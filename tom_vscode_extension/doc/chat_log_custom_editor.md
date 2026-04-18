# Live Chat Trail — implementation plan

The goal: one rolling, continuously-updating markdown file per quest that shows what the Anthropic transports are doing right now — thinking blocks, tool calls, tool results, assistant text — as they happen. Opens in the existing MD Browser custom editor, which is extended to auto-reload the currently-open file when it changes on disk.

This document supersedes the earlier "full custom editor" design. That spec was broader (tabs for every transport, synthetic backing doc, custom event stream) and overshot the need; see §6 for the pieces of the original spec that are deferred.

## 1. User experience

- **Open Live Trail** icon button in the Anthropic chat panel action bar, next to "Open session history". Click to open `_ai/quests/<quest>/live-trail.md` in the MD Browser.
- The MD Browser re-renders every time the file changes on disk (new feature). Output appears progressively as the turn runs: user prompt → thinking → tool_use → tool_result → assistant text → done.
- The file holds the **last 5 prompt blocks**. When a new prompt starts, the oldest block is removed from the top. File never grows unbounded.

## 2. File layout — `live-trail.md`

Stored at `_ai/quests/<quest>/live-trail.md`. One block per user prompt, newest at the bottom. Example end-state (outer fence uses tildes to avoid collision with the inner backtick fences the example contains):

~~~markdown
<!-- tom-ai live-trail -->

## 🚀 PROMPT 20260418_213045 [anthropic / sonnet-4-6-agent-sdk-mm]

> User: "Rename the field `foo` to `bar` across the codebase and update the tests."

### 🧠 thinking

I'll start by searching for `foo` usages across the project…

### 🔧 tomAi_findTextInFiles `[t12]`

```json
{"pattern": "\\bfoo\\b", "maxMatches": 200}
```

<details><summary>📤 result (4821 chars) — preview</summary>

```text
src/widgets/foo_panel.dart:12:  final foo = …
src/widgets/foo_panel.dart:18:  …foo.doStuff();
…
```

</details>

### 💬 assistant

Found 47 matches across 12 files. I'll edit them in one pass.

### 🔧 tomAi_multiEditFile `[t13]`

```json
{"path": "src/widgets/foo_panel.dart", "edits": [ …shortened… ]}
```

<details><summary>📤 result (86 chars)</summary>

```text
{"success": true, "editsApplied": 9}
```

</details>

### ✅ DONE (rounds=3, toolCalls=5, 12.4s)
~~~

Each block is delimited by a heading-level-2 `## 🚀 PROMPT <ts> [...]` marker so the rolling-window trimmer can cut cleanly on boundaries. The `<details>` / `<summary>` HTML elements around tool results render as collapsible blocks in the MD Browser (which uses `marked` and already tolerates inline HTML).

### 2.1 Event grammar

| Emoji + heading | When | Body |
| --- | --- | --- |
| `## 🚀 PROMPT <ts> [<transport>/<config>]` | `sendMessage` start, right after we've resolved profile/configuration | blockquote of the raw user text (truncated to ~1000 chars) |
| `### 🧠 thinking` | extended-thinking block received (direct path) or SDK emits a thinking event | plain text, one block per received thinking chunk |
| `### 🔧 <toolName> [tN]` | tool_use block encountered; `tN` is the replay key from ToolTrail | fenced JSON of the tool input |
| `<details>📤 result (<N> chars)</details>` | tool_result written | fenced preview (first ~800 chars); "…" when truncated |
| `### 💬 assistant` | assistant text block completes (streaming concatenates until the next event arrives) | raw text, markdown-escaped if it'd otherwise break the outer markdown |
| `### ✅ DONE (rounds=N, toolCalls=M, <N>ms)` | `finalize()` or the agent-SDK return | one-line summary |
| `### ⚠️ ERROR` | try/catch in the new always-write-answer path fires | diagnostic text |

A turn that never produces any assistant text (tool-only, cancelled, errored) still ends with either `✅ DONE` or `⚠️ ERROR` — never an open block.

## 3. Rolling window

Every `## 🚀 PROMPT` header marks a block boundary. Before the writer appends a new PROMPT header, it:

1. Reads the current file.
2. Counts `^## 🚀 PROMPT` lines.
3. If count ≥ 5, drops everything from the top up to (and including) the line *before* the sixth-newest PROMPT header — so the file is left with blocks 2..5 and room for the new one at position 5.
4. Writes the trimmed body back + the new PROMPT header.

Implementation detail: the trim is atomic (`writeFileSync` on a re-read-and-reassembled buffer). There is no concurrent writer in the normal flow — the Anthropic handler owns the live-trail file for its turn. If a second handler were to write at the same time (unlikely — only one send per window), the last-writer-wins semantics of `writeFileSync` are acceptable; we don't promise perfect concurrency.

## 4. Writer — `src/services/live-trail.ts`

New module. One exported class `LiveTrailWriter` with:

~~~ts
class LiveTrailWriter {
    constructor(questId: string);
    /** Start a new prompt block. Trims to last 5 blocks first. */
    beginPrompt(info: { transport: string; config: string; userText: string }): void;
    /** Append a thinking chunk. Streaming-friendly — multiple calls fold into one heading. */
    appendThinking(text: string): void;
    /** A tool_use block was emitted; record the JSON input and the replay key. */
    beginToolCall(toolName: string, input: unknown, replayKey: string): void;
    /** A tool_result was written; append the preview body (will be collapsed in <details>). */
    appendToolResult(resultPreview: string, fullLength: number): void;
    /** Stream-friendly assistant text append. */
    appendAssistantText(text: string): void;
    /** Mark the block done with the per-turn summary. */
    endPrompt(summary: { rounds: number; toolCalls: number; durationMs: number }): void;
    /** Record an error (from the always-write-answer catch branches). */
    endPromptWithError(message: string): void;
}
~~~

All write operations are **append-or-rewrite** against the current file. Calls are synchronous `fs.writeFileSync` with atomic semantics. The writer is cheap to instantiate; the handler keeps one instance per turn.

### 4.1 Trimming algorithm

- Match `^## 🚀 PROMPT ` lines via line-by-line scan (fast — files stay ≤ a few dozen kB).
- If count ≥ 5 at `beginPrompt()` time, slice off lines [0 .. indexOf(5th-newest header) - 1].
- Preserve a single file-header comment `<!-- tom-ai live-trail -->` on line 1 so the file is clearly identifiable.

## 5. Event hooks

### 5.1 Direct Anthropic transport — `anthropic-handler.ts`

- In `sendMessage`, after computing `profile` + `configuration` but before the first `client.messages.create`: call `liveTrail.beginPrompt(...)`.
- Inside the tool loop, after each `client.messages.create` returns:
  - For each `thinking` block in `response.content`: `liveTrail.appendThinking(text)`.
  - For each `text` block: `liveTrail.appendAssistantText(text)`.
  - For each `tool_use` block (before `this.runTool()` runs): `liveTrail.beginToolCall(name, input, replayKeyFromToolTrail)`.
  - After `this.runTool()`: `liveTrail.appendToolResult(preview, fullLength)`.
- In `finalize()`, at the end: `liveTrail.endPrompt({rounds, toolCalls, durationMs})`.
- In the catch branch added in the "always-write-answer" change: `liveTrail.endPromptWithError(errMsg)`.

### 5.2 Agent SDK transport — `agent-sdk-transport.ts`

- `runAgentSdkQuery` accepts a `liveTrail?: LiveTrailWriter` on its params (passed through from the handler — the handler instantiates).
- Inside the `for await (const msg of stream)` loop:
  - `msg.type === 'assistant'`: iterate content blocks, call the right `append*` per block type (thinking / text / tool_use).
  - The MCP `canUseTool` callback in `makeCanUseTool` already sees tool inputs — harder to hook tool results from there cleanly. Simpler path: keep using the `toolTrail.add` call in `canUseTool` and mirror that into the live trail from a new callback the writer registers.
- On the `result` message: `endPrompt(...)`.
- On `catch`: `endPromptWithError(...)`.

### 5.3 ToolTrail coupling

The replay key (`tN`) shown in the `[t14]` badges next to each 🔧 tool call comes from the existing `ToolTrail.add()` return value. We already expose `getActiveToolTrail()`; the writer either reads keys from the last-added entry after `toolTrail.add()` or accepts the key as an argument to `beginToolCall()`. The latter keeps dependencies one-way.

## 6. MD Browser — auto-reload-on-change

New behaviour in `markdownBrowser-handler.ts`:

1. When the browser renders a file, store that file path on the active panel state.
2. Create an `fs.FSWatcher` (or `vscode.workspace.createFileSystemWatcher`) on the current path. Dispose on file navigation or panel close.
3. On change events, debounce by ~200 ms, then re-render the webview with the new content.

Debounce is important — writes happen per event and a naive re-render per write would flash. 200 ms is below the human perception threshold for a progress feed but above the rate at which the Anthropic loop writes events.

One existing browser panel per window is reused (no duplicate panels). When the user navigates to a different file inside the browser, the watcher re-targets.

## 7. Chat panel button

New icon button in the Anthropic chat-panel action bar:

~~~html
<button class="icon-btn" data-action="openLiveTrail" data-id="anthropic"
    title="Open live trail — continuously-updating MD of the current and last 4 prompts">
    <span class="codicon codicon-pulse"></span>
</button>
~~~

Placed between "Open session history" and "Memory Panel". Action routes to a new `_openLiveTrailMarkdown()` method on the chat-panel handler that opens `_ai/quests/<quest>/live-trail.md` via `tomAi.openInMdBrowser`.

## 8. What this ships and what it doesn't

**Ships (this change):**
- Anthropic paths (direct + Agent SDK) emit events to `_ai/quests/<quest>/live-trail.md`.
- Rolling 5-block window.
- MD Browser auto-reloads the currently-open file on disk change (benefits every MD the browser displays, not just the live trail).
- Chat-panel "Open Live Trail" button.

**Deferred (original full-spec scope):**
- Per-transport tabs in a single custom editor. The MD Browser isn't a tabbed surface; one file per quest is the unit here.
- Local LLM + Tom AI Chat + AI Conversation live trails. Same pattern would work but requires distinct event hooks in each handler — separable follow-up.
- Auto-scroll-to-bottom + "pause auto-scroll when user scrolled up" behaviour. The MD Browser re-renders from the top; for long blocks the user scrolls manually. A small improvement is to anchor the scroll position to the nearest `<a id="…">` anchor the writer inserts at block boundaries — left for v2 if the flashing on re-render becomes annoying.
- Live streaming of text blocks *character-by-character* for the direct Anthropic path. The current plan appends in chunks at the granularity of what the non-streaming API returns (one text block per loop iteration); that's already ~100 ms granularity in practice.

## 9. Testing

- Start a new session, send a prompt that runs 2–3 tools. Open Live Trail during the turn — verify the file visibly updates without manual refresh.
- Send five more prompts. Verify the file never holds more than five blocks (old ones drop off the top).
- Cancel a turn mid-way. Verify the last block ends with `⚠️ ERROR` rather than a dangling `🧠 thinking`.
- Rapid back-to-back sends. Verify no partial or interleaved content — the writer is synchronous, so each call completes before the next begins on the same handler.
