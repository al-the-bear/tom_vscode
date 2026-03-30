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

## Explorer Views

- VS CODE NOTES
- QUEST NOTES
- QUEST TODOS
- SESSION TODOS
- TODO LOG
- WORKSPACE NOTES
- WORKSPACE TODOS
- WINDOW STATUS

## Core AI Commands

- `tomAi.sendToCopilot`
- `tomAi.sendToCopilot.standard`
- `tomAi.sendToCopilot.template`
- `tomAi.tomAiChat.start`
- `tomAi.tomAiChat.send`
- `tomAi.tomAiChat.interrupt`
- `tomAi.sendToLocalLlm`
- `tomAi.sendToLocalLlm.template`

## Bridge and Runtime Commands

- `tomAi.bridge.restart`
- `tomAi.bridge.switchProfile`
- `tomAi.cliServer.start`
- `tomAi.cliServer.stop`
- `tomAi.startProcessMonitor`

## Utility Commands

- `tomAi.statusPage`
- `tomAi.showQuickReference`
- `tomAi.openConfig`
- `tomAi.openSettings`

## Custom Editors (file-bound)

| Editor | View Type | File Patterns | Priority |
| --- | --- | --- | --- |
| YAML Graph Editor | `tomAi.yamlGraphEditor` | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | default |
| Quest TODO Editor | `tomAi.todoEditor` | `*.todo.yaml` | option |
| Trail Viewer | `tomAi.trailViewer` | `*.prompts.md`, `*.answers.md` | default |

## Standalone Webview Panels (command-opened)

| Panel | View Type | Opened Via |
| --- | --- | --- |
| Status Page | `tomStatusPage` | `tomAi.statusPage` |
| Markdown Browser | `tomAi.markdownBrowser` | `tomAi.openInMdBrowser` |
| Prompt Trail Viewer | `tomAi.trailViewer` | `tomAi.editor.rawTrailViewer` |
| Prompt Queue | `tomAi.queueEditor` | `tomAi.editor.promptQueue` |
| Timed Requests | `tomAi.timedRequestsEditor` | `tomAi.editor.timedRequests` |
| Prompt Template Editor | `tomAi.globalTemplateEditor` | `tomAi.editor.promptTemplates` |
| Reusable Prompt Editor | `tomAi.reusablePromptEditor` | `tomAi.editor.reusablePrompts` |
| Context & Settings | `tomAi.contextSettingsEditor` | `tomAi.editor.contextSettings` |
| Chat Variables | `tomAi.chatVariablesEditor` | `tomAi.editor.chatVariables` |
| Quest TODO Pop-out | `tomAi.questTodoEditor` | Pop-out from sidebar |

## Bottom Panel Sub-sections

### @CHAT (`tomAi.chatPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| Local LLM | `codicon-robot` | Send prompts to local Ollama model |
| AI Conversation | `codicon-comment-discussion` | Multi-turn AI conversation |
| Copilot | `codicon-copilot` | Copilot integration with R/W action bar |
| Tom AI Chat | `codicon-comment-discussion-sparkle` | Tom AI chat interface |

#### Copilot Action Bar Fields

| Field | Width | Description |
| --- | --- | --- |
| R | 24px | Repeat count (number of times to send prompt) |
| W | 24px | Answer wait minutes (0 = wait for answer file, >0 = auto-advance after N minutes) |

### @WS (`tomAi.wsPanel`)

| Section | Icon | Description |
| --- | --- | --- |
| Guidelines | `book` | Copilot guidelines browser with project/quest dropdowns |
| Documentation | `note` | Project documentation |
| Logs | `output` | Extension logs |
| Settings | `settings-gear` | Embedded status page and configuration |
| Issues | `issues` | Issue tracking |
| Tests | `beaker` | Test results |
| Quest TODO | `tasklist` | Quest todo list |

## Prompt Queue

Open: `Ctrl+Shift+6` or `@T: Open Prompt Queue`

### Queue Automation Settings

| Setting | Default | Toggle |
| --- | --- | --- |
| Auto-send | On | `toggleAutoSend` |
| Auto-start | Off | `toggleAutoStart` |
| Auto-pause | On | `toggleAutoPause` |
| Auto-continue | Off | `toggleAutoContinue` |

### Queue Entry Statuses

| Status | Color | Description |
| --- | --- | --- |
| Staged | Red | Editable, waiting to be queued |
| Pending | Green | In queue, waiting to send |
| Sending | Animated | Sent to Copilot, waiting for answer |
| Sent | Gray | Completed |
| Error | Red | Failed |

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
| Repeat prefix/suffix | Text affixes with placeholders `{{repeatNumber}}`/`${repeatNumber}`, `{{repeatIndex}}`/`${repeatIndex}`, `{{repeatCount}}`/`${repeatCount}` |
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

Explorer sidebar view showing all open @Tom windows with per-subsystem status:
- **Orange**: Prompt sent, awaiting answer
- **Green**: Answer received
- Auto-refreshes every 3 seconds from `_ai/local/*.window-state.json`
