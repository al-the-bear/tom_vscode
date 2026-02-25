/**
 * Handler for dartscript.executeFile command.
 * 
 * Executes a Dart file using the executeFile method (loads file with execute() function).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    handleError,
    getFilePath,
    validateDartFile,
    ensureBridgeRunning,
    getWorkspaceRoot,
    getLanguageFromFilename
} from './handler_shared';

/**
 * Execute Dart file using executeFile method (loads file with execute() function)
 */
export async function executeInTomAiBuildHandler(
    uri: vscode.Uri | undefined,
    context: vscode.ExtensionContext
): Promise<void> {
    try {
        // Get file path
        const filePath = getFilePath(uri);
        if (!filePath) {
            vscode.window.showErrorMessage('No Dart file selected');
            return;
        }

        // Validate the file
        const validation = validateDartFile(filePath);
        if (!validation.valid) {
            vscode.window.showErrorMessage(validation.error!);
            return;
        }

        const fileName = path.basename(filePath);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Executing ${fileName} in DartScript`,
                cancellable: false
            },
            async (progress) => {
                progress.report({ message: 'Starting bridge...' });

                // Ensure bridge is running
                const bridgeClient = await ensureBridgeRunning(context, false);
                if (!bridgeClient) {
                    vscode.window.showErrorMessage('Failed to start Dart bridge');
                    return;
                }

                progress.report({ message: 'Executing file...' });

                // Execute the file using executeFileVcb (expects execute() function in the file)
                const result = await bridgeClient.sendRequest('executeFileVcb', {
                    filePath: filePath,
                    params: {
                        workspaceRoot: getWorkspaceRoot() || '',
                        executedBy: 'vscode-context-menu'
                    }
                });

                progress.report({ message: 'Complete!' });

                // Show result
                if (result.success) {
                    // Check if result wants to show a document
                    if (result.result?.action === 'showDocument' && result.result?.content && result.result?.filename) {
                        const doc = await vscode.workspace.openTextDocument({
                            content: result.result.content,
                            language: getLanguageFromFilename(result.result.filename)
                        });
                        await vscode.window.showTextDocument(doc);
                    }
                    vscode.window.showInformationMessage(`✅ ${fileName} executed successfully!`);
                } else {
                    vscode.window.showErrorMessage(`❌ Execution failed: ${result.error || 'Unknown error'}`);
                }
            }
        );

    } catch (error) {
        handleError('Failed to execute Dart file', error);
    }
}
