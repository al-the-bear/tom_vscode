// @ts-check
/* Shared "no quest is open" banner (vsc_setup-5).
 *
 * Loaded after a panel's own script in the @CHAT and @WS panels and the @TOM
 * views that need a quest. On load it posts `{ type: 'questHintReady' }`; the
 * extension answers `{ type: 'questHint', show, text, buttons: [{ action,
 * label }] }` (src/handlers/questHint-handler.ts). With `show` the banner is
 * the first child of `<body>` (or fills an element `#tomQuestHint` when the
 * page has one); a button posts `{ type: 'questHintAction', action }`, which
 * the extension runs as a command. Without `show` the banner is removed.
 *
 * Bridge: reads `window.__tomVscodeApi` (the host script publishes its acquired
 * API there), as media/shared/completion.js does. */

(function () {
    var BANNER_ID = 'tomQuestHintBanner';

    /** @returns {VsCodeWebviewApi | null} */
    function resolveVscode() {
        if (window.__tomVscodeApi) { return window.__tomVscodeApi; }
        if (typeof acquireVsCodeApi === 'function') {
            window.__tomVscodeApi = acquireVsCodeApi();
            return window.__tomVscodeApi;
        }
        return null;
    }

    var vscode = resolveVscode();
    if (!vscode) { return; }

    /** @param {{ show?: boolean, text?: string, buttons?: Array<{ action: string, label: string }> }} state */
    function render(state) {
        var existing = document.getElementById(BANNER_ID);
        if (existing) { existing.remove(); }
        if (!state.show) { return; }
        var banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.className = 'tom-quest-hint';
        banner.setAttribute('role', 'note');
        var text = document.createElement('span');
        text.className = 'tom-quest-hint-text';
        text.textContent = state.text || '';
        banner.appendChild(text);
        var buttons = document.createElement('span');
        buttons.className = 'tom-quest-hint-buttons';
        (state.buttons || []).forEach(function (b) {
            var button = document.createElement('button');
            button.type = 'button';
            button.textContent = b.label;
            button.setAttribute('data-quest-hint-action', b.action);
            button.addEventListener('click', function () {
                if (vscode) { vscode.postMessage({ type: 'questHintAction', action: b.action }); }
            });
            buttons.appendChild(button);
        });
        banner.appendChild(buttons);
        var slot = document.getElementById('tomQuestHint');
        if (slot) {
            slot.appendChild(banner);
        } else {
            document.body.insertBefore(banner, document.body.firstChild);
        }
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg && msg.type === 'questHint') { render(msg); }
    });
    vscode.postMessage({ type: 'questHintReady' });
})();
