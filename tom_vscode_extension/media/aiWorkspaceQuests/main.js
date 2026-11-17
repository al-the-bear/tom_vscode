// @ts-nocheck
// AI Workspace Quests — see src/handlers/aiWorkspaceQuestsEditor-handler.ts (vscimpb144).
// The page posts save { quests }, allQuests, openFile, refresh.
(function () {
    var vscode = acquireVsCodeApi();
    function $(id) { return document.getElementById(id); }
    var state = window.__INIT__ || { quests: [] };
    /** The ticks as the user set them, by quest id. */
    var ticks = {};

    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function adopt(s) {
        state = s || state;
        ticks = {};
        (state.quests || []).forEach(function (q) { ticks[q.id] = !!q.checked; });
    }

    function render() {
        var s = state;
        $('wqTitle').textContent = 'AI Workspace Quests — ' + (s.workspace || '');
        var count = (s.quests || []).filter(function (q) { return ticks[q.id]; }).length;
        $('wqIntro').textContent = s.listed
            ? 'The quests of workspace ' + s.workspace + ' (' + s.file + '): ' + count + ' of ' + (s.quests || []).length + ' ticked. The quest lists of the todo panel, the queue editor, the chat panel and tomAi_listQuests offer these first.'
            : 'Workspace ' + s.workspace + ' has no quest list' + (s.fileExists ? ' in ' + s.file : ' (' + s.file + ' does not exist)') + ': it has every quest. Tick its quests and Save to make one.';
        $('wqMessage').hidden = !s.message;
        $('wqMessage').textContent = s.message || '';
        $('wqError').hidden = !s.error;
        $('wqError').textContent = s.error ? 'The file could not be read: ' + s.error : '';
        $('wqUnknown').hidden = !(s.unknown && s.unknown.length);
        $('wqUnknown').textContent = s.unknown && s.unknown.length ? 'Listed, but no such quest under _ai/quests: ' + s.unknown.join(', ') + ' (kept in the list).' : '';
        var filter = ($('wqFilter').value || '').toLowerCase();
        $('wqRows').innerHTML = (s.quests || []).filter(function (q) {
            return !filter || q.id.toLowerCase().indexOf(filter) >= 0 || String(q.shortDescription || '').toLowerCase().indexOf(filter) >= 0;
        }).map(function (q) {
            var first = String(q.shortDescription || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
            return '<tr><td><input type="checkbox" class="wq-tick" data-id="' + esc(q.id) + '"' + (ticks[q.id] ? ' checked' : '') + '></td>'
                + '<td class="wq-id">' + esc(q.id) + '</td>'
                + '<td class="wq-desc" title="' + esc(q.shortDescription || '') + '">' + esc(first) + '</td></tr>';
        }).join('');
    }

    $('wqRows').addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('wq-tick')) { ticks[t.getAttribute('data-id')] = t.checked; render(); }
    });
    $('wqSave').addEventListener('click', function () {
        vscode.postMessage({ type: 'save', quests: (state.quests || []).filter(function (q) { return ticks[q.id]; }).map(function (q) { return q.id; }) });
    });
    $('wqAll').addEventListener('click', function () { vscode.postMessage({ type: 'allQuests' }); });
    $('wqOpen').addEventListener('click', function () { vscode.postMessage({ type: 'openFile' }); });
    $('wqTickAll').addEventListener('click', function () { (state.quests || []).forEach(function (q) { ticks[q.id] = true; }); render(); });
    $('wqTickNone').addEventListener('click', function () { (state.quests || []).forEach(function (q) { ticks[q.id] = false; }); render(); });
    $('wqFilter').addEventListener('input', render);
    window.addEventListener('message', function (e) {
        var m = e.data || {};
        if (m.type === 'state' && m.state) { adopt(m.state); render(); }
    });
    adopt(state);
    render();
})();
