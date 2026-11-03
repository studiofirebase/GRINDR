use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::media::MediaProxy;
use crate::state::AppState;
use crate::storage::{
	AuthStorage, DeviceStorage, ProfileStorage, SavedProfile,
	SigningKeyStorage, MAX_PROFILES,
};

static SIGN_OUT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PROFILE_SWITCH: tokio::sync::Mutex<()> =
	tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInResult {
	pub profile_id: String,
	pub restriction: Option<Restriction>,
}

impl From<grindr::SignInResult> for SignInResult {
	fn from(r: grindr::SignInResult) -> Self {
		Self {
			profile_id: r.profile_id,
			restriction: r.restriction.map(Restriction::from),
		}
	}
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restriction {
	pub kind: String,
	pub region: Option<String>,
	pub reason: Option<String>,
	pub sub_reason: Option<String>,
	pub ends_at: Option<i64>,
}

impl Restriction {
	fn of_kind(kind: &str) -> Self {
		Self {
			kind: kind.to_owned(),
			..Self::default()
		}
	}
}

impl From<grindr::Restriction> for Restriction {
	fn from(r: grindr::Restriction) -> Self {
		match r {
			grindr::Restriction::AgeVerification { region, reason } => Self {
				region: Some(region_str(region).to_owned()),
				reason: Some(reason),
				..Self::of_kind("ageVerification")
			},
			grindr::Restriction::TimedBan(details) => Self {
				reason: details.reason,
				sub_reason: details.sub_reason,
				ends_at: details.expiry_time,
				..Self::of_kind("timedBan")
			},
			grindr::Restriction::TrustVendorRejected => {
				Self::of_kind("trustVendorRejected")
			}
			grindr::Restriction::Other(raw) => Self {
				reason: Some(raw),
				..Self::of_kind("other")
			},
			_ => Self::of_kind("other"),
		}
	}
}

fn region_str(region: grindr::VerificationRegion) -> &'static str {
	match region {
		grindr::VerificationRegion::Uk => "uk",
		grindr::VerificationRegion::Br => "br",
		grindr::VerificationRegion::Au => "au",
		_ => "other",
	}
}

#[tauri::command]
pub async fn sign_in_with_email(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
	email: String,
	password: String,
	captcha_token: Option<String>,
) -> Result<SignInResult, AppError> {
	end_existing_session(&app, &state, &media).await?;
	let client = state.client()?;
	let result = match captcha_token {
		Some(token) => {
			client
				.sign_in_with_email_captcha(&email, &password, &token)
				.await?
		}
		None => client.sign_in_with_email(&email, &password).await?,
	};
	Ok(SignInResult::from(result))
}

#[tauri::command]
pub async fn sign_in_with_google(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
) -> Result<SignInResult, AppError> {
	let access_token =
		super::google_oauth::fetch_google_access_token(&app).await?;
	end_existing_session(&app, &state, &media).await?;
	let result = state.client()?.sign_in_with_google(&access_token).await?;
	Ok(SignInResult::from(result))
}

#[tauri::command]
pub async fn sign_in_with_google_token(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
	token: String,
) -> Result<SignInResult, AppError> {
	end_existing_session(&app, &state, &media).await?;
	let result = state.client()?.sign_in_with_google(&token).await?;
	Ok(SignInResult::from(result))
}

#[tauri::command]
pub fn backend_ready(state: tauri::State<'_, AppState>) -> bool {
	state.client().is_ok()
}

#[tauri::command]
pub fn google_handoff_pending(app: tauri::AppHandle) -> bool {
	super::google_oauth::handoff_pending(&app)
}

#[tauri::command]
pub async fn sign_in_with_google_handoff(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
) -> Result<Option<SignInResult>, AppError> {
	let Some(token) = super::google_oauth::take_handoff(&app) else {
		return Ok(None);
	};
	end_existing_session(&app, &state, &media).await?;
	let result = state.client()?.sign_in_with_google(&token).await?;
	Ok(Some(SignInResult::from(result)))
}

#[tauri::command]
pub fn discard_google_handoff(app: tauri::AppHandle) {
	super::google_oauth::discard_handoff(&app);
}

#[tauri::command]
pub async fn sign_in_with_facebook(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
) -> Result<SignInResult, AppError> {
	let access_token =
		super::facebook_oauth::fetch_facebook_access_token(&app).await?;
	end_existing_session(&app, &state, &media).await?;
	let result = state.client()?.sign_in_with_facebook(&access_token).await?;
	Ok(SignInResult::from(result))
}

#[tauri::command]
pub async fn refresh_session(
	state: tauri::State<'_, AppState>,
	geohash: Option<String>,
) -> Result<SignInResult, AppError> {
	let client = state.client()?;
	let result = client
		.refresh_session_at_geohash(geohash.as_deref())
		.await
		.map_err(|e| AppError::from_client_error(e, &client))?;
	Ok(SignInResult::from(result))
}

#[tauri::command]
pub async fn sign_out(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
) -> Result<(), AppError> {
	let _one_at_a_time = PROFILE_SWITCH.lock().await;
	let client = state.client()?;
	if let Some(profile_id) = client
		.session_receiver()
		.borrow()
		.as_ref()
		.and_then(|session| session.credentials.profile_id.clone())
	{
		ProfileStorage::remove(&profile_id)?;
	}
	ProfileStorage::set_active(None)?;
	end_session(&app, &state, &media).await
}

/// How much of the visible-session bookkeeping a session switch performs.
/// Background scans borrow the backend session for a few seconds: they must
/// not flap the stored active profile, cycle the websocket, churn media
/// caches, or disturb the secondary clients. Only the persisted identity
/// (credentials/device/signing key) swaps, which the restore step rewrites.
#[derive(Debug, Clone, Copy)]
struct SwitchMode {
	persist_active: bool,
	connect_ws: bool,
	reset_media: bool,
}

const USER_SWITCH: SwitchMode = SwitchMode {
	persist_active: true,
	connect_ws: true,
	reset_media: true,
};

const SCAN_SWITCH: SwitchMode = SwitchMode {
	persist_active: false,
	connect_ws: false,
	reset_media: false,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
	pub profile_id: String,
	pub name: String,
	pub active: bool,
}

#[tauri::command]
pub fn profile_list(
	state: tauri::State<'_, AppState>,
) -> Result<Vec<ProfileSummary>, AppError> {
	let saved = ProfileStorage::load()?;
	let active_id = state.client().ok().and_then(|client| {
		client
			.session_receiver()
			.borrow()
			.as_ref()
			.and_then(|session| session.credentials.profile_id.clone())
	});
	Ok(saved
		.profiles
		.into_iter()
		.map(|profile| ProfileSummary {
			active: active_id.as_deref() == Some(&profile.profile_id),
			profile_id: profile.profile_id,
			name: profile.name,
		})
		.collect())
}

#[tauri::command]
pub async fn profile_add(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
) -> Result<(), AppError> {
	let _one_at_a_time = PROFILE_SWITCH.lock().await;
	let mut saved = ProfileStorage::load()?;
	if saved.profiles.len() >= MAX_PROFILES {
		return Err(AppError::Auth(format!(
			"at most {MAX_PROFILES} profiles can be saved"
		)));
	}
	let client = state.client()?;
	let current_session = { client.session_receiver().borrow().clone() };
	if let Some(session) = current_session {
		let Some(profile_id) = session.credentials.profile_id.clone() else {
			return Err(AppError::NotSignedIn);
		};
		let profile = SavedProfile {
			profile_id,
			name: session.credentials.email.clone(),
			device: client.current_device().await,
			credentials: session.credentials,
			signing_key: client.signing_key_receiver().borrow().clone(),
			geohash: None,
		};
		ProfileStorage::save_active_profile(profile)?;
		saved = ProfileStorage::load()?;
	}
	if saved.profiles.len() >= MAX_PROFILES {
		return Err(AppError::Auth(format!(
			"at most {MAX_PROFILES} profiles can be saved"
		)));
	}
	ProfileStorage::set_active(None)?;
	end_session(&app, &state, &media).await
}

#[tauri::command]
pub async fn profile_switch(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
	recovery: tauri::State<'_, super::session_recovery::SessionRecovery>,
	profile_id: String,
) -> Result<Option<String>, AppError> {
	switch_session(app, state, media, recovery, profile_id, USER_SWITCH).await
}

/// Background variant of [`profile_switch`]: borrows the backend session so
/// a scan can read (and let the AI answer) another profile without
/// disturbing the visible one. Skips every visible-session side effect; the
/// caller must switch back afterwards.
#[tauri::command]
pub async fn profile_scan_switch(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
	recovery: tauri::State<'_, super::session_recovery::SessionRecovery>,
	profile_id: String,
) -> Result<Option<String>, AppError> {
	switch_session(app, state, media, recovery, profile_id, SCAN_SWITCH).await
}

async fn switch_session(
	app: tauri::AppHandle,
	state: tauri::State<'_, AppState>,
	media: tauri::State<'_, MediaProxy>,
	recovery: tauri::State<'_, super::session_recovery::SessionRecovery>,
	profile_id: String,
	mode: SwitchMode,
) -> Result<Option<String>, AppError> {
	let _one_at_a_time = PROFILE_SWITCH.lock().await;
	let saved = ProfileStorage::load()?;
	let target = saved
		.profiles
		.iter()
		.find(|profile| profile.profile_id == profile_id)
		.cloned()
		.ok_or_else(|| AppError::Auth("profile is not saved".to_owned()))?;
	let current = state.client()?;
	if current
		.session_receiver()
		.borrow()
		.as_ref()
		.and_then(|session| session.credentials.profile_id.as_deref())
		== Some(profile_id.as_str())
	{
		return Ok(target.geohash);
	}
	let current_session = { current.session_receiver().borrow().clone() };
	if let Some(session) = current_session {
		if let Some(current_id) = session.credentials.profile_id.clone() {
			ProfileStorage::save_profile(SavedProfile {
				profile_id: current_id,
				name: session.credentials.email.clone(),
				device: current.current_device().await,
				credentials: session.credentials,
				signing_key: current.signing_key_receiver().borrow().clone(),
				geohash: None,
			})?;
		}
	}

	let next = grindr::GrindrClient::new(
		target.device.clone(),
		Some(grindr::Session {
			credentials: target.credentials.clone(),
			token: None,
		}),
	)
	.map_err(|error| AppError::Auth(error.to_string()))?;
	let restored_key = match target.signing_key.clone() {
		Some(key) if next.restore_signing_key(key.clone()).await => Some(key),
		Some(_) => {
			tracing::warn!(
				"[profiles] saved device signing key was refused for profile {}",
				target.profile_id
			);
			None
		}
		None => None,
	};
	current.set_active(false);
	current.sign_out().await;
	if mode.reset_media {
		media.forget_everything().await;
	}
	state.set_client(next.clone());
	if mode.persist_active {
		ProfileStorage::set_active(Some(profile_id))?;
	}
	AuthStorage::set_credentials(&target.credentials)?;
	DeviceStorage::save(&target.device)?;
	SigningKeyStorage::delete();
	if let Some(key) = restored_key.as_ref() {
		if let Err(error) = SigningKeyStorage::save(key) {
			tracing::error!("[profiles] could not restore device key: {error}");
		}
	}
	if mode.connect_ws {
		next.set_active(
			recovery
				.foreground
				.load(std::sync::atomic::Ordering::SeqCst),
		);
		crate::watch_client(app.clone(), next.clone());
		super::ws::spawn_ws_task(app.clone());
		next.connect().await;
		// The profile we just switched to must never keep a background twin,
		// and the one we left behind should come online in the background.
		super::secondary_sessions::drop_secondary(&app, &target.profile_id)
			.await;
		let resync_app = app.clone();
		tauri::async_runtime::spawn(async move {
			super::secondary_sessions::resync_all(&resync_app).await;
		});
	}
	Ok(target.geohash)
}

#[tauri::command]
pub async fn profile_set_location(
	state: tauri::State<'_, AppState>,
	geohash: Option<String>,
) -> Result<(), AppError> {
	let _one_at_a_time = PROFILE_SWITCH.lock().await;
	if let Some(hash) = &geohash {
		if hash.len() != 12
			|| !hash.bytes().all(|byte| {
				matches!(
					byte,
					b'0'..=b'9' | b'b'..=b'h' | b'j'..=b'n' | b'p'..=b'z'
				)
			}) {
			return Err(AppError::Auth("invalid geohash".to_owned()));
		}
	}

	let client = state.client()?;
	let Some(session) = client.session_receiver().borrow().clone() else {
		return Ok(());
	};
	let Some(profile_id) = session.credentials.profile_id.clone() else {
		return Ok(());
	};
	let profile = SavedProfile {
		profile_id,
		name: session.credentials.email.clone(),
		device: client.current_device().await,
		credentials: session.credentials,
		signing_key: client.signing_key_receiver().borrow().clone(),
		geohash: None,
	};
	ProfileStorage::save_active_profile_with_location(profile, geohash)
}

pub(crate) async fn end_session(
	app: &tauri::AppHandle,
	state: &AppState,
	media: &MediaProxy,
) -> Result<(), AppError> {
	let _one_at_a_time = SIGN_OUT.lock().await;
	// Nobody stays online once the user signs out (or starts over to add
	// another profile).
	super::secondary_sessions::stop_all_sessions(app).await;
	let client = state.client()?;
	forget_account(&client, media).await?;
	super::facebook_oauth::forget_sign_in_profile(app).await;
	crate::upload::staged::discard_all(app);
	Ok(())
}

async fn end_existing_session(
	app: &tauri::AppHandle,
	state: &AppState,
	media: &MediaProxy,
) -> Result<(), AppError> {
	if state.client()?.session_receiver().borrow().is_none() {
		return Ok(());
	}
	end_session(app, state, media).await
}

pub(crate) async fn forget_account(
	client: &grindr::GrindrClient,
	media: &MediaProxy,
) -> Result<(), AppError> {
	client.sign_out().await;
	AuthStorage::delete_credentials();
	SigningKeyStorage::delete();
	media.forget_everything().await;

	let new_device = grindr::DeviceInfo::generate();
	if let Err(e) = DeviceStorage::save(&new_device) {
		tracing::error!(
			"[auth] could not persist rotated device info on sign out: {e}"
		);
		DeviceStorage::delete();
	}
	client.rotate_device(new_device).await?;

	Ok(())
}

#[tauri::command]
pub async fn recaptcha_first_party_enabled(
	state: tauri::State<'_, AppState>,
) -> Result<bool, AppError> {
	state
		.client()?
		.recaptcha_first_party_enabled()
		.await
		.map_err(Into::into)
}

#[tauri::command]
pub async fn account_restriction(
	state: tauri::State<'_, AppState>,
) -> Result<Option<Restriction>, AppError> {
	let Ok(client) = state.client() else {
		return Ok(None);
	};
	Ok(client
		.session_receiver()
		.borrow()
		.as_ref()
		.and_then(|s| s.token.as_ref()?.restriction.clone())
		.map(Restriction::from))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeatureFlagClaims {
	#[serde(default)]
	feature_flags: Vec<String>,
}

fn feature_flags_of(session_id: &str) -> Vec<String> {
	session_id
		.split('.')
		.nth(1)
		.and_then(|payload| URL_SAFE_NO_PAD.decode(payload).ok())
		.and_then(|json| {
			serde_json::from_slice::<FeatureFlagClaims>(&json).ok()
		})
		.map(|claims| claims.feature_flags)
		.unwrap_or_default()
}

#[tauri::command]
pub async fn session_feature_flags(
	state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
	let Ok(client) = state.client() else {
		return Ok(Vec::new());
	};
	Ok(client
		.session_receiver()
		.borrow()
		.as_ref()
		.and_then(|s| s.token.as_ref())
		.map(|token| feature_flags_of(&token.session_id))
		.unwrap_or_default())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(any(
		target_os = "linux",
		all(
			target_os = "macos",
			not(feature = "keychain"),
			not(feature = "memory-storage")
		)
	))]
	#[test]
	fn ending_a_session_forgets_the_account_and_moves_to_a_new_device() {
		crate::storage::test_support::with_file_store(|_| {
			let old_device = grindr::DeviceInfo::generate();
			let credentials = grindr::Credentials {
				email: "user@example.com".to_owned(),
				profile_id: Some("42".to_owned()),
				auth_token: "auth-token".to_owned(),
				kind: grindr::SessionKind::Email,
				third_party_user_id: None,
			};
			DeviceStorage::save(&old_device).unwrap();
			AuthStorage::set_credentials(&credentials).unwrap();
			SigningKeyStorage::save(
				&serde_json::from_value(serde_json::json!({
					"key": "-----BEGIN PRIVATE KEY-----",
					"user_id": "42",
				}))
				.unwrap(),
			)
			.unwrap();
			let client = grindr::GrindrClient::new(
				old_device.clone(),
				Some(grindr::Session {
					credentials,
					token: None,
				}),
			)
			.unwrap();

			let runtime = tokio::runtime::Runtime::new().unwrap();
			runtime
				.block_on(forget_account(&client, &MediaProxy::default()))
				.unwrap();

			assert!(client.session_receiver().borrow().is_none());
			assert!(AuthStorage::get_credentials().unwrap().is_none());
			assert!(SigningKeyStorage::load().unwrap().is_none());
			let stored = DeviceStorage::load().unwrap().expect("a new device");
			assert_ne!(stored.device_id, old_device.device_id);
			assert_eq!(
				runtime.block_on(client.current_device()).device_id,
				stored.device_id
			);
		});
	}

	#[test]
	fn simulated_age_restriction_maps_to_frontend_shape() {
		let restriction: grindr::Restriction = serde_json::from_str(
			r#"{"AgeVerification":{"region":"Uk","reason":"UK_VERIFICATION_REQUIRED"}}"#,
		)
		.unwrap();

		let mapped = Restriction::from(restriction);
		let json = serde_json::to_value(&mapped).unwrap();
		assert_eq!(json["kind"], "ageVerification");
		assert_eq!(json["region"], "uk");
		assert_eq!(json["reason"], "UK_VERIFICATION_REQUIRED");
	}

	#[test]
	fn a_timed_ban_passes_its_end_time_and_sub_reason_to_the_frontend() {
		let restriction: grindr::Restriction =
			serde_json::from_value(serde_json::json!({ "TimedBan": {
				"expiryTime": 1_792_000_000_000_i64,
				"reason": "Scam / Spam",
				"subReason": "PROFILE_SPAM",
				"isAutomated": true,
			}}))
			.unwrap();

		let json =
			serde_json::to_value(Restriction::from(restriction)).unwrap();

		assert_eq!(json["kind"], "timedBan");
		assert_eq!(json["reason"], "Scam / Spam");
		assert_eq!(json["subReason"], "PROFILE_SPAM");
		assert_eq!(json["endsAt"], 1_792_000_000_000_i64);
	}

	fn jwt_with_payload(payload: serde_json::Value) -> String {
		format!(
			"{}.{}.signature",
			URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256"}"#),
			URL_SAFE_NO_PAD.encode(payload.to_string()),
		)
	}

	#[test]
	fn feature_flags_come_from_the_session_jwt() {
		let token = jwt_with_payload(serde_json::json!({
			"exp": 1,
			"featureFlags": ["edge-boost", "gender-filter"],
		}));
		assert_eq!(feature_flags_of(&token), ["edge-boost", "gender-filter"]);
	}

	#[test]
	fn an_unreadable_session_jwt_has_no_feature_flags() {
		assert!(feature_flags_of("sid").is_empty());
		assert!(feature_flags_of("a.%%%.c").is_empty());
		assert!(feature_flags_of(&jwt_with_payload(
			serde_json::json!({ "exp": 1 })
		))
		.is_empty());
	}
}
