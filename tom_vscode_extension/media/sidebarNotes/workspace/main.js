// @ts-nocheck
// WorkspaceNotepad sidebar client — a user-chosen workspace notes file.
//
// Migrated from the inline <script> of _getHtml in
// src/handlers/sidebarNotes-handler.ts (Phase B.4). No first-paint init: all
// data (workspace presence, file presence, content, templates) flows via
// postMessage ('ready' → 'state'). Publishes window.__tomVscodeApi so the
// shared completion.js reuses the single acquireVsCodeApi() handle.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const headerBar = document.getElementById('headerBar');
    const noWorkspace = document.getElementById('noWorkspace');
    const noFile = document.getElementById('noFile');
    const contentEl = document.getElementById('content');
    const statusBar = document.getElementById('statusBar');
    const wsHeader = document.getElementById('wsHeader');
    const fileName = document.getElementById('fileName');
    const templateSelect = document.getElementById('templateSelect');
    const charCount = document.getElementById('charCount');

    let saveTimeout;
    contentEl.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            vscode.postMessage({ type: 'updateContent', content: contentEl.value });
        }, 500);
        charCount.textContent = contentEl.value.length + ' chars';
    });

    function selectedText() {
        const start = typeof contentEl.selectionStart === 'number' ? contentEl.selectionStart : 0;
        const end = typeof contentEl.selectionEnd === 'number' ? contentEl.selectionEnd : 0;
        return start !== end ? contentEl.value.slice(start, end) : '';
    }

    templateSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'selectTemplate', key: templateSelect.value });
    });
    document.getElementById('sendBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'sendToCopilot', selectedText: selectedText() });
    });
    document.getElementById('previewPromptBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewPrompt', selectedText: selectedText() });
    });
    document.getElementById('previewMarkdownBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewMarkdown' });
    });
    document.getElementById('openBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInEditor' });
    });
    document.getElementById('changeFileBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'changeFile' });
    });
    document.getElementById('createFileBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'createNotesFile' });
    });
    document.getElementById('selectFileBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'changeFile' });
    });
    document.getElementById('openWorkspaceBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openWorkspace' });
    });

    function applyState(data) {
        headerBar.style.display = 'none';
        noWorkspace.style.display = 'none';
        noFile.style.display = 'none';
        contentEl.style.display = 'none';
        statusBar.style.display = 'none';

        if (!data.hasWorkspace) {
            noWorkspace.style.display = 'flex';
            return;
        }
        if (!data.hasFile) {
            noFile.style.display = 'flex';
            return;
        }
        headerBar.style.display = '';
        contentEl.style.display = '';
        statusBar.style.display = '';
        wsHeader.textContent = 'Workspace Notes — ' + (data.workspaceName || 'Workspace');
        const templates = data.templates || [];
        templateSelect.innerHTML = templates
            .map((t) => '<option value="' + t.key + '"' + (t.key === data.selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>')
            .join('');
        const fp = data.filePath || 'notes.md';
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
