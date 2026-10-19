// @ts-nocheck
// Process template editor — see src/handlers/processTemplateEditor-handler.ts.
// The host sends every template ('load'); the page keeps the edited texts of
// all kinds until Save (all at once) or Revert. A click on a variable inserts
// `${name}` at the cursor. The preview is resolved by the host for the move of
// this kind at the current position, with the text being edited.
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

    function $(id) { return document.getElementById(id); }
    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var kinds = [];
    /** kind → the text as edited (unsaved). */
    var edited = {};
    /** kind → the text as saved. */
    var saved = {};
    var selected = 'next';
    var text = $('text');
    var timer = null;

    function kindOf(k) { return kinds.find(function (x) { return x.kind === k; }); }

    function renderList() {
        $('kinds').innerHTML = kinds.map(function (k) {
            var dirty = edited[k.kind] !== saved[k.kind];
            var own = edited[k.kind] !== k.defaultText;
            return '<li class="item' + (k.kind === selected ? ' selected' : '') + '" data-kind="' + esc(k.kind) + '">'
                + '<span class="item-name">' + esc(k.kind) + (dirty ? ' ●' : '') + '</span>'
                + (own ? ' <span class="badge">' + (edited[k.kind] === '' ? 'empty' : 'custom') + '</span>' : '')
                + '<div class="item-title">' + esc(k.title) + '</div></li>';
        }).join('');
        var anyDirty = kinds.some(function (k) { return edited[k.kind] !== saved[k.kind]; });
        $('save').disabled = !anyDirty;
        $('revert').disabled = !anyDirty;
        var cur = kindOf(selected);
        $('reset').disabled = !cur || edited[selected] === cur.defaultText;
    }

    function select(kind) {
        if (!kindOf(kind)) { return; }
        selected = kind;
        var k = kindOf(kind);
        $('title').textContent = k.title;
        text.value = edited[kind];
        renderList();
        vscode.postMessage({ type: 'select', kind: kind });
        requestPreview();
    }

    function requestPreview() {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(function () {
            vscode.postMessage({ type: 'preview', kind: selected, text: edited[selected] });
        }, 250);
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

    window.addEventListener('message', function (e) {
        var msg = e.data || {};
        if (msg.type === 'load') {
            kinds = msg.kinds;
            edited = {};
            saved = {};
            kinds.forEach(function (k) { edited[k.kind] = k.text; saved[k.kind] = k.text; });
            $('vars').innerHTML = msg.variables.map(function (g) {
                return '<div class="var-group">' + esc(g.group) + '</div>' + g.items.map(function (v) {
                    return '<button class="var" data-var="' + esc(v.name) + '" title="' + esc(v.description || ('${' + v.name + '}')) + '">'
                        + '<code>${' + esc(v.name) + '}</code>' + (v.description ? '<span class="var-desc">' + esc(v.description) + '</span>' : '') + '</button>';
                }).join('');
            }).join('');
            select(msg.selected || selected);
        } else if (msg.type === 'select') {
            select(msg.kind);
        } else if (msg.type === 'preview' && msg.kind === selected) {
            var pre = $('preview');
            if (!msg.offered) {
                $('preview-note').textContent = '— "' + selected + '" is not offered at the current position';
                pre.textContent = '';
                pre.hidden = true;
            } else {
                $('preview-note').textContent = '— ' + msg.label;
                pre.hidden = false;
                pre.textContent = msg.preview || '(empty: nothing is queued)';
            }
        } else if (msg.type === 'saved') {
            $('preview-note').textContent = '— saved';
        }
    });

    $('kinds').addEventListener('click', function (e) {
        var li = e.target.closest && e.target.closest('[data-kind]');
        if (li) { select(li.dataset.kind); }
    });
    $('vars').addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-var]');
        if (b) { insert(b.dataset.var); }
    });
    text.addEventListener('input', onEdit);
    $('reset').addEventListener('click', function () {
        var k = kindOf(selected);
        if (!k) { return; }
        text.value = k.defaultText;
        onEdit();
    });
    $('revert').addEventListener('click', function () { vscode.postMessage({ type: 'revert' }); });
    $('save').addEventListener('click', function () { vscode.postMessage({ type: 'save', templates: edited }); });

    vscode.postMessage({ type: 'ready' });
})();
