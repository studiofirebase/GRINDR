use serde::{Deserialize, Serialize};
use std::sync::{Mutex, PoisonError};

use crate::error::AppError;

const ENTRY_NAME: &str = "profiles";
pub const MAX_PROFILES: usize = 5;
static UPDATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedProfile {
	pub profile_id: String,
	pub name: String,
	pub device: grindr::DeviceInfo,
	pub credentials: grindr::Credentials,
	pub signing_key: Option<grindr::DeviceSigningKey>,
	#[serde(default)]
	pub geohash: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SavedProfiles {
	pub active_profile_id: Option<String>,
	pub profiles: Vec<SavedProfile>,
}

pub struct ProfileStorage;

impl ProfileStorage {
	pub fn load() -> Result<SavedProfiles, AppError> {
		let entry = super::entry(ENTRY_NAME)?;
		let bytes = match entry.get_secret() {
			Ok(bytes) => bytes,
			Err(keyring_core::Error::NoEntry) => {
				return Ok(SavedProfiles::default());
			}
			Err(error) => return Err(AppError::Auth(error.to_string())),
		};
		rmp_serde::from_slice(&bytes).map_err(|error| {
			AppError::Auth(format!("profiles decode failed: {error}"))
		})
	}

	pub fn save(profiles: &SavedProfiles) -> Result<(), AppError> {
		let bytes =
			rmp_serde::encode::to_vec_named(profiles).map_err(|error| {
				AppError::Auth(format!("profiles encode failed: {error}"))
			})?;
		super::entry(ENTRY_NAME)?
			.set_secret(&bytes)
			.map_err(|error| AppError::Auth(error.to_string()))
	}

	pub fn save_profile(profile: SavedProfile) -> Result<(), AppError> {
		let _guard = UPDATE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		let mut saved = Self::load()?;
		upsert_profile(&mut saved, profile, true)?;
		Self::save(&saved)
	}

	pub fn save_active_profile(profile: SavedProfile) -> Result<(), AppError> {
		let geohash = profile.geohash.clone();
		Self::save_active_profile_inner(profile, geohash, true)
	}

	pub fn save_active_profile_with_location(
		profile: SavedProfile,
		geohash: Option<String>,
	) -> Result<(), AppError> {
		Self::save_active_profile_inner(profile, geohash, false)
	}

	fn save_active_profile_inner(
		mut profile: SavedProfile,
		geohash: Option<String>,
		preserve_location: bool,
	) -> Result<(), AppError> {
		let _guard = UPDATE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		let profile_id = profile.profile_id.clone();
		let mut saved = Self::load()?;
		profile.geohash = geohash;
		upsert_profile(&mut saved, profile, preserve_location)?;
		saved.active_profile_id = Some(profile_id);
		Self::save(&saved)
	}
}

fn upsert_profile(
	saved: &mut SavedProfiles,
	mut profile: SavedProfile,
	preserve_location: bool,
) -> Result<(), AppError> {
	if let Some(existing) = saved
		.profiles
		.iter_mut()
		.find(|existing| existing.profile_id == profile.profile_id)
	{
		if preserve_location && profile.geohash.is_none() {
			profile.geohash = existing.geohash.clone();
		}
		*existing = profile;
	} else {
		if saved.profiles.len() >= MAX_PROFILES {
			return Err(AppError::Auth(format!(
				"at most {MAX_PROFILES} profiles can be saved"
			)));
		}
		saved.profiles.push(profile);
	}
	Ok(())
}

impl ProfileStorage {
	pub fn set_active(profile_id: Option<String>) -> Result<(), AppError> {
		let _guard = UPDATE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		let mut saved = Self::load()?;
		if let Some(profile_id) = &profile_id {
			if !saved
				.profiles
				.iter()
				.any(|profile| &profile.profile_id == profile_id)
			{
				return Err(AppError::Auth("profile is not saved".to_owned()));
			}
		}
		saved.active_profile_id = profile_id;
		Self::save(&saved)
	}

	pub fn remove(profile_id: &str) -> Result<(), AppError> {
		let _guard = UPDATE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
		let mut saved = Self::load()?;
		saved
			.profiles
			.retain(|profile| profile.profile_id != profile_id);
		if saved.active_profile_id.as_deref() == Some(profile_id) {
			saved.active_profile_id = None;
		}
		Self::save(&saved)
	}
}
