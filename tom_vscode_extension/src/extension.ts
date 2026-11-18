/**
 * Tom AI VS Code Extension
 * 
 * Main extension entry point. This file handles activation, deactivation,
 * and command registration. All command implementations are in separate
 * handler files in the handlers/ directory.
 */

import { installTodoOnDone } from './services/todoOnDoneLive';
import { setTodoFiledByContextProvider } from './managers/questTodoManager';
import { currentInteractionRun, currentQueueItemId } from './services/userWaits';
import { configureNotificationLog } from './services/notificationLog';
import { getCurrentToolContext } from './services/tool-execution-context';
import { registerNotificationsView } from './handlers/notifications-handler';
import { callerSession } from './tools/session-param';
import { currentProcessRun } from './services/processRunContext';
import { registerQuestNotesPanel } from './handlers/questNotesPanel-handler';
import { registerSendToLlmCommands } from './handlers/sendToLlm-handler';
import { setToolCallLogSink } from './utils/toolCallLog';
import { getToolLogChannel } from './utils/toolLog';
import * as vscode from 'vscode';
import { setExtensionLogUri } from './utils/outputChannelLogs';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Bridge and test utilities
import { DartBridgeClient } from './vscode-bridge';

// Command handlers
import { bridgeLog, reportException, getBridgeClient, initializeBridgeClient, sendToChatHandler, SendToChatAdvancedManager, executeInTomAiBuildHandler, executeAsScriptHandler, restartBridgeHandler, switchBridgeProfileHandler, runTestsHandler, reloadWindowHandler, startCliServerHandler, startCliServerCustomPortHandler, stopCliServerHandler, startProcessMonitorHandler, toggleBridgeDebugLoggingHandler, printConfigurationHandler, showHelpHandler, showApiInfoHandler, LocalLlmManager, setLocalLlmManager, registerChordMenuCommands, registerCommandlineCommands, registerCombinedCommands, registerStateMachineCommands, registerDsNotesViews, registerChatPanel, registerWsPanel, registerChatVariablesEditorCommand, registerQueueEditorCommand, registerTimedRequestsEditorCommand, registerGlobalTemplateEditorCommand, registerRolesEditorCommands, registerReusablePromptEditorCommand, registerQueueTemplateEditorCommand, telegramTestHandler, telegramToggleHandler, telegramConfigureHandler, initTelegramCommands, disposeTelegramStandalone, readEffectiveTelegramRaw, showStatusPageHandler, registerStatusPageSerializer, toggleTrailHandler, getConfigPath, registerTrailViewerCommands, setExtensionPath } from './handlers';

import { registerQuestTodoCustomEditor } from './handlers/questTodoEditor-handler';
import { registerMarkdownBrowser } from './handlers/markdownBrowser-handler';
import { registerTrailCustomEditor } from './handlers/trailEditor-handler';
import { registerTodoLogView } from './handlers/todoLogPanel-handler';
import { registerWindowStatusView, deleteCurrentWindowState, cleanupStaleWindowStates, ensureWindowStateRegistered, writeWindowHeartbeat } from './handlers/windowStatusPanel-handler';
import { getWorkspaceName } from './services/copilotTrailService';
import { registerMinimalModePanels } from './handlers/minimalMode-handler';
import { getLayout, registerLayoutTracking, layoutWorkspaceFolder, onDidChangeLayout } from './utils/workspaceLayout';
import { recordWindowQuestWorkspaceFolder } from './services/aiWorkspaceLive';
import { initGeneratedSchemas } from './services/generatedSchemasService';
import { registerSetupWorkspaceFolderCommand } from './handlers/setupWorkspaceFolder-handler';
import { registerCreateQuestCommand } from './handlers/createQuest-handler';
import { openQuestOverviewOnce } from './handlers/questOverviewOnOpen-handler';
import { initTomScriptingBridgeHandler } from './handlers/tomScriptingBridge-handler';
import {
    McpServerController,
    defaultMcpServerStarter,
    setActiveMcpServerController,
    createTrailServiceMcpSink,
    reconcileMcpServerConfig,
    getMcpServerStatus,
} from './handlers/mcpServer-handler';
import { getCliServerStatus } from './handlers/cliServer-handler';
import { HEARTBEAT_INTERVAL_MS } from './utils/windowHeartbeat';
import { checkBuildStatus, initBuildStatus } from './services/buildStatusService';
import { currentDartBinariesStatus, setDartBinariesConfigSource, summarizeDartBinaries } from './services/dartBinariesStatus';
import { projectListingNoticeLine, projectListingNoticeMarkdown, setProjectListingNotifier } from './services/workspaceProjects';
import { initDartBinariesHelp, showWithDartBinariesHelp } from './handlers/dartBinariesHelp-handler';
import { initPendingQuestionUi } from './handlers/askUser-handler';
import { initAgentSdkCliHelp } from './handlers/agentSdkCliHelp-handler';
import { initProviderSdks } from './handlers/providerSdks-handler';
import { dartScriptUnavailableMessage, isDartScriptAvailable } from './handlers/dartScriptGuard';
import { loadSendToChatConfig } from './utils/sendToChatConfig';
import { aiFormatStartGate, startAiFormatCheck } from './services/aiFormatCheckService';
import { registerUsageLedger } from './services/usageLedgerService';
import { setAgentSdkUsageStoreDir } from './services/agentSdkUsageSnapshots';
import { collectWindowActivity, setWindowActivityBeat, watchWindowActivity } from './handlers/windowActivity-handler';
import { registerRunsOverviewView } from './handlers/runsOverview-handler';
import { mcpLog, disposeMcpLogChannel } from './utils/mcpServerLog';
import { refreshStatusPage } from './handlers/statusPage-handler';
import { debounce } from './utils/debounce';
import { initializeDebugLogger, installConsoleDebugRouting, debugLog } from './utils/debugLogger';
import { monitorStartupStalls, trackWebviewStartup } from './utils/webviewStartupTiming';
import { TomAiConfiguration } from './utils/tomAiConfiguration';
import { WsPaths } from './utils/workspacePaths';
import { TrailService } from './services/trailService';
import { readQueueSettings, getQueueReloadAfterReloadSetting } from './storage/queueFileStorage';

// Tom AI Chat tools
import { registerVsCodeLmTools } from './tools/vscodeLmTools';
import { setBacklinkProvider } from './tools/codespecs-trace-tools';
import { backlinkIndexJson, isValidatorAvailable, setValidationSkippedNotifier } from './services/codespecs-validator';
import { initializeToolDescriptions } from './tools/guideline-tools';

// Chat Enhancement stores & managers
import { ChatVariablesStore } from './managers/chatVariablesStore';
import { ProcessStateStore } from './managers/processStateStore';
import { ensureRunDefaultSession } from './services/agentSdkSessionStore';
import { registerProcessView } from './handlers/processPanel-handler';
import { installProcessMoveMarkers, onSuggestionsDue } from './services/processActionService';
import { openProcessBranchingEditor } from './handlers/processBranching-handler';
import { registerNestedProcessCommands } from './services/nestedProcessCommands';
import { registerSessionsView } from './handlers/sessionsView-handler';
import { registerVscResourcesView } from './handlers/vscResourcesView-handler';
import { registerPrerequisitesView } from './handlers/prerequisitesView-handler';
import { registerProcessEditor } from './handlers/processEditor-handler';
import { registerProcessTemplateEditor } from './handlers/processTemplateEditor-handler';
import { registerAiWorkspaceQuestsEditor } from './handlers/aiWorkspaceQuestsEditor-handler';
import { registerGroupPromptEditor } from './handlers/groupPromptEditor-handler';
import { AnthropicHandler } from './handlers/anthropic-handler';
import { TwoTierMemoryService } from './services/memory-service';
import { registerMemoryPanelCommand } from './handlers/memoryPanel-handler';
import { SessionTodoStore } from './managers/sessionTodoStore';
import { PromptQueueManager } from './managers/promptQueueManager';
import { TimerEngine } from './managers/timerEngine';
import { ReminderSystem } from './managers/reminderSystem';
import {
    getCliServerAutostart,
    getMcpServerAutostart,
    migrateQuestExtensionConfig,
    readEffectiveMcpServerSettings,
    questConfigPath,
} from './managers/extensionConfigStore';
import { registerChatVariableResolvers } from './tools/chatVariableResolvers';
import { instrumentWebviewMessages } from './utils/webviewMessageInstrumentation';
import { markShuttingDown, setOpenAskChatSender } from './services/openAskRecord';

// Global manager instance for SendToChatAdvanced
let sendToChatAdvancedManager: SendToChatAdvancedManager | undefined;

// Global manager instance for Prompt Expander
let localLlmManager: LocalLlmManager | undefined;

// Global manager instance for AI Conversation

// Lifecycle controller for the standalone MCP server (plan §7.5, todo #19).
// Owns the single running server; pushes the live bound port to the Status Page
// on every start/stop and is disposed on deactivate.
let mcpServerController: McpServerController | undefined;

let instrumentationInstalled = false;

/** When activate() began (performance.now()), for the views' start-up timings. */
let activationStartedAt: number | undefined;

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
                            instrumentWebviewMessages(webviewView.webview, {
                                source: viewId,
                                skipTypes: ['loadWindowStates', 'poll', 'ping'],
                                slowHandlerMs: 500,
                                log: (line) => debugLog(`webview message: ${line}`, 'INFO', 'webview.message'),
                                report: (where, error, details) => reportException(`webview:${where}`, error, details),
                            });
                            trackWebviewStartup(
                                webviewView.webview,
                                viewId,
                                activationStartedAt,
                                (line) => debugLog(line, 'INFO', 'webview.startup'),
                            );

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
                            if (viewType !== 'tomAi.trailViewer') {
                                instrumentWebviewMessages(webviewPanel.webview, {
                                    source: viewType,
                                    log: (line) => debugLog(`custom editor message: ${line}`, 'INFO', 'customEditor.message'),
                                    report: (where, error, details) => reportException(`customEditor:${where}`, error, details),
                                });
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
    const tomRoot = getLayout()?.root;
    if (tomRoot) { result = result.replace(/\$\{tomRoot\}/g, tomRoot); }
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
 * We now treat the workspace as a Tom workspace when **either** a configuration
 * layer of the window's layout exists (the root's `.tom/` or the workspace
 * folder's, `workspaceLayout.ts`) **or** the configured `tomAi.configPath` resolves to an
 * existing file (or an existing parent directory, so a not-yet-created config
 * at a valid location still activates fully).
 */
function hasTomWorkspaceConfig(wsRoot: string): boolean {
    // Under the workspace layout: a Tom workspace when a configuration layer
    // exists (the root's `.tom` or the workspace folder's).
    if ((getLayout()?.existingConfigLayers.length ?? 0) > 0) {
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
    activationStartedAt = activateStart;
    const timings: { step: string; ms: number }[] = [];
    const timeStep = (label: string, start: number) => {
        const elapsed = Math.round((performance.now() - start) * 100) / 100;
        timings.push({ step: label, ms: elapsed });
    };
    let stepStart: number;

    // Where VS Code writes this window's output channels (tomAi_readOutputChannel).
    setExtensionLogUri(context.logUri?.fsPath);

    stepStart = performance.now();
    initializeDebugLogger(context);
    // Every agent tool call writes one line (time, transport, tool, duration, size, ok/error) to Tom Tool Log.
    setToolCallLogSink((line) => getToolLogChannel().appendLine(line));
    installConsoleDebugRouting();
    debugLog('Debug logger initialized', 'INFO', 'extension.activate');
    timeStep('debugLogger + consoleRouting', stepStart);

    // The first two minutes: every stall of the extension host's thread
    // (ours or another extension's) as a debug-log line with its time.
    const stopStallMonitor = monitorStartupStalls({
        durationMs: 120_000,
        intervalMs: 100,
        thresholdMs: 250,
        log: (line) => debugLog(line, 'INFO', 'extension.startup'),
    });
    context.subscriptions.push({ dispose: stopStallMonitor });

    // Store extension path for bundled binary resolution
    setExtensionPath(context.extensionPath);

    stepStart = performance.now();
    installGlobalInstrumentation();
    timeStep('globalInstrumentation', stepStart);

    // ── Check for Tom AI workspace ──────────────────────────────────
    // The window's layout (root, workspace folder, _ai, config layers) is
    // computed once and kept current. Without a config layer (no .tom/ at the
    // root or in the workspace folder), skip full initialization and show an
    // informational message instead.
    registerLayoutTracking(context);
    const wsRoot = getLayout()?.workspaceFolder;
    const hasTomConfig = wsRoot ? hasTomWorkspaceConfig(wsRoot) : false;
    if (!hasTomConfig) {
        const totalMs = Math.round((performance.now() - activateStart) * 100) / 100;
        const msg = 'TOM AI: no TOM AI config found (no .tom/ folder at the root or in the workspace folder, and tomAi.configPath unset/invalid). Extension running in minimal mode.';
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

    // ── The _ai files in this build's format? (vscimpb142a) ─────────
    // Older or newer: Tom AI does not start; every panel shows a hint with
    // Upgrade the workspace… (the migration page) or the build to install.
    if (aiFormatStartGate(context)) {
        bridgeLog('Tom AI: the _ai files are not in this build\'s format; emergency mode (no normal start).');
        return;
    }

    bridgeLog('Tom AI extension is now active!');

    stepStart = performance.now();
    TomAiConfiguration.init(context);
    TrailService.init(context);
    timeStep('tomAiConfiguration + trailService', stepStart);

    // Which Dart-built binaries (tom_bs, tomspecs) this platform has,
    // bundled or configured in `bridge.executables`; when one is missing, the
    // page about it opens once per build and platform, and a status-bar hint
    // stays.
    stepStart = performance.now();
    setDartBinariesConfigSource(() => {
        const bridge = loadSendToChatConfig()?.bridge;
        const profiles = bridge?.profiles ?? {};
        const current = bridge?.current ? profiles[bridge.current] : undefined;
        // The bridge runs the current profile's executable, else the first profile's that names one.
        const bridgeExecutable = current?.executable ?? Object.values(profiles).find((p) => typeof p?.executable === 'string')?.executable;
        return { executables: bridge?.executables, binaryPath: bridge?.binaryPath, workspaceRoot: layoutWorkspaceFolder(), bridgeExecutable };
    });
    initDartBinariesHelp(context);
    // The project list without buildkit (qrfix14): once per reason and window, a notification
    // with the diagnostic (where buildkit was looked for, what it answered, how to fix it).
    setProjectListingNotifier((fallback) => {
        void vscode.window.showWarningMessage(projectListingNoticeLine(fallback), 'Show details').then(async (pick) => {
            if (pick !== 'Show details') { return; }
            const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: projectListingNoticeMarkdown(fallback, layoutWorkspaceFolder() ?? '') });
            await vscode.window.showTextDocument(doc, { preview: true });
        });
    });
    context.subscriptions.push({ dispose: () => setProjectListingNotifier(undefined) });
    // A question waiting for the user's answer: @T: Show Pending Question and its status-bar entry.
    initPendingQuestionUi(context);
    // The page the Agent SDK transport points to when the Anthropic provider's
    // SDK or its Claude CLI for this platform is not installed.
    initAgentSdkCliHelp(context);
    // Provider SDKs (not in the VSIX): their folder, the page, and the page
    // opened now when no provider is installed.
    initProviderSdks(context);
    timeStep('dartBinariesHelp', stepStart);

    // Initialize bridge client and immediately start the bridge process.
    // This must happen early so bridge output is visible even if later
    // registrations throw and abort activate().
    stepStart = performance.now();
    initializeBridgeClient(context);
    timeStep('bridgeClient', stepStart);

    // Without tom_bs on this platform this logs one line and starts nothing.
    // Not awaited: starting tom_bs takes a second or more (spawn, then a
    // settle wait), and every view waits for activate() to return before it
    // is resolved. What needs the bridge running waits for `bridgeStarted`.
    stepStart = performance.now();
    const bridgeStartBegin = stepStart;
    const bridgeStarted: Promise<void> = restartBridgeHandler(context, false).then(
        () => {
            const ms = Math.round((performance.now() - bridgeStartBegin) * 100) / 100;
            debugLog(`restartBridgeHandler finished after activation began: ${ms}ms`, 'INFO', 'extension.activate');
        },
        (error) => reportException('activate:restartBridgeHandler', error),
    );
    timeStep('restartBridgeHandler (started)', stepStart);

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

    // The QUEST NOTES side panel (@TOM INFO activity-bar container)
    stepStart = performance.now();
    registerQuestNotesPanel(context);
    timeStep('questNotesPanel', stepStart);

    // @TOM INFO › RUNS: every run of every window on this machine
    stepStart = performance.now();
    registerRunsOverviewView(context);
    timeStep('runsOverview', stepStart);

    // @TOM INFO › NOTIFICATIONS: queue and todo events of every window on this machine
    stepStart = performance.now();
    registerNotificationsView(context);
    timeStep('notifications', stepStart);

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

    // Register the PROCESS view and the process editor
    stepStart = performance.now();
    registerProcessView(context);
    registerSessionsView(context);
    // @TOM VSC: this window's extension helper processes, profiles, heavy settings, and the status-bar total (vscimpb30).
    registerVscResourcesView(context);
    registerPrerequisitesView(context);
    registerProcessEditor(context);
    registerProcessTemplateEditor(context);
    // AI Workspace Quests: the quests of this workspace, _ai/workspaces/<workspace>.yaml (vscimpb144).
    registerAiWorkspaceQuestsEditor(context);
    registerGroupPromptEditor(context);
    timeStep('processViews', stepStart);

    // Register Global Template Editor command
    stepStart = performance.now();
    registerGlobalTemplateEditorCommand(context);
    registerRolesEditorCommands(context);
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
    // A quest window shows its overview once per quest and machine (after the MD Browser registered its restored tabs).
    void openQuestOverviewOnce(context).catch((err) => debugLog(`[QuestOverview] opening the quest overview failed: ${err}`, 'WARN', 'extension.activate'));
    // Every send's usage block, summed for the Status Page.
    registerUsageLedger(context);
    // The Agent SDK sessions' last cumulative accounting, so a resumed session's prompt reports its own share (qrfix3).
    setAgentSdkUsageStoreDir(context.globalStorageUri.fsPath);
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
    // Register an idle state file for THIS window so it shows in the panel
    // even before it dispatches anything (otherwise open-but-idle windows
    // never appear). Does not clobber an existing file with real status.
    ensureWindowStateRegistered(wsWindowId, getWorkspaceName(), WsPaths.getWorkspaceQuestId());
    // The running build, compared with the installed one on every heartbeat:
    // a status-bar item asks for a reload when a newer build is installed.
    initBuildStatus(context);
    // The migration command, and another window's migration under this one
    // pauses its runs and asks for a reload (vscimpb142; the start itself is
    // gated by aiFormatStartGate above).
    startAiFormatCheck(context);
    // The heartbeat: every 30 s the time, this process and its CLI / MCP
    // servers, so other windows (WINDOW STATUS, tomAi_sendItemToQuest) can
    // tell a running window from a gone one.
    {
        let beating = false;
        const beat = async (): Promise<void> => {
            if (beating) { return; }
            beating = true;
            try {
                const cli = await getCliServerStatus();
                writeWindowHeartbeat(wsWindowId, getWorkspaceName(), WsPaths.getWorkspaceQuestId(), {
                    pid: process.pid,
                    cliServer: { running: !!cli.running, ...(cli.port ? { port: cli.port } : {}) },
                    mcpServer: getMcpServerStatus(),
                    build: checkBuildStatus(),
                    dartBinaries: summarizeDartBinaries(currentDartBinariesStatus()),
                }, collectWindowActivity(context));
            } finally {
                beating = false;
            }
        };
        void beat();
        setWindowActivityBeat(() => { void beat(); });
        const heartbeatTimer = setInterval(() => { void beat(); }, HEARTBEAT_INTERVAL_MS);
        context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });
    }
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
            ensureExecuteTodoUserMessageTemplate,
            ensureExplainTodoUserMessageTemplate,
            ensureSeededUserMessageTemplatesInConfig,
        } = await import('./utils/sendToChatConfig.js');
        const stcConfig = loadSendToChatConfig();
        // One-shot seed: migrate the in-code transport-retry default into an
        // on-disk "Default Retry" template (marked isDefault) so "use default"
        // resolves to an editable, pickable entry. No-op once it exists.
        // Same pass also seeds the "Execute TODO" Anthropic user-message
        // template and the "Explain TODO" one (options only — not forced default).
        if (stcConfig) {
            try {
                let stcDirty = false;
                if (ensureDefaultTransportRetryTemplate(stcConfig)) {
                    stcDirty = true;
                    bridgeLog('Seeded "Default Retry" transport-retry template', 'INFO');
                }
                if (ensureExecuteTodoUserMessageTemplate(stcConfig)) {
                    stcDirty = true;
                    bridgeLog('Seeded "Execute TODO" Anthropic user-message template', 'INFO');
                }
                if (ensureExplainTodoUserMessageTemplate(stcConfig)) {
                    stcDirty = true;
                    bridgeLog('Seeded "Explain TODO" Anthropic user-message template', 'INFO');
                }
                // With asking, the ask-tool hints, the retired templates (vscimpb120).
                const seeded = ensureSeededUserMessageTemplatesInConfig(stcConfig);
                if (seeded.length) {
                    stcDirty = true;
                    bridgeLog(`User-message templates: ${seeded.join('; ')}`, 'INFO');
                }
                // The Assist prompts' default templates (Grill me, Explain in detail,
                // Explain a decision, Finish review round, Out of budget), by id.
                const { ensureDefaultAssistPrompts } = await import('./utils/assistPrompts.js');
                if (ensureDefaultAssistPrompts(stcConfig)) {
                    stcDirty = true;
                    bridgeLog('Seeded the default Assist prompt templates', 'INFO');
                }
                if (stcDirty) {
                    saveSendToChatConfig(stcConfig);
                }
            } catch (e: any) {
                bridgeLog(`Default template seed failed: ${e?.message ?? e}`, 'ERROR');
            }
        }
        // One-shot migration of the legacy per-subsystem config files for this
        // quest into the two consolidated files (quest-refresh + telegram +
        // CLI/MCP autostart). Idempotent — a no-op once migrated.
        try {
            migrateQuestExtensionConfig();
        } catch (e: any) {
            bridgeLog(`Extension-config migration failed: ${e?.message ?? e}`, 'ERROR');
        }
        // The quest's workspace folder, recorded in its extension_config.<quest>.yaml (02_wslayout-11): the
        // workspace quests and tomAi_getWorkspaceInfo read it. Again when the layout changes.
        recordWindowQuestWorkspaceFolder();
        context.subscriptions.push(onDidChangeLayout(() => recordWindowQuestWorkspaceFolder()));
        // The schemas of the files the extension writes, as stamped generated copies in the top .tom (02_wslayout-8).
        initGeneratedSchemas(context);
        if (getCliServerAutostart() && !isDartScriptAvailable()) {
            // No tom_bs on this platform: nothing to start, and no error at start
            // (the Dart binaries page and its status-bar hint are the notice).
            bridgeLog(`[DartScript] ${dartScriptUnavailableMessage('The CLI integration server autostart')}`, 'INFO');
        } else if (getCliServerAutostart()) {
            // Once the bridge has started, and a little after, so it has settled.
            void bridgeStarted.then(() => setTimeout(async () => {
                try {
                    await startCliServerHandler();
                    bridgeLog('CLI server auto-started', 'INFO');
                } catch (e: any) {
                    bridgeLog(`CLI server autostart failed: ${e.message}`, 'ERROR');
                }
            }, 2000));
        }
        // Telegram autostart is a per-quest setting (see telegram-commands), so it
        // is read from the quest file rather than the shared config.
        if (readEffectiveTelegramRaw()?.autostart) {
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

        const mcpAutostartSettings = readEffectiveMcpServerSettings();
        if (mcpAutostartSettings.enabled && getMcpServerAutostart()) {
            const settings = mcpAutostartSettings;
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
        // per-quest MCP config file directly (`extension_config.{quest}.yaml`):
        // an edit by hand or from another window reconciles the server
        // (disabled ⇒ stop; running ⇒ restart onto new host/port/tools), not
        // just on card save. The bursty write events for a single save collapse
        // via the debounce.
        const mcpQuestConfigPath = questConfigPath();
        if (mcpQuestConfigPath) {
            const mcpConfigWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(
                    vscode.Uri.file(path.dirname(mcpQuestConfigPath)),
                    path.basename(mcpQuestConfigPath),
                ),
            );
            const reconcileFromConfig = debounce(() => {
                void reconcileMcpServerConfig(readEffectiveMcpServerSettings()).catch((e: any) => {
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
    context.subscriptions.push({ dispose: () => localLlmManager?.dispose() });
    timeStep('localLlmManager', stepStart);

    // Initialize Tom Scripting Bridge handler
    stepStart = performance.now();
    initTomScriptingBridgeHandler();
    timeStep('tomScriptingBridgeHandler', stepStart);

    // Dispose standalone Telegram on deactivation
    context.subscriptions.push({ dispose: () => disposeTelegramStandalone() });

    // Initialize Chat Enhancement stores (§1.1–§1.4)
    stepStart = performance.now();
    ChatVariablesStore.init(context);
    // The quest's process state; supplies the process chat variables, so after ChatVariablesStore.
    ProcessStateStore.init(context);
    SessionTodoStore.init(context);
    timeStep('chatEnhancementStores', stepStart);

    // Initialize Anthropic handler (Phase 1 of anthropic_sdk_integration)
    stepStart = performance.now();
    AnthropicHandler.init(context);
    timeStep('anthropicHandler', stepStart);

    // Memory service + panel (Phase 3 of anthropic_sdk_integration)
    stepStart = performance.now();
    TwoTierMemoryService.init(context);
    // The window's quest moves to per-session storage, and the bare `default` session of an older build becomes
    // `default@default` (vscimpb151): at window start, before anything sends in it.
    try { TwoTierMemoryService.instance.ensureSessionStorage(WsPaths.getWorkspaceQuestId() || undefined); } catch { /* reported in the storage log */ }
    // A new run gets its default session, default@<run> based on default@default, when it is created (vscimpb151).
    ProcessStateStore.runCreatedHook = (quest, run) => {
        ensureRunDefaultSession(TwoTierMemoryService.instance.agentSdkSessionsFolder(quest), run);
    };
    registerMemoryPanelCommand(context);
    timeStep('memoryServiceAndPanel', stepStart);

    // Initialize Queue & Automation (§3.2–§3.4)
    stepStart = performance.now();
    // @TOM INFO › NOTIFICATIONS: the machine's event log, and who a change is from (vscimpb124).
    configureNotificationLog(path.join(context.globalStorageUri.fsPath, 'notifications', 'events.jsonl'), {
        windowId: `${vscode.env.sessionId.substring(0, 8)}_${vscode.env.machineId.substring(0, 8)}`,
        quest: () => WsPaths.getWorkspaceQuestId(),
        run: () => currentInteractionRun(),
        who: () => {
            const tool = getCurrentToolContext();
            const itemId = currentQueueItemId();
            let item: ReturnType<typeof PromptQueueManager.prototype.getById> | undefined;
            try { item = itemId ? PromptQueueManager.instance.getById(itemId) : undefined; } catch { item = undefined; }
            if (!tool || tool.source === 'user') {
                // Outside a tool call: the queue acting for an item, else the user (the UI).
                return itemId ? { kind: 'extension' as const, label: `queue item ${itemId}` } : { kind: 'user' as const };
            }
            const profile = item?.lastDispatched?.anthropicProfileId ?? item?.anthropicProfileId;
            const session = callerSession() ?? item?.session;
            return {
                kind: 'agent' as const,
                transport: tool.source,
                ...(profile ? { profile } : {}),
                ...(session ? { session } : {}),
                ...(itemId ? { queueItemId: itemId } : {}),
                ...(item?.todoClaim ? { todo: `${item.todoClaim.questId}/${item.todoClaim.todoId}` } : {}),
            };
        },
    });
    // A panel send that waited in an ask when the window reloaded: its answer goes out as a new chat send in the
    // same session and run (vscimpb166, services/openAskRecord.ts).
    setOpenAskChatSender(async (p) => {
        const { runAnthropicSend } = await import('./handlers/sendToChatRouter.js');
        const outcome = await runAnthropicSend(context, p.text, { source: 'reload', ...(p.session ? { session: p.session } : {}), ...(p.run ? { run: p.run } : {}) });
        if (!outcome.ok) { bridgeLog(`Reload: the answer to a chat send's question was not sent: ${outcome.error ?? 'unknown'}`, 'ERROR'); }
    });
    PromptQueueManager.init(context);
    // A completed todo's `on_done`: carried out by the extension (ww_a_collab-5).
    installTodoOnDone();
    // `filed_by` of a todo the tools or the todo panel file: where the call runs.
    setTodoFiledByContextProvider(() => {
        const quest = WsPaths.getWorkspaceQuestId();
        const item = PromptQueueManager.instance.getById(currentQueueItemId() ?? '');
        return {
            windowQuest: quest === 'default' ? undefined : quest,
            session: callerSession(),
            run: currentProcessRun()?.run ?? item?.run,
            claim: item?.todoClaim ? { quest: item.todoClaim.questId, id: item.todoClaim.todoId } : undefined,
            sender: item?.from ? { quest: item.from.quest, run: item.from.run } : undefined,
        };
    });
    // A process step ends with its queue: the queue's process-move markers move the process.
    installProcessMoveMarkers();
    registerNestedProcessCommands(context);
    // The agent's suggestions are due (the step's queue items done): the process branching editor opens.
    onSuggestionsDue(() => { void openProcessBranchingEditor(context); });
    // The window state file follows the role, the process position and the queue as they change.
    watchWindowActivity(context);
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
    timeStep('vscodeLmTools.initToolDescriptions', stepStart);
    // Local-LLM bridge tools (Ask Big Brother, Ask Copilot) are lazy-initialized
    // on first use — selectChatModels() takes 20–30s during activation rush
    // but <1s when the event loop is idle.
    stepStart = performance.now();
    registerVsCodeLmTools(context);
    // The CodeSpecs trace reads a generated trio's back-links through
    // `tomspecs :codespecs-validate` (configured, or bundled in bin/<platform>/). Without it
    // on this platform the provider answers null: the trace goes on without
    // back-links, its answer carries the warning, and the user is told once per
    // tool and window session (a warning with the Dart binaries help button).
    setBacklinkProvider(async (dirs) => (isValidatorAvailable() ? backlinkIndexJson(dirs) : null));
    setValidationSkippedNotifier((message) => { void showWithDartBinariesHelp('warning', message); });
    context.subscriptions.push({ dispose: () => { setBacklinkProvider(null); setValidationSkippedNotifier(null); } });
    timeStep('vscodeLmTools.registerTools', stepStart);

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
    // First: the asks the shutdown closes keep their record on their queue item, so the reloaded window
    // shows them again and their answer continues the item (vscimpb166, services/openAskRecord.ts).
    markShuttingDown();
    bridgeLog('Tom AI extension deactivating - stopping bridge...');

    // Stop the MCP server so it never leaks its listener across reloads (#19).
    // dispose() is idempotent and a no-op when the server was never started.
    if (mcpServerController) {
        void mcpServerController.dispose();
        setActiveMcpServerController(undefined);
    }
    disposeMcpLogChannel();
    // Stop the external MCP servers the client started (CC-16).
    void import('./handlers/anthropic-handler.js').then((m) => m.disposeExternalMcp()).catch(() => undefined);
    // An open tomAi_askInMdBrowser ends; the MD Browser's comments worker stops.
    void import('./handlers/markdownBrowser-handler.js').then((m) => m.disposeMarkdownBrowser()).catch(() => undefined);

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
    // Setup New Workspace Folder: unpack the bundled workspace template (minimal mode too)
    registerSetupWorkspaceFolderCommand(context);
    // Create New Quest: the quest's files under _ai/quests/<id>/
    registerCreateQuestCommand(context);

    // Send to Anthropic/LLM - the @CHAT Anthropic panel's current profile and session
    registerSendToLlmCommands(context);

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
            return await executeInTomAiBuildHandler(uri, context);
        }
    );

    // Execute Dart file as script in D4rt (executeScript)
    const executeAsScriptInTomAiBuildCmd = vscode.commands.registerCommand(
        'tomAi.executeScript',
        async (uri?: vscode.Uri) => {
            return await executeAsScriptHandler(uri, context);
        }
    );

    // Restart/Start Dart Bridge command
    const restartBridgeCmd = vscode.commands.registerCommand(
        'tomAi.bridge.restart',
        async () => {
            return await restartBridgeHandler(context, true);
        }
    );

    // Switch Bridge Profile command
    const switchBridgeProfileCmd = vscode.commands.registerCommand(
        'tomAi.bridge.switchProfile',
        async () => {
            return await switchBridgeProfileHandler(context);
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
    // TomAiConfiguration follows its files and the `tomAi.configPath` setting on
    // every read; the command forces that now and reloads the send-to-chat
    // manager (its own copy, kept current by its own file watcher).
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
            e.affectsConfiguration('tomAi.layout') ||
            e.affectsConfiguration('tomAi.queueFolder')
        ) {
            void reloadAllConfig(false);
        }
    });

    // CLI Integration Server commands
    const startCliServerCmd = vscode.commands.registerCommand(
        'tomAi.cliServer.start',
        async () => {
            return await startCliServerHandler();
        }
    );

    const startCliServerCustomPortCmd = vscode.commands.registerCommand(
        'tomAi.cliServer.startCustomPort',
        async () => {
            return await startCliServerCustomPortHandler();
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
            const settings = readEffectiveMcpServerSettings();
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
            const settings = readEffectiveMcpServerSettings();
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
            return await startProcessMonitorHandler();
        }
    );

    // Debug Logging toggle command
    const toggleDebugLoggingCmd = vscode.commands.registerCommand(
        'tomAi.bridge.toggleDebug',
        async () => {
            return await toggleBridgeDebugLoggingHandler();
        }
    );

    // Print Configuration command
    const printConfigurationCmd = vscode.commands.registerCommand(
        'tomAi.printConfiguration',
        async () => {
            return await printConfigurationHandler();
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

    // Capture the extension context for the Telegram command registry so the
    // `send_prompt` command can drive the Anthropic chat panel.
    initTelegramCommands(context);

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
        // An optional section id (the Extension Tools catalogue's section entries): open it and scroll to it.
        async (section?: unknown) => {
            await showStatusPageHandler(typeof section === 'string' ? section : undefined);
        }
    );
    // Restore the Status Page panel after a window reload.
    registerStatusPageSerializer(context);

    // Focus @TOM activity-bar sidebar container
    const focusTomSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-sidebar');
        }
    );
    // Focus @TOM WS: the workspace views (notes, workspace todos, todo log, window status)
    const focusTomWsSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomWsSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-ws-sidebar');
        }
    );
    // Focus @TOM VSC: this window's resource-hungry extension processes, profiles and heavy settings
    const focusTomVscSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomVscSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-vsc-sidebar');
        }
    );
    // Focus @TOM INFO: the active quest's notes, Edit and View tabs
    const focusNotesSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomInfoSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-info-sidebar');
        }
    );

    // Focus @TOM TODO: the todo panel on its own, across quests (vscimpb138)
    const focusTomTodoSidebarCmd = vscode.commands.registerCommand(
        'tomAi.tomTodoSidebar.focus',
        async () => {
            await vscode.commands.executeCommand('workbench.view.extension.tomAi-todo-sidebar');
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
            // Which sessions' histories and memory (named as the active quest's; applied in every quest).
            const { pickSessionsOrAll } = await import('./handlers/sessionSelectionPicker.js');
            const picked = await pickSessionsOrAll(WsPaths.getWorkspaceQuestId() || '', {
                title: 'Compaction-format migration: which sessions (in every quest)',
                current: 'default',
            });
            if (!picked) { return; }
            const out = vscode.window.createOutputChannel('Tom AI: Compaction Migration');
            out.show(true);
            out.appendLine(`Tom AI: starting compaction-format migration for ${picked.all ? 'every session' : picked.sessions.join(', ')}…`);
            const report = migrateCompactionFormat({
                onProgress: (msg: string) => out.appendLine(msg),
                sessions: picked.all ? 'all' : picked.sessions,
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
        telegramTestCmd,
        telegramToggleCmd,
        telegramConfigureCmd,
        toggleTrailCmd,
        showStatusPageCmd,
        focusTomSidebarCmd,
        focusTomWsSidebarCmd,
        focusTomVscSidebarCmd,
        focusNotesSidebarCmd,
        focusTomTodoSidebarCmd,
        openInMdViewerCmd,
        openExtensionSettingsCmd,
        migrateCompactionFormatCmd
    );
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

        // Not straight into Copilot Chat (vscimpb109): once the queue is
        // restored (items loaded, crash recovery done) and the window's run is
        // known, the prompt is queued at the front of that run's queue with its
        // defaults and sent as Continue sends it, also while the run is paused.
        void Promise.all([PromptQueueManager.whenReady(), ProcessStateStore.ready])
            .then(([manager]) => manager.queueReloadPrompt(prompt))
            .catch((error) => bridgeLog(`Reload prompt could not be queued: ${error instanceof Error ? error.message : String(error)}`, 'ERROR'));

        bridgeLog(
            `Reload prompt: queued at the front of the window's run once the queue is restored (${questId ? `quest=${questId}` : 'workspace scope'})`,
            'INFO',
        );
    } catch (error) {
        // Best-effort behavior only; activation should not fail.
        console.error('Error scheduling reload prompt send:', error);
    }
}
