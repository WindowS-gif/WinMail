# WinMail

> Native, private email campaigns — no cloud, no account, just your machine.

WinMail is a **native desktop application** for running email campaigns. It's a Tauri 2 app written in Rust with a vanilla JS / HTML / CSS frontend — no Electron, no web server, no PHP.

## Features

- **Multi-provider** — send via SMTP, Microsoft 365, [Brevo](https://www.brevo.com/), [SendGrid](https://sendgrid.com/), [Amazon SES](https://aws.amazon.com/ses/), [Mailgun](https://www.mailgun.com/), [Mandrill](https://mandrillapp.com/) or [Postmark](https://postmarkapp.com/).
- **SMTP / API rotation** — split a campaign across several configurations.
- **Templates** with per-template URL rotation, `{{var}}` placeholders, `{{RANDNUM-8}}`-style randoms and an HTML preview that merges real recipient data.
- **CSV / TXT recipient import** with column mapping, dedup, domain filter, "Gmail last" ordering.
- **Deliverability score** — spam-word density, image / text ratio, HTML size, link analysis, unsubscribe presence, From-domain check.
- **DNS verifier** — checks SPF / DKIM / DMARC for the sending domain.
- **Live campaign monitor** — real-time progress events, per-recipient logs, pause / resume / stop, throttled stat persistence.
- **Per-campaign proxy support** — paste an HTTP, HTTPS, SOCKS5 or SOCKS5h proxy list; pick a rotation frequency; optional per-proxy rate limit (e.g. "30 sends / minute, per proxy"). Works on **every** provider including SMTP / Office365, which go through a native RFC 5321 tunnel.
- **Encrypted secrets at rest** — API keys, SMTP passwords and SES secret keys are AES-256-GCM encrypted with a key kept in the app data directory (`0600` perms on Unix).
- **Auto plain-text fallback** — pure-HTML messages are auto-augmented with a derived `text/plain` part for deliverability.
- **Input persistence** — the Lab and Settings forms remember what you typed across page navigation and app reloads (secrets excluded).

## Install

### Prebuilt binaries

Grab the latest installer from the [Releases page](https://github.com/WindowS-gif/WinMail/releases/latest):

- **Linux** — `.deb` (Debian / Ubuntu), `.rpm` (Fedora / RHEL), `.AppImage` (universal)
- **Windows** — `-setup.exe` (NSIS installer). Requires the [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 11; one-time download on Windows 10).

macOS is not shipped as a prebuilt binary but builds from source — see [INSTALL.md](INSTALL.md).

### From source

See [INSTALL.md](INSTALL.md).

## Quick start

1. Launch WinMail.
2. **SMTP / API** → add a configuration (SMTP credentials or an API key for one of the supported providers).
3. **Templates** → create at least one template. Use `{{first_name}}`, `{{rotate_url}}`, `{{RANDNUM-6}}`, etc.
4. **Campaigns** → upload a CSV, pick templates and provider(s), tune the delay and (optionally) proxies, then **Send**.
5. Watch progress live in the campaign detail view.

## Data

Everything lives under your user data directory (`~/.local/share/app.winmail.sender` on Linux, `%APPDATA%\app.winmail.sender` on Windows, `~/Library/Application Support/app.winmail.sender` on macOS). Layout:

```
templates/        Template JSON + folders
campaigns/        Campaign JSON + .log.jsonl per campaign
provider_configs/ Encrypted SMTP / API configs
uploads/          Recipient files saved through the UI
logs/             Application logs
.secrets.key      Master AES-256 key (0600 on Unix)
```

## License

[MIT](LICENSE) © 2026 WindowS-gif
