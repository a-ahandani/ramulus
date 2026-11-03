# Ramulus

Super visual Git for vibe coding. Your AI agent writes the code; you see every branch and every change, and decide what lands. Every branch in one graph, editor-grade diffs, and your repositories in a sidebar. No account, no cloud, no telemetry.

```sh
npx ramulus            # in a repository
npx ramulus ~/code/app # or point it at one
npx ramulus ~/code     # or a folder of repositories, each opens in its own tab
```

![The Ramulus branch graph](https://raw.githubusercontent.com/a-ahandani/ramulus/main/docs/screenshots/overview.png)

Options: `--port N` to pick a port, `--no-open` to only print the URL. The package carries a native helper for macOS, Windows and Linux (x64 and arm64) and falls back to the Node helper elsewhere; `RAMULUS_NODE=1` forces the Node one.

- Needs Node 20 or newer and `git` on your PATH. Works on macOS, Windows and Linux.
- Everything runs through your installed git, so SSH keys, credential helpers, hooks and LFS behave exactly as on the command line.
- The server listens on 127.0.0.1 only and every request carries a per-run token, so other pages and other machines cannot reach your repository.
- Commit graph with lanes, branches, tags, stashes, staging with diffs, commit and amend, merge, rebase, cherry-pick, revert, reset, fetch, pull, push, and a banner with Continue and Abort when a merge or rebase stops on conflicts.
- Open several repositories in a left sidebar that stays docked or auto-hides, pin favourites to the top, search them with ⌘⇧A, and pull or fetch all of them at once.
- Rebase with uncommitted changes and undo it afterwards; a rejected push offers rebase, merge or a safe force push.
- A terminal panel built for Claude Code: Shift+Enter or Option+Enter adds a line to the prompt, pasting an image hands it to Claude Code from the clipboard, and rendering runs on the GPU.
- Optional help from the AI agent you already use (Claude Code, Codex, Gemini CLI or opencode), with no API key: draft commit messages and branch names, and run the agent's own interactive tool in a terminal panel (⌃\`) to chat with it or have it fix conflicts. Ramulus asks first and sends nothing until you turn it on.
- A diff view on Monaco that takes the graph's place, where every opened file is a tab, with side-by-side or inline layout, hidden-region folds, an editable working-tree side saved with ⌘S, and block-level stage, unstage and discard; drag a branch label onto a commit to merge or rebase; solo branches; command palette (⌘⇧P); shortcuts list (?); tree or flat file lists with +/− counts; resizable panels; status bar; light and dark themes.

Source: https://github.com/a-ahandani/ramulus
