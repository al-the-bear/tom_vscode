/**
 * The session of a queue item (PromptQueueManager.updateItemSession), on the
 * real manager in a sandbox workspace: a staged or a pending item changes its
 * session — the run loop reads it when the item is dispatched — while an item
 * already sending, sent or in error does not.
 *
 *   QIS-1 a pending item takes a new session (it was refused as if it were sending)
 *   QIS-2 a staged item too; '' returns it to the queue default
 *   QIS-3 sending, sent and error items keep theirs: false, nothing changed
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-item-session-')));
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

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

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
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' },
        logUri: { fsPath: storage, scheme: 'file' }, globalStoragePath: storage, storagePath: storage, logPath: storage,
        globalState: memento(), workspaceState: memento(), asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
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
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

describe('the session of a queue item', () => {
    test('QIS-1: a pending item changes its session', async () => {
        clear();
        const item = await queue().enqueue({ originalText: 'a pending item', transport: 'copilot', deferSend: true });
        item.status = 'pending';
        assert.equal(queue().updateItemSession(item.id, 'op5'), true);
        assert.equal(queue().getById(item.id)?.session, 'op5');
        assert.equal(queue().getById(item.id)?.status, 'pending', 'still pending');
    });

    test('QIS-2: a staged item too, and back to the default', async () => {
        clear();
        const item = await queue().enqueue({ originalText: 'a staged item', transport: 'copilot', deferSend: true, initialStatus: 'staged' });
        assert.equal(item.status, 'staged');
        assert.equal(queue().updateItemSession(item.id, 'op5'), true);
        assert.equal(queue().getById(item.id)?.session, 'op5');
        assert.equal(queue().updateItemSession(item.id, ''), true);
        assert.equal(queue().getById(item.id)?.session, undefined, "'' is the queue default");
    });

    test('QIS-3: sending, sent and error items keep their session', async () => {
        for (const status of ['sending', 'sent', 'error'] as const) {
            clear();
            const item = await queue().enqueue({ originalText: `a ${status} item`, transport: 'copilot', deferSend: true });
            queue().updateItemSession(item.id, 'before');
            item.status = status;
            assert.equal(queue().updateItemSession(item.id, 'after'), false, status);
            assert.equal(queue().getById(item.id)?.session, 'before', `${status}: unchanged`);
        }
    });
});
