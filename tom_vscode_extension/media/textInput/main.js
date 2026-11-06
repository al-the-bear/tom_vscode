// @ts-nocheck
// Multi-line text input — see src/handlers/textInput-handler.ts. First paint
// from window.__INIT__ = { title, prompt, value, placeholder, okLabel,
// contextLabel, context }; OK posts { type: 'ok', text }, Cancel / Escape
// posts { type: 'cancel' }, each once.
(function () {
    var vscode = acquireVsCodeApi();
    var init = window.__INIT__ || {};
    function $(id) { return document.getElementById(id); }
    var text = $('tiText');
    var done = false;

    $('tiTitle').textContent = init.title || 'Enter text';
    $('tiPrompt').textContent = init.prompt || '';
    $('tiPrompt').hidden = !init.prompt;
    if (init.context) {
        $('tiContext').hidden = false;
        $('tiContextLabel').textContent = init.contextLabel || '';
        $('tiContextText').textContent = init.context;
    }
    text.value = init.value || '';
    text.placeholder = init.placeholder || '';
    if (init.okLabel) { $('tiOk').textContent = init.okLabel; }

    function finish(message) {
        if (done) { return; }
        done = true;
        $('tiOk').disabled = true;
        $('tiCancel').disabled = true;
        vscode.postMessage(message);
    }
    function ok() { finish({ type: 'ok', text: text.value }); }
    function cancel() { finish({ type: 'cancel' }); }

    $('tiOk').addEventListener('click', ok);
    $('tiCancel').addEventListener('click', cancel);
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    text.focus();
})();
