pub mod legacy;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::app_state::AppState;
use crate::core::api::ApiResponse;
use crate::core::error::AppError;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyApiRequest {
    pub action: String,
    pub method: String,
    pub data: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub status: String,
    pub backend: String,
    pub responsive: bool,
    pub data_dir: String,
}

#[tauri::command]
pub async fn health_check(state: State<'_, AppState>) -> Result<HealthCheck, AppError> {
    Ok(HealthCheck {
        status: "ok".to_string(),
        backend: "rust-tauri".to_string(),
        responsive: true,
        data_dir: state.paths.data_dir.display().to_string(),
    })
}

#[tauri::command]
pub async fn legacy_api(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    request: LegacyApiRequest,
) -> Result<ApiResponse<Value>, AppError> {
    let action = legacy::LegacyAction::parse(&request.action);
    let method = request.method.to_uppercase();
    let data = request.data.unwrap_or(Value::Null);

    let response = match action.name.as_str() {
        "dashboard" => crate::commands::dashboard::dashboard_get(&state).await?,
        "templates" => match method.as_str() {
            "GET" => crate::commands::templates::templates_list(&state).await?,
            "POST" => crate::commands::templates::template_save(&state, data).await?,
            _ => ApiResponse::err("Unsupported method for templates"),
        },
        "template" => match method.as_str() {
            "GET" => crate::commands::templates::template_get(&state, &action).await?,
            "DELETE" => crate::commands::templates::template_delete(&state, &action).await?,
            _ => ApiResponse::err("Unsupported method for template"),
        },
        "template_folders" => match method.as_str() {
            "GET" => crate::commands::templates::template_folders_list(&state).await?,
            "POST" => crate::commands::templates::template_folder_save(&state, data).await?,
            _ => ApiResponse::err("Unsupported method for template_folders"),
        },
        "template_folder" => match method.as_str() {
            "DELETE" => crate::commands::templates::template_folder_delete(&state, &action).await?,
            _ => ApiResponse::err("Unsupported method for template_folder"),
        },
        "template_move" => crate::commands::templates::template_move(&state, data).await?,
        "template_folder_move" => {
            crate::commands::templates::template_folder_move(&state, data).await?
        }
        "template_preview_merge" => {
            crate::commands::templates::template_preview_merge(&state, data).await?
        }
        "parse_recipients" => crate::commands::recipients::parse_recipients(data).await?,
        "score" => crate::commands::scoring::score(&state, data).await?,
        "dns_check" => crate::commands::dns::dns_check(data).await?,
        "campaigns" => {
            crate::commands::campaigns::campaigns_list_or_create(&state, &method, data).await?
        }
        "campaign" => {
            crate::commands::campaigns::campaign_get_update_delete(&state, &action, &method, data)
                .await?
        }
        "campaign_logs" => crate::commands::campaigns::campaign_logs(&state, &action).await?,
        "send" | "pause" | "resume" | "stop" | "retry_failed" => {
            crate::commands::campaigns::campaign_control(
                &state,
                app_handle.clone(),
                &action.name,
                data,
            )
            .await?
        }
        "smtp_configs" => {
            crate::commands::provider_configs::smtp_configs(&state, &method, data).await?
        }
        "smtp_config" => {
            crate::commands::provider_configs::smtp_config(&state, &action, &method).await?
        }
        "test_smtp" => crate::commands::provider_configs::test_smtp(&state, data).await?,
        "verified_senders" => {
            crate::commands::provider_configs::verified_senders(&state, data).await?
        }
        "provider_inspect" => {
            crate::commands::provider_configs::provider_inspect(&state, data).await?
        }
        "ses_inspect" => crate::commands::provider_configs::ses_inspect(&state, data).await?,
        "sendgrid_activity" => {
            crate::commands::provider_configs::sendgrid_activity(&state, data).await?
        }
        "send_test_email" => {
            crate::commands::provider_configs::send_test_email(&state, data).await?
        }
        other => ApiResponse::err(format!("Action not yet ported to Rust: {other}")),
    };

    Ok(response)
}

pub mod campaigns;
pub mod dashboard;
pub mod dns;
pub mod provider_configs;
pub mod recipients;
pub mod scoring;
pub mod templates;
pub mod update;
