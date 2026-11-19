// @ts-nocheck
// @TOM INFO › USER NOTIFICATIONS — everything directed at the user, from every
// window on this machine. Host: src/handlers/userNotifications-handler.ts posts
// {type: 'state', rows, open, thisWindow} whenever the shared log or the
// dismissed set changes. One row per event, newest first; an open ask shows how
// long it waits. A click opens the details; Dismiss (row) and Dismiss answered
// (bar) post back; Answer (an open ask, a todo waiting for decisions) posts answer, Continue queue (an answered
// decision whose todo held a queue) posts continueQueue; a click on an open ask of this window posts openAsk; a click on
// an answer (tomAi_answerUser) posts openAnswer.
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
    var bar = document.getElementById('bar');
    var list = document.getElementById('list');
    /** Opened details, by row id, kept across refreshes. */
    var expanded = {};
    var state = null;

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function time(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) { return ''; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        return d.toDateString() === new Date().toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
    function since(iso) {
        var ms = Date.now() - new Date(iso).getTime();
        var min = Math.max(0, Math.floor(ms / 60000));
        if (min < 60) { return min + ' min'; }
        var h = Math.floor(min / 60);
        if (h < 24) { return h + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : ''); }
        return Math.floor(h / 24) + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '');
    }
    function stateBadge(r) {
        if (r.state === 'open') { return '<span class="state state-open" title="Waiting for your answer">open · ' + esc(since(r.at)) + '</span>'; }
        if (r.state === 'answered') { return '<span class="state state-answered" title="' + esc(r.outcome || 'answered') + '">' + (r.todo ? 'decided' : 'answered') + '</span>'; }
        return '';
    }

    function renderBar() {
        var answered = state.rows.filter(function (r) { return r.state !== 'open'; }).length;
        bar.innerHTML = '<span class="summary">' + (state.open ? '<b>' + state.open + ' waiting for you</b>' : '<span class="muted">Nothing waits for you</span>') + '</span>'
            + '<span class="grow"></span>'
            + (answered ? '<button class="icon" data-action="dismissAnswered" title="Dismiss every answered ask and every notice (they stay in NOTIFICATIONS)"><span class="codicon codicon-clear-all"></span></button>' : '');
    }

    function renderList() {
        if (!state.rows.length) {
            list.innerHTML = '<div class="muted">Nothing directed at you on this machine yet.</div>';
            return;
        }
        list.innerHTML = state.rows.map(function (r) {
            var mine = r.windowId === state.thisWindow;
            var details = expanded[r.id]
                ? '<div class="details">' + esc(r.details.join('\n'))
                    + (r.state === 'open' && !mine && r.key ? '<div class="actions muted">From another window (' + esc(r.quest || r.windowId) + '): Answer shows it here.</div>' : '')
                    + '</div>'
                : '';
            // Answer: an open ask (of any window) or a todo waiting for decisions; Continue: the queue an answered decision held.
            var canAnswer = r.state === 'open' && (r.key || r.todo);
            var answerBtn = canAnswer
                ? '<button class="row-action" data-answer="' + esc(r.id) + '" title="' + esc(r.todo
                    ? 'Answer the decisions of todo ' + r.todo.quest + '/' + r.todo.id + ' in the Quest TODO panel (bottom panel)'
                    : (mine ? 'Answer it (where it waits in this window)' : 'Answer it here: the ask is shown in this window, the answer goes to ' + (r.quest || r.windowId))) + '">Answer</button>'
                : '';
            var continueBtn = r.state !== 'open' && r.continueQueue
                ? '<button class="row-action" data-continue="' + esc(r.id) + '" title="' + esc('The decisions are answered: continue run ' + r.continueQueue.run + ' of ' + (r.quest || r.continueQueue.windowId) + ', whose queue waited for them') + '">Continue queue</button>'
                : '';
            return '<div class="row ' + esc(r.state) + '" data-id="' + esc(r.id) + '">'
                + '<div class="row-line"><span class="codicon codicon-' + esc(r.icon) + ' type-' + esc(r.type) + '"></span>'
                + '<span class="title" title="' + esc(r.title) + '">' + esc(r.title) + '</span>'
                + stateBadge(r)
                + answerBtn + continueBtn
                + '<button class="icon dismiss" data-dismiss="' + esc(r.id) + '" title="Dismiss (it stays in NOTIFICATIONS)"><span class="codicon codicon-close"></span></button></div>'
                + '<div class="row-meta"><span>' + esc(time(r.at)) + '</span><span>' + esc(r.quest || r.windowId) + (mine ? ' (this window)' : '') + '</span><span>run ' + esc(r.run) + '</span>'
                + (r.kind ? '<span>' + esc(r.kind) + '</span>' : '') + '</div>'
                + details
                + '</div>';
        }).join('');
    }

    function render() {
        if (!state) { return; }
        renderBar();
        renderList();
    }

    bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button');
        if (btn && btn.getAttribute('data-action') === 'dismissAnswered') { vscode.postMessage({ type: 'dismissAnswered' }); }
    });

    list.addEventListener('click', function (ev) {
        var dismiss = ev.target.closest('[data-dismiss]');
        if (dismiss) { vscode.postMessage({ type: 'dismiss', id: dismiss.getAttribute('data-dismiss') }); return; }
        var answer = ev.target.closest('[data-answer]');
        if (answer) { vscode.postMessage({ type: 'answer', id: answer.getAttribute('data-answer') }); return; }
        var cont = ev.target.closest('[data-continue]');
        if (cont) { vscode.postMessage({ type: 'continueQueue', id: cont.getAttribute('data-continue') }); return; }
        var row = ev.target.closest('.row');
        if (!row) { return; }
        var id = row.getAttribute('data-id');
        expanded[id] = !expanded[id];
        renderList();
        // An open ask of this window opens where it is answered (the user-input panel, the MD Browser).
        var r = state.rows.filter(function (x) { return x.id === id; })[0];
        if (r && expanded[id] && r.state === 'open' && r.key && r.windowId === state.thisWindow) { vscode.postMessage({ type: 'openAsk', id: id }); }
        // An answer opens in the Answers page.
        if (r && expanded[id] && r.type === 'answer' && r.key) { vscode.postMessage({ type: 'openAnswer', id: id }); }
    });

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'state') { state = msg; render(); }
    });
    // How long an ask waits moves on by itself.
    setInterval(function () { if (state && state.open) { renderList(); } }, 30000);
    vscode.postMessage({ type: 'ready' });
})();
