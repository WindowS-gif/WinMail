use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use lettre::{AsyncSmtpTransport, Tokio1Executor};

use crate::app_state::AppPaths;
use crate::commands::campaigns::Campaign;
use crate::commands::provider_configs::ProviderConfig;
use crate::core::error::{AppError, AppResult};
use crate::mailer::message::EmailMessage;
use crate::mailer::proxy::{self, ProxyPool, RateLimit};
use crate::storage;
use crate::template::renderer;

/// All sustained tokio tasks the engine has launched for active campaigns.
///
/// Each entry holds the cancel token (for stop), a "paused" flag (atomic bool),
/// and aggregated counters so external commands can read live stats without
/// touching disk.
#[derive(Default)]
pub struct CampaignEngine {
    handles: Mutex<HashMap<String, CampaignHandle>>,
}

#[derive(Clone)]
pub struct CampaignHandle {
    pub cancel: CancellationToken,
    pub paused: Arc<AtomicBool>,
    #[allow(dead_code)]
    pub stats: Arc<EngineStats>,
}

#[derive(Default)]
pub struct EngineStats {
    pub sent: AtomicUsize,
    pub failed: AtomicUsize,
    pub processed: AtomicUsize,
    pub total: AtomicUsize,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    campaign_id: String,
    status: String,
    sent: usize,
    failed: usize,
    pending: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
struct LogEvent {
    campaign_id: String,
    timestamp: String,
    level: String,
    message: String,
}

impl CampaignEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn is_running(&self, campaign_id: &str) -> bool {
        self.handles.lock().await.contains_key(campaign_id)
    }

    pub async fn pause(&self, campaign_id: &str) -> AppResult<()> {
        let map = self.handles.lock().await;
        if let Some(handle) = map.get(campaign_id) {
            handle.paused.store(true, Ordering::SeqCst);
            Ok(())
        } else {
            Err(AppError::NotFound(format!(
                "campaign {campaign_id} not running"
            )))
        }
    }

    pub async fn resume(&self, campaign_id: &str) -> AppResult<()> {
        let map = self.handles.lock().await;
        if let Some(handle) = map.get(campaign_id) {
            handle.paused.store(false, Ordering::SeqCst);
            Ok(())
        } else {
            Err(AppError::NotFound(format!(
                "campaign {campaign_id} not running"
            )))
        }
    }

    pub async fn stop(&self, campaign_id: &str) -> AppResult<()> {
        if let Some(handle) = self.handles.lock().await.remove(campaign_id) {
            handle.cancel.cancel();
        }
        Ok(())
    }

    pub async fn start(
        self: Arc<Self>,
        campaign_id: String,
        paths: AppPaths,
        app_handle: AppHandle,
    ) -> AppResult<()> {
        if self.is_running(&campaign_id).await {
            return Err(AppError::Validation("Campaign already running".into()));
        }

        let cancel = CancellationToken::new();
        let paused = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(EngineStats::default());

        {
            let mut map = self.handles.lock().await;
            map.insert(
                campaign_id.clone(),
                CampaignHandle {
                    cancel: cancel.clone(),
                    paused: paused.clone(),
                    stats: stats.clone(),
                },
            );
        }

        let engine = self.clone();
        let id_for_task = campaign_id.clone();
        tokio::spawn(async move {
            let outcome = run_campaign(
                campaign_id.clone(),
                paths,
                app_handle.clone(),
                cancel,
                paused,
                stats,
            )
            .await;
            let mut map = engine.handles.lock().await;
            map.remove(&id_for_task);
            if let Err(err) = outcome {
                tracing::error!("campaign {campaign_id} crashed: {err}");
                let _ = app_handle.emit(
                    "campaign://failed",
                    &LogEvent {
                        campaign_id: campaign_id.clone(),
                        timestamp: crate::core::now_utc_rfc3339(),
                        level: "error".into(),
                        message: format!("Engine fatal error: {err}"),
                    },
                );
            }
        });

        Ok(())
    }
}

async fn run_campaign(
    campaign_id: String,
    paths: AppPaths,
    app_handle: AppHandle,
    cancel: CancellationToken,
    paused: Arc<AtomicBool>,
    stats: Arc<EngineStats>,
) -> AppResult<()> {
    // Load campaign
    let mut campaign = load_campaign(&paths, &campaign_id).await?;
    let previous_status = campaign.status.clone();
    let previous_sent = campaign.stats.sent;
    let previous_failed = campaign.stats.failed;
    let cfg = campaign.config.clone();

    // Open a long-lived log writer for the whole campaign (held open for every
    // send to avoid per-line open/fsync/close syscalls).
    let mut logger = CampaignLogger::open(&paths, campaign_id.clone()).await;

    // Resolve providers
    let provider_ids = resolve_provider_ids(&cfg);
    if provider_ids.is_empty() {
        return Err(AppError::Validation(
            "No SMTP/API configuration associated with this campaign".into(),
        ));
    }
    // Load providers concurrently (each is a separate JSON file).
    let provider_load_paths = paths.clone();
    let provider_handles: Vec<_> = provider_ids
        .iter()
        .cloned()
        .map(|id| {
            let p = provider_load_paths.clone();
            tokio::spawn(async move {
                match crate::commands::provider_configs::load_config(&p, &id).await {
                    Ok(Some(mut cfg)) => {
                        if let Err(err) =
                            crate::commands::provider_configs::decrypt_in_place(&mut cfg)
                        {
                            tracing::warn!(%id, %err, "provider decrypt failed");
                            None
                        } else {
                            Some(cfg)
                        }
                    }
                    Ok(None) => None,
                    Err(err) => {
                        tracing::warn!(%id, %err, "provider load failed");
                        None
                    }
                }
            })
        })
        .collect();
    let mut providers = Vec::with_capacity(provider_handles.len());
    for handle in provider_handles {
        if let Ok(Some(p)) = handle.await {
            providers.push(p);
        }
    }
    if providers.is_empty() {
        return Err(AppError::Validation(
            "No valid SMTP/API configuration".into(),
        ));
    }

    // Pre-build SMTP transports per provider to share lettre's connection pool
    // across every send of the campaign. Failures are logged but do not abort
    // startup — fallback path uses build_transport on demand.
    let mut smtp_transports: HashMap<String, Arc<AsyncSmtpTransport<Tokio1Executor>>> =
        HashMap::new();
    for provider in &providers {
        if matches!(provider.provider.as_str(), "smtp" | "office365") {
            match crate::mailer::smtp::build_transport_for(provider) {
                Ok(transport) => {
                    smtp_transports.insert(provider.id.clone(), Arc::new(transport));
                }
                Err(err) => {
                    tracing::warn!(provider = %provider.id, %err, "smtp transport build failed");
                }
            }
        }
    }

    // Build the proxy pool (None when the user disabled proxies on the campaign).
    let proxy_pool = match build_proxy_pool(&cfg) {
        Ok(pool) => pool,
        Err(err) => {
            logger
                .log(&app_handle, "warning", &format!("Proxies disabled: {err}"))
                .await;
            None
        }
    };
    // Log a one-line summary at the start so the user sees their config
    // applied without having to wait for the first proxied send.
    if let Some(pool) = proxy_pool.as_ref() {
        let rl_msg = match pool.rate_limit() {
            Some(rl) => format!(
                " — limit {} send(s) per {}s per proxy",
                rl.max_uses,
                rl.window.as_secs()
            ),
            None => String::new(),
        };
        logger
            .log(
                &app_handle,
                "info",
                &format!("Proxies enabled: {} proxy(s) loaded{rl_msg}", pool.len()),
            )
            .await;
    }
    // SMTP / Office365 sends now go through `mailer::smtp_proxy`, which speaks
    // RFC 5321 directly on a SOCKS5 / HTTP-CONNECT proxied stream. The lettre
    // connection pool is therefore bypassed for proxied SMTP sends — each
    // message opens a fresh tunnel, which is the only sane option when the
    // exit IP rotates.
    if proxy_pool.is_some() {
        let has_smtp = providers
            .iter()
            .any(|p| matches!(p.provider.as_str(), "smtp" | "office365"));
        if has_smtp {
            logger
                .log(
                    &app_handle,
                    "info",
                    "SMTP/Office365: sends routed through proxy (one tunnel per message).",
                )
                .await;
        }
    }

    // Load templates
    let template_ids: Vec<String> = cfg
        .get("template_ids")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if template_ids.is_empty() {
        return Err(AppError::Validation("No template selected".into()));
    }
    let template_load_paths = paths.clone();
    let template_handles: Vec<_> = template_ids
        .iter()
        .cloned()
        .map(|id| {
            let p = template_load_paths.clone();
            tokio::spawn(async move {
                crate::commands::templates::load_template_raw(&p, &id)
                    .await
                    .ok()
                    .flatten()
            })
        })
        .collect();
    let mut templates = Vec::with_capacity(template_handles.len());
    for handle in template_handles {
        if let Ok(Some(t)) = handle.await {
            templates.push(t);
        }
    }
    if templates.is_empty() {
        return Err(AppError::Validation("Templates not found on disk".into()));
    }

    // Load recipients
    let recipients = load_recipients(&cfg).await?;
    let filtered = filter_and_sort_recipients(&cfg, recipients);
    let total = filtered.len();

    if total == 0 {
        logger
            .log(
                &app_handle,
                "warning",
                "No recipients to send to after filters.",
            )
            .await;
        finalize(
            &paths,
            &mut campaign,
            "completed",
            &stats,
            total,
            &app_handle,
            &mut logger,
        )
        .await?;
        return Ok(());
    }

    let can_resume_progress = matches!(
        previous_status.as_str(),
        "running" | "paused" | "stopped" | "interrupted" | "failed"
    );
    let start_index = if can_resume_progress {
        previous_sent.saturating_add(previous_failed).min(total)
    } else {
        0
    };
    let initial_sent = if start_index > 0 {
        previous_sent.min(total)
    } else {
        0
    };
    let initial_failed = if start_index > 0 {
        previous_failed.min(total.saturating_sub(initial_sent))
    } else {
        0
    };

    stats.total.store(total, Ordering::SeqCst);
    stats.sent.store(initial_sent, Ordering::SeqCst);
    stats.failed.store(initial_failed, Ordering::SeqCst);
    stats.processed.store(
        initial_sent.saturating_add(initial_failed),
        Ordering::SeqCst,
    );

    // Update campaign status to running and preserve progress when relaunching
    // an interrupted/stopped/paused campaign. This allows editing config while
    // paused, then restarting the engine with the new config without resending
    // recipients that were already processed.
    campaign.status = "running".to_string();
    campaign.stats.total = total;
    campaign.stats.sent = initial_sent;
    campaign.stats.failed = initial_failed;
    campaign.stats.pending = total
        .saturating_sub(initial_sent)
        .saturating_sub(initial_failed);
    campaign.updated_at = crate::core::now_local_string();
    save_campaign(&paths, &campaign).await?;

    let _ = app_handle.emit(
        "campaign://started",
        &ProgressEvent {
            campaign_id: campaign_id.clone(),
            status: "running".into(),
            sent: initial_sent,
            failed: initial_failed,
            pending: total
                .saturating_sub(initial_sent)
                .saturating_sub(initial_failed),
            total,
        },
    );
    logger
        .log(
            &app_handle,
            "info",
            &if start_index > 0 {
                format!(
                    "Resuming campaign at recipient {} / {} (sent: {}, failed: {}).",
                    start_index + 1,
                    total,
                    initial_sent,
                    initial_failed
                )
            } else {
                format!("Starting campaign ({total} recipient(s)).")
            },
        )
        .await;

    // Read parameters
    let (delay_min, delay_max) = delay_range(&cfg);
    let template_rotation_every = cfg
        .get("template_rotation_frequency")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let smtp_rotation_every = cfg
        .get("smtp_rotation_every")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let from_email_default = cfg
        .get("from_email")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let from_name_default = cfg
        .get("from_name")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let sender_name_rotation_enabled = cfg
        .get("sender_name_rotation_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sender_name_rotation_names = parse_sender_name_rotation_names(&cfg);
    let sender_name_rotation_every = cfg
        .get("sender_name_rotation_every")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let sender_local_rotation_enabled = cfg
        .get("sender_local_rotation_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sender_local_rotation_parts = parse_sender_local_rotation_parts(&cfg);
    let sender_local_rotation_domain = cfg
        .get("sender_local_rotation_domain")
        .and_then(Value::as_str)
        .map(|s| s.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let sender_local_rotation_every = cfg
        .get("sender_local_rotation_every")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1) as usize;
    let unsubscribe_url = cfg
        .get("unsubscribe_url")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let smtp_sender_mode = cfg
        .get("smtp_sender_mode")
        .and_then(Value::as_str)
        .unwrap_or("default");
    let smtp_from_name_mode = cfg
        .get("smtp_from_name_mode")
        .and_then(Value::as_str)
        .unwrap_or("global");
    let smtp_per_smtp = cfg.get("smtp_per_smtp").cloned().unwrap_or(Value::Null);

    // Main send loop (sequential, robust)
    let mut last_progress = std::time::Instant::now();
    for (index, recipient) in filtered.iter().enumerate().skip(start_index) {
        if cancel.is_cancelled() {
            logger
                .log(&app_handle, "info", "Campaign stopped by user.")
                .await;
            finalize(
                &paths,
                &mut campaign,
                "stopped",
                &stats,
                total,
                &app_handle,
                &mut logger,
            )
            .await?;
            return Ok(());
        }

        wait_while_paused(&paused, &cancel).await;
        if cancel.is_cancelled() {
            finalize(
                &paths,
                &mut campaign,
                "stopped",
                &stats,
                total,
                &app_handle,
                &mut logger,
            )
            .await?;
            return Ok(());
        }

        // Random delay between sends (skip before first)
        if index > 0 {
            let secs = random_in_range(delay_min, delay_max);
            if secs > 0.0 {
                let total_ms = (secs * 1000.0) as u64;
                let chunk = 250u64;
                let mut elapsed = 0u64;
                while elapsed < total_ms {
                    if cancel.is_cancelled() {
                        break;
                    }
                    if paused.load(Ordering::SeqCst) {
                        wait_while_paused(&paused, &cancel).await;
                    }
                    let sleep = chunk.min(total_ms - elapsed);
                    tokio::time::sleep(Duration::from_millis(sleep)).await;
                    elapsed += sleep;
                }
            }
        }

        // Pick template & provider via rotation
        let template = &templates[(index / template_rotation_every) % templates.len()];
        let provider = &providers[(index / smtp_rotation_every) % providers.len()];

        // Resolve from email/name (per SMTP override)
        let (from_email, mut from_name) = resolve_sender(
            smtp_sender_mode,
            smtp_from_name_mode,
            &from_email_default,
            from_name_default.as_deref(),
            &provider.id,
            provider,
            &smtp_per_smtp,
        );
        let from_email = resolve_sender_local_part_rotation(
            from_email,
            smtp_sender_mode,
            sender_local_rotation_enabled,
            &sender_local_rotation_parts,
            sender_local_rotation_domain.as_deref(),
            sender_local_rotation_every,
            index,
        );
        from_name = resolve_sender_name_rotation(
            from_name,
            smtp_from_name_mode,
            sender_name_rotation_enabled,
            &sender_name_rotation_names,
            sender_name_rotation_every,
            index,
        );

        // Render template
        let subject =
            renderer::personalize_string(&template.subject, recipient, Some(template), index);
        let html_rendered =
            renderer::personalize_string(&template.html, recipient, Some(template), index);
        let text_rendered =
            renderer::personalize_string(&template.text, recipient, Some(template), index);

        let to_email = recipient.get("email").map(String::from).unwrap_or_default();
        let to_name = recipient
            .get("name")
            .cloned()
            .or_else(|| {
                let first = recipient.get("first_name").cloned().unwrap_or_default();
                let last = recipient.get("last_name").cloned().unwrap_or_default();
                let full = format!("{first} {last}").trim().to_string();
                if full.is_empty() {
                    None
                } else {
                    Some(full)
                }
            })
            .filter(|s| !s.is_empty());

        let message = EmailMessage {
            from_email: from_email.clone(),
            from_name: from_name.clone(),
            to_email: to_email.clone(),
            to_name,
            reply_to: None,
            subject: subject.clone(),
            html: Some(html_rendered),
            text: Some(text_rendered),
            unsubscribe_url: unsubscribe_url.clone(),
            headers: Vec::new(),
        };

        // Pick a proxy if the pool is configured — covers both HTTP-API
        // providers (via reqwest::Client routed through the proxy) and the
        // SMTP family (via mailer::smtp_proxy speaking RFC 5321 directly).
        let lease = if let Some(pool) = proxy_pool.as_ref() {
            match pool.acquire(index).await {
                Ok(l) => Some(l),
                Err(err) => {
                    logger
                        .log(
                            &app_handle,
                            "warning",
                            &format!("Proxy unavailable: {err} — sending without proxy"),
                        )
                        .await;
                    None
                }
            }
        } else {
            None
        };

        if let Some(l) = &lease {
            if let Some(waited) = l.waited {
                if waited >= Duration::from_millis(500) {
                    logger
                        .log(
                            &app_handle,
                            "info",
                            &format!(
                                "Proxy quota reached, waiting {:.1}s before next send",
                                waited.as_secs_f64()
                            ),
                        )
                        .await;
                }
            }
        }

        let send_result = if let Some(l) = lease.as_ref() {
            let final_message = message.clone().with_text_fallback();
            if matches!(provider.provider.as_str(), "smtp" | "office365") {
                // SMTP through proxy: open a fresh tunneled connection and
                // speak RFC 5321 on it. The pooled lettre transport is not
                // used because its TCP path can't be redirected.
                crate::mailer::smtp_proxy::send(provider, &final_message, &l.spec).await
            } else {
                // HTTP-API provider: reqwest Client already configured with
                // the proxy via ProxyPool::get_or_build_client.
                crate::mailer::send_email_with_client(provider, &final_message, l.client.as_ref())
                    .await
            }
        } else {
            match smtp_transports.get(&provider.id) {
                Some(transport) => {
                    // Reuse pooled SMTP transport. mailer::send_email is bypassed,
                    // so we apply the deliverability text-fallback ourselves.
                    let final_message = message.clone().with_text_fallback();
                    crate::mailer::smtp::send_via(transport.as_ref(), provider, &final_message)
                        .await
                }
                None => crate::mailer::send_email(provider, &message).await,
            }
        };
        match send_result {
            Ok(_result) => {
                stats.sent.fetch_add(1, Ordering::SeqCst);
                stats.processed.fetch_add(1, Ordering::SeqCst);
                let proxy_suffix = match lease.as_ref() {
                    Some(l) => format!(" [proxy #{}: {}]", l.index + 1, l.spec.label()),
                    None => String::new(),
                };
                logger
                    .log(
                        &app_handle,
                        "ok",
                        &format!(
                            "[{}/{}] OK → {} via {}{}",
                            index + 1,
                            total,
                            to_email,
                            provider.name,
                            proxy_suffix
                        ),
                    )
                    .await;
            }
            Err(e) => {
                stats.failed.fetch_add(1, Ordering::SeqCst);
                stats.processed.fetch_add(1, Ordering::SeqCst);
                let proxy_suffix = match lease.as_ref() {
                    Some(l) => format!(" [proxy #{}: {}]", l.index + 1, l.spec.label()),
                    None => String::new(),
                };
                logger
                    .log(
                        &app_handle,
                        "failed",
                        &format!(
                            "[{}/{}] FAIL → {} ({}){}",
                            index + 1,
                            total,
                            to_email,
                            e,
                            proxy_suffix
                        ),
                    )
                    .await;
            }
        }

        // Throttle progress events (every 500ms or on completion)
        if last_progress.elapsed() > Duration::from_millis(450) || index + 1 == total {
            emit_progress(&app_handle, &campaign_id, &stats, "running");
            // Persist stats periodically
            campaign.stats.sent = stats.sent.load(Ordering::SeqCst);
            campaign.stats.failed = stats.failed.load(Ordering::SeqCst);
            campaign.stats.pending = total
                .saturating_sub(campaign.stats.sent)
                .saturating_sub(campaign.stats.failed);
            campaign.updated_at = crate::core::now_local_string();
            let _ = save_campaign(&paths, &campaign).await;
            last_progress = std::time::Instant::now();
        }
    }

    finalize(
        &paths,
        &mut campaign,
        "completed",
        &stats,
        total,
        &app_handle,
        &mut logger,
    )
    .await?;
    Ok(())
}

async fn finalize(
    paths: &AppPaths,
    campaign: &mut Campaign,
    status: &str,
    stats: &EngineStats,
    total: usize,
    app_handle: &AppHandle,
    logger: &mut CampaignLogger,
) -> AppResult<()> {
    campaign.status = status.to_string();
    campaign.stats.sent = stats.sent.load(Ordering::SeqCst);
    campaign.stats.failed = stats.failed.load(Ordering::SeqCst);
    campaign.stats.total = total;
    campaign.stats.pending = total
        .saturating_sub(campaign.stats.sent)
        .saturating_sub(campaign.stats.failed);
    campaign.updated_at = crate::core::now_local_string();
    save_campaign(paths, campaign).await?;
    emit_progress(app_handle, &campaign.id, stats, status);
    let event_name = match status {
        "completed" => "campaign://completed",
        "stopped" => "campaign://stopped",
        "failed" => "campaign://failed",
        _ => "campaign://progress",
    };
    let _ = app_handle.emit(
        event_name,
        &ProgressEvent {
            campaign_id: campaign.id.clone(),
            status: status.into(),
            sent: campaign.stats.sent,
            failed: campaign.stats.failed,
            pending: campaign.stats.pending,
            total,
        },
    );
    logger
        .log(
            app_handle,
            "info",
            &format!(
                "Campaign {status} — sent: {}, failed: {}.",
                campaign.stats.sent, campaign.stats.failed
            ),
        )
        .await;
    // Final fsync so the on-disk log fully reflects the campaign's outcome.
    logger.flush().await;
    Ok(())
}

fn emit_progress(app_handle: &AppHandle, campaign_id: &str, stats: &EngineStats, status: &str) {
    let sent = stats.sent.load(Ordering::SeqCst);
    let failed = stats.failed.load(Ordering::SeqCst);
    let total = stats.total.load(Ordering::SeqCst);
    let pending = total.saturating_sub(sent).saturating_sub(failed);
    let _ = app_handle.emit(
        "campaign://progress",
        &ProgressEvent {
            campaign_id: campaign_id.to_string(),
            status: status.to_string(),
            sent,
            failed,
            pending,
            total,
        },
    );
}

/// Lazy, long-lived writer for a campaign's JSONL log file.
///
/// The previous implementation opened, wrote, fsynced and closed the file for
/// every single log line, which on a 10 000-email campaign is 60 000+
/// syscalls. We now open once for the whole campaign, batch flushes every
/// `FLUSH_EVERY` lines, and force a flush at finalize. Live readers (the
/// frontend) get every line in real time via the Tauri event bus, so flushes
/// only matter for crash durability of the on-disk log.
struct CampaignLogger {
    file: Option<tokio::fs::File>,
    campaign_id: String,
    pending_since_flush: usize,
}

impl CampaignLogger {
    const FLUSH_EVERY: usize = 32;

    async fn open(paths: &AppPaths, campaign_id: String) -> Self {
        let file = if storage::ensure_dir(&paths.campaigns_dir).await.is_ok() {
            tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(paths.campaigns_dir.join(format!("{campaign_id}.log.jsonl")))
                .await
                .map_err(|err| {
                    tracing::warn!(%campaign_id, %err, "campaign log open failed");
                    err
                })
                .ok()
        } else {
            None
        };
        Self {
            file,
            campaign_id,
            pending_since_flush: 0,
        }
    }

    async fn log(&mut self, app_handle: &AppHandle, level: &str, message: &str) {
        let timestamp = crate::core::now_utc_rfc3339();
        if let Some(file) = self.file.as_mut() {
            let line = json!({
                "timestamp": &timestamp,
                "level": level,
                "message": message,
            });
            if let Ok(mut s) = serde_json::to_vec(&line) {
                s.push(b'\n');
                if let Err(err) = file.write_all(&s).await {
                    tracing::warn!(campaign_id = %self.campaign_id, %err, "campaign log write failed");
                } else {
                    self.pending_since_flush += 1;
                    if self.pending_since_flush >= Self::FLUSH_EVERY {
                        let _ = file.flush().await;
                        self.pending_since_flush = 0;
                    }
                }
            }
        }

        let _ = app_handle.emit(
            "campaign://log",
            &LogEvent {
                campaign_id: self.campaign_id.clone(),
                timestamp,
                level: level.to_string(),
                message: message.to_string(),
            },
        );
    }

    async fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush().await;
            self.pending_since_flush = 0;
        }
    }
}

async fn wait_while_paused(paused: &AtomicBool, cancel: &CancellationToken) {
    while paused.load(Ordering::SeqCst) && !cancel.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn random_in_range(min: f64, max: f64) -> f64 {
    let lo = min.max(0.0);
    let hi = max.max(lo);
    if (hi - lo).abs() < f64::EPSILON {
        return lo;
    }
    let mut rng = rand::rng();
    rng.random_range(lo..=hi)
}

fn delay_range(cfg: &Value) -> (f64, f64) {
    let delay_min = cfg.get("delay_min").and_then(parse_f64).unwrap_or(1.0);
    let mut delay_max = cfg
        .get("delay_max")
        .and_then(parse_f64)
        .unwrap_or(delay_min);
    if delay_max < delay_min {
        delay_max = delay_min;
    }
    (delay_min.max(0.0), delay_max.max(0.0))
}

fn parse_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.replace(',', ".").trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn resolve_provider_ids(cfg: &Value) -> Vec<String> {
    let rotation_enabled = cfg
        .get("smtp_rotation_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if rotation_enabled {
        if let Some(arr) = cfg.get("smtp_rotation_ids").and_then(Value::as_array) {
            let mut ids = Vec::new();
            for v in arr {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() && !ids.contains(&trimmed.to_string()) {
                        ids.push(trimmed.to_string());
                    }
                }
            }
            if !ids.is_empty() {
                return ids;
            }
        }
    }
    if let Some(id) = cfg
        .get("smtp_config_id")
        .and_then(Value::as_str)
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return vec![id.to_string()];
    }
    Vec::new()
}

fn is_valid_email_local_part(part: &str) -> bool {
    let part = part.trim();
    !part.is_empty()
        && part.len() <= 64
        && part.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '.' | '!'
                        | '#'
                        | '$'
                        | '%'
                        | '&'
                        | '\''
                        | '*'
                        | '+'
                        | '/'
                        | '='
                        | '?'
                        | '^'
                        | '_'
                        | '`'
                        | '{'
                        | '|'
                        | '}'
                        | '~'
                        | '-'
                )
        })
}

fn parse_sender_local_rotation_parts(cfg: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    cfg.get("sender_local_rotation_parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(Value::as_str)
                .map(|part| part.trim().trim_start_matches('@'))
                .map(|part| part.split('@').next().unwrap_or("").trim())
                .filter(|part| is_valid_email_local_part(part))
                .filter_map(|part| {
                    let key = part.to_ascii_lowercase();
                    if seen.insert(key) {
                        Some(part.to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_sender_local_part_rotation(
    current_email: String,
    sender_mode: &str,
    enabled: bool,
    local_parts: &[String],
    configured_domain: Option<&str>,
    rotate_every: usize,
    email_index0: usize,
) -> String {
    // Per-SMTP sender overrides are explicit account-level choices; don't let a
    // global verified-domain rotation silently rewrite them.
    if sender_mode == "per_smtp" || !enabled || local_parts.is_empty() {
        return current_email;
    }

    let domain = configured_domain
        .map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .or_else(|| {
            current_email
                .rsplit_once('@')
                .map(|(_, d)| d.to_ascii_lowercase())
        });
    let Some(domain) = domain else {
        return current_email;
    };

    let every = rotate_every.max(1);
    let idx = (email_index0 / every) % local_parts.len();
    format!("{}@{}", local_parts[idx], domain)
}

fn parse_sender_name_rotation_names(cfg: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    cfg.get("sender_name_rotation_names")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .filter_map(|name| {
                    let key = name.to_ascii_lowercase();
                    if seen.insert(key) {
                        Some(name.to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_sender_name_rotation(
    current_name: Option<String>,
    from_name_mode: &str,
    enabled: bool,
    names: &[String],
    rotate_every: usize,
    email_index0: usize,
) -> Option<String> {
    // Per-SMTP names are explicit account-level overrides; keep them authoritative
    // when enabled so the global rotation does not silently fight SMTP routing.
    if from_name_mode == "per_smtp" || !enabled || names.is_empty() {
        return current_name;
    }
    let every = rotate_every.max(1);
    let idx = (email_index0 / every) % names.len();
    names.get(idx).cloned().or(current_name)
}

fn resolve_sender(
    sender_mode: &str,
    from_name_mode: &str,
    default_from: &str,
    default_name: Option<&str>,
    provider_id: &str,
    provider: &ProviderConfig,
    per_smtp: &Value,
) -> (String, Option<String>) {
    let mut from_email = default_from.to_string();
    let mut from_name = default_name.map(String::from);

    let row = per_smtp.get(provider_id);

    if sender_mode == "per_smtp" {
        if let Some(row) = row {
            let use_default = row
                .get("use_default_from")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let custom = row.get("from_email").and_then(Value::as_str).unwrap_or("");
            if !use_default && !custom.trim().is_empty() {
                from_email = custom.trim().to_string();
            }
        }
    }
    if from_name_mode == "per_smtp" {
        if let Some(row) = row {
            let use_global = row
                .get("use_global_name")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let custom = row.get("from_name").and_then(Value::as_str).unwrap_or("");
            if !use_global {
                from_name = if custom.trim().is_empty() {
                    None
                } else {
                    Some(custom.trim().to_string())
                };
            }
        }
    }

    // Fallback: for generic SMTP / Office365, if no From is set, use the username
    if from_email.trim().is_empty()
        && matches!(provider.provider.as_str(), "smtp" | "office365")
        && !provider.username.trim().is_empty()
    {
        from_email = provider.username.trim().to_string();
    }

    (from_email, from_name)
}

async fn load_campaign(paths: &AppPaths, campaign_id: &str) -> AppResult<Campaign> {
    let path = paths.campaigns_dir.join(format!("{campaign_id}.json"));
    storage::read_json::<Campaign>(&path)
        .await
        .map_err(|_| AppError::NotFound(format!("campaign {campaign_id} not found")))
}

async fn save_campaign(paths: &AppPaths, campaign: &Campaign) -> AppResult<()> {
    let path = paths.campaigns_dir.join(format!("{}.json", campaign.id));
    storage::write_json_pretty(&path, campaign).await
}

async fn load_recipients(cfg: &Value) -> AppResult<Vec<HashMap<String, String>>> {
    let file_path = cfg
        .get("file_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if file_path.is_empty() {
        return Err(AppError::Validation(
            "Recipient file missing from campaign".into(),
        ));
    }
    let file_type = cfg
        .get("file_type")
        .and_then(Value::as_str)
        .unwrap_or("csv")
        .to_string();
    let column_mapping = cfg.get("column_mapping").cloned();
    crate::commands::recipients::parse_file(Path::new(&file_path), &file_type, column_mapping)
        .await
        .map(|out| out.recipients)
}

/// Build a [`ProxyPool`] from the campaign config. Returns `Ok(None)` when
/// the user has not enabled proxies. Returns an error when proxies are
/// enabled but the configuration is malformed (no valid proxy line, bad
/// scheme, etc.) so the caller can log it and fall back to direct sends.
fn build_proxy_pool(cfg: &Value) -> AppResult<Option<ProxyPool>> {
    let enabled = cfg
        .get("proxy_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return Ok(None);
    }

    // Accept either a string blob (textarea-style) or an array of strings.
    let raw_lines: Vec<String> = match cfg.get("proxies") {
        Some(Value::String(s)) => s.lines().map(str::to_string).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let blob = raw_lines.join("\n");
    let (specs, errors) = proxy::parse_many(&blob);
    if specs.is_empty() {
        return Err(AppError::Validation(format!(
            "no valid proxy ({}). Expected format: scheme://host:port or host:port[:user:pass]",
            if errors.is_empty() {
                "empty list".to_string()
            } else {
                errors.join("; ")
            }
        )));
    }

    let rotation_every = cfg
        .get("proxy_rotation_every")
        .and_then(parse_usize)
        .unwrap_or(1)
        .max(1);

    let rate_limit = if cfg
        .get("proxy_rate_limit_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let max_uses = cfg
            .get("proxy_max_uses_per_window")
            .and_then(parse_usize)
            .unwrap_or(30);
        let window_secs = cfg
            .get("proxy_rate_window_secs")
            .and_then(parse_u64)
            .unwrap_or(60);
        if max_uses == 0 || window_secs == 0 {
            None
        } else {
            Some(RateLimit {
                max_uses,
                window: Duration::from_secs(window_secs),
            })
        }
    } else {
        None
    };

    Ok(Some(ProxyPool::new(specs, rotation_every, rate_limit)))
}

fn parse_usize(value: &Value) -> Option<usize> {
    parse_u64(value).map(|v| v as usize)
}

fn parse_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn filter_and_sort_recipients(
    cfg: &Value,
    mut recipients: Vec<HashMap<String, String>>,
) -> Vec<HashMap<String, String>> {
    let domain_filters: Vec<String> = cfg
        .get("domain_filters")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().trim_start_matches('@').to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    if !domain_filters.is_empty() {
        recipients.retain(|r| {
            r.get("email")
                .and_then(|email| email.split('@').nth(1))
                .map(|domain| domain.to_ascii_lowercase())
                .map(|d| domain_filters.contains(&d))
                .unwrap_or(false)
        });
    }

    let dedupe = cfg
        .get("deduplicate_recipients")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if dedupe {
        let mut seen = HashSet::new();
        recipients.retain(|r| match r.get("email") {
            Some(email) => seen.insert(email.to_ascii_lowercase()),
            None => false,
        });
    }

    let gmail_last = cfg
        .get("gmail_last")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if gmail_last {
        let mut gmail = Vec::new();
        let mut other = Vec::new();
        for r in recipients {
            let is_gmail = r
                .get("email")
                .map(|e| e.to_ascii_lowercase().ends_with("@gmail.com"))
                .unwrap_or(false);
            if is_gmail {
                gmail.push(r);
            } else {
                other.push(r);
            }
        }
        other.extend(gmail);
        other
    } else {
        recipients
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_delay_handles_string() {
        let cfg = json!({ "delay_min": "0.5", "delay_max": "1.5" });
        let (min, max) = delay_range(&cfg);
        assert!((min - 0.5).abs() < 1e-9);
        assert!((max - 1.5).abs() < 1e-9);
    }

    #[test]
    fn parse_delay_clamps_max_below_min() {
        let cfg = json!({ "delay_min": 2.0, "delay_max": 1.0 });
        let (min, max) = delay_range(&cfg);
        assert_eq!(min, 2.0);
        assert_eq!(max, 2.0);
    }

    #[test]
    fn resolve_ids_prefers_rotation_when_enabled() {
        let cfg = json!({
            "smtp_rotation_enabled": true,
            "smtp_rotation_ids": ["a", "b", "a"],
            "smtp_config_id": "z"
        });
        assert_eq!(resolve_provider_ids(&cfg), vec!["a", "b"]);
    }

    #[test]
    fn resolve_ids_falls_back_to_primary() {
        let cfg = json!({ "smtp_config_id": "main" });
        assert_eq!(resolve_provider_ids(&cfg), vec!["main"]);
    }

    #[test]
    fn parses_sender_local_rotation_parts_cleanly() {
        let cfg = json!({
            "sender_local_rotation_parts": [" alex ", "marie@example.com", "", "ALEx", "bad space", "team-1"]
        });
        assert_eq!(
            parse_sender_local_rotation_parts(&cfg),
            vec![
                "alex".to_string(),
                "marie".to_string(),
                "team-1".to_string()
            ]
        );
    }

    #[test]
    fn resolves_sender_local_part_rotation_by_email_index() {
        let parts = vec!["alex".to_string(), "marie".to_string()];
        let picked: Vec<_> = (0..5)
            .map(|idx| {
                resolve_sender_local_part_rotation(
                    "noreply@example.com".to_string(),
                    "default",
                    true,
                    &parts,
                    Some("example.com"),
                    2,
                    idx,
                )
            })
            .collect();
        assert_eq!(
            picked,
            vec![
                "alex@example.com",
                "alex@example.com",
                "marie@example.com",
                "marie@example.com",
                "alex@example.com",
            ]
        );
    }

    #[test]
    fn per_smtp_sender_email_overrides_local_part_rotation() {
        let parts = vec!["alex".to_string()];
        let picked = resolve_sender_local_part_rotation(
            "custom@example.com".to_string(),
            "per_smtp",
            true,
            &parts,
            Some("example.com"),
            1,
            0,
        );
        assert_eq!(picked, "custom@example.com");
    }

    #[test]
    fn parses_sender_name_rotation_names_cleanly() {
        let cfg = json!({
            "sender_name_rotation_names": [" Alice ", "", "Bob", "alice", "BOB ", "Claire"]
        });
        assert_eq!(
            parse_sender_name_rotation_names(&cfg),
            vec!["Alice".to_string(), "Bob".to_string(), "Claire".to_string()]
        );
    }

    #[test]
    fn resolves_sender_name_rotation_by_email_index() {
        let names = vec!["Alice".to_string(), "Bob".to_string()];
        let picked: Vec<_> = (0..6)
            .map(|idx| {
                resolve_sender_name_rotation(
                    Some("Default".to_string()),
                    "global",
                    true,
                    &names,
                    2,
                    idx,
                )
                .unwrap()
            })
            .collect();
        assert_eq!(
            picked,
            vec!["Alice", "Alice", "Bob", "Bob", "Alice", "Alice"]
        );
    }

    #[test]
    fn per_smtp_sender_name_overrides_rotation() {
        let names = vec!["Alice".to_string(), "Bob".to_string()];
        let picked = resolve_sender_name_rotation(
            Some("Per SMTP".to_string()),
            "per_smtp",
            true,
            &names,
            1,
            1,
        );
        assert_eq!(picked.as_deref(), Some("Per SMTP"));
    }

    #[test]
    fn filter_dedupes_by_email() {
        let cfg = json!({});
        let mut a = HashMap::new();
        a.insert("email".into(), "x@y.com".into());
        let mut b = HashMap::new();
        b.insert("email".into(), "X@y.com".into());
        let mut c = HashMap::new();
        c.insert("email".into(), "z@y.com".into());
        let out = filter_and_sort_recipients(&cfg, vec![a, b, c]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn filter_keeps_gmail_last() {
        let cfg = json!({ "gmail_last": true });
        let mut g = HashMap::new();
        g.insert("email".into(), "a@gmail.com".into());
        let mut o = HashMap::new();
        o.insert("email".into(), "a@other.com".into());
        let out = filter_and_sort_recipients(&cfg, vec![g, o]);
        assert_eq!(out[0].get("email").unwrap(), "a@other.com");
        assert_eq!(out[1].get("email").unwrap(), "a@gmail.com");
    }

    #[test]
    fn filter_applies_domain_filters() {
        let cfg = json!({ "domain_filters": ["gmail.com"] });
        let mut a = HashMap::new();
        a.insert("email".into(), "x@gmail.com".into());
        let mut b = HashMap::new();
        b.insert("email".into(), "x@yahoo.com".into());
        let out = filter_and_sort_recipients(&cfg, vec![a, b]);
        assert_eq!(out.len(), 1);
        assert!(out[0].get("email").unwrap().ends_with("@gmail.com"));
    }
}
