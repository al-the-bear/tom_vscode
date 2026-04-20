# Extension Architecture

## System components

The plugin runtime consists of:

- VS Code extension host ([src/extension.ts](../src/extension.ts)),
- handler modules under [src/handlers/](../src/handlers/) — UI entry points + webview providers,
- services under [src/services/](../src/services/) — persistence (trail, history, memory, tool trail, live trail),
- managers under [src/managers/](../src/managers/) — volatile session state (queue, timer, reminder, chat variables, session todos),
- tool implementations under [src/tools/](../src/tools/) — everything exposed to AI models,
- bridge client integration ([vscode-bridge](../src/utils/vscode-bridge.ts) + handler),
- Agent SDK transport ([agent-sdk-transport.ts](../src/handlers/agent-sdk-transport.ts)) over `@anthropic-ai/claude-agent-sdk`,
- shared webview components (accordion, tabs, queue entry), and
- optional external packages (`yaml-graph-core`, `yaml-graph-vscode`).

## Layering rules

```text
handlers/     UI entry points; command + webview wiring, approval UI
  ↓ may call
managers/     session-scoped state (queue, reminders, chat variables)
services/     persistence (trails, history, memory, tool trail)
tools/        pure dispatch + service reads; tool-use contract to the model
utils/        config, schema, path + variable resolution
```

- Handlers own VS Code UI coupling. No service module imports a `vscode.webview*` surface.
- Services own I/O. Tools read them; handlers ask tools to dispatch.
- `tools/` does not import `handlers/`. `services/` does not import `handlers/` or `tools/`.

## Activation flow

During activation, the extension:

1. initializes the bridge client (fail-soft),
2. registers commands, key systems, and webviews (`@CHAT`, `@WS`, `@TOM` sidebar views),
3. initializes stores (chat variables, session todos, queue, timer, reminder),
4. registers shared tools + variable resolvers,
5. registers custom editors (YAML graph, quest todo, markdown browser, trail viewer),
6. starts queue watchdog and timed-request timer engine,
7. writes window state file for multi-window status tracking.

## Panel architecture

- **`@CHAT`** (`tomAi.chatPanel`) — five chat subpanels (Anthropic, Tom AI Chat, AI Conversation, Copilot, Local LLM) with per-subpanel action bars. See [tom_ai_chat.md](tom_ai_chat.md) and [tom_ai_bottom_panel.md](tom_ai_bottom_panel.md).
- **`@WS`** (`tomAi.wsPanel`) — workspace / ops panel with guidelines, docs, quest, logs, settings, issues, tests.
- **`@TOM`** sidebar — tree views for notes, todos, todo log, window status.
- **Markdown Browser** (`tomAi.markdownBrowser`) — standalone custom editor with link resolver, debounced file watcher, navigation history, and live-mode follow-tail (used by the "Open Live Trail" chat-panel button).

## Data and state

Primary session / state managers:

- `ChatVariablesStore` — chat variable resolution for templates.
- `WindowSessionTodoStore` — per-window session todos.
- `PromptQueueManager` — file-per-entry queue, answer detection, watchdog, repeat/affix, automation settings.
- `TimerEngine` — timed request scheduling (interval + scheduled modes, `sendMaximum`, global schedule slots).
- `ReminderSystem` — reminder generation for pending queue items.

Persistence services:

- `TrailService` — raw trail file writer (prompt / payload / answer / tool-request / tool-answer per turn).
- `LiveTrailWriter` — rolling 5-block markdown at `_ai/quests/<quest>/live-trail.md`.
- `ToolTrail` — in-memory ring buffer (40 entries) with replay keys `t1`, `t2`, … used by past-tool-access tools.
- `TwoTierMemoryService` — shared + quest memory with placeholder expansion. Also owns the Agent SDK session id file (`default.session.json`, atomic write, idempotent).
- `history-compaction.ts` — `trim_and_summary` / `full` / `summary` / `llm_extract` modes for direct-transport history.

## Anthropic handler + transports

[anthropic-handler.ts](../src/handlers/anthropic-handler.ts) is the core multi-transport entry. Profiles select model + transport (`direct` / `agentSdk` / `vscodeLm`) + history mode (`sdk-managed` / `full` / `summary` / `trim_and_summary` / `llm_extract`). The Agent SDK path routes tool use through an MCP server (`mcp__tom-ai__*`) with an in-extension approval gate bridged via `canUseTool`. SDK-managed mode persists the session id to `_ai/quests/<quest>/history/default.session.json` (gitignored) and resumes each turn in place. See [../doc/anthropic_handler.md](../doc/anthropic_handler.md).

## Queue storage

Queue entries are stored as individual YAML files (`q_<id>.yaml`) with a hostname prefix for cross-workspace safety. Queue settings persist in `queue-settings.yaml`. File watchers enable cross-window sync. A background watchdog (60s interval) and polling fallback (30s) ensure answer detection reliability.

## Communication boundaries

- VS Code command API for UI and command execution.
- webview `postMessage` channels for panel/editor interaction.
- bridge protocol for delegated scripting and runtime operations.
- window state files (`_ai/local/*.window-state.json`) for multi-window status.

## Output channels

Dedicated channels for prompt queue, timed requests, bridge, tool log, conversation log, AI chat log, Local LLM log, and debug. See [user_guide.md](../doc/user_guide.md#8-output-channels) for the full list.

## Fault tolerance

- Optional features use soft-fail behavior — missing dependencies must degrade, not crash, activation.
- Queue watchdog auto-restarts file watchers and detects stalled items.
- Answer detection uses file watcher + polling + requestId-based matching.
- Session-id file write is atomic (`.tmp` + rename) and idempotent (short-circuits when the on-disk value already matches).
- Empty session-id files are unlinked on load so a corrupted write self-heals.
