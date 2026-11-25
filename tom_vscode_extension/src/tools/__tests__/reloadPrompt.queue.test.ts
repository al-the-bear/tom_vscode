/**
 * *Send prompt after reload* (vscimpb109): the prompt is queued at the front of the window's run and sent as Continue
 * sends it. Through the real process store and queue (dispatchStage stubbed: nothing reaches a model).
 *
 *   RP-1 the item is first in the queue, in the window's current run, with that run's defaults; it is sent although
 *        the run's auto-send is off, the run's auto-send stays off and the item queued before it is not sent; nothing
 *        runs `workbench.action.chat.open`
 *   RP-2 a busy run (an item of it runs a stage): the reload item waits, pending, and is sent once the stage has
 *        ended; a second reload of the same window replaces its unsent item, another window's stays
 *   RP-3 the marker is written to the entry file (`reload-prompt: {window-id}`) and read back
 *   RP-4 activation waits for the restored queue and the process store, queues it through queueReloadPrompt and opens
 *        no chat; the queue editor badges it; the Status Page says where it goes
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261115_vscimpb109_reload-')));
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
/** Every command the code under test runs (nothing may open Copilot Chat). */
const commandsRun: string[] = [];
{
    const commands = vscodeStub.stub.commands as Record<string, unknown>;
    const real = commands.executeCommand as (...a: unknown[]) => unknown;
    commands.executeCommand = (id: string, ...rest: unknown[]) => { commandsRun.push(id); return real ? real(id, ...rest) : undefined; };
}
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { installProcessMoveMarkers } from '../../services/processActionService.js';
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
    TimerEngine.init(context);
    PromptQueueManager.init(context);
    installProcessMoveMarkers();
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');
const tick = async (ms = 20): Promise<void> => { await new Promise((r) => setTimeout(r, ms)); };
/** The stages dispatched (stubbed): the item ids. */
const dispatched: string[] = [];

describe('the reload prompt', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        assert.equal(store().createRun('r2', undefined, 'user', true).ok, true);
        assert.equal(store().currentRun, 'r2', 'the window works on r2');
        queue().setRunQueueSettings('r2', { autoSend: false, defaultTransport: 'anthropic', defaultAnthropicProfileId: 'opus-test' });
        const q = queue() as unknown as { dispatchStage: (...a: unknown[]) => Promise<unknown> };
        q.dispatchStage = async (_text: unknown, _resolved: unknown, container: unknown) => { dispatched.push((container as { id?: string } | undefined)?.id ?? ''); return { mode: 'direct', answerText: 'ok' }; };
    });

    test('RP-1: at the front of the window\'s run, sent although the run is paused', async () => {
        const earlier = await queue().enqueue({ originalText: 'an older item', run: 'r2', runIsExplicit: true, deferSend: true });
        assert.equal(earlier.status, 'pending');
        const item = (await queue().queueReloadPrompt('  After the reload: go on.  ', { windowId: 'win-a' }))!;
        assert.equal(queue().items[0].id, item.id, 'position 0');
        assert.deepEqual([item.run, item.reloadPrompt, item.originalText], ['r2', { windowId: 'win-a' }, 'After the reload: go on.']);
        assert.equal(item.transport, undefined, 'the run\'s defaults, not a pinned transport');
        await tick();
        const now = queue().items.find((i) => i.id === item.id);
        assert.ok(dispatched.includes(item.id), `sent as Continue sends it (status ${now?.status}, error ${now?.error})`);
        assert.notEqual(queue().items.find((i) => i.id === item.id)?.status, 'pending');
        assert.equal(queue().runQueueSettings('r2').autoSend, false, 'the run\'s auto-send stays off');
        assert.equal(dispatched.includes(earlier.id), false, 'the item behind it is not sent');
        assert.equal(queue().items.find((i) => i.id === earlier.id)?.status, 'pending');
        assert.equal(commandsRun.includes('workbench.action.chat.open'), false, 'nothing opens Copilot Chat');
    });

    test('RP-2: a busy run, and a second reload', async () => {
        // An item of r2 running a stage (sending, no progress yet, so not held at the pause gate).
        const busy = await queue().enqueue({ originalText: 'a running item', run: 'r2', runIsExplicit: true, deferSend: true });
        busy.status = 'sending';
        assert.equal(queue().runLaneBusy('r2'), true);
        const before = dispatched.length;
        const first = (await queue().queueReloadPrompt('reload one', { windowId: 'win-a' }))!;
        const other = (await queue().queueReloadPrompt('reload of another window', { windowId: 'win-b' }))!;
        await tick();
        assert.equal(dispatched.length, before, 'held while the run is busy');
        assert.equal(first.status, 'pending');
        const second = (await queue().queueReloadPrompt('reload two', { windowId: 'win-a' }))!;
        const ids = queue().items.map((i) => i.id);
        assert.equal(ids.includes(first.id), false, 'the earlier unsent reload item of this window is replaced');
        assert.equal(ids.includes(other.id), true, 'another window\'s stays');
        assert.equal(ids[0], second.id);
        // The running stage ends.
        busy.status = 'sent';
        (queue() as unknown as { _onDidChange: { fire(): void } })._onDidChange.fire();
        await tick();
        assert.ok(dispatched.includes(second.id), 'sent once the stage has ended');
        assert.equal(commandsRun.includes('workbench.action.chat.open'), false);
    });

    test('RP-3: kept in the entry file and read back', () => {
        (queue() as unknown as { persist(): void }).persist();
        const dir = path.join(WS, '_ai', 'queue');
        const marked = queue().items.find((i) => i.reloadPrompt?.windowId === 'win-b')!;
        const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes(`id: ${marked.id}`))!;
        assert.ok(file, 'its entry file');
        const doc = parseYaml(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(doc['prompt-queue'][0]['reload-prompt'], { 'window-id': 'win-b' });
        const back = (queue() as unknown as { _entryToQueuedPrompt(e: unknown): { reloadPrompt?: unknown } })._entryToQueuedPrompt({ fileName: path.basename(file), doc });
        assert.deepEqual(back.reloadPrompt, { windowId: 'win-b' }, 'read back after a reload');
    });

    test('RP-4: activation, the queue editor and the Status Page', () => {
        const ext = EXT('src', 'extension.ts');
        const fn = ext.slice(ext.indexOf('function scheduleConfiguredReloadPromptSend'), ext.indexOf('\n}\n', ext.indexOf('function scheduleConfiguredReloadPromptSend')));
        assert.match(fn, /Promise\.all\(\[PromptQueueManager\.whenReady\(\), ProcessStateStore\.ready\]\)\s*\.then\(\(\[manager\]\) => manager\.queueReloadPrompt\(prompt\)\)/);
        assert.doesNotMatch(fn, /workbench\.action\.chat\.open|setTimeout/, 'no direct Copilot send, no fixed delay');
        assert.match(EXT('media', 'shared', 'queueEntryRenderFunctions.js'), /item\.reloadPrompt\s*\? '<span class="queue-from-chip queue-reload-chip"[^\n]*after reload<\/span>'/);
        const page = EXT('src', 'handlers', 'statusPage-handler.ts');
        assert.match(page, /the prompt is queued at the front of its run's queue, with that run's defaults \(transport, profile, session\), and sent as Continue sends it — also while the queue is paused/);
        assert.match(page, /placeholder="Prompt queued at the front of the run's queue after a window reload"/);
        assert.doesNotMatch(page, /Prompt to send 15s after extension activation/);
    });
});
