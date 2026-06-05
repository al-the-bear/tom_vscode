// @ts-nocheck
// notepad webview client (shared by both providers: the Workspace Notepad in the
// Explorer sidebar and the Tom Notepad in the bottom panel).
//
// Verbatim extraction of the inline <script> from `_getHtmlContent` in
// src/handlers/notepad-handler.ts, with two changes for the media-loader model:
//   1. first-paint data (persisted content + per-provider placeholder) now
//      arrives via window.__INIT__ instead of being string-substituted into the
//      HTML, so the textarea ships empty and is populated here;
//   2. window.__tomVscodeApi is published so the shared completion component
//      (media/shared/completion.js) reuses the single acquireVsCodeApi() handle.
// @ts-nocheck because it touches ambient DOM globals without strict checkJs
// typings (consistent with the other Phase B verbatim extractions).

const vscode = acquireVsCodeApi();
window.__tomVscodeApi = vscode; // shared completion.js reads this

const init = window.__INIT__ || {};

const notepad = document.getElementById('notepad');
const charCount = document.getElementById('charCount');
const selCount = document.getElementById('selCount');
const sendBtn = document.getElementById('sendBtn');
const copyBtn = document.getElementById('copyBtn');
const clearBtn = document.getElementById('clearBtn');

// First paint: per-provider placeholder + persisted content (was previously
// string-substituted into the HTML; now delivered via window.__INIT__).
notepad.placeholder = init.placeholderText || '';
notepad.value = init.content || '';

let saveTimeout;

function updateCharCount() {
    charCount.textContent = notepad.value.length;
}

function updateSelCount() {
    const start = notepad.selectionStart;
    const end = notepad.selectionEnd;
    selCount.textContent = end - start;
}

function getSelectedOrAll() {
    const start = notepad.selectionStart;
    const end = notepad.selectionEnd;
    if (start !== end) {
        return notepad.value.substring(start, end);
    }
    return notepad.value;
}

function saveContent() {
    vscode.postMessage({ type: 'save', content: notepad.value });
}

function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveContent, 500);
}

notepad.addEventListener('input', () => {
    updateCharCount();
    updateSelCount();
    debouncedSave();
});

notepad.addEventListener('select', updateSelCount);
notepad.addEventListener('click', updateSelCount);
notepad.addEventListener('keyup', updateSelCount);

sendBtn.addEventListener('click', () => {
    const selected = getSelectedOrAll();
    vscode.postMessage({
        type: 'sendToChat',
        content: notepad.value,
        selectedText: notepad.selectionStart !== notepad.selectionEnd ? selected : null
    });
});

copyBtn.addEventListener('click', () => {
    const selected = getSelectedOrAll();
    vscode.postMessage({
        type: 'copyToClipboard',
        content: notepad.value,
        selectedText: notepad.selectionStart !== notepad.selectionEnd ? selected : null
    });
});

clearBtn.addEventListener('click', () => {
    if (notepad.value.trim() === '' || confirm('Clear all content?')) {
        notepad.value = '';
        updateCharCount();
        updateSelCount();
        vscode.postMessage({ type: 'clear' });
    }
});

// Handle messages from extension
window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
        case 'restore':
            notepad.value = message.content || '';
            updateCharCount();
            updateSelCount();
            break;
        case 'cleared':
            notepad.value = '';
            updateCharCount();
            updateSelCount();
            break;
    }
});

// Initial counts
updateCharCount();
updateSelCount();
