/**
 * Add, edit and delete a prompt template from an editor's template
 * dropdown (queue editor, timed requests editor). There is one template
 * store, the user-message templates (`anthropic.userMessageTemplates`,
 * src/utils/copilotTemplates.ts); adding and editing open it in the
 * global template editor.
 */

import * as vscode from 'vscode';
import { loadSendToChatConfig, saveSendToChatConfig } from '../utils/sendToChatConfig';
import { userMessageTemplateOptions } from '../utils/copilotTemplates';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';

/** The template to act on: `currentId` when it is one, else the user's pick. */
async function pickUserMessageTemplate(currentId: string | undefined, placeHolder: string): Promise<string | undefined> {
    const options = userMessageTemplateOptions(loadSendToChatConfig());
    if (options.length === 0) {
        vscode.window.showWarningMessage('No prompt templates available.');
        return undefined;
    }
    if (currentId && options.some((o) => o.id === currentId)) { return currentId; }
    const picked = await vscode.window.showQuickPick(
        options.map((o) => ({ label: o.label, description: o.label === o.id ? undefined : o.id, id: o.id })),
        { placeHolder },
    );
    return picked?.id;
}

export function addUserMessageTemplate(ctx: vscode.ExtensionContext | undefined): void {
    if (ctx) { openGlobalTemplateEditor(ctx, { category: 'anthropicUserMessage' }); }
}

export async function editUserMessageTemplate(ctx: vscode.ExtensionContext | undefined, currentId?: string): Promise<void> {
    const id = await pickUserMessageTemplate(currentId, 'Select template to edit');
    if (id && ctx) { openGlobalTemplateEditor(ctx, { category: 'anthropicUserMessage', itemId: id }); }
}

export async function deleteUserMessageTemplate(currentId?: string): Promise<void> {
    const id = await pickUserMessageTemplate(currentId, 'Select template to delete');
    if (!id) { return; }
    const answer = await vscode.window.showWarningMessage(`Delete prompt template "${id}"?`, { modal: true }, 'Delete');
    if (answer !== 'Delete') { return; }
    const config = loadSendToChatConfig();
    if (!config?.anthropic?.userMessageTemplates) { return; }
    config.anthropic.userMessageTemplates = config.anthropic.userMessageTemplates.filter((t) => t.id !== id);
    saveSendToChatConfig(config);
}
