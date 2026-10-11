use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use tauri::State;

use crate::app_state::AppState;
use crate::core::api::ApiResponse;
use crate::core::error::AppResult;

static IMG_TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)<img\b[^>]*>").expect("valid img tag regex"));
static IMG_HAS_ALT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)"#).expect("valid alt regex")
});
static URL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"https?://([^/\s\"'<>]+)"#).expect("valid url regex"));
static STRIP_TAGS_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<[^>]+>").expect("valid html strip regex"));

const MAX_HTML_BYTES: usize = 102 * 1024;
const MAX_SUBJECT_LENGTH: usize = 60;
const FREE_DOMAINS: &[&str] = &[
    "gmail.com",
    "yahoo.com",
    "yahoo.fr",
    "hotmail.com",
    "hotmail.fr",
    "outlook.com",
    "live.com",
    "live.fr",
    "aol.com",
    "icloud.com",
    "me.com",
    "msn.com",
    "free.fr",
    "orange.fr",
    "sfr.fr",
    "laposte.net",
];
const URL_SHORTENERS: &[&str] = &[
    "bit.ly",
    "tinyurl.com",
    "goo.gl",
    "t.co",
    "ow.ly",
    "buff.ly",
    "dlvr.it",
    "ift.tt",
    "tiny.cc",
    "is.gd",
    "cutt.ly",
];

pub async fn score(state: &State<'_, AppState>, data: Value) -> AppResult<ApiResponse<Value>> {
    let template_ids = data
        .get("template_ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let campaign = data.get("campaign").cloned().unwrap_or_else(|| json!({}));

    let mut results = Vec::new();
    for id_value in template_ids {
        let Some(id) = id_value.as_str() else {
            continue;
        };
        if let Some(template) = crate::commands::templates::load_template(state, id).await? {
            results.push(score_one(&campaign, &serde_json::to_value(template)?));
        }
    }

    if results.len() == 1 {
        Ok(ApiResponse::ok(results.remove(0)))
    } else {
        let avg = if results.is_empty() {
            0
        } else {
            results
                .iter()
                .filter_map(|r| r.get("score").and_then(Value::as_i64))
                .sum::<i64>()
                / results.len() as i64
        };
        Ok(ApiResponse::ok(json!({
            "score": avg,
            "grade": grade(avg as i32),
            "templates": results
        })))
    }
}

fn score_one(campaign: &Value, template: &Value) -> Value {
    let mut total_score = 100i32;
    let mut issues = Vec::new();
    let mut ok = Vec::new();
    let mut warnings = Vec::new();

    let subject = campaign
        .get("subject")
        .and_then(Value::as_str)
        .or_else(|| template.get("subject").and_then(Value::as_str))
        .unwrap_or_default();
    let html = template
        .get("html")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let text = template
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let from_email = campaign
        .get("from_email")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let unsub_url = campaign
        .get("unsubscribe_url")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let subject_analysis = crate::scoring::spam_words::analyze(subject);
    if subject_analysis.0 > 0 {
        let penalty = (subject_analysis.0 as i32 * 10).min(20);
        total_score -= penalty;
        issues.push(json!({
            "severity": if penalty >= 15 { "critical" } else { "warning" },
            "criterion": "spam_subject",
            "message": format!("Spam words detected in subject: {}", subject_analysis.1.iter().take(3).cloned().collect::<Vec<_>>().join(", ")),
            "fix": "Replace aggressive wording with neutral wording.",
            "score_impact": -penalty
        }));
    } else {
        ok.push(
            json!({ "criterion": "spam_subject", "message": "Subject: no spam words detected" }),
        );
    }

    let plain = strip_tags(html);
    let body_analysis = crate::scoring::spam_words::analyze(&plain);
    if body_analysis.0 > 2 {
        let penalty = ((body_analysis.0 as i32 - 2) * 3).min(10);
        total_score -= penalty;
        issues.push(json!({
            "severity": "warning",
            "criterion": "spam_body",
            "message": format!("{} spam-word occurrences in body", body_analysis.0),
            "fix": format!("Review the terms: {}", body_analysis.1.iter().take(3).cloned().collect::<Vec<_>>().join(", ")),
            "score_impact": -penalty
        }));
    } else {
        ok.push(json!({ "criterion": "spam_body", "message": "Body: low spam-word density" }));
    }

    let img_count = html.matches("<img").count();
    let text_length = plain.trim().chars().count();
    if img_count > 0 && text_length < 200 {
        total_score -= 15;
        issues.push(json!({ "severity": "critical", "criterion": "text_image_ratio", "message": format!("Too little text relative to images ({text_length} chars for {img_count} image(s))"), "fix": "Add at least 400 characters of HTML text.", "score_impact": -15 }));
    } else if img_count > 0 && text_length < 400 {
        total_score -= 7;
        issues.push(json!({ "severity": "warning", "criterion": "text_image_ratio", "message": format!("Borderline text/image ratio ({text_length} chars)"), "fix": "Add more text.", "score_impact": -7 }));
    } else {
        ok.push(
            json!({ "criterion": "text_image_ratio", "message": "Acceptable text/image ratio" }),
        );
    }

    let html_size = html.len();
    if html_size > MAX_HTML_BYTES {
        total_score -= 10;
        issues.push(json!({ "severity": "critical", "criterion": "html_size", "message": format!("HTML too large: {:.1}KB", html_size as f64 / 1024.0), "fix": "Gmail clips emails > 102KB. Optimize the HTML.", "score_impact": -10 }));
    } else {
        ok.push(json!({ "criterion": "html_size", "message": format!("HTML size: {:.1}KB (OK)", html_size as f64 / 1024.0) }));
    }

    if text.trim().chars().count() < 100 {
        total_score -= 10;
        issues.push(json!({ "severity": "critical", "criterion": "multipart", "message": "Plain text version missing or too short", "fix": "Add a plain text version.", "score_impact": -10 }));
    } else {
        ok.push(json!({ "criterion": "multipart", "message": "Plain text version present" }));
    }

    if unsub_url.trim().is_empty() {
        total_score -= 15;
        issues.push(json!({ "severity": "critical", "criterion": "unsubscribe", "message": "Unsubscribe URL not configured", "fix": "Configure an unsubscribe URL.", "score_impact": -15 }));
    } else {
        ok.push(json!({ "criterion": "unsubscribe", "message": "Unsubscribe URL configured" }));
    }

    let link_penalty = link_penalty(html, &mut issues);
    total_score -= link_penalty;
    if link_penalty == 0 {
        ok.push(json!({ "criterion": "links", "message": "Links: HTTPS, no shorteners" }));
    }

    let subject_len = subject.chars().count();
    if subject_len > MAX_SUBJECT_LENGTH {
        total_score -= 5;
        issues.push(json!({ "severity": "warning", "criterion": "subject_length", "message": format!("Subject too long: {subject_len} characters"), "fix": "Shorten the subject.", "score_impact": -5 }));
    } else {
        ok.push(json!({ "criterion": "subject_length", "message": format!("Subject length: {subject_len} chars (OK)") }));
    }

    if let Some(domain) = from_email.split('@').nth(1).map(str::to_ascii_lowercase) {
        if FREE_DOMAINS.contains(&domain.as_str()) {
            total_score -= 5;
            issues.push(json!({ "severity": "critical", "criterion": "from_domain", "message": format!("From address on free domain (@{domain})"), "fix": "Use an address on your own domain.", "score_impact": -5, "action_link": "config_dns" }));
        } else {
            ok.push(json!({ "criterion": "from_domain", "message": format!("From: custom domain ({domain})") }));
        }
    }

    // The Rust regex crate does not support look-around, so we count <img>
    // tags first then filter out the ones that already carry an `alt=` attr.
    let img_without_alt = IMG_TAG_RE
        .find_iter(html)
        .filter(|m| !IMG_HAS_ALT_RE.is_match(m.as_str()))
        .count();
    if img_without_alt > 0 {
        warnings.push(json!({ "criterion": "img_alt", "message": format!("{img_without_alt} image(s) without alt attribute"), "fix": "Add alt=\"\" to every image." }));
    }

    let final_score = total_score.clamp(0, 100);
    json!({
        "score": final_score,
        "grade": grade(final_score),
        "issues": issues,
        "ok": ok,
        "warnings": warnings
    })
}

fn link_penalty(html: &str, issues: &mut Vec<Value>) -> i32 {
    let mut shorteners = Vec::new();
    let mut http_links = 0;
    let mut domains = std::collections::BTreeSet::new();
    for cap in URL_RE.captures_iter(html) {
        let url = cap.get(0).map(|m| m.as_str()).unwrap_or_default();
        let domain = cap
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        domains.insert(domain.clone());
        if url.starts_with("http://") {
            http_links += 1;
        }
        for shortener in URL_SHORTENERS {
            if domain.contains(shortener) {
                shorteners.push(*shortener);
            }
        }
    }

    let mut penalty = 0;
    let mut parts = Vec::new();
    if !shorteners.is_empty() {
        penalty += 6;
        parts.push(format!(
            "URL shorteners detected: {}",
            shorteners.join(", ")
        ));
    }
    if http_links > 0 {
        penalty += 2;
        parts.push(format!("{http_links} insecure HTTP link(s)"));
    }
    if domains.len() > 4 {
        penalty += 2;
        parts.push(format!("{} different domains in links", domains.len()));
    }
    let penalty = penalty.min(10);
    if penalty > 0 {
        issues.push(json!({ "severity": if penalty >= 6 { "critical" } else { "warning" }, "criterion": "links", "message": parts.join(" | "), "fix": "Use full HTTPS URLs on your own domain.", "score_impact": -penalty }));
    }
    penalty
}

fn strip_tags(html: &str) -> String {
    STRIP_TAGS_RE.replace_all(html, " ").to_string()
}

fn grade(score: i32) -> Value {
    if score >= 90 {
        json!({ "label": "Excellent", "color": "green-bright" })
    } else if score >= 75 {
        json!({ "label": "Good", "color": "green" })
    } else if score >= 50 {
        json!({ "label": "Needs work", "color": "orange" })
    } else {
        json!({ "label": "Do not send", "color": "red" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn img_without_alt_detection() {
        // The original (?!...) lookahead-based regex would panic at first use;
        // this guards against regressions.
        let html = r#"<img src="a.png"><img src="b.png" alt="hello"><img src='c.png' alt=''>"#;
        let img_no_alt = IMG_TAG_RE
            .find_iter(html)
            .filter(|m| !IMG_HAS_ALT_RE.is_match(m.as_str()))
            .count();
        assert_eq!(img_no_alt, 1);
    }

    #[test]
    fn strip_tags_removes_markup() {
        assert_eq!(strip_tags("<p>hi <b>there</b></p>").trim(), "hi  there");
    }

    #[test]
    fn link_penalty_flags_shorteners_and_http() {
        let html = r#"<a href="http://bit.ly/foo">x</a> <a href="https://example.com">y</a>"#;
        let mut issues = Vec::new();
        let pen = link_penalty(html, &mut issues);
        assert!(pen > 0);
        assert!(!issues.is_empty());
    }

    #[test]
    fn link_penalty_clean_https() {
        let html = r#"<a href="https://example.com">x</a>"#;
        let mut issues = Vec::new();
        assert_eq!(link_penalty(html, &mut issues), 0);
        assert!(issues.is_empty());
    }

    #[test]
    fn grade_thresholds() {
        assert_eq!(grade(95)["label"], "Excellent");
        assert_eq!(grade(80)["label"], "Good");
        assert_eq!(grade(60)["label"], "Needs work");
        assert_eq!(grade(10)["label"], "Do not send");
    }

    #[test]
    fn score_one_full_check_runs() {
        // Triggers every code path of score_one: spam words, image ratio,
        // html size, multipart, unsubscribe, links, subject length, from
        // domain, img alt. This is the regression net for the previous
        // panicking regex.
        let campaign = json!({
            "subject": "GRATUIT !!! cliquez ici maintenant",
            "from_email": "sender@gmail.com",
            "unsubscribe_url": ""
        });
        let template = json!({
            "subject": "x",
            "html": "<p>hi</p><img src=\"a.png\"><a href=\"http://bit.ly/abc\">go</a>",
            "text": ""
        });
        let result = score_one(&campaign, &template);
        assert!(result.get("score").and_then(Value::as_i64).is_some());
        assert!(result.get("issues").and_then(Value::as_array).is_some());
    }
}
