use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, Url};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct AppState {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("url error: {0}")]
    Url(#[from] url::ParseError),
    #[error("no available local port found")]
    NoPort,
    #[error("missing main window")]
    MissingWindow,
    #[error("server did not become ready at {0}")]
    ServerNotReady(String),
}

type Result<T> = std::result::Result<T, AppError>;

pub fn run() {
    tauri::Builder::default()
        .manage(AppState { child: Mutex::new(None) })
        .setup(|app| {
            setup_app(app.handle().clone()).map_err(|err| {
                eprintln!("failed to start Pi Agent App: {err}");
                Box::<dyn std::error::Error>::from(err)
            })?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                stop_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Pi Agent App")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                stop_sidecar(app);
            }
        });
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut child) = state.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

fn setup_app(app: tauri::AppHandle) -> Result<()> {
    let ca_bundle = write_system_ca_bundle(&app)?;
    let assets = extract_embedded_assets(&app)?;
    let window = app.get_webview_window("main").ok_or(AppError::MissingWindow)?;
    let Some(node) = find_node() else {
        show_missing_node_page(&window)?;
        return Ok(());
    };
    let port = portpicker::pick_unused_port().ok_or(AppError::NoPort)?;

    let mut command = Command::new(&node);
    command
        .arg(&assets.server)
        .current_dir(&assets.webapp)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_EXTRA_CA_CERTS", ca_bundle.to_string_lossy().to_string())
        .env("SSL_CERT_FILE", ca_bundle.to_string_lossy().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command.spawn()?;
    app.state::<AppState>().child.lock().expect("state poisoned").replace(child);

    let url = format!("http://127.0.0.1:{port}");
    wait_for_server(&url)?;

    window.navigate(Url::parse(&url)?)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

struct ExtractedAssets {
    webapp: PathBuf,
    server: PathBuf,
}

fn extract_embedded_assets(app: &tauri::AppHandle) -> Result<ExtractedAssets> {
    let standalone_root = app.path().app_data_dir()?.join("standalone");
    let cache_name = format!("{}-{}", env!("CARGO_PKG_VERSION"), EMBEDDED_ASSET_ID);
    let root = standalone_root.join(&cache_name);
    let webapp = root.join("webapp");
    let server = webapp.join("server.js");
    if cache_ready(&root, &server) {
        cleanup_old_asset_caches(&standalone_root, &cache_name);
        return Ok(ExtractedAssets { server, webapp });
    }

    fs::create_dir_all(&webapp)?;

    for (relative, bytes) in unpack_embedded_assets()? {
        let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_if_changed(&path, bytes)?;
    }

    fs::write(root.join(".complete"), EMBEDDED_ASSET_ID)?;
    cleanup_old_asset_caches(&standalone_root, &cache_name);

    Ok(ExtractedAssets {
        server,
        webapp,
    })
}

fn cache_ready(root: &Path, server: &Path) -> bool {
    server.is_file()
        && fs::read_to_string(root.join(".complete"))
            .map(|value| value == EMBEDDED_ASSET_ID)
            .unwrap_or(false)
}

fn cleanup_old_asset_caches(standalone_root: &Path, current: &str) {
    let Ok(entries) = fs::read_dir(standalone_root) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy() == current {
            continue;
        }
        let _ = fs::remove_dir_all(path);
    }
}

fn find_node() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("PI_AGENT_NODE") {
        if !path.trim().is_empty() {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates.push(PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
    candidates.push(PathBuf::from("node"));

    candidates.into_iter().find(|candidate| node_works(candidate))
}

fn node_works(candidate: &Path) -> bool {
    let mut command = Command::new(candidate);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.status().map(|status| status.success()).unwrap_or(false)
}

fn show_missing_node_page(window: &tauri::WebviewWindow) -> Result<()> {
    let html = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Node.js Required</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #111827; color: #e5e7eb; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { width: min(560px, calc(100vw - 48px)); padding: 32px; border: 1px solid #374151; border-radius: 18px; background: #0f172a; box-shadow: 0 20px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0 0 14px; line-height: 1.6; color: #cbd5e1; }
      code { color: #93c5fd; }
      a { color: #60a5fa; }
    </style>
  </head>
  <body>
    <main>
      <h1>Node.js is required</h1>
      <p>Pi Agent App did not find Node.js in your environment.</p>
      <p>Please install Node.js 20 or newer, then restart Pi Agent App.</p>
      <p>Recommended: Node.js LTS from <a href="https://nodejs.org/">https://nodejs.org/</a></p>
      <p>If Node is installed in a custom location, set <code>PI_AGENT_NODE</code> to the full Node executable path.</p>
    </main>
  </body>
</html>"#;
    let url = format!("data:text/html;charset=utf-8,{}", percent_encode(html));
    window.navigate(Url::parse(&url)?)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn percent_encode(input: &str) -> String {
    input.bytes().fold(String::new(), |mut out, byte| {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
        out
    })
}

fn unpack_embedded_assets() -> Result<Vec<(&'static str, &'static [u8])>> {
    let mut cursor = EMBEDDED_ASSETS;
    if cursor.len() < 12 || &cursor[..8] != b"PIAPACK1" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid embedded asset pack").into());
    }
    cursor = &cursor[8..];
    let file_count = read_u32(&mut cursor)?;
    let mut files = Vec::with_capacity(file_count as usize);
    for _ in 0..file_count {
        let path_len = read_u32(&mut cursor)? as usize;
        let data_len = read_u64(&mut cursor)? as usize;
        if cursor.len() < path_len + data_len {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated embedded asset pack").into());
        }
        let path = std::str::from_utf8(&cursor[..path_len])
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        let data = &cursor[path_len..path_len + data_len];
        cursor = &cursor[path_len + data_len..];
        files.push((path, data));
    }
    Ok(files)
}

fn read_u32(cursor: &mut &'static [u8]) -> Result<u32> {
    if cursor.len() < 4 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "missing u32").into());
    }
    let (bytes, rest) = cursor.split_at(4);
    *cursor = rest;
    Ok(u32::from_le_bytes(bytes.try_into().expect("slice length checked")))
}

fn read_u64(cursor: &mut &'static [u8]) -> Result<u64> {
    if cursor.len() < 8 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "missing u64").into());
    }
    let (bytes, rest) = cursor.split_at(8);
    *cursor = rest;
    Ok(u64::from_le_bytes(bytes.try_into().expect("slice length checked")))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::read(path).map(|existing| existing == bytes).unwrap_or(false) {
        return Ok(());
    }
    fs::write(path, bytes)?;
    Ok(())
}

fn write_system_ca_bundle(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let path = dir.join("ca-bundle.pem");
    let certs = rustls_native_certs::load_native_certs();
    if !certs.errors.is_empty() {
        for err in &certs.errors {
            eprintln!("failed to load a system certificate: {err}");
        }
    }

    let mut pem = String::new();
    for cert in certs.certs {
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        let encoded = STANDARD.encode(cert.as_ref());
        for chunk in encoded.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).expect("base64 is valid utf8"));
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    fs::write(&path, pem)?;
    Ok(path)
}

fn wait_for_server(url: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(45);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    while Instant::now() < deadline {
        if let Ok(response) = client.get(url).send() {
            if response.status().is_success() || response.status().is_redirection() {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err(AppError::ServerNotReady(url.to_string()))
}
