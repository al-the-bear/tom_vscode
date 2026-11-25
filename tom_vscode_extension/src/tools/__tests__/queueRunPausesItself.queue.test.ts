/**
 * A run's queue switched its auto-send off by itself after an item (vscimpb168), through the real manager and
 * process store.
 *
 *   QP-1 the cause, deliveries: an item another quest sends without a run is queued in `default` — not in the run
 *        the window works on (here `collab`), and not in a process position the take-up runs in; its "pause after
 *        this" belongs to `default`, so the window's own run goes on; a named run is kept
 *   QP-2 the cause, the shared settings file: a window writes only the runs it changed, of its own quest
 *        (`runs-by-quest.<quest>`): a run whose auto-send this window holds off since it started (Auto-Start off)
 *        is not written, another quest's runs (also one named like this quest's) and the runs another window wrote
 *        stay as the file has them
 *   QP-3 the rules: a quest without an entry reads the old shared `runs:` and starts its entry from them; removed
 *        runs are dropped; another quest's entry is kept
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261118_vscimpb168_pause-')));
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
    'id: design', 'name: design', 'phases:', '  - id: p1', '    steps:',
    '      - id: plan', '        name: Plan', '    gate:', '      id: g1', '',
].join('\n'));
put('_ai/processes/design/design.md', '# design\n');
put('.tom/tom_vscode_extension.json', '{}\n');
// The shared settings file as another window and another quest left it: q2's runs, a shared `runs:`.
put('_ai/queue/queue-settings.yaml', YAML.stringify({
    'auto-send-enabled': true,
    runs: { default: { 'auto-send-enabled': true, 'auto-start-enabled': true }, collab: { 'auto-send-enabled': true, 'auto-start-enabled': false } },
    'runs-by-quest': {
        q1: {
            default: { 'auto-send-enabled': true, 'auto-start-enabled': true },
            collab: { 'auto-send-enabled': true, 'auto-start-enabled': true },
            elsewhere: { 'auto-send-enabled': true, 'auto-start-enabled': false },
        },
        q2: { default: { 'auto-send-enabled': false, 'auto-start-enabled': false }, collab: { 'auto-send-enabled': true } },
    },
}));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { getQueueFolder } from '../../storage/queueFileStorage.js';
import { inboxFileName, writeInboxFile } from '../../utils/questInbox.js';
import { getWorkspaceName } from '../../utils/panelYamlStore.js';
import { runInProcessPosition } from '../../services/processRunContext.js';
import { questRunsInFile, readQuestRunQueueSettings, BUILTIN_RUN_QUEUE_SETTINGS } from '../../utils/runQueueSettings.js';

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
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });
handler.sendMessage = async () => ({ text: 'done', turnsUsed: 1, toolCallCount: 0 });
const settingsFile = (): Json => YAML.parse(fs.readFileSync(path.join(getQueueFolder()!, 'queue-settings.yaml'), 'utf8'));

describe('a run does not pause itself', () => {
    test('QP-1: a delivered item goes into default, not the run the window works on', async () => {
        assert.equal(store().createRun('collab', 'design', 'user', false).ok, true);
        assert.equal(store().selectRun('collab').ok, true, 'the window works on collab');
        queue().setRunAutoSend('collab', true);
        queue().setRunAutoSend('default', false);
        const folder = getQueueFolder()!;
        const from = { quest: 'al_the_bear', run: 'workspace_restructuring', windowId: 'w-sender', host: os.hostname(), sentAt: new Date().toISOString() };
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'qp1a'), { text: 'delivered with pause after', pauseAfter: true, from });
        writeInboxFile(folder, inboxFileName(os.hostname(), getWorkspaceName(), new Date(), 'qp1b'), { text: 'delivered into collab', run: 'collab', from });
        // The take-up happens to run inside a send of collab (a process position): no inheritance either.
        const taken = await runInProcessPosition({ quest: QUEST, run: 'collab', state: { process: 'design', phase: 'p1', phaseIteration: 1, step: 'plan', stepIteration: 1, substep: '', substepIteration: 1, completed: false } } as never,
            () => queue().takeInbox());
        assert.equal(taken, 2);
        const first = queue().items.find((i) => i.originalText === 'delivered with pause after') as Json;
        const second = queue().items.find((i) => i.originalText === 'delivered into collab') as Json;
        assert.equal(first.run ?? 'default', 'default', 'no run named: default');
        assert.equal(second.run, 'collab', 'the run named is kept');
        // Its "pause after this" therefore holds default once it ran (the run it is in), never collab.
        assert.equal(first.pauseAfter, true);
        assert.equal(queue().runQueueSettings('collab').autoSend, true, 'the window\'s own run goes on');
        first.status = 'sent';
        second.status = 'sent';
        store().selectRun('default');
    });

    test('QP-2: only the runs this window changed are written, of its own quest', () => {
        // `elsewhere` (Auto-Start off) is held off in this window's memory since it started — never written so.
        assert.equal(queue().runQueueSettings('elsewhere').autoSend, false, 'held off in this window');
        // Another window switches q1's collab off meanwhile; this window then changes default only.
        const before = settingsFile();
        before['runs-by-quest'].q1.team = { 'auto-send-enabled': true };
        fs.writeFileSync(path.join(getQueueFolder()!, 'queue-settings.yaml'), YAML.stringify(before));
        queue().setRunQueueSettings('default', { walkContinuations: 7 });
        const file = settingsFile();
        assert.equal(file['runs-by-quest'].q1.default['walk-continuations'], 7, 'the change is written');
        assert.equal(file['runs-by-quest'].q1.elsewhere['auto-send-enabled'], true, 'a run held off here is not written off');
        assert.equal(file['runs-by-quest'].q1.team['auto-send-enabled'], true, 'what another window wrote stays');
        assert.deepEqual(file['runs-by-quest'].q2, { default: { 'auto-send-enabled': false, 'auto-start-enabled': false }, collab: { 'auto-send-enabled': true } }, 'another quest untouched');
        assert.equal(file.runs.collab['auto-send-enabled'], true, 'the old shared runs stay');
    });

    test('QP-3: the rules', () => {
        const legacy = { runs: { default: { 'auto-send-enabled': true }, x: { 'auto-send-enabled': false } } };
        const read = readQuestRunQueueSettings(legacy, 'qn');
        assert.equal(read.runs.get('x')?.autoSend, false, 'no entry: the shared runs');
        const written = questRunsInFile(legacy, 'qn', new Map([['y', { ...BUILTIN_RUN_QUEUE_SETTINGS, autoSend: true }]]), ['x']);
        assert.deepEqual(Object.keys(written.qn).sort(), ['default', 'y'], 'seeded from the shared runs, x dropped, y written');
        const two = { 'runs-by-quest': { a: { default: { 'auto-send-enabled': false } } } };
        const b = questRunsInFile(two, 'b', new Map([['default', { ...BUILTIN_RUN_QUEUE_SETTINGS, autoSend: true }]]));
        assert.equal((b.a.default as Json)['auto-send-enabled'], false, 'quest a kept');
        assert.equal((b.b.default as Json)['auto-send-enabled'], true);
        assert.equal(readQuestRunQueueSettings({ 'runs-by-quest': b }, 'a').runs.get('default')?.autoSend, false, 'each quest reads its own default');
        assert.equal(readQuestRunQueueSettings({ 'runs-by-quest': b }, 'b').runs.get('default')?.autoSend, true);
    });
});
