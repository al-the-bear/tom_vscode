/**
 * Follow-up processes (vscimpb47) through the real process store, action service and tools under the vscode stub.
 *
 *   FS-1 in a run: at the decision after the phase's gate, Decide offers "Continue in …"; taking it moves the run's
 *        position (its own state file) to the target process, phase and step — the quest's own position stays —
 *        with the origin recorded (carried variables' values, the call context resolved against the run's chat
 *        variables); the run's chat variables stay; the follow-up's prompts see `${process-origin}` and
 *        `${origin.<name>}`; the decisions journal records the switch; the PROCESS view's state lists the origins
 *   FS-2 tomAi_validateProcess: a follow-up to a process, phase or step that does not exist is a finding; with
 *        existing targets the draft is valid
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys, chat-variable names */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb47_followups-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
const CHANGE = [
    'id: change', 'name: Spec Change', 'phases:', '  - id: intent', '    name: Intent',
    '    followUps:', '      - process: specs', '        phase: p2', '        step: draft',
    '        carry:', '          - change', '        context:', '          scope: ${change} (intent)',
    '    steps:', '      - id: capture', '    gate:', '      id: gate1', '',
].join('\n');
const SPECS = [
    'id: specs', 'name: Specs', 'phases:', '  - id: p1', '    steps:', '      - id: s1', '    gate:', '      id: g1',
    '  - id: p2', '    name: Phase 2', '    steps:', '      - id: prep', '      - id: draft', '        name: Draft', '    gate:', '      id: g2', '',
].join('\n');
put('_ai/processes/change/change.process.yaml', CHANGE);
put('_ai/processes/change/change.md', '# change\n');
put('_ai/processes/specs/specs.process.yaml', SPECS);
put('_ai/processes/specs/specs.md', '# specs\n');
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
import { ProcessRepository } from '../../utils/processRepository.js';
import { DEFAULT_RUN } from '../../utils/processRuns.js';
import { resolveVariables } from '../../utils/variableResolver.js';
import { validateProcessImpl, type ProcessWriteDeps } from '../process-write-tools.js';

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
const repo = (): ProcessRepository => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests'));

describe('follow-up processes: the store', () => {
    test('FS-1: a follow-up taken in a run', async () => {
        await ProcessStateStore.ready;
        PromptQueueManager.instance.autoSendEnabled = false;
        assert.equal(store().apply({ process: 'specs' }, 'user').ok, true, 'the quest\'s own position: elsewhere');
        assert.equal(store().createRun('chg7', 'change', 'user', true).ok, true);
        const chat = ChatVariablesStore.instance;
        chat.set('change', 'CHG-7', 'user');
        assert.equal(store().apply({ step: 'gate1' }, 'user').ok, true);
        assert.equal(store().move('proceed', undefined, 'user').ok, true, 'to the decision after the gate');
        const labels = decisionOptionLabels();
        assert.deepEqual(labels, ['Gate passed — finish the process', 'Gate failed — run gate1 again', 'Gate failed — back to the start of the current phase (Intent)', 'Gate passed — Continue in Specs › Phase 2 › Draft']);
        const taken = await takeDecisionOption(labels[3]);
        assert.equal(taken.ok, true, JSON.stringify(taken));
        // The run moved, into its own state file; the quest's own position did not.
        const run = repo().readState(QUEST, 'chg7');
        assert.deepEqual([run.process, run.phase, run.step, run.decision], ['specs', 'p2', 'draft', undefined]);
        assert.equal(repo().readState(QUEST, DEFAULT_RUN).phase, 'p1');
        assert.deepEqual(run.origins?.map((o) => [o.process, o.phase, o.step, o.level, o.carried, o.context]), [
            ['change', 'intent', 'gate1', 'phase', { change: 'CHG-7' }, { scope: 'CHG-7 (intent)' }],
        ]);
        assert.match(fs.readFileSync(path.join(QDIR, `process-state.${QUEST}.chg7.yaml`), 'utf8'), /origins:\n\s+- process: change/);
        // The run's chat variables stay; the follow-up's prompts read where it came from.
        assert.equal(chat.getRaw('change'), 'CHG-7');
        const vars = store().variables();
        assert.deepEqual([vars['process-origin'], vars['origin.scope'], vars.process, vars.step], ['change/intent', 'CHG-7 (intent)', 'specs', 'draft']);
        assert.equal(resolveVariables('${process-origin}: ${origin.scope}'), 'change/intent: CHG-7 (intent)');
        // The journal.
        const journal = fs.readFileSync(path.join(QDIR, `decisions.${QUEST}.md`), 'utf8');
        assert.match(journal, /— continued in the follow-up process specs\n\n- \*\*From:\*\* change › .*\(the phase's follow-up\)\n- \*\*To:\*\* specs › .*Draft\n- \*\*Run:\*\* chg7\n- \*\*Carried:\*\* `change` = CHG-7\n- \*\*Call context:\*\* `scope` = CHG-7 \(intent\)/);
        // The PROCESS view's state lists the origins.
        const panel = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'processPanel-handler.ts'), 'utf8');
        assert.match(panel, /origins: \(state\.origins \?\? \[\]\)\.map\(\(o\) => \{/);
        assert.match(panel, /to: m\.kind === 'follow-up'/);
        // Back in the change process by hand: a process set by hand starts without the chain.
        assert.equal(store().apply({ process: 'change' }, 'user').ok, true);
        assert.equal(store().state.origins, undefined);
        store().selectRun(DEFAULT_RUN);
    });

    test('FS-2: tomAi_validateProcess checks the targets', async () => {
        const deps: ProcessWriteDeps = {
            workspaceRoot: WS, processesDir: path.join(WS, '_ai', 'processes'), rolesDir: path.join(WS, '_ai', 'roles'),
            processOf: (id) => store().entry(id)?.definition ?? undefined,
            write: () => ({ ok: true }),
        };
        const draft = (followUp: string): string => [
            'id: draft', 'followUps:', followUp, 'phases:', '  - id: a', '    steps:', '      - id: b', '    gate:', '      id: g', '',
        ].join('\n');
        const check = async (followUp: string) => JSON.parse(await validateProcessImpl(deps, { yaml: draft(followUp) }));
        const ok = await check('  - process: specs\n    phase: p2\n    step: draft');
        assert.equal(ok.valid, true, JSON.stringify(ok.findings));
        const missing = await check('  - process: nope');
        assert.equal(missing.valid, false);
        assert.deepEqual(missing.findings.map((f: { source: string; path: string }) => [f.source, f.path]), [['rules', 'followUps[0].process']]);
        assert.match((await check('  - process: specs\n    phase: p2\n    step: zz')).findings[0].message, /has no step "zz"/);
    });
});
