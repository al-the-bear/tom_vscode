// @ts-nocheck
// Ask-User panel — renders the numbered questions + free-form textarea and
// posts the verbatim answer back to the extension. First-paint data arrives in
// window.__INIT__ = { requestId, questions: string[], title?, timeoutAt?, choices?, layout? }
// (choices: buttons at `{{choice:<id>}}` markers or under their question).
// An `answer` choice SELECTS an answer for its question (click again to clear,
// another to change); each such question gets a note field for the user's own
// words, and nothing is sent until "Send answers" posts
// { type: 'answers', answers: [{ choiceId?, text }] per question, text }.
// A `move` / `branch` / `subprocess` choice acts on its click: it posts
// { type: 'choice', choiceId } and the extension answers for it.
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
    // Answer choices select; the round is sent with "Send answers".
    const selectsAnswers = choices.some(function (c) { return c.kind === 'answer'; });
    /** Per question (0-based): the selected answer choice's id. */
    const selected = [];
    /** Per question: its note field, when it has answer choices. */
    const notes = [];

    function showSelection(qi) {
        choiceButtons.forEach(function (b) {
            if (b.getAttribute('data-question') !== String(qi) || b.getAttribute('data-kind') !== 'answer') { return; }
            const on = b.getAttribute('data-choice-id') === selected[qi];
            b.classList.toggle('selected', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function choiceButton(id, qi) {
        const choice = choices.find(function (c) { return c.id === id; });
        if (!choice) { return document.createTextNode('{{choice:' + id + '}}'); }
        const btn = document.createElement('button');
        btn.className = 'ask-choice ask-choice-' + choice.kind;
        btn.textContent = choice.label;
        btn.setAttribute('data-choice-id', choice.id);
        btn.setAttribute('data-question', String(qi));
        btn.setAttribute('data-kind', choice.kind);
        if (choice.kind === 'answer') {
            btn.title = 'Select this answer (click again to clear); sent with Send answers';
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', function () {
                if (submitted) { return; }
                selected[qi] = selected[qi] === choice.id ? undefined : choice.id;
                showSelection(qi);
            });
        } else {
            btn.title = choice.kind === 'move' ? 'Moves the process to ' + choice.target + ' when clicked' : choice.label + ' (acts when clicked)';
            btn.addEventListener('click', function () {
                if (submitted) { return; }
                submitted = true;
                submitBtn.disabled = true;
                choiceButtons.forEach(function (b) { b.disabled = true; });
                btn.classList.add('chosen');
                vscode.postMessage({ type: 'choice', requestId, choiceId: choice.id });
            });
        }
        choiceButtons.push(btn);
        return btn;
    }

    questions.forEach(function (q, i) {
        const li = document.createElement('li');
        const place = layout[i];
        if (place && Array.isArray(place.segments)) {
            place.segments.forEach(function (seg) {
                li.appendChild(seg.choiceId !== undefined ? choiceButton(seg.choiceId, i) : document.createTextNode(seg.text));
            });
            if (Array.isArray(place.below) && place.below.length) {
                const row = document.createElement('div');
                row.className = 'ask-choice-row';
                place.below.forEach(function (id) { row.appendChild(choiceButton(id, i)); });
                li.appendChild(row);
            }
            // A question with answer choices: the user's own words for it, beside or instead of a choice.
            const hasAnswer = choiceButtons.some(function (b) { return b.getAttribute('data-question') === String(i) && b.getAttribute('data-kind') === 'answer'; });
            if (hasAnswer) {
                const note = document.createElement('textarea');
                note.className = 'ask-note';
                note.rows = 2;
                note.setAttribute('data-question', String(i));
                note.placeholder = 'Your own words for question ' + (i + 1) + ' (optional)';
                notes[i] = note;
                li.appendChild(note);
            }
        } else {
            li.textContent = String(q);
        }
        listEl.appendChild(li);
    });

    // With answer choices: the hint and the button say how the round is answered.
    if (selectsAnswers) {
        submitBtn.textContent = 'Send answers';
        const hint = document.querySelector('.ask-hint');
        if (hint) {
            hint.textContent = 'Pick an answer per question (click it again to clear it), add your own words under a question or in the box below, then Send answers. Nothing is sent before.';
        }
        answerEl.placeholder = 'Anything else (optional)…';
        answerEl.rows = 4;
    }

    function submit() {
        if (submitted) { return; }
        submitted = true;
        submitBtn.disabled = true;
        choiceButtons.forEach(function (b) { b.disabled = true; });
        notes.forEach(function (n) { if (n) { n.disabled = true; } });
        if (selectsAnswers) {
            const answers = questions.map(function (_q, i) {
                const a = { text: notes[i] ? notes[i].value : '' };
                if (selected[i] !== undefined) { a.choiceId = selected[i]; }
                return a;
            });
            vscode.postMessage({ type: 'answers', requestId, answers: answers, text: answerEl.value });
            return;
        }
        vscode.postMessage({ type: 'submit', requestId, text: answerEl.value });
    }

    submitBtn.addEventListener('click', submit);

    // Cmd/Ctrl+Enter submits from the textarea or a question's note.
    function submitOnCtrlEnter(e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
    }
    answerEl.addEventListener('keydown', submitOnCtrlEnter);
    notes.forEach(function (n) { if (n) { n.addEventListener('keydown', submitOnCtrlEnter); } });

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
            notes.forEach(function (n) { if (n) { n.disabled = true; } });
            answerEl.disabled = true;
            if (timerEl) {
                timerEl.textContent = msg.note || 'Answered.';
            }
        }
    });

    answerEl.focus();
})();
