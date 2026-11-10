// @ts-nocheck
// @TOM VSC › RESOURCES — this window's extension helper processes, profiles and heavy settings.
// Host: src/handlers/vscResourcesView-handler.ts. The host posts one 'state'
// message per refresh (every 5 s while visible); every button posts back.
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
    /** Groups whose processes are shown (by extension id / label), kept across refreshes. */
    var open = {};
    /** The last state, drawn again when a group is opened or closed. */
    var last = null;

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function mem(kb) {
        var mb = kb / 1024;
        return mb < 1024 ? Math.round(mb) + ' MB' : (mb / 1024).toFixed(1) + ' GB';
    }
    function cpu(v) { return v === null || v === undefined ? '' : v.toFixed(1) + '%'; }
    function btn(icon, title, data) {
        var attrs = Object.keys(data).map(function (k) { return ' data-' + k + '="' + esc(data[k]) + '"'; }).join('');
        return '<button class="icon codicon codicon-' + icon + '" title="' + esc(title) + '"' + attrs + '></button>';
    }
    function actions(canPause, paused, target) {
        var out = '';
        if (canPause) {
            out += paused
                ? btn('debug-continue', 'Resume (SIGCONT): it goes on where it stopped', Object.assign({ act: 'resume' }, target))
                : btn('debug-pause', 'Pause (SIGSTOP): no CPU, memory left to the system; the extension does not notice. Its editor features wait until you resume it.', Object.assign({ act: 'pause' }, target));
        }
        out += btn('close', 'Kill (SIGTERM, asks first): the extension may start it again', Object.assign({ act: 'kill' }, target));
        return out;
    }

    function processesHtml(s) {
        var html = '<h3><span class="grow">Processes of this window\'s extensions</span>' + btn('refresh', 'Refresh now', { refresh: '1' }) + '</h3>';
        if (s.error) { return html + '<div class="note error">The process list could not be read: ' + esc(s.error) + '</div>'; }
        html += '<div class="total">' + esc(s.totalText) + ' in ' + s.processes.length + ' process' + (s.processes.length === 1 ? '' : 'es')
            + (s.host ? ' <span class="muted">(the extension host itself: ' + mem(s.host.rssKb) + ')</span>' : '') + '</div>';
        if (!s.canPause) { html += '<div class="muted">Windows has no pause signal: only Kill is offered.</div>'; }
        if (!s.groups.length) { return html + '<div class="muted">No helper processes.</div>'; }
        s.groups.forEach(function (g) {
            var key = g.extensionId || g.label;
            var target = g.extensionId ? { ext: g.extensionId, label: g.label } : { pids: g.processes.map(function (p) { return p.pid; }).join(','), label: g.label };
            html += '<div class="group">'
                + '<div class="group-head" data-toggle="' + esc(key) + '">'
                + '<span class="codicon codicon-chevron-' + (open[key] ? 'down' : 'right') + '"></span>'
                + '<span class="name' + (g.paused ? ' paused' : '') + '" title="' + esc(g.extensionId || 'not attributed to an extension') + '">' + esc(g.label) + '</span>'
                + (g.paused ? '<span class="badge paused">paused</span>' : '')
                + '<span class="num">' + mem(g.rssKb) + (g.cpu !== null ? ' · ' + cpu(g.cpu) : '') + ' · ' + g.processes.length + '</span>'
                + actions(s.canPause, g.paused, target)
                + '</div>';
            if (open[key]) {
                g.processes.forEach(function (p) {
                    html += '<div class="proc" style="padding-left:' + (6 + 8 * p.depth) + 'px" title="' + esc(p.command) + '">'
                        + '<span class="what' + (p.paused ? ' paused' : '') + '">' + esc(p.owner.kind) + ' <span class="muted">' + p.pid + '</span></span>'
                        + (p.paused ? '<span class="badge paused">paused</span>' : '')
                        + '<span class="num">' + mem(p.rssKb) + (p.cpu !== null ? ' · ' + cpu(p.cpu) : '') + ' · ' + esc(p.elapsed) + '</span>'
                        + actions(s.canPause, p.paused, { pids: String(p.pid), label: p.owner.kind })
                        + '</div>';
                });
            }
            html += '</div>';
        });
        return html;
    }

    function profilesHtml(profiles) {
        var html = '<h3>Profiles</h3><div class="muted">VS Code cannot switch one extension off; a lean profile with fewer extensions enabled can.</div>';
        (profiles || []).forEach(function (p) {
            html += '<div class="profile"><button data-profile="' + esc(p.id) + '" title="' + esc(p.hint) + '"' + (p.available ? '' : ' disabled') + '>' + esc(p.label) + '</button>'
                + (p.available ? '' : ' <span class="muted">not in this VS Code</span>') + '</div>';
        });
        return html;
    }

    function settingControl(r) {
        var dis = r.available ? '' : ' disabled';
        if (r.kind === 'bool' || r.kind === 'glob' || r.kind === 'listItem') {
            return '<input type="checkbox" data-setting="' + esc(r.id) + '"' + (r.value === true ? ' checked' : '') + dis + '>';
        }
        if (r.kind === 'number') {
            return '<input type="number" data-setting="' + esc(r.id) + '" value="' + esc(r.value === null ? '' : r.value) + '"' + dis + '>';
        }
        return '<select data-setting="' + esc(r.id) + '"' + dis + '>' + (r.value === null ? '<option value="" selected>—</option>' : '')
            + (r.options || []).map(function (o) { return '<option value="' + esc(String(o)) + '"' + (String(o) === String(r.value) ? ' selected' : '') + '>' + esc(String(o)) + '</option>'; }).join('')
            + '</select>';
    }

    function settingsHtml(rows) {
        var html = '<h3>Settings (this workspace)</h3>';
        (rows || []).forEach(function (r) {
            html += '<div class="setting' + (r.available ? '' : ' unavailable') + '" title="' + esc(r.key + ' — ' + r.hint + ' Lean: ' + String(r.lean) + (r.available ? '' : ' (its extension is not installed)')) + '">'
                + settingControl(r)
                + '<label>' + esc(r.label) + (r.inWorkspace ? ' <span class="ws">workspace</span>' : '') + '</label>'
                + '</div>';
        });
        return html;
    }

    function render(msg) {
        last = msg;
        var html = '';
        if (msg.note) { html += '<div class="note' + (msg.note.error ? ' error' : '') + '">' + esc(msg.note.text) + '</div>'; }
        html += processesHtml(msg.snapshot) + profilesHtml(msg.profiles) + settingsHtml(msg.settings);
        root.innerHTML = html;
    }

    root.addEventListener('click', function (e) {
        var t = e.target;
        var toggle = t.closest && t.closest('[data-toggle]');
        var act = t.closest && t.closest('[data-act]');
        if (act) {
            e.stopPropagation();
            var msg = { type: 'act', action: act.dataset.act, label: act.dataset.label || '' };
            if (act.dataset.ext !== undefined) { msg.extensionId = act.dataset.ext; }
            else { msg.pids = String(act.dataset.pids || '').split(',').filter(Boolean).map(Number); }
            vscode.postMessage(msg);
            return;
        }
        if (t.closest && t.closest('[data-refresh]')) { vscode.postMessage({ type: 'refresh' }); return; }
        var profile = t.closest && t.closest('[data-profile]');
        if (profile) { vscode.postMessage({ type: 'profile', command: profile.dataset.profile }); return; }
        if (toggle) {
            var key = toggle.dataset.toggle;
            open[key] = !open[key];
            if (last) { render(last); }
        }
    });
    root.addEventListener('change', function (e) {
        var t = e.target;
        if (!t.dataset || !t.dataset.setting) { return; }
        var value = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
        vscode.postMessage({ type: 'setting', id: t.dataset.setting, value: value });
    });
    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (msg && msg.type === 'state') { render(msg); }
    });
    vscode.postMessage({ type: 'ready' });
})();
