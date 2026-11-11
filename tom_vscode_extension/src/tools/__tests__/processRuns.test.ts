/**
 * Runs: several process positions in one quest (vscimpb29, src/utils/processRuns.ts), through the real store,
 * the process tools and Proceed with its process-move marker.
 *
 *   RN-1 the names: a run name's rules, `default` reserved; the state file of a run and the run of a file name
 *   RN-2 the repository: the quest's own file is `default` (also without a file); a run is
 *        `process-state.<quest>.<run>.yaml`, listed the last changed first; deleting `default` is refused
 *   RN-3 the store: two runs of different processes move independently; each writes only its own file; selecting a
 *        run makes the state, the moves and the `run` chat variable its own; the window's run is kept per quest;
 *        deleting runs (`default` refused, an unknown one refuses all), a deleted current run leaves `default`
 *   RN-4 the tools: tomAi_createProcessRun, tomAi_listProcessRuns, tomAi_selectProcessRun, tomAi_deleteProcessRuns;
 *        `run` on tomAi_getProcessState / tomAi_setProcessState reads / moves a run without selecting it; an
 *        unknown run is refused
 *   RN-5 Proceed in a run: its items carry the run; another run's Proceed is not held up by them; when the queue
 *        reaches the marker, it moves the run it was queued for — also while the window works on another run
 *   RN-6 a queued position keeps its level and run in the entry file (parseProcessRun)
 *   RN-7 the PROCESS view's run messages (processPanel-handler liveRunStore + processRunActions): + creates and
 *        selects a run (the name checked against the rules and the runs there are, a process or none), a click
 *        selects one, trash offers the runs but `default` and deletes the chosen ones after the confirmation (a
 *        deleted current run leaves the window on `default`); the list is the last changed first, the current marked
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'process-runs-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const QDIR = path.join(WS, '_ai', 'quests', QUEST);

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Quest Overview: Q1\n');
for (const id of ['main', 'change']) {
    put(`_ai/processes/${id}/${id}.process.yaml`, [
        `id: ${id}`, `name: ${id}`, 'phases:', '  - id: p1', '    steps:',
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
import { withTiming } from './_timing.js';
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
import { parseProcessRun } from '../../services/processRunContext.js';
import { handleRunMessage, type RunUiPort } from '../../services/processRunActions.js';
import { liveRunStore } from '../../handlers/processPanel-handler.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { DEFAULT_RUN, runNameError, runOfStateFile, runStateFileName } from '../../utils/processRuns.js';
import {
    CREATE_PROCESS_RUN_TOOL, DELETE_PROCESS_RUNS_TOOL, GET_PROCESS_STATE_TOOL, LIST_PROCESS_RUNS_TOOL,
    SELECT_PROCESS_RUN_TOOL, SET_PROCESS_STATE_TOOL,
} from '../quest-process-tools.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const call = async (tool: { execute: (input: never) => Promise<string> }, input: object = {}): Promise<Json> => JSON.parse(await tool.execute(input as never));
const fileOf = (run: string): string => path.join(QDIR, runStateFileName(QUEST, run));
const stepIn = (run: string): string => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, run).step;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function clean(): void {
    for (const i of [...queue().items]) { queue().remove(i.id); }
    store().selectRun(DEFAULT_RUN);
    for (const r of store().runs()) { if (r.run !== DEFAULT_RUN) { store().deleteRuns([r.run]); } }
    assert.equal(store().apply({ process: 'main', phase: 'p1', step: 'plan' }, 'user').ok, true);
}

describe('process runs', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        assert.equal(store().activeQuest, QUEST);
        assert.equal(store().currentRun, DEFAULT_RUN);
    });

    test('RN-1: names and files', () => {
        assert.equal(runNameError('chg-12_a'), null);
        for (const bad of ['', 'default', 'a.b', '-x', 'a b', 'a/b', 'x'.repeat(65)]) { assert.ok(runNameError(bad), bad); }
        assert.equal(runStateFileName('q1'), 'process-state.q1.yaml');
        assert.equal(runStateFileName('q1', 'chg1'), 'process-state.q1.chg1.yaml');
        assert.equal(runOfStateFile('q1', 'process-state.q1.yaml'), DEFAULT_RUN);
        assert.equal(runOfStateFile('q1', 'process-state.q1.chg1.yaml'), 'chg1');
        for (const other of ['process-state.q2.yaml', 'process-state.q1.a.b.yaml', 'process-state.q1.default.yaml', 'overview.q1.md']) {
            assert.equal(runOfStateFile('q1', other), null, other);
        }
    });

    test('RN-2: the repository', () => {
        const root = fs.mkdtempSync(path.join(SANDBOX, 'repo-'));
        const repo = new ProcessRepository(path.join(root, 'processes'), path.join(root, 'quests'));
        assert.deepEqual(repo.listRuns('qx').map((r) => [r.run, r.changed]), [[DEFAULT_RUN, null]], 'default without a file');
        repo.writeState('qx', { ...repo.readState('qx'), process: 'main', phase: 'p1', step: 'plan' }, 'a1');
        const later = new Date(Date.now() + 5000);
        repo.writeState('qx', { ...repo.readState('qx'), process: 'main', phase: 'p1', step: 'build' }, 'b2');
        fs.utimesSync(repo.stateFile('qx', 'b2'), later, later);
        assert.deepEqual(repo.listRuns('qx').map((r) => r.run), ['b2', 'a1', DEFAULT_RUN], 'the last changed first');
        assert.equal(repo.readState('qx', 'b2').step, 'build');
        assert.equal(repo.readState('qx').step, '', 'default untouched');
        assert.equal(repo.deleteRun('qx', DEFAULT_RUN).ok, false);
        assert.equal(repo.deleteRun('qx', 'a1').ok, true);
        assert.equal(repo.hasRun('qx', 'a1'), false);
    });

    test('RN-3: two runs in the store', () => {
        clean();
        const before = fs.readFileSync(fileOf(DEFAULT_RUN), 'utf8');
        const made = store().createRun('chg1', 'change', 'user', false);
        assert.equal(made.ok, true, JSON.stringify(made));
        assert.equal(store().currentRun, DEFAULT_RUN, 'not selected');
        assert.equal(stepIn('chg1'), 'plan', 'at the first position of its process');
        // Moving the window's run leaves the other alone, and the other way round.
        assert.equal(store().apply({ step: 'build' }, 'user').ok, true);
        assert.equal(stepIn('chg1'), 'plan');
        const other = store().withRun('chg1', () => store().apply({ step: 'build' }, 'user'));
        assert.equal(other.ok, true);
        assert.equal(stepIn('chg1'), 'build');
        assert.equal(store().state.process, 'main', 'the window\'s run is back');
        assert.equal(store().apply({ step: 'plan' }, 'user').ok, true);
        assert.equal(stepIn('chg1'), 'build', 'still its own');
        assert.notEqual(fs.readFileSync(fileOf(DEFAULT_RUN), 'utf8'), before, 'default wrote its own file');
        // Selecting a run.
        assert.equal(store().selectRun('chg1').ok, true);
        assert.deepEqual([store().currentRun, store().state.process, store().state.step], ['chg1', 'change', 'build']);
        assert.equal(store().variables().run, 'chg1');
        assert.equal(store().variables().process, 'change');
        store().reload();
        assert.equal(store().currentRun, 'chg1', 'kept for the window and quest');
        assert.equal(store().selectRun('nope').ok, false);
        assert.deepEqual(store().runs().map((r) => [r.run, r.process, r.current]).sort(), [['chg1', 'change', true], [DEFAULT_RUN, 'main', false]]);
        // Deleting.
        assert.equal(store().deleteRuns([DEFAULT_RUN]).ok, false);
        assert.equal(store().deleteRuns(['chg1', 'nope']).ok, false, 'an unknown one refuses all');
        assert.ok(fs.existsSync(fileOf('chg1')));
        assert.equal(store().deleteRuns(['chg1']).ok, true);
        assert.equal(store().currentRun, DEFAULT_RUN, 'back on default');
        assert.equal(fs.existsSync(fileOf('chg1')), false);
        assert.equal(store().createRun('default', undefined, 'user').ok, false);
    });

    test('RN-4: the tools', async () => {
        clean();
        const made = await withTiming('tomAi_createProcessRun:typical', () => call(CREATE_PROCESS_RUN_TOOL, { run: 'chg2', process: 'change', select: false }));
        assert.equal(made.ok, true, JSON.stringify(made));
        assert.equal((await call(CREATE_PROCESS_RUN_TOOL, { run: 'chg2' })).ok, false, 'a taken name');
        assert.equal((await call(CREATE_PROCESS_RUN_TOOL, { run: 'chg3', process: 'nope' })).ok, false, 'an unknown process');
        assert.equal(fs.existsSync(fileOf('chg3')), false, 'nothing left behind');
        const listed = await withTiming('tomAi_listProcessRuns:typical', () => call(LIST_PROCESS_RUNS_TOOL));
        assert.equal(listed.currentRun, DEFAULT_RUN);
        assert.deepEqual(listed.runs.map((r: Json) => r.run).sort(), ['chg2', DEFAULT_RUN]);
        const moved = await call(SET_PROCESS_STATE_TOOL, { run: 'chg2', step: 'build' });
        assert.equal(moved.ok, true, JSON.stringify(moved));
        assert.equal(moved.run, 'chg2');
        assert.equal(store().currentRun, DEFAULT_RUN, 'not selected');
        assert.equal(store().state.step, 'plan');
        const read = await call(GET_PROCESS_STATE_TOOL, { run: 'chg2' });
        assert.deepEqual([read.run, read.state.process, read.state.step], ['chg2', 'change', 'build']);
        assert.equal((await call(GET_PROCESS_STATE_TOOL, {})).run, DEFAULT_RUN);
        assert.equal((await call(GET_PROCESS_STATE_TOOL, { run: 'nope' })).ok, false);
        assert.equal((await call(SET_PROCESS_STATE_TOOL, { run: 'nope', step: 'build' })).ok, false);
        const selected = await withTiming('tomAi_selectProcessRun:typical', () => call(SELECT_PROCESS_RUN_TOOL, { run: 'chg2' }));
        assert.deepEqual([selected.ok, selected.run, selected.state.step], [true, 'chg2', 'build']);
        assert.equal((await call(DELETE_PROCESS_RUNS_TOOL, { runs: ['default'] })).ok, false);
        const deleted = await withTiming('tomAi_deleteProcessRuns:typical', () => call(DELETE_PROCESS_RUNS_TOOL, { runs: ['chg2'] }));
        assert.deepEqual([deleted.ok, deleted.deleted, deleted.currentRun], [true, ['chg2'], DEFAULT_RUN]);
    });

    test('RN-5: Proceed in a run', async () => {
        clean();
        assert.equal(store().createRun('chg4', 'change', 'user').ok, true);
        assert.equal(store().currentRun, 'chg4');
        const proceed = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceed.ok, true, JSON.stringify(proceed));
        const [prompt, marker] = queue().items;
        assert.equal(prompt.processRun?.run, 'chg4');
        assert.equal(marker.processRun?.run, 'chg4');
        assert.equal(queue().stepRunProgress(QUEST, 0, 'chg4')?.left, 1);
        // The window goes back to default: its Proceed is not held up by chg4's step.
        assert.equal(store().selectRun(DEFAULT_RUN).ok, true);
        assert.equal(queue().stepRunProgress(QUEST, 0, DEFAULT_RUN), undefined);
        // The queue reaches chg4's marker: chg4 moves, default stays.
        (queue().getById(prompt.id) as QueuedPrompt).status = 'sent';
        await queue().sendNext();
        await wait(50);
        assert.equal(queue().getById(marker.id)?.status, 'sent');
        assert.equal(stepIn('chg4'), 'build', 'the run it was queued for moved');
        assert.equal(store().state.step, 'plan', 'the window\'s run did not');
        assert.equal(store().currentRun, DEFAULT_RUN);
        for (const i of [...queue().items]) { queue().remove(i.id); }
    });

    test('RN-6: the queued position keeps its level and run', () => {
        const run = parseProcessRun({ quest: QUEST, state: { process: 'main', phase: 'p1', step: 'plan' }, proceedId: 'proceed-x', level: 1, run: 'chg9' });
        assert.deepEqual([run?.level, run?.run, run?.proceedId], [1, 'chg9', 'proceed-x']);
        const plain = parseProcessRun({ quest: QUEST, state: { process: 'main' }, run: 'default' });
        assert.deepEqual([plain?.level, plain?.run], [undefined, undefined], 'default is no run of its own');
    });

    test('RN-7: the PROCESS view\'s run messages', async () => {
        clean();
        const asked: Json[] = [];
        let answer: { name?: string; process?: string | null; runs?: string[]; confirm?: boolean } = {};
        let validate: ((v: string) => string | undefined) | undefined;
        const ui: RunUiPort = {
            inputRunName: async (v) => { validate = v; return answer.name; },
            pickProcess: async (items) => { asked.push({ processes: items.map((i) => i.id) }); return answer.process; },
            pickRuns: async (items) => { asked.push({ runs: items.map((i) => i.run) }); return answer.runs; },
            confirm: async (message) => { asked.push({ confirm: message }); return answer.confirm === true; },
        };
        const live = liveRunStore(store());
        // +: a name, a process, created and selected.
        answer = { name: 'chg7', process: 'change' };
        assert.deepEqual(await handleRunMessage({ type: 'createRun' }, live, ui), { handled: true, result: { ok: true } });
        assert.deepEqual(asked.shift(), { processes: ['', 'change', 'main'] }, 'none, then the processes');
        assert.equal(store().currentRun, 'chg7');
        assert.equal(store().state.process, 'change');
        // + without a process (its name checked against the runs there are); a dismissed picker creates nothing.
        answer = { name: 'chg8', process: null };
        assert.deepEqual((await handleRunMessage({ type: 'createRun' }, live, ui)), { handled: true, result: { ok: true } });
        asked.length = 0;
        assert.equal(validate!('default'), 'every quest has the run "default" already');
        assert.equal(validate!('chg7'), 'The quest has a run "chg7" already.');
        assert.match(validate!('bad name') ?? '', /no run name/);
        assert.equal(validate!('chg8'), undefined);
        assert.equal(store().state.process, '', 'no process yet');
        answer = { name: 'chg9', process: undefined };
        assert.deepEqual(await handleRunMessage({ type: 'createRun' }, live, ui), { handled: true, result: undefined });
        asked.length = 0;
        assert.deepEqual(store().runs().map((r) => r.run).sort(), ['chg7', 'chg8', 'default']);
        assert.equal(store().runs().find((r) => r.current)?.run, 'chg8', 'the current one marked');
        // A click selects.
        assert.deepEqual(await handleRunMessage({ type: 'selectRun', run: 'chg7' }, live, ui), { handled: true, result: { ok: true } });
        assert.equal(store().currentRun, 'chg7');
        await wait(15);
        assert.equal(store().apply({ step: 'build' }, 'user').ok, true);
        assert.equal(store().runs()[0].run, 'chg7', 'the last changed first');
        // Trash: the runs but default, then the confirmation.
        answer = { runs: ['chg7', 'chg8'], confirm: false };
        assert.deepEqual(await handleRunMessage({ type: 'deleteRuns' }, live, ui), { handled: true, result: undefined });
        assert.deepEqual(asked.shift(), { runs: ['chg7', 'chg8'] });
        assert.match(asked.shift().confirm, /Delete 2 runs: chg7, chg8\?/);
        assert.equal(store().runs().length, 3, 'not confirmed: nothing deleted');
        answer = { runs: ['chg7', 'chg8'], confirm: true };
        assert.deepEqual(await handleRunMessage({ type: 'deleteRuns' }, live, ui), { handled: true, result: { ok: true } });
        assert.deepEqual(store().runs().map((r) => r.run), ['default']);
        assert.equal(store().currentRun, DEFAULT_RUN, 'the deleted current run leaves default');
        assert.deepEqual(await handleRunMessage({ type: 'deleteRuns' }, live, ui), { handled: true, result: { ok: false, error: 'the quest has no run besides "default", which is never deleted' } });
        assert.deepEqual(await handleRunMessage({ type: 'action' }, live, ui), { handled: false });
        clean();
    });
});
