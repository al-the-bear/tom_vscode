/**
 * "Back to the start of the previous phase" (vscimpb93) through the real process store, chat variables and queue:
 * the PROCESS view's button (a move of kind `back-phase`), the choice of the decision after a failed gate (Decide…,
 * tomAi_askInMdBrowser's `reopenDecision` choices — both take the option by its label), the state file and the
 * decisions journal. The window works on `default`; `r2` is another run.
 *
 *   BPQ-1 the decision after P2's gate offers "Gate failed — back to the start of P1"; taking it moves `default` to
 *         P1's first step with P1's iteration counted on (2), records P2's iteration, drops the run's open
 *         process-move marker and writes the decisions journal
 *   BPQ-2 the action-bar move in r2 (not the window's run): r2 goes back to P1 (iteration 2), `default` stays
 *   BPQ-3 counted on again: back in P1 at iteration 2, on to P2 and back once more gives iteration 3
 *   BPQ-4 the PROCESS view shows the move with its own icon
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb93_backphase-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/two/two.process.yaml', [
    'id: two', 'name: two', 'phases:',
    '  - id: p1', '    name: P1', '    repeatable: true', '    steps:',
    '      - id: start', '        name: Start', '        prompt: Start the work.',
    '      - id: work', '        name: Work', '        prompt: Work on it.',
    '    gate:', '      id: g1', '      name: G1',
    '  - id: p2', '    name: P2', '    steps:',
    '      - id: check', '        name: Check', '        prompt: Check it.',
    '    gate:', '      id: g2', '      name: G2', '',
].join('\n'));
put('_ai/processes/two/two.md', '# two\n');
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
import { confirmProcessAction, decisionOptionLabels, installProcessMoveMarkers, takeDecisionOption } from '../../services/processActionService.js';
import { ProcessRepository } from '../../utils/processRepository.js';

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
const journal = (): string => { const f = path.join(WS, '_ai', 'quests', QUEST, `decisions.${QUEST}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
const where = (run: string): string => { const s = stateOf(run); return `${s.phase}#${s.phaseIteration}/${s.step}#${s.stepIteration}${s.decision ? ' (decision)' : ''}`; };
/** Move `run` to the decision after P2's gate, the way the view does: P2, its gate, Skip to the decision. */
const toP2Gate = (run: string): void => {
    const r = store().withRun(run, () => {
        assert.equal(store().apply({ phase: 'p2' }, 'user').ok, true);
        return store().apply({ step: 'g2' }, 'user');
    });
    assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r));
};
const toDecision = (run: string): void => {
    const r = store().withRun(run, () => store().move('skip', undefined, 'user'));
    assert.equal((r as { ok: boolean }).ok, true, JSON.stringify(r));
};
const markers = (): number => queue().items.filter((i) => i.processMove && i.status !== 'sent').length;

describe('Back to the start of the previous phase', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        for (const r of ['default', 'r2']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'anthropic' }); }
        assert.equal(store().apply({ process: 'two' }, 'user').ok, true);
        assert.equal(store().createRun('r2', 'two', 'user', false).ok, true);
        assert.equal(store().currentRun, 'default');
    });

    test('BPQ-1: the choice after a failed gate', async () => {
        toP2Gate('default');
        // A Proceed at the gate leaves its prompt and an open process-move marker in the queue.
        const proceeded = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceeded.ok && proceeded.queued, true, JSON.stringify(proceeded));
        assert.equal(markers(), 1);
        toDecision('default');
        assert.equal(where('default'), 'p2#1/g2#1 (decision)');
        assert.deepEqual(stateOf('default').phaseIterations, { p1: 1 }, 'P1\'s iteration recorded when it was left');
        const labels = store().moves().filter((m) => m.branchOption).map((m) => m.label);
        assert.deepEqual(labels, ['Gate passed — finish the process', 'Gate failed — run G2 again', 'Gate failed — back to the start of P1']);
        assert.deepEqual(decisionOptionLabels(), labels, 'Decide… and the reopenDecision choices offer it');
        const taken = await takeDecisionOption('Gate failed — back to the start of P1');
        assert.equal(taken.ok, true, JSON.stringify(taken));
        assert.equal(where('default'), 'p1#2/start#1');
        assert.deepEqual(stateOf('default').phaseIterations, { p1: 1, p2: 1 });
        assert.equal(markers(), 0, 'the run\'s open marker went');
        assert.equal(queue().items.filter((i) => i.processRun && !i.processMove).length, 1, 'the step\'s prompt stays');
        assert.match(journal(), /## \S+ — Gate failed — back to the start of P1\n\n- \*\*From:\*\* two › .*G2.*\n- \*\*To:\*\* two › .*Start.* \(phase iteration 2\)\n/);
    });

    test('BPQ-2: the action-bar move in another run', async () => {
        assert.equal((store().withRun('r2', () => store().apply({ phase: 'p2' }, 'user')) as { ok: boolean }).ok, true);
        assert.equal(where('r2'), 'p2#1/check#1');
        const before = where('default');
        const moved = await confirmProcessAction('back-phase', undefined, '', undefined, undefined, 'r2');
        assert.equal(moved.ok, true, JSON.stringify(moved));
        assert.equal(where('r2'), 'p1#2/start#1');
        assert.equal(where('default'), before, 'the window\'s run did not move');
        assert.match(journal(), /— Back to the start of P1\n\n- \*\*From:\*\* two › .*Check.*\n- \*\*To:\*\* .*\(phase iteration 2\)\n- \*\*Run:\*\* r2\n/);
    });

    test('BPQ-3: counted on again', async () => {
        toP2Gate('default');
        toDecision('default');
        assert.deepEqual(stateOf('default').phaseIterations, { p1: 2, p2: 1 });
        assert.equal((await takeDecisionOption('Gate failed — back to the start of P1')).ok, true);
        assert.equal(where('default'), 'p1#3/start#1');
        assert.equal((await confirmProcessAction('back-phase', undefined, '')).ok, false, 'P1 is the first phase: no move');
    });

    test('BPQ-4: the PROCESS view shows the move with its own icon', () => {
        assert.match(fs.readFileSync(path.join(EXT_ROOT, 'media', 'processPanel', 'main.js'), 'utf8'), /'back-phase': 'arrow-circle-left'/);
    });
});
