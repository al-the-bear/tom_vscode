# Code Structure: Classes and Types

This document inventories all class/interface/type/enum declarations in src and classifies them for review into important functional components, smaller shared helpers, and component-private subcomponents.

## Classification Model

- shared: exported declaration reusable across files/components.
- component-private: non-exported declaration local to one source file/component.
- important functional component: classes and exported contracts that represent runtime features/services/managers/providers/editors/handlers.
- smaller helper: exported supporting contracts (DTOs/options/input/result/helper types).
- component-private subcomponent: local supporting contracts and module-internal helpers.

## Inventory Totals

- Source files scanned: 107
- Total declarations: 316
- class: 44
- interface: 225
- type: 47
- component-private: 111
- shared: 205

## Component Distribution

| Component | Total | Shared | Component-Private |
| --- | --- | --- | --- |
| handlers | 149 | 89 | 60 |
| tools | 60 | 22 | 38 |
| utils | 42 | 41 | 1 |
| managers | 39 | 33 | 6 |
| storage | 10 | 10 | 0 |
| root | 6 | 2 | 4 |
| services | 6 | 4 | 2 |
| types | 4 | 4 | 0 |

## Component-Level Structure

### handlers

- Total declarations: 149
- Shared declarations: 89
- Component-private declarations: 60

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| AccordionPanelConfig | interface | shared | src/handlers/accordionPanel.ts:31 |
| AiConversationManager | class | shared | src/handlers/aiConversation-handler.ts:340 |
| BridgeConfig | interface | shared | src/handlers/restartBridge-handler.ts:35 |
| BridgeProfile | interface | shared | src/handlers/restartBridge-handler.ts:27 |
| ChannelMessage | interface | shared | src/handlers/chat/chat-channel.ts:28 |
| ChannelMessageCallback | type | shared | src/handlers/chat/chat-channel.ts:44 |
| ChannelResult | interface | shared | src/handlers/chat/chat-channel.ts:22 |
| ChatChannel | interface | shared | src/handlers/chat/chat-channel.ts:78 |
| GitHubIssueProvider | class | shared | src/handlers/githubIssueProvider.ts:38 |
| IssueProvider | interface | shared | src/handlers/issueProvider.ts:72 |
| IssueProviderRepo | interface | shared | src/handlers/issueProvider.ts:14 |
| LocalLlmManager | class | shared | src/handlers/localLlm-handler.ts:250 |
| PanelMode | type | shared | src/handlers/issuesPanel-handler.ts:27 |
| QuestTodoEmbeddedViewProvider | class | shared | src/handlers/questTodoPanel-handler.ts:3953 |
| QuestTodoViewConfig | interface | shared | src/handlers/questTodoPanel-handler.ts:81 |
| SendToChatAdvancedManager | class | shared | src/handlers/copilotTemplates-handler.ts:52 |
| TabPanelConfig | interface | shared | src/handlers/tabPanel.ts:31 |
| TelegramChannel | class | shared | src/handlers/chat/telegram-channel.ts:57 |
| TelegramCommandRegistry | class | shared | src/handlers/telegram-cmd-parser.ts:86 |
| TelegramNotifier | class | shared | src/handlers/telegram-notifier.ts:89 |
| TelegramResponseFormatter | class | shared | src/handlers/telegram-cmd-response.ts:35 |
| TemplateEditorConfig | interface | shared | src/handlers/handler_shared.ts:749 |
| TemplateEditorField | interface | shared | src/handlers/handler_shared.ts:739 |
| TodoLogViewProvider | class | shared | src/handlers/todoLogPanel-handler.ts:44 |
| TomScriptingBridgeHandler | class | shared | src/handlers/tomScriptingBridge-handler.ts:42 |
| WindowStatusViewProvider | class | shared | src/handlers/windowStatusPanel-handler.ts:90 |
| WsPanelHandler | class | shared | src/handlers/wsPanel-handler.ts:48 |

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| AccordionSection | interface | shared | src/handlers/accordionPanel.ts:19 |
| ActorType | type | shared | src/handlers/aiConversation-handler.ts:92 |
| AiConversationConfig | interface | shared | src/handlers/aiConversation-handler.ts:136 |
| AiConversationProfile | interface | shared | src/handlers/aiConversation-handler.ts:107 |
| AiConversationSetup | interface | shared | src/handlers/statusPage-handler.ts:81 |
| AttachmentInfo | interface | shared | src/handlers/issueProvider.ts:55 |
| ChatParseResult | interface | shared | src/handlers/tomAiChat-utils.ts:49 |
| CommandlineEntry | interface | shared | src/handlers/commandline-handler.ts:38 |
| ConversationExchange | interface | shared | src/handlers/aiConversation-handler.ts:72 |
| ConversationMode | type | shared | src/handlers/aiConversation-handler.ts:89 |
| CopilotResponse | interface | shared | src/handlers/aiConversation-handler.ts:56 |
| CwdMode | type | shared | src/handlers/commandline-handler.ts:37 |
| DocPickerGroup | interface | shared | src/handlers/documentPicker.ts:35 |
| DocPickerProject | interface | shared | src/handlers/documentPicker.ts:40 |
| DocumentPickerConfig | interface | shared | src/handlers/documentPicker.ts:19 |
| ExpanderProcessResult | interface | shared | src/handlers/localLlm-handler.ts:148 |
| ExpanderProfile | interface | shared | src/handlers/localLlm-handler.ts:90 |
| FavoriteEntry | interface | shared | src/handlers/statusPage-handler.ts:41 |
| GitHubComment | interface | shared | src/handlers/githubApi.ts:41 |
| GitHubIssue | interface | shared | src/handlers/githubApi.ts:27 |
| GitHubLabel | interface | shared | src/handlers/githubApi.ts:20 |
| GitHubUser | interface | shared | src/handlers/githubApi.ts:15 |
| HistoryMode | type | shared | src/handlers/aiConversation-handler.ts:86 |
| IssueComment | interface | shared | src/handlers/issueProvider.ts:39 |
| IssueItem | interface | shared | src/handlers/issueProvider.ts:25 |
| IssueUpdates | interface | shared | src/handlers/issueProvider.ts:48 |
| IssueUser | interface | shared | src/handlers/issueProvider.ts:20 |
| LlmConfiguration | interface | shared | src/handlers/localLlm-handler.ts:62 |
| LlmConfiguration | interface | shared | src/handlers/statusPage-handler.ts:57 |
| LocalLlmConfig | interface | shared | src/handlers/localLlm-handler.ts:115 |
| LocalLlmHistoryMode | type | shared | src/handlers/localLlm-handler.ts:112 |
| LocalLlmMessage | interface | shared | src/handlers/localLlm-handler.ts:245 |
| MarkdownHtmlPreviewOptions | interface | shared | src/handlers/markdownHtmlPreview.ts:2 |
| ModelConfig | interface | shared | src/handlers/localLlm-handler.ts:44 |
| OllamaStats | interface | shared | src/handlers/localLlm-handler.ts:179 |
| ParsedContent | interface | shared | src/handlers/copilotTemplates-handler.ts:44 |
| ParsedTelegramCommand | interface | shared | src/handlers/telegram-cmd-parser.ts:22 |
| ParsedTrailFile | interface | shared | src/handlers/trailViewer-handler.ts:53 |
| PostActionDefinition | interface | shared | src/handlers/commandline-handler.ts:65 |
| PromptScope | type | shared | src/handlers/reusablePromptEditor-handler.ts:26 |
| PromptTemplateOptions | interface | shared | src/handlers/promptTemplate.ts:45 |
| RepoInfo | interface | shared | src/handlers/githubApi.ts:52 |
| SelfTalkPersona | interface | shared | src/handlers/aiConversation-handler.ts:95 |
| SendMessageOptions | interface | shared | src/handlers/chat/chat-channel.ts:47 |
| SendToChatFullConfig | interface | shared | src/handlers/copilotTemplates-handler.ts:34 |
| SendToChatTemplate | interface | shared | src/handlers/copilotTemplates-handler.ts:24 |
| StatusData | interface | shared | src/handlers/statusPage-handler.ts:727 |
| SubsystemStatus | interface | shared | src/handlers/windowStatusPanel-handler.ts:48 |
| TabSection | interface | shared | src/handlers/tabPanel.ts:19 |
| TelegramApiResult | type | shared | src/handlers/telegram-notifier.ts:66 |
| TelegramCommand | interface | shared | src/handlers/telegram-notifier.ts:49 |
| TelegramCommandCallback | type | shared | src/handlers/telegram-notifier.ts:63 |
| TelegramCommandDef | interface | shared | src/handlers/telegram-cmd-parser.ts:42 |
| TelegramCommandResult | interface | shared | src/handlers/telegram-cmd-parser.ts:70 |
| TelegramConfig | interface | shared | src/handlers/telegram-notifier.ts:23 |
| TelegramSubcommandDef | interface | shared | src/handlers/telegram-cmd-parser.ts:63 |
| TemplateCategory | type | shared | src/handlers/globalTemplateEditor-handler.ts:26 |
| TrailEntry | interface | shared | src/handlers/trailEditor-handler.ts:23 |
| TrailExchange | interface | shared | src/handlers/trailViewer-handler.ts:40 |
| TrailFile | interface | shared | src/handlers/trailViewer-handler.ts:33 |
| TrailSet | interface | shared | src/handlers/trailEditor-handler.ts:228 |
| WindowStateFile | interface | shared | src/handlers/windowStatusPanel-handler.ts:60 |

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| ApplicationMapping | type | component-private | src/handlers/handler_shared.ts:32 | no |
| ChatLogManager | class | component-private | src/handlers/tomAiChat-handler.ts:170 | no |
| ChatPanelViewProvider | class | component-private | src/handlers/chatPanel-handler.ts:417 | no |
| ChordGroup | interface | component-private | src/handlers/chordMenu-handler.ts:42 | no |
| ChordMenuItem | interface | component-private | src/handlers/chordMenu-handler.ts:29 | no |
| CliServerResponse | interface | component-private | src/handlers/cliServer-handler.ts:17 | no |
| CliServerStatusResponse | interface | component-private | src/handlers/cliServer-handler.ts:29 | no |
| ColumnDef | interface | component-private | src/handlers/issuesPanel-handler.ts:40 | no |
| CombinedCommandConfig | interface | component-private | src/handlers/combinedCommand-handler.ts:40 | no |
| CombinedCommandsMap | type | component-private | src/handlers/combinedCommand-handler.ts:49 | no |
| CommandlineQuickPickItem | interface | component-private | src/handlers/commandline-handler.ts:774 | no |
| ConfigPlaceholderContext | type | component-private | src/handlers/handler_shared.ts:33 | no |
| ConversationNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1468 | no |
| ConversationState | interface | component-private | src/handlers/aiConversation-handler.ts:195 | no |
| CopilotNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:873 | no |
| DebugLoggingResponse | interface | component-private | src/handlers/debugLogging-handler.ts:13 | no |
| DiscoveredSubsystem | interface | component-private | src/handlers/trailViewer-handler.ts:317 | no |
| DocPickerGroup | type | component-private | src/handlers/markdownBrowser-handler.ts:23 | no |
| ExecAction | type | component-private | src/handlers/commandline-handler.ts:298 | no |
| ExecutablesConfig | type | component-private | src/handlers/handler_shared.ts:30 | no |
| ExternalApplicationsConfig | type | component-private | src/handlers/handler_shared.ts:31 | no |
| GitHubContentResponse | interface | component-private | src/handlers/githubApi.ts:293 | no |
| GuidelinesNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2454 | no |
| HistoryEntry | interface | component-private | src/handlers/markdownBrowser-handler.ts:49 | no |
| InitActions | interface | component-private | src/handlers/stateMachine-handler.ts:49 | no |
| IssuePanelConfig | interface | component-private | src/handlers/issuesPanel-handler.ts:54 | no |
| LocalLlmNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1101 | no |
| MinimalModeViewProvider | class | component-private | src/handlers/minimalMode-handler.ts:26 | no |
| NavigationHistory | class | component-private | src/handlers/markdownBrowser-handler.ts:56 | no |
| NoteItem | interface | component-private | src/handlers/sidebarNotes-handler.ts:2144 | no |
| NotepadViewProvider | class | component-private | src/handlers/notepad-handler.ts:20 | no |
| NotesNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2154 | no |
| ParsedStatus | interface | component-private | src/handlers/issuesPanel-handler.ts:29 | no |
| PrintConfigurationResponse | interface | component-private | src/handlers/printConfiguration-handler.ts:14 | no |
| ProcessMonitorResponse | interface | component-private | src/handlers/processMonitor-handler.ts:14 | no |
| ProfileItem | interface | component-private | src/handlers/restartBridge-handler.ts:245 | no |
| ProjectInfo | interface | component-private | src/handlers/telegram-cmd-handlers.ts:73 | no |
| QtPanelState | interface | component-private | src/handlers/questTodoPanel-handler.ts:38 | no |
| QtPendingSelectState | interface | component-private | src/handlers/questTodoPanel-handler.ts:56 | no |
| QuestNotesProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:3137 | no |
| QuestTodoEditorProvider | class | component-private | src/handlers/questTodoEditor-handler.ts:35 | no |
| ResetActions | interface | component-private | src/handlers/stateMachine-handler.ts:55 | no |
| ScopeItem | interface | component-private | src/handlers/reusablePromptEditor-handler.ts:35 | no |
| Section | interface | component-private | src/handlers/chatPanel-handler.ts:410 | no |
| SessionTodosProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:3258 | no |
| StateAction | interface | component-private | src/handlers/stateMachine-handler.ts:43 | no |
| StateMachineCommandsMap | type | component-private | src/handlers/stateMachine-handler.ts:66 | no |
| StateMachineConfig | interface | component-private | src/handlers/stateMachine-handler.ts:59 | no |
| TelegramUpdate | interface | component-private | src/handlers/chat/telegram-channel.ts:35 | no |
| TemplateItem | interface | component-private | src/handlers/globalTemplateEditor-handler.ts:45 | no |
| TodoLogEntry | interface | component-private | src/handlers/todoLogPanel-handler.ts:488 | no |
| TomAiChatNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:1833 | no |
| TomNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:625 | no |
| TrailEditorProvider | class | component-private | src/handlers/trailEditor-handler.ts:59 | no |
| TrailEntry | type | component-private | src/handlers/todoLogPanel-handler.ts:18 | no |
| TrailSet | type | component-private | src/handlers/todoLogPanel-handler.ts:19 | no |
| TrailType | type | component-private | src/handlers/localLlm-handler.ts:36 | no |
| TrailViewerFolderOption | interface | component-private | src/handlers/trailViewer-handler.ts:309 | no |
| TrailViewerState | interface | component-private | src/handlers/trailViewer-handler.ts:322 | no |
| WorkspaceNotepadProvider | class | component-private | src/handlers/sidebarNotes-handler.ts:2745 | no |

### tools

- Total declarations: 60
- Shared declarations: 22
- Component-private declarations: 38

Important functional components

None.

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| AskBigBrotherConfig | interface | shared | src/tools/local-llm-tools-config.ts:22 |
| AskBigBrotherInput | interface | shared | src/tools/tool-executors.ts:752 |
| AskCopilotConfig | interface | shared | src/tools/local-llm-tools-config.ts:11 |
| AskCopilotInput | interface | shared | src/tools/tool-executors.ts:1057 |
| CreateFileInput | interface | shared | src/tools/tool-executors.ts:503 |
| EditFileInput | interface | shared | src/tools/tool-executors.ts:532 |
| FetchWebpageInput | interface | shared | src/tools/tool-executors.ts:215 |
| FindFilesInput | interface | shared | src/tools/tool-executors.ts:138 |
| FindTextInFilesInput | interface | shared | src/tools/tool-executors.ts:170 |
| GetErrorsInput | interface | shared | src/tools/tool-executors.ts:355 |
| ListDirectoryInput | interface | shared | src/tools/tool-executors.ts:106 |
| LocalLlmToolsConfig | interface | shared | src/tools/local-llm-tools-config.ts:39 |
| ManageTodoInput | interface | shared | src/tools/tool-executors.ts:680 |
| MultiEditFileInput | interface | shared | src/tools/tool-executors.ts:563 |
| OllamaTool | interface | shared | src/tools/shared-tool-registry.ts:58 |
| OllamaToolCall | interface | shared | src/tools/shared-tool-registry.ts:68 |
| ReadFileInput | interface | shared | src/tools/tool-executors.ts:65 |
| ReadGuidelineInput | interface | shared | src/tools/tool-executors.ts:394 |
| RunCommandInput | interface | shared | src/tools/tool-executors.ts:607 |
| RunVscodeCommandInput | interface | shared | src/tools/tool-executors.ts:638 |
| SharedToolDefinition | interface | shared | src/tools/shared-tool-registry.ts:21 |
| WebSearchInput | interface | shared | src/tools/tool-executors.ts:247 |

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| AddFollowUpPromptInput | interface | component-private | src/tools/chat-enhancement-tools.ts:812 | no |
| AddTimedRequestInput | interface | component-private | src/tools/chat-enhancement-tools.ts:871 | no |
| AddToPromptQueueInput | interface | component-private | src/tools/chat-enhancement-tools.ts:692 | no |
| CreateTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:334 | no |
| DeleteTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1602 | no |
| DetermineQuestInput | interface | component-private | src/tools/chat-enhancement-tools.ts:144 | no |
| GetAllTodosInput | interface | component-private | src/tools/chat-enhancement-tools.ts:251 | no |
| GetTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:304 | no |
| GetWorkspaceInfoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:105 | no |
| ListDocumentsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1739 | no |
| ListProjectsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1690 | no |
| ListQuestsInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1643 | no |
| ListTodosInput | interface | component-private | src/tools/chat-enhancement-tools.ts:192 | no |
| MoveTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:463 | no |
| NotifyUserInput | interface | component-private | src/tools/chat-enhancement-tools.ts:37 | no |
| PromptTemplateManageInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1435 | no |
| QueueListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:924 | no |
| QueueRemoveFollowUpInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1217 | no |
| QueueRemoveItemInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1131 | no |
| QueueSendNowInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1099 | no |
| QueueSetStatusInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1063 | no |
| QueueUpdateFollowUpInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1162 | no |
| QueueUpdateItemInput | interface | component-private | src/tools/chat-enhancement-tools.ts:981 | no |
| ReminderTemplateManageInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1524 | no |
| ResolverDef | interface | component-private | src/tools/chatVariableResolvers.ts:14 | no |
| SearchResult | interface | component-private | src/tools/tool-executors.ts:297 | no |
| SendQueuedPromptInput | interface | component-private | src/tools/chat-enhancement-tools.ts:760 | no |
| SessionTodoAddInput | interface | component-private | src/tools/chat-enhancement-tools.ts:499 | no |
| SessionTodoDeleteInput | interface | component-private | src/tools/chat-enhancement-tools.ts:654 | no |
| SessionTodoGetAllInput | interface | component-private | src/tools/chat-enhancement-tools.ts:578 | no |
| SessionTodoListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:545 | no |
| SessionTodoUpdateInput | interface | component-private | src/tools/chat-enhancement-tools.ts:607 | no |
| TimedListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1253 | no |
| TimedRemoveEntryInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1373 | no |
| TimedSetEngineStateInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1404 | no |
| TimedUpdateEntryInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1302 | no |
| UpdateTodoInput | interface | component-private | src/tools/chat-enhancement-tools.ts:401 | no |
| WorkspaceTodoListInput | interface | component-private | src/tools/chat-enhancement-tools.ts:1828 | no |

### utils

- Total declarations: 42
- Shared declarations: 41
- Component-private declarations: 1

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| BaseWebviewProvider | class | shared | src/utils/baseWebviewProvider.ts:2 |
| BridgeConfig | type | shared | src/utils/tomAiConfiguration.ts:23 |
| FsUtils | class | shared | src/utils/fsUtils.ts:4 |
| LinkHandler | interface | shared | src/utils/linkResolver.ts:86 |
| TomAiConfiguration | class | shared | src/utils/tomAiConfiguration.ts:40 |
| WsPaths | class | shared | src/utils/workspacePaths.ts:115 |

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| AiConversationConfig | type | shared | src/utils/tomAiConfiguration.ts:19 |
| ApplicationMapping | interface | shared | src/utils/executableResolver.ts:57 |
| BuildAnswerFilePathInput | interface | shared | src/utils/queueStep4Utils.ts:2 |
| ConfigPlaceholderContext | interface | shared | src/utils/executableResolver.ts:45 |
| CopilotConfig | type | shared | src/utils/tomAiConfiguration.ts:20 |
| DetectedRequestId | interface | shared | src/utils/queueStep4Utils.ts:26 |
| DetectedWorkspaceProject | interface | shared | src/utils/projectDetector.ts:240 |
| DetectorContainsRule | interface | shared | src/utils/projectDetector.ts:6 |
| DetectorScanOptions | interface | shared | src/utils/projectDetector.ts:248 |
| ExecutableConfig | interface | shared | src/utils/executableResolver.ts:30 |
| ExecutablesConfig | interface | shared | src/utils/executableResolver.ts:37 |
| ExternalApplicationsConfig | interface | shared | src/utils/executableResolver.ts:71 |
| FavoriteEntry | type | shared | src/utils/tomAiConfiguration.ts:26 |
| HealthCheckDecisions | interface | shared | src/utils/queueStep4Utils.ts:20 |
| HealthCheckInput | interface | shared | src/utils/queueStep4Utils.ts:9 |
| LinkAction | type | shared | src/utils/linkResolver.ts:65 |
| LinkContext | interface | shared | src/utils/linkResolver.ts:77 |
| LinkType | type | shared | src/utils/linkResolver.ts:50 |
| LocalLlmConfig | type | shared | src/utils/tomAiConfiguration.ts:17 |
| PlatformKey | type | shared | src/utils/executableResolver.ts:24 |
| ProjectDetectionResult | interface | shared | src/utils/projectDetector.ts:31 |
| ProjectDetectionRule | interface | shared | src/utils/projectDetector.ts:13 |
| ProjectDetector | interface | shared | src/utils/projectDetector.ts:19 |
| ProjectDetectorConfig | interface | shared | src/utils/projectDetector.ts:25 |
| QueueEntryFileNameInput | interface | shared | src/utils/queueStep5Utils.ts:1 |
| RemindersConfig | type | shared | src/utils/tomAiConfiguration.ts:25 |
| RepeatDecision | interface | shared | src/utils/queueStep3Utils.ts:1 |
| RepetitionAffixInput | interface | shared | src/utils/queueStep3Utils.ts:6 |
| ResolvedLink | interface | shared | src/utils/linkResolver.ts:26 |
| ResolveOptions | interface | shared | src/utils/variableResolver.ts:41 |
| SendToChatConfig | interface | shared | src/utils/sendToChatConfig.ts:22 |
| TodoConfig | type | shared | src/utils/tomAiConfiguration.ts:24 |
| TomAiChatConfig | type | shared | src/utils/tomAiConfiguration.ts:21 |
| TomAiConfigDefaults | interface | shared | src/utils/tomAiConfiguration.ts:27 |
| TrailConfig | type | shared | src/utils/tomAiConfiguration.ts:22 |

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| LogLevel | type | component-private | src/utils/debugLogger.ts:9 | no |

### managers

- Total declarations: 39
- Shared declarations: 33
- Component-private declarations: 6

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| ChatTodoSessionManager | class | shared | src/managers/chatTodoSessionManager.ts:20 |
| ChatVariablesStore | class | shared | src/managers/chatVariablesStore.ts:55 |
| PromptQueueManager | class | shared | src/managers/promptQueueManager.ts:159 |
| ReminderSystem | class | shared | src/managers/reminderSystem.ts:50 |
| SessionTodoStore | class | shared | src/managers/sessionTodoStore.ts:54 |
| TimerEngine | class | shared | src/managers/timerEngine.ts:72 |
| TodoProvider | class | shared | src/managers/todoProvider.ts:39 |
| TodoProviderOptions | interface | shared | src/managers/todoProvider.ts:31 |

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| ChangeLogEntry | interface | shared | src/managers/chatVariablesStore.ts:25 |
| ChangeSource | type | shared | src/managers/chatVariablesStore.ts:22 |
| ChatVariablesSnapshot | interface | shared | src/managers/chatVariablesStore.ts:34 |
| QuestTodoFile | interface | shared | src/managers/questTodoManager.ts:62 |
| QuestTodoItem | interface | shared | src/managers/questTodoManager.ts:42 |
| QuestTodoReference | interface | shared | src/managers/questTodoManager.ts:34 |
| QuestTodoScope | interface | shared | src/managers/questTodoManager.ts:26 |
| QueuedFollowUpPrompt | interface | shared | src/managers/promptQueueManager.ts:53 |
| QueuedPrePrompt | interface | shared | src/managers/promptQueueManager.ts:64 |
| QueuedPrompt | interface | shared | src/managers/promptQueueManager.ts:70 |
| QueuedPromptStatus | type | shared | src/managers/promptQueueManager.ts:50 |
| QueuedPromptType | type | shared | src/managers/promptQueueManager.ts:52 |
| ReminderConfig | interface | shared | src/managers/reminderSystem.ts:26 |
| ReminderTemplate | interface | shared | src/managers/reminderSystem.ts:19 |
| ScannedProject | interface | shared | src/managers/questTodoManager.ts:858 |
| ScheduledTime | interface | shared | src/managers/timerEngine.ts:19 |
| SessionTodoItem | interface | shared | src/managers/sessionTodoStore.ts:28 |
| SessionTodoSnapshot | interface | shared | src/managers/sessionTodoStore.ts:40 |
| TimedRequest | interface | shared | src/managers/timerEngine.ts:26 |
| TimedRequestStatus | type | shared | src/managers/timerEngine.ts:24 |
| TimerScheduleSlot | interface | shared | src/managers/timerEngine.ts:49 |
| TodoFilter | interface | shared | src/managers/todoProvider.ts:26 |
| TodoInput | interface | shared | src/managers/todoProvider.ts:17 |
| TodoItem | interface | shared | src/managers/chatTodoSessionManager.ts:3 |
| TodoOperationResult | interface | shared | src/managers/chatTodoSessionManager.ts:12 |

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| QuestTodoItem | type | component-private | src/managers/todoProvider.ts:14 | no |
| QueueEntryFile | type | component-private | src/managers/promptQueueManager.ts:27 | no |
| QueueFileYaml | type | component-private | src/managers/promptQueueManager.ts:28 | no |
| QueuePromptYaml | type | component-private | src/managers/promptQueueManager.ts:29 | no |
| QueueReminderConfig | type | component-private | src/managers/promptQueueManager.ts:30 | no |
| TestQueuedPrompt | interface | component-private | src/managers/__tests__/noReminder.test.ts:21 | yes |

### storage

- Total declarations: 10
- Shared declarations: 10
- Component-private declarations: 0

Important functional components

None.

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| QueueEntryFile | interface | shared | src/storage/queueFileStorage.ts:138 |
| QueueExecutionState | interface | shared | src/storage/queueFileStorage.ts:71 |
| QueueFileYaml | interface | shared | src/storage/queueFileStorage.ts:132 |
| QueueMetaYaml | interface | shared | src/storage/queueFileStorage.ts:113 |
| QueuePromptRef | type | shared | src/storage/queueFileStorage.ts:80 |
| QueuePromptYaml | interface | shared | src/storage/queueFileStorage.ts:83 |
| QueueReloadAfterReloadSetting | interface | shared | src/storage/queueFileStorage.ts:203 |
| QueueReminderConfig | interface | shared | src/storage/queueFileStorage.ts:60 |
| QueueSettings | interface | shared | src/storage/queueFileStorage.ts:209 |
| QueueTemplateFile | interface | shared | src/storage/queueFileStorage.ts:150 |

Component-private subcomponents

None.

### root

- Total declarations: 6
- Shared declarations: 2
- Component-private declarations: 4

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| BridgeTestRunner | class | shared | src/tests.ts:26 |
| DartBridgeClient | class | shared | src/vscode-bridge.ts:95 |

Smaller shared helpers

None.

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| JsonRpcNotification | interface | component-private | src/vscode-bridge.ts:83 | no |
| JsonRpcRequest | interface | component-private | src/vscode-bridge.ts:68 | no |
| JsonRpcResponse | interface | component-private | src/vscode-bridge.ts:76 | no |
| TestResult | interface | component-private | src/tests.ts:16 | no |

### services

- Total declarations: 6
- Shared declarations: 4
- Component-private declarations: 2

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| TrailService | class | shared | src/services/trailService.ts:35 |

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| TrailMetadata | interface | shared | src/services/trailService.ts:12 |
| TrailSubsystem | type | shared | src/services/trailService.ts:7 |
| TrailType | type | shared | src/services/trailLogging.ts:6 |

Component-private subcomponents

| Name | Kind | Scope | File | TestOnly |
| --- | --- | --- | --- | --- |
| RawTrailConfig | interface | component-private | src/services/trailService.ts:18 | no |
| SummaryTrailConfig | interface | component-private | src/services/trailService.ts:29 | no |

### types

- Total declarations: 4
- Shared declarations: 4
- Component-private declarations: 0

Important functional components

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| ChatPanelDraftMessage | interface | shared | src/types/webviewMessages.ts:12 |
| ChatPanelSendMessage | interface | shared | src/types/webviewMessages.ts:5 |
| TodoPanelMessage | interface | shared | src/types/webviewMessages.ts:18 |

Smaller shared helpers

| Name | Kind | Scope | File |
| --- | --- | --- | --- |
| WebviewMessage | interface | shared | src/types/webviewMessages.ts:1 |

Component-private subcomponents

None.

## Complete Declaration Index (All Classes/Types)

| Name | Kind | Scope | Category | Component | File | TestOnly |
| --- | --- | --- | --- | --- | --- | --- |
| AccordionSection | interface | shared | smaller helper | handlers | src/handlers/accordionPanel.ts:19 | no |
| AccordionPanelConfig | interface | shared | important functional component | handlers | src/handlers/accordionPanel.ts:31 | no |
| CopilotResponse | interface | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:56 | no |
| ConversationExchange | interface | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:72 | no |
| HistoryMode | type | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:86 | no |
| ConversationMode | type | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:89 | no |
| ActorType | type | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:92 | no |
| SelfTalkPersona | interface | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:95 | no |
| AiConversationProfile | interface | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:107 | no |
| AiConversationConfig | interface | shared | smaller helper | handlers | src/handlers/aiConversation-handler.ts:136 | no |
| ConversationState | interface | component-private | component-private subcomponent | handlers | src/handlers/aiConversation-handler.ts:195 | no |
| AiConversationManager | class | shared | important functional component | handlers | src/handlers/aiConversation-handler.ts:340 | no |
| ChannelResult | interface | shared | important functional component | handlers | src/handlers/chat/chat-channel.ts:22 | no |
| ChannelMessage | interface | shared | important functional component | handlers | src/handlers/chat/chat-channel.ts:28 | no |
| ChannelMessageCallback | type | shared | important functional component | handlers | src/handlers/chat/chat-channel.ts:44 | no |
| SendMessageOptions | interface | shared | smaller helper | handlers | src/handlers/chat/chat-channel.ts:47 | no |
| ChatChannel | interface | shared | important functional component | handlers | src/handlers/chat/chat-channel.ts:78 | no |
| TelegramUpdate | interface | component-private | component-private subcomponent | handlers | src/handlers/chat/telegram-channel.ts:35 | no |
| TelegramChannel | class | shared | important functional component | handlers | src/handlers/chat/telegram-channel.ts:57 | no |
| Section | interface | component-private | component-private subcomponent | handlers | src/handlers/chatPanel-handler.ts:410 | no |
| ChatPanelViewProvider | class | component-private | component-private subcomponent | handlers | src/handlers/chatPanel-handler.ts:417 | no |
| ChordMenuItem | interface | component-private | component-private subcomponent | handlers | src/handlers/chordMenu-handler.ts:29 | no |
| ChordGroup | interface | component-private | component-private subcomponent | handlers | src/handlers/chordMenu-handler.ts:42 | no |
| CliServerResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/cliServer-handler.ts:17 | no |
| CliServerStatusResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/cliServer-handler.ts:29 | no |
| CombinedCommandConfig | interface | component-private | component-private subcomponent | handlers | src/handlers/combinedCommand-handler.ts:40 | no |
| CombinedCommandsMap | type | component-private | component-private subcomponent | handlers | src/handlers/combinedCommand-handler.ts:49 | no |
| CwdMode | type | shared | smaller helper | handlers | src/handlers/commandline-handler.ts:37 | no |
| CommandlineEntry | interface | shared | smaller helper | handlers | src/handlers/commandline-handler.ts:38 | no |
| PostActionDefinition | interface | shared | smaller helper | handlers | src/handlers/commandline-handler.ts:65 | no |
| ExecAction | type | component-private | component-private subcomponent | handlers | src/handlers/commandline-handler.ts:298 | no |
| CommandlineQuickPickItem | interface | component-private | component-private subcomponent | handlers | src/handlers/commandline-handler.ts:774 | no |
| SendToChatTemplate | interface | shared | smaller helper | handlers | src/handlers/copilotTemplates-handler.ts:24 | no |
| SendToChatFullConfig | interface | shared | smaller helper | handlers | src/handlers/copilotTemplates-handler.ts:34 | no |
| ParsedContent | interface | shared | smaller helper | handlers | src/handlers/copilotTemplates-handler.ts:44 | no |
| SendToChatAdvancedManager | class | shared | important functional component | handlers | src/handlers/copilotTemplates-handler.ts:52 | no |
| DebugLoggingResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/debugLogging-handler.ts:13 | no |
| DocumentPickerConfig | interface | shared | smaller helper | handlers | src/handlers/documentPicker.ts:19 | no |
| DocPickerGroup | interface | shared | smaller helper | handlers | src/handlers/documentPicker.ts:35 | no |
| DocPickerProject | interface | shared | smaller helper | handlers | src/handlers/documentPicker.ts:40 | no |
| GitHubUser | interface | shared | smaller helper | handlers | src/handlers/githubApi.ts:15 | no |
| GitHubLabel | interface | shared | smaller helper | handlers | src/handlers/githubApi.ts:20 | no |
| GitHubIssue | interface | shared | smaller helper | handlers | src/handlers/githubApi.ts:27 | no |
| GitHubComment | interface | shared | smaller helper | handlers | src/handlers/githubApi.ts:41 | no |
| RepoInfo | interface | shared | smaller helper | handlers | src/handlers/githubApi.ts:52 | no |
| GitHubContentResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/githubApi.ts:293 | no |
| GitHubIssueProvider | class | shared | important functional component | handlers | src/handlers/githubIssueProvider.ts:38 | no |
| TemplateCategory | type | shared | smaller helper | handlers | src/handlers/globalTemplateEditor-handler.ts:26 | no |
| TemplateItem | interface | component-private | component-private subcomponent | handlers | src/handlers/globalTemplateEditor-handler.ts:45 | no |
| ExecutablesConfig | type | component-private | component-private subcomponent | handlers | src/handlers/handler_shared.ts:30 | no |
| ExternalApplicationsConfig | type | component-private | component-private subcomponent | handlers | src/handlers/handler_shared.ts:31 | no |
| ApplicationMapping | type | component-private | component-private subcomponent | handlers | src/handlers/handler_shared.ts:32 | no |
| ConfigPlaceholderContext | type | component-private | component-private subcomponent | handlers | src/handlers/handler_shared.ts:33 | no |
| TemplateEditorField | interface | shared | important functional component | handlers | src/handlers/handler_shared.ts:739 | no |
| TemplateEditorConfig | interface | shared | important functional component | handlers | src/handlers/handler_shared.ts:749 | no |
| IssueProviderRepo | interface | shared | important functional component | handlers | src/handlers/issueProvider.ts:14 | no |
| IssueUser | interface | shared | smaller helper | handlers | src/handlers/issueProvider.ts:20 | no |
| IssueItem | interface | shared | smaller helper | handlers | src/handlers/issueProvider.ts:25 | no |
| IssueComment | interface | shared | smaller helper | handlers | src/handlers/issueProvider.ts:39 | no |
| IssueUpdates | interface | shared | smaller helper | handlers | src/handlers/issueProvider.ts:48 | no |
| AttachmentInfo | interface | shared | smaller helper | handlers | src/handlers/issueProvider.ts:55 | no |
| IssueProvider | interface | shared | important functional component | handlers | src/handlers/issueProvider.ts:72 | no |
| PanelMode | type | shared | important functional component | handlers | src/handlers/issuesPanel-handler.ts:27 | no |
| ParsedStatus | interface | component-private | component-private subcomponent | handlers | src/handlers/issuesPanel-handler.ts:29 | no |
| ColumnDef | interface | component-private | component-private subcomponent | handlers | src/handlers/issuesPanel-handler.ts:40 | no |
| IssuePanelConfig | interface | component-private | component-private subcomponent | handlers | src/handlers/issuesPanel-handler.ts:54 | no |
| TrailType | type | component-private | component-private subcomponent | handlers | src/handlers/localLlm-handler.ts:36 | no |
| ModelConfig | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:44 | no |
| LlmConfiguration | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:62 | no |
| ExpanderProfile | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:90 | no |
| LocalLlmHistoryMode | type | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:112 | no |
| LocalLlmConfig | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:115 | no |
| ExpanderProcessResult | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:148 | no |
| OllamaStats | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:179 | no |
| LocalLlmMessage | interface | shared | smaller helper | handlers | src/handlers/localLlm-handler.ts:245 | no |
| LocalLlmManager | class | shared | important functional component | handlers | src/handlers/localLlm-handler.ts:250 | no |
| DocPickerGroup | type | component-private | component-private subcomponent | handlers | src/handlers/markdownBrowser-handler.ts:23 | no |
| HistoryEntry | interface | component-private | component-private subcomponent | handlers | src/handlers/markdownBrowser-handler.ts:49 | no |
| NavigationHistory | class | component-private | component-private subcomponent | handlers | src/handlers/markdownBrowser-handler.ts:56 | no |
| MarkdownHtmlPreviewOptions | interface | shared | smaller helper | handlers | src/handlers/markdownHtmlPreview.ts:2 | no |
| MinimalModeViewProvider | class | component-private | component-private subcomponent | handlers | src/handlers/minimalMode-handler.ts:26 | no |
| NotepadViewProvider | class | component-private | component-private subcomponent | handlers | src/handlers/notepad-handler.ts:20 | no |
| PrintConfigurationResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/printConfiguration-handler.ts:14 | no |
| ProcessMonitorResponse | interface | component-private | component-private subcomponent | handlers | src/handlers/processMonitor-handler.ts:14 | no |
| PromptTemplateOptions | interface | shared | smaller helper | handlers | src/handlers/promptTemplate.ts:45 | no |
| QuestTodoEditorProvider | class | component-private | component-private subcomponent | handlers | src/handlers/questTodoEditor-handler.ts:35 | no |
| QtPanelState | interface | component-private | component-private subcomponent | handlers | src/handlers/questTodoPanel-handler.ts:38 | no |
| QtPendingSelectState | interface | component-private | component-private subcomponent | handlers | src/handlers/questTodoPanel-handler.ts:56 | no |
| QuestTodoViewConfig | interface | shared | important functional component | handlers | src/handlers/questTodoPanel-handler.ts:81 | no |
| QuestTodoEmbeddedViewProvider | class | shared | important functional component | handlers | src/handlers/questTodoPanel-handler.ts:3953 | no |
| BridgeProfile | interface | shared | important functional component | handlers | src/handlers/restartBridge-handler.ts:27 | no |
| BridgeConfig | interface | shared | important functional component | handlers | src/handlers/restartBridge-handler.ts:35 | no |
| ProfileItem | interface | component-private | component-private subcomponent | handlers | src/handlers/restartBridge-handler.ts:245 | no |
| PromptScope | type | shared | smaller helper | handlers | src/handlers/reusablePromptEditor-handler.ts:26 | no |
| ScopeItem | interface | component-private | component-private subcomponent | handlers | src/handlers/reusablePromptEditor-handler.ts:35 | no |
| TomNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:625 | no |
| CopilotNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:873 | no |
| LocalLlmNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:1101 | no |
| ConversationNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:1468 | no |
| TomAiChatNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:1833 | no |
| NoteItem | interface | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:2144 | no |
| NotesNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:2154 | no |
| GuidelinesNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:2454 | no |
| WorkspaceNotepadProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:2745 | no |
| QuestNotesProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:3137 | no |
| SessionTodosProvider | class | component-private | component-private subcomponent | handlers | src/handlers/sidebarNotes-handler.ts:3258 | no |
| StateAction | interface | component-private | component-private subcomponent | handlers | src/handlers/stateMachine-handler.ts:43 | no |
| InitActions | interface | component-private | component-private subcomponent | handlers | src/handlers/stateMachine-handler.ts:49 | no |
| ResetActions | interface | component-private | component-private subcomponent | handlers | src/handlers/stateMachine-handler.ts:55 | no |
| StateMachineConfig | interface | component-private | component-private subcomponent | handlers | src/handlers/stateMachine-handler.ts:59 | no |
| StateMachineCommandsMap | type | component-private | component-private subcomponent | handlers | src/handlers/stateMachine-handler.ts:66 | no |
| FavoriteEntry | interface | shared | smaller helper | handlers | src/handlers/statusPage-handler.ts:41 | no |
| LlmConfiguration | interface | shared | smaller helper | handlers | src/handlers/statusPage-handler.ts:57 | no |
| AiConversationSetup | interface | shared | smaller helper | handlers | src/handlers/statusPage-handler.ts:81 | no |
| StatusData | interface | shared | smaller helper | handlers | src/handlers/statusPage-handler.ts:727 | no |
| TabSection | interface | shared | smaller helper | handlers | src/handlers/tabPanel.ts:19 | no |
| TabPanelConfig | interface | shared | important functional component | handlers | src/handlers/tabPanel.ts:31 | no |
| ProjectInfo | interface | component-private | component-private subcomponent | handlers | src/handlers/telegram-cmd-handlers.ts:73 | no |
| ParsedTelegramCommand | interface | shared | smaller helper | handlers | src/handlers/telegram-cmd-parser.ts:22 | no |
| TelegramCommandDef | interface | shared | smaller helper | handlers | src/handlers/telegram-cmd-parser.ts:42 | no |
| TelegramSubcommandDef | interface | shared | smaller helper | handlers | src/handlers/telegram-cmd-parser.ts:63 | no |
| TelegramCommandResult | interface | shared | smaller helper | handlers | src/handlers/telegram-cmd-parser.ts:70 | no |
| TelegramCommandRegistry | class | shared | important functional component | handlers | src/handlers/telegram-cmd-parser.ts:86 | no |
| TelegramResponseFormatter | class | shared | important functional component | handlers | src/handlers/telegram-cmd-response.ts:35 | no |
| TelegramConfig | interface | shared | smaller helper | handlers | src/handlers/telegram-notifier.ts:23 | no |
| TelegramCommand | interface | shared | smaller helper | handlers | src/handlers/telegram-notifier.ts:49 | no |
| TelegramCommandCallback | type | shared | smaller helper | handlers | src/handlers/telegram-notifier.ts:63 | no |
| TelegramApiResult | type | shared | smaller helper | handlers | src/handlers/telegram-notifier.ts:66 | no |
| TelegramNotifier | class | shared | important functional component | handlers | src/handlers/telegram-notifier.ts:89 | no |
| TrailEntry | type | component-private | component-private subcomponent | handlers | src/handlers/todoLogPanel-handler.ts:18 | no |
| TrailSet | type | component-private | component-private subcomponent | handlers | src/handlers/todoLogPanel-handler.ts:19 | no |
| TodoLogViewProvider | class | shared | important functional component | handlers | src/handlers/todoLogPanel-handler.ts:44 | no |
| TodoLogEntry | interface | component-private | component-private subcomponent | handlers | src/handlers/todoLogPanel-handler.ts:488 | no |
| ChatLogManager | class | component-private | component-private subcomponent | handlers | src/handlers/tomAiChat-handler.ts:170 | no |
| ChatParseResult | interface | shared | smaller helper | handlers | src/handlers/tomAiChat-utils.ts:49 | no |
| TomScriptingBridgeHandler | class | shared | important functional component | handlers | src/handlers/tomScriptingBridge-handler.ts:42 | no |
| TrailEntry | interface | shared | smaller helper | handlers | src/handlers/trailEditor-handler.ts:23 | no |
| TrailEditorProvider | class | component-private | component-private subcomponent | handlers | src/handlers/trailEditor-handler.ts:59 | no |
| TrailSet | interface | shared | smaller helper | handlers | src/handlers/trailEditor-handler.ts:228 | no |
| TrailFile | interface | shared | smaller helper | handlers | src/handlers/trailViewer-handler.ts:33 | no |
| TrailExchange | interface | shared | smaller helper | handlers | src/handlers/trailViewer-handler.ts:40 | no |
| ParsedTrailFile | interface | shared | smaller helper | handlers | src/handlers/trailViewer-handler.ts:53 | no |
| TrailViewerFolderOption | interface | component-private | component-private subcomponent | handlers | src/handlers/trailViewer-handler.ts:309 | no |
| DiscoveredSubsystem | interface | component-private | component-private subcomponent | handlers | src/handlers/trailViewer-handler.ts:317 | no |
| TrailViewerState | interface | component-private | component-private subcomponent | handlers | src/handlers/trailViewer-handler.ts:322 | no |
| SubsystemStatus | interface | shared | smaller helper | handlers | src/handlers/windowStatusPanel-handler.ts:48 | no |
| WindowStateFile | interface | shared | smaller helper | handlers | src/handlers/windowStatusPanel-handler.ts:60 | no |
| WindowStatusViewProvider | class | shared | important functional component | handlers | src/handlers/windowStatusPanel-handler.ts:90 | no |
| WsPanelHandler | class | shared | important functional component | handlers | src/handlers/wsPanel-handler.ts:48 | no |
| TestQueuedPrompt | interface | component-private | component-private subcomponent | managers | src/managers/__tests__/noReminder.test.ts:21 | yes |
| TodoItem | interface | shared | smaller helper | managers | src/managers/chatTodoSessionManager.ts:3 | no |
| TodoOperationResult | interface | shared | smaller helper | managers | src/managers/chatTodoSessionManager.ts:12 | no |
| ChatTodoSessionManager | class | shared | important functional component | managers | src/managers/chatTodoSessionManager.ts:20 | no |
| ChangeSource | type | shared | smaller helper | managers | src/managers/chatVariablesStore.ts:22 | no |
| ChangeLogEntry | interface | shared | smaller helper | managers | src/managers/chatVariablesStore.ts:25 | no |
| ChatVariablesSnapshot | interface | shared | smaller helper | managers | src/managers/chatVariablesStore.ts:34 | no |
| ChatVariablesStore | class | shared | important functional component | managers | src/managers/chatVariablesStore.ts:55 | no |
| QueueEntryFile | type | component-private | component-private subcomponent | managers | src/managers/promptQueueManager.ts:27 | no |
| QueueFileYaml | type | component-private | component-private subcomponent | managers | src/managers/promptQueueManager.ts:28 | no |
| QueuePromptYaml | type | component-private | component-private subcomponent | managers | src/managers/promptQueueManager.ts:29 | no |
| QueueReminderConfig | type | component-private | component-private subcomponent | managers | src/managers/promptQueueManager.ts:30 | no |
| QueuedPromptStatus | type | shared | smaller helper | managers | src/managers/promptQueueManager.ts:50 | no |
| QueuedPromptType | type | shared | smaller helper | managers | src/managers/promptQueueManager.ts:52 | no |
| QueuedFollowUpPrompt | interface | shared | smaller helper | managers | src/managers/promptQueueManager.ts:53 | no |
| QueuedPrePrompt | interface | shared | smaller helper | managers | src/managers/promptQueueManager.ts:64 | no |
| QueuedPrompt | interface | shared | smaller helper | managers | src/managers/promptQueueManager.ts:70 | no |
| PromptQueueManager | class | shared | important functional component | managers | src/managers/promptQueueManager.ts:159 | no |
| QuestTodoScope | interface | shared | smaller helper | managers | src/managers/questTodoManager.ts:26 | no |
| QuestTodoReference | interface | shared | smaller helper | managers | src/managers/questTodoManager.ts:34 | no |
| QuestTodoItem | interface | shared | smaller helper | managers | src/managers/questTodoManager.ts:42 | no |
| QuestTodoFile | interface | shared | smaller helper | managers | src/managers/questTodoManager.ts:62 | no |
| ScannedProject | interface | shared | smaller helper | managers | src/managers/questTodoManager.ts:858 | no |
| ReminderTemplate | interface | shared | smaller helper | managers | src/managers/reminderSystem.ts:19 | no |
| ReminderConfig | interface | shared | smaller helper | managers | src/managers/reminderSystem.ts:26 | no |
| ReminderSystem | class | shared | important functional component | managers | src/managers/reminderSystem.ts:50 | no |
| SessionTodoItem | interface | shared | smaller helper | managers | src/managers/sessionTodoStore.ts:28 | no |
| SessionTodoSnapshot | interface | shared | smaller helper | managers | src/managers/sessionTodoStore.ts:40 | no |
| SessionTodoStore | class | shared | important functional component | managers | src/managers/sessionTodoStore.ts:54 | no |
| ScheduledTime | interface | shared | smaller helper | managers | src/managers/timerEngine.ts:19 | no |
| TimedRequestStatus | type | shared | smaller helper | managers | src/managers/timerEngine.ts:24 | no |
| TimedRequest | interface | shared | smaller helper | managers | src/managers/timerEngine.ts:26 | no |
| TimerScheduleSlot | interface | shared | smaller helper | managers | src/managers/timerEngine.ts:49 | no |
| TimerEngine | class | shared | important functional component | managers | src/managers/timerEngine.ts:72 | no |
| QuestTodoItem | type | component-private | component-private subcomponent | managers | src/managers/todoProvider.ts:14 | no |
| TodoInput | interface | shared | smaller helper | managers | src/managers/todoProvider.ts:17 | no |
| TodoFilter | interface | shared | smaller helper | managers | src/managers/todoProvider.ts:26 | no |
| TodoProviderOptions | interface | shared | important functional component | managers | src/managers/todoProvider.ts:31 | no |
| TodoProvider | class | shared | important functional component | managers | src/managers/todoProvider.ts:39 | no |
| TestResult | interface | component-private | component-private subcomponent | root | src/tests.ts:16 | no |
| BridgeTestRunner | class | shared | important functional component | root | src/tests.ts:26 | no |
| JsonRpcRequest | interface | component-private | component-private subcomponent | root | src/vscode-bridge.ts:68 | no |
| JsonRpcResponse | interface | component-private | component-private subcomponent | root | src/vscode-bridge.ts:76 | no |
| JsonRpcNotification | interface | component-private | component-private subcomponent | root | src/vscode-bridge.ts:83 | no |
| DartBridgeClient | class | shared | important functional component | root | src/vscode-bridge.ts:95 | no |
| TrailType | type | shared | smaller helper | services | src/services/trailLogging.ts:6 | no |
| TrailSubsystem | type | shared | smaller helper | services | src/services/trailService.ts:7 | no |
| TrailMetadata | interface | shared | smaller helper | services | src/services/trailService.ts:12 | no |
| RawTrailConfig | interface | component-private | component-private subcomponent | services | src/services/trailService.ts:18 | no |
| SummaryTrailConfig | interface | component-private | component-private subcomponent | services | src/services/trailService.ts:29 | no |
| TrailService | class | shared | important functional component | services | src/services/trailService.ts:35 | no |
| QueueReminderConfig | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:60 | no |
| QueueExecutionState | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:71 | no |
| QueuePromptRef | type | shared | smaller helper | storage | src/storage/queueFileStorage.ts:80 | no |
| QueuePromptYaml | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:83 | no |
| QueueMetaYaml | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:113 | no |
| QueueFileYaml | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:132 | no |
| QueueEntryFile | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:138 | no |
| QueueTemplateFile | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:150 | no |
| QueueReloadAfterReloadSetting | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:203 | no |
| QueueSettings | interface | shared | smaller helper | storage | src/storage/queueFileStorage.ts:209 | no |
| NotifyUserInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:37 | no |
| GetWorkspaceInfoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:105 | no |
| DetermineQuestInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:144 | no |
| ListTodosInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:192 | no |
| GetAllTodosInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:251 | no |
| GetTodoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:304 | no |
| CreateTodoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:334 | no |
| UpdateTodoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:401 | no |
| MoveTodoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:463 | no |
| SessionTodoAddInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:499 | no |
| SessionTodoListInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:545 | no |
| SessionTodoGetAllInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:578 | no |
| SessionTodoUpdateInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:607 | no |
| SessionTodoDeleteInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:654 | no |
| AddToPromptQueueInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:692 | no |
| SendQueuedPromptInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:760 | no |
| AddFollowUpPromptInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:812 | no |
| AddTimedRequestInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:871 | no |
| QueueListInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:924 | no |
| QueueUpdateItemInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:981 | no |
| QueueSetStatusInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1063 | no |
| QueueSendNowInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1099 | no |
| QueueRemoveItemInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1131 | no |
| QueueUpdateFollowUpInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1162 | no |
| QueueRemoveFollowUpInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1217 | no |
| TimedListInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1253 | no |
| TimedUpdateEntryInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1302 | no |
| TimedRemoveEntryInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1373 | no |
| TimedSetEngineStateInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1404 | no |
| PromptTemplateManageInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1435 | no |
| ReminderTemplateManageInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1524 | no |
| DeleteTodoInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1602 | no |
| ListQuestsInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1643 | no |
| ListProjectsInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1690 | no |
| ListDocumentsInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1739 | no |
| WorkspaceTodoListInput | interface | component-private | component-private subcomponent | tools | src/tools/chat-enhancement-tools.ts:1828 | no |
| ResolverDef | interface | component-private | component-private subcomponent | tools | src/tools/chatVariableResolvers.ts:14 | no |
| AskCopilotConfig | interface | shared | smaller helper | tools | src/tools/local-llm-tools-config.ts:11 | no |
| AskBigBrotherConfig | interface | shared | smaller helper | tools | src/tools/local-llm-tools-config.ts:22 | no |
| LocalLlmToolsConfig | interface | shared | smaller helper | tools | src/tools/local-llm-tools-config.ts:39 | no |
| SharedToolDefinition | interface | shared | smaller helper | tools | src/tools/shared-tool-registry.ts:21 | no |
| OllamaTool | interface | shared | smaller helper | tools | src/tools/shared-tool-registry.ts:58 | no |
| OllamaToolCall | interface | shared | smaller helper | tools | src/tools/shared-tool-registry.ts:68 | no |
| ReadFileInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:65 | no |
| ListDirectoryInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:106 | no |
| FindFilesInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:138 | no |
| FindTextInFilesInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:170 | no |
| FetchWebpageInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:215 | no |
| WebSearchInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:247 | no |
| SearchResult | interface | component-private | component-private subcomponent | tools | src/tools/tool-executors.ts:297 | no |
| GetErrorsInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:355 | no |
| ReadGuidelineInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:394 | no |
| CreateFileInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:503 | no |
| EditFileInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:532 | no |
| MultiEditFileInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:563 | no |
| RunCommandInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:607 | no |
| RunVscodeCommandInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:638 | no |
| ManageTodoInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:680 | no |
| AskBigBrotherInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:752 | no |
| AskCopilotInput | interface | shared | smaller helper | tools | src/tools/tool-executors.ts:1057 | no |
| WebviewMessage | interface | shared | smaller helper | types | src/types/webviewMessages.ts:1 | no |
| ChatPanelSendMessage | interface | shared | important functional component | types | src/types/webviewMessages.ts:5 | no |
| ChatPanelDraftMessage | interface | shared | important functional component | types | src/types/webviewMessages.ts:12 | no |
| TodoPanelMessage | interface | shared | important functional component | types | src/types/webviewMessages.ts:18 | no |
| BaseWebviewProvider | class | shared | important functional component | utils | src/utils/baseWebviewProvider.ts:2 | no |
| LogLevel | type | component-private | component-private subcomponent | utils | src/utils/debugLogger.ts:9 | no |
| PlatformKey | type | shared | smaller helper | utils | src/utils/executableResolver.ts:24 | no |
| ExecutableConfig | interface | shared | smaller helper | utils | src/utils/executableResolver.ts:30 | no |
| ExecutablesConfig | interface | shared | smaller helper | utils | src/utils/executableResolver.ts:37 | no |
| ConfigPlaceholderContext | interface | shared | smaller helper | utils | src/utils/executableResolver.ts:45 | no |
| ApplicationMapping | interface | shared | smaller helper | utils | src/utils/executableResolver.ts:57 | no |
| ExternalApplicationsConfig | interface | shared | smaller helper | utils | src/utils/executableResolver.ts:71 | no |
| FsUtils | class | shared | important functional component | utils | src/utils/fsUtils.ts:4 | no |
| ResolvedLink | interface | shared | smaller helper | utils | src/utils/linkResolver.ts:26 | no |
| LinkType | type | shared | smaller helper | utils | src/utils/linkResolver.ts:50 | no |
| LinkAction | type | shared | smaller helper | utils | src/utils/linkResolver.ts:65 | no |
| LinkContext | interface | shared | smaller helper | utils | src/utils/linkResolver.ts:77 | no |
| LinkHandler | interface | shared | important functional component | utils | src/utils/linkResolver.ts:86 | no |
| DetectorContainsRule | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:6 | no |
| ProjectDetectionRule | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:13 | no |
| ProjectDetector | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:19 | no |
| ProjectDetectorConfig | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:25 | no |
| ProjectDetectionResult | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:31 | no |
| DetectedWorkspaceProject | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:240 | no |
| DetectorScanOptions | interface | shared | smaller helper | utils | src/utils/projectDetector.ts:248 | no |
| RepeatDecision | interface | shared | smaller helper | utils | src/utils/queueStep3Utils.ts:1 | no |
| RepetitionAffixInput | interface | shared | smaller helper | utils | src/utils/queueStep3Utils.ts:6 | no |
| BuildAnswerFilePathInput | interface | shared | smaller helper | utils | src/utils/queueStep4Utils.ts:2 | no |
| HealthCheckInput | interface | shared | smaller helper | utils | src/utils/queueStep4Utils.ts:9 | no |
| HealthCheckDecisions | interface | shared | smaller helper | utils | src/utils/queueStep4Utils.ts:20 | no |
| DetectedRequestId | interface | shared | smaller helper | utils | src/utils/queueStep4Utils.ts:26 | no |
| QueueEntryFileNameInput | interface | shared | smaller helper | utils | src/utils/queueStep5Utils.ts:1 | no |
| SendToChatConfig | interface | shared | smaller helper | utils | src/utils/sendToChatConfig.ts:22 | no |
| LocalLlmConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:17 | no |
| AiConversationConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:19 | no |
| CopilotConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:20 | no |
| TomAiChatConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:21 | no |
| TrailConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:22 | no |
| BridgeConfig | type | shared | important functional component | utils | src/utils/tomAiConfiguration.ts:23 | no |
| TodoConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:24 | no |
| RemindersConfig | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:25 | no |
| FavoriteEntry | type | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:26 | no |
| TomAiConfigDefaults | interface | shared | smaller helper | utils | src/utils/tomAiConfiguration.ts:27 | no |
| TomAiConfiguration | class | shared | important functional component | utils | src/utils/tomAiConfiguration.ts:40 | no |
| ResolveOptions | interface | shared | smaller helper | utils | src/utils/variableResolver.ts:41 | no |
| WsPaths | class | shared | important functional component | utils | src/utils/workspacePaths.ts:115 | no |
