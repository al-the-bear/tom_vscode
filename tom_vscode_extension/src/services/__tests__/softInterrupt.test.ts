/**
 * The soft interrupt for continuation (vscimpb112; services/softInterrupt.ts), the Agent SDK's PostToolUse hold hook
 * (utils/agentSdkQueueRun.ts) and the queue's status bar text (utils/queueRunStatus.ts).
 *
 *   SI-U1 a hold point passes at once when no soft interrupt of its item is requested; with one, the tool result is
 *         not returned until release, and the state names the tool, the time held and the result
 *   SI-U2 release: the held-for line only when held longer than a minute; release of an item that waits for its hold
 *         point withdraws the request
 *   SI-U3 the timer: fires after the wait when nothing was held; not after a hold or markHeld; a second request is
 *         refused; clear lets a waiting hold point go as aborted
 *   SI-U4 the record: the queue file round trip, the resend line of a held result, the held conversation with the
 *         held-for line (direct API and Local LLM)
 *   SI-U5 the PostToolUse hook: holds a built-in's result until release (the held-for line as additional context),
 *         passes the extension's own tools and items without a soft interrupt, lets go on abort; registered with a
 *         long timeout for every tool
 *   SI-U6 the status bar text of the window's run: held, interrupting, answer needed, until
 *   SI-U7 waiting without a limit: the timer stops (never fires), the state says unlimited and keeps it once held
 *         (and pausedAutoSend from the request); refused when nothing waits, when held, when already unlimited;
 *         the queue file keeps both
 */

/* eslint-disable @typescript-eslint/naming-convention -- queue-file keys, the API's and the SDK hook's wire fields */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    formatHeldDuration,
    heldForLine,
    heldResultResendLine,
    prefixHeldConversation,
    SoftInterruptRegistry,
    softInterruptFromYaml,
    softInterruptToYaml,
} from '../softInterrupt.js';
import { runAsQueueItem } from '../userWaits.js';
import { softInterruptHoldHook, SOFT_INTERRUPT_HOOK_TIMEOUT_S, withSoftInterruptHold } from '../../utils/agentSdkQueueRun.js';
import { runStatusBarText } from '../../utils/queueRunStatus.js';

/** A registry on a fake clock and fake timers. */
function fake(): { reg: SoftInterruptRegistry; advance(ms: number): void; timers: Array<{ at: number; cb: () => void; done?: boolean }> } {
    let now = 1_000_000;
    const timers: Array<{ at: number; cb: () => void; done?: boolean }> = [];
    const reg = new SoftInterruptRegistry({
        now: () => now,
        setTimer: (ms, cb) => { const t = { at: now + ms, cb }; timers.push(t); return t as never; },
        clearTimer: (h) => { (h as unknown as { done: boolean }).done = true; },
    });
    return {
        reg,
        timers,
        advance(ms: number) {
            now += ms;
            for (const t of timers) { if (!t.done && t.at <= now) { t.done = true; t.cb(); } }
        },
    };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('soft interrupt for continuation', () => {
    test('SI-U1: a hold point holds only a requested item', async () => {
        const { reg, advance } = fake();
        assert.deepEqual(await reg.holdAt('a', 'Bash', 'out'), {}, 'nothing requested: passes');
        assert.deepEqual(await reg.holdAt(undefined, 'Bash', 'out'), {}, 'no item: passes');
        assert.equal(reg.request('a'), true);
        let released: unknown;
        void reg.holdAt('a', 'Bash', { stdout: 'built' }).then((r) => { released = r; });
        await settle();
        assert.equal(released, undefined, 'the result is not returned');
        const state = reg.stateOf('a')!;
        assert.equal(state.kind, 'tool');
        assert.equal(state.tool, 'Bash');
        assert.equal(state.heldResult, '{"stdout":"built"}');
        assert.equal(state.heldAt, 1_000_000);
        assert.equal(reg.hasLiveHold('a'), true);
        advance(30_000);
        assert.equal(reg.release('a'), true);
        await settle();
        assert.deepEqual(released, {}, 'held 30 s: no line');
        assert.equal(reg.stateOf('a'), undefined);
    });

    test('SI-U2: the held-for line, and a request withdrawn', async () => {
        const { reg, advance } = fake();
        reg.request('a');
        let released: { prefix?: string } | undefined;
        void reg.holdAt('a', 'Read', 'x').then((r) => { released = r; });
        advance(125_000);
        reg.release('a');
        await settle();
        assert.equal(released?.prefix, '[This result was held for 2 min 5 s by the user\'s interrupt for continuation.]');
        assert.equal(heldForLine(60_000), undefined, 'a minute exactly: no line');
        assert.equal(formatHeldDuration(3_780_000), '1 h 3 min');
        reg.request('b');
        assert.equal(reg.release('b'), false, 'nothing held yet: the request is withdrawn');
        assert.equal(reg.stateOf('b'), undefined);
        assert.deepEqual(await reg.holdAt('b', 'Read', 'x'), {}, 'and the next tool passes');
    });

    test('SI-U3: the timer, a second request, clear', async () => {
        const { reg, advance } = fake();
        let fired = 0;
        reg.request('a', () => { fired++; });
        assert.equal(reg.request('a', () => { fired += 10; }), false, 'a second request changes nothing');
        advance(14_999);
        assert.equal(fired, 0);
        advance(1);
        assert.equal(fired, 1, 'nothing held within 15 s');
        reg.clear('a');
        reg.request('b', () => { fired++; });
        void reg.holdAt('b', 'Bash', 'x');
        advance(20_000);
        assert.equal(fired, 1, 'held: the timer does not fire');
        reg.request('c', () => { fired++; });
        assert.equal(reg.markHeld('c', 'question', 'tomAi_askUser'), true);
        advance(20_000);
        assert.equal(fired, 1, 'an open question counts as held');
        assert.equal(reg.stateOf('c')?.kind, 'question');
        let release: { aborted?: true } | undefined;
        reg.clear('b');
        reg.request('d');
        void reg.holdAt('d', 'Bash', 'x').then((r) => { release = r; });
        assert.equal(reg.clear('d')?.tool, 'Bash');
        await settle();
        assert.deepEqual(release, { aborted: true });
    });

    test('SI-U7: waiting without a limit', async () => {
        const { reg, advance } = fake();
        let fired = 0;
        reg.request('a', () => { fired++; }, undefined, { pausedAutoSend: true });
        advance(10_000);
        assert.equal(reg.waitWithoutLimit('a'), true);
        assert.equal(reg.waitWithoutLimit('a'), false, 'already unlimited');
        advance(60 * 60_000);
        assert.equal(fired, 0, 'no hard interrupt by the timer');
        assert.deepEqual(reg.stateOf('a'), { requestedAt: reg.stateOf('a')!.requestedAt, pausedAutoSend: true, unlimited: true });
        void reg.holdAt('a', 'Bash', 'out');
        assert.equal(reg.stateOf('a')?.unlimited, true, 'kept once held');
        assert.equal(reg.stateOf('a')?.pausedAutoSend, true);
        assert.equal(reg.waitWithoutLimit('a'), false, 'held: nothing to wait for');
        assert.equal(reg.waitWithoutLimit('nobody'), false);
        reg.clear('a');
        const state = { requestedAt: Date.parse('2026-11-19T10:00:00Z'), unlimited: true, pausedAutoSend: true };
        assert.deepEqual(softInterruptToYaml(state), { 'requested-at': '2026-11-19T10:00:00.000Z', unlimited: true, 'paused-auto-send': true });
        assert.deepEqual(softInterruptFromYaml(softInterruptToYaml(state)), state);
    });

    test('SI-U4: the record', () => {
        const state = { requestedAt: Date.parse('2026-11-15T10:00:00Z'), heldAt: Date.parse('2026-11-15T10:00:05Z'), kind: 'tool' as const, tool: 'Bash', heldResult: 'built' };
        const yaml = softInterruptToYaml(state);
        assert.deepEqual(yaml, { 'requested-at': '2026-11-15T10:00:00.000Z', 'held-at': '2026-11-15T10:00:05.000Z', kind: 'tool', tool: 'Bash', 'held-result': 'built' });
        assert.deepEqual(softInterruptFromYaml(yaml), state);
        assert.equal(softInterruptFromYaml({ kind: 'tool' }), undefined);
        assert.equal(heldResultResendLine(state), 'The result of your last tool call Bash was: built');
        assert.equal(heldResultResendLine({ kind: 'question' }), undefined);
        const direct = prefixHeldConversation({
            transport: 'direct',
            messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: [] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }, { type: 'text', text: 'r' }] }],
        }, '[held]');
        assert.deepEqual((direct.messages[2] as { content: unknown[] }).content[0], { type: 'tool_result', tool_use_id: 't', content: '[held]\n\nout' });
        const local = prefixHeldConversation({ transport: 'localLlm', messages: [{ role: 'assistant', content: '' }, { role: 'tool', content: 'a' }, { role: 'tool', content: 'b' }] }, '[held]');
        assert.deepEqual(local.messages.map((m) => (m as { content: string }).content), ['', '[held]\n\na', 'b']);
        assert.equal(prefixHeldConversation(local, undefined), local);
    });

    test('SI-U5: the PostToolUse hook', async () => {
        const reg = new SoftInterruptRegistry();
        const hook = softInterruptHoldHook('mcp__tom-ai__', () => reg);
        const signal = new AbortController().signal;
        assert.deepEqual(await runAsQueueItem('q1', () => hook({ tool_name: 'Bash', tool_response: 'x' }, 't', { signal })), {}, 'no soft interrupt: passes');
        reg.request('q1');
        assert.deepEqual(await runAsQueueItem('q1', () => hook({ tool_name: 'mcp__tom-ai__tomAi_readFile', tool_response: 'x' }, 't', { signal })), {}, 'the extension\'s own tool: held in its handler');
        let out: unknown;
        void runAsQueueItem('q1', () => hook({ tool_name: 'Bash', tool_response: { stdout: 'ok' } }, 't', { signal })).then((r) => { out = r; });
        await settle();
        assert.equal(out, undefined, 'held');
        assert.equal(reg.stateOf('q1')?.tool, 'Bash');
        reg.release('q1');
        await settle();
        assert.deepEqual(out, {}, 'released (held under a minute: no context)');
        const ac = new AbortController();
        reg.request('q1');
        let aborted: unknown;
        void runAsQueueItem('q1', () => hook({ tool_name: 'Read', tool_response: 'x' }, 't', { signal: ac.signal })).then((r) => { aborted = r; });
        ac.abort();
        await settle();
        assert.deepEqual(aborted, {}, 'the turn ends: the hook lets go');
        const hooks = withSoftInterruptHold({ PreToolUse: [{ matcher: 'Bash', hooks: [] }] }, 'mcp__tom-ai__');
        assert.equal(hooks.PreToolUse.length, 1, 'other hooks kept');
        assert.equal(hooks.PostToolUse[0].matcher, undefined, 'every tool');
        assert.equal(hooks.PostToolUse[0].timeout, SOFT_INTERRUPT_HOOK_TIMEOUT_S);
        assert.ok(SOFT_INTERRUPT_HOOK_TIMEOUT_S >= 7 * 24 * 3600);
    });

    test('SI-U6: the status bar text', () => {
        const at = new Date(2026, 10, 15, 14, 5).getTime();
        assert.deepEqual(runStatusBarText({ run: 'r', softInterrupt: { requestedAt: at, heldAt: at, kind: 'tool', tool: 'Bash' } })?.text, '$(debug-disconnect) held: Bash');
        assert.match(runStatusBarText({ run: 'r', softInterrupt: { requestedAt: at, heldAt: at, kind: 'tool', tool: 'Bash' } })!.tooltip, /held for continuation since 14:05 at the result of Bash/);
        assert.equal(runStatusBarText({ run: 'r', softInterrupt: { requestedAt: at } })?.text, '$(loading~spin) interrupting');
        assert.equal(runStatusBarText({ run: 'r', question: { firstLine: 'Which?' } })?.text, '❓ answer needed');
        assert.equal(runStatusBarText({ run: 'r', waitingFor: { reason: 'pub.dev', until: new Date(2026, 10, 15, 14, 20).toISOString(), since: new Date(at).toISOString() } as never })?.text, '⏳ until 14:20');
        assert.equal(runStatusBarText({ run: 'r' }), undefined);
    });
});
