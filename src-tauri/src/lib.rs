mod commands;
mod db;
mod http;
mod images;
mod mcp;
mod models;
mod reminders;
mod repo;
mod seed;

/// Initialize the database and seed the first-run app before the UI starts.
fn bootstrap() -> anyhow::Result<()> {
    let conn = db::open()?;
    db::init(&conn)?;
    seed::seed(&conn)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(e) = bootstrap() {
        eprintln!("[nook] database bootstrap failed: {e:#}");
    }

    // Local API for the external MCP server (Claude Desktop). Background thread;
    // the app is the sole owner of the database.
    std::thread::spawn(http::serve);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Reminder scheduler: OS notifications for due date-fields.
            let handle = app.handle().clone();
            std::thread::spawn(move || reminders::run_scheduler(handle));

            // Frosted-glass sidebar (native macOS look). Best-effort.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = window_vibrancy::apply_vibrancy(
                        &win,
                        window_vibrancy::NSVisualEffectMaterial::Sidebar,
                        None,
                        None,
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_apps,
            commands::get_app,
            commands::create_app,
            commands::add_field,
            commands::delete_app,
            commands::list_records,
            commands::create_record,
            commands::update_record,
            commands::delete_record,
            commands::install_mcp,
            commands::import_image,
            commands::get_images_dir,
            commands::due_counts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
