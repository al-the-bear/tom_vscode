/**
 * A timed request's chosen template is applied when it fires (vscimpb24), through the real timer engine and
 * queue manager under the vscode stub.
 *
 *   TT-1 a fired entry queues a timed item whose `template` is the entry's template — its prompt is wrapped by
 *        it — and which names the entry in `timedEntryId`; an entry without a template queues `(None)`
 *   TT-2 one in flight per entry: firing again while the item is pending queues nothing; another entry is not
 *        held up by it; pausing the entry removes its pending item and no other
 *   TT-3 the entry file keeps the kind (`type: timed`, `timed-entry-id`, the template) and a reload reads it
 *        back, so the engine still finds its item after a reload
 *   TT-4 an entry file of an earlier build (template `timed:<entry id>`) reads as a timed item of that entry with
 *        no template, and the engine finds it
 *   TT-5 queueItemKindFromYaml / isTimedItemOf: plain, reminder and timed items; a meta entry id on a non-timed
 *        item is ignored
 */

/* eslint-disable @typescript-eslint/naming-convention -- `timed-entry-id` is the entry file's YAML key */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'timed-template-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG = {
    anthropic: { userMessageTemplates: [{ id: 'wrapT', name: 'Wrap T', template: 'WRAPPED BY T: ${userMessage}' }] },
};
for (const [rel, text] of [[`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n'], ['.tom/tom_vscode_extension.json', JSON.stringify(CONFIG)]]) {
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
import { TimerEngine, type TimedRequest } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { isTimedItemOf, queueItemKindFromYaml } from '../../utils/timedQueueItems.js';

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
const engine = (): TimerEngine => TimerEngine.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function clear(): void {
    for (const i of [...queue().items]) { queue().remove(i.id); }
    for (const e of [...engine().entries]) { engine().removeEntry(e.id); }
}
/** An active interval entry; `fire` queues it as the tick does once it is due. */
function entry(text: string, template?: string): TimedRequest {
    return engine().addEntry({ enabled: true, template: template as string, originalText: text, scheduleMode: 'interval', intervalMinutes: 30 });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fire = (e: TimedRequest): Promise<void> => (engine() as any).fire(e, new Date());
const itemsOf = (e: TimedRequest) => queue().items.filter((i) => isTimedItemOf(i, e.id));
const entryFile = (itemId: string): string => {
    const folder = path.join(WS, '_ai', 'queue');
    return fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), 'utf8')).find((t) => t.includes(itemId)) ?? '';
};

describe('a timed request\'s template', () => {
    test('TT-1: applied when the entry fires', async () => {
        clear();
        queue().autoSendEnabled = false;
        const wrapped = entry('check the build', 'wrapT');
        await fire(wrapped);
        const [item] = itemsOf(wrapped);
        assert.ok(item, 'a timed item of the entry');
        assert.equal(item.type, 'timed');
        assert.equal(item.timedEntryId, wrapped.id);
        assert.equal(item.template, 'wrapT', 'the entry\'s template, not a marker');
        assert.match(item.expandedText, /^WRAPPED BY T: check the build/, 'the prompt is wrapped by it');
        const plain = entry('no template');
        await fire(plain);
        assert.equal(itemsOf(plain)[0]?.template, '(None)');
        assert.equal(itemsOf(plain)[0]?.expandedText.trim(), 'no template');
        clear();
    });

    test('TT-2: one in flight per entry', async () => {
        clear();
        queue().autoSendEnabled = false;
        const a = entry('first', 'wrapT');
        const b = entry('second', 'wrapT');
        await fire(a);
        await fire(a);
        assert.equal(itemsOf(a).length, 1, 'the pending item holds the entry');
        await fire(b);
        assert.equal(itemsOf(b).length, 1, 'another entry is not held up');
        const unrelated = await queue().enqueue({ originalText: 'mine', template: 'wrapT', deferSend: true });
        engine().updateEntry(a.id, { enabled: false });
        assert.equal(itemsOf(a).length, 0, 'pausing removes the entry\'s pending item');
        assert.equal(itemsOf(b).length, 1, 'not the other entry\'s');
        assert.ok(queue().getById(unrelated.id), 'nor an item with the same template');
        clear();
    });

    test('TT-3: kept in the entry file across a reload', async () => {
        clear();
        queue().autoSendEnabled = false;
        const e = entry('after a reload', 'wrapT');
        await fire(e);
        const [item] = itemsOf(e);
        const file = entryFile(item.id);
        assert.match(file, /^ {2}type: timed$/m);
        assert.match(file, new RegExp(`^ {2}timed-entry-id: ${e.id}$`, 'm'));
        assert.match(file, /template: wrapT/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (queue() as any)._reloadFromDisk();
        await wait(400);
        const back = queue().getById(item.id);
        assert.deepEqual([back?.type, back?.timedEntryId, back?.template], ['timed', e.id, 'wrapT'], 'read back');
        await fire(e);
        assert.equal(itemsOf(e).length, 1, 'the engine still finds its item');
        clear();
    });

    test('TT-4: an entry file of an earlier build', async () => {
        clear();
        queue().autoSendEnabled = false;
        const e = entry('old item', 'wrapT');
        // What an earlier build wrote: the entry id in the template, no kind in the meta.
        const old = await queue().enqueue({ originalText: 'old item', template: `timed:${e.id}`, deferSend: true });
        assert.match(entryFile(old.id), new RegExp(`template: timed:${e.id}`));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (queue() as any)._reloadFromDisk();
        await wait(400);
        const back = queue().getById(old.id);
        assert.deepEqual([back?.type, back?.timedEntryId, back?.template], ['timed', e.id, '(None)']);
        await fire(e);
        assert.equal(itemsOf(e).length, 1, 'the old pending item still holds the entry');
        clear();
    });

    test('TT-5: the helpers', () => {
        assert.deepEqual(queueItemKindFromYaml({}, 'wrapT'), { type: 'normal', template: 'wrapT' });
        assert.deepEqual(queueItemKindFromYaml({}, undefined), { type: 'normal', template: '(None)' });
        assert.deepEqual(queueItemKindFromYaml({ type: 'reminder' }, '(None)'), { type: 'reminder', template: '(None)' });
        assert.deepEqual(queueItemKindFromYaml({ type: 'timed', 'timed-entry-id': 'e1' }, 'wrapT'), { type: 'timed', template: 'wrapT', timedEntryId: 'e1' });
        assert.deepEqual(queueItemKindFromYaml({}, 'timed:e2'), { type: 'timed', template: '(None)', timedEntryId: 'e2' });
        assert.deepEqual(queueItemKindFromYaml({ 'timed-entry-id': 'e3' }, 'x'), { type: 'normal', template: 'x' }, 'not timed: no entry id');
        assert.equal(isTimedItemOf({ type: 'timed', timedEntryId: 'e1' }, 'e1'), true);
        assert.equal(isTimedItemOf({ type: 'normal', timedEntryId: 'e1' }, 'e1'), false);
        assert.equal(isTimedItemOf({ type: 'timed', timedEntryId: 'e1' }, 'e2'), false);
    });
});
