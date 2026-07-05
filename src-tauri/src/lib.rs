mod commands;
mod db;
mod http;
mod images;
mod mcp;
mod models;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
