// @ts-nocheck
// Window Status panel webview client — extracted from the inline <script> of
// WindowStatusViewProvider._getHtml() in src/handlers/windowStatusPanel-handler.ts
// (Phase B.7 webview restructuring). First-paint data (codicons URI) arrives
// via window.__INIT__; window states flow via postMessage. No textareas, so no
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
    var states = [];
    var windowList = document.getElementById('windowList');

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /* Format a relative time string from ISO timestamp */
    function timeAgo(iso) {
        if (!iso) return '';
        var ms = Date.now() - new Date(iso).getTime();
        if (ms < 0) ms = 0;
        var sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + 's ago';
        var min = Math.floor(sec / 60);
        if (min < 60) return min + 'm ago';
        var hr = Math.floor(min / 60);
        return hr + 'h ago';
    }

    function renderStates() {
        if (states.length === 0) {
            windowList.innerHTML = '<div class="empty-state">'
                + '<span class="codicon codicon-window"></span>'
                + '<div>No active windows.</div>'
                + '</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < states.length; i++) {
            var s = states[i];
            var questLabel = s.activeQuest || s.workspace || 'unknown';
            var aiConversationActive = s.aiConversationActive === true;
            var aiConversationHtml = '<div class="ai-conversation-line ' + (aiConversationActive ? 'active' : 'inactive') + '">AI conversation: ' + (aiConversationActive ? 'active' : 'inactive') + '</div>';
            var subsHtml = '';
            if (s.status && s.status.length > 0) {
                for (var j = 0; j < s.status.length; j++) {
                    var sub = s.status[j];
                    var dotClass = sub.status === 'answer-received' ? 'answer-received' : 'prompt-sent';
                    var statusLabel = sub.status === 'answer-received' ? 'Answer received' : 'Prompt sent';
                    var ts = sub.status === 'answer-received' ? sub.lastAnswerAt : sub.promptStartedAt;
                    subsHtml += '<div class="subsystem-item">'
                        + '<span class="status-dot ' + dotClass + '" title="' + escapeHtml(statusLabel) + '"></span>'
                        + '<span class="subsystem-name">' + escapeHtml(sub.subsystem) + '</span>'
                        + '<span class="subsystem-time">' + escapeHtml(timeAgo(ts)) + '</span>'
                        + '</div>';
                }
            }
            html += '<div class="window-card">'
                + '<div class="window-card-header">'
                + '<span class="window-workspace">' + escapeHtml(questLabel) + '</span>'
                + '<button class="delete-btn" data-windowid="' + escapeHtml(s.windowId) + '" title="Remove window status">'
                + '<span class="codicon codicon-trash"></span></button>'
                + '</div>'
                + aiConversationHtml
                + (subsHtml ? '<div class="subsystem-list">' + subsHtml + '</div>' : '')
                + '</div>';
        }
        windowList.innerHTML = html;

        /* Wire up delete buttons */
        var deleteBtns = windowList.querySelectorAll('.delete-btn');
        for (var k = 0; k < deleteBtns.length; k++) {
            deleteBtns[k].addEventListener('click', function (ev) {
                ev.stopPropagation();
                var wid = this.getAttribute('data-windowid');
                if (wid) {
                    vscode.postMessage({ type: 'deleteWindowState', windowId: wid });
                }
            });
        }
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'windowStates') {
            states = msg.states || [];
            renderStates();
        } else if (msg.type === 'refresh') {
            vscode.postMessage({ type: 'loadWindowStates' });
        }
    });

    /* Initial load */
    vscode.postMessage({ type: 'loadWindowStates' });
})();
