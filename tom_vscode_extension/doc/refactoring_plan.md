# Tom AI Extension — Refactoring Implementation Plan

**Extension:** `tom-ai-extension` (renamed from `dartscript-vscode`)  
**Date:** 26 Feb 2026  
**Companion docs:** `extension_analysis.md`, `extension_discrepancies.md`

---

## Table of Contents

1. [Identity & Branding](#1-identity--branding)
2. [Command Renaming](#2-command-renaming)
3. [View & Panel Renaming](#3-view--panel-renaming)
4. [Keyboard Shortcuts](#4-keyboard-shortcuts)
5. [LM Tool Renaming](#5-lm-tool-renaming)
6. [VS Code Settings Renaming](#6-vs-code-settings-renaming)
7. [Configuration File Restructuring](#7-configuration-file-restructuring)
8. [Trail System Redesign](#8-trail-system-redesign)
9. [Folder Structure Consolidation](#9-folder-structure-consolidation)
10. [New Utility Classes & Infrastructure](#10-new-utility-classes--infrastructure)
11. [Todo System Unification](#11-todo-system-unification)
12. [Persistence Unification](#12-persistence-unification)
13. [Prompt Processing Unification](#13-prompt-processing-unification)
14. [Sidebar Notes Clarification](#14-sidebar-notes-clarification)
15. [Dead Code Removal](#15-dead-code-removal)
16. [Implementation Phases](#16-implementation-phases)

---

## 1. Identity & Branding

### 1.1 Extension Metadata

| Property | Current | After |
|----------|---------|-------|
| Extension ID (`name`) | `dartscript-vscode` | `tom-ai-extension` |
| Display name | `DartScript` | `@Tom` |
| Publisher | `tom` | `tom` |
| Description | "AI-powered build and documentation..." | "AI-powered workspace automation with Copilot, Local LLM, and AI Chat integration" |
| View container label (@CHAT) | `DartScript` | `@Tom` |
| Chat participant ID | `@dartscript` | `@tom` |
| Chat variable prefix | `dartscript.*` | `tomAi.*` |
| Status bar prefix | `DS` | `@T` |
| Context menu submenu labels | `DartScript: Send to Chat...` / `DartScript: Send to local LLM...` | (prefix-less, unchanged — these are context menu items) |

### 1.2 Command Prefix Convention

- **`@T:`** — All commands visible in the Command Palette
- **No prefix** — Context menu sub-menu entries (Send with Trail Reminder, Code Review, etc.) — these stay prefix-less
- **`DS:` / `DartScript:` / `Tom AI:`** — eliminated entirely

### 1.3 Config Namespace

| Property | Current | After |
|----------|---------|-------|
| VS Code settings prefix | `dartscript.*` | `tomAi.*` |
| WorkspaceState key prefix | `dartscript.dsNotes.*` | `tomAi.*` |
| Chat variable prefix | `dartscript.*` | `tomAi.*` |

### 1.4 Internal Subsystem Canonical Names

These canonical names will be used consistently across config keys, file names, view IDs, variable names, and handler names:

| Subsystem | Canonical Name | Config Key | View ID suffix | Variable prefix |
|-----------|---------------|------------|---------------|-----------------|
| Local LLM | `localLlm` | `localLlm` | `localLlmChatPanel` | `localLlm` |
| AI Conversation | `conversation` | `conversation` | `conversationChatPanel` | `conversation` |
| Copilot Chat | `copilot` | `copilot` | `copilotChatPanel` | `copilot` |
| Tom AI Chat | `tomAiChat` | `tomAiChat` | `tomAiChatChatPanel` | `tomAiChat` |

---

## 2. Command Renaming

### 2.1 Complete Command Mapping (78 commands)

#### Copilot Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 1 | `dartscript.sendToChat` | DS: Send to Copilot Chat | `tomAi.sendToCopilot` | @T: Send to Copilot |
| 2 | `dartscript.sendToChatAdvanced` | DS: Send to Copilot Chat (Template)... | `tomAi.sendToCopilot.template` | @T: Send to Copilot (Pick Template) |
| 3 | `dartscript.sendToChatStandard` | DS: Send to Copilot Chat (Standard) | `tomAi.sendToCopilot.standard` | @T: Send to Copilot (Default Template) |
| 4 | `dartscript.reloadSendToChatConfig` | DS: Reload Chat Config | `tomAi.reloadConfig` | @T: Reload Configuration |
| 5 | `dartscript.showChatAnswerValues` | DS: Show chat answer values | `tomAi.showAnswerValues` | @T: Show Chat Answer Values |
| 6 | `dartscript.clearChatAnswerValues` | DS: Clear chat answer values | `tomAi.clearAnswerValues` | @T: Clear Chat Answer Values |

#### Context Menu Items (prefix-less)

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 7 | `dartscript.sendToChatTrailReminder` | Send with Trail Reminder | `tomAi.sendToCopilot.trailReminder` | Send with Trail Reminder |
| 8 | `dartscript.sendToChatTodoExecution` | TODO Execution | `tomAi.sendToCopilot.todoExecution` | TODO Execution |
| 9 | `dartscript.sendToChatCodeReview` | Code Review | `tomAi.sendToCopilot.codeReview` | Code Review |
| 10 | `dartscript.sendToChatExplain` | Explain Code | `tomAi.sendToCopilot.explain` | Explain Code |
| 11 | `dartscript.sendToChatAddToTodo` | Add to Todo | `tomAi.sendToCopilot.addToTodo` | Add to Todo |
| 12 | `dartscript.sendToChatFixMarkdown` | Fix Markdown here | `tomAi.sendToCopilot.fixMarkdown` | Fix Markdown here |

#### Local LLM Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 13 | `dartscript.expandPrompt` | DS: Expand Prompt (Ollama) | `tomAi.sendToLocalLlm` | @T: Send to Local LLM |
| 14 | `dartscript.switchLocalModel` | DS: Change local Ollama model... | `tomAi.localLlm.switchModel` | @T: Change Local LLM Model... |
| 15 | `dartscript.sendToLocalLlm` | DS: Send to local LLM | `tomAi.sendToLocalLlm.default` | @T: Send to Local LLM (Default) |
| 16 | `dartscript.sendToLocalLlmAdvanced` | DS: Send to local LLM (Template)... | `tomAi.sendToLocalLlm.template` | @T: Send to Local LLM (Pick Template) |
| 17 | `dartscript.sendToLocalLlmStandard` | DS: Send to local LLM (Standard) | `tomAi.sendToLocalLlm.standard` | @T: Send to Local LLM (Default Template) |

#### Context Menu Items — Local LLM (prefix-less)

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 18 | `dartscript.sendToLocalLlm.expand` | Expand Prompt | `tomAi.sendToLocalLlm.expand` | Expand Prompt |
| 19 | `dartscript.sendToLocalLlm.rewrite` | Rewrite | `tomAi.sendToLocalLlm.rewrite` | Rewrite |
| 20 | `dartscript.sendToLocalLlm.detailed` | Detailed Expansion | `tomAi.sendToLocalLlm.detailed` | Detailed Expansion |
| 21 | `dartscript.sendToLocalLlm.annotated` | Annotated Expansion | `tomAi.sendToLocalLlm.annotated` | Annotated Expansion |

#### AI Conversation Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 22 | `dartscript.startBotConversation` | DS: Start Local-Copilot Conversation | `tomAi.conversation.start` | @T: Start AI Conversation |
| 23 | `dartscript.stopBotConversation` | DS: Stop Local-Copilot Conversation | `tomAi.conversation.stop` | @T: Stop AI Conversation |
| 24 | `dartscript.haltBotConversation` | DS: Halt Local-Copilot Conversation | `tomAi.conversation.halt` | @T: Halt AI Conversation |
| 25 | `dartscript.continueBotConversation` | DS: Continue Local-Copilot Conversation | `tomAi.conversation.continue` | @T: Continue AI Conversation |
| 26 | `dartscript.addToBotConversation` | DS: Add to Local-Copilot Conversation | `tomAi.conversation.add` | @T: Add to AI Conversation |

#### Tom AI Chat Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 27 | `dartscript.startTomAIChat` | Tom AI: Start Chat | `tomAi.tomAiChat.start` | @T: Start Tom AI Chat |
| 28 | `dartscript.sendToTomAIChat` | Tom AI: Send Chat Prompt | `tomAi.tomAiChat.send` | @T: Send Tom AI Chat Prompt |
| 29 | `dartscript.interruptTomAIChat` | Tom AI: Interrupt Chat | `tomAi.tomAiChat.interrupt` | @T: Interrupt Tom AI Chat |

#### Bridge & Infrastructure Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 30 | `dartscript.executeFile` | DS: Execute File | `tomAi.executeFile` | @T: Execute File |
| 31 | `dartscript.executeScript` | DS: Execute as Script | `tomAi.executeScript` | @T: Execute as Script |
| 32 | `dartscript.restartBridge` | DS: Restart Bridge | `tomAi.bridge.restart` | @T: Restart Bridge |
| 33 | `dartscript.switchBridgeProfile` | DS: Switch Dartscript Bridge Profile... | `tomAi.bridge.switchProfile` | @T: Switch Bridge Profile... |
| 34 | `dartscript.toggleBridgeDebugLogging` | DS: Toggle Bridge Debug Logging | `tomAi.bridge.toggleDebug` | @T: Toggle Bridge Debug Logging |
| 35 | `dartscript.reloadWindow` | DS: Reload Window | `tomAi.reloadWindow` | @T: Reload Window |
| 36 | `dartscript.runTests` | DS: Run Tests | `tomAi.runTests` | @T: Run Tests |

#### CLI Server Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 37 | `dartscript.startCliServer` | DS: Start Tom CLI Integration Server | `tomAi.cliServer.start` | @T: Start Tom CLI Integration Server |
| 38 | `dartscript.startCliServerCustomPort` | DS: Start Tom CLI Integration Server (Custom Port) | `tomAi.cliServer.startCustomPort` | @T: Start CLI Server (Custom Port) |
| 39 | `dartscript.stopCliServer` | DS: Stop Tom CLI Integration Server | `tomAi.cliServer.stop` | @T: Stop Tom CLI Integration Server |
| 40 | `dartscript.startProcessMonitor` | DS: Start Tom Process Monitor | `tomAi.startProcessMonitor` | @T: Start Process Monitor |

#### Chord Menu Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 41 | `dartscript.chordMenu.conversation` | DS: Conversation Shortcuts... | `tomAi.chordMenu.conversation` | @T: AI Conversation Shortcuts... |
| 42 | `dartscript.chordMenu.llm` | DS: Local LLM Shortcuts... | `tomAi.chordMenu.localLlm` | @T: Local LLM Shortcuts... |
| 43 | `dartscript.chordMenu.chat` | DS: Send to Chat Shortcuts... | `tomAi.chordMenu.copilot` | @T: Copilot Shortcuts... |
| 44 | `dartscript.chordMenu.tomAiChat` | DS: Tom AI Chat Shortcuts... | `tomAi.chordMenu.tomAiChat` | @T: Tom AI Chat Shortcuts... |
| 45 | `dartscript.chordMenu.execute` | DS: Execute Shortcuts... | `tomAi.chordMenu.execute` | @T: Execute Shortcuts... |
| 46 | `dartscript.chordMenu.favorites` | DS: Favorites... | `tomAi.chordMenu.favorites` | @T: Favorites... |

#### Layout & UI Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 47 | `dartscript.combined.maximizeExplorer` | DS: Maximize Explorer | `tomAi.layout.maximizeExplorer` | @T: Maximize Explorer |
| 48 | `dartscript.combined.maximizeEditor` | DS: Maximize Editor | `tomAi.layout.maximizeEditor` | @T: Maximize Editor |
| 49 | `dartscript.combined.maximizeChat` | DS: Maximize Chat | `tomAi.layout.maximizeChat` | @T: Maximize @CHAT |
| 50 | `dartscript.combined.maximizeToggle` | DS: Maximize Toggle | `tomAi.layout.maximizeToggle` | @T: Maximize Toggle |
| 51 | `dartscript.stateMachine.vsWindowStateFlow` | DS: Window Panel State Flow | `tomAi.layout.windowStateFlow` | @T: Window Panel State Flow |
| 52 | `dartscript.resetMultiCommandState` | DS: Reset All State Machine States | `tomAi.layout.resetStateMachines` | @T: Reset All State Machine States |
| 53 | `dartscript.focusTomAI` | DS: Focus Tom AI Panel | `tomAi.focusChatPanel` | @T: Focus @CHAT Panel |
| 54 | `dartscript.combined.showSideNotes` | DS: Show Side Notes | `tomAi.showSidebarNotes` | @T: Show Sidebar Notes |

#### Editors & Viewers

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 55 | `dartscript.openChatVariablesEditor` | DS: Open Chat Variables Editor | `tomAi.editor.chatVariables` | @T: Open Chat Variables Editor |
| 56 | `dartscript.openQueueEditor` | DS: Open Prompt Queue Editor | `tomAi.editor.promptQueue` | @T: Open Prompt Queue Editor |
| 57 | `dartscript.openTimedRequestsEditor` | DS: Open Timed Requests Editor | `tomAi.editor.timedRequests` | @T: Open Timed Requests Editor |
| 58 | `dartscript.openContextSettingsEditor` | DS: Open Context & Settings Editor | `tomAi.editor.contextSettings` | @T: Open Context & Settings Editor |
| 59 | `dartscript.openGlobalTemplateEditor` | DS: Open Prompt Template Editor | `tomAi.editor.promptTemplates` | @T: Open Prompt Template Editor |
| 60 | `dartscript.openReusablePromptEditor` | DS: Open Reusable Prompt Editor | `tomAi.editor.reusablePrompts` | @T: Open Reusable Prompt Editor |
| 61 | `dartscript.openTrailViewer` | DS: Open Prompt Trail Viewer | `tomAi.editor.rawTrailViewer` | @T: Open Raw Trail Viewer |
| 62 | `dartscript.openTrailViewerFolder` | DS: Open Trail Viewer (Select Folder) | `tomAi.editor.summaryTrailViewer` | @T: Open Summary Trail Viewer |

#### Misc Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 63 | `dartscript.printConfiguration` | DartScript: Print Configuration | `tomAi.printConfiguration` | @T: Print Configuration |
| 64 | `dartscript.showApiInfo` | DartScript: Show VS Code API Info | `tomAi.showApiInfo` | @T: Show VS Code API Info |
| 65 | `dartscript.showHelp` | DS: Show Extension Help | `tomAi.showHelp` | @T: Show Extension Help |
| 66 | `dartscript.showQuickReference` | DS: Show Quick Reference | `tomAi.showQuickReference` | @T: Show Quick Reference |
| 67 | `dartscript.openConfig` | DS: Open Config File | `tomAi.openConfig` | @T: Open Config File |
| 68 | `dartscript.showStatusPage` | DS: Extension Status Page | `tomAi.statusPage` | @T: Extension Status Page |
| 69 | `dartscript.openExtensionSettings` | DS: Open Extension Settings | `tomAi.openSettings` | @T: Open Extension Settings |
| 70 | `dartscript.toggleTrail` | DS: Toggle AI Trail Logging | `tomAi.trail.toggle` | @T: Toggle Trail Logging |

#### Commandline Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 71 | `dartscript.defineCommandline` | DS: Add Commandline | `tomAi.commandline.add` | @T: Add Commandline |
| 72 | `dartscript.deleteCommandline` | DS: Delete Commandline | `tomAi.commandline.delete` | @T: Delete Commandline |
| 73 | `dartscript.executeCommandline` | DS: Execute Commandline | `tomAi.commandline.execute` | @T: Execute Commandline |

#### Telegram Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 74 | `dartscript.telegramTest` | DS: Telegram Test Connection | `tomAi.telegram.testConnection` | @T: Telegram Test Connection |
| 75 | `dartscript.telegramToggle` | DS: Telegram Start/Stop Polling | `tomAi.telegram.toggle` | @T: Telegram Toggle Polling |
| 76 | `dartscript.telegramConfigure` | DS: Configure Telegram... | `tomAi.telegram.configure` | @T: Configure Telegram... |

#### External App Commands

| # | Current ID | Current Title | New ID | New Title |
|---|-----------|---------------|--------|-----------|
| 77 | `dartscript.openInExternalApp` | DS: Open in External Application | `tomAi.openInExternalApp` | @T: Open in External Application |
| 78 | `dartscript.openInMdViewer` | DS: Open in MD Viewer | `tomAi.openInMdViewer` | @T: Open in MD Viewer |

### 2.2 Submenu Renaming

| Current ID | Current Label | New ID | New Label |
|-----------|---------------|--------|-----------|
| `dartscript.sendToChatSubmenu` | DartScript: Send to Chat... | `tomAi.sendToCopilotSubmenu` | Send to Copilot... |
| `dartscript.sendToLocalLlmSubmenu` | DartScript: Send to local LLM... | `tomAi.sendToLocalLlmSubmenu` | Send to Local LLM... |

---

## 3. View & Panel Renaming

### 3.1 View Containers

| Current ID | Current Title | New ID | New Title |
|-----------|---------------|--------|-----------|
| `dartscript-t2-panel` | @CHAT | `tomAi-chat-panel` | @CHAT |
| `dartscript-t3-panel` | @WS | `tomAi-ws-panel` | @WS |

### 3.2 Views

| Current View ID | Current Name | New View ID | New Name | Notes |
|----------------|-------------|-------------|----------|-------|
| `dartscript.chatPanel` | @CHAT | `tomAi.chatPanel` | @CHAT | Main bottom panel |
| `dartscript.wsPanel` | @WS | `tomAi.wsPanel` | @WS | Workspace panel |
| `dartscript.tomNotepad` | VS CODE NOTES | `tomAi.vscodeNotes` | VS CODE NOTES | Sidebar explorer |
| `dartscript.questNotesView` | QUEST NOTES | `tomAi.questNotes` | QUEST NOTES | Sidebar explorer |
| `dartscript.questTodosView` | QUEST TODOS | `tomAi.questTodos` | QUEST TODOS | Sidebar explorer |
| `dartscript.sessionTodosView` | SESSION TODOS | `tomAi.sessionTodos` | SESSION TODOS | Sidebar explorer |
| `dartscript.todoLogView` | TODO LOG | `tomAi.todoLog` | TODO LOG | Sidebar explorer |
| `dartscript.workspaceNotepad` | WORKSPACE NOTES | `tomAi.workspaceNotes` | WORKSPACE NOTES | Sidebar explorer |
| `dartscript.workspaceTodosView` | WORKSPACE TODOS | `tomAi.workspaceTodos` | WORKSPACE TODOS | Sidebar explorer |

### 3.3 Custom Editors

| Current View Type | New View Type | Display Name | File Patterns |
|------------------|---------------|-------------|---------------|
| `yamlGraph.editor` | `tomAi.yamlGraphEditor` | YAML Graph Editor | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` |
| `questTodo.editor` | `tomAi.todoEditor` | Todo Editor | `*.todo.yaml` |
| `trailViewer.editor` | `tomAi.trailViewer` | Trail Viewer | `*.prompts.md`, `*.answers.md` |

### 3.4 @CHAT Panel Tabs (inside unified panel)

| Current Internal ID | Current Label | New Internal ID | New Label |
|--------------------|--------------|-----------------|-----------|
| `localLlmNotepad` | Local LLM | `localLlmChatPanel` | Local LLM |
| `conversationNotepad` | AI Conversation | `conversationChatPanel` | AI Conversation |
| `copilotNotepad` | Copilot | `copilotChatPanel` | Copilot |
| `tomAiChatNotepad` | Tom AI Chat | `tomAiChatChatPanel` | Tom AI Chat |

### 3.5 Handler File Renaming

| Current File | New File | Reason |
|-------------|----------|--------|
| `dsNotes-handler.ts` | `sidebarNotes-handler.ts` | Reflects sidebar notes purpose |
| `expandPrompt-handler.ts` | `localLlm-handler.ts` | Matches canonical subsystem name |
| `botConversation-handler.ts` | `conversation-handler.ts` | Matches canonical subsystem name |
| `sendToChatAdvanced-handler.ts` | `copilotTemplates-handler.ts` | Matches what it does |
| `unifiedNotepad-handler.ts` | `chatPanel-handler.ts` | Matches @CHAT panel |

---

## 4. Keyboard Shortcuts

### 4.1 Chord Menu Reassignment

| Shortcut | Current Command | Current Meaning | New Command | New Meaning |
|----------|----------------|-----------------|-------------|-------------|
| `Ctrl+Shift+C` | `chordMenu.conversation` | AI Conversation | `tomAi.chordMenu.copilot` | **Copilot** (C = Copilot) |
| `Ctrl+Shift+L` | `chordMenu.llm` | Local LLM | `tomAi.chordMenu.localLlm` | Local LLM (L = Local) |
| `Ctrl+Shift+T` | `chordMenu.tomAiChat` | Tom AI Chat | `tomAi.chordMenu.tomAiChat` | Tom AI Chat (T = Tom) |
| `Ctrl+Shift+A` | `chordMenu.chat` | Copilot/Send to Chat | `tomAi.chordMenu.conversation` | **AI Conversation** (A = AI) |
| `Ctrl+Shift+E` | `chordMenu.execute` | Execute | `tomAi.chordMenu.execute` | Execute (unchanged) |
| `Ctrl+Shift+X` | `chordMenu.favorites` | Favorites | `tomAi.chordMenu.favorites` | Favorites (unchanged) |

**Key change:** C and A are swapped — C now means Copilot, A now means AI Conversation.

### 4.2 Other Shortcuts (unchanged bindings, new command IDs)

| Shortcut | New Command ID | Purpose |
|----------|---------------|---------|
| `Ctrl+Shift+0` | `tomAi.focusChatPanel` | Focus @CHAT panel |
| `Ctrl+Shift+2` | `tomAi.layout.maximizeExplorer` | Maximize explorer |
| `Ctrl+Shift+3` | `tomAi.layout.maximizeEditor` | Maximize editor |
| `Ctrl+Shift+4` | `tomAi.layout.maximizeChat` | Maximize @CHAT |
| `Ctrl+Shift+8` | `tomAi.statusPage` | Status page |
| `Ctrl+Shift+9` | `tomAi.wsPanel.focus` | Focus @WS |
| `Ctrl+Shift+Y` | `tomAi.layout.windowStateFlow` | Window state flow |
| `Ctrl+Shift+N` | `tomAi.showSidebarNotes` | Show sidebar notes |
| `Ctrl+Shift+\`` | `tomAi.layout.maximizeToggle` | Maximize toggle |

---

## 5. LM Tool Renaming

### 5.1 Unified Prefix: `tomAi_`

All LM tools will use the `tomAi_` prefix.

| # | Current Name | New Name | Display Name |
|---|-------------|----------|-------------|
| 1 | `tom_createFile` | `tomAi_createFile` | Create File |
| 2 | `tom_readFile` | `tomAi_readFile` | Read File |
| 3 | `tom_editFile` | `tomAi_editFile` | Edit File |
| 4 | `tom_multiEditFile` | `tomAi_multiEditFile` | Multi Edit File |
| 5 | `tom_listDirectory` | `tomAi_listDirectory` | List Directory |
| 6 | `tom_findFiles` | `tomAi_findFiles` | Find Files |
| 7 | `tom_findTextInFiles` | `tomAi_findTextInFiles` | Find Text in Files |
| 8 | `tom_runCommand` | `tomAi_runCommand` | Run Command |
| 9 | `tom_runVscodeCommand` | `tomAi_runVscodeCommand` | Run VS Code Command |
| 10 | `tom_getErrors` | `tomAi_getErrors` | Get Errors |
| 11 | `tom_fetchWebpage` | `tomAi_fetchWebpage` | Fetch Webpage |
| 12 | `tom_readGuideline` | `tomAi_readGuideline` | Read Guideline |
| 13 | `tom_readLocalGuideline` | `tomAi_readLocalGuideline` | Read Local Guideline |
| 14 | `tom_webSearch` | `tomAi_webSearch` | Web Search |
| 15 | `tom_manageTodo` | `tomAi_manageTodo` | Manage Todo List |
| 16 | `dartscript_notifyUser` | `tomAi_notifyUser` | Notify User |
| 17 | `dartscript_getWorkspaceInfo` | `tomAi_getWorkspaceInfo` | Get Workspace Info |
| 18 | `dartscript_listTodos` | `tomAi_listTodos` | List All Quest Todos |
| 19 | `dartscript_getAllTodos` | `tomAi_getAllTodos` | List All Quest + Session Todos |
| 20 | `dartscript_getTodo` | `tomAi_getTodo` | Get Quest Todo |
| 21 | `dartscript_createTodo` | `tomAi_createTodo` | Create Quest Todo |
| 22 | `dartscript_updateTodo` | `tomAi_updateTodo` | Update Quest Todo |
| 23 | `dartscript_moveTodo` | `tomAi_moveTodo` | Move Quest Todo |
| 24 | `dartscript_windowTodo_add` | `tomAi_sessionTodo_add` | Add Session Todo |
| 25 | `dartscript_windowTodo_list` | `tomAi_sessionTodo_list` | List Session Todos |
| 26 | `dartscript_windowTodo_getAll` | `tomAi_sessionTodo_getAll` | Get All Session Todos |
| 27 | `dartscript_windowTodo_update` | `tomAi_sessionTodo_update` | Update Session Todo |
| 28 | `dartscript_windowTodo_delete` | `tomAi_sessionTodo_delete` | Delete Session Todo |
| 29 | `addToPromptQueue` | `tomAi_queue_add` | Add to Prompt Queue |
| 30 | `addFollowUpPrompt` | `tomAi_queue_addFollowUp` | Add Follow-Up Prompt |
| 31 | `sendQueuedPrompt` | `tomAi_queue_sendNow` | Send Queued Prompt |
| 32 | `addTimedRequest` | `tomAi_timed_add` | Add Timed Request |
| 33 | `tom_queue_list` | `tomAi_queue_list` | Queue List |
| 34 | `tom_queue_update_item` | `tomAi_queue_updateItem` | Queue Update Item |
| 35 | `tom_queue_set_status` | `tomAi_queue_setStatus` | Queue Set Status |
| 36 | `tom_queue_send_now` | `tomAi_queue_sendNow` | Queue Send Now |
| 37 | `tom_queue_remove_item` | `tomAi_queue_removeItem` | Queue Remove Item |
| 38 | `tom_queue_update_followup` | `tomAi_queue_updateFollowUp` | Queue Update Follow-Up |
| 39 | `tom_queue_remove_followup` | `tomAi_queue_removeFollowUp` | Queue Remove Follow-Up |
| 40 | `tom_timed_list` | `tomAi_timed_list` | Timed List |
| 41 | `tom_timed_update_entry` | `tomAi_timed_updateEntry` | Timed Update Entry |
| 42 | `tom_timed_remove_entry` | `tomAi_timed_removeEntry` | Timed Remove Entry |
| 43 | `tom_timed_set_engine_state` | `tomAi_timed_setEngineState` | Timed Set Engine State |
| 44 | `tom_prompt_template_manage` | `tomAi_templates_manage` | Manage Prompt Templates |
| 45 | `tom_reminder_template_manage` | `tomAi_reminders_manage` | Manage Reminder Templates |
| 46 | `tom_askBigBrother` | `tomAi_askBigBrother` | Ask Big Brother |
| 47 | `tom_askCopilot` | `tomAi_askCopilot` | Ask Copilot |

### 5.2 Duplicate Tool Removal

Remove these duplicates (old tools superseded by `tomAi_queue_*` / `tomAi_timed_*`):

| Remove | Replaced By |
|--------|-------------|
| `addToPromptQueue` (old) | `tomAi_queue_add` |
| `addFollowUpPrompt` (old) | `tomAi_queue_addFollowUp` |
| `sendQueuedPrompt` (old) | `tomAi_queue_sendNow` |
| `addTimedRequest` (old) | `tomAi_timed_add` |

After dedup: **43 tools** (from 47).

---

## 6. VS Code Settings Renaming

| # | Current Setting | New Setting | Type | Default | Description |
|---|----------------|-------------|------|---------|-------------|
| 1 | `dartscript.contextApproach` | `tomAi.contextApproach` | string | `"accumulation"` | Context persistence approach |
| 2 | `dartscript.maxContextSize` | `tomAi.maxContextSize` | number | `50000` | Maximum context size in tokens |
| 3 | `dartscript.autoRunOnSave` | `tomAi.autoRunOnSave` | boolean | `false` | Auto-run scripts on save |
| 4 | `dartscript.copilotModel` | `tomAi.copilot.model` | string | (no default — error if unset) | Copilot model ID |
| 5 | `dartscript.configPath` | `tomAi.configPath` | string | `"~/.tom/vscode/tom_vscode_extension.json"` | Config file path |
| 6 | `dartscript.sendToChat.showNotifications` | `tomAi.copilot.showNotifications` | boolean | `true` | Show send notifications |
| 7 | `dartscript.sendToChat.chatAnswerFolder` | `tomAi.copilot.answerFolder` | string | `"${ai}/chat_replies"` | Chat answer files folder |
| 8 | `dartscript.tomAiChat.modelId` | `tomAi.tomAiChat.modelId` | string | (no default — error if unset) | Tom AI Chat model |
| 9 | `dartscript.tomAiChat.tokenModelId` | `tomAi.tomAiChat.tokenModelId` | string | (no default — error if unset) | Token count model |
| 10 | `dartscript.tomAiChat.responsesTokenLimit` | `tomAi.tomAiChat.responsesTokenLimit` | number | `50000` | Responses token limit |
| 11 | `dartscript.tomAiChat.responseSummaryTokenLimit` | `tomAi.tomAiChat.responseSummaryTokenLimit` | number | `8000` | Summary token limit |
| 12 | `dartscript.tomAiChat.preProcessingModelId` | `tomAi.tomAiChat.preProcessingModelId` | string | (no default — error if unset) | Pre-processing model |
| 13 | `dartscript.tomAiChat.enablePromptOptimization` | `tomAi.tomAiChat.enablePromptOptimization` | boolean | `false` | Enable pre-processing |
| 14 | `dartscript.ollama.url` | `tomAi.localLlm.ollamaUrl` | string | `"http://localhost:11434"` | Ollama server URL |
| 15 | `dartscript.ollama.model` | `tomAi.localLlm.ollamaModel` | string | (no default — error if unset) | Ollama model name |
| 16 | `dartscript.notes.workspaceTodoFile` | `tomAi.todo.workspaceTodoFile` | string | `"workspace.todo.yaml"` | Workspace todo path |
| 17 | `dartscript.notes.questNotesFilePattern` | `tomAi.notes.questNotesPattern` | string | `"${ai}/quests/${quest}/quest-notes.${quest}.md"` | Quest notes pattern |
| 18 | `dartscript.notes.questTodoFilePattern` | `tomAi.todo.questTodoPattern` | string | `"todos.${quest}.todo.yaml"` | Quest todo pattern |
| 19 | `dartscript.guidelines.projectExcludeGlobs` | `tomAi.guidelines.excludeGlobs` | array | `["tom/zom_*/**"]` | Guidelines exclude globs |
| 20 | `dartscript.projectDetection.excludeGlobs` | `tomAi.projectDetection.excludeGlobs` | array | `["tom/zom_*/**"]` | Project detection exclude |

### 6.1 New Settings to Add

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tomAi.aiFolder` | string | `"_ai"` | Root AI folder name (configurable) |
| `tomAi.trail.enabled` | boolean | `true` | Enable trail logging |
| `tomAi.bridge.requestTimeout` | number | `30000` | Bridge request timeout ms |
| `tomAi.bridge.restartDelay` | number | `5000` | Bridge restart delay ms |
| `tomAi.bridge.maxRestarts` | number | `10` | Max restart attempts |
| `tomAi.timedRequests.tickInterval` | number | `30000` | Timer tick interval ms |

### 6.2 Model Default Policy

**No hardcoded model defaults.** If a model setting is not configured, the extension shows an error message: "Model not configured. Set `tomAi.copilot.model` in settings." This applies to:
- `tomAi.copilot.model`
- `tomAi.tomAiChat.modelId`
- `tomAi.tomAiChat.tokenModelId`
- `tomAi.tomAiChat.preProcessingModelId`
- `tomAi.localLlm.ollamaModel`

---

## 7. Configuration File Restructuring

### 7.1 Current → New Config Key Mapping

The JSON config file (`tom_vscode_extension.json`) top-level keys are reorganized to use canonical subsystem names:

| # | Current Key | New Key | Notes |
|---|------------|---------|-------|
| 1 | `promptExpander` | `localLlm` | Rename to canonical |
| 2 | `promptExpander.profiles` | `localLlm.profiles` | Under new parent |
| 3 | `promptExpander.models` | `localLlm.models` | Under new parent |
| 4 | `llmConfigurations` | `localLlm.configurations` | Move under subsystem |
| 5 | `botConversation` | `conversation` | Rename to canonical |
| 6 | `botConversation.profiles` | `conversation.profiles` | Under new parent |
| 7 | `botConversation.selfTalk` | `conversation.selfTalk` | Under new parent |
| 8 | `aiConversationSetups` | `conversation.setups` | Move under subsystem |
| 9 | `templates` (top-level) | `copilot.templates` | Move under subsystem |
| 10 | `defaultTemplates` | (distributed) | Split into per-subsystem `defaultTemplate` |
| 11 | `defaultTemplates.copilot` | `copilot.defaultTemplate` | Move under subsystem |
| 12 | (new) | `localLlm.defaultTemplate` | Add for symmetry |
| 13 | (new) | `conversation.defaultTemplate` | Add for symmetry |
| 14 | (new) | `tomAiChat.defaultTemplate` | Add for symmetry |
| 15 | `tomAiChat` | `tomAiChat` | Already canonical |
| 16 | `tomAiChat.templates` | `tomAiChat.templates` | Already correct |
| 17 | `telegram` | `conversation.telegram` | Move under subsystem |
| 18 | `telegramAutostart` | `conversation.telegram.autostart` | Move under subsystem |
| 19 | `trail` | `trail` | Keep |
| 20 | `trail.paths.*` | `trail.paths.*` | Reorganize (see §8) |
| 21 | `trailCleanupDays` | `trail.cleanupDays` | Move under trail |
| 22 | `trailMaxEntries` | `trail.maxEntries` | Move under trail |
| 23 | `localLlmTools` | `localLlm.tools` | Move under subsystem |
| 24 | `dartscriptBridge` | `bridge` | Rename |
| 25 | `cliServerAutostart` | `bridge.cliServerAutostart` | Move under bridge |
| 26 | `binaryPath` | `bridge.binaryPath` | Move under bridge |
| 27 | `executables` | `bridge.executables` | Move under bridge |
| 28 | `externalApplications` | `externalApplications` | Keep |
| 29 | `commandlines` | `commandlines` | Keep |
| 30 | `commandlinePostActions` | `commandlinePostActions` | Keep |
| 31 | `combinedCommands` | `stateMachines` | Rename for clarity |
| 32 | `stateMachineCommands` | `stateMachines.commands` | Merge with above |
| 33 | `favorites` | `favorites` | Keep |
| 34 | `userName` | `userName` | Keep |
| 35 | `copilotChatAnswerFolder` | `copilot.answerFolder` | Move under subsystem |
| 36 | `copilotAnswerPath` | (remove — use `copilot.answerFolder`) | Deduplicate |
| 37 | `todoPanel` | `todo` | Rename |
| 38 | `issuePanels` | `issuePanels` | Keep |
| 39 | `reminderTemplates` | `reminders.templates` | Group under reminders |
| 40 | `reminderConfig` | `reminders.config` | Group under reminders |
| 41 | `timedRequests` | `timedRequests` | Keep |

### 7.2 New Config File Structure (Consolidated)

```jsonc
{
    // Global
    "userName": "...",
    "default": "...",

    // Per-subsystem configuration
    "localLlm": {
        "profiles": [...],
        "models": [...],
        "configurations": [...],
        "tools": {...},
        "defaultTemplate": "..."
    },
    "conversation": {
        "profiles": [...],
        "selfTalk": [...],
        "setups": [...],
        "telegram": {
            "autostart": false,
            "botToken": "...",
            "chatId": "...",
            "pollInterval": 300000
        },
        "defaultTemplate": "..."
    },
    "copilot": {
        "templates": [...],
        "answerFolder": "${ai}/chat_replies",
        "defaultTemplate": "..."
    },
    "tomAiChat": {
        "templates": [...],
        "defaultTemplate": "..."
    },

    // Trail configuration
    "trail": {
        "enabled": true,
        "cleanupDays": 2,
        "maxEntries": 1000,
        "paths": {
            "localLlm": "${ai}/trail/localllm",
            "copilot": "${ai}/trail/copilot",
            "lmApi": "${ai}/trail/lm-api"
        }
    },

    // Bridge & infrastructure
    "bridge": {
        "binaryPath": {...},
        "executables": {...},
        "cliServerAutostart": false,
        "requestTimeout": 30000,
        "restartDelay": 5000,
        "maxRestarts": 10
    },

    // UI & layout
    "stateMachines": {
        "commands": {...}
    },
    "favorites": [...],
    "externalApplications": {...},

    // Commandlines
    "commandlines": [...],
    "commandlinePostActions": [...],

    // Todo & issues
    "todo": {
        "defaultColumns": [...]
    },
    "issuePanels": {...},

    // Reminders & timed requests
    "reminders": {
        "templates": [...],
        "config": {
            "checkInterval": 30000,
            "defaultTimeout": 600000
        }
    },
    "timedRequests": [...]
}
```

### 7.3 TomAiConfiguration Class

A new `TomAiConfiguration` class centralizes ALL config access:

```typescript
class TomAiConfiguration {
    // Singleton
    static init(context: ExtensionContext): void;
    static get instance(): TomAiConfiguration;

    // Config path resolution (replaces getConfigPath + getConfigPathSimple)
    get configPath(): string;

    // Typed section accessors
    getLocalLlm(): LocalLlmConfig;
    getConversation(): ConversationConfig;
    getCopilot(): CopilotConfig;
    getTomAiChat(): TomAiChatConfig;
    getTrail(): TrailConfig;
    getBridge(): BridgeConfig;
    getTodo(): TodoConfig;
    getReminders(): RemindersConfig;
    getFavorites(): FavoriteEntry[];

    // Generic section accessor
    getSection<T>(key: string): T | undefined;
    getSectionOrThrow<T>(key: string): T;

    // Write access (preserves comments via YAML AST if YAML, else JSON)
    updateSection(key: string, value: unknown): Promise<void>;

    // Reload from disk
    reload(): void;

    // Defaults (used when no config file exists)
    static get defaults(): Readonly<TomAiConfigDefaults>;

    // Missing config action
    createDefaultConfig(): Promise<void>;
}
```

**Key decisions:**
- Config resolution: VS Code setting → workspace `.tom/` → `~/.tom/vscode/` → built-in defaults
- All 15 inline `JSON.parse(fs.readFileSync(...))` patterns replaced by `TomAiConfiguration.instance.getSection()`
- If no config file found, display a button: "Create Default Configuration"
- `getConfigPath()` and `getConfigPathSimple()` are both removed — replaced by `TomAiConfiguration.instance.configPath`

---

## 8. Trail System Redesign

### 8.1 Two Trail Types

| Trail Type | Purpose | Viewer |
|-----------|---------|--------|
| **Raw Trail** | Complete content: full prompt, full answer, tool requests, tool answers, thinking blocks | Raw Trail Viewer |
| **Summary Trail** | Core user prompt (no wrappers/injections) + markdown answer + metadata | Summary Trail Viewer |

### 8.2 Raw Trail File Naming

Location: `${ai}/trail/<subsystem-folder>/`

File naming: `<timestamp>_<type>_<window-id>.<extension>`

| Component | Format | Example |
|-----------|--------|---------|
| `timestamp` | `YYYYMMDD_HHMMSS` | `20260226_143052` |
| `type` | `prompt`, `answer`, `tool_request`, `tool_answer`, `thinking` | `prompt` |
| `window-id` | VS Code window ID (short hash) | `a7ae42e5` |
| `extension` | `.md` for prompts/answers, `.json` for tool data | `.md` |

Example: `20260226_143052_prompt_a7ae42e5.md`

### 8.3 Raw Trail Subsystem Folders

| Subsystem | Folder Path |
|-----------|------------|
| Local LLM | `${ai}/trail/localllm-<profile>` |
| Copilot | `${ai}/trail/copilot` |
| LM API (Tom AI Chat) | `${ai}/trail/lm-api-<model>` |

Where `<profile>` is the active LLM profile name (e.g., `default`, `codegen`) and `<model>` is the LM API model ID (e.g., `gpt-5.2`).

### 8.4 Summary Trail Files

Location: Quest folder (`${ai}/quests/<quest-id>/`)

| File Pattern | Content |
|-------------|---------|
| `<quest-id>.copilot.prompts.md` | Core Copilot prompts (no wrappers) |
| `<quest-id>.copilot.answers.md` | Copilot answers (markdown) |
| `<quest-id>.localllm-<profile>.prompts.md` | Local LLM prompts |
| `<quest-id>.localllm-<profile>.answers.md` | Local LLM answers |
| `<quest-id>.lm-api-<model>.prompts.md` | Tom AI Chat prompts |
| `<quest-id>.lm-api-<model>.answers.md` | Tom AI Chat answers |

AI Conversation uses one of the above three subsystems and delegates trail writing accordingly (it already does this).

### 8.5 Trail Configuration

```jsonc
{
    "trail": {
        "enabled": true,
        "cleanupDays": 2,
        "maxEntries": 1000,
        "stripThinking": true,    // Setting to strip <thinking> blocks from raw trail
        "paths": {
            "localLlm": "${ai}/trail/localllm",
            "copilot": "${ai}/trail/copilot",
            "lmApi": "${ai}/trail/lm-api"
        }
    }
}
```

Note: Profile/model suffixes are appended dynamically. The paths above are base paths.

### 8.6 TrailService Class

```typescript
class TrailService {
    static init(context: ExtensionContext): void;
    static get instance(): TrailService;

    // Raw trail writing
    writeRawPrompt(subsystem: TrailSubsystem, prompt: string, windowId: string): void;
    writeRawAnswer(subsystem: TrailSubsystem, answer: string, windowId: string): void;
    writeRawToolRequest(subsystem: TrailSubsystem, request: object, windowId: string): void;
    writeRawToolAnswer(subsystem: TrailSubsystem, response: object, windowId: string): void;

    // Summary trail writing
    writeSummaryPrompt(subsystem: TrailSubsystem, corePrompt: string, questId?: string): void;
    writeSummaryAnswer(subsystem: TrailSubsystem, answer: string, metadata?: TrailMetadata, questId?: string): void;

    // Config
    isEnabled(): boolean;
    toggle(): void;
    getSubsystemPath(subsystem: TrailSubsystem): string;
}

type TrailSubsystem =
    | { type: 'localLlm'; profile: string }
    | { type: 'copilot' }
    | { type: 'lmApi'; model: string };
```

### 8.7 Eliminated Trail Systems

| Current System | Status |
|---------------|--------|
| `writePromptTrail()` / `writeAnswerTrail()` in unifiedNotepad-handler.ts | **Remove** — replaced by `TrailService` |
| `logPrompt()` / `logResponse()` / `clearTrail()` in trailLogger-handler.ts | **Remove** — replaced by `TrailService` |
| `_appendToTrail()` in dsNotes-handler.ts | **Remove** — replaced by `TrailService` |
| Destructive `clearTrail('copilot')` before send | **Remove** — trail is never auto-cleared. User deletes files manually if desired. |
| `escalation` trail type | **Remove** — obsolete |

---

## 9. Folder Structure Consolidation

### 9.1 Complete Folder Structure

Starting from workspace root. `${ai}` defaults to `_ai` and is configurable via `tomAi.aiFolder` setting.

```
<workspace-root>/
├── ${ai}/                              # AI folder (configurable, default: _ai)
│   ├── answers/
│   │   └── copilot/                    # Copilot chat-answer JSON files
│   ├── attachments/                    # File attachments for prompts
│   ├── bot_conversations/              # AI Conversation session logs
│   ├── chat_replies/                   # Copilot answer watcher folder (configurable)
│   ├── clarifications/                 # User clarification files
│   ├── clarifications_processed/       # Processed clarification files
│   ├── copilot/                        # Copilot-specific data
│   ├── local/                          # Local LLM specific data
│   │   └── local-instructions/         # Local LLM instruction files
│   ├── notes/                          # General notes
│   ├── prompt/                         # Reusable prompt files (*.prompt.md)
│   ├── quests/                         # Quest folders
│   │   └── <quest-id>/
│   │       ├── overview.<quest-id>.md
│   │       ├── todos.<quest-id>.todo.yaml
│   │       ├── <quest-id>.copilot.prompts.md        # Summary trail
│   │       ├── <quest-id>.copilot.answers.md        # Summary trail
│   │       ├── <quest-id>.localllm-<profile>.prompts.md
│   │       ├── <quest-id>.localllm-<profile>.answers.md
│   │       ├── <quest-id>.lm-api-<model>.prompts.md
│   │       └── <quest-id>.lm-api-<model>.answers.md
│   ├── roles/                          # AI role definitions
│   ├── schemas/                        # Schema files
│   │   └── yaml/                       # YAML schemas
│   ├── tom_ai_chat/                    # Tom AI Chat session files (*.chat.md)
│   └── trail/                          # Raw trail files
│       ├── copilot/                    # Raw Copilot trails
│       ├── localllm-<profile>/         # Raw Local LLM trails (per profile)
│       └── lm-api-<model>/             # Raw LM API trails (per model)
├── .tom/                               # Workspace config folder
│   ├── tom_vscode_extension.json       # Main config file
│   └── json-schema/                    # JSON Schema definitions
├── .tom_metadata/                      # Workspace metadata
│   └── tom_master.yaml
├── _copilot_guidelines/                # Global AI guidelines
├── _copilot_local/                     # Local guidelines (for local LLM)
├── _copilot_tomai/                     # Tom AI Chat guidelines
└── ztmp/                               # Temporary files
```

### 9.2 Path Registry (WsPaths Update)

All paths centralized in the updated `WsPaths` class:

| Constant | Value | Configurable |
|----------|-------|-------------|
| `AI_FOLDER` | `${tomAi.aiFolder}` (default `_ai`) | **Yes** via setting |
| `GUIDELINES_FOLDER` | `_copilot_guidelines` | No (fixed) |
| `LOCAL_GUIDELINES` | `_copilot_local` | No (fixed) |
| `TOMAI_GUIDELINES` | `_copilot_tomai` | No (fixed) |
| `TOM_METADATA_FOLDER` | `.tom_metadata` | No (fixed) |
| `WORKSPACE_CONFIG_FOLDER` | `.tom` | No (fixed) |
| `CONFIG_FILE_NAME` | `tom_vscode_extension.json` | No (fixed) |
| `HOME_TOM_FOLDER` | `.tom` | No (fixed) |
| `TEMP_FOLDER` | `ztmp` | No (fixed) |

**AI subfolder registry (all relative to `${ai}/`):**

| Key | Path | Used For |
|-----|------|---------|
| `quests` | `quests` | Quest data |
| `roles` | `roles` | AI roles |
| `notes` | `notes` | Notes |
| `local` | `local` | Local LLM data |
| `prompt` | `prompt` | Reusable prompts |
| `schemas` | `schemas/yaml` | YAML schemas |
| `copilot` | `copilot` | Copilot data |
| `tomAiChat` | `tom_ai_chat` | Chat session files |
| `chatReplies` | `chat_replies` | Copilot answers |
| `botConversations` | `bot_conversations` | Conversation logs |
| `attachments` | `attachments` | Attachments |
| `answersCopilot` | `answers/copilot` | Copilot answer JSONs |
| `trail` | `trail` | Raw trail root |
| `trailCopilot` | `trail/copilot` | Raw trail: Copilot |
| `trailLocalLlm` | `trail/localllm` | Raw trail: Local LLM base |
| `trailLmApi` | `trail/lm-api` | Raw trail: LM API base |
| `clarifications` | `clarifications` | Clarification files |
| `localInstructions` | `local/local-instructions` | Local LLM instructions |

### 9.3 Hardcoded Path Removal

All paths that are currently hardcoded in handler files will be moved to `WsPaths`:

| Currently Hardcoded In | Path | Moved To |
|------------------------|------|----------|
| `tool-executors.ts` | `_copilot_tomai/` | `WsPaths.TOMAI_GUIDELINES` |
| `tool-executors.ts` | `_copilot_local/` | `WsPaths.LOCAL_GUIDELINES` |
| Various | `ztmp/` | `WsPaths.TEMP_FOLDER` |
| `unifiedNotepad-handler.ts` | `_ai/trail/` | `WsPaths.ai('trail')` |
| `trailViewer-handler.ts` | `_ai/trail/` | `WsPaths.ai('trail')` |
| `reusablePromptEditor-handler.ts` | `_ai/prompt/` | `WsPaths.ai('prompt')` |
| `variableResolver.ts` | `.tom/json-schema/` | `WsPaths.wsConfig('json-schema')` |

---

## 10. New Utility Classes & Infrastructure

### 10.1 FsUtils Class

New file: `src/utils/fsUtils.ts`

```typescript
class FsUtils {
    static ensureDir(dirPath: string): void;
    static safeReadFile(filePath: string): string | undefined;
    static safeReadJson<T>(filePath: string): T | undefined;
    static safeWriteJson(filePath: string, data: unknown, indent?: number): void;
    static safeReadYaml<T>(filePath: string): T | undefined;
    static safeWriteYaml(filePath: string, data: unknown): void;
    static fileExists(filePath: string): boolean;
    static listFiles(dirPath: string, pattern?: string): string[];
}
```

Replaces ~54 inline `ensureDir` patterns and ~30 inline `readFileSync`+`JSON.parse` patterns.

### 10.2 BaseWebviewProvider Class

New file: `src/utils/baseWebviewProvider.ts`

```typescript
abstract class BaseWebviewProvider implements vscode.WebviewViewProvider {
    // Shared HTML generation
    protected getBaseHtml(webview: vscode.Webview, body: string, scripts?: string): string;
    protected getNonce(): string;
    protected getBaseStyles(): string;

    // Standard message handling registration
    protected registerMessageHandler(type: string, handler: (msg: any) => Promise<void>): void;
    protected abstract onResolve(webview: vscode.Webview): void;

    // Lifecycle
    resolveWebviewView(view: vscode.WebviewView): void;
    dispose(): void;
}
```

Consolidates 17 `_getHtml()` methods and 41 custom message handlers.

### 10.3 Shared Message Types

New file: `src/types/webviewMessages.ts`

```typescript
// Base message type
interface WebviewMessage {
    type: string;
    [key: string]: unknown;
}

// Chat panel messages
interface ChatPanelSendMessage extends WebviewMessage {
    type: 'send';
    panelId: 'localLlm' | 'conversation' | 'copilot' | 'tomAiChat';
    text: string;
    templateId?: string;
}

interface ChatPanelDraftMessage extends WebviewMessage {
    type: 'saveDraft' | 'loadDraft';
    panelId: string;
    text?: string;
}

// Todo panel messages
interface TodoPanelMessage extends WebviewMessage {
    type: 'create' | 'update' | 'delete' | 'move' | 'refresh';
    todoId?: string;
    data?: Record<string, unknown>;
}
```

### 10.4 Constants Registry

New file: `src/utils/constants.ts`

```typescript
// Timeouts (all in milliseconds)
export const BRIDGE_REQUEST_TIMEOUT = 30_000;
export const BRIDGE_RESTART_DELAY = 5_000;
export const BRIDGE_MAX_RESTARTS = 10;
export const TIMER_TICK_INTERVAL = 30_000;
export const REMINDER_CHECK_INTERVAL = 30_000;
export const REMINDER_DEFAULT_TIMEOUT = 600_000;
export const TELEGRAM_POLL_INTERVAL = 300_000;
export const BRIDGE_AUTO_START_DELAY = 2_000;
export const CLI_SERVER_AUTO_START_DELAY = 1_000;
export const TELEGRAM_AUTO_START_DELAY = 2_000;

// Trail limits
export const TRAIL_MAX_FILES_PER_FOLDER = 50;
export const TRAIL_MAX_VIEWER_EXCHANGES = 100;
export const TRAIL_DEFAULT_CLEANUP_DAYS = 2;
export const TRAIL_DEFAULT_MAX_ENTRIES = 1000;

// File extensions
export const FILE_EXT_TODO = '.todo.yaml';
export const FILE_EXT_CHAT = '.chat.md';
export const FILE_EXT_PROMPT = '.prompt.md';
export const FILE_EXT_TRAIL_PROMPT = '.userprompt.md';
export const FILE_EXT_TRAIL_ANSWER = '.answer.json';
export const FILE_EXT_PROMPTS_MD = '.prompts.md';
export const FILE_EXT_ANSWERS_MD = '.answers.md';

// File patterns (glob)
export const GLOB_TODO = '**/*.todo.yaml';
export const GLOB_PROMPT = '**/*.prompt.md';
export const GLOB_CHAT = '**/*.chat.md';
export const GLOB_FLOW = '*.flow.yaml';
export const GLOB_STATE = '*.state.yaml';
export const GLOB_ER = '*.er.yaml';
```

All files importing these constants can be configured to use `TomAiConfiguration` overrides where applicable (bridge timeouts, trail limits, etc.).

---

## 11. Todo System Unification

### 11.1 TodoProvider API

New file: `src/managers/todoProvider.ts`

```typescript
interface TodoProviderOptions {
    scope: 'quest' | 'session' | 'workspace' | 'scratch';
    todoFile?: string;          // Specific file path
    questId?: string;           // For quest-scoped todos
    windowId?: string;          // For session-scoped todos
    autoDiscover?: boolean;     // Scan for files automatically
}

class TodoProvider {
    constructor(options: TodoProviderOptions);

    // CRUD
    create(todo: TodoInput): Promise<TodoItem>;
    update(id: string, changes: Partial<TodoItem>): Promise<TodoItem>;
    delete(id: string): Promise<void>;
    move(id: string, targetFile: string): Promise<void>;
    get(id: string): Promise<TodoItem | undefined>;

    // Queries
    list(filter?: TodoFilter): Promise<TodoItem[]>;
    getSummary(): Promise<string>;
    formatAsMarkdown(): Promise<string>;

    // File discovery
    getFiles(): string[];
    findTodoFile(questId: string): string | undefined;

    // Events
    onDidChange: vscode.Event<void>;
}
```

### 11.2 Migration

| Current System | Migration Path |
|---------------|---------------|
| `QuestTodoManager` | Becomes the internal engine behind `TodoProvider` |
| `WindowSessionTodoStore` | Uses `TodoProvider` with `scope: 'session'` |
| `TodoManager` (JSON, Tom AI Chat only) | **Remove** — Tom AI Chat uses `TodoProvider` with `scope: 'scratch'` writing `*.todo.yaml` |

All panels (Quest Todos, Session Todos, Workspace Todos, Tom AI Chat scratch todos) use the same `TodoProvider` API. All output is `*.todo.yaml` format.

---

## 12. Persistence Unification

### 12.1 Target: YAML with AST/CST Preservation

All file-based persistence will use YAML format with the `yaml` package's Document API for CST-preserving edits. This means:
- Comments in YAML files are preserved on modification
- Formatting is preserved
- No accidental rewriting of non-modified sections

### 12.2 Manager Persistence Changes

| Manager | Current Persistence | New Persistence |
|---------|-------------------|-----------------|
| `ChatVariablesStore` | `workspaceState` (per workspace) | File: `<window-id>.chatvariable.yaml` (per VS Code window) |
| `PromptQueueManager` | YAML via `panelYamlStore` | YAML via `TodoProvider`-style API |
| `TimerEngine` | YAML via `panelYamlStore` | YAML timer file referencing prompt flow files |
| `ReminderSystem` | JSON config section | YAML via dedicated reminder file |
| `QuestTodoManager` | Direct YAML | `TodoProvider` (same underlying format) |
| `WindowSessionTodoStore` | Delegates to QuestTodoManager | `TodoProvider` with `scope: 'session'` |
| `TodoManager` | JSON (`*.todos.json`) | **Remove** — use `TodoProvider` with `scope: 'scratch'` |

### 12.3 ChatVariablesStore Changes

**Current:** Per workspace via `context.workspaceState['chatVariablesStore']`  
**New:** Per VS Code window via `${ai}/<window-id>.chatvariable.yaml`

- `<window-id>` is from `vscode.env.sessionId` or a window-local ID
- Cleanup: On window reload, stale files from closed windows are cleaned up
- On VS Code close: The dispose handler removes the file for the current window

### 12.4 WorkspaceState Key Cleanup

All workspace state keys will use the `tomAi.` prefix consistently:

| Current Key | New Key |
|------------|---------|
| `llmSelectedConfig` | `tomAi.localLlm.selectedConfig` |
| `conversationAiSetup` | `tomAi.conversation.selectedSetup` |
| `qt.panelState` | `tomAi.questTodo.panelState` |
| `qt.pendingSelect` | `tomAi.questTodo.pendingSelect` |
| `trailEditor.pendingFocus` | `tomAi.trailEditor.pendingFocus` |
| `copilotAutoHideDelay` | `tomAi.copilot.autoHideDelay` |
| `WorkspaceNotepadProvider.STORAGE_KEY` | `tomAi.notes.workspaceNoteFile` |
| `dartscript.dsNotes.localLlmDraft` | `tomAi.chatPanel.localLlm.draft` |
| `dartscript.dsNotes.conversationDraft` | `tomAi.chatPanel.conversation.draft` |
| `dartscript.dsNotes.copilotDraft` | `tomAi.chatPanel.copilot.draft` |
| `dartscript.dsNotes.tomAiChatDraft` | `tomAi.chatPanel.tomAiChat.draft` |
| `dartscript.dsNotes.conversationLlmProfileA` | **Remove** (unused) |
| `dartscript.dsNotes.conversationLlmProfileB` | **Remove** (unused) |

---

## 13. Prompt Processing Unification

### 13.1 Unified Prompt Pipeline

All four subsystems will use the same prompt processing pipeline.

```
User Input
    ↓
Template Application (if template selected or defaultTemplate configured)
    ↓
Variable Expansion (quest, role, activeProjects, todo, custom vars)
    ↓
Trail Logging (via TrailService — both raw and summary)
    ↓
Subsystem-Specific Send
    ├── Copilot: workbench.action.chat.open
    ├── Local LLM: Ollama HTTP API
    ├── Tom AI Chat: VS Code LM API (sendCopilotRequest)
    └── AI Conversation: delegates to one of the above
```

### 13.2 Copilot-Specific Differences

- Copilot does NOT need conversation history (VS Code manages it)
- Copilot uses answer-file watcher to capture responses
- Copilot answer files: only exist for Copilot (because we cannot access Copilot responses directly)

### 13.3 Sidebar Notes → Copilot

The six sidebar panels (VS Code Notes, Quest Notes, Workspace Notes, Quest Todos, Session Todos, Workspace Todos) all send to Copilot when the send button is pressed:

- Selection in textarea → send selected text
- No selection → send complete text
- Always uses the Answer Wrapper template
- Treated as if sent from the @CHAT Copilot panel
- Trail logging via `TrailService` with subsystem `copilot`

### 13.4 @CHAT Panel Feature Additions

All four @CHAT panels will get these features uniformly:

| Feature | Currently Available In | Add To |
|---------|----------------------|--------|
| `defaultTemplate` config | Copilot only | Local LLM, Conversation, Tom AI Chat |
| Raw Trail Viewer button | Local LLM, Copilot | Conversation, Tom AI Chat |
| Summary Trail Viewer button | (new) | All four panels |
| Progress notification + cancel | Local LLM only | Conversation, Tom AI Chat |

Features that remain Copilot-only (by design):
- Answer file watcher (no other subsystem needs it)
- Keep content after send
- Auto-hide delay
- Queue integration (could be extended to others later)
- Timed requests (could be extended to others later)
- Context popup (quest/role) (could be extended to others later)

---

## 14. Sidebar Notes Clarification

### 14.1 Architecture: Notes ≠ Chat Panels

The sidebar panels in the Explorer are **notes**, not chat panels. They have a fundamentally different purpose:

| Sidebar Panel | Purpose | Has Send Button? | Sends To |
|--------------|---------|-----------------|----------|
| VS CODE NOTES | Workspace-wide scratch notes | Yes → Copilot | Copilot (with Answer Wrapper) |
| QUEST NOTES | Per-quest notes | Yes → Copilot | Copilot (with Answer Wrapper) |
| WORKSPACE NOTES | Workspace file-based notes | Yes → Copilot | Copilot (with Answer Wrapper) |
| QUEST TODOS | Quest todo management | Yes → Copilot | Copilot (with Answer Wrapper) |
| SESSION TODOS | Window session todos | Yes → Copilot | Copilot (with Answer Wrapper) |
| WORKSPACE TODOS | Workspace-wide todos | Yes → Copilot | Copilot (with Answer Wrapper) |
| TODO LOG | Read-only todo history | No | — |

### 14.2 No State Sync Needed

There is no need to sync state between sidebar notes and @CHAT panels. They are intentionally distinct:
- Sidebar = persistent notes/todos with optional send-to-Copilot
- @CHAT = dedicated AI chat interfaces with templates, profiles, trail, etc.

---

## 15. Dead Code Removal

### 15.1 Remove Unused Storage Keys

| Key | Declared In |
|-----|------------|
| `dartscript.dsNotes.conversationLlmProfileA` | `dsNotes-handler.ts` |
| `dartscript.dsNotes.conversationLlmProfileB` | `dsNotes-handler.ts` |

### 15.2 Remove Obsolete Trail System

| Item | Location |
|------|---------|
| `escalation` trail type | `trailLogger-handler.ts` |
| `trail.paths.escalation` config key | Config file |
| `_ai/trail/escalation/` folder handling | `escalation-tools-config.ts` |

### 15.3 Remove TodoManager (JSON)

| Item | Location |
|------|---------|
| `TodoManager` class | `todoManager.ts` |
| `*.todos.json` file handling | `tomAiChat-handler.ts` |
| `tom_manageTodo` tool's JSON format | `tom-ai-chat-tools.ts` |

### 15.4 Remove Duplicate Queue/Timed Tools

Old tools (replaced by `tomAi_queue_*` / `tomAi_timed_*`):
- `addToPromptQueue`
- `addFollowUpPrompt`
- `sendQueuedPrompt`
- `addTimedRequest`

---

## 16. Implementation Phases

### Phase 1: Infrastructure (No UI Changes)

**Goal:** Create new utility classes without changing any visible behavior.

| # | Task | Files |
|---|------|-------|
| 1.1 | Create `FsUtils` class | `src/utils/fsUtils.ts` (new) |
| 1.2 | Create `constants.ts` with all magic numbers/patterns | `src/utils/constants.ts` (new) |
| 1.3 | Create `TomAiConfiguration` class (read-only initially) | `src/utils/tomAiConfiguration.ts` (new) |
| 1.4 | Create `BaseWebviewProvider` abstract class | `src/utils/baseWebviewProvider.ts` (new) |
| 1.5 | Create `TrailService` class | `src/services/trailService.ts` (new) |
| 1.6 | Create shared webview message types | `src/types/webviewMessages.ts` (new) |
| 1.7 | Create `TodoProvider` API | `src/managers/todoProvider.ts` (new) |
| 1.8 | Unit test all new utilities | `src/test/` |

### Phase 2: Internal Rewiring (Behavior Preserved)

**Goal:** Replace inline patterns with new utilities, keeping all external IDs and names unchanged.

| # | Task | Impact |
|---|------|--------|
| 2.1 | Replace 54 inline `ensureDir` → `FsUtils.ensureDir()` | All 21 files |
| 2.2 | Replace 15 inline config reads → `TomAiConfiguration.instance.getSection()` | 11 handler files |
| 2.3 | Replace 30+ inline `readFileSync`+`JSON.parse` → `FsUtils.safeReadJson()` | Various files |
| 2.4 | Replace 9 hardcoded Ollama URLs → `TomAiConfiguration.instance.getLocalLlm().ollamaUrl` | 3 files |
| 2.5 | Replace hardcoded paths → `WsPaths` constants | 7+ files |
| 2.6 | Replace magic numbers → `constants.ts` imports | 10+ files |
| 2.7 | Consolidate 3 trail systems → `TrailService` | 3 handler files |
| 2.8 | Replace `TodoManager` → `TodoProvider` with `scope: 'scratch'` | `tomAiChat-handler.ts` |
| 2.9 | Refactor duplicate `_insertExpandedToChatFile()` → shared function | 2 handler files |
| 2.10 | Refactor duplicate `_openOrCreateChatFile()` → shared function | 2 handler files |
| 2.11 | Migrate webview providers to `BaseWebviewProvider` | 10+ provider classes |

### Phase 3: Rename & Rebrand

**Goal:** Change all external-facing names. This is the breaking change phase.

| # | Task | Impact |
|---|------|--------|
| 3.1 | Update `package.json`: extension ID, display name, publisher | Extension identity |
| 3.2 | Rename all 78 command IDs and titles (§2) | `package.json` + all handler registrations |
| 3.3 | Rename all view IDs and container IDs (§3) | `package.json` + view registrations |
| 3.4 | Rename all 20 VS Code settings (§6) | `package.json` + all settings reads |
| 3.5 | Rename all 47 LM tool names (§5) | `package.json` + tool registrations |
| 3.6 | Rename chat variable prefix → `tomAi.*` | `package.json` + variable provider |
| 3.7 | Rename submenu IDs | `package.json` |
| 3.8 | Update all keybindings (§4) | `package.json` |
| 3.9 | Rename handler files (§3.5) | File renames + import updates |
| 3.10 | Update workspace state keys (§12.4) | All provider classes |
| 3.11 | Update chat participant → `@tom` | `package.json` + participant handler |

### Phase 4: Config & Persistence Migration

**Goal:** Restructure config file and persistence.

| # | Task | Impact |
|---|------|--------|
| 4.1 | Implement config key migration (old → new structure, §7.1) | `TomAiConfiguration` |
| 4.2 | Add `createDefaultConfig()` with button when no config | `TomAiConfiguration` |
| 4.3 | Migrate `ChatVariablesStore` to per-window YAML | `chatVariablesStore.ts` |
| 4.4 | Add window cleanup logic for stale chatvariable files | Extension activation/deactivation |
| 4.5 | Implement configurable `${ai}` folder | `WsPaths` + settings |
| 4.6 | New trail folder structure (§8) | `TrailService` + `WsPaths` |
| 4.7 | Add backward-compat migration for old trail paths | `TrailService` |
| 4.8 | Update `PromptQueueManager` to use unified YAML format | `promptQueueManager.ts` |

### Phase 5: Feature Parity & Polish

**Goal:** Bring all @CHAT panels to feature parity where applicable.

| # | Task | Impact |
|---|------|--------|
| 5.1 | Add `defaultTemplate` config support to Local LLM, Conversation, Tom AI Chat | 3 panel handlers |
| 5.2 | Add Raw Trail Viewer + Summary Trail Viewer buttons to all 4 panels | `chatPanel-handler.ts` |
| 5.3 | Add Progress notification + cancel to Conversation and Tom AI Chat | 2 handlers |
| 5.4 | Unify prompt processing pipeline (§13.1) | All 4 subsystem handlers |
| 5.5 | Ensure sidebar notes send uses Answer Wrapper template consistently | `sidebarNotes-handler.ts` |
| 5.6 | Verify sidebar notes send behavior: selection → selected text, no selection → full text | `sidebarNotes-handler.ts` |
| 5.7 | Fix destructive `clearTrail()` — remove auto-clear, trail cleaned only by user | `sidebarNotes-handler.ts` |
| 5.8 | Remove duplicate LM tools (§15.4) | `package.json` + tool registrations |
| 5.9 | Remove dead code (§15) | Various files |

### Phase 6: Documentation & Testing

| # | Task |
|---|------|
| 6.1 | Update `extension_analysis.md` with new names and structure |
| 6.2 | Update README.md |
| 6.3 | Update `_copilot_guidelines/` references |
| 6.4 | Update copilot-instructions.md references |
| 6.5 | Full regression test of all commands, panels, trail, config |

---

## Summary: What Changes Where

### Files to Create

| File | Purpose |
|------|---------|
| `src/utils/fsUtils.ts` | File system utilities |
| `src/utils/constants.ts` | Constants registry |
| `src/utils/tomAiConfiguration.ts` | Central config access |
| `src/utils/baseWebviewProvider.ts` | Shared webview base class |
| `src/services/trailService.ts` | Unified trail logging |
| `src/types/webviewMessages.ts` | Shared message types |
| `src/managers/todoProvider.ts` | Unified todo API |

### Files to Rename

| Current | New |
|---------|-----|
| `dsNotes-handler.ts` | `sidebarNotes-handler.ts` |
| `expandPrompt-handler.ts` | `localLlm-handler.ts` |
| `botConversation-handler.ts` | `conversation-handler.ts` |
| `sendToChatAdvanced-handler.ts` | `copilotTemplates-handler.ts` |
| `unifiedNotepad-handler.ts` | `chatPanel-handler.ts` |

### Files to Delete

| File | Reason |
|------|--------|
| `src/managers/todoManager.ts` | Replaced by `TodoProvider` |

### Key Metrics

| Metric | Before | After |
|--------|--------|-------|
| Command prefix variants | 4 (`DS:`, `DartScript:`, `Tom AI:`, none) | 2 (`@T:`, none for context menus) |
| Extension ID | `dartscript-vscode` | `tom-ai-extension` |
| Config systems | 4 (workspaceState, YAML, JSON config, direct JSON) | 2 (workspaceState for UI state, YAML for everything else) |
| Trail systems | 3 independent | 1 (`TrailService`) |
| Trail types | Mixed | 2 (Raw, Summary) |
| Todo systems | 3 incompatible | 1 (`TodoProvider`) |
| Inline ensureDir patterns | 54 | 0 |
| Inline config reads | 15 | 0 |
| Hardcoded Ollama URLs | 9 | 0 |
| LM tool prefix variants | 3 (`tom_`, `dartscript_`, camelCase) | 1 (`tomAi_`) |
| Magic numbers | 30+ | 0 (centralized in constants + optionally configurable) |
