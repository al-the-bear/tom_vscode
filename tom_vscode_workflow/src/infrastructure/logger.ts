/**
 * TOM Tracker — Centralized Logging Infrastructure
 *
 * Provides a structured logging system with multiple output targets:
 * - VS Code Output Channel ("Tom Tracker Log" for regular, "Tom Tracker Debug Log" for debug)
 * - Console (always, as fallback)
 * - File (optional, for persistent debug trails)
 *
 * Usage:
 *   import { log, debug, error } from './infrastructure/logger';
 *   log('Extension activated');
 *   debug('Resolving webview provider', { viewId });
 *   error('Failed to load graph', err);
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Log Levels
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

// ============================================================================
// Logger Configuration
// ============================================================================

export interface LoggerConfig {
    /** Minimum level for output channel messages. Default: INFO */
    channelLevel: LogLevel;
    /** Minimum level for debug channel messages. Default: DEBUG */
    debugChannelLevel: LogLevel;
    /** Minimum level for console output. Default: DEBUG */
    consoleLevel: LogLevel;
    /** Optional file path for persistent log output. Null = disabled. */
    filePath: string | null;
    /** Minimum level for file output. Default: DEBUG */
    fileLevel: LogLevel;
    /** Maximum file size in bytes before rotation. Default: 5MB */
    maxFileSize: number;
    /** Whether to include timestamps. Default: true */
    timestamps: boolean;
}

const DEFAULT_CONFIG: LoggerConfig = {
    channelLevel: 'INFO',
    debugChannelLevel: 'DEBUG',
    consoleLevel: 'DEBUG',
    filePath: null,
    fileLevel: 'DEBUG',
    maxFileSize: 5 * 1024 * 1024,
    timestamps: true,
};

// ============================================================================
// Logger State
// ============================================================================

let logChannel: vscode.OutputChannel | null = null;
let debugLogChannel: vscode.OutputChannel | null = null;
let config: LoggerConfig = { ...DEFAULT_CONFIG };
let fileStream: fs.WriteStream | null = null;
let fileBytesWritten = 0;

// ============================================================================
// Initialization & Disposal
// ============================================================================

/**
 * Initialize the logging system. Call once during extension activation.
 * Creates the VS Code output channels and optionally opens a log file.
 */
export function initLogger(overrides?: Partial<LoggerConfig>): void {
    config = { ...DEFAULT_CONFIG, ...overrides };

    if (!logChannel) {
        logChannel = vscode.window.createOutputChannel('Tom Tracker Log');
    }
    if (!debugLogChannel) {
        debugLogChannel = vscode.window.createOutputChannel('Tom Tracker Debug Log');
    }

    if (config.filePath) {
        openLogFile(config.filePath);
    }
}

/**
 * Dispose all logging resources. Call during extension deactivation.
 */
export function disposeLogger(): void {
    closeLogFile();
    logChannel?.dispose();
    debugLogChannel?.dispose();
    logChannel = null;
    debugLogChannel = null;
}

/**
 * Update logger configuration at runtime.
 */
export function configureLogger(overrides: Partial<LoggerConfig>): void {
    const oldFilePath = config.filePath;
    config = { ...config, ...overrides };

    if (config.filePath !== oldFilePath) {
        closeLogFile();
        if (config.filePath) {
            openLogFile(config.filePath);
        }
    }
}

// ============================================================================
// Output Channel Access
// ============================================================================

/**
 * Get the regular log output channel ("Tom Tracker Log").
 */
export function getLogChannel(): vscode.OutputChannel | null {
    return logChannel;
}

/**
 * Get the debug log output channel ("Tom Tracker Debug Log").
 */
export function getDebugLogChannel(): vscode.OutputChannel | null {
    return debugLogChannel;
}

/**
 * Show the regular log output channel in the UI.
 */
export function showLog(): void {
    logChannel?.show(true);
}

/**
 * Show the debug log output channel in the UI.
 */
export function showDebugLog(): void {
    debugLogChannel?.show(true);
}

// ============================================================================
// Logging Functions
// ============================================================================

/**
 * Log a message at INFO level.
 * Goes to the regular "Tom Tracker Log" channel and console.
 */
export function log(message: string, ...args: unknown[]): void {
    writeLog('INFO', message, args);
}

/**
 * Log a message at DEBUG level.
 * Goes to the "Tom Tracker Debug Log" channel and console.
 * Useful for instrumentation, tracing, and development diagnostics.
 */
export function debug(message: string, ...args: unknown[]): void {
    writeLog('DEBUG', message, args);
}

/**
 * Log a message at WARN level.
 * Goes to both output channels and console.
 */
export function warn(message: string, ...args: unknown[]): void {
    writeLog('WARN', message, args);
}

/**
 * Log a message at ERROR level.
 * Goes to both output channels, console.error, and optional file.
 */
export function error(message: string, ...args: unknown[]): void {
    writeLog('ERROR', message, args);
}

// ============================================================================
// Internal Implementation
// ============================================================================

function formatMessage(level: LogLevel, message: string, args: unknown[]): string {
    const timestamp = config.timestamps ? `${new Date().toISOString()} ` : '';
    const suffix = args.length > 0 ? ` ${formatArgs(args)}` : '';
    return `${timestamp}[${level}] ${message}${suffix}`;
}

function formatArgs(args: unknown[]): string {
    return args.map(arg => {
        if (arg instanceof Error) {
            return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
        }
        if (typeof arg === 'object' && arg !== null) {
            try {
                const seen = new WeakSet();
                return JSON.stringify(arg, (_key, val) => {
                    if (typeof val === 'object' && val !== null) {
                        if (seen.has(val)) { return '[Circular]'; }
                        seen.add(val);
                    }
                    return val;
                });
            } catch {
                return String(arg);
            }
        }
        return String(arg);
    }).join(' ');
}

function shouldLog(messageLevel: LogLevel, targetLevel: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[messageLevel] >= LOG_LEVEL_PRIORITY[targetLevel];
}

function writeLog(level: LogLevel, message: string, args: unknown[]): void {
    const formatted = formatMessage(level, message, args);

    // Console output (always active as fallback)
    if (shouldLog(level, config.consoleLevel)) {
        if (level === 'ERROR') {
            console.error(`[TOM Tracker] ${formatted}`);
        } else if (level === 'WARN') {
            console.warn(`[TOM Tracker] ${formatted}`);
        } else {
            console.log(`[TOM Tracker] ${formatted}`);
        }
    }

    // Regular log channel — INFO, WARN, ERROR
    if (logChannel && shouldLog(level, config.channelLevel)) {
        logChannel.appendLine(formatted);
    }

    // Debug log channel — all levels including DEBUG
    if (debugLogChannel && shouldLog(level, config.debugChannelLevel)) {
        debugLogChannel.appendLine(formatted);
    }

    // File output
    if (fileStream && config.filePath && shouldLog(level, config.fileLevel)) {
        writeToFile(formatted);
    }
}

// ============================================================================
// File Logging
// ============================================================================

function openLogFile(filePath: string): void {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Check existing file size for rotation
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            fileBytesWritten = stat.size;

            if (fileBytesWritten >= config.maxFileSize) {
                rotateLogFile(filePath);
                fileBytesWritten = 0;
            }
        }

        fileStream = fs.createWriteStream(filePath, { flags: 'a' });
        fileStream.on('error', (err) => {
            console.error(`[TOM Tracker] Log file write error: ${err.message}`);
            closeLogFile();
        });
    } catch (err) {
        console.error(`[TOM Tracker] Failed to open log file: ${err}`);
        fileStream = null;
    }
}

function closeLogFile(): void {
    if (fileStream) {
        try {
            fileStream.end();
        } catch {
            // Ignore close errors
        }
        fileStream = null;
        fileBytesWritten = 0;
    }
}

function writeToFile(line: string): void {
    if (!fileStream || !config.filePath) {
        return;
    }

    const bytes = Buffer.byteLength(line + '\n', 'utf8');
    fileBytesWritten += bytes;

    if (fileBytesWritten >= config.maxFileSize) {
        closeLogFile();
        rotateLogFile(config.filePath);
        openLogFile(config.filePath);
    }

    fileStream?.write(line + '\n');
}

function rotateLogFile(filePath: string): void {
    try {
        const rotatedPath = `${filePath}.1`;
        if (fs.existsSync(rotatedPath)) {
            fs.unlinkSync(rotatedPath);
        }
        if (fs.existsSync(filePath)) {
            fs.renameSync(filePath, rotatedPath);
        }
    } catch (err) {
        console.error(`[TOM Tracker] Log rotation failed: ${err}`);
    }
}
