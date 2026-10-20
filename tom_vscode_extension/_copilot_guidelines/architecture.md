# Extension Architecture

## System components

The plugin runtime consists of:

- VS Code extension host ([src/extension.ts](../src/extension.ts)),
- handler modules under [src/handlers/](../src/handlers/) — UI entry points + webview providers,
- services under [src/services/](../src/services/) — persistence (trail, history, memory, tool trail, live trail),
- managers under [src/managers/](../src/managers/) — volatile session state (queue, timer, reminder, chat variables, session todos),
- tool implementations under [src/tools/](../src/tools/) — everything exposed to AI models,
- bridge client integration ([vscode-bridge](../src/vscode-bridge.ts) + handler),
- Agent SDK transport ([agent-sdk-transport.ts](../src/handlers/agent-sdk-transport.ts)) over `@anthropic-ai/claude-agent-sdk`, and
- externalized webview assets under `media/<panelId>/` loaded via [webviewLoader.ts](../src/utils/webviewLoader.ts), plus shared webview components (accordion, tabs, queue entry).

## Layering rules

```text
handlers/     UI entry points; command + webview wiring, approval UI
  ↓ may call
managers/     session-scoped state (queue, reminders, chat variables)
services/     persistence (trails, history, memory, tool trail)
tools/        pure dispatch + service reads; tool-use contract to the model
utils/        config, schema, path + variable resolution
```

- Handlers own VS Code UI coupling. No service module imports a `vscode.webview*` surface.
- Services own I/O. Tools read them; handlers ask tools to dispatch.
- `tools/` does not import `handlers/`. `services/` does not import `handlers/` or `tools/`.

## Activation flow

During activation, the extension:

1. initializes the bridge client (fail-soft),
2. registers commands, key systems, and webviews (`@CHAT`, `@WS`, `@TOM` sidebar views),
3. initializes stores (chat variables, session todos, queue, timer, reminder),
4. registers shared tools + variable resolvers,
5. registers custom editors (quest todo, markdown browser, trail viewer),
6. starts queue watchdog and timed-request timer engine,
7. writes window state file for multi-window status tracking.

## Panel architecture

- **`@CHAT`** (`tomAi.chatPanel`) — five chat subpanels (Anthropic, Tom AI Chat, AI Conversation, Copilot, Local LLM) with per-subpanel action bars. See [tom_ai_chat.md](tom_ai_chat.md) and [tom_ai_bottom_panel.md](tom_ai_bottom_panel.md).
- **`@WS`** (`tomAi.wsPanel`) — workspace / ops panel with guidelines, docs, quest, logs, settings, issues, tests.
- **`@TOM`** sidebar — tree views for notes, todos, todo log, window status.
- **Markdown Browser** (`tomAi.markdownBrowser`) — standalone custom editor with link resolver, debounced file watcher, navigation history, and live-mode follow-tail (used by the "Open Live Trail" chat-panel button). Context-menu opens always create a **new** panel; the "Open Live Trail" button reuses a single live-panel singleton. In-place editing (answer buttons after `**Answer:**`, edit mode): the webview renders each top-level block in a `.mdb-block` wrapper and maps blocks and markers to file lines with `media/markdownBrowser/blocks.js` (pure, vm-tested); this works because `transformMarkdown` keeps every line in place; with CR/LF on, the handler sends `lineMap` (`crlfLineMap` in markdownHeadings.ts: shown line → file line, -1 for a line the conversion split or changed; null when nothing was converted), and the webview offers editing only on blocks whose lines map to consecutive file lines (`mapRange`, `blockEditable`) and posts every edit with file line numbers (`toFileEdit`). A save posts `applyEdit` {startLine, endLine, expected, replacement}; the handler applies it with `applyMdLineEdit` (`src/utils/markdownBrowserEdits.ts`), which refuses when the lines no longer hold `expected`, and refuses a file dirty in an editor. Folding: each heading carries its own flag (`foldState`, keyed by level, text and occurrence so it survives same-file re-renders); what is hidden follows from the flags through `mdbFoldHidden` in `blocks.js` (a section runs to the next heading of the same or a higher level), applied as the `mdb-folded-away` class on the content's top-level elements. Rendering is grouped (`mdbGroups`): an html token that opens an element (`<details>` in the live trail) is rendered and wrapped together with everything up to its close, or the wrapper would tear the element apart. Render cost must stay linear and must not block the window — large documents (a 6 MB spec, 100k top-level elements) are viewed and edited:
  - marked is called with `marked.defaults` merged into the options (`markedOptions()`); passing an options object alone replaces the defaults and turns GFM — tables, strikethrough — off.
  - `renderDocument` is a list of tasks run by `runTasks`, which for a large document (over `LARGE_DOC_CHARS`) yields to the event loop every `TASK_BUDGET_MS`: lex the text in parts (`mdbSplitForLexing` cuts before ATX headings outside fences and open html, so the tokens equal those of the whole; link definitions are merged before parsing), parse each part, build and decorate the blocks off-DOM in batches of `RENDER_BATCH`, group them into `.mdb-section` elements of `SECTION_BLOCKS`, and show the result by swapping the one `.mdb-doc` element inside `contentArea`. A render generation cancels a superseded one; `aria-busy` is set while it runs. Never clear a large rendered tree node by node: once anything in it has had focus, Chrome stalls for seconds to minutes on that.
  - Large documents get the `mdb-large` class: `content-visibility: auto` on their sections, with an estimated `contain-intrinsic-size` (`auto`, so the real height is kept once laid out). Content-visibility on 100k single blocks still cost one ~2.5 s style frame when shown and left blank pages while scrolling; on ~670 sections the first frame is under 0.1 s. An IntersectionObserver (`observeSections`, root margin two screens) marks the sections around the view `mdb-near` (`content-visibility: visible`) and keeps the last `NEAR_KEEP` that left that range, so pages ahead and behind are ready. The document's top-level elements are the sections' children: use `topElements()`, `isTopElement()`, `topElementOf()`, never `docRoot.children`. A patch whose region crosses two sections renders in full.
  - The file bar's `Line X / N` (`updateLinePos`, on scroll and when a section is laid out) reads the block at the top of the view; over a section not laid out yet it interpolates and shows `≈`.
  - A refresh carrying the text already shown renders nothing. After a successful save, `patchAfterSave` applies the edit to the shown text and re-renders only the touched blocks and the one before them (an edit may merge into it), shifting the line ranges of the blocks after; it falls back to a full render when the replacement holds a heading, a fence or html, or the region is not bounded by blank or heading lines. The file's own refresh that follows is then the same text.
  - Editing controls read their block's lines when clicked, never at render time, so they stay right after a patch moved them. The edit range starts at the blank lines before the block, so removing the leading newline merges it with the previous block; the textarea's value is sent exactly as typed.
  - Walk snapshots, never a live collection while inserting; clone one template for repeated elements; one delegated listener for their clicks; write only the DOM state that changes.

  - The edit / insert controls are in every editable block's markup (`BLOCK_ACTIONS_HTML`) and shown by `body.mdb-edit-mode`; switching edit mode touches no block. All clicks in the content — links, section references, block actions — go through one delegated listener; the block of a wrapper is `wrapper.__mdbBlock`.
  - Links in plain text are added once per render (or patch) by `linkify`, only for blocks whose HTML can hold one (`LINKABLE_HTML`): `mdbMdPaths` (plain-text `.md` paths, sent to the backend's `resolveLink` like any link) and `mdbSectionRefs` (`OUTER > INNER`), the latter only when `mdbResolveSectionRef` finds a heading by its dotted full id (`data-fullid`, indexed by last id in `headingsById`). Following one, or an in-document anchor, goes through `jumpWithinDocument`, which records the previous position for the document back / forward arrows (the top visible element and its offset, or `scrollTop` when that element was re-rendered).
  - Search indexes the lower-cased text of each top-level element once per render or patch and paints matches with the CSS Custom Highlight API (`mdb-search`, `mdb-search-current`), never by changing the DOM; queued keystrokes are searched once. Matches are uncapped (two number arrays, element index and offset): a cap left a short query with no match past the start of a large document, so it could not begin at the reader. A search starts at the current match while it is in view, else at the block at the top of the view (`searchStart`, binary search in `matchAtOrAfter`), wrapping to the first. `revealElement` returns at once when nothing is folded — walking 100k elements per search step was most of its cost.
  - The panel's history (`src/utils/mdBrowserHistory.ts`) keeps a `ReadingPosition` per entry — the source line of the block at the top of the view, its offset, and `scrollTop` as a fallback. The webview sends it with `goBack` / `goForward` / `navigateLink` and, debounced, as `readingPosition` after scrolling; `mdContent` carries it back on back / forward, and `restoreReadingPosition` keeps placing that block over the next frames until it holds still (lazily laid-out blocks change height as they come on screen), stopping when the reader scrolls.
  - Reviewing (vscimpa11): the `reviewMark` marked extension wraps every rendered mark in `.mdb-rm` (`data-kind` change / note, `data-raw` its markup) with accept / reject or remove buttons shown in edit mode. A click posts `reviewMark` (the block's lines, the markup and its occurrence among equal markups in the block, the decision); `reviewAllChanges` comes from the action bar. The host decides with the TomSpecs runtime's annot4 API in `src/services/review-marks.ts` — the text held as one content value of a scratch `SpecDocument`, so any Markdown file works, read-only SOM documents included (`decideMark`, `decideAllChanges`, `reviewMarkEdit`) — and writes the file (`_editableFile` / `_writeAndRefresh`, reply before refresh). One-click edits from the webview (an option as the answer, removing a comment block) go through `postEdit` with `notifyOnError`. Questions: `mdbQuestionAt` (blocks.js, MB-18) reads the question an answer belongs to — options `(a)`…, the recommended one (bold, else "recommended", else a `*Recommendation:*` letter); answer buttons carry `data-unanswered`; the navigation (`navigate`, `NAV_TARGETS`) walks the DOM elements of every kind ticked in `#navKindPop` (checkboxes `data-nav-kind`; `navSelector` joins their selectors, so `querySelectorAll` gives document order; `#navKindBtn` names them) and opens an unanswered answer prefilled while *Unanswered* is ticked (MD-19). A target's position is `navKey` (`{line, ord}`: source line, a mark's index among its block's marks; an answer button's line from `__mdbLine`). When a save (`editResult`: behind the edited region) or a decision (`decideReviewMark`: at the decided mark) replaces the element navigated to last, `navAnchor` holds that position and `mdbNavPick` (blocks.js, MB-19) picks the next / previous target from it; a change of the ticked kinds keeps stepping from the current target while it still matches, else anchors at it. `jumpWithinDocument(target, context, keep)` puts `navContext` (the question's block, the paragraph before a comment block) at the top unless `keep` (the target or the opened answer editor) would leave the view (`mdbRevealDelta`, MB-20). `openEditor(..., next)` adds *Save and next* for answers; `next(saved)` runs on the patched document, or after the full render (`afterNextRender`) when the edit could not be patched. `patchAfterSave` sets `shownText` before decorating the new blocks, so a just-written answer is not `data-unanswered` (MD-16 – MD-18). Reload sets `forceRender`: the next `mdContent` is rendered even with unchanged text, open editors removed (MD-20). Every change posted to the host (`applyEdit`, `reviewMark`, `reviewAllChanges`) calls `beginBusy` — `body.mdb-busy`, `#busyOverlay`, `inert` on the content, a 20 s safety end — and `editResult`, `mdContent` or the host's `actionDone` (a review decision that changed nothing or failed) calls `endBusy` (MD-21). `updateEditorLocks` disables the search box, its buttons and the navigation while `openEditors > 0`, and `navigate` refuses then (MD-22).
  - Review comment blocks (`> ⬆️ **C-12** (author): …`, tom_specs annot1): `parsePart` flags a blockquote token whose first line starts with the arrow as `block.comment`; such a block gets `COMMENT_ACTIONS_HTML` (add another comment) instead of the raw edit / insert, and an always-visible reopen button from `decorateWrapper`. The notation lives in `blocks.js` (`mdbIsCommentLine`, `mdbCommentAt`, `mdbNextCommentId` — highest `C-<n>` + 1, or the runtime's next number when higher —, `mdbInRanges`, `mdbWriteComment`, MB-16); the author of a comment that names none is the OS user, sent by the handler with every `mdContent` (`author`, from `src/utils/osUserName.ts`: the first name of the account's full name, else the login); an editor result `{hold: message}` makes `openEditor` show the message and wait for the next Save, which is how removing an emptied comment is confirmed. For a SOM Markdown file the handler then posts `somComments` (`nextCommentNumber`, `formFieldRanges`, and the `contentLength` of the text it was read from): `src/services/som-review-comments.ts` reads them with the TomSpecs runtime — annot2's `SpecReviewAnnotations.nextCommentId`, and the form-field lines of every form section, found by matching the file's headings to `toMarkdownWithMap`'s heading paths in order (level + id, so a file the import does not reproduce exactly still maps) and applying the codec's label rule — in a worker thread (`som-review-comments-client.ts` / `-worker.ts`; one request at a time, a waiting one overtaken by a newer one is dropped). The webview hides the comment button of a block in a form-field range (`mdb-no-comment`) and drops the reading when the text changes.
  - The link popup posts `navigateLink` with `newPanel: true`; the handler then opens the target with `openMarkdownBrowser(..., { anchor })` instead of navigating this panel.

  `mdBrowserFolding.dom.test.ts` MF-9 holds the linear, batched bound; `mdBrowserNavigation.dom.test.ts` MN-1 to MN-6 hold links, document navigation, the popup, search and the edit-mode switch; `mdBrowserEditing.dom.test.ts` MD-8 to MD-10 hold GFM, the patch and the skip. Indenting by heading level uses `mdbIndentDepths` (heading at level − 1, its content at level) times the dropdown's spaces, as `margin-left` in `ch` on the same elements.

## Webview asset layout

Webview HTML/JS/CSS is **not** embedded in TypeScript template literals. Every panel's assets are authored as real files under `media/<panelId>/` (`index.html` + `main.js` + `style.css`, with reusable pieces under `media/shared/`) and loaded through one uniform rewriting loader, [src/utils/webviewLoader.ts](../src/utils/webviewLoader.ts). This is the standard for all new and migrated webviews — the move out of template literals is complete (webview restructuring plan Phases A + B).

- **Single loader, minimal rewriting.** `loadWebviewHtml(webview, panelId, opts?)` does only: substitute the four fixed placeholders (`{{cspSource}}`, `{{nonce}}`, `{{baseUri}}`, `{{sharedUri}}`), inject a nonce-only CSP **iff** the document declares none, nonce every un-nonced `<script>`, and inject the first-paint `init` payload as `window.__INIT__` (with `</` escaped). Unknown `{{...}}` tokens are left untouched.
- **`init` vs `postMessage`.** First-paint data known at construction time flows through `init`; everything that changes after load flows through `postMessage`. Per-render data is never string-substituted into the HTML.
- **Callers must** add `media` to `localResourceRoots`, or no externalized asset loads.
- **Toolchain.** Media JS is lintable/typecheckable on its own (`npm run lint:media`, `npm run typecheck:media` via `tsconfig.media.json`); new media JS carries `// @ts-check`, verbatim legacy extractions carry `// @ts-nocheck`. A shared textarea-completion client (`media/shared/completion.js` + `wireCompletionMessages`) is opt-in per textarea.
- **Documented non-migrations** (kept inline by design): content-injection preview shells (markdown content arrives via `postMessage`), and degenerate error-fallback pages assigned directly to `webview.html` only when the normal render path fails. These are excluded from the "no remaining `webview.html = \`...\`" completion gate.

Day-to-day authoring reference (placeholders, `init`/`postMessage`, the inline-handler CSP gotcha, the exceptions): [media_webview_migration.md](media_webview_migration.md).

## Data and state

Primary session / state managers:

- `ChatVariablesStore` — chat variable resolution for templates.
- `ProcessStateStore` (`src/managers/processStateStore.ts`) — the active quest's process and its position. Definitions come from `_ai/processes/<id>/<id>.process.yaml` + `<id>.md`, the state from `_ai/quests/<quest>/process-state.<quest>.yaml` (shared `_ai`, so the same in every window and on every machine); both are file-watched, and the `quest` chat variable selects which state is read. It supplies the process chat variables to `ChatVariablesStore` as **derived, read-only** values (`registerDerivedVariables`): they read like built-ins (`getRaw`, template values, `${name}`), `tomAi_writeChatVariable` refuses them, and changes go through `apply` / `stepIteration`, which validate against the definition, write the state file and set `role` as `roleAfterMove` says: the role of the new step when the position moved, `default` when the process was cleared. The IO-free rules — validation (mirrored by `src/config/process.schema.json`, kept in step by the PD-10 test), moves between states, repair of a stale state, the chat-variable values and the `${process-context}` block — live in `src/utils/processDefinition.ts`; the files in `src/utils/processRepository.ts`. Views: the @TOM **PROCESS** view (`processPanel-handler.ts`, `media/processPanel/`) and the process editor (`processEditor-handler.ts`, `media/processEditor/`); tools: `src/tools/quest-process-tools.ts`.
  - **Action bar.** `availableMoves(def, state)` (processDefinition.ts) lists the moves from the current position — proceed / skip / back at a position; at a decision position proceed ("Decide…") followed by its options, marked `branchOption` (finish / gate-passed / finish-process, gate-failed, repeat *level*), and back — each with the state it leads to; a gate is always repeatable (`repeatView`), `completed` in the state marks a finished process and `decision` the decision after a position (read from an older file's `ran`; dropped by every move and change of position). `isDecisionPoint(pos)` is structural: a gate's end, a phase's end, a repeatable sub-step, the end of a repeatable step; nothing in the definition marks it. `decisionOptions` builds the options; a failed gate goes to `gate.onFail` (a step of its phase, validated) or runs again. `decisionAt(def, state)` gives the options at a decision; `processContextBlock` tells the agent the decision is the user's. Proceed is the only move that runs anything: it leads to the next position, or — at a decision point — to its decision. At a decision the PROCESS view shows a banner with the options (moves with `branchOption`, kept out of the action bar) and Proceed opens a modal with them (`decisionDialog`, processActionPrompt.ts); `confirmProcessAction` refuses to queue at a decision. The process editor's gate card sets `onFail` (PD-13, PD-18, PD-20, PA-8, PW-7, PW-14). The store's `move(kind, level)` looks the move up again at the current position and commits its target. Proceed opens the action page (`processAction-handler.ts`, `media/processAction/`); the other moves go straight to `confirmProcessAction`. On confirm `src/services/processActionService.ts` resolves the Proceed template with the placeholder engine — `processActionValues` (`src/utils/processActionPrompt.ts`) lays the CURRENT position's process variables and the action variables over the chat variables — enqueues the text with `processRun` (the quest and that position), then moves the state. The one template is `processActionTemplates.proceed` in the extension config, edited in the process template editor (`processTemplateEditor-handler.ts`, `media/processTemplateEditor/`, command `tomAi.editor.processTemplates`); equal to its default it is not stored.
  - **User actions.** A step without sub-steps, a sub-step or the post-gate step flagged `userAction` is done by the user (`userActionAt(def, state)`; validation refuses it on a gate, on a step with sub-steps, and with a `prompt` or `session`). Proceed there is labelled *Confirm done* and, at a decision point, offered once; the PROCESS view (`media/processPanel`) shows a *Your turn* banner, 👤 in the dropdowns and a person icon on Proceed; `processPanel-handler` asks the modal confirmation from `userActionConfirmation` (processActionPrompt.ts) instead of opening the action page, and `confirmProcessAction` never queues a prompt for a user action. `processContextBlock` tells the agent the position is the user's (PD-19, PA-7, PW-12, PW-13).
  - **Run position.** `src/services/processRunContext.ts` holds, in an `AsyncLocalStorage`, the position the current send runs for: the queue sends an item with `processRun` inside `runInProcessPosition`, `ProcessStateStore.variables()` / `contextBlock()` / `runRole()` answer for that position, and the variable resolver takes its role — so a Proceed prompt runs as its step although the quest moved on. An item enqueued during such a send (an agent planning a step queues its todo walks; the Agent SDK's tools run in-process) inherits the position (`inheritedProcessRun`); the queue file keeps it as `process-run`.
  - **Sessions.** A phase, step or sub-step may name the Agent SDK session it runs in (`session`: a name, or `{name, basedOn, mode}`); `effectiveSession` takes the innermost and fills in the `${phase-iteration}` / `${step-iteration}` / `${substep-iteration}` placeholders a name may hold, so each iteration gets its own session. The action page shows it (`actionSession`: picked on the page > the process's > the queue default); on confirm a missing process session is created from its spec (base first) and the prompt is queued with `session`.
- **Named Agent SDK sessions.** `src/utils/agentSdkSessions.ts` (rules: `planSessionStart` → resume / fork / persist; `shouldForkAttempt`) and `src/services/agentSdkSessionStore.ts` (the `<name>.session.json` files of the quest's history folder; saves merge). The Anthropic handler plans each Agent SDK prompt's start from the session key it is given; the transport sets `forkSession` only on the attempt that resumes the original base. The chat panel's session (per quest, workspaceState), the queue default and each item's `session` (queue YAML key `session`; the older `agent-sdk-session` is read) choose the key; on the direct API transport the same key chooses the history (`src/services/directSessionHistory.ts`: `chat` and `default` share the quest's `history/`, any other session has `history/sessions/<name>/`; `continue` with a base is seeded from the base's history once, `fork-from-base` reads the base's history and saves nothing). The handler's `selectHistoryScope` picks the scope per send — after awaiting the previous scope's background compaction — and every history read and write goes through `scopeFolder`; `persistsHistory` false skips saving and compaction (DH-1 – DH-5); `src/handlers/sessionPicker.ts` is the shared VS Code picker; `src/tools/session-tools.ts` lists and creates sessions for agents.
- `WindowSessionTodoStore` — per-window session todos.
- `PromptQueueManager` — file-per-entry queue, answer detection, watchdog, repeat/affix, automation settings.
- `TimerEngine` — timed request scheduling (interval + scheduled modes, `sendMaximum`, global schedule slots).
- `ReminderSystem` — reminder generation for pending queue items.

Persistence services:

- `TrailService` — raw trail file writer (prompt / payload / answer / tool-request / tool-answer per turn).
- `LiveTrailWriter` — rolling 5-block markdown at `_ai/quests/<quest>/live-trail.md`. Trimming happens in `beginPrompt()` via `trimOldBlocks()`: each new block drops the oldest once 5 are present. Thinking and assistant text are appended verbatim (no per-block size cap); individual blocks may be large on extended-thinking runs.
- `ToolTrail` — in-memory ring buffer (40 entries) with replay keys `t1`, `t2`, … used by past-tool-access tools.
- `TwoTierMemoryService` — shared + quest memory with placeholder expansion. Also owns the Agent SDK session id file (`default.session.json`, atomic write, idempotent).
- `history-compaction.ts` — `trim_and_summary` / `full` / `summary` / `llm_extract` modes for direct-transport history.

## Anthropic handler + transports

[anthropic-handler.ts](../src/handlers/anthropic-handler.ts) is the core multi-transport entry point. It owns all prompt composition, history injection, tool-approval loop, live-trail writes, and raw trail writes. Only the **leaf API call** differs between transport types.

### Four leaf primitives

| Leaf | Transport key | Notes |
|------|---------------|-------|
| Direct | `direct` | Raw `@anthropic-ai/sdk` |
| Agent SDK | `agentSdk` | `@anthropic-ai/claude-agent-sdk`; runs its own loop, SDK-managed session |
| VS Code LM | `vscodeLm` | `vscode.lm.selectChatModels` + `model.sendRequest`; model pinned at configure-time |
| Local LLM | `localLlm` (runtime only) | `callLocalLlmOnce` primitive shared with `LocalLlmManager`; synthesised at dispatch |

Direct / VS Code LM / Local LLM participate in the Anthropic handler's shared agent loop (tool-use rounds until no more `tool_use` blocks). Agent SDK runs its own stream-level loop; the handler wraps it with the same approval gate, live trail, and built-in-tool persistence.

### Configuration resolution

`AnthropicProfile.configId` can point at:
1. An `AnthropicConfiguration` in `config.anthropic.configurations` → transport is `direct`, `agentSdk`, or `vscodeLm`.
2. A Local LLM configuration in `config.localLlm.configurations` → synthesised `transport: 'localLlm'` at runtime.

Resolution is performed by the shared helper `resolveAnthropicTargets` ([src/utils/resolveAnthropicTargets.ts](../src/utils/resolveAnthropicTargets.ts)), which returns `{ profile, configuration } | { error: string }`. Both the queue dispatcher and the interactive chat panel use it; neither duplicates the fallback chain.

### History modes

Profile-level field `historyMode`: `sdk-managed` (Agent SDK only) | `full` | `summary` | `trim_and_summary` (default) | `llm_extract`. Non-`sdk-managed` modes use the Anthropic handler's own `rawTurns`/`compactedSummary` injection.

### Trail outputs

All four leaf paths write to `_ai/trail/anthropic/*` via `ANTHROPIC_SUBSYSTEM`. The `LiveTrailWriter` instance is created once per `sendMessage()` call and disposed at turn end. Isolated sub-agent calls (`options.isolated = true`) get `currentLiveTrail = null` so their intermediate work doesn't pollute the parent quest's trail.

### Tool approval

`toolApprovalMode: 'always' | 'never'`. Queue-dispatched items coerce this to `'never'` before calling `sendMessage()` (queue is unattended; blocking on the approval bar would stall the queue). Interactive sends honour the profile's stored value.

See [anthropic_chat.md](anthropic_chat.md) for the panel-level detail and [../doc/anthropic_handler.md](../doc/anthropic_handler.md) for the full handler spec.

## Queue transport model

The prompt queue supports **two transports**: `'copilot'` and `'anthropic'`. A queue item can interleave transports within the same ordered run.

### Copilot transport (existing)

- Wraps the prompt with an answer-file template.
- Dispatches via `workbench.action.chat.open`.
- Advances when an answer JSON appears under `_ai/answers/copilot/`.
- Polling loop + 30s watchdog + reminder system + `answerWaitMinutes` auto-advance all apply.

### Anthropic transport

- Calls `AnthropicHandler.instance.sendMessage()` directly and awaits the result.
- No answer-file polling, no reminder, no `answerWaitMinutes` — response is synchronous.
- Answer text is stored on the queue item as `answerText`.
- `toolApprovalMode` is coerced to `'never'` by the dispatcher.

### Stage resolution

Three-tier transport resolution for every stage (pre-prompt / main / follow-up):

```
stage.transport  →  item.transport  →  queue-settings defaultTransport  →  'copilot'
```

The `dispatchStage()` helper inside `promptQueueManager.ts` applies this resolution and branches on the result before calling either the Copilot path or `AnthropicHandler.sendMessage`.

### Queue YAML fields

Per-item and per-stage fields added for the Anthropic transport:

```yaml
transport: anthropic                    # 'copilot' | 'anthropic'
anthropic-profile-id: software-engineer
anthropic-config-id: claude-sonnet-46   # can be an Anthropic config id OR a Local LLM config id
answer-text: "…response…"              # captured direct response
```

Queue-level defaults in `queue-settings.yaml`:

```yaml
default-transport: anthropic
default-anthropic-profile-id: software-engineer
default-anthropic-config-id: claude-sonnet-46
```

All fields are additive-optional; missing fields fall back through the three-tier chain to `'copilot'`.

See [prompt_queue_timed_templates.md](prompt_queue_timed_templates.md) for queue editor, timed requests, and template editor detail.

## Queue storage

Queue entries are stored as individual YAML files (`q_<id>.yaml`) with a hostname prefix for cross-workspace safety. Queue settings persist in `queue-settings.yaml`. File watchers enable cross-window sync. A background watchdog (60s interval) and polling fallback (30s) ensure answer detection reliability.

**Important invariant:** `_reloadFromDisk()` is debounced (300 ms) and skips entirely when any item has `status === 'sending'`. This prevents the `FileSystemWatcher` (triggered by `persist()`) from swapping in-memory item references during an async Anthropic dispatch, which would cause the queue to stall permanently.

## Template stores

Two independent stores, not shared:

| Transport | Config key | Shape |
|-----------|-----------|-------|
| Copilot | `config.copilot.templates` | map `{ [name]: { template, showInMenu? } }` |
| Anthropic | `config.anthropic.userMessageTemplates` | array `[{ id, name, description?, template, isDefault? }]` |

All Anthropic leaf paths (Direct, Agent SDK, VS Code LM, Local-LLM-backed) share the Anthropic store. Template tools (`tomAi_listPromptTemplates`, `tomAi_createPromptTemplate`, `tomAi_updatePromptTemplate`, `tomAi_deletePromptTemplate`) accept a `transport?: 'copilot' | 'anthropic'` field, defaulting to `'copilot'`.

## TomSpecs (SOM) documents

The bundled SOM runtime + facade are reached only through `src/services/som-model-service.ts` (`SomModelService.instance`: model, model version, roots, meta trees, schemas). Spec documents on disk are reached only through `src/services/som-document-store.ts` — no tool parses or writes a document itself:

- `load(path)` → `LoadedSomDocument`: format (`*.docspecs.yaml` or SOM `*.md`), root, `document`, model-version `stamp`, SOM §4.2 `editability`, sha256 `revision`, the YAML `review:` pass as the runtime decodes it (`null` when the file has none, a possibly empty map when it has one, so an explicit `review: {}` survives a save), Markdown `rejections` and `fidelityProblems`, and `readOnlyReason`.
- Edit `loaded.document` (e.g. `SpecEditor.forModel(doc, service.model)`), then `save(loaded, { expectedRevision?, dryRun? })`: re-encodes in the file's own format stamped with the current model version, returns the new revision, a unified diff and `staleReviewPaths`. It refuses (`SomDocumentError.code`) a read-only document, a revision conflict, and a file dirty in an editor.
- Markdown loads read-only when its import is not faithful — the re-render differs (a hand-formatted file), the document cannot be encoded, or values land where the model has no value leaf — or when the parser rejected blocks.
- The extension uses `somDocumentStore()` from `som-document-io-vscode.ts`: files open in an editor are read from and written through the editor (WorkspaceEdit + save); others are written atomically. The store itself is vscode-free and unit-tested with `nodeSomDocumentIo`.
- `src/services/som-spec-inspector.ts` (`SomSpecInspector`, vscode-free) answers the read-only questions over a loaded document or the model alone: outline, one section with typed form values, reflection, and what `checkAddNode` accepts at a path. An unresolvable path raises `SpecPathError` carrying the nearest resolvable node and its children. `store.peek(path)` identifies a file from its header lines only, for workspace scans.
- The agent tools are in `src/tools/spec-tools.ts` (read and reflect), `src/tools/spec-search-tools.ts` (search), `src/tools/spec-edit-tools.ts` (approval-gated edits and the `tomAi_specApplyEdits` batch) and `src/tools/spec-annotation-tools.ts` (review annotations through the runtime's `SpecReviewAnnotations`: the reader `tomAi_specAnnotations` and eight writers, each also a batch op via `ANNOTATION_BATCH_OPS`; `writeMarked` is the `marked: true` write `setContent` / `setFormField` share) and `src/tools/spec-answers-tools.ts` (a round's `answers.md` through the runtime's `extractAnswers` / `renderAnswers`, the rules of tom_specs' `extract_answers` CLI: `tomAi_specExtractAnswers` reads, `tomAi_specWriteAnswers` writes). The writers share `src/tools/spec-edit-core.ts`: one `runEdit` cycle of load → validate → mutate → validate → save, the refusals (`SpecEditRefusal`; a runtime `SpecReviewAnnotationError` is `annotationRefused`) and the write-tool parameters. All share `spec-tool-common.ts` (deps, path resolution inside the workspace, the document header, failure answers); all are catalogued in `doc/llm_tools.md` §4.23. Each is a `*Impl(deps, input)` over the store, the model and the workspace root, with a thin `execute` wrapper.
- `SomDocumentStore.create(path, root)` writes a new, empty document. The runtime's codec writes an empty YAML document with its root key (`document:\n  SBP D00SolutionBlueprint: {}`), so the file still says which document it is.
- `src/services/som-spec-validation.ts` (`SomSpecValidation`, vscode-free) runs the three tiers of tom_specs' `validate_spec` CLI (decode with fragment assembly, DocSpecs schema over the rendition, instance) and reports them in the CLI's `spec-validation`/1 shape, with a `path` added to each finding (a schema finding takes the path of the section its line falls under, from the runtime's `toMarkdownWithMap` heading map). `subtreeOf(document, path)` gives the part of a document a subtree render needs; `SomDocumentStore.convert()` writes the other format.
- Plain DocSpecs Markdown (not SOM) is handled in `src/services/docspecs-markdown.ts` (schema lookup: argument → nearest `.tom/docspecs-schema/` → generated SOM schemas; outline; section lookup; the older-form note) and `src/tools/docspecs-tools.ts`. It reads and writes through `SomDocumentStore.readText` / `writeText`, the store's generic text save path, which `save()` uses too: dirty check, revision checks, editor or atomic write, dry-run diff.
- CodeSpecs: `src/tools/codespecs-tools.ts` runs the runtime's `CodeSpecsExtractor` against `SomModelService.codeSpecsCatalog`. That catalogue is the packaged copy in `resources/codespecs/codespecs_areas.json`, which `npm run som:pack` copies from tom_specs_model; the VSIX check requires it, and a test holds it equal to the source. A root whose class carries `@CodeSpecsProjection` is refused.
- CodeSpecs Stage A/B: `src/tools/codespecs-gate-tools.ts` runs the runtime's `CodeSpecsGate` (A1 findings located through the rendition's heading map, `pathAtLine`) and reads and writes `gate.verdicts.yaml` through `CodeSpecsGateRecord`. A new record is validated by parsing exactly the text that would be written, and the record's leading comments are kept by hand, because `toYaml()` does not carry them.
- CodeSpecs query and trace: `src/services/codespecs-trace.ts` reads a written run file by file (`CodeSpecsExtract.fromYaml`, so an unreadable file is reported alone, and a gate record scopes the areas) and the `codespecs-backlinks` index, then compares token sets. `src/tools/codespecs-trace-tools.ts` adds the tools. Its `setBacklinkProvider` receives the bundled binary at activation (extension.ts), so `codeDirs` reads a trio directly.
- CodeSpecs validate and step context: `src/services/codespecs-validator.ts` resolves the `validate_codespecs` binary in `bin/<platform>/` (built by `scripts/build-validate-codespecs.cjs`, never `dart run`), runs it (`--json`, `--backlinks`) and keeps exit 0 / 1 / 2 apart; `resolveTrio` takes client and server as the shared folder's siblings. `src/services/codespecs-contract.ts` reads the packaged derivation contract (`resources/codespecs/codespecs_derivation_contract.md`, copied by `npm run som:pack`) and picks a step's §3 entries from its headings. `src/tools/codespecs-validate-tools.ts` adds the two tools; validate passes the packaged `resources/codespecs/vocabulary.dart` (`CS_VOCABULARY_FILE`) as `--cs-vocabulary` unless the caller names one, so checks 40 and 41 always have their hook catalogue.
- CodeSpecs workflow: `src/tools/codespecs-workflow-tools.ts` adds `tomAi_specCodeSpecsStatus`, built from the stage tools' own answers (gate, write-extracts dry run, verdicts, plan-todos dry run, validate) so it cannot disagree with them, and `tomAi_specCodeSpecsGuide` over `src/services/codespecs-guides.ts` (the packaged `codespecs_prompt.md` / `codespecs_mapping.md` as numbered sections, and the stage runbooks). `src/handlers/mcpCodeSpecsGuides.ts` registers the guides as MCP resources and the runbooks as MCP prompts on every server `buildToolMcpServer` builds.
- CodeSpecs todo tree: `src/tools/codespecs-plan-tools.ts` plans the `csopen` / `csproj` / `csgen` tree from the gate record and the catalogue's step table, and creates it through `createQuestTodoImpl` (the same validation and verified write as `tomAi_createQuestTodo`). The quest-todo access (`PlanTodoDeps`) is injected; the live one comes from `chat-enhancement-tools.ts` (`liveQuestTodoDeps`, `readQuestTodosIncludingTerminal`), loaded lazily because that module imports `vscode`. Ids use `buildIdPrefix`. Stage A comes from `stageA()` in `codespecs-gate-tools.ts`. Test fixture: `src/tools/__tests__/fixtures/phase4/`, a snapshot of the phase4_codespecs_run sample, with refresh steps in its README.
- Search cursors are the series' only state: `src/services/som-search-cursors.ts` (`SomSearchCursors`: TTL, cap, LRU eviction, and remembered reasons for closed ids). A cursor keeps the runtime `SpecQueryCursor` and the revision it was opened on.

## Communication boundaries

- VS Code command API for UI and command execution.
- webview `postMessage` channels for panel/editor interaction.
- bridge protocol for delegated scripting and runtime operations.
- window state files (`_ai/local/*.window-state.json`) for multi-window status.

## Output channels

Dedicated channels for prompt queue, timed requests, bridge, tool log, conversation log, AI chat log, Local LLM log, and debug. See [user_guide.md](../doc/user_guide.md#8-output-channels) for the full list.

## Fault tolerance

- Optional features use soft-fail behavior — missing dependencies must degrade, not crash, activation.
- Queue watchdog auto-restarts file watchers and detects stalled items.
- Answer detection uses file watcher + polling + requestId-based matching.
- Session-id file write is atomic (`.tmp` + rename) and idempotent (short-circuits when the on-disk value already matches).
- Empty session-id files are unlinked on load so a corrupted write self-heals.
- `resolveAnthropicTargets` returns a discriminated union `{ profile, configuration } | { error: string }` — callers surface the error string without catching across module boundaries.
