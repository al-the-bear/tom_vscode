// @ts-nocheck
// Process action page (Proceed) — see src/handlers/processAction-handler.ts. The host
// sends the move ('move'), a fresh preview ('preview') or that the move is no
// longer possible ('unavailable'); this page posts the custom instructions
// with every message, so the host always previews and queues what is typed.
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
    var custom = $('custom');
    /** The move shown (kind + level): the textarea is filled only when it changes, never while typing. */
    var shownKey = null;
    var timer = null;

    function post(type) { vscode.postMessage({ type: type, custom: custom.value }); }

    function showPreview(text) {
        var pre = $('preview');
        pre.textContent = text || 'The Proceed template is empty: confirming only moves the process state; nothing is queued.';
        pre.classList.toggle('muted', !text);
        $('confirm').textContent = text ? 'Add to queue' : 'Move without a prompt';
    }

    window.addEventListener('message', function (e) {
        var msg = e.data || {};
        if (msg.type === 'move') {
            $('unavailable').hidden = true;
            $('page').hidden = false;
            $('label').textContent = msg.label;
            $('title').textContent = msg.title;
            $('process').textContent = msg.process + (msg.quest ? ' — quest ' + msg.quest : '');
            $('from').textContent = msg.from;
            $('to').textContent = msg.to;
            var s = msg.session || {};
            var sessionText = s.name
                ? s.name + (s.mode === 'fork-from-base' || s.mode === 'per-prompt' ? ' — ' + (s.basedOn ? 'from ' + s.basedOn : 'fresh') + ' for every prompt'
                    : s.mode === 'per-iteration' ? ' — ' + (s.basedOn ? 'from ' + s.basedOn : 'fresh') + ' for every queue iteration'
                        : s.basedOn ? ' — based on ' + s.basedOn : '')
                    + (s.profile ? ' · ' + s.profile : '')
                    + (s.source === 'override' ? ' (picked here)' : ' (from the process)')
                : 'the queue default' + (s.source === 'override' ? ' (picked here)' : '');
            $('session').textContent = sessionText;
            $('started').textContent = msg.startedPrompts || '';
            $('started-box').hidden = !msg.startedPrompts;
            var key = msg.kind + '|' + (msg.level || '');
            if (key !== shownKey) {
                shownKey = key;
                custom.value = msg.custom || '';
                custom.focus();
            }
            $('confirm').disabled = false;
            showPreview(msg.preview);
        } else if (msg.type === 'preview') {
            showPreview(msg.preview);
        } else if (msg.type === 'unavailable') {
            $('page').hidden = true;
            var box = $('unavailable');
            box.hidden = false;
            box.textContent = msg.quest
                ? 'This move ("' + msg.kind + '") is not possible at the current position of the process any more. Close this page and choose again in the PROCESS view.'
                : 'No quest is active.';
        }
    });

    custom.addEventListener('input', function () {
        if (timer) { clearTimeout(timer); }
        timer = setTimeout(function () { post('preview'); }, 250);
    });
    custom.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('confirm').click(); }
    });
    $('confirm').addEventListener('click', function () {
        $('confirm').disabled = true;
        post('confirm');
    });
    $('cancel').addEventListener('click', function () { post('cancel'); });
    $('template').addEventListener('click', function () { post('editTemplate'); });
    $('pick-session').addEventListener('click', function () { post('pickSession'); });

    post('ready');
})();
