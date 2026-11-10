/**
 * The @CHAT Logs panel's session actions on the host (runChatSessionAction →
 * the chat panel's runSessionAction): each acts on the session selected in
 * the Logs panel, never on `default` or on a session picked again.
 *
 *   LA-1 trail summary: the selected session's summary trail opens in the trail viewer, no session picker
 *   LA-2 memory: the memory panel opens on the selected session (`tomAi.panel.memory <session>`), and the
 *        command hands that session to the panel
 *   LA-3 history and live trail open the selected session's files
 *   LA-4 the chat panel provider is in the context's subscriptions, so its dispose (the answer-folder watcher, the
 *        answer poll timer) runs on deactivate — this test process ends only because it does
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'logs-session-actions-')));
const WS = path.join(SANDBOX, 'ws');
const QUEST = 'q1';
const SESSION = 'op5';
fs.mkdirSync(path.join(WS, '_ai', 'quests', QUEST), { recursive: true });
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}');

let pickerShown = 0;
const stubbed = installVscodeStub({ workspaceFolders: [WS] });
const stubWindow = stubbed.stub.window as Record<string, unknown>;
const stubWorkspace = stubbed.stub.workspace as Record<string, unknown>;
stubWorkspace.workspaceFile = { fsPath: path.join(WS, '_ai', 'quests', QUEST, `${QUEST}.code-workspace`), scheme: 'file' };
stubWindow.showQuickPick = async () => { pickerShown++; return undefined; };
stubWindow.registerWebviewViewProvider = () => ({ dispose: () => undefined });

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerChatPanel, runChatSessionAction } from '../chatPanel-handler.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
setExtensionPath(EXT);
TomAiConfiguration.init({} as never);
TrailService.init({} as never);
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const memento = (): unknown => {
    const values = new Map<string, unknown>();
    return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()] };
};
const subscriptions: Array<{ dispose?: () => unknown }> = [];
after(() => { for (const d of subscriptions) { try { d.dispose?.(); } catch { /* best effort */ } } });
registerChatPanel({
    subscriptions, extensionPath: EXT, extensionUri: { fsPath: EXT, scheme: 'file' },
    workspaceState: memento(), globalState: memento(), globalStorageUri: { fsPath: path.join(SANDBOX, 'storage') },
} as never);

const commands = (): unknown[][] => stubbed.spies.byMethod('commands.executeCommand').map((c) => c.args);
const since = (n: number): unknown[][] => commands().slice(n);
const fsPathOf = (u: unknown): string => (u as { fsPath: string }).fsPath;

describe('the @CHAT Logs session actions', () => {
    test('LA-1: the trail summary of the selected session', async () => {
        const summary = TrailService.instance.getSummaryFilePath('prompts', { type: 'anthropic', session: SESSION }, QUEST);
        assert.ok(summary, 'a summary path for the session');
        fs.mkdirSync(path.dirname(summary!), { recursive: true });
        fs.writeFileSync(summary!, '# prompts\n');
        const before = commands().length;
        await runChatSessionAction('trailSummary', SESSION);
        assert.equal(pickerShown, 0, 'no session picker');
        const opened = since(before).find((a) => a[0] === 'vscode.openWith');
        assert.ok(opened, 'the trail viewer opened');
        assert.equal(fsPathOf(opened![1]), summary);
        assert.ok(summary!.includes(path.join('sessions', SESSION)), 'the session\'s own trail pair');
    });

    test('LA-2: the memory panel on the selected session', async () => {
        const before = commands().length;
        await runChatSessionAction('memory', SESSION);
        assert.deepEqual(since(before).find((a) => a[0] === 'tomAi.panel.memory'), ['tomAi.panel.memory', SESSION]);
        // The command hands the session to the panel.
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'memoryPanel-handler.ts'), 'utf8');
        assert.match(src, /registerCommand\('tomAi\.panel\.memory', \(session\?: unknown\) => \{\n\s+openMemoryPanel\(context, typeof session === 'string' && session \? session : undefined\);/);
        assert.match(src, /export function openMemoryPanel\(context: vscode\.ExtensionContext, session\?: string\): void \{\n\s+_context = context;\n\s+if \(session\) \{ _session = session; \}/);
    });

    test('LA-3: history and live trail of the selected session', async () => {
        const sessionDir = path.join(WS, '_ai', 'quests', QUEST, 'history', 'sessions', SESSION);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'history.md'), '# history\n');
        fs.writeFileSync(path.join(sessionDir, 'live-trail.md'), '# live\n');
        const before = commands().length;
        await runChatSessionAction('history', SESSION);
        await runChatSessionAction('liveTrail', SESSION);
        const touched = [
            ...since(before).flatMap((a) => a.slice(1)),
            ...stubbed.spies.byMethod('window.showTextDocument').map((c) => c.args[0]),
            ...stubbed.spies.byMethod('workspace.openTextDocument').map((c) => c.args[0]),
        ].map((x) => (typeof x === 'string' ? x : (x as { fsPath?: string; uri?: { fsPath?: string } })?.fsPath ?? (x as { uri?: { fsPath?: string } })?.uri?.fsPath ?? '')).filter(Boolean);
        assert.ok(touched.some((f) => f === path.join(sessionDir, 'history.md')), `history.md of ${SESSION} opened: ${touched.join(', ')}`);
        assert.ok(touched.some((f) => f === path.join(sessionDir, 'live-trail.md')), `live-trail.md of ${SESSION} opened: ${touched.join(', ')}`);
    });
    test('LA-4: the provider is disposed with the extension', () => {
        assert.ok(subscriptions.some((d) => d && (d as { constructor?: { name?: string } }).constructor?.name === 'ChatPanelViewProvider'), 'the provider itself is a subscription');
    });
});
