/**
 * Tool-impl tests for `ask-copilot-tool.ts` — coverage entry #25.
 *
 * Strategy: in-memory `AnswerFileSink` whose `read()` returns canned
 * payloads on schedule (e.g. "null for the first 3 polls then a JSON
 * answer"), paired with a recording `CopilotChatOpener` and a
 * pure-function `TemplateExpander`.  Plus a pinned `PollClock` so the
 * timeout branch can fire without real sleeping.
 *
 * Coverage entry #25 four-row checklist (askCopilot half):
 *
 *   a) Description clarity — verified in the impl file: template
 *      chain (selected → answer wrapper), polling lifecycle,
 *      JSON-vs-text response formats, fire-and-forget mode.
 *   b) Ambiguities covered:
 *        - JSON answer with `responseValues` triggers the callback
 *        - plain-text answer (non-JSON) returns format: 'text'
 *        - timeout returns ok:false with `timedOut: true` (not
 *          flattened into the response string like the old impl)
 *        - clear() runs BEFORE open() so a stale file can't be read
 *        - waitForAnswer: false returns immediately with the path
 *   c) Tests via fake sink + fake opener (the b-row asked for
 *      `vscode.commands` + fs stubbing).
 *   d) Timing — pinned clock avoids real polls; sub-ms per test.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import {
    askCopilotImpl,
    type AskCopilotDeps,
    type CopilotConfigSnapshot,
    type CopilotChatOpener,
    type AnswerFileSink,
    type TemplateExpander,
    type PollClock,
} from '../ask-copilot-tool.js';

// ===========================================================================
// Fakes
// ===========================================================================

function makeOpener(): CopilotChatOpener & { calls: string[]; throwNext?: Error } {
    const fake: CopilotChatOpener & { calls: string[]; throwNext?: Error } = {
        calls: [],
        async open(q) {
            if (fake.throwNext) { const e = fake.throwNext; fake.throwNext = undefined; throw e; }
            fake.calls.push(q);
        },
    };
    return fake;
}

interface FakeSink extends AnswerFileSink {
    clearCount: number;
    /** Queue of strings (one per `read()` call); `null` means "not ready yet". */
    queue: Array<string | null>;
    /** Whether the impl called `clear()` BEFORE the first read (it must). */
    clearBeforeFirstRead: boolean;
    /** When set, the next read() throws. */
    throwOnRead?: Error;
}

function makeSink(): FakeSink {
    let firstReadHappened = false;
    const fake: FakeSink = {
        clearCount: 0,
        queue: [],
        clearBeforeFirstRead: false,
        absolutePath() { return '/tmp/fake/answer.json'; },
        clear() {
            fake.clearCount++;
            if (!firstReadHappened) { fake.clearBeforeFirstRead = true; }
        },
        read() {
            firstReadHappened = true;
            if (fake.throwOnRead) { const e = fake.throwOnRead; fake.throwOnRead = undefined; throw e; }
            return fake.queue.length === 0 ? null : fake.queue.shift() ?? null;
        },
    };
    return fake;
}

function makeExpander(): TemplateExpander & { calls: Array<{ template: string; values: { originalPrompt: string } }> } {
    const fake: TemplateExpander & { calls: Array<{ template: string; values: { originalPrompt: string } }> } = {
        calls: [],
        async expand(template, values) {
            fake.calls.push({ template, values });
            // simulate substitution
            return template.replace('${originalPrompt}', values.originalPrompt);
        },
    };
    return fake;
}

function makeClock(initial = 1_000): PollClock & { advance(ms: number): void; setSleepNoop(): void } {
    let t = initial;
    let sleepNoop = false;
    const fake: PollClock & { advance(ms: number): void; setSleepNoop(): void } = {
        now: () => t,
        async sleep(ms) { if (!sleepNoop) { t += ms; } },
        advance: (ms) => { t += ms; },
        setSleepNoop: () => { sleepNoop = true; },
    };
    return fake;
}

function makeConfig(overrides: Partial<CopilotConfigSnapshot> = {}): CopilotConfigSnapshot {
    return {
        enabled: true,
        answerFileTimeoutMs: 1_000,
        pollIntervalMs: 100,
        answerFolder: '_ai/chat_replies',
        answerFilename: 'sess_mach_answer.json',
        selectedTemplateId: '__none__',
        selectedTemplateBody: undefined,
        answerFileTemplate: 'INSTRUCT_COPILOT_TO_DUMP_FILE: ${originalPrompt}',
        ...overrides,
    };
}

function buildDeps(): AskCopilotDeps & {
    sink: FakeSink;
    opener: ReturnType<typeof makeOpener>;
    expander: ReturnType<typeof makeExpander>;
    clock: ReturnType<typeof makeClock>;
    cfg: CopilotConfigSnapshot;
    receivedValues: Array<Record<string, unknown>>;
} {
    const sink = makeSink();
    const opener = makeOpener();
    const expander = makeExpander();
    const clock = makeClock();
    const cfg = makeConfig();
    const receivedValues: Array<Record<string, unknown>> = [];
    return {
        sink,
        opener,
        expander,
        clock,
        cfg,
        receivedValues,
        config: () => cfg,
        onResponseValues: (v) => { receivedValues.push(v); },
    };
}

// ===========================================================================
// `tomAi_askCopilot`
// ===========================================================================

describe('askCopilotImpl', () => {

    test('typical: JSON answer file with response field → format: "json" envelope', async () => {
        const d = buildDeps();
        d.sink.queue = [null, JSON.stringify({ response: 'hello from copilot', requestId: 'req-7' })];
        const raw = await withTiming('tomAi_askCopilot:typical', () =>
            askCopilotImpl(d, { prompt: 'What is 2+2?' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.format, 'json');
        assert.equal(r.response, 'hello from copilot');
        assert.equal(r.requestId, 'req-7');
        // Template chain ran exactly once (no user template, just the wrapper).
        assert.equal(d.expander.calls.length, 1);
        assert.match(d.expander.calls[0].template, /INSTRUCT_COPILOT/);
        // Opener called with expanded prompt.
        assert.equal(d.opener.calls.length, 1);
        assert.match(d.opener.calls[0], /What is 2\+2\?/);
    });

    test('clear() runs BEFORE the first read (no stale-file masquerade)', async () => {
        const d = buildDeps();
        d.sink.queue = [JSON.stringify({ response: 'ok' })];
        await askCopilotImpl(d, { prompt: 'hi' });
        assert.equal(d.sink.clearBeforeFirstRead, true);
        assert.ok(d.sink.clearCount >= 1);
    });

    test('JSON answer with responseValues → onResponseValues callback fires', async () => {
        const d = buildDeps();
        d.sink.queue = [JSON.stringify({
            response: 'done',
            responseValues: { fileName: 'x.ts', mode: 'edit' },
        })];
        await askCopilotImpl(d, { prompt: 'x' });
        assert.equal(d.receivedValues.length, 1);
        assert.deepEqual(d.receivedValues[0], { fileName: 'x.ts', mode: 'edit' });
    });

    test('plain-text answer (non-JSON) → format: "text"', async () => {
        const d = buildDeps();
        d.sink.queue = ['I am not JSON, just text from the chat panel.'];
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.format, 'text');
        assert.match(r.response, /not JSON/);
    });

    test('JSON answer without a `response` field → returns the whole pretty-printed JSON', async () => {
        const d = buildDeps();
        d.sink.queue = [JSON.stringify({ status: 'partial', steps: 2 })];
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.format, 'json');
        assert.match(r.response, /"status": "partial"/);
    });

    test('selected template + wrapper: BOTH templates expanded (inner → wrapper)', async () => {
        const d = buildDeps();
        d.cfg = makeConfig({
            selectedTemplateId: 'code-question',
            selectedTemplateBody: 'CODE_Q: ${originalPrompt}',
        });
        // Override the config function to return the new cfg
        d.config = () => d.cfg;
        d.sink.queue = [JSON.stringify({ response: 'ok' })];
        await askCopilotImpl(d, { prompt: 'why is foo broken?' });
        assert.equal(d.expander.calls.length, 2, 'inner template + wrapper template');
        // Inner expansion first
        assert.match(d.expander.calls[0].template, /CODE_Q/);
        assert.equal(d.expander.calls[0].values.originalPrompt, 'why is foo broken?');
        // Then wrapper, fed the inner result
        assert.match(d.expander.calls[1].template, /INSTRUCT_COPILOT/);
        assert.equal(d.expander.calls[1].values.originalPrompt, 'CODE_Q: why is foo broken?');
    });

    test('selectedTemplateId: "__answer_file__" treated as wrapper-only (no inner template)', async () => {
        const d = buildDeps();
        d.cfg = makeConfig({
            selectedTemplateId: '__answer_file__',
            selectedTemplateBody: 'should-not-be-used',
        });
        d.config = () => d.cfg;
        d.sink.queue = [JSON.stringify({ response: 'ok' })];
        await askCopilotImpl(d, { prompt: 'p' });
        assert.equal(d.expander.calls.length, 1);
    });

    test('waitForAnswer: false → returns immediately with answerFile path, no polling', async () => {
        const d = buildDeps();
        d.sink.queue = [JSON.stringify({ response: 'never reached' })];
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x', waitForAnswer: false }));
        assert.equal(r.ok, true);
        assert.equal(r.waitForAnswer, false);
        assert.equal(r.sent, true);
        assert.equal(r.answerFile, '/tmp/fake/answer.json');
        // Sink not read in fire-and-forget mode
        assert.equal(d.sink.queue.length, 1, 'queue untouched');
    });

    test('timeout: queue stays null until clock exceeds timeoutMs → ok:false, timedOut:true', async () => {
        const d = buildDeps();
        d.cfg = makeConfig({ answerFileTimeoutMs: 250, pollIntervalMs: 100 });
        d.config = () => d.cfg;
        // sink always returns null (Copilot never wrote)
        d.sink.queue = [];
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.ok, false);
        assert.equal(r.timedOut, true);
        assert.equal(r.timeoutMs, 250);
        assert.equal(r.answerFile, '/tmp/fake/answer.json');
    });

    test('opener throws → ok:false, sink was cleared but no polling started', async () => {
        const d = buildDeps();
        d.opener.throwNext = new Error('command not found');
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Error opening Copilot Chat: command not found/);
        assert.ok(d.sink.clearCount >= 1, 'still cleared (idempotent)');
    });

    test('sink.read() throws → ok:false with answerFile path', async () => {
        const d = buildDeps();
        // First poll throws
        d.sink.throwOnRead = new Error('EACCES');
        d.sink.queue = [JSON.stringify({ response: 'never reached' })];
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Error reading answer file: EACCES/);
        assert.equal(r.answerFile, '/tmp/fake/answer.json');
    });

    test('empty prompt rejected; opener NOT invoked', async () => {
        const d = buildDeps();
        const r = JSON.parse(await askCopilotImpl(d, { prompt: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`prompt` is required/);
        assert.equal(d.opener.calls.length, 0);
        assert.equal(d.sink.clearCount, 0);
    });

    test('disabled tool → ok:false with hint, opener NOT invoked', async () => {
        const d = buildDeps();
        d.cfg = makeConfig({ enabled: false });
        d.config = () => d.cfg;
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /disabled/);
        assert.match(r.hint, /status page/);
        assert.equal(d.opener.calls.length, 0);
    });

    test('input.timeoutMs override is respected (overrides config)', async () => {
        const d = buildDeps();
        d.cfg = makeConfig({ answerFileTimeoutMs: 10_000, pollIntervalMs: 100 });
        d.config = () => d.cfg;
        const r = JSON.parse(await askCopilotImpl(d, { prompt: 'x', timeoutMs: 200 }));
        assert.equal(r.ok, false);
        assert.equal(r.timeoutMs, 200);
    });
});
