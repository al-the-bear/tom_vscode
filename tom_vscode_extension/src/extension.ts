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
    showAiConversationStatusHandler,
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
import {
    McpServerController,
    defaultMcpServerStarter,
    setActiveMcpServerController,
    createTrailServiceMcpSink,
    reconcileMcpServerConfig,
} from './handlers/mcpServer-handler';
import { mcpLog, disposeMcpLogChannel } from './utils/mcpServerLog';
import { refreshStatusPage } from './handlers/statusPage-handler';
import { getMcpServerSettings, loadSendToChatConfig } from './utils/sendToChatConfig';
import { debounce } from './utils/debounce';
import { initializeDebugLogger, installConsoleDebugRouting, debugLog } from './utils/debugLogger';
import { TomAiConfiguration } from './utils/tomAiConfiguration';
import { WsPaths } from './utils/workspacePaths';
import { TrailService } from './services/trailService';
import { readQueueSettings, getQueueReloadAfterReloadSetting } from './storage/queueFileStorage';

// Tom AI Chat tools
import { registerTomAiChatTools } from './tools/tomAiChat-tools';
import { initializeToolDescriptions } from './tools/guideline-tools';

// Chat Enhancement stores & managers
import { ChatVariablesStore } from './managers/chatVariablesStore';
import { AnthropicHandler } from './handlers/anthropic-handler';
import { TwoTierMemoryService } from './services/memory-service';
import { registerMemoryPanelCommand } from './handlers/memoryPanel-handler';
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

// Lifecycle controller for the standalone MCP server (plan §7.5, todo #19).
// Owns the single running server; pushes the live bound port to the Status Page
// on every start/stop and is disposed on deactivate.
let mcpServerController: McpServerController | undefined;

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
                                        // Skip logging for high-frequency polling messages
                                        const msgType = typeof message === 'object' && message !== null && 'type' in (message as Record<string, unknown>)
                                            ? (message as Record<string, unknown>).type
                                            : undefined;
                                        const isPolling = msgType === 'loadWindowStates' || msgType === 'poll' || msgType === 'ping';
                                        if (!isPolling) {
                                            debugLog(`webview message: ${viewId} payload=${JSON.stringify(message, (_k, v) => typeof v === 'function' ? '[Function]' : v)}`, 'INFO', 'webview.message');
                                        }
                                        try {
                                            return await Promise.resolve(listener.call(thisArgs, message));
                                        } catch (error) {
                                            reportException(`webview:${viewId}.onDidReceiveMessage`, error, { messageType: msgType });
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
 * Expand the placeholders the extension supports in a `tomAi.configPath`
 * value: a leading `~`, `${home}`, and `${workspaceFolder}`. Kept local to
 * activation because it runs *before* `TomAiConfiguration.init()` — we cannot
 * route through the configuration singleton yet.
 */
function expandConfiguredConfigPath(raw: string, wsRoot: string): string {
    let result = raw;
    if (result.startsWith('~/') || result.startsWith('~\\') || result === '~') {
        result = path.join(os.homedir(), result.slice(1));
    }
    result = result.replace(/\$\{home\}/g, os.homedir());
    result = result.replace(/\$\{workspaceFolder\}/g, wsRoot);
    return result;
}

/**
 * Decide whether the open workspace is a Tom AI workspace.
 *
 * Historically this checked only for a `.tom/` folder directly under the
 * workspace root. That breaks nested layouts where the workspace root is a
 * *parent* of the actual Tom project (e.g. opening an umbrella
 * `al_the_bear.code-workspace` whose folder is the repo root while the Tom
 * project — and its `.tom/` — lives several directories deeper). In that
 * case the user points `tomAi.configPath` at the real config file, but the
 * root has no `.tom/`, so the extension wrongly dropped to minimal mode.
 *
 * We now treat the workspace as a Tom workspace when **either** the root has
 * a `.tom/` folder **or** the configured `tomAi.configPath` resolves to an
 * existing file (or an existing parent directory, so a not-yet-created config
 * at a valid location still activates fully).
 */
function hasTomWorkspaceConfig(wsRoot: string): boolean {
    if (fs.existsSync(path.join(wsRoot, '.tom'))) {
        return true;
    }

    const configured = vscode.workspace
        .getConfiguration('tomAi')
        .get<string>('configPath');
    if (configured && configured.trim()) {
        const resolved = expandConfiguredConfigPath(configured.trim(), wsRoot);
        if (fs.existsSync(resolved) || fs.existsSync(path.dirname(resolved))) {
            return true;
        }
    }

    return false;
}

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
    const hasTomConfig = wsRoot ? hasTomWorkspaceConfig(wsRoot) : false;
    if (!hasTomConfig) {
        const totalMs = Math.round((performance.now() - activateStart) * 100) / 100;
        const msg = 'TOM AI: no TOM AI config found (.tom/ folder missing and tomAi.configPath unset/invalid). Extension running in minimal mode.';
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
        const {
            loadSendToChatConfig,
            saveSendToChatConfig,
            ensureDefaultTransportRetryTemplate,
        } = await import('./utils/sendToChatConfig.js');
        const stcConfig = loadSendToChatConfig();
        // One-shot seed: migrate the in-code transport-retry default into an
        // on-disk "Default Retry" template (marked isDefault) so "use default"
        // resolves to an editable, pickable entry. No-op once it exists.
        if (stcConfig) {
            try {
                if (ensureDefaultTransportRetryTemplate(stcConfig)) {
                    saveSendToChatConfig(stcConfig);
                    bridgeLog('Seeded "Default Retry" transport-retry template', 'INFO');
                }
            } catch (e: any) {
                bridgeLog(`Default Retry template seed failed: ${e?.message ?? e}`, 'ERROR');
            }
        }
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

        // MCP server controller (#19): construct once, register it as the active
        // controller so the Status-Page snapshot reads its live status, and push
        // card refreshes on every start/stop. Disposed on deactivate + on config
        // change (see registerCommands).
        mcpServerController = new McpServerController({
            start: defaultMcpServerStarter(
                createTrailServiceMcpSink(wsWindowId, WsPaths.getWorkspaceQuestId()),
                mcpLog,
            ),
            onChange: () => { void refreshStatusPage(); },
            log: mcpLog,
        });
        setActiveMcpServerController(mcpServerController);
        context.subscriptions.push({ dispose: () => { void mcpServerController?.dispose(); } });
        context.subscriptions.push({ dispose: disposeMcpLogChannel });

        if (stcConfig?.mcpServer?.enabled && stcConfig?.mcpServer?.autoStart) {
            const settings = getMcpServerSettings(stcConfig);
            setTimeout(async () => {
                try {
                    const running = await mcpServerController?.start(settings);
                    if (running) {
                        vscode.window.showInformationMessage(`MCP Server started on ${running.url}`);
                        bridgeLog(`MCP server auto-started on ${running.url}`, 'INFO');
                    }
                } catch (e: any) {
                    bridgeLog(`MCP server autostart failed: ${e?.message ?? e}`, 'ERROR');
                }
            }, 2500);
        }

        // Reconcile the running server on external config edits (#7). The
        // file-based config has no `onDidChangeConfiguration`, so watch the
        // workspace config file directly: an edit by hand or from another
        // window reconciles the server (disabled ⇒ stop; running ⇒ restart
        // onto new host/port/tools), not just on card save. The bursty
        // write events for a single save collapse via the debounce.
        const mcpWsRoot = WsPaths.wsRoot;
        if (mcpWsRoot) {
            const mcpConfigWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(
                    mcpWsRoot,
                    `${WsPaths.wsConfigFolder}/${WsPaths.configFileName}`,
                ),
            );
            const reconcileFromConfig = debounce(() => {
                const cfg = loadSendToChatConfig();
                if (!cfg) {
                    return;
                }
                void reconcileMcpServerConfig(getMcpServerSettings(cfg)).catch((e: any) => {
                    bridgeLog(`MCP config reconcile failed: ${e?.message ?? e}`, 'ERROR');
                });
            }, 300);
            mcpConfigWatcher.onDidChange(() => reconcileFromConfig());
            mcpConfigWatcher.onDidCreate(() => reconcileFromConfig());
            context.subscriptions.push(mcpConfigWatcher);
            context.subscriptions.push({ dispose: () => reconcileFromConfig.cancel() });
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

    // Initialize Anthropic handler (Phase 1 of anthropic_sdk_integration)
    stepStart = performance.now();
    AnthropicHandler.init(context);
    timeStep('anthropicHandler', stepStart);

    // Memory service + panel (Phase 3 of anthropic_sdk_integration)
    stepStart = performance.now();
    TwoTierMemoryService.init(context);
    registerMemoryPanelCommand(context);
    timeStep('memoryServiceAndPanel', stepStart);

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

    // Register the Anthropic sub-agent spawner so tomAi_spawnSubagent works
    // on the direct transport. (The Agent SDK transport uses its own `Task`
    // tool and does not go through this path.)
    stepStart = performance.now();
    try {
        const { spawnAnthropicSubagent } = await import('./handlers/anthropic-handler.js');
        const { registerSubagentSpawner } = await import('./tools/planning-tools.js');
        registerSubagentSpawner(spawnAnthropicSubagent);
        timeStep('spawnSubagent.register', stepStart);
    } catch (err: any) {
        debugLog(`spawnSubagent registration failed: ${err?.message ?? err}`, 'WARN', 'extension.activate');
    }

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

    // Stop the MCP server so it never leaks its listener across reloads (#19).
    // dispose() is idempotent and a no-op when the server was never started.
    if (mcpServerController) {
        void mcpServerController.dispose();
        setActiveMcpServerController(undefined);
    }
    disposeMcpLogChannel();

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
            await sendToChatHandler(context);
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

    // Re-read the extension's on-disk configuration. The main
    // TomAiConfiguration singleton only resolves `tomAi.configPath` and loads
    // the file once, in its constructor at activation — so without an explicit
    // refresh, a changed path is not picked up until a full window reload.
    const reloadAllConfig = async (notify: boolean): Promise<void> => {
        try {
            TomAiConfiguration.instance.reload();
        } catch {
            // Singleton not initialized yet — nothing to reload.
        }
        if (sendToChatAdvancedManager) {
            await sendToChatAdvancedManager.loadConfig();
        }
        if (notify) {
            vscode.window.showInformationMessage('Tom AI configuration reloaded');
        }
    };

    // Reload config command
    const reloadSendToChatConfigCmd = vscode.commands.registerCommand(
        'tomAi.reloadConfig',
        () => reloadAllConfig(true),
    );

    // Pick up a changed config-file location (or AI/queue folder) without a
    // full window reload. Without this, editing `tomAi.configPath` in
    // workspace/.code-workspace settings has no effect until VS Code restarts
    // the extension host.
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (
            e.affectsConfiguration('tomAi.configPath') ||
            e.affectsConfiguration('tomAi.aiFolder') ||
            e.affectsConfiguration('tomAi.queueFolder')
        ) {
            void reloadAllConfig(false);
        }
    });

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

    // MCP Server lifecycle commands (plan §7.5, todo #19). Routed to the
    // controller created at activation; settings are resolved fresh from config
    // on each invocation so a config edit takes effect on the next start.
    const startMcpServerCmd = vscode.commands.registerCommand(
        'tomAi.mcpServer.start',
        async () => {
            const { loadSendToChatConfig } = await import('./utils/sendToChatConfig.js');
            const settings = getMcpServerSettings(loadSendToChatConfig());
            try {
                const running = await mcpServerController?.start(settings);
                if (running) {
                    vscode.window.showInformationMessage(`MCP Server started on ${running.url}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`MCP Server failed to start: ${e?.message ?? e}`);
            }
        }
    );

    const stopMcpServerCmd = vscode.commands.registerCommand(
        'tomAi.mcpServer.stop',
        async () => {
            await mcpServerController?.stop();
            vscode.window.showInformationMessage('MCP Server stopped');
        }
    );

    const restartMcpServerCmd = vscode.commands.registerCommand(
        'tomAi.mcpServer.restart',
        async () => {
            const { loadSendToChatConfig } = await import('./utils/sendToChatConfig.js');
            const settings = getMcpServerSettings(loadSendToChatConfig());
            try {
                const running = await mcpServerController?.restart(settings);
                if (running) {
                    vscode.window.showInformationMessage(`MCP Server restarted on ${running.url}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`MCP Server failed to restart: ${e?.message ?? e}`);
            }
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

    // Show AI Conversation Status
    const showAiConversationStatusCmd = vscode.commands.registerCommand(
        'tomAi.aiConversation.status',
        async () => {
            await showAiConversationStatusHandler();
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

    // One-shot migration: legacy `history.json` + free-form memory
    // bullets → block-format `compacted_history.md` + single-line
    // memory entries. Idempotent — re-running after a partial pass is
    // safe.
    const migrateCompactionFormatCmd = vscode.commands.registerCommand(
        'tomAi.migrate.compactionFormat',
        async () => {
            const { migrateCompactionFormat } = await import('./services/compaction-migration.js');
            const out = vscode.window.createOutputChannel('Tom AI: Compaction Migration');
            out.show(true);
            out.appendLine('Tom AI: starting compaction-format migration…');
            const report = migrateCompactionFormat({
                onProgress: (msg: string) => out.appendLine(msg),
            });
            const summary =
                `Tom AI migration complete — ` +
                `${report.questsMigrated}/${report.questsScanned} quest(s) migrated, ` +
                `${report.memoryFilesMigrated}/${report.memoryFilesScanned} memory file(s) migrated.`;
            out.appendLine('---');
            out.appendLine(summary);
            if (report.questsFailed > 0 || report.memoryFilesFailed > 0) {
                vscode.window.showWarningMessage(
                    `${summary} ${report.questsFailed} quest + ${report.memoryFilesFailed} memory failure(s) — see "Tom AI: Compaction Migration" output channel.`,
                );
            } else {
                vscode.window.showInformationMessage(summary);
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
        configChangeListener,
        startCliServerCmd,
        startCliServerCustomPortCmd,
        stopCliServerCmd,
        startMcpServerCmd,
        stopMcpServerCmd,
        restartMcpServerCmd,
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
        showAiConversationStatusCmd,
        telegramTestCmd,
        telegramToggleCmd,
        telegramConfigureCmd,
        toggleTrailCmd,
        showStatusPageCmd,
        focusTomSidebarCmd,
        openInMdViewerCmd,
        openExtensionSettingsCmd,
        migrateCompactionFormatCmd
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
