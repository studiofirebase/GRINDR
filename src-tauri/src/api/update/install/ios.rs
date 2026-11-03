use std::path::Path;

use tauri::AppHandle;

use super::super::baseline::Baseline;
use super::super::component::Component;
use super::super::error::UpdateError;
use super::{Outcome, TransferProgress, TransferPurpose, Unsupported};

pub fn probe_package(_app: &AppHandle, _package: &str) -> Baseline {
	Baseline::Unreadable {
		why: "iOS updates are delivered through TestFlight or the App Store"
			.into(),
	}
}

pub fn verdict(
	_app: &AppHandle,
	_component: &Component,
) -> Result<bool, Unsupported> {
	Err(Unsupported::NoReleaseArtifacts {
		target: "ios".into(),
	})
}

pub async fn install(
	_app: &AppHandle,
	_payload: &Path,
	_package_name: &str,
) -> Result<(), UpdateError> {
	Err(UpdateError::Unsupported(Unsupported::NoReleaseArtifacts {
		target: "ios".into(),
	}))
}

pub fn install_pending(_app: &AppHandle) -> bool {
	false
}

pub fn open_install_permission_settings(
	_app: &AppHandle,
) -> Result<(), UpdateError> {
	Err(UpdateError::Unsupported(Unsupported::NoReleaseArtifacts {
		target: "ios".into(),
	}))
}

pub fn sweep_replaced() {}

pub fn enforce_home() {}

pub fn take_outcome(_app: &AppHandle) -> Option<Outcome> {
	None
}

pub fn watch_install(
	_app: &AppHandle,
	_on_event: tauri::ipc::Channel<Outcome>,
) -> Result<(), UpdateError> {
	Ok(())
}

pub(super) fn begin_transfer<R: tauri::Runtime>(
	_app: &AppHandle<R>,
	_purpose: TransferPurpose,
) {
}

pub(super) fn report_transfer<R: tauri::Runtime>(
	_app: &AppHandle<R>,
	_purpose: TransferPurpose,
	_progress: TransferProgress,
) {
}

pub(super) fn end_transfer<R: tauri::Runtime>(
	_app: &AppHandle<R>,
	_purpose: TransferPurpose,
) {
}
