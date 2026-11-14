/**
 * Decision steps (vscimpb95) through the real process store, chat variables and queue: a step with `decision:`
 * chooses where the process goes when the step before it has finished — automatically from chat variables (`auto`),
 * by the user in the Decide… dialog (`user`) or by the agent (`judge`, tomAi_setProcessState `decide`). The jumps
 * go across phases with the iterations counted on, into the state file and the decisions journal.
 *
 *   DSQ-1 auto: with `fast` = no the step after Draft's decision is passed straight to P2 (recorded, journalled);
 *         Proceed at the decision step itself queues nothing; with `fast` unset it stops at the decision
 *   DSQ-2 user: Choose's decision offers its targets (Decide…, the reopenDecision labels); Redo the draft goes back
 *         to P1 at its next iteration, and P2 after it counts on too
 *   DSQ-3 judge: Proceed queues the step's prompt; the agent's `decide` inside the run is recorded and taken when the
 *         run ends; without a running Proceed it jumps at once; an unknown target is refused with the targets
 *   DSQ-4 tomAi_validateProcess knows decision steps (a missing target is a rules finding); the PROCESS view shows the
 *         jumps and the decision step; the editor has its block; the tool documents `decide`
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb95_decision-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/branchy/branchy.process.yaml', [
    'id: branchy', 'name: Branchy', 'phases:',
    '  - id: p1', '    name: P1', '    repeatable: true', '    steps:',
    '      - id: draft', '        name: Draft', '        repeatable: true', '        prompt: Draft it.',
    '      - id: route', '        name: Route', '        decision:', '          mode: auto', '          targets:',
    '            - to: p3/ship', '              label: Straight to shipping', '              when: { var: fast, equals: "yes" }',
    '            - to: p2', '              label: To the review', '              when: { var: fast, equals: "no" }',
    '    gate: { id: g1, name: G1 }',
    '  - id: p2', '    name: P2', '    repeatable: true', '    steps:',
    '      - id: review', '        name: Review', '        prompt: Review it.',
    '      - id: choose', '        name: Choose', '        decision:', '          targets:',
    '            - to: p1/draft', '              label: Redo the draft', '            - to: p3', '              label: Ship it',
    '    gate: { id: g2, name: G2 }',
    '  - id: p3', '    name: P3', '    steps:',
    '      - id: prep', '        name: Prep', '        repeatable: true', '        prompt: Prepare.',
    '      - id: ship', '        name: Ship', '        prompt: Ship it.',
    '      - id: judgeit', '        name: Judge it', '        prompt: Look at the build.', '        decision:', '          mode: judge', '          targets:',
    '            - to: prep', '              label: Prepare again', '              when: { judge: the build failed }',
    '            - to: g3',
    '    gate: { id: g3, name: G3 }', '',
].join('\n'));
put('_ai/processes/branchy/branchy.md', '# branchy\n');
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
import { SET_PROCESS_STATE_TOOL } from '../quest-process-tools.js';
import { checkProcessDraft } from '../process-write-tools.js';
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
const chat = (): ChatVariablesStore => ChatVariablesStore.instance;
const stateOf = () => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, 'default');
const journal = (): string => { const f = path.join(WS, '_ai', 'quests', QUEST, `decisions.${QUEST}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
const where = (): string => { const s = stateOf(); return `${s.phase}#${s.phaseIteration}/${s.step}#${s.stepIteration}${s.decision ? ' (decision)' : ''}`; };
const setVar = (name: string, value: string): void => { chat().set(name, value, 'user'); };
const ok = (r: { ok: boolean }): void => { assert.equal(r.ok, true, JSON.stringify(r)); };
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');

describe('decision steps', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        queue().setRunQueueSettings('default', { autoSend: false, defaultTransport: 'anthropic' });
        ok(store().apply({ process: 'branchy' }, 'user'));
        assert.equal(where(), 'p1#1/draft#1');
    });

    test('DSQ-1: automatic', async () => {
        setVar('fast', 'no');
        ok(store().move('skip', undefined, 'user'));
        assert.equal(where(), 'p1#1/draft#1 (decision)');
        ok(await confirmProcessAction('finish', undefined, ''));
        assert.equal(where(), 'p2#1/review#1', 'Route decided on entry');
        const jump = stateOf().jumps!.at(-1)!;
        assert.deepEqual([jump.from.step, jump.to.phase, jump.label, jump.by, jump.reason], ['route', 'p2', 'To the review', 'condition', '`fast` is `no` holds']);
        assert.match(journal(), /## \S+ — decision step: To the review\n\n- \*\*From:\*\* branchy › p1 #1 › route #1\n- \*\*To:\*\* branchy › p2 #1 › review #1\n- \*\*By:\*\* the extension \(its condition held\) — `fast` is `no` holds\n/);
        // At the decision step itself: Proceed decides at once and queues nothing.
        ok(store().apply({ phase: 'p1', step: 'route' }, 'user'));
        setVar('fast', '');
        const before = queue().items.length;
        const proceeded = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceeded.ok && proceeded.queued, false, JSON.stringify(proceeded));
        assert.equal(queue().items.length, before, 'nothing queued');
        assert.equal(where(), 'p1#1/route#1 (decision)', 'fast unset: the user decides');
        assert.deepEqual(decisionOptionLabels(), ['Straight to shipping', 'To the review']);
    });

    test('DSQ-2: the user decides; back across phases, counted on', async () => {
        ok(await takeDecisionOption('To the review'));
        assert.equal(where(), 'p2#2/review#1', 'P2 ran once already (DSQ-1): its next iteration');
        ok(store().move('skip', undefined, 'user'));
        assert.equal(where(), 'p2#2/choose#1 (decision)');
        assert.deepEqual(decisionOptionLabels(), ['Redo the draft', 'Ship it']);
        ok(await takeDecisionOption('Redo the draft'));
        assert.equal(where(), 'p1#2/draft#1', 'P1 at its next iteration');
        assert.match(journal(), /— decision step: Redo the draft\n\n- \*\*From:\*\* branchy › p2 #2 › choose #1\n- \*\*To:\*\* branchy › p1 #2 › draft #1\n- \*\*By:\*\* the user\n/);
        setVar('fast', 'no');
        ok(store().move('skip', undefined, 'user'));
        ok(await confirmProcessAction('finish', undefined, ''));
        assert.equal(where(), 'p2#3/review#1', 'P2 after it counts on as well');
    });

    test('DSQ-3: the agent judges', async () => {
        ok(store().apply({ phase: 'p3' }, 'user'));
        ok(store().apply({ step: 'judgeit' }, 'user'));
        const proceeded = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceeded.ok && proceeded.queued, true, 'judge: the step\'s prompt is queued');
        // Inside the run: recorded, taken when the run ends (the marker's Proceed).
        ok(store().decide('Prepare again', 'the build failed', true, 'anthropic'));
        assert.deepEqual(stateOf().decide, { target: 0, reason: 'the build failed' });
        assert.equal(where(), 'p3#1/judgeit#1');
        ok(store().move('proceed', undefined, 'anthropic'));
        assert.equal(where(), 'p3#1/prep#2', 'prep ran once in this phase iteration (it was left for judgeit): its next iteration');
        const jump = stateOf().jumps!.at(-1)!;
        assert.deepEqual([jump.by, jump.reason, jump.label], ['agent', 'the build failed', 'Prepare again']);
        assert.equal(stateOf().decide, undefined);
        // Without a running Proceed the tool jumps at once; an unknown target is refused.
        ok(store().apply({ step: 'judgeit' }, 'user'));
        const refused = JSON.parse(await SET_PROCESS_STATE_TOOL.execute({ decide: 'Somewhere' }));
        assert.equal(refused.ok, false);
        assert.match(refused.error, /no target "Somewhere"; its targets: "Prepare again" \(prep\), "Go to G3" \(g3\)/);
        const jumped = JSON.parse(await SET_PROCESS_STATE_TOOL.execute({ decide: 'g3', reason: 'the build is green' }));
        assert.equal(jumped.ok, true, JSON.stringify(jumped));
        assert.equal(jumped.jumped.label, 'Go to G3');
        assert.equal(where(), 'p3#1/g3#1');
        assert.equal(JSON.parse(await SET_PROCESS_STATE_TOOL.execute({ decide: 'g3' })).ok, false, 'not at a decision step');
        assert.equal(JSON.parse(await SET_PROCESS_STATE_TOOL.execute({ decide: 'g3', step: 'prep' })).ok, false, '`decide` goes alone');
    });

    test('DSQ-4: the validator, the view, the editor and the tool know it', () => {
        const yaml = fs.readFileSync(path.join(WS, '_ai/processes/branchy/branchy.process.yaml'), 'utf8');
        const deps = { workspaceRoot: WS, processesDir: path.join(WS, '_ai', 'processes'), rolesDir: path.join(WS, '_ai', 'roles'), write: () => ({ ok: true }) };
        assert.deepEqual(checkProcessDraft(deps as never, { yaml }).findings, []);
        const broken = checkProcessDraft(deps as never, { yaml: yaml.replace('to: p1/draft', 'to: p1/nothing') });
        assert.deepEqual(broken.findings.map((f) => `${f.source} ${f.path}`), ['rules phases[1].steps[1].decision.targets[0].to']);
        const handler = EXT('src', 'handlers', 'processPanel-handler.ts');
        assert.match(handler, /jumps: \(state\.jumps \?\? \[\]\)\.slice\(-8\)\.reverse\(\)/);
        const view = EXT('media', 'processPanel', 'main.js');
        assert.match(view, /function jumpsBox\(items\)/);
        assert.match(view, /html \+= jumpsBox\(c\.jumps\);/);
        assert.match(view, /html \+= decisionStepNote\(step\);/);
        assert.match(view, /e\.step\.decision \? 'Decision: '/);
        const editor = EXT('media', 'processEditor', 'main.js');
        assert.match(editor, /function decisionBlock\(path, step\)/);
        assert.match(editor, /case 'make-decision':/);
        assert.match(editor, /case 'add-target':/);
        const props = (SET_PROCESS_STATE_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
        assert.ok(props.decide && props.reason);
        assert.match(SET_PROCESS_STATE_TOOL.description, /`decide` \(with `reason`, alone\)/);
    });
});
