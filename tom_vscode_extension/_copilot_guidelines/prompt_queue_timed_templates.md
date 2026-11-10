# Prompt Queue, Timed Requests, and Queue Template Editor

Three interrelated features for automating and scheduling AI prompts:

| Feature | Handler / Manager | UI entry |
|---------|-------------------|----------|
| Prompt Queue | [promptQueueManager.ts](../src/managers/promptQueueManager.ts) + [queueEditor-handler.ts](../src/handlers/queueEditor-handler.ts) | `@CHAT` Copilot / ANTHROPIC/LLM panel → "Add to Queue" / "Open Queue Editor" |
| Timed Requests | [timerEngine.ts](../src/managers/timerEngine.ts) + dedicated panel in `@WS` | Timed Requests tab in `@WS` |
| Queue Template Editor | [queueTemplateEditor-handler.ts](../src/handlers/queueTemplateEditor-handler.ts) | Command `tomAi.openQueueTemplateEditor` |

---

## 1. Prompt Queue

### Overview

The queue is a **strictly sequential, ordered list** of `QueuedPrompt` items. One item is `'sending'` at a time; the next `'pending'` item only starts once the current one reaches `'sent'` or `'error'`. Items can interleave Copilot and Anthropic transports within the same queue.

### Storage

Each item is a separate YAML file in the queue folder — `_ai/queue/` by default, or the folder the `tomAi.queueFolder` setting names: `<hostname>_<workspace>_<yymmdd_hhmmss>_<quest>.<type>.entry.queue.yaml` (the host and workspace prefix keeps windows and machines from colliding). Queue settings live in `queue-settings.yaml` in the same folder. Managed by `queueFileStorage.ts` via VS Code `FileSystemWatcher`; changes propagate across windows in real time.

**Important:** `_reloadFromDisk()` is debounced (300 ms) and skips entirely while any item has `status === 'sending'`. This prevents the watcher from replacing in-memory item references during an async Anthropic dispatch (which would stall the queue permanently).

### Item lifecycle

```
staged → pending → sending → sent
                            → error
```

- `staged` — item exists but is not yet in the active run (held by the user).
- `pending` — queued and waiting for the item ahead to finish.
- `sending` — currently dispatching (may be polling for Copilot or awaiting the Anthropic API). Shown as **`SENDING (PAUSED)`** in the editor when the item is mid-flight but auto-send was turned off (see pause/resume below).
- `sent` — all stages complete; `answerText` set for Anthropic items.
- `error` — dispatch failed; `error` field holds the message; **auto-send is flipped off** so the failure doesn't cascade into the following pending items.

### Pause / resume and error handling

The queue preserves the in-flight cursor (`repeatIndex` per stage,
`followUpIndex`) across pauses, errors, and window reloads, so it always
resumes from the interrupted repetition rather than restarting the item or
skipping a rep.

- **Pause finishes the current rep, then holds.** Turning auto-send off lets the
  in-flight repetition complete (`DispatchOutcome = 'dispatched' | 'done' | 'paused'`);
  the item stays `'sending'` with its counters intact and the editor shows
  `SENDING (PAUSED)`. The first dispatch of an item is always allowed even with
  auto-send off, so an explicit "Send" is never blocked.
- **Resume** continues from the persisted cursor — re-enabling auto-send
  re-enters the paused item before starting the next one.
- **Error → auto-send off.** A failed dispatch stamps `error` (plus an optional
  classified `warning`), leaves the item at the front, and disables auto-send
  unconditionally (rate-limit / quota / overload failures almost always recur).
  The per-item **"Resend"** button is replaced by **"Set to Pending"** while
  errored.
- **Resend** replays the errored rep's frozen text without touching counters;
  **"Set to Pending"** resets to `'pending'` and rolls the interrupted-stage
  counter back by one so the retry re-runs that exact rep; **"Retry All Errors"**
  re-enables auto-send before draining.

Full mechanics (pure helpers `itemHasInFlightProgress` / `applyErrorTransition` /
`applyResetToPending` in `queueErrorTransitions.ts`, the `_markItemError` /
`_resumePausedSendingItem` / `resendLastPrompt` manager hooks, and the
`move(id, 'front')` "Send next" affordance) are documented in
[multi_transport_prompt_queue_revised.md §4.18](../doc/multi_transport_prompt_queue_revised.md).

### Transports

Two transports per item (and per pre-prompt / follow-up stage):

#### Copilot transport

1. `_buildExpandedText()` applies the named template (from the one store, `anthropic.userMessageTemplates`) and wraps the text in the Copilot Queue Wrapper (`copilot.queueWrapper`, default built in), unless the item sets `answerWrapper: false`.
2. `dispatchStage()` extracts `expectedRequestId`, calls `workbench.action.chat.open`, returns `{ mode: 'polled', expectedRequestId }`.
3. `pollForExpectedAnswer()` watches `_ai/answers/copilot/` for a file whose `requestId` matches. Polling interval: 30 s. Background watchdog: 60 s.
4. Additional Copilot-only features: `reminderEnabled` (ReminderSystem generates follow-up prompts after a timeout), `answerWaitMinutes` (auto-advance after N minutes without an answer).

#### Anthropic transport

1. `_buildExpandedText()` applies the named template; **no** answer-wrapper injection.
2. `dispatchStage()` resolves `(profile, configuration)` via `resolveAnthropicTargets`, coerces `toolApprovalMode = 'never'`, calls `AnthropicHandler.instance.sendMessage()`, returns `{ mode: 'direct', answerText }`.
3. `sendItem()` stores `answerText` on the item, calls `sendNext()` synchronously — no polling.
4. Reminders, `answerWaitMinutes`, and the answer-file polling loop are **all skipped**.

**Pre-prompt context propagation (Anthropic).** The Anthropic handler appends each turn to `rawTurns` / `compactedSummary` within the handler's session state. A pre-prompt's answer is therefore automatically visible to the main prompt without any queue-level stitching — the user writes them as natural consecutive prompts.

### Stage resolution — three tiers

For every stage (pre-prompt / main / follow-up), transport resolves as:

```
stage.transport  →  item.transport  →  queue defaultTransport  →  'copilot'
```

`dispatchStage()` inside `promptQueueManager.ts` applies this chain before dispatching.

### Queue YAML fields

Per-item (and per-stage) fields:

```yaml
# Copilot
transport: copilot
template: my-template-name
answer-wrapper: true
repeat-count: 3
answer-wait-minutes: 10
reminder-enabled: true
reminder-template-id: my-reminder

# Anthropic  
transport: anthropic
anthropic-profile-id: software-engineer
anthropic-config-id: claude-sonnet-46   # Anthropic OR Local LLM config id
answer-text: "…captured response…"      # written by dispatcher on success
```

Queue-level defaults in `queue-settings.yaml`:

```yaml
default-transport: anthropic
default-anthropic-profile-id: software-engineer
default-anthropic-config-id: claude-sonnet-46
```

All fields are additive-optional (no migration required for existing queues).

### Queue editor (`queueEditor-handler.ts`)

The queue editor webview (opened via "Open Queue Editor") provides:

**Header row — queue defaults.** A transport picker showing the queue's default transport, profile, and config. Changing these updates `queue-settings.yaml`.

**Per-item rows.** Each item shows:
- Status badge, prompt preview, repeat count, template name.
- A **gear icon** → three-step VS Code QuickPick: transport (Copilot / Anthropic / Inherit) → profile → config. Selecting "Inherit" clears the item's transport fields so it falls through to the queue default.
- Reminder + answer-wait controls, **disabled with tooltip** when transport is `'anthropic'` (those are Copilot-only).
- Answer text preview (truncated + expand button) when `answerText` is present, with the two markdown preview buttons (`.qe-md-btn`: the overlay of `media/shared/mdOverlay.js` after the host's `renderMarkdown`, or `openMarkdownPreview` in the editor area).

**Per-stage overrides.** Pre-prompt and follow-up rows each have their own gear icon → same QuickPick with "Inherit from item" as the inherit option.

**Auto-approve warning.** When the user picks Anthropic at any tier, a notice renders below the transport picker:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored. The queue cannot pause for the approval bar.

**Template dropdown.** Lists the one template store (the user-message templates) for either transport. Changing transport clears the template selection.

**Add form.** New items inherit transport from the queue default unless the user overrides in the form's own transport picker.

### `renderTransportPicker` component

Utility at [src/utils/transportPicker.ts](../src/utils/transportPicker.ts). Renders an HTML fragment with transport dropdown + conditional profile/config dropdowns and the auto-approve warning. Used by the queue editor's header row and Add form. Per-item / per-stage overrides use the QuickPick flow instead (keeps item rows compact).

| Context | Options | Inherit option? |
|---------|---------|----------------|
| `queue-default` | Copilot, Anthropic | No |
| `queue-item` | Inherit (queue default), Copilot, Anthropic | Yes |
| `queue-stage` | Inherit (item), Copilot, Anthropic | Yes |
| `template-editor` | Copilot, Anthropic | No |

### Tool surface

Queue MCP tools for AI agents:

| Tool | Purpose |
|------|---------|
| `tomAi_addQueueItem` | Stage a main prompt |
| `tomAi_updateQueueItem` | Patch fields of an existing item |
| `tomAi_removeQueueItem` | Delete an item |
| `tomAi_addQueuePrePrompt` | Add a pre-prompt stage |
| `tomAi_updateQueuePrePrompt` | Patch a pre-prompt |
| `tomAi_removeQueuePrePrompt` | Delete a pre-prompt |
| `tomAi_addQueueFollowUp` | Add a follow-up stage |
| `tomAi_updateQueueFollowUp` | Patch a follow-up |
| `tomAi_removeQueueFollowUp` | Delete a follow-up |
| `tomAi_listQueue` | List all items with full fields |
| `tomAi_setQueueItemStatus` | Force-set item status |
| `tomAi_sendQueuedPrompt` | Force-send a specific item |
| `tomAi_addQueueFollowUp` | Add follow-up to existing item |

Add/update tools accept `transport`, `anthropicProfileId`, `anthropicConfigId` fields. `tomAi_listQueue` returns them.

---

## 2. Timed Requests

### Overview

The **Timed Requests** panel (in `@WS`) manages `TimedRequest` entries that fire prompts on a schedule. The `TimerEngine` (singleton, `src/managers/timerEngine.ts`) checks entries every 30 s and dispatches due items.

### `TimedRequest` schema

```ts
interface TimedRequest {
    id: string;
    originalText: string;        // the prompt text to send
    templateId?: string;         // expand via a template (the one store) before sending
    questId?: string;            // target quest context
    scheduleMode: 'interval' | 'scheduled';
    intervalMinutes?: number;    // used when mode === 'interval'
    scheduledTimes?: ScheduledTime[];  // used when mode === 'scheduled'
    sendMaximum?: number;        // auto-pause after N sends (interval mode)
    sentCount: number;           // incremented on each fire
    lastSentAt?: string;         // ISO timestamp of last fire
    status: 'active' | 'paused' | 'completed';
}
```

### Schedule modes

**Interval mode.** Fires every `intervalMinutes` minutes after `lastSentAt`. Auto-pauses when `sentCount >= sendMaximum` (if set). Useful for periodic check-ins or status polls.

**Scheduled mode.** Fires at specific `ScheduledTime` slots. Each slot has a `time` (`HH:MM`), an optional `date` (`YYYY-MM-DD`) and optional `weekdays` (0 = Sunday … 6 = Saturday; absent or empty means every day). A slot without a date fires daily at its time on the days its weekdays allow; a slot with a date is a one-shot that fires on that date only. When every slot of an entry is dated and all of them have passed, the entry completes.

### Dispatch

A due timed request is enqueued into the prompt queue as a `pending` item of type `timed` and runs there with the queue's default transport (an entry carries no transport of its own). Its `template` is the entry's template (the one store, `config.anthropic.userMessageTemplates`; `(None)` without one), applied to `originalText` like any item's. The item names its entry in `timedEntryId` (entry file meta: `type: timed`, `timed-entry-id`; `src/utils/timedQueueItems.ts`): the engine skips an entry that still has a staged, pending or sending item, and pausing an entry removes its staged and pending items. An entry file of an earlier build, which marked the item by the template `timed:<entry id>`, reads as a timed item of that entry with no template.

### Persistence

Stored in the panel storage folder (`_ai/local/`) as `<hostname>_<workspace>.timed.yaml`, alongside a `timerActivated` flag and optional `schedule` slots (global schedule overrides). Managed by `panelYamlStore.ts`.

### Tool surface

| Tool | Purpose |
|------|---------|
| `tomAi_listTimedRequests` | List all timed requests |
| `tomAi_addTimedRequest` | Create a new entry |
| `tomAi_updateTimedRequest` | Patch an existing entry |
| `tomAi_removeTimedRequest` | Delete an entry |
| `tomAi_setTimerEngineState` | Enable or disable the timer engine globally |

---

## 3. Queue Template Editor

### Overview

The Queue Template Editor (`tomAi.openQueueTemplateEditor`) is a webview panel for managing **queue templates** — pre-filled `QueuedPrompt` YAML documents saved as `*.template.queue.yaml` files. Templates are the starting point for recurring workflows: the user picks a template, optionally edits the prompt text, and clicks **Queue Prompt** to copy the template into the live queue.

Source: [queueTemplateEditor-handler.ts](../src/handlers/queueTemplateEditor-handler.ts).

### Layout

```
┌────────────────┬────────────────────────────────────┐
│  Template list │  Queue item editor (right panel)   │
│  [+ copy ✎ ⊞ 🗑]│  ┌─ prompt text ─────────────────┐ │
│  > Template A  │  │ (editable)                    │ │
│    Template B  │  └───────────────────────────────┘ │
│    …           │  [bottom bar: Queue Prompt | Save] │
└────────────────┴────────────────────────────────────┘
```

- **Left sidebar** — list of templates. Toolbar: New, Copy, Rename, Open YAML, Delete.
- **Right panel** — shared queue-entry editor (same component as the queue editor's item form). All fields are editable: transport, profile, config, main prompt, pre-prompts, follow-ups, templates, reminders, repeat count, etc.
- **Bottom bar** — **Queue Prompt** copies the template (with the current prompt text filled in) into the live queue as a new `staged` item. **Save** persists edits back to the template file.

### Template files

Stored in the queue folder (`_ai/queue/` by default, `tomAi.queueFolder`) as `<name>.template.queue.yaml`. Format is the same as a live queue entry YAML (`QueueFileYaml`), plus a `meta` section:

```yaml
meta:
  name: My Template Name
  description: Optional description
prompt:
  template: my-copilot-template
  transport: anthropic
  anthropic-profile-id: software-engineer
  anthropic-config-id: claude-sonnet-46
  pre-prompts:
    - text: "Context setup step"
  follow-ups:
    - text: "Verification step"
```

### Transport on templates

Templates carry the same transport fields as live queue items. When the template is queued, the transport settings are copied verbatim. The `renderTransportPicker` is wired in the template editor's Add/edit form via the `template-editor` context (no inherit option — templates always specify their own transport or leave it unset to default to `'copilot'`).

In practice, the **Global Template Editor** (Category dropdown, separate from the queue template editor) covers the Copilot and Anthropic user-message template stores. The Queue Template Editor is about queue-level workflow templates (full queue entry structure), not about text-transformation templates.

### Operational notes

- When a template's transport is changed, the template editor clears the template-name selection and repopulates from the new transport's store (same rule as the live queue editor).
- The `queueTransport` from the template's settings is stamped onto every pre-prompt and follow-up when opening a template in the editor, so transport is consistently visible at the stage level.
- Templates can encode complex multi-stage workflows (many pre-prompts + follow-ups) for one-click queuing of repeated processes.
