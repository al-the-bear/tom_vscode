/**
 * Non-linear processes (vscimpb96) through the real process store, chat variables and queue: a phase names the
 * phases that may follow it (`next:`); two branches meet again at Join, one (Solo) ends the process on its own.
 *
 *   NLQ-1 the decision after Start's gate offers only the branch whose condition holds (`way` = beta); taken, Beta and
 *         then Join, the path recorded in the state file; Join's end finishes the process
 *   NLQ-2 tomAi_validateProcess (checkProcessDraft) reports a phase never reached and a phase from which the process
 *         never ends as rules findings
 *   NLQ-3 the PROCESS view shows the flow and the path taken; the editor has the Next phases block and goto
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb96_graph-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
const GRAPH = [
    'id: graph', 'name: Graph', 'phases:',
    '  - id: start', '    name: Start', '    next:',
    '      - { phase: alpha, label: The alpha way, when: { var: way, equals: alpha } }',
    '      - { phase: beta, label: The beta way, when: { var: way, equals: beta } }',
    '      - { phase: solo, label: Alone, when: { var: way, equals: solo } }',
    '    steps: [{ id: s1, name: S1, prompt: Start. }]', '    gate: { id: g, name: Start gate }',
    '  - id: alpha', '    name: Alpha', '    next: [join]', '    steps: [{ id: a1, name: A1, prompt: Alpha. }]', '    gate: { id: g, name: Alpha gate }',
    '  - id: beta', '    name: Beta', '    next: [join]', '    steps: [{ id: b1, name: B1, prompt: Beta. }]', '    gate: { id: g, name: Beta gate }',
    '  - id: solo', '    name: Solo', '    next: []', '    steps: [{ id: o1, name: O1, prompt: Solo. }]', '    gate: { id: g, name: Solo gate }',
    '  - id: join', '    name: Join', '    steps: [{ id: j1, name: J1, prompt: Join. }]', '    gate: { id: g, name: Join gate }', '',
].join('\n');
put('_ai/processes/graph/graph.process.yaml', GRAPH);
put('_ai/processes/graph/graph.md', '# graph\n');
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
import { decisionOptionLabels, installProcessMoveMarkers, takeDecisionOption } from '../../services/processActionService.js';
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

const store = (): ProcessStateStore => ProcessStateStore.instance!;
const chat = (): ChatVariablesStore => ChatVariablesStore.instance;
const stateOf = () => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, 'default');
const where = (): string => { const s = stateOf(); return `${s.phase}#${s.phaseIteration}/${s.step}#${s.stepIteration}${s.decision ? ' (decision)' : ''}${s.completed ? ' (finished)' : ''}`; };
const ok = (r: { ok: boolean }): void => { assert.equal(r.ok, true, JSON.stringify(r)); };
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');
const toGateDecision = (): void => { ok(store().move('skip', undefined, 'user')); ok(store().move('skip', undefined, 'user')); };

describe('non-linear processes', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        PromptQueueManager.instance.autoSendEnabled = false;
        PromptQueueManager.instance.setRunQueueSettings('default', { autoSend: false, defaultTransport: 'anthropic' });
        ok(store().apply({ process: 'graph' }, 'user'));
        assert.equal(where(), 'start#1/s1#1');
    });

    test('NLQ-1: branches by condition, meet again, end', async () => {
        chat().set('way', 'beta', 'user');
        toGateDecision();
        assert.equal(where(), 'start#1/g#1 (decision)');
        assert.deepEqual(decisionOptionLabels().filter((l) => l.startsWith('Gate passed')), ['Gate passed — go on to The beta way']);
        ok(await takeDecisionOption('Gate passed — go on to The beta way'));
        assert.equal(where(), 'beta#1/b1#1');
        toGateDecision();
        ok(await takeDecisionOption('Gate passed — go on to Join › J1'));
        assert.equal(where(), 'join#1/j1#1', 'the branches meet');
        assert.deepEqual(stateOf().phasePath, [{ phase: 'start', phaseIteration: 1 }, { phase: 'beta', phaseIteration: 1 }, { phase: 'join', phaseIteration: 1 }]);
        toGateDecision();
        ok(await takeDecisionOption('Gate passed — finish the process'));
        assert.equal(stateOf().completed, true);
        // Solo ends the process on its own.
        ok(store().apply({ process: '' }, 'user'));
        ok(store().apply({ process: 'graph' }, 'user'));
        chat().set('way', 'solo', 'user');
        toGateDecision();
        ok(await takeDecisionOption('Gate passed — go on to Alone'));
        assert.equal(where(), 'solo#1/o1#1');
        toGateDecision();
        assert.ok(decisionOptionLabels().includes('Gate passed — finish the process'));
        assert.ok(!decisionOptionLabels().some((l) => /go on to/.test(l)), 'nothing follows Solo');
    });

    test('NLQ-2: the validator tool checks the graph', () => {
        const deps = { workspaceRoot: WS, processesDir: path.join(WS, '_ai', 'processes'), rolesDir: path.join(WS, '_ai', 'roles'), write: () => ({ ok: true }) };
        assert.deepEqual(checkProcessDraft(deps as never, { yaml: GRAPH }).findings, []);
        const unreached = checkProcessDraft(deps as never, { yaml: GRAPH.replace("      - { phase: solo, label: Alone, when: { var: way, equals: solo } }\n", '') });
        assert.deepEqual(unreached.findings.map((f) => `${f.source} ${f.path}`), ['rules phases[3]']);
        assert.match(unreached.findings[0].message, /the phase "solo" is never reached/);
        const endless = checkProcessDraft(deps as never, { yaml: GRAPH.replace("    next: []", '    next: [alpha]').replace(/next: \[join\]/g, 'next: [solo]') });
        assert.ok(endless.findings.some((f) => /from the phase "solo" the process never ends/.test(f.message)), JSON.stringify(endless.findings));
        assert.ok(endless.findings.every((f) => f.source === 'rules' && /never ends|never reached/.test(f.message)), JSON.stringify(endless.findings));
    });

    test('NLQ-3: the view shows the flow and the path; the editor has the blocks', () => {
        const handler = EXT('src', 'handlers', 'processPanel-handler.ts');
        assert.match(handler, /flow: entry\?\.definition \? processFlow\(entry\.definition\) : null/);
        assert.match(handler, /path: \(state\.phasePath \?\? \[\]\)/);
        const view = EXT('media', 'processPanel', 'main.js');
        assert.match(view, /function flowBox\(flow, path, current\)/);
        assert.match(view, /html \+= flowBox\(c\.flow, c\.path, c\.state && c\.state\.phase\);/);
        assert.match(view, /Path taken:/);
        const editor = EXT('media', 'processEditor', 'main.js');
        assert.match(editor, /function nextBlock\(path, phase, i\)/);
        assert.match(editor, /\+ nextBlock\(path, phase, i\)/);
        assert.match(editor, /data-path="' \+ path \+ '\.goto"/);
    });
});
