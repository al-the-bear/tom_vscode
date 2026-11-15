/**
 * What a process run works on (vscimpb118): the run's `process-subject` chat variable, set by a process's first
 * step and shown by the extension. Through the real process store and chat variables; the window works on
 * `default`, `r2` is another run of the same process.
 *
 *   PS-1 the context line: "Working on: <subject>" when the run names it; "not named yet" with the instruction
 *        to set it when the process declares `process-subject` in its runParameters; nothing otherwise
 *   PS-2 the store: each run's subject in `runs()` and `subjectOf(run)`, from the run's own variables; the system
 *        prompt's process context of the window's run; tomAi_listProcessRuns answers it; Reset Process clears it
 *        (a declared run parameter)
 *   PS-3 the Run selects name it after the run (chatRunOptions), and the chat panel passes the subjects
 *   PS-4 the views: the PROCESS view's run list and its "Working on" row, the Proceed page's row
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261115_vscimpb118_subject-')));
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
    'id: des', 'name: Design', 'runParameters: [process-subject, design]', 'phases:', '  - id: p1', '    steps:',
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
import { installProcessMoveMarkers, resetProcessRun } from '../../services/processActionService.js';
import { LIST_PROCESS_RUNS_TOOL } from '../quest-process-tools.js';
import { PROCESS_SUBJECT_VARIABLE, declaresProcessSubject, parseProcessYaml, subjectContextLines } from '../../utils/processDefinition.js';
import { chatRunOptions } from '../../utils/chatPanelRuns.js';

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
const setVars = (run: string, vars: Record<string, string>): void => chat().withRun(run, () => { for (const [k, v] of Object.entries(vars)) { chat().set(k, v, 'user'); } });
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');

describe('the run\'s subject (process-subject)', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        for (const r of ['default', 'r2']) { queue().setRunQueueSettings(r, { autoSend: false, defaultTransport: 'anthropic' }); }
        assert.equal(store().apply({ process: 'des' }, 'user').ok, true);
        assert.equal(store().createRun('r2', 'des', 'user', false).ok, true);
        assert.equal(store().currentRun, 'default');
    });

    test('PS-1: the context line', () => {
        assert.equal(PROCESS_SUBJECT_VARIABLE, 'process-subject');
        const declared = parseProcessYaml(fs.readFileSync(path.join(WS, '_ai/processes/des/des.process.yaml'), 'utf8')).definition!;
        const plain = { ...declared, runParameters: ['design'] };
        assert.equal(declaresProcessSubject(declared), true);
        assert.equal(declaresProcessSubject(plain), false);
        assert.deepEqual(subjectContextLines(declared, 'Revision of tom_specs'), ['Working on: Revision of tom_specs (`${process-subject}`)']);
        assert.deepEqual(subjectContextLines(plain, 'Revision of tom_specs'), ['Working on: Revision of tom_specs (`${process-subject}`)'], 'shown whenever the run names it');
        assert.match(subjectContextLines(declared, '  ')[0], /^Working on: not named yet — .*set the run's `process-subject` chat variable .*tomAi_writeChatVariable/);
        assert.deepEqual(subjectContextLines(plain, undefined), [], 'a process that does not declare it: no line');
    });

    test('PS-2: the store, the system prompt, the run list tool, Reset Process', async () => {
        assert.match(store().contextBlock(), /\nWorking on: not named yet/, 'declared, not set');
        assert.equal(store().subjectOf(), undefined);
        setVars('r2', { [PROCESS_SUBJECT_VARIABLE]: 'Change chg3 on tom_uam' });
        setVars('default', { [PROCESS_SUBJECT_VARIABLE]: 'Revision of tom_specs' });
        assert.equal(store().subjectOf('r2'), 'Change chg3 on tom_uam');
        assert.equal(store().subjectOf(), 'Revision of tom_specs');
        const byRun = Object.fromEntries(store().runs().map((r) => [r.run, r.subject]));
        assert.deepEqual(byRun, { default: 'Revision of tom_specs', r2: 'Change chg3 on tom_uam' });
        const block = store().contextBlock();
        assert.match(block, /^Process: \*\*Design\*\* \(`des`\)\nWorking on: Revision of tom_specs \(`\$\{process-subject\}`\)\n/, block);
        const listed = JSON.parse(await LIST_PROCESS_RUNS_TOOL.execute({} as never));
        assert.equal(listed.runs.find((r: { run: string }) => r.run === 'r2').subject, 'Change chg3 on tom_uam');
        assert.match(LIST_PROCESS_RUNS_TOOL.description, /`subject`: what the run works on, its `process-subject` chat variable/);
        const outcome = await resetProcessRun('process', 'r2');
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(store().subjectOf('r2'), undefined, 'a declared run parameter: Reset Process clears it');
        assert.equal(store().subjectOf(), 'Revision of tom_specs', 'the other run keeps its own');
    });

    test('PS-3: the Run selects', () => {
        assert.deepEqual(chatRunOptions(['r2', 'r3'], 'r2', { r2: 'Change chg3 on tom_uam', default: '' }), [
            { run: 'default', label: 'default' },
            { run: 'r2', label: 'r2 — Change chg3 on tom_uam (PROCESS view)' },
            { run: 'r3', label: 'r3' },
        ]);
        assert.deepEqual(chatRunOptions(['r2'], 'default'), [{ run: 'default', label: 'default (PROCESS view)' }, { run: 'r2', label: 'r2' }]);
        const panel = EXT('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(panel, /options: chatRunOptions\(runs, windowRun, subjects\)/);
        assert.match(panel, /e\.key === PROCESS_SUBJECT_VARIABLE\) \{ this\._sendChatRuns\(\); \}/, 'a new subject updates the selects');
    });

    test('PS-4: the PROCESS view and the Proceed page', () => {
        const handler = EXT('src', 'handlers', 'processPanel-handler.ts');
        assert.match(handler, /subject: r\.subject \?\? ''/);
        assert.match(handler, /subject: store\.subjectOf\(\) \?\? '',\s*subjectDeclared: declaresProcessSubject\(entry\?\.definition\)/);
        const view = EXT('media', 'processPanel', 'main.js');
        assert.match(view, /'<span class="run-subject">' \+ esc\(r\.subject\)/);
        assert.match(view, /<label>Working on<\/label>[\s\S]*not named yet/);
        assert.match(EXT('src', 'handlers', 'processAction-handler.ts'), /subject: store\.subjectOf\(\) \?\? ''/);
        assert.match(EXT('media', 'processAction', 'index.html'), /<tr id="subject-row" hidden><th>Working on<\/th><td id="subject"><\/td><\/tr>/);
        assert.match(EXT('media', 'processAction', 'main.js'), /\$\('subject-row'\)\.hidden = !msg\.subject;/);
    });
});
