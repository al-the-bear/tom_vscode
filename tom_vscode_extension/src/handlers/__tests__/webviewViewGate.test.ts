/**
 * A window whose workspace another window migrated (vscimpb142d): every panel shows only that the window needs
 * a reload, and new chat sends are refused (handlers/webviewViewGate.ts, sendToChatState.ts `refuseChatSends`,
 * services/aiFormatCheckService.ts `enterReloadRequiredMode`, media/minimalMode).
 *
 *   RG-1 the gate: a view resolved before shows its own provider's page; closed, every view (shown and resolved
 *        later, the later ones without their provider) shows the reload placeholder; a provider writing its
 *        page again is overwritten when the view becomes visible; Show running prompts / Reload window
 *   RG-2 the refusals: the chat sends of the editor commands (Send to LLM), scripts (Anthropic and Copilot),
 *        Send to Copilot, the todo panel and Telegram answer the sentence; nothing is sent
 *   RG-3 the placeholder page: the reload hint with Reload window and Show running prompts, no Upgrade button
 *   RG-4 the wiring: every webview view of the extension is registered behind the gate; another window's
 *        migration enters the mode; the user guide says so
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const warnings: string[] = [];
const stubbed = installVscodeStub({
    workspaceFolders: [os.tmpdir()],
    methodOverrides: { showWarningMessage: (m: unknown) => { warnings.push(String(m)); return Promise.resolve(undefined); } },
});
const providers = new Map<string, { resolveWebviewView(view: unknown, ctx?: unknown, token?: unknown): unknown }>();
(stubbed.stub.window as Record<string, unknown>).registerWebviewViewProvider = (id: string, p: { resolveWebviewView(view: unknown): unknown }) => { providers.set(id, p); return { dispose: () => undefined }; };

import { closeWebviewViews, gatedViews, isWebviewGateClosed, registerGatedWebviewViewProvider, resetWebviewGateForTests } from '../webviewViewGate.js';
import { chatSendRefusal, refuseChatSends } from '../sendToChatState.js';
import { dispatchToLlm, openCopilotChat, runAnthropicSend, sendToChatForScript } from '../sendToChatRouter.js';
import { formatReloadHint, reloadRequiredSentence } from '../../utils/aiFormatMigrationRun.js';
import { setExtensionPath } from '../handler_shared.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
setExtensionPath(EXT);
after(() => { refuseChatSends(undefined); resetWebviewGateForTests(); stubbed.restore(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function fakeView(): { view: Json; handlers: Array<(m: Json) => unknown>; becomeVisible: () => void } {
    const handlers: Array<(m: Json) => unknown> = [];
    let visibility: () => void = () => undefined;
    const view: Json = {
        visible: true,
        webview: {
            options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u,
            onDidReceiveMessage: (fn: (m: Json) => unknown) => { handlers.push(fn); return { dispose: () => undefined }; },
            postMessage: async () => true,
        },
        onDidDispose: () => ({ dispose: () => undefined }),
        onDidChangeVisibility: (fn: () => void) => { visibility = fn; return { dispose: () => undefined }; },
    };
    return { view, handlers, becomeVisible: () => visibility() };
}
const initOf = (html: string): Json => JSON.parse(/<script nonce="[^"]*">window\.__INIT__ = ([\s\S]*?);<\/script>/.exec(html)![1]);
const context = (): Json => ({ extensionUri: { fsPath: EXT, scheme: 'file', path: EXT }, extensionPath: EXT, subscriptions: [], workspaceState: { get: () => '', update: async () => undefined } });

describe('a window migrated under it', () => {
    test('RG-1: the gate', async () => {
        resetWebviewGateForTests();
        const resolved: string[] = [];
        const own = { resolveWebviewView(v: Json) { resolved.push('own'); v.webview.html = '<p>own page</p>'; } };
        registerGatedWebviewViewProvider('tomAi.chatPanel', own);
        registerGatedWebviewViewProvider('tomAi.wsPanel', own);
        const a = fakeView();
        providers.get('tomAi.chatPanel')!.resolveWebviewView(a.view);
        assert.equal(a.view.webview.html, '<p>own page</p>');
        assert.equal(isWebviewGateClosed(), false);
        const calls: string[] = [];
        closeWebviewViews(context().extensionUri, { mode: 'format', hint: formatReloadHint(9) }, { reload: () => calls.push('reload'), showOverlay: () => calls.push('overlay') });
        assert.equal(initOf(a.view.webview.html).hint.text, 'The workspace has been migrated to version 9; reload this window.');
        const b = fakeView();
        providers.get('tomAi.wsPanel')!.resolveWebviewView(b.view);
        assert.deepEqual(resolved, ['own'], 'a view resolved after closing never shows its provider');
        assert.equal(initOf(b.view.webview.html).hint.kind, 'reload');
        assert.equal(gatedViews().size, 2);
        a.view.webview.html = '<p>own page again</p>';
        a.becomeVisible();
        assert.equal(initOf(a.view.webview.html).hint.kind, 'reload', 'overwritten again');
        for (const h of a.handlers) { await h({ type: 'tomGate.showOverlay' }); await h({ type: 'tomGate.reload' }); await h({ type: 'reload' }); }
        assert.deepEqual(calls, ['overlay', 'reload'], 'only the namespaced messages');
        resetWebviewGateForTests();
    });

    test('RG-2: the refusals', async () => {
        const sentence = reloadRequiredSentence(9);
        refuseChatSends(sentence);
        assert.equal(chatSendRefusal(), sentence);
        const ctx = context();
        const out = await runAnthropicSend(ctx, 'hello', { source: 'todo panel: send' });
        assert.deepEqual(out, { target: 'anthropic', ok: false, refused: true, error: sentence });
        warnings.length = 0;
        await dispatchToLlm(ctx, 'hello');
        assert.deepEqual(warnings, [`Not sent: ${sentence}`]);
        assert.deepEqual(await sendToChatForScript(ctx, 'hi', 'copilot'), { target: 'copilot', ok: false, refused: true, error: sentence });
        const before = stubbed.spies.byMethod('commands.executeCommand').length;
        await openCopilotChat('hi');
        assert.equal(stubbed.spies.byMethod('commands.executeCommand').slice(before).filter((c) => c.args[0] === 'workbench.action.chat.open').length, 0);
        assert.equal(warnings.at(-1), `Not sent: ${sentence}`);
        const telegram = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'telegram-cmd-handlers.ts'), 'utf8');
        assert.match(telegram, /if \(outcome\.refused\) \{\s*return \{ text: `⛔ Not sent: \$\{outcome\.error/);
        const panel = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf8');
        assert.match(panel, /const refusal = chatSendRefusal\(\);\s*if \(refusal\) \{\s*this\._view\?\.webview\.postMessage\(\{ type: 'anthropicNotSent', message: `Not sent: \$\{refusal\}`/);
        refuseChatSends(undefined);
        assert.equal(chatSendRefusal(), undefined);
    });

    test('RG-3: the placeholder page', () => {
        const read = (f: string): string => fs.readFileSync(path.join(EXT, 'media', 'minimalMode', f), 'utf8');
        const w = new JSDOM(read('index.html').replace(/<script[^>]*><\/script>/g, ''), { runScripts: 'outside-only' }).window as Json;
        const posted: Json[] = [];
        w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => posted.push(m) });
        w.__INIT__ = { mode: 'format', hint: formatReloadHint(9) };
        w.eval(read('main.js'));
        const $ = (id: string): Json => w.document.getElementById(id);
        assert.deepEqual([$('setupMode').hidden, $('formatMode').hidden], [true, false]);
        assert.equal($('formatTitle').textContent, 'Reload this window');
        assert.equal($('formatText').textContent, 'The workspace has been migrated to version 9; reload this window.');
        assert.deepEqual([$('upgradeBtn').hidden, $('reloadBtn').hidden, $('overlayBtn').hidden], [true, false, false]);
        assert.equal($('overlayBtn').textContent, 'Show running prompts');
        $('overlayBtn').click();
        $('reloadBtn').click();
        assert.equal(JSON.stringify(posted), '[{"type":"tomGate.showOverlay"},{"type":"tomGate.reload"}]');
        w.close();
    });

    test('RG-4: the wiring', () => {
        const handlers = path.join(EXT, 'src', 'handlers');
        const direct = fs.readdirSync(handlers).filter((f) => f.endsWith('.ts'))
            .filter((f) => fs.readFileSync(path.join(handlers, f), 'utf8').includes('vscode.window.registerWebviewViewProvider('));
        assert.deepEqual(direct.sort(), ['minimalMode-handler.ts', 'webviewViewGate.ts'], 'every other view behind the gate');
        const gated = fs.readdirSync(handlers).filter((f) => f.endsWith('.ts') && fs.readFileSync(path.join(handlers, f), 'utf8').includes('registerGatedWebviewViewProvider('));
        assert.ok(gated.length >= 12, gated.join(', '));
        const service = fs.readFileSync(path.join(EXT, 'src', 'services', 'aiFormatCheckService.ts'), 'utf8');
        assert.match(service, /showReloadOverlay\(context, overlayDeps, now\);\s*\/\/[^\n]*\n\s*enterReloadRequiredMode\(context, now,/);
        assert.match(service, /refuseChatSends\(reloadRequiredSentence\(version\)\);\s*closeWebviewViews\(context\.extensionUri, \{ mode: 'format', hint: formatReloadHint\(version\) \}/);
        const guide = fs.readFileSync(path.join(EXT, 'doc', 'user_guide.md'), 'utf8');
        assert.match(guide, /every panel and view of that window shows only \*The workspace has been migrated to version X; reload this window\.\*/);
    });
});
