// @ts-nocheck
// SESSIONS sidebar view — the quest's named sessions.
// Host: src/handlers/sessionsView-handler.ts. The rows arrive as one 'state'
// message (src/utils/sessionsViewRows.ts); Reset and Delete are posted back
// and the host answers with the new state.
/* global acquireVsCodeApi */
(function () {
    var vscode = acquireVsCodeApi();
    // Shared components (media/shared/questHint.js) reuse it: acquireVsCodeApi() may be called only once.
    window.__tomVscodeApi = vscode;
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
        // A process run's sessions (`<session>@<run>`) come after the others, grouped by run.
        var runOf = function (r) { var at = r.name.indexOf('@'); return at > 0 ? r.name.slice(at + 1) : ''; };
        var rows = state.rows.map(function (r, i) { return { r: r, i: i, run: runOf(r) }; });
        rows.sort(function (a, b) { return (a.run === b.run ? 0 : !a.run ? -1 : !b.run ? 1 : a.run < b.run ? -1 : 1) || a.i - b.i; });
        var lastRun = '';
        root.innerHTML = rows.map(function (x) {
            var r = x.r;
            var head = x.run && x.run !== lastRun
                ? '<div class="run-group" title="The sessions the process run ' + esc(x.run) + ' uses: its own conversations, apart from the other runs\'"><span class="codicon codicon-run-all"></span> Run ' + esc(x.run) + '</div>'
                : '';
            lastRun = x.run;
            var shown = x.run ? r.name.slice(0, r.name.length - x.run.length - 1) : r.name;
            var deleteTitle = r.dependents.length
                ? 'Cannot delete: ' + r.dependents.join(', ') + (r.dependents.length === 1 ? ' is' : ' are') + ' based on it'
                : r.usedBy ? 'The ' + r.name + ' session is ' + r.usedBy + '\'s: Reset clears its history'
                : 'Delete the session with its whole storage: history, trails, tool results and quest memory';
            return head + '<div class="session' + (x.run ? ' in-run' : '') + '" data-name="' + esc(r.name) + '">'
                + '<div class="body"><span class="name" title="' + esc(r.name) + '">' + esc(shown) + '</span>'
                + (x.run ? '<span class="tag run" title="The process run ' + esc(x.run) + '\'s session">@' + esc(x.run) + '</span>' : '')
                + (r.usedBy ? '<span class="tag">' + esc(r.usedBy) + '</span>' : '')
                + (r.temporary ? '<span class="tag" title="Created for an item another quest sent; deleted once the item and its notification are done">temporary</span>' : '')
                + (r.todos && r.todos.total ? '<span class="tag todos" title="Session todos: ' + r.todos.open + ' open, ' + r.todos.total + ' in all">☑ ' + r.todos.open + '</span>' : '')
                + '<div class="meta">' + esc(meta(r)) + '</div></div>'
                + '<div class="actions">'
                + '<button class="icon" data-op="reset" title="Reset: forget the conversation (its history and SDK session); keep base, lifetime, profile, trails and memory"'
                + ((r.hasFile && r.hasConversation) || r.usedBy ? '' : ' disabled') + '><span class="codicon codicon-debug-restart"></span></button>'
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
