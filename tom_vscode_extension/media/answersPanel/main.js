// @ts-nocheck
// The Answers page — the answers agents gave with tomAi_answerUser.
// Host: src/handlers/answersPanel-handler.ts posts {type: 'state', answers,
// selected, total, unread, limit} whenever the store changes. The list posts
// select; a suggested todo posts addTodo (and shows its record on demand); a
// suggested prompt posts copyPrompt; the bar posts deleteRead / deleteAll; the
// answer's own buttons post delete / markUnread.
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
    var detail = document.getElementById('detail');
    /** The todo records shown, by `<answer id>|<index>`, kept across refreshes. */
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
        return d.toDateString() === new Date().toDateString() ? hm : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    }

    function renderBar() {
        bar.innerHTML = '<span>' + (state.unread ? '<b>' + state.unread + ' unread</b> of ' : '') + state.total + ' answer' + (state.total === 1 ? '' : 's') + '</span>'
            + '<span class="grow"></span>'
            + '<button class="icon" data-action="deleteRead" title="Delete the answers you have read"><span class="codicon codicon-clear-all"></span></button>'
            + '<button class="icon" data-action="deleteAll" title="Delete all answers (asks first)"><span class="codicon codicon-trash"></span></button>';
    }

    function renderList() {
        if (!state.answers.length) {
            list.innerHTML = '<div class="muted">No answers yet. An agent gives one with tomAi_answerUser.</div>';
            return;
        }
        var sel = state.selected ? state.selected.id : '';
        list.innerHTML = state.answers.map(function (a) {
            return '<div class="item' + (a.read ? '' : ' unread') + (a.id === sel ? ' selected' : '') + '" data-id="' + esc(a.id) + '">'
                + '<div class="title" title="' + esc(a.title) + '">' + esc(a.title) + '</div>'
                + '<div class="meta"><span>' + esc(time(a.at)) + '</span><span>' + esc(a.quest) + '</span><span>run ' + esc(a.run) + '</span>'
                + (a.todos ? '<span title="suggested todos"><span class="codicon codicon-checklist"></span> ' + a.todos + '</span>' : '')
                + (a.prompts ? '<span title="suggested prompts"><span class="codicon codicon-comment"></span> ' + a.prompts + '</span>' : '')
                + '</div></div>';
        }).join('');
    }

    function renderDetail() {
        var a = state.selected;
        if (!a) { detail.innerHTML = '<div class="empty">Select an answer.</div>'; return; }
        var html = '<h1 class="title">' + esc(a.title) + '</h1>'
            + '<div class="meta"><span>' + esc(time(a.at)) + '</span><span>quest ' + esc(a.quest) + '</span><span>run ' + esc(a.run) + '</span>'
            + (a.session ? '<span>session ' + esc(a.session) + '</span>' : '')
            + (a.queueItemId ? '<span>queue item ' + esc(a.queueItemId) + '</span>' : '')
            + '<span class="grow"></span>'
            + '<button class="icon" data-action="markUnread" title="Mark as unread"><span class="codicon codicon-mail"></span></button>'
            + '<button class="icon" data-action="delete" title="Delete this answer"><span class="codicon codicon-trash"></span></button></div>'
            + (a.question ? '<div class="question">' + esc(a.question) + '</div>' : '')
            // Rendered by the host (renderQuestLogMarkdown): escaped Markdown, no script.
            + '<div class="answer">' + a.answerHtml + '</div>';
        if (a.todos.length) {
            html += '<h2 class="section">Suggested todos</h2>' + a.todos.map(function (t, i) {
                var key = a.id + '|' + i;
                return '<div class="card" data-todo="' + i + '"><div class="card-head">'
                    + '<span class="name"><span class="id">' + esc(t.id) + '</span>' + (t.title ? ' — ' + esc(t.title) : '') + ' <span class="muted">· ' + esc(t.quest) + (t.file ? ' / ' + esc(t.file) : '') + '</span></span>'
                    + '<button class="btn secondary" data-action="toggleRecord" data-index="' + i + '">' + (expanded[key] ? 'Hide record' : 'Show record') + '</button>'
                    + (t.addedId
                        ? '<span class="added"><span class="codicon codicon-check"></span> added as ' + esc(t.addedId) + '</span>'
                        : '<button class="btn" data-action="addTodo" data-index="' + i + '">Add todo</button>')
                    + '</div>' + (expanded[key] ? '<pre>' + esc(t.record) + '</pre>' : '') + '</div>';
            }).join('');
        }
        if (a.prompts.length) {
            html += '<h2 class="section">Suggested prompts</h2>' + a.prompts.map(function (p, i) {
                return '<div class="card" data-prompt="' + i + '"><div class="card-head"><span class="name">' + esc(p.label) + '</span>'
                    + '<button class="btn" data-action="copyPrompt" data-index="' + i + '" title="Copy the prompt; queue it from the chat panel">Copy</button></div>'
                    + '<pre>' + esc(p.text) + '</pre></div>';
            }).join('');
        }
        detail.innerHTML = html;
    }

    function render() {
        if (!state) { return; }
        renderBar();
        renderList();
        renderDetail();
    }

    bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button[data-action]');
        if (btn) { vscode.postMessage({ type: btn.getAttribute('data-action') }); }
    });

    list.addEventListener('click', function (ev) {
        var item = ev.target.closest('.item');
        if (item) { vscode.postMessage({ type: 'select', id: item.getAttribute('data-id') }); }
    });

    detail.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button[data-action]');
        if (!btn || !state || !state.selected) { return; }
        var action = btn.getAttribute('data-action');
        var id = state.selected.id;
        var index = Number(btn.getAttribute('data-index'));
        if (action === 'toggleRecord') {
            expanded[id + '|' + index] = !expanded[id + '|' + index];
            renderDetail();
            return;
        }
        if (action === 'addTodo' || action === 'copyPrompt') { vscode.postMessage({ type: action, id: id, index: index }); return; }
        if (action === 'delete' || action === 'markUnread') { vscode.postMessage({ type: action, id: id }); }
    });

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'state') { state = msg; render(); }
    });
    vscode.postMessage({ type: 'ready' });
})();
