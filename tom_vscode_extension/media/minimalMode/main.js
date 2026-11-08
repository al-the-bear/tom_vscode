// @ts-check
// Minimal-mode placeholder panel webview client — extracted from the inline
// script of MinimalModeViewProvider._getHtml() in
// src/handlers/minimalMode-handler.ts (Phase B.8 webview restructuring).
// Two buttons wired via addEventListener (no inline handlers), so the panel
// uses the loader's default nonce-only CSP. No first-paint data needed.

(function () {
    const vscode = acquireVsCodeApi();
    const setupWorkspaceBtn = document.getElementById('setupWorkspaceBtn');
    if (setupWorkspaceBtn) {
        setupWorkspaceBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'setupWorkspaceFolder' });
        });
    }
    const setupBtn = document.getElementById('setupBtn');
    if (setupBtn) {
        setupBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'openSetupDoc' });
        });
    }
})();
