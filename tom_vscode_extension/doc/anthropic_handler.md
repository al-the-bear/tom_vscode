# Anthropic Handler — Quick Start

The Anthropic handler drives the ANTHROPIC/LLM subpanel of the bottom panel: Claude models on the direct API or the Agent SDK, VS Code LM models, and Local LLM configurations (Ollama or OpenAI-compatible), each chosen through a profile. Full design is in `_ai/quests/vscode_extension/anthropic_sdk_integration.md`.

## 1. Set the API key

The key is read from an environment variable at runtime — never written to the config file.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

The variable name is configurable via `anthropic.apiKeyEnvVar` in `tom_vscode_extension.json` (default `ANTHROPIC_API_KEY`). The direct client reads the name — from the config file as it is now, the read the key check makes — and its value on every call, and is made again when either changed (`src/utils/anthropicClientCache.ts`), so a hand edit of the setting, or a key that is set or removed, takes effect at the next send without a reload; with no key the send fails at once, as the queue's missing-key warning said, and the queue does not send such a stage at all (`stageKeyRefusal` in `dispatchStage`). The 🔑 dot in the ANTHROPIC/LLM panel toolbar is green when the variable is populated, red otherwise.

The variable is read from the extension host's environment, which VS Code takes from the environment it was **launched** with. "Developer: Reload Window" restarts the extension host from the same main process and does not refresh it: after setting the variable (on macOS e.g. `launchctl setenv`, or in the shell VS Code is started from), quit VS Code and start it again. Until then:

- the profile pickers (the ANTHROPIC/LLM panel's and the queue's) label every profile on a `direct` configuration `(no API key)`;
- the queue tools answer a `warning` when an item is queued on such a profile, and the queue editor shows a **No API key** chip on it;
- a send that fails for it ("Anthropic client not available") is not retried: the queue item goes to `error` at once, saying what to do, and the user is told once (`multi_transport_prompt_queue_revised.md` §4.17a).

Profiles on the `agentSdk` transport need no key (they use the Claude Code login).

## 2. Create a configuration

A configuration bundles a model id, token limits, history mode, tool set, and approval mode. Open the **Status Page → LLM Configurations** section, or edit `tom_vscode_extension.json` directly:

```json
"anthropic": {
  "configurations": [
    {
      "id": "default",
      "name": "Sonnet — balanced",
      "model": "claude-sonnet-4-6",
      "maxTokens": 8192,
      "temperature": 0.5,
      "memoryToolsEnabled": false,
      "historyMode": "last",
      "maxRounds": 20,
      "promptCachingEnabled": false,
      "isDefault": true
    }
  ]
}
```

The model dropdown in the panel is populated live from `anthropic.models.list()` — there is no hardcoded fallback list. If the API is unreachable, the dropdown is empty and Send is disabled.

## 2b. Choosing a transport

Every configuration runs over one of two backends, picked per-configuration via the `transport` field (`anthropic_sdk_integration.md` §18):

The direct transport sends every Messages API request **streamed**
(`client.messages.stream(...).finalMessage()`, `src/services/anthropicMessageCall.ts`)
and waits for the final message, so a configuration may ask for the current
models' full 64k-128k `maxTokens`: the SDK refuses a non-streaming request whose
`max_tokens` could run longer than ten minutes ("Streaming is required for
operations that may take longer than 10 minutes"). Cancelling a send aborts the
stream in flight.

| Field | `transport: "direct"` (default) | `transport: "agentSdk"` |
| --- | --- | --- |
| Auth source | `ANTHROPIC_API_KEY` env var | Inherited from the host Claude Code install |
| Billing | Anthropic API account | Claude Code subscription / Bedrock / Vertex |
| Prompt caching | `promptCachingEnabled`: system prompt, tools and newest turn; usage (cache reads/writes) in the live trail | SDK-managed (field ignored) |
| Thinking and effort | The profile's `thinking` (`adaptive` / `off`) and `effort` (`low` … `max`), sent as the model takes them: `thinking: {type: 'adaptive'}` (or `{type: 'disabled'}`) and `output_config.effort`; `{type: 'enabled', budget_tokens: legacyThinkingBudgetTokens}` only on models without adaptive thinking (Haiku 4.5 and older). Off is not possible on Opus 5.5 / Fable, nor on Opus 5 at xhigh / max. A setting the model does not take is left out and named in the payload dump | The SDK's `thinking` and `effort` options, decided the same way |
| Context compaction | Our `history-compaction.ts` | SDK-managed (`historyMode`, `maxHistoryTokens` ignored) |
| Tool-use loop | Hand-rolled in `anthropic-handler.ts` | SDK-managed |
| Memory tools | Same (`tomAi_memory_*`) | Same (`tomAi_memory_*`) — still exposed over MCP |
| Memory → system prompt injection | Yes (§5.2) | No — agent pulls via tools on demand |

To switch, edit the JSON config:

```json
{
  "transport": "agentSdk",
  "agentSdk": {
    "permissionMode": "default",
    "settingSources": [],
    "maxTurns": 40,
    "maxBackgroundWaitMinutes": 30
  }
}
```

`maxBackgroundWaitMinutes` matters when the model starts a command in the background (`run_in_background`) and ends its turn while it runs, for example "WAITING for the suites". The prompt stays open until the command finishes, and the model then continues with its result. After this many minutes (default 30) the wait is checked. A command still producing output, or a background agent still reporting progress, earns another period of the same length. One showing nothing is abandoned, and the live trail says so in a `⏳ notice`. `0` turns waiting off, and such a command's result is then never delivered.

Ignored fields on the `agentSdk` path: `apiKeyEnvVar`, `promptCachingEnabled`, `historyMode`, `maxHistoryTokens`. The approval gate still runs — write tools prompt identically on both paths via the SDK's `canUseTool` hook. **The profile's Tool Approval decides, not the configuration's `permissionMode`** (`src/utils/agentSdkPermissionMode.ts`): `never` runs in `bypassPermissions`; `always` never does — a configuration set to `bypassPermissions` runs in `default` for such a profile (the transport logs it in the Tom Tool Log, the profile editor's Tool Approval help names the configuration), because the SDK does not call `canUseTool` under `bypassPermissions`. `acceptEdits` and `plan` are kept. Queued prompts never ask: the queue sends with approval off.

The panel shows a 🤖 dot next to the 🔑 dot whenever any configuration has `transport: "agentSdk"`:

- **Green** — `claude --version` succeeded at panel load.
- **Red** — `claude` CLI not found on PATH or exited non-zero. Install Claude Code and run `claude login` or `claude setup-token`, then reload the window.
- **Hidden** — no configuration uses the Agent SDK transport.

A quick summary of every configuration (name, model, transport, permission mode, cache, history) is available on the **Status Page → Anthropic/LLM — Configurations** section.

> **Not the same as the Dart-side Agent SDK mirror.** Both backends above are the *in-extension* ANTHROPIC/LLM panel path: profile-gated, trailed, and approval-gated. The `tom_vscode_scripting_api` package also ships a **low-level 1:1 Dart mirror** of `@anthropic-ai/claude-agent-sdk` (`AgentSdkClient.query({prompt, options})`) reachable over the CLI bridge. That mirror is a *separate* surface — **no profiles, allow-lists, trail, or approval gate**; the script owns the SDK `Options` and the bridge relays raw `SDKMessage`s verbatim. It is **not** the `transport: "agentSdk"` configuration documented here. See [agent_sdk_scripting_mirror.md](agent_sdk_scripting_mirror.md) and `_copilot_guidelines/bridge_scripting_guide.md`.

## 3. Create a profile

A profile is a system prompt bound to a configuration. Open the **Global Template Editor** (`Tom AI: Edit Templates` command) and switch to the **Anthropic Profiles** category. Each profile has:

- `systemPrompt` — the system prompt string (or `null` to inherit from the configuration)
- `configurationId` — default configuration id this profile uses
- `isDefault` — whether to preselect on panel load

The profile dropdown in the ANTHROPIC/LLM panel is populated from this list.

## 4. Enable memory tools

Two-tier memory (`_ai/memory/shared/` + `_ai/memory/{quest}/`) is exposed via five tools (`tomAi_memory_read`, `_list`, `_save`, `_update`, `_forget`). To let the model write to memory, enable them either per-configuration:

```json
"memoryToolsEnabled": true
```

…or globally via the cross-config defaults:

```json
"anthropic": {
  "memory": {
    "memoryToolsEnabled": true,
    "memoryExtractionTemplateId": "default-memory",
    "autoExtractMode": "trim_and_summary",
    "maxInjectedTokens": 3000
  }
}
```

Memory writes are subject to the approval gate (§8.1) unless the active profile's `toolApprovalMode` is set to `never` (or the user elevates the call at the approval bar via "Allow All (session)").

## 5. Template categories

The Anthropic flow uses the following template categories, all editable via the **Global Template Editor**:

| Category | Purpose | Where it runs |
| --- | --- | --- |
| `anthropicProfiles` | System-prompt profiles | Sent as `system` on every request (both transports) |
| `anthropicUserMessage` | User-input wrapping (e.g. add file context, role banner) | Wraps each user turn before sending (both transports) |
| `compaction` | History-summary template | `history-compaction.ts` between turns (direct only — SDK compacts on `agentSdk`) |
| `memoryExtraction` | Extract durable facts from a finished exchange | Background pass after each turn (direct only on `agentSdk`) |
| `transportRetry` | Retry-on-busy planning text | `agentSdk` transport when a turn is interrupted/overloaded |
| `interactiveQuestions` | Fallback text returned to the agent for an `AskUserQuestion` call | `agentSdk` transport when interactive questions are off / dismissed (see §6) |

The compaction and memory extraction templates support `${userMessage}` (raw user input) plus all the universal placeholders documented in `file_and_prompt_placeholders.md`.

## 6. Interactive questions (Agent SDK only)

The Claude Agent SDK ships a built-in `AskUserQuestion` tool. On the `agentSdk` transport with `useBuiltInTools: true`, the agent can call it to ask the user multiple-choice questions. In a headless extension host there is no TTY, so the SDK would auto-allow the call, run it with no way to collect an answer, and surface the unanswered questions as the turn's final text — stalling the run.

The extension intercepts `AskUserQuestion` in the `canUseTool` callback (`agent-sdk-transport.ts`, pure logic in `services/agent-sdk-questions.ts`):

- When the active profile sets **`allowInteractiveQuestions: true`**, each question is shown as a native VS Code QuickPick (multi-select honoured). A free-text **"Other…"** entry falls through to an input box; it stays visible under any filter (`alwaysShow`), and typing an answer that matches no option and pressing Enter submits it directly. The collected answers are returned to the agent as the tool result via `{ behavior: 'deny', message }`, so the agent continues the turn with the user's choices.
- When interactive questions are **off**, or the user **dismisses** the picker/input box, a fallback message (the `interactiveQuestionsTemplateId` template, or a built-in default) is returned instead. Its body may reference `${questions}` — a bulleted digest of the headers and options — instructing the agent to proceed autonomously.

> **Limitation:** `canUseTool` is not fired when `permissionMode === 'bypassPermissions'`, which `toolApprovalMode: 'never'` forces. With a never-approve profile the interception is skipped and the SDK's default headless behaviour applies. Use `toolApprovalMode: 'always'` for interactive questions to take effect — it runs outside `bypassPermissions` whatever the configuration sets.

Configure per-profile (`anthropicProfile`):

```json
{
  "allowInteractiveQuestions": true,
  "interactiveQuestionsTemplateId": "my-autonomous-fallback"
}
```

> **Deeper reference:** the full input shape, the exported pure-logic surface (`isAskUserQuestionTool`, `parseAskUserQuestionInput`, `collectInteractiveAnswers`, `summarizeQuestions`, …), the `UserPrompter` seam, and the Global Template Editor `interactiveQuestions` category are specified in [anthropic_sdk_integration.md §18.11](anthropic_sdk_integration.md#1811-interactive-questions-askuserquestion).

## 7. Backend-busy retry (all transports)

Transient backend pressure — HTTP **429**, **529**, every **5xx** except 501 and 505 (so a gateway's 502 / 504 too) and `overloaded_error` — is ridden out automatically, not surfaced as a failure. The retryable set is one shared classifier, `isRetryableBusyError` (`src/utils/retryableError.ts`), used by every send path so they agree on what "busy" means. It matches both error shapes: the raw Anthropic SDK's numeric `.status`, and the Claude Agent SDK's `API Error: <code> { … } · check status.claude.com` message string. **500 ("Internal server error") is included** — it is a server-side transient, not a client bug.

How long it retries depends on the transport, but all of them honour the profile's **`retryMaxTotalWaitMinutes`** (default 10; set 240 for a 4-hour window that survives a long overload):

| Transport | Mechanism | Bound | Backoff |
| --- | --- | --- | --- |
| `direct`, `localLlm` | `withRetryBudget` (`src/utils/retryWithBudget.ts`, loop in `retryBudgetLoop.ts`) | time budget = `retryMaxTotalWaitMinutes` | exponential, capped 5 min/step; on `direct`, a rate limit waits as long as the API says (below) |
| `agentSdk` | `runAgentSdkQuery` loop + `planAgentSdkRetry` (`src/services/agent-sdk-retry.ts`) | **busy** errors: same time budget; **non-busy** "resume interrupted work" errors: `anthropic.transportRetry.maxAttempts` (default 3) | a reported **rate-limit reset** when there is one (see below), otherwise exponential (`computeBackoffMs`), capped 5 min/step, bounded by remaining budget |

On the `agentSdk` path a busy error keeps retrying past the small `maxAttempts` cap until the time budget is spent — a sustained 529 needs many spaced-out retries, not three instant ones. Each backoff sleep is cancellable (Stop button / cancellation token) and pushes a status line (`Anthropic API busy (Agent SDK) — retrying in …`) to the panel via `_onStatusUpdate`, plus a `[retry]` line to the Tom Tool Log. The `transportRetry` *template* (§5) still governs the continuation prompt sent when a retry **resumes** the failed session.

### Rate limits on the direct transport

A 429 on a `direct` profile is not retried on the exponential schedule: the API says when the window resets, and retrying earlier only burns a request. `providerRetryDelayMs` (`src/utils/rateLimitHeaders.ts`) reads, in order, `retry-after-ms`, `retry-after` (seconds or an HTTP date) and, on a 429 without either, the `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-reset` instants — the latest reset among the buckets whose `-remaining` is 0, else the earliest future one. A 529 or 5xx honours `retry-after` when it carries one.

- **Within the budget** the send waits that long plus one second and tries again. The wait counts against `retryMaxTotalWaitMinutes` like a backoff does.
- **Beyond the budget** it does not wait: it stamps the reset instant on the error and rethrows it. The prompt queue then parks the item as `waiting` ("WAITING FOR API RATE LIMIT RESET 14:32") and sends it again once the instant has passed (checked every minute), the way it waits out a "resets <time>" clause from the Agent SDK. Auto-send stays on, so an unattended `<prefix>*` walk does not stop.
- **While a send waits** inside its loop, the queue item shows it: "SENDING — RATE LIMITED, RETRY 2 AT 14:32:05" (or "API BUSY" for a backoff), from `QueuedPrompt.sendWait`, set and cleared through `AnthropicSendOptions.onRetryWait`.

### Retries are visible in the live-trail

Every retry is also written into the quest's `live-trail.md` as a `### 🔁 retry` entry — the status line plus the triggering error in a fenced block — so you can see *that there was an error and it's being ridden out* without opening the Tom Tool Log, alongside the thinking / tool-call / assistant entries. This is emitted by `LiveTrailWriter.appendRetry` (a `{ kind: 'retry', message, cause }` event) and applies to **all transports**:

- `direct` / `localLlm` — the enriched `withRetryBudget` `onRetryStatus(status, cause)` callback fires the panel status line *and* `liveTrail.appendRetry`.
- `agentSdk` — `runAgentSdkQuery` calls `liveTrail.appendRetry` for **every** retry: busy errors (with the backoff status) and the non-busy "resume interrupted work" retries (with a `Retrying after error …` note).

The retry entry does **not** close the prompt block — the turn continues — unlike the terminal `### ✅ DONE` / `### ⚠️ ERROR` / interruption banners. The Telegram trail forwarder mirrors it as a `🔁 retry — …` line so a remote follower sees the failure too.

### Subscription rate limits schedule the retry exactly (`agentSdk`)

Under claude.ai **subscription** auth the Agent SDK pushes a `rate_limit_event` on the query stream whenever the window state changes, carrying `status` (`allowed` / `allowed_warning` / `rejected`), the window kind (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`), `utilization`, and `resetsAt`. `runAgentSdkAttempt` keeps the latest one; the retry loop reads it when the attempt fails.

When the last reported status was **`rejected`** we know the exact instant a retry can be accepted, so the loop schedules against it instead of guessing:

- **Wait = `resetsAt` + 2 minutes** (`RATE_LIMIT_RESET_SKEW_MS` in `agent-sdk-retry.ts`), the skew absorbing clock drift between the extension host and the API. Retrying before the reset can only earn another rejection, so this wait **outranks exponential backoff** — even when no time budget is configured.
- **A reset beyond the remaining budget gives up immediately.** `planAgentSdkRetry` returns `give-up` when `elapsed + rateLimitWait > maxTotalWaitMs`: every attempt inside the budget is certain to be rejected, so sleeping through it only delays a failure the user could already act on.
- A rejected window counts as "busy" regardless of the error text, so the reset-aware path engages even when the thrown message isn't recognisable to `isRetryableBusyError`.
- The status line and the `### 🔁 retry` trail entry name the window, its utilization and its reset time — e.g. `Anthropic five_hour limit rejected (98% used, resets 2026-08-02T17:00:00.000Z, in 42m10s) — retrying in 44m10s`.

Under **API-key** auth this message never arrives; the loop falls back to exponential backoff unchanged. The decision logic (`rateLimitResetAtMs`, `computeRateLimitWaitMs`, `describeRateLimit`, `formatRetryDuration`) lives in the pure, `vscode`-free `src/services/agent-sdk-retry.ts` and is unit-tested there. `resetsAt` is accepted in either seconds or milliseconds — the SDK types don't state a unit, so values below `1e12` are treated as seconds.

### A failure names its cause (`agentSdk`)

When the Claude Code child process exits non-zero, the SDK throws `Claude Code process exited with code 1` and nothing more. The cause has usually been said in the stream already, and `runAgentSdkAttempt` keeps it (`FailureCauseCollector`, `src/services/agent-sdk-failure.ts`):

- an **assistant message with `error`** (`authentication_failed`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, …) and its text, e.g. `Failed to authenticate: OAuth session expired and could not be refreshed`;
- a **`result` with `is_error`**: its `errors` for the error subtypes, or its `result` text for subtype `success`;
- an **`auth_status` message with `error`**;
- the CLI's **stderr**, through the query's `stderr` option. The last 4 KB is kept, and it is used only when nothing structured arrived.

The exit error is then rethrown as an `AgentSdkFailureError` whose message **leads with the cause** and keeps the exit text after it, e.g. `Agent SDK failed: authentication_failed — Failed to authenticate: OAuth session expired and could not be refreshed (Claude Code process exited with code 1) Sign in again: …`. Its stack starts with the same line, so the `### 🔁 retry` notes, the `### ⚠️ ERROR` block, the Tom Tool Log and the queue item's error all show the cause. Stderr and the cause text are scrubbed of token-shaped strings (API keys, GitHub tokens, JWTs, bearer headers, long hex/base64 runs) before they go anywhere. A failure the stream said nothing about is rethrown unchanged.

The cause also steers the retry:

| Cause | Retry |
| --- | --- |
| `rate_limit`, `overloaded`, `server_error` | busy path, as above |
| `authentication_failed` | **one** retry after 30 s (`AUTH_RETRY_DELAY_MS`), because the CLI's token refresh can recover on its own; then give up |
| `billing_error`, `invalid_request`, `model_not_found`, `oauth_org_not_allowed`, `account_on_hold`, `verification_required`, `cloud_credential_error` | give up at once: retrying cannot succeed until the user acts |
| anything else | unchanged: the "resume interrupted work" retries |

Giving up on one of those non-retryable causes also calls the transport's `onFailureNotice`. The handler wires it to the same channels as `tomAi_notifyUser`: Telegram when configured, else a VS Code error message. That matters for a queued prompt, which otherwise simply stops. The notice names the cause and what to do, e.g. *Sign in again: run /login in Claude Code, or re-authenticate the extension's Claude profile, then resend.*

### Token / cost accounting in the live-trail (`agentSdk`)

The Agent SDK reports the turn's accounting exactly once, in its final `result` message. The transport maps it onto `LiveTrailUsage` (`toLiveTrailUsage`) and writes a `### 📊 usage` block **just before** the closing `### ✅ DONE`, so the numbers sit next to the work that incurred them:

```markdown
### 📊 usage

- tokens: in 1,234 · out 567 · cache read 8,901 · cache write 42
- cost: $0.0421 · api 12.3s

| model | in | out | cache read | cache write | cost | ctx | when |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| claude-opus-4-7 | 1,234 | 567 | 8,901 | 42 | $0.0421 | 1,000,000 | 20260804_092114 |
```

Both cost figures are **US dollars**, not cents — `costUSD` / `total_cost_usd` come from the SDK in dollars and are printed to four decimal places.

The `when` column stamps the moment the accounting was recorded, in the same `YYYYMMDD_HHMMSS` format as the enclosing `## 🚀 PROMPT …` header so the two can be read together. They are deliberately not the same instant: the header marks when the turn *started*, and a turn that runs for minutes finishes far from where it began. `formatLiveTrailUsage` takes that time as an argument rather than reading the clock, which is what keeps it pure.

The aggregate `usage` arrives in the wire format's snake_case while `modelUsage` uses camelCase; the transport normalises both onto the trail's single vocabulary.

### The same block on `direct` and Local LLM

The **direct** transport sums `response.usage` over the rounds of a send (cache reads and writes included) and writes the same block: the totals, one line for the configuration's model and its cost from the price table `anthropic.modelPrices` (USD per million tokens; a model matches its exact entry, else the longest entry its id starts with; cache prices default to 0.1x read and 1.25x write of the input price). A model without an entry shows its tokens and no cost: prices are configured, never guessed (`src/utils/usageCost.ts`). A **Local LLM** send (an Anthropic profile on a Local LLM configuration) sums each round's prompt and completion tokens and writes tokens only. VS Code LM reports no usage, so its sends have no block.

Every `usage` event, from any transport, is also added to this window's usage ledger (`src/services/usageLedgerService.ts`, kept in the workspace state, per day and model, 62 days), which the Status Page shows as today's and the since-reset totals. The direct transport is the exception that comes earlier: it puts each round's usage into the ledger as the round's response arrives (`DirectSendUsage` in `src/utils/usageCost.ts`, `recordRoundUsage`; the first round counts the send), so a send that ends in an error — out of credit, a 400, a cancel — is counted for what its rounds used; its usage block, summed over the rounds, is written once, also before the error is, and carries `recordedInLedger`, so the ledger's observer does not count it again. Rendering is `formatLiveTrailUsage` — a pure function in `live-trail.ts`, unit-tested — and a usage object with nothing to report renders nothing rather than an empty heading. `LiveTrailWriter.appendUsage` also emits a `{ kind: 'usage', usage }` event; the Telegram coalescer deliberately drops it (a remote follower wants the answer, not the invoice).

## Related sections of the spec

- §4 Trail system (raw + summary trails for `anthropic` subsystem)
- §6 History compaction (summary / trim_and_summary / llm_extract modes)
- §8.1 Write-tool approval gate
- §10 Status Page — Compaction + Anthropic Memory sections
- §11 Bottom panel — ANTHROPIC accordion
- §14 Configuration schema
- §18 Claude Agent SDK transport (alternative backend)
