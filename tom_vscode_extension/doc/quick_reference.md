# @Tom Extension Quick Reference

## Bottom Panels

- `@CHAT` → `tomAi.chatPanel`
- `@WS` → `tomAi.wsPanel`

## Keybindings

### Panel & Layout

| Key | Command | Description |
| --- | --- | --- |
| `Ctrl+Shift+0` | `tomAi.focusChatPanel` | Focus `@CHAT` panel |
| `Ctrl+Shift+9` | `tomAi.wsPanel.focus` | Focus `@WS` panel |
| `Ctrl+Shift+8` | `tomAi.statusPage` | Open status page |
| `Ctrl+Shift+7` | `tomAi.editor.timedRequests` | Open timed requests editor |
| `Ctrl+Shift+6` | `tomAi.editor.promptQueue` | Open prompt queue editor |
| `Ctrl+Shift+5` | `tomAi.editor.rawTrailViewer` | Open raw trail viewer |
| `Ctrl+Shift+Y` | `tomAi.layout.windowStateFlow` | Window state flow |
| `Ctrl+Shift+N` | `tomAi.showSidebarNotes` | Show sidebar notes |
| `Ctrl+Shift+\` | `tomAi.layout.maximizeToggle` | Maximize toggle |
| `Ctrl+Shift+2` | `tomAi.layout.maximizeExplorer` | Maximize explorer |
| `Ctrl+Shift+3` | `tomAi.layout.maximizeEditor` | Maximize editor |
| `Ctrl+Shift+4` | `tomAi.layout.maximizeChat` | Maximize chat |

### Chord Menus

| Key | Command | Description |
| --- | --- | --- |
| `Ctrl+Shift+L` | `tomAi.chordMenu.llm` | Send to Anthropic/LLM menu (`l` selection, `s` default template, `t` pick template) |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute menu |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites menu |

## Sidebar Views

**@TOM** (the quest; `tomAi.tomSidebar.focus`):

- PROCESS (the active quest's process: phase, step, sub-step, iterations; the Runs list — select, +, trash, Reset Process, Reset Run; the action bar — Proceed / Decide…, Skip, Leave out, Back, Back to the start of the current phase, Back to the start of the previous phase; Jumps lists where decision steps sent the process)
- QUEST NOTES (the quest's notes files `_ai/quests/<quest>/notes/*.md`; toolbar: the notes file dropdown — default `quest-notes.md` first —, New notes file, Preview Markdown, Open in Editor, Open in MD Browser, Open in MD Viewer)
- QUEST TODOS
- SESSIONS (the quest's named sessions: + new, Remove unused sessions, per row Reset and Delete)
- SESSION TODOS

**@TOM WS** (the workspace; `tomAi.tomWsSidebar.focus`):

- VS CODE NOTES (`~/.tom/notes/global_notes.md`; Preview Markdown and the open buttons, plus Copy and Clear)
- WORKSPACE NOTES (one file, `_ai/workspaces/<workspace>.notes.md`; Preview Markdown and the open buttons)
- WORKSPACE TODOS
- TODO LOG
- WINDOW STATUS

**@TOM VSC** (this window; `tomAi.tomVscSidebar.focus`):

- RESOURCES (the window's extension helper processes: Pause / Resume / Kill; Lean / Full profiles; heavy workspace settings)
- PREREQUISITES (every project's `prerequisites.yaml`: the secrets it needs and the software it expects, checked on Check now / Refresh — presence only; Create for a project without one)

**@TOM INFO** (the quest notes on their own, the runs, the notifications; `tomAi.tomInfoSidebar.focus`):

- QUEST NOTES — <quest> (`tomAi.questNotesPanel`): the notes file dropdown and New notes file (the same files and choice as @TOM's QUEST NOTES), Edit tab (text area, saved as you type; asks when the file changed while you have unsaved text), View tab (rendered as in the MD Browser: folding, +/− per level, search, links; read-only), Open in MD Browser, Open in Editor
- RUNS (`tomAi.runsOverview`): every run of every window on this machine, one folding tile per window (expanded while a run waits for you; collapsed, its runs' state badges in the headline, alphabetical) — run, subject, process › position, state badge (waiting for user / interrupted / waiting for event / waiting on task / running / paused / idle) with what it waits for; click this window's run to select it, another window's for its details
- Prompt Queue headline: 🌙 night mode (the window-wide chat variable `night-mode`; this window or every window) — the `night_mode` aspect: no asking, decisions recorded as `ND-…` question blocks for the morning
- Prompt Queue editor: 📌 **Make default** in the first context bar (with chat variables, templates); 💬 `chatOnlyBtn` in the toolbar: only the items queued from the @CHAT panel and its chat sends
- Recent Prompts (`@T: Recent Prompts`, `tomAi.editor.recentPrompts`; the history icon in the Prompt Queue editor's first context bar): the last 100 prompts the queue sent in this quest, one row per item newest first (kind, todos or first line, run / session / profile / role / template, time, prompt count, answer start); expands into iterations and single prompts, each with **Full text** and **Markdown** (the prompt as queued); **As sent (n)** per row: each stage's user message and system prompt exactly as sent; read-only, follows the queue
- @CHAT input row: 📂 quest folder in the Explorer, Prompt Queue, Status Page, then the others; 🤖 **Available models** overlay (the Anthropic API's list, or why empty); the Template field picks from a fresh list
- Prompt Queue editor, a waiting item: the `tomAi_waitFor` and background-work panels have **Message** (a text area in the item; Send goes to the item's own turn, the agent reads it and waits on; the messages and their answers are listed under the panel); an item whose turn asks shows an ask panel — a question's choices and text area, a picker's items, an MD Browser ask's buttons — answered right there, **Open question** for the full panel; Continue offers **Message…** and **Type an answer…**
- Q&A (`@T: Q&A`, `tomAi.showAnswers`): the quests' Q&A journals (`qa.<host>.<quest>.md`) and the todos' decisions, for the current quest, the workspace's quests or quests you tick. **Questions** tab: the questions asked of you with your answers, the answers agents gave with `tomAi_answerUser` (**Add todo** per suggested todo, **Copy** per suggested prompt; Delete read / Delete all for the stored answers) and the process decisions, every machine's, newest first. **Decisions** tab: open decisions first, answered in place (Save; the last one sets a `decision-needed` todo `not-started`). Each tab counts its new entries; opens when an answer arrives, from its row and from the Q&A link in USER NOTIFICATIONS
- USER NOTIFICATIONS (`tomAi.userNotifications`): everything directed at you, from every window on this machine, the open ones on top under a header that does not scroll — asks (questions, pickers, MD Browser asks, plans, tool approvals) shown open with how long until answered, then answered with the answer; tomAi_notifyUser messages; suggested subprocesses; process decisions waiting; todos for you (decision-needed, your action); the queue holding (decision-needed, error, needs attention, a run paused); one row each, newest first; click for the details (an open ask of this window opens too); Dismiss / Dismiss answered hide rows here only; badge: the open asks
- NOTIFICATIONS (`tomAi.notifications`): queue and todo events of every window on this machine — item queued / deleted, todo created / edited / status changed, the user-directed kinds above (asks, answers, messages, suggestions, decisions, todos for you, queue holds) and *You wrote* (a message you wrote to a waiting turn from its queue item), each with a toggle; one line each (time, icon, text), merged per kind, source and quest within 60 s; hover or click for who (agent: transport, profile, session, queue item, todo; you; the extension), the fields old → new and the members; toggles per kind, a window filter, Clear (this window only); filters kept per window; one shared log (global storage, last 1000 events)

**@TOM TODO** (the todo panel on its own; `tomAi.tomTodoSidebar.focus`, `@T: Focus @TOM TODO`):

- TODO (`tomAi.tomTodo`): the todo panel across quests, a panel instance of its own (scope, toggles, sort and filters kept apart); starts on the open windows' quests with the quest prefix on, on all quests without an active quest

## Quest TODO Panel — top bar

- Quest scope button (one quest / the open windows' quests / all quests with checkboxes; kept per view), file toggles (live, archived, deleted — archived and deleted read-only with ↩️ Restore), order with several quests (groups of all quests / by quest then groups / by quest then list), quest prefix toggle (on by default with several quests)
- Right end: **Done notification** toggle (bell, pressed = on, kept per quest; off by default, disabled while no Todo — Done Notification template is set; on: a todo the panel queued that has no notify prompt of its own reports back with that template, next in the run and session it was queued into), **template button** (the selection, at most 20 characters; click = picker of the templates on offer, *Run default* first and preselected), the **Next** toggle (arrow down to a point = the end of the queue, arrow up from a point = next; for every queue button of the panel) and the **Fresh** toggle (sparkle; on: queued and sent todos run in a one-prompt session based on the session picked) — the same pair leads a todo's Run row —, Save to Queue in the default run (`default@default`, no questions), Save to Queue (asks quest, run, session), Send

## Quest TODO Panel — where a todo goes

- Every queue button asks: quest (an open window's; default the window's, or the todo's own) → run (with its state: busy / paused / idle) → a free session, the queue default or a new session → Next or End of the queue
- After the first use: **Last: <quest> / <run> / <session> / <next|end>** first (one Enter); the later picks preselect the last choices; kept per panel; Escape cancels
- Another quest: through its window's inbox, with run, session and position; TODO items and walks only into their own quest
- Send / Guide me's send: pick a free session of this window's runs (its own **Last: …**)

## Quest TODO Panel — prefix groups

- Group key = todo id up to its number (`qr3-2026…` → `qr`); a leading number belongs to the key (`001_cleanup2` → `001_cleanup`, todo 2); no number after the key, or digits only → the **Unprefixed** group, always rendered last
- Prefixes are verbatim: case-sensitive, separators kept (`qr` and `qr-` are different groups)
- Separator line per group: chevron + prefix + count in brackets; click to expand/collapse
- Groups sorted alphabetically by prefix (Unprefixed last), whatever the sort; the filter still decides which todos show
- Sort picker: todos in a group by the chosen fields (`id` = number order, `qr2` before `qr10`), none chosen = by id; ties by id
- Sort picker **Group by prefix** checkbox (default on, saved with the panel state): off = one plain list in the chosen order
- List opens fully collapsed on every script load (window reload / VS Code restart); expansion is never persisted
- Collapse all / Expand all: toolbar buttons `qt-btn-collapse-all` / `qt-btn-expand-all`
- 👁 `qt-btn-group-members`: **Group todo members** hidden / shown — hidden, a member of a group todo, and the group todo itself, shows only in its group's section, not again in its prefix group or among the other todos (kept with the panel's state)
- 👤 `qt-btn-only-mine`: only the user's own todos (`user_action: true`), every group open; again: all todos. Filter section **User action** (yes / no). User-action titles are purple (the left border is the status: blue in progress, yellow blocked)
- ⛓️ beside the status icon: the todo blocks open todos (its `blocking`, the reverse of their `blocked_by`, kept in step by every save; hover for the list). The detail form shows it as a read-only **Blocking** row. Filter section **Blocking** (yes / no)
- Filter **Date Ranges**: Created, Updated, Completed (`completed_date`; a todo without one is hidden while a Completed bound is set)
- Shift-click stack ranges only span **visible** rows — a collapsed group is never traversed

## Quest TODO Panel — archive/delete buttons

- Archive completed todo / Archive all completed → move to the `-archived` sibling file (completed todos only)
- Delete todo (to file) / Delete all cancelled → move to the `-deleted` sibling file (non-completed todos only; recoverable)
- Sibling naming: first dot-segment suffixed, e.g. `todos.q.todo.yaml` → `todos-archived.q.todo.yaml`; sibling files are terminal (no buttons)
- Session todos: per session, `history/<host>/sessions/<session>/session-todos.todo.yaml` (unversioned, deleted with the session); the view's session switch shows each session's open count
- Repeated todos (🔁): done → `waiting-for-repeat` (⏳) until `next_repeat`; ⏭️ Repeat now; the Timed Requests list's Repeated todos entry releases due ones

## Quest TODO Panel — todo stack

- Circle under each row's status icon: click = stack todo (index shown in circle), shift-click = stack range from last pick, click again = un-stack + renumber
- Clear todo stack: toolbar button `qt-btn-clear-stack` (clear-all icon)
- Save to Queue with stack: one queue prompt per stacked todo, in stack order, selected template applied per todo
- Send with stack: ONE combined prompt — yaml fragments concatenated into a single todo list + numbered `#TODO_<n>=` responseValue lines, embedded in the selected template (raw fragments when template = None)

## Core AI Commands

- `tomAi.sendToLlm`, `tomAi.sendToLlm.standard`, `tomAi.sendToLlm.template` (to the @CHAT ANTHROPIC/LLM panel's current profile and session)
- `tomAi.openInMdBrowser`, `tomAi.openInMdBrowserLive` (follow-tail mode for the live trail)

## Bridge and Runtime Commands

- `tomAi.bridge.restart`
- `tomAi.bridge.switchProfile`
- `tomAi.cliServer.start`
- `tomAi.cliServer.stop`
- `tomAi.mcpServer.start`
- `tomAi.mcpServer.stop`
- `tomAi.mcpServer.restart`
- `tomAi.startProcessMonitor`

## Utility Commands

- `tomAi.statusPage`
- `tomAi.createQuest` — Create New Quest: `_ai/quests/<id>/` with the quest's
  files and the todo that defines the quest with you (also the **Create new
  quest** button of the *No quest is open* banner the panels show while no
  quest is open)
- `tomAi.setupWorkspaceFolder` — Setup New Workspace Folder: unpack the
  workspace template the VSIX carries into a folder (also a button on the
  placeholder panels of a folder without `.tom/` and at the top of the Status
  Page)
- `tomAi.migrateAiFormats` — @T: Migrate _ai Formats: the page Upgrade the
  workspace (the `_ai` format migration: a dry run, the warning, Migrate now);
  opens by itself, and is the button **Upgrade the workspace…** of every
  panel, while the workspace's `_ai` files are older than the build (Tom AI
  does not start until then)
- `tomAi.showDartBinariesHelp` — the Missing Dart Binaries page (DartScript / CodeSpecs validation on this platform; also the status-bar item *Dart binaries missing* and the Status Page's **Dart binaries** section)
- `tomAi.showPendingQuestion` — @T: Show Pending Question: the user-input panel (questions, approvals, plans, pickers, MD Browser asks; one tab per process run), also after it was closed; also the status-bar item *Waiting for you*
- `tomAi.showUserInteraction` — what a queue item waits for (`{itemId}`): the user-input panel on its run's tab, or its MD Browser; run by the item's waiting badge and **Open question** button
- `tomAi.showAgentSdkCliHelp` — the Missing Agent SDK page (the Anthropic provider's SDK or its Claude CLI not installed)
- `tomAi.providerSdks` — the Provider SDKs page: install, update or remove the model providers' SDKs (not in the VSIX; also the Status Page's **Provider SDKs** button; opens at start while none is installed)
- `tomAi.showQuickReference`
- `tomAi.openConfig`
- `tomAi.openSettings`

## Workspace and Quest Setup

- **Setup New Workspace Folder** (`tomAi.setupWorkspaceFolder`): the
  workspace template into a folder; an existing file is asked about one by one
  (Overwrite, Skip, Overwrite All, Skip All, Cancel); then the configuration
  to adapt and what to open.
- **Create New Quest** (`tomAi.createQuest`): `_ai/quests/<id>/` with the
  quest's files and the `questsetup1` todo that defines the quest with you.
- **No quest is open** banner: in @CHAT, @WS and the @TOM quest views while
  the window's quest is `default`, with both buttons.
- **Upgrade the workspace** (`tomAi.migrateAiFormats`): while the `_ai` files
  are in an older format than the build (or a newer one), Tom AI does not
  start; the panels show the versions, the page migrates and asks for a
  reload.
- **Reload required**: after another window migrated the `_ai` files, every
  panel of this window shows only that it needs a reload (Reload window, Show
  running prompts); new chat sends are refused, running ones finish.
- **`_ai` merge drivers**: the extension carries its own drivers for the `_ai`
  files (live trails, session histories, compacted histories, YAML); the
  migration merges with them, and git can use them once registered for the
  `_ai` repository (offered on an upgrade).
- **AI workspaces** (`tomAi.editor.aiWorkspaceQuests`, @T: Open AI Workspace
  Quests): `_ai/workspaces/<workspace>.yaml` lists the workspace's quests; the
  quest choosers and `tomAi_listQuests` offer them first.
- **The quest overview** opens in the MD Browser the first time a quest's
  window opens on a machine (globalState `tomAi.questOverview.shown`).

## Custom Editors (file-bound)

| Editor | View Type | File Patterns | Priority |
| --- | --- | --- | --- |
| Quest TODO Editor | `tomAi.todoEditor` | `*.todo.yaml` | option |
| Trail Viewer | `tomAi.trailViewer` | `*.prompts.md`, `*.answers.md` | default |

## Standalone Webview Panels (command-opened)

| Panel | View Type | Opened Via |
| --- | --- | --- |
| Status Page | `tomStatusPage` | `tomAi.statusPage` |
| Markdown Browser | `tomAi.markdownBrowser` | `tomAi.openInMdBrowser` (static) or `tomAi.openInMdBrowserLive` (follow-tail) |
| Prompt Trail Viewer | `tomAi.trailViewer` | `tomAi.editor.rawTrailViewer` |
| Prompt Queue | `tomAi.queueEditor` | `tomAi.editor.promptQueue` |
| Recent Prompts | `tomAi.recentPrompts` | `tomAi.editor.recentPrompts`, or the history icon of the Prompt Queue editor |
| Timed Requests | `tomAi.timedRequestsEditor` | `tomAi.editor.timedRequests` |
| Prompt Template Editor | `tomAi.globalTemplateEditor` | `tomAi.editor.promptTemplates` |
| Reusable Prompt Editor | `tomAi.reusablePromptEditor` | `tomAi.editor.reusablePrompts` |
| Chat Variables | `tomAi.chatVariablesEditor` | `tomAi.editor.chatVariables` |
| Role Editor (Roles and Role Types tabs) | `tomAi.rolesEditor` | `tomAi.editor.roles` / `tomAi.editor.roleTypes` (on that tab) |
| Aspect Guidelines Editor | `tomAi.aspectSectionEditor` | `tomAi.editor.aspectSections`, or *Edit aspects…* in a guideline picker |
| Process Editor | `tomAi.processEditor` | `tomAi.editor.process` |
| AI Workspace Quests | `tomAi.aiWorkspaceQuests` | `tomAi.editor.aiWorkspaceQuests` |
| Process Template Editor | `tomAi.processTemplateEditor` | `tomAi.editor.processTemplates`, or the snippet button of the PROCESS view's action bar |
| Group Prompt Editor | `tomAi.groupPromptEditor` | `tomAi.editor.groupPrompts`, or the last entry of a todo group's Queue Group Prompt picker (🔁) |
| Process Action Page | `tomAi.processAction` | The Proceed (▶) button of the PROCESS view's action bar (at a user action Proceed asks for a confirmation instead) |
| Quest TODO Pop-out | `tomAi.questTodoEditor` | Pop-out from sidebar |

## Bottom Panel Sub-sections

### @CHAT (`tomAi.chatPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| ANTHROPIC/LLM | `codicon-sparkle` | Anthropic SDK / Agent SDK / VS Code LM / Local LLM configuration with profile and session picker; the action row: Save to Queue and Queue next (sent next — between a running loop's iterations) into the default run with the queue's profile, session `default@default` and default template; then the **Session** and **Run** fields (switching the run selects *Run default*, the run's default session, created when missing), the **Role** (the role of the panel's sends; *Run default*) and the guideline button (the sends' guideline choices; a dot and the hover help) — every choice of the action bar (Model, Template, Session, Run, Role and the reusable prompt's Prompt file — the `*.prompt.md` files of the active quest's `_ai/quests/<quest>/prompt/`) is a field, its label above and its value a link below, at most 110px wide, a click opening VS Code's picker; the profile, template and session pickers start with *Run default* (the run's, looked up at Send; nothing of the panel's own on an item it queues), the template's next entry *No template*; then Send (the picked session), Save to Queue with the panel's session, run, profile and template, and Queue next with the panel's session and run; Keep per prompt slot (keep or clear the text after Send / queue), Fresh (Send in a one-prompt session based on the panel's session, deleted once answered) and the queue mode (Save to Queue adds pending, the default, or staged); Keep, Fresh and the queue mode are icon toggle buttons. Trail, history, memory and Clear are in the @CHAT Logs section behind the session switch. The status bar under the input: **Rebuild history and memory** (builds the quest history and extracts memory candidates in one run; Shift+click or right-click: **Rebuild from scratch**, asked first) and, with the setting `tomAi.memory.promoteMemoryButton`, **Promote memory** (queues the Promote memory prompt in the panel's run and session, staged or pending as the queue mode says) |
| Logs | `codicon-output` | One session on this machine: its turns and its live trail, with a session switch — see [Logs sub-tabs](#logs-sub-tabs) |

The tools button (`codicon-tools`) of the ANTHROPIC/LLM subpanel opens **Extension Tools**: an open button for every editor and page, in the Status Page's four groups, up to four columns wide.

Editors with a list on the left have **Up / Down** (↑ ↓) for the selected entry: configuration entries (profiles, templates) move in the configuration, so the pickers follow; file-based lists (queue templates, reusable prompts, group prompts, roles, role types, processes) keep their order in the configuration's `editorListOrder`. The todo panel's search field has an **×** that clears it.

#### Logs sub-tabs

Read-only viewers over one Anthropic session on this machine: its turns of this
machine's trail `_ai/quests/{quest}/history/trail.{host}.md` and its live trail
in its storage `_ai/quests/{quest}/history/{host}/sessions/{session}/`. A
**session switch** sits above
the sub-tabs: one button per session, the most recently used first; with more
than four sessions a dropdown holding every session comes first and the buttons
are the four most recently used. The list follows sessions created and deleted
while the section is open. The session is one for every sub-tab (switched on
any, it switches on all; default: `default`, the queue's), and it and the
selected sub-tab survive a window reload. The
content refreshes every 7 s while it is shown. A file larger than 256 KB is read from — and the
view opens at — the end its newest content is at (the *Opens at* column below).
Two toolbar buttons act on the selected sub-tab: **Refresh** re-reads from disk,
**Open in editor** opens the file in a normal text editor.

| Sub-tab | File | View | Opens at |
| --- | --- | --- | --- |
| Trail | `history/trail.{host}.md`, the session's turns | Pairs: prompt, then answer | Top (newest first) |
| Live Trail | `live-trail.md` (the session's storage) | Rendered markdown | Bottom (appended to) |
| Live Source | `live-trail.md` (the session's storage) | Source, syntax-highlighted | Bottom (appended to) |

A session without the file yet shows a line saying so. The **Trail** tab shows
the newest 200 turns, each with its time, profile and model and the buttons
*Copy the prompt*, *Copy the answer*, *Markdown* (prompt and answer rendered in
an overlay) and *Open* (the turn at its block in the trail file); the todos its
answer names are links to them.

### @WS (`tomAi.wsPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| Guidelines | `book` | Guidelines browser with project/quest dropdowns |
| Documentation | `note` | Sub-tabs: **Documents** (the document editor) and the quest's own documents — see [Documentation sub-tabs](#documentation-sub-tabs) |
| Settings | `settings-gear` | Embedded status page and configuration |
| Issues | `issues` | Issue tracking |
| Tests | `beaker` | Test results |
| Quest TODO | `tasklist` | Quest todo list |

#### Documentation sub-tabs

**Documents** is the document editor (Workspace / Projects groups). The
other sub-tabs are read-only viewers over the quest's own documents in
`_ai/quests/{quest}/`, one set for every session, with the same toolbar, refresh
and 256 KB window as the Logs:

| Sub-tab | File | Opens at |
| --- | --- | --- |
| Quest Progress | `progress.{quest}.md` | Top |
| Quest Overview | `overview.{quest}.md` | Top |
| Quest Notes | `notes/quest-notes.md` | Top |
| Quest Refresh | `quest_refresh.{quest}.md` | Top |
| DocUpdate | `quest_documentation_update.{quest}.md` | Top |
| Deferred | `deferred.{quest}.md` | Bottom (appended to) |
| Q&A | `qa.{host}.{quest}.md` (this machine's Q&A journal) | Bottom (appended to) |

Not every quest has every file; a missing one is reported in the viewer.

## Prompt Queue

Open: `Ctrl+Shift+6` or `@T: Open Prompt Queue`

### Queue Automation Settings

| Setting | Default | Toggle |
| --- | --- | --- |
| Auto-send | On | `toggleAutoSend` |
| Auto-start | Off | `toggleAutoStart` |
| Auto-pause | On | `toggleAutoPause` |
| Auto-continue | Off | `toggleAutoContinue` |

### Queue Toolbar Actions

| Action | Icon | Effect |
| --- | --- | --- |
| Restart Queue | `codicon-debug-restart` | Reset stuck `sending` items to pending |
| Stop | `codicon-debug-stop` | Cancel the running prompt, revert it to Staged |
| Interrupt for continuation | `codicon-debug-disconnect` | Soft first: hold the next tool result (the turn goes on when auto-send is re-enabled); a hard interrupt after 15 s without one. A second click (`codicon-watch`) waits for the hold point without a limit; a third click or one once held (`codicon-debug-stop`), or the item panel's **Hard interrupt now**: the hard interrupt; **Cancel interruption** lets the turn go on — the repetition is resent with a note |

### Queue Entry Statuses

| Status | Color | Description |
| --- | --- | --- |
| Staged | Red | Editable, waiting to be queued |
| Pending | Green | In queue, waiting to send |
| Sending | Animated | Sent, waiting for answer |
| Sent | Gray | Completed |
| Error | Red | Failed |
| Waiting | Violet | Parked on a rate limit, retries automatically |
| Retry | Violet | Parked on a backoff, retries automatically |
| Decision-needed | Amber | Its `prefix*` todo series contains an undecided todo; auto-send is off. Restarting the queue returns it to Pending and re-checks |
| Interrupted | Cyan | Held for continuation after a deliberate interrupt; auto-send is off. Re-enabling auto-send re-sends the interrupted repetition first. Exits: resume, or Move back to Staged |

### Queue Entry Types

| Type | Badge | Source |
| --- | --- | --- |
| Normal | `codicon-comment` | Manual queue add |
| Timed | `codicon-watch` | Fired by timer engine |

### Queue Storage

- File-per-entry: `q_<8-digit-hex-id>.yaml` in queue folder
- Settings: `queue-settings.yaml`
- Hostname prefix for cross-workspace safety

## Timed Requests

Open: `Ctrl+Shift+7` or `@T: Open Timed Requests`

### Timed Request Fields

| Field | Description |
| --- | --- |
| Template | Prompt template |
| Mode | `interval` (every N min) or `scheduled` (specific times) |
| Interval | Minutes between fires |
| Repeat count | Times to repeat each fire (min 1) |
| Repeat prefix/suffix | Text affixes with placeholders `${repeatNumber}`, `${repeatIndex}`, `${repeatCount}` |
| Send maximum | Max total fires before auto-pause (interval mode) |

## Output Channels

| Channel | Purpose |
| --- | --- |
| Tom Prompt Queue | Queue state, sends, watchdog |
| Tom Timed Requests | Ticks, fire decisions, schedule evaluation |
| Tom Extension Debug Log | General debug across all categories |
| Tom Tests | Test output |
| Tom Dartbridge Log | Bridge communication |
| Tom Tool Log | Tool invocations |
| Tom AI Anthropic Chat | Anthropic turns |
| Tom AI Anthropic Chat Responses | Anthropic response content |
| Tom AI Compaction and Memory Extraction | Compaction and memory-extraction passes |
| Tom AI: MCP Server | MCP server requests |
| Tom AI Local Log | Local LLM debug (endpoint, timing, retries) |

## Window Status Panel

View in the @TOM WS sidebar showing all open @Tom windows with per-subsystem status:

- **Orange**: Prompt sent, awaiting answer
- **Green**: Answer received
- Auto-refreshes every 15 seconds from `_ai/local/*.window-state.json`, only while the view is visible

## Trails on Disk

| Surface | Path | Written by | Notes |
| --- | --- | --- | --- |
| Session storage (Anthropic) | `_ai/quests/<quest>/history/<host>/sessions/<session>/` — one per session of this machine (machine-local; its definition `history/<host>/<session>.session.json`, tracked), `chat` (the ANTHROPIC/LLM panel) and `default` (the queue) included | Anthropic handler, `TrailService`, `LiveTrailWriter` | The compacted history is the quest's (below); a session's old `compacted_history.md` / `history.json` / `history.md` in `history/sessions/<session>/` is read while the quest has none, never written, and deleted by the quest history's first build. Its prompt/answer turns go to the host trail `history/trail.<host>.md`. `trail/` holds the raw per-call files (`*_prompt_*.userprompt.md`, `*_payload_*.payload.md`, `*_answer_*.answer.json`, `*_tool_request_*.json`, `*_tool_answer_*.json`), `compaction/` and `memory/`, `tool_results/t<n>.json` (keys continue past what is stored and past what was pruned). **Retention:** the host trail keeps `trail.compact.maxEntries` prompt / answer turns (default 2000; only turns the quest history covers are dropped; on the Status Page (Trail) as *Compact trail — turns per file*); the raw per-call files of `trail/`, `compaction/` and `memory/` keep at most `trail.raw.maxRawFiles` each (default 1000, the oldest deleted on every write; the flat `trail.maxRawFiles` of older configs is read when it is unset); the stored tool results are pruned after each send to `trail.toolResultsMaxAgeDays` (default 30 days) and `trail.toolResultsMaxPerSession` (default 1000, the newest kept), 0 switching a limit off — both on the Status Page (Trail). `tool_results/.retention.json` records every key up to which results were pruned, so `tomAi_readPastToolResult` answers such a key *pruned by retention*. `rawTurns.json` and `compaction_rounds.json` are the live conversation state, bounded by compaction |
| Raw trail (other subsystems) | `_ai/trail/<subsystem>/<quest>/` | `TrailService`, `lastRequestDump` | LM API, MCP; the quest-level `last_request.json` of `_ai/trail/anthropic/<quest>/` and, for Anthropic profiles on Local LLM configurations, of `_ai/trail/localllm/<quest>/` |
| Live trail | `history/<host>/sessions/<session>/live-trail.md` (machine-local) | `LiveTrailWriter` | Rolling window: last 5 prompt blocks. Stream thinking / tool_use / tool_result / assistant text |
| Host trail | `_ai/quests/<quest>/history/trail.<host>.md` | `TrailService` (the Anthropic handler's sends) | One block per prompt/answer turn of this machine's sessions whose `contributesToTrailAndMemory` is on; tracked; `trail.compact.maxEntries` (2000) turns, the oldest dropped only once the quest's history covers them; read by `tomAi_listPromptPairs`, the TODO LOG and a session's summary trail action |
| Quest memory | `_ai/quests/<quest>/memory/` (no session level, no shared memory): curated files (`facts.md`, `facts-<suffix>.md`, …) and one `candidates.<host>.md` per host | curated: memory tools, `Remember:` / `Forget:`, Memory panel, Promote memory; candidates: memory extraction on that host (`<host>` the host slug) | `${memory}` injects the curated files, then this host's candidates |
| Sessions | `_ai/quests/<quest>/history/<host>/<name>.session.json` (`chat` panel, `default@default` queue, named sessions; a file an older build wrote directly in `history/` is used there) | Anthropic handler, session pickers, the SESSIONS view, `tomAi_createSession` | Tracked, written only by its host; holds the conversation id, base, lifetime, profile and `contributesToTrailAndMemory` (absent: on) |
| Moving to per-session storage | `history/<host>/sessions/.storage-version` (ignored) | memory service, on a quest's first use | The per-quest layout's files (the rolling tail and accumulator, the Anthropic pair, `live-trail.md`, the raw Anthropic trail) become this host's `default@default` session's, once per quest and machine; a file whose target exists stays (named in the *Tom AI Compaction and Memory Extraction* output channel) |
| Quest history | `_ai/quests/<quest>/history/compacted_history.md`, `history.json` / `history.md` (snapshot), `history.watermark.json` (machine-local) | the Anthropic handler's build (`src/services/questHistory.ts`): every `compaction.runEveryNRounds` rounds, a quest's first prompt with a trail and no history, **Rebuild history and memory** | Built from every host's trail (each turn once, by time) and the todo archive (id, title, status and completion date, description, notes, decisions with who decided, references, last answer), interleaved by date; the watermark holds per host the last turn covered and the last archived todo covered; at most `compaction.rebuildFromLastNPrompts` (200) new inputs per build. Every session's prompt gets it. Memory extraction in the same run, per session of the new turns. The first build on a machine deletes the old session histories in `history/sessions/*/` (`compacted_history.md`, `history.json`, `history.md`) once. A notice offers the rebuild when another host's trail holds turns newer than the watermark. One build per machine at a time (`history/.build.<host>.lock`, stale after 10 minutes); Rebuild from scratch deletes the built files and the watermark and folds everything again |
| History of a session | its storage root | Anthropic handler | The rolling tail and accumulator: a based `continue` session is seeded from its base once; a `per-prompt` session reads its base and writes nothing; a `per-iteration` session's folder holds the current iteration (`iteration.json`). A temporary session's storage is deleted with it |
| Tool trail | in-memory (`tool-trail.ts`), one per session | `AnthropicHandler` | Ring buffer 40 entries; replay keys `t<n>` continue past the session's stored results; queryable via `tomAi_*PastToolCall*` tools (the running session's first) |
