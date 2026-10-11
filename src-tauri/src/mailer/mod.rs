pub mod message;
pub mod proxy;
pub mod smtp;
pub mod smtp_proxy;

pub use message::{EmailMessage, SendResult};

use reqwest::Client;

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};

/// Sends an email through any supported provider using the global HTTP client.
/// Decryption of the config secrets must have been performed by the caller
/// (`resolve_config_for_action` in `provider_configs` already does it).
///
/// All messages go through `with_text_fallback`: if HTML is present but text
/// is empty, a plain-text alternative is auto-derived from the HTML before
/// reaching the provider. Pure-HTML messages are routinely down-ranked by MTAs
/// so this is a free deliverability win.
pub async fn send_email(cfg: &ProviderConfig, message: &EmailMessage) -> AppResult<SendResult> {
    send_email_with_client(cfg, message, &crate::providers::HTTP_CLIENT).await
}

/// Same as [`send_email`] but routes HTTP-API providers through `client`.
///
/// Used by the campaign engine to switch the underlying `reqwest::Client` per
/// send when proxies are enabled. SMTP / Office365 ignore the client and go
/// through the existing lettre transport (proxy support for raw SMTP is not
/// yet implemented).
pub async fn send_email_with_client(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    client: &Client,
) -> AppResult<SendResult> {
    if let Err(msg) = message.validate() {
        return Err(AppError::Validation(msg));
    }

    // Normalize `Name <addr>` in address fields (so API payloads get a bare
    // address) and synthesise a text part for HTML-only mail. Cheap relative
    // to the network send, so always done.
    let prepared = message
        .clone()
        .with_normalized_addresses()
        .with_text_fallback();
    let m = &prepared;

    let provider = cfg.provider.to_ascii_lowercase();
    match provider.as_str() {
        "smtp" | "office365" => smtp::send(cfg, m).await,
        "brevo" => crate::providers::brevo::send_email(cfg, m, client).await,
        "sendgrid" => crate::providers::sendgrid::send_email(cfg, m, client).await,
        "ses" | "amazonses" => crate::providers::ses::send_email(cfg, m, client).await,
        "mailgun" => crate::providers::mailgun::send_email(cfg, m, client).await,
        "mandrill" => crate::providers::mandrill::send_email(cfg, m, client).await,
        "postmark" => crate::providers::postmark::send_email(cfg, m, client).await,
        other => Err(AppError::Validation(format!(
            "Unsupported provider for sending: {other}"
        ))),
    }
}
