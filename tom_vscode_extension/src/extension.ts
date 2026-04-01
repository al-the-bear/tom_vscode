/**
 * Tom AI VS Code Extension
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
    LocalLlmManager,
    setLocalLlmManager,
    getLocalLlmManager,
    createProfileHandler,
    switchModelHandler,
    startAiConversationHandler,
    stopAiConversationHandler,
    haltAiConversationHandler,
    continueAiConversationHandler,
    addToAiConversationHandler,
    AiConversationManager,
    setAiConversationManager,
    registerChordMenuCommands,
    registerCommandlineCommands,
    registerCombinedCommands,
    registerStateMachineCommands,
    registerDsNotesViews,
    registerChatPanel,
    registerWsPanel,
    registerChatVariablesEditorCommand,
    registerContextSettingsEditorCommand,
    registerQueueEditorCommand,
    registerTimedRequestsEditorCommand,
    registerGlobalTemplateEditorCommand,
    registerReusablePromptEditorCommand,
    registerQueueTemplateEditorCommand,
    telegramTestHandler,
    telegramToggleHandler,
    telegramConfigureHandler,
    disposeTelegramStandalone,
    showStatusPageHandler,
    toggleTrailHandler,
    getConfigPath,
    registerYamlGraphEditor,
    registerTrailViewerCommands,
    setExtensionPath,
} from './handlers';

import { registerQuestTodoCustomEditor } from './handlers/questTodoEditor-handler';
import { registerMarkdownBrowser } from './handlers/markdownBrowser-handler';
import { registerTrailCustomEditor } from './handlers/trailEditor-handler';
import { registerTodoLogView } from './handlers/todoLogPanel-handler';
import { registerWindowStatusView, deleteCurrentWindowState, cleanupStaleWindowStates } from './handlers/windowStatusPanel-handler';
import { registerMinimalModePanels } from './handlers/minimalMode-handler';
import { initTomScriptingBridgeHandler } from './handlers/tomScriptingBridge-handler';
import { initializeDebugLogger, installConsoleDebugRouting, debugLog } from './utils/debugLogger';
import { TomAiConfiguration } from './utils/tomAiConfiguration';
import { WsPaths } from './utils/workspacePaths';
import { TrailService } from './services/trailService';
import { readQueueSettings, getQueueReloadAfterReloadSetting } from './storage/queueFileStorage';

// Tom AI Chat tools
import { registerTomAiChatTools } from './tools/tomAiChat-tools';
import { initializeToolDescriptions } from './tools/tool-executors';

// Chat Enhancement stores & managers
import { ChatVariablesStore } from './managers/chatVariablesStore';
import { SessionTodoStore } from './managers/sessionTodoStore';
import { PromptQueueManager } from './managers/promptQueueManager';
import { TimerEngine } from './managers/timerEngine';
import { ReminderSystem } from './managers/reminderSystem';
import { registerChatVariableResolvers } from './tools/chatVariableResolvers';

// Global manager instance for SendToChatAdvanced
let sendToChatAdvancedManager: SendToChatAdvancedManager | undefined;

// Global manager instance for Prompt Expander
let localLlmManager: LocalLlmManager | undefined;

// Global manager instance for AI Conversation
let aiConversationManager: AiConversationManager | undefined;

let instrumentationInstalled = false;

function installGlobalInstrumentation(): void {
    if (instrumentationInstalled) {
        return;
    }
    instrumentationInstalled = true;

    try {
        const commandsAny = vscode.commands as unknown as {
            registerCommand: typeof vscode.commands.registerCommand;
            __tomAiInstrumented?: boolean;
        };
        if (!commandsAny.__tomAiInstrumented) {
            const originalRegisterCommand = vscode.commands.registerCommand.bind(vscode.commands);
            commandsAny.registerCommand = ((command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => {
                const wrappedCallback = async (...args: unknown[]) => {
                    debugLog(`command triggered: ${command} args=${JSON.stringify(args, (_k, v) => typeof v === 'function' ? '[Function]' : v)}`, 'INFO', 'command.trigger');
                    try {
                        return await Promise.resolve(callback.apply(thisArg, args));
                    } catch (error) {
                        reportException(`command:${command}`, error, { argsCount: args.length });
                        throw error;
                    }
                };
                return originalRegisterCommand(command, wrappedCallback, thisArg);
            }) as typeof vscode.commands.registerCommand;
            commandsAny.__tomAiInstrumented = true;
        }

        const windowAny = vscode.window as unknown as {
            registerWebviewViewProvider: typeof vscode.window.registerWebviewViewProvider;
            __tomAiWebviewInstrumented?: boolean;
        };
        if (!windowAny.__tomAiWebviewInstrumented) {
            const originalRegisterWebviewProvider = vscode.window.registerWebviewViewProvider.bind(vscode.window);
            windowAny.registerWebviewViewProvider = ((viewId, provider, options) => {
                const wrappedProvider: vscode.WebviewViewProvider = {
                    ...provider,
                    resolveWebviewView(webviewView, webviewViewResolveContext, token) {
                        const resolveStart = performance.now();
                        debugLog(`webview resolve triggered: ${viewId}`, 'INFO', 'webview.resolve');
                        try {
                            const webviewAny = webviewView.webview as unknown as {
                                onDidReceiveMessage: typeof webviewView.webview.onDidReceiveMessage;
                                __tomAiMessageInstrumented?: boolean;
                            };

                            if (!webviewAny.__tomAiMessageInstrumented) {
                                const originalOnDidReceiveMessage = webviewView.webview.onDidReceiveMessage.bind(webviewView.webview);
                                webviewAny.onDidReceiveMessage = ((listener, thisArgs, disposables) => {
                                    const wrappedListener = async (message: unknown) => {
                                        debugLog(`webview message: ${viewId} payload=${JSON.stringify(message, (_k, v) => typeof v === 'function' ? '[Function]' : v)}`, 'INFO', 'webview.message');
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
                                webviewAny.__tomAiMessageInstrumented = true;
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
            windowAny.__tomAiWebviewInstrumented = true;
        }

        const customEditorAny = vscode.window as unknown as {
            registerCustomEditorProvider: typeof vscode.window.registerCustomEditorProvider;
            __tomAiCustomEditorInstrumented?: boolean;
        };
        if (!customEditorAny.__tomAiCustomEditorInstrumented) {
            const originalRegisterCustomEditor = vscode.window.registerCustomEditorProvider.bind(vscode.window);
            customEditorAny.registerCustomEditorProvider = ((viewType, provider, options) => {
                const wrappedProvider: vscode.CustomTextEditorProvider = {
                    ...provider,
                    async resolveCustomTextEditor(document, webviewPanel, token) {
                        debugLog(`custom editor resolve triggered: ${viewType} file=${document.uri.fsPath}`, 'INFO', 'customEditor.resolve');
                        try {
                            const webviewAny = webviewPanel.webview as unknown as {
                                onDidReceiveMessage: typeof webviewPanel.webview.onDidReceiveMessage;
                                __tomAiCustomMessageInstrumented?: boolean;
                            };

                            if (viewType !== 'tomAi.trailViewer' && !webviewAny.__tomAiCustomMessageInstrumented) {
                                const originalOnDidReceiveMessage = webviewPanel.webview.onDidReceiveMessage.bind(webviewPanel.webview);
                                webviewAny.onDidReceiveMessage = ((listener, thisArgs, disposables) => {
                                    const wrappedListener = async (message: unknown) => {
                                        debugLog(`custom editor message: ${viewType} payload=${JSON.stringify(message, (_k, v) => typeof v === 'function' ? '[Function]' : v)}`, 'INFO', 'customEditor.message');
                                        try {
                                            return await Promise.resolve(listener.call(thisArgs, message));
                                        } catch (error) {
                                            reportException(`customEditor:${viewType}.onDidReceiveMessage`, error, {
                                                messageType: typeof message === 'object' && message && 'type' in (message as Record<string, unknown>)
                                                    ? (message as Record<string, unknown>).type
                                                    : undefined,
                                            });
                                            throw error;
                                        }
                                    };
                                    return originalOnDidReceiveMessage(wrappedListener, thisArgs, disposables);
                                }) as typeof webviewPanel.webview.onDidReceiveMessage;
                                webviewAny.__tomAiCustomMessageInstrumented = true;
                            }

                            const resolver = (provider as { resolveCustomTextEditor?: (document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken) => unknown }).resolveCustomTextEditor;
                            if (typeof resolver !== 'function') {
                                throw new Error(`Custom editor provider for ${viewType} has no resolveCustomTextEditor`);
                            }
                            await Promise.resolve(resolver.call(provider, document, webviewPanel, token));
                            debugLog(`custom editor resolve completed: ${viewType} file=${document.uri.fsPath}`, 'INFO', 'customEditor.resolve');
                        } catch (error) {
                            reportException(`customEditor:${viewType}.resolveCustomTextEditor`, error, {
                                filePath: document.uri.fsPath,
                            });
                            throw error;
                        }
                    },
                };
                return originalRegisterCustomEditor(viewType, wrappedProvider, options);
            }) as typeof vscode.window.registerCustomEditorProvider;
            customEditorAny.__tomAiCustomEditorInstrumented = true;
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

    // Store extension path for bundled binary resolution
    setExtensionPath(context.extensionPath);

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

        bridgeLog(`Tom AI minimal activation in ${totalMs}ms`);
        return;
    }

    bridgeLog('Tom AI extension is now active!');

    stepStart = performance.now();
    TomAiConfiguration.init(context);
    TrailService.init(context);
    timeStep('tomAiConfiguration + trailService', stepStart);

    // Initialize bridge client and immediately start the bridge process.
    // This must happen early so bridge output is visible even if later
    // registrations throw and abort activate().
    stepStart = performance.now();
    const bridgeClient = initializeBridgeClient(context);
    timeStep('bridgeClient', stepStart);

    stepStart = performance.now();
    await restartBridgeHandler(context, false);
    timeStep('restartBridgeHandler', stepStart);

    try {
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
    registerChatPanel(context);
    timeStep('chatPanel', stepStart);

    // Register WS panel (includes Issues, Tests, and Quest TODO tabs)
    stepStart = performance.now();
    registerWsPanel(context);
    timeStep('wsPanel', stepStart);

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

    // Register Queue Template Editor command
    stepStart = performance.now();
    registerQueueTemplateEditorCommand(context);
    timeStep('queueTemplateEditor', stepStart);

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

    // Register Markdown Browser
    stepStart = performance.now();
    registerMarkdownBrowser(context);
    timeStep('markdownBrowser', stepStart);

    // Register TODO Log explorer sidebar panel
    stepStart = performance.now();
    context.subscriptions.push(registerTodoLogView(context));
    timeStep('todoLogView', stepStart);

    // Register Window Status explorer sidebar panel
    stepStart = performance.now();
    context.subscriptions.push(registerWindowStatusView(context));
    // Compute the trail-compatible window ID (matches chatPanel-handler getWindowId())
    const wsWindowId = `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`;
    cleanupStaleWindowStates(wsWindowId);
    // Cleanup own window state file on deactivation
    context.subscriptions.push({ dispose: () => deleteCurrentWindowState(wsWindowId) });
    timeStep('windowStatusView', stepStart);

    // Check for test reinstall marker and schedule optional reload prompt send
    stepStart = performance.now();
    checkTestReinstallMarker();
    scheduleConfiguredReloadPromptSend();
    timeStep('checkReinstallMarker + scheduleReloadPrompt', stepStart);

    // Bridge already started above (right after initializeBridgeClient)

    // CLI Server autostart: if enabled in config, start after bridge is ready
    {
        const { loadSendToChatConfig } = await import('./utils/sendToChatConfig.js');
        const stcConfig = loadSendToChatConfig();
        if (stcConfig?.bridge?.cliServerAutostart) {
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
        if (stcConfig?.aiConversation?.telegram?.autostart) {
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

    // Initialize Local LLM manager
    // NOTE: Even if this fails, ensureLocalLlmManager() in the handlers
    // will lazily create it on first use.
    stepStart = performance.now();
    localLlmManager = new LocalLlmManager(context);
    setLocalLlmManager(localLlmManager);
    registerLocalLlmContextMenuCommands(context);
    context.subscriptions.push({ dispose: () => localLlmManager?.dispose() });
    timeStep('localLlmManager', stepStart);

    // Initialize AI Conversation manager
    stepStart = performance.now();
    aiConversationManager = new AiConversationManager(context);
    setAiConversationManager(aiConversationManager);
    context.subscriptions.push({ dispose: () => aiConversationManager?.dispose() });
    timeStep('aiConversationManager', stepStart);

    // Initialize Tom Scripting Bridge handler
    stepStart = performance.now();
    initTomScriptingBridgeHandler(context);
    timeStep('tomScriptingBridgeHandler', stepStart);

    // Dispose standalone Telegram on deactivation
    context.subscriptions.push({ dispose: () => disposeTelegramStandalone() });

    // Initialize Chat Enhancement stores (§1.1–§1.4)
    stepStart = performance.now();
    ChatVariablesStore.init(context);
    const windowId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    SessionTodoStore.init(context, windowId);
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
    // Local-LLM bridge tools (Ask Big Brother, Ask Copilot) are lazy-initialized
    // on first use — selectChatModels() takes 20–30s during activation rush
    // but <1s when the event loop is idle.
    stepStart = performance.now();
    registerTomAiChatTools(context);
    timeStep('tomAiChatTools.registerTools', stepStart);

    // Register chat variable resolvers (#quest, #role, etc.)
    stepStart = performance.now();
    registerChatVariableResolvers(context);
    timeStep('chatVariableResolvers', stepStart);

    } catch (err: any) {
        const msg = err?.stack ?? err?.message ?? String(err);
        debugLog(`activate() registration error: ${msg}`, 'ERROR', 'extension.activate');
        bridgeLog(`activate() registration error: ${msg}`, 'ERROR');
    }

    // --- Activation timing summary ---
    const totalMs = Math.round((performance.now() - activateStart) * 100) / 100;
    const sortedTimings = [...timings].sort((a, b) => b.ms - a.ms);
    const timingLines = sortedTimings.map(t => `  ${t.step}: ${t.ms}ms`);
    const timingSummary = `Tom AI activate(): ${totalMs}ms total\n${timingLines.join('\n')}`;
    debugLog(timingSummary, 'INFO', 'extension.activate');

    // Show activation message with timing
    vscode.window.showInformationMessage(`Tom AI activated in ${totalMs}ms`);

    bridgeLog('Tom AI extension is now active!');
}

/**
 * Extension deactivation function
 * Note: This is called synchronously when VS Code is about to reload/close
 */
export function deactivate() {
    bridgeLog('Tom AI extension deactivating - stopping bridge...');
    
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
    
    bridgeLog('Tom AI extension deactivated');
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
        'tomAi.sendToCopilot',
        async () => {
            await sendToChatHandler();
        }
    );

    // Execute Dart file in D4rt (executeFile)
    const executeInTomAiBuildCmd = vscode.commands.registerCommand(
        'tomAi.executeFile',
        async (uri?: vscode.Uri) => {
            await executeInTomAiBuildHandler(uri, context);
        }
    );

    // Execute Dart file as script in D4rt (executeScript)
    const executeAsScriptInTomAiBuildCmd = vscode.commands.registerCommand(
        'tomAi.executeScript',
        async (uri?: vscode.Uri) => {
            await executeAsScriptHandler(uri, context);
        }
    );

    // Restart/Start Dart Bridge command
    const restartBridgeCmd = vscode.commands.registerCommand(
        'tomAi.bridge.restart',
        async () => {
            await restartBridgeHandler(context, true);
        }
    );

    // Switch Bridge Profile command
    const switchBridgeProfileCmd = vscode.commands.registerCommand(
        'tomAi.bridge.switchProfile',
        async () => {
            await switchBridgeProfileHandler(context);
        }
    );

    // Run Tests command - executes all tests from tom_vscode_bridge/test/
    const runTestsCmd = vscode.commands.registerCommand(
        'tomAi.runTests',
        async () => {
            return await runTestsHandler(context);
        }
    );

    // Reload window with bridge notification command
    const reloadWithBridgeNotificationCmd = vscode.commands.registerCommand(
        'tomAi.reloadWindow',
        async () => {
            await reloadWindowHandler();
        }
    );

    // Reload Send to Chat config command
    const reloadSendToChatConfigCmd = vscode.commands.registerCommand(
        'tomAi.reloadConfig',
        async () => {
            if (sendToChatAdvancedManager) {
                await sendToChatAdvancedManager.loadConfig();
                vscode.window.showInformationMessage('Send to Chat configuration reloaded');
            }
        }
    );

    // CLI Integration Server commands
    const startCliServerCmd = vscode.commands.registerCommand(
        'tomAi.cliServer.start',
        async () => {
            await startCliServerHandler();
        }
    );

    const startCliServerCustomPortCmd = vscode.commands.registerCommand(
        'tomAi.cliServer.startCustomPort',
        async () => {
            await startCliServerCustomPortHandler();
        }
    );

    const stopCliServerCmd = vscode.commands.registerCommand(
        'tomAi.cliServer.stop',
        async () => {
            await stopCliServerHandler();
        }
    );

    // Process Monitor command
    const startProcessMonitorCmd = vscode.commands.registerCommand(
        'tomAi.startProcessMonitor',
        async () => {
            await startProcessMonitorHandler();
        }
    );

    // Debug Logging toggle command
    const toggleDebugLoggingCmd = vscode.commands.registerCommand(
        'tomAi.bridge.toggleDebug',
        async () => {
            await toggleBridgeDebugLoggingHandler();
        }
    );

    // Print Configuration command
    const printConfigurationCmd = vscode.commands.registerCommand(
        'tomAi.printConfiguration',
        async () => {
            await printConfigurationHandler();
        }
    );

    // Show Help command
    const showHelpCmd = vscode.commands.registerCommand(
        'tomAi.showHelp',
        async () => {
            await showHelpHandler();
        }
    );

    // Show API Info command
    const showApiInfoCmd = vscode.commands.registerCommand(
        'tomAi.showApiInfo',
        async () => {
            await showApiInfoHandler();
        }
    );

    // Tom AI Chat commands
    const startTomAiChatCmd = vscode.commands.registerCommand(
        'tomAi.tomAiChat.start',
        async () => {
            await startTomAiChatHandler();
        }
    );

    const sendToTomAiChatCmd = vscode.commands.registerCommand(
        'tomAi.tomAiChat.send',
        async () => {
            await sendToTomAiChatHandler();
        }
    );

    const interruptTomAiChatCmd = vscode.commands.registerCommand(
        'tomAi.tomAiChat.interrupt',
        () => {
            interruptTomAiChatHandler();
        }
    );

    // Expand Prompt with local Ollama model
    const expandPromptCmd = vscode.commands.registerCommand(
        'tomAi.sendToLocalLlm',
        async () => {
            await expandPromptHandler();
        }
    );

    // Switch local Ollama model
    const switchLocalModelCmd = vscode.commands.registerCommand(
        'tomAi.localLlm.switchModel',
        async () => {
            await switchModelHandler();
        }
    );

    // Start AI Conversation
    const startAiConversationCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.start',
        async () => {
            await startAiConversationHandler();
        }
    );

    // Stop AI Conversation
    const stopAiConversationCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.stop',
        async () => {
            await stopAiConversationHandler();
        }
    );

    // Halt AI Conversation
    const haltAiConversationCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.halt',
        async () => {
            await haltAiConversationHandler();
        }
    );

    // Continue AI Conversation
    const continueAiConversationCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.continue',
        async () => {
            await continueAiConversationHandler();
        }
    );

    // Add to AI Conversation
    const addToAiConversationCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.add',
        async () => {
            await addToAiConversationHandler();
        }
    );

    // Telegram Test Connection
    const telegramTestCmd = vscode.commands.registerCommand(
        'tomAi.telegram.testConnection',
        async () => {
            await telegramTestHandler();
        }
    );

    // Telegram Toggle Polling
    const telegramToggleCmd = vscode.commands.registerCommand(
        'tomAi.telegram.toggle',
        async () => {
            await telegramToggleHandler();
        }
    );

    // Telegram Configure
    const telegramConfigureCmd = vscode.commands.registerCommand(
        'tomAi.telegram.configure',
        async () => {
            await telegramConfigureHandler();
        }
    );

    // Toggle AI Trail logging
    const toggleTrailCmd = vscode.commands.registerCommand(
        'tomAi.trail.toggle',
        async () => {
            await toggleTrailHandler();
        }
    );

    // Show Status Page
    const showStatusPageCmd = vscode.commands.registerCommand(
        'tomAi.statusPage',
        async () => {
            await showStatusPageHandler();
        }
    );

    // Focus @TOM activity-bar sidebar container
    const focusTomSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-sidebar');
        }
    );

    // Open in MD Viewer - dedicated command for markdown files
    const openInMdViewerCmd = vscode.commands.registerCommand(
        'tomAi.openInMdViewer',
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
        'tomAi.openSettings',
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
        startAiConversationCmd,
        stopAiConversationCmd,
        haltAiConversationCmd,
        continueAiConversationCmd,
        addToAiConversationCmd,
        telegramTestCmd,
        telegramToggleCmd,
        telegramConfigureCmd,
        toggleTrailCmd,
        showStatusPageCmd,
        focusTomSidebarCmd,
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
 *  - tomAi.sendToLocalLlm.default   (uses default profile, no picker)
 *  - tomAi.sendToLocalLlm.standard  (uses default profile)
 *  - tomAi.sendToLocalLlm.template  (shows profile picker)
 */
function registerLocalLlmContextMenuCommands(context: vscode.ExtensionContext): void {
    if (!localLlmManager) { return; }

    // Base command — uses default profile (direct send, no picker)
    const sendToLocalLlm = vscode.commands.registerCommand(
        'tomAi.sendToLocalLlm.default',
        async () => {
            bridgeLog('sendToLocalLlm command invoked');
            try {
                if (!localLlmManager) { return; }
                const config = localLlmManager.loadConfig();
                const defaultKey = Object.entries(config.profiles)
                    .find(([_, p]) => p.isDefault)?.[0]
                    ?? Object.keys(config.profiles)[0]
                    ?? undefined;
                await localLlmManager.expandPromptCommand(defaultKey);
            } catch (error) {
                bridgeLog(`sendToLocalLlm FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM failed: ${error}`);
            }
        }
    );

    // Standard — same as base (uses default profile without asking)
    const sendToLocalLlmStandard = vscode.commands.registerCommand(
        'tomAi.sendToLocalLlm.standard',
        async () => {
            bridgeLog('sendToLocalLlmStandard command invoked');
            try {
                if (!localLlmManager) { return; }
                const config = localLlmManager.loadConfig();
                const defaultKey = Object.entries(config.profiles)
                    .find(([_, p]) => p.isDefault)?.[0]
                    ?? Object.keys(config.profiles)[0]
                    ?? undefined;
                await localLlmManager.expandPromptCommand(defaultKey);
            } catch (error) {
                bridgeLog(`sendToLocalLlmStandard FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM (Standard) failed: ${error}`);
            }
        }
    );

    // Advanced — shows profile picker (for expand/rewrite/detailed etc.)
    const sendToLocalLlmAdvanced = vscode.commands.registerCommand(
        'tomAi.sendToLocalLlm.template',
        async () => {
            bridgeLog('sendToLocalLlmAdvanced command invoked');
            try {
                await localLlmManager?.expandPromptCommand();
            } catch (error) {
                bridgeLog(`sendToLocalLlmAdvanced FAILED: ${error}`, 'ERROR');
                vscode.window.showErrorMessage(`Send to Local LLM (Advanced) failed: ${error}`);
            }
        }
    );

    context.subscriptions.push(sendToLocalLlm, sendToLocalLlmStandard, sendToLocalLlmAdvanced);

    // Dynamic per-profile commands (tomAi.sendToLocalLlm.<profileKey>)
    try {
        const config = localLlmManager.loadConfig();
        for (const profileKey of Object.keys(config.profiles)) {
            const cmd = vscode.commands.registerCommand(
                `tomAi.sendToLocalLlm.${profileKey}`,
                createProfileHandler(profileKey)
            );
            context.subscriptions.push(cmd);
            localLlmManager['registeredCommands'].push(cmd);
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

function scheduleConfiguredReloadPromptSend(): void {
    try {
        const questId = WsPaths.getWorkspaceQuestId();
        const settings = readQueueSettings();
        const reloadPrompt = getQueueReloadAfterReloadSetting(settings, questId);
        const prompt = (reloadPrompt.prompt || '').trim();

        if (!reloadPrompt.enabled || !prompt) {
            return;
        }

        setTimeout(() => {
            void vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        }, 15_000);

        bridgeLog(
            `Scheduled reload prompt send in 15s (${questId ? `quest=${questId}` : 'workspace scope'})`,
            'INFO',
        );
    } catch (error) {
        // Best-effort behavior only; activation should not fail.
        console.error('Error scheduling reload prompt send:', error);
    }
}
