<div align="center">

<img src="frontend/assets/winmail-logo.svg" alt="WinMail" width="88" height="88" />

# WinMail

**A native desktop email campaign sender built for one person: you.**

No cloud. No account. No dashboard subscription. Just your machine, your lists, your providers.

[![Version](https://img.shields.io/badge/version-1.0.13-blue?style=flat-square)](#)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?style=flat-square)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.74%2B-orange?style=flat-square)](https://www.rust-lang.org)

</div>

---

## Why I built this

I got tired of paying monthly for tools that throttle me, hide my own sending
logic, and keep my recipient lists on someone else's server.

So I wrote my own. WinMail is a **real native application** — Rust and Tauri 2,
not an Electron wrapper, not a browser tab pretending to be an app. It starts
instantly, it uses a few dozen megabytes of RAM, and everything it knows stays
on your disk. The only network calls it ever makes are the ones you configure:
your provider, your SMTP server, your proxies.

It handles the parts of email campaigns that actually decide whether you land in
the inbox or in spam: sender identity, per-recipient personalisation, URL
rotation, send pacing, proxy rotation and a deliverability check before a single
message goes out.

---

## What it does

| | |
|---|---|
| **8 providers, one interface** | SMTP, Microsoft 365, Brevo, SendGrid, Amazon SES, Mailgun, Mandrill and Postmark — with native API integrations, not generic SMTP shims. |
| **Rotation everywhere** | Rotate across several SMTP/API accounts, across sender display names, across the local part of the address on a verified domain, and across destination URLs — each with its own switch frequency. |
| **Templates with folders** | Drag-and-drop folder organisation, a visual HTML editor *and* a raw code editor (CodeMirror), plus a live preview that merges real recipient data instead of fake placeholders. |
| **Serious recipient import** | CSV and TXT with automatic column detection, manual column mapping, custom variables, deduplication, domain filtering and "send Gmail last" ordering. |
| **Per-campaign proxies** | Paste a proxy list, pick a rotation frequency, add an optional per-proxy rate limit. Works on every provider — including plain SMTP, which goes through a native RFC 5321 tunnel I wrote for this. |
| **Deliverability scoring** | Spam-word density, image/text ratio, HTML weight, link analysis, unsubscribe presence and From-domain validation — before you send. |
| **Live campaign monitor** | Real-time progress events, per-recipient logs, pause, resume, stop, and automatic recovery of campaigns interrupted by a crash. |
| **Encrypted secrets** | API keys, SMTP passwords and AWS secret keys are AES-256-GCM encrypted at rest, with the master key stored `0600` in your app data directory. |
| **Looks like home** | The whole UI is a hand-built Aero / Windows 7 theme with glass panels, glossy buttons and a light, readable layout. |

---

## Supported providers

| Provider | Authentication | Sender list from API | Quota / DNS introspection |
|---|---|---|---|
| **SMTP (generic)** | host + port + user + password | — | connection test |
| **Microsoft 365** | SMTP with STARTTLS preset | — | connection test |
| **Brevo** | API key | yes | yes |
| **SendGrid** | API key (US / EU region) | yes | yes, incl. Email Activity log |
| **Amazon SES** | IAM access key + secret, region probe | yes | yes, all regions |
| **Mailgun** | API key + sending domain (US / EU) | yes | yes |
| **Mandrill** | API key | yes | yes |
| **Postmark** | API key | yes | yes |

Every configuration is stored and encrypted locally. Nothing is shared between
campaigns unless you deliberately reuse it.

---

## The template engine

Variables are case-insensitive and accept both `{{double}}` and `{single}`
braces. Unknown variables are left untouched, so a typo never silently blanks
your message.

### Recipient variables

Whatever your CSV columns are mapped to becomes available in the message:

| Variable | Source |
|---|---|
| `{{email}}` | the recipient address |
| `{{first_name}}`, `{{last_name}}` | mapped CSV columns |
| `{{name}}` | full display name |
| `{{prenom}}`, `{{nom}}`, `{{nom_complet}}`, `{{full_name}}` | automatic aliases |
| `{{anything_else}}` | any custom variable you mapped yourself |

### Generated variables

| Variable | Output |
|---|---|
| `{{RANDNUM-8}}` | random digits, e.g. `48291736` (never starts with 0) |
| `{{RANDALPHA-6}}` | random letters, e.g. `kQmVzA` |
| `{{RANDALPHANUM-12}}` | random alphanumerics |
| `{{date}}` | `11/10/2026` |
| `{{time}}` | `21:44` |
| `{{datetime}}` | `11/10/2026 21:44` |
| `{{rotate_url}}` | next URL from this template's rotation list |

Length is clamped between 1 and 128 characters for the random generators.

### URL rotation

Give a template a list of URLs and a rotation frequency. Each recipient gets the
next URL in the list, so the same link is never blasted to your entire list at
once — a simple, effective way to keep link reputation clean.

---

## Recipients

Import a CSV or TXT and WinMail takes it from there:

- **Automatic delimiter detection** — comma, semicolon (French/European Excel) or tab.
- **Encoding detection** — UTF-8, UTF-8 with BOM, UTF-16 LE/BE (Windows "Unicode Text" exports) and Windows-1252 fallback.
- **Column mapping** — pick the email column, map first name / last name / full name, and define your own custom variables.
- **Deduplication** — with an optional "keep duplicates" mode, so you can deliberately repeat an address (a control copy every N sends, for example).
- **Domain filter** — include or exclude specific domains.
- **Gmail last** — Gmail addresses are sent last, after every other domain.
- **Random pacing** — a min/max delay range between sends, so your traffic has a human rhythm instead of a machine-gun one.

---

## Proxies

Enable proxies per campaign and paste your list in any of these formats:

```
http://user:pass@1.2.3.4:8080
https://1.2.3.4:8443
socks5://1.2.3.4:1080
1.2.3.4:8080
1.2.3.4:8080:user:pass
```

- **Rotation** — switch proxy every N emails, or one proxy per email.
- **Per-proxy rate limit** — "30 sends per minute, per proxy". When every proxy
  is saturated, WinMail waits for the earliest free slot instead of ignoring the
  limit.
- **Works with SMTP too.** Most tools only proxy their HTTP API calls. For
  SMTP and Office365, WinMail opens the TCP connection through your SOCKS5 or
  HTTP CONNECT proxy and speaks RFC 5321 over it, STARTTLS and SASL
  authentication included.

Credentials are never written to log lines — proxy labels are always redacted.

---

## Deliverability tools

Before you commit to a send:

- **Spam score** — keyword density against a real spam-word list, image-to-text
  ratio, total HTML weight, link count and quality, unsubscribe link presence,
  and a From-domain consistency check.
- **DNS verification** — SPF, DKIM and DMARC records for the sending domain,
  resolved live.
- **Provider quotas** — remaining credits, reputation and sender verification
  status pulled straight from each provider's API.
- **Lab — Tests** — send a single test email through any configuration, with
  full provider introspection output.

---

## Security and privacy

- **Encrypted at rest.** API keys, SMTP passwords and AWS secret keys are
  encrypted with AES-256-GCM. The master key lives in your app data directory
  with `0600` permissions on Unix.
- **No telemetry.** WinMail never phones home. The only outbound requests are
  yours.
- **No accounts.** There is nothing to sign up for because there is no service —
  just an application.
- **Local data.** Templates, campaigns, logs, uploaded recipient files and
  configurations all live in your own user data directory.

---

## Install

### Prebuilt binaries

Grab the latest installer from the [Releases page](https://github.com/WindowS-gif/WinMail/releases/latest):

- **Windows** — `-setup.exe` (NSIS installer). Requires the
  [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/),
  which ships with Windows 11 and installs in one click on Windows 10.
- **Linux** — `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) or `.AppImage`
  (any glibc-based distribution).
- **macOS** — build from source, see [INSTALL.md](INSTALL.md).

### From source

```bash
git clone https://github.com/WindowS-gif/WinMail.git
cd WinMail
npm install
cargo install tauri-cli --version '^2'
cargo tauri dev      # run
cargo tauri build    # produce a native installer
```

Full platform requirements are in [INSTALL.md](INSTALL.md).

---

## Quick start

1. **Launch WinMail.** The Dashboard is empty until you add something — that's normal.
2. **SMTP / API** → add a configuration. Paste your provider API key, or your
   SMTP host, port, username and password. Use **Test** to confirm it works.
3. **Templates** → create your first template. Drop in HTML, personalise it with
   `{{first_name}}`, `{{rotate_url}}`, `{{RANDNUM-6}}`, and preview it with real
   data before saving. Organise related templates into folders by dragging one
   card onto another.
4. **Campaigns** → **New campaign**:
   - ① Import your list and map the columns.
   - ② Pick one or more templates and set the rotation frequency.
   - ③ Choose your SMTP/API configuration and the sender identity.
   - ④ Optionally enable proxies, pacing and sender rotation.
   - ⑤ Run the analysis, then send.
5. **Watch it happen.** Progress, per-recipient logs and live stats update as
   the campaign runs. Pause, resume or stop at any time.

---

## Where your data lives

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\app.winmail.sender` |
| Linux | `~/.local/share/app.winmail.sender` |
| macOS | `~/Library/Application Support/app.winmail.sender` |

```
templates/          Template JSON + folder definitions
campaigns/          Campaign JSON + one .log.jsonl per campaign
provider_configs/   Encrypted SMTP / API configurations
uploads/            Recipient files imported through the interface
logs/               Application logs
.secrets.key        Master AES-256 key (0600 on Unix)
```

Back up this directory and you have backed up everything.

---

## Under the hood

```
frontend/               Vanilla JS/HTML/CSS interface (no framework, no build step)
  index.html            Application shell: every page and modal
  legacy-app.js         Application logic
  tauri-adapter.js      Bridge to the Rust backend + campaign event bus
  styles.css            The entire Aero theme
src-tauri/
  src/commands/         Tauri commands (the backend API surface)
  src/campaign/         Send engine: rotation, pacing, logging, recovery
  src/mailer/           SMTP, and the SOCKS5 / HTTP CONNECT SMTP tunnel
  src/providers/        One module per API provider
  src/template/         Personalisation and rendering engine
  src/scoring/          Spam word list and deliverability scoring
  src/security/         AES-256-GCM secret storage
  src/storage/          JSON persistence layer
```

There is no bundler and no frontend framework on purpose: the interface is
plain HTML, CSS and JavaScript that the WebView loads directly. That keeps the
build fast, the app small and the whole thing auditable.

### Tests

```bash
cd src-tauri
cargo test --lib
cargo clippy --lib --all-targets -- -D warnings
```

The suite includes end-to-end tests that spin up an in-process SOCKS5 server,
an HTTP CONNECT proxy and a fake SMTP server on real sockets, so the entire
proxied sending pipeline is exercised without any external service.

---

## Roadmap

Things I want to add next:

- [ ] Scheduled campaigns (send at a specific date and time)
- [ ] A/B subject-line testing with automatic winner selection
- [ ] Bounce and complaint ingestion from provider webhooks
- [ ] A proper import for Excel files (`.xlsx`)
- [ ] macOS notarised builds

Ideas and bug reports are welcome in the [issues](https://github.com/WindowS-gif/WinMail/issues).

---

## License

[MIT](LICENSE) © 2026 [WindowS-gif](https://github.com/WindowS-gif)

Built with Rust, Tauri 2 and a stubborn refusal to rent my own tooling.
