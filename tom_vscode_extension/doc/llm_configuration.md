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

---

## 1. Two distinct accumulators — history and tool trail

A long agent session has two sources of context growth that need separate
treatment:

1. **History.** Each turn appends one user/assistant pair to
   `conversationHistory` (Local LLM) or to `rawTurns` (Anthropic). Across many
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
| `toolTrailMaxResultChars` | `1000` | Each tool_result block kept inline is truncated to this many chars; a `[Truncated inline view: N/total chars. Full result available via tomAi_readPastToolResult({"key":"tX"})...]` marker is prefixed so the model knows where to look. |
| `toolTrailKeepRounds` | `2` | The most-recent N tool rounds keep (truncated) bodies inline. Tool rounds older than this have their `tool_result` content replaced with a one-line stub naming the replay key. The `tool_use` / `tool_result` pairing is preserved so the Anthropic API stays happy. |

### Where the bodies live

Every tool result that runs through either handler is **persisted to disk**
under the active quest's trail folder. Layout:

```text
_ai/trail/anthropic/<quest>/tool_results/t14.json
_ai/trail/localllm/<quest>/tool_results/t14.json
```

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

- Local LLM: [`applyLocalLlmToolTrailPolicy`](../src/handlers/localLlm-handler.ts) runs after every tool round in `ollamaGenerateWithTools`.
- Anthropic: [`applyToolTrailRetentionPolicy`](../src/handlers/anthropic-handler.ts) runs after each `messages.push({ role:'user', content: toolResults })` in the direct-SDK tool loop.

Both paths share [`ToolTrail.truncateInline`](../src/services/tool-trail.ts) and
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
| `maxHistoryTokens` | `8000` | Token target for the compactor's output (`${maxHistoryTokens}` placeholder). Also used as the safety token cap in batch summary mode. |
| `historyMaxChars` | `24000` | Hard cap on the `${existingSummary}` / `${compactedSummary}` injected into the compactor's *own* prompt. Tail-bounded (newest portion kept). |
| `memoryMaxChars` | `8000` | Hard cap on `${existingMemory}` injected into the memory-extraction prompt. Head-bounded (newest entries kept — memory files are prepended newest-first). |
| `compactionTemplateId` | active id from `compaction.templates[]` | Which template renders the prompt sent to the compactor LLM. |
| `compactionMaxRounds` | `1` | Tool-call rounds allowed during one compaction pass (Local LLM only — Anthropic compaction is single-shot). |
| `fullTrailMaxTurns` | `200` | Safety cap on `historyMode: full`. |

Per-configuration overrides live directly on the configuration entry:

```jsonc
{
  "id": "bomber-gemma4-26b-8001",
  "model": "gemma4-26b-a4b",
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

- Anthropic: [`resolveEffectiveCaps`](../src/handlers/anthropic-handler.ts)
- Local LLM: [`resolveEffectiveLocalLlmCaps`](../src/handlers/localLlm-handler.ts)

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
| `trailMaximumTokens`, `trailSummarizationTemperature`, `removePromptTemplateFromTrail` | Trail viewer | Visual / summarisation hints for the trail UI; not used in model requests. |
| `answerFolder`, `logFolder` | Trail layout | Folder overrides for per-config trail output. |
| `isDefault` | Picker | One configuration may be flagged default. |

### 5.2 `profiles[…]` — system prompt overlays

A profile binds a system prompt (with optional template overrides) on top of a
`modelConfig`. Fields are unchanged from before — `label`, `systemPrompt`,
`resultTemplate`, `temperature`, `modelConfig`, `toolsEnabled`, `enabledTools`,
`maxRounds`, `historyMode`, `stripThinkingTags`, `isDefault`.

The profile's `systemPrompt` does NOT receive history placeholders. History
arrives as conversation messages, not template variables (see §4).

### 5.3 Top-level `localLlm.historyMode`

Read as a default for profiles that don't override it. Same enum as §3.

### 5.4 Backends (`apiStyle`) and Bearer auth (`apiKeyEnv`)

The Local LLM transport speaks two protocols, selected per configuration by
`apiStyle` (default `'ollama'`):

| `apiStyle` | Discovery | Chat endpoint | Backends |
| --- | --- | --- | --- |
| `'ollama'` (default) | `GET /api/tags` | `POST /api/chat` | Ollama |
| `'openai'` | `GET /v1/models` | `POST /v1/chat/completions` | **Any OpenAI-compatible server** — vLLM, LM Studio, llama.cpp (`llama-server`), and similar |

`ollamaUrl` is the base URL for **both** styles (the field name is historical);
point it at the OpenAI-compatible server's root (e.g. `http://bomber.vpn:8001`)
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

`apiKeyEnv` lives on each `localLlm.configurations[i]` **and** on
`localLlm.profiles[…]`, and is threaded through to the synthesised Anthropic
profile path (`resolveAnthropicTargets`) so a Local LLM configuration that backs
an Anthropic profile authenticates the same way. The history compactor honours
`apiStyle` too — see `services/history-compaction.ts` — so a vLLM/llama.cpp
configuration used as the compaction backend hits the OpenAI path as well.

The Status Page Local LLM card surfaces both fields: an **API style** dropdown
(Ollama / OpenAI) and an **API Key Env** input.

---

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
| `compactionOverride` | `'default' \| 'on' \| 'off'` — per-config override for the global compaction kill switch. |
| `promptCachingEnabled` | Adds `cache_control` blocks. Doesn't shrink the prompt; reduces cost. |
| `transport` | `'direct'` / `'agentSdk'` / `'vscodeLm'`. Tool-trail enforcement applies to `'direct'`. |
| `memoryToolsEnabled` | Expose memory read/write tools to the model. |
| `maxRounds`, `maxTokens` | Standard agent loop knobs. |

---

## 7. History Compaction (`compaction` section) — defaults & system-wide flags

These act as fallbacks for any per-configuration override. They also control
behaviour that is genuinely system-wide (e.g. the global kill switch).

| Field | Default | Where used |
| --- | --- | --- |
| `disabled` | `false` | Global kill switch for the post-turn compaction + memory-extraction pass. Also suppresses the **automatic** trail-based history rebuild on session seed (so a disabled compactor makes no LLM/Ollama calls on a fresh session); the explicit "Recreate History" button still forces a rebuild. Per-config `compactionOverride` wins. |
| `llmProvider` | `'localLlm'` | Picks Anthropic vs Local LLM as the compactor backend. |
| `llmConfigId` | — | Configuration id within the chosen provider. |
| `compactionTemplateId` | — | Active compaction template (`compaction.templates[]`). |
| `memoryExtractionTemplateId` | — | Active memory-extraction template. |
| `compactionMaxRounds` | `1` | Local-LLM compactor tool loop. |
| `maxHistoryTokens` | `8000` | Fallback compactor token budget. |
| `historyMaxChars` | `24000` | Fallback char ceiling on `${existingSummary}` / `${compactedSummary}`. |
| `memoryMaxChars` | `8000` | Fallback char ceiling on `${existingMemory}`. |
| **`rawTurnsKept`** | `4` | Fallback raw-turn-pair count for `trim_and_summary`. |
| **`toolTrailMaxResultChars`** | `1000` | Fallback per-result inline truncation (now wired in both tool loops). |
| **`toolTrailKeepRounds`** | `2` | Fallback in-message keep window for tool_result blocks. |
| `fullTrailMaxTurns` | `200` | Safety cap on `historyMode: full`. |
| `backgroundExtractionEnabled` | `true` | Anthropic background `llm_extract` pass on/off. |
| `runMemoryExtractionOnCompaction` | `true` | Memory extraction runs after every compaction pass. |
| `rebuildFromLastNPrompts` | `200` | Anthropic — number of trail-file entries used to seed history when no `history.json` exists. Only runs the LLM fold when compaction is enabled (`disabled: false`) or the rebuild was forced via "Recreate History". |
| `archiveHistoryEveryTurn` | `false` | Debug toggle: write a timestamped `history.json` snapshot per turn. |
| `templates[]` | — | Compaction prompt templates (id, name, body, targetMode). |
| `memoryExtractionTemplates[]` | — | Memory-extraction prompt templates. |

---

## 8. Example walk-through — `Gemma4:26b-bomber` with the new defaults

Config (relevant excerpt):

```json
{
  "localLlm": {
    "configurations": [
      {
        "id": "bomber-gemma4-26b-8001",
        "name": "gemma4-26b-a4b on bomber.vpn:8001 (vLLM)",
        "apiStyle": "openai",
        "ollamaUrl": "http://bomber.vpn:8001",
        "model": "gemma4-26b-a4b",
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
    "llmProvider": "localLlm",
    "llmConfigId": "bomber-gemma4-26b-8001",
    "compactionTemplateId": "default-compaction",
    "memoryExtractionTemplateId": "default-memory-extraction",
    "compactionMaxRounds": 40,
    "maxHistoryTokens": 16000,
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
- Both full bodies were written to
  `_ai/trail/localllm/<quest>/tool_results/t1.json` and `t2.json` on tool
  execution.

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

The Tom AI Local Log channel now prints per-round summaries with the assigned
ToolTrail key:

```text
[Round 4] Tool #5 key=t12: tomAi_findTextInFiles
  Args: {"query":"foo"}
  Result (61823 chars): …
[history] compactedSummary updated → 9143 chars
[process] Passing 11 history message(s) to Ollama (mode=trim_and_summary, summaryChars=9143, rawTurns=8)
```

The keys (`t12` here) match the names that will appear in stub lines and in
`tomAi_readPastToolResult({"key":"t12"})`.

---

## 9. Quick troubleshooting

When a Local LLM call still hits the context limit:

1. **Check the log channel** for a high `summaryChars` or a high
   `Result (NNNN chars)` line. The summary grows up to `historyMaxChars`; if
   yours is set very high (e.g. 60k) you can tighten it.
2. **Lower `toolTrailKeepRounds`** to `1` (or `0` — older rounds become stubs
   immediately). The first inline round is still truncated to
   `toolTrailMaxResultChars` so even one round can't blow the window.
3. **Lower `toolTrailMaxResultChars`** to e.g. 500.
4. **Lower `rawTurnsKept`** so older turns roll into the summary faster.
5. **Inspect the disk store** at
   `_ai/trail/localllm/<quest>/tool_results/` (or `anthropic/...`) to
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
