/**
 * "Send to LLM": sends the editor's text to the @CHAT Anthropic panel's current
 * profile and session, as if it had been typed there (src/handlers/sendToChatRouter.ts
 * runAnthropicSend). The profile may run on an Anthropic or a Local LLM
 * configuration. Three variants, as for Copilot:
 *
 *   - `tomAi.sendToLlm`           the selection, with the default user-message template;
 *   - `tomAi.sendToLlm.standard`  the selection or the whole file, with the default template;
 *   - `tomAi.sendToLlm.template`  the selection or the whole file, with a picked template.
 *
 * Reached from the editor context menu and the Ctrl+Shift+L chord menu.
 */

import * as vscode from 'vscode';

import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { llmSendText, llmTemplateChoices, type LlmSendTextMode } from '../utils/sendToLlm';
import { dispatchToLlm } from './sendToChatRouter';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';

export const SEND_TO_LLM_COMMANDS = {
    plain: 'tomAi.sendToLlm',
    standard: 'tomAi.sendToLlm.standard',
    template: 'tomAi.sendToLlm.template',
} as const;

/** The active editor's text for this variant, or undefined after telling the user why there is none. */
function editorText(mode: LlmSendTextMode): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor.');
        return undefined;
    }
    const picked = llmSendText(editor.document.getText(editor.selection), editor.document.getText(), mode);
    if ('error' in picked) {
        vscode.window.showErrorMessage(picked.error);
        return undefined;
    }
    return picked.text;
}

/** Let the user pick a user-message template; undefined when there is none or the pick was cancelled. */
async function pickTemplate(context: vscode.ExtensionContext): Promise<string | undefined> {
    const choices = llmTemplateChoices(loadSendToChatConfig()?.anthropic?.userMessageTemplates);
    if (choices.length === 0) {
        const action = await vscode.window.showWarningMessage(
            'No prompt templates configured. Open the template editor to add one?',
            'Open Template Editor',
            'Cancel',
        );
        if (action === 'Open Template Editor') {
            openGlobalTemplateEditor(context, { category: 'anthropicUserMessage' });
        }
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        choices.map((c) => ({
            label: c.label,
            description: c.isDefault ? 'default' : undefined,
            detail: c.template.substring(0, 80).replace(/\n/g, ' '),
            template: c.template,
        })),
        { title: 'Send to LLM', placeHolder: 'Select a template to send with' },
    );
    return picked?.template;
}

export function registerSendToLlmCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(SEND_TO_LLM_COMMANDS.plain, async () => {
            const text = editorText('selection');
            if (text !== undefined) { await dispatchToLlm(context, text); }
        }),
        vscode.commands.registerCommand(SEND_TO_LLM_COMMANDS.standard, async () => {
            const text = editorText('selectionOrDocument');
            if (text !== undefined) { await dispatchToLlm(context, text); }
        }),
        vscode.commands.registerCommand(SEND_TO_LLM_COMMANDS.template, async () => {
            const text = editorText('selectionOrDocument');
            if (text === undefined) { return; }
            const template = await pickTemplate(context);
            if (template !== undefined) { await dispatchToLlm(context, text, template); }
        }),
    );
}
