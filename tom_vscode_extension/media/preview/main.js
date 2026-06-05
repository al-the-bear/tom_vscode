// @ts-check
// Preview panel webview client — migrated from the inline <script> of
// showPreviewPanel() in src/handlers/handler_shared.ts (Phase B.18 webview
// restructuring).
//
// §3 content-injection panel: the preview text arrives via postMessage
// (setContent) rather than being substituted into the HTML. main.js posts a
// 'ready' handshake on load so the host can reply with the (possibly large)
// content without racing the script registration. The Send button visibility
// comes from window.__INIT__.hasSend (known at first paint). Buttons are wired
// with addEventListener, so the default nonce-only CSP applies.

(function () {
    const vscode = acquireVsCodeApi();
    const init = window.__INIT__ || {};
    const hasSend = init.hasSend === true;

    const contentEl = document.getElementById('content');
    const copyBtn = document.getElementById('copyBtn');
    const sendBtn = document.getElementById('sendBtn');

    if (sendBtn && hasSend) {
        sendBtn.style.display = '';
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'copy' });
        });
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'send' });
        });
    }

    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && msg.type === 'setContent' && contentEl) {
            contentEl.textContent = typeof msg.content === 'string' ? msg.content : '';
        }
    });

    // Ask the host for the content now that the listener is registered.
    vscode.postMessage({ type: 'ready' });
})();
