use std::collections::BTreeMap;

use chrono::Utc;
use reqwest::Client;
use serde_json::{json, Value};

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::providers::sigv4::{sign, SigV4Request};
use crate::providers::{json_response, HTTP_CLIENT};

pub async fn send_email(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    let access_key = cfg.access_key.trim();
    let secret_key = cfg.secret_key.trim();
    let region = cfg.region.trim();
    validate(access_key, secret_key, region)?;

    let host = format!("email.{region}.amazonaws.com");
    let path = "/v2/email/outbound-emails".to_string();

    let mut simple = json!({
        "Subject": { "Data": message.subject, "Charset": "UTF-8" },
    });
    let mut body_obj = serde_json::Map::new();
    if let Some(text) = message.text.as_deref().filter(|s| !s.trim().is_empty()) {
        body_obj.insert(
            "Text".to_string(),
            json!({ "Data": text, "Charset": "UTF-8" }),
        );
    }
    if let Some(html) = message.html.as_deref().filter(|s| !s.trim().is_empty()) {
        body_obj.insert(
            "Html".to_string(),
            json!({ "Data": html, "Charset": "UTF-8" }),
        );
    }
    simple["Body"] = Value::Object(body_obj);

    let mut headers = Vec::new();
    for (k, v) in message.unsubscribe_headers() {
        headers.push(json!({ "Name": k, "Value": v }));
    }
    for (k, v) in &message.headers {
        headers.push(json!({ "Name": k, "Value": v }));
    }
    if !headers.is_empty() {
        simple["Headers"] = Value::Array(headers);
    }

    let mut payload = json!({
        "FromEmailAddress": message.formatted_from(),
        "Destination": { "ToAddresses": [message.formatted_to()] },
        "Content": { "Simple": simple },
    });
    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        payload["ReplyToAddresses"] = json!([reply_to]);
    }

    let body = serde_json::to_vec(&payload)
        .map_err(|e| AppError::Security(format!("SES payload: {e}")))?;

    let sig = sign(
        &SigV4Request {
            method: "POST",
            host: host.clone(),
            path: path.clone(),
            query: BTreeMap::new(),
            body: body.clone(),
            region: region.to_string(),
            service: "ses".into(),
        },
        access_key,
        secret_key,
        Utc::now(),
    );

    let response = client
        .post(format!("https://{host}{path}"))
        .header("Host", host.as_str())
        .header("X-Amz-Date", sig.amz_date)
        .header("X-Amz-Content-Sha256", sig.content_sha256)
        .header("Authorization", sig.authorization)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Security(format!("SES network: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Security(format!("SES body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::Security(format!(
            "SES HTTP {}: {}",
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        )));
    }
    let raw: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let message_id = raw
        .get("MessageId")
        .and_then(Value::as_str)
        .map(String::from);
    Ok(SendResult {
        provider: "ses".into(),
        message_id,
        raw: Some(raw),
    })
}

pub async fn ping(access_key: &str, secret_key: &str, region: &str) -> AppResult<Value> {
    validate(access_key, secret_key, region)?;
    let account = get_account(access_key, secret_key, region).await?;
    Ok(json!({ "provider": "ses", "region": region, "account": account }))
}

pub async fn inspect(access_key: &str, secret_key: &str, region: &str) -> AppResult<Value> {
    validate(access_key, secret_key, region)?;

    let account = get_account(access_key, secret_key, region).await;
    let identities = list_identities(access_key, secret_key, region).await;

    let mut errors = serde_json::Map::new();
    if let Err(e) = &account {
        errors.insert("account".into(), Value::String(e.to_string()));
    }
    if let Err(e) = &identities {
        errors.insert("identities".into(), Value::String(e.to_string()));
    }

    Ok(json!({
        "provider": "ses",
        "region": region,
        "account": account.ok(),
        "identities": identities.ok(),
        "errors": Value::Object(errors),
    }))
}

pub async fn verified_senders(
    access_key: &str,
    secret_key: &str,
    region: &str,
) -> AppResult<Vec<Value>> {
    validate(access_key, secret_key, region)?;
    let response = list_identities(access_key, secret_key, region).await?;
    Ok(parse_identities(&response))
}

/// Turn a SES `ListEmailIdentities` response into selectable sender options.
///
/// IdentityType is one of `EMAIL_ADDRESS | DOMAIN | MANAGED_DOMAIN` (SES v2).
/// A verified DOMAIN authorizes sending from ANY address on that domain, so we
/// surface domains too — most SES accounts verify domains, not individual
/// addresses, and dropping them made the sender list look empty.
pub(crate) fn parse_identities(response: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(arr) = response.get("EmailIdentities").and_then(Value::as_array) else {
        return out;
    };
    for item in arr {
        let identity_type = item
            .get("IdentityType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let identity_name = item
            .get("IdentityName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let sending_enabled = item
            .get("SendingEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let verification_status = item
            .get("VerificationStatus")
            .and_then(Value::as_str)
            .unwrap_or("");

        let verified = verification_status == "SUCCESS" || sending_enabled;
        if identity_name.is_empty() || !verified {
            continue;
        }

        match identity_type {
            "EMAIL_ADDRESS" => out.push(json!({
                "email": identity_name,
                "name": "",
                "label": identity_name,
            })),
            "DOMAIN" | "MANAGED_DOMAIN" => out.push(json!({
                // Suggest a sensible default; SES accepts any local part on a
                // verified domain (the mailbox need not exist).
                "email": format!("noreply@{identity_name}"),
                "name": "",
                "domain": identity_name,
                "label": format!("@{identity_name} (verified domain — any address)"),
            })),
            _ => {}
        }
    }
    out
}

/// Inspect every commonly used SES region in parallel and return a summary.
pub async fn inspect_all_regions(
    access_key: &str,
    secret_key: &str,
    preferred_region: Option<&str>,
) -> AppResult<Value> {
    if access_key.trim().is_empty() || secret_key.trim().is_empty() {
        return Err(AppError::Validation(
            "Access Key ID and Secret Access Key required".into(),
        ));
    }

    const REGIONS: &[(&str, &str)] = &[
        ("us-east-1", "US East (N. Virginia)"),
        ("us-east-2", "US East (Ohio)"),
        ("us-west-1", "US West (N. California)"),
        ("us-west-2", "US West (Oregon)"),
        ("ca-central-1", "Canada (Central)"),
        ("eu-west-1", "Europe (Ireland)"),
        ("eu-west-2", "Europe (London)"),
        ("eu-west-3", "Europe (Paris)"),
        ("eu-central-1", "Europe (Frankfurt)"),
        ("eu-north-1", "Europe (Stockholm)"),
        ("eu-south-1", "Europe (Milan)"),
        ("ap-south-1", "Asia Pacific (Mumbai)"),
        ("ap-southeast-1", "Asia Pacific (Singapore)"),
        ("ap-southeast-2", "Asia Pacific (Sydney)"),
        ("ap-northeast-1", "Asia Pacific (Tokyo)"),
        ("ap-northeast-2", "Asia Pacific (Seoul)"),
        ("sa-east-1", "South America (São Paulo)"),
        ("me-south-1", "Middle East (Bahrain)"),
        ("af-south-1", "Africa (Cape Town)"),
    ];

    let preferred_owned = preferred_region.map(|s| s.to_string());
    let mut handles = Vec::new();
    for (code, label) in REGIONS {
        let ak = access_key.to_string();
        let sk = secret_key.to_string();
        let region = code.to_string();
        let lbl = label.to_string();
        let preferred = preferred_owned.clone();
        handles.push(tokio::spawn(async move {
            let matches = preferred.as_deref().map(|r| r == region).unwrap_or(false);
            match get_account(&ak, &sk, &region).await {
                Ok(data) => {
                    let quota = data.get("SendQuota").cloned().unwrap_or(Value::Null);
                    json!({
                        "region": region,
                        "label": lbl,
                        "ok": true,
                        "production_access": data.get("ProductionAccessEnabled"),
                        "sending_enabled": data.get("SendingEnabled"),
                        "max_24h": quota.get("Max24HourSend"),
                        "sent_24h": quota.get("SentLast24Hours"),
                        "max_rate": quota.get("MaxSendRate"),
                        "matches_form_region": matches,
                    })
                }
                Err(e) => json!({
                    "region": region,
                    "label": lbl,
                    "ok": false,
                    "error": e.to_string(),
                    "matches_form_region": matches,
                }),
            }
        }));
    }

    let mut regions = Vec::new();
    for handle in handles {
        if let Ok(value) = handle.await {
            regions.push(value);
        }
    }

    let reachable_count = regions.iter().filter(|r| r["ok"] == true).count();
    let best = regions
        .iter()
        .filter(|r| r["ok"] == true)
        .max_by_key(|r| r["max_24h"].as_f64().map(|x| x as i64).unwrap_or(0));

    Ok(json!({
        "provider": "ses",
        "probe_all_regions": true,
        "region": "*",
        "regions": regions,
        "summary": {
            "reachable_count": reachable_count,
            "best_quota_region": best.map(|r| r["region"].clone()),
            "best_quota_label": best.map(|r| r["label"].clone()),
            "best_max_24h": best.map(|r| r["max_24h"].clone()),
            "hint": "List built from parallel GetAccount calls across public SES regions.",
        }
    }))
}

fn validate(access_key: &str, secret_key: &str, region: &str) -> AppResult<()> {
    if access_key.trim().is_empty() {
        return Err(AppError::Validation("Access Key ID required".into()));
    }
    if secret_key.trim().is_empty() {
        return Err(AppError::Validation("Secret Access Key required".into()));
    }
    if region.trim().is_empty() {
        return Err(AppError::Validation("SES region required".into()));
    }
    Ok(())
}

async fn get_account(access_key: &str, secret_key: &str, region: &str) -> AppResult<Value> {
    let host = format!("email.{region}.amazonaws.com");
    let path = "/v2/email/account".to_string();

    let sig = sign(
        &SigV4Request {
            method: "GET",
            host: host.clone(),
            path: path.clone(),
            query: BTreeMap::new(),
            body: Vec::new(),
            region: region.to_string(),
            service: "ses".into(),
        },
        access_key,
        secret_key,
        Utc::now(),
    );

    let request = HTTP_CLIENT
        .get(format!("https://{host}{path}"))
        .header("Host", host.as_str())
        .header("X-Amz-Date", sig.amz_date)
        .header("X-Amz-Content-Sha256", sig.content_sha256)
        .header("Authorization", sig.authorization)
        .header("Accept", "application/json");

    json_response(request).await
}

async fn list_identities(access_key: &str, secret_key: &str, region: &str) -> AppResult<Value> {
    let host = format!("email.{region}.amazonaws.com");
    let path = "/v2/email/identities".to_string();
    let mut query = BTreeMap::new();
    query.insert("PageSize".to_string(), "100".to_string());

    let sig = sign(
        &SigV4Request {
            method: "GET",
            host: host.clone(),
            path: path.clone(),
            query: query.clone(),
            body: Vec::new(),
            region: region.to_string(),
            service: "ses".into(),
        },
        access_key,
        secret_key,
        Utc::now(),
    );

    let mut request = HTTP_CLIENT
        .get(format!("https://{host}{path}"))
        .header("Host", host.as_str())
        .header("X-Amz-Date", sig.amz_date)
        .header("X-Amz-Content-Sha256", sig.content_sha256)
        .header("Authorization", sig.authorization)
        .header("Accept", "application/json");
    for (k, v) in &query {
        request = request.query(&[(k.as_str(), v.as_str())]);
    }

    json_response(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_identities_surfaces_verified_domains() {
        // The exact shape returned by SES v2 ListEmailIdentities for an
        // account that verified two domains (no individual email identities).
        let response = json!({
            "EmailIdentities": [
                {
                    "IdentityName": "hokifyjob.com",
                    "IdentityType": "DOMAIN",
                    "SendingEnabled": true,
                    "VerificationStatus": "SUCCESS"
                },
                {
                    "IdentityName": "hokify.com",
                    "IdentityType": "DOMAIN",
                    "SendingEnabled": true,
                    "VerificationStatus": "SUCCESS"
                }
            ],
            "NextToken": null
        });
        let out = parse_identities(&response);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["email"], "noreply@hokifyjob.com");
        assert_eq!(out[0]["domain"], "hokifyjob.com");
        assert_eq!(out[1]["email"], "noreply@hokify.com");
        assert!(out[1]["label"]
            .as_str()
            .unwrap()
            .contains("verified domain"));
    }

    #[test]
    fn parse_identities_handles_email_addresses() {
        let response = json!({
            "EmailIdentities": [
                {
                    "IdentityName": "alice@example.com",
                    "IdentityType": "EMAIL_ADDRESS",
                    "SendingEnabled": true,
                    "VerificationStatus": "SUCCESS"
                }
            ]
        });
        let out = parse_identities(&response);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["email"], "alice@example.com");
        assert!(out[0].get("domain").is_none());
    }

    #[test]
    fn parse_identities_skips_unverified_and_pending() {
        let response = json!({
            "EmailIdentities": [
                {
                    "IdentityName": "pending.com",
                    "IdentityType": "DOMAIN",
                    "SendingEnabled": false,
                    "VerificationStatus": "PENDING"
                },
                {
                    "IdentityName": "failed@example.com",
                    "IdentityType": "EMAIL_ADDRESS",
                    "SendingEnabled": false,
                    "VerificationStatus": "FAILED"
                }
            ]
        });
        assert!(parse_identities(&response).is_empty());
    }

    #[test]
    fn parse_identities_empty_response() {
        assert!(parse_identities(&json!({})).is_empty());
        assert!(parse_identities(&json!({ "EmailIdentities": [] })).is_empty());
    }
}
