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
