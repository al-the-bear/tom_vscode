/**
 * Guideline choices per level (gsel4), through the real queue, todo store, extension config and role files (nothing
 * reaches a model). `_ai/aspect_guidelines/` has a system section `language` (default `en`, options `de`, `en`) and a
 * user section `night` (default `off`, options `on`, `off`). The levels, lowest winning: section default, quest
 * default, window, run, role type, role, item, todo.
 *
 *   GL-1 every level is stored where it belongs and decides when it is the lowest that chooses; the selection names
 *        the level; a todo's `remove` sends nothing for its section; the Copilot text follows
 *   GL-2 the window level is machine-local per quest and read back from its file (a reload reads the same file)
 *   GL-3 Set as quest default copies the window's choices into the shared file; Clear quest default empties it
 *   GL-4 the all-windows change: this window's level now, every other open window on this machine through a window
 *        request that sets only that section; windows of another machine or with a stale heartbeat are left
 *   GL-5 the tools: tomAi_addQueueItem / tomAi_updateQueueItem, tomAi_createQuestTodo / tomAi_updateQuestTodo and
 *        tomAi_sendItemToQuest take `guidelines`, refuse an unknown section or option, and clear with {}; the inbox
 *        carries them
 *   GL-6 tomAi_getAspectGuidelines: sections, options, each level's choices and the selection with its origins, cut
 *        at a level
 *   GL-7 kept in the item's entry file and the run's settings; the role files keep their choices when the editors
 *        save; the role schemas accept them
 *   GL-8 the wiring: the queue's Copilot send, the direct send and both chat panels take their levels
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261121_gsel4_levels-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';

function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/aspect_guidelines/language/aspect.yaml', 'name: Language\ndefault: en\nchoices: [de, en]\n');
put('_ai/aspect_guidelines/language/de.md', 'LANG-DE: answer in German.\n');
put('_ai/aspect_guidelines/language/en.md', 'LANG-EN: answer in English.\n');
put('_ai/aspect_guidelines/night/aspect.yaml', 'name: Night\nplacement: user\ndefault: off\nchoices: [on, off]\n');
put('_ai/aspect_guidelines/night/on.md', 'NIGHT-ON: nobody is there.\n');
put('_ai/aspect_guidelines/night/off.md', 'NIGHT-OFF: the user is there.\n');
put('_ai/role-types/author/role-type.yaml', 'tools:\n  mode: profileDefault\nguidelines:\n  night: off\n');
put('_ai/roles/writer/role.md', '# The writer role\n');
put('_ai/roles/writer/role-config.yaml', 'roleType: author\nguidelines:\n  language: de\n');
put('_ai/roles/plain/role.md', '# The plain role\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
    `quest: ${QUEST}`, 'todos:',
    '  - id: t1_aktl-chosen', '    title: Chosen', '    description: D', '    status: not-started',
    '    guidelines:', '      language: remove',
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
import { findTodoById } from '../../managers/questTodoManager.js';
import { machineConfigPath, questConfigPath } from '../../managers/extensionConfigStore.js';
import {
    ADD_TO_PROMPT_QUEUE_TOOL as ADD_QUEUE_ITEM_TOOL,
    CREATE_TODO_TOOL as CREATE_QUEST_TODO_TOOL,
    UPDATE_TODO_TOOL as UPDATE_QUEST_TODO_TOOL,
    QUEUE_UPDATE_ITEM_TOOL as UPDATE_QUEUE_ITEM_TOOL,
} from '../chat-enhancement-tools.js';
import { sendItemToQuestImpl } from '../send-to-quest-tools.js';
import { GET_ASPECT_GUIDELINES_TOOL, liveSectionsReader } from '../aspect-guideline-tools.js';
import { parseInboxItem, planInboxConversion, serializeInboxItem } from '../../utils/questInbox.js';
import {
    chatPanelChoices, chatSendAspectChoices, clearQuestDefault, liveAspectChoices, openWindowsOnThisMachine, questDefaultChoices,
    setChatPanelChoices, setQuestDefaultChoices, setQuestDefaultFromWindow, setSectionChoiceInAllWindows, setWindowChoices,
    setWindowSectionChoice, windowChoices,
} from '../../services/aspectChoiceLevels.js';
import { readAspectSections, withAspectsForCopilot } from '../../services/aspectGuidelinesStore.js';
import { resolveAspects, type AspectLevelChoices } from '../../utils/aspectGuidelines.js';
import { configureWindowRequests, sendWindowRequest, takeWindowRequests } from '../../services/windowRequests.js';
import { RoleStore } from '../../services/roleStore.js';
import { parseRoleConfig, parseRoleType } from '../../utils/roleTypes.js';
import { parse as parseYaml } from 'yaml';
import { withTiming } from './_timing.js';

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
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');
const SECTIONS = (): ReturnType<typeof readAspectSections>['sections'] => readAspectSections(path.join(WS, '_ai', 'aspect_guidelines')).sections;

/** The selection a stage of `item` runs with: per section `[option or 'remove' or null, the deciding level]`. */
function selectionOf(choices: AspectLevelChoices): Record<string, [string | null, string | null]> {
    const out: Record<string, [string | null, string | null]> = {};
    for (const r of resolveAspects(SECTIONS(), choices).sections) { out[r.section] = [r.removed ? 'remove' : (r.option ?? null), r.from ?? null]; }
    return out;
}
const stageChoices = (item: QueuedPrompt, stage: 'prePrompt' | 'main' | 'followUp' = 'main', todoId?: string): AspectLevelChoices =>
    liveAspectChoices(undefined, queue().stageRoleSource(item, stage, todoId));

async function add(text: string, extra: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const answer = JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text, run: TEST_RUN, ...extra } as never));
    assert.ok(answer.id, JSON.stringify(answer));
    return queue().items.find((i) => i.id === answer.id)!;
}

describe('guideline choices per level', () => {
    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        useRun(store());
        queue().setRunQueueSettings(TEST_RUN, { autoSend: false, defaultTransport: 'anthropic' });
        ChatVariablesStore.instance.role = '';
        assert.deepEqual(SECTIONS().map((s) => s.id), ['language', 'night']);
    });

    test('GL-1: every level decides when it is the lowest that chooses', async () => {
        const plain = await add('plain');
        assert.deepEqual(selectionOf(stageChoices(plain)), { language: ['en', 'sectionDefault'], night: ['off', 'sectionDefault'] }, 'nothing chosen: the defaults');
        setQuestDefaultChoices({ language: 'de' });
        assert.deepEqual(selectionOf(stageChoices(plain)).language, ['de', 'questDefault']);
        setWindowChoices({ night: 'on' });
        assert.deepEqual(selectionOf(stageChoices(plain)).night, ['on', 'window']);
        queue().setRunGuidelines({ language: 'en' }, TEST_RUN);
        assert.deepEqual(selectionOf(stageChoices(plain)).language, ['en', 'run']);
        // The role writer (type author): the type's night: off, the role's language: de.
        const writer = await add('as writer', { role: 'writer' });
        assert.deepEqual(selectionOf(stageChoices(writer)), { language: ['de', 'role'], night: ['off', 'roleType'] });
        // The item's own choice beats the role's.
        const chosen = await add('chosen', { role: 'writer', guidelines: { night: 'on' } });
        assert.deepEqual(selectionOf(stageChoices(chosen)), { language: ['de', 'role'], night: ['on', 'item'] });
        // The todo's remove beats everything: nothing is sent for language.
        chosen.repeatTodoId = 't1_aktl-chosen';
        assert.deepEqual(selectionOf(stageChoices(chosen)), { language: ['remove', 'todo'], night: ['on', 'item'] });
        chosen.repeatTodoId = 't2_aktl-plain';
        assert.deepEqual(selectionOf(stageChoices(chosen)).language, ['de', 'role'], 'a todo without choices adds none');
        // What Copilot is sent follows: the item's night text, the todo's remove.
        chosen.repeatTodoId = 't1_aktl-chosen';
        const text = withAspectsForCopilot('PROMPT', stageChoices(chosen));
        assert.match(text, /NIGHT-ON[\s\S]*PROMPT/);
        assert.doesNotMatch(text, /LANG-/);
        // Outside the queue: the live levels (quest default, window, the window's run, the chat role).
        assert.deepEqual(selectionOf(liveAspectChoices()).night, ['on', 'window']);
        queue().setRunGuidelines(undefined, TEST_RUN);
        assert.equal(queue().runQueueSettings(TEST_RUN).guidelines, undefined, 'cleared');
    });

    test('GL-2: the window level is machine-local per quest and read back from its file', () => {
        setWindowChoices({ night: 'on', language: 'de' });
        const file = machineConfigPath(QUEST);
        assert.match(path.basename(file), /^extension_config\.[^.]+\.q1\.yaml$/);
        const doc = parseYaml(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(doc.aspectGuidelines.window, { night: 'on', language: 'de' });
        assert.deepEqual(windowChoices(), { night: 'on', language: 'de' }, 'read from the file (a reload reads the same)');
        setWindowSectionChoice('language', undefined);
        assert.deepEqual(windowChoices(), { night: 'on' }, "Don't add drops the entry");
        // The chat panels' sticky choices beside it.
        setChatPanelChoices('anthropic', { language: 'en' });
        assert.deepEqual(chatPanelChoices('anthropic'), { language: 'en' });
        assert.equal(chatPanelChoices('copilot'), undefined);
        assert.deepEqual(chatSendAspectChoices('anthropic', TEST_RUN), { run: {}, item: { language: 'en' } });
        assert.deepEqual(selectionOf(liveAspectChoices(chatSendAspectChoices('anthropic', TEST_RUN))).language, ['en', 'item'], 'a chat send carries them as its item level');
        setChatPanelChoices('anthropic', undefined);
        assert.deepEqual(parseYaml(fs.readFileSync(file, 'utf8')).aspectGuidelines, { window: { night: 'on' } }, 'empty maps are not written');
    });

    test('GL-3: Set as quest default and Clear quest default', () => {
        setWindowChoices({ night: 'on', language: 'en' });
        assert.deepEqual(setQuestDefaultFromWindow(), { night: 'on', language: 'en' });
        assert.deepEqual(parseYaml(fs.readFileSync(questConfigPath(QUEST), 'utf8')).aspectGuidelines, { night: 'on', language: 'en' }, 'the shared file');
        assert.deepEqual(questDefaultChoices(), { night: 'on', language: 'en' });
        clearQuestDefault();
        assert.equal(questDefaultChoices(), undefined);
        assert.equal(parseYaml(fs.readFileSync(questConfigPath(QUEST), 'utf8'))?.aspectGuidelines, undefined, 'the section is gone');
    });

    test('GL-4: the all-windows change sets only its section, here and in the other windows', () => {
        setWindowChoices({ night: 'on', language: 'de' });
        const dir = path.join(SANDBOX, 'storage', 'windows');
        configureWindowRequests(dir, 'aaaa1111_mach0001');
        const open = openWindowsOnThisMachine([
            { windowId: 'aaaa1111_mach0001', alive: true },
            { windowId: 'bbbb2222_mach0001', alive: true },
            { windowId: 'cccc3333_mach0001', alive: false },
            { windowId: 'dddd4444_other002', alive: true },
        ], 'aaaa1111_mach0001');
        assert.deepEqual(open, ['aaaa1111_mach0001', 'bbbb2222_mach0001'], 'live windows of this machine');
        const sent = setSectionChoiceInAllWindows('night', undefined, {
            ownWindowId: 'aaaa1111_mach0001',
            windowIds: () => open,
            send: (id, section, option) => sendWindowRequest(id, { type: 'setAspectChoice', section, ...(option ? { option } : {}) }),
        });
        assert.deepEqual(sent, ['bbbb2222_mach0001'], 'not sent to itself');
        assert.deepEqual(windowChoices(), { language: 'de' }, 'this window: only night changed');
        // The other window takes the request.
        configureWindowRequests(dir, 'bbbb2222_mach0001');
        const calls: Array<[string, string | string[] | undefined]> = [];
        const handled = takeWindowRequests({ answerAsk: () => false, resumeRun: () => false, setAspectChoice: (s, o) => { calls.push([s, o]); return true; } });
        assert.equal(handled, 1);
        assert.deepEqual(calls, [['night', undefined]]);
        configureWindowRequests(dir, 'aaaa1111_mach0001');
        setSectionChoiceInAllWindows('language', 'en', { ownWindowId: 'aaaa1111_mach0001', windowIds: () => open, send: (id, s, o) => sendWindowRequest(id, { type: 'setAspectChoice', section: s, ...(o ? { option: o } : {}) }) });
        configureWindowRequests(dir, 'bbbb2222_mach0001');
        calls.length = 0;
        takeWindowRequests({ answerAsk: () => false, resumeRun: () => false, setAspectChoice: (s, o) => { calls.push([s, o]); return true; } });
        assert.deepEqual(calls, [['language', 'en']]);
        configureWindowRequests(undefined, undefined);
        setWindowChoices(undefined);
    });

    test('GL-5: the tools take guidelines and refuse unknown ones', async () => {
        assert.match(JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'x', guidelines: { mood: 'on' } } as never)).error, /"mood" is no guideline aspect \(aspects: language, night\)/);
        assert.match(JSON.parse(await ADD_QUEUE_ITEM_TOOL.execute({ text: 'x', guidelines: { night: 'dusk' } } as never)).error, /"dusk" is no choice of "night" \(choices: on, off, remove\)/);
        const item = await add('to update', { guidelines: { language: 'remove' } });
        assert.deepEqual(item.guidelines, { language: 'remove' });
        await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, guidelines: { night: 'on' } } as never);
        assert.deepEqual(queue().items.find((i) => i.id === item.id)!.guidelines, { night: 'on' }, 'replaced as a whole');
        assert.match(JSON.parse(await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, guidelines: { night: 'x' } } as never)).error, /no choice of "night"/);
        await UPDATE_QUEUE_ITEM_TOOL.execute({ queueItemId: item.id, guidelines: {} } as never);
        assert.equal(queue().items.find((i) => i.id === item.id)!.guidelines, undefined, '{} clears them');
        // The todo tools.
        const created = JSON.parse(await CREATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todo: { id: 't3_aktl-made', title: 'Made', description: 'D', status: 'not-started', guidelines: { night: 'on' } } } as never));
        assert.equal(created.ok, true, JSON.stringify(created));
        assert.deepEqual(findTodoById(QUEST, 't3_aktl-made')?.guidelines, { night: 'on' });
        assert.match(fs.readFileSync(path.join(WS, '_ai', 'quests', QUEST, `todos.${QUEST}.todo.yaml`), 'utf8'), /guidelines:\n\s+night: on/);
        assert.match(await CREATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todo: { id: 't4_aktl-bad', title: 'Bad', description: 'D', status: 'not-started', guidelines: { mood: 'on' } } } as never), /no guideline aspect/);
        const updated = JSON.parse(await UPDATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todoId: 't3_aktl-made', updates: { guidelines: { language: 'de' } } } as never));
        assert.equal(updated.ok, true, JSON.stringify(updated));
        assert.deepEqual(findTodoById(QUEST, 't3_aktl-made')?.guidelines, { language: 'de' });
        await UPDATE_QUEST_TODO_TOOL.execute({ questId: QUEST, todoId: 't3_aktl-made', updates: { guidelines: null } } as never);
        assert.equal(findTodoById(QUEST, 't3_aktl-made')?.guidelines, undefined, 'null removes them');
        // tomAi_sendItemToQuest: carried in the inbox item, which the target enqueues with them.
        let delivered: unknown;
        const access = {
            currentQuest: () => QUEST, currentRun: () => 'default', runExists: () => true, questExists: () => true, profileExists: () => true,
            listSessions: () => [], liveWindows: () => [{ windowId: 'w', workspace: 'other' }], sender: () => ({ windowId: 'me', host: 'h' }),
            deliver: (_ws: string, i: unknown) => { delivered = i; return '/x'; }, aspectSections: liveSectionsReader, now: () => new Date(),
        };
        const sent = JSON.parse(await sendItemToQuestImpl(access as never, { quest: 'other', text: 'hi', guidelines: { night: 'on' } } as never));
        assert.equal(sent.ok, true, JSON.stringify(sent));
        assert.deepEqual((delivered as { guidelines?: unknown }).guidelines, { night: 'on' });
        assert.match(await sendItemToQuestImpl(access as never, { quest: 'other', text: 'hi', guidelines: { mood: 'x' } } as never), /unknownGuidelines/);
        const round = parseInboxItem(serializeInboxItem(delivered as never));
        assert.equal(round.ok, true);
        assert.deepEqual((round as unknown as { item: { guidelines?: unknown } }).item.guidelines, { night: 'on' }, 'written and read back from the inbox file');
        const plan = planInboxConversion((round as unknown as { item: never }).item, { profileExists: () => true, readSession: () => undefined, now: new Date(), token: 'x' });
        assert.deepEqual(plan.enqueue.guidelines, { night: 'on' }, 'the target enqueues it with them');
    });

    test('GL-6: tomAi_getAspectGuidelines', async () => {
        setQuestDefaultChoices({ language: 'de' });
        setWindowChoices({ night: 'on' });
        const item = await add('read me', { role: 'writer', guidelines: { night: 'off' } });
        item.repeatTodoId = 't1_aktl-chosen';
        const all = JSON.parse(await withTiming('tomAi_getAspectGuidelines:typical', () => GET_ASPECT_GUIDELINES_TOOL.execute({ itemId: item.id })));
        assert.equal(all.ok, true, JSON.stringify(all));
        assert.deepEqual(all.aspects.map((s: { id: string; choices: string[]; placement: string; default?: string }) => [s.id, s.placement, s.default, s.choices]), [['language', 'system', 'en', ['de', 'en']], ['night', 'user', 'off', ['on', 'off']]]);
        assert.deepEqual(all.levels, { questDefault: { language: 'de' }, window: { night: 'on' }, roleType: { night: 'off' }, role: { language: 'de' }, item: { night: 'off' }, todo: { language: 'remove' } });
        assert.deepEqual(all.selection, [{ aspect: 'language', choice: 'remove', from: 'todo' }, { aspect: 'night', choice: 'off', from: 'item', file: '_ai/aspect_guidelines/night/off.md' }], 'the file a choice comes from (gsel17)');
        assert.equal(all.context.role, 'writer');
        assert.equal(all.context.roleType, 'author');
        const atWindow = JSON.parse(await GET_ASPECT_GUIDELINES_TOOL.execute({ itemId: item.id, level: 'window' }));
        assert.deepEqual(atWindow.selection, [{ aspect: 'language', choice: 'de', from: 'questDefault', file: '_ai/aspect_guidelines/language/de.md' }, { aspect: 'night', choice: 'on', from: 'window', file: '_ai/aspect_guidelines/night/on.md' }], 'cut at the window level');
        const byTodo = JSON.parse(await GET_ASPECT_GUIDELINES_TOOL.execute({ todoId: 't1_aktl-chosen', role: 'plain' }));
        assert.deepEqual(byTodo.selection, [{ aspect: 'language', choice: 'remove', from: 'todo' }, { aspect: 'night', choice: 'on', from: 'window', file: '_ai/aspect_guidelines/night/on.md' }]);
        assert.match(JSON.parse(await GET_ASPECT_GUIDELINES_TOOL.execute({ level: 'nowhere' })).error, /Unknown level/);
        assert.match(JSON.parse(await GET_ASPECT_GUIDELINES_TOOL.execute({ itemId: 'nope' })).error, /No queue item/);
        clearQuestDefault();
        setWindowChoices(undefined);
    });

    test('GL-7: kept in the entry file, the run settings and the role files', () => {
        const item = queue().items.find((i) => i.originalText === 'chosen')!;
        (queue() as unknown as { persist(): void }).persist();
        const dir = path.join(WS, '_ai', 'queue');
        const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => fs.readFileSync(f, 'utf8').includes(`id: ${item.id}`))!;
        const doc = parseYaml(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(doc['prompt-queue'][0].guidelines, { night: 'on' });
        const back = (queue() as unknown as { _entryToQueuedPrompt(e: unknown): QueuedPrompt })._entryToQueuedPrompt({ fileName: path.basename(file), doc });
        assert.deepEqual(back.guidelines, { night: 'on' }, 'read back');
        queue().setRunGuidelines({ night: 'on' }, TEST_RUN);
        const settings = parseYaml(fs.readFileSync(path.join(WS, '_ai', 'queue', 'queue-settings.yaml'), 'utf8'));
        const runs = settings.runs ?? settings['runs-by-quest']?.[QUEST] ?? {};
        assert.deepEqual(JSON.stringify(settings).includes('"guidelines":{"night":"on"}'), true, JSON.stringify(runs));
        queue().setRunGuidelines(undefined, TEST_RUN);
        // The role editors keep the choices they do not show.
        const roles = new RoleStore(path.join(WS, '.tom'), path.join(WS, '_ai'));
        roles.saveRole('writer', '# The writer role, edited\n', 'author');
        assert.deepEqual(roles.role('writer')?.guidelines, { language: 'de' }, 'saveRole keeps them');
        roles.saveRole('writer', '# The writer role\n', 'author', { night: 'on' });
        assert.deepEqual(roles.role('writer')?.guidelines, { night: 'on' }, 'or replaces them when given');
        roles.saveRole('writer', '# The writer role\n', 'author', { language: 'de' });
        roles.saveRoleType('author', { tools: { mode: 'profileDefault' } });
        assert.match(fs.readFileSync(path.join(WS, '_ai', 'role-types', 'author', 'role-type.yaml'), 'utf8'), /guidelines:\n\s+night: off/, 'saveRoleType keeps them');
        // The schemas accept them, and only as a map of names.
        assert.equal(parseRoleConfig('roleType: author\nguidelines:\n  language: de\n').ok, true);
        assert.equal(parseRoleType('tools:\n  mode: profileDefault\nguidelines:\n  night: off\n').ok, true);
        assert.equal(parseRoleConfig('guidelines:\n  language: [de, +en]\n').ok, true, 'a list is a valid value (gsel20)');
        assert.equal(parseRoleConfig('guidelines:\n  language: {de: 1}\n').ok, false);
    });

    test('GL-8: the wiring', () => {
        const src = EXT('src', 'managers', 'promptQueueManager.ts');
        assert.match(src, /withAspectsForCopilot\(unescapePlaceholders\(expandedText\), liveAspectChoices\(undefined, roleSource\)\)/, 'the queue\'s Copilot send');
        assert.match(EXT('src', 'handlers', 'anthropic-handler.ts'), /liveAspectsForSend\(transport as AspectTransport, \{ systemSegments, userContent: '' \}, liveAspectChoices\(options\.aspectGuidelineChoices\)\)/, 'the direct, VS Code LM, Local LLM and Agent SDK sends');
        const chat = EXT('src', 'handlers', 'chatPanel-handler.ts');
        assert.match(chat, /withAspectsForCopilot\(expanded, liveAspectChoices\(chatSendAspectChoices\('copilot', this\._chatRun\('copilot'\)\)\)\)/);
        assert.match(chat, /aspectGuidelineChoices: chatSendAspectChoices\('anthropic', this\._chatRun\('anthropic'\)\)/);
        assert.match(EXT('src', 'extension.ts'), /setAspectChoice: \(section, option\) => applyAspectChoiceRequest\(section, option\)/);
        const pkg = JSON.parse(EXT('package.json')) as { contributes: { commands: Array<{ command: string; title: string }> } };
        const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
        assert.equal(titles['tomAi.setQuestDefaultGuidelines'], '@T: Set Guideline Choices as Quest Default');
        assert.equal(titles['tomAi.clearQuestDefaultGuidelines'], '@T: Clear Quest Default Guideline Choices');
    });
});
