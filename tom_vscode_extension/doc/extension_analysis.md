# @Tom VS Code Extension — Architecture Analysis

**Extension:** `tom-ai-extension` v0.1.0  
**Entry Point:** `src/extension.ts`  
**Config File:** `.tom/tom_vscode_extension.json`

> Note: This document reflects the current canonical `tomAi.*` namespace. Legacy `tomAi.*` identifiers may still appear in source as compatibility aliases.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Activation Flow](#2-activation-flow)
3. [Source File Inventory](#3-source-file-inventory)
4. [Explorer Sidebar Views](#4-explorer-sidebar-views)
5. [Bottom Panel Views](#5-bottom-panel-views)
6. [Custom Editors](#6-custom-editors)
7. [Standalone Webview Panels](#7-standalone-webview-panels)
8. [Commands](#8-commands)
9. [Chord Menus & Keybindings](#9-chord-menus--keybindings)
10. [Reusable UI Components](#10-reusable-ui-components)
11. [Manager Singletons](#11-manager-singletons)
12. [LM Tools & Chat Variables](#12-lm-tools--chat-variables)
13. [Bridge & Telegram Communication](#13-bridge--telegram-communication)
14. [Timed Requests & Prompt Queue](#14-timed-requests--prompt-queue)
15. [Configuration System](#15-configuration-system)
16. [Filename Patterns](#16-filename-patterns)
17. [Dependency Map](#17-dependency-map)

---

## 1. High-Level Architecture

```mermaid
graph TB
    subgraph "VS Code Extension Host"
        EXT["extension.ts<br/>Activation & Registration"]
        
        subgraph "UI Layer"
            EXP["Explorer Sidebar<br/>7 webview views"]
            T2["@CHAT Bottom Panel<br/>Accordion notepad"]
            T3["@WS Bottom Panel<br/>Accordion: Tasks/Logs/Settings/Issues/Tests/QuestTodo"]
            CE["Custom Editors<br/>YAML Graph, Quest TODO, Trail Viewer"]
            WP["Standalone Webview Panels<br/>6 editors + Status Page"]
        end
        
        subgraph "Command Layer"
            CMD["74 Commands"]
            CHORD["6 Chord Menus"]
            SM["State Machines"]
            COMB["Combined Commands"]
        end
        
        subgraph "Manager Layer"
            CVS["ChatVariablesStore"]
            PQM["PromptQueueManager"]
            TE["TimerEngine"]
            RS["ReminderSystem"]
            QTM["QuestTodoManager"]
            WSTS["WindowSessionTodoStore"]
            TM["TodoManager"]
        end
        
        subgraph "Tool Layer"
            LMT["47 Language Model Tools"]
            CVR["5 Chat Variable Resolvers"]
            STR["SharedToolRegistry"]
            ESC["Escalation Tools Config"]
        end
        
        subgraph "Infrastructure"
            BRIDGE["DartBridgeClient<br/>JSON-RPC over stdin/stdout"]
            TELE["Telegram Subsystem<br/>Bot API + Command Registry"]
            TRAIL["Trail Logger<br/>Timestamped files"]
            PT["Prompt Template Engine<br/>Variable resolution"]
        end
        
        subgraph "Utilities"
            WP_U["WsPaths<br/>Central path registry"]
            PD["ProjectDetector"]
            VR["VariableResolver"]
            STC["SendToChatConfig"]
            PYS["PanelYamlStore"]
            ER["ExecutableResolver"]
            DL["DebugLogger"]
        end
    end
    
    subgraph "External"
        DART["Dart Bridge Process"]
        OLLAMA["Ollama Server"]
        GH["GitHub API"]
        TGAPI["Telegram Bot API"]
        COPILOT["VS Code Copilot"]
        LMAPI["VS Code LM API"]
    end
    
    EXT --> CMD & CHORD & SM & COMB
    EXT --> EXP & T2 & T3 & CE & WP
    EXT --> CVS & PQM & TE & RS
    EXT --> LMT & CVR
    
    T2 --> PT & TRAIL
    T3 --> QTM & WSTS
    
    CMD --> BRIDGE & TELE & TRAIL
    LMT --> STR
    
    BRIDGE --> DART
    TELE --> TGAPI
    LMT --> OLLAMA
    LMT --> COPILOT
    LMT --> LMAPI
    CMD --> GH
```

---

## 2. Activation Flow

```mermaid
flowchart TD
    A["Extension Activates"] --> B["Init Debug Logger"]
    B --> C["Install Global Instrumentation<br/>(wrap registerCommand, registerWebviewViewProvider)"]
    C --> D{"`.tom/` folder exists?"}
    
    D -->|No| MIN["MINIMAL MODE<br/>registerCommands (basic)<br/>registerChordMenuCommands<br/>registerCombinedCommands<br/>registerStateMachineCommands<br/>registerMinimalModePanels"]
    
    D -->|Yes| E["FULL MODE"]
    E --> F["Initialize Bridge Client"]
    F --> G["Register Commands (35)"]
    G --> H["Register Chord Menus (6)"]
    H --> I["Register Commandline Commands"]
    I --> J["Register Combined Commands"]
    J --> K["Register State Machine Commands"]
    K --> L["Register DS Notes Views (12 sidebar views)"]
    L --> M["Register Unified Notepad (@CHAT panel)"]
    M --> N["Register T3 Panel (@WS panel)"]
    N --> O["Register Editor Commands<br/>(ChatVars, Context, Template,<br/>Reusable, Queue, Timed)"]
    O --> P["Register Custom Editors<br/>(YAML Graph, Quest TODO, Trail)"]
    P --> Q["Register Trail Viewer Commands"]
    Q --> R["Register TODO Log View"]
    R --> S["Auto-start Bridge"]
    S --> T["Auto-start CLI Server (if configured)"]
    T --> U["Auto-start Telegram (if configured)"]
    U --> V["Init SendToChatAdvancedManager"]
    V --> W["Init PromptExpanderManager<br/>Register Local LLM context menu cmds"]
    W --> X["Init BotConversationManager"]
    X --> Y["Init ChatVariablesStore<br/>Init WindowSessionTodoStore"]
    Y --> Z["Init PromptQueueManager<br/>Init TimerEngine<br/>Init ReminderSystem"]
    Z --> AA["Register LM Tools (47)<br/>Initialize Tool Descriptions"]
    AA --> AB["Register Chat Variable Resolvers (5)"]
```

---

## 3. Source File Inventory

**81 TypeScript files** organized as:

| Directory | Count | Purpose |
|-----------|-------|---------|
| `src/` | 3 | Entry point, bridge client, tests |
| `src/handlers/` | 59 | UI panels, commands, editors, templates, telegram |
| `src/handlers/chat/` | 3 | Chat channel abstraction (interface + Telegram impl) |
| `src/managers/` | 7 | State singletons (queue, timer, todos, variables) |
| `src/tools/` | 6 | LM tool definitions and registration |
| `src/utils/` | 7 | Shared utilities (paths, config, resolver, logging) |

### Handler Files by Size (lines)

| File | Lines | Purpose |
|------|-------|---------|
| `unifiedNotepad-handler.ts` | 4162 | T2 @CHAT accordion panel |
| `questTodoPanel-handler.ts` | 3806 | Quest/session todo panel (embeddable) |
| `dsNotes-handler.ts` | 3416 | 12 sidebar webview providers |
| `statusPage-handler.ts` | 2741 | Status page + embedded status HTML |
| `botConversation-handler.ts` | 2246 | Multi-turn AI conversation orchestrator |
| `expandPrompt-handler.ts` | 1884 | Local LLM prompt expansion |
| `issuesPanel-handler.ts` | 1636 | GitHub issues panel (embeddable) |
| `queueEditor-handler.ts` | 1473 | Prompt queue webview editor |
| `timedRequestsEditor-handler.ts` | 1257 | Timed requests webview editor |
| `trailViewer-handler.ts` | 1210 | Trail viewer commands & exchange parser |
| `tomAiChat-handler.ts` | 1203 | Tom AI Chat (VS Code LM API) |
| `t3Panel-handler.ts` | 1094 | T3 @WS accordion panel |
| `globalTemplateEditor-handler.ts` | 1061 | Prompt template editor |
| `trailEditor-handler.ts` | 1014 | Trail custom editor for consolidated files |
| `handler_shared.ts` | 956 | Shared utilities (bridge, config, templates) |
| `reusablePromptEditor-handler.ts` | 935 | Reusable prompt .md editor |
| `commandline-handler.ts` | 929 | Custom CLI commandlines |
| `sendToChatAdvanced-handler.ts` | 848 | Template-based send-to-chat |
| `contextSettingsEditor-handler.ts` | 742 | Context & settings webview editor |

### Manager Files

| File | Lines | Purpose |
|------|-------|---------|
| `promptQueueManager.ts` | 933 | Ordered prompt queue with auto-send |
| `questTodoManager.ts` | 923 | CST-preserving YAML todo CRUD |
| `timerEngine.ts` | 422 | Timed/scheduled request firing |
| `chatVariablesStore.ts` | 238 | Chat variable state singleton |
| `reminderSystem.ts` | 253 | Response timeout reminders |
| `todoManager.ts` | 230 | Per-chat-session scratch todos |
| `windowSessionTodoStore.ts` | 207 | Window-scoped session todos |

### Tool Files

| File | Lines | Purpose |
|------|-------|---------|
| `chat-enhancement-tools.ts` | 1643 | 31 chat enhancement LM tools |
| `tool-executors.ts` | 1240 | 17 core tool implementations |
| `escalation-tools-config.ts` | 296 | Ask Copilot / Ask Big Brother config |
| `shared-tool-registry.ts` | 130 | Unified tool definition interface |
| `chatVariableResolvers.ts` | 97 | 5 chat variable resolvers |
| `tomAiChat-tools.ts` | 36 | VS Code LM tool registration wrapper |

### Utility Files

| File | Lines | Purpose |
|------|-------|---------|
| `workspacePaths.ts` | — | Central path registry (`WsPaths`) |
| `variableResolver.ts` | — | Template variable resolution |
| `sendToChatConfig.ts` | — | Config loading & `SendToChatConfig` class |
| `projectDetector.ts` | — | Workspace project scanning |
| `panelYamlStore.ts` | — | YAML persistence for panel state |
| `executableResolver.ts` | — | Binary path resolution |
| `debugLogger.ts` | — | Console/output channel logging |

---

## 4. Explorer Sidebar Views

All registered in `tomAi-explorer` view container.

```mermaid
graph LR
    subgraph "Explorer Sidebar"
        A["VS CODE NOTES<br/>tomAi.tomNotepad"]
        B["QUEST NOTES<br/>tomAi.questNotesView"]
        C["QUEST TODOS<br/>tomAi.questTodosView"]
        D["SESSION TODOS<br/>tomAi.sessionTodosView"]
        E["TODO LOG<br/>tomAi.todoLogView"]
        F["WORKSPACE NOTES<br/>tomAi.workspaceNotepad"]
        G["WORKSPACE TODOS<br/>tomAi.workspaceTodosView"]
    end
```

| View ID | Name | Handler File | Icon | Description |
|---------|------|-------------|------|-------------|
| `tomAi.tomNotepad` | VS CODE NOTES | `dsNotes-handler.ts` | `$(note)` | Persistent scratch pad with template support |
| `tomAi.questNotesView` | QUEST NOTES | `dsNotes-handler.ts` | `$(book)` | Quest-specific markdown notes file |
| `tomAi.questTodosView` | QUEST TODOS | `dsNotes-handler.ts` + `questTodoPanel-handler.ts` | `$(checklist)` | Quest todo YAML editor |
| `tomAi.sessionTodosView` | SESSION TODOS | `dsNotes-handler.ts` + `questTodoPanel-handler.ts` | `$(clock)` | Window-scoped session todos |
| `tomAi.todoLogView` | TODO LOG | `todoLogPanel-handler.ts` | `$(history)` | Trail exchanges referencing todos |
| `tomAi.workspaceNotepad` | WORKSPACE NOTES | `dsNotes-handler.ts` | `$(file-text)` | Workspace-level markdown notes |
| `tomAi.workspaceTodosView` | WORKSPACE TODOS | `dsNotes-handler.ts` + `questTodoPanel-handler.ts` | `$(tasklist)` | Workspace-level todo YAML |

### Additional DS Notes Views (registered but used inside panels)

| View ID | Name | Used In | Purpose |
|---------|------|---------|---------|
| `tomAi.guidelinesNotepad` | Guidelines | @WS panel | Browse `_copilot_guidelines/` |
| `tomAi.notesNotepad` | Documentation | @WS panel | Project documentation |
| `tomAi.localLlmNotepad` | Local LLM | @CHAT panel | Ollama prompt interface |
| `tomAi.conversationNotepad` | AI Conversation | @CHAT panel | Multi-turn conversation |
| `tomAi.copilotNotepad` | Copilot | @CHAT panel | Copilot integration |
| `tomAi.tomAiChatNotepad` | Tom AI Chat | @CHAT panel | Tom AI chat interface |

---

## 5. Bottom Panel Views

### @CHAT Panel (`tomAi.chatPanel`)

```mermaid
graph TB
    subgraph "@CHAT Panel - tomAi-chat-panel"
        direction TB
        T2["Unified Notepad<br/>unifiedNotepad-handler.ts<br/>4162 lines"]
        
        subgraph "Accordion Sections"
            S1["Local LLM<br/>codicon-robot"]
            S2["AI Conversation<br/>codicon-comment-discussion"]
            S3["Copilot<br/>codicon-copilot"]
            S4["Tom AI Chat<br/>codicon-comment-discussion-sparkle"]
        end
        
        T2 --> S1 & S2 & S3 & S4
    end
```

**Handler:** `unifiedNotepad-handler.ts` (4162 lines)  
**View ID:** `tomAi.chatPanel`  
**Key features:**
- Accordion layout with collapsible sections
- Each section has a text area + template picker + send button
- Writes prompt trail files to `_ai/trail/`
- Writes consolidated trail to quest folder
- Manages answer file watching
- Draft persistence via `workspaceState`

### @WS Panel (`tomAi.wsPanel`)

```mermaid
graph TB
    subgraph "@WS Panel - tomAi-ws-panel"
        direction TB
        T3["T3 Panel Handler<br/>t3Panel-handler.ts<br/>1094 lines"]
        
        subgraph "Accordion Sections"
            W1["Guidelines<br/>book"]
            W2["Documentation<br/>note"]
            W3["Logs<br/>output"]
            W4["Settings<br/>settings-gear"]
            W5["Issues<br/>issues"]
            W6["Tests<br/>beaker"]
            W7["Quest TODO<br/>tasklist"]
        end
        
        T3 --> W1 & W2 & W3 & W4 & W5 & W6 & W7
    end
```

**Handler:** `t3Panel-handler.ts` (1094 lines)  
**View ID:** `tomAi.wsPanel`  
**Key features:**
- Composes embedded fragments from: `issuesPanel-handler`, `questTodoPanel-handler`, `statusPage-handler`
- Guidelines browser for `_copilot_guidelines/`
- Embedded status page settings
- GitHub issues CRUD
- Quest todo management

---

## 6. Custom Editors

File-bound editors that open automatically for matching file patterns.

| viewType | displayName | File Patterns | Priority | Handler |
|----------|-------------|---------------|----------|---------|
| `yamlGraph.editor` | YAML Graph Editor | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | default | `yamlGraph-handler.ts` |
| `questTodo.editor` | Quest TODO Editor | `*.todo.yaml` | option | `questTodoEditor-handler.ts` |
| `trailViewer.editor` | Trail Viewer | `*.prompts.md`, `*.answers.md` | default | `trailEditor-handler.ts` |

```mermaid
graph LR
    subgraph "Custom Editors"
        YG["YAML Graph Editor<br/>yamlGraph-handler.ts"]
        QT["Quest TODO Editor<br/>questTodoEditor-handler.ts"]
        TV["Trail Viewer<br/>trailEditor-handler.ts"]
    end
    
    F1["*.flow.yaml<br/>*.state.yaml<br/>*.er.yaml"] --> YG
    F2["*.todo.yaml"] --> QT
    F3["*.prompts.md<br/>*.answers.md"] --> TV
    
    YG --> YGC["yaml-graph-core<br/>yaml-graph-vscode"]
    QT --> QTP["questTodoPanel-handler<br/>(reuses HTML/CSS/JS)"]
    TV --> TVH["trailEditor-handler<br/>Consolidated timeline"]
```

---

## 7. Standalone Webview Panels

Command-opened panels (not file-bound).

| Panel | viewType | Command | Handler |
|-------|----------|---------|---------|
| Status Page | `tomStatusPage` | `tomAi.statusPage` | `statusPage-handler.ts` |
| Prompt Trail Viewer | `tomAi.trailViewer` | `tomAi.editor.rawTrailViewer` | `trailViewer-handler.ts` |
| Prompt Queue | `tomAi.queueEditor` | `tomAi.editor.promptQueue` | `queueEditor-handler.ts` |
| Timed Requests | `tomAi.timedRequestsEditor` | `tomAi.editor.timedRequests` | `timedRequestsEditor-handler.ts` |
| Prompt Template Editor | `tomAi.globalTemplateEditor` | `tomAi.editor.promptTemplates` | `globalTemplateEditor-handler.ts` |
| Reusable Prompt Editor | `tomAi.reusablePromptEditor` | `tomAi.editor.reusablePrompts` | `reusablePromptEditor-handler.ts` |
| Context & Settings | `tomAi.contextSettingsEditor` | `tomAi.editor.contextSettings` | `contextSettingsEditor-handler.ts` |
| Chat Variables | `chatVariablesEditor` | `tomAi.editor.chatVariables` | `chatVariablesEditor-handler.ts` |
| Quest TODO Pop-out | `questTodoEditor` | Pop-out from sidebar | `questTodoEditor-handler.ts` |
| Markdown Preview | `tomAiMarkdownHtmlPreview` | Internal | `markdownHtmlPreview.ts` |

---

## 8. Commands

### All 74 Registered Commands

#### Script Execution (2)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.executeFile` | DS: Execute File | `executeInTomAiBuild-handler.ts` |
| `tomAi.executeScript` | DS: Execute as Script | `executeAsScript-handler.ts` |

#### Send to Copilot Chat (12)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.sendToCopilot` | DS: Send to Copilot Chat | `sendToChat-handler.ts` |
| `tomAi.sendToCopilot.standard` | DS: Send to Copilot Chat (Standard) | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.template` | DS: Send to Copilot Chat (Template)... | `sendToChatAdvanced-handler.ts` |
| `tomAi.reloadConfig` | DS: Reload Chat Config | `extension.ts` (inline) |
| `tomAi.sendToCopilot.trailReminder` | Send with Trail Reminder | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.todoExecution` | TODO Execution | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.codeReview` | Code Review | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.explain` | Explain Code | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.addToTodo` | Add to Todo | `sendToChatAdvanced-handler.ts` |
| `tomAi.sendToCopilot.fixMarkdown` | Fix Markdown here | `sendToChatAdvanced-handler.ts` |
| `tomAi.showAnswerValues` | DS: Show chat answer values | `handler_shared.ts` |
| `tomAi.clearAnswerValues` | DS: Clear chat answer values | `handler_shared.ts` |

#### Bridge & Infrastructure (7)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.bridge.restart` | DS: Restart Bridge | `restartBridge-handler.ts` |
| `tomAi.bridge.switchProfile` | DS: Switch Tom AI Bridge Profile... | `restartBridge-handler.ts` |
| `tomAi.reloadWindow` | DS: Reload Window | `reloadWindow-handler.ts` |
| `tomAi.bridge.toggleDebug` | DS: Toggle Bridge Debug Logging | `debugLogging-handler.ts` |
| `tomAi.printConfiguration` | @T: Print Configuration | `printConfiguration-handler.ts` |
| `tomAi.showHelp` | DS: Show Extension Help | `showHelp-handler.ts` |
| `tomAi.showApiInfo` | @T: Show VS Code API Info | `showApiInfo-handler.ts` |

#### CLI Server & Process Monitor (4)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.cliServer.start` | DS: Start Tom CLI Integration Server | `cliServer-handler.ts` |
| `tomAi.cliServer.startCustomPort` | DS: Start Tom CLI Integration Server (Custom Port) | `cliServer-handler.ts` |
| `tomAi.cliServer.stop` | DS: Stop Tom CLI Integration Server | `cliServer-handler.ts` |
| `tomAi.startProcessMonitor` | DS: Start Tom Process Monitor | `processMonitor-handler.ts` |

#### Tom AI Chat (3)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.tomAiChat.start` | Tom AI: Start Chat | `tomAiChat-handler.ts` |
| `tomAi.tomAiChat.send` | Tom AI: Send Chat Prompt | `tomAiChat-handler.ts` |
| `tomAi.tomAiChat.interrupt` | Tom AI: Interrupt Chat | `tomAiChat-handler.ts` |

#### Local LLM / Ollama (9)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.sendToLocalLlm` | DS: Expand Prompt (Ollama) | `expandPrompt-handler.ts` |
| `tomAi.localLlm.switchModel` | DS: Change local Ollama model... | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.default` | DS: Send to local LLM | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.template` | DS: Send to local LLM (Template)... | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.standard` | DS: Send to local LLM (Standard) | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.expand` | Expand Prompt | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.rewrite` | Rewrite | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.detailed` | Detailed Expansion | `expandPrompt-handler.ts` |
| `tomAi.sendToLocalLlm.annotated` | Annotated Expansion | `expandPrompt-handler.ts` |

#### Bot Conversation (5)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.aiConversation.start` | DS: Start Local-Copilot Conversation | `botConversation-handler.ts` |
| `tomAi.aiConversation.stop` | DS: Stop Local-Copilot Conversation | `botConversation-handler.ts` |
| `tomAi.aiConversation.halt` | DS: Halt Local-Copilot Conversation | `botConversation-handler.ts` |
| `tomAi.aiConversation.continue` | DS: Continue Local-Copilot Conversation | `botConversation-handler.ts` |
| `tomAi.aiConversation.add` | DS: Add to Local-Copilot Conversation | `botConversation-handler.ts` |

#### Chord Menus (6)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.chordMenu.aiConversation` | DS: Conversation Shortcuts... | `chordMenu-handler.ts` |
| `tomAi.chordMenu.localLlm` | DS: Local LLM Shortcuts... | `chordMenu-handler.ts` |
| `tomAi.chordMenu.copilot` | DS: Send to Chat Shortcuts... | `chordMenu-handler.ts` |
| `tomAi.chordMenu.tomAiChat` | DS: Tom AI Chat Shortcuts... | `chordMenu-handler.ts` |
| `tomAi.chordMenu.execute` | DS: Execute Shortcuts... | `chordMenu-handler.ts` |
| `tomAi.chordMenu.favorites` | DS: Favorites... | `chordMenu-handler.ts` |

#### Telegram (3)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.telegram.testConnection` | DS: Telegram Test Connection | `telegram-commands.ts` |
| `tomAi.telegram.toggle` | DS: Telegram Start/Stop Polling | `telegram-commands.ts` |
| `tomAi.telegram.configure` | DS: Configure Telegram... | `telegram-commands.ts` |

#### Layout & Window Management (8)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.combined.maximizeExplorer` | DS: Maximize Explorer | `combinedCommand-handler.ts` |
| `tomAi.combined.maximizeEditor` | DS: Maximize Editor | `combinedCommand-handler.ts` |
| `tomAi.combined.maximizeChat` | DS: Maximize Chat | `combinedCommand-handler.ts` |
| `tomAi.combined.maximizeToggle` | DS: Maximize Toggle | `combinedCommand-handler.ts` |
| `tomAi.stateMachine.vsWindowStateFlow` | DS: Window Panel State Flow | `stateMachine-handler.ts` |
| `tomAi.resetMultiCommandState` | DS: Reset All State Machine States | `stateMachine-handler.ts` |
| `tomAi.focusTomAi` | DS: Focus Tom AI Panel | `extension.ts` |
| `tomAi.combined.showSideNotes` | DS: Show Side Notes | `combinedCommand-handler.ts` |

#### Commandline (4)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.commandline.add` | DS: Add Commandline | `commandline-handler.ts` |
| `tomAi.commandline.delete` | DS: Delete Commandline | `commandline-handler.ts` |
| `tomAi.commandline.execute` | DS: Execute Commandline | `commandline-handler.ts` |
| `tomAi.openConfig` | DS: Open Config File | `commandline-handler.ts` |

#### Trail & Status (3)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.trail.toggle` | DS: Toggle AI Trail Logging | `statusPage-handler.ts` |
| `tomAi.statusPage` | DS: Extension Status Page | `statusPage-handler.ts` |
| `tomAi.openSettings` | DS: Open Extension Settings | `extension.ts` (inline) |

#### Webview Editors (8)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.editor.chatVariables` | DS: Open Chat Variables Editor | `chatVariablesEditor-handler.ts` |
| `tomAi.editor.promptQueue` | DS: Open Prompt Queue Editor | `queueEditor-handler.ts` |
| `tomAi.editor.timedRequests` | DS: Open Timed Requests Editor | `timedRequestsEditor-handler.ts` |
| `tomAi.editor.contextSettings` | DS: Open Context & Settings Editor | `contextSettingsEditor-handler.ts` |
| `tomAi.editor.promptTemplates` | DS: Open Prompt Template Editor | `globalTemplateEditor-handler.ts` |
| `tomAi.editor.reusablePrompts` | DS: Open Reusable Prompt Editor | `reusablePromptEditor-handler.ts` |
| `tomAi.editor.rawTrailViewer` | DS: Open Prompt Trail Viewer | `trailViewer-handler.ts` |
| `tomAi.editor.summaryTrailViewer` | DS: Open Trail Viewer (Select Folder) | `trailViewer-handler.ts` |

#### Other Commands (4)

| Command ID | Title | Handler |
|------------|-------|---------|
| `tomAi.runTests` | DS: Run Tests | `runTests-handler.ts` |
| `tomAi.showQuickReference` | DS: Show Quick Reference | `chordMenu-handler.ts` |
| `tomAi.openInExternalApp` | DS: Open in External Application | `extension.ts` (inline) |
| `tomAi.openInMdViewer` | DS: Open in MD Viewer | `extension.ts` (inline) |

---

## 9. Chord Menus & Keybindings

### Keybindings

| Key | Command | Description |
|-----|---------|-------------|
| `Ctrl+Shift+C` | `tomAi.chordMenu.aiConversation` | Conversation shortcuts |
| `Ctrl+Shift+L` | `tomAi.chordMenu.localLlm` | Local LLM shortcuts |
| `Ctrl+Shift+A` | `tomAi.chordMenu.copilot` | Send to Chat shortcuts |
| `Ctrl+Shift+T` | `tomAi.chordMenu.tomAiChat` | Tom AI Chat shortcuts |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute shortcuts |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites |
| `Ctrl+Shift+\` | `tomAi.combined.maximizeToggle` | Maximize toggle |
| `Ctrl+Shift+2` | `tomAi.combined.maximizeExplorer` | Maximize explorer |
| `Ctrl+Shift+3` | `tomAi.combined.maximizeEditor` | Maximize editor |
| `Ctrl+Shift+4` | `tomAi.combined.maximizeChat` | Maximize chat |
| `Ctrl+Shift+0` | `tomAi.focusTomAi` | Focus @CHAT panel |
| `Ctrl+Shift+Y` | `tomAi.stateMachine.vsWindowStateFlow` | Window state flow |
| `Ctrl+Shift+8` | `tomAi.statusPage` | Status page |
| `Ctrl+Shift+9` | `tomAi.wsPanel.focus` | Focus @WS panel |
| `Ctrl+Shift+N` | `tomAi.combined.showSideNotes` | Show side notes |

### Unbindings (overridden VS Code defaults)

| Key | Original Command | Replaced By |
|-----|-----------------|-------------|
| `Ctrl+Shift+C` | `workbench.action.terminal.openNativeConsole` | Conversation chord |
| `Ctrl+Shift+X` | `workbench.view.extensions` | Favorites chord |
| `Ctrl+Shift+N` | `workbench.action.newWindow` | Show side notes |

---

## 10. Reusable UI Components

| Component | File | Exports | Used By |
|-----------|------|---------|---------|
| Accordion Panel | `accordionPanel.ts` | `getAccordionHtml()`, `getAccordionStyles()`, `getAccordionScript()` | @CHAT panel, @WS panel |
| Tab Panel | `tabPanel.ts` | `getTabPanelHtml()`, `getTabPanelStyles()`, `getTabPanelScript()` | Various panels |
| Markdown Preview | `markdownHtmlPreview.ts` | `showMarkdownHtmlPreview()` | Trail viewer, notes, reusable prompts |
| Prompt Template | `promptTemplate.ts` | `resolveTemplate()`, `expandTemplate()`, `formatDateTime()` | All send-to-chat, LLM, conversation |
| Variable Resolver | `variableResolver.ts` | Variable resolution engine | Template system |

---

## 11. Manager Singletons

```mermaid
graph TB
    subgraph "State Managers"
        CVS["ChatVariablesStore<br/>quest, role, projects, todo<br/>Persistence: workspaceState"]
        PQM["PromptQueueManager<br/>Ordered prompt queue<br/>Persistence: YAML"]
        TE["TimerEngine<br/>Timed/scheduled requests<br/>Persistence: YAML"]
        RS["ReminderSystem<br/>Response timeout reminders<br/>Persistence: JSON config"]
        QTM["QuestTodoManager<br/>Quest YAML todo CRUD<br/>Persistence: *.todo.yaml"]
        WSTS["WindowSessionTodoStore<br/>Ephemeral session todos<br/>Persistence: YAML"]
        TM["TodoManager<br/>Per-chat scratch todos<br/>Persistence: JSON"]
    end
    
    PQM -->|"sends to"| CVS
    TE -->|"fires into"| PQM
    RS -->|"monitors"| PQM
    WSTS -->|"delegates to"| QTM
    
    PQM -->|"queue.panel.yaml"| PYS["PanelYamlStore"]
    TE -->|"timed.panel.yaml"| PYS
```

| Manager | Singleton | Init Method | Persistence | Key |
|---------|-----------|-------------|-------------|-----|
| `ChatVariablesStore` | Yes | `init(context)` | `workspaceState` | `chatVariablesStore` |
| `PromptQueueManager` | Yes | `init(ctx)` | YAML via `panelYamlStore` | `_ai/tom_ai_chat/queue.panel.yaml` |
| `TimerEngine` | Yes | `init(ctx)` | YAML via `panelYamlStore` | `_ai/tom_ai_chat/timed.panel.yaml` |
| `ReminderSystem` | Yes | `init(ctx)` | JSON config | `reminderTemplates`, `reminderConfig` |
| `QuestTodoManager` | No (pure functions) | — | YAML files | `_ai/quests/*/todos.*.todo.yaml` |
| `WindowSessionTodoStore` | Yes | `init(context, windowId)` | YAML (via QuestTodoManager) | `_ai/quests/*/YYYYMMDD_HHMM_*.todo.yaml` |
| `TodoManager` | No (per-session) | `new TodoManager()` | JSON | `_ai/tom_ai_chat/*.todos.json` |

---

## 12. LM Tools & Chat Variables

### Language Model Tools (47 total)

```mermaid
graph TB
    subgraph "Tool Registration"
        REG["tomAiChat-tools.ts<br/>registerTomAiChatTools()"]
    end
    
    subgraph "Tool Definitions"
        TE_D["tool-executors.ts<br/>17 core tools"]
        CE_D["chat-enhancement-tools.ts<br/>31 chat tools"]
    end
    
    subgraph "Shared Infrastructure"
        STR["shared-tool-registry.ts<br/>SharedToolDefinition interface"]
        ESC["escalation-tools-config.ts<br/>Ask Copilot / Big Brother config"]
    end
    
    REG --> TE_D & CE_D
    TE_D --> STR
    CE_D --> STR
    TE_D --> ESC
```

#### Core Tools (17 in `tool-executors.ts`)

| Tool Name | Category | Read-Only | Description |
|-----------|----------|-----------|-------------|
| `tom_readFile` | Files | ✓ | Read file contents |
| `tom_createFile` | Files | ✗ | Create new file |
| `tom_editFile` | Files | ✗ | Edit existing file |
| `tom_multiEditFile` | Files | ✗ | Multiple file edits |
| `tom_listDirectory` | Files | ✓ | List directory contents |
| `tom_findFiles` | Search | ✓ | Find files by glob |
| `tom_findTextInFiles` | Search | ✓ | Grep text in files |
| `tom_runCommand` | Terminal | ✗ | Run shell command |
| `tom_runVscodeCommand` | VS Code | ✗ | Execute VS Code command |
| `tom_getErrors` | Diagnostics | ✓ | Get VS Code diagnostics |
| `tom_fetchWebpage` | Web | ✓ | Fetch URL content |
| `tom_webSearch` | Web | ✓ | Web search |
| `tom_readGuideline` | Guidelines | ✓ | Read from `_copilot_tomai/` |
| `tom_readLocalGuideline` | Guidelines | ✓ | Read from `_copilot_local/` |
| `tom_manageTodo` | Todo | ✗ | Manage scratch todos |
| `tom_askBigBrother` | Escalation | ✓ | Ask a more powerful model |
| `tom_askCopilot` | Escalation | ✓ | Escalate to VS Code Copilot |

#### Chat Enhancement Tools (31 in `chat-enhancement-tools.ts`)

| Tool Name | Category | Description |
|-----------|----------|-------------|
| `tomAi_notifyUser` | Notification | Send Telegram or VS Code notification |
| `tomAi_getWorkspaceInfo` | Workspace | Get workspace and quest context |
| `tomAi_listTodos` | Quest Todo | List all quest todos |
| `tomAi_getAllTodos` | Quest Todo | List quest + session todos |
| `tomAi_getTodo` | Quest Todo | Get specific todo by ID |
| `tomAi_createTodo` | Quest Todo | Create new quest todo |
| `tomAi_updateTodo` | Quest Todo | Update existing quest todo |
| `tomAi_moveTodo` | Quest Todo | Move todo between files |
| `tomAi_windowTodo_add` | Session Todo | Add session todo |
| `tomAi_windowTodo_list` | Session Todo | List session todos |
| `tomAi_windowTodo_getAll` | Session Todo | Get all session todos |
| `tomAi_windowTodo_update` | Session Todo | Update session todo |
| `tomAi_windowTodo_delete` | Session Todo | Delete session todo |
| `addToPromptQueue` | Queue | Add prompt to queue |
| `addFollowUpPrompt` | Queue | Add follow-up prompt |
| `sendQueuedPrompt` | Queue | Send next queued prompt |
| `addTimedRequest` | Timed | Add timed request |
| `tom_queue_list` | Queue | List queue items |
| `tom_queue_update_item` | Queue | Update queue item |
| `tom_queue_set_status` | Queue | Set item status |
| `tom_queue_send_now` | Queue | Send item immediately |
| `tom_queue_remove_item` | Queue | Remove from queue |
| `tom_queue_update_followup` | Queue | Update follow-up |
| `tom_queue_remove_followup` | Queue | Remove follow-up |
| `tom_timed_list` | Timed | List timed entries |
| `tom_timed_update_entry` | Timed | Update timed entry |
| `tom_timed_remove_entry` | Timed | Remove timed entry |
| `tom_timed_set_engine_state` | Timed | Enable/disable timer |
| `tom_prompt_template_manage` | Templates | CRUD prompt templates |
| `tom_reminder_template_manage` | Templates | CRUD reminder templates |

### Chat Variable Resolvers (5)

| Variable | Resolver ID | Source |
|----------|-------------|--------|
| `#quest` | `tomAi.quest` | `ChatVariablesStore.quest` |
| `#role` | `tomAi.role` | `ChatVariablesStore.role` |
| `#activeProjects` | `tomAi.activeProjects` | `ChatVariablesStore.activeProjects` |
| `#todo` | `tomAi.todo` | `ChatVariablesStore.todo` |
| `#workspaceName` | `tomAi.workspaceName` | Workspace folder name |

---

## 13. Bridge & Telegram Communication

### Dart Bridge

```mermaid
sequenceDiagram
    participant EXT as VS Code Extension
    participant BRIDGE as DartBridgeClient
    participant DART as Dart Process
    
    EXT->>BRIDGE: startWithAutoRestart(path, cmd, args)
    BRIDGE->>DART: spawn child process
    
    EXT->>BRIDGE: sendRequest(method, params)
    BRIDGE->>DART: JSON-RPC request (stdin)
    DART-->>BRIDGE: JSON-RPC response (stdout)
    BRIDGE-->>EXT: Promise<result>
    
    DART-->>BRIDGE: notification (stdout)
    BRIDGE-->>EXT: onNotification event
    
    Note over BRIDGE,DART: Auto-restart on exit
    Note over BRIDGE,DART: 30s request timeout
```

**File:** `vscode-bridge.ts` (1056 lines)  
**Protocol:** JSON-RPC 2.0 over stdin/stdout with length-prefixed messages  
**Bridge commands used:** `executeFileVcb`, `executeScriptVcb`, `startCliServer`, `stopCliServer`, `startProcessMonitor`, `setDebugLogging`, `getDebugLogging`, `printConfiguration`, `notifyReload`

### Telegram Subsystem

```mermaid
graph TB
    subgraph "Telegram Integration"
        TC["telegram-commands.ts<br/>3 VS Code commands"]
        TN["telegram-notifier.ts<br/>TelegramNotifier class"]
        TCP["telegram-cmd-parser.ts<br/>Command registry + parser"]
        TCH["telegram-cmd-handlers.ts<br/>Bot command implementations"]
        TCR["telegram-cmd-response.ts<br/>Response formatter"]
        TM["telegram-markdown.ts<br/>MarkdownV2 conversion"]
    end
    
    subgraph "Chat Abstraction"
        CC["chat-channel.ts<br/>ChatChannel interface"]
        TCH2["telegram-channel.ts<br/>TelegramChannel impl"]
    end
    
    TC --> TN & TCP & TCH & TCR
    TN --> CC
    TCH2 --> CC
    TCR --> TM
    
    TCH2 -->|"HTTPS"| TGAPI["Telegram Bot API"]
```

**Telegram bot commands:** help, ls, cd, cwd, project, dart analyze, problems, todos, bk, tk, bridge, cli-integration, status, stop

---

## 14. Timed Requests & Prompt Queue

```mermaid
sequenceDiagram
    participant USER as User / LLM Tool
    participant TE as TimerEngine
    participant PQM as PromptQueueManager
    participant RS as ReminderSystem
    participant COPILOT as VS Code Copilot
    
    Note over TE: 30s tick interval
    TE->>TE: Check schedule slots
    TE->>PQM: enqueue(timedPrompt)
    
    USER->>PQM: enqueue(prompt)
    PQM->>PQM: Check autoSend
    PQM->>COPILOT: Send to Chat API
    PQM->>PQM: Watch answer file
    
    Note over RS: 30s check interval
    RS->>PQM: Check pending items
    alt Timeout exceeded
        RS->>PQM: enqueue(reminderPrompt)
    end
    
    COPILOT-->>PQM: Answer file written
    PQM->>PQM: Process follow-ups
    PQM->>COPILOT: Send follow-up
```

### Persistence

| Component | Format | File Path |
|-----------|--------|-----------|
| Prompt Queue | YAML | `_ai/tom_ai_chat/queue.panel.yaml` |
| Timed Requests | YAML | `_ai/tom_ai_chat/timed.panel.yaml` |
| Reminder Config | JSON | In main config file (`reminderTemplates`, `reminderConfig`) |

---

## 15. Configuration System

### Config File Resolution

```mermaid
flowchart TD
    A["getConfigPath()"] --> B{"Workspace<br/>.tom/tom_vscode_extension.json<br/>exists?"}
    B -->|Yes| C["Use workspace config"]
    B -->|No| D{"VS Code setting<br/>tomAi.configPath<br/>set?"}
    D -->|Yes| E["Use configured path"]
    D -->|No| F["Use ~/.tom/vscode/<br/>tom_vscode_extension.json"]
```

### JSON Config Sections

| Section Key | Purpose | Used By |
|-------------|---------|---------|
| `templates` | Copilot prompt templates | dsNotes, sendToChatAdvanced, globalTemplateEditor |
| `defaultTemplates.<panel>` | Per-panel default template | handler_shared |
| `reminderTemplates` | Reminder prompt templates | reminderSystem, globalTemplateEditor |
| `reminderConfig` | Reminder timeout settings | reminderSystem |
| `promptExpander` | Local LLM config (profiles, models, settings) | expandPrompt-handler |
| `promptExpander.profiles` | Named LLM profiles | expandPrompt-handler, dsNotes |
| `promptExpander.models` | Available model configs | expandPrompt-handler |
| `promptExpander.llmConfigurations` | LLM configuration presets | dsNotes |
| `botConversation.profiles` | Conversation profiles | botConversation-handler, dsNotes |
| `botConversation.selfTalk` | Self-talk profiles | globalTemplateEditor |
| `botConversation.telegram` | Telegram bot config | telegram-commands |
| `botConversation.conversationMode` | Default mode | dsNotes |
| `tomAiChat.templates` | Tom AI Chat templates | dsNotes |
| `timedRequests` | Timed request entries | timedRequestsEditor (legacy) |
| `trail` | Trail logging config | trailLogger-handler |
| `trail.paths.*` | Per-subsystem trail paths | trailLogger-handler |
| `tomAiBridge` | Bridge profiles & settings | restartBridge-handler |
| `combinedCommands` | Multi-command sequences | combinedCommand-handler |
| `stateMachineCommands` | State machine definitions | stateMachine-handler |
| `commandlines` | Custom CLI commands | commandline-handler |
| `favorites` | Favorites chord items | chordMenu-handler |
| `executables` | Named executable paths | executableResolver, commandline-handler |
| `externalApplications` | File→app associations | handler_shared |
| `issueKit` | Issue tracking config | issuesPanel-handler |
| `testkit` | Test results config | issuesPanel-handler |
| `copilotChatAnswerFolder` | Answer file folder | sendToChatConfig |
| `copilotAnswerPath` | Full answer file path | sendToChatConfig |
| `localLlmTools.askCopilot` | Escalation tool config | escalation-tools-config |
| `localLlmTools.askBigBrother` | Escalation tool config | escalation-tools-config |
| `binaryPath` | Legacy binary path | sendToChatConfig |
| `todoPanel` | Todo panel config | sendToChatConfig |
| `cliServerAutostart` | Auto-start CLI server | extension.ts |
| `telegramAutostart` | Auto-start Telegram | extension.ts |
| `trailCleanupDays` | Trail cleanup period | sendToChatConfig |
| `trailMaxEntries` | Max trail entries | sendToChatConfig |
| `aiConversationSetups` | AI conversation presets | dsNotes |
| `llmConfigurations` | LLM configuration presets | dsNotes |

### VS Code Settings (`tomAi.*`)

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `tomAi.contextApproach` | enum | `"accumulation"` | Context persistence mode |
| `tomAi.maxContextSize` | number | `50000` | Max context tokens |
| `tomAi.autoRunOnSave` | boolean | `false` | Auto-run on save |
| `tomAi.copilotModel` | enum | `"gpt-4o"` | Preferred Copilot model |
| `tomAi.configPath` | string | `"~/.tom/vscode/tom_vscode_extension.json"` | Config file path |
| `tomAi.sendToChat.showNotifications` | boolean | `true` | Chat send notifications |
| `tomAi.sendToChat.chatAnswerFolder` | string | `"_ai/chat_replies"` | Chat answer folder |
| `tomAi.tomAiChat.modelId` | string | `"gpt-5.2"` | Tom AI Chat model |
| `tomAi.tomAiChat.tokenModelId` | string | `"gpt-4o"` | Token counting model |
| `tomAi.tomAiChat.responsesTokenLimit` | number | `50000` | Response token limit |
| `tomAi.tomAiChat.responseSummaryTokenLimit` | number | `8000` | Summary token limit |
| `tomAi.tomAiChat.preProcessingModelId` | string | `"gpt-5-mini"` | Pre-processing model |
| `tomAi.tomAiChat.enablePromptOptimization` | boolean | `false` | Enable pre-processing |
| `tomAi.ollama.url` | string | `"http://localhost:11434"` | Ollama server URL |
| `tomAi.ollama.model` | string | `"qwen3:8b"` | Ollama model name |
| `tomAi.notes.workspaceTodoFile` | string | `"workspace.todo.yaml"` | Workspace todo file |
| `tomAi.notes.questNotesFilePattern` | string | `"_ai/quests/${quest}/quest-notes.${quest}.md"` | Quest notes pattern |
| `tomAi.notes.questTodoFilePattern` | string | `"todos.${quest}.todo.yaml"` | Quest todo pattern |
| `tomAi.guidelines.excludeGlobs` | array | `["tom/zom_*/**"]` | Guidelines exclude globs |
| `tomAi.projectDetection.excludeGlobs` | array | `["tom/zom_*/**"]` | Project detection excludes |

### Workspace State Keys

| Key | Type | Purpose |
|-----|------|---------|
| `tomAi.dsNotes.localLlmDraft` | string | Local LLM notepad draft |
| `tomAi.dsNotes.localLlmProfile` | string | Selected LLM profile |
| `tomAi.dsNotes.localLlmModel` | string | Selected LLM model |
| `tomAi.dsNotes.conversationDraft` | string | Conversation notepad draft |
| `tomAi.dsNotes.conversationProfile` | string | Selected conversation profile |
| `tomAi.dsNotes.conversationLlmProfileA` | string | LLM profile A |
| `tomAi.dsNotes.conversationLlmProfileB` | string | LLM profile B |
| `tomAi.dsNotes.copilotDraft` | string | Copilot notepad draft |
| `tomAi.dsNotes.copilotTemplate` | string | Selected Copilot template |
| `tomAi.dsNotes.tomAiChatDraft` | string | Tom AI Chat draft |
| `tomAi.dsNotes.tomAiChatTemplate` | string | Selected Tom AI template |
| `tomAi.dsNotes.notes` | string | Notes storage |
| `tomAi.dsNotes.tomNotepad` | string | VS Code Notes content |
| `tomAi.dsNotes.tomNotepadTemplate` | string | VS Code Notes template |
| `tomAi.dsNotes.activeNoteFile` | string | Active note file ID |
| `tomAi.dsNotes.workspaceNotepadTemplate` | string | Workspace notepad template |
| `tomAi.dsNotes.questNotesTemplate` | string | Quest notes template |
| `WorkspaceNotepadProvider.STORAGE_KEY` | string | Workspace notepad file path |
| `llmSelectedConfig` | string | Selected LLM configuration |
| `conversationAiSetup` | string | Selected AI conversation setup |
| `qt.panelState` | object | Quest todo panel state |
| `qt.pendingSelect` | object | Pending todo selection |
| `tomAi.queueEditor.collapsedItemIds` | array | Queue editor collapsed state |
| `tomAi.timedEditor.collapsedEntryIds` | array | Timed editor collapsed state |
| `trailEditor.pendingFocus` | object | Pending trail focus |
| `chatVariablesStore` | object | Chat variables snapshot |
| `copilotAutoHideDelay` | number | Copilot auto-hide delay |

### Environment Variables

| Variable | File | Purpose |
|----------|------|---------|
| `process.env.HOME` / `process.env.USERPROFILE` | `dsNotes-handler.ts` | Global notes path |
| `process.env.TOM_USER` | `questTodoPanel-handler.ts` | User identity override |
| `${env.VARNAME}` template | `variableResolver.ts` | Generic env var lookup |
| `vscode.env.sessionId` | `variableResolver.ts` | Window/session ID |
| `vscode.env.machineId` | `variableResolver.ts` | Machine ID |

---

## 16. Filename Patterns

### Trail Files — Individual Exchange Files

Written to `_ai/trail/` folder.

| Pattern | Extension | Purpose |
|---------|-----------|---------|
| `YYYYMMDD_HHMMSSmmm_prompt_<requestId>` | `.userprompt.md` | Individual user prompt |
| `YYYYMMDD_HHMMSSmmm_answer_<requestId>` | `.answer.json` | Individual answer |

**Parsing regex (new format):**
```
/^(\d{8}_\d{9})_(prompt|answer)_([^.]+)\.(userprompt\.md|answer\.json)$/
```

**Parsing regex (legacy format):**
```
/^(\d{8}_\d{6})_([^.]+)\.(userprompt|answer)\.md$/
```

### Trail Files — Consolidated Files

Written to quest folder or `_ai/trail/`.

| Pattern | Purpose |
|---------|---------|
| `<prefix>.prompts.md` | Consolidated prompts (current) |
| `<prefix>.answers.md` | Consolidated answers (current) |
| `<prefix>_prompts.md` | Consolidated prompts (legacy) |
| `<prefix>_answers.md` | Consolidated answers (legacy) |

Where `<prefix>` = quest ID from workspace filename, or `'default'`.

### Trail Logger Files — Step-Level Logging

Written to subsystem-specific trail folders.

| Pattern | Extension | Purpose |
|---------|-----------|---------|
| `YYYYMMDD_HHMMSS_NNN_prompt_to_<model>` | `.md` | Prompt sent |
| `YYYYMMDD_HHMMSS_NNN_response_partial_from_<model>` | `.md` | Partial response |
| `YYYYMMDD_HHMMSS_NNN_response_final_from_<model>` | `.md` | Final response |
| `YYYYMMDD_HHMMSS_NNN_toolrequest_<toolname>` | `.json` | Tool request |
| `YYYYMMDD_HHMMSS_NNN_toolresult_<toolname>` | `.json` | Tool result |
| `YYYYMMDD_HHMMSS_NNN_continuation_to_<model>` | `.md` | Continuation |
| `YYYYMMDD_HHMMSS_NNN_copilot_answer` | `.json` | Copilot answer |
| `YYYYMMDD_HHMMSS_NNN_error` | `.md` | Error details |

**Subsystem trail folders (configurable via `trail.paths.*`):**

| Subsystem | Default Path |
|-----------|--------------|
| Local LLM | `_ai/local/trail/` |
| Bot Conversation | `_ai/conversation/trail/` |
| Tom AI Chat | `_ai/tomai/trail/` |
| Copilot | `_ai/copilot/trail/` |
| Escalation | `_ai/trail/escalation/<trailId>/` |

### Answer Files

| Pattern | Location | Purpose |
|---------|----------|---------|
| `<windowId>_answer.json` | `_ai/answers/copilot/` | Copilot answer file |
| `<sessionId>_<machineId>_answer.json` | `_ai/chat_replies/` | Queue answer polling |

### Todo Files

| Pattern | Location | Purpose |
|---------|----------|---------|
| `workspace.todo.yaml` | Workspace root | Workspace-level todos |
| `todos.<quest>.todo.yaml` | `_ai/quests/<quest>/` | Quest todos |
| `YYYYMMDD_HHMM_<windowId>.todo.yaml` | `_ai/quests/<quest>/` | Session todos |
| `<chatId>.todos.json` | `_ai/tom_ai_chat/` | Per-chat scratch todos |

### Panel YAML Files

| Pattern | Location | Purpose |
|---------|----------|---------|
| `queue.panel.yaml` | `_ai/tom_ai_chat/` | Prompt queue state |
| `timed.panel.yaml` | `_ai/tom_ai_chat/` | Timed requests state |

### Chat Files

| Pattern | Location | Purpose |
|---------|----------|---------|
| `chat_YYYYMMDD.chat.md` | `_ai/tom_ai_chat/` | Tom AI Chat session |
| `chat_trail.md` | `_ai/local/` | Local LLM chat trail |

### Other File Patterns

| Pattern | Location | Purpose |
|---------|----------|---------|
| `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | Any | YAML Graph Editor |
| `*.todo.yaml` | Any | Quest TODO Editor |
| `*.prompts.md`, `*.answers.md` | Any | Trail Viewer Editor |
| `*.prompt.md` | `_ai/prompt/`, `{project}/prompt/` | Reusable prompts |
| `.github/copilot-instructions.md` | Workspace root | System prompt source |
| `global_notes.md` | `~/.tom/notes/` | Global notes file |
| `~/.vscode-tom-test-reinstall` | Home | Reinstall marker |

### Glob Patterns

| Glob | File | Purpose |
|------|------|---------|
| `_ai/quests/**/*.todo.yaml` | `workspacePaths.ts` | Find all quest todos |
| `_copilot_guidelines/**/*.md` | `workspacePaths.ts` | Find all guidelines |

---

## 17. Dependency Map

### Handler → Handler Dependencies

```mermaid
graph LR
    HS["handler_shared"] --> PT["promptTemplate"]
    HS --> VR["variableResolver"]
    HS --> WP["workspacePaths"]
    HS --> ER["executableResolver"]
    HS --> STC["sendToChatConfig"]
    HS --> DL["debugLogger"]
    
    UN["unifiedNotepad"] --> HS & PT & AP & MHP & WP & STC & PD & GTE & RPE & DL
    DN["dsNotes"] --> HS & PT & EP & GTE & TL & MHP & WST & QTP & WP
    T3["t3Panel"] --> AP & IP & QTP & SP & WP & PD & MHP & HS
    
    QTP["questTodoPanel"] --> CVS & QTM & WST & WP & HS & PT & STC
    
    EP["expandPrompt"] --> HS & PT & TL & STR & TEX & WP
    BC["botConversation"] --> HS & STC & PT & EP & TN & TL & WP
    SAM["sendToChatAdvanced"] --> HS & TL & PT
    TAC["tomAiChat"] --> TAU & TM & TAT & WP & TL
    
    IP["issuesPanel"] --> ISP & GIP & HS & WP
    GIP["githubIssueProvider"] --> ISP & GA & WP
    
    SP["statusPage"] --> HS & CS & RB & TL & TC & ESC & WP & STC & CL
    
    AP["accordionPanel"]
    MHP["markdownHtmlPreview"]
    
    subgraph "Telegram"
        TC["telegram-commands"] --> TN & TCP & TCR & TCH
        TN["telegram-notifier"] --> CC["chat-channel"]
        TCH["telegram-cmd-handlers"] --> TCP & TM2["telegram-markdown"] & PD
        TCR["telegram-cmd-response"] --> CC & TCP & TM2
        TCH2["telegram-channel"] --> CC & TN & TM2
    end
    
    subgraph "Managers"
        CVS["chatVariablesStore"]
        PQM["promptQueueManager"] --> PT & HS & PYS & WP
        TE2["timerEngine"] --> PQM & PYS
        RS["reminderSystem"] --> HS & PQM
        QTM["questTodoManager"] --> WP & PD
        WST["windowSessionTodoStore"] --> QTM & WP
        TM["todoManager"]
    end
    
    subgraph "Tools"
        TAT["tomAiChat-tools"] --> STR & TEX
        TEX["tool-executors"] --> STR & ESC & CET & TM & HS & PT & DL
        CET["chat-enhancement-tools"] --> CVS & WST & QTM & PQM & TE2 & RS & HS & QTP & WP
        STR["shared-tool-registry"]
        ESC["escalation-tools-config"] --> HS & WP & DL
        CVR["chatVariableResolvers"] --> CVS
    end
    
    subgraph "Utilities"
        WP["workspacePaths"]
        VR
        STC
        PD["projectDetector"]
        PYS["panelYamlStore"]
        ER
        DL
    end
```

### Central Path Registry (`WsPaths`)

| Logical Key | Relative Path | Used For |
|-------------|---------------|----------|
| `quests` | `_ai/quests` | Quest folders |
| `roles` | `_ai/roles` | AI role definitions |
| `notes` | `_ai/notes` | Notes storage |
| `local` | `_ai/local` | Local LLM files |
| `schemas` | `_ai/schemas/yaml` | YAML schemas |
| `copilot` | `_ai/copilot` | Copilot files |
| `tomAiChat` | `_ai/tom_ai_chat` | Tom AI Chat files |
| `chatReplies` | `_ai/chat_replies` | Chat reply files |
| `botConversations` | `_ai/bot_conversations` | Conversation logs |
| `attachments` | `_ai/attachments` | File attachments |
| `answersCopilot` | `_ai/answers/copilot` | Copilot answer files |
| `trailLocal` | `_ai/local/trail` | Local LLM trail |
| `trailConversation` | `_ai/conversation/trail` | Conversation trail |
| `trailTomai` | `_ai/tomai/trail` | Tom AI Chat trail |
| `trailCopilot` | `_ai/copilot/trail` | Copilot trail |

---

## Summary Statistics

| Category | Count |
|----------|-------|
| TypeScript source files | 81 |
| Total source lines (approx.) | ~45,000 |
| VS Code commands | 74 |
| Explorer sidebar views | 7 |
| Bottom panel views | 2 |
| Panel sections (accordion) | 11 |
| Custom editors | 3 |
| Standalone webview panels | 10 |
| Manager singletons | 6 (+1 per-session) |
| Language model tools | 47 |
| Chat variable resolvers | 5 |
| VS Code settings | 20 |
| JSON config sections | 35+ |
| Workspace state keys | 25+ |
| Keybindings | 15 |
| File patterns (read/write) | 30+ |
| Handler files | 59 |

---

## 18. Naming Inconsistencies Audit

### 18.1 Command Title Prefixes

Commands in `contributes.commands` use **four different prefix conventions**:

| Prefix | Count | Examples |
|--------|-------|----------|
| `@T:` | ~45 | `DS: Execute File`, `DS: Send to Copilot Chat`, `DS: Restart Bridge` |
| `@T:` | 2 | `@T: Print Configuration`, `@T: Show VS Code API Info` |
| `Tom AI:` | 3 | `Tom AI: Start Chat`, `Tom AI: Send Chat Prompt`, `Tom AI: Interrupt Chat` |
| No prefix | 7 | `Send with Trail Reminder`, `TODO Execution`, `Code Review`, `Explain Code`, `Add to Todo`, `Fix Markdown here`, `Expand Prompt`, `Rewrite`, `Detailed Expansion`, `Annotated Expansion` |

**Issues:**
- `@T:` and `@T:` are two different prefixes for the same extension — should be unified
- `Tom AI:` is a third brand used only for the Tom AI Chat subsystem
- Several submenu commands (`Send with Trail Reminder`, `TODO Execution`, `Code Review`, etc.) have no prefix at all — inconsistent with the rest
- The local LLM submenu items (`Expand Prompt`, `Rewrite`, `Detailed Expansion`, `Annotated Expansion`) also have no prefix

### 18.2 Confusing / Similar Command Title Pairs

| Command A | Command B | Confusion Risk |
|-----------|-----------|----------------|
| `DS: Send to Copilot Chat` | `DS: Send to Copilot Chat (Standard)` | Unclear difference |
| `DS: Send to Copilot Chat (Template)...` | `DS: Send to Copilot Chat (Standard)` | "Template" vs "Standard" meaningless to users |
| `DS: Send to local LLM` | `DS: Send to local LLM (Standard)` | Same confusion as above |
| `DS: Send to local LLM (Template)...` | `DS: Send to local LLM (Standard)` | Same pattern |
| `DS: Expand Prompt (Ollama)` | `DS: Send to local LLM` | Both send to local LLM — different naming |
| `DS: Open Prompt Queue Editor` | `DS: Open Prompt Template Editor` | Both abbreviate differently |
| `DS: Open Reusable Prompt Editor` | `DS: Open Prompt Template Editor` | Unclear distinction |
| `DS: Start Tom CLI Integration Server` | `DS: Start Tom Process Monitor` | CLI Server vs Process Monitor — user won't know the difference |
| `DS: Show Extension Help` | `DS: Show Quick Reference` | Help vs Quick Reference — redundant? |

### 18.3 Titles That Don't Describe Functionality

| Command ID | Title | Problem |
|------------|-------|---------|
| `tomAi.sendToCopilot.trailReminder` | `Send with Trail Reminder` | No prefix, vague — "send what? where?" |
| `tomAi.sendToCopilot.todoExecution` | `TODO Execution` | No context that it sends to chat |
| `tomAi.sendToCopilot.codeReview` | `Code Review` | No indication it sends to Copilot |
| `tomAi.sendToCopilot.explain` | `Explain Code` | Same issue |
| `tomAi.sendToCopilot.addToTodo` | `Add to Todo` | Sounds like it adds a todo, not sends to chat |
| `tomAi.sendToCopilot.fixMarkdown` | `Fix Markdown here` | Informal, inconsistent casing |
| `tomAi.showAnswerValues` | `DS: Show chat answer values` | Lowercase "chat answer values" — inconsistent with other titles |
| `tomAi.clearAnswerValues` | `DS: Clear chat answer values` | Same casing issue |
| `tomAi.combined.showSideNotes` | `DS: Show Side Notes` | Unclear what "Side Notes" are |
| `tomAi.focusTomAi` | `DS: Focus Tom AI Panel` | Legacy `DS:` prefix inconsistent with Tom AI branding |

### 18.4 View/Panel Naming Inconsistencies

| ID | Name | Issue |
|----|------|-------|
| `tomAi-chat-panel` | `@CHAT` | Cryptic `t2` ID; `@CHAT` uses `@` prefix |
| `tomAi-ws-panel` | `@WS` | Cryptic `t3` ID; `@WS` uses `@` prefix |
| `tomAi.chatPanel` | `@CHAT` | Redundant — same label as container |
| `tomAi.wsPanel` | `@WS` | Redundant — same label as container |
| `tomAi.tomNotepad` | `VS CODE NOTES` | ID says "notepad", name says "NOTES" — the `tom` prefix is also inconsistent with `tomAi` prefix |
| `tomAi.questNotesView` | `QUEST NOTES` | Consistent |
| `tomAi.questTodosView` | `QUEST TODOS` | Consistent |
| `tomAi.sessionTodosView` | `SESSION TODOS` | Consistent |
| `tomAi.todoLogView` | `TODO LOG` | Consistent |
| `tomAi.workspaceNotepad` | `WORKSPACE NOTES` | ID says "notepad", name says "NOTES" |
| `tomAi.workspaceTodosView` | `WORKSPACE TODOS` | Consistent |

**View naming issues:**
- `@CHAT` and `@WS` use `@` prefix but nothing else does — these are the bottom panel containers
- `tomNotepad` and `workspaceNotepad` IDs use "notepad" but display names use "NOTES"
- The `t2` / `t3` internal naming convention in panel container IDs is cryptic

### 18.5 LM Tool Name Prefixes (languageModelTools)

Tools use **five different naming conventions**:

| Prefix/Convention | Count | Examples |
|-------------------|-------|----------|
| `tom_` (snake_case) | 22 | `tom_createFile`, `tom_readFile`, `tom_editFile`, `tom_queue_list`, `tom_timed_list`, `tom_askBigBrother`, `tom_askCopilot` |
| `tomAi_` (snake_case) | 11 | `tomAi_notifyUser`, `tomAi_getWorkspaceInfo`, `tomAi_listTodos`, `tomAi_windowTodo_add` |
| `camelCase` (no prefix) | 4 | `addToPromptQueue`, `addFollowUpPrompt`, `sendQueuedPrompt`, `addTimedRequest` |
| `determineQuest` (no prefix, source only) | 1 | Not in package.json but registered in code |
| `tom_` mixed casing | — | `tom_askBigBrother` uses camelCase after `tom_`, but `tom_queue_list` uses snake_case |

**Specific issues:**
- `tom_` tools use **mixed casing**: `tom_readFile` (camelCase) vs `tom_queue_list` (snake_case) vs `tom_askBigBrother` (camelCase)
- `tomAi_` tools also mix: `tomAi_notifyUser` (camelCase) vs `tomAi_windowTodo_add` (mixed)
- **4 tools have no prefix at all**: `addToPromptQueue`, `addFollowUpPrompt`, `sendQueuedPrompt`, `addTimedRequest`
- `determineQuest` exists in source code ([chat-enhancement-tools.ts](src/tools/chat-enhancement-tools.ts#L183)) but not in package.json `languageModelTools`

### 18.6 Tool `name` vs `toolReferenceName` Mismatches

Some tools have matching name/reference, others diverge wildly:

| `name` | `toolReferenceName` | Consistent? |
|---------|---------------------|-------------|
| `tom_createFile` | `tom_createFile` | Yes |
| `tom_readFile` | `tom_readFile` | Yes |
| `tom_manageTodo` | `manageScratchTodos` | **No** — completely different name |
| `tomAi_listTodos` | `listAllQuestTodos` | **No** — prefix dropped, name changed |
| `tomAi_getAllTodos` | `listAllQuestAndSessionTodos` | **No** — prefix dropped, verbose |
| `tomAi_getTodo` | `getQuestTodoById` | **No** — prefix dropped |
| `tomAi_createTodo` | `createQuestTodo` | **No** — prefix dropped |
| `tomAi_updateTodo` | `updateQuestTodo` | **No** — prefix dropped |
| `tomAi_moveTodo` | `moveQuestTodo` | **No** — prefix dropped |
| `tomAi_windowTodo_add` | `addSessionTodo` | **No** — completely different naming |
| `tomAi_windowTodo_list` | `listSessionTodos` | **No** |
| `tomAi_windowTodo_getAll` | `getAllSessionTodos` | **No** |
| `tomAi_windowTodo_update` | `updateSessionTodo` | **No** |
| `tomAi_windowTodo_delete` | `deleteSessionTodo` | **No** |
| `tomAi_notifyUser` | `tomAi_notifyUser` | Yes |
| `tomAi_getWorkspaceInfo` | `tomAi_getWorkspaceInfo` | Yes |
| `addToPromptQueue` | `addToPromptQueue` | Yes (but no prefix) |
| `tom_queue_list` | `tom_queue_list` | Yes |

**Pattern:** `tom_` tools tend to keep consistent names. `tomAi_` tools almost always have divergent reference names.

### 18.7 Hardcoded Directory Paths Bypassing workspacePaths.ts

Despite `WsPaths` being the central registry, many files still have hardcoded fallback paths:

| File | Hardcoded Path | Should Use |
|------|----------------|------------|
| [questTodoManager.ts](src/managers/questTodoManager.ts#L82) | `'_ai', 'quests', questId` | `WsPaths.ai('quests', questId)` only |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L129) | `'_ai', 'schemas', 'yaml'` | `WsPaths.ai('schemas')` |
| [questTodoManager.ts](src/managers/questTodoManager.ts#L665) | `'_ai/'` string check | `WsPaths.aiFolder` |
| [windowSessionTodoStore.ts](src/managers/windowSessionTodoStore.ts#L110) | `'_ai', 'quests'` fallback | Already uses WsPaths but duplicates fallback |
| [panelYamlStore.ts](src/utils/panelYamlStore.ts#L47) | `'_ai', 'local'` | `WsPaths.ai('local')` only |
| [variableResolver.ts](src/utils/variableResolver.ts#L219) | `'.tom', 'vscode'` | `WsPaths.home('vscodeConfig')` |
| [variableResolver.ts](src/utils/variableResolver.ts#L245) | `'_ai/chat_replies'` | `WsPaths.aiRelative('chatReplies')` |
| [variableResolver.ts](src/utils/variableResolver.ts#L255) | `'.tom', 'chat_replies'` | `WsPaths.home('chatReplies')` |
| [executableResolver.ts](src/utils/executableResolver.ts#L235) | `'.tom', 'bin'` | Missing from WsPaths |
| [extension.ts](src/extension.ts#L233) | `'.tom'` | `WsPaths.wsConfigFolder` |
| [tool-executors.ts](src/tools/tool-executors.ts#L449) | `'_copilot_tomai'` | Should be in `WsPaths` |
| [tool-executors.ts](src/tools/tool-executors.ts#L460) | `'_copilot_local'` | Should be in `WsPaths` |
| [botConversation-handler.ts](src/handlers/botConversation-handler.ts#L664) | `'_ai', 'trail', 'ai_conversation'` | `WsPaths.ai(...)` |
| [trailEditor-handler.ts](src/handlers/trailEditor-handler.ts#L242) | `'_ai', 'quests'` | `WsPaths.ai('quests')` |
| [unifiedNotepad-handler.ts](src/handlers/unifiedNotepad-handler.ts) | Multiple `'_ai'` fallbacks | Remove redundant fallbacks |
| [issuesPanel-handler.ts](src/handlers/issuesPanel-handler.ts) | `'_ai', 'attachments'` fallbacks | `WsPaths.ai('attachments')` only |
| [trailViewer-handler.ts](src/handlers/trailViewer-handler.ts#L330) | `'_ai/trail'` | `WsPaths.aiRelative('trail')` |

**Missing from WsPaths constants:**
- `_copilot_tomai` folder (Copilot guideline folder)
- `_copilot_local` folder (local LLM guideline folder)
- `~/.tom/bin/` (binary directory)
- `prompt` subfolder in AI_SUBPATHS
- `trail` top-level subfolder (only `trailLocal`, `trailConversation`, etc. exist)

### 18.8 Inconsistent Naming Patterns in Source Code

#### "sendToChat" vs "sendToCopilot" vs "sendToLocalLlm"

| Pattern | Usage | Files |
|---------|-------|-------|
| `sendToChat` | Primary pattern for Copilot Chat | `sendToChat-handler.ts`, `sendToChatAdvanced-handler.ts`, `sendToChatConfig.ts`, commands in package.json |
| `sendToCopilot` | Not used in code (never appears) | — |
| `sendToLocalLlm` | Pattern for local Ollama LLM | Commands in package.json, `expandPrompt-handler.ts` |

The function is "send to Copilot Chat" but the code and config section name is `sendToChat` — the Copilot brand only appears in the command *title*, not the code.

#### "botConversation" vs "conversation" vs "aiConversation"

| Pattern | Where | Context |
|---------|-------|---------|
| `botConversation` | `botConversation-handler.ts`, config section `botConversation`, commands `startBotConversation`/`stopBotConversation`/etc. | Primary pattern — local+Copilot automated conversation loop |
| `conversation` | Command titles: `DS: Start Local-Copilot Conversation`, `DS: Conversation Shortcuts...` | Display name — shorter form |
| `aiConversation` | Not found in code | — |
| `ai_conversation` | Trail folder path: `_ai/trail/ai_conversation` | Only in trail paths |

The code uses `botConversation` internally but `Local-Copilot Conversation` in UX and `ai_conversation` in trail paths — three different names for the same subsystem.

#### "promptExpander" vs "localLlm" vs "ollama"

| Pattern | Where | Context |
|---------|-------|---------|
| `promptExpander` | Config section `promptExpander`, `PromptExpanderManager` class, status page | Original name — Ollama-backed prompt expansion |
| `localLlm` | Commands `sendToLocalLlm*`, chord menu `chordMenu.llm`, menu groups `localLlm@0` | Newer generalized name |
| `ollama` | VS Code settings `tomAi.ollama.url`, `tomAi.ollama.model`; command title `DS: Expand Prompt (Ollama)`, `DS: Change local Ollama model...` | Specific product name |

Three different names for the same underlying system: the config calls it `promptExpander`, the commands call it `localLlm`, and individual settings/titles mention `ollama` explicitly.

### 18.9 Extension Identity Crisis

The extension has **multiple brand names** used in different places:

| Brand | Where Used |
|-------|------------|
| `tom-ai-extension` | Package name in `package.json` |
| `@Tom` | `displayName`, `category` for all commands, settings `configuration.title` |
| `@T:` | Command title prefix (80% of commands) |
| `@T:` | Command title prefix (2 commands) |
| `Tom AI:` | Command title prefix (3 commands) |
| `Tom` | Internal tool names (`tom_*`), config paths (`~/.tom/`) |
| `@CHAT`, `@WS` | Panel names (no brand prefix) |

**Summary:** The extension is called "@Tom" externally but half the internals use "Tom" naming. This reflects that "@Tom" was the original scripting focus, while "Tom" is the broader workspace platform name. The two brands collide in command titles, tool names, and panel labels.
