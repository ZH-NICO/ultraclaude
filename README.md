<p align="center">
  <img src="docs/hero.svg" alt="UltraClaude: a team of Claude Code agents around one shared memory, with every chat on your computer on a map around them" width="100%">
</p>

<p align="center">
  <b>Run a whole team of Claude Code agents in one window.</b><br>
  Every agent has a role. All of them share one memory in Obsidian.<br>
  They see what the others do, message each other and hand work over.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#every-chat-on-one-map">The map</a> ·
  <a href="#shared-memory">Memory</a> ·
  <a href="#keyboard">Keyboard</a> ·
  <a href="#your-account">Account</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#how-it-works">How it works</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="A minute of work: the Bugfixer fixes a bug and saves the cause to memory, tells the Tester, the PR Reviewer asks for permission" width="100%">
  <br>
  <sub>The real interface, recorded with scripted demo agents.</sub>
</p>

## Why

One Claude Code window does one thing at a time. But a pull request is waiting for review while a bug needs fixing and somebody should write that ticket.

UltraClaude opens as many Claude Code sessions as you want for the same project and turns them into a team.

<p align="center">
  <img src="docs/features.svg" alt="Roles, one shared memory, agents that talk, a map of every chat, Ctrl+V for screenshots, a prompt that stays put" width="100%">
</p>

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and [Claude Code](https://claude.com/claude-code) (the `claude` command works in your terminal and you are signed in). Obsidian is optional, because the vault is a normal folder of Markdown files.

```bash
npm install -g github:ZH-NICO/ultraclaude
```

Then, in any project folder:

```bash
cd my-project
ultraclaude
```

A window opens for that folder. Pick a role and your first agent starts. The first time Claude Code runs in a folder, it asks in the agent's terminal whether you trust the folder. Select "Yes" there.

Run `ultraclaude` again after an update: it replaces the old server and your running agents continue their sessions.

<details>
<summary>Install from a clone instead</summary>

```bash
git clone https://github.com/ZH-NICO/ultraclaude.git
cd ultraclaude
npm install
npm link
```

</details>

## What you get

<table>
  <tr>
    <td width="50%"><img src="docs/overview.png" alt="Overview: agents around the shared memory, activity feed on the right"></td>
    <td width="50%"><img src="docs/terminals.png" alt="All terminals side by side"></td>
  </tr>
  <tr>
    <td><b>Overview.</b> Every agent around the shared memory, with its state and what it is doing. Messages and memory access move through the graph as they happen.</td>
    <td><b>Terminals.</b> The real Claude Code terminals, one at a time or all side by side. Tick agents to open, stop or remove them together, and hide a terminal with <b>−</b>.</td>
  </tr>
  <tr>
    <td><img src="docs/tasks.png" alt="Task board with Open, In progress and Done"></td>
    <td><img src="docs/memory.png" alt="Memory view with a note open"></td>
  </tr>
  <tr>
    <td><b>Tasks.</b> A board with Open, In progress and Done. Whoever gets a task assigned is told.</td>
    <td><b>Memory.</b> The vault's real folders. Make, edit, move, copy and delete notes right here.</td>
  </tr>
</table>

Colour only ever means state: green is working, amber needs you. The window follows your system's light or dark theme.

## Every chat on one map

Click **ultraclaude** at the top left. Your drive sits in the middle, every folder on the way to a Claude Code chat spreads out around it, and each chat is a dot in the folder it was opened in. Click any folder to open it, scroll to zoom, drag to move. Pick a chat to continue it, or open its folder in its own UltraClaude window.

<p align="center">
  <img src="docs/map.gif" alt="The chat map: zooming into code, opening folders, picking a chat" width="100%">
  <br>
  <sub>Shown on a made-up drive.</sub>
</p>

## Missions

Give the team one goal under **Missions** and say how many helpers it may use (1 to 6). A coordinator agent plans the goal into tasks on the board, starts helpers with the roles it needs, follows their work and reports back. Each mission is a card with the steps **Plan → Work → Check → Done**, the share of its tasks that are done, the open ones, and the coordinator's final report. **Stop** stops the coordinator and every helper it started. Only the coordinator of a running mission can start agents, and never more than its budget.

## Changes

In a git repository, **Changes** shows what each agent changed. Agents started with *Own worktree* work on their own branch; for each one you see the files, the full diff (uncommitted and new files included) and three buttons: **Commit all**, **Merge into main** (stops cleanly on a conflict and changes nothing), and **Open pull request** (pushes the branch and runs `gh pr create --fill`, if the GitHub CLI is installed). The main folder's uncommitted changes are listed too.

## Cost guard

The guard watches the current 5-hour window against your limit (the one under *Settings → Usage*, or your busiest earlier window). At 80% it warns in the sidebar, with the time the window is full at the current pace. At 95% it stops the running agents, so a forgotten team doesn't use up the rest. **Resume** starts them again, and they continue their sessions. Both marks, auto-resume when a new window starts, and switching it off are under *Settings → Usage*.

## Memory graph

In **Memory**, switch from *List* to *Graph* to see your notes as a network, linked by their `[[wikilinks]]`. Scroll to zoom, drag to move, click a note to open it. Dashed dots are links to notes that don't exist yet; click one to write it. When an agent reads or writes a note, its dot lights up, and new notes appear on their own.

## Replay

Everything your agents do is recorded in the project (`.ultraclaude/events.jsonl`). **Replay** in the sidebar winds it back: drag the slider to any moment and the graph shows who was working, who was waiting for you and what each one was doing. **Play** runs it forward at 1×, 10×, 60× or 300× with the messages and memory access flying through the graph again. A strip above the slider shows when things happened, and quiet stretches are skipped.

## Roles

| Role | What it does |
| --- | --- |
| Bugfixer | Finds root causes and fixes bugs |
| Developer | Implements tickets and features |
| PR Reviewer | Reviews pull requests and diffs |
| Tester | Writes and runs tests |
| Ticket Writer | Turns ideas and bugs into clear tickets |
| Architect | Plans the approach and records decisions |
| Docs Writer | Keeps README, guides and changelogs current |
| Coordinator | Splits up the work and keeps track of it |
| Custom role | You describe what the agent should do |

"New agent" also lets you set a name, extra instructions, a first task, the model, the permission mode and a separate git worktree.

## Keyboard

The terminals behave like Windows Terminal.

| Keys | What happens |
| --- | --- |
| Ctrl+V, Ctrl+Shift+V | Paste. A screenshot or copied image is attached right away as `[Image #1]`, no file path needed |
| Ctrl+C | Copies when text is selected, otherwise interrupts Claude |
| Ctrl+Shift+C | Always copies |
| Shift+Enter, Ctrl+Enter | New line in the prompt instead of sending |
| Ctrl+R, Shift+Tab, Esc, … | Go to Claude Code as usual |
| Ctrl+S, Esc | Save and cancel in the memory editor |

The prompt and status line stay at the bottom while you scroll the chat with the mouse wheel (Claude Code's fullscreen rendering). To turn that off, set `"tui"` to something other than `"fullscreen"` in your Claude Code settings.

## Your account

The window asks you to sign in. The first time you create an account with your name, email and a password. After that you sign in with email and password.

Below the form, **Continue without signing in** opens the window as a guest. A guest has no account: no photo, no saved settings and no access to account tools, and the session ends after 12 hours of not using it. Anyone who can open the window can do this, so if you want a real sign-in every time, turn it off under **Settings → Security → Sign-in screen**.

Bottom left in the sidebar is your profile: your photo (or initials) and your name. It opens **Settings**, a window in the middle of the screen:

| Section | What it does |
| --- | --- |
| **Profile** | Photo, first and last name, email |
| **Appearance** | System, light or dark theme, terminal text size, desktop notifications |
| **Usage** | What your Claude Code chats used, see below |
| **Security** | Change your password, see and end sessions on other devices, delete the account |
| **About** | Version, project and vault paths, keyboard shortcuts |

Accounts are stored on your computer only, in `~/.ultraclaude/users.json`. There is no server and no email, which also means a forgotten password cannot be reset by mail. If you lose it, delete that file and create the account again. Your projects and memory are not touched.

### What protects it

- Passwords are never stored, only a salted scrypt hash. Every account has its own salt, and the file is readable only by you.
- After five wrong passwords an account is locked for a while, longer with every further try. An unknown email and a wrong password give the same answer.
- A session lasts 30 days and lives in an `HttpOnly`, `SameSite=Strict` cookie, so scripts cannot read it and other websites cannot use it. Only a hash of the session key is kept on the computer.
- Everything the window asks for needs a signed-in account, the live terminal connection included. The server listens on `127.0.0.1` only, every call carries a secret from the window's address, and the live connection also checks that it comes from the window itself.
- The page may only load files from the server itself, and cannot be shown inside another site.
- Changing the password signs out every other device. The command line (`ultraclaude stop` and the update restart) uses a separate key that only exists in `<project>/.ultraclaude/server.json`.

This keeps other people, other websites and other programs in your browser out. It does not protect you from malware that runs as you on your computer: that can read your files, as it could for any program.

## Usage

**Settings → Usage** shows what your Claude Code chats have used, read from their history on your computer. Nothing is sent anywhere.

- **The current 5-hour window**: tokens, cost, pace and when it resets, compared with your busiest earlier window or a limit you set.
- **Totals** for today, 7 days, 30 days or all time: tokens (input, output, cache), estimated cost, replies and chats.
- **Tokens per day** for the last 30 days and an **activity map** of the last 26 weeks.
- **Models, projects and recent chats**, each with tokens, cost and share.
- **Export CSV** of the daily numbers.

Costs are what the same tokens would cost at API list prices. A Pro or Max subscription is not billed per token. The percentage Claude shows for your plan is not part of this: reading it would need your Claude login token, and UltraClaude never touches that.

## Shared memory

The default vault is `~/UltraClaudeVault`. Change it with `ultraclaude vault <path>`, for example to a folder inside a vault you already use.

```
UltraClaudeVault/
  Global/                      knowledge for all your projects
  Projects/<project>/
    Memory/                    what the agents learned, and what you write yourself
    Claude Code/               what Claude Code had already saved for this folder
    Agents/                    one note per agent with its role and current status
    Tasks/<project> Board.md   the board as a checklist
    Log/2026-01-31.md          journal: who did what, and when
```

To see it in Obsidian, choose "Open folder as vault" and pick the vault folder. In the **Memory** view you can add notes and folders, edit notes (Ctrl+S saves), rename or move, duplicate, copy text or path, and delete. `Agents/`, `Tasks/` and `Claude Code/` are kept up to date by UltraClaude, so they are read-only there; **Copy into Memory** makes an editable copy.

Already used Claude Code in a folder? Its earlier sessions are listed in the sidebar and continue as agents with one click, and the notes Claude Code saved for the folder are mirrored into the vault.

## How it works

<p align="center">
  <img src="docs/flow.svg" alt="The window talks to a local server, which runs every agent as a Claude Code process, shares team tools over MCP, hears from them through hooks and keeps the memory in an Obsidian vault" width="100%">
</p>

- `ultraclaude` starts a small local server for the folder you are in and opens the window. It listens on `127.0.0.1` only and requires an access token. Closing the window leaves the agents running. The server exits once no window is open and no agent is running, or when you choose Quit.
- Each agent is a regular `claude` process in a pseudo terminal, started with its role prompt.
- A built-in MCP server gives every agent the team tools: `list_agents`, `send_message`, `read_messages`, `set_status`, `memory_search`, `memory_read`, `memory_write`, `memory_list`, `task_list`, `task_create`, `task_update`.
- Claude Code hooks tell the window what an agent is doing, and they deliver messages: to a busy agent after its next tool call, to an idle agent as new input.
- A new agent gets a briefing: who is on the team, the open tasks and the notes already in memory.
- The server writes agent-made notes to the vault, so agents working in parallel do not overwrite each other.
- A project's state lives in `<project>/.ultraclaude/`, which git ignores. A stopped agent continues its session the next time you start it.

## Commands

```
ultraclaude               open the window for the current folder (updates an outdated server)
ultraclaude stop          stop the server and all agents of this folder
ultraclaude status        is a server running for this folder?
ultraclaude vault [path]  show or change the vault
ultraclaude --no-open     start the server without a window
```

## Good to know

- All agents work in the same folder. For agents that change code at the same time, use the "Own git worktree" option.
- Every agent uses your Claude quota. Many agents in parallel reach the limit sooner.
- The window is a Chromium app window when Edge or Chrome is installed, otherwise a tab in your default browser.
- UltraClaude is an independent project. It starts the Claude Code you have installed and is not made or endorsed by Anthropic.

## Development

```bash
npm test    # accounts, sign-in and who may connect, usage, vault, files, messages, tasks, hooks, MCP, sessions, the chat map and the HTTP API
```

```
bin/ultraclaude.js   command line
src/server.js        HTTP, WebSocket, MCP endpoint and hook endpoint
src/project.js       agents, messages, tasks, hook logic
src/mcp.js           the team tools
src/accounts.js      accounts, passwords, sessions
src/usage.js         token usage read from Claude Code's history
src/vault.js         the Obsidian vault and its files
src/history.js       earlier Claude Code sessions, memory and every chat on the computer
src/roles.js         roles and the agent prompt
src/hook.js          hook script that Claude Code calls
src/version.js       tells an outdated server from an up-to-date one
public/              the interface (no build step)
docs/                the pictures in this README
```

## License

[MIT](LICENSE)
