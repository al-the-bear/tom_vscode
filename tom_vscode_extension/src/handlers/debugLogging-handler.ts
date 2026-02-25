/**
 * Handler for Bridge Debug Logging commands.
 * 
 * Provides commands to toggle debug logging in the VS Code Bridge.
 */

import * as vscode from 'vscode';
import { getBridgeClient, bridgeLog } from './handler_shared';

/**
 * Response from debug logging commands
 */
interface DebugLoggingResponse {
    success?: boolean;
    debugLogging: boolean;
    debugTraceLogging: boolean;
}

/** Current debug logging state (cached) */
let debugLoggingEnabled = false;

/**
 * Toggle debug logging in the VS Code Bridge
 */
export async function toggleBridgeDebugLoggingHandler(): Promise<void> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        vscode.window.showErrorMessage('VS Code Bridge is not running. Please restart the bridge first.');
        return;
    }

    try {
        // Toggle the state
        const newState = !debugLoggingEnabled;

        const response = await bridgeClient.sendRequest<DebugLoggingResponse>('setDebugLogging', {
            enabled: newState
        });

        debugLoggingEnabled = response.debugLogging;

        const status = debugLoggingEnabled ? 'enabled' : 'disabled';
        vscode.window.showInformationMessage(`Bridge debug logging ${status}`);
        bridgeLog(`Bridge debug logging ${status}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`Failed to toggle debug logging: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`Failed to toggle debug logging: ${message}`);
    }
}

/**
 * Get current debug logging status from the bridge
 */
export async function getDebugLoggingStatus(): Promise<boolean> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        return false;
    }

    try {
        const response = await bridgeClient.sendRequest<DebugLoggingResponse>('getDebugLogging');
        debugLoggingEnabled = response.debugLogging;
        return debugLoggingEnabled;
    } catch {
        return false;
    }
}
