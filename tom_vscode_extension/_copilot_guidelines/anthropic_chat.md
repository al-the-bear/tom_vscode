# Anthropic Chat Panel

The **ANTHROPIC/LLM** subpanel (its section id, config keys, trail subsystem, history file names and tool names keep `anthropic`) is one of the two chat subpanels in `@CHAT` (with Copilot) and the primary interactive surface for Anthropic-based AI interactions, Local LLM configurations included. Both subpanels have queue buttons. Source: [chatPanel-handler.ts](../src/handlers/chatPanel-handler.ts) — Anthropic section at approximately `:3300`.

For the underlying handler, see [../doc/anthropic_handler.md](../doc/anthropic_handler.md) and [architecture.md](architecture.md).

## What makes the ANTHROPIC/LLM panel distinctive

The ANTHROPIC/LLM panel exposes:

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

**Effect:** the Anthropic handler's full loop, tool-approval gate, live trail, user-message templates, and raw trail (the session's `history/sessions/<session>/trail/`) all apply — even though the actual API call goes to Ollama.

The profile config picker in the panel's UI merges both Anthropic configurations and Local LLM configurations, each labelled by backing type (`[direct]`, `[agentSdk]`, `[vscodeLm]`, `[localLlm]`).

## VS Code LM API configurations

When a configuration has `transport: 'vscodeLm'`, the handler calls `vscode.lm.selectChatModels()` to route through VS Code's Language Model API (e.g., GitHub Copilot's GPT-4o or claude-sonnet-4.5 seats, or any registered LM provider).

**Key design decisions:**

- **Model is pinned at configure-time**, not per send. When creating or editing a `vscodeLm` configuration, the Extension State Page's model picker calls `vscode.lm.selectChatModels()` once, the user picks a model, and `{vendor, family, modelId}` are stored on the configuration. On subsequent sends the handler filters against VS Code's cached list by `modelId` — no fresh enumeration.
- **System prompt concatenation.** VS Code LM has no separate system/user fields. The handler prepends `{systemPrompt}\n\n` to the composed user message before calling `model.sendRequest`.
- **Informational model dropdown on the panel.** When the active configuration is `vscodeLm`, the ANTHROPIC/LLM panel's bottom area shows a dropdown listing currently available models from `vscode.lm.selectChatModels()`, plus a **Refresh** button. This is read-only — changing the selection here does NOT retarget sends. To change the target model, edit the configuration.
- **Trail directory** is the same as other Anthropic configs: the session's `history/sessions/<session>/trail/`.

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

There is **one template store**: `config.anthropic.userMessageTemplates` — an array of `{ id, name, description?, template, isDefault? }`. The ANTHROPIC/LLM panel, every Anthropic leaf path (VS Code LM and Local-LLM-backed profiles included) and Copilot sends all read it.

- `isDefault: true` marks the template auto-applied on every send (profile-scoped default).
- Templates support placeholder expansion: `${tomAi.quest}`, `${tomAi.role}`, chat variables, `${memory}`, etc.
- The Global Template Editor's **Category** dropdown routes to the Anthropic — User Message store when selected. The template tools (`tomAi_createPromptTemplate`, etc.) work on it, keyed by `id`.

## Live trail

Each `sendMessage()` call creates a `LiveTrailWriter` pointed at the session's live trail, `_ai/quests/<quest>/history/sessions/<session>/live-trail.md` (`chat` for the panel, `default` for the queue, else the named session). The writer:

- Calls `beginPrompt()` once — trims the file to the last 5 prompt blocks and writes the new `## 🚀 PROMPT …` header.
- Appends thinking, tool calls, tool results, and assistant text incrementally as the turn runs.
- Calls `endPrompt()` with round/tool-call count and duration on completion.

The **Open Live Trail** button in the panel header fires `tomAi.openInMdBrowserLive`, which opens the panel's session's `live-trail.md` in the MD Browser's live-mode singleton (auto-scroll-to-bottom on each file-watcher update).

Isolated sub-agent runs (`options.isolated = true`) receive a null writer — their intermediate work does not appear in the quest's live trail.

## Queue integration

The ANTHROPIC/LLM panel has two queue buttons (matching the Copilot panel):

- **Add to Queue** (`data-action="addToQueue" data-id="anthropic"`) — stages a new `QueuedPrompt` with `transport: 'anthropic'`, `anthropicProfileId`, and `anthropicConfigId` pre-filled from the panel's current dropdowns.
- **Open Queue Editor** (`data-action="openQueueEditor"`) — opens the queue editor webview.

Items staged from the ANTHROPIC/LLM panel **always pin their transport** (`transport: 'anthropic'`); they never inherit the queue default. Queue dispatch coerces `toolApprovalMode = 'never'` for all Anthropic items regardless of the profile's stored value.

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

## The panel's session

The panel sends in a named session (`<name>.session.json` in the quest's `history/`): the one picked for the quest with the session button, else its own `chat`.

- **The button** reads like the queue's context-bar session link: the session's name, `based on <base>` when it has one, the lifetime when not `continue` (`(per prompt)`, `(per iteration)`) and the model when it has a profile, e.g. `walk based on prep (per iteration) · claude-opus-5-5`. `_sendChatSession` builds it with `sessionLabel` (`src/utils/sessionPickerPlan.ts`).
- **The picker** (`pickAgentSdkSession`, `src/handlers/sessionPicker.ts`, shared with the queue's context bar, queue items and the process action page) lists the sessions with base, lifetime and model. **New session…** and **New session based on…** ask for the lifetime (one conversation, new for every prompt, new for every queue iteration — worded for with and without a base) and then for the profile: *No profile*, *As the base (<profile>)* for a based session whose base has one, or a profile as the panel lists it (`(no API key)` marks included), stored with its model. The `.session.json` is written at once, so the session shows everywhere; its conversation starts on first use. The choices are planned by the pure `lifetimeChoices` / `profileChoices` / `newSessionOptions`.
- **Profile.** Picking a session with a profile preselects that profile in the panel's profile select; the panel's selection is what a send uses (item → session → queue default: the panel's profile is the item's own). A send whose profile keeps its conversation elsewhere than the session's existing one (an Agent SDK session continued by a profile with our own history, or the reverse) is refused with the reason (`sessionTransportMismatch`).
- **Actions on the session storage ask for the sessions.** Recreate history and Recreate memory open the session selection (`src/handlers/sessionSelectionPicker.ts`, rules in `src/utils/sessionSelection.ts`): a multi-select of the quest's sessions with **All sessions** on top and the panel's session preselected; the two Recreates then confirm, naming the sessions. Clearing (from the Logs panel) reports back with `anthropicHistoryCleared` `{sessions, panelSession}`, and the webview resets its counters only when the panel's session was among them.
- **Save to Queue** queues the prompt with nothing pinned, so it runs with the prompt queue's default profile and session; **Save to Queue with the panel's target** (`addToQueuePanelTarget`, `usePanelTarget`) pins the panel's profile and session (the picked one, else `chat`). **Queue next** (`addToQueueNext`, `next: true`) goes through `PromptQueueManager.enqueueNext`: pending, at `nextQueuePosition`, nothing pinned, marked to go between the iterations of a running loop above it. The host answers every queue add with `queueAdded {count, section, slot}`. **Keep** (`anthropic-keep-slot`) is per prompt slot: `sectionSlotState.anthropic.keep` (`{"1".."9": boolean}`, a slot without an entry keeps), saved and loaded as the drafts' `slotKeep` (`chatDraftService.normalizeSlotKeep`); an unkept slot is cleared after Send and when `queueAdded` names it (CB-6, CB-7, DK-1–2). **Send** runs in the picked session; `runAnthropicSend` (editor command, todo panel, Telegram, scripts) always in `chat`.
- **Chat sends are shown in the prompt queue** (`trackChatSend`, `src/handlers/chatQueueTracking.ts`; rules `src/utils/chatQueueItems.ts`): an item with status `chat` while the send runs and `chat-sent` with its answer or error after it. No queue path selects these statuses, so the queue never sends, retries or counts them; *Clear sent* and the sent-history trim include `chat-sent`. Each item records its window (`chatWindowId`); a `chat` item is settled as `chat-sent` with a note when its window is gone (startup) or when the same window starts another chat send. The queue editor renders them read-only (`renderChatEntry`, media/shared/queueEntryRenderFunctions.js) like a sent item: the header (time, source, profile, session, usage), the error chip, the complete prompt as `mainprompt-content`, the answer through `renderAnswerBlock` (600 characters, the toggle, the two Markdown buttons) once it arrived (CB-3, CB-8). Tests: `chatQueueItems.test.ts` CQ-1–5, `chatSendsAndQueueButtons.dom.test.ts` CB-1–5.
- **Busy sessions** (`src/utils/sessionBusy.ts`, `src/handlers/busySessionChoice.ts`): a session is held by a `sending` queue item on the Anthropic transport (its resolved session) or a `chat` item whose send is alive (this window's: `isChatSendActive`; another window's: its heartbeat) — `PromptQueueManager.sessionHolder`. Before a chat send (the panel's Send, `runAnthropicSend`) `resolveBusySession` asks: free → send; busy → a quick pick of **Send now as an update to the running prompt** first when the session's prompt is a running Agent SDK query (`canUpdateRunningPrompt`: the transport registers each query's `QueryInputChannel` under its `liveInputSession` in `services/agentSdkLiveInputs.ts`; `sendAsUpdate` pushes the text — another user message of the stream, answered by the result naming its uuid — and lists it through `trackChatSend` with source `update`, ending with that answer), **Run next** (`enqueueNext`: under the running item, `sendBetween` on a loop), **Run after the current item** (`enqueueAfterCurrent`), **Send now in session Y** for each free one (`freeSessions` over `chat`, `default` and the quest's sessions; none while the caller's send slot is taken, `canSendElsewhere: false`); dismissed → not sent (`anthropicNotSent`, the text stays; the panel clears an unkept slot only on `anthropicSendStarted` or a queued `anthropicNotSent`); Telegram and scripts are refused. The panel's Send stays enabled while a panel send runs; the host's replies to a second Send carry `panelBusy`, which keeps the webview's running state. `settleRunningChatItems` settles this window's other `chat` items only when their send no longer runs (`isActive`: a send and its updates run at once). The queue holds an item whose session a chat send holds (`sendItem` → `chatHoldingSessionOf`; the editor shows `waitingForSession`) and `completeChatItem` starts the queue again. `trackChatSend` races the send against the queue's response timeout (`chatTimeoutError`) and against removal of its entry (`abandonChatSend`, called by `remove`), running the send's cancel either way, so its `finally` frees the chat send slot. Tests: BS-1 – BS-6, SY-1 – SY-2, CQ-2, CB-7, CB-9, CB-10, UP-1 – UP-5.
- **The session actions live in the @WS Logs panel** (raw trail, trail summary, history, live trail, memory, clear): `runChatSessionAction(action, session)` → the provider's `runSessionAction`, for the session selected there (the trail summary opens that session's summary trail without a picker, the memory panel opens on it: `tomAi.panel.memory <session>`); Clear asks with a modal.

## Tool approval

The profile's `toolApprovalMode` controls whether tool calls are routed through the in-panel approval bar (`'always'`), lets the file edits through and routes the other writers there (`'acceptEdits'`), or auto-approves silently (`'never'`). Queue runs always use `'never'` regardless of the profile setting.

The approval gate is part of the Anthropic handler's shared loop and applies to all four leaf paths (Direct, Agent SDK, VS Code LM, Local LLM).

A request must be seen: `ChatPanelViewProvider` listens to `onApprovalNeeded` from its construction (not from its first send) and hands each request to an `ApprovalRelay` (`src/utils/approvalRelay.ts`), which reveals the @CHAT view (`view.show(true)`, or `tomAi.chatPanel.focus` when the view was never resolved) and posts the request once the webview reports `approvalUiReady`, re-posting the open ones when the webview restarts. The webview (`media/chatPanel/main.js`) expands the ANTHROPIC/LLM subpanel, queues requests and answers them one at a time, and drops one the handler reports settled (`onApprovalSettled` → `anthropicToolApprovalSettled`). Tests: `approvalRelay.test.ts` (AR-1..3), `chatPanelApproval.dom.test.ts` (CA-1..4).

## Plan mode

Plan mode (`src/tools/planning-tools.ts`) is one flag per window that gates writes on every transport: `planModeRefusalFor` is the rule, checked in the handler's `runTool` (direct, Local LLM, VS Code LM), in the Agent SDK's `canUseTool` and MCP tool handlers (`planModeGated`), and through the SDK's `plan` permission mode (set at the start of a send, followed with `setPermissionMode` via `onPlanModeChanged`). The panel shows it: `ChatPanelViewProvider` registers the plan decider (`registerPlanDecider`) and follows the flag. The webview gets `planMode {active}` (the badge; its **Leave plan mode** posts `leavePlanMode` → `leavePlanModeByUser`) and `planProposal {id, html}` (the plan rendered by `renderQuestLogMarkdown`; **Accept** / **Keep planning** post `planDecision {id, accepted, feedback}`). Leaving with the badge settles waiting proposals as accepted (`planProposalSettled`). Both are re-sent on `approvalUiReady`. Without a ready panel, `_decidePlan` asks in a modal dialog.

## Output channels

- **Tom AI** — assistant text + tool summaries for the ANTHROPIC/LLM panel's turns.
- **Tom AI Log** — debug / timing details.
- Raw trail: `_ai/quests/<quest>/history/sessions/<session>/trail/` (gitignored, one per session).

## Operational notes for agents

- `resolveAnthropicTargets(profileId, configId)` in `src/utils/resolveAnthropicTargets.ts` is the single resolver for `(profile, configuration)` pairs. Use it instead of duplicating the Anthropic-then-LocalLlm fallback chain.
- When adding a new Anthropic leaf path, plug it into `AnthropicHandler.sendMessage()` as a fourth leaf primitive (join the shared agent loop).
- Both `vscodeLm` and Local-LLM-backed configs are **Anthropic-profile-level** concerns. They write to the session's trail (`history/sessions/<session>/trail/`) and use Anthropic user-message templates — do not create separate subsystems.
- The VS Code LM model dropdown on the panel is **informational only** — do not wire it to retarget sends.
