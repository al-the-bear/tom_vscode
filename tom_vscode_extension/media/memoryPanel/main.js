// @ts-nocheck
// memoryPanel webview client — the two-tier memory store editor.
//
// Verbatim extraction of the inline <script> IIFE from `_getHtml` in
// src/handlers/memoryPanel-handler.ts. All panel data flows in via postMessage
// (the webview posts `ready`, the host replies with `snapshot`/`fileContent`),
// so there is no window.__INIT__ first-paint payload. The only addition is
// publishing window.__tomVscodeApi so the shared completion component
// (media/shared/completion.js) reuses the single acquireVsCodeApi() handle.
// @ts-nocheck because it touches ambient DOM globals without strict checkJs
// typings (consistent with the other Phase B verbatim extractions).

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this
    let currentScope = 'shared';
    let currentFile = '';
    let dirty = false;
    let snapshot = { quest: '', shared: [], questFiles: [] };

    const questTab = document.getElementById('quest-tab');
    const fileList = document.getElementById('file-list');
    const content = document.getElementById('content');
    const status = document.getElementById('status');
    const btnNew = document.getElementById('btn-new');
    const btnSave = document.getElementById('btn-save');
    const btnDelete = document.getElementById('btn-delete');
    const btnOpen = document.getElementById('btn-open');

    document.querySelectorAll('.tab').forEach((el) => {
        el.addEventListener('click', () => switchScope(el.getAttribute('data-scope')));
    });

    content.addEventListener('input', () => {
        dirty = true;
        btnSave.disabled = !currentFile;
        status.textContent = currentFile ? 'unsaved' : '';
    });

    btnNew.addEventListener('click', () => {
        vscode.postMessage({ type: 'newFile', scope: currentScope });
    });
    btnSave.addEventListener('click', () => {
        if (!currentFile) return;
        vscode.postMessage({ type: 'saveFile', scope: currentScope, file: currentFile, content: content.value });
        dirty = false;
        status.textContent = 'saved';
    });
    btnDelete.addEventListener('click', () => {
        if (!currentFile) return;
        if (!confirm('Delete ' + currentScope + '/' + currentFile + '?')) return;
        vscode.postMessage({ type: 'deleteFile', scope: currentScope, file: currentFile });
        currentFile = '';
        content.value = '';
        dirty = false;
        btnSave.disabled = true;
        btnDelete.disabled = true;
        btnOpen.disabled = true;
    });
    btnOpen.addEventListener('click', () => {
        if (!currentFile) return;
        vscode.postMessage({ type: 'openInEditor', scope: currentScope, file: currentFile });
    });

    function switchScope(scope) {
        if (dirty && !confirm('Discard unsaved changes?')) return;
        currentScope = scope;
        currentFile = '';
        content.value = '';
        dirty = false;
        btnSave.disabled = true;
        btnDelete.disabled = true;
        btnOpen.disabled = true;
        status.textContent = '';
        document.querySelectorAll('.tab').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-scope') === scope);
        });
        renderList();
    }

    function renderList() {
        const files = currentScope === 'shared' ? snapshot.shared : snapshot.questFiles;
        fileList.innerHTML = '';
        if (!files.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            if (currentScope === 'quest' && !snapshot.quest) {
                empty.textContent = 'No active quest. Set one in the Chat Variables Editor.';
            } else {
                empty.textContent = '(no files)';
            }
            fileList.appendChild(empty);
            return;
        }
        for (const f of files) {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.innerHTML = '<span>' + f.file + '</span><span class="bytes">' + f.bytes + 'b</span>';
            if (f.file === currentFile) item.classList.add('active');
            item.addEventListener('click', () => {
                if (dirty && !confirm('Discard unsaved changes?')) return;
                currentFile = f.file;
                document.querySelectorAll('.file-item').forEach((el) => el.classList.remove('active'));
                item.classList.add('active');
                vscode.postMessage({ type: 'readFile', scope: currentScope, file: f.file });
            });
            fileList.appendChild(item);
        }
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'snapshot') {
            snapshot = msg;
            questTab.textContent = msg.quest ? 'Quest: ' + msg.quest : 'Quest';
            renderList();
        } else if (msg.type === 'fileContent') {
            if (msg.scope === currentScope && msg.file === currentFile) {
                content.value = msg.content;
                dirty = false;
                btnSave.disabled = false;
                btnDelete.disabled = false;
                btnOpen.disabled = false;
                status.textContent = '';
            }
        } else if (msg.type === 'error') {
            status.textContent = 'error: ' + msg.message;
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
