//! SMTP send through a SOCKS5 or HTTP-CONNECT proxy.
//!
//! `lettre` 0.11 owns its TCP socket lifecycle and does not expose a hook for
//! plugging in a custom stream. This module implements just enough of
//! RFC 5321 (+ RFC 3207 STARTTLS, RFC 4954 SASL AUTH) to deliver one message
//! over a stream we control: a `TcpStream`, a `tokio_socks::Socks5Stream` or
//! a `TcpStream` upgraded via HTTP CONNECT. The stream is then optionally
//! wrapped in TLS via `tokio_rustls`.
//!
//! The MIME body itself still comes from `lettre::Message::formatted()` so
//! the header / multipart / encoding logic stays shared with the direct path.

use std::sync::OnceLock;
use std::time::Duration;

use base64::{engine::general_purpose, Engine};
use lettre::address::Envelope;
use rustls::ClientConfig;
use rustls_platform_verifier::ConfigVerifierExt;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;
use tokio_socks::tcp::Socks5Stream;

use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::{EmailMessage, SendResult};
use crate::mailer::proxy::ProxySpec;

/// I/O timeout for each individual SMTP step.
const STEP_TIMEOUT: Duration = Duration::from_secs(45);

/// Trait alias for "an owned async stream we can read, write, send across
/// tasks and box behind `dyn`". Implemented for `TcpStream`, `Socks5Stream`
/// and any `TlsStream<S>` wrapping one of those.
trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStream for T {}

type BoxedStream = Box<dyn AsyncStream>;

/// Send one message over `proxy` using the SMTP credentials in `cfg`. Returns
/// the parsed SMTP response so the campaign engine can attach it to its log.
pub async fn send(
    cfg: &ProviderConfig,
    message: &EmailMessage,
    proxy: &ProxySpec,
) -> AppResult<SendResult> {
    // 1. Validate config the same way mailer::smtp does, before we open any
    //    socket — we want fast feedback for empty fields.
    let host = cfg.host.trim();
    if host.is_empty() {
        return Err(AppError::Validation("SMTP host required".into()));
    }
    let port = crate::mailer::smtp::extract_port(cfg)?;
    let username = cfg.username.trim();
    if username.is_empty() {
        return Err(AppError::Validation("SMTP username required".into()));
    }
    let password = cfg.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation("SMTP password required".into()));
    }

    // 2. Build the lettre Message → envelope (RFC 5321 addresses) + raw MIME
    //    bytes (DATA payload). Mirrors mailer::smtp::send_via byte-for-byte.
    let email = crate::mailer::smtp::build_lettre_message(message)?;
    let envelope = email.envelope().clone();
    let mime_bytes = email.formatted();

    // 3. Open a TCP stream to the target SMTP host through the proxy.
    let stream = connect_through_proxy(proxy, host, port).await?;

    // 4. Optionally wrap in implicit TLS (SMTPS on 465 or encryption=ssl).
    let encryption = cfg.encryption.to_ascii_lowercase();
    let implicit_tls = matches!(encryption.as_str(), "ssl" | "smtps") || port == 465;
    let stream: BoxedStream = if implicit_tls {
        let tls = wrap_tls(stream, host).await?;
        Box::new(tls)
    } else {
        stream
    };

    // 5. Run the SMTP session.
    let response = run_session(
        stream,
        host,
        username,
        password,
        &envelope,
        &mime_bytes,
        !implicit_tls,
        cfg.provider.clone(),
    )
    .await?;

    Ok(response)
}

// ---------------------------------------------------------------------------
// Proxy connect
// ---------------------------------------------------------------------------

async fn connect_through_proxy(
    proxy: &ProxySpec,
    target_host: &str,
    target_port: u16,
) -> AppResult<BoxedStream> {
    let url = url::Url::parse(&proxy.url)
        .map_err(|e| AppError::Validation(format!("invalid proxy URL: {e}")))?;
    let proxy_host = url
        .host_str()
        .ok_or_else(|| AppError::Validation("proxy without host".into()))?
        .to_string();
    let proxy_port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::Validation("proxy without port".into()))?;
    let user = url.username().to_string();
    let pass = url.password().unwrap_or("").to_string();

    match proxy.scheme.as_str() {
        "socks5" | "socks5h" => {
            let target = (target_host, target_port);
            let stream = if !user.is_empty() {
                Socks5Stream::connect_with_password(
                    (proxy_host.as_str(), proxy_port),
                    target,
                    &user,
                    &pass,
                )
                .await
                .map_err(|e| AppError::Security(format!("SOCKS5 connect: {e}")))?
            } else {
                Socks5Stream::connect((proxy_host.as_str(), proxy_port), target)
                    .await
                    .map_err(|e| AppError::Security(format!("SOCKS5 connect: {e}")))?
            };
            Ok(Box::new(stream))
        }
        "http" | "https" => {
            let stream = http_connect(
                proxy_host.as_str(),
                proxy_port,
                target_host,
                target_port,
                &user,
                &pass,
            )
            .await?;
            Ok(Box::new(stream))
        }
        other => Err(AppError::Validation(format!(
            "proxy scheme not supported for SMTP: {other}"
        ))),
    }
}

/// Open a TCP connection to `proxy_host:proxy_port` and issue an HTTP CONNECT
/// to tunnel TCP to `target_host:target_port`. Returns the upgraded stream.
async fn http_connect(
    proxy_host: &str,
    proxy_port: u16,
    target_host: &str,
    target_port: u16,
    user: &str,
    pass: &str,
) -> AppResult<TcpStream> {
    let stream = timeout(
        Duration::from_secs(30),
        TcpStream::connect((proxy_host, proxy_port)),
    )
    .await
    .map_err(|_| AppError::Security("proxy connect timeout".into()))?
    .map_err(|e| AppError::Security(format!("proxy connect: {e}")))?;
    let _ = stream.set_nodelay(true);

    let mut req = format!("CONNECT {target_host}:{target_port} HTTP/1.1\r\n");
    req.push_str(&format!("Host: {target_host}:{target_port}\r\n"));
    if !user.is_empty() {
        let auth = general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {auth}\r\n"));
    }
    req.push_str("Proxy-Connection: keep-alive\r\n\r\n");

    let mut reader = BufReader::new(stream);
    {
        let inner = reader.get_mut();
        timeout(Duration::from_secs(30), inner.write_all(req.as_bytes()))
            .await
            .map_err(|_| AppError::Security("CONNECT write timeout".into()))?
            .map_err(|e| AppError::Security(format!("CONNECT write: {e}")))?;
        inner
            .flush()
            .await
            .map_err(|e| AppError::Security(format!("CONNECT flush: {e}")))?;
    }

    let mut status = String::new();
    timeout(Duration::from_secs(30), reader.read_line(&mut status))
        .await
        .map_err(|_| AppError::Security("CONNECT response timeout".into()))?
        .map_err(|e| AppError::Security(format!("CONNECT read: {e}")))?;
    if !status.contains(" 200 ") {
        return Err(AppError::Security(format!(
            "proxy CONNECT refused: {}",
            status.trim()
        )));
    }
    // Consume the remaining header lines until the empty line.
    loop {
        let mut line = String::new();
        let n = timeout(Duration::from_secs(30), reader.read_line(&mut line))
            .await
            .map_err(|_| AppError::Security("CONNECT headers timeout".into()))?
            .map_err(|e| AppError::Security(format!("CONNECT header: {e}")))?;
        if n == 0 || matches!(line.as_str(), "\r\n" | "\n") {
            break;
        }
    }
    Ok(reader.into_inner())
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

fn tls_config() -> AppResult<std::sync::Arc<ClientConfig>> {
    static TLS_CFG: OnceLock<std::sync::Arc<ClientConfig>> = OnceLock::new();
    if let Some(cfg) = TLS_CFG.get() {
        return Ok(cfg.clone());
    }
    // Install the ring crypto provider on first call. Idempotent: if another
    // crate already installed it, the call is a no-op and returns Err.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = ClientConfig::with_platform_verifier()
        .map_err(|e| AppError::Security(format!("TLS config: {e}")))?;
    let arc = std::sync::Arc::new(cfg);
    // OnceLock::set may fail if another task initialised first — that's fine.
    let _ = TLS_CFG.set(arc.clone());
    Ok(arc)
}

async fn wrap_tls<S>(stream: S, host: &str) -> AppResult<tokio_rustls::client::TlsStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let connector = TlsConnector::from(tls_config()?);
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|e| AppError::Validation(format!("invalid TLS server name: {e}")))?;
    timeout(STEP_TIMEOUT, connector.connect(server_name, stream))
        .await
        .map_err(|_| AppError::Security("TLS handshake timeout".into()))?
        .map_err(|e| AppError::Security(format!("TLS handshake: {e}")))
}

// ---------------------------------------------------------------------------
// SMTP session
// ---------------------------------------------------------------------------

const EHLO_DOMAIN: &str = "winmail.local";

#[allow(clippy::too_many_arguments)]
async fn run_session(
    stream: BoxedStream,
    host: &str,
    username: &str,
    password: &str,
    envelope: &Envelope,
    raw_body: &[u8],
    use_starttls: bool,
    provider_name: String,
) -> AppResult<SendResult> {
    // Initial greeting
    let mut conn = SmtpConn::new(stream);
    conn.expect_2xx().await?;

    // First EHLO
    let ehlo_cmd = format!("EHLO {EHLO_DOMAIN}");
    conn.write_command(&ehlo_cmd).await?;
    let (_code, ehlo_response) = conn.read_response().await?;
    if !ehlo_response.starts_with('2') {
        return Err(AppError::Security(format!(
            "EHLO refused: {}",
            ehlo_response.trim()
        )));
    }

    // STARTTLS upgrade (if requested and supported)
    let (mut conn, ehlo_response) =
        if use_starttls && ehlo_response.to_ascii_uppercase().contains("STARTTLS") {
            conn.write_command("STARTTLS").await?;
            conn.expect_2xx().await?;
            let inner = conn.into_inner();
            let tls = wrap_tls(inner, host).await?;
            let mut tls_conn = SmtpConn::new(Box::new(tls) as BoxedStream);
            tls_conn.write_command(&ehlo_cmd).await?;
            let (_code, response) = tls_conn.read_response().await?;
            if !response.starts_with('2') {
                return Err(AppError::Security(format!(
                    "post-TLS EHLO refused: {}",
                    response.trim()
                )));
            }
            (tls_conn, response)
        } else {
            (conn, ehlo_response)
        };

    // Authentication. We pick the SASL mechanism advertised by the server.
    authenticate(&mut conn, username, password, &ehlo_response).await?;

    // MAIL FROM
    let from_str = envelope
        .from()
        .map(|a| a.to_string())
        .unwrap_or_else(|| username.to_string());
    conn.write_command(&format!("MAIL FROM:<{from_str}>"))
        .await?;
    conn.expect_2xx().await?;

    // RCPT TO (envelope may carry multiple recipients in theory)
    for rcpt in envelope.to() {
        conn.write_command(&format!("RCPT TO:<{}>", rcpt)).await?;
        conn.expect_2xx().await?;
    }

    // DATA
    conn.write_command("DATA").await?;
    let (code, _) = conn.read_response().await?;
    if code != 354 {
        return Err(AppError::Security(format!("DATA refused ({code})")));
    }
    let payload = dot_stuff_and_terminate(raw_body);
    conn.write_bytes(&payload).await?;
    let (final_code, final_response) = conn.read_response().await?;
    if !(200..300).contains(&final_code) {
        return Err(AppError::Security(format!(
            "DATA result {final_code}: {}",
            final_response.trim()
        )));
    }

    // QUIT (best-effort)
    let _ = conn.write_command("QUIT").await;
    let _ = conn.read_response().await;

    Ok(SendResult {
        provider: provider_name,
        message_id: extract_queued_id(&final_response),
        raw: Some(serde_json::json!({
            "code": final_code.to_string(),
            "message": final_response.trim()
        })),
    })
}

async fn authenticate(
    conn: &mut SmtpConn,
    username: &str,
    password: &str,
    ehlo_response: &str,
) -> AppResult<()> {
    let upper = ehlo_response.to_ascii_uppercase();
    let auth_line = upper
        .lines()
        .find(|l| l.contains("AUTH "))
        .unwrap_or_default();
    let supports = |m: &str| auth_line.contains(m);

    if supports("LOGIN") {
        conn.write_command("AUTH LOGIN").await?;
        let (code, _) = conn.read_response().await?;
        if code != 334 {
            return Err(AppError::Security(format!("AUTH LOGIN refused ({code})")));
        }
        conn.write_command(&general_purpose::STANDARD.encode(username))
            .await?;
        let (code, _) = conn.read_response().await?;
        if code != 334 {
            return Err(AppError::Security(format!(
                "AUTH LOGIN: username refused ({code})"
            )));
        }
        conn.write_command(&general_purpose::STANDARD.encode(password))
            .await?;
        let (code, response) = conn.read_response().await?;
        if code != 235 {
            return Err(AppError::Security(format!(
                "AUTH LOGIN failed ({code}): {}",
                response.trim()
            )));
        }
        Ok(())
    } else if supports("PLAIN") {
        let token = general_purpose::STANDARD.encode(format!("\0{username}\0{password}"));
        conn.write_command(&format!("AUTH PLAIN {token}")).await?;
        let (code, response) = conn.read_response().await?;
        if code != 235 {
            return Err(AppError::Security(format!(
                "AUTH PLAIN failed ({code}): {}",
                response.trim()
            )));
        }
        Ok(())
    } else {
        Err(AppError::Security(
            "server advertised no compatible AUTH method (LOGIN/PLAIN)".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/// Tiny wrapper around a buffered stream that knows how to issue an SMTP
/// command + parse a (possibly multi-line) reply.
struct SmtpConn {
    reader: BufReader<BoxedStream>,
}

impl SmtpConn {
    fn new(stream: BoxedStream) -> Self {
        Self {
            reader: BufReader::new(stream),
        }
    }

    fn into_inner(self) -> BoxedStream {
        self.reader.into_inner()
    }

    async fn write_command(&mut self, cmd: &str) -> AppResult<()> {
        let stream = self.reader.get_mut();
        timeout(STEP_TIMEOUT, async {
            stream.write_all(cmd.as_bytes()).await?;
            stream.write_all(b"\r\n").await?;
            stream.flush().await?;
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(|_| AppError::Security("SMTP write timeout".into()))?
        .map_err(|e| AppError::Security(format!("SMTP write: {e}")))
    }

    async fn write_bytes(&mut self, data: &[u8]) -> AppResult<()> {
        let stream = self.reader.get_mut();
        timeout(STEP_TIMEOUT, async {
            stream.write_all(data).await?;
            stream.flush().await?;
            Ok::<_, std::io::Error>(())
        })
        .await
        .map_err(|_| AppError::Security("SMTP DATA write timeout".into()))?
        .map_err(|e| AppError::Security(format!("SMTP DATA write: {e}")))
    }

    async fn read_response(&mut self) -> AppResult<(u16, String)> {
        let mut full = String::new();
        let code;
        loop {
            let mut line = String::new();
            let n = timeout(STEP_TIMEOUT, self.reader.read_line(&mut line))
                .await
                .map_err(|_| AppError::Security("SMTP read timeout".into()))?
                .map_err(|e| AppError::Security(format!("SMTP read: {e}")))?;
            if n == 0 {
                return Err(AppError::Security("SMTP connection closed".into()));
            }
            if line.len() < 4 {
                return Err(AppError::Security(format!(
                    "invalid SMTP line: {}",
                    line.trim()
                )));
            }
            let parsed = line[..3]
                .parse::<u16>()
                .map_err(|_| AppError::Security(format!("invalid SMTP code: {}", &line[..3])))?;
            let sep = line.as_bytes()[3];
            full.push_str(&line);
            // RFC 5321: '-' on the 4th char means more lines follow, ' ' means
            // this is the last line of the reply.
            if sep == b' ' {
                code = parsed;
                break;
            }
        }
        Ok((code, full))
    }

    async fn expect_2xx(&mut self) -> AppResult<(u16, String)> {
        let (code, response) = self.read_response().await?;
        if !(200..300).contains(&code) {
            return Err(AppError::Security(format!(
                "SMTP {code}: {}",
                response.trim()
            )));
        }
        Ok((code, response))
    }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/// Apply RFC 5321 §4.5.2 dot-stuffing to the DATA payload and append the
/// `\r\n.\r\n` terminator. Any line that already starts with `.` is prefixed
/// with another `.`; the body is normalized to CRLF before the terminator.
fn dot_stuff_and_terminate(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + 16);
    let mut at_line_start = true;
    for &b in raw {
        if at_line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        at_line_start = b == b'\n';
    }
    // Make sure we end with CRLF before the terminator.
    if !out.ends_with(b"\r\n") {
        if out.ends_with(b"\n") {
            out.pop();
            out.extend_from_slice(b"\r\n");
        } else {
            out.extend_from_slice(b"\r\n");
        }
    }
    out.extend_from_slice(b".\r\n");
    out
}

/// Pull the message id out of a `250 ... queued as ABC123` response when the
/// server provides one. Falls back to the last token of the response.
fn extract_queued_id(response: &str) -> Option<String> {
    let trimmed = response.trim();
    if let Some(idx) = trimmed.to_ascii_lowercase().rfind("queued as ") {
        let rest = &trimmed[idx + "queued as ".len()..];
        let id = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    trimmed.split_whitespace().last().map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_stuffs_dots_at_line_starts() {
        let raw = b"hello\r\n.world\r\nmore\r\n";
        let out = dot_stuff_and_terminate(raw);
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "hello\r\n..world\r\nmore\r\n.\r\n");
    }

    #[test]
    fn dot_stuffs_leading_dot() {
        let raw = b".hidden";
        let out = dot_stuff_and_terminate(raw);
        let s = String::from_utf8(out).unwrap();
        // Leading "." is doubled, CRLF added before terminator.
        assert_eq!(s, "..hidden\r\n.\r\n");
    }

    #[test]
    fn dot_stuff_normalizes_lf_only() {
        let raw = b"line1\nline2\n";
        let out = dot_stuff_and_terminate(raw);
        let s = String::from_utf8(out).unwrap();
        assert!(s.ends_with("\r\n.\r\n"));
    }

    #[test]
    fn extract_queued_id_parses_postfix_form() {
        let r = "250 2.0.0 Ok: queued as 9C0F4A4001E";
        assert_eq!(extract_queued_id(r), Some("9C0F4A4001E".to_string()));
    }

    #[test]
    fn extract_queued_id_falls_back_to_last_token() {
        let r = "250 OK ABC123";
        assert_eq!(extract_queued_id(r), Some("ABC123".to_string()));
    }

    // ----------------------------------------------------------------
    //  End-to-end integration tests
    // ----------------------------------------------------------------
    //
    // These spin up a tiny in-process SOCKS5 server + a tiny in-process SMTP
    // server, and run the full client through them. No TLS is exercised here
    // (those paths are covered by their respective crates) but the whole
    // RFC 5321 dialog, the SOCKS5 handshake and the HTTP CONNECT request are
    // hit on real sockets.

    use tokio::io::AsyncReadExt as _;
    use tokio::net::TcpListener;

    /// Minimal SOCKS5 server that accepts "no authentication" requests and
    /// connects the client to the requested target. Returns the listen port.
    async fn spawn_socks5_no_auth() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut client, _) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                tokio::spawn(async move {
                    // Greeting: ver=5, nmethods=N, methods
                    let mut hdr = [0u8; 2];
                    if client.read_exact(&mut hdr).await.is_err() {
                        return;
                    }
                    let nmethods = hdr[1] as usize;
                    let mut methods = vec![0u8; nmethods];
                    if client.read_exact(&mut methods).await.is_err() {
                        return;
                    }
                    // Pick "no auth" (0x00)
                    let _ = client.write_all(&[0x05, 0x00]).await;

                    // Request: ver=5, cmd=1(connect), rsv=0, atyp, addr, port
                    let mut req = [0u8; 4];
                    if client.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let atyp = req[3];
                    let host: String = match atyp {
                        0x01 => {
                            let mut b = [0u8; 4];
                            client.read_exact(&mut b).await.unwrap();
                            format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
                        }
                        0x03 => {
                            let mut len = [0u8; 1];
                            client.read_exact(&mut len).await.unwrap();
                            let mut name = vec![0u8; len[0] as usize];
                            client.read_exact(&mut name).await.unwrap();
                            String::from_utf8(name).unwrap()
                        }
                        _ => return,
                    };
                    let mut p = [0u8; 2];
                    client.read_exact(&mut p).await.unwrap();
                    let port = u16::from_be_bytes(p);

                    // Connect to the real target.
                    let target = match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                        Ok(t) => t,
                        Err(_) => {
                            let _ = client
                                .write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                                .await;
                            return;
                        }
                    };
                    // Reply: success
                    let _ = client
                        .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                        .await;

                    // Splice both halves.
                    let (mut cr, mut cw) = client.into_split();
                    let (mut tr, mut tw) = target.into_split();
                    let _ = tokio::join!(
                        tokio::io::copy(&mut cr, &mut tw),
                        tokio::io::copy(&mut tr, &mut cw),
                    );
                });
            }
        });
        port
    }

    /// Minimal SMTP server that accepts AUTH LOGIN with any credentials,
    /// returns 250 for everything and 250 "queued as TESTID" after DATA.
    /// Captures the raw DATA payload in `captured` for the test to inspect.
    async fn spawn_fake_smtp(captured: std::sync::Arc<tokio::sync::Mutex<Vec<u8>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            sock.write_all(b"220 fake.smtp ESMTP ready\r\n")
                .await
                .unwrap();
            let (rd, mut wr) = sock.split();
            let mut reader = tokio::io::BufReader::new(rd);
            let mut in_data = false;
            let mut data_buf: Vec<u8> = Vec::new();
            loop {
                let mut line = String::new();
                let n = reader.read_line(&mut line).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                if in_data {
                    if line == ".\r\n" || line == ".\n" {
                        captured.lock().await.extend_from_slice(&data_buf);
                        wr.write_all(b"250 2.0.0 Ok: queued as TESTID-42\r\n")
                            .await
                            .unwrap();
                        in_data = false;
                        continue;
                    }
                    data_buf.extend_from_slice(line.as_bytes());
                    continue;
                }
                let upper = line.trim_end().to_ascii_uppercase();
                if upper.starts_with("EHLO") {
                    wr.write_all(b"250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n")
                        .await
                        .unwrap();
                } else if upper == "AUTH LOGIN" {
                    wr.write_all(b"334 VXNlcm5hbWU6\r\n").await.unwrap();
                    let mut u = String::new();
                    reader.read_line(&mut u).await.unwrap();
                    wr.write_all(b"334 UGFzc3dvcmQ6\r\n").await.unwrap();
                    let mut p = String::new();
                    reader.read_line(&mut p).await.unwrap();
                    wr.write_all(b"235 2.7.0 Authentication successful\r\n")
                        .await
                        .unwrap();
                } else if upper.starts_with("MAIL FROM") || upper.starts_with("RCPT TO") {
                    wr.write_all(b"250 2.1.0 Ok\r\n").await.unwrap();
                } else if upper == "DATA" {
                    wr.write_all(b"354 End data with <CR><LF>.<CR><LF>\r\n")
                        .await
                        .unwrap();
                    in_data = true;
                } else if upper == "QUIT" {
                    let _ = wr.write_all(b"221 Bye\r\n").await;
                    return;
                } else {
                    wr.write_all(b"502 Command not implemented\r\n")
                        .await
                        .unwrap();
                }
            }
        });
        port
    }

    /// Minimal HTTP-CONNECT proxy. Reads the CONNECT request line, parses the
    /// target, then splices the two connections.
    async fn spawn_http_connect_proxy() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (client, _) = match listener.accept().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                tokio::spawn(async move {
                    let (rd, mut wr) = client.into_split();
                    let mut reader = tokio::io::BufReader::new(rd);
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).await.is_err() {
                        return;
                    }
                    // Drain headers up to blank line.
                    loop {
                        let mut line = String::new();
                        let n = reader.read_line(&mut line).await.unwrap_or(0);
                        if n == 0 || matches!(line.as_str(), "\r\n" | "\n") {
                            break;
                        }
                    }
                    // Parse "CONNECT host:port HTTP/1.1"
                    let target = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .to_string();
                    let Some((host, port_str)) = target.rsplit_once(':') else {
                        let _ = wr.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
                        return;
                    };
                    let port: u16 = match port_str.parse() {
                        Ok(p) => p,
                        Err(_) => {
                            let _ = wr.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
                            return;
                        }
                    };
                    let target = match tokio::net::TcpStream::connect((host, port)).await {
                        Ok(s) => s,
                        Err(_) => {
                            let _ = wr.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                            return;
                        }
                    };
                    if wr
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .is_err()
                    {
                        return;
                    }
                    let (mut tr, mut tw) = target.into_split();
                    let mut cr = reader.into_inner();
                    let _ = tokio::join!(
                        tokio::io::copy(&mut cr, &mut tw),
                        tokio::io::copy(&mut tr, &mut wr),
                    );
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn end_to_end_send_via_http_connect_proxy() {
        let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<u8>::new()));
        let smtp_port = spawn_fake_smtp(captured.clone()).await;
        let http_port = spawn_http_connect_proxy().await;

        let cfg = ProviderConfig {
            provider: "smtp".into(),
            host: "127.0.0.1".into(),
            port: serde_json::json!(smtp_port),
            username: "alice".into(),
            password: "swordfish".into(),
            encryption: "none".into(),
            ..Default::default()
        };
        let message = EmailMessage {
            from_email: "alice@example.com".into(),
            to_email: "bob@example.org".into(),
            subject: "hi via http connect".into(),
            text: Some("plain text body".into()),
            ..Default::default()
        };
        let proxy = ProxySpec::parse(&format!("http://127.0.0.1:{http_port}")).unwrap();

        let result = tokio::time::timeout(Duration::from_secs(10), send(&cfg, &message, &proxy))
            .await
            .expect("send must not time out")
            .expect("send must succeed");
        assert_eq!(result.message_id.as_deref(), Some("TESTID-42"));

        let captured = captured.lock().await;
        let body = String::from_utf8_lossy(&captured);
        assert!(body.contains("Subject: hi via http connect"), "{body}");
    }

    #[tokio::test]
    async fn end_to_end_send_via_socks5_proxy() {
        let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<u8>::new()));
        let smtp_port = spawn_fake_smtp(captured.clone()).await;
        let socks_port = spawn_socks5_no_auth().await;

        let cfg = ProviderConfig {
            provider: "smtp".into(),
            host: "127.0.0.1".into(),
            port: serde_json::json!(smtp_port),
            username: "user".into(),
            password: "pass".into(),
            encryption: "none".into(), // no STARTTLS in this test
            ..Default::default()
        };
        let message = EmailMessage {
            from_email: "alice@example.com".into(),
            from_name: Some("Alice".into()),
            to_email: "bob@example.org".into(),
            subject: "hi via proxy".into(),
            html: None,
            text: Some("body line\n.dot line at start\nend\n".into()),
            ..Default::default()
        };
        let proxy = ProxySpec::parse(&format!("socks5://127.0.0.1:{socks_port}")).unwrap();

        let result = tokio::time::timeout(Duration::from_secs(10), send(&cfg, &message, &proxy))
            .await
            .expect("send must not time out")
            .expect("send must succeed");
        assert_eq!(result.message_id.as_deref(), Some("TESTID-42"));

        let captured = captured.lock().await;
        let body = String::from_utf8_lossy(&captured);
        // lettre only quotes display names when they contain reserved chars.
        assert!(
            body.contains("From: Alice <alice@example.com>")
                || body.contains("From: \"Alice\" <alice@example.com>"),
            "From header missing in DATA payload: {body}"
        );
        assert!(
            body.contains("To: bob@example.org"),
            "To header missing: {body}"
        );
        assert!(
            body.contains("Subject: hi via proxy"),
            "Subject header missing: {body}"
        );
        // The server strips one leading dot per RFC 5321 §4.5.2, leaving the
        // "dot line at start" intact when the client correctly dot-stuffs.
        assert!(
            body.contains("dot line at start"),
            "DATA body missing or not properly dot-stuffed: {body}"
        );
    }
}
