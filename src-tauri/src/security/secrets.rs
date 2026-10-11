use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine};

use crate::core::error::{AppError, AppResult};

const ENC_PREFIX: &str = "enc:v1:";
const KEY_FILENAME: &str = ".secrets.key";

static MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// Returns true if a value has already been encrypted by this module.
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

/// Initialise the master encryption key.
///
/// The key is stored once in `<app_data_dir>/.secrets.key`. On Unix it gets
/// `0600` permissions so only the current user can read it. The key never
/// leaves disk: at runtime we load it into a `OnceLock` and use it for AES-256
/// GCM encryption of secret fields.
pub fn initialize(app_data_dir: &Path) -> AppResult<()> {
    if MASTER_KEY.get().is_some() {
        return Ok(());
    }
    let key = load_or_create_master_key(app_data_dir)
        .map_err(|e| AppError::Security(format!("master key: {e}")))?;
    // Ignore set errors caused by concurrent initialise() races.
    let _ = MASTER_KEY.set(key);
    Ok(())
}

fn key_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(KEY_FILENAME)
}

fn load_or_create_master_key(app_data_dir: &Path) -> Result<[u8; 32], String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let path = key_path(app_data_dir);

    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);

    let tmp = path.with_extension("key.tmp");
    std::fs::write(&tmp, key).map_err(|e| e.to_string())?;
    apply_restricted_permissions(&tmp);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    apply_restricted_permissions(&path);

    Ok(key)
}

#[cfg(unix)]
fn apply_restricted_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn apply_restricted_permissions(_path: &Path) {
    // On Windows the file inherits the user-only ACL from the parent app data
    // directory created by Tauri. We rely on that for confidentiality.
}

fn master_key() -> AppResult<&'static [u8; 32]> {
    MASTER_KEY
        .get()
        .ok_or_else(|| AppError::Security("master key not initialised".to_string()))
}

/// Encrypts a UTF-8 string with AES-256-GCM. Empty strings and values that are
/// already encrypted are returned unchanged so the function is idempotent.
pub fn encrypt(plaintext: &str) -> AppResult<String> {
    if plaintext.is_empty() || is_encrypted(plaintext) {
        return Ok(plaintext.to_string());
    }
    let key_bytes = master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| AppError::Security(format!("encryption: {e}")))?;
    let mut combined = Vec::with_capacity(nonce.len() + ciphertext.len());
    combined.extend_from_slice(nonce.as_slice());
    combined.extend_from_slice(&ciphertext);
    let encoded = general_purpose::STANDARD.encode(&combined);
    Ok(format!("{ENC_PREFIX}{encoded}"))
}

/// Decrypts a value produced by `encrypt`. Non-encrypted inputs are returned as
/// is so legacy clear-text values keep working until they get re-saved.
pub fn decrypt(value: &str) -> AppResult<String> {
    if !is_encrypted(value) {
        return Ok(value.to_string());
    }
    let payload = &value[ENC_PREFIX.len()..];
    let combined = general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::Security(format!("base64: {e}")))?;
    if combined.len() < 12 {
        return Err(AppError::Security("invalid encrypted payload".to_string()));
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let key_bytes = master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| AppError::Security(format!("decryption: {e}")))?;
    String::from_utf8(plaintext).map_err(|e| AppError::Security(format!("utf-8: {e}")))
}
