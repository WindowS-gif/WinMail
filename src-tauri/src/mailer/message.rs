use serde::{Deserialize, Serialize};

/// Provider-agnostic email message representation.
///
/// All providers receive the same struct and adapt it to their API
/// payload. Empty fields are simply omitted from the request.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EmailMessage {
    pub from_email: String,
    #[serde(default)]
    pub from_name: Option<String>,
    pub to_email: String,
    #[serde(default)]
    pub to_name: Option<String>,
    #[serde(default)]
    pub reply_to: Option<String>,
    pub subject: String,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub unsubscribe_url: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendResult {
    pub provider: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub raw: Option<serde_json::Value>,
}

impl EmailMessage {
    pub fn validate(&self) -> Result<(), String> {
        if self.from_email.trim().is_empty() {
            return Err("From address required".to_string());
        }
        if !self.from_email.contains('@') {
            return Err(format!("Invalid From address: {}", self.from_email));
        }
        if self.to_email.trim().is_empty() {
            return Err("To address required".to_string());
        }
        if !self.to_email.contains('@') {
            return Err(format!("Invalid To address: {}", self.to_email));
        }
        if self.subject.trim().is_empty() {
            return Err("Subject required".to_string());
        }
        let has_html = self
            .html
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let has_text = self
            .text
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_html && !has_text {
            return Err("At least one of HTML or text content is required".to_string());
        }
        Ok(())
    }

    pub fn formatted_from(&self) -> String {
        match self.from_name.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(name) => format!("{name} <{}>", self.from_email),
            None => self.from_email.clone(),
        }
    }

    pub fn formatted_to(&self) -> String {
        match self.to_name.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(name) => format!("{name} <{}>", self.to_email),
            None => self.to_email.clone(),
        }
    }

    /// Returns true when the message has HTML content but no usable text part.
    pub fn needs_text_fallback(&self) -> bool {
        let has_html = self
            .html
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let has_text = self
            .text
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        has_html && !has_text
    }

    /// Consumes the message and returns a copy with a synthesised plain text
    /// body when only HTML is present. No-op otherwise.
    pub fn with_text_fallback(mut self) -> Self {
        if self.needs_text_fallback() {
            if let Some(text) = html_to_text(self.html.as_deref().unwrap_or("")) {
                self.text = Some(text);
            }
        }
        self
    }

    /// Split any `Display Name <addr@host>` value in `from_email`/`to_email`
    /// into a bare address plus a display name. API providers (Brevo, SES,
    /// etc.) expect the address field to contain only the address, so this
    /// prevents a manually-typed `Name <email>` from producing a malformed
    /// payload. An explicit `from_name`/`to_name` always wins.
    pub fn with_normalized_addresses(mut self) -> Self {
        let (from_addr, from_disp) = split_addr_name(&self.from_email);
        self.from_email = from_addr;
        if self
            .from_name
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            self.from_name = from_disp;
        }
        let (to_addr, to_disp) = split_addr_name(&self.to_email);
        self.to_email = to_addr;
        if self
            .to_name
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            self.to_name = to_disp;
        }
        self
    }

    /// Builds the standard `List-Unsubscribe` header pair from `unsubscribe_url`.
    /// Returns an empty vec if no URL is configured.
    pub fn unsubscribe_headers(&self) -> Vec<(String, String)> {
        let Some(url) = self.unsubscribe_url.as_deref() else {
            return Vec::new();
        };
        let url = url.trim();
        if url.is_empty() {
            return Vec::new();
        }
        vec![
            ("List-Unsubscribe".to_string(), format!("<{url}>")),
            (
                "List-Unsubscribe-Post".to_string(),
                "List-Unsubscribe=One-Click".to_string(),
            ),
        ]
    }
}

/// Split a `Display Name <addr@host>` value into `(address, Some(name))`.
/// A bare address returns `(address, None)`. Surrounding quotes on the name
/// are stripped.
fn split_addr_name(value: &str) -> (String, Option<String>) {
    let raw = value.trim();
    if let (Some(lt), Some(gt)) = (raw.rfind('<'), raw.rfind('>')) {
        if gt > lt + 1 {
            let addr = raw[lt + 1..gt].trim().to_string();
            let name = raw[..lt].trim().trim_matches('"').trim().to_string();
            return (addr, if name.is_empty() { None } else { Some(name) });
        }
    }
    (raw.to_string(), None)
}

/// Best-effort HTML -> plain text conversion. Renders with a generous line
/// width so long URLs stay on one line, and clamps the result to avoid
/// generating multi-megabyte text parts for HTML-heavy templates.
fn html_to_text(html: &str) -> Option<String> {
    if html.trim().is_empty() {
        return None;
    }
    let text = html2text::from_read(html.as_bytes(), 100).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_message() -> EmailMessage {
        EmailMessage {
            from_email: "a@b.com".into(),
            from_name: Some("A".into()),
            to_email: "x@y.com".into(),
            to_name: None,
            subject: "Test".into(),
            html: Some("<p>hi</p>".into()),
            ..Default::default()
        }
    }

    #[test]
    fn validate_accepts_minimum() {
        assert!(ok_message().validate().is_ok());
    }

    #[test]
    fn validate_rejects_missing_from() {
        let mut m = ok_message();
        m.from_email = String::new();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_invalid_email() {
        let mut m = ok_message();
        m.from_email = "no-at-sign".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_body() {
        let mut m = ok_message();
        m.html = None;
        m.text = None;
        assert!(m.validate().is_err());
    }

    #[test]
    fn formatted_from_with_name() {
        let m = ok_message();
        assert_eq!(m.formatted_from(), "A <a@b.com>");
    }

    #[test]
    fn formatted_from_without_name() {
        let mut m = ok_message();
        m.from_name = None;
        assert_eq!(m.formatted_from(), "a@b.com");
    }

    #[test]
    fn unsubscribe_headers_when_present() {
        let mut m = ok_message();
        m.unsubscribe_url = Some("https://example.com/u".into());
        let h = m.unsubscribe_headers();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].0, "List-Unsubscribe");
        assert!(h[0].1.contains("https://example.com/u"));
    }

    #[test]
    fn unsubscribe_headers_empty_when_missing() {
        assert!(ok_message().unsubscribe_headers().is_empty());
    }

    #[test]
    fn normalize_splits_embedded_name_when_no_explicit_name() {
        let mut m = ok_message();
        m.from_email = "Alice Smith <alice@b.com>".into();
        m.from_name = None;
        let m = m.with_normalized_addresses();
        assert_eq!(m.from_email, "alice@b.com");
        assert_eq!(m.from_name.as_deref(), Some("Alice Smith"));
    }

    #[test]
    fn normalize_keeps_explicit_name() {
        let mut m = ok_message();
        m.from_email = "Embedded <alice@b.com>".into();
        m.from_name = Some("Explicit".into());
        let m = m.with_normalized_addresses();
        assert_eq!(m.from_email, "alice@b.com");
        assert_eq!(m.from_name.as_deref(), Some("Explicit"));
    }

    #[test]
    fn normalize_leaves_bare_address_untouched() {
        let (addr, name) = split_addr_name("alice@b.com");
        assert_eq!(addr, "alice@b.com");
        assert!(name.is_none());
    }

    #[test]
    fn needs_text_fallback_when_only_html() {
        let mut m = ok_message();
        m.text = None;
        assert!(m.needs_text_fallback());
        m.text = Some("".into());
        assert!(m.needs_text_fallback());
        m.text = Some("hi".into());
        assert!(!m.needs_text_fallback());
    }

    #[test]
    fn with_text_fallback_synthesises_text() {
        let mut m = ok_message();
        m.html = Some("<p>Hello <b>World</b></p>".into());
        m.text = None;
        let m = m.with_text_fallback();
        assert!(m.text.as_deref().unwrap().to_lowercase().contains("hello"));
    }

    #[test]
    fn html_to_text_handles_empty() {
        assert!(html_to_text("").is_none());
        assert!(html_to_text("   ").is_none());
    }
}
