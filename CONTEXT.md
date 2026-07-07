# Pi Agent

Tauri desktop wrapper around the vendored Next.js app in `pi-web/`. The wrapper
adds Tauri-native integration (directory picker, root CA export, embedded
asset caching) and a small set of behavior patches layered on top of upstream
pi-web via `scripts/build-webapp.mjs`.

## Language

**Session Name**
The `name` field of a `session_info` entry in a pi session `.jsonl` file. A
session has at most one name. Sourced three ways:
1. Empty (default) — the sidebar shows the **Fallback Title** instead.
2. Auto-generated — set by the `generate-title` route after the first prompt
   completes (the auto-session-title feature).
3. User-set — set via the `set_session_name` agent command.

_Avoid_: title, summary, label

**Fallback Title**
What the sidebar displays when a session has no **Session Name**: the session's
first user message, truncated. Not stored — computed at display time.

_Avoid_: default name, preview
