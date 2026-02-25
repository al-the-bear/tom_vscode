/**
 * TODO Mindmap Handler
 *
 * Opens a WebviewPanel displaying a mermaid flowchart TD diagram
 * of all *.todo.yaml files found by scanning from the workspace root.
 *
 * Features:
 * - Automatic root discovery (master.mindmap.yaml / topmost .git)
 * - Recursive scanning for *.todo.yaml files
 * - Directory tree rendered as subgraphs
 * - Todo items color-coded by status
 * - Dependency/blocked_by connections as dotted edges
 * - Click handlers open files or select todos
 *
 * Adapted from tom_vscode_extension/src/handlers/markdownHtmlPreview.ts
 */

import * as vscode from 'vscode';
import {
    findScanRoot,
    scanTodoFiles,
    buildTodoTree,
    extractDependencyLinks,
    renderFlowchart,
} from 'tom-vscode-shared';
import type { NodeAction } from 'tom-vscode-shared';
import { debug, log } from '../infrastructure';
import { reportError } from '../infrastructure/errorCapture';

// ============================================================================
// State
// ============================================================================

let _mindmapPanel: vscode.WebviewPanel | undefined;

// ============================================================================
// Public API
// ============================================================================

/**
 * Register the mindmap command.
 */
export function registerTodoMindmap(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tomTracker.showTodoMindmap',
            async () => {
                try {
                    await showTodoMindmap(context);
                } catch (err) {
                    reportError('tomTracker.showTodoMindmap', err);
                }
            },
        ),
    );
    debug('Todo Mindmap command registered');
}

// ============================================================================
// Panel Creation
// ============================================================================

async function showTodoMindmap(context: vscode.ExtensionContext): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
    }

    const startPath = wsFolder.uri.fsPath;
    const scanRoot = findScanRoot(startPath);
    log(`Todo Mindmap: scanning from ${scanRoot}`);

    const files = scanTodoFiles(scanRoot);
    if (files.length === 0) {
        vscode.window.showInformationMessage('No *.todo.yaml files found');
        return;
    }

    let effectiveFiles = files;
    let effectiveRoot = scanRoot;

    const tree = buildTodoTree(effectiveRoot, effectiveFiles);
    const links = extractDependencyLinks(tree);
    const { mermaid: mermaidCode, nodeActions } = renderFlowchart(tree, links);

    log(`Todo Mindmap: ${effectiveFiles.length} files, ${links.length} dependency links`);

    // Dispose any existing panel
    if (_mindmapPanel) {
        _mindmapPanel.dispose();
    }

    const mermaidUri = vscode.Uri.joinPath(
        context.extensionUri, 'lib', 'mermaid.min.js',
    );

    _mindmapPanel = vscode.window.createWebviewPanel(
        'todoMindmap',
        `TODO Mindmap (${effectiveFiles.length} files)`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'lib'),
            ],
        },
    );

    const webviewMermaidUri = _mindmapPanel.webview.asWebviewUri(mermaidUri);
    _mindmapPanel.webview.html = _getMindmapHtml(
        webviewMermaidUri.toString(),
        mermaidCode,
        nodeActions,
        effectiveRoot,
        effectiveFiles.length,
    );

    // Handle messages from webview
    _mindmapPanel.webview.onDidReceiveMessage(
        async (msg) => {
            try {
                await _handleMessage(msg, nodeActions, context);
            } catch (err) {
                reportError('todoMindmap.onMessage', err);
            }
        },
        undefined,
        context.subscriptions,
    );

    _mindmapPanel.onDidDispose(() => {
        _mindmapPanel = undefined;
    });
}

// ============================================================================
// Message Handling
// ============================================================================

async function _handleMessage(
    msg: any,
    nodeActions: Record<string, NodeAction>,
    context: vscode.ExtensionContext,
): Promise<void> {
    switch (msg.type) {
        case 'nodeClick': {
            const action = nodeActions[msg.nodeId];
            if (!action) { return; }

            if (action.type === 'openFile' && action.path) {
                const doc = await vscode.workspace.openTextDocument(action.path);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } else if (action.type === 'selectTodo' && action.file) {
                const doc = await vscode.workspace.openTextDocument(action.file);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } else if (action.type === 'openDirectory' && action.path) {
                const uri = vscode.Uri.file(action.path);
                await vscode.commands.executeCommand('revealInExplorer', uri);
            }
            break;
        }
        case 'refresh':
            await vscode.commands.executeCommand('tomTracker.showTodoMindmap');
            break;
        case 'close':
            _mindmapPanel?.dispose();
            break;
    }
}

// ============================================================================
// HTML Generation
// ============================================================================

function _getMindmapHtml(
    mermaidUri: string,
    mermaidCode: string,
    nodeActions: Record<string, NodeAction>,
    scanRoot: string,
    fileCount: number,
): string {
    const mermaidJson = JSON.stringify(mermaidCode);
    const nodeActionsJson = JSON.stringify(nodeActions);
    const scanRootJson = JSON.stringify(scanRoot);

    return `<!DOCTYPE html>
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
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}
.header-left {
    display: flex;
    align-items: center;
    gap: 12px;
}
.title {
    font-weight: 600;
    font-size: 13px;
}
.meta {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}
.header-right {
    display: flex;
    gap: 6px;
}
.btn {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-radius: 4px;
    cursor: pointer;
    padding: 4px 10px;
    font-size: 12px;
}
.btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}
.content {
    flex: 1;
    overflow: auto;
    padding: 16px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
}
.mermaid {
    max-width: 100%;
}
.mermaid svg {
    max-width: 100%;
    height: auto;
}
.legend {
    display: flex;
    gap: 12px;
    padding: 6px 12px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    flex-wrap: wrap;
}
.legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
}
</style>
</head>
<body>
<div class="header">
    <div class="header-left">
        <div class="title">TODO Mindmap</div>
        <div class="meta" id="scanInfo"></div>
    </div>
    <div class="header-right">
        <button class="btn" id="refreshBtn" title="Refresh">↻ Refresh</button>
        <button class="btn" id="closeBtn" title="Close">✕</button>
    </div>
</div>
<div class="content" id="diagramContainer">
    <div class="mermaid" id="mermaidDiagram"></div>
</div>
<div class="legend">
    <div class="legend-item">⬜ Not started</div>
    <div class="legend-item">🔄 In progress</div>
    <div class="legend-item">✅ Completed</div>
    <div class="legend-item">⛔ Cancelled</div>
    <div class="legend-item">🚫 Blocked</div>
    <div class="legend-item">┈→ Dependency</div>
</div>

<script src="${mermaidUri}"></script>
<script>
var vscode = acquireVsCodeApi();
var mermaidCode = ${mermaidJson};
var nodeActionsMap = ${nodeActionsJson};
var scanRoot = ${scanRootJson};
var fileCount = ${fileCount};

document.getElementById('scanInfo').textContent = scanRoot + ' (' + fileCount + ' files)';

// Click callback for mermaid nodes — called by mermaid via securityLevel:loose
function onNodeClick(nodeId) {
    vscode.postMessage({ type: 'nodeClick', nodeId: nodeId });
}
window.onNodeClick = onNodeClick;

// Initialize and render mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    maxTextSize: 5000000,
    maxEdges: 10000,
    flowchart: {
        curve: 'basis',
        padding: 15,
        nodeSpacing: 30,
        rankSpacing: 40,
    },
});

(async function renderDiagram() {
    var container = document.getElementById('mermaidDiagram');
    try {
        var result = await mermaid.render('mindmap-svg', mermaidCode);
        container.innerHTML = result.svg;
    } catch (err) {
        container.innerHTML = '<pre style="color: var(--vscode-errorForeground); padding: 20px;">' +
            'Diagram render error:\\n' + String(err) +
            '\\n\\nMermaid code (first 2000 chars):\\n' + mermaidCode.substring(0, 2000) + '</pre>';
    }
})();

document.getElementById('refreshBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'refresh' });
});
document.getElementById('closeBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'close' });
});
</script>
</body>
</html>`;
}
