# @TOM and @TOM WS Sidebars — Notes, Todos, Log, Window Status

Two Activity Bar view containers hold these views: **@TOM** (`tomAi-sidebar`) for the active quest and **@TOM WS** (`tomAi-ws-sidebar`) for the workspace. `tomAi.tomSidebar.focus` and `tomAi.tomWsSidebar.focus` open them; each view also has VS Code's own `<view id>.focus`, which works whichever container holds it. `src/utils/__tests__/sidebarContainers.test.ts` (SB-1..3) pins both containers and their view lists.

## Contributed views

**@TOM** — the quest:

| View | View ID | Contents |
| --- | --- | --- |
| PROCESS | `tomAi.process` | The active quest's process and position (process, phase, step, sub-step, iterations, role); a webview over `ProcessStateStore` — see `doc/user_guide.md` § Processes. |
| QUEST NOTES | `tomAi.questNotes` | Notes scoped to the active quest. |
| QUEST TODOS | `tomAi.questTodos` | Todos from the active quest's YAML todo files. |
| SESSIONS | `tomAi.sessions` | The quest's named sessions: every `<name>.session.json` of its `history/` plus the implicit `default` (queue) and `chat` (ANTHROPIC panel), with base, lifetime, profile / model, conversation and last use. Title-bar **+** (`tomAi.sessions.add`) runs the session picker's new-session path; per row **Reset** (forget the conversation, keep the definition) and **Delete** (confirmed; refused while another session is based on it). Both touch only the `.session.json`. `sessionsView-handler.ts`, rows in `sessionsViewRows.ts`, assets `media/sessionsView/`; refreshed by the store's `onSessionsChanged` and an `fs.watch` on the folder. |
| SESSION TODOS | `tomAi.sessionTodos` | Window-scoped session todos (not persisted across reload). |

**@TOM WS** — the workspace:

| View | View ID | Contents |
| --- | --- | --- |
| VS CODE NOTES | `tomAi.vscodeNotes` | VS Code-scoped notes (user-wide). |
| WORKSPACE NOTES | `tomAi.workspaceNotes` | Workspace-root notes. |
| WORKSPACE TODOS | `tomAi.workspaceTodos` | Workspace-root todos. |
| TODO LOG | `tomAi.todoLogTom` | Session-scoped execution log of completed todos. |
| WINDOW STATUS | `tomAi.windowStatusTom` | Multi-window status overview with per-subsystem indicators. |

## Purpose

Keep workspace context navigable without leaving Explorer / Activity Bar. Notes and todos are markdown / YAML files — the tree views are thin navigation shells with file-watcher refresh; the actual editor is VS Code's built-in markdown / YAML, or the custom [quest todo editor](../src/handlers/questTodoPanel-handler.ts) for `*.todo.yaml` files.

## Notes views — picking up edits made elsewhere

The three notes views (VS CODE NOTES, WORKSPACE NOTES, QUEST NOTES) share one store, [`NotepadFileStorage`](../src/handlers/notepad/notepadFileStorage.ts), and each hands it an `onExternalChange` callback that re-renders the view. Two things about it are load-bearing:

- **A `NOTEPAD_POLL_INTERVAL_MS` poll is the guarantee, not the `createFileSystemWatcher`.** None of the three files is reliably watchable: quest and workspace notes sit under `_ai/`, a relative symlink whose real path is outside the workspace folder, and the global notes are in `~/.tom/notes/`, outside any workspace folder. Same reason the MD Browser polls its live-trail (`markdownBrowser-handler.ts`). The watcher stays as a low-latency extra; if it never fires, the view still updates.
- **The view's own autosave is recognised by content, not by timing.** `save()` updates the in-memory content before writing, so a change signal whose disk content matches it is our own echo. Do not reintroduce an "ignore the next event" flag: it is set on every save and cleared only when an event arrives, so on these paths it stayed armed and swallowed the *next real* external edit.

Both are covered by `src/handlers/__tests__/notepadFileStorage.test.ts`, where the stub watcher never fires unless a test asks it to.

## Window Status specifics

Shows one card per open `@Tom` window:

- workspace name + active quest,
- per-subsystem indicators (Anthropic / Tom AI Chat / Copilot / Local LLM / AI Conversation) colored **orange** (prompt sent, awaiting answer) / **green** (answer received),
- relative timestamps for the most recent state change,
- delete action to remove stale window entries.

Backed by `_ai/local/*.window-state.json` files (one per open window). Auto-refreshes via file watcher + 3-second poll.

## Interaction with bottom panels

- `@CHAT` does **not** host todo views — it focuses on chat. Todos live in this sidebar.
- `@WS` embeds the Quest TODO panel and has a refresh watcher for updates.

## Maintenance

When changing view IDs, titles, or contributions:

1. Update `package.json` `contributes.views.tomAi` and any menu contributions.
2. Update focus / open commands in `src/extension.ts` and the relevant handlers.
3. Update [../doc/quick_reference.md](../doc/quick_reference.md) and [../doc/user_guide.md](../doc/user_guide.md).
