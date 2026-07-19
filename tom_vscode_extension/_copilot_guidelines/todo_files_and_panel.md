# Todo Files & Quest TODO Panel (TRA series)

Maintainer reference for the todo-file mechanics introduced by the TRA
restructuring (TRA01–TRA05, 2026-07). Covers the archive/delete sibling-file
rule, the panel's archive/delete/status/move top-bar buttons, the stable
per-host session todo file, and the LLM/MCP move tools.

Key source files:

| Concern | File |
| --- | --- |
| Sibling naming rule | `src/utils/todoArchiveNames.ts` |
| Move operations (archive/delete) | `src/utils/todoArchive.ts` |
| Session todo file naming | `src/utils/sessionTodoNames.ts` |
| Panel handler | `src/handlers/questTodoPanel-handler.ts` |
| Panel webview (buttons) | `media/questTodoPanel/fragment.html` + `main.js` |
| LLM tool impls | `src/tools/quest-todo-tools.ts` |
| Live tool wiring | `src/tools/chat-enhancement-tools.ts` |

## 1. Archive / delete sibling files (TRA01)

Every `*.todo.yaml` file has two derived **terminal siblings**, named by
suffixing the **first dot-separated segment** of the basename:

```
todos.vscode_extension.todo.yaml
  → todos-archived.vscode_extension.todo.yaml   (archive target)
  → todos-deleted.vscode_extension.todo.yaml    (delete target)
```

Rules (all enforced in `todoArchive.ts` / `todoArchiveNames.ts`):

- **Archive** moves only `status: completed` todos and stamps each with
  `archived: <date>`.
- **Delete** (to file) moves only **non-completed** todos and stamps each with
  `deleted: <date>`. Completed todos can only be archived, never deleted.
- Bulk variants: `archiveAllCompleted` (every completed todo in the file) and
  `deleteAllCancelled` (every `status: cancelled` todo).
- A file whose first segment already ends in `-archived` / `-deleted` is
  **terminal**: it can never be the *source* of a move (the whole operation is
  refused with an error), and the derivation helpers throw for it.
- The target sibling is created on demand in the same folder, inheriting the
  source's `# yaml-language-server:` schema comment. Todos are appended to the
  target **before** being removed from the source (no loss window).
- All operations return `TodoMoveResult { moved, skipped[{id, reason}],
  targetFile, error? }` so UI and tools can report precisely what happened.
- Source YAML formatting/comments are preserved (yaml Document/CST API);
  `todoArchive.ts` is vscode-free and unit-tested under `npm run test:utils`.

This **replaces the pre-TRA backup mechanism** (TRA03): there are no
`*.backup.todo.yaml` files and no restore-from-backup action anymore. Deleting
via the panel/tools moves todos to the `-deleted` sibling (recoverable by
moving the YAML block back manually); only `tomAi_deleteQuestTodo` (singular)
and the per-row hard-delete erase a todo outright.

## 2. Panel top-bar buttons (TRA02)

The Quest TODO panel (`tomAi.todoEditor` custom editor + the @WS embed) has
four move buttons in the top bar (`fragment.html`, ids `qt-btn-*`):

| Button | Icon | Action | Enabled when |
| --- | --- | --- | --- |
| Archive completed todo | archive | selected todo → `-archived` sibling | selection with `status: completed` |
| Archive all completed | archive + check-all | bulk `archiveAllCompleted` on current file | concrete non-terminal file scope |
| Delete todo (to file) | trash | selected todo → `-deleted` sibling | selection with any non-completed status |
| Delete all cancelled | trash + circle-slash | bulk `deleteAllCancelled` on current file | concrete non-terminal file scope |

In-place status + move buttons (no move to a terminal file):

| Button | Icon | Action | Enabled when |
| --- | --- | --- | --- |
| Mark selected todo completed | check | set `status: completed` + stamp `completed_date` | selection or stack |
| Mark selected todo cancelled | circle-slash | set `status: cancelled` | selection or stack |
| Mark selected todo not-started | issue-reopened | set `status: not-started`, clear `completed_*` | selection or stack |
| Move selected to other todo file | file-symlink-file | quick pick of the quest's other non-terminal `*.todo.yaml` files (+ *New file…*) → move todo(s) | selection or stack, concrete quest mode only |

Visibility rules (`qtUpdateArchiveButtons()` in `media/questTodoPanel/main.js`):

- **Terminal files show no buttons** — the webview mirrors
  `isArchivedOrDeletedTodoFile` client-side (`qtIsTerminalTodoFileName`).
- In aggregate views ("All files", all-quests) the single-todo buttons follow
  the *selected todo's own* source file; bulk buttons need a concrete file.
- The move button is hidden in workspace-file and aggregate (`__all_*`) modes.
- Session mode hides the move buttons; the archive/delete buttons were enabled
  for the stable session file (TRB1, done).
- Per-row trash icons are suppressed for rows whose source file is terminal.

The handler answers `qtArchiveTodo` / `qtDeleteTodoToFile` /
`qtArchiveAllCompleted` / `qtDeleteAllCancelled` messages with an
`qtArchiveResult` refresh, and `qtCompleteTodo` / `qtCancelTodo` /
`qtReopenSelectedTodo` (+ their `…StackedTodos` variants) with a
`qtStatusResult` refresh. `qtMoveTodosToPickedFile` runs the quick pick and
refreshes via `qtArchiveResult`. The candidate list for the move picker is the
pure helper `computeMoveTargetFiles` (`src/utils/questTodoMoveTargets.ts`,
excludes terminal siblings + the single common source file; 6 unit tests).
Detail requests thread the todo's `sourceFile` (`qtGetTodo` → `_sendTodoDetail`
→ `_resolveDeleteSourcePath`) so todos in secondary files resolve correctly.

## 3. Session todos — stable per-host file (TRA04)

Session todos live in **one stable, git-tracked file per host+quest** inside
the quest folder:

```
_ai/quests/<quest>/session-todo.<hostSlug>.<quest>.todo.yaml
```

- `<hostSlug>` comes from `WsPaths.hostSlug()`; because the `_ai` clone is
  shared/synced across the fleet, the slug keeps each machine's session todos
  separate while the file survives window reloads and syncs with `_ai`.
- Session todos are **persistent** — they are NOT cleared when the VS Code
  window closes (that was the pre-TRA04 behaviour).
- Legacy per-window files (`{YYYYMMDD}_{HHMM}_win-*.todo.yaml`) are lazily
  merged into the stable file on first access; the naming predicates in
  `sessionTodoNames.ts` still recognise them so unmigrated hosts' files keep
  showing in the session view.

## 4. LLM / MCP move tools (TRA05)

`src/tools/quest-todo-tools.ts` exposes the TRA01 operations as shared tools
(registered for the chat LLM and the MCP server via `CHAT_ENHANCEMENT_TOOLS` →
`ALL_SHARED_TOOLS`, plus `package.json` `languageModelTools`):

- `tomAi_archiveQuestTodos` — `{ questId, file?, todoIds? | allCompleted? }`
- `tomAi_deleteQuestTodos` — `{ questId, file?, todoIds? | allCancelled? }`

Contract:

- `file` is a **bare** filename inside the quest folder; defaults to
  `todos.<questId>.todo.yaml`. Paths with slashes are rejected.
- `todoIds` and the bulk flag are **mutually exclusive**; exactly one must be
  given.
- Returns `{ok, targetFile, movedCount, moved[], skipped[]}`; TRA01 refusals
  (terminal source, missing file) surface as `{ok: false, error}`.
- `tomAi_deleteQuestTodo` (singular) remains the **hard-remove**; its
  description steers models to the recoverable plural tools.

When touching these tools, keep all registration surfaces in lockstep:
`quest-todo-tools.ts`, `chat-enhancement-tools.ts`, `tool-executors.ts`
(`ALL_SHARED_TOOLS`), `utils/constants.ts` (`AVAILABLE_LLM_TOOLS`),
`utils/toolCategories.ts`, `package.json` (`contributes.languageModelTools`),
and a `withTiming` test case so `npm run audit:tools` passes (see
`tool_testing.md`).
