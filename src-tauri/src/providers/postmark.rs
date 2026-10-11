use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::{json_response, HTTP_CLIENT};

const POSTMARK_API: &str = "https://api.postmarkapp.com";

fn validate(api_key: &str) -> AppResult<()> {
    if api_key.trim().is_empty() {
        return Err(AppError::Validation(
            "Postmark Server API Token required".into(),
        ));
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

    let mut payload = json!({
        "From": message.formatted_from(),
        "To": message.formatted_to(),
        "Subject": message.subject,
        "MessageStream": "outbound",
    });
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["HtmlBody"] = Value::String(html.to_string());
    }
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["TextBody"] = Value::String(text.to_string());
    }
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["ReplyTo"] = Value::String(reply_to.to_string());
    }

    let mut headers = Vec::new();
    for (k, v) in message
        .unsubscribe_headers()
        .into_iter()
        .chain(message.headers.iter().cloned())
    {
        headers.push(json!({ "Name": k, "Value": v }));
    }
    if !headers.is_empty() {
        payload["Headers"] = Value::Array(headers);
    }

    let response = json_response(
        client
            .post(format!("{POSTMARK_API}/email"))
            .header("X-Postmark-Server-Token", api_key)
            .header("Accept", "application/json")
            .json(&payload),
    )
    .await?;

    let message_id = response
        .get("MessageID")
        .and_then(Value::as_str)
        .map(String::from);
    let error_code = response
        .get("ErrorCode")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if error_code != 0 {
        let message_text = response
            .get("Message")
            .and_then(Value::as_str)
            .unwrap_or("Postmark error");
        return Err(AppError::Security(format!(
            "Postmark code {error_code}: {message_text}"
        )));
    }
    Ok(SendResult {
        provider: "postmark".into(),
        message_id,
        raw: Some(response),
    })
}

pub async fn ping(api_key: &str) -> AppResult<Value> {
    validate(api_key)?;
    let server = json_response(
        HTTP_CLIENT
            .get(format!("{POSTMARK_API}/server"))
            .header("X-Postmark-Server-Token", api_key)
            .header("Accept", "application/json"),
    )
    .await?;
    Ok(json!({
        "provider": "postmark",
        "server": server
    }))
}

pub async fn inspect(api_key: &str) -> AppResult<Value> {
    validate(api_key)?;

    let server = json_response(
        HTTP_CLIENT
            .get(format!("{POSTMARK_API}/server"))
            .header("X-Postmark-Server-Token", api_key)
            .header("Accept", "application/json"),
    )
    .await?;

    // /senders requires an Account API Token, may fail with a Server Token.
    // We still try it so a user who pasted an account token gets full data.
    let senders = json_response(
        HTTP_CLIENT
            .get(format!("{POSTMARK_API}/senders"))
            .header("X-Postmark-Server-Token", api_key)
            .header("X-Postmark-Account-Token", api_key)
            .header("Accept", "application/json"),
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "provider": "postmark",
        "server": server,
        "senders": senders,
        "note": "Sender signature list only available with an Account API Token."
    }))
}

pub async fn verified_senders(api_key: &str) -> AppResult<Vec<Value>> {
    validate(api_key)?;
    let response = json_response(
        HTTP_CLIENT
            .get(format!("{POSTMARK_API}/senders"))
            .header("X-Postmark-Server-Token", api_key)
            .header("X-Postmark-Account-Token", api_key)
            .header("Accept", "application/json"),
    )
    .await;
    let response = match response {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_verified_senders(&response))
}

pub(crate) fn parse_verified_senders(response: &Value) -> Vec<Value> {
    let Some(arr) = response.get("SenderSignatures").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sig in arr {
        let confirmed = sig
            .get("Confirmed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !confirmed {
            continue;
        }
        let email = sig
            .get("EmailAddress")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if email.is_empty() {
            continue;
        }
        let name = sig
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let label = if name.is_empty() {
            email.clone()
        } else {
            format!("{name} <{email}>")
        };
        out.push(json!({
            "email": email,
            "name": name,
            "label": label
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
        assert!(validate("\t").is_err());
        assert!(validate("abc123").is_ok());
    }

    #[test]
    fn parse_verified_senders_filters_confirmed() {
        let response = serde_json::json!({
            "TotalCount": 3,
            "SenderSignatures": [
                {
                    "ID": 1,
                    "EmailAddress": "alice@example.com",
                    "Name": "Alice",
                    "Confirmed": true
                },
                {
                    "ID": 2,
                    "EmailAddress": "bob@example.com",
                    "Name": "",
                    "Confirmed": true
                },
                {
                    "ID": 3,
                    "EmailAddress": "draft@example.com",
                    "Name": "Draft",
                    "Confirmed": false
                }
            ]
        });
        let senders = parse_verified_senders(&response);
        assert_eq!(senders.len(), 2);
        assert_eq!(senders[0]["email"], "alice@example.com");
        assert_eq!(senders[0]["label"], "Alice <alice@example.com>");
        assert_eq!(senders[1]["email"], "bob@example.com");
        assert_eq!(senders[1]["label"], "bob@example.com");
    }

    #[test]
    fn parse_verified_senders_missing_key() {
        let response = serde_json::json!({ "TotalCount": 0 });
        assert!(parse_verified_senders(&response).is_empty());
    }
}
