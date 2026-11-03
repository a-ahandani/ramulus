# Ramulus desktop

Ramulus as a desktop app: a Tauri 2 window that runs the native helper from `server` and shows the UI built in `web`. The helper serves on 127.0.0.1 with a per-run token, as the CLI does; the window loads that page, so the frontend is the same build with nothing added.

```sh
cd web && npm ci && npm run build      # the UI, copied to cli/ui
cd ../cli && npm run build
cd ../desktop && npx @tauri-apps/cli@2 build
```

The bundles land in `target/release/bundle` (a `.app` and `.dmg` on macOS, `.msi` and `.exe` on Windows, `.deb` and `.AppImage` on Linux). `npx @tauri-apps/cli@2 dev` opens the window on a debug build that reads the UI straight from `cli/ui`. The bundles are not signed; macOS asks to confirm opening a downloaded one, and a locally built one opens as it is.

The app checks GitHub releases for a newer version a few seconds after launch and every four hours, downloads it in the background and offers a restart. Updates are signed: the public key is in `tauri.conf.json`, and the release workflow needs the matching private key in the `TAURI_SIGNING_PRIVATE_KEY` secret (with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has none). The updater reads `latest.json` from the latest published release, so a draft release becomes an update when it is published.

The app starts with no repository open: pick one from the sidebar, the recent list or the folder picker. On macOS it reads PATH from your login shell so git, gh and your AI agent are found when launched from the Dock.
