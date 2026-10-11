use std::collections::HashMap;

use once_cell::sync::Lazy;
use rand::distr::{Alphanumeric, SampleString};
use rand::Rng;
use regex::{Captures, Regex};

use crate::commands::templates::Template;

static RANDOM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\{\{?(RANDNUM|RANDALPHANUM|RANDALPHA)-(\d+)\}?\}").expect("valid random regex")
});
static DOUBLE_VAR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\{\{(\w+)\}\}").expect("valid double var regex"));
static SINGLE_VAR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\{(\w+)\}").expect("valid single var regex"));

pub fn personalize_string(
    content: &str,
    data: &HashMap<String, String>,
    template: Option<&Template>,
    email_index0: usize,
) -> String {
    let merged = merge_template_vars(data, template, email_index0);
    let with_random = RANDOM_RE.replace_all(content, |caps: &Captures<'_>| {
        let kind = caps
            .get(1)
            .map(|m| m.as_str().to_ascii_uppercase())
            .unwrap_or_default();
        let len = caps
            .get(2)
            .and_then(|m| m.as_str().parse::<usize>().ok())
            .unwrap_or(6)
            .clamp(1, 128);
        match kind.as_str() {
            "RANDNUM" => random_number(len),
            "RANDALPHA" => random_alpha(len),
            "RANDALPHANUM" => Alphanumeric.sample_string(&mut rand::rng(), len),
            _ => caps
                .get(0)
                .map(|m| m.as_str())
                .unwrap_or_default()
                .to_string(),
        }
    });

    let with_double = replace_vars(&DOUBLE_VAR_RE, &with_random, &merged);
    let with_single = replace_vars(&SINGLE_VAR_RE, &with_double, &merged);
    replace_dates(&with_single)
}

fn merge_template_vars(
    data: &HashMap<String, String>,
    template: Option<&Template>,
    email_index0: usize,
) -> HashMap<String, String> {
    let mut merged = data.clone();
    if let Some(template) = template {
        let urls: Vec<_> = template
            .rotate_urls
            .iter()
            .map(|u| u.trim())
            .filter(|u| !u.is_empty())
            .collect();
        if !urls.is_empty() {
            let every = template.rotate_url_every.max(1);
            let index = (email_index0 / every) % urls.len();
            let picked = urls[index].to_string();
            merged.insert("rotate_url".to_string(), picked.clone());
            merged.insert("url_rotate".to_string(), picked);
        }
    }
    merged
}

fn replace_vars(re: &Regex, content: &str, data: &HashMap<String, String>) -> String {
    re.replace_all(content, |caps: &Captures<'_>| {
        let key = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        find_case_insensitive(data, key)
            .cloned()
            .unwrap_or_else(|| {
                caps.get(0)
                    .map(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string()
            })
    })
    .to_string()
}

fn find_case_insensitive<'a>(data: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    let wanted = key.to_ascii_lowercase();
    data.iter()
        .find(|(k, _)| k.to_ascii_lowercase() == wanted)
        .map(|(_, v)| v)
}

fn replace_dates(content: &str) -> String {
    let now = chrono::Local::now();
    content
        .replace("{{date}}", &now.format("%d/%m/%Y").to_string())
        .replace("{{time}}", &now.format("%H:%M").to_string())
        .replace("{{datetime}}", &now.format("%d/%m/%Y %H:%M").to_string())
        .replace("{date}", &now.format("%d/%m/%Y").to_string())
        .replace("{time}", &now.format("%H:%M").to_string())
        .replace("{datetime}", &now.format("%d/%m/%Y %H:%M").to_string())
}

fn random_number(len: usize) -> String {
    let mut rng = rand::rng();
    let mut out = String::with_capacity(len);
    for i in 0..len {
        let start = if i == 0 && len > 1 { 1 } else { 0 };
        out.push(char::from(b'0' + rng.random_range(start..=9)));
    }
    out
}

fn random_alpha(len: usize) -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ALPHA[rng.random_range(0..ALPHA.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_variables() {
        let data = HashMap::from([("prenom".to_string(), "Alex".to_string())]);
        assert_eq!(
            personalize_string("Bonjour {{prenom}}", &data, None, 0),
            "Bonjour Alex"
        );
    }

    /// Vérifie que les URLs d'images https:// dans les templates HTML sont
    /// préservées telles quelles par le moteur de personnalisation.
    /// Le rendu visuel de ces images dépend du CSP de l'application (img-src https:).
    #[test]
    fn preserves_https_image_urls() {
        let data = HashMap::from([("nom".to_string(), "Dupont".to_string())]);
        let html =
            "<img src=\"https://cdn.example.com/banner.jpg\" alt=\"Banner\"> Bonjour {{nom}}";
        let result = personalize_string(html, &data, None, 0);
        assert!(
            result.contains("https://cdn.example.com/banner.jpg"),
            "L'URL https de l'image doit être préservée intacte"
        );
        assert!(
            result.contains("Bonjour Dupont"),
            "Les variables doivent être remplacées correctement"
        );
    }

    #[test]
    fn preserves_full_html_document_with_images() {
        let data = HashMap::from([("prenom".to_string(), "Marie".to_string())]);
        let html = concat!(
            "<!DOCTYPE html><html><body>",
            "<img src=\"https://img.host.com/logo.png\">",
            "<p>Salut {{prenom}}</p></body></html>"
        );
        let result = personalize_string(html, &data, None, 0);
        assert!(result.contains("https://img.host.com/logo.png"));
        assert!(result.contains("Salut Marie"));
    }
}
