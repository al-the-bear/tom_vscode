# Multi-Transport Prompt Queue — design

## 1. Goal

Today the prompt queue only routes to **Copilot Chat**. Prompts are wrapped with an answer-file template, dispatched via `workbench.action.chat.open`, and advance when an answer JSON appears in the Copilot answer directory. We want the same queue to also be able to route to:

- **Anthropic** (Agent SDK or direct) — call `AnthropicHandler.sendMessage()` and capture the returned text synchronously.
- **Local LLM (Ollama)** — call `localLlmManager.ollamaGenerateWithTools()` the same way.
- **AI Conversation (VS Code LM)** — future; same pattern.

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
6. **Chat-panel buttons for all transports.** Every chat panel (copilot, anthropic, localLlm, aiConversation) gets the same two action-bar buttons the copilot panel has today — "Add to Queue" and "Open Queue Editor" — pre-wired to set the right transport metadata when staging.

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
transport?: 'copilot' | 'anthropic' | 'localLlm';   // default 'copilot'
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
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
// localLlm
const opts = resolveLocalLlmTargets(item, stage);
const result = await localLlmManager.ollamaGenerateWithTools(opts, expandedText);
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

```
┌─────────────────────────────────────────────────────────────────────┐
│  Default transport: [ Copilot ▾ ]                                   │
│  [Anthropic selected → ] Profile: [ ▾ ]   Config: [ ▾ ]             │
│  [Local LLM selected → ] Config: [ ▾ ]                              │
└─────────────────────────────────────────────────────────────────────┘
```

The three dropdowns are **conditional on transport**. Reuse the existing rendering code from [chatPanel-handler.ts:3166–3214](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3166-L3214) — extract it into a shared helper (e.g. `renderTransportTargetPickers(kind, idPrefix, context)`) so the queue editor and the chat panel render identical dropdowns.

**Per-item form — advanced section** (collapsed by default):

```
▶ Advanced
    Transport: [ inherit (Copilot) ▾ ]
    [if Anthropic] Profile, Config pickers
    [if Local LLM] Config picker
```

- Default value `inherit` → the stage uses the queue-level transport.
- Any explicit value overrides for this item/stage.
- When transport ≠ copilot, **disable** the Reminder dropdown and `answerWaitMinutes` input (with a tooltip explaining why).

**Per-stage override** (pre-prompts and follow-ups): apply the same collapsible "Advanced" section inside each stage's editor. Default to inherit-from-item. Three levels of resolution: stage > item > queue default > `'copilot'`.

**Display of direct responses**: when `item.answerText` exists (direct transport), show it inline under the item (truncated preview + expand-to-full button). The authoritative trail is the transport's trail file, but seeing the text in the queue itself is the practical way to inspect what happened.

### 4.8 Chat panel action-bar buttons — `chatPanel-handler.ts`

Today only the Copilot section has the queue buttons ([line 3099–3100](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3099-L3100)):

```html
<button data-action="addToQueue"       data-id="copilot" …>
<button data-action="openQueueEditor"  data-id="copilot" …>
```

**Changes:**

1. Add the same two buttons to the **Anthropic**, **Local LLM**, and **AI Conversation** sections. Each keeps its `data-id` distinct (`"anthropic"`, `"localLlm"`, `"aiConversation"`).
2. In the `addToQueue` handler (currently `addCopilotToQueue()` at [line 3447](tom_vscode_extension/src/handlers/chatPanel-handler.ts#L3447)), dispatch by `data-id`:
   - `copilot` → current behaviour.
   - `anthropic` → post `{ type: 'addToQueue', transport: 'anthropic', text, anthropicProfileId, anthropicConfigId, … }`. The backend's queue-add router resolves the profile/config from the section's dropdowns.
   - `localLlm` → analogous with `localLlmConfigId`.
   - `aiConversation` → once AI Conversation gets direct-transport support.
3. `openQueueEditor` is unchanged — it opens the same queue editor regardless of which panel's button was clicked.

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
transport?: 'copilot' | 'anthropic' | 'localLlm';
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
```

The executors forward these to the manager unchanged. Defaults mirror the data model (undefined = inherit).

### 4.10 Persistence / compatibility

Queue state is persisted to `_ai/local/*.prompt-panel.yaml`. The new fields are additive optional → **no migration**. Existing queue items deserialise with `transport: undefined`, which resolves to `'copilot'` at dispatch time — identical to current behaviour.

## 5. Edge cases and non-obvious bits

- **Template expansion placeholders** (`${repeatNumber}`, `${repeatIndex}`, chat variables): these happen at expand-time before transport dispatch — unchanged. Chat-variable-driven `repeatCount` keeps working identically.
- **Pre-prompts with direct transport**: each pre-prompt awaits its own direct call. Because direct calls are synchronous, the pre-prompt chain runs back-to-back without polling gaps. This is much faster than the Copilot flow, which waits 30-second poll intervals between stages. May surprise users — consider documenting in the queue editor's help text.
- **`sendMaximum` on timed requests**: orthogonal to transport; still counted the same way.
- **`templateRepeatCount`**: re-runs the entire (pre-prompts + main + follow-ups) group. Works identically per-transport. If transport is direct, the whole re-run is fast and synchronous.
- **Anthropic `profile.autoApproveAll`**: when enabled, the queue can run Anthropic tool calls end-to-end without user prompts. When disabled, every tool call opens the approval bar and the queue stage awaits it (the handler already blocks). That's the user's call, not the queue's.
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
6. **Queue editor UI** — queue-level dropdowns + per-item Advanced section. Share the `renderTransportTargetPickers()` helper with the chat panel.
7. **Chat-panel buttons** — add the two buttons to anthropic / localLlm / aiConversation sections. Dispatch by `data-id`.
8. **Documentation** — update `llm_tools.md` §4.20, `copilot_chat_integration.md` if it exists, and this doc's "current state" once implemented.

Rough effort: **2–3 days** end-to-end, depending on how much polish the per-stage override UI gets.

## 7. Out of scope

- Parallel execution across transports (explicitly not needed).
- Cross-transport abstraction as a shared `ChatTransport` interface — a local dispatcher is simpler and has no reuse target beyond the queue.
- AI Conversation transport — the plumbing mirrors Anthropic/Local LLM (same `sendMessage`-style entry point via `vscode.lm.*`) but the chat panel integration is different enough to split into a follow-up.
- Streaming responses — current transports return the full text once done; no stream events are propagated to the queue. If needed later, add a `onChunk` callback to the dispatcher without changing the overall shape.
- UI for viewing the direct-response trail from inside the queue editor — the existing trail viewer already covers this.

## 8. Acceptance checklist

- [ ] A queue item with `transport: 'anthropic'` fires `AnthropicHandler.sendMessage()`, stores the text, and advances without polling.
- [ ] A queue item with `transport: 'localLlm'` fires `ollamaGenerateWithTools()`, stores the text, and advances without polling.
- [ ] Existing Copilot queue items are byte-identical in behaviour (template wrapper, answer-file polling, reminders, answer-wait).
- [ ] Queue editor header shows the transport default + conditional profile/config dropdowns.
- [ ] Per-item Advanced section lets me override transport for one item.
- [ ] Reminder + answerWait fields are visibly disabled for direct-transport items.
- [ ] "Add to Queue" + "Open Queue Editor" buttons exist on every chat panel (copilot, anthropic, localLlm, aiConversation).
- [ ] `tomAi_queue_add` and siblings accept the four new fields.
- [ ] Anthropic and Local LLM trail files contain entries for queue-dispatched prompts (verified by the transport's own logging).
- [ ] A queue item with a stale/invalid `anthropicProfileId` surfaces a clear error.
