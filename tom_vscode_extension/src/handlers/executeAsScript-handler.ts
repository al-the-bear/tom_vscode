/**
 * Handler for tomAi.executeScript command.
 * 
 * Executes a Dart file as an inline script using the executeScript method.
 * Supports executing either the full file or just the selected text.
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
 * Execute Dart file as inline script using executeScript method
 */
export async function executeAsScriptHandler(
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

        // Determine script content: use selection if called from editor, otherwise full file
        let script: string;
        let scriptSource: string;

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.fsPath === filePath && !activeEditor.selection.isEmpty) {
            // Called from editor with selection - use selected text
            script = activeEditor.document.getText(activeEditor.selection);
            scriptSource = 'selection';
        } else {
            // Called from explorer or editor without selection - use full file
            script = fs.readFileSync(filePath, 'utf8');
            scriptSource = 'file';
        }

        const fileName = path.basename(filePath);

        // Parse timeout from script's first line comment: // @timeout: <seconds>
        // Default to 2 hours (7200 seconds) for long-running scripts like askCopilotChat
        const timeoutMatch = script.match(/^\/\/\s*@timeout:\s*(\d+)/m);
        const timeoutSeconds = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 7200;
        const timeoutMs = timeoutSeconds * 1000;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Executing ${fileName} as script in D4rt`,
                cancellable: false
            },
            async (progress) => {
                // Ensure bridge is running
                const bridgeClient = await ensureBridgeRunning(context, false);
                if (!bridgeClient) {
                    progress.report({ message: 'Starting bridge...' });
                    vscode.window.showErrorMessage('Failed to start Dart bridge');
                    return;
                }

                progress.report({ message: 'Executing script...' });

                // Execute as inline script with basePath for file exports
                const basePath = path.dirname(filePath);
                const result = await bridgeClient.sendRequest('executeScriptVcb', {
                    script: script,
                    basePath: basePath,
                    params: {
                        workspaceRoot: getWorkspaceRoot() || '',
                        fileName: fileName,
                        executedBy: 'vscode-context-menu',
                        scriptSource: scriptSource
                    }
                }, { timeoutMs: timeoutMs });

                progress.report({ message: `Complete! ${JSON.stringify(result)}` });

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
                    vscode.window.showInformationMessage(`✅ ${fileName} executed as script successfully!`);
                } else {
                    vscode.window.showErrorMessage(`❌ Script execution failed: ${result.error || 'Unknown error'}`);
                }
            }
        );

    } catch (error) {
        handleError('Failed to execute Dart script', error);
    }
}
