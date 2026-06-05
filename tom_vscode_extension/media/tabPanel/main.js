// @ts-nocheck
/* global vscode, __defaultActive */
/*
 * Tab panel behaviour — the static body of getTabPanelScript() in
 * src/handlers/tabPanel.ts (Phase B.24 webview restructuring). The handler
 * prepends a small generated data-prefix that declares `vscode` (single
 * acquireVsCodeApi()) and `__defaultActive`, then appends the consumer's
 * `additionalScript`. Read via readMediaText and inlined into one <script>.
 */

(function() {
    var tabBtns = document.querySelectorAll('.tab-btn');

    function switchTab(tabId) {
        tabBtns.forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var btn = document.querySelector('.tab-btn[data-tab="' + tabId + '"]');
        var content = document.querySelector('[data-tab-content="' + tabId + '"]');
        if (btn && content) { btn.classList.add('active'); content.classList.add('active'); }
        var state = vscode.getState() || {};
        state.activeTab = tabId;
        vscode.setState(state);
    }

    tabBtns.forEach(function(btn) {
        btn.addEventListener('click', function() { switchTab(btn.dataset.tab); });
    });

    // Restore persisted tab or use default
    var s = vscode.getState();
    if (s && s.activeTab) { switchTab(s.activeTab); }
    else { switchTab(__defaultActive); }

    // Action button handler
    document.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (btn) { vscode.postMessage({ type: 'action', action: btn.dataset.action, sectionId: btn.dataset.id }); }
    });
})();
