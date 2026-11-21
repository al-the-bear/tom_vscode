/**
 * The guideline picker's views follow each other (gsel5b; handlers/aspectViewsRefresh.ts): a level written in the
 * Prompt Queue editor, a todo view or another window redraws the queue editor and every open todo view, through the
 * real handlers under the vscode stub (the queue editor restored into a stub panel, the todo views fake webviews).
 * `_ai/aspect_guidelines/` has the sections `answer` (default `full`, options `brief`, `full`) and `night` (default
 * `off`, options `on`, `off`).
 *
 *   AR-1 every level write of the picker's messages refreshes both: the window, all windows, a run, Set as / Clear
 *        quest default; a refused choice and Edit sections refresh nothing; a refresher that throws does not keep
 *        the other from running
 *   AR-2 another window's all-windows change (the setAspectChoice window request) sets the window level and
 *        refreshes both; so do the two quest-default commands
 *   AR-3 a window choice made in the queue editor reaches every todo view that asked for the picker's data
 *        (qtAspects with the new window level) and the queue editor's own state, without a reload
 *   AR-4 a window choice made in a todo view reaches the queue editor's state and the other todo views; a quest
 *        default set there too; another window's change reaches both pages
 *   AR-5 a todo view whose post throws (disposed) is dropped and the others still get it
 *   AR-6 the wiring: the queue editor and the todo panel send nothing of their own after a change; extension.ts
 *        routes the setAspectChoice request to applyAspectChoiceRequest
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261121_gsel5b_refresh-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
// The sandbox is its own root: it lies under the real workspace's ztmp/, whose root marker the layout would find.
put('.tom/tom_root.yaml', 'version: 1\n');
put('.tom/tom_vscode_extension.json', '{}\n');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, 'todos:\n  - id: t1\n    title: T\n    description: D\n    status: not-started\n');
put('_ai/aspect_guidelines/answer/section.yaml', 'name: Answer\ndefault: full\noptions: [brief, full]\n');
put('_ai/aspect_guidelines/answer/brief.md', 'ANSWER-BRIEF\n');
put('_ai/aspect_guidelines/answer/full.md', 'ANSWER-FULL\n');
put('_ai/aspect_guidelines/night/section.yaml', 'name: Night\nplacement: user\ndefault: off\noptions: [on, off]\n');
put('_ai/aspect_guidelines/night/on.md', 'NIGHT-ON\n');
put('_ai/aspect_guidelines/night/off.md', 'NIGHT-OFF\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = vscodeStub.stub.window as Record<string, unknown>;
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
const serializers = new Map<string, { deserializeWebviewPanel(panel: unknown, state?: unknown): Promise<void> }>();
stubWindow.registerWebviewPanelSerializer = (viewType: string, s: never) => { serializers.set(viewType, s); return { dispose: () => undefined }; };
const commands = new Map<string, (...args: unknown[]) => unknown>();
(vscodeStub.stub.commands as Record<string, unknown>).registerCommand = (id: string, fn: (...args: unknown[]) => unknown) => { commands.set(id, fn); return { dispose: () => undefined }; };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerQueueEditorCommand } from '../queueEditor-handler.js';
import { handleQuestTodoMessage, postTodoAspectsToAllViews } from '../questTodoPanel-handler.js';
import { handleAspectPickerMessage } from '../aspectPickerMessages.js';
import {
    applyAspectChoiceRequest, CLEAR_QUEST_DEFAULT_GUIDELINES_COMMAND, registerAspectChoiceCommands, SET_QUEST_DEFAULT_GUIDELINES_COMMAND,
} from '../aspectChoiceCommands.js';
import { __setAspectViewRefreshersForTests, refreshAspectViews } from '../aspectViewsRefresh.js';
import { questDefaultChoices, setWindowChoices, windowChoices } from '../../services/aspectChoiceLevels.js';

const subscriptions: Array<{ dispose(): void }> = [];
const storage = path.join(SANDBOX, 'storage');
fs.mkdirSync(storage, { recursive: true });
const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
};
const context = {
    subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
    globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' },
    logUri: { fsPath: storage, scheme: 'file' }, globalStoragePath: storage, storagePath: storage, logPath: storage,
    globalState: memento(), workspaceState: memento(), asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
} as never;

after(() => {
    __setAspectViewRefreshersForTests(undefined);
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A todo view: what the host posts to it is in `posted`; `broken` makes its post throw (a disposed webview). */
function todoView(): { webview: Json; posted: Json[]; broken: boolean } {
    const view = { posted: [] as Json[], broken: false, webview: undefined as Json };
    view.webview = {
        postMessage: (m: Json): Promise<boolean> => {
            if (view.broken) { throw new Error('Webview is disposed'); }
            view.posted.push(m);
            return Promise.resolve(true);
        },
    };
    return view;
}
const lastAspects = (view: { posted: Json[] }): Json => [...view.posted].reverse().find((m) => m?.type === 'qtAspects');
const queueStates = (panel: Json): Json[] => (panel.webview.__posted as Json[]).filter((m) => m && m.type === 'state');
const lastQueueState = (panel: Json): Json => queueStates(panel).pop();

/** Count the refresh calls while `run` runs. */
async function refreshCalls(run: () => unknown): Promise<{ queueEditor: number; todoViews: number }> {
    const calls = { queueEditor: 0, todoViews: 0 };
    __setAspectViewRefreshersForTests({ queueEditor: () => { calls.queueEditor++; }, todoViews: () => { calls.todoViews++; } });
    try { await run(); } finally { __setAspectViewRefreshersForTests(undefined); }
    return calls;
}

describe('the guideline picker views follow each other (gsel5b)', () => {
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ProcessStateStore.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
    registerQueueEditorCommand(context);
    registerAspectChoiceCommands(context);
    const queuePanel: Json = (stubWindow.createWebviewPanel as (v: string, t: string) => Json)('tomAi.queueEditor', 'Prompt Queue');

    test('AR-1: every level write of the picker refreshes both pages', async () => {
        const choose = (level: string, section: string, value: string, extra: Record<string, string> = {}) => () =>
            handleAspectPickerMessage({ type: 'aspectChoose', level, section, value, ...extra });
        for (const [what, run] of [
            ['window', choose('window', 'answer', 'brief')],
            ['window, Don\'t add', choose('window', 'answer', '')],
            ['all windows', choose('allWindows', 'night', 'on')],
            ['a run', choose('run', 'answer', 'brief', { run: 'default' })],
            ['Set as quest default', () => handleAspectPickerMessage({ type: 'aspectQuestDefault', action: 'set' })],
            ['Clear quest default', () => handleAspectPickerMessage({ type: 'aspectQuestDefault', action: 'clear' })],
        ] as const) {
            assert.deepEqual(await refreshCalls(run), { queueEditor: 1, todoViews: 1 }, what);
        }
        assert.deepEqual(await refreshCalls(choose('window', 'tone', 'dry')), { queueEditor: 0, todoViews: 0 }, 'an unknown section is refused');
        assert.deepEqual(await refreshCalls(choose('window', 'night', 'never')), { queueEditor: 0, todoViews: 0 }, 'an unknown option is refused');
        assert.deepEqual(await refreshCalls(() => handleAspectPickerMessage({ type: 'aspectEditSections' })), { queueEditor: 0, todoViews: 0 }, 'Edit sections');
        // A refresher that throws does not keep the other from running.
        let todo = 0;
        __setAspectViewRefreshersForTests({ queueEditor: () => { throw new Error('gone'); }, todoViews: () => { todo++; } });
        try { refreshAspectViews(); } finally { __setAspectViewRefreshersForTests(undefined); }
        assert.equal(todo, 1);
        setWindowChoices(undefined);
    });

    test('AR-2: another window\'s change and the quest-default commands refresh both', async () => {
        assert.deepEqual(await refreshCalls(() => applyAspectChoiceRequest('night', 'on')), { queueEditor: 1, todoViews: 1 });
        assert.deepEqual(windowChoices(), { night: 'on' }, 'set in this window');
        assert.deepEqual(await refreshCalls(() => commands.get(SET_QUEST_DEFAULT_GUIDELINES_COMMAND)!()), { queueEditor: 1, todoViews: 1 });
        assert.deepEqual(questDefaultChoices(), { night: 'on' });
        assert.deepEqual(await refreshCalls(() => commands.get(CLEAR_QUEST_DEFAULT_GUIDELINES_COMMAND)!()), { queueEditor: 1, todoViews: 1 });
        assert.equal(questDefaultChoices(), undefined);
        setWindowChoices(undefined);
    });

    const viewA = todoView();
    const viewB = todoView();

    test('AR-3: a window choice in the queue editor reaches the todo views', async () => {
        await serializers.get('tomAi.queueEditor')!.deserializeWebviewPanel(queuePanel);
        await wait(300);
        await handleQuestTodoMessage({ type: 'qtGetAspects' }, viewA.webview);
        await handleQuestTodoMessage({ type: 'qtGetAspects' }, viewB.webview);
        assert.equal(lastAspects(viewA).aspects.window, undefined, 'no window choice yet');
        const statesBefore = queueStates(queuePanel).length;
        queuePanel.webview.__receive({ type: 'aspectChoose', level: 'window', section: 'answer', value: 'brief' });
        await wait(100);
        for (const [name, view] of [['A', viewA], ['B', viewB]] as const) {
            assert.deepEqual(lastAspects(view).aspects.window, { answer: 'brief' }, `todo view ${name}`);
        }
        assert.ok(queueStates(queuePanel).length > statesBefore, 'the queue editor got its state again');
        assert.deepEqual(lastQueueState(queuePanel).aspects.window, { answer: 'brief' });
    });

    test('AR-4: a change in a todo view or from another window reaches the queue editor and the other views', async () => {
        const bBefore = viewB.posted.length;
        await handleQuestTodoMessage({ type: 'aspectChoose', level: 'window', section: 'night', value: 'on' }, viewA.webview);
        await wait(50);
        assert.deepEqual(lastQueueState(queuePanel).aspects.window, { answer: 'brief', night: 'on' }, 'the queue editor');
        assert.ok(viewB.posted.length > bBefore, 'the other todo view');
        assert.deepEqual(lastAspects(viewB).aspects.window, { answer: 'brief', night: 'on' });
        assert.deepEqual(lastAspects(viewA).aspects.window, { answer: 'brief', night: 'on' }, 'the view it was made in');

        await handleQuestTodoMessage({ type: 'aspectQuestDefault', action: 'set' }, viewB.webview);
        await wait(50);
        assert.deepEqual(lastQueueState(queuePanel).aspects.questDefault, { answer: 'brief', night: 'on' }, 'quest default in the queue editor');
        assert.deepEqual(lastAspects(viewA).aspects.questDefault, { answer: 'brief', night: 'on' }, 'and in the other todo view');

        applyAspectChoiceRequest('answer', undefined);
        await wait(50);
        assert.deepEqual(lastQueueState(queuePanel).aspects.window, { night: 'on' }, 'another window\'s change in the queue editor');
        assert.deepEqual(lastAspects(viewA).aspects.window, { night: 'on' });
        assert.deepEqual(lastAspects(viewB).aspects.window, { night: 'on' });
    });

    test('AR-5: a disposed todo view is dropped, the others still get it', async () => {
        viewB.broken = true;
        assert.equal(postTodoAspectsToAllViews(), 1, 'B threw and was dropped');
        viewB.broken = false;
        const bBefore = viewB.posted.length;
        assert.equal(postTodoAspectsToAllViews(), 1, 'only A is left');
        assert.equal(viewB.posted.length, bBefore, 'B gets nothing more');
        // A view that asks again is back.
        await handleQuestTodoMessage({ type: 'qtGetAspects' }, viewB.webview);
        assert.equal(postTodoAspectsToAllViews(), 2);
    });

    test('AR-6: the wiring', () => {
        const src = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, 'src', ...p), 'utf8');
        assert.match(src('handlers', 'queueEditor-handler.ts'), /const aspect = await handleAspectPickerMessage\(msg\);\s*if \(aspect\.handled\) \{ return; \}/);
        const todo = src('handlers', 'questTodoPanel-handler.ts');
        assert.match(todo, /_aspectViews\.add\(webview\);\s*await handleAspectPickerMessage\(msg\);\s*return true;/);
        assert.match(src('extension.ts'), /setAspectChoice: \(section, option\) => applyAspectChoiceRequest\(section, option\)/);
        const refresh = src('handlers', 'aspectViewsRefresh.ts');
        assert.match(refresh, /\.refreshQueueEditorState\(\)/);
        assert.match(refresh, /\.postTodoAspectsToAllViews\(\)/);
    });
});
