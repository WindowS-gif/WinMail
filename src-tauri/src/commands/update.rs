use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::core::error::AppError;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/WindowS-gif/WinMail/releases/latest";

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub changelog: String,
    pub release_url: String,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct InstallUpdatePayload {
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    body: Option<String>,
    html_url: String,
    assets: Vec<GitHubAsset>,
}

/// Parse a version string (with optional `v` prefix) into (major, minor, patch).
fn parse_version(v: &str) -> Result<(u64, u64, u64), AppError> {
    let v = v.strip_prefix('v').unwrap_or(v);
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 {
        return Err(AppError::Validation(format!("Invalid version format: {v}")));
    }
    let major = parts[0]
        .parse::<u64>()
        .map_err(|e| AppError::Validation(format!("Bad major version: {e}")))?;
    let minor = parts[1]
        .parse::<u64>()
        .map_err(|e| AppError::Validation(format!("Bad minor version: {e}")))?;
    let patch = parts[2]
        .parse::<u64>()
        .map_err(|e| AppError::Validation(format!("Bad patch version: {e}")))?;
    Ok((major, minor, patch))
}

/// Returns true when `latest` is strictly newer than `current`.
fn is_newer(current: &str, latest: &str) -> Result<bool, AppError> {
    let c = parse_version(current)?;
    let l = parse_version(latest)?;
    Ok(l > c)
}

/// Pick the best download asset for the running OS, falling back to the release page URL.
fn pick_download_url(assets: &[GitHubAsset], fallback: &str) -> String {
    let dominated: Option<&GitHubAsset> = if cfg!(target_os = "windows") {
        // Prefer a setup installer, then any .exe
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.ends_with("setup.exe") || n.ends_with("_setup.exe")
            })
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".exe"))
            })
    } else if cfg!(target_os = "linux") {
        assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".appimage"))
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".deb"))
            })
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".rpm"))
            })
            .or_else(|| {
                assets
                    .iter()
                    .find(|a| a.name.to_lowercase().ends_with(".tar.gz"))
            })
    } else if cfg!(target_os = "macos") {
        assets
            .iter()
            .find(|a| a.name.to_lowercase().ends_with(".dmg"))
    } else {
        None
    };

    dominated
        .map(|a| a.browser_download_url.clone())
        .unwrap_or_else(|| fallback.to_string())
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Validation(format!("Failed to create HTTP client: {e}")))?;

    let release: GitHubRelease = client
        .get(GITHUB_RELEASES_URL)
        .header("User-Agent", format!("WinMail/{CURRENT_VERSION}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Validation(format!("Failed to fetch release info: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Validation(format!("GitHub API error: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Validation(format!("Failed to parse release JSON: {e}")))?;

    let latest_version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    let update_available = is_newer(CURRENT_VERSION, latest_version)?;
    let download_url = pick_download_url(&release.assets, &release.html_url);

    Ok(UpdateInfo {
        update_available,
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_version.to_string(),
        changelog: release.body.unwrap_or_default(),
        release_url: release.html_url,
        download_url,
    })
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    payload: InstallUpdatePayload,
) -> Result<Value, AppError> {
    let url = reqwest::Url::parse(&payload.download_url)
        .map_err(|e| AppError::Validation(format!("Invalid update URL: {e}")))?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err(AppError::Validation(
            "Update URL must be HTTP or HTTPS".to_string(),
        ));
    }

    let filename = update_filename_from_url(url.path()).ok_or_else(|| {
        AppError::Validation(
            "Update URL does not contain a downloadable asset filename".to_string(),
        )
    })?;
    if !is_direct_update_asset(&filename) {
        return Err(AppError::Validation(
            "No direct installer asset is available for this platform.".to_string(),
        ));
    }

    let update_dir = std::env::temp_dir().join("WinMail-updates");
    tokio::fs::create_dir_all(&update_dir).await?;
    let destination = update_dir.join(&filename);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| AppError::Validation(format!("Failed to create HTTP client: {e}")))?;
    let bytes = client
        .get(url)
        .header("User-Agent", format!("WinMail/{CURRENT_VERSION}"))
        .send()
        .await
        .map_err(|e| AppError::Validation(format!("Failed to download update: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Validation(format!("Update download failed: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Validation(format!("Failed to read update: {e}")))?;

    if bytes.is_empty() {
        return Err(AppError::Validation(
            "Downloaded update is empty".to_string(),
        ));
    }
    tokio::fs::write(&destination, &bytes).await?;

    launch_update_asset(&destination)?;

    // On Windows, the NSIS installer must be able to replace the running app.
    // Give the frontend enough time to receive the command response, then exit.
    if cfg!(target_os = "windows") {
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(900));
            app_handle.exit(0);
        });
    }

    Ok(json!({
        "started": true,
        "path": destination.display().to_string(),
        "message": if cfg!(target_os = "windows") {
            "Installer launched. The app will close to complete the update."
        } else {
            "Update package opened. Follow your system installer prompts."
        }
    }))
}

fn update_filename_from_url(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(sanitize_update_filename(name))
    }
}

fn sanitize_update_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn is_direct_update_asset(filename: &str) -> bool {
    let name = filename.to_ascii_lowercase();
    if cfg!(target_os = "windows") {
        name.ends_with(".exe")
    } else if cfg!(target_os = "linux") {
        name.ends_with(".appimage")
            || name.ends_with(".deb")
            || name.ends_with(".rpm")
            || name.ends_with(".tar.gz")
    } else if cfg!(target_os = "macos") {
        name.ends_with(".dmg")
    } else {
        false
    }
}

fn launch_update_asset(path: &Path) -> Result<(), AppError> {
    let mut command = if cfg!(target_os = "windows") {
        Command::new(path)
    } else if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map_err(|e| AppError::Validation(format!("Failed to launch update installer: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v1.2.3").unwrap(), (1, 2, 3));
        assert_eq!(parse_version("1.2.3").unwrap(), (1, 2, 3));
    }

    #[test]
    fn parse_version_rejects_invalid() {
        assert!(parse_version("1.2").is_err());
        assert!(parse_version("abc").is_err());
        assert!(parse_version("1.2.x").is_err());
    }

    #[test]
    fn is_newer_detects_updates() {
        assert!(is_newer("1.0.4", "1.0.5").unwrap());
        assert!(is_newer("1.0.4", "1.1.0").unwrap());
        assert!(is_newer("1.0.4", "2.0.0").unwrap());
        assert!(is_newer("0.9.9", "1.0.0").unwrap());
    }

    #[test]
    fn is_newer_rejects_same_or_older() {
        assert!(!is_newer("1.0.4", "1.0.4").unwrap());
        assert!(!is_newer("1.0.5", "1.0.4").unwrap());
        assert!(!is_newer("2.0.0", "1.9.9").unwrap());
    }

    #[test]
    fn is_newer_handles_v_prefix() {
        assert!(is_newer("v1.0.0", "v1.0.1").unwrap());
        assert!(!is_newer("v1.0.1", "1.0.0").unwrap());
    }

    #[test]
    fn update_filename_from_url_sanitizes_asset_name() {
        assert_eq!(
            update_filename_from_url("/repos/x/releases/assets/WinMail_1.0.8_x64-setup.exe")
                .as_deref(),
            Some("WinMail_1.0.8_x64-setup.exe")
        );
        assert_eq!(
            update_filename_from_url("/bad/..\\evil.exe").as_deref(),
            Some(".._evil.exe")
        );
    }

    #[test]
    fn sanitize_update_filename_strips_unsafe_chars() {
        assert_eq!(
            sanitize_update_filename("hello world!.exe"),
            "hello_world_.exe"
        );
        assert_eq!(sanitize_update_filename("../setup.exe"), ".._setup.exe");
    }

    #[test]
    fn direct_asset_detection_matches_current_platform() {
        if cfg!(target_os = "windows") {
            assert!(is_direct_update_asset("WinMail_1.0.8_x64-setup.exe"));
            assert!(!is_direct_update_asset("WinMail_1.0.8_amd64.deb"));
        } else if cfg!(target_os = "linux") {
            assert!(is_direct_update_asset("WinMail_1.0.8_amd64.deb"));
            assert!(is_direct_update_asset(
                "WinMail_1.0.8_linux_x86_64.tar.gz"
            ));
            assert!(!is_direct_update_asset("WinMail_1.0.8_x64-setup.exe"));
        }
    }

    #[test]
    fn pick_download_url_returns_fallback_when_no_assets() {
        let assets: Vec<GitHubAsset> = vec![];
        assert_eq!(
            pick_download_url(&assets, "https://fallback"),
            "https://fallback"
        );
    }

    #[test]
    fn pick_download_url_finds_appimage_on_linux() {
        let assets = vec![
            GitHubAsset {
                name: "WinMail_1.0.5_amd64.deb".to_string(),
                browser_download_url: "https://example.com/deb".to_string(),
            },
            GitHubAsset {
                name: "WinMail_1.0.5_amd64.AppImage".to_string(),
                browser_download_url: "https://example.com/appimage".to_string(),
            },
        ];
        // On Linux, should pick the AppImage
        if cfg!(target_os = "linux") {
            assert_eq!(
                pick_download_url(&assets, "https://fallback"),
                "https://example.com/appimage"
            );
        }
    }

    #[test]
    fn pick_download_url_finds_exe_on_windows() {
        let assets = vec![
            GitHubAsset {
                name: "WinMail_1.0.5_x64-setup.exe".to_string(),
                browser_download_url: "https://example.com/setup".to_string(),
            },
            GitHubAsset {
                name: "WinMail_1.0.5_x64.msi".to_string(),
                browser_download_url: "https://example.com/msi".to_string(),
            },
        ];
        if cfg!(target_os = "windows") {
            assert_eq!(
                pick_download_url(&assets, "https://fallback"),
                "https://example.com/setup"
            );
        }
    }
}
