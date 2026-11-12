# UltraClaude

Run a team of Claude Code agents in one window. Each agent has a role (bugfixer, PR reviewer, tester, …), all of them share one memory in an Obsidian vault, they see what the others are doing and they message each other. You can have one agent review a pull request while another solves a ticket, and both work from the same knowledge.

![Overview with five agents around the shared memory](docs/overview.png)

## Install

You need [Node.js](https://nodejs.org) 20 or newer and [Claude Code](https://claude.com/claude-code) (the `claude` command works in your terminal and you are signed in). Obsidian is optional: the vault is a normal folder of Markdown files.

```bash
git clone <repository-url> ultraclaude
cd ultraclaude
npm install
npm link        # makes the "ultraclaude" command available everywhere
```

## Use

```bash
cd my-project
ultraclaude
```

A window opens for that folder. Pick a role to start your first agent.

The first time Claude Code runs in a folder it asks in the agent's terminal whether you trust the folder. Select "Yes" there.

| View | What it shows |
| --- | --- |
| **Overview** | Every agent around the shared memory, with its state and what it is doing right now. Messages and memory access move through the graph as they happen. Next to it: the activity feed and a box to message your agents. |
| **Agents** (sidebar) | The real Claude Code terminals, one at a time or all side by side. The sidebar always shows who is working, idle or waiting for you. |
| **Tasks** | A board with Open, In progress and Done. You and the agents add tasks; whoever gets one assigned is told. |
| **Memory** | All notes in the vault, to filter and read, with a jump into Obsidian. |

Colour only ever means state: green is working, amber needs you.

## Roles

Bugfixer, Developer, PR Reviewer, Tester, Ticket Writer, Architect, Docs Writer, Coordinator, or a custom role you describe yourself. "New agent" also lets you set a name, extra instructions, a first task, the model, the permission mode and a separate git worktree.

## Shared memory

The default vault is `~/UltraClaudeVault`. Change it with `ultraclaude vault <path>`, for example to a folder inside a vault you already use.

```
UltraClaudeVault/
  Global/                      knowledge for all your projects
  Projects/<project>/
    Memory/                    what the agents learned: decisions, architecture, gotchas
    Agents/                    one note per agent with its role and current status
    Tasks/<project> Board.md   the board as a checklist
    Log/2026-01-31.md          journal: who did what, and when
```

To see it in Obsidian, choose "Open folder as vault" and pick the vault folder. Notes you write yourself in `Memory/` or `Global/` are found by the agents too.

## How it works

- `ultraclaude` starts a small local server for the folder you are in (it listens on `127.0.0.1` only and requires an access token) and opens the window. Closing the window leaves the agents running. The server exits once no window is open and no agent is running, or when you choose Quit.
- Each agent is a regular `claude` process in a pseudo terminal, started with its role prompt.
- A built-in MCP server gives every agent the team tools: `list_agents`, `send_message`, `read_messages`, `set_status`, `memory_search`, `memory_read`, `memory_write`, `memory_list`, `task_list`, `task_create`, `task_update`.
- Claude Code hooks report to the dashboard what an agent is doing, and they deliver messages: to a busy agent after its next tool call, to an idle agent as new input.
- When an agent starts it gets a briefing: who is on the team, the open tasks and the notes already in memory.
- Only the server writes to the vault, so agents working in parallel do not overwrite each other.
- A project's state (agents, tasks, messages) lives in `<project>/.ultraclaude/`, which git ignores. A stopped agent continues its session the next time you start it.

## Commands

```
ultraclaude               open the window for the current folder
ultraclaude stop          stop the server and all agents of this folder
ultraclaude status        is a server running for this folder?
ultraclaude vault [path]  show or change the vault
ultraclaude --no-open     start the server without a window
```

## Good to know

- All agents work in the same folder. For agents that change code at the same time, use the "Own git worktree" option.
- Every agent uses your Claude quota. Many agents in parallel reach the limit sooner.
- The window is a Chromium app window when Edge or Chrome is installed, otherwise a tab in your default browser.

## Development

```bash
npm test    # vault, messages, tasks, hooks, MCP and the HTTP API, without real Claude processes
```

```
bin/ultraclaude.js   command line
src/server.js        HTTP, WebSocket, MCP endpoint and hook endpoint
src/project.js       agents, messages, tasks, hook logic
src/mcp.js           the team tools
src/vault.js         the Obsidian vault
src/roles.js         roles and the agent prompt
src/hook.js          hook script that Claude Code calls
public/              the interface (no build step)
```

## License

MIT
