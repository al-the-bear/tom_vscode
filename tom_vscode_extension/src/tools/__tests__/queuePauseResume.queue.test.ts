/**
 * Pause and resume while a stage is still running (vscimpb53), through the real queue manager under the vscode
 * stub. Only `dispatchStage` (the send to the model) is replaced, by a gate the test opens; the dispatch loop, the
 * pause gate, the resume and the todo walk are the manager's own. Measured in the d4rt window: a `ghissues*` walk
 * paused and resumed while its turn ran was marked `sent` by a second dispatch frame, while the first went on and
 * dispatched the next iteration on the sent item.
 *
 *   PR-1 a `w*` walk: auto-send off and on while a stage is in flight resumes nothing — the item stays `sending`, one
 *        stage in flight — and when the stage ends the same frame goes on with the next todo; never two stages of
 *        the item in flight at once
 *   PR-2 paused for real (the stage ended while auto-send was off: held at the gate), turning auto-send on resumes it
 *        and the walk finishes `sent` after its last todo, each todo sent once
 *   PR-3 no stage for an item that is not `sending`: removed (or sent) while its stage is in flight, the frame stops
 *        when the stage ends instead of dispatching the next one
 *   PR-4 a frame taken over: a newer frame of the item (a resend) makes the older one stop at its next stage
 */

/* eslint-disable @typescript-eslint/naming-convention -- YAML keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb53_pause-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), '{}\n');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

/** The walk's todos: `<prefix>1_x` … `<prefix>n_x`, not started. */
function writeTodos(prefix: string, n: number): void {
    const todos = Array.from({ length: n }, (_, i) => [
        `  - id: ${prefix}${i + 1}_x`, `    title: todo ${i + 1}`, '    status: not-started', '    priority: medium', '    created: 2026-11-12',
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
import { updateTodo } from '../../managers/questTodoManager.js';
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
/** The stub agent finishes its todo when its turn ends normally (vscimpb58: the queue reads it after the turn). */
function completeTodoIn(text: string): void {
    const id = /(\w+\d_x)/.exec(text)?.[1];
    if (id) { updateTodo(QUEST, id, { status: 'completed' } as never); }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The stages sent (their text), how many are in flight now and the most at once; `finish()` ends the oldest. */
const sent: string[] = [];
const open: Array<() => void> = [];
let inFlight = 0;
let maxInFlight = 0;
function gateDispatch(): void {
    (queue() as Json).dispatchStage = (text: string, _resolved: unknown, stage?: { answerText?: string }) => new Promise((resolve) => {
        sent.push(text);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        open.push(() => {
            inFlight--;
            completeTodoIn(text);
            if (stage) { stage.answerText = 'done'; }
            resolve({ mode: 'direct', answerText: 'done' });
        });
    });
}
async function finish(): Promise<void> {
    const next = open.shift();
    assert.ok(next, 'a stage is in flight');
    next();
    await wait(80);
}
function reset(): void {
    queue().autoSendEnabled = false;
    for (const i of [...queue().items]) { queue().remove(i.id); }
    sent.length = 0;
    open.length = 0;
    inFlight = 0;
    maxInFlight = 0;
}
const walk = (prefix: string): Promise<QueuedPrompt> =>
    queue().enqueue({ originalText: 'work on ${repeatTodoId}', repeatCount: `${prefix}*`, transport: 'anthropic', session: 's1', deferSend: true, initialStatus: 'pending' } as never);
const statusOf = (item: QueuedPrompt): string | undefined => queue().getById(item.id)?.status;
const todoIds = (): string[] => sent.map((t) => /(\w+_x)/.exec(t)?.[1] ?? t);

describe('pause and resume during a running stage', () => {
    test('setup', () => {
        queue().autoSendEnabled = false;
        queue().setDefaultTransport('anthropic');
        gateDispatch();
    });

    test('PR-1: pause and resume while the stage runs', async () => {
        reset();
        writeTodos('wa', 3);
        const item = await walk('wa');
        queue().autoSendEnabled = true;
        await wait(80);
        assert.deepEqual(todoIds(), ['wa1_x'], 'the first todo in flight');
        // The d4rt sequence: off, on — while wa1's turn still runs.
        queue().autoSendEnabled = false;
        queue().autoSendEnabled = true;
        await wait(80);
        assert.equal(statusOf(item), 'sending', 'still sending, not marked sent');
        assert.deepEqual([sent.length, inFlight], [1, 1], 'nothing resumed beside the running stage');
        await finish();
        assert.deepEqual(todoIds(), ['wa1_x', 'wa2_x'], 'the same frame went on with the next todo');
        assert.equal(statusOf(item), 'sending');
        await finish();
        await finish();
        assert.deepEqual(todoIds(), ['wa1_x', 'wa2_x', 'wa3_x']);
        assert.equal(statusOf(item), 'sent', 'done after its last todo');
        assert.equal(maxInFlight, 1, 'never two stages of the item at once');
    });

    test('PR-2: paused for real, then resumed', async () => {
        reset();
        writeTodos('wb', 3);
        const item = await walk('wb');
        queue().autoSendEnabled = true;
        await wait(80);
        queue().autoSendEnabled = false;
        await finish();
        assert.deepEqual([todoIds(), statusOf(item), inFlight], [['wb1_x'], 'sending', 0], 'held at the gate: nothing in flight');
        queue().autoSendEnabled = true;
        await wait(80);
        assert.deepEqual(todoIds(), ['wb1_x', 'wb2_x'], 'resumed with the next todo');
        await finish();
        await finish();
        assert.deepEqual(todoIds(), ['wb1_x', 'wb2_x', 'wb3_x'], 'each todo once');
        assert.equal(statusOf(item), 'sent');
        assert.equal(maxInFlight, 1);
    });

    test('PR-3: no stage for an item that is not sending', async () => {
        reset();
        writeTodos('wc', 3);
        const item = await walk('wc');
        queue().autoSendEnabled = true;
        await wait(80);
        assert.equal(sent.length, 1);
        queue().remove(item.id);
        await finish();
        assert.equal(sent.length, 1, 'removed while its stage ran: the frame stopped');
        // Sent under a running frame (as the second frame did in d4rt): the first one stops too.
        reset();
        writeTodos('wd', 3);
        const other = await walk('wd');
        queue().autoSendEnabled = true;
        await wait(80);
        (queue().getById(other.id) as QueuedPrompt).status = 'sent';
        await finish();
        assert.equal(sent.length, 1, 'no iteration dispatched on a sent item (the ghost iteration 28)');
    });

    test('PR-4: a frame taken over stops at its next stage', async () => {
        reset();
        writeTodos('we', 3);
        const item = await walk('we');
        queue().autoSendEnabled = true;
        await wait(80);
        const live = queue().getById(item.id) as QueuedPrompt;
        // A newer frame takes the item over (as a resend does) while the first frame's stage is in flight.
        const newer = (queue() as Json)._claimFrame(live);
        await finish();
        assert.equal(sent.length, 1, 'the older frame did not dispatch the next todo');
        assert.equal(statusOf(item), 'sending', 'the item is the newer frame\'s now');
        (queue() as Json)._releaseFrame(live, newer);
        const src = fs.readFileSync(path.join(EXT_ROOT, 'src', 'managers', 'promptQueueManager.ts'), 'utf8');
        assert.match(src, /const frame = takeover \?\? this\._claimFrame\(item\);\n\s+try \{\n\s+if \(last\.transport === 'copilot'\)/, 'resend claims the item before its stage (a running stage resent: claimed before its turn is cancelled)');
        reset();
    });
});
