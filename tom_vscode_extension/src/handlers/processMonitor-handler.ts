/**
 * Handler for Process Monitor commands.
 * 
 * Provides commands to start the Tom Process Monitor via the VS Code Bridge.
 * The Process Monitor manages the watcher twin and ledger server.
 */

import * as vscode from 'vscode';
import { getBridgeClient, bridgeLog } from './handler_shared';

/**
 * Response from Process Monitor start command
 */
interface ProcessMonitorResponse {
    success: boolean;
    message: string;
    processMonitor?: { alive: boolean; pid?: number };
    watcher?: { alive: boolean; pid?: number };
    ledgerServer?: { alive: boolean; pid?: number };
    error?: string;
}

/**
 * Start the Tom Process Monitor and verify all related processes are running
 */
export async function startProcessMonitorHandler(): Promise<void> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        vscode.window.showErrorMessage('VS Code Bridge is not running. Please restart the bridge first.');
        return;
    }

    try {
        vscode.window.showInformationMessage('Starting Tom Process Monitor...');

        const response = await bridgeClient.sendRequest<ProcessMonitorResponse>('startProcessMonitor');

        if (response.success) {
            const pm = response.processMonitor?.alive ? '✅' : '❌';
            const watcher = response.watcher?.alive ? '✅' : '❌';
            const ledger = response.ledgerServer?.alive ? '✅' : '❌';
            
            const statusMessage = `Process Monitor: ${pm}, Watcher: ${watcher}, Ledger Server: ${ledger}`;
            
            if (response.processMonitor?.alive && response.watcher?.alive && response.ledgerServer?.alive) {
                vscode.window.showInformationMessage(`Tom Process Monitor started. ${statusMessage}`);
            } else {
                vscode.window.showWarningMessage(`Tom Process Monitor partially started. ${statusMessage}`);
            }
            
            bridgeLog(`Process Monitor status: ${statusMessage}`);
        } else {
            vscode.window.showErrorMessage(`Failed to start Process Monitor: ${response.message}`);
            bridgeLog(`Failed to start Process Monitor: ${response.message}`, 'ERROR');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`Failed to start Process Monitor: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`Failed to start Process Monitor: ${message}`);
    }
}
