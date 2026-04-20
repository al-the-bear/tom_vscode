# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Tom AI chat tools, local LLM integration, YAML graph editing, a prompt queue with timed requests, and dedicated output channels for observability.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): five subpanels — **Anthropic**, **Tom AI Chat**, **AI Conversation**, **Copilot**, **Local LLM**. Shared features: prompt queue side panel, document picker, live-trail button (Anthropic), session-history button, memory/config buttons, accordion/pin/rotate layout.
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO.

AI Conversation is the only subpanel that is **not** queue-compatible — each AI Conversation turn runs as an ad-hoc chat.

### Guidelines Panel

The Guidelines panel in @WS provides a document browser for copilot guidelines. Features:

- **Project dropdown**: Filter guidelines by project (shows projects with `_copilot_guidelines/` folders)
- **Quest dropdown**: Filter guidelines by quest (shows quests when quest project type selected)
- **Link navigation**: Click links to navigate within the panel or open in Markdown Browser

### Markdown Browser

The Markdown Browser is a standalone webview panel for reading markdown documents with full navigation:

- **Open via**: `@T: Open in Markdown Browser` command, `@T: Open in Markdown Browser (Live)` for follow-tail mode, or link clicks in Guidelines panel
- **Document picker**: Grouped by Guidelines, Workspace Docs, Notes, Roles, Quests, Copilot Instructions, and Projects
- **Quest dropdown**: Secondary dropdown to filter quest documents when in quest context
- **Link resolver**: Clickable `.md` links navigate within the browser; special link types include `quest:`, `issue:`, `todo:`, and `test:` protocols; non-`.md` files open in the VS Code editor; external URLs open in the system browser
- **Line number support**: Links with `#L10` or `#L10-L20` fragments open source files at the specified line
- **Auto-reload**: File watcher (debounced ~200 ms) monitors the currently viewed file and re-renders on external changes; scroll position is preserved across same-file re-renders in normal mode
- **Live mode (follow-tail)**: Opened via the "Open Live Trail" button in the Anthropic subpanel or the Live command. Auto-scrolls to the bottom on each re-render as events stream in; pauses when the user scrolls up and resumes when they return to the bottom
- **Anchor navigation**: Heading anchors allow direct scrolling to specific sections
- **Navigation history**: Back/forward buttons with up to 100 entries
- **Breadcrumb navigation**: Shows current document path

### Window Status Panel

The Window Status panel is an Explorer sidebar view showing the state of all open @Tom windows:

- **Multi-window overview**: One card per open window displaying workspace name and active quest
- **Subsystem status**: Per-subsystem indicators (Copilot, Local LLM, AI Conversation, etc.) with color coding:
  - **Orange**: Prompt sent, awaiting answer
  - **Green**: Answer received
- **Relative timestamps**: Shows how long ago each state change occurred
- **Auto-refresh**: File watcher on `_ai/local/*.window-state.json` with periodic refresh every 3 seconds
- **Cleanup**: Delete button to remove stale window entries

Explorer adds note and todo views: VS Code Notes, Quest Notes, Quest Todos, Session Todos, TODO Log, Workspace Notes, Workspace Todos, Window Status.

## 3) Sending prompts

### Anthropic

The Anthropic subpanel in `@CHAT` is the primary AI chat surface. Every turn picks a **profile** that bundles model + transport + history mode + user-message template.

Curated profiles (9 total): **Sonnet 4.6**, **Opus 4.7**, and **Opus 4.6**, each in three flavors:

- **Direct** — raw Anthropic SDK. History injected via `trim_and_summary` compaction. Memory placeholders (`${memory}`, `${memory-shared}`, `${memory-quest}`) expanded before send.
- **Agent SDK T&S** — routes through `@anthropic-ai/claude-agent-sdk` but still uses in-extension history compaction. Memory pulled via `tomAi_memory_*` tools on demand.
- **Agent SDK SDK-MM** — Agent SDK with SDK-managed continuity. Session id persists in `_ai/quests/<quest>/history/default.session.json` (gitignored) so the next turn resumes in place. Works with Claude Code's session selector.

Switches + actions on the action bar: profile picker, model picker (filters to profile-compatible models), **Open Live Trail** (MD Browser in follow-tail mode), **Session History** (opens `history.md`), **Memory**, **Clear Session**, **Config**.

### Copilot

Use command palette or editor context menu:

- `@T: Send to Copilot`
- `@T: Send to Copilot (Default Template)`
- `@T: Send to Copilot (Pick Template)`

In `@CHAT`, Copilot supports templates, prompt slots, answer-file notifications, and response-value extraction.

#### CHAT Action Bar

The Copilot section in `@CHAT` includes an action bar with:

- **R** (Repeat count): Number of times to repeat the prompt (text input, 24px wide)
- **W** (Answer wait minutes): Minutes to wait before auto-advancing without an answer file. When set to 0, uses classic answer-file detection. When > 0, the queue auto-advances after the specified time (text input, 24px wide)
- **Template picker**: Select a prompt template
- **Queue button**: Add the current prompt to the queue with the configured repeat count and wait time

### Tom AI Chat

Use:

- `@T: Start Tom AI Chat`
- `@T: Send Tom AI Chat Prompt`
- `@T: Interrupt Tom AI Chat`

Tom AI Chat shares the Anthropic handler (profiles, tool trail, approval gate, raw trail) but has its own subpanel UI and tool-surface tuning. The tool trail's past-tool-access tools (`tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult`) let the model recall prior tool output by replay key (`t1`, `t2`, …) across turns.

### Local LLM (Ollama)

Use:

- `@T: Send to Local LLM`
- `@T: Send to Local LLM (Default Template)`
- `@T: Send to Local LLM (Pick Template)`

Switch model with `@T: Change Local LLM Model...`.

## 4) Prompt Queue

The prompt queue manages sequenced prompt dispatch to Copilot with answer detection, repeat logic, and automation settings.

### Queue Storage

Queue entries are stored as individual YAML files (one file per entry) in the queue folder with the naming pattern `q_<8-digit-hex-id>.yaml`. Queue settings are stored separately in `queue-settings.yaml`. This file-per-entry approach enables cross-window sync via file watchers.

Files are prefixed with the hostname to prevent cross-workspace collisions when multiple machines share a workspace folder.

### Queue Entry Fields

Each queued prompt tracks:

- **Status**: `staged` → `pending` → `sending` → `sent` (or `error`)
- **Type**: `normal`, `timed`, or `reminder`
- **Template**: Prompt template name (or "(None)")
- **Answer wrapper**: Whether to wrap with answer file template
- **Request ID**: Unique ID for matching answer files
- **Pre-prompts**: Sent before the main prompt
- **Follow-ups**: Sent after receiving the main answer
- **Repeat settings**: `repeatCount`, `repeatIndex`, `repeatPrefix`, `repeatSuffix`
- **Reminder settings**: Template, timeout, repeat, enabled flag
- **Answer wait minutes**: Time-based auto-advance timeout

### Repeat and Affix Support

Prompts can repeat multiple times with customizable prefix and suffix text:

- **repeatCount**: Total number of times to send the prompt
- **repeatIndex**: Current iteration (0-based internally, displayed 1-based)
- **repeatPrefix / repeatSuffix**: Template text inserted before/after each repetition, supporting placeholders `${repeatNumber}` (1-based), `${repeatIndex}` (0-based), `${repeatCount}` (total)

### Answer Detection

The queue uses RequestId-based answer file matching:

- A unique request ID is embedded in each prompt via the answer wrapper template
- The file watcher monitors the answer directory for `*_answer.json` files
- A fallback polling mechanism (every 30 seconds) catches missed file events
- When `answerWaitMinutes` > 0, the queue auto-advances after the specified time without requiring an answer file

### Automation Settings

| Setting | Default | Description |
| --- | --- | --- |
| Auto-send | On | Automatically send pending items |
| Auto-start | Off | Enable auto-send on extension activation |
| Auto-pause | On | Pause auto-send when queue empties |
| Auto-continue | Off | Auto-continue processing after receiving an answer |

### Watchdog and Health Check

A background watchdog runs every 60 seconds to ensure queue reliability:

- Verifies the answer directory exists and is accessible
- Checks the file watcher is active and restarts it if needed
- Detects stalled pending items and triggers processing
- Supplements primary file watching with polling every 30 seconds

### Queue Editor

Open with `Ctrl+Shift+6` or `@T: Open Prompt Queue`. The editor provides:

- **Toolbar**: Auto-send, Auto-start, Auto-pause, Auto-continue toggles, Restart Queue button
- **Entry list**: Per-item cards with status color coding, type badges, progress indicators
- **Staged item form**: Template, repeat count, answer wait minutes, repeat prefix/suffix, pre-prompts
- **Per-item controls**: Preview, send now, move up/down, delete, toggle reminder

## 5) Timed Requests

Timed requests fire prompts on a schedule or at regular intervals. Open the editor with `Ctrl+Shift+7` or `@T: Open Timed Requests`.

### Schedule Modes

- **Interval**: Fire every N minutes (configurable `intervalMinutes`)
- **Scheduled**: Fire at specific times (`HH:MM` format), optionally date-restricted

### Entry Fields

| Field | Description |
| --- | --- |
| Template | Prompt template to use |
| Answer wrapper | Whether to apply answer wrapper |
| Interval (minutes) | Time between fires (interval mode) |
| Scheduled times | Specific fire times (scheduled mode) |
| Repeat count | Number of times to repeat each fire |
| Repeat prefix/suffix | Text affixes per repetition |
| Send maximum | Maximum total fires before auto-pause |
| Sent count | Fires so far (tracking) |
| Answer wait (minutes) | Auto-advance timeout instead of answer file wait |
| Reminder | Template, timeout, enabled flag |

### Send Maximum and Auto-pause

When `sendMaximum` is set on an interval entry, the entry automatically pauses after `sentCount` reaches the limit. This prevents unbounded firing when the user is away.

### Global Schedule Slots

Timer entries respect global schedule slots that restrict when entries can fire:

- Day-of-week restrictions (weekday, specific days)
- Time-of-day windows (`timeFrom` / `timeTo`)
- Month filtering

### Tick Process

The timer engine ticks every 30 seconds. On each tick:

1. Checks global schedule slots
2. For each active entry, evaluates whether it should fire
3. Skips entries that already have a pending item in the queue (prevents duplicates)
4. Enqueues via the prompt queue manager (never sends directly)
5. Updates `lastSentAt`, `sentCount`, and persists state

## 6) Bridge operations

Bridge and automation commands:

- `@T: Restart Bridge`
- `@T: Switch Bridge Profile...`
- `@T: Start Tom CLI Integration Server`
- `@T: Stop Tom CLI Integration Server`
- `@T: Start Process Monitor`

## 7) Status, config, and diagnostics

Use:

- `@T: Extension Status Page`
- `@T: Open Extension Settings`
- `@T: Open Config File`
- `@T: Toggle Bridge Debug Logging`

## 8) Output Channels

The extension provides dedicated output channels for observability:

| Channel | Source | Purpose |
| --- | --- | --- |
| Tom Prompt Queue | `promptQueueManager.ts` | Queue state changes, send events, answer detection, watchdog health checks |
| Tom Timed Requests | `timerEngine.ts` | Tick heartbeats, fire decisions, schedule evaluation, entry lifecycle |
| Tom Debug | `debugLogger.ts` | General debug logging across all categories |
| Tom Tests | `tests.ts` | Test execution output |
| Tom Dartbridge Log | `vscode-bridge.ts` | Bridge communication logs |
| Tom Conversation Log | `aiConversation-handler.ts` | AI conversation turns |
| Tom AI Chat Log | `tomAiChat-handler.ts` | Tom AI Chat interactions |
| Tom Tool Log | `tomAiChat-handler.ts` | Tool invocation logs |
| Tom AI Chat Responses | `tomAiChat-handler.ts` | Chat response content |
| Tom AI Local LLM | `localLlm-handler.ts` | Local LLM interactions |
| Tom AI Local Log | `localLlm-handler.ts` | Local LLM debug output |

Queue and timed request channels include ISO timestamps on every log line and can be enabled/disabled at runtime.

## 9) Trails and history

The Anthropic + Tom AI Chat subsystems write three kinds of trail:

- **Raw trail** — `_ai/trail/anthropic/<quest>/` (and per-subsystem siblings). Every turn produces `<ts>_prompt_<rid>.userprompt.md`, `<ts>_payload_<rid>.payload.md`, `<ts>_answer_<rid>.answer.json`, plus `<ts>_toolrequest_*.json` / `<ts>_toolanswer_*.json` for each tool call. Inspect via the Raw Trail Viewer editor.
- **Live trail** — `_ai/quests/<quest>/live-trail.md`. Rolling-window markdown (last 5 prompt blocks). Streams thinking / tool_use / tool_result / assistant-text events as they arrive. Best viewed via the **Open Live Trail** button (MD Browser in live mode follow-tails the file).
- **Session history** — `_ai/quests/<quest>/history/history.json` (+ `history.md` rendering). Rolling compacted context used by `trim_and_summary` on the direct transport. SDK-managed mode uses `default.session.json` instead.

Clear the session (reset history + tool trail + SDK session id) via the subpanel's Clear button or `@T: Clear Anthropic Session`.

## 10) YAML graph editing

Open `*.flow.yaml`, `*.state.yaml`, or `*.er.yaml` files.

The custom editor requires a numeric `meta.graph-version` and renders Mermaid output based on registered graph types.

## 11) Keyboard productivity

See [quick_reference.md](quick_reference.md) and [../_copilot_guidelines/keybindings_and_commands.md](../_copilot_guidelines/keybindings_and_commands.md).

## 12) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Detailed flow: [../_copilot_guidelines/reinstall_extension.md](../_copilot_guidelines/reinstall_extension.md).
