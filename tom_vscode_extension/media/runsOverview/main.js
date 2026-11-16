// @ts-nocheck
// @TOM INFO › RUNS — every process run of every window on this machine.
// Host: src/handlers/runsOverview-handler.ts posts {type: 'runs', windows}
// (src/utils/runActivity.ts runsOverviewWindows) on every state-file change and
// once per heartbeat interval while shown. A click on a run of this window
// selects it; on another window's run it opens its details in place.
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
    /** Details opened, by `windowId run`, kept across refreshes. */
    var open = {};
    var last = [];

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function age(seconds) {
        if (seconds === undefined || seconds === null) { return ''; }
        if (seconds < 60) { return seconds + 's'; }
        if (seconds < 3600) { return Math.round(seconds / 60) + 'm'; }
        return Math.round(seconds / 3600) + 'h';
    }
    function stateClass(state) { return 'state-' + String(state || 'idle').replace(/ /g, '-'); }

    function runHtml(w, r) {
        var key = w.windowId + ' ' + r.run;
        var where = r.process ? r.process + (r.position ? ' › ' + r.position : '') : 'no process';
        var tip = w.isThisWindow ? (r.current ? 'The run this window works on' : 'Click to work on this run in this window') : 'Click for its details';
        var html = '<div class="run' + (w.isThisWindow && r.current ? ' current' : '') + '" data-window="' + esc(w.windowId) + '" data-run="' + esc(r.run) + '" title="' + esc(tip) + '">'
            + '<div class="run-line"><span class="name">' + esc(r.run) + '</span>'
            + '<span class="subject">' + esc(r.subject || '') + '</span>'
            + '<span class="badge ' + stateClass(r.state) + '">' + esc(r.state) + '</span></div>'
            + '<div class="run-sub">' + esc(where) + (r.detail ? ' — ' + esc(r.detail) : '') + '</div>';
        if (open[key]) {
            html += '<div class="details">'
                + '<div>Window: ' + esc(w.workspace || w.windowId) + ' (' + esc(w.quest || 'no quest') + ')</div>'
                + '<div>Process: ' + esc(where) + '</div>'
                + (r.subject ? '<div>Subject: ' + esc(r.subject) + '</div>' : '')
                + '<div>State: ' + esc(r.state) + (r.detail ? ' — ' + esc(r.detail) : '') + '</div>'
                + '<div>Pending items: ' + esc(r.pending) + '</div>'
                + (r.current ? '<div>The run that window works on.</div>' : '')
                + '</div>';
        }
        return html + '</div>';
    }

    function render(windows) {
        last = windows || [];
        if (!last.length) { root.innerHTML = '<div class="muted">No window of this machine has written its runs yet.</div>'; return; }
        root.innerHTML = last.map(function (w) {
            var tag = w.isThisWindow ? 'this window' : (w.alive ? '' : 'gone, ' + age(w.heartbeatAgeSeconds) + ' ago');
            var runs = (w.runs || []).length
                ? w.runs.map(function (r) { return runHtml(w, r); }).join('')
                : '<div class="run-sub no-runs">No runs reported (an older build, or no quest).</div>';
            return '<div class="window' + (w.alive ? '' : ' gone') + '">'
                + '<div class="window-head"><span class="codicon codicon-window"></span>'
                + '<span class="name" title="' + esc(w.windowId) + '">' + esc(w.quest || w.workspace || w.windowId) + '</span>'
                + (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') + '</div>'
                + runs + '</div>';
        }).join('');
    }

    root.addEventListener('click', function (ev) {
        var el = ev.target.closest('.run');
        if (!el) { return; }
        var windowId = el.getAttribute('data-window');
        var run = el.getAttribute('data-run');
        var w = last.filter(function (x) { return x.windowId === windowId; })[0];
        if (w && w.isThisWindow) {
            vscode.postMessage({ type: 'selectRun', windowId: windowId, run: run });
            return;
        }
        var key = windowId + ' ' + run;
        open[key] = !open[key];
        render(last);
    });

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'runs') { render(msg.windows); }
    });
    vscode.postMessage({ type: 'ready' });
})();
