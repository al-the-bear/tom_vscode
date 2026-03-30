# Extension Architecture

## System components

The plugin runtime consists of:

- VS Code extension host (`src/extension.ts`),
- TypeScript handler modules (`src/handlers/*`),
- bridge client integration (`vscode-bridge`),
- AI tooling registration (`src/tools/*`),
- webview managers for panel/editor UX,
- stateful managers for queue, timer, and reminder processing (`src/managers/*`),
- dedicated output channels for queue and timed request observability (`src/utils/queueLogger.ts`),
- shared UI components for queue/template editors (`src/handlers/queueEntryComponent.ts`),
- optional external packages (`yaml-graph-core`, `yaml-graph-vscode`).

## Activation flow

During activation, the extension:

1. initializes bridge client,
2. registers commands, key systems, and webviews,
3. initializes stores (chat variables, session todos, queue/timer/reminder),
4. registers Tom AI tools and variable resolvers,
5. registers custom editors (YAML graph and quest todo),
6. starts queue watchdog and timed request timer engine,
7. writes window state file for multi-window status tracking.

## Panel architecture

- Bottom panel `@CHAT` (`tomAi.chatPanel`) is the AI operations panel with per-section action bars (R/W fields for Copilot).
- Bottom panel `@WS` (`tomAi.wsPanel`) is the workspace/ops panel with guidelines/docs/quest browsers.
- Explorer views expose notes, todo sidebars, and the Window Status panel.
- Markdown Browser is a standalone webview panel with link resolver, file watching, and navigation history.

## Data and state

Primary stateful services:

- `ChatVariablesStore` — chat variable resolution for templates
- `WindowSessionTodoStore` — per-window session todos
- `PromptQueueManager` — queue processing with file-per-entry storage, answer detection, watchdog, repeat/affix logic, and automation settings (auto-send, auto-start, auto-pause, auto-continue)
- `TimerEngine` — timed request scheduling with interval/scheduled modes, sendMaximum, and global schedule slots
- `ReminderSystem` — reminder generation for pending queue items

These services are initialized once and shared across command handlers.

## Queue storage architecture

Queue entries are stored as individual YAML files (`q_<id>.yaml`) with hostname prefix for cross-workspace safety. Queue settings persist in `queue-settings.yaml`. File watchers enable cross-window sync. A background watchdog (60s interval) and polling fallback (30s interval) ensure answer detection reliability.

## Communication boundaries

- VS Code command API for UI and command execution.
- webview `postMessage` channels for panel/editor interaction.
- bridge protocol for delegated scripting and runtime operations.
- window state files (`_ai/local/*.window-state.json`) for multi-window status.

## Output channels

Dedicated channels for prompt queue and timed requests provide structured logging with ISO timestamps. See [user_guide.md](../doc/user_guide.md#8-output-channels) for the full channel list.

## Fault tolerance

- Critical optional features use soft-fail behavior (for example dynamic imports in YAML graph registration), so core extension activation can still succeed.
- Queue watchdog auto-restarts file watchers and detects stalled items.
- Answer detection uses multiple fallback strategies: file watcher, polling, requestId-based matching.
- "No reminder" (`__none__` template) correctly suppresses reminder generation.
