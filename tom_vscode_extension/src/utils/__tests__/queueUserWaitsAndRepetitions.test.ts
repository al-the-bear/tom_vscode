/**
 * The prompt queue: an item whose prompt waits for the user (services/userWaits.ts), and the answers of every
 * repetition of a repeated item (utils/repetitionAnswers.ts), with the queue editor's rendering of both.
 *
 *   UW-1 a wait opened inside a queue item's dispatch (runAsQueueItem) is that item's; one opened outside names no
 *        item; it closes (once), also when what it waits for throws; listeners are told
 *   UW-2 the waits are opened where a prompt waits for the user: the ask registry's question (tomAi_askUser, the
 *        Agent SDK's AskUserQuestion), the picker's and input box's prompter, the MD Browser ask, tool approvals —
 *        and the queue runs its Anthropic dispatch as the item, re-firing its change event when a wait changes
 *   UW-3 the queue editor: a sending item that waits gets its own colour (waiting-for-user) and a badge naming
 *        a reply or an approval
 *   UW-4 a sending item whose turn waits in a tomAi_askUser question: the badge says since when, Open question posts
 *        `openPendingQuestion`, Continue posts `continueSending` (the extension asks first), Resend of the running
 *        stage posts `resendSendingStage`; no Resend before anything was dispatched
 *   UW-5 a sending item waiting for its background work (vscimpb57): the line (count, running time, limit), the ?
 *        list (each task with its command and output file / handle, kept open over a redraw), the three buttons
 *        posting `backgroundWaitAction`; Wait without limit disabled once there is no limit; nothing for an item
 *        that does not wait (and nothing for a non-sending item, also after a reload's stale state)
 *   UW-6 a repetition whose turn ended with background work still running: its chip red, and the answer shown red
 *        with a note; an item without repetitions: the answer red from answerBackgroundLeft
 *   UW-7 a continued walk iteration (vscimpb58): its chip marked `1 continuation`, the final answer shown with the
 *        earlier one folded below ('ended before its work was done'); an item that stopped shows [⚠ needs attention]
 *        with the reason as its title
 *   RP-1 the repetition key: the walked todo's id, else the repetition number, else the template repetition
 *        number; none for an item that does not repeat
 *   RP-2 recording: one answer per repetition, a repetition answered again replaces its entry in place, empty
 *        answers and non-repeated items record nothing; read back from the entry file's list
 *   RP-3 the queue editor: a chip per repetition under the Answer (the latest active); a click shows that
 *        repetition's answer, its key in the title, and the Markdown buttons take it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { beginUserWait, hasUserWaits, onUserWaitsChanged, queueItemsWaitingForUser, runAsQueueItem, whileWaitingForUser } from '../../services/userWaits.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { recordRepetitionAnswer, repetitionAnswersFromYaml, repetitionKeyOf } from '../repetitionAnswers.js';

const ROOT = join(__dirname, '..', '..', '..');
const media = (...p: string[]): string => readFileSync(join(ROOT, 'media', ...p), 'utf-8');
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf-8');
const count = (raw: number | string | undefined): number => (typeof raw === 'number' ? raw : Number(raw) || 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function queueEditor(items: unknown[], posted?: unknown[]): Win {
    const html = media('queueEditor', 'index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Win;
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => { posted?.push(m); }, setState: () => undefined, getState: () => undefined });
    w.__INIT__ = { state: { items, autoSend: false, anthropicProfiles: [] }, queueDefaultPickerHtml: '', addFormPickerHtml: '' };
    w.eval([media('shared', 'mdOverlay.js'), media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
    return w;
}
const base = { type: 'normal', transport: 'anthropic', template: '(None)', createdAt: new Date().toISOString(), expandedText: '', prePrompts: [], followUps: [] };

describe('queue: waits for the user', () => {
    test('UW-1: whose wait it is', async () => {
        let told = 0;
        const stop = onUserWaitsChanged(() => { told++; });
        let close!: () => void;
        await runAsQueueItem('item-1', async () => {
            await Promise.resolve();
            close = beginUserWait('question');
        });
        const outside = beginUserWait('approval');
        assert.deepEqual(Object.fromEntries(queueItemsWaitingForUser()), { 'item-1': ['question'] }, 'the item\'s; the outside one names none');
        assert.equal(hasUserWaits(), true);
        close();
        close();
        outside();
        assert.equal(queueItemsWaitingForUser().size, 0);
        assert.equal(hasUserWaits(), false);
        await assert.rejects(runAsQueueItem('item-2', () => whileWaitingForUser('approval', async () => { throw new Error('gone'); })));
        assert.equal(hasUserWaits(), false, 'closed although it threw');
        assert.equal(told, 6, 'every open and close told once');
        stop();
    });

    test('UW-2: where the waits are opened', async () => {
        const registry = new AskUserRegistry({ genId: () => 'ask-1' });
        const answer = runAsQueueItem('item-3', () => registry.begin({ questions: ['Which?'], fallbackPrompt: 'f', onOpen: () => undefined, onResolve: () => undefined }));
        await Promise.resolve();
        assert.deepEqual(Object.fromEntries(queueItemsWaitingForUser()), { 'item-3': ['question'] }, 'an open question');
        registry.submit('ask-1', 'that one', 'vscode');
        assert.equal(await answer, 'that one');
        assert.equal(hasUserWaits(), false, 'answered: closed');
        assert.match(src('tools', 'user-interaction-tools.ts'), /whileWaitingForUser\('question', \(\) => \(showingRun === undefined\s*\? onScreen\(run, \(\) => showLiveQuickPick/);
        assert.match(src('tools', 'user-interaction-tools.ts'), /whileWaitingForUser\('question', async \(\) => \{[\s\S]{0,1200}?await win\.showInputBox\(/);
        assert.match(src('tools', 'ask-in-md-browser-tool.ts'), /return whileWaitingForUser\('mdBrowser', \(\) => new Promise<string>/);
        assert.match(src('handlers', 'anthropic-handler.ts'), /return whileWaitingForUser\('approval', \(\) => new Promise<boolean>/);
        const queue = src('managers', 'promptQueueManager.ts');
        assert.match(queue, /runAsQueueItem\(waitItem\?\.id, \(\) => runInProcessPosition/);
        assert.match(queue, /onUserWaitsChanged\(\(\) => m\._onDidChange\.fire\(\)\)/);
    });

    test('UW-3: the editor shows the waiting item', () => {
        const w = queueEditor([
            { ...base, id: 'w1', status: 'sending', originalText: 'prompt-waits', waitingForUser: ['question'] },
            { ...base, id: 'w2', status: 'sending', originalText: 'prompt-approval', waitingForUser: ['approval'] },
            { ...base, id: 'w3', status: 'pending', originalText: 'prompt-free' },
        ]);
        try {
            const el = (text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
            assert.ok(el('prompt-waits').classList.contains('waiting-for-user'));
            assert.match(el('prompt-waits').querySelector('.waiting-user-badge').textContent, /waiting for your reply/);
            assert.match(el('prompt-approval').querySelector('.waiting-user-badge').textContent, /waiting for your approval/);
            assert.equal(el('prompt-free').classList.contains('waiting-for-user'), false);
            assert.match(media('shared', 'queueEntryStyles.css'), /\.queue-item\.waiting-for-user \{[^}]*background/);
        } finally {
            w.close();
        }
    });

    test('UW-5: waiting for its background work', () => {
        const posted: unknown[] = [];
        const view = {
            line: '2 tasks, 1 h 20 min of 6 h', limit: '6 h', unlimited: false,
            items: [
                { id: 'b1', kind: 'task', description: 'Wait for the corpus run', command: 'until [ -f done ]; do sleep 30; done', outputFile: '/tmp/b1.output' },
                { id: 'proc_2', kind: 'command', description: 'npm test', command: 'npm test' },
            ],
        };
        const w = queueEditor([
            { ...base, id: 'g1', status: 'sending', originalText: 'prompt-bg', backgroundWaitView: view },
            { ...base, id: 'g2', status: 'sending', originalText: 'prompt-unlimited', backgroundWaitView: { ...view, line: '1 task, 3 h, no limit', unlimited: true, items: [view.items[0]] } },
            { ...base, id: 'g3', status: 'pending', originalText: 'prompt-stale', backgroundWaitView: view },
            { ...base, id: 'g4', status: 'sending', originalText: 'prompt-plain' },
        ], posted);
        try {
            posted.length = 0;
            const el = (text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
            const bg = el('prompt-bg').querySelector('.bg-wait');
            assert.match(bg.querySelector('.bg-wait-badge').textContent, /Waiting for background work — 2 tasks, 1 h 20 min of 6 h/);
            assert.equal(bg.querySelector('.bg-wait-list'), null, 'the list is closed');
            const click = (b: Win): void => { w.eval(String(b.getAttribute('onclick')).replace('event.stopPropagation();', '')); };
            click(bg.querySelector('.bg-wait-help'));
            const list = el('prompt-bg').querySelector('.bg-wait-list');
            assert.ok(list, 'the ? opened the list (kept over the redraw)');
            assert.match(list.textContent, /Wait for the corpus run \[b1\]/);
            assert.match(list.textContent, /until \[ -f done \]; do sleep 30; done/);
            assert.match(list.textContent, /output: \/tmp\/b1\.output/);
            assert.match(list.textContent, /npm test \[handle proc_2\]/);
            const buttons = [...el('prompt-bg').querySelectorAll('.bg-wait-btn')];
            assert.deepEqual(buttons.map((b: Win) => b.textContent), ['Wait without limit', 'Keep waiting up to 6 h', 'Stop waiting']);
            for (const b of buttons) { click(b); }
            assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
                { type: 'backgroundWaitAction', id: 'g1', action: 'waitWithoutLimit' },
                { type: 'backgroundWaitAction', id: 'g1', action: 'keepWaiting' },
                { type: 'backgroundWaitAction', id: 'g1', action: 'stopWaiting' },
            ]);
            assert.equal(el('prompt-unlimited').querySelector('[data-bg-action="waitWithoutLimit"]').disabled, true, 'no limit already');
            assert.equal(el('prompt-stale').querySelector('.bg-wait'), null, 'only a sending item waits');
            assert.equal(el('prompt-plain').querySelector('.bg-wait'), null);
            assert.match(media('shared', 'queueEntryStyles.css'), /\.bg-wait \{/);
        } finally {
            w.close();
        }
    });

    test('UW-6: an answer that ended with background work still running is red', () => {
        const w = queueEditor([
            { ...base, id: 'r1', status: 'sent', originalText: 'prompt-walk', repeatCount: 'ww*', answerText: 'B done',
                repetitionAnswers: [
                    { key: 'ww1_x', text: 'A ended early\n\n_(1 background task was still running …)_', at: '2026-11-12T18:00:00Z', backgroundLeft: true },
                    { key: 'ww2_x', text: 'B done', at: '2026-11-12T19:00:00Z' },
                ] },
            { ...base, id: 'r2', status: 'sent', originalText: 'prompt-single', answerText: 'Stopped waiting …', answerBackgroundLeft: true },
        ]);
        try {
            const el = (text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
            const chips = [...el('prompt-walk').querySelectorAll('.rep-answer-chip')];
            assert.deepEqual(chips.map((c: Win) => [c.textContent, c.classList.contains('bg-left')]), [['ww1_x', true], ['ww2_x', false]]);
            assert.match(chips[0].title, /ended with background work still running/);
            assert.equal(el('prompt-walk').querySelector('.answer-preview').classList.contains('bg-left'), false, 'the latest answer is not');
            w.eval("showRepetitionAnswer('r1', 'ww1_x')");
            const shown = el('prompt-walk').querySelector('.answer-preview');
            assert.ok(shown.classList.contains('bg-left'), 'the red repetition shown: red');
            assert.match(shown.textContent, /background work still running/);
            assert.ok(el('prompt-single').querySelector('.answer-preview').classList.contains('bg-left'));
            assert.match(media('shared', 'queueEntryStyles.css'), /\.rep-answer-chip\.bg-left \{/);
        } finally {
            w.close();
        }
    });

    test('UW-7: a continued iteration and needs attention', () => {
        const w = queueEditor([
            { ...base, id: 'k1', status: 'sending', originalText: 'prompt-continued', repeatCount: 'ww*', answerText: 'Finished green.',
                needsAttention: 'The todo ww2_x is still in-progress after 2 continuations; the walk stopped instead of going on.',
                repetitionAnswers: [
                    { key: 'ww1_x', text: 'Finished green.', at: '2026-11-12T18:00:00Z', continuations: 1, earlier: ['Started; waiting to get notified.'] },
                ] },
        ]);
        try {
            const el = [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes('prompt-continued'));
            const chip = el.querySelector('.rep-answer-chip');
            assert.equal(chip.querySelector('.rep-cont-mark').textContent, '1 continuation');
            assert.match(chip.title, /1 continuation: the todo was not completed after the turn/);
            const answer = el.querySelector('.answer-preview');
            assert.match(answer.textContent, /Finished green\./);
            const earlier = answer.querySelector('details.earlier-answers');
            assert.ok(earlier, 'the earlier answer folded');
            assert.equal(earlier.open, false);
            assert.match(earlier.querySelector('summary').textContent, /Earlier answer — ended before its work was done/);
            assert.match(earlier.textContent, /Started; waiting to get notified\./);
            const badge = el.querySelector('.needs-attention-badge');
            assert.match(badge.textContent, /needs attention/);
            assert.match(badge.title, /still in-progress after 2 continuations/);
        } finally {
            w.close();
        }
    });

    test('UW-4: Open question, Continue and Resend on a waiting item', () => {
        const posted: unknown[] = [];
        const w = queueEditor([
            { ...base, id: 'q1', status: 'sending', originalText: 'prompt-asks', waitingForUser: ['question'], pendingQuestionSince: 'since 20:31 (9 h 25 min)', lastDispatched: { kind: 'main', transport: 'anthropic', expandedText: 'x', dispatchedAt: new Date().toISOString() } },
            { ...base, id: 'q2', status: 'sending', originalText: 'prompt-fresh' },
        ], posted);
        try {
            posted.length = 0;
            const el = (text: string): Win => [...w.document.querySelectorAll('.queue-item')].find((e: Win) => e.textContent.includes(text));
            const asks = el('prompt-asks');
            assert.match(asks.querySelector('.waiting-user-badge').textContent, /waiting for your answer since 20:31 \(9 h 25 min\)/);
            // Inline handlers do not run in this DOM: run each button's onclick as the webview would.
            const click = (b: Win): void => { w.eval(String(b.getAttribute('onclick')).replace('event.stopPropagation();', '')); };
            click(asks.querySelector('.open-question-btn'));
            click(asks.querySelector('.codicon-play[title^="Continue"]'));
            click(asks.querySelector('.codicon-refresh[title^="Resend this stage"]'));
            assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
                { type: 'openPendingQuestion', id: 'q1' },
                { type: 'continueSending', id: 'q1' },
                { type: 'resendSendingStage', id: 'q1' },
            ]);
            const fresh = el('prompt-fresh');
            assert.equal(fresh.querySelector('.open-question-btn'), null, 'no question, no button');
            assert.equal(fresh.querySelector('.codicon-refresh[title^="Resend this stage"]'), null, 'nothing dispatched yet: no Resend');
            assert.match(media('shared', 'queueEntryStyles.css'), /\.open-question-btn \{/);
        } finally {
            w.close();
        }
    });
});

describe('queue: the answers of every repetition', () => {
    test('RP-1: the repetition key', () => {
        assert.equal(repetitionKeyOf({ repeatCount: 'chat*', repeatTodoId: 'chat7_x', repeatIndex: 7 }, count), 'chat7_x', 'a walk: the todo id');
        assert.equal(repetitionKeyOf({ repeatCount: 3, repeatIndex: 2 }, count), '2');
        assert.equal(repetitionKeyOf({ repeatCount: 1, templateRepeatCount: 4, templateRepeatIndex: 3 }, count), '3');
        assert.equal(repetitionKeyOf({ repeatCount: 1, repeatIndex: 1 }, count), undefined, 'not repeated');
        assert.equal(repetitionKeyOf({ repeatCount: 3, repeatIndex: 0 }, count), undefined, 'not sent yet');
    });

    test('RP-2: recording', () => {
        const item: Parameters<typeof recordRepetitionAnswer>[0] = { repeatCount: 3, repeatIndex: 1 };
        recordRepetitionAnswer(item, 'first', count, new Date('2026-11-09T10:00:00Z'));
        item.repeatIndex = 2;
        recordRepetitionAnswer(item, 'second', count);
        item.repeatIndex = 1;
        recordRepetitionAnswer(item, 'first again', count);
        recordRepetitionAnswer(item, '   ', count);
        assert.deepEqual(item.repetitionAnswers!.map((a) => [a.key, a.text]), [['1', 'first again'], ['2', 'second']], 'replaced in place');
        const once: Parameters<typeof recordRepetitionAnswer>[0] = { repeatCount: 1, repeatIndex: 1 };
        recordRepetitionAnswer(once, 'x', count);
        assert.equal(once.repetitionAnswers, undefined);
        assert.deepEqual(repetitionAnswersFromYaml([{ key: 2, text: 't', at: 'a' }, { nope: 1 }, 'x']), [{ key: '2', text: 't', at: 'a' }]);
        assert.equal(repetitionAnswersFromYaml(undefined), undefined);
    });

    test('RP-3: the chips', () => {
        const reps = [
            { key: 'chat7_x', text: 'answer of chat7', at: '2026-11-09T10:00:00Z' },
            { key: 'chat8_y', text: 'answer of chat8', at: '2026-11-09T11:00:00Z' },
        ];
        const w = queueEditor([{ ...base, id: 'r1', status: 'sending', originalText: 'prompt-walk', repeatCount: 'chat*', answerText: 'answer of chat8', repetitionAnswers: reps }]);
        try {
            const chips = (): Win[] => [...w.document.querySelectorAll('.rep-answer-chip')];
            assert.deepEqual(chips().map((c) => c.textContent), ['chat7_x', 'chat8_y']);
            assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, true], 'the latest is shown');
            chips()[0].click();
            assert.match(w.document.querySelector('.answer-preview').textContent, /answer of chat7/);
            assert.match(w.document.querySelector('.answer-preview strong').textContent, /Answer — chat7_x/);
            assert.deepEqual(chips().map((c) => c.classList.contains('active')), [true, false]);
            assert.equal(w.__queueAnswers.r1.text, 'answer of chat7', 'the Markdown buttons take it');
        } finally {
            w.close();
        }
    });
});
