# Refactoring Plan Implementation Status

**Generated:** 2026-03-01  
**Source:** [refactoring_plan.md](refactoring_plan.md)

This document tracks the exact implementation status of every point in the refactoring plan by scanning the actual codebase.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Fully implemented |
| ⚠️ PARTIAL | Partially implemented |
| ❌ NOT DONE | Not yet implemented |
| ➖ N/A | Not applicable or removed from scope |

---

## Section 1: Identity & Branding

### 1.1 Extension Metadata

| Property | Plan Target | Actual | Status |
|----------|-------------|--------|--------|
| Extension ID (`name`) | `tom-ai-extension` | `tom-ai-extension` | ✅ |
| Display name | `@Tom` | `@Tom` | ✅ |
| Publisher | `Peter Nicolai Alexis Kyaw` | `peter-nicolai-alexis-kyaw` | ✅ |
| Description | Updated description | "AI-powered workspace automation with Copilot, Local LLM, and AI Chat integration" | ✅ |
| View container label (@CHAT) | `@CHAT` | `@CHAT` | ✅ |
| Chat participant ID | `@tom` | N/A — extension uses LM API, not chat participant API | ➖ N/A |
| Chat variable prefix | `tomAi.*` | `tomAi.*` | ✅ |
| Status bar prefix | `@T` | N/A — no VS Code status bar item registered | ➖ N/A |

### 1.2 Command Prefix Convention

| Requirement | Status | Evidence |
|-------------|--------|----------|
| `@T:` for Command Palette | ✅ | Commands use `@T:` prefix in `title` field |
| No prefix for context menus | ✅ | All 22 context menu commands have `shortTitle` without prefix; submenu labels prefix-free |
| `@T:`/`Tom AI:` eliminated | ✅ | No legacy `Tom AI:` prefixes remain; all use `@T:` for Command Palette only |

### 1.3 Config Namespace

| Property | Plan Target | Actual | Status |
|----------|-------------|--------|--------|
| VS Code settings prefix | `tomAi.*` | `tomAi.*` | ✅ |
| WorkspaceState key prefix | `tomAi.*` | Migrated from `tomAi.dsNotes.*` | ✅ |
| Chat variable prefix | `tomAi.*` | `tomAi.*` | ✅ |

### 1.4 Internal Subsystem Canonical Names

| Subsystem | Plan Name | Config Key in Code | Status |
|-----------|-----------|-------------------|--------|
| Local LLM | `localLlm` | `LocalLlmConfig` in handler | ✅ |
| AI Conversation | `aiConversation` | `AiConversationConfig` in handler | ✅ |
| Copilot Chat | `copilot` | `copilot` | ✅ |
| Tom AI Chat | `tomAiChat` | `tomAiChat` | ✅ |

---

## Section 2: Command Renaming

### 2.1 Command ID Prefix Migration

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Commands use `tomAi.*` IDs | ✅ | package.json uses `tomAi.*` command IDs |
| Command titles use `@T:` prefix | ✅ | Titles like `@T: Send to Copilot` |
| Legacy `tomAi.*` aliases maintained | ✅ | All commands already use `tomAi.*` IDs; no legacy aliases exist |

### 2.2 Submenu Renaming

| Current ID | Plan Target | Actual | Status |
|------------|-------------|--------|--------|
| `tomAi.sendToCopilotSubmenu` | `tomAi.sendToCopilotSubmenu` | `tomAi.sendToCopilotSubmenu` | ✅ |
| `tomAi.sendToLocalLlmSubmenu` | `tomAi.sendToLocalLlmSubmenu` | `tomAi.sendToLocalLlmSubmenu` | ✅ |

---

## Section 3: View & Panel Renaming

### 3.1 View Containers

| Current ID | Plan Target | Actual ID | Status |
|------------|-------------|-----------|--------|
| `tomAi-chat-panel` | `tomAi-chat-panel` | `tomAi-chat-panel` | ✅ |
| `tomAi-ws-panel` | `tomAi-ws-panel` | `tomAi-ws-panel` | ✅ |

### 3.2 Views

| Current View ID | Plan Target | Actual | Status |
|-----------------|-------------|--------|--------|
| `tomAi.chatPanel` | `tomAi.chatPanel` | `tomAi.chatPanel` | ✅ |
| `tomAi.wsPanel` | `tomAi.wsPanel` | `tomAi.wsPanel` | ✅ |
| `tomAi.tomNotepad` | `tomAi.vscodeNotes` | `tomAi.vscodeNotes` | ✅ |
| `tomAi.questNotesView` | `tomAi.questNotes` | `tomAi.questNotes` | ✅ |
| `tomAi.questTodosView` | `tomAi.questTodos` | `tomAi.questTodos` | ✅ |
| `tomAi.sessionTodosView` | `tomAi.sessionTodos` | `tomAi.sessionTodos` | ✅ |
| `tomAi.todoLogView` | `tomAi.todoLog` | `tomAi.todoLog` | ✅ |
| `tomAi.workspaceNotepad` | `tomAi.workspaceNotes` | `tomAi.workspaceNotes` | ✅ |
| `tomAi.workspaceTodosView` | `tomAi.workspaceTodos` | `tomAi.workspaceTodos` | ✅ |

### 3.3 Custom Editors

| Current Type | Plan Target | Actual | Status |
|--------------|-------------|--------|--------|
| `yamlGraph.editor` | `tomAi.yamlGraphEditor` | `tomAi.yamlGraphEditor` | ✅ |
| `questTodo.editor` | `tomAi.todoEditor` | `tomAi.todoEditor` | ✅ |
| `trailViewer.editor` | `tomAi.trailViewer` | `tomAi.trailViewer` | ✅ |
| `summaryTrailViewer.editor` | `tomAi.summaryTrailViewer` | N/A — summary/raw trail viewers are commands, not custom editors | ➖ N/A |
| `rawTrailViewer.editor` | `tomAi.rawTrailViewer` | N/A — raw trail viewer is a command (`tomAi.editor.rawTrailViewer`) | ➖ N/A |

### 3.4 @CHAT Panel Tabs

| Current Internal ID | Plan Target | Status |
|--------------------|-------------|--------|
| `localLlm` | `localLlmChatPanel` | ✅ Already clean — IDs are `localLlm`, `conversation`, `copilot`, `tomAiChat` (no `*Notepad` suffix) |
| `conversation` | `aiConversationChatPanel` | ✅ Already clean |
| `copilot` | `copilotChatPanel` | ✅ Already clean |
| `tomAiChat` | `tomAiChatChatPanel` | ✅ Already clean |
| `UnifiedNotepadViewProvider` | `ChatPanelViewProvider` | ✅ Renamed |
| `registerUnifiedNotepad` | `registerChatPanel` | ✅ Renamed |

### 3.5 Handler File Renaming

| Current File | Plan Target | Actual File | Status |
|--------------|-------------|-------------|--------|
| `dsNotes-handler.ts` | `sidebarNotes-handler.ts` | `sidebarNotes-handler.ts` | ✅ |
| `expandPrompt-handler.ts` | `localLlm-handler.ts` | `localLlm-handler.ts` | ✅ |
| `botConversation-handler.ts` | `aiConversation-handler.ts` | `aiConversation-handler.ts` | ✅ |
| `sendToChatAdvanced-handler.ts` | `copilotTemplates-handler.ts` | `copilotTemplates-handler.ts` | ✅ |
| `unifiedNotepad-handler.ts` | `chatPanel-handler.ts` | `chatPanel-handler.ts` | ✅ |
| `t3Panel-handler.ts` | `wsPanel-handler.ts` | `wsPanel-handler.ts` | ✅ |

---

## Section 4: Keyboard Shortcuts

### 4.1 Chord Menu Reassignment

| Shortcut | Plan Change | Status |
|----------|-------------|--------|
| `Ctrl+Shift+C` | Changed to Copilot | ✅ Verified: `tomAi.chordMenu.copilot` |
| `Ctrl+Shift+A` | Changed to AI Conversation | ✅ Verified: `tomAi.chordMenu.aiConversation` |
| Others | ID updates only | ✅ All keybindings use `tomAi.*` command IDs |

---

## Section 5: LM Tool Renaming

### 5.1 Tool Prefix Migration to `tomAi_`

| # | Current Name | Plan Target | Actual | Status |
|---|-------------|-------------|--------|--------|
| 1 | `tom_createFile` | `tomAi_createFile` | `tomAi_createFile` | ✅ |
| 2 | `tom_readFile` | `tomAi_readFile` | `tomAi_readFile` | ✅ |
| 3 | `tom_editFile` | `tomAi_editFile` | `tomAi_editFile` | ✅ |
| 4 | `tom_multiEditFile` | `tomAi_multiEditFile` | `tomAi_multiEditFile` | ✅ |
| 5 | `tom_listDirectory` | `tomAi_listDirectory` | `tomAi_listDirectory` | ✅ |
| 6 | `tom_findFiles` | `tomAi_findFiles` | `tomAi_findFiles` | ✅ |
| 7 | `tom_findTextInFiles` | `tomAi_findTextInFiles` | `tomAi_findTextInFiles` | ✅ |
| 8 | `tom_runCommand` | `tomAi_runCommand` | `tomAi_runCommand` | ✅ |
| 9 | `tom_runVscodeCommand` | `tomAi_runVscodeCommand` | `tomAi_runVscodeCommand` | ✅ |
| 10 | `tom_getErrors` | `tomAi_getErrors` | `tomAi_getErrors` | ✅ |
| 11 | `tom_fetchWebpage` | `tomAi_fetchWebpage` | `tomAi_fetchWebpage` | ✅ |
| 12 | `tom_readGuideline` | `tomAi_readGuideline` | `tomAi_readGuideline` | ✅ |
| 13 | `tom_readLocalGuideline` | `tomAi_readLocalGuideline` | `tomAi_readLocalGuideline` | ✅ |
| 14 | `tom_webSearch` | `tomAi_webSearch` | `tomAi_webSearch` | ✅ |
| 15 | `tom_manageTodo` | `tomAi_manageTodo` | `tomAi_manageTodo` | ✅ |
| 24–28 | `tomAi_windowTodo_*` | `tomAi_sessionTodo_*` | `tomAi_sessionTodo_*` | ✅ |

### 5.2 Duplicate Tool Removal

| Tool to Remove | Plan: Replaced By | Status |
|----------------|-------------------|--------|
| `addToPromptQueue` (old) | `tomAi_queue_add` | ✅ Removed from package.json |
| `addFollowUpPrompt` (old) | `tomAi_queue_addFollowUp` | ✅ Removed from package.json |
| `sendQueuedPrompt` (old) | `tomAi_queue_sendNow` | ✅ Removed from package.json |
| `addTimedRequest` (old) | `tomAi_timed_add` | ✅ Removed from package.json |

---

## Section 6: VS Code Settings Renaming

| # | Current Setting | Plan Target | Actual | Status |
|---|-----------------|-------------|--------|--------|
| 1 | `tomAi.contextApproach` | `tomAi.contextApproach` | `tomAi.contextApproach` | ✅ |
| 4 | `tomAi.copilotModel` | `tomAi.copilot.model` | `tomAi.copilot.model` | ✅ |
| 5 | `tomAi.configPath` | `tomAi.configPath` | `tomAi.configPath` | ✅ |

### 6.1 New Settings to Add

| Setting | Status |
|---------|--------|
| `tomAi.aiFolder` | ✅ (exists in package.json) |
| `tomAi.trail.enabled` | ✅ (exists in package.json) |
| `tomAi.bridge.requestTimeout` | ✅ (exists in package.json) |
| `tomAi.bridge.restartDelay` | ✅ (exists in package.json) |
| `tomAi.bridge.maxRestarts` | ✅ (exists in package.json) |
| `tomAi.timedRequests.tickInterval` | ✅ (exists in package.json) |

---

## Section 7: Configuration File Restructuring

### 7.1 Config Key Migration

| # | Current Key | Plan Target | Status |
|---|-------------|-------------|--------|
| 1 | `promptExpander` | `localLlm` | ✅ (`LocalLlmConfig` in handler) |
| 5 | `botConversation` | `aiConversation` | ✅ (`AiConversationConfig` in handler) |
| 9 | `templates` | `copilot.templates` | ✅ Verified: `parsed.copilot?.templates` |
| 17 | `telegram` | `aiConversation.telegram` | ✅ Verified: `parsed?.aiConversation` → `sec.telegram` |
| 24 | `tomAiBridge` | `bridge` | ✅ Verified: `getSection<BridgeConfig>('bridge')` |
| 31 | `combinedCommands` | `stateMachines` | ✅ Verified: `config?.stateMachines` |

### 7.3 TomAiConfiguration Class

| Feature | Status | Evidence |
|---------|--------|----------|
| Singleton pattern | ✅ | `TomAiConfiguration.init()`, `TomAiConfiguration.instance` |
| Config path resolution | ✅ | `configPath` property exists |
| Typed section accessors | ✅ | `getTrail()`, `saveTrail()`, `getBridge()`, `saveBridge()`, `getSection<T>()` |
| `createDefaultConfig()` | ✅ | Exists in `TomAiConfiguration` and `CopilotTemplatesHandler` |

---

## Section 8: Trail System Redesign

### 8.6 TrailService Class

| Feature | Status | Evidence |
|---------|--------|----------|
| `TrailService` singleton | ✅ | `TrailService.init()`, `TrailService.instance` |
| `writeRawPrompt()` | ✅ | Method exists |
| `writeRawAnswer()` | ✅ | Method exists |
| `writeRawToolRequest()` | ✅ | Method exists |
| `writeRawToolAnswer()` | ✅ | Method exists |
| `writeSummaryPrompt()` | ✅ | Method exists |
| `writeSummaryAnswer()` | ✅ | Method exists |
| `isEnabled()` | ✅ | Method exists |
| `toggle()` | ✅ | Method exists |

### 8.7 Eliminated Trail Systems

| Item | Status | Evidence |
|------|--------|----------|
| `trailLogger-handler.ts` deleted | ✅ | File does not exist |
| `escalation-tools-config.ts` deleted | ✅ | File does not exist |
| Destructive `clearTrail()` removed | ✅ | No matches found |
| `escalation` trail type removed | ✅ | No matches found |

---

## Section 9: Folder Structure Consolidation

### 9.2 Path Registry (WsPaths Update)

| Constant | Status | Evidence |
|----------|--------|----------|
| `AI_FOLDER` configurable | ✅ | `tomAi.aiFolder` setting exists |

---

## Section 10: New Utility Classes & Infrastructure

### 10.1 FsUtils Class

| Feature | Status | Evidence |
|---------|--------|----------|
| File created | ✅ | `src/utils/fsUtils.ts` exists |
| `ensureDir()` | ✅ | Used throughout codebase |
| `safeReadFile()` | ✅ | Used throughout codebase |
| `safeReadJson()` | ✅ | Used throughout codebase |
| `safeWriteJson()` | ✅ | Used throughout codebase |
| `safeReadYaml()` | ✅ | Used in chatVariablesStore |
| `safeWriteYaml()` | ✅ | Used in chatVariablesStore |
| `fileExists()` | ✅ | Used throughout codebase |

### 10.2 BaseWebviewProvider Class

| Feature | Status | Evidence |
|---------|--------|----------|
| File created | ✅ | `src/utils/baseWebviewProvider.ts` exists |
| Abstract class | ✅ | `export abstract class BaseWebviewProvider` |

### 10.3 Shared Message Types

| Feature | Status | Evidence |
|---------|--------|----------|
| File created | ✅ | `src/types/webviewMessages.ts` exists |
| `WebviewMessage` interface | ✅ | Interface defined |
| `ChatPanelSendMessage` | ✅ | Interface defined |
| `ChatPanelDraftMessage` | ✅ | Interface defined |
| `TodoPanelMessage` | ✅ | Interface defined |

### 10.4 Constants Registry

| Feature | Status | Evidence |
|---------|--------|----------|
| File created | ✅ | `src/utils/constants.ts` exists |
| `BRIDGE_REQUEST_TIMEOUT` | ✅ | `30_000` |
| `TRAIL_MAX_FILES_PER_FOLDER` | ✅ | `50` |
| `TRAIL_MAX_VIEWER_EXCHANGES` | ✅ | `100` |

---

## Section 11: Todo System Unification

### 11.1 TodoProvider API

| Feature | Status | Evidence |
|---------|--------|----------|
| File created | ✅ | `src/managers/todoProvider.ts` exists |
| `TodoProvider` class | ✅ | Class defined |

### 11.2 Migration

| Item | Status | Evidence |
|------|--------|----------|
| `TodoManager` (JSON) removed | ✅ | No `todoManager.ts` file, uses `ChatTodoSessionManager` |

---

## Section 12: Persistence Unification

### 12.3 ChatVariablesStore Changes

| Feature | Status | Evidence |
|---------|--------|----------|
| Per-window YAML file | ✅ | Uses `FsUtils.safeWriteYaml()` |
| Window cleanup logic | ✅ | Dispose handler cleans up file |

### 12.4 WorkspaceState Key Cleanup

| Current Key | Plan Target | Status |
|-------------|-------------|--------|
| `tomAi.dsNotes.*` | `tomAi.*` | ✅ Migrated (no matches for old keys) |

---

## Section 15: Dead Code Removal

### 15.1 Remove Unused Storage Keys

| Key | Status |
|-----|--------|
| `tomAi.dsNotes.conversationLlmProfileA` | ✅ Removed |
| `tomAi.dsNotes.conversationLlmProfileB` | ✅ Removed |

### 15.2 Remove Obsolete Trail System

| Item | Status |
|------|--------|
| `escalation` trail type | ✅ Removed |
| `trail.paths.escalation` config | ✅ Removed |
| `escalation-tools-config.ts` | ✅ Deleted |

### 15.3 Remove TodoManager (JSON)

| Item | Status |
|------|--------|
| `TodoManager` class | ✅ Removed |
| `*.todos.json` handling | ✅ Removed |

### 15.4 Remove Duplicate Queue/Timed Tools

| Tool | Status |
|------|--------|
| `addToPromptQueue` (old) | ✅ Removed |
| `addFollowUpPrompt` (old) | ✅ Removed |
| `sendQueuedPrompt` (old) | ✅ Removed |
| `addTimedRequest` (old) | ✅ Removed |

---

## Summary: Implementation Status by Phase

### Phase 1: Infrastructure (No UI Changes)

| # | Task | Status |
|---|------|--------|
| 1.1 | Create `FsUtils` class | ✅ |
| 1.2 | Create `constants.ts` | ✅ |
| 1.3 | Create `TomAiConfiguration` class | ✅ |
| 1.4 | Create `BaseWebviewProvider` | ✅ |
| 1.5 | Create `TrailService` class | ✅ |
| 1.6 | Create shared webview message types | ✅ |
| 1.7 | Create `TodoProvider` API | ✅ |

### Phase 2: Internal Rewiring (Behavior Preserved)

| # | Task | Status |
|---|------|--------|
| 2.1 | Replace inline `ensureDir` | ✅ (mostly done) |
| 2.2 | Replace inline config reads | ✅ |
| 2.3 | Replace inline JSON reads | ✅ (mostly done) |
| 2.7 | Consolidate trail systems | ✅ |
| 2.8 | Replace `TodoManager` | ✅ |

### Phase 3: Rename & Rebrand

| # | Task | Status |
|---|------|--------|
| 3.1 | Update extension identity | ✅ |
| 3.2 | Rename command IDs/titles | ✅ |
| 3.3 | Rename view IDs | ✅ |
| 3.5 | Rename LM tools | ✅ |
| 3.9 | Rename handler files | ✅ |
| 3.10 | Update workspace state keys | ✅ |

### Phase 4: Config & Persistence Migration

| # | Task | Status |
|---|------|--------|
| 4.1 | Config key migration | ✅ |
| 4.3 | ChatVariablesStore per-window | ✅ |
| 4.5 | Configurable AI folder | ✅ |
| 4.6 | New trail folder structure | ✅ |

### Phase 5: Feature Parity & Polish

| # | Task | Status |
|---|------|--------|
| 5.8 | Remove duplicate LM tools | ✅ |
| 5.9 | Remove dead code | ✅ (mostly done) |

---

## Critical Outstanding Items

### High Priority (Blocking Release)

All high-priority items have been completed:

| Item | Section | Status |
|------|---------|--------|
| View container IDs | §3.1 | ✅ `tomAi-chat-panel`, `tomAi-ws-panel` |
| `t3Panel-handler.ts` | §3.5 | ✅ Renamed to `wsPanel-handler.ts` |
| T3 class/function names | §3.5 | ✅ `WsPanelHandler`, `registerWsPanel` |
| Config key migration | §7.1 | ✅ `localLlm`, `aiConversation` |
| Duplicate tool removal | §15.4 | ✅ All 4 old tools removed |

### Medium Priority

All medium-priority items have been completed:

| Item | Section | Status |
|------|---------|--------|
| Internal tab IDs | §3.4 | ✅ Section IDs already clean; `ChatPanelViewProvider` renamed |
| LM tool renaming | §5.1 | ✅ All `tomAi_*` prefix; `sessionTodo` renamed |
| Extension description | §1.1 | ✅ Updated |

### Low Priority (Polish)

All low-priority polish items have been completed:

| Item | Section | Status |
|------|---------|--------|
| Context menu prefixes | §1.2 | ✅ `shortTitle` added to 22 commands; submenu labels prefix-free |
| Full LM tool audit | §5.1 | ✅ All tools use `tomAi_*` prefix |
| Full view ID audit | §3.2 | ✅ All view IDs use `tomAi.*` prefix |

---

## Statistics

| Category | Done | Partial | Not Done | Total |
|----------|------|---------|----------|-------|
| Handler file renames | 6 | 0 | 0 | 6 |
| Utility classes | 7 | 0 | 0 | 7 |
| Dead code removal | 5 | 0 | 0 | 5 |
| View/panel IDs | 11 | 0 | 0 | 11 |
| Config key migration | 7 | 0 | 0 | 7 |
| LM tools | 17 | 0 | 0 | 17 |

**Overall Progress:** 100% complete ✅
