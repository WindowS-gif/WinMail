use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::{json_response, HTTP_CLIENT};

const BREVO_API: &str = "https://api.brevo.com";

pub async fn send_email(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Validation("Brevo API key required".into()));
    }
    let mut payload = json!({
        "sender": {
            "email": message.from_email,
            "name": message.from_name.as_deref().unwrap_or("")
        },
        "to": [{
            "email": message.to_email,
            "name": message.to_name.as_deref().unwrap_or("")
        }],
        "subject": message.subject,
    });
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["htmlContent"] = Value::String(html.to_string());
    }
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["textContent"] = Value::String(text.to_string());
    }
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["replyTo"] = json!({ "email": reply_to });
    }
    let mut headers_obj = serde_json::Map::new();
    for (k, v) in message
        .unsubscribe_headers()
        .into_iter()
        .chain(message.headers.iter().cloned())
    {
        headers_obj.insert(k, Value::String(v));
    }
    if !headers_obj.is_empty() {
        payload["headers"] = Value::Object(headers_obj);
    }

    let response = json_response(
        client
            .post(format!("{BREVO_API}/v3/smtp/email"))
            .header("api-key", api_key)
            .header("accept", "application/json")
            .json(&payload),
    )
    .await?;

    let message_id = response
        .get("messageId")
        .and_then(Value::as_str)
        .map(String::from);
    Ok(SendResult {
        provider: "brevo".into(),
        message_id,
        raw: Some(response),
    })
}

pub async fn ping(api_key: &str) -> AppResult<Value> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("Brevo API key required".into()));
    }
    let account = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/account"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await?;
    Ok(json!({ "provider": "brevo", "account": account }))
}

pub async fn inspect(api_key: &str) -> AppResult<Value> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("Brevo API key required".into()));
    }

    let account = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/account"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await?;

    let senders = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/senders"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await
    .unwrap_or(Value::Null);

    let domains = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/senders/domains"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "provider": "brevo",
        "account": account,
        "senders": senders,
        "domains": domains,
    }))
}

pub async fn verified_senders(api_key: &str) -> AppResult<Vec<Value>> {
    let response = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/senders"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await?;

    let mut out = Vec::new();
    if let Some(arr) = response.get("senders").and_then(Value::as_array) {
        for sender in arr {
            let active = sender
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if !active {
                continue;
            }
            let email = sender
                .get("email")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if email.is_empty() {
                continue;
            }
            let name = sender
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let label = if name.is_empty() {
                email.clone()
            } else {
                format!("{name} <{email}>")
            };
            out.push(json!({
                "email": email,
                "name": name,
                "label": label,
            }));
        }
    }

    // Also pull verified domains so the user can type any address on them.
    if let Ok(domains_resp) = json_response(
        HTTP_CLIENT
            .get(format!("{BREVO_API}/v3/senders/domains"))
            .header("api-key", api_key)
            .header("accept", "application/json"),
    )
    .await
    {
        let items = domains_resp
            .get("domains")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for domain_item in items {
            let domain = domain_item
                .get("domain")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if domain.is_empty() {
                continue;
            }
            let verified = domain_item
                .get("verified")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            out.push(json!({
                "email": format!("noreply@{domain}"),
                "name": "",
                "domain": domain,
                "verified": verified,
                "label": format!("@{domain} (verified domain — any address)"),
            }));
        }
    }
    Ok(out)
}
