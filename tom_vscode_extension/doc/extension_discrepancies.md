# @Tom VS Code Extension — Discrepancies & Improvement Opportunities

> **Note:** This document is a pre-migration snapshot. Command and setting IDs referenced here use the legacy `tomAi.*` namespace. See `refactoring_plan.md` for the canonical `tomAi.*` mappings.

**Extension:** `tom-ai-extension` (formerly `tom-ai-extension`) v0.1.0  
**Companion doc:** `extension_analysis.md`  
**Date:** 26 Feb 2026

---

## Table of Contents

1. [Inconsistencies](#1-inconsistencies)
2. [Duplication of Functionality](#2-duplication-of-functionality)
3. [Duplication of Configuration](#3-duplication-of-configuration)
4. [Missing Configuration](#4-missing-configuration)
5. [Misleading Names](#5-misleading-names)
6. [Too-Similar Names](#6-too-similar-names)
7. [@CHAT Panel Uniformity Issues](#7-chat-panel-uniformity-issues)
8. [General Improvements & Extractable Components](#8-general-improvements--extractable-components)

---

## 1. Inconsistencies

### 1.1 Command Title Prefixes

Four different prefixes appear across 74 commands:

| Prefix | Count | Examples |
|--------|-------|----------|
| `@T:` | 57 | `DS: Execute File`, `DS: Restart Bridge` |
| `@T:` | 2 | `@T: Print Configuration`, `@T: Show VS Code API Info` |
| `Tom AI:` | 3 | `Tom AI: Start Chat`, `Tom AI: Send Chat Prompt`, `Tom AI: Interrupt Chat` |
| *(none)* | 12 | `Send with Trail Reminder`, `TODO Execution`, `Code Review`, `Expand Prompt`, `Rewrite` |

**Issue:** No single brand identity. "DS:", "@T:", and "Tom AI:" fragment the command palette. The 12 prefix-less commands appear generic and are hard to distinguish from other extensions.

**Recommendation:** Adopt a single prefix (e.g., `Tom:` or `@T:`) for all commands.

### 1.2 Extension Identity Crisis

The extension uses multiple brand names interchangeably:

| Context | Name Used |
|---------|-----------|
| Extension ID | `tom-ai-extension` |
| Display name | `@Tom` (package.json) |
| Command prefix (majority) | `@T:` |
| Command prefix (2 commands) | `@T:` |
| Command prefix (3 commands) | `Tom AI:` |
| View container label | `@Tom` |
| Config namespace | `tomAi.*` |
| Chat participant | `@tom` |
| Subsystem panels | `@CHAT`, `@WS` |
| Tool name prefix (17 tools) | `tom_*` |
| Tool name prefix (14 tools) | `tomAi_*` |
| Chat variable prefix | `tomAi.*` |
| Status bar | `DS` |

### 1.3 Persistence Mechanism Inconsistency

Seven managers use four different persistence mechanisms:

| Manager | Persistence | Format |
|---------|-------------|--------|
| `ChatVariablesStore` | `workspaceState` | JSON (VS Code internal) |
| `PromptQueueManager` | File via `panelYamlStore` | YAML |
| `TimerEngine` | File via `panelYamlStore` | YAML |
| `ReminderSystem` | JSON config file sections | JSON |
| `QuestTodoManager` | Direct YAML file I/O | YAML |
| `WindowSessionTodoStore` | Delegates to `QuestTodoManager` | YAML |
| `TodoManager` | Direct JSON file I/O | JSON |

**Impact:** No unified save/load pattern. Backup/restore requires understanding 4 different storage locations.

### 1.4 WorkspaceState Key Naming Inconsistency

Most keys use the `tomAi.dsNotes.*` prefix, but some don't:

| Key | Expected Pattern | Issue |
|-----|-----------------|-------|
| `llmSelectedConfig` | `tomAi.dsNotes.localLlmConfig` | Missing prefix entirely |
| `conversationAiSetup` | `tomAi.dsNotes.conversationAiSetup` | Missing prefix entirely |
| `qt.panelState` | `tomAi.questTodo.panelState` | Wrong/short prefix |
| `qt.pendingSelect` | `tomAi.questTodo.pendingSelect` | Wrong/short prefix |
| `trailEditor.pendingFocus` | `tomAi.trailEditor.pendingFocus` | Missing namespace |
| `copilotAutoHideDelay` | `tomAi.copilot.autoHideDelay` | Missing prefix entirely |
| `WorkspaceNotepadProvider.STORAGE_KEY` | `tomAi.dsNotes.workspaceNotepadFile` | Class name as key |

In contrast, these follow the convention correctly:
- `tomAi.dsNotes.localLlmDraft`
- `tomAi.dsNotes.conversationDraft`
- `tomAi.dsNotes.copilotDraft`
- `tomAi.dsNotes.tomAiChatDraft`

### 1.5 Unused Storage Keys

Declared in `STORAGE_KEYS` but never actually read or written:

| Key | Declared In |
|-----|------------|
| `tomAi.dsNotes.conversationLlmProfileA` | `dsNotes-handler.ts` |
| `tomAi.dsNotes.conversationLlmProfileB` | `dsNotes-handler.ts` |

### 1.6 Trail Logging — Three Separate Systems

| System | Implementation | Used By |
|--------|---------------|---------|
| **Custom trail (Unified)** | `writePromptTrail()` / `writeAnswerTrail()` in `unifiedNotepad-handler.ts` | Copilot (Unified), Local LLM (Unified), Tom AI Chat (Unified) |
| **`trailLogger-handler.ts`** | `logPrompt()` / `logResponse()` / `clearTrail()` — structured, file-per-step | expandPrompt-handler, botConversation-handler, Copilot (Sidebar), tomAiChat-handler |
| **Custom trail (Sidebar)** | `_appendToTrail()` in `dsNotes-handler.ts` — single `chat_trail.md` file | Local LLM (Sidebar only) |

The unified panel writes to `_ai/trail/{prefix}.prompts.md` / `.answers.md` plus individual files.
The sidebar Local LLM writes to `_ai/local/chat_trail.md`.
The `trailLogger` writes to subsystem-specific folders (`_ai/local/trail/`, `_ai/conversation/trail/`, etc.).

**Impact:** Same user action creates trail files in different locations depending on which UI variant is used. No single trail history view captures all activity.

### 1.7 Trail Folder Path Divergence

| Subsystem | Unified Panel Path | Sidebar Path | trailLogger Path |
|-----------|-------------------|--------------|------------------|
| Local LLM | `_ai/trail/local_llm/` | `_ai/local/chat_trail.md` | `_ai/local/trail/` |
| AI Conversation | (delegates to handler) | `_ai/conversation/trail/` | `_ai/conversation/trail/` |
| Copilot | `_ai/trail/` or quest folder | `_ai/copilot/trail/` | `_ai/copilot/trail/` |
| Tom AI Chat | `_ai/trail/` | **NO trail** | `_ai/tomai/trail/` |

### 1.8 Template Config Path Structure

Copilot templates break the nesting pattern:

| Panel | Config Path | Pattern |
|-------|-------------|---------|
| Local LLM | `config.promptExpander.profiles` | `config.<subsystem>.<collection>` |
| AI Conversation | `config.botConversation.profiles` | `config.<subsystem>.<collection>` |
| Tom AI Chat | `config.tomAiChat.templates` | `config.<subsystem>.<collection>` |
| **Copilot** | **`config.templates`** | **Top-level — inconsistent** |

Copilot templates are at the root of the config, while all other sections nest under their subsystem key.

### 1.9 Source-Level Naming Inconsistency for Subsystems

Each subsystem has multiple names used across different contexts:

| Subsystem | File Names | Config Keys | View IDs | UI Labels | Variables |
|-----------|------------|-------------|----------|-----------|-----------|
| Local LLM | `expandPrompt-handler` | `promptExpander` | `localLlmNotepad` | "Local LLM" | `localLlm` |
| AI Conversation | `botConversation-handler` | `botConversation` | `conversationNotepad` | "AI Conversation" | `conversation` |
| Copilot Chat | `sendToChatAdvanced-handler` | `templates` (top-level) | `copilotNotepad` | "Copilot" | `copilot` |
| Tom AI Chat | `tomAiChat-handler` | `tomAiChat` | `tomAiChatNotepad` | "Tom AI Chat" | `tomAiChat` |

**Issue:** "Prompt Expander" ≠ "Local LLM" ≠ "Ollama". "Bot Conversation" ≠ "AI Conversation" ≠ "Local-Copilot Conversation". These aliases make it hard to trace from UI to code to config.

---

## 2. Duplication of Functionality

### 2.1 Sidebar vs. Unified — Complete Dual Implementation

The four @CHAT sections exist as **two parallel implementations** sharing no code:

| Component | Unified (`unifiedNotepad-handler.ts`) | Sidebar (`dsNotes-handler.ts`) |
|-----------|---------------------------------------|-------------------------------|
| HTML generation | `getPromptEditorComponent()` shared function | 4 separate `_getHtml()` methods per provider class |
| Draft persistence | YAML via `panelYamlStore` | `workspaceState` keys |
| Template loading | `loadSendToChatConfig()` + `applyDefaultTemplate()` | `loadSendToChatConfig()` + `expandPlaceholders()` |
| Send action | Per-section message handlers (`sendLocalLlm`, `sendConversation`, `sendCopilot`, `sendTomAiChat`) | Per-class `_send()` methods |
| Trail logging | Custom `writePromptTrail()` | Custom `_appendToTrail()` or `trailLogger` |
| State sync | **None** — drafts edited in sidebar are not visible in unified, and vice versa |

**Estimated duplication:** ~3,000–4,000 lines across the two handlers.

### 2.2 Config Path Resolution — Two Functions

| Function | File | Difference |
|----------|------|------------|
| `getConfigPath()` | `handler_shared.ts:164` | Uses `resolvePathVariables()` for `${workspaceFolder}`, `${env.VAR}`, etc. |
| `getConfigPathSimple()` | `sendToChatConfig.ts:288` | Only expands `~` and `${home}` (to avoid circular dependency) |

Both follow the same 3-step resolution: workspace `.tom/` → VS Code setting → `~/.tom/vscode/`. The `getConfigPathSimple()` was intentionally simplified to break a circular dependency, but the existence of two functions is confusing.

### 2.3 Inline Config Reading — 15 Sites

Instead of using `loadSendToChatConfig()`, 11 handler files perform their own inline config reads:

```typescript
// Pattern repeated 15 times across the codebase:
const configPath = getConfigPath();
if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    // ... use config.someSection
}
```

**Files with inline config reads:**

| File | Approximate Count |
|------|-------------------|
| `dsNotes-handler.ts` | 3 |
| `expandPrompt-handler.ts` | 3 |
| `combinedCommand-handler.ts` | 1 |
| `stateMachine-handler.ts` | 1 |
| `restartBridge-handler.ts` | 2 |
| `trailLogger-handler.ts` | 1 |
| `commandline-handler.ts` | 1 |
| `reminderSystem.ts` | 1 |
| `telegram-commands.ts` | 1 |
| `telegram-cmd-handlers.ts` | 1 |

**Issue:** Error handling varies per site. Some silently swallow errors, some log, some return undefined. A single `readConfigSection<T>(sectionKey)` utility would eliminate this.

### 2.4 `_insertExpandedToChatFile()` — Duplicated

Both `unifiedNotepad-handler.ts` and `dsNotes-handler.ts` contain independent implementations of `_insertExpandedToChatFile()` with identical regex logic:

```typescript
// Same regex in both files:
/_{3,}\s*CHAT\s+\w+\s*_{3,}/
```

### 2.5 `_openOrCreateChatFile()` — Duplicated

Both handlers contain their own implementation for creating and opening `.chat.md` files with the same default `modelId: claude-sonnet-4-20250514` header.

### 2.6 Inline `ensureDir` Patterns — 54 Occurrences

Across 21 files, directory creation is done with inline patterns:

```typescript
// Repeated ~54 times:
if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
}
```

No shared `ensureDir()` utility exists despite this being one of the most common operations.

### 2.7 Three Todo Systems

| System | Manager | Persistence | ID Type | Used By |
|--------|---------|-------------|---------|---------|
| Quest Todos | `QuestTodoManager` | YAML (`*.todo.yaml`) | String (UUID) | Quest TODO panel, Chat Enhancement Tools |
| Session Todos | `WindowSessionTodoStore` | YAML (wraps Quest) | String (UUID) | Session TODO sidebar, Chat Enhancement Tools |
| Scratch Todos | `TodoManager` | JSON (`*.todos.json`) | Number (auto-increment) | Tom AI Chat only |

`TodoManager` has incompatible types with `QuestTodoManager`. Its functionality (create, update, list, get, delete) is a subset of what `QuestTodoManager` already provides.

### 2.8 HTML Generation — 17 `_getHtml()` Methods

`dsNotes-handler.ts` contains **10 separate `WebviewViewProvider` classes**, each with its own `_getHtml()` method generating HTML inline. While each panel has unique content, the boilerplate (head, styles, nonce, script tags) is identical.

In addition to these 10, `unifiedNotepad-handler.ts`, `t3Panel-handler.ts`, `statusPage-handler.ts`, `queueEditor-handler.ts`, `timedRequestsEditor-handler.ts`, `globalTemplateEditor-handler.ts`, and `contextSettingsEditor-handler.ts` each have their own HTML generation.

### 2.9 Five Prompt-Sending Mechanisms

| Mechanism | Target | Used By |
|-----------|--------|---------|
| `workbench.action.chat.open` | VS Code Copilot Chat | sendToChatAdvanced, unifiedNotepad, dsNotes (~18 call sites) |
| `sendCopilotRequest()` | VS Code LM API (streaming) | tomAiChat-handler (3 sites) |
| Direct `model.sendRequest()` | VS Code LM API | tool-executors (~7 sites) |
| `PromptExpanderManager.process()` | Ollama HTTP API | expandPrompt-handler, unifiedNotepad, dsNotes |
| `bridgeClient.sendRequest()` | Dart Bridge (JSON-RPC) | Various handlers (script execution, CLI, etc.) |

### 2.10 Webview Message Handling — 41 Custom Handlers

Every webview panel registers its own `onDidReceiveMessage` handler with custom message type strings. No shared message router, no TypeScript types for messages, no validation.

---

## 3. Duplication of Configuration

### 3.1 Ollama URL — 9 Hardcoded Occurrences

`http://localhost:11434` appears in:

| File | Count | Context |
|------|-------|---------|
| `statusPage-handler.ts` | 6 | Health check, status display |
| `expandPrompt-handler.ts` | 2 | API calls |
| `dsNotes-handler.ts` | 1 | Status check |

The VS Code setting `tomAi.ollama.url` exists but these inline references don't all use it.

### 3.2 Model Name Defaults — Scattered

| Model | Files | Purpose |
|-------|-------|---------|
| `gpt-4o` | `handler_shared.ts`, package.json | Default Copilot model |
| `gpt-5.2` | `tomAiChat-handler.ts`, package.json | Tom AI Chat default |
| `gpt-5-mini` | package.json | Pre-processing model |
| `qwen3:8b` | package.json | Ollama default model |
| `claude-sonnet-4-20250514` | `unifiedNotepad-handler.ts`, `dsNotes-handler.ts` | Chat file default model |

These are defined both in `package.json` defaults AND inline in code. If the VS Code setting is changed, the inline occurrences may still use the old value.

### 3.3 Duplicate Path Definitions

Some paths appear in both `WsPaths` and inline in handler code:

| Path | In WsPaths | Inline Occurrences |
|------|-----------|-------------------|
| `_ai/quests` | `AI_SUBPATHS.quests` | `questTodoManager.ts`, `variableResolver.ts` |
| `_ai/local` | `AI_SUBPATHS.local` | `dsNotes-handler.ts` |
| `_ai/copilot` | `AI_SUBPATHS.copilot` | `dsNotes-handler.ts` |
| `_ai/trail` | *(Missing)* | `unifiedNotepad-handler.ts`, `trailViewer-handler.ts` |
| `_copilot_guidelines` | `WORKSPACE_PATHS.guidelinesFolder` | `t3Panel-handler.ts`, `contextSettingsEditor-handler.ts` |

### 3.4 Answer File Path — Configured in Two Places

| Location | Setting | Default |
|----------|---------|---------|
| JSON config | `copilotChatAnswerFolder` | (varies) |
| VS Code setting | `tomAi.sendToCopilot.chatAnswerFolder` | `_ai/chat_replies` |

Both are checked, with the JSON config taking precedence. This creates confusion about which one is the "real" setting.

### 3.5 Trail Path Defaults — Config AND Constants

Trail paths have defaults in `trailLogger-handler.ts` AND are configurable via `config.trail.paths.*`:

| Subsystem | Hardcoded Default | Config Key |
|-----------|-------------------|------------|
| `local` | `_ai/local/trail/` | `trail.paths.local` |
| `conversation` | `_ai/conversation/trail/` | `trail.paths.conversation` |
| `tomai` | `_ai/tomai/trail/` | `trail.paths.tomai` |
| `copilot` | `_ai/copilot/trail/` | `trail.paths.copilot` |
| `escalation` | `_ai/trail/escalation/` | `trail.paths.escalation` |

But the unified notepad uses DIFFERENT paths (`_ai/trail/`, `_ai/trail/local_llm/`) that ignore these config values entirely.

---

## 4. Missing Configuration

### 4.1 Paths in `WsPaths` That Should Be Configurable

The `workspacePaths.ts` `WsPaths` class defines paths as constants. These should probably be VS Code settings or JSON config entries:

| Path | Current Value | Why Configurable |
|------|---------------|-----------------|
| `_ai/` | Hardcoded | AI folder root — some users may want a different folder |
| `_ai/trail/` | Hardcoded | Trail root |
| `_ai/prompt/` | Hardcoded (missing from WsPaths) | Prompt templates folder |
| `_ai/attachments/` | Hardcoded | Attachment storage |
| `_ai/answers/copilot/` | Hardcoded | Answer file location |
| `_ai/bot_conversations/` | Hardcoded | Conversation logs |

### 4.2 Paths Missing from `WsPaths` Entirely

Used inline in code but not registered in the central path registry:

| Path | Used In | Purpose |
|------|---------|---------|
| `_copilot_tomai/` | `tool-executors.ts` | Tom AI Chat guidelines |
| `_copilot_local/` | `tool-executors.ts` | Local guidelines |
| `ztmp/` | Various | Temporary files |
| `_ai/trail/` | `unifiedNotepad-handler.ts` | Individual trail files root |
| `_ai/trail/escalation/` | `escalation-tools-config.ts` | Escalation trail |
| `_ai/prompt/` | `reusablePromptEditor-handler.ts` | Reusable prompts |
| `.tom/json-schema/` | `variableResolver.ts` | JSON schema folder |
| `_ai/local/local-instructions/` | Various | Local LLM instructions |

### 4.3 Magic Numbers — Hardcoded Timeouts and Limits

| Value | File | Purpose | Should Be |
|-------|------|---------|-----------|
| `30000` ms | `vscode-bridge.ts` | Bridge request timeout | Config: `tomAiBridge.requestTimeout` |
| `5000` ms | `vscode-bridge.ts` | Bridge restart delay | Config: `tomAiBridge.restartDelay` |
| `10` | `vscode-bridge.ts` | Max restart attempts | Config: `tomAiBridge.maxRestarts` |
| `30000` ms | `timerEngine.ts` | Timer tick interval | Config: `timedRequests.tickInterval` |
| `30000` ms | `reminderSystem.ts` | Reminder check interval | Config: `reminderConfig.checkInterval` |
| `600000` ms | `reminderSystem.ts` | Default reminder timeout | Config: `reminderConfig.defaultTimeout` |
| `300000` ms | `telegram-channel.ts` | Telegram poll interval | Config: `botConversation.telegram.pollInterval` |
| `86400000` ms | `trailLogger-handler.ts` | Trail cleanup cutoff (1 day) | Config: `trail.cleanupIntervalMs` |
| `50` | `trailLogger-handler.ts` | Max trail files per folder | Config: `trail.maxFilesPerFolder` |
| `100` | `trailViewer-handler.ts` | Max exchanges to display | Config: `trail.maxViewerExchanges` |
| `2000` ms | `extension.ts` | Bridge auto-start delay | Config: `tomAiBridge.autoStartDelay` |
| `1000` ms | `extension.ts` | CLI server auto-start delay | Config: `cliServer.autoStartDelay` |
| `2000` ms | `extension.ts` | Telegram auto-start delay | Config: `telegram.autoStartDelay` |

### 4.4 Hardcoded File Extension Patterns

These globs are scattered across code and could be centralized:

| Pattern | Used In | Purpose |
|---------|---------|---------|
| `*.todo.yaml` | `questTodoManager.ts`, `workspacePaths.ts`, package.json | Todo file detection |
| `*.prompt.md` | `reusablePromptEditor-handler.ts` | Reusable prompt detection |
| `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | package.json | YAML graph files |
| `*.prompts.md`, `*.answers.md` | `trailEditor-handler.ts`, package.json | Consolidated trail files |
| `*.chat.md` | `tomAiChat-handler.ts`, `unifiedNotepad-handler.ts`, `dsNotes-handler.ts` | Chat files |
| `.userprompt.md`, `.answer.json` | `trailViewer-handler.ts`, `unifiedNotepad-handler.ts` | Trail exchange files |

---

## 5. Misleading Names

### 5.1 Commands with Misleading Titles

| Command ID | Current Title | Issue |
|------------|---------------|-------|
| `tomAi.sendToCopilot.addToTodo` | "Add to Todo" | Actually sends a pre-configured prompt to Copilot Chat — doesn't add anything to a todo list |
| `tomAi.sendToCopilot.fixMarkdown` | "Fix Markdown here" | Sends to Copilot Chat with a template — doesn't fix markdown in-place |
| `tomAi.sendToCopilot.codeReview` | "Code Review" | Too generic — actually sends to Copilot Chat with a code review template |
| `tomAi.sendToCopilot.explain` | "Explain Code" | Too generic — actually sends to Copilot Chat with an explanation template |
| `tomAi.sendToCopilot.todoExecution` | "TODO Execution" | Sends to Copilot Chat — doesn't execute todos |
| `tomAi.focusTomAi` | "DS: Focus Tom AI Panel" | Actually focuses the @CHAT panel, not specifically "Tom AI" |
| `tomAi.combined.showSideNotes` | "DS: Show Side Notes" | Unclear what "Side Notes" are — these are the Explorer sidebar note views |
| `tomAi.sendToLocalLlm` | "DS: Expand Prompt (Ollama)" | "Expand" is misleading for users unfamiliar — this sends the prompt to a local LLM |

### 5.2 View Names vs. View IDs

| View ID | Display Name | Mismatch |
|---------|-------------|----------|
| `tomAi.tomNotepad` | "VS CODE NOTES" | ID says "tom", display says "VS CODE" |
| `tomAi.chatPanel` | "@CHAT" | ID says "chatPanel", display says "@CHAT" |
| `tomAi.wsPanel` | "@WS" | ID says "wsPanel", display says "@WS" |
| `tomAi.localLlmNotepad` | "Local LLM" | "Notepad" in ID, but not a notepad — it's a chat interface |
| `tomAi.conversationNotepad` | "AI Conversation" | "Notepad" in ID, but purpose is conversation management |

### 5.3 Handler File Names vs. Purpose

| File | Name Suggests | Actually Does |
|------|--------------|---------------|
| `dsNotes-handler.ts` | "DS Notes" — note-taking | 12 sidebar webview providers for notes, todos, chat, LLM, conversation, guidelines, docs |
| `expandPrompt-handler.ts` | Prompt expansion only | Full Local LLM management (model selection, profile management, prompt sending, result display) |
| `sendToChatAdvanced-handler.ts` | Advanced send-to-chat | Template-based send-to-chat with pre-configured commands (Standard, Trail Reminder, Code Review, etc.) |
| `handler_shared.ts` | Shared handler utilities | Massive file (956 lines) including config reading, bridge access, template management, external app handling, and various utilities |

---

## 6. Too-Similar Names

### 6.1 Confusing Command Pairs

| Command A | Command B | Confusion |
|-----------|-----------|-----------|
| `DS: Send to Copilot Chat` | `DS: Send to Copilot Chat (Standard)` | What's the difference? (Answer: Standard uses the default template without showing picker) |
| `DS: Send to Copilot Chat (Standard)` | `DS: Send to Copilot Chat (Template)...` | Three "Send to Copilot Chat" variants hard to distinguish |
| `DS: Send to local LLM` | `DS: Send to local LLM (Standard)` | Same issue — three variants |
| `DS: Send to local LLM` | `DS: Expand Prompt (Ollama)` | Both send to Ollama but with different UX |
| `DS: Start Local-Copilot Conversation` | `DS: Start Tom CLI Integration Server` | Both start long-running processes, "Local-Copilot" ≈ "Tom CLI"? |
| `DS: Open Prompt Trail Viewer` | `DS: Open Trail Viewer (Select Folder)` | Two trail viewers with subtle differences |
| `DS: Open Prompt Template Editor` | `DS: Open Reusable Prompt Editor` | "Template" vs "Reusable Prompt" — what's the difference? |

### 6.2 Similar LM Tool Names

| Tool A | Tool B | Confusion |
|--------|--------|-----------|
| `tomAi_listTodos` | `tomAi_getAllTodos` | "list" vs "getAll" — both return todo lists (difference: `getAllTodos` includes session todos) |
| `tomAi_windowTodo_list` | `tomAi_windowTodo_getAll` | Same issue within session todos |
| `addToPromptQueue` | `tom_queue_update_item` | One uses camelCase, the other uses `tom_` prefix for the same subsystem |
| `addFollowUpPrompt` | `tom_queue_update_followup` | Same inconsistency |
| `addTimedRequest` | `tom_timed_update_entry` | Same inconsistency |
| `tom_readGuideline` | `tom_readLocalGuideline` | Only difference is the folder — `_copilot_tomai/` vs `_copilot_local/` |

### 6.3 Tool Name Prefix Inconsistency

| Prefix | Count | Examples |
|--------|-------|----------|
| `tom_` | 17 | `tom_readFile`, `tom_createFile`, `tom_queue_list` |
| `tomAi_` | 14 | `tomAi_notifyUser`, `tomAi_listTodos` |
| *(camelCase, no prefix)* | 4 | `addToPromptQueue`, `addFollowUpPrompt`, `sendQueuedPrompt`, `addTimedRequest` |

The 4 prefix-less tools (`addToPromptQueue`, `addFollowUpPrompt`, `sendQueuedPrompt`, `addTimedRequest`) were apparently the original queue/timed tools, later supplemented with the `tom_queue_*` / `tom_timed_*` family without removing the originals.

### 6.4 Config Section Names vs. UI Names

| UI Name | Config Section | Mismatch |
|---------|---------------|----------|
| "Local LLM" | `promptExpander` | Not "localLlm" |
| "AI Conversation" | `botConversation` | Not "aiConversation" or "conversation" |
| "Copilot" | `templates` (top-level) | Not "copilot.templates" |
| "Tom AI Chat" | `tomAiChat` | ✓ Consistent |

---

## 7. @CHAT Panel Uniformity Issues

### 7.1 Feature Availability Matrix

| Feature | Local LLM | AI Conversation | Copilot | Tom AI Chat |
|---------|-----------|-----------------|---------|-------------|
| Template/profile picker | ✓ | ✓ | ✓ | ✓ |
| Secondary selector (model/setup) | ✓ (LLM Config) | ✓ (AI Setup) | ✗ | ✗ |
| `defaultTemplates` config support | ✗ | ✗ | ✓ | ✗ |
| Answer file watcher | ✗ | ✗ | ✓ (Unified only) | ✗ |
| Keep content after send | ✗ | ✗ | ✓ | ✗ |
| Auto-hide delay | ✗ | ✗ | ✓ | ✗ |
| Queue integration | ✗ | ✗ | ✓ | ✗ |
| Timed requests | ✗ | ✗ | ✓ | ✗ |
| Context popup (quest/role) | ✗ | ✗ | ✓ | ✗ |
| Trail viewer button | ✓ | ✗ | ✓ | ✗ |
| Preview before send | ✓ | ✓ | ✓ | ✓ |
| Open chat file button | ✗ | ✗ | ✗ | ✓ |
| Progress notification + cancel | ✓ | ✗ | ✗ | ✗ (separate command) |
| LLM config validation | ✓ (Unified) | ✓ (Unified) | ✗ | ✗ |
| Slot support (9 slots) | ✓ | ✓ | ✓ | ✓ |
| Sidebar trail logging | ✓ (custom `_appendToTrail`) | ✓ (trailLogger) | ✓ (trailLogger) | **✗ (MISSING)** |
| Unified trail logging | ✓ (custom) | (delegates) | ✓ (custom) | ✓ (custom) |

**Key asymmetries:**
- **Queue & timed requests** exist only for Copilot, not for Local LLM, AI Conversation, or Tom AI Chat
- **Trail logging** is missing from sidebar Tom AI Chat entirely
- **Answer watching** is Copilot-only
- **Context popup** (quest/role selection) is Copilot-only
- **`defaultTemplates`** applies only to Copilot — the other 3 sections always start with empty or last-used template
- **Progress/cancellation** differs per panel: LLM gets `ProgressLocation.Notification`, Tom AI Chat has a separate interrupt command, Copilot and Conversation have no cancellation

### 7.2 Send Action Terminology

| Panel | Unified Button | Sidebar Button | Message Type (Unified) | Message Type (Sidebar) |
|-------|---------------|----------------|----------------------|----------------------|
| Local LLM | "Send to LLM" | "➤" | `sendLocalLlm` | `send` |
| AI Conversation | "Start" | "▶" | `sendConversation` | `startConversation` |
| Copilot | Codicon send icon | "Send to Copilot" | `sendCopilot` | `send` |
| Tom AI Chat | "Insert" | "Insert" | `sendTomAiChat` → `insertToChatFile` | `insertToChatFile` |

**Issues:**
- "Send" vs "Start" vs "Insert" — three different verbs for the same concept
- Message type names differ between Unified and Sidebar for the same action
- Sidebar uses generic `send` for two different panels (LLM and Copilot), distinguishable only by which class handles it

### 7.3 Draft Persistence Split

| Panel | Unified Storage | Sidebar Storage | Synced? |
|-------|----------------|-----------------|---------|
| Local LLM | `panelYamlStore('localLlm')` | `workspaceState: tomAi.dsNotes.localLlmDraft` | **No** |
| AI Conversation | `panelYamlStore('conversation')` | `workspaceState: tomAi.dsNotes.conversationDraft` | **No** |
| Copilot | `panelYamlStore('copilot')` | `workspaceState: tomAi.dsNotes.copilotDraft` | **No** |
| Tom AI Chat | `panelYamlStore('tomAiChat')` | `workspaceState: tomAi.dsNotes.tomAiChatDraft` | **No** |

Users who type a draft in the sidebar and then switch to the bottom panel (or vice versa) will not see their draft. This is a confusing user experience.

### 7.4 Template Expansion — Two Different Pipelines

| Context | Pipeline |
|---------|----------|
| **Unified Panel** | `applyDefaultTemplate()` → `expandTemplate()` (with `values` map support) |
| **Sidebar Notes** | `expandPlaceholders()` (simpler, no `values` map) |

The unified panel wraps prompts in a default template (if configured), then expands all variables. The sidebar skips the default template wrapping.

### 7.5 Destructive `clearTrail()` in Sidebar Copilot

The sidebar `CopilotNotepadProvider._send()` calls `clearTrail('copilot')` before every send, which resets the trail sequence counter and may delete trail files. The unified version does NOT clear the trail — it appends with sequence numbers.

**Impact:** Using the sidebar Copilot panel destroys trail history; using the unified panel preserves it.

### 7.6 @CHAT Chord Menu Gaps

| Chord Menu | Shortcut | Exists? |
|------------|----------|---------|
| Conversation Shortcuts | `Ctrl+Shift+C` | ✓ |
| Local LLM Shortcuts | `Ctrl+Shift+L` | ✓ |
| Send to Chat Shortcuts | `Ctrl+Shift+A` | ✓ |
| Tom AI Chat Shortcuts | `Ctrl+Shift+T` | ✓ |

All four subsystems have chord menus, but the naming doesn't align:
- "Send to Chat Shortcuts" → this is the Copilot chord, but it says "Chat" not "Copilot"
- "Conversation Shortcuts" → the section is called "AI Conversation" in the UI
- "Local LLM Shortcuts" → consistent

---

## 8. General Improvements & Extractable Components

### 8.1 Unified Config Reader

**Extract:** A single `ConfigReader` utility class that:
- Resolves the config path once (caching the resolution)
- Provides typed accessor methods: `getSection<T>(key: string): T | undefined`
- Has a `reload()` method for `tomAi.reloadConfig`
- Handles error reporting consistently
- Replaces both `getConfigPath()` and `getConfigPathSimple()`

**Estimated savings:** Eliminates 15 inline `JSON.parse(fs.readFileSync(...))` sites.

### 8.2 `ensureDir()` / `safeReadFile()` / `safeReadJson()` Utilities

**Extract:** Simple file operation utilities:

```typescript
function ensureDir(dirPath: string): void;
function safeReadFile(filePath: string): string | undefined;
function safeReadJson<T>(filePath: string): T | undefined;
function safeWriteJson(filePath: string, data: unknown): void;
```

**Estimated savings:** Eliminates ~54 inline `mkdirSync` patterns and ~30 inline `readFileSync` + `JSON.parse` patterns.

### 8.3 Shared Webview Base Class

**Extract:** A `BaseWebviewProvider` class that:
- Handles HTML boilerplate (head, CSP nonce, styles, script loading)
- Provides a standard message handling registration pattern
- Manages webview lifecycle (dispose, visibility change)
- Offers `getBaseStyles()` + `getBaseScript()` methods

**Estimated savings:** Consolidates 17 `_getHtml()` methods into one pattern.

### 8.4 Unified Trail Logger

**Extract:** Consolidate the 3 trail systems into one:
- Single `TrailService` class
- Configurable output formats (individual files, consolidated files, single log file)
- Configurable output paths (per-subsystem via config)
- Used by all 4 @CHAT sections consistently
- Eliminates custom `_appendToTrail()` implementations

### 8.5 @CHAT Panel Abstraction

**Extract:** A `ChatSection` interface/base class that all 4 @CHAT sections implement:

```typescript
interface ChatSection {
    readonly id: string;              // 'localLlm' | 'conversation' | 'copilot' | 'tomAiChat'
    readonly label: string;           // Display name
    readonly icon: string;            // Codicon
    readonly configSection: string;   // Config key for templates/profiles
    
    getHtml(webview: Webview): string;
    handleMessage(message: any): Promise<void>;
    saveDraft(text: string): Promise<void>;
    loadDraft(): Promise<string>;
    send(text: string, template?: string): Promise<void>;
    logTrail(prompt: string, response?: string): Promise<void>;
}
```

This would:
- Eliminate the sidebar/unified dual implementation
- Force uniform feature support across all 4 sections
- Make adding new sections trivial
- Sync drafts between sidebar and bottom panel automatically

### 8.6 Unified Todo System

**Extract:** Merge `TodoManager` into `QuestTodoManager` or create an adapter:
- `TodoManager` is only used by Tom AI Chat for scratch todos
- It could be replaced by a "session todo" file managed through `QuestTodoManager`
- Eliminates one persistence format (JSON → YAML)

### 8.7 Shared Message Types

**Extract:** TypeScript interfaces for webview messages:

```typescript
// Instead of 41 custom onDidReceiveMessage handlers with untyped messages:
interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

// Per-panel typed messages:
interface ChatPanelMessage extends WebviewMessage {
    type: 'send' | 'saveDraft' | 'loadDraft' | 'switchTemplate' | ...;
    panelId: ChatSectionId;
    text?: string;
    templateId?: string;
}
```

### 8.8 Constants Registry

**Extract:** Move all magic numbers, file patterns, and default values into a single `constants.ts`:

```typescript
export const BRIDGE_TIMEOUT_MS = 30_000;
export const BRIDGE_RESTART_DELAY_MS = 5_000;
export const BRIDGE_MAX_RESTARTS = 10;
export const TIMER_TICK_MS = 30_000;
export const REMINDER_CHECK_MS = 30_000;
export const REMINDER_DEFAULT_TIMEOUT_MS = 600_000;
export const TRAIL_CLEANUP_DAYS = 1;
export const TRAIL_MAX_FILES = 50;
export const TRAIL_MAX_VIEWER_EXCHANGES = 100;
// File patterns
export const FILE_EXT_TODO = '.todo.yaml';
export const FILE_EXT_CHAT = '.chat.md';
export const FILE_EXT_PROMPT = '.prompt.md';
export const FILE_EXT_TRAIL_PROMPT = '.userprompt.md';
export const FILE_EXT_TRAIL_ANSWER = '.answer.json';
```

### 8.9 Config Section Normalization

**Proposed structure** — move all template/profile configs under their subsystem:

```jsonc
{
    "localLlm": {
        "profiles": [...],          // Currently: promptExpander.profiles
        "models": [...],            // Currently: promptExpander.models
        "llmConfigurations": [...], // Currently: promptExpander.llmConfigurations
        "defaultTemplate": "..."    // Currently: missing
    },
    "conversation": {
        "profiles": [...],          // Currently: botConversation.profiles
        "selfTalk": [...],          // Currently: botConversation.selfTalk
        "telegram": {...},          // Currently: botConversation.telegram
        "defaultTemplate": "..."    // Currently: missing
    },
    "copilot": {
        "templates": [...],         // Currently: templates (top-level!)
        "defaultTemplate": "..."    // Currently: defaultTemplates.copilot
    },
    "tomAiChat": {
        "templates": [...],         // Currently: tomAiChat.templates
        "defaultTemplate": "..."    // Currently: missing
    },
    "trail": {...},
    "bridge": {...},                // Currently: tomAiBridge
    // ... rest
}
```

### 8.10 Sidebar/Unified State Sync

Since both the sidebar and unified panel exist, their state should be synced:

- **Option A:** Remove sidebar @CHAT sections entirely (since the unified bottom panel covers all 4)
- **Option B:** Make sidebar views thin wrappers that delegate to shared `ChatSection` instances
- **Option C:** Use a shared `StateStore` (file or `workspaceState`) that both UI variants read/write

### 8.11 Command Naming Convention

**Proposed renaming:**

| Current | Proposed | Rationale |
|---------|----------|-----------|
| `DS: Send to Copilot Chat` | `Tom: Send to Copilot` | Consistent prefix, shorter |
| `DS: Send to Copilot Chat (Standard)` | `Tom: Send to Copilot (Default Template)` | Clearer meaning |
| `DS: Send to Copilot Chat (Template)...` | `Tom: Send to Copilot (Pick Template)` | Clearer meaning |
| `DS: Send to local LLM` | `Tom: Send to Local LLM` | Consistent prefix |
| `DS: Expand Prompt (Ollama)` | `Tom: Expand with Local LLM` | Remove "Ollama" branding |
| `DS: Start Local-Copilot Conversation` | `Tom: Start AI Conversation` | Match panel name |
| `@T: Print Configuration` | `Tom: Print Configuration` | Consistent prefix |
| `@T: Show VS Code API Info` | `Tom: Show VS Code API Info` | Consistent prefix |
| `Tom AI: Start Chat` | `Tom: Start Tom AI Chat` | Consistent prefix |
| All prefix-less commands | Add `Tom:` prefix | Consistency |

---

## Summary — Priority Issues

### Critical (Should fix before adding features)

| # | Issue | Impact | Sections |
|---|-------|--------|----------|
| C1 | Sidebar @CHAT and Unified @CHAT have no shared code or state sync | User confusion, duplicate bugs, double maintenance cost | 2.1, 7.3 |
| C2 | Three independent trail systems with divergent paths | Trail data scattered, no unified history view | 1.6, 1.7, 7.5 |
| C3 | Sidebar Tom AI Chat has NO trail logging | Lost conversation history | 7.1 |

### High (Should address in next refactoring pass)

| # | Issue | Impact | Sections |
|---|-------|--------|----------|
| H1 | 15 inline config reads with inconsistent error handling | Fragile, hard to debug config issues | 2.3 |
| H2 | 54 inline `ensureDir` patterns | Code bloat, inconsistent error handling | 2.6 |
| H3 | Feature asymmetry across @CHAT panels (queue/timed only Copilot) | Inconsistent UX | 7.1 |
| H4 | WorkspaceState key naming inconsistency | Risk of key collision, confusing debugging | 1.4 |
| H5 | Copilot templates at wrong config path (top-level) | Config structure inconsistency | 1.8 |
| H6 | Mixed command prefixes (`@T:`, `@T:`, `Tom AI:`, none) | Fragmented command palette experience | 1.1 |

### Medium (Should address when touching related code)

| # | Issue | Impact | Sections |
|---|-------|--------|----------|
| M1 | 17 `_getHtml()` methods with no shared base | Boilerplate duplication | 2.8 |
| M2 | 3 todo systems with incompatible types | Confusing API surface | 2.7 |
| M3 | 41 custom webview message handlers | No type safety, no validation | 2.10 |
| M4 | 8 paths missing from `WsPaths` | Hardcoded magic strings | 4.2 |
| M5 | 30+ magic numbers | Not configurable, scattered | 4.3 |
| M6 | Misleading command names | User confusion | 5.1 |
| M7 | Tool name prefix inconsistency (`tom_` vs `tomAi_` vs camelCase) | Confusing tool discovery | 6.3 |
| M8 | 9 hardcoded Ollama URL occurrences | Bug risk if URL changes | 3.1 |
| M9 | Subsystem name aliases (3 names per subsystem) | Hard to trace UI → code → config | 1.9 |

### Low (Nice to have)

| # | Issue | Impact | Sections |
|---|-------|--------|----------|
| L1 | Unused `STORAGE_KEYS` entries | Dead code | 1.5 |
| L2 | File extension patterns not centralized | Minor maintenance burden | 4.4 |
| L3 | Duplicate `addToPromptQueue` / `tom_queue_*` tools | Confusing tool set | 6.3 |
| L4 | View ID vs display name mismatches | Minor developer confusion | 5.2 |
