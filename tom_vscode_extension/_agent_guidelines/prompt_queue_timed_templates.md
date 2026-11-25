# Prompt Queue, Timed Requests, and Queue Template Editor

Three interrelated features for automating and scheduling AI prompts:

| Feature | Handler / Manager | UI entry |
|---------|-------------------|----------|
| Prompt Queue | [promptQueueManager.ts](../src/managers/promptQueueManager.ts) + [queueEditor-handler.ts](../src/handlers/queueEditor-handler.ts) | `@CHAT` ANTHROPIC/LLM panel → "Add to Queue" / "Open Queue Editor" |
| Timed Requests | [timerEngine.ts](../src/managers/timerEngine.ts) + dedicated panel in `@WS` | Timed Requests tab in `@WS` |
| Queue Template Editor | [queueTemplateEditor-handler.ts](../src/handlers/queueTemplateEditor-handler.ts) | Command `tomAi.openQueueTemplateEditor` |

---

## 1. Prompt Queue

### Overview

The queue is a **strictly sequential, ordered list** of `QueuedPrompt` items. One item is `'sending'` at a time; the next `'pending'` item only starts once the current one reaches `'sent'` or `'error'`. Every item is sent through the Anthropic handler, with the profile it resolves to.

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
- `sending` — currently dispatching (awaiting the Anthropic handler). Shown as **`SENDING <KIND> (PAUSED)`** in the editor (status and kind in one label, e.g. `SENDING TODO (PAUSED)`) when the item is mid-flight but auto-send was turned off (see pause/resume below).
- `sent` — all stages complete; `answerText` holds the answer.
- `error` — dispatch failed; `error` field holds the message; **auto-send is flipped off** so the failure doesn't cascade into the following pending items.

### Pause / resume and error handling

The queue preserves the in-flight cursor (`repeatIndex` per stage,
`followUpIndex`) across pauses, errors, and window reloads, so it always
resumes from the interrupted repetition rather than restarting the item or
skipping a rep.

- **Pause finishes the current rep, then holds.** Turning auto-send off lets the
  in-flight repetition complete (`DispatchOutcome = 'done' | 'paused'`);
  the item stays `'sending'` with its counters intact and the editor shows
  `SENDING <KIND> (PAUSED)`. The first dispatch of an item is always allowed even with
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

### Transport

Every item, pre-prompt and follow-up stage is sent through the Anthropic handler (`transport: 'anthropic'`); which API runs — direct, Agent SDK, VS Code LM or a Local LLM — follows from the configuration of the profile the stage resolves to.

1. `_buildExpandedText()` applies the named template (from the one store, `anthropic.userMessageTemplates`).
2. `dispatchStage()` resolves `(profile, configuration)` via `resolveAnthropicTargets`, coerces `toolApprovalMode = 'never'`, calls `AnthropicHandler.instance.sendMessage()` and awaits the answer text.
3. The answer is stored as `answerText` on the item (or on the stage), and the dispatch loop goes on with the next stage; a dispatch always completes inline.

**Pre-prompt context propagation.** The Anthropic handler appends each turn to `rawTurns` / `compactedSummary` within the handler's session state. A pre-prompt's answer is therefore automatically visible to the main prompt without any queue-level stitching — the user writes them as natural consecutive prompts.

### Stage resolution — three tiers

For every stage (pre-prompt / main / follow-up), the profile resolves as:

```
stage profile  →  item profile  →  session's profile  →  the run's default profile
```

and the configuration as the stage's, else the item's, else the run's default configuration, else the profile's own. `resolveStageTransport()` inside `promptQueueManager.ts` applies this chain before `dispatchStage()` sends.

### Queue YAML fields

Per-item (and per-stage) fields:

```yaml
transport: anthropic
template: my-template-name
repeat-count: 3
anthropic-profile-id: software-engineer
anthropic-config-id: claude-sonnet-46   # Anthropic OR Local LLM config id
answer-text: "…captured response…"      # written by dispatcher on success
```

A run's defaults in `queue-settings.yaml`:

```yaml
default-anthropic-profile-id: software-engineer
default-anthropic-config-id: claude-sonnet-46
```

All fields are optional.

### Queue editor (`queueEditor-handler.ts`)

The queue editor webview (opened via "Open Queue Editor") provides:

**Header row — the run's defaults.** A context bar showing the defaults the run's items take: Model (the Anthropic profile), Session and Template. Each value is a link that opens a VS Code picker; a change updates `queue-settings.yaml`.

**Per-item rows.** Each item shows:
- Status badge, prompt preview, repeat count, template name.
- Its profile: a chip with the profile's name when it has one of its own, else an icon button naming the profile it runs with; a click opens the profile picker.
- A **gear icon** (staged items) → VS Code QuickPick: profile (or "Inherit (queue default)") → configuration → session. Selecting "Inherit" clears the item's profile and configuration so it falls through to the run's default.
- Answer text preview (truncated + expand button) when `answerText` is present, with the two markdown preview buttons (`.qe-md-btn`: the overlay of `media/shared/mdOverlay.js` after the host's `renderMarkdown`, or `openMarkdownPreview` in the editor area).

**Per-stage overrides.** Pre-prompt and follow-up rows each have their own gear icon → the same profile → configuration QuickPick with "Inherit from item" as the inherit option.

**Auto-approve warning.** The Add form carries a notice beside its Profile select:

> ⚠️ Queue runs auto-approve every tool call — the profile's approval setting is ignored.

**Template dropdown.** Lists the one template store (the user-message templates).

**Recent Prompts.** The history icon of the first context bar posts `openRecentPrompts`; the host opens the Recent Prompts panel (`recentPromptsPanel-handler.ts`, `tomAi.editor.recentPrompts`, page `media/recentPromptsPanel/`). It shows the last 100 prompts of the quest's queue from the items the manager holds (the sent history included): `utils/recentPrompts.ts` counts pre-prompts and follow-ups by their `repeatIndex`, the main stage per iteration (`walkedTodos` / `repetitionAnswers` keys for a walk, `iterationSeq` / `repeatIndex` for a repetition) with a walk iteration's continuations (`repetitionAnswers[].continuations`, answers from `earlier`), and a chat send as one prompt. Only `lastDispatched` holds an expanded text; the other prompts show the text as queued. Rows newest first by the last dispatch; the row crossing the limit keeps its newest prompts. The page redraws on `onDidChange` (debounced) and keeps its expansions in the webview state; Markdown goes through the host's `renderMarkdown` → `markdownHtml` into `media/shared/mdOverlay.js`.

**Add form.** A **Profile** select: a profile for the new item, or `(default profile)` — the default profile of its run.

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

Add/update tools accept `anthropicProfileId` and `anthropicConfigId` (`transport` accepts only `anthropic` and may be left out). `tomAi_listQueue` returns them.

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

A due timed request is enqueued into the prompt queue as a `pending` item of type `timed` and runs there with the queue's default profile (an entry carries no profile of its own). Its `template` is the entry's template (the one store, `config.anthropic.userMessageTemplates`; `(None)` without one), applied to `originalText` like any item's. The item names its entry in `timedEntryId` (entry file meta: `type: timed`, `timed-entry-id`; `src/utils/timedQueueItems.ts`): the engine skips an entry that still has a staged, pending or sending item, and pausing an entry removes its staged and pending items. An entry file of an earlier build, which marked the item by the template `timed:<entry id>`, reads as a timed item of that entry with no template.

### Persistence

Stored in the panel storage folder (`_ai/local/` by default, or the folder the `tomAi.panelStoragePath` setting names) as `<hostname>_<workspace>.timed.yaml`, alongside a `timerActivated` flag and optional `schedule` slots (global schedule overrides), with `$schema` pointing at `.tom/json-schema/panels/timed.schema.json` relative to that folder. Managed by `panelYamlStore.ts`.

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
- **Right panel** — shared queue-entry editor (same component as the queue editor's item form). The main prompt, pre-prompts, follow-ups and repeat count are editable.
- **Bottom bar** — **Queue Prompt** copies the template (with the current prompt text filled in) into the live queue as a new `staged` item. **Save** persists edits back to the template file.

### Template files

Stored in the queue folder (`_ai/queue/` by default, `tomAi.queueFolder`) as `<name>.template.queue.yaml`. Format is the same as a live queue entry YAML (`QueueFileYaml`), plus a `meta` section:

```yaml
meta:
  name: My Template Name
  description: Optional description
prompt:
  template: my-template
  transport: anthropic
  anthropic-profile-id: software-engineer
  anthropic-config-id: claude-sonnet-46
  pre-prompts:
    - text: "Context setup step"
  follow-ups:
    - text: "Verification step"
```

### Profile and template when a template is queued

When a template is queued, every main prompt, pre-prompt and follow-up of it takes the prompt queue's default message template and default profile as they are at that moment (`transport: anthropic`, `anthropic-profile-id`).

The **Global Template Editor** (Category dropdown, separate from the queue template editor) covers the user-message template store. The Queue Template Editor is about queue-level workflow templates (full queue entry structure), not about text-transformation templates.

### Operational notes

- Templates can encode complex multi-stage workflows (many pre-prompts + follow-ups) for one-click queuing of repeated processes.
