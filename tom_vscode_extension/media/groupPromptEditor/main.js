// @ts-nocheck
// Group prompt editor — see src/handlers/groupPromptEditor-handler.ts. The
// host sends every entry of the global folder and one quest ('load'); the page
// keeps the edited texts until Save (every changed entry at once) or Revert.
// New entries, deleting and switching the quest go through the host. The
// preview is computed by the host from the texts as edited.
/* global acquireVsCodeApi */
(function () {
    var vscode = acquireVsCodeApi();

    function $(id) { return document.getElementById(id); }
    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var entries = [];
    var questId = '';
    /** key → the text as edited (unsaved). */
    var edited = {};
    var selected = '';
    var text = $('text');
    var timer = null;

    function entryOf(key) { return entries.find(function (e) { return e.key === key; }); }
    function isDirty(e) { return edited[e.key] !== e.text; }
    function dirtyEntries() { return entries.filter(isDirty); }

    function label(e) {
        if (e.kind === 'default') { return e.scope === 'quest' ? 'Default (this quest)' : 'Default'; }
        return e.name;
    }

    function item(e) {
        var badge = e.kind === 'default' && !e.exists ? ' <span class="badge">built-in</span>' : '';
        return '<li class="item' + (e.key === selected ? ' selected' : '') + '" data-key="' + esc(e.key) + '">'
            + '<span class="item-name">' + esc(label(e)) + (isDirty(e) ? ' ●' : '') + '</span>' + badge + '</li>';
    }

    function addButton(scope, kind, text) {
        return '<button class="add" data-scope="' + scope + '" data-kind="' + kind + '">＋ ' + esc(text) + '</button>';
    }

    function section(title, scope, kinds) {
        var html = '<div class="section-title">' + esc(title) + '</div>';
        kinds.forEach(function (k) {
            var list = entries.filter(function (e) { return e.scope === scope && e.kind === k.kind; });
            html += '<div class="group-title">' + esc(k.title) + '</div><ul class="list">' + list.map(item).join('') + '</ul>';
            if (k.add && (k.kind !== 'default' || list.length === 0)) { html += addButton(scope, k.kind, k.add); }
        });
        return html;
    }

    function renderList() {
        $('entries').innerHTML =
            section('Global', 'global', [
                { kind: 'default', title: 'Default' },
                { kind: 'addition', title: 'Additions', add: 'Addition' },
            ])
            + (questId ? section('Quest ' + questId, 'quest', [
                { kind: 'default', title: 'Own default (replaces the global one)', add: 'Own default' },
                { kind: 'addition', title: 'Additions', add: 'Addition' },
                { kind: 'prompt', title: 'Prompts (sent instead of the default)', add: 'Prompt' },
            ]) : '<div class="muted pad">No quest: choose one above for its own prompts.</div>');
        var anyDirty = dirtyEntries().length > 0;
        $('save').disabled = !anyDirty;
        $('revert').disabled = !anyDirty;
        var cur = entryOf(selected);
        $('delete').disabled = !cur || !cur.exists;
        // Up / Down: within the entry's own list (its scope and kind); off at the ends.
        var peers = cur ? entries.filter(function (e) { return e.scope === cur.scope && e.kind === cur.kind; }) : [];
        var at = cur ? peers.indexOf(cur) : -1;
        $('moveUp').disabled = at <= 0;
        $('moveDown').disabled = at < 0 || at >= peers.length - 1;
        $('delete').textContent = cur && cur.scope === 'global' && cur.kind === 'default' ? 'Use built-in' : 'Delete';
    }

    function select(key) {
        var e = entryOf(key);
        if (!e) { return; }
        selected = key;
        $('title').textContent = (e.scope === 'global' ? 'Global ' : questId + ' ') + (e.kind === 'default' ? 'default' : e.kind + ' "' + e.name + '"');
        text.value = edited[key];
        renderList();
        vscode.postMessage({ type: 'select', key: key });
        requestPreview();
    }

    function editedEntries() {
        return entries.map(function (e) { return { scope: e.scope, kind: e.kind, name: e.name, text: edited[e.key] }; });
    }

    function requestPreview() {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(function () {
            vscode.postMessage({ type: 'preview', key: selected, entries: editedEntries() });
        }, 200);
    }

    function insert(name) {
        var token = '${' + name + '}';
        var start = text.selectionStart, end = text.selectionEnd;
        text.value = text.value.slice(0, start) + token + text.value.slice(end);
        text.selectionStart = text.selectionEnd = start + token.length;
        text.focus();
        onEdit();
    }

    function onEdit() {
        edited[selected] = text.value;
        renderList();
        requestPreview();
    }

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'load') {
            entries = msg.entries || [];
            questId = msg.questId || '';
            edited = {};
            entries.forEach(function (e) { edited[e.key] = e.text; });
            $('quest').innerHTML = '<option value="">(none)</option>' + (msg.quests || []).map(function (q) {
                return '<option value="' + esc(q) + '"' + (q === questId ? ' selected' : '') + '>' + esc(q) + '</option>';
            }).join('');
            $('vars').innerHTML = (msg.variables || []).map(function (v) {
                return '<button class="var" data-var="' + esc(v.name) + '" title="' + esc(v.description) + '"><code>${' + esc(v.name) + '}</code>'
                    + '<span class="var-desc">' + esc(v.description) + '</span></button>';
            }).join('');
            select(entryOf(msg.selected) ? msg.selected : (entries[0] && entries[0].key));
        } else if (msg.type === 'order') {
            // The host stored a new order: the entries are put in it; the unsaved texts stay.
            var rank = {};
            (msg.keys || []).forEach(function (k, i) { rank[k] = i; });
            entries.sort(function (a, b) { return (rank[a.key] === undefined ? 1e9 : rank[a.key]) - (rank[b.key] === undefined ? 1e9 : rank[b.key]); });
            renderList();
        } else if (msg.type === 'preview' && msg.key === selected) {
            $('preview').textContent = msg.text;
            $('preview-note').textContent = msg.note ? '— ' + msg.note : '';
        } else if (msg.type === 'saved') {
            $('preview-note').textContent = '— saved';
        }
    });

    $('entries').addEventListener('click', function (ev) {
        var add = ev.target.closest && ev.target.closest('button.add');
        if (add) {
            vscode.postMessage({ type: 'create', scope: add.dataset.scope, kind: add.dataset.kind });
            return;
        }
        var li = ev.target.closest && ev.target.closest('[data-key]');
        if (li) { select(li.dataset.key); }
    });
    $('vars').addEventListener('click', function (ev) {
        var b = ev.target.closest && ev.target.closest('[data-var]');
        if (b) { insert(b.dataset.var); }
    });
    $('quest').addEventListener('change', function () {
        if (dirtyEntries().length && !window.confirm('Discard the unsaved changes?')) {
            $('quest').value = questId;
            return;
        }
        vscode.postMessage({ type: 'quest', questId: $('quest').value });
    });
    text.addEventListener('input', onEdit);
    $('delete').addEventListener('click', function () {
        var e = entryOf(selected);
        if (e) { vscode.postMessage({ type: 'delete', scope: e.scope, kind: e.kind, name: e.name }); }
    });
    $('moveUp').addEventListener('click', function () { if (selected) { vscode.postMessage({ type: 'move', key: selected, direction: 'up' }); } });
    $('moveDown').addEventListener('click', function () { if (selected) { vscode.postMessage({ type: 'move', key: selected, direction: 'down' }); } });
    $('revert').addEventListener('click', function () { vscode.postMessage({ type: 'revert' }); });
    $('save').addEventListener('click', function () {
        vscode.postMessage({ type: 'save', entries: dirtyEntries().map(function (e) { return { scope: e.scope, kind: e.kind, name: e.name, text: edited[e.key] }; }) });
    });

    vscode.postMessage({ type: 'ready' });
})();
