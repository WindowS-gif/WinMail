use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::{json_response, HTTP_CLIENT};

const MANDRILL_API: &str = "https://mandrillapp.com/api/1.0";

fn validate(api_key: &str) -> AppResult<()> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation("Mandrill API key required".into()));
    }
    Ok(())
}

pub async fn send_email(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    let api_key = cfg.api_key.trim();
    validate(api_key)?;

    let payload = build_payload(api_key, message);

    let response = json_response(
        client
            .post(format!("{MANDRILL_API}/messages/send.json"))
            .json(&payload),
    )
    .await?;

    // Mandrill returns an array of result objects, one per recipient.
    let message_id = response
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("_id"))
        .and_then(Value::as_str)
        .map(String::from);
    let status = response
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|first| first.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(status, "rejected" | "invalid") {
        let reason = response
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|first| first.get("reject_reason"))
            .and_then(Value::as_str)
            .unwrap_or("unknown reason");
        return Err(AppError::Security(format!(
            "Mandrill rejected the message: {status} ({reason})"
        )));
    }

    Ok(SendResult {
        provider: "mandrill".into(),
        message_id,
        raw: Some(response),
    })
}

pub async fn ping(api_key: &str) -> AppResult<Value> {
    validate(api_key)?;
    let response = json_response(
        HTTP_CLIENT
            .post(format!("{MANDRILL_API}/users/ping2.json"))
            .json(&json!({ "key": api_key })),
    )
    .await?;
    Ok(json!({
        "provider": "mandrill",
        "ping": response
    }))
}

pub async fn inspect(api_key: &str) -> AppResult<Value> {
    validate(api_key)?;

    let info = json_response(
        HTTP_CLIENT
            .post(format!("{MANDRILL_API}/users/info.json"))
            .json(&json!({ "key": api_key })),
    )
    .await?;

    let senders = json_response(
        HTTP_CLIENT
            .post(format!("{MANDRILL_API}/senders/list.json"))
            .json(&json!({ "key": api_key })),
    )
    .await
    .unwrap_or(Value::Null);

    let domains = json_response(
        HTTP_CLIENT
            .post(format!("{MANDRILL_API}/senders/domains.json"))
            .json(&json!({ "key": api_key })),
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "provider": "mandrill",
        "info": info,
        "senders": senders,
        "domains": domains,
    }))
}

pub async fn verified_senders(api_key: &str) -> AppResult<Vec<Value>> {
    validate(api_key)?;
    let response = json_response(
        HTTP_CLIENT
            .post(format!("{MANDRILL_API}/senders/list.json"))
            .json(&json!({ "key": api_key })),
    )
    .await?;
    Ok(parse_verified_senders(&response))
}

pub(crate) fn build_payload(api_key: &str, message: &EmailMessage) -> Value {
    let mut headers_obj = serde_json::Map::new();
    for (k, v) in message
        .unsubscribe_headers()
        .into_iter()
        .chain(message.headers.iter().cloned())
    {
        headers_obj.insert(k, Value::String(v));
    }
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        headers_obj.insert("Reply-To".to_string(), Value::String(reply_to.to_string()));
    }

    let mut msg = json!({
        "from_email": message.from_email,
        "from_name": message.from_name.as_deref().unwrap_or(""),
        "to": [{
            "email": message.to_email,
            "name": message.to_name.as_deref().unwrap_or(""),
            "type": "to"
        }],
        "subject": message.subject,
    });
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        msg["html"] = Value::String(html.to_string());
    }
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        msg["text"] = Value::String(text.to_string());
    }
    if !headers_obj.is_empty() {
        msg["headers"] = Value::Object(headers_obj);
    }

    json!({
        "key": api_key,
        "message": msg,
        "async": false,
    })
}

pub(crate) fn parse_verified_senders(response: &Value) -> Vec<Value> {
    let Some(items) = response.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sender in items {
        let email = sender
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if email.is_empty() || !email.contains('@') {
            continue;
        }
        out.push(json!({
            "email": email.clone(),
            "name": "",
            "label": email
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_empty() {
        assert!(validate("").is_err());
        assert!(validate("  ").is_err());
        assert!(validate("md-XXXXXXXX").is_ok());
    }

    #[test]
    fn parse_verified_senders_extracts_addresses() {
        let response = serde_json::json!([
            { "address": "alice@example.com", "sent": 10 },
            { "address": "bob@example.org", "sent": 0 },
            { "address": "" },
            { "address": "not-an-email" }
        ]);
        let senders = parse_verified_senders(&response);
        assert_eq!(senders.len(), 2);
        assert_eq!(senders[0]["email"], "alice@example.com");
        assert_eq!(senders[1]["email"], "bob@example.org");
    }

    #[test]
    fn parse_verified_senders_non_array() {
        let response = serde_json::json!({ "status": "error" });
        assert!(parse_verified_senders(&response).is_empty());
    }

    fn message_with(reply_to: Option<&str>, unsub: Option<&str>) -> EmailMessage {
        EmailMessage {
            from_email: "from@example.com".into(),
            from_name: Some("From".into()),
            to_email: "to@example.com".into(),
            to_name: None,
            reply_to: reply_to.map(String::from),
            subject: "Hello".into(),
            html: Some("<p>hi</p>".into()),
            text: Some("hi".into()),
            unsubscribe_url: unsub.map(String::from),
            headers: Vec::new(),
        }
    }

    #[test]
    fn build_payload_includes_reply_to_even_without_other_headers() {
        // Regression test for the bug where Reply-To was dropped because the
        // headers object had not been initialised yet.
        let payload = build_payload("key", &message_with(Some("reply@example.com"), None));
        let headers = payload["message"]["headers"]
            .as_object()
            .expect("headers present");
        assert_eq!(
            headers.get("Reply-To").and_then(Value::as_str),
            Some("reply@example.com")
        );
    }

    #[test]
    fn build_payload_omits_headers_when_none() {
        let payload = build_payload("key", &message_with(None, None));
        assert!(payload["message"].get("headers").is_none());
    }

    #[test]
    fn build_payload_attaches_unsubscribe_headers() {
        let payload = build_payload("key", &message_with(None, Some("https://unsub.example/u")));
        let headers = payload["message"]["headers"]
            .as_object()
            .expect("headers present");
        assert!(headers.contains_key("List-Unsubscribe"));
        assert!(headers.contains_key("List-Unsubscribe-Post"));
    }
}
