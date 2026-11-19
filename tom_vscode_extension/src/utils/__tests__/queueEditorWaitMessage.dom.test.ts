/**
 * The Prompt Queue editor: writing to a waiting turn from the item, and the item's ask panel (vscimpb173;
 * media/shared/queueEntryRenderFunctions.js renderWaitMessageBox / renderWaitMessages / renderItemAsks,
 * media/queueEditor/main.js).
 *
 *   QM-1 the tomAi_waitFor panel: Message (only while `canMessageWait`) opens a text area with Send and Cancel right
 *        in the item; Send posts `messageWaitingItem` with the item id and the text and closes the box; Cancel closes
 *        it and drops the draft; an empty text sends nothing; the draft survives a redraw
 *   QM-2 the background-wait panel: the same Message box beside Wait without limit / Keep waiting / Stop waiting
 *   QM-3 the messages written are listed under the panel with their state and the answer; while the turn answers
 *        and no wait panel shows, they are listed on their own
 *   QM-4 the ask panel, a question: the questions, their choices (answer choices select, a preselected one is
 *        selected; a move acts at once and posts `choice`), a text area; Send posts `answers` (every question's
 *        choice, the text) — `submit` with the text when no answer choice exists; Open question stays
 *   QM-5 the ask panel, a picker: its items (radio, or checkboxes with canPickMany), Other…, Choose posts `picker`
 *        with the selected indexes and the text, Dismiss posts `dismissed`
 *   QM-6 the ask panel, an MD Browser ask: the file, its buttons (each posts `mdButton` with its id) and Show
 *        document (posts `reveal`); a tool approval is named and answered in the full panel
 *   QM-7 the host: the two messages reach the manager and the ask service; the item's state carries
 *        `canMessageWait`, `waitMessagesView` and `askViews`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

function readMedia(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }, items: unknown[]): { w: Win; posted: Win[]; doc: Win } {
    const html = readMedia('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    const posted: Win[] = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: Win) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({}) });
    w.__INIT__ = {
        state: { items, autoSend: false, processRuns: ['default'], currentRun: 'default' },
        queueDefaultPickerHtml: '<select id="queueDefault-transport-profile"></select>',
        addFormPickerHtml: '<select id="addForm-transport-profile"></select>',
    };
    w.eval([
        readMedia('shared', 'queueEntryUtils.js'),
        readMedia('shared', 'queueEntryRenderFunctions.js'),
        readMedia('shared', 'queueEntryMessageHandlers.js'),
        readMedia('queueEditor', 'main.js'),
    ].join('\n;\n'));
    return { w, posted, doc: w.document };
}

const base = { type: 'normal', template: '(None)', createdAt: '2026-11-19T10:00:00.000Z' };
const sending = (id: string, extra: Record<string, unknown>): Record<string, unknown> => ({ ...base, id, status: 'sending', originalText: id, expandedText: id, ...extra });
const UNTIL = new Date(Date.now() + 65 * 60_000).toISOString();
const WAIT = { reason: 'pub.dev limit', until: UNTIL, untilLabel: '14:20', left: 'until 14:20 (1 h 5 min left)', since: '2026-11-19T12:00:00.000Z' };
const BG = { line: '1 task, 5 min of 6 h', limit: '6 h', unlimited: false, items: [{ id: 'b1', kind: 'task', description: 'the corpus run' }] };
const ofType = (posted: Win[], type: string): Win[] => posted.filter((m) => m.type === type);

describe('Prompt Queue editor — writing to a waiting turn, answering in the item', () => {
    test('QM-1: the message box of the tomAi_waitFor panel', (t) => {
        const { w, posted, doc } = setup(t, [
            sending('a', { waitForView: WAIT, canMessageWait: true }),
            sending('b', { waitForView: WAIT }),
        ]);
        const panel = (id: string): Win => doc.querySelector(`.wait-for[data-qid="${id}"]`);
        assert.equal(panel('b').querySelector('[data-wait-msg="open"]'), null, 'no Message while no message can reach the turn');
        const open = panel('a').querySelector('[data-wait-msg="open"]');
        assert.equal(open.textContent, 'Message');
        assert.equal(panel('a').querySelector('.wait-msg-text'), null, 'closed at first');
        assert.match(open.getAttribute('onclick'), /toggleWaitMessage\('a'\)/);
        w.toggleWaitMessage('a');
        const ta = panel('a').querySelector('textarea.wait-msg-text');
        assert.ok(ta, 'the text area opens right in the item');
        assert.equal(ta.id, 'waitMsg-a');
        assert.deepEqual([...panel('a').querySelectorAll('.wait-msg-bar button')].map((b: Win) => b.textContent), ['Send', 'Cancel']);
        assert.match(panel('a').querySelector('[data-wait-msg="send"]').getAttribute('onclick'), /sendWaitMessage\('a'\)/);
        assert.match(panel('a').querySelector('[data-wait-msg="cancel"]').getAttribute('onclick'), /cancelWaitMessage\('a'\)/);
        assert.match(ta.getAttribute('oninput'), /waitMessageDraft\('a', this\.value\)/);
        // An empty text sends nothing.
        w.sendWaitMessage('a');
        assert.equal(ofType(posted, 'messageWaitingItem').length, 0);
        // The draft survives a redraw.
        ta.value = 'How far are you?';
        w.waitMessageDraft('a', ta.value);
        w.render();
        assert.equal(panel('a').querySelector('textarea.wait-msg-text').value, 'How far are you?');
        // Cancel closes it and drops the draft.
        w.cancelWaitMessage('a');
        assert.equal(panel('a').querySelector('.wait-msg-text'), null);
        w.toggleWaitMessage('a');
        assert.equal(panel('a').querySelector('textarea.wait-msg-text').value, '');
        // Send posts the item and the text, and closes the box.
        panel('a').querySelector('textarea.wait-msg-text').value = 'Also bump the changelog.\nThen wait on.';
        w.sendWaitMessage('a');
        assert.deepEqual(ofType(posted, 'messageWaitingItem'), [{ type: 'messageWaitingItem', id: 'a', text: 'Also bump the changelog.\nThen wait on.' }]);
        assert.equal(panel('a').querySelector('.wait-msg-text'), null);
        // The wait's own button is still there.
        assert.equal(panel('a').querySelector('.wait-for-btn').textContent, 'Interrupt the wait and move on');
    });

    test('QM-2: the message box of the background-wait panel', (t) => {
        const { w, posted, doc } = setup(t, [sending('a', { backgroundWaitView: BG, canMessageWait: true }), sending('b', { backgroundWaitView: BG })]);
        const panel = doc.querySelector('.bg-wait[data-qid="a"]');
        assert.deepEqual([...panel.querySelectorAll('button')].map((b: Win) => b.textContent), ['?', 'Wait without limit', 'Keep waiting up to 6 h', 'Stop waiting', 'Message']);
        assert.equal(doc.querySelector('.bg-wait[data-qid="b"] [data-wait-msg="open"]'), null);
        w.toggleWaitMessage('a');
        const now = doc.querySelector('.bg-wait[data-qid="a"]');
        now.querySelector('textarea.wait-msg-text').value = 'status?';
        w.sendWaitMessage('a');
        assert.deepEqual(ofType(posted, 'messageWaitingItem'), [{ type: 'messageWaitingItem', id: 'a', text: 'status?' }]);
    });

    test('QM-3: the messages written, with what became of them', (t) => {
        const msgs = [
            { at: '2026-11-19T12:05:00.000Z', into: 'waitFor', text: 'How <far> are you?', state: 'the wait goes on', answer: 'Half way.' },
            { at: '2026-11-19T12:09:00.000Z', into: 'waitFor', text: 'ok', state: 'the agent has it' },
        ];
        const { doc } = setup(t, [
            sending('a', { waitForView: WAIT, canMessageWait: true, waitMessagesView: msgs }),
            sending('b', { backgroundWaitView: BG, waitMessagesView: [msgs[0]] }),
            sending('c', { waitMessagesView: [msgs[1]] }),
        ]);
        const list = [...doc.querySelectorAll('.wait-for[data-qid="a"] .wait-msg')] as Win[];
        assert.equal(list.length, 2);
        assert.match(list[0].querySelector('.wait-msg-head').textContent, /^You, \d\d:\d\d — the wait goes on$/);
        assert.equal(list[0].querySelector('.wait-msg-body').textContent, 'How <far> are you?', 'escaped');
        assert.equal(list[0].querySelector('.wait-msg-answer').textContent, 'Answer: Half way.');
        assert.equal(list[1].querySelector('.wait-msg-answer'), null);
        assert.equal(list[1].querySelector('.wait-msg-state').textContent, 'the agent has it');
        assert.equal(doc.querySelectorAll('.bg-wait[data-qid="b"] .wait-msg').length, 1);
        // No wait panel (the turn is answering): the messages on their own.
        const alone = doc.querySelector('.wait-msgs-alone[data-qid="c"]');
        assert.equal(alone.querySelectorAll('.wait-msg').length, 1);
        assert.equal(doc.querySelectorAll('.wait-msgs-alone').length, 1, 'only where no wait panel shows them');
    });

    test('QM-4: the ask panel of a question', (t) => {
        const withChoices = {
            id: 'ask_1', kind: 'question', title: 'Release', createdAt: 1,
            data: {
                requestId: 'ask_1', questions: ['Ship it? {{choice:yes}} {{choice:no}}', 'Which tag?', 'Then?'],
                choices: [
                    { id: 'yes', label: 'Yes', kind: 'answer', selected: true }, { id: 'no', label: 'No', kind: 'answer' },
                    { id: 'v1', label: 'v1', kind: 'answer' }, { id: 'go', label: 'Go to review', kind: 'move', target: 'review' },
                ],
                layout: [
                    { segments: [{ text: 'Ship it? ' }, { choiceId: 'yes' }, { text: ' ' }, { choiceId: 'no' }], below: [] },
                    { segments: [{ text: 'Which tag?' }], below: ['v1'] },
                    { segments: [{ text: 'Then?' }], below: ['go'] },
                ],
            },
        };
        const plain = { id: 'ask_2', kind: 'question', title: 'The assistant has some questions', createdAt: 2, data: { requestId: 'ask_2', questions: ['Why <b>?'], choices: [], layout: [] } };
        const { w, posted, doc } = setup(t, [sending('a', { askViews: [withChoices] }), sending('b', { askViews: [plain] }), { ...base, id: 'c', status: 'pending', originalText: 'c', expandedText: 'c', askViews: [plain] }]);
        assert.deepEqual([...doc.querySelectorAll('.item-ask')].map((p: Win) => [p.dataset.qid, p.dataset.ask, p.dataset.askKind]), [['a', 'ask_1', 'question'], ['b', 'ask_2', 'question']], 'sending items only');
        const a = (): Win => doc.querySelector('.item-ask[data-ask="ask_1"]');
        assert.match(a().querySelector('.item-ask-badge').textContent, /^❓ The turn asks: Release$/);
        assert.equal(a().querySelector('[data-ask-action="open"]').textContent, 'Open question');
        assert.deepEqual([...a().querySelectorAll('.item-ask-questions li')].map((li: Win) => li.textContent), ['Ship it? Yes No', 'Which tag?v1', 'Then?Go to review']);
        const choice = (id: string): Win => a().querySelector(`[data-ask-choice="${id}"]`);
        assert.ok(choice('yes').classList.contains('selected'), 'the preselected answer');
        assert.equal(choice('no').getAttribute('aria-pressed'), 'false');
        assert.match(choice('no').getAttribute('onclick'), /askToggleChoice\('ask_1', 0, 'no'\)/);
        w.askToggleChoice('ask_1', 0, 'no');
        assert.ok(choice('no').classList.contains('selected') && !choice('yes').classList.contains('selected'), 'one answer per question');
        w.askToggleChoice('ask_1', 1, 'v1');
        assert.ok(choice('v1').classList.contains('selected'));
        w.askToggleChoice('ask_1', 1, 'v1');
        assert.ok(!choice('v1').classList.contains('selected'), 'a second click clears it');
        w.askToggleChoice('ask_1', 1, 'v1');
        a().querySelector('textarea.item-ask-text').value = 'and tell the team';
        assert.match(a().querySelector('[data-ask-action="send"]').getAttribute('onclick'), /askSend\('a', 'ask_1'\)/);
        w.askSend('a', 'ask_1');
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop(), {
            type: 'answerItemAsk', id: 'a', askId: 'ask_1',
            response: { type: 'answers', requestId: 'ask_1', answers: [{ text: '', choiceId: 'no' }, { text: '', choiceId: 'v1' }, { text: '' }], text: 'and tell the team' },
        });
        // A choice that acts at once.
        assert.match(choice('go').getAttribute('onclick'), /askChoiceAct\('a', 'ask_1', 'go'\)/);
        w.askChoiceAct('a', 'ask_1', 'go');
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop().response, { type: 'choice', requestId: 'ask_1', choiceId: 'go' });
        // Without answer choices: the text, as the panel's Submit sends it.
        const b = doc.querySelector('.item-ask[data-ask="ask_2"]');
        assert.equal(b.querySelector('.item-ask-questions li').textContent, 'Why <b>?', 'escaped');
        b.querySelector('textarea.item-ask-text').value = 'Because.';
        w.askSend('b', 'ask_2');
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop(), { type: 'answerItemAsk', id: 'b', askId: 'ask_2', response: { type: 'submit', requestId: 'ask_2', text: 'Because.' } });
        // Open question: the full panel.
        w.openPendingQuestion('b');
        assert.deepEqual(ofType(posted, 'openPendingQuestion'), [{ type: 'openPendingQuestion', id: 'b' }]);
    });

    test('QM-5: the ask panel of a picker', (t) => {
        const one = { id: 'qp_1', kind: 'picker', title: 'Which branch?', createdAt: 1, live: true, data: { prompt: 'Pick one', items: [{ label: 'main' }, { label: 'dev', description: 'the next release' }], canPickMany: false } };
        const many = { id: 'pick_2', kind: 'picker', title: 'Which hosts?', createdAt: 2, data: { items: [{ label: 'mbp' }, { label: 'bomber' }, { label: 'bigbeast' }], canPickMany: true } };
        const { w, posted, doc } = setup(t, [sending('a', { askViews: [one] }), sending('b', { askViews: [many] })]);
        const p1 = doc.querySelector('.item-ask[data-ask="qp_1"]');
        assert.match(p1.querySelector('.item-ask-badge').textContent, /asks you to pick: Which branch\?$/);
        assert.equal(p1.querySelector('.item-ask-hint').textContent, 'Pick one');
        assert.deepEqual([...p1.querySelectorAll('.item-ask-pick')].map((l: Win) => l.textContent.trim()), ['main', 'dev — the next release']);
        assert.ok([...p1.querySelectorAll('input[data-ask-pick]')].every((i: Win) => i.type === 'radio'));
        assert.match(p1.querySelector('input[data-ask-pick="1"]').getAttribute('onclick'), /askPickToggle\('qp_1', 1, false, this\.checked\)/);
        w.askPickToggle('qp_1', 0, false, true);
        w.askPickToggle('qp_1', 1, false, true);
        assert.match(p1.querySelector('[data-ask-action="choose"]').getAttribute('onclick'), /askPickSend\('a', 'qp_1', false\)/);
        w.askPickSend('a', 'qp_1', false);
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop(), { type: 'answerItemAsk', id: 'a', askId: 'qp_1', response: { type: 'picker', id: 'qp_1', dismissed: false, selected: [1], other: '' } });
        const p2 = doc.querySelector('.item-ask[data-ask="pick_2"]');
        assert.ok([...p2.querySelectorAll('input[data-ask-pick]')].every((i: Win) => i.type === 'checkbox'));
        w.askPickToggle('pick_2', 2, true, true);
        w.askPickToggle('pick_2', 0, true, true);
        w.askPickToggle('pick_2', 1, true, true);
        w.askPickToggle('pick_2', 1, true, false);
        p2.querySelector('.item-ask-other').value = 'legiondary01';
        w.askPickSend('b', 'pick_2', false);
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop().response, { type: 'picker', id: 'pick_2', dismissed: false, selected: [0, 2], other: 'legiondary01' });
        assert.match(p2.querySelector('[data-ask-action="dismiss"]').getAttribute('onclick'), /askPickSend\('b', 'pick_2', true\)/);
        w.askPickSend('b', 'pick_2', true);
        assert.equal(ofType(posted, 'answerItemAsk').pop().response.dismissed, true);
    });

    test('QM-6: the ask panel of an MD Browser ask, and of an approval', (t) => {
        const md = { id: 'mdask_1', kind: 'mdBrowser', title: 'Review round', createdAt: 1, data: { file: '_ai/quests/q1/review.md', requestId: 'mdask_1', buttons: [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel' }], keepFile: true } };
        const approval = { id: 'tu_1', kind: 'approval', title: 'Tool approval: Bash', createdAt: 2, data: { toolName: 'Bash' } };
        const { w, posted, doc } = setup(t, [sending('a', { askViews: [md, approval] })]);
        const p = doc.querySelector('.item-ask[data-ask="mdask_1"]');
        assert.match(p.querySelector('.item-ask-badge').textContent, /asks in the MD Browser: Review round$/);
        assert.equal(p.querySelector('.item-ask-hint').textContent, '_ai/quests/q1/review.md');
        assert.deepEqual([...p.querySelectorAll('[data-ask-md]')].map((b: Win) => [b.getAttribute('data-ask-md'), b.textContent]), [['continue', 'Continue'], ['cancel', 'Cancel']]);
        assert.match(p.querySelector('[data-ask-action="show"]').getAttribute('onclick'), /askShowDocument\('a', 'mdask_1'\)/);
        w.askShowDocument('a', 'mdask_1');
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop(), { type: 'answerItemAsk', id: 'a', askId: 'mdask_1', response: { type: 'reveal', id: 'mdask_1' } });
        assert.match(p.querySelector('[data-ask-md="continue"]').getAttribute('onclick'), /askMdButton\('a', 'mdask_1', 'continue'\)/);
        w.askMdButton('a', 'mdask_1', 'continue');
        assert.deepEqual(ofType(posted, 'answerItemAsk').pop().response, { type: 'mdButton', id: 'mdask_1', buttonId: 'continue' });
        const ap = doc.querySelector('.item-ask[data-ask="tu_1"]');
        assert.match(ap.querySelector('.item-ask-badge').textContent, /asks for approval: Tool approval: Bash$/);
        assert.equal(ap.querySelector('.item-ask-hint').textContent, 'Answered in the full panel.');
        assert.ok(ap.querySelector('[data-ask-action="open"]'));
        assert.equal(ap.querySelector('[data-ask-action="send"]'), null);
    });

    test('QM-7: the host', () => {
        const host = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'queueEditor-handler.ts'), 'utf-8');
        const message = host.slice(host.indexOf("case 'messageWaitingItem':"), host.indexOf("case 'answerItemAsk':"));
        assert.match(message, /qm\.messageWaitingItem\(String\(msg\.id \?\? ''\), String\(msg\.text \?\? ''\)\)/);
        assert.match(message, /The message was not sent: \$\{r\.reason\}/);
        const answer = host.slice(host.indexOf("case 'answerItemAsk':"), host.indexOf("case 'openPendingQuestion':"));
        assert.match(answer, /answerItemAsk\(String\(msg\.id \?\? ''\), String\(msg\.askId \?\? ''\)/);
        assert.match(host, /canMessageWaitOf\(item\) \? \{ canMessageWait: true \}/);
        assert.match(host, /waitMessagesView: waitMessageViews\(item\.waitMessages\)/);
        assert.match(host, /askViews: itemAskViews\(item\.id\)/);
        // The same styles serve both panels.
        const css = readMedia('shared', 'queueEntryStyles.css');
        for (const cls of ['.wait-msg-box', '.wait-msg-text', '.wait-msgs', '.item-ask', '.item-ask-choice.selected']) { assert.ok(css.includes(cls), cls); }
    });
});
