use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;

pub const BUBBLE_WINDOW_LABEL: &str = "message-bubble";

const BUBBLE_WIDTH: f64 = 380.0;
const BUBBLE_HEIGHT: f64 = 200.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BubblePayload {
	pub profile_id: String,
	pub profile_name: String,
	pub conversation_id: Option<String>,
	pub peer_name: String,
	pub peer_avatar_media_hash: Option<String>,
	pub snippet: String,
	pub unread: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleOpenEvent {
	pub profile_id: String,
	pub profile_name: String,
}

#[derive(Default)]
pub struct BubbleState {
	pending: Mutex<Option<BubblePayload>>,
	active: Mutex<Option<BubblePayload>>,
}

fn lock<'a>(
	state: &'a tauri::State<'_, BubbleState>,
) -> Result<std::sync::MutexGuard<'a, Option<BubblePayload>>, AppError> {
	Ok(state.pending.lock().unwrap_or_else(PoisonError::into_inner))
}

#[tauri::command]
pub async fn bubble_show(
	app: AppHandle,
	state: tauri::State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
	conversation_id: Option<String>,
	peer_name: String,
	peer_avatar_media_hash: Option<String>,
	snippet: String,
	unread: u32,
) -> Result<(), AppError> {
	let payload = BubblePayload {
		profile_id,
		profile_name,
		conversation_id,
		peer_name,
		peer_avatar_media_hash,
		snippet,
		unread,
	};
	*lock(&state)? = Some(payload.clone());
	*state.active.lock().unwrap_or_else(PoisonError::into_inner) =
		Some(payload.clone());
	if let Some(window) = app.get_webview_window(BUBBLE_WINDOW_LABEL) {
		app.emit_to(BUBBLE_WINDOW_LABEL, "bubble:update", &payload)
			.map_err(|error| AppError::Auth(error.to_string()))?;
		window
			.set_focus()
			.map_err(|error| AppError::Auth(error.to_string()))?;
		return Ok(());
	}
	tauri::WebviewWindowBuilder::new(
		&app,
		BUBBLE_WINDOW_LABEL,
		tauri::WebviewUrl::App("/bubble".into()),
	)
	.title("New message")
	.inner_size(BUBBLE_WIDTH, BUBBLE_HEIGHT)
	.center()
	.resizable(false)
	.decorations(false)
	.transparent(true)
	.skip_taskbar(true)
	.always_on_top(true)
	.focused(true)
	.build()
	.map_err(|error| AppError::Auth(error.to_string()))?;
	Ok(())
}

#[tauri::command]
pub async fn bubble_update(
	app: AppHandle,
	state: tauri::State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
	conversation_id: Option<String>,
	peer_name: String,
	peer_avatar_media_hash: Option<String>,
	snippet: String,
	unread: u32,
) -> Result<bool, AppError> {
	let payload = BubblePayload {
		profile_id,
		profile_name,
		conversation_id,
		peer_name,
		peer_avatar_media_hash,
		snippet,
		unread,
	};
	let matches_visible_bubble = state
		.active
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.as_ref()
		.is_some_and(|active| {
			active.profile_id == payload.profile_id
				&& active.conversation_id == payload.conversation_id
		});
	if !matches_visible_bubble {
		return Ok(false);
	}
	let Some(_window) = app.get_webview_window(BUBBLE_WINDOW_LABEL) else {
		return Ok(false);
	};
	*lock(&state)? = Some(payload.clone());
	*state.active.lock().unwrap_or_else(PoisonError::into_inner) =
		Some(payload.clone());
	app.emit_to(BUBBLE_WINDOW_LABEL, "bubble:update", &payload)
		.map_err(|error| AppError::Auth(error.to_string()))?;
	Ok(true)
}

#[tauri::command]
pub async fn bubble_take(
	state: tauri::State<'_, BubbleState>,
) -> Result<Option<BubblePayload>, AppError> {
	Ok(std::mem::take(&mut *lock(&state)?))
}

#[tauri::command]
pub async fn bubble_open(
	app: AppHandle,
	state: tauri::State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
) -> Result<(), AppError> {
	*lock(&state)? = None;
	*state.active.lock().unwrap_or_else(PoisonError::into_inner) = None;
	crate::focus_main_window(&app);
	app.emit_to(
		"main",
		"bubble:open-profile",
		&BubbleOpenEvent {
			profile_id,
			profile_name,
		},
	)
	.map_err(|error| AppError::Auth(error.to_string()))?;
	if let Some(window) = app.get_webview_window(BUBBLE_WINDOW_LABEL) {
		window
			.close()
			.map_err(|error| AppError::Auth(error.to_string()))?;
	}
	Ok(())
}

#[tauri::command]
pub async fn bubble_close(
	app: AppHandle,
	state: tauri::State<'_, BubbleState>,
) -> Result<(), AppError> {
	*lock(&state)? = None;
	*state.active.lock().unwrap_or_else(PoisonError::into_inner) = None;
	if let Some(window) = app.get_webview_window(BUBBLE_WINDOW_LABEL) {
		window
			.close()
			.map_err(|error| AppError::Auth(error.to_string()))?;
	}
	Ok(())
}
