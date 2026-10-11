// ============================================
// GLOBAL STATE
// ============================================

const state = {
  currentSection: "dashboard",
  /** Campaign polling timer (avoids SSE: php -S handles only one request at a time) */
  campaignPollTimer: null,
  currentCampaignId: null,
  editingCampaignId: null,
  resumeCampaignAfterEdit: false,
  editReturnToMonitoringId: null,
  scoreData: null,
  uploadedFilePath: null,
  uploadedFileType: null,
  uploadedTotal: 0,
  uploadNativeDropInit: false,
  templates: [],
  smtpConfigs: [],
  campaignsCache: [],
  suppressSmtpSelectChange: false,
  paused: false,
  /** Headers of the last imported CSV (exact column names) */
  csvHeaders: [],
  csvMappingReparseTimer: null,
  /** Template editor: 'code' | 'visual' */
  templateHtmlEditMode: "code",
  templatePreviewDevice: "desktop",
  /** true after "Apply" real data - reset if the HTML changes in code mode */
  templatePreviewUsesRealMerge: false,
  /** Pre-send summary */
  sendSummaryPending: null,
  deleteCampaignPendingId: null,
  configCacheForDetailEta: null,
  completionWatchTimer: null,
  completionWatchCampaignId: null,
  completionWatchName: null,
  /** Visual editor: true if the source is a full HTML document, false if a fragment injected into body */
  templateVisualIsFullDocument: false,
  templateVisualLoading: false,
  templateVisualInputHandler: null,
  /** Template folders (loaders + UI-side rendering) */
  templateFolders: [],
  /** Currently open folder ('' = root view) */
  currentTemplateFolderId: "",
  /** Current state of template <-> folder DnD */
  templateDnd: {
    draggingId: null,
    draggingKind: null, // 'template' | 'folder' | null
    hoverMergeId: null,
    hoverMergeTimer: null,
  },
};

/** @type {Map<string, { email: string, name: string, label: string, domain: string }>} */
let campaignFromIdentityMeta = new Map();

const VERIFIED_DOMAIN_LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;

/**
 * SES regions (forms) - aligned with SesAccountInspector::PROBE_REGIONS (PHP).
 * @type {{ v: string, l: string }[]}
 */
const SES_AWS_REGION_OPTIONS = [
  { v: "af-south-1", l: "Africa (Cape Town) — af-south-1" },
  { v: "ap-northeast-1", l: "Asia Pacific (Tokyo) — ap-northeast-1" },
  { v: "ap-northeast-2", l: "Asia Pacific (Seoul) — ap-northeast-2" },
  { v: "ap-northeast-3", l: "Asia Pacific (Osaka) — ap-northeast-3" },
  { v: "ap-south-1", l: "Asia Pacific (Mumbai) — ap-south-1" },
  { v: "ap-south-2", l: "Asia Pacific (Hyderabad) — ap-south-2" },
  { v: "ap-southeast-1", l: "Asia Pacific (Singapore) — ap-southeast-1" },
  { v: "ap-southeast-2", l: "Asia Pacific (Sydney) — ap-southeast-2" },
  { v: "ap-southeast-3", l: "Asia Pacific (Jakarta) — ap-southeast-3" },
  { v: "ap-southeast-5", l: "Asia Pacific (Malaysia) — ap-southeast-5" },
  { v: "ca-central-1", l: "Canada (Central) — ca-central-1" },
  { v: "ca-west-1", l: "Canada West (Calgary) — ca-west-1" },
  { v: "eu-central-1", l: "Europe (Frankfurt) — eu-central-1" },
  { v: "eu-central-2", l: "Europe (Zurich) — eu-central-2" },
  { v: "eu-north-1", l: "Europe (Stockholm) — eu-north-1" },
  { v: "eu-south-1", l: "Europe (Milan) — eu-south-1" },
  { v: "eu-west-1", l: "Europe (Ireland) — eu-west-1" },
  { v: "eu-west-2", l: "Europe (London) — eu-west-2" },
  { v: "eu-west-3", l: "Europe (Paris) — eu-west-3" },
  { v: "il-central-1", l: "Israel (Tel Aviv) — il-central-1" },
  { v: "me-central-1", l: "Middle East (UAE) — me-central-1" },
  { v: "me-south-1", l: "Middle East (Bahrain) — me-south-1" },
  { v: "sa-east-1", l: "South America (Sao Paulo) — sa-east-1" },
  { v: "us-east-1", l: "US East (N. Virginia) — us-east-1" },
  { v: "us-east-2", l: "USA (Ohio) — us-east-2" },
  { v: "us-west-1", l: "US West (N. California) — us-west-1" },
  { v: "us-west-2", l: "USA (Oregon) — us-west-2" },
  { v: "us-gov-east-1", l: "AWS GovCloud (US-East) — us-gov-east-1" },
  { v: "us-gov-west-1", l: "AWS GovCloud (US-West) — us-gov-west-1" },
];

function labelForAwsRegionCode(code) {
  if (!code) return "";
  const o = SES_AWS_REGION_OPTIONS.find((x) => x.v === code);
  return o ? o.l : String(code) + " — " + String(code);
}

function populateAwsRegionSelects() {
  ["smtpAwsRegion", "campAwsRegion", "testingSesRegion"].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const previous = sel.value;
    sel.textContent = "";
    SES_AWS_REGION_OPTIONS.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.v;
      opt.textContent = o.l;
      sel.appendChild(opt);
    });
    const allowed = SES_AWS_REGION_OPTIONS.some((o) => o.v === previous);
    sel.value = allowed ? previous : "eu-west-3";
  });
}

/** Adds the option if needed (e.g. old config or scan) then selects it. */
function ensureAwsRegionInSelect(selectId, regionCode, displayLabel) {
  const sel = document.getElementById(selectId);
  if (!sel || !regionCode) return;
  const code = String(regionCode).trim();
  if (!code) return;
  let found = Array.from(sel.options).some((o) => o.value === code);
  if (!found) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = displayLabel || labelForAwsRegionCode(code);
    sel.appendChild(opt);
    found = true;
  }
  if (found) sel.value = code;
}

// --- API introspection cache (sessionStorage - never an automatic call) ---
const INSPECT_CACHE_SS_KEY = "winmail_provider_inspect_v1";
const INSPECTABLE_SMTP_PROVIDERS = new Set([
  "brevo",
  "ses",
  "amazonses",
  "sendgrid",
]);

function readInspectCacheMap() {
  try {
    const raw = sessionStorage.getItem(INSPECT_CACHE_SS_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function writeInspectCacheMap(map) {
  try {
    sessionStorage.setItem(INSPECT_CACHE_SS_KEY, JSON.stringify(map));
  } catch {
    /* quota / private */
  }
}

function getSmtpInspectCacheEntry(smtpId) {
  if (smtpId == null || smtpId === "") return null;
  const m = readInspectCacheMap();
  return m[String(smtpId)] || null;
}

function setSmtpInspectCacheEntry(smtpId, apiData) {
  if (smtpId == null || smtpId === "" || !apiData || !apiData.inspect) return;
  const m = readInspectCacheMap();
  m[String(smtpId)] = {
    fetched_at: apiData.fetched_at,
    inspect: apiData.inspect,
  };
  writeInspectCacheMap(m);
}

function removeSmtpInspectCacheEntry(smtpId) {
  if (smtpId == null || smtpId === "") return;
  const m = readInspectCacheMap();
  delete m[String(smtpId)];
  writeInspectCacheMap(m);
}

function formatInspectScalar(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

function renderSendgridInspectSummary(inspectObj) {
  if (
    !inspectObj ||
    String(inspectObj.provider || "").toLowerCase() !== "sendgrid"
  ) {
    return "";
  }
  const profile = inspectObj.profile || {};
  const quota = inspectObj.quota_summary || {};
  const credits = inspectObj.credits || {};
  const creditsOk = !!credits.ok;
  const identitySummary = inspectObj.identity_summary || {};
  const identities = Array.isArray(identitySummary.identities)
    ? identitySummary.identities
    : [];
  const sources = identitySummary.sources || {};
  const verifiedCount = Number(identitySummary.verified_count || 0);
  const unverifiedCount = Number(identitySummary.unverified_count || 0);
  const sourceBadges = [
    ["Single Sender", sources.verified_senders],
    ["Sender identities", sources.legacy_senders],
    ["Authenticated domains", sources.authenticated_domains],
  ]
    .map(([label, ok]) => `${ok ? "✓" : "×"} ${label}`)
    .join(" · ");

  const quotaLine = creditsOk
    ? `Remaining: <strong>${escHtml(formatInspectScalar(quota.remaining))}</strong> · Used: <strong>${escHtml(formatInspectScalar(quota.used))}</strong> · Total: <strong>${escHtml(formatInspectScalar(quota.total))}</strong>`
    : `Quota endpoint unavailable${credits.error ? `: ${escHtml(String(credits.error))}` : ""}`;

  const identitiesHtml = identities.length
    ? `<ul class="header-list" style="margin-top:.5rem;">${identities
        .slice(0, 12)
        .map((i) => {
          const label = i.label || i.email || i.domain || "identity";
          const verified = !!i.verified;
          const status = verified ? "verified" : "unverified";
          const source = i.source
            ? ` <span class="label-hint">(${escHtml(String(i.source))}, ${status})</span>`
            : ` <span class="label-hint">(${status})</span>`;
          return `<li>${escHtml(String(label))}${source}</li>`;
        })
        .join(
          "",
        )}${identities.length > 12 ? `<li>… ${identities.length - 12} more</li>` : ""}</ul>`
    : '<p class="field-hint">No SendGrid sender record or authenticated domain was returned by the API. Choose “Custom address…” in the test email form if you know the domain is authorized.</p>';

  return `
    <div class="highlight-box" style="margin-bottom:1rem;">
      <strong>SendGrid API summary</strong>
      <div style="margin-top:.6rem;display:grid;gap:.35rem;">
        <div><strong>Region used:</strong> ${escHtml(inspectObj.region || "—")} <span class="label-hint">${escHtml(inspectObj.base_used || "")}</span></div>
        <div><strong>Account:</strong> ${escHtml(profile.username || profile.email || profile.first_name || "—")}</div>
        <div><strong>Quota / credits:</strong> ${quotaLine}</div>
        <div><strong>Identities:</strong> ${escHtml(String(identities.length || 0))} detected <span class="label-hint">(${escHtml(String(verifiedCount))} verified, ${escHtml(String(unverifiedCount))} unverified)</span></div>
        <div><strong>Endpoints:</strong> ${escHtml(sourceBadges)}</div>
      </div>
      ${identitiesHtml}
    </div>`;
}

function buildInspectPreHtml(fetchedAt, inspectObj) {
  const t =
    fetchedAt && String(fetchedAt).trim()
      ? `<p class="field-hint smtp-inspect-meta"><strong>Fetched:</strong> ${escHtml(
          (() => {
            try {
              return new Date(fetchedAt).toLocaleString("en-US");
            } catch {
              return String(fetchedAt);
            }
          })(),
        )}</p>`
      : "";
  return (
    t +
    renderSendgridInspectSummary(inspectObj) +
    '<pre class="inspect-json-pre" tabindex="0">' +
    escHtml(JSON.stringify(inspectObj, null, 2)) +
    "</pre>"
  );
}

function renderSmtpDetailMetaRows(c) {
  const rows = [
    ["ID", c.id || "—"],
    ["Name", c.name || "—"],
    ["Provider", c.provider || "—"],
  ];
  if (c.host) rows.push(["Host", c.host]);
  if (c.port != null && c.port !== "") rows.push(["Port", String(c.port)]);
  if (c.username) rows.push(["User", c.username]);
  if (c.region) rows.push(["SES region", c.region]);
  if (String(c.provider || "").toLowerCase() === "office365") {
    const enc = (c.encryption && String(c.encryption).trim()) || "tls";
    rows.push([
      "SMTP encryption",
      enc.toUpperCase() + " (STARTTLS expected on port 587)",
    ]);
  }
  if (String(c.provider || "").toLowerCase() === "sendgrid") {
    const g = c.sendgrid_region != null ? String(c.sendgrid_region).trim() : "";
    const label =
      g === "eu"
        ? "EU (api.eu.sendgrid.com)"
        : g === "global" || g === "us"
          ? "US / global (api.sendgrid.com)"
          : "Automatic (EU then US introspection)";
    rows.push(["SendGrid API region", label]);
  }
  const masked =
    (c.api_key && String(c.api_key).includes("*")) ||
    c.password === "***" ||
    (c.secret_key && String(c.secret_key).includes("*"));
  rows.push(["Saved secrets", masked ? "•••• (masked in the interface)" : "—"]);
  return rows;
}

function renderSmtpDetailMetaHtml(c) {
  const rows = renderSmtpDetailMetaRows(c);
  return (
    '<dl class="smtp-config-detail-meta">' +
    rows
      .map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`)
      .join("") +
    "</dl>"
  );
}

function smtpDnsBadgeClass(st) {
  if (st === "ok") return "smtp-dns-badge smtp-dns-badge--ok";
  if (st === "fail") return "smtp-dns-badge smtp-dns-badge--fail";
  if (st === "warn") return "smtp-dns-badge smtp-dns-badge--warn";
  return "smtp-dns-badge smtp-dns-badge--na";
}

function buildSmtpRemoteRowExtrasHtml(c) {
  const p = String(c.provider || "").toLowerCase();
  if (!["brevo", "ses", "amazonses", "sendgrid"].includes(p)) {
    return '<div class="smtp-row-extras smtp-row-extras--na" title="API indicators for Brevo, Amazon SES and SendGrid">—</div>';
  }
  if (!c.remote_snapshot || typeof c.remote_snapshot !== "object") {
    return '<div class="smtp-row-extras smtp-row-extras--na" title="Save the config or open the details, then click &quot;Query API&quot; to refresh quotas and DNS">⋯</div>';
  }
  const snap = c.remote_snapshot;
  const d = snap.dns_badges || {};
  const hint = [d.hint, (snap.errors && snap.errors[0]) || ""]
    .filter(Boolean)
    .join(" — ");
  const qs = (snap.quotas && snap.quotas.lines) || [];
  const quotaStr = qs
    .map((l) => escHtml(l))
    .join('<span class="smtp-quota-sep"> · </span>');

  return (
    '<div class="smtp-row-extras" title="' +
    escAttr(
      hint ||
        "SPF / DKIM / DMARC aggregate per provider docs + public DNS if needed",
    ) +
    '">' +
    '<div class="smtp-dns-badges" role="group" aria-label="DNS authentication">' +
    '<span class="' +
    smtpDnsBadgeClass(d.spf) +
    '">SPF</span>' +
    '<span class="' +
    smtpDnsBadgeClass(d.dkim) +
    '">DKIM</span>' +
    '<span class="' +
    smtpDnsBadgeClass(d.dmarc) +
    '">DMARC</span>' +
    "</div>" +
    (quotaStr ? '<div class="smtp-quota-inline">' + quotaStr + "</div>" : "") +
    "</div>"
  );
}

function mergeSmtpRemoteSnapshotIntoState(smtpId, snap) {
  if (!snap || !state.smtpConfigs) return;
  const i = state.smtpConfigs.findIndex((s) => String(s.id) === String(smtpId));
  if (i >= 0) state.smtpConfigs[i].remote_snapshot = snap;
}

function patchSmtpRowExtrasFromState(smtpId) {
  const idEsc = escAttr(String(smtpId));
  const wrap = document.querySelector(
    '.smtp-config-wrap[data-smtp-id="' + idEsc + '"]',
  );
  if (!wrap) return;
  const cfg = (state.smtpConfigs || []).find(
    (s) => String(s.id) === String(smtpId),
  );
  if (!cfg) return;
  const slot = wrap.querySelector(".smtp-row-extras-slot");
  if (!slot) return;
  slot.innerHTML = buildSmtpRemoteRowExtrasHtml(cfg);
}

// --- Campaign sender: API list (Brevo / SES) or manual entry (other providers) ---

function getCampaignSmtpContextForVerifiedSenders() {
  const smtpSel = document.getElementById("smtpConfigSelect");
  const v = smtpSel && smtpSel.value;
  if (!v || v === "") {
    return {
      supportsApi: false,
      reason: "no_smtp",
      hint: null,
      provider: null,
      payload: null,
    };
  }
  if (v === "__new__") {
    const d = collectCampSmtpData();
    if (d.provider === "brevo") {
      if (!d.api_key) {
        return {
          supportsApi: true,
          reason: "inline",
          provider: "brevo",
          payload: null,
        };
      }
      return {
        supportsApi: true,
        reason: "inline",
        provider: "brevo",
        payload: { provider: "brevo", api_key: d.api_key },
      };
    }
    if (d.provider === "ses") {
      if (!d.access_key || !d.secret_key) {
        return {
          supportsApi: true,
          reason: "inline",
          provider: "ses",
          payload: null,
        };
      }
      return {
        supportsApi: true,
        reason: "inline",
        provider: "ses",
        payload: {
          provider: "ses",
          access_key: d.access_key,
          secret_key: d.secret_key,
          region: d.region || "eu-west-3",
        },
      };
    }
    if (d.provider === "sendgrid") {
      if (!d.api_key) {
        return {
          supportsApi: true,
          reason: "inline",
          provider: "sendgrid",
          payload: null,
        };
      }
      const payload = { provider: "sendgrid", api_key: d.api_key };
      if (d.sendgrid_region) payload.sendgrid_region = d.sendgrid_region;
      return {
        supportsApi: true,
        reason: "inline",
        provider: "sendgrid",
        payload,
      };
    }
    return {
      supportsApi: false,
      reason: "other_provider",
      hint: "Manual entry: this provider does not provide a sender list in the app.",
      provider: d.provider,
      payload: null,
    };
  }
  const cfg = (state.smtpConfigs || []).find((s) => String(s.id) === v);
  const p = String((cfg && cfg.provider) || "").toLowerCase();
  // Providers whose verified senders/domains we can list from the API.
  // Domain identities (SES, SendGrid authenticated domains, Mailgun) are
  // handled as editable addresses in the campaign form.
  if (
    [
      "brevo",
      "ses",
      "amazonses",
      "sendgrid",
      "mandrill",
      "postmark",
      "mailgun",
    ].includes(p)
  ) {
    return {
      supportsApi: true,
      reason: "saved",
      provider: p === "amazonses" ? "ses" : p,
      payload: { smtp_config_id: v },
    };
  }
  return {
    supportsApi: false,
    reason: "other_provider",
    hint: "Manual entry: API sender list not available for this provider.",
    provider: p,
    payload: null,
  };
}

function getCampaignSelectedFromMeta() {
  const sel = document.getElementById("fromEmailSelect");
  if (!sel || sel.classList.contains("hidden")) return null;
  const val = String(sel.value || "").toLowerCase();
  return campaignFromIdentityMeta.get(val) || null;
}

function splitEmailAddress(email) {
  const raw = String(email || "").trim();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at >= raw.length - 1) return { local: "", domain: "" };
  return {
    local: raw.slice(0, at),
    domain: raw.slice(at + 1).toLowerCase(),
  };
}

function normalizeVerifiedDomainLocalPart(value) {
  const local = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .split("@")[0]
    .trim();
  return local && VERIFIED_DOMAIN_LOCAL_RE.test(local) ? local : "";
}

function getSenderLocalRotationPartsFromTextarea() {
  const ta = document.getElementById("senderLocalRotationParts");
  const seen = new Set();
  return String((ta && ta.value) || "")
    .split(/\r?\n/)
    .map(normalizeVerifiedDomainLocalPart)
    .filter(Boolean)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getSenderLocalRotationEvery() {
  const el = document.getElementById("senderLocalRotationEvery");
  return Math.max(1, parseInt(el && el.value, 10) || 1);
}

function getVerifiedDomainFromEmailValue() {
  const domain = getCampaignSelectedFromMeta()?.domain || "";
  const inp = document.getElementById("verifiedDomainFromEmail");
  const value = String((inp && inp.value) || "").trim();
  if (!domain) return value;
  const parsed = splitEmailAddress(value);
  if (
    parsed.domain === domain &&
    normalizeVerifiedDomainLocalPart(parsed.local)
  ) {
    return `${parsed.local}@${domain}`;
  }
  const local = normalizeVerifiedDomainLocalPart(value);
  return local ? `${local}@${domain}` : "";
}

function getFromEmailValue() {
  const sel = document.getElementById("fromEmailSelect");
  const inp = document.getElementById("fromEmail");
  if (sel && !sel.classList.contains("hidden")) {
    if (sel.value === CUSTOM_FROM_OPTION) {
      return (inp ? inp.value : "").trim();
    }
    const meta = getCampaignSelectedFromMeta();
    if (meta && meta.domain) return getVerifiedDomainFromEmailValue();
    return (sel.value || "").trim();
  }
  if (inp && !inp.readOnly) {
    return (inp.value || "").trim();
  }
  return "";
}

function resetCampaignVerifiedDomainControls(clearValues = true) {
  const wrap = document.getElementById("verifiedDomainFromWrap");
  const panel = document.getElementById("senderLocalRotationPanel");
  const fields = document.getElementById("senderLocalRotationFields");
  const input = document.getElementById("verifiedDomainFromEmail");
  const enabled = document.getElementById("senderLocalRotationEnabled");
  if (wrap) wrap.classList.add("hidden");
  if (panel) panel.classList.add("hidden");
  if (fields) fields.classList.add("hidden");
  if (input && clearValues) {
    input.value = "";
    delete input.dataset.autoFromValue;
    delete input.dataset.forIdentity;
  }
  if (enabled && clearValues) enabled.checked = false;
  updateSenderLocalRotationHint();
}

function updateCampaignVerifiedDomainControls(preferredEmail = "") {
  const meta = getCampaignSelectedFromMeta();
  const wrap = document.getElementById("verifiedDomainFromWrap");
  const input = document.getElementById("verifiedDomainFromEmail");
  const hint = document.getElementById("verifiedDomainFromHint");
  const panel = document.getElementById("senderLocalRotationPanel");
  const domain = meta && meta.domain ? meta.domain : "";
  if (!domain) {
    if (wrap) wrap.classList.add("hidden");
    if (panel) panel.classList.add("hidden");
    updateSenderLocalRotationHint();
    return;
  }

  if (wrap) wrap.classList.remove("hidden");
  if (panel) panel.classList.remove("hidden");
  if (input) {
    const suggestion = meta.email || `noreply@${domain}`;
    const preferred = String(preferredEmail || "").trim();
    const parsedPreferred = splitEmailAddress(preferred);
    const next = parsedPreferred.domain === domain ? preferred : suggestion;
    const switchedIdentity =
      input.dataset.forIdentity !== String(meta.email || "");
    const cur = String(input.value || "").trim();
    const prevAuto = String(input.dataset.autoFromValue || "").trim();
    if (switchedIdentity || cur === "" || cur === prevAuto) {
      input.value = next;
    }
    input.dataset.autoFromValue = next;
    input.dataset.forIdentity = String(meta.email || "");
  }
  if (hint) {
    hint.textContent = `Verified domain @${domain}: type any local part before “@” (for example alex@${domain}).`;
    hint.classList.remove("hidden");
  }
  updateSenderLocalRotationHint();
}

function updateSenderLocalRotationHint() {
  const hint = document.getElementById("senderLocalRotationHint");
  const fields = document.getElementById("senderLocalRotationFields");
  const enabled = !!document.getElementById("senderLocalRotationEnabled")
    ?.checked;
  const meta = getCampaignSelectedFromMeta();
  const domain = meta && meta.domain ? meta.domain : "";
  const parts = getSenderLocalRotationPartsFromTextarea();
  const every = getSenderLocalRotationEvery();
  if (fields) fields.classList.toggle("hidden", !enabled);
  if (!hint) return;
  if (!domain) {
    hint.textContent = "";
    return;
  }
  if (!enabled) {
    hint.textContent = "";
    return;
  }
  if (parts.length === 0) {
    hint.textContent = `Add local parts to rotate addresses on @${domain}.`;
    return;
  }
  const sample = parts
    .slice(0, 3)
    .map((p) => `${p}@${domain}`)
    .join(" → ");
  hint.textContent = `Rotation ready: ${parts.length} address(es), switching every ${every} email(s). ${sample}${parts.length > 3 ? " → …" : ""}`;
}

function setSenderLocalRotationUiFromConfig(cfg = {}) {
  const enabledEl = document.getElementById("senderLocalRotationEnabled");
  const partsEl = document.getElementById("senderLocalRotationParts");
  const everyEl = document.getElementById("senderLocalRotationEvery");
  if (enabledEl) enabledEl.checked = !!cfg.sender_local_rotation_enabled;
  if (partsEl) {
    const parts = Array.isArray(cfg.sender_local_rotation_parts)
      ? cfg.sender_local_rotation_parts
      : [];
    partsEl.value = parts.map(String).filter(Boolean).join("\n");
  }
  if (everyEl)
    everyEl.value = String(
      Math.max(1, parseInt(cfg.sender_local_rotation_every, 10) || 1),
    );
  updateSenderLocalRotationHint();
}

function applyCampaignFromEmailBlockedMode(message) {
  const sel = document.getElementById("fromEmailSelect");
  const inp = document.getElementById("fromEmail");
  const btn = document.getElementById("refreshVerifiedSendersBtn");
  const hint = document.getElementById("fromEmailListHint");
  campaignFromIdentityMeta = new Map();
  resetCampaignVerifiedDomainControls();
  if (sel) {
    sel.classList.add("hidden");
    sel.innerHTML = "";
  }
  if (btn) btn.classList.add("hidden");
  if (inp) {
    inp.classList.remove("hidden");
    inp.readOnly = true;
    inp.value = "";
    inp.placeholder = message || "—";
  }
  if (hint) {
    hint.textContent =
      message ||
      "Choose an SMTP configuration (Brevo, SendGrid or Amazon SES) to show authorized senders.";
    hint.classList.remove("hidden");
  }
}

function applyCampaignFromEmailManualMode(value) {
  const sel = document.getElementById("fromEmailSelect");
  const inp = document.getElementById("fromEmail");
  const btn = document.getElementById("refreshVerifiedSendersBtn");
  const hint = document.getElementById("fromEmailListHint");
  campaignFromIdentityMeta = new Map();
  resetCampaignVerifiedDomainControls();
  if (sel) {
    sel.classList.add("hidden");
    sel.innerHTML = "";
  }
  if (btn) btn.classList.add("hidden");
  if (inp) {
    inp.classList.remove("hidden");
    inp.readOnly = false;
    inp.placeholder = "newsletter@mondomaine.com";
    inp.value = value != null ? value : "";
  }
  if (hint) {
    hint.textContent =
      "Manual entry: this provider does not offer a sender list in the app.";
    hint.classList.remove("hidden");
  }
}

function applyCampaignFromEmailApiMode(senders, preferredEmail) {
  const sel = document.getElementById("fromEmailSelect");
  const inp = document.getElementById("fromEmail");
  const btn = document.getElementById("refreshVerifiedSendersBtn");
  const hint = document.getElementById("fromEmailListHint");
  campaignFromIdentityMeta = new Map();
  resetCampaignVerifiedDomainControls(false);
  if (inp) {
    inp.classList.add("hidden");
    inp.readOnly = false;
    inp.value = "";
  }
  if (btn) btn.classList.remove("hidden");
  if (sel) {
    sel.classList.remove("hidden");
    sel.innerHTML = "";
    const o0 = document.createElement("option");
    o0.value = "";
    o0.textContent = senders.length
      ? "— Choose a sender or verified domain —"
      : "— No sender available —";
    sel.appendChild(o0);

    (senders || []).forEach((s) => {
      const email = String(s.email || "").trim();
      if (!email) return;
      const domain = String(s.domain || "")
        .trim()
        .toLowerCase();
      const name = String(s.name || "").trim();
      const label =
        String(s.label || "").trim() || (name ? `${name} <${email}>` : email);
      campaignFromIdentityMeta.set(email.toLowerCase(), {
        email,
        name,
        label,
        domain,
      });
      const o = document.createElement("option");
      o.value = email;
      o.textContent = label;
      if (domain) o.dataset.verifiedDomain = domain;
      sel.appendChild(o);
    });

    const selectedMeta = getCampaignSmtpContextForVerifiedSenders();
    const provider = (selectedMeta && selectedMeta.provider) || "";
    const allowCustom =
      CUSTOM_FROM_PROVIDERS.has(provider) || senders.some((s) => s.domain);

    let customOptionSelected = false;
    if (allowCustom) {
      const oCustom = document.createElement("option");
      oCustom.value = CUSTOM_FROM_OPTION;
      oCustom.textContent = "✏️ Custom address…";
      sel.appendChild(oCustom);
    }

    const pref = (preferredEmail || "").trim().toLowerCase();
    const prefParts = splitEmailAddress(pref);
    let picked = "";
    if (pref) {
      const exact = [...sel.options].find(
        (x) => (x.value || "").toLowerCase() === pref,
      );
      if (exact) {
        sel.value = exact.value;
        picked = exact.value;
      } else if (prefParts.domain) {
        const domainMatch = [...campaignFromIdentityMeta.values()].find(
          (m) => m.domain && m.domain === prefParts.domain,
        );
        if (domainMatch) {
          sel.value = domainMatch.email;
          picked = domainMatch.email;
        }
      } else if (allowCustom && pref) {
        sel.value = CUSTOM_FROM_OPTION;
        customOptionSelected = true;
        picked = CUSTOM_FROM_OPTION;
        if (inp) {
          inp.classList.remove("hidden");
          inp.value = preferredEmail || "";
        }
      }
    }
    if (!picked && senders.length === 1 && !allowCustom) {
      sel.value = String(senders[0].email || "");
      picked = sel.value;
    }
    if (!picked && allowCustom) {
      sel.value = CUSTOM_FROM_OPTION;
      customOptionSelected = true;
      picked = CUSTOM_FROM_OPTION;
      if (inp) inp.classList.remove("hidden");
    }
    if (customOptionSelected && inp) {
      inp.classList.remove("hidden");
      if (!pref) inp.value = "";
    } else if (!customOptionSelected && inp) {
      inp.classList.add("hidden");
      inp.value = "";
    }
    updateCampaignVerifiedDomainControls(preferredEmail);
    if (hint) {
      const selectedMeta = getCampaignSelectedFromMeta();
      if (selectedMeta && selectedMeta.domain) {
        hint.textContent = `Verified domain detected: you can send from any address on @${selectedMeta.domain}.`;
        hint.classList.remove("hidden");
      } else if (pref && !picked) {
        hint.textContent =
          "The saved address is not in the current list. Choose a verified sender/domain on " +
          (senders.length ? "provider" : "account") +
          ".";
        hint.classList.remove("hidden");
      } else {
        hint.textContent =
          "Addresses authorized by your provider API. Verified domains allow custom local parts.";
        hint.classList.remove("hidden");
      }
    }
    syncCustomSelect(sel);
  }
}

function ensureFromEmailSelectChangeHook() {
  const sel = document.getElementById("fromEmailSelect");
  if (!sel || sel.dataset.fromHook === "1") return;
  sel.dataset.fromHook = "1";
  sel.addEventListener("change", () => {
    const inp = document.getElementById("fromEmail");
    if (sel.value === CUSTOM_FROM_OPTION && inp) {
      inp.classList.remove("hidden");
      if (!inp.value.trim()) inp.focus();
    } else if (inp) {
      inp.classList.add("hidden");
    }
    updateCampaignVerifiedDomainControls();
    refreshCampaignSendButtonState();
  });
}

async function refreshCampaignVerifiedSenders(opts = {}) {
  const preferredEmail =
    opts.preferredEmail != null ? String(opts.preferredEmail) : "";
  const silent = !!opts.silent;
  const meta = getCampaignSmtpContextForVerifiedSenders();
  const hintEl = document.getElementById("fromEmailListHint");
  ensureFromEmailSelectChangeHook();

  if (!meta.supportsApi) {
    if (meta.reason === "no_smtp") {
      applyCampaignFromEmailBlockedMode("Choose an SMTP configuration first.");
      if (hintEl) {
        hintEl.textContent =
          "For Brevo, SendGrid and Amazon SES, the sender is chosen from the list returned by the API after selecting the SMTP.";
        hintEl.classList.remove("hidden");
      }
    } else {
      applyCampaignFromEmailManualMode(preferredEmail);
      if (meta.hint && hintEl) {
        hintEl.textContent = meta.hint;
        hintEl.classList.remove("hidden");
      }
    }
    refreshCampaignSendButtonState();
    return;
  }

  if (!meta.payload) {
    applyCampaignFromEmailApiMode([], "");
    if (hintEl) {
      const msg =
        meta.provider === "ses"
          ? 'Fill in the IAM keys and SES region, then click "Refresh".'
          : meta.provider === "sendgrid"
            ? 'Fill in the SendGrid API key, then click "Refresh".'
            : 'Fill in the Brevo API key, then click "Refresh".';
      hintEl.textContent = msg;
      hintEl.classList.remove("hidden");
    }
    refreshCampaignSendButtonState();
    return;
  }

  if (!silent && hintEl) {
    hintEl.textContent = "Loading senders…";
    hintEl.classList.remove("hidden");
  }

  try {
    const res = await api("verified_senders", "POST", meta.payload);
    if (!res.success) {
      throw new Error(res.error || "API error");
    }
    const senders = (res.data && res.data.senders) || [];
    applyCampaignFromEmailApiMode(senders, preferredEmail);
    if (hintEl) {
      if (silent) {
        hintEl.classList.toggle("hidden", senders.length > 0);
        hintEl.textContent = senders.length
          ? ""
          : "No sender listed for this account.";
      } else if (senders.length === 0) {
        const who =
          {
            ses: "SES",
            sendgrid: "SendGrid",
            brevo: "Brevo",
            mandrill: "Mandrill",
            postmark: "Postmark",
          }[meta.provider] || "provider";
        hintEl.textContent =
          "No active sender found. Check your " + who + " account.";
        hintEl.classList.remove("hidden");
      } else {
        hintEl.textContent =
          "Addresses authorized by your provider (API). No manual input.";
        hintEl.classList.remove("hidden");
      }
    }
  } catch (e) {
    applyCampaignFromEmailApiMode([], "");
    if (hintEl) {
      hintEl.textContent = "Unable to load list: " + (e.message || String(e));
      hintEl.classList.remove("hidden");
    }
    if (!silent) console.error(e);
  }
  refreshCampaignSendButtonState();
}

/** Sidebar labels panel: remembered between visits */
const SIDEBAR_PANEL_EXPANDED_KEY = "winmail_sidebar_panel_expanded";

/** View persistence (F5 / Ctrl+R): section, template editor, campaigns… */
const UI_STATE_STORAGE_KEY = "winmail_ui_state_v1";
let uiStateRestoreInProgress = false;

// ----------------------------------------------------------------------------
// Per-input persistence (Lab / Settings pages)
//
// Pages tagged with `data-persist-inputs="true"` automatically keep their
// inputs / textareas / selects values across navigation AND app reloads. We
// store them in sessionStorage keyed by element id. Sensitive fields are
// excluded so we never write API keys, passwords or AWS secrets to disk
// (sessionStorage is persisted in the Tauri webview's profile directory).
// ----------------------------------------------------------------------------
const FORM_VALUES_STORAGE_KEY = "winmail_form_values_v1";
const FORM_VALUES_DEBOUNCE_MS = 250;
const FORM_VALUES_SENSITIVE_RE =
  /(api[_-]?key|password|secret|access[_-]?key|secret[_-]?key|token|credential)/i;
let formValuesDebounceTimer = null;
let formValuesApplyInProgress = false;

function isPersistableInput(el) {
  if (!el || !el.id) return false;
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return false;
  if (el.hasAttribute("data-no-persist")) return false;
  if (el.classList.contains("testing-api-key-input")) return false;
  if (el.classList.contains("api-key-input")) return false;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    if (
      type === "password" ||
      type === "file" ||
      type === "hidden" ||
      type === "submit" ||
      type === "button" ||
      type === "reset" ||
      type === "image"
    ) {
      return false;
    }
  }
  const idAndName = el.id + " " + (el.name || "");
  if (FORM_VALUES_SENSITIVE_RE.test(idAndName)) return false;
  return true;
}

function persistableInputsInPage(pageEl) {
  if (!pageEl) return [];
  return Array.from(pageEl.querySelectorAll("input, textarea, select")).filter(
    isPersistableInput,
  );
}

function snapshotFormValues() {
  if (formValuesApplyInProgress) return;
  const snapshot = {};
  const pages = document.querySelectorAll('[data-persist-inputs="true"]');
  for (const page of pages) {
    for (const el of persistableInputsInPage(page)) {
      const id = el.id;
      if (!id) continue;
      if (el.type === "checkbox" || el.type === "radio") {
        snapshot[id] = !!el.checked;
      } else {
        snapshot[id] = el.value;
      }
    }
  }
  try {
    sessionStorage.setItem(
      FORM_VALUES_STORAGE_KEY,
      JSON.stringify({ v: 1, values: snapshot }),
    );
  } catch {
    /* quota / private mode */
  }
}

function loadStoredFormValues() {
  let raw;
  try {
    raw = sessionStorage.getItem(FORM_VALUES_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !parsed.values) return null;
    return parsed.values;
  } catch {
    return null;
  }
}

/**
 * Restore persisted values inside a page (or the whole document if no page is
 * passed). Re-emits a `change` event for each restored element so dependent
 * UI (panel show/hide, related selects) stays in sync.
 */
function applyStoredFormValues(scopeEl) {
  const values = loadStoredFormValues();
  if (!values) return;

  const targets = (
    scopeEl
      ? [scopeEl]
      : Array.from(document.querySelectorAll('[data-persist-inputs="true"]'))
  ).filter(Boolean);
  if (!targets.length) return;

  formValuesApplyInProgress = true;
  try {
    for (const page of targets) {
      for (const el of persistableInputsInPage(page)) {
        const id = el.id;
        if (!(id in values)) continue;
        const stored = values[id];
        if (el.type === "checkbox" || el.type === "radio") {
          const desired = !!stored;
          if (el.checked !== desired) {
            el.checked = desired;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        } else {
          const next = stored == null ? "" : String(stored);
          if (el.tagName === "SELECT") {
            if (next && ![...el.options].some((o) => o.value === next)) {
              // The expected option is not yet there (async populate not done).
              // Skip this element; we'll be called again after the populate.
              continue;
            }
          }
          if (el.value !== next) {
            el.value = next;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
    }
  } finally {
    formValuesApplyInProgress = false;
  }
}

function scheduleFormValuesSnapshot() {
  if (formValuesApplyInProgress) return;
  if (formValuesDebounceTimer) clearTimeout(formValuesDebounceTimer);
  formValuesDebounceTimer = setTimeout(
    snapshotFormValues,
    FORM_VALUES_DEBOUNCE_MS,
  );
}

function installFormValuesPersistence() {
  const handler = (e) => {
    const target = e.target;
    if (!target) return;
    const page = target.closest('[data-persist-inputs="true"]');
    if (!page) return;
    if (!isPersistableInput(target)) return;
    scheduleFormValuesSnapshot();
  };
  document.addEventListener("input", handler);
  document.addEventListener("change", handler);
}

function persistUiState() {
  if (uiStateRestoreInProgress) return;
  try {
    const detail = document.getElementById("campaignDetail");
    const form = document.getElementById("campaignForm");
    const templateModal = document.getElementById("templateEditorModal");
    const codePhase = document.getElementById("templateEditorPhaseCode");
    const templateEditorOpen = !!(
      templateModal && !templateModal.classList.contains("hidden")
    );
    const templateCodePhase =
      templateEditorOpen &&
      !!(codePhase && !codePhase.classList.contains("hidden"));
    const tidEl = document.getElementById("templateId");

    const campaignDetailOpen = !!(
      detail && !detail.classList.contains("hidden")
    );
    const campaignFormOpen = !!(form && !form.classList.contains("hidden"));

    sessionStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        section: state.currentSection || "dashboard",
        templateEditorOpen,
        templateCodePhase,
        editingTemplateId: templateEditorOpen
          ? tidEl && tidEl.value
            ? tidEl.value.trim()
            : ""
          : "",
        campaignDetailOpen,
        campaignDetailId: campaignDetailOpen
          ? String(state.currentCampaignId || "")
          : "",
        campaignFormOpen,
        editingCampaignId: campaignFormOpen
          ? String(state.editingCampaignId || "")
          : "",
      }),
    );
  } catch (e) {
    /* quota / private mode */
  }
}

// ============================================
// HELPER: API
// ============================================

async function api(action, method = "GET", data = null) {
  if (window.winmailNative && window.winmailNative.available) {
    return window.winmailNative.api(action, method, data);
  }
  return { success: false, error: "Native Tauri backend unavailable." };
}

function parseDomainFilters(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(/[,;\n]+/)
    .map((s) => s.trim().replace(/^@+/, "").toLowerCase())
    .filter(Boolean);
}

// ----------------------------------------------------------------------------
// Proxies (per-campaign feature)
// ----------------------------------------------------------------------------
const PROXY_SCHEMES = ["http", "https", "socks5", "socks5h"];

/**
 * Tries to validate a single proxy line client-side, mirroring the rules in
 * `mailer::proxy::ProxySpec::parse`. Returns either `{ ok: true, label }` or
 * `{ ok: false, error }`.
 */
function validateProxyLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return { ok: false, error: "empty" };
  let url;
  if (raw.includes("://")) {
    try {
      url = new URL(raw);
    } catch (e) {
      return { ok: false, error: "URL invalide" };
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (!PROXY_SCHEMES.includes(scheme)) {
      return { ok: false, error: `unsupported scheme '${scheme}'` };
    }
    if (!url.hostname || !url.port) {
      return { ok: false, error: "host:port missing" };
    }
    return {
      ok: true,
      scheme,
      label: `${scheme}://${url.username ? "***@" : ""}${url.hostname}:${url.port}`,
    };
  }
  const parts = raw.split(":");
  if (parts.length === 2) {
    if (!parts[0] || !/^\d+$/.test(parts[1]))
      return { ok: false, error: "host:port invalide" };
    return {
      ok: true,
      scheme: "http",
      label: `http://${parts[0]}:${parts[1]}`,
    };
  }
  if (parts.length === 4) {
    if (!parts[0] || !/^\d+$/.test(parts[1]))
      return { ok: false, error: "host:port:user:pass invalide" };
    return {
      ok: true,
      scheme: "http",
      label: `http://***@${parts[0]}:${parts[1]}`,
    };
  }
  return { ok: false, error: "format non reconnu" };
}

/** Parse the textarea into an array of validated proxy strings. */
function parseProxyTextarea(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const valid = [];
  const invalid = [];
  for (const line of lines) {
    const result = validateProxyLine(line);
    if (result.ok) {
      valid.push(line);
    } else {
      invalid.push({ line, error: result.error });
    }
  }
  return { lines, valid, invalid };
}

/** Read the proxy form section and return the campaign-config slice. */
function collectProxyConfigFromForm() {
  const enabledEl = document.getElementById("proxyEnabled");
  if (!enabledEl) return {};
  const enabled = !!enabledEl.checked;
  if (!enabled) {
    return {
      proxy_enabled: false,
      proxies: [],
    };
  }
  const listEl = document.getElementById("proxyList");
  const parsed = parseProxyTextarea(listEl ? listEl.value : "");
  const rotateEl = document.getElementById("proxyRotationEvery");
  const rotation = Math.max(1, parseInt(rotateEl && rotateEl.value, 10) || 1);
  const rateEnabledEl = document.getElementById("proxyRateLimitEnabled");
  const rateEnabled = !!(rateEnabledEl && rateEnabledEl.checked);
  const maxUsesEl = document.getElementById("proxyMaxUsesPerWindow");
  const windowEl = document.getElementById("proxyRateWindowSecs");
  return {
    proxy_enabled: true,
    proxies: parsed.valid,
    proxy_rotation_every: rotation,
    proxy_rate_limit_enabled: rateEnabled,
    proxy_max_uses_per_window: Math.max(
      1,
      parseInt(maxUsesEl && maxUsesEl.value, 10) || 30,
    ),
    proxy_rate_window_secs: Math.max(
      1,
      parseInt(windowEl && windowEl.value, 10) || 60,
    ),
  };
}

/** Repopulate the proxy form section from a saved campaign config. */
function applyProxyConfigToForm(cfg) {
  const enabledEl = document.getElementById("proxyEnabled");
  const listEl = document.getElementById("proxyList");
  const rotateEl = document.getElementById("proxyRotationEvery");
  const rateEnabledEl = document.getElementById("proxyRateLimitEnabled");
  const maxUsesEl = document.getElementById("proxyMaxUsesPerWindow");
  const windowEl = document.getElementById("proxyRateWindowSecs");
  const enabled = !!(cfg && cfg.proxy_enabled);
  if (enabledEl) enabledEl.checked = enabled;
  if (listEl) {
    const items = Array.isArray(cfg && cfg.proxies) ? cfg.proxies : [];
    listEl.value = items.join("\n");
  }
  if (rotateEl)
    rotateEl.value = String(
      Math.max(1, parseInt((cfg && cfg.proxy_rotation_every) || 1, 10)),
    );
  if (rateEnabledEl)
    rateEnabledEl.checked = !!(cfg && cfg.proxy_rate_limit_enabled);
  if (maxUsesEl)
    maxUsesEl.value = String(
      Math.max(1, parseInt((cfg && cfg.proxy_max_uses_per_window) || 30, 10)),
    );
  if (windowEl)
    windowEl.value = String(
      Math.max(1, parseInt((cfg && cfg.proxy_rate_window_secs) || 60, 10)),
    );
  syncProxyFormVisibility();
  refreshProxyListStatus();
  refreshProxyAccordionSummary();
}

/** Reset the proxy form to its blank state (new campaign). */
function resetProxyFormDefaults() {
  applyProxyConfigToForm({
    proxy_enabled: false,
    proxies: [],
    proxy_rotation_every: 1,
    proxy_rate_limit_enabled: false,
    proxy_max_uses_per_window: 30,
    proxy_rate_window_secs: 60,
  });
}

/** Show/hide the rest of the panel based on the master toggle. */
function syncProxyFormVisibility() {
  const enabled = !!(document.getElementById("proxyEnabled") || {}).checked;
  const body = document.getElementById("proxyConfigBody");
  if (body) body.classList.toggle("hidden", !enabled);
  const rateFields = document.getElementById("proxyRateFields");
  const rateEnabled = !!(document.getElementById("proxyRateLimitEnabled") || {})
    .checked;
  if (rateFields) rateFields.style.opacity = rateEnabled ? "1" : "0.55";
}

/** Update the live counter under the textarea. */
function refreshProxyListStatus() {
  const enabled = !!(document.getElementById("proxyEnabled") || {}).checked;
  const listEl = document.getElementById("proxyList");
  const statusEl = document.getElementById("proxyListStatus");
  if (!statusEl) return;
  if (!enabled || !listEl) {
    statusEl.textContent = "";
    return;
  }
  const parsed = parseProxyTextarea(listEl.value || "");
  if (parsed.lines.length === 0) {
    statusEl.textContent = "";
    return;
  }
  const parts = [`${parsed.valid.length} valide(s)`];
  if (parsed.invalid.length) {
    parts.push(`${parsed.invalid.length} invalide(s)`);
  }
  let html = parts.join(" — ");
  if (parsed.invalid.length) {
    const sample = parsed.invalid
      .slice(0, 3)
      .map((e) => `"${escHtml(e.line)}" (${escHtml(e.error)})`)
      .join("; ");
    html += `<br><span style="color:#ef4444">Invalid rows: ${sample}${parsed.invalid.length > 3 ? ", …" : ""}</span>`;
  }
  statusEl.innerHTML = html;
}

/** Surface a one-line summary on the accordion header. */
function refreshProxyAccordionSummary() {
  const statusEl = document.getElementById("proxyAccordionStatus");
  if (!statusEl) return;
  const enabled = !!(document.getElementById("proxyEnabled") || {}).checked;
  if (!enabled) {
    statusEl.textContent = "";
    return;
  }
  const listEl = document.getElementById("proxyList");
  const parsed = parseProxyTextarea(listEl ? listEl.value : "");
  const rateEnabled = !!(document.getElementById("proxyRateLimitEnabled") || {})
    .checked;
  const parts = [
    `${parsed.valid.length} proxy${parsed.valid.length > 1 ? "s" : ""}`,
  ];
  if (rateEnabled) {
    const maxUses = parseInt(
      (document.getElementById("proxyMaxUsesPerWindow") || {}).value || 30,
      10,
    );
    const win = parseInt(
      (document.getElementById("proxyRateWindowSecs") || {}).value || 60,
      10,
    );
    parts.push(`max ${maxUses}/${win}s`);
  }
  statusEl.textContent = parts.join(" • ");
}

/** One-time wiring of the proxy form events. */
function initProxyFormWiring() {
  const enabledEl = document.getElementById("proxyEnabled");
  if (!enabledEl || enabledEl.dataset.tydraWired === "1") return;
  enabledEl.dataset.tydraWired = "1";

  const listEl = document.getElementById("proxyList");
  const rateEl = document.getElementById("proxyRateLimitEnabled");
  const usesEl = document.getElementById("proxyMaxUsesPerWindow");
  const winEl = document.getElementById("proxyRateWindowSecs");

  enabledEl.addEventListener("change", () => {
    syncProxyFormVisibility();
    refreshProxyListStatus();
    refreshProxyAccordionSummary();
  });
  if (rateEl)
    rateEl.addEventListener("change", () => {
      syncProxyFormVisibility();
      refreshProxyAccordionSummary();
    });
  if (listEl)
    listEl.addEventListener("input", () => {
      refreshProxyListStatus();
      refreshProxyAccordionSummary();
    });
  for (const el of [usesEl, winEl]) {
    if (el)
      el.addEventListener("input", () => {
        refreshProxyAccordionSummary();
      });
  }

  syncProxyFormVisibility();
  refreshProxyListStatus();
  refreshProxyAccordionSummary();
}

function tyI(name, size, cls) {
  return typeof tyIcon === "function" ? tyIcon(name, size, cls || "") : "";
}

/**
 * Render a styled connection-test result banner into `el`.
 * Works for SMTP tests (uses host/port/encryption/authenticated from
 * `res.data` when present) and API-provider pings (just shows success).
 *
 * @param {HTMLElement} el       target element (a <p>/<div>)
 * @param {{success:boolean,data?:object,error?:string}} res  API response
 * @param {{ successLabel?:string, errorLabel?:string }} [opts]
 */
function renderConnTestResult(el, res, opts) {
  if (!el) return;
  opts = opts || {};
  el.classList.remove(
    "hidden",
    "conn-test-result--ok",
    "conn-test-result--err",
  );
  el.classList.add("conn-test-result");
  // Drop any inline color set by older code paths.
  el.style.color = "";

  if (res && res.success) {
    el.classList.add("conn-test-result--ok");
    const d = (res && res.data) || {};
    const title = opts.successLabel || "Connection successful";
    const bits = [];
    if (d.host) bits.push(d.port ? `${d.host}:${d.port}` : String(d.host));
    if (d.encryption) {
      const enc = String(d.encryption).trim();
      if (enc) bits.push(enc.toUpperCase());
    }
    if (d.authenticated) bits.push("authenticated");
    const detail = bits.join(" · ");
    el.innerHTML =
      '<span class="conn-test-icon">' +
      tyI("check-circle", 18) +
      "</span>" +
      '<span class="conn-test-body"><span class="conn-test-title">' +
      escHtml(title) +
      "</span>" +
      (detail
        ? '<span class="conn-test-detail">' + escHtml(detail) + "</span>"
        : "") +
      "</span>";
  } else {
    el.classList.add("conn-test-result--err");
    const msg = (res && res.error) || opts.errorLabel || "Unknown error";
    el.innerHTML =
      '<span class="conn-test-icon">' +
      tyI("x-circle", 18) +
      "</span>" +
      '<span class="conn-test-body"><span class="conn-test-title">' +
      escHtml(opts.errorLabel || "Connection failed") +
      "</span>" +
      '<span class="conn-test-detail">' +
      escHtml(msg) +
      "</span></span>";
  }
}

function tySetAccordionChevron(el, open) {
  if (!el) return;
  el.setAttribute("data-ty-icon", open ? "chevron-down" : "chevron-right");
  if (typeof tyHydrateIconEl === "function") tyHydrateIconEl(el);
  else if (typeof tyIcon === "function") {
    const sz = parseInt(el.getAttribute("data-ty-icon-size") || "18", 10);
    el.innerHTML = tyIcon(open ? "chevron-down" : "chevron-right", sz);
  }
}

function inferEmailColumnFromHeaders(headers) {
  if (!headers || !headers.length) return "";
  const lower = headers.map((h) => String(h).toLowerCase().trim());
  const prefer = [
    "email",
    "e-mail",
    "mail",
    "courriel",
    "e_mail",
    "email address",
    "adresse email",
  ];
  for (const p of prefer) {
    const i = lower.indexOf(p);
    if (i >= 0) return headers[i];
  }
  for (let i = 0; i < lower.length; i++) {
    if (lower[i].includes("email") || lower[i].includes("mail"))
      return headers[i];
  }
  return "";
}

function fillCsvColumnSelect(selectEl, headers, includeEmptyLabel) {
  if (!selectEl) return;
  const cur = selectEl.value;
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = includeEmptyLabel ? "— Ignore —" : "— Choose —";
  selectEl.appendChild(opt0);
  (headers || []).forEach((h) => {
    const o = document.createElement("option");
    o.value = h;
    o.textContent = h;
    selectEl.appendChild(o);
  });
  if (cur && [...selectEl.options].some((o) => o.value === cur))
    selectEl.value = cur;
}

function populateCsvColumnSelects() {
  const h = state.csvHeaders || [];
  fillCsvColumnSelect(document.getElementById("csvEmailColumn"), h, false);
  fillCsvColumnSelect(document.getElementById("csvFirstNameColumn"), h, true);
  fillCsvColumnSelect(document.getElementById("csvLastNameColumn"), h, true);
  fillCsvColumnSelect(document.getElementById("csvFullNameColumn"), h, true);
  document
    .querySelectorAll(
      "#csvCustomVarsBody .csv-custom-var-row select.csv-custom-col",
    )
    .forEach((sel) => fillCsvColumnSelect(sel, h, false));
}

function showCsvMappingPanel(show) {
  const p = document.getElementById("csvMappingPanel");
  if (p) p.classList.toggle("hidden", !show);
}

function clearCsvCustomVarRows() {
  const tb = document.getElementById("csvCustomVarsBody");
  if (tb) tb.innerHTML = "";
}

function addCsvCustomVarRow(varName = "", column = "") {
  const list = document.getElementById("csvCustomVarsBody");
  if (!list) return;
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const row = document.createElement("div");
  row.className = "csv-custom-var-row";
  row.innerHTML = `
    <div class="form-group csv-custom-var-field">
      <label class="csv-custom-field-label" for="csvVarName_${uid}">Variable name</label>
      <input type="text" id="csvVarName_${uid}" class="csv-custom-name" placeholder="e.g. city" value="${escAttr(varName)}" autocomplete="off">
    </div>
    <div class="form-group csv-custom-var-field">
      <label class="csv-custom-field-label" for="csvVarCol_${uid}">CSV column</label>
      <select id="csvVarCol_${uid}" class="csv-column-select csv-custom-col"><option value="">— Choose —</option></select>
    </div>
    <div class="csv-custom-var-actions">
      <button type="button" class="csv-custom-remove-btn" title="Remove this variable" aria-label="Remove this variable">${tyI("trash", 18)}</button>
    </div>`;
  list.appendChild(row);
  const sel = row.querySelector("select.csv-custom-col");
  fillCsvColumnSelect(sel, state.csvHeaders || [], false);
  if (column && sel) {
    const ok = [...sel.options].some((o) => o.value === column);
    if (ok) sel.value = column;
  }
  row.querySelector(".csv-custom-remove-btn")?.addEventListener("click", () => {
    row.remove();
    scheduleCsvMappingReparse();
  });
  row
    .querySelector(".csv-custom-name")
    ?.addEventListener("input", scheduleCsvMappingReparse);
  sel?.addEventListener("change", scheduleCsvMappingReparse);
}

function buildColumnMappingFromForm() {
  if (state.uploadedFileType !== "csv") return null;
  const emailCol = (
    document.getElementById("csvEmailColumn") || {}
  ).value?.trim();
  if (!emailCol) return null;
  const out = { email: emailCol };
  const fn = (
    document.getElementById("csvFirstNameColumn") || {}
  ).value?.trim();
  const ln = (document.getElementById("csvLastNameColumn") || {}).value?.trim();
  const nm = (document.getElementById("csvFullNameColumn") || {}).value?.trim();
  if (fn) out.first_name = fn;
  if (ln) out.last_name = ln;
  if (nm) out.name = nm;
  const custom = {};
  document
    .querySelectorAll("#csvCustomVarsBody .csv-custom-var-row")
    .forEach((tr) => {
      const name = tr.querySelector(".csv-custom-name")?.value?.trim();
      const col = tr.querySelector(".csv-custom-col")?.value?.trim();
      if (name && col) {
        const key = name
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_]/g, "");
        if (key) custom[key] = col;
      }
    });
  if (Object.keys(custom).length) out.custom_variables = custom;
  return out;
}

function csvMappingHasRequiredEmail() {
  if (state.uploadedFileType !== "csv") return true;
  return !!(document.getElementById("csvEmailColumn") || {}).value?.trim();
}

function setCsvMappingWarning(msg) {
  const w = document.getElementById("csvMappingWarning");
  if (!w) return;
  if (!msg) {
    w.textContent = "";
    w.classList.add("hidden");
    return;
  }
  w.textContent = msg;
  w.classList.remove("hidden");
}

async function reparseRecipientsWithCurrentMapping() {
  if (!state.uploadedFilePath) return;
  const ft = state.uploadedFileType;
  const payload = { file_path: state.uploadedFilePath, file_type: ft };
  if (ft === "csv") {
    const m = buildColumnMappingFromForm();
    if (!m || !m.email) {
      state.uploadedTotal = 0;
      setCsvMappingWarning(
        "Choose the column that contains the email address to count recipients.",
      );
      const summaryEl = document.getElementById("domainSummary");
      if (summaryEl) {
        summaryEl.classList.add("hidden");
        summaryEl.textContent = "";
      }
      document.getElementById("domainFilters")?.classList.add("hidden");
      updateUploadFileHint();
      refreshCampaignSendButtonState();
      return;
    }
    payload.column_mapping = m;
    setCsvMappingWarning("");
  }

  const parseRes = await api("parse_recipients", "POST", payload);
  if (!parseRes.success) {
    alert("Parsing error: " + (parseRes.error || ""));
    return;
  }
  state.uploadedTotal = parseRes.data.total || 0;
  if (ft === "csv" && parseRes.data.headers && parseRes.data.headers.length) {
    state.csvHeaders = parseRes.data.headers;
    populateCsvColumnSelects();
  }
  const domains = parseRes.data.domains || {};
  const summaryEl = document.getElementById("domainSummary");
  if (summaryEl) {
    const parts = Object.entries(domains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(
        ([domain, count]) => `${capitalize(domain)}: ${count.toLocaleString()}`,
      );
    summaryEl.textContent =
      parts.join(" | ") + ` (Total: ${state.uploadedTotal.toLocaleString()})`;
    summaryEl.classList.toggle("hidden", state.uploadedTotal === 0);
  }
  document
    .getElementById("domainFilters")
    ?.classList.toggle("hidden", state.uploadedTotal === 0);
  updateUploadFileHint();
  refreshCampaignSendButtonState();
}

function scheduleCsvMappingReparse() {
  if (state.csvMappingReparseTimer) clearTimeout(state.csvMappingReparseTimer);
  state.csvMappingReparseTimer = setTimeout(() => {
    state.csvMappingReparseTimer = null;
    reparseRecipientsWithCurrentMapping();
  }, 400);
}

function applyColumnMappingToForm(mapping) {
  if (!mapping || typeof mapping !== "object") return;
  const setSel = (id, val) => {
    const el = document.getElementById(id);
    if (el && val && [...el.options].some((o) => o.value === val))
      el.value = val;
  };
  setSel("csvEmailColumn", mapping.email);
  setSel("csvFirstNameColumn", mapping.first_name);
  setSel("csvLastNameColumn", mapping.last_name);
  setSel("csvFullNameColumn", mapping.name);
  clearCsvCustomVarRows();
  const cv = mapping.custom_variables;
  if (cv && typeof cv === "object") {
    Object.entries(cv).forEach(([k, col]) => addCsvCustomVarRow(k, col));
  }
}

function initCsvMappingUI() {
  document
    .getElementById("csvAddCustomVarBtn")
    ?.addEventListener("click", () => {
      addCsvCustomVarRow();
      scheduleCsvMappingReparse();
    });
  [
    "csvEmailColumn",
    "csvFirstNameColumn",
    "csvLastNameColumn",
    "csvFullNameColumn",
  ].forEach((id) => {
    document
      .getElementById(id)
      ?.addEventListener("change", scheduleCsvMappingReparse);
  });
}

/** Config to merge server-side: avoids overwriting file_path / SMTP with empty values (e.g. after a failed parse). */
function mergeSafeCampaignConfigForPut() {
  const c = collectCampaignConfig();
  if (!c.file_path) delete c.file_path;
  if (
    !c.smtp_config_id &&
    (!Array.isArray(c.smtp_rotation_ids) || c.smtp_rotation_ids.length === 0)
  ) {
    delete c.smtp_config_id;
  }
  return c;
}

function countSelectedTemplates() {
  return document.querySelectorAll(".template-chip.selected").length;
}

/**
 * New campaign: sending enabled only after analysis (score >= 50 or forced link).
 * Edit: no need to re-analyze - enable as soon as list + templates + SMTP are ready.
 */
function refreshCampaignSendButtonState() {
  const sendBtn = document.getElementById("sendBtn");
  const forceSendLink = document.getElementById("forceSendLink");
  if (!sendBtn) return;
  const cfg = collectCampaignConfig();
  syncCampaignFromEmailVisibility(cfg);

  const hasFile = !!state.uploadedFilePath;
  const hasTemplates = countSelectedTemplates() > 0;
  const smtpSel = document.getElementById("smtpConfigSelect");
  const smtpVal = smtpSel && smtpSel.value;
  const rotationEnabled = !!document.getElementById("smtpRotationEnabled")
    ?.checked;
  const selectedRot = getSelectedSmtpRotationIds();
  const hasSmtp = rotationEnabled
    ? selectedRot.length > 0
    : !!(smtpVal && smtpVal !== "__new__");
  const csvOk = csvMappingHasRequiredEmail();
  const hasRecipients = (state.uploadedTotal || 0) > 0;

  const hasFrom = hasUsableFromEmail(cfg);

  if (state.editingCampaignId) {
    const canSend =
      hasFile && csvOk && hasRecipients && hasTemplates && hasSmtp && hasFrom;
    sendBtn.disabled = !canSend;
    sendBtn.classList.toggle("btn-disabled", !canSend);
    if (forceSendLink) forceSendLink.classList.add("hidden");
    return;
  }

  const baseOk =
    hasFile && csvOk && hasRecipients && hasTemplates && hasSmtp && hasFrom;
  if (!baseOk) {
    sendBtn.disabled = true;
    sendBtn.classList.add("btn-disabled");
    if (forceSendLink) forceSendLink.classList.add("hidden");
    return;
  }

  if (state.scoreData && state.scoreData.score >= 50) {
    sendBtn.disabled = false;
    sendBtn.classList.remove("btn-disabled");
    if (forceSendLink) forceSendLink.classList.add("hidden");
  } else if (state.scoreData && state.scoreData.score < 50) {
    sendBtn.disabled = true;
    sendBtn.classList.add("btn-disabled");
    if (forceSendLink) forceSendLink.classList.remove("hidden");
  } else {
    sendBtn.disabled = true;
    sendBtn.classList.add("btn-disabled");
    if (forceSendLink) forceSendLink.classList.add("hidden");
  }
}

/** Opens a section of the campaign form (the Send button is in "analyze", often collapsed). */
function openCampaignFormAccordionSection(dataSection) {
  const form = document.getElementById("campaignForm");
  if (!form) return;
  form.querySelectorAll(".accordion-section").forEach((sec) => {
    const body = sec.querySelector(".accordion-body");
    const chev = sec.querySelector(".accordion-chevron");
    const isTarget = sec.getAttribute("data-section") === dataSection;
    if (body) body.classList.toggle("hidden", !isTarget);
    if (chev) tySetAccordionChevron(chev, isTarget);
    sec.classList.toggle("open", isTarget);
  });
}

function getSenderNameRotationNamesFromTextarea() {
  const ta = document.getElementById("senderNameRotationNames");
  const seen = new Set();
  return String((ta && ta.value) || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getSenderNameRotationEvery() {
  const el = document.getElementById("senderNameRotationEvery");
  return Math.max(1, parseInt(el && el.value, 10) || 1);
}

function syncSenderNameRotationUi() {
  const enabled = !!document.getElementById("senderNameRotationEnabled")
    ?.checked;
  const group = document.getElementById("fromNameGroup");
  if (group) group.classList.toggle("hidden", enabled);
}

function updateSenderNameRotationHint() {
  syncSenderNameRotationUi();
  const hint = document.getElementById("senderNameRotationHint");
  if (!hint) return;
  const enabled = !!document.getElementById("senderNameRotationEnabled")
    ?.checked;
  const names = getSenderNameRotationNamesFromTextarea();
  const every = getSenderNameRotationEvery();
  const perSmtpNameMode =
    document.getElementById("smtpFromNameMode")?.value === "per_smtp";

  if (!enabled) {
    hint.textContent = "";
    return;
  }
  if (perSmtpNameMode) {
    hint.textContent =
      "Per-SMTP sender names are enabled, so those overrides take priority over this rotation.";
    return;
  }
  if (names.length === 0) {
    hint.textContent =
      "Add at least one name to rotate. Until then, the default display name above will be used.";
    return;
  }
  const sample = names.slice(0, 3).join(" → ");
  hint.textContent = `Rotation ready: ${names.length} name(s), switching every ${every} email(s). ${sample}${names.length > 3 ? " → …" : ""}`;
}

function setSenderNameRotationUiFromConfig(cfg = {}) {
  const enabledEl = document.getElementById("senderNameRotationEnabled");
  const panel = document.getElementById("senderNameRotationPanel");
  const namesEl = document.getElementById("senderNameRotationNames");
  const everyEl = document.getElementById("senderNameRotationEvery");
  const enabled = !!cfg.sender_name_rotation_enabled;
  if (enabledEl) enabledEl.checked = enabled;
  if (panel) panel.classList.toggle("hidden", !enabled);
  if (namesEl) {
    const names = Array.isArray(cfg.sender_name_rotation_names)
      ? cfg.sender_name_rotation_names
      : [];
    namesEl.value = names.map(String).filter(Boolean).join("\n");
  }
  if (everyEl)
    everyEl.value = String(
      Math.max(1, parseInt(cfg.sender_name_rotation_every, 10) || 1),
    );
  updateSenderNameRotationHint();
}

function collectCampaignConfig(extra = {}) {
  const chips = document.querySelectorAll(".template-chip.selected");
  const templateIds = Array.from(chips)
    .map((c) => c.dataset.id)
    .filter(Boolean);
  const smtpSelect = document.getElementById("smtpConfigSelect");
  let smtpId = "";
  if (smtpSelect && smtpSelect.value && smtpSelect.value !== "__new__") {
    smtpId = smtpSelect.value;
  }
  const domainRaw =
    (document.getElementById("domainFilterInput") || {}).value || "";
  const gmailEl = document.getElementById("gmailLastToggle");
  const keepDupEl = document.getElementById("campaignKeepDuplicateEmails");
  const rotationEl = document.getElementById("rotationFrequency");
  const smtpRotationEnabledEl = document.getElementById("smtpRotationEnabled");
  const smtpRotationEveryEl = document.getElementById("smtpRotationEvery");
  const smtpRotationModeEl = document.getElementById("smtpRotationMode");
  const smtpSenderModeEl = document.getElementById("smtpSenderMode");
  const smtpFromNameModeEl = document.getElementById("smtpFromNameMode");
  const smtpRotationEnabled = !!(
    smtpRotationEnabledEl && smtpRotationEnabledEl.checked
  );
  const smtpRotationIds = getSelectedSmtpRotationIds();
  if (smtpRotationEnabled && smtpRotationIds.length === 0 && smtpId)
    smtpRotationIds.push(smtpId);
  const smtpSenderMode =
    smtpSenderModeEl && smtpSenderModeEl.value === "per_smtp"
      ? "per_smtp"
      : "default";
  const smtpFromNameMode =
    smtpFromNameModeEl && smtpFromNameModeEl.value === "per_smtp"
      ? "per_smtp"
      : "global";
  const smtpPerSmtp = collectSmtpPerSenderMapFromUi();
  const senderNameRotationEnabled = !!document.getElementById(
    "senderNameRotationEnabled",
  )?.checked;
  const senderNameRotationNames = getSenderNameRotationNamesFromTextarea();
  const senderLocalRotationEnabled = !!document.getElementById(
    "senderLocalRotationEnabled",
  )?.checked;
  const senderLocalRotationParts = getSenderLocalRotationPartsFromTextarea();
  const senderLocalRotationDomain = getCampaignSelectedFromMeta()?.domain || "";
  const delayMinEl = document.getElementById("delayMin");
  const delayMaxEl = document.getElementById("delayMax");
  const parseDelaySec = (el) => {
    if (!el || String(el.value).trim() === "") return null;
    const n = parseFloat(String(el.value).trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  let delayMin = parseDelaySec(delayMinEl);
  if (delayMin === null) delayMin = 1;
  delayMin = Math.max(0, delayMin);
  let delayMax = parseDelaySec(delayMaxEl);
  if (delayMax === null) delayMax = 3;
  delayMax = Math.max(0, delayMax);
  if (delayMax < delayMin) delayMax = delayMin;

  const base = {
    template_ids: templateIds,
    from_email: getFromEmailValue(),
    from_name: senderNameRotationEnabled
      ? ""
      : (document.getElementById("fromName") || {}).value.trim() || "",
    smtp_config_id: smtpId,
    file_path: state.uploadedFilePath,
    file_type: state.uploadedFileType || "csv",
    total_recipients: state.uploadedTotal,
    unsubscribe_url: localStorage.getItem("tydra_unsub_url") || "",
    delay_min: delayMin,
    delay_max: delayMax,
    domain_filters: parseDomainFilters(domainRaw),
    gmail_last: !!(gmailEl && gmailEl.checked),
    deduplicate_recipients: !(keepDupEl && keepDupEl.checked),
    template_rotation_frequency: Math.max(
      1,
      parseInt(rotationEl && rotationEl.value, 10) || 1,
    ),
    smtp_rotation_enabled: smtpRotationEnabled,
    smtp_rotation_ids: smtpRotationEnabled ? smtpRotationIds : [],
    smtp_rotation_every: Math.max(
      1,
      parseInt(smtpRotationEveryEl && smtpRotationEveryEl.value, 10) || 1,
    ),
    smtp_rotation_mode:
      smtpRotationModeEl && smtpRotationModeEl.value === "parallel"
        ? "parallel"
        : "sequential",
    smtp_sender_mode: smtpSenderMode,
    smtp_from_name_mode: smtpFromNameMode,
    smtp_per_smtp: smtpPerSmtp,
    sender_name_rotation_enabled: senderNameRotationEnabled,
    sender_name_rotation_names: senderNameRotationNames,
    sender_name_rotation_every: getSenderNameRotationEvery(),
    sender_local_rotation_enabled:
      senderLocalRotationEnabled && !!senderLocalRotationDomain,
    sender_local_rotation_parts: senderLocalRotationParts,
    sender_local_rotation_every: getSenderLocalRotationEvery(),
    sender_local_rotation_domain: senderLocalRotationDomain,
    ...collectProxyConfigFromForm(),
    ...extra,
  };
  if (smtpRotationEnabled && smtpRotationIds.length > 0 && !smtpId) {
    base.smtp_config_id = smtpRotationIds[0];
  }
  const cm = buildColumnMappingFromForm();
  if (state.uploadedFileType === "csv" && cm && cm.email) {
    base.column_mapping = cm;
  }
  return base;
}

/** Subset for the template_preview_merge API (list + filters). */
function collectPreviewListConfigOnly() {
  const full = collectCampaignConfig();
  const o = {
    file_path: full.file_path || "",
    file_type: full.file_type || "csv",
    domain_filters: full.domain_filters || [],
    gmail_last: !!full.gmail_last,
    deduplicate_recipients: full.deduplicate_recipients !== false,
  };
  if (full.column_mapping) o.column_mapping = full.column_mapping;
  return o;
}

function updateUploadFileHint() {
  const hint = document.getElementById("uploadFileHint");
  if (!hint) return;
  if (state.uploadedFilePath) {
    const short =
      state.uploadedFilePath.split("/").pop() || state.uploadedFilePath;
    hint.textContent = `File: ${short} — ${(state.uploadedTotal || 0).toLocaleString("en-US")} recipient(s)`;
    hint.classList.remove("hidden");
  } else {
    hint.textContent = "";
    hint.classList.add("hidden");
  }
}

async function ensureSmtpConfigs() {
  if (state.smtpConfigs && state.smtpConfigs.length) return;
  const res = await api("smtp_configs");
  if (res.success) state.smtpConfigs = res.data || [];
}

function smtpLabelForId(id) {
  if (!id) return "—";
  const c = (state.smtpConfigs || []).find((s) => String(s.id) === String(id));
  return c ? c.name || c.host || c.id : id;
}

function getSelectedSmtpRotationIds() {
  const wrap = document.getElementById("smtpRotationSelect");
  if (!wrap) return [];
  return Array.from(
    wrap.querySelectorAll('input[type="checkbox"][data-smtp-id]:checked'),
  )
    .map((el) => String(el.getAttribute("data-smtp-id") || ""))
    .filter(Boolean);
}

function setSelectedSmtpRotationIds(ids) {
  const wanted = new Set((ids || []).map(String));
  const wrap = document.getElementById("smtpRotationSelect");
  if (!wrap) return;
  Array.from(
    wrap.querySelectorAll('input[type="checkbox"][data-smtp-id]'),
  ).forEach((cb) => {
    cb.checked = wanted.has(String(cb.getAttribute("data-smtp-id") || ""));
  });
}

function getSenderRoutingSmtpIds() {
  const rotationEnabled = !!document.getElementById("smtpRotationEnabled")
    ?.checked;
  const ids = rotationEnabled
    ? getSelectedSmtpRotationIds()
    : [String(document.getElementById("smtpConfigSelect")?.value || "")];
  return ids
    .map(String)
    .filter((id) => id && id !== "__new__")
    .filter((id, idx, arr) => arr.indexOf(id) === idx);
}

function collectSmtpPerSenderMapFromUi() {
  const wrap = document.getElementById("smtpSenderOverridesList");
  if (!wrap) return {};
  const out = {};
  wrap.querySelectorAll("[data-smtp-sender-item]").forEach((item) => {
    const smtpId = String(item.getAttribute("data-smtp-id") || "").trim();
    if (!smtpId) return;
    const useDefaultFrom = !!item.querySelector(
      "input[data-smtp-use-default-from]",
    )?.checked;
    const fromEmail = String(
      item.querySelector("input[data-smtp-from-email]")?.value || "",
    ).trim();
    const useGlobalName = !!item.querySelector(
      "input[data-smtp-use-global-name]",
    )?.checked;
    const fromName = String(
      item.querySelector("input[data-smtp-from-name]")?.value || "",
    ).trim();
    out[smtpId] = {
      use_default_from: useDefaultFrom,
      from_email: fromEmail,
      use_global_name: useGlobalName,
      from_name: fromName,
    };
  });
  return out;
}

function renderSmtpSenderOverridesList(preferredMap = null) {
  const wrap = document.getElementById("smtpSenderOverridesList");
  if (!wrap) return;
  const ids = getSenderRoutingSmtpIds();
  const remembered =
    preferredMap && typeof preferredMap === "object"
      ? preferredMap
      : collectSmtpPerSenderMapFromUi();
  const senderMode =
    document.getElementById("smtpSenderMode")?.value === "per_smtp"
      ? "per_smtp"
      : "default";
  const nameMode =
    document.getElementById("smtpFromNameMode")?.value === "per_smtp"
      ? "per_smtp"
      : "global";
  if (ids.length === 0) {
    wrap.innerHTML =
      '<p class="field-hint">Select SMTP to configure sender routing.</p>';
    return;
  }
  wrap.innerHTML = ids
    .map((id) => {
      const smtp = (state.smtpConfigs || []).find(
        (s) => String(s.id) === String(id),
      );
      const label = escHtml(
        smtp ? smtp.name || smtp.host || "Config " + id : id,
      );
      const override =
        remembered && typeof remembered === "object"
          ? remembered[id] || {}
          : {};
      const useDefaultFrom = override.use_default_from !== false;
      const useGlobalName = override.use_global_name !== false;
      const fromEmail = escAttr(override.from_email || "");
      const fromName = escAttr(override.from_name || "");
      const emailInputDisabled =
        senderMode !== "per_smtp" || useDefaultFrom ? " disabled" : "";
      const nameInputDisabled =
        nameMode !== "per_smtp" || useGlobalName ? " disabled" : "";
      return `
      <div class="smtp-sender-override-item" data-smtp-sender-item data-smtp-id="${escAttr(id)}">
        <div class="smtp-sender-override-head">
          <span class="smtp-sender-override-title">${label}</span>
          <div class="smtp-sender-override-toggles">
            <label class="smtp-sender-override-toggle" data-smtp-use-default-from-toggle>
              <input type="checkbox" data-smtp-use-default-from${useDefaultFrom ? " checked" : ""}${senderMode !== "per_smtp" ? " disabled" : ""}>
              <span>Use default From email</span>
            </label>
            <label class="smtp-sender-override-toggle">
              <input type="checkbox" data-smtp-use-global-name${useGlobalName ? " checked" : ""}${nameMode !== "per_smtp" ? " disabled" : ""}>
              <span>Use global sender name</span>
            </label>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group${senderMode !== "per_smtp" ? " hidden" : ""}" data-smtp-from-email-group>
            <label>From email override</label>
            <input type="email" data-smtp-from-email placeholder="sender@domain.com" value="${fromEmail}"${emailInputDisabled}>
          </div>
          <div class="form-group${nameMode !== "per_smtp" ? " hidden" : ""}" data-smtp-from-name-group>
            <label>From name override</label>
            <input type="text" data-smtp-from-name placeholder="Optional" value="${fromName}"${nameInputDisabled}>
          </div>
        </div>
      </div>
    `;
    })
    .join("");
}

function syncSmtpSenderOverridesDisabledState() {
  const senderMode =
    document.getElementById("smtpSenderMode")?.value === "per_smtp"
      ? "per_smtp"
      : "default";
  const nameMode =
    document.getElementById("smtpFromNameMode")?.value === "per_smtp"
      ? "per_smtp"
      : "global";
  const wrap = document.getElementById("smtpSenderOverridesList");
  if (!wrap) return;
  wrap.querySelectorAll("[data-smtp-sender-item]").forEach((item) => {
    const useDefaultFromEl = item.querySelector(
      "input[data-smtp-use-default-from]",
    );
    const useGlobalNameEl = item.querySelector(
      "input[data-smtp-use-global-name]",
    );
    const fromEmailEl = item.querySelector("input[data-smtp-from-email]");
    const fromNameEl = item.querySelector("input[data-smtp-from-name]");
    const useDefaultFromToggle = item.querySelector(
      "[data-smtp-use-default-from-toggle]",
    );
    const fromEmailGroupEl = item.querySelector("[data-smtp-from-email-group]");
    const fromNameGroupEl = item.querySelector("[data-smtp-from-name-group]");
    if (useDefaultFromEl) useDefaultFromEl.disabled = senderMode !== "per_smtp";
    if (useGlobalNameEl) useGlobalNameEl.disabled = nameMode !== "per_smtp";
    if (fromEmailEl)
      fromEmailEl.disabled =
        senderMode !== "per_smtp" || !!useDefaultFromEl?.checked;
    if (fromNameEl)
      fromNameEl.disabled =
        nameMode !== "per_smtp" || !!useGlobalNameEl?.checked;
    if (useDefaultFromToggle)
      useDefaultFromToggle.classList.toggle(
        "hidden",
        senderMode !== "per_smtp",
      );
    if (fromEmailGroupEl)
      fromEmailGroupEl.classList.toggle("hidden", senderMode !== "per_smtp");
    if (fromNameGroupEl)
      fromNameGroupEl.classList.toggle("hidden", nameMode !== "per_smtp");
  });
}

function setSenderRoutingUiFromConfig(cfg = {}) {
  const senderModeEl = document.getElementById("smtpSenderMode");
  const fromNameModeEl = document.getElementById("smtpFromNameMode");
  if (senderModeEl)
    senderModeEl.value =
      cfg.smtp_sender_mode === "per_smtp" ? "per_smtp" : "default";
  if (fromNameModeEl)
    fromNameModeEl.value =
      cfg.smtp_from_name_mode === "per_smtp" ? "per_smtp" : "global";
  renderSmtpSenderOverridesList(
    cfg.smtp_per_smtp && typeof cfg.smtp_per_smtp === "object"
      ? cfg.smtp_per_smtp
      : {},
  );
  syncSmtpSenderOverridesDisabledState();
}

function renderSmtpRotationChecklist(preferredIds = []) {
  const wrap = document.getElementById("smtpRotationSelect");
  if (!wrap) return;
  const preferred = new Set((preferredIds || []).map(String));
  wrap.innerHTML = (state.smtpConfigs || [])
    .map((s) => {
      const id = String(s.id || "");
      const label = escHtml(s.name || s.host || "Config " + id);
      const checked = preferred.has(id) ? " checked" : "";
      return `
      <label class="smtp-rotation-check-item">
        <input type="checkbox" data-smtp-id="${escAttr(id)}"${checked}>
        <span class="smtp-rotation-check-label">${label}</span>
      </label>
    `;
    })
    .join("");
}

function updateSmtpSelectionUiMode() {
  const enabled = !!document.getElementById("smtpRotationEnabled")?.checked;
  const primaryGroup = document.getElementById("smtpPrimaryConfigGroup");
  if (primaryGroup) primaryGroup.classList.toggle("hidden", enabled);
}

function syncRotationSelectionWithPrimarySmtp() {
  const enabled = !!document.getElementById("smtpRotationEnabled")?.checked;
  if (enabled) {
    const primary = document.getElementById("smtpConfigSelect")?.value;
    const ids = getSelectedSmtpRotationIds();
    if (ids.length > 0) {
      const sel = document.getElementById("smtpConfigSelect");
      if (sel && ids[0] !== "__new__") sel.value = ids[0];
      toggleCampaignSmtpNewPanel(false);
    } else if (primary && primary !== "__new__") {
      setSelectedSmtpRotationIds([primary]);
    }
  }
  renderSmtpSenderOverridesList();
  syncSmtpSenderOverridesDisabledState();
}

function setSmtpRotationUiFromConfig(cfg = {}) {
  const enabled = !!cfg.smtp_rotation_enabled;
  const enabledEl = document.getElementById("smtpRotationEnabled");
  const panel = document.getElementById("smtpRotationPanel");
  if (enabledEl) enabledEl.checked = enabled;
  if (panel) panel.classList.toggle("hidden", !enabled);
  updateSmtpSelectionUiMode();
  const everyEl = document.getElementById("smtpRotationEvery");
  if (everyEl)
    everyEl.value = String(
      Math.max(1, parseInt(cfg.smtp_rotation_every, 10) || 1),
    );
  const modeEl = document.getElementById("smtpRotationMode");
  if (modeEl)
    modeEl.value =
      cfg.smtp_rotation_mode === "parallel" ? "parallel" : "sequential";
  const ids = Array.isArray(cfg.smtp_rotation_ids) ? cfg.smtp_rotation_ids : [];
  setSelectedSmtpRotationIds(ids.map(String));
  syncRotationSelectionWithPrimarySmtp();
}

function formatSmtpRoutingLabel(cfg = {}) {
  const ids = Array.isArray(cfg.smtp_rotation_ids)
    ? cfg.smtp_rotation_ids.map(String).filter(Boolean)
    : [];
  if (cfg.smtp_rotation_enabled && ids.length > 0) {
    const labels = ids.map((id) => smtpLabelForId(id));
    const mode =
      cfg.smtp_rotation_mode === "parallel" ? "Parallel" : "Sequential";
    const every = Math.max(1, parseInt(cfg.smtp_rotation_every, 10) || 1);
    return `Rotation ${mode} (x${labels.length}, every ${every} email(s)): ${labels.join(", ")}`;
  }
  return smtpLabelForId(cfg.smtp_config_id);
}

function listSmtpIdsFromConfig(cfg = {}) {
  if (
    cfg.smtp_rotation_enabled &&
    Array.isArray(cfg.smtp_rotation_ids) &&
    cfg.smtp_rotation_ids.length > 0
  ) {
    return cfg.smtp_rotation_ids.map(String).filter(Boolean);
  }
  if (cfg.smtp_config_id) return [String(cfg.smtp_config_id)];
  return [];
}

function getSmtpConfigById(id) {
  return (
    (state.smtpConfigs || []).find((s) => String(s.id) === String(id)) || null
  );
}

function getImplicitFromEmailForSmtpConfig(smtpConfig) {
  if (!smtpConfig || typeof smtpConfig !== "object") return "";
  const provider = String(smtpConfig.provider || "").toLowerCase();
  if (provider !== "smtp" && provider !== "office365") return "";
  return String(smtpConfig.username || "").trim();
}

function canAutoResolveDefaultFromFromSmtp(config = {}) {
  if (!config.smtp_rotation_enabled) return false;
  if (config.smtp_sender_mode === "per_smtp") return false;
  const ids = listSmtpIdsFromConfig(config);
  if (ids.length === 0) return false;
  return ids.every(
    (id) => getImplicitFromEmailForSmtpConfig(getSmtpConfigById(id)) !== "",
  );
}

function syncCampaignFromEmailVisibility(config = null) {
  const group = document.getElementById("fromEmailGroup");
  if (!group) return;
  const cfg =
    config && typeof config === "object" ? config : collectCampaignConfig();
  group.classList.toggle("hidden", canAutoResolveDefaultFromFromSmtp(cfg));
}

function hasUsableFromEmail(config = {}) {
  const globalFrom = String(config.from_email || "").trim();
  if (globalFrom) return true;
  const ids = listSmtpIdsFromConfig(config);
  if (ids.length === 0) return false;
  if (config.smtp_sender_mode !== "per_smtp") {
    return ids.every(
      (id) => getImplicitFromEmailForSmtpConfig(getSmtpConfigById(id)) !== "",
    );
  }
  const per =
    config.smtp_per_smtp && typeof config.smtp_per_smtp === "object"
      ? config.smtp_per_smtp
      : {};
  return ids.every((id) => {
    const row = per[id];
    if (!row || typeof row !== "object") return false;
    if (row.use_default_from !== false) {
      return getImplicitFromEmailForSmtpConfig(getSmtpConfigById(id)) !== "";
    }
    return String(row.from_email || "").trim() !== "";
  });
}

function formatSenderRoutingLabel(cfg = {}) {
  let base = cfg.from_name
    ? `${String(cfg.from_name)} <${String(cfg.from_email || "")}>`
    : String(cfg.from_email || "—");
  const localParts = Array.isArray(cfg.sender_local_rotation_parts)
    ? cfg.sender_local_rotation_parts.map(String).filter(Boolean)
    : [];
  if (
    cfg.sender_local_rotation_enabled &&
    localParts.length > 0 &&
    cfg.sender_local_rotation_domain
  ) {
    const everyLocal = Math.max(
      1,
      parseInt(cfg.sender_local_rotation_every, 10) || 1,
    );
    base = `${localParts.length} From address(es) on @${String(cfg.sender_local_rotation_domain)} rotating every ${everyLocal} email(s)`;
  }
  const senderMode =
    cfg.smtp_sender_mode === "per_smtp"
      ? "per SMTP from email"
      : "default from email";
  let fromNameMode =
    cfg.smtp_from_name_mode === "per_smtp"
      ? "per SMTP sender name"
      : "global sender name";
  const names = Array.isArray(cfg.sender_name_rotation_names)
    ? cfg.sender_name_rotation_names.map(String).filter(Boolean)
    : [];
  if (
    cfg.sender_name_rotation_enabled &&
    names.length > 0 &&
    cfg.smtp_from_name_mode !== "per_smtp"
  ) {
    const every = Math.max(
      1,
      parseInt(cfg.sender_name_rotation_every, 10) || 1,
    );
    fromNameMode = `rotating ${names.length} sender name(s), every ${every} email(s)`;
  }
  return `${base} (${senderMode}, ${fromNameMode})`;
}

function setCampaignFormEditMode(isEdit) {
  const banner = document.getElementById("campaignEditBanner");
  const title = document.getElementById("campaignFormTitle");
  const sub = document.getElementById("campaignFormSubtitle");
  const sendBtn = document.getElementById("sendBtn");
  if (banner) banner.classList.toggle("hidden", !isEdit);
  if (title) title.textContent = isEdit ? "Edit campaign" : "New campaign";
  if (sub) {
    sub.textContent = isEdit
      ? state.resumeCampaignAfterEdit
        ? "Campaign is paused. Adjust settings, then save to resume from the current progress with the new configuration."
        : "Adjust the list, sender, SMTP or templates, save, then start sending to apply the changes."
      : "Import a list, choose your templates, configure the sender and SMTP, then analyze or send.";
  }
  if (sendBtn) {
    const label = isEdit
      ? state.resumeCampaignAfterEdit
        ? "Save & resume"
        : "Save & start sending"
      : "Start sending";
    sendBtn.innerHTML =
      tyI("send", 20) +
      '<span class="ty-btn-txt">' +
      escHtml(label) +
      "</span>";
  }
}

function resetNewCampaignForm() {
  state.editingCampaignId = null;
  state.resumeCampaignAfterEdit = false;
  state.editReturnToMonitoringId = null;
  setCampaignFormEditMode(false);
  const ids = ["campaignName", "fromName", "domainFilterInput"];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  applyCampaignFromEmailBlockedMode("Choose an SMTP configuration first.");
  const delayMin = document.getElementById("delayMin");
  const delayMax = document.getElementById("delayMax");
  if (delayMin) delayMin.value = "1";
  if (delayMax) delayMax.value = "3";
  const gmail = document.getElementById("gmailLastToggle");
  if (gmail) gmail.checked = false;
  const keepDup = document.getElementById("campaignKeepDuplicateEmails");
  if (keepDup) keepDup.checked = false;
  const rot = document.getElementById("rotationFrequency");
  if (rot) rot.value = "1";
  const smtp = document.getElementById("smtpConfigSelect");
  if (smtp) smtp.value = "";
  setSmtpRotationUiFromConfig({
    smtp_rotation_enabled: false,
    smtp_rotation_ids: [],
    smtp_rotation_every: 1,
    smtp_rotation_mode: "sequential",
  });
  setSenderRoutingUiFromConfig({
    smtp_sender_mode: "default",
    smtp_from_name_mode: "global",
    smtp_per_smtp: {},
  });
  setSenderNameRotationUiFromConfig({
    sender_name_rotation_enabled: false,
    sender_name_rotation_names: [],
    sender_name_rotation_every: 1,
  });
  setSenderLocalRotationUiFromConfig({
    sender_local_rotation_enabled: false,
    sender_local_rotation_parts: [],
    sender_local_rotation_every: 1,
  });
  resetProxyFormDefaults();
  const campPanel = document.getElementById("campaignSmtpNewPanel");
  if (campPanel) campPanel.classList.add("hidden");
  clearCampSmtpForm();
  const fileInput = document.getElementById("recipientsFile");
  if (fileInput) fileInput.value = "";
  state.uploadedFilePath = null;
  state.uploadedFileType = null;
  state.uploadedTotal = 0;
  state.csvHeaders = [];
  clearCsvCustomVarRows();
  showCsvMappingPanel(false);
  setCsvMappingWarning("");
  [
    "csvEmailColumn",
    "csvFirstNameColumn",
    "csvLastNameColumn",
    "csvFullNameColumn",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.innerHTML =
        '<option value="">' +
        (id === "csvEmailColumn" ? "— Choose —" : "— Ignore —") +
        "</option>";
  });
  updateUploadFileHint();
  document
    .querySelectorAll(".template-chip.selected")
    .forEach((c) => c.classList.remove("selected"));
  const summaryEl = document.getElementById("domainSummary");
  if (summaryEl) {
    summaryEl.textContent = "";
    summaryEl.classList.add("hidden");
  }
  const filtersEl = document.getElementById("domainFilters");
  if (filtersEl) filtersEl.classList.add("hidden");
  const scoreDisplay = document.getElementById("scoreDisplay");
  if (scoreDisplay) {
    scoreDisplay.classList.add("hidden");
    scoreDisplay.innerHTML = "";
  }
  const sendBtn = document.getElementById("sendBtn");
  const forceLink = document.getElementById("forceSendLink");
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.classList.add("btn-disabled");
  }
  if (forceLink) forceLink.classList.add("hidden");
  state.scoreData = null;
}

async function backToCampaignListFromForm() {
  const returnToMonitoringId = state.editReturnToMonitoringId;
  if (state.editingCampaignId) {
    const nameEl = document.getElementById("campaignName");
    const name = nameEl ? nameEl.value.trim() : "Campaign";
    const config = mergeSafeCampaignConfigForPut();
    const putRes = await api(
      "campaign&id=" + encodeURIComponent(state.editingCampaignId),
      "PUT",
      { name, config },
    );
    if (!putRes.success) {
      alert("Unable to save campaign: " + (putRes.error || ""));
      return;
    }
  }

  document.getElementById("campaignForm").classList.add("hidden");
  resetNewCampaignForm();
  if (returnToMonitoringId) {
    await showCampaignDetail(returnToMonitoringId);
  } else {
    document.getElementById("campaignsList").classList.remove("hidden");
    document.getElementById("newCampaignBtn").classList.remove("hidden");
    await loadCampaigns();
  }
}

function campaignUploadUiIsVisible() {
  const zone = document.getElementById("uploadZone");
  if (!zone) return false;
  const page = document.getElementById("page-campaigns");
  return !page || !page.classList.contains("hidden");
}

async function openRecipientFilePicker() {
  let nativeHandled = false;
  try {
    nativeHandled = await pickRecipientFileNative();
  } catch (err) {
    console.warn("Native file picker failed, using HTML fallback:", err);
  }
  if (nativeHandled) return;
  document.getElementById("recipientsFile")?.click();
}

function initUploadDragDrop() {
  const zone = document.getElementById("uploadZone");
  const input = document.getElementById("recipientsFile");
  const placeholder = document.getElementById("uploadPlaceholder");
  if (!zone || !input) return;

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const openFromClick = (e) => {
    stop(e);
    void openRecipientFilePicker();
  };
  zone.addEventListener("click", openFromClick);
  placeholder?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openFromClick(e);
  });

  ["dragenter", "dragover"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      stop(e);
      zone.classList.add("drag-active");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    zone.addEventListener(ev, (e) => {
      stop(e);
      zone.classList.remove("drag-active");
    });
  });

  // Browser/Linux fallback: when the WebView exposes File objects, keep the
  // existing chunked upload path. On Windows/Tauri, drops are often captured by
  // the native webview layer and exposed through onDragDropEvent below instead.
  zone.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const dt = new DataTransfer();
    dt.items.add(files[0]);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  if (state.uploadNativeDropInit) return;
  state.uploadNativeDropInit = true;
  const getWebview = window.__TAURI__?.webview?.getCurrentWebview;
  const getWindow = window.__TAURI__?.window?.getCurrentWindow;
  const target =
    typeof getWebview === "function"
      ? getWebview()
      : typeof getWindow === "function"
        ? getWindow()
        : null;
  if (target && typeof target.onDragDropEvent === "function") {
    target
      .onDragDropEvent(async (event) => {
        if (!campaignUploadUiIsVisible()) return;
        const zone = document.getElementById("uploadZone");
        if (event.payload?.type === "enter" || event.payload?.type === "over") {
          zone?.classList.add("drag-active");
          return;
        }
        if (event.payload?.type === "leave") {
          zone?.classList.remove("drag-active");
          return;
        }
        if (event.payload?.type === "drop") {
          zone?.classList.remove("drag-active");
          const path = event.payload.paths && event.payload.paths[0];
          if (!path) return;
          try {
            await importRecipientFilePath(path);
          } catch (err) {
            alert("Error during upload: " + formatUploadError(err));
          }
        }
      })
      .catch((err) => console.warn("Native file-drop hook failed", err));
  }
}

async function openEditCampaign(campaignId, options = {}) {
  const res = await api("campaign&id=" + encodeURIComponent(campaignId));
  if (!res.success || !res.data) {
    alert("Unable to load campaign.");
    return;
  }
  const c = res.data;
  let campaignStatus = c.status;
  const shouldResumeAfterEdit = !!options.resumeAfterEdit;
  if (campaignStatus === "running") {
    if (!options.autoPause) {
      alert("Cannot edit a running campaign. Pause it first, then edit.");
      return;
    }
    const pauseRes = await api("pause", "POST", { campaign_id: campaignId });
    if (!pauseRes.success) {
      alert("Pause before edit failed: " + (pauseRes.error || ""));
      return;
    }
    state.paused = true;
    campaignStatus = "paused";
    c.status = "paused";
  }

  state.scoreData = null;
  state.editingCampaignId = campaignId;
  state.resumeCampaignAfterEdit =
    shouldResumeAfterEdit || campaignStatus === "paused";
  state.editReturnToMonitoringId = state.resumeCampaignAfterEdit
    ? campaignId
    : null;
  setCampaignFormEditMode(true);

  const list = document.getElementById("campaignsList");
  const form = document.getElementById("campaignForm");
  const detail = document.getElementById("campaignDetail");
  const newBtn = document.getElementById("newCampaignBtn");
  if (list) list.classList.add("hidden");
  if (detail) detail.classList.add("hidden");
  if (form) form.classList.remove("hidden");
  if (newBtn) newBtn.classList.add("hidden");
  document.getElementById("campaignsEmptyState")?.classList.add("hidden");
  stopCampaignMonitor();

  const cfg = c.config || {};
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v != null && v !== "" ? v : "";
  };

  setVal("campaignName", c.name || "");
  setVal("fromName", cfg.from_name || "");
  setVal("delayMin", cfg.delay_min != null ? cfg.delay_min : 1);
  setVal("delayMax", cfg.delay_max != null ? cfg.delay_max : 3);
  const gmailEl = document.getElementById("gmailLastToggle");
  if (gmailEl) gmailEl.checked = !!cfg.gmail_last;
  const keepDupEl = document.getElementById("campaignKeepDuplicateEmails");
  if (keepDupEl) keepDupEl.checked = cfg.deduplicate_recipients === false;
  const rot = document.getElementById("rotationFrequency");
  if (rot) rot.value = String(cfg.template_rotation_frequency || 1);
  setSmtpRotationUiFromConfig(cfg);
  setSenderNameRotationUiFromConfig(cfg);
  setSenderLocalRotationUiFromConfig(cfg);

  const df = cfg.domain_filters || [];
  const domainInput = document.getElementById("domainFilterInput");
  if (domainInput) {
    domainInput.value =
      Array.isArray(df) && df.length
        ? df.map((d) => (String(d).startsWith("@") ? d : "@" + d)).join(", ")
        : "";
  }

  await populateTemplateChips();
  await populateSmtpSelect(cfg.smtp_config_id || null, {
    preferredFromEmail: cfg.from_email || "",
    preferredRotationIds: Array.isArray(cfg.smtp_rotation_ids)
      ? cfg.smtp_rotation_ids
      : [],
    preferredSenderMap:
      cfg.smtp_per_smtp && typeof cfg.smtp_per_smtp === "object"
        ? cfg.smtp_per_smtp
        : {},
  });
  setSenderLocalRotationUiFromConfig(cfg);
  setSenderRoutingUiFromConfig(cfg);
  applyProxyConfigToForm(cfg);
  document.getElementById("campaignSmtpNewPanel")?.classList.add("hidden");

  const templateIds = (cfg.template_ids || []).map(String);
  document.querySelectorAll(".template-chip").forEach((chip) => {
    chip.classList.toggle(
      "selected",
      templateIds.includes(String(chip.dataset.id)),
    );
  });

  state.uploadedFilePath = cfg.file_path || null;
  state.uploadedFileType = cfg.file_type || "csv";
  state.uploadedTotal = cfg.total_recipients || 0;

  if (state.uploadedFilePath) {
    if (state.uploadedFileType === "csv") {
      const peekRes = await api("parse_recipients", "POST", {
        file_path: state.uploadedFilePath,
        file_type: "csv",
      });
      if (!peekRes.success) {
        state.uploadedFilePath = null;
        state.uploadedTotal = 0;
        alert("The original file was not found. Import a new list.");
      } else {
        state.csvHeaders = peekRes.data.headers || [];
        showCsvMappingPanel(state.csvHeaders.length > 0);
        populateCsvColumnSelects();
        if (cfg.column_mapping && typeof cfg.column_mapping === "object") {
          applyColumnMappingToForm(cfg.column_mapping);
        } else {
          const guess = inferEmailColumnFromHeaders(state.csvHeaders);
          const em = document.getElementById("csvEmailColumn");
          if (em && guess && [...em.options].some((o) => o.value === guess))
            em.value = guess;
        }
        await reparseRecipientsWithCurrentMapping();
      }
    } else {
      showCsvMappingPanel(false);
      clearCsvCustomVarRows();
      state.csvHeaders = [];
      setCsvMappingWarning("");
      const parseRes = await api("parse_recipients", "POST", {
        file_path: state.uploadedFilePath,
        file_type: "txt",
      });
      if (parseRes.success) {
        state.uploadedTotal = parseRes.data.total || state.uploadedTotal;
        const domains = parseRes.data.domains || {};
        const summaryEl = document.getElementById("domainSummary");
        if (summaryEl) {
          const parts = Object.entries(domains)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(
              ([domain, count]) =>
                `${capitalize(domain)}: ${count.toLocaleString()}`,
            );
          summaryEl.textContent =
            parts.join(" | ") +
            ` (Total: ${state.uploadedTotal.toLocaleString()})`;
          summaryEl.classList.toggle("hidden", state.uploadedTotal === 0);
        }
        document
          .getElementById("domainFilters")
          ?.classList.toggle("hidden", state.uploadedTotal === 0);
      } else {
        state.uploadedFilePath = null;
        state.uploadedTotal = 0;
        alert("The original file was not found. Import a new list.");
      }
    }
  } else {
    state.csvHeaders = [];
    clearCsvCustomVarRows();
    showCsvMappingPanel(false);
    setCsvMappingWarning("");
    const summaryEl = document.getElementById("domainSummary");
    if (summaryEl) {
      summaryEl.classList.add("hidden");
      summaryEl.textContent = "";
    }
    document.getElementById("domainFilters")?.classList.add("hidden");
  }

  updateUploadFileHint();
  refreshCampaignSendButtonState();
  const sendBtnAfterLoad = document.getElementById("sendBtn");
  if (
    state.editingCampaignId &&
    sendBtnAfterLoad &&
    !sendBtnAfterLoad.disabled
  ) {
    openCampaignFormAccordionSection("analyze");
  }
}

function setSmtpApiKeyUiForProvider(provider, labelId, inputId) {
  const label = document.getElementById(labelId);
  const input = document.getElementById(inputId);
  if (!label || !input) return;
  const map = {
    brevo: { t: "API key", ph: "xkeysib-…" },
    sendgrid: { t: "SendGrid API key", ph: "SG.xxx…" },
    postmark: {
      t: "Jeton serveur Postmark",
      ph: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    },
    mandrill: { t: "Mandrill API key", ph: "md-XXXXXXXX..." },
    mailgun: { t: "Mailgun private API key", ph: "key-…" },
  };
  const m = map[provider] || { t: "API key", ph: "…" };
  label.textContent = m.t;
  input.placeholder = m.ph;
}

function applyMicrosoft365SmtpDefaults(hostId, portId, userId) {
  const host = document.getElementById(hostId);
  const port = document.getElementById(portId);
  const user = userId ? document.getElementById(userId) : null;
  if (host && !String(host.value || "").trim())
    host.value = "smtp.office365.com";
  const pv = port ? String(port.value || "").trim() : "";
  if (port && (!pv || pv === "0")) port.value = "587";
  if (user) user.placeholder = "address@domain.com (Microsoft 365 account)";
}

function toggleCampSmtpFields(provider) {
  const apiKeyGroup = document.getElementById("campSmtpApiKeyGroup");
  const sesGroup = document.getElementById("campSmtpSesGroup");
  const o365 = document.getElementById("campSmtpOffice365Group");
  const credFields = document.querySelectorAll(".camp-smtp-credentials");
  const isSes = provider === "ses";
  const isSmtpLike = provider === "smtp" || provider === "office365";

  if (sesGroup) sesGroup.classList.toggle("hidden", !isSes);
  if (o365) o365.classList.toggle("hidden", provider !== "office365");
  if (apiKeyGroup) apiKeyGroup.classList.toggle("hidden", isSes || isSmtpLike);
  credFields.forEach((el) => el.classList.toggle("hidden", !isSmtpLike));

  if (!isSes && !isSmtpLike) {
    setSmtpApiKeyUiForProvider(
      provider,
      "campSmtpApiKeyLabel",
      "campSmtpApiKey",
    );
  }
  const cu = document.getElementById("campSmtpUser");
  if (cu) {
    if (provider === "office365")
      cu.placeholder = "address@domain.com (Microsoft 365 account)";
    else if (provider === "smtp") cu.placeholder = "login SMTP";
  }
}

function clearCampSmtpForm() {
  [
    "campSmtpName",
    "campSmtpApiKey",
    "campSmtpHost",
    "campSmtpUser",
    "campSmtpPass",
    "campAwsAccessKey",
    "campAwsSecretKey",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const port = document.getElementById("campSmtpPort");
  if (port) port.value = "587";
  const awsReg = document.getElementById("campAwsRegion");
  if (awsReg) awsReg.value = "eu-west-3";
  const prov = document.getElementById("campSmtpProvider");
  if (prov) {
    prov.value = "brevo";
    prov.selectedIndex = [...prov.options].findIndex(
      (o) => o.value === "brevo",
    );
    toggleCampSmtpFields("brevo");
    syncCustomSelect(prov);
  }
  const tr = document.getElementById("campSmtpTestResult");
  if (tr) {
    tr.textContent = "";
    tr.classList.add("hidden");
  }
}

function toggleCampaignSmtpNewPanel(show) {
  const p = document.getElementById("campaignSmtpNewPanel");
  if (p) p.classList.toggle("hidden", !show);
  if (show) {
    clearCampSmtpForm();
    const prov = document.getElementById("campSmtpProvider");
    if (prov) {
      toggleCampSmtpFields(prov.value);
      syncCustomSelect(prov);
    }
    if (typeof tyHydrateIcons === "function") tyHydrateIcons(p);
    setTimeout(() => {
      const first = document.getElementById("campSmtpName");
      if (first) first.focus({ preventScroll: true });
    }, 80);
  }
}

function onCampaignSmtpSelectChange() {
  if (state.suppressSmtpSelectChange) return;
  const sel = document.getElementById("smtpConfigSelect");
  if (!sel) return;
  if (
    document.getElementById("smtpRotationEnabled")?.checked &&
    sel.value &&
    sel.value !== "__new__"
  ) {
    setSelectedSmtpRotationIds([sel.value, ...getSelectedSmtpRotationIds()]);
  }
  if (sel.value === "__new__") {
    toggleCampaignSmtpNewPanel(true);
  } else {
    toggleCampaignSmtpNewPanel(false);
  }
  syncRotationSelectionWithPrimarySmtp();
  syncCampaignFromEmailVisibility();
  refreshCampaignSendButtonState();
  void refreshCampaignVerifiedSenders({ silent: true });
}

function collectCampSmtpData() {
  const get = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  const provider = get("campSmtpProvider") || "brevo";
  const base = {
    name: get("campSmtpName"),
    provider,
    api_key: get("campSmtpApiKey"),
    host: get("campSmtpHost"),
    port: get("campSmtpPort"),
    username: get("campSmtpUser"),
    password: get("campSmtpPass"),
  };
  if (provider === "ses") {
    base.access_key = get("campAwsAccessKey");
    base.secret_key = get("campAwsSecretKey");
    const regEl = document.getElementById("campAwsRegion");
    base.region = regEl && regEl.value ? regEl.value.trim() : "eu-west-3";
    base.api_key = "";
  }
  if (provider === "office365") {
    base.encryption = "tls";
    if (!base.host) base.host = "smtp.office365.com";
    if (!base.port) base.port = "587";
  }
  return base;
}

async function testCampSmtpInline() {
  let from = getFromEmailValue();
  if (!from) from = "test@example.com";
  const res = await api("test_smtp", "POST", {
    ...collectCampSmtpData(),
    from_email: from,
  });
  renderConnTestResult(document.getElementById("campSmtpTestResult"), res);
}

async function saveCampSmtpAndUse() {
  const data = collectCampSmtpData();
  if (!data.name) return alert("Enter a name for this SMTP configuration.");
  if (data.provider === "office365") {
    if (!data.username)
      return alert(
        "Microsoft 365: the SMTP user must be the account’s full email address.",
      );
    if (!data.password)
      return alert(
        "Microsoft 365: the password (or app password) is required.",
      );
  }
  if (data.provider === "ses") {
    if (!data.access_key || !data.secret_key) {
      return alert(
        "Amazon SES: fill in the IAM Access Key ID and Secret Access Key (both are required).",
      );
    }
  }
  const res = await api("smtp_configs", "POST", data);
  if (!res.success) return alert("Error: " + (res.error || ""));
  const newId = res.data && res.data.id;
  if (!newId) return alert("Unexpected server response.");
  await populateSmtpSelect(newId);
  toggleCampaignSmtpNewPanel(false);
  const tr = document.getElementById("campSmtpTestResult");
  if (tr) {
    tr.classList.add("hidden");
    tr.textContent = "";
  }
  const campSes = document.getElementById("campSesInspectResult");
  if (campSes) {
    campSes.classList.add("hidden");
    campSes.innerHTML = "";
  }
}

function initCampaignSmtpInline() {
  const form = document.getElementById("campaignForm");
  if (!form || form.dataset.smtpInlineInit === "1") return;
  form.dataset.smtpInlineInit = "1";

  ensureFromEmailSelectChangeHook();
  document
    .getElementById("fromEmail")
    ?.addEventListener("input", refreshCampaignSendButtonState);

  const prov = document.getElementById("campSmtpProvider");
  if (prov) {
    prov.addEventListener("change", () => {
      toggleCampSmtpFields(prov.value);
      if (prov.value === "office365") {
        applyMicrosoft365SmtpDefaults(
          "campSmtpHost",
          "campSmtpPort",
          "campSmtpUser",
        );
      }
      void refreshCampaignVerifiedSenders({ silent: true });
    });
    toggleCampSmtpFields(prov.value);
  }

  const sel = document.getElementById("smtpConfigSelect");
  if (sel) sel.addEventListener("change", onCampaignSmtpSelectChange);
  const rotEnabled = document.getElementById("smtpRotationEnabled");
  const rotPanel = document.getElementById("smtpRotationPanel");
  if (rotEnabled) {
    rotEnabled.addEventListener("change", () => {
      if (rotPanel) rotPanel.classList.toggle("hidden", !rotEnabled.checked);
      updateSmtpSelectionUiMode();
      syncRotationSelectionWithPrimarySmtp();
      syncCampaignFromEmailVisibility();
      void refreshCampaignVerifiedSenders({ silent: true });
      refreshCampaignSendButtonState();
    });
  }
  document
    .getElementById("smtpRotationSelect")
    ?.addEventListener("change", () => {
      syncRotationSelectionWithPrimarySmtp();
      syncCampaignFromEmailVisibility();
      void refreshCampaignVerifiedSenders({ silent: true });
      refreshCampaignSendButtonState();
    });
  document
    .getElementById("smtpRotationEvery")
    ?.addEventListener("input", refreshCampaignSendButtonState);
  document
    .getElementById("smtpRotationMode")
    ?.addEventListener("change", refreshCampaignSendButtonState);
  document.getElementById("smtpSenderMode")?.addEventListener("change", () => {
    syncSmtpSenderOverridesDisabledState();
    syncCampaignFromEmailVisibility();
    refreshCampaignSendButtonState();
  });
  document
    .getElementById("smtpFromNameMode")
    ?.addEventListener("change", () => {
      syncSmtpSenderOverridesDisabledState();
      updateSenderNameRotationHint();
      refreshCampaignSendButtonState();
    });
  document
    .getElementById("smtpSenderOverridesList")
    ?.addEventListener("change", () => {
      syncSmtpSenderOverridesDisabledState();
      refreshCampaignSendButtonState();
    });
  document
    .getElementById("smtpSenderOverridesList")
    ?.addEventListener("input", refreshCampaignSendButtonState);

  const senderNameRotationEnabled = document.getElementById(
    "senderNameRotationEnabled",
  );
  const senderNameRotationPanel = document.getElementById(
    "senderNameRotationPanel",
  );
  if (senderNameRotationEnabled) {
    senderNameRotationEnabled.addEventListener("change", () => {
      if (senderNameRotationPanel) {
        senderNameRotationPanel.classList.toggle(
          "hidden",
          !senderNameRotationEnabled.checked,
        );
      }
      updateSenderNameRotationHint();
      refreshCampaignSendButtonState();
    });
  }
  ["fromName", "senderNameRotationNames", "senderNameRotationEvery"].forEach(
    (id) => {
      document.getElementById(id)?.addEventListener("input", () => {
        updateSenderNameRotationHint();
        refreshCampaignSendButtonState();
      });
    },
  );

  document
    .getElementById("verifiedDomainFromEmail")
    ?.addEventListener("input", refreshCampaignSendButtonState);
  document
    .getElementById("senderLocalRotationEnabled")
    ?.addEventListener("change", () => {
      updateSenderLocalRotationHint();
      refreshCampaignSendButtonState();
    });
  ["senderLocalRotationParts", "senderLocalRotationEvery"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      updateSenderLocalRotationHint();
      refreshCampaignSendButtonState();
    });
  });

  document
    .getElementById("refreshVerifiedSendersBtn")
    ?.addEventListener("click", () => {
      void refreshCampaignVerifiedSenders({ silent: false });
      if (typeof tyHydrateIcons === "function") tyHydrateIcons(form);
    });

  document.getElementById("campAwsRegion")?.addEventListener("change", () => {
    const smtpSel = document.getElementById("smtpConfigSelect");
    if (smtpSel && smtpSel.value === "__new__")
      void refreshCampaignVerifiedSenders({ silent: true });
  });
  ["campAwsAccessKey", "campAwsSecretKey"].forEach((id) => {
    document.getElementById(id)?.addEventListener("blur", () => {
      const smtpSel = document.getElementById("smtpConfigSelect");
      if (smtpSel && smtpSel.value === "__new__")
        void refreshCampaignVerifiedSenders({ silent: true });
    });
  });
  document.getElementById("campSmtpApiKey")?.addEventListener("blur", () => {
    const smtpSel = document.getElementById("smtpConfigSelect");
    if (smtpSel && smtpSel.value === "__new__") {
      const d = collectCampSmtpData();
      if (d.provider === "brevo" && d.api_key)
        void refreshCampaignVerifiedSenders({ silent: true });
    }
  });

  document
    .getElementById("campSmtpSaveBtn")
    ?.addEventListener("click", saveCampSmtpAndUse);
  document
    .getElementById("campSmtpTestBtn")
    ?.addEventListener("click", testCampSmtpInline);
  document
    .getElementById("campSesInspectBtn")
    ?.addEventListener("click", () => runSesInspect("camp"));
  document
    .getElementById("campSesProbeAllBtn")
    ?.addEventListener("click", () => runSesProbeAllRegions("camp"));
  if (rotPanel && rotEnabled)
    rotPanel.classList.toggle("hidden", !rotEnabled.checked);
  updateSmtpSelectionUiMode();
  renderSmtpSenderOverridesList();
  syncSmtpSenderOverridesDisabledState();
  syncCampaignFromEmailVisibility();
  updateSenderNameRotationHint();
}

// ============================================
// NAVIGATION
// ============================================

function updateSidebarPanelToggleUI(expanded) {
  const toggle = document.getElementById("sidebarPanelToggle");
  const iconSpan = document.getElementById("sidebarPanelToggleIcon");
  if (iconSpan) {
    iconSpan.setAttribute(
      "data-ty-icon",
      expanded ? "chevron-left" : "chevron-right",
    );
    if (typeof tyHydrateIconEl === "function") tyHydrateIconEl(iconSpan);
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.title = expanded ? "Collapse panel" : "Show panel";
  }
}

function applySidebarPanelFromStorage() {
  const panel = document.getElementById("sidebarPanel");
  if (!panel) return;
  let expanded = true;
  try {
    if (localStorage.getItem(SIDEBAR_PANEL_EXPANDED_KEY) === "0")
      expanded = false;
  } catch {
    /* private mode */
  }
  panel.classList.toggle("collapsed", !expanded);
  updateSidebarPanelToggleUI(expanded);
}

function toggleSidebarPanel() {
  const panel = document.getElementById("sidebarPanel");
  if (!panel) return;
  panel.classList.toggle("collapsed");
  const nowExpanded = !panel.classList.contains("collapsed");
  try {
    localStorage.setItem(SIDEBAR_PANEL_EXPANDED_KEY, nowExpanded ? "1" : "0");
  } catch {
    /* private mode */
  }
  updateSidebarPanelToggleUI(nowExpanded);
}

function showSection(section) {
  // If leaving campaigns page with detail open, reset it
  if (state.currentSection === "campaigns" && section !== "campaigns") {
    const detail = document.getElementById("campaignDetail");
    const list = document.getElementById("campaignsList");
    const newBtn = document.getElementById("newCampaignBtn");
    if (detail && !detail.classList.contains("hidden")) {
      detail.classList.add("hidden");
      if (list) list.classList.remove("hidden");
      if (newBtn) newBtn.classList.remove("hidden");
    }
    stopCampaignMonitor();
  }

  state.currentSection = section;

  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  const target = document.getElementById("page-" + section);
  if (target) target.classList.remove("hidden");

  document
    .querySelectorAll(".nav-icon[data-section], .nav-item[data-section]")
    .forEach((el) => {
      el.classList.toggle("active", el.dataset.section === section);
    });

  if (section === "testing") {
    // Restore text inputs immediately so the user sees their values without
    // any flash, then re-apply after `refreshTestingPage` populates the SMTP
    // / template <select>s (a value can only be set after the option exists).
    applyStoredFormValues(document.getElementById("page-testing"));
    void refreshTestingPage().then(() => {
      applyStoredFormValues(document.getElementById("page-testing"));
    });
  } else if (section === "config") {
    applyStoredFormValues(document.getElementById("page-config"));
  }

  if (!uiStateRestoreInProgress) persistUiState();
}

function initNavigation() {
  document
    .querySelectorAll(".nav-icon[data-section], .nav-item[data-section]")
    .forEach((el) => {
      el.addEventListener("click", () => {
        showSection(el.dataset.section);
      });
    });

  const panelToggle = document.getElementById("sidebarPanelToggle");
  if (panelToggle) {
    panelToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSidebarPanel();
    });
  }
}

// ============================================
// DASHBOARD
// ============================================

async function initDashboard() {
  const res = await api("dashboard");
  if (!res.success) return;

  const { campaigns = [], templates = [] } = res.data;

  // Stats
  const totalCampaigns = campaigns.length;
  const totalSent = campaigns.reduce(
    (sum, c) => sum + ((c.stats && c.stats.sent) || 0),
    0,
  );
  const activeCampaigns = campaigns.filter(
    (c) => c.status === "running",
  ).length;
  const totalTemplates = templates.length;

  const statsEl = document.getElementById("dashboardStats");
  if (statsEl) {
    statsEl.innerHTML = [
      { val: totalCampaigns, lbl: "Campaigns", section: "campaigns", cls: "" },
      {
        val: totalSent.toLocaleString("en-US"),
        lbl: "Emails sent",
        section: "campaigns",
        cls: "success",
      },
      {
        val: activeCampaigns,
        lbl: "Running",
        section: "campaigns",
        cls: activeCampaigns > 0 ? "success" : "",
      },
      { val: totalTemplates, lbl: "Templates", section: "templates", cls: "" },
    ]
      .map(
        (s) => `
      <div class="stat-card" onclick="showSection('${s.section}')" style="cursor:pointer">
        <div class="stat-val ${s.cls}">${s.val}</div>
        <div class="stat-lbl">${s.lbl}</div>
      </div>
    `,
      )
      .join("");
  }

  const dashEmpty = document.getElementById("dashboardEmptyState");
  if (dashEmpty) {
    if (totalCampaigns === 0 && totalTemplates === 0) {
      dashEmpty.classList.remove("hidden");
      dashEmpty.innerHTML = `
        <div class="empty-state-card dashboard-empty-inner">
          <div class="empty-state-icon">${tyI("hexagon", 44)}</div>
          <h2 class="empty-state-title">Bienvenue sur WinMail</h2>
          <p class="empty-state-text">Where to start? Create an email template, then a campaign with your contact list.</p>
          <div class="dashboard-empty-actions">
            <button type="button" class="btn-primary btn-with-icon" id="dashEmptyTemplates">${tyI("mail", 18)} Create a template</button>
            <button type="button" class="btn-secondary btn-with-icon" id="dashEmptyCampaigns">${tyI("clipboard-list", 18)} New campaign</button>
          </div>
        </div>`;
      document
        .getElementById("dashEmptyTemplates")
        ?.addEventListener("click", () => {
          showSection("templates");
          document.getElementById("newTemplateBtn")?.click();
        });
      document
        .getElementById("dashEmptyCampaigns")
        ?.addEventListener("click", () => {
          showSection("campaigns");
          document.getElementById("newCampaignBtn")?.click();
        });
      if (typeof tyHydrateIcons === "function") tyHydrateIcons(dashEmpty);
    } else {
      dashEmpty.classList.add("hidden");
      dashEmpty.innerHTML = "";
    }
  }

  // Recent campaigns (last 5)
  const recent = [...campaigns].slice(-5).reverse();
  const listEl = document.getElementById("recentCampaigns");
  if (listEl) {
    if (recent.length === 0) {
      listEl.innerHTML =
        '<div class="recent-empty-hint"><span class="recent-empty-icon" aria-hidden="true">' +
        tyI("clipboard-list", 22) +
        "</span><p>No recent campaign. The latest campaigns will appear here.</p></div>";
    } else {
      listEl.innerHTML = recent
        .map((c) => {
          const stats = c.stats || {};
          const statusColor =
            c.status === "running"
              ? "#22c55e"
              : c.status === "done"
                ? "#64748b"
                : "#f59e0b";
          return `
          <div class="campaign-row">
            <span class="status-dot" style="background:${statusColor};width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px"></span>
            <span style="flex:1;font-weight:500">${escHtml(c.name || "Untitled")}</span>
            <span class="recent-list-meta ty-inline-row">
              ${tyI("check", 14)} <span>${stats.sent || 0}</span>
              <span style="opacity:0.5;margin:0 0.15em">·</span>
              ${tyI("x-circle", 14)} <span>${stats.failed || 0}</span>
              <span style="opacity:0.5;margin:0 0.25em">/</span>
              <span>${stats.total || 0}</span>
            </span>
          </div>
        `;
        })
        .join("");
    }
  }

  // Active campaign widget
  const running = campaigns.find((c) => c.status === "running");
  const widgetEl = document.getElementById("activeCampaignWidget");
  if (widgetEl) {
    if (running) {
      widgetEl.classList.remove("hidden");
      widgetEl.innerHTML = `
        <strong>${escHtml(running.name)}</strong> is running.
        <button class="btn btn-sm" onclick="goToMonitoring('${running.id}')">Voir le monitoring</button>
      `;
    } else {
      widgetEl.classList.add("hidden");
    }
  }
}

async function goToMonitoring(campaignId) {
  showSection("campaigns");
  await showCampaignDetail(campaignId);
}

function campaignIsActiveStatus(status) {
  return ["pending", "running", "paused"].includes(String(status || ""));
}

function bindCampaignDetailInteractions() {
  const detail = document.getElementById("campaignDetail");
  if (!detail || detail.dataset.boundActions === "1") return;
  detail.dataset.boundActions = "1";
  detail.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-detail-action]");
    if (!btn || !detail.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();

    const action = btn.getAttribute("data-detail-action");
    const campaignId =
      btn.getAttribute("data-campaign-id") || state.currentCampaignId;
    if (action === "back") {
      void backToCampaignList();
    } else if (action === "pause") {
      void handlePause();
    } else if (action === "stop") {
      void handleStop();
    } else if (action === "edit" && campaignId) {
      void openEditCampaign(campaignId, { resumeAfterEdit: state.paused });
    } else if (action === "pause-edit" && campaignId) {
      void openEditCampaign(campaignId, {
        autoPause: true,
        resumeAfterEdit: true,
      });
    } else if (action === "relaunch" && campaignId) {
      void relaunchCampaign(campaignId);
    }
  });
}

// ============================================
// TEMPLATES
// ============================================

const TEMPLATE_PREVIEW_SAMPLES = {
  prenom: "María",
  nom: "García López",
  email: "maria.garcia@example.com",
  ville: "Madrid",
  entreprise: "Ejemplo S.L.",
  url_primaria: "https://www.example.com/expediente",
  url_secundaria: "https://www.example.com/ayuda",
  url_aviso: "https://www.example.com/aviso-legal",
  rotate_url: "https://www.example.com/lien-rotatif",
  url_rotate: "https://www.example.com/lien-rotatif",
};

/** Relaxed HTMLHint rules for email fragments (Handlebars, single quotes, etc.) */
const TEMPLATE_HTMLHINT_RULES = {
  "tagname-lowercase": false,
  "attr-lowercase": false,
  "attr-value-double-quotes": false,
  "doctype-first": false,
  "tag-pair": true,
  "spec-char-escape": true,
  "id-unique": true,
  "src-not-empty": true,
  "attr-no-duplication": true,
};

let templatePreviewDebounceTimer = null;
let templateCodeMirror = null;
let templateCmResizeTimer = null;
/** JSON snapshot of the saved state (or at open) to detect changes */
let templateEditorSavedSnapshot = null;
let templateSaveToastTimer = null;

function getTemplateRotateUrlsFromTextarea() {
  const ta = document.getElementById("templateRotateUrls");
  if (!ta || !String(ta.value).trim()) return [];
  return String(ta.value)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function templateCombinedContentForVars() {
  const sub = (document.getElementById("templateSubject") || {}).value || "";
  const tx = (document.getElementById("templateText") || {}).value || "";
  return `${sub}\n${tx}\n${getTemplateHtmlValue()}`;
}

function templateUsesRotateUrl() {
  return /\{\{?\s*(rotate_url|url_rotate)\s*\}?\}/i.test(
    templateCombinedContentForVars(),
  );
}

function syncTemplateRotateHint() {
  const hint = document.getElementById("templateRotateDetectHint");
  if (!hint) return;
  const hasUrls = getTemplateRotateUrlsFromTextarea().length > 0;
  hint.classList.toggle("hidden", !templateUsesRotateUrl() || hasUrls);
}

let templateRotateHintTimer = null;
function scheduleTemplateRotateHintSync() {
  if (templateRotateHintTimer) clearTimeout(templateRotateHintTimer);
  templateRotateHintTimer = setTimeout(() => {
    templateRotateHintTimer = null;
    syncTemplateRotateHint();
  }, 200);
}

function getCurrentTemplateEditorState() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : "";
  };
  const everyEl = document.getElementById("templateRotateEvery");
  const every = Math.max(1, parseInt(everyEl && everyEl.value, 10) || 1);
  return {
    id: getVal("templateId").trim(),
    name: getVal("templateName").trim(),
    subject: getVal("templateSubject").trim(),
    html: getTemplateHtmlValue().trim(),
    text: getVal("templateText").trim(),
    rotate_urls: getTemplateRotateUrlsFromTextarea(),
    rotate_url_every: every,
  };
}

function markTemplateEditorClean() {
  templateEditorSavedSnapshot = JSON.stringify(getCurrentTemplateEditorState());
}

function templateEditorIsDirty() {
  if (templateEditorSavedSnapshot === null) return false;
  return (
    JSON.stringify(getCurrentTemplateEditorState()) !==
    templateEditorSavedSnapshot
  );
}

function showTemplateSaveToast(message = "Template saved") {
  const el = document.getElementById("templateSaveToast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("template-save-toast--show");
  clearTimeout(templateSaveToastTimer);
  templateSaveToastTimer = setTimeout(() => {
    el.classList.remove("template-save-toast--show");
  }, 2800);
}

function hideTemplateUnsavedDialog() {
  document.getElementById("templateUnsavedDialog")?.classList.add("hidden");
}

function requestCloseTemplateEditor() {
  const m = document.getElementById("templateEditorModal");
  if (!m || m.classList.contains("hidden")) return;
  if (!templateEditorIsDirty()) {
    forceCloseTemplateEditorModal();
    return;
  }
  document.getElementById("templateUnsavedDialog")?.classList.remove("hidden");
}

function registerHtmlMixedLint() {
  if (typeof CodeMirror === "undefined") return;
  const lint = CodeMirror.helpers && CodeMirror.helpers.lint;
  if (lint && lint.htmlmixed) return;
  if (lint && lint.html) {
    CodeMirror.registerHelper("lint", "htmlmixed", lint.html);
    return;
  }
  let HH = typeof window !== "undefined" ? window.HTMLHint : null;
  if (HH && typeof HH.verify !== "function") {
    HH = HH.default || HH.HTMLHint || null;
  }
  if (!HH || typeof HH.verify !== "function") return;
  CodeMirror.registerHelper("lint", "htmlmixed", function (text, options) {
    const found = [];
    const rules = (options && options.rules) || TEMPLATE_HTMLHINT_RULES;
    const messages = HH.verify(text, rules) || [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const line = Math.max(0, (message.line || 1) - 1);
      const col = Math.max(0, (message.col || 1) - 1);
      found.push({
        from: CodeMirror.Pos(line, col),
        to: CodeMirror.Pos(line, col + 1),
        message: message.message,
        severity: message.type === "warning" ? "warning" : "error",
      });
    }
    return found;
  });
}

function isLikelyFullHtmlDocument(html) {
  const s = String(html || "").trim();
  if (!s) return false;
  if (/^\s*<!DOCTYPE/i.test(s)) return true;
  if (/<html[\s>]/i.test(s)) return true;
  return false;
}

/** Iframe + designMode: preserves the email HTML (Quill destroyed it by normalizing). */
function buildSrcdocForTemplateVisualEdit(html) {
  const raw = html == null ? "" : String(html);
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      srcdoc:
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{min-height:100%;margin:0;}body{padding:12px;box-sizing:border-box;font-family:system-ui,sans-serif;background:#fff;color:#111;}</style></head><body><p>&#8203;</p></body></html>',
      isFull: false,
    };
  }
  if (isLikelyFullHtmlDocument(raw)) {
    return { srcdoc: raw, isFull: true };
  }
  return {
    srcdoc: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>html,body{min-height:100%;margin:0;}body{padding:12px;box-sizing:border-box;}</style></head><body>${raw}</body></html>`,
    isFull: false,
  };
}

function getTemplateVisualIframeHtml() {
  const iframe = document.getElementById("templateVisualIframe");
  if (!iframe) return "";
  const doc = iframe.contentDocument;
  if (!doc || !doc.documentElement) return "";
  if (state.templateVisualIsFullDocument) {
    return doc.documentElement.outerHTML;
  }
  if (doc.body) return doc.body.innerHTML;
  return "";
}

function getTemplateHtmlValue() {
  if (state.templateHtmlEditMode === "visual") {
    if (state.templateVisualLoading) {
      return templateCodeMirror
        ? templateCodeMirror.getValue()
        : document.getElementById("templateHtml")?.value || "";
    }
    return getTemplateVisualIframeHtml();
  }
  if (templateCodeMirror) return templateCodeMirror.getValue();
  const el = document.getElementById("templateHtml");
  return el ? el.value : "";
}

function setTemplateHtmlValue(val) {
  const v = val == null ? "" : String(val);
  if (templateCodeMirror) {
    if (templateCodeMirror.getValue() !== v) {
      templateCodeMirror.setValue(v);
    }
  } else {
    const el = document.getElementById("templateHtml");
    if (el) el.value = v;
  }
  if (state.templateHtmlEditMode === "visual") {
    const wrap = document.getElementById("templateVisualWrap");
    if (wrap && !wrap.classList.contains("hidden")) {
      openTemplateVisualEditor(v);
    }
  }
  state.templatePreviewUsesRealMerge = false;
  updateTemplatePreviewHintLine();
  scheduleTemplatePreviewUpdate();
}

function destroyTemplateVisualEditor() {
  const iframe = document.getElementById("templateVisualIframe");
  if (iframe && state.templateVisualInputHandler) {
    try {
      const d = iframe.contentDocument;
      if (d) {
        d.removeEventListener("input", state.templateVisualInputHandler);
        d.removeEventListener("keyup", state.templateVisualInputHandler);
      }
    } catch (e) {
      /* iframe unloaded */
    }
    state.templateVisualInputHandler = null;
  }
  if (iframe) {
    iframe.onload = null;
    iframe.removeAttribute("srcdoc");
  }
  state.templateVisualIsFullDocument = false;
  state.templateVisualLoading = false;
}

function openTemplateVisualEditor(html) {
  const iframe = document.getElementById("templateVisualIframe");
  if (!iframe) return;
  destroyTemplateVisualEditor();
  state.templateVisualLoading = true;
  const { srcdoc, isFull } = buildSrcdocForTemplateVisualEdit(html);
  state.templateVisualIsFullDocument = isFull;
  state.templateVisualInputHandler = () => {
    state.templatePreviewUsesRealMerge = false;
    updateTemplatePreviewHintLine();
    scheduleTemplatePreviewUpdate();
    scheduleTemplateRotateHintSync();
  };
  iframe.onload = () => {
    const d = iframe.contentDocument;
    if (d) {
      try {
        d.designMode = "on";
      } catch (err) {
        /* rare */
      }
      if (state.templateVisualInputHandler) {
        d.addEventListener("input", state.templateVisualInputHandler);
        d.addEventListener("keyup", state.templateVisualInputHandler);
      }
    }
    state.templateVisualLoading = false;
  };
  iframe.srcdoc = srcdoc;
}

function setTemplateHtmlEditMode(mode) {
  const visual = mode === "visual";
  state.templateHtmlEditMode = visual ? "visual" : "code";
  const visualWrap = document.getElementById("templateVisualWrap");
  const codeWrap = document.getElementById("templateCodeEditorWrap");
  const btnV = document.getElementById("templateModeVisualBtn");
  const btnC = document.getElementById("templateModeCodeBtn");
  if (visual) {
    const html = templateCodeMirror
      ? templateCodeMirror.getValue()
      : document.getElementById("templateHtml")?.value || "";
    openTemplateVisualEditor(html);
    visualWrap?.classList.remove("hidden");
    codeWrap?.classList.add("hidden");
    visualWrap?.setAttribute("aria-hidden", "false");
    codeWrap?.setAttribute("aria-hidden", "true");
  } else {
    let html;
    if (state.templateVisualLoading) {
      html = templateCodeMirror
        ? templateCodeMirror.getValue()
        : document.getElementById("templateHtml")?.value || "";
    } else {
      html = getTemplateVisualIframeHtml();
      const cmVal = templateCodeMirror ? templateCodeMirror.getValue() : "";
      if ((!html || !String(html).trim()) && cmVal && String(cmVal).trim()) {
        html = cmVal;
      }
    }
    if (templateCodeMirror) {
      if (templateCodeMirror.getValue() !== html)
        templateCodeMirror.setValue(html);
    } else {
      const ta = document.getElementById("templateHtml");
      if (ta) ta.value = html;
    }
    destroyTemplateVisualEditor();
    visualWrap?.classList.add("hidden");
    codeWrap?.classList.remove("hidden");
    visualWrap?.setAttribute("aria-hidden", "true");
    codeWrap?.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      refreshTemplateCodeMirrorLayout();
      templateCodeMirror?.refresh();
    });
  }
  btnV?.classList.toggle("segmented-btn--active", visual);
  btnC?.classList.toggle("segmented-btn--active", !visual);
  btnV?.setAttribute("aria-selected", visual ? "true" : "false");
  btnC?.setAttribute("aria-selected", !visual ? "true" : "false");
  scheduleTemplatePreviewUpdate();
}

function updateTemplatePreviewHintLine() {
  const el = document.getElementById("templatePreviewHintLine");
  if (!el) return;
  if (state.templatePreviewUsesRealMerge) {
    el.textContent =
      "Preview with real data - edit the HTML then reapply to refresh.";
  } else {
    el.textContent =
      'Preview with sample data - choose a campaign (or the draft) and click "Apply" for a real row.';
  }
}

function setTemplatePreviewDevice(device) {
  state.templatePreviewDevice = device === "mobile" ? "mobile" : "desktop";
  const vp = document.getElementById("templatePreviewViewport");
  if (vp) vp.setAttribute("data-device", state.templatePreviewDevice);
  document
    .getElementById("templatePreviewDeviceDesktop")
    ?.classList.toggle(
      "segmented-btn--active",
      state.templatePreviewDevice === "desktop",
    );
  document
    .getElementById("templatePreviewDeviceMobile")
    ?.classList.toggle(
      "segmented-btn--active",
      state.templatePreviewDevice === "mobile",
    );
  document
    .getElementById("templatePreviewDeviceDesktop")
    ?.setAttribute(
      "aria-selected",
      state.templatePreviewDevice === "desktop" ? "true" : "false",
    );
  document
    .getElementById("templatePreviewDeviceMobile")
    ?.setAttribute(
      "aria-selected",
      state.templatePreviewDevice === "mobile" ? "true" : "false",
    );
}

async function populateTemplatePreviewCampaignSelect() {
  const sel = document.getElementById("templatePreviewCampaignSelect");
  if (!sel) return;
  const draftVal = "__draft__";
  const cur = sel.value;
  const res = await api("campaigns");
  const campaigns = res.success ? res.data || [] : [];
  const opts = [
    `<option value="">— Exemples fictifs —</option>`,
    `<option value="${draftVal}">Current draft (campaign form)</option>`,
  ];
  campaigns.forEach((c) => {
    const id = escAttr(c.id);
    opts.push(`<option value="${id}">${escHtml(c.name || c.id)}</option>`);
  });
  sel.innerHTML = opts.join("");
  const allowed = ["", draftVal, ...campaigns.map((c) => String(c.id))];
  if (cur && allowed.includes(cur)) sel.value = cur;
}

async function applyTemplateRealDataPreview() {
  const sel = document.getElementById("templatePreviewCampaignSelect");
  const idxEl = document.getElementById("templatePreviewRowIndex");
  const campaignId = sel && sel.value;
  const rowIndex = Math.max(0, parseInt(idxEl && idxEl.value, 10) || 0);
  const templatePayload = {
    html: getTemplateHtmlValue(),
    subject: (document.getElementById("templateSubject") || {}).value || "",
    text: (document.getElementById("templateText") || {}).value || "",
    rotate_urls: getTemplateRotateUrlsFromTextarea(),
    rotate_url_every: Math.max(
      1,
      parseInt(
        (document.getElementById("templateRotateEvery") || {}).value,
        10,
      ) || 1,
    ),
  };

  const body = {
    template: templatePayload,
    recipient_index: rowIndex,
  };

  if (!campaignId || campaignId === "") {
    return alert('Choose a campaign or "Current draft".');
  }
  if (campaignId === "__draft__") {
    const pc = collectPreviewListConfigOnly();
    if (!pc.file_path || !String(pc.file_path).trim()) {
      return alert("First import a list in the campaign form (draft).");
    }
    body.preview_config = pc;
  } else {
    body.campaign_id = campaignId;
  }

  const res = await api("template_preview_merge", "POST", body);
  if (!res.success) return alert(res.error || "Preview error");

  const d = res.data || {};
  const subjEl = document.getElementById("templatePreviewSubjectLine");
  if (subjEl) {
    subjEl.textContent = d.subject ? `Objet : ${d.subject}` : "";
    subjEl.classList.toggle("hidden", !d.subject);
  }

  const iframe = document.getElementById("templatePreviewFrame");
  if (iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(d.html || "");
      doc.close();
    } catch (e) {
      console.error(e);
    }
  }
  state.templatePreviewUsesRealMerge = true;
  updateTemplatePreviewHintLine();
}

function initTemplateEditorAdvancedControls() {
  document
    .getElementById("templateModeVisualBtn")
    ?.addEventListener("click", () => setTemplateHtmlEditMode("visual"));
  document
    .getElementById("templateModeCodeBtn")
    ?.addEventListener("click", () => setTemplateHtmlEditMode("code"));
  document
    .getElementById("templatePreviewDeviceDesktop")
    ?.addEventListener("click", () => setTemplatePreviewDevice("desktop"));
  document
    .getElementById("templatePreviewDeviceMobile")
    ?.addEventListener("click", () => setTemplatePreviewDevice("mobile"));
  document
    .getElementById("templatePreviewApplyRealBtn")
    ?.addEventListener("click", () => applyTemplateRealDataPreview());
}

function initTemplateCodeMirror() {
  if (templateCodeMirror || typeof CodeMirror === "undefined") return;
  const ta = document.getElementById("templateHtml");
  if (!ta) return;

  registerHtmlMixedLint();

  const lintOn = !!(typeof window !== "undefined" && window.HTMLHint);

  templateCodeMirror = CodeMirror.fromTextArea(ta, {
    mode: "htmlmixed",
    theme: "material-darker",
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 2,
    matchBrackets: true,
    autoRefresh: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-lint-markers"],
    lint: lintOn ? { rules: TEMPLATE_HTMLHINT_RULES } : false,
    extraKeys: {
      Tab: (cm) => cm.execCommand("indentMore"),
      "Shift-Tab": (cm) => cm.execCommand("indentLess"),
    },
  });

  templateCodeMirror
    .getWrapperElement()
    .classList.add("template-codemirror-root");
  templateCodeMirror.on("change", () => {
    state.templatePreviewUsesRealMerge = false;
    updateTemplatePreviewHintLine();
    scheduleTemplatePreviewUpdate();
    scheduleTemplateRotateHintSync();
  });
}

function refreshTemplateCodeMirrorLayout() {
  if (!templateCodeMirror) return;
  const h = Math.max(280, window.innerHeight - 150);
  templateCodeMirror.setSize(null, h);
  templateCodeMirror.refresh();
}

function applyTemplatePreviewPlaceholders(html) {
  if (!html || !String(html).trim()) {
    return '<p style="margin:0;padding:28px;font-family:system-ui,sans-serif;font-size:15px;color:#64748b;">Enter HTML on the left to display the preview here.</p>';
  }

  let out = String(html);

  out = out.replace(
    /\{\{?(RANDNUM|RANDALPHANUM|RANDALPHA)-(\d+)\}?\}/gi,
    (_, type, len) => {
      const n = Math.min(24, Math.max(1, parseInt(len, 10) || 6));
      const t = String(type).toUpperCase();
      if (t === "RANDNUM") return "482910".padStart(n, "0").slice(-n);
      if (t === "RANDALPHA") return "PreviewABCDEFGHIJKL".slice(0, n);
      return "a1B2c3D4e5F6g7H8".repeat(2).slice(0, n);
    },
  );

  const replaceKnown = (key) => {
    const k = String(key).toLowerCase();
    if (k === "date") return new Date().toLocaleDateString("en-US");
    if (k === "time") {
      return new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (k === "datetime") return new Date().toLocaleString("en-US");
    if (k === "rotate_url" || k === "url_rotate") {
      const lines = getTemplateRotateUrlsFromTextarea();
      return lines.length ? lines[0] : TEMPLATE_PREVIEW_SAMPLES.rotate_url;
    }
    if (Object.prototype.hasOwnProperty.call(TEMPLATE_PREVIEW_SAMPLES, k)) {
      return TEMPLATE_PREVIEW_SAMPLES[k];
    }
    return `[${key}]`;
  };

  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => replaceKnown(key));
  out = out.replace(/\{(\w+)\}/g, (_, key) => replaceKnown(key));

  return out;
}

function updateTemplatePreviewLive() {
  const iframe = document.getElementById("templatePreviewFrame");
  if (!iframe) return;

  if (state.templatePreviewUsesRealMerge) {
    return;
  }

  const subjLine = document.getElementById("templatePreviewSubjectLine");
  if (subjLine) {
    subjLine.classList.add("hidden");
    subjLine.textContent = "";
  }

  const html = applyTemplatePreviewPlaceholders(getTemplateHtmlValue());
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  } catch (err) {
    console.error("Template preview", err);
  }
}

function scheduleTemplatePreviewUpdate() {
  if (templatePreviewDebounceTimer) clearTimeout(templatePreviewDebounceTimer);
  templatePreviewDebounceTimer = setTimeout(() => {
    templatePreviewDebounceTimer = null;
    updateTemplatePreviewLive();
  }, 120);
}

function isTemplateCodePhaseActive() {
  const code = document.getElementById("templateEditorPhaseCode");
  return !!(code && !code.classList.contains("hidden"));
}

function setTemplateCodePhase(active) {
  const overlay = document.getElementById("templateEditorModal");
  const inner = document.getElementById("templateEditorModalInner");
  const main = document.getElementById("templateEditorPhaseMain");
  const code = document.getElementById("templateEditorPhaseCode");
  if (!main || !code) return;
  main.classList.toggle("hidden", active);
  main.setAttribute("aria-hidden", active ? "true" : "false");
  code.classList.toggle("hidden", !active);
  code.setAttribute("aria-hidden", active ? "false" : "true");
  overlay?.classList.toggle("template-editor-overlay--code", active);
  inner?.classList.toggle("modal-template-editor--code", active);
  if (active) {
    state.templateHtmlEditMode = "code";
    state.templatePreviewUsesRealMerge = false;
    destroyTemplateVisualEditor();
    const qw = document.getElementById("templateVisualWrap");
    const cw = document.getElementById("templateCodeEditorWrap");
    qw?.classList.add("hidden");
    cw?.classList.remove("hidden");
    document
      .getElementById("templateModeVisualBtn")
      ?.classList.remove("segmented-btn--active");
    document
      .getElementById("templateModeCodeBtn")
      ?.classList.add("segmented-btn--active");
    initTemplateCodeMirror();
    populateTemplatePreviewCampaignSelect();
    setTemplatePreviewDevice("desktop");
    updateTemplatePreviewHintLine();
    scheduleTemplatePreviewUpdate();
    requestAnimationFrame(() => {
      refreshTemplateCodeMirrorLayout();
      requestAnimationFrame(() => {
        templateCodeMirror?.refresh();
        templateCodeMirror?.focus();
      });
    });
  } else {
    destroyTemplateVisualEditor();
    requestAnimationFrame(() => {
      const m = document.getElementById("templateEditorModal");
      if (m && !m.classList.contains("hidden")) {
        document.getElementById("templateName")?.focus();
      }
    });
  }
}

function openTemplateEditorModal() {
  const modal = document.getElementById("templateEditorModal");
  const titleEl = document.getElementById("templateEditorModalTitle");
  const idEl = document.getElementById("templateId");
  const id = idEl && idEl.value;
  if (titleEl) titleEl.textContent = id ? "Edit template" : "New template";
  setTemplateCodePhase(false);
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }
  const guideBtn = document.getElementById("templateVarsGuideBtn");
  const guidePanel = document.getElementById("templateVarsGuidePanel");
  if (guideBtn && guidePanel) {
    guideBtn.setAttribute("aria-expanded", "false");
    guidePanel.classList.add("hidden");
  }
  markTemplateEditorClean();
  requestAnimationFrame(() => {
    updateTemplatePreviewLive();
    scheduleTemplateRotateHintSync();
    document.getElementById("templateName")?.focus();
  });
}

function forceCloseTemplateEditorModal() {
  hideTemplateUnsavedDialog();
  destroyTemplateVisualEditor();
  setTemplateCodePhase(false);
  const modal = document.getElementById("templateEditorModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
  templateEditorSavedSnapshot = null;
}

async function initTemplates() {
  await loadTemplates();

  const newBtn = document.getElementById("newTemplateBtn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      clearTemplateForm();
      openTemplateEditorModal();
    });
  }

  const newFolderBtn = document.getElementById("newFolderBtn");
  if (newFolderBtn) {
    newFolderBtn.addEventListener("click", () => openFolderEditDialog(null));
  }

  initFolderEditDialog();

  const breadcrumbRoot = document.getElementById("templatesBreadcrumbRoot");
  if (breadcrumbRoot) {
    breadcrumbRoot.addEventListener("click", () => {
      enterTemplateFolder("");
    });
  }

  const saveBtn = document.getElementById("saveTemplateBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", saveTemplate);
  }

  const cancelBtn = document.getElementById("cancelTemplateBtn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => requestCloseTemplateEditor());
  }

  document
    .getElementById("openTemplateCodeEditorBtn")
    ?.addEventListener("click", () => setTemplateCodePhase(true));
  initTemplateEditorAdvancedControls();

  const templateVarsGuideBtn = document.getElementById("templateVarsGuideBtn");
  const templateVarsGuidePanel = document.getElementById(
    "templateVarsGuidePanel",
  );
  if (templateVarsGuideBtn && templateVarsGuidePanel) {
    templateVarsGuideBtn.addEventListener("click", () => {
      const isOpen =
        templateVarsGuideBtn.getAttribute("aria-expanded") === "true";
      const willOpen = !isOpen;
      templateVarsGuideBtn.setAttribute("aria-expanded", String(willOpen));
      templateVarsGuidePanel.classList.toggle("hidden", isOpen);
      if (willOpen) {
        requestAnimationFrame(() => {
          templateVarsGuidePanel.scrollIntoView({
            block: "nearest",
            behavior: "smooth",
          });
        });
      }
    });
  }

  document
    .getElementById("backTemplateCodeEditorBtn")
    ?.addEventListener("click", () => setTemplateCodePhase(false));

  document
    .getElementById("closeTemplateEditorModal")
    ?.addEventListener("click", () => requestCloseTemplateEditor());

  document
    .getElementById("closeTemplateCodeEditorModal")
    ?.addEventListener("click", () => requestCloseTemplateEditor());

  const editorModal = document.getElementById("templateEditorModal");
  if (editorModal) {
    editorModal.addEventListener("click", (e) => {
      if (e.target !== editorModal) return;
      if (isTemplateCodePhaseActive()) {
        setTemplateCodePhase(false);
      } else {
        requestCloseTemplateEditor();
      }
    });
  }

  const unsavedDlg = document.getElementById("templateUnsavedDialog");
  if (unsavedDlg) {
    unsavedDlg.addEventListener("click", (e) => {
      if (e.target === unsavedDlg) hideTemplateUnsavedDialog();
    });
    document
      .getElementById("templateUnsavedCancel")
      ?.addEventListener("click", () => hideTemplateUnsavedDialog());
    document
      .getElementById("templateUnsavedDiscard")
      ?.addEventListener("click", () => {
        hideTemplateUnsavedDialog();
        forceCloseTemplateEditorModal();
      });
    document
      .getElementById("templateUnsavedSave")
      ?.addEventListener("click", () => {
        saveTemplate({ closeAfter: true, showToast: true });
      });
  }

  document
    .getElementById("templateHtml")
    ?.addEventListener("input", scheduleTemplatePreviewUpdate);

  window.addEventListener("resize", () => {
    if (!isTemplateCodePhaseActive() || !templateCodeMirror) return;
    clearTimeout(templateCmResizeTimer);
    templateCmResizeTimer = setTimeout(refreshTemplateCodeMirrorLayout, 120);
  });

  document.addEventListener(
    "keydown",
    (e) => {
      const unsavedOpen = document.getElementById("templateUnsavedDialog");
      if (unsavedOpen && !unsavedOpen.classList.contains("hidden")) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          hideTemplateUnsavedDialog();
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          e.stopPropagation();
          saveTemplate();
        }
        return;
      }

      const m = document.getElementById("templateEditorModal");
      if (!m || m.classList.contains("hidden")) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        saveTemplate();
        return;
      }

      if (e.key !== "Escape") return;
      e.preventDefault();
      if (isTemplateCodePhaseActive()) {
        setTemplateCodePhase(false);
      } else {
        requestCloseTemplateEditor();
      }
    },
    true,
  );

  document
    .getElementById("templateSubject")
    ?.addEventListener("input", scheduleTemplateRotateHintSync);
  document
    .getElementById("templateText")
    ?.addEventListener("input", scheduleTemplateRotateHintSync);
  document
    .getElementById("templateRotateUrls")
    ?.addEventListener("input", scheduleTemplateRotateHintSync);
  document
    .getElementById("templateRotateEvery")
    ?.addEventListener("input", scheduleTemplateRotateHintSync);
}

async function loadTemplates() {
  const [tplRes, folderRes] = await Promise.all([
    api("templates"),
    api("template_folders"),
  ]);
  if (tplRes && tplRes.success) state.templates = tplRes.data || [];
  if (folderRes && folderRes.success)
    state.templateFolders = folderRes.data || [];
  renderTemplates(state.templates);
}

/**
 * Root view: level-0 folders + templates without a folder.
 * Folder view: breadcrumb + subfolders + templates in the current folder.
 */
function renderTemplates(templates) {
  const list = document.getElementById("templatesList");
  const emptyEl = document.getElementById("templatesEmptyState");
  const breadcrumb = document.getElementById("templatesBreadcrumb");
  if (!list) return;

  const folders = state.templateFolders || [];
  const currentFolderId = state.currentTemplateFolderId || "";

  // If we're in a folder that no longer exists, exit automatically.
  if (currentFolderId && !folders.some((f) => f.id === currentFolderId)) {
    state.currentTemplateFolderId = "";
    return renderTemplates(templates);
  }

  // Index folders by id (for parent chain).
  const folderById = new Map();
  for (const f of folders) folderById.set(f.id, f);

  // Templates by folder.
  const tplsByFolder = new Map();
  const rootTemplates = [];
  for (const t of templates) {
    const fid = t.folder_id || "";
    if (fid) {
      if (!tplsByFolder.has(fid)) tplsByFolder.set(fid, []);
      tplsByFolder.get(fid).push(t);
    } else {
      rootTemplates.push(t);
    }
  }

  // Direct subfolders by parent_id.
  const subfoldersByParent = new Map();
  for (const f of folders) {
    const pid = f.parent_id || "";
    if (!subfoldersByParent.has(pid)) subfoldersByParent.set(pid, []);
    subfoldersByParent.get(pid).push(f);
  }

  // Render the breadcrumb (full path).
  renderTemplatesBreadcrumb(breadcrumb, currentFolderId, folderById);

  // Empty state — empty root (no folders, no templates)
  const rootFolders = subfoldersByParent.get("") || [];
  if (
    !currentFolderId &&
    rootFolders.length === 0 &&
    rootTemplates.length === 0
  ) {
    list.innerHTML = "";
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      emptyEl.innerHTML = `
        <div class="empty-state-card">
          <div class="empty-state-icon" aria-hidden="true">${tyI("mail", 40)}</div>
          <h2 class="empty-state-title">No template yet</h2>
          <p class="empty-state-text">Create your first template from the <strong>New template</strong> button at the top right.</p>
        </div>`;
      if (typeof tyHydrateIcons === "function") tyHydrateIcons(emptyEl);
    }
    return;
  }

  if (emptyEl) {
    emptyEl.classList.add("hidden");
    emptyEl.innerHTML = "";
  }

  let displayTemplates;
  let displayFolders;
  if (currentFolderId) {
    displayTemplates = tplsByFolder.get(currentFolderId) || [];
    displayFolders = subfoldersByParent.get(currentFolderId) || [];
  } else {
    displayTemplates = rootTemplates;
    displayFolders = rootFolders;
  }

  const folderCardsHtml = displayFolders
    .map((f) => {
      const items = tplsByFolder.get(f.id) || [];
      const subFolders = subfoldersByParent.get(f.id) || [];
      const preview = items.slice(0, 3);
      const totalCount = items.length + subFolders.length;
      const stackItems = [];
      if (subFolders.length > 0) {
        const previewSubs = subFolders.slice(0, 2);
        for (const sf of previewSubs) {
          stackItems.push(
            `<div class="folder-card-stack-item is-subfolder" title="Subfolder">${tyI("folder", 12)} ${escHtml(sf.name)}</div>`,
          );
        }
      }
      for (const t of preview) {
        if (stackItems.length >= 3) break;
        stackItems.push(
          `<div class="folder-card-stack-item" title="${escAttr(t.subject || "")}">${escHtml(t.name)}</div>`,
        );
      }
      const stackHtml =
        stackItems.length === 0
          ? `<div class="folder-card-stack-empty">Drag a template or folder here</div>`
          : stackItems.join("");

      const colorHex = folderColorHex(f.color);
      return `
      <div class="folder-card" data-folder-id="${escAttr(f.id)}" data-color="${escAttr(f.color || "violet")}" style="--folder-color:${colorHex}" draggable="true" tabindex="0" role="button" aria-label="Open folder ${escAttr(f.name)}">
        <div class="folder-card-head">
          <span class="folder-card-icon">${tyI("folder", 18)}</span>
          <span class="folder-card-name">${escHtml(f.name)}</span>
          <span class="folder-card-count">${totalCount}</span>
          <button type="button" class="folder-card-menu" data-folder-edit="${escAttr(f.id)}" aria-label="Edit folder" title="Edit folder">
            ${tyI("more-horizontal", 16)}
          </button>
        </div>
        <div class="folder-card-stack">${stackHtml}</div>
      </div>
    `;
    })
    .join("");

  const templateCardsHtml = displayTemplates
    .map(
      (t) => `
    <div class="template-card" data-id="${escAttr(t.id)}" draggable="true" data-merge-label="Create a folder">
      <div class="template-card-header">
        <strong>${escHtml(t.name)}</strong>
      </div>
      <div class="template-card-sub">${escHtml(t.subject || "")}</div>
      <div class="template-card-actions">
        <button type="button" class="btn btn-sm btn-with-icon" data-action="edit">${tyI("pencil", 15)} Edit</button>
        <button type="button" class="btn btn-sm btn-danger btn-with-icon" data-action="delete">${tyI("trash", 15)} Delete</button>
      </div>
    </div>
  `,
    )
    .join("");

  // In an empty folder, show a small drop hint.
  const emptyFolderHint =
    currentFolderId &&
    displayTemplates.length === 0 &&
    displayFolders.length === 0
      ? `<div class="empty-state-card" style="grid-column: 1 / -1;">
         <div class="empty-state-icon" aria-hidden="true">${tyI("folder-open", 40)}</div>
         <h2 class="empty-state-title">This folder is empty</h2>
         <p class="empty-state-text">Go back to "All templates" then drag templates here.</p>
       </div>`
      : "";

  list.innerHTML = folderCardsHtml + templateCardsHtml + emptyFolderHint;

  if (typeof tyHydrateIcons === "function") tyHydrateIcons(list);

  // Bind template edit/delete buttons via event delegation (CSP blocks inline onclick)
  list
    .querySelectorAll(".template-card-actions button[data-action]")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const card = btn.closest(".template-card");
        const id = card && card.dataset.id;
        if (!id) return;
        if (btn.dataset.action === "edit") editTemplate(id);
        else if (btn.dataset.action === "delete") deleteTemplate(id);
      });
    });

  bindTemplateDragAndDrop(list);
  bindFolderCardInteractions(list);
}

/**
 * Builds the breadcrumb (current folder path, clickable, drop targets).
 * @param {HTMLElement|null} breadcrumb
 * @param {string} currentFolderId
 * @param {Map<string, any>} folderById
 */
function renderTemplatesBreadcrumb(breadcrumb, currentFolderId, folderById) {
  if (!breadcrumb) return;
  if (!currentFolderId) {
    breadcrumb.classList.add("hidden");
    breadcrumb.innerHTML = "";
    return;
  }

  // Walk up the parent chain to the root.
  const chain = [];
  let cur = folderById.get(currentFolderId);
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_id ? folderById.get(cur.parent_id) : null;
  }

  let html = `
    <button type="button" class="templates-breadcrumb-root" id="templatesBreadcrumbRoot" data-drop-folder="">
      ${tyI("arrow-left", 16)}
      <span>All templates</span>
    </button>
  `;
  chain.forEach((f, idx) => {
    const isLast = idx === chain.length - 1;
    html += `<span class="templates-breadcrumb-sep" aria-hidden="true">/</span>`;
    if (isLast) {
      html += `<span class="templates-breadcrumb-current" id="templatesBreadcrumbCurrent" style="--folder-color:${folderColorHex(f.color)}">${escHtml(f.name)}</span>`;
    } else {
      html += `<button type="button" class="templates-breadcrumb-crumb" data-folder-id="${escAttr(f.id)}" data-drop-folder="${escAttr(f.id)}" style="--folder-color:${folderColorHex(f.color)}">${escHtml(f.name)}</button>`;
    }
  });
  html += `<span class="templates-breadcrumb-hint" id="templatesBreadcrumbHint">Drag an item here to move it</span>`;

  breadcrumb.innerHTML = html;
  breadcrumb.classList.remove("hidden");
  if (typeof tyHydrateIcons === "function") tyHydrateIcons(breadcrumb);

  const rootBtn = breadcrumb.querySelector("#templatesBreadcrumbRoot");
  if (rootBtn) rootBtn.addEventListener("click", () => enterTemplateFolder(""));

  breadcrumb.querySelectorAll(".templates-breadcrumb-crumb").forEach((btn) => {
    btn.addEventListener("click", () =>
      enterTemplateFolder(btn.dataset.folderId || ""),
    );
  });
}

/** Predefined folder color palette. */
const FOLDER_COLOR_PRESETS = {
  violet: "#7c3aed",
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  slate: "#64748b",
};

/** Returns a hex color from a stored value (preset name or hex). */
function folderColorHex(value) {
  if (!value) return FOLDER_COLOR_PRESETS.violet;
  const raw = String(value).trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
  return FOLDER_COLOR_PRESETS[raw] || FOLDER_COLOR_PRESETS.violet;
}

/**
 * Enables native drag & drop on all rendered cards.
 * - Drag a template onto a folder = move it inside
 * - Drag a template onto another template (600 ms) = create a folder containing both
 * - Drag a template onto the breadcrumb (folder mode) = move it out of the folder
 */
function bindTemplateDragAndDrop(list) {
  const cards = list.querySelectorAll(".template-card");
  const folders = list.querySelectorAll(".folder-card");
  const breadcrumb = document.getElementById("templatesBreadcrumb");

  const clearMerge = () => {
    if (state.templateDnd.hoverMergeTimer) {
      clearTimeout(state.templateDnd.hoverMergeTimer);
      state.templateDnd.hoverMergeTimer = null;
    }
    if (state.templateDnd.hoverMergeId) {
      const prev = list.querySelector(
        `.template-card[data-id="${cssEsc(state.templateDnd.hoverMergeId)}"]`,
      );
      if (prev) prev.classList.remove("merge-target");
      state.templateDnd.hoverMergeId = null;
    }
  };

  const resetDrag = () => {
    state.templateDnd.draggingId = null;
    state.templateDnd.draggingKind = null;
    clearMerge();
    list
      .querySelectorAll(".drop-hover")
      .forEach((el) => el.classList.remove("drop-hover"));
    if (breadcrumb) {
      breadcrumb.classList.remove("drop-hover");
      breadcrumb
        .querySelectorAll(".drop-hover")
        .forEach((el) => el.classList.remove("drop-hover"));
    }
  };

  cards.forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      state.templateDnd.draggingId = card.dataset.id;
      state.templateDnd.draggingKind = "template";
      card.classList.add("is-dragging");
      list.classList.add("has-dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.dataset.id || "");
      } catch (_) {
        /* safari */
      }
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      list.classList.remove("has-dragging");
      resetDrag();
    });

    // Hover over another template -> timer to create a folder.
    card.addEventListener("dragover", (e) => {
      const dragging = state.templateDnd.draggingId;
      const kind = state.templateDnd.draggingKind;
      if (!dragging || kind !== "template" || dragging === card.dataset.id)
        return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      if (state.templateDnd.hoverMergeId !== card.dataset.id) {
        clearMerge();
        state.templateDnd.hoverMergeId = card.dataset.id;
        state.templateDnd.hoverMergeTimer = setTimeout(() => {
          card.classList.add("merge-target");
        }, 420);
      }
    });

    card.addEventListener("dragleave", (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      if (state.templateDnd.hoverMergeId === card.dataset.id) {
        clearMerge();
      }
    });

    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      const sourceId = state.templateDnd.draggingId;
      const kind = state.templateDnd.draggingKind;
      const targetId = card.dataset.id;
      const hadMergeHover = card.classList.contains("merge-target");
      clearMerge();
      if (
        !sourceId ||
        kind !== "template" ||
        !targetId ||
        sourceId === targetId
      )
        return;
      if (!hadMergeHover) return;
      await createFolderFromMerge(sourceId, targetId);
    });
  });

  folders.forEach((folder) => {
    folder.addEventListener("dragstart", (e) => {
      state.templateDnd.draggingId = folder.dataset.folderId;
      state.templateDnd.draggingKind = "folder";
      folder.classList.add("is-dragging");
      list.classList.add("has-dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", folder.dataset.folderId || "");
      } catch (_) {
        /* safari */
      }
    });

    folder.addEventListener("dragend", () => {
      folder.classList.remove("is-dragging");
      list.classList.remove("has-dragging");
      resetDrag();
    });

    folder.addEventListener("dragover", (e) => {
      const dragging = state.templateDnd.draggingId;
      const kind = state.templateDnd.draggingKind;
      if (!dragging) return;
      // A folder cannot be dragged onto itself.
      if (kind === "folder" && dragging === folder.dataset.folderId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      folder.classList.add("drop-hover");
    });
    folder.addEventListener("dragleave", (e) => {
      if (folder.contains(e.relatedTarget)) return;
      folder.classList.remove("drop-hover");
    });
    folder.addEventListener("drop", async (e) => {
      e.preventDefault();
      folder.classList.remove("drop-hover");
      const sourceId = state.templateDnd.draggingId;
      const kind = state.templateDnd.draggingKind;
      const targetId = folder.dataset.folderId || null;
      if (!sourceId) return;
      if (kind === "folder") {
        if (sourceId === targetId) return;
        await moveFolderToFolder(sourceId, targetId);
      } else {
        await moveTemplateToFolder(sourceId, targetId);
      }
    });
  });

  if (breadcrumb) {
    const dropTargets = breadcrumb.querySelectorAll("[data-drop-folder]");
    dropTargets.forEach((el) => {
      el.addEventListener("dragover", (e) => {
        const dragging = state.templateDnd.draggingId;
        if (!dragging) return;
        const targetId = el.dataset.dropFolder || "";
        // No point dropping a folder onto itself.
        if (
          state.templateDnd.draggingKind === "folder" &&
          dragging === targetId
        )
          return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        el.classList.add("drop-hover");
      });
      el.addEventListener("dragleave", (ev) => {
        if (el.contains(ev.relatedTarget)) return;
        el.classList.remove("drop-hover");
      });
      el.addEventListener("drop", async (e) => {
        e.preventDefault();
        el.classList.remove("drop-hover");
        const sourceId = state.templateDnd.draggingId;
        const kind = state.templateDnd.draggingKind;
        if (!sourceId) return;
        const targetId = el.dataset.dropFolder || "";
        const parentId = targetId === "" ? null : targetId;
        if (kind === "folder") {
          if (sourceId === targetId) return;
          await moveFolderToFolder(sourceId, parentId);
        } else {
          await moveTemplateToFolder(sourceId, parentId);
        }
      });
    });
  }
}

function bindFolderCardInteractions(list) {
  list.querySelectorAll(".folder-card").forEach((folder) => {
    folder.addEventListener("click", (e) => {
      // Ignore the click if it came from the menu button
      if (e.target.closest("[data-folder-edit]")) return;
      enterTemplateFolder(folder.dataset.folderId);
    });

    folder.addEventListener("dblclick", (e) => {
      if (e.target.closest("[data-folder-edit]")) return;
      const fid = folder.dataset.folderId;
      const f = (state.templateFolders || []).find((x) => x.id === fid);
      if (f) openFolderEditDialog(f);
    });

    folder.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        enterTemplateFolder(folder.dataset.folderId);
      }
    });

    const menuBtn = folder.querySelector("[data-folder-edit]");
    if (menuBtn) {
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const fid = menuBtn.dataset.folderEdit;
        const f = (state.templateFolders || []).find((x) => x.id === fid);
        if (f) openFolderEditDialog(f);
      });
    }
  });
}

function enterTemplateFolder(folderId) {
  state.currentTemplateFolderId = folderId || "";
  renderTemplates(state.templates);
}

async function moveTemplateToFolder(templateId, folderId) {
  const res = await api("template_move", "POST", {
    template_id: templateId,
    folder_id: folderId || null,
  });
  if (!res.success) {
    alert("Unable to move template: " + (res.error || "unknown error"));
    return;
  }
  await loadTemplates();
}

async function moveFolderToFolder(folderId, parentId) {
  if (!folderId) return;
  const res = await api("template_folder_move", "POST", {
    folder_id: folderId,
    parent_id: parentId || null,
  });
  if (!res.success) {
    alert("Unable to move folder: " + (res.error || "unknown error"));
    return;
  }
  await loadTemplates();
}

async function createFolderFromMerge(templateAId, templateBId) {
  const a = (state.templates || []).find(
    (x) => String(x.id) === String(templateAId),
  );
  const b = (state.templates || []).find(
    (x) => String(x.id) === String(templateBId),
  );
  const defaultName =
    a && b ? `Folder ${a.name} & ${b.name}`.slice(0, 40) : "New folder";
  const name = prompt("New folder name:", defaultName);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;

  const parentId = state.currentTemplateFolderId || null;
  const createRes = await api("template_folders", "POST", {
    name: trimmed,
    color: "violet",
    parent_id: parentId,
  });
  if (!createRes.success || !createRes.data || !createRes.data.id) {
    alert("Folder creation error: " + (createRes.error || ""));
    return;
  }
  const newFolderId = createRes.data.id;
  await Promise.all([
    api("template_move", "POST", {
      template_id: templateAId,
      folder_id: newFolderId,
    }),
    api("template_move", "POST", {
      template_id: templateBId,
      folder_id: newFolderId,
    }),
  ]);
  await loadTemplates();
}

// ----- Folder edit dialog ---------------------------------------------------

let _folderEditCtx = null;

function initFolderEditDialog() {
  const dlg = document.getElementById("folderEditDialog");
  if (!dlg || dlg.dataset.initialized === "1") return;
  dlg.dataset.initialized = "1";

  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeFolderEditDialog();
  });

  document
    .getElementById("folderEditCancel")
    ?.addEventListener("click", closeFolderEditDialog);
  document
    .getElementById("folderEditSave")
    ?.addEventListener("click", handleFolderEditSave);
  document
    .getElementById("folderEditDelete")
    ?.addEventListener("click", handleFolderEditDelete);

  document
    .getElementById("folderColorPicker")
    ?.addEventListener("click", (e) => {
      const btn = e.target.closest(".folder-color-swatch");
      if (!btn) return;
      selectFolderColorSwatch(btn.dataset.color || "violet");
    });

  const customInput = document.getElementById("folderColorCustom");
  if (customInput) {
    const handler = () =>
      selectFolderColorSwatch(customInput.value || "#7c3aed");
    customInput.addEventListener("input", handler);
    customInput.addEventListener("change", handler);
  }

  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFolderEditDialog();
    if (e.key === "Enter" && e.target && e.target.id === "folderEditName")
      handleFolderEditSave();
  });
}

function selectFolderColorSwatch(color) {
  const isHex = typeof color === "string" && color.startsWith("#");
  document
    .querySelectorAll("#folderColorPicker .folder-color-swatch")
    .forEach((el) => {
      el.classList.toggle("is-selected", !isHex && el.dataset.color === color);
    });
  const customLabel = document.querySelector(
    "#folderColorPicker .folder-color-custom",
  );
  const customInput = document.getElementById("folderColorCustom");
  if (customLabel) {
    customLabel.classList.toggle("is-selected", isHex);
    customLabel.style.setProperty(
      "--swatch",
      isHex ? color : customInput ? customInput.value : "#7c3aed",
    );
  }
  if (
    customInput &&
    isHex &&
    customInput.value.toLowerCase() !== color.toLowerCase()
  ) {
    customInput.value = color;
  }
  if (_folderEditCtx) _folderEditCtx.color = color;
}

function openFolderEditDialog(folder) {
  initFolderEditDialog();
  const dlg = document.getElementById("folderEditDialog");
  if (!dlg) return;
  _folderEditCtx = {
    id: folder ? folder.id : "",
    color: folder ? folder.color || "violet" : "violet",
    parent_id: folder ? folder.parent_id || null : null,
  };
  const title = document.getElementById("folderEditDialogTitle");
  if (title) title.textContent = folder ? "Rename folder" : "New folder";
  const nameInput = document.getElementById("folderEditName");
  if (nameInput) {
    nameInput.value = folder ? folder.name : "";
    setTimeout(() => nameInput.focus(), 40);
  }
  // Pre-fill the native color picker with the equivalent hex color.
  const customInput = document.getElementById("folderColorCustom");
  if (customInput) customInput.value = folderColorHex(_folderEditCtx.color);
  selectFolderColorSwatch(_folderEditCtx.color);
  const delBtn = document.getElementById("folderEditDelete");
  if (delBtn) delBtn.classList.toggle("hidden", !folder);
  dlg.classList.remove("hidden");
  dlg.setAttribute("aria-hidden", "false");
  if (typeof tyHydrateIcons === "function") tyHydrateIcons(dlg);
}

function closeFolderEditDialog() {
  const dlg = document.getElementById("folderEditDialog");
  if (!dlg) return;
  dlg.classList.add("hidden");
  dlg.setAttribute("aria-hidden", "true");
  _folderEditCtx = null;
}

async function handleFolderEditSave() {
  if (!_folderEditCtx) return;
  const name = (document.getElementById("folderEditName") || {}).value || "";
  const trimmed = name.trim();
  if (!trimmed) {
    alert("Folder name is required.");
    return;
  }
  const payload = {
    name: trimmed,
    color: _folderEditCtx.color || "violet",
  };
  if (_folderEditCtx.id) {
    payload.id = _folderEditCtx.id;
    payload.parent_id = _folderEditCtx.parent_id;
  } else {
    // On creation, anchor the new folder in the current folder.
    payload.parent_id = state.currentTemplateFolderId || null;
  }
  const res = await api("template_folders", "POST", payload);
  if (!res.success) {
    alert("Save error: " + (res.error || ""));
    return;
  }
  closeFolderEditDialog();
  await loadTemplates();
}

async function handleFolderEditDelete() {
  if (!_folderEditCtx || !_folderEditCtx.id) return;
  const confirmed = await uiConfirm(
    "Delete this folder? The templates it contains will return to the root.",
    { title: "Delete folder", confirmLabel: "Delete folder" },
  );
  if (!confirmed) return;
  const res = await api("template_folder&id=" + _folderEditCtx.id, "DELETE");
  if (!res.success) {
    await uiAlert("Deletion error: " + (res.error || ""), {
      title: "Deletion failed",
    });
    return;
  }
  // If we were inside this folder, go back up to the root.
  if (state.currentTemplateFolderId === _folderEditCtx.id) {
    state.currentTemplateFolderId = "";
  }
  closeFolderEditDialog();
  await loadTemplates();
}

function cssEsc(value) {
  if (window.CSS && typeof window.CSS.escape === "function")
    return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch);
}

function clearTemplateForm() {
  destroyTemplateVisualEditor();
  state.templateHtmlEditMode = "code";
  document.getElementById("templateVisualWrap")?.classList.add("hidden");
  document.getElementById("templateCodeEditorWrap")?.classList.remove("hidden");
  document
    .getElementById("templateModeVisualBtn")
    ?.classList.remove("segmented-btn--active");
  document
    .getElementById("templateModeCodeBtn")
    ?.classList.add("segmented-btn--active");
  ["templateId", "templateName", "templateSubject", "templateText"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    },
  );
  setTemplateHtmlValue("");
  const ru = document.getElementById("templateRotateUrls");
  if (ru) ru.value = "";
  const re = document.getElementById("templateRotateEvery");
  if (re) re.value = "1";
  syncTemplateRotateHint();
}

async function editTemplate(id) {
  const res = await api("template&id=" + id);
  if (!res.success) return alert("Unable to load template.");
  const t = res.data;
  const setVal = (elId, val) => {
    const el = document.getElementById(elId);
    if (el) el.value = val || "";
  };
  setVal("templateId", t.id);
  setVal("templateName", t.name);
  setVal("templateSubject", t.subject);
  setTemplateHtmlValue(t.html || "");
  setVal("templateText", t.text);
  const ru = document.getElementById("templateRotateUrls");
  if (ru) {
    ru.value = Array.isArray(t.rotate_urls) ? t.rotate_urls.join("\n") : "";
  }
  const re = document.getElementById("templateRotateEvery");
  if (re) re.value = String(Math.max(1, parseInt(t.rotate_url_every, 10) || 1));
  openTemplateEditorModal();
  scheduleTemplateRotateHintSync();
}

async function saveTemplate(options = {}) {
  const closeAfter = options.closeAfter === true;
  const showToast = options.showToast !== false;

  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  const id = getVal("templateId");
  const name = getVal("templateName");
  const subject = getVal("templateSubject");
  const html = getTemplateHtmlValue().trim();
  const text = getVal("templateText");
  const rotate_urls = getTemplateRotateUrlsFromTextarea();
  const rotate_url_every = Math.max(
    1,
    parseInt(
      (document.getElementById("templateRotateEvery") || {}).value,
      10,
    ) || 1,
  );

  if (!name) return alert("Template name is required.");
  if (!subject) return alert("Template subject is required.");

  // Determine the target folder:
  //  - On edit: keep the template's current folder_id (don't move it back to the root)
  //  - On creation: if the user is in a folder, create the new template there
  let folderId = null;
  if (id) {
    const existing = (state.templates || []).find(
      (t) => String(t.id) === String(id),
    );
    folderId = existing && existing.folder_id ? existing.folder_id : null;
  } else {
    folderId = state.currentTemplateFolderId || null;
  }

  const body = {
    name,
    subject,
    html,
    text,
    rotate_urls,
    rotate_url_every,
    folder_id: folderId,
  };
  let res;
  if (id) {
    res = await api("templates", "POST", { ...body, id });
  } else {
    res = await api("templates", "POST", body);
  }

  if (!res.success) return alert("Error while saving: " + (res.error || ""));

  const savedId = res.data && res.data.id;
  if (savedId) {
    const hid = document.getElementById("templateId");
    if (hid) hid.value = savedId;
    const titleEl = document.getElementById("templateEditorModalTitle");
    if (titleEl) titleEl.textContent = "Edit template";
  }

  markTemplateEditorClean();
  await loadTemplates();

  if (showToast) showTemplateSaveToast();

  if (closeAfter) {
    hideTemplateUnsavedDialog();
    forceCloseTemplateEditorModal();
  }
}

async function deleteTemplate(id) {
  const confirmed = await uiConfirm("Delete this template?", {
    title: "Delete template",
    confirmLabel: "Delete template",
  });
  if (!confirmed) return;
  const res = await api("template&id=" + id, "DELETE");
  if (!res.success) {
    await uiAlert("Error while deleting: " + (res.error || ""));
    return;
  }
  await loadTemplates();
}

// ============================================
// CAMPAIGNS
// ============================================

async function initCampaigns() {
  await loadCampaigns();
  initProxyFormWiring();
  bindCampaignDetailInteractions();

  const campaignsList = document.getElementById("campaignsList");
  if (campaignsList && campaignsList.dataset.boundCampaignActions !== "1") {
    campaignsList.dataset.boundCampaignActions = "1";
    campaignsList.addEventListener("click", async (e) => {
      const actionBtn = e.target.closest("[data-campaign-action]");
      const card = e.target.closest(".campaign-card[data-campaign-id]");
      const campaignId =
        (actionBtn && actionBtn.getAttribute("data-campaign-id")) ||
        (card && card.getAttribute("data-campaign-id"));
      if (!campaignId) return;

      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const action = actionBtn.getAttribute("data-campaign-action");
        if (action === "monitor") await showCampaignDetail(campaignId);
        else if (action === "edit") await openEditCampaign(campaignId);
        else if (action === "relaunch") await relaunchCampaign(campaignId);
        else if (action === "delete") deleteCampaignCard(campaignId);
        return;
      }

      await showCampaignDetail(campaignId);
    });
  }

  const newBtn = document.getElementById("newCampaignBtn");
  if (newBtn) {
    newBtn.addEventListener("click", async () => {
      resetNewCampaignForm();
      document.getElementById("campaignForm").classList.remove("hidden");
      document.getElementById("campaignsList").classList.add("hidden");
      document.getElementById("campaignsEmptyState")?.classList.add("hidden");
      populateTemplateChips();
      await populateSmtpSelect();
    });
  }

  const cancelFormBtn = document.getElementById("cancelCampaignFormBtn");
  if (cancelFormBtn)
    cancelFormBtn.addEventListener("click", backToCampaignListFromForm);

  const exitEditBtn = document.getElementById("exitEditCampaignBtn");
  if (exitEditBtn)
    exitEditBtn.addEventListener("click", backToCampaignListFromForm);

  initUploadDragDrop();
  initCampaignSmtpInline();

  // Accordion
  document.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => {
      const body = header.nextElementSibling;
      const isOpen = !body.classList.contains("hidden");

      // Close all
      document
        .querySelectorAll(".accordion-body")
        .forEach((b) => b.classList.add("hidden"));
      document
        .querySelectorAll(".accordion-chevron")
        .forEach((c) => tySetAccordionChevron(c, false));

      if (!isOpen) {
        body.classList.remove("hidden");
        const chevron = header.querySelector(".accordion-chevron");
        if (chevron) tySetAccordionChevron(chevron, true);
      }
    });
  });

  // File upload
  const fileInput = document.getElementById("recipientsFile");
  if (fileInput) {
    fileInput.addEventListener("change", handleFileUpload);
  }

  // Analyze button
  const analyzeBtn = document.getElementById("analyzeBtn");
  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", handleAnalyze);
  }

  // Send button -> summary then confirmation
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) {
    sendBtn.addEventListener("click", () => openSendSummaryModal(false));
  }

  document
    .getElementById("sendSummaryCancel")
    ?.addEventListener("click", closeSendSummaryModal);
  document
    .getElementById("sendSummaryConfirm")
    ?.addEventListener("click", () => confirmSendSummaryAndRun());
  document
    .getElementById("sendSummaryModal")
    ?.addEventListener("click", (e) => {
      if (e.target && e.target.id === "sendSummaryModal")
        closeSendSummaryModal();
    });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const sm = document.getElementById("sendSummaryModal");
    if (sm && !sm.classList.contains("hidden")) closeSendSummaryModal();
  });

  // Force send -> same summary with score warning
  const forceSendLink = document.getElementById("forceSendLink");
  if (forceSendLink) {
    forceSendLink.addEventListener("click", (e) => {
      e.preventDefault();
      openSendSummaryModal(true);
    });
  }

  const confirmForce = document.getElementById("confirmForceSend");
  if (confirmForce) {
    confirmForce.addEventListener("click", () => {
      const modal = document.getElementById("forceSendModal");
      if (modal) modal.classList.add("hidden");
      openSendSummaryModal(true);
    });
  }

  const cancelForce = document.getElementById("cancelForceSend");
  if (cancelForce) {
    cancelForce.addEventListener("click", () => {
      const modal = document.getElementById("forceSendModal");
      if (modal) modal.classList.add("hidden");
    });
  }

  document
    .getElementById("cancelDeleteCampaign")
    ?.addEventListener("click", closeDeleteCampaignModal);
  document
    .getElementById("deleteCampaignModal")
    ?.addEventListener("click", (e) => {
      if (e.target && e.target.id === "deleteCampaignModal")
        closeDeleteCampaignModal();
    });
  document
    .getElementById("confirmDeleteCampaign")
    ?.addEventListener("click", confirmDeleteCampaign);

  initCsvMappingUI();
}

async function loadCampaigns() {
  const res = await api("campaigns");
  if (!res.success) return;
  state.campaignsCache = res.data || [];
  renderCampaignsList(state.campaignsCache);
}

function renderCampaignsList(campaigns) {
  const list = document.getElementById("campaignsList");
  const emptyEl = document.getElementById("campaignsEmptyState");
  if (!list) return;

  if (campaigns.length === 0) {
    list.innerHTML = "";
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      emptyEl.innerHTML = `
        <div class="empty-state-card">
          <div class="empty-state-icon" aria-hidden="true">${tyI("clipboard-list", 40)}</div>
          <h2 class="empty-state-title">No campaign</h2>
          <p class="empty-state-text">Create a new campaign from the <strong>New campaign</strong> button at the top right.</p>
        </div>`;
      if (typeof tyHydrateIcons === "function") tyHydrateIcons(emptyEl);
    }
    return;
  }

  if (emptyEl) {
    emptyEl.classList.add("hidden");
    emptyEl.innerHTML = "";
  }

  const statusMeta = {
    running: { icon: "activity", text: "Running", cls: "running" },
    completed: { icon: "check-circle", text: "Completed", cls: "done" },
    done: { icon: "check-circle", text: "Completed", cls: "done" },
    failed: { icon: "x-circle", text: "Failed", cls: "failed" },
    stopped: { icon: "square", text: "Stopped", cls: "done" },
    interrupted: {
      icon: "alert-triangle",
      text: "Interrupted",
      cls: "failed",
    },
    pending: { icon: "clock", text: "Pending", cls: "pending" },
  };

  list.innerHTML = campaigns
    .map((c) => {
      const stats = c.stats || {};
      const sm = statusMeta[c.status] || {
        icon: null,
        text: c.status || "Unknown",
        cls: "done",
      };
      const date = c.created_at
        ? new Date(c.created_at).toLocaleDateString("en-US", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "";
      const pct =
        stats.total > 0
          ? Math.round(((stats.sent || 0) / stats.total) * 100)
          : 0;
      const id = escAttr(c.id);
      return `
      <div class="campaign-card" data-campaign-id="${id}" role="button" tabindex="0">
        <div class="campaign-card-top">
          <div class="campaign-card-info">
            <span class="campaign-status-badge ${sm.cls}">${sm.icon ? tyI(sm.icon, 14) : ""}<span>${escHtml(sm.text)}</span></span>
            <div class="campaign-card-name">${escHtml(c.name || "Untitled")}</div>
            <div class="campaign-card-date">${date}</div>
          </div>
          <div class="campaign-card-stats">
            <div class="campaign-stat-item">
              <span class="campaign-stat-val success">${(stats.sent || 0).toLocaleString("en-US")}</span>
              <span class="campaign-stat-lbl">Sent</span>
            </div>
            <div class="campaign-stat-item">
              <span class="campaign-stat-val danger">${(stats.failed || 0).toLocaleString("en-US")}</span>
              <span class="campaign-stat-lbl">Failed</span>
            </div>
            <div class="campaign-stat-item">
              <span class="campaign-stat-val muted">${(stats.total || 0).toLocaleString("en-US")}</span>
              <span class="campaign-stat-lbl">Total</span>
            </div>
            ${
              stats.total > 0
                ? `
            <div class="campaign-stat-item">
              <span class="campaign-stat-val accent">${pct}%</span>
              <span class="campaign-stat-lbl">Progress</span>
            </div>`
                : ""
            }
          </div>
        </div>
        <div class="campaign-card-footer">
          <button type="button" class="btn btn-sm btn-with-icon" data-campaign-action="monitor" data-campaign-id="${id}">
            ${campaignIsActiveStatus(c.status) ? tyI("radio", 16) + " Monitoring" : tyI("list", 16) + " View logs"}
          </button>
          ${
            c.status !== "running"
              ? `<button type="button" class="btn btn-sm btn-primary btn-with-icon" data-campaign-action="edit" data-campaign-id="${id}">${tyI("pencil", 15)} Edit</button>
          <button type="button" class="btn btn-sm btn-with-icon" data-campaign-action="relaunch" data-campaign-id="${id}">${tyI("refresh-cw", 15)} Relaunch</button>`
              : ""
          }
          <span class="btn-spacer"></span>
          <button type="button" class="btn btn-sm btn-danger btn-with-icon" title="Delete" aria-label="Delete campaign" data-campaign-action="delete" data-campaign-id="${id}">${tyI("trash", 16)}</button>
        </div>
      </div>
    `;
    })
    .join("");
}

async function populateTemplateChips() {
  const container = document.getElementById("templateSelector");
  if (!container) return;

  const res = await api("templates");
  if (!res.success) return;
  const templates = res.data || [];

  container.innerHTML = templates
    .map(
      (t) => `
    <div class="template-chip" data-id="${t.id}" data-subject="${escAttr(t.subject || "")}">
      ${escHtml(t.name)}
    </div>
  `,
    )
    .join("");

  container.querySelectorAll(".template-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("selected");
      refreshCampaignSendButtonState();
    });
  });
}

async function populateSmtpSelect(preferId = null, options = {}) {
  const select = document.getElementById("smtpConfigSelect");
  if (!select) return;

  const preferredFromEmail =
    options.preferredFromEmail != null ? options.preferredFromEmail : "";
  const preferredRotationIds = Array.isArray(options.preferredRotationIds)
    ? options.preferredRotationIds.map(String)
    : [];
  const preferredSenderMap =
    options.preferredSenderMap && typeof options.preferredSenderMap === "object"
      ? options.preferredSenderMap
      : null;

  const keep =
    preferId != null && preferId !== ""
      ? String(preferId)
      : select.value && select.value !== "__new__"
        ? select.value
        : "";

  state.suppressSmtpSelectChange = true;

  const res = await api("smtp_configs");
  if (!res.success) {
    state.suppressSmtpSelectChange = false;
    return;
  }
  state.smtpConfigs = res.data || [];

  const opts = [
    '<option value="">— Choose an SMTP —</option>',
    '<option value="__new__">+ New SMTP (create and use)</option>',
    ...state.smtpConfigs.map((s) => {
      const id = String(s.id).replace(/"/g, "&quot;");
      return `<option value="${id}">${escHtml(s.name || s.host || "Config " + s.id)}</option>`;
    }),
  ];
  select.innerHTML = opts.join("");

  const rotSelect = document.getElementById("smtpRotationSelect");
  if (rotSelect) {
    renderSmtpRotationChecklist(preferredRotationIds);
  }

  const optValues = [...select.options].map((o) => o.value);
  if (keep && optValues.includes(keep)) {
    select.value = keep;
    toggleCampaignSmtpNewPanel(false);
    syncCustomSelect(select);
  } else if (select.value === "__new__") {
    toggleCampaignSmtpNewPanel(true);
    syncCustomSelect(select);
  } else {
    toggleCampaignSmtpNewPanel(false);
    syncCustomSelect(select);
  }

  syncRotationSelectionWithPrimarySmtp();
  renderSmtpSenderOverridesList(preferredSenderMap);
  syncSmtpSenderOverridesDisabledState();
  syncCampaignFromEmailVisibility();

  state.suppressSmtpSelectChange = false;
  await refreshCampaignVerifiedSenders({
    silent: true,
    preferredEmail: preferredFromEmail,
  });
}

function formatUploadError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.kind && err.message) return `${err.kind}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

async function saveRecipientUpload(file, fileType) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    throw new Error("Backend Tauri unavailable.");
  }

  const start = await invoke("start_upload", {
    filename: file.name,
    fileType,
  });
  if (!start.success) throw new Error(start.error || "Upload start failed");
  const uploadId = start.data && start.data.upload_id;
  if (!uploadId) throw new Error("Upload start failed: missing upload id");

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      const res = await invoke("append_upload_chunk", {
        uploadId,
        bytes: Array.from(chunk),
      });
      if (!res.success) throw new Error(res.error || "Upload chunk failed");
    }

    const done = await invoke("finish_upload", {
      uploadId,
      filename: file.name,
      fileType,
    });
    if (!done.success)
      throw new Error(done.error || "Upload validation failed");
    return done;
  } catch (err) {
    try {
      await invoke("abort_upload", { uploadId });
    } catch (_) {
      /* best effort cleanup */
    }
    throw err;
  }
}

async function applyRecipientUploadResponse(data, fallbackFileType = "csv") {
  if (!data || !data.success) {
    throw new Error((data && data.error) || "Upload failed");
  }
  const payload = data.data || {};
  const fileType = payload.file_type || fallbackFileType;
  state.uploadedFilePath = payload.filepath;
  state.uploadedFileType = fileType;

  if (fileType === "txt") {
    showCsvMappingPanel(false);
    clearCsvCustomVarRows();
    state.csvHeaders = [];
    setCsvMappingWarning("");
    const parseRes = await api("parse_recipients", "POST", {
      file_path: state.uploadedFilePath,
      file_type: "txt",
    });
    if (!parseRes.success) {
      throw new Error("Parsing error: " + (parseRes.error || ""));
    }

    state.uploadedTotal = parseRes.data.total || 0;
    const domains = parseRes.data.domains || {};
    const summaryEl = document.getElementById("domainSummary");
    if (summaryEl) {
      const parts = Object.entries(domains)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(
          ([domain, count]) =>
            `${capitalize(domain)}: ${count.toLocaleString()}`,
        );
      summaryEl.textContent =
        parts.join(" | ") + ` (Total: ${state.uploadedTotal.toLocaleString()})`;
      summaryEl.classList.toggle("hidden", state.uploadedTotal === 0);
    }
    document
      .getElementById("domainFilters")
      ?.classList.toggle("hidden", state.uploadedTotal === 0);
  } else {
    const headers = (payload.validation && payload.validation.headers) || [];
    state.csvHeaders = Array.isArray(headers) ? headers : [];
    clearCsvCustomVarRows();
    showCsvMappingPanel(state.csvHeaders.length > 0);
    populateCsvColumnSelects();
    const emailGuess = inferEmailColumnFromHeaders(state.csvHeaders);
    const em = document.getElementById("csvEmailColumn");
    if (
      em &&
      emailGuess &&
      [...em.options].some((o) => o.value === emailGuess)
    ) {
      em.value = emailGuess;
    } else if (em) {
      em.value = "";
    }
    await reparseRecipientsWithCurrentMapping();
  }

  updateUploadFileHint();
  refreshCampaignSendButtonState();
}

async function handleFileUpload() {
  const input = document.getElementById("recipientsFile");
  if (!input || !input.files[0]) return;

  const file = input.files[0];
  const ext = file.name.split(".").pop().toLowerCase();
  if (["xlsx", "xls"].includes(ext)) {
    alert(
      "Excel files are not supported. Export your table as CSV (one header row + one row per contact).",
    );
    input.value = "";
    return;
  }
  const fileType = ext === "txt" ? "txt" : "csv";

  try {
    const data = await saveRecipientUpload(file, fileType);
    await applyRecipientUploadResponse(data, fileType);
  } catch (err) {
    alert("Error during upload: " + formatUploadError(err));
  }
}

async function importRecipientFilePath(path) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Backend Tauri unavailable.");
  const data = await invoke("import_recipient_file", { path });
  await applyRecipientUploadResponse(data, data?.data?.file_type || "csv");
}

async function pickRecipientFileNative() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  const data = await invoke("pick_recipient_file");
  if (!data.success && data.error === "No file selected") return true;
  await applyRecipientUploadResponse(data, data?.data?.file_type || "csv");
  return true;
}

async function handleAnalyze() {
  const cfg = collectCampaignConfig();
  if (cfg.template_ids.length === 0)
    return alert("Select at least one template.");
  if (!hasUsableFromEmail(cfg)) return alert("Choose a sender email.");

  const res = await api("score", "POST", {
    template_ids: cfg.template_ids,
    campaign: {
      from_email: cfg.from_email,
      unsubscribe_url: cfg.unsubscribe_url,
    },
  });

  if (!res.success) return alert("Analysis error: " + (res.error || ""));

  state.scoreData = res.data;

  const displayEl = document.getElementById("scoreDisplay");
  if (displayEl) {
    displayEl.classList.remove("hidden");
    renderScore(res.data, displayEl);
  }

  refreshCampaignSendButtonState();
}

function validateCampaignBeforeSend(force = false) {
  const config = collectCampaignConfig({ force_send: force });
  if (config.template_ids.length === 0) return "Select at least one template.";
  if (config.smtp_rotation_enabled) {
    if (
      !Array.isArray(config.smtp_rotation_ids) ||
      config.smtp_rotation_ids.length === 0
    ) {
      return "Select at least one SMTP for rotation.";
    }
  } else if (!config.smtp_config_id) {
    const sel = document.getElementById("smtpConfigSelect");
    if (sel && sel.value === "__new__") {
      return 'Save the new SMTP first ("Save & use for this campaign"), or select an existing configuration.';
    }
    return "Choose an SMTP configuration.";
  }
  if (!hasUsableFromEmail(config))
    return "Choose a sender email (API list or manual entry depending on the provider).";
  if (config.sender_local_rotation_enabled) {
    if (!config.sender_local_rotation_domain) {
      return "Choose a verified domain before enabling From address rotation.";
    }
    if (
      !Array.isArray(config.sender_local_rotation_parts) ||
      config.sender_local_rotation_parts.length === 0
    ) {
      return "Add at least one local part to rotate the From address.";
    }
  }
  if (config.sender_name_rotation_enabled) {
    if (
      !Array.isArray(config.sender_name_rotation_names) ||
      config.sender_name_rotation_names.length === 0
    ) {
      return "Add at least one display name to rotate, or disable sender name rotation.";
    }
  }
  if (config.smtp_sender_mode === "per_smtp") {
    const per =
      config.smtp_per_smtp && typeof config.smtp_per_smtp === "object"
        ? config.smtp_per_smtp
        : {};
    const ids = listSmtpIdsFromConfig(config);
    for (const id of ids) {
      const row = per[id];
      if (!row || typeof row !== "object") {
        return "Configure the per-SMTP sender, or switch back to the default sender.";
      }
      if (
        row.use_default_from === false &&
        !String(row.from_email || "").trim()
      ) {
        return `Fill in a From email for the SMTP ${smtpLabelForId(id)} (or check "Use default From email").`;
      }
    }
  }
  if (!config.file_path)
    return "Import a recipient list (or reopen the campaign if the file was lost).";
  if (!state.editingCampaignId) {
    if (!force && (!state.scoreData || state.scoreData.score < 50)) {
      return 'Run the deliverability analysis first, or use "Send anyway" if you accept the risk.';
    }
  }
  return null;
}

function formatEtaSeconds(sec) {
  if (sec == null || sec <= 0 || !Number.isFinite(sec)) return "—";
  if (sec < 90) return `≈ ${Math.max(1, Math.ceil(sec))} s`;
  if (sec < 3600) return `≈ ${Math.ceil(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.ceil((sec % 3600) / 60);
  return `≈ ${h} h ${m} min`;
}

function estimateEtaSeconds(totalOrRemaining, cfg = {}) {
  const count = Math.max(0, Number(totalOrRemaining) || 0);
  const dmin = Math.max(
    0,
    parseFloat(String(cfg.delay_min ?? 1).replace(",", ".")) || 0,
  );
  const dmax = Math.max(
    dmin,
    parseFloat(String(cfg.delay_max ?? dmin).replace(",", ".")) || dmin,
  );
  const mode =
    cfg.smtp_rotation_mode === "parallel" ? "parallel" : "sequential";
  const smtpCount =
    cfg.smtp_rotation_enabled && Array.isArray(cfg.smtp_rotation_ids)
      ? Math.max(1, cfg.smtp_rotation_ids.filter(Boolean).length)
      : 1;
  if (mode !== "parallel" || smtpCount <= 1) {
    return { low: count * dmin, high: count * dmax };
  }
  const perLane = Math.ceil(count / smtpCount);
  return { low: perLane * dmin, high: perLane * dmax };
}

function stopCampaignCompletionWatch() {
  if (state.completionWatchTimer != null) {
    clearInterval(state.completionWatchTimer);
    state.completionWatchTimer = null;
  }
  state.completionWatchCampaignId = null;
  state.completionWatchName = null;
}

function showCampaignDoneNotification(name, status) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const labels = {
    completed: "completed successfully",
    failed: "failed",
    stopped: "stopped",
    interrupted: "interrompue",
  };
  const body = `"${name || "Campaign"}": ${labels[status] || status}.`;
  try {
    new Notification("WinMail — Sending completed", {
      body,
      tag: "tydra-end-" + status,
      requireInteraction: false,
    });
  } catch (e) {
    /* ignore */
  }
}

function startCampaignCompletionWatch(campaignId, displayName) {
  stopCampaignCompletionWatch();
  if (!campaignId) return;
  state.completionWatchCampaignId = campaignId;
  state.completionWatchName = displayName || "";
  state.completionWatchTimer = setInterval(async () => {
    if (state.completionWatchCampaignId !== campaignId) {
      stopCampaignCompletionWatch();
      return;
    }
    const res = await api("campaign&id=" + encodeURIComponent(campaignId));
    if (!res.success || !res.data) return;
    const st = res.data.status;
    if (!["completed", "failed", "stopped", "interrupted"].includes(st)) return;
    stopCampaignCompletionWatch();
    showCampaignDoneNotification(
      res.data.name || state.completionWatchName,
      st,
    );
  }, 3200);
}

async function openSendSummaryModal(forceSend = false) {
  await ensureSmtpConfigs();
  await loadTemplates();
  const err = validateCampaignBeforeSend(forceSend);
  if (err) return alert(err);

  const nameEl = document.getElementById("campaignName");
  const name =
    nameEl && nameEl.value.trim()
      ? nameEl.value.trim()
      : "Campaign " + Date.now();
  const config = collectCampaignConfig({ force_send: forceSend });
  const chips = Array.from(
    document.querySelectorAll(".template-chip.selected"),
  );
  const templateNames = chips.map((ch) => {
    const id = ch.dataset.id;
    const t = (state.templates || []).find((x) => String(x.id) === String(id));
    return t ? t.name : id;
  });

  const total = state.uploadedTotal || config.total_recipients || 0;
  const delayMin = config.delay_min ?? 1;
  const delayMax = config.delay_max ?? 3;
  const avgDelay = (delayMin + delayMax) / 2;
  const eta = estimateEtaSeconds(total, config);
  const etaLow = eta.low;
  const etaHigh = eta.high;

  const scoreBlock =
    state.scoreData && typeof state.scoreData.score === "number"
      ? `<div class="send-summary-score ${state.scoreData.score < 50 ? "send-summary-score--warn" : ""}">Deliverability score: <strong>${state.scoreData.score}</strong>/100</div>`
      : state.editingCampaignId
        ? '<p class="send-summary-note">Existing campaign - score not recalculated in this summary.</p>'
        : "";

  const forceWarn =
    forceSend && state.scoreData && state.scoreData.score < 50
      ? '<p class="send-summary-warning"><strong>Forced send</strong>: the score is below the recommended threshold.</p>'
      : "";

  const notifyHint = document.getElementById("sendSummaryNotifyHint");
  if (notifyHint) {
    const p =
      typeof Notification !== "undefined" ? Notification.permission : "denied";
    notifyHint.classList.toggle("hidden", p === "granted");
  }

  const body = document.getElementById("sendSummaryBody");
  if (body) {
    body.innerHTML = `
      ${forceWarn}
      ${scoreBlock}
      <ul class="send-summary-list">
        <li><span>Name</span><strong>${escHtml(name)}</strong></li>
        <li><span>Recipients (file)</span><strong>${total.toLocaleString("en-US")}</strong></li>
        <li><span>Templates</span><strong>${templateNames.length ? escHtml(templateNames.join(", ")) : "—"}</strong></li>
        <li><span>Sender</span><strong>${escHtml(formatSenderRoutingLabel(config))}</strong></li>
        <li><span>SMTP</span><strong>${escHtml(formatSmtpRoutingLabel(config))}</strong></li>
        <li><span>Delay between emails</span><strong>${delayMin}–${delayMax} s (avg. ${avgDelay.toFixed(1)} s${config.smtp_rotation_enabled && config.smtp_rotation_mode === "parallel" ? ", per SMTP" : ""})</strong></li>
        <li><span>Estimated duration (rough)</span><strong>${formatEtaSeconds(etaLow)} — ${formatEtaSeconds(etaHigh)}</strong></li>
        <li><span>Template rotation</span><strong>every ${config.template_rotation_frequency || 1} email(s)</strong></li>
        <li><span>List file</span><strong>${escHtml((config.file_path || "").split("/").pop() || "—")}</strong></li>
      </ul>
    `;
  }

  state.sendSummaryPending = { forceSend, name, config };
  document.getElementById("sendSummaryModal")?.classList.remove("hidden");
  document
    .getElementById("sendSummaryModal")
    ?.setAttribute("aria-hidden", "false");
}

function closeSendSummaryModal() {
  document.getElementById("sendSummaryModal")?.classList.add("hidden");
  document
    .getElementById("sendSummaryModal")
    ?.setAttribute("aria-hidden", "true");
  state.sendSummaryPending = null;
}

async function confirmSendSummaryAndRun() {
  const pending = state.sendSummaryPending;
  if (!pending) return;

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    try {
      await Notification.requestPermission();
    } catch (e) {
      /* ignore */
    }
  }

  const { forceSend, name, config } = pending;
  closeSendSummaryModal();

  let campaignId;
  const shouldResumeAfterEdit = !!(
    state.editingCampaignId && state.resumeCampaignAfterEdit
  );
  if (state.editingCampaignId) {
    const putRes = await api(
      "campaign&id=" + encodeURIComponent(state.editingCampaignId),
      "PUT",
      { name, config },
    );
    if (!putRes.success)
      return alert("Campaign update error: " + (putRes.error || ""));
    campaignId = state.editingCampaignId;
  } else {
    const createRes = await api("campaigns", "POST", { name, config });
    if (!createRes.success)
      return alert("Campaign creation error: " + (createRes.error || ""));
    campaignId = createRes.data && createRes.data.id;
    if (!campaignId) return alert("Unable to retrieve campaign ID.");
  }

  state.currentCampaignId = campaignId;
  let sendRes;
  if (shouldResumeAfterEdit) {
    const stopRes = await api("stop", "POST", { campaign_id: campaignId });
    if (!stopRes.success)
      return alert("Pause/apply error: " + (stopRes.error || ""));
    await new Promise((resolve) => setTimeout(resolve, 700));
    sendRes = await api("send", "POST", { campaign_id: campaignId });
  } else {
    sendRes = await api("send", "POST", { campaign_id: campaignId });
  }
  if (!sendRes.success)
    return alert(
      (shouldResumeAfterEdit ? "Resume with changes" : "Send") +
        " error: " +
        (sendRes.error || ""),
    );

  startCampaignCompletionWatch(campaignId, name);

  // Wait for the engine to flip the campaign status to an active state before
  // rendering the monitoring view — otherwise pause/stop buttons won't appear.
  await waitForCampaignActiveStatus(campaignId);

  state.editingCampaignId = null;
  state.resumeCampaignAfterEdit = false;
  state.editReturnToMonitoringId = null;
  setCampaignFormEditMode(false);
  document.getElementById("campaignForm")?.classList.add("hidden");
  await showCampaignDetail(campaignId);
}

// ============================================
// CAMPAIGN DETAIL VIEW
// ============================================

async function showCampaignDetail(campaignId) {
  state.currentCampaignId = campaignId;
  state.editingCampaignId = null;
  setCampaignFormEditMode(false);

  // Hide list and form, show detail
  const list = document.getElementById("campaignsList");
  const form = document.getElementById("campaignForm");
  const detail = document.getElementById("campaignDetail");
  const newBtn = document.getElementById("newCampaignBtn");
  if (list) list.classList.add("hidden");
  if (form) form.classList.add("hidden");
  if (newBtn) newBtn.classList.add("hidden");
  if (detail) detail.classList.remove("hidden");

  // Clear logs
  const logsContainer = document.getElementById("detailLogsContainer");
  if (logsContainer)
    logsContainer.innerHTML = '<div class="log-line info">Loading...</div>';

  // Load campaign with logs — retry once to account for filesystem timing on
  // Windows where the engine may not have flushed the status yet.
  let res = await api("campaign&id=" + campaignId + "&with_logs");
  if (!res.success || !res.data) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    res = await api("campaign&id=" + campaignId + "&with_logs");
  }
  if (!res.success || !res.data) {
    if (logsContainer)
      logsContainer.innerHTML =
        '<div class="log-line failed">Unable to load campaign.</div>';
    return;
  }

  const campaign = res.data;
  const stats = campaign.stats || {};
  state.paused = campaign.status === "paused";
  state.configCacheForDetailEta = campaign.config || {};

  // Header
  const nameEl = document.getElementById("detailCampaignName");
  if (nameEl) nameEl.textContent = campaign.name || "Campaign";

  const statusMeta = {
    pending: { icon: "clock", text: "Starting", color: "#64748b" },
    running: { icon: "activity", text: "Running", color: "#22c55e" },
    paused: { icon: "pause", text: "Paused", color: "#f59e0b" },
    completed: { icon: "check-circle", text: "Completed", color: "#64748b" },
    done: { icon: "check-circle", text: "Completed", color: "#64748b" },
    failed: { icon: "x-circle", text: "Failed", color: "#ef4444" },
    stopped: { icon: "square", text: "Stopped", color: "#f59e0b" },
    interrupted: {
      icon: "alert-triangle",
      text: "Interrupted",
      color: "#f59e0b",
    },
  };
  const sm = statusMeta[campaign.status] || {
    icon: null,
    text: campaign.status,
    color: "#64748b",
  };
  const badgeEl = document.getElementById("detailStatusBadge");
  if (badgeEl) {
    badgeEl.style.color = sm.color;
    badgeEl.innerHTML =
      (sm.icon ? tyI(sm.icon, 16) : "") +
      "<span>" +
      escHtml(sm.text) +
      "</span>";
  }

  await ensureSmtpConfigs();
  const cfg = campaign.config || {};
  const metaBar = document.getElementById("detailMetaBar");
  if (metaBar) {
    const fromLine = escHtml(formatSenderRoutingLabel(cfg));
    metaBar.innerHTML = `
      <span><strong>From:</strong> ${fromLine}</span>
      <span><strong>SMTP :</strong> ${escHtml(formatSmtpRoutingLabel(cfg))}</span>
      <span><strong>List:</strong> ${escHtml((cfg.file_path || "").split("/").pop() || "—")}</span>
    `;
    metaBar.classList.remove("hidden");
  }

  const editHint = document.getElementById("detailEditHint");
  if (editHint) {
    if (campaign.status === "running") {
      editHint.textContent =
        'Use "Pause" to temporarily stop sending, or "Pause & edit" to modify settings then resume from the current progress.';
      editHint.classList.remove("hidden");
    } else if (campaign.status === "paused") {
      editHint.textContent =
        'Campaign is paused. You can edit settings, then "Save & resume" to continue from the current progress.';
      editHint.classList.remove("hidden");
    } else {
      editHint.textContent =
        'To change the list, sender or SMTP before a new send, use "Edit campaign".';
      editHint.classList.remove("hidden");
    }
  }

  updateDetailStatsFromServer(stats, campaign.status);

  // Action buttons
  const actionsEl = document.getElementById("detailActions");
  const cid = escAttr(campaignId);
  if (actionsEl) {
    if (campaignIsActiveStatus(campaign.status)) {
      const pauseIcon = campaign.status === "paused" ? "play" : "pause";
      const pauseText =
        campaign.status === "paused" ? "Resume sending" : "Pause only";
      const editButton =
        campaign.status === "paused"
          ? `<button type="button" class="btn-primary btn-with-icon" data-detail-action="edit" data-campaign-id="${cid}">${tyI("pencil", 16)} Edit & resume</button>`
          : `<button type="button" class="btn-secondary btn-with-icon" data-detail-action="pause-edit" data-campaign-id="${cid}">${tyI("pencil", 16)} Pause + edit</button>`;
      actionsEl.innerHTML = `
        <button type="button" class="btn-warning btn-with-icon" id="detailPauseBtn" data-detail-action="pause" data-campaign-id="${cid}">${tyI(pauseIcon, 16)} ${pauseText}</button>
        ${editButton}
        <button type="button" class="btn-danger btn-with-icon" id="detailStopBtn" data-detail-action="stop" data-campaign-id="${cid}">${tyI("square", 16)} Stop</button>
      `;
    } else {
      actionsEl.innerHTML = `
        <button type="button" class="btn-primary btn-with-icon" data-detail-action="edit" data-campaign-id="${cid}">${tyI("pencil", 16)} Edit campaign</button>
        <button type="button" class="btn-secondary btn-with-icon" data-detail-action="relaunch" data-campaign-id="${cid}">${tyI("refresh-cw", 16)} Relaunch as is</button>
      `;
    }
  }

  // Logs indicator
  const indicator = document.getElementById("detailLogsIndicator");
  if (indicator) {
    if (campaignIsActiveStatus(campaign.status)) {
      const label = campaign.status === "paused" ? "paused" : "live";
      indicator.innerHTML = tyI("activity", 12) + ` <span>${label}</span>`;
      indicator.style.color =
        campaign.status === "paused" ? "#f59e0b" : "#22c55e";
    } else {
      indicator.innerHTML =
        tyI("check", 12) + " <span>" + (stats.sent || 0) + " sent</span>";
      indicator.style.color = "#64748b";
    }
  }

  // Populate logs from API
  // The server now returns `logs_total` (monotonic counter of the full file)
  // in addition to the last 500 lines, to allow incremental streaming.
  const logsTotal = Number.isFinite(campaign.logs_total)
    ? campaign.logs_total
    : (campaign.logs || []).length;
  if (logsContainer) {
    const logs = campaign.logs || [];
    if (logs.length === 0 && !campaignIsActiveStatus(campaign.status)) {
      logsContainer.innerHTML =
        '<div class="log-line info" style="color:#64748b">No logs available for this campaign.</div>';
    } else {
      logsContainer.innerHTML = "";
      logs.forEach((line) => {
        const div = document.createElement("div");
        // Detect status from log content
        const lower = line.toLowerCase();
        div.className =
          "log-line " +
          (lower.includes("error") || lower.includes("failed")
            ? "failed"
            : lower.includes("sent") || lower.includes("ok")
              ? "ok"
              : "info");
        div.textContent = line;
        logsContainer.appendChild(div);
      });
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  }

  // Live updates come from the Tauri event bus (progress + per-line logs).
  // Only fall back to HTTP polling when those events are unavailable, so we
  // never append the same log line twice.
  if (campaignIsActiveStatus(campaign.status)) {
    state.campaignLogCursor = logsTotal;
    if (!state.liveEventsActive) {
      startCampaignPolling(campaignId, logsTotal);
    } else {
      stopCampaignMonitor();
    }
  } else {
    stopCampaignMonitor();
  }
}

async function backToCampaignList() {
  stopCampaignMonitor();
  state.paused = false;

  const detail = document.getElementById("campaignDetail");
  const list = document.getElementById("campaignsList");
  const newBtn = document.getElementById("newCampaignBtn");
  if (detail) detail.classList.add("hidden");
  if (list) list.classList.remove("hidden");
  if (newBtn) newBtn.classList.remove("hidden");

  await loadCampaigns();
}

async function relaunchCampaign(campaignId) {
  const confirmed = await uiConfirm(
    'Relaunch sending with the settings currently saved on this campaign? (Use "Edit campaign" to change them.)',
    { title: "Relaunch campaign", confirmLabel: "Relaunch", danger: false },
  );
  if (!confirmed) return;

  const res = await api("send", "POST", { campaign_id: campaignId });
  if (!res.success) return alert("Relaunch error: " + (res.error || ""));

  // Wait for the engine to set the campaign status to an active state before
  // showing the monitoring view — otherwise the pause/stop buttons won't
  // appear because the status on disk is still the old one.
  await waitForCampaignActiveStatus(campaignId);

  const campRes = await api("campaign&id=" + encodeURIComponent(campaignId));
  startCampaignCompletionWatch(campaignId, campRes.data?.name || "");
  await showCampaignDetail(campaignId);
}

async function waitForCampaignActiveStatus(campaignId, maxWaitMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const res = await api("campaign&id=" + encodeURIComponent(campaignId));
      if (res.success && res.data && campaignIsActiveStatus(res.data.status)) {
        return;
      }
    } catch (_) {
      /* retry */
    }
  }
}

function closeDeleteCampaignModal() {
  state.deleteCampaignPendingId = null;
  const modal = document.getElementById("deleteCampaignModal");
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

async function deleteCampaignCard(campaignId) {
  if (!campaignId) return;
  state.deleteCampaignPendingId = campaignId;
  const campaign = (state.campaignsCache || []).find(
    (c) => String(c.id) === String(campaignId),
  );
  const text = document.getElementById("deleteCampaignText");
  if (text) {
    text.textContent = `This will permanently delete “${campaign?.name || campaignId}” and its logs. This action cannot be undone.`;
  }
  const modal = document.getElementById("deleteCampaignModal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }
}

async function confirmDeleteCampaign() {
  const campaignId = state.deleteCampaignPendingId;
  if (!campaignId) return closeDeleteCampaignModal();
  const btn = document.getElementById("confirmDeleteCampaign");
  if (btn) btn.disabled = true;
  const res = await api(
    "campaign&id=" + encodeURIComponent(campaignId),
    "DELETE",
  );
  if (btn) btn.disabled = false;
  if (!res.success) return alert("Error while deleting: " + (res.error || ""));
  const wasCurrent =
    String(state.currentCampaignId || "") === String(campaignId);
  closeDeleteCampaignModal();
  if (wasCurrent) await backToCampaignList();
  else await loadCampaigns();
}

async function handlePause() {
  if (!state.currentCampaignId) return;
  const campaignId = state.currentCampaignId;
  const pauseBtn = document.getElementById("detailPauseBtn");
  if (pauseBtn) pauseBtn.disabled = true;

  const action = state.paused ? "resume" : "pause";
  const res = await api(action, "POST", { campaign_id: campaignId });
  if (!res.success) {
    if (pauseBtn) pauseBtn.disabled = false;
    return alert(
      (state.paused ? "Resume" : "Pause") + " error: " + (res.error || ""),
    );
  }

  state.paused = !state.paused;
  await showCampaignDetail(campaignId);
}

async function handleStop() {
  if (!state.currentCampaignId) return;
  const confirmed = await uiConfirm("Permanently stop the campaign?", {
    title: "Stop campaign",
    confirmLabel: "Stop",
  });
  if (!confirmed) return;
  const campaignId = state.currentCampaignId;
  const stopBtn = document.getElementById("detailStopBtn");
  if (stopBtn) stopBtn.disabled = true;

  const res = await api("stop", "POST", { campaign_id: campaignId });
  if (!res.success) {
    if (stopBtn) stopBtn.disabled = false;
    return alert("Stop error: " + (res.error || ""));
  }

  // The `campaign://stopped` event finalizes the UI when the bus is live.
  // Otherwise resume polling from the current cursor (no re-streaming).
  if (!state.liveEventsActive) {
    const cursor =
      typeof state.campaignLogCursor === "number"
        ? state.campaignLogCursor
        : document.querySelectorAll("#detailLogsContainer .log-line").length;
    startCampaignPolling(campaignId, cursor);
  }
  await showCampaignDetail(campaignId);
}

// ============================================
// Campaign monitoring (polling — php -S compatible)
// ============================================

function stopCampaignMonitor() {
  if (state.campaignPollTimer != null) {
    clearInterval(state.campaignPollTimer);
    state.campaignPollTimer = null;
  }
}

function logLineClassFromContent(line) {
  const lower = String(line).toLowerCase();
  if (lower.includes("error") || lower.includes("failed")) return "failed";
  if (lower.includes("sent")) return "ok";
  return "info";
}

function updateDetailStatsFromServer(stats, status) {
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const sent = stats.sent || 0;
  const failed = stats.failed || 0;
  const total = stats.total || 0;
  const remaining = Math.max(0, total - sent - failed);
  setText("detailSent", sent.toLocaleString("en-US"));
  setText("detailFailed", failed.toLocaleString("en-US"));
  setText("detailTotal", total.toLocaleString("en-US"));
  setText(
    "detailRemaining",
    status === "running" ? remaining.toLocaleString("en-US") : "—",
  );
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  setText("detailPercent", pct + "%");
  const circumference = 201;
  const ring = document.getElementById("detailRingFill");
  if (ring) ring.style.strokeDashoffset = circumference * (1 - pct / 100);

  const etaEl = document.getElementById("detailEta");
  if (etaEl) {
    if (
      status === "running" &&
      remaining > 0 &&
      state.configCacheForDetailEta
    ) {
      const cfg = state.configCacheForDetailEta;
      const eta = estimateEtaSeconds(remaining, cfg);
      etaEl.textContent = formatEtaSeconds((eta.low + eta.high) / 2);
    } else {
      etaEl.textContent = "—";
    }
  }
}

/**
 * Incremental polling of a campaign's logs.
 *
 * @param {string} campaignId
 * @param {number} initialCursor  cursor position (logs_total already displayed).
 *                                The backend then returns only the lines
 *                                after this cursor, which avoids the historical
 *                                blocking that occurred beyond 500 lines.
 */
function startCampaignPolling(campaignId, initialCursor = 0) {
  stopCampaignMonitor();
  let cursor =
    typeof initialCursor === "number" && initialCursor >= 0 ? initialCursor : 0;
  state.campaignLogCursor = cursor;

  const tick = async () => {
    if (state.currentCampaignId !== campaignId) {
      stopCampaignMonitor();
      return;
    }
    const res = await api(
      "campaign&id=" +
        encodeURIComponent(campaignId) +
        "&with_logs&log_offset=" +
        encodeURIComponent(String(cursor)),
    );
    if (!res.success || !res.data) return;

    const camp = res.data;
    const stats = camp.stats || {};
    updateDetailStatsFromServer(stats, camp.status);

    const newLines = Array.isArray(camp.logs) ? camp.logs : [];
    const serverTotal = Number.isFinite(camp.logs_total)
      ? camp.logs_total
      : cursor + newLines.length;
    const container = document.getElementById("detailLogsContainer");

    if (container && newLines.length > 0) {
      // Remove any "No logs available" placeholder on first add.
      container.querySelectorAll(".log-line").forEach((el) => {
        const txt = (el.textContent || "").trim();
        if (txt.startsWith("No logs available") || txt === "Loading...") {
          el.remove();
        }
      });
      const frag = document.createDocumentFragment();
      newLines.forEach((raw) => {
        const div = document.createElement("div");
        div.className = "log-line " + logLineClassFromContent(raw);
        div.textContent = raw;
        frag.appendChild(div);
      });
      container.appendChild(frag);
      container.scrollTop = container.scrollHeight;
    }

    // The cursor always follows the server total, even without a new line.
    cursor = serverTotal;
    state.campaignLogCursor = cursor;

    const indicator = document.getElementById("detailLogsIndicator");
    const terminal = ["completed", "failed", "stopped", "interrupted"].includes(
      camp.status,
    );
    if (indicator) {
      if (terminal) {
        indicator.innerHTML =
          tyI("check-circle", 12) + " <span>completed</span>";
        indicator.style.color = "#64748b";
      } else if (camp.status === "running") {
        indicator.innerHTML =
          tyI("activity", 12) + " <span>live (auto refresh)</span>";
        indicator.style.color = "#22c55e";
      } else if (camp.status === "paused") {
        indicator.innerHTML = tyI("pause", 12) + " <span>paused</span>";
        indicator.style.color = "#f59e0b";
      } else {
        indicator.innerHTML =
          tyI("clock", 12) + " <span>waiting for worker…</span>";
        indicator.style.color = "#f59e0b";
      }
    }

    if (terminal) {
      stopCampaignMonitor();
      await showCampaignDetail(campaignId);
    }
  };

  tick();
  state.campaignPollTimer = setInterval(tick, 1500);
}

// ============================================
// SCORE PAGE
// ============================================

async function initScore() {
  const select = document.getElementById("scoreCampaignSelect");
  const scoreEmpty = document.getElementById("scorePageEmptyState");
  if (select) {
    const res = await api("campaigns");
    if (res.success) {
      const campaigns = res.data || [];
      select.innerHTML =
        '<option value="">-- Choose a campaign --</option>' +
        campaigns
          .map(
            (c) =>
              `<option value="${c.id}">${escHtml(c.name || "Campaign " + c.id)}</option>`,
          )
          .join("");
      if (scoreEmpty) {
        if (campaigns.length === 0) {
          scoreEmpty.classList.remove("hidden");
          scoreEmpty.innerHTML = `
            <div class="empty-state-card empty-state-card--compact">
              <p class="empty-state-text">First create a campaign (even a draft) to run a score analysis from its templates.</p>
              <button type="button" class="btn-secondary btn-sm" id="scoreEmptyGoCampaigns">Aller aux campagnes</button>
            </div>`;
          document
            .getElementById("scoreEmptyGoCampaigns")
            ?.addEventListener("click", () => showSection("campaigns"));
          if (typeof tyHydrateIcons === "function") tyHydrateIcons(scoreEmpty);
        } else {
          scoreEmpty.classList.add("hidden");
          scoreEmpty.innerHTML = "";
        }
      }
    }
  }

  const runBtn = document.getElementById("runScoreBtn");
  if (runBtn) {
    runBtn.addEventListener("click", async () => {
      const campaignId = select ? select.value : "";
      if (!campaignId) return alert("Select a campaign.");

      const campaignRes = await api("campaigns");
      if (!campaignRes.success) return alert("Campaign loading error.");
      const campaign = (campaignRes.data || []).find(
        (c) => String(c.id) === String(campaignId),
      );
      if (!campaign) return alert("Campaign not found.");

      const config = campaign.config || {};
      const templateIds = config.template_ids || [];

      const scoreRes = await api("score", "POST", {
        template_ids: templateIds,
        campaign: {
          from_email: config.from_email || "",
          unsubscribe_url:
            config.unsubscribe_url ||
            localStorage.getItem("tydra_unsub_url") ||
            "",
        },
      });

      if (!scoreRes.success)
        return alert("Score error: " + (scoreRes.error || ""));

      const container = document.getElementById("scoreResult");
      if (container) {
        container.classList.remove("hidden");
        renderScore(scoreRes.data, container);
      }
    });
  }
}

// ============================================
// LAB — TESTING PAGE
// ============================================

/** @type {Map<string, { email: string, name: string, label: string }>} */
let testingMailFromIdentityMeta = new Map();

/** Providers that allow sending from an arbitrary From address (in addition
 *  to any detected identity). All providers support manual entry in Labs and
 *  campaign form — if the address is not authorized by the provider the send
 *  may be rejected, but the user can still type it. */
const CUSTOM_FROM_PROVIDERS = new Set([
  "smtp",
  "office365",
  "mailgun",
  "sendgrid",
  "brevo",
  "ses",
  "amazonses",
  "mandrill",
  "postmark",
]);
const CUSTOM_FROM_OPTION = "__custom__";

/** Show/hide the manual From input and sync the display name based on the
 *  current identity selection. */
function syncTestingFromSelection() {
  const fs = document.getElementById("testingMailFromSelect");
  const wrapInp = document.getElementById("testingMailFromInputWrap");
  const fromInput = document.getElementById("testingMailFrom");
  const nameEl = document.getElementById("testingMailFromName");
  const hintEl = document.getElementById("testingMailFromInputHint");
  if (!fs) return;
  const val = fs.value;
  const meta = testingMailFromIdentityMeta.get(String(val).toLowerCase());
  const domain = meta && meta.domain ? meta.domain : "";

  // "Custom address…" or a verified-domain identity both require the user to
  // type the actual From address (any local part on the verified domain).
  if (val === CUSTOM_FROM_OPTION || domain) {
    if (wrapInp) wrapInp.classList.remove("hidden");
    if (fromInput) {
      // Did the selected identity itself change (vs. just re-syncing the same
      // one)? When it changes we must refresh the address — the previous one
      // belongs to a different domain and is no longer valid.
      const switchedIdentity = fromInput.dataset.forIdentity !== val;
      if (domain) {
        const suggestion = meta.email || `noreply@${domain}`;
        const cur = String(fromInput.value || "").trim();
        const prevAuto = String(fromInput.dataset.autoFromValue || "").trim();
        // Reset on identity switch; otherwise only fill while untouched so we
        // don't clobber what the user typed for this same identity.
        if (switchedIdentity || cur === "" || cur === prevAuto) {
          fromInput.value = suggestion;
        }
        fromInput.dataset.autoFromValue = suggestion;
      } else if (switchedIdentity) {
        // Freshly chose "Custom address…": start from a clean field.
        fromInput.value = "";
        delete fromInput.dataset.autoFromValue;
      }
      fromInput.dataset.forIdentity = val;
    }
    if (hintEl) {
      hintEl.textContent = domain
        ? `Any address on @${domain} — edit the part before “@”.`
        : "Type the full From address to send from.";
      hintEl.classList.remove("hidden");
    }
  } else {
    if (wrapInp) wrapInp.classList.add("hidden");
    if (fromInput) {
      delete fromInput.dataset.autoFromValue;
      delete fromInput.dataset.forIdentity;
    }
    if (hintEl) hintEl.classList.add("hidden");
    if (meta && nameEl && !nameEl.value.trim()) nameEl.value = meta.name || "";
  }
}

async function refreshTestingMailFromIdentities() {
  const selSmtp = document.getElementById("testingMailSmtpSelect");
  const selectedSmtpId = selSmtp?.value?.trim() || "";
  const wrapSel = document.getElementById("testingMailFromSelectWrap");
  const wrapInp = document.getElementById("testingMailFromInputWrap");
  const hintEl = document.getElementById("testingMailFromIdentityHint");
  const hintNo = document.getElementById("testingMailFromNoConfigHint");
  const fs = document.getElementById("testingMailFromSelect");
  const id = selectedSmtpId;
  const previousFromSelection = fs?.value || "";

  testingMailFromIdentityMeta = new Map();

  // No configuration selected yet.
  if (!id) {
    if (wrapSel) wrapSel.classList.add("hidden");
    if (wrapInp) wrapInp.classList.add("hidden");
    if (hintEl) {
      hintEl.textContent = "";
      hintEl.classList.add("hidden");
    }
    if (hintNo) {
      hintNo.textContent =
        "Choose an SMTP configuration above to load the sender.";
      hintNo.classList.remove("hidden");
    }
    return;
  }
  if (hintNo) hintNo.classList.add("hidden");

  const cfg = (state.smtpConfigs || []).find((s) => String(s.id) === id);
  const prov = cfg ? String(cfg.provider || "").toLowerCase() : "";
  let allowCustom = CUSTOM_FROM_PROVIDERS.has(prov);

  // When the selected SMTP config changes, clear the manual From so the new
  // identity's suggestion (different domain) prefills cleanly instead of
  // staying stuck on the previous value.
  const fromInput = document.getElementById("testingMailFrom");
  if (fromInput && fromInput.dataset.forConfig !== id) {
    fromInput.value = "";
    delete fromInput.dataset.autoFromValue;
    fromInput.dataset.forConfig = id;
  }

  // Always show the identity dropdown and load identities (the backend
  // returns the username for SMTP, the verified domain for Mailgun, sender
  // signatures for Postmark/Mandrill, verified senders for Brevo/SES/SendGrid).
  if (wrapSel) wrapSel.classList.remove("hidden");
  if (wrapInp) wrapInp.classList.add("hidden");
  if (fs) fs.innerHTML = '<option value="">Loading…</option>';
  if (hintEl) {
    hintEl.textContent = "Loading identities…";
    hintEl.classList.remove("hidden");
  }

  let senders = [];
  let loadError = "";
  try {
    const res = await api("verified_senders", "POST", { smtp_config_id: id });
    if (res.success) senders = (res.data && res.data.senders) || [];
    else loadError = res.error || "API error";
  } catch (e) {
    loadError = (e && e.message) || "Network error";
  }
  if (!fs) return;

  let optionsHtml = "";
  let firstEmail = "";
  senders.forEach((s) => {
    const email = (s.email || "").trim();
    if (!email) return;
    if (!firstEmail) firstEmail = email;
    // A `domain` field means this identity authorizes ANY address on that
    // domain (SES verified domain, SendGrid authenticated domain, Mailgun),
    // so the user may type a custom address.
    if (s.domain) allowCustom = true;
    const name = (s.name != null && String(s.name).trim()) || "";
    const label =
      (s.label && String(s.label).trim()) ||
      (name ? name + " <" + email + ">" : email);
    testingMailFromIdentityMeta.set(email.toLowerCase(), {
      email,
      name,
      label,
      domain: (s.domain && String(s.domain).trim()) || "",
      verified: s.verified !== false,
      source: (s.source && String(s.source).trim()) || "",
    });
    optionsHtml += `<option value="${escAttr(email)}">${escHtml(label)}</option>`;
  });
  const hasIdentities = testingMailFromIdentityMeta.size > 0;

  const head = hasIdentities
    ? '<option value="">— Choose an identity —</option>'
    : '<option value="">— No identity detected —</option>';
  const customOpt = allowCustom
    ? `<option value="${CUSTOM_FROM_OPTION}">✏️ Custom address…</option>`
    : "";
  fs.innerHTML = head + optionsHtml + customOpt;

  // Preserve the From identity only if it still exists for the currently
  // selected SMTP. Do not re-apply all persisted testing form values here:
  // doing that resets `testingMailSmtpSelect` to the old tested config right
  // after the user changes it.
  if (
    previousFromSelection &&
    [...fs.options].some((o) => o.value === previousFromSelection)
  ) {
    fs.value = previousFromSelection;
  } else if (hasIdentities && firstEmail) {
    fs.value = firstEmail;
  } else if (allowCustom) {
    fs.value = CUSTOM_FROM_OPTION;
  }
  syncTestingFromSelection();

  if (hintEl) {
    if (loadError && !hasIdentities) {
      hintEl.textContent = allowCustom
        ? `Could not load identities (${loadError}) — type a custom From address on an authenticated domain.`
        : "Unable to load identities: " + loadError;
    } else if (!hasIdentities) {
      hintEl.textContent = allowCustom
        ? "No identity returned by the API — type a From address on an authenticated domain."
        : "No verified identity for this account. Create a sender identity in Brevo, SendGrid (Sender Authentication) or SES.";
    } else if (allowCustom) {
      hintEl.textContent =
        "Pick a detected identity, or choose “Custom address…” to type one.";
    } else {
      hintEl.textContent =
        "Identities authorized by the API: selection required (no manual entry for this provider).";
    }
    hintEl.classList.remove("hidden");
  }
}

function populateTestingSelects() {
  const ids = [
    "testingInspectSmtpSelect",
    "testingConnSmtpSelect",
    "testingMailSmtpSelect",
  ];
  const list = state.smtpConfigs || [];
  const html =
    '<option value="">— Choose —</option>' +
    list
      .map((c) => {
        const id = escAttr(c.id);
        return `<option value="${id}">${escHtml(c.name || c.host || c.id)}</option>`;
      })
      .join("");
  ids.forEach((selId) => {
    const el = document.getElementById(selId);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = html;
    if (cur && [...el.options].some((o) => o.value === cur)) el.value = cur;
  });

  // Dedicated SendGrid Activity select: SendGrid configs only.
  const sgSel = document.getElementById("sgActivitySmtpSelect");
  if (sgSel) {
    const sgList = list.filter(
      (c) => String(c.provider || "").toLowerCase() === "sendgrid",
    );
    const sgHtml =
      '<option value="">— Choose —</option>' +
      sgList
        .map(
          (c) =>
            `<option value="${escAttr(c.id)}">${escHtml(c.name || c.host || c.id)}</option>`,
        )
        .join("");
    const cur = sgSel.value;
    sgSel.innerHTML = sgHtml;
    if (cur && [...sgSel.options].some((o) => o.value === cur))
      sgSel.value = cur;
  }

  void refreshTestingMailFromIdentities();
}

async function refreshTestingPage() {
  const res = await api("smtp_configs");
  if (res.success) state.smtpConfigs = res.data || [];
  populateTestingSelects();

  const tplRes = await api("templates");
  const sel = document.getElementById("testingMailTemplateSelect");
  if (sel && tplRes.success) {
    const cur = sel.value;
    const tpls = tplRes.data || [];
    sel.innerHTML =
      '<option value="">— Choose —</option>' +
      tpls
        .map(
          (t) =>
            `<option value="${escAttr(t.id)}">${escHtml(t.name || t.id)}</option>`,
        )
        .join("");
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }

  if (typeof tyHydrateIcons === "function")
    tyHydrateIcons(document.getElementById("page-testing"));
}

async function fetchProviderInspectAndCacheSmtp(smtpId) {
  const res = await api("provider_inspect", "POST", { smtp_config_id: smtpId });
  if (!res.success) throw new Error(res.error || "Introspection failed");
  setSmtpInspectCacheEntry(smtpId, res.data);
  if (res.data && res.data.remote_snapshot) {
    mergeSmtpRemoteSnapshotIntoState(smtpId, res.data.remote_snapshot);
    patchSmtpRowExtrasFromState(smtpId);
  }
  return res.data;
}

function initTesting() {
  const page = document.getElementById("page-testing");
  if (!page) return;

  document
    .getElementById("testingInspectSource")
    ?.addEventListener("change", () => {
      const manual =
        document.getElementById("testingInspectSource")?.value === "manual";
      document
        .getElementById("testingInspectSavedBlock")
        ?.classList.toggle("hidden", manual);
      document
        .getElementById("testingInspectManualBlock")
        ?.classList.toggle("hidden", !manual);
    });

  const syncManualPanels = () => {
    const p =
      document.getElementById("testingInspectManualProvider")?.value || "brevo";
    document
      .getElementById("testingManualBrevoWrap")
      ?.classList.toggle("hidden", p !== "brevo");
    document
      .getElementById("testingManualSesWrap")
      ?.classList.toggle("hidden", p !== "ses");
    document
      .getElementById("testingManualSgWrap")
      ?.classList.toggle("hidden", p !== "sendgrid");
  };
  document
    .getElementById("testingInspectManualProvider")
    ?.addEventListener("change", syncManualPanels);
  syncManualPanels();

  document
    .getElementById("testingInspectRunBtn")
    ?.addEventListener("click", async () => {
      const status = document.getElementById("testingInspectStatus");
      const out = document.getElementById("testingInspectOutput");
      const src = document.getElementById("testingInspectSource")?.value;
      let body = null;

      if (src === "saved") {
        const id = document
          .getElementById("testingInspectSmtpSelect")
          ?.value?.trim();
        if (!id) return alert("Choose an SMTP configuration.");
        const cfg = (state.smtpConfigs || []).find((s) => String(s.id) === id);
        if (
          !cfg ||
          !INSPECTABLE_SMTP_PROVIDERS.has(
            String(cfg.provider || "").toLowerCase(),
          )
        ) {
          return alert("Choose a Brevo, Amazon SES or SendGrid configuration.");
        }
        body = { smtp_config_id: id };
      } else {
        const p = document.getElementById(
          "testingInspectManualProvider",
        )?.value;
        if (p === "brevo") {
          const k = document
            .getElementById("testingManualBrevoKey")
            ?.value?.trim();
          if (!k) return alert("Brevo API key required.");
          body = { provider: "brevo", api_key: k };
        } else if (p === "ses") {
          const ak = document
            .getElementById("testingManualSesAk")
            ?.value?.trim();
          const sk = document
            .getElementById("testingManualSesSk")
            ?.value?.trim();
          const reg =
            document.getElementById("testingSesRegion")?.value || "eu-west-3";
          if (!ak || !sk)
            return alert(
              "Access Key ID and Secret Access Key required for SES.",
            );
          body = {
            provider: "ses",
            access_key: ak,
            secret_key: sk,
            region: reg,
          };
        } else {
          const k = document
            .getElementById("testingManualSendgridKey")
            ?.value?.trim();
          if (!k) return alert("SendGrid API key required.");
          const sgr =
            document
              .getElementById("testingManualSendgridRegion")
              ?.value?.trim() || "";
          body = { provider: "sendgrid", api_key: k };
          if (sgr) body.sendgrid_region = sgr;
        }
      }

      if (status) {
        status.textContent = "Querying APIs…";
        status.classList.remove("hidden");
      }
      const res = await api("provider_inspect", "POST", body);
      if (status) status.classList.add("hidden");
      if (!res.success) {
        alert(res.error || "Error");
        return;
      }
      if (body.smtp_config_id) {
        setSmtpInspectCacheEntry(body.smtp_config_id, res.data);
        if (res.data.remote_snapshot) {
          mergeSmtpRemoteSnapshotIntoState(
            body.smtp_config_id,
            res.data.remote_snapshot,
          );
        }
        renderSmtpList(state.smtpConfigs || []);
      }
      if (out) {
        out.classList.remove("hidden");
        out.innerHTML = buildInspectPreHtml(
          res.data.fetched_at,
          res.data.inspect,
        );
      }
    });

  document
    .getElementById("testingConnRunBtn")
    ?.addEventListener("click", async () => {
      const id = document
        .getElementById("testingConnSmtpSelect")
        ?.value?.trim();
      const rEl = document.getElementById("testingConnResult");
      if (!id) return alert("Choose a configuration.");
      if (rEl) {
        rEl.classList.remove(
          "hidden",
          "conn-test-result--ok",
          "conn-test-result--err",
        );
        rEl.classList.add("conn-test-result", "conn-test-result--pending");
        rEl.style.color = "";
        rEl.innerHTML =
          '<span class="conn-test-icon conn-test-spin">' +
          tyI("refresh-cw", 18) +
          '</span><span class="conn-test-body"><span class="conn-test-title">Testing connection…</span></span>';
      }
      const res = await api("test_smtp", "POST", {
        smtp_config_id: id,
        from_email: "test@example.com",
      });
      if (rEl) {
        rEl.classList.remove("conn-test-result--pending");
        renderConnTestResult(rEl, res);
      }
    });

  const syncMailMode = () => {
    const m = document.getElementById("testingMailContentMode")?.value;
    document
      .getElementById("testingMailSimpleFields")
      ?.classList.toggle("hidden", m === "template");
    document
      .getElementById("testingMailHtmlFields")
      ?.classList.toggle("hidden", m !== "html");
    document
      .getElementById("testingMailTemplateFields")
      ?.classList.toggle("hidden", m !== "template");
  };
  document
    .getElementById("testingMailContentMode")
    ?.addEventListener("change", syncMailMode);
  syncMailMode();

  document
    .getElementById("testingMailSmtpSelect")
    ?.addEventListener("change", () => {
      void refreshTestingMailFromIdentities();
    });
  document
    .getElementById("testingMailFromSelect")
    ?.addEventListener("change", syncTestingFromSelection);
  void refreshTestingMailFromIdentities();

  document
    .getElementById("testingMailSendBtn")
    ?.addEventListener("click", async () => {
      const smtpId = document
        .getElementById("testingMailSmtpSelect")
        ?.value?.trim();
      const to = document.getElementById("testingMailTo")?.value?.trim();
      const cfg = smtpId
        ? (state.smtpConfigs || []).find((s) => String(s.id) === smtpId)
        : null;
      const prov = cfg ? String(cfg.provider || "").toLowerCase() : "";
      const allowCustom = CUSTOM_FROM_PROVIDERS.has(prov);
      const selVal =
        document.getElementById("testingMailFromSelect")?.value?.trim() || "";
      const manualFrom =
        document.getElementById("testingMailFrom")?.value?.trim() || "";
      // Resolve the From: a picked exact identity, or the typed address when
      // 'Custom address…' / a verified-domain identity is selected (any local
      // part on that domain), or nothing picked yet on a flexible provider.
      const selMeta = testingMailFromIdentityMeta.get(selVal.toLowerCase());
      const selIsDomain = !!(selMeta && selMeta.domain);
      let from;
      if (selVal === CUSTOM_FROM_OPTION || selIsDomain) {
        from = manualFrom;
      } else if (selVal) {
        from = selVal;
      } else {
        from = allowCustom ? manualFrom : "";
      }
      if (!smtpId || !to || !from)
        return alert(
          "SMTP configuration, recipient and sender (From) are required.",
        );
      if (
        prov === "sendgrid" &&
        selMeta &&
        selMeta.verified === false &&
        !(await uiConfirm(
          "This SendGrid sender identity is marked as UNVERIFIED by the API. SendGrid may accept the API call but then drop/suppress the email. Continue anyway?",
          {
            title: "Unverified sender",
            confirmLabel: "Send anyway",
            danger: false,
          },
        ))
      ) {
        return;
      }
      const mode = document.getElementById("testingMailContentMode")?.value;
      const payload = {
        smtp_config_id: smtpId,
        to,
        from_email: from,
        from_name:
          document.getElementById("testingMailFromName")?.value?.trim() || "",
      };
      if (mode === "template") {
        const tid = document
          .getElementById("testingMailTemplateSelect")
          ?.value?.trim();
        if (!tid) return alert("Choose a template.");
        payload.template_id = tid;
      } else {
        payload.subject =
          document.getElementById("testingMailSubject")?.value?.trim() ||
          "Test WinMail";
        payload.body = document.getElementById("testingMailBody")?.value ?? "";
        if (mode === "html") {
          payload.body_html =
            document.getElementById("testingMailHtml")?.value ?? "";
        }
      }
      const rEl = document.getElementById("testingMailResult");
      const pendingLine = appendTestingMailLog(rEl, to, "pending");
      try {
        const res = await api("send_test_email", "POST", payload);
        if (res.success) {
          const data = res.data || {};
          if (String(data.provider || "").toLowerCase() === "sendgrid") {
            updateTestingMailLog(pendingLine, to, "accepted", null, data);
            scheduleSendgridActivityCheck(smtpId, to, pendingLine, data);
          } else {
            updateTestingMailLog(pendingLine, to, "ok", null, data);
          }
        } else {
          updateTestingMailLog(
            pendingLine,
            to,
            "failed",
            res.error || "Failed",
          );
        }
      } catch (e) {
        updateTestingMailLog(
          pendingLine,
          to,
          "failed",
          (e && e.message) || "Network error",
        );
      }
    });

  initSendgridActivityCard();
}

function formatTestingMailTime(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendTestingMailLog(container, to, state) {
  if (!container) return null;
  container.classList.remove("hidden");
  const MAX_LINES = 50;
  while (container.childElementCount >= MAX_LINES) {
    container.removeChild(container.firstElementChild);
  }
  const line = document.createElement("div");
  line.className = "log-line";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = formatTestingMailTime();
  const msg = document.createElement("span");
  msg.className = "log-msg";
  line.appendChild(time);
  line.appendChild(msg);
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
  updateTestingMailLog(line, to, state || "pending");
  return line;
}

function updateTestingMailLog(line, to, state, errorMessage, data = null) {
  if (!line) return;
  line.classList.remove("ok", "failed", "info", "retry", "accepted");
  const msg = line.querySelector(".log-msg");
  if (!msg) return;
  msg.innerHTML = "";
  const target = document.createElement("span");
  target.className = "log-target";
  target.textContent = to || "(unknown recipient)";

  if (state === "ok") {
    line.classList.add("ok");
    msg.append("Email sent to ", target);
    if (data && data.message_id) msg.append(" — id: " + data.message_id);
  } else if (state === "accepted") {
    line.classList.add("info", "accepted");
    msg.append(
      "Accepted by SendGrid for ",
      target,
      " (queued, not delivered yet)",
    );
    if (data && data.message_id)
      msg.append(" — x-message-id: " + data.message_id);
    if (errorMessage) msg.append(" — " + errorMessage);
  } else if (state === "delivery") {
    const activity = data || {};
    const status = String(activity.status || "").toLowerCase();
    if (status === "delivered") line.classList.add("ok");
    else if (
      status === "not_delivered" ||
      status === "dropped" ||
      status === "bounce" ||
      status === "blocked"
    )
      line.classList.add("failed");
    else line.classList.add("info");
    msg.append(
      "SendGrid Activity for ",
      target,
      ": ",
      activity.status || "unknown",
    );
    if (activity.reason) msg.append(" — " + activity.reason);
    if (activity.last_event_time) msg.append(" — " + activity.last_event_time);
  } else if (state === "failed") {
    line.classList.add("failed");
    msg.append("Failed for ", target);
    if (errorMessage) msg.append(" — " + errorMessage);
  } else {
    line.classList.add("info");
    msg.append("Sending to ", target, "…");
  }
}

function pickRelevantSendgridActivity(messages, sendData) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const xMessageId = String((sendData && sendData.message_id) || "").trim();
  if (xMessageId) {
    const byId = messages.find((m) => {
      const msgId = String(m.msg_id || m.message_id || "");
      return msgId.includes(xMessageId) || xMessageId.includes(msgId);
    });
    if (byId) return byId;
  }
  return messages[0];
}

function scheduleSendgridActivityCheck(smtpId, to, line, sendData) {
  if (!smtpId || !to || !line) return;
  setTimeout(async () => {
    try {
      const res = await api("sendgrid_activity", "POST", {
        smtp_config_id: smtpId,
        limit: 10,
        to_email: to,
      });
      if (!res.success) {
        updateTestingMailLog(
          line,
          to,
          "accepted",
          "Activity check unavailable: " + (res.error || "unknown error"),
          sendData,
        );
        return;
      }
      const messages = Array.isArray(res.data && res.data.messages)
        ? res.data.messages
        : [];
      const activity = pickRelevantSendgridActivity(messages, sendData);
      if (!activity) {
        updateTestingMailLog(
          line,
          to,
          "accepted",
          "not visible in Activity Feed yet",
          sendData,
        );
        return;
      }
      updateTestingMailLog(line, to, "delivery", null, activity);
    } catch (e) {
      updateTestingMailLog(
        line,
        to,
        "accepted",
        "Activity check failed: " + ((e && e.message) || "network error"),
        sendData,
      );
    }
  }, 12000);
}

// ----- SendGrid Activity (Lab) ------------------------------------------------

function initSendgridActivityCard() {
  const srcSel = document.getElementById("sgActivitySource");
  if (!srcSel) return;

  const syncSource = () => {
    const manual = srcSel.value === "manual";
    document
      .getElementById("sgActivitySavedWrap")
      ?.classList.toggle("hidden", manual);
    document
      .getElementById("sgActivityManualWrap")
      ?.classList.toggle("hidden", !manual);
  };
  srcSel.addEventListener("change", syncSource);
  syncSource();

  document
    .getElementById("sgActivityRunBtn")
    ?.addEventListener("click", async () => {
      const hint = document.getElementById("sgActivityStatusHint");
      const out = document.getElementById("sgActivityOutput");
      const setHint = (msg, color) => {
        if (!hint) return;
        hint.textContent = msg;
        hint.classList.remove("hidden");
        if (color) hint.style.color = color;
        else hint.style.removeProperty("color");
      };

      const body = {
        limit: parseInt(
          document.getElementById("sgActivityLimit")?.value || "25",
          10,
        ),
        status: document.getElementById("sgActivityStatus")?.value || "",
        to_email: document.getElementById("sgActivityTo")?.value?.trim() || "",
      };
      if (srcSel.value === "saved") {
        const id = document
          .getElementById("sgActivitySmtpSelect")
          ?.value?.trim();
        if (!id) return alert("Choose a saved SendGrid configuration.");
        body.smtp_config_id = id;
      } else {
        const k = document.getElementById("sgActivityManualKey")?.value?.trim();
        if (!k) return alert("SendGrid API key required.");
        body.api_key = k;
        const sgr = document
          .getElementById("sgActivityManualRegion")
          ?.value?.trim();
        if (sgr) body.sendgrid_region = sgr;
      }

      setHint("Querying /v3/messages…");
      const res = await api("sendgrid_activity", "POST", body);
      if (!res.success) {
        setHint("Error: " + (res.error || ""), "#ef4444");
        if (out) {
          out.classList.add("hidden");
          out.innerHTML = "";
        }
        return;
      }
      const data = res.data || {};
      const messages = Array.isArray(data.messages) ? data.messages : [];
      setHint(
        messages.length +
          " message(s) returned — source: " +
          (data.base_used || "SendGrid") +
          " — " +
          (data.fetched_at || ""),
        messages.length === 0 ? "#64748b" : "#22c55e",
      );
      if (out) {
        out.classList.remove("hidden");
        out.innerHTML = renderSendgridActivityTable(messages);
      }
    });
}

function renderSendgridActivityTable(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '<p class="field-hint">No matching message. Try widening the filters or loading a higher number.</p>';
  }
  const rows = messages
    .map((m) => {
      const status = String(m.status || "").toLowerCase();
      const statusLabel =
        {
          delivered: "Delivered",
          not_delivered: "Not delivered",
          processed: "Processed",
          processing: "Processing",
        }[status] ||
        m.status ||
        "—";
      const badgeClass =
        {
          delivered: "sg-status-delivered",
          not_delivered: "sg-status-failed",
          processed: "sg-status-processed",
          processing: "sg-status-processed",
        }[status] || "sg-status-unknown";

      const when = m.last_event_time ? new Date(m.last_event_time) : null;
      const whenLabel =
        when && !isNaN(when.getTime())
          ? when.toLocaleString("en-US", {
              dateStyle: "short",
              timeStyle: "medium",
            })
          : m.last_event_time || "—";

      return `
      <tr>
        <td class="sg-activity-cell-time" title="${escAttr(m.last_event_time || "")}">${escHtml(whenLabel)}</td>
        <td><span class="sg-activity-badge ${badgeClass}">${escHtml(statusLabel)}</span></td>
        <td class="sg-activity-cell-email" title="${escAttr(m.to_email || "")}">${escHtml(m.to_email || "—")}</td>
        <td class="sg-activity-cell-email" title="${escAttr(m.from_email || "")}">${escHtml(m.from_email || "—")}</td>
        <td class="sg-activity-cell-subject" title="${escAttr(m.subject || "")}">${escHtml(m.subject || "—")}</td>
        <td class="sg-activity-cell-num">${Number(m.opens_count || 0)}</td>
        <td class="sg-activity-cell-num">${Number(m.clicks_count || 0)}</td>
        <td class="sg-activity-cell-id" title="${escAttr(m.msg_id || "")}">${escHtml((m.msg_id || "").slice(0, 16))}${m.msg_id && m.msg_id.length > 16 ? "…" : ""}</td>
      </tr>
    `;
    })
    .join("");

  return `
    <div class="sg-activity-table-wrap">
      <table class="sg-activity-table">
        <thead>
          <tr>
            <th>Last event</th>
            <th>Status</th>
            <th>To</th>
            <th>From</th>
            <th>Subject</th>
            <th title="Opens">Opens</th>
            <th title="Clicks">Clicks</th>
            <th>Message ID</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ============================================
// CONFIG PAGE
// ============================================

async function initConfig() {
  await loadSmtpConfigs();

  const smtpListEl = document.getElementById("smtpList");
  if (smtpListEl) {
    smtpListEl.addEventListener("click", async (e) => {
      const wrap = e.target.closest(".smtp-config-wrap");
      if (!wrap) return;
      const sid = wrap.getAttribute("data-smtp-id");
      if (!sid) return;

      if (e.target.closest(".js-smtp-edit")) {
        e.preventDefault();
        editSmtpConfig(sid);
        return;
      }
      if (e.target.closest(".js-smtp-test")) {
        e.preventDefault();
        testSavedSmtpConfig(sid);
        return;
      }
      if (e.target.closest(".js-smtp-delete")) {
        e.preventDefault();
        deleteSmtpConfig(sid);
        return;
      }
      if (e.target.closest(".js-smtp-fetch-inspect")) {
        e.preventDefault();
        e.stopPropagation();
        const cfg = (state.smtpConfigs || []).find((s) => String(s.id) === sid);
        if (
          !cfg ||
          !INSPECTABLE_SMTP_PROVIDERS.has(
            String(cfg.provider || "").toLowerCase(),
          )
        )
          return;
        const btn = e.target.closest(".js-smtp-fetch-inspect");
        const out = wrap.querySelector(".smtp-config-inspect-output");
        const prevHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = tyI("activity", 16) + " …";
        try {
          const data = await fetchProviderInspectAndCacheSmtp(sid);
          if (out)
            out.innerHTML = buildInspectPreHtml(data.fetched_at, data.inspect);
        } catch (err) {
          alert(err.message || String(err));
        } finally {
          btn.disabled = false;
          btn.innerHTML = prevHtml;
          if (typeof tyHydrateIcons === "function") tyHydrateIcons(btn);
        }
        return;
      }

      // The toggle only activates if you click the header row itself,
      // never on the expanded content (text selection / click on JSON, etc.).
      if (e.target.closest(".smtp-config-detail")) return;
      if (e.target.closest(".smtp-config-row-actions")) return;
      if (!e.target.closest(".smtp-config-row--head")) return;

      wrap.classList.toggle("is-open");
      const det = wrap.querySelector(".smtp-config-detail");
      if (det) det.classList.toggle("hidden");
    });
  }

  // Add SMTP button
  const addSmtpBtn = document.getElementById("addSmtpBtn");
  if (addSmtpBtn) {
    addSmtpBtn.addEventListener("click", () => {
      clearSmtpForm();
      const form = document.getElementById("smtpForm");
      if (form) {
        form.classList.remove("hidden");
        form.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setTimeout(() => {
        const first = document.getElementById("smtpName");
        if (first) first.focus({ preventScroll: true });
      }, 80);
    });
  }

  // Provider select
  const providerSelect = document.getElementById("smtpProvider");
  if (providerSelect) {
    providerSelect.addEventListener("change", () => {
      toggleSmtpFields(providerSelect.value);
      if (providerSelect.value === "office365") {
        applyMicrosoft365SmtpDefaults("smtpHost", "smtpPort", "smtpUser");
      }
    });
    toggleSmtpFields(providerSelect.value);
  }

  // Save SMTP
  const saveSmtpBtn = document.getElementById("saveSmtpBtn");
  if (saveSmtpBtn) {
    saveSmtpBtn.addEventListener("click", saveSmtpConfig);
  }

  // Cancel SMTP
  const cancelSmtpBtn = document.getElementById("cancelSmtpBtn");
  if (cancelSmtpBtn) {
    cancelSmtpBtn.addEventListener("click", () => {
      clearSmtpForm();
      const form = document.getElementById("smtpForm");
      if (form) form.classList.add("hidden");
    });
  }

  // Test SMTP
  const testSmtpBtn = document.getElementById("testSmtpBtn");
  if (testSmtpBtn) {
    testSmtpBtn.addEventListener("click", async () => {
      const existingId = document.getElementById("smtpConfigId")?.value?.trim();
      let res;
      if (existingId) {
        res = await api("test_smtp", "POST", {
          smtp_config_id: existingId,
          from_email: "test@example.com",
        });
      } else {
        res = await api("test_smtp", "POST", buildSmtpTestPayloadFromForm());
      }
      const resultEl = document.getElementById("smtpTestResult");
      renderConnTestResult(resultEl, res);
    });
  }

  document
    .getElementById("smtpSesInspectBtn")
    ?.addEventListener("click", () => runSesInspect("smtp"));
  document
    .getElementById("smtpSesProbeAllBtn")
    ?.addEventListener("click", () => runSesProbeAllRegions("smtp"));

  // Unsubscribe URL
  const unsubEl = document.getElementById("unsubscribeUrl");
  if (unsubEl) {
    unsubEl.value = localStorage.getItem("tydra_unsub_url") || "";
  }

  const saveUnsubBtn = document.getElementById("saveUnsubBtn");
  if (saveUnsubBtn) {
    saveUnsubBtn.addEventListener("click", () => {
      const val = unsubEl ? unsubEl.value.trim() : "";
      localStorage.setItem("tydra_unsub_url", val);
      alert("Unsubscribe URL saved.");
    });
  }

  // DNS guide
  const showDnsBtn = document.getElementById("showDnsRecordsBtn");
  if (showDnsBtn) {
    showDnsBtn.addEventListener("click", renderDnsGuide);
  }

  const verifyDnsBtn = document.getElementById("verifyDnsBtn");
  if (verifyDnsBtn) {
    verifyDnsBtn.addEventListener("click", verifyDns);
  }
}

async function loadSmtpConfigs() {
  const res = await api("smtp_configs");
  if (!res.success) return;
  state.smtpConfigs = res.data || [];
  renderSmtpList(state.smtpConfigs);
}

function renderSmtpList(configs) {
  const list = document.getElementById("smtpList");
  const emptyEl = document.getElementById("smtpEmptyState");
  if (!list) return;

  if (configs.length === 0) {
    list.innerHTML = "";
    if (emptyEl) {
      emptyEl.classList.remove("hidden");
      emptyEl.innerHTML = `
        <div class="empty-state-card empty-state-card--compact">
          <div class="empty-state-icon" aria-hidden="true">${tyI("server", 36)}</div>
          <h2 class="empty-state-title">No SMTP / API configuration</h2>
          <p class="empty-state-text">Add Brevo, SMTP, Office365, SES or SendGrid from the <strong>Add configuration</strong> button at the top right.</p>
        </div>`;
      if (typeof tyHydrateIcons === "function") tyHydrateIcons(emptyEl);
    }
    return;
  }

  if (emptyEl) {
    emptyEl.classList.add("hidden");
    emptyEl.innerHTML = "";
  }

  list.innerHTML = configs
    .map((c) => {
      const id = escAttr(c.id);
      const p = String(c.provider || "").toLowerCase();
      const canInspect = INSPECTABLE_SMTP_PROVIDERS.has(p);
      const entry = getSmtpInspectCacheEntry(c.id);
      const inspectBlock =
        entry && entry.inspect
          ? buildInspectPreHtml(entry.fetched_at, entry.inspect)
          : `<p class="field-hint">${canInspect ? 'No cached data for this session — click "Query API".' : "API introspection available for Brevo, Amazon SES and SendGrid only."}</p>`;
      const fetchBtn = canInspect
        ? `<button type="button" class="btn-secondary btn-sm btn-with-icon js-smtp-fetch-inspect">${tyI("refresh-cw", 16)} Query API</button>`
        : "";
      return `
    <div class="smtp-config-wrap" data-smtp-id="${id}">
      <div class="smtp-config-row smtp-config-row--head">
        <span class="smtp-config-toggle" aria-hidden="true">${tyI("chevron-right", 18)}</span>
        <div class="smtp-config-row-main">
          <span class="smtp-config-row-name">${escHtml(c.name || c.host || "Config " + c.id)}</span>
          <span class="smtp-config-row-provider">${escHtml(c.provider || c.host || "")}</span>
        </div>
        <div class="smtp-row-extras-slot">${buildSmtpRemoteRowExtrasHtml(c)}</div>
        <div class="smtp-config-row-actions">
          <button type="button" class="btn btn-sm js-smtp-edit">Edit</button>
          <button type="button" class="btn btn-sm js-smtp-test">Tester</button>
          <button type="button" class="btn btn-sm btn-danger js-smtp-delete">Delete</button>
        </div>
      </div>
      <div class="smtp-config-detail hidden">
        ${renderSmtpDetailMetaHtml(c)}
        <div class="smtp-config-inspect">
          <h4>API data (this session)</h4>
          ${fetchBtn}
          <div class="smtp-config-inspect-output">${inspectBlock}</div>
        </div>
      </div>
    </div>`;
    })
    .join("");
  if (typeof tyHydrateIcons === "function") tyHydrateIcons(list);
}

async function editSmtpConfig(id) {
  const res = await api("smtp_config&id=" + encodeURIComponent(id));
  if (!res.success || !res.data) {
    alert("Configuration not found.");
    return;
  }
  const c = res.data;
  showSection("smtp");
  document.getElementById("smtpConfigId").value = c.id || "";
  document.getElementById("smtpName").value = c.name || "";
  const provEl = document.getElementById("smtpProvider");
  if (provEl) {
    provEl.value = c.provider || "smtp";
    toggleSmtpFields(provEl.value);
  }
  const isSes = (c.provider || "") === "ses";
  const isMaskedSecret = (value) => /^\s*[\*•●]+\s*$/.test(String(value || ""));
  if (isSes) {
    document.getElementById("smtpApiKey").value = "";
    let ak = c.access_key || "";
    if (!ak && c.api_key && String(c.api_key).startsWith("AKIA"))
      ak = c.api_key;
    document.getElementById("smtpAwsAccessKey").value = ak;
    document.getElementById("smtpAwsSecretKey").value = isMaskedSecret(
      c.secret_key || c.password,
    )
      ? ""
      : c.secret_key || c.password || "";
  } else {
    document.getElementById("smtpApiKey").value = isMaskedSecret(c.api_key)
      ? ""
      : c.api_key || "";
    document.getElementById("smtpAwsAccessKey").value = "";
    document.getElementById("smtpAwsSecretKey").value = "";
  }
  const regionCode = (c.region && String(c.region).trim()) || "eu-west-3";
  ensureAwsRegionInSelect(
    "smtpAwsRegion",
    regionCode,
    c.region && String(c.region).trim()
      ? labelForAwsRegionCode(String(c.region).trim())
      : undefined,
  );
  document.getElementById("smtpHost").value = c.host || "";
  document.getElementById("smtpPort").value =
    c.port != null && c.port !== "" ? c.port : 587;
  document.getElementById("smtpUser").value = c.username || "";
  document.getElementById("smtpPass").value = isMaskedSecret(c.password)
    ? ""
    : c.password || "";
  if (String(c.provider || "").toLowerCase() === "office365") {
    applyMicrosoft365SmtpDefaults("smtpHost", "smtpPort", "smtpUser");
  }
  const sgReg = document.getElementById("smtpSendgridRegion");
  if (sgReg) {
    const v =
      c.sendgrid_region != null && String(c.sendgrid_region).trim() !== ""
        ? String(c.sendgrid_region).trim()
        : "";
    sgReg.value =
      v === "eu" ? "eu" : v === "global" || v === "us" ? "global" : "";
  }
  const mgDomain = document.getElementById("smtpMailgunDomain");
  if (mgDomain) mgDomain.value = c.domain || "";
  const mgReg = document.getElementById("smtpMailgunRegion");
  if (mgReg) {
    const v = (c.mailgun_region || "us").toLowerCase();
    mgReg.value = v === "eu" ? "eu" : "us";
  }
  document.getElementById("smtpSecretHint")?.classList.remove("hidden");
  document.getElementById("smtpForm")?.classList.remove("hidden");
  document.getElementById("smtpTestResult")?.classList.add("hidden");
  document
    .getElementById("smtpForm")
    ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function testSavedSmtpConfig(id) {
  const msg = document.getElementById("smtpListTestMessage");
  if (msg) {
    msg.classList.remove(
      "hidden",
      "conn-test-result--ok",
      "conn-test-result--err",
    );
    msg.classList.add("conn-test-result", "conn-test-result--pending");
    msg.style.color = "";
    msg.innerHTML =
      '<span class="conn-test-icon conn-test-spin">' +
      tyI("refresh-cw", 18) +
      '</span><span class="conn-test-body"><span class="conn-test-title">Testing connection…</span></span>';
  }
  const res = await api("test_smtp", "POST", {
    smtp_config_id: id,
    from_email: "test@example.com",
  });
  if (msg) {
    msg.classList.remove("conn-test-result--pending");
    const name = state.smtpConfigs.find((s) => s.id === id)?.name || id;
    renderConnTestResult(msg, res, {
      successLabel: `Connection successful for “${name}”`,
    });
  }
}

function clearSmtpForm() {
  [
    "smtpConfigId",
    "smtpName",
    "smtpApiKey",
    "smtpHost",
    "smtpPort",
    "smtpUser",
    "smtpPass",
    "smtpAwsAccessKey",
    "smtpAwsSecretKey",
    "smtpMailgunDomain",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const sgR = document.getElementById("smtpSendgridRegion");
  if (sgR) sgR.value = "";
  const sreg = document.getElementById("smtpAwsRegion");
  if (sreg) sreg.value = "eu-west-3";
  const prov = document.getElementById("smtpProvider");
  if (prov) {
    prov.value = "brevo";
    prov.selectedIndex = [...prov.options].findIndex(
      (o) => o.value === "brevo",
    );
    toggleSmtpFields("brevo");
    syncCustomSelect(prov);
  }
  document.getElementById("smtpSecretHint")?.classList.add("hidden");
  const resultEl = document.getElementById("smtpTestResult");
  if (resultEl) resultEl.classList.add("hidden");
  const sesInspect = document.getElementById("smtpSesInspectResult");
  if (sesInspect) {
    sesInspect.classList.add("hidden");
    sesInspect.innerHTML = "";
  }
}

function buildSmtpTestPayloadFromForm() {
  const d = collectSmtpFormData();
  const payload = {
    provider: d.provider,
    api_key: d.api_key,
    host: d.host,
    port: d.port,
    username: d.username,
    password: d.password,
    from_email: "test@example.com",
  };
  if (d.provider === "ses") {
    payload.access_key = d.access_key;
    payload.secret_key = d.secret_key;
    payload.region = d.region;
  }
  if (d.provider === "sendgrid" && d.sendgrid_region) {
    payload.sendgrid_region = d.sendgrid_region;
  }
  if (d.provider === "office365") {
    payload.encryption = d.encryption || "tls";
    if (!payload.host) payload.host = "smtp.office365.com";
    if (!payload.port) payload.port = "587";
  }
  return payload;
}

function formatSesQuotaNum(n) {
  if (n == null || n === "") return "—";
  const x = Number(n);
  if (Number.isNaN(x)) return "—";
  return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function truncateSesErr(s, max) {
  if (!s) return "";
  const t = String(s);
  return t.length <= max ? t : t.slice(0, max) + "…";
}

function resolveSesInspectPayload(context) {
  if (context === "smtp") {
    const existingId = document.getElementById("smtpConfigId")?.value?.trim();
    if (existingId) {
      return {
        payload: { smtp_config_id: existingId, provider: "ses" },
        error: null,
      };
    }
    const d = collectSmtpFormData();
    if (d.provider !== "ses") return { payload: null, error: "ses_only" };
    if (!d.access_key || !d.secret_key)
      return { payload: null, error: "need_keys" };
    return {
      payload: {
        provider: "ses",
        access_key: d.access_key,
        secret_key: d.secret_key,
        region: d.region,
      },
      error: null,
    };
  }
  const d = collectCampSmtpData();
  if (d.provider !== "ses") return { payload: null, error: "ses_only" };
  if (!d.access_key || !d.secret_key)
    return { payload: null, error: "need_keys" };
  return {
    payload: {
      provider: "ses",
      access_key: d.access_key,
      secret_key: d.secret_key,
      region: d.region,
    },
    error: null,
  };
}

function alertSesInspectError(code) {
  if (code === "ses_only") alert("Choose Amazon SES as the provider.");
  else if (code === "need_keys") {
    alert(
      "Fill in the Access Key ID and the Secret Access Key. AWS does not allow any API call with only the visible key (AKIA…): the signature requires the secret key.",
    );
  }
}

function attachSesProbeInteractions(container, context) {
  if (container.dataset.sesProbeDelegation === "1") return;
  container.dataset.sesProbeDelegation = "1";
  const selId = context === "camp" ? "campAwsRegion" : "smtpAwsRegion";
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".js-ses-pick-region");
    if (!btn) return;
    const r = btn.getAttribute("data-region");
    if (!r) return;
    const lab = btn.getAttribute("data-label");
    ensureAwsRegionInSelect(selId, r, lab || undefined);
    document
      .getElementById(selId)
      ?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function renderSesProbeTable(container, data, context) {
  const sum = data.summary || {};
  const regions = data.regions || [];
  let html = '<div class="smtp-ses-probe">';
  html += '<div class="smtp-ses-probe-summary">';
  if ((sum.reachable_count || 0) > 0) {
    html +=
      '<p class="smtp-ses-probe-lead"><strong>' +
      escHtml(String(sum.reachable_count)) +
      "</strong> region(s) responding successfully. ";
    if (sum.best_quota_region) {
      html +=
        "Highest 24h quota: <strong>" +
        escHtml(sum.best_quota_label || sum.best_quota_region) +
        "</strong> (<code>" +
        escHtml(sum.best_quota_region) +
        "</code>) — " +
        formatSesQuotaNum(sum.best_max_24h) +
        " max / 24h.</p>";
    } else {
      html += "</p>";
    }
  } else {
    html +=
      '<p class="smtp-ses-probe-lead smtp-ses-probe-lead--warn">No region responded successfully.</p>';
  }
  if (sum.hint)
    html +=
      '<p class="field-hint smtp-ses-probe-hint">' + escHtml(sum.hint) + "</p>";
  html += "</div>";

  html +=
    '<div class="smtp-ses-probe-table-wrap"><table class="smtp-ses-probe-table"><thead><tr>';
  [
    "Region",
    "Code",
    "Status",
    "Max / 24h",
    "Sent / 24h",
    "Rate / s",
    "Prod.",
    "Sending",
    "",
  ].forEach((h) => {
    html += "<th>" + escHtml(h) + "</th>";
  });
  html += "</tr></thead><tbody>";

  regions.forEach((r) => {
    const ok = !!r.ok;
    let trClass = ok ? "ses-probe-row--ok" : "ses-probe-row--bad";
    if (r.matches_form_region) trClass += " ses-probe-row--picked";
    html += '<tr class="' + trClass + '">';
    html += "<td>" + escHtml(r.label || "") + "</td>";
    html += "<td><code>" + escHtml(r.region || "") + "</code></td>";
    html +=
      '<td class="ses-probe-stat">' +
      (ok
        ? tyI("check", 14) + " <span>OK</span>"
        : tyI("x-circle", 14) + " <span>—</span>") +
      "</td>";
    html += "<td>" + formatSesQuotaNum(r.max_24h) + "</td>";
    html += "<td>" + formatSesQuotaNum(r.sent_24h) + "</td>";
    html += "<td>" + formatSesQuotaNum(r.max_rate) + "</td>";
    html +=
      "<td>" + (ok ? (r.production_access ? "Yes" : "No") : "—") + "</td>";
    html += "<td>" + (ok ? (r.sending_enabled ? "Yes" : "No") : "—") + "</td>";
    html += '<td class="ses-probe-actions">';
    if (ok) {
      const pickLabel = (r.label || r.region || "") + " — " + (r.region || "");
      html +=
        '<button type="button" class="btn btn-sm js-ses-pick-region" data-region="' +
        escAttr(r.region || "") +
        '" data-label="' +
        escAttr(pickLabel) +
        '">Use</button>';
    } else {
      html +=
        '<span class="ses-probe-err" title="' +
        escAttr(r.error || "") +
        '">' +
        escHtml(truncateSesErr(r.error, 48)) +
        "</span>";
    }
    html += "</td></tr>";
  });

  html += "</tbody></table></div></div>";
  container.innerHTML = html;
  attachSesProbeInteractions(container, context);
}

function renderSesInspectResult(container, res, context) {
  if (!container) return;
  container.classList.remove("hidden");
  if (!res.success) {
    container.innerHTML =
      '<p class="smtp-ses-inspect-err">' +
      tyI("x-circle", 16) +
      " " +
      escHtml(res.error || "Error") +
      "</p>";
    return;
  }
  const d = res.data || {};
  // The all-regions probe response carries a `regions` array (and a `*`
  // region marker). Render the multi-region table for any of those signals.
  if (d.probe_all_regions || Array.isArray(d.regions) || d.region === "*") {
    renderSesProbeTable(container, d, context);
    return;
  }
  let html = '<div class="smtp-ses-inspect-inner">';
  html +=
    '<p class="smtp-ses-inspect-meta">Region: <code>' +
    escHtml(d.region || "") +
    "</code></p>";
  if (d.account) {
    html +=
      '<h4 class="smtp-ses-inspect-h">SES account <span class="label-hint">(API GetAccount)</span></h4>';
    html +=
      '<pre class="smtp-ses-inspect-pre" tabindex="0">' +
      escHtml(JSON.stringify(d.account, null, 2)) +
      "</pre>";
  }
  if (d.identities) {
    html +=
      '<h4 class="smtp-ses-inspect-h">Identities <span class="label-hint">(first page)</span></h4>';
    html +=
      '<pre class="smtp-ses-inspect-pre" tabindex="0">' +
      escHtml(JSON.stringify(d.identities, null, 2)) +
      "</pre>";
  }
  if (
    d.errors &&
    typeof d.errors === "object" &&
    Object.keys(d.errors).length
  ) {
    html += '<h4 class="smtp-ses-inspect-h">Partial errors</h4>';
    html +=
      '<pre class="smtp-ses-inspect-pre">' +
      escHtml(JSON.stringify(d.errors, null, 2)) +
      "</pre>";
  }
  html += "</div>";
  container.innerHTML = html;
}

async function runSesInspect(context) {
  const resultEl =
    context === "camp"
      ? document.getElementById("campSesInspectResult")
      : document.getElementById("smtpSesInspectResult");
  if (!resultEl) return;

  const resolved = resolveSesInspectPayload(context);
  if (resolved.error) {
    alertSesInspectError(resolved.error);
    return;
  }

  resultEl.innerHTML =
    '<p class="smtp-ses-inspect-loading">Querying the Amazon SES API…</p>';
  resultEl.classList.remove("hidden");
  const res = await api("ses_inspect", "POST", resolved.payload);
  renderSesInspectResult(resultEl, res, context);
}

async function runSesProbeAllRegions(context) {
  const resultEl =
    context === "camp"
      ? document.getElementById("campSesInspectResult")
      : document.getElementById("smtpSesInspectResult");
  if (!resultEl) return;

  const resolved = resolveSesInspectPayload(context);
  if (resolved.error) {
    alertSesInspectError(resolved.error);
    return;
  }

  const payload = { ...resolved.payload, probe_all_regions: true };
  const regEl = document.getElementById(
    context === "camp" ? "campAwsRegion" : "smtpAwsRegion",
  );
  if (regEl && regEl.value) payload.preferred_region = regEl.value.trim();

  resultEl.innerHTML =
    '<p class="smtp-ses-inspect-loading">Analyzing all SES regions in parallel (≈ 5–15 s)…</p>';
  resultEl.classList.remove("hidden");
  const res = await api("ses_inspect", "POST", payload);
  renderSesInspectResult(resultEl, res, context);
}

function toggleSmtpFields(provider) {
  const apiKeyGroup = document.getElementById("smtpApiKeyGroup");
  const sesGroup = document.getElementById("smtpSesGroup");
  const sgRegionGroup = document.getElementById("smtpSendgridGroup");
  const mailgunGroup = document.getElementById("smtpMailgunGroup");
  const o365 = document.getElementById("smtpOffice365Group");
  const credFields = document.querySelectorAll(".smtp-credentials");
  const isSes = provider === "ses";
  const isSmtpLike = provider === "smtp" || provider === "office365";
  const isSendgrid = provider === "sendgrid";
  const isMailgun = provider === "mailgun";

  if (sesGroup) sesGroup.classList.toggle("hidden", !isSes);
  if (o365) o365.classList.toggle("hidden", provider !== "office365");
  if (sgRegionGroup) sgRegionGroup.classList.toggle("hidden", !isSendgrid);
  if (mailgunGroup) mailgunGroup.classList.toggle("hidden", !isMailgun);
  if (apiKeyGroup) apiKeyGroup.classList.toggle("hidden", isSes || isSmtpLike);
  credFields.forEach((el) => el.classList.toggle("hidden", !isSmtpLike));

  if (!isSes && !isSmtpLike) {
    setSmtpApiKeyUiForProvider(provider, "smtpApiKeyLabel", "smtpApiKey");
  }
  const smtpUserEl = document.getElementById("smtpUser");
  if (smtpUserEl) {
    if (provider === "office365")
      smtpUserEl.placeholder = "address@domain.com (Microsoft 365 account)";
    else if (provider === "smtp") smtpUserEl.placeholder = "user@domain.com";
  }
}

function collectSmtpFormData() {
  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  };
  const provider = getVal("smtpProvider");
  const data = {
    id: getVal("smtpConfigId") || undefined,
    name: getVal("smtpName"),
    provider,
    api_key: getVal("smtpApiKey"),
    host: getVal("smtpHost"),
    port: getVal("smtpPort"),
    username: getVal("smtpUser"),
    password: getVal("smtpPass"),
  };
  if (provider === "ses") {
    data.access_key = getVal("smtpAwsAccessKey");
    data.secret_key = getVal("smtpAwsSecretKey");
    const regEl = document.getElementById("smtpAwsRegion");
    data.region = regEl && regEl.value ? regEl.value.trim() : "eu-west-3";
    data.api_key = "";
  }
  if (provider === "sendgrid") {
    const sgR = document.getElementById("smtpSendgridRegion");
    data.sendgrid_region =
      sgR && sgR.value != null ? String(sgR.value).trim() : "";
  }
  if (provider === "mailgun") {
    data.domain = getVal("smtpMailgunDomain");
    const mgR = document.getElementById("smtpMailgunRegion");
    data.mailgun_region =
      mgR && mgR.value != null ? String(mgR.value).trim() : "us";
  }
  if (provider === "office365") {
    data.encryption = "tls";
    if (!data.host) data.host = "smtp.office365.com";
    if (!data.port) data.port = "587";
  }
  return data;
}

async function saveSmtpConfig() {
  const data = collectSmtpFormData();
  if (!data.name) return alert("Configuration name is required.");
  if (data.provider === "office365") {
    if (!data.username) {
      return alert(
        "Microsoft 365: the SMTP user must be the account’s full email address.",
      );
    }
    if (!data.id && !data.password) {
      return alert(
        "Microsoft 365: the password (or app password) is required for a new configuration.",
      );
    }
  }
  const maskedSecretRe = /^\s*[\*•●]+\s*$/;
  if (
    maskedSecretRe.test(data.api_key || "") ||
    maskedSecretRe.test(data.password || "") ||
    maskedSecretRe.test(data.secret_key || "")
  ) {
    return alert(
      "The saved secret is masked. Please paste the real key/password before saving.",
    );
  }
  if (data.provider === "ses") {
    if (!data.access_key)
      return alert("Amazon SES: the Access Key ID (AKIA…) is required.");
    if (!data.id && !data.secret_key) {
      return alert(
        "Amazon SES: the Secret Access Key is required for a new configuration.",
      );
    }
  }

  const res = await api("smtp_configs", "POST", data);
  if (!res.success) return alert("SMTP save error: " + (res.error || ""));

  const form = document.getElementById("smtpForm");
  if (form) form.classList.add("hidden");
  await loadSmtpConfigs();
}

async function deleteSmtpConfig(id) {
  const confirmed = await uiConfirm("Delete this SMTP configuration?", {
    title: "Delete configuration",
    confirmLabel: "Delete",
  });
  if (!confirmed) return;
  const res = await api("smtp_config&id=" + id, "DELETE");
  if (!res.success) {
    await uiAlert("SMTP deletion error: " + (res.error || ""));
    return;
  }
  removeSmtpInspectCacheEntry(id);
  await loadSmtpConfigs();
}

function renderDnsGuide() {
  const container = document.getElementById("dnsRecords");
  if (!container) return;

  const domainEl = document.getElementById("dnsDomain");
  const domain = domainEl
    ? domainEl.value.trim() || "votredomaine.com"
    : "votredomaine.com";

  container.innerHTML = `
    <div class="dns-block">
      <div class="dns-block-title">SPF <span style="color:#64748b;font-weight:normal;font-size:12px">@ TXT</span></div>
      <div class="dns-record-value" id="spfValue">v=spf1 include:spf.brevo.com ~all</div>
      <button class="btn btn-sm" onclick="copyText('spfValue')">Copy</button>
    </div>
    <div class="dns-block">
      <div class="dns-block-title">DKIM <span style="color:#64748b;font-weight:normal;font-size:12px">brevo._domainkey TXT</span></div>
      <textarea id="dkimValue" class="dns-record-value" rows="3" placeholder="Paste your DKIM value from Brevo here..." style="width:100%;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:8px;color:inherit;font-family:monospace;font-size:12px"></textarea>
      <button class="btn btn-sm" onclick="copyText('dkimValue')">Copy</button>
    </div>
    <div class="dns-block">
      <div class="dns-block-title">DMARC <span style="color:#64748b;font-weight:normal;font-size:12px">_dmarc TXT</span></div>
      <div class="dns-record-value" id="dmarcValue">v=DMARC1; p=none; rua=mailto:dmarc@${escHtml(domain)}</div>
      <button class="btn btn-sm" onclick="copyText('dmarcValue')">Copy</button>
    </div>
  `;
  container.classList.remove("hidden");
}

function copyText(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.value || el.textContent;
  navigator.clipboard
    .writeText(text.trim())
    .then(() => {
      alert("Copied!");
    })
    .catch(() => {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text.trim();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      alert("Copied!");
    });
}

async function verifyDns() {
  const domainEl = document.getElementById("dnsDomain");
  const selectorEl = document.getElementById("dkimSelector");
  const domain = domainEl ? domainEl.value.trim() : "";
  const selector = selectorEl ? selectorEl.value.trim() : "brevo";

  if (!domain) return alert("Enter a domain to check.");

  const res = await api("dns_check", "POST", { domain, selector });
  const resultsEl = document.getElementById("dnsResults");
  if (!resultsEl) return;

  if (!res.success) {
    resultsEl.innerHTML =
      '<span style="color:#ef4444">Error: ' +
      escHtml(res.error || "") +
      "</span>";
    resultsEl.classList.remove("hidden");
    return;
  }

  const d = res.data;
  const renderDnsResult = (label, result) => {
    if (!result) return "";
    const found = result.status === "found";
    const error = result.status === "error";
    const iconSvg = found ? tyI("check-circle", 16) : tyI("x-circle", 16);
    const color = found ? "#22c55e" : "#ef4444";
    return `<div class="ty-inline-row" style="margin:6px 0;color:${color}">${iconSvg}<span><strong>${escHtml(label)}:</strong> ${escHtml(result.message || "")}</span></div>`;
  };

  resultsEl.innerHTML =
    renderDnsResult("SPF", d.spf) +
    renderDnsResult("DKIM", d.dkim) +
    renderDnsResult("DMARC", d.dmarc);
  resultsEl.classList.remove("hidden");
}

// ============================================
// SCORE RENDERER
// ============================================

function renderScore(result, container) {
  const pct = result.score;
  const circumference = 201;
  const offset = circumference * (1 - pct / 100);
  const gradeColors = {
    "green-bright": "#22c55e",
    green: "#84cc16",
    orange: "#f59e0b",
    red: "#ef4444",
  };
  const color = gradeColors[result.grade && result.grade.color] || "#a78bfa";
  const gradeLabel = (result.grade && result.grade.label) || "";
  const issues = result.issues || [];
  const okList = result.ok || [];
  const warnings = result.warnings || [];

  let html = `
    <div class="score-gauge-wrap">
      <div class="score-circle">
        <svg viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>
          <circle cx="40" cy="40" r="32" fill="none" stroke="${color}" stroke-width="6"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 40 40)"/>
        </svg>
        <div class="score-number" style="color:${color}">${pct}</div>
      </div>
      <div>
        <div class="score-grade ${result.grade ? result.grade.color : ""}">${escHtml(gradeLabel)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">${issues.length} issue(s) detected</div>
      </div>
    </div>
    <div class="score-issues">
  `;

  issues.forEach((issue) => {
    html += `
      <div class="issue-item ${escAttr(issue.severity || "")}">
        <div class="issue-severity">${issue.severity === "critical" ? "Critique" : "Avertissement"} — ${issue.score_impact || 0} pts</div>
        <div class="issue-message">${escHtml(issue.message || "")}</div>
        <div class="issue-fix">${tyI("lightbulb", 16)}<span>${escHtml(issue.fix || "")}</span></div>
      </div>
    `;
  });

  warnings.forEach((w) => {
    html += `
      <div class="issue-item warning">
        <div class="issue-severity">Avertissement — ${w.score_impact || 0} pts</div>
        <div class="issue-message">${escHtml(w.message || "")}</div>
        <div class="issue-fix">${tyI("lightbulb", 16)}<span>${escHtml(w.fix || "")}</span></div>
      </div>
    `;
  });

  okList.forEach((ok) => {
    html += `<div class="issue-item ok"><div class="issue-message ty-inline-row">${tyI("check", 15)}<span>${escHtml(ok.message || "")}</span></div></div>`;
  });

  html += "</div>";
  container.innerHTML = html;
}

// ============================================
// UTILITIES
// ============================================

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(str) {
  return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

// ============================================
// CUSTOM SELECT MENUS
// ============================================

function shouldEnhanceSelect(select) {
  if (!select || select.multiple || select.dataset.nativeSelect === "1")
    return false;
  if (select.closest(".CodeMirror") || select.closest(".tox")) return false;
  return true;
}

function closeAllCustomSelects(except = null) {
  document.querySelectorAll(".custom-select.is-open").forEach((wrap) => {
    if (wrap !== except) wrap.classList.remove("is-open");
  });
}

function syncCustomSelect(select) {
  const wrap = select && select.nextElementSibling;
  if (!wrap || !wrap.classList || !wrap.classList.contains("custom-select"))
    return;
  const trigger = wrap.querySelector(".custom-select-trigger");
  const menu = wrap.querySelector(".custom-select-menu");
  if (!trigger || !menu) return;

  const selected = select.options[select.selectedIndex];
  trigger.querySelector(".custom-select-value").textContent = selected
    ? selected.textContent
    : "—";
  trigger.disabled = select.disabled;
  wrap.classList.toggle("is-disabled", select.disabled);

  menu.innerHTML = "";
  Array.from(select.options).forEach((option, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "custom-select-option";
    item.dataset.value = option.value;
    item.dataset.index = String(index);
    item.textContent = option.textContent || "—";
    item.disabled = option.disabled;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", option.selected ? "true" : "false");
    if (option.selected) item.classList.add("is-selected");
    item.addEventListener("click", () => {
      if (option.disabled) return;
      select.selectedIndex = index;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncCustomSelect(select);
      wrap.classList.remove("is-open");
      trigger.focus();
    });
    menu.appendChild(item);
  });
}

function enhanceSelect(select) {
  if (!shouldEnhanceSelect(select) || select.dataset.customSelectReady === "1")
    return;
  select.dataset.customSelectReady = "1";
  select.classList.add("native-select-hidden");

  const wrap = document.createElement("div");
  wrap.className = "custom-select";
  wrap.innerHTML = `
    <button type="button" class="custom-select-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="custom-select-value"></span>
      <span class="custom-select-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="custom-select-menu" role="listbox" tabindex="-1"></div>
  `;
  select.insertAdjacentElement("afterend", wrap);

  const trigger = wrap.querySelector(".custom-select-trigger");
  const menu = wrap.querySelector(".custom-select-menu");

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (select.disabled) return;
    const willOpen = !wrap.classList.contains("is-open");
    closeAllCustomSelects(willOpen ? wrap : null);
    wrap.classList.toggle("is-open", willOpen);
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    if (willOpen) {
      syncCustomSelect(select);
      const selected =
        menu.querySelector(".is-selected") ||
        menu.querySelector(".custom-select-option:not(:disabled)");
      if (selected) selected.scrollIntoView({ block: "nearest" });
    }
  });

  trigger.addEventListener("keydown", (event) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (!wrap.classList.contains("is-open")) {
        closeAllCustomSelects(wrap);
        wrap.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
      }
      const options = Array.from(
        menu.querySelectorAll(".custom-select-option:not(:disabled)"),
      );
      if (!options.length) return;
      const current =
        menu.querySelector(".custom-select-option.is-keyboard") ||
        menu.querySelector(".is-selected");
      let idx = Math.max(0, options.indexOf(current));
      if (event.key === "ArrowDown")
        idx = Math.min(options.length - 1, idx + 1);
      if (event.key === "ArrowUp") idx = Math.max(0, idx - 1);
      options.forEach((o) => o.classList.remove("is-keyboard"));
      options[idx].classList.add("is-keyboard");
      options[idx].scrollIntoView({ block: "nearest" });
      if (event.key === "Enter" || event.key === " ") options[idx].click();
    }
    if (event.key === "Escape") {
      wrap.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
    }
  });

  select.addEventListener("change", () => syncCustomSelect(select));
  select.addEventListener("input", () => syncCustomSelect(select));

  const observer = new MutationObserver(() => syncCustomSelect(select));
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "label", "value"],
  });
  select._customSelectObserver = observer;

  syncCustomSelect(select);
}

function enhanceAllSelects(root = document) {
  root.querySelectorAll("select").forEach(enhanceSelect);
}

function initCustomSelects() {
  enhanceAllSelects(document);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".custom-select")) closeAllCustomSelects();
  });
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches && node.matches("select")) enhanceSelect(node);
        if (node.querySelectorAll) enhanceAllSelects(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ============================================
// UI RESTORATION (after F5 / Ctrl+R)
// ============================================

async function restoreUiStateAfterLoad() {
  let s;
  try {
    const raw = sessionStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return false;
    s = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!s || s.v !== 1) return false;

  uiStateRestoreInProgress = true;
  try {
    const section = s.section || "dashboard";
    showSection(section);

    if (s.templateEditorOpen && section === "templates") {
      await loadTemplates();
      const tid = s.editingTemplateId && String(s.editingTemplateId).trim();
      if (tid) {
        await editTemplate(tid);
      } else {
        clearTemplateForm();
        openTemplateEditorModal();
      }
      if (s.templateCodePhase) {
        setTemplateCodePhase(true);
      }
      return true;
    }

    if (s.campaignDetailOpen && s.campaignDetailId && section === "campaigns") {
      await loadCampaigns();
      await showCampaignDetail(s.campaignDetailId);
      return true;
    }

    if (s.campaignFormOpen && section === "campaigns") {
      await loadCampaigns();
      const ecid = s.editingCampaignId && String(s.editingCampaignId).trim();
      if (ecid) {
        await openEditCampaign(ecid);
      } else {
        resetNewCampaignForm();
        const list = document.getElementById("campaignsList");
        const formEl = document.getElementById("campaignForm");
        const newBtn = document.getElementById("newCampaignBtn");
        if (list) list.classList.add("hidden");
        if (formEl) formEl.classList.remove("hidden");
        if (newBtn) newBtn.classList.add("hidden");
        stopCampaignMonitor();
        await populateTemplateChips();
        await populateSmtpSelect();
      }
      return true;
    }

    return section !== "dashboard";
  } finally {
    uiStateRestoreInProgress = false;
    persistUiState();
  }
}

// ============================================
// INIT
// ============================================

function appendLiveLogLine(message, level) {
  const container = document.getElementById("detailLogsContainer");
  if (!container) return;
  container.querySelectorAll(".log-line").forEach((el) => {
    const txt = (el.textContent || "").trim();
    if (txt.startsWith("No logs available") || txt === "Loading...") {
      el.remove();
    }
  });
  const div = document.createElement("div");
  const cls =
    level === "ok"
      ? "ok"
      : level === "failed" || level === "error"
        ? "failed"
        : level === "warning"
          ? "retry"
          : "info";
  div.className = "log-line " + cls;
  div.textContent = message;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function wireTauriCampaignEvents() {
  const bus = window.winmailEvents;
  if (!bus) return;
  // When the real-time Tauri event bus is available we drive the campaign
  // monitor entirely from events and skip the legacy HTTP polling, which
  // would otherwise re-append log lines and duplicate them.
  const eventApi = window.__TAURI__ && window.__TAURI__.event;
  state.liveEventsActive = !!(
    eventApi && typeof eventApi.listen === "function"
  );
  bus.onProgress((payload) => {
    if (!payload || state.currentCampaignId !== payload.campaign_id) return;
    updateDetailStatsFromServer(
      {
        sent: payload.sent || 0,
        failed: payload.failed || 0,
        total: payload.total || 0,
      },
      payload.status,
    );
  });
  bus.onLog((payload) => {
    if (!payload || state.currentCampaignId !== payload.campaign_id) return;
    appendLiveLogLine(payload.message, payload.level);
  });
  bus.onStarted((payload) => {
    if (!payload || state.currentCampaignId !== payload.campaign_id) return;
    const indicator = document.getElementById("detailLogsIndicator");
    if (indicator) {
      indicator.innerHTML = tyI("activity", 12) + " <span>live</span>";
      indicator.style.color = "#22c55e";
    }
  });
  const finalize = (status) => (payload) => {
    if (!payload || state.currentCampaignId !== payload.campaign_id) return;
    updateDetailStatsFromServer(
      {
        sent: payload.sent || 0,
        failed: payload.failed || 0,
        total: payload.total || 0,
      },
      status,
    );
    const indicator = document.getElementById("detailLogsIndicator");
    if (indicator) {
      indicator.innerHTML = tyI("check-circle", 12) + " <span>completed</span>";
      indicator.style.color = "#64748b";
    }
    loadCampaigns();
  };
  bus.onCompleted(finalize("completed"));
  bus.onStopped(finalize("stopped"));
  bus.onFailed(finalize("failed"));
}

// ============================================
// AUTO-UPDATE CHECK
// ============================================

let _updateInfo = null;
const UPDATE_DISMISS_KEY = "winmail_update_dismissed_v";

function isUpdateDismissed(version) {
  return localStorage.getItem(UPDATE_DISMISS_KEY + version) === "1";
}

function dismissUpdate(version) {
  localStorage.setItem(UPDATE_DISMISS_KEY + version, "1");
}

function showUpdateButton(info) {
  _updateInfo = info;
  const navBtn = document.getElementById("updateNavBtn");
  const panelBtn = document.getElementById("updatePanelBtn");
  if (navBtn) {
    navBtn.classList.remove("hidden");
    navBtn.title = "Update available — v" + info.latest_version;
  }
  if (panelBtn) {
    panelBtn.classList.remove("hidden");
    panelBtn.textContent = "";
    const dot = document.createElement("span");
    dot.className = "update-pulse-dot-sm";
    panelBtn.appendChild(dot);
    panelBtn.appendChild(
      document.createTextNode(" Update v" + info.latest_version),
    );
  }
  if (typeof tyHydrateIcons === "function") {
    if (navBtn) tyHydrateIcons(navBtn);
  }
}

function hideUpdateButton() {
  const navBtn = document.getElementById("updateNavBtn");
  const panelBtn = document.getElementById("updatePanelBtn");
  if (navBtn) navBtn.classList.add("hidden");
  if (panelBtn) panelBtn.classList.add("hidden");
}

function openUpdateModal() {
  if (!_updateInfo) return;
  const modal = document.getElementById("updateModal");
  if (!modal) return;
  document.getElementById("updateCurrentVer").textContent =
    "v" + _updateInfo.current_version;
  document.getElementById("updateNewVer").textContent =
    "v" + _updateInfo.latest_version;
  const cl = document.getElementById("updateChangelog");
  if (cl) cl.textContent = _updateInfo.changelog || "";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  if (typeof tyHydrateIcons === "function") tyHydrateIcons(modal);
}

function closeUpdateModal() {
  const modal = document.getElementById("updateModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function initUpdateUI() {
  const navBtn = document.getElementById("updateNavBtn");
  const panelBtn = document.getElementById("updatePanelBtn");
  const dismissBtn = document.getElementById("updateDismissBtn");
  const downloadBtn = document.getElementById("updateDownloadBtn");
  const modal = document.getElementById("updateModal");

  if (navBtn) navBtn.addEventListener("click", openUpdateModal);
  if (panelBtn) panelBtn.addEventListener("click", openUpdateModal);

  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      if (_updateInfo) dismissUpdate(_updateInfo.latest_version);
      closeUpdateModal();
      hideUpdateButton();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      if (!_updateInfo || !_updateInfo.download_url) return;
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) {
        alert("Native updater unavailable in this environment.");
        return;
      }

      const previousHtml = downloadBtn.innerHTML;
      downloadBtn.disabled = true;
      downloadBtn.innerHTML =
        tyI("loader", 16) + '<span class="ty-btn-txt">Installing…</span>';
      try {
        const res = await invoke("install_update", {
          payload: {
            download_url: _updateInfo.download_url,
          },
        });
        alert(
          (res && res.message) ||
            "Installer launched. Follow the installer prompts to finish updating.",
        );
        closeUpdateModal();
      } catch (err) {
        console.error("Failed to install update:", err);
        alert("Update failed: " + formatUploadError(err));
        downloadBtn.disabled = false;
        downloadBtn.innerHTML = previousHtml;
        if (typeof tyHydrateIcons === "function") tyHydrateIcons(downloadBtn);
      }
    });
  }

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeUpdateModal();
    });
  }
}

async function checkForUpdate() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  try {
    const info = await invoke("check_for_update");
    if (info && info.update_available) {
      if (!isUpdateDismissed(info.latest_version)) {
        showUpdateButton(info);
      }
    }
  } catch (err) {
    console.warn("Update check failed (non-critical):", err);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  if (document.documentElement) document.documentElement.lang = "en";
  if (typeof tyHydrateIcons === "function") tyHydrateIcons();
  initCustomSelects();
  applySidebarPanelFromStorage();
  populateAwsRegionSelects();

  initNavigation();
  initDashboard();
  initTemplates();
  initCampaigns();
  wireTauriCampaignEvents();
  initScore();
  initConfig();
  initTesting();
  installFormValuesPersistence();
  initUpdateUI();
  checkForUpdate();

  // Flush pending input snapshots before the window goes away, so values
  // typed in the last 250ms are not lost on close.
  const flushFormValues = () => {
    if (formValuesDebounceTimer) {
      clearTimeout(formValuesDebounceTimer);
      formValuesDebounceTimer = null;
    }
    snapshotFormValues();
  };
  window.addEventListener("pagehide", () => {
    flushFormValues();
    persistUiState();
  });
  window.addEventListener("beforeunload", () => {
    flushFormValues();
    persistUiState();
  });

  const restored = await restoreUiStateAfterLoad();
  if (!restored) {
    showSection("dashboard");
  }

  // After everything has had a chance to populate its <select> options,
  // apply any persisted values once more to make sure dropdowns recover too.
  applyStoredFormValues();
});
/* ============================================
   IN-APP CONFIRMATION / ALERT
   ============================================
   The native window.confirm()/alert() are not reliable inside the Tauri
   webview (the dialog may never be shown, in which case confirm() returns
   false and the action silently aborts). These helpers render an in-app
   Aero dialog and resolve a Promise instead, so the delete / stop /
   relaunch flows always work. */

function uiConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay app-confirm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.className = "modal app-confirm-box";

    const title = document.createElement("h3");
    title.className = "app-confirm-title";
    title.textContent = options.title || "Please confirm";

    const text = document.createElement("p");
    text.className = "app-confirm-text";
    text.textContent = message == null ? "" : String(message);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = options.cancelLabel || "Cancel";

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = options.danger === false ? "btn-primary" : "btn-danger";
    okBtn.textContent = options.confirmLabel || "Delete";

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      }
    }

    cancelBtn.addEventListener("click", () => cleanup(false));
    okBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });
    document.addEventListener("keydown", onKey, true);

    requestAnimationFrame(() => okBtn.focus());
  });
}

function uiAlert(message, options = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay app-confirm-overlay";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.className = "modal app-confirm-box";

    const title = document.createElement("h3");
    title.className = "app-confirm-title";
    title.textContent = options.title || "Notice";

    const text = document.createElement("p");
    text.className = "app-confirm-text";
    text.textContent = message == null ? "" : String(message);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn-primary";
    okBtn.textContent = options.okLabel || "OK";

    actions.appendChild(okBtn);
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(true);
    };
    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        cleanup();
      }
    }

    okBtn.addEventListener("click", cleanup);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup();
    });
    document.addEventListener("keydown", onKey, true);

    requestAnimationFrame(() => okBtn.focus());
  });
}
