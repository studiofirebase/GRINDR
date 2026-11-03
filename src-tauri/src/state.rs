use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::error::AppError;

static SHARED: OnceLock<grindr::GrindrClient> = OnceLock::new();

pub struct AppState {
	client: Mutex<Option<grindr::GrindrClient>>,
	tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
	openrouter_api_key: Mutex<Option<String>>,
}

impl AppState {
	fn new(openrouter_api_key: Option<String>) -> Self {
		Self {
			client: Mutex::new(None),
			tasks: Mutex::new(Vec::new()),
			openrouter_api_key: Mutex::new(openrouter_api_key),
		}
	}

	/// Loads the API key captured from the launching environment, then falls
	/// back to the app-private local key file for GUI launches from Finder.
	pub fn from_environment_and_file(path: &Path) -> Self {
		let openrouter_api_key = resolve_openrouter_api_key(
			std::env::var("OPENROUTER_API_KEY").ok(),
			Some(path),
			None,
		);
		Self::new(openrouter_api_key)
	}

	pub fn from_environment_file_and_keyring(
		path: &Path,
		keyring_key: Option<String>,
	) -> Self {
		let openrouter_api_key = resolve_openrouter_api_key(
			std::env::var("OPENROUTER_API_KEY").ok(),
			Some(path),
			keyring_key,
		);
		Self::new(openrouter_api_key)
	}

	pub fn client(&self) -> Result<grindr::GrindrClient, AppError> {
		self.client
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.clone()
			.ok_or(AppError::NotInitialized)
	}

	pub fn set_client(&self, client: grindr::GrindrClient) {
		for task in self
			.tasks
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.drain(..)
		{
			task.abort();
		}
		*self
			.client
			.lock()
			.unwrap_or_else(|error| error.into_inner()) = Some(client);
	}

	pub fn keep_task(&self, task: tauri::async_runtime::JoinHandle<()>) {
		self.tasks
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.push(task);
	}

	pub fn openrouter_api_key(&self) -> Option<String> {
		self.openrouter_api_key
			.lock()
			.unwrap_or_else(|error| error.into_inner())
			.clone()
	}

	pub fn set_openrouter_api_key(&self, api_key: Option<String>) {
		*self
			.openrouter_api_key
			.lock()
			.unwrap_or_else(|error| error.into_inner()) = api_key;
	}
}

impl Default for AppState {
	fn default() -> Self {
		Self::new(resolve_openrouter_api_key(
			std::env::var("OPENROUTER_API_KEY").ok(),
			None,
			None,
		))
	}
}

fn resolve_openrouter_api_key(
	environment_key: Option<String>,
	file_path: Option<&Path>,
	keyring_key: Option<String>,
) -> Option<String> {
	environment_key
		.filter(|key| !key.trim().is_empty())
		.or_else(|| keyring_key.filter(|key| !key.trim().is_empty()))
		.or_else(|| file_path.and_then(read_private_api_key))
}

fn read_private_api_key(path: &Path) -> Option<String> {
	let parent = path.parent()?;
	fs::create_dir_all(parent).ok()?;

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).ok()?;
	}

	let metadata = fs::symlink_metadata(path).ok()?;
	if !metadata.file_type().is_file() {
		return None;
	}

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(path, fs::Permissions::from_mode(0o600)).ok()?;
	}

	let key = fs::read_to_string(path).ok()?;
	let key = key.trim();
	(!key.is_empty()).then(|| key.to_owned())
}

#[cfg(test)]
mod tests {
	use std::fs;
	use std::path::PathBuf;
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::{resolve_openrouter_api_key, AppState};

	fn scratch_key_file() -> (PathBuf, PathBuf) {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let dir = std::env::temp_dir().join(format!(
			"open-grind-api-key-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		let path = dir.join("secrets").join("openrouter-api-key");
		(dir, path)
	}

	#[test]
	fn captures_the_openrouter_key_from_the_startup_environment() {
		let expected = std::env::var("OPENROUTER_API_KEY")
			.ok()
			.filter(|key| !key.trim().is_empty());
		assert_eq!(AppState::default().openrouter_api_key(), expected);
	}

	#[test]
	fn loads_the_local_key_when_the_environment_key_is_missing_or_blank() {
		let (dir, path) = scratch_key_file();
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(&path, " local-test-key\n").unwrap();

		assert_eq!(
			resolve_openrouter_api_key(None, Some(&path), None).as_deref(),
			Some("local-test-key")
		);
		assert_eq!(
			resolve_openrouter_api_key(
				Some("  ".to_owned()),
				Some(&path),
				None,
			)
			.as_deref(),
			Some("local-test-key")
		);
		fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_nonempty_environment_key_takes_precedence_over_the_local_file() {
		let (dir, path) = scratch_key_file();
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(&path, "local-test-key").unwrap();

		assert_eq!(
			resolve_openrouter_api_key(
				Some("environment-test-key".to_owned()),
				Some(&path),
				Some("keyring-test-key".to_owned()),
			)
			.as_deref(),
			Some("environment-test-key")
		);
		fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn prefers_the_keyring_to_the_legacy_file_when_environment_is_empty() {
		let (dir, path) = scratch_key_file();
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(&path, "legacy-file-key").unwrap();

		assert_eq!(
			resolve_openrouter_api_key(
				None,
				Some(&path),
				Some("saved-keyring-key".to_owned()),
			)
			.as_deref(),
			Some("saved-keyring-key")
		);
		fs::remove_dir_all(dir).unwrap();
	}
}

#[cfg(target_os = "android")]
pub fn shared() -> Option<grindr::GrindrClient> {
	SHARED.get().cloned()
}

pub fn share(
	build: impl FnOnce() -> grindr::GrindrClient,
) -> grindr::GrindrClient {
	SHARED.get_or_init(build).clone()
}
