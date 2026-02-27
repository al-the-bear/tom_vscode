/**
 * Handler for printing Tom AI configuration.
 * 
 * Provides a command to print the detailed D4rt interpreter configuration
 * to the output channel, including all classes, methods, and constructors.
 */

import * as vscode from 'vscode';
import { getBridgeClient, bridgeLog } from './handler_shared';

/**
 * Response from printConfiguration command
 */
interface PrintConfigurationResponse {
    success: boolean;
    message: string;
}

/**
 * Print the detailed D4rt configuration to the output channel.
 * 
 * This command sends a request to the bridge to print the complete
 * interpreter configuration including all imports, classes, methods,
 * constructors, global variables, and getters.
 */
export async function printConfigurationHandler(): Promise<void> {
    const bridgeClient = getBridgeClient();
    if (!bridgeClient) {
        vscode.window.showErrorMessage('VS Code Bridge is not running. Please restart the bridge first.');
        return;
    }

    try {
        const response = await bridgeClient.sendRequest<PrintConfigurationResponse>('printConfiguration');

        if (response.success) {
            vscode.window.showInformationMessage('D4rt configuration printed to Tom AI output channel');
            bridgeLog('Configuration printed - check VS Code Bridge output for details');
        } else {
            vscode.window.showWarningMessage('Failed to print configuration');
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bridgeLog(`Failed to print configuration: ${message}`, 'ERROR');
        vscode.window.showErrorMessage(`Failed to print configuration: ${message}`);
    }
}
