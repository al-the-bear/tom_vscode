# Extension Elements Inventory

This document is the complete UI/action inventory for the Tom VS Code extension based on package contributions and runtime registrations.

## Snapshot Summary

- Activation events: 1
- Contributed commands: 75
- Keybindings: 22
- View containers: 3
- Views: 12
- Custom editors: 3
- Submenus: 2
- Chat variables: 5

## Activation

| Event | Meaning |
| --- | --- |
| onStartupFinished | Extension activates when this VS Code event fires. |

## UI Containers and Panels

| Container area | Container id | Title | Icon |
| --- | --- | --- | --- |
| activitybar | tomAi-sidebar | @TOM | resources/tom-sidebar.svg |
| panel | tomAi-chat-panel | @CHAT | $(layout) |
| panel | tomAi-ws-panel | @WS | $(beaker) |

| Parent container | View id | View name | Type | View condition |
| --- | --- | --- | --- | --- |
| tomAi-chat-panel | tomAi.chatPanel | @CHAT | webview | always |
| tomAi-ws-panel | tomAi.wsPanel | @WS | webview | always |
| tomAi-sidebar | tomAi.vscodeNotes | VS CODE NOTES | webview | always |
| tomAi-sidebar | tomAi.questNotes | QUEST NOTES | webview | tomAi.hasWorkspaceFile |
| tomAi-sidebar | tomAi.questTodos | QUEST TODOS | webview | always |
| tomAi-sidebar | tomAi.sessionTodos | SESSION TODOS | webview | always |
| tomAi-sidebar | tomAi.workspaceNotes | WORKSPACE NOTES | webview | always |
| tomAi-sidebar | tomAi.workspaceTodos | WORKSPACE TODOS | webview | always |
| tomAi-sidebar | tomAi.todoLogTom | TODO LOG | webview | always |
| tomAi-sidebar | tomAi.windowStatusTom | WINDOW STATUS | webview | always |
| explorer | tomAi.todoLog | TODO LOG | webview | always |
| explorer | tomAi.windowStatus | WINDOW STATUS | webview | always |

## Custom Editors

| View type | Display name | Priority | File selectors |
| --- | --- | --- | --- |
| tomAi.yamlGraphEditor | YAML Graph Editor | default | *.flow.yaml, *.state.yaml, *.er.yaml |
| tomAi.todoEditor | Quest TODO Editor | option | *.todo.yaml |
| tomAi.trailViewer | Trail Viewer | default | *.prompts.md, *.answers.md |

## Chat Variables

| Id | Name | Description |
| --- | --- | --- |
| tomAi.quest | quest | Current active quest ID |
| tomAi.role | role | Current AI role / persona |
| tomAi.activeProjects | activeProjects | Currently active project IDs |
| tomAi.todo | todo | Current todo summary from the active quest |
| tomAi.workspaceName | workspaceName | Current workspace name |

## Keyboard Shortcuts

| Key | Command | Condition | Note |
| --- | --- | --- | --- |
| ctrl+shift+c | -workbench.action.terminal.openNativeConsole | always | Removes default VS Code binding |
| ctrl+shift+x | -workbench.view.extensions | always | Removes default VS Code binding |
| ctrl+shift+c | tomAi.chordMenu.copilot | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+l | tomAi.chordMenu.localLlm | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+a | tomAi.chordMenu.aiConversation | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+t | tomAi.chordMenu.tomAiChat | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+e | tomAi.chordMenu.execute | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+x | tomAi.chordMenu.favorites | !tomAi.chordMenuOpen | Extension action |
| ctrl+shift+` | tomAi.layout.maximizeToggle | always | Extension action |
| ctrl+shift+1 | tomAi.layout.maximizeToggle | always | Extension action |
| ctrl+shift+5 | tomAi.editor.rawTrailViewer | always | Extension action |
| ctrl+shift+6 | tomAi.editor.promptQueue | always | Extension action |
| ctrl+shift+7 | tomAi.editor.timedRequests | always | Extension action |
| ctrl+shift+2 | tomAi.layout.maximizeExplorer | always | Extension action |
| ctrl+shift+3 | tomAi.layout.maximizeEditor | always | Extension action |
| ctrl+shift+4 | tomAi.layout.maximizeChat | always | Extension action |
| ctrl+shift+0 | tomAi.focusChatPanel | always | Extension action |
| ctrl+shift+y | tomAi.layout.windowStateFlow | always | Extension action |
| ctrl+shift+8 | tomAi.statusPage | always | Extension action |
| ctrl+shift+9 | tomAi.wsPanel.focus | always | Extension action |
| ctrl+shift+n | -workbench.action.newWindow | always | Removes default VS Code binding |
| ctrl+shift+n | tomAi.showSidebarNotes | always | Extension action |

## Context Menu Entry Points

| Location | Item type | Id | Group | Condition |
| --- | --- | --- | --- | --- |
| explorer/context | command | tomAi.executeFile | tomAi@1 | resourceExtname == .dart |
| explorer/context | command | tomAi.executeScript | tomAi@3 | resourceExtname == .dart |
| explorer/context | command | tomAi.openInMdViewer | tomAi@5 | resourceExtname == .md |
| explorer/context | command | tomAi.openInMdBrowser | tomAi@6 | resourceExtname == .md |
| editor/context | submenu | tomAi.sendToCopilotSubmenu | copilot@0 | always |
| editor/context | command | tomAi.sendToCopilot.standard | copilot@1 | always |
| editor/context | command | tomAi.sendToCopilot.template | copilot@2 | always |
| editor/context | command | tomAi.sendToCopilot | copilot@3 | editorHasSelection |
| editor/context | submenu | tomAi.sendToLocalLlmSubmenu | localLlm@0 | always |
| editor/context | command | tomAi.sendToLocalLlm.standard | localLlm@1 | always |
| editor/context | command | tomAi.sendToLocalLlm.template | localLlm@2 | always |
| editor/context | command | tomAi.sendToLocalLlm.default | localLlm@3 | editorHasSelection |
| editor/context | command | tomAi.executeFile | tomAi@2 | editorLangId == dart |
| editor/context | command | tomAi.executeScript | tomAi@3 | editorLangId == dart |
| editor/context | command | tomAi.tomAiChat.start | tomAi@4 | resourceExtname == .chat.md |
| editor/context | command | tomAi.tomAiChat.send | tomAi@5 | resourceExtname == .chat.md |
| editor/context | command | tomAi.openInMdViewer | tomAi@10 | resourceLangId == markdown |
| editor/context | command | tomAi.openInMdBrowser | tomAi@11 | resourceLangId == markdown |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.trailReminder | standard@1 | always |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.todoExecution | standard@2 | always |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.codeReview | standard@3 | always |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.explain | standard@4 | always |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.addToTodo | standard@5 | always |
| tomAi.sendToCopilotSubmenu | command | tomAi.sendToCopilot.fixMarkdown | standard@6 | always |
| tomAi.sendToLocalLlmSubmenu | command | tomAi.sendToLocalLlm.expand | profiles@1 | always |
| tomAi.sendToLocalLlmSubmenu | command | tomAi.sendToLocalLlm.rewrite | profiles@2 | always |
| tomAi.sendToLocalLlmSubmenu | command | tomAi.sendToLocalLlm.detailed | profiles@3 | always |
| tomAi.sendToLocalLlmSubmenu | command | tomAi.sendToLocalLlm.annotated | profiles@4 | always |

## Command Catalog

Every contributed command below is accessible from Command Palette after activation. Additional entry points and trigger conditions are listed per command.

### Copilot actions

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.sendToCopilot | @T: Send to Copilot | Command Palette; Editor context menu | editor/context: editorHasSelection | none | src/extension.ts |
| tomAi.sendToCopilot.addToTodo | @T: Add to Todo | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.codeReview | @T: Code Review | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.explain | @T: Explain Code | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.fixMarkdown | @T: Fix Markdown here | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.standard | @T: Send to Copilot (Default Template) | Command Palette; Editor context menu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.template | @T: Send to Copilot (Pick Template) | Command Palette; Editor context menu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.todoExecution | @T: TODO Execution | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.sendToCopilot.trailReminder | @T: Send with Trail Reminder | Command Palette; Editor context menu > tomAi.sendToCopilotSubmenu | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |

### Local LLM actions

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.localLlm.switchModel | @T: Change Local LLM Model... | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm | @T: Send to Local LLM | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.annotated | @T: Annotated Expansion | Command Palette; Editor context menu > tomAi.sendToLocalLlmSubmenu | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.default | @T: Send to Local LLM (Default) | Command Palette; Editor context menu | editor/context: editorHasSelection | none | src/extension.ts |
| tomAi.sendToLocalLlm.detailed | @T: Detailed Expansion | Command Palette; Editor context menu > tomAi.sendToLocalLlmSubmenu | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.expand | @T: Expand Prompt | Command Palette; Editor context menu > tomAi.sendToLocalLlmSubmenu | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.rewrite | @T: Rewrite | Command Palette; Editor context menu > tomAi.sendToLocalLlmSubmenu | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.standard | @T: Send to Local LLM (Default Template) | Command Palette; Editor context menu | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.sendToLocalLlm.template | @T: Send to Local LLM (Pick Template) | Command Palette; Editor context menu | Always available in Command Palette after activation | none | src/extension.ts |

### AI conversation and Tom AI chat

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.aiConversation.add | @T: Add to AI Conversation | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.aiConversation.continue | @T: Continue AI Conversation | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.aiConversation.halt | @T: Halt AI Conversation | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.aiConversation.start | @T: Start AI Conversation | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.aiConversation.stop | @T: Stop AI Conversation | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.tomAiChat.interrupt | @T: Interrupt Tom AI Chat | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.tomAiChat.send | @T: Send Tom AI Chat Prompt | Command Palette; Editor context menu | editor/context: resourceExtname == .chat.md | none | src/extension.ts |
| tomAi.tomAiChat.start | @T: Start Tom AI Chat | Command Palette; Editor context menu | editor/context: resourceExtname == .chat.md | none | src/extension.ts |

### Bridge, server, process, telegram, trail

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.bridge.restart | @T: Restart Bridge | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.bridge.switchProfile | @T: Switch Bridge Profile... | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.bridge.toggleDebug | @T: Toggle Bridge Debug Logging | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.cliServer.start | @T: Start Tom CLI Integration Server | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.cliServer.startCustomPort | @T: Start Tom CLI Integration Server (Custom Port) | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.cliServer.stop | @T: Stop Tom CLI Integration Server | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.startProcessMonitor | @T: Start Tom Process Monitor | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.telegram.configure | @T: Configure Telegram | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.telegram.testConnection | @T: Telegram Test Connection | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.telegram.toggle | @T: Toggle Telegram | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.trail.toggle | @T: Toggle Trail | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |

### Layout and focus

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.focusChatPanel | @T: Focus @CHAT Panel | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+0 | src/handlers/sidebarNotes-handler.ts |
| tomAi.layout.maximizeChat | @T: Maximize @CHAT | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+4 | src/handlers/combinedCommand-handler.ts |
| tomAi.layout.maximizeEditor | @T: Maximize Editor | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+3 | src/handlers/combinedCommand-handler.ts |
| tomAi.layout.maximizeExplorer | @T: Maximize Explorer | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+2 | src/handlers/combinedCommand-handler.ts |
| tomAi.layout.maximizeToggle | @T: Maximize Toggle | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+`; ctrl+shift+1 | src/handlers/combinedCommand-handler.ts |
| tomAi.layout.resetStateMachines | @T: Reset All State Machine States | Command Palette | Always available in Command Palette after activation | none | src/handlers/stateMachine-handler.ts |
| tomAi.layout.windowStateFlow | @T: Window Panel State Flow | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+y | src/handlers/stateMachine-handler.ts |
| tomAi.showSidebarNotes | @T: Show Sidebar Notes | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+n | src/handlers/combinedCommand-handler.ts |
| tomAi.tomSidebar.focus | @T: Focus @TOM Sidebar | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.wsPanel.focus | @T: Focus Workspace Panel | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+9 | not found via static scan |

### Editor and review tools

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.editor.chatVariables | @T: Open Chat Variables Editor | Command Palette | Always available in Command Palette after activation | none | src/handlers/chatVariablesEditor-handler.ts |
| tomAi.editor.contextSettings | @T: Open Context & Settings Editor | Command Palette | Always available in Command Palette after activation | none | src/handlers/contextSettingsEditor-handler.ts |
| tomAi.editor.promptQueue | @T: Open Prompt Queue Editor | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+6 | src/handlers/queueEditor-handler.ts |
| tomAi.editor.promptTemplates | @T: Open Prompt Template Editor | Command Palette | Always available in Command Palette after activation | none | src/handlers/globalTemplateEditor-handler.ts |
| tomAi.editor.queueTemplates | @T: Open Queue-Template Editor | Command Palette | Always available in Command Palette after activation | none | src/handlers/queueTemplateEditor-handler.ts |
| tomAi.editor.rawTrailViewer | @T: Open Raw Trail Viewer | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+5 | src/handlers/trailViewer-handler.ts |
| tomAi.editor.reusablePrompts | @T: Open Reusable Prompt Editor | Command Palette | Always available in Command Palette after activation | none | src/handlers/reusablePromptEditor-handler.ts |
| tomAi.editor.summaryTrailViewer | @T: Open Summary Trail Viewer | Command Palette | Always available in Command Palette after activation | none | src/handlers/trailViewer-handler.ts |
| tomAi.editor.timedRequests | @T: Open Timed Requests Editor | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+7 | src/handlers/timedRequestsEditor-handler.ts |
| tomAi.openInMdBrowser | @T: Open in MD Browser | Command Palette; Explorer context menu; Editor context menu | explorer/context: resourceExtname == .md; editor/context: resourceLangId == markdown | none | src/handlers/markdownBrowser-handler.ts |
| tomAi.openInMdViewer | @T: Open in MD Viewer | Command Palette; Explorer context menu; Editor context menu | explorer/context: resourceExtname == .md; editor/context: resourceLangId == markdown | none | src/extension.ts |

### Commandline and configuration

| Command id | Title | UI entry points | Trigger conditions | Shortcuts | Runtime registration location |
| --- | --- | --- | --- | --- | --- |
| tomAi.clearAnswerValues | @T: Clear Chat Answer Values | Command Palette | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.commandline.add | @T: Add Commandline | Command Palette | Always available in Command Palette after activation | none | src/handlers/commandline-handler.ts |
| tomAi.commandline.delete | @T: Delete Commandline | Command Palette | Always available in Command Palette after activation | none | src/handlers/commandline-handler.ts |
| tomAi.commandline.execute | @T: Execute Commandline | Command Palette | Always available in Command Palette after activation | none | src/handlers/commandline-handler.ts |
| tomAi.executeFile | @T: Execute File | Command Palette; Explorer context menu; Editor context menu | explorer/context: resourceExtname == .dart; editor/context: editorLangId == dart | none | src/extension.ts |
| tomAi.executeScript | @T: Execute as Script | Command Palette; Explorer context menu; Editor context menu | explorer/context: resourceExtname == .dart; editor/context: editorLangId == dart | none | src/extension.ts |
| tomAi.openConfig | @T: Open Config | Command Palette | Always available in Command Palette after activation | none | src/handlers/commandline-handler.ts |
| tomAi.openSettings | @T: Open Extension Settings | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.printConfiguration | @T: Print Configuration | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.reloadConfig | @T: Reload Configuration | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.reloadWindow | @T: Reload Window | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.runTests | @T: Run Tests | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.showAnswerValues | @T: Show Chat Answer Values | Command Palette | Always available in Command Palette after activation | none | src/handlers/copilotTemplates-handler.ts |
| tomAi.showApiInfo | @T: Show VS Code API Info | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.showHelp | @T: Show Extension Help | Command Palette | Always available in Command Palette after activation | none | src/extension.ts |
| tomAi.showQuickReference | @T: Show Quick Reference | Command Palette | Always available in Command Palette after activation | none | src/handlers/chordMenu-handler.ts |
| tomAi.statusPage | @T: Extension Status Page | Command Palette; Keyboard shortcut | Always available in Command Palette after activation | ctrl+shift+8 | src/extension.ts |

## Runtime-Only Commands (Not Contributed in package.json)

| Command id | Trigger path | Runtime registration location |
| --- | --- | --- |
| tomAi.chordMenu.aiConversation | ctrl+shift+a | src/handlers/chordMenu-handler.ts |
| tomAi.chordMenu.copilot | ctrl+shift+c | src/handlers/chordMenu-handler.ts |
| tomAi.chordMenu.execute | ctrl+shift+e | src/handlers/chordMenu-handler.ts |
| tomAi.chordMenu.favorites | ctrl+shift+x | src/handlers/chordMenu-handler.ts |
| tomAi.chordMenu.localLlm | ctrl+shift+l | src/handlers/chordMenu-handler.ts |
| tomAi.chordMenu.tomAiChat | ctrl+shift+t | src/handlers/chordMenu-handler.ts |

## Review Notes

- The command id tomAi.wsPanel.focus is contributed and bound to Ctrl+Shift+9, but no direct registration was found in static command registration scans.
- Several commands are registered via template literals or constants (for example layout and Local LLM profile commands), so static literal-only scans can under-report registration locations unless expanded as done in this document.
- Context submenus tomAi.sendToCopilotSubmenu and tomAi.sendToLocalLlmSubmenu are surfaced from the editor context menu.
