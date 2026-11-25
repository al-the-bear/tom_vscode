/**
 * A queue item's own profile, set from its header (PromptQueueManager.setItemProfile, resolvedProfileOf), on the
 * real manager in a sandbox root.
 *
 *   IP-1 an item without a profile runs with the queue default: resolvedProfileOf names it; the item itself
 *        carries none
 *   IP-2 setItemProfile gives it any profile, Agent SDK or direct API: the Anthropic transport, that profile,
 *        the profile's own configuration (an item-level configuration is dropped), an out-of-budget fallback
 *        ended; a pending item too; `undefined` takes it away again (back to the queue default)
 *   IP-3 refused, nothing changed: an unknown profile, a finished item
 *   IP-4 a profile that cannot continue the conversation of the item's session is refused naming the session;
 *        with `defaultSession` the item gets the profile and runs in the queue's default session
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_itemprofile_queue-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
// A root of its own, so nothing resolves to the real workspace.
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
// The configuration is the root's.
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        profiles: [
            { id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk', isDefault: true },
            { id: 'api', name: 'API', systemPrompt: '', configurationId: 'c-api' },
        ],
        configurations: [
            { id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' },
            { id: 'c-api', name: 'Direct', model: 'claude-test', transport: 'direct' },
        ],
    },
}, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;


import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
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
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
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
const live = (id: string): Json => queue().getById(id);
const add = async (opts: Record<string, unknown> = {}): Promise<Json> => queue().enqueue({ originalText: 'do it', deferSend: true, ...opts } as never);

describe('queue item: its own profile', () => {
    test('IP-1: without one it runs with the queue default', async () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
        const item = await add();
        assert.equal(live(item.id).anthropicProfileId, undefined);
        assert.deepEqual(queue().resolvedProfileOf(item.id), { transport: 'anthropic', anthropicProfileId: 'sdk' });
        assert.equal(queue().resolvedProfileOf('nope'), undefined);
    });

    test('IP-2: any profile, and back', async () => {
        const item = await add({ transport: 'anthropic', anthropicProfileId: 'sdk', anthropicConfigId: 'c-sdk' });
        live(item.id).budgetFallback = { fromProfileId: 'sdk', toProfileId: 'api' };
        assert.deepEqual(queue().setItemProfile(item.id, 'api'), { ok: true });
        assert.equal(live(item.id).transport, 'anthropic');
        assert.equal(live(item.id).anthropicProfileId, 'api');
        assert.equal(live(item.id).anthropicConfigId, undefined, 'the profile\'s own configuration applies');
        assert.equal(live(item.id).budgetFallback, undefined);
        assert.deepEqual(queue().resolvedProfileOf(item.id), { transport: 'anthropic', anthropicProfileId: 'api' });
        assert.deepEqual(queue().setItemProfile(item.id, 'sdk'), { ok: true }, 'and an Agent SDK one');
        assert.equal(live(item.id).anthropicProfileId, 'sdk');

        const pending = await add({ initialStatus: 'pending' });
        assert.equal(live(pending.id).status, 'pending');
        assert.deepEqual(queue().setItemProfile(pending.id, 'api'), { ok: true });
        assert.equal(live(pending.id).anthropicProfileId, 'api');

        assert.deepEqual(queue().setItemProfile(item.id, undefined), { ok: true });
        assert.equal(live(item.id).transport, undefined);
        assert.equal(live(item.id).anthropicProfileId, undefined);
        assert.deepEqual(queue().resolvedProfileOf(item.id), { transport: 'anthropic', anthropicProfileId: 'sdk' }, 'the queue default again');
    });

    test('IP-3: refused', async () => {
        const item = await add({ transport: 'anthropic', anthropicProfileId: 'sdk' });
        const unknown = queue().setItemProfile(item.id, 'nope');
        assert.equal(unknown.ok, false);
        assert.match((unknown as Json).reason, /no Anthropic profile "nope"/);
        assert.equal(live(item.id).anthropicProfileId, 'sdk');
        live(item.id).status = 'sent';
        assert.deepEqual(queue().setItemProfile(item.id, 'api'), { ok: false, reason: 'the item has finished' });
        assert.equal(live(item.id).anthropicProfileId, 'sdk');
        assert.deepEqual(queue().setItemProfile('nope', 'api'), { ok: false, reason: 'no such item' });
    });

    test('IP-4: a session the profile cannot continue', async () => {
        const item = await add({ transport: 'anthropic', anthropicProfileId: 'sdk', session: 'talk' });
        // The session has an Agent SDK conversation: a direct-API profile keeps its own history and cannot continue it.
        const { TwoTierMemoryService } = await import('../../services/memory-service.js');
        const folder = TwoTierMemoryService.instance.agentSdkSessionsFolder(QUEST);
        fs.mkdirSync(folder, { recursive: true });
        const file = fs.readdirSync(folder).find((f) => f.startsWith('talk') && f.endsWith('.session.json')) ?? 'talk.session.json';
        const record = fs.existsSync(path.join(folder, file)) ? JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) : { name: 'talk', mode: 'continue' };
        fs.writeFileSync(path.join(folder, file), JSON.stringify({ ...record, sessionId: 'sdk-session-1' }));

        const refused = queue().setItemProfile(item.id, 'api') as Json;
        assert.equal(refused.ok, false);
        assert.equal(refused.sessionMismatch, live(item.id).session);
        assert.match(refused.reason, /cannot continue it/);
        assert.equal(live(item.id).anthropicProfileId, 'sdk', 'nothing changed');

        assert.deepEqual(queue().setItemProfile(item.id, 'api', { defaultSession: true }), { ok: true });
        assert.equal(live(item.id).anthropicProfileId, 'api');
        assert.equal(live(item.id).session, undefined, 'the queue\'s default session');
    });
});
