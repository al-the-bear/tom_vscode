# Code Structure: Classes and Types

This document analyzes the extension source and inventories all class/type declarations with component mapping and scope classification.

## Classification Rules

- `shared`: declaration is exported from its module and intended to be reused across files/components.
- `component-private`: declaration is not exported and acts as a local subcomponent/helper for one file or feature slice.
- `functional-component`: higher-level declaration driving behavior (all classes and exported feature contracts).
- `shared-helper` and `private-subcomponent`: narrower helper contracts used to support functional components.

## Inventory Totals

- Total declarations: 303
- Classes: 44
- Interfaces: 225
- Type aliases: 34
- Shared declarations: 205
- Component-private declarations: 98

## Shared Foundational Contracts and Helpers

| Declaration | Kind | Role | File | Scope |
| --- | --- | --- | --- | --- |
| TrailType | type | shared-helper | src/services/trailLogging.ts:7 | shared |
| TrailSubsystem | type | shared-helper | src/services/trailService.ts:8 | shared |
| TrailMetadata | interface | shared-helper | src/services/trailService.ts:13 | shared |
| TrailService | class | functional-component | src/services/trailService.ts:36 | shared |
| QueueReminderConfig | interface | shared-helper | src/storage/queueFileStorage.ts:60 | shared |
| QueueExecutionState | interface | shared-helper | src/storage/queueFileStorage.ts:71 | shared |
| QueuePromptRef | type | shared-helper | src/storage/queueFileStorage.ts:80 | shared |
| QueuePromptYaml | interface | shared-helper | src/storage/queueFileStorage.ts:83 | shared |
| QueueMetaYaml | interface | shared-helper | src/storage/queueFileStorage.ts:112 | shared |
| QueueFileYaml | interface | shared-helper | src/storage/queueFileStorage.ts:131 | shared |
| QueueEntryFile | interface | shared-helper | src/storage/queueFileStorage.ts:137 | shared |
| QueueTemplateFile | interface | shared-helper | src/storage/queueFileStorage.ts:149 | shared |
| QueueReloadAfterReloadSetting | interface | shared-helper | src/storage/queueFileStorage.ts:202 | shared |
| QueueSettings | interface | shared-helper | src/storage/queueFileStorage.ts:209 | shared |
| WebviewMessage | interface | shared-helper | src/types/webviewMessages.ts:1 | shared |
| ChatPanelSendMessage | interface | shared-helper | src/types/webviewMessages.ts:6 | shared |
| ChatPanelDraftMessage | interface | shared-helper | src/types/webviewMessages.ts:13 | shared |
| TodoPanelMessage | interface | shared-helper | src/types/webviewMessages.ts:19 | shared |
| BaseWebviewProvider | class | functional-component | src/utils/baseWebviewProvider.ts:3 | shared |
| PlatformKey | type | shared-helper | src/utils/executableResolver.ts:24 | shared |
| ExecutableConfig | interface | shared-helper | src/utils/executableResolver.ts:30 | shared |
| ExecutablesConfig | interface | shared-helper | src/utils/executableResolver.ts:37 | shared |
| ConfigPlaceholderContext | interface | shared-helper | src/utils/executableResolver.ts:45 | shared |
| ApplicationMapping | interface | shared-helper | src/utils/executableResolver.ts:57 | shared |
| ExternalApplicationsConfig | interface | shared-helper | src/utils/executableResolver.ts:71 | shared |
| FsUtils | class | functional-component | src/utils/fsUtils.ts:5 | shared |
| ResolvedLink | interface | shared-helper | src/utils/linkResolver.ts:26 | shared |
| LinkType | type | shared-helper | src/utils/linkResolver.ts:50 | shared |
| LinkAction | type | shared-helper | src/utils/linkResolver.ts:65 | shared |
| LinkContext | interface | shared-helper | src/utils/linkResolver.ts:77 | shared |
| LinkHandler | interface | shared-helper | src/utils/linkResolver.ts:86 | shared |
| DetectorContainsRule | interface | shared-helper | src/utils/projectDetector.ts:7 | shared |
| ProjectDetectionRule | interface | shared-helper | src/utils/projectDetector.ts:14 | shared |
| ProjectDetector | interface | shared-helper | src/utils/projectDetector.ts:20 | shared |
| ProjectDetectorConfig | interface | shared-helper | src/utils/projectDetector.ts:26 | shared |
| ProjectDetectionResult | interface | shared-helper | src/utils/projectDetector.ts:32 | shared |
| DetectedWorkspaceProject | interface | shared-helper | src/utils/projectDetector.ts:241 | shared |
| DetectorScanOptions | interface | shared-helper | src/utils/projectDetector.ts:249 | shared |
| RepeatDecision | interface | shared-helper | src/utils/queueStep3Utils.ts:1 | shared |
| RepetitionAffixInput | interface | shared-helper | src/utils/queueStep3Utils.ts:7 | shared |
| BuildAnswerFilePathInput | interface | shared-helper | src/utils/queueStep4Utils.ts:3 | shared |
| HealthCheckInput | interface | shared-helper | src/utils/queueStep4Utils.ts:10 | shared |
| HealthCheckDecisions | interface | shared-helper | src/utils/queueStep4Utils.ts:21 | shared |
| DetectedRequestId | interface | shared-helper | src/utils/queueStep4Utils.ts:27 | shared |
| QueueEntryFileNameInput | interface | shared-helper | src/utils/queueStep5Utils.ts:1 | shared |
| SendToChatConfig | interface | shared-helper | src/utils/sendToChatConfig.ts:23 | shared |
| LocalLlmConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:18 | shared |
| AiConversationConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:19 | shared |
| CopilotConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:20 | shared |
| TomAiChatConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:21 | shared |
| TrailConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:22 | shared |
| BridgeConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:23 | shared |
| TodoConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:24 | shared |
| RemindersConfig | type | shared-helper | src/utils/tomAiConfiguration.ts:25 | shared |
| FavoriteEntry | type | shared-helper | src/utils/tomAiConfiguration.ts:26 | shared |
| TomAiConfigDefaults | interface | shared-helper | src/utils/tomAiConfiguration.ts:28 | shared |
| TomAiConfiguration | class | functional-component | src/utils/tomAiConfiguration.ts:41 | shared |
| ResolveOptions | interface | shared-helper | src/utils/variableResolver.ts:42 | shared |
| WsPaths | class | functional-component | src/utils/workspacePaths.ts:116 | shared |

## Component Breakdown

### Bridge, Execution, CLI, and Integrations

- Declarations: 30
- Shared: 19
- Component-private: 11

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| TelegramChannel | class | shared | src/handlers/chat/telegram-channel.ts:57 |
| CwdMode | type | shared | src/handlers/commandline-handler.ts:37 |
| CommandlineEntry | interface | shared | src/handlers/commandline-handler.ts:39 |
| PostActionDefinition | interface | shared | src/handlers/commandline-handler.ts:65 |
| BridgeProfile | interface | shared | src/handlers/restartBridge-handler.ts:28 |
| BridgeConfig | interface | shared | src/handlers/restartBridge-handler.ts:36 |
| ParsedTelegramCommand | interface | shared | src/handlers/telegram-cmd-parser.ts:22 |
| TelegramCommandDef | interface | shared | src/handlers/telegram-cmd-parser.ts:42 |
| TelegramSubcommandDef | interface | shared | src/handlers/telegram-cmd-parser.ts:63 |
| TelegramCommandResult | interface | shared | src/handlers/telegram-cmd-parser.ts:70 |
| TelegramCommandRegistry | class | shared | src/handlers/telegram-cmd-parser.ts:87 |
| TelegramResponseFormatter | class | shared | src/handlers/telegram-cmd-response.ts:36 |
| TelegramConfig | interface | shared | src/handlers/telegram-notifier.ts:23 |
| TelegramCommand | interface | shared | src/handlers/telegram-notifier.ts:49 |
| TelegramCommandCallback | type | shared | src/handlers/telegram-notifier.ts:63 |
| TelegramApiResult | type | shared | src/handlers/telegram-notifier.ts:66 |
| TelegramNotifier | class | shared | src/handlers/telegram-notifier.ts:90 |
| TomScriptingBridgeHandler | class | shared | src/handlers/tomScriptingBridge-handler.ts:43 |
| DartBridgeClient | class | shared | src/vscode-bridge.ts:95 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| TelegramUpdate | interface | component-private | src/handlers/chat/telegram-channel.ts:35 |
| CliServerResponse | interface | component-private | src/handlers/cliServer-handler.ts:17 |
| CliServerStatusResponse | interface | component-private | src/handlers/cliServer-handler.ts:29 |
| ExecAction | type | component-private | src/handlers/commandline-handler.ts:299 |
| CommandlineQuickPickItem | interface | component-private | src/handlers/commandline-handler.ts:775 |
| ProcessMonitorResponse | interface | component-private | src/handlers/processMonitor-handler.ts:14 |
| ProfileItem | interface | component-private | src/handlers/restartBridge-handler.ts:246 |
| ProjectInfo | interface | component-private | src/handlers/telegram-cmd-handlers.ts:74 |
| JsonRpcRequest | interface | component-private | src/vscode-bridge.ts:68 |
| JsonRpcResponse | interface | component-private | src/vscode-bridge.ts:77 |
| JsonRpcNotification | interface | component-private | src/vscode-bridge.ts:84 |

### Chat, Copilot, and Local LLM Flows

- Declarations: 77
- Shared: 36
- Component-private: 41

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| CopilotResponse | interface | shared | src/handlers/aiConversation-handler.ts:55 |
| ConversationExchange | interface | shared | src/handlers/aiConversation-handler.ts:71 |
| HistoryMode | type | shared | src/handlers/aiConversation-handler.ts:85 |
| ConversationMode | type | shared | src/handlers/aiConversation-handler.ts:88 |
| ActorType | type | shared | src/handlers/aiConversation-handler.ts:91 |
| SelfTalkPersona | interface | shared | src/handlers/aiConversation-handler.ts:94 |
| AiConversationProfile | interface | shared | src/handlers/aiConversation-handler.ts:106 |
| AiConversationConfig | interface | shared | src/handlers/aiConversation-handler.ts:135 |
| AiConversationManager | class | shared | src/handlers/aiConversation-handler.ts:332 |
| ChannelResult | interface | shared | src/handlers/chat/chat-channel.ts:22 |
| ChannelMessage | interface | shared | src/handlers/chat/chat-channel.ts:28 |
| ChannelMessageCallback | type | shared | src/handlers/chat/chat-channel.ts:44 |
| SendMessageOptions | interface | shared | src/handlers/chat/chat-channel.ts:47 |
| ChatChannel | interface | shared | src/handlers/chat/chat-channel.ts:78 |
| ChatPanelViewProvider | class | component-private | src/handlers/chatPanel-handler.ts:417 |
| SendToChatTemplate | interface | shared | src/handlers/copilotTemplates-handler.ts:25 |
| SendToChatFullConfig | interface | shared | src/handlers/copilotTemplates-handler.ts:35 |
| ParsedContent | interface | shared | src/handlers/copilotTemplates-handler.ts:45 |
| SendToChatAdvancedManager | class | shared | src/handlers/copilotTemplates-handler.ts:53 |
| ModelConfig | interface | shared | src/handlers/localLlm-handler.ts:44 |
| LlmConfiguration | interface | shared | src/handlers/localLlm-handler.ts:62 |
| ExpanderProfile | interface | shared | src/handlers/localLlm-handler.ts:90 |
| LocalLlmHistoryMode | type | shared | src/handlers/localLlm-handler.ts:112 |
| LocalLlmConfig | interface | shared | src/handlers/localLlm-handler.ts:115 |
| ExpanderProcessResult | interface | shared | src/handlers/localLlm-handler.ts:148 |
| OllamaStats | interface | shared | src/handlers/localLlm-handler.ts:179 |
| LocalLlmMessage | interface | shared | src/handlers/localLlm-handler.ts:245 |
| LocalLlmManager | class | shared | src/handlers/localLlm-handler.ts:251 |
| ChatLogManager | class | component-private | src/handlers/tomAiChat-handler.ts:171 |
| ChatParseResult | interface | shared | src/handlers/tomAiChat-utils.ts:50 |
| TodoItem | interface | shared | src/managers/chatTodoSessionManager.ts:4 |
| TodoOperationResult | interface | shared | src/managers/chatTodoSessionManager.ts:13 |
| ChatTodoSessionManager | class | shared | src/managers/chatTodoSessionManager.ts:21 |
| ChangeSource | type | shared | src/managers/chatVariablesStore.ts:22 |
| ChangeLogEntry | interface | shared | src/managers/chatVariablesStore.ts:25 |
| ChatVariablesSnapshot | interface | shared | src/managers/chatVariablesStore.ts:34 |
| ChatVariablesStore | class | shared | src/managers/chatVariablesStore.ts:55 |
| SendToChatConfig | interface | shared | src/utils/sendToChatConfig.ts:23 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| ConversationState | interface | component-private | src/handlers/aiConversation-handler.ts:194 |
| Section | interface | component-private | src/handlers/chatPanel-handler.ts:410 |
| NotifyUserInput | interface | component-private | src/tools/chat-enhancement-tools.ts:38 |
| GetWorkspaceInfoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:106 |
| DetermineQuestInput | interface | component-private | src/tools/chat-enhancement-tools.ts:145 |
| ListTodosInput | interface | component-private | src/tools/chat-enhancement-tools.ts:193 |
| GetAllTodosInput | interface | component-private | src/tools/chat-enhancement-tools.ts:252 |
| GetTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:305 |
| CreateTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:335 |
| UpdateTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:402 |
| MoveTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:464 |
| SessionTodoAddInput | interface | component-private | src/tools/chat-enhancement-tools.ts:500 |
| SessionTodoListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:546 |
| SessionTodoGetAllInput | interface | component-private | src/tools/chat-enhancement-tools.ts:579 |
| SessionTodoUpdateInput | interface | component-private | src/tools/chat-enhancement-tools.ts:608 |
| SessionTodoDeleteInput | interface | component-private | src/tools/chat-enhancement-tools.ts:655 |
| AddToPromptQueueInput | interface | component-private | src/tools/chat-enhancement-tools.ts:693 |
| SendQueuedPromptInput | interface | component-private | src/tools/chat-enhancement-tools.ts:761 |
| AddFollowUpPromptInput | interface | component-private | src/tools/chat-enhancement-tools.ts:813 |
| AddTimedRequestInput | interface | component-private | src/tools/chat-enhancement-tools.ts:872 |
| QueueListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:925 |
| QueueUpdateItemInput | interface | component-private | src/tools/chat-enhancement-tools.ts:982 |
| QueueSetStatusInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1064 |
| QueueSendNowInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1100 |
| QueueRemoveItemInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1132 |
| QueueUpdateFollowUpInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1163 |
| QueueRemoveFollowUpInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1218 |
| TimedListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1254 |
| TimedUpdateEntryInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1303 |
| TimedRemoveEntryInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1374 |
| TimedSetEngineStateInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1405 |
| PromptTemplateManageInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1436 |
| ReminderTemplateManageInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1525 |
| DeleteTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1603 |
| ListQuestsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1644 |
| ListProjectsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1691 |
| ListDocumentsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1740 |
| WorkspaceTodoListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1829 |
| ResolverDef | interface | component-private | src/tools/chatVariableResolvers.ts:15 |

### Core Extension Wiring

- Declarations: 7
- Shared: 6
- Component-private: 1

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| DocumentPickerConfig | interface | shared | src/handlers/documentPicker.ts:19 |
| DocPickerGroup | interface | shared | src/handlers/documentPicker.ts:36 |
| DocPickerProject | interface | shared | src/handlers/documentPicker.ts:41 |
| TemplateEditorField | interface | shared | src/handlers/handler_shared.ts:740 |
| TemplateEditorConfig | interface | shared | src/handlers/handler_shared.ts:750 |
| BridgeTestRunner | class | shared | src/tests.ts:27 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| TestResult | interface | component-private | src/tests.ts:17 |

### General Handlers

- Declarations: 23
- Shared: 16
- Component-private: 7

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| GitHubUser | interface | shared | src/handlers/githubApi.ts:16 |
| GitHubLabel | interface | shared | src/handlers/githubApi.ts:21 |
| GitHubIssue | interface | shared | src/handlers/githubApi.ts:28 |
| GitHubComment | interface | shared | src/handlers/githubApi.ts:42 |
| RepoInfo | interface | shared | src/handlers/githubApi.ts:53 |
| GitHubIssueProvider | class | shared | src/handlers/githubIssueProvider.ts:39 |
| TemplateCategory | type | shared | src/handlers/globalTemplateEditor-handler.ts:27 |
| IssueProviderRepo | interface | shared | src/handlers/issueProvider.ts:14 |
| IssueUser | interface | shared | src/handlers/issueProvider.ts:21 |
| IssueItem | interface | shared | src/handlers/issueProvider.ts:26 |
| IssueComment | interface | shared | src/handlers/issueProvider.ts:40 |
| IssueUpdates | interface | shared | src/handlers/issueProvider.ts:49 |
| AttachmentInfo | interface | shared | src/handlers/issueProvider.ts:56 |
| IssueProvider | interface | shared | src/handlers/issueProvider.ts:73 |
| PromptTemplateOptions | interface | shared | src/handlers/promptTemplate.ts:46 |
| PromptScope | type | shared | src/handlers/reusablePromptEditor-handler.ts:27 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| CombinedCommandConfig | interface | component-private | src/handlers/combinedCommand-handler.ts:41 |
| CombinedCommandsMap | type | component-private | src/handlers/combinedCommand-handler.ts:49 |
| DebugLoggingResponse | interface | component-private | src/handlers/debugLogging-handler.ts:13 |
| GitHubContentResponse | interface | component-private | src/handlers/githubApi.ts:293 |
| TemplateItem | interface | component-private | src/handlers/globalTemplateEditor-handler.ts:46 |
| PrintConfigurationResponse | interface | component-private | src/handlers/printConfiguration-handler.ts:14 |
| ScopeItem | interface | component-private | src/handlers/reusablePromptEditor-handler.ts:36 |

### Queue, Timed Requests, and Scheduling

- Declarations: 32
- Shared: 31
- Component-private: 1

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| QueuedPromptStatus | type | shared | src/managers/promptQueueManager.ts:51 |
| QueuedPromptType | type | shared | src/managers/promptQueueManager.ts:52 |
| QueuedFollowUpPrompt | interface | shared | src/managers/promptQueueManager.ts:54 |
| QueuedPrePrompt | interface | shared | src/managers/promptQueueManager.ts:65 |
| QueuedPrompt | interface | shared | src/managers/promptQueueManager.ts:71 |
| PromptQueueManager | class | shared | src/managers/promptQueueManager.ts:159 |
| ReminderTemplate | interface | shared | src/managers/reminderSystem.ts:20 |
| ReminderConfig | interface | shared | src/managers/reminderSystem.ts:27 |
| ReminderSystem | class | shared | src/managers/reminderSystem.ts:51 |
| ScheduledTime | interface | shared | src/managers/timerEngine.ts:20 |
| TimedRequestStatus | type | shared | src/managers/timerEngine.ts:25 |
| TimedRequest | interface | shared | src/managers/timerEngine.ts:27 |
| TimerScheduleSlot | interface | shared | src/managers/timerEngine.ts:50 |
| TimerEngine | class | shared | src/managers/timerEngine.ts:73 |
| QueueReminderConfig | interface | shared | src/storage/queueFileStorage.ts:60 |
| QueueExecutionState | interface | shared | src/storage/queueFileStorage.ts:71 |
| QueuePromptRef | type | shared | src/storage/queueFileStorage.ts:80 |
| QueuePromptYaml | interface | shared | src/storage/queueFileStorage.ts:83 |
| QueueMetaYaml | interface | shared | src/storage/queueFileStorage.ts:112 |
| QueueFileYaml | interface | shared | src/storage/queueFileStorage.ts:131 |
| QueueEntryFile | interface | shared | src/storage/queueFileStorage.ts:137 |
| QueueTemplateFile | interface | shared | src/storage/queueFileStorage.ts:149 |
| QueueReloadAfterReloadSetting | interface | shared | src/storage/queueFileStorage.ts:202 |
| QueueSettings | interface | shared | src/storage/queueFileStorage.ts:209 |
| RepeatDecision | interface | shared | src/utils/queueStep3Utils.ts:1 |
| RepetitionAffixInput | interface | shared | src/utils/queueStep3Utils.ts:7 |
| BuildAnswerFilePathInput | interface | shared | src/utils/queueStep4Utils.ts:3 |
| HealthCheckInput | interface | shared | src/utils/queueStep4Utils.ts:10 |
| HealthCheckDecisions | interface | shared | src/utils/queueStep4Utils.ts:21 |
| DetectedRequestId | interface | shared | src/utils/queueStep4Utils.ts:27 |
| QueueEntryFileNameInput | interface | shared | src/utils/queueStep5Utils.ts:1 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| TestQueuedPrompt | interface | component-private | src/managers/__tests__/noReminder.test.ts:21 |

### Shared Infrastructure and Contracts

- Declarations: 38
- Shared: 37
- Component-private: 1

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| WebviewMessage | interface | shared | src/types/webviewMessages.ts:1 |
| ChatPanelSendMessage | interface | shared | src/types/webviewMessages.ts:6 |
| ChatPanelDraftMessage | interface | shared | src/types/webviewMessages.ts:13 |
| TodoPanelMessage | interface | shared | src/types/webviewMessages.ts:19 |
| BaseWebviewProvider | class | shared | src/utils/baseWebviewProvider.ts:3 |
| PlatformKey | type | shared | src/utils/executableResolver.ts:24 |
| ExecutableConfig | interface | shared | src/utils/executableResolver.ts:30 |
| ExecutablesConfig | interface | shared | src/utils/executableResolver.ts:37 |
| ConfigPlaceholderContext | interface | shared | src/utils/executableResolver.ts:45 |
| ApplicationMapping | interface | shared | src/utils/executableResolver.ts:57 |
| ExternalApplicationsConfig | interface | shared | src/utils/executableResolver.ts:71 |
| FsUtils | class | shared | src/utils/fsUtils.ts:5 |
| ResolvedLink | interface | shared | src/utils/linkResolver.ts:26 |
| LinkType | type | shared | src/utils/linkResolver.ts:50 |
| LinkAction | type | shared | src/utils/linkResolver.ts:65 |
| LinkContext | interface | shared | src/utils/linkResolver.ts:77 |
| LinkHandler | interface | shared | src/utils/linkResolver.ts:86 |
| DetectorContainsRule | interface | shared | src/utils/projectDetector.ts:7 |
| ProjectDetectionRule | interface | shared | src/utils/projectDetector.ts:14 |
| ProjectDetector | interface | shared | src/utils/projectDetector.ts:20 |
| ProjectDetectorConfig | interface | shared | src/utils/projectDetector.ts:26 |
| ProjectDetectionResult | interface | shared | src/utils/projectDetector.ts:32 |
| DetectedWorkspaceProject | interface | shared | src/utils/projectDetector.ts:241 |
| DetectorScanOptions | interface | shared | src/utils/projectDetector.ts:249 |
| LocalLlmConfig | type | shared | src/utils/tomAiConfiguration.ts:18 |
| AiConversationConfig | type | shared | src/utils/tomAiConfiguration.ts:19 |
| CopilotConfig | type | shared | src/utils/tomAiConfiguration.ts:20 |
| TomAiChatConfig | type | shared | src/utils/tomAiConfiguration.ts:21 |
| TrailConfig | type | shared | src/utils/tomAiConfiguration.ts:22 |
| BridgeConfig | type | shared | src/utils/tomAiConfiguration.ts:23 |
| TodoConfig | type | shared | src/utils/tomAiConfiguration.ts:24 |
| RemindersConfig | type | shared | src/utils/tomAiConfiguration.ts:25 |
| FavoriteEntry | type | shared | src/utils/tomAiConfiguration.ts:26 |
| TomAiConfigDefaults | interface | shared | src/utils/tomAiConfiguration.ts:28 |
| TomAiConfiguration | class | shared | src/utils/tomAiConfiguration.ts:41 |
| ResolveOptions | interface | shared | src/utils/variableResolver.ts:42 |
| WsPaths | class | shared | src/utils/workspacePaths.ts:116 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| LogLevel | type | component-private | src/utils/debugLogger.ts:10 |

### Todo, Notes, and Work Tracking

- Declarations: 31
- Shared: 15
- Component-private: 16

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| NotepadViewProvider | class | component-private | src/handlers/notepad-handler.ts:20 |
| QuestTodoEditorProvider | class | component-private | src/handlers/questTodoEditor-handler.ts:36 |
| QuestTodoViewConfig | interface | shared | src/handlers/questTodoPanel-handler.ts:82 |
| QuestTodoEmbeddedViewProvider | class | shared | src/handlers/questTodoPanel-handler.ts:3954 |
| TomNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:626 |
| CopilotNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:874 |
| LocalLlmNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1102 |
| ConversationNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1469 |
| TomAiChatNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1834 |
| NotesNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2155 |
| GuidelinesNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2455 |
| WorkspaceNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2746 |
| QuestNotesProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:3138 |
| SessionTodosProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:3259 |
| TodoLogViewProvider | class | shared | src/handlers/todoLogPanel-handler.ts:45 |
| QuestTodoScope | interface | shared | src/managers/questTodoManager.ts:27 |
| QuestTodoReference | interface | shared | src/managers/questTodoManager.ts:35 |
| QuestTodoItem | interface | shared | src/managers/questTodoManager.ts:43 |
| QuestTodoFile | interface | shared | src/managers/questTodoManager.ts:63 |
| ScannedProject | interface | shared | src/managers/questTodoManager.ts:859 |
| SessionTodoItem | interface | shared | src/managers/sessionTodoStore.ts:29 |
| SessionTodoSnapshot | interface | shared | src/managers/sessionTodoStore.ts:41 |
| SessionTodoStore | class | shared | src/managers/sessionTodoStore.ts:54 |
| TodoInput | interface | shared | src/managers/todoProvider.ts:18 |
| TodoFilter | interface | shared | src/managers/todoProvider.ts:27 |
| TodoProviderOptions | interface | shared | src/managers/todoProvider.ts:32 |
| TodoProvider | class | shared | src/managers/todoProvider.ts:40 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| QtPanelState | interface | component-private | src/handlers/questTodoPanel-handler.ts:39 |
| QtPendingSelectState | interface | component-private | src/handlers/questTodoPanel-handler.ts:57 |
| NoteItem | interface | component-private | src/handlers/sidebarNotes-handler.ts:2145 |
| TodoLogEntry | interface | component-private | src/handlers/todoLogPanel-handler.ts:488 |

### Tooling Surface and Model Tools

- Declarations: 23
- Shared: 22
- Component-private: 1

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| AskCopilotConfig | interface | shared | src/tools/local-llm-tools-config.ts:12 |
| AskBigBrotherConfig | interface | shared | src/tools/local-llm-tools-config.ts:23 |
| LocalLlmToolsConfig | interface | shared | src/tools/local-llm-tools-config.ts:40 |
| SharedToolDefinition | interface | shared | src/tools/shared-tool-registry.ts:21 |
| OllamaTool | interface | shared | src/tools/shared-tool-registry.ts:58 |
| OllamaToolCall | interface | shared | src/tools/shared-tool-registry.ts:68 |
| ReadFileInput | interface | shared | src/tools/tool-executors.ts:66 |
| ListDirectoryInput | interface | shared | src/tools/tool-executors.ts:107 |
| FindFilesInput | interface | shared | src/tools/tool-executors.ts:139 |
| FindTextInFilesInput | interface | shared | src/tools/tool-executors.ts:171 |
| FetchWebpageInput | interface | shared | src/tools/tool-executors.ts:216 |
| WebSearchInput | interface | shared | src/tools/tool-executors.ts:248 |
| GetErrorsInput | interface | shared | src/tools/tool-executors.ts:356 |
| ReadGuidelineInput | interface | shared | src/tools/tool-executors.ts:395 |
| CreateFileInput | interface | shared | src/tools/tool-executors.ts:504 |
| EditFileInput | interface | shared | src/tools/tool-executors.ts:533 |
| MultiEditFileInput | interface | shared | src/tools/tool-executors.ts:564 |
| RunCommandInput | interface | shared | src/tools/tool-executors.ts:608 |
| RunVscodeCommandInput | interface | shared | src/tools/tool-executors.ts:639 |
| ManageTodoInput | interface | shared | src/tools/tool-executors.ts:681 |
| AskBigBrotherInput | interface | shared | src/tools/tool-executors.ts:753 |
| AskCopilotInput | interface | shared | src/tools/tool-executors.ts:1058 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| SearchResult | interface | component-private | src/tools/tool-executors.ts:298 |

### Trail and Markdown Views

- Declarations: 18
- Shared: 10
- Component-private: 8

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| NavigationHistory | class | component-private | src/handlers/markdownBrowser-handler.ts:56 |
| MarkdownHtmlPreviewOptions | interface | shared | src/handlers/markdownHtmlPreview.ts:3 |
| TrailEntry | interface | shared | src/handlers/trailEditor-handler.ts:24 |
| TrailEditorProvider | class | component-private | src/handlers/trailEditor-handler.ts:60 |
| TrailSet | interface | shared | src/handlers/trailEditor-handler.ts:229 |
| TrailFile | interface | shared | src/handlers/trailViewer-handler.ts:34 |
| TrailExchange | interface | shared | src/handlers/trailViewer-handler.ts:41 |
| ParsedTrailFile | interface | shared | src/handlers/trailViewer-handler.ts:54 |
| TrailType | type | shared | src/services/trailLogging.ts:7 |
| TrailSubsystem | type | shared | src/services/trailService.ts:8 |
| TrailMetadata | interface | shared | src/services/trailService.ts:13 |
| TrailService | class | shared | src/services/trailService.ts:36 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| HistoryEntry | interface | component-private | src/handlers/markdownBrowser-handler.ts:50 |
| TrailViewerFolderOption | interface | component-private | src/handlers/trailViewer-handler.ts:310 |
| DiscoveredSubsystem | interface | component-private | src/handlers/trailViewer-handler.ts:317 |
| TrailViewerState | interface | component-private | src/handlers/trailViewer-handler.ts:323 |
| RawTrailConfig | interface | component-private | src/services/trailService.ts:19 |
| SummaryTrailConfig | interface | component-private | src/services/trailService.ts:30 |

### Window Layout, Panels, and UI Shell

- Declarations: 24
- Shared: 13
- Component-private: 11

Important functional components

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| AccordionSection | interface | shared | src/handlers/accordionPanel.ts:19 |
| AccordionPanelConfig | interface | shared | src/handlers/accordionPanel.ts:31 |
| PanelMode | type | shared | src/handlers/issuesPanel-handler.ts:28 |
| MinimalModeViewProvider | class | component-private | src/handlers/minimalMode-handler.ts:27 |
| FavoriteEntry | interface | shared | src/handlers/statusPage-handler.ts:41 |
| LlmConfiguration | interface | shared | src/handlers/statusPage-handler.ts:57 |
| AiConversationSetup | interface | shared | src/handlers/statusPage-handler.ts:81 |
| StatusData | interface | shared | src/handlers/statusPage-handler.ts:727 |
| TabSection | interface | shared | src/handlers/tabPanel.ts:19 |
| TabPanelConfig | interface | shared | src/handlers/tabPanel.ts:31 |
| SubsystemStatus | interface | shared | src/handlers/windowStatusPanel-handler.ts:48 |
| WindowStateFile | interface | shared | src/handlers/windowStatusPanel-handler.ts:60 |
| WindowStatusViewProvider | class | shared | src/handlers/windowStatusPanel-handler.ts:89 |
| WsPanelHandler | class | shared | src/handlers/wsPanel-handler.ts:49 |

Smaller helpers and subcomponents

| Declaration | Kind | Scope | File |
| --- | --- | --- | --- |
| ChordMenuItem | interface | component-private | src/handlers/chordMenu-handler.ts:30 |
| ChordGroup | interface | component-private | src/handlers/chordMenu-handler.ts:43 |
| ParsedStatus | interface | component-private | src/handlers/issuesPanel-handler.ts:30 |
| ColumnDef | interface | component-private | src/handlers/issuesPanel-handler.ts:41 |
| IssuePanelConfig | interface | component-private | src/handlers/issuesPanel-handler.ts:55 |
| StateAction | interface | component-private | src/handlers/stateMachine-handler.ts:44 |
| InitActions | interface | component-private | src/handlers/stateMachine-handler.ts:50 |
| ResetActions | interface | component-private | src/handlers/stateMachine-handler.ts:56 |
| StateMachineConfig | interface | component-private | src/handlers/stateMachine-handler.ts:60 |
| StateMachineCommandsMap | type | component-private | src/handlers/stateMachine-handler.ts:67 |

## Complete Declaration Index

| Declaration | Kind | Component | Scope | Role | Location |
| --- | --- | --- | --- | --- | --- |
| TelegramUpdate | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/chat/telegram-channel.ts:35 |
| TelegramChannel | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/chat/telegram-channel.ts:57 |
| CliServerResponse | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/cliServer-handler.ts:17 |
| CliServerStatusResponse | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/cliServer-handler.ts:29 |
| CwdMode | type | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/commandline-handler.ts:37 |
| CommandlineEntry | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/commandline-handler.ts:39 |
| PostActionDefinition | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/commandline-handler.ts:65 |
| ExecAction | type | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/commandline-handler.ts:299 |
| CommandlineQuickPickItem | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/commandline-handler.ts:775 |
| ProcessMonitorResponse | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/processMonitor-handler.ts:14 |
| BridgeProfile | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/restartBridge-handler.ts:28 |
| BridgeConfig | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/restartBridge-handler.ts:36 |
| ProfileItem | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/restartBridge-handler.ts:246 |
| ProjectInfo | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/handlers/telegram-cmd-handlers.ts:74 |
| ParsedTelegramCommand | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-parser.ts:22 |
| TelegramCommandDef | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-parser.ts:42 |
| TelegramSubcommandDef | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-parser.ts:63 |
| TelegramCommandResult | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-parser.ts:70 |
| TelegramCommandRegistry | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-parser.ts:87 |
| TelegramResponseFormatter | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-cmd-response.ts:36 |
| TelegramConfig | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-notifier.ts:23 |
| TelegramCommand | interface | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-notifier.ts:49 |
| TelegramCommandCallback | type | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-notifier.ts:63 |
| TelegramApiResult | type | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-notifier.ts:66 |
| TelegramNotifier | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/telegram-notifier.ts:90 |
| TomScriptingBridgeHandler | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/handlers/tomScriptingBridge-handler.ts:43 |
| JsonRpcRequest | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/vscode-bridge.ts:68 |
| JsonRpcResponse | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/vscode-bridge.ts:77 |
| JsonRpcNotification | interface | Bridge, Execution, CLI, and Integrations | component-private | private-subcomponent | src/vscode-bridge.ts:84 |
| DartBridgeClient | class | Bridge, Execution, CLI, and Integrations | shared | functional-component | src/vscode-bridge.ts:95 |
| CopilotResponse | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:55 |
| ConversationExchange | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:71 |
| HistoryMode | type | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:85 |
| ConversationMode | type | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:88 |
| ActorType | type | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:91 |
| SelfTalkPersona | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:94 |
| AiConversationProfile | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:106 |
| AiConversationConfig | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:135 |
| ConversationState | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/handlers/aiConversation-handler.ts:194 |
| AiConversationManager | class | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/aiConversation-handler.ts:332 |
| ChannelResult | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/chat/chat-channel.ts:22 |
| ChannelMessage | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/chat/chat-channel.ts:28 |
| ChannelMessageCallback | type | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/chat/chat-channel.ts:44 |
| SendMessageOptions | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/chat/chat-channel.ts:47 |
| ChatChannel | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/chat/chat-channel.ts:78 |
| Section | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/handlers/chatPanel-handler.ts:410 |
| ChatPanelViewProvider | class | Chat, Copilot, and Local LLM Flows | component-private | functional-component | src/handlers/chatPanel-handler.ts:417 |
| SendToChatTemplate | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/copilotTemplates-handler.ts:25 |
| SendToChatFullConfig | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/copilotTemplates-handler.ts:35 |
| ParsedContent | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/copilotTemplates-handler.ts:45 |
| SendToChatAdvancedManager | class | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/copilotTemplates-handler.ts:53 |
| ModelConfig | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:44 |
| LlmConfiguration | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:62 |
| ExpanderProfile | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:90 |
| LocalLlmHistoryMode | type | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:112 |
| LocalLlmConfig | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:115 |
| ExpanderProcessResult | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:148 |
| OllamaStats | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:179 |
| LocalLlmMessage | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:245 |
| LocalLlmManager | class | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/localLlm-handler.ts:251 |
| ChatLogManager | class | Chat, Copilot, and Local LLM Flows | component-private | functional-component | src/handlers/tomAiChat-handler.ts:171 |
| ChatParseResult | interface | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/handlers/tomAiChat-utils.ts:50 |
| TodoItem | interface | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/managers/chatTodoSessionManager.ts:4 |
| TodoOperationResult | interface | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/managers/chatTodoSessionManager.ts:13 |
| ChatTodoSessionManager | class | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/managers/chatTodoSessionManager.ts:21 |
| ChangeSource | type | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/managers/chatVariablesStore.ts:22 |
| ChangeLogEntry | interface | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/managers/chatVariablesStore.ts:25 |
| ChatVariablesSnapshot | interface | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/managers/chatVariablesStore.ts:34 |
| ChatVariablesStore | class | Chat, Copilot, and Local LLM Flows | shared | functional-component | src/managers/chatVariablesStore.ts:55 |
| NotifyUserInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:38 |
| GetWorkspaceInfoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:106 |
| DetermineQuestInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:145 |
| ListTodosInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:193 |
| GetAllTodosInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:252 |
| GetTodoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:305 |
| CreateTodoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:335 |
| UpdateTodoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:402 |
| MoveTodoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:464 |
| SessionTodoAddInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:500 |
| SessionTodoListInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:546 |
| SessionTodoGetAllInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:579 |
| SessionTodoUpdateInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:608 |
| SessionTodoDeleteInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:655 |
| AddToPromptQueueInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:693 |
| SendQueuedPromptInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:761 |
| AddFollowUpPromptInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:813 |
| AddTimedRequestInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:872 |
| QueueListInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:925 |
| QueueUpdateItemInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:982 |
| QueueSetStatusInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1064 |
| QueueSendNowInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1100 |
| QueueRemoveItemInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1132 |
| QueueUpdateFollowUpInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1163 |
| QueueRemoveFollowUpInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1218 |
| TimedListInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1254 |
| TimedUpdateEntryInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1303 |
| TimedRemoveEntryInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1374 |
| TimedSetEngineStateInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1405 |
| PromptTemplateManageInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1436 |
| ReminderTemplateManageInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1525 |
| DeleteTodoInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1603 |
| ListQuestsInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1644 |
| ListProjectsInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1691 |
| ListDocumentsInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1740 |
| WorkspaceTodoListInput | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chat-enhancement-tools.ts:1829 |
| ResolverDef | interface | Chat, Copilot, and Local LLM Flows | component-private | private-subcomponent | src/tools/chatVariableResolvers.ts:15 |
| SendToChatConfig | interface | Chat, Copilot, and Local LLM Flows | shared | shared-helper | src/utils/sendToChatConfig.ts:23 |
| DocumentPickerConfig | interface | Core Extension Wiring | shared | functional-component | src/handlers/documentPicker.ts:19 |
| DocPickerGroup | interface | Core Extension Wiring | shared | functional-component | src/handlers/documentPicker.ts:36 |
| DocPickerProject | interface | Core Extension Wiring | shared | functional-component | src/handlers/documentPicker.ts:41 |
| TemplateEditorField | interface | Core Extension Wiring | shared | functional-component | src/handlers/handler_shared.ts:740 |
| TemplateEditorConfig | interface | Core Extension Wiring | shared | functional-component | src/handlers/handler_shared.ts:750 |
| TestResult | interface | Core Extension Wiring | component-private | private-subcomponent | src/tests.ts:17 |
| BridgeTestRunner | class | Core Extension Wiring | shared | functional-component | src/tests.ts:27 |
| CombinedCommandConfig | interface | General Handlers | component-private | private-subcomponent | src/handlers/combinedCommand-handler.ts:41 |
| CombinedCommandsMap | type | General Handlers | component-private | private-subcomponent | src/handlers/combinedCommand-handler.ts:49 |
| DebugLoggingResponse | interface | General Handlers | component-private | private-subcomponent | src/handlers/debugLogging-handler.ts:13 |
| GitHubUser | interface | General Handlers | shared | functional-component | src/handlers/githubApi.ts:16 |
| GitHubLabel | interface | General Handlers | shared | functional-component | src/handlers/githubApi.ts:21 |
| GitHubIssue | interface | General Handlers | shared | functional-component | src/handlers/githubApi.ts:28 |
| GitHubComment | interface | General Handlers | shared | functional-component | src/handlers/githubApi.ts:42 |
| RepoInfo | interface | General Handlers | shared | functional-component | src/handlers/githubApi.ts:53 |
| GitHubContentResponse | interface | General Handlers | component-private | private-subcomponent | src/handlers/githubApi.ts:293 |
| GitHubIssueProvider | class | General Handlers | shared | functional-component | src/handlers/githubIssueProvider.ts:39 |
| TemplateCategory | type | General Handlers | shared | functional-component | src/handlers/globalTemplateEditor-handler.ts:27 |
| TemplateItem | interface | General Handlers | component-private | private-subcomponent | src/handlers/globalTemplateEditor-handler.ts:46 |
| IssueProviderRepo | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:14 |
| IssueUser | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:21 |
| IssueItem | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:26 |
| IssueComment | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:40 |
| IssueUpdates | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:49 |
| AttachmentInfo | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:56 |
| IssueProvider | interface | General Handlers | shared | functional-component | src/handlers/issueProvider.ts:73 |
| PrintConfigurationResponse | interface | General Handlers | component-private | private-subcomponent | src/handlers/printConfiguration-handler.ts:14 |
| PromptTemplateOptions | interface | General Handlers | shared | functional-component | src/handlers/promptTemplate.ts:46 |
| PromptScope | type | General Handlers | shared | functional-component | src/handlers/reusablePromptEditor-handler.ts:27 |
| ScopeItem | interface | General Handlers | component-private | private-subcomponent | src/handlers/reusablePromptEditor-handler.ts:36 |
| TestQueuedPrompt | interface | Queue, Timed Requests, and Scheduling | component-private | private-subcomponent | src/managers/__tests__/noReminder.test.ts:21 |
| QueuedPromptStatus | type | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/promptQueueManager.ts:51 |
| QueuedPromptType | type | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/promptQueueManager.ts:52 |
| QueuedFollowUpPrompt | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/promptQueueManager.ts:54 |
| QueuedPrePrompt | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/promptQueueManager.ts:65 |
| QueuedPrompt | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/promptQueueManager.ts:71 |
| PromptQueueManager | class | Queue, Timed Requests, and Scheduling | shared | functional-component | src/managers/promptQueueManager.ts:159 |
| ReminderTemplate | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/reminderSystem.ts:20 |
| ReminderConfig | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/reminderSystem.ts:27 |
| ReminderSystem | class | Queue, Timed Requests, and Scheduling | shared | functional-component | src/managers/reminderSystem.ts:51 |
| ScheduledTime | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/timerEngine.ts:20 |
| TimedRequestStatus | type | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/timerEngine.ts:25 |
| TimedRequest | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/timerEngine.ts:27 |
| TimerScheduleSlot | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/managers/timerEngine.ts:50 |
| TimerEngine | class | Queue, Timed Requests, and Scheduling | shared | functional-component | src/managers/timerEngine.ts:73 |
| QueueReminderConfig | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:60 |
| QueueExecutionState | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:71 |
| QueuePromptRef | type | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:80 |
| QueuePromptYaml | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:83 |
| QueueMetaYaml | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:112 |
| QueueFileYaml | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:131 |
| QueueEntryFile | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:137 |
| QueueTemplateFile | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:149 |
| QueueReloadAfterReloadSetting | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:202 |
| QueueSettings | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/storage/queueFileStorage.ts:209 |
| RepeatDecision | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep3Utils.ts:1 |
| RepetitionAffixInput | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep3Utils.ts:7 |
| BuildAnswerFilePathInput | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep4Utils.ts:3 |
| HealthCheckInput | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep4Utils.ts:10 |
| HealthCheckDecisions | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep4Utils.ts:21 |
| DetectedRequestId | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep4Utils.ts:27 |
| QueueEntryFileNameInput | interface | Queue, Timed Requests, and Scheduling | shared | shared-helper | src/utils/queueStep5Utils.ts:1 |
| WebviewMessage | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/types/webviewMessages.ts:1 |
| ChatPanelSendMessage | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/types/webviewMessages.ts:6 |
| ChatPanelDraftMessage | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/types/webviewMessages.ts:13 |
| TodoPanelMessage | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/types/webviewMessages.ts:19 |
| BaseWebviewProvider | class | Shared Infrastructure and Contracts | shared | functional-component | src/utils/baseWebviewProvider.ts:3 |
| LogLevel | type | Shared Infrastructure and Contracts | component-private | private-subcomponent | src/utils/debugLogger.ts:10 |
| PlatformKey | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:24 |
| ExecutableConfig | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:30 |
| ExecutablesConfig | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:37 |
| ConfigPlaceholderContext | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:45 |
| ApplicationMapping | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:57 |
| ExternalApplicationsConfig | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/executableResolver.ts:71 |
| FsUtils | class | Shared Infrastructure and Contracts | shared | functional-component | src/utils/fsUtils.ts:5 |
| ResolvedLink | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/linkResolver.ts:26 |
| LinkType | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/linkResolver.ts:50 |
| LinkAction | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/linkResolver.ts:65 |
| LinkContext | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/linkResolver.ts:77 |
| LinkHandler | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/linkResolver.ts:86 |
| DetectorContainsRule | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:7 |
| ProjectDetectionRule | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:14 |
| ProjectDetector | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:20 |
| ProjectDetectorConfig | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:26 |
| ProjectDetectionResult | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:32 |
| DetectedWorkspaceProject | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:241 |
| DetectorScanOptions | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/projectDetector.ts:249 |
| LocalLlmConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:18 |
| AiConversationConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:19 |
| CopilotConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:20 |
| TomAiChatConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:21 |
| TrailConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:22 |
| BridgeConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:23 |
| TodoConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:24 |
| RemindersConfig | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:25 |
| FavoriteEntry | type | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:26 |
| TomAiConfigDefaults | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/tomAiConfiguration.ts:28 |
| TomAiConfiguration | class | Shared Infrastructure and Contracts | shared | functional-component | src/utils/tomAiConfiguration.ts:41 |
| ResolveOptions | interface | Shared Infrastructure and Contracts | shared | shared-helper | src/utils/variableResolver.ts:42 |
| WsPaths | class | Shared Infrastructure and Contracts | shared | functional-component | src/utils/workspacePaths.ts:116 |
| NotepadViewProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/notepad-handler.ts:20 |
| QuestTodoEditorProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/questTodoEditor-handler.ts:36 |
| QtPanelState | interface | Todo, Notes, and Work Tracking | component-private | private-subcomponent | src/handlers/questTodoPanel-handler.ts:39 |
| QtPendingSelectState | interface | Todo, Notes, and Work Tracking | component-private | private-subcomponent | src/handlers/questTodoPanel-handler.ts:57 |
| QuestTodoViewConfig | interface | Todo, Notes, and Work Tracking | shared | functional-component | src/handlers/questTodoPanel-handler.ts:82 |
| QuestTodoEmbeddedViewProvider | class | Todo, Notes, and Work Tracking | shared | functional-component | src/handlers/questTodoPanel-handler.ts:3954 |
| TomNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:626 |
| CopilotNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:874 |
| LocalLlmNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:1102 |
| ConversationNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:1469 |
| TomAiChatNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:1834 |
| NoteItem | interface | Todo, Notes, and Work Tracking | component-private | private-subcomponent | src/handlers/sidebarNotes-handler.ts:2145 |
| NotesNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:2155 |
| GuidelinesNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:2455 |
| WorkspaceNotepadProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:2746 |
| QuestNotesProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:3138 |
| SessionTodosProvider | class | Todo, Notes, and Work Tracking | component-private | functional-component | src/handlers/sidebarNotes-handler.ts:3259 |
| TodoLogViewProvider | class | Todo, Notes, and Work Tracking | shared | functional-component | src/handlers/todoLogPanel-handler.ts:45 |
| TodoLogEntry | interface | Todo, Notes, and Work Tracking | component-private | private-subcomponent | src/handlers/todoLogPanel-handler.ts:488 |
| QuestTodoScope | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/questTodoManager.ts:27 |
| QuestTodoReference | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/questTodoManager.ts:35 |
| QuestTodoItem | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/questTodoManager.ts:43 |
| QuestTodoFile | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/questTodoManager.ts:63 |
| ScannedProject | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/questTodoManager.ts:859 |
| SessionTodoItem | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/sessionTodoStore.ts:29 |
| SessionTodoSnapshot | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/sessionTodoStore.ts:41 |
| SessionTodoStore | class | Todo, Notes, and Work Tracking | shared | functional-component | src/managers/sessionTodoStore.ts:54 |
| TodoInput | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/todoProvider.ts:18 |
| TodoFilter | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/todoProvider.ts:27 |
| TodoProviderOptions | interface | Todo, Notes, and Work Tracking | shared | shared-helper | src/managers/todoProvider.ts:32 |
| TodoProvider | class | Todo, Notes, and Work Tracking | shared | functional-component | src/managers/todoProvider.ts:40 |
| AskCopilotConfig | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/local-llm-tools-config.ts:12 |
| AskBigBrotherConfig | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/local-llm-tools-config.ts:23 |
| LocalLlmToolsConfig | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/local-llm-tools-config.ts:40 |
| SharedToolDefinition | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/shared-tool-registry.ts:21 |
| OllamaTool | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/shared-tool-registry.ts:58 |
| OllamaToolCall | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/shared-tool-registry.ts:68 |
| ReadFileInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:66 |
| ListDirectoryInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:107 |
| FindFilesInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:139 |
| FindTextInFilesInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:171 |
| FetchWebpageInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:216 |
| WebSearchInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:248 |
| SearchResult | interface | Tooling Surface and Model Tools | component-private | private-subcomponent | src/tools/tool-executors.ts:298 |
| GetErrorsInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:356 |
| ReadGuidelineInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:395 |
| CreateFileInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:504 |
| EditFileInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:533 |
| MultiEditFileInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:564 |
| RunCommandInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:608 |
| RunVscodeCommandInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:639 |
| ManageTodoInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:681 |
| AskBigBrotherInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:753 |
| AskCopilotInput | interface | Tooling Surface and Model Tools | shared | shared-helper | src/tools/tool-executors.ts:1058 |
| HistoryEntry | interface | Trail and Markdown Views | component-private | private-subcomponent | src/handlers/markdownBrowser-handler.ts:50 |
| NavigationHistory | class | Trail and Markdown Views | component-private | functional-component | src/handlers/markdownBrowser-handler.ts:56 |
| MarkdownHtmlPreviewOptions | interface | Trail and Markdown Views | shared | functional-component | src/handlers/markdownHtmlPreview.ts:3 |
| TrailEntry | interface | Trail and Markdown Views | shared | functional-component | src/handlers/trailEditor-handler.ts:24 |
| TrailEditorProvider | class | Trail and Markdown Views | component-private | functional-component | src/handlers/trailEditor-handler.ts:60 |
| TrailSet | interface | Trail and Markdown Views | shared | functional-component | src/handlers/trailEditor-handler.ts:229 |
| TrailFile | interface | Trail and Markdown Views | shared | functional-component | src/handlers/trailViewer-handler.ts:34 |
| TrailExchange | interface | Trail and Markdown Views | shared | functional-component | src/handlers/trailViewer-handler.ts:41 |
| ParsedTrailFile | interface | Trail and Markdown Views | shared | functional-component | src/handlers/trailViewer-handler.ts:54 |
| TrailViewerFolderOption | interface | Trail and Markdown Views | component-private | private-subcomponent | src/handlers/trailViewer-handler.ts:310 |
| DiscoveredSubsystem | interface | Trail and Markdown Views | component-private | private-subcomponent | src/handlers/trailViewer-handler.ts:317 |
| TrailViewerState | interface | Trail and Markdown Views | component-private | private-subcomponent | src/handlers/trailViewer-handler.ts:323 |
| TrailType | type | Trail and Markdown Views | shared | shared-helper | src/services/trailLogging.ts:7 |
| TrailSubsystem | type | Trail and Markdown Views | shared | shared-helper | src/services/trailService.ts:8 |
| TrailMetadata | interface | Trail and Markdown Views | shared | shared-helper | src/services/trailService.ts:13 |
| RawTrailConfig | interface | Trail and Markdown Views | component-private | private-subcomponent | src/services/trailService.ts:19 |
| SummaryTrailConfig | interface | Trail and Markdown Views | component-private | private-subcomponent | src/services/trailService.ts:30 |
| TrailService | class | Trail and Markdown Views | shared | functional-component | src/services/trailService.ts:36 |
| AccordionSection | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/accordionPanel.ts:19 |
| AccordionPanelConfig | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/accordionPanel.ts:31 |
| ChordMenuItem | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/chordMenu-handler.ts:30 |
| ChordGroup | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/chordMenu-handler.ts:43 |
| PanelMode | type | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/issuesPanel-handler.ts:28 |
| ParsedStatus | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/issuesPanel-handler.ts:30 |
| ColumnDef | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/issuesPanel-handler.ts:41 |
| IssuePanelConfig | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/issuesPanel-handler.ts:55 |
| MinimalModeViewProvider | class | Window Layout, Panels, and UI Shell | component-private | functional-component | src/handlers/minimalMode-handler.ts:27 |
| StateAction | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/stateMachine-handler.ts:44 |
| InitActions | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/stateMachine-handler.ts:50 |
| ResetActions | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/stateMachine-handler.ts:56 |
| StateMachineConfig | interface | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/stateMachine-handler.ts:60 |
| StateMachineCommandsMap | type | Window Layout, Panels, and UI Shell | component-private | private-subcomponent | src/handlers/stateMachine-handler.ts:67 |
| FavoriteEntry | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/statusPage-handler.ts:41 |
| LlmConfiguration | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/statusPage-handler.ts:57 |
| AiConversationSetup | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/statusPage-handler.ts:81 |
| StatusData | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/statusPage-handler.ts:727 |
| TabSection | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/tabPanel.ts:19 |
| TabPanelConfig | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/tabPanel.ts:31 |
| SubsystemStatus | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/windowStatusPanel-handler.ts:48 |
| WindowStateFile | interface | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/windowStatusPanel-handler.ts:60 |
| WindowStatusViewProvider | class | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/windowStatusPanel-handler.ts:89 |
| WsPanelHandler | class | Window Layout, Panels, and UI Shell | shared | functional-component | src/handlers/wsPanel-handler.ts:49 |
