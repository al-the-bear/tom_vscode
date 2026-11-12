/**
 * The direct API's and Local LLM's background wait (vscimpb56): the tomAi_runCommandStream handles a send started,
 * waited for with real processes.
 *
 *   CW-1 a handle belongs to the send whose tool call started it (runAsCommandOwner); another send's or none
 *   CW-2 a silent waiter loop (no output at all) is waited for until it ends; the waiting state is reported, then
 *        cleared; the outcome carries its exit code
 *   CW-3 a process that outlives its shell (`sleep … &`) keeps the handle alive (its process group exists)
 *   CW-4 the limit ends the wait with what still runs; limit 0 does not wait; nothing running is "none"
 *   CW-5 a cancelled send stops waiting
 *   CW-6 the message the turn goes on with names each command and how it ended
 *   CW-7 the user's choices (vscimpb57): Stop waiting ends the wait (reason `stopped`); Wait without limit waits
 *        past the limit; Keep waiting starts the limit again; the controls are handed out while waiting, then withdrawn
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { runAsCommandOwner } from '../commandOwners.js';
import { commandsFinishedMessage, waitForOwnedCommands, type CommandWaitDeps } from '../backgroundCommandWait.js';
import { _resetRegistryForTesting, commandsOfOwner, runCommandStreamImpl } from '../../tools/process-tools.js';
import type { BackgroundWaitState } from '../../utils/backgroundWait.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const WS = fs.realpathSync(fs.mkdtempSync(path.join(EXT_ROOT, '..', '..', '..', 'ztmp', 'vscode_extension_261112_vscimpb56_cmdwait-')));
after(() => {
    _resetRegistryForTesting();
    fs.rmSync(WS, { recursive: true, force: true });
});

async function start(owner: string | undefined, command: string): Promise<string> {
    const run = (): Promise<string> => runCommandStreamImpl({ wsRoot: WS }, { command });
    const out = JSON.parse(owner ? await runAsCommandOwner(owner, run) : await run()) as { handle: string };
    return out.handle;
}

function deps(owner: string, extra: Partial<CommandWaitDeps> = {}): CommandWaitDeps & { states: Array<BackgroundWaitState | undefined> } {
    const states: Array<BackgroundWaitState | undefined> = [];
    return {
        list: () => commandsOfOwner(owner),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        isCancelled: () => false,
        onState: (s) => { states.push(s); },
        pollMs: 50,
        states,
        ...extra,
    };
}

describe('waiting for a send\'s command streams', () => {
    test('CW-1: whose handle it is', async () => {
        const mine = await start('send-a', 'true');
        await start('send-b', 'true');
        await start(undefined, 'true');
        assert.deepEqual(commandsOfOwner('send-a').map((c) => c.handle), [mine]);
        assert.equal(commandsOfOwner('send-c').length, 0);
    });

    test('CW-2: a silent waiter loop is waited for until it ends', async () => {
        const handle = await start('send-2', 'i=0; while [ $i -lt 4 ]; do sleep 0.15; i=$((i+1)); done; exit 3');
        const d = deps('send-2');
        const outcome = await waitForOwnedCommands(360, d);
        assert.equal(outcome.kind, 'finished');
        assert.deepEqual(outcome.kind === 'finished' ? outcome.commands.map((c) => [c.handle, c.running, c.exitCode]) : [], [[handle, false, 3]]);
        assert.equal(d.states[0]?.limitMinutes, 360);
        assert.deepEqual(d.states[0]?.items.map((i) => [i.id, i.kind, i.command]), [[handle, 'command', 'i=0; while [ $i -lt 4 ]; do sleep 0.15; i=$((i+1)); done; exit 3']]);
        assert.equal(d.states[d.states.length - 1], undefined, 'cleared once the wait is over');
    });

    test('CW-3: a process outliving its shell keeps the handle alive', async () => {
        await start('send-3', 'sleep 0.6 &');
        await new Promise((r) => setTimeout(r, 150));
        const [cmd] = commandsOfOwner('send-3');
        assert.equal(cmd.running, true, 'the shell exited, its sleep runs on in the group');
        const startedAt = Date.now();
        const outcome = await waitForOwnedCommands(360, deps('send-3'));
        assert.equal(outcome.kind, 'finished');
        assert.ok(Date.now() - startedAt >= 250, 'waited for the sleep, not just the shell');
    });

    test('CW-4: the limit, limit 0, nothing running', async () => {
        const handle = await start('send-4', 'sleep 5');
        const outcome = await waitForOwnedCommands(0.005, deps('send-4'));
        assert.deepEqual(outcome, { kind: 'limit', running: [{ id: handle, kind: 'command', description: 'sleep 5', command: 'sleep 5' }], reason: 'limit' });
        const off = await waitForOwnedCommands(0, deps('send-4'));
        assert.equal(off.kind, 'limit', 'limit 0: no wait, what runs is named');
        assert.deepEqual(await waitForOwnedCommands(360, deps('nobody')), { kind: 'none' });
    });

    test('CW-5: cancelled', async () => {
        await start('send-5', 'sleep 5');
        let cancelled = false;
        setTimeout(() => { cancelled = true; }, 120);
        const d = deps('send-5', { isCancelled: () => cancelled });
        assert.deepEqual(await waitForOwnedCommands(360, d), { kind: 'cancelled' });
        assert.equal(d.states[d.states.length - 1], undefined);
    });

    test('CW-7: the user\'s choices', async () => {
        // Stop waiting.
        await start('send-7a', 'sleep 5');
        let control: import('../../utils/backgroundWait.js').BackgroundWaitControl | undefined;
        const controls: unknown[] = [];
        const d = deps('send-7a', { onControl: (c) => { controls.push(c); control = c; } });
        setTimeout(() => control?.stop(), 120);
        const stopped = await waitForOwnedCommands(360, d);
        assert.equal(stopped.kind, 'limit');
        assert.equal(stopped.kind === 'limit' ? stopped.reason : '', 'stopped');
        assert.equal(controls[controls.length - 1], undefined, 'withdrawn once the wait is over');
        // Wait without limit: past a 300 ms limit, until the command ends.
        await start('send-7b', 'sleep 0.6');
        const d2 = deps('send-7b', { onControl: (c) => { if (c) { c.waitWithoutLimit(); } } });
        const unlimited = await waitForOwnedCommands(0.005, d2);
        assert.equal(unlimited.kind, 'finished', 'waited past the limit');
        assert.equal(d2.states.find((s) => s?.unlimited)?.unlimited, true, 'the state says no limit');
        // Keep waiting: the limit again from now.
        // The command outlasts the restarted limit by far, so a loaded machine cannot let it finish first.
        await start('send-7c', 'sleep 3');
        let keep: import('../../utils/backgroundWait.js').BackgroundWaitControl | undefined;
        const d3 = deps('send-7c', { onControl: (c) => { keep = c; } });
        setTimeout(() => keep?.keepWaiting(), 250);
        const keptFrom = Date.now();
        const kept = await waitForOwnedCommands(0.006, d3); // 360 ms, restarted at 250 ms → 610 ms
        assert.equal(kept.kind, 'limit');
        assert.ok(Date.now() - keptFrom >= 550, 'the limit ran again from the click, not from the start');
        assert.ok(d3.states.some((s) => s?.limitFrom !== undefined), 'the state names the new start');
        _resetRegistryForTesting();
    });

    test('CW-6: the message to go on with', () => {
        const text = commandsFinishedMessage([
            { handle: 'proc_1', command: 'npm test', startedAt: 0, running: false, exitCode: 0, signal: null },
            { handle: 'proc_2', command: 'sleep 600', startedAt: 0, running: false, exitCode: null, signal: 'SIGTERM' },
        ]);
        assert.match(text, /^The background commands you started have finished:/);
        assert.match(text, /- `npm test` \[proc_1\]: exit code 0/);
        assert.match(text, /- `sleep 600` \[proc_2\]: ended by SIGTERM/);
        assert.match(text, /tomAi_readCommandOutput/);
    });
});
