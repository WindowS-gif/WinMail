use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct LegacyAction {
    pub name: String,
    pub params: HashMap<String, String>,
}

impl LegacyAction {
    pub fn parse(raw: &str) -> Self {
        let mut parts = raw.split('&');
        let name = parts.next().unwrap_or_default().to_string();
        let mut params = HashMap::new();
        for part in parts {
            if part.is_empty() {
                continue;
            }
            let mut kv = part.splitn(2, '=');
            let key = kv.next().unwrap_or_default().to_string();
            let value = kv.next().unwrap_or_default().to_string();
            params.insert(key, value);
        }
        Self { name, params }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.params.get(key).map(String::as_str)
    }

    pub fn has_flag(&self, key: &str) -> bool {
        self.params.contains_key(key)
    }
}
