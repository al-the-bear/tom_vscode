/**
 * Saved prompts are the active quest's `_ai/quests/<quest>/prompt/*.prompt.md` and nothing else
 * (src/utils/questPrompts.ts, reusablePromptEditor-handler.ts, the scripting bridge, tomAi_listDocuments), through
 * the vscode stub in a sandbox root of its own: the window's quest `q1`, a second quest `q2` with prompts, and an
 * `_ai/prompt/` folder with a file.
 *
 *   QP-1 the rules: the active quest's folder (null without a `.code-workspace`, for `default` and for a quest
 *        without a folder); a prompt file name is `<name>.prompt.md` without a folder part; a typed name gets the
 *        suffix; the list holds only `*.prompt.md`, by name; write (folder created, an existing file kept unless
 *        overwritten), rename (missing source, existing target refused) and delete act on the named file only
 *   QP-2 the editor host lists only the active quest's prompts; a `scope` / `subScopeId` in a message is not read;
 *        another quest's file and the `_ai/prompt/` file are neither listed nor loaded
 *   QP-3 the editor host creates, saves, renames and deletes in `_ai/quests/<quest>/prompt/` (created on demand);
 *        a name that is already taken is refused; the other quest's and the `_ai/prompt/` files stay untouched
 *   QP-4 Up / Down: the order is stored under the one key `reusablePrompts:quest:<quest>`; a renamed file keeps
 *        its place; every change of the list tells the listeners (the chat panel's dropdown)
 *   QP-5 without a quest the editor host answers no files and the reason, and writes nothing
 *   QP-6 `tomAi_listDocuments` `prompts` lists the active quest's folder; `exists: false` without a quest
 *   QP-7 the scripting bridge's prompt documents are the active quest's folder
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_251125_01_aifmt-3_questprompts-')));
const WS = path.join(SANDBOX, 'ws');
const CONFIG = path.join(SANDBOX, '.tom', 'tom_vscode_extension.json');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const at = (rel: string): string => path.join(WS, rel);
const has = (rel: string): boolean => fs.existsSync(at(rel));
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');

fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(CONFIG, JSON.stringify({ userName: 'kept' }, null, 2));
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/quests/q2/overview.q2.md', '# Q2\n');
put('_ai/quests/q2/prompt/other.prompt.md', 'the other quest\'s\n');
put('_ai/prompt/global.prompt.md', 'the old global place\n');
put('pkg/prompt/project.prompt.md', 'a project folder\n');
process.env.HOME = path.join(SANDBOX, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const vs = installVscodeStub({ workspaceFolders: [WS] });
const workspace = vs.stub.workspace as Record<string, unknown>;
const win = vs.stub.window as Record<string, unknown>;
const questFile = (quest: string) => ({ fsPath: path.join(WS, `${quest}.code-workspace`), scheme: 'file' });
workspace.workspaceFile = questFile(QUEST);
after(() => { vs.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// First: the tool modules import each other in a circle that only resolves from this end.
import { ALL_SHARED_TOOLS } from '../../tools/tool-executors.js';
import {
    NO_QUEST_PROMPTS_MESSAGE, activeQuestPromptFolder, deleteQuestPrompt, isQuestPromptFileName, listQuestPromptFiles,
    onQuestPromptsChanged, questPromptFileName, questPromptFilePath, questPromptsListKey, renameQuestPrompt, writeQuestPrompt,
} from '../../utils/questPrompts.js';
import { handleReusablePromptEditorMessage, reusablePromptEditorData } from '../reusablePromptEditor-handler.js';
import { TomScriptingBridgeHandler } from '../tomScriptingBridge-handler.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const PROMPT_DIR = `_ai/quests/${QUEST}/prompt`;
/** The one list key of the quest's stored prompt order. */
const ORDER_KEY = 'reusablePrompts:quest:q1';
const onDisk = (): Json => JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
const ids = (files: Array<{ id: string }>): string[] => files.map((f) => f.id);

/** One message to the editor host; answers what it posted. */
async function editor(msg: Record<string, unknown>): Promise<Json[]> {
    const posted: Json[] = [];
    await handleReusablePromptEditorMessage(msg, (m) => { posted.push(JSON.parse(JSON.stringify(m))); });
    return posted;
}
/** The next input box answers `value`; the next modal warning answers `button`. */
function dialogs(value: string | undefined, button?: string): { warnings: string[] } {
    const warnings: string[] = [];
    win.showInputBox = async () => value;
    win.showWarningMessage = async (message: string) => { warnings.push(message); return button; };
    return { warnings };
}
/** While `fn` runs the window has no quest. */
async function withoutQuest<T>(fn: () => T | Promise<T>): Promise<T> {
    workspace.workspaceFile = undefined;
    try { return await fn(); } finally { workspace.workspaceFile = questFile(QUEST); }
}

describe('saved prompts: only the active quest\'s', () => {
    test('QP-1: the rules', async () => {
        assert.deepEqual(activeQuestPromptFolder(), { questId: QUEST, dir: at(PROMPT_DIR) });
        assert.ok(!has(PROMPT_DIR), 'asking for the folder does not create it');
        assert.equal(await withoutQuest(() => activeQuestPromptFolder()), null, 'no .code-workspace');
        workspace.workspaceFile = questFile('default');
        assert.equal(activeQuestPromptFolder(), null, 'default is no quest');
        workspace.workspaceFile = questFile('nofolder');
        assert.equal(activeQuestPromptFolder(), null, 'a quest without a folder');
        workspace.workspaceFile = questFile(QUEST);
        assert.equal(questPromptsListKey('q1'), 'reusablePrompts:quest:q1');

        for (const good of ['a.prompt.md', 'with space.prompt.md']) { assert.equal(isQuestPromptFileName(good), true, good); }
        for (const bad of ['a.md', '.prompt.md', '../a.prompt.md', 'sub/a.prompt.md', 'sub\\a.prompt.md', '', undefined, 7]) {
            assert.equal(isQuestPromptFileName(bad), false, String(bad));
        }
        assert.equal(questPromptFileName(' review '), 'review.prompt.md');
        assert.equal(questPromptFileName('review.prompt.md'), 'review.prompt.md');
        assert.equal(questPromptFileName('review.md'), 'review.prompt.md');
        assert.equal(questPromptFileName('  '), null);
        assert.equal(questPromptFileName('../escape'), null);
        assert.equal(questPromptFilePath('/x', 'a.prompt.md'), path.join('/x', 'a.prompt.md'));
        assert.equal(questPromptFilePath('/x', '../a.prompt.md'), null);

        const dir = path.join(SANDBOX, 'rules', 'deep', 'prompt');
        assert.deepEqual(listQuestPromptFiles(dir), [], 'a missing folder lists nothing');
        assert.deepEqual(writeQuestPrompt(dir, 'b.prompt.md', 'B'), { ok: true, fileName: 'b.prompt.md', filePath: path.join(dir, 'b.prompt.md') });
        assert.equal(writeQuestPrompt(dir, 'a.prompt.md', 'A').ok, true);
        fs.writeFileSync(path.join(dir, 'notes.md'), 'no prompt');
        fs.mkdirSync(path.join(dir, 'folder.prompt.md.d'));
        assert.deepEqual(listQuestPromptFiles(dir), [{ id: 'a.prompt.md', label: 'a.prompt.md' }, { id: 'b.prompt.md', label: 'b.prompt.md' }]);
        assert.deepEqual(writeQuestPrompt(dir, 'a.prompt.md', 'again'), { ok: false, error: 'File "a.prompt.md" already exists.' });
        assert.equal(fs.readFileSync(path.join(dir, 'a.prompt.md'), 'utf-8'), 'A');
        assert.equal(writeQuestPrompt(dir, 'a.prompt.md', 'again', true).ok, true);
        assert.equal(fs.readFileSync(path.join(dir, 'a.prompt.md'), 'utf-8'), 'again');
        assert.equal(writeQuestPrompt(dir, '../out.prompt.md', 'x').ok, false);
        assert.ok(!fs.existsSync(path.join(dir, '..', 'out.prompt.md')));

        assert.deepEqual(renameQuestPrompt(dir, 'a.prompt.md', 'b.prompt.md'), { ok: false, error: 'File "b.prompt.md" already exists.' });
        assert.deepEqual(renameQuestPrompt(dir, 'gone.prompt.md', 'c.prompt.md'), { ok: false, error: 'File "gone.prompt.md" not found.' });
        assert.equal(renameQuestPrompt(dir, 'a.prompt.md', '../c.prompt.md').ok, false);
        assert.equal(renameQuestPrompt(dir, 'a.prompt.md', 'c.prompt.md').ok, true);
        assert.deepEqual(ids(listQuestPromptFiles(dir)), ['b.prompt.md', 'c.prompt.md']);
        assert.equal(fs.readFileSync(path.join(dir, 'c.prompt.md'), 'utf-8'), 'again');
        assert.equal(deleteQuestPrompt(dir, '../prompt/b.prompt.md'), false);
        assert.equal(deleteQuestPrompt(dir, 'notes.md'), false, 'only a prompt file');
        assert.equal(deleteQuestPrompt(dir, 'b.prompt.md'), true);
        assert.equal(deleteQuestPrompt(dir, 'b.prompt.md'), false);
        assert.deepEqual(fs.readdirSync(dir).sort(), ['c.prompt.md', 'folder.prompt.md.d', 'notes.md']);
    });

    test('QP-2: the editor host lists only the active quest\'s prompts', async () => {
        assert.deepEqual(await editor({ type: 'ready' }), [{ type: 'data', quest: QUEST, noQuestMessage: '', files: [], initialFileId: '' }]);
        put(`${PROMPT_DIR}/beta.prompt.md`, 'beta text\n');
        put(`${PROMPT_DIR}/alpha.prompt.md`, 'alpha text\n');
        put(`${PROMPT_DIR}/readme.md`, 'no prompt\n');
        for (const msg of [
            { type: 'ready' },
            { type: 'requestData', scope: 'global', subScopeId: 'global' },
            { type: 'requestData', scope: 'quest', subScopeId: 'q2' },
            { type: 'requestData', scope: 'project', subScopeId: encodeURIComponent(at('pkg')) },
            { type: 'requestData', scope: 'scan', subScopeId: encodeURIComponent(at('pkg/prompt')) },
        ]) {
            const [data] = await editor(msg);
            assert.equal(data.quest, QUEST, JSON.stringify(msg));
            assert.deepEqual(ids(data.files), ['alpha.prompt.md', 'beta.prompt.md'], JSON.stringify(msg));
        }
        assert.equal((await editor({ type: 'requestData', fileId: 'beta.prompt.md' }))[0].initialFileId, 'beta.prompt.md');
        assert.deepEqual(reusablePromptEditorData().files, [{ id: 'alpha.prompt.md', label: 'alpha.prompt.md' }, { id: 'beta.prompt.md', label: 'beta.prompt.md' }]);

        assert.deepEqual(await editor({ type: 'loadFile', fileId: 'alpha.prompt.md' }), [{ type: 'fileContent', fileId: 'alpha.prompt.md', content: 'alpha text\n' }]);
        // Another quest's file, the old global place, a path: nothing is read.
        for (const msg of [
            { type: 'loadFile', scope: 'quest', subScopeId: 'q2', fileId: 'other.prompt.md' },
            { type: 'loadFile', scope: 'global', subScopeId: 'global', fileId: 'global.prompt.md' },
            { type: 'loadFile', fileId: '../../q2/prompt/other.prompt.md' },
            { type: 'loadFile', fileId: '../../../prompt/global.prompt.md' },
        ]) {
            assert.deepEqual(await editor(msg), [{ type: 'fileContent', fileId: msg.fileId, content: '' }], JSON.stringify(msg));
        }
    });

    test('QP-3: creating, saving, renaming and deleting act in the quest\'s prompt folder', async () => {
        fs.rmSync(at(PROMPT_DIR), { recursive: true, force: true });
        const changes: number[] = [];
        const listening = onQuestPromptsChanged(() => { changes.push(changes.length + 1); });

        // Create: the folder is made with the first prompt; a scope in the message changes nothing.
        dialogs('review');
        assert.deepEqual(await editor({ type: 'add', scope: 'global', subScopeId: 'global' }), [
            { type: 'files', files: [{ id: 'review.prompt.md', label: 'review.prompt.md' }], selectFileId: 'review.prompt.md' },
        ]);
        assert.equal(read(`${PROMPT_DIR}/review.prompt.md`), '# review\n\n');
        assert.deepEqual(fs.readdirSync(at('_ai/prompt')), ['global.prompt.md'], 'nothing in the old global place');
        dialogs('build.prompt.md');
        await editor({ type: 'add', scope: 'quest', subScopeId: 'q2' });
        assert.ok(has(`${PROMPT_DIR}/build.prompt.md`));
        assert.deepEqual(fs.readdirSync(at('_ai/quests/q2/prompt')), ['other.prompt.md'], 'not in the other quest');
        // A taken name is refused, the file kept.
        put(`${PROMPT_DIR}/review.prompt.md`, 'mine\n');
        const taken = dialogs('review');
        assert.deepEqual(await editor({ type: 'add' }), []);
        assert.deepEqual(taken.warnings, ['File "review.prompt.md" already exists.']);
        assert.equal(read(`${PROMPT_DIR}/review.prompt.md`), 'mine\n');
        // Cancelled: nothing.
        dialogs(undefined);
        assert.deepEqual(await editor({ type: 'add' }), []);
        assert.deepEqual(changes, [1, 2]);

        // Save.
        await editor({ type: 'save', scope: 'quest', subScopeId: 'q2', fileId: 'review.prompt.md', content: 'saved\n' });
        assert.equal(read(`${PROMPT_DIR}/review.prompt.md`), 'saved\n');
        assert.ok(!has('_ai/quests/q2/prompt/review.prompt.md'));
        const badSave = dialogs(undefined);
        await editor({ type: 'save', fileId: '../../q2/prompt/other.prompt.md', content: 'overwritten' });
        assert.equal(read('_ai/quests/q2/prompt/other.prompt.md'), 'the other quest\'s\n');
        assert.equal(badSave.warnings.length, 1);

        // Rename.
        dialogs('check');
        assert.deepEqual(await editor({ type: 'rename', scope: 'scan', subScopeId: 'x', fileId: 'review.prompt.md' }), [
            { type: 'fileRenamed', fileId: 'review.prompt.md', newFileId: 'check.prompt.md', files: [{ id: 'build.prompt.md', label: 'build.prompt.md' }, { id: 'check.prompt.md', label: 'check.prompt.md' }] },
        ]);
        assert.equal(read(`${PROMPT_DIR}/check.prompt.md`), 'saved\n');
        assert.ok(!has(`${PROMPT_DIR}/review.prompt.md`));
        const clash = dialogs('build');
        assert.deepEqual(await editor({ type: 'rename', fileId: 'check.prompt.md' }), []);
        assert.deepEqual(clash.warnings, ['File "build.prompt.md" already exists.']);
        assert.deepEqual(fs.readdirSync(at(PROMPT_DIR)).sort(), ['build.prompt.md', 'check.prompt.md']);
        dialogs('other');
        assert.deepEqual(await editor({ type: 'rename', fileId: '../../q2/prompt/other.prompt.md' }), []);
        assert.ok(has('_ai/quests/q2/prompt/other.prompt.md'), 'a file of another quest is not renamed');
        assert.deepEqual(changes, [1, 2, 3]);

        // Delete: asked first; only the quest's file.
        dialogs(undefined, undefined);
        assert.deepEqual(await editor({ type: 'delete', fileId: 'build.prompt.md' }), []);
        assert.ok(has(`${PROMPT_DIR}/build.prompt.md`), 'not confirmed: kept');
        const confirm = dialogs(undefined, 'Delete');
        assert.deepEqual(await editor({ type: 'delete', scope: 'global', subScopeId: 'global', fileId: 'build.prompt.md' }), [
            { type: 'files', files: [{ id: 'check.prompt.md', label: 'check.prompt.md' }] },
            { type: 'fileDeleted', fileId: 'build.prompt.md' },
        ]);
        assert.deepEqual(confirm.warnings, ['Delete "build.prompt.md"?']);
        assert.ok(!has(`${PROMPT_DIR}/build.prompt.md`));
        assert.deepEqual(await editor({ type: 'delete', scope: 'global', subScopeId: 'global', fileId: 'global.prompt.md' }), [
            { type: 'files', files: [{ id: 'check.prompt.md', label: 'check.prompt.md' }] },
            { type: 'fileDeleted', fileId: 'global.prompt.md' },
        ], 'a name the quest does not have: the list again, nothing removed');
        assert.deepEqual(await editor({ type: 'delete', fileId: '../../q2/prompt/other.prompt.md' }), []);
        assert.equal(read('_ai/prompt/global.prompt.md'), 'the old global place\n');
        assert.equal(read('_ai/quests/q2/prompt/other.prompt.md'), 'the other quest\'s\n');
        assert.equal(read('pkg/prompt/project.prompt.md'), 'a project folder\n');
        listening.dispose();
    });

    test('QP-4: Up / Down under one key; a renamed file keeps its place', async () => {
        fs.rmSync(at(PROMPT_DIR), { recursive: true, force: true });
        for (const name of ['a', 'b', 'c']) { put(`${PROMPT_DIR}/${name}.prompt.md`, name); }
        let changes = 0;
        const listening = onQuestPromptsChanged(() => { changes++; });
        assert.deepEqual(await editor({ type: 'move', scope: 'global', subScopeId: 'global', fileId: 'c.prompt.md', direction: 'up' }), [
            { type: 'filesReordered', files: ['a', 'c', 'b'].map((n) => ({ id: `${n}.prompt.md`, label: `${n}.prompt.md` })) },
        ]);
        assert.deepEqual(onDisk().editorListOrder, { [ORDER_KEY]: ['a.prompt.md', 'c.prompt.md', 'b.prompt.md'] });
        assert.equal(onDisk().userName, 'kept');
        assert.deepEqual(await editor({ type: 'move', fileId: 'a.prompt.md', direction: 'up' }), [], 'the first entry stays');
        assert.deepEqual(await editor({ type: 'move', fileId: 'a.prompt.md', direction: 'sideways' }), []);
        assert.equal(changes, 1);
        assert.deepEqual(ids((await editor({ type: 'ready' }))[0].files), ['a.prompt.md', 'c.prompt.md', 'b.prompt.md']);

        dialogs('zeta');
        const [renamed] = await editor({ type: 'rename', fileId: 'c.prompt.md' });
        assert.deepEqual(ids(renamed.files), ['a.prompt.md', 'zeta.prompt.md', 'b.prompt.md'], 'in the place of the file it was');
        assert.deepEqual(onDisk().editorListOrder, { [ORDER_KEY]: ['a.prompt.md', 'zeta.prompt.md', 'b.prompt.md'] });
        // A file created later follows the placed ones.
        dialogs('aaa');
        const [added] = await editor({ type: 'add' });
        assert.deepEqual(ids(added.files), ['a.prompt.md', 'zeta.prompt.md', 'b.prompt.md', 'aaa.prompt.md']);
        assert.equal(changes, 3);
        listening.dispose();
        dialogs('bbb');
        await editor({ type: 'add' });
        assert.equal(changes, 3, 'a disposed listener is not told');
    });

    test('QP-5: without a quest nothing is offered and nothing written', async () => {
        await withoutQuest(async () => {
            assert.deepEqual(await editor({ type: 'ready' }), [{ type: 'data', quest: '', noQuestMessage: NO_QUEST_PROMPTS_MESSAGE, files: [], initialFileId: '' }]);
            assert.deepEqual(await editor({ type: 'requestData', scope: 'global', subScopeId: 'global', fileId: 'global.prompt.md' }),
                [{ type: 'data', quest: '', noQuestMessage: NO_QUEST_PROMPTS_MESSAGE, files: [], initialFileId: '' }]);
            const before = fs.readdirSync(at(PROMPT_DIR)).sort();
            const told = dialogs('new');
            assert.deepEqual(await editor({ type: 'add', scope: 'global', subScopeId: 'global' }), []);
            await editor({ type: 'save', scope: 'global', subScopeId: 'global', fileId: 'global.prompt.md', content: 'changed' });
            assert.deepEqual(await editor({ type: 'rename', fileId: 'a.prompt.md' }), []);
            assert.deepEqual(told.warnings, [NO_QUEST_PROMPTS_MESSAGE, NO_QUEST_PROMPTS_MESSAGE, NO_QUEST_PROMPTS_MESSAGE]);
            dialogs(undefined, 'Delete');
            assert.deepEqual(await editor({ type: 'delete', fileId: 'a.prompt.md' }), []);
            assert.deepEqual(await editor({ type: 'move', fileId: 'b.prompt.md', direction: 'up' }), []);
            assert.deepEqual(await editor({ type: 'loadFile', fileId: 'a.prompt.md' }), [{ type: 'fileContent', fileId: 'a.prompt.md', content: '' }]);
            assert.deepEqual(fs.readdirSync(at(PROMPT_DIR)).sort(), before);
            assert.equal(read('_ai/prompt/global.prompt.md'), 'the old global place\n');
            assert.deepEqual(fs.readdirSync(at('_ai/prompt')), ['global.prompt.md']);
        });
    });

    test('QP-6: tomAi_listDocuments `prompts` is the active quest\'s folder', async () => {
        fs.rmSync(at(PROMPT_DIR), { recursive: true, force: true });
        const LIST_DOCUMENTS_TOOL = ALL_SHARED_TOOLS.find((tool) => tool.name === 'tomAi_listDocuments')!;
        const list = async (input: Record<string, unknown>): Promise<Json> => JSON.parse(await LIST_DOCUMENTS_TOOL.execute(input as never));
        const none = await list({ category: 'prompts' });
        assert.deepEqual([none.ok, none.exists, none.files, none.resolvedFolder], [true, false, [], '_ai/quests/q1/prompt'], 'the quest has no prompt folder yet');
        put(`${PROMPT_DIR}/one.prompt.md`, '1');
        put(`${PROMPT_DIR}/drafts/two.prompt.md`, '2');
        const r = await list({ category: 'prompts' });
        assert.equal(r.ok, true);
        assert.equal(r.exists, true);
        assert.equal(r.categoryFolder, '_ai/quests/<active quest>/prompt');
        assert.equal(r.resolvedFolder, '_ai/quests/q1/prompt');
        assert.deepEqual(r.files, ['drafts/two.prompt.md', 'one.prompt.md'], 'neither _ai/prompt/global.prompt.md nor q2\'s other.prompt.md');
        assert.deepEqual((await list({ category: 'prompts', subPath: 'drafts' })).files, ['two.prompt.md']);
        assert.equal((await list({ category: 'prompts', subPath: '../../q2/prompt' })).ok, false);
        await withoutQuest(async () => {
            const q = await list({ category: 'prompts' });
            assert.deepEqual([q.ok, q.exists, q.fileCount, q.files], [true, false, 0, []]);
            assert.equal(q.resolvedFolder, '_ai/quests/<active quest>/prompt');
            assert.equal((await list({ category: 'roles' })).ok, true, 'the other categories do not need a quest');
        });
        assert.match(LIST_DOCUMENTS_TOOL.description, /`prompts` → the active quest's saved prompts, `_ai\/quests\/<active quest>\/prompt`/);
        assert.doesNotMatch(JSON.stringify([LIST_DOCUMENTS_TOOL.description, LIST_DOCUMENTS_TOOL.inputSchema]), /_ai\/prompt\b/);
    });

    test('QP-7: the scripting bridge\'s prompt documents', async () => {
        const bridge = new TomScriptingBridgeHandler() as unknown as { handleDocRequest(method: string, params: Json): Promise<Json> };
        const listed = await bridge.handleDocRequest('doc.listPromptsVce', {});
        assert.equal(listed.folder, at(PROMPT_DIR));
        assert.deepEqual(listed.documents.map((d: Json) => d.name).sort(), ['drafts', 'one.prompt.md']);
        assert.equal((await bridge.handleDocRequest('doc.readPromptVce', { filename: 'one.prompt.md' })).content, '1');
        const created = await bridge.handleDocRequest('doc.createPromptVce', { filename: 'made.prompt.md', content: 'made' });
        assert.equal(created.path, at(`${PROMPT_DIR}/made.prompt.md`));
        assert.equal(read(`${PROMPT_DIR}/made.prompt.md`), 'made');
        assert.deepEqual(fs.readdirSync(at('_ai/prompt')), ['global.prompt.md']);
        await withoutQuest(async () => {
            await assert.rejects(bridge.handleDocRequest('doc.listPromptsVce', {}), new RegExp(NO_QUEST_PROMPTS_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        });
    });
});
