# Prompt Queue — transport and dispatch design

The queue has one transport, **Anthropic**: every queue item, pre-prompt,
follow-up and timed request is sent through the Anthropic handler. A new
model backend is a configuration type an Anthropic profile references
(the JSON field is `transport`), not a queue transport. Local LLM
configurations surface inside the Anthropic profile's config picker and
dispatch through a synthesised shim configuration with
`transport: 'localLlm'` so the handler fork stays uniform.

The Anthropic handler owns a shared loop over four leaf primitives —
Direct, Agent SDK, VS Code LM, Local LLM — each a one-round API call
(or the full SDK stream for Agent SDK). The queue sees only
`anthropic`. @CHAT has the ANTHROPIC/LLM subpanel with its queue
buttons, and the Logs section. The Local LLM leaf calls the
public `callLocalLlmOnce` entry point on `LocalLlmManager`, the
single-round HTTP primitive.

## 1. Goal

The prompt queue routes every prompt through the **Anthropic** handler, which itself forks into four concrete API calls based on the Anthropic profile's selected configuration:

- **Direct** — `@anthropic-ai/sdk`.
- **Agent SDK** — `@anthropic-ai/claude-agent-sdk`.
- **VS Code LM** — `vscode.lm.selectChatModels` + `model.sendRequest` (a configuration type).
- **Local LLM (Ollama / OpenAI-compatible)** — `LocalLlmManager.callLocalLlmOnce` (a Local LLM configuration, referenced from the Anthropic profile's config picker).

From the queue's perspective there is **one transport**: `anthropic`. The four-way fork happens inside `AnthropicHandler.sendMessage()` based on `configuration.transport` (plus the synthesised `transport: 'localLlm'` shim when the profile's `configurationId` resolves to a Local LLM config); the queue does not care which leaf path ran.

**One ordered queue per process run** — each run is a lane of its own (`utils/queueLanes.ts`), and the items of a lane are sent one after the other.

## 2. Design decisions

1. **One transport.** `QueuedTransport` is `'anthropic'`. An item, pre-prompt or follow-up may carry `transport: 'anthropic'` or leave it out; either way it runs on Anthropic. A stored `transport: copilot` is read as `anthropic` (`readStoredTransport`). What a single ordered workflow varies per item or stage is the **profile** ("plan with one profile → run three tasks with another").
2. **VS Code LM is an Anthropic configuration type.** The `AnthropicConfiguration.transport` enum is `'direct' | 'agentSdk' | 'vscodeLm'`, with a fourth synthesised value `'localLlm'` used at runtime when a profile references a Local LLM config (never persisted). A `vscodeLm` configuration carries the selector params for `vscode.lm.selectChatModels` as a required triple `{vendor, family, modelId}`. Trails land in the same `_ai/trail/anthropic/*` directory as the other two persisted types.
3. **Local LLM configurations are referenced from Anthropic profiles.** The Local LLM config schema is its own and lives in `config.localLlm.configurations`. The Anthropic profile's config picker lists Anthropic configurations AND Local LLM configurations, labelled by backing type. Selecting a Local LLM config on an Anthropic profile swaps only the final API call — prompt composition, tool approval, live trail, trail-file layout, user-message templates, and the queueing UI are the ANTHROPIC/LLM panel's.
4. **Direct responses.** `dispatchStage()` awaits `AnthropicHandler.sendMessage()` and stores the returned text on the queue item or stage (`answerText`). A dispatch always completes inline: when the call returns, the stage is answered.
5. **Transport-owned trails.** AnthropicHandler writes prompt + answer + tool-call + live-trail entries for every leaf path (same subsystem, same directory). The queue does not duplicate trails.
6. **The awaited call is the stage.** The queue puts nothing around the prompt but its template, starts no timer for an answer and watches no file: a stage begins with the call to `sendMessage` and ends when it returns or throws.
7. **Queue-dispatched items force auto-approve-all.** Queue execution is unattended — any tool call that triggers the approval bar would deadlock the queue. The dispatcher sets `toolApprovalMode = 'never'` regardless of the profile's stored value (`'always' | 'acceptEdits' | 'never'`, [sendToChatConfig.ts:244](../src/utils/sendToChatConfig.ts#L244)). The UI must surface this (see §4.10).
8. **Shared prompt composition, APIs that don't separate system/user get concatenated.** The ANTHROPIC/LLM panel's rules apply to every leaf path: profile system prompt + user-message template + user prompt = final composed prompt. When the leaf API (VS Code LM, Local LLM) doesn't take a separate `system` field, the handler concatenates `{systemPrompt}\n\n{userText}` before the call. Direct and Agent SDK use the structured fields they take.
9. **One template store.** Every send — every Anthropic profile whatever its configuration type — takes its template from `config.anthropic.userMessageTemplates`. No per-configuration-type templates.
10. **The ANTHROPIC/LLM panel carries queue buttons** — Save to Queue and Queue next, each for the default run and for the panel's own target (§4.11).

## 3. Current state reference

| Concern | Where |
| --- | --- |
| Queue manager | [promptQueueManager.ts](../src/managers/promptQueueManager.ts) |
| `QueuedTransport` type (`'anthropic'`), `readStoredTransport()` | [line 257](../src/managers/promptQueueManager.ts#L257) |
| `QueuedFollowUpPrompt` / `QueuedPrePrompt` / `QueuedPrompt` interfaces | [lines 264 / 279 / 303](../src/managers/promptQueueManager.ts#L264) |
| `_buildExpandedText()` (repeat affixes, todo record, template) | [line 1135](../src/managers/promptQueueManager.ts#L1135) |
| `enqueue()` | [line 1902](../src/managers/promptQueueManager.ts#L1902) |
| `continueSending()` | [line 2913](../src/managers/promptQueueManager.ts#L2913) |
| `sendItem()` — starts an item | [line 4131](../src/managers/promptQueueManager.ts#L4131) |
| `resolveStageTransport()` — profile, configuration and session of a stage: stage › item › session › run default | [line 4970](../src/managers/promptQueueManager.ts#L4970) |
| `dispatchStage()` — the one dispatch, through `AnthropicHandler.sendMessage` | [line 5024](../src/managers/promptQueueManager.ts#L5024) |
| `dispatchNextStageForSendingItem()` — the stage loop of a sending item | [line 6011](../src/managers/promptQueueManager.ts#L6011) |
| Queue editor webview | [queueEditor-handler.ts](../src/handlers/queueEditor-handler.ts), `media/queueEditor/`, `media/shared/queueEntry*.js` |
| `editItemTransport` / `editPrePromptTransport` / `editFollowUpTransport` (the gear's profile → configuration pick) | [queueEditor-handler.ts:563](../src/handlers/queueEditor-handler.ts#L563) |
| `toggleAutoSend` | [queueEditor-handler.ts:1059](../src/handlers/queueEditor-handler.ts#L1059) |
| `stopActiveItem` | [queueEditor-handler.ts:1113](../src/handlers/queueEditor-handler.ts#L1113) |
| `interruptActiveForContinuation` / `interruptForContinuation` (interrupt for continuation, §4.18) | [queueEditor-handler.ts:1123](../src/handlers/queueEditor-handler.ts#L1123) |
| `AnthropicTransport` leaf enum (`'direct' \| 'agentSdk' \| 'vscodeLm' \| 'localLlm'`) | [anthropic-handler.ts:132](../src/handlers/anthropic-handler.ts#L132) |
| `AnthropicSendOptions` / `AnthropicSendResult` | [line 349](../src/handlers/anthropic-handler.ts#L349) / [line 553](../src/handlers/anthropic-handler.ts#L553) |
| `AnthropicHandler` class | [anthropic-handler.ts:665](../src/handlers/anthropic-handler.ts#L665) |
| `sendMessage()` entry point | [anthropic-handler.ts:2190](../src/handlers/anthropic-handler.ts#L2190) — `async sendMessage(options: AnthropicSendOptions): Promise<AnthropicSendResult>` |
| Anthropic Agent SDK branch | [anthropic-handler.ts:2531](../src/handlers/anthropic-handler.ts#L2531) |
| VS Code LM branch (`sendViaVsCodeLm`) | [anthropic-handler.ts:3196](../src/handlers/anthropic-handler.ts#L3196) |
| Local LLM branch (`sendViaLocalLlm`, synthesised shim) | [anthropic-handler.ts:3509](../src/handlers/anthropic-handler.ts#L3509) (calls `callLocalLlmOnce` at [:3653](../src/handlers/anthropic-handler.ts#L3653)) |
| Trail writes (`writeSummaryPrompt` / `writeSummaryAnswer`) | [anthropic-handler.ts:2482](../src/handlers/anthropic-handler.ts#L2482), [:2702](../src/handlers/anthropic-handler.ts#L2702) |
| `ANTHROPIC_SUBSYSTEM` literal | [services/trailSubsystems.ts:16](../src/services/trailSubsystems.ts#L16) |
| `callLocalLlmOnce()` — single-round HTTP primitive | [localLlm-handler.ts:595](../src/handlers/localLlm-handler.ts#L595) |
| `resolveAnthropicTargets()` — shared profile + config resolver | [utils/resolveAnthropicTargets.ts:50](../src/utils/resolveAnthropicTargets.ts#L50) |
| Local LLM configurations (`sendToChatConfig`) | [sendToChatConfig.ts:30](../src/utils/sendToChatConfig.ts#L30) |
| Anthropic configurations (`transport` enum + `vscodeLm` block) | [sendToChatConfig.ts:153](../src/utils/sendToChatConfig.ts#L153) |
| Anthropic profiles (`toolApprovalMode`) | [sendToChatConfig.ts:209](../src/utils/sendToChatConfig.ts#L209) |
| Anthropic user-message templates | [sendToChatConfig.ts:267](../src/utils/sendToChatConfig.ts#L267) |
| `getPromptEditorComponent` factory (the panel section's toolbar, with the queue buttons) | [media/chatPanel/main.js:312](../media/chatPanel/main.js#L312) |
| Webview-side `addAnthropicToQueue()` | [media/chatPanel/main.js:1665](../media/chatPanel/main.js#L1665) |
| `addToQueue` / `openQueueEditor` backend router | [chatPanel-handler.ts:597, 621](../src/handlers/chatPanel-handler.ts#L597) |
| `_handleAddToQueue()` | [chatPanel-handler.ts:1884](../src/handlers/chatPanel-handler.ts#L1884) |
| Queue tools | [prompt-queue-tools.ts](../src/tools/prompt-queue-tools.ts) |

## 4. Required changes

### 4.1 Data model — `promptQueueManager.ts`

`QueuedPrompt`, `QueuedPrePrompt` and `QueuedFollowUpPrompt` carry:

```ts
transport?: 'anthropic';                 // the one transport; may be left out
anthropicProfileId?: string;             // Anthropic profile id
anthropicConfigId?: string;              // may reference an Anthropic config OR a Local LLM config
answerText?: string;                     // the response the dispatch returned
```

All four fields optional. An item without them runs with its session's profile, else its run's default profile (§4.19).

`anthropicConfigId` is intentionally a single loosely-typed id — it can point at an Anthropic configuration (`direct` / `agentSdk` / `vscodeLm`) or at a Local LLM configuration. The handler resolves the id against both stores when dispatching.

### 4.2 Anthropic configuration type: `vscodeLm`

The `AnthropicConfiguration.transport` enum is `'direct' | 'agentSdk' | 'vscodeLm'`. A `vscodeLm` configuration stores the model identity at configure-time in a sibling `vscodeLm` object (flat-record style — the interface keeps `transport` on the one field, and the configure-time-resolved selector triple is nested):

```ts
interface AnthropicConfiguration {
    id: string;
    name: string;
    model: string;                    // mirrors vscodeLm.modelId for UI display
    maxTokens: number;
    maxRounds: number;
    transport?: 'direct' | 'agentSdk' | 'vscodeLm';  // 'direct' when omitted
    vscodeLm?: {                      // set when transport === 'vscodeLm'
        vendor: string;               // e.g. 'copilot'
        family: string;               // e.g. 'gpt-4o' or 'claude-sonnet-4.5'
        modelId: string;              // exact id picked at configure-time
    };
    agentSdk?: AnthropicAgentSdkOptions;
    localLlm?: { baseUrl; model; temperature; keepAlive? };  // runtime-synthesised only
    // … other fields
}
```

**The model is stored on the configuration, NOT resolved per send.** A `vscodeLm` configuration holds `{vendor, family, modelId}`; editing it on the Extension State Page keeps that triple, so the other fields can be changed without retargeting the model. On a send, the handler calls `selectChatModels({ vendor, family })` and picks the entry whose `id === modelId` — this is a cheap filter against an already-cached-by-VS-Code list, not a fresh enumeration across providers.

**Trail directory is the same** as the other two types (`_ai/trail/anthropic/*`), because from the user's perspective this is still "an Anthropic configuration" — it just happens to route to VS Code's LM API.

The JSON schema and the `SendToChatConfig` type carry the type.

### 4.3 Anthropic profile config picker — widened source

The Anthropic profile's `configId` dropdown sources from `config.anthropic.configurations` and from `config.localLlm.configurations` ([sendToChatConfig.ts:30](../src/utils/sendToChatConfig.ts#L30)), with a visible backing-type label so the user knows which path they're pinning. The Local LLM configuration schema itself is its own.

Resolution order inside `AnthropicHandler.sendMessage()` when handling `profile.configId`:

1. Look it up in `config.anthropic.configurations`. If found → dispatch to the type-specific branch (Direct / Agent SDK / VS Code LM).
2. Otherwise look it up in `config.localLlm.configurations`. If found → dispatch to the Local LLM branch.
3. Otherwise → error.

### 4.4 `AnthropicHandler.sendMessage` — shared loop with four leaf primitives

The Anthropic handler owns everything **around** the API call for all four leaves: prompt composition (profile system prompt + user-message template + user prompt), `rawTurns` / `compactedSummary` history injection, the tool-approval gate, the agent loop (repeated calls until the model stops producing `tool_use` blocks), raw trail + live trail + built-in-tool persistence, `AnthropicSendResult` shape. **Only the "one API round-trip" primitive differs per leaf.**

The four leaves:

- **Direct** — one `@anthropic-ai/sdk` request per round, inside `sendMessage`'s own loop.
- **Agent SDK** — special case. The SDK runs its OWN loop, so this leaf hands the whole stream off (`runAgentSdkQuery`) rather than participating in the shared loop. It still uses the Anthropic handler's live-trail writer and approval bridge.
- **VS Code LM** — `sendViaVsCodeLm`: one `model.sendRequest` per round.
- **Local LLM** — `sendViaLocalLlm`: one `LocalLlmManager.callLocalLlmOnce` per round (see §4.4a).

Each self-looped leaf takes already-composed messages + tool schemas, calls its API exactly once per round, and yields blocks in Anthropic's content-block shape (`text`, `tool_use`, `thinking`). The loop stitches rounds together, runs the approval gate on any `tool_use` block, dispatches the tool, appends `tool_result` to the next round's messages, and repeats until there are no more `tool_use` blocks.

**VS Code LM branch.** When `configuration.transport === 'vscodeLm'`, each round:

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

**Local LLM branch.** When `configuration` resolves to a Local LLM config, `callLocalLlmOnce` is the HTTP primitive of `LocalLlmManager` — see §4.4a.

All three self-looped leaves (Direct / VS Code LM / Local LLM) share the same tool-approval bridge, live-trail writer, and built-in-tool-persistence hooks. `AnthropicSendResult`'s shape is the same for every caller (queue and chat panel).

### 4.4a Local LLM primitive — `callLocalLlmOnce`

`LocalLlmManager` ([localLlm-handler.ts](../src/handlers/localLlm-handler.ts)) offers one primitive, `callLocalLlmOnce(messages, tools, config)`: one HTTP call to the configuration's endpoint (Ollama `/api/chat` or OpenAI-compatible `/v1/chat/completions`, by `apiStyle`), returning one response. It has no tool loop, approval or template handling.

The Anthropic handler's Local LLM leaf calls `callLocalLlmOnce` directly and participates in the Anthropic handler's shared loop — inheriting Anthropic's approval gate (coerced to `'never'` by the queue dispatcher), the session's trails, live trail, and user-message templates. History compaction on a Local LLM configuration (`compactionModel: "localLlm:<id>"`) calls the same primitive. The Local LLM *configurations* (how they're stored and loaded) are shared by both.

### 4.5 Transport dispatcher

A private method of `PromptQueueManager` — **not** a cross-handler abstraction. Signature (shortened):

```ts
private async dispatchStage(
  expandedText: string,
  resolved: ReturnType<typeof this.resolveStageTransport>,   // profile, configuration, session, iteration key
  stageForAnswer: { answerText?: string } | undefined,       // the item / pre-prompt / follow-up that takes the answer
  skipQuestRefresh = true,
  propagateAnswer = true,
): Promise<{ answerText: string; superseded?: true }>
```

Inside:

```ts
const { profile, configuration } = resolveAnthropicTargets({
  profileId: resolved.anthropicProfileId, configId: resolved.anthropicConfigId,
});
const coercedProfile = { ...profile, toolApprovalMode: 'never' as const };  // §2 decision 7
const result = await AnthropicHandler.instance.sendMessage({
  userText: expandedText, profile: coercedProfile, configuration, tools: ALL_SHARED_TOOLS,
  source: 'queue', sessionKey: resolved.session, iterationKey: resolved.iterationKey, …
});
// result.text is stored as the stage's answerText
```

`resolveAnthropicTargets()` hands the profile's `configId` to the resolver described in §4.3; the caller doesn't need to know which leaf path will run.

### 4.6 `sendItem()` and the stage loop

- Before `dispatchStage()` is called, the stage's text is expanded by `_buildExpandedText()` at [promptQueueManager.ts:1135](../src/managers/promptQueueManager.ts#L1135): the repeat affixes and their placeholders, a todo iteration's record, then the named template if any (`applyTemplateWrapping(expanded, templateName)`). A stored template id `__answer_file__` means no template.
- After `dispatchStage()` returned: `answerText` is stored on the item or stage (with the `prePrompts[i].status = 'sent'` / follow-up `repeatIndex++` machinery), and the loop (`dispatchNextStageForSendingItem`) goes on with the next stage.
- On a failed send: the error path of §4.18 (`_markItemError`) — a retry schedule, or item status `'error'` with the error message.
- The dispatcher **always** coerces `toolApprovalMode = 'never'` (see §2 decision 7) — regardless of whether the leaf path is Direct, Agent SDK, VS Code LM, or Local LLM.

### 4.7 What a stage consists of

A stage is one awaited `sendMessage` call:

| Aspect | Behaviour |
| --- | --- |
| Text | the stage's text in its template (`_buildExpandedText`, [:1135](../src/managers/promptQueueManager.ts#L1135)) — nothing else is put around it |
| Completion | the call returning; its text is the stage's answer |
| Waiting | none beside the call: the turn's own waits (a question, `tomAi_waitFor`, background work, §4.10) happen inside it |
| Failure | the call throwing (§4.18) |

### 4.8 Health check

A 60-second health check (`runHealthCheck`) keeps the queue moving without any answer to wait for: it takes inbox items a watcher event missed (§4.20), puts `waiting` and `retry` items whose time has come back to work, and restarts the drain of a run whose auto-send is on while it has pending items and nothing sending (`computeHealthCheckDecisions` in `queueStep4Utils.ts`).

### 4.9 Trail integration

No queue-side code — the transport owns it.

- **All four leaf paths**: `sendMessage()` writes `ANTHROPIC_SUBSYSTEM` raw + summary trails for every branch (Direct, Agent SDK, VS Code LM, Local LLM). The queue does nothing.

If a trail consumer ever needs to know which leaf path a particular entry came from, the raw trail payload records the configuration (model/type) — no separate subsystem needed.

### 4.9a Response-value propagation — every final answer

Response values (`${chat.KEY}` store updates, custom chat variables, and the
`#TODO=` references that mark `*.todo.yaml` entries) must propagate on **every
final answer** of a queue item — each pre-prompt, the main prompt, every repeat,
and every follow-up — not only the last stage. A repeating or multi-stage item
therefore sets variables per stage/repeat.

The built-in / custom split is a pure, unit-tested util —
[`src/utils/answerResponseValues.ts`](../src/utils/answerResponseValues.ts)
(`normalizeResponseValues`, `splitResponseValues`, `analyzeAnswerText`;
`BUILTIN_CHAT_VARIABLE_KEYS` = `quest`, `role`, `activeProjects`, `todo`,
`todoFile`). Every final answer goes through
`PromptQueueManager.propagateAnswerResponseValues(answer, source)`, which pushes
every value to the `${chat.KEY}` store (via `updateChatResponseValues`) and the
non-built-in subset (with any leading `custom.` stripped) to
`ChatVariablesStore.setCustomBulk(values, source)`, in the answering item's run:

- The send returns the model's answer text inline, so `dispatchStage` calls
  `_propagateDirectAnswer(result.text)` after every `sendMessage`. That parses
  `responseValues` out of the free-form text (`extractResponseValuesFromText`)
  and propagates with `source: 'anthropic'`. `dispatchStage` runs once per
  stage/repeat, so every final answer is analyzed by construction. The
  internal Quest Refresh dispatch passes `propagateAnswer = false`: its
  maintenance answer sets nothing.

### 4.10 Queue editor UI — `queueEditor-handler.ts`

**Run defaults row.** Each run tab of the queue editor has, below its context bar, the row `#runDefaultsBar` with the defaults the run's items take:

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Model            Session            Template                       │
│  <profile>        <session>          <prompt template>              │
└─────────────────────────────────────────────────────────────────────┘
```

Each value is a link that opens a VS Code picker: **Model** the run's default Anthropic profile (`pickQueueDefaultProfile`; *(default profile)* is the profile marked as default; a profile whose direct-API key is missing is marked, §4.17a), **Session** the session new items run in, **Template** the prompt template they take. The selection persists to `queue-settings.yaml` in the run's entry (`default-anthropic-profile-id`, `default-anthropic-config-id`, `default-agent-sdk-session`, `default-message-template-id`, §4.14). An item without a profile of its own takes its session's, else the run's default, at dispatch (`resolveStageTransport`, §4.19).

**Per-item profile — chip and gear-icon QuickPick** (not a collapsible form). Every item that has not finished shows its profile in its header (`renderItemProfile`): a chip naming the item's own profile, or an account icon when it runs with its run's; a click picks among every profile, or "no profile of its own" (`pickItemProfile` → `setItemProfile`; a profile that cannot continue the item's session is offered with the queue's default session instead). Each *staged* queue item's header also carries a gear icon (`codicon-settings`). Clicking it opens a VS Code QuickPick flow: profile (or *Inherit (queue default)*) → configuration → session. The configuration picker lists *(profile default)* and the merged Anthropic + Local LLM entries with backing-type labels (`[direct]`, `[agentSdk]`, `[vscodeLm]`, `[localLlm]`, see §4.3). Picking "Inherit" clears the item's profile and configuration, so it falls through to the run's default.

**Adopt-queue-default button — one-click sync** (`codicon-arrow-circle-down`). Alongside the gear, every queue item header carries a *Set the profile to the default of its run* icon that copies the run's default Anthropic profile and configuration straight onto the item. Unlike the staged-only gear, it is shown in **every status** and is applied without the `isEditableStatus` guard (`PromptQueueManager.applyQueueDefaultsToItem`, wired to the `applyQueueDefaultTransport` webview message). It touches only the profile and configuration — status, repetition counters, template and text are left intact — so for a currently repeating (`sending`) item the in-flight dispatch is untouched and the **next repetition** resolves the freshly-adopted profile via `resolveStageTransport`. The item→patch logic is the pure, unit-tested `applyQueueDefaultTransportToItem` (`queueStep3Utils.ts`). The toolbar's *Apply the run's defaults to all items* does the same for every staged and pending item of the run, for a chosen set of profile, template, session and role.

**Per-stage override** (pre-prompts and follow-ups): each pre-prompt row and each follow-up row (when the item is editable) gets its own gear icon → the profile → configuration QuickPick, routed to `updatePrePrompt` / `updateFollowUpPrompt`. The inherit option on a stage-level picker is labelled "Inherit from item". Levels of resolution for the profile: stage > item > session > run default.

**Add form.** The Add form has a **Profile** select (`#addProfile`; *(default profile)*: the default profile of the item's run) beside the prompt template, the queue repeats and the repeat prefix / suffix.

**Auto-approve warning**: the Add form shows, directly beside the Profile select:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored.

No checkbox to disable it. See §2 decision 7.

**An item waiting for the user**: while a prompt of a sending item waits for the user — a question (`tomAi_askUser`, the picker, the MD Browser ask, the Agent SDK's `AskUserQuestion`) or a tool approval — the item has its own colour (`waiting-for-user`) and the badge *waiting for your reply* / *waiting for your approval*. The waits are attributed to the item through an `AsyncLocalStorage` context around its dispatch (`services/userWaits.ts`), so a question from a chat send marks no queue item.

**An item waiting on something outside its turn** (`tomAi_waitFor`, `src/tools/wait-for-tool.ts`; rules in `src/utils/waitFor.ts`, the open waits in `src/services/waitForRegistry.ts`): the tool blocks until `until` / `minutes` (at most 48 h); the wait belongs to the queue item whose dispatch it runs in (`currentQueueItemId`). The manager listens to the registry and keeps the state on the item (`waitingFor`: reason, details, since, until; YAML `waiting-for`, cleared when the wait ends and by crash recovery); `waitForOf(id)` reads it, `tomAi_listQueue` reports it as `waitingFor`, the window summary as `sending.waitingFor`. The editor shows it (`waitForViewOf` → `renderWaitFor`, the time left kept current by `tickWaitForLines`; the run tab's title names it). **Interrupt the wait and move on** (`interruptWaitFor(id)`, the line's button and Continue's choice beside **Keep waiting**) ends the wait with outcome `interrupted`: the tool tells the agent to end its turn with a note of what is still to do; when that turn ends, `dispatchStage` does not go on with the next stage — `_stepBackAfterWaitInterrupt` puts the item behind the next pending item of its lane (`yieldTarget` / `orderForYield`; `staged` when none follows), counters, run id and answers kept, with `resumeAfterWait` (meta `resume-after-wait`), and the lane goes on. When the item runs again, `sendItem` sends its last stage again through `resendLastPrompt(id, undefined, { note: WAIT_RESUME_NOTE })`. Stop, Resend, Skip and interrupt-for-continuation cancel the wait with the dispatch (`_cancelActiveDispatch` → `cancelForQueueItem`, outcome `cancelled`); a send that ends cancels the waits it left open (`registerAskCancel`, so a chat send's wait ends with it).

**An item waiting for its background work**: a turn waits for the background work it started before its answer counts — the Agent SDK's background tasks (alive while the CLI lists them), the direct API's and Local LLM's `tomAi_runCommandStream` handles (alive while their process group exists; the turn then goes on with a message naming each command and its exit code). The limit is the item's `backgroundWaitLimitMinutes`, else the profile's, else 360 minutes; at the limit the answer ends with a hint naming what still ran and the queue goes on. `dispatchStage` passes the item's limit and `onBackgroundWait`, which keeps the state on the item (`backgroundWait`: since, limit, tasks / commands; YAML `background-wait`, cleared when the wait ends and by crash recovery); `backgroundWaitOf(id)` reads it. An Agent SDK queue run refuses detaching Bash commands and offers no `tomAi_runCommandStream` / `Monitor` (llm_configuration.md § 6, *Background work of a queue turn*). **The user's choices**: the transport hands the queue the wait's controls (`onBackgroundWaitControl`: `waitWithoutLimit`, `keepWaiting` — the limit again from now — and `stop`), kept per sending item; `waitWithoutLimit(id)`, `keepWaitingForBackground(id)` and `stopBackgroundWait(id)` reach them while the item waits. The queue editor shows the wait (`backgroundWaitViewOf`: the line `2 tasks, 1 h 20 min of 6 h`, the ? list of tasks with command and output file / handle, the three buttons → `backgroundWaitAction`), which goes through `applyBackgroundWaitAction`; the @CHAT panel does not show it. Continue offers the three, then Resend and Skip. Stop waiting ends the turn with the hint (reason `stopped`); a turn that ended with work still running returns `backgroundLeft`, which flags its repetition answer and the item's answer (`backgroundLeft`, `answerBackgroundLeft`; YAML `background-left`, `answer-background-left`): the chip and the answer show red. **The background-work reminder** (vscimpb143): before the queue waits silently, the agent gets one prompt in the same session and turn — the Assist prompt `backgroundWork` (utils/assistPrompts.ts, utils/backgroundWorkReminder.ts; `${backgroundWork}`, `${waitingSince}`, `${limitMinutes}`; an empty template sends none). The Agent SDK transport pushes it into the query's input channel on the channel's `waiting` event (`backgroundReminder`, passed by the handler for queue sends), so the CLI runs a turn for it while the wait goes on; the direct API and Local LLM (`awaitBackgroundCommands`) continue the tool loop with it before `waitForOwnedCommands` (`reminderForRunningCommands`), so the agent polls its command streams itself. Once per wait: the work it named is remembered per send (`takeReminderFor`); a later wait for new work gets it again.

**A message to the item's waiting turn** (`messageWaitingItem(id, text)`, `canMessageWaitingItem(id)`; the records in `src/utils/itemWaitMessages.ts`): both wait panels carry a **Message** box (`renderWaitMessageBox` in `media/shared/queueEntryRenderFunctions.js`: a text area with Send and Cancel in the item; the editor posts `messageWaitingItem {id, text}`), and Continue offers **Message…**. The manager sends the text to the item's own turn — no session is picked, nothing is queued:

- the turn waits in `tomAi_waitFor`: `WaitForRegistry.message(id, text)` ends the open wait with the outcome `message`; the tool answers `{ok, outcome: "message", message, waited, until, remaining, instruction}` and the agent calls it again with the same `until`. The item's state `waitingFor` is cleared for that moment and set again by the new call; the item does not step back.
- the turn waits for its background work: the transport's `BackgroundWaitControl.message(text)` takes it. The Agent SDK pushes it into the running query (`QueryInputChannel.push`, the channel keeps waiting) and answers with the promise of the agent's answer; the direct API and Local LLM end `waitForOwnedCommands` with `{kind: 'message'}`, the tool loop goes on with the text as its next user message, and when that round ends the wait begins again for the same work (the background-work reminder is not sent a second time). The text the turn gets is `backgroundWaitMessageText`: the message, headed by a note that the work still runs and the wait is not over. A control without `message` (a transport with no turn to write to) refuses: the box is not offered.

The item keeps each message (`waitMessages`, YAML `wait-messages`, the last 20): when it was sent, into which wait, the text, the agent's answer where the transport reports it, and `resumed` once the wait goes on — the next `tomAi_waitFor` begin, the background wait showing again, or the Agent SDK's answer arriving while the wait still shows. The editor lists them under the wait panel (`waitMessagesView`), or on their own while the turn answers and no wait panel shows. Every message is appended to the quest's Q&A journal and emitted to NOTIFICATIONS as type `message` (who: the user).

**The item's ask panel** (`src/services/queueItemAsks.ts`, `renderItemAsks`): a sending item carries `askViews` — its open interactions (`userInteractions.forQueueItem`: questions, pickers shown in the user-input panel, MD Browser asks, approvals, plan proposals) and the QuickPicks on screen for it (`src/services/livePickers.ts`, registered by the live prompter while a QuickPick shows). The panel renders a question's choices from the same `layout` the user-input panel uses, a picker's items, an MD Browser ask's buttons. It posts `answerItemAsk {id, askId, response}`; `answerItemAsk` hands `response` to the interaction's own `respond` — a question's `submit` / `answers` / `choice`, a picker's `picker` message, an MD Browser ask's `{type: 'mdButton', buttonId}` (the slot's `click`) or `reveal` — or to the live picker's `answer`. So an answer from the item takes the path of an answer from the user-input panel, the QuickPick or the MD Browser bar, and the ask is settled once, for every surface. An ask of another item, or one already closed, is refused. Continue's **Type an answer…** submits a question's text the same way.

**A walk iteration whose todo is not completed** (`utils/walkCompletionCheck.ts`, `_continueUnfinishedIteration`): after the main prompt of a `<prefix>*` iteration answered, the queue reads the walked todo. Completed (or `waiting-for-repeat`, `cancelled`, gone): the walk goes on. Not completed, and nothing says why — the todo is not `blocked` or `decision-needed`, has no open decision (a `decisions` entry without its `decision`), and no question of the item waits — the queue sends the continuation *"The todo <id> is not completed. If you started something, wait for it actively and finish the todo; if it cannot be finished, say why and set its status."* with the main prompt's transport, session and iteration key, so it goes into the same conversation. At most N continuations: the item's `walkContinuations` (queue tools), else the queue setting `walk-continuations` (`queue-settings.yaml`), default 2. Still not completed after them: the item stops as **needs attention** — `needsAttention` (YAML `needs-attention`) carries the reason, auto-send goes off, and the item is held before the next todo (auto-send on goes on with it and clears the reason). The iteration's answer is its last turn's: the repetition answer, `answerText` (`${answer}`) and the todo's `last_answer` take it; the repetition answer records `continuations` and the `earlier` answers (YAML), which the editor shows as the chip's mark (`1 continuation`) and folded under the final answer (*ended before its work was done*). The continuation prompt is no answer; the trails keep every turn.

**A question the item waits in** (`tomAi_askUser`): the registry records the asking item on the pending ask (`PendingAsk.queueItemId`, from the same context), so `pendingQuestionOf(id)` answers when it was asked; the editor's badge says *waiting for your answer since …* with an **Open question** button (`openPendingQuestion` → command `tomAi.showUserInteraction {itemId}`, which opens the user-input panel on the item's run tab, or brings the item's MD Browser to the front; the status-bar item *Waiting for you* runs `tomAi.showPendingQuestion`). **One open interaction per run (vscimpb81):** every wait records the run of its turn (`runAsQueueItem(id, fn, run)`, `currentInteractionRun()` in `services/userWaits.ts`: the item's run, else the process position, else `default`); a chat send runs as its chat item and run (`trackChatSend`), so its waits show on its entry too (`waitingForUser` for status `chat`). The open interactions — questions, approvals, plan proposals, pickers, MD Browser asks — are kept in `services/userInteractions.ts` and shown by `handlers/userInteractionPanel.ts`, one tab per run; the ask registry and the MD Browser slot allow one open ask per run, plan mode is per run, a picker of another run than the one on screen goes to the panel, and a Stop denies only the stopped turn's approvals (`abortPendingApprovals(match)`). The registry fires a change event on open and resolve (`AskUserRegistry.onDidChange`), which the manager forwards to its own. **Continue asks first** (`continueWithChoice` in the queue editor handler, options from `utils/pendingQuestion.ts`): *Answer now* only while the item waits in a question, *Resend this stage* whenever a stage was dispatched, *Skip* always; Cancel does nothing. **Resend of a running stage** (`resendSendingStage`, also the ↻ on a sending row): the item's frame is taken over, its turn cancelled, its question closed, and `resendLastPrompt(id, undefined, { interruptRunning: true })` sends the same stage again, prefixed with `RESEND_INTERRUPTED_NOTE` (not recorded as the stage's text); the counters stay. Skip (`continueSending`), Resend and Stop close the item's question with a note the turn receives (`AskUserRegistry.cancelForQueueItem`: `QUESTION_CLOSED_BY_SKIP` / `_RESEND` / `_STOP`), so it is journalled as closed by the user, not lost. The question panel's messages go to the debug log (`instrumentWebviewMessages`, source `tomAiAskUser`), so a submitted answer can be told from none afterwards. A question has no deadline unless the agent sets one.

**Answers of every repetition**: a repeated item keeps each repetition's main-prompt answer (`repetitionAnswers`, entry-file key `repetition-answers`, at most 200, `utils/repetitionAnswers.ts`), keyed by the walked todo's id (a `<prefix>*` walk) or the repetition number. The Answer block shows a chip per repetition, the latest active; a click shows that answer. A resent repetition replaces its entry.

**Display of responses**: when `item.answerText` exists, show it inline under the item (truncated preview + expand-to-full button, and two buttons that show it rendered as Markdown over the queue or in the markdown preview editor). The authoritative trail is the Anthropic trail file, but seeing the text in the queue itself is the practical way to inspect what happened.

### 4.11 ANTHROPIC/LLM panel — queueing buttons

The ANTHROPIC/LLM section's toolbar ([media/chatPanel/main.js](../media/chatPanel/main.js), `getPromptEditorComponent`) carries four queue buttons and, in the status bar below the input, the button that opens the queue editor:

| `data-action` | Button | What is queued |
| --- | --- | --- |
| `addToQueue` | Save to Queue | in the default run, with the prompt queue's profile, session (`default@default`) and default template; nothing of the panel is pinned |
| `addToQueueNext` | Queue next | the same, pending at the front of the default run's queue (§4.18, *Queue next*) |
| `addToQueuePanelTarget` | Save to Queue with the panel's target | in the panel's run, with `anthropicProfileId` (unless the panel's profile is *Run default*), the panel's `template`, and `session`: the panel's session, so the queued prompt continues the panel's conversation; the panel's role and guideline choices go with it |
| `addToQueueNextPanelTarget` | Queue next with the panel's target | the same, sent next in the panel's run |
| `openQueueEditor` | Open Prompt Queue | — |

All four go through the webview's `addAnthropicToQueue(usePanelTarget, next)`, which posts `addToQueue` with the text, the template, the repeat count and `transport: 'anthropic'`; the backend's router (`case 'addToQueue'` at [chatPanel-handler.ts:597](../src/handlers/chatPanel-handler.ts#L597)) hands it to `_handleAddToQueue` ([:1884](../src/handlers/chatPanel-handler.ts#L1884)), which calls `PromptQueueManager.enqueue()` or, for Queue next, `enqueueNext()`. Save to Queue adds the prompt staged or pending by the subpanel's queue mode toggle; Queue next is always pending. Every item queued here is marked `fromChatPanel`, which the queue editor's *From the chat panel only* filter reads.

`openQueueEditor` (`case 'openQueueEditor'` at [:621](../src/handlers/chatPanel-handler.ts#L621)) opens the queue editor.

### 4.12 ANTHROPIC/LLM panel — Available models (informational)

The ANTHROPIC/LLM panel's **Available models** button (`showAvailableModels`) opens an overlay listing what the Anthropic API offers, with its count, or why the list is empty — **purely for informational purposes**.

**Sends don't touch this list.** The model used on send is the one stored on the active configuration — for a `vscodeLm` configuration the `modelId` of its triple (§4.2). It's a browser, not a control. (If the user wants to change the target model, they edit the configuration.)

Everything else on the ANTHROPIC/LLM panel — system prompt composition, user-message template picker, live trail viewer, trail directory — is the same for every leaf path.

### 4.13 Tool surface — `prompt-queue-tools.ts`

The queue add/update tools ([prompt-queue-tools.ts](../src/tools/prompt-queue-tools.ts)) take the target fields:

| Tool | Purpose |
| --- | --- |
| `tomAi_addQueueItem` | stage a main prompt |
| `tomAi_updateQueueItem` | patch fields of an existing item |
| `tomAi_addQueuePrePrompt` | add a pre-prompt stage |
| `tomAi_updateQueuePrePrompt` | patch a pre-prompt |
| `tomAi_addQueueFollowUp` | add a follow-up stage |
| `tomAi_updateQueueFollowUp` | patch a follow-up |

Target fields:

```ts
transport?: 'anthropic';        // the one transport; may be left out
anthropicProfileId?: string;
anthropicConfigId?: string;
```

Tools that report queue state (`tomAi_listQueue`, `tomAi_setQueueItemStatus`, `tomAi_sendQueuedPrompt`) surface the fields in output; a snapshot always says `transport: 'anthropic'`.

Removers (`tomAi_removeQueueItem`, `tomAi_removeQueuePrePrompt`, `tomAi_removeQueueFollowUp`) take none of them.

### 4.14 Persistence / compatibility

Queue state is persisted as one entry file per item in the queue folder (`_ai/queue/<host>_<workspace>_<time>-<id>_<quest>.<type>.entry.queue.yaml`, `src/storage/queueFileStorage.ts`), queue-level settings in `queue-settings.yaml` beside them.

**Only what changed is written.** `PromptQueueManager._persistToFiles` keeps, per item, the fingerprint its file was last written from — the quest, the item's place in the queue and the item as JSON, all that `_queuedPromptToDoc` builds the file from — and serialises and writes only the items whose fingerprint changed (a dispatch changes one item; removing or moving one changes the places after it); removed items' files are deleted. Before, every persist serialised every item with the yaml package on the extension host's thread (with 50 items of real prompts and answers, 274 KB: a median 112 ms and up to 400 ms per persist, 50 files written; now a median 4.5 ms, one file). The sent-history trim on disk (`trimSentEntries`, which reads and parses every entry file) runs only when the folder holds entry files of this host and workspace that the queue does not own (`countEntryFiles()` above the files it wrote): its own sent items are trimmed in memory already (`trimSentHistory`, 50). Tests: `queuePersistChanged.queue.test.ts` QP-1 – QP-3.

The target fields are optional. An item stored without `transport` runs on Anthropic like one that names it, and a stored `transport: copilot` is read as `anthropic` (`readStoredTransport`).

**YAML layout**: the per-item queue YAML format under `queueFileStorage.ts` uses dash-case keys on `QueuePromptYaml`. The target fields on the main item and on each pre-prompt / follow-up, and the item's todo pattern, are:

```yaml
transport: anthropic                    # the one transport; may be absent
anthropic-profile-id: software-engineer # string (profile id)
anthropic-config-id: claude-sonnet-46   # string — anthropic OR localLlm config id
answer-text: "…returned response…"      # the response captured by the dispatcher
todo-id-pattern: chat*                  # the todos it runs: a todo id, <prefix>* (a walk), several comma-separated;
                                        # the todo panel marks them queued (utils/todoQueueMarks.ts)
```

**Queue settings per run** persist to `queue-settings.yaml` via `QueueSettings` (`utils/runQueueSettings.ts`): each process run has its own auto-send, Auto-Start / -Pause / -Continue, walk continuations, defaults (profile, configuration, session, prompt template, role), per quest under `runs-by-quest.<quest>.<run>` (vscimpb168; a quest without an entry reads the older shared `runs:`, and its first write starts its entry from them). The file is shared by every window of every quest, so a window writes only the runs it changed (`_putRunSettings` / `_dropRunSettings` mark them; `persistSettings` merges them into the file read fresh through `questRunsInFile`): a run's auto-send held from its Auto-Start at activation stays in that window's memory and never switches another window's run off. An item from another quest (the inbox) without a run is queued in `default` with `runIsExplicit`, never in the window's current run or an inherited process position. The keys of a run entry:

```yaml
runs:
  default:
    auto-send-enabled: true
    default-transport: anthropic
    default-anthropic-profile-id: software-engineer
  collab:
    auto-send-enabled: false
    default-agent-sdk-session: idea
```

`default-transport` is written with every entry and always says `anthropic`. All keys are additive-optional; each `runs:` entry is written complete (an unset optional value as `""`), so a run with settings of its own never takes a top-level value. The top-level keys — the same keys, one set for the whole queue, the file's old shape — are the start values: what a run without settings of its own has (and the `default` run, when it has no entry). A missing key takes the start value, else the built-in default. The top-level keys are written only by **Make default** in the queue editor (a pin button in a tab's toolbar): `setDefaultQueueSettings(run)` copies the tab's run's shown settings (`DEFAULT_SETTING_FIELDS`: auto-send, Auto-Start / -Pause / -Continue, default profile / configuration / session / role / prompt template; not the walk continuations) to the top level, keeping `runs:` and every other key; runs with settings of their own keep them, runs without them and runs created later take the new values. The button is disabled while the tab's settings equal the start values (`defaultQueueSettingsDiff(run)`; the editor's state carries `startQueueSettings`). The queue always runs one lane per run (`utils/queueLanes.ts`): a run whose auto-send is off is a held lane. The manager's queue-wide accessors (`autoSendEnabled`, `defaultAnthropicProfileId`, `defaultAgentSdkSession`, ...) read and set the window's run; `runQueueSettings(run)` / `setRunQueueSettings(run, patch)` / `setRunAutoSend(run, on)` take a run. Every place that used to switch the queue-wide auto-send off (an error, interrupt for continuation, needs attention, a decision hold, out of credit, Auto-Pause, *pause after this*, deleting the sending item) switches off the run of the item (`_pauseRunOf`).

### 4.15 Profile pickers

The queue editor has no transport choice; what is picked is the Anthropic profile (and, in the gear's flow, its configuration):

| Place | Options | Has inherit/default option? |
| --- | --- | --- |
| Run defaults row, **Model** | every profile | yes, *(default profile)* |
| Add form, **Profile** | every profile | yes, *(default profile)* |
| Item header, profile chip | every profile | yes, no profile of its own |
| Item gear (staged) | profile → configuration → session | yes, **Inherit (queue default)** |
| Pre-prompt / follow-up gear | profile → configuration | yes, **Inherit from item** |

The configuration step lists *(profile default)*, the Anthropic configurations and the Local LLM configurations, labelled per §4.3. All of them are VS Code `QuickPick` flows except the Add form's select, which keeps the item row compact (see §4.10). The gear posts `editItemTransport` / `editPrePromptTransport` / `editFollowUpTransport`; the host writes `{ transport: 'anthropic', anthropicProfileId, anthropicConfigId }` (or clears all three for "Inherit") through `updateItemTransport` / `updatePrePrompt` / `updateFollowUpPrompt`.

### 4.16 Prompt template editor — the one template store

| Store | Config key | Shape |
| --- | --- | --- |
| Templates | `config.anthropic.userMessageTemplates` | array `[{ id, name, description?, template, isDefault? }]` |

Every send reads the one store: every Anthropic profile regardless of its configuration's leaf type (VS Code LM and Local-LLM-backed configurations included). The lookup helpers are in `src/utils/userMessageTemplateLookup.ts`.

**Template editor:**

1. The Global Template Editor's **Category** dropdown has `Anthropic — User Message` for the one store.
2. The four template tools (`tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate`, in `src/tools/prompt-template-tools.ts`) work on the one store, keyed by `id` (`name`, `description`, `template`, `isDefault`); they take no transport.

**Queue editor — template dropdown:**

- The template dropdowns in the queue editor (Add form's new-item template picker, per-item template select in the expanded row, per-stage template select on pre-prompts + follow-ups) list the one store.

**Quest TODO panel — send button:**

- The Quest TODO panel's send button (`qt-btn-send-chat`, *Send to chat*) routes the todo through the Anthropic handler via `runAnthropicSend(context, prompt, { userMessageTemplate })`. Its template dropdown lists the one template store
  (`config.anthropic.userMessageTemplates`).
- The pure decision — which templates to offer and which is pre-selected — lives in `src/utils/todoSendTargets.ts` (`buildTodoSendTemplateChoices`),
  unit-tested without the panel.
- The options: **Run default** first and pre-selected (the item gets no template of its own and takes its run's default template,
  `defaultMessageTemplateId` of the run's queue settings, when it is sent; its label names that template), then (None), then the store's templates,
  among them the seeded **Execute TODO** template (see below).

**What a todo send carries:** every send of a todo from the panel (Send,
Add to queue, the stack) puts the todo's reference and its whole stored record
into the prompt (`todoSendBlock` in `todoSendTargets.ts` around
`todoYamlBlock` of `todoIterationRecord.ts`, the block a todo iteration
appends), so Execute TODO, Guide me and Explain TODO read the same todo a walk
does. The record's placeholders are escaped; the queue and the Anthropic send
unescape them as the text leaves.

**Seeded "Execute TODO" Anthropic user-message template:**

- `ensureExecuteTodoUserMessageTemplate` (in `sendToChatConfig.ts`, seeded at
  activation alongside the Default Retry template) adds an `execute-todo`
  entry to `config.anthropic.userMessageTemplates`: execution instructions around
  the `${userMessage}` placeholder.
  It is a pickable option only — **not** forced as the default user-message
  template — and the seed is idempotent.

**Seeded "Explain TODO" Anthropic user-message template:**

- `ensureExplainTodoUserMessageTemplate` seeds `explain-todo` the same way
  (body in `src/utils/explainTodoTemplate.ts`). A todo sent with it is
  explained, not done: what it changes, why, its open decisions with their
  options and a recommendation. The open points are asked through
  `tomAi_askUser`, and the todo is changed from the answers with
  `tomAi_updateQuestTodo` (decisions, description, a dated note; `not-started`
  once every decision is answered). It took the place of the
  "Explain-then-ask scaffold" (`explain-and-ask`); `npm run migrate:ai-formats`
  renames that id in the workspace config and the user overlay (format
  version 4).

### 4.17 Shared resolver: `resolveAnthropicTargets`

`src/utils/resolveAnthropicTargets.ts` is the single source of truth for `(profileId, configId) → (profile, AnthropicConfiguration)` resolution. Used by:

- The queue's `dispatchStage` helper — before calling `AnthropicHandler.sendMessage` (queue-side).
- The chat panel's `_handleSendAnthropic` — before calling the same handler entry (interactive-send side).

Both call sites share the fallback chain, the Local-LLM-backed profile case included, and the same error messages (see §5 failure modes). The helper returns a discriminated union `{ profile, configuration } | { error: string }` so callers can surface a clear message without catching thrown errors across the module boundary.

Its first two steps — which profile (by id, else the default, else the first) and which configuration (an explicit, non-blank id, else the profile's) — live in `src/utils/anthropicApiKeyCheck.ts` (`pickAnthropicProfile`, `effectiveConfigurationId`), because the missing-key check below has to pick the same target.

#### 4.17a A missing API key is said before anything is sent

The direct transport reads its key only from `process.env[anthropic.apiKeyEnvVar]` (default `ANTHROPIC_API_KEY`) of the extension host. When that variable is unset every send fails ("Anthropic client not available", `ANTHROPIC_CLIENT_UNAVAILABLE`). `missingDirectApiKey(section, {profileId, configId}, env)` answers the question up front: the target resolves to an Anthropic configuration whose `transport` is `direct` (or absent) and the variable is unset. Agent SDK, VS Code LM and Local-LLM-backed targets never need it.

- `PromptQueueManager.missingApiKeyWarnings(itemId)` runs it for every stage of an item (main prompt, each pre-prompt, each follow-up, each resolved like `dispatchStage` resolves it) and answers one line per cause naming the stages it affects.
- The queue tools that queue, change or send an item (`tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_addQueuePrePrompt`, `tomAi_updateQueuePrePrompt`, `tomAi_addQueueFollowUp`, `tomAi_updateQueueFollowUp`, `tomAi_sendQueuedPrompt`) answer those lines as `warning`. The item is kept: the caller decides.
- The queue editor shows each line as a **No API key** chip at the top of the item, right under its header (the interruption chip of a send that did not complete sits beside it), with the yellow `warned` border.
- The profile pickers — the ANTHROPIC/LLM subpanel's and the queue editor's (§4.15) — label such a profile `(no API key)` (`profileKeyStates`).
- **The stage is not sent.** `dispatchStage` runs the same check (`stageKeyRefusal`) for the stage it is about to send, before its session is made or anything leaves, and throws the transport's own no-key failure with the cause. The error path then treats it as a failed send — **not retried** (see *Backoff retry* in §4.18): `_markItemError` recognises the failure (`isMissingApiKeyFailure`) and sends the item to `error` at once, its `error` naming the stages and the fix (`missingApiKeyFailureText`); the user is told (`notifyUserLive`: Telegram when configured, else a VS Code message), the same text at most once in ten minutes. Auto-send stays on, so items on other profiles keep running.
- **Process items do not count.** An item with `processItem: true` (meta `process-item`, vscimpb97) — the prompt Proceed queues for a position, its process-move marker, and what a step's agent queues with `tomAi_addQueueItem {processItem: true}` (the system prompt of a Proceed run asks for it) — is a process step's own work: its main stage neither counts toward the Quest Refresh interval nor runs a refresh that is due (`runMainStageWithRefresh` with `counts: false`); the refresh waits for the next stage that counts. The queue editor marks it `[process item]`.
- **A due Quest Refresh waits.** The main stage's refresh pre-step (`runMainStageWithRefresh`) asks the same check first (`stageRefused`): a stage that would be refused runs no refresh and does not count toward the interval, so the refresh is neither refused on the same profile nor spent — it stays due for the next stage that can be sent.
- **One read.** The check, the warnings, the pickers' marks, the dispatch and the direct send itself (`AnthropicHandler.getClient`) all take the variable's name from the config file as it is now (`loadSendToChatConfig()`), so a hand edit of `anthropic.apiKeyEnvVar` changes all of them at once, without a reload. `TomAiConfiguration`, which serves every other section, follows the file the same way: each read compares the file's stat with the one its copy was built from and parses it again when it changed (`src/utils/tomAiConfiguration.ts`).

The message names the fix: the key has to be in the environment VS Code was **launched** with; "Developer: Reload Window" restarts the extension host from the same main process and does not refresh it, so VS Code must be quit and started again.

#### 4.17b Out of budget: the credit balance is too low

When the direct API's credit is used up it refuses every request with a 400 `invalid_request_error` — "Your credit balance is too low to access the Anthropic API" — until credit is bought. A retry cannot help, and the rule for other unretryable 400s (§4.18) would end an unattended walk there. So `_markItemError` recognises this failure first (`isOutOfBudgetFailure`, `src/utils/outOfBudget.ts`) and records on the item where it stopped: `outOfBudget = {profileId, profileName, model, session, message, at, suggestedProfileId}`.

- **The profile decides first.** A profile may name the profile to continue on and whether to switch by itself: `outOfBudget: {fallbackProfileId, autoSwitch}` (profile editor: *Out of Budget: Continue On*, *Out of Budget: Switch Automatically*). With `autoSwitch` and a fallback that is another existing profile, the queue continues there at once and auto-send stays on, so the prompt is not interrupted. An item switches by itself once; a fallback that runs out too stops the item, so two profiles naming each other cannot pass it back and forth.
- **Otherwise the item stops and asks.** It goes to `error`, auto-send is switched off, and the user is told (`notifyUserLive`). The queue editor shows an **Out of budget** panel first in the item's body: the profile and session that stopped, a picker of the other profiles (preset to the profile's fallback when it names one), **Continue on profile** and **Resend**.
- **Continue on profile** (`continueOnProfile`, also what the automatic switch calls) sends the stopped stage on the picked profile as the out-of-budget prompt (`outOfBudgetPrompt`: the Assist prompt chosen for *Out of budget* on the Status Page, `assistPrompts` in `src/utils/assistPrompts.ts`, filled by `outOfBudgetValues`; its default template is the text described here): which profile and model stopped, in which session and when, the API's message, the path of that session's live trail, the note that uncommitted changes are in the working trees and that the work is to be continued rather than started over, then the original prompt. It runs in the item's session unless that session keeps its conversation where the picked profile cannot continue it (`sessionTransportMismatch`); then in `default`, and the prompt says so. Every later stage of the item that would run on the profile that ran out runs on the picked one (`budgetFallback`, applied by `resolveStageTransport` through `applyBudgetFallback`).
- **Resend** sends the very last request again as it was (`resendLastPrompt`, §4.18) — for when credit has been bought.
- **For an agent** (and a Telegram prompt, which reaches one): `tomAi_resendQueueItem` answers with the item's `outOfBudget` mark; with `profileId` it calls `continueOnProfile`, without it `resendLastPrompt`. `tomAi_listQueue` shows `outOfBudget` and `budgetFallback` per item.

Either button clears the panel. The repetition counters are not touched: the stopped stage is sent again, not the next one.

### 4.18 Pause / resume and error handling

The queue is a long-running, possibly multi-repetition drain, so it needs
well-defined semantics for two interruptions: the user pausing mid-flight, and
a dispatch failing. Both are designed around a single invariant — **never lose
the in-flight cursor**. The repetition counters (`repeatIndex` per stage,
`followUpIndex`) are persisted, so a pause, an error, or even a window crash
resumes from exactly the rep that was interrupted rather than restarting the
item or silently skipping a rep.

#### Pause finishes the current rep, then holds

Turning auto-send off does **not** abort the rep that is already in flight.
`dispatchNextStageForSendingItem` returns a two-valued
`DispatchOutcome = 'done' | 'paused'`. In each stage, just
before a further prompt would go out (a pre-prompt, a main-prompt repetition or
`prefix*` todo, a follow-up), the pause gate `_pauseBeforeNextDispatch` checks
whether `_autoSendEnabled === false` **and** the item already has dispatch
progress (`itemHasInFlightProgress(item)` — see below, rule in
`src/utils/queueSendNow.ts`); if so the call returns `'paused'` instead of
sending it. The in-flight rep finishes naturally; the item **stays in
`'sending'`** with its counters intact. An item with nothing left to send never
reaches the gate: it returns `'done'` and becomes `'sent'`, auto-send on or off.
Every caller (`sendItem`, `_resumePausedSendingItem`,
`advanceSendingItemWithoutAnswer`, `resendLastPrompt`) propagates the outcome
instead of treating "not done" as "mark sent".

> The very first dispatch of an item is allowed even with auto-send off, so an
> explicit `sendNow` / "Send" action is never blocked: the item sends its first
> prompt and, if it has more, holds before the second. **Send Now also works on
> a `sent` item**: `resetItemRunState` puts it back to its first prompt and the
> whole item runs once more (every repetition or `prefix*` todo, every
> follow-up); a repeat run does not queue the item's next template iteration a
> second time.

The queue editor reflects this: `queueEntryComponent.ts` renders the status
label as **`SENDING <KIND> (PAUSED)`** (e.g. `SENDING TODO (PAUSED)`; status and kind in one label, `queueStatusKindLabel`, vscimpb128) when `status === 'sending'` and the page-level
`autoSend === false` (guarded with `typeof autoSend !== 'undefined'` so the
shared component still works in the template editor, where the global isn't
defined).

#### Resume continues from the persisted cursor

Re-enabling auto-send (`set autoSendEnabled(true)`) first looks for a paused
`'sending'` item that has progress and re-enters the dispatch loop via
`_resumePausedSendingItem`; only if there is no such item does it fall through
to `sendNext`. `sendItem` carries a **fresh-vs-resume gate**: items with prior
progress (paused mid-flight, error-reset, or recovered after a crash) keep
their counters, while truly-fresh items get the full reset. State persistence
was already in place — `repeatIndex` lives in the per-item / per-stage
`queue-entry` YAML and `auto-send-enabled` in `queue-settings.yaml` — so a
window reload that recovers a `'sending'` item back to `'pending'` preserves
the counters and the next drain picks up where the pause left off.

An item whose turn waited in an ask tool when the window went down is the
exception (vscimpb166, `services/openAskRecord.ts`): its open call
(`open-ask`: the tool, its input, the window that showed it) is recorded while
the ask is open, so crash recovery keeps the item `sending`, the window that
takes it over (its own, or any once the asking window is gone; never a live
other window's) runs the same tool again for the item, and the answer goes out
through `resendLastPrompt` with `continuation`: the continuation prompt
(`openAskContinuationPrompt`) in the item's session, resuming the interrupted
turn's conversation (`turnSessionId`), the stage's own text kept. A Resend,
Skip or Stop bumps the item's epoch: the restored ask is closed and its answer
not sent. A chat item (a send of the @CHAT panel, status `chat`) with an open
ask is kept from being settled as abandoned and restored the same way; its
answer goes out as a new chat send in the item's session and run (the chat
send path `runAnthropicSend`, registered with `setOpenAskChatSender`), and the
item ends with `RELOADED_CHAT_SEND_NOTE`. While the window shuts down, an ask
the shutdown closes keeps its record and its turn is held, so it does not
finish the item before the window is gone.

#### Error → auto-send off (anti-cascade brake)

When any stage dispatch throws, all four catch sites funnel through the private
`_markItemError`, which delegates to the pure helper
`applyErrorTransition` in [`src/utils/queueErrorTransitions.ts`](../src/utils/queueErrorTransitions.ts):

- The item **stays at its current position** (top of the in-progress queue)
  with `status: 'error'`; the `error` string and an optional classified
  `warning` (`rate_limit` / `quota_exceeded` / `overloaded` / `cancelled` /
  `interrupted`, read from the thrown error) are stamped on it.
- **Auto-send is flipped off unconditionally.** A rate-limit / quota / overload
  failure almost always recurs for every following pending item, so draining
  into them just burns quota. The user reviews the failure and explicitly opts
  back in. `applyErrorTransition` is idempotent — a second call on an
  already-errored item refreshes the markers but reports `transitioned: false`
  so the auto-send brake isn't pulled twice.

In the editor the per-item **"Resend"** button (codicon-refresh) is **hidden**
while the item is errored, and a **"Set to Pending"** button (codicon-history)
appears in its place.

#### Resume from the interrupted rep, not the next one

The dispatch loop bumps `repeatIndex` **before** awaiting the send (so the rep
number is visible to `lastDispatched` and the status formatters during the
dispatch). When the send then throws, the counter is one ahead of what was
actually delivered. Two recovery paths keep this correct:

- **"Set to Pending"** → `applyResetToPending`. Resets the item to `'pending'`
  **only** (never sends immediately), clears the failure + transient
  send-tracking fields, and **decrements the counter for the stage recorded in
  `lastDispatched.kind`** (`main` / `prePrompt[i]` / `followUp[i]`, bounded at
  0). Without this rollback a reset-then-drain would skip the errored rep and
  jump to rep N+2. Auto-send is left off (the error transition already disabled
  it); the user re-arms the queue via the toggle when ready, at which point the
  Resend button reappears (`lastDispatched` is preserved across the reset).
- **"Resend"** → `resendLastPrompt`. Replays `lastDispatched.expandedText` (the
  errored rep's frozen text) **without** touching counters, then the loop
  advances naturally to N+2. (After resending the failed rep it can itself
  return `'paused'`, holding the item in `'sending'` for a later resume.)
- **"Retry All Errors"** re-enables auto-send **before** kicking the cascade, so
  the queue drains properly after a bulk retry — the deliberate opt-in that the
  per-item error brake otherwise prevents.

The editor also exposes a **"Send next"** button (codicon-arrow-circle-up) per
pending item, backed by `move(id, 'front')` — a `'front'` direction that
relocates a pending item to the front of the in-progress queue. On the pending
item directly under a running loop (repeat count above 1 or `prefix*`; the
host flags it `canSendBetween`) the button is **"Send between iterations"**
instead: `toggleSendBetween(id)` marks it (`sendBetween`, one mark at a time,
persisted as `meta.send-between`), and at the loop's next iteration boundary —
after the pause gate, before a todo is claimed — the loop item steps back to
pending with its counters kept, the marked item moves in front of it and is
sent, and the loop resumes after it (`src/utils/queueSendBetween.ts`).

**Moving an item to another run**: `moveItemToRun(id, run)` (the queue editor's run chip, message
`moveItemToRun`, which picks among the quest's other runs) sets a staged or pending item's `run`, maps a
named session to the new run (`runSessionName(sessionBaseName(session), run)`), drops `sendBetween` and
`yieldAfterIteration` (both refer to the old lane) and puts the item at the end of the queue, behind the
run's items. Refused for a sending item, an item of a Proceed run (`processRun`) and a process-move marker.

**The queue of a deleted run** (vscimpb86): the editor's tabs are the quest's runs plus every run that still
has items (`knownRuns()` in `media/queueEditor/main.js`), so a run deleted while it had items keeps its tab.
On every render a tab whose run is not among the state's `processRuns` (and is not `default`) is orphaned
(`isOrphanedRun`): muted (`run-tab-orphaned`), `(deleted run)` in its label and tooltip, and a remove button
beside it (codicon trash, *Remove this deleted run's queue: delete its items*) that posts `removeRunQueue`
with the run. A run created again under the same name is in `processRuns` again, so its tab is live, with
its old items, and has no button. The host (`case 'removeRunQueue'` in `queueEditor-handler.ts`) refuses
`default` and live runs (`runQueueRemovalRefused`), plans the removal (`runQueueRemovalPlan` in
`src/utils/runQueueRemoval.ts`: the finished items — `sent`, `chat-sent`, `error` — and the others per
status) and asks in a modal (`runQueueRemovalDialog`): with only finished items one *Delete N items*; with
items not finished also *Delete only the N finished items*, the detail naming the counts per status and that
a sending item is stopped. It checks the run is still deleted, then calls the manager's
`removeRunQueue(run, mode)`: `all` removes every item of the run through `remove(id)` (a sending one is
stopped, as removing it stops it), `finished` only the finished ones; when no item of the run is left its
settings entry (`runs.<run>`) is deleted too, so a run created later under that name starts from the start
values. The tab goes once its items are gone, and the selection falls back to the window's run.

**Let the next item go first** (`src/utils/queueYield.ts`) is the reverse: the
iteration item yields. `letNextGoFirst(id)` on a pending iteration item moves
it directly behind the next pending item of its lane (`orderForYield`); on a
sending one it arms `yieldAfterIteration` (persisted as
`meta.yield-after-iteration`; a second call cancels it). At the next iteration
boundary — the same point as send-between: after the finished iteration's
answer, waits and continuation check and the pause gate, before a todo is
claimed — an armed item with a following pending item in its lane
(`yieldTarget`) clears the flag, steps back to pending with its counters, run
id and answers kept, moves behind that item, and the frame ends `'paused'`;
`sendNext` then sends the item in front, and the walk resumes after it. With no
following item (or a walk that is done) the flag is dropped and the loop goes
on. The editor's state carries `canLetNextGoFirst` / `letNextGoFirstUnavailable`
per pending or sending iteration item (the step-over button, disabled with the
reason); Continue offers it (`continueOptions`, action `letNextGoFirst`); and
`tomAi_updateQueueItem` takes `letNextGoFirst: true | false`.

**Queue next** (the @CHAT ANTHROPIC/LLM subpanel; `addToQueue` with `next`)
calls `enqueueNext`: the item is enqueued pending (not deferred) at
`nextQueuePosition` — directly under the sending item, or in front of the
first pending item when that comes earlier or nothing is sending — with
nothing pinned (the queue's profile and session), and marked `sendBetween`
when the item above is a running loop.

**A session a chat send runs in.** `sendItem` does not start an item
whose resolved session a live chat send holds
(`chatHoldingSessionOf`, `src/utils/sessionBusy.ts`); it stays pending, the
editor's state flags it `waitingForSession`, and `completeChatItem` calls
`sendNext` once the chat send ended. In the other direction, a chat send into a
session a queue item runs in is not started: `resolveBusySession` offers Run
next (`enqueueNext`), Run after the current item (`enqueueAfterCurrent`: under
the running item, unmarked) or a free session. A `chat` item is always
removable; removing a running one stops its send (`abandonChatSend`).

**Editing a pending item's text.** `updateText` accepts staged and pending
items (`canEditText`; a pending item has not been dispatched, so its expansion
is built again). The queue editor's edit button opens the text
(`beginTextEdit`; the editor keeps the draft and its focus over redraws); while
it is open, `sendNext` holds when that item is next (`sendNext: held — item …
is being edited`), which also covers an item sent between iterations, since
the loop steps aside and calls `sendNext`. `endTextEdit(id, text?)` saves (or
cancels) and calls `sendNext` when auto-send is on and nothing sends; the
editor's dispose calls `endTextEdit(undefined)` so a closed editor never
leaves the queue held. The state flags an open edit as `textEditing`.

`itemHasInFlightProgress`, `applyErrorTransition`, and `applyResetToPending` are
all pure (no `vscode` imports) and unit-tested in
[`queueErrorTransitions.test.ts`](../src/utils/__tests__/queueErrorTransitions.test.ts);
the manager owns persistence and change-event firing, keeping the helpers free
of side effects.

#### Interrupt for continuation

The third interruption is external: the user has to pull the plug — the
network is about to go away, the machine is about to sleep — and wants the
running prompt to go on, or run again, once it is back; neither a fresh
restart (**Stop**, which reverts to `staged`) nor a finish-first (**Pause**,
which lets the in-flight rep complete). The toolbar's
`codicon-debug-disconnect` button, and the same icon on the running item's row,
call `interruptActiveItemForContinuation(id?, run?, { hard? })`. It is **soft
first** (vscimpb112):

- **Soft interrupt.** `SoftInterruptRegistry.request(itemId, onTimeout)`
  (`src/services/softInterrupt.ts`, vscode-free) asks the turn's next hold
  point to hold the result of its next tool call: the result is not handed
  back to the model, so the turn stays open the way it stays open while a
  `tomAi_askUser` question waits, and no API request is in flight while it is
  held — the hold needs no network. The run's auto-send goes off
  (`_pauseRunOf`). The hold points call `holdAt(currentQueueItemId(), tool,
  result, extras?)`, which answers at once unless a soft interrupt of that item
  is requested:
  - Agent SDK: the extension's tools in their MCP handlers (`heldAtResult`,
    `agent-sdk-transport.ts`), Claude Code's built-ins through a `PostToolUse`
    hook that awaits the release (`softInterruptHoldHook` / `withSoftInterruptHold`,
    `utils/agentSdkQueueRun.ts`; queue runs only, a 30-day hook timeout,
    the extension's own `mcp__tom-ai__*` tools passed), and the built-in
    `AskUserQuestion` where `canUseTool` answers it;
  - direct API, Local LLM and VS Code LM: the tool loop in
    `anthropic-handler.ts`, after the round's tool results and before they go
    into the next request. The direct API and Local LLM loops hand over the
    conversation up to and including the held results (`extras.conversation`),
    which the manager saves to `<queue folder>/held/<item>.conversation.json`
    (`heldConversationFile`).
- **The wait.** Nothing held within `SOFT_INTERRUPT_TIMEOUT_MS` (15 s, counted
  from the press): `_softInterruptTimedOut` — a turn waiting in an ask* tool
  (`AskUserRegistry.pendingForQueueItem`, `waitingForUserOf`) or in
  `tomAi_waitFor` (`item.waitingFor`), or for its background work after its
  answer (`item.backgroundWait`, tool `background work`), counts as held
  (`markHeld`, kind `question` / `wait`; the question stays open, the wait goes
  on), any other — a tool still running, text without a tool call — gets the
  hard interrupt. A turn already waiting in any of them when the button is
  pressed is held at once.
  An answer given while the item is held is accepted: it passes the hold point
  of its tool and is kept until the release.
- **The turn ends within the wait**: `dispatchStage` clears the request; the
  stage is done and the run stays paused — nothing held, nothing resent.
- **Between two stages** (the item is `sending` but no dispatch is live): the
  press only pauses the run; the next stage goes out on resume.
- **Release.** Re-arming the run's auto-send (`_onRunResumed` →
  `_releaseHeldItems`, before the interrupted-item resume), Continue's
  **Resume** (`resumeHeldItem`, which switches auto-send back on) or
  Telegram's `continue` (the same auto-send) releases the held result: the
  turn goes on where it stopped, nothing is resent. A result held longer than
  a minute starts with `[This result was held for <duration> by the user's
  interrupt for continuation.]` (`heldForLine`; on the Agent SDK's built-ins it
  goes to the model as the hook's additional context).
- **Waiting without a limit** — a second click while the request still waits
  for its hold point (`SoftInterruptRegistry.waitWithoutLimit`): the timer
  stops, the state records `unlimited`, and the turn is held at its next tool
  result however long that takes (or ends by itself). **Cancel interruption**
  (`cancelSoftInterrupt`) withdraws a waiting request or releases a held turn,
  and switches the run's auto-send back on when the press had switched it off
  (`pausedAutoSend`).
- **Hard interrupt** — a third click, or a click once held (toolbar or row), the
  item panel's **Hard interrupt now**, Continue's **Hard interrupt**, the wait
  running out (not when waiting without a limit) — is `_hardInterrupt`: the
  in-flight dispatch is cancelled exactly as Stop does (`_cancelActiveDispatch`
  — epoch bump, CTS cancel, approval awaiters released, the soft interrupt
  cleared and a waiting hold point let go), the todo claim released, and the
  item moves to **`interrupted`** via the pure
  `applyInterruptForContinuation`. Its cursor is left untouched — counters,
  pre-prompt statuses, `followUpIndex` and `lastDispatched` all survive — and
  only transient send-tracking is cleared (`awaitingAnswer`, `sentAt`, the
  in-flight repetition snapshot, a stale error). There is no counter rollback: the loop bumped it before the
  send, so it already names the interrupted rep, and the resume path replays
  that rep's frozen text. The item gets `interruptNote`, keeps what a soft
  interrupt held (`softInterrupt.heldResult`), and auto-send of its run is
  switched off — not merely paused: the pause gate only refuses the *next* rep,
  and here nothing may go out until re-armed.
- **A lost turn** — the SDK process ends (`dispatchStage` catches the error of
  a soft-interrupted item whose CTS was not cancelled: `_softTurnLost`), or a
  reload / extension-host restart during the wait or while held (crash
  recovery: a `sending` item with `softInterrupt` becomes `interrupted` with
  `interruptNote`, and `_pauseLostSoftRuns` pauses its run once the run
  settings are read, after Auto-Start) — leaves the item `interrupted` and its
  run paused.

The item records the soft interrupt as `softInterrupt` (`requestedAt`,
`heldAt`, `kind`, `tool`, `heldResult` cut at 20 000 characters; YAML
`soft-interrupt`), the conversation its turn runs in as `turnSessionId` (the
Agent SDK session id from the turn's first message, `onTurnSessionId`; YAML
`turn-session-id`), `interruptNote` (`interrupt-note`) and
`heldConversationFile` (`held-conversation-file`).

Re-arming auto-send — the play toggle, Auto-Start on load, or Auto-Continue's
timer — releases held items first, then runs `pickInterruptedResume` before any
paused or pending work. With a `lastDispatched` snapshot the item is replayed
through `resendLastPrompt` (same expanded text, counters untouched, then the
loop advances naturally); without one (cancelled before any stage went out) it
simply re-enters the backlog as `pending`. `sendNext` carries the same hook,
guarded by auto-send, so a drain that does not come through the setter — a
manually-sent item completing — resumes it too. While another item is
`sending` the resume waits. **A resend after a hard interrupt or a lost turn**
(`interruptNote`, also the row's Resend) starts with `RESEND_INTERRUPTED_NOTE`
plus, when a tool result was held, `The result of your last tool call <tool>
was: <result>` (`heldResultResendLine`), and continues the very conversation
the turn ran in: `continueSessionId` = `turnSessionId`, which `sendMessage`
resumes without a fork whatever the session's lifetime (per-prompt and
per-iteration continue that prompt's own copy; whether the session file
records it follows the lifetime as for every send). A held direct-API or Local
LLM turn lost to a restart is not resent: `resendLastPrompt` reads the saved
conversation (`prefixHeldConversation` puts the held-for line before its tool
result) and dispatches it as `resumeConversation`, which the loop takes in
place of a new prompt — the turn continues exactly where it stopped.

Replaying the byte-identical text rather than re-expanding the prompt is
deliberate: re-expansion could resolve `${todo}` to a different todo than the
one the interrupted rep had claimed.

The row of a soft-interrupted item says **`INTERRUPTING`** (a spinning icon; the
tooltip the seconds left to the hard interrupt) and then **`HELD`**
(`codicon-debug-disconnect`; *held since 14:05 at the result of <tool>*); after
the first click the button shows `codicon-watch` (*click again to wait for the
hold point without a limit*), waiting without a limit (`INTERRUPTING (NO
LIMIT)`) or held `codicon-debug-stop` (*click again for a hard interrupt
now*). While a soft interrupt waits or holds, the item shows a panel with
**Hard interrupt now** and **Cancel interruption**. A hard-interrupted row is
labelled **`INTERRUPTED <KIND> — RESENDS ON RESUME`** and offers **Resend** (replay now,
without re-arming) and **Move back to Staged** (abandon the continuation — the
same reset as stopping). Continue on a held item offers **Resume** and **Hard
interrupt** only. `interrupted` → `pending` is not a sanctioned transition — it
would re-dispatch with the counter one ahead and skip the rep — so `setStatus`
refuses it. `restartQueue` only resets `sending` and leaves a held item alone.
The status is enumerated in `queue-entry.schema.json` and on the MCP
`listQueue` surface.

**What the run tabs and the status bar show.** A run tab's state
(`runTabState`, `media/queueEditor/main.js`) takes this precedence: **held**
(`codicon-debug-disconnect`) > **answer needed** (a red ❓, the turn waits for the
user's answer) > **waiting in `tomAi_waitFor`** (⏳, a state of its own, not
`sending`) > **sending** > **paused** (`codicon-debug-pause`: auto-send off, or a
hard-interrupted item) > **waiting** (`codicon-clock`: pending items) > **idle**;
the tab's tooltip gives the text (held since … at the result of …; the
question's first line and since when; the wait's reason, until, time left and
since when). The row shows the same states (`❓ ANSWER NEEDED`, `⏳ WAITING UNTIL
14:20`). The host builds the views (`softInterruptViewOf`, `questionViewOf`
in `queueEditor-handler.ts`). The queue's status bar item
shows the window's run with the same icon and word (`runStatusBarText`,
`utils/queueRunStatus.ts`): `$(debug-disconnect) held: Bash`,
`$(loading~spin) interrupting`, `❓ answer needed`, `⏳ until 14:20`. No other
notification is given.

#### Backoff retry, deferred start, and idle signalling

Four refinements layer on top of the pause/resume/error model above. The retry
logic is pure and unit-tested in
[`src/utils/queueRetryTransitions.ts`](../src/utils/queueRetryTransitions.ts)
(no `vscode` imports).

- **`'retry'` status with a backoff cascade.** A genuine send failure no longer
  stops after a few immediate attempts. (A failure no retry can fix goes to `error`
  at once instead: the direct transport finding no API key, §4.17a, and a request
  the API refused as malformed — a 400 `invalid_request_error`, which every retry
  would send again unchanged; `isUnretryableRequestError`. Two 400s stay
  retryable because the retry changes what is sent: the stale
  `previous_message_id` below and a prompt that is too long, which compaction
  can shrink. Such an item fails like an exhausted schedule: auto-send goes off.) `_markItemError` parks the item in the
  new `'retry'` status and schedules re-sends at `RETRY_BACKOFF_MS` = 30 s, then
  +15/30/45/60/60/60 min (7 attempts, ≈ 4 h 30 m). Retry items keep their queue
  position; `statusSortRank` clusters `decision-needed`/`error`/`retry`/`waiting` at the top so a
  stalled queue is visible, and retry reuses the waiting **violet** (`#b39ddb`).
  Per-item **retry-now** (`retryRetryingNow`) and **stop-retrying**
  (`stopRetrying`, → paused `error`) icons are wired through the handler and
  manager; schedule exhaustion falls through to the existing paused-error
  transition. `computeRetryDecision`, `applyRetryScheduling`, `fireRetry`,
  `isRetryDue`, `applyStopRetrying`, and `isPreviousMessageIdError` carry the
  logic. The agent-SDK `previous_message_id … must start with msg_` 400 is
  classified via `isPreviousMessageIdError`; before the first retry the transport
  deletes `default.session.json` (`clearAgentSdkSessionId`) so the SDK
  re-handshakes clean instead of hard-failing the prompt.

- **`inFlightRepetition` rollback.** The dispatch loop advances a stage's
  repetition counter optimistically (`repeatIndex = mainSentCount + 1`, and the
  pre-prompt / follow-up equivalents) *before* the send resolves. A transient
  `inFlightRepetition` snapshot records that single advance; `_markItemError`
  calls the pure `rollbackInFlightRepetition` before every waiting / retry /
  hard-error transition so a retry re-sends the **same** failed rep instead of
  walking the loop forward.

  A snapshot must never outlive the dispatch it describes: while it is set, any
  `_markItemError` rewinds that counter, so a leftover snapshot turns an
  unrelated later failure into a silent rewind. It is therefore cleared at every
  transition that ends a dispatch — the pause gate, the top of each fresh
  attempt and the done path in `dispatchNextStageForSendingItem`; `setStatus`
  sending → staged (and so `stopActiveItem`); `resendLastPrompt`, which advances
  no counter of its own; and `applyCrashRecovery`. Dispatch **success** is
  not itself a clear point: `_clearRetryOnDispatchSuccess` wipes only the retry
  bookkeeping; the snapshot goes at the top of the next attempt or on the done
  path.

- **Idle-amber header.** A transient `awaitingAnswer` flag (set at all three
  dispatch points, cleared at the pause gate, the done path, and
  `_markItemError`) lets the webview tell a genuinely in-flight iteration from an
  idle gap between repetitions. The sending item's status-bar header (and the
  next pending item's) stays **green** while a prompt is processing and takes the
  amber `.status-bar.idle` background (`#ffc107`) once the queue is paused with
  nothing in flight (`queueActive = autoSend || some(sending && awaitingAnswer)`).
  The sending label splits into **`SENDING <KIND> (PAUSED)`** (iteration still running)
  vs **`PAUSED <KIND>`** (idle).

- **Quest-refresh running banner.** While a Quest Refresh prompt is being
  dispatched — from either the queue's own refresh step or an interactive send —
  `QuestRefreshService` exposes `isRefreshing` and fires `onDidChangeRefreshing`.
  The queue editor subscribes and paints an orange banner between the queue
  header and the first item, so a refresh-induced pause reads as intentional
  rather than stuck. `isRefreshing` is set only when there is an actual refresh
  prompt to dispatch (the blank trim-and-reset case stays instant) and cleared in
  the `finally`, so a failed refresh never leaves the banner stuck on.

- **What a refresh reads and trims.** Every Anthropic session keeps its own live
  trail (`history/<host>/sessions/<session>/live-trail.md`). The Anthropic refresh
  prompt gets the list of the session trails written since the last refresh,
  newest first, with their workspace-relative paths and last-write times
  (`sessionLiveTrailsSince` in `services/sessionStorage.ts`, formatted by
  `utils/refreshSessionTrails.ts`): in place of `${refreshSessions}` when the
  configured `questRefresh.anthropic.refreshPrompt` holds it, else appended.
  The refresh then trims every session's trail to the base five blocks, resets
  the counter and records `lastRefreshAt` in the `questRefresh` section of the
  host's `extension_config.<host>.<quest>.yaml` — the later of now and the
  trim's own writes, so the next list starts after it. Before the first refresh
  on a host, every session's trail is listed. The other panels have no
  sessions; there the placeholder is removed.

### 4.19 Sessions, iterations and the session's profile

An item runs in a named session (`session`; unset: the queue default, else the queue's own `default`). The session's lifetimes and files are described in `anthropic_sdk_integration.md` §18.12; the queue's part is:

- **Name or spec.** `session` is a name or a spec `{name, basedOn?, mode?, profile?}` (`parseSessionSpec`, `src/utils/sessionSpecs.ts`). `mode` is `continue`, `per-prompt` or `per-iteration` (`fork-from-base` is read as `per-prompt`); neither lifetime needs a base. A malformed spec is refused by `enqueue` / `updateItemSession`, and by `tomAi_addQueueItem` / `tomAi_updateQueueItem` with code `invalidSession`. The item keeps the name in `session` and the rest in `sessionCreate`.
- **Created at dispatch.** `dispatchStage` calls `ensureItemSession` before a send: a session that does not exist is created from the spec (its missing base first, plainly; the spec's profile, else the item's `anthropicProfileId`), a bare name as a fresh `continue` session. `chat` and `default` are never created here.
- **Iteration keys.** Every stage dispatch carries `iterationKey` (`src/utils/queueIterations.ts`): `ensureRunId` gives the item a run id on its first dispatch, `iterationSeq` counts the main prompts sent, the main prompt runs in iteration `iterationSeq + 1` and counts it, a pre-prompt runs in the iteration it precedes, a follow-up in the one it follows. A failed main send rolls `iterationSeq` back with the repetition (`prevIterationSeq` in `inFlightRepetition`), so the re-send runs in the same iteration; `lastDispatched.iterationKey` makes a resend run in it too. `resetItemRunState` (Send Now on a sent item) clears the run id, so a new run starts new conversations. The Quest Refresh prompt is sent without a key.
- **Profile precedence.** `resolveStageTransport`: the stage's profile, else the item's, else the session's (`profileId` of its file, else the spec's `profile`), else the queue default.
- **Transport check.** `sessionRefusal` refuses an item, when it is queued or its session changes, whose stages would run with a profile that keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued by a profile with our own history, or the reverse), or whose spec names an unknown profile.

Persisted keys (entry YAML): `session` is a string, or the map `{name, basedOn, mode, profile}` when the item carries a spec; `execution.run-id`, `execution.iteration-seq` and `execution.last-dispatched.iteration-key`. The older key `agent-sdk-session` is still read.

### 4.20 Done notification and items from other quests

**Done notification** (`src/utils/doneNotification.ts`). An item may carry `doneNotificationPrompt`. Every completion path calls `_afterItemDone`, which queues the next template iteration (`buildNextTemplateIterationParams` carries transport, profile, session and the notification fields to it) or, after the last, calls `_itemFinished`. `_markItemError` and `_failForMissingApiKey` call `_itemFinished` for the errors that will not recover: no API key, a request the API refused (400 `invalid_request_error`), an exhausted retry schedule. A usage limit being waited out (`waiting`) and a scheduled retry (`retry`) are not the end of the item. `_itemFinished` plans with `planDoneNotification`:

- nothing when there is no prompt, a blank one, `doneNotificationDisabled`, or one already queued for this run (`doneNotificationRun`: a retried error that then succeeds does not notify twice; Send Now starts a new run, which notifies again);
- otherwise a new item at the index of the first pending item (ahead of everything else pending; appended when nothing is pending), with the finished item's transport, profile and session, `notificationOf: <item id>` and the sender (`from`) of the item;
- `${itemOutcome}` becomes `done` or `error: <message>` (one line);
- the item's `pauseAfter` moves to the notification, so the queue pauses after the notification, not before it;
- a temporary session is handed to the notification, which runs in it; it is deleted once the notification is done, or at once when there is no notification (`_deleteTemporarySession`: the `.session.json` and `history/sessions/<name>/`).

`updateItemDoneNotification(id, {prompt?, disabled?})` changes the prompt or switches it off until the item is `sent`, also while it is sending; the queue editor shows it in a collapsible section under the item's prompt with a bell icon, and `tomAi_updateQueueItem` takes `doneNotificationPrompt` / `doneNotificationDisabled`.

**Items from other quests** (`src/utils/questInbox.ts`, `tomAi_sendItemToQuest`). The sender writes `<host>_<workspace>_<yymmdd_hhmmss>-<token>.inbox.queue.yaml` into the queue folder (a dot-named temporary file renamed into place), holding only what it said: text, template, `anthropic-profile-id`, `done-notification-prompt`, `pause-after`, `session` or `new-session`, and `from` (quest, window id, host, time). The workspace is that of a running window of the quest (its window-state file), else the quest id. The target window's `takeInbox` runs on the inbox watcher (`onInboxChanged`, pattern `<host>_<workspace>_*.inbox.queue.yaml`), at start (files written while no window ran) and in the health check. It claims each file by renaming it to `<file>.claimed-<window id>`, so with two windows on one quest only one gets it. A claim older than two minutes (a window that stopped mid-way) is claimed again. `planInboxConversion` turns the file into enqueue options with the target's defaults for what the sender left unset: a given profile means transport `anthropic`, and `${senderQuest}` in the text and the notification prompt becomes the sender's quest. A new session is created before the item is queued (profile: the one given, else the base's, else the item's; without a name `tmp-<yymmdd-hhmmss>-<token>`, `temporarySession`). A profile or session the target does not have, or a session the profile cannot continue, queues the item as an `error` (prefixed `Sent by <quest>:`), and its done-notification still goes out. A file that cannot be read is set aside as `<file>.rejected`.

Persisted keys (entry `meta`): `done-notification: {prompt, disabled?, queued-for-run?}`, `notification-of`, `from: {quest, window-id, host, sent-at}`, `temporary-session`.

### 4.21 The prompt after a reload

The Status Page's *Send prompt after reload* (Queue & Timer → After Reload, stored per quest scope as `reload-prompt-by-scope` in `queue-settings.yaml`) goes through the queue. At activation `scheduleConfiguredReloadPromptSend` (extension.ts) waits for `PromptQueueManager.whenReady()` (the queue restored: entries loaded, crash recovery applied) and `ProcessStateStore.ready` (the window's run known), then calls `queueReloadPrompt(text)`:

- the prompt becomes an item of the window's current run with that run's defaults (profile, session, template), inserted at position 0, marked `reloadPrompt: {windowId}` (entry `reload-prompt: {window-id}`; the queue editor shows an **after reload** chip) and logged in the Tom Prompt Queue channel;
- an unsent reload item this window queued before is replaced; another window's stays (several windows of one quest may each queue one);
- it is sent with `sendNow`, as Continue / Send Now send an item: also while the run is paused, without switching its auto-send on, so the items behind it wait as before. While an item of the run runs a stage (`runLaneBusy`: sending, not held at the pause gate) it waits, pending, and is sent once none does.

## 5. Edge cases and non-obvious bits

- **Template expansion placeholders** (`${repeatNumber}`, `${repeatIndex}`, chat variables): handled at expand-time inside `_buildExpandedText` at [promptQueueManager.ts:1135](../src/managers/promptQueueManager.ts#L1135). A chat-variable-driven `repeatCount` is resolved the same way.
- **TODO and GROUP items (vscimpb127).** A walk is what `parseTodoWalk` (`queueStep3Utils.ts`) reads in the repeat count: `<prefix>*`, `todo:<quest>/<id>` (one todo) or `group:<quest>/<id>` (a group todo's members in `comprised_of` order, this quest's only). `collectWalkTodos` gives the walk's todos, and every walk rule — the pick, the release of blocked todos, the user-action pass, the decision hold, the empty reason, the series count — reads them through it, so the three kinds share the claim, the record, the completion check and its continuations. `todoQueueItemSpec` (`todoQueueItems.ts`) checks a todo / group and gives the walk value and the todo pattern; the todo panel, `tomAi_addQueueItem` and `tomAi_sendItemToQuest` use it. Every item carries its kind (`deriveQueueItemKind`, `queueItemKind.ts`: todo, group, prefix, iteration, chat, prompt), written as `item-kind` on every save and derived for an entry written before it.
- **`repeatCount` resolves at dispatch, not enqueue.** A `repeatCount` may be a plain integer, a chat-variable name, or a **`prefix*` pattern** (e.g. `tod*`). The raw value is stored on the item at enqueue (the client webview and the enqueue handlers no longer coerce a non-numeric value down to `1` — see `normalizeRepeatCountInput` / the webview `normalizeRepeatField`), and the actual count is computed at the processing chokepoint `resolveStableRepeatCount` and cached to `item.resolvedRepeatCount`. For a `prefix*` value, `resolveTodoPrefixRepeatCount` returns the highest number among the active quest's todo ids that start with `prefix`, the number being the first digit run after the prefix wherever it starts (`tod3b` and `tod-groupa3` count as `3`; a literal prefix with dashes, `tod-groupa*`, narrows to one group), and empty/non-matching patterns fall back to `1`. The id list comes from `readAllTodos`, which reads the quest's **live** todo files only — the `-archived` / `-deleted` siblings are excluded, so a retired todo cannot inflate the iteration count (see `TodoFileScope` in `src/utils/todoArchiveNames.ts`).
- **Blocked todos are released before each pick.** `releaseUnblockedTodos` (`queueStep3Utils.ts`, live store via `questTodoUnblockPort`) sets a `blocked` todo of the series back to `not-started` when every id in its `blocked_by` is completed, cancelled or absent from the live files (`<quest>/<id>` names another quest); `todosToUnblock` is the pure rule. A todo with an open blocker, no `blocked_by`, or a `blocked_until` condition stays blocked, and the picker never takes a blocked todo.
- **A `prefix*` main prompt runs in TODO ITERATION mode, not counter mode.** `planMainStageDispatch` (`src/utils/queueStep3Utils.ts`) reduces both modes to one gate. In counter mode the gate is `sentCount < repeatCount`. In todo mode `sentCount` is ignored entirely: `pickNextTodoForIteration` returns the lowest-numbered `not-started` todo matching the prefix (ties broken alphabetically, so `dsa2-a` precedes `dsa2-b`), and the stage runs while one exists. The resolved count stays frozen as the *displayed* series size only.
  - **Termination comes from the status write, not from a counter.** The dispatcher marks the picked todo `in-progress` **before** sending; an `in-progress` todo no longer qualifies, so the candidate set strictly shrinks. If the write does not stick (`updateTodo` returns `undefined`), the stage ends instead of dispatching — otherwise the same todo would be picked on every pass.
  - **`item.repeatIndex` carries the todo's number** in this mode (so the entry reads "7/9" for `dsa7`), and `${repeatNumber}` prints it. `${repeatTodoId}` / `${repeatTodoTitle}` name the todo; both are `''` outside todo mode.
  - **Every prompt of the iteration carries the todo's record** (`src/utils/todoIterationRecord.ts`, `iterationTodoBlock` in the manager): `_buildExpandedText` appends "Here is the complete YAML of the todo:" and the stored todo (every field, `_extra` put back, without the derived `blocking`) in a yaml fence headed by its file, after the repeat pass and before the template pass; its `${` are escaped (`escapePlaceholders`), so the pass leaves it as stored and the transport's unescape restores it. The main prompt carries the todo it claimed, a pre-prompt the todo `pickNextTodoForIteration` will pick (pre-prompts run before the first todo), a follow-up `item.repeatTodoId` (the last todo walked).
  - **The status write is a claim the runner owes an outcome for** (`src/utils/queueTodoClaim.ts`). `claimTodo` records the status it overwrote, and the claim is persisted with the item (`todo-claim` on the main prompt), so a reload does not lose it. When the answer for that dispatch arrives, the claim is **settled**: it is dropped and the todo's status is the agent's. When the run ends without an answer — stop (`setStatus → staged`), interrupt-for-continuation, a dispatch error, removal or clear of an in-flight item — the claim is **released**: the prior status is put back, but only if the todo still holds the runner's `in-progress`; a status the agent or the user wrote meanwhile is left alone. A released claim stays on the item marked `released`, so a Resend of the same main-stage prompt can claim the todo again.
  - **Rollback and release are separate steps.** On a dispatch error the shared failure handler runs `rollbackInFlightRepetition` (pure: it restores the counters and `prevRepeatTodoId`, what the entry displayed) and then releases the claim, which is the I/O half. The retry then picks up the same todo rather than skipping past it.
  - **Scope**: main prompt only. A `prefix*` on a pre-prompt or follow-up keeps counter behaviour against the resolved max-index.
  - **A walk with nothing to walk over is held at enqueue.** `enqueue` asks `emptyTodoIterationReason` (`queueStep3Utils.ts`) about the main prompt's `prefix*`: no todo of the prefix, or none `not-started` (and not the user's), `blocked` or `decision-needed`, puts the item in `error` with the reason (`Nothing to iterate over: …`, `isEmptyTodoIterationError` recognises it) and runs its done-notification. `setStatus`, `resetItemToPending` (the queue editor's Set to Pending), an edit of the repeat count and adding / changing / removing a pre-prompt check again (`recheckEmptyIteration`): work now → `staged`, still nothing → the reason renewed (`resetItemToPending` throws it). An item queued with pre-prompts is not judged, since they may create the todos.
  - **No matching todo is not "run once".** `resolveTodoPrefixRepeatCount` floors at `1`, but a "work on `${repeatTodoId}`" prompt with no todo to name is worse than no prompt — the stage logs and skips.
  - **A todo that is the user's to do is passed, never sent.** `user_action: true` on a todo (read by `readQuestTodoEntries` as `userAction`) marks work only a person can do. `pickNextTodoForIteration` skips it, so it stays `not-started` and the walk takes the next todo; sent to an agent it could only be prepared, and since its status would not change the walk would pick it on every pass. `planMainStageDispatch` names the passed todos in `waitingForUser` on the `todo` and `exhausted` plans (`collectUserActionTodos`, present only when there are some) and the manager logs them. A series of only such todos is `exhausted`. An unmade decision on one still holds the series.
  - **An unmade decision holds the walk when it is the next todo.** A todo in status `decision-needed` — one whose `decisions[]` the user has not answered yet — is never run. `decisionHoldingWalk` takes the series in walk order (lowest number first) and finds the first todo the walk would run or stop at (walkable, `decision-needed`, or blocked by a todo that is not done; completed, cancelled, in-progress and the user's own are passed as the pick passes them); when that one is `decision-needed`, `planMainStageDispatch` returns `{mode: 'decision-needed', todos: [it]}` ahead of both the pick and the exhausted check. A decision further down the series holds nothing yet: the todos before it run, and the walk holds when it reaches it. The manager logs the waiting id, moves the item to the **`'decision-needed'`** status, flips auto-send off and returns `'paused'` — reporting `exhausted` instead would quietly finish the item with the question never surfacing. `statusSortRank` puts `decision-needed` at the very head (ahead of `error`) because it is the only stopped state that cannot clear by itself, and the entry renders amber (`#ffb300`).
  - **A blocked todo holds the item when it is the todo the item is about.** `walkEntriesOf` gives every todo of the series its block state (`utils/todoBlockState.ts`: an unmet `blocked_by` entry — an open todo, an unknown id, prose — or a `blocked` status nothing releases; blockers are looked up in every quest, live and archived). `releaseUnblockedTodos` first sets back to `not-started` the todos still marked `blocked` whose blockers are all done, so blockers completed in the meantime never hold. Then `blockHoldingWalk` takes the series in walk order and finds the first todo the walk would run or stop at; when that one is blocked, `planMainStageDispatch` answers `todo-blocked` and the dispatcher holds the item (`_holdTodoBlocked`): status `todo-blocked`, `blockedOn` (the todo and what it waits for; YAML `blocked-on`), the run paused, and — through the notification emitter's `holdingState` — a `queueHolding` event of kind `item-blocked`. A plain item that names its todos in `todoIdPattern` (no walk) is checked the same way before its main prompt goes out (`_todoBlockOf`). `_releaseUnblockedItems` (called with the decision release before every pick) puts a `todo-blocked` item back to `pending` once its todo is no longer blocked. A checked member of a GROUP item's selection is sent although blocked; the user's own todos are passed.
  - **Every item queued from the todo panel names its todos** (`todoIdPattern`: the todo, the group and its members, or `<prefix>*`; the panel's entry type requires it), so the queue can read their block state and the panel can mark them queued.
  - **A held item is released only once its decisions are answered — the rest of the queue runs past it.** `sendNext()` calls `_releaseResolvedDecisionItems()` before picking the next item; it re-reads the quest todos and `releaseResolvedDecisionItems` (pure, `queueStep3Utils.ts`) puts back to `'pending'` every held item whose walk is no longer held (`decisionHoldingWalk` finds nothing: the todo it was held at had its decisions answered; a later `decision-needed` todo holds it again only when the walk reaches it). An item whose decisions are still open stays held and `sendNext` picks the next *pending* prompt instead, so a `dec*` item waiting on the user no longer stops prompts that have nothing to decide. Releasing unconditionally on resume is what made the play button look like a no-op: the released item was the first pending one in array order, so it was picked, re-blocked, and auto-send went straight back off. Items whose block can never resolve — a repeat count that is not a `prefix*` pattern, or an unreadable/empty todo set — are released rather than stranded; the gate then reports `exhausted` and the item finishes. Only `status` is touched, so an item with prior repetitions resumes on its counters rather than re-sending from the top. `decision-needed` is state-machine-managed: `tomAi_setQueueItemStatus` cannot set it.
- **One gate decides whether the queue advances after a completion.** `decideAdvanceAfterCompletion(pauseAfter, autoSendEnabled)` (`src/utils/queueStep3Utils.ts`), reached through the manager's `_shouldAdvanceQueueAfter(item)`, answers both reasons the queue might stop — the queue is paused, or the item carries "pause after this" — and applies the flag's side effect of flipping auto-send off. A completion tail calls `sendNext()` / `delaySendNext()` **only** when it returns true.
  - **Every completion site goes through it**: resume-from-pause, manual **Continue** (`advanceSendingItemWithoutAnswer`), a manual status change (`changeItemStatus`), a process-move marker, `sendItem`, `resendLastPrompt`. Neither the pause nor the auto-send toggle may depend on *how* an item happened to finish. `queueAdvanceAfterCompletion.test.ts` asserts this against the manager *source* — `PromptQueueManager` imports `vscode` and cannot be instantiated under `node:test`, so the wiring is checked by scanning each `status = 'sent'` site for a guarded advance.
  - **`sendNext(force?)` starts only the runs whose auto-send is on**; the explicit escape hatches name the runs they kick even while paused (`force`): the health-check resume after a rate-limit / retry window (the runs of the items that became due), per-item `retryWaitingNow` / `retryRetryingNow` (the item's run), `retryAllErrors` (which re-enables the auto-send of the runs it retries first), and `sendItem` called directly by "send now". That is precisely why the check is mandatory in the completion tails — and why it lives in one method instead of being restated at each of them: a tail that restates only half the condition looks correct in isolation while letting a paused queue start the next item.
  - **"Pause after this" holds at item granularity, not stage granularity.** `item.pauseAfter` never shortens an item: the gate is consulted only where an item reaches `'sent'`, so all pre-prompts, every main-prompt repetition and all follow-ups run first.
  - **Sticky, not one-shot.** The flag stays on the item, so re-sending it pauses again. It is persisted under `meta.pause-after` and rendered inverted in the entry header — including on a finished item, so a leftover flag stays visible.
- **Pre-prompts**: each pre-prompt awaits its own call. Because a dispatch completes inline, the pre-prompt chain runs back-to-back without gaps.
- **Pre-prompt context carries automatically.** The Anthropic handler preserves turn history across calls: Direct / VS Code LM / Local LLM leaves use `rawTurns` + `compactedSummary` (appended on every non-isolated `sendMessage`), and the Agent SDK leaf uses its own session continuity via `default.session.json`. A pre-prompt's answer is therefore visible to the main prompt without any queue-level chaining or placeholder machinery — the user just writes pre-prompt and main prompt naturally, and the handler stitches them into one conversation.
- **A template reference holds whatever the profile.** Template ids name entries of the one store, so changing an item's profile or configuration leaves its template selection as it is.
- **`toolApprovalMode` coercion covers every Anthropic leaf path.** Direct, Agent SDK, VS Code LM, Local LLM — all honour `'never'` when called from the queue. The coercion happens *before* `AnthropicHandler.sendMessage` dispatches into a leaf primitive, so the shared loop receives the coerced value. Each leaf primitive participates in the Anthropic handler's own approval gate rather than its own — which is why the Local LLM leaf uses `callLocalLlmOnce` (§4.4a): the pure HTTP call with no approval inside it.
- **Concurrency**: each run's lane is strictly sequential (one `sending` item of the run at a time); two items also never run in the same session at once (`utils/queueLanes.ts`).
- **Failure modes** (full pause/resume + error semantics in §4.18):
  - Anthropic API error (any leaf) → item status `'error'`, error message surfaced, **auto-send flipped off** (anti-cascade), item held at the front for "Resend" / "Set to Pending" (§4.18).
  - `vscode.lm.selectChatModels` returns no entry matching the configuration's stored `modelId` → surface "VS Code LM model not available", pause queue, do not retry. (The stored model was valid at configure-time but the provider extension may have been uninstalled.)
  - `anthropicConfigId` references a config that no longer exists in either the Anthropic or Local LLM config store → dispatcher returns a clear error without touching the transport.

## 6. Step-by-step implementation order

The parts in the order they build on each other:

1. **Data model** — the optional target fields (§4.1).
2. **`vscodeLm` configuration type** (§4.2) — schema + JSON-schema + `SendToChatConfig`; the model triple is stored on the configuration.
3. **Local LLM primitive** (§4.4a) — `callLocalLlmOnce(messages, tools, config)` on `LocalLlmManager`.
4. **AnthropicHandler shared loop + leaves** (§4.4) — `sendViaVsCodeLm` and `sendViaLocalLlm` beside the Direct loop and the Agent SDK stream. Every leaf feeds the same live-trail / tool-approval / built-in-tool-persistence hooks.
5. **Anthropic profile config picker** (§4.3) — lists Anthropic + Local LLM configs with type labels. The resolver falls back across both stores.
6. **Dispatcher + stage loop** (§4.5, §4.6) — `dispatchStage` through `AnthropicHandler.sendMessage`; a dispatch completes inline.
7. **Stage and health check** (§4.7, §4.8) — a stage is one awaited call; the 60 s health check restarts what is due.
8. **ANTHROPIC/LLM panel queueing buttons** (§4.11) — Save to Queue and Queue next, for the default run and for the panel's target.
9. **ANTHROPIC/LLM panel Available models overlay** (§4.12) — informational only.
10. **Queue editor UI** (§4.10) — the run defaults row, the per-item and per-stage profile picks, the auto-approve warning.
11. **Tool surface** (§4.13) — the target fields in the add/update queue tools.
12. **Profile pickers** (§4.15) — the queue editor's places a profile is picked.
13. **Template editor** (§4.16) — the one store, category `Anthropic — User Message`.
14. **The four prompt-template tools** (§4.16) — on the one store, no transport.

## 7. Out of scope

- **Further chat surfaces.** Any further model backend goes through the Anthropic profile layer (as a configuration an Anthropic profile references) rather than a parallel transport path; consolidation happens at the profile layer.
- **A second queue transport** and a shared `ChatTransport` interface — one dispatcher plus the Anthropic handler's internal fork is simpler and has no other reuse target.
- **Streaming chunks to the queue** — each leaf primitive returns the full text of one round once done. If needed, `onChunk` callbacks go inside the shared loop without touching the queue.
- **Queue-level auto-chaining of pre-prompt answers** — not needed. The Anthropic handler carries turn history (`rawTurns` for Direct / VS Code LM / Local LLM; session id for Agent SDK), so a pre-prompt's answer is available to the main prompt by virtue of the session behaviour. No placeholder dance, no toggle.

## 8. Acceptance checklist

- [x] `QueuedPrompt.transport` accepts only `'anthropic'`; a stored `copilot` is read as `anthropic`; no other values in the queue schema (`localLlm` is an Anthropic configuration transport, not a queue transport).
- [x] A queue item with a `direct` config hits the Direct path.
- [x] A queue item with an `agentSdk` config hits the Agent SDK path.
- [x] A queue item with a `vscodeLm` config routes through `sendViaVsCodeLm` (full tool-use loop) and concatenates `{systemPrompt}\n\n{userText}`.
- [x] A queue item whose `anthropicConfigId` points at a Local LLM config runs through `callLocalLlmOnce` under the Anthropic handler's shared loop (same concatenation rule, same approval gate, same live trail).
- [x] All four leaf paths write to `_ai/trail/anthropic/*` (single subsystem).
- [x] All four leaf paths honour the ANTHROPIC/LLM panel's live trail, tool approval (coerced to `'never'` for queue runs), and user-message template rules.
- [x] The Anthropic handler carries pre-prompt context into the main prompt automatically via `rawTurns` / Agent SDK session — no queue-level chaining code needed.
- [x] The VS Code LM model is stored as `{vendor, family, modelId}` on the configuration; sends do NOT enumerate available models.
- [x] The ANTHROPIC/LLM panel has Save to Queue and Queue next buttons (default run and panel target) and the Open Prompt Queue button.
- [x] The ANTHROPIC/LLM panel's Available models overlay is informational and does NOT retarget sends.
- [x] Queue-dispatched items run with `toolApprovalMode = 'never'`.
- [x] The queue editor's run defaults row has Model, Session and Template.
- [x] The queue editor's configuration pick lists Anthropic configurations AND Local LLM configurations, each labelled by backing type.
- [x] Every send takes its template from the one store (Anthropic — User Message in the template editor; the four template tools work on it).
- [x] The Add form shows the auto-approve-all warning.
- [x] `tomAi_addQueueItem`, `tomAi_updateQueueItem`, `tomAi_addQueuePrePrompt`, `tomAi_updateQueuePrePrompt`, `tomAi_addQueueFollowUp`, `tomAi_updateQueueFollowUp` ([prompt-queue-tools.ts](../src/tools/prompt-queue-tools.ts)) accept `transport` (`anthropic` only, may be left out), `anthropicProfileId`, `anthropicConfigId`.
- [x] `tomAi_listQueue` returns the fields in its output.
- [x] `tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate` ([prompt-template-tools.ts](../src/tools/prompt-template-tools.ts)) work on the one store and take no transport.
- [x] A queue item with a stale/invalid `anthropicProfileId` or `anthropicConfigId` surfaces a clear error (shared `resolveAnthropicTargets` helper).
