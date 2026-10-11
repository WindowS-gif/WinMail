use serde_json::{json, Value};
use tauri::State;

use crate::app_state::AppState;
use crate::core::api::ApiResponse;
use crate::core::error::AppResult;

pub async fn dashboard_get(state: &State<'_, AppState>) -> AppResult<ApiResponse<Value>> {
    let campaigns = crate::commands::campaigns::list_campaigns_raw(state).await?;
    let templates = crate::commands::templates::list_templates_raw(state).await?;
    Ok(ApiResponse::ok(json!({
        "campaigns": campaigns,
        "templates": templates
    })))
}
