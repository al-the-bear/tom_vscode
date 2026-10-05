/**
 * Tests for the Agent SDK query input channel — when the extension may close
 * the CLI's stdin.
 *
 * Why this matters: the CLI reaches the extension's in-process MCP server
 * (every `tomAi_*` tool) over control messages whose RESPONSES travel back on
 * the CLI's stdin. With a string prompt the SDK closes stdin at the query's
 * first `result`, and two things make the CLI keep working after that:
 *
 *   - a background agent finishing → a continuation turn in the same process;
 *   - on resume, an orphan-summary notification about the previous process's
 *     background tasks, run as its own turn BEFORE the prompt (its stale
 *     result closed stdin before the prompt had started).
 *
 * Every `tomAi_*` call in such a turn failed in milliseconds with "The tool
 * call was interrupted before a result was received" (reproduced live with
 * SDK 0.3.282; 292 calls in the mbp transcripts). The channel therefore stays
 * open until the CLI reports `idle` after a result that answers OUR message.
 *
 * Coverage (IC-*):
 *   IC-1  messages() yields one user message carrying the channel's uuid.
 *   IC-2  a result answering our uuid, then idle → closes.
 *   IC-3  an idle after a result that does not answer us (orphan turn) does
 *         not close while the CLI starts running again.
 *   IC-4  a background continuation: result, more work, idle → closes only at idle.
 *   IC-5  an unanswered idle with nothing following closes after the grace period.
 *   IC-6  a CLI that emits no session-state events → closes at the answering result.
 *   IC-7  close() is idempotent, records the first reason and ends messages().
 *   IC-8  isChannelDeadToolResult recognises the SDK's interrupted-call text only.
 *   IC-9  a result with user_message_uuid (singular) also answers.
 *   IC-10 the transport uses the channel: stream prompt, env flag, observe, close.
 *
 * Background tasks that outlive the model's turn (BG-*): a background Bash
 * does not hold the turn open, so the CLI goes idle while it runs; closing
 * there dropped its result. The channel now waits, up to a cap, and at the
 * cap keeps waiting only while a task still shows progress.
 *   BG-1  idle after the answer with a live task waits; it closes at the idle
 *         after the follow-up turn, and reports the wait once.
 *   BG-2  ambient tasks (watchers) do not hold the channel open.
 *   BG-3  tasks finishing while idle with no follow-up turn → closes after grace.
 *   BG-4  the cap with no progress closes and names the abandoned task.
 *   BG-5  task_progress since the last check extends the wait by one cap.
 *   BG-6  a grown output file (path parsed from the Bash tool result) extends it.
 *   BG-7  backgroundWaitMs 0 keeps the old rule and reports what it abandons.
 *   BG-8  background_tasks_changed replaces the set; it is not merged.
 *   BG-9  describeInputChannelEvent says what is waited for, for how long,
 *         and that an abandoned task's result will not arrive.
 *   BG-10 the transport passes the configured cap, an output-size probe and
 *         the event reporter to the channel, and asks for no-op when unset.
 *
 * Pure module — no `vscode`, no SDK — so it runs directly under `node --test`.
 */

// The SDK's message fields are its snake_case wire format and cannot be renamed.
/* eslint-disable @typescript-eslint/naming-convention */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    QueryInputChannel,
    isChannelDeadToolResult,
    describeInputChannelEvent,
    outputFileSize,
    SESSION_STATE_EVENTS_ENV,
} from '../agent-sdk-input-channel';

const UUID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

const running = { type: 'system', subtype: 'session_state_changed', state: 'running' };
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
const resultFor = (uuids?: string[]) => ({
    type: 'result',
    subtype: 'success',
    ...(uuids ? { user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids } : {}),
});
const assistant = { type: 'assistant', message: { content: [] } };

async function firstMessage(ch: QueryInputChannel) {
    const it = ch.messages()[Symbol.asyncIterator]();
    const first = await it.next();
    return { it, first };
}

describe('QueryInputChannel', () => {
    test('IC-1: yields one user message carrying the channel uuid', async () => {
        const ch = new QueryInputChannel('hello', { uuid: UUID });
        const { it, first } = await firstMessage(ch);
        assert.equal(first.done, false);
        assert.deepEqual(first.value, {
            type: 'user',
            uuid: UUID,
            message: { role: 'user', content: 'hello' },
            parent_tool_use_id: null,
            session_id: '',
        });
        ch.close('test');
        assert.equal((await it.next()).done, true);
    });

    test('IC-2: a result answering our uuid, then idle → closes', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID });
        ch.observe(running);
        ch.observe(assistant);
        ch.observe(resultFor([UUID]));
        assert.equal(ch.closed, false, 'the result alone must not close: the CLI may still continue');
        ch.observe(idle);
        assert.equal(ch.closed, true);
        assert.equal(ch.closeReason, 'idle-after-answer');
    });

    test('IC-3: the orphan turn on resume does not close the channel', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, graceMs: 50 });
        ch.observe(running);
        ch.observe(resultFor()); // orphan-summary turn: no client uuid
        ch.observe(idle);
        ch.observe(running); // our prompt starts
        assert.equal(ch.closed, false);
        ch.observe(resultFor([OTHER])); // some other message's result
        ch.observe(idle);
        ch.observe(running);
        assert.equal(ch.closed, false);
        ch.observe(resultFor([OTHER, UUID]));
        ch.observe(idle);
        assert.equal(ch.closed, true);
        assert.equal(ch.closeReason, 'idle-after-answer');
    });

    test('IC-4: a background continuation keeps the channel open until idle', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID });
        ch.observe(running);
        ch.observe(resultFor([UUID])); // the model ended its turn: "WAITING"
        ch.observe(assistant); // background agent finished → continuation turn
        ch.observe(resultFor()); // continuation's result (meta turn, no uuid)
        assert.equal(ch.closed, false);
        ch.observe(idle);
        assert.equal(ch.closed, true);
    });

    test('IC-5: an unanswered idle with nothing following closes after the grace period', async () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, graceMs: 20 });
        ch.observe(running);
        ch.observe(resultFor()); // a CLI that never stamps uuids
        ch.observe(idle);
        assert.equal(ch.closed, false);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(ch.closed, true);
        assert.equal(ch.closeReason, 'idle-unanswered-timeout');
    });

    test('IC-5b: running after an unanswered idle cancels the grace timer', async () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, graceMs: 20 });
        ch.observe(running);
        ch.observe(idle);
        ch.observe(running);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(ch.closed, false);
        ch.close('test');
    });

    test('IC-6: without session-state events it closes at the answering result', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID });
        ch.observe(assistant);
        ch.observe(resultFor([UUID]));
        assert.equal(ch.closed, true);
        assert.equal(ch.closeReason, 'result-without-session-state');
    });

    test('IC-7: close() is idempotent, keeps the first reason and ends messages()', async () => {
        const ch = new QueryInputChannel('p', { uuid: UUID });
        const { it } = await firstMessage(ch);
        const next = it.next();
        ch.close('cancelled');
        ch.close('later');
        assert.equal(ch.closeReason, 'cancelled');
        assert.equal((await next).done, true);
        ch.observe(idle); // observing after close is harmless
        assert.equal(ch.closeReason, 'cancelled');
    });

    test('IC-9: a singular user_message_uuid also answers', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID });
        ch.observe(running);
        ch.observe({ type: 'result', subtype: 'success', user_message_uuid: UUID });
        ch.observe(idle);
        assert.equal(ch.closed, true);
    });

    test('a generated uuid is a v4 UUID', () => {
        const ch = new QueryInputChannel('p');
        assert.match(ch.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        ch.close('test');
    });
});

describe('isChannelDeadToolResult (IC-8)', () => {
    test('matches the SDK interrupted-call text', () => {
        assert.equal(isChannelDeadToolResult(
            'The tool call was interrupted before a result was received. It may or may not have completed on the server — verify before assuming it did.',
        ), true);
    });
    test('does not match a long result that merely quotes it', () => {
        const quoted = `log excerpt:\n${'x'.repeat(600)}\nThe tool call was interrupted before a result was received.`;
        assert.equal(isChannelDeadToolResult(quoted), false);
    });
    test('does not match ordinary results', () => {
        assert.equal(isChannelDeadToolResult('{"ok":true}'), false);
        assert.equal(isChannelDeadToolResult(''), false);
    });
});

describe('agent-sdk-transport wiring (IC-10)', () => {
    // out/services/__tests__ -> project root is three levels up.
    const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'agent-sdk-transport.ts'), 'utf-8');

    test('the query prompt is the channel stream, never the raw text', () => {
        assert.match(src, /sdk\.query\(\{\s*prompt:\s*input\.messages\(\)/);
    });
    test('the CLI is asked to emit session-state events', () => {
        assert.match(src, /env:\s*\{\s*\.\.\.process\.env,\s*\[SESSION_STATE_EVENTS_ENV\]:\s*'1'\s*\}/);
        assert.equal(SESSION_STATE_EVENTS_ENV, 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS');
    });
    test('every stream message is observed, and the channel closes on cancel and at the end', () => {
        assert.match(src, /input\.observe\(msg\)/);
        assert.match(src, /input\.close\('cancelled'\)/);
        assert.match(src, /finally\s*\{\s*input\.close\('stream-ended'\)/);
    });
});

describe('QueryInputChannel — background tasks outliving the turn (BG-*)', () => {
    const bgChanged = (tasks: { task_id: string; task_type?: string; description?: string; ambient?: boolean }[]) => ({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: tasks.map((t) => ({ task_type: 'local_bash', description: `task ${t.task_id}`, ...t })),
    });
    const bashStarted = (taskId: string, path: string) => ({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu', // The Bash tool's wording, verbatim, sentence-final period included
        // (SDK 0.3.282): the path must not take that period with it.
        content: `Command running in background with ID: ${taskId}. Output is being written to: ${path}.` }] },
    });
    const progress = (taskId: string, toolUses: number) => ({
        type: 'system', subtype: 'task_progress', task_id: taskId, description: 'd', usage: { total_tokens: 1, tool_uses: toolUses, duration_ms: 1 },
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Ev = { kind: string; tasks?: { taskId: string; outputFile?: string }[] };

    /** Our turn: running, a background Bash started, our result, idle. */
    function turnWithBackgroundBash(ch: QueryInputChannel, taskId = 'b1', path = '/tmp/tasks/b1.output') {
        ch.observe(running);
        ch.observe(bgChanged([{ task_id: taskId }]));
        ch.observe(bashStarted(taskId, path));
        ch.observe(resultFor([UUID]));
        ch.observe(idle);
    }

    test('BG-1: waits at idle while a task is live, closes after the follow-up turn', () => {
        const events: Ev[] = [];
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 60_000, onEvent: (e) => events.push(e) });
        turnWithBackgroundBash(ch);
        assert.equal(ch.closed, false, 'a live background task must keep stdin open');
        ch.observe(bgChanged([]));
        ch.observe(running); // the CLI runs the follow-up turn on the notification
        ch.observe(resultFor());
        ch.observe(idle);
        assert.equal(ch.closed, true);
        assert.equal(ch.closeReason, 'idle-after-answer');
        assert.deepEqual(events.map((e) => e.kind), ['waiting']);
        assert.deepEqual(events[0].tasks?.map((t) => [t.taskId, t.outputFile]), [['b1', '/tmp/tasks/b1.output']]);
    });

    test('BG-2: ambient tasks do not hold the channel open', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 60_000 });
        ch.observe(running);
        ch.observe(bgChanged([{ task_id: 'w1', task_type: 'monitor', ambient: true }]));
        ch.observe(resultFor([UUID]));
        ch.observe(idle);
        assert.equal(ch.closed, true);
    });

    test('BG-3: tasks finishing while idle with no follow-up turn close after the grace period', async () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 60_000, graceMs: 20 });
        turnWithBackgroundBash(ch);
        ch.observe(bgChanged([]));
        assert.equal(ch.closed, false);
        await wait(60);
        assert.equal(ch.closeReason, 'background-done');
    });

    test('BG-4: the cap with no progress closes and names the abandoned task', async () => {
        const events: Ev[] = [];
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 30, onEvent: (e) => events.push(e) });
        turnWithBackgroundBash(ch);
        await wait(80);
        assert.equal(ch.closeReason, 'background-wait-capped');
        assert.deepEqual(events.map((e) => e.kind), ['waiting', 'capped']);
        assert.deepEqual(events[1].tasks?.map((t) => t.taskId), ['b1']);
    });

    test('BG-5: task_progress since the last check extends the wait by one cap', async () => {
        const events: Ev[] = [];
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 40, onEvent: (e) => events.push(e) });
        turnWithBackgroundBash(ch, 'a1');
        ch.observe(progress('a1', 3));
        await wait(55); // first cap: progress seen → extended
        assert.equal(ch.closed, false);
        await wait(60); // second cap: nothing new → capped
        assert.equal(ch.closeReason, 'background-wait-capped');
        assert.deepEqual(events.map((e) => e.kind), ['waiting', 'extended', 'capped']);
    });

    test('BG-6: a grown output file extends the wait', async () => {
        const sizes = new Map<string, number>([['/tmp/tasks/b1.output', 10]]);
        const events: Ev[] = [];
        const ch = new QueryInputChannel('p', {
            uuid: UUID,
            backgroundWaitMs: 40,
            progressOf: (t) => (t.outputFile ? sizes.get(t.outputFile) : undefined),
            onEvent: (e) => events.push(e),
        });
        turnWithBackgroundBash(ch);
        sizes.set('/tmp/tasks/b1.output', 250); // the command printed more
        await wait(55);
        assert.equal(ch.closed, false);
        assert.deepEqual(events.map((e) => e.kind), ['waiting', 'extended']);
        ch.close('test');
    });

    test('BG-7: backgroundWaitMs 0 keeps the old rule and reports what it abandons', () => {
        const events: Ev[] = [];
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 0, onEvent: (e) => events.push(e) });
        turnWithBackgroundBash(ch);
        assert.equal(ch.closeReason, 'idle-after-answer');
        assert.deepEqual(events.map((e) => e.kind), ['abandoned']);
        assert.deepEqual(events[0].tasks?.map((t) => t.taskId), ['b1']);
    });

    test('BG-8: background_tasks_changed replaces the set', () => {
        const ch = new QueryInputChannel('p', { uuid: UUID, backgroundWaitMs: 60_000 });
        ch.observe(running);
        ch.observe(bgChanged([{ task_id: 'b1' }, { task_id: 'b2' }]));
        ch.observe(bgChanged([{ task_id: 'b2' }]));
        assert.deepEqual(ch.liveBackgroundTasks().map((t) => t.taskId), ['b2']);
        ch.observe(bgChanged([]));
        ch.observe(resultFor([UUID]));
        ch.observe(idle);
        assert.equal(ch.closed, true);
    });
});

describe('describeInputChannelEvent (BG-9)', () => {
    const task = { taskId: 'b1', taskType: 'local_bash', description: 'run the suites' };
    test('waiting names the tasks and the cap', () => {
        const text = describeInputChannelEvent({ kind: 'waiting', tasks: [task], capMs: 30 * 60_000 });
        assert.match(text, /Waiting for 1 background task/);
        assert.match(text, /run the suites \[b1\]/);
        assert.match(text, /30 min/);
    });
    test('extended names what progressed', () => {
        const text = describeInputChannelEvent({ kind: 'extended', tasks: [task], progressed: [task], capMs: 5 * 60_000 });
        assert.match(text, /still progressing/);
        assert.match(text, /another 5 min/);
    });
    test('capped and abandoned say the result will not be delivered', () => {
        assert.match(describeInputChannelEvent({ kind: 'capped', tasks: [task] }), /no progress.*will not be delivered/s);
        assert.match(describeInputChannelEvent({ kind: 'abandoned', tasks: [task, { ...task, taskId: 'b2' }] }), /2 background tasks.*will not be delivered/s);
    });
});

describe('agent-sdk-transport background-wait wiring (BG-10)', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'handlers', 'agent-sdk-transport.ts'), 'utf-8');
    test('the configured cap is passed in milliseconds', () => {
        assert.match(src, /maxBackgroundWaitMinutes/);
        assert.match(src, /backgroundWaitMs:/);
    });
    test('progress is probed through the output file size', () => {
        assert.match(src, /progressOf:\s*outputFileSize/);
        const dir = mkdtempSync(join(tmpdir(), 'qr9-probe-'));
        const file = join(dir, 'b1.output');
        writeFileSync(file, 'tick 1\n');
        const task = { taskId: 'b1', taskType: 'local_bash', description: 'd', outputFile: file };
        assert.equal(outputFileSize(task), 7);
        assert.equal(outputFileSize({ ...task, outputFile: join(dir, 'missing') }), undefined);
        assert.equal(outputFileSize({ ...task, outputFile: undefined }), undefined);
    });
    test('each event reaches the tool log and the live trail', () => {
        assert.match(src, /onEvent:/);
        assert.match(src, /describeInputChannelEvent\(/);
        assert.match(src, /appendNotice\(/);
    });
});
