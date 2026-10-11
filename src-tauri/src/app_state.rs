use std::path::PathBuf;
use std::sync::Arc;

use crate::campaign::CampaignEngine;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub templates_dir: PathBuf,
    pub campaigns_dir: PathBuf,
    pub uploads_dir: PathBuf,
    pub provider_configs_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            templates_dir: data_dir.join("templates"),
            campaigns_dir: data_dir.join("campaigns"),
            uploads_dir: data_dir.join("uploads"),
            provider_configs_dir: data_dir.join("provider_configs"),
            logs_dir: data_dir.join("logs"),
            data_dir,
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub paths: AppPaths,
    pub engine: Arc<CampaignEngine>,
}

impl AppState {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            engine: Arc::new(CampaignEngine::new()),
        }
    }
}
