/**
 * Queue per run (vscimpb46, src/utils/queueLanes.ts) through the real queue manager and process store under
 * the vscode stub. The dispatch of an item is replaced by a gate the test opens, so it can see what sends
 * at the same time; everything else — picking, the lanes, completion, the markers — is the manager's own.
 *
 *   QM-1 off (the default): one item sends at a time, whatever its run; the next one starts when it is done;
 *        the settings file has no lane keys
 *   QM-2 on: each run's lane sends one item, the lanes in parallel; a run's second item waits for its first and
 *        starts when it is done while the other lane still sends; the setting is in the settings file, and read
 *        back by a new manager
 *   QM-3 two runs of different processes move independently: each Proceed's marker moves its own run's state
 *        file when its own step's item is done, while the other run's item still sends
 *   QM-4 Pause per run: a held run starts nothing while the others go; its sending item stops before its next
 *        prompt (the pause gate); Resume starts it; the held runs are kept in the settings file
 *   QM-5 the editor and the tool: the state carries queuePerRun, heldRuns and the lanes; the page has the
 *        checkbox and the lane strip with Pause / Resume (its messages reach the manager); tomAi_listQueue
 *        reports queuePerRun and heldRuns
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb46_lanes-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
// Two processes, each naming its own session, so their runs' prompts run in different conversations.
for (const [id, session] of [['design', 'work'], ['review', 'check']]) {
    put(`_ai/processes/${id}/${id}.process.yaml`, [
        `id: ${id}`, `name: ${id}`, `session: ${session}`, 'phases:', '  - id: p1', '    steps:',
        '      - id: plan', '        name: Plan', '      - id: build', '        name: Build',
        '    gate:', '      id: g1', '',
    ].join('\n'));
    put(`_ai/processes/${id}/${id}.md`, `# ${id}\n`);
}
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
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { confirmProcessAction, installProcessMoveMarkers } from '../../services/processActionService.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { DEFAULT_RUN } from '../../utils/processRuns.js';
import { readQueueSettings } from '../../storage/queueFileStorage.js';
import { listQueueImpl, type PromptQueueAccess } from '../prompt-queue-tools.js';

let context: never;
const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    context = {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stepIn = (run: string): string => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, run).step;
const statusOf = (item: QueuedPrompt): string | undefined => queue().getById(item.id)?.status;

/** The items whose dispatch runs now, and the gate that finishes one. */
const inFlight = new Map<string, () => void>();
function gateDispatch(): void {
    (queue() as Json).dispatchNextStageForSendingItem = (item: QueuedPrompt) => new Promise<'done'>((resolve) => {
        inFlight.set(item.id, () => { inFlight.delete(item.id); resolve('done'); });
    });
}
async function finish(item: QueuedPrompt): Promise<void> {
    const open = inFlight.get(item.id);
    assert.ok(open, `${item.id} is in flight`);
    open();
    await wait(60);
}
function clean(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    inFlight.clear();
    store().selectRun(DEFAULT_RUN);
    for (const r of store().runs()) { if (r.run !== DEFAULT_RUN) { store().deleteRuns([r.run]); } }
    for (const r of [...queue().heldRuns]) { queue().setRunHeld(r, false); }
}
const add = (text: string, run: string, session: string): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: text, run, session, transport: 'anthropic', deferSend: true, initialStatus: 'pending' } as never);

describe('Queue per run', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        gateDispatch();
        assert.equal(queue().queuePerRun, false, 'off by default');
    });

    test('QM-1: off — one item at a time', async () => {
        clean();
        const a = await add('a', 'r1', 'sa');
        const b = await add('b', 'r2', 'sb');
        queue().autoSendEnabled = true;
        await wait(60);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sending', 'pending'], 'b waits although its run differs');
        await finish(a);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sent', 'sending']);
        await finish(b);
        const settings = readQueueSettings() as Json;
        assert.equal('queue-per-run' in settings, false, 'an untouched queue writes no lane keys');
        assert.equal('held-runs' in settings, false);
        clean();
    });

    test('QM-2: on — the lanes send in parallel', async () => {
        clean();
        queue().queuePerRun = true;
        const a1 = await add('a1', 'r1', 'sa');
        const b1 = await add('b1', 'r2', 'sb');
        const a2 = await add('a2', 'r1', 'sa2');
        queue().autoSendEnabled = true;
        await wait(60);
        assert.deepEqual([statusOf(a1), statusOf(b1), statusOf(a2)], ['sending', 'sending', 'pending'], 'one per lane, in parallel');
        assert.deepEqual([...inFlight.keys()].sort(), [a1.id, b1.id].sort());
        await finish(a1);
        assert.deepEqual([statusOf(a1), statusOf(b1), statusOf(a2)], ['sent', 'sending', 'sending'], 'r1 goes on while r2 still sends');
        await finish(b1);
        await finish(a2);
        assert.equal((readQueueSettings() as Json)['queue-per-run'], true);
        // A new window reads it back from the settings file.
        (queue() as Json)._queuePerRun = false;
        (queue() as Json).restoreSettings();
        assert.equal(queue().queuePerRun, true, 'read back');
        clean();
    });

    test('QM-3: two runs of different processes move independently', async () => {
        clean();
        assert.equal(store().createRun('ra', 'design', 'user', true).ok, true);
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        assert.equal(store().createRun('rb', 'review', 'user', true).ok, true);
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        const prompts = queue().items.filter((i) => !i.processMove);
        const pa = prompts.find((i) => i.processRun?.run === 'ra')!;
        const pb = prompts.find((i) => i.processRun?.run === 'rb')!;
        assert.deepEqual([pa.session, pb.session], ['work@ra', 'check@rb'], 'each run in its own session');
        queue().autoSendEnabled = true;
        await wait(60);
        assert.deepEqual([statusOf(pa), statusOf(pb)], ['sending', 'sending'], 'both runs\' steps send at once');
        await finish(pb);
        assert.equal(stepIn('rb'), 'build', 'rb moved when its own step was done');
        assert.equal(stepIn('ra'), 'plan', 'ra did not: its step still sends');
        assert.equal(statusOf(pa), 'sending');
        await finish(pa);
        assert.equal(stepIn('ra'), 'build');
        assert.ok(fs.existsSync(path.join(WS, '_ai', 'quests', QUEST, `process-state.${QUEST}.ra.yaml`)), 'each run its own state file');
        assert.ok(fs.existsSync(path.join(WS, '_ai', 'quests', QUEST, `process-state.${QUEST}.rb.yaml`)));
        clean();
    });

    test('QM-4: Pause per run', async () => {
        clean();
        queue().setRunHeld('r2', true);
        assert.deepEqual((readQueueSettings() as Json)['held-runs'], ['r2']);
        const a = await add('a', 'r1', 'sa');
        const b = await add('b', 'r2', 'sb');
        queue().autoSendEnabled = true;
        await wait(60);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sending', 'pending'], 'the held run waits, the other goes');
        // The pause gate: a sending item of a held run stops before its next prompt; another run's does not.
        const gate = (item: QueuedPrompt): boolean => (queue() as Json)._pauseBeforeNextDispatch(queue().getById(item.id));
        const held = { ...queue().getById(b.id)!, status: 'sending', repeatIndex: 1 } as QueuedPrompt;
        assert.equal((queue() as Json)._pauseBeforeNextDispatch(held), true);
        assert.equal(gate(a), false);
        queue().setRunHeld('r2', false);
        await wait(60);
        assert.equal(statusOf(b), 'sending', 'Resume starts it');
        await finish(a);
        await finish(b);
        assert.deepEqual((readQueueSettings() as Json)['held-runs'], []);
        clean();
    });

    test('QM-5: the editor and the tool', async () => {
        clean();
        queue().setRunHeld('r2', true);
        const access = {
            items: () => queue().items as never, autoSendEnabled: () => queue().autoSendEnabled,
            responseFileTimeoutMinutes: () => 60, pendingCount: () => 0,
            lanes: () => ({ queuePerRun: queue().queuePerRun, heldRuns: [...queue().heldRuns] }),
        } as unknown as PromptQueueAccess;
        const listed = JSON.parse(await listQueueImpl(access, {}));
        assert.deepEqual([listed.queuePerRun, listed.heldRuns], [true, ['r2']]);
        assert.deepEqual(queue().laneSummaries(['default', 'r1']).map((l) => [l.run, l.held]), [['default', false], ['r1', false], ['r2', true]]);
        const handler = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'queueEditor-handler.ts'), 'utf8');
        assert.match(handler, /case 'setQueuePerRun':\s*qm\.queuePerRun = msg\.value === true;/);
        assert.match(handler, /case 'setRunHeld':\s*if \(typeof msg\.run === 'string' && msg\.run\) \{ qm\.setRunHeld\(msg\.run, msg\.held === true\); \}/);
        assert.match(handler, /\.\.\.queueLaneState\(\),/);
        const html = fs.readFileSync(path.join(EXT_ROOT, 'media', 'queueEditor', 'index.html'), 'utf8');
        assert.match(html, /<input type="checkbox" id="queuePerRun" onchange="setQueuePerRun\(this\.checked\)"> Queue per run/);
        assert.match(html, /id="laneStrip"/);
        queue().setRunHeld('r2', false);
        queue().queuePerRun = false;
        assert.equal((readQueueSettings() as Json)['queue-per-run'], false, 'turned off: written off');
        clean();
    });
});
