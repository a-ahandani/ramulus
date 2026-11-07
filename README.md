<img src="site/icon.svg" alt="The Ramulus icon, a stick insect" width="96" height="96" />

# Ramulus

A Git app for when your AI agent writes the code. You see every branch in one graph, review every change as a diff, and decide what gets committed.

It runs on your computer, on top of the git you already have. No account, no cloud, no tracking.

```sh
npx ramulus
```

Run it inside a repository, or give it a path: `npx ramulus ~/code/app`. Point it at a folder full of repositories, like `~/code`, and it offers to open each one. You need Node 20 or newer and git. It works on macOS, Windows and Linux.

Prefer an app? [Download Ramulus](https://github.com/a-ahandani/ramulus/releases/latest) for macOS, Windows or Linux. It updates itself.

![Ramulus in use: Claude Code adding a feature in the agent panel and the change reviewed as a diff, two change blocks staged and the commit message drafted by the agent, a branch dragged onto main to merge it, a remote branch switched to with a double-click, every repository pulled at once, and a color scheme taken from a link](docs/demo.gif)

[Full-quality demo (MP4, 5.6 MB)](https://github.com/a-ahandani/ramulus/raw/main/docs/demo.mp4) · [Website](https://a-ahandani.github.io/ramulus/)

## What you get

- **Every branch in one graph.** Local and remote branches, tags, stashes and your uncommitted work, with how far each branch is ahead or behind. Search commits, or show just one or two branches.
- **Drag to merge.** Drop a branch on a commit to merge or rebase it. Right-click anything to check it out, cherry-pick, revert, reset, rename or delete.
- **Diffs you can work in.** They're built on Monaco, the editor inside VS Code. Stage or discard one block of changes at a time, edit the file right there, and save with ⌘S.
- **All your repositories in a sidebar.** Each one shows its branch, its changes and what it needs to push or pull. Pull or fetch all of them at once.
- **Pull requests and CI.** Read a pull request's comments and checks, and merge it, through the GitHub CLI you're already signed in to. Each pushed commit shows how its GitHub Actions run went.
- **Pick up where you left off.** Close Ramulus and open it again: same projects, same terminal tabs, same Claude Code conversations.
- **Your colors.** Light, dark, or any scheme from [terminalcolors.com](https://terminalcolors.com/). Paste its link and the whole app follows.

![The branch graph of a repository with local and remote branches, two tags, a stash and uncommitted changes, with a commit selected and its changed file listed](docs/screenshots/overview.png)

## Your AI agent, if you want one

Ramulus finds Claude Code, Codex, Gemini CLI or opencode on your computer and asks before using any of them. Each one uses its own sign-in, so there's no API key to set up.

- Press ⌃\` to open the agent panel under the graph and chat with it, just like in your own terminal. Open more tabs for other agents or a plain shell.
- Everything the agent edits shows up as a change for you to review before you commit.
- One click drafts a commit message or a branch name, ready for you to edit.
- Stuck on a merge conflict? One click hands the file to your agent with a prompt you can change first.
- Claude Code tabs are named after the conversation, and a mark tells you when one finishes while you're looking elsewhere.
- Terminal tabs stay alive in the background, so switching between them is instant.

![Claude Code in the agent panel below the graph, summarising the change it just made](docs/screenshots/agent.png)

## Private by default

- Ramulus only listens on 127.0.0.1, and every request needs a token that's new each time it starts.
- It uses your own git, so SSH keys, credential helpers, hooks and LFS work exactly as they do in your terminal.
- Nothing leaves your computer unless you ask for it: your git remotes, avatars from Gravatar and GitHub, GitHub pull requests and Actions through `gh`, and your AI agent if you turn it on.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘⇧P` | Command palette: every action, branch and tag |
| `⌘F` | Search commits |
| `⌘⇧A` | Search your repositories |
| `⌘⏎` | Commit |
| `⌘B` | New branch |
| `` ⌃` `` | Show or hide the agent panel |
| `?` | All shortcuts |

On Windows and Linux, use Ctrl for ⌘ and Alt for ⌥.

## In the browser

[Ramulus in the browser](https://a-ahandani.github.io/ramulus/app/) needs nothing installed. It runs git in JavaScript, so it's slower, works only in Chromium browsers like Chrome and Edge, can't use SSH, and leaves out rebase, cherry-pick and revert. More in `web/README.md`.

## Develop

```sh
cd web && npm install && npm run dev   # the UI with hot reload
npm test                               # in web/ and cli/
cargo test                             # in server/
```

`npm run dev` opens this repository. Set `RAMULUS_REPO=/path/to/repo` to open another one, ideally a scratch copy, since Discard and Save change real files. Design notes are in `docs/ux.md`, and how the desktop app is built is in `desktop/README.md`.

To release, bump the version in `server/Cargo.toml`, `desktop/src-tauri/Cargo.toml`, `desktop/src-tauri/tauri.conf.json` and `cli/package.json`, along with `Cargo.lock` and `cli/package-lock.json`. Push that to main, then push the tags `cli-vX.Y.Z` and `desktop-vX.Y.Z`. CI runs the tests and publishes to npm. The desktop release starts as a draft; publish it once its builds pass.

Ramulus is Latin for a small branch.

## License

MIT. Third-party components and their licenses are listed in `THIRD-PARTY-NOTICES.md`.
