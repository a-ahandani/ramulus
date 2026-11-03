# Ramulus server

The Ramulus helper in Rust: the same HTTP API, token scheme, event streams and terminal sessions as `cli/lib`, serving the UI built in `web`. The frontend talks to it without changes.

```sh
cd web && npm ci && npm run build          # the UI, copied to cli/ui
cd ../server && cargo build --release
./target/release/ramulus ~/code/app --ui ../cli/ui
```

Options are the CLI's: `[path] [--port N] [--no-open]`, plus `--ui DIR` when the `ui` folder is not beside the binary. Run `cargo test` in this folder for the port of the CLI test suite; it needs `git` on the PATH.

Everything still runs through the installed `git`, so hooks, SSH keys, credential helpers and LFS behave as on the command line.
