# Chat Log Custom Editor — design draft

A single markdown-based custom editor that renders live conversation logs for all four LLM-interaction surfaces (Local LLM, Anthropic, Tom AI Chat, AI Conversation), with transport-switching tabs, activity indicators, streaming updates, auto-scroll, copy-paste-able text, and prominent tool-call blocks.

## 1. Goal

Today the user has no unified view of what an LLM is doing while it runs. Trail files exist (per-transport raw trail + summary `.prompts.md` / `.answers.md` under `_ai/`) but they are:

- Not updated live — they're written after the turn ends.
- Not a rich chat render — the summary `.md` is a raw text dump.
- Spread across four subsystems — switching requires opening different files.

The **Chat Log custom editor** replaces this with a single VS Code custom editor that:

- Renders the current session's conversation for a chosen transport in a structured form (user/assistant/tool roles clearly delineated).
- Updates live as the model streams its reply.
- Auto-scrolls to keep the latest content visible (until the user manually scrolls up, then stops).
- Has tabs for each of the four transports and each tab shows an activity indicator when a turn is in flight.
- Lets the user **copy-paste** any part of the rendered conversation (including tool invocations and results).
- Visually distinguishes tool calls (syntax-highlighted JSON input + collapsible output preview) from regular model text.

This is a **presentation layer** only. It does not own any conversation state — it subscribes to events from the existing handlers and renders them.

## 2. Why a new custom editor (not the MD browser)

The existing MD browser custom editor ([markdownBrowser-handler.ts](tom_vscode_extension/src/handlers/markdownBrowser-handler.ts)) renders static `.md` files via `marked` + `mermaid`, with a reload button and picker. Differences that argue for a new editor:

| Concern | MD browser | Chat Log |
| --- | --- | --- |
| Content source | static file on disk | live event stream |
| Updates | manual refresh button | streaming append, auto-render |
| Auto-scroll | n/a | required while reply streams |
| Tabs | n/a (one file per panel) | 4 transport tabs with activity indicators |
| Tool-call rendering | generic markdown | dedicated block with collapsible output |
| Edit | n/a (read-only viewer) | n/a but must support selection + copy |
| Underlying model | `vscode.CustomTextEditor<TextDocument>` | `vscode.CustomEditor` with a **synthetic backing doc** (no file on disk) |

**Reuse from the MD browser:** the marked renderer setup, the codicon CSS link, the VS Code theme variable integration, the syntax highlighting approach. About 30–40% of the CSS is liftable. The outer structure (`getHtmlForWebview`, postMessage pattern, webview-side state machine) is built from scratch — the dynamic/streaming nature makes it easier to start fresh than to bolt streaming onto the static viewer.

## 3. User-facing behaviour

### 3.1 Opening

- VS Code command `tomAi.editor.chatLog` — opens the editor in the active view column.
- Or: a button in each chat panel's action bar (`codicon-output`) that opens the editor pre-selected to that transport's tab.
- Or: via the chat-panel "Open Chat Log" button (to be added in a later change).

### 3.2 Tabs

A tab bar at the top of the editor with four tabs:

```text
[ Local LLM •  ] [ Anthropic ○ ] [ Tom AI Chat ] [ AI Conversation ● ]
```

Per-tab state:

- **`•` (filled blue dot)** — a turn is currently in flight on this transport.
- **`○` (hollow dot)** — no activity, but this transport has history.
- **no dot** — no history yet this session.
- **`●` (pulsing red dot)** — AI Conversation is actively cycling (both participants turning).
- Clicking a tab switches the rendered log; tab state persists across switches.

The active tab is highlighted with a VS Code-accent underline.

### 3.3 Rendering model

Each conversation is an ordered list of **entries**. Entry types:

| Kind | Rendered as | Notes |
| --- | --- | --- |
| `system` | Collapsed box at the top, expandable | System prompt; never shown by default |
| `user` | Left-aligned bubble with user icon | User's input text |
| `assistantText` | Left-aligned bubble with model icon | Streams in; re-rendered as content arrives |
| `assistantThinking` | Collapsed box labelled "Thinking…" | Only shown when the model emits thinking blocks; collapsed by default, 1-click expand |
| `toolCall` | Distinct block: name + JSON input + output preview | See §3.4 |
| `conversationTurn` | Shown in AI Conversation tab only — identifies which participant spoke | Alternating colour strip |
| `status` | Small grey line: "Turn ended (12 tool calls, 4324 tokens)" | End-of-turn summary |
| `error` | Red-bordered box | Handler-level errors |

### 3.4 Tool-call blocks

Each tool invocation renders as a collapsible block:

```text
┌─ 🛠  tomAi_readFile ─────────────────────────────── [✓ 142 ms] ┐
│ { "filePath": "src/extension.ts", "startLine": 1, "endLine": 50 }│
│ ─────────────                                                    │
│ (expand to see result — 1842 chars)                              │
└──────────────────────────────────────────────────────────────────┘
```

- **Header** — tool name, duration, exit status (`✓` or `✗`), approval state if gated.
- **Input** — pretty-printed JSON, monospace, syntax-highlighted.
- **Result** — collapsed by default with a preview line. Expand to see the full result text (or structured summary — see [llm_tools.md](tom_vscode_extension/doc/llm_tools.md) per-tool formatters). Truncation markers shown when > 10 KB.
- **Copy** — a small copy icon per block copies `name(input) → result` as a markdown code block. The whole chat is also copy-paste-able as one selection.

### 3.5 Streaming

- Text entries append chunks as they arrive. Re-rendering happens per chunk but uses a **diffing append** (only the new text is added to the DOM, not a full re-render) to keep streaming smooth and preserve user selection.
- Auto-scroll sticks to the bottom as content arrives, **unless** the user has scrolled up more than ~50 px. If they have, a floating "↓ Jump to latest" pill appears at the bottom; clicking it re-anchors.
- The active tab's activity dot animates while a chunk stream is in flight.

### 3.6 Copy-paste

- All rendered content is selectable text. No fancy tricks — use normal flexbox/div layouts, avoid CSS `user-select: none`.
- Pasted output is plain text with tool-call blocks collapsed to a single line: `tomAi_readFile({filePath: "..."}) → ...`
- A "Copy whole log as markdown" button on the toolbar exports the full rendered conversation as a markdown file.

### 3.7 Stop button

A `codicon-debug-stop` button in the top-right of the editor cancels the currently-running turn on the active tab. Wired to the same cancellation mechanism as the stop button in each chat panel (see the chat_log companion task). When no turn is running, the button is disabled (greyed out).

## 4. Technical design

### 4.1 VS Code custom-editor vs webview-view

Use **`vscode.window.registerCustomEditorProvider`** with a **synthetic URI scheme** (`tomAiChatLog:///`). The editor isn't backed by a file on disk — the synthetic URI lets VS Code treat it as a tab like any other editor (movable, splittable), without persisting state to a file.

Alternative: plain webview panel (`createWebviewPanel`). Rejected because the custom-editor integration gives tab-drag, column-switching, and keyboard navigation for free.

### 4.2 State architecture

Two sides:

**Backend (`src/handlers/chatLog-handler.ts`)**
- Module-level singleton `ChatLogStore` holding per-transport conversations:
  ```ts
  interface ChatLogStore {
    sessions: Record<Transport, ChatLogSession>;
    onDidUpdate: vscode.EventEmitter<{ transport: Transport; entry: ChatLogEntry; append?: boolean }>;
  }
  interface ChatLogSession {
    entries: ChatLogEntry[];
    activeTurn: { startedAt: number; pendingEntryId?: string } | null;
  }
  ```
- Subscribes to per-transport event hooks:
  - Anthropic: hooks in [anthropic-handler.ts](tom_vscode_extension/src/handlers/anthropic-handler.ts) emit `writeRawPrompt`, `writeRawAnswer`, `writeRawToolRequest`, `writeRawToolAnswer`, and thinking-block events.
  - Local LLM: hooks in [localLlm-handler.ts](tom_vscode_extension/src/handlers/localLlm-handler.ts) at `logPrompt` / `logResponse` / `logToolRequest` / `logToolResult`.
  - Tom AI Chat: hooks in [tomAiChat-handler.ts](tom_vscode_extension/src/handlers/tomAiChat-handler.ts) at its equivalent log points.
  - AI Conversation: hooks in [aiConversation-handler.ts](tom_vscode_extension/src/handlers/aiConversation-handler.ts) at turn-start / turn-end + nested per-participant transport events.
- Each open Chat Log editor subscribes to the emitter and receives incremental events.

**Frontend (webview inside the editor)**
- Renders a tab bar + content area.
- Maintains per-tab `entries[]` in memory (initial state sent on webview ready).
- Receives `{ type: 'append', transport, entry }` messages; either pushes or updates the last entry (for streaming append).
- Tracks scroll position; sticks to bottom unless user scrolled up.

### 4.3 Events

Backend → webview:

```ts
type ChatLogMsg =
  | { type: 'init'; sessions: Record<Transport, ChatLogSession>; activeTab: Transport }
  | { type: 'append'; transport: Transport; entry: ChatLogEntry }
  | { type: 'updateEntry'; transport: Transport; entryId: string; patch: Partial<ChatLogEntry> } // streaming chunk
  | { type: 'turnStarted'; transport: Transport; at: number }
  | { type: 'turnEnded'; transport: Transport; stats: TurnStats }
  | { type: 'error'; transport: Transport; message: string };
```

Webview → backend:

```ts
type UiMsg =
  | { type: 'ready' }
  | { type: 'switchTab'; transport: Transport }
  | { type: 'stopCurrent' }              // clicks the stop button
  | { type: 'copyAsMarkdown'; transport: Transport }
  | { type: 'clearHistory'; transport: Transport }
  | { type: 'toggleSystemPrompt'; transport: Transport };
```

### 4.4 Entry streaming

For `assistantText` entries, the backend holds one pending entry per turn:

1. On first chunk: emit `{ type: 'append', entry: { id, kind: 'assistantText', text: chunk } }`.
2. On subsequent chunks: emit `{ type: 'updateEntry', entryId, patch: { text: fullTextSoFar } }`.
   - The webview diffs the incoming text against its stored copy and appends only the new suffix to the DOM.
3. On turn end: emit `{ type: 'turnEnded' }` to clear the activity dot.

For `toolCall` entries: emitted once when the tool is requested, then updated once with result when the call returns. Two updates, not streaming.

### 4.5 Persistence

- **In-memory only per session** — when VS Code reloads, the Chat Log starts empty for all transports.
- Each transport's own trail file under `_ai/trail/…` remains the authoritative durable record. The Chat Log editor is a live view; re-opening it does not replay history.
- Optional future: add a "Load previous session" button that reads the last trail summary files and rehydrates.

### 4.6 Rendering library

Use **vanilla DOM + marked** — same pattern as the MD browser. `marked.parse()` on markdown-formatted assistant text; plain DOM for tool-call blocks and UI chrome. No React / framework overhead. Streaming diff uses `textContent += suffix` on the last leaf node.

### 4.7 Syntax highlighting

For tool-call JSON input and code blocks inside assistant text:

- Keep the existing mermaid + marked setup from the MD browser.
- Add a minimal JSON highlighter (regex-based; ~30 lines) for the tool-call input blocks. Full Prism/highlight.js is overkill and bulky.

### 4.8 Auto-scroll heuristic

```ts
const threshold = 50; // px from bottom
function shouldStickToBottom(scrollerEl: HTMLElement): boolean {
    return scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight < threshold;
}
// Before append:
const stick = shouldStickToBottom(log);
// After DOM update:
if (stick) { log.scrollTop = log.scrollHeight; }
else { showJumpToLatestPill(); }
```

User-initiated scroll-up hides the pill once they're within threshold again.

### 4.9 Tab activity indicator

- A small `<span class="activity-dot">` next to each tab's label.
- CSS class variants: `idle` (hollow dot), `active` (filled blue dot), `cycling` (pulsing red for AI Conversation).
- Backend emits `turnStarted` / `turnEnded`; webview toggles class.

## 5. Required backend hooks (handler-side changes)

For each of the four transports, the handler must emit events to `ChatLogStore` at:

1. **Turn start** — when the user's message enters the dispatcher.
2. **System prompt resolved** — one-shot event with the resolved system prompt (cached so expansion happens once per turn).
3. **Tool request** — per-tool, before dispatch. Carries name + input.
4. **Tool result** — per-tool, after dispatch. Carries result text + durationMs + error flag.
5. **Assistant text chunk** — per streaming chunk from the model. If the handler doesn't support streaming (current Anthropic handler returns full text once), emit one chunk with the whole text.
6. **Thinking block** — if the model emits thinking, one event per block.
7. **Turn end** — with summary stats (round count, tool calls, tokens).
8. **Error** — on handler failure.

This is new work per handler. The existing trail-writing infrastructure already has the right hook points — see [llm_tools.md §4.6](tom_vscode_extension/doc/llm_tools.md) and the investigation notes in the Anthropic handler at line 430, 500–501, 575, 698, 723. The chat log store piggy-backs on those existing call sites.

**Per-transport caveats:**

- **Anthropic handler** — does not stream today. Emit a single chunk with the full assistant text after the API call returns. Streaming can be added later; the editor already supports chunked updates.
- **Local LLM handler** — has streaming support via Ollama's streaming endpoint. Emit per-chunk events.
- **Tom AI Chat** — VS Code LM API has streaming support (`LanguageModelChatResponse.stream`). Wire per-chunk.
- **AI Conversation** — emit per-turn entries with a `participant: 'A' | 'B'` field in the entry so the renderer can colour-code the conversation.

## 6. Stop button wiring

The editor's stop button posts `{ type: 'stopCurrent' }`. The backend:

1. Identifies the active tab's transport.
2. Looks up the in-flight `vscode.CancellationTokenSource` for that transport.
3. Calls `.cancel()`.
4. The handler exits its loop (existing cancellation checks are in place).

Needs a singleton registry of active cancellation tokens keyed by transport — one per handler singleton.

## 7. File layout

```text
src/handlers/chatLog-handler.ts       # ChatLogStore + CustomEditorProvider
src/handlers/chatLog-renderer.ts      # buildHtml() — webview HTML/CSS/JS
src/handlers/chatLog-events.ts        # ChatLogEntry types + event emitter
test/chat-log-handler.spec.ts         # unit tests on event routing
```

Per-transport hook code lives in each handler file, calling `ChatLogStore.instance.emit(...)`. Handlers should not import the renderer — only the store/events module.

## 8. Acceptance criteria

- [ ] Command `tomAi.editor.chatLog` opens the editor in a new tab.
- [ ] Four tabs visible at the top: Local LLM, Anthropic, Tom AI Chat, AI Conversation.
- [ ] Tab switching preserves scroll position and selection for each tab.
- [ ] Sending a prompt to any of the four transports causes the corresponding tab's activity dot to light up immediately.
- [ ] Streaming replies append in real time without re-rendering the whole log.
- [ ] Auto-scroll follows the latest content; scrolling up pauses it and shows "Jump to latest" pill.
- [ ] Tool calls render as distinct blocks with name + input + collapsible result + duration badge.
- [ ] Thinking blocks collapse by default and expand on click.
- [ ] Selecting text across multiple entries copies as plain markdown.
- [ ] Stop button cancels the in-flight turn on the active tab.
- [ ] Editor works in split view (two Chat Log editors open at once, each with independent tab state).
- [ ] Re-opening VS Code starts the editor empty (no disk persistence).
- [ ] Editor theme follows VS Code light/dark without extra code.

## 9. Open questions

1. **Multiple concurrent editors** — two Chat Log editors open in different columns. Do they share tab state or have independent tabs? (Recommendation: shared conversation state, independent active-tab state — each editor shows the same transport's full history, but each picks its own tab.)
2. **Retention** — should the in-memory log be bounded (e.g. last 1000 entries per transport) to prevent memory bloat during long sessions?
3. **Participant labelling for AI Conversation** — use profile name, position ("A"/"B"), or both? (Recommendation: both — "Participant A — Claude Sonnet 4.6".)
4. **Export format** — markdown with YAML front matter (timestamp, transport), or raw markdown? (Recommendation: YAML front matter.)
5. **Prompt-queue integration** — when the queue fires a prompt via a direct-transport (see [multi_transport_prompt_queue.md](tom_vscode_extension/doc/multi_transport_prompt_queue.md)), the chat log entry should mark it "(queued)" for the user to recognize it wasn't entered manually.
6. **Embedded `.md` conversation files** — Tom AI Chat persists to a `.md` file today. Should the Chat Log editor mirror writes to that file, or stay purely in-memory? (Recommendation: stay in-memory; Tom AI Chat's `.md` is authoritative and the Chat Log is a live view.)

## 10. Out of scope (v1)

- Editing entries after they're logged.
- Rerun-from-here / fork-conversation UX.
- Searching across the log (user can Ctrl+F the editor text).
- Persisted session recovery across VS Code restarts.
- Cross-transport conversation merge view.
- Rendering images / vision outputs (no transport uses them today).

## 11. Effort

**Rough estimate: 4–5 days.** The renderer is ~2 days, the per-transport hooks are ~1 day (4 × ~2 h each), the cancellation registry and stop button is ~0.5 day, polish + theme integration ~1 day. The biggest unknown is the streaming implementation for Local LLM and Tom AI Chat — neither currently exposes a streaming API to external subscribers.
