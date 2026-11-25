/**
 * The @CHAT action bar's reusable prompts on the host (chatPanel-handler.ts, src/utils/questPrompts.ts) through the
 * real chat panel provider under the vscode stub: the window's quest `q1`, a second quest `q2` with prompts, an
 * `_ai/prompt/` folder and a project `prompt/` folder with a file each.
 *
 *   CQ-1 `getReusablePrompts` answers the active quest's prompt files only — `{quest, files}`, no scopes, no
 *        preferred ids; neither the other quest's nor the `_ai/prompt/` nor the project folder's file is listed;
 *        the list is in the Reusable Prompt Editor's stored order
 *   CQ-2 a prompt is addressed by its file name in the active quest's folder: the content is loaded for the copy
 *        button; an id with a scope part, another quest's file, a path and the `_ai/prompt/` file resolve to nothing
 *   CQ-3 saving the tab's text writes `_ai/quests/<quest>/prompt/<name>.prompt.md` (the folder created on demand),
 *        asks before it overwrites, and sends the list again; a selection the page might send is not read
 *   CQ-4 the list follows the editor's change notice and a `refreshChoices` request
 *   CQ-5 without a quest the list is empty and nothing is saved
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_251125_01_aifmt-3_chatprompts-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const PROMPT_DIR = `_ai/quests/${QUEST}/prompt`;
/** The one list key of the quest's stored prompt order. */
const ORDER_KEY = 'reusablePrompts:quest:q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const at = (rel: string): string => path.join(WS, rel);
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/quests/q2/overview.q2.md', '# Q2\n');
put('_ai/quests/q2/prompt/other.prompt.md', 'the other quest\'s\n');
put('_ai/prompt/global.prompt.md', 'the old global place\n');
put('pkg/pubspec.yaml', 'name: pkg\n');
put('pkg/prompt/project.prompt.md', 'a project folder\n');
// The sandbox is a root of its own: its configuration is the one read and written.
const CONFIG = path.join(SANDBOX, '.tom', 'tom_vscode_extension.json');
fs.mkdirSync(path.join(SANDBOX, '.tom'), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, '.tom', 'tom_root.yaml'), 'root: true\n');
fs.writeFileSync(CONFIG, '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
const workspace = vscodeStub.stub.workspace as Record<string, unknown>;
const win = vscodeStub.stub.window as Record<string, unknown>;
const questFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
workspace.workspaceFile = questFile;

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerChatPanel } from '../chatPanel-handler.js';
import { moveInStoredOrder } from '../../services/editorListOrder.js';
import { NO_QUEST_PROMPTS_MESSAGE, notifyQuestPromptsChanged, questPromptsListKey } from '../../utils/questPrompts.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
};
const subscriptions: Array<{ dispose?: () => unknown }> = [];
const storage = path.join(SANDBOX, 'storage');
fs.mkdirSync(storage, { recursive: true });
const context = {
    subscriptions, extensionPath: EXT, extensionUri: { fsPath: EXT, scheme: 'file' },
    globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
    globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
    asAbsolutePath: (rel: string) => path.join(EXT, rel),
} as never;
setExtensionPath(EXT);
TomAiConfiguration.init(context);
TrailService.init(context);
ChatVariablesStore.init(context);
ProcessStateStore.init(context);
TimerEngine.init(context);
PromptQueueManager.init(context);
registerChatPanel(context);
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose?.(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const provider = (): Json => subscriptions.find((d) => d && (d as { constructor?: { name?: string } }).constructor?.name === 'ChatPanelViewProvider');
const posted: Json[] = [];
provider()._view = { webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } }, onDidDispose: () => ({ dispose: () => undefined }) };
const ofType = (type: string): Json[] => posted.filter((m) => m.type === type);
const file = (name: string) => ({ id: name, label: name });
/** The next input box answers `value`; a modal warning answers `button`. */
function dialogs(value: string | undefined, button?: string): { warnings: string[] } {
    const warnings: string[] = [];
    win.showInputBox = async () => value;
    win.showWarningMessage = async (message: string) => { warnings.push(message); return button; };
    return { warnings };
}

describe('chat panel: the active quest\'s reusable prompts', () => {
    test('CQ-1: only the active quest\'s prompt files', () => {
        provider()._sendReusablePrompts();
        assert.deepEqual(posted.splice(0), [{ type: 'reusablePrompts', quest: QUEST, files: [] }], 'the quest has no prompt folder yet');
        for (const name of ['a', 'b', 'c']) { put(`${PROMPT_DIR}/${name}.prompt.md`, `text of ${name}\n`); }
        put(`${PROMPT_DIR}/notes.md`, 'no prompt\n');
        provider()._sendReusablePrompts();
        assert.deepEqual(posted.splice(0), [{ type: 'reusablePrompts', quest: QUEST, files: [file('a.prompt.md'), file('b.prompt.md'), file('c.prompt.md')] }]);
        // The editor's order.
        assert.equal(moveInStoredOrder(questPromptsListKey(QUEST), ['a.prompt.md', 'b.prompt.md', 'c.prompt.md'], 'c.prompt.md', 'up'), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).editorListOrder, { [ORDER_KEY]: ['a.prompt.md', 'c.prompt.md', 'b.prompt.md'] }, 'stored in the sandbox root');
        provider()._sendReusablePrompts();
        const [message] = posted.splice(0);
        assert.deepEqual(Object.keys(message).sort(), ['files', 'quest', 'type'], 'no model, scopes or preferred ids');
        assert.deepEqual(message.files.map((f: Json) => f.id), ['a.prompt.md', 'c.prompt.md', 'b.prompt.md']);
        for (const gone of ['_getGlobalPromptsDir', '_getQuestPromptScopes', '_getPreferredQuestId', '_resolveReusablePromptTargetDir']) {
            assert.equal(typeof provider()[gone], 'undefined', gone);
        }
    });

    test('CQ-2: a prompt is its file name in the active quest\'s folder', () => {
        assert.deepEqual(provider()._parseReusablePromptId('a.prompt.md'), { filePath: at(`${PROMPT_DIR}/a.prompt.md`), fileName: 'a.prompt.md' });
        provider()._loadReusablePromptContent('a.prompt.md');
        assert.deepEqual(posted.splice(0), [{ type: 'reusablePromptContent', reusableId: 'a.prompt.md', content: 'text of a\n' }]);
        for (const id of [
            'global::global.prompt.md', 'global.prompt.md', 'quest::q2::other.prompt.md', 'other.prompt.md',
            `project::${encodeURIComponent(at('pkg'))}::project.prompt.md`, `scan::${encodeURIComponent(at('pkg/prompt'))}::project.prompt.md`,
            `path::${encodeURIComponent(at('_ai/prompt'))}::global.prompt.md`, '../../q2/prompt/other.prompt.md', '../../../prompt/global.prompt.md',
            at('_ai/prompt/global.prompt.md'), 'notes.md', '',
        ]) {
            provider()._loadReusablePromptContent(id);
            assert.deepEqual(posted.splice(0), [{ type: 'reusablePromptContent', reusableId: id, content: '' }], id);
        }
    });

    test('CQ-3: saving the tab\'s text as a prompt of the quest', async () => {
        fs.rmSync(at(PROMPT_DIR), { recursive: true, force: true });
        dialogs('review');
        await provider()._saveReusablePrompt('the text', { type: 'global', scopeId: '' });
        assert.equal(fs.readFileSync(at(`${PROMPT_DIR}/review.prompt.md`), 'utf-8'), 'the text');
        assert.deepEqual(fs.readdirSync(at('_ai/prompt')), ['global.prompt.md'], 'nothing in the old global place');
        assert.deepEqual(posted.splice(0), [{ type: 'reusablePrompts', quest: QUEST, files: [file('review.prompt.md')] }], 'the list again');
        // An existing prompt: asked first.
        const kept = dialogs('review.prompt.md', undefined);
        await provider()._saveReusablePrompt('second');
        assert.deepEqual(kept.warnings, ['Prompt "review.prompt.md" already exists. Overwrite?']);
        assert.equal(fs.readFileSync(at(`${PROMPT_DIR}/review.prompt.md`), 'utf-8'), 'the text');
        dialogs('review', 'Overwrite');
        await provider()._saveReusablePrompt('second');
        assert.equal(fs.readFileSync(at(`${PROMPT_DIR}/review.prompt.md`), 'utf-8'), 'second');
        // No name, no text, a path: nothing written.
        posted.length = 0;
        dialogs(undefined);
        await provider()._saveReusablePrompt('third');
        const empty = dialogs('x');
        await provider()._saveReusablePrompt('   ');
        assert.deepEqual(empty.warnings, ['Current tab text is empty; nothing to save.']);
        const escaping = dialogs('../../q2/prompt/taken');
        await provider()._saveReusablePrompt('fourth');
        assert.equal(escaping.warnings.length, 1);
        assert.deepEqual(fs.readdirSync(at(PROMPT_DIR)), ['review.prompt.md']);
        assert.deepEqual(fs.readdirSync(at('_ai/quests/q2/prompt')), ['other.prompt.md']);
        assert.deepEqual(posted, []);
    });

    test('CQ-4: the list follows the editor and a refresh request', () => {
        posted.length = 0;
        put(`${PROMPT_DIR}/later.prompt.md`, 'later\n');
        notifyQuestPromptsChanged();
        assert.deepEqual(ofType('reusablePrompts'), [{ type: 'reusablePrompts', quest: QUEST, files: [file('later.prompt.md'), file('review.prompt.md')] }]);
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf-8');
        assert.match(src, /case 'refreshChoices': \{[^}]*this\._sendReusablePrompts\(\);\s*this\._sendProfiles\(\);/);
        assert.doesNotMatch(src, /promptScopes|_ai', 'prompt'|ai\('prompt'\)|preferredProjectId|preferredScanId|preferredQuestId/);
    });

    test('CQ-5: without a quest', async () => {
        workspace.workspaceFile = undefined;
        try {
            posted.length = 0;
            provider()._sendReusablePrompts();
            assert.deepEqual(posted.splice(0), [{ type: 'reusablePrompts', quest: '', files: [] }]);
            assert.equal(provider()._parseReusablePromptId('review.prompt.md'), null);
            const told = dialogs('new');
            await provider()._saveReusablePrompt('text');
            assert.deepEqual(told.warnings, [NO_QUEST_PROMPTS_MESSAGE]);
            assert.deepEqual(fs.readdirSync(at(PROMPT_DIR)).sort(), ['later.prompt.md', 'review.prompt.md']);
            assert.deepEqual(fs.readdirSync(at('_ai/prompt')), ['global.prompt.md']);
        } finally {
            workspace.workspaceFile = questFile;
        }
    });
});
