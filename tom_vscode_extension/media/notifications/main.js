// @ts-nocheck
// @TOM INFO › NOTIFICATIONS — queue and todo events of every window on this machine.
// Host: src/handlers/notifications-handler.ts posts {type: 'state', groups,
// windows, filters, typeInfo, total} whenever the shared log changes; the bar
// posts back the filters (setFilters), Clear (clear) and Show cleared (unclear).
// One line per (merged) event; hover shows its details, a click opens them.
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
    var windowsBox = document.getElementById('windows');
    var list = document.getElementById('list');
    /** Opened details, by group id, kept across refreshes. */
    var open = {};
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
        var today = new Date();
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        return d.toDateString() === today.toDateString() ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    }
    function windowLabel(w) {
        return (w.quest || w.windowId) + (w.isThisWindow ? ' (this window)' : '');
    }

    function renderBar() {
        var f = state.filters;
        var html = state.typeInfo.map(function (t) {
            var on = f.types.indexOf(t.type) >= 0;
            return '<button class="icon type-' + esc(t.type) + (on ? '' : ' off') + '" data-type="' + esc(t.type) + '" title="' + esc(t.label + (on ? ' — shown; click to hide' : ' — hidden; click to show')) + '">'
                + '<span class="codicon codicon-' + esc(t.icon) + '"></span></button>';
        }).join('');
        var someWindows = f.windows.length > 0;
        html += '<span class="grow"></span>'
            + '<button class="icon' + (someWindows ? ' on' : '') + '" data-action="windows" title="' + esc(someWindows ? f.windows.length + ' window(s) shown — choose' : 'Every window — choose windows') + '"><span class="codicon codicon-window"></span>' + (someWindows ? f.windows.length : '') + '</button>'
            + (f.cleared ? '<button class="icon" data-action="unclear" title="Show the cleared events again"><span class="codicon codicon-history"></span></button>' : '')
            + '<button class="icon" data-action="clear" title="Clear: hide the events there are now (this window only; the log stays)"><span class="codicon codicon-clear-all"></span></button>';
        bar.innerHTML = html;
    }

    function renderWindows() {
        var f = state.filters;
        windowsBox.innerHTML = '<div class="muted">Windows shown (none ticked: every window)</div>' + state.windows.map(function (w) {
            var checked = f.windows.indexOf(w.windowId) >= 0 ? ' checked' : '';
            return '<label title="' + esc(w.windowId) + '"><input type="checkbox" data-window="' + esc(w.windowId) + '"' + checked + '>' + esc(windowLabel(w)) + '</label>';
        }).join('');
    }

    function renderList() {
        if (!state.groups.length) {
            list.innerHTML = '<div class="muted">' + (state.total ? 'No event matches the filters.' : 'No queue or todo event yet on this machine.') + '</div>';
            return;
        }
        list.innerHTML = state.groups.map(function (g) {
            var details = g.details.join('\n');
            return '<div class="event" data-id="' + esc(g.id) + '" title="' + esc(details) + '">'
                + '<div class="event-line"><span class="time">' + esc(time(g.last)) + '</span>'
                + '<span class="codicon codicon-' + esc(g.icon) + ' type-' + esc(g.type) + '"></span>'
                + '<span class="text">' + esc(g.line) + '</span>'
                + (g.count > 1 ? '<span class="count">' + g.count + '</span>' : '') + '</div>'
                + (open[g.id] ? '<div class="details">' + esc(details) + '</div>' : '')
                + '</div>';
        }).join('');
    }

    function render() {
        if (!state) { return; }
        renderBar();
        renderWindows();
        renderList();
    }

    function sendFilters(windows, types) {
        vscode.postMessage({ type: 'setFilters', windows: windows, types: types });
    }

    bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button');
        if (!btn || !state) { return; }
        var type = btn.getAttribute('data-type');
        if (type) {
            var types = state.filters.types.slice();
            var at = types.indexOf(type);
            if (at >= 0) { types.splice(at, 1); } else { types.push(type); }
            sendFilters(state.filters.windows, types);
            return;
        }
        var action = btn.getAttribute('data-action');
        if (action === 'windows') { windowsBox.hidden = !windowsBox.hidden; return; }
        if (action === 'clear' || action === 'unclear') { vscode.postMessage({ type: action }); }
    });

    windowsBox.addEventListener('change', function () {
        var ticked = Array.prototype.slice.call(windowsBox.querySelectorAll('input[type=checkbox]:checked')).map(function (i) { return i.getAttribute('data-window'); });
        sendFilters(ticked, state.filters.types);
    });

    list.addEventListener('click', function (ev) {
        var el = ev.target.closest('.event');
        if (!el) { return; }
        var id = el.getAttribute('data-id');
        open[id] = !open[id];
        renderList();
    });

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'state') { state = msg; render(); }
    });
    vscode.postMessage({ type: 'ready' });
})();
