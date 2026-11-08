/**
 * Create New Quest and the "no quest is open" hint (vsc_setup-5): the scaffold
 * in sandbox workspaces, the command and the hint through the vscode stub, the
 * shared banner helper in JSDOM.
 *
 *   CQ-1 the scaffold: the thirteen files, empty but for their headings; the workspace's folder `../../..`; the
 *        one todo (id `questsetup1_<code>-define-the-quest`, the interview it asks for) valid against the todo
 *        schema and read by the todo reader; the row in the Active Quests table, once
 *   CQ-2 an id that is taken, malformed, `default` or empty is refused, and nothing is written
 *   CQ-3 the command: the input boxes (the id box refuses a taken id), the quest created, the workspace offered
 *        and opened in a new window; with arguments no box opens and `offerOpen: false` offers nothing; a taken
 *        id through the arguments is an error; contributed and registered
 *   QH-1 the hint is shown only while no quest is open (quest `default`) and hidden once one is
 *   QH-2 the shared helper: asks for the hint when loaded, shows the banner first in the body (or in
 *        `#tomQuestHint`) with its text and the two buttons, a click posts the action, hidden again on `show: false`
 *   QH-3 the buttons dispatch: createQuest and setupWorkspaceFolder run their commands, another action runs nothing,
 *        other messages are not taken
 *   QH-4 the panels: @CHAT, @WS, PROCESS, QUEST NOTES, QUEST TODOS, SESSIONS, SESSION TODOS load the helper and
 *        wire the host side; WORKSPACE TODOS does not
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
// eslint-disable-next-line @typescript-eslint/naming-convention
import Ajv from 'ajv';
import { parse as parseYaml } from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'create-quest-')));
const WS = path.join(SANDBOX, 'ws');
fs.mkdirSync(path.join(WS, '_ai', 'quests', 'taken'), { recursive: true });
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
const EXT = path.resolve(__dirname, '..', '..', '..');
const REPO_WS = path.resolve(EXT, '..', '..', '..');

let inputAnswers: Array<string | undefined> = [];
const inputBoxes: Array<Record<string, unknown>> = [];
let infoAnswer: string | undefined;
const infos: unknown[][] = [];
const errors: string[] = [];
const stubbed = installVscodeStub({
    workspaceFolders: [WS],
    methodOverrides: {
        showInformationMessage: (...args: unknown[]) => { infos.push(args); return Promise.resolve(infoAnswer); },
        showErrorMessage: (msg: unknown) => { errors.push(String(msg)); return Promise.resolve(undefined); },
    },
});
const stubWindow = stubbed.stub.window as Record<string, unknown>;
stubWindow.showInputBox = async (options: Record<string, unknown>) => { inputBoxes.push(options); return inputAnswers.shift(); };
const stubWorkspace = stubbed.stub.workspace as Record<string, unknown>;

// Safe to import after the stub is wired into the resolver.
import { ACTIVE_QUESTS_FILE, createQuestScaffold, questIdProblem, questScaffoldFiles, registerActiveQuest } from '../../utils/questScaffold.js';
import { CREATE_QUEST_COMMAND, OPEN_QUEST_WORKSPACE, createQuest, registerCreateQuestCommand } from '../createQuest-handler.js';
import { QUEST_HINT_TEXT, handleQuestHintMessage, questHintMessage, wireQuestHintMessages } from '../questHint-handler.js';
import { SETUP_WORKSPACE_COMMAND } from '../setupWorkspaceFolder-handler.js';
import { readTodoFile } from '../../managers/questTodoManager.js';

after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const FILES = (id: string): string[] => [
    `${id}.code-workspace`, `overview.${id}.md`, `todos.${id}.todo.yaml`, `quest-notes.${id}.md`, `deferred.${id}.md`,
    `progress.${id}.md`, `decisions.${id}.md`, `questions.${id}.md`, `open_topics.${id}.md`, `references.${id}.md`,
    `quest_refresh.${id}.md`, `quest_documentation_update.${id}.md`, `extension_config.${id}.yaml`,
];
const TABLE = '# Quests\n\n## Active Quests\n\n| ID | Name | Description | Path |\n|----|------|-------------|------|\n| taken | Taken | x | `_ai/quests/taken/` |\n\nAfter the table.\n';
let counter = 0;
function workspace(withTable = true): string {
    const ws = path.join(SANDBOX, `w${++counter}`);
    fs.mkdirSync(path.join(ws, '_ai', 'quests', 'taken'), { recursive: true });
    if (withTable) {
        fs.mkdirSync(path.join(ws, '_copilot_guidelines'), { recursive: true });
        fs.writeFileSync(path.join(ws, ACTIVE_QUESTS_FILE), TABLE);
    }
    return ws;
}
const openFolderCalls = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args).filter((a) => a[0] === 'vscode.openFolder');
const commandsRun = (): unknown[] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args[0]);

describe('Create New Quest', () => {
    test('CQ-1: the scaffold', () => {
        const ws = workspace();
        const date = new Date(2026, 10, 8, 14, 5);
        const r = createQuestScaffold(ws, path.join(ws, '_ai', 'quests'), 'my_quest', 'My Quest', date);
        const folder = path.join(ws, '_ai', 'quests', 'my_quest');
        assert.equal(r.folder, folder);
        assert.deepEqual(r.files, FILES('my_quest'));
        assert.deepEqual(fs.readdirSync(folder).sort(), FILES('my_quest').sort());
        assert.equal(r.workspaceFile, path.join(folder, 'my_quest.code-workspace'));
        assert.deepEqual(JSON.parse(fs.readFileSync(r.workspaceFile, 'utf8')), { folders: [{ path: '../../..' }] });
        // Headings only: every Markdown file is headings, the quest id line, and fixed preamble text.
        const overview = fs.readFileSync(path.join(folder, 'overview.my_quest.md'), 'utf8');
        assert.match(overview, /^# Quest Overview: My Quest\n/);
        assert.match(overview, /\*\*Status:\*\* Active/);
        assert.deepEqual(overview.split('\n').filter((l) => l.startsWith('## ')),
            ['## Purpose', '## Scope', '## Related Projects', '## Current State', '## Objectives / Backlog', '## Constraints', '## Related Quests']);
        assert.equal(overview.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('**')).length, 0, 'no content');
        assert.match(fs.readFileSync(path.join(folder, 'decisions.my_quest.md'), 'utf8'), /^# Decisions — my_quest\n/);
        assert.match(fs.readFileSync(path.join(folder, 'questions.my_quest.md'), 'utf8'), /^# Questions — my_quest\n/);
        assert.deepEqual(parseYaml(fs.readFileSync(path.join(folder, 'extension_config.my_quest.yaml'), 'utf8')), {});
        // The todo.
        assert.equal(r.todoId, 'questsetup1_akho-define-the-quest');
        const todoFile = path.join(folder, 'todos.my_quest.todo.yaml');
        const doc = parseYaml(fs.readFileSync(todoFile, 'utf8'));
        assert.equal(doc.quest, 'my_quest');
        assert.equal(doc.todos.length, 1);
        const todo = doc.todos[0];
        assert.equal(todo.id, r.todoId);
        assert.equal(todo.status, 'not-started');
        for (const topic of ['tomAi_askUser', 'Purpose', 'Scope', 'Repositories and projects', 'Processes and roles', 'overview.my_quest.md', 'tomAi_createQuestTodo', 'tomAi_generateIdPrefix']) {
            assert.ok(todo.description.includes(topic), topic);
        }
        const schemaPath = path.join(REPO_WS, '_ai', 'schemas', 'yaml', 'todo.schema.json');
        if (fs.existsSync(schemaPath)) {
            const validate = new Ajv({ strict: false, validateFormats: false }).compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
            assert.ok(validate(doc), JSON.stringify(validate.errors));
        }
        assert.deepEqual(readTodoFile(todoFile).map((t) => t.id), [r.todoId], 'the todo reader takes it');
        // The registration.
        assert.equal(r.registration, 'added');
        const table = fs.readFileSync(path.join(ws, ACTIVE_QUESTS_FILE), 'utf8');
        assert.match(table, /\| taken \| Taken \| x \| `_ai\/quests\/taken\/` \|\n\| my_quest \| My Quest \| .* \| `_ai\/quests\/my_quest\/` \|\n\nAfter the table\./);
        assert.equal(registerActiveQuest(path.join(ws, ACTIVE_QUESTS_FILE), 'my_quest', 'My Quest'), 'present');
        assert.equal(registerActiveQuest(path.join(ws, 'missing.md'), 'x', 'X'), 'noFile');
        const noTable = createQuestScaffold(workspace(false), path.join(SANDBOX, `w${counter}`, '_ai', 'quests'), 'other', 'Other', date);
        assert.equal(noTable.registration, 'noFile');
        assert.equal(questScaffoldFiles('q', 'Q', date).length, 13);
    });

    test('CQ-2: ids refused', () => {
        const ws = workspace();
        const dir = path.join(ws, '_ai', 'quests');
        assert.match(questIdProblem('taken', dir)!, /exists already/);
        assert.match(questIdProblem('my-quest', dir)!, /letters, digits and `_` only/);
        assert.match(questIdProblem('a b', dir)!, /letters, digits and `_` only/);
        assert.match(questIdProblem('default', dir)!, /no-quest workspace/);
        assert.match(questIdProblem('', dir)!, /Enter a quest id/);
        assert.equal(questIdProblem('new_1', dir), undefined);
        assert.throws(() => createQuestScaffold(ws, dir, 'taken', 'Taken'), /exists already/);
        assert.deepEqual(fs.readdirSync(path.join(dir, 'taken')), [], 'nothing written into the existing folder');
        assert.equal(fs.readFileSync(path.join(ws, ACTIVE_QUESTS_FILE), 'utf8'), TABLE);
    });

    test('CQ-3: the command', async () => {
        // Interactive: the id box refuses a taken id; the name box offers the id's name.
        inputAnswers = ['first_quest', 'First Quest'];
        infoAnswer = OPEN_QUEST_WORKSPACE;
        const before = openFolderCalls().length;
        const out = await createQuest();
        assert.equal(out.ok, true);
        const validate = inputBoxes[0].validateInput as (v: string) => string | null;
        assert.match(validate('taken')!, /exists already/);
        assert.equal(validate('fresh'), null);
        assert.equal(inputBoxes[1].value, 'First Quest');
        assert.ok(fs.existsSync(path.join(WS, '_ai', 'quests', 'first_quest', 'todos.first_quest.todo.yaml')));
        assert.deepEqual(infos.at(-1)!.slice(1), [OPEN_QUEST_WORKSPACE]);
        assert.match(String(infos.at(-1)![0]), /Created the quest first_quest \(13 files .*Its todo questsetup1_.*-define-the-quest defines the quest with you/);
        const opened = openFolderCalls().slice(before);
        assert.equal((opened[0][1] as { fsPath: string }).fsPath, path.join(WS, '_ai', 'quests', 'first_quest', 'first_quest.code-workspace'));
        assert.deepEqual(opened[0][2], { forceNewWindow: true });
        // Cancelled at the id box.
        inputAnswers = [undefined];
        assert.deepEqual(await createQuest(), { ok: false, error: 'cancelled', cancelled: true });
        // With arguments: no box, nothing offered.
        const boxes = inputBoxes.length;
        const agent = await createQuest({ id: 'agent_quest', name: 'Agent Quest', offerOpen: false });
        assert.equal(agent.ok, true);
        assert.equal(inputBoxes.length, boxes, 'no input box');
        assert.equal(infos.at(-1)!.length, 1, 'no button');
        assert.equal(openFolderCalls().length, before + 1, 'nothing opened');
        const taken = await createQuest({ id: 'taken', name: 'Taken' });
        assert.equal(taken.ok, false);
        assert.match(errors.at(-1)!, /exists already/);
        // Contributed and registered.
        const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === CREATE_QUEST_COMMAND && c.title === '@T: Create New Quest'));
        const registered = new Map<string, (a?: unknown) => Promise<unknown>>();
        const cmds = stubbed.stub.commands as Record<string, unknown>;
        const original = cmds.registerCommand;
        cmds.registerCommand = (id: string, fn: (a?: unknown) => Promise<unknown>) => { registered.set(id, fn); return { dispose: () => undefined }; };
        try { registerCreateQuestCommand({ subscriptions: [] } as never); } finally { cmds.registerCommand = original; }
        const viaCommand = await registered.get(CREATE_QUEST_COMMAND)!({ id: 'cmd_quest', name: 'Cmd', offerOpen: false }) as { ok: boolean; quest: string };
        assert.deepEqual([viaCommand.ok, viaCommand.quest], [true, 'cmd_quest']);
    });
});

describe('The no-quest hint', () => {
    test('QH-1: only while no quest is open', async () => {
        stubWorkspace.workspaceFile = undefined;
        assert.deepEqual(questHintMessage(), {
            type: 'questHint',
            show: true,
            text: QUEST_HINT_TEXT,
            buttons: [{ action: 'createQuest', label: 'Create new quest' }, { action: 'setupWorkspaceFolder', label: 'Setup new workspace folder' }],
        });
        assert.equal(QUEST_HINT_TEXT, 'No quest is open. Open a quest workspace (_ai/quests/<id>/<id>.code-workspace) or create one.');
        const posted: unknown[] = [];
        const webview = { postMessage: async (m: unknown) => { posted.push(m); return true; } };
        assert.equal(await handleQuestHintMessage({ type: 'questHintReady' }, webview), true);
        stubWorkspace.workspaceFile = { fsPath: path.join(WS, 'default.code-workspace'), scheme: 'file' };
        await handleQuestHintMessage({ type: 'questHintReady' }, webview);
        stubWorkspace.workspaceFile = { fsPath: path.join(WS, '_ai', 'quests', 'taken', 'taken.code-workspace'), scheme: 'file' };
        await handleQuestHintMessage({ type: 'questHintReady' }, webview);
        assert.deepEqual(posted.map((m) => (m as { show: boolean }).show), [true, true, false], 'hidden once a quest is open');
        stubWorkspace.workspaceFile = undefined;
    });

    test('QH-2: the shared helper', (t) => {
        const dom = new JSDOM('<body><div id="first">panel</div></body>', { runScripts: 'outside-only' });
        t.after(() => dom.window.close());
        const w = dom.window as unknown as Record<string, unknown> & { eval(s: string): unknown; postMessage(m: unknown, o: string): void };
        const posted: Array<Record<string, unknown>> = [];
        w.__tomVscodeApi = { postMessage: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))) };
        w.eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'questHint.js'), 'utf8'));
        assert.deepEqual(posted, [{ type: 'questHintReady' }], 'asks for the hint when loaded');
        const doc = dom.window.document;
        const deliver = (m: unknown): void => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m })); };
        deliver(questHintMessage(true));
        const banner = doc.body.firstElementChild!;
        assert.equal(banner.className, 'tom-quest-hint');
        assert.equal(banner.querySelector('.tom-quest-hint-text')!.textContent, QUEST_HINT_TEXT);
        const buttons = [...banner.querySelectorAll('button')];
        assert.deepEqual(buttons.map((b) => [b.textContent, b.getAttribute('data-quest-hint-action')]), [['Create new quest', 'createQuest'], ['Setup new workspace folder', 'setupWorkspaceFolder']]);
        buttons[0].click();
        buttons[1].click();
        assert.deepEqual(posted.slice(1), [{ type: 'questHintAction', action: 'createQuest' }, { type: 'questHintAction', action: 'setupWorkspaceFolder' }]);
        deliver(questHintMessage(true));
        assert.equal(doc.querySelectorAll('.tom-quest-hint').length, 1, 'shown once');
        deliver(questHintMessage(false));
        assert.equal(doc.querySelectorAll('.tom-quest-hint').length, 0, 'hidden');
        assert.equal(doc.body.firstElementChild!.id, 'first');
        // A page with a slot gets it there.
        const slotted = new JSDOM('<body><div id="a"></div><div id="tomQuestHint"></div></body>', { runScripts: 'outside-only' });
        t.after(() => slotted.window.close());
        (slotted.window as unknown as Record<string, unknown>).__tomVscodeApi = { postMessage: () => undefined };
        (slotted.window as unknown as { eval(s: string): unknown }).eval(fs.readFileSync(path.join(EXT, 'media', 'shared', 'questHint.js'), 'utf8'));
        slotted.window.dispatchEvent(new slotted.window.MessageEvent('message', { data: questHintMessage(true) }));
        assert.ok(slotted.window.document.querySelector('#tomQuestHint > .tom-quest-hint'));
    });

    test('QH-3: the buttons dispatch', async () => {
        const webview = { postMessage: async () => true };
        const count = (cmd: string): number => commandsRun().filter((c) => c === cmd).length;
        const total = (): number => stubbed.spies.byMethod('commands.executeCommand').length;
        const [create, setup] = [count(CREATE_QUEST_COMMAND), count(SETUP_WORKSPACE_COMMAND)];
        assert.equal(await handleQuestHintMessage({ type: 'questHintAction', action: 'createQuest' }, webview), true);
        assert.equal(await handleQuestHintMessage({ type: 'questHintAction', action: 'setupWorkspaceFolder' }, webview), true);
        assert.deepEqual([count(CREATE_QUEST_COMMAND), count(SETUP_WORKSPACE_COMMAND)], [create + 1, setup + 1]);
        const runs = total();
        assert.equal(await handleQuestHintMessage({ type: 'questHintAction', action: 'rm -rf' }, webview), true);
        assert.equal(total(), runs, 'another action runs nothing');
        assert.equal(await handleQuestHintMessage({ type: 'sendCopilot' }, webview), false, 'not the hint\'s');
        // As its own listener on a webview.
        let listener: ((m: unknown) => void) | undefined;
        const posted: unknown[] = [];
        wireQuestHintMessages({ postMessage: async (m: unknown) => { posted.push(m); return true; }, onDidReceiveMessage: ((fn: (m: unknown) => void) => { listener = fn; return { dispose: () => undefined }; }) as never });
        listener!({ type: 'questHintReady' });
        await new Promise((r) => setImmediate(r));
        assert.equal((posted[0] as { type: string }).type, 'questHint');
    });

    test('QH-4: the panels', () => {
        const read = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');
        // Pages loaded from media/: the CSS, and the helper after the panel's script.
        for (const page of ['chatPanel', 'processPanel', 'sessionsView', path.join('sidebarNotes', 'questNotes')]) {
            const html = read('media', page, 'index.html');
            assert.ok(html.includes('<link rel="stylesheet" href="{{sharedUri}}/questHint.css">'), `${page}: css`);
            assert.ok(html.indexOf('{{sharedUri}}/questHint.js') > html.indexOf('{{baseUri}}/main.js'), `${page}: after main.js`);
        }
        for (const page of ['processPanel', 'sessionsView']) {
            assert.match(read('media', page, 'main.js'), /window\.__tomVscodeApi = vscode;/, `${page} publishes its API`);
        }
        // The host side of each.
        for (const handler of ['chatPanel', 'processPanel', 'sessionsView', 'wsPanel']) {
            assert.match(read('src', 'handlers', `${handler}-handler.ts`), /subscriptions\.push\(wireQuestHintMessages\(webviewView\.webview\)\)/, handler);
        }
        const notes = read('src', 'handlers', 'sidebarNotes-handler.ts');
        assert.match(notes, /sidebarNotes\/questNotes'\);\n\s+wireCompletionMessages\(webviewView\.webview\);\n\s+\/\/ The "no quest is open" banner[^\n]*\n\s+this\._context\.subscriptions\.push\(wireQuestHintMessages/);
        // @WS inlines the helper after main.js and completion.js.
        const ws = read('src', 'handlers', 'wsPanel-handler.ts');
        assert.ok(ws.indexOf("readMediaText('shared', 'questHint.js')") > ws.indexOf("readMediaText('shared', 'completion.js')"));
        assert.ok(ws.includes("readMediaText('shared', 'questHint.css')"));
        // QUEST TODOS and SESSION TODOS (questHint: true), not WORKSPACE TODOS.
        const providers = [...notes.matchAll(/const (\w+)Provider = new QuestTodoEmbeddedViewProvider\([^{]*\{([^}]*)\}/g)].map((m) => [m[1], /questHint: true/.test(m[2])]);
        assert.deepEqual(providers, [['workspaceTodos', false], ['questTodos', true], ['sessionTodos', true]]);
        const todo = read('src', 'handlers', 'questTodoPanel-handler.ts');
        assert.match(todo, /if \(this\.config\?\.questHint\) \{\n\s+this\.context\.subscriptions\.push\(wireQuestHintMessages\(webviewView\.webview\)\);/);
        assert.match(todo, /const questHintJs = config\?\.questHint \? `<script src="\$\{shared\('questHint\.js'\)\}"><\/script>` : '';/);
    });
});
