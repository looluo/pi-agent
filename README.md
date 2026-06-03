# Pi Agent App

Desktop wrapper for the Pi Agent web UI, packaged with Tauri.

The upstream web UI is vendored in `pi-web/` via git subtree. Build scripts create a temporary copy of `pi-web`, change the page title to `Pi Agent App`, enable Next.js standalone output, and package the standalone server into the desktop app.

## Build

```bash
npm install
npm run build
```

Windows output:

```text
src-tauri/target/release/pi-agent.exe
src-tauri/target/release/bundle/nsis/pi-agent_0.1.0_x64-setup.exe
```

`src-tauri/target/release/pi-agent.exe` is a standalone executable. It can be copied and launched without the installer and without adjacent `resources/` or `pi-agent-node.exe` files.

macOS output from a macOS build host:

```text
src-tauri/target/release/bundle/macos/pi-agent.app
src-tauri/target/release/bundle/dmg/*.dmg
```

## Runtime Packaging

- The app does not require an external Node.js installation.
- `scripts/download-node.mjs` downloads Node.js for the build target.
- `scripts/build-webapp.mjs` packages the Next.js standalone server under `src-tauri/resources/webapp`.
- `src-tauri/build.rs` embeds Node.js and the Next.js standalone server into the Tauri executable.
- At runtime, Tauri extracts the embedded assets into the app data directory, starts the extracted Node runtime with `webapp/server.js` on a random localhost port, and opens the desktop window to that URL.

## Corporate CA Certificates

On startup the Rust app reads the OS native root certificate store via `rustls-native-certs`, writes a PEM bundle to the app data directory, and passes it to the Node sidecar through `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.

If a company proxy replaces external TLS certificates with a company root CA installed in the system trust store, the bundled Node server will trust it without requiring a separate Node installation.

## Update pi-web

```bash
git subtree pull --prefix=pi-web https://github.com/agegr/pi-web.git main --squash
```

Then rebuild:

```bash
npm run build
```
