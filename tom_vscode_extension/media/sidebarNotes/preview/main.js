// @ts-nocheck
// Preview-before-send modal client (showPreviewPanel).
//
// Migrated from the inline <script> of the former template literal in
// src/handlers/sidebarNotes-handler.ts (Phase B.4). The expanded content is
// passed once at first paint via window.__INIT__.content; the user edits it and
// posts { type: 'send', content } or { type: 'cancel' }. Publishes
// window.__tomVscodeApi so the shared completion.js reuses the single
// acquireVsCodeApi() handle.

(() => {
    const vscode = acquireVsCodeApi();
    window.__tomVscodeApi = vscode; // shared completion.js reads this

    const init = window.__INIT__ || {};
    const content = document.getElementById('content');
    content.value = init.content || '';

    document.getElementById('cancelBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });
    document.getElementById('sendBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'send', content: content.value });
    });
})();
