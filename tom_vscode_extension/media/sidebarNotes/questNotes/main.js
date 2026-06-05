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
    const templateSelect = document.getElementById('templateSelect');

    let saveTimeout;
    contentEl.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            vscode.postMessage({ type: 'updateContent', content: contentEl.value });
        }, 300);
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
    document.getElementById('previewPromptBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewPrompt', selectedText: selectedText() });
    });
    document.getElementById('previewMarkdownBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'previewMarkdown' });
    });
    document.getElementById('sendBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'sendToCopilot', selectedText: selectedText() });
    });
    document.getElementById('openBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'openInEditor' });
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
        const templates = e.data.templates || [];
        templateSelect.innerHTML = templates
            .map((t) => '<option value="' + t.key + '"' + (t.key === e.data.selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>')
            .join('');
    });

    vscode.postMessage({ type: 'ready' });
})();
