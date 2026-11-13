/**
 * The queue's lanes and settings per process run (vscimpb46, vscimpb60a; src/utils/queueLanes.ts,
 * src/utils/runQueueSettings.ts) through the real queue manager and process store under the vscode stub. The
 * dispatch of an item is replaced by a gate the test opens, so it can see what sends at the same time;
 * everything else — picking, the lanes, completion, the markers, the settings — is the manager's own.
 *
 *   QM-2 one lane per run, always: the lanes send in parallel; a run's second item waits for its first and
 *        starts when it is done while the other lane still sends
 *   QM-3 two runs of different processes move independently: each Proceed's marker moves its own run's state
 *        file when its own step's item is done, while the other run's item still sends
 *   QM-4 auto-send per run: a paused run starts nothing while another sends; its sending item stops before its
 *        next prompt (the pause gate); resuming it starts it; each run's auto-send is in the settings file
 *        (`runs:`), no lane keys
 *   QM-6 an error in one run (an item the API refuses) pauses only that run; the other run's next item sends
 *   QM-7 each run's defaults: transport, profile, configuration, session, prompt template, reminder template,
 *        Copilot answer timeout and walk continuations are the item's run's
 *   QM-8 Auto-Pause per run: a run whose lane empties pauses (Auto-Pause on); a run with it off goes on
 *   QM-9 Auto-Start and Auto-Continue per run at activation: a run with Auto-Start sends, one without starts
 *        paused, one with Auto-Continue and an interrupted item gets its 30 s start; a run created later
 *        starts from the start values
 *   QM-10 a settings file in the old shape (top-level keys) loads into the default run and gives a new run its
 *        start values; writing keeps the old keys as they were and adds `runs:`
 *   QM-11 the queue editor's tab actions act on their run only (vscimpb60b): Send all staged, Restart, Stop, Retry
 *        errors (not refused while another run sends), Delete errors, Clear sent, Clear all; a chat send records the
 *        run it ran in
 *   QM-12 a staged or pending item moves into another run's queue (the editor's run chip): its run, its session
 *        `<session>@<run>`, behind the run's items, a between-iterations mark dropped; it sends in the new lane; a
 *        sending item and an item of a Proceed run are refused
 *   QM-5 the editor, the tool, Telegram, the Status Page and the window status take or show a run: the editor's
 *        toolbar settings are those of its tab's run (messages name it); tomAi_listQueue reports a run's settings and every run's auto-send; Telegram's pause / continue
 *        take a run (default the window's)
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
import { getQueueFolder, readQueueSettings } from '../../storage/queueFileStorage.js';
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
    queue().setRunAutoSend('default', false);
}
const add = (text: string, run: string, session: string): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: text, run, session, transport: 'anthropic', deferSend: true, initialStatus: 'pending' } as never);

describe('lanes and settings per run', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        gateDispatch();
        assert.equal(queue().queuePerRun, true, 'one lane per run, always');
    });

    test('QM-2: the lanes send in parallel', async () => {
        clean();
        const a1 = await add('a1', 'r1', 'sa');
        const b1 = await add('b1', 'r2', 'sb');
        const a2 = await add('a2', 'r1', 'sa2');
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        queue().setRunQueueSettings('r2', { autoSend: true, autoPause: false });
        await wait(60);
        assert.deepEqual([statusOf(a1), statusOf(b1), statusOf(a2)], ['sending', 'sending', 'pending'], 'one per lane, in parallel');
        assert.deepEqual([...inFlight.keys()].sort(), [a1.id, b1.id].sort());
        await finish(a1);
        assert.deepEqual([statusOf(a1), statusOf(b1), statusOf(a2)], ['sent', 'sending', 'sending'], 'r1 goes on while r2 still sends');
        await finish(b1);
        await finish(a2);
        const settings = readQueueSettings() as Json;
        assert.equal('queue-per-run' in settings, false, 'no lane keys any more');
        assert.equal('held-runs' in settings, false);
        clean();
    });

    test('QM-3: two runs of different processes move independently', async () => {
        clean();
        // Each run's own defaults: on the Copilot transport (the start values) the two would share the one chat.
        queue().setRunQueueSettings('ra', { defaultTransport: 'anthropic', autoSend: false });
        queue().setRunQueueSettings('rb', { defaultTransport: 'anthropic', autoSend: false });
        assert.equal(store().createRun('ra', 'design', 'user', true).ok, true);
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        assert.equal(store().createRun('rb', 'review', 'user', true).ok, true);
        assert.equal((await confirmProcessAction('proceed', undefined, '')).ok, true);
        const prompts = queue().items.filter((i) => !i.processMove);
        const pa = prompts.find((i) => i.processRun?.run === 'ra')!;
        const pb = prompts.find((i) => i.processRun?.run === 'rb')!;
        assert.deepEqual([pa.session, pb.session], ['work@ra', 'check@rb'], 'each run in its own session');
        queue().setRunAutoSend('ra', true);
        queue().setRunAutoSend('rb', true);
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

    test('QM-4: auto-send per run', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        queue().setRunAutoSend('r2', false);
        const a = await add('a', 'r1', 'sa');
        const b = await add('b', 'r2', 'sb');
        queue().autoSendEnabled = true; // the window's run (default): r2 stays paused
        await wait(60);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sending', 'pending'], 'the paused run waits, the other goes');
        assert.deepEqual(queue().heldRuns.includes('r2'), true);
        // The pause gate: a sending item of a paused run stops before its next prompt; another run's does not.
        const gate = (item: QueuedPrompt): boolean => (queue() as Json)._pauseBeforeNextDispatch(queue().getById(item.id));
        const held = { ...queue().getById(b.id)!, status: 'sending', repeatIndex: 1 } as QueuedPrompt;
        assert.equal((queue() as Json)._pauseBeforeNextDispatch(held), true);
        assert.equal(gate(a), false);
        const runs = (readQueueSettings() as Json).runs;
        assert.equal(runs.r2['auto-send-enabled'], false);
        assert.equal(runs.r1['auto-send-enabled'], true);
        queue().setRunAutoSend('r2', true);
        await wait(60);
        assert.equal(statusOf(b), 'sending', 'resuming the run starts it');
        await finish(a);
        await finish(b);
        assert.equal((readQueueSettings() as Json).runs.r2['auto-send-enabled'], true);
        clean();
    });

    test('QM-6: an error stops only its run', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: false });
        queue().setRunQueueSettings('r2', { autoSend: true, autoPause: false });
        const a = await add('a', 'r1', 'sa');
        const b = await add('b', 'r2', 'sb');
        const b2 = await add('b2', 'r2', 'sb2');
        queue().setRunAutoSend('r1', true);
        await wait(60);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sending', 'sending']);
        const live = queue().getById(a.id)!;
        (queue() as Json)._markItemError(live, new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'), 'test');
        assert.equal(statusOf(a), 'error');
        assert.equal(queue().runQueueSettings('r1').autoSend, false, 'r1 paused');
        assert.equal(queue().runQueueSettings('r2').autoSend, true, 'r2 not');
        await finish(b);
        assert.equal(statusOf(b2), 'sending', 'r2 goes on with its next item');
        await finish(b2);
        clean();
    });

    test('QM-7: each run\'s defaults', async () => {
        clean();
        queue().setRunQueueSettings('r1', {
            defaultTransport: 'anthropic', defaultAnthropicProfileId: 'p1', defaultAnthropicConfigId: 'c1', defaultAgentSdkSession: 'work',
            defaultMessageTemplateId: 't1', defaultReminderTemplateId: 'rem1', responseTimeoutMinutes: 30, walkContinuations: 4,
        });
        queue().setRunQueueSettings('r2', { defaultTransport: 'copilot', defaultReminderTemplateId: 'rem2', responseTimeoutMinutes: 120, walkContinuations: 0 });
        const plain = (run: string): Promise<QueuedPrompt> => queue().enqueue({ originalText: `x ${run}`, run, deferSend: true } as never);
        const i1 = await plain('r1');
        const i2 = await plain('r2');
        const t1 = (queue() as Json).resolveStageTransportAsQueued(i1);
        const t2 = (queue() as Json).resolveStageTransportAsQueued(i2);
        assert.deepEqual([t1.transport, t1.anthropicProfileId, t1.anthropicConfigId, t1.session], ['anthropic', 'p1', 'c1', 'work@r1']);
        assert.equal(t2.transport, 'copilot');
        assert.deepEqual([i1.reminderTemplateId, i2.reminderTemplateId], ['rem1', 'rem2'], 'the reminder template of the run');
        assert.deepEqual([queue().responseTimeoutMinutesFor(i1), queue().responseTimeoutMinutesFor(i2)], [30, 120], 'the Copilot answer timeout of the run');
        assert.deepEqual([queue().walkContinuationsOf(i1), queue().walkContinuationsOf(i2)], [4, 0], 'walk continuations of the run');
        assert.equal(queue().runQueueSettings('r1').defaultMessageTemplateId, 't1');
        queue().setDefaultMessageTemplate('t2', 'r2');
        queue().setDefaultTransport('anthropic', 'p2', undefined, 'r2');
        queue().setDefaultAgentSdkSession('other', 'r2');
        assert.deepEqual([queue().runQueueSettings('r2').defaultMessageTemplateId, queue().runQueueSettings('r2').defaultAnthropicProfileId, queue().runQueueSettings('r2').defaultAgentSdkSession], ['t2', 'p2', 'other']);
        assert.equal(queue().runQueueSettings('r1').defaultAnthropicProfileId, 'p1', 'r1 unchanged');
        // The window's run's accessors (the Status Page and the tools read them) are the window's run's settings.
        queue().defaultReminderTemplateId = 'remDefault';
        assert.deepEqual([queue().runQueueSettings('default').defaultReminderTemplateId, queue().runQueueSettings('r1').defaultReminderTemplateId], ['remDefault', 'rem1']);
        clean();
    });

    test('QM-8: Auto-Pause per run', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoSend: true, autoPause: true });
        queue().setRunQueueSettings('r2', { autoSend: true, autoPause: false });
        const a = await add('a', 'r1', 'sa');
        const b = await add('b', 'r2', 'sb');
        queue().setRunAutoSend('r1', true);
        await wait(60);
        await finish(a);
        await finish(b);
        assert.equal(queue().runQueueSettings('r1').autoSend, false, 'r1 paused when its lane emptied');
        assert.equal(queue().runQueueSettings('r2').autoSend, true, 'r2 (Auto-Pause off) goes on');
        clean();
    });

    test('QM-9: Auto-Start and Auto-Continue per run at activation', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoStart: true, autoSend: false });
        queue().setRunQueueSettings('r2', { autoStart: false, autoSend: true });
        queue().setRunQueueSettings('r3', { autoStart: false, autoContinue: true, autoSend: true });
        const c = await add('c', 'r3', 'sc');
        (queue().getById(c.id) as Json).status = 'interrupted';
        (queue() as Json)._applyActivationRunSettings();
        try {
            assert.deepEqual(['r1', 'r2', 'r3'].map((r) => queue().runQueueSettings(r).autoSend), [true, false, false]);
            assert.equal((queue() as Json)._autoContinueTimers.has('r3'), true, 'r3 starts after 30 s');
            assert.equal((queue() as Json)._autoContinueTimers.has('r2'), false);
            assert.equal(queue().runQueueSettings('fresh').autoSend, (queue() as Json)._runStart.autoSend, 'a run created later: the start values');
        } finally {
            for (const t of (queue() as Json)._autoContinueTimers.values()) { clearTimeout(t); }
            (queue() as Json)._autoContinueTimers.clear();
        }
        queue().remove(c.id);
        clean();
    });

    test('QM-10: a settings file in the old shape', () => {
        const file = path.join(getQueueFolder()!, 'queue-settings.yaml');
        const keep = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, [
            'response-timeout-minutes: 30', 'default-reminder-template-id: remOld', 'auto-send-enabled: true', 'auto-start-enabled: true',
            'auto-pause-enabled: false', 'auto-continue-enabled: true', 'walk-continuations: 3', 'default-transport: anthropic',
            'default-anthropic-profile-id: pOld', 'default-agent-sdk-session: sOld', 'default-message-template-id: tOld',
            'queue-per-run: true', 'held-runs: [x]', '',
        ].join('\n'));
        (queue() as Json).restoreSettings();
        const d = queue().runQueueSettings('default');
        assert.deepEqual(
            [d.responseTimeoutMinutes, d.defaultReminderTemplateId, d.autoSend, d.autoStart, d.autoPause, d.autoContinue, d.walkContinuations, d.defaultTransport, d.defaultAnthropicProfileId, d.defaultAgentSdkSession, d.defaultMessageTemplateId],
            [30, 'remOld', true, true, false, true, 3, 'anthropic', 'pOld', 'sOld', 'tOld'],
            'the old keys are the default run\'s',
        );
        assert.equal(queue().runQueueSettings('brandnew').defaultAnthropicProfileId, 'pOld', 'and a new run\'s start values');
        queue().setRunQueueSettings('r1', { autoPause: true });
        const written = readQueueSettings() as Json;
        assert.equal(written['auto-pause-enabled'], false, 'the old keys stay as they were');
        assert.equal(written.runs.default['default-anthropic-profile-id'], 'pOld');
        assert.equal(written.runs.r1['auto-pause-enabled'], true);
        assert.equal(written.runs.r1['default-anthropic-profile-id'], 'pOld', 'r1 started from the start values');
        // A file with `runs:` reads each run's own settings over the start values.
        (queue() as Json).restoreSettings();
        assert.equal(queue().runQueueSettings('r1').autoPause, true);
        fs.writeFileSync(file, keep);
        (queue() as Json).restoreSettings();
    });

    test('QM-11: the tab actions act on their run', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoSend: false });
        queue().setRunQueueSettings('r2', { autoSend: false });
        const st = (text: string, run: string): Promise<QueuedPrompt> =>
            queue().enqueue({ originalText: text, run, transport: 'anthropic', session: `s-${text}`, deferSend: true, initialStatus: 'staged' } as never);
        const a = await st('a', 'r1');
        const b = await st('b', 'r2');
        assert.equal(queue().sendAllStaged('r1'), 1);
        assert.deepEqual([statusOf(a), statusOf(b)], ['pending', 'staged'], 'Send all staged: r1 only');
        // Another run sending does not stop retrying r1's errors.
        queue().setRunAutoSend('r2', true);
        queue().sendAllStaged('r2');
        await wait(60);
        assert.equal(statusOf(b), 'sending');
        (queue().getById(a.id) as Json).status = 'error';
        const retried = await queue().retryAllErrors('r1');
        assert.equal(retried.requeued + retried.resent, 1, 'r1\'s error retried while r2 sends');
        await assert.rejects(() => queue().retryAllErrors('r2'), /Run r2 is sending/);
        // The retry switched r1 on again: its item sends beside r2's.
        await wait(60);
        assert.deepEqual([statusOf(a), statusOf(b)], ['sending', 'sending']);
        // Restart and Stop of one run leave the other's sending item alone.
        queue().restartQueue('r1');
        assert.equal(statusOf(b), 'sending', 'Restart of r1 leaves r2 sending');
        assert.equal(queue().stopActiveItem(undefined, 'r2'), true, 'Stop of r2 stops its item');
        assert.equal(statusOf(b), 'staged');
        await wait(60);
        assert.equal(statusOf(a), 'sending', 'r1 goes on');
        assert.equal(queue().stopActiveItem(undefined, 'r1'), true);
        inFlight.clear();
        // Delete errors, Clear sent, Clear all: per run.
        (queue().getById(a.id) as Json).status = 'error';
        (queue().getById(b.id) as Json).status = 'error';
        queue().clearByStatus('error', 'r1');
        assert.deepEqual([statusOf(a), statusOf(b)], [undefined, 'error']);
        const c = await st('c', 'r1');
        queue().clearAll('r2');
        assert.deepEqual([statusOf(b), statusOf(c)], [undefined, 'staged'], 'Clear all of r2 leaves r1');
        // A chat send records the run it ran in.
        const chatId = queue().addChatItem({ text: 'hi', session: 'chat@r2', source: 'panel', run: 'r2' });
        assert.equal(queue().getById(chatId)?.run, 'r2');
        const plain = queue().addChatItem({ text: 'hi', session: 'chat', source: 'panel', run: 'default' });
        assert.equal(queue().getById(plain)?.run, undefined, 'default: no run written');
        clean();
    });

    test('QM-12: a staged or pending item moves into another run\'s queue', async () => {
        clean();
        queue().setRunQueueSettings('r1', { autoSend: false });
        queue().setRunQueueSettings('r2', { autoSend: false, autoPause: false });
        const a = await add('a', 'r1', 'sa');
        const s = await queue().enqueue({ originalText: 's', run: 'r1', transport: 'anthropic', deferSend: true, initialStatus: 'staged' } as never);
        const b = await add('b', 'r2', 'sb');
        assert.equal(queue().getById(a.id)?.session, 'sa@r1');
        (queue().getById(a.id) as Json).sendBetween = true;
        assert.deepEqual(queue().moveItemToRun(a.id, 'r2'), { ok: true, moved: true });
        const moved = queue().getById(a.id)!;
        assert.equal(moved.run, 'r2');
        assert.equal(moved.session, 'sa@r2', 'its session is the new run\'s');
        assert.equal(moved.sendBetween, undefined, 'the old lane\'s mark is dropped');
        assert.deepEqual(queue().items.map((i) => i.id).slice(-2), [b.id, a.id], 'behind the run\'s items');
        assert.deepEqual(queue().moveItemToRun(a.id, 'r2'), { ok: true, moved: false }, 'its own run: nothing changes');
        assert.deepEqual(queue().moveItemToRun(s.id, 'default'), { ok: true, moved: true }, 'a staged item too');
        assert.equal(queue().getById(s.id)?.run, 'default');
        // It sends in its new run's lane: r2 on, r1 off.
        queue().setRunAutoSend('r2', true);
        await wait(60);
        assert.deepEqual([statusOf(b), statusOf(a)], ['sending', 'pending'], 'r2\'s lane: b first, then a');
        await finish(b);
        assert.equal(statusOf(a), 'sending');
        assert.match(String((queue().moveItemToRun(a.id, 'r1') as Json).reason), /staged or pending/, 'a sending item stays');
        await finish(a);
        const p = await queue().enqueue({ originalText: 'p', transport: 'anthropic', deferSend: true, initialStatus: 'pending', processRun: { quest: 'q', state: {}, run: 'r1' } } as never);
        assert.match(String((queue().moveItemToRun(p.id, 'r2') as Json).reason), /Proceed run/);
        clean();
    });

    test('QM-5: the editor, the tool, Telegram, the Status Page, the window status', async () => {
        clean();
        queue().setRunHeld('r2', true);
        assert.equal(queue().runQueueSettings('r2').autoSend, false, 'setRunHeld (Telegram, tools): the run\'s auto-send');
        // tomAi_listQueue: a run's settings and every run's auto-send.
        const access = {
            items: () => queue().items as never, autoSendEnabled: () => queue().autoSendEnabled,
            responseFileTimeoutMinutes: () => queue().responseFileTimeoutMinutes, pendingCount: () => 0,
            runSettings: (run?: string) => ({
                run: run ?? queue().windowRun, settings: { ...queue().runQueueSettings(run) },
                runs: ['default', 'r2'].map((r) => ({ run: r, autoSend: queue().runQueueSettings(r).autoSend })),
            }),
        } as unknown as PromptQueueAccess;
        const listed = JSON.parse(await listQueueImpl(access, { run: 'r2' }));
        assert.deepEqual([listed.run, listed.autoSendEnabled, listed.settings.autoSend], ['r2', false, false]);
        assert.deepEqual(listed.runs.find((r: Json) => r.run === 'r2'), { run: 'r2', autoSend: false });
        const tools = fs.readFileSync(path.join(EXT_ROOT, 'src', 'tools', 'chat-enhancement-tools.ts'), 'utf8');
        assert.match(tools, /runSettings\(run\) \{[\s\S]{0,600}settings: \{ \.\.\.m\.runQueueSettings\(name\) \}/);
        assert.deepEqual(queue().laneSummaries(['default', 'r1']).map((l) => [l.run, l.held]).filter(([r]) => r !== 'r1'), [['default', true], ['r2', true]]);
        // The editor: settings messages name the run; the host applies them to it (the tabs: queueEditorRuns.dom.test).
        const handler = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'queueEditor-handler.ts'), 'utf8');
        assert.match(handler, /qm\.setRunQueueSettings\(run, \{ \[key\]: !qm\.runQueueSettings\(run\)\[key\] \}\);/);
        assert.match(handler, /case 'setSettingsRun':/);
        assert.match(handler, /setDefaultTransport\(transport, pid, undefined, run\)/);
        assert.doesNotMatch(handler, /case 'setRunHeld':/, 'the lane strip and its message are gone: a tab\'s play / pause is its run\'s auto-send');
        assert.match(handler, /\.\.\.queueLaneState\(\),/);
        const html = fs.readFileSync(path.join(EXT_ROOT, 'media', 'queueEditor', 'index.html'), 'utf8');
        assert.doesNotMatch(html, /id="queuePerRun"/, 'the Queue per run checkbox is gone');
        assert.match(html, /id="runTabs"/, 'a tab per run (vscimpb60b) instead of the lane strip');
        assert.doesNotMatch(html, /id="laneStrip"/);
        // Telegram: pause / continue of a run.
        const telegram = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'telegram-commands.ts'), 'utf8');
        assert.match(telegram, /setRunning: \(running, run\) => \{ PromptQueueManager\.instance\.setRunAutoSend\(run, running\); \}/);
        // The Status Page and the window status say the run.
        const status = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'statusPage-handler.ts'), 'utf8');
        assert.match(status, /queueRun = PromptQueueManager\.instance\.windowRun;/);
        const activity = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'windowActivity-handler.ts'), 'utf8');
        assert.match(activity, /run: qm\.windowRun,[\s\S]{0,120}pausedRuns: qm\.heldRuns,/);
        queue().setRunHeld('r2', false);
        clean();
    });
});
