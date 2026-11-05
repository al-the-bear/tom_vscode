/**
 * VS Code Language Model Tool registration: every shared tool
 * (tool-executors.ts) registered as a `vscode.LanguageModelTool`, so Copilot
 * Chat and the VS Code LM transport can call them.
 */

import * as vscode from 'vscode';
import { toVsCodeTool } from './shared-tool-registry';
import { ALL_SHARED_TOOLS } from './tool-executors';

/** Register every shared tool with VS Code's language-model tool registry. */
export function registerVsCodeLmTools(context: vscode.ExtensionContext): void {
    for (const tool of ALL_SHARED_TOOLS) {
        context.subscriptions.push(
            vscode.lm.registerTool(tool.name, toVsCodeTool(tool)),
        );
    }
}
