/**
 * The "thinking" overlay of a Grill me / Explain in detail turn (vscimpb65): services/assistProgress.ts, the live
 * port in services/assistLiveDeps.ts, the assist's use of it (services/questionAssist.ts) and the overlay in both
 * webviews (media/shared/assistOverlay.js).
 *
 *   AP-1 a run: start → thinking (shown, with the question, the file, the time); a wait for the user hides it and
 *        the thinking time starts anew when the turn works again; end → nothing shows; a new start replaces it
 *   AP-2 failed: the error shows until dismissed (Cancel on a failed run) or for FAILED_SHOWN_MS; a cancelled run's
 *        failure shows nothing
 *   AP-3 Cancel: the cancel hook runs, the run is gone, wasCancelled says so afterwards; an unknown id does nothing
 *   AP-4 the live port: Cancel cancels the running chat send (the send slot's hook); the phase follows the turn's
 *        waits for the user, keyed by its chat item
 *   AP-5 the assist: the overlay begins with the turn and ends when the turn ends (before the closing panel); a
 *        failed send fails it with the error, a thrown one too; Cancel during the turn ends the run with nothing
 *        written (no closing panel), a "cancelled — left as it is" notice and the note on its queue entry; the chat
 *        item reaches the overlay through the send's hook
 *   AP-6 the overlay in a webview: thinking — the question, the file, the time counting up, Cancel posting
 *        assistCancel with the run's id; failed — the error and Dismiss; null hides it; both panels load it and their
 *        hosts send it (the MD Browser only to a panel on the run's document) and pass Cancel on
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { AssistProgress, FAILED_SHOWN_MS, assistProgress } from '../assistProgress.js';
import { liveAssistProgress } from '../assistLiveDeps.js';
import { beginUserWait, runAsQueueItem } from '../userWaits.js';
import { endAnthropicSend, tryBeginAnthropicSend } from '../../handlers/sendToChatState.js';
import { runQuestionAssist, type AssistProgressPort, type QuestionAssistDeps } from '../questionAssist.js';

const EXT = path.join(__dirname, '..', '..', '..');
const FIXTURE = fs.readFileSync(path.join(EXT, 'src', 'tools', '__tests__', 'fixtures', 'md_questions', 'review.md'), 'utf8');
const INFO = { label: 'Grill me', questionId: 'DP-19', filePath: '/ws/ideas/tsm.md', file: 'ideas/tsm.md' };

function clockedProgress() {
    let t = 1000;
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const p = new AssistProgress({
        now: () => t,
        setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
        clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    });
    const seen: unknown[] = [];
    p.onChange((v) => seen.push(v ? v.phase : null));
    return { p, timers, seen, tick: (ms: number) => { t += ms; } };
}

describe('the Grill me thinking overlay', () => {
    test('AP-1: a run', () => {
        const { p, seen, tick } = clockedProgress();
        const id = p.start(INFO);
        assert.deepEqual(p.shown(), { ...INFO, id, phase: 'thinking', startedAt: 1000, phaseSince: 1000 });
        p.setChatItem(id, 'chat-1');
        assert.equal(p.chatItemOf(id), 'chat-1');
        tick(5000);
        p.setWaiting(id, true);
        assert.equal(p.shown(), undefined, 'a question is open: hidden');
        assert.deepEqual(p.active(), { id, chatItemId: 'chat-1' });
        tick(30_000);
        p.setWaiting(id, false);
        assert.equal(p.shown()!.phaseSince, 36_000, 'thinking anew after the answer');
        assert.equal(p.shown()!.startedAt, 1000);
        p.setWaiting(id, false);
        p.end(id);
        assert.equal(p.shown(), undefined);
        assert.deepEqual(seen, ['thinking', null, 'thinking', null], 'no event for a phase that did not change');
        const first = p.start(INFO);
        const second = p.start({ ...INFO, questionId: 'DP-20' });
        assert.notEqual(first, second);
        p.end(first);
        assert.equal(p.shown()!.questionId, 'DP-20', 'ending an old run does not end the new one');
    });

    test('AP-2: failed', () => {
        const { p, timers } = clockedProgress();
        const id = p.start(INFO);
        p.fail(id, 'credit balance too low');
        assert.deepEqual([p.shown()!.phase, p.shown()!.error], ['failed', 'credit balance too low']);
        p.setWaiting(id, true);
        assert.equal(p.shown()!.phase, 'failed', 'a failed run is not hidden by a late wait');
        assert.equal(timers.at(-1)!.ms, FAILED_SHOWN_MS);
        timers.at(-1)!.fn();
        assert.equal(p.shown(), undefined, 'gone after FAILED_SHOWN_MS');
        const again = p.start(INFO);
        p.fail(again, 'boom');
        assert.equal(p.cancel(again), true, 'Dismiss');
        assert.equal(p.shown(), undefined);
        assert.equal(timers.at(-1)!.cleared, true, 'its timer cleared');
        assert.equal(p.wasCancelled(again), false, 'dismissing an error is no cancel');
        const cancelled = p.start(INFO);
        p.cancel(cancelled);
        p.fail(cancelled, 'aborted');
        assert.equal(p.shown(), undefined, 'a cancelled run shows no failure');
    });

    test('AP-3: Cancel', () => {
        const { p } = clockedProgress();
        let hook = 0;
        const id = p.start(INFO, () => { hook++; });
        assert.equal(p.cancel('nope'), false);
        assert.equal(p.cancel(id), true);
        assert.equal(hook, 1);
        assert.equal(p.shown(), undefined);
        assert.equal(p.wasCancelled(id), true, 'still known after it ended');
        assert.equal(p.cancel(id), false, 'once');
    });

    test('AP-4: the live port', async () => {
        let cancelled = 0;
        assert.equal(tryBeginAnthropicSend(() => { cancelled++; }), true);
        try {
            const handle = liveAssistProgress().begin(INFO);
            const run = assistProgress.active()!;
            assert.equal(assistProgress.shown()!.phase, 'thinking');
            handle.chatItem('chat-7');
            await runAsQueueItem('chat-7', async () => {
                const close = beginUserWait('question');
                assert.equal(assistProgress.shown(), undefined, 'the question is open: hidden');
                close();
            });
            assert.equal(assistProgress.shown()!.phase, 'thinking', 'answered: thinking again');
            const other = beginUserWait('question');
            assert.equal(assistProgress.shown()!.phase, 'thinking', 'another item\'s wait changes nothing');
            other();
            assert.equal(assistProgress.cancel(run.id), true);
            assert.equal(cancelled, 1, 'the chat send cancelled');
            assert.equal(handle.cancelled(), true);
            handle.end();
        } finally { endAnthropicSend(); }
        const h2 = liveAssistProgress().begin(INFO);
        h2.fail('boom');
        assert.equal(assistProgress.shown()!.error, 'boom');
        assistProgress.cancel(assistProgress.active()!.id);
    });

    test('AP-5: the assist', async () => {
        const events: string[] = [];
        const port = (cancelAfterSend = false): AssistProgressPort => ({
            begin: (info) => {
                events.push(`begin ${info.label} ${info.questionId} ${info.file}`);
                return {
                    chatItem: (id) => events.push(`chat ${id}`),
                    cancelled: () => cancelAfterSend,
                    fail: (e) => events.push(`fail ${e}`),
                    end: () => events.push('end'),
                };
            },
        });
        const asked: string[] = [];
        const notices: string[] = [];
        const notes: string[] = [];
        const deps = (over: Partial<QuestionAssistDeps>): QuestionAssistDeps => ({
            workspaceRoot: '/ws', readText: () => FIXTURE, assistPrompts: () => undefined, baseSession: () => 'default',
            sessionsFolder: () => '/ws/h', hasSession: () => true, createSession: () => ({ ok: true }), deleteSession: () => undefined,
            send: async (_p, _s, _src, hooks) => { hooks?.onChatItem?.('chat-9'); events.push('turn'); return { ok: true, chatItemId: 'chat-9' }; },
            askAnswer: async (input) => { events.push('closing panel'); asked.push(input.title); return ''; },
            writeAnswer: async () => '',
            notify: (n) => notices.push(n.message),
            noteChatItem: (_id, note) => notes.push(note),
            ...over,
        });
        await runQuestionAssist(deps({ progress: port() }), { use: 'grillMe', filePath: '/ws/specs/review.md', questionId: 'CC-2' });
        assert.deepEqual(events, ['begin Grill me CC-2 specs/review.md', 'chat chat-9', 'turn', 'end', 'closing panel'], 'the overlay ends with the turn, before the closing panel');
        events.length = 0;
        const failed = await runQuestionAssist(deps({ progress: port(), send: async () => ({ ok: false, error: 'credit balance too low' }) }), { use: 'grillMe', filePath: '/ws/specs/review.md', questionId: 'CC-2' });
        assert.equal(failed.ok, false);
        assert.deepEqual(events, ['begin Grill me CC-2 specs/review.md', 'fail credit balance too low']);
        events.length = 0;
        await assert.rejects(runQuestionAssist(deps({ progress: port(), send: async () => { throw new Error('crashed'); } }), { use: 'grillMe', filePath: '/ws/specs/review.md', questionId: 'CC-2' }), /crashed/);
        assert.deepEqual(events, ['begin Grill me CC-2 specs/review.md', 'fail crashed']);
        events.length = 0;
        notices.length = 0;
        const cancelled = await runQuestionAssist(deps({ progress: port(true) }), { use: 'grillMe', filePath: '/ws/specs/review.md', questionId: 'CC-2' });
        assert.equal(cancelled.ok && cancelled.cancelled, true);
        assert.deepEqual(events, ['begin Grill me CC-2 specs/review.md', 'chat chat-9', 'turn', 'end'], 'no closing panel after Cancel');
        assert.deepEqual(notices, ['Grill me: cancelled — CC-2 in specs/review.md is left as it is.']);
        assert.deepEqual(notes.at(-1), 'Grill me: cancelled — CC-2 in specs/review.md is left as it is.');
    });

    test('AP-6: the overlay in a webview', () => {
        const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = dom.window as any;
        const posted: Array<Record<string, unknown>> = [];
        w.__tomVscodeApi = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) };
        try {
            w.eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'assistOverlay.js'), 'utf8'));
            const send = (data: unknown): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
            const box = (): HTMLElement => w.document.getElementById('tomAssistOverlay')!;
            const now = Date.now();
            send({ type: 'assistOverlay', view: { ...INFO, id: 'assist-3', phase: 'thinking', startedAt: now - 125_000, phaseSince: now - 42_000 } });
            assert.equal(box().hidden, false);
            const text = box().textContent!.replace(/\s+/g, ' ');
            assert.match(text, /Grill me: the agent is thinking about the next step on DP-19/);
            assert.match(text, /Thinking for 0:4[234] · started 2:0[567] ago/);
            assert.match(text, /ideas\/tsm\.md/);
            const cancel = box().querySelector('button')!;
            assert.equal(cancel.textContent, 'Cancel');
            cancel.click();
            assert.deepEqual(posted, [{ type: 'assistCancel', id: 'assist-3' }]);
            assert.equal(box().hidden, true, 'gone at once');
            send({ type: 'assistOverlay', view: { ...INFO, id: 'assist-4', phase: 'failed', startedAt: now, phaseSince: now, error: 'credit balance too low' } });
            assert.match(box().textContent!, /Grill me on DP-19 failed/);
            assert.match(box().textContent!, /credit balance too low/);
            assert.equal(box().querySelector('button')!.textContent, 'Dismiss');
            send({ type: 'assistOverlay', view: null });
            assert.equal(box().hidden, true);
        } finally { w.close(); }
        const media = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'media', ...p), 'utf8');
        for (const panel of ['markdownBrowser', 'chatPanel']) {
            assert.match(media(panel, 'index.html'), /\{\{sharedUri\}\}\/assistOverlay\.js/, panel);
            assert.match(media(panel, 'index.html'), /\{\{sharedUri\}\}\/assistOverlay\.css/, panel);
        }
        const src = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'src', ...p), 'utf8');
        const md = src('handlers', 'markdownBrowser-handler.ts');
        assert.match(md, /const mine = view && current && path\.resolve\(view\.filePath\) === path\.resolve\(current\) \? view : null;/, 'only a panel on the run\'s document');
        assert.match(md, /case 'assistCancel':\s*\/\/[^\n]*\n\s*assistProgress\.cancel\(String\(msg\.id \|\| ''\)\);/);
        assert.match(md, /progress: liveAssistProgress\(\),/);
        const chat = src('handlers', 'chatPanel-handler.ts');
        assert.match(chat, /postMessage\(\{ type: 'assistOverlay', view: assistProgress\.shown\(\) \?\? null \}\)/);
        assert.match(chat, /case 'assistCancel':\s*\/\/[^\n]*\n\s*assistProgress\.cancel\(String\(message\.id \|\| ''\)\);/);
        assert.match(src('handlers', 'sendToChatRouter.ts'), /onChatItem: \(itemId\) => \{ chatItemId = itemId; opts\?\.onChatItem\?\.\(itemId\); \}/);
    });
});
