// @ts-nocheck
// SESSIONS sidebar view — the quest's named sessions.
// Host: src/handlers/sessionsView-handler.ts. The rows arrive as one 'state'
// message (src/utils/sessionsViewRows.ts); Reset and Delete are posted back
// and the host answers with the new state.
/* global acquireVsCodeApi */
(function () {
    var vscode = acquireVsCodeApi();
    var INIT = window.__INIT__ || {};
    if (INIT.codiconsUri) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = INIT.codiconsUri;
        document.head.appendChild(link);
    }
    var root = document.getElementById('root');

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function when(iso) {
        if (!iso) { return ''; }
        var d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toLocaleString();
    }

    /** One row's description line: base, lifetime, profile / model, conversation, last use. */
    function meta(r) {
        var parts = [];
        if (r.basedOn) { parts.push('based on ' + r.basedOn); }
        if (r.lifetime) { parts.push(r.lifetime); }
        if (r.profileId || r.model) { parts.push((r.profileId || '') + (r.model ? (r.profileId ? ' · ' : '') + r.model : '')); }
        parts.push(r.hasConversation ? 'has a conversation' : 'no conversation yet');
        if (r.lastUse) { parts.push('used ' + when(r.lastUse)); }
        return parts.join(' — ');
    }

    function render(state) {
        if (!state.quest) {
            root.innerHTML = '<div class="muted">No active quest.</div>';
            return;
        }
        root.innerHTML = state.rows.map(function (r) {
            var deleteTitle = r.dependents.length
                ? 'Cannot delete: ' + r.dependents.join(', ') + (r.dependents.length === 1 ? ' is' : ' are') + ' based on it'
                : 'Delete the session file (its history folder stays)';
            return '<div class="session" data-name="' + esc(r.name) + '">'
                + '<div class="body"><span class="name">' + esc(r.name) + '</span>'
                + (r.usedBy ? '<span class="tag">' + esc(r.usedBy) + '</span>' : '')
                + (r.temporary ? '<span class="tag" title="Created for an item another quest sent; deleted once the item and its notification are done">temporary</span>' : '')
                + '<div class="meta">' + esc(meta(r)) + '</div></div>'
                + '<div class="actions">'
                + '<button class="icon" data-op="reset" title="Reset: forget the conversation, keep base, lifetime and profile"'
                + (r.hasFile && r.hasConversation ? '' : ' disabled') + '><span class="codicon codicon-debug-restart"></span></button>'
                + '<button class="icon" data-op="delete" title="' + esc(deleteTitle) + '"'
                + (r.hasFile && !r.dependents.length ? '' : ' disabled') + '><span class="codicon codicon-trash"></span></button>'
                + '</div></div>';
        }).join('');
    }

    root.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-op]');
        if (!btn || btn.disabled) { return; }
        var row = btn.closest('.session');
        vscode.postMessage({ type: btn.dataset.op, name: row.dataset.name });
    });

    window.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'state') { render(e.data); }
    });
    vscode.postMessage({ type: 'ready' });
})();
