// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;

/// The window is useless without the gateway behind it: a user who launches
/// the app without a terminal used to see a live-looking console that could
/// answer nothing. If the gateway socket is missing and this binary was
/// built from a checkout that still exists, start the gateway from there.
/// The child is detached on purpose: the gateway serves the mobile
/// companion too and should outlive the window.
fn ensure_gateway(socket_path: &PathBuf) {
    if socket_path.exists() {
        return;
    }
    // Baked at build time; a relocated app without its checkout just shows
    // the honest disconnected state instead of spawning nonsense.
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../");
    if !repo_root.join("src/cli.ts").exists() {
        return;
    }
    let run_dir = socket_path.parent().map(|dir| dir.to_path_buf());
    if let Some(dir) = run_dir {
        let _ = std::fs::create_dir_all(&dir);
    }
    let log_path = env::var("HOME")
        .map(|home| PathBuf::from(home).join(".dokkabi/run/desktop-gateway-stdout.log"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/dokkabi-desktop-gateway.log"));
    if let Ok(log) = std::fs::File::create(&log_path) {
        let _ = std::process::Command::new("bun")
            .arg("src/cli.ts")
            .arg("desktop")
            .current_dir(&repo_root)
            .stdout(log.try_clone().expect("stdout log clone"))
            .stderr(log)
            .spawn();
    }
    // Boot takes a moment (plugins, sandbox attestation); the client retries
    // the websocket anyway, so this only smooths the first paint.
    for _ in 0..75 {
        if socket_path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

struct AppState {
    socket_path: PathBuf,
    gateway_http_url: String,
}

#[tauri::command]
async fn get_gateway_url(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    Ok(state.gateway_http_url.clone())
}

#[tauri::command]
async fn send_rpc(
    method: String,
    params: Value,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    // The socket protocol lives in the tauri-free gateway-rs crate so it is
    // compiled and unit-tested on machines the Tauri shell cannot build on.
    // One request, one response line: notifications (terminal output,
    // approval pushes) stream on the authenticated websocket instead.
    //
    // Blocking std sockets, not tokio: an async tokio::net::UnixStream read
    // deadlocked in this command context on macOS 26 (connect and write
    // completed; the reactor never woke the pending read, so the invoke
    // promise never settled and the UI hung before ever opening its
    // websocket). spawn_blocking needs no reactor.
    let socket_path = state.socket_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        dokkabi_gateway_client::round_trip(&socket_path, &method, params)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn main() {
    let home = env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let socket_path = PathBuf::from(format!("{}/.dokkabi/run/dokkabi-desktop.sock", home));
    let gateway_port = env::var("DOKKABI_DESKTOP_PORT").unwrap_or_else(|_| "4174".into());
    let gateway_http_url = format!("http://127.0.0.1:{}", gateway_port);

    ensure_gateway(&socket_path);

    let state = Arc::new(AppState {
        socket_path,
        gateway_http_url,
    });

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_gateway_url, send_rpc])
        .run(tauri::generate_context!())
        .expect("error while running dokkabi desktop application");
}
