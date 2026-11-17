// @ts-check
// Placeholder panel while Tom AI does not start — see src/handlers/minimalMode-handler.ts.
// First paint from window.__INIT__ ({ mode: 'setup' } or { mode: 'format', hint }); a `content` message
// replaces it. Buttons wired via addEventListener (no inline handlers), the loader's nonce-only CSP.

(function () {
    const vscode = acquireVsCodeApi();
    /** @param {string} id */
    function $(id) { return /** @type {HTMLElement} */ (document.getElementById(id)); }
    /** @param {string} id @param {string} type */
    function wire(id, type) {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('click', function () { vscode.postMessage({ type: type }); }); }
    }
    wire('setupWorkspaceBtn', 'setupWorkspaceFolder');
    wire('setupBtn', 'openSetupDoc');
    wire('upgradeBtn', 'tomGate.upgradeWorkspace');
    wire('reloadBtn', 'tomGate.reload');
    wire('overlayBtn', 'tomGate.showOverlay');

    /** @param {any} content */
    function render(content) {
        const format = !!content && content.mode === 'format' && !!content.hint;
        $('setupMode').hidden = format;
        $('formatMode').hidden = !format;
        if (!format) { return; }
        const hint = content.hint;
        $('formatTitle').textContent = hint.title || '';
        $('formatText').textContent = hint.text || '';
        $('upgradeBtn').hidden = !hint.upgradeButton;
        $('reloadBtn').hidden = !hint.reloadButton;
        $('overlayBtn').hidden = !hint.overlayButton;
    }

    render(/** @type {any} */ (window).__INIT__ || { mode: 'setup' });
    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && msg.type === 'content') { render(msg.content); }
    });
})();
