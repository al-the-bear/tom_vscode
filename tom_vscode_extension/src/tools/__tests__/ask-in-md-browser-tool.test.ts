/**
 * `tomAi_askInMdBrowser` (ccparity_i_assist-1): an agent asks through a
 * document in the MD Browser — buttons and a *Keep this file* checkbox in the
 * top area, blocking until a button is clicked.
 *
 *   AM-1 blocking: the call does not answer until a click; the click answers `{button, label, keepFile}`, the bar
 *        is replaced by a note and the file stays
 *   AM-2 keepFile: unchecked (from the start or by the checkbox) the file is deleted and its panel closed when
 *        the flow goes on — on a click, on a timeout, when the panel is closed
 *   AM-3 timeout: none by default; `timeoutMinutes` (capped by the user's ceiling) answers `timedOut: true`
 *   AM-4 one per process run (vscimpb81): a second ask of the same run while one is open is refused, and the first
 *        still answers; an ask of another run opens beside it and each answer reaches its asker; a stale request
 *        id or an unknown button is ignored; the panel closed answers `closed: true`; cancel answers `cancelled`
 *   AM-5 input: a .md file in the workspace that exists, 1–8 buttons with unique non-empty ids and labels;
 *        a panel that does not open frees the slot
 *   AM-6 journal, registration and the documentation row
 *   AM-7 Finish review round (i-5): `finishReviewRound` adds the button (id `finish`) when the process is at a review,
 *        refused otherwise; its click closes only that panel and answers what the review's move did
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import { withTiming } from './_timing.js';
import {
    ASK_IN_MD_BROWSER_TOOL, MdBrowserAskSlot, askInMdBrowserImpl,
    type AskInMdBrowserDeps, type AskMdBar,
} from '../ask-in-md-browser-tool.js';
import type { QuestionLogEntry } from '../../utils/questionsLogFormat.js';
import { runAsQueueItem } from '../../services/userWaits.js';

const ROOT = '/ws';

function fake(over: Partial<AskInMdBrowserDeps> = {}) {
    const files = new Set(['/ws/notes/ask.md']);
    const bars: Array<{ panelId: string; bar: AskMdBar }> = [];
    const cleared: Array<{ panelId: string; requestId: string; note: string }> = [];
    const closed: string[] = [];
    const deleted: string[] = [];
    const logs: QuestionLogEntry[] = [];
    const timers: Array<{ ms: number; cb: () => void; cleared: boolean }> = [];
    const deps: AskInMdBrowserDeps = {
        workspaceRoot: ROOT,
        exists: (p) => files.has(p),
        openWithBar: (abs, bar) => { bars.push({ panelId: 'p1', bar }); return 'p1'; },
        clearBar: (panelId, requestId, note) => { cleared.push({ panelId, requestId, note }); },
        closePanel: (panelId) => { closed.push(panelId); },
        deleteFile: (abs) => { files.delete(abs); deleted.push(abs); },
        log: (e) => logs.push(e),
        now: () => 1000,
        genId: () => `req${bars.length + 1}`,
        setTimer: (ms, cb) => { const t = { ms, cb, cleared: false }; timers.push(t); return t as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: (h) => { (h as unknown as { cleared: boolean }).cleared = true; },
        ...over,
    };
    return { deps, files, bars, cleared, closed, deleted, logs, timers };
}

const BUTTONS = [{ id: 'continue', label: 'Continue' }, { id: 'cancel', label: 'Cancel' }];
const tick = () => new Promise((r) => setImmediate(r));

describe('tomAi_askInMdBrowser', () => {
    test('AM-1: blocks until a click', async () => {
        const f = fake();
        const slot = new MdBrowserAskSlot();
        let answered = false;
        const call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, title: 'Go on?' }, slot)
            .then((s) => { answered = true; return s; });
        await tick();
        assert.equal(answered, false, 'still waiting');
        assert.deepEqual(f.bars[0].bar, { requestId: 'req1', title: 'Go on?', buttons: BUTTONS, keepFile: true, timeoutAt: undefined });
        assert.equal(f.timers.length, 0, 'no deadline by default');
        assert.equal(slot.click('req1', 'continue', true), true);
        const out = JSON.parse(await call);
        assert.deepEqual(out, { button: 'continue', keepFile: true, label: 'Continue', fileDeleted: false, file: 'notes/ask.md', panelId: 'p1' });
        assert.deepEqual(f.cleared, [{ panelId: 'p1', requestId: 'req1', note: 'Answered: Continue' }]);
        assert.deepEqual(f.deleted, []);
        assert.equal(slot.hasOpen(), false);
    });

    test('AM-2: an unchecked file is deleted when the flow goes on', async () => {
        // Unchecked from the start, then a click.
        let f = fake();
        let slot = new MdBrowserAskSlot();
        let call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, keepFile: false }, slot);
        await tick();
        assert.equal(f.bars[0].bar.keepFile, false);
        slot.click('req1', 'cancel', false);
        let out = JSON.parse(await call);
        assert.equal(out.button, 'cancel');
        assert.equal(out.keepFile, false);
        assert.equal(out.fileDeleted, true);
        assert.deepEqual(f.deleted, ['/ws/notes/ask.md']);
        assert.deepEqual(f.closed, ['p1'], 'its panel closes with it');
        // Unchecked by the checkbox, then the timeout.
        f = fake();
        slot = new MdBrowserAskSlot();
        call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, timeoutMinutes: 1 }, slot);
        await tick();
        assert.equal(slot.setKeepFile('req1', false), true);
        f.timers[0].cb();
        out = JSON.parse(await call);
        assert.equal(out.timedOut, true);
        assert.equal(out.fileDeleted, true);
        // Unchecked, then the panel closed: the file goes, the panel is already gone.
        f = fake();
        slot = new MdBrowserAskSlot();
        call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, keepFile: false }, slot);
        await tick();
        slot.panelClosed('p1');
        out = JSON.parse(await call);
        assert.equal(out.closed, true);
        assert.equal(out.fileDeleted, true);
        assert.deepEqual(f.closed, []);
        // Checked again before the click: kept.
        f = fake();
        slot = new MdBrowserAskSlot();
        call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, keepFile: false }, slot);
        await tick();
        slot.click('req1', 'continue', true);
        out = JSON.parse(await call);
        assert.equal(out.keepFile, true);
        assert.deepEqual(f.deleted, []);
    });

    test('AM-3: timeout', async () => {
        const f = fake({ ceilingMinutes: () => 2 });
        const slot = new MdBrowserAskSlot();
        const call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, timeoutMinutes: 5 }, slot);
        await tick();
        assert.equal(f.timers[0].ms, 2 * 60_000, 'the ceiling caps the request');
        assert.equal(f.bars[0].bar.timeoutAt, 1000 + 2 * 60_000);
        f.timers[0].cb();
        const out = JSON.parse(await call);
        assert.equal(out.button, null);
        assert.equal(out.timedOut, true);
        assert.equal(out.fileDeleted, false);
        assert.match(f.cleared[0].note, /Timed out/);
        // A click after the timeout changes nothing.
        assert.equal(slot.click('req1', 'continue', true), false);
        // A click before it clears the timer.
        const g = fake();
        const call2 = askInMdBrowserImpl(g.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, timeoutMinutes: 1 }, slot);
        await tick();
        slot.click('req1', 'continue', true);
        await call2;
        assert.equal(g.timers[0].cleared, true);
    });

    test('AM-4: one ask per process run', async () => {
        const f = fake();
        const slot = new MdBrowserAskSlot();
        const first = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot);
        await tick();
        const second = JSON.parse(await withTiming('tomAi_askInMdBrowser:refused-while-open', () =>
            askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot)));
        assert.match(second.error, /of run "default" is already open — one per process run/);
        assert.equal(f.bars.length, 1, 'no second bar');
        // Another run asks at the same time: its bar opens beside the first.
        const otherRun = runAsQueueItem('item-r2', () => askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot), 'r2');
        await tick();
        assert.equal(f.bars.length, 2, 'the other run\'s bar opens');
        assert.equal(slot.hasOpen('default'), true);
        assert.equal(slot.hasOpen('r2'), true);
        assert.equal(slot.click(f.bars[1].bar.requestId, 'continue', true), true, 'answered in any order: the second first');
        assert.equal(JSON.parse(await otherRun).button, 'continue');
        assert.equal(slot.hasOpen('r2'), false);
        assert.equal(slot.click('stale', 'continue', true), false, 'a stale request id');
        assert.equal(slot.click('req1', 'nope', true), false, 'an unknown button');
        assert.equal(slot.setKeepFile('stale', false), false);
        slot.panelClosed('other-panel');
        assert.equal(slot.hasOpen(), true, 'another panel closing changes nothing');
        assert.equal(slot.click('req1', 'cancel', true), true);
        assert.equal(JSON.parse(await first).button, 'cancel');
        // Closed and cancelled.
        const closedCall = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot);
        await tick();
        slot.panelClosed('p1');
        assert.deepEqual(JSON.parse(await closedCall), { button: null, keepFile: true, closed: true, fileDeleted: false, file: 'notes/ask.md', panelId: 'p1' });
        const cancelled = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot);
        await tick();
        slot.cancel();
        assert.equal(JSON.parse(await cancelled).cancelled, true);
    });

    test('AM-5: input', async () => {
        const f = fake();
        const slot = new MdBrowserAskSlot();
        const ask = async (input: Record<string, unknown>) => JSON.parse(await askInMdBrowserImpl(f.deps, input as never, slot)).error as string;
        assert.match(await ask({ buttons: BUTTONS }), /`filePath` is required/);
        assert.match(await ask({ filePath: 'notes/ask.txt', buttons: BUTTONS }), /\.md files only/);
        assert.match(await ask({ filePath: '/elsewhere/x.md', buttons: BUTTONS }), /outside the workspace/);
        assert.match(await ask({ filePath: 'notes/none.md', buttons: BUTTONS }), /File not found/);
        assert.match(await ask({ filePath: 'notes/ask.md', buttons: [] }), /at least one/);
        assert.match(await ask({ filePath: 'notes/ask.md', buttons: Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, label: 'B' })) }), /maximum is 8/);
        assert.match(await ask({ filePath: 'notes/ask.md', buttons: [{ id: 'a', label: '' }] }), /non-empty/);
        assert.match(await ask({ filePath: 'notes/ask.md', buttons: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /unique/);
        assert.equal(f.bars.length, 0);
        // A panel that does not open: an error, and the slot is free again.
        const g = fake({ openWithBar: () => undefined });
        assert.match(JSON.parse(await askInMdBrowserImpl(g.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot)).error, /Could not open/);
        assert.equal(slot.hasOpen(), false);
        const h = fake({ openWithBar: () => { throw new Error('boom'); } });
        assert.match(JSON.parse(await askInMdBrowserImpl(h.deps, { filePath: 'notes/ask.md', buttons: BUTTONS }, slot)).error, /boom/);
        assert.equal(slot.hasOpen(), false);
    });

    test('AM-6: journal, registration, documentation', async () => {
        const f = fake();
        const slot = new MdBrowserAskSlot();
        const call = withTiming('tomAi_askInMdBrowser:typical', async () => {
            const p = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', buttons: BUTTONS, title: 'Review', keepFile: false }, slot);
            await tick();
            slot.click('req1', 'continue', false);
            return p;
        });
        await call;
        assert.equal(f.logs.length, 1);
        assert.equal(f.logs[0].tool, 'tomAi_askInMdBrowser');
        assert.equal(f.logs[0].title, 'Review');
        assert.deepEqual(f.logs[0].questions, ['notes/ask.md — Continue / Cancel']);
        assert.equal(f.logs[0].answer, 'Continue (file not kept)');
        assert.equal(f.logs[0].source, 'vscode');

        assert.equal(ASK_IN_MD_BROWSER_TOOL.requiresApproval, false, 'asking needs no approval, like tomAi_askUser');
        assert.deepEqual(ASK_IN_MD_BROWSER_TOOL.inputSchema.required, ['filePath'], '`buttons` may be left out with `finishReviewRound`');
        const ext = path.join(__dirname, '..', '..', '..');
        const src = (rel: string) => readFileSync(path.join(ext, 'src', rel), 'utf-8');
        assert.match(src('tools/tool-executors.ts'), /askInMdBrowserImpl\(mdBrowserAskDeps, input\)/);
        assert.match(src('tools/tool-executors.ts'), /\n {4}ASK_IN_MD_BROWSER_TOOL,/);
        for (const file of ['utils/toolCategories.ts', 'utils/constants.ts']) {
            assert.match(src(file), /'tomAi_askInMdBrowser'/, file);
        }
        assert.match(readFileSync(path.join(ext, 'doc', 'llm_tools.md'), 'utf-8'), /^\| `tomAi_askInMdBrowser` \|/m, 'the llm_tools.md row');
    });

    test('AM-7: Finish review round', async () => {
        const outcome = { ok: true as const, confirmed: 'Confirm done', next: 'queued' as const, where: 'p1 › refine' };
        let runs = 0;
        const review = (unavailable?: string) => ({ unavailable: () => unavailable, run: async () => { runs++; return outcome; } });
        const slot = new MdBrowserAskSlot();
        // Refused: not available here, not at a review, a clashing id.
        assert.match(JSON.parse(await askInMdBrowserImpl(fake().deps, { filePath: 'notes/ask.md', finishReviewRound: true }, slot)).error, /not available here/);
        assert.match(JSON.parse(await askInMdBrowserImpl(fake({ finishReview: review('the process is not at a review') }).deps, { filePath: 'notes/ask.md', finishReviewRound: true }, slot)).error,
            /Finish review round cannot be offered: the process is not at a review\. Open the document with tomAi_openInMdBrowser instead\./);
        assert.match(JSON.parse(await askInMdBrowserImpl(fake({ finishReview: review() }).deps, { filePath: 'notes/ask.md', finishReviewRound: true, buttons: [{ id: 'finish', label: 'Mine' }] }, slot)).error, /button id `finish`/);
        assert.match(JSON.parse(await askInMdBrowserImpl(fake().deps, { filePath: 'notes/ask.md' }, slot)).error, /or set `finishReviewRound`/);
        assert.equal(slot.hasOpen(), false);
        // Offered: the button is added (no other needed); the click closes that panel, runs the review, answers.
        const f = fake({ finishReview: review() });
        const call = askInMdBrowserImpl(f.deps, { filePath: 'notes/ask.md', finishReviewRound: true, keepFile: false }, slot);
        await tick();
        assert.deepEqual(f.bars[0].bar.buttons, [{ id: 'finish', label: 'Finish review round' }]);
        assert.equal(slot.click('req1', 'finish', false), true);
        assert.equal(slot.click('req1', 'finish', false), false, 'once');
        const answer = JSON.parse(await call);
        assert.equal(runs, 1, 'the review is confirmed and the process moved on');
        assert.deepEqual(f.closed, ['p1'], 'only the panel clicked closes');
        assert.deepEqual(f.cleared, [], 'no bar to clear: the panel is gone');
        assert.deepEqual(f.deleted, ['/ws/notes/ask.md'], 'an unchecked file goes with it');
        assert.deepEqual([answer.button, answer.panelClosed, answer.fileDeleted], ['finish', true, true]);
        assert.deepEqual(answer.review, outcome);
        assert.equal(answer.summary, 'The review is confirmed; the process is at p1 › refine and its prompt is queued.');
        assert.equal(slot.hasOpen(), false);
        // Another button of the same ask answers as always and runs nothing.
        const g = fake({ finishReview: review() });
        const other = askInMdBrowserImpl(g.deps, { filePath: 'notes/ask.md', finishReviewRound: true, buttons: [{ id: 'later', label: 'Later' }] }, slot);
        await tick();
        assert.deepEqual(g.bars[0].bar.buttons.map((b) => b.id), ['later', 'finish']);
        slot.click('req1', 'later', true);
        assert.equal(JSON.parse(await other).button, 'later');
        assert.equal(runs, 1);
        assert.deepEqual(g.closed, [], 'the panel stays');
        // A failing review run is reported, not thrown.
        const h = fake({ finishReview: { unavailable: () => undefined, run: async () => { throw new Error('store gone'); } } });
        const failing = askInMdBrowserImpl(h.deps, { filePath: 'notes/ask.md', finishReviewRound: true }, slot);
        await tick();
        slot.click('req1', 'finish', true);
        const failed = JSON.parse(await failing);
        assert.deepEqual(failed.review, { ok: false, error: 'store gone' });
        assert.equal(failed.summary, 'Finish review round failed: store gone');
    });
});

