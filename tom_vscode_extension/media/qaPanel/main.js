// @ts-nocheck
// The Q&A page — the Questions tab (the Q&A journals and the stored answers of
// tomAi_answerUser) and the Decisions tab (the todos' decisions).
// Host: src/handlers/qaPanel-handler.ts posts {type: 'state', tab, filter,
// currentQuest, allQuests, quests, counts, questions, selected, decisions,
// total, unread, limit} whenever something changes. The tabs post tab; the
// filter posts filter; the list posts select (key); a stored answer's
// suggested todo posts addTodo, a suggested prompt copyPrompt, its own buttons
// delete / markUnread, the bar deleteRead / deleteAll; an open decision posts
// answerDecision {key, answer}.
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
    var tabs = document.getElementById('tabs');
    var filterBox = document.getElementById('filter');
    var pageQuestions = document.getElementById('page-questions');
    var pageDecisions = document.getElementById('page-decisions');
    var bar = document.getElementById('bar');
    var list = document.getElementById('list');
    var detail = document.getElementById('detail');
    /** The todo records shown, by `<answer id>|<index>`, kept across refreshes. */
    var expanded = {};
    /** What the user typed into an open decision, by its key, kept across refreshes. */
    var drafts = {};
    var state = null;

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function time(iso) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) { return String(iso); }
        var d = new Date(iso);
        if (isNaN(d.getTime())) { return ''; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        return d.toDateString() === new Date().toDateString() ? hm : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    }
    function hostLabel(host) { return host ? host : 'unknown host'; }
    var KIND_ICON = { question: 'question', answerGiven: 'comment', decision: 'git-merge' };
    var KIND_LABEL = { question: 'Question', answerGiven: 'Answer given', decision: 'Process decision' };

    function renderTabs() {
        var c = state.counts || {};
        var tab = function (id, label, n) {
            return '<button class="tab' + (state.tab === id ? ' active' : '') + '" data-tab="' + id + '">' + label
                + (n ? ' <span class="count" data-count="' + id + '">' + n + ' new</span>' : '') + '</button>';
        };
        tabs.innerHTML = tab('questions', 'Questions', c.questions) + tab('decisions', 'Decisions', c.decisions);
    }

    function renderFilter() {
        var f = state.filter || { scope: 'current', selected: [] };
        var opt = function (v, label) { return '<option value="' + v + '"' + (f.scope === v ? ' selected' : '') + '>' + label + '</option>'; };
        var html = '<label>Quests <select id="scope">'
            + opt('current', 'Current quest' + (state.currentQuest ? ' (' + esc(state.currentQuest) + ')' : ''))
            + opt('workspace', 'The workspace\'s quests')
            + opt('selected', 'Selected quests')
            + '</select></label>';
        if (f.scope === 'selected') {
            html += '<div class="quest-picks">' + (state.allQuests || []).map(function (q) {
                return '<label class="pick"><input type="checkbox" data-quest="' + esc(q) + '"' + (f.selected.indexOf(q) >= 0 ? ' checked' : '') + '> ' + esc(q) + '</label>';
            }).join('') + '</div>';
        } else {
            html += '<span class="muted shown">' + esc((state.quests || []).join(', ') || 'no quest') + '</span>';
        }
        filterBox.innerHTML = html;
    }

    function renderBar() {
        bar.innerHTML = '<span>' + state.questions.length + ' entr' + (state.questions.length === 1 ? 'y' : 'ies')
            + (state.unread ? ' · <b>' + state.unread + ' unread</b> stored' : '') + '</span>'
            + '<span class="grow"></span>'
            + '<button class="icon" data-action="deleteRead" title="Delete the stored answers you have read (the journals keep them)"><span class="codicon codicon-clear-all"></span></button>'
            + '<button class="icon" data-action="deleteAll" title="Delete all stored answers (asks first; the journals keep them)"><span class="codicon codicon-trash"></span></button>';
    }

    function renderList() {
        if (!state.questions.length) {
            list.innerHTML = '<div class="muted">No questions, answers or process decisions yet for ' + esc((state.quests || []).join(', ') || 'this filter') + '.</div>';
            return;
        }
        var sel = state.selected ? state.selected.key : '';
        list.innerHTML = state.questions.map(function (r) {
            return '<div class="item kind-' + esc(r.kind) + (r.isNew ? ' new' : '') + (r.unread ? ' unread' : '') + (r.key === sel ? ' selected' : '') + '" data-key="' + esc(r.key) + '">'
                + '<div class="title" title="' + esc(r.title) + '"><span class="codicon codicon-' + (KIND_ICON[r.kind] || 'circle') + '"></span> ' + esc(r.title) + '</div>'
                + '<div class="meta"><span>' + esc(time(r.time)) + '</span><span class="host">' + esc(hostLabel(r.host)) + '</span><span>' + esc(r.quest) + '</span>'
                + (r.run ? '<span>run ' + esc(r.run) + '</span>' : '')
                + (r.open ? '<span class="open">open</span>' : '')
                + (r.isNew ? '<span class="badge">new</span>' : '')
                + '</div></div>';
        }).join('');
    }

    function metaLine(a) {
        return '<div class="meta"><span>' + esc(KIND_LABEL[a.kind] || '') + '</span><span>' + esc(time(a.time || a.at)) + '</span>'
            + '<span class="host">' + esc(hostLabel(a.host)) + '</span><span>quest ' + esc(a.quest) + '</span>'
            + (a.run ? '<span>run ' + esc(a.run) + '</span>' : '')
            + (a.session ? '<span>session ' + esc(a.session) + '</span>' : '')
            + (a.queueItemId ? '<span>queue item ' + esc(a.queueItemId) + '</span>' : '')
            + (a.tool ? '<span>' + esc(a.tool) + '</span>' : '')
            + '<span class="grow"></span>'
            + (a.stored
                ? '<button class="icon" data-action="markUnread" title="Mark as unread"><span class="codicon codicon-mail"></span></button>'
                + '<button class="icon" data-action="delete" title="Delete from this machine\'s answer store (the journal keeps it)"><span class="codicon codicon-trash"></span></button>'
                : '')
            + '</div>';
    }

    function renderQuestion(a) {
        var html = '<h1 class="title">' + esc(a.title || 'Question') + '</h1>' + metaLine(a);
        (a.questions || []).forEach(function (q, i) {
            html += '<div class="question"><b>' + (i + 1) + '.</b> ' + esc(q) + '</div>';
        });
        if (a.choices && a.choices.length) {
            html += '<div class="choices">Choices: ' + a.choices.map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join(' ') + '</div>';
        }
        if (a.reply) {
            html += '<h2 class="section">Answer</h2><div class="meta"><span>' + esc(time(a.reply.time)) + '</span>'
                + (a.reply.source ? '<span>via ' + esc(a.reply.source) + '</span>' : '')
                + (a.reply.host ? '<span class="host">' + esc(a.reply.host) + '</span>' : '') + '</div>'
                + '<div class="reply">' + esc(a.reply.text) + '</div>';
        } else {
            html += '<h2 class="section">Answer</h2><div class="muted open">Not answered (still open, or its window went away).</div>';
        }
        return html;
    }

    function renderAnswerGiven(a) {
        var html = '<h1 class="title">' + esc(a.title) + '</h1>' + metaLine(a)
            + (a.question ? '<div class="question">' + esc(a.question) + '</div>' : '')
            // Rendered by the host (renderQuestLogMarkdown): escaped Markdown, no script.
            + '<div class="answer">' + a.answerHtml + '</div>';
        if (a.todos && a.todos.length) {
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
        } else if (a.todoLabels && a.todoLabels.length) {
            html += '<h2 class="section">Suggested todos</h2><div class="muted">Stored on the host that gave the answer:</div>'
                + a.todoLabels.map(function (l) { return '<div class="card">' + esc(l) + '</div>'; }).join('');
        }
        if (a.prompts && a.prompts.length) {
            html += '<h2 class="section">Suggested prompts</h2>' + a.prompts.map(function (p, i) {
                return '<div class="card" data-prompt="' + i + '"><div class="card-head"><span class="name">' + esc(p.label) + '</span>'
                    + '<button class="btn" data-action="copyPrompt" data-index="' + i + '" title="Copy the prompt; queue it from the chat panel">Copy</button></div>'
                    + '<pre>' + esc(p.text) + '</pre></div>';
            }).join('');
        } else if (a.promptLabels && a.promptLabels.length) {
            html += '<h2 class="section">Suggested prompts</h2><div class="muted">Stored on the host that gave the answer:</div>'
                + a.promptLabels.map(function (l) { return '<div class="card">' + esc(l) + '</div>'; }).join('');
        }
        return html;
    }

    function renderDetail() {
        var a = state.selected;
        if (!a) { detail.innerHTML = '<div class="empty">Select an entry.</div>'; return; }
        if (a.kind === 'answerGiven') { detail.innerHTML = renderAnswerGiven(a); return; }
        if (a.kind === 'decision') {
            detail.innerHTML = '<h1 class="title">' + esc(a.title) + '</h1>' + metaLine(a) + '<div class="answer">' + a.detailsHtml + '</div>';
            return;
        }
        detail.innerHTML = renderQuestion(a);
    }

    function renderDecisions() {
        var rows = state.decisions || [];
        if (!rows.length) {
            pageDecisions.innerHTML = '<div class="empty">No todo of ' + esc((state.quests || []).join(', ') || 'this filter') + ' has decisions.</div>';
            return;
        }
        var open = rows.filter(function (d) { return d.open; }).length;
        pageDecisions.innerHTML = '<div class="dec-head">' + open + ' open · ' + (rows.length - open) + ' answered</div>' + rows.map(function (d) {
            var html = '<div class="decision' + (d.open ? ' open' : '') + (d.isNew ? ' new' : '') + '" data-key="' + esc(d.key) + '">'
                + '<div class="dec-title">' + (d.open ? '<span class="codicon codicon-question"></span> ' : '<span class="codicon codicon-check"></span> ')
                + '<b>' + esc(d.summary) + '</b>' + (d.isNew ? ' <span class="badge">new</span>' : '') + '</div>'
                + '<div class="meta"><span class="id">' + esc(d.todoId) + '</span><span>' + esc(d.todoTitle) + '</span><span>' + esc(d.quest) + '</span>'
                + '<span>' + esc(d.archived ? 'archived' : d.todoStatus) + '</span>' + (d.time ? '<span>' + esc(time(d.time)) + '</span>' : '') + '</div>'
                + (d.neededHtml ? '<div class="needed">' + d.neededHtml + '</div>' : '');
            if (d.open) {
                html += '<div class="answer-form">'
                    + (d.options && d.options.length ? '<div class="options">' + d.options.map(function (o) {
                        return '<button class="btn secondary" data-option="' + esc(o) + '">(' + esc(o) + ')</button>';
                    }).join(' ') + '</div>' : '')
                    + '<textarea data-draft="' + esc(d.key) + '" placeholder="Your decision">' + esc(drafts[d.key] || '') + '</textarea>'
                    + '<button class="btn" data-save="' + esc(d.key) + '">Save</button></div>';
            } else {
                html += '<div class="decided"><span class="muted">Decision:</span> ' + esc(d.decision || '(not decided)') + '</div>';
            }
            return html + '</div>';
        }).join('');
    }

    function render() {
        if (!state) { return; }
        renderTabs();
        renderFilter();
        var questions = state.tab !== 'decisions';
        pageQuestions.classList.toggle('hidden', !questions);
        pageDecisions.classList.toggle('hidden', questions);
        if (questions) {
            renderBar();
            renderList();
            renderDetail();
        } else {
            renderDecisions();
        }
    }

    tabs.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button[data-tab]');
        if (btn) { vscode.postMessage({ type: 'tab', tab: btn.getAttribute('data-tab') }); }
    });

    function postFilter(scope, selected) {
        vscode.postMessage({ type: 'filter', filter: { scope: scope, selected: selected } });
    }
    filterBox.addEventListener('change', function (ev) {
        var f = state.filter || { scope: 'current', selected: [] };
        if (ev.target.id === 'scope') { postFilter(ev.target.value, f.selected || []); return; }
        var q = ev.target.getAttribute('data-quest');
        if (q === null) { return; }
        var selected = (f.selected || []).filter(function (x) { return x !== q; });
        if (ev.target.checked) { selected.push(q); }
        postFilter('selected', selected);
    });

    bar.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button[data-action]');
        if (btn) { vscode.postMessage({ type: btn.getAttribute('data-action') }); }
    });

    list.addEventListener('click', function (ev) {
        var item = ev.target.closest('.item');
        if (item) { vscode.postMessage({ type: 'select', key: item.getAttribute('data-key') }); }
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

    pageDecisions.addEventListener('input', function (ev) {
        var key = ev.target.getAttribute('data-draft');
        if (key !== null) { drafts[key] = ev.target.value; }
    });
    pageDecisions.addEventListener('click', function (ev) {
        var opt = ev.target.closest('button[data-option]');
        if (opt) {
            var card = opt.closest('.decision');
            var area = card && card.querySelector('textarea');
            if (!area) { return; }
            var letter = '(' + opt.getAttribute('data-option') + ')';
            var rest = area.value.replace(/^\s*\([a-z]\)\s*/i, '');
            area.value = letter + (rest ? ' ' + rest : ' ');
            drafts[card.getAttribute('data-key')] = area.value;
            area.focus();
            return;
        }
        var save = ev.target.closest('button[data-save]');
        if (save) {
            var key = save.getAttribute('data-save');
            var text = (drafts[key] || '').trim();
            if (!text) { return; }
            vscode.postMessage({ type: 'answerDecision', key: key, answer: text });
            delete drafts[key];
        }
    });

    window.addEventListener('message', function (ev) {
        var msg = ev.data || {};
        if (msg.type === 'state') { state = msg; render(); }
    });
    vscode.postMessage({ type: 'ready' });
})();
