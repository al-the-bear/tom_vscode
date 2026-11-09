// @ts-nocheck
// Provider SDKs — see src/handlers/providerSdks-handler.ts. The host sends
// `state` { rows, busy, folder, platform, lastCheckedAt, log, message,
// noneInstalled } and `log` { line }; the page posts ready, checkUpdates,
// apply { install, remove }, update { id }, reinstall { id }, updateAll.
(function () {
    var vscode = acquireVsCodeApi();
    function $(id) { return document.getElementById(id); }
    var current = window.__INIT__ || { rows: [] };
    // The user's checkbox choices: provider id -> wanted installed (absent: as installed).
    var wanted = {};

    function esc(s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function changes() {
        var install = [];
        var remove = [];
        (current.rows || []).forEach(function (r) {
            if (!Object.prototype.hasOwnProperty.call(wanted, r.id)) { return; }
            if (wanted[r.id] && !r.installed) { install.push(r.id); }
            if (!wanted[r.id] && r.installed) { remove.push(r.id); }
        });
        return { install: install, remove: remove };
    }

    function render() {
        var rows = current.rows || [];
        // A choice that now matches what is installed is no longer a change.
        rows.forEach(function (r) {
            if (Object.prototype.hasOwnProperty.call(wanted, r.id) && wanted[r.id] === r.installed) { delete wanted[r.id]; }
        });
        $('psRows').innerHTML = rows.map(function (r) {
            var checked = Object.prototype.hasOwnProperty.call(wanted, r.id) ? wanted[r.id] : r.installed;
            var pending = Object.prototype.hasOwnProperty.call(wanted, r.id)
                ? '<span class="ps-pending">' + (wanted[r.id] ? 'to install' : 'to uninstall') + '</span>' : '';
            return '<tr>'
                + '<td><input type="checkbox" class="ps-check" data-id="' + esc(r.id) + '"' + (checked ? ' checked' : '') + (current.busy ? ' disabled' : '') + '></td>'
                + '<td><div class="ps-name">' + esc(r.name) + '</div><div class="ps-desc">' + esc(r.description) + '</div></td>'
                + '<td>' + (r.installed ? esc(r.installedLabel) + (r.updated ? ' <span class="ps-muted">(updated)</span>' : '') : '<span class="ps-muted">not installed</span>') + ' ' + pending + '</td>'
                + '<td class="ps-muted">' + esc(r.pinnedLabel) + ' · ' + r.packageCount + ' packages</td>'
                + '<td>' + (r.updateLabel ? '<button class="ps-update' + (r.updateMajor ? ' major' : '') + '" data-id="' + esc(r.id) + '"' + (current.busy ? ' disabled' : '')
                    + ' title="' + (r.updateMajor ? 'A new major version: it may change the API this build of the extension uses. Install it to try; Install this build&#39;s versions goes back.' : 'Install this update') + '">update to ' + esc(r.updateLabel) + (r.updateMajor ? ' (new major)' : '') + '</button>' : '')
                + (r.installed && r.installedLabel !== r.pinnedLabel ? ' <button class="ps-reinstall" data-id="' + esc(r.id) + '"' + (current.busy ? ' disabled' : '') + ' title="Install the versions this build is tested with">install this build&#39;s versions</button>' : '') + '</td>'
                + '</tr>';
        }).join('');
        var c = changes();
        $('psApply').disabled = !!current.busy || (c.install.length + c.remove.length === 0);
        $('psUpdateAll').disabled = !!current.busy || !rows.some(function (r) { return !!r.updateLabel; });
        $('psCheck').disabled = !!current.busy || !rows.some(function (r) { return r.installed; });
        $('psChecked').textContent = current.busy ? 'Working…' : (current.lastCheckedAt ? 'Checked ' + new Date(current.lastCheckedAt).toLocaleString() : '');
        $('psNone').hidden = !current.noneInstalled;
        $('psFolder').textContent = current.folder || '';
        $('psPlatform').textContent = current.platform || '';
        var m = $('psMessage');
        m.hidden = !current.message;
        if (current.message) {
            m.textContent = current.message.text;
            m.className = 'ps-message ' + (current.message.kind === 'error' ? 'error' : 'info');
        }
        var log = $('psLog');
        log.hidden = !(current.log && current.log.length);
        log.textContent = (current.log || []).join('\n');
    }

    document.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('ps-check')) {
            wanted[t.getAttribute('data-id')] = !!t.checked;
            render();
        }
    });
    document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!t || t.disabled) { return; }
        if (t.id === 'psApply') { var c = changes(); wanted = {}; vscode.postMessage({ type: 'apply', install: c.install, remove: c.remove }); }
        else if (t.id === 'psUpdateAll') { vscode.postMessage({ type: 'updateAll' }); }
        else if (t.id === 'psCheck') { vscode.postMessage({ type: 'checkUpdates' }); }
        else if (t.classList.contains('ps-update')) { vscode.postMessage({ type: 'update', id: t.getAttribute('data-id') }); }
        else if (t.classList.contains('ps-reinstall')) { vscode.postMessage({ type: 'reinstall', id: t.getAttribute('data-id') }); }
    });
    window.addEventListener('message', function (e) {
        var msg = e.data || {};
        if (msg.type === 'state') { current = msg; render(); }
        else if (msg.type === 'log') {
            current.log = (current.log || []).concat([msg.line]);
            var log = $('psLog');
            log.hidden = false;
            log.textContent = current.log.join('\n');
        }
    });
    render();
    vscode.postMessage({ type: 'ready' });
})();
