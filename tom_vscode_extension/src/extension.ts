/**
 * DartScript VS Code Extension
 * 
 * Main extension entry point. This file handles activation, deactivation,
 * and command registration. All command implementations are in separate
 * handler files in the handlers/ directory.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Bridge and test utilities
import { DartBridgeClient } from './vscode-bridge';

// Command handlers
import {
    bridgeLog,
    reportException,
    getBridgeClient,
    setBridgeClient,
    initializeBridgeClient,
    sendToChatHandler,
    SendToChatAdvancedManager,
    executeInTomAiBuildHandler,
    executeAsScriptHandler,
    restartBridgeHandler,
    switchBridgeProfileHandler,
    runTestsHandler,
    reloadWindowHandler,
    startCliServerHandler,
    startCliServerCustomPortHandler,
    stopCliServerHandler,
    startProcessMonitorHandler,
    toggleBridgeDebugLoggingHandler,
    printConfigurationHandler,
    showHelpHandler,
    showApiInfoHandler,
    startTomAiChatHandler,
    sendToTomAiChatHandler,
    interruptTomAiChatHandler,
    expandPromptHandler,
    PromptExpanderManager,
    setPromptExpanderManager,
    getPromptExpanderManager,
    createProfileHandler,
    switchModelHandler,
    startBotConversationHandler,
    stopBotConversationHandler,
    haltBotConversationHandler,
    continueBotConversationHandler,
    addToBotConversationHandler,
    BotConversationManager,
    setBotConversationManager,
    registerChordMenuCommands,
    registerCommandlineCommands,
    registerCombinedCommands,
    registerStateMachineCommands,
    registerDsNotesViews,
    registerUnifiedNotepad,
    registerT3Panel,
    registerChatVariablesEditorCommand,
    registerContextSettingsEditorCommand,
    registerQueueEditorCommand,
    registerTimedRequestsEditorCommand,
    registerGlobalTemplateEditorCommand,
    registerReusablePromptEditorCommand,
    telegramTestHandler,
    telegramToggleHandler,
    telegramConfigureHandler,
    disposeTelegramStandalone,
    showStatusPageHandler,
    toggleTrailHandler,
    getConfigPath,
    registerYamlGraphEditor,
    registerTrailViewerCommands,
} from './handlers';

import { registerQuestTodoCustomEditor } from './handlers/questTodoEditor-handler';
import { registerTrailCustomEditor } from './handlers/trailEditor-handler';
import { registerTodoLogView } from './handlers/todoLogPanel-handler';
import { registerMinimalModePanels } from './handlers/minimalMode-handler';
import { initializeDebugLogger, installConsoleDebugRouting, debugLog } from './utils/debugLogger';
import { TomAiConfiguration } from './utils/tomAiConfiguration';
import { TrailService } from './services/trailService';

// Tom AI Chat tools
import { registerTomAiChatTools } from './tools/tomAiChat-tools';
import { initializeToolDescriptions } from './tools/tool-executors';

// Chat Enhancement stores & managers
import { ChatVariablesStore } from './managers/chatVariablesStore';
import { WindowSessionTodoStore } from './managers/windowSessionTodoStore';
import { PromptQueueManager } from './managers/promptQueueManager';
import { TimerEngine } from './managers/timerEngine';
import { ReminderSystem } from './managers/reminderSystem';
import { registerChatVariableResolvers } from './tools/chatVariableResolvers';

// Global manager instance for SendToChatAdvanced
let sendToChatAdvancedManager: SendToChatAdvancedManager | undefined;

// Global manager instance for Prompt Expander
let promptExpanderManager: PromptExpanderManager | undefined;

// Global manager instance for Bot Conversation
let botConversationManager: BotConversationManager | undefined;

let instrumentationInstalled = false;

function installGlobalInstrumentation(): void {
    if (instrumentationInstalled) {
        return;
    }
    instrumentationInstalled = true;

    try {
        const commandsAny = vscode.commands as unknown as {
            registerCommand: typeof vscode.commands.registerCommand;
            __dartscriptInstrumented?: boolean;
        };
        if (!commandsAny.__dartscriptInstrumented) {
            const originalRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);
            commandsAny.registerCommand = ((command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => {
                const wrappedCallback = async (...args: unknown[]) => {
                    try {
                        return await Promise.resolve(callback.apply(thisArg, args));
                    } catch (error) {
                        reportException(`command:${command}`, error, { argsCount: args.length });
                        throw error;
                    }
                };
                return originalRegisterCommand(command, wrappedCallback, thisArg);
            }) as typeof vscode.commands.registerCommand;
            commandsAny.__dartscriptInstrumented = true;
        }

        const windowAny = vscode.window as unknown as {
            registerWebviewViewProvider: typeof vscode.window.registerWebviewViewProvider;
            __dartscriptWebviewInstrumented?: boolean;
        };
        if (!windowAny.__dartscriptWebviewInstrumented) {
            const originalRegisterWebviewProvider = vscode.window.registerWebviewViewProvider.bind(vscode.window);
            windowAny.registerWebviewViewProvider = ((viewId, provider, options) => {
                const wrappedProvider: vscode.WebviewViewProvider = {
                    ...provider,
                    resolveWebviewView(webviewView, webviewViewResolveContext, token) {
                        const resolveStart = performance.now();
                        try {
                            const webviewAny = webviewView.webview as unknown as {
                                onDidReceiveMessage: typeof webviewView.webview.onDidReceiveMessage;
                                __dartscriptMessageInstrumented?: boolean;
                            };

                            if (!webviewAny.__dartscriptMessageInstrumented) {
                                const originalOnDidReceiveMessage = webviewView.webview.onDidReceiveMessage.bind(webviewView.webview);
                                webviewAny.onDidReceiveMessage = ((listener, thisArgs, disposables) => {
                                    const wrappedListener = async (message: unknown) => {
                                        try {
                                            return await Promise.resolve(listener.call(thisArgs, message));
                                        } catch (error) {
                                            const messageType =
                                                typeof message === 'object' && message !== null && 'type' in (message as Record<string, unknown>)
                                                    ? (message as Record<string, unknown>).type
                                                    : undefined;
                                            reportException(`webview:${viewId}.onDidReceiveMessage`, error, { messageType });
                                            throw error;
                                        }
                                    };
                                    return originalOnDidReceiveMessage(wrappedListener, thisArgs, disposables);
                                }) as typeof webviewView.webview.onDidReceiveMessage;
                                webviewAny.__dartscriptMessageInstrumented = true;
                            }

                            provider.resolveWebviewView(webviewView, webviewViewResolveContext, token);
                            const resolveMs = Math.round((performance.now() - resolveStart) * 100) / 100;
                            debugLog(`resolveWebviewView(${viewId}): ${resolveMs}ms`, 'INFO', 'webview.resolve');
                        } catch (error) {
                            const resolveMs = Math.round((performance.now() - resolveStart) * 100) / 100;
                            debugLog(`resolveWebviewView(${viewId}): FAILED after ${resolveMs}ms`, 'ERROR', 'webview.resolve');
                            reportException(`webviewProvider:${viewId}.resolveWebviewView`, error);
                            throw error;
                        }
                    },
                };
                return originalRegisterWebviewProvider(viewId, wrappedProvider, options);
            }) as typeof vscode.window.registerWebviewViewProvider;
            windowAny.__dartscriptWebviewInstrumented = true;
        }

        // NOTE: We intentionally do NOT install process-level unhandledRejection
        // or uncaughtException handlers. In VS Code, all extensions share the
        // same Node.js process, so process-level handlers catch errors from OTHER
        // extensions (e.g., GitHub PR extension's HTTP errors with circular
        // TLSSocket references, GitLens auth errors). This causes noisy,
        // non-actionable error floods in our log output.
        // Our own code is already covered by the command/webview wrappers above.

        bridgeLog('Global instrumentation installed', 'INFO');
    } catch (error) {
        reportException('instrumentation:installGlobalInstrumentation', error);
    }
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

/**
 * Main extension activation function
 */
export async function activate(context: vscode.ExtensionContext) {
    const activateStart = performance.now();
    const timings: { step: string; ms: number }[] = [];
    const timeStep = (label: string, start: number) => {
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        timings.push({ step: label, ms: elapsed });
    };
    let stepStart: number;

    stepStart = performance.now();
    initializeDebugLogger(context);
    installConsoleDebugRouting();
    debugLog('Debug logger initialized', 'INFO', 'extension.activate');
    timeStep('debugLogger + consoleRouting', stepStart);

    stepStart = performance.now();
    installGlobalInstrumentation();
    timeStep('globalInstrumentation', stepStart);

    // ── Check for Tom AI workspace ──────────────────────────────────
    // If there is no .tom/ config folder in the workspace root, skip full
    // initialization and show an informational message instead.
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const hasTomConfig = wsRoot ? fs.existsSync(path.join(wsRoot, '.tom')) : false;
    if (!hasTomConfig) {
        const totalMs = Math.round((performance.now() - activateStart) * 100) / 100;
        const msg = 'TOM AI: no TOM AI config found (.tom/ folder missing). Extension running in minimal mode.';
        debugLog(msg, 'INFO', 'extension.activate');
        vscode.window.showInformationMessage(msg);

        // Register only basic, non-invasive features that don't create files
        registerCommands(context);
        registerChordMenuCommands(context);
        registerCombinedCommands(context);
        registerStateMachineCommands(context);

        // Register placeholder panels so they show setup instructions instead of
        // infinite loading indicators
        registerMinimalModePanels(context);

        bridgeLog(`DartScript minimal activation in ${totalMs}ms`);
        return;
    }

    bridgeLog('DartScript extension is now active!');

    stepStart = performance.now();
    TomAiConfiguration.init(context);
    TrailService.init(context);
    timeStep('tomAiConfiguration + trailService', stepStart);

    // Initialize bridge client
    stepStart = performance.now();
    const bridgeClient = initializeBridgeClient(context);
    timeStep('bridgeClient', stepStart);

    // Register all commands
    stepStart = performance.now();
    registerCommands(context);
    timeStep('registerCommands', stepStart);

    // Register chord menu (which-key) commands
    stepStart = performance.now();
    registerChordMenuCommands(context);
    timeStep('chordMenuCommands', stepStart);

    // Register commandline commands
    stepStart = performance.now();
    registerCommandlineCommands(context);
    timeStep('commandlineCommands', stepStart);

    // Register combined commands (configurable multi-command shortcuts)
    stepStart = performance.now();
    registerCombinedCommands(context);
    timeStep('combinedCommands', stepStart);

    // Register state machine commands (stateful multi-command shortcuts)
    stepStart = performance.now();
    registerStateMachineCommands(context);
    timeStep('stateMachineCommands', stepStart);

    // Register DS Notes panel views
    stepStart = performance.now();
    registerDsNotesViews(context);
    timeStep('dsNotesViews', stepStart);

    // Register Unified Notepad (T2) panel
    stepStart = performance.now();
    registerUnifiedNotepad(context);
    timeStep('unifiedNotepad', stepStart);

    // Register T3 panel (includes Issues, Tests, and Quest TODO tabs)
    stepStart = performance.now();
    registerT3Panel(context);
    timeStep('t3Panel', stepStart);

    // Register Chat Variables Editor command
    stepStart = performance.now();
    registerChatVariablesEditorCommand(context);
    timeStep('chatVariablesEditor', stepStart);

    // Register Context & Settings Editor command
    stepStart = performance.now();
    registerContextSettingsEditorCommand(context);
    timeStep('contextSettingsEditor', stepStart);

    // Register Global Template Editor command
    stepStart = performance.now();
    registerGlobalTemplateEditorCommand(context);
    timeStep('globalTemplateEditor', stepStart);

    // Register Reusable Prompt Editor command
    stepStart = performance.now();
    registerReusablePromptEditorCommand(context);
    timeStep('reusablePromptEditor', stepStart);

    // Register Queue Editor command
    stepStart = performance.now();
    registerQueueEditorCommand(context);
    timeStep('queueEditor', stepStart);

    // Register Timed Requests Editor command
    stepStart = performance.now();
    registerTimedRequestsEditorCommand(context);
    timeStep('timedRequestsEditor', stepStart);

    // Register YAML Graph Editor (custom editor for *.flow.yaml, *.state.yaml, *.er.yaml)
    // NOTE: Graph type registration is deferred to background inside registerYamlGraphEditor.
    // The custom editor is registered immediately; graph types are loaded lazily.
    stepStart = performance.now();
    await registerYamlGraphEditor(context);
    timeStep('yamlGraphEditor (editor registered, types deferred)', stepStart);

    // Register Quest TODO custom editor for *.todo.yaml files
    stepStart = performance.now();
    registerQuestTodoCustomEditor(context);
    timeStep('questTodoEditor', stepStart);

    // Register Trail Viewer custom editor for *.prompts.md / *.answers.md files
    stepStart = performance.now();
    registerTrailCustomEditor(context);
    timeStep('trailEditor', stepStart);

    // Register Trail Viewer commands
    stepStart = performance.now();
    context.subscriptions.push(...registerTrailViewerCommands(context));
    timeStep('trailViewerCommands', stepStart);

    // Register TODO Log explorer sidebar panel
    stepStart = performance.now();
    context.subscriptions.push(registerTodoLogView(context));
    timeStep('todoLogView', stepStart);

    // Check for test reinstall marker and send reload prompt to Copilot Chat
    stepStart = performance.now();
    checkTestReinstallMarker();
    timeStep('checkReinstallMarker', stepStart);

    // Auto-start the Dart bridge
    stepStart = performance.now();
    await restartBridgeHandler(context, false);
    timeStep('restartBridgeHandler', stepStart);

    // CLI Server autostart: if enabled in config, start after bridge is ready
    {
        const { loadSendToChatConfig } = await import('./utils/sendToChatConfig.js');
        const stcConfig = loadSendToChatConfig();
        if (stcConfig?.cliServerAutostart) {
            // Small delay to let bridge fully settle before starting CLI server
            setTimeout(async () => {
                try {
                    await startCliServerHandler();
                    bridgeLog('CLI server auto-started', 'INFO');
                } catch (e: any) {
                    bridgeLog(`CLI server autostart failed: ${e.message}`, 'ERROR');
                }
            }, 2000);
        }
        if (stcConfig?.telegramAutostart) {
            // Start Telegram polling after a short delay
            setTimeout(async () => {
                try {
                    await telegramToggleHandler();
                    bridgeLog('Telegram auto-started', 'INFO');
                } catch (e: any) {
                    bridgeLog(`Telegram autostart failed: ${e.message}`, 'ERROR');
                }
            }, 3000);
        }
    }

    // Initialize Send to Chat Advanced manager
    stepStart = performance.now();
    sendToChatAdvancedManager = new SendToChatAdvancedManager(context, DartBridgeClient.outputChannel);
    await sendToChatAdvancedManager.initialize();
    context.subscriptions.push({ dispose: () => sendToChatAdvancedManager?.dispose() });
    timeStep('sendToChatAdvancedManager', stepStart);

    // Initialize Prompt Expander manager
    stepStart = performance.now();
    promptExpanderManager = new PromptExpanderManager(context);
    setPromptExpanderManager(promptExpanderManager);
    registerLocalLlmContextMenuCommands(context);
    context.subscriptions.push({ dispose: () => promptExpanderManager?.dispose() });
    timeStep('promptExpanderManager', stepStart);

    // Initialize Bot Conversation manager
    stepStart = performance.now();
    botConversationManager = new BotConversationManager(context);
    setBotConversationManager(botConversationManager);
    context.subscriptions.push({ dispose: () => botConversationManager?.dispose() });
    timeStep('botConversationManager', stepStart);

    // Dispose standalone Telegram on deactivation
    context.subscriptions.push({ dispose: () => disposeTelegramStandalone() });

    // Initialize Chat Enhancement stores (§1.1–§1.4)
    stepStart = performance.now();
    ChatVariablesStore.init(context);
    const windowId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    WindowSessionTodoStore.init(context, windowId);
    timeStep('chatEnhancementStores', stepStart);

    // Initialize Queue & Automation (§3.2–§3.4)
    stepStart = performance.now();
    PromptQueueManager.init(context);
    TimerEngine.init(context);
    ReminderSystem.init(context);
    ReminderSystem.instance.bindToQueue();
    context.subscriptions.push({ dispose: () => PromptQueueManager.instance.dispose() });
    context.subscriptions.push({ dispose: () => TimerEngine.instance.dispose() });
    context.subscriptions.push({ dispose: () => ReminderSystem.instance.dispose() });
    timeStep('queueAutomation', stepStart);

    // Register Tom AI Chat tools
    stepStart = performance.now();
    initializeToolDescriptions();
    timeStep('tomAiChatTools.initToolDescriptions', stepStart);
    // Escalation tools (Ask Big Brother, Ask Copilot) are lazy-initialized
    // on first use — selectChatModels() takes 20–30s during activation rush
    // but <1s when the event loop is idle.
    stepStart = performance.now();
    registerTomAiChatTools(context);
    timeStep('tomAiChatTools.registerTools', stepStart);

    // Register chat variable resolvers (#quest, #role, etc.)
    stepStart = performance.now();
    registerChatVariableResolvers(context);
    timeStep('chatVariableResolvers', stepStart);

    // --- Activation timing summary ---
    const totalMs = Math.round((performance.now() - activateStart) * 100) / 100;
    const sortedTimings = [...timings].sort((a, b) => b.ms - a.ms);
    const timingLines = sortedTimings.map(t => `  ${t.step}: ${t.ms}ms`);
    const timingSummary = `DartScript activate(): ${totalMs}ms total\n${timingLines.join('\n')}`;
    debugLog(timingSummary, 'INFO', 'extension.activate');

    // Show activation message with timing
    vscode.window.showInformationMessage(`DartScript activated in ${totalMs}ms`);

    bridgeLog('DartScript extension is now active!');
}

/**
 * Extension deactivation function
 * Note: This is called synchronously when VS Code is about to reload/close
 */
export function deactivate() {
    bridgeLog('DartScript extension deactivating - stopping bridge...');
    
    // Stop the bridge process to ensure clean shutdown
    const bridgeClient = getBridgeClient();
    if (bridgeClient) {
        try {
            bridgeClient.stop();
            bridgeLog('Bridge process stopped');
        } catch (error) {
            bridgeLog(`Failed to stop bridge: ${error}`, 'ERROR');
        }
    }
    
    bridgeLog('DartScript extension deactivated');
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register all extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Send to Chat command - sends selected text to Copilot Chat
    const sendToChatCmd = vscode.commands.registerCommand(
        'dartscript.sendToChat',
        async () => {
            await sendToChatHandler();
        }
    );

    // Execute Dart file in DartScript (executeFile)
    const executeInTomAiBuildCmd = vscode.commands.registerCommand(
        'dartscript.executeFile',
        async (uri?: vscode.Uri) => {
            await executeInTomAiBuildHandler(uri, context);
        }
    );

    // Execute Dart file as script in DartScript (executeScript)
    const executeAsScriptInTomAiBuildCmd = vscode.commands.registerCommand(
        'dartscript.executeScript',
        async (uri?: vscode.Uri) => {
            await executeAsScriptHandler(uri, context);
        }
    );

    // Restart/Start Dart Bridge command
    const restartBridgeCmd = vscode.commands.registerCommand(
        'dartscript.restartBridge',
        async () => {
            await restartBridgeHandler(context, true);
        }
    );

    // Switch Bridge Profile command
    const switchBridgeProfileCmd = vscode.commands.registerCommand(
        'dartscript.switchBridgeProfile',
        async () => {
            await switchBridgeProfileHandler(context);
        }
    );

    // Run Tests command - executes all tests from tom_vscode_bridge/test/
    const runTestsCmd = vscode.commands.registerCommand(
        'dartscript.runTests',
        async () => {
            return await runTestsHandler(context);
        }
    );

    // Reload window with bridge notification command
    const reloadWithBridgeNotificationCmd = vscode.commands.registerCommand(
        'dartscript.reloadWindow',
        async () => {
            await reloadWindowHandler();
        }
    );

    // Reload Send to Chat config command
    const reloadSendToChatConfigCmd = vscode.commands.registerCommand(
        'dartscript.reloadSendToChatConfig',
        async () => {
            if (sendToChatAdvancedManager) {
                await sendToChatAdvancedManager.loadConfig();
                vscode.window.showInformationMessage('Send to Chat configuration reloaded');
            }
        }
    );

    // CLI Integration Server commands
    const startCliServerCmd = vscode.commands.registerCommand(
        'dartscript.startCliServer',
        async () => {
            await startCliServerHandler();
        }
    );

    const startCliServerCustomPortCmd = vscode.commands.registerCommand(
        'dartscript.startCliServerCustomPort',
        async () => {
            await startCliServerCustomPortHandler();
        }
    );

    const stopCliServerCmd = vscode.commands.registerCommand(
        'dartscript.stopCliServer',
        async () => {
            await stopCliServerHandler();
        }
    );

    // Process Monitor command
    const startProcessMonitorCmd = vscode.commands.registerCommand(
        'dartscript.startProcessMonitor',
        async () => {
            await startProcessMonitorHandler();
        }
    );

    // Debug Logging toggle command
    const toggleDebugLoggingCmd = vscode.commands.registerCommand(
        'dartscript.toggleBridgeDebugLogging',
        async () => {
            await toggleBridgeDebugLoggingHandler();
        }
    );

    // Print Configuration command
    const printConfigurationCmd = vscode.commands.registerCommand(
        'dartscript.printConfiguration',
        async () => {
            await printConfigurationHandler();
        }
    );

    // Show Help command
    const showHelpCmd = vscode.commands.registerCommand(
        'dartscript.showHelp',
        async () => {
            await showHelpHandler();
        }
    );

    // Show API Info command
    const showApiInfoCmd = vscode.commands.registerCommand(
        'dartscript.showApiInfo',
        async () => {
            await showApiInfoHandler();
        }
    );

    // Tom AI Chat commands
    const startTomAiChatCmd = vscode.commands.registerCommand(
        'dartscript.startTomAIChat',
        async () => {
            await startTomAiChatHandler();
        }
    );

    const sendToTomAiChatCmd = vscode.commands.registerCommand(
        'dartscript.sendToTomAIChat',
        async () => {
            await sendToTomAiChatHandler();
        }
    );

    const interruptTomAiChatCmd = vscode.commands.registerCommand(
        'dartscript.interruptTomAIChat',
        () => {
            interruptTomAiChatHandler();
        }
    );

    // Expand Prompt with local Ollama model
    const expandPromptCmd = vscode.commands.registerCommand(
        'dartscript.expandPrompt',
        async () => {
            await expandPromptHandler();
        }
    );

    // Switch local Ollama model
    const switchLocalModelCmd = vscode.commands.registerCommand(
        'dartscript.switchLocalModel',
        async () => {
            await switchModelHandler();
        }
    );

    // Start Bot Conversation
    const startBotConversationCmd = vscode.commands.registerCommand(
        'dartscript.startBotConversation',
        async () => {
            await startBotConversationHandler();
        }
    );

    // Stop Bot Conversation
    const stopBotConversationCmd = vscode.commands.registerCommand(
        'dartscript.stopBotConversation',
        async () => {
            await stopBotConversationHandler();
        }
    );

    // Halt Bot Conversation
    const haltBotConversationCmd = vscode.commands.registerCommand(
        'dartscript.haltBotConversation',
        async () => {
            await haltBotConversationHandler();
        }
    );

    // Continue Bot Conversation
    const continueBotConversationCmd = vscode.commands.registerCommand(
        'dartscript.continueBotConversation',
        async () => {
            await continueBotConversationHandler();
        }
    );

    // Add to Bot Conversation
    const addToBotConversationCmd = vscode.commands.registerCommand(
        'dartscript.addToBotConversation',
        async () => {
            await addToBotConversationHandler();
        }
    );

    // Telegram Test Connection
    const telegramTestCmd = vscode.commands.registerCommand(
        'dartscript.telegramTest',
        async () => {
            await telegramTestHandler();
        }
    );

    // Telegram Toggle Polling
    const telegramToggleCmd = vscode.commands.registerCommand(
        'dartscript.telegramToggle',
        async () => {
            await telegramToggleHandler();
        }
    );

    // Telegram Configure
    const telegramConfigureCmd = vscode.commands.registerCommand(
        'dartscript.telegramConfigure',
        async () => {
            await telegramConfigureHandler();
        }
    );

    // Toggle AI Trail logging
    const toggleTrailCmd = vscode.commands.registerCommand(
        'dartscript.toggleTrail',
        async () => {
            await toggleTrailHandler();
        }
    );

    // Show Status Page
    const showStatusPageCmd = vscode.commands.registerCommand(
        'dartscript.showStatusPage',
        async () => {
            await showStatusPageHandler();
        }
    );

    // Open in External Application - uses externalApplications config
    const openInExternalAppCmd = vscode.commands.registerCommand(
        'dartscript.openInExternalApp',
        async (uri?: vscode.Uri) => {
            // Get the file to open
            const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!filePath) {
                vscode.window.showWarningMessage('No file selected to open');
                return;
            }
            
            const { openInExternalApplication, getExternalApplicationForFile } = await import('./handlers/handler_shared.js');
            
            // Check if there's a configured application
            const app = getExternalApplicationForFile(filePath);
            if (!app) {
                vscode.window.showWarningMessage(
                    `No external application configured for this file type. ` +
                    `Configure in tom_vscode_extension.json → externalApplications.mappings`
                );
                return;
            }
            
            if (!app.executable) {
                vscode.window.showWarningMessage(
                    `Executable '${app.executableName}' not configured for current platform. ` +
                    `Configure in tom_vscode_extension.json → executables.${app.executableName}`
                );
                return;
            }
            
            const success = await openInExternalApplication(filePath);
            if (!success) {
                vscode.window.showErrorMessage(
                    `Failed to open file in ${app.label || app.executableName}`
                );
            }
        }
    );

    // Open in MD Viewer - dedicated command for markdown files
    const openInMdViewerCmd = vscode.commands.registerCommand(
        'dartscript.openInMdViewer',
        async (uri?: vscode.Uri) => {
            const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!filePath) {
                vscode.window.showWarningMessage('No file selected to open');
                return;
            }
            
            const { openInExternalApplication, getExternalApplicationForFile } = await import('./handlers/handler_shared.js');
            
            const app = getExternalApplicationForFile(filePath);
            if (!app) {
                vscode.window.showWarningMessage(
                    `No MD viewer configured. ` +
                    `Configure in tom_vscode_extension.json → executables + externalApplications.mappings for .md files`
                );
                return;
            }
            
            if (!app.executable) {
                vscode.window.showWarningMessage(
                    `Executable '${app.executableName}' not configured for current platform. ` +
                    `Configure in tom_vscode_extension.json → executables.${app.executableName}`
                );
                return;
            }
            
            const success = await openInExternalApplication(filePath);
            if (!success) {
                vscode.window.showErrorMessage(
                    `Failed to open file in ${app.label || app.executableName}`
                );
            }
        }
    );

    // Open Extension Settings File
    const openExtensionSettingsCmd = vscode.commands.registerCommand(
        'dartscript.openExtensionSettings',
        async () => {
            const configPath = getConfigPath();
            if (configPath && fs.existsSync(configPath)) {
                const doc = await vscode.workspace.openTextDocument(configPath);
                await vscode.window.showTextDocument(doc);
            } else {
                vscode.window.showWarningMessage(`Extension settings file not found: ${configPath}`);
            }
        }
    );

    // Add all commands to subscriptions
    context.subscriptions.push(
        sendToChatCmd,
        executeInTomAiBuildCmd,
        executeAsScriptInTomAiBuildCmd,
        restartBridgeCmd,
        switchBridgeProfileCmd,
        runTestsCmd,
        reloadWithBridgeNotificationCmd,
        reloadSendToChatConfigCmd,
        startCliServerCmd,
        startCliServerCustomPortCmd,
        stopCliServerCmd,
        startProcessMonitorCmd,
        toggleDebugLoggingCmd,
        printConfigurationCmd,
        showHelpCmd,
        showApiInfoCmd,
        startTomAiChatCmd,
        sendToTomAiChatCmd,
        interruptTomAiChatCmd,
        expandPromptCmd,
        switchLocalModelCmd,
        startBotConversationCmd,
        stopBotConversationCmd,
        haltBotConversationCmd,
        continueBotConversationCmd,
        addToBotConversationCmd,
        telegramTestCmd,
        telegramToggleCmd,
        telegramConfigureCmd,
        toggleTrailCmd,
        showStatusPageCmd,
        openInExternalAppCmd,
        openInMdViewerCmd,
        openExtensionSettingsCmd
    );
}

// ============================================================================
// Local LLM Context Menu Registration
// ============================================================================

/**
 * Dynamically register context menu commands for each profile defined in
 * the Prompt Expander config. Also registers the three base commands:
 *  - dartscript.sendToLocalLlm          (shows profile picker)
 *  - dartscript.sendToLocalLlmStandard  (uses default profile)
 *  - dartscript.sendToLocalLlmAdvanced  (shows profile picker — alias)
 */
function registerLocalLlmContextMenuCommands(context: vscode.ExtensionContext): void {
    if (!promptExpanderManager) { return; }

    // Base command — uses default profile (direct send, no picker)
    const sendToLocalLlm = vscode.commands.registerCommand(
        'dartscript.sendToLocalLlm',
        async () => {
            bridgeLog('sendToLocalLlm command invoked');
            try {
                if (!promptExpanderManager) { return; }
                const config = promptExpanderManager.loadConfig();
                const defaultKey = Object.entries(config.profiles)
                    .find(([_, p]) => p.isDefault)?.[0]
                    ?? Object.keys(config.profiles)[0]
                    ?? undefined;
                await promptExpanderManager.expandPromptCommand(defaultKey);
            } catch (error) {
                bridgeLog(`sendToLocalLlm FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM failed: ${error}`);
            }
        }
    );

    // Standard — same as base (uses default profile without asking)
    const sendToLocalLlmStandard = vscode.commands.registerCommand(
        'dartscript.sendToLocalLlmStandard',
        async () => {
            bridgeLog('sendToLocalLlmStandard command invoked');
            try {
                if (!promptExpanderManager) { return; }
                const config = promptExpanderManager.loadConfig();
                const defaultKey = Object.entries(config.profiles)
                    .find(([_, p]) => p.isDefault)?.[0]
                    ?? Object.keys(config.profiles)[0]
                    ?? undefined;
                await promptExpanderManager.expandPromptCommand(defaultKey);
            } catch (error) {
                bridgeLog(`sendToLocalLlmStandard FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM (Standard) failed: ${error}`);
            }
        }
    );

    // Advanced — shows profile picker (for expand/rewrite/detailed etc.)
    const sendToLocalLlmAdvanced = vscode.commands.registerCommand(
        'dartscript.sendToLocalLlmAdvanced',
        async () => {
            bridgeLog('sendToLocalLlmAdvanced command invoked');
            try {
                await promptExpanderManager?.expandPromptCommand();
            } catch (error) {
                bridgeLog(`sendToLocalLlmAdvanced FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM (Advanced) failed: ${error}`);
            }
        }
    );

    context.subscriptions.push(sendToLocalLlm, sendToLocalLlmStandard, sendToLocalLlmAdvanced);

    // Dynamic per-profile commands (dartscript.sendToLocalLlm.<profileKey>)
    try {
        const config = promptExpanderManager.loadConfig();
        for (const profileKey of Object.keys(config.profiles)) {
            const cmd = vscode.commands.registerCommand(
                `dartscript.sendToLocalLlm.${profileKey}`,
                createProfileHandler(profileKey)
            );
            context.subscriptions.push(cmd);
            promptExpanderManager['registeredCommands'].push(cmd);
        }
    } catch (e) {
        bridgeLog(`Failed to register local LLM profile commands: ${e}`, 'ERROR');
    }
}

// ============================================================================
// Activation Helpers
// ============================================================================

/**
 * Check for test reinstall marker and show reminder notification
 */
function checkTestReinstallMarker(): void {
    try {
        const markerPath = path.join(os.homedir(), '.vscode-tom-test-reinstall');

        if (fs.existsSync(markerPath)) {
            // Read timestamp from marker
            const timestamp = fs.readFileSync(markerPath, 'utf8').trim();
            const markerDate = new Date(parseInt(timestamp) * 1000);
            const now = new Date();
            const ageMinutes = Math.floor((now.getTime() - markerDate.getTime()) / 60000);

            // Only show if marker is recent (within 5 minutes)
            if (ageMinutes < 5) {
                // Show reminder after a brief delay to let extension fully activate
                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.chat.open', { query: '!!!Reload finished' });
                    try {
                        fs.unlinkSync(markerPath);
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                }, 5000);
            } else {
                // Marker is old, just delete it
                fs.unlinkSync(markerPath);
            }
        }
    } catch (error) {
        // Silently ignore errors checking for marker
        console.error('Error checking test reinstall marker:', error);
    }
}
