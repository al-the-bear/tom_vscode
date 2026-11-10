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
  source's `# yaml-language-server:` schema comment. Todos are written to the
  target **before** being removed from the source (no loss window).
- **The target write is keyed by id, so moving twice is moving once.** An id
  already in the target is replaced where it sits — never added a second time —
  and surplus copies of that id are dropped in the same pass. This is what makes
  the write order safe: an interrupted move leaves the todo in both files, and
  the recovery is simply to run the move again. Without it, that recovery is
  what corrupts the archive (`todos-archived.tom_core.todo.yaml` once held six
  ids five times over, 30 970 lines).
- The file-level `updated:` key is stamped **in the header**, before `todos:`.
  `doc.set` alone appends an absent key, which on a todo file means thousands of
  lines below the header — so an absent key is inserted, not set.
- All operations return `TodoMoveResult { moved, replaced, skipped[{id,
  reason}], targetFile, error? }` so UI and tools can report precisely what
  happened. A non-empty `replaced` means the target already held those ids.
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
| Mark selected todo completed | check | set `status: completed` + stamp `completed_date` (today, local date) | selection or stack |
| Mark selected todo cancelled | circle-slash | set `status: cancelled` | selection or stack |
| Mark selected todo not-started | issue-reopened | set `status: not-started`, clear `completed_*` | selection or stack |
| Move selected to other todo file | file-symlink-file | quick pick of the quest's other `*.todo.yaml` files, including the `-archived`/`-deleted` siblings (+ *New file…*) → move todo(s) | selection or stack, concrete quest mode only |

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
offers every `*.todo.yaml` file — including the `-archived`/`-deleted` siblings
— minus the single common source file; 6 unit tests).
The per-row ⬆️ button (`qt-move-ws-btn`) posts `qtMoveTodosToDestination`
with the clicked todo, or the whole stack when more than one todo is stacked.
The handler resolves each todo's file by panel mode (`_resolveMoveSource`:
session file, workspace file, `__all_workspace__` relative path, or
`questTodoSourcePath` over the quest — every quest in `__all_quests__`), shows
the destination QuickPick from the pure helper `todoMoveOptions` /
`todoMovePickerTitle` (`src/utils/todoDestinationPicker.ts`: *Quest todos* when
all todos share one quest and not all are in its own file, *Workspace todos*
unless all are there, *Move to quest…* always, which opens a quest QuickPick),
and moves each through `questTodoManager.moveTodoToDestination`. That function
writes the target first (`createTodo` / `createTodoInFile`, both verified) and
removes the source second (verified), carries every field including
`decisions` and unknown keys, notes `[moved from quest: <id>]` when the todo
leaves its quest, and refuses an unknown id, a target that is the source and a
target that already holds the id — writing nothing.
A group separator's ⬆️ (`qt-group-move-btn`, `data-qt-group-move` = the
prefix; its click stops before the group toggle) posts the same message with
every open todo of the group (`qtGroupOpenTodos`).
When `todoMoveNeedsIdChoice` says a todo enters a quest it is not in, the
handler asks ONE id decision for all moved todos: `todoPrefixChoices` over the
target's ids (`readAllTodos(quest, ALL_TODO_FILES)`, so archived and deleted
ids count as taken) offers its groups (`kind: 'group'`), largest first with
the next numbers, then *Enter a prefix…* (`custom`: an input box validated by
`validateTodoPrefix`, its info line the `todoPrefixPreview` of the new ids),
then *Keep the ids* (`keep`). `todoRenames` maps each moved id to `<prefix><n><tail>`
(consecutive after the group's highest, taken numbers skipped, the tail after
the id's first digit run kept, an id without digits becoming its tail), and
`moveTodoToDestination(..., renames)` writes the new id, notes the old one and
maps `blocked_by` / `dependencies` through the same map (DP-7 – DP-11, MD-5).
Detail requests thread the todo's `sourceFile` (`qtGetTodo` → `_sendTodoDetail`
→ `_resolveDeleteSourcePath`) so todos in secondary files resolve correctly.

## 2a. List pane — prefix groups

The list pane groups todos by the **prefix of their id**: the leading run of
characters before the id's first digit (`qr3-20260723…` → `qr`,
`vex1_agäo-…` → `vex`). Ids that start with a digit, and ids with no digit at
all, fall into a single catch-all group labelled **Unprefixed**. Prefixes are
taken verbatim — case-sensitive, separators kept — so `qr` and `qr-` are
different groups; the rule is the literal leading non-digit run, not a
normalised key.

Each group is headed by a thin separator row (`.qt-group-header`) carrying a
chevron twisty, the prefix and the group size in brackets. Clicking the row
toggles the group. Named groups render in **first-appearance order**, so the
active filter/sort still drives the layout; `Unprefixed` is always appended
last.

Where the pieces live:

| Piece | Location |
| --- | --- |
| Grouping rule (pure) | `media/questTodoPanel/grouping.js` — `qtTodoPrefix`, `qtGroupTodosByPrefix` |
| Rendering + toggle state | `media/questTodoPanel/main.js` — `qtRenderGroupHeader`, `qtRenderTodoRow`, `qtIsGroupExpanded`, `qtToggleGroup`, `qtCollapseAllGroups`, `qtExpandGroupForTodo` |
| Separator styling | `media/questTodoPanel/style.css` — `.qt-group-header` (the `::after` hairline is what makes it read as a separator rather than a row) |
| Collapse-all / expand-all buttons | `fragment.html` `#qt-btn-collapse-all`, `#qt-btn-expand-all`; `qtCollapseAllGroups`, `qtExpandAllGroups` |
| Script composition | `getQuestTodoScript()` prepends `grouping.js` before `main.js` |

`grouping.js` is a **separate file on purpose**: it has no DOM and no `vscode`
handle, so `src/utils/__tests__/questTodoPrefixGroups.test.ts` loads it into a
bare `vm` sandbox and tests the shipped file directly — there is no TS mirror
that could drift (contrast `qtIsTerminalTodoFileName`, which *is* a mirror).
`questTodoGroupRender.dom.test.ts` loads `fragment.html` + both scripts into
jsdom and covers the rendering, the toggles and the collapse-all button.

Collapse state rules:

- `qtExpandedGroups` is **in-memory only** and deliberately not part of
  `qtPersistState`. The panel must come up fully collapsed after a window
  reload or a VS Code restart, and since the webview script is re-evaluated on
  both, an empty set on every fresh load *is* that state.
- Expansion survives a data refresh (`qtTodos` push) within the session — only
  a script reload or the **Collapse all** button closes the groups. **Expand
  all** and the 👤 toggle open every group of the loaded todos.
- `qtLastRenderOrder` holds only the **visible** rows, so a shift-click stack
  range can never reach into a collapsed group.
- The reveal path (`qtPendingSelect`) calls `qtExpandGroupForTodo` first, so an
  explicit "show me this todo" request never lands on a hidden row.

## 2b. Decisions — the `decision-needed` status and the `decisions[]` block

A todo whose approach depends on a choice **the user** has not made yet cannot
be started: starting it means guessing. Two schema features carry that.

- **`status: decision-needed`** — the todo is waiting on the user. It renders
  with a **question-mark** icon in the list pane and appears in the status
  dropdown of the edit form alongside the other statuses.
- **`decisions[]`** — a list of what has to be settled. Each entry has three
  fields: `summary` (one line, the collapsed label), `decision_needed` (the full
  question with its context and options), and `decision` (the answer, absent
  until the user gives one). The edit form renders them as an accordion — open
  shows all three fields, closed shows only the summary. Parsing/normalising is
  the pure `src/utils/todoDecisions.ts`; the tools
  (`tomAi_createQuestTodo` / `tomAi_updateQuestTodo` / `tomAi_getQuestTodo` /
  `tomAi_listQuestTodos`) round-trip both. On update, passing `decisions`
  **replaces** the whole list; omitting it leaves the list untouched.

Note the two spellings, which coexist across the todo schema: the *status* value
is hyphenated (`decision-needed`), the *object property* is snake_case
(`decision_needed`).

**`references[]`** has one accepted shape. Each entry is an object, as the
schema's `$defs/reference` defines it: `{path}` for a workspace file, `{url}`
for a link or `{description}` for a note, optionally with `type` and `lines`.
`tomAi_createQuestTodo` and `tomAi_updateQuestTodo` reject anything else,
including a bare string, with an `ok: false` that names the object form to
send (`validateTodoReferences` in `src/tools/quest-todo-tools.ts`); a rejected
update applies none of its fields. The reader is more lenient on purpose: a
string already in a file (hand-written, or from an older build) is read as
`{path}`, so the todo keeps its references.

**`tomAi_updateQuestTodo` replaces; it never merges or appends.** Every field
passed overwrites the stored value: `notes` and `description` as whole texts,
the lists (`tags`, `dependencies`, `blocked_by`, `blocked_until`, `references`, `decisions`)
entirely, `scope` as a whole object. An empty value removes the field, and
fields not passed are kept. Because a status-only update once overwrote a
todo's operating instructions in `notes`, a `notes` or `description`
replacement that keeps less than half of the previous text returns `ok: true`
with a `warning` quoting the replaced text (`replacementWarning`). It warns,
it does not refuse: a deliberate rewrite is legitimate. Older versions remain
in the todo file's git history.

Two behaviours hang off the status:

- **Archiving a completed todo journals its decisions.** `todoArchive.ts` copies
  the `decisions[]` of each archived todo into `decisions.<quest>.md` (the
  @WS → Logs → Decisions tab) with the todo id and the archive timestamp, so the
  reasoning outlives the todo. It is a **copy** — the archived todo keeps its
  block — and two things narrow what gets written. Only *archiving* journals:
  deleting a todo throws it away, and recording its open questions as decisions
  the project made would be a lie. And only todos whose status is `completed`
  are journalled: the panel's Archive button archives the selection whatever its
  status, and a todo archived half-done was abandoned rather than concluded. An
  unanswered decision on a completed todo is written as `_(not decided)_` rather
  than dropped.
- **Queue iteration refuses to run the series.** A `prefix*` main prompt whose
  matched todos include a `decision-needed` one pauses the queue and marks the
  item `decision-needed` — see `planMainStageDispatch` in
  `doc/multi_transport_prompt_queue_revised.md` § 5.

## 2c. The user's own todos — `user_action: true`

A todo that only the user can do (reviewing, answering questions, looking at a
screen) carries `user_action: true` (schema field, boolean; `false` removes the
key). `questTodoManager` reads, writes, verifies and updates it, and both write
tools take it. The panel shows 👤 in the list row and a *Your to do* checkbox in
the new-todo and the detail form (`qtUserActionRow`; `qtCollectFormData` sends
`false` when unchecked, so the mark can be removed). A `prefix*` queue walk passes such a todo: it stays
`not-started` and the next todo of the series is sent (`pickNextTodoForIteration`
/ `collectUserActionTodos` in `queueStep3Utils.ts`). A process step's
`userAction: true` is the same idea for processes.

In the panel a user-action row has the class `user-action` (purple title,
`style.css` — a colour no status border uses). Every list row is built by
`todoListItem` (`src/utils/todoListItem.ts`), which carries `user_action` and
`completed_date`; a field the list needs is added there, never in one of the
handler's list builders (`todoListItem.test.ts` TL-1–5). The filter state carries `userAction` (`[]` all, `['yes']`,
`['no']`; `qtEmptyFilterState`), shown as the picker's **User action** section;
an older saved state restores as `[]`. The 👤 toolbar button
(`#qt-btn-only-mine`, `qtToggleOnlyUserActions`) switches between `['yes']`
(opening every group) and `[]`. Tests: `questTodoUserAction.dom.test.ts` QU-1–7.

The detail form's Description, Notes and (completed todos) Answer carry the two
markdown preview buttons (`qtMdButtons`, one delegated click handler
`qtHandleMdButtonClick`): overlay posts `qtRenderMarkdown` and the host answers
`qtMarkdownHtml` with `renderQuestLogMarkdown`'s safe HTML, shown by the shared
overlay `media/shared/mdOverlay.js` / `.css` (composed into the panel's script
and CSS; the Prompt Queue editor loads the same files); editor posts
`qtOpenMarkdownPreview` (`showMarkdownHtmlPreview`). Description and Notes are
sent as they are in the form. Tests: `markdownPreviewButtons.dom.test.ts`
MP-1–6, `questTodoLastAnswer.dom.test.ts` QA-1–4.

The **Agent answer** row (every saved todo) posts `qtShowAgentAnswer` with the
stored `last_answer` as fallback; the host takes the newest trail answer that
reports the todo (`todoAgentAnswer.latestTodoAnswer` over the quest's trail
sets, the TODO Log's reader) and answers `qtMarkdownHtml` or opens the preview
editor. The **Send** / **Queue** buttons of every saved todo (`qtTodoButtonsRow`,
the Run row) post `qtTodoButton` (`chat` / `queue`), the **Guide me** buttons
beside the user-action checkbox (`qtUserActionRow(checked, true)`) post
`qtGuideUserAction`. Both run `_runTodoButton`: the todo's prompt fragment with
the template `todoButtonTemplates.resolveTodoButtonTemplate` gives
(`anthropic.todoButtonTemplates`: `userAction` for Guide me and a user-action
todo, `other` for the rest; defaults `guide-user-action` / `execute-todo`),
always on Anthropic — sent by `runAnthropicSend` or enqueued staged with
`transport: 'anthropic'`; a template missing from the store warns. A double
click is ignored: the button pauses for 2 s (`qtPauseButton`) and the host
drops the same todo sent the same way within 3 s (`_todoButtonGuard`,
`duplicateSubmitGuard.ts`). Tests:
`questTodoAgentAnswerAndGuide.dom.test.ts` AG-1–5, `todoButtons.test.ts` TB-1–6.

The filter state also carries `blocking` (`[]` all, `['yes']` blocks an open todo by
`qtOpenBlockedTodos`, `['no']`) and the date bounds `createdFrom`/`To`, `updatedFrom`/`To`,
`completedFrom`/`To` (inclusive ISO date strings; a todo without `completed_date` fails any
Completed bound). Every field of `qtEmptyFilterState` must be read by the filter loop, counted by
`qtHasActiveFilters`, offered by `qtRenderFilterPicker` and restored with a default in the saved
state. Tests: `questTodoFilterRanges.dom.test.ts` QF-1–4.

Waiting for the user is expressed with this field and `blocked_by`, nothing
else: a 👤 todo for the user's part, the dependent work `blocked` with
`blocked_by` naming it. The walk passes the 👤 todo, leaves the blocked one
blocked, and `releaseUnblockedTodos` releases it once the 👤 todo is completed
(UA-7 in `todoIterationUserAction.test.ts`).

### `blocking` — the reverse of `blocked_by`

`blocking` lists the LIVE todos whose `blocked_by` names the todo: a bare id in
the same quest, `<quest>/<id>` from another; a todo of a non-quest todo file
(`workspace.todo.yaml`) is named only inside that file. It is derived and never
set: every todo file write in the extension goes through `writeTodoFileText`
(`src/utils/todoBlockingSync.ts`), which writes the text and then recomputes
`blocking` for the todos the write can have changed — those named by the
file's `blocked_by` before or after the write, and the file's own todos. The
rules are pure in `src/utils/todoBlocking.ts`. Terminal siblings
(`-archived` / `-deleted`) are not live and are never rewritten; archiving a
blocked todo drops it from its blocker's list. The corpus scan keeps a stat
cache (measured 2026-10-29: 60 live files, 175 ms cold, a few ms warm).
Untouched todos elsewhere are not rewritten: the format migration fills the
existing corpus.

`applyTodoUpdates` never writes `blocking`; `tomAi_createQuestTodo` /
`tomAi_updateQuestTodo` refuse it (`validateNoBlocking`); a bridge update that
sends the whole todo map back carries it harmlessly. The panel shows ⛓️ in a
row whose `blocking` names an open todo (`qtBlockingMark`; a cross-quest entry
counts as open) and a read-only **Blocking** row of badges in the detail form.
`todoWriteSitesGuard.test.ts` counts `writeTodoFileText` as a raw write.
`_ai/schemas/todo_blocking.py` (pass 9 of `validate_todo_corpus.py`) reports a
mismatched pair; a todo with no `blocking` key yet is counted as unmigrated.
Tests: `todoBlocking.test.ts` TB-1–8, `questTodoBlocking.test.ts` QBM-1–5,
`questTodoBlocking.dom.test.ts` QB-1–3.

## 3. Session todos — one file per session

A session todo belongs to **one session** of the quest: a step an agent notes
for itself while carrying out a quest todo, in the flow of that session. Work
that outlives the session, or belongs to the quest, is a quest todo. Each
session keeps its todos in its own storage root:

```
_ai/quests/<quest>/history/sessions/<session>/session-todos.todo.yaml
```

- `services/sessionTodoFiles.ts` names the file and counts its todos
  (`sessionTodoCounts`); `managers/sessionTodoStore.ts` reads and writes it.
  Every store method takes the session; without one it is the session the
  current tool call runs in (the active tool trail's), else the session the
  SESSION TODOS view shows (`shownSession`, set by its session switch), else
  `default`. The panel passes `shownSession` explicitly, so a click never lands
  in the session of an agent that happens to be running.
- The file is **machine-local** like the session itself (`<name>.session.json`
  is not versioned either): the `_ai` `.gitignore` excludes
  `quests/*/history/sessions/*/session-todos*.todo.yaml`. It goes when the
  session is deleted (`removeSessionStorage` removes the storage root); the
  SESSIONS view's confirmation names the open todos that go with it.
- The SESSION TODOS view's **session switch** is `planSessionSwitch`
  (`utils/sessionSwitch.ts`, the @WS Logs one) over the sessions that have
  todos, most recently written first; each chip shows the open count. The
  SESSIONS view shows `☑ <open>` per session.
- The former per-machine file `session-todo.<host>.<quest>.todo.yaml` (and the
  older per-window `{YYYYMMDD}_{HHMM}_win-*.todo.yaml`) is taken over once
  when the store starts: its open todos go to `default`, and it is removed
  with its `-archived` / `-deleted` siblings.

## 4. LLM / MCP move tools (TRA05)

`src/tools/quest-todo-tools.ts` exposes the TRA01 operations as shared tools
(registered for the chat LLM and the MCP server via `CHAT_ENHANCEMENT_TOOLS` →
`ALL_SHARED_TOOLS`, plus `package.json` `languageModelTools`):

- `tomAi_archiveQuestTodos` — `{ questId, file?, todoIds? | allCompleted? }`
- `tomAi_deleteQuestTodos` — `{ questId, file?, todoIds? | allCancelled? }`
- `tomAi_transferTodos` (`src/tools/todo-transfer-tools.ts`, live deps in
  `chat-enhancement-tools.ts`) — `{ todoIds, sourceQuestId [+ sourceFile] |
  fromWorkspace, targetQuestId | toWorkspace }`: the panel's ⬆️ move as a tool,
  through `moveTodoToDestination`; per-id refusals come back in `skipped`.
  `tomAi_moveQuestTodo` stays the move between two files of one quest.

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
