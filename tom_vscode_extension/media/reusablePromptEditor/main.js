// @ts-nocheck
// Reusable Prompt Editor webview client — extracted from the inline <script> of
// _getHtml() in src/handlers/reusablePromptEditor-handler.ts (Phase B.9 webview
// restructuring). First-paint data (codicons URI) arrives via window.__INIT__;
// the quest's file list flows via postMessage. The content textarea is rendered after
// load and opts into shared completion (data-completion="on" + completion.js).
// @ts-nocheck: verbatim legacy extraction (loose getElementById access predates
// the strict checkJs gate).

(function () {
    // Inject codicons stylesheet (its URI is resolved by the extension host).
    var __init = window.__INIT__ || {};
    if (__init.codiconsUri) {
        var __link = document.createElement('link');
        __link.rel = 'stylesheet';
        __link.href = String(__init.codiconsUri);
        document.head.appendChild(__link);
    }

    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const NO_SELECTION_HTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';

    // The active quest ('' while the window has none: nothing is offered then).
    let currentQuest = '';
    let currentFileId = '';
    let currentFiles = [];
    let dirty = false;

    const fileList = document.getElementById('fileList');
    const editorArea = document.getElementById('editorArea');
    const saveBar = document.getElementById('saveBar');
    const panelHeadline = document.getElementById('panelHeadline');
    const noQuest = document.getElementById('noQuest');
    const mainArea = document.getElementById('mainArea');
    const btnAdd = document.getElementById('btnAdd');
    const btnRename = document.getElementById('btnRename');
    const btnDelete = document.getElementById('btnDelete');
    const btnPreview = document.getElementById('btnPreview');
    const btnOpen = document.getElementById('btnOpen');

    function updateHeadline() {
        panelHeadline.textContent = (currentQuest ? currentQuest + ' — ' : '') + 'Reusable Prompt Editor';
    }

    btnAdd.addEventListener('click', () => {
        if (!currentQuest) return;
        vscode.postMessage({ type: 'add' });
    });
    btnRename.addEventListener('click', () => {
        if (!currentFileId) return;
        if (dirty && !confirmDiscard()) return;
        vscode.postMessage({ type: 'rename', fileId: currentFileId });
    });
    btnDelete.addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'delete', fileId: currentFileId });
    });
    document.getElementById('btnSave').addEventListener('click', saveFile);
    // Up / Down: the selected file moves one place in the list (the order is stored by the host; the files stay).
    const btnMoveUp = document.getElementById('btnMoveUp');
    const btnMoveDown = document.getElementById('btnMoveDown');
    function moveCurrentFile(direction) {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'move', fileId: currentFileId, direction });
    }
    btnMoveUp.addEventListener('click', () => moveCurrentFile('up'));
    btnMoveDown.addEventListener('click', () => moveCurrentFile('down'));
    /** The buttons follow the selection: off at the list's ends and without one; everything is off without a quest. */
    function syncButtons() {
        const at = currentFiles.findIndex(f => f.id === currentFileId);
        btnMoveUp.disabled = at <= 0;
        btnMoveDown.disabled = at < 0 || at >= currentFiles.length - 1;
        btnAdd.disabled = !currentQuest;
        btnRename.disabled = at < 0;
        btnDelete.disabled = at < 0;
        btnPreview.disabled = at < 0;
        btnOpen.disabled = at < 0;
    }
    btnPreview.addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'openInPreview', fileId: currentFileId });
    });
    btnOpen.addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'openInVsCode', fileId: currentFileId });
    });

    // Ctrl/Cmd+S to save
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
    });

    // Persist the current selection so deserializeWebviewPanel() can re-open the
    // same prompt after a window reload (the extension reads this state object).
    function persistState() {
        vscode.setState({ fileId: currentFileId });
    }

    function clearEditor() {
        editorArea.innerHTML = NO_SELECTION_HTML;
        saveBar.style.display = 'none';
        dirty = false;
    }

    function loadCurrentFile() {
        vscode.postMessage({ type: 'loadFile', fileId: currentFileId });
    }

    function renderFileList(files, selectId) {
        currentFiles = files || [];
        if (currentFiles.length === 0) {
            fileList.innerHTML = '<div class="empty">No .prompt.md files in this quest</div>';
            syncButtons();
            return;
        }
        fileList.innerHTML = currentFiles.map(f =>
            '<div class="item' + (f.id === (selectId || currentFileId) ? ' selected' : '') +
            '" data-id="' + escapeAttr(f.id) + '">' + escapeText(f.label) + '</div>'
        ).join('');

        fileList.querySelectorAll('.item').forEach(el => {
            el.addEventListener('click', () => {
                if (dirty && !confirmDiscard()) return;
                dirty = false;
                currentFileId = el.dataset.id;
                fileList.querySelectorAll('.item').forEach(e => e.classList.remove('selected'));
                el.classList.add('selected');
                syncButtons();
                persistState();
                loadCurrentFile();
            });
        });
        syncButtons();
    }

    function renderEditor(fileId, content) {
        editorArea.innerHTML = '<div class="file-header">' + escapeText(fileId) + '</div>' +
            '<textarea id="contentEditor" data-completion="on" spellcheck="false">' + escapeText(content) + '</textarea>';
        saveBar.style.display = 'flex';
        dirty = false;
        const ta = document.getElementById('contentEditor');
        ta.addEventListener('input', () => { dirty = true; });
        // Tab support in textarea
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(end);
                ta.selectionStart = ta.selectionEnd = start + 4;
                dirty = true;
            }
        });
    }

    function saveFile() {
        const ta = document.getElementById('contentEditor');
        if (!ta || !currentFileId) return;
        vscode.postMessage({ type: 'save', fileId: currentFileId, content: ta.value });
        dirty = false;
    }

    function confirmDiscard() { return confirm('Discard unsaved changes?'); }
    function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // ── Messages from extension ──
    window.addEventListener('message', e => {
        const msg = e.data;
        switch (msg.type) {
            case 'data': {
                currentQuest = String(msg.quest || '');
                updateHeadline();
                noQuest.textContent = currentQuest ? '' : String(msg.noQuestMessage || '');
                noQuest.style.display = currentQuest ? 'none' : '';
                mainArea.style.display = currentQuest ? '' : 'none';
                const files = currentQuest ? (msg.files || []) : [];
                const wanted = msg.initialFileId || currentFileId;
                currentFileId = files.some(f => f.id === wanted) ? wanted : '';
                renderFileList(files, currentFileId);
                if (currentFileId) { loadCurrentFile(); } else { clearEditor(); }
                persistState();
                break;
            }
            case 'files':
                // The list after a file was added or deleted; a new file is selected and loaded.
                if (msg.selectFileId) { currentFileId = msg.selectFileId; dirty = false; }
                renderFileList(msg.files, currentFileId);
                if (msg.selectFileId) { persistState(); loadCurrentFile(); }
                break;
            case 'filesReordered':
                // Only the list: the file being edited stays as it is.
                renderFileList(msg.files, currentFileId);
                break;
            case 'fileContent':
                if (msg.fileId === currentFileId) { renderEditor(msg.fileId, msg.content); }
                break;
            case 'fileRenamed':
                if (currentFileId === msg.fileId) { currentFileId = msg.newFileId; }
                renderFileList(msg.files, currentFileId);
                persistState();
                if (currentFileId === msg.newFileId) { loadCurrentFile(); }
                break;
            case 'fileDeleted':
                if (currentFileId === msg.fileId) {
                    currentFileId = '';
                    clearEditor();
                    syncButtons();
                    persistState();
                }
                break;
            case 'selectFile':
                if (!msg.fileId || (dirty && !confirmDiscard())) { break; }
                dirty = false;
                vscode.postMessage({ type: 'requestData', fileId: msg.fileId });
                break;
        }
    });

    syncButtons();
    vscode.postMessage({ type: 'ready' });

    // ── Splitter logic ──
    (function () {
        const fileListEl = document.getElementById('fileList');
        const vSplitter = document.getElementById('vSplitter');
        let vDragging = false;
        vSplitter.addEventListener('mousedown', function (e) {
            vDragging = true;
            vSplitter.classList.add('dragging');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (vDragging) {
                const newWidth = Math.max(150, Math.min(e.clientX, window.innerWidth - 300));
                fileListEl.style.width = newWidth + 'px';
            }
        });
        document.addEventListener('mouseup', function () {
            if (vDragging) { vDragging = false; vSplitter.classList.remove('dragging'); }
        });
    })();
})();
