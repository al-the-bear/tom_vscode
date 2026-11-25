/**
 * Roles per todo, queue item and run default (gsel3), through the real process store, queue and chat variables
 * (nothing reaches a model). A stage runs as the role utils/promptRole.ts orders: todo > item > the process step
 * (a Proceed prompt and what it queued) > the run's default > the chat variable `role`.
 *
 *   QR-1 a Proceed prompt runs as its step's role; an item queued while that prompt runs inherits the position and
 *        runs as the step's role too, unless it names its own
 *   QR-2 a walk iteration's todo role beats the item's role: a pre-prompt runs as the todo its iteration is about to
 *        run, the main prompt as the claimed one, a follow-up as the iteration's; a todo without a role: the item's;
 *        an item that is no walk runs as the todo it ran (a TODO item)
 *   QR-3 the run's default role: for an item naming none and run by no step; a Proceed prompt keeps its step's role
 *   QR-4 the chat variable decides when nothing else names a role; the tools, `${role}` and `${role-description}`
 *        follow the same role
 *   QR-5 the chat variable `role` holds the queue's role while the item sends and is put back when it stops —
 *        sent, failed, interrupted or removed; a step's role does not touch it; two items overlap
 *   QR-6 the role is kept in the item's entry file and read back; the run default in the settings file
 *   QR-7 the tools: tomAi_addQueueItem / tomAi_updateQueueItem take `role` (an unknown or malformed one is refused),
 *        tomAi_createQuestTodo / tomAi_updateQuestTodo write the todo's `role`, tomAi_sendItemToQuest carries it
 *        in the inbox item the target enqueues
 *   QR-8 the editors: the queue editor's item chip and run default link, the todo panel's Role field
 *   QR-9 the wiring: every stage is expanded and sent with its role source; the hold before the send
 *   QR-10 shown (gsel11): the queue editor's role chip names the role an item runs as and where it comes from — a
 *        TODO item its todo's (read from the todo file, each quest once), its own, its step's, its run's default; a
 *        walk with no todo in hand says each todo's own wins; the live trail's prompt header names the role a
 *        prompt runs as (`· role writer (todo)`), nothing without one; the trail merge driver still splits those
 *        headers; the wiring
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261120_gsel3_roles-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
for (const role of ['stepper', 'writer', 'reviewer', 'planner', 'chatter', 'default']) { put(`_ai/roles/${role}/role.md`, `# The ${role} role\n`); }
put('_ai/processes/roled/roled.process.yaml', [
    'id: roled', 'name: roled', 'phases:',
    '  - id: p1', '    name: P1', '    steps:',
    '      - id: work', '        name: Work', '        role: stepper', '        prompt: Work on it.',
    '    gate:', '      id: g1', '      name: G1', '',
].join('\n'));
put('_ai/processes/roled/roled.md', '# roled\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
    `quest: ${QUEST}`, 'todos:',
    '  - id: t1_aktl-roled', '    title: Roled', '    description: D', '    status: not-started', '    role: writer',
    '  - id: t2_aktl-plain', '    title: Plain', '    description: D', '    status: not-started', '',
].join('\n'));
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TEST_RUN, useRun } from './_processTestRun.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { confirmProcessAction, installProcessMoveMarkers } from '../../services/processActionService.js';
import { runInProcessPosition } from '../../services/processRunContext.js';
import { livePromptRole, runWithQueueRole } from '../../services/queueRoleContext.js';
import { currentRoleTools } from '../../services/roleTools.js';
import { resolveVariables } from '../../utils/variableResolver.js';
import { findTodoById } from '../../managers/questTodoManager.js';
import {
    ADD_TO_PROMPT_QUEUE_TOOL as ADD_QUEUE_ITEM_TOOL,
    CREATE_TODO_TOOL as CREATE_QUEST_TODO_TOOL,
    UPDATE_TODO_TOOL as UPDATE_QUEST_TODO_TOOL,
    QUEUE_UPDATE_ITEM_TOOL as UPDATE_QUEUE_ITEM_TOOL,
} from '../chat-enhancement-tools.js';
import { sendItemToQuestImpl } from '../send-to-quest-tools.js';
import { parseInboxItem as parseInboxFile, planInboxConversion, serializeInboxItem } from '../../utils/questInbox.js';
import { parse as parseYaml } from 'yaml';
import { cachedTodoRoles } from '../../handlers/queueEditor-handler.js';
import { LiveTrailWriter, promptHeaderLines } from '../../services/live-trail.js';
import { mergeTrail } from '../../utils/aiMergeDrivers/trail.js';

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
const chat = (): ChatVariablesStore => ChatVariablesStore.instance;
const ok = (r: { ok: boolean }): void => { assert.equal(r.ok, true, JSON.stringify(r)); };
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');
type Internals = {
    _holdStageRole(item: QueuedPrompt | undefined, run: unknown, source: unknown): Promise<void>;
    _onDidChange: { fire(): void };
    persist(): void;
    _entryToQueuedPrompt(e: unknown): QueuedPrompt;
};
const internals = (): Internals => queue() as unknown as Internals;

/** What a stage of `item` runs as: the role, where it comes from, the tools' role, `${role}` and `${role-description}`. */
async function stageRole(item: QueuedPrompt, stage: 'prePrompt' | 'main' | 'followUp' = 'main', todoId?: string) {
    const source = queue().stageRoleSource(item, stage, todoId);
    return runInProcessPosition(item.processRun, () => runWithQueueRole(source, async () => ({
        ...livePromptRole(),
        tools: currentRoleTools().role,
        placeholder: resolveVariables('${role}'),
        text: resolveVariables('${role-description}').trim(),
    })));
}

async function add(text: string, extra: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const answer = JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text, run: TEST_RUN, ...extra } as never));
    assert.ok(answer.id, JSON.stringify(answer));
    return queue().items.find((i) => i.id === answer.id)!;
}

describe('roles per todo, item and run default', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        queue().setRunQueueSettings(TEST_RUN, { autoSend: false, defaultTransport: 'anthropic' });
        useRun(store());
        ok(store().apply({ process: 'roled' }, 'user'));
        chat().role = 'chatter';
    });

    test('QR-1: a Proceed prompt runs as its step\'s role, and what it queues inherits it', async () => {
        const before = new Set(queue().items.map((i) => i.id));
        const proceeded = await confirmProcessAction('proceed', undefined, '');
        assert.equal(proceeded.ok && proceeded.queued, true, JSON.stringify(proceeded));
        const proceedItem = queue().items.find((i) => !before.has(i.id) && !i.processMove)!;
        assert.ok(proceedItem.processRun, 'the Proceed prompt carries its position');
        const r = await stageRole(proceedItem);
        assert.deepEqual([r.role, r.from], ['stepper', 'step']);
        assert.deepEqual([r.tools, r.placeholder, r.text], ['stepper', 'stepper', '# The stepper role'], 'the tools, ${role} and the role text follow');
        // Queued while the Proceed prompt runs: the item inherits the position.
        const inherited = await runInProcessPosition(proceedItem.processRun, () => add('a walk the step queues'));
        assert.ok(inherited.processRun, 'inherits the position');
        assert.deepEqual(await stageRole(inherited).then((x) => [x.role, x.from]), ['stepper', 'step'], 'the step\'s role');
        const named = await runInProcessPosition(proceedItem.processRun, () => add('a review the step queues', { role: 'reviewer' }));
        assert.deepEqual(await stageRole(named).then((x) => [x.role, x.from]), ['reviewer', 'item'], 'its own role beats the step\'s');
    });

    test('QR-2: the todo\'s role beats the item\'s, at every stage of its iteration', async () => {
        const walk = await add('walk ${repeatTodoId}', { role: 'reviewer', repeatCount: 't*' });
        assert.deepEqual(await stageRole(walk, 'prePrompt').then((x) => [x.role, x.from]), ['writer', 'todo'], 'a pre-prompt: the todo its iteration is about to run (t1)');
        assert.deepEqual(await stageRole(walk, 'main', 't1_aktl-roled').then((x) => [x.role, x.from]), ['writer', 'todo'], 'main: the claimed todo\'s role');
        walk.repeatTodoId = 't1_aktl-roled';
        assert.deepEqual(await stageRole(walk, 'followUp').then((x) => [x.role, x.from, x.placeholder]), ['writer', 'todo', 'writer'], 'a follow-up of the iteration');
        assert.deepEqual(await stageRole(walk, 'main').then((x) => [x.role, x.from]), ['writer', 'todo'], 'a resend or continuation of the main prompt');
        walk.repeatTodoId = 't2_aktl-plain';
        assert.deepEqual(await stageRole(walk, 'followUp').then((x) => [x.role, x.from]), ['reviewer', 'item'], 'a todo without a role: the item\'s');
        // An item that is no walk (a TODO item) runs as the todo it ran.
        const single = await add('one todo', { role: 'reviewer' });
        single.repeatTodoId = 't1_aktl-roled';
        assert.deepEqual(await stageRole(single, 'main').then((x) => [x.role, x.from]), ['writer', 'todo']);
        // A todo role inside a Proceed run still wins over the step.
        const stepWalk = (queue().items.find((i) => i.originalText === 'a walk the step queues'))!;
        assert.deepEqual(await stageRole(stepWalk, 'main', 't1_aktl-roled').then((x) => [x.role, x.from]), ['writer', 'todo']);
    });

    test('QR-3: the run\'s default role', async () => {
        queue().setDefaultRole('planner', TEST_RUN);
        assert.equal(queue().runQueueSettings(TEST_RUN).defaultRole, 'planner');
        const plain = await add('plain');
        assert.deepEqual(await stageRole(plain).then((x) => [x.role, x.from]), ['planner', 'runDefault'], 'an item naming none');
        const reviewer = await add('reviewed', { role: 'reviewer' });
        assert.deepEqual(await stageRole(reviewer).then((x) => [x.role, x.from]), ['reviewer', 'item'], 'the item\'s own beats it');
        const proceedItem = queue().items.find((i) => i.processRun && !i.processMove && i.originalText.includes('Work on it'))!;
        assert.deepEqual(await stageRole(proceedItem).then((x) => [x.role, x.from]), ['stepper', 'step'], 'a Proceed prompt keeps its step\'s');
        queue().setDefaultRole('', TEST_RUN);
        assert.equal(queue().runQueueSettings(TEST_RUN).defaultRole, 'default', '"" goes back to the role default');
    });

    test('QR-4: every run has a default role, `default` unless chosen; the chat variable outside the queue', async () => {
        const plain = await add('plain again');
        const r = await stageRole(plain);
        assert.deepEqual([r.role, r.from, r.tools, r.placeholder, r.text], ['default', 'runDefault', 'default', 'default', '# The default role'],
            'the run\'s default role `default` is a role: the chat variable is not asked');
        assert.deepEqual(livePromptRole(), { role: 'chatter', from: 'chat' }, 'outside the queue');
    });

    test('QR-5: the chat variable holds the queue\'s role while the item sends and is put back', async () => {
        const q = internals();
        chat().role = 'chatter';
        const one = await add('one', { role: 'reviewer' });
        one.status = 'sending';
        await q._holdStageRole(one, one.processRun, queue().stageRoleSource(one, 'main'));
        assert.equal(chat().role, 'reviewer', 'held while it sends');
        const two = await add('two', { role: 'writer' });
        two.status = 'sending';
        await q._holdStageRole(two, two.processRun, queue().stageRoleSource(two, 'main'));
        assert.equal(chat().role, 'writer', 'the newest of two overlapping items');
        one.status = 'sent'; q._onDidChange.fire();
        assert.equal(chat().role, 'writer', 'the other still sends');
        two.status = 'error'; q._onDidChange.fire();
        assert.equal(chat().role, 'chatter', 'back after the last, also after an error');
        // Interrupted and removed.
        const three = await add('three', { role: 'planner' });
        three.status = 'sending';
        await q._holdStageRole(three, three.processRun, queue().stageRoleSource(three, 'main'));
        assert.equal(chat().role, 'planner');
        three.status = 'interrupted' as never; q._onDidChange.fire();
        assert.equal(chat().role, 'chatter', 'an interrupt gives it back');
        const four = await add('four', { role: 'planner' });
        four.status = 'sending';
        await q._holdStageRole(four, four.processRun, queue().stageRoleSource(four, 'main'));
        queue().remove(four.id);
        assert.equal(chat().role, 'chatter', 'a removal gives it back');
        // A step's role does not touch the chat variable.
        const stepItem = queue().items.find((i) => i.processRun && !i.processMove && i.originalText.includes('Work on it'))!;
        stepItem.status = 'sending';
        await q._holdStageRole(stepItem, stepItem.processRun, queue().stageRoleSource(stepItem, 'main'));
        assert.equal(chat().role, 'chatter', 'the step\'s role is not shown in the chat variable');
        stepItem.status = 'staged'; q._onDidChange.fire();
        // The user changes the role by hand meanwhile: kept.
        const five = await add('five', { role: 'reviewer' });
        five.status = 'sending';
        await q._holdStageRole(five, five.processRun, queue().stageRoleSource(five, 'main'));
        chat().role = 'planner';
        five.status = 'sent'; q._onDidChange.fire();
        assert.equal(chat().role, 'planner', 'the user\'s choice stays');
        chat().role = 'chatter';
    });

    test('QR-6: kept in the entry file and the settings file', () => {
        const item = queue().items.find((i) => i.role === 'reviewer' && i.originalText === 'reviewed')!;
        internals().persist();
        const dir = path.join(WS, '_ai', 'queue');
        const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes(`id: ${item.id}`))!;
        const doc = parseYaml(fs.readFileSync(file, 'utf8'));
        assert.equal(doc['prompt-queue'][0].role, 'reviewer');
        assert.equal(internals()._entryToQueuedPrompt({ fileName: path.basename(file), doc }).role, 'reviewer', 'read back');
        queue().setDefaultRole('planner', TEST_RUN);
        const settings = fs.readFileSync(path.join(WS, '_ai', 'queue', 'queue-settings.yaml'), 'utf8');
        assert.match(settings, /default-role: planner/);
        queue().setDefaultRole(undefined, TEST_RUN);
    });

    test('QR-7: the tools', async () => {
        // tomAi_addQueueItem: an unknown or malformed role is refused.
        assert.match(JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'x', role: 'nobody' } as never)).error, /role "nobody" is not a role of _ai\/roles\/ \(the roles: chatter, default, planner, reviewer, stepper, writer\)/);
        assert.match(JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'x', role: 'two words' } as never)).error, /role must be a role folder name/);
        // tomAi_updateQueueItem: set, change, clear.
        const item = await add('to update');
        await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, role: 'writer' } as never);
        assert.equal(queue().items.find((i) => i.id === item.id)!.role, 'writer');
        assert.match(await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, role: 'nobody' } as never), /not a role/);
        await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, role: '' } as never);
        assert.equal(queue().items.find((i) => i.id === item.id)!.role, undefined, '"" clears it');
        // tomAi_createQuestTodo / tomAi_updateQuestTodo.
        const created = JSON.parse(await CREATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todo: { id: 't3_aktl-made', title: 'Made', description: 'D', status: 'not-started', role: 'planner' } } as never));
        assert.equal(created.ok, true, JSON.stringify(created));
        assert.equal(findTodoById(QUEST, 't3_aktl-made')?.role, 'planner');
        assert.match(fs.readFileSync(path.join(WS, '_ai', 'quests', QUEST, `todos.${QUEST}.todo.yaml`), 'utf8'), /role: planner/);
        assert.match(await CREATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todo: { id: 't4_aktl-bad', title: 'Bad', description: 'D', status: 'not-started', role: 'nobody' } } as never), /not a role/);
        await UPDATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todoId: 't3_aktl-made', updates: { role: 'writer' } } as never);
        assert.equal(findTodoById(QUEST, 't3_aktl-made')?.role, 'writer');
        await UPDATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todoId: 't3_aktl-made', updates: { role: '' } } as never);
        assert.equal(findTodoById(QUEST, 't3_aktl-made')?.role, undefined, '"" removes it');
        // tomAi_sendItemToQuest: carried in the inbox item, which the target enqueues with it.
        let delivered: unknown;
        const access = {
            currentQuest: () => QUEST, currentRun: () => 'default', runExists: () => true, questExists: () => true, profileExists: () => true,
            listSessions: () => [], liveWindows: () => [{ windowId: 'w', workspace: 'other' }], sender: () => ({ windowId: 'me', host: 'h' }),
            deliver: (_ws: string, i: unknown) => { delivered = i; return '/x'; }, rolesDir: () => path.join(WS, '_ai', 'roles'), now: () => new Date(),
        };
        const sent = JSON.parse(await sendItemToQuestImpl(access as never, { quest: 'other', text: 'hi', role: 'reviewer' } as never));
        assert.equal(sent.ok, true, JSON.stringify(sent));
        assert.equal((delivered as { role?: string }).role, 'reviewer');
        assert.match(await sendItemToQuestImpl(access as never, { quest: 'other', text: 'hi', role: 'nobody' } as never), /unknownRole/);
        const round = parseInboxFile(serializeInboxItem(delivered as never));
        assert.equal(round.ok && round.item.role, 'reviewer', 'written and read back from the inbox file');
        const plan = planInboxConversion((round as unknown as { item: never }).item, { profileExists: () => true, readSession: () => undefined, now: new Date(), token: 'x' });
        assert.equal(plan.enqueue.role, 'reviewer', 'the target enqueues it with its role');
    });

    test('QR-8: the editors', () => {
        const render = EXT('media', 'shared', 'queueEntryRenderFunctions.js');
        assert.match(render, /queue-role-chip[\s\S]*editItemRole\(/);
        assert.match(EXT('media', 'shared', 'queueEntryMessageHandlers.js'), /function editItemRole\(id\) \{\n[^\n]*\n\s*vscode\.postMessage\(\{ type: 'editItemRole', id: id \}\);/);
        const editor = EXT('src', 'handlers', 'queueEditor-handler.ts');
        assert.match(editor, /case 'pickQueueDefaultRole':\n\s*case 'editItemRole':[\s\S]*pqm\.setDefaultRole\(picked\.role, run\)[\s\S]*pqm\.updateItemRole\(id, picked\.role\)/);
        const queueMain = EXT('media', 'queueEditor', 'main.js');
        assert.match(queueMain, /pick === 'defaultRole' \? \{ type: 'pickQueueDefaultRole', run: settingsRun\(\) \}/);
        assert.match(queueMain, /field\(el, 'Default role', link\('defaultRole', settings\.defaultRole \|\| 'default'/);
        assert.match(queueMain, /'defaultMessageTemplateId', 'defaultRole'\];/, 'Make default copies it');
        const panel = EXT('media', 'questTodoPanel', 'main.js');
        assert.match(panel, /qtFormRow\('Role', '<select id="qt-d-role"[^\n]*qtRoleOptions\(todo\.role\)/, 'the detail form');
        assert.match(panel, /qtFormRow\('Role', '<select id="qt-d-role"[^\n]*qtRoleOptions\(''\)/, 'the new-todo form');
        assert.match(panel, /role: document\.getElementById\('qt-d-role'\) \? document\.getElementById\('qt-d-role'\)\.value : undefined/);
        assert.match(panel, />Default role<\/option>/);
        assert.match(EXT('src', 'handlers', 'questTodoPanel-handler.ts'), /case 'qtGetRoles': \{[\s\S]*post\(\{ type: 'qtRoles', roles: listRoleNames\(WsPaths\.ai\('roles'\)\) \}\)/);
    });

    test('QR-9: the wiring', () => {
        const src = EXT('src', 'managers', 'promptQueueManager.ts');
        const dispatch = src.slice(src.indexOf('    private async dispatchStage('), src.indexOf('\n    }\n', src.indexOf('    private async dispatchStage(')));
        assert.ok(dispatch.indexOf('await this._holdStageRole(stageItem, resolved.processRun, roleSource);') < dispatch.indexOf("if (resolved.transport === 'copilot')"), 'held before either transport');
        assert.match(dispatch, /runInProcessPosition\(resolved\.processRun, \(\) => runWithQueueRole\(roleSource, \(\) => AnthropicHandler\.instance\.sendMessage\(/);
        for (const stage of ["'prePrompt'", "'main', iterationTodo?.id", "'followUp'"]) {
            assert.ok(src.includes(`runInProcessPosition(item.processRun, () => runWithQueueRole(this.stageRoleSource(item, ${stage}), () => this._buildExpandedText(`), `expansion of ${stage}`);
        }
        assert.match(src, /m\._onDidChange\.event\(\(\) => m\._syncRoleHolds\(\)\)/, 'released on every change');
    });

    test('QR-10: the role chip and the trail header name the role and where it comes from', async () => {
        const roles = cachedTodoRoles();
        assert.equal(roles(QUEST, 't1_aktl-roled'), 'writer', 'read from the todo file');
        assert.equal(roles(QUEST, 't2_aktl-plain'), undefined);
        const view = (item: QueuedPrompt) => queue().roleViewOf(item, roles);
        // A TODO item: its todo's role, over its own.
        const todoItem = await add('a todo item', { role: 'reviewer' });
        todoItem.repeatCount = `todo:${QUEST}/t1_aktl-roled` as never;
        const fromTodo = view(todoItem);
        assert.deepEqual([fromTodo.role, fromTodo.from, fromTodo.note], ['writer', 'todo', '· from its todo']);
        assert.match(fromTodo.title, /^Runs as role writer — from the todo it runs\. Its own role reviewer is passed over\./);
        assert.match(fromTodo.title, /The order: the todo's role > the item's role > the process step's > the run's default > the chat variable role\./);
        assert.deepEqual([view(todoItem).role], [queue().roleViewOf(todoItem).role], 'the default reader agrees');
        // A TODO item whose todo names none: its own.
        const plainTodo = await add('a plain todo item', { role: 'reviewer' });
        plainTodo.repeatCount = `todo:${QUEST}/t2_aktl-plain` as never;
        assert.deepEqual([view(plainTodo).role, view(plainTodo).from, view(plainTodo).note], ['reviewer', 'item', '']);
        // The run's default.
        queue().setDefaultRole('planner', TEST_RUN);
        const none = await add('names none');
        assert.deepEqual([view(none).role, view(none).from, view(none).note], ['planner', 'runDefault', '· run default']);
        assert.match(view(none).title, /the default role of its run/);
        // The Proceed prompt: its step's.
        const proceedItem = queue().items.find((i) => i.processRun && !i.processMove && i.originalText.includes('Work on it'))!;
        assert.deepEqual([view(proceedItem).role, view(proceedItem).from, view(proceedItem).note], ['stepper', 'step', '· process step']);
        queue().setDefaultRole('', TEST_RUN);
        // A walk with no todo in hand: none known, each todo's own wins; once it has one, that one's.
        const walk = await add('walk t2 ${repeatTodoId}', { repeatCount: 't2_*' });
        assert.deepEqual([view(walk).role, view(walk).from, view(walk).perTodo], ['default', 'runDefault', true]);
        assert.match(view(walk).title, /^Runs as role default — the default role of its run\. A walk: the todo it runs names its own role/);
        walk.todoClaim = { questId: QUEST, todoId: 't1_aktl-roled' } as never;
        assert.deepEqual([view(walk).role, view(walk).from], ['writer', 'todo'], 'the claimed todo while it runs');
        walk.todoClaim = undefined;
        walk.status = 'sent'; walk.repeatTodoId = 't1_aktl-roled';
        assert.deepEqual([view(walk).role, view(walk).from], ['writer', 'todo'], 'a finished walk: the last todo it ran');

        // The live trail's header: the role the prompt runs as, where it comes from; nothing without one.
        const header = (role: ReturnType<typeof livePromptRole> | undefined): string => {
            const w = new LiveTrailWriter(QUEST, undefined, `gsel11_${Math.random().toString(36).slice(2)}`);
            w.beginPrompt({ transport: 'direct', config: 'opus-5-5-direct', userText: 'x', role });
            return fs.readFileSync(w.getFilePath(), 'utf8').split('\n').find((l) => l.startsWith('## \u{1F680} PROMPT '))!;
        };
        const queued = await runWithQueueRole(queue().stageRoleSource(todoItem, 'main', 't1_aktl-roled'), async () => header(livePromptRole()));
        assert.match(queued, /^## \u{1F680} PROMPT \d{8}_\d{6} \[direct \/ opus-5-5-direct · role writer \(todo\)\]$/u);
        assert.match(await runWithQueueRole(queue().stageRoleSource(none, 'main'), async () => header(livePromptRole())), /\[direct \/ opus-5-5-direct · role default \(run default\)\]$/);
        assert.match(header({ role: 'reviewer', from: 'item' }), /· role reviewer \(item\)\]$/);
        assert.match(header({ role: 'planner', from: 'runDefault' }), /· role planner \(run default\)\]$/);
        assert.match(header({ role: 'stepper', from: 'step' }), /· role stepper \(process step\)\]$/);
        assert.match(header({ role: '', from: 'none' }), /^## \u{1F680} PROMPT \d{8}_\d{6} \[direct \/ opus-5-5-direct\]$/u, 'no role: nothing added');
        assert.match(header(undefined), /\[direct \/ opus-5-5-direct\]$/);
        // Still a prompt block for the writer's trimming and the _ai trail merge driver.
        const block = (ts: string, role: string, body: string): string => `## \u{1F680} PROMPT ${ts} [direct / opus · role ${role} (todo)]\n\n${body}\n`;
        const ours = `<!-- tom-ai live-trail -->\n\n${block('20261121_100000', 'writer', 'ours')}`;
        const theirs = `<!-- tom-ai live-trail -->\n\n${block('20261121_090000', 'idea_author', 'theirs')}\n${block('20261121_100000', 'writer', 'ours longer')}`;
        const merged = mergeTrail({ ours, theirs });
        assert.equal(merged.status, 'merged', JSON.stringify(merged));
        const text = (merged as { text: string }).text;
        assert.equal(promptHeaderLines(text.split('\n')).length, 2, 'two blocks');
        assert.ok(text.indexOf('role idea_author') < text.indexOf('role writer'), 'sorted by time');
        assert.match(text, /role writer \(todo\)\]\n\nours longer/, 'one block per prompt, the longer side');

        // The wiring: the editor's state carries the view; the Anthropic send names the role.
        assert.match(EXT('src', 'handlers', 'queueEditor-handler.ts'), /const todoRoleOf = cachedTodoRoles\(\);[\s\S]*roleView: PromptQueueManager\.instance\.roleViewOf\(item, todoRoleOf\)/);
        assert.match(EXT('src', 'handlers', 'anthropic-handler.ts'), /liveTrail\?\.beginPrompt\(\{[\s\S]{0,600}role: livePromptRole\(\),\n\s*\}\);/);
        assert.match(EXT('media', 'shared', 'queueEntryRenderFunctions.js'), /\(!isChat \? queueRoleChip\(item, safeId, isStaged \|\| isPending\) : ''\)/);
    });
});
