use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::{AppPaths, AppState};
use crate::commands::legacy::LegacyAction;
use crate::core::api::ApiResponse;
use crate::core::error::{AppError, AppResult};
use crate::core::{now_local_string, prefixed_id};
use crate::storage;
use tokio::io::AsyncWriteExt;

/// Mark any campaign left in a live state (`running` / `paused`) as
/// `interrupted` at startup. The send engine lives in memory, so a campaign
/// that was sending when the app was closed has no task driving it anymore;
/// without this it would appear "running" forever with no way to recover.
/// The user can then relaunch it from where it stands.
pub async fn reconcile_orphaned_campaigns(paths: &AppPaths) {
    let files = match storage::list_json_files(&paths.campaigns_dir).await {
        Ok(f) => f,
        Err(err) => {
            tracing::warn!(%err, "could not list campaigns for reconciliation");
            return;
        }
    };
    for file in files {
        let Ok(mut campaign) = storage::read_json::<Campaign>(&file).await else {
            continue;
        };
        if matches!(campaign.status.as_str(), "running" | "paused") {
            campaign.status = "interrupted".to_string();
            campaign.stats.pending = campaign
                .stats
                .total
                .saturating_sub(campaign.stats.sent + campaign.stats.failed);
            campaign.updated_at = now_local_string();
            if let Err(err) = storage::write_json_pretty(&file, &campaign).await {
                tracing::warn!(%err, id = %campaign.id, "could not reconcile campaign");
            } else {
                tracing::info!(id = %campaign.id, "reconciled orphaned campaign -> interrupted");
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Campaign {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub stats: CampaignStats,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CampaignStats {
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub sent: usize,
    #[serde(default)]
    pub failed: usize,
    #[serde(default)]
    pub pending: usize,
}

#[derive(Debug, Deserialize)]
struct CampaignSavePayload {
    name: String,
    #[serde(default)]
    config: Value,
}

pub async fn campaigns_list_or_create(
    state: &State<'_, AppState>,
    method: &str,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    match method {
        "GET" => {
            let campaigns = list_campaigns_raw(state).await?;
            Ok(ApiResponse::ok(json!(campaigns)))
        }
        "POST" => campaign_create(state, data).await,
        _ => Ok(ApiResponse::err("Unsupported method for campaigns")),
    }
}

pub async fn campaign_get_update_delete(
    state: &State<'_, AppState>,
    action: &LegacyAction,
    method: &str,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing campaign id".to_string()))?;
    match method {
        "GET" => {
            let mut campaign = load_campaign(state, id)
                .await?
                .ok_or_else(|| AppError::NotFound(id.to_string()))?;
            if action.has_flag("with_logs") {
                let all_logs = load_campaign_logs(state, id).await?;
                let total = all_logs.len();
                // `log_offset` lets the client stream incrementally: we return
                // only the lines after the cursor plus the absolute total, so
                // a poller never re-appends the whole file.
                let offset = action
                    .get("log_offset")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0)
                    .min(total);
                let logs: Vec<Value> = all_logs.into_iter().skip(offset).collect();
                campaign.stats.pending = campaign
                    .stats
                    .total
                    .saturating_sub(campaign.stats.sent + campaign.stats.failed);
                let mut v = serde_json::to_value(&campaign)?;
                v["logs"] = json!(logs);
                v["logs_total"] = json!(total);
                return Ok(ApiResponse::ok(v));
            }
            campaign.stats.pending = campaign
                .stats
                .total
                .saturating_sub(campaign.stats.sent + campaign.stats.failed);
            Ok(ApiResponse::ok(json!(campaign)))
        }
        "PUT" => campaign_update(state, id, data).await,
        "DELETE" => {
            let _ = state.engine.stop(id).await;
            let path = state.paths.campaigns_dir.join(format!("{}.json", id));
            storage::remove_file_if_exists(&path).await?;
            let log_path = state.paths.campaigns_dir.join(format!("{}.log.jsonl", id));
            storage::remove_file_if_exists(&log_path).await?;
            Ok(ApiResponse::<Value>::empty_ok())
        }
        _ => Ok(ApiResponse::err("Unsupported method for campaign")),
    }
}

pub async fn campaign_logs(
    state: &State<'_, AppState>,
    action: &LegacyAction,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing campaign id".to_string()))?;
    let logs = load_campaign_logs(state, id).await?;
    Ok(ApiResponse::ok(json!(logs)))
}

pub async fn campaign_control(
    state: &State<'_, AppState>,
    app_handle: tauri::AppHandle,
    action_name: &str,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let id = data
        .get("campaign_id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("Missing campaign id".to_string()))?
        .to_string();

    // Ensure campaign exists
    let _ = load_campaign(state, &id)
        .await?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;

    let engine = state.engine.clone();
    match action_name {
        "send" | "retry_failed" => {
            engine
                .start(id.clone(), state.paths.clone(), app_handle)
                .await?;
        }
        "pause" => {
            engine.pause(&id).await?;
            mark_status(state, &id, "paused").await?;
        }
        "resume" => {
            engine.resume(&id).await?;
            mark_status(state, &id, "running").await?;
        }
        "stop" => {
            engine.stop(&id).await?;
            mark_status(state, &id, "stopped").await?;
        }
        _ => return Ok(ApiResponse::err("Unsupported campaign action")),
    }

    Ok(ApiResponse::ok(json!({ "campaign_id": id })))
}

async fn mark_status(state: &State<'_, AppState>, id: &str, status: &str) -> AppResult<()> {
    if let Some(mut campaign) = load_campaign(state, id).await? {
        campaign.status = status.to_string();
        campaign.updated_at = now_local_string();
        save_campaign(state, &campaign).await?;
    }
    Ok(())
}

pub async fn list_campaigns_raw(state: &State<'_, AppState>) -> AppResult<Vec<Campaign>> {
    // Only parse files that look like a campaign document, skip the JSONL logs.
    let mut campaigns = storage::read_json_files::<Campaign>(&state.paths.campaigns_dir, |path| {
        path.file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.ends_with(".log.jsonl") || s == "folders.json")
            .unwrap_or(false)
    })
    .await?;
    for campaign in &mut campaigns {
        campaign.stats.pending = campaign
            .stats
            .total
            .saturating_sub(campaign.stats.sent + campaign.stats.failed);
    }
    campaigns.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(campaigns)
}

async fn campaign_create(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let payload: CampaignSavePayload = serde_json::from_value(data)?;
    if payload.name.trim().is_empty() {
        return Ok(ApiResponse::err("Campaign name is required"));
    }
    let total = payload
        .config
        .get("total_recipients")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let now = now_local_string();
    let campaign = Campaign {
        id: prefixed_id("campaign"),
        name: payload.name,
        status: "draft".to_string(),
        config: payload.config,
        stats: CampaignStats {
            total,
            sent: 0,
            failed: 0,
            pending: total,
        },
        created_at: now.clone(),
        updated_at: now,
    };
    save_campaign(state, &campaign).await?;
    Ok(ApiResponse::ok(json!({ "id": campaign.id })))
}

async fn campaign_update(
    state: &State<'_, AppState>,
    id: &str,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let payload: CampaignSavePayload = serde_json::from_value(data)?;
    let mut campaign = load_campaign(state, id)
        .await?
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;
    campaign.name = payload.name;
    campaign.config = payload.config;
    campaign.stats.total = campaign
        .config
        .get("total_recipients")
        .and_then(Value::as_u64)
        .unwrap_or(campaign.stats.total as u64) as usize;
    campaign.stats.pending = campaign
        .stats
        .total
        .saturating_sub(campaign.stats.sent + campaign.stats.failed);
    campaign.updated_at = now_local_string();
    save_campaign(state, &campaign).await?;
    Ok(ApiResponse::ok(json!({ "id": campaign.id })))
}

async fn load_campaign(state: &State<'_, AppState>, id: &str) -> AppResult<Option<Campaign>> {
    let path = state.paths.campaigns_dir.join(format!("{}.json", id));
    match storage::read_json::<Campaign>(&path).await {
        Ok(campaign) => Ok(Some(campaign)),
        Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

async fn save_campaign(state: &State<'_, AppState>, campaign: &Campaign) -> AppResult<()> {
    let path = state
        .paths
        .campaigns_dir
        .join(format!("{}.json", campaign.id));
    storage::write_json_pretty(&path, campaign).await
}

async fn load_campaign_logs(state: &State<'_, AppState>, id: &str) -> AppResult<Vec<Value>> {
    let path = state.paths.campaigns_dir.join(format!("{}.log.jsonl", id));
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok(content
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .map(|value| {
                if let Some(message) = value.get("message").and_then(Value::as_str) {
                    Value::String(message.to_string())
                } else {
                    value
                }
            })
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

#[allow(dead_code)]
async fn append_campaign_log(
    state: &State<'_, AppState>,
    id: &str,
    level: &str,
    message: &str,
) -> AppResult<()> {
    storage::ensure_dir(&state.paths.campaigns_dir).await?;
    let path = state.paths.campaigns_dir.join(format!("{}.log.jsonl", id));
    let line = json!({
        "timestamp": crate::core::now_utc_rfc3339(),
        "level": level,
        "message": message
    });
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(serde_json::to_string(&line)?.as_bytes())
        .await?;
    file.write_all(b"\n").await?;
    file.flush().await?;
    Ok(())
}
