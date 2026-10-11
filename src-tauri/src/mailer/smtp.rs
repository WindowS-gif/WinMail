use std::time::Duration;

use lettre::message::header::{ContentType, Header, HeaderName, HeaderValue};
use lettre::message::{Mailbox, Message, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

/// RFC 8058 List-Unsubscribe header (one-click unsubscribe).
#[derive(Clone)]
pub(crate) struct ListUnsubscribe(pub String);

impl Header for ListUnsubscribe {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii("List-Unsubscribe".to_string()).expect("valid header name")
    }
    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// `List-Unsubscribe-Post` header that enables one-click in Gmail/Yahoo.
#[derive(Clone)]
pub(crate) struct ListUnsubscribePost(pub String);

impl Header for ListUnsubscribePost {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii("List-Unsubscribe-Post".to_string()).expect("valid header name")
    }
    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_string()))
    }
    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), self.0.clone())
    }
}

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};

/// Sends an email through a generic SMTP server (also used for Microsoft 365
/// since that's just a flavoured SMTP).
pub async fn send(cfg: &ProviderConfig, message: &EmailMessage) -> AppResult<SendResult> {
    let transport = build_transport_for(cfg)?;
    send_via(&transport, cfg, message).await
}

/// Same as [`send`] but reuses a pre-built transport, so the underlying TLS
/// connection pool (`pool` feature of lettre) is shared across messages of a
/// campaign instead of being rebuilt per call.
pub async fn send_via(
    transport: &AsyncSmtpTransport<Tokio1Executor>,
    cfg: &ProviderConfig,
    message: &EmailMessage,
) -> AppResult<SendResult> {
    let email = build_lettre_message(message)?;

    let response = transport
        .send(email)
        .await
        .map_err(|e| AppError::Validation(format!("SMTP send: {e}")))?;

    Ok(SendResult {
        provider: cfg.provider.clone(),
        message_id: response.first_line().map(str::to_string),
        raw: Some(serde_json::json!({
            "code": response.code().to_string(),
            "message": response.message().collect::<Vec<_>>().join("\n")
        })),
    })
}

/// Build the lettre [`Message`] used by both the direct transport and the
/// proxied SMTP path (`smtp_proxy::send`). Centralises MIME assembly so the
/// two paths stay in lockstep (List-Unsubscribe headers, alternative parts,
/// Reply-To, etc.).
pub(crate) fn build_lettre_message(message: &EmailMessage) -> AppResult<Message> {
    if let Err(msg) = message.validate() {
        return Err(AppError::Validation(msg));
    }

    let from = parse_mailbox(&message.from_email, message.from_name.as_deref())?;
    let to = parse_mailbox(&message.to_email, message.to_name.as_deref())?;

    let mut builder = Message::builder()
        .from(from)
        .to(to)
        .subject(&message.subject);

    if let Some(reply_to) = message.reply_to.as_deref().filter(|s| !s.trim().is_empty()) {
        builder = builder.reply_to(parse_mailbox(reply_to, None)?);
    }

    if let Some(url) = message
        .unsubscribe_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        builder = builder.header(ListUnsubscribe(format!("<{url}>")));
        builder = builder.header(ListUnsubscribePost(
            "List-Unsubscribe=One-Click".to_string(),
        ));
    }
    // Note: additional custom headers are not injected over raw SMTP (lettre
    // requires typed Header types). For advanced needs, use an API provider
    // (Brevo/SendGrid/SES) that forwards them without restriction.

    let body = build_body(message)?;
    builder
        .multipart(body)
        .map_err(|e| AppError::Validation(format!("MIME: {e}")))
}

/// Validates the SMTP config and returns a configured transport that callers
/// can keep alive to reuse the connection pool across many sends.
pub fn build_transport_for(cfg: &ProviderConfig) -> AppResult<AsyncSmtpTransport<Tokio1Executor>> {
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err(AppError::Validation("SMTP host required".into()));
    }
    let port = extract_port(cfg)?;
    let username = cfg.username.trim();
    if username.is_empty() {
        return Err(AppError::Validation("SMTP username required".into()));
    }
    let password = cfg.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation("SMTP password required".into()));
    }
    build_transport(cfg, host, port, username, password)
}

/// Build a configured AsyncSmtpTransport. Encryption resolution rules:
/// - `ssl` / `smtps` / port 465  → implicit TLS (SMTPS)
/// - otherwise                   → STARTTLS
fn build_transport(
    cfg: &ProviderConfig,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> AppResult<AsyncSmtpTransport<Tokio1Executor>> {
    let encryption = cfg.encryption.to_ascii_lowercase();
    let builder = if encryption == "ssl" || encryption == "smtps" || port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .map_err(|e| AppError::Validation(format!("SMTP TLS init: {e}")))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(|e| AppError::Validation(format!("SMTP STARTTLS init: {e}")))?
    };
    Ok(builder
        .port(port)
        .credentials(Credentials::new(username.to_string(), password.to_string()))
        .timeout(Some(Duration::from_secs(45)))
        .build())
}

/// Performs a real SMTP handshake (TCP + TLS + AUTH) without sending any
/// message. Used by the `test_smtp` Tauri command.
pub async fn test_connection(cfg: &ProviderConfig) -> AppResult<serde_json::Value> {
    let transport = build_transport_for(cfg)?;
    let ok = transport
        .test_connection()
        .await
        .map_err(|e| AppError::Validation(format!("SMTP connection: {e}")))?;
    Ok(serde_json::json!({
        "provider": cfg.provider,
        "host": cfg.host.trim(),
        "port": extract_port(cfg).ok(),
        "encryption": cfg.encryption,
        "authenticated": ok,
        "message": if ok { "SMTP/AUTH connection OK" } else { "SMTP connection failed" }
    }))
}

pub(crate) fn extract_port(cfg: &ProviderConfig) -> AppResult<u16> {
    let port_value = &cfg.port;
    let port = match port_value {
        serde_json::Value::Number(n) => n.as_u64().map(|n| n as u16),
        serde_json::Value::String(s) => s.trim().parse::<u16>().ok(),
        _ => None,
    };
    port.filter(|p| *p > 0)
        .ok_or_else(|| AppError::Validation("SMTP port required".into()))
}

fn parse_mailbox(email: &str, name: Option<&str>) -> AppResult<Mailbox> {
    let raw = email.trim();
    // Tolerate a `Display Name <addr@host>` value in the address field: extract
    // the part inside angle brackets and, when no explicit name was given, use
    // the leading text as the display name.
    let (addr_str, embedded_name) = match (raw.rfind('<'), raw.rfind('>')) {
        (Some(lt), Some(gt)) if gt > lt + 1 => {
            let inner = raw[lt + 1..gt].trim().to_string();
            let lead = raw[..lt].trim().trim_matches('"').trim().to_string();
            (inner, if lead.is_empty() { None } else { Some(lead) })
        }
        _ => (raw.to_string(), None),
    };
    let address: Address = addr_str
        .parse()
        .map_err(|e| AppError::Validation(format!("Invalid address '{email}': {e}")))?;
    let display = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(embedded_name);
    Ok(Mailbox::new(display, address))
}

fn build_body(message: &EmailMessage) -> AppResult<MultiPart> {
    let html = message
        .html
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let text = message
        .text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let text_part = text.unwrap_or("");
    let html_part = html.unwrap_or("");

    if !html_part.is_empty() && !text_part.is_empty() {
        Ok(MultiPart::alternative()
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(text_part.to_string()),
            )
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(html_part.to_string()),
            ))
    } else if !html_part.is_empty() {
        Ok(MultiPart::alternative().singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(html_part.to_string()),
        ))
    } else if !text_part.is_empty() {
        Ok(MultiPart::alternative().singlepart(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(text_part.to_string()),
        ))
    } else {
        Err(AppError::Validation(
            "Empty body: neither HTML nor text provided".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mailbox_with_name() {
        let m = parse_mailbox("a@b.com", Some("Alice")).unwrap();
        assert_eq!(m.email.user(), "a");
        assert_eq!(m.email.domain(), "b.com");
        assert_eq!(m.name.as_deref(), Some("Alice"));
    }

    #[test]
    fn parse_mailbox_no_name() {
        let m = parse_mailbox("a@b.com", None).unwrap();
        assert!(m.name.is_none());
    }

    #[test]
    fn parse_mailbox_rejects_invalid() {
        assert!(parse_mailbox("not-an-email", None).is_err());
    }

    #[test]
    fn parse_mailbox_accepts_name_angle_addr() {
        let m = parse_mailbox("Alice Smith <alice@b.com>", None).unwrap();
        assert_eq!(m.email.user(), "alice");
        assert_eq!(m.email.domain(), "b.com");
        assert_eq!(m.name.as_deref(), Some("Alice Smith"));
    }

    #[test]
    fn parse_mailbox_explicit_name_wins_over_embedded() {
        let m = parse_mailbox("Embedded <alice@b.com>", Some("Explicit")).unwrap();
        assert_eq!(m.name.as_deref(), Some("Explicit"));
    }

    #[test]
    fn extract_port_from_number() {
        let cfg = ProviderConfig {
            port: serde_json::json!(465),
            ..Default::default()
        };
        assert_eq!(extract_port(&cfg).unwrap(), 465);
    }

    #[test]
    fn extract_port_from_string() {
        let cfg = ProviderConfig {
            port: serde_json::json!("587"),
            ..Default::default()
        };
        assert_eq!(extract_port(&cfg).unwrap(), 587);
    }

    #[test]
    fn extract_port_rejects_invalid() {
        let cfg = ProviderConfig {
            port: serde_json::json!("oops"),
            ..Default::default()
        };
        assert!(extract_port(&cfg).is_err());
    }
}
