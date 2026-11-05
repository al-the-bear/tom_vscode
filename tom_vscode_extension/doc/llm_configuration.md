# LLM Configuration

Reference guide for the **Local LLM**, **Anthropic**, and **History Compaction**
settings exposed by the Tom VS Code extension (`tom_vscode_extension.json` and
the Status Page sections that mirror it).

The focus of this document is **what each setting actually does in the code
paths**, including:

- The tool-trail retention policy that bounds in-turn prompt growth.
- The incremental compaction loop that keeps inter-turn history bounded.
- Which placeholders the compaction template can use to assemble the summary
  prompt — and which placeholders the model sees when it asks for older tool
  results back.

All file references below point under [tom_vscode_extension/src/](../src/).

Edits to `tom_vscode_extension.json` (and to the user-global overlay
`~/.tom/vscode/tom_vscode_extension.user.yaml`) take effect at the next read,
whether they are made on the Status Page, by hand or by an agent: the
configuration compares the files' stat on every read and parses them again only
when they changed. No *Reload Chat Config* or window reload is needed.
A save through the extension writes only the section it saves into the
workspace file, so the user-global overlay keeps serving every section the
workspace file does not define. While the workspace file does not parse, saves
are refused with a message, so a half-finished hand edit is not overwritten.

---

## 1. Two distinct accumulators — history and tool trail

A long agent session has two sources of context growth that need separate
treatment:

1. **History.** Each turn appends one user/assistant pair to
   `rawTurns`. Across many
   turns this can drift into hundreds of KB.
2. **Tool trail.** Each *tool round* inside a single turn appends one
   `assistant{tool_calls}` message and one `tool_result` (or `tool`) message
   per tool call. A few `tomAi_findTextInFiles` / `tomAi_readFile` calls can
   add 60–100 kB *per round*. Multi-round agents accumulate this within a
   single user prompt — `historyMode` does nothing about it.

Both accumulators are now governed by configuration. Below is the layout.

```text
┌──────────────────────────────────────────────────────────────────┐
│ Outgoing request                                                 │
│                                                                  │
│   system  : profile.systemPrompt + instructions                  │
│                                                                  │
│   history :  ┌──────────────────────────────────────┐            │
│              │ compactedSummary (running, optional) │            │
│              │ rawTurns[-rawTurnsKept * 2]          │            │
│              └──────────────────────────────────────┘            │
│                                                                  │
│   user    : current prompt                                       │
│                                                                  │
│   tool    : [round N-1] assistant{tool_calls}                    │
│             [round N-1] tool_result content                      │
│              ↑ inside `toolTrailKeepRounds` → truncated to       │
│                `toolTrailMaxResultChars` with a key reference    │
│             [older]    tool_result content = stub by key         │
│              ↑ outside the window → one-line pointer, full       │
│                body kept on disk under                           │
│                _ai/trail/<sub>/<quest>/tool_results/<key>.json   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Tool-trail retention policy (the fix for the 128k overflow)

Settings (`compaction.*` with per-configuration overrides on every
`localLlm.configurations[i]` and `anthropic.configurations[i]`):

| Setting | Default | Effect |
| --- | --- | --- |
| `toolTrailMaxResultChars` | `30000` | A tool_result block is cut to this many chars once, when it arrives (a cut result is never cut again); a `[Truncated inline view: N/total chars. Full result available via tomAi_readPastToolResult({"key":"tX"})...]` marker is prefixed so the model knows where to look. |
| `toolTrailKeepRounds` | `2` | The tool rounds kept whole: without prompt caching, the newest N rounds at any time; with caching, the newest N rounds after a collapse. Older rounds have their `tool_result` content replaced with a one-line stub naming the replay key. The `tool_use` / `tool_result` pairing is preserved so the Anthropic API stays happy. **Once an assistant turn of the loop carries a thinking block, no earlier round is rewritten:** that holds whether or not the profile asks for thinking (`thinking`), because a model may think unasked — Opus 5.5 does. The `thinking` / `redacted_thinking` blocks are signed over the conversation as it was, and the API refuses a request whose earlier messages changed ("Invalid `signature` in `thinking` block"). Each round's results are then cut to `toolTrailMaxResultChars` once, as they are added, and nothing is stubbed (`src/services/toolTrailRetention.ts`). Long tool loops send a larger prompt in that case; the history kept between prompts is text only and unaffected. |
| `toolTrailCollapseRounds` | `30` | **Direct API with prompt caching.** The conversation is cached up to the newest turn (a read costs 0.1× the input price, a write 1.25×), and stubbing an old round rewrites a message inside that prefix — the next request reads the cache only up to it and writes everything after it again. So earlier rounds stay exactly as sent until more than this many rounds are kept whole; then every round but the newest `toolTrailKeepRounds` becomes a stub at once. The prefix changes once per batch (keep 2, collapse 30: at rounds 31, 60, 89, …) instead of every round. Without caching, every round past `toolTrailKeepRounds` is stubbed. |
| `toolTrailCollapseChars` | `300000` | With caching, collapse also once the results of the rounds kept whole exceed this many characters, so a few huge results do not wait for `toolTrailCollapseRounds`. |

### Where the bodies live

Every tool result that runs through either handler is **persisted to disk**:
an Anthropic session's in its own storage, the Local LLM's in its trail folder.
Layout:

```text
_ai/quests/<quest>/history/sessions/<session>/trail/tool_results/t14.json
_ai/trail/localllm/<quest>/tool_results/t14.json
```

An Anthropic session's keys continue past the results it has stored, so a key
never names two results.

The file is a JSON object matching `ToolTrailEntry`
([services/tool-trail.ts:22](../src/services/tool-trail.ts#L22)):
`{ key, timestamp, round, toolName, inputSummary, result, durationMs, error? }`.

### How the model recovers a stubbed result

The existing `tomAi_readPastToolResult` tool now reads from the in-memory ring
buffer first and falls back to disk
([past-tool-access-tools.ts:195](../src/tools/past-tool-access-tools.ts#L195)).
Pass the `key` shown in the stub:

```text
[Past tool call t14 — tomAi_readFile(path=src/foo.ts) — 61823 chars.
 Use tomAi_readPastToolResult({"key":"t14"}) to retrieve the full result.]
```

The model calls `tomAi_readPastToolResult({"key":"t14"})` and gets the full
body back. This is what makes aggressive truncation safe — the body is never
actually destroyed.

### Implementation

- [`applyToolTrailRetentionPolicy`](../src/handlers/anthropic-handler.ts) runs after each `messages.push({ role:'user', content: toolResults })` in the direct-SDK tool loop and in the Local LLM transport's tool loop.

Both use [`ToolTrail.truncateInline`](../src/services/tool-trail.ts) and
[`ToolTrail.renderStub`](../src/services/tool-trail.ts) so the markers/stubs
are byte-identical.

> **Note on the Agent SDK transport.** When an Anthropic configuration uses
> `transport: 'agentSdk'`, the SDK owns the tool loop and we do not see the
> intermediate `messages[]`. The retention policy only applies to the direct
> SDK transport. Use the Agent SDK's own context-management knobs there.

---

## 3. History compaction — `trim_and_summary` mode (the running summary)

The Local LLM and Anthropic direct paths now share the same model: a running
**`compactedSummary`** (one string) plus a small **`rawTurns`** array of the
most recent verbatim user/assistant pairs. Every turn:

1. The new user prompt and the model's reply are appended to `rawTurns`.
2. If `rawTurns.length > rawTurnsKept * 2`, the overflow (oldest) is folded
   into `compactedSummary` via the configured compaction template — *every
   turn the threshold is crossed*, not just once when the budget snaps.
3. On the next call, the prompt is assembled as `[compactedSummary-as-synth-pair] + rawTurns + currentUser`.

### Settings (with per-configuration overrides)

| Setting | Default | What it does |
| --- | --- | --- |
| `rawTurnsKept` | `4` | Number of user/assistant turn *pairs* kept verbatim. Total raw messages = `rawTurnsKept * 2`. |
| `maxHistoryTokens` | `8000` | Token target for the compactor's output (`${maxHistoryTokens}` placeholder). Also used as the safety token cap in batch summary mode, and as the cap on the raw history every request carries: the newest whole rounds that fit (four characters a token) go out, older ones are left out (`src/services/historyPayloadBound.ts`). |
| `historyMaxChars` | `24000` | Hard cap on the `${existingSummary}` / `${compactedSummary}` injected into the compactor's *own* prompt. Tail-bounded (newest portion kept). |
| `memoryMaxChars` | `8000` | Hard cap on `${existingMemory}` injected into the memory-extraction prompt. Head-bounded (newest entries kept — memory files are prepended newest-first). |
| `compactionTemplateId` | active id from `compaction.templates[]` | Which template renders the prompt sent to the compactor LLM. |
| `compactionMaxRounds` | `1` | Tool-call rounds allowed during one compaction pass (Local LLM only — Anthropic compaction is single-shot). |
| `fullTrailMaxTurns` | `200` | Safety cap on `historyMode: full`. |

**The history a request carries is bounded.** Between two compactions a request
carries the rounds the compactor has not folded yet plus the rolling tail. With
compaction switched off (`compaction.disabled`, or a configuration's
`compactionOverride: "off"`) nothing folds the accumulator, so the request then
carries the rolling tail only (`rawTurnsKept` rounds); and in every case only
the newest rounds that fit `maxHistoryTokens`. A stored round holds the user's
prompt, not the wrapped message: a `userPromptWrapper` that injects
`${rawTurns}` (needed by the Agent SDK T&S profiles, whose transport takes no
message history) would otherwise copy every earlier round into the next one.
Direct profiles do not need `${rawTurns}` or `${compactedSummary}` in their
wrapper: the direct transport sends both as messages.

Per-configuration overrides live directly on the configuration entry:

```jsonc
{
  "id": "macpro2023-gemma4-26b-omlx",
  "model": "Gemma4:26B",
  "historyMode": "trim_and_summary",
  "rawTurnsKept": 6,
  "maxHistoryTokens": 12000,
  "historyMaxChars": 40000,
  "toolTrailMaxResultChars": 800,
  "toolTrailKeepRounds": 2
}
```

If a configuration omits a field, the compaction-level value (or the schema
default) applies. Resolution helpers:

- [`resolveEffectiveCaps`](../src/handlers/anthropic-handler.ts)

---

## 4. Placeholders — what to put in your compaction template

The compactor template is plain markdown with `${...}` placeholders resolved by
[`expandTemplate`](../src/services/history-compaction.ts) (which delegates to
the project's `resolveVariables`). The placeholders that the
**`runIncrementalCompaction`** path supplies — i.e. the variables you can use
in `compaction.templates[*].template` for `trim_and_summary` mode — are:

| Placeholder | Type | Meaning |
| --- | --- | --- |
| `${existingSummary}` | string | The previous turn's `compactedSummary`, tail-bounded to `historyMaxChars`. Empty (or a sentinel like `(empty — this is the first turn of the session)`) on the very first compaction. |
| `${lastTurn}` | string | The user/assistant overflow being folded in this pass, formatted as `[user] …\n\n[assistant] …`. For batch (`summary`) mode this carries the whole history. |
| `${lastTurnCharCount}` | string (int) | Character count of `${lastTurn}` — handy in the template instructions ("integrate the following N chars of new history…"). |
| `${maxHistoryTokens}` | string (int) | Numeric token budget; aim the output around this size. |
| `${maxHistorySize}` | string (int) | Convenience char target = `maxHistoryTokens * 4`. |
| `${historyMaxChars}` | string (int) | Hard char ceiling on what was injected into this prompt — also a sensible *output* cap to aim for. |

The memory-extraction template (`memoryExtractionTemplates[*].template`) sees a
different vocabulary, used by **`runIncrementalMemoryExtraction`**:

| Placeholder | Type | Meaning |
| --- | --- | --- |
| `${lastTurn}` | string | The exchange that just happened. |
| `${compactedSummary}` | string | The just-updated running summary, tail-bounded to `historyMaxChars`. |
| `${existingMemory}` | string | Current memory file content, head-bounded to `memoryMaxChars` (newest entries kept). |
| `${memoryFilePath}` | string | Absolute path of the target memory file (`facts.md` etc). |
| `${memoryScope}` | string | `'quest'` / `'shared'` / `'both'`. |
| `${historyMaxChars}` | string (int) | Same value passed to the compactor. |
| `${memoryMaxChars}` | string (int) | Hard cap on existing memory injection. |

### Example: the seeded `default-compaction` template

```text
You maintain a single running summary of a developer chat session. Every
turn, you receive:
- the current summary (the state of the session as of the *previous* turn)
- the latest user/assistant exchange

Your job is to produce an **updated** summary that integrates the new
exchange.

Target size: approximately ${maxHistorySize} characters (~${maxHistoryTokens}
tokens). The summary should be **detailed**: preserve decisions, file paths,
function names, commits, gating items, errors, and user preferences.
Summaries shorter than half the budget are too terse.

**Write the new summary in full** — do not produce a diff or describe what
changed; just emit the integrated summary as it should appear next turn. No
preamble, no closing remark. Keep bulleted lists where the underlying
content was already bulleted.

---

Current summary (empty on the first turn):

${existingSummary}

---

Latest exchange to integrate (${lastTurnCharCount} chars):

${lastTurn}
```

That template runs on **every turn** whose overflow exceeds `rawTurnsKept * 2`
messages. It is also used in batch mode for `historyMode: summary` (in which
case `${existingSummary}` is a sentinel and `${lastTurn}` carries the entire
history).

### How history reaches the *model* (not the compactor)

The compactor produces `compactedSummary`. That string is then injected into
the next *user-facing* prompt as a synthetic user/assistant pair:

```ts
// rolling history sent to the model
[
  ...rawTurns,            // up to rawTurnsKept * 2 messages, verbatim
  { role: 'user',
    content: '## Additional context (compacted from earlier turns)\n\n${compactedSummary}' },
  { role: 'assistant',
    content: 'Understood — continuing with this context in mind.' },
  { role: 'user', content: currentUserPrompt },
]
```

There is **no `${history}` placeholder** in profile system prompts on the
direct-LLM path. The summary is positioned as conversation context, not as a
template variable, so prompt caching can include the rolling prefix when
enabled.

For profiles that use the Anthropic `userPromptWrapper` (Agent SDK or
direct-SDK alike), the placeholders `${compactedSummary}`, `${rawTurns}`, and
`${rawTurnCount}` ARE available — see the existing seed templates in
`.tom/tom_vscode_extension.json` for examples.

---

## 5. Local LLM configuration (`localLlm` section)

### 5.1 `configurations[]` — full configuration entries

| Field | Used by | Meaning |
| --- | --- | --- |
| `id`, `name` | UI / refs | Identifier + label. |
| `ollamaUrl` | Request builder | Endpoint base URL (also used for OpenAI-compatible servers — the field name is historical). |
| `apiStyle` | Request builder | Backend protocol; defaults to `'ollama'`. `'ollama'` → `GET /api/tags` + `POST /api/chat`. `'openai'` → `GET /v1/models` + `POST /v1/chat/completions` — for **OpenAI-compatible** servers (vLLM, LM Studio, llama.cpp, etc.). See §5.4. |
| `apiKeyEnv` | Request builder | **Name** of an env var holding the bearer token for OpenAI-compatible auth — never the key itself. See §5.4. |
| `model`, `temperature`, `keepAlive` | Request builder | Forwarded to the backend. `keepAlive` is Ollama-only — ignored when `apiStyle: 'openai'`. |
| `stripThinkingTags` | Post-processor | Strip `<think>…</think>` from the cleaned text. |
| `toolsEnabled` | Request builder | When `false`, omit the `tools` array entirely (vLLM without tool-call parser). |
| `enabledTools` | Request builder | Tool subset when `toolsEnabled === false`. |
| `maxRounds` | Tool loop | Tool rounds cap. Set ≥ 2 to allow any tool use. |
| `maxTokens` | Anthropic profile only | Mapped onto the synthesised AnthropicConfiguration. |
| `historyMode` | Inter-turn history | `none` / `last` / `full` / `summary` / `trim_and_summary` / `llm_extract` — see §3. |
| **`rawTurnsKept`** | Inter-turn history | Per-config override for `compaction.rawTurnsKept`. |
| **`maxHistoryTokens`** | Compactor budget | Per-config override for `compaction.maxHistoryTokens`. |
| **`historyMaxChars`** | Compactor input cap | Per-config override for `compaction.historyMaxChars`. |
| **`memoryMaxChars`** | Memory-extraction input cap | Per-config override for `compaction.memoryMaxChars`. |
| **`toolTrailMaxResultChars`** | Tool-trail | Per-config override for `compaction.toolTrailMaxResultChars`. |
| **`toolTrailKeepRounds`** | Tool-trail | Per-config override for `compaction.toolTrailKeepRounds`. |
| **`toolTrailCollapseRounds`** | Tool-trail | Per-config override for `compaction.toolTrailCollapseRounds`. |
| **`toolTrailCollapseChars`** | Tool-trail | Per-config override for `compaction.toolTrailCollapseChars`. |
| `trailMaximumTokens`, `trailSummarizationTemperature`, `removePromptTemplateFromTrail` | Trail viewer | Visual / summarisation hints for the trail UI; not used in model requests. |
| `answerFolder`, `logFolder` | Trail layout | Folder overrides for per-config trail output. |
| `isDefault` | Picker | One configuration may be flagged default. |

### 5.2 Anthropic profiles on a Local LLM configuration

A Local LLM configuration is used through an **Anthropic profile** whose
`configurationId` names it (`transport: 'localLlm'`): the Anthropic handler
runs its tool loop, approval gate, templates and trails, and each model call
goes to the configuration's endpoint through
[`LocalLlmManager.callLocalLlmOnce`](../src/handlers/localLlm-handler.ts).
The profile's `systemPrompt` does NOT receive history placeholders. History
arrives as conversation messages, not template variables (see §4).

### 5.3 Compaction on a Local LLM configuration

`compactionModel: "localLlm:<configuration id>"` runs history compaction on a
Local LLM configuration, also through `callLocalLlmOnce`, with the
configuration's `apiStyle` and `apiKeyEnv` (see §5.4).

### 5.4 Backends (`apiStyle`) and Bearer auth (`apiKeyEnv`)

The Local LLM transport speaks two protocols, selected per configuration by
`apiStyle` (default `'ollama'`):

| `apiStyle` | Discovery | Chat endpoint | Backends |
| --- | --- | --- | --- |
| `'ollama'` (default) | `GET /api/tags` | `POST /api/chat` | Ollama |
| `'openai'` | `GET /v1/models` | `POST /v1/chat/completions` | **Any OpenAI-compatible server** — vLLM, LM Studio, llama.cpp (`llama-server`), and similar |

`ollamaUrl` is the base URL for **both** styles (the field name is historical);
point it at the OpenAI-compatible server's root (e.g. `http://macpro2023.vpn:8001`)
and the handler appends the right path. `keepAlive` is an Ollama parameter and is
**ignored** for `apiStyle: 'openai'`. Tool-call support varies by backend — set
`toolsEnabled: false` for a server that lacks a tool-call parser (e.g. a bare
vLLM deployment), which omits the `tools` array entirely.

**Bearer auth — `apiKeyEnv`.** OpenAI-compatible servers behind a gateway often
require a token. Set `apiKeyEnv` to the **name** of an environment variable
holding the token (never the secret itself, mirroring the Anthropic
`apiKeyEnvVar` and MCP `apiKeyEnv` discipline). The pure helper
[`apiKeyAuthHeader`](../src/utils/apiKeyAuthHeader.ts) resolves it:

- set + the named var holds a non-empty value ⇒ the request gets
  `Authorization: Bearer <value>`;
- unset ⇒ the call is unauthenticated (the original behaviour);
- **configured but the named var is empty/undefined ⇒ treated as unset and the
  miss is logged**, so a typo'd env name fails loud-ish instead of silently
  sending `Bearer undefined`.

`apiKeyEnv` lives on each `localLlm.configurations[i]` and is threaded through
to the synthesised Anthropic profile path (`resolveAnthropicTargets`) so a Local LLM configuration that backs
an Anthropic profile authenticates the same way. The history compactor honours
`apiStyle` too — see `services/history-compaction.ts` — so a vLLM/llama.cpp
configuration used as the compaction backend hits the OpenAI path as well.

The Status Page LLM Configurations section surfaces both fields: an **API style** dropdown
(Ollama / OpenAI) and an **API Key Env** input.

---

### 5.5 Where the Local LLM keeps its files

An Anthropic profile on a Local LLM configuration keeps its files like every
Anthropic profile: in its session (history, summary trail, live trail, tool
results, memory). The last assembled request is dumped to the `localllm` raw
trail bucket, since the wire endpoint is the local model.

Copilot has no sessions either: `_ai/quests/<quest>/history/<quest>.copilot.{prompts,answers}.md`
and `_ai/trail/copilot/<quest>/`, one set per quest.

## 6. Anthropic configuration (`anthropic` section)

| Field | Effect |
| --- | --- |
| `historyMode` on a configuration | Same enum as Local LLM. `'sdk-managed'` is unique to the Agent SDK transport and lets the SDK own continuity. |
| `maxHistoryTokens` | Per-config compactor token budget (overrides `compaction.maxHistoryTokens`). |
| **`historyMaxChars`** | Per-config char ceiling on the compactor input (overrides `compaction.historyMaxChars`). |
| **`memoryMaxChars`** | Per-config memory-extraction char ceiling (overrides `compaction.memoryMaxChars`). |
| **`rawTurnsKept`** | Per-config raw-turn-pair cap (overrides `compaction.rawTurnsKept`). |
| **`toolTrailMaxResultChars`** | Per-config tool-result inline cap (overrides `compaction.toolTrailMaxResultChars`). |
| **`toolTrailKeepRounds`** | Per-config tool-trail keep-rounds (overrides `compaction.toolTrailKeepRounds`). |
| **`toolTrailCollapseRounds`** / **`toolTrailCollapseChars`** | Per-config collapse thresholds (override the `compaction` ones). |

An Anthropic configuration inherits every one of these unless it sets its own. The Status Page lists the configurations with ⚙ and the values each sets itself; its edit wizard asks for the retention values on a direct configuration — *Use the defaults*, *Keep this configuration's values* or *Customise…* (an empty field inherits) — and keeps the other overrides as they were.
| `compactionOverride` | `'default' \| 'on' \| 'off'` — per-config override for the global compaction kill switch. |
| `promptCachingEnabled` | Adds `cache_control` breakpoints on the system prompt, the tool definitions and the newest turn, so each tool-loop round reads the earlier prefix from the cache. Doesn't shrink the prompt; reduces cost. Cache reads and writes show in the live trail's usage block. |
| `transport` | `'direct'` / `'agentSdk'` / `'vscodeLm'`. Tool-trail enforcement applies to `'direct'`. |
| `memoryToolsEnabled` | Expose memory read/write tools to the model. |
| `maxRounds`, `maxTokens` | Standard agent loop knobs. |

**`anthropic.modelPrices`** (on the section, not a configuration) is the price table of the direct-API models, in USD per million tokens, for the cost in the live trail's usage block and the Status Page's usage totals:

```json
"modelPrices": [
  { "model": "claude-opus-5", "inputPerMTok": 15, "outputPerMTok": 75 },
  { "model": "claude-haiku-5-5", "inputPerMTok": 1, "outputPerMTok": 5, "cacheReadPerMTok": 0.1, "cacheWritePerMTok": 1.25 }
]
```

The numbers are an example of the shape, not current prices: take them from Anthropic's pricing page. A model matches its exact entry, else the longest entry its id starts with (`claude-opus-5` prices every `claude-opus-5-*`). `cacheReadPerMTok` defaults to 0.1x and `cacheWritePerMTok` to 1.25x the input price. A model without an entry shows its tokens and no cost. The Agent SDK reports its own cost; Local LLM sends show tokens only.

---

## 7. History Compaction (`compaction` section) — defaults & system-wide flags

These act as fallbacks for any per-configuration override. They also control
behaviour that is genuinely system-wide (e.g. the global kill switch).

| Field | Default | Where used |
| --- | --- | --- |
| `disabled` | `false` | Global kill switch for the post-turn compaction + memory-extraction pass. Also suppresses the **automatic** trail-based history rebuild on session seed (so a disabled compactor makes no LLM/Ollama calls on a fresh session); the explicit "Recreate History" button still forces a rebuild. Per-config `compactionOverride` wins. |
| `compactionModel` | — | The model compaction runs on: `anthropic:<configuration id>` — any Anthropic configuration, on the direct API, the Agent SDK or VS Code LM, called through its own transport — or `localLlm:<configuration id>`. Unset: no compaction. Chosen in the Status Page's History Compaction section ("Compaction model"). |
| `memoryExtractionModel` | — | The model memory extraction runs on, written the same way ("Memory extraction model"). Unset: no memory extraction. |
| `llmProvider`, `llmConfigId` | — | The older form: one model for both. Read only while the two keys above are unset; the Status Page writes the two keys and drops these on save. |
| `compactionTemplateId` | — | Active compaction template (`compaction.templates[]`). |
| `memoryExtractionTemplateId` | — | Active memory-extraction template. |
| `compactionMaxRounds` | `1` | Local-LLM compactor tool loop. |
| `maxHistoryTokens` | `8000` | Fallback compactor token budget. |
| `historyMaxChars` | `24000` | Fallback char ceiling on `${existingSummary}` / `${compactedSummary}`. |
| `memoryMaxChars` | `8000` | Fallback char ceiling on `${existingMemory}`. |
| **`rawTurnsKept`** | `4` | Fallback raw-turn-pair count for `trim_and_summary`. |
| **`toolTrailMaxResultChars`** | `30000` | Fallback per-result inline truncation (both tool loops; Local LLM configurations with a small context set their own). |
| **`toolTrailKeepRounds`** | `2` | Fallback in-message keep window for tool_result blocks. |
| `fullTrailMaxTurns` | `200` | Safety cap on `historyMode: full`. |
| `backgroundExtractionEnabled` | `true` | Anthropic background `llm_extract` pass on/off. |
| `runMemoryExtractionOnCompaction` | `true` | Memory extraction runs after every compaction pass. |
| `rebuildFromLastNPrompts` | `200` | Anthropic — number of trail-file entries used to seed history when no `history.json` exists. Only runs the LLM fold when compaction is enabled (`disabled: false`) or the rebuild was forced via "Recreate History". |
| `archiveHistoryEveryTurn` | `false` | Debug toggle: write a timestamped `history.json` snapshot per turn. |
| `templates[]` | — | Compaction prompt templates (id, name, body, targetMode). |
| `memoryExtractionTemplates[]` | — | Memory-extraction prompt templates. |

---

### Per-quest override (`extension_config.<quest>.yaml`, section `compaction`)

The `compaction` section above applies to every quest that reads this config
file. A quest can override part of it in its own machine-independent
`_ai/quests/<quest>/extension_config.<quest>.yaml`, so compaction runs for that
quest only, or with other sizes or templates. The models are the workspace's
alone: a quest cannot choose them.

```yaml
compaction:
  disabled: false               # on for this quest, whatever the workspace says
  runEveryNRounds: 10
```

The keys taken are `disabled`, `compactionTemplateId`, `memoryExtractionTemplateId`,
`runMemoryExtractionOnCompaction`, `archiveHistoryEveryTurn` and the counts
(`runEveryNRounds`, `rawTurnsKept`, `maxHistoryTokens`, `historyMaxChars`,
`memoryMaxChars`, `compactionMaxRounds`, `toolTrailMaxResultChars`,
`toolTrailKeepRounds`, `fullTrailMaxTurns`, `rebuildFromLastNPrompts`); a
value of the wrong type is ignored (`src/utils/compactionQuestOverride.ts`).
The Anthropic handler applies it for the window's quest; the Status Page and
the Local LLM handler show and use the workspace setting.

## 8. Example walk-through — a Local LLM on macpro2023 with the new defaults

An Anthropic profile on this Local LLM configuration drives the conversation.
Config (relevant excerpt):

```json
{
  "localLlm": {
    "configurations": [
      {
        "id": "macpro2023-gemma4-26b-omlx",
        "name": "Gemma4:26B on macpro2023 (oMLX)",
        "apiStyle": "openai",
        "ollamaUrl": "http://macpro2023.vpn:8001",
        "model": "Gemma4:26B",
        "temperature": 1,
        "stripThinkingTags": true,
        "maxRounds": 400,
        "historyMode": "trim_and_summary",
        "rawTurnsKept": 4,
        "maxHistoryTokens": 16000,
        "historyMaxChars": 60000,
        "memoryMaxChars": 100000,
        "toolTrailMaxResultChars": 1000,
        "toolTrailKeepRounds": 2,
        "toolsEnabled": true,
        "isDefault": true
      }
    ]
  },
  "compaction": {
    "compactionModel": "anthropic:haiku-5-5-agent",
    "memoryExtractionModel": "anthropic:haiku-5-5-agent",
    "compactionTemplateId": "default-compaction",
    "memoryExtractionTemplateId": "default-memory-extraction",
    "compactionMaxRounds": 40,
    "maxHistoryTokens": 10000,
    "historyMaxChars": 60000,
    "memoryMaxChars": 100000,
    "rawTurnsKept": 4,
    "toolTrailMaxResultChars": 1000,
    "toolTrailKeepRounds": 2,
    "fullTrailMaxTurns": 200,
    "backgroundExtractionEnabled": false,
    "runMemoryExtractionOnCompaction": true
  }
}
```

`compaction.maxHistoryTokens` (10 000) is the history budget of every configuration
that states none — the Anthropic configurations keep it so; this Local LLM
configuration states its own 16 000. Compaction and memory extraction run on
the Haiku 5.5 Agent SDK configuration, whatever the conversation runs on.

### What happens turn by turn

**Turn 1.** User asks `P1`. Prompt sent =
`system + (empty history) + P1`. Model invokes `tomAi_findTextInFiles`
(60 kB result, key `t1`), then `tomAi_readFile` (40 kB, `t2`), then answers.

- After the first tool round, the in-message `tool_result` for `t1` is
  truncated to 1000 chars with a `[Truncated inline view: 1000/61823 chars.
  Full result available via tomAi_readPastToolResult({"key":"t1"})…]` marker.
- After the second tool round, `t1` is now *outside* the
  `toolTrailKeepRounds = 2` window for round 1 but still inside for round 2.
  Round 2's result `t2` is truncated to 1000 chars; round 1's `t1` becomes a
  one-line stub `[Past tool call t1 — tomAi_findTextInFiles(...) — 61823
  chars. Use tomAi_readPastToolResult({"key":"t1"})…]`.
- Both full bodies were written to the session's
  `history/sessions/<session>/trail/tool_results/t1.json` and `t2.json` on
  tool execution.

**Post-turn 1.** `rawTurns = [P1, A1]` (one pair). No compaction yet because
`1 ≤ rawTurnsKept * 2 = 8`. `compactedSummary` remains empty.

**Turn 5.** `rawTurns` now holds 10 messages. Overflow = the 2 oldest
(`P1`, `A1`). The handler calls `runIncrementalCompaction` with
`existingSummary = (empty)`, `lastTurn = [P1, A1]`. The compactor LLM rewrites
the `compactedSummary` to integrate that exchange.

**Turn 6.** Outgoing history =
`[compactedSummary-as-synth-pair, P2, A2, P3, A3, P4, A4, P5, A5]`. The summary
is bounded by `historyMaxChars`. Raw turns are bounded by `rawTurnsKept * 2`.
Within the current turn the tool trail policy is applied to every tool round
as in turn 1.

### Diagnostic

Every round's payload is in the session's raw trail
(`history/sessions/<session>/trail/*_payload_*.payload.md`), with the tool-trail
keys (`t12`, …) in its stub lines; the same keys name the files in
`trail/tool_results/` and are what `tomAi_readPastToolResult({"key":"t12"})`
takes. The Tom AI Local Log channel logs each request to the endpoint, with its
timing and any busy-backend retry.

---

## 9. Quick troubleshooting

When a Local LLM call still hits the context limit:

1. **Check the payload** in the session's raw trail for a long compacted
   summary or a large tool result. The summary grows up to `historyMaxChars`;
   if yours is set very high (e.g. 60k) you can tighten it.
2. **Lower `toolTrailKeepRounds`** to `1` (or `0` — older rounds become stubs
   immediately). The first inline round is still truncated to
   `toolTrailMaxResultChars` so even one round can't blow the window.
3. **Lower `toolTrailMaxResultChars`** to e.g. 500.
4. **Lower `rawTurnsKept`** so older turns roll into the summary faster.
5. **Inspect the disk store** at the session's
   `history/sessions/<session>/trail/tool_results/` to
   confirm full bodies are being persisted. If they are missing,
   `tomAi_readPastToolResult` falls back to "no key" and the model loses
   recovery — but the in-message stub still contains enough context
   (tool name + input summary + size) to retry the original call.

---

## 10. Glossary

- **Configuration** — a named backend entry under
  `localLlm.configurations[]` or `anthropic.configurations[]`. May override
  any compaction-level cap.
- **Profile** — a system-prompt overlay that binds to a configuration.
- **History** — the inter-turn user/assistant message list. On `trim_and_summary`
  this is split into a running `compactedSummary` (string) plus a small
  `rawTurns` array of recent verbatim pairs.
- **Tool trail** — the in-turn `tool_use` / `tool_result` pairs. Bounded by
  `toolTrailKeepRounds` (inline window) and `toolTrailMaxResultChars`
  (per-result cap). Stubbed entries are recoverable by key via
  `tomAi_readPastToolResult`, which now reads from disk too.
- **Compaction** — running an LLM to rewrite older raw turns into the
  `compactedSummary`. Driven by the template selected by
  `compactionTemplateId`. Runs every turn that overflows the raw-turn budget.

---

## 11. Telegram — per-quest configuration location

The Telegram remote-control / notification channel is configured **per quest**,
not in the central `.tom/tom_vscode_extension.json`. Its settings are owned by
`extensionConfigStore.ts` (read/written via `telegram-config.ts`) and split
across two consolidated per-quest files by whether the value is host-invariant:

| File | Scope | Telegram keys |
| --- | --- | --- |
| `_ai/quests/{quest}/extension_config.{quest}.yaml` | machine-INDEPENDENT | `allowedUserIds`, `defaultChatId`, `pollIntervalMs`, `notifyOnStart` / `notifyOnTurn` / `notifyOnEnd`, `includeResponseText`, `maxResponseChars` |
| `_ai/quests/{quest}/extension_config.{hostSlug}.{quest}.yaml` | machine-SPECIFIC | `enabled`, `autostart`, `botTokenEnv` |

The raw bot token is **never persisted** — it is resolved at load time from
`process.env[botTokenEnv]`. Telegram allows only **one `getUpdates` consumer per
bot token**, so each quest needs its own bot. Full command reference, the
live-conversation forwarder, the Status Page section, and the one-receiver
constraint are documented in **[`telegram_integration.md`](telegram_integration.md)**.
