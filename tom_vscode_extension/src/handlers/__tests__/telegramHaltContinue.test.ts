/**
 * Telegram `halt` / `pause` and `continue` / `resume` pause and resume the prompt queue (vscimpb26), through the
 * poller's parse (TelegramNotifier) and the command registry as handleStandaloneCommand dispatches them.
 *
 *   TH-1 the poller reads `halt`, `/halt`, `pause` as `halt` and `continue`, `/resume`, `resume` as `continue`
 *   TH-2 `halt` turns auto-send off and says so; again: already paused; `continue` turns it on; again: already
 *        running — the same switch `queue_pause` toggles
 *   TH-3 `help` lists both, with their aliases
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub';
installVscodeStub({});

import { TelegramNotifier, type TelegramCommand } from '../telegram-notifier';
import { createCommandRegistry, type CommandRegistryDeps } from '../telegram-cmd-handlers';

/** A channel that hands messages to the notifier the way the Telegram channel does. */
function notifierWithChannel(): { send(text: string): TelegramCommand | null } {
    let deliver: ((msg: unknown) => void) | null = null;
    const channel = {
        isEnabled: true,
        onMessage: (cb: (msg: unknown) => void) => { deliver = cb; },
        sendMessage: async () => ({ ok: true }),
        startListening: () => undefined,
        stopListening: () => undefined,
        dispose: () => undefined,
    };
    const notifier = new TelegramNotifier(channel as never, {} as never);
    let last: TelegramCommand | null = null;
    notifier.onCommand((cmd) => { last = cmd; });
    return {
        send(text: string) {
            last = null;
            deliver!({ text, senderId: 7, chatId: 7, senderName: 'me' });
            return last;
        },
    };
}

/** The registry with a queue whose auto-send switch is `state.running`. */
function registryWithQueue(): { state: { running: boolean; toggles: number }; run(text: string): Promise<string> } {
    const state = { running: true, toggles: 0 };
    const deps = {
        queue: {
            addPrompt: async () => undefined,
            list: () => [],
            deleteAt: () => ({ ok: false, message: '' }),
            togglePause: () => { state.toggles++; state.running = !state.running; return state.running; },
            setRunning: (running: boolean) => { state.running = running; },
            isRunning: () => state.running,
        },
    } as unknown as CommandRegistryDeps;
    const registry = createCommandRegistry(() => undefined, deps);
    return {
        state,
        async run(text: string): Promise<string> {
            const parsed = registry.parse(text, 7, 7, 'me');
            assert.ok(parsed, `parsed: ${text}`);
            const def = registry.get(parsed.command);
            assert.ok(def, `registered: ${parsed.command}`);
            return String((await def.handler(parsed)).text);
        },
    };
}

describe('Telegram halt / continue', () => {
    test('TH-1: the poller\'s reading', () => {
        const n = notifierWithChannel();
        for (const text of ['halt', '/halt', 'pause', 'HALT']) { assert.equal(n.send(text)?.type, 'halt', text); }
        for (const text of ['continue', '/continue', 'resume', '/resume']) { assert.equal(n.send(text)?.type, 'continue', text); }
    });

    test('TH-2: pause and resume the queue', async () => {
        const { state, run } = registryWithQueue();
        // handleStandaloneCommand dispatches a halt / continue command by its type.
        assert.match(await run('halt'), /Queue paused/);
        assert.equal(state.running, false);
        assert.match(await run('halt'), /already paused/);
        assert.equal(state.running, false);
        assert.match(await run('continue'), /Queue resumed/);
        assert.equal(state.running, true);
        assert.match(await run('continue'), /already running/);
        assert.equal(state.toggles, 0, 'set, never toggled');
        assert.match(await run('queue_pause'), /paused/);
        assert.equal(state.running, false, 'the same switch');
    });

    test('TH-3: listed in help', async () => {
        const { run } = registryWithQueue();
        const help = await run('help');
        assert.match(help, /halt/);
        assert.match(help, /continue/);
        assert.match(await run('help halt'), /pause/);
        assert.match(await run('help continue'), /resume/);
    });
});
