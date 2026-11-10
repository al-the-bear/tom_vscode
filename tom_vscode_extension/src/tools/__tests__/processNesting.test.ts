/**
 * Nested processes: subprocesses and branches on a quest's process stack (src/utils/processStack.ts,
 * ProcessStateStore, processActionService, the queue's markers, nestedProcessCommands). The real store and
 * queue run under the vscode stub in a sandbox workspace; nothing is sent to a model.
 *
 *   NP-1 a step (and a sub-step, else its step's) lists `subprocesses:` and `branches:` — ids or {process,
 *        description}; the validator refuses a bad entry, an unknown key, a process listed twice; the
 *        writer keeps the lists; the schema has them on steps, sub-steps and post-gate steps
 *   NP-2 the lists are closed: only a listed process starts, as the kind it is listed as; not at a decision;
 *        not an undefined process; a start pushes a level at the process's first position with its kind,
 *        follow-up and start time, and the step below waits; the state file holds every level
 *   NP-3 any depth, a process may recur (each level its own position); beyond the maximum depth the start
 *        asks for a confirmation (declined: nothing starts); the depth setting comes from processNesting
 *   NP-4 a level that finishes its process ends: go-on moves the step below where Proceed would have led,
 *        run-again leaves it at the step, ask leaves the decision Go on / Run the step again (decisionAt),
 *        whose choice clears it
 *   NP-5 Abort subprocess asks first; aborted, the level goes, the decisions journal records where it stood,
 *        the step below goes on with its follow-up
 *   NP-6 the queue: a Proceed run carries its level; while the step below still has items queued the new
 *        level's Proceed is allowed and goes in behind them; the step below's marker moves nothing while a
 *        level above runs; the new level's marker moves the new level
 *   NP-7 switching the quest's process leaves every level; levels and their nested marks survive the file
 *   NP-8 inputs and outputs (CC-61): a process declares `inputs` / `outputs` (name, kind, description,
 *        required; an output's default `value` with ${input.<name>}); a list entry's `inputs` fill them; the
 *        validator refuses bad declarations and mappings; the writer and the schema keep them
 *   NP-9 a start fills the inputs at the starting position (the placeholder engine; an undeclared name or an
 *        empty required input refuses the start); the level's prompts see ${input.<name>} and the context
 *        block lists inputs and outputs to hand back
 *   NP-10 outputs: tomAi_setProcessState {outputs} sets declared ones on a nested level (not the quest's own,
 *        no undeclared name) without ending a running step; a subprocess finishes only with its required
 *        outputs set; then they come back to the level below as ${sub.<process>.<name>} (defaults filled);
 *        an aborted level hands nothing back
 *   NP-11 the process editor edits a process's inputs and outputs and saves them in the definition
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'process-nesting-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Quest Overview: Q1\n');
put('_ai/processes/main/main.process.yaml', [
    'id: main',
    'name: Main',
    'phases:',
    '  - id: p1',
    '    steps:',
    '      - id: plan',
    '        name: Plan',
    '        subprocesses:',
    '          - sub',
    '          - process: main',
    '            description: the same process again',
    '          - process: iosub',
    '            inputs:',
    '              doc: docs/${step}.md',
    '              folder: out',
    '        branches: [side]',
    '      - id: build',
    '        name: Build',
    '    gate:',
    '      id: g1',
    '',
].join('\n'));
put('_ai/processes/main/main.md', '# Main\n');
put('_ai/processes/iosub/iosub.process.yaml', [
    'id: iosub', 'name: IO sub',
    'inputs:',
    '  - {name: doc, kind: document, required: true, description: the document to review}',
    '  - {name: folder, kind: folder}',
    'outputs:',
    '  - {name: result, kind: document, required: true}',
    '  - {name: report, value: "${input.folder}/report.md"}',
    'phases:', '  - id: s1', '    steps:', '      - id: work', '    gate:', '      id: sg', '',
].join('\n'));
put('_ai/processes/iosub/iosub.md', '# iosub\n');
for (const id of ['sub', 'side']) {
    put(`_ai/processes/${id}/${id}.process.yaml`, [`id: ${id}`, `name: ${id}`, 'phases:', '  - id: s1', '    steps:', '      - id: work', '        role: reviewer', '    gate:', '      id: sg', ''].join('\n'));
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
import { abortNestedProcess, maxProcessDepth, startNestedProcess, type NestedStartUi } from '../../services/nestedProcessCommands.js';
import { decisionAt, parseProcessStateStack, parseProcessYaml, stringifyProcessDefinition, stringifyProcessStateStack, type ProcessDefinition } from '../../utils/processDefinition.js';
import { decisionDialog } from '../../utils/processActionPrompt.js';
import { DEFAULT_MAX_PROCESS_DEPTH, fillNestedInputs, positionProcessLists, startNeedsConfirmation } from '../../utils/processStack.js';
import { SET_PROCESS_STATE_TOOL } from '../quest-process-tools.js';
import { JSDOM } from 'jsdom';

const subscriptions: Array<{ dispose(): void }> = [];
function start(): void {
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
}
start();
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
const set = (id: string, status: QueuedPrompt['status']): void => { (queue().getById(id) as QueuedPrompt).status = status; };
const stateFile = (): string => fs.readFileSync(path.join(WS, '_ai', 'quests', QUEST, `process-state.${QUEST}.yaml`), 'utf8');
function reset(): void {
    for (const i of [...queue().items]) { queue().remove(i.id); }
    const r = store().apply({ process: '' }, 'user');
    assert.equal(r.ok, true);
    const m = store().apply({ process: 'main', phase: 'p1', step: 'plan' }, 'user');
    assert.equal(m.ok, true, JSON.stringify(m));
}
/** A UI that picks `pick` with `followUp`, answers confirmations with `confirm`, records what it was shown. */
function ui(pick: { kind: 'subprocess' | 'branch'; process: string } | undefined, followUp: 'ask' | 'go-on' | 'run-again' = 'ask', confirm = true) {
    const shown: { items?: Json[]; followUps?: string[]; confirms: string[]; infos: string[]; errors: string[] } = { confirms: [], infos: [], errors: [] };
    const u: NestedStartUi = {
        pickProcess: async (items) => { shown.items = items; return pick; },
        pickFollowUp: async (items) => { shown.followUps = items.map((i) => i.label); return followUp; },
        confirm: async (m) => { shown.confirms.push(m); return confirm; },
        info: (m) => { shown.infos.push(m); },
        error: (m) => { shown.errors.push(m); },
    };
    return { u, shown };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('nested processes', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        assert.equal(store().activeQuest, QUEST);
    });

    test('NP-1: the lists in the definition', () => {
        const ok = parseProcessYaml(fs.readFileSync(path.join(WS, '_ai/processes/main/main.process.yaml'), 'utf8'));
        assert.deepEqual(ok.errors, []);
        const def = ok.definition!;
        assert.match(stringifyProcessDefinition(def), /subprocesses:\n\s+- sub\n\s+- process: main\n\s+description: the same process again\n\s+- process: iosub\n[\s\S]*branches:\n\s+- side/, 'the writer keeps them');
        assert.deepEqual(positionProcessLists(def, { process: 'main', phase: 'p1', phaseIteration: 1, step: 'plan', stepIteration: 1, substep: '', substepIteration: 1, completed: false }),
            { subprocesses: [{ process: 'sub' }, { process: 'main', description: 'the same process again' }, { process: 'iosub', inputs: { doc: 'docs/${step}.md', folder: 'out' } }], branches: [{ process: 'side' }] });
        const bad = parseProcessYaml(['id: x', 'phases:', '  - id: a', '    steps:', '      - id: s', '        subprocesses: [ok, ok, "-bad", {process: y, extra: 1}, {description: d}]', '        branches: nope', '    gate: {id: g}'].join('\n'));
        assert.deepEqual(bad.errors.map((e) => e.path).sort(), [
            'phases[0].steps[0].branches', 'phases[0].steps[0].subprocesses[1]', 'phases[0].steps[0].subprocesses[2]',
            'phases[0].steps[0].subprocesses[3].extra', 'phases[0].steps[0].subprocesses[4].process',
        ].sort(), JSON.stringify(bad.errors));
        // A sub-step takes its step's lists unless it lists its own.
        const withSubs = parseProcessYaml(['id: x', 'phases:', '  - id: a', '    steps:', '      - id: s', '        branches: [b1]', '        substeps:', '          - id: s1', '          - id: s2', '            branches: [b2]', '    gate: {id: g}'].join('\n')).definition as ProcessDefinition;
        const at = (substep: string) => positionProcessLists(withSubs, { process: 'x', phase: 'a', phaseIteration: 1, step: 's', stepIteration: 1, substep, substepIteration: 1, completed: false });
        assert.deepEqual(at('s1').branches, [{ process: 'b1' }]);
        assert.deepEqual(at('s2').branches, [{ process: 'b2' }]);
        const schema = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'src', 'config', 'process.schema.json'), 'utf8'));
        for (const k of ['step', 'substep', 'postGate']) {
            assert.equal(schema.$defs[k].properties.subprocesses.$ref, '#/$defs/processList', k);
            assert.equal(schema.$defs[k].properties.branches.$ref, '#/$defs/processList', k);
        }
    });

    test('NP-2: closed lists; a start pushes a level', async () => {
        reset();
        for (const [kind, id, why] of [['subprocess', 'side', /lists no subprocess "side"/], ['branch', 'sub', /lists no branch "sub"/], ['subprocess', 'other', /lists no subprocess "other"/]] as const) {
            const r = store().startNested(kind, id, 'ask', 'user');
            assert.equal(r.ok, false);
            assert.match(!r.ok ? r.error : '', why);
        }
        const { u, shown } = ui({ kind: 'subprocess', process: 'sub' }, 'go-on');
        assert.equal(await startNestedProcess(store(), u), true, JSON.stringify(shown));
        assert.deepEqual(shown.items!.map((i: Json) => [i.nestedKind, i.process]), [['subprocess', 'sub'], ['subprocess', 'main'], ['subprocess', 'iosub'], ['branch', 'side']], 'both lists offered');
        const levels = store().levels;
        assert.equal(levels.length, 2);
        assert.deepEqual([levels[0].process, levels[0].step], ['main', 'plan'], 'the step below waits');
        assert.deepEqual([levels[1].process, levels[1].phase, levels[1].step], ['sub', 's1', 'work'], 'the first position');
        assert.deepEqual([levels[1].nested?.kind, levels[1].nested?.followUp], ['subprocess', 'go-on']);
        assert.match(levels[1].nested!.startedAt, /^\d{4}-\d\d-\d\dT/);
        assert.equal(store().state.process, 'sub', 'the top level runs');
        assert.equal(ChatVariablesStore.instance.role, 'reviewer', 'the role follows the new top');
        assert.deepEqual(parseProcessStateStack(stateFile()).levels.map((l) => l.process), ['main', 'sub']);
        // At a decision nothing starts.
        reset();
        assert.equal(store().apply({ step: 'g1' }, 'user').ok, true);
        assert.equal(store().move('skip', undefined, 'user').ok, true);
        assert.equal(store().state.decision, true, JSON.stringify(store().state));
        const atDecision = store().startNested('subprocess', 'sub', 'ask', 'user');
        assert.equal(atDecision.ok, false);
        assert.match(!atDecision.ok ? atDecision.error : '', /at a decision/);
    });

    test('NP-3: depth and recursion', async () => {
        reset();
        assert.equal(maxProcessDepth(), DEFAULT_MAX_PROCESS_DEPTH);
        for (let i = 0; i < 2; i++) {
            const { u } = ui({ kind: 'subprocess', process: 'main' }, 'run-again');
            assert.equal(await startNestedProcess(store(), u, 5), true);
        }
        assert.deepEqual(store().levels.map((l) => l.process), ['main', 'main', 'main'], 'recursion, each its own level');
        assert.equal(store().move('skip', undefined, 'user').ok, true);
        assert.deepEqual(store().levels.map((l) => l.step), ['plan', 'plan', 'build'], 'each level keeps its own position');
        assert.equal(store().move('back', undefined, 'user').ok, true);
        const declined = ui({ kind: 'subprocess', process: 'main' }, 'ask', false);
        assert.equal(await startNestedProcess(store(), declined.u, 2), false);
        assert.match(declined.shown.confirms[0], /at nesting depth 3/);
        assert.equal(store().levels.length, 3, 'declined: nothing started');
        const accepted = ui({ kind: 'subprocess', process: 'main' }, 'ask', true);
        assert.equal(await startNestedProcess(store(), accepted.u, 2), true);
        assert.equal(store().levels.length, 4);
        assert.deepEqual([startNeedsConfirmation([{} as Json], 0), startNeedsConfirmation([{} as Json], 1), startNeedsConfirmation([{}, {}] as Json, 1)], [true, false, true]);
        const within = ui({ kind: 'subprocess', process: 'main' });
        reset();
        assert.equal(await startNestedProcess(store(), within.u, 5), true);
        assert.deepEqual(within.shown.confirms, [], 'within the depth: no confirmation');
        assert.deepEqual(within.shown.followUps, ['Ask me at the end (Go on / Run the step again)', 'Go on past the step', 'Run the step again']);
        const rec = ui({ kind: 'subprocess', process: 'sub' }, 'run-again');
        assert.equal(await startNestedProcess(store(), rec.u, 5, 'run-again'), true);
        assert.deepEqual(rec.shown.followUps, ['Run the step again (recommended)', 'Ask me at the end (Go on / Run the step again)', 'Go on past the step'], 'the recommendation first, marked');
    });

    test('NP-4: the follow-ups when a level finishes', async () => {
        // go-on: the step below moves where Proceed would have led.
        reset();
        assert.equal(store().startNested('subprocess', 'sub', 'go-on', 'user').ok, true);
        assert.equal(store().apply({ completed: true }, 'user').ok, true);
        assert.equal(store().levels.length, 1);
        assert.deepEqual([store().state.process, store().state.step, store().state.nested], ['main', 'build', undefined]);
        // run-again: the step stays.
        reset();
        assert.equal(store().startNested('branch', 'side', 'run-again', 'user').ok, true);
        assert.equal(store().apply({ completed: true }, 'user').ok, true);
        assert.deepEqual([store().levels.length, store().state.step, store().state.decision, store().state.nestedEnded], [1, 'plan', undefined, undefined]);
        // ask: the decision Go on / Run the step again.
        reset();
        assert.equal(store().startNested('subprocess', 'sub', 'ask', 'user').ok, true);
        assert.equal(store().apply({ completed: true }, 'user').ok, true);
        assert.deepEqual(store().state.nestedEnded, { process: 'sub', kind: 'subprocess', outcome: 'finished' });
        const decide = decisionAt(store().currentDefinition(), store().state)!;
        assert.deepEqual(decide.options.map((o) => [o.kind, o.level, o.label]), [
            ['finish', undefined, 'The subprocess sub finished — go on to Build'],
            ['repeat', 'step', 'Run the step Plan again'],
        ]);
        assert.deepEqual(store().moves().filter((m) => !m.branchOption).map((m) => m.label), ['Decide…'], 'no Skip / Back at this decision');
        assert.match(decisionDialog(store().currentDefinition()!, store().state)!.detail, /^The subprocess sub finished\. Go on past the step, or run it again/);
        const view = fs.readFileSync(path.join(EXT_ROOT, 'media', 'processPanel', 'main.js'), 'utf8');
        assert.match(view, /!\(c\.state\.decision \|\| c\.state\.nestedEnded\)/, 'the view shows it as a decision');
        assert.equal(store().move('repeat', 'step', 'user').ok, true);
        assert.deepEqual([store().state.step, store().state.nestedEnded], ['plan', undefined], 'run again: the step, the decision gone');
        reset();
        assert.equal(store().startNested('subprocess', 'sub', 'ask', 'user').ok, true);
        assert.equal(store().apply({ completed: true }, 'user').ok, true);
        assert.equal(store().move('finish', undefined, 'user').ok, true);
        assert.deepEqual([store().state.step, store().state.nestedEnded], ['build', undefined], 'go on');
    });

    test('NP-5: abort', async () => {
        reset();
        assert.equal(store().startNested('branch', 'side', 'ask', 'user').ok, true);
        const no = ui(undefined, 'ask', false);
        assert.equal(await abortNestedProcess(store(), no.u), false);
        assert.match(no.shown.confirms[0], /^Abort the branch side\?$/);
        assert.equal(store().levels.length, 2, 'not confirmed: still running');
        const yes = ui(undefined, 'ask', true);
        assert.equal(await abortNestedProcess(store(), yes.u), true);
        assert.equal(store().levels.length, 1);
        assert.deepEqual(store().state.nestedEnded, { process: 'side', kind: 'branch', outcome: 'aborted' });
        const journal = fs.readFileSync(path.join(WS, '_ai', 'quests', QUEST, `decisions.${QUEST}.md`), 'utf8');
        assert.match(journal, /^# Decisions — q1/);
        assert.match(journal, /## \d{4}-[^\n]+ — aborted the branch side\n\n- \*\*Stood at:\*\* [^\n]+\n- \*\*Started from:\*\* main › [^\n]*Plan[^\n]*\n- \*\*Follow-up:\*\* Ask me at the end/);
        const none = ui(undefined);
        assert.equal(await abortNestedProcess(store(), none.u), false);
        assert.match(none.shown.infos[0], /No subprocess or branch is running/);
    });

    test('NP-6: the queue', async () => {
        reset();
        const parent = await confirmProcessAction('proceed', undefined, '');
        assert.deepEqual([parent.ok, parent.ok && parent.queued], [true, true], JSON.stringify(parent));
        const [parentPrompt, parentMarker] = queue().items;
        assert.equal(parentMarker.processRun?.level, 0);
        assert.equal(store().startNested('subprocess', 'sub', 'ask', 'user').ok, true);
        assert.equal(queue().stepRunProgress(QUEST, 1), undefined, 'the new level runs nothing yet');
        const child = await confirmProcessAction('proceed', undefined, '');
        assert.equal(child.ok, true, JSON.stringify(child));
        const ids = queue().items.map((i) => i.id);
        assert.deepEqual(ids.slice(0, 2), [parentPrompt.id, parentMarker.id], 'behind the step below\'s items');
        const childMarker = queue().items[3];
        assert.equal(childMarker.processRun?.level, 1);
        // The queue reaches the step below's marker: it moves nothing while the level above runs.
        set(parentPrompt.id, 'sent');
        await queue().sendNext();
        assert.equal(queue().getById(parentMarker.id)?.status, 'sent');
        assert.deepEqual(store().levels.map((l) => l.step), ['plan', 'work'], 'nothing moved');
        set(queue().items[2].id, 'sent');
        await queue().sendNext();
        assert.deepEqual(store().levels.map((l) => [l.step, l.decision]), [['plan', undefined], ['sg', undefined]], 'the new level moved');
        for (const i of [...queue().items]) { queue().remove(i.id); }
    });

    test('NP-7: switching the process; the file', () => {
        reset();
        assert.equal(store().startNested('subprocess', 'sub', 'ask', 'user').ok, true);
        assert.equal(store().apply({ process: 'side' }, 'user').ok, true);
        assert.deepEqual(store().levels.map((l) => [l.process, l.nested]), [['side', undefined]], 'every level left');
        const text = stringifyProcessStateStack({ levels: [
            { process: 'a', phase: 'p', phaseIteration: 1, step: 's', stepIteration: 1, substep: '', substepIteration: 1, completed: false, nestedEnded: { process: 'b', kind: 'branch', outcome: 'aborted' } },
            { process: 'b', phase: 'p', phaseIteration: 1, step: 's', stepIteration: 2, substep: '', substepIteration: 1, completed: false, nested: { kind: 'branch', followUp: 'run-again', startedAt: '2026-11-10T00:00:00.000Z' } },
        ] }, 'now');
        const back = parseProcessStateStack(text).levels;
        assert.deepEqual(back[0].nestedEnded, { process: 'b', kind: 'branch', outcome: 'aborted' });
        assert.deepEqual(back[1].nested, { kind: 'branch', followUp: 'run-again', startedAt: '2026-11-10T00:00:00.000Z' });
        const io = parseProcessStateStack(stringifyProcessStateStack({ levels: [
            { ...back[0], subOutputs: { iosub: { result: 'r.md' } } },
            { ...back[1], inputs: { doc: 'a.md' }, outputs: { result: 'r.md' } },
        ] }, 'now')).levels;
        assert.deepEqual([io[0].subOutputs, io[1].inputs, io[1].outputs], [{ iosub: { result: 'r.md' } }, { doc: 'a.md' }, { result: 'r.md' }], 'inputs, outputs and handed-back outputs survive the file');
    });

    test('NP-8: declarations, mappings, schema', () => {
        const def = parseProcessYaml(fs.readFileSync(path.join(WS, '_ai/processes/iosub/iosub.process.yaml'), 'utf8'));
        assert.deepEqual(def.errors, []);
        const text = stringifyProcessDefinition(def.definition!);
        assert.match(text, /inputs:\n\s+- name: doc\n\s+kind: document\n\s+description: the document to review\n\s+required: true/);
        assert.match(text, /outputs:\n[\s\S]*- name: report\n\s+value: \$\{input\.folder\}\/report\.md/);
        assert.match(stringifyProcessDefinition(parseProcessYaml(fs.readFileSync(path.join(WS, '_ai/processes/main/main.process.yaml'), 'utf8')).definition!), /- process: iosub\n\s+inputs:\n\s+doc: docs\/\$\{step\}\.md/);
        const bad = parseProcessYaml([
            'id: x',
            'inputs: [{name: a, kind: file}, {name: a}, {name: b, value: v}, {kind: folder}]',
            'outputs: [{name: o, required: yes, extra: 1}]',
            'phases:', '  - id: p', '    steps:', '      - id: s', '        subprocesses: [{process: y, inputs: [a]}, {process: z, inputs: {"bad name": v, ok: 1}}]', '    gate: {id: g}',
        ].join('\n'));
        assert.deepEqual(bad.errors.map((e) => e.path).sort(), [
            'inputs[0].kind', 'inputs[1].name', 'inputs[2].value', 'inputs[3].name',
            'outputs[0].extra', 'outputs[0].required',
            'phases[0].steps[0].subprocesses[0].inputs', 'phases[0].steps[0].subprocesses[1].inputs.bad name', 'phases[0].steps[0].subprocesses[1].inputs.ok',
        ].sort(), JSON.stringify(bad.errors));
        const schema = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'src', 'config', 'process.schema.json'), 'utf8'));
        assert.deepEqual(Object.keys(schema.properties).slice(0, 6), ['id', 'name', 'summary', 'session', 'inputs', 'outputs']);
        assert.ok(schema.properties.outputs.items.properties.value);
        assert.equal(schema.properties.inputs.items.properties.value, undefined, 'a default only on outputs');
        assert.equal(schema.$defs.processList.items.oneOf[1].properties.inputs.additionalProperties.type, 'string');
        const target = def.definition!;
        assert.deepEqual(fillNestedInputs(target, { process: 'iosub', inputs: { doc: ' a.md ', folder: '' } }, (t) => t), { ok: true, inputs: { doc: 'a.md' } });
        assert.match((fillNestedInputs(target, { process: 'iosub', inputs: { doc: 'a', nope: 'x' } }, (t) => t) as Json).error, /fills "nope", which iosub does not declare/);
        assert.match((fillNestedInputs(target, { process: 'iosub' }, (t) => t) as Json).error, /input "doc" of iosub is required, and the step does not fill it/);
        assert.match((fillNestedInputs(target, { process: 'iosub', inputs: { doc: '${x}' } }, () => '') as Json).error, /fills it with an empty value/);
    });

    test('NP-9: a start fills the inputs', async () => {
        reset();
        const { u, shown } = ui({ kind: 'subprocess', process: 'iosub' }, 'go-on');
        assert.equal(await startNestedProcess(store(), u), true, JSON.stringify(shown));
        assert.deepEqual(store().state.inputs, { doc: 'docs/plan.md', folder: 'out' }, 'resolved at the starting position');
        const vars = store().variables();
        assert.deepEqual([vars['input.doc'], vars['input.folder']], ['docs/plan.md', 'out']);
        const block = store().contextBlock();
        assert.match(block, /Started as a \*\*subprocess\*\* from the step of the process below it/);
        assert.match(block, /Inputs: `\$\{input\.doc\}` \(document\) = docs\/plan\.md; `\$\{input\.folder\}` \(folder\) = out/);
        assert.match(block, /Outputs to hand back: `result` \(document\), required — not set; `report` — default: \$\{input\.folder\}\/report\.md\. Set them with `tomAi_setProcessState/);
    });

    test('NP-10: outputs', async () => {
        // (continues from NP-9: iosub runs above main › plan)
        const set = async (input: Json): Promise<Json> => JSON.parse(await SET_PROCESS_STATE_TOOL.execute(input));
        assert.match((await set({ outputs: { nope: 'x' } })).error, /declares no output "nope"/);
        const finishEarly = store().apply({ completed: true }, 'user');
        assert.equal(finishEarly.ok, false);
        assert.match(!finishEarly.ok ? finishEarly.error : '', /cannot finish: its required output\(s\) "result" are not set/);
        assert.equal(store().levels.length, 2, 'still running');
        const run = await confirmProcessAction('proceed', undefined, '');
        assert.equal(run.ok, true, JSON.stringify(run));
        const marker = queue().items.find((i) => i.processMove)!;
        const r = await set({ outputs: { result: 'review/consolidated.md' } });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.processMoveMarkersRemoved, undefined);
        assert.ok(queue().getById(marker.id), 'the running step\'s marker is kept');
        for (const i of [...queue().items]) { queue().remove(i.id); }
        assert.match(store().contextBlock(), /`result` \(document\), required — set: review\/consolidated\.md/);
        assert.equal((await set({ completed: true })).ok, true);
        assert.equal(store().levels.length, 1);
        assert.deepEqual(store().state.subOutputs, { iosub: { result: 'review/consolidated.md', report: 'out/report.md' } }, 'handed back, the default filled');
        assert.equal(store().state.step, 'build', 'go-on');
        const vars = store().variables();
        assert.deepEqual([vars['sub.iosub.result'], vars['sub.iosub.report'], vars['input.doc']], ['review/consolidated.md', 'out/report.md', undefined]);
        assert.match(store().contextBlock(), /Outputs handed back by subprocesses: `\$\{sub\.iosub\.result\}` = review\/consolidated\.md/);
        assert.match((await set({ outputs: { result: 'x' } })).error, /outputs belong to a subprocess or branch/);
        reset();
        assert.equal(store().startNested('subprocess', 'iosub', 'run-again', 'user', { doc: 'd.md' }).ok, true);
        assert.equal(store().apply({ outputs: { result: 'r.md' } }, 'user').ok, true);
        assert.equal(store().abortNested('user').ok, true);
        assert.equal(store().state.subOutputs, undefined, 'aborted: nothing handed back');
    });

    test('NP-11: the process editor', async () => {
        const html = fs.readFileSync(path.join(EXT_ROOT, 'media', 'processEditor', 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        try {
            const posted: Json[] = [];
            w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => undefined });
            w.__INIT__ = {};
            w.eval(fs.readFileSync(path.join(EXT_ROOT, 'media', 'processEditor', 'main.js'), 'utf8'));
            const fire = (data: Json): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
            fire({ type: 'list', processes: [{ id: 'x', valid: true }], roles: [], currentProcess: '' });
            fire({ type: 'load', id: 'x', definition: { id: 'x', phases: [{ id: 'p', steps: [{ id: 's' }], gate: { id: 'g' } }] }, description: '', errors: [], files: { definition: 'x.process.yaml', description: 'x.md' } });
            const doc = w.document;
            doc.querySelector('[data-op="add-input"]').click();
            doc.querySelector('[data-op="add-output"]').click();
            doc.querySelector('[data-op="add-output"]').click();
            const field = (p: string): Json => doc.querySelector(`[data-path="${p}"]`);
            const type = (p: string, value: string): void => { const f = field(p); f.value = value; f.dispatchEvent(new w.Event(f.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
            type('inputs.0.name', 'documents');
            type('inputs.0.kind', 'documents');
            field('inputs.0.required').checked = true;
            field('inputs.0.required').dispatchEvent(new w.Event('change', { bubbles: true }));
            type('outputs.0.name', 'consolidated');
            type('outputs.0.value', '${input.documents}/merged.md');
            doc.querySelector('[data-op="remove"][data-path="outputs.1"]').click();
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            const save = posted.filter((m) => m.type === 'save').pop();
            assert.ok(save, JSON.stringify(posted.map((m) => m.type)));
            assert.deepEqual([save.definition.inputs, save.definition.outputs], [[{ name: 'documents', kind: 'documents', required: true }], [{ name: 'consolidated', value: '${input.documents}/merged.md' }]]);
            doc.querySelector('[data-op="remove"][data-path="inputs.0"]').click();
            doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
            assert.equal(posted.filter((m) => m.type === 'save').pop().definition.inputs, undefined, 'an empty list is dropped');
        } finally {
            w.close();
        }
    });
});

