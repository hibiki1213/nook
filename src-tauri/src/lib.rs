mod commands;
mod db;
mod files;
mod http;
mod images;
mod mcp;
mod migrate;
mod models;
mod reminders;
mod repo;
mod seed;
mod sync;

/// Initialize the database, run pending schema migrations, and seed the
/// first-run app before the UI starts.
fn bootstrap() -> anyhow::Result<()> {
    let mut conn = db::open()?;
    db::init(&conn)?;
    migrate::run(&mut conn)?;
    seed::seed(&conn)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A failed bootstrap (e.g. the v1→v2 id migration) must stop the app: the
    // code below assumes the new schema, and writing to a half-migrated DB
    // would corrupt it. The error is surfaced in a dialog once Tauri is up.
    let boot_err = bootstrap().err().map(|e| format!("{e:#}"));

    // Local API for the external MCP server (Claude Desktop). Background thread;
    // the app is the sole owner of the database. Not started if bootstrap
    // failed — nothing may touch the old-format DB.
    if boot_err.is_none() {
        std::thread::spawn(http::serve);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Self-update: checks GitHub Releases' latest.json, verified with our
        // minisign public key (see `plugins.updater` in tauri.conf.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Needed to relaunch the app after an update is installed.
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            if let Some(msg) = &boot_err {
                use tauri_plugin_dialog::DialogExt;
                let backup = migrate::backup_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                app.dialog()
                    .message(format!(
                        "データベースの初期化に失敗しました。\n\n{msg}\n\n\
                         移行前のバックアップ: {backup}\n\
                         このままでは安全に続行できないため、アプリを終了します。"
                    ))
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .title("Nook — 起動エラー")
                    .blocking_show();
                std::process::exit(1);
            }

            // Reminder scheduler: OS notifications for due date-fields.
            let handle = app.handle().clone();
            std::thread::spawn(move || reminders::run_scheduler(handle));

            // P2P sync runtime (iroh). Only meaningful once apps are shared;
            // failure to start degrades to an unshared (fully local) app.
            sync::net::start(app.handle().clone());

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
            commands::update_app,
            commands::delete_app,
            commands::list_records,
            commands::create_record,
            commands::update_record,
            commands::delete_record,
            commands::install_mcp,
            commands::import_image,
            commands::get_images_dir,
            commands::import_file,
            commands::get_files_dir,
            commands::due_counts,
            commands::share_preview,
            commands::share_app,
            commands::create_invite,
            commands::join_share,
            commands::leave_share,
            commands::remove_member,
            commands::share_status,
            commands::get_device_name,
            commands::set_device_name,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
