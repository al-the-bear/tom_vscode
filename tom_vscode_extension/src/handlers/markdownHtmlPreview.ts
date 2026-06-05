import * as vscode from 'vscode';
import { loadWebviewHtml } from '../utils/webviewLoader';

export interface MarkdownHtmlPreviewOptions {
    title: string;
    markdown: string;
    meta?: string;
}

let markdownPreviewPanel: vscode.WebviewPanel | undefined;

export async function showMarkdownHtmlPreview(
    context: vscode.ExtensionContext,
    options: MarkdownHtmlPreviewOptions,
): Promise<void> {
    if (markdownPreviewPanel) {
        markdownPreviewPanel.dispose();
    }

    markdownPreviewPanel = vscode.window.createWebviewPanel(
        'tomAiMarkdownHtmlPreview',
        options.title,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist'),
            ],
        },
    );

    const panel = markdownPreviewPanel;

    // The library bundles live in node_modules; their webview URIs are
    // first-paint state (they don't change after load), so they flow through
    // `init`/window.__INIT__. The markdown text itself is injected via
    // postMessage (§3 content-injection) once the webview signals readiness.
    const markedUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
    );
    const mermaidUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    );

    panel.webview.html = loadWebviewHtml(panel.webview, 'markdownHtmlPreview', {
        init: { markedUri: markedUri.toString(), mermaidUri: mermaidUri.toString() },
    });

    panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
            panel.webview.postMessage({
                type: 'setContent',
                title: options.title || 'Markdown Preview',
                markdown: options.markdown || '',
                meta: options.meta || '',
            });
        } else if (msg?.type === 'close') {
            markdownPreviewPanel?.dispose();
        }
    });

    panel.onDidDispose(() => {
        markdownPreviewPanel = undefined;
    });
}
