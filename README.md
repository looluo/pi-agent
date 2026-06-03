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

`src-tauri/target/release/pi-agent.exe` is a standalone executable. It can be copied and launched without the installer and without adjacent `resources/` files. It requires Node.js to be installed on the user's system.

macOS output from a macOS build host:

```text
src-tauri/target/release/bundle/macos/pi-agent.app
src-tauri/target/release/bundle/dmg/*.dmg
```

## Runtime Packaging

- The app requires Node.js 20 or newer at runtime.
- If Node.js is not found, the app shows an installation prompt and asks the user to restart after installing Node.js.
- Set `PI_AGENT_NODE` to a full Node executable path when Node.js is installed in a custom location.
- `scripts/build-webapp.mjs` packages the Next.js standalone server under `src-tauri/resources/webapp`.
- `src-tauri/build.rs` embeds the Next.js standalone server into the Tauri executable.
- At runtime, Tauri extracts the embedded web assets into the app data directory on first launch or after the embedded assets change. Later launches reuse the cached `standalone/<version>-<asset-id>/webapp` directory and skip extraction.
- Tauri starts system Node.js with `webapp/server.js` on a random localhost port and opens the desktop window to that URL.

## Corporate CA Certificates

On startup the Rust app reads the OS native root certificate store via `rustls-native-certs`, writes a PEM bundle to the app data directory, and passes it to the Node server through `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`.

If a company proxy replaces external TLS certificates with a company root CA installed in the system trust store, the Node server will trust it through that generated CA bundle.

## Update pi-web

```bash
git subtree pull --prefix=pi-web https://github.com/agegr/pi-web.git main --squash
```

Then rebuild:

```bash
npm run build
```
