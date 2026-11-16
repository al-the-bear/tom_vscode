/**
 * Chat sends hold one busy slot per session (vscimpb135; handlers/sendToChatState.ts), through the real
 * runAnthropicSend under the vscode stub; only the Anthropic handler's sendMessage is replaced (it waits until the
 * test lets it answer, or until its cancellation token fires).
 *
 *   CS-1 a send in a free session goes while another session's chat send runs; a second send into a session whose
 *        send still runs is refused, naming that session (busySession); once it ended the session takes a send again
 *   CS-2 Telegram /cancel_chat cancels every running chat send and says how many and in which sessions; nothing
 *        running: it says so
 *   CS-3 the callers: the chat panel claims the slot of the session it sends in and its busy state follows its own
 *        send and its session; Telegram's cancelChat cancels all; the assist cancels its own send; scripts and the
 *        editor menus go through runAnthropicSend
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261116_vscimpb135_slots-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('.tom/tom_vscode_extension.json', JSON.stringify({ anthropic: {
    profiles: [{ id: 'p1', name: 'P1', description: '', systemPrompt: '', configurationId: 'c1', isDefault: true }],
    configurations: [{ id: 'c1', name: 'C1', model: 'claude-test', maxTokens: 1000, maxRounds: 2 }],
} }, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../handler_shared.js';
import { AnthropicHandler } from '../anthropic-handler.js';
import { runAnthropicSend } from '../sendToChatRouter.js';
import { anthropicSendSessions, cancelAnthropicSend, isAnthropicSendInFlight, __resetAnthropicSendsForTests } from '../sendToChatState.js';
import { cancelChatText } from '../telegram-cmd-handlers.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let context: Json;
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { if (v === undefined) { values.delete(k); } else { values.set(k, v); } }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    context = {
        subscriptions: [], extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file', path: EXT_ROOT },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    };
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
})();

/** The sends the replaced Anthropic handler holds, by session: answer one, or see it cancelled. */
const running = new Map<string, { answer: (text: string) => void; cancelled: () => boolean }>();
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
handler.sendMessage = (o: Json): Promise<Json> => new Promise((resolve, reject) => {
    let cancelled = false;
    o.cancellationToken?.onCancellationRequested?.(() => { cancelled = true; reject(new Error('cancelled')); });
    running.set(o.sessionKey, { answer: (text) => resolve({ text, turnsUsed: 1, toolCallCount: 0 }), cancelled: () => cancelled });
});
after(() => {
    handler.sendMessage = originalSend;
    __resetAnthropicSendsForTests();
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('chat sends: one busy slot per session', () => {
    test('CS-1: sessions side by side, the same session refused', async () => {
        const first = runAnthropicSend(context, 'in chat', { source: 'editor' });
        await tick();
        assert.ok(running.has('chat'), 'the first send runs in chat');
        assert.equal(isAnthropicSendInFlight('chat'), true);
        // Another session is free: it goes while the first runs.
        const second = runAnthropicSend(context, 'in work', { source: 'todo panel: send', session: 'work@r2', run: 'r2' });
        await tick();
        assert.ok(running.has('work@r2'), 'sent beside it');
        assert.deepEqual(anthropicSendSessions(), ['chat', 'work@r2']);
        // The same session again: refused, naming it (no person to ask on Telegram: the busy check refuses too).
        const refused = await runAnthropicSend(context, 'again in work', { source: 'script', session: 'work@r2' });
        assert.equal(refused.ok, false);
        assert.equal(refused.rejected, true);
        assert.equal(refused.busySession, 'work@r2');
        running.get('work@r2')!.answer('done in work');
        const secondOutcome = await second;
        assert.equal(secondOutcome.ok, true);
        assert.equal(secondOutcome.answer, 'done in work');
        assert.equal(isAnthropicSendInFlight('work@r2'), false, 'released');
        assert.equal(isAnthropicSendInFlight('chat'), true, 'the first runs on');
        running.get('chat')!.answer('done in chat');
        assert.equal((await first).answer, 'done in chat');
        assert.equal(isAnthropicSendInFlight(), false);
        running.clear();
        const again = runAnthropicSend(context, 'work again', { source: 'editor', session: 'work@r2' });
        await tick();
        assert.ok(running.has('work@r2'), 'free again');
        running.get('work@r2')!.answer('ok');
        assert.equal((await again).ok, true);
        running.clear();
    });

    test('CS-2: Telegram /cancel_chat stops every running chat send', async () => {
        assert.equal(cancelChatText(cancelAnthropicSend()), 'ℹ️ No direct chat prompt is currently running.');
        const a = runAnthropicSend(context, 'a', { source: 'editor' });
        const b = runAnthropicSend(context, 'b', { source: 'editor', session: 'work@r2' });
        await tick();
        const text = cancelChatText(cancelAnthropicSend());
        assert.equal(text, '🛑 Cancelled 2 running direct chat prompts (sessions chat, work@r2).');
        const [ra, rb] = await Promise.all([a, b]);
        assert.equal(ra.ok, false);
        assert.equal(rb.ok, false);
        assert.ok(running.get('chat')!.cancelled() && running.get('work@r2')!.cancelled());
        assert.equal(isAnthropicSendInFlight(), false);
        assert.equal(cancelChatText(['chat']), '🛑 Cancelled the running direct chat prompt (session chat).');
        running.clear();
    });

    test('CS-3: the callers', () => {
        const src = (rel: string): string => fs.readFileSync(path.join(EXT_ROOT, 'src', rel), 'utf-8');
        const panel = src('handlers/chatPanel-handler.ts');
        assert.match(panel, /tryBeginAnthropicSend\(slotKey\)/, 'the panel claims its session\'s slot');
        assert.match(panel, /const slotKey = fresh \? `\$\{targetSession\}~fresh-\$\{Date\.now\(\)\}` : targetSession;/);
        assert.match(panel, /private _panelBusy\(\): boolean \{\s*return this\._panelSendSlot !== undefined \|\| isAnthropicSendInFlight\(this\._panelSession\(\)\);/);
        assert.doesNotMatch(panel, /isAnthropicSendInFlight\(\)/, 'never "any send"');
        assert.equal((panel.match(/endAnthropicSend\(slotKey\)/g) ?? []).length, 3, 'every way out releases it');
        assert.match(src('handlers/telegram-commands.ts'), /cancelChat: \(\) => cancelAnthropicSend\(\),/);
        assert.match(src('services/assistLiveDeps.ts'), /cancelAnthropicSendOfChatItem\(chat\)/);
        const router = src('handlers/sendToChatRouter.ts');
        assert.match(router, /return runAnthropicSend\(context, prompt, \{ source: 'script' \}\);/, 'the scripting bridge');
        assert.doesNotMatch(src('handlers/busySessionChoice.ts'), /canSendElsewhere/);
        assert.doesNotMatch(src('handlers/questTodoPanel-handler.ts'), /Anthropic chat is busy/);
    });
});
