// @ts-nocheck
// @TOM VSC › PREREQUISITES — the workspace's prerequisites.yaml files as a tree with their checks.
// Host: src/handlers/prerequisitesView-handler.ts. The host posts one 'state' message (on open, on a file
// change, while a check runs); the buttons post back. No value of a secret ever reaches this page.
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
    var last = null;
    /** Open nodes (from global storage, changed here and told to the host). */
    var expanded = {};
    /** Nodes whose details are shown (this page only). */
    var details = {};

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function btn(icon, title, data) {
        var attrs = Object.keys(data).map(function (k) { return ' data-' + k + '="' + esc(data[k]) + '"'; }).join('');
        return '<button class="icon codicon codicon-' + icon + '" title="' + esc(title) + '"' + attrs + '></button>';
    }
    var MARK = { set: '✓', missing: '✗', unknown: '?' };
    function mark(status, title) {
        var s = status || 'unknown';
        return '<span class="mark ' + s + '" title="' + esc(title || s) + '">' + MARK[s] + '</span>';
    }
    /** Default: repositories open, everything else closed; the without-file group closed. */
    function isOpen(key, byDefault) {
        return Object.prototype.hasOwnProperty.call(expanded, key) ? !!expanded[key] : !!byDefault;
    }
    function counts(r) {
        var req = r.set + r.missing + r.unknown;
        return '<span class="num" title="required available / required; ' + r.total + ' in all">' + r.set + '/' + req + '</span>';
    }
    function when(iso) {
        if (!iso) { return ''; }
        var d = new Date(iso);
        return d.toLocaleString();
    }
    function para(label, text) {
        return text ? '<div class="para"><span class="label">' + esc(label) + '</span> ' + esc(text) + '</div>' : '';
    }
    function resultBlock(r) {
        if (!r) { return '<div class="para muted">Not checked yet.</div>'; }
        return '<div class="para"><span class="label">Check</span> ' + mark(r.status) + ' ' + esc(r.detail) + ' <span class="muted">(' + esc(when(r.checkedAt)) + ')</span></div>'
            + (r.warning ? '<div class="para warn">⚠ ' + esc(r.warning) + '</div>' : '');
    }
    /** VS Code and the terminal, for env options and tools. */
    function twoMarks(r) {
        if (!r || r.shell === undefined) { return ''; }
        return '<span class="two">' + mark(r.host, 'VS Code') + '<span class="tiny">VS Code</span>' + mark(r.shell, 'login shell (a terminal)') + '<span class="tiny">terminal</span></span>';
    }
    /** A row with its chevron; `byDefault` is whether the node is open before it was ever toggled. */
    function headRow(key, byDefault, depth, inner, hasChildren) {
        var open = isOpen(key, byDefault);
        return '<div class="row d' + depth + '" data-node="' + esc(key) + '">'
            + (hasChildren ? '<span class="chev codicon codicon-chevron-' + (open ? 'down' : 'right') + '" data-toggle="' + esc(key) + '" data-default="' + (byDefault ? '1' : '') + '"></span>' : '<span class="chev"></span>')
            + inner + '</div>';
    }

    function keepItem(item, f) {
        if (f.requiredOnly && !item.required) { return false; }
        if (f.missingOnly && item.status === 'set') { return false; }
        return true;
    }

    function renderItem(file, item) {
        var key = file.file + '#' + item.nodeId;
        var open = isOpen(key, false);
        var tip = [item.title, item.description, item.result ? item.result.detail : ''].filter(Boolean).join('\n');
        var html = headRow(key, false, 3,
            mark(item.status) + '<span class="name" data-details="' + esc(key) + '" title="' + esc(tip) + '">' + esc(item.title)
            + (item.required ? '' : ' <span class="badge">optional</span>') + ' <span class="muted">' + esc(item.type) + '</span></span>'
            + (item.kind === 'tool' ? twoMarks(item.result) : '')
            + btn('go-to-file', 'Open prerequisites.yaml at this entry', { open: file.file, nodeid: item.nodeId }),
            item.kind === 'secret' && item.options.length > 0);
        if (details[key]) {
            html += '<div class="details d3">' + para('What for', item.description) + para('How to get it', item.obtain)
                + (item.kind === 'tool' ? para('Command', item.command) + para('Custom check', item.check) + resultBlock(item.result) : '') + '</div>';
        }
        if (open && item.kind === 'secret') {
            item.options.forEach(function (o, i) {
                var okey = o.key;
                var otip = [o.description, o.result ? o.result.detail : 'not checked yet'].filter(Boolean).join('\n');
                html += '<div class="row d4">' + '<span class="chev"></span>'
                    + mark(o.result ? o.result.status : 'unknown') + '<span class="name" data-details="' + esc(okey) + '" title="' + esc(otip) + '">'
                    + esc(o.label) + (i === 0 ? ' <span class="badge">default</span>' : '') + '</span>'
                    + (o.via === 'env' ? twoMarks(o.result) : '')
                    + (o.result && o.result.warning ? '<span class="codicon codicon-warning warn" title="' + esc(o.result.warning) + '"></span>' : '')
                    + '</div>';
                if (details[okey]) {
                    var fields = Object.keys(o.fields).map(function (k) { return esc(k) + ': <code>' + esc(o.fields[k]) + '</code>'; }).join(' · ');
                    html += '<div class="details d4">' + para('How', o.description) + (fields ? '<div class="para">' + fields + '</div>' : '') + resultBlock(o.result) + '</div>';
                }
            });
        }
        return html;
    }

    function renderFile(file, f) {
        var key = file.file;
        var open = isOpen(key, false);
        var problems = file.error ? 1 + file.problems.length : file.problems.length;
        var html = headRow(key, false, 1,
            mark(file.error ? 'unknown' : file.rollup.status) + '<span class="name" data-details="' + esc(key) + '" title="' + esc(file.relDir) + '">' + esc(file.name) + '</span>'
            + (problems ? '<span class="codicon codicon-warning warn" title="' + esc((file.error ? file.error + '\n' : '') + file.problems.map(function (p) { return p.path + ': ' + p.message; }).join('\n')) + '"></span>' : '')
            + counts(file.rollup) + btn('edit', 'Edit prerequisites.yaml', { open: file.file }),
            file.sections.length > 0);
        if (details[key]) {
            html += '<div class="details d1"><div class="para muted">' + esc(file.relDir) + '/prerequisites.yaml</div>'
                + (file.error ? '<div class="para warn">' + esc(file.error) + '</div>' : '')
                + file.problems.map(function (p) { return '<div class="para warn">' + esc(p.path) + ': ' + esc(p.message) + '</div>'; }).join('') + '</div>';
        }
        if (!open) { return html; }
        file.sections.forEach(function (s) {
            var items = s.items.filter(function (i) { return keepItem(i, f); });
            if (!items.length && (f.missingOnly || f.requiredOnly)) { return; }
            var skey = file.file + '#' + s.nodeId;
            var sopen = isOpen(skey, true);
            html += headRow(skey, true, 2,
                mark(s.rollup.status) + '<span class="name" data-details="' + esc(skey) + '" title="' + esc(s.description || s.title) + '">' + esc(s.title) + '</span>'
                + counts(s.rollup) + btn('go-to-file', 'Open prerequisites.yaml at this section', { open: file.file, nodeid: s.nodeId }), items.length > 0);
            if (details[skey]) { html += '<div class="details d2">' + para('', s.description) + '</div>'; }
            if (sopen) { items.forEach(function (i) { html += renderItem(file, i); }); }
        });
        return html;
    }

    function fileVisible(file, f) {
        if (!f.missingOnly && !f.requiredOnly) { return true; }
        if (file.error) { return true; }
        return file.sections.some(function (s) { return s.items.some(function (i) { return keepItem(i, f); }); });
    }

    function render() {
        if (!last) { return; }
        var s = last;
        var f = s.filter || {};
        var html = '';
        if (s.note) { html += '<div class="note' + (s.note.error ? ' error' : '') + '">' + esc(s.note.text) + '</div>'; }
        if (s.checking) {
            html += '<div class="bar"><span class="codicon codicon-loading codicon-modifier-spin"></span> Checking ' + s.checking.done + ' / ' + s.checking.total + '…</div>';
        } else if (!s.checkedAt) {
            html += '<div class="start"><button class="primary" data-check="1">Check now</button>'
                + '<div class="muted">Not checked on this installation yet. The check looks at every project\'s prerequisites.yaml and runs a few programs (keychain, CLI logins, ssh-agent); it may take a while. Nothing shows a secret\'s value.</div></div>';
        } else {
            html += '<div class="bar">' + btn('refresh', 'Check again', { check: '1' })
                + '<span class="muted">Last checked ' + esc(when(s.checkedAt)) + (s.durationMs !== null ? ' (' + Math.round(s.durationMs / 100) / 10 + ' s)' : '') + '</span></div>';
        }
        html += '<div class="filters"><label><input type="checkbox" data-filter="missingOnly"' + (f.missingOnly ? ' checked' : '') + '> missing only</label>'
            + '<label><input type="checkbox" data-filter="requiredOnly"' + (f.requiredOnly ? ' checked' : '') + '> required only</label>'
            + mark(s.tree.rollup.status, 'the whole workspace') + counts(s.tree.rollup) + '</div>';
        if (!s.scanned) { html += '<div class="muted">Looking for prerequisites.yaml files…</div>'; }
        else if (!s.tree.repositories.length) { html += '<div class="muted">No project has a prerequisites.yaml yet.</div>'; }
        s.tree.repositories.forEach(function (r) {
            var files = r.files.filter(function (file) { return fileVisible(file, f); });
            if (!files.length) { return; }
            var key = 'repo:' + r.dir;
            var open = isOpen(key, true);
            html += headRow(key, true, 0, mark(r.rollup.status) + '<span class="name repo" title="' + esc(r.relDir) + '">' + esc(r.name) + '</span>' + counts(r.rollup), true);
            if (open) { files.forEach(function (file) { html += renderFile(file, f); }); }
        });
        if (s.tree.withoutFile.length) {
            var wopen = isOpen('without', false);
            html += headRow('without', false, 0, '<span class="name repo muted">Projects without prerequisites.yaml</span><span class="num">' + s.tree.withoutFile.length + '</span>', true);
            if (wopen) {
                s.tree.withoutFile.forEach(function (p) {
                    html += '<div class="row d1"><span class="chev"></span><span class="name" title="' + esc(p.relDir) + '">' + esc(p.name) + ' <span class="muted">' + esc(p.repoName) + '</span></span>'
                        + btn('new-file', 'Create prerequisites.yaml in ' + p.relDir, { create: p.dir }) + '</div>';
                });
            }
        }
        root.innerHTML = html;
    }

    root.addEventListener('click', function (e) {
        var t = e.target.closest('[data-toggle],[data-details],[data-open],[data-create],[data-check]');
        if (!t) { return; }
        if (t.dataset.check) { vscode.postMessage({ type: 'check' }); return; }
        if (t.dataset.toggle) {
            var key = t.dataset.toggle;
            var now = !isOpen(key, t.dataset['default'] === '1');
            expanded[key] = now;
            vscode.postMessage({ type: 'toggle', node: key, expanded: now });
            render();
            return;
        }
        if (t.dataset.open) { vscode.postMessage({ type: 'open', file: t.dataset.open, nodeId: t.dataset.nodeid || undefined }); return; }
        if (t.dataset.create) { vscode.postMessage({ type: 'create', dir: t.dataset.create }); return; }
        if (t.dataset.details) { details[t.dataset.details] = !details[t.dataset.details]; render(); }
    });
    root.addEventListener('change', function (e) {
        var t = e.target;
        if (!t.dataset || !t.dataset.filter || !last) { return; }
        var f = Object.assign({}, last.filter || {});
        f[t.dataset.filter] = t.checked;
        last.filter = f;
        vscode.postMessage({ type: 'filter', filter: f });
        render();
    });
    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (!msg || msg.type !== 'state') { return; }
        last = msg;
        expanded = Object.assign({}, msg.expanded || {}, expanded);
        render();
    });
    vscode.postMessage({ type: 'ready' });
})();
