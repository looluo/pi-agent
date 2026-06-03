use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    io,
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, Url};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct AppState {
    child: Mutex<Option<CommandChild>>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("shell error: {0}")]
    Shell(#[from] tauri_plugin_shell::Error),
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
        .plugin(tauri_plugin_shell::init())
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
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

fn setup_app(app: tauri::AppHandle) -> Result<()> {
    let ca_bundle = write_system_ca_bundle(&app)?;
    let port = portpicker::pick_unused_port().ok_or(AppError::NoPort)?;
    let server = app
        .path()
        .resolve("resources/webapp/server.js", tauri::path::BaseDirectory::Resource)?;

    let mut command = app
        .shell()
        .sidecar("pi-agent-node")?
        .args([server.to_string_lossy().to_string()])
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_EXTRA_CA_CERTS", ca_bundle.to_string_lossy().to_string())
        .env("SSL_CERT_FILE", ca_bundle.to_string_lossy().to_string());

    if let Some(parent) = server.parent() {
        command = command.current_dir(parent);
    }

    let (mut rx, child) = command.spawn()?;
    app.state::<AppState>().child.lock().expect("state poisoned").replace(child);

    thread::spawn(move || {
        while let Some(event) = rx.blocking_recv() {
            eprintln!("pi-agent-node: {event:?}");
        }
    });

    let url = format!("http://127.0.0.1:{port}");
    wait_for_server(&url)?;

    let window = app.get_webview_window("main").ok_or(AppError::MissingWindow)?;
    window.navigate(Url::parse(&url)?)?;
    window.show()?;
    window.set_focus()?;
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
