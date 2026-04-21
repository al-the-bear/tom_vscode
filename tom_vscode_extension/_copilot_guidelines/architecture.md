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
- **Markdown Browser** (`tomAi.markdownBrowser`) — standalone custom editor with link resolver, debounced file watcher, navigation history, and live-mode follow-tail (used by the "Open Live Trail" chat-panel button). Context-menu opens always create a **new** panel; the "Open Live Trail" button reuses a single live-panel singleton.

## Data and state

Primary session / state managers:

- `ChatVariablesStore` — chat variable resolution for templates.
- `WindowSessionTodoStore` — per-window session todos.
- `PromptQueueManager` — file-per-entry queue, answer detection, watchdog, repeat/affix, automation settings.
- `TimerEngine` — timed request scheduling (interval + scheduled modes, `sendMaximum`, global schedule slots).
- `ReminderSystem` — reminder generation for pending queue items.

Persistence services:

- `TrailService` — raw trail file writer (prompt / payload / answer / tool-request / tool-answer per turn).
- `LiveTrailWriter` — rolling 5-block markdown at `_ai/quests/<quest>/live-trail.md`. Trimming happens in `beginPrompt()` via `trimOldBlocks()`: each new block drops the oldest once 5 are present. Thinking and assistant text are appended verbatim (no per-block size cap); individual blocks may be large on extended-thinking runs.
- `ToolTrail` — in-memory ring buffer (40 entries) with replay keys `t1`, `t2`, … used by past-tool-access tools.
- `TwoTierMemoryService` — shared + quest memory with placeholder expansion. Also owns the Agent SDK session id file (`default.session.json`, atomic write, idempotent).
- `history-compaction.ts` — `trim_and_summary` / `full` / `summary` / `llm_extract` modes for direct-transport history.

## Anthropic handler + transports

[anthropic-handler.ts](../src/handlers/anthropic-handler.ts) is the core multi-transport entry point. It owns all prompt composition, history injection, tool-approval loop, live-trail writes, and raw trail writes. Only the **leaf API call** differs between transport types.

### Four leaf primitives

| Leaf | Transport key | Notes |
|------|---------------|-------|
| Direct | `direct` | Raw `@anthropic-ai/sdk` |
| Agent SDK | `agentSdk` | `@anthropic-ai/claude-agent-sdk`; runs its own loop, SDK-managed session |
| VS Code LM | `vscodeLm` | `vscode.lm.selectChatModels` + `model.sendRequest`; model pinned at configure-time |
| Local LLM | `localLlm` (runtime only) | `callLocalLlmOnce` primitive shared with `LocalLlmManager`; synthesised at dispatch |

Direct / VS Code LM / Local LLM participate in the Anthropic handler's shared agent loop (tool-use rounds until no more `tool_use` blocks). Agent SDK runs its own stream-level loop; the handler wraps it with the same approval gate, live trail, and built-in-tool persistence.

### Configuration resolution

`AnthropicProfile.configId` can point at:
1. An `AnthropicConfiguration` in `config.anthropic.configurations` → transport is `direct`, `agentSdk`, or `vscodeLm`.
2. A Local LLM configuration in `config.localLlm.configurations` → synthesised `transport: 'localLlm'` at runtime.

Resolution is performed by the shared helper `resolveAnthropicTargets` ([src/utils/resolveAnthropicTargets.ts](../src/utils/resolveAnthropicTargets.ts)), which returns `{ profile, configuration } | { error: string }`. Both the queue dispatcher and the interactive chat panel use it; neither duplicates the fallback chain.

### History modes

Profile-level field `historyMode`: `sdk-managed` (Agent SDK only) | `full` | `summary` | `trim_and_summary` (default) | `llm_extract`. Non-`sdk-managed` modes use the Anthropic handler's own `rawTurns`/`compactedSummary` injection.

### Trail outputs

All four leaf paths write to `_ai/trail/anthropic/*` via `ANTHROPIC_SUBSYSTEM`. The `LiveTrailWriter` instance is created once per `sendMessage()` call and disposed at turn end. Isolated sub-agent calls (`options.isolated = true`) get `currentLiveTrail = null` so their intermediate work doesn't pollute the parent quest's trail.

### Tool approval

`toolApprovalMode: 'always' | 'never'`. Queue-dispatched items coerce this to `'never'` before calling `sendMessage()` (queue is unattended; blocking on the approval bar would stall the queue). Interactive sends honour the profile's stored value.

See [anthropic_chat.md](anthropic_chat.md) for the panel-level detail and [../doc/anthropic_handler.md](../doc/anthropic_handler.md) for the full handler spec.

## Queue transport model

The prompt queue supports **two transports**: `'copilot'` and `'anthropic'`. A queue item can interleave transports within the same ordered run.

### Copilot transport (existing)

- Wraps the prompt with an answer-file template.
- Dispatches via `workbench.action.chat.open`.
- Advances when an answer JSON appears under `_ai/answers/copilot/`.
- Polling loop + 30s watchdog + reminder system + `answerWaitMinutes` auto-advance all apply.

### Anthropic transport

- Calls `AnthropicHandler.instance.sendMessage()` directly and awaits the result.
- No answer-file polling, no reminder, no `answerWaitMinutes` — response is synchronous.
- Answer text is stored on the queue item as `answerText`.
- `toolApprovalMode` is coerced to `'never'` by the dispatcher.

### Stage resolution

Three-tier transport resolution for every stage (pre-prompt / main / follow-up):

```
stage.transport  →  item.transport  →  queue-settings defaultTransport  →  'copilot'
```

The `dispatchStage()` helper inside `promptQueueManager.ts` applies this resolution and branches on the result before calling either the Copilot path or `AnthropicHandler.sendMessage`.

### Queue YAML fields

Per-item and per-stage fields added for the Anthropic transport:

```yaml
transport: anthropic                    # 'copilot' | 'anthropic'
anthropic-profile-id: software-engineer
anthropic-config-id: claude-sonnet-46   # can be an Anthropic config id OR a Local LLM config id
answer-text: "…response…"              # captured direct response
```

Queue-level defaults in `queue-settings.yaml`:

```yaml
default-transport: anthropic
default-anthropic-profile-id: software-engineer
default-anthropic-config-id: claude-sonnet-46
```

All fields are additive-optional; missing fields fall back through the three-tier chain to `'copilot'`.

See [prompt_queue_timed_templates.md](prompt_queue_timed_templates.md) for queue editor, timed requests, and template editor detail.

## Queue storage

Queue entries are stored as individual YAML files (`q_<id>.yaml`) with a hostname prefix for cross-workspace safety. Queue settings persist in `queue-settings.yaml`. File watchers enable cross-window sync. A background watchdog (60s interval) and polling fallback (30s) ensure answer detection reliability.

**Important invariant:** `_reloadFromDisk()` is debounced (300 ms) and skips entirely when any item has `status === 'sending'`. This prevents the `FileSystemWatcher` (triggered by `persist()`) from swapping in-memory item references during an async Anthropic dispatch, which would cause the queue to stall permanently.

## Template stores

Two independent stores, not shared:

| Transport | Config key | Shape |
|-----------|-----------|-------|
| Copilot | `config.copilot.templates` | map `{ [name]: { template, showInMenu? } }` |
| Anthropic | `config.anthropic.userMessageTemplates` | array `[{ id, name, description?, template, isDefault? }]` |

All Anthropic leaf paths (Direct, Agent SDK, VS Code LM, Local-LLM-backed) share the Anthropic store. Template tools (`tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate`) accept a `transport?: 'copilot' | 'anthropic'` field, defaulting to `'copilot'`.

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
- `resolveAnthropicTargets` returns a discriminated union `{ profile, configuration } | { error: string }` — callers surface the error string without catching across module boundaries.
