import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const DEBUG_OUTPUT_CHANNEL_NAME = 'Tom Extension Debug Log';
const DEBUG_LOG_TO_CONSOLE = false;
const DEBUG_LOG_TO_FILE = false;
const DEBUG_LOG_FILE_NAME = 'tom_extension_debug.log';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

let debugOutputChannel: vscode.OutputChannel | undefined;
let consolePatched = false;

const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug ? console.debug.bind(console) : console.log.bind(console)),
};

function getWorkspaceRoot(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (activeWorkspaceFolder) {
            return activeWorkspaceFolder.uri.fsPath;
        }
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function getDebugFilePath(): string | undefined {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) {
        return undefined;
    }
    return path.join(wsRoot, 'ztmp', DEBUG_LOG_FILE_NAME);
}

function ensureDebugOutputChannel(): vscode.OutputChannel {
    if (!debugOutputChannel) {
        debugOutputChannel = vscode.window.createOutputChannel(DEBUG_OUTPUT_CHANNEL_NAME);
    }
    return debugOutputChannel;
}

function formatArg(value: unknown): string {
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function writeToDebugFile(line: string): void {
    if (!DEBUG_LOG_TO_FILE) {
        return;
    }
    const filePath = getDebugFilePath();
    if (!filePath) {
        return;
    }
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.appendFileSync(filePath, `${line}\n`, 'utf-8');
    } catch {
        // Intentionally swallow to avoid recursive logging loops.
    }
}

export function debugLog(message: string, level: LogLevel = 'INFO', source?: string): void {
    const timestamp = new Date().toISOString();
    const sourceText = source ? `[${source}] ` : '';
    const line = `${timestamp} ${level} ${sourceText}${message}`;

    ensureDebugOutputChannel().appendLine(line);
    writeToDebugFile(line);

    if (DEBUG_LOG_TO_CONSOLE) {
        if (level === 'ERROR') {
            originalConsole.error(line);
        } else if (level === 'WARN') {
            originalConsole.warn(line);
        } else {
            originalConsole.log(line);
        }
    }
}

export function debugException(context: string, error: unknown, details?: Record<string, unknown>): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const detailText = details ? ` details=${JSON.stringify(details)}` : '';
    debugLog(`${context}: ${errorMessage}${detailText}`, 'ERROR', 'exception');

    if (error instanceof Error && error.stack) {
        debugLog(error.stack, 'ERROR', context);
    }
}

export function installConsoleDebugRouting(): void {
    if (consolePatched) {
        return;
    }
    consolePatched = true;

    console.log = (...args: unknown[]) => {
        debugLog(args.map(formatArg).join(' '), 'INFO', 'console.log');
        if (DEBUG_LOG_TO_CONSOLE) {
            originalConsole.log(...args);
        }
    };

    console.info = (...args: unknown[]) => {
        debugLog(args.map(formatArg).join(' '), 'INFO', 'console.info');
        if (DEBUG_LOG_TO_CONSOLE) {
            originalConsole.info(...args);
        }
    };

    console.warn = (...args: unknown[]) => {
        debugLog(args.map(formatArg).join(' '), 'WARN', 'console.warn');
        if (DEBUG_LOG_TO_CONSOLE) {
            originalConsole.warn(...args);
        }
    };

    console.error = (...args: unknown[]) => {
        debugLog(args.map(formatArg).join(' '), 'ERROR', 'console.error');
        if (DEBUG_LOG_TO_CONSOLE) {
            originalConsole.error(...args);
        }
    };

    console.debug = (...args: unknown[]) => {
        debugLog(args.map(formatArg).join(' '), 'DEBUG', 'console.debug');
        if (DEBUG_LOG_TO_CONSOLE) {
            originalConsole.debug(...args);
        }
    };

    debugLog('Console debug routing installed', 'INFO', 'debugLogger');
}

export function initializeDebugLogger(context: vscode.ExtensionContext): void {
    const channel = ensureDebugOutputChannel();
    context.subscriptions.push(channel);
}
