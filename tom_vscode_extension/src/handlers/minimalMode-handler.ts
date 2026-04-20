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
        webview.options = { enableScripts: true };
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
        const body = `
  <div class="icon">&#9881;</div>
  <h3>TOM AI Setup Required</h3>
  <p>This workspace is not configured for TOM AI.<br>The extension is running in minimal mode.</p>
  <ol class="steps">
    <li>Create a <code>.tom/</code> folder in the workspace root</li>
    <li>Add <code>.tom/tom_vscode_extension.json</code> config file</li>
    <li>Reload the window</li>
  </ol>
  <button id="setupBtn">Open Setup Guide</button>`;

        const script = `
(function() {
  var vscode = acquireVsCodeApi();
  document.getElementById('setupBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openSetupDoc' });
  });
})();`;

        // The base helper wires up CSP + base styles. We replace the body
        // styles with a centered-layout variant tuned for the empty-state card.
        return this.getBaseHtml(webview, body, script).replace(
            /<style>[\s\S]*?<\/style>/,
            `<style>${this.getBaseStyles()}${extraStyles}</style>`,
        );
    }
}

const extraStyles = `
body {
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    background: var(--vscode-sideBar-background);
}
.icon {
    font-size: 32px;
    margin-bottom: 12px;
    opacity: 0.6;
}
h3 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
}
p {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
    margin-bottom: 12px;
}
code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
}
.steps {
    text-align: left;
    width: 100%;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.6;
    margin-bottom: 12px;
}
.steps li {
    margin-bottom: 4px;
    margin-left: 16px;
}
button {
    padding: 6px 14px;
    border-radius: 2px;
    font-size: 12px;
}
`;

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
