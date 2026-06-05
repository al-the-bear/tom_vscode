// @ts-nocheck
// Status Page bootstrap (standalone webview panel).
//
// Phase B.11 webview restructuring: replaces the inline <script> formerly built
// by getStatusPageHtml() in src/handlers/statusPage-handler.ts. Loaded BEFORE
// listeners.js so the shared globals it publishes are in place when the listener
// functions (and the shared completion component) run:
//   - window.__statusAvailableLlmTools : the LLM tool list, passed via init
//     (listeners.js reads it instead of the former server-side interpolation).
//   - var vscode / window.__tomVscodeApi : the host bridge, reused by
//     listeners.js (ambient global) and media/shared/completion.js.
//
// The data-driven body HTML is generated server-side (getEmbeddedStatusHtml) and
// delivered via postMessage ({type:'statusData', html}) — the §3 content-injection
// pattern, identical to the @WS accordion embed. @ts-nocheck: bootstrap glue that
// references ambient globals declared in the sibling listeners.js script.
/* global attachStatusPanelListeners */

var vscode = acquireVsCodeApi();
// Publish the bridge so media/shared/completion.js reuses it (acquireVsCodeApi
// may be called only once per webview).
window.__tomVscodeApi = vscode;

// First-paint data. listeners.js reads window.__statusAvailableLlmTools at the
// top of its LLM-configs editor block, so it MUST be set before that runs.
var __INIT__ = window.__INIT__ || {};
window.__statusAvailableLlmTools = __INIT__.availableLlmTools || [];

// Inject a fresh status body and (re)wire its listeners, preserving the
// collapse/expand state of any sections already on screen — mirrors the @WS
// accordion's statusData handler so refresh does not reset the user's view.
function applyStatusData(html) {
    var panel = document.getElementById('settings-status-panel');
    if (!panel) { return; }

    var savedCollapseStates = {};
    panel.querySelectorAll('.sp-collapse-content').forEach(function (el) {
        if (el.id) { savedCollapseStates[el.id] = el.classList.contains('sp-collapsed'); }
    });

    panel.innerHTML = html || '<div class="sp-loading">No data</div>';

    Object.keys(savedCollapseStates).forEach(function (elId) {
        var el = document.getElementById(elId);
        if (!el) { return; }
        var icon = el.previousElementSibling
            ? el.previousElementSibling.querySelector('.sp-collapse-icon')
            : null;
        if (savedCollapseStates[elId]) {
            el.classList.add('sp-collapsed');
            if (icon) { icon.textContent = '▶'; }
        } else {
            el.classList.remove('sp-collapsed');
            if (icon) { icon.textContent = '▼'; }
        }
    });

    // attachStatusPanelListeners is defined in the sibling listeners.js.
    if (typeof attachStatusPanelListeners === 'function') {
        attachStatusPanelListeners();
    }
}

window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || !msg.type) { return; }
    if (msg.type === 'statusData') {
        applyStatusData(msg.html);
    }
});

// Pull the initial render (race-free: the host replies once this listener is
// registered, rather than us depending on a push that may arrive pre-load).
vscode.postMessage({ type: 'getStatusData' });
