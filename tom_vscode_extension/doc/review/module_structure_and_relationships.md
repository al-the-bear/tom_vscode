# Module Structure and Relationships

This document shows which functional components in the extension use other functional components, based on resolved internal TypeScript imports.

## Analysis Basis

- Source scope: `src/**/*.ts`
- Functional component heuristic: runtime modules such as handlers (`*-handler.ts`), managers/stores/services/engines/systems/providers/clients, tools under `src/tools/`, plus root runtime modules (`extension.ts`, `vscode-bridge.ts`).
- Relationship edge: component A imports component B via relative module import resolved to `src` file.
- Source files analyzed: 107
- Functional components found: 64
- Functional component dependency edges: 88

## Subsystem Relationship Summary

| Subsystem | Functional Components | Outgoing Edges | Incoming Edges |
| --- | --- | --- | --- |
| handlers | 45 | 50 | 31 |
| managers | 8 | 8 | 40 |
| tools | 6 | 12 | 9 |
| utils | 2 | 0 | 3 |
| extension.ts | 1 | 17 | 0 |
| services | 1 | 0 | 3 |
| vscode-bridge.ts | 1 | 1 | 2 |

## Functional Component Inventory

| Component | Subsystem | File | Uses Functional Components | Used By Functional Components |
| --- | --- | --- | --- | --- |
| extension | extension.ts | src/extension.ts | 17 | 0 |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts | 6 | 1 |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts | 6 | 1 |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts | 5 | 2 |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts | 5 | 0 |
| tool-executors | tools | src/tools/tool-executors.ts | 4 | 2 |
| queueEditor-handler | handlers | src/handlers/queueEditor-handler.ts | 4 | 0 |
| sidebarNotes-handler | handlers | src/handlers/sidebarNotes-handler.ts | 4 | 0 |
| statusPage-handler | handlers | src/handlers/statusPage-handler.ts | 4 | 0 |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts | 3 | 4 |
| chatVariablesEditor-handler | handlers | src/handlers/chatVariablesEditor-handler.ts | 3 | 0 |
| promptQueueManager | managers | src/managers/promptQueueManager.ts | 2 | 6 |
| timerEngine | managers | src/managers/timerEngine.ts | 2 | 4 |
| aiConversation-handler | handlers | src/handlers/aiConversation-handler.ts | 2 | 1 |
| todoLogPanel-handler | handlers | src/handlers/todoLogPanel-handler.ts | 2 | 1 |
| trailEditor-handler | handlers | src/handlers/trailEditor-handler.ts | 2 | 1 |
| trailViewer-handler | handlers | src/handlers/trailViewer-handler.ts | 2 | 1 |
| tomAiChat-handler | handlers | src/handlers/tomAiChat-handler.ts | 2 | 0 |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts | 1 | 6 |
| reminderSystem | managers | src/managers/reminderSystem.ts | 1 | 5 |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts | 1 | 3 |
| chatTodoSessionManager | managers | src/managers/chatTodoSessionManager.ts | 1 | 2 |
| tomAiChat-tools | tools | src/tools/tomAiChat-tools.ts | 1 | 2 |
| vscode-bridge | vscode-bridge.ts | src/vscode-bridge.ts | 1 | 2 |
| restartBridge-handler | handlers | src/handlers/restartBridge-handler.ts | 1 | 1 |
| reusablePromptEditor-handler | handlers | src/handlers/reusablePromptEditor-handler.ts | 1 | 1 |
| todoProvider | managers | src/managers/todoProvider.ts | 1 | 1 |
| chatVariableResolvers | tools | src/tools/chatVariableResolvers.ts | 1 | 1 |
| contextSettingsEditor-handler | handlers | src/handlers/contextSettingsEditor-handler.ts | 1 | 0 |
| issuesPanel-handler | handlers | src/handlers/issuesPanel-handler.ts | 1 | 0 |
| queueTemplateEditor-handler | handlers | src/handlers/queueTemplateEditor-handler.ts | 1 | 0 |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts | 0 | 10 |
| questTodoManager | managers | src/managers/questTodoManager.ts | 0 | 6 |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts | 0 | 5 |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts | 0 | 4 |
| trailService | services | src/services/trailService.ts | 0 | 3 |
| shared-tool-registry | tools | src/tools/shared-tool-registry.ts | 0 | 3 |
| panelYamlStore | utils | src/utils/panelYamlStore.ts | 0 | 3 |
| cliServer-handler | handlers | src/handlers/cliServer-handler.ts | 0 | 1 |
| commandline-handler | handlers | src/handlers/commandline-handler.ts | 0 | 1 |
| githubIssueProvider | handlers | src/handlers/githubIssueProvider.ts | 0 | 1 |
| markdownBrowser-handler | handlers | src/handlers/markdownBrowser-handler.ts | 0 | 1 |
| minimalMode-handler | handlers | src/handlers/minimalMode-handler.ts | 0 | 1 |
| questTodoEditor-handler | handlers | src/handlers/questTodoEditor-handler.ts | 0 | 1 |
| chordMenu-handler | handlers | src/handlers/chordMenu-handler.ts | 0 | 0 |
| combinedCommand-handler | handlers | src/handlers/combinedCommand-handler.ts | 0 | 0 |
| copilotTemplates-handler | handlers | src/handlers/copilotTemplates-handler.ts | 0 | 0 |
| debugLogging-handler | handlers | src/handlers/debugLogging-handler.ts | 0 | 0 |
| executeAsScript-handler | handlers | src/handlers/executeAsScript-handler.ts | 0 | 0 |
| executeInTomAiBuild-handler | handlers | src/handlers/executeInTomAiBuild-handler.ts | 0 | 0 |
| issueProvider | handlers | src/handlers/issueProvider.ts | 0 | 0 |
| notepad-handler | handlers | src/handlers/notepad-handler.ts | 0 | 0 |
| printConfiguration-handler | handlers | src/handlers/printConfiguration-handler.ts | 0 | 0 |
| processMonitor-handler | handlers | src/handlers/processMonitor-handler.ts | 0 | 0 |
| reloadWindow-handler | handlers | src/handlers/reloadWindow-handler.ts | 0 | 0 |
| runTests-handler | handlers | src/handlers/runTests-handler.ts | 0 | 0 |
| sendToChat-handler | handlers | src/handlers/sendToChat-handler.ts | 0 | 0 |
| showApiInfo-handler | handlers | src/handlers/showApiInfo-handler.ts | 0 | 0 |
| showHelp-handler | handlers | src/handlers/showHelp-handler.ts | 0 | 0 |
| stateMachine-handler | handlers | src/handlers/stateMachine-handler.ts | 0 | 0 |
| wsPanel-handler | handlers | src/handlers/wsPanel-handler.ts | 0 | 0 |
| yamlGraph-handler | handlers | src/handlers/yamlGraph-handler.ts | 0 | 0 |
| local-llm-tools-config | tools | src/tools/local-llm-tools-config.ts | 0 | 0 |
| baseWebviewProvider | utils | src/utils/baseWebviewProvider.ts | 0 | 0 |

## Dependency Hubs (Top 15)

| Component | Subsystem | File | Uses Functional Components | Used By Functional Components |
| --- | --- | --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts | 0 | 10 |
| promptQueueManager | managers | src/managers/promptQueueManager.ts | 2 | 6 |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts | 1 | 6 |
| questTodoManager | managers | src/managers/questTodoManager.ts | 0 | 6 |
| reminderSystem | managers | src/managers/reminderSystem.ts | 1 | 5 |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts | 0 | 5 |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts | 3 | 4 |
| timerEngine | managers | src/managers/timerEngine.ts | 2 | 4 |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts | 0 | 4 |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts | 1 | 3 |
| trailService | services | src/services/trailService.ts | 0 | 3 |
| shared-tool-registry | tools | src/tools/shared-tool-registry.ts | 0 | 3 |
| panelYamlStore | utils | src/utils/panelYamlStore.ts | 0 | 3 |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts | 5 | 2 |
| tool-executors | tools | src/tools/tool-executors.ts | 4 | 2 |

## Component-to-Component Edges

| From | To | From File | To File |
| --- | --- | --- | --- |
| extension (extension.ts) | markdownBrowser-handler (handlers) | src/extension.ts | src/handlers/markdownBrowser-handler.ts |
| extension (extension.ts) | minimalMode-handler (handlers) | src/extension.ts | src/handlers/minimalMode-handler.ts |
| extension (extension.ts) | questTodoEditor-handler (handlers) | src/extension.ts | src/handlers/questTodoEditor-handler.ts |
| extension (extension.ts) | todoLogPanel-handler (handlers) | src/extension.ts | src/handlers/todoLogPanel-handler.ts |
| extension (extension.ts) | tomScriptingBridge-handler (handlers) | src/extension.ts | src/handlers/tomScriptingBridge-handler.ts |
| extension (extension.ts) | trailEditor-handler (handlers) | src/extension.ts | src/handlers/trailEditor-handler.ts |
| extension (extension.ts) | windowStatusPanel-handler (handlers) | src/extension.ts | src/handlers/windowStatusPanel-handler.ts |
| extension (extension.ts) | chatVariablesStore (managers) | src/extension.ts | src/managers/chatVariablesStore.ts |
| extension (extension.ts) | promptQueueManager (managers) | src/extension.ts | src/managers/promptQueueManager.ts |
| extension (extension.ts) | reminderSystem (managers) | src/extension.ts | src/managers/reminderSystem.ts |
| extension (extension.ts) | sessionTodoStore (managers) | src/extension.ts | src/managers/sessionTodoStore.ts |
| extension (extension.ts) | timerEngine (managers) | src/extension.ts | src/managers/timerEngine.ts |
| extension (extension.ts) | trailService (services) | src/extension.ts | src/services/trailService.ts |
| extension (extension.ts) | chatVariableResolvers (tools) | src/extension.ts | src/tools/chatVariableResolvers.ts |
| extension (extension.ts) | tomAiChat-tools (tools) | src/extension.ts | src/tools/tomAiChat-tools.ts |
| extension (extension.ts) | tool-executors (tools) | src/extension.ts | src/tools/tool-executors.ts |
| extension (extension.ts) | vscode-bridge (vscode-bridge.ts) | src/extension.ts | src/vscode-bridge.ts |
| aiConversation-handler (handlers) | localLlm-handler (handlers) | src/handlers/aiConversation-handler.ts | src/handlers/localLlm-handler.ts |
| aiConversation-handler (handlers) | windowStatusPanel-handler (handlers) | src/handlers/aiConversation-handler.ts | src/handlers/windowStatusPanel-handler.ts |
| chatPanel-handler (handlers) | aiConversation-handler (handlers) | src/handlers/chatPanel-handler.ts | src/handlers/aiConversation-handler.ts |
| chatPanel-handler (handlers) | globalTemplateEditor-handler (handlers) | src/handlers/chatPanel-handler.ts | src/handlers/globalTemplateEditor-handler.ts |
| chatPanel-handler (handlers) | localLlm-handler (handlers) | src/handlers/chatPanel-handler.ts | src/handlers/localLlm-handler.ts |
| chatPanel-handler (handlers) | reusablePromptEditor-handler (handlers) | src/handlers/chatPanel-handler.ts | src/handlers/reusablePromptEditor-handler.ts |
| chatPanel-handler (handlers) | windowStatusPanel-handler (handlers) | src/handlers/chatPanel-handler.ts | src/handlers/windowStatusPanel-handler.ts |
| chatPanel-handler (handlers) | trailService (services) | src/handlers/chatPanel-handler.ts | src/services/trailService.ts |
| chatVariablesEditor-handler (handlers) | chatVariablesStore (managers) | src/handlers/chatVariablesEditor-handler.ts | src/managers/chatVariablesStore.ts |
| chatVariablesEditor-handler (handlers) | questTodoManager (managers) | src/handlers/chatVariablesEditor-handler.ts | src/managers/questTodoManager.ts |
| chatVariablesEditor-handler (handlers) | panelYamlStore (utils) | src/handlers/chatVariablesEditor-handler.ts | src/utils/panelYamlStore.ts |
| contextSettingsEditor-handler (handlers) | globalTemplateEditor-handler (handlers) | src/handlers/contextSettingsEditor-handler.ts | src/handlers/globalTemplateEditor-handler.ts |
| issuesPanel-handler (handlers) | githubIssueProvider (handlers) | src/handlers/issuesPanel-handler.ts | src/handlers/githubIssueProvider.ts |
| localLlm-handler (handlers) | tool-executors (tools) | src/handlers/localLlm-handler.ts | src/tools/tool-executors.ts |
| questTodoPanel-handler (handlers) | chatVariablesStore (managers) | src/handlers/questTodoPanel-handler.ts | src/managers/chatVariablesStore.ts |
| questTodoPanel-handler (handlers) | questTodoManager (managers) | src/handlers/questTodoPanel-handler.ts | src/managers/questTodoManager.ts |
| questTodoPanel-handler (handlers) | sessionTodoStore (managers) | src/handlers/questTodoPanel-handler.ts | src/managers/sessionTodoStore.ts |
| queueEditor-handler (handlers) | globalTemplateEditor-handler (handlers) | src/handlers/queueEditor-handler.ts | src/handlers/globalTemplateEditor-handler.ts |
| queueEditor-handler (handlers) | chatVariablesStore (managers) | src/handlers/queueEditor-handler.ts | src/managers/chatVariablesStore.ts |
| queueEditor-handler (handlers) | promptQueueManager (managers) | src/handlers/queueEditor-handler.ts | src/managers/promptQueueManager.ts |
| queueEditor-handler (handlers) | reminderSystem (managers) | src/handlers/queueEditor-handler.ts | src/managers/reminderSystem.ts |
| queueTemplateEditor-handler (handlers) | reminderSystem (managers) | src/handlers/queueTemplateEditor-handler.ts | src/managers/reminderSystem.ts |
| restartBridge-handler (handlers) | vscode-bridge (vscode-bridge.ts) | src/handlers/restartBridge-handler.ts | src/vscode-bridge.ts |
| reusablePromptEditor-handler (handlers) | panelYamlStore (utils) | src/handlers/reusablePromptEditor-handler.ts | src/utils/panelYamlStore.ts |
| sidebarNotes-handler (handlers) | globalTemplateEditor-handler (handlers) | src/handlers/sidebarNotes-handler.ts | src/handlers/globalTemplateEditor-handler.ts |
| sidebarNotes-handler (handlers) | localLlm-handler (handlers) | src/handlers/sidebarNotes-handler.ts | src/handlers/localLlm-handler.ts |
| sidebarNotes-handler (handlers) | questTodoPanel-handler (handlers) | src/handlers/sidebarNotes-handler.ts | src/handlers/questTodoPanel-handler.ts |
| sidebarNotes-handler (handlers) | sessionTodoStore (managers) | src/handlers/sidebarNotes-handler.ts | src/managers/sessionTodoStore.ts |
| statusPage-handler (handlers) | cliServer-handler (handlers) | src/handlers/statusPage-handler.ts | src/handlers/cliServer-handler.ts |
| statusPage-handler (handlers) | commandline-handler (handlers) | src/handlers/statusPage-handler.ts | src/handlers/commandline-handler.ts |
| statusPage-handler (handlers) | restartBridge-handler (handlers) | src/handlers/statusPage-handler.ts | src/handlers/restartBridge-handler.ts |
| statusPage-handler (handlers) | timerEngine (managers) | src/handlers/statusPage-handler.ts | src/managers/timerEngine.ts |
| timedRequestsEditor-handler (handlers) | globalTemplateEditor-handler (handlers) | src/handlers/timedRequestsEditor-handler.ts | src/handlers/globalTemplateEditor-handler.ts |
| timedRequestsEditor-handler (handlers) | chatVariablesStore (managers) | src/handlers/timedRequestsEditor-handler.ts | src/managers/chatVariablesStore.ts |
| timedRequestsEditor-handler (handlers) | promptQueueManager (managers) | src/handlers/timedRequestsEditor-handler.ts | src/managers/promptQueueManager.ts |
| timedRequestsEditor-handler (handlers) | reminderSystem (managers) | src/handlers/timedRequestsEditor-handler.ts | src/managers/reminderSystem.ts |
| timedRequestsEditor-handler (handlers) | timerEngine (managers) | src/handlers/timedRequestsEditor-handler.ts | src/managers/timerEngine.ts |
| todoLogPanel-handler (handlers) | chatPanel-handler (handlers) | src/handlers/todoLogPanel-handler.ts | src/handlers/chatPanel-handler.ts |
| todoLogPanel-handler (handlers) | trailViewer-handler (handlers) | src/handlers/todoLogPanel-handler.ts | src/handlers/trailViewer-handler.ts |
| tomAiChat-handler (handlers) | chatTodoSessionManager (managers) | src/handlers/tomAiChat-handler.ts | src/managers/chatTodoSessionManager.ts |
| tomAiChat-handler (handlers) | tomAiChat-tools (tools) | src/handlers/tomAiChat-handler.ts | src/tools/tomAiChat-tools.ts |
| tomScriptingBridge-handler (handlers) | chatVariablesStore (managers) | src/handlers/tomScriptingBridge-handler.ts | src/managers/chatVariablesStore.ts |
| tomScriptingBridge-handler (handlers) | promptQueueManager (managers) | src/handlers/tomScriptingBridge-handler.ts | src/managers/promptQueueManager.ts |
| tomScriptingBridge-handler (handlers) | questTodoManager (managers) | src/handlers/tomScriptingBridge-handler.ts | src/managers/questTodoManager.ts |
| tomScriptingBridge-handler (handlers) | sessionTodoStore (managers) | src/handlers/tomScriptingBridge-handler.ts | src/managers/sessionTodoStore.ts |
| tomScriptingBridge-handler (handlers) | timerEngine (managers) | src/handlers/tomScriptingBridge-handler.ts | src/managers/timerEngine.ts |
| trailEditor-handler (handlers) | questTodoPanel-handler (handlers) | src/handlers/trailEditor-handler.ts | src/handlers/questTodoPanel-handler.ts |
| trailEditor-handler (handlers) | questTodoManager (managers) | src/handlers/trailEditor-handler.ts | src/managers/questTodoManager.ts |
| trailViewer-handler (handlers) | questTodoPanel-handler (handlers) | src/handlers/trailViewer-handler.ts | src/handlers/questTodoPanel-handler.ts |
| trailViewer-handler (handlers) | questTodoManager (managers) | src/handlers/trailViewer-handler.ts | src/managers/questTodoManager.ts |
| chatTodoSessionManager (managers) | todoProvider (managers) | src/managers/chatTodoSessionManager.ts | src/managers/todoProvider.ts |
| promptQueueManager (managers) | windowStatusPanel-handler (handlers) | src/managers/promptQueueManager.ts | src/handlers/windowStatusPanel-handler.ts |
| promptQueueManager (managers) | trailService (services) | src/managers/promptQueueManager.ts | src/services/trailService.ts |
| reminderSystem (managers) | promptQueueManager (managers) | src/managers/reminderSystem.ts | src/managers/promptQueueManager.ts |
| sessionTodoStore (managers) | chatVariablesStore (managers) | src/managers/sessionTodoStore.ts | src/managers/chatVariablesStore.ts |
| timerEngine (managers) | promptQueueManager (managers) | src/managers/timerEngine.ts | src/managers/promptQueueManager.ts |
| timerEngine (managers) | panelYamlStore (utils) | src/managers/timerEngine.ts | src/utils/panelYamlStore.ts |
| todoProvider (managers) | sessionTodoStore (managers) | src/managers/todoProvider.ts | src/managers/sessionTodoStore.ts |
| chat-enhancement-tools (tools) | questTodoPanel-handler (handlers) | src/tools/chat-enhancement-tools.ts | src/handlers/questTodoPanel-handler.ts |
| chat-enhancement-tools (tools) | chatVariablesStore (managers) | src/tools/chat-enhancement-tools.ts | src/managers/chatVariablesStore.ts |
| chat-enhancement-tools (tools) | questTodoManager (managers) | src/tools/chat-enhancement-tools.ts | src/managers/questTodoManager.ts |
| chat-enhancement-tools (tools) | reminderSystem (managers) | src/tools/chat-enhancement-tools.ts | src/managers/reminderSystem.ts |
| chat-enhancement-tools (tools) | sessionTodoStore (managers) | src/tools/chat-enhancement-tools.ts | src/managers/sessionTodoStore.ts |
| chat-enhancement-tools (tools) | shared-tool-registry (tools) | src/tools/chat-enhancement-tools.ts | src/tools/shared-tool-registry.ts |
| chatVariableResolvers (tools) | chatVariablesStore (managers) | src/tools/chatVariableResolvers.ts | src/managers/chatVariablesStore.ts |
| tomAiChat-tools (tools) | shared-tool-registry (tools) | src/tools/tomAiChat-tools.ts | src/tools/shared-tool-registry.ts |
| tool-executors (tools) | chatTodoSessionManager (managers) | src/tools/tool-executors.ts | src/managers/chatTodoSessionManager.ts |
| tool-executors (tools) | chatVariablesStore (managers) | src/tools/tool-executors.ts | src/managers/chatVariablesStore.ts |
| tool-executors (tools) | chat-enhancement-tools (tools) | src/tools/tool-executors.ts | src/tools/chat-enhancement-tools.ts |
| tool-executors (tools) | shared-tool-registry (tools) | src/tools/tool-executors.ts | src/tools/shared-tool-registry.ts |
| vscode-bridge (vscode-bridge.ts) | tomScriptingBridge-handler (handlers) | src/vscode-bridge.ts | src/handlers/tomScriptingBridge-handler.ts |

## Per-Component Relationship View

### extension (extension.ts)

- File: `src/extension.ts`
- Uses functional components: 17
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| markdownBrowser-handler | handlers | src/handlers/markdownBrowser-handler.ts |
| minimalMode-handler | handlers | src/handlers/minimalMode-handler.ts |
| questTodoEditor-handler | handlers | src/handlers/questTodoEditor-handler.ts |
| todoLogPanel-handler | handlers | src/handlers/todoLogPanel-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |
| trailEditor-handler | handlers | src/handlers/trailEditor-handler.ts |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |
| reminderSystem | managers | src/managers/reminderSystem.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |
| timerEngine | managers | src/managers/timerEngine.ts |
| trailService | services | src/services/trailService.ts |
| chatVariableResolvers | tools | src/tools/chatVariableResolvers.ts |
| tomAiChat-tools | tools | src/tools/tomAiChat-tools.ts |
| tool-executors | tools | src/tools/tool-executors.ts |
| vscode-bridge | vscode-bridge.ts | src/vscode-bridge.ts |

Used by these functional components

None.

### aiConversation-handler (handlers)

- File: `src/handlers/aiConversation-handler.ts`
- Uses functional components: 2
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |

### chatPanel-handler (handlers)

- File: `src/handlers/chatPanel-handler.ts`
- Uses functional components: 6
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| aiConversation-handler | handlers | src/handlers/aiConversation-handler.ts |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts |
| reusablePromptEditor-handler | handlers | src/handlers/reusablePromptEditor-handler.ts |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts |
| trailService | services | src/services/trailService.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| todoLogPanel-handler | handlers | src/handlers/todoLogPanel-handler.ts |

### chatVariablesEditor-handler (handlers)

- File: `src/handlers/chatVariablesEditor-handler.ts`
- Uses functional components: 3
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |
| panelYamlStore | utils | src/utils/panelYamlStore.ts |

Used by these functional components

None.

### chordMenu-handler (handlers)

- File: `src/handlers/chordMenu-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### cliServer-handler (handlers)

- File: `src/handlers/cliServer-handler.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| statusPage-handler | handlers | src/handlers/statusPage-handler.ts |

### combinedCommand-handler (handlers)

- File: `src/handlers/combinedCommand-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### commandline-handler (handlers)

- File: `src/handlers/commandline-handler.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| statusPage-handler | handlers | src/handlers/statusPage-handler.ts |

### contextSettingsEditor-handler (handlers)

- File: `src/handlers/contextSettingsEditor-handler.ts`
- Uses functional components: 1
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts |

Used by these functional components

None.

### copilotTemplates-handler (handlers)

- File: `src/handlers/copilotTemplates-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### debugLogging-handler (handlers)

- File: `src/handlers/debugLogging-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### executeAsScript-handler (handlers)

- File: `src/handlers/executeAsScript-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### executeInTomAiBuild-handler (handlers)

- File: `src/handlers/executeInTomAiBuild-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### githubIssueProvider (handlers)

- File: `src/handlers/githubIssueProvider.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| issuesPanel-handler | handlers | src/handlers/issuesPanel-handler.ts |

### globalTemplateEditor-handler (handlers)

- File: `src/handlers/globalTemplateEditor-handler.ts`
- Uses functional components: 0
- Used by functional components: 5

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |
| contextSettingsEditor-handler | handlers | src/handlers/contextSettingsEditor-handler.ts |
| queueEditor-handler | handlers | src/handlers/queueEditor-handler.ts |
| sidebarNotes-handler | handlers | src/handlers/sidebarNotes-handler.ts |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts |

### issueProvider (handlers)

- File: `src/handlers/issueProvider.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### issuesPanel-handler (handlers)

- File: `src/handlers/issuesPanel-handler.ts`
- Uses functional components: 1
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| githubIssueProvider | handlers | src/handlers/githubIssueProvider.ts |

Used by these functional components

None.

### localLlm-handler (handlers)

- File: `src/handlers/localLlm-handler.ts`
- Uses functional components: 1
- Used by functional components: 3

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| tool-executors | tools | src/tools/tool-executors.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| aiConversation-handler | handlers | src/handlers/aiConversation-handler.ts |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |
| sidebarNotes-handler | handlers | src/handlers/sidebarNotes-handler.ts |

### markdownBrowser-handler (handlers)

- File: `src/handlers/markdownBrowser-handler.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### minimalMode-handler (handlers)

- File: `src/handlers/minimalMode-handler.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### notepad-handler (handlers)

- File: `src/handlers/notepad-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### printConfiguration-handler (handlers)

- File: `src/handlers/printConfiguration-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### processMonitor-handler (handlers)

- File: `src/handlers/processMonitor-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### questTodoEditor-handler (handlers)

- File: `src/handlers/questTodoEditor-handler.ts`
- Uses functional components: 0
- Used by functional components: 1

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### questTodoPanel-handler (handlers)

- File: `src/handlers/questTodoPanel-handler.ts`
- Uses functional components: 3
- Used by functional components: 4

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| sidebarNotes-handler | handlers | src/handlers/sidebarNotes-handler.ts |
| trailEditor-handler | handlers | src/handlers/trailEditor-handler.ts |
| trailViewer-handler | handlers | src/handlers/trailViewer-handler.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |

### queueEditor-handler (handlers)

- File: `src/handlers/queueEditor-handler.ts`
- Uses functional components: 4
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |
| reminderSystem | managers | src/managers/reminderSystem.ts |

Used by these functional components

None.

### queueTemplateEditor-handler (handlers)

- File: `src/handlers/queueTemplateEditor-handler.ts`
- Uses functional components: 1
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| reminderSystem | managers | src/managers/reminderSystem.ts |

Used by these functional components

None.

### reloadWindow-handler (handlers)

- File: `src/handlers/reloadWindow-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### restartBridge-handler (handlers)

- File: `src/handlers/restartBridge-handler.ts`
- Uses functional components: 1
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| vscode-bridge | vscode-bridge.ts | src/vscode-bridge.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| statusPage-handler | handlers | src/handlers/statusPage-handler.ts |

### reusablePromptEditor-handler (handlers)

- File: `src/handlers/reusablePromptEditor-handler.ts`
- Uses functional components: 1
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| panelYamlStore | utils | src/utils/panelYamlStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |

### runTests-handler (handlers)

- File: `src/handlers/runTests-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### sendToChat-handler (handlers)

- File: `src/handlers/sendToChat-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### showApiInfo-handler (handlers)

- File: `src/handlers/showApiInfo-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### showHelp-handler (handlers)

- File: `src/handlers/showHelp-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### sidebarNotes-handler (handlers)

- File: `src/handlers/sidebarNotes-handler.ts`
- Uses functional components: 4
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |

Used by these functional components

None.

### stateMachine-handler (handlers)

- File: `src/handlers/stateMachine-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### statusPage-handler (handlers)

- File: `src/handlers/statusPage-handler.ts`
- Uses functional components: 4
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| cliServer-handler | handlers | src/handlers/cliServer-handler.ts |
| commandline-handler | handlers | src/handlers/commandline-handler.ts |
| restartBridge-handler | handlers | src/handlers/restartBridge-handler.ts |
| timerEngine | managers | src/managers/timerEngine.ts |

Used by these functional components

None.

### timedRequestsEditor-handler (handlers)

- File: `src/handlers/timedRequestsEditor-handler.ts`
- Uses functional components: 5
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| globalTemplateEditor-handler | handlers | src/handlers/globalTemplateEditor-handler.ts |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |
| reminderSystem | managers | src/managers/reminderSystem.ts |
| timerEngine | managers | src/managers/timerEngine.ts |

Used by these functional components

None.

### todoLogPanel-handler (handlers)

- File: `src/handlers/todoLogPanel-handler.ts`
- Uses functional components: 2
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |
| trailViewer-handler | handlers | src/handlers/trailViewer-handler.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### tomAiChat-handler (handlers)

- File: `src/handlers/tomAiChat-handler.ts`
- Uses functional components: 2
- Used by functional components: 0

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatTodoSessionManager | managers | src/managers/chatTodoSessionManager.ts |
| tomAiChat-tools | tools | src/tools/tomAiChat-tools.ts |

Used by these functional components

None.

### tomScriptingBridge-handler (handlers)

- File: `src/handlers/tomScriptingBridge-handler.ts`
- Uses functional components: 5
- Used by functional components: 2

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |
| timerEngine | managers | src/managers/timerEngine.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| vscode-bridge | vscode-bridge.ts | src/vscode-bridge.ts |

### trailEditor-handler (handlers)

- File: `src/handlers/trailEditor-handler.ts`
- Uses functional components: 2
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### trailViewer-handler (handlers)

- File: `src/handlers/trailViewer-handler.ts`
- Uses functional components: 2
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| todoLogPanel-handler | handlers | src/handlers/todoLogPanel-handler.ts |

### windowStatusPanel-handler (handlers)

- File: `src/handlers/windowStatusPanel-handler.ts`
- Uses functional components: 0
- Used by functional components: 4

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| aiConversation-handler | handlers | src/handlers/aiConversation-handler.ts |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |

### wsPanel-handler (handlers)

- File: `src/handlers/wsPanel-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### yamlGraph-handler (handlers)

- File: `src/handlers/yamlGraph-handler.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### chatTodoSessionManager (managers)

- File: `src/managers/chatTodoSessionManager.ts`
- Uses functional components: 1
- Used by functional components: 2

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| todoProvider | managers | src/managers/todoProvider.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| tomAiChat-handler | handlers | src/handlers/tomAiChat-handler.ts |
| tool-executors | tools | src/tools/tool-executors.ts |

### chatVariablesStore (managers)

- File: `src/managers/chatVariablesStore.ts`
- Uses functional components: 0
- Used by functional components: 10

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| chatVariablesEditor-handler | handlers | src/handlers/chatVariablesEditor-handler.ts |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| queueEditor-handler | handlers | src/handlers/queueEditor-handler.ts |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |
| chatVariableResolvers | tools | src/tools/chatVariableResolvers.ts |
| tool-executors | tools | src/tools/tool-executors.ts |

### promptQueueManager (managers)

- File: `src/managers/promptQueueManager.ts`
- Uses functional components: 2
- Used by functional components: 6

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| windowStatusPanel-handler | handlers | src/handlers/windowStatusPanel-handler.ts |
| trailService | services | src/services/trailService.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| queueEditor-handler | handlers | src/handlers/queueEditor-handler.ts |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |
| reminderSystem | managers | src/managers/reminderSystem.ts |
| timerEngine | managers | src/managers/timerEngine.ts |

### questTodoManager (managers)

- File: `src/managers/questTodoManager.ts`
- Uses functional components: 0
- Used by functional components: 6

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesEditor-handler | handlers | src/handlers/chatVariablesEditor-handler.ts |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |
| trailEditor-handler | handlers | src/handlers/trailEditor-handler.ts |
| trailViewer-handler | handlers | src/handlers/trailViewer-handler.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |

### reminderSystem (managers)

- File: `src/managers/reminderSystem.ts`
- Uses functional components: 1
- Used by functional components: 5

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| queueEditor-handler | handlers | src/handlers/queueEditor-handler.ts |
| queueTemplateEditor-handler | handlers | src/handlers/queueTemplateEditor-handler.ts |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |

### sessionTodoStore (managers)

- File: `src/managers/sessionTodoStore.ts`
- Uses functional components: 1
- Used by functional components: 6

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| sidebarNotes-handler | handlers | src/handlers/sidebarNotes-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |
| todoProvider | managers | src/managers/todoProvider.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |

### timerEngine (managers)

- File: `src/managers/timerEngine.ts`
- Uses functional components: 2
- Used by functional components: 4

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |
| panelYamlStore | utils | src/utils/panelYamlStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| statusPage-handler | handlers | src/handlers/statusPage-handler.ts |
| timedRequestsEditor-handler | handlers | src/handlers/timedRequestsEditor-handler.ts |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |

### todoProvider (managers)

- File: `src/managers/todoProvider.ts`
- Uses functional components: 1
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatTodoSessionManager | managers | src/managers/chatTodoSessionManager.ts |

### trailService (services)

- File: `src/services/trailService.ts`
- Uses functional components: 0
- Used by functional components: 3

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| chatPanel-handler | handlers | src/handlers/chatPanel-handler.ts |
| promptQueueManager | managers | src/managers/promptQueueManager.ts |

### chat-enhancement-tools (tools)

- File: `src/tools/chat-enhancement-tools.ts`
- Uses functional components: 6
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| questTodoPanel-handler | handlers | src/handlers/questTodoPanel-handler.ts |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| questTodoManager | managers | src/managers/questTodoManager.ts |
| reminderSystem | managers | src/managers/reminderSystem.ts |
| sessionTodoStore | managers | src/managers/sessionTodoStore.ts |
| shared-tool-registry | tools | src/tools/shared-tool-registry.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| tool-executors | tools | src/tools/tool-executors.ts |

### chatVariableResolvers (tools)

- File: `src/tools/chatVariableResolvers.ts`
- Uses functional components: 1
- Used by functional components: 1

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |

### local-llm-tools-config (tools)

- File: `src/tools/local-llm-tools-config.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### shared-tool-registry (tools)

- File: `src/tools/shared-tool-registry.ts`
- Uses functional components: 0
- Used by functional components: 3

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |
| tomAiChat-tools | tools | src/tools/tomAiChat-tools.ts |
| tool-executors | tools | src/tools/tool-executors.ts |

### tomAiChat-tools (tools)

- File: `src/tools/tomAiChat-tools.ts`
- Uses functional components: 1
- Used by functional components: 2

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| shared-tool-registry | tools | src/tools/shared-tool-registry.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| tomAiChat-handler | handlers | src/handlers/tomAiChat-handler.ts |

### tool-executors (tools)

- File: `src/tools/tool-executors.ts`
- Uses functional components: 4
- Used by functional components: 2

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatTodoSessionManager | managers | src/managers/chatTodoSessionManager.ts |
| chatVariablesStore | managers | src/managers/chatVariablesStore.ts |
| chat-enhancement-tools | tools | src/tools/chat-enhancement-tools.ts |
| shared-tool-registry | tools | src/tools/shared-tool-registry.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| localLlm-handler | handlers | src/handlers/localLlm-handler.ts |

### baseWebviewProvider (utils)

- File: `src/utils/baseWebviewProvider.ts`
- Uses functional components: 0
- Used by functional components: 0

Uses these functional components

None.

Used by these functional components

None.

### panelYamlStore (utils)

- File: `src/utils/panelYamlStore.ts`
- Uses functional components: 0
- Used by functional components: 3

Uses these functional components

None.

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| chatVariablesEditor-handler | handlers | src/handlers/chatVariablesEditor-handler.ts |
| reusablePromptEditor-handler | handlers | src/handlers/reusablePromptEditor-handler.ts |
| timerEngine | managers | src/managers/timerEngine.ts |

### vscode-bridge (vscode-bridge.ts)

- File: `src/vscode-bridge.ts`
- Uses functional components: 1
- Used by functional components: 2

Uses these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| tomScriptingBridge-handler | handlers | src/handlers/tomScriptingBridge-handler.ts |

Used by these functional components

| Component | Subsystem | File |
| --- | --- | --- |
| extension | extension.ts | src/extension.ts |
| restartBridge-handler | handlers | src/handlers/restartBridge-handler.ts |
