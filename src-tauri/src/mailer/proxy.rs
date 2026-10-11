//! Per-campaign proxy support.
//!
//! Each campaign may enable proxies (HTTP / HTTPS / SOCKS5). We accept three
//! input formats so users can paste from proxy provider exports directly:
//!
//! - `scheme://[user:pass@]host:port`   (canonical URL)
//! - `host:port`                        (defaults to `http://`)
//! - `host:port:user:pass`              (defaults to `http://`)
//!
//! The [`ProxyPool`] handles rotation and an optional per-proxy rate limit
//! (e.g. "30 sends per minute, per proxy"). When all proxies hit their window
//! quota, [`ProxyPool::acquire`] sleeps until the earliest slot frees up so
//! the send loop stays compliant without the campaign engine needing to
//! coordinate anything.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::{Client, Proxy};
use tokio::sync::Mutex;

use crate::core::error::{AppError, AppResult};

const REQUEST_TIMEOUT_SECS: u64 = 30;

/// A validated proxy specification accepted by the engine.
#[derive(Debug, Clone)]
pub struct ProxySpec {
    /// Final canonical URL (always has a scheme).
    pub url: String,
    /// Scheme: `http`, `https`, `socks5`, `socks5h`.
    pub scheme: String,
    /// Host[:port] for display, no credentials.
    pub host_port: String,
    /// True if the URL embedded credentials.
    pub has_auth: bool,
}

impl ProxySpec {
    /// Parse a single proxy input. Accepts URL form, `host:port` and
    /// `host:port:user:pass` shortcuts.
    pub fn parse(input: &str) -> AppResult<Self> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation("Empty proxy entry".into()));
        }
        let normalized = if trimmed.contains("://") {
            trimmed.to_string()
        } else {
            normalize_short_form(trimmed)?
        };
        let url = url::Url::parse(&normalized)
            .map_err(|e| AppError::Validation(format!("invalid proxy URL '{trimmed}': {e}")))?;
        let scheme = url.scheme().to_ascii_lowercase();
        match scheme.as_str() {
            "http" | "https" | "socks5" | "socks5h" => {}
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported proxy scheme '{other}': use http, https, socks5 or socks5h"
                )))
            }
        }
        let host = url
            .host_str()
            .ok_or_else(|| AppError::Validation(format!("proxy without host: {trimmed}")))?
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| AppError::Validation(format!("proxy without port: {trimmed}")))?;
        let has_auth = !url.username().is_empty() || url.password().is_some();
        Ok(Self {
            url: url.to_string(),
            scheme,
            host_port: format!("{host}:{port}"),
            has_auth,
        })
    }

    /// Human label with credentials redacted. Safe to log.
    pub fn label(&self) -> String {
        if self.has_auth {
            format!("{}://***@{}", self.scheme, self.host_port)
        } else {
            format!("{}://{}", self.scheme, self.host_port)
        }
    }
}

fn normalize_short_form(input: &str) -> AppResult<String> {
    let parts: Vec<&str> = input.split(':').collect();
    match parts.len() {
        2 => Ok(format!("http://{}:{}", parts[0], parts[1])),
        4 => Ok(format!(
            "http://{user}:{pass}@{host}:{port}",
            host = parts[0],
            port = parts[1],
            user = parts[2],
            pass = parts[3],
        )),
        _ => Err(AppError::Validation(format!(
            "unrecognised proxy '{input}' (expected: scheme://host:port, host:port or host:port:user:pass)"
        ))),
    }
}

/// Parse a textarea-style multi-line list. Empty lines and lines starting
/// with `#` are ignored. Returns (specs, per-line errors).
pub fn parse_many(input: &str) -> (Vec<ProxySpec>, Vec<String>) {
    let mut specs = Vec::new();
    let mut errors = Vec::new();
    for raw in input.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match ProxySpec::parse(line) {
            Ok(spec) => specs.push(spec),
            Err(err) => errors.push(format!("{line}: {err}")),
        }
    }
    (specs, errors)
}

/// Build a `reqwest::Client` routing every request through `spec`. Uses the
/// same defaults as the global HTTP client (rustls, 30s timeout, WinMail UA).
pub fn build_client(spec: &ProxySpec) -> AppResult<Client> {
    let proxy = Proxy::all(spec.url.as_str())
        .map_err(|e| AppError::Validation(format!("Proxy '{}': {e}", spec.label())))?;
    Client::builder()
        .user_agent("WinMail/0.1 (rust)")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .proxy(proxy)
        .build()
        .map_err(|e| AppError::Security(format!("reqwest client init (proxy): {e}")))
}

/// Optional rate limit shared by every proxy in a [`ProxyPool`].
#[derive(Debug, Clone, Copy)]
pub struct RateLimit {
    pub max_uses: usize,
    pub window: Duration,
}

#[derive(Debug, Default)]
struct ProxyUsage {
    /// Monotonic-clock timestamps of recent uses still within the window.
    uses: VecDeque<Instant>,
    /// Total uses since start (for stats/logs).
    total_uses: u64,
}

#[derive(Debug, Default)]
struct PoolInner {
    state: Vec<ProxyUsage>,
}

/// Owns the proxy rotation, per-proxy rate limiter and cached reqwest clients.
pub struct ProxyPool {
    proxies: Vec<ProxySpec>,
    rotation_every: usize,
    rate_limit: Option<RateLimit>,
    state: Mutex<PoolInner>,
    clients: Mutex<HashMap<String, Arc<Client>>>,
}

/// Outcome of an [`acquire`] call.
#[derive(Debug, Clone)]
pub struct ProxyLease {
    /// Index in the pool (0-based) — useful for log lines.
    pub index: usize,
    pub spec: ProxySpec,
    pub client: Arc<Client>,
    /// Set when the call had to sleep waiting for a free slot.
    pub waited: Option<Duration>,
}

impl ProxyPool {
    pub fn new(
        proxies: Vec<ProxySpec>,
        rotation_every: usize,
        rate_limit: Option<RateLimit>,
    ) -> Self {
        let n = proxies.len();
        Self {
            proxies,
            rotation_every: rotation_every.max(1),
            rate_limit,
            state: Mutex::new(PoolInner {
                state: (0..n).map(|_| ProxyUsage::default()).collect(),
            }),
            clients: Mutex::new(HashMap::new()),
        }
    }

    pub fn len(&self) -> usize {
        self.proxies.len()
    }

    pub fn is_empty(&self) -> bool {
        self.proxies.is_empty()
    }

    pub fn rate_limit(&self) -> Option<RateLimit> {
        self.rate_limit
    }

    /// Pick a proxy for the email at 0-based `index`. Honours rotation
    /// frequency, then the per-proxy rate limit. If every proxy is currently
    /// at quota the future sleeps until the earliest slot is free.
    pub async fn acquire(&self, index: usize) -> AppResult<ProxyLease> {
        if self.is_empty() {
            return Err(AppError::Validation("empty proxy pool".into()));
        }

        let preferred = (index / self.rotation_every) % self.proxies.len();
        let started_at = Instant::now();

        loop {
            let now = Instant::now();
            let chosen: Option<usize>;
            let next_free_at: Option<Instant>;

            {
                let mut inner = self.state.lock().await;
                let mut earliest: Option<Instant> = None;
                let mut pick: Option<usize> = None;

                for offset in 0..self.proxies.len() {
                    let i = (preferred + offset) % self.proxies.len();
                    if let Some(rl) = self.rate_limit {
                        let cutoff = now.checked_sub(rl.window).unwrap_or(now);
                        let uses = &mut inner.state[i].uses;
                        while uses.front().map(|&t| t <= cutoff).unwrap_or(false) {
                            uses.pop_front();
                        }
                        if uses.len() < rl.max_uses {
                            uses.push_back(now);
                            inner.state[i].total_uses += 1;
                            pick = Some(i);
                            break;
                        } else if let Some(&front) = uses.front() {
                            let free_at = front + rl.window;
                            earliest = Some(earliest.map_or(free_at, |e| e.min(free_at)));
                        }
                    } else {
                        inner.state[i].total_uses += 1;
                        pick = Some(i);
                        break;
                    }
                }
                chosen = pick;
                next_free_at = earliest;
            }

            if let Some(i) = chosen {
                let spec = self.proxies[i].clone();
                let client = self.get_or_build_client(&spec).await?;
                let waited = if started_at == now {
                    None
                } else {
                    Some(now.saturating_duration_since(started_at))
                };
                return Ok(ProxyLease {
                    index: i,
                    spec,
                    client,
                    waited,
                });
            }

            // All proxies are at quota — sleep until the earliest is free.
            let wait = next_free_at
                .map(|t| t.saturating_duration_since(now))
                .unwrap_or_else(|| Duration::from_millis(250));
            let wait = wait
                .max(Duration::from_millis(50))
                .min(Duration::from_secs(30));
            tokio::time::sleep(wait).await;
        }
    }

    async fn get_or_build_client(&self, spec: &ProxySpec) -> AppResult<Arc<Client>> {
        {
            let map = self.clients.lock().await;
            if let Some(c) = map.get(&spec.url) {
                return Ok(c.clone());
            }
        }
        let client = build_client(spec)?;
        let arc = Arc::new(client);
        let mut map = self.clients.lock().await;
        Ok(map
            .entry(spec.url.clone())
            .or_insert_with(|| arc.clone())
            .clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_form() {
        let spec = ProxySpec::parse("socks5://alice:pwd@1.2.3.4:1080").unwrap();
        assert_eq!(spec.scheme, "socks5");
        assert_eq!(spec.host_port, "1.2.3.4:1080");
        assert!(spec.has_auth);
        assert_eq!(spec.label(), "socks5://***@1.2.3.4:1080");
    }

    #[test]
    fn parse_short_form_host_port() {
        let spec = ProxySpec::parse("1.2.3.4:8080").unwrap();
        assert_eq!(spec.scheme, "http");
        assert_eq!(spec.host_port, "1.2.3.4:8080");
        assert!(!spec.has_auth);
        assert_eq!(spec.label(), "http://1.2.3.4:8080");
    }

    #[test]
    fn parse_short_form_host_port_user_pass() {
        let spec = ProxySpec::parse("1.2.3.4:8080:alice:s3cret").unwrap();
        assert_eq!(spec.scheme, "http");
        assert_eq!(spec.host_port, "1.2.3.4:8080");
        assert!(spec.has_auth);
        assert!(spec.url.contains("alice:s3cret"));
        // Label MUST NOT leak credentials.
        assert!(!spec.label().contains("alice"));
        assert!(!spec.label().contains("s3cret"));
    }

    #[test]
    fn parse_rejects_unknown_scheme() {
        assert!(ProxySpec::parse("ftp://1.2.3.4:21").is_err());
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(ProxySpec::parse("").is_err());
        assert!(ProxySpec::parse("not-a-proxy").is_err());
        assert!(ProxySpec::parse("a:b:c").is_err()); // 3 segments, not 2 or 4
    }

    #[test]
    fn parse_many_collects_errors() {
        let input = "1.2.3.4:8080\n# comment\n\nbad-line\nsocks5://10.0.0.1:1080\n";
        let (specs, errors) = parse_many(input);
        assert_eq!(specs.len(), 2);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("bad-line"));
    }

    #[tokio::test]
    async fn pool_rotates_through_proxies() {
        let specs = vec![
            ProxySpec::parse("1.1.1.1:8080").unwrap(),
            ProxySpec::parse("2.2.2.2:8080").unwrap(),
            ProxySpec::parse("3.3.3.3:8080").unwrap(),
        ];
        let pool = ProxyPool::new(specs, 1, None);
        let mut indices = Vec::new();
        for i in 0..6 {
            let lease = pool.acquire(i).await.unwrap();
            indices.push(lease.index);
        }
        assert_eq!(indices, vec![0, 1, 2, 0, 1, 2]);
    }

    #[tokio::test]
    async fn pool_respects_rotation_every() {
        let specs = vec![
            ProxySpec::parse("1.1.1.1:8080").unwrap(),
            ProxySpec::parse("2.2.2.2:8080").unwrap(),
        ];
        // rotate every 3 emails
        let pool = ProxyPool::new(specs, 3, None);
        let mut indices = Vec::new();
        for i in 0..7 {
            indices.push(pool.acquire(i).await.unwrap().index);
        }
        assert_eq!(indices, vec![0, 0, 0, 1, 1, 1, 0]);
    }

    #[tokio::test]
    async fn pool_single_proxy_used_for_everything() {
        let specs = vec![ProxySpec::parse("1.1.1.1:8080").unwrap()];
        let pool = ProxyPool::new(specs, 5, None);
        for i in 0..10 {
            assert_eq!(pool.acquire(i).await.unwrap().index, 0);
        }
    }

    #[tokio::test]
    async fn pool_rate_limit_falls_back_to_other_proxy() {
        let specs = vec![
            ProxySpec::parse("1.1.1.1:8080").unwrap(),
            ProxySpec::parse("2.2.2.2:8080").unwrap(),
        ];
        let pool = ProxyPool::new(
            specs,
            10, // rotation would keep us on #0 for the first 10 emails
            Some(RateLimit {
                max_uses: 3,
                window: Duration::from_secs(60),
            }),
        );
        let mut indices = Vec::new();
        for i in 0..6 {
            indices.push(pool.acquire(i).await.unwrap().index);
        }
        // 0,0,0 then quota reached → falls back to 1,1,1
        assert_eq!(indices, vec![0, 0, 0, 1, 1, 1]);
    }

    #[tokio::test]
    async fn pool_rate_limit_waits_when_all_saturated() {
        let specs = vec![ProxySpec::parse("1.1.1.1:8080").unwrap()];
        let pool = ProxyPool::new(
            specs,
            1,
            Some(RateLimit {
                max_uses: 1,
                window: Duration::from_millis(150),
            }),
        );
        // First call: instant.
        let _ = pool.acquire(0).await.unwrap();
        // Second call: must wait until the window opens.
        let started = Instant::now();
        let lease = pool.acquire(1).await.unwrap();
        let elapsed = started.elapsed();
        assert_eq!(lease.index, 0);
        assert!(
            elapsed >= Duration::from_millis(100),
            "expected wait, got {:?}",
            elapsed
        );
        assert!(lease.waited.is_some());
    }
}
