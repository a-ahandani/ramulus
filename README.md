<img src="site/icon.svg" alt="The Ramulus icon, a stick insect" width="96" height="96" />

# Ramulus

Super visual Git for vibe coding. Your AI agent writes the code; you see every branch and every change, and decide what lands. A local-first Git GUI with every branch in one graph, editor-grade diffs and your repositories in a sidebar. No account, no cloud, no telemetry.

```sh
npx ramulus
```

Run it inside any git repository, or pass a path: `npx ramulus ~/code/app`. Run it in a folder that holds several repositories, such as `~/code`, and it offers to open each one in the sidebar. Run it in a repository that has others in its subfolders, and it offers those too. Ramulus starts a small server on 127.0.0.1 on top of the `git` you already have and opens the UI in your browser. It needs Node 20 or newer and `git`, and works on macOS, Windows and Linux.

![Ramulus in use: Claude Code adding a feature in the agent panel and the change reviewed as a diff, two change blocks staged and the commit message drafted by the agent, a branch dragged onto main to merge it, a remote branch switched to with a double-click, every repository pulled at once, and a color scheme taken from a link](docs/demo.gif)

[Download the demo in full quality (MP4, 5.6 MB)](https://github.com/a-ahandani/ramulus/raw/main/docs/demo.mp4) · [Website](https://a-ahandani.github.io/ramulus/)

## Why Ramulus

- **Visual control while your agent codes.** Let Claude Code, Codex, Gemini CLI or opencode write the code in a panel beside the graph. Every edit shows up as a diff and every branch as a lane, so you review what it did and choose what to stage and commit.
- **Your git, unchanged.** Every operation runs through the git binary you already use, so SSH keys, credential helpers, hooks and LFS behave exactly as they do in the terminal.
- **Nothing leaves your machine unless you ask.** The server listens on 127.0.0.1 and every request carries a per-run token. The only outside requests are your own git remotes, avatar lookups on gravatar.com, pull request lookups through the GitHub CLI when you have it installed, the images, videos and avatars of a pull request you open, which load only from GitHub's own hosts, and, if you turn it on, the AI agent you already use.
- **One command.** No installer, no sign-in, no license key. Close the terminal and it is gone.

Ramulus is Latin for a small branch.

## Features

### History you can read

![The branch graph of a repository with local and remote branches, two tags, a stash and uncommitted changes, with a commit selected and its changed file listed](docs/screenshots/overview.png)

- A lane graph with merge, stash and work-in-progress nodes, author avatars on the nodes, and one label per branch with ahead and behind counts against its upstream.
- Search commits by message, author, hash or ref. Solo one or two branches to see only their history.
- The checked-out branch is a solid label with a check mark, sits first in the branch list, and is a chip in the toolbar that switches branches.
- Double-click a remote branch to switch to its local branch and bring it up to date. Your uncommitted changes come along, and a branch with commits of its own is switched to but never rewritten.
- Drag a branch label onto a commit to merge or rebase. A lifted copy follows the pointer and says what the drop will do, the graph scrolls at its edges, and Esc cancels. Right-click any commit, branch, tag or stash for checkout, new branch, tag, cherry-pick, revert, reset, rename and delete.
- Fetch, pull and push. Pull fast-forwards, and when both sides have new commits it asks whether to rebase or merge. When a merge or rebase stops on conflicts, a banner offers Continue and Abort.
- Delete the branches whose pull request merged in one step, here and optionally on the remote. Only branches still at exactly the merged commit are offered.

### Diffs and staging

![A diff window beside the commit box, with two change blocks staged and a commit message drafted by the AI agent](docs/screenshots/diff.png)

- Every file you click opens as a tab in one diff view that takes the graph's place beside the left panel, or maximize it over the left panel too. The graph stays one click away as the first tab. Unchanged regions are collapsed until you open them, and a diff opens at its first change.
- Review every change of the working tree, the index or a commit in one tab, as one scrolling list of diffs with the stage and discard toolbar on each block.
- The left panel has four tabs: Branches, Changes (always the commit box and the working tree), Commit (the commit selected in the graph) and Files, which shows the whole working tree with changed files marked. Commit & push commits and pushes in one go. A file opened from Files opens in a plain editor instead of a diff.
- The diff runs on Monaco, the open-source editor component: side by side or inline, a +/− gutter, folded unchanged regions, syntax highlighting and word wrap.
- Stage, unstage or discard one change block from the small toolbar beside it. Edit the working-tree side and save with ⌘S.
- Staging writes whole file contents rather than patches, so line endings and byte-order marks survive exactly. If a file changed underneath you, the write is refused instead of guessed.

### Repositories in tabs

![Four repositories in the sidebar, in the Catppuccin Latte color scheme taken from a terminalcolors.com link](docs/screenshots/light.png)

- Open several repositories at once from recent repositories, the system folder picker, a typed path, or the repositories found in the folder you started from. They live in a left sidebar that stays docked or auto-hides, with pinned repositories at the top and ⌘⇧A to search. Each one shows its branch, its uncommitted changes and what it has to push or pull. Each one keeps its own selection, filters and draft commit message.
- Pull all (fast-forward only) and Fetch all update every open repository, three at a time so the app stays responsive.
- Branches with a pull request on GitHub show its number. Click it to open the pull request in Ramulus: description with its images and videos, checks (refreshing while they run), and one timeline of comments, reviews and review threads, each thread shown with the lines of code it is about, with GitHub's Merge options (merge commit, squash, rebase). Resolved threads and bot comments fold away. It all goes through the GitHub CLI (`gh`) you are already signed in to, what GitHub sends is sanitized, media loads only from GitHub's own hosts so tracking pixels stay out, and Ramulus fetches after a merge so it shows in the graph.
- Rebase with uncommitted changes: they are stashed and put back for you, and the rebase can be undone afterwards. A rejected push offers rebase, merge or a safe force push instead of an error.
- Drag a project in the sidebar to reorder it, or press ⌥↑ and ⌥↓. Rest the pointer on one to see its agent and terminal tabs, and click one to jump straight to it.
- A folder without git opens too, with its terminals and agent, and a button to start a repository in it.
- Quit and reopen Ramulus and you are where you left off: the same projects in the same order, each terminal tab with what it printed, and every Claude Code tab resuming its own conversation.
- Only the visible tab watches its folder, so hidden tabs cost nothing and catch up when you come back.
- Light and dark themes, or any color scheme from [terminalcolors.com](https://terminalcolors.com/): paste the link of its page and the whole app, the diff and the agent terminal take its colors.
- Resizable panels, tree or flat file lists with +/− counts, and a status bar with sync, change and stash counts and a refresh button.

### Your AI agent, if you want one

![Claude Code in the agent panel below the graph, summarising the change it just made](docs/screenshots/agent.png)

- Ramulus looks for Claude Code, Codex, Gemini CLI and opencode on your PATH and asks before using any of them. Pick one if several are installed. Each uses its own sign-in, so there is no API key to add.
- The sparkle in the commit box drafts a message from the staged changes, and the one in the new-branch dialog suggests a name. Both fill the field for you to review and edit.
- The Agent button in the top bar (or ⌃\`) opens a panel at the bottom that runs the agent's own interactive tool in the repository's folder, so you can chat with it as you would in your own terminal. Add more tabs with +, for another agent or a plain terminal, and maximize the panel when you want the whole window. The sparkle on a conflicted file pastes a resolve prompt into it without sending it, so you can change it first. The agent then edits the file with its own approvals, and the result shows up as an unstaged change for you to review.
- Each agent tab is named after the conversation, the way Claude Code titles its terminal, with a spinner while it works. When one finishes while you are elsewhere, its project in the sidebar and the Agent button get a mark until you look.
- Every prompt can be edited in AI agent settings in the command palette.

### Keyboard

| Keys | Action |
| --- | --- |
| `⌘⇧P` | Command palette: every action, branch and tag |
| `⌘F` | Search commits |
| `⌘⇧A` | Search open and recent repositories |
| `⌥↑` / `⌥↓` | Move a project in the sidebar |
| `↑` `↓` or `J` `K` | Move through commits |
| `⌘⏎` | Commit |
| `⌘⇧S` / `⌘⇧U` | Stage / unstage everything |
| `⌘S` | Save edits in the diff |
| `⌘B` | New branch from HEAD |
| `⌘L` | Fetch every remote |
| `⌘J` | Toggle the left panel |
| `` ⌃` `` | Show or hide the agent panel |
| `?` | All shortcuts |

Use Ctrl instead of ⌘, and Alt instead of ⌥, on Windows and Linux.

## Other ways to run it

### In the browser, nothing installed

[a-ahandani.github.io/ramulus/app](https://a-ahandani.github.io/ramulus/app/) runs the same UI with git reimplemented in JavaScript over the File System Access API (Chrome and Edge). It is slower on large repositories, cannot use SSH, and has no rebase, cherry-pick or revert. Details in `web/README.md`.

## Develop

```sh
cd web && npm install && npm run dev   # browser UI with hot reload, served over the helper
npm test                               # in web/ and cli/
```

`npm run dev` serves this repository by default; set `RAMULUS_REPO=/path/to/repo` for another one. Discard and Save write real files, so point it at a scratch clone when trying those. Design decisions are written down in `docs/ux.md`.

To release the npm helper, run `npm version patch --no-git-tag-version` in `cli/`, push that to main, then push a matching tag such as `cli-v0.5.1`. The Publish workflow runs the tests on Linux, macOS and Windows, then publishes to npm through trusted publishing, with provenance and no stored token.

## License

MIT. Bundled third-party components and their licenses are listed in `THIRD-PARTY-NOTICES.md`.
