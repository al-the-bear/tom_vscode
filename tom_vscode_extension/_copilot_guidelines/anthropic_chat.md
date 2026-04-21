# Anthropic Chat Panel

The **Anthropic** subpanel is one of five chat subpanels in `@CHAT` and the primary interactive surface for Anthropic-based AI interactions. It is the **only** subpanel (besides Copilot) that has queue buttons. Source: [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts) — Anthropic section at approximately `:3300`.

For the underlying handler, see [../doc/anthropic_handler.md](../doc/anthropic_handler.md) and [architecture.md](architecture.md).

## What makes the Anthropic panel distinctive

Unlike Tom AI Chat (which uses the same Anthropic handler but with a curated tool surface), the Anthropic panel exposes:

- full profile + configuration selectors,
- user-message template picker,
- live trail viewer button (opens `live-trail.md` in the MD Browser in live mode),
- session history button,
- **Add to Queue** + **Open Queue Editor** buttons,
- VS Code LM model info dropdown (when the active config is `vscodeLm`).

## Profiles and configurations

### Profiles (`AnthropicProfile`)

A profile bundles:

- system prompt,
- history mode (`sdk-managed` | `full` | `summary` | `trim_and_summary` | `llm_extract`),
- tool approval mode (`always` | `never`),
- thinking settings (enabled, budget tokens),
- prompt caching flag,
- user-message template reference (`isDefault` marks the auto-applied template),
- the active `configId` — points at either an `AnthropicConfiguration` or a `LocalLlmConfiguration`.

Stored in `config.anthropic.profiles` ([sendToChatConfig.ts](../src/utils/sendToChatConfig.ts) `:167`).

### Configurations (`AnthropicConfiguration`)

A configuration defines the concrete API call:

| `transport` field | Leaf call | Notes |
|---|---|---|
| `direct` (default) | Raw `@anthropic-ai/sdk` | Synchronous round-trip per agent loop turn |
| `agentSdk` | `@anthropic-ai/claude-agent-sdk` | SDK runs its own stream loop; session continuity via `default.session.json` |
| `vscodeLm` | `vscode.lm.selectChatModels` + `model.sendRequest` | Model identity pinned at configure-time (see below) |

Stored in `config.anthropic.configurations` ([sendToChatConfig.ts](../src/utils/sendToChatConfig.ts) `:138`).

### Local LLM configurations referenced from Anthropic profiles

A profile's `configId` may also point at a **Local LLM configuration** (`config.localLlm.configurations`). When the Anthropic handler detects this, it synthesises a runtime-only `transport: 'localLlm'` on the resolved configuration and routes to `callLocalLlmOnce` — the extracted Ollama HTTP primitive shared with `LocalLlmManager`.

**Effect:** the Anthropic handler's full loop, tool-approval gate, live trail, user-message templates, and trail directory (`_ai/trail/anthropic/*`) all apply — even though the actual API call goes to Ollama. The Local LLM panel's own flow (`ollamaGenerateWithTools`) is byte-identical to before (writes to `_ai/trail/local/*`, uses Local LLM's own template store, runs its own approval).

The profile config picker in the panel's UI merges both Anthropic configurations and Local LLM configurations, each labelled by backing type (`[direct]`, `[agentSdk]`, `[vscodeLm]`, `[localLlm]`).

## VS Code LM API configurations

When a configuration has `transport: 'vscodeLm'`, the handler calls `vscode.lm.selectChatModels()` to route through VS Code's Language Model API (e.g., GitHub Copilot's GPT-4o or claude-sonnet-4.5 seats, or any registered LM provider).

**Key design decisions:**

- **Model is pinned at configure-time**, not per send. When creating or editing a `vscodeLm` configuration, the Extension State Page's model picker calls `vscode.lm.selectChatModels()` once, the user picks a model, and `{vendor, family, modelId}` are stored on the configuration. On subsequent sends the handler filters against VS Code's cached list by `modelId` — no fresh enumeration.
- **System prompt concatenation.** VS Code LM has no separate system/user fields. The handler prepends `{systemPrompt}\n\n` to the composed user message before calling `model.sendRequest`.
- **Informational model dropdown on the panel.** When the active configuration is `vscodeLm`, the Anthropic panel's bottom area shows a dropdown listing currently available models from `vscode.lm.selectChatModels()`, plus a **Refresh** button. This is read-only — changing the selection here does NOT retarget sends. To change the target model, edit the configuration.
- **Trail directory** is the same as other Anthropic configs: `_ai/trail/anthropic/*`.

Configuration shape (relevant fields):

```ts
interface AnthropicConfiguration {
    id: string;
    name: string;
    transport: 'vscodeLm';
    model: string;          // mirrors vscodeLm.modelId for display
    vscodeLm: {
        vendor: string;     // e.g. 'copilot'
        family: string;     // e.g. 'gpt-4o'
        modelId: string;    // exact id from selectChatModels at configure-time
    };
    maxTokens: number;
    maxRounds: number;
}
```

## User-message templates

The Anthropic panel (and all Anthropic leaf paths including VS Code LM and Local-LLM-backed profiles) share **one template store**: `config.anthropic.userMessageTemplates` — an array of `{ id, name, description?, template, isDefault? }`. This is separate from the Copilot template store (`config.copilot.templates`).

- `isDefault: true` marks the template auto-applied on every send (profile-scoped default).
- Templates support placeholder expansion: `${tomAi.quest}`, `${tomAi.role}`, chat variables, `${memory}`, etc.
- The Global Template Editor's **Category** dropdown routes to the Anthropic — User Message store when selected. The template tools (`tomAi_createPromptTemplate`, etc.) accept `transport: 'anthropic'`.

## Live trail

Each `sendMessage()` call creates a `LiveTrailWriter` pointed at `_ai/quests/<quest>/live-trail.md`. The writer:

- Calls `beginPrompt()` once — trims the file to the last 5 prompt blocks and writes the new `## 🚀 PROMPT …` header.
- Appends thinking, tool calls, tool results, and assistant text incrementally as the turn runs.
- Calls `endPrompt()` with round/tool-call count and duration on completion.

The **Open Live Trail** button in the panel header fires `tomAi.openInMdBrowserLive`, which opens the current quest's `live-trail.md` in the MD Browser's live-mode singleton (auto-scroll-to-bottom on each file-watcher update).

Isolated sub-agent runs (`options.isolated = true`) receive a null writer — their intermediate work does not appear in the quest's live trail.

## Queue integration

The Anthropic panel has two queue buttons (matching the Copilot panel):

- **Add to Queue** (`data-action="addToQueue" data-id="anthropic"`) — stages a new `QueuedPrompt` with `transport: 'anthropic'`, `anthropicProfileId`, and `anthropicConfigId` pre-filled from the panel's current dropdowns.
- **Open Queue Editor** (`data-action="openQueueEditor"`) — opens the queue editor webview.

Items staged from the Anthropic panel **always pin their transport** (`transport: 'anthropic'`); they never inherit the queue default. Queue dispatch coerces `toolApprovalMode = 'never'` for all Anthropic items regardless of the profile's stored value.

See [prompt_queue_timed_templates.md](prompt_queue_timed_templates.md) for queue mechanics.

## History modes and session continuity

| Mode | Works with | Notes |
|------|-----------|-------|
| `trim_and_summary` | Direct, vscodeLm, localLlm | Default. Compacts old turns before context window fills. |
| `full` | Direct, vscodeLm, localLlm | Sends all turns verbatim. |
| `summary` | Direct, vscodeLm, localLlm | Sends only the compacted summary. |
| `llm_extract` | Direct, vscodeLm, localLlm | LLM-driven extraction of key turns. |
| `sdk-managed` | Agent SDK only | SDK owns session resumption via `default.session.json`. |

For non-`sdk-managed` modes, `rawTurns` + `compactedSummary` are injected into each outgoing message array. This means **pre-prompt answers are automatically visible to the main prompt** — no queue-level context chaining is needed.

## Tool approval

The profile's `toolApprovalMode` controls whether tool calls are routed through the in-panel approval bar (`'always'`) or auto-approved silently (`'never'`). Queue runs always use `'never'` regardless of the profile setting.

The approval gate is part of the Anthropic handler's shared loop and applies to all four leaf paths (Direct, Agent SDK, VS Code LM, Local LLM). The Local LLM panel's own `ollamaGenerateWithTools` has its own separate approval handling that is unchanged.

## Output channels

- **Tom AI** — assistant text + tool summaries for the Anthropic panel's turns.
- **Tom AI Log** — debug / timing details.
- Raw trail: `_ai/trail/anthropic/<quest>/<requestId>.*`.

## Operational notes for agents

- `resolveAnthropicTargets(profileId, configId)` in `src/utils/resolveAnthropicTargets.ts` is the single resolver for `(profile, configuration)` pairs. Use it instead of duplicating the Anthropic-then-LocalLlm fallback chain.
- When adding a new Anthropic leaf path, plug it into `AnthropicHandler.sendMessage()` as a fourth leaf primitive (join the shared agent loop, not `ollamaGenerateWithTools`).
- Both `vscodeLm` and Local-LLM-backed configs are **Anthropic-profile-level** concerns. They write to `_ai/trail/anthropic/*` and use Anthropic user-message templates — do not create separate subsystems.
- The VS Code LM model dropdown on the panel is **informational only** — do not wire it to retarget sends.
- `tomAi.tomAiChat.*` commands route through the same `AnthropicHandler` but via a separate handler ([tomAiChat-handler.ts](../src/handlers/tomAiChat-handler.ts)) with a curated tool set. Changes to the Anthropic handler's shared loop affect both panels.
