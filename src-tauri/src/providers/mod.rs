pub mod brevo;
pub mod mailgun;
pub mod mandrill;
pub mod postmark;
pub mod sendgrid;
pub mod ses;
pub mod sigv4;

use once_cell::sync::Lazy;
use reqwest::Client;
use std::time::Duration;

use crate::core::error::{AppError, AppResult};

/// Shared HTTP client used by ping / inspect / verified-senders endpoints, and
/// as the default for sends when no per-campaign proxy is configured.
pub static HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .user_agent("WinMail/0.1 (rust)")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client init")
});

/// Send a request and return the parsed JSON body, with uniform error mapping.
pub async fn json_response(req: reqwest::RequestBuilder) -> AppResult<serde_json::Value> {
    let response = req
        .send()
        .await
        .map_err(|e| AppError::Security(format!("network: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::Security(format!("response body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::Security(format!(
            "HTTP {} — {}",
            status.as_u16(),
            text.chars().take(400).collect::<String>()
        )));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| AppError::Security(format!("parse JSON: {e}")))
}
