/**
 * The Prompt Queue tab's context links open the tab's run, and the editors say which run (vscimpb60c), through the
 * real process store, chat variables store and editor handlers under the vscode stub.
 *
 *   RC-1 a run's context (the queue editor's runContextOf, ProcessStateStore.runOverview): its position, the role its
 *        step names, its own custom chat variables and its state file — another run's differ — read without moving
 *        the window's run or telling listeners
 *   RC-2 the Chat Variables editor opened for a run: the title names it, its state has the run, that run's custom
 *        variables and process position; a variable set there goes to that run only; opened without a run it shows
 *        the window's run
 *   RC-4 the queue editor host: the context links pass the tab's run (Chat Variables, the state file of its
 *        position); the reminder link opens the Status Page's reminder settings; its state carries each run's context
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb60c_runcontext-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/design/design.process.yaml', [
    'id: design', 'name: Design', 'phases:', '  - id: p1', '    name: Phase One', '    steps:',
    '      - id: plan', '        name: Plan', '        role: planner', '      - id: build', '        name: Build', '        role: builder',
    '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/design/design.md', '# Design\n');
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { chatVariablesEditorTitle, openChatVariablesEditor } from '../chatVariablesEditor-handler.js';
import { runContextOf } from '../queueEditor-handler.js';

let context: never;
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    context = {
        subscriptions: [], extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
})();
after(() => {
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const chat = (): ChatVariablesStore => ChatVariablesStore.instance;
const panels = (): Json[] => (vscodeStub.stub.window as Json).__webviewPanels;
const lastState = (panel: Json, type: string): Json => [...panel.webview.__posted].reverse().find((m: Json) => m.type === type);

describe('the context of a Prompt Queue tab\'s run', () => {
    test('setup: two runs at different positions, each with its own chat variable', async () => {
        await ProcessStateStore.ready;
        assert.equal(store().apply({ process: 'design' }, 'user').ok, true);
        assert.equal(store().createRun('r2', 'design', 'user', false).ok, true);
        assert.equal((store().withRun('r2', () => store().apply({ process: 'design', phase: 'p1', step: 'build' }, 'user')) as Json).ok, true);
        chat().set('mode', 'fast', 'user');
        chat().withRun('r2', () => chat().set('mode', 'careful', 'user'));
        assert.equal(store().currentRun, 'default');
    });

    test('RC-1: a run\'s context', () => {
        let fired = 0;
        const sub = store().onDidChange(() => { fired++; });
        const d = runContextOf('default');
        const r2 = runContextOf('r2');
        sub.dispose();
        assert.equal(fired, 0, 'read without telling listeners');
        assert.equal(store().currentRun, 'default', 'the window\'s run is not moved');
        assert.match(d.position, /Plan/);
        assert.match(r2.position, /Build/);
        assert.deepEqual([d.role, r2.role], ['planner', 'builder'], 'the role each step names');
        assert.deepEqual([d.variables.mode, r2.variables.mode], ['fast', 'careful'], 'each run\'s own chat variables');
        assert.match(r2.stateFile, new RegExp(`process-state\\.${QUEST}\\.r2\\.yaml$`));
        assert.match(d.stateFile, new RegExp(`process-state\\.${QUEST}\\.yaml$`));
        assert.equal(store().runOverview('r2').variables.step, 'build');
    });

    test('RC-2: the Chat Variables editor for a run', () => {
        openChatVariablesEditor(context, 'r2');
        const panel = panels().find((p: Json) => p.viewType === 'chatVariablesEditor');
        assert.ok(panel);
        assert.equal(panel.title, chatVariablesEditorTitle('r2'));
        assert.equal(panel.title, 'Chat Variables — run r2');
        let state = lastState(panel, 'state');
        assert.deepEqual([state.run, state.windowRun, state.custom.mode, state.process.step], ['r2', 'default', 'careful', 'build']);
        panel.webview.__receive({ type: 'setCustom', key: 'limit', value: '7' });
        assert.equal(chat().withRun('r2', () => chat().getRaw('limit')), '7', 'set in r2');
        assert.equal(chat().withRun('default', () => chat().getRaw('limit')), '', 'not in default');
        // Opened again without a run: the window's.
        openChatVariablesEditor(context);
        state = lastState(panel, 'state');
        assert.equal(panel.title, 'Chat Variables — run default');
        assert.deepEqual([state.run, state.custom.mode, state.process.step], ['default', 'fast', 'plan']);
    });


    test('RC-4: the queue editor host', () => {
        const host = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'queueEditor-handler.ts'), 'utf8');
        assert.match(host, /case 'openReminderSettings':\s+await vscode\.commands\.executeCommand\('tomAi\.statusPage', 'reminders'\);/);
        assert.match(host, /executeCommand\('tomAi\.editor\.chatVariables', tabRunOf\(msg\)\)/);
        assert.match(host, /case 'openRunStateFile': \{[\s\S]{0,300}runContextOf\(tabRunOf\(msg\) \?\? 'default'\)\.stateFile/);
        assert.match(host, /runContexts: runContextsFor\(items\),/);
        const chatHandler = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'chatVariablesEditor-handler.ts'), 'utf8');
        assert.match(chatHandler, /registerCommand\('tomAi\.editor\.chatVariables', \(run\?: unknown\) =>/);
    });
});
