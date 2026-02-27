/**
 * Handler for tomAi.sendToCopilot command.
 * 
 * Sends selected text from the active editor to Copilot Chat.
 */

import * as vscode from 'vscode';
import { handleError } from './handler_shared';

/**
 * Send selected text to Copilot Chat
 */
export async function sendToChatHandler(): Promise<void> {
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showErrorMessage('No text selected');
            return;
        }

        const selectedText = editor.document.getText(selection);

        // Open chat view and send the selected text
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: selectedText
        });

    } catch (error) {
        handleError('Failed to send to chat', error);
    }
}
