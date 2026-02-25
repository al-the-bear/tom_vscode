/**
 * Command Handlers Index
 *
 * This module exports all command handlers for the VS Code extension.
 * Each handler is responsible for a specific dartscript.* command.
 */

// Shared utilities
export {
    bridgeLog,
    handleError,
    reportException,
    getWorkspaceRoot,
    getConfigPath,
    getWorkspaceStructure,
    ensureBridgeRunning,
    getCopilotModel,
    sendCopilotRequest,
    validateDartFile,
    getFilePath,
    showAnalysisResult,
    getBridgeClient,
    setBridgeClient
} from './handler_shared';

// Command handlers
export { sendToChatHandler } from './sendToChat-handler';
export { SendToChatAdvancedManager } from './sendToChatAdvanced-handler';
export { executeInTomAiBuildHandler } from './executeInTomAiBuild-handler';
export { executeAsScriptHandler } from './executeAsScript-handler';
export { restartBridgeHandler, initializeBridgeClient, switchBridgeProfileHandler } from './restartBridge-handler';
export { runTestsHandler } from './runTests-handler';
export { reloadWindowHandler } from './reloadWindow-handler';
export {
    startCliServerHandler,
    startCliServerCustomPortHandler,
    stopCliServerHandler
} from './cliServer-handler';
export { startProcessMonitorHandler } from './processMonitor-handler';
export { toggleBridgeDebugLoggingHandler } from './debugLogging-handler';
export { printConfigurationHandler } from './printConfiguration-handler';
export { showHelpHandler } from './showHelp-handler';
export { showApiInfoHandler } from './showApiInfo-handler';
export { startTomAiChatHandler, sendToTomAiChatHandler, interruptTomAiChatHandler } from './tomAiChat-handler';
export {
    expandPromptHandler,
    createProfileHandler,
    switchModelHandler,
    PromptExpanderManager,
    setPromptExpanderManager,
    getPromptExpanderManager,
} from './expandPrompt-handler';
export {
    startBotConversationHandler,
    stopBotConversationHandler,
    haltBotConversationHandler,
    continueBotConversationHandler,
    addToBotConversationHandler,
    BotConversationManager,
    setBotConversationManager,
    getBotConversationManager,
} from './botConversation-handler';
export { registerChordMenuCommands } from './chordMenu-handler';
export { registerCommandlineCommands } from './commandline-handler';
export { registerCombinedCommands } from './combinedCommand-handler';
export { registerStateMachineCommands } from './stateMachine-handler';
export { telegramTestHandler, telegramToggleHandler, telegramConfigureHandler, disposeTelegramStandalone, isTelegramPollingActive } from './telegram-commands';
export { registerDsNotesViews } from './dsNotes-handler';
export { registerUnifiedNotepad } from './unifiedNotepad-handler';
export { registerT3Panel } from './t3Panel-handler';
export { registerQuestTodoPanel } from './questTodoPanel-handler';
export { registerChatVariablesEditorCommand } from './chatVariablesEditor-handler';
export { registerContextSettingsEditorCommand } from './contextSettingsEditor-handler';
export { registerQueueEditorCommand } from './queueEditor-handler';
export { registerTimedRequestsEditorCommand } from './timedRequestsEditor-handler';
export { registerGlobalTemplateEditorCommand, openGlobalTemplateEditor } from './globalTemplateEditor-handler';
export { registerReusablePromptEditorCommand, openReusablePromptEditor } from './reusablePromptEditor-handler';
export { toggleTrail, setTrailEnabled, isTrailEnabled, loadTrailConfig } from './trailLogger-handler';
export { showStatusPageHandler, toggleTrailHandler } from './statusPage-handler';
export { getCliServerStatus } from './cliServer-handler';
export { registerTrailViewerCommands } from './trailViewer-handler';

// YAML Graph Editor
export { registerYamlGraphEditor } from './yamlGraph-handler';
