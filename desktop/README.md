# Ramulus desktop

Ramulus as a desktop app: a Tauri 2 window that runs the native helper from `server` and shows the UI built in `web`. The helper serves on 127.0.0.1 with a per-run token, as the CLI does; the window loads that page, so the frontend is the same build with nothing added.

```sh
cd web && npm ci && npm run build      # the UI, copied to cli/ui
cd ../cli && npm run build
cd ../desktop && npx @tauri-apps/cli@2 build
```

The bundles land in `target/release/bundle` (a `.app` and `.dmg` on macOS, `.msi` and `.exe` on Windows, `.deb` and `.AppImage` on Linux). `npx @tauri-apps/cli@2 dev` opens the window on a debug build that reads the UI straight from `cli/ui`. On macOS the app must be signed with a Developer ID, or a downloaded copy is refused as damaged: set `APPLE_SIGNING_IDENTITY` to the certificate's name when building (it also signs the DMG), and the release workflow does the same from the `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY` secrets. Notarization, which lets the app open without a warning, happens in the same build when `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID` are set too. Windows and Linux bundles are unsigned.

The app checks GitHub releases for a newer version a few seconds after launch and every four hours, downloads it in the background and offers a restart. Updates are signed: the public key is in `tauri.conf.json`, and the release workflow needs the matching private key in the `TAURI_SIGNING_PRIVATE_KEY` secret (with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has none). The updater reads `latest.json` from the latest published release, so a draft release becomes an update when it is published.

The app starts with no repository open: pick one from the sidebar, the recent list or the folder picker. On macOS it reads PATH from your login shell so git, gh and your AI agent are found when launched from the Dock.
