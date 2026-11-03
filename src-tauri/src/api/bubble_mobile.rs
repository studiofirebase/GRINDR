use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;

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

#[derive(Default)]
pub struct BubbleState;

#[tauri::command]
pub async fn bubble_show(
	_app: AppHandle,
	_state: State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
	conversation_id: Option<String>,
	peer_name: String,
	peer_avatar_media_hash: Option<String>,
	snippet: String,
	unread: u32,
) -> Result<(), AppError> {
	let _ = (
		profile_id,
		profile_name,
		conversation_id,
		peer_name,
		peer_avatar_media_hash,
		snippet,
		unread,
	);
	Ok(())
}

#[tauri::command]
pub async fn bubble_update(
	_app: AppHandle,
	_state: State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
	conversation_id: Option<String>,
	peer_name: String,
	peer_avatar_media_hash: Option<String>,
	snippet: String,
	unread: u32,
) -> Result<bool, AppError> {
	let _ = (
		profile_id,
		profile_name,
		conversation_id,
		peer_name,
		peer_avatar_media_hash,
		snippet,
		unread,
	);
	Ok(false)
}

#[tauri::command]
pub async fn bubble_take(
	_state: State<'_, BubbleState>,
) -> Result<Option<BubblePayload>, AppError> {
	Ok(None)
}

#[tauri::command]
pub async fn bubble_open(
	_app: AppHandle,
	_state: State<'_, BubbleState>,
	profile_id: String,
	profile_name: String,
) -> Result<(), AppError> {
	let _ = (profile_id, profile_name);
	Ok(())
}

#[tauri::command]
pub async fn bubble_close(
	_app: AppHandle,
	_state: State<'_, BubbleState>,
) -> Result<(), AppError> {
	Ok(())
}
