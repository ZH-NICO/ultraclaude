# UltraClaude

Ein Team aus Claude-Code-Agents in einem Fenster. Jeder Agent hat eine Rolle (Bugfixer, PR-Reviewer, Tester, …), alle teilen dieselbe Memory in einem Obsidian-Vault, wissen voneinander und schreiben sich Nachrichten. So kannst du gleichzeitig einen PR reviewen lassen und ein Ticket lösen, und beide Agents arbeiten mit demselben Wissen.

## Schnellstart

```bash
git clone <dieses-repo> ultraclaude
cd ultraclaude
npm install
npm link          # macht den Befehl "ultraclaude" überall verfügbar
```

Danach in einem beliebigen Projektordner:

```bash
cd mein-projekt
ultraclaude
```

Das UltraClaude-Fenster öffnet sich. Ein Klick auf eine Rolle startet den ersten Agent.

Voraussetzungen: Node.js 20+, [Claude Code](https://claude.com/claude-code) (`claude` im PATH, eingeloggt). Obsidian ist optional, der Vault ist ein normaler Ordner mit Markdown-Dateien.

## Was du bekommst

| Bereich | Inhalt |
| --- | --- |
| **Dashboard** | Graph aller Agents rund um die gemeinsame Memory. Farbe zeigt den Zustand (arbeitet, braucht dich, bereit, gestoppt), darunter steht, was der Agent gerade tut. Nachrichten und Memory-Zugriffe laufen als Punkte durch den Graph. Rechts der Live-Feed und ein Feld, um dem Team zu schreiben. |
| **Agents** | Die echten Claude-Code-Terminals. Einzeln oder alle nebeneinander. |
| **Aufgaben** | Kanban-Board (Offen, In Arbeit, Erledigt). Du und die Agents legen Aufgaben an; wer eine zugewiesen bekommt, wird benachrichtigt. |
| **Memory** | Alle Notizen des Vaults zum Durchsuchen und Lesen, mit Sprung nach Obsidian. |

Wenn ein Agent eine Erlaubnis braucht oder dir etwas meldet, bekommst du einen Hinweis im Fenster und im Tab-Titel.

## Rollen

Bugfixer, Entwickler, PR-Reviewer, Tester, Ticket-Ersteller, Architekt, Doku-Schreiber, Koordinator oder eine eigene Rolle mit deiner Beschreibung. Über „+ Agent“ kannst du zusätzlich Name, Anweisungen, eine erste Aufgabe, Modell, Berechtigungsmodus und einen eigenen Git-Worktree wählen.

## Gemeinsame Memory (Obsidian)

Standard-Vault: `~/UltraClaudeVault`. Ändern mit `ultraclaude vault <pfad>` (z.B. auf deinen bestehenden Vault).

```
UltraClaudeVault/
  Global/                      Wissen für alle Projekte
  Projects/<projekt>/
    Memory/                    Wissen der Agents: Entscheide, Architektur, Stolpersteine
    Agents/                    eine Notiz pro Agent mit Rolle und aktuellem Status
    Tasks/<projekt> Board.md   das Board als Checkliste
    Log/2026-11-12.md          Journal: wer hat was wann getan
```

In Obsidian: „Ordner als Vault öffnen“ und den Vault-Pfad wählen. Notizen, die du selbst in `Memory/` oder `Global/` schreibst, finden die Agents ebenfalls.

## Wie es funktioniert

- `ultraclaude` startet pro Projektordner einen kleinen lokalen Server (nur `127.0.0.1`, mit Zugriffstoken) und öffnet das Fenster. Schliesst du das Fenster, laufen die Agents weiter; der Server beendet sich, sobald kein Fenster offen ist und kein Agent mehr läuft.
- Jeder Agent ist ein normaler `claude`-Prozess in einem Pseudo-Terminal, gestartet mit seinem Rollen-Prompt.
- Ein eingebauter MCP-Server gibt jedem Agent die Team-Werkzeuge: `list_agents`, `send_message`, `read_messages`, `set_status`, `memory_search`, `memory_read`, `memory_write`, `memory_list`, `task_list`, `task_create`, `task_update`.
- Claude-Code-Hooks melden dem Dashboard live, was der Agent tut, und stellen Nachrichten zu: bei einem beschäftigten Agent nach dem nächsten Tool-Aufruf, bei einem wartenden Agent direkt als neue Eingabe.
- Beim Start bekommt jeder Agent ein Briefing: wer im Team ist, offene Aufgaben, vorhandene Memory-Notizen.
- Nur der Server schreibt in den Vault, deshalb überschreiben sich parallele Agents nicht.
- Der Zustand eines Projekts (Agents, Aufgaben, Nachrichten) liegt in `<projekt>/.ultraclaude/` und wird von Git ignoriert. Gestoppte Agents setzen ihre Session beim nächsten Start fort.

## Befehle

```
ultraclaude              Fenster für den aktuellen Ordner öffnen
ultraclaude stop         Server und alle Agents dieses Ordners beenden
ultraclaude status       läuft der Server für diesen Ordner?
ultraclaude vault [pfad] Vault anzeigen oder ändern
ultraclaude --no-open    Server starten ohne Fenster
```

## Gut zu wissen

- In einem neuen Ordner fragt Claude Code einmal, ob du dem Ordner vertraust. Bestätige das im Terminal des Agents.
- Alle Agents arbeiten im selben Ordner. Für Agents, die gleichzeitig Code ändern, lohnt sich die Option „Eigener Git-Worktree“.
- Jeder Agent verbraucht dein Claude-Kontingent. Viele parallele Agents erreichen das Limit schneller.

## Entwicklung

```bash
npm test     # Vault, Nachrichten, Aufgaben, Hooks, MCP und API (ohne echte Claude-Prozesse)
```

```
bin/ultraclaude.js   CLI
src/server.js        HTTP, WebSocket, MCP- und Hook-Endpunkt
src/project.js       Agents, Nachrichten, Aufgaben, Hook-Logik
src/mcp.js           Team-Werkzeuge
src/vault.js         Obsidian-Vault
src/roles.js         Rollen und Agent-Prompt
src/hook.js          Hook-Skript, das Claude Code aufruft
public/              Oberfläche (ohne Build-Schritt)
```

## Lizenz

MIT
