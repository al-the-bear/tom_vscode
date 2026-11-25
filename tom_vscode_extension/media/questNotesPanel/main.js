// @ts-nocheck
// QUEST NOTES side panel (@TOM INFO, view tomAi.questNotesPanel) —
// src/handlers/questNotesPanel-handler.ts.
//
// The bar's picker lists the quest's notes files (the default first); a change
// saves the text and posts 'selectNotesFile', the New button posts
// 'newNotesFile' (the host asks for the name). Both wait while the conflict bar
// asks. Everything else acts on the file picked.
//
// Edit tab: a text area on the notes file picked, saved after a short
// pause in typing and on blur ('save'). The host sends the file as
// 'notesState' when the view opens and whenever it changes on disk; a change
// is taken in unless the text area holds unsaved edits, then the conflict bar
// asks (Load the file / Keep my text).
//
// View tab: the MD Browser's renderer. This script loads its scripts and
// styles from window.__INIT__ (in order, with this page's nonce); they wire
// the View tab's bar and #contentArea by id and render the host's
// 'mdContent'. The page acquires the VS Code API once and publishes it as
// window.__tomVscodeApi, which the MD Browser's main.js, completion.js and
// questHint.js reuse. The chosen tab is kept in the webview state (qnpTab),
// merged with what the renderer keeps there.

(function () {
    var vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode;
    window.vscode = vscode;
    var nonce = document.currentScript ? document.currentScript.nonce : '';
    var init = window.__INIT__ || {};

    var SAVE_DELAY_MS = 500;
    var bar = document.querySelector('.qnp-bar');
    var empty = document.getElementById('qnpEmpty');
    var fileEl = document.getElementById('qnpFile');
    var fileSelect = document.getElementById('notesFileSelect');
    var newFileBtn = document.getElementById('newNotesFileBtn');
    var conflictBar = document.getElementById('conflictBar');
    var editPane = document.getElementById('editPane');
    var viewPane = document.getElementById('viewPane');
    var text = document.getElementById('notesText');
    var status = document.getElementById('qnpStatus');
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.qnp-tab'));

    function getState() { return vscode.getState() || {}; }
    function putState(patch) { vscode.setState(Object.assign({}, getState(), patch)); }

    // ---- Tabs ----
    var tab = getState().qnpTab === 'view' ? 'view' : 'edit';
    var hasQuest = false;
    function showTab(next) {
        if (next !== tab && tab === 'edit') { saveNow(); }
        tab = next;
        tabs.forEach(function (b) {
            var on = b.dataset.tab === tab;
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
        });
        editPane.hidden = !hasQuest || tab !== 'edit';
        viewPane.hidden = !hasQuest || tab !== 'view';
        putState({ qnpTab: tab });
    }
    tabs.forEach(function (b) {
        b.addEventListener('click', function () { showTab(b.dataset.tab); });
        b.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                var next = tab === 'edit' ? 'view' : 'edit';
                showTab(next);
                document.querySelector('.qnp-tab[data-tab="' + next + '"]').focus();
            }
        });
    });

    // ---- Edit ----
    var synced = '';          // what the file holds as far as this page knows
    var pendingDisk = null;   // a change on disk held while the text area has unsaved edits
    var saveTimer = null;
    function dirty() { return text.value !== synced; }
    function showStatus() {
        status.textContent = text.value.length + ' chars' + (dirty() ? ' · unsaved' : '');
    }
    function saveNow() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (pendingDisk !== null || !dirty()) { return; }
        synced = text.value;
        vscode.postMessage({ type: 'save', content: synced });
        showStatus();
    }
    text.addEventListener('input', function () {
        if (saveTimer) { clearTimeout(saveTimer); }
        saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
        showStatus();
    });
    text.addEventListener('blur', saveNow);

    function setText(content) {
        var focused = document.activeElement === text;
        var start = text.selectionStart;
        var end = text.selectionEnd;
        text.value = content;
        synced = content;
        if (focused) {
            text.selectionStart = Math.min(start, content.length);
            text.selectionEnd = Math.min(end, content.length);
        }
        showStatus();
    }
    function askAboutDisk(content) {
        pendingDisk = content;
        conflictBar.hidden = false;
        fileSelect.disabled = true;
        newFileBtn.disabled = true;
    }
    function closeConflict() {
        pendingDisk = null;
        conflictBar.hidden = true;
        fileSelect.disabled = false;
        newFileBtn.disabled = false;
    }
    document.getElementById('loadDiskBtn').addEventListener('click', function () {
        var content = pendingDisk;
        closeConflict();
        if (content !== null) { setText(content); }
    });
    document.getElementById('keepMineBtn').addEventListener('click', function () {
        if (pendingDisk !== null) { synced = pendingDisk; }
        closeConflict();
        saveNow();
    });

    document.getElementById('openEditorBtn').addEventListener('click', function () {
        saveNow();
        vscode.postMessage({ type: 'openInEditor' });
    });
    document.getElementById('openMdBrowserBtn').addEventListener('click', function () {
        saveNow();
        vscode.postMessage({ type: 'openInMdBrowser' });
    });

    // ---- The notes files of the quest ----
    var shownFile = '';       // the path of the file the text area holds
    function showFiles(files, selected) {
        fileSelect.textContent = '';
        (files || []).forEach(function (f) {
            var o = document.createElement('option');
            o.value = f.name;
            o.textContent = f.name;
            if (f.isDefault) { o.title = 'The default notes file of the quest'; }
            fileSelect.appendChild(o);
        });
        fileSelect.value = selected || '';
    }
    fileSelect.addEventListener('change', function () {
        saveNow();
        vscode.postMessage({ type: 'selectNotesFile', name: fileSelect.value });
    });
    newFileBtn.addEventListener('click', function () {
        saveNow();
        vscode.postMessage({ type: 'newNotesFile' });
    });

    window.addEventListener('message', function (e) {
        var msg = e.data || {};
        if (msg.type !== 'notesState') { return; }
        hasQuest = !!msg.hasQuest;
        bar.hidden = !hasQuest;
        empty.hidden = hasQuest;
        if (!hasQuest) { closeConflict(); showTab(tab); return; }
        fileEl.textContent = msg.relativePath || msg.filePath || '';
        fileEl.title = msg.filePath || '';
        showFiles(msg.notesFiles, msg.notesFile);
        var content = typeof msg.content === 'string' ? msg.content : '';
        var otherFile = (msg.filePath || '') !== shownFile;
        shownFile = msg.filePath || '';
        if (otherFile) {
            // Another notes file: its text replaces the one shown (saved before the switch was asked for).
            closeConflict();
            setText(content);
        } else if (content === synced) {
            // Nothing new: unsaved edits stay; a held change is no longer one.
            if (pendingDisk !== null) { closeConflict(); }
        } else if (dirty()) {
            askAboutDisk(content);
        } else {
            closeConflict();
            setText(content);
        }
        showTab(tab);
    });

    // ---- View: the MD Browser's renderer ----
    function link(href) {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        document.head.appendChild(l);
    }
    if (init.codiconsUri) { link(init.codiconsUri); }
    (init.styles || []).forEach(link);
    (function loadNext(list) {
        if (!list.length) { return; }
        var s = document.createElement('script');
        if (nonce) { s.nonce = nonce; }
        s.src = list[0];
        s.onload = function () { loadNext(list.slice(1)); };
        s.onerror = function () { loadNext(list.slice(1)); };
        document.body.appendChild(s);
    })((init.scripts || []).slice());

    showTab(tab);
    vscode.postMessage({ type: 'ready' });
})();
