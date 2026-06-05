/**
 * Handler for tomAi.sendToCopilot command.
 *
 * Sends selected text from the active editor to the configured chat target
 * (Copilot or Anthropic — see `sendToChatTarget`). No answer handling here:
 * the menu/command paths are fire-and-forget.
 */

import * as vscode from 'vscode';
import { handleError } from './handler_shared';
import { dispatchSendToChat } from './sendToChatRouter';

/**
 * Send selected text to the configured chat target.
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

        // Route to Copilot or Anthropic per the configured target.
        await dispatchSendToChat(context, selectedText);

    } catch (error) {
        handleError('Failed to send to chat', error);
    }
}
