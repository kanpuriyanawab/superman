#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use arboard::Clipboard;
use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_notification::NotificationExt;

#[derive(Default)]
struct AppState {
    orchestrator: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayCounts {
    active_count: u32,
    needs_me_count: u32,
    blocked_count: u32,
    ready_count: u32,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn superman_home(root: &Path) -> PathBuf {
    root.join(".superman-dev")
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn start_orchestrator_if_needed(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .orchestrator
        .lock()
        .map_err(|_| "Failed to acquire orchestrator state lock.".to_string())?;

    if guard.is_some() {
        return Ok(());
    }

    let root = repo_root();
    let built_entry = root.join("services/orchestrator/dist/index.js");
    let mut command = if built_entry.exists() {
        let mut command = Command::new("node");
        command.arg(built_entry);
        command
    } else {
        let mut command = Command::new("pnpm");
        command
            .arg("--dir")
            .arg(root.as_os_str())
            .arg("--filter")
            .arg("@superman/orchestrator")
            .arg("dev");
        command
    };

    let child = command
        .current_dir(&root)
        .env("SUPERMAN_HOME", superman_home(&root))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to start orchestrator: {error}"))?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn set_tray_counts(app: AppHandle, counts: TrayCounts) -> Result<(), String> {
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "Tray icon is not available.".to_string())?;
    let urgent = counts.needs_me_count + counts.blocked_count;
    let title = if urgent == 0 && counts.ready_count == 0 {
        "S".to_string()
    } else {
        format!(
            "S {}:{}:{}",
            counts.needs_me_count, counts.blocked_count, counts.ready_count
        )
    };
    let tooltip = format!(
        "Superman\nActive sessions: {}\nNeeds input: {}\nBlocked: {}\nReady: {}",
        counts.active_count, counts.needs_me_count, counts.blocked_count, counts.ready_count
    );
    tray.set_title(Some(title)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn notify_urgent(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn copy_to_clipboard(value: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(value).map_err(|error| error.to_string())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('\"', "\\\""))
}

#[tauri::command]
fn open_in_terminal(command: String, cwd: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let shell_command = match cwd {
            Some(cwd) if !cwd.is_empty() => format!("cd {} && {}", shell_quote(&cwd), command),
            _ => command,
        };
        let output = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"Terminal\"")
            .arg("-e")
            .arg("activate")
            .arg("-e")
            .arg(format!("do script {}", applescript_quote(&shell_command)))
            .arg("-e")
            .arg("end tell")
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let message = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "Failed to open Terminal.".to_string()
            };
            return Err(message);
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = cwd;
        let _ = command;
        Err("Open in terminal is currently implemented only for macOS.".to_string())
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Superman", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Superman", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, tauri::tray::TrayIconEvent::Click { .. }) {
                show_main_window(&tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .setup(|app| {
            start_orchestrator_if_needed(app.handle())?;
            build_tray(app.handle()).map_err(|error| error.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_counts,
            notify_urgent,
            copy_to_clipboard,
            open_in_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
