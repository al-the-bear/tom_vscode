/**
 * The Q&A page's webview (media/qaPanel/) and the Q&A link of USER NOTIFICATIONS (media/userNotifications/).
 *
 *   QD-1 the tabs with their "N new" counters post `tab`; the shown tab's page is visible, the other hidden
 *   QD-2 the filter: the scope select posts `filter`; Selected quests shows a checkbox per quest, ticking posts the
 *        selection; the other scopes name the quests shown
 *   QD-3 the Questions list: newest first as given, the host (unknown when a block names none), open questions and new entries
 *        marked; a click posts `select` with the key; a question with its choices and answer; a process decision
 *   QD-4 a stored answer given: the rendered answer, its question, a suggested todo's record on demand (kept across a
 *        refresh), Add todo and Copy post, an added todo shows its id, mark unread / delete and the bar's delete
 *        buttons post; an answer given without a stored answer lists its suggestions by label
 *   QD-5 the Decisions tab: open decisions with a text field and their option letters (a click puts the letter first),
 *        Save posts `answerDecision` with the key and the text; answered ones show their decision
 *   QD-6 USER NOTIFICATIONS: the bar links the Q&A page's new entries; a click posts `openQa` with the tab
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT = path.resolve(__dirname, '..', '..', '..');
const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function page(t: { after(fn: () => void): void }, name = 'qaPanel'): { w: Json; doc: Json; posted: Json[]; send(state: Json): void } {
    const dom = new JSDOM(src('media', name, 'index.html').replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only' });
    const w = dom.window as Json;
    t.after(() => w.close());
    const posted: Json[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))) });
    w.__INIT__ = {};
    w.eval(src('media', name, 'main.js'));
    return { w, doc: w.document, posted, send: (state) => { w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', ...state } })); } };
}

const STORED = {
    key: 'q1|g-2', kind: 'answerGiven', stored: true,
    id: 'a2', title: 'Why <slow>?', time: '2026-11-19T10:00:00Z', at: '2026-11-19T10:00:00Z', host: 'mbp', quest: 'q1', run: 'r2', session: 'default@r2', queueItemId: 'item-7', tool: 'tomAi_answerUser',
    question: 'Why is it slow?',
    answerHtml: '<p>Because of <strong>x</strong>.</p>',
    prompts: [{ label: 'Next', text: 'Do the <next> step' }],
    todos: [{ quest: 'q1', id: 'x1', title: 'Follow up', record: 'id: x1\ndescription: Do <it>\n' }, { quest: 'q2', file: 'side.q2.todo.yaml', id: 'x2', title: '', record: 'id: x2\n', addedId: 'x2' }],
};
const ROWS = [
    { key: 'q1|g-2', kind: 'answerGiven', time: '2026-11-19T10:00:00Z', host: 'mbp', quest: 'q1', title: 'Why <slow>?', run: 'r2', open: false, isNew: true, stored: true, unread: true },
    { key: 'q1|q-1', kind: 'question', time: '2026-11-18T10:00:00Z', host: 'bomber', quest: 'q1', title: 'Which way?', open: true, isNew: false },
    { key: 'q1|q-6', kind: 'question', time: '2026-11-01T10:00:00Z', host: '', quest: 'q1', title: 'Old one', open: false, isNew: false },
];
const BASE = {
    tab: 'questions', filter: { scope: 'current', selected: [] }, currentQuest: 'q1', allQuests: ['q1', 'q2', 'q3'], quests: ['q1'],
    counts: { questions: 1, decisions: 2 }, questions: ROWS, selected: STORED, decisions: [], total: 1, unread: 1, limit: 500,
};

describe('the Q&A page', () => {
    test('QD-1: the tabs and their counters', (t) => {
        const { doc, posted, send } = page(t);
        assert.deepEqual(posted.shift(), { type: 'ready' });
        send(BASE);
        const tabs = [...doc.querySelectorAll('#tabs .tab')] as Json[];
        assert.deepEqual(tabs.map((b) => b.textContent), ['Questions 1 new', 'Decisions 2 new']);
        assert.ok(tabs[0].classList.contains('active'));
        assert.equal(doc.getElementById('page-questions').classList.contains('hidden'), false);
        assert.equal(doc.getElementById('page-decisions').classList.contains('hidden'), true);
        tabs[1].click();
        assert.deepEqual(posted.pop(), { type: 'tab', tab: 'decisions' });
        send({ ...BASE, tab: 'decisions', counts: { questions: 0, decisions: 0 } });
        assert.deepEqual([...doc.querySelectorAll('#tabs .tab')].map((b: Json) => b.textContent), ['Questions', 'Decisions']);
        assert.equal(doc.getElementById('page-questions').classList.contains('hidden'), true);
        assert.equal(doc.getElementById('page-decisions').classList.contains('hidden'), false);
    });

    test('QD-2: the filter', (t) => {
        const { doc, posted, send, w } = page(t);
        send(BASE);
        const scope = doc.getElementById('scope');
        assert.deepEqual([...scope.options].map((o: Json) => o.textContent), ['Current quest (q1)', 'The workspace\'s quests', 'Selected quests']);
        assert.match(doc.getElementById('filter').textContent, /q1/);
        scope.value = 'workspace';
        scope.dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'filter', filter: { scope: 'workspace', selected: [] } });
        send({ ...BASE, filter: { scope: 'selected', selected: ['q2'] }, quests: ['q2'] });
        const boxes = [...doc.querySelectorAll('#filter input[data-quest]')] as Json[];
        assert.deepEqual(boxes.map((b) => [b.getAttribute('data-quest'), b.checked]), [['q1', false], ['q2', true], ['q3', false]]);
        boxes[2].checked = true;
        boxes[2].dispatchEvent(new w.Event('change', { bubbles: true }));
        assert.deepEqual(posted.pop(), { type: 'filter', filter: { scope: 'selected', selected: ['q2', 'q3'] } });
    });

    test('QD-3: the Questions list and a question', (t) => {
        const { doc, posted, send } = page(t);
        send({ ...BASE, questions: [], selected: null });
        assert.match(doc.querySelector('#list').textContent, /No questions, answers or process decisions yet for q1/);
        assert.match(doc.querySelector('#detail').textContent, /Select an entry/);
        send(BASE);
        const items = [...doc.querySelectorAll('#list .item')] as Json[];
        assert.deepEqual(items.map((i) => i.querySelector('.title').textContent.trim()), ['Why <slow>?', 'Which way?', 'Old one'], 'titles escaped, in the given order');
        assert.deepEqual(items.map((i) => i.querySelector('.host').textContent), ['mbp', 'bomber', 'unknown host']);
        assert.ok(items[0].classList.contains('new') && items[0].classList.contains('selected') && items[0].classList.contains('unread'));
        assert.match(items[1].querySelector('.meta').textContent, /open/);
        assert.match(src('media', 'qaPanel', 'style.css'), /\.item\.new \.title\s*\{[^}]*font-weight:\s*(bold|600|700)/, 'new is bold');
        items[1].click();
        assert.deepEqual(posted.pop(), { type: 'select', key: 'q1|q-1' });
        send({ ...BASE, selected: { key: 'q1|q-1', kind: 'question', title: 'Which way?', time: '2026-11-18T10:00:00Z', host: 'bomber', quest: 'q1', tool: 'tomAi_askUser', questions: ['Left <or> right?'], choices: ['Left', 'Right'], reply: { text: '## Left\nbecause', time: '2026-11-18T10:05:00Z', host: 'bomber', source: 'telegram' } } });
        const detail = doc.querySelector('#detail');
        assert.equal(detail.querySelector('.question').textContent, '1. Left <or> right?');
        assert.deepEqual([...detail.querySelectorAll('.chip')].map((c: Json) => c.textContent), ['Left', 'Right']);
        assert.equal(detail.querySelector('.reply').textContent, '## Left\nbecause');
        assert.match(detail.textContent, /via telegram/);
        send({ ...BASE, selected: { key: 'q1|q-3', kind: 'question', title: 'Open one', time: '2026-11-18T10:00:00Z', host: 'mbp', quest: 'q1', questions: ['?'], choices: [], reply: null } });
        assert.match(doc.querySelector('#detail').textContent, /Not answered/);
        send({ ...BASE, selected: { key: 'q1|d-1', kind: 'decision', title: 'Reset Run: run r2', time: '2026-11-18T10:00:00Z', host: 'mbp', quest: 'q1', run: 'r2', detailsHtml: '<ul><li><strong>Was:</strong> des</li></ul>' } });
        assert.match(doc.querySelector('#detail').textContent, /Process decision.*run r2/);
        assert.equal(doc.querySelector('#detail .answer strong').textContent, 'Was:');
    });

    test('QD-4: a stored answer given', (t) => {
        const { doc, posted, send } = page(t);
        send(BASE);
        assert.match(doc.querySelector('#bar').textContent, /3 entries · 1 unread stored/);
        const detail = doc.querySelector('#detail');
        assert.equal(detail.querySelector('h1').textContent, 'Why <slow>?');
        assert.match(detail.querySelector('.meta').textContent, /mbp.*quest q1.*run r2.*session default@r2.*queue item item-7/);
        assert.equal(detail.querySelector('.question').textContent, 'Why is it slow?');
        assert.equal(detail.querySelector('.answer strong').textContent, 'x');
        const cards = (): Json[] => [...detail.querySelectorAll('[data-todo]')];
        assert.equal(cards().length, 2);
        assert.equal(cards()[0].querySelector('pre'), null, 'the record is hidden until asked for');
        cards()[0].querySelector('[data-action="toggleRecord"]').click();
        assert.equal(cards()[0].querySelector('pre').textContent, 'id: x1\ndescription: Do <it>\n');
        send(BASE);
        assert.ok(cards()[0].querySelector('pre'), 'the open record survives a refresh');
        cards()[0].querySelector('[data-action="addTodo"]').click();
        assert.deepEqual(posted.pop(), { type: 'addTodo', id: 'a2', index: 0 });
        assert.equal(cards()[1].querySelector('[data-action="addTodo"]'), null, 'an added todo has no Add button');
        assert.match(cards()[1].querySelector('.added').textContent, /added as x2/);
        const prompt = detail.querySelector('[data-prompt]');
        assert.equal(prompt.querySelector('pre').textContent, 'Do the <next> step');
        prompt.querySelector('[data-action="copyPrompt"]').click();
        assert.deepEqual(posted.pop(), { type: 'copyPrompt', id: 'a2', index: 0 });
        detail.querySelector('[data-action="markUnread"]').click();
        assert.deepEqual(posted.pop(), { type: 'markUnread', id: 'a2' });
        detail.querySelector('[data-action="delete"]').click();
        assert.deepEqual(posted.pop(), { type: 'delete', id: 'a2' });
        doc.querySelector('#bar [data-action="deleteRead"]').click();
        assert.deepEqual(posted.pop(), { type: 'deleteRead' });
        doc.querySelector('#bar [data-action="deleteAll"]').click();
        assert.deepEqual(posted.pop(), { type: 'deleteAll' });
        // Given on another host: the suggestions by label, no buttons.
        send({ ...BASE, selected: { key: 'q1|g-9', kind: 'answerGiven', title: 'Elsewhere', time: '2026-11-19T10:00:00Z', host: 'bomber', quest: 'q1', answerHtml: '<p>a</p>', promptLabels: ['Go on'], todoLabels: ['x5 — Five'] } });
        const d2 = doc.querySelector('#detail');
        assert.equal(d2.querySelector('[data-action]'), null);
        assert.match(d2.textContent, /Go on/);
        assert.match(d2.textContent, /x5 — Five/);
    });

    test('QD-5: the Decisions tab', (t) => {
        const { doc, posted, send, w } = page(t);
        send({ ...BASE, tab: 'decisions', decisions: [] });
        assert.match(doc.getElementById('page-decisions').textContent, /No todo of q1 has decisions/);
        const decisions = [
            { key: 'q1|d1|0', quest: 'q1', todoId: 'd1', todoTitle: 'Two', todoStatus: 'decision-needed', archived: false, index: 0, summary: 'First <one>', neededHtml: '<p>Pick: (a) one (b) two</p>', open: true, time: '2026-11-20', options: ['a', 'b'], isNew: true },
            { key: 'q1|d3|0', quest: 'q1', todoId: 'd3', todoTitle: 'Old', todoStatus: 'completed', archived: true, index: 0, summary: 'Archived', neededHtml: '', decision: 'b', open: false, time: '2026-11-25', options: [], isNew: false },
        ];
        send({ ...BASE, tab: 'decisions', decisions });
        const cards = [...doc.querySelectorAll('.decision')] as Json[];
        assert.equal(cards.length, 2);
        assert.match(doc.querySelector('.dec-head').textContent, /1 open · 1 answered/);
        assert.equal(cards[0].querySelector('.dec-title b').textContent, 'First <one>');
        assert.ok(cards[0].classList.contains('open') && cards[0].classList.contains('new'));
        assert.match(cards[0].querySelector('.meta').textContent, /d1.*Two.*q1.*decision-needed/);
        assert.match(cards[1].querySelector('.meta').textContent, /archived/);
        assert.match(cards[1].querySelector('.decided').textContent, /Decision: b/);
        assert.equal(cards[1].querySelector('textarea'), null, 'an answered decision has no field');
        // An option letter goes first; the text typed is kept; Save posts.
        const area = cards[0].querySelector('textarea');
        area.value = 'because shorter';
        area.dispatchEvent(new w.Event('input', { bubbles: true }));
        cards[0].querySelector('[data-option="b"]').click();
        assert.equal(area.value, '(b) because shorter');
        cards[0].querySelector('[data-option="a"]').click();
        assert.equal(area.value, '(a) because shorter', 'another letter replaces the first');
        cards[0].querySelector('[data-save]').click();
        assert.deepEqual(posted.pop(), { type: 'answerDecision', key: 'q1|d1|0', answer: '(a) because shorter' });
        // An empty answer posts nothing.
        const before = posted.length;
        send({ ...BASE, tab: 'decisions', decisions });
        doc.querySelector('.decision [data-save]').click();
        assert.equal(posted.length, before);
    });

    test('QD-6: USER NOTIFICATIONS links the Q&A page\'s new entries', (t) => {
        const { doc, posted, send } = page(t, 'userNotifications');
        posted.length = 0;
        send({ rows: [], open: 0, thisWindow: 'w1', qa: { questions: 2, decisions: 1 } });
        const links = [...doc.querySelectorAll('#bar [data-qa]')] as Json[];
        assert.deepEqual(links.map((l) => l.textContent), ['2 new questions', '1 new decision']);
        links[1].click();
        assert.deepEqual(posted.pop(), { type: 'openQa', tab: 'decisions' });
        send({ rows: [], open: 0, thisWindow: 'w1', qa: { questions: 0, decisions: 0 } });
        assert.equal(doc.querySelector('#bar [data-qa]'), null, 'nothing new: no link');
    });
});
