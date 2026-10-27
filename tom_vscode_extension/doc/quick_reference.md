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
| `Ctrl+Shift+C` | `tomAi.chordMenu.copilot` | Copilot menu |
| `Ctrl+Shift+L` | `tomAi.chordMenu.localLlm` | Local LLM menu |
| `Ctrl+Shift+A` | `tomAi.chordMenu.aiConversation` | AI Conversation menu |
| `Ctrl+Shift+T` | `tomAi.chordMenu.tomAiChat` | Tom AI chat menu |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute menu |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites menu |

## Sidebar Views

**@TOM** (the quest; `tomAi.tomSidebar.focus`):

- PROCESS (the active quest's process: phase, step, sub-step, iterations)
- QUEST NOTES
- QUEST TODOS
- SESSIONS (the quest's named sessions: + new, per row Reset and Delete)
- SESSION TODOS

**@TOM WS** (the workspace; `tomAi.tomWsSidebar.focus`):

- VS CODE NOTES
- WORKSPACE NOTES
- WORKSPACE TODOS
- TODO LOG
- WINDOW STATUS

## Quest TODO Panel — prefix groups

- Group key = todo id up to its first digit (`qr3-2026…` → `qr`); no digit, or a leading digit → the **Unprefixed** group, always rendered last
- Prefixes are verbatim: case-sensitive, separators kept (`qr` and `qr-` are different groups)
- Separator line per group: chevron + prefix + count in brackets; click to expand/collapse
- Named groups keep first-appearance order, so the active filter/sort still drives the layout
- List opens fully collapsed on every script load (window reload / VS Code restart); expansion is never persisted
- Collapse all / Expand all: toolbar buttons `qt-btn-collapse-all` / `qt-btn-expand-all`
- 👤 `qt-btn-only-mine`: only the user's own todos (`user_action: true`), every group open; again: all todos. Filter section **User action** (yes / no). User-action titles are yellow
- Shift-click stack ranges only span **visible** rows — a collapsed group is never traversed

## Quest TODO Panel — archive/delete buttons

- Archive completed todo / Archive all completed → move to the `-archived` sibling file (completed todos only)
- Delete todo (to file) / Delete all cancelled → move to the `-deleted` sibling file (non-completed todos only; recoverable)
- Sibling naming: first dot-segment suffixed, e.g. `todos.q.todo.yaml` → `todos-archived.q.todo.yaml`; sibling files are terminal (no buttons)
- Session todos: stable per-host file `session-todo.<host>.<quest>.todo.yaml`, persists across reloads

## Quest TODO Panel — todo stack

- Circle under each row's status icon: click = stack todo (index shown in circle), shift-click = stack range from last pick, click again = un-stack + renumber
- Clear todo stack: toolbar button `qt-btn-clear-stack` (clear-all icon)
- Save to Queue with stack: one queue prompt per stacked todo, in stack order, selected template applied per todo
- Send with stack: ONE combined prompt — yaml fragments concatenated into a single todo list + numbered `#TODO_<n>=` responseValue lines, embedded in the selected template (raw fragments when template = None)

## Core AI Commands

- `tomAi.sendToCopilot`, `tomAi.sendToCopilot.standard`, `tomAi.sendToCopilot.template`
- `tomAi.tomAiChat.start`, `tomAi.tomAiChat.send`, `tomAi.tomAiChat.interrupt`
- `tomAi.sendToLocalLlm`, `tomAi.sendToLocalLlm.template`
- `tomAi.aiConversation.start`, `tomAi.aiConversation.stop`, `tomAi.aiConversation.continue`, `tomAi.aiConversation.add`, `tomAi.aiConversation.status`
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
- `tomAi.showQuickReference`
- `tomAi.openConfig`
- `tomAi.openSettings`

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
| Timed Requests | `tomAi.timedRequestsEditor` | `tomAi.editor.timedRequests` |
| Prompt Template Editor | `tomAi.globalTemplateEditor` | `tomAi.editor.promptTemplates` |
| Reusable Prompt Editor | `tomAi.reusablePromptEditor` | `tomAi.editor.reusablePrompts` |
| Context & Settings | `tomAi.contextSettingsEditor` | `tomAi.editor.contextSettings` |
| Chat Variables | `tomAi.chatVariablesEditor` | `tomAi.editor.chatVariables` |
| Process Editor | `tomAi.processEditor` | `tomAi.editor.process` |
| Process Template Editor | `tomAi.processTemplateEditor` | `tomAi.editor.processTemplates`, or the snippet button of the PROCESS view's action bar |
| Process Action Page | `tomAi.processAction` | The Proceed (▶) button of the PROCESS view's action bar (at a user action Proceed asks for a confirmation instead) |
| Quest TODO Pop-out | `tomAi.questTodoEditor` | Pop-out from sidebar |

## Bottom Panel Sub-sections

### @CHAT (`tomAi.chatPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| Anthropic | `codicon-hubot` | Anthropic SDK / Agent SDK with profile picker, Open Live Trail button, Session History, Memory, Clear Session |
| Tom AI Chat | `codicon-comment-discussion-sparkle` | Tom AI chat interface (shares Anthropic handler) |
| AI Conversation | `codicon-comment-discussion` | Multi-turn AI conversation (not queue-compatible) |
| Copilot | `codicon-copilot` | Copilot integration with R/W action bar |
| Local LLM | `codicon-robot` | Send prompts to local Ollama model |

#### Copilot Action Bar Fields

| Field | Width | Description |
| --- | --- | --- |
| R | 24px | Repeat count (number of times to send prompt) |
| W | 24px | Answer wait minutes (0 = wait for answer file, >0 = auto-advance after N minutes) |

### @WS (`tomAi.wsPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| Guidelines | `book` | Copilot guidelines browser with project/quest dropdowns |
| Documentation | `note` | Sub-tabs: **Documents** (the document editor) and the quest's own documents — see [Documentation sub-tabs](#documentation-sub-tabs) |
| Logs | `output` | One session's files, with a session switch — see [Logs sub-tabs](#logs-sub-tabs) |
| Settings | `settings-gear` | Embedded status page and configuration |
| Issues | `issues` | Issue tracking |
| Tests | `beaker` | Test results |
| Quest TODO | `tasklist` | Quest todo list |

#### Logs sub-tabs

Read-only viewers over one Anthropic session's files in
`_ai/quests/{quest}/history/sessions/{session}/`. A **session switch** sits above
the sub-tabs: one button per session, the most recently used first; with more
than four sessions a dropdown holding every session comes first and the buttons
are the four most recently used. The list follows sessions created and deleted
while the section is open; each sub-tab remembers its session (default:
`default`, the queue's) and the selected sub-tab survives a window reload. The
content refreshes every 2.5 s. A file larger than 256 KB is read from — and the
view opens at — the end its newest content is at (the *Opens at* column below).
Two toolbar buttons act on the selected sub-tab: **Refresh** re-reads from disk,
**Open in editor** opens the file in a normal text editor.

| Sub-tab | File (in the session's folder) | View | Opens at |
| --- | --- | --- | --- |
| MD Trail | `live-trail.md` | Rendered markdown | Bottom (appended to) |
| Trail | `live-trail.md` | Source, syntax-highlighted | Bottom (appended to) |
| Prompts | `{quest}.anthropic.prompts.md` | Source | Top |
| Answers | `{quest}.anthropic.answers.md` | Source | Top |
| Current Prompt | `trail/current_prompt.*.md` | Source | Top |

A session without the file yet shows a line saying so.

#### Documentation sub-tabs

**Documents** is the document editor (Workspace / Projects / Notes groups). The
other sub-tabs are read-only viewers over the quest's own documents in
`_ai/quests/{quest}/`, one set for every session, with the same toolbar, refresh
and 256 KB window as the Logs:

| Sub-tab | File | Opens at |
| --- | --- | --- |
| Quest Progress | `progress.{quest}.md` | Top |
| Quest Overview | `overview.{quest}.md` | Top |
| Quest Notes | `quest-notes.{quest}.md` | Top |
| Quest Refresh | `quest_refresh.{quest}.md` | Top |
| DocUpdate | `quest_documentation_update.{quest}.md` | Top |
| Deferred | `deferred.{quest}.md` | Bottom (appended to) |
| Questions | `questions.{quest}.md` | Bottom (appended to) |
| Decisions | `decisions.{quest}.md` | Bottom (appended to) |

Not every quest has every file; a missing one is reported in the viewer.

**Current Prompt** is the one sub-tab that shows several files, picked from a
toolbar dropdown that appears only while it is selected. The six options are the
three parts of a dispatched prompt for each of the two that can run in parallel:

| Option | File | Content |
| --- | --- | --- |
| Chat / Queue Literal Prompt | `current_prompt.{chat\|queue}.literal.md` | What the user typed, pre-expansion |
| Chat / Queue User Prompt | `current_prompt.{chat\|queue}.user.md` | The user message sent to the model |
| Chat / Queue System Prompt | `current_prompt.{chat\|queue}.system.md` | The system prompt; empty when there is none |

All three are rewritten on every send, so nothing lingers from the previous
prompt. The dropdown selection is remembered alongside the sub-tab.

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
| Interrupt for continuation | `codicon-debug-disconnect` | Cancel now, hold the current repetition, resend it when auto-send is re-enabled |

### Queue Entry Statuses

| Status | Color | Description |
| --- | --- | --- |
| Staged | Red | Editable, waiting to be queued |
| Pending | Green | In queue, waiting to send |
| Sending | Animated | Sent to Copilot, waiting for answer |
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
| Reminder | `codicon-bell` | Generated by reminder system |

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
| Answer wait (min) | Auto-advance timeout (0 = classic answer file wait) |
| Reminder | Template, timeout, enabled |

## Output Channels

| Channel | Purpose |
| --- | --- |
| Tom Prompt Queue | Queue state, sends, answer detection, watchdog |
| Tom Timed Requests | Ticks, fire decisions, schedule evaluation |
| Tom Debug | General debug across all categories |
| Tom Tests | Test output |
| Tom Dartbridge Log | Bridge communication |
| Tom Conversation Log | AI conversation turns |
| Tom AI Chat Log | Chat interactions |
| Tom Tool Log | Tool invocations |
| Tom AI Chat Responses | Chat response content |
| Tom AI Local LLM | Local LLM interactions |
| Tom AI Local Log | Local LLM debug |

## Window Status Panel

View in the @TOM WS sidebar showing all open @Tom windows with per-subsystem status:

- **Orange**: Prompt sent, awaiting answer
- **Green**: Answer received
- Auto-refreshes every 3 seconds from `_ai/local/*.window-state.json`

## Trails on Disk

| Surface | Path | Written by | Notes |
| --- | --- | --- | --- |
| Session storage (Anthropic) | `_ai/quests/<quest>/history/sessions/<session>/` — one per session, `chat` (the ANTHROPIC panel) and `default` (the queue) included | Anthropic handler, `TrailService`, `LiveTrailWriter` | `compacted_history.md`, `history.json` / `history.md` (snapshot) and `live-trail.md` are tracked; `rawTurns.json`, `compaction_rounds.json`, `iteration.json`, the pair `<quest>.anthropic.prompts.md` / `.answers.md` and `trail/` are ignored. `trail/` holds the raw per-call files (`*_prompt_*.userprompt.md`, `*_payload_*.payload.md`, `*_answer_*.answer.json`, `*_tool_request_*.json`, `*_tool_answer_*.json`), `compaction/` and `memory/`, `tool_results/t<n>.json` (keys continue past what is stored) and `current_prompt.*.md` |
| Raw trail (other subsystems) | `_ai/trail/<subsystem>/<quest>/` (Local LLM: `_ai/trail/localllm/<quest>-<config>/`) | `TrailService` | Copilot, Local LLM, LM API, MCP; the quest-level `_ai/trail/anthropic/<quest>/last_request.json` stays there |
| Live trail | `history/sessions/<session>/live-trail.md` (Anthropic); `_ai/quests/<quest>/live-trail-localLLM.md` (Local LLM) | `LiveTrailWriter` | Rolling window: last 5 prompt blocks. Stream thinking / tool_use / tool_result / assistant text |
| Quest memory | `_ai/memory/<quest>/<session>/` per session; `_ai/memory/shared/` one set | memory service, memory tools, background extraction | `${memory}` injects the running session's quest memory plus shared; a Local LLM memory bucket (`facts-<suffix>.md`) reads the `default` session's |
| Sessions | `_ai/quests/<quest>/history/<name>.session.json` (`chat` panel, `default` queue, named sessions) | Anthropic handler, session pickers, `tomAi_createSession` | `chat.session.json` and `default.session.json` are gitignored, a named session's file is tracked. Holds the Agent SDK session id (SDK-managed mode) and, for a named session, `basedOn`, `mode` (`continue` / `per-prompt` / `per-iteration`; `fork-from-base` = `per-prompt`), `profileId` and `model`, and a per-iteration session's current `iteration` |
| Moving to per-session storage | `history/sessions/.storage-version` (ignored) | memory service, on a quest's first use | The per-quest layout's files (history, the Anthropic pair, `live-trail.md`, the raw Anthropic trail, quest memory) become the `default` session's, once per quest and machine; a file whose target exists stays (named in the *Tom AI Compaction and Memory Extraction* output channel) |
| History of a session | its storage root | Anthropic handler | A based `continue` session is seeded from its base once; a `per-prompt` session reads its base and writes nothing; a `per-iteration` session's folder holds the current iteration (`iteration.json`). A temporary session's storage is deleted with it |
| Tool trail | in-memory (`tool-trail.ts`), one per session | `AnthropicHandler` | Ring buffer 40 entries; replay keys `t<n>` continue past the session's stored results; queryable via `tomAi_*PastToolCall*` tools (the running session's first) |
