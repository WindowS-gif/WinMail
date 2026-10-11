use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::{json_response, HTTP_CLIENT};

const SENDGRID_US_BASE: &str = "https://api.sendgrid.com";
const SENDGRID_EU_BASE: &str = "https://api.eu.sendgrid.com";

fn base_url(sendgrid_region: Option<&str>) -> &'static str {
    match sendgrid_region.unwrap_or("").trim() {
        "eu" => SENDGRID_EU_BASE,
        _ => SENDGRID_US_BASE,
    }
}

fn candidate_bases(sendgrid_region: Option<&str>) -> Vec<&'static str> {
    match sendgrid_region
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "eu" => vec![SENDGRID_EU_BASE],
        "global" | "us" => vec![SENDGRID_US_BASE],
        // The UI labels the empty value as automatic. For all read-only API
        // discovery calls, try EU first then global. This fixes EU SendGrid
        // accounts being queried against api.sendgrid.com only.
        _ => vec![SENDGRID_EU_BASE, SENDGRID_US_BASE],
    }
}

fn region_name_for_base(base: &str) -> &'static str {
    if base == SENDGRID_EU_BASE {
        "eu"
    } else {
        "global"
    }
}

async fn get_json(base: &str, path: &str, api_key: &str) -> AppResult<Value> {
    json_response(
        HTTP_CLIENT
            .get(format!("{base}{path}"))
            .bearer_auth(api_key),
    )
    .await
}

async fn optional_get_json(base: &str, path: &str, api_key: &str) -> Value {
    match get_json(base, path, api_key).await {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

async fn first_successful_get(
    api_key: &str,
    sendgrid_region: Option<&str>,
    path: &str,
) -> AppResult<(&'static str, Value)> {
    let mut errors = Vec::new();
    for base in candidate_bases(sendgrid_region) {
        match get_json(base, path, api_key).await {
            Ok(data) => return Ok((base, data)),
            Err(e) => errors.push(format!("{}: {}", region_name_for_base(base), e)),
        }
    }
    Err(AppError::Security(format!(
        "SendGrid API failed on all regions — {}",
        errors.join(" | ")
    )))
}

pub async fn send_email(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Validation("SendGrid API key required".into()));
    }
    let region = if cfg.sendgrid_region.is_empty() {
        None
    } else {
        Some(cfg.sendgrid_region.as_str())
    };
    // Do not auto-fallback on an actual send: retrying a mail/send request on
    // another region after an ambiguous network failure could duplicate mail.
    let base = base_url(region);

    let mut content = Vec::new();
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        content.push(json!({ "type": "text/plain", "value": text }));
    }
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        content.push(json!({ "type": "text/html", "value": html }));
    }

    let mut from = json!({ "email": message.from_email });
    if let Some(name) = message
        .from_name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        from["name"] = Value::String(name.to_string());
    }

    let mut to = json!({ "email": message.to_email });
    if let Some(name) = message.to_name.as_deref().filter(|s| !s.trim().is_empty()) {
        to["name"] = Value::String(name.to_string());
    }

    let mut payload = json!({
        "personalizations": [{ "to": [to] }],
        "from": from,
        "subject": message.subject,
        "content": content,
    });
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["reply_to"] = json!({ "email": reply_to });
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

    let response = client
        .post(format!("{base}/v3/mail/send"))
        .bearer_auth(api_key)
        .header("accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::Security(format!("SendGrid network: {e}")))?;

    let status = response.status();
    let message_id = response
        .headers()
        .get("x-message-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Security(format!(
            "SendGrid HTTP {}: {}",
            status.as_u16(),
            body.chars().take(400).collect::<String>()
        )));
    }

    Ok(SendResult {
        provider: "sendgrid".into(),
        message_id,
        raw: Some(json!({ "status": status.as_u16(), "body": body })),
    })
}

pub async fn ping(api_key: &str, sendgrid_region: Option<&str>) -> AppResult<Value> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("SendGrid API key required".into()));
    }
    let (base, profile) =
        first_successful_get(api_key, sendgrid_region, "/v3/user/profile").await?;
    Ok(json!({
        "provider": "sendgrid",
        "region": region_name_for_base(base),
        "base_used": base,
        "profile": profile,
    }))
}

pub async fn inspect(api_key: &str, sendgrid_region: Option<&str>) -> AppResult<Value> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("SendGrid API key required".into()));
    }

    let (base, profile) =
        first_successful_get(api_key, sendgrid_region, "/v3/user/profile").await?;

    let account = optional_get_json(base, "/v3/user/account", api_key).await;
    let credits = optional_get_json(base, "/v3/user/credits", api_key).await;
    let scopes = optional_get_json(base, "/v3/scopes", api_key).await;
    let verified_senders_raw = optional_get_json(base, "/v3/verified_senders", api_key).await;
    let legacy_senders_raw = optional_get_json(base, "/v3/senders", api_key).await;
    let domains_raw = optional_get_json(base, "/v3/whitelabel/domains", api_key).await;

    let mut identities = Vec::new();
    if let Some(data) = verified_senders_raw.get("data") {
        collect_verified_sender_identities(data, &mut identities);
    }
    if let Some(data) = legacy_senders_raw.get("data") {
        collect_legacy_sender_identities(data, &mut identities);
    }
    if let Some(data) = domains_raw.get("data") {
        collect_authenticated_domain_identities(data, &mut identities);
    }
    dedupe_identities(&mut identities);
    let verified_count = identities
        .iter()
        .filter(|item| {
            item.get("verified")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .count();
    let unverified_count = identities.len().saturating_sub(verified_count);

    let quota_summary = build_credits_summary(credits.get("data").unwrap_or(&Value::Null));

    Ok(json!({
        "provider": "sendgrid",
        "region": region_name_for_base(base),
        "base_used": base,
        "profile": profile,
        "account": account,
        "credits": credits,
        "quota_summary": quota_summary,
        "scopes": scopes,
        "identity_summary": {
            "count": identities.len(),
            "verified_count": verified_count,
            "unverified_count": unverified_count,
            "identities": identities,
            "sources": {
                "verified_senders": verified_senders_raw.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "legacy_senders": legacy_senders_raw.get("ok").and_then(Value::as_bool).unwrap_or(false),
                "authenticated_domains": domains_raw.get("ok").and_then(Value::as_bool).unwrap_or(false)
            }
        },
        "verified_senders": verified_senders_raw,
        "senders": legacy_senders_raw,
        "authenticated_domains": domains_raw,
    }))
}

pub async fn verified_senders(
    api_key: &str,
    sendgrid_region: Option<&str>,
) -> AppResult<Vec<Value>> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("SendGrid API key required".into()));
    }

    let mut last_error = None;
    for base in candidate_bases(sendgrid_region) {
        let mut out = Vec::new();

        match get_json(base, "/v3/verified_senders", api_key).await {
            Ok(response) => collect_verified_sender_identities(&response, &mut out),
            Err(e) => last_error = Some(e.to_string()),
        }
        if let Ok(response) = get_json(base, "/v3/senders", api_key).await {
            collect_legacy_sender_identities(&response, &mut out);
        }
        if let Ok(response) = get_json(base, "/v3/whitelabel/domains", api_key).await {
            collect_authenticated_domain_identities(&response, &mut out);
        }

        dedupe_identities(&mut out);
        if !out.is_empty() {
            return Ok(out);
        }

        // If the mandatory profile endpoint works but no identity endpoint has
        // data, do not keep trying unrelated regions unless region is automatic.
        if sendgrid_region.is_some() {
            return Ok(out);
        }
    }

    if let Some(err) = last_error {
        return Err(AppError::Security(format!(
            "SendGrid identities unavailable: {err}"
        )));
    }
    Ok(Vec::new())
}

fn array_from_response(value: &Value) -> Vec<&Value> {
    if let Some(arr) = value.as_array() {
        return arr.iter().collect();
    }
    for key in ["results", "senders", "domains", "result"] {
        if let Some(arr) = value.get(key).and_then(Value::as_array) {
            return arr.iter().collect();
        }
    }
    Vec::new()
}

fn value_is_truthy(value: Option<&Value>, default_when_missing: bool) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "1" | "verified" | "valid" | "success"
        ),
        Some(Value::Object(map)) => {
            if let Some(status) = map.get("status") {
                value_is_truthy(Some(status), false)
            } else if let Some(valid) = map.get("valid") {
                value_is_truthy(Some(valid), false)
            } else {
                default_when_missing
            }
        }
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        Some(_) => default_when_missing,
        None => default_when_missing,
    }
}

fn collect_verified_sender_identities(response: &Value, out: &mut Vec<Value>) {
    for item in array_from_response(response) {
        let verified = value_is_truthy(item.get("verified"), false)
            || value_is_truthy(item.get("status"), false)
            || value_is_truthy(item.get("is_verified"), false);

        let email = first_string(item, &["from_email", "email", "sender_email"]);
        if email.is_empty() {
            continue;
        }
        let name = first_string(item, &["from_name", "name", "nickname"]);
        push_email_identity(out, &email, &name, None, "single sender", verified);
    }
}

fn collect_legacy_sender_identities(response: &Value, out: &mut Vec<Value>) {
    for item in array_from_response(response) {
        let verified = value_is_truthy(item.get("verified"), true)
            || value_is_truthy(item.get("verified_status"), false);

        let mut email = first_string(item, &["from_email", "email", "sender_email"]);
        if email.is_empty() {
            email = nested_string(item, &["from", "email"]);
        }
        if email.is_empty() {
            continue;
        }
        let mut name = first_string(item, &["from_name", "name", "nickname"]);
        if name.is_empty() {
            name = nested_string(item, &["from", "name"]);
        }
        push_email_identity(out, &email, &name, None, "sender identity", verified);
    }
}

fn collect_authenticated_domain_identities(response: &Value, out: &mut Vec<Value>) {
    for item in array_from_response(response) {
        if !value_is_truthy(item.get("valid"), true) {
            continue;
        }
        let domain = first_string(item, &["domain"]);
        if domain.is_empty() {
            continue;
        }
        let subdomain = first_string(item, &["subdomain"]);
        let label = if subdomain.is_empty() {
            format!("@{domain} (authenticated domain — any address)")
        } else {
            format!("@{domain} (authenticated domain, DNS subdomain: {subdomain})")
        };
        out.push(json!({
            "email": format!("noreply@{domain}"),
            "name": "",
            "domain": domain,
            "source": "authenticated domain",
            "verified": true,
            "label": label,
        }));
    }
}

fn push_email_identity(
    out: &mut Vec<Value>,
    email: &str,
    name: &str,
    domain: Option<&str>,
    source: &str,
    verified: bool,
) {
    let base_label = if name.trim().is_empty() {
        email.to_string()
    } else {
        format!("{} <{}>", name.trim(), email.trim())
    };
    let label = if verified {
        format!("{base_label} — verified")
    } else {
        format!("{base_label} — unverified")
    };
    let mut item = json!({
        "email": email.trim(),
        "name": name.trim(),
        "label": label,
        "source": source,
        "verified": verified,
    });
    if let Some(domain) = domain.filter(|s| !s.trim().is_empty()) {
        item["domain"] = Value::String(domain.trim().to_string());
    }
    out.push(item);
}

fn dedupe_identities(items: &mut Vec<Value>) {
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| {
        let email = item
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let domain = item
            .get("domain")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let key = if domain.is_empty() {
            format!("email:{email}")
        } else {
            format!("domain:{domain}")
        };
        !key.ends_with(':') && seen.insert(key)
    });
}

fn first_string(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn nested_string(item: &Value, path: &[&str]) -> String {
    let mut cur = item;
    for key in path {
        match cur.get(*key) {
            Some(next) => cur = next,
            None => return String::new(),
        }
    }
    cur.as_str().unwrap_or("").trim().to_string()
}

fn build_credits_summary(credits: &Value) -> Value {
    if credits.is_null() {
        return Value::Null;
    }

    let total = number_at_any(credits, &["total", "total_credits", "quota", "limit"]);
    let used = number_at_any(credits, &["used", "credits_used", "usage"]);
    let remaining = number_at_any(
        credits,
        &["remaining", "remain", "credits_remaining", "available"],
    );

    json!({
        "total": total,
        "used": used,
        "remaining": remaining,
        "raw": credits,
    })
}

fn number_at_any(value: &Value, keys: &[&str]) -> Value {
    for key in keys {
        if let Some(v) = value.get(*key) {
            if v.is_number() || v.is_string() {
                return v.clone();
            }
        }
    }
    Value::Null
}

pub async fn activity(
    api_key: &str,
    sendgrid_region: Option<&str>,
    limit: u32,
    status: Option<&str>,
    to_email: Option<&str>,
) -> AppResult<Value> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("SendGrid API key required".into()));
    }

    let limit = limit.clamp(1, 100);

    let mut query_parts: Vec<String> = Vec::new();
    if let Some(s) = status.filter(|s| !s.is_empty()) {
        query_parts.push(format!("status=\"{s}\""));
    }
    if let Some(to) = to_email.filter(|s| !s.is_empty()) {
        query_parts.push(format!("to_email=\"{to}\""));
    }
    let query = if query_parts.is_empty() {
        None
    } else {
        Some(query_parts.join(" AND "))
    };

    let mut errors = Vec::new();
    for base in candidate_bases(sendgrid_region) {
        let mut req = HTTP_CLIENT
            .get(format!("{base}/v3/messages"))
            .bearer_auth(api_key)
            .query(&[("limit", limit.to_string())]);
        if let Some(q) = &query {
            req = req.query(&[("query", q.clone())]);
        }

        match json_response(req).await {
            Ok(response) => {
                let messages = response
                    .get("messages")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                return Ok(json!({
                    "base_used": base,
                    "region": region_name_for_base(base),
                    "messages": messages,
                }));
            }
            Err(e) => errors.push(format!("{}: {}", region_name_for_base(base), e)),
        }
    }

    Err(AppError::Security(format!(
        "SendGrid activity unavailable — {}",
        errors.join(" | ")
    )))
}
