// @ts-nocheck
// Ask-User panel — renders the numbered questions + free-form textarea and
// posts the verbatim answer back to the extension. First-paint data arrives in
// window.__INIT__ = { requestId, questions: string[], title?, timeoutAt?, choices?, layout? }
// (choices: buttons at `{{choice:<id>}}` markers or under their question; a
// click posts { type: 'choice', choiceId } and the extension answers for it).
// Live signals (e.g. the ask was answered from Telegram) arrive via postMessage
// as { type: 'resolved' }.
(function () {
    const vscode = acquireVsCodeApi();
    const init = window.__INIT__ || {};
    const requestId = init.requestId;

    const titleEl = document.getElementById('askTitle');
    const listEl = document.getElementById('askQuestions');
    const answerEl = document.getElementById('askAnswer');
    const submitBtn = document.getElementById('btnSubmit');
    const timerEl = document.getElementById('askTimer');

    let submitted = false;

    if (init.title && typeof init.title === 'string') {
        titleEl.textContent = init.title;
    }

    const questions = Array.isArray(init.questions) ? init.questions : [];
    // Choices (utils/askChoices.ts): `layout[i]` cuts question i at its
    // `{{choice:<id>}}` markers (segments) and names the choices shown under it.
    const choices = Array.isArray(init.choices) ? init.choices : [];
    const layout = Array.isArray(init.layout) ? init.layout : [];
    const choiceButtons = [];

    function choiceButton(id) {
        const choice = choices.find(function (c) { return c.id === id; });
        if (!choice) { return document.createTextNode('{{choice:' + id + '}}'); }
        const btn = document.createElement('button');
        btn.className = 'ask-choice ask-choice-' + choice.kind;
        btn.textContent = choice.label;
        btn.setAttribute('data-choice-id', choice.id);
        btn.title = choice.kind === 'move' ? 'Moves the process to ' + choice.target + ' when clicked' : choice.label;
        btn.addEventListener('click', function () {
            if (submitted) { return; }
            submitted = true;
            submitBtn.disabled = true;
            choiceButtons.forEach(function (b) { b.disabled = true; });
            btn.classList.add('chosen');
            vscode.postMessage({ type: 'choice', requestId, choiceId: choice.id });
        });
        choiceButtons.push(btn);
        return btn;
    }

    questions.forEach(function (q, i) {
        const li = document.createElement('li');
        const place = layout[i];
        if (place && Array.isArray(place.segments)) {
            place.segments.forEach(function (seg) {
                li.appendChild(seg.choiceId !== undefined ? choiceButton(seg.choiceId) : document.createTextNode(seg.text));
            });
            if (Array.isArray(place.below) && place.below.length) {
                const row = document.createElement('div');
                row.className = 'ask-choice-row';
                place.below.forEach(function (id) { row.appendChild(choiceButton(id)); });
                li.appendChild(row);
            }
        } else {
            li.textContent = String(q);
        }
        listEl.appendChild(li);
    });

    function submit() {
        if (submitted) { return; }
        submitted = true;
        submitBtn.disabled = true;
        choiceButtons.forEach(function (b) { b.disabled = true; });
        vscode.postMessage({ type: 'submit', requestId, text: answerEl.value });
    }

    submitBtn.addEventListener('click', submit);

    // Cmd/Ctrl+Enter submits from the textarea.
    answerEl.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    });

    // Countdown to the timeout, when one was provided.
    if (typeof init.timeoutAt === 'number' && timerEl) {
        const tick = function () {
            const remainingMs = init.timeoutAt - Date.now();
            if (remainingMs <= 0) {
                timerEl.textContent = 'Time is up — the assistant will continue on its own.';
                timerEl.classList.add('expired');
                return;
            }
            const totalSec = Math.floor(remainingMs / 1000);
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;
            timerEl.textContent = 'Auto-continues in ' + m + 'm ' + String(s).padStart(2, '0') + 's';
            setTimeout(tick, 1000);
        };
        tick();
    }

    // The extension tells us when the ask was resolved elsewhere (Telegram /
    // timeout / cancel) so the panel can stop accepting input.
    window.addEventListener('message', function (event) {
        const msg = event.data || {};
        if (msg.type === 'resolved') {
            submitted = true;
            submitBtn.disabled = true;
            choiceButtons.forEach(function (b) { b.disabled = true; });
            answerEl.disabled = true;
            if (timerEl) {
                timerEl.textContent = msg.note || 'Answered.';
            }
        }
    });

    answerEl.focus();
})();
