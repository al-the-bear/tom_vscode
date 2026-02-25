# DartScript Extension Quick Reference

## Bottom Panels

- `@CHAT` → `dartscript.chatPanel`
- `@WS` → `dartscript.wsPanel`

## Keybindings

### Panel & Layout

| Key | Command | Description |
|-----|---------|-------------|
| `Ctrl+Shift+0` | `dartscript.focusTomAI` | Focus `@CHAT` panel |
| `Ctrl+Shift+9` | `dartscript.wsPanel.focus` | Focus `@WS` panel |
| `Ctrl+Shift+8` | `dartscript.showStatusPage` | Open status page |
| `Ctrl+Shift+Y` | `dartscript.stateMachine.vsWindowStateFlow` | Window state flow |
| `Ctrl+Shift+N` | `dartscript.combined.showSideNotes` | Show side notes |
| `Ctrl+Shift+\` | `dartscript.combined.maximizeToggle` | Maximize toggle |
| `Ctrl+Shift+2` | `dartscript.combined.maximizeExplorer` | Maximize explorer |
| `Ctrl+Shift+3` | `dartscript.combined.maximizeEditor` | Maximize editor |
| `Ctrl+Shift+4` | `dartscript.combined.maximizeChat` | Maximize chat |

### Chord Menus

| Key | Command | Description |
|-----|---------|-------------|
| `Ctrl+Shift+C` | `dartscript.chordMenu.conversation` | Conversation menu |
| `Ctrl+Shift+L` | `dartscript.chordMenu.llm` | Local LLM menu |
| `Ctrl+Shift+A` | `dartscript.chordMenu.chat` | Send-to-chat menu |
| `Ctrl+Shift+T` | `dartscript.chordMenu.tomAiChat` | Tom AI chat menu |
| `Ctrl+Shift+E` | `dartscript.chordMenu.execute` | Execute menu |
| `Ctrl+Shift+X` | `dartscript.chordMenu.favorites` | Favorites menu |

## Explorer Views

- VS CODE NOTES
- QUEST NOTES
- QUEST TODOS
- SESSION TODOS
- WORKSPACE NOTES
- WORKSPACE TODOS

## Core AI Commands

- `dartscript.sendToChat`
- `dartscript.sendToChatStandard`
- `dartscript.sendToChatAdvanced`
- `dartscript.startTomAIChat`
- `dartscript.sendToTomAIChat`
- `dartscript.interruptTomAIChat`
- `dartscript.sendToLocalLlm`
- `dartscript.sendToLocalLlmAdvanced`

## Bridge and Runtime Commands

- `dartscript.restartBridge`
- `dartscript.switchBridgeProfile`
- `dartscript.startCliServer`
- `dartscript.stopCliServer`
- `dartscript.startProcessMonitor`

## Utility Commands

- `dartscript.showStatusPage`
- `dartscript.showQuickReference`
- `dartscript.openConfig`
- `dartscript.openExtensionSettings`

## Custom Editors (file-bound)

| Editor | View Type | File Patterns | Priority |
|--------|-----------|---------------|----------|
| YAML Graph Editor | `yamlGraph.editor` | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | default |
| Quest TODO Editor | `questTodo.editor` | `*.todo.yaml` | option |
| Trail Viewer | `trailViewer.editor` | `*.prompts.md`, `*.answers.md` | default |

## Standalone Webview Panels (command-opened)

| Panel | View Type | Opened Via |
|-------|-----------|------------|
| Status Page | `tomStatusPage` | `dartscript.showStatusPage` |
| Prompt Trail Viewer | `dartscript.trailViewer` | `dartscript.openTrailViewer` |
| Prompt Queue | `dartscript.queueEditor` | `dartscript.openQueueEditor` |
| Timed Requests | `dartscript.timedRequestsEditor` | `dartscript.openTimedRequestsEditor` |
| Prompt Template Editor | `dartscript.globalTemplateEditor` | `dartscript.openGlobalTemplateEditor` |
| Reusable Prompt Editor | `dartscript.reusablePromptEditor` | `dartscript.openReusablePromptEditor` |
| Context & Settings | `dartscript.contextSettingsEditor` | `dartscript.openContextSettingsEditor` |
| Chat Variables | `chatVariablesEditor` | `dartscript.openChatVariablesEditor` |
| Quest TODO Pop-out | `questTodoEditor` | Pop-out from sidebar |
| Markdown Preview | `dartscriptMarkdownHtmlPreview` | Internal preview |

## Bottom Panel Sub-sections

### @CHAT (`dartscript.chatPanel`)

| Section | Icon | Description |
|---------|------|-------------|
| Local LLM | `codicon-robot` | Send prompts to local Ollama model |
| AI Conversation | `codicon-comment-discussion` | Multi-turn AI conversation |
| Copilot | `codicon-copilot` | Copilot integration |
| Tom AI Chat | `codicon-comment-discussion-sparkle` | Tom AI chat interface |

### @WS (`dartscript.wsPanel`)

| Section | Icon | Description |
|---------|------|-------------|
| Guidelines | `book` | Copilot guidelines browser |
| Documentation | `note` | Project documentation |
| Logs | `output` | Extension logs |
| Settings | `settings-gear` | Embedded status page and configuration |
| Issues | `issues` | Issue tracking |
| Tests | `beaker` | Test results |
| Quest TODO | `tasklist` | Quest todo list |
