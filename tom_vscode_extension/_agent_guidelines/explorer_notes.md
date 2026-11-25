# @TOM, @TOM WS and @TOM INFO Sidebars — Notes, Todos, Log, Window Status, Runs

Three Activity Bar view containers hold these views: **@TOM** (`tomAi-sidebar`) for the active quest, **@TOM WS** (`tomAi-ws-sidebar`) for the workspace and **@TOM INFO** (`tomAi-info-sidebar`) for the quest notes on their own, the runs of every window and the notifications (a fourth, **@TOM VSC**, holds RESOURCES: `vscResourcesView-handler.ts`). `tomAi.tomSidebar.focus`, `tomAi.tomWsSidebar.focus` and `tomAi.tomInfoSidebar.focus` open them; each view also has VS Code's own `<view id>.focus`, which works whichever container holds it. `src/utils/__tests__/sidebarContainers.test.ts` (SB-1..3) pins the containers and their view lists.

## Contributed views

**@TOM** — the quest:

| View | View ID | Contents |
| --- | --- | --- |
| PROCESS | `tomAi.process` | The active quest's process and position (process, phase, step, sub-step, iterations, role); a webview over `ProcessStateStore` — see `doc/user_guide.md` § Processes. |
| QUEST NOTES | `tomAi.questNotes` | Notes scoped to the active quest. |
| QUEST TODOS | `tomAi.questTodos` | Todos from the active quest's YAML todo files. |
| SESSIONS | `tomAi.sessions` | The quest's named sessions: every `<name>.session.json` of its `history/` plus the implicit `default` (queue) and `chat` (ANTHROPIC/LLM panel), with base, lifetime, profile / model, conversation and last use. Title-bar **+** (`tomAi.sessions.add`) runs the session picker's new-session path; per row **Reset** (forget the conversation, keep the definition) and **Delete** (confirmed; refused while another session is based on it). Reset clears the history and the SDK session id and keeps the definition, trails and memory; Delete removes the `.session.json` and the session's storage (`history/sessions/<name>/`, its quest memory). Title-bar **Remove unused sessions** (`tomAi.sessions.removeUnused`): a multi-picker of the named sessions no unfinished queue item, the queue default, a process definition (a run's `<name>@<run>` while its run exists) or another session uses (plan: `unusedSessions.ts`, pure), those without a conversation ticked; the ticked ones are deleted with their storage after one confirmation. It refuses while the queue, the process definitions or the quest's runs are not loaded. `sessionsView-handler.ts`, rows in `sessionsViewRows.ts`, assets `media/sessionsView/`; refreshed by the store's `onSessionsChanged` and an `fs.watch` on the folder. |
| SESSION TODOS | `tomAi.sessionTodos` | Window-scoped session todos (not persisted across reload). |

**@TOM WS** — the workspace:

| View | View ID | Contents |
| --- | --- | --- |
| VS CODE NOTES | `tomAi.vscodeNotes` | VS Code-scoped notes (user-wide). |
| WORKSPACE NOTES | `tomAi.workspaceNotes` | Workspace-root notes. |
| WORKSPACE TODOS | `tomAi.workspaceTodos` | Workspace-root todos. |
| TODO LOG | `tomAi.todoLogTom` | Session-scoped execution log of completed todos. |
| WINDOW STATUS | `tomAi.windowStatusTom` | Multi-window status overview with per-subsystem indicators. |

**@TOM INFO** — the quest notes on their own, the runs and the notifications:

| View | View ID | Contents |
| --- | --- | --- |
| QUEST NOTES — <quest> | `tomAi.questNotesPanel` | The same `quest-notes.<quest>.md` as @TOM's QUEST NOTES, through the same `NotepadFileStorage`: an **Edit** tab (text area, saved on a 500 ms pause and on blur; a change on disk is taken in unless the text area holds unsaved text, then a bar asks Load the file / Keep my text) and a **View** tab (the MD Browser's own `blocks.js` / `teamReview.js` / `main.js`, read-only: writing controls hidden, write messages ignored); the tab is kept in the webview state. Buttons open the file in the MD Browser and in an editor. `questNotesPanel-handler.ts`, assets `media/questNotesPanel/`; links through `followMdLink` (`markdownBrowser-handler.ts`). Tests: `questNotesPanel.test.ts` (QNP-1..6), `questNotesPanel.dom.test.ts` (MQP-1..5). |
| RUNS | `tomAi.runsOverview` | Every process run of every window on this machine, from the window-state files (`_ai/local/<window>.window-state.json`, `runs`, written with the heartbeat and 1 s after a change of the queue, the process position, a chat variable or an open user interaction: `windowActivity-handler.ts`). Grouped by window (`runsOverviewWindows`: this window first, alive, then by quest; gone after 90 s without a heartbeat, dropped after 10 minutes; other hosts left out); per run its name, subject, process › position and state badge (`runActivity`: waiting for user > waiting for event > waiting on task > running > paused > idle, with `detail`). A click on this window's run selects it (`ProcessStateStore.selectRun`), on another's opens its details in place. Refreshes on a state-file change and once per heartbeat interval while shown. `runsOverview-handler.ts`, pure rules `src/utils/runActivity.ts`, assets `media/runsOverview/`. Tests: `runActivity.test.ts` (RA-1..6). |
| NOTIFICATIONS | `tomAi.notifications` | Queue and todo events of every window on this machine, from one log for the machine: `<globalStorage>/notifications/events.jsonl`, one JSON event per line, appended under a `mkdir` lock (a lock older than 5 s is taken over), cut to the last 1000 (`services/notificationLog.ts`). Emitted by `PromptQueueManager` (`enqueue` — every path that queues, inbox and process-move markers included —, `remove`, `clearByStatus`, `clearAll`, `dropProcessMoveMarkers`), the todo manager (`fileTodo`, the panel's imports, `updateTodo`, `updateTodoInFile` on a quest todo file: one event per call) and the blocking cascade (`notificationDrafts.ts`). Who: the tool context (`runWithToolContext`) is an agent, with the queue item's profile, session and claimed todo; outside a tool call inside a queue item's dispatch the extension; else the user; an item names its own source (another quest, timed, done notification, reload prompt). The view merges events (`groupNotifications`: one type, source and quest within 60 s of the group's first), filters by window and type, Clear hides older events; filters in workspaceState `tomAi.notifications.filters`. Reads the log on change (`fs.watch` on its folder), no polling. `notifications-handler.ts`, rules `src/utils/notificationEvents.ts`, assets `media/notifications/`. Tests: `notificationEvents.test.ts` (NE-1..7), `notificationLog.test.ts` (NL-1..5), `notificationHooks.test.ts` (NH-1..4). |

## Purpose

Keep workspace context navigable without leaving Explorer / Activity Bar. Notes and todos are markdown / YAML files — the tree views are thin navigation shells with file-watcher refresh; the actual editor is VS Code's built-in markdown / YAML, or the custom [quest todo editor](../src/handlers/questTodoPanel-handler.ts) for `*.todo.yaml` files.

## Notes views — toolbar

Each notes view edits one Markdown file; none of them sends to a model (that is the @CHAT panel's job). Preview Markdown stays per view; the three open buttons — Open in Editor, Open in MD Browser (`openMarkdownBrowser`), Open in MD Viewer (`openInExternalApplication`, the configured external application) — go through one helper, [`handleNotesFileMessage`](../src/handlers/notepad/notesFileActions.ts), which creates the file first when it is missing and warns when the view has no file. Tests: `src/handlers/__tests__/sidebarNotesOpenButtons.test.ts` (SNB-1..4, the providers under the vscode stub) and `src/utils/__tests__/notesPanelsButtons.dom.test.ts` (NPB-1..3, the toolbars).

## Notes views — picking up edits made elsewhere

The notes views (VS CODE NOTES, WORKSPACE NOTES, QUEST NOTES and the @TOM INFO side panel) share one store, [`NotepadFileStorage`](../src/handlers/notepad/notepadFileStorage.ts), and each hands it an `onExternalChange` callback that re-renders the view. Two things about it are load-bearing:

- **A `NOTEPAD_POLL_INTERVAL_MS` poll is the guarantee, not the `createFileSystemWatcher`.** None of the three files is reliably watchable: quest and workspace notes sit under `_ai/`, a relative symlink whose real path is outside the workspace folder, and the global notes are in `~/.tom/notes/`, outside any workspace folder. Same reason the MD Browser polls its live-trail (`markdownBrowser-handler.ts`). The watcher stays as a low-latency extra; if it never fires, the view still updates.
- **The view's own autosave is recognised by content, not by timing.** `save()` updates the in-memory content before writing, so a change signal whose disk content matches it is our own echo. Do not reintroduce an "ignore the next event" flag: it is set on every save and cleared only when an event arrives, so on these paths it stayed armed and swallowed the *next real* external edit.

Both are covered by `src/handlers/__tests__/notepadFileStorage.test.ts`, where the stub watcher never fires unless a test asks it to.

## Window Status specifics

Shows one card per open `@Tom` window:

- workspace name + active quest,
- per-subsystem indicators (Queue / Anthropic) colored **orange** (prompt sent, awaiting answer) / **green** (answer received),
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
