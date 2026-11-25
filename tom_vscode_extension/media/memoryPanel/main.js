// @ts-nocheck
// memoryPanel webview client — the editor of the quest memory folder
// (_ai/quests/<quest>/memory/): the curated files first, then the candidates
// files (candidates.<host>.md), marked as such.
//
// All panel data flows in via postMessage (the webview posts `ready`, the
// host replies with `snapshot`/`fileContent`), so there is no
// window.__INIT__ first-paint payload. window.__tomVscodeApi is published so
// the shared completion component (media/shared/completion.js) reuses the
// single acquireVsCodeApi() handle.
// @ts-nocheck because it touches ambient DOM globals without strict checkJs
// typings.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this
    const currentScope = 'quest';
    let currentFile = '';
    let dirty = false;
    let snapshot = { quest: '', questFiles: [] };

    const questTab = document.getElementById('quest-tab');
    const fileList = document.getElementById('file-list');
    const content = document.getElementById('content');
    const status = document.getElementById('status');
    const btnNew = document.getElementById('btn-new');
    const btnSave = document.getElementById('btn-save');
    const btnDelete = document.getElementById('btn-delete');
    const btnOpen = document.getElementById('btn-open');
    const memoryFolder = document.getElementById('memory-folder');

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

    function renderList() {
        const files = snapshot.questFiles;
        fileList.innerHTML = '';
        if (!files.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            if (!snapshot.quest) {
                empty.textContent = 'No active quest. Set one in the Chat Variables Editor.';
            } else {
                empty.textContent = '(no files)';
            }
            fileList.appendChild(empty);
            return;
        }
        // The host sends the curated files first, then the candidates files.
        let candidatesHeading = false;
        for (const f of files) {
            const isCandidates = f.kind === 'candidates';
            if (isCandidates && !candidatesHeading) {
                candidatesHeading = true;
                const group = document.createElement('div');
                group.className = 'file-group';
                group.textContent = 'Candidates (automatic extraction)';
                fileList.appendChild(group);
            }
            const item = document.createElement('div');
            item.className = 'file-item' + (isCandidates ? ' candidates' : '');
            item.dataset.file = f.file;
            item.dataset.kind = isCandidates ? 'candidates' : 'curated';
            const name = document.createElement('span');
            name.textContent = f.file;
            item.appendChild(name);
            if (isCandidates) {
                const kind = document.createElement('span');
                kind.className = 'kind';
                kind.textContent = f.ownHost ? 'candidates · this host' : 'candidates · host ' + (f.host || '?');
                item.title = f.ownHost
                    ? 'Candidates the memory extraction on this host wrote; each line names its session and the curated file it is meant for'
                    : 'Candidates of host ' + (f.host || '?') + ': that host writes this file';
                item.appendChild(kind);
            }
            const bytes = document.createElement('span');
            bytes.className = 'bytes';
            bytes.textContent = f.bytes + 'b';
            item.appendChild(bytes);
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
            memoryFolder.textContent = msg.folder || '';
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
