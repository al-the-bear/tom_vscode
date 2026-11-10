/**
 * Handler for the tomAi.sendToCopilot command: the selected text of the active
 * editor into Copilot Chat. No answer handling here: the menu / command paths
 * are fire-and-forget. The ANTHROPIC/LLM panel has its own commands, Send to
 * LLM (sendToLlm-handler.ts).
 */

import * as vscode from 'vscode';
import { handleError } from './handler_shared';
import { openCopilotChat } from './sendToChatRouter';

/**
 * Send the selected text to Copilot Chat.
 */
export async function sendToChatHandler(context: vscode.ExtensionContext): Promise<void> {
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

        await openCopilotChat(selectedText);

    } catch (error) {
        handleError('Failed to send to chat', error);
    }
}
