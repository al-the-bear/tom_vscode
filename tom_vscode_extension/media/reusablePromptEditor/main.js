// @ts-nocheck
// Reusable Prompt Editor webview client — extracted from the inline <script> of
// _getHtml() in src/handlers/reusablePromptEditor-handler.ts (Phase B.9 webview
// restructuring). First-paint data (codicons URI) arrives via window.__INIT__;
// scope/file data flows via postMessage. The content textarea is rendered after
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

    let scopeData = {};
    let currentScope = 'global';
    let currentSubScope = 'global';
    let currentFileId = '';
    let currentFiles = [];
    let preferred = {};
    let dirty = false;

    const scopeSelect = document.getElementById('scopeSelect');
    const subScopeSelect = document.getElementById('subScopeSelect');
    const fileList = document.getElementById('fileList');
    const editorArea = document.getElementById('editorArea');
    const saveBar = document.getElementById('saveBar');
    const panelHeadline = document.getElementById('panelHeadline');

    function updateHeadline() {
        const scopeLabels = { global: 'Global', project: 'Project', quest: 'Quest', scan: 'Scan' };
        const label = scopeLabels[currentScope] || currentScope;
        panelHeadline.textContent = label + ' — Reusable Prompt Editor';
    }

    scopeSelect.addEventListener('change', () => {
        if (dirty && !confirmDiscard()) { scopeSelect.value = currentScope; return; }
        currentScope = scopeSelect.value;
        dirty = false;
        updateSubScopeSelect();
        updateHeadline();
        requestFiles();
        editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
        saveBar.style.display = 'none';
        currentFileId = '';
    });

    subScopeSelect.addEventListener('change', () => {
        if (dirty && !confirmDiscard()) { subScopeSelect.value = currentSubScope; return; }
        currentSubScope = subScopeSelect.value;
        dirty = false;
        updateHeadline();
        requestFiles();
        editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
        saveBar.style.display = 'none';
        currentFileId = '';
    });

    document.getElementById('btnAdd').addEventListener('click', () => {
        vscode.postMessage({ type: 'add', scope: currentScope, subScopeId: getSubScopeId() });
    });
    document.getElementById('btnDelete').addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'delete', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
    });
    document.getElementById('btnSave').addEventListener('click', saveFile);
    document.getElementById('btnPreview').addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'openInPreview', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
    });
    document.getElementById('btnOpen').addEventListener('click', () => {
        if (!currentFileId) return;
        vscode.postMessage({ type: 'openInVsCode', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
    });

    // Ctrl/Cmd+S to save
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
    });

    function getSubScopeId() {
        if (currentScope === 'global') return 'global';
        return currentSubScope;
    }

    function updateSubScopeSelect() {
        if (currentScope === 'global') {
            subScopeSelect.style.display = 'none';
            currentSubScope = 'global';
            return;
        }
        const items = scopeData[currentScope] || [];
        if (items.length === 0) {
            subScopeSelect.style.display = 'none';
            subScopeSelect.innerHTML = '';
            currentSubScope = '';
            return;
        }
        subScopeSelect.style.display = '';
        const prevId = preferred[currentScope] || items[0]?.id || '';
        subScopeSelect.innerHTML = items.map(s =>
            '<option value="' + escapeAttr(s.id) + '"' + (s.id === prevId ? ' selected' : '') + '>' +
            escapeText(s.label) + '</option>'
        ).join('');
        currentSubScope = prevId || items[0]?.id || '';
    }

    function requestFiles() {
        vscode.postMessage({ type: 'selectScope', scope: currentScope, subScopeId: getSubScopeId() });
    }

    function renderFileList(files, selectId) {
        currentFiles = files || [];
        if (currentFiles.length === 0) {
            fileList.innerHTML = '<div class="empty">No .prompt.md files in this scope</div>';
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
                vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
            });
        });
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
        vscode.postMessage({
            type: 'save',
            scope: currentScope,
            subScopeId: getSubScopeId(),
            fileId: currentFileId,
            content: ta.value,
        });
        dirty = false;
    }

    function confirmDiscard() { return confirm('Discard unsaved changes?'); }
    function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // ── Messages from extension ──
    window.addEventListener('message', e => {
        const msg = e.data;
        switch (msg.type) {
            case 'allData': {
                scopeData = msg.scopes;
                preferred = msg.preferred || {};
                const initScope = preferred.scope || 'global';
                scopeSelect.value = initScope;
                currentScope = initScope;
                updateSubScopeSelect();

                // If globalFiles were provided, render them immediately
                if (initScope === 'global' && msg.files?.global) {
                    renderFileList(msg.files.global, msg.initialFileId);
                    if (msg.initialFileId) {
                        currentFileId = msg.initialFileId;
                        vscode.postMessage({ type: 'loadFile', scope: 'global', subScopeId: 'global', fileId: msg.initialFileId });
                    }
                } else {
                    requestFiles();
                    if (msg.initialFileId) {
                        // Will be selected when scopeFiles arrives
                        currentFileId = msg.initialFileId;
                    }
                }
                break;
            }
            case 'scopeFiles':
                renderFileList(msg.files, currentFileId);
                if (currentFileId && msg.files.some(f => f.id === currentFileId)) {
                    vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: currentFileId });
                }
                break;
            case 'fileContent':
                renderEditor(msg.fileId, msg.content);
                break;
            case 'selectNewFile':
                currentFileId = msg.fileId;
                renderFileList(currentFiles.concat([{ id: msg.fileId, label: msg.fileId }]), msg.fileId);
                vscode.postMessage({ type: 'loadFile', scope: currentScope, subScopeId: getSubScopeId(), fileId: msg.fileId });
                break;
            case 'fileDeleted':
                currentFileId = '';
                editorArea.innerHTML = '<div class="no-selection">Select a prompt file from the left to edit</div>';
                saveBar.style.display = 'none';
                dirty = false;
                break;
            case 'selectFile':
                if (msg.scope) { currentScope = msg.scope; scopeSelect.value = msg.scope; updateSubScopeSelect(); }
                if (msg.subScopeId) { currentSubScope = msg.subScopeId; subScopeSelect.value = msg.subScopeId; }
                if (msg.fileId) { currentFileId = msg.fileId; }
                requestFiles();
                break;
        }
    });

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
