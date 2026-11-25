// @ts-nocheck
// WorkspaceNotepad sidebar client — the workspace's one notes file
// (_ai/workspaces/<workspace>.notes.md, resolved by the host; the page has no
// file choice).
//
// No first-paint init: all
// data (workspace presence, content) flows via
// postMessage ('ready' → 'state'). Publishes window.__tomVscodeApi so the
// shared completion.js reuses the single acquireVsCodeApi() handle.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const headerBar = document.getElementById('headerBar');
    const noWorkspace = document.getElementById('noWorkspace');
    const contentEl = document.getElementById('content');
    const statusBar = document.getElementById('statusBar');
    const wsHeader = document.getElementById('wsHeader');
    const fileName = document.getElementById('fileName');
    const charCount = document.getElementById('charCount');

    let saveTimeout;
    contentEl.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            vscode.postMessage({ type: 'updateContent', content: contentEl.value });
        }, 500);
        charCount.textContent = contentEl.value.length + ' chars';
    });

    document.getElementById('previewMarkdownBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewMarkdown' });
    });
    document.getElementById('openBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInEditor' });
    });
    document.getElementById('openMdBrowserBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInMdBrowser' });
    });
    document.getElementById('openMdViewerBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInMdViewer' });
    });
    document.getElementById('openWorkspaceBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openWorkspace' });
    });

    function applyState(data) {
        headerBar.style.display = 'none';
        noWorkspace.style.display = 'none';
        contentEl.style.display = 'none';
        statusBar.style.display = 'none';

        if (!data.hasWorkspace) {
            noWorkspace.style.display = 'flex';
            return;
        }
        headerBar.style.display = '';
        contentEl.style.display = '';
        statusBar.style.display = '';
        wsHeader.textContent = 'Workspace Notes — ' + (data.workspaceName || 'Workspace');
        const fp = data.filePath || '';
        fileName.textContent = fp.split('/').pop() || fp.split('\\').pop() || fp;
        fileName.title = fp;
        const text = data.content || '';
        contentEl.value = text;
        charCount.textContent = text.length + ' chars';
    }

    window.addEventListener('message', (e) => {
        if (e.data.type === 'state') { applyState(e.data); }
    });

    vscode.postMessage({ type: 'ready' });
})();
