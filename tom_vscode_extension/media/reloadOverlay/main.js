// @ts-nocheck
// The reload overlay — see src/handlers/reloadOverlay-handler.ts (vscimpb142b).
// state: { version, text, rows: [{ id, label, cls, run, session, title, running, chat, gone }], idle }.
// The page posts ready, interrupt { id, chat }, reload.
(function () {
    var vscode = acquireVsCodeApi();
    function $(id) { return document.getElementById(id); }
    var state = window.__INIT__ || { version: 0, text: '', rows: [], idle: true };
    /** The ids whose Interrupt was pressed (the button waits for the queue to answer). */
    var pressed = {};

    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function render() {
        var s = state;
        $('roTitle').textContent = 'The workspace has been migrated to version ' + s.version;
        $('roText').textContent = s.text || '';
        var rows = s.rows || [];
        var running = rows.filter(function (r) { return r.running; }).length;
        $('roIdle').textContent = s.idle
            ? 'Nothing runs any more: reload now.'
            : running + ' prompt(s) still running: let them finish or interrupt them, then reload.';
        $('roIdle').className = 'ro-idle' + (s.idle ? ' ro-ready' : '');
        $('roEmpty').hidden = rows.length > 0;
        $('roList').hidden = rows.length === 0;
        $('roRows').innerHTML = rows.map(function (r) {
            var button = r.running
                ? '<button class="ro-interrupt" data-id="' + esc(r.id) + '" data-chat="' + (r.chat ? '1' : '') + '"' + (pressed[r.id] ? ' disabled' : '') + '>'
                    + (pressed[r.id] ? 'Interrupting…' : 'Interrupt') + '</button>'
                : '';
            return '<tr class="' + (r.running ? 'ro-running' : 'ro-done') + '" data-id="' + esc(r.id) + '">'
                + '<td><span class="' + esc(r.cls) + '">' + esc(r.label) + '</span></td>'
                + '<td>' + esc(r.run) + '</td><td>' + esc(r.session) + '</td>'
                + '<td class="ro-prompt">' + esc(r.title) + '</td><td>' + button + '</td></tr>';
        }).join('');
    }

    $('roRows').addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('.ro-interrupt') : null;
        if (!b || b.disabled) { return; }
        var id = b.getAttribute('data-id');
        pressed[id] = true;
        vscode.postMessage({ type: 'interrupt', id: id, chat: b.getAttribute('data-chat') === '1' });
        render();
    });
    $('roReload').addEventListener('click', function () { vscode.postMessage({ type: 'reload' }); });
    window.addEventListener('message', function (e) {
        var m = e.data || {};
        if (m.type === 'state') {
            state = m.state || state;
            (state.rows || []).forEach(function (r) { if (!r.running) { delete pressed[r.id]; } });
            render();
        }
    });
    render();
    vscode.postMessage({ type: 'ready' });
})();
