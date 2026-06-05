/**
 * Minimal-mode placeholder provider for all webview panels.
 *
 * When the extension runs without a .tom/ configuration folder, this provider
 * is registered for every declared webview view ID. Instead of showing a
 * forever-spinning loading indicator, each panel displays a friendly
 * "not a TOM AI workspace" message with setup instructions.
 *
 * Extends {@link BaseWebviewProvider} for the common webview boilerplate
 * (message routing, CSP nonce, base styles). Pilot adoption of the
 * shared base class — see Wave 2.4 of the review refactoring plan.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BaseWebviewProvider } from '../utils/baseWebviewProvider';
import { loadWebviewHtml } from '../utils/webviewLoader';

// All webview view IDs declared in package.json that need a provider in minimal mode
const MINIMAL_VIEW_IDS = [
    'tomAi.chatPanel',
    'tomAi.wsPanel',
    'tomAi.vscodeNotes',
    'tomAi.questNotes',
    'tomAi.questTodos',
    'tomAi.sessionTodos',
    'tomAi.todoLog',
    'tomAi.workspaceNotes',
    'tomAi.workspaceTodos',
];

class MinimalModeViewProvider extends BaseWebviewProvider {
    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        super();
        this.registerMessageHandler('openSetupDoc', async () => {
            await this._openSetupDoc();
        });
    }

    protected onResolve(webview: vscode.Webview): void {
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
            ],
        };
        webview.html = this._getHtml(webview);
    }

    private async _openSetupDoc(): Promise<void> {
        // Try to open the bundled workspace_setup.md via the markdown preview
        const docPath = path.join(this._extensionUri.fsPath, 'doc', 'workspace_setup.md');
        if (fs.existsSync(docPath)) {
            const doc = await vscode.workspace.openTextDocument(docPath);
            await vscode.window.showTextDocument(doc, { preview: true });
        } else {
            vscode.window.showInformationMessage(
                'Setup instructions: create a .tom/ folder in your workspace root, then reload the window.',
            );
        }
    }

    private _getHtml(webview: vscode.Webview): string {
        return loadWebviewHtml(webview, 'minimalMode');
    }
}

/**
 * Register placeholder webview providers for all panel view IDs in minimal mode.
 * This prevents the "loading" spinner from showing indefinitely.
 */
export function registerMinimalModePanels(context: vscode.ExtensionContext): void {
    const provider = new MinimalModeViewProvider(context.extensionUri);
    for (const viewId of MINIMAL_VIEW_IDS) {
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(viewId, provider),
        );
    }
    // Tie the provider's lifetime to the extension so disposables clear.
    context.subscriptions.push(provider);
}
