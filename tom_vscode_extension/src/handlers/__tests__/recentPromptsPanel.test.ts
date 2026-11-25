/**
 * The Recent Prompts panel's host (src/handlers/recentPromptsPanel-handler.ts) and the Prompt Queue editor's button
 * that opens it, in a sandbox workspace under the vscode stub, with the real queue manager.
 *
 *   RPH-1 the queue editor's context bar has the Recent Prompts button; a click posts `openRecentPrompts`
 *   RPH-2 the queue editor host opens the panel on `openRecentPrompts` (one panel: a second open brings it to the
 *         front); its first state lists the queue's chat sends; the command `tomAi.editor.recentPrompts` opens it too
 *   RPH-3 a change of the queue posts the state again; `renderMarkdown` answers `markdownHtml` with safe HTML
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_251125_01_aifmt-4_recentprompts-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
// The sandbox is its own root: it lies under the real workspace's ztmp/, whose root marker the layout would find.
put('.tom/tom_root.yaml', 'version: 1\n');
put('.tom/tom_vscode_extension.json', '{}\n');
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = vscodeStub.stub.window as Record<string, unknown>;
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };
stubWindow.registerWebviewPanelSerializer = () => ({ dispose: () => undefined });
const commands = new Map<string, (...args: unknown[]) => unknown>();
(vscodeStub.stub.commands as Record<string, unknown>).registerCommand = (id: string, fn: (...args: unknown[]) => unknown) => { commands.set(id, fn); return { dispose: () => undefined }; };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerQueueEditorCommand } from '../queueEditor-handler.js';
import { RECENT_PROMPTS_COMMAND, RECENT_PROMPTS_VIEW_TYPE, registerRecentPromptsPanel } from '../recentPromptsPanel-handler.js';

const subscriptions: Array<{ dispose(): void }> = [];
const storage = path.join(SANDBOX, 'storage');
fs.mkdirSync(storage, { recursive: true });
const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
};
const context = {
    subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
    globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' },
    logUri: { fsPath: storage, scheme: 'file' }, globalStoragePath: storage, storagePath: storage, logPath: storage,
    globalState: memento(), workspaceState: memento(), asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
} as never;

after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const panels = (viewType: string): Json[] => (stubWindow.__webviewPanels as Json[]).filter((p) => p.viewType === viewType);
const states = (panel: Json): Json[] => (panel.webview.__posted as Json[]).filter((m) => m && m.type === 'state');

describe('the Recent Prompts panel', () => {
    test('RPH-1: the queue editor\'s button posts openRecentPrompts', (t) => {
        const html = fs.readFileSync(path.join(EXT_ROOT, 'media', 'queueEditor', 'index.html'), 'utf-8').replace(/<script[\s\S]*?<\/script>/g, '');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const window = dom.window as Json;
        t.after(() => window.close());
        const posted: Json[] = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push({ ...m }), setState: () => undefined, getState: () => undefined });
        window.__INIT__ = { state: { items: [], autoSend: false } };
        const media = (...p: string[]): string => fs.readFileSync(path.join(EXT_ROOT, 'media', ...p), 'utf-8');
        window.eval([media('shared', 'queueEntryUtils.js'), media('shared', 'queueEntryRenderFunctions.js'), media('shared', 'queueEntryMessageHandlers.js'), media('queueEditor', 'main.js')].join('\n;\n'));
        const button = window.document.getElementById('recentPromptsBtn');
        assert.ok(button, 'the button');
        assert.ok(button.closest('.context-bar').querySelector('[title="Queue Templates"]'), 'beside the other top icon buttons');
        assert.ok(button.querySelector('.codicon-history'));
        posted.length = 0;
        // jsdom runs no inline handlers here: run the button's onclick as the browser would.
        assert.equal(button.getAttribute('onclick'), 'openRecentPrompts()');
        window.eval(button.getAttribute('onclick'));
        assert.deepEqual(posted, [{ type: 'openRecentPrompts' }]);
    });

    test('RPH-2 / RPH-3: the host opens the panel, lists the chat sends, follows the queue', async () => {
        setExtensionPath(EXT_ROOT);
        TomAiConfiguration.init(context);
        ChatVariablesStore.init(context);
        ProcessStateStore.init(context);
        TimerEngine.init(context);
        PromptQueueManager.init(context);
        registerQueueEditorCommand(context);
        registerRecentPromptsPanel(context);
        const qm = PromptQueueManager.instance;
        const chat = qm.addChatItem({ text: 'What changed?\nDetails', session: 'default', source: 'panel' });
        qm.completeChatItem(chat, { answerText: 'Nothing much.' });

        // The queue editor, and its button's message.
        await commands.get('tomAi.editor.promptQueue')!();
        const queuePanel = panels('tomAi.queueEditor')[0];
        assert.ok(queuePanel, 'the queue editor is open');
        assert.equal(panels(RECENT_PROMPTS_VIEW_TYPE).length, 0);
        queuePanel.webview.__receive({ type: 'openRecentPrompts' });
        await wait(20);
        const [panel] = panels(RECENT_PROMPTS_VIEW_TYPE);
        assert.ok(panel, 'the host opened the Recent Prompts panel');
        assert.equal(panel.title, 'Recent Prompts');
        assert.match(panel.webview.html, /recentPromptsPanel/);
        assert.match(panel.webview.html, /mdOverlay\.js/);
        // Its first state (in __INIT__ and posted once the queue is ready) lists the chat send.
        await wait(50);
        const first = states(panel).pop();
        assert.ok(first, 'a state was posted');
        assert.deepEqual(first.rows.map((r: Json) => [r.id, r.kind, r.firstLine, r.promptCount, r.lastAnswerStart]), [[chat, 'chat', 'What changed?', 1, 'Nothing much.']]);
        // A second open — the command or the button — brings the same panel to the front.
        await commands.get(RECENT_PROMPTS_COMMAND)!();
        queuePanel.webview.__receive({ type: 'openRecentPrompts' });
        await wait(20);
        assert.equal(panels(RECENT_PROMPTS_VIEW_TYPE).length, 1);

        // RPH-3: a change of the queue posts the state again.
        const before = states(panel).length;
        const second = qm.addChatItem({ text: 'And now?', session: 'default', source: 'editor' });
        qm.completeChatItem(second, { answerText: 'Now this.' });
        await wait(500);
        assert.ok(states(panel).length > before, 'posted again');
        const latest = states(panel).pop();
        assert.deepEqual(latest.rows.map((r: Json) => r.firstLine).sort(), ['And now?', 'What changed?']);
        assert.equal(latest.promptCount, 2);
        // Markdown: the host renders it safely.
        panel.webview.__receive({ type: 'renderMarkdown', title: 'Chat send', markdown: '## Prompt\n\nSome **bold** text\n\n<script>x</script>' });
        const md = (panel.webview.__posted as Json[]).filter((m) => m?.type === 'markdownHtml').pop();
        assert.equal(md.title, 'Chat send');
        assert.match(md.html, /<strong>bold<\/strong>/);
        assert.doesNotMatch(md.html, /<script>/);
        panel.dispose();
        queuePanel.dispose();
    });
});
