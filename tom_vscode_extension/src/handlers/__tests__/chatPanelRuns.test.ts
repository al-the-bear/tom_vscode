/**
 * The @CHAT subpanels' run pickers (vscimpb48, src/utils/chatPanelRuns.ts, chatPanel-handler.ts) through the real
 * chat panel provider, process store, chat variables and queue under the vscode stub.
 *
 *   CR-1 the rules: a picked run while the quest has it, else `default`; the session in a run (`<session>@<run>`,
 *        the shared ones unchanged); a run context only when the panel's run is not the window's; the picker's
 *        options (`default` first, then by name, the PROCESS view's run marked)
 *   CR-2 the picker: the panel tells the webview the runs and each subpanel's run; a pick is kept per subpanel
 *        (the other one stays), per window and quest; the ANTHROPIC/LLM subpanel then shows the run's session
 *   CR-3 a send into a non-default run while the window works on `default`: it runs in the run's session, with
 *        the run's chat variables and the run's process position (variables, run); the window's own stay
 *   CR-4 Save to Queue carries the subpanel's run (its session becomes the run's); a Copilot subpanel's queue add
 *        carries the Copilot subpanel's run
 *   CR-5 the fallback: a run deleted elsewhere is `default` again for the subpanel that was on it, the pick
 *        forgotten, and the webview is told
 *   CR-6 the webview: each subpanel has a run select; `chatRuns` fills both (the run each is on selected; one not
 *        on the PROCESS view's run marked); a change posts `setChatRun` with its subpanel
 */

/* eslint-disable @typescript-eslint/naming-convention -- chat-variable names */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261111_vscimpb48_chatruns-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
function put(rel: string, text: string): void {
    const abs = path.join(WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
put(`_ai/quests/${QUEST}/overview.${QUEST}.md`, '# Q1\n');
put('_ai/processes/change/change.process.yaml', ['id: change', 'name: Change', 'phases:', '  - id: p1', '    steps:', '      - id: plan', '      - id: build', '    gate:', '      id: g1', ''].join('\n'));
put('_ai/processes/change/change.md', '# change\n');
put('.tom/tom_vscode_extension.json', '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ProcessStateStore } from '../../managers/processStateStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager } from '../../managers/promptQueueManager.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { TrailService } from '../../services/trailService.js';
import { setExtensionPath } from '../handler_shared.js';
import { registerChatPanel } from '../chatPanel-handler.js';
import { setChatSessionFor } from '../sessionPicker.js';
import { AnthropicHandler } from '../anthropic-handler.js';
import { chatRunOptions, chatRunSession, effectiveChatRun, needsRunContext } from '../../utils/chatPanelRuns.js';
import { DEFAULT_RUN } from '../../utils/processRuns.js';

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
ReminderSystem.init(context);
TimerEngine.init(context);
PromptQueueManager.init(context);
registerChatPanel(context);
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose?.(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const provider = (): Json => subscriptions.find((d) => d && (d as { constructor?: { name?: string } }).constructor?.name === 'ChatPanelViewProvider');
const posted: Json[] = [];
/** A webview the provider posts to. */
function attachView(): void {
    const view = { webview: { postMessage: async (m: Json) => { posted.push(JSON.parse(JSON.stringify(m))); return true; } }, onDidDispose: () => ({ dispose: () => undefined }) };
    provider()._view = view;
    provider()._watchRuns(view);
}
const lastPosted = (type: string): Json => posted.filter((m) => m.type === type).at(-1);
const store = (): ProcessStateStore => ProcessStateStore.instance!;
const queue = (): PromptQueueManager => PromptQueueManager.instance;

describe('the chat panels\' run pickers', () => {
    test('CR-1: the rules', () => {
        assert.equal(effectiveChatRun('chg1', ['default', 'chg1']), 'chg1');
        assert.equal(effectiveChatRun('gone', ['default', 'chg1']), DEFAULT_RUN);
        assert.equal(effectiveChatRun(undefined, ['default']), DEFAULT_RUN);
        assert.equal(chatRunSession('work', 'chg1'), 'work@chg1');
        assert.equal(chatRunSession('chat', 'chg1'), 'chat', 'the panel\'s shared session stays');
        assert.equal(chatRunSession('work', DEFAULT_RUN), 'work');
        assert.equal(needsRunContext('chg1', 'default'), true);
        assert.equal(needsRunContext('default', 'default'), false);
        assert.deepEqual(chatRunOptions(['zeta', 'default', 'alpha'], 'zeta'), [
            { run: 'default', label: 'default' }, { run: 'alpha', label: 'alpha' }, { run: 'zeta', label: 'zeta (PROCESS view)' },
        ]);
    });

    test('CR-2: the picker', async () => {
        await ProcessStateStore.ready;
        queue().autoSendEnabled = false;
        assert.equal(store().createRun('chg1', 'change', 'user', false).ok, true);
        assert.equal(store().createRun('chg2', 'change', 'user', false).ok, true);
        assert.equal(store().currentRun, DEFAULT_RUN, 'the window works on default');
        attachView();
        await new Promise((r) => setTimeout(r, 20));
        provider()._sendChatRuns();
        assert.deepEqual(lastPosted('chatRuns').options.map((o: Json) => o.run), ['default', 'chg1', 'chg2']);
        assert.deepEqual(lastPosted('chatRuns').selected, { anthropic: 'default', copilot: 'default' });
        // The ANTHROPIC/LLM subpanel picks chg1; the Copilot one stays.
        await provider()._setChatRun('anthropic', 'chg1');
        provider()._sendChatRuns();
        assert.deepEqual(lastPosted('chatRuns').selected, { anthropic: 'chg1', copilot: 'default' });
        // Its session: the run's (a named session — `chat` is shared and stays as it is).
        await setChatSessionFor((context as Json).workspaceState, QUEST, 'work');
        const sessionKey = provider()._chatSessionKey();
        assert.equal(provider()._panelSession(), chatRunSession(sessionKey, 'chg1'));
        provider()._sendChatSession();
        assert.equal(lastPosted('anthropicSession').name, chatRunSession(sessionKey, 'chg1'));
        // A run the quest does not have is not taken.
        await provider()._setChatRun('copilot', 'nope');
        assert.equal(provider()._chatRun('copilot'), DEFAULT_RUN);
        // The handler's messages.
        const src = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'chatPanel-handler.ts'), 'utf8');
        assert.match(src, /case 'setChatRun': \{\n\s+const section = CHAT_RUN_SECTIONS\.find\(\(x\) => x === message\.section\);\n\s+if \(section && typeof message\.run === 'string'\) \{ await this\._setChatRun\(section, message\.run\); \}/);
    });

    test('CR-3: a send into a non-default run', async () => {
        // The run's own chat variables and the window's.
        const chat = ChatVariablesStore.instance;
        chat.set('design', 'window-value', 'user');
        assert.equal(store().withRun('chg1', () => { chat.set('design', 'run-value', 'user'); return { ok: true as const }; }).ok, true);
        assert.equal(chat.getRaw('design'), 'window-value');
        let seen: Json;
        const handler = AnthropicHandler.instance as Json;
        const original = handler.sendMessage;
        handler.sendMessage = async (opts: Json) => {
            seen = { sessionKey: opts.sessionKey, design: ChatVariablesStore.instance.getRaw('design'), run: store().variables().run, process: store().variables().process };
            return { text: 'done', turnsUsed: 1, toolCallCount: 0 };
        };
        try {
            await provider()._handleSendAnthropic('hello', '', 'claude-test-model', '', undefined, true);
        } finally { handler.sendMessage = original; }
        assert.ok(seen, 'the send ran');
        assert.deepEqual(seen, { sessionKey: provider()._panelSession(), design: 'run-value', run: 'chg1', process: 'change' });
        assert.equal(chat.getRaw('design'), 'window-value', 'the window\'s own stay');
        assert.equal(store().currentRun, DEFAULT_RUN);
    });

    test('CR-4: Save to Queue carries the run', async () => {
        for (const i of [...queue().items]) { queue().remove(i.id); }
        await provider()._handleAddToQueue('queued from anthropic', '', '1', 0, { transport: 'anthropic', usePanelTarget: true, anthropicProfileId: 'p' }, { section: 'anthropic' });
        const item = queue().items.find((i) => i.originalText === 'queued from anthropic')!;
        assert.equal(item.run, 'chg1');
        assert.equal(item.session, chatRunSession(provider()._chatSessionKey(), 'chg1'), 'the run\'s session');
        await provider()._setChatRun('copilot', 'chg2');
        await provider()._handleAddToQueue('queued from copilot', '', '1', 0, undefined, {});
        assert.equal(queue().items.find((i) => i.originalText === 'queued from copilot')!.run, 'chg2', 'the Copilot subpanel\'s run');
        for (const i of [...queue().items]) { queue().remove(i.id); }
    });

    test('CR-5: a deleted run falls back to default', async () => {
        assert.equal(provider()._chatRun('anthropic'), 'chg1');
        assert.equal(store().deleteRuns(['chg1']).ok, true);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(provider()._chatRun('anthropic'), DEFAULT_RUN);
        assert.equal((context as Json).workspaceState.get(`tomAi.chatPanel.run.${QUEST}.anthropic`), undefined, 'the pick is forgotten');
        assert.equal(lastPosted('chatRuns').selected.anthropic, DEFAULT_RUN, 'the webview is told');
        assert.equal(provider()._chatRun('copilot'), 'chg2', 'the other subpanel keeps its run');
    });

    test('CR-6: the webview', () => {
        const html = fs.readFileSync(path.join(EXT, 'media', 'chatPanel', 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
        const w = new JSDOM(html, { runScripts: 'outside-only' }).window as Json;
        try {
            const sent: Json[] = [];
            w.acquireVsCodeApi = () => ({ postMessage: (m: Json) => sent.push(JSON.parse(JSON.stringify(m))), setState: () => undefined, getState: () => ({ expanded: ['anthropic', 'copilot'], pinned: [] }) });
            w.__INIT__ = {};
            w.eval(fs.readFileSync(path.join(EXT, 'media', 'chatPanel', 'main.js'), 'utf8'));
            const sel = (s: string): Json => w.document.getElementById(`${s}-run`);
            assert.ok(sel('anthropic') && sel('copilot'), 'a run select in each subpanel');
            w.dispatchEvent(new w.MessageEvent('message', { data: {
                type: 'chatRuns', windowRun: 'default',
                options: [{ run: 'default', label: 'default (PROCESS view)' }, { run: 'chg2', label: 'chg2' }],
                selected: { anthropic: 'default', copilot: 'chg2' },
            } }));
            assert.deepEqual([...sel('copilot').options].map((o: Json) => o.textContent), ['Run: default (PROCESS view)', 'Run: chg2']);
            assert.equal(sel('copilot').value, 'chg2');
            assert.equal(sel('anthropic').value, 'default');
            assert.equal(sel('copilot').classList.contains('run-other'), true, 'on another run than the PROCESS view\'s');
            assert.equal(sel('anthropic').classList.contains('run-other'), false);
            sel('anthropic').value = 'chg2';
            sel('anthropic').dispatchEvent(new w.Event('change'));
            assert.deepEqual(sent.filter((m) => m.type === 'setChatRun').at(-1), { type: 'setChatRun', section: 'anthropic', run: 'chg2' });
        } finally { w.close(); }
    });
});
