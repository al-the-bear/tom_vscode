# Multi-Transport Prompt Queue — design

## 1. Goal

Today the prompt queue only routes to **Copilot Chat**. Prompts are wrapped with an answer-file template, dispatched via `workbench.action.chat.open`, and advance when an answer JSON appears in the Copilot answer directory. We want the same queue to also be able to route to:

- **Anthropic** (Agent SDK or direct) — call `AnthropicHandler.sendMessage()` and capture the returned text synchronously.
- **Local LLM (Ollama)** — call `localLlmManager.ollamaGenerateWithTools()` the same way.
- **Tom AI Chat (VS Code LM API)** — call the VS Code language model API for direct LLM conversation.

**Note:** The CHAT panel has five sections: Anthropic, Tom AI Chat, AI Conversation, Copilot, and Local LLM. The **AI Conversation** panel is for bot-to-bot orchestrated exchanges between two models — it manages its own multi-turn flow programmatically and is **not** a queue target.

Each transport writes its **own trail** already (Anthropic via `TrailService.writeSummaryPrompt/Answer` with `ANTHROPIC_SUBSYSTEM` at [anthropic-handler.ts:585](tom_vscode_extension/src/handlers/anthropic-handler.ts#L585); Local LLM via `logPrompt`/`logResponse` with `trailType='local'` at [localLlm-handler.ts:1038](tom_vscode_extension/src/handlers/localLlm-handler.ts#L1038)), so the queue does not need synthetic answer files — responses flow directly into the queue's state machine and the handler owns logging.

Parallel execution across transports is explicitly **not a goal** — a single ordered queue is sufficient.

## 2. Design decisions

1. **Single queue, per-item transport.** One `PromptQueueManager` instance, with a `transport` field on each queue item (pre-prompt, main, follow-up). Default `'copilot'` for backwards compatibility. Per-item transport lets a single ordered workflow interleave transports ("plan with Claude → run 3 tasks via Ollama → review via Copilot").
2. **Direct responses, no synthetic answer files.** For `anthropic` / `localLlm` transports, `sendItem()` awaits the handler's entry-point and stores the returned text on the item. Advancing the queue (pre-prompt → main → follow-up → next item) is synchronous and skips the polling loop entirely.
3. **Transport-owned trails.** Anthropic and Local LLM handlers already write full trail entries. The queue does not duplicate them. Queue UI should still show the response body (for inspection) but the authoritative record is the transport's trail files.
4. **Skip features that only make sense for Copilot** when transport is direct:
   - **Answer-wrapper template** — not applied.
   - **Reminders** — ignored (no one to nudge).
   - **`answerWaitMinutes`** — ignored (response is synchronous).
   - **`expectedRequestId`** — not extracted.
   - **Polling loop** — skipped.
5. **Queue-level default + per-item override.** The queue editor has dropdowns at the top selecting the default transport (+ profile/config as appropriate). Each item's add/edit form has a collapsible "Advanced" section to override just for that item.
6. **Chat-panel buttons for queue-compatible transports.** Every queue-compatible chat panel (Copilot, Anthropic, Local LLM, Tom AI Chat) gets the same two action-bar buttons — "Add to Queue" and "Open Queue Editor" — pre-wired to set the right transport metadata when staging. The AI Conversation panel does not get these buttons (it orchestrates bot-to-bot exchanges, not user-initiated prompts).
7. **Queue-dispatched direct items always force auto-approve-all.** Queue execution is unattended — if a tool call triggers the approval bar, the queue deadlocks. For `anthropic` and `localLlm` transports the dispatcher sets `autoApproveAll = true` unconditionally, regardless of the profile's configured value. This is the "everything else is unusable" constraint: without it the queue can't run a multi-step Anthropic item that uses any approval-gated tool. The UI must make this explicit (see §4.7) so the user knows queue runs have weaker safety than interactive chat.
8. **Prompt templates are per-transport.** The four transports already have four *different* template shapes today (see §4.12), so there is no shared template store to reuse. The template editor becomes per-transport (the transport picker switches which config key it edits), and the queue's template dropdown is filtered by the item's current transport. A *Default* template option (transport-agnostic body-only template) is stored in a small new shared pool.

## 3. Current state reference

| Concern | Where |
| --- | --- |
| Queue manager singleton | [promptQueueManager.ts](tom_vscode_extension/src/managers/promptQueueManager.ts) |
| `sendItem()` dispatches via `workbench.action.chat.open` | [line 1945–2079](tom_vscode_extension/src/managers/promptQueueManager.ts#L1945-L2079) |
| Answer-file polling loop | [line 537](tom_vscode_extension/src/managers/promptQueueManager.ts#L537) |
| `processAnswerFile()` → `continueSending()` | [line 885](tom_vscode_extension/src/managers/promptQueueManager.ts#L885) |
| Queue editor webview | [queueEditor-handler.ts](tom_vscode_extension/src/handlers/queueEditor-handler.ts) |
| Queue toolbar (template dropdown, auto-send, reminder, …) | queueEditor-handler around lines 697–1203 |
| Anthropic entry point | [anthropic-handler.ts:398](tom_vscode_extension/src/handlers/anthropic-handler.ts#L398) — `sendMessage(options)` |
| Local LLM entry point | [localLlm-handler.ts:840](tom_vscode_extension/src/handlers/localLlm-handler.ts#L840) — `ollamaGenerateWithTools(options)` |
| Reusable config pickers (Chat Panel) | [chatPanel-handler.ts:3166–3214](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3166-L3214) |
| Existing `addToQueue` / `openQueueEditor` buttons (copilot only) | chatPanel-handler.ts lines 3099–3100, 688, 3447, 4031 |

## 4. Required changes

### 4.1 Data model — `promptQueueManager.ts`

Add to `QueuedPrompt`, `QueuedPrePrompt`, `QueuedFollowUpPrompt`:

```ts
transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat';   // default 'copilot'
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
tomAiChatConfigId?: string;
answerText?: string;        // captured direct response (not written by Copilot path)
```

All five fields optional. Items without `transport` behave exactly like today.

### 4.2 Transport dispatcher

A small local helper inside `promptQueueManager.ts` — **not** a new cross-handler abstraction. Signature:

```ts
async function dispatchStage(
  item: QueuedPrompt,
  stage: 'pre' | 'main' | 'followUp',
  indexOrId: number | string,
  expandedText: string,
): Promise<
  | { mode: 'polled'; expectedRequestId: string }        // copilot
  | { mode: 'direct'; answerText: string }               // anthropic | localLlm
>
```

Inside the helper:

```ts
const transport = resolveStageTransport(item, stage);  // per-stage override > item > queue default > 'copilot'
if (transport === 'copilot') {
  // Current flow: extract requestId, chat.open, return { mode: 'polled' }
}
if (transport === 'anthropic') {
  const { profile, configuration, tools } = resolveAnthropicTargets(item, stage);
  const result = await AnthropicHandler.instance.sendMessage({
    userText: expandedText, profile, configuration, tools,
  });
  return { mode: 'direct', answerText: result.text };
}
if (transport === 'localLlm') {
  const opts = resolveLocalLlmTargets(item, stage);
  const result = await localLlmManager.ollamaGenerateWithTools(opts, expandedText);
  return { mode: 'direct', answerText: result.text };
}
// tomAiChat (VS Code LM API)
const opts = resolveTomAiChatTargets(item, stage);
const result = await tomAiChatManager.sendMessage(opts, expandedText);
return { mode: 'direct', answerText: result.text };
```

`resolveStageTransport`: pre/follow-up item-level wins over queue-default (see §4.4 for override semantics).

### 4.3 `sendItem()` refactor

- Before calling `dispatchStage()`, **conditionally expand** the text:
  - Copilot: current behaviour (apply template + answer wrapper → `expandedText`).
  - Direct: apply the named template if any, **skip** `__answer_file__` wrapping and skip the `answerWrapper` boolean (both are Copilot-only constructs).
- After `dispatchStage()`:
  - `{ mode: 'polled' }`: record `expectedRequestId` and let the existing poll loop drive `continueSending()`.
  - `{ mode: 'direct' }`: store `answerText` on the item/stage (use the existing `prePrompts[i].status = 'sent'` / follow-up `repeatIndex++` machinery), then call `continueSending()` synchronously.
- On direct-transport failure: set item status `'error'` and surface the error message.
- **Inside `dispatchStage()` for Anthropic**: clone the resolved profile and set `autoApproveAll = true` before passing it to `sendMessage()`, regardless of the profile's stored value. Same applies to Local LLM's approval flow — the dispatcher coerces any tool-approval parameter to "bypass" for queue runs. See §2 decision 7.

### 4.4 Per-transport skips

When `transport !== 'copilot'`, the queue bypasses:

| Feature | Copilot behaviour | Direct behaviour |
| --- | --- | --- |
| `answerWrapper` + `__answer_file__` template | applied at `_buildExpandedText` | **not applied** |
| `expectedRequestId` extraction | required | skipped |
| Answer-file polling | `pollForExpectedAnswer()` watches directory | **not started** for this item |
| Reminders (`reminderEnabled`, `reminderTemplateId`, …) | enqueue reminder prompts on timeout | **ignored** (UI warns) |
| `answerWaitMinutes` auto-advance | triggers after N min without answer | **ignored** (response is synchronous) |

Implementation: add a `isDirectTransport(item)` / `isDirectStage(item, stage)` guard in `sendItem()`, `pollForExpectedAnswer()`, reminder scheduler, and answer-wait timer.

### 4.5 Polling-loop guard

`pollForExpectedAnswer()` already skips items with no `expectedRequestId`. Defensive belt-and-suspenders: also skip any item where `transport` is set and not `'copilot'` so a mis-constructed item can never be matched against an unrelated answer file.

### 4.6 Trail integration

No queue-side changes — transports own it.

- **Copilot**: unchanged. The answer file is the trail entry (and the existing `_ai/trail/copilot/` pipeline picks it up).
- **Anthropic**: `sendMessage()` calls `TrailService.writeSummaryPrompt/Answer` with `ANTHROPIC_SUBSYSTEM` internally. The queue does nothing.
- **Local LLM**: `ollamaGenerateWithTools` calls `logPrompt/logResponse` with `trailType='local'`. The queue does nothing.

If the queue ever wants a cross-transport view, the existing trail viewer already subsystem-filters; no synthetic files required.

### 4.7 Queue editor UI — `queueEditor-handler.ts`

**Header row — queue-level defaults** (new, above the existing toolbar):

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Default transport: [ Copilot ▾ ]                                   │
│  [Anthropic selected → ] Profile: [ ▾ ]   Config: [ ▾ ]             │
│  [Local LLM selected → ] Config: [ ▾ ]                              │
└─────────────────────────────────────────────────────────────────────┘
```

The three dropdowns are **conditional on transport**. Reuse the existing rendering code from [chatPanel-handler.ts:3166–3214](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3166-L3214) — extract it into a shared helper (e.g. `renderTransportTargetPickers(kind, idPrefix, context)`) so the queue editor and the chat panel render identical dropdowns.

**Per-item form — advanced section** (collapsed by default):

```text
▶ Advanced
    Transport: [ inherit (Copilot) ▾ ]
    [if Anthropic] Profile, Config pickers
    [if Local LLM] Config picker
```

- Default value `inherit` → the stage uses the queue-level transport.
- Any explicit value overrides for this item/stage.
- When transport ≠ copilot, **disable** the Reminder dropdown and `answerWaitMinutes` input (with a tooltip explaining why).

**Per-stage override** (pre-prompts and follow-ups): apply the same collapsible "Advanced" section inside each stage's editor. Default to inherit-from-item. Three levels of resolution: stage > item > queue default > `'copilot'`.

**Auto-approve warning**: when the user picks `Anthropic` or `Local LLM` as the queue-level or item-level transport, render a visible notice directly below the transport dropdown:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored. The queue cannot pause for the approval bar.

No checkbox to disable it. See §2 decision 7.

**Display of direct responses**: when `item.answerText` exists (direct transport), show it inline under the item (truncated preview + expand-to-full button). The authoritative trail is the transport's trail file, but seeing the text in the queue itself is the practical way to inspect what happened.

### 4.8 Chat panel action-bar buttons — `chatPanel-handler.ts`

Today only the Copilot section has the queue buttons ([line 3099–3100](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3099-L3100)):

```html
<button data-action="addToQueue"       data-id="copilot" …>
<button data-action="openQueueEditor"  data-id="copilot" …>
```

**Changes:**

1. Add the same two buttons to the **Anthropic**, **Local LLM**, and **Tom AI Chat** sections. Each keeps its `data-id` distinct (`"anthropic"`, `"localLlm"`, `"tomAiChat"`). The **AI Conversation** section does **not** get queue buttons — it orchestrates bot-to-bot exchanges, not user-initiated prompts.
2. In the `addToQueue` handler (currently `addCopilotToQueue()` at [line 3447](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3447)), dispatch by `data-id`. The staged queue item **must** carry the transport-specific metadata read from that panel's own dropdowns. This is non-trivial — the current Copilot button only needs `text` + `template`, but direct transports need the full target context:

   | `data-id` | `transport` set | Extra payload (read from that panel's dropdowns) |
   | --- | --- | --- |
   | `copilot` | `'copilot'` | `template`, `answerWrapper`, `repeatCount`, `answerWaitMinutes` (current) |
   | `anthropic` | `'anthropic'` | `anthropicProfileId`, `anthropicConfigId`, `template` |
   | `localLlm` | `'localLlm'` | `localLlmConfigId`, `template` |
   | `tomAiChat` | `'tomAiChat'` | `tomAiChatConfigId`, `template` |

3. The backend's queue-add router (`case 'addToQueue'` at [line 688](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L688)) must forward all five new fields into `PromptQueueManager.enqueue()` unchanged. A queue item staged from the Anthropic panel should never inherit the queue's default transport — the user clicked *that* panel's button precisely to pin the transport.
4. `openQueueEditor` is unchanged — it opens the same queue editor regardless of which panel's button was clicked.

### 4.9 Tool surface — `chat-enhancement-tools.ts`

Extend the input schemas of:

- `tomAi_queue_add`
- `tomAi_queue_addFollowUp`
- `tomAi_queue_addPrePrompt`
- `tomAi_queue_updateItem`
- `tomAi_queue_updateFollowUp`
- `tomAi_queue_updatePrePrompt`

with the four new fields:

```ts
transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat';
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
tomAiChatConfigId?: string;
```

The executors forward these to the manager unchanged. Defaults mirror the data model (undefined = inherit).

### 4.10 Persistence / compatibility

Queue state is persisted to `_ai/local/*.prompt-panel.yaml`. The new fields are additive optional → **no migration**. Existing queue items deserialise with `transport: undefined`, which resolves to `'copilot'` at dispatch time — identical to current behaviour.

### 4.11 Reusable TransportPicker component

The same four transport dropdowns + profile/config dropdown combinations are needed in three places:

- Queue editor — queue-level default
- Queue editor — per-item / per-stage "Advanced" override
- **Prompt template editor** (see §4.12)

Rather than duplicate the markup + event handlers three times, extract a single webview-side helper:

```ts
// shared between queueEditor-handler.ts, chatPanel-handler.ts, and templateEditor-handler.ts
renderTransportPicker(options: {
  idPrefix: string;                      // disambiguates DOM ids when multiple pickers are on a page
  context: 'queue-default' | 'queue-item' | 'queue-stage' | 'template-editor';
  value: TransportPickerValue;           // current selected transport + target ids
  showTargets: boolean;                  // whether to render the profile/config dropdowns below
  onChangeEvent: string;                 // webview postMessage type fired on any change
}): string;   // returns HTML fragment
```

**Option set varies by context:**

| Context | Dropdown options | Has "inherit / default" option? |
| --- | --- | --- |
| `queue-default` | Copilot, Anthropic, Local LLM, Tom AI Chat | no — this *is* the default |
| `queue-item` | *Inherit (queue default)*, Copilot, Anthropic, Local LLM, Tom AI Chat | yes, labelled **Inherit** |
| `queue-stage` | *Inherit (item)*, Copilot, Anthropic, Local LLM, Tom AI Chat | yes, labelled **Inherit** |
| `template-editor` | *Default (transport-agnostic)*, Copilot, Anthropic, Local LLM, Tom AI Chat | yes, labelled **Default** |

**Conditional target pickers** (shown when `showTargets: true` and a non-inherit transport is selected):

- Copilot → no target dropdowns (answer-file pipeline is fixed).
- Anthropic → profile dropdown + config dropdown. Reuse the list-loading logic from [chatPanel-handler.ts:3166–3214](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3166-L3214).
- Local LLM → config dropdown only.
- Tom AI Chat → config dropdown only.

In the **template editor** (§4.12) `showTargets` should be **`false`** — templates don't pin a profile/config; they just declare which transport store they belong to. Profile/config are applied at queue time, not template-define time.

The picker emits a single `{ type: onChangeEvent, transport, anthropicProfileId?, anthropicConfigId?, localLlmConfigId?, tomAiChatConfigId? }` message, and the consuming handler writes it to the right store (queue item, queue default, or template record).

### 4.12 Prompt template editor — per-transport templates

Today the template editor only knows about the **Copilot** template store (`config.copilot.templates` — see [sendToChatConfig.ts:108–112](tom_vscode_extension/src/utils/sendToChatConfig.ts#L108-L112)). With multi-transport queueing the editor must also reach the other three stores — which have **four genuinely different shapes**:

| Transport | Config key | Shape |
| --- | --- | --- |
| Copilot | `config.copilot.templates` | map `{ [name]: { template, showInMenu } }` |
| Anthropic | `config.anthropic.userMessageTemplates` | array `[{ id, name, description?, template, isDefault }]` |
| Tom AI Chat | `config.tomAiChat.templates` | map `{ [name]: { label, description?, contextInstructions?, systemPromptOverride? } }` — **not a plain body template**, structural system-prompt config |
| Local LLM | `config.localLlm.profiles[key].{ systemPrompt, resultTemplate }` + `config.localLlm.defaultTemplate` | **per-profile** attributes, no separate named store |
| Default (new) | `config.sharedQueueTemplates` (new) | array `[{ id, name, description?, template }]` — transport-agnostic body text |

**Template editor changes:**

1. **Add the TransportPicker** (context `'template-editor'`, `showTargets: false`) at the top of the editor. Its value selects which store the editor is reading/writing.
2. **Load the template list from that store** on transport change. For Tom AI Chat and Local LLM the list is **structurally different** from the simple `{name, body}` model the editor renders today — the editor must branch:
   - Copilot / Anthropic / Default → render a plain "name + body" edit form (current form, unchanged).
   - Tom AI Chat → render label + description + contextInstructions + systemPromptOverride fields. Body-only templates can still be stored alongside, but the editor should surface the fuller shape.
   - Local LLM → **read-only listing** of per-profile `resultTemplate` strings; editing the body happens via the Local LLM profile editor, not here. Show a hint: *"Local LLM templates live on each profile. Open the Local LLM profile editor to change them."*
3. **Create/update/delete** operations go to the matching config key. The existing `tomAi_templates_manage` tool (§4.9 addendum) gets a `transport` field that selects the target store; without it the tool defaults to `copilot` (current behaviour preserved).
4. **Default store bootstrap**: if the user creates a template with transport `Default`, write it to `config.sharedQueueTemplates[]`. This is a new config key — additive, requires a one-line addition to `SendToChatConfig` and the JSON schema.

**Queue editor — template dropdown** (existing):

- When a queue item's effective transport is known, the template dropdown **filters its contents to that transport's store plus the Default store**. The Default store is always visible because its templates are transport-neutral.
- Changing a queue item's transport **blanks** the template selection (see §5 edge case). The dropdown repopulates with templates for the new transport + Default.

**`tomAi_templates_manage` tool extension:**

```ts
operation: 'list' | 'create' | 'update' | 'delete'
transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat' | 'default';   // default: 'copilot'
```

- `list` without a transport lists only Copilot templates (current behaviour).
- `list` with a transport returns that store's templates, normalised into a common `{ id, name, template, extras?: { ... transport-specific fields } }` shape.
- `create` / `update` / `delete` target the matching store. For Local LLM, `create` returns an error steering the user to the profile editor; `update`/`delete` of a Local LLM resultTemplate is allowed and writes to the profile.

## 5. Edge cases and non-obvious bits

- **Template expansion placeholders** (`${repeatNumber}`, `${repeatIndex}`, chat variables): these happen at expand-time before transport dispatch — unchanged. Chat-variable-driven `repeatCount` keeps working identically.
- **Pre-prompts with direct transport**: each pre-prompt awaits its own direct call. Because direct calls are synchronous, the pre-prompt chain runs back-to-back without polling gaps. This is much faster than the Copilot flow, which waits 30-second poll intervals between stages. May surprise users — consider documenting in the queue editor's help text.
- **`sendMaximum` on timed requests**: orthogonal to transport; still counted the same way.
- **`templateRepeatCount`**: re-runs the entire (pre-prompts + main + follow-ups) group. Works identically per-transport. If transport is direct, the whole re-run is fast and synchronous.
- **Anthropic `profile.autoApproveAll`**: queue dispatch **always overrides** this to `true` — see §2 decision 7 and §4.3. The profile's stored value applies only when the profile is used interactively from the chat panel. This is a safety tradeoff the user needs to understand: queue runs are unattended and cannot pause for approval.
- **Template reference invalidated when transport changes.** A queue item's `template` name is meaningful only within one transport's store. If the user switches a queue item's transport (via the per-item Advanced picker) from Copilot to Anthropic, the previously-selected template name may not exist in `config.anthropic.userMessageTemplates`. **Handling**: on transport change inside the queue editor, clear the template selection and repopulate the dropdown from the new transport's store + Default store. Do **not** try to copy templates across stores automatically — too magical, and Tom AI Chat's shape doesn't even match the simple body-only model. A "Save a copy in the new transport's store" button on the item editor is a reasonable future add; out of scope for the first pass.
- **Tom AI Chat and Local LLM template shapes don't round-trip.** Tom AI Chat templates carry structural fields (`systemPromptOverride`, `contextInstructions`) that have no meaning in the other stores; Local LLM templates are per-profile. The template editor must not offer to "convert" a template between stores — the user has to recreate it deliberately.
- **Concurrency**: the queue is strictly sequential (one `sending` item at a time — [isEditableStatus guard](tom_vscode_extension/src/managers/promptQueueManager.ts)). Direct transport doesn't change this.
- **Failure modes**:
  - Anthropic API error → item status `'error'`, error message surfaced, queue pauses (same as the current `'error'` handling).
  - Local LLM timeout → ditto.
  - Config-id references a profile/config that no longer exists → dispatcher returns a clear error without touching the transport.
- **`tomAi_askCopilot` inside an Anthropic direct-transport item**: valid — the Anthropic call can still use the `askCopilot` tool which bounces a sub-question into Copilot Chat. That's pre-existing behaviour, just not the queue's main-prompt transport.

## 6. Step-by-step implementation order

1. **Data model** — add the four optional fields + `answerText`. One commit; no behaviour change yet.
2. **Transport dispatcher + `sendItem()` branch** — introduce `dispatchStage()` but default all items to `'copilot'` so the flow is byte-identical. Add unit-test for each transport branch.
3. **Polling / reminder / answer-wait guards** — skip direct items in all three. Verify Copilot still works end-to-end.
4. **Direct-transport execution** — wire the Anthropic and Local LLM branches through. Exercise with a hand-crafted item in each transport.
5. **Tool-input extensions** — expose the four new fields in the six queue tools.
6. **Reusable `renderTransportPicker()` helper** (§4.11) — extract from the current Chat Panel's dropdowns; call sites come in the next steps.
7. **Queue editor UI** — queue-level dropdowns + per-item Advanced section, using the helper from step 6. Transport change blanks the template selection.
8. **Chat-panel buttons** — add the two buttons to Anthropic / Local LLM / Tom AI Chat sections. Dispatch by `data-id`; the payload carries transport + target ids read from the clicked panel's own dropdowns. (AI Conversation is excluded.)
9. **Add `config.sharedQueueTemplates` to `SendToChatConfig` + JSON schema** (§4.12) — one-line additions; needed before the template editor gets a Default option.
10. **Template editor — per-transport switcher** — add the `renderTransportPicker()` at the top, swap the list source + edit form per transport (Tom AI Chat's structural form is a branch, Local LLM is read-only with a hint).
11. **Extend `tomAi_templates_manage` with `transport`** — default `'copilot'` for backward compat; routes to the matching store.
12. **Documentation** — update `llm_tools.md` §4.20, `copilot_chat_integration.md` if it exists, and this doc's "current state" once implemented.

Rough effort: **3–4 days** end-to-end. The template editor per-transport branching is the largest single chunk — the Tom AI Chat form is structurally different from the others, so the UI can't just be "swap the datasource".

## 7. Out of scope

- Parallel execution across transports (explicitly not needed).
- Cross-transport abstraction as a shared `ChatTransport` interface — a local dispatcher is simpler and has no reuse target beyond the queue.
- **AI Conversation panel** — bot-to-bot orchestration, manages its own multi-turn flow. The queue does not drive it; the AI Conversation panel does not get queue buttons.
- Streaming responses — current transports return the full text once done; no stream events are propagated to the queue. If needed later, add a `onChunk` callback to the dispatcher without changing the overall shape.
- UI for viewing the direct-response trail from inside the queue editor — the existing trail viewer already covers this.

## 8. Acceptance checklist

- [ ] A queue item with `transport: 'anthropic'` fires `AnthropicHandler.sendMessage()`, stores the text, and advances without polling.
- [ ] A queue item with `transport: 'localLlm'` fires `ollamaGenerateWithTools()`, stores the text, and advances without polling.
- [ ] Existing Copilot queue items are byte-identical in behaviour (template wrapper, answer-file polling, reminders, answer-wait).
- [ ] Queue editor header shows the transport default + conditional profile/config dropdowns.
- [ ] Per-item Advanced section lets me override transport for one item.
- [ ] Reminder + answerWait fields are visibly disabled for direct-transport items.
- [ ] Selecting Anthropic or Local LLM transport shows the auto-approve-all warning.
- [ ] Queue-dispatched Anthropic items run with `autoApproveAll = true` even when the profile stores `false` — verified by a tool call that would otherwise prompt.
- [ ] "Add to Queue" + "Open Queue Editor" buttons exist on queue-compatible chat panels (Copilot, Anthropic, Local LLM, Tom AI Chat). AI Conversation panel does **not** have these buttons.
- [ ] Each chat panel's "Add to Queue" button stages an item with the **correct transport** and target-ids read from that panel's own dropdowns (not the queue's default).
- [ ] A queue item with `transport: 'tomAiChat'` fires the VS Code LM API, stores the text, and advances without polling.
- [ ] `tomAi_queue_add` and siblings accept the four new fields.
- [ ] Anthropic and Local LLM trail files contain entries for queue-dispatched prompts (verified by the transport's own logging).
- [ ] A queue item with a stale/invalid `anthropicProfileId` surfaces a clear error.
- [ ] `renderTransportPicker()` helper is used in all three call sites (chat panel, queue editor, template editor) with the right `context` value.
- [ ] Template editor's transport picker switches the list source for Copilot / Anthropic / Default stores and renders Tom AI Chat's structural form when selected.
- [ ] Template editor shows the read-only hint for Local LLM with a pointer to the profile editor.
- [ ] Switching a queue item's transport in the editor clears its template selection and repopulates the dropdown.
- [ ] `tomAi_templates_manage` honours a `transport` field, defaulting to `copilot` when absent.
- [ ] `config.sharedQueueTemplates` exists in the schema and holds Default templates.
