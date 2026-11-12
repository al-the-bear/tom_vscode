/**
 * The queue item and its turn's background wait (vscimpb56), through the real manager under the vscode stub; the
 * transport is a stub that reports a waiting state the way the transports do.
 *
 *   QB-1 the item's limit (enqueue, then updateItemRepetition) reaches the send; unset, none is passed (the
 *        profile's / 6 h apply in the handler)
 *   QB-2 the waiting state the turn reports is kept on the item (backgroundWaitOf) and in its queue file
 *        (`background-wait`), and cleared when the wait is over and when the stage ends
 *   QB-3 each button (vscimpb57): Wait without limit, Keep waiting and Stop waiting reach the waiting turn's
 *        controls, also through the editor's applyBackgroundWaitAction; Stop waiting ends the turn and the queue goes
 *        on; none of them acts on an item that does not wait (before the wait, after the stage)
 *   QB-4 a turn that ended with background work still running: its repetition answer and the item's answer are
 *        flagged (a red chip), in memory and in the queue file; the next answer without it clears the item's flag
 *   QB-5 Continue on a waiting item offers the three choices, then Resend and Skip; the choice reaches the turn
 */

/* eslint-disable @typescript-eslint/naming-convention -- config keys */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb56_bgwait-')));
const WS = path.join(SANDBOX, 'ws');
const HOME = path.join(SANDBOX, 'home');
const QUEST = 'q1';
const QDIR = path.join(WS, '_ai', 'quests', QUEST);
fs.mkdirSync(QDIR, { recursive: true });
fs.writeFileSync(path.join(QDIR, `overview.${QUEST}.md`), '# Q1\n');
fs.mkdirSync(path.join(WS, '.tom'), { recursive: true });
fs.writeFileSync(path.join(WS, '.tom', 'tom_vscode_extension.json'), JSON.stringify({
    anthropic: {
        apiKeyEnvVar: 'TOM_TEST_ANTHROPIC_KEY',
        profiles: [
            { id: 'sdk', name: 'SDK', systemPrompt: '', configurationId: 'c-sdk' },
            { id: 'api', name: 'API', systemPrompt: '', configurationId: 'c-api' },
        ],
        configurations: [
            { id: 'c-sdk', name: 'Agent SDK', model: 'claude-test', transport: 'agentSdk' },
            { id: 'c-api', name: 'Direct', model: 'claude-test', transport: 'direct' },
        ],
    },
}, null, 2));
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.TOM_TEST_ANTHROPIC_KEY = 'test-key';

import { installVscodeStub } from './_vscode-stub.js';
const vscodeStub = installVscodeStub({ workspaceFolders: [WS] });
(vscodeStub.stub.workspace as Record<string, unknown>).workspaceFile = { fsPath: path.join(WS, `${QUEST}.code-workspace`), scheme: 'file' };

import { ChatVariablesStore } from '../../managers/chatVariablesStore.js';
import { ReminderSystem } from '../../managers/reminderSystem.js';
import { TimerEngine } from '../../managers/timerEngine.js';
import { PromptQueueManager, type QueuedPrompt } from '../../managers/promptQueueManager.js';
import type { BackgroundWaitState } from '../../utils/backgroundWait.js';
import { applyBackgroundWaitAction, continueWithChoice } from '../../handlers/queueEditor-handler.js';
import { TomAiConfiguration } from '../../utils/tomAiConfiguration.js';
import { setExtensionPath } from '../../handlers/handler_shared.js';
import { AnthropicHandler } from '../../handlers/anthropic-handler.js';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const handler = AnthropicHandler.instance as Json;
const originalSend = handler.sendMessage;
after(() => {
    handler.sendMessage = originalSend;
    for (const stop of [() => PromptQueueManager.instance.dispose(), () => TimerEngine.instance.dispose(), () => ReminderSystem.instance.dispose()]) {
        try { stop(); } catch { /* not started */ }
    }
    for (const s of subscriptions.splice(0)) { try { s.dispose(); } catch { /* already gone */ } }
    vscodeStub.restore();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const queue = (): PromptQueueManager => PromptQueueManager.instance;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sends: Json[] = [];
let finishTurn: ((result?: Json) => void) | undefined;
handler.sendMessage = (opts: Json) => new Promise((resolve) => {
    sends.push(opts);
    finishTurn = (result?: Json) => resolve(result ?? { text: 'done', turnsUsed: 1, toolCallCount: 0 });
});
/** A waiting turn's controls, as the transports hand them out: each call recorded; stop ends the turn as the transports do. */
function startWaiting(opts: Json, calls: string[]): void {
    opts.onBackgroundWaitControl({
        waitWithoutLimit: () => { calls.push('waitWithoutLimit'); opts.onBackgroundWait({ ...STATE, unlimited: true }); },
        keepWaiting: () => { calls.push('keepWaiting'); opts.onBackgroundWait({ ...STATE, limitFrom: new Date().toISOString() }); },
        stop: () => {
            calls.push('stop');
            opts.onBackgroundWait(undefined);
            opts.onBackgroundWaitControl(undefined);
            finishTurn?.({ text: 'stopped\n\n_(1 background task was still running …)_', turnsUsed: 1, toolCallCount: 0, backgroundLeft: true });
        },
    });
    opts.onBackgroundWait(STATE);
}
const STATE: BackgroundWaitState = {
    since: '2026-11-12T18:00:00.000Z',
    limitMinutes: 30,
    items: [{ id: 'b1', kind: 'task', description: 'the corpus run', command: 'until [ -f done ]; do sleep 30; done', outputFile: '/tmp/b1.out' }],
};
function queueFileText(id: string): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.ya?ml$/.test(e.name)) {
                const text = fs.readFileSync(p, 'utf8');
                if (text.includes(id)) { found.push(text); }
            }
        }
    };
    walk(SANDBOX);
    return found.join('\n');
}

describe('a queue item and its background wait', () => {
    test('QB-1: the item\'s limit reaches the send', async () => {
        queue().setDefaultTransport('anthropic', 'sdk');
        const plain = await queue().enqueue({ originalText: 'plain', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'staged' } as never);
        const limited = await queue().enqueue({ originalText: 'limited', transport: 'anthropic', anthropicProfileId: 'sdk', backgroundWaitLimitMinutes: 30, deferSend: true, initialStatus: 'staged' } as never);
        assert.equal(queue().getById(limited.id)?.backgroundWaitLimitMinutes, 30);
        assert.equal(queue().getById(plain.id)?.backgroundWaitLimitMinutes, undefined);
        assert.equal(queue().updateItemRepetition(limited.id, { backgroundWaitLimitMinutes: 45 }), true);
        assert.equal(queue().getById(limited.id)?.backgroundWaitLimitMinutes, 45);
        assert.match(queueFileText(limited.id), /background-wait-limit-minutes: 45/);
        void queue().sendNow(limited.id);
        await wait(150);
        assert.equal(sends[0]?.backgroundWaitLimitMinutes, 45);
        assert.equal(typeof sends[0]?.onBackgroundWait, 'function');
        finishTurn?.();
        await wait(150);
        void queue().sendNow(plain.id);
        await wait(150);
        assert.equal('backgroundWaitLimitMinutes' in sends[1], false, 'unset: the handler applies the profile\'s or 6 h');
        finishTurn?.();
        await wait(150);
        assert.equal(queue().updateItemRepetition(plain.id, { backgroundWaitLimitMinutes: -1 }), false, 'a sent item is not editable');
    });

    test('QB-2: the waiting state is kept, persisted and cleared', async () => {
        sends.length = 0;
        const item: QueuedPrompt = await queue().enqueue({ originalText: 'waits', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'staged' } as never);
        void queue().sendNow(item.id);
        await wait(150);
        sends[0].onBackgroundWait(STATE);
        assert.deepEqual(queue().backgroundWaitOf(item.id), STATE);
        const file = queueFileText(item.id);
        assert.match(file, /background-wait:/);
        assert.match(file, /limit-minutes: 30/);
        assert.match(file, /until \[ -f done \]; do sleep 30; done/);
        sends[0].onBackgroundWait(undefined);
        assert.equal(queue().backgroundWaitOf(item.id), undefined, 'the wait is over');
        assert.doesNotMatch(queueFileText(item.id), /background-wait:/);
        sends[0].onBackgroundWait(STATE);
        finishTurn?.();
        await wait(150);
        assert.equal(queue().backgroundWaitOf(item.id), undefined, 'cleared when the stage ended');
    });

    test('QB-3: each button reaches the waiting turn', async () => {
        sends.length = 0;
        const item: QueuedPrompt = await queue().enqueue({ originalText: 'buttons', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'staged' } as never);
        void queue().sendNow(item.id);
        await wait(150);
        const calls: string[] = [];
        // The turn runs but does not wait yet: no button acts.
        sends[0].onBackgroundWaitControl({ waitWithoutLimit: () => calls.push('early'), keepWaiting: () => calls.push('early'), stop: () => calls.push('early') });
        assert.deepEqual([queue().waitWithoutLimit(item.id), queue().keepWaitingForBackground(item.id), queue().stopBackgroundWait(item.id)], [false, false, false]);
        startWaiting(sends[0], calls);
        assert.equal(queue().waitWithoutLimit(item.id), true);
        assert.equal(queue().backgroundWaitOf(item.id)?.unlimited, true, 'the state says no limit');
        assert.equal(queue().keepWaitingForBackground(item.id), true);
        assert.ok(queue().backgroundWaitOf(item.id)?.limitFrom, 'the limit counts from now');
        assert.equal(applyBackgroundWaitAction(queue(), item.id, 'keepWaiting'), true, 'the editor\'s and @CHAT\'s route');
        assert.equal(queue().stopBackgroundWait(item.id), true);
        assert.deepEqual(calls, ['waitWithoutLimit', 'keepWaiting', 'keepWaiting', 'stop']);
        await wait(200);
        assert.equal(queue().getById(item.id)?.status, 'sent', 'the turn ended; the queue went on');
        assert.equal(queue().stopBackgroundWait(item.id), false, 'after the stage: nothing to stop');
    });

    test('QB-4: a turn that left background work running is flagged', async () => {
        sends.length = 0;
        const item: QueuedPrompt = await queue().enqueue({ originalText: 'repeated', repeatCount: 2, transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'staged' } as never);
        // Auto-send on: the second repetition goes out after the first (off, it would hold at the pause gate).
        queue().autoSendEnabled = true;
        void queue().sendNow(item.id);
        await wait(150);
        startWaiting(sends[0], []);
        assert.equal(queue().stopBackgroundWait(item.id), true);
        await wait(200);
        const live = queue().getById(item.id) as QueuedPrompt;
        assert.deepEqual(live.repetitionAnswers?.map((a) => [a.key, a.backgroundLeft === true]), [['1', true]]);
        assert.equal(live.answerBackgroundLeft, true);
        const file = queueFileText(item.id);
        assert.match(file, /background-left: true/);
        assert.match(file, /answer-background-left: true/);
        finishTurn?.(); // the second repetition answers normally
        await wait(200);
        const done = queue().getById(item.id) as QueuedPrompt;
        assert.deepEqual(done.repetitionAnswers?.map((a) => [a.key, a.backgroundLeft === true]), [['1', true], ['2', false]]);
        assert.equal(done.answerBackgroundLeft, undefined, 'the latest answer is not');
        queue().autoSendEnabled = false;
    });

    test('QB-5: Continue on a waiting item', async () => {
        sends.length = 0;
        const shown: unknown[][] = [];
        let pick: string | undefined;
        const win = vscodeStub.stub.window as Json;
        const original = win.showWarningMessage;
        win.showWarningMessage = (...args: unknown[]) => { shown.push(args); return Promise.resolve(pick); };
        try {
            const item: QueuedPrompt = await queue().enqueue({ originalText: 'continue me', transport: 'anthropic', anthropicProfileId: 'sdk', deferSend: true, initialStatus: 'staged' } as never);
            void queue().sendNow(item.id);
            await wait(150);
            const calls: string[] = [];
            startWaiting(sends[0], calls);
            pick = 'Wait without limit';
            await continueWithChoice(queue(), item.id);
            assert.deepEqual(shown[0].slice(2), ['Wait without limit', 'Keep waiting up to 30 min', 'Stop waiting', 'Resend this stage', 'Skip to the next stage']);
            assert.match(String(shown[0][0]), /waiting for its background work \(1 task, .* of 30 min\)/);
            pick = 'Stop waiting';
            await continueWithChoice(queue(), item.id);
            assert.deepEqual(calls, ['waitWithoutLimit', 'stop']);
            await wait(200);
            assert.equal(queue().getById(item.id)?.status, 'sent');
        } finally {
            win.showWarningMessage = original;
        }
    });
});
