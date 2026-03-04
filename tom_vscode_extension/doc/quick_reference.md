# @Tom Extension Quick Reference

## Bottom Panels

- `@CHAT` → `tomAi.chatPanel`
- `@WS` → `tomAi.wsPanel`

## Keybindings

### Panel & Layout

| Key | Command | Description |
|-----|---------|-------------|
| `Ctrl+Shift+0` | `tomAi.focusChatPanel` | Focus `@CHAT` panel |
| `Ctrl+Shift+9` | `tomAi.wsPanel.focus` | Focus `@WS` panel |
| `Ctrl+Shift+8` | `tomAi.statusPage` | Open status page |
| `Ctrl+Shift+7` | `tomAi.editor.timedRequests` | Open timed requests editor |
| `Ctrl+Shift+6` | `tomAi.editor.promptQueue` | Open prompt queue editor |
| `Ctrl+Shift+5` | `tomAi.editor.rawTrailViewer` | Open raw trail viewer |
| `Ctrl+Shift+Y` | `tomAi.layout.windowStateFlow` | Window state flow |
| `Ctrl+Shift+N` | `tomAi.showSidebarNotes` | Show sidebar notes |
| `Ctrl+Shift+\` | `tomAi.layout.maximizeToggle` | Maximize toggle |
| `Ctrl+Shift+2` | `tomAi.layout.maximizeExplorer` | Maximize explorer |
| `Ctrl+Shift+3` | `tomAi.layout.maximizeEditor` | Maximize editor |
| `Ctrl+Shift+4` | `tomAi.layout.maximizeChat` | Maximize chat |

### Chord Menus

| Key | Command | Description |
|-----|---------|-------------|
| `Ctrl+Shift+C` | `tomAi.chordMenu.copilot` | Copilot menu |
| `Ctrl+Shift+L` | `tomAi.chordMenu.localLlm` | Local LLM menu |
| `Ctrl+Shift+A` | `tomAi.chordMenu.aiConversation` | AI Conversation menu |
| `Ctrl+Shift+T` | `tomAi.chordMenu.tomAiChat` | Tom AI chat menu |
| `Ctrl+Shift+E` | `tomAi.chordMenu.execute` | Execute menu |
| `Ctrl+Shift+X` | `tomAi.chordMenu.favorites` | Favorites menu |

## Explorer Views

- VS CODE NOTES
- QUEST NOTES
- QUEST TODOS
- SESSION TODOS
- TODO LOG
- WORKSPACE NOTES
- WORKSPACE TODOS
- WINDOW STATUS

## Core AI Commands

- `tomAi.sendToCopilot`
- `tomAi.sendToCopilot.standard`
- `tomAi.sendToCopilot.template`
- `tomAi.tomAiChat.start`
- `tomAi.tomAiChat.send`
- `tomAi.tomAiChat.interrupt`
- `tomAi.sendToLocalLlm`
- `tomAi.sendToLocalLlm.template`

## Bridge and Runtime Commands

- `tomAi.bridge.restart`
- `tomAi.bridge.switchProfile`
- `tomAi.cliServer.start`
- `tomAi.cliServer.stop`
- `tomAi.startProcessMonitor`

## Utility Commands

- `tomAi.statusPage`
- `tomAi.showQuickReference`
- `tomAi.openConfig`
- `tomAi.openSettings`

## Custom Editors (file-bound)

| Editor | View Type | File Patterns | Priority |
|--------|-----------|---------------|----------|
| YAML Graph Editor | `tomAi.yamlGraphEditor` | `*.flow.yaml`, `*.state.yaml`, `*.er.yaml` | default |
| Quest TODO Editor | `tomAi.todoEditor` | `*.todo.yaml` | option |
| Trail Viewer | `tomAi.trailViewer` | `*.prompts.md`, `*.answers.md` | default |

## Standalone Webview Panels (command-opened)

| Panel | View Type | Opened Via |
|-------|-----------|------------|
| Status Page | `tomStatusPage` | `tomAi.statusPage` |
| Markdown Browser | `tomAi.markdownBrowser` | `tomAi.openInMdBrowser` |
| Prompt Trail Viewer | `tomAi.trailViewer` | `tomAi.editor.rawTrailViewer` |
| Prompt Queue | `tomAi.queueEditor` | `tomAi.editor.promptQueue` |
| Timed Requests | `tomAi.timedRequestsEditor` | `tomAi.editor.timedRequests` |
| Prompt Template Editor | `tomAi.globalTemplateEditor` | `tomAi.editor.promptTemplates` |
| Reusable Prompt Editor | `tomAi.reusablePromptEditor` | `tomAi.editor.reusablePrompts` |
| Context & Settings | `tomAi.contextSettingsEditor` | `tomAi.editor.contextSettings` |
| Chat Variables | `tomAi.chatVariablesEditor` | `tomAi.editor.chatVariables` |
| Quest TODO Pop-out | `tomAi.questTodoEditor` | Pop-out from sidebar |

## Bottom Panel Sub-sections

### @CHAT (`tomAi.chatPanel`)

| Section | Icon | Description |
|---------|------|-------------|
| Local LLM | `codicon-robot` | Send prompts to local Ollama model |
| AI Conversation | `codicon-comment-discussion` | Multi-turn AI conversation |
| Copilot | `codicon-copilot` | Copilot integration |
| Tom AI Chat | `codicon-comment-discussion-sparkle` | Tom AI chat interface |

### @WS (`tomAi.wsPanel`)

| Section | Icon | Description |
|---------|------|-------------|
| Guidelines | `book` | Copilot guidelines browser |
| Documentation | `note` | Project documentation |
| Logs | `output` | Extension logs |
| Settings | `settings-gear` | Embedded status page and configuration |
| Issues | `issues` | Issue tracking |
| Tests | `beaker` | Test results |
| Quest TODO | `tasklist` | Quest todo list |
