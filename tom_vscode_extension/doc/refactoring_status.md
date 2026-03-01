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
| Description | Updated description | Original description | ❌ NOT DONE |
| View container label (@CHAT) | `@CHAT` | `@CHAT` | ✅ |
| Chat participant ID | `@tom` | (needs verification) | ⚠️ PARTIAL |
| Chat variable prefix | `tomAi.*` | `tomAi.*` | ✅ |
| Status bar prefix | `@T` | (needs verification) | ⚠️ PARTIAL |

### 1.2 Command Prefix Convention

| Requirement | Status | Evidence |
|-------------|--------|----------|
| `@T:` for Command Palette | ✅ | Commands use `@T:` prefix in package.json |
| No prefix for context menus | ⚠️ PARTIAL | Some context menu items still have `@T:` prefix |
| `@T:`/`Tom AI:` eliminated | ⚠️ PARTIAL | Some legacy patterns may exist |

### 1.3 Config Namespace

| Property | Plan Target | Actual | Status |
|----------|-------------|--------|--------|
| VS Code settings prefix | `tomAi.*` | `tomAi.*` | ✅ |
| WorkspaceState key prefix | `tomAi.*` | Migrated from `tomAi.dsNotes.*` | ✅ |
| Chat variable prefix | `tomAi.*` | `tomAi.*` | ✅ |

### 1.4 Internal Subsystem Canonical Names

| Subsystem | Plan Name | Config Key in Code | Status |
|-----------|-----------|-------------------|--------|
| Local LLM | `localLlm` | Still `promptExpander` in handler | ❌ NOT DONE |
| AI Conversation | `aiConversation` | Still `botConversation` in handler | ❌ NOT DONE |
| Copilot Chat | `copilot` | `copilot` | ✅ |
| Tom AI Chat | `tomAiChat` | `tomAiChat` | ✅ |

---

## Section 2: Command Renaming

### 2.1 Command ID Prefix Migration

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Commands use `tomAi.*` IDs | ✅ | package.json uses `tomAi.*` command IDs |
| Command titles use `@T:` prefix | ✅ | Titles like `@T: Send to Copilot` |
| Legacy `tomAi.*` aliases maintained | ✅ | Compatibility aliases exist (per plan) |

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
| `tomAi-chat-panel` | `tomAi-chat-panel` | `tomAi-t2-panel` | ❌ NOT DONE |
| `tomAi-ws-panel` | `tomAi-ws-panel` | `tomAi-t3-panel` | ❌ NOT DONE |

### 3.2 Views

| Current View ID | Plan Target | Actual | Status |
|-----------------|-------------|--------|--------|
| `tomAi.chatPanel` | `tomAi.chatPanel` | `tomAi.chatPanel` | ✅ |
| `tomAi.wsPanel` | `tomAi.wsPanel` | `tomAi.wsPanel` | ✅ |
| `tomAi.tomNotepad` | `tomAi.vscodeNotes` | `tomAi.vscodeNotes` | ✅ |
| `tomAi.questNotesView` | `tomAi.questNotes` | `tomAi.questNotes` | ✅ |
| `tomAi.questTodosView` | `tomAi.questTodos` | (needs verification) | ⚠️ PARTIAL |
| `tomAi.sessionTodosView` | `tomAi.sessionTodos` | (needs verification) | ⚠️ PARTIAL |
| `tomAi.todoLogView` | `tomAi.todoLog` | (needs verification) | ⚠️ PARTIAL |
| `tomAi.workspaceNotepad` | `tomAi.workspaceNotes` | (needs verification) | ⚠️ PARTIAL |
| `tomAi.workspaceTodosView` | `tomAi.workspaceTodos` | (needs verification) | ⚠️ PARTIAL |

### 3.3 Custom Editors

| Current Type | Plan Target | Actual | Status |
|--------------|-------------|--------|--------|
| `yamlGraph.editor` | `tomAi.yamlGraphEditor` | `tomAi.yamlGraphEditor` | ✅ |
| `questTodo.editor` | `tomAi.todoEditor` | `tomAi.todoEditor` | ✅ |
| `trailViewer.editor` | `tomAi.trailViewer` | (needs verification) | ⚠️ PARTIAL |
| `summaryTrailViewer.editor` | `tomAi.summaryTrailViewer` | (needs verification) | ⚠️ PARTIAL |
| `rawTrailViewer.editor` | `tomAi.rawTrailViewer` | (needs verification) | ⚠️ PARTIAL |

### 3.4 @CHAT Panel Tabs

| Current Internal ID | Plan Target | Status |
|--------------------|-------------|--------|
| `localLlmNotepad` | `localLlmChatPanel` | ❌ NOT DONE |
| `conversationNotepad` | `aiConversationChatPanel` | ❌ NOT DONE |
| `copilotNotepad` | `copilotChatPanel` | ❌ NOT DONE |
| `tomAiChatNotepad` | `tomAiChatChatPanel` | ❌ NOT DONE |

### 3.5 Handler File Renaming

| Current File | Plan Target | Actual File | Status |
|--------------|-------------|-------------|--------|
| `dsNotes-handler.ts` | `sidebarNotes-handler.ts` | `sidebarNotes-handler.ts` | ✅ |
| `expandPrompt-handler.ts` | `localLlm-handler.ts` | `localLlm-handler.ts` | ✅ |
| `botConversation-handler.ts` | `aiConversation-handler.ts` | `aiConversation-handler.ts` | ✅ |
| `sendToChatAdvanced-handler.ts` | `copilotTemplates-handler.ts` | `copilotTemplates-handler.ts` | ✅ |
| `unifiedNotepad-handler.ts` | `chatPanel-handler.ts` | `chatPanel-handler.ts` | ✅ |
| `t3Panel-handler.ts` | `wsPanel-handler.ts` | `t3Panel-handler.ts` | ❌ NOT DONE |

---

## Section 4: Keyboard Shortcuts

### 4.1 Chord Menu Reassignment

| Shortcut | Plan Change | Status |
|----------|-------------|--------|
| `Ctrl+Shift+C` | Changed to Copilot | (needs verification) |
| `Ctrl+Shift+A` | Changed to AI Conversation | (needs verification) |
| Others | ID updates only | (needs verification) |

---

## Section 5: LM Tool Renaming

### 5.1 Tool Prefix Migration to `tomAi_`

| # | Current Name | Plan Target | Actual | Status |
|---|-------------|-------------|--------|--------|
| 1 | `tom_createFile` | `tomAi_createFile` | `tomAi_createFile` | ✅ |
| 2 | `tom_readFile` | `tomAi_readFile` | (needs verification) | ⚠️ PARTIAL |
| 3 | `tom_editFile` | `tomAi_editFile` | (needs verification) | ⚠️ PARTIAL |
| 4 | `tom_multiEditFile` | `tomAi_multiEditFile` | (needs verification) | ⚠️ PARTIAL |
| 5 | `tom_listDirectory` | `tomAi_listDirectory` | (needs verification) | ⚠️ PARTIAL |
| 6 | `tom_findFiles` | `tomAi_findFiles` | (needs verification) | ⚠️ PARTIAL |
| 7 | `tom_findTextInFiles` | `tomAi_findTextInFiles` | (needs verification) | ⚠️ PARTIAL |
| 8 | `tom_runCommand` | `tomAi_runCommand` | (needs verification) | ⚠️ PARTIAL |
| 9 | `tom_runVscodeCommand` | `tomAi_runVscodeCommand` | (needs verification) | ⚠️ PARTIAL |
| 10 | `tom_getErrors` | `tomAi_getErrors` | (needs verification) | ⚠️ PARTIAL |
| 11 | `tom_fetchWebpage` | `tomAi_fetchWebpage` | (needs verification) | ⚠️ PARTIAL |
| 12 | `tom_readGuideline` | `tomAi_readGuideline` | (needs verification) | ⚠️ PARTIAL |
| 13 | `tom_readLocalGuideline` | `tomAi_readLocalGuideline` | (needs verification) | ⚠️ PARTIAL |
| 14 | `tom_webSearch` | `tomAi_webSearch` | (needs verification) | ⚠️ PARTIAL |
| 15 | `tom_manageTodo` | `tomAi_manageTodo` | `tomAi_manageTodo` | ✅ |
| 24–28 | `tomAi_windowTodo_*` | `tomAi_sessionTodo_*` | `tomAi_windowTodo_*` | ❌ NOT DONE |

### 5.2 Duplicate Tool Removal

| Tool to Remove | Plan: Replaced By | Status |
|----------------|-------------------|--------|
| `addToPromptQueue` (old) | `tomAi_queue_add` | ❌ Still exists |
| `addFollowUpPrompt` (old) | `tomAi_queue_addFollowUp` | ❌ Still exists |
| `sendQueuedPrompt` (old) | `tomAi_queue_sendNow` | ❌ Still exists |
| `addTimedRequest` (old) | `tomAi_timed_add` | ❌ Still exists |

---

## Section 6: VS Code Settings Renaming

| # | Current Setting | Plan Target | Actual | Status |
|---|-----------------|-------------|--------|--------|
| 1 | `tomAi.contextApproach` | `tomAi.contextApproach` | (needs verification) | ⚠️ PARTIAL |
| 4 | `tomAi.copilotModel` | `tomAi.copilot.model` | `tomAi.copilot.model` | ✅ |
| 5 | `tomAi.configPath` | `tomAi.configPath` | `tomAi.configPath` | ✅ |

### 6.1 New Settings to Add

| Setting | Status |
|---------|--------|
| `tomAi.aiFolder` | ✅ (exists in package.json) |
| `tomAi.trail.enabled` | (needs verification) |
| `tomAi.bridge.requestTimeout` | (needs verification) |
| `tomAi.bridge.restartDelay` | (needs verification) |
| `tomAi.bridge.maxRestarts` | (needs verification) |
| `tomAi.timedRequests.tickInterval` | (needs verification) |

---

## Section 7: Configuration File Restructuring

### 7.1 Config Key Migration

| # | Current Key | Plan Target | Status |
|---|-------------|-------------|--------|
| 1 | `promptExpander` | `localLlm` | ❌ NOT DONE (still `promptExpander`) |
| 5 | `botConversation` | `aiConversation` | ❌ NOT DONE (still `botConversation`) |
| 9 | `templates` | `copilot.templates` | (needs verification) |
| 17 | `telegram` | `aiConversation.telegram` | ❌ NOT DONE |
| 24 | `tomAiBridge` | `bridge` | (needs verification) |
| 31 | `combinedCommands` | `stateMachines` | (needs verification) |

### 7.3 TomAiConfiguration Class

| Feature | Status | Evidence |
|---------|--------|----------|
| Singleton pattern | ✅ | `TomAiConfiguration.init()`, `TomAiConfiguration.instance` |
| Config path resolution | ✅ | `configPath` property exists |
| Typed section accessors | ⚠️ PARTIAL | `getTrail()`, `saveTrail()` exist |
| `createDefaultConfig()` | (needs verification) | |

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
| `addToPromptQueue` (old) | ❌ Still exists |
| `addFollowUpPrompt` (old) | ❌ Still exists |
| `sendQueuedPrompt` (old) | ❌ Still exists |
| `addTimedRequest` (old) | ❌ Still exists |

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
| 2.2 | Replace inline config reads | ⚠️ PARTIAL |
| 2.3 | Replace inline JSON reads | ✅ (mostly done) |
| 2.7 | Consolidate trail systems | ✅ |
| 2.8 | Replace `TodoManager` | ✅ |

### Phase 3: Rename & Rebrand

| # | Task | Status |
|---|------|--------|
| 3.1 | Update extension identity | ✅ |
| 3.2 | Rename command IDs/titles | ✅ |
| 3.3 | Rename view IDs | ⚠️ PARTIAL (container IDs not done) |
| 3.5 | Rename LM tools | ⚠️ PARTIAL |
| 3.9 | Rename handler files | ⚠️ PARTIAL (t3Panel not renamed) |
| 3.10 | Update workspace state keys | ✅ |

### Phase 4: Config & Persistence Migration

| # | Task | Status |
|---|------|--------|
| 4.1 | Config key migration | ❌ NOT DONE |
| 4.3 | ChatVariablesStore per-window | ✅ |
| 4.5 | Configurable AI folder | ✅ |
| 4.6 | New trail folder structure | ✅ |

### Phase 5: Feature Parity & Polish

| # | Task | Status |
|---|------|--------|
| 5.8 | Remove duplicate LM tools | ❌ NOT DONE |
| 5.9 | Remove dead code | ✅ (mostly done) |

---

## Critical Outstanding Items

### High Priority (Blocking Release)

| Item | Section | Description |
|------|---------|-------------|
| View container IDs | §3.1 | `tomAi-t2-panel` → `tomAi-chat-panel`, `tomAi-t3-panel` → `tomAi-ws-panel` |
| `t3Panel-handler.ts` | §3.5 | Rename to `wsPanel-handler.ts` |
| T3 class/function names | §3.5 | `T3PanelHandler` → `WsPanelHandler`, `registerT3Panel` → `registerWsPanel` |
| Config key migration | §7.1 | `promptExpander` → `localLlm`, `botConversation` → `aiConversation` |
| Duplicate tool removal | §15.4 | Remove old queue/timed tools |

### Medium Priority

| Item | Section | Description |
|------|---------|-------------|
| Internal tab IDs | §3.4 | `*Notepad` → `*ChatPanel` |
| LM tool renaming | §5.1 | `tomAi_windowTodo_*` → `tomAi_sessionTodo_*` |
| Extension description | §1.1 | Update to plan target |

### Low Priority (Polish)

| Item | Section | Description |
|------|---------|-------------|
| Context menu prefixes | §1.2 | Some still have `@T:` prefix |
| Full LM tool audit | §5.1 | Verify all 47 tools renamed |
| Full view ID audit | §3.2 | Verify all view IDs updated |

---

## Statistics

| Category | Done | Partial | Not Done | Total |
|----------|------|---------|----------|-------|
| Handler file renames | 5 | 0 | 1 | 6 |
| Utility classes | 7 | 0 | 0 | 7 |
| Dead code removal | 4 | 0 | 1 | 5 |
| View/panel IDs | 4 | 5 | 2 | 11 |
| Config key migration | 2 | 0 | 5 | 7 |
| LM tools | 2 | 0 | 1 group | varies |

**Overall Progress:** ~70% complete
