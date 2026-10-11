use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::{json_response, HTTP_CLIENT};

pub async fn send_email(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    let api_key = cfg.api_key.trim();
    let domain = cfg.domain.trim();
    let region = cfg.mailgun_region.trim();
    validate(api_key, domain)?;
    let base = base_url(region);

    let mut form: Vec<(String, String)> = Vec::new();
    form.push(("from".into(), message.formatted_from()));
    form.push(("to".into(), message.formatted_to()));
    form.push(("subject".into(), message.subject.clone()));
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        form.push(("text".into(), text.to_string()));
    }
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        form.push(("html".into(), html.to_string()));
    }
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        form.push(("h:Reply-To".into(), reply_to.to_string()));
    }
    for (k, v) in message
        .unsubscribe_headers()
        .into_iter()
        .chain(message.headers.iter().cloned())
    {
        form.push((format!("h:{k}"), v));
    }

    let response = client
        .post(format!("{base}/v3/{domain}/messages"))
        .basic_auth("api", Some(api_key))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Security(format!("Mailgun network: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Security(format!("Mailgun body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::Security(format!(
            "Mailgun HTTP {}: {}",
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        )));
    }
    let raw: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let message_id = raw
        .get("id")
        .and_then(Value::as_str)
        .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());
    Ok(SendResult {
        provider: "mailgun".into(),
        message_id,
        raw: Some(raw),
    })
}

pub(crate) fn base_url(region: &str) -> &'static str {
    match region.trim().to_ascii_lowercase().as_str() {
        "eu" => "https://api.eu.mailgun.net",
        _ => "https://api.mailgun.net",
    }
}

fn validate(api_key: &str, domain: &str) -> AppResult<()> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("Mailgun API key required".into()));
    }
    if domain.trim().is_empty() {
        return Err(AppError::Validation(
            "Mailgun sending domain required (e.g. mg.example.com)".into(),
        ));
    }
    Ok(())
}

pub async fn ping(api_key: &str, domain: &str, region: &str) -> AppResult<Value> {
    validate(api_key, domain)?;
    let base = base_url(region);
    let info = json_response(
        HTTP_CLIENT
            .get(format!("{base}/v3/domains/{domain}"))
            .basic_auth("api", Some(api_key)),
    )
    .await?;
    Ok(json!({
        "provider": "mailgun",
        "region": region,
        "domain": domain,
        "domain_info": info
    }))
}

pub async fn inspect(api_key: &str, domain: &str, region: &str) -> AppResult<Value> {
    validate(api_key, domain)?;
    let base = base_url(region);

    let domain_info = json_response(
        HTTP_CLIENT
            .get(format!("{base}/v3/domains/{domain}"))
            .basic_auth("api", Some(api_key)),
    )
    .await?;

    let all_domains = json_response(
        HTTP_CLIENT
            .get(format!("{base}/v4/domains"))
            .basic_auth("api", Some(api_key)),
    )
    .await
    .unwrap_or(Value::Null);

    let stats = json_response(
        HTTP_CLIENT
            .get(format!("{base}/v3/{domain}/stats/total"))
            .basic_auth("api", Some(api_key))
            .query(&[
                ("event", "delivered"),
                ("event", "failed"),
                ("duration", "1d"),
            ]),
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "provider": "mailgun",
        "region": region,
        "domain": domain,
        "domain_info": domain_info,
        "all_domains": all_domains,
        "stats_24h": stats,
    }))
}

pub async fn verified_senders(api_key: &str, domain: &str, region: &str) -> AppResult<Vec<Value>> {
    validate(api_key, domain)?;
    let base = base_url(region);
    let info = json_response(
        HTTP_CLIENT
            .get(format!("{base}/v3/domains/{domain}"))
            .basic_auth("api", Some(api_key)),
    )
    .await?;

    Ok(parse_verified_senders(&info, domain))
}

pub(crate) fn parse_verified_senders(info: &Value, domain: &str) -> Vec<Value> {
    let state = info
        .get("domain")
        .and_then(|d| d.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if state != "active" {
        return Vec::new();
    }
    vec![json!({
        "email": format!("noreply@{domain}"),
        "name": "",
        "domain": domain,
        "label": format!("@{domain} (verified domain — any address)"),
        "hint": "Mailgun allows any address on a verified domain."
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_us_default() {
        assert_eq!(base_url(""), "https://api.mailgun.net");
        assert_eq!(base_url("us"), "https://api.mailgun.net");
        assert_eq!(base_url("US"), "https://api.mailgun.net");
        assert_eq!(base_url("unknown"), "https://api.mailgun.net");
    }

    #[test]
    fn base_url_eu() {
        assert_eq!(base_url("eu"), "https://api.eu.mailgun.net");
        assert_eq!(base_url("EU"), "https://api.eu.mailgun.net");
        assert_eq!(base_url(" eu "), "https://api.eu.mailgun.net");
    }

    #[test]
    fn validate_rejects_missing_fields() {
        assert!(validate("", "example.com").is_err());
        assert!(validate("key", "").is_err());
        assert!(validate("key", "example.com").is_ok());
    }

    #[test]
    fn parse_verified_senders_active() {
        let response = serde_json::json!({
            "domain": {
                "name": "mg.example.com",
                "state": "active"
            }
        });
        let senders = parse_verified_senders(&response, "mg.example.com");
        assert_eq!(senders.len(), 1);
        assert_eq!(senders[0]["email"], "noreply@mg.example.com");
        assert_eq!(senders[0]["domain"], "mg.example.com");
    }

    #[test]
    fn parse_verified_senders_unverified() {
        let response = serde_json::json!({
            "domain": {
                "name": "mg.example.com",
                "state": "unverified"
            }
        });
        assert!(parse_verified_senders(&response, "mg.example.com").is_empty());
    }
}
