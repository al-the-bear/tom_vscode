# @Tom Extension User Guide

## 1) What the extension provides

The extension combines VS Code automation, bridge-based scripting, Copilot workflows, Tom AI chat tools, local LLM integration, YAML graph editing, a prompt queue with timed requests, and dedicated output channels for observability.

## 2) Panels and layout

Current bottom panel layout:

- `@CHAT` (`tomAi.chatPanel`): Local LLM, AI Conversation, Copilot, Tom AI Chat.
- `@WS` (`tomAi.wsPanel`): Guidelines, Documentation, Logs, Settings, Issues, Tests, Quest TODO.

### Guidelines Panel

The Guidelines panel in @WS provides a document browser for copilot guidelines. Features:

- **Project dropdown**: Filter guidelines by project (shows projects with `_copilot_guidelines/` folders)
- **Quest dropdown**: Filter guidelines by quest (shows quests when quest project type selected)
- **Link navigation**: Click links to navigate within the panel or open in Markdown Browser

### Markdown Browser

The Markdown Browser is a standalone webview panel for reading markdown documents with full navigation:

- **Open via**: `@T: Open in Markdown Browser` command or link clicks in Guidelines panel
- **Document picker**: Grouped by Guidelines, Workspace Docs, Notes, Roles, Quests, Copilot Instructions, and Projects
- **Quest dropdown**: Secondary dropdown to filter quest documents when in quest context
- **Link resolver**: Clickable `.md` links navigate within the browser; special link types include `quest:`, `issue:`, `todo:`, and `test:` protocols; non-`.md` files open in the VS Code editor; external URLs open in the system browser
- **Line number support**: Links with `#L10` or `#L10-L20` fragments open source files at the specified line
- **Auto-reload**: File watcher monitors the currently viewed file and auto-reloads content on external changes
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

Tom AI Chat tools are initialized during activation and support workspace operations, editing actions, diagnostics, and integrations.

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

## 9) YAML graph editing

Open `*.flow.yaml`, `*.state.yaml`, or `*.er.yaml` files.

The custom editor requires a numeric `meta.graph-version` and renders Mermaid output based on registered graph types.

## 10) Keyboard productivity

See [quick_reference.md](quick_reference.md) and [../_copilot_guidelines/keybindings_and_commands.md](../_copilot_guidelines/keybindings_and_commands.md).

## 11) Reinstall and reload

If extension changes do not appear:

1. reinstall the extension package in the target VS Code host,
2. reload window,
3. rerun the affected command.

Detailed flow: [../_copilot_guidelines/reinstall_extension.md](../_copilot_guidelines/reinstall_extension.md).
