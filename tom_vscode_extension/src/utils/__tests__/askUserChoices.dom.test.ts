/**
 * Choice buttons in the question panel (media/askUser/main.js), in a JSDOM
 * with the panel's own shell (ccparity_i_assist-4).
 *
 *   AQ-1 a choice with a marker is a button at the marker's place in its question's text; the others are a row
 *        under their question; a move is marked as one
 *   AQ-2 a move (or branch / subprocess) acts on its click: posts `choice` with the choice id, disables every
 *        button and Submit; an ask without choices renders the plain questions and Submit posts `submit`
 *   AQ-3 (vscimpb35) an `answer` choice selects for its question: shown selected, cleared by a second click,
 *        changed by another; nothing is posted until Send answers, which posts every question's selection and
 *        own words (a note field under each question with answer choices) and the general text; a question
 *        without answer choices has no note field
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { layoutChoices, type AskChoice } from '../askChoices.js';

const ROOT = join(__dirname, '..', '..', '..');
const media = (file: string): string => readFileSync(join(ROOT, 'media', 'askUser', file), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function panel(t: { after(fn: () => void): void }, questions: string[], choices: AskChoice[]) {
    const shell = media('index.html');
    const body = shell.slice(shell.indexOf('<body>') + 6, shell.indexOf('<script'));
    const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.__INIT__ = { requestId: 'req-1', questions, choices, layout: layoutChoices(questions, choices) };
    w.eval(media('main.js'));
    const items = (): Win[] => [...w.document.querySelectorAll('#askQuestions > li')];
    return { w, posted, items };
}

const CHOICES: AskChoice[] = [
    { id: 'go', label: 'Go to review', kind: 'move', target: 'review' },
    { id: 'more', label: 'One more draft', kind: 'answer' },
    { id: 'x', label: 'Explain', kind: 'answer', question: 1 },
];

describe('question panel: choice buttons', () => {
    test('AQ-1: placed at the marker or under the question', (t) => {
        const p = panel(t, ['Ready? {{choice:go}} — or wait', 'Anything else?'], CHOICES);
        const [q1, q2] = p.items();
        const nodes = [...q1.childNodes].map((n: Win) => (n.nodeType === 3 ? `text:${n.textContent}` : `${n.tagName}:${n.textContent}`));
        assert.deepEqual(nodes, ['text:Ready? ', 'BUTTON:Go to review', 'text: — or wait', 'DIV:Explain', 'TEXTAREA:'],
            'the button where the marker was; Explain under question 1; its note field (it has an answer choice)');
        assert.ok(q1.querySelector('[data-choice-id="go"]').classList.contains('ask-choice-move'));
        assert.match(q1.querySelector('[data-choice-id="go"]').title, /Moves the process to review/);
        assert.deepEqual([...q2.querySelectorAll('.ask-choice-row button')].map((b: Win) => b.getAttribute('data-choice-id')), ['more'], 'no question named: the last one');
        assert.ok(!q1.textContent.includes('{{choice:'), 'no marker left in the text');
    });

    test('AQ-2: a move acts on its click', (t) => {
        const p = panel(t, ['Ready? {{choice:go}}'], CHOICES.slice(0, 1));
        const btn = p.w.document.querySelector('[data-choice-id="go"]');
        btn.click();
        btn.click();
        assert.deepEqual(p.posted, [{ type: 'choice', requestId: 'req-1', choiceId: 'go' }], 'once');
        assert.ok(btn.classList.contains('chosen'));
        assert.equal(btn.disabled, true);
        assert.equal(p.w.document.getElementById('btnSubmit').disabled, true);
        assert.equal(p.w.document.getElementById('btnSubmit').textContent, 'Submit answer', 'no answer choices: Submit as before');
        // No choices: plain questions, Submit posts the text.
        const q = panel(t, ['Plain?'], []);
        assert.equal(q.items()[0].textContent, 'Plain?');
        q.w.document.getElementById('askAnswer').value = 'yes';
        q.w.document.getElementById('btnSubmit').click();
        assert.deepEqual(q.posted, [{ type: 'submit', requestId: 'req-1', text: 'yes' }]);
    });

    test('AQ-3: answer choices select; Send answers sends the round', (t) => {
        const choices: AskChoice[] = [
            { id: 'a1', label: 'Yes', kind: 'answer', question: 1 },
            { id: 'a2', label: 'No', kind: 'answer', question: 1 },
            { id: 'c1', label: 'Monthly', kind: 'answer', question: 3 },
            { id: 'c2', label: 'Weekly', kind: 'answer', question: 3, target: 'every week' },
        ];
        const p = panel(t, ['Keep it?', 'Why?', 'How often?'], choices);
        const doc = p.w.document;
        const btn = (id: string) => doc.querySelector(`[data-choice-id="${id}"]`);
        const send = doc.getElementById('btnSubmit');
        assert.equal(send.textContent, 'Send answers');
        assert.match(doc.querySelector('.ask-hint').textContent, /Nothing is sent before/);
        // A note field under each question with answer choices, none under question 2.
        assert.deepEqual([...doc.querySelectorAll('.ask-note')].map((n: Win) => n.getAttribute('data-question')), ['0', '2']);
        // Select, change, clear: nothing posted.
        btn('a1').click();
        assert.equal(btn('a1').classList.contains('selected'), true);
        assert.equal(btn('a1').getAttribute('aria-pressed'), 'true');
        btn('a2').click();
        assert.deepEqual([btn('a1').classList.contains('selected'), btn('a2').classList.contains('selected')], [false, true], 'changed');
        btn('c1').click();
        btn('c1').click();
        assert.equal(btn('c1').classList.contains('selected'), false, 'a second click clears it');
        btn('c2').click();
        assert.deepEqual(p.posted, [], 'nothing sent before Send answers');
        // The user's words beside a choice, and the general text.
        doc.querySelector('.ask-note[data-question="2"]').value = 'on Fridays';
        doc.getElementById('askAnswer').value = 'Thanks.';
        send.click();
        send.click();
        assert.deepEqual(p.posted, [{
            type: 'answers', requestId: 'req-1',
            answers: [{ text: '', choiceId: 'a2' }, { text: '' }, { text: 'on Fridays', choiceId: 'c2' }],
            text: 'Thanks.',
        }], 'once, with every question');
        assert.equal(btn('a1').disabled, true, 'locked after sending');
        assert.equal(doc.querySelector('.ask-note').disabled, true);
    });
});
