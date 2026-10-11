pub mod api;
pub mod error;

use chrono::{DateTime, Local, Utc};

pub fn now_local_string() -> String {
    let now: DateTime<Local> = Local::now();
    now.format("%Y-%m-%d %H:%M:%S").to_string()
}

pub fn now_utc_rfc3339() -> String {
    let now: DateTime<Utc> = Utc::now();
    now.to_rfc3339()
}

pub fn prefixed_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4())
}
