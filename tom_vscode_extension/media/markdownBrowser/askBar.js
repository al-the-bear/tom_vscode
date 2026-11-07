// The tomAi_askInMdBrowser bar: an agent's buttons and a "Keep this file"
// checkbox in the MD Browser's top area. The host sends `askBar` (show it) and
// `askBarClear` (take it off, leaving a note); a click posts `askAnswer` with the
// button id and the checkbox, a change of the checkbox `askKeepFile`. Uses the
// `window.vscode` main.js publishes.
(function () {
    'use strict';
    /**
     * @typedef {{ id: string, label: string }} AskButton
     * @typedef {{ requestId: string, title?: string, buttons?: AskButton[], keepFile?: boolean, timeoutAt?: number }} AskSpec
     */
    var found = document.getElementById('askBar');
    if (!found) { return; }
    /** @type {HTMLElement} */
    var bar = found;
    /** @type {AskSpec | null} */
    var current = null;

    /** @param {Record<string, unknown>} msg */
    function post(msg) {
        /** @type {{ vscode?: { postMessage(m: unknown): void } }} */
        var w = /** @type {any} */ (window);
        if (w.vscode) { w.vscode.postMessage(msg); }
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

    /** @param {AskSpec} spec */
    function show(spec) {
        current = spec;
        bar.textContent = '';
        bar.classList.remove('answered');
        if (spec.title) { bar.appendChild(el('span', 'ask-bar-title', spec.title)); }
        var buttons = el('span', 'ask-bar-buttons');
        var keep = /** @type {HTMLInputElement} */ (el('input'));
        keep.type = 'checkbox';
        keep.id = 'askKeepFile';
        keep.checked = spec.keepFile !== false;
        (spec.buttons || []).forEach(function (/** @type {AskButton} */ b, /** @type {number} */ i) {
            var btn = /** @type {HTMLButtonElement} */ (el('button', i === 0 ? 'ask-bar-btn primary' : 'ask-bar-btn', b.label));
            btn.setAttribute('data-ask-button', b.id);
            btn.addEventListener('click', function () {
                if (!current || current.requestId !== spec.requestId) { return; }
                bar.querySelectorAll('button').forEach(function (/** @type {HTMLButtonElement} */ x) { x.disabled = true; });
                keep.disabled = true;
                post({ type: 'askAnswer', requestId: spec.requestId, button: b.id, keepFile: keep.checked });
            });
            buttons.appendChild(btn);
        });
        bar.appendChild(buttons);
        var label = el('label', 'ask-bar-keep');
        label.appendChild(keep);
        label.appendChild(document.createTextNode(' Keep this file'));
        keep.addEventListener('change', function () {
            post({ type: 'askKeepFile', requestId: spec.requestId, keepFile: keep.checked });
        });
        bar.appendChild(label);
        if (spec.timeoutAt) {
            var until = new Date(spec.timeoutAt);
            bar.appendChild(el('span', 'ask-bar-deadline', 'until ' + until.toLocaleTimeString()));
        }
        bar.hidden = false;
    }

    /**
     * @param {string} requestId
     * @param {string} [note]
     */
    function clear(requestId, note) {
        if (current && current.requestId !== requestId) { return; }
        current = null;
        bar.textContent = '';
        if (note) {
            bar.classList.add('answered');
            bar.appendChild(el('span', 'ask-bar-note', note));
            bar.hidden = false;
        } else {
            bar.hidden = true;
        }
    }

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (!msg) { return; }
        if (msg.type === 'askBar' && msg.bar) { show(msg.bar); }
        else if (msg.type === 'askBarClear') { clear(msg.requestId, msg.note); }
    });
})();
