// @ts-nocheck
// QuestNotes sidebar client — per-quest notes, path derived from the active
// quest (the host resolves it; the view stays empty when no quest is active).
//
// Migrated from the inline <script> of _getHtml in
// src/handlers/sidebarNotes-handler.ts (Phase B.4). No first-paint init; all
// data flows via postMessage ('ready' → 'state'). Publishes
// window.__tomVscodeApi so the shared completion.js reuses the single
// acquireVsCodeApi() handle.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const toolbar = document.getElementById('toolbar');
    const empty = document.getElementById('empty');
    const contentEl = document.getElementById('content');
    const status = document.getElementById('status');
    const charCount = document.getElementById('charCount');
    const fileName = document.getElementById('fileName');

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
    document.getElementById('openBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInEditor' });
    });
    document.getElementById('openMdBrowserBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInMdBrowser' });
    });
    document.getElementById('openMdViewerBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInMdViewer' });
    });

    window.addEventListener('message', (e) => {
        if (e.data.type !== 'state') { return; }
        const ok = e.data.hasWorkspaceFile && e.data.filePath;
        toolbar.style.display = ok ? '' : 'none';
        contentEl.style.display = ok ? '' : 'none';
        status.style.display = ok ? '' : 'none';
        empty.style.display = ok ? 'none' : 'flex';
        if (!ok) { return; }
        contentEl.value = e.data.content || '';
        charCount.textContent = (e.data.content || '').length + ' chars';
        const fp = e.data.filePath || '';
        const fn = fp.split('/').pop() || fp.split('\\').pop() || fp;
        fileName.textContent = fn || '-';
        fileName.title = fp || '';
    });

    vscode.postMessage({ type: 'ready' });
})();
