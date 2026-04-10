# Module Structure and Relationships

This document shows which functional components use other functional components in the VS Code extension, based on internal TypeScript import relationships.

## Method and Scope

- Scope analyzed: all TypeScript modules under src/.
- Relationship signal: static internal imports that resolve to source files in this package.
- Graph size: 107 source files, 251 internal imports, 12 functional components, 65 component-to-component edges.

## Functional Components

| Component | Outgoing dependencies | Incoming dependencies |
| --- | --- | --- |
| Bridge, Execution, CLI, and Integrations | 41 | 18 |
| Chat, Copilot, and Local LLM Flows | 60 | 28 |
| Core Extension Wiring | 30 | 47 |
| General Handlers | 20 | 21 |
| Queue, Timed Requests, and Scheduling | 31 | 27 |
| Shared Infrastructure and Contracts | 6 | 61 |
| State Managers and Coordination | 0 | 0 |
| Todo, Notes, and Work Tracking | 22 | 13 |
| Tooling Surface and Model Tools | 9 | 9 |
| Trail and Markdown Views | 10 | 20 |
| Window Layout, Panels, and UI Shell | 21 | 7 |
| YAML Graph and Diagram Editing | 1 | 0 |

## Top Cross-Component Dependencies

| Using component | Used component | Import links | Evidence examples |
| --- | --- | --- | --- |
| Bridge, Execution, CLI, and Integrations | Core Extension Wiring | 18 | src/handlers/chat/telegram-channel.ts -> src/handlers/handler_shared.ts; src/handlers/cliServer-handler.ts -> src/handlers/handler_shared.ts |
| Queue, Timed Requests, and Scheduling | Queue, Timed Requests, and Scheduling | 17 | src/handlers/queueEditor-handler.ts -> src/managers/promptQueueManager.ts; src/handlers/queueEditor-handler.ts -> src/managers/reminderSystem.ts |
| Chat, Copilot, and Local LLM Flows | Shared Infrastructure and Contracts | 14 | src/handlers/aiConversation-handler.ts -> src/utils/workspacePaths.ts; src/handlers/chatPanel-handler.ts -> src/utils/debugLogger.ts |
| Chat, Copilot, and Local LLM Flows | Chat, Copilot, and Local LLM Flows | 13 | src/handlers/__tests__/tomAiChat-utils.test.ts -> src/handlers/tomAiChat-utils.ts; src/handlers/aiConversation-handler.ts -> src/utils/sendToChatConfig.ts |
| Bridge, Execution, CLI, and Integrations | Bridge, Execution, CLI, and Integrations | 9 | src/handlers/chat/telegram-channel.ts -> src/handlers/telegram-notifier.ts; src/handlers/restartBridge-handler.ts -> src/vscode-bridge.ts |
| Trail and Markdown Views | Shared Infrastructure and Contracts | 8 | src/handlers/trailEditor-handler.ts -> src/utils/workspacePaths.ts; src/handlers/trailEditor-handler.ts -> src/utils/debugLogger.ts |
| Chat, Copilot, and Local LLM Flows | Core Extension Wiring | 7 | src/handlers/aiConversation-handler.ts -> src/handlers/handler_shared.ts; src/handlers/aiConversation-handler.ts -> src/handlers/chat/index.ts |
| Core Extension Wiring | Shared Infrastructure and Contracts | 7 | src/extension.ts -> src/utils/debugLogger.ts; src/extension.ts -> src/utils/tomAiConfiguration.ts |
| Todo, Notes, and Work Tracking | Shared Infrastructure and Contracts | 7 | src/handlers/questTodoEditor-handler.ts -> src/utils/workspacePaths.ts; src/handlers/questTodoPanel-handler.ts -> src/utils/workspacePaths.ts |
| Bridge, Execution, CLI, and Integrations | Shared Infrastructure and Contracts | 6 | src/handlers/commandline-handler.ts -> src/utils/projectDetector.ts; src/handlers/commandline-handler.ts -> src/utils/executableResolver.ts |
| Chat, Copilot, and Local LLM Flows | General Handlers | 6 | src/handlers/aiConversation-handler.ts -> src/handlers/promptTemplate.ts; src/handlers/chatPanel-handler.ts -> src/handlers/globalTemplateEditor-handler.ts |
| Chat, Copilot, and Local LLM Flows | Trail and Markdown Views | 6 | src/handlers/aiConversation-handler.ts -> src/services/trailLogging.ts; src/handlers/chatPanel-handler.ts -> src/handlers/markdownHtmlPreview.ts |
| General Handlers | Core Extension Wiring | 6 | src/handlers/combinedCommand-handler.ts -> src/handlers/handler_shared.ts; src/handlers/debugLogging-handler.ts -> src/handlers/handler_shared.ts |
| General Handlers | Shared Infrastructure and Contracts | 6 | src/handlers/combinedCommand-handler.ts -> src/utils/fsUtils.ts; src/handlers/contextSettingsEditor-handler.ts -> src/utils/workspacePaths.ts |
| Chat, Copilot, and Local LLM Flows | Todo, Notes, and Work Tracking | 5 | src/handlers/chatVariablesEditor-handler.ts -> src/managers/questTodoManager.ts; src/managers/chatTodoSessionManager.ts -> src/managers/todoProvider.ts |
| Chat, Copilot, and Local LLM Flows | Tooling Surface and Model Tools | 5 | src/handlers/localLlm-handler.ts -> src/tools/shared-tool-registry.ts; src/handlers/localLlm-handler.ts -> src/tools/tool-executors.ts |
| General Handlers | General Handlers | 5 | src/handlers/contextSettingsEditor-handler.ts -> src/handlers/globalTemplateEditor-handler.ts; src/handlers/contextSettingsEditor-handler.ts -> src/handlers/promptTemplate.ts |
| Queue, Timed Requests, and Scheduling | Core Extension Wiring | 5 | src/handlers/queueEditor-handler.ts -> src/handlers/handler_shared.ts; src/handlers/queueTemplateEditor-handler.ts -> src/handlers/handler_shared.ts |
| Shared Infrastructure and Contracts | Shared Infrastructure and Contracts | 5 | src/utils/projectDetector.ts -> src/utils/workspacePaths.ts; src/utils/tomAiConfiguration.ts -> src/utils/fsUtils.ts |
| Todo, Notes, and Work Tracking | Todo, Notes, and Work Tracking | 5 | src/handlers/sidebarNotes-handler.ts -> src/managers/sessionTodoStore.ts; src/handlers/sidebarNotes-handler.ts -> src/handlers/questTodoPanel-handler.ts |

## Dependency Matrix

| From \ To | Bridge, Execution, CLI, and Integrations | Chat, Copilot, and Local LLM Flows | Core Extension Wiring | General Handlers | Queue, Timed Requests, and Scheduling | Shared Infrastructure and Contracts | State Managers and Coordination | Todo, Notes, and Work Tracking | Tooling Surface and Model Tools | Trail and Markdown Views | Window Layout, Panels, and UI Shell | YAML Graph and Diagram Editing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bridge, Execution, CLI, and Integrations | 9 | 2 | 18 | 0 | 2 | 6 | 0 | 0 | 0 | 4 | 0 | 0 |
| Chat, Copilot, and Local LLM Flows | 1 | 13 | 7 | 6 | 1 | 14 | 0 | 5 | 5 | 6 | 2 | 0 |
| Core Extension Wiring | 4 | 4 | 1 | 1 | 4 | 7 | 0 | 3 | 1 | 3 | 2 | 0 |
| General Handlers | 0 | 1 | 6 | 5 | 0 | 6 | 0 | 0 | 0 | 1 | 1 | 0 |
| Queue, Timed Requests, and Scheduling | 0 | 2 | 5 | 3 | 17 | 1 | 0 | 0 | 0 | 1 | 2 | 0 |
| Shared Infrastructure and Contracts | 0 | 0 | 1 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| State Managers and Coordination | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Todo, Notes, and Work Tracking | 0 | 3 | 2 | 3 | 0 | 7 | 0 | 5 | 0 | 2 | 0 | 0 |
| Tooling Surface and Model Tools | 0 | 2 | 1 | 1 | 0 | 2 | 0 | 0 | 2 | 1 | 0 | 0 |
| Trail and Markdown Views | 0 | 0 | 1 | 0 | 0 | 8 | 0 | 0 | 0 | 1 | 0 | 0 |
| Window Layout, Panels, and UI Shell | 4 | 1 | 4 | 2 | 3 | 5 | 0 | 0 | 1 | 1 | 0 | 0 |
| YAML Graph and Diagram Editing | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Per-Component Relationship View

### Bridge, Execution, CLI, and Integrations

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| TelegramChannel | class | src/handlers/chat/telegram-channel.ts:57 |
| TelegramCommandRegistry | class | src/handlers/telegram-cmd-parser.ts:87 |
| TelegramResponseFormatter | class | src/handlers/telegram-cmd-response.ts:36 |
| TelegramNotifier | class | src/handlers/telegram-notifier.ts:90 |
| TomScriptingBridgeHandler | class | src/handlers/tomScriptingBridge-handler.ts:43 |
| DartBridgeClient | class | src/vscode-bridge.ts:95 |
| CwdMode | type | src/handlers/commandline-handler.ts:37 |
| CommandlineEntry | interface | src/handlers/commandline-handler.ts:39 |
| PostActionDefinition | interface | src/handlers/commandline-handler.ts:65 |
| BridgeProfile | interface | src/handlers/restartBridge-handler.ts:28 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Core Extension Wiring | 18 | src/handlers/chat/telegram-channel.ts -> src/handlers/handler_shared.ts |
| Bridge, Execution, CLI, and Integrations | 9 | src/handlers/chat/telegram-channel.ts -> src/handlers/telegram-notifier.ts |
| Shared Infrastructure and Contracts | 6 | src/handlers/commandline-handler.ts -> src/utils/projectDetector.ts |
| Trail and Markdown Views | 4 | src/handlers/chat/telegram-channel.ts -> src/handlers/telegram-markdown.ts |
| Chat, Copilot, and Local LLM Flows | 2 | src/handlers/chat/telegram-channel.ts -> src/handlers/chat/chat-channel.ts |
| Queue, Timed Requests, and Scheduling | 2 | src/handlers/tomScriptingBridge-handler.ts -> src/managers/promptQueueManager.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Bridge, Execution, CLI, and Integrations | 9 | src/handlers/chat/telegram-channel.ts -> src/handlers/telegram-notifier.ts |
| Core Extension Wiring | 4 | src/extension.ts -> src/vscode-bridge.ts |
| Window Layout, Panels, and UI Shell | 4 | src/handlers/statusPage-handler.ts -> src/handlers/cliServer-handler.ts |
| Chat, Copilot, and Local LLM Flows | 1 | src/handlers/aiConversation-handler.ts -> src/handlers/telegram-notifier.ts |

### Chat, Copilot, and Local LLM Flows

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| AiConversationManager | class | src/handlers/aiConversation-handler.ts:332 |
| SendToChatAdvancedManager | class | src/handlers/copilotTemplates-handler.ts:53 |
| LocalLlmManager | class | src/handlers/localLlm-handler.ts:251 |
| ChatTodoSessionManager | class | src/managers/chatTodoSessionManager.ts:21 |
| ChatVariablesStore | class | src/managers/chatVariablesStore.ts:55 |
| CopilotResponse | interface | src/handlers/aiConversation-handler.ts:55 |
| ConversationExchange | interface | src/handlers/aiConversation-handler.ts:71 |
| HistoryMode | type | src/handlers/aiConversation-handler.ts:85 |
| ConversationMode | type | src/handlers/aiConversation-handler.ts:88 |
| ActorType | type | src/handlers/aiConversation-handler.ts:91 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 14 | src/handlers/aiConversation-handler.ts -> src/utils/workspacePaths.ts |
| Chat, Copilot, and Local LLM Flows | 13 | src/handlers/__tests__/tomAiChat-utils.test.ts -> src/handlers/tomAiChat-utils.ts |
| Core Extension Wiring | 7 | src/handlers/aiConversation-handler.ts -> src/handlers/handler_shared.ts |
| General Handlers | 6 | src/handlers/aiConversation-handler.ts -> src/handlers/promptTemplate.ts |
| Trail and Markdown Views | 6 | src/handlers/aiConversation-handler.ts -> src/services/trailLogging.ts |
| Todo, Notes, and Work Tracking | 5 | src/handlers/chatVariablesEditor-handler.ts -> src/managers/questTodoManager.ts |
| Tooling Surface and Model Tools | 5 | src/handlers/localLlm-handler.ts -> src/tools/shared-tool-registry.ts |
| Window Layout, Panels, and UI Shell | 2 | src/handlers/chatPanel-handler.ts -> src/handlers/accordionPanel.ts |
| Bridge, Execution, CLI, and Integrations | 1 | src/handlers/aiConversation-handler.ts -> src/handlers/telegram-notifier.ts |
| Queue, Timed Requests, and Scheduling | 1 | src/tools/chat-enhancement-tools.ts -> src/managers/reminderSystem.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 13 | src/handlers/__tests__/tomAiChat-utils.test.ts -> src/handlers/tomAiChat-utils.ts |
| Core Extension Wiring | 4 | src/extension.ts -> src/tools/tomAiChat-tools.ts |
| Todo, Notes, and Work Tracking | 3 | src/handlers/questTodoPanel-handler.ts -> src/utils/sendToChatConfig.ts |
| Bridge, Execution, CLI, and Integrations | 2 | src/handlers/chat/telegram-channel.ts -> src/handlers/chat/chat-channel.ts |
| Queue, Timed Requests, and Scheduling | 2 | src/handlers/queueEditor-handler.ts -> src/managers/chatVariablesStore.ts |
| Tooling Surface and Model Tools | 2 | src/tools/tool-executors.ts -> src/managers/chatTodoSessionManager.ts |
| General Handlers | 1 | src/handlers/globalTemplateEditor-handler.ts -> src/utils/sendToChatConfig.ts |
| Window Layout, Panels, and UI Shell | 1 | src/handlers/statusPage-handler.ts -> src/utils/sendToChatConfig.ts |

### Core Extension Wiring

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| BridgeTestRunner | class | src/tests.ts:27 |
| DocumentPickerConfig | interface | src/handlers/documentPicker.ts:19 |
| DocPickerGroup | interface | src/handlers/documentPicker.ts:36 |
| DocPickerProject | interface | src/handlers/documentPicker.ts:41 |
| TemplateEditorField | interface | src/handlers/handler_shared.ts:740 |
| TemplateEditorConfig | interface | src/handlers/handler_shared.ts:750 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 7 | src/extension.ts -> src/utils/debugLogger.ts |
| Bridge, Execution, CLI, and Integrations | 4 | src/extension.ts -> src/vscode-bridge.ts |
| Chat, Copilot, and Local LLM Flows | 4 | src/extension.ts -> src/tools/tomAiChat-tools.ts |
| Queue, Timed Requests, and Scheduling | 4 | src/extension.ts -> src/storage/queueFileStorage.ts |
| Todo, Notes, and Work Tracking | 3 | src/extension.ts -> src/handlers/questTodoEditor-handler.ts |
| Trail and Markdown Views | 3 | src/extension.ts -> src/handlers/markdownBrowser-handler.ts |
| Window Layout, Panels, and UI Shell | 2 | src/extension.ts -> src/handlers/windowStatusPanel-handler.ts |
| Core Extension Wiring | 1 | src/extension.ts -> src/handlers/index.ts |
| General Handlers | 1 | src/handlers/handler_shared.ts -> src/handlers/promptTemplate.ts |
| Tooling Surface and Model Tools | 1 | src/extension.ts -> src/tools/tool-executors.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Bridge, Execution, CLI, and Integrations | 18 | src/handlers/chat/telegram-channel.ts -> src/handlers/handler_shared.ts |
| Chat, Copilot, and Local LLM Flows | 7 | src/handlers/aiConversation-handler.ts -> src/handlers/handler_shared.ts |
| General Handlers | 6 | src/handlers/combinedCommand-handler.ts -> src/handlers/handler_shared.ts |
| Queue, Timed Requests, and Scheduling | 5 | src/handlers/queueEditor-handler.ts -> src/handlers/handler_shared.ts |
| Window Layout, Panels, and UI Shell | 4 | src/handlers/chordMenu-handler.ts -> src/handlers/handler_shared.ts |
| Todo, Notes, and Work Tracking | 2 | src/handlers/questTodoPanel-handler.ts -> src/handlers/handler_shared.ts |
| Core Extension Wiring | 1 | src/extension.ts -> src/handlers/index.ts |
| Shared Infrastructure and Contracts | 1 | src/utils/projectDetector.ts -> src/handlers/handler_shared.ts |
| Tooling Surface and Model Tools | 1 | src/tools/tool-executors.ts -> src/handlers/handler_shared.ts |
| Trail and Markdown Views | 1 | src/handlers/trailViewer-handler.ts -> src/handlers/handler_shared.ts |
| YAML Graph and Diagram Editing | 1 | src/handlers/yamlGraph-handler.ts -> src/handlers/handler_shared.ts |

### General Handlers

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| GitHubIssueProvider | class | src/handlers/githubIssueProvider.ts:39 |
| GitHubUser | interface | src/handlers/githubApi.ts:16 |
| GitHubLabel | interface | src/handlers/githubApi.ts:21 |
| GitHubIssue | interface | src/handlers/githubApi.ts:28 |
| GitHubComment | interface | src/handlers/githubApi.ts:42 |
| RepoInfo | interface | src/handlers/githubApi.ts:53 |
| TemplateCategory | type | src/handlers/globalTemplateEditor-handler.ts:27 |
| IssueProviderRepo | interface | src/handlers/issueProvider.ts:14 |
| IssueUser | interface | src/handlers/issueProvider.ts:21 |
| IssueItem | interface | src/handlers/issueProvider.ts:26 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Core Extension Wiring | 6 | src/handlers/combinedCommand-handler.ts -> src/handlers/handler_shared.ts |
| Shared Infrastructure and Contracts | 6 | src/handlers/combinedCommand-handler.ts -> src/utils/fsUtils.ts |
| General Handlers | 5 | src/handlers/contextSettingsEditor-handler.ts -> src/handlers/globalTemplateEditor-handler.ts |
| Chat, Copilot, and Local LLM Flows | 1 | src/handlers/globalTemplateEditor-handler.ts -> src/utils/sendToChatConfig.ts |
| Trail and Markdown Views | 1 | src/handlers/reusablePromptEditor-handler.ts -> src/handlers/markdownHtmlPreview.ts |
| Window Layout, Panels, and UI Shell | 1 | src/handlers/reusablePromptEditor-handler.ts -> src/utils/panelYamlStore.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 6 | src/handlers/aiConversation-handler.ts -> src/handlers/promptTemplate.ts |
| General Handlers | 5 | src/handlers/contextSettingsEditor-handler.ts -> src/handlers/globalTemplateEditor-handler.ts |
| Queue, Timed Requests, and Scheduling | 3 | src/handlers/queueEditor-handler.ts -> src/handlers/globalTemplateEditor-handler.ts |
| Todo, Notes, and Work Tracking | 3 | src/handlers/questTodoPanel-handler.ts -> src/handlers/promptTemplate.ts |
| Window Layout, Panels, and UI Shell | 2 | src/handlers/issuesPanel-handler.ts -> src/handlers/issueProvider.ts |
| Core Extension Wiring | 1 | src/handlers/handler_shared.ts -> src/handlers/promptTemplate.ts |
| Tooling Surface and Model Tools | 1 | src/tools/tool-executors.ts -> src/handlers/promptTemplate.ts |

### Queue, Timed Requests, and Scheduling

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| PromptQueueManager | class | src/managers/promptQueueManager.ts:159 |
| ReminderSystem | class | src/managers/reminderSystem.ts:51 |
| TimerEngine | class | src/managers/timerEngine.ts:73 |
| QueuedPromptStatus | type | src/managers/promptQueueManager.ts:51 |
| QueuedPromptType | type | src/managers/promptQueueManager.ts:52 |
| QueuedFollowUpPrompt | interface | src/managers/promptQueueManager.ts:54 |
| QueuedPrePrompt | interface | src/managers/promptQueueManager.ts:65 |
| QueuedPrompt | interface | src/managers/promptQueueManager.ts:71 |
| ReminderTemplate | interface | src/managers/reminderSystem.ts:20 |
| ReminderConfig | interface | src/managers/reminderSystem.ts:27 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Queue, Timed Requests, and Scheduling | 17 | src/handlers/queueEditor-handler.ts -> src/managers/promptQueueManager.ts |
| Core Extension Wiring | 5 | src/handlers/queueEditor-handler.ts -> src/handlers/handler_shared.ts |
| General Handlers | 3 | src/handlers/queueEditor-handler.ts -> src/handlers/globalTemplateEditor-handler.ts |
| Chat, Copilot, and Local LLM Flows | 2 | src/handlers/queueEditor-handler.ts -> src/managers/chatVariablesStore.ts |
| Window Layout, Panels, and UI Shell | 2 | src/managers/promptQueueManager.ts -> src/handlers/windowStatusPanel-handler.ts |
| Shared Infrastructure and Contracts | 1 | src/managers/promptQueueManager.ts -> src/utils/debugLogger.ts |
| Trail and Markdown Views | 1 | src/managers/promptQueueManager.ts -> src/services/trailService.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Queue, Timed Requests, and Scheduling | 17 | src/handlers/queueEditor-handler.ts -> src/managers/promptQueueManager.ts |
| Core Extension Wiring | 4 | src/extension.ts -> src/storage/queueFileStorage.ts |
| Window Layout, Panels, and UI Shell | 3 | src/handlers/statusPage-handler.ts -> src/managers/timerEngine.ts |
| Bridge, Execution, CLI, and Integrations | 2 | src/handlers/tomScriptingBridge-handler.ts -> src/managers/promptQueueManager.ts |
| Chat, Copilot, and Local LLM Flows | 1 | src/tools/chat-enhancement-tools.ts -> src/managers/reminderSystem.ts |

### Shared Infrastructure and Contracts

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| BaseWebviewProvider | class | src/utils/baseWebviewProvider.ts:3 |
| FsUtils | class | src/utils/fsUtils.ts:5 |
| TomAiConfiguration | class | src/utils/tomAiConfiguration.ts:41 |
| WsPaths | class | src/utils/workspacePaths.ts:116 |
| WebviewMessage | interface | src/types/webviewMessages.ts:1 |
| ChatPanelSendMessage | interface | src/types/webviewMessages.ts:6 |
| ChatPanelDraftMessage | interface | src/types/webviewMessages.ts:13 |
| TodoPanelMessage | interface | src/types/webviewMessages.ts:19 |
| PlatformKey | type | src/utils/executableResolver.ts:24 |
| ExecutableConfig | interface | src/utils/executableResolver.ts:30 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 5 | src/utils/projectDetector.ts -> src/utils/workspacePaths.ts |
| Core Extension Wiring | 1 | src/utils/projectDetector.ts -> src/handlers/handler_shared.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 14 | src/handlers/aiConversation-handler.ts -> src/utils/workspacePaths.ts |
| Trail and Markdown Views | 8 | src/handlers/trailEditor-handler.ts -> src/utils/workspacePaths.ts |
| Core Extension Wiring | 7 | src/extension.ts -> src/utils/debugLogger.ts |
| Todo, Notes, and Work Tracking | 7 | src/handlers/questTodoEditor-handler.ts -> src/utils/workspacePaths.ts |
| Bridge, Execution, CLI, and Integrations | 6 | src/handlers/commandline-handler.ts -> src/utils/projectDetector.ts |
| General Handlers | 6 | src/handlers/combinedCommand-handler.ts -> src/utils/fsUtils.ts |
| Shared Infrastructure and Contracts | 5 | src/utils/projectDetector.ts -> src/utils/workspacePaths.ts |
| Window Layout, Panels, and UI Shell | 5 | src/handlers/chordMenu-handler.ts -> src/utils/fsUtils.ts |
| Tooling Surface and Model Tools | 2 | src/tools/local-llm-tools-config.ts -> src/utils/workspacePaths.ts |
| Queue, Timed Requests, and Scheduling | 1 | src/managers/promptQueueManager.ts -> src/utils/debugLogger.ts |

### State Managers and Coordination

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| n/a | n/a | n/a |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| none | 0 | n/a |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| none | 0 | n/a |

### Todo, Notes, and Work Tracking

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| QuestTodoEmbeddedViewProvider | class | src/handlers/questTodoPanel-handler.ts:3954 |
| TodoLogViewProvider | class | src/handlers/todoLogPanel-handler.ts:45 |
| SessionTodoStore | class | src/managers/sessionTodoStore.ts:54 |
| TodoProvider | class | src/managers/todoProvider.ts:40 |
| QuestTodoViewConfig | interface | src/handlers/questTodoPanel-handler.ts:82 |
| QuestTodoScope | interface | src/managers/questTodoManager.ts:27 |
| QuestTodoReference | interface | src/managers/questTodoManager.ts:35 |
| QuestTodoItem | interface | src/managers/questTodoManager.ts:43 |
| QuestTodoFile | interface | src/managers/questTodoManager.ts:63 |
| ScannedProject | interface | src/managers/questTodoManager.ts:859 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 7 | src/handlers/questTodoEditor-handler.ts -> src/utils/workspacePaths.ts |
| Todo, Notes, and Work Tracking | 5 | src/handlers/sidebarNotes-handler.ts -> src/managers/sessionTodoStore.ts |
| Chat, Copilot, and Local LLM Flows | 3 | src/handlers/questTodoPanel-handler.ts -> src/utils/sendToChatConfig.ts |
| General Handlers | 3 | src/handlers/questTodoPanel-handler.ts -> src/handlers/promptTemplate.ts |
| Core Extension Wiring | 2 | src/handlers/questTodoPanel-handler.ts -> src/handlers/handler_shared.ts |
| Trail and Markdown Views | 2 | src/handlers/sidebarNotes-handler.ts -> src/services/trailLogging.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 5 | src/handlers/chatVariablesEditor-handler.ts -> src/managers/questTodoManager.ts |
| Todo, Notes, and Work Tracking | 5 | src/handlers/sidebarNotes-handler.ts -> src/managers/sessionTodoStore.ts |
| Core Extension Wiring | 3 | src/extension.ts -> src/handlers/questTodoEditor-handler.ts |

### Tooling Surface and Model Tools

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| AskCopilotConfig | interface | src/tools/local-llm-tools-config.ts:12 |
| AskBigBrotherConfig | interface | src/tools/local-llm-tools-config.ts:23 |
| LocalLlmToolsConfig | interface | src/tools/local-llm-tools-config.ts:40 |
| SharedToolDefinition | interface | src/tools/shared-tool-registry.ts:21 |
| OllamaTool | interface | src/tools/shared-tool-registry.ts:58 |
| OllamaToolCall | interface | src/tools/shared-tool-registry.ts:68 |
| ReadFileInput | interface | src/tools/tool-executors.ts:66 |
| ListDirectoryInput | interface | src/tools/tool-executors.ts:107 |
| FindFilesInput | interface | src/tools/tool-executors.ts:139 |
| FindTextInFilesInput | interface | src/tools/tool-executors.ts:171 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 2 | src/tools/tool-executors.ts -> src/managers/chatTodoSessionManager.ts |
| Shared Infrastructure and Contracts | 2 | src/tools/local-llm-tools-config.ts -> src/utils/workspacePaths.ts |
| Tooling Surface and Model Tools | 2 | src/tools/tool-executors.ts -> src/tools/shared-tool-registry.ts |
| Core Extension Wiring | 1 | src/tools/tool-executors.ts -> src/handlers/handler_shared.ts |
| General Handlers | 1 | src/tools/tool-executors.ts -> src/handlers/promptTemplate.ts |
| Trail and Markdown Views | 1 | src/tools/tool-executors.ts -> src/services/trailLogging.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 5 | src/handlers/localLlm-handler.ts -> src/tools/shared-tool-registry.ts |
| Tooling Surface and Model Tools | 2 | src/tools/tool-executors.ts -> src/tools/shared-tool-registry.ts |
| Core Extension Wiring | 1 | src/extension.ts -> src/tools/tool-executors.ts |
| Window Layout, Panels, and UI Shell | 1 | src/handlers/statusPage-handler.ts -> src/tools/local-llm-tools-config.ts |

### Trail and Markdown Views

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| TrailService | class | src/services/trailService.ts:36 |
| MarkdownHtmlPreviewOptions | interface | src/handlers/markdownHtmlPreview.ts:3 |
| TrailEntry | interface | src/handlers/trailEditor-handler.ts:24 |
| TrailSet | interface | src/handlers/trailEditor-handler.ts:229 |
| TrailFile | interface | src/handlers/trailViewer-handler.ts:34 |
| TrailExchange | interface | src/handlers/trailViewer-handler.ts:41 |
| ParsedTrailFile | interface | src/handlers/trailViewer-handler.ts:54 |
| TrailType | type | src/services/trailLogging.ts:7 |
| TrailSubsystem | type | src/services/trailService.ts:8 |
| TrailMetadata | interface | src/services/trailService.ts:13 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 8 | src/handlers/trailEditor-handler.ts -> src/utils/workspacePaths.ts |
| Core Extension Wiring | 1 | src/handlers/trailViewer-handler.ts -> src/handlers/handler_shared.ts |
| Trail and Markdown Views | 1 | src/services/trailLogging.ts -> src/services/trailService.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 6 | src/handlers/aiConversation-handler.ts -> src/services/trailLogging.ts |
| Bridge, Execution, CLI, and Integrations | 4 | src/handlers/chat/telegram-channel.ts -> src/handlers/telegram-markdown.ts |
| Core Extension Wiring | 3 | src/extension.ts -> src/handlers/markdownBrowser-handler.ts |
| Todo, Notes, and Work Tracking | 2 | src/handlers/sidebarNotes-handler.ts -> src/services/trailLogging.ts |
| General Handlers | 1 | src/handlers/reusablePromptEditor-handler.ts -> src/handlers/markdownHtmlPreview.ts |
| Queue, Timed Requests, and Scheduling | 1 | src/managers/promptQueueManager.ts -> src/services/trailService.ts |
| Tooling Surface and Model Tools | 1 | src/tools/tool-executors.ts -> src/services/trailLogging.ts |
| Trail and Markdown Views | 1 | src/services/trailLogging.ts -> src/services/trailService.ts |
| Window Layout, Panels, and UI Shell | 1 | src/handlers/statusPage-handler.ts -> src/services/trailLogging.ts |

### Window Layout, Panels, and UI Shell

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| WindowStatusViewProvider | class | src/handlers/windowStatusPanel-handler.ts:89 |
| WsPanelHandler | class | src/handlers/wsPanel-handler.ts:49 |
| AccordionSection | interface | src/handlers/accordionPanel.ts:19 |
| AccordionPanelConfig | interface | src/handlers/accordionPanel.ts:31 |
| PanelMode | type | src/handlers/issuesPanel-handler.ts:28 |
| FavoriteEntry | interface | src/handlers/statusPage-handler.ts:41 |
| LlmConfiguration | interface | src/handlers/statusPage-handler.ts:57 |
| AiConversationSetup | interface | src/handlers/statusPage-handler.ts:81 |
| StatusData | interface | src/handlers/statusPage-handler.ts:727 |
| TabSection | interface | src/handlers/tabPanel.ts:19 |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Shared Infrastructure and Contracts | 5 | src/handlers/chordMenu-handler.ts -> src/utils/fsUtils.ts |
| Bridge, Execution, CLI, and Integrations | 4 | src/handlers/statusPage-handler.ts -> src/handlers/cliServer-handler.ts |
| Core Extension Wiring | 4 | src/handlers/chordMenu-handler.ts -> src/handlers/handler_shared.ts |
| Queue, Timed Requests, and Scheduling | 3 | src/handlers/statusPage-handler.ts -> src/managers/timerEngine.ts |
| General Handlers | 2 | src/handlers/issuesPanel-handler.ts -> src/handlers/issueProvider.ts |
| Chat, Copilot, and Local LLM Flows | 1 | src/handlers/statusPage-handler.ts -> src/utils/sendToChatConfig.ts |
| Tooling Surface and Model Tools | 1 | src/handlers/statusPage-handler.ts -> src/tools/local-llm-tools-config.ts |
| Trail and Markdown Views | 1 | src/handlers/statusPage-handler.ts -> src/services/trailLogging.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| Chat, Copilot, and Local LLM Flows | 2 | src/handlers/chatPanel-handler.ts -> src/handlers/accordionPanel.ts |
| Core Extension Wiring | 2 | src/extension.ts -> src/handlers/windowStatusPanel-handler.ts |
| Queue, Timed Requests, and Scheduling | 2 | src/managers/promptQueueManager.ts -> src/handlers/windowStatusPanel-handler.ts |
| General Handlers | 1 | src/handlers/reusablePromptEditor-handler.ts -> src/utils/panelYamlStore.ts |

### YAML Graph and Diagram Editing

Functional components in this area

| Declaration | Kind | Location |
| --- | --- | --- |
| n/a | n/a | n/a |

Uses these functional components

| Used component | Import links | Example file-level usage |
| --- | --- | --- |
| Core Extension Wiring | 1 | src/handlers/yamlGraph-handler.ts -> src/handlers/handler_shared.ts |

Used by these functional components

| Using component | Import links | Example file-level usage |
| --- | --- | --- |
| none | 0 | n/a |

## Review Notes

- Shared Infrastructure and Contracts is the central dependency target (highest incoming links), so changes there have broad impact across feature components.
- Chat, Copilot, and Local LLM Flows has the highest outgoing coupling and should be treated as a primary integration hotspot during refactors.
- Core Extension Wiring is a major integration hub and transitive dependency anchor for many components through handler_shared and extension activation wiring.
