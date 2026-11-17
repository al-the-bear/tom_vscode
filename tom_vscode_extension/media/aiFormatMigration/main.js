// @ts-nocheck
// Upgrade the workspace (the _ai format migration) — see src/handlers/aiFormatMigration-handler.ts.
// The host sends `state` { phase, from, to, reason, reportHtml, changes, problems, windows, holder, message };
// phase: review (the dry run shown), running, done, failed, locked (another window migrates), current, newer.
// The page posts ready, apply, openReport, reload, close.
(function () {
    var vscode = acquireVsCodeApi();
    function $(id) { return document.getElementById(id); }
    var state = window.__INIT__ || { phase: 'review' };

    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function show(id, on) { $(id).hidden = !on; }

    function render() {
        var s = state;
        var from = s.from === undefined || s.from === null ? 'none' : s.from;
        $('fmTitle').textContent = s.phase === 'done' ? 'The workspace is upgraded' : 'Upgrade the workspace to format version ' + s.to;
        var intro = '';
        if (s.phase === 'review' || s.phase === 'running') {
            intro = s.reason === 'local'
                ? 'The shared _ai files are already in format version ' + s.to + ', but this machine\'s own files (queue, chat variables, sessions) are not (version ' + from + '). The migration brings them up to date.'
                : 'The _ai files of this workspace are in format version ' + from + '; this Tom AI build works with version ' + s.to + '. Below is what the migration changes (a dry run: nothing is written yet).';
        } else if (s.phase === 'done') {
            intro = 'Migrated to format version ' + s.to + ': ' + s.changes + ' change(s). Reload this window so every part of Tom AI reads the new files.';
        } else if (s.phase === 'failed') {
            intro = 'The migration stopped with problems: the files listed below stay as they are, and the format stamp is not written.';
        } else if (s.phase === 'locked') {
            intro = 'A migration is already running in another window (' + esc(s.holder || '') + '). Wait for it to finish, then reload.';
        } else if (s.phase === 'current') {
            intro = 'The workspace is already in format version ' + s.to + ': nothing to migrate.';
        } else if (s.phase === 'newer') {
            intro = 'The _ai files are newer than this Tom AI build understands. Install the newer build and reload; a migration cannot go back.';
        }
        $('fmIntro').innerHTML = esc(intro);
        show('fmWarning', s.phase === 'review');
        show('fmConfirmLabel', s.phase === 'review');
        show('fmApply', s.phase === 'review' || s.phase === 'running');
        $('fmApply').disabled = s.phase !== 'review' || !$('fmConfirm').checked || s.problems > 0;
        $('fmApply').textContent = s.phase === 'running' ? 'Migrating…' : 'Migrate now';
        show('fmReload', s.phase === 'done' || s.phase === 'locked');
        show('fmReport', !!s.reportHtml);
        $('fmClose').textContent = s.phase === 'done' ? 'Close' : 'Not now';
        show('fmMessage', !!s.message);
        $('fmMessage').textContent = s.message || '';
        var windows = s.windows || [];
        show('fmWindows', windows.length > 0 && (s.phase === 'review' || s.phase === 'done'));
        $('fmWindows').innerHTML = '<b>Other windows on this workspace</b> (they pause their runs and ask for a reload after the migration):<ul>'
            + windows.map(function (w) { return '<li>' + esc(w.label) + '</li>'; }).join('') + '</ul>';
        $('fmReportBody').innerHTML = s.reportHtml || '';
    }

    $('fmConfirm').addEventListener('change', render);
    $('fmApply').addEventListener('click', function () {
        if ($('fmApply').disabled) { return; }
        state.phase = 'running';
        render();
        vscode.postMessage({ type: 'apply' });
    });
    $('fmReport').addEventListener('click', function () { vscode.postMessage({ type: 'openReport' }); });
    $('fmReload').addEventListener('click', function () { vscode.postMessage({ type: 'reload' }); });
    $('fmClose').addEventListener('click', function () { vscode.postMessage({ type: 'close' }); });
    window.addEventListener('message', function (e) {
        var m = e.data || {};
        if (m.type === 'state') { state = m.state || state; render(); }
    });
    render();
    vscode.postMessage({ type: 'ready' });
})();
