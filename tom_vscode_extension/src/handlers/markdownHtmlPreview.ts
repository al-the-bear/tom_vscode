import * as vscode from 'vscode';

export interface MarkdownHtmlPreviewOptions {
    title: string;
    markdown: string;
    meta?: string;
}

let markdownPreviewPanel: vscode.WebviewPanel | undefined;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

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
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib'),
                vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist'),
            ],
        },
    );

    const markedUri = markdownPreviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js'),
    );
    const mermaidUri = markdownPreviewPanel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    );

    const titleJson = JSON.stringify(options.title || 'Markdown Preview');
    const markdownSource = options.markdown || '';
    const markdownJson = JSON.stringify(markdownSource);
    const escapedMarkdownJson = JSON.stringify(escapeHtml(markdownSource));
    const metaJson = JSON.stringify(options.meta || '');

    markdownPreviewPanel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }
        .title {
            font-weight: 600;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .close-btn {
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 4px;
            cursor: pointer;
            width: 28px;
            height: 28px;
            font-size: 16px;
            line-height: 1;
        }
        .close-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .meta {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .content {
            padding: 14px 18px;
            overflow: auto;
            flex: 1;
        }
        .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 16px 0 8px; }
        .markdown-body p { margin: 8px 0; line-height: 1.5; }
        .markdown-body pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 6px; overflow-x: auto; }
        .markdown-body code { font-family: var(--vscode-editor-font-family); }
        .markdown-body blockquote { border-left: 3px solid var(--vscode-panel-border); margin: 8px 0; padding: 4px 10px; color: var(--vscode-descriptionForeground); }
        .markdown-body table { border-collapse: collapse; width: 100%; margin: 10px 0; }
        .markdown-body th, .markdown-body td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; }
        .markdown-body hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 14px 0; }
    </style>
</head>
<body>
    <div class="header">
        <div class="title" id="previewTitle"></div>
        <button class="close-btn" id="closeBtn" title="Close">✕</button>
    </div>
    <div class="meta" id="previewMeta"></div>
    <div class="content markdown-body" id="previewContent"></div>

    <script src="${markedUri}"></script>
    <script src="${mermaidUri}"></script>
    <script>
        const vscode = acquireVsCodeApi();
        const title = ${titleJson};
        const markdown = ${markdownJson};
        const meta = ${metaJson};

        const titleEl = document.getElementById('previewTitle');
        const metaEl = document.getElementById('previewMeta');
        const contentEl = document.getElementById('previewContent');
        const closeBtn = document.getElementById('closeBtn');

        if (titleEl) {
            titleEl.textContent = title;
        }

        if (metaEl) {
            metaEl.textContent = meta;
            metaEl.style.display = meta ? 'block' : 'none';
        }

        const renderedHtml = (typeof marked !== 'undefined' && marked.parse)
            ? marked.parse(markdown || '')
            : '<pre>' + ${escapedMarkdownJson} + '</pre>';

        if (contentEl) {
            contentEl.innerHTML = renderedHtml;
        }

        if (typeof mermaid !== 'undefined' && contentEl) {
            try {
                contentEl.querySelectorAll('pre > code.language-mermaid').forEach((codeEl) => {
                    const pre = codeEl.parentElement;
                    if (!pre || !pre.parentElement) {
                        return;
                    }
                    const mermaidDiv = document.createElement('div');
                    mermaidDiv.className = 'mermaid';
                    mermaidDiv.textContent = codeEl.textContent || '';
                    pre.parentElement.replaceChild(mermaidDiv, pre);
                });

                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
                mermaid.run({ nodes: contentEl.querySelectorAll('.mermaid') });
            } catch (error) {
                console.error('Mermaid render failed', error);
            }
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'close' });
            });
        }
    </script>
</body>
</html>`;

    markdownPreviewPanel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'close') {
            markdownPreviewPanel?.dispose();
        }
    });

    markdownPreviewPanel.onDidDispose(() => {
        markdownPreviewPanel = undefined;
    });
}