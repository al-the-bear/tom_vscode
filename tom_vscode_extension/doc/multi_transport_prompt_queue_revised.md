# Multi-Transport Prompt Queue — design (revised)

> **Revision note.** This file supersedes `multi_transport_prompt_queue.md`. All
> code references have been re-anchored against the current tree (post-commit
> `483d349`, 2026-04-19). Tool names match the shipped set in
> `chat-enhancement-tools.ts`. Section §4.12 extends the four separate template
> tools instead of a hypothetical unified `tomAi_templates_manage`. The Tom AI
> Chat dispatcher gap is called out explicitly (§4.2.1) and is still unresolved
> as of this revision — `sendToTomAiChatHandler()` remains monolithic. Phase 2
> (§9) is unchanged in intent; only references were refreshed.

## Scope and phases

This design is delivered in two phases. **Phase 2 is a separate follow-up** — don't mix it into the Phase 1 commits.

- **Phase 1 — Queue multi-transport + chat-panel buttons + template editor per-transport.** Everything in §1–§8 below. The existing five-panel chat structure is preserved; each queue-compatible panel (Copilot, Anthropic, Local LLM, Tom AI Chat) just gains the "Add to Queue" and "Open Queue Editor" buttons. The `TransportPicker` component appears in the queue editor and template editor only.
- **Phase 2 — Panel consolidation** (§9). A follow-up milestone that merges the Anthropic, Local LLM, and Tom AI Chat panels into a single "LLM" panel, folds the Tom AI Chat `.md` conversation format in as a view mode, and adds a twin `TransportPicker` to the AI Conversation panel (one per participant). Structural work — bigger, optional, and sequenced *after* Phase 1 lands and the `TransportPicker` has been battle-tested in the queue + template editor.

## 1. Goal

Today the prompt queue only routes to **Copilot Chat**. Prompts are wrapped with an answer-file template, dispatched via `workbench.action.chat.open`, and advance when an answer JSON appears in the Copilot answer directory. We want the same queue to also be able to route to:

- **Anthropic** (Agent SDK or direct) — call `AnthropicHandler.instance.sendMessage()` and capture the returned text synchronously.
- **Local LLM (Ollama)** — call `LocalLlmManager.instance.ollamaGenerateWithTools()` the same way.
- **Tom AI Chat (VS Code LM API)** — call the VS Code language model API for direct LLM conversation. **No single-shot dispatcher exists yet** (see §4.2.1).

**Note:** The CHAT panel has five sections: Anthropic, Tom AI Chat, AI Conversation, Copilot, and Local LLM. The **AI Conversation** panel is for bot-to-bot orchestrated exchanges between two models — it manages its own multi-turn flow programmatically and is **not** a queue target.

Each transport writes its **own trail** already:

- Anthropic: `TrailService.writeSummaryPrompt`/`writeSummaryAnswer` with `ANTHROPIC_SUBSYSTEM` — see [anthropic-handler.ts:1097-1098](../src/handlers/anthropic-handler.ts#L1097-L1098) (Agent SDK branch) and [:1313-1314](../src/handlers/anthropic-handler.ts#L1313-L1314) (direct branch). The literal lives at [anthropic-handler.ts:176](../src/handlers/anthropic-handler.ts#L176).
- Local LLM: `logPrompt`/`logResponse` with `trailType = 'local'` — see [localLlm-handler.ts:1201](../src/handlers/localLlm-handler.ts#L1201) and [:1072](../src/handlers/localLlm-handler.ts#L1072).

So the queue does not need synthetic answer files — responses flow directly into the queue's state machine and the handler owns logging.

Parallel execution across transports is explicitly **not a goal** — a single ordered queue is sufficient.

## 2. Design decisions

1. **Single queue, per-item transport.** One `PromptQueueManager` instance, with a `transport` field on each queue item (pre-prompt, main, follow-up). Default `'copilot'` for backwards compatibility. Per-item transport lets a single ordered workflow interleave transports ("plan with Claude → run 3 tasks via Ollama → review via Copilot").
2. **Direct responses, no synthetic answer files.** For `anthropic` / `localLlm` / `tomAiChat` transports, `sendItem()` awaits the handler's entry-point and stores the returned text on the item. Advancing the queue (pre-prompt → main → follow-up → next item) is synchronous and skips the polling loop entirely.
3. **Transport-owned trails.** Anthropic and Local LLM handlers already write full trail entries. Tom AI Chat currently has its `ChatLogManager` at [tomAiChat-handler.ts:188](../src/handlers/tomAiChat-handler.ts#L188) — the refactor in §4.2.1 must keep this wired. The queue does not duplicate trails.
4. **Skip features that only make sense for Copilot** when transport is direct:
   - **Answer-wrapper template** — not applied.
   - **Reminders** — ignored (no one to nudge).
   - **`answerWaitMinutes`** — ignored (response is synchronous).
   - **`expectedRequestId`** — not extracted.
   - **Polling loop** — skipped.
5. **Queue-level default + per-item override.** The queue editor has dropdowns at the top selecting the default transport (+ profile/config as appropriate). Each item's add/edit form has a collapsible "Advanced" section to override just for that item.
6. **Chat-panel buttons for queue-compatible transports.** Every queue-compatible chat panel (Copilot, Anthropic, Local LLM, Tom AI Chat) gets the same two action-bar buttons — "Add to Queue" and "Open Queue Editor" — pre-wired to set the right transport metadata when staging. The AI Conversation panel does not get these buttons (it orchestrates bot-to-bot exchanges, not user-initiated prompts).
7. **Queue-dispatched direct items always force auto-approve-all.** Queue execution is unattended — if a tool call triggers the approval bar, the queue deadlocks. For `anthropic` items the dispatcher sets `toolApprovalMode = 'never'` unconditionally, regardless of the profile's configured value (the field's only two legal values after commit `805ee3f` are `'always'` / `'never'` — see [sendToChatConfig.ts:187](../src/utils/sendToChatConfig.ts#L187)). Local LLM's tool-approval equivalent is coerced the same way. The UI must make this explicit (see §4.7).
8. **Prompt templates are per-transport.** The four transports have four *different* template shapes today (see §4.12), so there is no shared template store to reuse. The template editor becomes per-transport (the transport picker switches which config key it edits), and the queue's template dropdown is filtered by the item's current transport. A *Default* template option (transport-agnostic body-only template) is stored in a small new shared pool.

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
| Reminder `chat.open` call | [line 859](../src/managers/promptQueueManager.ts#L859) |
| Queue editor webview | [queueEditor-handler.ts](../src/handlers/queueEditor-handler.ts) (1429 lines) |
| Reminder message routes | [queueEditor-handler.ts:197-205, 268, 287-289, 347-350, 368-371, 391-394, 412-415](../src/handlers/queueEditor-handler.ts#L197) |
| Auto-send toggle | [queueEditor-handler.ts:303](../src/handlers/queueEditor-handler.ts#L303) |
| `answerWaitMinutes` message payload | [queueEditor-handler.ts:328, 390, 411](../src/handlers/queueEditor-handler.ts#L328) |
| Anthropic entry point | [anthropic-handler.ts:868](../src/handlers/anthropic-handler.ts#L868) — `async sendMessage(options: AnthropicSendOptions): Promise<AnthropicSendResult>` |
| `AnthropicSendOptions` / `AnthropicSendResult` | [line 152](../src/handlers/anthropic-handler.ts#L152) / [line 328](../src/handlers/anthropic-handler.ts#L328) |
| `ANTHROPIC_SUBSYSTEM` literal | [anthropic-handler.ts:176](../src/handlers/anthropic-handler.ts#L176) |
| Local LLM entry point | [localLlm-handler.ts:840](../src/handlers/localLlm-handler.ts#L840) — `public async ollamaGenerateWithTools(options, userPrompt): Promise<{ text, stats?, toolCallCount, turnsUsed }>` |
| Local LLM trail writes | [localLlm-handler.ts:1201](../src/handlers/localLlm-handler.ts#L1201) (prompt), [:947, 1072, 1290](../src/handlers/localLlm-handler.ts#L947) (response — per-round, final, direct) |
| Tom AI Chat entry point (monolithic) | [tomAiChat-handler.ts:694](../src/handlers/tomAiChat-handler.ts#L694) — `sendToTomAiChatHandler()` with no args and `void` return; internally uses `vscode.lm.selectChatModels` ([:548 / :550 / :553](../src/handlers/tomAiChat-handler.ts#L548)) and `model.sendRequest` ([:1064](../src/handlers/tomAiChat-handler.ts#L1064)). **No reusable single-shot `sendMessage(opts, text) → Promise<{text}>` exists yet.** See §4.2.1. |
| Tom AI Chat `ChatLogManager` | [tomAiChat-handler.ts:188](../src/handlers/tomAiChat-handler.ts#L188) |
| Reusable per-section chat-panel markup factory | [chatPanel-handler.ts:3140](../src/handlers/chatPanel-handler.ts#L3140) — `getPromptEditorComponent(options)` (**not** a transport picker; it builds the whole panel toolbar). |
| Panel section definitions | [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts): localLlm [:3170](../src/handlers/chatPanel-handler.ts#L3170), conversation (AI Conv) [:3190](../src/handlers/chatPanel-handler.ts#L3190), copilot [:3213](../src/handlers/chatPanel-handler.ts#L3213), tomAiChat [:3281](../src/handlers/chatPanel-handler.ts#L3281), anthropic [:3300](../src/handlers/chatPanel-handler.ts#L3300) |
| Existing queue buttons (Copilot only) | [chatPanel-handler.ts:3231](../src/handlers/chatPanel-handler.ts#L3231) |
| `addToQueue` / `openQueueEditor` backend router | [chatPanel-handler.ts:675, 678](../src/handlers/chatPanel-handler.ts#L675) |
| Webview-side `addToQueue` dispatcher | [chatPanel-handler.ts:3596](../src/handlers/chatPanel-handler.ts#L3596) |
| `addCopilotToQueue()` (stages the item) | [chatPanel-handler.ts:4154](../src/handlers/chatPanel-handler.ts#L4154) |

## 4. Required changes

### 4.1 Data model — `promptQueueManager.ts`

Add to `QueuedPrompt` ([:83](../src/managers/promptQueueManager.ts#L83)), `QueuedPrePrompt` ([:69](../src/managers/promptQueueManager.ts#L69)), `QueuedFollowUpPrompt` ([:54](../src/managers/promptQueueManager.ts#L54)):

```ts
transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat';   // default 'copilot'
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
tomAiChatConfigId?: string;
answerText?: string;        // captured direct response (not written by Copilot path)
```

All six fields optional. Items without `transport` behave exactly like today.

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
  | { mode: 'direct'; answerText: string }               // anthropic | localLlm | tomAiChat
>
```

Inside the helper:

```ts
const transport = resolveStageTransport(item, stage);  // stage > item > queue default > 'copilot'
if (transport === 'copilot') {
  // Current flow: extract requestId, chat.open, return { mode: 'polled' }
}
if (transport === 'anthropic') {
  const { profile, configuration, tools } = resolveAnthropicTargets(item, stage);
  const coercedProfile = { ...profile, toolApprovalMode: 'never' as const };  // §2 decision 7
  const result = await AnthropicHandler.instance.sendMessage({
    userText: expandedText, profile: coercedProfile, configuration, tools,
  });
  return { mode: 'direct', answerText: result.text };
}
if (transport === 'localLlm') {
  const opts = resolveLocalLlmTargets(item, stage);
  const result = await LocalLlmManager.instance.ollamaGenerateWithTools(opts, expandedText);
  return { mode: 'direct', answerText: result.text };
}
// tomAiChat — see §4.2.1 below; this call does not yet exist in the codebase.
const result = await sendTomAiChatOnce({ configId: resolveTomAiChatConfig(item, stage), userText: expandedText });
return { mode: 'direct', answerText: result.text };
```

`resolveStageTransport`: stage-level item-level wins over queue-default (see §4.4 for override semantics).

#### 4.2.1 Tom AI Chat dispatcher refactor — **new work for Phase 1**

There is no reusable "send one prompt and return the text" entry point for Tom AI Chat today. The existing `sendToTomAiChatHandler()` at [tomAiChat-handler.ts:694](../src/handlers/tomAiChat-handler.ts#L694) is a panel-only flow that: (1) reads the active editor, (2) persists via `ChatLogManager` ([:188](../src/handlers/tomAiChat-handler.ts#L188)), (3) calls `model.sendRequest` ([:1064](../src/handlers/tomAiChat-handler.ts#L1064)) and writes the response back into the `.md` file. It returns `void`. Model selection uses `vscode.lm.selectChatModels` ([:548 / :550 / :553](../src/handlers/tomAiChat-handler.ts#L548) — three fallback variants).

Phase 1 needs to extract a single-shot variant, e.g.:

```ts
export async function sendTomAiChatOnce(opts: {
  configId?: string;
  templateName?: string;
  userText: string;
  /** When true, do not write to a .md conversation file — for queue use. */
  ephemeral?: boolean;
}): Promise<{ text: string }>
```

Implementation approach: factor the core "select model → build messages → sendRequest → collect text" block out of `sendToTomAiChatHandler`. The panel handler becomes a thin wrapper that adds the editor/`ChatLogManager` glue. The queue dispatcher calls `sendTomAiChatOnce` with `ephemeral: true` so queue runs don't spam `.md` files. Trails are still written by whatever logging hook exists today (confirm during implementation).

This is the single largest piece of new code in Phase 1 outside the queue editor UI — budget ~half a day. If it slips, the queue can ship Anthropic + Local LLM first and add Tom AI Chat in a follow-up; the data model already accommodates it.

### 4.3 `sendItem()` refactor

- Before calling `dispatchStage()`, **conditionally expand** the text. `_buildExpandedText()` at [promptQueueManager.ts:308](../src/managers/promptQueueManager.ts#L308) already handles the Copilot answer-wrapper case — split its behaviour:
  - Copilot: current behaviour (apply template + answer wrapper → `expandedText`).
  - Direct: apply the named template if any, **skip** `__answer_file__` wrapping and skip the `answerWrapper` boolean (both are Copilot-only constructs).
- After `dispatchStage()`:
  - `{ mode: 'polled' }`: record `expectedRequestId` and let the existing poll loop drive `continueSending()` at [:1670](../src/managers/promptQueueManager.ts#L1670).
  - `{ mode: 'direct' }`: store `answerText` on the item/stage (reuse the existing `prePrompts[i].status = 'sent'` / follow-up `repeatIndex++` machinery), then call `continueSending()` synchronously.
- On direct-transport failure: set item status `'error'` and surface the error message.
- **Inside `dispatchStage()` for Anthropic**: clone the resolved profile and set `toolApprovalMode = 'never'` before passing it to `sendMessage()`, regardless of the profile's stored value. Same applies to Local LLM's approval flow — the dispatcher coerces any tool-approval parameter to "bypass" for queue runs. See §2 decision 7.

### 4.4 Per-transport skips

When `transport !== 'copilot'`, the queue bypasses:

| Feature | Copilot behaviour | Direct behaviour |
| --- | --- | --- |
| `answerWrapper` + `__answer_file__` template | applied at `_buildExpandedText` ([:308](../src/managers/promptQueueManager.ts#L308)) | **not applied** |
| `expectedRequestId` extraction | required | skipped |
| Answer-file polling | `pollForExpectedAnswer()` ([:583](../src/managers/promptQueueManager.ts#L583)) watches directory | **not started** for this item |
| Reminders (`reminderEnabled`, `reminderTemplateId`, …) | enqueue reminder prompts on timeout | **ignored** (UI warns) |
| `answerWaitMinutes` auto-advance | triggers after N min without answer | **ignored** (response is synchronous) |

Implementation: add an `isDirectTransport(item)` / `isDirectStage(item, stage)` guard in `sendItem()`, `pollForExpectedAnswer()`, reminder scheduler, and answer-wait timer.

### 4.5 Polling-loop guard

`pollForExpectedAnswer()` already skips items with no `expectedRequestId`. Defensive belt-and-suspenders: also skip any item where `transport` is set and not `'copilot'` so a mis-constructed item can never be matched against an unrelated answer file.

### 4.6 Trail integration

No queue-side changes — transports own it.

- **Copilot**: unchanged. The answer file is the trail entry (and the existing `_ai/trail/copilot/` pipeline picks it up).
- **Anthropic**: `sendMessage()` already calls `TrailService.writeSummaryPrompt/Answer` with `ANTHROPIC_SUBSYSTEM` at [anthropic-handler.ts:1097-1098](../src/handlers/anthropic-handler.ts#L1097-L1098) / [:1313-1314](../src/handlers/anthropic-handler.ts#L1313-L1314). The queue does nothing.
- **Local LLM**: `ollamaGenerateWithTools` calls `logPrompt`/`logResponse` with `trailType = 'local'` at [:1201](../src/handlers/localLlm-handler.ts#L1201) and [:1072](../src/handlers/localLlm-handler.ts#L1072). The queue does nothing.
- **Tom AI Chat**: confirm during §4.2.1 refactor that `sendTomAiChatOnce` preserves whatever trail hook the current `sendToTomAiChatHandler` emits.

If the queue ever wants a cross-transport view, the existing trail viewer already subsystem-filters; no synthetic files required.

### 4.7 Queue editor UI — `queueEditor-handler.ts`

**Header row — queue-level defaults** (new, above the existing toolbar):

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Default transport: [ Copilot ▾ ]                                   │
│  [Anthropic selected → ] Profile: [ ▾ ]   Config: [ ▾ ]             │
│  [Local LLM selected → ] Config: [ ▾ ]                              │
│  [Tom AI Chat selected → ] Config: [ ▾ ]                            │
└─────────────────────────────────────────────────────────────────────┘
```

The three conditional dropdowns render via a new shared helper `renderTransportPicker()` (see §4.11). This helper is a **sibling** of the existing `getPromptEditorComponent()` factory at [chatPanel-handler.ts:3140](../src/handlers/chatPanel-handler.ts#L3140), not an extraction of it — the existing factory builds whole per-section toolbars; the picker is a smaller focused component that produces the transport dropdown + conditional target dropdowns.

**Per-item form — advanced section** (collapsed by default):

```text
▶ Advanced
    Transport: [ inherit (Copilot) ▾ ]
    [if Anthropic] Profile, Config pickers
    [if Local LLM] Config picker
    [if Tom AI Chat] Config picker
```

- Default value `inherit` → the stage uses the queue-level transport.
- Any explicit value overrides for this item/stage.
- When transport ≠ copilot, **disable** the Reminder dropdown and `answerWaitMinutes` input (with a tooltip explaining why). Reminder bindings currently live at [queueEditor-handler.ts:197-205, 268, 287-289, 347-350, 368-371, 391-394, 412-415](../src/handlers/queueEditor-handler.ts#L197); `answerWaitMinutes` at [:328, 390, 411](../src/handlers/queueEditor-handler.ts#L328).

**Per-stage override** (pre-prompts and follow-ups): apply the same collapsible "Advanced" section inside each stage's editor. Default to inherit-from-item. Three levels of resolution: stage > item > queue default > `'copilot'`.

**Auto-approve warning**: when the user picks `Anthropic`, `Local LLM`, or `Tom AI Chat` as the queue-level or item-level transport, render a visible notice directly below the transport dropdown:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored. The queue cannot pause for the approval bar.

No checkbox to disable it. See §2 decision 7.

**Display of direct responses**: when `item.answerText` exists (direct transport), show it inline under the item (truncated preview + expand-to-full button). The authoritative trail is the transport's trail file, but seeing the text in the queue itself is the practical way to inspect what happened.

### 4.8 Chat panel action-bar buttons — `chatPanel-handler.ts`

Today only the Copilot section has the queue buttons ([line 3231](../src/handlers/chatPanel-handler.ts#L3231)):

```html
<button data-action="addToQueue"       data-id="copilot" …>
<button data-action="openQueueEditor"  data-id="copilot" …>
```

**Changes:**

1. Add the same two buttons to the **Anthropic** ([:3300](../src/handlers/chatPanel-handler.ts#L3300)), **Local LLM** ([:3170](../src/handlers/chatPanel-handler.ts#L3170)), and **Tom AI Chat** ([:3281](../src/handlers/chatPanel-handler.ts#L3281)) sections. Each keeps its `data-id` distinct (`"anthropic"`, `"localLlm"`, `"tomAiChat"`). The **AI Conversation** section ([:3190](../src/handlers/chatPanel-handler.ts#L3190), `sectionId: 'conversation'`) does **not** get queue buttons — it orchestrates bot-to-bot exchanges, not user-initiated prompts.
2. In the `addToQueue` handler (currently `addCopilotToQueue()` at [:4154](../src/handlers/chatPanel-handler.ts#L4154), wired from the webview dispatcher at [:3596](../src/handlers/chatPanel-handler.ts#L3596)), dispatch by `data-id`. The staged queue item **must** carry the transport-specific metadata read from that panel's own dropdowns. This is non-trivial — the current Copilot button only needs `text` + `template`, but direct transports need the full target context:

   | `data-id` | `transport` set | Extra payload (read from that panel's dropdowns) |
   | --- | --- | --- |
   | `copilot` | `'copilot'` | `template`, `answerWrapper`, `repeatCount`, `answerWaitMinutes` (current) |
   | `anthropic` | `'anthropic'` | `anthropicProfileId`, `anthropicConfigId`, `template` |
   | `localLlm` | `'localLlm'` | `localLlmConfigId`, `template` |
   | `tomAiChat` | `'tomAiChat'` | `tomAiChatConfigId`, `template` |

3. The backend's queue-add router (`case 'addToQueue'` at [chatPanel-handler.ts:675](../src/handlers/chatPanel-handler.ts#L675)) must forward all five new fields into `PromptQueueManager.enqueue()` ([:1240](../src/managers/promptQueueManager.ts#L1240)) unchanged. A queue item staged from the Anthropic panel should never inherit the queue's default transport — the user clicked *that* panel's button precisely to pin the transport.
4. `openQueueEditor` (`case 'openQueueEditor'` at [chatPanel-handler.ts:678](../src/handlers/chatPanel-handler.ts#L678)) is unchanged — it opens the same queue editor regardless of which panel's button was clicked.

### 4.9 Tool surface — `chat-enhancement-tools.ts`

The queue tools in the current tree are split per-operation (not a single "queue manage" tool). Extend the input schemas of:

| Tool | Line | Purpose |
| --- | --- | --- |
| `tomAi_addQueueItem` | [:778](../src/tools/chat-enhancement-tools.ts#L778) | stage a main prompt |
| `tomAi_updateQueueItem` | [:1316](../src/tools/chat-enhancement-tools.ts#L1316) | patch fields of an existing item |
| `tomAi_sendQueueItem` | [:1398](../src/tools/chat-enhancement-tools.ts#L1398) | force-send a specific item |
| `tomAi_addQueuePrePrompt` | [:843](../src/tools/chat-enhancement-tools.ts#L843) | add a pre-prompt stage |
| `tomAi_updateQueuePrePrompt` | [:900](../src/tools/chat-enhancement-tools.ts#L900) | patch a pre-prompt |
| `tomAi_addQueueFollowUp` | [:1067](../src/tools/chat-enhancement-tools.ts#L1067) | add a follow-up stage |
| `tomAi_updateQueueFollowUp` | [:1481](../src/tools/chat-enhancement-tools.ts#L1481) | patch a follow-up |

with the five new fields (the four transport-target fields + `transport`):

```ts
transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat';
anthropicProfileId?: string;
anthropicConfigId?: string;
localLlmConfigId?: string;
tomAiChatConfigId?: string;
```

The executors forward these to the manager unchanged. Defaults mirror the data model (undefined = inherit).

Read-only tools that already list queue state (`tomAi_listQueue` at [:1218](../src/tools/chat-enhancement-tools.ts#L1218), `tomAi_setQueueItemStatus` at [:1365](../src/tools/chat-enhancement-tools.ts#L1365), `tomAi_sendQueuedPrompt` at [:986](../src/tools/chat-enhancement-tools.ts#L986)) need to **return** the new fields in their output but don't take them as input.

Removers (`tomAi_removeQueueItem` at [:1429](../src/tools/chat-enhancement-tools.ts#L1429), `tomAi_removeQueuePrePrompt` at [:939](../src/tools/chat-enhancement-tools.ts#L939), `tomAi_removeQueueFollowUp` at [:1526](../src/tools/chat-enhancement-tools.ts#L1526)) are unchanged.

### 4.10 Persistence / compatibility

Queue state is persisted to `_ai/local/*.prompt-panel.yaml` via `panelYamlStore.ts`:

- Path builder at [panelYamlStore.ts:68-72](../src/utils/panelYamlStore.ts#L68-L72): `workspace.<section>.prompt-panel.yaml`.
- Read/write at [:151](../src/utils/panelYamlStore.ts#L151) / [:164](../src/utils/panelYamlStore.ts#L164).

The new fields are additive optional → **no migration**. Existing queue items deserialise with `transport: undefined`, which resolves to `'copilot'` at dispatch time — identical to current behaviour.

### 4.11 Reusable TransportPicker component

The same set of transport dropdowns + profile/config dropdown combinations is needed in three places:

- Queue editor — queue-level default
- Queue editor — per-item / per-stage "Advanced" override
- **Prompt template editor** (see §4.12)

Rather than duplicate the markup + event handlers three times, add a new webview-side helper. **Important:** this is a *new* helper and lives alongside the existing `getPromptEditorComponent()` factory at [chatPanel-handler.ts:3140](../src/handlers/chatPanel-handler.ts#L3140). The existing factory composes full per-section panel toolbars (selector + manage buttons + action buttons + reusable prompt controls + panel slots). The new picker is smaller and focused:

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
- Anthropic → profile dropdown + config dropdown. Data is loaded via the existing `sendToChatConfig.anthropic.configurations` ([sendToChatConfig.ts:138-166](../src/utils/sendToChatConfig.ts#L138-L166)) + `.profiles` ([:167-190](../src/utils/sendToChatConfig.ts#L167-L190)) arrays.
- Local LLM → config dropdown only (source: `sendToChatConfig.localLlm.configurations` at [:59-76](../src/utils/sendToChatConfig.ts#L59-L76)).
- Tom AI Chat → config dropdown only (source: `sendToChatConfig.tomAiChat` block at [:105-117](../src/utils/sendToChatConfig.ts#L105-L117); currently one implicit config — the dropdown will be single-option until more configs exist).

In the **template editor** (§4.12) `showTargets` should be **`false`** — templates don't pin a profile/config; they just declare which transport store they belong to. Profile/config are applied at queue time, not template-define time.

The picker emits a single `{ type: onChangeEvent, transport, anthropicProfileId?, anthropicConfigId?, localLlmConfigId?, tomAiChatConfigId? }` message, and the consuming handler writes it to the right store (queue item, queue default, or template record).

### 4.12 Prompt template editor — per-transport templates

Today the four template tools (list / create / update / delete) only touch the **Copilot** template store `config.copilot.templates` at [sendToChatConfig.ts:118-122](../src/utils/sendToChatConfig.ts#L118-L122) — see the hard-coded routing in `getPromptTemplates()` inside [chat-enhancement-tools.ts:1743](../src/tools/chat-enhancement-tools.ts#L1743). With multi-transport queueing the editor must also reach the other three stores — which have **genuinely different shapes**:

| Transport | Config key | Shape |
| --- | --- | --- |
| Copilot | `config.copilot.templates` ([:118-122](../src/utils/sendToChatConfig.ts#L118-L122)) | map `{ [name]: { template, showInMenu? } }` |
| Anthropic | `config.anthropic.userMessageTemplates` ([:191-197](../src/utils/sendToChatConfig.ts#L191-L197)) | array `[{ id, name, description?, template, isDefault? }]` |
| Tom AI Chat | `config.tomAiChat.templates` ([:107-116](../src/utils/sendToChatConfig.ts#L107-L116)) | map `{ [name]: { label, description?, contextInstructions?, systemPromptOverride?, toolsEnabled?, enabledTools? } }` — **not a plain body template**, structural system-prompt config |
| Local LLM | per-profile `systemPrompt` + `resultTemplate` ([:27-28](../src/utils/sendToChatConfig.ts#L27-L28)) + `config.localLlm.defaultTemplate` ([:77](../src/utils/sendToChatConfig.ts#L77)) | **per-profile** attributes, no separate named store |
| Default (new) | `config.sharedQueueTemplates` (new) | array `[{ id, name, description?, template }]` — transport-agnostic body text |

**Template editor changes:**

1. **Add the TransportPicker** (context `'template-editor'`, `showTargets: false`) at the top of the editor. Its value selects which store the editor is reading/writing.
2. **Load the template list from that store** on transport change. For Tom AI Chat and Local LLM the list is **structurally different** from the simple `{name, body}` model the editor renders today — the editor must branch:
   - Copilot / Anthropic / Default → render a plain "name + body" edit form (current form, unchanged).
   - Tom AI Chat → render label + description + contextInstructions + systemPromptOverride fields. Body-only templates can still be stored alongside, but the editor should surface the fuller shape.
   - Local LLM → **read-only listing** of per-profile `resultTemplate` strings; editing the body happens via the Local LLM profile editor, not here. Show a hint: *"Local LLM templates live on each profile. Open the Local LLM profile editor to change them."*
3. **Create/update/delete** operations go to the matching config key. Instead of a single "templates_manage" tool this design extends the **four existing template tools** (`tomAi_listPromptTemplates` [:1752](../src/tools/chat-enhancement-tools.ts#L1752), `tomAi_createPromptTemplate` [:1771](../src/tools/chat-enhancement-tools.ts#L1771), `tomAi_updatePromptTemplate` [:1799](../src/tools/chat-enhancement-tools.ts#L1799), `tomAi_deletePromptTemplate` [:1833](../src/tools/chat-enhancement-tools.ts#L1833)) with a `transport?` field (default `'copilot'` for backward compatibility).
4. **Default store bootstrap**: if the user creates a template with transport `Default`, write it to `config.sharedQueueTemplates[]`. This is a new config key — additive, requires a one-line addition to `SendToChatConfig` and the JSON schema.

**Queue editor — template dropdown** (existing):

- When a queue item's effective transport is known, the template dropdown **filters its contents to that transport's store plus the Default store**. The Default store is always visible because its templates are transport-neutral.
- Changing a queue item's transport **blanks** the template selection (see §5 edge case). The dropdown repopulates with templates for the new transport + Default.

**Per-tool extension:**

- `tomAi_listPromptTemplates` — add `transport?: 'copilot' | 'anthropic' | 'localLlm' | 'tomAiChat' | 'default'`. Without a `transport`, list only Copilot templates (current behaviour — see `getPromptTemplates()` at [:1743](../src/tools/chat-enhancement-tools.ts#L1743)). With a transport, return that store's templates, normalised into a common `{ id?, name, template, extras?: { …transport-specific fields } }` shape.
- `tomAi_createPromptTemplate` / `tomAi_updatePromptTemplate` / `tomAi_deletePromptTemplate` — same `transport?` field. For Local LLM, `create` returns an error steering the user to the profile editor; `update`/`delete` of a Local LLM `resultTemplate` is allowed and writes to the profile. For Tom AI Chat, accept the extra structural fields (`label`, `description`, `contextInstructions`, `systemPromptOverride`).

## 5. Edge cases and non-obvious bits

- **Template expansion placeholders** (`${repeatNumber}`, `${repeatIndex}`, chat variables): these happen at expand-time inside `_buildExpandedText` at [promptQueueManager.ts:308](../src/managers/promptQueueManager.ts#L308) — unchanged. Chat-variable-driven `repeatCount` keeps working identically.
- **Pre-prompts with direct transport**: each pre-prompt awaits its own direct call. Because direct calls are synchronous, the pre-prompt chain runs back-to-back without polling gaps. This is much faster than the Copilot flow, which waits 30-second poll intervals between stages. May surprise users — consider documenting in the queue editor's help text.
- **Direct pre-prompt output → next-stage context? (open question).** The doc deliberately does *not* pipe `pre.answerText` into the main item's prompt. If the user wants that, they should place a `${prePrompt[0].answer}` placeholder or similar in the main prompt. Alternatively, we could add an opt-in "chain answers" toggle on the item. Decision deferred — see Open Questions §6.1.
- **`sendMaximum` on timed requests**: orthogonal to transport; still counted the same way.
- **`templateRepeatCount`**: re-runs the entire (pre-prompts + main + follow-ups) group. Works identically per-transport. If transport is direct, the whole re-run is fast and synchronous.
- **Anthropic `profile.toolApprovalMode`**: only valid values today are `'always' | 'never'` ([sendToChatConfig.ts:187](../src/utils/sendToChatConfig.ts#L187) — after commit `805ee3f`). Queue dispatch **always overrides** to `'never'` — see §2 decision 7 and §4.3. The profile's stored value applies only when the profile is used interactively from the chat panel.
- **Template reference invalidated when transport changes.** A queue item's `template` name is meaningful only within one transport's store. If the user switches a queue item's transport (via the per-item Advanced picker) from Copilot to Anthropic, the previously-selected template name may not exist in `config.anthropic.userMessageTemplates`. **Handling**: on transport change inside the queue editor, clear the template selection and repopulate the dropdown from the new transport's store + Default store. Do **not** try to copy templates across stores automatically — too magical, and Tom AI Chat's shape doesn't even match the simple body-only model. A "Save a copy in the new transport's store" button on the item editor is a reasonable future add; out of scope for the first pass.
- **Tom AI Chat and Local LLM template shapes don't round-trip.** Tom AI Chat templates carry structural fields (`systemPromptOverride`, `contextInstructions`) that have no meaning in the other stores; Local LLM templates are per-profile. The template editor must not offer to "convert" a template between stores — the user has to recreate it deliberately.
- **Concurrency**: the queue is strictly sequential (one `sending` item at a time — see the `isEditableStatus` guard in `promptQueueManager.ts`). Direct transport doesn't change this.
- **Failure modes**:
  - Anthropic API error → item status `'error'`, error message surfaced, queue pauses (same as the current `'error'` handling).
  - Local LLM timeout → ditto.
  - Tom AI Chat — `vscode.lm.selectChatModels` returns empty → surface "no LM available", pause queue, do not retry.
  - Config-id references a profile/config that no longer exists → dispatcher returns a clear error without touching the transport.
- **`tomAi_askCopilot` inside an Anthropic direct-transport item**: valid — the Anthropic call can still use the `askCopilot` tool which bounces a sub-question into Copilot Chat. That's pre-existing behaviour, just not the queue's main-prompt transport.

### 6.1 Open questions

1. **Should direct-transport pre-prompts feed into the main prompt automatically?** See bullet above. Default proposal: no — user uses placeholders or the follow-up chain to carry context. Confirm before implementing.
2. **Tom AI Chat dispatcher — can we safely factor the model+messages code out of `sendToTomAiChatHandler` without breaking the `.md` conversation format?** Smoke-test with a hand-crafted queue item before rolling the dispatcher out.
3. **Does Local LLM need a per-run `toolApprovalMode` equivalent, or is its tool path already fire-and-forget?** Confirm during implementation of §4.3.

## 6. Step-by-step implementation order

1. **Data model** — add the six optional fields (§4.1) + `answerText`. One commit; no behaviour change yet.
2. **Tom AI Chat dispatcher refactor** (§4.2.1) — extract `sendTomAiChatOnce(opts)` from `sendToTomAiChatHandler`. Lands before anything else in the queue that depends on it; otherwise the queue can ship with only Copilot/Anthropic/Local LLM wired and Tom AI Chat added in a later commit.
3. **Transport dispatcher + `sendItem()` branch** (§4.2, §4.3) — introduce `dispatchStage()` but default all items to `'copilot'` so the flow is byte-identical. Add unit-tests for each transport branch.
4. **Polling / reminder / answer-wait guards** (§4.4, §4.5) — skip direct items in all three. Verify Copilot still works end-to-end.
5. **Direct-transport execution** — wire Anthropic first, exercise with a hand-crafted item; then Local LLM; then Tom AI Chat.
6. **Tool-input extensions** (§4.9) — expose the five new fields in the seven add/update queue tools.
7. **Reusable `renderTransportPicker()` helper** (§4.11) — new sibling to `getPromptEditorComponent`. Call sites come in the next steps.
8. **Queue editor UI** (§4.7) — queue-level dropdowns + per-item Advanced section, using the helper from step 7. Transport change blanks the template selection.
9. **Chat-panel buttons** (§4.8) — add the two buttons to Anthropic / Local LLM / Tom AI Chat sections. Dispatch by `data-id`; the payload carries transport + target ids read from the clicked panel's own dropdowns. (AI Conversation is excluded.)
10. **Add `config.sharedQueueTemplates` to `SendToChatConfig` + JSON schema** (§4.12) — one-line additions; needed before the template editor gets a Default option.
11. **Template editor — per-transport switcher** — add the `renderTransportPicker()` at the top, swap the list source + edit form per transport (Tom AI Chat's structural form is a branch, Local LLM is read-only with a hint).
12. **Extend the four prompt-template tools with `transport`** (§4.12) — default `'copilot'` for backward compat; routes to the matching store.
13. **Documentation** — update `llm_tools.md`, `copilot_chat_integration.md` if it exists, and this doc's "current state" once implemented.

Rough effort: **4–5 days** end-to-end (up from 3–4 in the original doc to absorb the Tom AI Chat dispatcher refactor). The template editor per-transport branching remains the largest single UI chunk.

## 7. Out of scope (for Phase 1)

- Parallel execution across transports (explicitly not needed).
- Cross-transport abstraction as a shared `ChatTransport` interface — a local dispatcher is simpler and has no reuse target beyond the queue.
- **AI Conversation panel (as a queue target)** — bot-to-bot orchestration, manages its own multi-turn flow. The queue does not drive it; the AI Conversation panel does not get queue buttons. (But it *does* get transport pickers in Phase 2 — see §9.3.)
- **Panel consolidation** — merging Anthropic + Local LLM + Tom AI Chat into a single "LLM" panel is Phase 2 work, designed in §9 below.
- Streaming responses — current transports return the full text once done; no stream events are propagated to the queue. If needed later, add an `onChunk` callback to the dispatcher without changing the overall shape.
- UI for viewing the direct-response trail from inside the queue editor — the existing trail viewer already covers this.
- Automatic chaining of direct pre-prompt answers into the main prompt — see §6.1 open question 1.

## 8. Acceptance checklist

- [ ] A queue item with `transport: 'anthropic'` fires `AnthropicHandler.instance.sendMessage()`, stores the text in `answerText`, and advances without polling.
- [ ] A queue item with `transport: 'localLlm'` fires `LocalLlmManager.instance.ollamaGenerateWithTools()`, stores the text, and advances without polling.
- [ ] A queue item with `transport: 'tomAiChat'` fires `sendTomAiChatOnce()` (new, §4.2.1), stores the text, and advances without polling.
- [ ] Existing Copilot queue items are byte-identical in behaviour (template wrapper, answer-file polling, reminders, answer-wait).
- [ ] Queue editor header shows the transport default + conditional profile/config dropdowns for each non-Copilot transport.
- [ ] Per-item Advanced section lets me override transport for one item; per-stage override works inside pre-prompts and follow-ups.
- [ ] Reminder + answerWait fields are visibly disabled for direct-transport items.
- [ ] Selecting Anthropic, Local LLM, or Tom AI Chat transport shows the auto-approve-all warning.
- [ ] Queue-dispatched Anthropic items run with `toolApprovalMode = 'never'` even when the profile stores `'always'` — verified by a tool call that would otherwise prompt.
- [ ] "Add to Queue" + "Open Queue Editor" buttons exist on queue-compatible chat panels (Copilot, Anthropic, Local LLM, Tom AI Chat). AI Conversation panel does **not** have these buttons.
- [ ] Each chat panel's "Add to Queue" button stages an item with the **correct transport** and target-ids read from that panel's own dropdowns (not the queue's default).
- [ ] `tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_addQueuePrePrompt`, `tomAi_updateQueuePrePrompt`, `tomAi_addQueueFollowUp`, `tomAi_updateQueueFollowUp`, `tomAi_sendQueueItem` accept the five new fields.
- [ ] `tomAi_listQueue` returns the new fields in its output.
- [ ] Anthropic and Local LLM trail files contain entries for queue-dispatched prompts (verified by the transport's own logging); Tom AI Chat trail hook preserved through the dispatcher refactor.
- [ ] A queue item with a stale/invalid `anthropicProfileId` surfaces a clear error.
- [ ] `renderTransportPicker()` helper is used in all three call sites (chat panel, queue editor, template editor) with the right `context` value.
- [ ] Template editor's transport picker switches the list source for Copilot / Anthropic / Default stores and renders Tom AI Chat's structural form when selected.
- [ ] Template editor shows the read-only hint for Local LLM with a pointer to the profile editor.
- [ ] Switching a queue item's transport in the editor clears its template selection and repopulates the dropdown.
- [ ] `tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate` honour a `transport` field, defaulting to `copilot` when absent.
- [ ] `config.sharedQueueTemplates` exists in `SendToChatConfig` + JSON schema and holds Default templates.

## 9. Phase 2 — panel consolidation (deferred)

Phase 1 keeps the five-panel structure untouched. Phase 2 consolidates the chat panels so the `TransportPicker` component becomes the primary way to choose a backend, instead of a panel-per-transport. **This is a separate milestone** — land it after Phase 1 is proven in production.

### 9.1 What consolidates and what doesn't

The three "direct API" transports (Anthropic, Local LLM, Tom AI Chat as a VS Code LM API consumer) are structurally a unit — same `sendMessage(opts, text) → Promise<{text}>` shape (once §4.2.1 lands), same config+profile picker structure, same approval gate. Copilot is different (answer-file protocol); AI Conversation is different (bot-to-bot meta panel).

| Transport | Structural role | Phase 2 outcome |
| --- | --- | --- |
| Anthropic | Direct API, configurations + profiles | folds into **LLM panel** |
| Local LLM (Ollama) | Direct API, configurations | folds into **LLM panel** |
| Tom AI Chat (VS Code LM API) | Direct API, `.md` conversation format is a view mode | folds into **LLM panel** as `Conversation (.md)` view mode |
| Copilot | Answer-file protocol, externally-managed conversation history | stays its own panel |
| AI Conversation | Two participants, multi-turn meta | stays its own panel, gains **twin transport pickers** (§9.3) |

**Final layout: 3 panels** (down from 5): *LLM*, *Copilot*, *AI Conversation*.

Tom AI Chat simplification (user-confirmed): it uses the VS Code LM API in a programming model almost identical to the Anthropic API. **Model selection is a config parameter, not a separate picker.** Currently there is only one Tom AI Chat configuration; the consolidated LLM panel will surface Tom AI Chat via the `TransportPicker`'s config dropdown (which will be a single-option dropdown until more configs exist).

### 9.2 Merged "LLM" panel

**UI on top:**

- `TransportPicker` in `queue-default` mode with transport set `{Anthropic | Local LLM | Tom AI Chat}` — no "inherit"/"default" option because this panel *is* the top-level selector.
- Conditional target dropdowns below (from `showTargets: true`):
  - Anthropic → profile + config.
  - Local LLM → config.
  - Tom AI Chat → config (single option today).
- **View mode** toggle: `[ Single exchange | Conversation (.md) ]`.
  - `Single exchange` — behaves like today's Anthropic/Local LLM panels (one prompt → one reply → clear).
  - `Conversation (.md)` — behaves like today's Tom AI Chat panel (persists to a `.md` file, each send appends). Orthogonal to transport.

**Panel state per transport:** the panel remembers the last-used configuration per transport, so switching the transport picker doesn't force re-selection of config every time.

**What unifies under the hood:**

- **User-message templates** — all three direct transports take a text prompt and optionally wrap it. Canonical store becomes `config.sharedQueueTemplates[]` (introduced in §4.12 for queue use). The legacy `anthropic.userMessageTemplates[]` and `copilot.templates[]` stay read-only for migration; the merged panel only writes to `sharedQueueTemplates`.
- **System prompt (optional override)** — one textarea. Per-transport the handler maps it to the right API field (Anthropic `system:`, Local LLM message prefix, Tom AI Chat `systemPromptOverride`).

**What stays per-transport:**

- Configurations (Anthropic configs have `apiKeyEnvVar`/`maxTokens`, Local LLM configs have `ollamaUrl`/`keepAlive` — genuinely different schemas).
- Tool approval semantics — each transport owns its own approval gate.
- Trail writers (already per-transport; see §4.6).
- Tom AI Chat's structural `.md` configuration (contextInstructions, documents referenced) — lives on the *conversation*, not on the transport.

### 9.3 AI Conversation panel — twin transport pickers

AI Conversation orchestrates two participants exchanging messages. Today each participant has its own hard-coded backend selector. Phase 2: each participant gets its own `TransportPicker` (context `queue-item`, `showTargets: true`). So participant A could be Anthropic+profile-X while participant B is Local LLM+config-Y.

This keeps the AI Conversation panel intact as a standalone surface but surfaces the same transport model as the rest of the UI. No queue integration — AI Conversation still manages its own turn-taking loop.

### 9.4 Keybinding + command compatibility

Double-check findings from before Phase 2 design:

- **Per-panel chord-menu keybindings** (see `chordMenu-handler.ts`): `tomAi.chordMenu.copilot`, `.aiConversation`, `.localLlm`, `.tomAiChat` exist today.
  - `.copilot` / `.aiConversation` — stay, target the same panels unchanged.
  - `.localLlm` — **aliased** to open the merged LLM panel with transport pre-selected to Local LLM.
  - `.tomAiChat` — **aliased** to open the merged LLM panel with transport pre-selected to Tom AI Chat + view mode set to `Conversation (.md)`.
  - No `tomAi.chordMenu.anthropic` command exists today; optionally add one that opens the LLM panel with transport pre-selected to Anthropic.
- **Per-panel `sendTo*` commands** (`tomAi.sendToCopilot.*`, `tomAi.sendToLocalLlm.*`) — all stay. The `sendToLocalLlm.*` commands internally dispatch into the merged LLM panel with transport `Local LLM` pre-selected and the named template applied.
- **Settings keys** (`tomAi.copilot.*`, `tomAi.localLlm.*`, `tomAi.tomAiChat.*`) — unchanged. They back per-transport configurations, which still exist under the hood.
- **No direct key-command references to "panel"** are in use — the merging can proceed without binding rewrites.

### 9.5 Migration / risk

- **Persisted panel state** in `_ai/local/*.prompt-panel.yaml` (see [panelYamlStore.ts:68-72](../src/utils/panelYamlStore.ts#L68-L72)) — today there are per-panel YAMLs (`copilot`, `localLlm`, `tomAiChat`, `aiConversation`). After merge, Local LLM + Tom AI Chat state migrates into a single `llm.prompt-panel.yaml` (transport + config + view mode + history). Write a one-shot migration on first activation that reads the legacy files and seeds the new one, then leaves the old files in place as a backup.
- **Template editor** — already per-transport from Phase 1 (§4.12). Phase 2 adds no new template work; the user-message-template store just becomes the default home for templates written from the merged LLM panel.
- **Risk of dropped features** — audit each of the three panels for any transport-specific UI (e.g. Anthropic's "test API key" button, Local LLM's "reload models") and make sure every feature maps to the merged panel (conditional on transport).

### 9.6 Open questions before committing to Phase 2

1. **`.md` conversation format portability** — cheap verification: does Tom AI Chat's current system-prompt composition (context instructions + systemPromptOverride) render sensibly when the backend is Anthropic or Local LLM instead of VS Code LM? Smoke-test with a few conversations before locking the view-mode merge.
2. **Anthropic "test API key" button** — fits naturally into the merged panel's config-level actions; no new design needed.
3. **Tom AI Chat's `contextInstructions`** — belongs on the conversation document, not on the transport. The merged panel needs a place to surface / edit those when view mode is `Conversation (.md)`.
4. **Model selection in Tom AI Chat** — today a config parameter, single config exists. If more configs get added later, the `TransportPicker`'s config dropdown handles it without extra work.

### 9.7 Phase 2 acceptance checklist

- [ ] A single **LLM** panel exists, with a transport picker covering Anthropic, Local LLM, Tom AI Chat and conditional profile/config dropdowns.
- [ ] View mode toggle (`Single exchange` / `Conversation (.md)`) persists per transport.
- [ ] Legacy `tomAi.chordMenu.localLlm` / `.tomAiChat` open the merged panel with the right pre-selected transport.
- [ ] All legacy `sendTo*` commands continue to work end-to-end.
- [ ] Existing `_ai/local/*.prompt-panel.yaml` state migrates cleanly on first activation.
- [ ] AI Conversation panel renders **two** `TransportPicker` components (one per participant), with independent config selection.
- [ ] AI Conversation still runs its own turn loop; no queue integration.
- [ ] Copilot panel is unchanged.
- [ ] No regression in the per-transport trail writers.
