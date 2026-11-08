/**
 * Choice buttons in the question panel (media/askUser/main.js), in a JSDOM
 * with the panel's own shell (ccparity_i_assist-4).
 *
 *   AQ-1 a choice with a marker is a button at the marker's place in its question's text; the others are a row
 *        under their question; a move is marked as one
 *   AQ-2 a click posts `choice` with the choice id and disables every button and Submit; Submit disables the
 *        buttons too; an ask without choices renders the plain questions
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
        assert.deepEqual(nodes, ['text:Ready? ', 'BUTTON:Go to review', 'text: — or wait', 'DIV:Explain'], 'the button where the marker was; Explain under question 1');
        assert.ok(q1.querySelector('[data-choice-id="go"]').classList.contains('ask-choice-move'));
        assert.match(q1.querySelector('[data-choice-id="go"]').title, /Moves the process to review/);
        assert.deepEqual([...q2.querySelectorAll('.ask-choice-row button')].map((b: Win) => b.getAttribute('data-choice-id')), ['more'], 'no question named: the last one');
        assert.ok(!q1.textContent.includes('{{choice:'), 'no marker left in the text');
    });

    test('AQ-2: the click posts the choice', (t) => {
        const p = panel(t, ['Ready? {{choice:go}}'], CHOICES.slice(0, 1));
        const btn = p.w.document.querySelector('[data-choice-id="go"]');
        btn.click();
        btn.click();
        assert.deepEqual(p.posted, [{ type: 'choice', requestId: 'req-1', choiceId: 'go' }], 'once');
        assert.ok(btn.classList.contains('chosen'));
        assert.equal(btn.disabled, true);
        assert.equal(p.w.document.getElementById('btnSubmit').disabled, true);
        // Submit disables the buttons; no choices: plain questions.
        const q = panel(t, ['Plain?'], []);
        assert.equal(q.items()[0].textContent, 'Plain?');
        const r = panel(t, ['Ready? {{choice:go}}'], CHOICES.slice(0, 1));
        r.w.document.getElementById('btnSubmit').click();
        assert.equal(r.w.document.querySelector('[data-choice-id="go"]').disabled, true);
        assert.equal(r.posted[0].type, 'submit');
    });
});
