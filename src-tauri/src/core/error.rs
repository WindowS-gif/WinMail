use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Disk error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid CSV: {0}")]
    Csv(#[from] csv::Error),
    #[error("{0}")]
    Validation(String),
    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("DNS: {0}")]
    Dns(String),
    #[error("Security: {0}")]
    Security(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "message")]
pub enum AppErrorDto {
    Io(String),
    Json(String),
    Csv(String),
    Validation(String),
    NotFound(String),

    Dns(String),
    Security(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let dto = match self {
            AppError::Io(e) => AppErrorDto::Io(e.to_string()),
            AppError::Json(e) => AppErrorDto::Json(e.to_string()),
            AppError::Csv(e) => AppErrorDto::Csv(e.to_string()),
            AppError::Validation(e) => AppErrorDto::Validation(e.clone()),
            AppError::NotFound(e) => AppErrorDto::NotFound(e.clone()),

            AppError::Dns(e) => AppErrorDto::Dns(e.clone()),
            AppError::Security(e) => AppErrorDto::Security(e.clone()),
        };
        dto.serialize(serializer)
    }
}

pub type AppResult<T> = Result<T, AppError>;
