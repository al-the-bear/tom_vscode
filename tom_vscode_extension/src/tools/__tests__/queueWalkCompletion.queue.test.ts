/**
 * A `<prefix>*` walk iteration whose todo is not completed after its turn gets a continuation in its own session
 * before the queue moves on (vscimpb58), through the real manager and its real dispatch; only the transport is a
 * stub. It plays the agent: a turn may set the walked todo's status in the real todo file, which the check reads.
 *
 *   WC-1 the todo still in-progress after the turn: the continuation (its exact prompt) goes into the SAME session
 *        and iteration; the continuation completes the todo: the walk goes on; the iteration's answer is the last
 *        turn's (repetition answer, `${answer}` / answerText, the todo's last_answer), its chip marked 1
 *        continuation with the first answer folded as earlier; the continuation prompt is no answer
 *   WC-2 still unfinished after 2 continuations (the default): the item stops as needs attention — auto-send off,
 *        the reason on the item and in its queue file, the next todo not sent; auto-send on again goes on with the
 *        next todo and clears it
 *   WC-3 no continuation when the todo is blocked, decision-needed, has an open decision, or a question waits; none
 *        for a completed todo
 *   WC-4 the number is configurable: the item's walkContinuations (0: needs attention at once), the queue's
 *        `walk-continuations` (default 2)
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb58_walkcheck-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        profiles: [{ id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' }],
        configurations: [{ id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' }],
    },
}, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

/** The walk's todos: `<prefix>1_x` … `<prefix>n_x`, not started; `extra` adds lines to a todo (by number). */
function writeTodos(prefix: string, n: number, extra: Record<number, string[]> = {}): void {
    const todos = Array.from({ length: n }, (_, i) => [
        `  - id: ${prefix}${i + 1}_x`, `    title: todo ${i + 1}`, '    status: not-started', '    priority: medium', '    created: 2026-11-12',
        ...(extra[i + 1] ?? []),
    ].join('\n'));
    fs.writeFileSync(path.join(QDIR, `todos.${prefix}.${QUEST}.todo.yaml`), `todos:\n${todos.join('\n')}\n`);
}

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';
import { AskUserRegistry } from '../../services/askUserRegistry.js';
import { findTodoById, updateTodo } from '../../managers/questTodoManager.js';
import { continuationPrompt } from '../../utils/walkCompletionCheck.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';

const subscriptions: Array<{ dispose(): void }> = [];
(function start(): void {
    const storage = path.join(SANDBOX, 'storage');
    fs.mkdirSync(storage, { recursive: true });
    const memento = (): unknown => {
        const values = new Map<string, unknown>();
        return { get: (k: string, d?: unknown) => values.has(k) ? values.get(k) : d, update: async (k: string, v: unknown) => { values.set(k, v); }, keys: () => [...values.keys()], setKeysForSync: () => undefined };
    };
    const context = {
        subscriptions, extensionPath: EXT_ROOT, extensionUri: { fsPath: EXT_ROOT, scheme: 'file' },
        globalStorageUri: { fsPath: storage, scheme: 'file' }, storageUri: { fsPath: storage, scheme: 'file' }, logUri: { fsPath: storage, scheme: 'file' },
        globalStoragePath: storage, storagePath: storage, logPath: storage, globalState: memento(), workspaceState: memento(),
        asAbsolutePath: (rel: string) => path.join(EXT_ROOT, rel),
    } as never;
    setExtensionPath(EXT_ROOT);
    TomAiConfiguration.init(context);
    ChatVariablesStore.init(context);
    ReminderSystem.init(context);
    TimerEngine.init(context);
    PromptQueueManager.init(context);
})();
after(() => {
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => { handler.sendMessage = originalSend; });

/** Each turn: its options; `script(opts, n)` plays the agent and says the answer. */
const turns: Json[] = [];
let script: (opts: Json, n: number) => string = () => 'done';
handler.sendMessage = async (opts: Json) => {
    turns.push(opts);
    return { text: script(opts, turns.length), turnsUsed: 1, toolCallCount: 0 };
};
const todoOf = (id: string): Json => findTodoById(QUEST, id);
const setStatus = (id: string, status: string): void => { updateTodo(QUEST, id, { status } as never); };
const todoIdIn = (text: string): string | undefined => /(\w+\d_x)/.exec(text)?.[1];

function reset(): void {
    queue().autoSendEnabled = false;
    AskUserRegistry.instance.cancel('reset');
    for (const i of [...queue().items]) { queue().remove(i.id); }
    turns.length = 0;
}
async function runWalk(prefix: string, opts: Record<string, unknown> = {}): Promise<QueuedPrompt> {
    const item = await queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', anthropicProfileId: 'sdk', session: `s-${prefix}`, deferSend: true, initialStatus: 'pending', ...opts } as never);
    queue().autoSendEnabled = true;
    await wait(400);
    return item;
}
const live = (item: QueuedPrompt): QueuedPrompt => queue().getById(item.id) as QueuedPrompt;
function queueFileText(id: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(id)) { found.push(fs.readFileSync(p, 'utf8')); }
        }
    };
    walk(SANDBOX);
    return found.join('\n');
}

describe('a walk iteration whose todo is not completed', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic', 'sdk');
    });

    test('WC-1: one continuation in the same session, then the walk goes on', async () => {
        reset();
        writeTodos('wa', 2);
        script = (opts, n) => {
            const text = String(opts.userText);
            if (n === 1) { return 'Started the corpus run; I am waiting to get notified.'; }
            if (text === continuationPrompt('wa1_x')) { setStatus('wa1_x', 'completed'); return 'The run finished green; wa1_x completed.'; }
            const id = todoIdIn(text);
            if (id) { setStatus(id, 'completed'); }
            return `done ${id}`;
        };
        const item = await runWalk('wa');
        assert.deepEqual(turns.map((t) => todoIdIn(String(t.userText)) ?? String(t.userText)), ['wa1_x', continuationPrompt('wa1_x').match(/(\w+\d_x)/)![1], 'wa2_x']);
        assert.equal(turns[1].userText, continuationPrompt('wa1_x'), 'the continuation prompt, as it is');
        assert.equal(turns[1].sessionKey, turns[0].sessionKey, 'the same session');
        assert.equal(turns[1].iterationKey, turns[0].iterationKey, 'the same iteration');
        const done = live(item);
        assert.equal(done.status, 'sent');
        const rep = done.repetitionAnswers?.find((a) => a.key === 'wa1_x');
        assert.equal(rep?.text, 'The run finished green; wa1_x completed.', 'the last turn\'s answer');
        assert.equal(rep?.continuations, 1);
        assert.deepEqual(rep?.earlier, ['Started the corpus run; I am waiting to get notified.']);
        assert.deepEqual(done.repetitionAnswers?.map((a) => a.key), ['wa1_x', 'wa2_x'], 'the continuation prompt is no answer');
        assert.equal(todoOf('wa1_x').last_answer, 'The run finished green; wa1_x completed.', 'the todo keeps the final answer');
        assert.match(queueFileText(item.id), /continuations: 1/);
    });

    test('WC-2: still unfinished after 2 continuations: needs attention', async () => {
        reset();
        writeTodos('wb', 2);
        script = (opts) => {
            const id = todoIdIn(String(opts.userText));
            if (id === 'wb2_x') { setStatus(id, 'completed'); }
            return `still waiting (${turns.length})`;
        };
        const item = await runWalk('wb');
        assert.deepEqual(turns.map((t) => String(t.userText)), ['work on wb1_x', continuationPrompt('wb1_x'), continuationPrompt('wb1_x')].map((t) => t.replace('work on wb1_x', String(turns[0].userText))));
        const held = live(item);
        assert.equal(held.status, 'sending', 'held, not walking on');
        assert.match(held.needsAttention ?? '', /The todo wb1_x is still in-progress after 2 continuations/);
        assert.equal(queue().autoSendEnabled, false, 'auto-send off');
        assert.match(queueFileText(item.id), /needs-attention:/);
        assert.equal(held.repetitionAnswers?.find((a) => a.key === 'wb1_x')?.continuations, 2);
        assert.equal(turns.length, 3, 'wb2_x not sent');
        queue().autoSendEnabled = true;
        await wait(400);
        assert.equal(todoIdIn(String(turns[3]?.userText)), 'wb2_x', 'auto-send on: the next todo');
        assert.equal(live(item).needsAttention, undefined, 'cleared when it went on');
        assert.equal(live(item).status, 'sent');
    });

    test('WC-3: no continuation when the todo or a question says why', async () => {
        for (const [prefix, what] of [['wc', 'blocked'], ['wd', 'decision-needed'], ['we', 'open decision'], ['wf', 'question'], ['wg', 'completed']] as const) {
            reset();
            writeTodos(prefix, 2, what === 'open decision'
                ? { 1: ['    decisions:', '      - summary: Which order?', '        decision_needed: (a) or (b)'] }
                : {});
            script = (opts) => {
                const id = todoIdIn(String(opts.userText))!;
                if (id.endsWith('1_x')) {
                    if (what === 'blocked' || what === 'decision-needed' || what === 'completed') { setStatus(id, what); }
                    if (what === 'question') {
                        // The turn ends while its question is still open (asked from inside the item's dispatch).
                        void AskUserRegistry.instance.begin({ questions: ['Which?'], fallbackPrompt: 'f', onOpen: () => undefined, onResolve: () => undefined });
                    }
                } else {
                    setStatus(id, 'completed');
                }
                return `answer ${id}`;
            };
            const item = await runWalk(prefix);
            const texts = turns.map((t) => String(t.userText));
            assert.equal(texts.some((t) => t.startsWith('The todo ')), false, `${what}: no continuation`);
            assert.equal(live(item).needsAttention, undefined, `${what}: no needs attention`);
            // A decision-needed todo holds the walk by the queue's own rule (the decision first); the others go on.
            if (what !== 'question' && what !== 'decision-needed') {
                assert.deepEqual(texts.map((t) => todoIdIn(t)), [`${prefix}1_x`, `${prefix}2_x`], `${what}: the walk went on`);
            }
        }
        reset();
    });

    test('WC-4: the number is configurable', async () => {
        assert.equal(queue().walkContinuations, 2, 'the queue\'s default');
        reset();
        writeTodos('wh', 2);
        script = () => 'not yet';
        const item = await runWalk('wh', { walkContinuations: 0 });
        assert.equal(turns.length, 1, 'no continuation');
        assert.match(live(item).needsAttention ?? '', /after 0 continuations/);
        assert.equal(live(item).walkContinuations, 0);
        assert.match(queueFileText(item.id), /walk-continuations: 0/);
        reset();
        queue().walkContinuations = 1;
        writeTodos('wi', 1);
        const one = await runWalk('wi');
        assert.equal(turns.length, 2, 'the queue\'s 1');
        assert.match(live(one).needsAttention ?? '', /after 1 continuation;/);
        queue().walkContinuations = 2;
        reset();
    });
});
