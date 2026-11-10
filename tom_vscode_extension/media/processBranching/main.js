// @ts-nocheck
// Process branching editor — host: src/handlers/processBranching-handler.ts.
// window.__INIT__ = { step, process, cards: BranchingCard[], followUps: [{value, label}] }.
// Start posts { type: 'start', kind, process, followUp }; Dismiss posts { type: 'dismiss' }.
(function () {
    var vscode = acquireVsCodeApi();
    var init = window.__INIT__ || {};
    var cards = Array.isArray(init.cards) ? init.cards : [];
    var followUps = Array.isArray(init.followUps) ? init.followUps : [];

    function esc(text) {
        return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    document.getElementById('title').textContent = 'Start from ' + (init.step || 'this step') + (init.process ? ' (' + init.process + ')' : '');

    function card(c, i) {
        var inputs = c.inputs && c.inputs.length
            ? '<div class="inputs"><div class="label">Inputs</div><ul>' + c.inputs.map(function (inp) {
                return '<li><code>' + esc(inp.name) + '</code>' + (inp.kind ? ' <span class="muted">(' + esc(inp.kind) + ')</span>' : '')
                    + ' ← ' + (inp.from ? '<code>' + esc(inp.from) + '</code>' : '<span class="' + (inp.required ? 'warn' : 'muted') + '">not filled' + (inp.required ? ' — required' : '') + '</span>') + '</li>';
            }).join('') + '</ul></div>'
            : '';
        var options = followUps.map(function (f) {
            return '<option value="' + esc(f.value) + '"' + (f.value === c.followUp ? ' selected' : '') + '>' + esc(f.label) + (c.recommended && f.value === c.followUp ? ' (recommended)' : '') + '</option>';
        }).join('');
        return '<div class="card ' + esc(c.kind) + (c.reason ? ' suggested' : '') + '" data-index="' + i + '">'
            + '<div class="head"><span class="badge ' + esc(c.kind) + '">' + (c.kind === 'branch' ? 'Branch' : 'Subprocess') + '</span>'
            + '<span class="name">' + esc(c.name) + '</span> <code class="id">' + esc(c.process) + '</code></div>'
            + (c.reason ? '<div class="reason"><span class="label">Suggested:</span> ' + esc(c.reason) + '</div>' : '')
            + (c.summary ? '<div class="summary">' + esc(c.summary) + '</div>' : '')
            + (c.description ? '<div class="description">' + esc(c.description) + '</div>' : '')
            + (c.valid ? '<div class="starts"><span class="label">Starts at</span> ' + esc(c.startsAt) + '</div>' : '<div class="warn">This process is not defined (or its definition is invalid): it cannot start.</div>')
            + inputs
            + '<div class="actions"><label>When it ends: <select class="follow-up">' + options + '</select></label>'
            + '<button class="primary start"' + (c.valid ? '' : ' disabled') + '>Start</button></div>'
            + '</div>';
    }

    var cardsEl = document.getElementById('cards');
    cardsEl.innerHTML = cards.length ? cards.map(card).join('') : '<div class="muted">This step lists no processes to start.</div>';

    cardsEl.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('button.start') : null;
        if (!btn || btn.disabled) { return; }
        var el = btn.closest('.card');
        var c = cards[Number(el.getAttribute('data-index'))];
        if (!c) { return; }
        btn.disabled = true;
        setTimeout(function () { btn.disabled = false; }, 2000);
        vscode.postMessage({ type: 'start', kind: c.kind, process: c.process, followUp: el.querySelector('select.follow-up').value });
    });
    document.getElementById('btnDismiss').addEventListener('click', function () { vscode.postMessage({ type: 'dismiss' }); });
})();
