/**
 * Apply run defaults to all items (the queue editor's button; src/utils/queueRunDefaultsApply.ts,
 * PromptQueueManager.applyRunDefaultsToItems).
 *
 *   RDA-1 the helper: set writes the run's profile (transport, profile, configuration), template, session
 *         (`<session>@<run>` outside the default run) and role; clear removes the item's own values (the
 *         template: the run's default); only the picked fields; the changed fields answered; an unknown field ignored
 *   RDA-2 the picker lines name the run's current defaults; the summary says what was done and what was left
 *   RDA-3 on a real queue: every staged and pending item of the run gets the picked defaults, items of another
 *         run and items that already started stay as they are; clear removes them; a template change rebuilds
 *         the item's text; nothing picked changes nothing
 */

/* eslint-disable @typescript-eslint/naming-convention */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-run-defaults-')));
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
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import {
    applyRunDefaultsToItem, runDefaultFieldsOf, runDefaultPickerEntries, runDefaultsApplySummary, NO_TEMPLATE,
    type RunDefaultsSource, type RunDefaultsTarget,
} from '../../utils/queueRunDefaultsApply.js';

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

const queue = (): PromptQueueManager => PromptQueueManager.instance;
function clear(): void { for (const i of [...queue().items]) { queue().remove(i.id); } }

const DEFAULTS: RunDefaultsSource = {
    defaultTransport: 'anthropic', defaultAnthropicProfileId: 'opus', defaultAnthropicConfigId: 'cfg',
    defaultAgentSdkSession: 'work', defaultMessageTemplateId: 'execute-todo', defaultRole: 'reviewer',
};

describe('apply run defaults to all items', () => {
    test('RDA-1: the helper', () => {
        const item: RunDefaultsTarget = { transport: 'copilot', template: 'other', session: 'mine', sessionCreate: { name: 'mine' }, role: 'writer' };
        assert.deepEqual(applyRunDefaultsToItem(item, DEFAULTS, 'collab', ['profile', 'template', 'session', 'role'], 'set'), ['profile', 'template', 'session', 'role']);
        assert.deepEqual(item, { transport: 'anthropic', anthropicProfileId: 'opus', anthropicConfigId: 'cfg', template: 'execute-todo', session: 'work@collab', role: 'reviewer' });
        assert.deepEqual(applyRunDefaultsToItem(item, DEFAULTS, 'collab', ['profile', 'role'], 'set'), [], 'already the defaults');
        assert.deepEqual(applyRunDefaultsToItem(item, DEFAULTS, 'collab', ['role', 'template'], 'clear'), ['template', 'role'], 'only the picked fields, in picker order');
        assert.deepEqual([item.role, item.template, item.session], [undefined, '(Run default)', 'work@collab']);
        applyRunDefaultsToItem(item, DEFAULTS, 'collab', ['profile', 'session'], 'clear');
        assert.deepEqual(item, { template: '(Run default)' }, 'clear removes the item\'s own profile and session');
        const plain: RunDefaultsTarget = {};
        applyRunDefaultsToItem(plain, {}, 'default', ['profile', 'template', 'session', 'role'], 'set');
        assert.deepEqual(plain, { transport: 'copilot', template: NO_TEMPLATE, session: 'default@default' }, 'a run without defaults');
        assert.deepEqual(runDefaultFieldsOf(['role', 'bogus', 'profile', 'role', undefined]), ['profile', 'role']);
    });

    test('RDA-2: picker lines and summary', () => {
        assert.deepEqual(runDefaultPickerEntries(DEFAULTS, 'collab').map((e) => [e.field, e.description]), [
            ['profile', 'Anthropic · opus · cfg'], ['template', 'execute-todo'], ['session', 'work@collab'], ['role', 'reviewer'],
        ]);
        assert.deepEqual(runDefaultPickerEntries({}, 'default').map((e) => e.description), ['Copilot', 'no template', 'default@default', 'no default role']);
        assert.equal(runDefaultsApplySummary({ run: 'collab', mode: 'set', fields: ['profile', 'role'], changed: 3, unchanged: 1, notEditable: 2, refused: [] }),
            'Run collab\'s defaults (profile, role) set on 3 items; 1 item already matched; 2 items that already started left as they are.');
        assert.equal(runDefaultsApplySummary({ run: 'default', mode: 'clear', fields: ['session'], changed: 1, unchanged: 0, notEditable: 0, refused: [{ id: 'x', reason: 'No.' }] }),
            'Per-item settings (session) removed on 1 item; 1 item left as they were: No.');
    });

    test('RDA-3: on a real queue', async () => {
        clear();
        queue().setRunQueueSettings('collab', { defaultTransport: 'copilot', defaultRole: 'reviewer', defaultMessageTemplateId: '' });
        const a = await queue().enqueue({ originalText: 'first', transport: 'copilot', deferSend: true, run: 'collab', role: 'writer', template: 'other' } as never);
        const b = await queue().enqueue({ originalText: 'second', transport: 'copilot', deferSend: true, run: 'collab' } as never);
        b.status = 'pending';
        const started = await queue().enqueue({ originalText: 'started', transport: 'copilot', deferSend: true, run: 'collab', role: 'writer' } as never);
        started.status = 'sending';
        const other = await queue().enqueue({ originalText: 'other run', transport: 'copilot', deferSend: true, run: 'another', role: 'writer' } as never);

        const set = await queue().applyRunDefaultsToItems('collab', ['role', 'template'], 'set');
        assert.deepEqual([set.changed, set.unchanged, set.notEditable, set.refused.length], [2, 0, 1, 0]);
        const find = (id: string) => queue().items.find((i) => i.id === id)!;
        assert.deepEqual([find(a.id).role, find(a.id).template], ['reviewer', NO_TEMPLATE]);
        assert.equal(find(b.id).role, 'reviewer');
        assert.equal(find(started.id).role, 'writer', 'an item that started stays');
        assert.equal(find(other.id).role, 'writer', 'another run\'s item stays');
        assert.equal(find(a.id).expandedText?.includes('first'), true, 'the text rebuilt without the old template');

        const cleared = await queue().applyRunDefaultsToItems('collab', ['role'], 'clear');
        assert.equal(cleared.changed, 2);
        assert.equal(find(a.id).role, undefined, 'the item follows the run\'s default role again');
        const none = await queue().applyRunDefaultsToItems('collab', [], 'set');
        assert.equal(none.changed + none.unchanged, 0, 'nothing picked: nothing done');
        clear();
    });

    test('RDA-4: move items to another run', async () => {
        clear();
        queue().setRunQueueSettings('target', { defaultTransport: 'copilot', defaultMessageTemplateId: '' });
        const a = await queue().enqueue({ originalText: 'move me', transport: 'anthropic', anthropicProfileId: 'opus', deferSend: true, run: 'collab', role: 'writer', template: 'other', session: 'mine@collab' } as never);
        const started = await queue().enqueue({ originalText: 'started', transport: 'copilot', deferSend: true, run: 'collab' } as never);
        started.status = 'sending';
        const r = await queue().moveItemsToRun([a.id, started.id, 'nope'], 'target');
        const find = (id: string) => queue().items.find((i) => i.id === id)!;
        assert.deepEqual(r.moved, [a.id]);
        assert.deepEqual(r.refused.map((x) => x.id).sort(), ['nope', started.id].sort());
        const moved = find(a.id);
        assert.equal(moved.run, 'target');
        assert.deepEqual([moved.transport, moved.anthropicProfileId, moved.role, moved.session, moved.template], [undefined, undefined, undefined, undefined, '(Run default)'],
            'the item follows the target run\'s defaults');
        assert.equal(find(started.id).run, 'collab', 'an item that started stays');
        clear();
    });
});
