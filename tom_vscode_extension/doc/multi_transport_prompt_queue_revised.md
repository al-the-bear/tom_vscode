# Multi-Transport Prompt Queue — design (revised v2)

> **Revision note (v2, 2026-04-19).** This version collapses the queue's
> transport model to exactly two entries — **Copilot** and **Anthropic**.
> VS Code LM is folded in as a new *Anthropic configuration type*; existing
> Local LLM configurations are surfaced inside the Anthropic profile's
> config picker. The Anthropic path forks internally four ways (Direct /
> Agent SDK / VS Code LM / Local LLM), but the queue only sees `anthropic`.
> The Tom AI Chat and Local LLM panels stay exactly as they are — they do
> NOT gain queueing buttons and are NOT queue targets. Previous §4.2.1
> (Tom AI Chat dispatcher refactor) and the entire Phase 2 panel-
> consolidation plan (§9) are removed as obsolete: the new model already
> achieves the consolidation at the profile layer, not the panel layer.
> All code references have been re-anchored against the current tree
> (post-commit `2a1943a`, 2026-04-19).

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

Extend `AnthropicConfiguration.type` from `'direct' | 'agentSdk'` to `'direct' | 'agentSdk' | 'vscodeLm'`. A `vscodeLm` configuration carries the selector parameters for `vscode.lm.selectChatModels`:

```ts
interface VsCodeLmConfiguration extends AnthropicConfigurationBase {
    type: 'vscodeLm';
    vendor?: string;          // e.g. 'copilot'
    family?: string;          // e.g. 'gpt-4o' or 'claude-sonnet-4.5'
    modelId?: string;         // exact id when multiple models match vendor+family
    maxTokens?: number;       // optional; falls back to the model's advertised max
}
```

**Trail directory is the same** as the other two types (`_ai/trail/anthropic/*`), because from the user's perspective this is still "an Anthropic configuration" — it just happens to route to VS Code's LM API.

JSON schema + `SendToChatConfig` type updated accordingly. The Extension State Page's Anthropic configurations section gains the new type as a picker option; the rest of the form adapts to the reduced field set.

### 4.3 Anthropic profile config picker — widened source

The Anthropic profile's `configId` dropdown today sources only from `config.anthropic.configurations`. It must now also list entries from `config.localLlm.configurations` ([sendToChatConfig.ts:59-76](../src/utils/sendToChatConfig.ts#L59-L76)), with a visible backing-type label so the user knows which path they're pinning. The Local LLM configuration schema itself is **not** changed.

Resolution order inside `AnthropicHandler.sendMessage()` when handling `profile.configId`:

1. Look it up in `config.anthropic.configurations`. If found → dispatch to the type-specific branch (Direct / Agent SDK / VS Code LM).
2. Otherwise look it up in `config.localLlm.configurations`. If found → dispatch to the Local LLM branch.
3. Otherwise → error.

### 4.4 `AnthropicHandler.sendMessage` — internal four-way fork

The existing Direct and Agent SDK branches stay as-is. Two new branches are added:

**VS Code LM branch.** When `configuration.type === 'vscodeLm'`:

```ts
const models = await vscode.lm.selectChatModels({ vendor: configuration.vendor, family: configuration.family });
const model = pickModel(models, configuration.modelId);
if (!model) throw new Error('No VS Code LM model matches configuration');
// API has no system/user split in the simple single-shot form we need —
// concatenate per design decision 8.
const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;
const request = await model.sendRequest([vscode.LanguageModelChatMessage.User(combinedPrompt)], {}, token);
const text = await collectText(request.text);
// Raw + summary trail writes identical to the Agent SDK branch.
// Tool approval + live trail: reuse the same code paths already wired for Agent SDK.
```

**Local LLM branch.** When `configuration` resolves to a Local LLM config:

```ts
const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userText}` : userText;
const result = await LocalLlmManager.instance.ollamaGenerateWithTools(
    { configId: configuration.id, toolApprovalMode },
    combinedPrompt,
);
// Raw + summary trail writes to _ai/trail/anthropic/* (same subsystem as the other branches).
// DO NOT invoke the Local LLM handler's own trail writer on this path — we intentionally
// unify trails under the Anthropic subsystem.
```

Both new branches reuse the Agent SDK path's tool-approval bridge, live-trail writer, and built-in-tool persistence hooks. The behavioural contract of `AnthropicSendResult` is unchanged for callers (queue and chat panel).

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

### 4.12 Anthropic panel — VS Code LM model dropdown

When the active configuration has `type === 'vscodeLm'`, the Anthropic panel's bottom area (where the profile/config pickers live) surfaces an additional dropdown listing the models returned by `vscode.lm.selectChatModels({ vendor, family })` for the selected configuration. Picking a model updates the effective `modelId` used on the next send.

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
- **Anthropic pre-prompt output → next-stage context? (open question).** The queue deliberately does *not* pipe `pre.answerText` into the main item's prompt. If the user wants that, they use a `${prePrompt[0].answer}` placeholder or similar in the main prompt. Alternatively, an opt-in "chain answers" toggle on the item — deferred to §6.1.
- **Template reference invalidated when transport changes.** Template names are meaningful only within one transport's store. Switching a queue item's transport in the editor clears its template selection and repopulates from the new transport's store. Do **not** auto-copy templates across stores — the two shapes overlap but aren't identical, and silent conversion is too magical.
- **`toolApprovalMode` coercion covers every Anthropic leaf path.** Direct, Agent SDK, VS Code LM, Local LLM — all must honour `'never'` when called from the queue. The coercion happens *before* `AnthropicHandler.sendMessage` dispatches into a leaf branch, so each branch receives the already-coerced profile.
- **Concurrency**: the queue is strictly sequential (one `sending` item at a time). Anthropic transport doesn't change this.
- **Failure modes**:
  - Anthropic API error (Direct / Agent SDK / VS Code LM / Local LLM) → item status `'error'`, error message surfaced, queue pauses.
  - `vscode.lm.selectChatModels` returns empty for a `vscodeLm` config → surface "no LM available", pause queue, do not retry.
  - `anthropicConfigId` references a config that no longer exists in either the Anthropic or Local LLM config store → dispatcher returns a clear error without touching the transport.
- **`tomAi_askCopilot` inside an Anthropic queue item**: valid — the Anthropic call can still use the `askCopilot` tool which bounces a sub-question into Copilot Chat. That's pre-existing behaviour, just not the queue's main-prompt transport.

### 6.1 Open questions

1. **Should anthropic-transport pre-prompts feed into the main prompt automatically?** See bullet above. Default proposal: no — user uses placeholders or the follow-up chain to carry context. Confirm before implementing.
2. **Should VS Code LM `selectChatModels` results be cached across queue items?** For a long queue this can be hundreds of lookups. A per-send cache in `AnthropicHandler` would avoid the cost; invalidate on configuration change.
3. **Local-LLM-backed Anthropic profile: tool-approval parity.** Confirm that coercing to `'never'` at the Anthropic layer translates correctly into the Local LLM handler's own approval flow.

## 6. Step-by-step implementation order

1. **Data model** — add the four optional fields (§4.1). One commit; no behaviour change yet.
2. **New `vscodeLm` configuration type** (§4.2) — schema + JSON-schema + `SendToChatConfig` + Extension State Page editor. No dispatch wiring yet.
3. **AnthropicHandler four-way fork** (§4.4) — add VS Code LM branch and Local LLM branch to `sendMessage`. Reuse Agent SDK path's live-trail / tool-approval / trail-write wiring.
4. **Anthropic profile config picker widens** (§4.3) — lists Anthropic + Local LLM configs with type labels. Resolver falls back across both stores.
5. **Transport dispatcher + `sendItem()` branch** (§4.5, §4.6) — two-way. Default `'copilot'` preserves byte-identical behaviour.
6. **Polling / reminder / answer-wait guards** (§4.7, §4.8) — skip anthropic items in all three.
7. **Anthropic panel queueing buttons** (§4.11) — mirror the Copilot section's two buttons; dispatch on `data-id="anthropic"`.
8. **Anthropic panel VS Code LM model dropdown** (§4.12) — conditional on active configuration type.
9. **Queue editor UI** (§4.10) — queue-level dropdowns + per-item Advanced + auto-approve warning.
10. **Tool surface extensions** (§4.13) — expose new fields in the add/update queue tools.
11. **`renderTransportPicker()` helper** (§4.15) — new sibling to `getPromptEditorComponent`. Call sites are the queue editor and template editor.
12. **Template editor — per-transport switcher** (§4.16) — swap store on transport change.
13. **Extend the four prompt-template tools with `transport`** (§4.16) — default `'copilot'` for backward compat.
14. **Documentation** — update `llm_tools.md`, `copilot_chat_integration.md` if it exists, and this doc's "current state" once implemented.

Rough effort: **3–4 days** end-to-end. The largest single chunks are the VS Code LM branch inside `AnthropicHandler` (step 3) and the queue editor UI (step 9).

## 7. Out of scope

- **Queueing for Tom AI Chat, Local LLM, and AI Conversation panels.** These panels stay exactly as they are. If a future phase wants to integrate them, it should go through the Anthropic profile layer (e.g. surface the panel's configuration as an Anthropic config reference) rather than introducing parallel transport paths.
- **Panel consolidation.** The new two-transport model already achieves consolidation at the profile layer — no merged "LLM" panel, no twin pickers on AI Conversation. Previous §9 (Phase 2) is removed.
- **Parallel execution across transports** (a single ordered queue is sufficient).
- **Cross-transport shared `ChatTransport` interface** — a two-way dispatcher plus an internal Anthropic fork is simpler and has no other reuse target.
- **Streaming chunks to the queue** — each leaf branch returns the full text once done. If needed later, add `onChunk` callbacks inside `AnthropicHandler` without touching the queue.
- **Automatic chaining of anthropic pre-prompt answers into the main prompt** — see §6.1 open question 1.

## 8. Acceptance checklist

- [ ] `QueuedPrompt.transport` accepts only `'copilot' | 'anthropic'`; no `tomAiChat` or `localLlm` values in the queue schema.
- [ ] Anthropic queue item with a `direct` config hits the existing Direct path.
- [ ] Anthropic queue item with an `agentSdk` config hits the existing Agent SDK path.
- [ ] Anthropic queue item with a `vscodeLm` config routes through `vscode.lm.selectChatModels` + `model.sendRequest` and concatenates `{systemPrompt}\n\n{userText}`.
- [ ] Anthropic queue item whose `anthropicConfigId` points at a Local LLM config delegates to `LocalLlmManager.instance.ollamaGenerateWithTools` with the same concatenation rule.
- [ ] All four Anthropic leaf paths write to `_ai/trail/anthropic/*` (single subsystem).
- [ ] All four Anthropic leaf paths honour the Anthropic panel's live trail, tool approval (coerced to `'never'` for queue runs), and user-message template rules.
- [ ] Anthropic panel has "Add to Queue" + "Open Queue Editor" buttons matching the Copilot section.
- [ ] Anthropic panel surfaces a VS Code LM model dropdown when the active configuration is of type `vscodeLm`, and hides it otherwise.
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
