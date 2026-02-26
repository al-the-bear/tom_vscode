import * as vscode from 'vscode';

export abstract class BaseWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    protected view: vscode.WebviewView | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly messageHandlers = new Map<string, (msg: Record<string, unknown>) => Promise<void>>();

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.onResolve(view.webview);

        const disposable = view.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
            const type = typeof message.type === 'string' ? message.type : '';
            if (!type) {
                return;
            }
            const handler = this.messageHandlers.get(type);
            if (handler) {
                await handler(message);
            }
        });

        this.disposables.push(disposable);
    }

    dispose(): void {
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            disposable?.dispose();
        }
        this.messageHandlers.clear();
        this.view = undefined;
    }

    protected registerMessageHandler(type: string, handler: (msg: Record<string, unknown>) => Promise<void>): void {
        this.messageHandlers.set(type, handler);
    }

    protected getBaseHtml(webview: vscode.Webview, body: string, scripts = ''): string {
        const nonce = this.getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${this.getBaseStyles()}</style>
</head>
<body>${body}
<script nonce="${nonce}">${scripts}</script>
</body>
</html>`;
    }

    protected getNonce(): string {
        return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    protected getBaseStyles(): string {
        return `
            body {
                margin: 0;
                padding: 8px;
                color: var(--vscode-foreground);
                background: var(--vscode-editor-background);
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
            }
            button {
                color: var(--vscode-button-foreground);
                background: var(--vscode-button-background);
                border: none;
                padding: 4px 8px;
                cursor: pointer;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
        `;
    }

    protected abstract onResolve(webview: vscode.Webview): void;
}
