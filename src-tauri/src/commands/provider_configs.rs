use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::{AppPaths, AppState};
use crate::commands::legacy::LegacyAction;
use crate::core::api::ApiResponse;
use crate::core::error::{AppError, AppResult};
use crate::core::{now_local_string, prefixed_id};
use crate::security::secrets;
use crate::storage;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Value,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub encryption: String,
    #[serde(default)]
    pub access_key: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub sendgrid_region: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub mailgun_region: String,
    #[serde(default)]
    pub remote_snapshot: Option<Value>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

pub async fn smtp_configs(
    state: &State<'_, AppState>,
    method: &str,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    match method {
        "GET" => {
            let mut configs = list_configs_raw(state).await?;
            configs.iter_mut().for_each(mask_secrets_for_ui);
            Ok(ApiResponse::ok(json!(configs)))
        }
        "POST" => save_config(state, data).await,
        _ => Ok(ApiResponse::err("Unsupported smtp_configs method")),
    }
}

pub async fn smtp_config(
    state: &State<'_, AppState>,
    action: &LegacyAction,
    method: &str,
) -> AppResult<ApiResponse<Value>> {
    let id = action
        .get("id")
        .ok_or_else(|| AppError::Validation("Missing configuration ID".to_string()))?;
    match method {
        "GET" => {
            let mut cfg = load_config(&state.paths, id)
                .await?
                .ok_or_else(|| AppError::NotFound(id.to_string()))?;
            mask_secrets_for_ui(&mut cfg);
            Ok(ApiResponse::ok(json!(cfg)))
        }
        "DELETE" => {
            let path = state
                .paths
                .provider_configs_dir
                .join(format!("{}.json", id));
            storage::remove_file_if_exists(&path).await?;
            Ok(ApiResponse::<Value>::empty_ok())
        }
        _ => Ok(ApiResponse::err("Unsupported smtp_config method")),
    }
}

pub async fn test_smtp(state: &State<'_, AppState>, data: Value) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::err(
            "SMTP/API configuration not found or incomplete",
        ));
    };

    let provider = cfg.provider.to_ascii_lowercase();
    if let Err(message) = validate_provider_config(&cfg, true) {
        return Ok(ApiResponse::err(message));
    }

    let sg_region = if cfg.sendgrid_region.is_empty() {
        None
    } else {
        Some(cfg.sendgrid_region.as_str())
    };

    let result: AppResult<Value> = match provider.as_str() {
        "brevo" => crate::providers::brevo::ping(&cfg.api_key).await,
        "sendgrid" => crate::providers::sendgrid::ping(&cfg.api_key, sg_region).await,
        "ses" | "amazonses" => {
            crate::providers::ses::ping(&cfg.access_key, &cfg.secret_key, &cfg.region).await
        }
        "mailgun" => {
            crate::providers::mailgun::ping(&cfg.api_key, &cfg.domain, &cfg.mailgun_region).await
        }
        "mandrill" => crate::providers::mandrill::ping(&cfg.api_key).await,
        "postmark" => crate::providers::postmark::ping(&cfg.api_key).await,
        "smtp" | "office365" => crate::mailer::smtp::test_connection(&cfg).await,
        other => {
            return Ok(ApiResponse::err(format!(
                "Unsupported provider \"{other}\""
            )))
        }
    };

    match result {
        Ok(data) => Ok(ApiResponse::ok(data)),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

pub async fn verified_senders(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::ok(json!({ "senders": [] })));
    };

    let provider = cfg.provider.to_ascii_lowercase();
    let region_opt = if cfg.sendgrid_region.is_empty() {
        None
    } else {
        Some(cfg.sendgrid_region.as_str())
    };

    let senders = match provider.as_str() {
        "brevo" => crate::providers::brevo::verified_senders(&cfg.api_key)
            .await
            .unwrap_or_default(),
        "sendgrid" => crate::providers::sendgrid::verified_senders(&cfg.api_key, region_opt)
            .await
            .unwrap_or_default(),
        "ses" | "amazonses" => {
            crate::providers::ses::verified_senders(&cfg.access_key, &cfg.secret_key, &cfg.region)
                .await
                .unwrap_or_default()
        }
        "mailgun" => crate::providers::mailgun::verified_senders(
            &cfg.api_key,
            &cfg.domain,
            &cfg.mailgun_region,
        )
        .await
        .unwrap_or_default(),
        "mandrill" => crate::providers::mandrill::verified_senders(&cfg.api_key)
            .await
            .unwrap_or_default(),
        "postmark" => crate::providers::postmark::verified_senders(&cfg.api_key)
            .await
            .unwrap_or_default(),
        "smtp" | "office365" if !cfg.username.trim().is_empty() => {
            // The SMTP username is the default sender. Leave the display name
            // empty (the config name is not an email display name) so the
            // test email isn't sent as "My Config <user@host>".
            vec![json!({
                "email": cfg.username.trim(),
                "name": "",
                "label": cfg.username.trim()
            })]
        }
        _ => Vec::new(),
    };

    Ok(ApiResponse::ok(json!({
        "provider": provider,
        "senders": senders
    })))
}

pub async fn provider_inspect(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::err("Configuration not found"));
    };
    let provider = cfg.provider.to_ascii_lowercase();
    let region_opt = if cfg.sendgrid_region.is_empty() {
        None
    } else {
        Some(cfg.sendgrid_region.as_str())
    };

    let inspect_data = match provider.as_str() {
        "brevo" => crate::providers::brevo::inspect(&cfg.api_key).await,
        "sendgrid" => crate::providers::sendgrid::inspect(&cfg.api_key, region_opt).await,
        "ses" | "amazonses" => {
            crate::providers::ses::inspect(&cfg.access_key, &cfg.secret_key, &cfg.region).await
        }
        "mailgun" => {
            crate::providers::mailgun::inspect(&cfg.api_key, &cfg.domain, &cfg.mailgun_region).await
        }
        "mandrill" => crate::providers::mandrill::inspect(&cfg.api_key).await,
        "postmark" => crate::providers::postmark::inspect(&cfg.api_key).await,
        "smtp" | "office365" => crate::mailer::smtp::test_connection(&cfg).await,
        other => {
            return Ok(ApiResponse::err(format!(
                "Introspection not available for provider \"{other}\""
            )))
        }
    };

    match inspect_data {
        Ok(data) => Ok(ApiResponse::ok(json!({
            "fetched_at": crate::core::now_utc_rfc3339(),
            "inspect": data,
            "remote_snapshot": build_remote_snapshot(&provider)
        }))),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

fn build_remote_snapshot(provider: &str) -> Value {
    json!({
        "provider": provider,
        "fetched_at": crate::core::now_utc_rfc3339(),
        "quotas": { "lines": [] },
        "dns_badges": { "spf": "unknown", "dkim": "unknown", "dmarc": "unknown" }
    })
}

pub async fn ses_inspect(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::err("SES configuration not found"));
    };
    if !matches!(cfg.provider.as_str(), "ses" | "amazonses") {
        return Ok(ApiResponse::err("This endpoint is reserved for Amazon SES"));
    }

    let probe_all = data
        .get("probe_all_regions")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let result = if probe_all {
        let preferred = data
            .get("preferred_region")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        crate::providers::ses::inspect_all_regions(&cfg.access_key, &cfg.secret_key, preferred)
            .await
    } else {
        crate::providers::ses::inspect(&cfg.access_key, &cfg.secret_key, &cfg.region).await
    };

    match result {
        Ok(data) => Ok(ApiResponse::ok(data)),
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

pub async fn sendgrid_activity(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::err("SendGrid configuration not found"));
    };
    if cfg.provider != "sendgrid" {
        return Ok(ApiResponse::err("This endpoint is reserved for SendGrid"));
    }

    let limit = data.get("limit").and_then(Value::as_u64).unwrap_or(25) as u32;
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let to_email = data
        .get("to_email")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let region = if cfg.sendgrid_region.is_empty() {
        None
    } else {
        Some(cfg.sendgrid_region.as_str())
    };

    match crate::providers::sendgrid::activity(&cfg.api_key, region, limit, status, to_email).await
    {
        Ok(mut data) => {
            if let Value::Object(ref mut map) = data {
                map.insert(
                    "fetched_at".to_string(),
                    Value::String(crate::core::now_utc_rfc3339()),
                );
            }
            Ok(ApiResponse::ok(data))
        }
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

pub async fn send_test_email(
    state: &State<'_, AppState>,
    data: Value,
) -> AppResult<ApiResponse<Value>> {
    let cfg = resolve_config_for_action(state, &data).await?;
    let Some(cfg) = cfg else {
        return Ok(ApiResponse::err("SMTP/API configuration not found"));
    };

    let to = data
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if to.is_empty() {
        return Ok(ApiResponse::err("Recipient required"));
    }
    let from_email = data
        .get("from_email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if from_email.is_empty() {
        return Ok(ApiResponse::err("From address required"));
    }
    let from_name = data
        .get("from_name")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (subject, html, text) = if let Some(tpl_id) = data
        .get("template_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let template = crate::commands::templates::load_template_raw(&state.paths, tpl_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("template {tpl_id}")))?;
        let mut sample: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        sample.insert("email".to_string(), to.clone());
        sample.insert("prenom".to_string(), "Test".to_string());
        sample.insert("nom".to_string(), "User".to_string());
        let s = crate::template::renderer::personalize_string(
            &template.subject,
            &sample,
            Some(&template),
            0,
        );
        let h = crate::template::renderer::personalize_string(
            &template.html,
            &sample,
            Some(&template),
            0,
        );
        let t = crate::template::renderer::personalize_string(
            &template.text,
            &sample,
            Some(&template),
            0,
        );
        (
            s,
            if h.trim().is_empty() { None } else { Some(h) },
            if t.trim().is_empty() { None } else { Some(t) },
        )
    } else {
        let subject = data
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or("Test WinMail")
            .to_string();
        let text = data
            .get("body")
            .and_then(Value::as_str)
            .map(String::from)
            .filter(|s| !s.trim().is_empty());
        let html = data
            .get("body_html")
            .and_then(Value::as_str)
            .map(String::from)
            .filter(|s| !s.trim().is_empty());
        (subject, html, text)
    };

    let message = crate::mailer::message::EmailMessage {
        from_email,
        from_name,
        to_email: to.clone(),
        to_name: None,
        reply_to: None,
        subject,
        html,
        text,
        unsubscribe_url: None,
        headers: Vec::new(),
    };

    match crate::mailer::send_email(&cfg, &message).await {
        Ok(result) => {
            let provider_status = result
                .raw
                .as_ref()
                .and_then(|raw| raw.get("status"))
                .and_then(Value::as_u64);
            let is_sendgrid = result.provider.eq_ignore_ascii_case("sendgrid");
            let delivery_status = if is_sendgrid && provider_status == Some(202) {
                "accepted"
            } else {
                "sent"
            };
            let message = if delivery_status == "accepted" {
                format!("Email accepted by SendGrid for {to} (queued; not proof of delivery)")
            } else {
                format!("Email sent to {to}")
            };
            Ok(ApiResponse::ok(json!({
                "provider": result.provider,
                "provider_status": provider_status,
                "delivery_status": delivery_status,
                "message_id": result.message_id,
                "message": message,
                "raw": result.raw,
            })))
        }
        Err(e) => Ok(ApiResponse::err(e.to_string())),
    }
}

async fn save_config(state: &State<'_, AppState>, data: Value) -> AppResult<ApiResponse<Value>> {
    let mut incoming: ProviderConfig = serde_json::from_value(data)?;
    if incoming.name.trim().is_empty() {
        return Ok(ApiResponse::err("Configuration name is required"));
    }
    if incoming.provider.trim().is_empty() {
        incoming.provider = "smtp".to_string();
    }

    let is_new = incoming.id.trim().is_empty();
    if is_new {
        incoming.id = prefixed_id("smtp");
        incoming.created_at = now_local_string();
    } else if let Some(existing) = load_config(&state.paths, &incoming.id).await? {
        incoming.created_at = existing.created_at;
        preserve_secret_if_masked(&mut incoming.api_key, &existing.api_key);
        preserve_secret_if_masked(&mut incoming.password, &existing.password);
        preserve_secret_if_masked(&mut incoming.secret_key, &existing.secret_key);
        preserve_secret_if_masked(&mut incoming.access_key, &existing.access_key);
        if incoming.region.trim().is_empty() {
            incoming.region = existing.region;
        }
        if incoming.sendgrid_region.trim().is_empty() {
            incoming.sendgrid_region = existing.sendgrid_region;
        }
    }

    normalize_provider_defaults(&mut incoming);
    if contains_masked_secret(&incoming) {
        return Ok(ApiResponse::err(
            "Masked secret received. Paste the real API key/password before saving.".to_string(),
        ));
    }
    if let Err(message) = validate_provider_config(&incoming, false) {
        return Ok(ApiResponse::err(message));
    }

    // Encrypt secrets before writing to disk. Idempotent: values already
    // encrypted (preserve_secret_if_masked case) remain as-is.
    incoming.api_key = secrets::encrypt(&incoming.api_key)?;
    incoming.password = secrets::encrypt(&incoming.password)?;
    incoming.secret_key = secrets::encrypt(&incoming.secret_key)?;
    // access_key (AKIA...) stays in plaintext: on its own it cannot send.

    incoming.updated_at = now_local_string();
    let id = incoming.id.clone();
    let path = state
        .paths
        .provider_configs_dir
        .join(format!("{}.json", id));
    storage::write_json_pretty(&path, &incoming).await?;
    Ok(ApiResponse::ok(json!({ "id": id })))
}

pub async fn load_config(paths: &AppPaths, id: &str) -> AppResult<Option<ProviderConfig>> {
    let path = paths.provider_configs_dir.join(format!("{}.json", id));
    match storage::read_json::<ProviderConfig>(&path).await {
        Ok(c) => Ok(Some(c)),
        Err(AppError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Decrypts `api_key`, `password`, `secret_key` in place.
pub fn decrypt_in_place(cfg: &mut ProviderConfig) -> AppResult<()> {
    decrypt_secrets_in_place(cfg)
}

async fn list_configs_raw(state: &State<'_, AppState>) -> AppResult<Vec<ProviderConfig>> {
    let mut configs =
        storage::read_json_files::<ProviderConfig>(&state.paths.provider_configs_dir, |_| false)
            .await?;
    configs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(configs)
}

async fn resolve_config_for_action(
    state: &State<'_, AppState>,
    data: &Value,
) -> AppResult<Option<ProviderConfig>> {
    if let Some(id) = data.get("smtp_config_id").and_then(Value::as_str) {
        let mut cfg = load_config(&state.paths, id).await?;
        if let Some(ref mut c) = cfg {
            decrypt_secrets_in_place(c)?;
        }
        return Ok(cfg);
    }
    if data.get("provider").is_some() || data.get("host").is_some() || data.get("api_key").is_some()
    {
        let mut cfg: ProviderConfig = serde_json::from_value(data.clone())?;
        normalize_provider_defaults(&mut cfg);
        return Ok(Some(cfg));
    }
    Ok(None)
}

fn decrypt_secrets_in_place(cfg: &mut ProviderConfig) -> AppResult<()> {
    if secrets::is_encrypted(&cfg.api_key) {
        cfg.api_key = secrets::decrypt(&cfg.api_key)?;
    }
    if secrets::is_encrypted(&cfg.password) {
        cfg.password = secrets::decrypt(&cfg.password)?;
    }
    if secrets::is_encrypted(&cfg.secret_key) {
        cfg.secret_key = secrets::decrypt(&cfg.secret_key)?;
    }
    Ok(())
}

fn normalize_provider_defaults(config: &mut ProviderConfig) {
    config.provider = config.provider.trim().to_ascii_lowercase();
    if config.provider == "amazonses" {
        config.provider = "ses".to_string();
    }
    if config.name.trim().is_empty() {
        config.name = format!("{} {}", config.provider.to_uppercase(), now_local_string());
    }
    if config.provider == "office365" {
        if config.host.trim().is_empty() {
            config.host = "smtp.office365.com".to_string();
        }
        if is_empty_json_number_or_string(&config.port) {
            config.port = json!(587);
        }
        if config.encryption.trim().is_empty() {
            config.encryption = "tls".to_string();
        }
    }
    if config.provider == "ses" && config.region.trim().is_empty() {
        config.region = "eu-west-3".to_string();
    }
    if config.provider == "mailgun" && config.mailgun_region.trim().is_empty() {
        config.mailgun_region = "us".to_string();
    }
}

fn validate_provider_config(
    config: &ProviderConfig,
    allow_missing_secret_on_saved: bool,
) -> Result<(), String> {
    match config.provider.as_str() {
        "smtp" | "office365" => {
            if config.host.trim().is_empty() {
                return Err("SMTP host required".to_string());
            }
            if is_empty_json_number_or_string(&config.port) {
                return Err("SMTP port required".to_string());
            }
            if config.username.trim().is_empty() {
                return Err("SMTP username required".to_string());
            }
            if !allow_missing_secret_on_saved && config.password.trim().is_empty() {
                return Err("SMTP password required".to_string());
            }
        }
        "ses" => {
            if config.access_key.trim().is_empty() {
                return Err("Amazon SES: Access Key ID required".to_string());
            }
            if !allow_missing_secret_on_saved && config.secret_key.trim().is_empty() {
                return Err("Amazon SES: Secret Access Key required".to_string());
            }
        }
        "mailgun" => {
            if !allow_missing_secret_on_saved && config.api_key.trim().is_empty() {
                return Err("Mailgun: API key required".to_string());
            }
            if config.domain.trim().is_empty() {
                return Err("Mailgun: sending domain required (e.g. mg.example.com)".to_string());
            }
        }
        "brevo" | "sendgrid" | "mandrill" | "postmark" => {
            if !allow_missing_secret_on_saved && config.api_key.trim().is_empty() {
                return Err("API key required".to_string());
            }
        }
        other => return Err(format!("Unsupported provider: {other}")),
    }
    Ok(())
}

/// Masks real outgoing secrets sent to the UI. The AWS access key (AKIA...)
/// stays in plaintext because it is useless without the associated secret key.
fn mask_secrets_for_ui(config: &mut ProviderConfig) {
    if !config.api_key.trim().is_empty() {
        config.api_key = "***".to_string();
    }
    if !config.password.trim().is_empty() {
        config.password = "***".to_string();
    }
    if !config.secret_key.trim().is_empty() {
        config.secret_key = "***".to_string();
    }
}

fn preserve_secret_if_masked(incoming: &mut String, existing: &str) {
    let v = incoming.trim();
    if v.is_empty() || is_masked_secret(v) {
        *incoming = existing.to_string();
    }
}

fn contains_masked_secret(config: &ProviderConfig) -> bool {
    is_masked_secret(&config.api_key)
        || is_masked_secret(&config.password)
        || is_masked_secret(&config.secret_key)
}

fn is_masked_secret(value: &str) -> bool {
    let v = value.trim();
    !v.is_empty() && v.chars().all(|c| matches!(c, '*' | '•' | '●'))
}

fn is_empty_json_number_or_string(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty() || s.trim() == "0",
        Value::Number(n) => n.as_u64().unwrap_or(0) == 0,
        _ => false,
    }
}
