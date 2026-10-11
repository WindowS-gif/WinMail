use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use email_address::EmailAddress;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::AppState;
use crate::core::api::ApiResponse;
use crate::core::error::{AppError, AppResult};
use crate::storage;

#[derive(Debug, Deserialize)]
struct ParseRecipientsPayload {
    file_path: String,
    file_type: String,
    #[serde(default)]
    column_mapping: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone)]
pub struct ParseOutput {
    pub recipients: Vec<HashMap<String, String>>,
    pub headers: Vec<String>,
}

/// Public helper used by the campaign engine to load recipients off disk.
pub async fn parse_file(
    path: &Path,
    file_type: &str,
    column_mapping: Option<Value>,
) -> AppResult<ParseOutput> {
    let mapping_map = column_mapping.and_then(|v| match v {
        Value::Object(map) => Some(map.into_iter().collect::<HashMap<String, Value>>()),
        _ => None,
    });
    match file_type {
        "txt" => parse_txt(path).await,
        "csv" => parse_csv(path, mapping_map.as_ref()).await,
        other => Err(AppError::Validation(format!(
            "Unsupported file type: {other}"
        ))),
    }
}

#[tauri::command]
pub async fn save_upload(
    state: State<'_, AppState>,
    filename: String,
    file_type: String,
    bytes: Vec<u8>,
) -> Result<ApiResponse<Value>, AppError> {
    validate_upload_request(&filename, &file_type)?;
    if bytes.is_empty() {
        return Ok(ApiResponse::err("Empty file"));
    }

    storage::ensure_dir(&state.paths.uploads_dir).await?;
    let safe_name = sanitize_filename(&filename);
    let path = upload_final_path(&state.paths.uploads_dir, &safe_name, None);
    tokio::fs::write(&path, bytes).await?;
    upload_response(&path, &file_type).await
}

#[tauri::command]
pub async fn import_recipient_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ApiResponse<Value>, AppError> {
    import_recipient_file_from_path(&state.paths.uploads_dir, Path::new(&path)).await
}

#[tauri::command]
pub async fn pick_recipient_file(
    state: State<'_, AppState>,
) -> Result<ApiResponse<Value>, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose recipients file")
            .add_filter("Recipients", &["csv", "txt"])
            .pick_file()
    })
    .await
    .map_err(|e| AppError::Validation(format!("File dialog failed: {e}")))?;

    let Some(path) = picked else {
        return Ok(ApiResponse::err("No file selected"));
    };
    import_recipient_file_from_path(&state.paths.uploads_dir, &path).await
}

#[tauri::command]
pub async fn start_upload(
    state: State<'_, AppState>,
    filename: String,
    file_type: String,
) -> Result<ApiResponse<Value>, AppError> {
    validate_upload_request(&filename, &file_type)?;
    storage::ensure_dir(&state.paths.uploads_dir).await?;
    let upload_id = uuid::Uuid::new_v4().to_string();
    let temp_path = upload_temp_path(&state.paths.uploads_dir, &upload_id)?;
    tokio::fs::File::create(&temp_path).await?;
    Ok(ApiResponse::ok(json!({ "upload_id": upload_id })))
}

#[tauri::command]
pub async fn append_upload_chunk(
    state: State<'_, AppState>,
    upload_id: String,
    bytes: Vec<u8>,
) -> Result<ApiResponse<Value>, AppError> {
    let temp_path = upload_temp_path(&state.paths.uploads_dir, &upload_id)?;
    let mut file = tokio::fs::OpenOptions::new()
        .append(true)
        .open(&temp_path)
        .await?;
    use tokio::io::AsyncWriteExt;
    file.write_all(&bytes).await?;
    Ok(ApiResponse::<Value>::empty_ok())
}

#[tauri::command]
pub async fn finish_upload(
    state: State<'_, AppState>,
    upload_id: String,
    filename: String,
    file_type: String,
) -> Result<ApiResponse<Value>, AppError> {
    validate_upload_request(&filename, &file_type)?;
    let temp_path = upload_temp_path(&state.paths.uploads_dir, &upload_id)?;
    let metadata = tokio::fs::metadata(&temp_path).await?;
    if metadata.len() == 0 {
        tokio::fs::remove_file(&temp_path).await.ok();
        return Ok(ApiResponse::err("Empty file"));
    }

    let mut validation = json!({});
    if file_type == "csv" {
        match parse_csv(&temp_path, None).await {
            Ok(parsed) => validation["headers"] = json!(parsed.headers),
            Err(err) => {
                tokio::fs::remove_file(&temp_path).await.ok();
                return Err(err);
            }
        }
    }

    let safe_name = sanitize_filename(&filename);
    let final_path = upload_final_path(&state.paths.uploads_dir, &safe_name, Some(&upload_id));
    tokio::fs::rename(&temp_path, &final_path).await?;
    Ok(ApiResponse::ok(json!({
        "filepath": final_path.display().to_string(),
        "file_type": file_type,
        "validation": validation
    })))
}

#[tauri::command]
pub async fn abort_upload(
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<ApiResponse<Value>, AppError> {
    if let Ok(temp_path) = upload_temp_path(&state.paths.uploads_dir, &upload_id) {
        tokio::fs::remove_file(temp_path).await.ok();
    }
    Ok(ApiResponse::<Value>::empty_ok())
}

pub async fn parse_recipients(data: Value) -> AppResult<ApiResponse<Value>> {
    let payload: ParseRecipientsPayload = serde_json::from_value(data)?;
    let mapping_value = payload
        .column_mapping
        .as_ref()
        .map(|m| Value::Object(m.clone().into_iter().collect()));
    let out = match parse_file(
        Path::new(&payload.file_path),
        &payload.file_type,
        mapping_value,
    )
    .await
    {
        Ok(out) => out,
        Err(AppError::Validation(msg)) => return Ok(ApiResponse::err(msg)),
        Err(e) => return Err(e),
    };

    let mut domains: BTreeMap<String, usize> = BTreeMap::new();
    for recipient in &out.recipients {
        if let Some(email) = recipient.get("email") {
            if let Some(domain) = email.split('@').nth(1) {
                *domains.entry(domain.to_ascii_lowercase()).or_default() += 1;
            }
        }
    }

    Ok(ApiResponse::ok(json!({
        "total": out.recipients.len(),
        "domains": domains,
        "headers": out.headers,
        "sample": out.recipients.iter().take(5).collect::<Vec<_>>()
    })))
}

async fn parse_txt(path: &Path) -> AppResult<ParseOutput> {
    let bytes = tokio::fs::read(path).await?;
    let content = decode_recipient_file_bytes(&bytes);
    let mut recipients = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut row = HashMap::new();
        if line.contains('/') && line.matches('/').count() >= 2 {
            let parts: Vec<_> = line.splitn(3, '/').map(str::trim).collect();
            if parts.len() == 3 && EmailAddress::is_valid(parts[2]) {
                row.insert("first_name".to_string(), parts[0].to_string());
                row.insert("last_name".to_string(), parts[1].to_string());
                row.insert(
                    "name".to_string(),
                    format!("{} {}", parts[0], parts[1]).trim().to_string(),
                );
                row.insert("email".to_string(), parts[2].to_ascii_lowercase());
            }
        } else if EmailAddress::is_valid(line) {
            row.insert("email".to_string(), line.to_ascii_lowercase());
        }

        if row.contains_key("email") {
            add_name_aliases(&mut row);
            recipients.push(row);
        }
    }
    Ok(ParseOutput {
        recipients,
        headers: Vec::new(),
    })
}

async fn parse_csv(
    path: &Path,
    mapping: Option<&HashMap<String, Value>>,
) -> AppResult<ParseOutput> {
    let bytes = tokio::fs::read(path).await?;
    let content = decode_recipient_file_bytes(&bytes);
    let csv_bytes = content.as_bytes();
    let delimiter = detect_delimiter(csv_bytes);
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(csv_bytes);
    let headers: Vec<String> = reader.headers()?.iter().map(ToString::to_string).collect();

    let explicit = mapping
        .and_then(|m| m.get("email"))
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let mut recipients = Vec::new();
    for record in reader.records() {
        let record = record?;
        let raw: HashMap<String, String> = headers
            .iter()
            .cloned()
            .zip(record.iter().map(|v| v.trim().to_string()))
            .collect();
        let mut row = if explicit {
            map_csv_explicit(&raw, mapping.expect("checked explicit"))
        } else {
            map_csv_auto(&raw)
        };
        let Some(email) = row.get("email").map(|s| s.trim().to_ascii_lowercase()) else {
            continue;
        };
        if !EmailAddress::is_valid(&email) {
            continue;
        }
        row.insert("email".to_string(), email);
        add_name_aliases(&mut row);
        recipients.push(row);
    }

    Ok(ParseOutput {
        recipients,
        headers,
    })
}

fn validate_upload_request(filename: &str, file_type: &str) -> AppResult<()> {
    if filename.trim().is_empty() {
        return Err(AppError::Validation("Missing filename".to_string()));
    }
    if !matches!(file_type, "csv" | "txt") {
        return Err(AppError::Validation(format!(
            "Unsupported file type: {file_type}"
        )));
    }
    Ok(())
}

fn validate_upload_id(upload_id: &str) -> AppResult<uuid::Uuid> {
    uuid::Uuid::parse_str(upload_id)
        .map_err(|_| AppError::Validation("Invalid upload id".to_string()))
}

fn upload_temp_path(uploads_dir: &Path, upload_id: &str) -> AppResult<PathBuf> {
    let id = validate_upload_id(upload_id)?;
    Ok(uploads_dir.join(format!("{id}.part")))
}

fn upload_final_path(uploads_dir: &Path, safe_name: &str, upload_id: Option<&str>) -> PathBuf {
    let id = upload_id
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .unwrap_or_else(uuid::Uuid::new_v4);
    uploads_dir.join(format!("{id}_{safe_name}"))
}

async fn import_recipient_file_from_path(
    uploads_dir: &Path,
    source_path: &Path,
) -> Result<ApiResponse<Value>, AppError> {
    let metadata = tokio::fs::metadata(source_path).await?;
    if !metadata.is_file() {
        return Ok(ApiResponse::err("Selected path is not a file"));
    }
    if metadata.len() == 0 {
        return Ok(ApiResponse::err("Empty file"));
    }

    let filename = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("recipients.csv");
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let file_type = match ext.as_str() {
        "txt" => "txt",
        "csv" => "csv",
        "xls" | "xlsx" => {
            return Ok(ApiResponse::err(
                "Excel files are not supported. Export your table as CSV or TXT.",
            ))
        }
        _ => return Ok(ApiResponse::err("Choose a .csv or .txt file")),
    };

    validate_upload_request(filename, file_type)?;
    storage::ensure_dir(uploads_dir).await?;
    let safe_name = sanitize_filename(filename);
    let dest_path = upload_final_path(uploads_dir, &safe_name, None);
    tokio::fs::copy(source_path, &dest_path).await?;

    match upload_response(&dest_path, file_type).await {
        Ok(res) => Ok(res),
        Err(err) => {
            tokio::fs::remove_file(&dest_path).await.ok();
            Err(err)
        }
    }
}

async fn upload_response(path: &Path, file_type: &str) -> Result<ApiResponse<Value>, AppError> {
    let mut validation = json!({});
    if file_type == "csv" {
        let parsed = parse_csv(path, None).await?;
        validation["headers"] = json!(parsed.headers);
    }
    Ok(ApiResponse::ok(json!({
        "filepath": path.display().to_string(),
        "file_type": file_type,
        "validation": validation
    })))
}

/// Decode CSV/TXT files exported by common Windows tools.
///
/// Linux/macOS exports are usually UTF-8, but Windows Excel/Notepad may write
/// recipient lists as UTF-16 (often tab-separated) or legacy Windows-1252
/// (“ANSI”). Feeding those bytes directly to `csv` or `read_to_string` fails
/// with invalid UTF-8, which made uploads look broken on Windows.
fn decode_recipient_file_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16_bytes(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16_bytes(&bytes[2..], false);
    }

    if looks_like_utf16_le(bytes) {
        return decode_utf16_bytes(bytes, true);
    }
    if looks_like_utf16_be(bytes) {
        return decode_utf16_bytes(bytes, false);
    }

    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => decode_windows_1252(bytes),
    }
}

fn decode_utf16_bytes(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|chunk| {
        if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        }
    });
    std::char::decode_utf16(units)
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect::<String>()
        .trim_start_matches('\u{feff}')
        .to_string()
}

fn looks_like_utf16_le(bytes: &[u8]) -> bool {
    looks_like_utf16_with_zeroes(bytes, 1)
}

fn looks_like_utf16_be(bytes: &[u8]) -> bool {
    looks_like_utf16_with_zeroes(bytes, 0)
}

fn looks_like_utf16_with_zeroes(bytes: &[u8], zero_offset: usize) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    let pairs = bytes.len() / 2;
    if pairs == 0 {
        return false;
    }
    let zeroes = bytes
        .chunks_exact(2)
        .filter(|pair| pair.get(zero_offset).copied() == Some(0))
        .count();
    zeroes * 100 / pairs >= 60
}

fn decode_windows_1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80 => '€',
            0x82 => '‚',
            0x83 => 'ƒ',
            0x84 => '„',
            0x85 => '…',
            0x86 => '†',
            0x87 => '‡',
            0x88 => 'ˆ',
            0x89 => '‰',
            0x8A => 'Š',
            0x8B => '‹',
            0x8C => 'Œ',
            0x8E => 'Ž',
            0x91 => '‘',
            0x92 => '’',
            0x93 => '“',
            0x94 => '”',
            0x95 => '•',
            0x96 => '–',
            0x97 => '—',
            0x98 => '˜',
            0x99 => '™',
            0x9A => 'š',
            0x9B => '›',
            0x9C => 'œ',
            0x9E => 'ž',
            0x9F => 'Ÿ',
            0x81 | 0x8D | 0x8F | 0x90 | 0x9D => char::REPLACEMENT_CHARACTER,
            _ => b as char,
        })
        .collect()
}

/// Remove a leading UTF-8 byte-order mark (EF BB BF) if present. Excel and
/// many Windows tools prepend one, which otherwise corrupts the first CSV
/// header (`\u{feff}Email`) and makes the email column undetectable.
#[cfg(test)]
fn strip_bom(bytes: &mut Vec<u8>) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(0..3);
    }
}

/// Sniff the field delimiter from the header line. Defaults to comma, but
/// detects `;` (common in French/European Excel exports) and tab.
fn detect_delimiter(bytes: &[u8]) -> u8 {
    let line_end = bytes
        .iter()
        .position(|&b| b == b'\n')
        .unwrap_or(bytes.len());
    let line = &bytes[..line_end];
    let count = |d: u8| line.iter().filter(|&&b| b == d).count();
    let comma = count(b',');
    let semicolon = count(b';');
    let tab = count(b'\t');
    if semicolon > comma && semicolon >= tab {
        b';'
    } else if tab > comma && tab > semicolon {
        b'\t'
    } else {
        b','
    }
}

fn map_csv_auto(raw: &HashMap<String, String>) -> HashMap<String, String> {
    let mut row = HashMap::new();
    for (key, value) in raw {
        let normalized = key.trim().to_ascii_lowercase().replace(' ', "_");
        row.insert(normalized, value.trim().to_string());
    }
    // Map common email-column header variants onto the canonical `email` key
    // when the file didn't already have one.
    if !row.contains_key("email") {
        for alias in [
            "e-mail",
            "e_mail",
            "mail",
            "email_address",
            "emailaddress",
            "courriel",
            "adresse_email",
        ] {
            if let Some(v) = row.remove(alias) {
                row.insert("email".to_string(), v);
                break;
            }
        }
    }
    row
}

fn map_csv_explicit(
    raw: &HashMap<String, String>,
    mapping: &HashMap<String, Value>,
) -> HashMap<String, String> {
    let mut row = HashMap::new();
    for key in ["email", "first_name", "last_name", "name", "prenom", "nom"] {
        if let Some(source) = mapping.get(key).and_then(Value::as_str).map(str::trim) {
            if !source.is_empty() {
                if let Some(value) = raw.get(source) {
                    row.insert(key.to_string(), value.trim().to_string());
                }
            }
        }
    }

    if let Some(custom) = mapping.get("custom_variables").and_then(Value::as_object) {
        for (var_name, source_value) in custom {
            let Some(source) = source_value.as_str().map(str::trim) else {
                continue;
            };
            if source.is_empty() {
                continue;
            }
            if let Some(value) = raw.get(source) {
                let normalized = normalize_variable_name(var_name);
                if !normalized.is_empty() {
                    row.insert(normalized, value.trim().to_string());
                }
            }
        }
    }

    row
}

fn normalize_variable_name(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn add_name_aliases(row: &mut HashMap<String, String>) {
    if let Some(v) = row.get("first_name").cloned() {
        row.entry("prenom".to_string()).or_insert(v);
    }
    if let Some(v) = row.get("last_name").cloned() {
        row.entry("nom".to_string()).or_insert(v);
    }
    if let Some(v) = row.get("name").cloned() {
        row.entry("nom_complet".to_string()).or_insert(v.clone());
        row.entry("full_name".to_string()).or_insert(v);
    }
}

fn sanitize_filename(filename: &str) -> String {
    filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

#[allow(dead_code)]
fn missing_file(path: &Path) -> AppError {
    AppError::NotFound(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_file(name: &str, content: &str) -> std::path::PathBuf {
        tmp_file_bytes(name, content.as_bytes())
    }

    fn tmp_file_bytes(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("winmail-test-{}-{}", uuid::Uuid::new_v4(), name));
        let mut f = std::fs::File::create(&path).expect("tmp file");
        f.write_all(content).expect("write");
        path
    }

    fn utf16le_with_bom(s: &str) -> Vec<u8> {
        let mut out = vec![0xFF, 0xFE];
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[tokio::test]
    async fn import_recipient_file_from_path_copies_and_validates_csv() {
        let source = tmp_file("import.csv", "Email,Name\nalice@example.com,Alice\n");
        let uploads_dir =
            std::env::temp_dir().join(format!("winmail-uploads-test-{}", uuid::Uuid::new_v4()));
        let res = import_recipient_file_from_path(&uploads_dir, &source)
            .await
            .expect("import ok");
        std::fs::remove_file(&source).ok();
        std::fs::remove_dir_all(&uploads_dir).ok();

        assert!(res.success);
        let data = res.data.expect("response data");
        assert_eq!(data["file_type"], "csv");
        assert!(data["validation"]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h == "Email"));
    }

    #[tokio::test]
    async fn parse_txt_handles_three_field_lines_and_plain_emails() {
        let path = tmp_file(
            "recipients.txt",
            "Alice/Smith/alice@example.com\nbob@example.org\nnot-an-email\n\n",
        );
        let out = parse_txt(&path).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 2);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert_eq!(out.recipients[0].get("first_name").unwrap(), "Alice");
        assert_eq!(out.recipients[0].get("last_name").unwrap(), "Smith");
        assert_eq!(out.recipients[0].get("prenom").unwrap(), "Alice");
        assert_eq!(out.recipients[1].get("email").unwrap(), "bob@example.org");
    }

    #[tokio::test]
    async fn parse_csv_auto_mapping_picks_email_column() {
        let path = tmp_file(
            "recipients.csv",
            "Email,First Name,Last Name\nalice@example.com,Alice,Smith\nINVALID,oops,oops\n",
        );
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert!(out.headers.contains(&"Email".to_string()));
    }

    #[tokio::test]
    async fn parse_csv_handles_utf8_bom() {
        // Excel/Windows exports prepend a UTF-8 BOM; without stripping it the
        // first header becomes "\u{feff}Email" and every row is dropped.
        let path = tmp_file("bom.csv", "\u{feff}Email,Name\nalice@example.com,Alice\n");
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        // The BOM must not survive in the header name either.
        assert!(out.headers.iter().any(|h| h == "Email"));
    }

    #[tokio::test]
    async fn parse_csv_handles_utf16le_tab_export() {
        // Windows Excel can export "Unicode Text" as UTF-16LE + tabs. Users may
        // still choose that file as CSV/TXT; upload should not fail on Windows.
        let bytes = utf16le_with_bom("Email\tName\r\nalice@example.com\tAlice\r\n");
        let path = tmp_file_bytes("utf16.csv", &bytes);
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert!(out.headers.iter().any(|h| h == "Email"));
    }

    #[tokio::test]
    async fn parse_txt_handles_utf16le_export() {
        let bytes = utf16le_with_bom("alice@example.com\r\nbob@example.org\r\n");
        let path = tmp_file_bytes("utf16.txt", &bytes);
        let out = parse_txt(&path).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 2);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert_eq!(out.recipients[1].get("email").unwrap(), "bob@example.org");
    }

    #[tokio::test]
    async fn parse_csv_falls_back_to_windows_1252() {
        let bytes = b"Email,Name\nalice@example.com,Andr\xE9\n";
        let path = tmp_file_bytes("cp1252.csv", bytes);
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert_eq!(out.recipients[0].get("name").unwrap(), "André");
    }

    #[tokio::test]
    async fn parse_csv_detects_semicolon_delimiter() {
        // French/European Excel uses ';' as the field separator.
        let path = tmp_file(
            "semi.csv",
            "Email;First Name;Last Name\nalice@example.com;Alice;Smith\nbob@example.org;Bob;Jones\n",
        );
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 2);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert_eq!(out.recipients[0].get("first_name").unwrap(), "Alice");
    }

    #[tokio::test]
    async fn parse_csv_auto_maps_email_address_header() {
        let path = tmp_file("addr.csv", "Email Address,Name\nalice@example.com,Alice\n");
        let out = parse_csv(&path, None).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
    }

    #[test]
    fn detect_delimiter_picks_expected() {
        assert_eq!(detect_delimiter(b"a,b,c\n1,2,3"), b',');
        assert_eq!(detect_delimiter(b"a;b;c\n1;2;3"), b';');
        assert_eq!(detect_delimiter(b"a\tb\tc\n1\t2\t3"), b'\t');
        assert_eq!(detect_delimiter(b"email\nalice@example.com"), b',');
    }

    #[test]
    fn strip_bom_removes_leading_marker() {
        let mut with_bom = vec![0xEF, 0xBB, 0xBF, b'a', b'b'];
        strip_bom(&mut with_bom);
        assert_eq!(with_bom, b"ab");
        let mut without = b"ab".to_vec();
        strip_bom(&mut without);
        assert_eq!(without, b"ab");
    }

    #[tokio::test]
    async fn parse_csv_explicit_mapping_supports_custom_variables() {
        let path = tmp_file(
            "recipients2.csv",
            "Address,FirstName,Company\nalice@example.com,Alice,Acme\n",
        );
        let mapping: HashMap<String, Value> = HashMap::from([
            ("email".to_string(), serde_json::json!("Address")),
            ("first_name".to_string(), serde_json::json!("FirstName")),
            (
                "custom_variables".to_string(),
                serde_json::json!({ "company": "Company" }),
            ),
        ]);
        let out = parse_csv(&path, Some(&mapping)).await.expect("parse ok");
        std::fs::remove_file(&path).ok();
        assert_eq!(out.recipients.len(), 1);
        assert_eq!(out.recipients[0].get("email").unwrap(), "alice@example.com");
        assert_eq!(out.recipients[0].get("first_name").unwrap(), "Alice");
        assert_eq!(out.recipients[0].get("company").unwrap(), "Acme");
    }

    #[test]
    fn sanitize_filename_strips_unsafe_chars() {
        assert_eq!(sanitize_filename("hello world!.csv"), "hello_world_.csv");
        // Path separators MUST be removed so an upload can't escape the
        // uploads directory (final names are also prefixed with a UUID).
        let sanitized = sanitize_filename("../etc/passwd");
        assert!(!sanitized.contains('/'));
        assert!(!sanitized.contains('\\'));
        assert_eq!(sanitized, ".._etc_passwd");
    }

    #[test]
    fn normalize_variable_name_keeps_alphanumeric_only() {
        assert_eq!(normalize_variable_name("R&D"), "r_d");
        assert_eq!(normalize_variable_name("  name 1 "), "name_1");
        assert_eq!(normalize_variable_name("___"), "");
    }
}
