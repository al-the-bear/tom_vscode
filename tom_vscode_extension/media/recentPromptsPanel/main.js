// @ts-nocheck
// Recent Prompts — the last prompts the prompt queue sent in this window's quest.
// Host: src/handlers/recentPromptsPanel-handler.ts posts {type: 'state', rows,
// promptCount, truncated, limit} (src/utils/recentPrompts.ts) on every change of
// the queue; the first state comes in window.__INIT__. One row per item, newest
// first, collapsed; an item expands into its iterations and single prompts, an
// iteration into its prompts, a prompt into its text and the start of its answer
// with Full text (both in full, in the page) and Markdown (posts renderMarkdown;
// the host answers markdownHtml, shown with the shared tomMdOverlayShow).
// A prompt shows the user's prompt as queued. A row's As sent (n) opens the
// stages exactly as sent (row.sent, src/utils/sentPrompts.ts): label, time,
// sizes, and the user message / system prompt (posts showSentText {ref, title};
// the host answers markdownHtml).
// What is expanded is kept across refreshes and in the webview state.
/* global acquireVsCodeApi, tomMdOverlayShow */
(function () {
    var vscode = acquireVsCodeApi();
    var INIT = window.__INIT__ || {};
    if (INIT.codiconsUri) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = INIT.codiconsUri;
        document.head.appendChild(link);
    }
    var PROMPT_START_CHARS = 400;
    var ANSWER_START_CHARS = 200;
    var bar = document.getElementById('bar');
    var rowsEl = document.getElementById('rows');
    var saved = vscode.getState() || {};
    /** Expanded keys: a row's id, `<row>|<node>` an iteration or prompt, `<row>|<node>|<prompt>` a prompt of an iteration. */
    var open = saved.open || {};
    /** Prompts shown in full. */
    var full = saved.full || {};
    /** Rows whose As sent list is open. */
    var openSent = saved.openSent || {};
    var state = INIT.state || null;

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function time(iso) {
        var d = new Date(iso);
        if (!iso || isNaN(d.getTime())) { return ''; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        return d.toDateString() === new Date().toDateString() ? hm : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm;
    }
    function start(text, max) {
        var t = String(text || '');
        return t.length > max ? t.slice(0, max).replace(/\s+$/, '') + '…' : t;
    }
    function persist() { vscode.setState({ open: open, full: full, openSent: openSent }); }
    function fold(isOpen) { return '<span class="fold codicon codicon-chevron-' + (isOpen ? 'down' : 'right') + '"></span>'; }
    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    /** The row's headline text: its todos (id — title), else the prompt's first line. */
    function rowTitle(row) {
        if (row.todos && row.todos.length) {
            return row.todos.map(function (t) { return t.title ? t.id + ' — ' + t.title : t.id; }).join(', ');
        }
        return row.firstLine || '(empty prompt)';
    }
    var KIND_LABELS = { todo: 'todo', group: 'group', prefix: 'walk', iteration: 'iteration', chat: 'chat', prompt: 'prompt' };

    function settingsHtml(s) {
        var out = [];
        [['run', 'Run'], ['session', 'Session'], ['profile', 'Profile'], ['role', 'Role'], ['template', 'Template']].forEach(function (f) {
            if (s && s[f[0]]) { out.push('<span class="chip" data-setting="' + f[0] + '" title="' + f[1] + '">' + esc(f[1]) + ': ' + esc(s[f[0]]) + '</span>'); }
        });
        return out.length ? '<div class="settings">' + out.join('') + '</div>' : '';
    }

    function promptHtml(p, key) {
        var isOpen = !!open[key];
        var h = '<div class="prompt" data-prompt="' + esc(key) + '">'
            + '<div class="head" data-toggle="' + esc(key) + '">' + fold(isOpen)
            + '<span class="title">' + esc(p.label) + '</span>'
            + '<span class="meta">' + esc(time(p.at)) + '</span></div>';
        if (isOpen) {
            var whole = !!full[key];
            var answer = p.answer || '';
            h += '<div class="body">'
                + '<div class="label">Prompt (as queued)</div>'
                + '<pre class="prompt-text">' + esc(whole ? p.text : start(p.text, PROMPT_START_CHARS)) + '</pre>'
                + '<div class="label">Answer</div>'
                + (answer
                    ? '<pre class="answer-text' + (p.error ? ' error' : '') + '">' + esc(whole ? answer : start(answer, ANSWER_START_CHARS)) + '</pre>'
                    : '<div class="muted answer-text">(no answer kept)</div>')
                + '<div class="actions">'
                + '<button data-action="full" data-key="' + esc(key) + '" title="Prompt and answer in full, here">' + (whole ? 'Shorten' : 'Full text') + '</button>'
                + '<button data-action="markdown" data-key="' + esc(key) + '" title="Prompt and answer rendered as Markdown">Markdown</button>'
                + '</div></div>';
        }
        return h + '</div>';
    }

    function nodeHtml(row, node, n) {
        var key = row.id + '|' + n;
        if (node.type === 'prompt') { return promptHtml(node.prompt, key); }
        var isOpen = !!open[key];
        var h = '<div class="iteration" data-iteration="' + esc(key) + '">'
            + '<div class="head" data-toggle="' + esc(key) + '">' + fold(isOpen)
            + '<span class="title">' + esc(node.label) + '</span>'
            + '<span class="meta">' + plural(node.prompts.length, 'prompt') + '</span></div>';
        if (isOpen) {
            h += '<div class="children">' + node.prompts.map(function (p, i) { return promptHtml(p, key + '|' + i); }).join('') + '</div>';
        }
        return h + '</div>';
    }

    function chars(n) {
        if (n === undefined || n === null) { return ''; }
        return n >= 1000 ? (Math.round(n / 100) / 10) + 'k chars' : n + ' chars';
    }

    /** The row's stages exactly as sent: label, time, sizes, the two texts on demand. */
    function sentHtml(row) {
        var sent = row.sent || [];
        if (!sent.length) { return ''; }
        var isOpen = !!openSent[row.id];
        var h = '<div class="sent" data-sent-row="' + esc(row.id) + '">'
            + '<button class="sent-toggle" data-sent-toggle="' + esc(row.id) + '" title="The stages exactly as sent: the user message and the system prompt">'
            + fold(isOpen) + 'As sent (' + sent.length + ')</button>';
        if (isOpen) {
            h += '<div class="sent-list">' + sent.slice().reverse().map(function (r) {
                return '<div class="sent-entry">'
                    + '<span class="title">' + esc(r.label) + '</span>'
                    + '<span class="meta">' + esc(time(r.sentAt)) + '</span>'
                    + (r.promptRef ? '<button data-sent-ref="' + esc(r.promptRef) + '" data-sent-title="' + esc(r.label + ' — user message as sent') + '" title="The user message as sent">User message ' + esc(chars(r.promptChars)) + '</button>' : '<span class="muted">(not kept)</span>')
                    + (r.systemRef ? '<button data-sent-ref="' + esc(r.systemRef) + '" data-sent-title="' + esc(r.label + ' — system prompt') + '" title="The system prompt as sent">System prompt ' + esc(chars(r.systemChars)) + '</button>' : '')
                    + '</div>';
            }).join('') + '</div>';
        }
        return h + '</div>';
    }

    function rowHtml(row) {
        var isOpen = !!open[row.id];
        var h = '<div class="row" data-row="' + esc(row.id) + '">'
            + '<div class="head" data-toggle="' + esc(row.id) + '">' + fold(isOpen)
            + '<span class="kind">' + esc(KIND_LABELS[row.kind] || row.kind) + '</span>'
            + '<span class="title">' + esc(rowTitle(row)) + '</span>'
            + '<span class="meta count">' + plural(row.promptCount, 'prompt') + '</span>'
            + '<span class="meta">' + esc(time(row.sentAt)) + '</span></div>'
            + settingsHtml(row.settings)
            + (row.lastAnswerStart ? '<div class="answer-start">' + esc(row.lastAnswerStart) + '</div>' : '')
            + sentHtml(row);
        if (isOpen) {
            h += '<div class="children">' + row.nodes.map(function (node, n) { return nodeHtml(row, node, n); }).join('') + '</div>';
        }
        return h + '</div>';
    }

    function render() {
        if (!state) { return; }
        var rows = state.rows || [];
        bar.innerHTML = '<span>' + plural(state.promptCount || 0, 'prompt') + ' in ' + plural(rows.length, 'item') + '</span>'
            + (state.truncated ? '<span class="muted">(the last ' + esc(state.limit) + ' prompts)</span>' : '')
            + '<span class="grow"></span>';
        rowsEl.innerHTML = rows.length
            ? rows.map(rowHtml).join('')
            : '<div class="muted">No prompts sent yet. The prompt queue lists what it sends, the chat sends included.</div>';
    }

    /** The prompt a key names. */
    function promptOf(key) {
        var parts = String(key).split('|');
        var row = (state && state.rows || []).find(function (r) { return r.id === parts[0]; });
        var node = row && row.nodes[Number(parts[1])];
        if (!node) { return undefined; }
        if (node.type === 'prompt') { return node.prompt; }
        return node.prompts[Number(parts[2])];
    }

    document.addEventListener('click', function (e) {
        var target = e.target instanceof Element ? e.target : null;
        if (!target) { return; }
        var sentRef = target.closest('[data-sent-ref]');
        if (sentRef) {
            vscode.postMessage({ type: 'showSentText', ref: sentRef.getAttribute('data-sent-ref'), title: sentRef.getAttribute('data-sent-title') });
            return;
        }
        var sentToggle = target.closest('[data-sent-toggle]');
        if (sentToggle) {
            var id = sentToggle.getAttribute('data-sent-toggle');
            if (openSent[id]) { delete openSent[id]; } else { openSent[id] = true; }
            persist();
            render();
            return;
        }
        var action = target.closest('[data-action]');
        if (action) {
            var key = action.getAttribute('data-key');
            var p = promptOf(key);
            if (!p) { return; }
            if (action.getAttribute('data-action') === 'full') {
                if (full[key]) { delete full[key]; } else { full[key] = true; }
                persist();
                render();
            } else {
                vscode.postMessage({
                    type: 'renderMarkdown',
                    title: p.label,
                    markdown: '## Prompt (as queued)\n\n' + p.text + '\n\n## Answer\n\n' + (p.answer || '_(no answer kept)_'),
                });
            }
            return;
        }
        var toggle = target.closest('[data-toggle]');
        if (toggle) {
            var k = toggle.getAttribute('data-toggle');
            if (open[k]) { delete open[k]; } else { open[k] = true; }
            persist();
            render();
        }
    });

    window.addEventListener('message', function (event) {
        var msg = event.data || {};
        if (msg.type === 'state') { state = msg; render(); return; }
        if (msg.type === 'markdownHtml') { tomMdOverlayShow(msg.title, msg.html); }
    });

    render();
    vscode.postMessage({ type: 'ready' });
})();
