//! Background clients that keep every saved profile online at the same time.
//!
//! The app historically holds a single [`grindr::GrindrClient`] for the
//! visible session. That is still the only client used for REST traffic, but
//! every other saved profile now gets its own lightweight client that stays
//! connected over its own websocket. Incoming events for those profiles are
//! re-emitted with a `grindr:background:` prefix so the frontend can
//! attribute them without switching sessions.
//!
//! A background client never touches the shared [`AppState`] client, the
//! legacy [`AuthStorage`], or the shared device storage: it only reads its
//! own [`SavedProfile`] and writes refreshed credentials back to it.

use std::collections::HashMap;
use std::sync::{
	atomic::{AtomicBool, Ordering},
	Arc, Mutex, PoisonError,
};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use crate::error::AppError;
use crate::state::AppState;
use crate::storage::{ProfileStorage, SavedProfile};

/// How often a background client refreshes its own session token.
const REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondaryStatus {
	pub profile_id: String,
	pub ws_online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundEvent {
	profile_id: String,
	profile_name: String,
	event: serde_json::Value,
}

struct SecondaryHandle {
	client: grindr::GrindrClient,
	shutdown: Arc<AtomicBool>,
	tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct SecondarySessions {
	handles: Mutex<HashMap<String, SecondaryHandle>>,
	resync_lock: tokio::sync::Mutex<()>,
}

fn lock_handles(
	handles: &Mutex<HashMap<String, SecondaryHandle>>,
) -> std::sync::MutexGuard<'_, HashMap<String, SecondaryHandle>> {
	handles.lock().unwrap_or_else(PoisonError::into_inner)
}

fn active_profile_id<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<String> {
	let state = app.state::<AppState>();
	let client = state.client().ok()?;
	client
		.session_receiver()
		.borrow()
		.as_ref()?
		.credentials
		.profile_id
		.clone()
}

/// Builds a sessionless client for a saved profile. It performs no network
/// traffic: callers restore the signing key, refresh, and connect it.
pub fn build_secondary_client(
	profile: &SavedProfile,
) -> Result<grindr::GrindrClient, AppError> {
	let client = grindr::GrindrClient::new(
		profile.device.clone(),
		Some(grindr::Session {
			credentials: profile.credentials.clone(),
			token: None,
		}),
	)
	.map_err(|error| AppError::Auth(error.to_string()))?;
	// Idle clients disconnect their socket and stop reconnecting, so
	// background profiles must stay marked active.
	client.set_active(true);
	Ok(client)
}

/// Whether a refresh failure is terminal for the saved credentials.
fn is_terminal_refresh(error: &grindr::GrindrError) -> bool {
	matches!(
		error,
		grindr::GrindrError::Unauthorized { .. }
			| grindr::GrindrError::Banned(_)
	)
}

fn persist_secondary_credentials(
	profile_id: &str,
	credentials: &grindr::Credentials,
) -> Result<(), AppError> {
	let saved = ProfileStorage::load()?;
	let Some(mut profile) = saved
		.profiles
		.into_iter()
		.find(|profile| profile.profile_id == profile_id)
	else {
		return Ok(());
	};
	profile.credentials = credentials.clone();
	ProfileStorage::save_profile(profile)
}

async fn forward_loop<R: tauri::Runtime>(
	app: AppHandle<R>,
	profile_id: String,
	profile_name: String,
	mut events: tokio::sync::broadcast::Receiver<grindr::WsEvent>,
) {
	loop {
		match events.recv().await {
			Ok(event) => {
				let safe_type = event.event_type.replace('.', "_");
				app.emit(
					&format!("grindr:background:{safe_type}"),
					&BackgroundEvent {
						profile_id: profile_id.clone(),
						profile_name: profile_name.clone(),
						event: event.payload,
					},
				)
				.ok();
			}
			Err(RecvError::Lagged(_)) => continue,
			Err(RecvError::Closed) => break,
		}
	}
}

async fn persist_loop(
	profile_id: String,
	client: grindr::GrindrClient,
	shutdown: Arc<AtomicBool>,
) {
	let mut sessions = client.session_receiver();
	loop {
		if sessions.changed().await.is_err() {
			break;
		}
		if shutdown.load(Ordering::Relaxed) {
			break;
		}
		if let Some(session) = sessions.borrow().clone() {
			if let Err(error) =
				persist_secondary_credentials(&profile_id, &session.credentials)
			{
				tracing::warn!(
					"[secondary] could not persist refreshed session for {profile_id}: {error}"
				);
			}
		}
	}
}

async fn refresh_loop<R: tauri::Runtime>(
	app: AppHandle<R>,
	profile_id: String,
	client: grindr::GrindrClient,
	shutdown: Arc<AtomicBool>,
) {
	loop {
		tokio::time::sleep(REFRESH_INTERVAL).await;
		if shutdown.load(Ordering::Relaxed) {
			break;
		}
		match client.refresh_session_at_geohash(None).await {
			Ok(_) => {}
			Err(error) if is_terminal_refresh(&error) => {
				tracing::warn!(
					"[secondary] session for {profile_id} is no longer valid: {error}"
				);
				app.state::<SecondarySessions>().drop_one(&profile_id).await;
				break;
			}
			Err(error) => {
				tracing::warn!(
					"[secondary] background refresh failed for {profile_id}: {error}"
				);
			}
		}
	}
}

impl SecondarySessions {
	async fn start_one<R: tauri::Runtime>(
		&self,
		app: &AppHandle<R>,
		profile: SavedProfile,
	) -> Result<bool, AppError> {
		let profile_id = profile.profile_id.clone();
		if lock_handles(&self.handles).contains_key(&profile_id) {
			return Ok(false);
		}
		// The profile may have become (or never stopped being) the visible
		// session while we were loading it: never shadow the main client.
		if active_profile_id(app).as_deref() == Some(profile_id.as_str()) {
			return Ok(false);
		}
		let client = build_secondary_client(&profile)?;
		if let Some(key) = profile.signing_key.clone() {
			// A refused key only loses request signing, like the manual
			// switch.
			if !client.restore_signing_key(key).await {
				tracing::warn!(
					"[secondary] saved device signing key was refused for {profile_id}"
				);
			}
		}
		match client.refresh_session_at_geohash(None).await {
			Ok(_) => {}
			Err(error) if is_terminal_refresh(&error) => {
				tracing::warn!(
					"[secondary] saved session for {profile_id} is dead, skipping: {error}"
				);
				return Ok(false);
			}
			Err(error) => {
				tracing::warn!(
					"[secondary] initial refresh failed for {profile_id}, will retry: {error}"
				);
			}
		}
		let shutdown = Arc::new(AtomicBool::new(false));
		let mut tasks = Vec::new();
		tasks.push(tauri::async_runtime::spawn(forward_loop(
			app.clone(),
			profile_id.clone(),
			profile.name.clone(),
			client.ws_receiver(),
		)));
		tasks.push(tauri::async_runtime::spawn(persist_loop(
			profile_id.clone(),
			client.clone(),
			Arc::clone(&shutdown),
		)));
		tasks.push(tauri::async_runtime::spawn(refresh_loop(
			app.clone(),
			profile_id.clone(),
			client.clone(),
			Arc::clone(&shutdown),
		)));
		lock_handles(&self.handles).insert(
			profile_id.clone(),
			SecondaryHandle {
				client: client.clone(),
				shutdown,
				tasks,
			},
		);
		client.connect().await;
		tracing::info!("[secondary] {profile_id} is now online");
		Ok(true)
	}

	/// Drops a background client, if present. Fast local teardown only.
	pub async fn drop_one(&self, profile_id: &str) {
		let handle = lock_handles(&self.handles).remove(profile_id);
		let Some(handle) = handle else { return };
		handle.shutdown.store(true, Ordering::Relaxed);
		handle.client.sign_out().await;
		for task in handle.tasks {
			task.abort();
		}
		tracing::info!("[secondary] {profile_id} went offline");
	}

	/// Drops every background client.
	pub async fn stop_all(&self) {
		let ids: Vec<String> =
			lock_handles(&self.handles).keys().cloned().collect();
		for id in ids {
			self.drop_one(&id).await;
		}
	}

	/// Reconciles the running set with storage: starts missing saved
	/// profiles (except the visible one) and drops stale entries.
	/// Serialized so two passes can never double-start a profile.
	pub async fn resync<R: tauri::Runtime>(&self, app: &AppHandle<R>) {
		let _guard = self.resync_lock.lock().await;
		let saved = match ProfileStorage::load() {
			Ok(saved) => saved,
			Err(error) => {
				tracing::warn!(
					"[secondary] could not load saved profiles: {error}"
				);
				return;
			}
		};
		let Some(active_id) = active_profile_id(app) else {
			// Signed out (or pre-first-refresh): explicit stop paths own this
			// state, and starting clients now would shadow the login.
			return;
		};
		let current: Vec<String> =
			lock_handles(&self.handles).keys().cloned().collect();
		for id in current {
			if id == active_id
				|| !saved.profiles.iter().any(|p| p.profile_id == id)
			{
				self.drop_one(&id).await;
			}
		}
		for profile in saved.profiles {
			if profile.profile_id == active_id {
				continue;
			}
			if lock_handles(&self.handles).contains_key(&profile.profile_id) {
				continue;
			}
			if let Err(error) = self.start_one(app, profile.clone()).await {
				tracing::warn!(
					"[secondary] could not bring {} online: {error}",
					profile.profile_id
				);
			}
		}
	}

	pub fn status(&self) -> Vec<SecondaryStatus> {
		lock_handles(&self.handles)
			.iter()
			.map(|(profile_id, handle)| SecondaryStatus {
				profile_id: profile_id.clone(),
				ws_online: *handle.client.connection_state().borrow()
					== grindr::WsConnectionState::Connected,
			})
			.collect()
	}

	#[cfg(test)]
	fn len(&self) -> usize {
		lock_handles(&self.handles).len()
	}
}

/// Starts or refreshes background clients for every saved non-visible
/// profile. Cheap no-op when nothing changed.
pub async fn resync_all<R: tauri::Runtime>(app: &AppHandle<R>) {
	app.state::<SecondarySessions>().resync(app).await;
}

/// Drops the background client for one profile, if running.
pub async fn drop_secondary<R: tauri::Runtime>(
	app: &AppHandle<R>,
	profile_id: &str,
) {
	app.state::<SecondarySessions>().drop_one(profile_id).await;
}

/// Drops every background client, e.g. on sign-out.
pub async fn stop_all_sessions<R: tauri::Runtime>(app: &AppHandle<R>) {
	app.state::<SecondarySessions>().stop_all().await;
}

#[tauri::command]
pub fn secondary_status(
	state: tauri::State<'_, SecondarySessions>,
) -> Vec<SecondaryStatus> {
	state.status()
}

#[cfg(test)]
mod tests {
	use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
	use tauri::Manager;

	use super::*;

	fn fixture_profile(profile_id: &str) -> SavedProfile {
		SavedProfile {
			profile_id: profile_id.to_owned(),
			name: format!("{profile_id}@example.com"),
			device: grindr::DeviceInfo::generate(),
			credentials: grindr::Credentials {
				email: format!("{profile_id}@example.com"),
				profile_id: Some(profile_id.to_owned()),
				auth_token: "token".to_owned(),
				kind: Default::default(),
				third_party_user_id: None,
			},
			signing_key: None,
			geohash: None,
		}
	}

	fn app_without_client() -> tauri::App<MockRuntime> {
		mock_builder()
			.manage(AppState::default())
			.manage(SecondarySessions::default())
			.build(mock_context(noop_assets()))
			.expect("mock app")
	}

	#[test]
	fn build_secondary_client_keeps_profiles_active() {
		let client =
			build_secondary_client(&fixture_profile("42")).expect("build");
		assert!(client.is_active());
	}

	#[tokio::test]
	async fn resync_without_an_active_session_starts_nothing() {
		let app = app_without_client();
		let sessions = app.state::<SecondarySessions>();
		resync_all(&app.handle()).await;
		assert_eq!(sessions.len(), 0);
		assert!(sessions.status().is_empty());
	}

	#[tokio::test]
	async fn dropping_a_missing_profile_is_a_noop() {
		let app = app_without_client();
		let sessions = app.state::<SecondarySessions>();
		sessions.drop_one("nope").await;
		sessions.stop_all().await;
		assert_eq!(sessions.len(), 0);
	}
}
