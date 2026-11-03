use std::sync::{Mutex, PoisonError};

mod entries;
#[cfg(any(
	target_os = "linux",
	all(
		target_os = "macos",
		not(feature = "keychain"),
		not(feature = "memory-storage")
	)
))]
mod file_store;
mod keyring;
#[cfg(any(
	test,
	all(
		target_os = "macos",
		feature = "keychain",
		not(feature = "memory-storage")
	)
))]
mod legacy;
mod profiles;

pub use entries::{
	AuthStorage, DeviceStorage, OpenRouterKeyStorage, SigningKeyStorage,
};
pub(crate) use keyring::{entry, Entry};
#[cfg(all(
	target_os = "macos",
	feature = "keychain",
	not(feature = "memory-storage")
))]
pub use legacy::adopt_legacy_items;
pub use profiles::{ProfileStorage, SavedProfile, MAX_PROFILES};

#[cfg(any(
	target_os = "linux",
	all(
		target_os = "macos",
		not(feature = "keychain"),
		not(feature = "memory-storage")
	)
))]
pub fn init_file_store(base: std::path::PathBuf) {
	file_store::init(base);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageBackend {
	Keyring,
	File,
	Memory,
	Unavailable,
}

const STARTUP_PROBE: &str = "startup-probe";

const HAS_FILE_STORE: bool = cfg!(any(
	target_os = "linux",
	all(
		target_os = "macos",
		not(feature = "keychain"),
		not(feature = "memory-storage")
	)
));
const IS_MEMORY_STORE: bool =
	cfg!(all(target_os = "macos", feature = "memory-storage"));

pub fn init_keyring() -> StorageBackend {
	static USABLE: Mutex<Option<StorageBackend>> = Mutex::new(None);
	cached(&USABLE, probe_keyring)
}

fn cached(
	usable: &Mutex<Option<StorageBackend>>,
	probe: impl FnOnce() -> StorageBackend,
) -> StorageBackend {
	let mut usable = usable.lock().unwrap_or_else(PoisonError::into_inner);
	if let Some(backend) = *usable {
		return backend;
	}
	let backend = probe();
	if backend != StorageBackend::Unavailable {
		*usable = Some(backend);
	}
	backend
}

fn probe_keyring() -> StorageBackend {
	let backend = match install_platform_store() {
		Ok(()) if IS_MEMORY_STORE => StorageBackend::Memory,
		Ok(()) => StorageBackend::Keyring,
		Err(e) if HAS_FILE_STORE => {
			tracing::warn!(
				"[storage] no platform keyring, keeping file store: {e}"
			);
			StorageBackend::File
		}
		Err(e) => {
			tracing::error!("[storage] no platform keyring: {e}");
			StorageBackend::Unavailable
		}
	};
	if backend != StorageBackend::Unavailable && !round_trips() {
		tracing::error!("[storage] the credential store failed a round trip");
		return StorageBackend::Unavailable;
	}
	backend
}

#[cfg(target_os = "ios")]
fn install_platform_store() -> Result<(), String> {
	let store = apple_native_keyring_store::protected::Store::new()
		.map_err(|e| e.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[cfg(target_os = "android")]
fn install_platform_store() -> Result<(), String> {
	let store = android_native_keyring_store::Store::new()
		.map_err(|e| e.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[cfg(all(target_os = "macos", feature = "memory-storage"))]
fn install_platform_store() -> Result<(), String> {
	let store =
		keyring_core::mock::Store::new().map_err(|error| error.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[cfg(all(
	target_os = "macos",
	feature = "keychain",
	not(feature = "memory-storage")
))]
fn install_platform_store() -> Result<(), String> {
	let store = apple_native_keyring_store::keychain::Store::new()
		.map_err(|e| e.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[cfg(all(
	target_os = "macos",
	not(feature = "keychain"),
	not(feature = "memory-storage")
))]
fn install_platform_store() -> Result<(), String> {
	Err("built without the keychain feature".to_owned())
}

#[cfg(target_os = "windows")]
fn install_platform_store() -> Result<(), String> {
	let store = windows_native_keyring_store::Store::new()
		.map_err(|e| e.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[cfg(target_os = "linux")]
fn install_platform_store() -> Result<(), String> {
	let store = dbus_secret_service_keyring_store::Store::new()
		.map_err(|e| e.to_string())?;
	keyring_core::set_default_store(store);
	Ok(())
}

#[tauri::command]
pub fn storage_backend(
	backend: tauri::State<'_, StorageBackend>,
) -> StorageBackend {
	*backend
}

fn round_trips() -> bool {
	let Ok(entry) = entry(STARTUP_PROBE) else {
		return false;
	};
	let ok = entry.set_secret(b"ok").is_ok()
		&& entry.get_secret().is_ok_and(|secret| secret == b"ok");
	let _ = entry.delete_credential();
	ok
}

#[cfg(all(
	test,
	any(
		target_os = "linux",
		all(
			target_os = "macos",
			not(feature = "keychain"),
			not(feature = "memory-storage")
		)
	)
))]
pub(crate) mod test_support {
	use std::path::Path;
	use std::sync::Mutex;

	use super::{file_store, init_file_store};

	static DEFAULT_STORE: Mutex<()> = Mutex::new(());

	pub(crate) fn lock() -> std::sync::MutexGuard<'static, ()> {
		DEFAULT_STORE.lock().unwrap_or_else(|e| e.into_inner())
	}

	pub(crate) fn with_file_store(test: impl FnOnce(&Path)) {
		let _guard = lock();
		let base = file_store::scratch_dir();
		init_file_store(base.clone());
		test(&base);
		std::fs::remove_dir_all(&base).ok();
	}
}

#[cfg(all(
	test,
	any(
		target_os = "linux",
		all(
			target_os = "macos",
			not(feature = "keychain"),
			not(feature = "memory-storage")
		)
	)
))]
mod tests {
	use std::sync::Barrier;
	use std::time::Duration;

	use super::test_support::{lock, with_file_store};
	use super::*;

	const PERSISTED_ENTRIES: [&str; 4] =
		["device-info", "device-signing-key", "profiles", "session"];

	fn entry(user: &str) -> keyring_core::Entry {
		keyring_core::Entry::new("open-grind", user).unwrap()
	}

	fn credentials(auth_token: &str) -> grindr::Credentials {
		grindr::Credentials {
			email: "user@example.com".to_owned(),
			profile_id: Some("42".to_owned()),
			auth_token: auth_token.to_owned(),
			kind: grindr::SessionKind::Email,
			third_party_user_id: None,
		}
	}

	fn signing_key() -> grindr::DeviceSigningKey {
		serde_json::from_value(serde_json::json!({
			"key": "-----BEGIN PRIVATE KEY-----",
			"user_id": "42",
		}))
		.unwrap()
	}

	fn saved_profile(profile_id: &str) -> SavedProfile {
		let mut credentials = credentials("auth-token");
		credentials.profile_id = Some(profile_id.to_owned());
		SavedProfile {
			profile_id: profile_id.to_owned(),
			name: format!("profile {profile_id}"),
			device: grindr::DeviceInfo::generate(),
			credentials,
			signing_key: None,
			geohash: None,
		}
	}

	#[test]
	fn profiles_are_persisted_independently_and_active_profile_is_tracked() {
		with_file_store(|_| {
			ProfileStorage::save_active_profile(saved_profile("42")).unwrap();
			ProfileStorage::save_profile(saved_profile("43")).unwrap();
			let saved = ProfileStorage::load().unwrap();
			assert_eq!(saved.profiles.len(), 2);
			assert_eq!(saved.active_profile_id.as_deref(), Some("42"));

			ProfileStorage::set_active(Some("43".to_owned())).unwrap();
			ProfileStorage::remove("42").unwrap();
			let saved = ProfileStorage::load().unwrap();
			assert_eq!(saved.profiles.len(), 1);
			assert_eq!(saved.profiles[0].profile_id, "43");
			assert_eq!(saved.active_profile_id.as_deref(), Some("43"));
		});
	}

	#[test]
	fn profile_locations_survive_session_refreshes_and_can_be_cleared() {
		with_file_store(|_| {
			let mut profile = saved_profile("42");
			profile.geohash = Some("u33dc1c1f1s0".to_owned());
			ProfileStorage::save_active_profile(profile).unwrap();

			ProfileStorage::save_active_profile(saved_profile("42")).unwrap();
			assert_eq!(
				ProfileStorage::load().unwrap().profiles[0]
					.geohash
					.as_deref(),
				Some("u33dc1c1f1s0")
			);

			ProfileStorage::save_active_profile_with_location(
				saved_profile("42"),
				None,
			)
			.unwrap();
			assert_eq!(
				ProfileStorage::load().unwrap().profiles[0].geohash,
				None
			);
		});
	}

	#[test]
	fn profiles_saved_before_location_support_load_with_no_location() {
		#[derive(serde::Serialize)]
		struct LegacyProfile<'a> {
			profile_id: &'a str,
			name: &'a str,
			device: &'a grindr::DeviceInfo,
			credentials: &'a grindr::Credentials,
			signing_key: &'a Option<grindr::DeviceSigningKey>,
		}

		#[derive(serde::Serialize)]
		struct LegacyProfiles<'a> {
			active_profile_id: Option<&'a str>,
			profiles: Vec<LegacyProfile<'a>>,
		}

		with_file_store(|_| {
			let profile = saved_profile("42");
			let legacy = LegacyProfiles {
				active_profile_id: Some("42"),
				profiles: vec![LegacyProfile {
					profile_id: &profile.profile_id,
					name: &profile.name,
					device: &profile.device,
					credentials: &profile.credentials,
					signing_key: &profile.signing_key,
				}],
			};
			entry("profiles")
				.set_secret(&rmp_serde::to_vec_named(&legacy).unwrap())
				.unwrap();

			let loaded = ProfileStorage::load().unwrap();
			assert_eq!(loaded.profiles[0].geohash, None);
		});
	}

	#[test]
	fn the_profile_store_enforces_its_five_profile_limit() {
		with_file_store(|_| {
			for id in ["1", "2", "3", "4", "5"] {
				ProfileStorage::save_profile(saved_profile(id)).unwrap();
			}
			assert!(ProfileStorage::save_profile(saved_profile("6")).is_err());
			assert_eq!(ProfileStorage::load().unwrap().profiles.len(), 5);
		});
	}

	#[test]
	fn the_installed_store_backs_every_keyring_entry() {
		with_file_store(|base| {
			DeviceStorage::save(&grindr::DeviceInfo::generate()).unwrap();
			AuthStorage::set_credentials(&credentials("auth-token")).unwrap();
			SigningKeyStorage::save(&signing_key()).unwrap();
			ProfileStorage::save_profile(saved_profile("42")).unwrap();

			let mut written: Vec<_> =
				std::fs::read_dir(base.join("credentials"))
					.unwrap()
					.map(|e| {
						e.unwrap().file_name().to_string_lossy().into_owned()
					})
					.collect();
			written.sort();
			assert_eq!(written, PERSISTED_ENTRIES);
		});
	}

	#[test]
	fn the_windows_uninstaller_clears_every_keyring_entry() {
		let hooks = include_str!("../../installer-hooks.nsh");
		for name in PERSISTED_ENTRIES {
			assert!(
				hooks.contains(&format!("\"{name}.open-grind\"")),
				"installer-hooks.nsh leaves {name} in Credential Manager"
			);
		}
	}

	#[test]
	fn a_probe_leaves_a_usable_store_behind() {
		with_file_store(|_| {
			let backend = probe_keyring();

			assert_ne!(backend, StorageBackend::Unavailable);
			assert!(keyring_core::get_default_store().is_some());
			assert!(keyring_core::Entry::new("open-grind", "session").is_ok());
		});
	}

	#[test]
	fn a_second_init_keyring_reuses_the_first_probe() {
		with_file_store(|_| {
			let first = init_keyring();
			keyring_core::unset_default_store();

			assert_eq!(init_keyring(), first);
			assert!(keyring_core::get_default_store().is_none());
		});
	}

	#[test]
	fn a_failed_probe_is_tried_again_and_a_usable_one_is_kept() {
		let usable = Mutex::new(None);

		assert_eq!(
			cached(&usable, || StorageBackend::Unavailable),
			StorageBackend::Unavailable
		);
		assert_eq!(
			cached(&usable, || StorageBackend::File),
			StorageBackend::File
		);
		assert_eq!(
			cached(&usable, || unreachable!("a usable backend is probed once")),
			StorageBackend::File
		);
	}

	#[test]
	fn probes_from_many_threads_never_overlap() {
		let usable = Mutex::new(None);
		let probing = Mutex::new(());
		let start = Barrier::new(8);

		std::thread::scope(|scope| {
			for _ in 0..8 {
				scope.spawn(|| {
					start.wait();
					cached(&usable, || {
						let _probing = probing
							.try_lock()
							.expect("another probe is already running");
						std::thread::sleep(Duration::from_millis(20));
						StorageBackend::Unavailable
					})
				});
			}
		});
	}

	#[test]
	fn the_probe_leaves_nothing_behind() {
		with_file_store(|_| {
			assert!(round_trips());
			assert!(matches!(
				entry("startup-probe").get_secret(),
				Err(keyring_core::Error::NoEntry)
			));
		});
	}

	#[test]
	fn a_store_that_cannot_round_trip_reads_as_unavailable() {
		let _guard = lock();
		keyring_core::unset_default_store();

		assert!(!round_trips());
	}

	#[test]
	fn nothing_is_stored_before_anything_is_saved() {
		with_file_store(|_| {
			assert!(DeviceStorage::load().unwrap().is_none());
			assert!(AuthStorage::get_credentials().unwrap().is_none());
			assert!(SigningKeyStorage::load().unwrap().is_none());
		});
	}

	#[test]
	fn a_device_survives_a_save_and_load() {
		with_file_store(|_| {
			let device = grindr::DeviceInfo::generate();

			DeviceStorage::save(&device).unwrap();

			let loaded = DeviceStorage::load().unwrap().unwrap();
			assert_eq!(format!("{loaded:?}"), format!("{device:?}"));
		});
	}

	#[test]
	fn a_device_stored_before_build_id_existed_still_loads() {
		#[derive(serde::Serialize)]
		struct DeviceBeforeBuildId {
			device_type: u8,
			device_id: &'static str,
			os: &'static str,
			screen_resolution: &'static str,
			total_ram: &'static str,
			advertising_id: &'static str,
			device_model: &'static str,
			manufacturer: &'static str,
			timezone: &'static str,
			locale: &'static str,
			accept_language: &'static str,
		}

		with_file_store(|_| {
			let stored = rmp_serde::encode::to_vec(&DeviceBeforeBuildId {
				device_type: 2,
				device_id: "0123456789abcdef",
				os: "Android 14",
				screen_resolution: "2400x1080",
				total_ram: "8026152960",
				advertising_id: "ad-id",
				device_model: "Pixel 8",
				manufacturer: "Google",
				timezone: "Europe/Madrid",
				locale: "en_US",
				accept_language: "en-US",
			})
			.unwrap();
			entry("device-info").set_secret(&stored).unwrap();

			let loaded = DeviceStorage::load().unwrap().unwrap();

			assert_eq!(loaded.device_id, "0123456789abcdef");
			assert_eq!(loaded.device_model, "Pixel 8");
			assert!(loaded.build_id.is_empty());
		});
	}

	#[test]
	fn every_secret_is_stored_as_a_named_map_not_a_positional_array() {
		with_file_store(|_| {
			DeviceStorage::save(&grindr::DeviceInfo::generate()).unwrap();
			AuthStorage::set_credentials(&credentials("tok-1")).unwrap();
			SigningKeyStorage::save(&signing_key()).unwrap();

			for name in ["device-info", "session", "device-signing-key"] {
				let stored = entry(name).get_secret().unwrap();
				let decoded: serde_json::Value =
					rmp_serde::from_slice(&stored).unwrap();

				assert!(
					decoded.is_object(),
					"{name} is a positional array, not a named map"
				);
			}
		});
	}

	#[test]
	fn a_device_that_cannot_be_decoded_is_reported_as_an_error() {
		with_file_store(|_| {
			entry("device-info").set_secret(b"not msgpack").unwrap();

			assert!(DeviceStorage::load().is_err());
		});
	}

	#[test]
	fn a_created_device_is_persisted_for_the_next_launch() {
		with_file_store(|_| {
			let created = DeviceStorage::load_or_create();

			assert_eq!(
				format!("{:?}", DeviceStorage::load_or_create()),
				format!("{created:?}")
			);
		});
	}

	#[test]
	fn a_device_that_cannot_be_decoded_is_replaced_rather_than_regenerated_forever(
	) {
		with_file_store(|_| {
			entry("device-info").set_secret(b"not msgpack").unwrap();

			let replacement = DeviceStorage::load_or_create();

			assert_eq!(
				format!("{:?}", DeviceStorage::load().unwrap().unwrap()),
				format!("{replacement:?}")
			);
		});
	}

	#[test]
	fn deleting_the_device_clears_it() {
		with_file_store(|_| {
			DeviceStorage::save(&grindr::DeviceInfo::generate()).unwrap();

			DeviceStorage::delete();

			assert!(DeviceStorage::load().unwrap().is_none());
		});
	}

	#[test]
	fn credentials_survive_a_save_and_load() {
		with_file_store(|_| {
			let saved = credentials("auth-token");

			AuthStorage::set_credentials(&saved).unwrap();

			assert_eq!(AuthStorage::get_credentials().unwrap().unwrap(), saved);
		});
	}

	#[test]
	fn credentials_that_cannot_be_decoded_are_discarded_rather_than_kept() {
		with_file_store(|_| {
			entry("session").set_secret(b"not msgpack").unwrap();

			assert!(AuthStorage::get_credentials().unwrap().is_none());
			assert!(matches!(
				entry("session").get_secret(),
				Err(keyring_core::Error::NoEntry)
			));
		});
	}

	#[test]
	fn a_session_stored_before_credentials_existed_still_loads() {
		with_file_store(|_| {
			let legacy = serde_json::json!({
				"email": "user@example.com",
				"expires_at": 9_999_999_999u64,
				"profile_id": "42",
				"session_id": "e".repeat(3056),
				"auth_token": "auth-token",
				"kind": "Google",
				"third_party_user_id": "tp-1",
				"restriction": {
					"AgeVerification": {
						"region": "GB",
						"reason": "age_verification_required",
					},
				},
			});
			entry("session")
				.set_secret(&rmp_serde::encode::to_vec_named(&legacy).unwrap())
				.unwrap();

			let loaded = AuthStorage::get_credentials().unwrap().unwrap();
			assert_eq!(loaded.email, "user@example.com");
			assert_eq!(loaded.profile_id.as_deref(), Some("42"));
			assert_eq!(loaded.auth_token, "auth-token");
			assert_eq!(loaded.kind, grindr::SessionKind::Google);
			assert_eq!(loaded.third_party_user_id.as_deref(), Some("tp-1"));
		});
	}

	#[test]
	fn stored_credentials_stay_far_under_the_windows_blob_cap() {
		const CRED_MAX_CREDENTIAL_BLOB_SIZE: usize = 2560;

		let worst_case = grindr::Credentials {
			email: "a-fairly-long-address@example.com".to_owned(),
			profile_id: Some("1234567890123".to_owned()),
			auth_token: "t".repeat(512),
			kind: grindr::SessionKind::Google,
			third_party_user_id: Some("x".repeat(128)),
		};

		let encoded = rmp_serde::encode::to_vec_named(&worst_case).unwrap();
		assert!(
			encoded.len() < CRED_MAX_CREDENTIAL_BLOB_SIZE,
			"credentials encode to {} bytes",
			encoded.len()
		);
	}

	#[test]
	fn setting_credentials_replaces_the_previous_ones() {
		with_file_store(|_| {
			AuthStorage::set_credentials(&credentials("first")).unwrap();
			AuthStorage::set_credentials(&credentials("second")).unwrap();

			assert_eq!(
				AuthStorage::get_credentials().unwrap().unwrap().auth_token,
				"second"
			);
		});
	}

	#[test]
	fn deleting_the_session_clears_it() {
		with_file_store(|_| {
			AuthStorage::set_credentials(&credentials("auth-token")).unwrap();

			AuthStorage::delete_credentials();

			assert!(AuthStorage::get_credentials().unwrap().is_none());
		});
	}

	#[test]
	fn a_signing_key_survives_a_save_and_load() {
		with_file_store(|_| {
			let key = signing_key();

			SigningKeyStorage::save(&key).unwrap();

			let loaded = SigningKeyStorage::load().unwrap().unwrap();
			assert_eq!(format!("{loaded:?}"), format!("{key:?}"));
		});
	}

	#[test]
	fn a_signing_key_that_cannot_be_decoded_reads_as_absent() {
		with_file_store(|_| {
			entry("device-signing-key")
				.set_secret(b"not msgpack")
				.unwrap();

			assert!(SigningKeyStorage::load().unwrap().is_none());
		});
	}

	#[test]
	fn a_signing_key_the_client_refuses_is_dropped_from_storage() {
		with_file_store(|_| {
			SigningKeyStorage::save(&signing_key()).unwrap();
			let client = grindr::GrindrClient::new(
				grindr::DeviceInfo::generate(),
				Some(grindr::Session {
					credentials: credentials("auth-token"),
					token: None,
				}),
			)
			.unwrap();

			tokio::runtime::Builder::new_current_thread()
				.build()
				.unwrap()
				.block_on(SigningKeyStorage::restore(&client));

			assert!(SigningKeyStorage::load().unwrap().is_none());
		});
	}

	#[test]
	fn deleting_the_signing_key_clears_it() {
		with_file_store(|_| {
			SigningKeyStorage::save(&signing_key()).unwrap();

			SigningKeyStorage::delete();

			assert!(SigningKeyStorage::load().unwrap().is_none());
		});
	}

	#[test]
	fn with_no_store_at_all_the_storages_report_errors_instead_of_panicking() {
		let _guard = lock();
		keyring_core::unset_default_store();

		assert!(DeviceStorage::load().is_err());
		assert!(AuthStorage::get_credentials().is_err());
		assert!(SigningKeyStorage::load().is_err());
		assert!(
			AuthStorage::set_credentials(&credentials("auth-token")).is_err()
		);
		DeviceStorage::delete();
		AuthStorage::delete_credentials();
		SigningKeyStorage::delete();
	}
}

#[cfg(all(test, target_os = "macos", feature = "memory-storage"))]
mod memory_storage_tests {
	use super::*;

	fn credentials() -> grindr::Credentials {
		grindr::Credentials {
			email: "memory@example.com".to_owned(),
			profile_id: Some("memory-profile".to_owned()),
			auth_token: "memory-token".to_owned(),
			kind: grindr::SessionKind::Email,
			third_party_user_id: None,
		}
	}

	#[test]
	fn session_data_exists_only_in_the_current_memory_store() {
		assert_eq!(init_keyring(), StorageBackend::Memory);
		let saved = credentials();
		AuthStorage::set_credentials(&saved).unwrap();
		assert_eq!(AuthStorage::get_credentials().unwrap(), Some(saved));

		keyring_core::unset_default_store();
		install_platform_store().unwrap();
		assert!(AuthStorage::get_credentials().unwrap().is_none());
	}
}
