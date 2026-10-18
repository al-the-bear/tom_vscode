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
- **Markdown Browser** (`tomAi.markdownBrowser`) — standalone custom editor with link resolver, debounced file watcher, navigation history, and live-mode follow-tail (used by the "Open Live Trail" chat-panel button). Context-menu opens always create a **new** panel; the "Open Live Trail" button reuses a single live-panel singleton. In-place editing (answer buttons after `**Answer:**`, edit mode): the webview renders each top-level block in a `.mdb-block` wrapper and maps blocks and markers to file lines with `media/markdownBrowser/blocks.js` (pure, vm-tested); this works because `transformMarkdown` keeps every line in place unless CR/LF is on, so editing is off then. A save posts `applyEdit` {startLine, endLine, expected, replacement}; the handler applies it with `applyMdLineEdit` (`src/utils/markdownBrowserEdits.ts`), which refuses when the lines no longer hold `expected`, and refuses a file dirty in an editor. Folding: each heading carries its own flag (`foldState`, keyed by level, text and occurrence so it survives same-file re-renders); what is hidden follows from the flags through `mdbFoldHidden` in `blocks.js` (a section runs to the next heading of the same or a higher level), applied as the `mdb-folded-away` class on the content's top-level elements. Rendering is grouped (`mdbGroups`): an html token that opens an element (`<details>` in the live trail) is rendered and wrapped together with everything up to its close, or the wrapper would tear the element apart. Render cost must stay linear and must not block the window — large documents (a 6 MB spec, 100k top-level elements) are viewed and edited:
  - marked is called with `marked.defaults` merged into the options (`markedOptions()`); passing an options object alone replaces the defaults and turns GFM — tables, strikethrough — off.
  - `renderDocument` lexes once, then builds and decorates the HTML off-DOM in batches of `RENDER_CHUNK` pieces with a `setTimeout` between them (a render generation cancels a superseded one; `aria-busy` is set while it runs), and shows the result by swapping the one `.mdb-doc` element inside `contentArea`. Never clear a large rendered tree node by node: once anything in it has had focus, Chrome stalls for seconds to minutes on that.
  - Large documents get the `mdb-large` class: `content-visibility: auto` on their blocks, so only blocks on screen are laid out.
  - A refresh carrying the text already shown renders nothing. After a successful save, `patchAfterSave` applies the edit to the shown text and re-renders only the touched blocks and the one before them (an edit may merge into it), shifting the line ranges of the blocks after; it falls back to a full render when the replacement holds a heading, a fence or html, or the region is not bounded by blank or heading lines. The file's own refresh that follows is then the same text.
  - Editing controls read their block's lines when clicked, never at render time, so they stay right after a patch moved them. The edit range starts at the blank lines before the block, so removing the leading newline merges it with the previous block; the textarea's value is sent exactly as typed.
  - Walk snapshots, never a live collection while inserting; clone one template for repeated elements; one delegated listener for their clicks; write only the DOM state that changes.

  - The edit / insert controls are in every editable block's markup (`BLOCK_ACTIONS_HTML`) and shown by `body.mdb-edit-mode`; switching edit mode touches no block. All clicks in the content — links, section references, block actions — go through one delegated listener; the block of a wrapper is `wrapper.__mdbBlock`.
  - Links in plain text are added once per render (or patch) by `linkify`, only for blocks whose HTML can hold one (`LINKABLE_HTML`): `mdbMdPaths` (plain-text `.md` paths, sent to the backend's `resolveLink` like any link) and `mdbSectionRefs` (`OUTER > INNER`), the latter only when `mdbResolveSectionRef` finds a heading by its dotted full id (`data-fullid`, indexed by last id in `headingsById`). Following one, or an in-document anchor, goes through `jumpWithinDocument`, which records the previous position for the document back / forward arrows (the top visible element and its offset, or `scrollTop` when that element was re-rendered).
  - Search indexes the lower-cased text of each top-level element once per render or patch and paints matches with the CSS Custom Highlight API (`mdb-search`, `mdb-search-current`), never by changing the DOM; queued keystrokes are searched once. `revealElement` returns at once when nothing is folded — walking 100k elements per search step was most of its cost.
  - The panel's history (`src/utils/mdBrowserHistory.ts`) keeps a `ReadingPosition` per entry — the source line of the block at the top of the view, its offset, and `scrollTop` as a fallback. The webview sends it with `goBack` / `goForward` / `navigateLink` and, debounced, as `readingPosition` after scrolling; `mdContent` carries it back on back / forward, and `restoreReadingPosition` keeps placing that block over the next frames until it holds still (lazily laid-out blocks change height as they come on screen), stopping when the reader scrolls.
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
- The agent tools are in `src/tools/spec-tools.ts` (read and reflect), `src/tools/spec-search-tools.ts` (search) and `src/tools/spec-edit-tools.ts` (approval-gated edits: one `runEdit` cycle of load → validate → mutate → validate → save), sharing `spec-tool-common.ts` (deps, path resolution inside the workspace, the document header, failure answers); all are catalogued in `doc/llm_tools.md` §4.23. Each is a `*Impl(deps, input)` over the store, the model and the workspace root, with a thin `execute` wrapper.
- `SomDocumentStore.create(path, root)` writes a new, empty document. An empty YAML document is written with its root key (`document:\n  SBP D00SolutionBlueprint: {}`), because the codec's `document: {}` would not say which document it is.
- `src/services/som-spec-validation.ts` (`SomSpecValidation`, vscode-free) runs the three tiers of tom_specs' `validate_spec` CLI (decode with fragment assembly, DocSpecs schema over the rendition, instance) and reports them in the CLI's `spec-validation`/1 shape, with a `path` added to each finding (schema findings located by a marker-headline render). `subtreeOf(document, path)` gives the part of a document a subtree render needs; `SomDocumentStore.convert()` writes the other format.
- Plain DocSpecs Markdown (not SOM) is handled in `src/services/docspecs-markdown.ts` (schema lookup: argument → nearest `.tom/docspecs-schema/` → generated SOM schemas; outline; section lookup; the older-form note) and `src/tools/docspecs-tools.ts`. It reads and writes through `SomDocumentStore.readText` / `writeText`, the store's generic text save path, which `save()` uses too: dirty check, revision checks, editor or atomic write, dry-run diff.
- CodeSpecs: `src/tools/codespecs-tools.ts` runs the runtime's `CodeSpecsExtractor` against `SomModelService.codeSpecsCatalog`. That catalogue is the packaged copy in `resources/codespecs/codespecs_areas.json`, which `npm run som:pack` copies from tom_specs_model; the VSIX check requires it, and a test holds it equal to the source. A root whose class carries `@CodeSpecsProjection` is refused.
- CodeSpecs Stage A/B: `src/tools/codespecs-gate-tools.ts` runs the runtime's `CodeSpecsGate` (A1 findings located through `SomSpecValidation.locate`) and reads and writes `gate.verdicts.yaml` through `CodeSpecsGateRecord`. A new record is validated by parsing exactly the text that would be written, and the record's leading comments are kept by hand, because `toYaml()` does not carry them.
- CodeSpecs query and trace: `src/services/codespecs-trace.ts` reads a written run file by file (`CodeSpecsExtract.fromYaml`, so an unreadable file is reported alone, and a gate record scopes the areas) and the `codespecs-backlinks` index, then compares token sets. `src/tools/codespecs-trace-tools.ts` adds the tools. Its `setBacklinkProvider` receives the bundled binary at activation (extension.ts), so `codeDirs` reads a trio directly.
- CodeSpecs validate and step context: `src/services/codespecs-validator.ts` resolves the `validate_codespecs` binary in `bin/<platform>/` (built by `scripts/build-validate-codespecs.cjs`, never `dart run`), runs it (`--json`, `--backlinks`) and keeps exit 0 / 1 / 2 apart; `resolveTrio` takes client and server as the shared folder's siblings. `src/services/codespecs-contract.ts` reads the packaged derivation contract (`resources/codespecs/codespecs_derivation_contract.md`, copied by `npm run som:pack`) and picks a step's §3 entries from its headings. `src/tools/codespecs-validate-tools.ts` adds the two tools.
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
