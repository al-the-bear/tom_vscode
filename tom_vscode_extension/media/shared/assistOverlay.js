// The "thinking" overlay of a Grill me / Explain in detail turn (vscimpb65),
// shared by the MD Browser and the @CHAT panel. The host posts `assistOverlay`
// with the run to show (services/assistProgress.ts: thinking, or failed with
// its error) or `view: null`; the overlay names the question and the document,
// counts the time up, and its button posts `assistCancel` with the run's id —
// Cancel while it thinks, Dismiss once it failed. Uses the host bridge the
// panel's main.js published (window.__tomVscodeApi, else window.vscode).
(function () {
    'use strict';
    /**
     * @typedef {{ id: string, label: string, questionId: string, file: string, phase: string,
     *             startedAt: number, phaseSince: number, error?: string }} AssistView
     */

    /** @type {AssistView | null} */
    var current = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    var ticker = null;
    var box = document.createElement('div');
    box.id = 'tomAssistOverlay';
    box.className = 'tom-assist-overlay';
    box.setAttribute('role', 'status');
    box.hidden = true;

    function attach() {
        if (!box.parentNode && document.body) { document.body.appendChild(box); }
    }

    /** @param {Record<string, unknown>} msg */
    function post(msg) {
        /** @type {any} */
        var w = window;
        var api = w.__tomVscodeApi || w.vscode;
        if (api && typeof api.postMessage === 'function') { api.postMessage(msg); }
    }

    /**
     * 0:42, 3:05, 1:02:10.
     * @param {number} ms
     * @returns {string}
     */
    function clock(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var sec = s % 60;
        var mm = h ? (m < 10 ? '0' + m : String(m)) : String(m);
        return (h ? h + ':' : '') + mm + ':' + (sec < 10 ? '0' + sec : String(sec));
    }

    /**
     * @param {string} tag
     * @param {string} [cls]
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }

    function render() {
        attach();
        box.textContent = '';
        if (!current) { box.hidden = true; return; }
        var run = current;
        var failed = run.phase === 'failed';
        box.hidden = false;
        box.classList.toggle('failed', failed);
        var head = el('div', 'tom-assist-head');
        head.appendChild(el('span', 'codicon ' + (failed ? 'codicon-error' : 'codicon-loading codicon-modifier-spin')));
        head.appendChild(el('span', 'tom-assist-title', failed
            ? run.label + ' on ' + run.questionId + ' failed'
            : run.label + ': the agent is thinking about the next step on ' + run.questionId));
        box.appendChild(head);
        if (failed) {
            box.appendChild(el('div', 'tom-assist-error', run.error || 'the turn ended with an error'));
        } else {
            box.appendChild(el('div', 'tom-assist-time', 'Thinking for ' + clock(Date.now() - run.phaseSince)
                + (run.phaseSince > run.startedAt ? ' · started ' + clock(Date.now() - run.startedAt) + ' ago' : '')));
        }
        var foot = el('div', 'tom-assist-foot');
        foot.appendChild(el('span', 'tom-assist-file', run.file));
        var button = /** @type {HTMLButtonElement} */ (el('button', 'tom-assist-cancel', failed ? 'Dismiss' : 'Cancel'));
        button.dataset.assistId = run.id;
        button.title = failed ? 'Close this message' : 'Stop the ' + run.label + ' turn; the document stays as it is and no answer is written';
        button.addEventListener('click', function () {
            post({ type: 'assistCancel', id: run.id });
            current = null;
            render();
            stopTicker();
        });
        foot.appendChild(button);
        box.appendChild(foot);
    }

    function stopTicker() {
        if (ticker !== null) { clearInterval(ticker); ticker = null; }
    }

    /** @param {AssistView | null} view */
    function show(view) {
        current = view && typeof view === 'object' ? view : null;
        render();
        stopTicker();
        if (current && current.phase !== 'failed') { ticker = setInterval(render, 1000); }
    }

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (msg && msg.type === 'assistOverlay') { show(msg.view || null); }
    });
    /** @type {any} */ (window).TomAssistOverlay = { show: show };
})();
