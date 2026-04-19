# Multi-Transport Prompt Queue — design (revised v2)

> **Revision note (v2, 2026-04-19).** This version collapses the queue's
> transport model to exactly two entries — **Copilot** and **Anthropic**.
> VS Code LM is folded in as a new *Anthropic configuration type*; existing
> Local LLM configurations are surfaced inside the Anthropic profile's
> config picker. The Anthropic handler runs a single shared agent loop
> over four *leaf primitives* — Direct, Agent SDK, VS Code LM, Local LLM —
> each of which is a pure one-round API call. The queue sees only
> `anthropic`. The Tom AI Chat and Local LLM panels stay exactly as they
> are: no queueing buttons, no queue targets, behaviour byte-identical.
> The Local LLM leaf is an additive extraction from
> `ollamaGenerateWithTools` — the panel's public entry point is untouched.
> Previous §4.2.1 (Tom AI Chat dispatcher refactor) and the entire Phase 2
> panel-consolidation plan (§9) are removed as obsolete. Open questions
> section (§6.1) is removed — all three prior questions are resolved in
> the design above. All code references have been re-anchored against the
> current tree (post-commit `2a1943a`, 2026-04-19).

## 1. Goal

Today the prompt queue only routes to **Copilot Chat**. Prompts are wrapped with an answer-file template, dispatched via `workbench.action.chat.open`, and advance when an answer JSON appears in the Copilot answer directory. We want the same queue to also route through the **Anthropic** handler, which itself forks into four concrete API calls based on the active Anthropic profile's selected configuration:

- **Direct** — `@anthropic-ai/sdk` (existing).
- **Agent SDK** — `@anthropic-ai/claude-agent-sdk` (existing).
- **VS Code LM** — `vscode.lm.selectChatModels` + `model.sendRequest` (new configuration type).
- **Local LLM (Ollama)** — `LocalLlmManager.instance.ollamaGenerateWithTools` (existing Local LLM configuration, referenced from the Anthropic profile's config picker).

From the queue's perspective there are **two transports**: `copilot` and `anthropic`. The four-way fork happens inside `AnthropicHandler.sendMessage()` based on `configuration.type` (or the reference to a Local LLM config); the queue does not care which leaf path ran.

**What stays out.** The Tom AI Chat panel and the Local LLM panel are **not** queue targets and do **not** gain queueing buttons. The AI Conversation panel is also excluded — it orchestrates bot-to-bot exchanges and runs its own multi-turn loop.

**No parallel execution across transports** — a single ordered queue is sufficient.

## 2. Design decisions

1. **Two transports only.** Queue items carry `transport: 'copilot' | 'anthropic'` (default `'copilot'`). Per-item transport lets a single ordered workflow interleave transports ("plan with Claude → run 3 tasks via Copilot").
2. **VS Code LM is a new Anthropic configuration type.** The `AnthropicConfiguration.type` enum grows from `'direct' | 'agentSdk'` to `'direct' | 'agentSdk' | 'vscodeLm'`. A `vscodeLm` configuration carries the selector params for `vscode.lm.selectChatModels` (`vendor`, `family`, optional `id`). Trails land in the same `_ai/trail/anthropic/*` directory as the other two types.
3. **Local LLM configurations are referenced from Anthropic profiles.** The Local LLM config schema is unchanged and lives where it lives today. The Anthropic profile's config picker widens its source: it lists Anthropic configurations AND existing Local LLM configurations, labelled by backing type. Selecting a Local LLM config on an Anthropic profile swaps only the final API call — prompt composition, tool approval, live trail, trail-file layout, user-message templates, and the queueing UI are the Anthropic panel's.
4. **Direct responses, no synthetic answer files.** For `anthropic` items, `sendItem()` awaits `AnthropicHandler.sendMessage()` and stores the returned text on the queue item. The polling loop is bypassed for anthropic items.
5. **Transport-owned trails.** AnthropicHandler already writes prompt + answer + tool-call + live-trail entries for the Direct and Agent SDK paths. The new `vscodeLm` branch and the Local-LLM-referencing branch reuse the same trail writers (same subsystem, same directory). The queue does not duplicate trails.
6. **Anthropic-only features dropped for direct transport**: answer-wrapper template, reminders, `answerWaitMinutes`, `expectedRequestId`, polling loop. All Copilot-specific.
7. **Queue-dispatched anthropic items force auto-approve-all.** Queue execution is unattended — any tool call that triggers the approval bar would deadlock the queue. The dispatcher sets `toolApprovalMode = 'never'` regardless of the profile's stored value. The field's only legal values are `'always' | 'never'` — see [sendToChatConfig.ts:187](../src/utils/sendToChatConfig.ts#L187). The UI must surface this (see §4.10).
8. **Shared prompt composition, APIs that don't separate system/user get concatenated.** The Anthropic panel's rules apply to every leaf path: profile system prompt + user-message template + user prompt = final composed prompt. When the leaf API (VS Code LM, Local LLM) doesn't take a separate `system` field, the handler concatenates `{systemPrompt}\n\n{userText}` before the call. Direct and Agent SDK keep using the structured fields they already take.
9. **Two template stores, full stop.** Copilot keeps `config.copilot.templates`; all Anthropic profiles — no matter which configuration type — share `config.anthropic.userMessageTemplates`. No new "shared" store, no per-configuration-type templates.
10. **Only the Anthropic and Copilot panels carry queue buttons.** Copilot already has them. **This phase adds the same two buttons to the Anthropic panel.** Tom AI Chat, Local LLM, and AI Conversation panels are untouched.

## 3. Current state reference

| Concern | Where |
| --- | --- |
| Queue manager | [promptQueueManager.ts](../src/managers/promptQueueManager.ts) (2621 lines) |
| `QueuedFollowUpPrompt` / `QueuedPrePrompt` / `QueuedPrompt` interfaces | [lines 54 / 69 / 83](../src/managers/promptQueueManager.ts#L54) |
| `_buildExpandedText()` (template + answer-wrapper expansion) | [line 308](../src/managers/promptQueueManager.ts#L308) |
| `pollForExpectedAnswer()` answer-file polling loop | [line 583](../src/managers/promptQueueManager.ts#L583) (kicked off at lines 538, 580) |
| `enqueue()` | [line 1240](../src/managers/promptQueueManager.ts#L1240) |
| `continueSending()` | [line 1670](../src/managers/promptQueueManager.ts#L1670) |
| `sendItem()` — main dispatch | [line 1945](../src/managers/promptQueueManager.ts#L1945) |
| `workbench.action.chat.open` calls (pre / main / follow-up) | [lines 2043 / 2079 / 2118](../src/managers/promptQueueManager.ts#L2043) |
| Queue editor webview | [queueEditor-handler.ts](../src/handlers/queueEditor-handler.ts) (1429 lines) |
| Reminder bindings | [queueEditor-handler.ts:197-205, 268, 287-289, 347-350, 368-371, 391-394, 412-415](../src/handlers/queueEditor-handler.ts#L197) |
| `answerWaitMinutes` message payload | [queueEditor-handler.ts:328, 390, 411](../src/handlers/queueEditor-handler.ts#L328) |
| Anthropic entry point | [anthropic-handler.ts:868](../src/handlers/anthropic-handler.ts#L868) — `async sendMessage(options: AnthropicSendOptions): Promise<AnthropicSendResult>` |
| Anthropic direct branch | [anthropic-handler.ts:1313-1314](../src/handlers/anthropic-handler.ts#L1313-L1314) |
| Anthropic Agent SDK branch | [anthropic-handler.ts:1019-1098](../src/handlers/anthropic-handler.ts#L1019-L1098) |
| `AnthropicSendOptions` / `AnthropicSendResult` | [line 152](../src/handlers/anthropic-handler.ts#L152) / [line 328](../src/handlers/anthropic-handler.ts#L328) |
| `AnthropicConfiguration` schema | [anthropic-handler.ts:60+](../src/handlers/anthropic-handler.ts#L60) and `sendToChatConfig.ts` |
| `ANTHROPIC_SUBSYSTEM` literal | [anthropic-handler.ts:176](../src/handlers/anthropic-handler.ts#L176) |
| Local LLM entry point | [localLlm-handler.ts:840](../src/handlers/localLlm-handler.ts#L840) — `public async ollamaGenerateWithTools(options, userPrompt): Promise<{ text, stats?, toolCallCount, turnsUsed }>` |
| Local LLM configurations | [sendToChatConfig.ts:59-76](../src/utils/sendToChatConfig.ts#L59-L76) |
| Anthropic configurations | [sendToChatConfig.ts:138-166](../src/utils/sendToChatConfig.ts#L138-L166) |
| Anthropic profiles | [sendToChatConfig.ts:167-190](../src/utils/sendToChatConfig.ts#L167-L190) |
| Anthropic user-message templates | [sendToChatConfig.ts:191-197](../src/utils/sendToChatConfig.ts#L191-L197) |
| Panel section definitions | [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts): localLlm [:3170](../src/handlers/chatPanel-handler.ts#L3170), conversation (AI Conv) [:3190](../src/handlers/chatPanel-handler.ts#L3190), copilot [:3213](../src/handlers/chatPanel-handler.ts#L3213), tomAiChat [:3281](../src/handlers/chatPanel-handler.ts#L3281), anthropic [:3300](../src/handlers/chatPanel-handler.ts#L3300) |
| Existing queue buttons (Copilot only) | [chatPanel-handler.ts:3231](../src/handlers/chatPanel-handler.ts#L3231) |
| `addToQueue` / `openQueueEditor` backend router | [chatPanel-handler.ts:675, 678](../src/handlers/chatPanel-handler.ts#L675) |
| Webview-side `addToQueue` dispatcher | [chatPanel-handler.ts:3596](../src/handlers/chatPanel-handler.ts#L3596) |
| `addCopilotToQueue()` (stages the item) | [chatPanel-handler.ts:4154](../src/handlers/chatPanel-handler.ts#L4154) |

## 4. Required changes

### 4.1 Data model — `promptQueueManager.ts`

Add to `QueuedPrompt` ([:83](../src/managers/promptQueueManager.ts#L83)), `QueuedPrePrompt` ([:69](../src/managers/promptQueueManager.ts#L69)), `QueuedFollowUpPrompt` ([:54](../src/managers/promptQueueManager.ts#L54)):

```ts
transport?: 'copilot' | 'anthropic';     // default 'copilot'
anthropicProfileId?: string;             // Anthropic profile id
anthropicConfigId?: string;              // may reference an Anthropic config OR a Local LLM config
answerText?: string;                     // captured direct response (not written by Copilot path)
```

All four fields optional. Items without `transport` behave exactly like today.

`anthropicConfigId` is intentionally a single loosely-typed id — it can point at an Anthropic configuration (`direct` / `agentSdk` / `vscodeLm`) or at a Local LLM configuration. The handler resolves the id against both stores when dispatching.

### 4.2 New Anthropic configuration type: `vscodeLm`

Extend `AnthropicConfiguration.type` from `'direct' | 'agentSdk'` to `'direct' | 'agentSdk' | 'vscodeLm'`. A `vscodeLm` configuration stores the model identity at configure-time:

```ts
interface VsCodeLmConfiguration extends AnthropicConfigurationBase {
    type: 'vscodeLm';
    vendor: string;           // e.g. 'copilot'
    family: string;           // e.g. 'gpt-4o' or 'claude-sonnet-4.5'
    modelId: string;          // exact id picked at configure-time
    maxTokens?: number;       // optional; falls back to the model's advertised max
}
```

**Model resolution happens at configure-time, NOT per send.** When the user creates or edits a `vscodeLm` configuration on the Extension State Page, the form's model picker calls `vscode.lm.selectChatModels()` once to list available models; the user's selection is stored as `{vendor, family, modelId}` on the configuration. On subsequent sends, the handler calls `selectChatModels({ vendor, family })` and picks the entry whose `id === modelId` — this is a cheap filter against an already-cached-by-VS-Code list, not a fresh enumeration across providers.

**Trail directory is the same** as the other two types (`_ai/trail/anthropic/*`), because from the user's perspective this is still "an Anthropic configuration" — it just happens to route to VS Code's LM API.

JSON schema + `SendToChatConfig` type updated accordingly. The Extension State Page's Anthropic configurations section gains the new type as a picker option; the rest of the form adapts to the reduced field set.

### 4.3 Anthropic profile config picker — widened source

The Anthropic profile's `configId` dropdown today sources only from `config.anthropic.configurations`. It must now also list entries from `config.localLlm.configurations` ([sendToChatConfig.ts:59-76](../src/utils/sendToChatConfig.ts#L59-L76)), with a visible backing-type label so the user knows which path they're pinning. The Local LLM configuration schema itself is **not** changed.

Resolution order inside `AnthropicHandler.sendMessage()` when handling `profile.configId`:

1. Look it up in `config.anthropic.configurations`. If found → dispatch to the type-specific branch (Direct / Agent SDK / VS Code LM).
2. Otherwise look it up in `config.localLlm.configurations`. If found → dispatch to the Local LLM branch.
3. Otherwise → error.

### 4.4 `AnthropicHandler.sendMessage` — shared loop with four leaf primitives

The Anthropic handler owns everything **around** the API call for all four leaves: prompt composition (profile system prompt + user-message template + user prompt), `rawTurns` / `compactedSummary` history injection, the tool-approval gate, the agent loop (repeated calls until the model stops producing `tool_use` blocks), raw trail + live trail + built-in-tool persistence, `AnthropicSendResult` shape. **Only the "one API round-trip" primitive differs per leaf.**

The four leaf primitives:

```ts
// Direct — already exists, today baked into the direct branch.
callDirectOnce(messages, tools, config): Promise<ResponseBlocks>

// Agent SDK — special case. The SDK runs its OWN loop, so this leaf
// hands the whole stream off (as today) rather than participating in
// the shared loop. It still uses the Anthropic handler's live-trail
// writer and approval bridge via the callback seam we already have.
runAgentSdkQuery(...): AgentSdkResult   // unchanged

// VS Code LM — NEW.
callVsCodeLmOnce(messages, tools, config): Promise<ResponseBlocks>

// Local LLM — extracted from ollamaGenerateWithTools (see below).
callLocalLlmOnce(messages, tools, config): Promise<ResponseBlocks>
```

Each primitive takes already-composed messages + tool schemas, calls its API exactly once, and returns a block array in Anthropic's content-block shape (`text`, `tool_use`, `thinking`). The shared loop in `sendMessage` stitches rounds together, runs the approval gate on any `tool_use` block, dispatches the tool, appends `tool_result` to the next round's messages, and repeats until there are no more `tool_use` blocks.

**VS Code LM branch.** When `configuration.type === 'vscodeLm'`, `callVsCodeLmOnce`:

```ts
// Resolve the pinned model (cheap — selectChatModels here filters against
// a VS Code-cached list, not an enumeration across providers).
const [model] = (await vscode.lm.selectChatModels({ vendor, family }))
    .filter((m) => m.id === modelId);
if (!model) throw new Error('VS Code LM model not available');

// VS Code LM has no separate system/user split — concatenate per §2.8.
const lastUser = messages[messages.length - 1];
const combinedUser = systemPrompt ? `${systemPrompt}\n\n${lastUser.content}` : lastUser.content;

const chatMessages = [
    ...priorHistory.map(toLMChatMessage),           // prior tool_use / tool_result rounds
    vscode.LanguageModelChatMessage.User(combinedUser),
];
const request = await model.sendRequest(chatMessages, { tools: toLMTools(tools) }, token);
// Collect text + tool-call fragments from request.stream, return as Anthropic-shaped blocks.
```

**Local LLM branch.** When `configuration` resolves to a Local LLM config, `callLocalLlmOnce` is a *new extracted primitive* from the existing `ollamaGenerateWithTools` implementation — see §4.4a.

All three self-looped leaves (Direct / VS Code LM / Local LLM) share the same tool-approval bridge, live-trail writer, and built-in-tool-persistence hooks already wired for the Direct branch. `AnthropicSendResult`'s shape is unchanged for callers (queue and chat panel).

### 4.4a Local LLM extraction — additive, panel behaviour unchanged

Today `LocalLlmManager.instance.ollamaGenerateWithTools` at [localLlm-handler.ts:840](../src/handlers/localLlm-handler.ts#L840) bakes everything into one call: prompt composition, tool loop, approval, logging, the Ollama HTTP call. The Anthropic handler's Local LLM leaf needs only the **HTTP call** part.

**Refactor:**

```text
ollamaGenerateWithTools(opts, userPrompt)            ← existing public entry point
  ├─ composes prompt / handles templates / …
  ├─ runs its own tool loop
  └─ calls NEW: callLocalLlmOnce(messages, tools)    ← extracted primitive
                  └─ HTTP POST to Ollama, returns one response
```

`ollamaGenerateWithTools`'s public surface, return type, and behaviour are **unchanged**. The **Local LLM panel** continues to call it exactly as today — same template handling, same tool approval, same trail writes to the Local LLM subsystem. The extraction is purely internal: we expose `callLocalLlmOnce(messages, tools, config)` as an additional entry point on the Local LLM manager and make the existing `ollamaGenerateWithTools` delegate to it internally for the actual HTTP call.

The Anthropic handler's Local LLM leaf then calls `callLocalLlmOnce` directly and participates in the Anthropic handler's shared loop — inheriting Anthropic's approval gate, trail directory (`_ai/trail/anthropic/*`), live trail, and user-message templates.

**Net effect:**

- Local LLM panel flow: byte-identical. Still hits `ollamaGenerateWithTools`, still logs to `_ai/trail/local/*`, still uses Local LLM's own template store, still owns its approval flow.
- Local-LLM-backed Anthropic profile flow: runs through the Anthropic handler's loop, writes to `_ai/trail/anthropic/*`, uses Anthropic user-message templates, uses Anthropic's approval gate (coerced to `'never'` by the queue dispatcher).
- Shared piece between the two flows: the `callLocalLlmOnce` HTTP primitive and the Local LLM *configurations* (how they're stored and loaded).

### 4.5 Transport dispatcher

A small local helper inside `promptQueueManager.ts` — **not** a new cross-handler abstraction. Signature:

```ts
async function dispatchStage(
  item: QueuedPrompt,
  stage: 'pre' | 'main' | 'followUp',
  indexOrId: number | string,
  expandedText: string,
): Promise<
  | { mode: 'polled'; expectedRequestId: string }     // copilot
  | { mode: 'direct'; answerText: string }            // anthropic
>
```

Inside the helper:

```ts
const transport = resolveStageTransport(item, stage);  // stage > item > queue default > 'copilot'
if (transport === 'copilot') {
  // Current flow: extract requestId, chat.open, return { mode: 'polled' }
}
// transport === 'anthropic'
const { profile, configuration, tools } = resolveAnthropicTargets(item, stage);
const coercedProfile = { ...profile, toolApprovalMode: 'never' as const };  // §2 decision 7
const result = await AnthropicHandler.instance.sendMessage({
  userText: expandedText, profile: coercedProfile, configuration, tools,
});
return { mode: 'direct', answerText: result.text };
```

`resolveAnthropicTargets()` hands the profile's `configId` to the resolver described in §4.3; the caller doesn't need to know which leaf path will run.

### 4.6 `sendItem()` refactor

- Before calling `dispatchStage()`, **conditionally expand** the text. `_buildExpandedText()` at [promptQueueManager.ts:308](../src/managers/promptQueueManager.ts#L308) already handles the Copilot answer-wrapper case — split its behaviour:
  - Copilot: current behaviour (apply template + answer wrapper → `expandedText`).
  - Anthropic: apply the named template if any, **skip** `__answer_file__` wrapping and skip the `answerWrapper` boolean (both are Copilot-only constructs).
- After `dispatchStage()`:
  - `{ mode: 'polled' }`: record `expectedRequestId` and let the existing poll loop drive `continueSending()` at [:1670](../src/managers/promptQueueManager.ts#L1670).
  - `{ mode: 'direct' }`: store `answerText` on the item/stage (reuse the existing `prePrompts[i].status = 'sent'` / follow-up `repeatIndex++` machinery), then call `continueSending()` synchronously.
- On anthropic-transport failure: set item status `'error'` and surface the error message.
- The dispatcher **always** coerces `toolApprovalMode = 'never'` for anthropic items (see §2 decision 7) — regardless of whether the leaf path is Direct, Agent SDK, VS Code LM, or Local LLM.

### 4.7 Per-transport skips

When `transport === 'anthropic'`, the queue bypasses:

| Feature | Copilot behaviour | Anthropic behaviour |
| --- | --- | --- |
| `answerWrapper` + `__answer_file__` template | applied at `_buildExpandedText` ([:308](../src/managers/promptQueueManager.ts#L308)) | **not applied** |
| `expectedRequestId` extraction | required | skipped |
| Answer-file polling | `pollForExpectedAnswer()` ([:583](../src/managers/promptQueueManager.ts#L583)) watches directory | **not started** for this item |
| Reminders (`reminderEnabled`, `reminderTemplateId`, …) | enqueue reminder prompts on timeout | **ignored** (UI warns) |
| `answerWaitMinutes` auto-advance | triggers after N min without answer | **ignored** (response is synchronous) |

Implementation: `isDirectTransport(item)` / `isDirectStage(item, stage)` guard in `sendItem()`, `pollForExpectedAnswer()`, reminder scheduler, and answer-wait timer.

### 4.8 Polling-loop guard

`pollForExpectedAnswer()` already skips items with no `expectedRequestId`. Defensive belt-and-suspenders: also skip any item where `transport === 'anthropic'` so a mis-constructed item can never be matched against an unrelated answer file.

### 4.9 Trail integration

No queue-side changes — transports own it.

- **Copilot**: unchanged. The answer file IS the trail entry (and the existing `_ai/trail/copilot/` pipeline picks it up).
- **Anthropic (all four leaf paths)**: `sendMessage()` writes `ANTHROPIC_SUBSYSTEM` raw + summary trails for every branch (Direct, Agent SDK, VS Code LM, Local LLM). The queue does nothing.

If a trail consumer ever needs to know which leaf path a particular entry came from, the raw trail payload already records the configuration (model/type) — no separate subsystem needed.

### 4.10 Queue editor UI — `queueEditor-handler.ts`

**Header row — queue-level defaults** (new, above the existing toolbar):

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Default transport: [ Copilot ▾ ]                                   │
│  [Anthropic selected → ] Profile: [ ▾ ]  Config: [ ▾ ]              │
└─────────────────────────────────────────────────────────────────────┘
```

The `Config` dropdown contains both Anthropic configurations and Local LLM configurations (see §4.3), each labelled by backing type (e.g. `[direct]`, `[agentSdk]`, `[vscodeLm]`, `[localLlm]`). The Anthropic-profile dropdown determines the default profile; the config dropdown defaults to the profile's own `configId` and can be overridden on a per-item basis.

**Per-item form — advanced section** (collapsed by default):

```text
▶ Advanced
    Transport: [ inherit (Copilot) ▾ ]
    [if Anthropic] Profile, Config pickers
```

- Default value `inherit` → the stage uses the queue-level transport.
- Any explicit value overrides for this item/stage.
- When transport is `anthropic`, **disable** the Reminder dropdown and `answerWaitMinutes` input (with a tooltip explaining why). Reminder bindings currently live at [queueEditor-handler.ts:197-205, 268, 287-289, 347-350, 368-371, 391-394, 412-415](../src/handlers/queueEditor-handler.ts#L197); `answerWaitMinutes` at [:328, 390, 411](../src/handlers/queueEditor-handler.ts#L328).

**Per-stage override** (pre-prompts and follow-ups): apply the same collapsible "Advanced" section inside each stage's editor. Default to inherit-from-item. Three levels of resolution: stage > item > queue default > `'copilot'`.

**Auto-approve warning**: when the user picks `Anthropic` as the queue-level or item-level transport, render a visible notice directly below the transport dropdown:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored. The queue cannot pause for the approval bar.

No checkbox to disable it. See §2 decision 7.

**Display of direct responses**: when `item.answerText` exists (anthropic transport), show it inline under the item (truncated preview + expand-to-full button). The authoritative trail is the Anthropic trail file, but seeing the text in the queue itself is the practical way to inspect what happened.

### 4.11 Anthropic panel — queueing buttons

The Copilot section already carries the queue buttons at [chatPanel-handler.ts:3231](../src/handlers/chatPanel-handler.ts#L3231):

```html
<button data-action="addToQueue"       data-id="copilot" …>
<button data-action="openQueueEditor"  data-id="copilot" …>
```

**Change:** add the same two buttons to the **Anthropic** section at [:3300](../src/handlers/chatPanel-handler.ts#L3300), with `data-id="anthropic"`. That is the entire per-panel scope of this phase. Tom AI Chat ([:3281](../src/handlers/chatPanel-handler.ts#L3281)), Local LLM ([:3170](../src/handlers/chatPanel-handler.ts#L3170)), and AI Conversation ([:3190](../src/handlers/chatPanel-handler.ts#L3190)) sections are unchanged.

In the `addToQueue` handler (currently `addCopilotToQueue()` at [:4154](../src/handlers/chatPanel-handler.ts#L4154), wired from the webview dispatcher at [:3596](../src/handlers/chatPanel-handler.ts#L3596)), dispatch by `data-id`. The staged queue item carries the target metadata read from that panel's own dropdowns:

| `data-id` | `transport` set | Payload (read from that panel's dropdowns) |
| --- | --- | --- |
| `copilot` | `'copilot'` | `template`, `answerWrapper`, `repeatCount`, `answerWaitMinutes` (current) |
| `anthropic` | `'anthropic'` | `anthropicProfileId`, `anthropicConfigId`, `template` |

The backend's queue-add router (`case 'addToQueue'` at [:675](../src/handlers/chatPanel-handler.ts#L675)) forwards all new fields into `PromptQueueManager.enqueue()` ([:1240](../src/managers/promptQueueManager.ts#L1240)) unchanged. A queue item staged from the Anthropic panel **must** pin its transport — it should never inherit the queue's default.

`openQueueEditor` (`case 'openQueueEditor'` at [:678](../src/handlers/chatPanel-handler.ts#L678)) is unchanged — opens the same queue editor regardless of which panel's button was clicked.

### 4.12 Anthropic panel — VS Code LM model dropdown (informational)

When the active configuration has `type === 'vscodeLm'`, the Anthropic panel's bottom area (where the profile/config pickers live) surfaces a dropdown listing the models currently available via `vscode.lm.selectChatModels()`, **purely for informational purposes** — it shows the user what's on offer in their VS Code LM provider set right now.

A small **Refresh** button sits next to the dropdown. The dropdown only calls `selectChatModels` on:

1. First render of the Anthropic panel when a `vscodeLm` configuration is active.
2. The user clicking Refresh.

**Sends don't touch this dropdown.** The actual model used on send is the `modelId` stored on the active configuration — decided at configure-time (§4.2). Changing the selected entry here does not retarget sends; it's a browser, not a control. (If the user wants to change the target model, they edit the configuration.)

- For Direct / Agent SDK configurations, the existing model-string handling applies (no new dropdown).
- For Local-LLM-backed configurations, the existing Local LLM config owns its own model field; the Anthropic panel's VS Code LM dropdown is hidden.

This dropdown is the only new piece of panel-side UI outside the queue buttons in §4.11. Everything else on the Anthropic panel — system prompt composition, user-message template picker, live trail viewer, trail directory — is reused as-is for every leaf path.

### 4.13 Tool surface — `chat-enhancement-tools.ts`

Extend the input schemas of the queue add/update tools with the new fields:

| Tool | Line | Purpose |
| --- | --- | --- |
| `tomAi_addQueueItem` | [:778](../src/tools/chat-enhancement-tools.ts#L778) | stage a main prompt |
| `tomAi_updateQueueItem` | [:1316](../src/tools/chat-enhancement-tools.ts#L1316) | patch fields of an existing item |
| `tomAi_sendQueueItem` | [:1398](../src/tools/chat-enhancement-tools.ts#L1398) | force-send a specific item |
| `tomAi_addQueuePrePrompt` | [:843](../src/tools/chat-enhancement-tools.ts#L843) | add a pre-prompt stage |
| `tomAi_updateQueuePrePrompt` | [:900](../src/tools/chat-enhancement-tools.ts#L900) | patch a pre-prompt |
| `tomAi_addQueueFollowUp` | [:1067](../src/tools/chat-enhancement-tools.ts#L1067) | add a follow-up stage |
| `tomAi_updateQueueFollowUp` | [:1481](../src/tools/chat-enhancement-tools.ts#L1481) | patch a follow-up |

New fields:

```ts
transport?: 'copilot' | 'anthropic';
anthropicProfileId?: string;
anthropicConfigId?: string;
```

Read-only tools that list queue state (`tomAi_listQueue` at [:1218](../src/tools/chat-enhancement-tools.ts#L1218), `tomAi_setQueueItemStatus` at [:1365](../src/tools/chat-enhancement-tools.ts#L1365), `tomAi_sendQueuedPrompt` at [:986](../src/tools/chat-enhancement-tools.ts#L986)) surface the new fields in output.

Removers (`tomAi_removeQueueItem` at [:1429](../src/tools/chat-enhancement-tools.ts#L1429), `tomAi_removeQueuePrePrompt` at [:939](../src/tools/chat-enhancement-tools.ts#L939), `tomAi_removeQueueFollowUp` at [:1526](../src/tools/chat-enhancement-tools.ts#L1526)) are unchanged.

### 4.14 Persistence / compatibility

Queue state is persisted to `_ai/local/*.prompt-panel.yaml` via `panelYamlStore.ts` ([:68-72](../src/utils/panelYamlStore.ts#L68-L72), read/write at [:151](../src/utils/panelYamlStore.ts#L151) / [:164](../src/utils/panelYamlStore.ts#L164)).

The new fields are additive optional → **no migration**. Existing queue items deserialise with `transport: undefined`, which resolves to `'copilot'` at dispatch time — identical to current behaviour.

### 4.15 Reusable TransportPicker component

Same dropdown used in:

- Queue editor — queue-level default
- Queue editor — per-item / per-stage "Advanced" override
- Prompt template editor (§4.16)

```ts
renderTransportPicker(options: {
  idPrefix: string;                      // disambiguates DOM ids
  context: 'queue-default' | 'queue-item' | 'queue-stage' | 'template-editor';
  value: TransportPickerValue;           // current selection + target ids
  showTargets: boolean;                  // render profile/config dropdowns?
  onChangeEvent: string;                 // postMessage type
}): string;   // HTML fragment
```

**Option set per context:**

| Context | Dropdown options | Has inherit/default option? |
| --- | --- | --- |
| `queue-default` | Copilot, Anthropic | no |
| `queue-item` | *Inherit (queue default)*, Copilot, Anthropic | yes, **Inherit** |
| `queue-stage` | *Inherit (item)*, Copilot, Anthropic | yes, **Inherit** |
| `template-editor` | Copilot, Anthropic | no |

**Conditional target pickers** (`showTargets: true`):

- Copilot → no target dropdowns (answer-file pipeline is fixed).
- Anthropic → profile dropdown + config dropdown. The config dropdown is widened per §4.3 (Anthropic configs + Local LLM configs, labelled).

In the **template editor** (§4.16), `showTargets` is **`false`** — templates don't pin a profile/config; they're applied at queue time.

The picker emits `{ type: onChangeEvent, transport, anthropicProfileId?, anthropicConfigId? }` on any change.

### 4.16 Prompt template editor — per-transport templates

Two template stores, each retaining its existing shape:

| Transport | Config key | Shape |
| --- | --- | --- |
| Copilot | `config.copilot.templates` ([:118-122](../src/utils/sendToChatConfig.ts#L118-L122)) | map `{ [name]: { template, showInMenu? } }` |
| Anthropic | `config.anthropic.userMessageTemplates` ([:191-197](../src/utils/sendToChatConfig.ts#L191-L197)) | array `[{ id, name, description?, template, isDefault? }]` |

All Anthropic profiles — regardless of the selected configuration's leaf type — share the Anthropic store. VS Code LM and Local-LLM-backed configurations **do not get their own template stores**; they reuse the Anthropic ones.

**Template editor changes:**

1. Add a `renderTransportPicker(context: 'template-editor', showTargets: false)` at the top. Its value selects which store the editor is reading/writing.
2. The edit form is the same shape as today's Copilot form for both stores — name + body — because both stores already store body-only templates (the Anthropic array entries carry an id + description but the editable surface is still `template`).
3. Extend the four template tools (`tomAi_listPromptTemplates` at [:1752](../src/tools/chat-enhancement-tools.ts#L1752), `tomAi_createPromptTemplate` at [:1771](../src/tools/chat-enhancement-tools.ts#L1771), `tomAi_updatePromptTemplate` at [:1799](../src/tools/chat-enhancement-tools.ts#L1799), `tomAi_deletePromptTemplate` at [:1833](../src/tools/chat-enhancement-tools.ts#L1833)) with a `transport?: 'copilot' | 'anthropic'` field, default `'copilot'` for backward compatibility.

**Queue editor — template dropdown:**

- When a queue item's effective transport is known, the template dropdown filters its contents to that transport's store.
- Changing a queue item's transport **blanks** the template selection (see §5 edge case). The dropdown repopulates with templates for the new transport.

## 5. Edge cases and non-obvious bits

- **Template expansion placeholders** (`${repeatNumber}`, `${repeatIndex}`, chat variables): handled at expand-time inside `_buildExpandedText` at [promptQueueManager.ts:308](../src/managers/promptQueueManager.ts#L308) — unchanged. Chat-variable-driven `repeatCount` keeps working identically on both transports.
- **Pre-prompts with anthropic transport**: each pre-prompt awaits its own direct call. Because direct calls are synchronous, the pre-prompt chain runs back-to-back without polling gaps. This is much faster than the Copilot flow, which waits 30-second poll intervals between stages. May surprise users — consider documenting in the queue editor's help text.
- **Pre-prompt context carries automatically** (anthropic transport). The Anthropic handler already preserves turn history across calls: Direct / VS Code LM / Local LLM leaves use `rawTurns` + `compactedSummary` (appended on every non-isolated `sendMessage`), and the Agent SDK leaf uses its own session continuity via `default.session.json`. A pre-prompt's answer is therefore visible to the main prompt without any queue-level chaining or placeholder machinery — the user just writes pre-prompt and main prompt naturally, and the handler stitches them into one conversation. This is symmetric with how Copilot pre-prompts behave (Copilot carries session state via `workbench.action.chat.open`). No action needed at the queue layer.
- **Template reference invalidated when transport changes.** Template names are meaningful only within one transport's store. Switching a queue item's transport in the editor clears its template selection and repopulates from the new transport's store. Do **not** auto-copy templates across stores — the two shapes overlap but aren't identical, and silent conversion is too magical.
- **`toolApprovalMode` coercion covers every Anthropic leaf path.** Direct, Agent SDK, VS Code LM, Local LLM — all honour `'never'` when called from the queue. The coercion happens *before* `AnthropicHandler.sendMessage` dispatches into a leaf primitive, so the shared loop receives the already-coerced value. Each leaf primitive participates in the Anthropic handler's own approval gate rather than its own — which is why the Local LLM extraction (§4.4a) is necessary: `callLocalLlmOnce` is the pure HTTP call with no approval inside it.
- **Concurrency**: the queue is strictly sequential (one `sending` item at a time). Anthropic transport doesn't change this.
- **Failure modes**:
  - Anthropic API error (any leaf) → item status `'error'`, error message surfaced, queue pauses.
  - `vscode.lm.selectChatModels` returns no entry matching the configuration's stored `modelId` → surface "VS Code LM model not available", pause queue, do not retry. (The stored model was valid at configure-time but the provider extension may have been uninstalled.)
  - `anthropicConfigId` references a config that no longer exists in either the Anthropic or Local LLM config store → dispatcher returns a clear error without touching the transport.
- **`tomAi_askCopilot` inside an Anthropic queue item**: valid — the Anthropic call can still use the `askCopilot` tool which bounces a sub-question into Copilot Chat. That's pre-existing behaviour, just not the queue's main-prompt transport.

## 6. Step-by-step implementation order

1. **Data model** — add the four optional fields (§4.1). One commit; no behaviour change yet.
2. **New `vscodeLm` configuration type** (§4.2) — schema + JSON-schema + `SendToChatConfig` + Extension State Page editor with a configure-time model picker. No dispatch wiring yet.
3. **Local LLM extraction** (§4.4a) — extract `callLocalLlmOnce(messages, tools, config)` from `ollamaGenerateWithTools`. Existing `ollamaGenerateWithTools` delegates to it internally; **panel behaviour must be byte-identical** before and after this commit. Verify by exercising the Local LLM panel end-to-end.
4. **AnthropicHandler shared loop + leaf primitives** (§4.4) — generalise the Direct branch's agent loop to call a leaf primitive; plug in `callVsCodeLmOnce` and `callLocalLlmOnce`. Leaf primitives must feed the same live-trail / tool-approval / built-in-tool-persistence hooks the Direct branch already uses.
5. **Anthropic profile config picker widens** (§4.3) — lists Anthropic + Local LLM configs with type labels. Resolver falls back across both stores.
6. **Transport dispatcher + `sendItem()` branch** (§4.5, §4.6) — two-way. Default `'copilot'` preserves byte-identical behaviour.
7. **Polling / reminder / answer-wait guards** (§4.7, §4.8) — skip anthropic items in all three.
8. **Anthropic panel queueing buttons** (§4.11) — mirror the Copilot section's two buttons; dispatch on `data-id="anthropic"`.
9. **Anthropic panel VS Code LM model dropdown + Refresh button** (§4.12) — informational only; conditional on active configuration type.
10. **Queue editor UI** (§4.10) — queue-level dropdowns + per-item Advanced + auto-approve warning.
11. **Tool surface extensions** (§4.13) — expose new fields in the add/update queue tools.
12. **`renderTransportPicker()` helper** (§4.15) — new sibling to `getPromptEditorComponent`. Call sites are the queue editor and template editor.
13. **Template editor — per-transport switcher** (§4.16) — swap store on transport change.
14. **Extend the four prompt-template tools with `transport`** (§4.16) — default `'copilot'` for backward compat.
15. **Documentation** — update `llm_tools.md`, `copilot_chat_integration.md` if it exists, and this doc's "current state" once implemented.

Rough effort: **4–5 days** end-to-end. The two largest chunks are the Local LLM extraction + AnthropicHandler shared loop (steps 3–4) and the queue editor UI (step 10).

## 7. Out of scope

- **Queueing for Tom AI Chat, Local LLM, and AI Conversation panels.** These panels stay exactly as they are. If a future phase wants to integrate them, it should go through the Anthropic profile layer (e.g. surface the panel's configuration as an Anthropic config reference) rather than introducing parallel transport paths.
- **Panel consolidation.** The new two-transport model already achieves consolidation at the profile layer — no merged "LLM" panel, no twin pickers on AI Conversation. Previous §9 (Phase 2) is removed.
- **Parallel execution across transports** (a single ordered queue is sufficient).
- **Cross-transport shared `ChatTransport` interface** — a two-way dispatcher plus an internal Anthropic fork is simpler and has no other reuse target.
- **Streaming chunks to the queue** — each leaf primitive returns the full text of one round once done. If needed later, add `onChunk` callbacks inside the shared loop without touching the queue.
- **Queue-level auto-chaining of pre-prompt answers** — not needed. The Anthropic handler already carries turn history (`rawTurns` for Direct / VS Code LM / Local LLM; session id for Agent SDK), so a pre-prompt's answer is available to the main prompt by virtue of the existing session behaviour. No placeholder dance, no toggle.

## 8. Acceptance checklist

- [ ] `QueuedPrompt.transport` accepts only `'copilot' | 'anthropic'`; no `tomAiChat` or `localLlm` values in the queue schema.
- [ ] Anthropic queue item with a `direct` config hits the existing Direct path.
- [ ] Anthropic queue item with an `agentSdk` config hits the existing Agent SDK path.
- [ ] Anthropic queue item with a `vscodeLm` config routes through `callVsCodeLmOnce` and concatenates `{systemPrompt}\n\n{userText}`.
- [ ] Anthropic queue item whose `anthropicConfigId` points at a Local LLM config runs through `callLocalLlmOnce` under the Anthropic handler's shared loop (same concatenation rule, same approval gate, same live trail).
- [ ] Local LLM panel behaviour is **byte-identical** before and after the `callLocalLlmOnce` extraction — still hits `ollamaGenerateWithTools`, still logs to `_ai/trail/local/*`, still owns its own template / approval / tool loop.
- [ ] All four Anthropic leaf paths write to `_ai/trail/anthropic/*` (single subsystem).
- [ ] All four Anthropic leaf paths honour the Anthropic panel's live trail, tool approval (coerced to `'never'` for queue runs), and user-message template rules.
- [ ] Anthropic handler carries pre-prompt context into the main prompt automatically via `rawTurns` / Agent SDK session — no queue-level chaining code needed.
- [ ] VS Code LM model is resolved at configure-time (stored as `{vendor, family, modelId}` on the configuration); sends do NOT enumerate available models.
- [ ] Anthropic panel has "Add to Queue" + "Open Queue Editor" buttons matching the Copilot section.
- [ ] Anthropic panel surfaces an informational VS Code LM model dropdown + Refresh button when the active configuration is of type `vscodeLm`, and hides it otherwise. The dropdown does NOT retarget sends.
- [ ] Tom AI Chat, Local LLM, and AI Conversation panels are byte-identical to before this change (no new buttons, no new pickers).
- [ ] Queue-dispatched anthropic items run with `toolApprovalMode = 'never'` — verified by a tool call that would otherwise prompt.
- [ ] Queue editor's default-transport dropdown has two entries: Copilot and Anthropic.
- [ ] Queue editor's Anthropic config dropdown lists Anthropic configurations AND Local LLM configurations, each labelled by backing type.
- [ ] Template editor's transport picker has two entries; switching swaps the store (Copilot templates ↔ Anthropic user-message templates).
- [ ] Existing Copilot queue items are byte-identical in behaviour (template wrapper, answer-file polling, reminders, answer-wait).
- [ ] Reminder + `answerWaitMinutes` fields are visibly disabled for anthropic-transport items.
- [ ] Selecting Anthropic transport shows the auto-approve-all warning.
- [ ] `tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_addQueuePrePrompt`, `tomAi_updateQueuePrePrompt`, `tomAi_addQueueFollowUp`, `tomAi_updateQueueFollowUp`, `tomAi_sendQueueItem` accept `transport`, `anthropicProfileId`, `anthropicConfigId`.
- [ ] `tomAi_listQueue` returns the new fields in its output.
- [ ] `tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate` honour a `transport` field, defaulting to `copilot` when absent.
- [ ] A queue item with a stale/invalid `anthropicProfileId` or `anthropicConfigId` surfaces a clear error.
- [ ] `renderTransportPicker()` helper is used by both the queue editor and the template editor.
