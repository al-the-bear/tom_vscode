/**
 * An editor tab VS Code restores after a window reload is restored before the
 * manager it shows has started (chat10): the panel serializers are registered
 * early in activation, PromptQueueManager.init / TimerEngine.init run later,
 * after an await. The restored editor must still follow the manager once it
 * starts — before the fix it subscribed to nothing (`instance` threw, the
 * catch swallowed it) and showed changes only after it was closed and reopened.
 *
 *   ER-1 the Prompt Queue editor restored before the queue manager starts gets the state once the manager
 *        starts, and every change after that (an item added, removed)
 *   ER-2 the Timed Requests editor restored before the timer engine starts follows the engine the same way
 *   ER-3 whenReady(): answers the manager at once once it runs, and waits for it before
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-restore-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', '{}\n']]) {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = vscodeStub.stub.window as Record<string, unknown>;
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
// The serializers the handlers register, as VS Code keeps them.
const serializers = new Map<string, { deserializeWebviewPanel(panel: unknown, state?: unknown): Promise<void> }>();
stubWindow.registerWebviewPanelSerializer = (viewType: string, s: never) => { serializers.set(viewType, s); return { dispose: () => undefined }; };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerQueueEditorCommand } from '../queueEditor-handler.js';
import { registerTimedRequestsEditorCommand } from '../timedRequestsEditor-handler.js';

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
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Panel = any;
const newPanel = (viewType: string): Panel => (stubWindow.createWebviewPanel as (v: string, t: string) => Panel)(viewType, viewType);
const states = (panel: Panel): Array<Record<string, unknown>> => (panel.webview.__posted as Array<Record<string, unknown>>).filter((m) => m && m.type === 'state');
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('editors restored before their manager starts', () => {
    // Activation as extension.ts runs it: the serializers first, the managers after an await.
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ReminderSystem.init(context);
    registerQueueEditorCommand(context);
    registerTimedRequestsEditorCommand(context);
    const queuePanel = newPanel('tomAi.queueEditor');
    const timedPanel = newPanel('tomAi.timedRequestsEditor');

    test('ER-3: whenReady before the managers start', async () => {
        let queueReady = false;
        void PromptQueueManager.whenReady().then(() => { queueReady = true; });
        await wait(10);
        assert.equal(queueReady, false, 'not before init');
        // VS Code restores the tabs while activation awaits.
        await serializers.get('tomAi.queueEditor')!.deserializeWebviewPanel(queuePanel);
        await serializers.get('tomAi.timedRequestsEditor')!.deserializeWebviewPanel(timedPanel);
        TimerEngine.init(context);
        PromptQueueManager.init(context);
        await wait(20);
        assert.equal(queueReady, true, 'resolved by init');
        assert.equal(await PromptQueueManager.whenReady(), PromptQueueManager.instance);
        assert.equal(await TimerEngine.whenReady(), TimerEngine.instance);
    });

    test('ER-1: the Prompt Queue editor follows the queue', async () => {
        await wait(600);
        const before = states(queuePanel).length;
        const item = await PromptQueueManager.instance.enqueue({ originalText: 'added after the restore', deferSend: true });
        await wait(50);
        const after1 = states(queuePanel);
        assert.ok(after1.length > before, 'a state was posted for the change');
        const last = after1[after1.length - 1] as { items: Array<{ id: string }> };
        assert.ok(last.items.some((i) => i.id === item.id), 'the new item is in the posted state');
        PromptQueueManager.instance.remove(item.id);
        await wait(50);
        const final = states(queuePanel).pop() as { items: Array<{ id: string }> };
        assert.ok(!final.items.some((i) => i.id === item.id), 'its removal too');
    });

    test('ER-2: the Timed Requests editor follows the timer engine', async () => {
        const before = states(timedPanel).length;
        TimerEngine.instance.addRepeatedTodoController();
        await wait(50);
        assert.ok(states(timedPanel).length > before, 'a state was posted for the new entry');
    });
});
