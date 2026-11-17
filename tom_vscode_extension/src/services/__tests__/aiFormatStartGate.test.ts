/**
 * Emergency mode for a workspace not in this build's `_ai` format (services/aiFormatCheckService.ts
 * `aiFormatStartGate`, handlers/minimalMode-handler.ts, media/minimalMode; vscimpb142a), under the vscode stub.
 *
 *   AG-1 the workspace needs the migration: Tom AI does not start (the gate answers true); every webview view
 *        of package.json gets the placeholder with the hint "This workspace is in _ai format version X; this Tom
 *        AI build needs version Y. Tom AI does not start until the workspace is upgraded." and Upgrade the
 *        workspace…, which runs the migration command; the page opens by itself; a warning offers it
 *   AG-2 Migrate now in emergency mode: the page asks for a reload (restartRequired); the watcher then turns
 *        every placeholder into "Reload the window to start Tom AI"; the next start is normal (the gate
 *        answers false)
 *   AG-3 files NEWER than the build: the hint names the version to install, no migration button, no page
 *   AG-4 only this machine's own files behind and nothing to migrate: the local stamp is written quietly and
 *        the window starts normally; no `_ai` folder: normal
 *   AG-5 the placeholder page (JSDOM): format mode shows the hint and the buttons the hint asks for; a
 *        `content` message replaces it; setup mode as before
 */

import test, { describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub, stubFileWatchers } from '../../tools/__tests__/_vscode-stub.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-format-gate-')));
const WS = path.join(SANDBOX, 'ws');
const AI = path.join(WS, '_ai');
fs.mkdirSync(path.join(AI, 'quests', 'q1'), { recursive: true });
const EXT = path.resolve(__dirname, '..', '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));

const warnings: Array<{ message: string; buttons: unknown[] }> = [];
const stubbed = installVscodeStub({
    workspaceFolders: [WS],
    methodOverrides: {
        showWarningMessage: (message: unknown, ...buttons: unknown[]) => { warnings.push({ message: String(message), buttons }); return Promise.resolve(undefined); },
        showInformationMessage: (message: unknown, ...buttons: unknown[]) => { warnings.push({ message: String(message), buttons }); return Promise.resolve(undefined); },
    },
});
const stubWindow = stubbed.stub.window as Record<string, unknown>;
let providers = new Map<string, { resolveWebviewView(view: unknown): void }>();
stubWindow.registerWebviewViewProvider = (id: string, provider: { resolveWebviewView(view: unknown): void }) => { providers.set(id, provider); return { dispose: () => undefined }; };
let commands = new Map<string, () => unknown>();
(stubbed.stub.commands as Record<string, unknown>).registerCommand = (id: string, fn: () => unknown) => { commands.set(id, fn); return { dispose: () => undefined }; };

import { aiFormatStartGate } from '../aiFormatCheckService.js';
import { readLocalStamp } from '../../utils/aiFormatMigrationRun.js';
import { AI_FORMAT_VERSION, writeAiFormatStamp } from '../../utils/aiFormatVersion.js';
import { hostSlugOf } from '../../utils/hostSlug.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

setExtensionPath(EXT);

after(() => { stubbed.restore(); fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
function context(): Json {
    return { extensionUri: { fsPath: EXT, scheme: 'file' }, extensionPath: EXT, extension: { packageJSON: PKG }, subscriptions: [] };
}
function reset(): void {
    providers = new Map();
    commands = new Map();
    warnings.length = 0;
}
/** Resolve a placeholder view; answers its webview (html, posted messages, the message handlers). */
function resolve(id: string): { html: () => string; posted: Json[]; send: (m: Json) => Promise<unknown> } {
    const handlers: Array<(m: Json) => unknown> = [];
    const posted: Json[] = [];
    const webview: Json = {
        options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (fn: (m: Json) => unknown) => { handlers.push(fn); return { dispose: () => undefined }; },
        postMessage: async (m: Json) => { posted.push(m); return true; },
    };
    providers.get(id)!.resolveWebviewView({ webview, onDidDispose: () => ({ dispose: () => undefined }) });
    return { html: () => webview.html, posted, send: async (m) => { for (const h of handlers) { await h(m); } } };
}
function initOf(html: string): Json {
    const m = /<script nonce="[^"]*">window\.__INIT__ = ([\s\S]*?);<\/script>/.exec(html);
    assert.ok(m, 'the placeholder carries its first-paint data');
    return JSON.parse(m[1]);
}
const webviewViewIds = (): string[] => Object.values(PKG.contributes.views as Record<string, Json[]>).flat().filter((v) => v.type === 'webview').map((v) => v.id);
const panels = (): Json[] => (stubWindow.__webviewPanels as Json[]).filter((p) => p.viewType === 'tomAi.aiFormatMigration');

describe('emergency mode: the _ai files not in this build\'s format', () => {
    test('AG-1: the workspace needs the migration', async () => {
        reset();
        writeAiFormatStamp(AI, { version: AI_FORMAT_VERSION - 1, date: '2026-11-01' });
        assert.equal(aiFormatStartGate(context()), true, 'Tom AI does not start');
        assert.deepEqual([...providers.keys()].sort(), webviewViewIds().sort(), 'every webview view gets the placeholder');
        assert.ok(providers.size >= 19);
        const view = resolve('tomAi.questTodos');
        const init = initOf(view.html());
        assert.equal(init.mode, 'format');
        assert.equal(init.hint.text, `This workspace is in _ai format version ${AI_FORMAT_VERSION - 1}; this Tom AI build needs version ${AI_FORMAT_VERSION}. Tom AI does not start until the workspace is upgraded.`);
        assert.deepEqual([init.hint.upgradeButton, init.hint.reloadButton], [true, false]);
        assert.deepEqual([...commands.keys()], ['tomAi.migrateAiFormats'], 'only the migration command');
        assert.equal(panels().length, 1, 'the page opened by itself');
        assert.match(warnings[0].message, /^Tom AI does not start: This workspace is in _ai format version/);
        assert.deepEqual(warnings[0].buttons, ['Upgrade the workspace…']);
        const before = stubbed.spies.byMethod('commands.executeCommand').length;
        await view.send({ type: 'tomGate.upgradeWorkspace' });
        const runs = stubbed.spies.byMethod('commands.executeCommand').slice(before).map((c) => c.args[0]);
        assert.deepEqual(runs, ['tomAi.migrateAiFormats'], 'the button opens the page');
    });

    test('AG-2: Migrate now in emergency mode, then a normal start', async () => {
        const page = panels()[0];
        const view = resolve('tomAi.chatPanel');
        page.webview.__receive({ type: 'apply' });
        await new Promise((r) => setTimeout(r, 50));
        const done = page.webview.__posted.find((m: Json) => m.type === 'state' && m.state.phase === 'done');
        assert.ok(done, JSON.stringify(page.webview.__posted));
        assert.equal(done.state.restartRequired, true, 'the page asks for a reload');
        assert.equal(readLocalStamp(AI, hostSlugOf())?.version, AI_FORMAT_VERSION);
        const watcher = stubFileWatchers().at(-1)!;
        watcher.fireChange();
        const content = view.posted.find((m) => m.type === 'content');
        assert.equal(content?.content.hint.kind, 'migrated');
        assert.equal(content?.content.hint.text, `The workspace has been migrated to _ai format version ${AI_FORMAT_VERSION}. Reload the window to start Tom AI.`);
        assert.deepEqual([content?.content.hint.upgradeButton, content?.content.hint.reloadButton], [false, true]);
        await view.send({ type: 'tomGate.reload' });
        assert.equal(stubbed.spies.byMethod('commands.executeCommand').at(-1)?.args[0], 'workbench.action.reloadWindow');
        reset();
        assert.equal(aiFormatStartGate(context()), false, 'after the reload: a normal start');
        assert.equal(providers.size, 0);
    });

    test('AG-3: files newer than the build', () => {
        reset();
        writeAiFormatStamp(AI, { version: AI_FORMAT_VERSION + 1, date: '2026-12-01' });
        const pagesBefore = panels().length;
        assert.equal(aiFormatStartGate(context()), true);
        const init = initOf(resolve('tomAi.wsPanel').html());
        assert.equal(init.hint.kind, 'newer');
        assert.match(init.hint.text, new RegExp(`format version ${AI_FORMAT_VERSION + 1}; this Tom AI build understands version ${AI_FORMAT_VERSION} only\\. Install a Tom AI build that knows format version ${AI_FORMAT_VERSION + 1}`));
        assert.deepEqual([init.hint.upgradeButton, init.hint.reloadButton], [false, true], 'no migration button');
        assert.equal(panels().length, pagesBefore, 'no migration page');
        assert.deepEqual(warnings[0].buttons, ['Reload window']);
    });

    test('AG-4: only this machine\'s files behind, nothing to do; no _ai folder', () => {
        reset();
        writeAiFormatStamp(AI, { version: AI_FORMAT_VERSION, date: '2026-11-17' });
        fs.rmSync(path.join(AI, 'local'), { recursive: true, force: true });
        assert.equal(aiFormatStartGate(context()), false, 'a normal start');
        assert.equal(readLocalStamp(AI, hostSlugOf())?.version, AI_FORMAT_VERSION, 'the local stamp written quietly');
        assert.equal(providers.size, 0);
        assert.equal(warnings.length, 0);
        fs.renameSync(AI, `${AI}.gone`);
        try {
            assert.equal(aiFormatStartGate(context()), false, 'no _ai: a normal start');
        } finally { fs.renameSync(`${AI}.gone`, AI); }
    });

    test('AG-5: the placeholder page', () => {
        const html = fs.readFileSync(path.join(EXT, 'media', 'minimalMode', 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(m) });
        w.__INIT__ = { mode: 'format', hint: { kind: 'migrate', title: 'Upgrade the workspace', text: 'This workspace is in _ai format version 8.', upgradeButton: true, reloadButton: false } };
        w.eval(fs.readFileSync(path.join(EXT, 'media', 'minimalMode', 'main.js'), 'utf8'));
        const $ = (id: string): Json => w.document.getElementById(id);
        assert.deepEqual([$('setupMode').hidden, $('formatMode').hidden], [true, false]);
        assert.equal($('formatTitle').textContent, 'Upgrade the workspace');
        assert.equal($('formatText').textContent, 'This workspace is in _ai format version 8.');
        assert.deepEqual([$('upgradeBtn').hidden, $('reloadBtn').hidden], [false, true]);
        assert.equal($('upgradeBtn').textContent, 'Upgrade the workspace…');
        $('upgradeBtn').click();
        assert.equal(JSON.stringify(posted), '[{"type":"tomGate.upgradeWorkspace"}]');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'content', content: { mode: 'format', hint: { kind: 'migrated', title: 'The workspace is upgraded', text: 'Reload the window to start Tom AI.', upgradeButton: false, reloadButton: true } } } }));
        assert.deepEqual([$('upgradeBtn').hidden, $('reloadBtn').hidden], [true, false]);
        $('reloadBtn').click();
        assert.equal(posted.at(-1).type, 'tomGate.reload');
        w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'content', content: { mode: 'setup' } } }));
        assert.deepEqual([$('setupMode').hidden, $('formatMode').hidden], [false, true]);
        w.close();
    });
});
