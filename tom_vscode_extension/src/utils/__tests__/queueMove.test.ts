/**
 * Queue item up / down move one place as the queue editor shows the items (src/utils/queueMove.ts): past the
 * nearest item of the same status, not past the array neighbour of another group.
 *
 *   QM-1 a pending item with sent items above it (a todo walk's queue) moves up past the pending one above it
 *   QM-2 down skips items of other groups the same way
 *   QM-3 first / last of its group: no move (-1)
 *   QM-4 through the queue manager: up on the second pending item makes it the first pending item
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { queueMoveTarget } from '../queueMove';

const items = (...statuses: string[]) => statuses.map((status, i) => ({ id: `i${i}`, status }));

describe('queue up / down', () => {
    test('QM-1: up past the sent items between', () => {
        const q = items('pending', 'sent', 'sent', 'pending', 'staged');
        assert.equal(queueMoveTarget(q, 3, 'up'), 0);
    });

    test('QM-2: down past other groups', () => {
        const q = items('pending', 'sent', 'staged', 'pending');
        assert.equal(queueMoveTarget(q, 0, 'down'), 3);
    });

    test('QM-3: the ends of a group', () => {
        const q = items('sent', 'pending', 'sent', 'pending', 'staged');
        assert.equal(queueMoveTarget(q, 1, 'up'), -1);
        assert.equal(queueMoveTarget(q, 3, 'down'), -1);
        assert.equal(queueMoveTarget(q, 9, 'up'), -1);
    });
});

// ---- QM-4: the manager -----------------------------------------------------

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-move-')));
const WS = path.join(SANDBOX, 'ws');
const QUEST = 'q1';
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.writeFileSync(path.join(WS, '_ai', 'quests', QUEST, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}\n');
process.env.HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
(stubbed.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore';
import { ReminderSystem } from '../../managers/reminderSystem';
import { TimerEngine } from '../../managers/timerEngine';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration';

const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions, extensionPath: SANDBOX, extensionUri: { fsPath: SANDBOX, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(SANDBOX, rel),
    } as never;
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
    stubbed.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('queue up / down in the manager', () => {
    test('QM-4: up over a sent item', async () => {
        const qm = PromptQueueManager.instance;
        qm.autoSendEnabled = false;
        const a = await qm.enqueue({ originalText: 'A', deferSend: true, initialStatus: 'pending' });
        const s = await qm.enqueue({ originalText: 'S', deferSend: true, initialStatus: 'pending' });
        const b = await qm.enqueue({ originalText: 'B', deferSend: true, initialStatus: 'pending' });
        (qm.getById(s.id) as QueuedPrompt).status = 'sent';
        const pendingOrder = (): string[] => qm.items.filter((i) => i.status === 'pending').map((i) => i.originalText);
        assert.deepEqual(pendingOrder(), ['A', 'B']);
        qm.move(b.id, 'up');
        assert.deepEqual(pendingOrder(), ['B', 'A'], 'B is now the first pending item');
        qm.move(b.id, 'up');
        assert.deepEqual(pendingOrder(), ['B', 'A'], 'already first: no move');
        qm.move(b.id, 'down');
        assert.deepEqual(pendingOrder(), ['A', 'B']);
        for (const i of [a, s, b]) { qm.remove(i.id); }
    });
});
