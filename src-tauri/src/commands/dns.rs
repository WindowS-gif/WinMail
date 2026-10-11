use hickory_resolver::{Resolver, TokioResolver};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::core::api::ApiResponse;
use crate::core::error::AppResult;

static DMARC_POLICY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"p=(\w+)").expect("valid dmarc policy regex"));

#[derive(Debug, Deserialize)]
struct DnsCheckPayload {
    domain: String,
    #[serde(default = "default_selector")]
    selector: String,
}

fn default_selector() -> String {
    "mail".to_string()
}

pub async fn dns_check(data: Value) -> AppResult<ApiResponse<Value>> {
    let payload: DnsCheckPayload = serde_json::from_value(data)?;
    let domain = payload
        .domain
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let selector = payload.selector.trim();
    if domain.is_empty() {
        return Ok(ApiResponse::err("Missing domain"));
    }

    let resolver = Resolver::builder_tokio()
        .map_err(|e| crate::core::error::AppError::Dns(e.to_string()))?
        .build();

    let spf = check_spf(&resolver, &domain).await;
    let dkim = check_dkim(&resolver, &domain, selector).await;
    let dmarc = check_dmarc(&resolver, &domain).await;

    Ok(ApiResponse::ok(json!({
        "spf": spf,
        "dkim": dkim,
        "dmarc": dmarc
    })))
}

async fn lookup_txt(resolver: &TokioResolver, name: &str) -> Result<Vec<String>, String> {
    let lookup = resolver.txt_lookup(name).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for txt in lookup.iter() {
        let value = txt
            .txt_data()
            .iter()
            .map(|part| String::from_utf8_lossy(part).to_string())
            .collect::<Vec<_>>()
            .join("");
        out.push(value);
    }
    Ok(out)
}

async fn check_spf(resolver: &TokioResolver, domain: &str) -> Value {
    match lookup_txt(resolver, domain).await {
        Ok(records) => {
            for txt in records {
                if txt.starts_with("v=spf1") {
                    let has_brevo =
                        txt.contains("spf.brevo.com") || txt.contains("spf.sendinblue.com");
                    return json!({
                        "status": "found",
                        "message": if has_brevo { "SPF present and includes Brevo ✓" } else { "SPF present but Brevo not included" },
                        "value": txt,
                        "has_brevo": has_brevo
                    });
                }
            }
            json!({ "status": "missing", "message": "SPF record not found", "value": null })
        }
        Err(e) => {
            json!({ "status": "error", "message": format!("Could not resolve {domain}: {e}"), "value": null })
        }
    }
}

async fn check_dkim(resolver: &TokioResolver, domain: &str, selector: &str) -> Value {
    let selector = if selector.is_empty() {
        "mail"
    } else {
        selector
    };
    let host = format!("{selector}._domainkey.{domain}");
    match lookup_txt(resolver, &host).await {
        Ok(records) => {
            for txt in records {
                if txt.contains("v=DKIM1") {
                    let value = if txt.len() > 80 {
                        format!("{}...", &txt[..80])
                    } else {
                        txt.clone()
                    };
                    return json!({ "status": "found", "message": "DKIM present ✓", "value": value });
                }
            }
            json!({ "status": "missing", "message": "DKIM not found (invalid format)", "value": null })
        }
        Err(_) => {
            json!({ "status": "missing", "message": format!("DKIM not found on {host}"), "value": null })
        }
    }
}

async fn check_dmarc(resolver: &TokioResolver, domain: &str) -> Value {
    let host = format!("_dmarc.{domain}");
    match lookup_txt(resolver, &host).await {
        Ok(records) => {
            for txt in records {
                if txt.starts_with("v=DMARC1") {
                    let policy = DMARC_POLICY_RE
                        .captures(&txt)
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                        .unwrap_or_else(|| "none".to_string());
                    return json!({
                        "status": "found",
                        "message": format!("DMARC present, policy: p={policy} ✓"),
                        "value": txt,
                        "policy": policy
                    });
                }
            }
            json!({ "status": "missing", "message": "DMARC not found (invalid format)", "value": null })
        }
        Err(_) => json!({ "status": "missing", "message": "DMARC not found", "value": null }),
    }
}
