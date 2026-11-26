/**
 * The @CHAT Logs panel's session actions on the host (runChatSessionAction →
 * the chat panel's runSessionAction): each acts on the session selected in
 * the Logs panel, never on `default` or on a session picked again.
 *
 *   LA-1 trail summary: the selected session's view of this host's trail opens as a Markdown document, no session
 *        picker
 *   LA-2 memory: the memory panel opens (`tomAi.panel.memory`) on the quest's memory folder, which has no session
 *        level: no session is handed over
 *   LA-3 history opens the quest's history (`history/history.md`), the live trail the selected session's
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
// An untitled Markdown document (the session's trail view): recorded here, files go to the stub.
const untitled: string[] = [];
const fileDocument = stubWorkspace.openTextDocument as (arg: unknown) => Promise<unknown>;
stubWorkspace.openTextDocument = async (arg: unknown) => {
    if (arg && typeof arg === 'object' && typeof (arg as { content?: unknown }).content === 'string') {
        untitled.push((arg as { content: string }).content);
        return { uri: { fsPath: '', scheme: 'untitled' }, getText: () => (arg as { content: string }).content };
    }
    return fileDocument(arg);
};

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { appendHostTrailTurn } from '../../services/hostTrail.js';
import { hostSlugOf } from '../../utils/hostSlug.js';
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

describe('the @CHAT Logs session actions', () => {
    test('LA-1: the trail summary of the selected session', async () => {
        const questFolder = path.join(WS, '_ai', 'quests', QUEST);
        appendHostTrailTurn(questFolder, { id: 'r1', time: '2026-11-25T10:00:00.000Z', host: hostSlugOf(), session: SESSION, profile: 'p', model: 'm', prompt: 'the prompt', answer: 'the answer' }, 2000);
        appendHostTrailTurn(questFolder, { id: 'r2', time: '2026-11-25T11:00:00.000Z', host: hostSlugOf(), session: 'other', profile: 'p', model: 'm', prompt: 'other prompt', answer: 'other answer' }, 2000);
        await runChatSessionAction('trailSummary', SESSION);
        assert.equal(pickerShown, 0, 'no session picker');
        assert.equal(untitled.length, 1, 'the session\'s trail view opened');
        assert.match(untitled[0], /# Trail of session op5[\s\S]*the prompt[\s\S]*the answer/);
        assert.doesNotMatch(untitled[0], /other prompt/, 'only the selected session\'s turns');
    });

    test('LA-2: the memory panel, without a session', async () => {
        const before = commands().length;
        await runChatSessionAction('memory', SESSION);
        assert.deepEqual(since(before).find((a) => a[0] === 'tomAi.panel.memory'), ['tomAi.panel.memory']);
        // The command takes no session: the panel shows the quest's memory folder.
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'memoryPanel-handler.ts'), 'utf8');
        assert.match(src, /registerCommand\('tomAi\.panel\.memory', \(\) => \{\n\s+openMemoryPanel\(context\);/);
        assert.match(src, /export function openMemoryPanel\(context: vscode\.ExtensionContext\): void \{\n\s+_context = context;\n/);
    });

    test('LA-3: history and live trail of the selected session', async () => {
        const historyDir = path.join(WS, '_ai', 'quests', QUEST, 'history');
        const sessionDir = path.join(historyDir, hostSlugOf(), 'sessions', SESSION);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(historyDir, 'history.md'), '# history\n');
        fs.writeFileSync(path.join(sessionDir, 'live-trail.md'), '# live\n');
        const before = commands().length;
        await runChatSessionAction('history', SESSION);
        await runChatSessionAction('liveTrail', SESSION);
        const touched = [
            ...since(before).flatMap((a) => a.slice(1)),
            ...stubbed.spies.byMethod('window.showTextDocument').map((c) => c.args[0]),
            ...stubbed.spies.byMethod('workspace.openTextDocument').map((c) => c.args[0]),
        ].map((x) => (typeof x === 'string' ? x : (x as { fsPath?: string; uri?: { fsPath?: string } })?.fsPath ?? (x as { uri?: { fsPath?: string } })?.uri?.fsPath ?? '')).filter(Boolean);
        assert.ok(touched.some((f) => f === path.join(historyDir, 'history.md')), `the quest's history.md opened: ${touched.join(', ')}`);
        assert.ok(touched.some((f) => f === path.join(sessionDir, 'live-trail.md')), `live-trail.md of ${SESSION} opened: ${touched.join(', ')}`);
    });
    test('LA-4: the provider is disposed with the extension', () => {
        assert.ok(subscriptions.some((d) => d && (d as { constructor?: { name?: string } }).constructor?.name === 'ChatPanelViewProvider'), 'the provider itself is a subscription');
    });
});
