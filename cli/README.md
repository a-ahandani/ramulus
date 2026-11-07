# Ramulus

A Git app for when your AI agent writes the code. See every branch in one graph, review every change as a diff, and decide what gets committed. It runs on your computer, on top of your own git. No account, no cloud, no tracking.

```sh
npx ramulus            # in a repository
npx ramulus ~/code/app # or point it at one
npx ramulus ~/code     # or a folder of repositories
```

![The Ramulus branch graph](https://raw.githubusercontent.com/a-ahandani/ramulus/main/docs/screenshots/overview.png)

- Needs Node 20 or newer and git. Works on macOS, Windows and Linux.
- Every branch, tag and stash in one graph. Drag a branch onto a commit to merge or rebase it.
- Diffs built on Monaco, the editor inside VS Code. Stage or discard one block at a time, or edit and save right there.
- All your repositories in a sidebar. Pull or fetch all of them at once.
- Pull requests, checks and GitHub Actions, through the `gh` CLI you're already signed in to.
- Optional help from Claude Code, Codex, Gemini CLI or opencode: commit messages, branch names, and a terminal panel (⌃\`) to chat with your agent. Ramulus asks before using one.
- Close it and open it again: your projects, terminal tabs and Claude Code conversations come back.
- It listens on 127.0.0.1 only, with a new token each time it starts, and uses your own git, so SSH keys, hooks and LFS just work.

Options: `--port N` picks the port, and `--no-open` only prints the URL. The package ships a native helper for macOS, Windows and Linux (x64 and arm64) and falls back to a Node one elsewhere. Set `RAMULUS_NODE=1` to use the Node one anyway.

Screenshots, the desktop app and the source: https://github.com/a-ahandani/ramulus
