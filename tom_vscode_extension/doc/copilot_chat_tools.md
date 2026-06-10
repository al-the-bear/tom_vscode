# Copilot Chat and Tom AI Tools

Reference for the tooling surface exposed by the extension. For the full per-subpanel experience, see [user_guide.md](user_guide.md).

## Scope

The extension integrates **five** chat subsystems, all accessible from the `@CHAT` panel:

- **Anthropic** — direct Anthropic SDK or Agent SDK ([anthropic_handler.md](anthropic_handler.md)).
- **Tom AI Chat** — Anthropic handler with a narrower UI, same profile + tool surface.
- **AI Conversation** — multi-turn chat (not queue-compatible).
- **Copilot** — VS Code Copilot Chat via the answer-file mechanism.
- **Local LLM** — Ollama or OpenAI-compatible HTTP backend ([../\_copilot\_guidelines/local\_llm.md](../_copilot_guidelines/local_llm.md)).

This page covers the Copilot-facing commands + tooling. For Anthropic / Tom AI Chat specifics, see [../\_copilot\_guidelines/tom\_ai\_chat.md](../_copilot_guidelines/tom_ai_chat.md) and [anthropic_handler.md](anthropic_handler.md).

## Copilot Chat Workflows

Main commands:

- `tomAi.sendToCopilot`
- `tomAi.sendToCopilot.standard`
- `tomAi.sendToCopilot.template`
- `tomAi.reloadConfig`

The `@CHAT` panel's Copilot subpanel supports prompt slots (up to 4), template selection, answer-file polling, and response-value extraction.

### CHAT Action Bar

The Copilot section of `@CHAT` includes an action bar with:

- **R** (24px text input): Repeat count — how many times to send the prompt
- **W** (24px text input): Answer wait minutes — 0 for classic answer-file detection, >0 for time-based auto-advance
- **Template picker**: Select from configured prompt templates
- **Queue button**: Add to queue with current R/W settings

## Send-to-Chat Target Routing

"Send to Chat" is **not** hard-wired to Copilot. A single config key selects which transport receives the prompt:

- **Config key**: `sendToChatTarget: 'anthropic' | 'copilot'` (default `'anthropic'`), in [sendToChatConfig.ts](../src/utils/sendToChatConfig.ts) and the [JSON schema](../src/config/tom_vscode_extension.schema.json). The default-applying accessor is `getSendToChatTarget(config)`; the live value is read through `currentSendToChatTarget()`.
- **Router**: [sendToChatRouter.ts](../src/handlers/sendToChatRouter.ts) funnels three callers through one decision — `dispatchSendToChat` (command / context / file menus, fire-and-forget), `sendToChatForScript` (the scripting-API bridge op, returns the answer for both targets), and the chat panel's own send (via the shared busy guard in `sendToChatState.ts`).
  - **copilot** — legacy behaviour: open the Copilot chat view with the prompt; the scripting API detects the answer through the `tomAi_askCopilot` answer-file mechanism.
  - **anthropic** — handle the prompt exactly as if typed into the Anthropic chat panel: same active profile + configuration, the default user-message template, the chat-panel Agent SDK session bucket, and the full tool loop. The turn is written to `live-trail.md` and mirrored into the panel UI when open. While a turn is running, a second interactive send is **rejected** (the prompt queue owns queuing).
- **Status Page control**: the target is switchable from the Tom Status Page via the `setSendToChatTarget` action (an anthropic/copilot dropdown), so no config-file edit is needed to flip transports.
- **Scripting-API tool gating**: when the target is `copilot`, the scripting API exposes **no** tools — `scripting-tools-bridge.ts` short-circuits on `getSendToChatTarget(config) === 'copilot'`. Tools are only available on the `anthropic` target. See [bridge_scripting_guide.md](../_copilot_guidelines/bridge_scripting_guide.md) for the gating rationale.

## Prompt Queue Integration

Copilot prompts flow through the `PromptQueueManager` for sequenced dispatch:

- **File-per-entry storage**: Each queued prompt is a separate YAML file (`q_<id>.yaml`)
- **RequestId-based answer detection**: Unique IDs embedded in prompts match answer files
- **Repeat support**: `repeatCount`, `repeatPrefix`, `repeatSuffix` with placeholders `${repeatNumber}`, `${repeatIndex}`, `${repeatCount}`
- **Answer wait minutes**: Time-based auto-advance when `answerWaitMinutes > 0`
- **Automation**: Auto-send, auto-start, auto-pause, auto-continue settings
- **Watchdog**: 60s health check + 30s polling fallback for answer detection

See [user_guide.md](user_guide.md#4-prompt-queue) for full queue documentation.

## Timed Requests

The timer engine fires prompts on schedule:

- **Interval mode**: Every N minutes with optional `sendMaximum` limit
- **Scheduled mode**: At specific `HH:MM` times with optional date restriction
- **Global schedule slots**: Day-of-week and time-of-day restrictions
- Entries enqueue through `PromptQueueManager` (never send directly)

See [user_guide.md](user_guide.md#5-timed-requests) for full timer documentation.

## Tom AI Chat + Anthropic Tool Surface

Both subpanels share the Anthropic handler's tool registry. Command surface (Tom AI Chat):

- `tomAi.tomAiChat.start`
- `tomAi.tomAiChat.send`
- `tomAi.tomAiChat.interrupt`

Tool categories (all live under `src/tools/`):

- **File I/O** — `tomAi_readFile`, `tomAi_createFile`, `tomAi_editFile`, `tomAi_multiEditFile` (writes go through the approval gate).
- **Search** — `tomAi_findFiles`, `tomAi_findTextInFiles`, `tomAi_listDirectory`.
- **Guidelines + memory** — `tomAi_read*Guideline`, `tomAi_list*Guideline`, `tomAi_search*Guideline`, `tomAi_memory_*`.
- **Past-tool-access** — `tomAi_listPastToolCalls`, `tomAi_searchPastToolResults`, `tomAi_readPastToolResult` (replay keys `t1`, `t2`, …).
- **Execution** — `tomAi_runCommand`, `tomAi_runVscodeCommand` (approval-gated).
- **User surface** — `tomAi_notifyUser` (approval-gated).
- **Diagnostics + editor context** — `tomAi_getErrors`, editor-context helpers.
- **Integrations** — GitHub PR, git, issue, language-service, web fetch / search.

On the Agent SDK transport, tools are exposed via an MCP server; names carry the `mcp__tom-ai__` prefix when surfaced to `canUseTool`. Built-in Claude Code preset tools (Read/Write/Bash/Grep/…) can be enabled per profile via `useBuiltInTools: true`; their tool_use + tool_result blocks are mirrored into the raw and tool trails from the stream.

## Chat Variables and Context

Chat variables are registered via `contributes.chatVariables` and resolved through `registerChatVariableResolvers(context)`.

Current variables:

- `quest`
- `role`
- `activeProjects`
- `todo`
- `workspaceName`

## Trails and Answer Files

Copilot interactions in `@CHAT` panel can persist prompt/answer trails under `_ai/trail` and answer artifacts under configured Copilot answer folders.

Key behavior:

- answer detection for `*_answer.json` using requestId matching,
- fallback polling every 30s if file watcher misses events,
- slot-aware answer highlighting,
- optional value extraction into chat response values,
- window state tracking for multi-window status panel.

## Output Channels

Dedicated output channels provide structured logging:

- **Tom Prompt Queue**: Queue state changes, send events, answer detection, watchdog health
- **Tom Timed Requests**: Timer ticks, fire decisions, schedule evaluation, entry lifecycle

Both channels include ISO timestamps and can be enabled/disabled at runtime.

## Related Docs

- [user_guide.md](user_guide.md)
- [quick_reference.md](quick_reference.md)
- [../_copilot_guidelines/tom_ai_chat.md](../_copilot_guidelines/tom_ai_chat.md)
- [../_copilot_guidelines/copilot_answers.md](../_copilot_guidelines/copilot_answers.md)
- [../_copilot_guidelines/architecture.md](../_copilot_guidelines/architecture.md)
