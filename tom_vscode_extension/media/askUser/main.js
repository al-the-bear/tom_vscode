// @ts-nocheck
// The user-input panel (src/handlers/userInteractionPanel.ts, vscimpb81): one tab
// per process run with open interactions (badge: how many), the selected run's
// interactions as cards — a question, a tool approval, a plan proposal, a
// picker, an ask waiting in the MD Browser. They are answered in any order.
//
// First paint: window.__INIT__ = { interactions: [...], run?, focusId? }; an
// older shape { requestId, questions, ... } is one question of run `default`.
// Then { type: 'state', interactions, run?, focusId? } on every change.
//
// A question card: answer choices SELECT an answer for their question (click
// again to clear, another to change), each such question gets a note field, and
// nothing is sent until "Send answers" posts
// { type: 'answers', requestId, answers: [{ choiceId?, text }], text }; a
// move / branch / subprocess choice acts on its click ({ type: 'choice',
// requestId, choiceId }); without choices Submit posts { type: 'submit', requestId, text }.
// Other cards post { type: 'approval' | 'plan' | 'picker' | 'reveal', id, ... }.
(function () {
    const vscode = acquireVsCodeApi();
    const init = window.__INIT__ || {};

    const tabsEl = document.getElementById('runTabs');
    const listEl = document.getElementById('interactions');
    const emptyEl = document.getElementById('emptyNote');

    let interactions = Array.isArray(init.interactions) ? init.interactions
        : init.requestId ? [{ id: init.requestId, kind: 'question', run: 'default', createdAt: 0, title: init.title || '', data: init }] : [];
    let selectedRun = init.run;
    /** Built cards by interaction id (kept while open, so typed text survives a redraw). */
    const cards = new Map();

    function runsOf() {
        const counts = {};
        interactions.forEach(function (i) { counts[i.run] = (counts[i.run] || 0) + 1; });
        return Object.keys(counts).sort(function (a, b) { return a === 'default' ? -1 : b === 'default' ? 1 : a < b ? -1 : a > b ? 1 : 0; })
            .map(function (run) { return { run: run, count: counts[run] }; });
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined) { e.textContent = text; }
        return e;
    }

    function runLine(i) {
        const parts = ['run ' + i.run];
        if (i.session) { parts.push('session ' + i.session); }
        if (i.queueItemId) { parts.push('item ' + String(i.queueItemId).slice(0, 8)); }
        return el('div', 'ui-run-line', parts.join(' · '));
    }

    // ----- question -------------------------------------------------------------

    function questionCard(i) {
        const data = i.data || {};
        const requestId = data.requestId || i.id;
        const card = el('div', 'ui-card ui-question');
        const titleEl = el('h2', 'ask-title', data.title && typeof data.title === 'string' ? data.title : 'The assistant has some questions');
        titleEl.id = 'askTitle';
        const hint = el('p', 'ask-hint', 'Answer in the box below in your own words. The questions are numbered so you can structure your reply. Your reply is sent back to the assistant exactly as written. You can also answer from Telegram.');
        const listQ = el('ol', 'ask-questions');
        listQ.id = 'askQuestions';
        const answerEl = el('textarea', 'ask-answer');
        answerEl.id = 'askAnswer';
        answerEl.rows = 10;
        answerEl.placeholder = 'Type your answer here…';
        const bar = el('div', 'ask-bar');
        const timerEl = el('span', 'ask-timer');
        timerEl.id = 'askTimer';
        const submitBtn = el('button', 'primary', 'Submit answer');
        submitBtn.id = 'btnSubmit';
        bar.appendChild(timerEl);
        bar.appendChild(el('div', 'spacer'));
        bar.appendChild(submitBtn);
        card.appendChild(titleEl);
        card.appendChild(runLine(i));
        card.appendChild(hint);
        card.appendChild(listQ);
        card.appendChild(answerEl);
        card.appendChild(bar);

        let submitted = false;
        const questions = Array.isArray(data.questions) ? data.questions : [];
        // Choices (utils/askChoices.ts): `layout[i]` cuts question i at its
        // `{{choice:<id>}}` markers (segments) and names the choices shown under it.
        const choices = Array.isArray(data.choices) ? data.choices : [];
        const layout = Array.isArray(data.layout) ? data.layout : [];
        const choiceButtons = [];
        const selectsAnswers = choices.some(function (c) { return c.kind === 'answer'; });
        const selected = [];
        const notes = [];

        function showSelection(qi) {
            choiceButtons.forEach(function (b) {
                if (b.getAttribute('data-question') !== String(qi) || b.getAttribute('data-kind') !== 'answer') { return; }
                const on = b.getAttribute('data-choice-id') === selected[qi];
                b.classList.toggle('selected', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }

        function lock() {
            submitted = true;
            submitBtn.disabled = true;
            choiceButtons.forEach(function (b) { b.disabled = true; });
            notes.forEach(function (n) { if (n) { n.disabled = true; } });
        }

        function choiceButton(id, qi) {
            const choice = choices.find(function (c) { return c.id === id; });
            if (!choice) { return document.createTextNode('{{choice:' + id + '}}'); }
            const btn = el('button', 'ask-choice ask-choice-' + choice.kind, choice.label);
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
                    lock();
                    btn.classList.add('chosen');
                    vscode.postMessage({ type: 'choice', requestId: requestId, choiceId: choice.id });
                });
            }
            choiceButtons.push(btn);
            return btn;
        }

        questions.forEach(function (q, qi) {
            const li = document.createElement('li');
            const place = layout[qi];
            if (place && Array.isArray(place.segments)) {
                place.segments.forEach(function (seg) {
                    li.appendChild(seg.choiceId !== undefined ? choiceButton(seg.choiceId, qi) : document.createTextNode(seg.text));
                });
                if (Array.isArray(place.below) && place.below.length) {
                    const row = el('div', 'ask-choice-row');
                    place.below.forEach(function (id) { row.appendChild(choiceButton(id, qi)); });
                    li.appendChild(row);
                }
                const hasAnswer = choiceButtons.some(function (b) { return b.getAttribute('data-question') === String(qi) && b.getAttribute('data-kind') === 'answer'; });
                if (hasAnswer) {
                    const note = el('textarea', 'ask-note');
                    note.rows = 2;
                    note.setAttribute('data-question', String(qi));
                    note.placeholder = 'Your own words for question ' + (qi + 1) + ' (optional)';
                    notes[qi] = note;
                    li.appendChild(note);
                }
            } else {
                li.textContent = String(q);
            }
            listQ.appendChild(li);
        });

        if (selectsAnswers) {
            submitBtn.textContent = 'Send answers';
            hint.textContent = 'Pick an answer per question (click it again to clear it), add your own words under a question or in the box below, then Send answers. Nothing is sent before.';
            answerEl.placeholder = 'Anything else (optional)…';
            answerEl.rows = 4;
        }

        function submit() {
            if (submitted) { return; }
            lock();
            if (selectsAnswers) {
                const answers = questions.map(function (_q, qi) {
                    const a = { text: notes[qi] ? notes[qi].value : '' };
                    if (selected[qi] !== undefined) { a.choiceId = selected[qi]; }
                    return a;
                });
                vscode.postMessage({ type: 'answers', requestId: requestId, answers: answers, text: answerEl.value });
                return;
            }
            vscode.postMessage({ type: 'submit', requestId: requestId, text: answerEl.value });
        }

        submitBtn.addEventListener('click', submit);
        function submitOnCtrlEnter(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        }
        answerEl.addEventListener('keydown', submitOnCtrlEnter);
        notes.forEach(function (n) { if (n) { n.addEventListener('keydown', submitOnCtrlEnter); } });

        if (typeof data.timeoutAt === 'number') {
            const tick = function () {
                if (!card.isConnected && submitted) { return; }
                const remainingMs = data.timeoutAt - Date.now();
                if (remainingMs <= 0) {
                    timerEl.textContent = 'Time is up — the assistant will continue on its own.';
                    timerEl.classList.add('expired');
                    return;
                }
                const totalSec = Math.floor(remainingMs / 1000);
                timerEl.textContent = 'Auto-continues in ' + Math.floor(totalSec / 60) + 'm ' + String(totalSec % 60).padStart(2, '0') + 's';
                setTimeout(tick, 1000);
            };
            tick();
        }
        card.__focus = function () { answerEl.focus(); };
        return card;
    }

    // ----- approval, plan, picker, MD Browser -----------------------------------------

    function buttonRow(buttons) {
        const bar = el('div', 'ask-bar');
        bar.appendChild(el('div', 'spacer'));
        buttons.forEach(function (b) { bar.appendChild(b); });
        return bar;
    }

    function approvalCard(i) {
        const d = i.data || {};
        const card = el('div', 'ui-card ui-approval');
        card.appendChild(el('h2', 'ask-title', 'Tool approval: ' + (d.toolName || '')));
        card.appendChild(runLine(i));
        card.appendChild(el('pre', 'ui-pre', String(d.inputSummary || '')));
        const approve = el('button', 'primary', 'Approve');
        const all = el('button', '', 'Approve all (this tool, this session)');
        const deny = el('button', 'danger', 'Deny');
        function answer(approved, approveAll) {
            [approve, all, deny].forEach(function (b) { b.disabled = true; });
            vscode.postMessage({ type: 'approval', id: i.id, approved: approved, approveAll: approveAll });
        }
        approve.addEventListener('click', function () { answer(true, false); });
        all.addEventListener('click', function () { answer(true, true); });
        deny.addEventListener('click', function () { answer(false, false); });
        card.appendChild(buttonRow([deny, all, approve]));
        return card;
    }

    function planCard(i) {
        const d = i.data || {};
        const card = el('div', 'ui-card ui-plan');
        card.appendChild(el('h2', 'ask-title', 'The agent proposes a plan'));
        card.appendChild(runLine(i));
        card.appendChild(el('pre', 'ui-pre', String(d.plan || '')));
        const note = el('textarea', 'ask-note');
        note.rows = 3;
        note.placeholder = 'A note to the agent with Keep planning (optional)';
        card.appendChild(note);
        const accept = el('button', 'primary', 'Accept and leave plan mode');
        const keep = el('button', '', 'Keep planning');
        function answer(accepted) {
            accept.disabled = true; keep.disabled = true; note.disabled = true;
            vscode.postMessage({ type: 'plan', id: i.id, accepted: accepted, feedback: note.value });
        }
        accept.addEventListener('click', function () { answer(true); });
        keep.addEventListener('click', function () { answer(false); });
        card.appendChild(buttonRow([keep, accept]));
        return card;
    }

    function pickerCard(i) {
        const d = i.data || {};
        const items = Array.isArray(d.items) ? d.items : [];
        const many = d.canPickMany === true;
        const card = el('div', 'ui-card ui-picker');
        card.appendChild(el('h2', 'ask-title', d.title || 'Pick'));
        card.appendChild(runLine(i));
        if (d.prompt) { card.appendChild(el('p', 'ask-hint', String(d.prompt))); }
        const list = el('div', 'ui-picker-list');
        const inputs = items.map(function (it, idx) {
            const row = el('label', 'ui-picker-item');
            const input = document.createElement('input');
            input.type = many ? 'checkbox' : 'radio';
            input.name = 'pick-' + i.id;
            input.value = String(idx);
            row.appendChild(input);
            row.appendChild(document.createTextNode(' ' + (it.label || '') + (it.description ? ' — ' + it.description : '')));
            list.appendChild(row);
            return input;
        });
        card.appendChild(list);
        const other = el('input', 'ui-picker-other');
        other.type = 'text';
        other.placeholder = 'Other… (your own answer)';
        card.appendChild(other);
        const choose = el('button', 'primary', 'Choose');
        const dismiss = el('button', '', 'Dismiss');
        function done(dismissed) {
            choose.disabled = true; dismiss.disabled = true;
            const selected = inputs.filter(function (x) { return x.checked; }).map(function (x) { return Number(x.value); });
            vscode.postMessage({ type: 'picker', id: i.id, dismissed: dismissed, selected: selected, other: other.value });
        }
        choose.addEventListener('click', function () { done(false); });
        dismiss.addEventListener('click', function () { done(true); });
        card.appendChild(buttonRow([dismiss, choose]));
        return card;
    }

    function mdBrowserCard(i) {
        const d = i.data || {};
        const card = el('div', 'ui-card ui-mdbrowser');
        card.appendChild(el('h2', 'ask-title', 'Waiting in the MD Browser' + (d.title ? ': ' + d.title : '')));
        card.appendChild(runLine(i));
        card.appendChild(el('p', 'ask-hint', String(d.file || '')));
        const show = el('button', 'primary', 'Show it');
        show.addEventListener('click', function () { vscode.postMessage({ type: 'reveal', id: i.id }); });
        card.appendChild(buttonRow([show]));
        return card;
    }

    const BUILDERS = { question: questionCard, approval: approvalCard, plan: planCard, picker: pickerCard, mdBrowser: mdBrowserCard };

    // ----- tabs and cards -----------------------------------------------------------

    function render(focusId) {
        const runs = runsOf();
        const open = {};
        interactions.forEach(function (i) { open[i.id] = true; });
        Array.from(cards.keys()).forEach(function (id) { if (!open[id]) { cards.delete(id); } });
        if (!runs.some(function (r) { return r.run === selectedRun; })) { selectedRun = runs.length ? runs[0].run : undefined; }
        tabsEl.innerHTML = '';
        tabsEl.hidden = runs.length === 0;
        runs.forEach(function (r) {
            const tab = el('button', 'run-tab' + (r.run === selectedRun ? ' active' : ''));
            tab.setAttribute('role', 'tab');
            tab.setAttribute('data-run', r.run);
            tab.setAttribute('aria-selected', r.run === selectedRun ? 'true' : 'false');
            tab.title = 'Run ' + r.run + ': ' + r.count + ' waiting for you';
            tab.appendChild(document.createTextNode('run ' + r.run + ' '));
            tab.appendChild(el('span', 'run-tab-count', String(r.count)));
            tab.addEventListener('click', function () { selectedRun = r.run; render(); });
            tabsEl.appendChild(tab);
        });
        while (listEl.firstChild) { listEl.removeChild(listEl.firstChild); }
        interactions.filter(function (i) { return i.run === selectedRun; }).forEach(function (i) {
            let card = cards.get(i.id);
            if (!card) {
                const build = BUILDERS[i.kind];
                if (!build) { return; }
                card = build(i);
                card.setAttribute('data-id', i.id);
                card.setAttribute('data-kind', i.kind);
                cards.set(i.id, card);
            }
            listEl.appendChild(card);
        });
        emptyEl.hidden = interactions.length > 0;
        const focus = focusId ? cards.get(focusId) : undefined;
        if (focus) {
            if (focus.scrollIntoView) { focus.scrollIntoView({ block: 'nearest' }); }
            if (focus.__focus) { focus.__focus(); }
        }
    }

    window.addEventListener('message', function (event) {
        const msg = event.data || {};
        if (msg.type === 'state') {
            interactions = Array.isArray(msg.interactions) ? msg.interactions : [];
            if (msg.run) { selectedRun = msg.run; }
            render(msg.focusId);
        }
    });

    render(init.focusId || (interactions.length === 1 ? interactions[0].id : undefined));
})();
