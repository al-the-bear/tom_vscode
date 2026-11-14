/**
 * Finish review round in a process run other than the window's (vscimpb89), through the real process store, the
 * queue and tomAi_askInMdBrowser. The window works on `default`; the review's run is `r2`.
 *
 *   FRO-1 step → user step: while r2's step `draft` runs, its closing item's ask (as r2) gets Finish review round,
 *         though the window's run is at no review; the click completes `draft`, confirms the review `review` and
 *         queues r2's next step (`iteration › revise`) — r2 moves, `default` does not, the window stays on `default`
 *   FRO-2 sub-step → user sub-step: while r2's sub-step `revise` runs, the button is offered (its next position is
 *         the user sub-step `check`); the click completes it, confirms `check` and arrives at the decision after the
 *         repeatable step `iteration`
 *   FRO-3 the window's own run works as before: the same in `default`; an ask from a run at no review is refused
 *         with the reason; an unknown run is named
 *   FRO-4 the decision's choices and the gate decision in r2 (vscimpb104): r2's decision offers its choices while the
 *         window's run is elsewhere, taking one moves r2 only; at r2's running gate the gate decision offers gate
 *         passed / failed, and its click ends the gate's step and finishes r2's process
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb89_fro-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/rev/rev.process.yaml', [
    'id: rev', 'name: rev', 'phases:', '  - id: p1', '    steps:',
    '      - id: draft', '        name: Draft', '        prompt: Write the draft.',
    '      - id: review', '        name: Review', '        userAction: true',
    '      - id: iteration', '        name: Iteration', '        repeatable: true', '        substeps:',
    '          - id: revise', '            name: Revise', '            prompt: Revise the draft.',
    '          - id: check', '            name: Check', '            userAction: true',
    '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/rev/rev.md', '# rev\n');
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import {
    confirmProcessAction, decisionOptionLabels, finishReviewUnavailableNow, gateDecisionOptionLabels, gateDecisionUnavailableNow,
    installProcessMoveMarkers, runFinishReviewRound, runGateDecision, takeDecisionOption,
} from '../../services/processActionService.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { runAsQueueItem } from '../../services/userWaits.js';
import { MdBrowserAskSlot, askInMdBrowserImpl, type AskInMdBrowserDeps, type AskMdBar } from '../ask-in-md-browser-tool.js';

const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
    installProcessMoveMarkers();
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const stateOf = (run: string) => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, run);
const tick = () => new Promise((r) => setTimeout(r, 30));

/** The MD Browser side of the ask, with the live Finish review round of processActionService. */
function askDeps(): { deps: AskInMdBrowserDeps; bars: AskMdBar[] } {
    put('review.md', '# Results\n');
    const bars: AskMdBar[] = [];
    return {
        bars,
        deps: {
            workspaceRoot: WS,
            exists: (p) => fs.existsSync(p),
            openWithBar: (_abs, bar) => { bars.push(bar); return 'p1'; },
            clearBar: () => undefined,
            closePanel: () => undefined,
            deleteFile: () => undefined,
            genId: () => `req${bars.length + 1}`,
            finishReview: { unavailable: (run) => finishReviewUnavailableNow(run), run: (run) => runFinishReviewRound(undefined, run) },
        },
    };
}

/** An ask with Finish review round from a closing item of run `run`; clicks it and answers the parsed answer. */
async function askAndFinish(run: string): Promise<Record<string, unknown>> {
    const { deps, bars } = askDeps();
    const slot = new MdBrowserAskSlot();
    const call = runAsQueueItem(`closing-${run}`, () => askInMdBrowserImpl(deps, { filePath: 'review.md', finishReviewRound: true }, slot), run);
    await tick();
    const opened = bars.at(-1);
    if (!opened) { return JSON.parse(await call) as Record<string, unknown>; }
    assert.deepEqual(opened.buttons.map((b) => b.id), ['finish'], `${run}: the Finish review round button`);
    assert.equal(slot.click(opened.requestId, 'finish', true), true);
    return JSON.parse(await call) as Record<string, unknown>;
}

describe('Finish review round in another process run', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        for (const r of ['default', 'r2']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'anthropic' }); }
        assert.equal(store().createRun('r2', 'rev', 'user', false).ok, true);
        assert.equal(store().currentRun, 'default', 'the window stays on default');
    });

    test('FRO-1: step → user step, in r2', async () => {
        assert.deepEqual((await confirmProcessAction('proceed', undefined, '', undefined, undefined, 'r2')), { ok: true, queued: true, label: 'Proceed' });
        assert.equal(store().currentRun, 'default');
        assert.equal(queue().items.filter((i) => i.processRun?.run === 'r2').length, 2, 'r2\'s prompt and marker');
        assert.equal(finishReviewUnavailableNow('r2'), undefined, 'r2\'s running step leads to a review');
        assert.match(finishReviewUnavailableNow() ?? '', /no process set|not at a review/, 'the window\'s run is at none');
        const answer = await askAndFinish('r2');
        const review = answer.review as Record<string, unknown>;
        assert.equal(review.ok, true, JSON.stringify(answer));
        assert.equal(review.next, 'queued');
        const r2 = stateOf('r2');
        assert.deepEqual([r2.step, r2.substep], ['iteration', 'revise'], 'r2 at its next step, its prompt queued');
        assert.ok(queue().items.some((i) => i.processRun?.run === 'r2' && i.processRun.state.substep === 'revise' && !i.processMove), 'revise queued in r2');
        assert.equal(stateOf('default').process, '', 'default did not move');
        assert.equal(store().currentRun, 'default', 'the window still on default');
    });

    test('FRO-2: sub-step → user sub-step, in r2', async () => {
        assert.equal(finishReviewUnavailableNow('r2'), undefined, 'r2\'s running sub-step leads to the user sub-step check');
        const answer = await askAndFinish('r2');
        const review = answer.review as Record<string, unknown>;
        assert.equal(review.ok, true, JSON.stringify(answer));
        assert.equal(review.next, 'decision', 'after check the repeatable step ends at its decision');
        const r2 = stateOf('r2');
        assert.deepEqual([r2.step, r2.substep, r2.decision], ['iteration', 'check', true]);
        assert.equal(store().currentRun, 'default');
    });

    test('FRO-3: the window\'s run, a run at no review, an unknown run', async () => {
        assert.equal(store().apply({ process: 'rev' }, 'user').ok, true);
        assert.equal(stateOf('default').step, 'draft');
        assert.match(finishReviewUnavailableNow() ?? '', /not at a review/, 'default: draft not running yet');
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        assert.equal(finishReviewUnavailableNow(), undefined, 'default: its running step leads to a review');
        const answer = await askAndFinish('default');
        assert.equal((answer.review as Record<string, unknown>).ok, true, JSON.stringify(answer));
        assert.deepEqual([stateOf('default').step, stateOf('default').substep], ['iteration', 'revise']);
        // r2 is at its decision: no review, no running step.
        const refused = await askAndFinish('r2');
        assert.match(String(refused.error), /Finish review round cannot be offered: the process is not at a review/);
        assert.match(finishReviewUnavailableNow('nope') ?? '', /no process set|no run/);
    });

    test('FRO-4: the decision\'s choices and the gate decision in r2', async () => {
        assert.deepEqual(decisionOptionLabels(), [], 'default is at no decision');
        const labels = decisionOptionLabels('r2');
        assert.ok(labels.some((l) => /^Go on to/.test(l)) && labels.some((l) => /^Repeat the step/.test(l)), labels.join(' | '));
        const goOn = labels.find((l) => /^Go on to/.test(l))!;
        assert.equal((await takeDecisionOption(goOn, 'r2')).ok, true);
        assert.equal(stateOf('r2').step, 'g1', 'r2 at its gate');
        assert.deepEqual([stateOf('default').step, stateOf('default').substep], ['iteration', 'revise'], 'default unmoved');
        assert.match(gateDecisionUnavailableNow('r2') ?? '', /not running/, 'the gate\'s step not started yet');
        assert.equal((await confirmProcessAction('proceed', undefined, '', undefined, undefined, 'r2')).ok, true);
        assert.equal(gateDecisionUnavailableNow('r2'), undefined);
        assert.match(gateDecisionUnavailableNow() ?? '', /not at a gate/, 'default is not at a gate');
        const gate = gateDecisionOptionLabels('r2');
        assert.deepEqual(gate, ['Gate passed — finish the process', 'Gate failed — run g1 again']);
        const outcome = await runGateDecision(gate[0], 'r2');
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(stateOf('r2').completed, true, 'r2 finished');
        assert.equal(stateOf('default').completed ?? false, false);
        assert.equal(store().currentRun, 'default');
    });
});
