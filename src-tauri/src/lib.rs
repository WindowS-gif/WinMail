mod app_state;
mod campaign;
mod commands;
mod core;
mod dns;
mod mailer;
mod providers;
mod recipient;
mod scoring;
mod security;
mod storage;
mod template;

use app_state::{AppPaths, AppState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "winmail=info,tauri=info".into()),
        )
        .compact()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let paths = AppPaths::new(data_dir);
            std::fs::create_dir_all(&paths.data_dir)?;
            std::fs::create_dir_all(&paths.templates_dir)?;
            std::fs::create_dir_all(&paths.campaigns_dir)?;
            std::fs::create_dir_all(&paths.uploads_dir)?;
            std::fs::create_dir_all(&paths.provider_configs_dir)?;
            std::fs::create_dir_all(&paths.logs_dir)?;
            if let Err(err) = security::secrets::initialize(&paths.data_dir) {
                tracing::error!("encryption unavailable: {err}");
            }
            // Recover campaigns left "running"/"paused" by a previous session:
            // their in-memory send task is gone, so flip them to "interrupted"
            // so the user can relaunch instead of seeing a frozen "running".
            let reconcile_paths = paths.clone();
            tauri::async_runtime::spawn(async move {
                commands::campaigns::reconcile_orphaned_campaigns(&reconcile_paths).await;
            });
            app.manage(AppState::new(paths));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            commands::legacy_api,
            commands::recipients::save_upload,
            commands::recipients::import_recipient_file,
            commands::recipients::pick_recipient_file,
            commands::recipients::start_upload,
            commands::recipients::append_upload_chunk,
            commands::recipients::finish_upload,
            commands::recipients::abort_upload,
            commands::update::check_for_update,
            commands::update::install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running WinMail Tauri application");
}
