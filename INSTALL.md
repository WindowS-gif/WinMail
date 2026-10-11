# Building WinMail from source

## Requirements

| Platform | Toolchain | System libraries |
|---|---|---|
| Linux  | Rust 1.74+, Node 18+, Tauri CLI 2 | `webkit2gtk-4.1`, `libsoup3`, `gtk3`, `libayatana-appindicator3`, `librsvg2`, `patchelf` |
| Windows | Rust 1.74+ (MSVC), Node 18+, Tauri CLI 2 | [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) runtime, Visual Studio Build Tools 2022 |
| macOS  | Rust 1.74+, Node 18+, Tauri CLI 2, Xcode CLT | — |

### Linux package names (examples)

- **Arch / Manjaro** — `pacman -S webkit2gtk-4.1 base-devel curl wget file openssl libappindicator-gtk3 librsvg gtk3`
- **Debian / Ubuntu 22.04+** — `apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev`
- **Fedora 38+** — `dnf install webkit2gtk4.1-devel gcc-c++ openssl-devel libxdo-devel libappindicator-gtk3-devel librsvg2-devel`

## Build

```bash
# 1. Clone
git clone https://github.com/WindowS-gif/WinMail.git
cd WinMail

# 2. Install JS deps (just the Tauri CLI wrapper)
npm install

# 3. Install Tauri CLI v2 (Rust)
cargo install tauri-cli --version '^2'

# 4. Run from source
cargo tauri dev

# 5. Build a release binary + native installer for the current OS
cargo tauri build
```

Build artefacts are written under `src-tauri/target/release/bundle/`:

| Platform | Artefacts |
|---|---|
| Linux | `bundle/deb/*.deb`, `bundle/rpm/*.rpm`, `bundle/appimage/*.AppImage` |
| Windows | `bundle/msi/*.msi`, `bundle/nsis/*-setup.exe` |
| macOS | `bundle/dmg/*.dmg`, `bundle/macos/*.app` |

## Tests

```bash
cd src-tauri
cargo test --lib       # unit + integration tests
cargo clippy --lib --all-targets -- -D warnings
```

The integration suite spins up an in-process SOCKS5 server, an in-process HTTP-CONNECT proxy and a fake SMTP server so the full proxied send pipeline is exercised on real sockets — no external services are required.
