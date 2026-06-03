# Pi Agent App

Desktop wrapper for the Pi Agent web UI, packaged with Tauri.

The upstream web UI is vendored in `pi-web/` via git subtree.

## Update pi-web

```bash
git subtree pull --prefix=pi-web https://github.com/agegr/pi-web.git main --squash
```

## Build

```bash
npm install
npm run build
```
