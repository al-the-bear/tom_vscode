/**
 * What a queue item's turn asks, for the item's own ask panel, and answering it from there (vscimpb173;
 * src/services/queueItemAsks.ts, src/services/livePickers.ts) — with the real ask tools: the tomAi_askUser registry
 * and its panel wiring, the live QuickPick prompter and tomAi_askInMdBrowser.
 *
 *   IA-1 a tomAi_askUser question of the item is one of its asks (questions, choices, layout); Send's `submit`
 *        answers it with the text and `answers` composes the choices exactly as the user-input panel does; the ask
 *        closes everywhere (the registry, the interactions); another item's ask, or one already closed, is refused
 *   IA-2 a picker on screen as a QuickPick is one of the item's asks too (its items without the pinned free-text
 *        entry); answered from the item it settles the QuickPick with the picked item, the items of a
 *        multi-select, or the typed text; Dismiss answers as Escape does; it is gone when the QuickPick is answered
 *   IA-3 a tomAi_askInMdBrowser ask lists its buttons; `mdButton` answers as the click in the MD Browser does
 *        (the same result, the bar cleared), `reveal` only brings the document forward
 *   IA-4 the asks of an item are listed oldest first, each item its own
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({});
after(() => vscodeStub.restore());

// The tool registry first: the handlers below load against it.
import '../tool-executors.js';
import { runAsQueueItem } from '../../services/userWaits.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { userInteractions } from '../../services/userInteractions.js';
import { livePickersOf } from '../../services/livePickers.js';
import { answerItemAsk, itemAskViews } from '../../services/queueItemAsks.js';
import { composeChoiceAnswers } from '../../utils/askChoices.js';
import '../../handlers/askUser-handler.js';
import { createLiveUserPrompter, type LiveWindow, type PickerItem } from '../user-interaction-tools.js';
import { MdBrowserAskSlot, askInMdBrowserImpl, type AskInMdBrowserDeps } from '../ask-in-md-browser-tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

class FakeQuickPick {
    items: readonly Json[] = [];
    title?: string;
    placeholder?: string;
    canSelectMany = false;
    matchOnDescription = false;
    ignoreFocusOut = false;
    value = '';
    selectedItems: readonly Json[] = [];
    disposed = 0;
    private hideListener?: () => void;
    onDidAccept = (): { dispose(): void } => ({ dispose() { /* noop */ } });
    onDidHide = (listener: () => void): { dispose(): void } => { this.hideListener = listener; return { dispose() { /* noop */ } }; };
    show(): void { /* shown */ }
    hide(): void { this.hideListener?.(); }
    dispose(): void { this.disposed++; }
}
function fakeWindow(): { win: LiveWindow; qp: () => FakeQuickPick } {
    let last: FakeQuickPick | undefined;
    const win: LiveWindow = {
        createQuickPick() { last = new FakeQuickPick(); return last as Json; },
        async showInputBox() { return undefined; },
    };
    return { win, qp: () => last! };
}

describe('the asks of a queue item, answered from the item', () => {
    test('IA-1: a tomAi_askUser question', async () => {
        const reg = AskUserRegistry.instance;
        const choices = [{ id: 'yes', label: 'Yes', kind: 'answer' as const }, { id: 'no', label: 'No', kind: 'answer' as const }];
        const questions = ['Ship it? {{choice:yes}} {{choice:no}}', 'Which tag?'];
        const first = runAsQueueItem('item-1', () => reg.begin({ questions, title: 'Release', choices, fallbackPrompt: '', onOpen: () => undefined, onResolve: () => undefined }));
        await tick();
        const views = itemAskViews('item-1');
        assert.equal(views.length, 1);
        assert.deepEqual([views[0].kind, views[0].title], ['question', 'Release']);
        assert.deepEqual(views[0].data.questions, questions);
        assert.deepEqual((views[0].data.choices as Json[]).map((c) => c.id), ['yes', 'no']);
        assert.ok(Array.isArray(views[0].data.layout), 'the layout that places the choices');
        assert.deepEqual(itemAskViews('item-2'), [], 'another item has none');
        const askId = views[0].id;
        // Another item's ask is refused; nothing is answered.
        assert.deepEqual(answerItemAsk('item-2', askId, { type: 'submit', requestId: askId, text: 'x' }), { ok: false, reason: 'That question was already closed; your answer was not sent.' });
        assert.equal(itemAskViews('item-1').length, 1);
        // Send with choices: composed exactly as the user-input panel's Send answers.
        const answers = [{ text: '', choiceId: 'no' }, { text: '' }];
        assert.deepEqual(answerItemAsk('item-1', askId, { type: 'answers', requestId: askId, answers, text: 'tag it v2' }), { ok: true, kind: 'question' });
        const got = await first;
        assert.equal(got, composeChoiceAnswers(questions, choices as Json, answers, 'tag it v2'));
        await tick();
        assert.deepEqual(itemAskViews('item-1'), [], 'closed everywhere');
        assert.equal(reg.pendingForQueueItem('item-1'), undefined);
        assert.equal(userInteractions.get(askId), undefined);
        assert.equal(answerItemAsk('item-1', askId, { type: 'submit', requestId: askId, text: 'late' }).ok, false, 'already closed');
        // Send without choices: the text as it is.
        const second = runAsQueueItem('item-1', () => reg.begin({ questions: ['Why?'], fallbackPrompt: '', onOpen: () => undefined, onResolve: () => undefined }));
        await tick();
        const id2 = itemAskViews('item-1')[0].id;
        assert.equal(answerItemAsk('item-1', id2, { type: 'submit', requestId: id2, text: 'Because.' }).ok, true);
        const got2 = await second;
        assert.equal(got2, 'Because.');
    });

    test('IA-2: a picker on screen as a QuickPick', async () => {
        const RED: PickerItem = { label: 'Red', value: 'red', description: 'warm' };
        const BLUE: PickerItem = { label: 'Blue', value: 'blue' };
        const OTHER: PickerItem = { label: 'Other…', value: 'Other…', alwaysShow: true };
        const { win, qp } = fakeWindow();
        const prompter = createLiveUserPrompter(win);
        const one = runAsQueueItem('item-3', () => prompter.showQuickPick([RED, BLUE, OTHER], { title: 'Colour?', placeHolder: 'Pick one' }));
        await tick();
        const views = itemAskViews('item-3');
        assert.equal(views.length, 1);
        assert.deepEqual([views[0].kind, views[0].title, views[0].live], ['picker', 'Colour?', true]);
        assert.deepEqual(views[0].data, { title: 'Colour?', prompt: 'Pick one', items: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }], canPickMany: false }, 'without the pinned free-text entry');
        assert.equal(answerItemAsk('item-9', views[0].id, { selected: [1] }).ok, false, 'another item');
        assert.deepEqual(answerItemAsk('item-3', views[0].id, { type: 'picker', id: views[0].id, dismissed: false, selected: [1], other: '' }), { ok: true, kind: 'picker' });
        assert.deepEqual(await one, BLUE);
        assert.equal(qp().disposed, 1, 'the QuickPick is retracted');
        assert.deepEqual(livePickersOf('item-3'), [], 'gone');
        // The user's own text.
        const typed = runAsQueueItem('item-3', () => prompter.showQuickPick([RED, OTHER], {}));
        await tick();
        answerItemAsk('item-3', itemAskViews('item-3')[0].id, { selected: [], other: '  green ' });
        assert.deepEqual(await typed, { label: 'green', value: 'green' });
        // A multi-select: the picked items, in the list's order.
        const many = runAsQueueItem('item-3', () => prompter.showQuickPick([RED, BLUE], { canPickMany: true }));
        await tick();
        assert.equal(itemAskViews('item-3')[0].data.canPickMany, true);
        answerItemAsk('item-3', itemAskViews('item-3')[0].id, { selected: [0, 1] });
        assert.deepEqual(await many, [RED, BLUE]);
        // Dismiss: as Escape.
        const dismissed = runAsQueueItem('item-3', () => prompter.showQuickPick([RED], {}));
        await tick();
        answerItemAsk('item-3', itemAskViews('item-3')[0].id, { dismissed: true });
        assert.equal(await dismissed, undefined);
        // Answered in the QuickPick itself: no longer one of the item's asks.
        const inWidget = runAsQueueItem('item-3', () => prompter.showQuickPick([RED], {}));
        await tick();
        assert.equal(itemAskViews('item-3').length, 1);
        qp().hide();
        assert.equal(await inWidget, undefined);
        assert.deepEqual(itemAskViews('item-3'), []);
    });

    test('IA-3: a tomAi_askInMdBrowser ask', async () => {
        const cleared: string[] = [];
        const revealed: string[] = [];
        const deps: AskInMdBrowserDeps = {
            workspaceRoot: '/ws',
            exists: () => true,
            openWithBar: () => 'p1',
            clearBar: (_panel, _req, note) => { cleared.push(note); },
            closePanel: () => undefined,
            deleteFile: () => undefined,
            revealPanel: (id) => { revealed.push(id); },
            log: () => undefined,
            now: () => 1000,
            genId: () => 'mdreq1',
        } as AskInMdBrowserDeps;
        const slot = new MdBrowserAskSlot();
        const buttons = [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel' }];
        const call = runAsQueueItem('item-4', () => askInMdBrowserImpl(deps, { filePath: 'notes/ask.md', buttons, title: 'Go on?' }, slot));
        await tick();
        const views = itemAskViews('item-4');
        assert.deepEqual([views[0].kind, views[0].id, views[0].title], ['mdBrowser', 'mdreq1', 'Go on?']);
        assert.deepEqual([views[0].data.file, views[0].data.buttons, views[0].data.keepFile], ['notes/ask.md', buttons, true]);
        // Show document: the panel comes forward, the ask stays open.
        assert.deepEqual(answerItemAsk('item-4', 'mdreq1', { type: 'reveal', id: 'mdreq1' }), { ok: true, kind: 'mdBrowser' });
        assert.deepEqual(revealed, ['p1']);
        assert.equal(slot.hasOpen(), true);
        // A button: answered as the click in the MD Browser.
        assert.equal(answerItemAsk('item-4', 'mdreq1', { type: 'mdButton', id: 'mdreq1', buttonId: 'cancel' }).ok, true);
        const out = JSON.parse(await call);
        assert.deepEqual([out.button, out.label, out.keepFile, out.file], ['cancel', 'Cancel', true, 'notes/ask.md']);
        assert.deepEqual(cleared, ['Answered: Cancel']);
        assert.equal(slot.hasOpen(), false);
        await tick();
        assert.deepEqual(itemAskViews('item-4'), []);
    });

    test('IA-4: the asks of an item, oldest first', () => {
        const picker = { id: 'qp1', queueItemId: 'a', run: 'default', createdAt: 5, title: 'P', items: [{ label: 'x' }], canPickMany: false, answer: () => undefined };
        const interactions = {
            forQueueItem: (id: string) => (id === 'a'
                ? [{ id: 'q1', kind: 'question' as const, run: 'default', queueItemId: 'a', createdAt: 9, title: 'Late', data: { questions: ['?'] } },
                    { id: 't1', kind: 'approval' as const, run: 'default', queueItemId: 'a', createdAt: 1, title: 'Tool approval: Bash', data: {} }]
                : []),
        };
        const views = itemAskViews('a', interactions, (id) => (id === 'a' ? [picker] : []));
        assert.deepEqual(views.map((v) => [v.id, v.kind, v.live]), [['t1', 'approval', undefined], ['qp1', 'picker', true], ['q1', 'question', undefined]]);
        assert.deepEqual(itemAskViews('b', interactions, () => []), []);
        // An ask without a way to answer it from the item says so.
        const noRespond = { get: () => ({ id: 'x', kind: 'plan' as const, run: 'default', queueItemId: 'a', createdAt: 1, title: 'Plan', data: {} }) };
        assert.deepEqual(answerItemAsk('a', 'x', {}, noRespond, () => undefined), { ok: false, reason: 'This ask cannot be answered from the item.' });
    });
});
