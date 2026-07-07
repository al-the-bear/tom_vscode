// @ts-nocheck
// TODO Log panel webview client — extracted from the inline <script> of
// TodoLogViewProvider._getHtml() in src/handlers/todoLogPanel-handler.ts
// (Phase B.6 webview restructuring). First-paint data (codicons URI) arrives
// via window.__INIT__; entries flow via postMessage. No textareas, so no
// completion wiring. @ts-nocheck: verbatim legacy extraction (loose
// getElementById access predates the strict checkJs gate).

(function () {
    // Inject codicons stylesheet (its URI is resolved by the extension host).
    var __init = window.__INIT__ || {};
    if (__init.codiconsUri) {
        var __link = document.createElement('link');
        __link.rel = 'stylesheet';
        __link.href = String(__init.codiconsUri);
        document.head.appendChild(__link);
    }

    var vscode = acquireVsCodeApi();
    var entries = [];
    var entryList = document.getElementById('entryList');
    var entryCount = document.getElementById('entryCount');
    var refreshBtn = document.getElementById('refreshBtn');
    var openTrailFilesBtn = document.getElementById('openTrailFilesBtn');
    var openTrailViewerBtn = document.getElementById('openTrailViewerBtn');

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function renderEntries() {
        entryCount.textContent = entries.length > 0 ? '(' + entries.length + ')' : '';
        if (entries.length === 0) {
            entryList.innerHTML = '<div class="empty-state">'
                + '<span class="codicon codicon-checklist"></span>'
                + '<div>No TODO-linked answers yet.</div>'
                + '</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var linksHtml = '';
            if (e.todoLinks && e.todoLinks.length > 0) {
                var links = '';
                for (var j = 0; j < e.todoLinks.length; j++) {
                    var link = e.todoLinks[j];
                    var todoId = link.id || link.ref;
                    var todoFile = link.fileName || '';
                    var idPart = todoFile ? todoId + '@' + todoFile : todoId;
                    var encoded = encodeURIComponent(link.ref || '');
                    // Show the todo title (when resolved) as the primary label and
                    // the id@file as a muted secondary reference; fall back to the
                    // id@file alone when the todo can no longer be resolved.
                    var labelHtml = link.title
                        ? '<span class="entry-todo-title">' + escapeHtml(link.title) + '</span>'
                            + '<span class="entry-todo-ref">' + escapeHtml(idPart) + '</span>'
                        : '<span class="entry-todo-title">' + escapeHtml(idPart) + '</span>';
                    links += '<a class="entry-todo-link" data-todoref="' + encoded + '" title="Open TODO">'
                        + '<span class="codicon codicon-tasklist" style="margin-right:3px;font-size:11px;vertical-align:middle;"></span>'
                        + labelHtml + '</a>';
                }
                linksHtml = '<div class="entry-todo-links">' + links + '</div>';
            }
            html += '<div class="entry-item" data-id="' + e.id + '" data-session="' + escapeHtml(e.session) + '">'
                + '<div class="entry-time">' + escapeHtml(e.displayTime) + '</div>'
                + '<div class="entry-session">' + escapeHtml(e.session) + '</div>'
                + linksHtml
                + '</div>';
        }
        entryList.innerHTML = html;

        // Wire up entry-item clicks (open trail editor at that answer)
        var itemEls = entryList.querySelectorAll('.entry-item');
        for (var m = 0; m < itemEls.length; m++) {
            itemEls[m].addEventListener('click', (function (el) {
                return function (ev) {
                    if (ev.target && ev.target.classList && ev.target.classList.contains('entry-todo-link')) return;
                    if (ev.target && ev.target.closest && ev.target.closest('.entry-todo-link')) return;
                    var id = el.getAttribute('data-id') || '';
                    var session = el.getAttribute('data-session') || '';
                    if (id && session) {
                        vscode.postMessage({ type: 'openAnswerInTrailEditor', session: session, requestId: id });
                    }
                };
            })(itemEls[m]));
        }

        // Wire up TODO link clicks
        var linkEls = entryList.querySelectorAll('.entry-todo-link');
        for (var k = 0; k < linkEls.length; k++) {
            linkEls[k].addEventListener('click', function (ev) {
                ev.stopPropagation();
                ev.preventDefault();
                var todoRef = decodeURIComponent(this.getAttribute('data-todoref') || '');
                if (todoRef) {
                    vscode.postMessage({ type: 'gotoTodo', todoRef: todoRef });
                }
            });
        }
    }

    refreshBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'loadTodoExchanges' });
    });

    openTrailFilesBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openTrailFiles' });
    });

    openTrailViewerBtn.addEventListener('click', function () {
        vscode.postMessage({ type: 'openTrailViewer' });
    });

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'todoExchanges') {
            entries = msg.entries || [];
            renderEntries();
        } else if (msg.type === 'refresh') {
            vscode.postMessage({ type: 'loadTodoExchanges' });
        }
    });

    // Initial load
    vscode.postMessage({ type: 'loadTodoExchanges' });
})();
