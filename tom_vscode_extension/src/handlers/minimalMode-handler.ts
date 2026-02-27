/**
 * Minimal-mode placeholder provider for all webview panels.
 *
 * When the extension runs without a .tom/ configuration folder, this provider
 * is registered for every declared webview view ID. Instead of showing a
 * forever-spinning loading indicator, each panel displays a friendly
 * "not a TOM AI workspace" message with setup instructions.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// All webview view IDs declared in package.json that need a provider in minimal mode
const MINIMAL_VIEW_IDS = [
    'tomAi.chatPanel',
    'tomAi.wsPanel',
    'tomAi.tomNotepad',
    'tomAi.questNotesView',
    'tomAi.questTodosView',
    'tomAi.sessionTodosView',
    'tomAi.todoLogView',
    'tomAi.workspaceNotepad',
    'tomAi.workspaceTodosView',
];

class MinimalModeViewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === 'openSetupDoc') {
                this._openSetupDoc();
            }
        });
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

    private _getHtml(_webview: vscode.Webview): string {
        return '<!DOCTYPE html>\n'
            + '<html lang="en">\n'
            + '<head>\n'
            + '  <meta charset="UTF-8">\n'
            + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            + '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">\n'
            + '  <title>Setup Required</title>\n'
            + '  <style>\n'
            + '    * { box-sizing: border-box; margin: 0; padding: 0; }\n'
            + '    body {\n'
            + '      font-family: var(--vscode-font-family);\n'
            + '      font-size: var(--vscode-font-size);\n'
            + '      color: var(--vscode-foreground);\n'
            + '      background: var(--vscode-sideBar-background);\n'
            + '      padding: 16px 12px;\n'
            + '      display: flex;\n'
            + '      flex-direction: column;\n'
            + '      align-items: center;\n'
            + '      text-align: center;\n'
            + '    }\n'
            + '    .icon {\n'
            + '      font-size: 32px;\n'
            + '      margin-bottom: 12px;\n'
            + '      opacity: 0.6;\n'
            + '    }\n'
            + '    h3 {\n'
            + '      font-size: 13px;\n'
            + '      font-weight: 600;\n'
            + '      margin-bottom: 8px;\n'
            + '    }\n'
            + '    p {\n'
            + '      font-size: 12px;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      line-height: 1.5;\n'
            + '      margin-bottom: 12px;\n'
            + '    }\n'
            + '    code {\n'
            + '      background: var(--vscode-textCodeBlock-background);\n'
            + '      padding: 1px 4px;\n'
            + '      border-radius: 3px;\n'
            + '      font-size: 11px;\n'
            + '    }\n'
            + '    .steps {\n'
            + '      text-align: left;\n'
            + '      width: 100%;\n'
            + '      font-size: 12px;\n'
            + '      color: var(--vscode-descriptionForeground);\n'
            + '      line-height: 1.6;\n'
            + '      margin-bottom: 12px;\n'
            + '    }\n'
            + '    .steps li {\n'
            + '      margin-bottom: 4px;\n'
            + '      margin-left: 16px;\n'
            + '    }\n'
            + '    button {\n'
            + '      background: var(--vscode-button-background);\n'
            + '      color: var(--vscode-button-foreground);\n'
            + '      border: none;\n'
            + '      padding: 6px 14px;\n'
            + '      border-radius: 2px;\n'
            + '      cursor: pointer;\n'
            + '      font-size: 12px;\n'
            + '    }\n'
            + '    button:hover {\n'
            + '      background: var(--vscode-button-hoverBackground);\n'
            + '    }\n'
            + '  </style>\n'
            + '</head>\n'
            + '<body>\n'
            + '  <div class="icon">&#9881;</div>\n'
            + '  <h3>TOM AI Setup Required</h3>\n'
            + '  <p>This workspace is not configured for TOM AI.<br>The extension is running in minimal mode.</p>\n'
            + '  <ol class="steps">\n'
            + '    <li>Create a <code>.tom/</code> folder in the workspace root</li>\n'
            + '    <li>Add <code>.tom/tom_vscode_extension.json</code> config file</li>\n'
            + '    <li>Reload the window</li>\n'
            + '  </ol>\n'
            + '  <button id="setupBtn">Open Setup Guide</button>\n'
            + '  <script>\n'
            + '    (function() {\n'
            + '      var vscode = acquireVsCodeApi();\n'
            + '      document.getElementById(\'setupBtn\').addEventListener(\'click\', function() {\n'
            + '        vscode.postMessage({ type: \'openSetupDoc\' });\n'
            + '      });\n'
            + '    })();\n'
            + '  </script>\n'
            + '</body>\n'
            + '</html>';
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
}
