// @ts-nocheck
// QuestNotes sidebar client — the active quest's notes files, one at a time
// (the host resolves them; the view stays empty when no quest is active).
// The picker lists the files (the default first): a change saves the text and
// posts 'selectNotesFile'; the New button posts 'newNotesFile' (the host asks
// for the name). The other buttons act on the file picked.
//
// No first-paint init; all
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
    const fileSelect = document.getElementById('notesFileSelect');

    let saveTimeout = null;
    /** Write text still waiting for its pause, so that it reaches the file shown. */
    function saveNow() {
        if (saveTimeout === null) { return; }
        clearTimeout(saveTimeout);
        saveTimeout = null;
        vscode.postMessage({ type: 'updateContent', content: contentEl.value });
    }
    contentEl.addEventListener('input', () => {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveNow, 300);
        charCount.textContent = contentEl.value.length + ' chars';
    });

    fileSelect.addEventListener('change', () => {
        saveNow();
        vscode.postMessage({ type: 'selectNotesFile', name: fileSelect.value });
    });
    document.getElementById('newNotesFileBtn').addEventListener('click', () => {
        saveNow();
        vscode.postMessage({ type: 'newNotesFile' });
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
        fileSelect.textContent = '';
        (e.data.notesFiles || []).forEach((f) => {
            const o = document.createElement('option');
            o.value = f.name;
            o.textContent = f.name;
            fileSelect.appendChild(o);
        });
        fileSelect.value = e.data.notesFile || '';
        fileSelect.title = e.data.filePath || '';
    });

    vscode.postMessage({ type: 'ready' });
})();
