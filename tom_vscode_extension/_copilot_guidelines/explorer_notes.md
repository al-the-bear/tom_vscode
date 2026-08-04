# @TOM Sidebar — Notes, Todos, Log, Window Status

Contributed in the **@TOM** sidebar (Activity Bar view container). Tree views that provide persistent workspace context.

## Contributed views

| View | View ID | Contents |
| --- | --- | --- |
| VS CODE NOTES | `tomAi.vscodeNotes` | VS Code-scoped notes (user-wide). |
| QUEST NOTES | `tomAi.questNotes` | Notes scoped to the active quest. |
| QUEST TODOS | `tomAi.questTodos` | Todos from the active quest's YAML todo files. |
| SESSION TODOS | `tomAi.sessionTodos` | Window-scoped session todos (not persisted across reload). |
| WORKSPACE NOTES | `tomAi.workspaceNotes` | Workspace-root notes. |
| WORKSPACE TODOS | `tomAi.workspaceTodos` | Workspace-root todos. |
| TODO LOG | `tomAi.todoLog` | Session-scoped execution log of completed todos. |
| WINDOW STATUS | `tomAi.windowStatus` | Multi-window status overview with per-subsystem indicators. |

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
