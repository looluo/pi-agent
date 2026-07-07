# Patch-based pi-web customization

Auto-session-title and other pi-web behavior changes live in
`patches/pi-web/*.patch` (plus string-marker replacements in
`scripts/build-webapp.mjs`) and are applied to a throwaway build copy, never
edited directly in `pi-web/`.

`pi-web/` is a git subtree from `https://github.com/agegr/pi-web.git` and must
stay byte-identical to upstream so subtree pulls remain conflict-free.
Submitting these changes upstream is not viable for opinionated desktop-wrapper
behavior (Tauri directory picker, app title, auto-session-title). The patch
strategy keeps customization portable across upstream releases at the cost of
merge fragility — if upstream renames a symbol or restructures a file the
patch hunks target, the build breaks and the patch must be rebased.

When adding new customization, prefer string-marker replacement in
`build-webapp.mjs` for small inserts and a new `.patch` file for larger
features. Never edit `pi-web/` sources directly.
