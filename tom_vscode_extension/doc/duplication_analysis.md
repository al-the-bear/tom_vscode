# VS Code Extension — Duplication & Reusable Component Analysis

**Date:** 2026-02-26  
**Scope:** `tom_vscode_extension/src/`  
**Total source:** 53,539 lines across ~60 `.ts` files

---

## 1. HTML Generation Duplication

### 1.1 `dsNotes-handler.ts` — 10 private `_getHtml()` methods

`dsNotes-handler.ts` (3,416 lines) contains **10 separate WebviewViewProvider classes**, each with its own `_getHtml()` method:

| Class | Line | `_getHtml` line | Approx size |
|-------|------|-----------------|-------------|
| `TomNotepadProvider` | L622 | L790 | ~80 lines |
| `CopilotNotepadProvider` | L870 | L1023 | ~75 lines |
| `LocalLlmNotepadProvider` | L1099 | L1415 | ~95 lines |
| `ConversationNotepadProvider` | L1512 | L1777 | ~120 lines |
| `TomAiChatNotepadProvider` | L1877 | L2110 | ~85 lines |
| `NotesNotepadProvider` | L2198 | L2422 | ~85 lines |
| `GuidelinesNotepadProvider` | L2498 | L2705 | ~120 lines |
| `WorkspaceNotepadProvider` | L2789 | L3063 | ~115 lines |
| `QuestNotesProvider` | L3181 | L3284 | ~25 lines |
| `SessionTodosProvider` | L3302 | L3327 | ~30 lines |

**All 10** share the `getBaseStyles()` function (L80-160, ~80 lines of shared CSS). Each `_getHtml()` method generates a complete `<!DOCTYPE html>` document with:
- The same `getBaseStyles()` CSS
- The same toolbar pattern (buttons, selects, textareas)
- The same `vscode.postMessage()` JS communication pattern
- The same `window.addEventListener('message', ...)` JS listener

**Estimated duplicated HTML/CSS/JS:** ~600-800 lines of near-identical boilerplate across these 10 classes.

### 1.2 `unifiedNotepad-handler.ts` — 2 `_getHtmlContent()` methods

`unifiedNotepad-handler.ts` (4,162 lines) has:

| Method | Line | Description |
|--------|------|-------------|
| `UnifiedNotepadViewProvider._getHtmlContent(codiconsUri)` | L2416 | Main unified notepad with tabs — **~1,150 lines** of inline HTML/CSS/JS |
| `LocalLlmPanel._getHtmlContent()` | L3585 | Local LLM panel — **~570 lines** of inline HTML/CSS/JS |

The `getPromptEditorComponent()` function (L2674) generates HTML for prompt editors within the unified notepad — it's called 4 times (L2703, L2722, L2740, L2815) for different tab types (localLlm, conversation, copilot, tomAiChat). This is a **partial extraction** — the component is reused within the file but not across files.

### 1.3 Overlap between `dsNotes-handler.ts` and `unifiedNotepad-handler.ts`

Both files generate HTML for the **same panel types**:
- Local LLM notepad (dsNotes `LocalLlmNotepadProvider` vs unifiedNotepad `LocalLlmPanel`)
- Copilot notepad (dsNotes `CopilotNotepadProvider` + `QuestNotesProvider` vs unified tabs)
- Conversation notepad (dsNotes `ConversationNotepadProvider` vs unified tab)
- Tom AI Chat notepad (dsNotes `TomAiChatNotepadProvider` vs unified tab)

The implementations are **not shared** — each file has its own HTML, CSS, JS, and message handling.

### 1.4 Other `_getHtml` implementations

| File | Line | Type |
|------|------|------|
| `globalTemplateEditor-handler.ts` | L578 | Standalone `_getHtml(codiconsUri)` |
| `contextSettingsEditor-handler.ts` | L432 | Standalone `_getHtml(codiconsUri)` |
| `reusablePromptEditor-handler.ts` | L492 | Standalone `_getHtml(codiconsUri)` |
| `notepad-handler.ts` | L91 | Instance `_getHtmlContent()` |
| `t3Panel-handler.ts` | L232 | Instance `_getHtmlForWebview(webview)` |
| `todoLogPanel-handler.ts` | L254 | Instance `_getHtml(webview)` |
| `minimalMode-handler.ts` | L60 | Instance `_getHtml(_webview)` |
| `trailViewer-handler.ts` | (inline) | Large inline HTML |
| `trailEditor-handler.ts` | (inline) | Large inline HTML |
| `questTodoPanel-handler.ts` | (inline) | Large inline HTML |
| `statusPage-handler.ts` | (inline) | Massive inline HTML |

**Total:** ~17 separate HTML generation implementations. No shared HTML templating framework.

### 1.5 Existing shared abstractions

Two reusable panel generators **do** exist:
- `accordionPanel.ts` — `getAccordionHtml()` (L292), used by `t3Panel-handler.ts`
- `tabPanel.ts` — `getTabPanelHtml()` (L136), available but not widely adopted

These are good patterns but adopted by only 1-2 consumers each.

---

## 2. Trail Writing Duplication

### 2.1 Trail systems inventory

There are **3 separate trail-writing systems**:

#### System A: `trailLogger-handler.ts` (424 lines) — Structured trail files

Centralized, well-designed module with typed functions:

| Function | Line | Purpose |
|----------|------|---------|
| `clearTrail(type)` | L143 | Clear trail folder by type |
| `logPrompt(type, target, prompt, systemPrompt?, metadata?)` | L224 | Log prompt to AI |
| `logResponse(type, source, response, isFinal?, metadata?)` | L249 | Log AI response |
| `logToolRequest(type, toolName, args)` | L275 | Log tool invocation |
| `logToolResult(type, toolName, result, error?)` | L291 | Log tool result |
| `logCopilotAnswer(answer)` | L391+ | Log Copilot answer JSON |
| `writeTrailFile(type, filename, content, isJson?)` | L187 | Low-level file writer |

Used by: `tomAiChat-handler.ts`, `expandPrompt-handler.ts`, `botConversation-handler.ts`, `dsNotes-handler.ts`

#### System B: `unifiedNotepad-handler.ts` — Consolidated trail files

Module-level functions in the unified notepad handler:

| Function | Line | Purpose |
|----------|------|---------|
| `writePromptTrail(originalPrompt, templateName, isAnswerWrapper, expandedPrompt, overrideRequestId?)` | L340 | Write to `{workspace}.prompts.md` |
| `writeAnswerTrail(answer)` | L400 | Write to `{workspace}.answers.md` |
| `writeToTrailViewer(session, type, content)` | L484 | Legacy individual files |

Writes to: `_ai/trail/` folder, consolidated by workspace name prefix.

#### System C: Inline `_appendToTrail()` methods

Two independent implementations in different classes:

| File | Class | Line | Trail path |
|------|-------|------|------------|
| `dsNotes-handler.ts` | `LocalLlmNotepadProvider` | L1342 | `_ai/local/chat_trail.md` |
| `unifiedNotepad-handler.ts` | `LocalLlmPanel` | L1585 | `_ai/local/{workspace}.trail.md` + `.prompts.md` + `.answers.md` |

Both do the same thing (log local LLM prompt/response) but with **different file formats and paths**:
- dsNotes version: simple append to single `chat_trail.md` file
- unifiedNotepad version: writes to 3 separate files (compact, prompts, answers) + individual files

### 2.2 Summary of trail duplication

- **3 separate systems** writing trail files
- **2 duplicate `_appendToTrail()`** implementations for local LLM trails
- **No shared interface** between Systems A, B, and C
- Different file naming conventions, folder structures, and content formats per system
- `trailLogger-handler.ts` is the best-designed but not universally adopted

---

## 3. Config Reading Duplication

### 3.1 `getConfigPath()` + inline `JSON.parse(fs.readFileSync(...))`

`getConfigPath()` is defined in `handler_shared.ts` (L164) and imported by 13 handlers. However, **there is no `readConfig()` utility** — each handler does its own inline read:

| File | Line | Pattern |
|------|------|---------|
| `chordMenu-handler.ts` | L166 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `stateMachine-handler.ts` | L90 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `telegram-cmd-handlers.ts` | L439 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `expandPrompt-handler.ts` | L1484 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `expandPrompt-handler.ts` | L1550 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `expandPrompt-handler.ts` | L1571 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `combinedCommand-handler.ts` | L64 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `telegram-commands.ts` | L49, L267 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `commandline-handler.ts` | L87 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `trailLogger-handler.ts` | L81, L391 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `reminderSystem.ts` | L284 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `issuesPanel-handler.ts` | L118 | `JSON.parse(fs.readFileSync(configPath, 'utf-8'))` |
| `restartBridge-handler.ts` | L60, L119 | `fs.readFileSync(configPath, 'utf-8')` + JSON.parse |

**Total: 15 inline `JSON.parse(fs.readFileSync(...))` calls** across 11 different files.

Each call also redundantly does `fs.existsSync(configPath)` check beforehand. A single `readConfig(): Record<string, any> | null` utility would eliminate ~45 lines of repetitive guard + parse code.

### 3.2 Config write pattern

Similarly, **18 instances** of `fs.writeFileSync(path, JSON.stringify(data, null, 2))` exist with no shared `writeConfig()` utility.

---

## 4. Todo System Duplication

### 4.1 Three separate todo systems

| System | File | Storage | Status values | ID type |
|--------|------|---------|---------------|---------|
| **QuestTodoManager** | `managers/questTodoManager.ts` (923 lines) | YAML files in `_ai/quests/{id}/` | `not-started`, `in-progress`, `blocked`, `completed`, `cancelled` | `string` |
| **WindowSessionTodoStore** | `managers/windowSessionTodoStore.ts` (238 lines) | Delegates to `questTodoManager` YAML | `pending`, `done` | `string` |
| **TodoManager** | `managers/todoManager.ts` (253 lines) | JSON in `_ai/tom_ai_chat/{chatId}.todos.json` | `not-started`, `in-progress`, `completed` | `number` |

### 4.2 API comparison

| Operation | QuestTodoManager | WindowSessionTodoStore | TodoManager |
|-----------|------------------|----------------------|-------------|
| Create | `createTodo(questId, item)` / `createTodoInFile(path, item)` | `add(title, source, opts?)` | `add(title, description?)` |
| Read one | `findTodoById(questId, todoId)` / `findTodoByIdInFile(path, todoId)` | `get(id)` | (loop `list()`) |
| Update | `updateTodo(questId, todoId, updates)` / `updateTodoInFile(path, todoId, updates)` | `update(id, updates)` | `update(id, updates)` |
| Delete | `deleteTodo(questId, todoId)` | `delete(id)` | `remove(id)` |
| List | `readAllTodos(questId)` / `readWorkspaceTodos()` / `readAllQuestsTodos()` | `list(filter?)` | `list(status?)` |
| Clear | — | — | `clear()` |
| Move | `moveTodo(fromQuestId, todoId, toQuestId)` / `moveToWorkspaceTodo(questId, todoId)` | — | — |
| Extra | `collectAllTags()`, `collectScopeValues()`, `scanWorkspaceProjects()`, `listQuestIds()`, `listWorkspaceTodoFiles()` | — | — |

### 4.3 Duplication assessment

- **QuestTodoManager** has 22 exported functions — the most feature-rich system
- **WindowSessionTodoStore** wraps QuestTodoManager for session-scoped YAML todos — reasonable delegation
- **TodoManager** is an entirely separate JSON-based system with incompatible types, used **only by `tomAiChat-handler.ts`**

The TodoManager (JSON) and QuestTodoManager (YAML) share no code despite having overlapping functionality. TodoManager uses `number` IDs while both Quest systems use `string` IDs. TodoManager has incompatible status enums.

**Consumers:**
- `questTodoPanel-handler.ts`: Uses both QuestTodoManager (26+ calls) and WindowSessionTodoStore (20+ calls)
- `dsNotes-handler.ts`: Uses WindowSessionTodoStore (SessionTodosProvider class)
- `tomAiChat-handler.ts`: Uses TodoManager exclusively
- `tool-executors.ts`: Uses TodoManager (re-exported via `tomAiChat-tools.ts`)

---

## 5. Prompt Sending Patterns

### 5.1 Ways to send a prompt

There are **5 distinct mechanisms** for sending prompts to AI:

| # | Mechanism | File(s) | What it does |
|---|-----------|---------|-------------|
| 1 | `vscode.commands.executeCommand('workbench.action.chat.open', { query })` | 18 call sites across 9 files | Opens Copilot Chat panel with pre-filled query |
| 2 | `sendCopilotRequest(model, prompt, token)` | `handler_shared.ts` L400; used by `botConversation-handler.ts` (2 sites) | Uses VS Code LM API directly |
| 3 | `model.sendRequest(messages, options, token)` via VS Code LM API | `tomAiChat-handler.ts` (3 sites), `tool-executors.ts` (2 sites), `vscode-bridge.ts` (2 sites), `handler_shared.ts` (1 site) | Direct model invocation |
| 4 | `PromptExpanderManager.expandPromptCommand()` / Ollama HTTP | `expandPrompt-handler.ts` L251+; used via `getPromptExpanderManager()` in 6 handlers | Expands templates, sends to Ollama |
| 5 | `bridgeClient.sendRequest(method, params)` via Dart bridge | `vscode-bridge.ts` L424; used by 8+ handlers | Sends to Dart-side for processing |

### 5.2 `workbench.action.chat.open` call sites (18 total)

| File | Line(s) |
|------|---------|
| `dsNotes-handler.ts` | L567, L776, L970, L989, L3008, L3244 |
| `unifiedNotepad-handler.ts` | L1495, L2223 |
| `notepad-handler.ts` | L58 |
| `sendToChat-handler.ts` | L30 |
| `sendToChatAdvanced-handler.ts` | L468 |
| `questTodoPanel-handler.ts` | L3088 |
| `extension.ts` | L983 |
| `promptQueueManager.ts` | L362, L433, L808 |
| `tool-executors.ts` | L1082 |
| `vscode-bridge.ts` | L901 |

### 5.3 `getPromptExpanderManager()` consumers

| File | Lines |
|------|-------|
| `dsNotes-handler.ts` | L1280 |
| `botConversation-handler.ts` | L820, L1035, L1209, L1470, L1773, L2036 |
| `unifiedNotepad-handler.ts` | L1293 |
| `vscode-bridge.ts` | L632 |

---

## 6. Webview Message Handling — No Shared Pattern

### 6.1 Total `onDidReceiveMessage` registrations

**41 total** across the codebase. The breakdown:

| File | Count | Pattern |
|------|-------|---------|
| `dsNotes-handler.ts` | **11** | Per-class inline `async (msg) => { switch/if }` |
| `unifiedNotepad-handler.ts` | 1 | Massive single handler (~1800 lines of message processing) |
| `questTodoPanel-handler.ts` | 2 | Inline switch on `msg.type` |
| `globalTemplateEditor-handler.ts` | 1 | Delegates to `_handleMessage(msg)` |
| `contextSettingsEditor-handler.ts` | 1 | Delegates to `_handleMessage(msg)` |
| `reusablePromptEditor-handler.ts` | 1 | Delegates to `_handleMessage(msg)` |
| `t3Panel-handler.ts` | 1 | Inline |
| `handler_shared.ts` | 2 | Template editor + preview panel |
| `accordionPanel.ts` | 1 | Generic dispatcher |
| `tabPanel.ts` | 1 | Generic dispatcher |
| Others (9 files) | 1 each | Various inline patterns |

### 6.2 Message format

All webview panels use `{ type: string, ... }` as message format, but:
- **No shared TypeScript types** for messages
- **No shared message dispatcher** or router
- Each handler has its own `switch` or `if` chain
- No validation of incoming message shapes

The `accordionPanel.ts` and `tabPanel.ts` have the best pattern — they accept a `messageHandler` callback in their config.

---

## 7. File Reading/Writing Utilities Duplication

### 7.1 `ensureDir` pattern (54 instances)

The pattern `if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }` appears **54 times** across 21 files. The worst offenders:

| File | Count |
|------|-------|
| `unifiedNotepad-handler.ts` | 16 |
| `dsNotes-handler.ts` | 7 |
| `t3Panel-handler.ts` | 5 |
| `trailLogger-handler.ts` | 3 |
| `botConversation-handler.ts` | 3 |

A 3-line `ensureDir(dirPath)` utility would eliminate all 54 instances.

### 7.2 File read/write with existence check (33+ instances)

The pattern `if (fs.existsSync(path)) { content = fs.readFileSync(path, 'utf-8'); }` appears in many variations. No shared `safeReadFile(path): string | null` utility exists.

### 7.3 JSON config read pattern (15 instances)

As detailed in §3, the `existsSync → readFileSync → JSON.parse` triplet appears 15 times.

### 7.4 YAML file reading

`questTodoManager.ts` does its own YAML reading with the `yaml` package. Other handlers also read YAML files independently.

### 7.5 Directory listing pattern

The pattern `fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory())` appears in:
- `contextSettingsEditor-handler.ts` (L146, L153, L206, L313)
- `chatVariablesEditor-handler.ts` (L202)
- `reusablePromptEditor-handler.ts` (L213, L269)
- `questTodoPanel-handler.ts` (L2278)
- `trailLogger-handler.ts` (within `clearTrail`)
- `telegram-cmd-handlers.ts` (L151)

---

## 8. Extraction Opportunities — Priority Ranking

### P0 — Highest impact, lowest risk

| Component | Files affected | LOC savings | Description |
|-----------|---------------|-------------|-------------|
| `readConfig() / writeConfig()` | 11 handlers + 2 managers | ~100 | Shared JSON config I/O with existence checks |
| `ensureDir(path)` | 21 files, 54 call sites | ~80 | Single-line `fs.mkdirSync` wrapper |
| `safeReadFile(path) / safeReadJson(path)` | 15+ files | ~60 | Read with existence guard |

### P1 — High impact, moderate effort

| Component | Files affected | LOC savings | Description |
|-----------|---------------|-------------|-------------|
| `WebviewBaseStyles` shared CSS module | `dsNotes-handler.ts` (10 classes) | ~700 | Extract `getBaseStyles()` + common toolbar HTML into shared template |
| `WebviewShell` HTML wrapper | 17 handlers | ~300 | Shared `<!DOCTYPE html>` + meta + style wrapper |
| Trail system unification | 5 files, 3 systems | ~200 | Single trail API replacing 3 separate systems |
| `WebviewMessageRouter` | 20+ handlers | ~100 | Type-safe message dispatch with schema validation |

### P2 — Medium impact, higher effort

| Component | Files affected | LOC savings | Description |
|-----------|---------------|-------------|-------------|
| TodoManager unification | 3 managers, 4+ consumers | ~200 | Replace TodoManager (JSON) with QuestTodoManager adapter |
| `dsNotes-handler.ts` class consolidation | 1 file (3,416 lines) | ~1,500 | Merge 10 near-identical WebviewViewProviders into parameterized factory |
| `PromptSender` abstraction | 18 call sites | ~50 | Unified `sendToChat(target, text, options)` wrapper |

### P3 — Cleanup

| Component | Files affected | Description |
|-----------|---------------|-------------|
| Remove duplicate `_appendToTrail()` in dsNotes | 1 file | dsNotes version is simpler but redundant with unifiedNotepad version |
| Extract directory listing utility | 6+ files | `listSubdirectories(dir)` helper |
| Shared webview type definitions | all webview files | TypeScript interfaces for `{ type: string, ... }` messages |

---

## 9. Quantitative Summary

| Metric | Value |
|--------|-------|
| Total `.ts` source lines | 53,539 |
| Separate `_getHtml` implementations | **17** |
| Trail writing systems | **3** (trailLogger, unifiedNotepad, inline `_appendToTrail`) |
| Inline `JSON.parse(readFileSync(...))` sites | **15** |
| Todo systems | **3** (QuestTodoManager, WindowSessionTodoStore, TodoManager) |
| Todo CRUD API surface | **22** + **5** + **5** = 32 total operations |
| Prompt sending mechanisms | **5** distinct paths |
| `workbench.action.chat.open` call sites | **18** |
| `onDidReceiveMessage` registrations | **41** |
| Inline `ensureDir` patterns | **54** |
| Estimated recoverable LOC via extraction | **~2,500-3,000** |
| Largest file (unifiedNotepad-handler.ts) | **4,162 lines** |
| Second largest (questTodoPanel-handler.ts) | **3,806 lines** |
| Third largest (dsNotes-handler.ts) | **3,416 lines** |
