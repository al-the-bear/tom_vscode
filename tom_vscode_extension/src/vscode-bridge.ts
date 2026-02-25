import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getPromptExpanderManager, getBotConversationManager } from './handlers';

const DART_COMMAND = 'dart';

/**
 * Global debug logging switches for VS Code Bridge
 * 
 * - debugTraceLogging: Enables detailed logging of raw message transmission (JSON data)
 * - debugLogging: Enables logging of request/response handling after message parsing
 */
export const BridgeLogging = {
    /** Enable trace-level logging for raw data transmission (JSON messages) */
    debugTraceLogging: false,
    /** Enable debug logging for request handling and responses */
    debugLogging: false,
};

/**
 * Truncate a string for compact logging
 */
function truncate(s: string, maxLength: number): string {
    if (s.length <= maxLength) { return s; }
    return s.substring(0, maxLength) + '...';
}

/**
 * Helper function for bridge logging (trace level - raw transmission)
 */
function bridgeLogTrace(message: string, outputChannel?: vscode.OutputChannel, level: 'INFO' | 'ERROR' = 'INFO'): void {
    if (BridgeLogging.debugTraceLogging && outputChannel) {
        outputChannel.appendLine(`[VS Code Extension] ${level} ${message}`);
    }
}

/**
 * Helper function for bridge logging (debug level - request handling)
 */
function bridgeLog(message: string, outputChannel?: vscode.OutputChannel, level: 'INFO' | 'ERROR' = 'INFO'): void {
    if (BridgeLogging.debugLogging && outputChannel) {
        outputChannel.appendLine(`[VS Code Extension] ${level} ${message}`);
    }
}

/**
 * Helper function for bridge logging with short fallback when debugLogging is off
 */
function bridgeLogWithFallback(
    fullMessage: string,
    shortMessage: string,
    outputChannel?: vscode.OutputChannel,
    level: 'INFO' | 'ERROR' = 'INFO'
): void {
    if (!outputChannel) { return; }
    if (BridgeLogging.debugLogging) {
        outputChannel.appendLine(`[VS Code Extension] ${level} ${fullMessage}`);
    } else {
        outputChannel.appendLine(`[VS Code Extension] ${level} ${shortMessage}`);
    }
}

/**
 * JSON-RPC message types
 */
interface JsonRpcRequest {
    jsonrpc: string;
    id?: string | number;
    method: string;
    params: any;
    callId?: string;
    timeoutMs?: number;
}

interface JsonRpcResponse {
    jsonrpc: string;
    id: string | number;
    result?: any;
    error?: any;
}

interface JsonRpcNotification {
    jsonrpc: string;
    method: string;
    params: any;
    callId?: string;
    timeoutMs?: number;
}

/**
 * Dart Bridge Client - Communicates with Dart process via stdin/stdout
 */
export class DartBridgeClient {
    private process: ChildProcess | null = null;
    private messageId = 0;
    private pendingRequests = new Map<string, {
        resolve: (value: any) => void;
        reject: (reason: any) => void;
        timer?: NodeJS.Timeout;
        method: string;
        timeoutMs: number;
        startedAt: number;
    }>();
    private context: vscode.ExtensionContext;
    static outputChannel: vscode.OutputChannel;
    private bridgePath: string = '';
    private bridgeCommand: string = DART_COMMAND;
    private bridgeArgs: string[] = [];
    private bridgeRunPubGet: boolean = true;
    private autoRestart: boolean = false;
    private isStarting: boolean = false;
    private restartTimer: NodeJS.Timeout | null = null;
    private readonly defaultRequestTimeoutMs = 30000;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // Reuse existing output channel if available, otherwise create new one
        if (!DartBridgeClient.outputChannel) {
            DartBridgeClient.outputChannel = vscode.window.createOutputChannel('Tom Dartbridge Log');
        }
    }

    /**
     * Get the output channel for registration with extension context
     */
    getOutputChannel(): vscode.OutputChannel {
        return DartBridgeClient.outputChannel;
    }

    /**
     * Start the Dart bridge with auto-restart on error.
     * 
     * @param bridgePath Working directory for the bridge process
     * @param command    Executable to run (default: 'dart')
     * @param args       Arguments to pass (default: ['run', 'bin/tom_bs.dart'])
     * @param runPubGet  Whether to run `dart pub get` before starting (default: true)
     */
    async startWithAutoRestart(
        bridgePath: string,
        command?: string,
        args?: string[],
        runPubGet?: boolean
    ): Promise<void> {
        this.bridgePath = bridgePath;
        if (command !== undefined) { this.bridgeCommand = command; }
        if (args !== undefined) { this.bridgeArgs = args; }
        if (runPubGet !== undefined) { this.bridgeRunPubGet = runPubGet; }
        this.autoRestart = true;
        this.clearPendingRestartTimer();
        DartBridgeClient.outputChannel.show(true); // Show output channel (preserveFocus=true)
        await this.start();
    }

    /**
     * Start the Dart bridge process
     */
    async start(): Promise<void> {
        if (this.isStarting) {
            DartBridgeClient.outputChannel.appendLine('[VS Code Extension] INFO Bridge is already starting...');
            return;
        }

        if (this.process) {
            DartBridgeClient.outputChannel.appendLine('[VS Code Extension] INFO Bridge already running... stopping existing process before restart.');
            this.stop(true);
        }

        if (!this.bridgePath) {
            throw new Error('Bridge path not set. Call startWithAutoRestart before start.');
        }

        this.isStarting = true;

        try {
            // Step 1: Run dart pub get (only if configured)
            if (this.bridgeRunPubGet) {
                DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Running dart pub get in ${this.bridgePath}...`);
                await this.runCommand(DART_COMMAND, ['pub', 'get'], this.bridgePath);
                DartBridgeClient.outputChannel.appendLine('[VS Code Extension] INFO dart pub get completed');
            }

            // Step 2: Start the bridge
            // Resolve command and args from profile configuration
            const effectiveCommand = this.bridgeCommand;
            // Only use dart-specific fallback args when command is 'dart'
            const effectiveArgs = this.bridgeArgs.length > 0
                ? this.bridgeArgs
                : (effectiveCommand === DART_COMMAND
                    ? ['run', path.join(this.bridgePath, 'bin', 'tom_bs.dart')]
                    : []);

            const cmdLine = [effectiveCommand, ...effectiveArgs].join(' ');
            DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Starting Dart bridge: ${cmdLine}`);

            // Spawn process
            const spawnOptions: any = {
                cwd: this.bridgePath,
                stdio: ['pipe', 'pipe', 'pipe']
            };
            if (process.platform === 'win32') {
                spawnOptions.shell = true;
            }

            this.process = spawn(effectiveCommand, effectiveArgs, spawnOptions);

            if (!this.process.stdout || !this.process.stdin || !this.process.stderr) {
                DartBridgeClient.outputChannel.appendLine('[VS Code Extension] ERROR Failed to initialize process stdio');
                throw new Error('Failed to initialize process stdio');
            }

            // Handle stdout (JSON-RPC messages from Dart)
            let buffer = '';
            this.process.stdout.on('data', (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim()) {
                        const trimmed = line.trim();
                        bridgeLog(`Raw from Dart: ${trimmed}`, DartBridgeClient.outputChannel);
                        try {
                            this.handleMessage(trimmed);
                        } catch (err: any) {
                            bridgeLog(`Error handling incoming line: ${err?.message ?? err}`, DartBridgeClient.outputChannel, 'ERROR');
                            DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Handle Error: ${err?.message ?? err}`);
                        }
                    }
                }
            });

            // Handle stderr (Dart errors)
            this.process.stderr!.on('data', (data: Buffer) => {
                const text = data.toString().trim();
                if (text) {
                    DartBridgeClient.outputChannel.appendLine(`[VS Code Bridge] ${text}`);
                }
            });

            this.process.on('error', (err) => {
                DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Dart process error: ${err}`);
                this.handleProcessExit('Bridge process error');
            });

            const exitHandler = (code: number | null, signal?: NodeJS.Signals) => {
                DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Dart process exited with code ${code} signal ${signal ?? ''}`);
                const reason = `Bridge process terminated (code ${code}${signal ? `, signal ${signal}` : ''})`;
                this.handleProcessExit(reason, code ?? undefined);
            };

            this.process.on('exit', exitHandler);
            this.process.on('close', exitHandler);

            // Wait a bit for process to start
            await new Promise(resolve => setTimeout(resolve, 1000));
            DartBridgeClient.outputChannel.appendLine('[VS Code Extension] INFO Dart bridge started');
        } catch (error) {
            DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Failed to start bridge: ${error}`);
            if (this.autoRestart) {
                this.scheduleRestart('Start failed');
            }
            throw error;
        } finally {
            this.isStarting = false;
        }
    }

    /**
     * Run a command and wait for completion
     */
    private runCommand(command: string, args: string[], cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const spawnOptions: any = { cwd, stdio: 'pipe' };
            if (process.platform === 'win32') {
                spawnOptions.shell = true;
            }
            const proc = spawn(command, args, spawnOptions);

            let output = '';
            proc.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            proc.stderr?.on('data', (data) => {
                output += data.toString();
            });
            
            proc.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Command failed with code ${code}: ${output}`));
                }
            });
            
            proc.on('error', (err) => {
                reject(err);
            });
        });
    }

    private handleProcessExit(reason: string, code?: number): void {
        const proc = this.process;
        if (!proc) {
            return;
        }

        this.stop(true);
        this.process = null;
        proc.removeAllListeners();
        DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Cleaning up bridge process: ${reason}`);

        this.clearPendingRequests(reason);

        if (this.autoRestart && (code === undefined || code !== 0)) {
            this.scheduleRestart(reason);
        }
    }

    private scheduleRestart(reason: string): void {
        if (this.isStarting) {
            return;
        }

        this.clearPendingRestartTimer();
        DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Attempting to restart bridge in 5 seconds (${reason})...`);

        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start().catch(e => {
                DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Failed to restart bridge: ${e}`);
            });
        }, 5000);
    }

    private clearPendingRestartTimer(): void {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }

    /**
     * Check if bridge is running
     */
    isRunning(): boolean {
        return this.process !== null;
    }

    /**
     * Stop the Dart bridge process
     */
    stop(autoRestart: boolean = false): void {
        this.clearPendingRestartTimer();
        this.autoRestart = autoRestart;

        const proc = this.process;
        if (proc) {
            proc.removeAllListeners();
            if (!proc.killed) {
                proc.kill();
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill('SIGKILL');
                    }
                }, 2000);
            }
            this.process = null;
        }

        this.clearPendingRequests('Bridge stopped');
    }

    /**
     * Reject and clear all pending requests (e.g., on reload/stop/exit)
     */
    private clearPendingRequests(reason: string): void {
        for (const [id, entry] of this.pendingRequests.entries()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            entry.reject(new Error(reason));
            this.pendingRequests.delete(id);
        }
    }

    private bumpPendingTimeout(callId: string, timeoutMs: number = 0): void {
        const entry = this.pendingRequests.get(callId);
        if (!entry) {
            return;
        }

        if (entry.timer) {
            clearTimeout(entry.timer);
        }

        const deltaMs = timeoutMs ?? 0;
        const updatedTimeoutMs = entry.timeoutMs + deltaMs;
        entry.timeoutMs = updatedTimeoutMs;

        const expiresAt = entry.startedAt + updatedTimeoutMs;
        const remainingMs = expiresAt - Date.now();

        if (updatedTimeoutMs <= 0 || remainingMs <= 0) {
            this.pendingRequests.delete(callId);
            bridgeLog(`[E10] Request timeout (bumped): ${entry.method} (id: ${callId})`, DartBridgeClient.outputChannel, 'ERROR');
            entry.reject(new Error(`[E10] Request timeout: ${entry.method}`));
            return;
        }

        entry.timer = setTimeout(() => {
            this.pendingRequests.delete(callId);
            bridgeLog(`[E11] Request timeout (bumped timer): ${entry.method} (id: ${callId})`, DartBridgeClient.outputChannel, 'ERROR');
            entry.reject(new Error(`[E11] Request timeout: ${entry.method}`));
        }, remainingMs);

        this.pendingRequests.set(callId, entry);
    }

    /**
     * Send a request to Dart and await response
     */
    async sendRequest<T = any>(method: string, params: any = {}, options?: { timeoutMs?: number }): Promise<T> {
        if (!this.process || !this.process.stdin) {
            throw new Error('Bridge not started');
        }

        const id = `js-${this.messageId++}`;
        const timeoutMs = options?.timeoutMs ?? this.defaultRequestTimeoutMs;
        const message: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
            timeoutMs
        };

        if (BridgeLogging.debugTraceLogging) {
            bridgeLogTrace(`Raw to Dart: ${JSON.stringify(message)}`, DartBridgeClient.outputChannel);
        } else {
            DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] INFO → Request: ${method} (id: ${id})`);
        }
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            this.pendingRequests.set(id, { resolve, reject, timer: undefined, method, timeoutMs, startedAt });

            this.bumpPendingTimeout(id, 0);

            if (!this.pendingRequests.has(id)) {
                return;
            }

            const json = JSON.stringify(message) + '\n';
            try {
                this.process!.stdin!.write(json, (err) => {
                    if (err) {
                        const pending = this.pendingRequests.get(id);
                        if (pending?.timer) {
                            clearTimeout(pending.timer);
                        }
                        this.pendingRequests.delete(id);
                        reject(err);
                    }
                });
            } catch (err: any) {
                const pending = this.pendingRequests.get(id);
                if (pending?.timer) {
                    clearTimeout(pending.timer);
                }
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }

    /**
     * Send a notification to Dart (no response expected)
     */
    sendNotification(method: string, params: any = {}): void {
        if (!this.process || !this.process.stdin) {
            return;
        }

        const message: JsonRpcNotification = {
            jsonrpc: '2.0',
            method,
            params
        };

        if (BridgeLogging.debugTraceLogging) {
            bridgeLogTrace(`→ Sending notification to Dart: ${method}`, DartBridgeClient.outputChannel);
            bridgeLogTrace(`  Params: ${JSON.stringify(params, null, 2)}`, DartBridgeClient.outputChannel);
        } else {
            DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] INFO → Notification: ${method}`);
        }

        const json = JSON.stringify(message) + '\n';
        this.process.stdin.write(json);
    }

    /**
     * Handle incoming message from Dart
     */
    private handleMessage(line: string): void {
        // Check if the message looks like JSON (starts with { and ends with }). Line is trimmed already.
        const trimmed = line; 
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
            // Not JSON, output as-is to the output channel
            DartBridgeClient.outputChannel.appendLine(`[VS Code Bridge M] INFO  ${trimmed}`);
            return;
        }

        try {
            const message = JSON.parse(line);

            // Prefer request handling when method is present; raw logging above is sufficient.
            if (message.method) {
                this.handleDartRequest(message.method, message.params, message.id, message?.scriptName, message.callId, message.timeoutMs);
                return;
            }

            // Otherwise treat as response (no extra logging beyond raw line)
            if (message.id !== undefined) {
                if (BridgeLogging.debugLogging) {
                    bridgeLog(`Received response from Dart ${JSON.stringify(message)}`, DartBridgeClient.outputChannel);
                } else {
                    DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] INFO ← Response id: ${message.id} (${truncate(JSON.stringify(message.result ?? message.error ?? ''), 100)})`);
                }
                const responseId = message.id.toString();
                const pending = this.pendingRequests.get(responseId);
                if (pending) {
                    this.pendingRequests.delete(responseId);
                    if (pending.timer) {
                        clearTimeout(pending.timer);
                    }

                    if (message.error) {
                        const errMessage = typeof message.error === 'string'
                            ? message.error
                            : message.error?.message || 'Unknown error';
                        const errData = message.error?.data ? ` | data: ${JSON.stringify(message.error.data)}` : '';
                        pending.reject(new Error(`${errMessage}${errData}`));
                    } else {
                        pending.resolve(message.result);
                    }
                } else {
                    bridgeLog(`No pending handler for response id ${responseId}`, DartBridgeClient.outputChannel, 'ERROR');
                }
                return;
            }
        } catch (error) {
            // Failed to parse even though it looked like JSON, output the original line
            bridgeLog(`Parse error for incoming Dart line: ${error}`, DartBridgeClient.outputChannel, 'ERROR');
            DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] ERROR Parse Error: ${trimmed}`);
        }
    }

    /**
     * Handle a request from Dart
     */
    private async handleDartRequest(method: string, params: any, id?: string | number, scriptName?: string, callId?: string, timeoutMs?: number): Promise<void> {
        const startedAt = Date.now();
        // Always log callId/timeoutMs for debugging timeout issues
        DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO handleDartRequest: method=${method}, callId=${callId ?? 'NONE'}, timeoutMs=${timeoutMs ?? 'NONE'}`);
        try {
            if (callId && timeoutMs !== undefined) {
                this.bumpPendingTimeout(callId, timeoutMs);
            }

            let result: any;

            switch (method) {
                // VS Code Extension commands (Vce suffix) - executed directly in VS Code
                case 'logVce':
                    DartBridgeClient.outputChannel.appendLine(`[VS Code Bridge LM] ${params.message}`);
                    return; // No response needed for logs

                case 'showInfoVce':
                    vscode.window.showInformationMessage(params.message);
                    result = { success: true };
                    break;

                case 'showErrorVce':
                    vscode.window.showErrorMessage(params.message);
                    result = { success: true };
                    break;

                case 'showWarningVce':
                    vscode.window.showWarningMessage(params.message);
                    result = { success: true };
                    break;

                case 'askCopilotVce':
                    result = await this.askCopilot(params.prompt);
                    break;

                case 'readFileVce':
                    result = await this.readFile(params.path);
                    break;

                case 'writeFileVce':
                    await this.writeFile(params.path, params.content);
                    result = { success: true };
                    break;

                case 'openFileVce':
                    await this.openFile(params.path);
                    result = { success: true };
                    break;

                case 'executeFileVce':
                    result = await this.executeFile(params.filePath, params.params || {});
                    break;

                case 'executeScriptVce':
                    result = await this.executeScript(params.script, params.params || {}, scriptName);
                    break;

                case 'sendToChatVce':
                    result = await this.sendToChat(params.prompt);
                    break;

                // Local LLM / Prompt Expander bridge API
                case 'localLlm.getProfilesVce':
                case 'localLlm.getModelsVce':
                case 'localLlm.updateProfileVce':
                case 'localLlm.removeProfileVce':
                case 'localLlm.updateModelVce':
                case 'localLlm.removeModelVce':
                case 'localLlm.processVce': {
                    const mgr = getPromptExpanderManager();
                    if (!mgr) {
                        throw new Error('Prompt Expander manager not initialized');
                    }
                    result = await mgr.handleBridgeRequest(method, params);
                    break;
                }

                // Bot Conversation bridge API
                case 'botConversation.getConfigVce':
                case 'botConversation.getProfilesVce':
                case 'botConversation.startVce':
                case 'botConversation.stopVce':
                case 'botConversation.haltVce':
                case 'botConversation.continueVce':
                case 'botConversation.addInfoVce':
                case 'botConversation.statusVce':
                case 'botConversation.getLogVce':
                case 'botConversation.singleTurnVce': {
                    const botMgr = getBotConversationManager();
                    if (!botMgr) {
                        throw new Error('Bot Conversation manager not initialized');
                    }
                    result = await botMgr.handleBridgeRequest(method, params);
                    break;
                }

                default:
                    throw new Error(`Unknown method: ${method}`);
            }

            if (id !== undefined) {
                this.sendResponse(id, result);
            }
        } catch (error: any) {
            // Always log errors regardless of debug settings
            DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] ERROR Error handling request ${method}: ${error.message}`);
            if (BridgeLogging.debugLogging) {
                bridgeLog(`Stack: ${error.stack}`, DartBridgeClient.outputChannel, 'ERROR');
            }
            if (id !== undefined) {
                this.sendErrorResponse(id, error.message);
            }
        } finally {
            if (callId && timeoutMs !== undefined) {
                const elapsedMs = Date.now() - startedAt;
                const delta = -(timeoutMs - elapsedMs);
                this.bumpPendingTimeout(callId, delta);
            }
        }
    }

    /**
     * Send a response to a Dart request
     */
    private sendResponse(id: string | number, result: any): void {
        if (!this.process || !this.process.stdin) {
            return;
        }

        if (BridgeLogging.debugLogging) {
            bridgeLog(`→ Sending response to Dart (id: ${id})`, DartBridgeClient.outputChannel);
            bridgeLog(`  Result: ${JSON.stringify(result, null, 2)}`, DartBridgeClient.outputChannel);
        } else {
            DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] INFO ← Sending response id: ${id} (${truncate(JSON.stringify(result ?? ''), 100)})`);
        }

        const message: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
            result
        };

        const json = JSON.stringify(message) + '\n';
        this.process.stdin.write(json);
    }

    /**
     * Send an error response to a Dart request
     */
    private sendErrorResponse(id: string | number, error: string): void {
        if (!this.process || !this.process.stdin) {
            return;
        }

        if (BridgeLogging.debugLogging) {
            bridgeLog(`→ Sending error response to Dart (id: ${id})`, DartBridgeClient.outputChannel);
            bridgeLog(`  Error: ${error}`, DartBridgeClient.outputChannel);
        } else {
            DartBridgeClient.outputChannel?.appendLine(`[VS Code Extension] INFO ← Sending error response id: ${id} (${truncate(error, 100)})`);
        }

        const message: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
            error: { message: error }
        };

        const json = JSON.stringify(message) + '\n';
        this.process.stdin.write(json);
    }

    // ===================================================================
    // VS Code API implementations
    // ===================================================================

    private async askCopilot(prompt: string): Promise<string> {
        try {
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4'
            });

            if (models.length === 0) {
                throw new Error('No Copilot model available');
            }

            const model = models[0];
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let result = '';
            for await (const chunk of response.text) {
                result += chunk;
            }

            return result;
        } catch (error: any) {
            throw new Error(`Copilot request failed: ${error.message}`);
        }
    }

    private async readFile(filePath: string): Promise<string> {
        const uri = vscode.Uri.file(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(content).toString('utf8');
    }

    private async writeFile(filePath: string, content: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const buffer = Buffer.from(content, 'utf8');
        await vscode.workspace.fs.writeFile(uri, buffer);
    }

    private async openFile(filePath: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
    }

    /**
     * Execute a JavaScript file on this (TypeScript) side with context access
     * 
     * The file must export a function (default, execute, or direct export)
     * Function signature: (params: any, context: ExecutionContext) => Promise<any> | any
     * 
     * ExecutionContext includes: { vscode, bridge, require, console }
     */
    private async executeFile(filePath: string, params: any = {}): Promise<any> {
        DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Executing file: ${filePath}`);
        bridgeLog(`→ executeFile: ${filePath} with params: ${JSON.stringify(params, null, 2)}`, DartBridgeClient.outputChannel);

        try {
            // Clear require cache to allow re-execution
            delete require.cache[require.resolve(filePath)];
            
            // Create execution context
            const context = {
                vscode: vscode,
                bridge: this,
                require: require,
                console: console
            };
            
            // Load the module
            const module = require(filePath);
            
            // The module should export a function: default, execute, or direct export
            const executeFunc = module.default || module.execute || module;
            
            if (typeof executeFunc !== 'function') {
                throw new Error('Module must export a function (default, execute, or direct export)');
            }
            
            // Execute with params and context
            const result = await Promise.resolve(executeFunc(params, context));
            bridgeLog(`← executeFile success: ${filePath}`, DartBridgeClient.outputChannel);
            
            return {
                filePath,
                success: true,
                result: result
            };
        } catch (error: any) {
            bridgeLog(`executeFile error: ${error.message}`, DartBridgeClient.outputChannel, 'ERROR');
            return {
                filePath,
                success: false,
                error: error.message,
                stack: error.stack
            };
        }
    }

    /**
     * Execute a JavaScript script with context access
     * 
     * Script has access to: params (request parameters) and context object
     * Context includes: { vscode, bridge, require, console }
     * 
     * Example script:
     * ```javascript
     * const files = await context.vscode.workspace.findFiles('**\/*.ts');
     * return { fileCount: files.length, params: params };
     * ```
     */
    private async executeScript(script: string, params: any = {}, scriptName?: string): Promise<any> {
        DartBridgeClient.outputChannel.appendLine(`[VS Code Extension] INFO Executing script ${scriptName} (${script.length} chars) ${JSON.stringify(params, null, 2)}`);

        try {
            // Create a custom console that logs to our output channel
            const outputChannel = DartBridgeClient.outputChannel;
            const customConsole = {
                log: (...args: any[]) => outputChannel.appendLine(`[Script Console] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
                error: (...args: any[]) => outputChannel.appendLine(`[Script Console ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
                warn: (...args: any[]) => outputChannel.appendLine(`[Script Console WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
                info: (...args: any[]) => outputChannel.appendLine(`[Script Console INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`),
            };

            // Create execution context
            const context = {
                vscode: vscode,
                bridge: this,
                require: require,
                console: customConsole
            };
            
            // Create async function with params and context
            const asyncFunction = Object.getPrototypeOf(async function(){}).constructor as any;
            const fn = new asyncFunction('params', 'context', script);
            
            // Execute the script
            const result = await fn(params, context);

            bridgeLog(`← executeScript success`, DartBridgeClient.outputChannel);

            return {
                success: true,
                result: result
            };
        } catch (error: any) {
            bridgeLog(`executeScript error: ${error.message}`, DartBridgeClient.outputChannel, 'ERROR');
            bridgeLog(`  Stack: ${error.stack}`, DartBridgeClient.outputChannel);
            return {
                success: false,
                error: error.message,
                stack: error.stack
            };
        }
    }

    /**
     * Send a prompt to Copilot Chat
     */
    private async sendToChat(prompt: string): Promise<any> {
        bridgeLog(`→ sendToChat: ${prompt}`, DartBridgeClient.outputChannel);

        try {
            // Use the VS Code chat API to send the prompt
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: prompt
            });

            bridgeLog(`← sendToChat success`, DartBridgeClient.outputChannel);
            return { success: true };
        } catch (error: any) {
            bridgeLog(`sendToChat error: ${error.message}`, DartBridgeClient.outputChannel, 'ERROR');
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Keep the old VSCodeBridge class for compatibility
export class VSCodeBridge {
    constructor(private context: vscode.ExtensionContext) {}

    getWorkspaceRoot(): string | undefined {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri) {
            const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
            if (activeWorkspaceFolder) {
                return activeWorkspaceFolder.uri.fsPath;
            }
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }
        return workspaceFolders[0].uri.fsPath;
    }

    async readFile(filePath: string): Promise<string> {
        const uri = vscode.Uri.file(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(content).toString('utf8');
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const buffer = Buffer.from(content, 'utf8');

        const dir = path.dirname(filePath);
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        } catch (e) {
            // Directory might already exist
        }

        await vscode.workspace.fs.writeFile(uri, buffer);
    }

    async openFile(filePath: string): Promise<void> {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
    }

    showInfo(message: string): void {
        vscode.window.showInformationMessage(message);
    }

    showError(message: string): void {
        vscode.window.showErrorMessage(message);
    }

    showWarning(message: string): void {
        vscode.window.showWarningMessage(message);
    }

    async askCopilot(prompt: string): Promise<string> {
        try {
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4'
            });

            if (models.length === 0) {
                throw new Error('No Copilot model available');
            }

            const model = models[0];
            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            let result = '';
            for await (const chunk of response.text) {
                result += chunk;
            }

            return result;
        } catch (error: any) {
            throw new Error(`Copilot request failed: ${error.message}`);
        }
    }

    async showQuickPick(items: string[], placeholder: string): Promise<string | undefined> {
        return await vscode.window.showQuickPick(items, {
            placeHolder: placeholder,
            canPickMany: false
        });
    }

    async showInputBox(prompt: string, defaultValue?: string): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: prompt,
            value: defaultValue,
            placeHolder: 'Enter value...'
        });
    }

    async listFiles(directoryPath: string): Promise<string[]> {
        const uri = vscode.Uri.file(directoryPath);
        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            return entries.map(([name, _]) => name);
        } catch (error) {
            return [];
        }
    }

    async fileExists(filePath: string): Promise<boolean> {
        const uri = vscode.Uri.file(filePath);
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    getWorkspaceInfo(): any {
        const workspaceRoot = this.getWorkspaceRoot();
        const workspaceFolders = vscode.workspace.workspaceFolders;

        return {
            root: workspaceRoot,
            name: workspaceFolders?.[0]?.name,
            folders: workspaceFolders?.map(f => ({
                name: f.name,
                path: f.uri.fsPath
            })) || []
        };
    }
}

export function createVSCodeBridgeDefinition(bridge: VSCodeBridge): any {
    return bridge; // For compatibility
}
