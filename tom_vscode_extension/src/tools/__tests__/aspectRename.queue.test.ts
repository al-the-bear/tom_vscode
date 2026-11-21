/**
 * Guideline choices carried over a section or option rename (gsel7b), through the real queue, todo store, extension
 * config and role files (nothing reaches a model). `_ai/aspect_guidelines/` has a section `night` (options `on`,
 * `off`, default `off`) and a section `language` (options `de`, `en`, default `en`).
 *
 *   CR-1 the rename of one choice map: a section's key (its place kept, a stale choice under the new id giving way),
 *        an option's value, `remove` and unrelated choices untouched; a rename message parsed or refused; a YAML map
 *        rewritten in place with its comments
 *   CR-2 a section renamed: every level — quest default, window, @CHAT panel, run, queue item, todo, role, role type —
 *        names the new id, read back by its own reader, and the selection a send runs with is the same option from
 *        the same level; the sentence says what was rewritten
 *   CR-3 an option renamed: the same levels name the new option, and the selection follows
 *   CR-4 another window's rename (the `renameAspectChoices` window request): the choices that window holds in memory
 *        (an item's and a run's) carried over and written; a malformed request is not carried out
 *   CR-5 the file sweep: every quest's files, every host's per-host file, session todos and the terminal siblings,
 *        templates, files that do not name it left byte-for-byte, comments kept, a broken file listed and left
 *   CR-6 the section editor: Rename section carries the choices over and says what it rewrote; a save carries the
 *        draft's option renames (only to an option the section has); the page sends `renames` and shows `carried`
 *   CR-7 the wiring: the live editor carries over, every window takes the request, the user guide no longer warns
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261121_gsel7b_rename-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const AI = path.join(WS, '_ai');
const SECTIONS_DIR = path.join(AI, 'aspect_guidelines');

function put(rel: string, text: string): string {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
}
const readWs = (rel: string): string => fs.readFileSync(path.join(WS, rel), 'utf8');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/aspect_guidelines/language/section.yaml', 'name: Language\ndefault: en\noptions: [de, en]\n');
put('_ai/aspect_guidelines/language/de.md', 'LANG-DE.\n');
put('_ai/aspect_guidelines/language/en.md', 'LANG-EN.\n');
put('_ai/aspect_guidelines/night/section.yaml', 'name: Night\nplacement: user\ndefault: off\noptions: [on, off]\n');
put('_ai/aspect_guidelines/night/on.md', 'NIGHT-ON.\n');
put('_ai/aspect_guidelines/night/off.md', 'NIGHT-OFF.\n');
put('_ai/role-types/author/role-type.yaml', '# the author type\ntools:\n  mode: profileDefault\nguidelines:\n  night: on # quiet\n');
put('_ai/roles/writer/role.md', '# The writer role\n');
put('_ai/roles/writer/role-config.yaml', 'roleType: author\nguidelines:\n  night: on\n  language: de\n');
put(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`, [
    `quest: ${QUEST}`, 'todos:',
    '  - id: t1_aktl-chosen', '    title: Chosen', '    description: D', '    status: not-started',
    '    guidelines:', '      night: on', '      language: remove',
    '  - id: t2_aktl-plain', '    title: Plain', '    description: Mentions night in its text', '    status: not-started', '',
].join('\n'));
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { parse as parseYaml, parseDocument, type YAMLMap } from 'yaml';
import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { TEST_RUN, useRun } from './_processTestRun.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { findTodoById } from '../../managers/questTodoManager.js';
import { machineConfigPath } from '../../managers/extensionConfigStore.js';
import { ADD_TO_PROMPT_QUEUE_TOOL } from '../chat-enhancement-tools.js';
import {
    chatPanelChoices, liveAspectChoices, questDefaultChoices, setChatPanelChoices, setQuestDefaultChoices, setWindowChoices, windowChoices,
} from '../../services/aspectChoiceLevels.js';
import { readAspectSections } from '../../services/aspectGuidelinesStore.js';
import { renameAspectSection, saveAspectSection } from '../../services/aspectSectionsEdit.js';
import { aspectRenameSummary, rewriteStoredAspectChoices } from '../../services/aspectChoiceRename.js';
import { configureWindowRequests, sendWindowRequest, takeWindowRequests } from '../../services/windowRequests.js';
import { getQueueFolder } from '../../storage/queueFileStorage.js';
import { resolveAspects, type AspectLevelChoices } from '../../utils/aspectGuidelines.js';
import { aspectRenameText, parseAspectRename, renameInChoices, renameInGuidelinesNodes, renameInYamlChoiceMap } from '../../utils/aspectRename.js';
import { applyAspectRenameRequest, carryAspectChoicesOver } from '../../handlers/aspectChoiceCommands.js';
import { handleAspectSectionEditorMessage } from '../../handlers/aspectSectionEditor-handler.js';

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
const EXT = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, ...p), 'utf8');
const SECTIONS = (): ReturnType<typeof readAspectSections>['sections'] => readAspectSections(SECTIONS_DIR).sections;

/** Per section: `[option or 'remove', the deciding level]`. */
function selectionOf(choices: AspectLevelChoices): Record<string, [string | null, string | null]> {
    const out: Record<string, [string | null, string | null]> = {};
    for (const r of resolveAspects(SECTIONS(), choices).sections) { out[r.section] = [r.removed ? 'remove' : (r.option ?? null), r.from ?? null]; }
    return out;
}
const stageChoices = (item: QueuedPrompt, todoId?: string): AspectLevelChoices => liveAspectChoices(undefined, queue().stageRoleSource(item, 'main', todoId));

async function add(text: string, extra: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const answer = JSON.parse(await ADD_TO_PROMPT_QUEUE_TOOL.execute({ text, run: TEST_RUN, ...extra } as never));
    assert.ok(answer.id, JSON.stringify(answer));
    return queue().items.find((i) => i.id === answer.id)!;
}

/** The entry file holding `item`, parsed: its items' `guidelines`. */
function entryGuidelines(item: QueuedPrompt): unknown[] {
    const dir = getQueueFolder()!;
    const file = fs.readdirSync(dir).filter((n) => n.endsWith('.queue.yaml')).map((n) => path.join(dir, n)).find((f) => fs.readFileSync(f, 'utf8').includes(item.id));
    assert.ok(file, `the entry file of ${item.id}`);
    const found: unknown[] = [];
    const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) { if (k === 'guidelines') { found.push(x); } else { walk(x); } }
        }
    };
    walk(parseYaml(fs.readFileSync(file, 'utf8')));
    return found;
}

const roleChoices = (): unknown => parseYaml(readWs('_ai/roles/writer/role-config.yaml')).guidelines;
const typeChoices = (): unknown => parseYaml(readWs('_ai/role-types/author/role-type.yaml')).guidelines;
const todoChoices = (): unknown => (findTodoById(QUEST, 't1_aktl-chosen') as { guidelines?: unknown } | undefined)?.guidelines;

describe('guideline choices carried over a rename (gsel7b)', () => {
    let plain: QueuedPrompt;
    let chosen: QueuedPrompt;

    test('setup', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        useRun(ProcessStateStore.instance!);
        queue().setRunQueueSettings(TEST_RUN, { autoSend: false, defaultTransport: 'anthropic' });
        ChatVariablesStore.instance.role = '';
        assert.deepEqual(SECTIONS().map((s) => s.id), ['language', 'night']);
    });

    test('CR-1: the rename of one choice map', () => {
        const section = { kind: 'section', from: 'night', to: 'mode' } as const;
        assert.deepEqual(Object.entries(renameInChoices({ language: 'de', night: 'on', x: 'y' }, section)!), [['language', 'de'], ['mode', 'on'], ['x', 'y']], 'the key keeps its place');
        assert.deepEqual(renameInChoices({ mode: 'stale', night: 'remove' }, section), { mode: 'remove' }, 'a stale choice under the new id gives way; remove carried');
        assert.equal(renameInChoices({ language: 'de' }, section), undefined, 'nothing renamed');
        assert.equal(renameInChoices(undefined, section), undefined);
        const options = { kind: 'options', section: 'night', options: { on: 'yes', off: 'no' } } as const;
        assert.deepEqual(renameInChoices({ night: 'on', language: 'on' }, options), { night: 'yes', language: 'on' }, 'only that section');
        assert.equal(renameInChoices({ night: 'remove' }, options), undefined, 'remove is no option');
        assert.deepEqual(renameInChoices({ night: 'off' }, { kind: 'options', section: 'night', options: { on: 'off', off: 'on' } }), { night: 'on' }, 'a swap renames each once');

        assert.deepEqual(parseAspectRename({ kind: 'section', from: 'a', to: 'b' }), { kind: 'section', from: 'a', to: 'b' });
        for (const bad of [null, 'x', { kind: 'section', from: 'a', to: 'a' }, { kind: 'section', from: ' a', to: 'b' }, { kind: 'options', section: 's', options: {} },
            { kind: 'options', section: 's', options: { a: 'remove' } }, { kind: 'other' }]) {
            assert.equal(parseAspectRename(bad), undefined, JSON.stringify(bad));
        }
        assert.deepEqual(parseAspectRename({ kind: 'options', section: 's', options: { a: 'b', c: '', d: 3, e: 'e' } }), { kind: 'options', section: 's', options: { a: 'b' } }, 'the usable entries kept');
        assert.equal(aspectRenameText(section), 'section night → mode');
        assert.equal(aspectRenameText(options), 'options of night: on → yes, off → no');

        const doc = parseDocument('# top\nguidelines:\n  night: on # quiet\n  language: de\nother:\n  guidelines:\n    night: off\n');
        assert.equal(renameInGuidelinesNodes(doc, section), 2);
        assert.equal(doc.toString(), '# top\nguidelines:\n  mode: on # quiet\n  language: de\nother:\n  guidelines:\n    mode: off\n', 'in place, the comments kept');
        const map = parseDocument('night: 1\n').contents as YAMLMap;
        assert.ok(renameInYamlChoiceMap(map, { kind: 'options', section: 'night', options: Object.fromEntries([['1', 'true']]) }));
        assert.deepEqual(parseYaml(String(map)), { night: 'true' }, 'a name YAML would read as another type stays a string');
    });

    test('CR-2: a section renamed keeps every level in effect', async () => {
        // Every level chooses night: quest default, window, @CHAT panel, run, item, todo, role, role type.
        setQuestDefaultChoices({ night: 'on', language: 'de' });
        setWindowChoices({ night: 'on' });
        setChatPanelChoices('anthropic', { night: 'on' });
        queue().setRunGuidelines({ night: 'on' }, TEST_RUN);
        plain = await add('plain');
        chosen = await add('chosen', { role: 'writer', guidelines: { night: 'on' } });
        const before = {
            plain: selectionOf(stageChoices(plain)),
            writer: selectionOf(stageChoices(await add('as writer', { role: 'writer' }))),
            chosen: selectionOf(stageChoices(chosen)),
            todo: selectionOf(stageChoices(chosen, 't1_aktl-chosen')),
        };
        assert.deepEqual(before.plain.night, ['on', 'run']);
        assert.deepEqual(before.writer.night, ['on', 'role']);
        assert.deepEqual(before.chosen.night, ['on', 'item']);
        assert.deepEqual(before.todo.night, ['on', 'todo']);

        renameAspectSection(SECTIONS_DIR, 'night', 'mode', path.join(WS, '.tom'));
        const said = carryAspectChoicesOver({ kind: 'section', from: 'night', to: 'mode' });

        assert.deepEqual(questDefaultChoices(), { mode: 'on', language: 'de' }, 'quest default');
        assert.deepEqual(windowChoices(), { mode: 'on' }, 'window');
        assert.deepEqual(chatPanelChoices('anthropic'), { mode: 'on' }, '@CHAT panel');
        assert.deepEqual(queue().runQueueSettings(TEST_RUN).guidelines, { mode: 'on' }, 'run (memory)');
        const settings = parseYaml(fs.readFileSync(path.join(getQueueFolder()!, 'queue-settings.yaml'), 'utf8'));
        assert.match(JSON.stringify(settings), /"guidelines":\{"mode":"on"\}/, 'run (queue-settings.yaml)');
        assert.doesNotMatch(JSON.stringify(settings), /"night"/);
        assert.deepEqual(chosen.guidelines, { mode: 'on' }, 'queue item (memory)');
        assert.deepEqual(entryGuidelines(chosen), [{ mode: 'on' }], 'queue item (its entry file)');
        assert.deepEqual(todoChoices(), { mode: 'on', language: 'remove' }, 'todo');
        assert.deepEqual(roleChoices(), { mode: 'on', language: 'de' }, 'role');
        assert.deepEqual(typeChoices(), { mode: 'on' }, 'role type');
        assert.match(readWs('_ai/role-types/author/role-type.yaml'), /^# the author type\n[\s\S]*mode: on # quiet\n/, 'the comments kept');
        assert.match(readWs(`_ai/quests/${QUEST}/todos.${QUEST}.todo.yaml`), /description: Mentions night in its text/, 'only choices are rewritten');

        // The selection a send runs with: the same option, from the same level.
        const after = {
            plain: selectionOf(stageChoices(plain)),
            writer: selectionOf(stageChoices(await add('as writer again', { role: 'writer' }))),
            chosen: selectionOf(stageChoices(chosen)),
            todo: selectionOf(stageChoices(chosen, 't1_aktl-chosen')),
        };
        for (const key of Object.keys(before) as Array<keyof typeof before>) {
            assert.deepEqual(after[key].mode, before[key].night, `${key}: in effect`);
            assert.deepEqual(after[key].language, before[key].language, `${key}: the other section unchanged`);
        }
        // Without the run's and the role's choice, the levels above show through: window, then quest default.
        queue().setRunGuidelines(undefined, TEST_RUN);
        assert.deepEqual(selectionOf(stageChoices(plain)).mode, ['on', 'window']);
        setWindowChoices(undefined);
        assert.deepEqual(selectionOf(stageChoices(plain)).mode, ['on', 'questDefault']);

        assert.match(said, /^Renamed section night → mode\. Choices carried over: quest default 1, window 1, @CHAT panel 1, run 1, queue item 1, todo 1, role 1, role type 1 \(5 files\)\.$/);
        assert.equal(queue().items.filter((i) => i.guidelines && 'night' in i.guidelines).length, 0);
    });

    test('CR-3: an option renamed keeps every level in effect', () => {
        setWindowChoices({ mode: 'on' });
        queue().setRunGuidelines({ mode: 'on' }, TEST_RUN);
        saveAspectSection(SECTIONS_DIR, { id: 'mode', name: 'Night', label: '', placement: 'user', defaultOption: 'off', options: [{ name: 'yes', text: 'NIGHT-ON.\n' }, { name: 'off', text: 'NIGHT-OFF.\n' }] });
        const said = carryAspectChoicesOver({ kind: 'options', section: 'mode', options: { on: 'yes' } });
        assert.deepEqual(questDefaultChoices(), { mode: 'yes', language: 'de' });
        assert.deepEqual(windowChoices(), { mode: 'yes' });
        assert.deepEqual(chatPanelChoices('anthropic'), { mode: 'yes' });
        assert.deepEqual(queue().runQueueSettings(TEST_RUN).guidelines, { mode: 'yes' });
        assert.deepEqual(chosen.guidelines, { mode: 'yes' });
        assert.deepEqual(entryGuidelines(chosen), [{ mode: 'yes' }]);
        assert.deepEqual(todoChoices(), { mode: 'yes', language: 'remove' }, 'the todo\'s remove untouched');
        assert.deepEqual(roleChoices(), { mode: 'yes', language: 'de' });
        assert.deepEqual(typeChoices(), { mode: 'yes' });
        assert.deepEqual(selectionOf(stageChoices(chosen)).mode, ['yes', 'item']);
        assert.deepEqual(selectionOf(stageChoices(plain)).mode, ['yes', 'run']);
        assert.match(said, /^Renamed option of mode: on → yes\. Choices carried over: /);
    });

    test('CR-4: another window\'s rename carries this window\'s memory over', () => {
        // Choices this window holds in memory only (not yet in a file): an item's and a run's.
        chosen.guidelines = { mode: 'yes', language: 'de' };
        (queue() as unknown as { _runSettings: Map<string, { guidelines?: Record<string, string> }> })._runSettings.get(TEST_RUN)!.guidelines = { mode: 'yes' };
        configureWindowRequests(path.join(SANDBOX, 'windows'), 'win-a');
        assert.ok(sendWindowRequest('win-a', { type: 'renameAspectChoices', rename: { kind: 'options', section: 'mode', options: { yes: 'on' } } }));
        assert.ok(sendWindowRequest('win-a', { type: 'renameAspectChoices', rename: { kind: 'section', from: 'x', to: 'x' } } as never));
        const taken: unknown[] = [];
        const done = takeWindowRequests({
            answerAsk: () => false, resumeRun: () => false,
            renameAspectChoices: (rename) => { taken.push(rename); return applyAspectRenameRequest(rename); },
        });
        assert.equal(done, 1, 'the malformed request is not carried out');
        assert.deepEqual(taken, [{ kind: 'options', section: 'mode', options: { yes: 'on' } }]);
        assert.deepEqual(chosen.guidelines, { mode: 'on', language: 'de' });
        assert.deepEqual(entryGuidelines(chosen), [{ mode: 'on', language: 'de' }], 'written');
        assert.deepEqual(queue().runQueueSettings(TEST_RUN).guidelines, { mode: 'on' });
        assert.match(fs.readFileSync(path.join(getQueueFolder()!, 'queue-settings.yaml'), 'utf8'), /mode: on/);
        configureWindowRequests(undefined, undefined);
    });

    test('CR-5: the file sweep', () => {
        const ai = path.join(SANDBOX, 'sweep', '_ai');
        const at = (rel: string, text: string): string => {
            const abs = path.join(ai, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, text);
            return abs;
        };
        const files = {
            shared2: at('quests/q2/extension_config.q2.yaml', 'telegram:\n  enabled: false\naspectGuidelines:\n  night: on\n'),
            otherHost: at('quests/q2/extension_config.otherhost.q2.yaml', 'aspectGuidelines:\n  window:\n    night: on\n  chat:\n    copilot:\n      night: off\n'),
            session: at('quests/q2/history/sessions/s1/session-todos.todo.yaml', 'todos:\n  - id: s1\n    guidelines:\n      night: on\n'),
            archived: at('quests/q2/todos-archived.q2.todo.yaml', 'todos:\n  - id: a1\n    guidelines: { night: on }\n'),
            template: at('queue/t1.template.queue.yaml', '# a template\nmain:\n  guidelines:\n    night: on\n'),
            settings: at('queue/queue-settings.yaml', 'runs-by-quest:\n  q2:\n    r1:\n      guidelines:\n        night: off\n'),
            unrelated: at('quests/q2/todos.q2.todo.yaml', 'todos:\n  - id: u1\n    notes: "night is long; no guidelines here"\n    guidelines:\n      language: de\n'),
            broken: at('roles/bad/role-config.yaml', 'guidelines:\n  night: [on\n'),
            notAChoice: at('role-types/t/role-type.yaml', 'night: on\nguidelines: none\n'),
        };
        const untouched = [files.unrelated, files.broken, files.notAChoice].map((f) => fs.readFileSync(f, 'utf8'));
        const result = rewriteStoredAspectChoices({ aiRoot: ai }, { kind: 'section', from: 'night', to: 'mode' });
        assert.deepEqual(parseYaml(fs.readFileSync(files.shared2, 'utf8')), { telegram: { enabled: false }, aspectGuidelines: { mode: 'on' } });
        assert.deepEqual(parseYaml(fs.readFileSync(files.otherHost, 'utf8')), { aspectGuidelines: { window: { mode: 'on' }, chat: { copilot: { mode: 'off' } } } }, 'another host\'s file too');
        assert.deepEqual(parseYaml(fs.readFileSync(files.session, 'utf8')).todos[0].guidelines, { mode: 'on' }, 'session todos');
        assert.deepEqual(parseYaml(fs.readFileSync(files.archived, 'utf8')).todos[0].guidelines, { mode: 'on' }, 'the archived sibling');
        assert.equal(fs.readFileSync(files.template, 'utf8'), '# a template\nmain:\n  guidelines:\n    mode: on\n', 'templates, the comment kept');
        assert.deepEqual(parseYaml(fs.readFileSync(files.settings, 'utf8'))['runs-by-quest'].q2.r1.guidelines, { mode: 'off' }, 'every quest\'s runs');
        assert.deepEqual([files.unrelated, files.broken, files.notAChoice].map((f) => fs.readFileSync(f, 'utf8')), untouched, 'left byte for byte');
        assert.deepEqual(result.failed.map((f) => path.basename(path.dirname(f.file))), ['bad'], 'the broken file listed');
        assert.deepEqual(result.changes.map((c) => [c.level, c.count]).sort(), [
            ['chat', 1], ['item', 1], ['questDefault', 1], ['run', 1], ['todo', 1], ['todo', 1], ['window', 1],
        ]);
        assert.match(aspectRenameSummary(result), /^Choices carried over: quest default 1, window 1, @CHAT panel 1, run 1, queue item 1, todos 2 \(6 files\)\. Not rewritten: role-config\.yaml \(/);
        assert.equal(aspectRenameSummary({ changes: [], failed: [] }), 'No stored choice named it.');
        assert.equal(aspectRenameSummary({ changes: [], failed: [] }, { item: 2 }), 'Choices carried over: queue items 2.');
    });

    test('CR-6: the section editor carries the choices over', async () => {
        const dir = path.join(SANDBOX, 'editor', 'aspect_guidelines');
        fs.mkdirSync(path.join(dir, 'answer'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'answer', 'section.yaml'), 'name: Answer\ndefault: brief\noptions: [brief, full]\n');
        fs.writeFileSync(path.join(dir, 'answer', 'brief.md'), 'Brief.\n');
        fs.writeFileSync(path.join(dir, 'answer', 'full.md'), 'Full.\n');
        const renames: unknown[] = [];
        const notices: string[] = [];
        let changedAfterRename = false;
        const env = {
            dir,
            renamed: (r: unknown) => { renames.push(r); changedAfterRename = false; return 'Choices carried over: run 1.'; },
            changed: () => { changedAfterRename = true; },
        };
        const ui = { ask: async () => 'reply', confirm: async () => true, error: (m: string) => { throw new Error(m); }, info: () => undefined, notice: (m: string) => { notices.push(m); } };
        const renamed = await handleAspectSectionEditorMessage({ type: 'renameSection', id: 'answer' }, env, ui);
        assert.deepEqual(renames, [{ kind: 'section', from: 'answer', to: 'reply' }]);
        assert.ok(changedAfterRename, 'the views are redrawn after the choices moved');
        assert.equal(renamed?.carried, 'Choices carried over: run 1.');
        assert.deepEqual(notices, ['Choices carried over: run 1.']);

        renames.length = 0;
        const section = { id: 'reply', name: 'Answer', label: '', placement: 'system', defaultOption: 'short', options: [{ name: 'short', text: 'Brief.\n' }, { name: 'full', text: 'Full.\n' }] };
        const saved = await handleAspectSectionEditorMessage({ type: 'save', section, renames: { brief: 'short', full: 'gone', x: '' } }, env, ui);
        assert.deepEqual(renames, [{ kind: 'options', section: 'reply', options: { brief: 'short' } }], 'only renames to an option the section has');
        assert.equal(saved?.carried, 'Choices carried over: run 1.');
        renames.length = 0;
        const plainSave = await handleAspectSectionEditorMessage({ type: 'save', section }, env, ui);
        assert.deepEqual([renames, plainSave?.carried], [[], undefined], 'a save without renames carries nothing over');

        // The page: the draft's option renames go with Save; the host's `carried` is shown.
        const body = EXT('media', 'aspectSectionEditor', 'index.html').split(/<body[^>]*>/)[1].split('<script')[0];
        const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { runScripts: 'outside-only' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = dom.window as any;
        const posted: Array<Record<string, unknown>> = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => undefined });
        w.__INIT__ = {};
        w.eval(EXT('media', 'aspectSectionEditor', 'main.js'));
        const sendData = (data: Record<string, unknown>): void => { w.dispatchEvent(new w.MessageEvent('message', { data })); };
        const disk = { id: 'reply', name: 'Answer', label: '', placement: 'system', defaultOption: 'brief', options: [{ name: 'brief', text: 'B' }, { name: 'full', text: 'F' }], problems: [] };
        sendData({ type: 'data', sections: [disk], selected: 'reply' });
        const nameInput = (i: number): HTMLInputElement => w.document.querySelectorAll('.opt-name')[i];
        const typeInto = (el: HTMLInputElement, v: string): void => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
        typeInto(nameInput(0), 'short');
        w.document.getElementById('btnAddOption').click();
        typeInto(nameInput(2), 'new');
        posted.length = 0;
        w.document.getElementById('btnSave').click();
        assert.deepEqual(posted[0].renames, { brief: 'short' }, 'a renamed option, not the new one');
        w.document.getElementById('btnRevert').click();
        typeInto(w.document.getElementById('secName'), 'Answer style');
        posted.length = 0;
        w.document.getElementById('btnSave').click();
        assert.equal(posted[0].renames, undefined, 'no rename: no renames');
        sendData({ type: 'data', saved: 'reply', carried: 'Choices carried over: run 1.', sections: [disk], selected: 'reply' });
        assert.match(w.document.querySelector('.carried').textContent, /Choices carried over: run 1\./);
        sendData({ type: 'data', sections: [disk], selected: 'reply' });
        assert.ok(w.document.querySelector('.carried'), 'kept on a plain refresh');
        sendData({ type: 'data', saved: 'reply', sections: [disk], selected: 'reply' });
        assert.equal(w.document.querySelector('.carried'), null, 'gone with the next save');
        w.close();
    });

    test('CR-7: the wiring', () => {
        const handler = EXT('src', 'handlers', 'aspectSectionEditor-handler.ts');
        assert.match(handler, /renamed: \(rename\) => \(require\('\.\/aspectChoiceCommands'\) as typeof import\('\.\/aspectChoiceCommands'\)\)\.carryAspectChoicesOver\(rename\)/, 'the live editor carries over');
        assert.match(handler, /notice: \(message\) => \{ void vscode\.window\.showInformationMessage/);
        assert.match(EXT('src', 'extension.ts'), /renameAspectChoices: \(rename\) => applyAspectRenameRequest\(rename\)/, 'every window takes the request');
        const guide = EXT('doc', 'user_guide.md');
        assert.doesNotMatch(guide, /no longer apply until chosen again/);
        assert.match(guide, /carried over/);
        assert.equal(machineConfigPath(QUEST).startsWith(AI), true);
    });
});
