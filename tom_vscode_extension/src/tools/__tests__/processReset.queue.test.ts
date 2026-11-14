/**
 * Reset Run and Reset Process (vscimpb91): src/utils/processReset.ts, ProcessStateStore.resetPlan / resetRun,
 * processActionService.resetProcessRun, tomAi_resetProcess and the PROCESS view's buttons, through the real
 * process store, chat variables and queue. The window works on `default`; `r2` is another run.
 *
 *   PR-1 the plan: Reset Run clears every custom variable and leaves a run other than `default` with no process,
 *        `default` keeps its process; Reset Process clears only the declared run parameters that are set; the
 *        confirmation names what is reset; the journal entry; Reset Process without a process is refused
 *   PR-2 Reset Run of r2 (not the window's run): its stack goes (no process), its open process-move marker goes and
 *        its prompt stays, every custom variable of r2 is cleared, `default`'s are not; the decisions journal records it
 *   PR-3 Reset Run of `default`: its process kept, back at its first position; its custom variables cleared
 *   PR-4 Reset Process of r2: back at the first position of its process, only the declared run parameters cleared
 *   PR-5 tomAi_resetProcess: modes, the default run, a wrong mode, a refusal passed on; registered in the tool lists
 *   PR-6 `runParameters` in a definition: validated (names, twice), kept by the serializer, in the JSON schema, an
 *        editor field in the process editor; the PROCESS view's two buttons post `resetRun` with the mode and the
 *        handler asks first (resetProcessRun with confirm)
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb91_reset-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/des/des.process.yaml', [
    'id: des', 'name: des', 'runParameters: [design, design-mode]', 'phases:', '  - id: p1', '    steps:',
    '      - id: start', '        name: Start', '        prompt: Set up the design.',
    '      - id: work', '        name: Work', '        prompt: Work on it.',
    '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/des/des.md', '# des\n');
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
import { confirmProcessAction, installProcessMoveMarkers, resetProcessRun } from '../../services/processActionService.js';
import { ProcessRepository } from '../../utils/processRepository.js';
import { processResetConfirmation, processResetJournalEntry, processResetLines, processResetPlan, processResetRefused } from '../../utils/processReset.js';
import { RESET_PROCESS_TOOL, QUEST_PROCESS_TOOLS, resetProcessImpl } from '../quest-process-tools.js';
import { parseProcessYaml as parseProcessDefinition, stringifyProcessDefinition as serializeProcessDefinition } from '../../utils/processDefinition.js';
import { AVAILABLE_LLM_TOOLS } from '../../utils/constants.js';
import { CATEGORY_MAP } from '../../utils/toolCategories.js';
import { withTiming } from './_timing.js';

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
const stateOf = (run: string) => new ProcessRepository(path.join(WS, '_ai', 'processes'), path.join(WS, '_ai', 'quests')).readState(QUEST, run);
const customOf = (run: string): Record<string, string> => ({ ...chat().withRun(run, () => chat().custom) });
const setVars = (run: string, vars: Record<string, string>): void => chat().withRun(run, () => { for (const [k, v] of Object.entries(vars)) { chat().set(k, v, 'user'); } });
const journal = (): string => { const f = path.join(WS, '_ai', 'quests', QUEST, `decisions.${QUEST}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');

describe('Reset Run and Reset Process', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        for (const r of ['default', 'r2']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'anthropic' }); }
        assert.equal(store().apply({ process: 'des' }, 'user').ok, true);
        assert.equal(store().createRun('r2', 'des', 'user', false).ok, true);
        assert.equal(store().currentRun, 'default');
    });

    test('PR-1: the plan, the words, the journal entry', () => {
        const custom = { design: 'd1', 'design-mode': 'new', other: 'x' };
        const base = { process: 'des', position: 'p1 › work', custom, runParameters: ['design', 'design-mode', 'design-input'], nestedLevels: 1, markers: 2 };
        const run = processResetPlan({ ...base, mode: 'run', run: 'r2' });
        assert.equal(run.processAfter, '', 'a run other than default: no process');
        assert.deepEqual(run.variables.map((v) => v.name), ['design', 'design-mode', 'other'], 'every custom variable');
        assert.equal(processResetPlan({ ...base, mode: 'run', run: 'default' }).processAfter, 'des', 'default keeps its process');
        const proc = processResetPlan({ ...base, mode: 'process', run: 'r2' });
        assert.equal(proc.processAfter, 'des');
        assert.deepEqual(proc.variables.map((v) => v.name), ['design', 'design-mode'], 'only the declared ones that are set');
        assert.deepEqual(processResetLines(run), [
            'The run follows no process afterwards (it follows des, at p1 › work).',
            '1 running subprocess or branch level of its process stack go.',
            '2 open process-move markers in the prompt queue go (the step\'s prompts stay).',
            'Every custom chat variable of the run is cleared: design = d1, design-mode = new, other = x.',
        ]);
        const dialog = processResetConfirmation(proc);
        assert.equal(dialog.message, 'Reset Process: reset the run r2?');
        assert.equal(dialog.confirm, 'Reset Process');
        assert.match(dialog.detail, /The run goes back to the first position of des \(it stands at p1 › work\)\.[\s\S]*The run parameters the process declares are cleared: design = d1, design-mode = new\.[\s\S]*decisions journal/);
        assert.match(processResetJournalEntry(run, new Date('2026-11-14T16:00:00Z')),
            /^## 2026-11-14T16:00:00\.000Z — Reset Run: run r2\n\n- \*\*Was:\*\* des › p1 › work\n- \*\*Now:\*\* no process\n- \*\*Cleared:\*\* `design` = d1, `design-mode` = new, `other` = x\n- \*\*Levels removed:\*\* 1\n- \*\*Markers removed:\*\* 2\n/);
        assert.match(processResetRefused('process', '', [])!, /follows no process/);
        assert.match(processResetRefused('process', 'des', undefined)!, /could not be read/);
        assert.equal(processResetRefused('run', '', undefined), undefined);
    });

    test('PR-2: Reset Run of r2', async () => {
        setVars('default', { keep: 'yes' });
        setVars('r2', { design: 'd1', 'design-mode': 'new', note: 'n' });
        assert.equal((await confirmProcessAction('proceed', undefined, '', undefined, undefined, 'r2')).ok, true);
        assert.equal(queue().items.filter((i) => i.processRun?.run === 'r2' && i.processMove).length, 1, 'r2\'s marker');
        const outcome = await resetProcessRun('run', 'r2');
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.ok && outcome.markersRemoved, 1);
        assert.equal(stateOf('r2').process, '', 'no process yet');
        assert.deepEqual(customOf('r2'), {}, 'every custom variable of r2 cleared');
        assert.deepEqual(customOf('default'), { keep: 'yes' }, 'default\'s untouched');
        assert.equal(queue().items.filter((i) => i.processRun?.run === 'r2' && i.processMove).length, 0, 'the marker went');
        assert.equal(queue().items.filter((i) => i.processRun?.run === 'r2' && !i.processMove).length, 1, 'the step\'s prompt stays');
        assert.match(journal(), /— Reset Run: run r2\n\n- \*\*Was:\*\* des › p1 › Start[^\n]*\n- \*\*Now:\*\* no process\n- \*\*Cleared:\*\* `design` = d1, `design-mode` = new, `note` = n\n- \*\*Markers removed:\*\* 1/);
        assert.equal(store().currentRun, 'default');
        for (const i of [...queue().items]) { queue().remove(i.id); }
    });

    test('PR-3: Reset Run of default keeps its process', async () => {
        assert.equal(store().apply({ step: 'work' }, 'user').ok, true);
        setVars('default', { design: 'x', keep: 'yes' });
        const outcome = await resetProcessRun('run');
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        const st = stateOf('default');
        assert.deepEqual([st.process, st.phase, st.step], ['des', 'p1', 'start'], 'its process, from its first position');
        assert.deepEqual(customOf('default'), {});
    });

    test('PR-4: Reset Process of r2 clears only the declared run parameters', async () => {
        assert.equal(store().withRun('r2', () => store().apply({ process: 'des', step: 'work' }, 'user')).ok, true);
        setVars('r2', { design: 'd2', 'design-mode': 'revise', note: 'stays' });
        const outcome = await resetProcessRun('process', 'r2');
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.deepEqual([stateOf('r2').process, stateOf('r2').step], ['des', 'start']);
        assert.deepEqual(customOf('r2'), { note: 'stays' }, 'only design and design-mode cleared');
        assert.match(journal(), /— Reset Process: run r2\n\n- \*\*Was:\*\* des › p1 › Work[^\n]*\n- \*\*Now:\*\* des at its first position\n- \*\*Cleared:\*\* `design` = d2, `design-mode` = revise/);
    });

    test('PR-5: tomAi_resetProcess', async () => {
        const calls: Array<[string, string | undefined]> = [];
        const fake = async (mode: 'run' | 'process', run: string | undefined) => { calls.push([mode, run]); return { ok: true as const, mode, run: run ?? 'default', lines: ['x'], markersRemoved: 0 }; };
        const r = JSON.parse(await resetProcessImpl(fake, {}));
        assert.deepEqual(r, { ok: true, mode: 'run', run: 'default', reset: ['x'], markersRemoved: 0 });
        await resetProcessImpl(fake, { mode: 'process', run: ' r2 ' });
        assert.deepEqual(calls, [['run', undefined], ['process', 'r2']]);
        assert.match(JSON.parse(await resetProcessImpl(fake, { mode: 'all' })).error, /`mode` is `run`/);
        const refused = JSON.parse(await resetProcessImpl(async () => ({ ok: false, error: 'the run follows no process' }), { mode: 'process' }));
        assert.deepEqual(refused, { ok: false, error: 'the run follows no process' });
        // The live tool on the real store: r2 back to no process.
        const live = JSON.parse(await withTiming('tomAi_resetProcess:typical', () => RESET_PROCESS_TOOL.execute({ mode: 'run', run: 'r2' }) as Promise<string>));
        assert.equal(live.ok, true, JSON.stringify(live));
        assert.equal(stateOf('r2').process, '');
        assert.match(JSON.parse(await RESET_PROCESS_TOOL.execute({ mode: 'process', run: 'r2' }) as string).error, /follows no process/);
        assert.ok(QUEST_PROCESS_TOOLS.includes(RESET_PROCESS_TOOL));
        assert.equal(RESET_PROCESS_TOOL.requiresApproval, true);
        assert.ok((AVAILABLE_LLM_TOOLS as readonly string[]).includes('tomAi_resetProcess'));
        assert.ok(CATEGORY_MAP.Processes.includes('tomAi_resetProcess'));
    });

    test('PR-6: runParameters in a definition; the view and the editor', () => {
        const yaml = 'id: x\nrunParameters: [design, design-mode]\nphases:\n  - id: p\n    steps:\n      - id: s\n    gate:\n      id: g\n';
        const parsed = parseProcessDefinition(yaml);
        assert.deepEqual(parsed.errors, []);
        assert.deepEqual(parsed.definition?.runParameters, ['design', 'design-mode']);
        assert.match(serializeProcessDefinition(parsed.definition!), /^runParameters:\n {2}- design\n {2}- design-mode\nphases:/m);
        assert.match(JSON.stringify(parseProcessDefinition(yaml.replace('[design, design-mode]', '[design, "no space"]')).errors), /runParameters/);
        assert.match(JSON.stringify(parseProcessDefinition(yaml.replace('[design, design-mode]', '[design, design]')).errors), /named twice/);
        const schema = JSON.parse(EXT('src', 'config', 'process.schema.json'));
        assert.equal(schema.properties.runParameters.type, 'array');
        assert.match(EXT('media', 'processEditor', 'main.js'), /data-path="runParameters" data-kind="list"/);
        const view = EXT('media', 'processPanel', 'main.js');
        assert.match(view, /data-run-reset="process" title="Reset Process:/);
        assert.match(view, /data-run-reset="run" title="Reset Run:/);
        assert.match(view, /post\(\{ type: 'resetRun', mode: btn\.dataset\.runReset \}\);/);
        assert.match(EXT('src', 'handlers', 'processPanel-handler.ts'), /case 'resetRun': \{[\s\S]*resetProcessRun\(msg\.mode === 'process' \? 'process' : 'run', store\.currentRun, \{ confirm: true \}\)/);
    });
});
