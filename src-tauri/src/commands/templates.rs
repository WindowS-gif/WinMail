use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::{AppPaths, AppState};
use crate::commands::legacy::LegacyAction;
use crate::core::api::ApiResponse;
use crate::core::error::{AppError, AppResult};
use crate::core::{now_local_string, prefixed_id};
use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Template {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub subject: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub rotate_urls: Vec<String>,
    #[serde(default = "default_rotate_every")]
    pub rotate_url_every: usize,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TemplateFolder {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
struct MoveTemplatePayload {
    template_id: String,
    folder_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MoveFolderPayload {
    folder_id: String,
    parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PreviewMergePayload {
    #[serde(default)]
    template_id: Option<String>,
    #[serde(default)]
    template: Option<Template>,
    #[serde(default)]
    recipient: Option<std::collections::HashMap<String, String>>,
}

fn default_rotate_every() -> usize {
    1
}

pub async fn templates_list(state: &State<'_, AppState>) -> AppResult<ApiResponse<Value>> {
    let mut templates = list_templates_raw(state).await?;
    templates.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(ApiResponse::ok(json!(templates)))
}

pub async fn template_get(
    state: &State<'_, AppState>,
    action: &LegacyAction,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing template id".to_string()))?;
    let template = load_template(state, id)
        .await?
        .ok_or_else(|| AppError::NotFound(id.to_string()))?;
    Ok(ApiResponse::ok(json!(template)))
}

pub async fn template_save(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let mut template: Template = serde_json::from_value(data)?;
    if template.name.trim().is_empty() {
        return Ok(ApiResponse::err("Template name is required"));
    }
    if template.subject.trim().is_empty() {
        return Ok(ApiResponse::err("Template subject is required"));
    }

    let is_new = template.id.trim().is_empty();
    if is_new {
        template.id = prefixed_id("template");
        template.created_at = now_local_string();
    } else if let Some(existing) = load_template(state, &template.id).await? {
        if template.created_at.trim().is_empty() {
            template.created_at = existing.created_at;
        }
        if template.folder_id.is_none() {
            template.folder_id = existing.folder_id;
        }
    }
    template.updated_at = now_local_string();
    template.rotate_url_every = template.rotate_url_every.max(1);

    let path = state
        .paths
        .templates_dir
        .join(format!("{}.json", template.id));
    storage::write_json_pretty(&path, &template).await?;
    Ok(ApiResponse::ok(json!({ "id": template.id })))
}

pub async fn template_delete(
    state: &State<'_, AppState>,
    action: &LegacyAction,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing template id".to_string()))?;
    let path = state.paths.templates_dir.join(format!("{}.json", id));
    storage::remove_file_if_exists(&path).await?;
    Ok(ApiResponse::<Value>::empty_ok())
}

pub async fn template_folders_list(state: &State<'_, AppState>) -> AppResult<ApiResponse<Value>> {
    let folders = load_folders(state).await?;
    Ok(ApiResponse::ok(json!(folders)))
}

pub async fn template_folder_save(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let mut incoming: TemplateFolder = serde_json::from_value(data)?;
    if incoming.name.trim().is_empty() {
        return Ok(ApiResponse::err("Folder name is required"));
    }

    let mut folders = load_folders(state).await?;
    let now = now_local_string();
    if incoming.id.trim().is_empty() {
        incoming.id = prefixed_id("folder");
        incoming.created_at = now.clone();
        incoming.updated_at = now;
        if incoming.color.trim().is_empty() {
            incoming.color = "violet".to_string();
        }
        folders.push(incoming.clone());
    } else if let Some(existing) = folders.iter_mut().find(|f| f.id == incoming.id) {
        existing.name = incoming.name.clone();
        existing.color = if incoming.color.trim().is_empty() {
            existing.color.clone()
        } else {
            incoming.color.clone()
        };
        existing.parent_id = incoming.parent_id.clone();
        existing.updated_at = now;
    } else {
        incoming.created_at = now.clone();
        incoming.updated_at = now;
        folders.push(incoming.clone());
    }

    save_folders(state, &folders).await?;
    Ok(ApiResponse::ok(json!({ "id": incoming.id })))
}

pub async fn template_folder_delete(
    state: &State<'_, AppState>,
    action: &LegacyAction,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing folder id".to_string()))?;
    let folders = load_folders(state).await?;

    // Iteratively collect all descendant folder IDs
    let mut ids_to_delete: Vec<String> = vec![id.to_string()];
    let mut i = 0;
    while i < ids_to_delete.len() {
        let current = ids_to_delete[i].clone();
        for f in &folders {
            if f.parent_id.as_deref() == Some(current.as_str()) && !ids_to_delete.contains(&f.id) {
                ids_to_delete.push(f.id.clone());
            }
        }
        i += 1;
    }

    let mut folders = folders;
    folders.retain(|f| !ids_to_delete.contains(&f.id));
    save_folders(state, &folders).await?;

    let templates = list_templates_raw(state).await?;
    for mut template in templates {
        let in_deleted = template
            .folder_id
            .as_deref()
            .map_or(false, |fid| ids_to_delete.iter().any(|d| d == fid));
        if in_deleted {
            template.folder_id = None;
            template.updated_at = now_local_string();
            let path = state
                .paths
                .templates_dir
                .join(format!("{}.json", template.id));
            storage::write_json_pretty(&path, &template).await?;
        }
    }

    Ok(ApiResponse::<Value>::empty_ok())
}

pub async fn template_move(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let payload: MoveTemplatePayload = serde_json::from_value(data)?;
    let mut template = load_template(state, &payload.template_id)
        .await?
        .ok_or_else(|| AppError::NotFound(payload.template_id.clone()))?;
    template.folder_id = payload.folder_id;
    template.updated_at = now_local_string();
    let path = state
        .paths
        .templates_dir
        .join(format!("{}.json", template.id));
    storage::write_json_pretty(&path, &template).await?;
    Ok(ApiResponse::<Value>::empty_ok())
}

pub async fn template_folder_move(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let payload: MoveFolderPayload = serde_json::from_value(data)?;
    let mut folders = load_folders(state).await?;
    if let Some(folder) = folders.iter_mut().find(|f| f.id == payload.folder_id) {
        folder.parent_id = payload.parent_id.filter(|p| p != &payload.folder_id);
        folder.updated_at = now_local_string();
    }
    save_folders(state, &folders).await?;
    Ok(ApiResponse::<Value>::empty_ok())
}

pub async fn template_preview_merge(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let payload: PreviewMergePayload = serde_json::from_value(data)?;
    let template = if let Some(t) = payload.template {
        t
    } else if let Some(id) = payload.template_id {
        load_template(state, &id)
            .await?
            .ok_or_else(|| AppError::NotFound(id.clone()))?
    } else {
        return Ok(ApiResponse::err("No template to preview"));
    };

    let recipient = payload.recipient.unwrap_or_else(|| {
        std::collections::HashMap::from([
            ("email".to_string(), "demo@example.com".to_string()),
            ("first_name".to_string(), "Alex".to_string()),
            ("prenom".to_string(), "Alex".to_string()),
            ("name".to_string(), "Alex Martin".to_string()),
        ])
    });

    let html = crate::template::renderer::personalize_string(
        &template.html,
        &recipient,
        Some(&template),
        0,
    );
    let text = crate::template::renderer::personalize_string(
        &template.text,
        &recipient,
        Some(&template),
        0,
    );
    let subject = crate::template::renderer::personalize_string(
        &template.subject,
        &recipient,
        Some(&template),
        0,
    );

    Ok(ApiResponse::ok(json!({
        "subject": subject,
        "html": html,
        "text": text
    })))
}

pub async fn load_template(state: &State<'_, AppState>, id: &str) -> AppResult<Option<Template>> {
    load_template_raw(&state.paths, id).await
}

pub async fn load_template_raw(paths: &AppPaths, id: &str) -> AppResult<Option<Template>> {
    let path = paths.templates_dir.join(format!("{}.json", id));
    match storage::read_json::<Template>(&path).await {
        Ok(t) => Ok(Some(t)),
        Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub async fn list_templates_raw(state: &State<'_, AppState>) -> AppResult<Vec<Template>> {
    storage::read_json_files::<Template>(&state.paths.templates_dir, |path| {
        path.file_name().and_then(|s| s.to_str()) == Some("folders.json")
    })
    .await
}

async fn load_folders(state: &State<'_, AppState>) -> AppResult<Vec<TemplateFolder>> {
    let path = state.paths.templates_dir.join("folders.json");
    match storage::read_json::<Vec<TemplateFolder>>(&path).await {
        Ok(folders) => Ok(folders),
        Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

async fn save_folders(state: &State<'_, AppState>, folders: &[TemplateFolder]) -> AppResult<()> {
    let path = state.paths.templates_dir.join("folders.json");
    storage::write_json_pretty(&path, &folders).await
}
