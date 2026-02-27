/**
 * Handler for tomAi.reloadWindowWithBridgeNotification command.
 * 
 * Reloads the VS Code window after notifying the bridge to save state
 * and stopping the bridge process to ensure clean shutdown.
 */

import * as vscode from 'vscode';
import {
    handleError,
    bridgeLog,
    getBridgeClient
} from './handler_shared';

/**
 * Reload VS Code window with bridge notification.
 * This notifies the bridge before reloading, stops the bridge process,
 * and then reloads the window.
 */
export async function reloadWindowHandler(): Promise<void> {
    try {
        bridgeLog('Reload initiated - notifying and stopping bridge...');

        const bridgeClient = getBridgeClient();

        // Notify bridge about impending reload and stop it
        if (bridgeClient && bridgeClient.isRunning()) {
            try {
                // Send notification with timeout
                await Promise.race([
                    bridgeClient.sendRequest('notifyReload', {}),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Notification timeout')), 1000)
                    )
                ]);
                bridgeLog('Bridge notified successfully');
            } catch (error) {
                bridgeLog(`Bridge notification failed (continuing anyway): ${error}`, 'ERROR');
            }

            // Stop the bridge process to ensure clean shutdown
            try {
                bridgeClient.stop();
                bridgeLog('Bridge process stopped');
            } catch (error) {
                bridgeLog(`Failed to stop bridge (continuing anyway): ${error}`, 'ERROR');
            }
        }

        // Execute the actual reload
        await vscode.commands.executeCommand('workbench.action.reloadWindow');

    } catch (error) {
        handleError('Failed to reload window', error);
    }
}
