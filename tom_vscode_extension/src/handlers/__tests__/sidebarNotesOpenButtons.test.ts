/**
 * The NOTES panels' buttons and messages (src/handlers/sidebarNotes-handler.ts,
 * src/handlers/notepad/notesFileActions.ts), the providers driven through the
 * vscode stub with a fake webview view.
 *
 *   SNB-1 handleNotesFileMessage: each open message reaches its opener with the notes file, created first
 *         when missing; another message is not taken; without a file it warns and opens nothing
 *   SNB-2 VS CODE NOTES: Open in MD Browser opens the global notes file in the MD Browser, Open in MD
 *         Viewer hands it to the external application, Open in Editor shows it in an editor
 *   SNB-3 QUEST NOTES opens the quest's notes file; WORKSPACE NOTES without a file warns and opens nothing
 *   SNB-4 the prompt features are gone: sendToCopilot, selectTemplate and previewPrompt do nothing, and
 *         no panel's state carries templates
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
    workspaceState: memento(),
    globalState: memento(),
};
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
const QUEST_NOTES = path.join(WS, '_ai', 'quests', QUEST, `quest-notes.${QUEST}.md`);

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

    test('SNB-3: QUEST NOTES opens the quest notes; WORKSPACE NOTES without a file warns', async () => {
        const quest = resolve('tomAi.questNotes');
        await quest.send({ type: 'ready' });
        mdBrowserOpens.length = 0;
        await quest.send({ type: 'openInMdBrowser' });
        assert.deepEqual(mdBrowserOpens.map((o) => o.filePath), [QUEST_NOTES]);

        const ws = resolve('tomAi.workspaceNotes');
        mdBrowserOpens.length = 0;
        warnings.length = 0;
        await ws.send({ type: 'openInMdBrowser' });
        await ws.send({ type: 'openInMdViewer' });
        assert.equal(mdBrowserOpens.length, 0);
        assert.deepEqual(warnings, ['No notes file configured', 'No notes file configured']);
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
});
