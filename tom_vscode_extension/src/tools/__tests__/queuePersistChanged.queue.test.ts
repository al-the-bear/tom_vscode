/**
 * The queue writes only the items that changed (PromptQueueManager
 * `_persistToFiles`, storage/queueFileStorage.ts): through the real queue
 * manager under the vscode stub, on the Copilot transport (nothing reaches a
 * model), with the file writes counted.
 *
 *   QP-1 a queue of 50 items: the first persist writes all 50 files; a dispatch of a loop's next iteration
 *        writes only the loop item's file, and that file holds the new state (repeat-index)
 *   QP-2 removing an item deletes its file and rewrites only the items after it (their place changed);
 *        moving an item rewrites the items whose place changed and no other; an unchanged queue writes nothing
 *   QP-3 the sent history on disk: no entry file is read while the files are the queue's own; entry files the
 *        queue does not own that push the sent entries past 50 are trimmed
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-persist-')));
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
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
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

const QUEUE_DIR = path.join(WS, '_ai', 'queue');
const isEntry = (f: unknown): boolean => typeof f === 'string' && f.startsWith(QUEUE_DIR) && f.endsWith('.entry.queue.yaml');

// Count the entry files written and read: on the fs module itself (the compiled modules read through to it).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeFs = require('fs') as { writeFileSync: typeof fs.writeFileSync; readFileSync: typeof fs.readFileSync };
const realWrite = nodeFs.writeFileSync;
const realRead = nodeFs.readFileSync;
let written: string[] = [];
let read: string[] = [];
nodeFs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    if (isEntry(args[0])) { written.push(path.basename(String(args[0]))); }
    return realWrite(...args);
}) as typeof fs.writeFileSync;
nodeFs.readFileSync = ((...args: unknown[]) => {
    if (isEntry(args[0])) { read.push(path.basename(String(args[0]))); }
    return (realRead as (...a: unknown[]) => unknown)(...args);
}) as typeof fs.readFileSync;

after(() => {
    nodeFs.writeFileSync = realWrite;
    nodeFs.readFileSync = realRead;
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const persist = (): void => (queue() as unknown as { persist(): void }).persist();
const boundary = (item: QueuedPrompt): Promise<string> =>
    (queue() as unknown as { dispatchNextStageForSendingItem(i: QueuedPrompt): Promise<string> }).dispatchNextStageForSendingItem(item);
const fileOf = (item: QueuedPrompt): string => (queue() as unknown as { _fileNameMap: Map<string, string> })._fileNameMap.get(item.id)!;
const reset = (): void => { written = []; read = []; };

function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

describe('the queue writes what changed', () => {
    test('QP-1: a dispatch on a queue of 50 items writes one file', async () => {
        clear();
        queue().autoSendEnabled = false;
        reset();
        const loop = await queue().enqueue({ originalText: 'iteration', repeatCount: 3, transport: 'copilot', deferSend: true });
        for (let i = 1; i < 50; i++) {
            await queue().enqueue({ originalText: `prompt ${i} ${'text '.repeat(200)}`, transport: 'copilot', deferSend: true });
        }
        assert.equal(queue().items.length, 50);
        assert.equal(new Set(written).size, 50, 'every item written once at least');
        // A loop with its first iteration out, then the dispatch of iteration 2.
        loop.status = 'sending';
        loop.repeatIndex = 1;
        loop.lastDispatched = { kind: 'main', expandedText: 'iteration', transport: 'copilot', dispatchedAt: new Date().toISOString() } as QueuedPrompt['lastDispatched'];
        persist();
        reset();
        queue().autoSendEnabled = true;
        try {
            await boundary(loop);
        } finally {
            queue().autoSendEnabled = false;
        }
        assert.ok(written.length >= 1, 'the dispatch persisted');
        assert.deepEqual([...new Set(written)], [fileOf(loop)], 'only the loop item\'s file');
        const text = fs.readFileSync(path.join(QUEUE_DIR, fileOf(loop)), 'utf8');
        assert.match(text, new RegExp(`repeat-index: ${queue().getById(loop.id)!.repeatIndex}\\b`));
    });

    test('QP-2: removing, moving, nothing changed', async () => {
        // The sending loop of QP-1 goes on changing (its send is asynchronous): write that first.
        persist();
        const items = queue().items.slice();
        const gone = items[10];
        const goneFile = fileOf(gone);
        reset();
        queue().remove(gone.id);
        // The files record each item's place: the items after it moved up, the ones before it did not.
        assert.deepEqual(new Set(written), new Set(items.slice(11).map(fileOf)), 'only the items whose place changed');
        assert.equal(fs.existsSync(path.join(QUEUE_DIR, goneFile)), false, 'its file is deleted');
        // Moving item 21 up one place: it and the item it passed change their place.
        const now = queue().items.slice();
        const moved = now[20];
        const passed = now[19];
        reset();
        queue().move(moved.id, 'up');
        assert.deepEqual(new Set(written), new Set([fileOf(moved), fileOf(passed)]));
        reset();
        persist();
        assert.deepEqual(written, [], 'nothing changed: nothing written');
    });

    test('QP-3: the sent history on disk', async () => {
        reset();
        persist();
        assert.deepEqual(read, [], 'the queue\'s own files: none is read');
        // 55 sent entries of the same host and workspace this queue does not own.
        const own = fs.readdirSync(QUEUE_DIR).find((f) => f.endsWith('.entry.queue.yaml'))!;
        const template = fs.readFileSync(path.join(QUEUE_DIR, own), 'utf8').replace(/status: \w+/, 'status: sent');
        const prefix = own.replace(/_\d{6}_\d{6}-[0-9a-f]+_.*$/, '');
        for (let i = 0; i < 55; i++) {
            const name = `${prefix}_200101_${String(100000 + i)}-ff${String(i).padStart(6, '0')}_x.normal.entry.queue.yaml`;
            fs.writeFileSync(path.join(QUEUE_DIR, name), template.replace(/^ {2}id: .*$/m, `  id: stray-${i}`));
        }
        const before = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.entry.queue.yaml')).length;
        reset();
        queue().items[0].repeatIndex = 2; // something to persist
        persist();
        assert.ok(read.length > 0, 'files it does not own: the sent history is read');
        const after = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.entry.queue.yaml')).length;
        assert.ok(after < before, `trimmed (${before} → ${after})`);
        clear();
    });
});
