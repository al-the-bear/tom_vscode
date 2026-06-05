// @ts-check
/* Shared webview completion client.
 *
 * Opt-in: any <textarea data-completion="on"> gets Ctrl+Shift+Space
 * `/skill` + `@file` completion. On the chord this scans the token immediately
 * before the caret (mirroring detectToken() in services/completion-service.ts)
 * and posts `{ type: 'requestCompletion', kind, query }` to the extension. The
 * extension answers with `{ type: 'insertCompletion', text }`, which is spliced
 * over the trigger token. The target textarea + range are tracked locally, so
 * no element identity travels over the message channel.
 *
 * After insertion an `input` event is dispatched on the textarea so the host
 * panel's own listeners (slot/draft persistence, etc.) run — this component
 * stays decoupled from any panel-specific state.
 *
 * Bridge: reads `window.__tomVscodeApi` (the host script publishes its acquired
 * API there). Falls back to acquiring once if absent, caching on the same
 * global. Uses event delegation at the document level so textareas rendered
 * after load are covered without re-scanning. Extension counterpart:
 * src/utils/completionWiring.wireCompletionMessages(). */

(function () {

    /** @returns {VsCodeWebviewApi | null} */
    function resolveVscode() {
        if (window.__tomVscodeApi) { return window.__tomVscodeApi; }
        if (typeof acquireVsCodeApi === 'function') {
            window.__tomVscodeApi = acquireVsCodeApi();
            return window.__tomVscodeApi;
        }
        return null;
    }

    /**
     * Scan backwards from `cursor` for a `/` (skill) or `@` (file) trigger
     * token. The token runs from the trigger char to the cursor and must not
     * contain whitespace; the trigger must start the text or follow whitespace
     * (so `a/b` and `x@y` do not trigger). Mirrors detectToken() in
     * services/completion-service.ts.
     * @param {string} text
     * @param {number} cursor
     * @returns {{ kind: 'skill' | 'file', query: string, start: number, end: number } | null}
     */
    function detectToken(text, cursor) {
        var i = cursor - 1;
        while (i >= 0) {
            var ch = text.charAt(i);
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { return null; }
            if (ch === '/' || ch === '@') {
                var beforeOk = (i === 0) || /\s/.test(text.charAt(i - 1));
                if (!beforeOk) { return null; }
                return {
                    kind: ch === '/' ? 'skill' : 'file',
                    query: text.slice(i + 1, cursor),
                    start: i,
                    end: cursor
                };
            }
            i--;
        }
        return null;
    }

    /** @type {{ el: HTMLTextAreaElement, start: number, end: number } | null} */
    var pending = null;

    /**
     * Splice the chosen completion over the pending trigger token, restore
     * focus + caret, then fire `input` so the host persists the change.
     * @param {string} insertText
     */
    function applyInsertion(insertText) {
        var target = pending;
        pending = null;
        if (!target) { return; }
        var el = target.el;
        var value = el.value || '';
        var start = target.start;
        var end = target.end;
        if (start < 0 || end > value.length || start > end) { return; }
        el.value = value.slice(0, start) + insertText + value.slice(end);
        var caret = start + insertText.length;
        el.focus();
        try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Document-level delegation: covers textareas rendered after script load.
    document.addEventListener('keydown', function (ev) {
        if (!(ev.ctrlKey && ev.shiftKey && (ev.key === ' ' || ev.code === 'Space'))) { return; }
        var el = ev.target;
        if (!(el instanceof HTMLTextAreaElement)) { return; }
        if (el.getAttribute('data-completion') !== 'on') { return; }
        // Own the shortcut for completion-enabled textareas.
        ev.preventDefault();
        ev.stopPropagation();
        var token = detectToken(el.value || '', el.selectionStart);
        if (!token) { return; }
        var api = resolveVscode();
        if (!api) { return; }
        pending = { el: el, start: token.start, end: token.end };
        api.postMessage({ type: 'requestCompletion', kind: token.kind, query: token.query });
    });

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (!msg || msg.type !== 'insertCompletion') { return; }
        applyInsertion(String(msg.text || ''));
    });

})();
