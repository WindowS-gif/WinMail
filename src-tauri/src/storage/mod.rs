use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Serialize};
use tokio::io::AsyncWriteExt;

use crate::core::error::{AppError, AppResult};

/// Reads & deserializes every `*.json` file from `dir` in parallel and returns
/// the values that successfully deserialized. Files that fail to parse are
/// skipped (logged at debug level) so a single corrupted file does not break
/// the list view.
pub async fn read_json_files<T>(dir: &Path, skip: impl Fn(&Path) -> bool) -> AppResult<Vec<T>>
where
    T: DeserializeOwned + Send + 'static,
{
    let files = list_json_files(dir).await?;
    let mut joins = Vec::with_capacity(files.len());
    for file in files {
        if skip(&file) {
            continue;
        }
        joins.push(tokio::spawn(async move {
            match read_json::<T>(&file).await {
                Ok(v) => Some(v),
                Err(err) => {
                    tracing::debug!(?file, %err, "skipping unreadable json file");
                    None
                }
            }
        }));
    }
    let mut out = Vec::with_capacity(joins.len());
    for handle in joins {
        if let Ok(Some(value)) = handle.await {
            out.push(value);
        }
    }
    Ok(out)
}

pub async fn ensure_dir(path: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(path).await?;
    Ok(())
}

pub async fn read_json<T>(path: &Path) -> AppResult<T>
where
    T: DeserializeOwned,
{
    let bytes = tokio::fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn write_json_pretty<T>(path: &Path, value: &T) -> AppResult<()>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        ensure_dir(parent).await?;
    }

    let tmp = tmp_path(path);
    let json = serde_json::to_vec_pretty(value)?;
    let mut file = tokio::fs::File::create(&tmp).await?;
    file.write_all(&json).await?;
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

pub async fn remove_file_if_exists(path: &Path) -> AppResult<bool> {
    match tokio::fs::remove_file(path).await {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(AppError::Io(e)),
    }
}

pub async fn list_json_files(dir: &Path) -> AppResult<Vec<PathBuf>> {
    ensure_dir(dir).await?;
    let mut out = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) == Some("json") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

fn tmp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("tmp.json");
    path.with_file_name(format!("{}.tmp", file_name))
}
