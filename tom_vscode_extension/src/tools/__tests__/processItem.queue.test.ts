/**
 * Process items (vscimpb97): the work of a process step does not count towards the quest refresh. Through the real
 * process store, queue and quest-refresh store (dispatchStage stubbed: nothing reaches a model).
 *
 *   PI-1 Proceed marks the prompt it queues and its process-move marker `processItem`; tomAi_addQueueItem marks an
 *        item with `processItem: true` and leaves one without it unmarked
 *   PI-2 the marker is written to the item's entry file (`process-item: true`) and read back from it (a reload)
 *   PI-3 the anthropic main stage of a marked item leaves the quest refresh counter as it is; an unmarked item counts
 *   PI-4 the queue editor shows the marker; the system prompt of a Proceed run tells the agent to set it
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261114_vscimpb97_processitem-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/two/two.process.yaml', [
    'id: two', 'name: two', 'phases:',
    '  - id: p1', '    name: P1', '    repeatable: true', '    steps:',
    '      - id: start', '        name: Start', '        repeatable: true', '        prompt: Start the work.',
    '      - id: work', '        name: Work', '        prompt: Work on it.',
    '    gate:', '      id: g1', '      name: G1',
    '  - id: p2', '    name: P2', '    steps:',
    '      - id: check', '        name: Check', '        prompt: Check it.',
    '    gate:', '      id: g2', '      name: G2', '',
].join('\n'));
put('_ai/processes/two/two.md', '# two\n');
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
import { confirmProcessAction, installProcessMoveMarkers } from '../../services/processActionService.js';
import { QuestRefreshStore } from '../../managers/questRefreshStore.js';
import { ADD_TO_PROMPT_QUEUE_TOOL as ADD_QUEUE_ITEM_TOOL } from '../chat-enhancement-tools.js';
import { parse as parseYaml } from 'yaml';

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
const ok = (r: { ok: boolean }): void => { assert.equal(r.ok, true, JSON.stringify(r)); };
const count = (): number => QuestRefreshStore.instance.getPanelState('anthropic', QUEST).count;
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');

describe('process items', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        queue().setRunQueueSettings('default', { autoSend: false, defaultTransport: 'anthropic' });
        ok(store().apply({ process: 'two' }, 'user'));
    });

    test('PI-1: Proceed and tomAi_addQueueItem mark their items', async () => {
        const before = new Set(queue().items.map((i) => i.id));
        const proceeded = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceeded.ok && proceeded.queued, true, JSON.stringify(proceeded));
        const added = queue().items.filter((i) => !before.has(i.id));
        assert.equal(added.length, 2, 'the step\'s prompt and its marker');
        assert.deepEqual(added.map((i) => [!!i.processMove, i.processItem]), [[false, true], [true, true]]);
        const marked = JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'a walk of the step', processItem: true } as never));
        const plain = JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'something else' } as never));
        const byId = (id: string) => queue().items.find((i) => i.id === id)!;
        assert.equal(byId(marked.id).processItem, true, JSON.stringify(marked));
        assert.equal(byId(plain.id).processItem, undefined);
    });

    test('PI-2: kept in the entry file and read back', () => {
        (queue() as unknown as { persist(): void }).persist();
        const dir = path.join(WS, '_ai', 'queue');
        const marked = queue().items.find((i) => i.processItem && !i.processMove)!;
        const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes(`id: ${marked.id}`))!;
        assert.ok(file, 'its entry file');
        const doc = parseYaml(fs.readFileSync(file, 'utf8'));
        assert.equal(doc['prompt-queue'][0]['process-item'], true);
        const back = (queue() as unknown as { _entryToQueuedPrompt(e: unknown): { processItem?: boolean } })._entryToQueuedPrompt({ fileName: path.basename(file), doc });
        assert.equal(back.processItem, true, 'read back after a reload');
        const plain = queue().items.find((i) => i.originalText === 'something else')!;
        const plainFile = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes(`id: ${plain.id}`))!;
        assert.doesNotMatch(fs.readFileSync(plainFile, 'utf8'), /process-item/);
    });

    test('PI-3: a marked item leaves the counter as it is; an unmarked one counts', async () => {
        const q = queue() as unknown as {
            dispatchStage: (...a: unknown[]) => Promise<unknown>;
            _dispatchMainStageWithRefresh(item: unknown, resolved: unknown): Promise<unknown>;
        };
        const real = q.dispatchStage;
        q.dispatchStage = async () => ({ mode: 'direct', answerText: 'ok' });
        try {
            const start = count();
            const marked = queue().items.find((i) => i.processItem && !i.processMove)!;
            await q._dispatchMainStageWithRefresh(marked, { transport: 'anthropic' });
            assert.equal(count(), start, 'a process item does not count');
            const plain = queue().items.find((i) => i.originalText === 'something else')!;
            await q._dispatchMainStageWithRefresh(plain, { transport: 'anthropic' });
            assert.equal(count(), start + 1, 'a normal item counts');
        } finally {
            q.dispatchStage = real;
        }
    });

    test('PI-4: the queue editor shows it; the Proceed run\'s system prompt asks for it', () => {
        assert.match(EXT('media', 'shared', 'queueEntryRenderFunctions.js'), /if \(item\.processItem && !item\.processMove\)[\s\S]*\[process item\]/);
        assert.match(EXT('src', 'utils', 'processDefinition.ts'), /pass `processItem: true`, so it does not count towards the quest refresh/);
        assert.match(fs.readFileSync(path.join(EXT_ROOT, '..', '..', '..', '_ai', 'processes', '_prompts', 'process_engine.md'), 'utf8'), /pass `processItem: true` to tomAi_addQueueItem/);
    });
});
