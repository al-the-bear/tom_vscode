/**
 * The NOTES panels' buttons and messages (src/handlers/sidebarNotes-handler.ts,
 * src/handlers/notepad/notesFileActions.ts), the providers driven through the
 * vscode stub with a fake webview view.
 *
 *   SNB-1 handleNotesFileMessage: each open message reaches its opener with the notes file, created first
 *         when missing; another message is not taken; without a file it warns and opens nothing
 *   SNB-2 VS CODE NOTES: Open in MD Browser opens the global notes file in the MD Browser, Open in MD
 *         Viewer hands it to the external application, Open in Editor shows it in an editor
 *   SNB-3 QUEST NOTES opens the quest's default notes file (notes/quest-notes.md, created with its header);
 *         WORKSPACE NOTES opens `_ai/workspaces/<workspace>.notes.md`, created from the file the window had
 *         picked (the one-time import; the picked file stays, its workspaceState key is dropped)
 *   SNB-4 the prompt features are gone: sendToCopilot, selectTemplate and previewPrompt do nothing, and
 *         no panel's state carries templates
 *   SNB-5 QUEST NOTES (sidebar): the state lists the quest's notes files and names the one shown;
 *         selectNotesFile shows and saves another file; newNotesFile creates one in notes/ and shows it; the
 *         QUEST NOTES side panel shares the choice and shows what the sidebar view saves
 *   SNB-6 WORKSPACE NOTES: one file, read and saved; no file pick (changeFile / createNotesFile do nothing,
 *         no file dialog, the host names no picked-file state but for the import); an existing workspace
 *         notes file is never replaced by an import
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-open-buttons-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const mdBrowserOpens: Array<{ filePath: string; context: unknown }> = [];
const warnings: string[] = [];
const commands: string[] = [];
const providers = new Map<string, { resolveWebviewView(view: unknown): void }>();
const vscodeStub = installVscodeStub({
    workspaceFolders: [WS],
    // The lazy require in notesFileActions.ts; the panels' own './markdownBrowser-handler' imports are other specs.
    moduleOverrides: {
        '../markdownBrowser-handler': {
            openMarkdownBrowser: (context: unknown, filePath: string) => { mdBrowserOpens.push({ context, filePath }); return 'panel'; },
        },
    },
    methodOverrides: {
        showWarningMessage: (msg: unknown) => { warnings.push(String(msg)); return Promise.resolve(undefined); },
        executeCommand: (cmd: unknown) => { commands.push(String(cmd)); return Promise.resolve(undefined); },
    },
});
const stubWindow = vscodeStub.stub.window as Record<string, unknown>;
stubWindow.registerWebviewViewProvider = (id: string, provider: { resolveWebviewView(view: unknown): void }) => {
    providers.set(id, provider);
    return { dispose: () => undefined };
};
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { setExtensionPath } from '../handler_shared.js';
import { registerDsNotesViews } from '../sidebarNotes-handler.js';
import { QuestNotesPanelProvider } from '../questNotesPanel-handler.js';
import { handleNotesFileMessage, NOTES_FILE_MESSAGES, type NotesFileOpeners } from '../notepad/notesFileActions.js';

setExtensionPath(EXT_ROOT);

after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()] };
};
const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extensionPath: EXT_ROOT,
    extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
    workspaceState: memento() as { get(k: string, d?: unknown): unknown; update(k: string, v: unknown): Promise<void> },
    globalState: memento(),
};
// What the window had picked for WORKSPACE NOTES before: imported once into the workspace notes file.
const PICKED_NOTES = path.join(WS, 'docs', 'my-notes.md');
fs.mkdirSync(path.dirname(PICKED_NOTES), { recursive: true });
fs.writeFileSync(PICKED_NOTES, '# Picked\n\nearlier notes\n');
fs.writeFileSync(path.join(WS, 'notes.md'), '# Root notes\n');
void context.workspaceState.update('tomAi.notes.workspaceNoteFile', PICKED_NOTES);
const inputAnswers: Array<string | undefined> = [];
stubWindow.showInputBox = async () => inputAnswers.shift();
const dialogs: string[] = [];
stubWindow.showOpenDialog = async () => { dialogs.push('open'); return undefined; };
stubWindow.showSaveDialog = async () => { dialogs.push('save'); return undefined; };
registerDsNotesViews(context as never);
after(() => { for (const p of providers.values()) { (p as { dispose?(): void }).dispose?.(); } });

/** A fake webview view: collects the panel's message handlers and what it posts. */
function resolve(viewId: string): { send(msg: Record<string, unknown>): Promise<void>; posted: Array<Record<string, unknown>> } {
    const provider = providers.get(viewId);
    assert.ok(provider, `provider ${viewId} registered`);
    const handlers: Array<(m: unknown) => unknown> = [];
    const posted: Array<Record<string, unknown>> = [];
    const view = {
        visible: true,
        onDidChangeVisibility: () => ({ dispose: () => undefined }),
        webview: {
            options: {},
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: (u: unknown) => u,
            onDidReceiveMessage: (fn: (m: unknown) => unknown) => { handlers.push(fn); return { dispose: () => undefined }; },
            postMessage: async (m: Record<string, unknown>) => { posted.push(m); return true; },
        },
    };
    provider.resolveWebviewView(view);
    return {
        posted,
        async send(msg) { for (const h of handlers) { await h(msg); } },
    };
}

const GLOBAL_NOTES = path.join(HOME, '.tom', 'notes', 'global_notes.md');
const NOTES_DIR = path.join(WS, '_ai', 'quests', QUEST, 'notes');
const QUEST_NOTES = path.join(NOTES_DIR, 'quest-notes.md');
const WS_NOTES = path.join(WS, '_ai', 'workspaces', 'ws.notes.md');

describe('NOTES panels: open buttons', () => {
    test('SNB-1: handleNotesFileMessage', async () => {
        const opened: string[] = [];
        const openers: NotesFileOpeners = {
            openInEditor: async (fp) => { opened.push(`editor:${fp}`); },
            openInMdBrowser: (_ctx, fp) => { opened.push(`browser:${fp}`); },
            openInMdViewer: async (fp) => { opened.push(`viewer:${fp}`); },
        };
        let ensured = 0;
        const file = { path: '/n.md', ensureFile: () => { ensured++; } };
        for (const type of NOTES_FILE_MESSAGES) {
            assert.equal(await handleNotesFileMessage(type, file, context as never, openers), true);
        }
        assert.deepEqual(opened, ['editor:/n.md', 'browser:/n.md', 'viewer:/n.md']);
        assert.equal(ensured, 3, 'the file is created before it is opened');
        assert.equal(await handleNotesFileMessage('previewMarkdown', file, context as never, openers), false);
        warnings.length = 0;
        assert.equal(await handleNotesFileMessage('openInMdBrowser', null, context as never, openers), true);
        assert.equal(opened.length, 3, 'nothing opened without a file');
        assert.deepEqual(warnings, ['No notes file configured']);
    });

    test('SNB-2: VS CODE NOTES opens its file in the MD Browser, the MD Viewer and the editor', async () => {
        const panel = resolve('tomAi.vscodeNotes');
        mdBrowserOpens.length = 0;
        await panel.send({ type: 'openInMdBrowser' });
        assert.deepEqual(mdBrowserOpens.map((o) => o.filePath), [GLOBAL_NOTES]);
        assert.equal(mdBrowserOpens[0].context, context);

        warnings.length = 0;
        await panel.send({ type: 'openInMdViewer' });
        // No external application is configured in the sandbox: openInExternalApplication says so.
        assert.deepEqual(warnings, ['No external application configured for this file type.']);

        vscodeStub.spies.clear();
        await panel.send({ type: 'openInEditor' });
        const shown = vscodeStub.spies.byMethod('window.showTextDocument');
        assert.equal(shown.length, 1);
        assert.equal((shown[0].args[0] as { uri: { fsPath: string } }).uri.fsPath, GLOBAL_NOTES);
    });

    test('SNB-3: QUEST NOTES opens the quest notes; WORKSPACE NOTES opens the workspace notes file', async () => {
        const quest = resolve('tomAi.questNotes');
        await quest.send({ type: 'ready' });
        assert.equal(fs.readFileSync(QUEST_NOTES, 'utf8'), `# Quest Notes — ${QUEST}\n\n`, 'created with its header when first shown');
        mdBrowserOpens.length = 0;
        await quest.send({ type: 'openInMdBrowser' });
        assert.deepEqual(mdBrowserOpens.map((o) => o.filePath), [QUEST_NOTES]);

        assert.equal(fs.existsSync(WS_NOTES), false);
        const ws = resolve('tomAi.workspaceNotes');
        await ws.send({ type: 'ready' });
        assert.equal(fs.readFileSync(WS_NOTES, 'utf8'), '# Picked\n\nearlier notes\n', 'imported from the file the window had picked');
        assert.equal(fs.readFileSync(PICKED_NOTES, 'utf8'), '# Picked\n\nearlier notes\n', 'the picked file is left as it is');
        assert.equal(context.workspaceState.get('tomAi.notes.workspaceNoteFile'), undefined, 'the picked file is not read again');
        const state = ws.posted.find((m) => m.type === 'state');
        assert.deepEqual(state, { type: 'state', content: '# Picked\n\nearlier notes\n', filePath: WS_NOTES, workspaceName: 'ws', hasWorkspace: true });
        mdBrowserOpens.length = 0;
        warnings.length = 0;
        await ws.send({ type: 'openInMdBrowser' });
        assert.deepEqual(mdBrowserOpens.map((o) => o.filePath), [WS_NOTES]);
        assert.deepEqual(warnings, []);
    });

    test('SNB-4: the prompt messages do nothing and the state has no templates', async () => {
        for (const id of ['tomAi.vscodeNotes', 'tomAi.questNotes', 'tomAi.workspaceNotes']) {
            const panel = resolve(id);
            commands.length = 0;
            vscodeStub.spies.clear();
            await panel.send({ type: 'sendToCopilot', selectedText: 'x' });
            await panel.send({ type: 'previewPrompt' });
            await panel.send({ type: 'selectTemplate', key: 'make_ws_todo' });
            assert.deepEqual(commands, [], `${id}: nothing sent to a chat`);
            assert.equal(vscodeStub.spies.byMethod('window.createWebviewPanel').length, 0, `${id}: no prompt preview`);
            panel.posted.length = 0;
            await panel.send({ type: 'ready' });
            const state = panel.posted.find((m) => m.type === 'state');
            assert.ok(state, `${id} posts its state`);
            assert.equal('templates' in state, false, `${id}: no templates`);
            assert.equal('selectedTemplate' in state, false, `${id}: no selected template`);
        }
    });

    test('SNB-5: QUEST NOTES lists, switches and creates notes files, with the side panel', async () => {
        fs.writeFileSync(path.join(NOTES_DIR, 'ideas.md'), '# ideas\n');
        const quest = resolve('tomAi.questNotes');
        await quest.send({ type: 'ready' });
        const states = (): Array<Record<string, unknown>> => quest.posted.filter((m) => m.type === 'state');
        const list = [{ name: 'quest-notes.md', isDefault: true }, { name: 'ideas.md', isDefault: false }];
        assert.deepEqual([states()[0].notesFiles, states()[0].notesFile, states()[0].filePath], [list, 'quest-notes.md', QUEST_NOTES]);

        // The side panel, on the same quest in the same window.
        const panel = new QuestNotesPanelProvider(context as never, 40);
        const panelPosted: Array<Record<string, unknown>> = [];
        panel.resolveWebviewView({
            visible: true, title: '',
            onDidChangeVisibility: () => ({ dispose: () => undefined }),
            onDidDispose: () => ({ dispose: () => undefined }),
            webview: {
                options: {}, html: '', cspSource: 'vscode-resource:',
                asWebviewUri: (u: { fsPath?: string; path?: string }) => ({ toString: () => `res:${u.fsPath ?? u.path}` }),
                onDidReceiveMessage: () => ({ dispose: () => undefined }),
                postMessage: async (m: Record<string, unknown>) => { panelPosted.push(m); return true; },
            },
        } as never);
        try {
            await panel.handleMessage({ type: 'ready' });
            const panelStates = (): Array<Record<string, unknown>> => panelPosted.filter((m) => m.type === 'notesState');

            quest.posted.length = 0;
            await quest.send({ type: 'selectNotesFile', name: 'ideas.md' });
            assert.deepEqual([states().pop()!.notesFile, states().pop()!.content, states().pop()!.filePath], ['ideas.md', '# ideas\n', path.join(NOTES_DIR, 'ideas.md')]);
            assert.deepEqual([panelStates().pop()!.notesFile, panelStates().pop()!.content], ['ideas.md', '# ideas\n'], 'the side panel follows the switch');

            await quest.send({ type: 'updateContent', content: '# ideas\n\none more\n' });
            assert.equal(fs.readFileSync(path.join(NOTES_DIR, 'ideas.md'), 'utf8'), '# ideas\n\none more\n');
            assert.equal(fs.readFileSync(QUEST_NOTES, 'utf8'), `# Quest Notes — ${QUEST}\n\n`, 'the default is not written');
            const end = Date.now() + 3000;
            while (!panelStates().some((m) => m.external === true && m.content === '# ideas\n\none more\n')) {
                assert.ok(Date.now() < end, 'the side panel shows what the sidebar view saved');
                await new Promise((r) => setTimeout(r, 20));
            }

            mdBrowserOpens.length = 0;
            await quest.send({ type: 'openInMdBrowser' });
            assert.deepEqual(mdBrowserOpens.map((o) => o.filePath), [path.join(NOTES_DIR, 'ideas.md')], 'the buttons act on the file shown');

            // The side panel switches back: the sidebar view follows.
            quest.posted.length = 0;
            await panel.handleMessage({ type: 'selectNotesFile', name: 'quest-notes.md' });
            assert.deepEqual([states().pop()!.notesFile, states().pop()!.filePath], ['quest-notes.md', QUEST_NOTES]);

            inputAnswers.push('Retro 1');
            await quest.send({ type: 'newNotesFile' });
            assert.equal(fs.readFileSync(path.join(NOTES_DIR, 'Retro 1.md'), 'utf8'), '# Retro 1\n\n');
            assert.deepEqual([states().pop()!.notesFile, (states().pop()!.notesFiles as Array<{ name: string }>).map((f) => f.name)],
                ['Retro 1.md', ['quest-notes.md', 'ideas.md', 'Retro 1.md']]);
            assert.equal(panelStates().pop()!.notesFile, 'Retro 1.md');
            assert.deepEqual(context.workspaceState.get('tomAi.notes.questNotesFile'), { [QUEST]: 'Retro 1.md' });
        } finally {
            panel.dispose();
        }
    });

    test('SNB-6: WORKSPACE NOTES is one file without a file pick', async () => {
        const ws = resolve('tomAi.workspaceNotes');
        await ws.send({ type: 'ready' });
        await ws.send({ type: 'updateContent', content: '# Workspace\n\nmine\n' });
        assert.equal(fs.readFileSync(WS_NOTES, 'utf8'), '# Workspace\n\nmine\n');

        dialogs.length = 0;
        ws.posted.length = 0;
        await ws.send({ type: 'changeFile' });
        await ws.send({ type: 'createNotesFile' });
        assert.deepEqual(dialogs, [], 'no file dialog');
        assert.equal(ws.posted.length, 0);
        assert.equal(context.workspaceState.get('tomAi.notes.workspaceNoteFile'), undefined);

        // A picked file or a notes.md appearing later is not imported over the workspace notes file.
        await context.workspaceState.update('tomAi.notes.workspaceNoteFile', PICKED_NOTES);
        const again = resolve('tomAi.workspaceNotes');
        await again.send({ type: 'ready' });
        assert.equal(fs.readFileSync(WS_NOTES, 'utf8'), '# Workspace\n\nmine\n');
        assert.equal(again.posted.find((m) => m.type === 'state')!.content, '# Workspace\n\nmine\n');

        const host = fs.readFileSync(path.join(EXT_ROOT, 'src', 'handlers', 'sidebarNotes-handler.ts'), 'utf8');
        assert.doesNotMatch(host, /showOpenDialog|showSaveDialog|'changeFile'|'createNotesFile'/);
        assert.equal(host.split('tomAi.notes.workspaceNoteFile').length - 1, 1, 'the picked-file key is named once, for the import');
        assert.doesNotMatch(host, /workspaceState\.update\(PICKED_WORKSPACE_NOTES_KEY, (?!undefined)/, 'the key is only ever dropped');
    });
});
