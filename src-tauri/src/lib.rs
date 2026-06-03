use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
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
        .invoke_handler(tauri::generate_handler![window_control])
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

#[tauri::command]
fn window_control(window: tauri::WebviewWindow, action: String) -> std::result::Result<(), String> {
    apply_window_action(&window, &action)
}

fn apply_window_action(window: &tauri::WebviewWindow, action: &str) -> std::result::Result<(), String> {
    match action {
        "minimize" => window.minimize().map_err(|err| err.to_string()),
        "maximize" => {
            if window.is_maximized().map_err(|err| err.to_string())? {
                window.unmaximize().map_err(|err| err.to_string())
            } else {
                window.maximize().map_err(|err| err.to_string())
            }
        }
        "drag" => window.start_dragging().map_err(|err| err.to_string()),
        "close" => window.close().map_err(|err| err.to_string()),
        _ => Err(format!("unknown window action: {action}")),
    }
}

fn start_control_server(app: tauri::AppHandle) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_control_request(&app, stream);
        }
    });
    Ok(port)
}

fn handle_control_request(app: &tauri::AppHandle, mut stream: TcpStream) {
    let mut buffer = [0_u8; 1024];
    let Ok(read) = stream.read(&mut buffer) else { return; };
    let request = String::from_utf8_lossy(&buffer[..read]);
    let action = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|path| path.split("action=").nth(1))
        .map(|value| value.split(&['&', ' '][..]).next().unwrap_or(value))
        .unwrap_or("");

    let status = if let Some(window) = app.get_webview_window("main") {
        apply_window_action(&window, action).map(|_| "204 No Content").unwrap_or("400 Bad Request")
    } else {
        "404 Not Found"
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(response.as_bytes());
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
    let port = portpicker::pick_unused_port().ok_or(AppError::NoPort)?;
    let control_port = start_control_server(app.clone())?;

    let mut command = Command::new(&assets.node);
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

    let url = format!("http://127.0.0.1:{port}?tauriControlPort={control_port}");
    wait_for_server(&url)?;

    let window = app.get_webview_window("main").ok_or(AppError::MissingWindow)?;
    #[cfg(windows)]
    window.set_decorations(false)?;
    window.navigate(Url::parse(&url)?)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

struct ExtractedAssets {
    node: PathBuf,
    webapp: PathBuf,
    server: PathBuf,
}

fn extract_embedded_assets(app: &tauri::AppHandle) -> Result<ExtractedAssets> {
    let root = app.path().app_data_dir()?.join("standalone").join(env!("CARGO_PKG_VERSION"));
    let webapp = root.join("webapp");
    fs::create_dir_all(&webapp)?;

    for (relative, bytes) in unpack_embedded_assets()? {
        let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        write_if_changed(&path, bytes)?;
    }

    let node = root.join(if cfg!(windows) { "pi-agent-node.exe" } else { "pi-agent-node" });
    let extracted_node = root.join("node").join(if cfg!(windows) { "pi-agent-node.exe" } else { "pi-agent-node" });
    if extracted_node != node {
        write_if_changed(&node, &fs::read(&extracted_node)?)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&node)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&node, permissions)?;
    }

    Ok(ExtractedAssets {
        server: webapp.join("server.js"),
        webapp,
        node,
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
