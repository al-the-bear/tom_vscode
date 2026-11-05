// @ts-nocheck
// TomNotepad sidebar client — global notes (~/.tom/notes/global_notes.md).
//
// Migrated from the inline <script> of _getHtml in
// src/handlers/sidebarNotes-handler.ts (Phase B.4). The status-bar path label
// is seeded from window.__INIT__.homeTomFolder; all editable data flows via
// postMessage ('ready' → 'state'). Publishes window.__tomVscodeApi so the
// shared completion.js reuses the single acquireVsCodeApi() handle.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const init = window.__INIT__ || {};
    const contentEl = document.getElementById('content');
    const charCount = document.getElementById('charCount');
    const notesFileName = document.getElementById('notesFileName');
    const notesPath = document.getElementById('notesPath');

    if (init.homeTomFolder) {
        notesPath.textContent = '~/' + init.homeTomFolder + '/notes/global_notes.md';
    }

    let saveTimeout;
    contentEl.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            vscode.postMessage({ type: 'updateContent', content: contentEl.value });
        }, 300);
        charCount.textContent = contentEl.value.length + ' chars';
    });

    document.getElementById('previewMarkdownBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewMarkdown' });
    });
    document.getElementById('copyBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'copy' });
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
    document.getElementById('clearBtn').addEventListener('click', () => {
        if (confirm('Clear notepad?')) {
            vscode.postMessage({ type: 'clear' });
        }
    });

    window.addEventListener('message', (e) => {
        if (e.data.type !== 'state') { return; }
        contentEl.value = e.data.content || '';
        charCount.textContent = (e.data.content || '').length + ' chars';
        const fp = e.data.notesFilePath || '';
        const name = fp.split('/').pop() || fp.split('\\').pop() || fp;
        notesFileName.textContent = name || 'global_notes.md';
        notesFileName.title = fp || 'global_notes.md';
    });

    vscode.postMessage({ type: 'ready' });
})();
