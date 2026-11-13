/**
 * The user-input panel's page (media/askUser/main.js, vscimpb81) in a JSDOM with its own shell.
 *
 *   UP-1 one tab per run with open interactions (`default` first), each with its count; the selected run's
 *        interactions as cards with their run (and item); a tab click shows that run's cards
 *   UP-2 the cards post their answers: an approval (Approve, Approve all, Deny), a plan (Accept, Keep planning with
 *        a note), a picker (selection, own words, Dismiss), an MD Browser ask (Show it)
 *   UP-3 a state update keeps a card open while its interaction is (typed text survives), drops the settled ones,
 *        and shows "Nothing is waiting" when none is left
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(__dirname, '..', '..', '..');
const media = (file: string): string => readFileSync(join(ROOT, 'media', 'askUser', file), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

const INTERACTIONS = [
    { id: 'q1', kind: 'question', run: 'default', createdAt: 1, title: 'Q', data: { requestId: 'q1', questions: ['Which?'], choices: [], layout: [] } },
    { id: 'md1', kind: 'mdBrowser', run: 'default', createdAt: 2, title: 'notes', data: { file: 'notes/a.md', panelId: 'p1' } },
    { id: 'tu1', kind: 'approval', run: 'collab', queueItemId: 'item-123456789', createdAt: 3, title: 'Tool approval', data: { toolName: 'tomAi_editFile', inputSummary: 'edit a.ts' } },
    { id: 'plan-1', kind: 'plan', run: 'collab', createdAt: 4, title: 'Plan', data: { plan: '1. do it' } },
    { id: 'pick1', kind: 'picker', run: 'collab', createdAt: 5, title: 'Pick', data: { title: 'Pick one', items: [{ label: 'red' }, { label: 'blue' }], canPickMany: false } },
];

function panel(t: { after(fn: () => void): void }, init: Record<string, unknown>) {
    const shell = media('index.html');
    const body = shell.slice(shell.indexOf('<body>') + 6, shell.indexOf('<script'));
    const dom = new JSDOM(`<body>${body}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Array<Record<string, unknown>> = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.__INIT__ = init;
    w.eval(media('main.js'));
    const tabs = (): string[] => [...w.document.querySelectorAll('#runTabs .run-tab')].map((b: Win) => `${b.getAttribute('data-run')}:${b.querySelector('.run-tab-count').textContent}${b.classList.contains('active') ? '*' : ''}`);
    const cards = (): string[] => [...w.document.querySelectorAll('#interactions .ui-card')].map((c: Win) => `${c.getAttribute('data-kind')}:${c.getAttribute('data-id')}`);
    const card = (id: string): Win => w.document.querySelector(`#interactions .ui-card[data-id="${id}"]`);
    const state = (msg: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', ...msg } })); };
    return { w, posted, tabs, cards, card, state };
}

describe('the user-input panel', () => {
    test('UP-1: one tab per run', (t) => {
        const p = panel(t, { interactions: INTERACTIONS, run: 'collab' });
        assert.deepEqual(p.tabs(), ['default:2', 'collab:3*']);
        assert.deepEqual(p.cards(), ['approval:tu1', 'plan:plan-1', 'picker:pick1']);
        assert.equal(p.card('tu1').querySelector('.ui-run-line').textContent, 'run collab · item item-123');
        p.w.document.querySelector('#runTabs .run-tab[data-run="default"]').click();
        assert.deepEqual(p.cards(), ['question:q1', 'mdBrowser:md1']);
        assert.deepEqual(p.tabs(), ['default:2*', 'collab:3']);
    });

    test('UP-2: the cards post their answers', (t) => {
        const p = panel(t, { interactions: INTERACTIONS, run: 'collab' });
        const buttons = (id: string): Win[] => [...p.card(id).querySelectorAll('button')];
        buttons('tu1').find((b) => b.textContent === 'Approve all (this tool, this session)').click();
        p.card('plan-1').querySelector('textarea').value = 'smaller steps';
        buttons('plan-1').find((b) => b.textContent === 'Keep planning').click();
        p.card('pick1').querySelectorAll('input[type=radio]')[1].checked = true;
        p.card('pick1').querySelector('.ui-picker-other').value = 'green';
        buttons('pick1').find((b) => b.textContent === 'Choose').click();
        p.w.document.querySelector('#runTabs .run-tab[data-run="default"]').click();
        buttons('md1').find((b) => b.textContent === 'Show it').click();
        assert.deepEqual(p.posted, [
            { type: 'approval', id: 'tu1', approved: true, approveAll: true },
            { type: 'plan', id: 'plan-1', accepted: false, feedback: 'smaller steps' },
            { type: 'picker', id: 'pick1', dismissed: false, selected: [1], other: 'green' },
            { type: 'reveal', id: 'md1' },
        ]);
        assert.ok(buttons('q1').some((b) => b.id === 'btnSubmit'), 'the question card is the question form');
    });

    test('UP-3: updates keep open cards', (t) => {
        const p = panel(t, { interactions: INTERACTIONS, run: 'default' });
        p.w.document.getElementById('askAnswer').value = 'half typed';
        p.state({ interactions: INTERACTIONS.filter((i) => i.id !== 'md1' && i.run === 'default') });
        assert.deepEqual(p.tabs(), ['default:1*']);
        assert.deepEqual(p.cards(), ['question:q1']);
        assert.equal(p.w.document.getElementById('askAnswer').value, 'half typed', 'typed text survives');
        assert.equal(p.w.document.getElementById('emptyNote').hidden, true);
        p.state({ interactions: [] });
        assert.deepEqual(p.cards(), []);
        assert.equal(p.w.document.getElementById('emptyNote').hidden, false);
    });
});
