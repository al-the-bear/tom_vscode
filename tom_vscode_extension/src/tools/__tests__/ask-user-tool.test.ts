/**
 * Tool-impl tests for `ask-user-tool.ts` — the blocking, multi-question
 * `tomAi_askUser` tool.
 *
 * The impl is `vscode`-free: it takes a narrow {@link AskUserDeps} (config +
 * registry + the two UI callbacks). Here we drive it with a real
 * {@link AskUserRegistry} wired to a controllable timer seam (so we can read
 * the requested timeout and fire it) plus a stub `loadConfig` and spy
 * callbacks. Coverage:
 *
 *   - input validation (empty / whitespace-only / over-limit questions),
 *   - the verbatim answer round-trip (vscode + timeout),
 *   - the deadline: none by default, the configured `maxWaitMinutes` as a
 *     ceiling, and the model's per-call `timeoutMinutes` as a request,
 *   - the questions journal written on every resolution,
 *   - title trimming, and
 *   - the already-pending error (the singleton guard surfaced as a string).
 *
 * `ask-user-tool.ts` transitively imports `vscode` (via `shared-tool-registry`),
 * so the shared stub is installed before the module import.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    askUserImpl,
    MAX_ASK_USER_QUESTIONS,
    ASK_USER_TOOL,
    type AskUserDeps,
} from '../ask-user-tool.js';
import { AskUserRegistry, type PendingAsk, type AskAnswerSource } from '../../services/askUserRegistry.js';
import type { ChatQuestionsConfig } from '../../handlers/chatQuestions-config.js';
import type { QuestionLogEntry } from '../../utils/questionsLogFormat.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ArmedTimer { ms: number; cb: () => void; cleared: boolean; }

interface Harness {
    deps: AskUserDeps;
    timers: ArmedTimer[];
    opens: PendingAsk[];
    resolves: Array<{ source: AskAnswerSource; answer: string }>;
    logged: QuestionLogEntry[];
    /** Advance the injected clock, so `answeredAt - askedAt` is assertable. */
    tick(ms: number): void;
    submitLatest(answer: string, source: 'vscode' | 'telegram'): boolean;
    fireLatestTimer(): void;
}

/**
 * Note the `maxWaitMinutes ?? 0` default: 0 is the shipped default and means
 * "no ceiling", so the *unconfigured* harness exercises the infinite wait —
 * the behaviour a queued prompt gets out of the box.
 */
function makeHarness(cfg: Partial<ChatQuestionsConfig> = {}): Harness {
    const timers: ArmedTimer[] = [];
    const opens: PendingAsk[] = [];
    const resolves: Array<{ source: AskAnswerSource; answer: string }> = [];
    const logged: QuestionLogEntry[] = [];
    let clock = 1_000_000;
    const registry = new AskUserRegistry({
        setTimer: (ms, cb) => {
            const handle = { ms, cb, cleared: false };
            timers.push(handle);
            return handle as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (handle) => { (handle as unknown as ArmedTimer).cleared = true; },
        genId: () => 'req-1',
        now: () => clock,
    });
    const config: ChatQuestionsConfig = {
        maxWaitMinutes: cfg.maxWaitMinutes ?? 0,
        fallbackPrompt: cfg.fallbackPrompt ?? 'FALLBACK',
    };
    return {
        timers,
        opens,
        resolves,
        logged,
        tick(ms) { clock += ms; },
        deps: {
            registry,
            loadConfig: () => config,
            onOpen: (p) => opens.push(p),
            onResolve: (_p, source, answer) => resolves.push({ source, answer }),
            log: (entry) => logged.push(entry),
            now: () => clock,
        },
        submitLatest(answer, source) {
            const pending = registry.getPending();
            assert.ok(pending, 'expected a pending ask to submit to');
            return registry.submit(pending.requestId, answer, source);
        },
        fireLatestTimer() {
            const live = [...timers].reverse().find((t) => !t.cleared);
            assert.ok(live, 'expected a live timer');
            live.cb();
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('askUserImpl', () => {

    test('valid ask → blocks, opens, then resolves verbatim on vscode submit', async () => {
        const h = makeHarness({ maxWaitMinutes: 15 });
        const call = askUserImpl(h.deps, { questions: ['Pick A or B?', 'Why?'], title: 'Decision' });
        // The ask is open and blocking — onOpen fired, promise still pending.
        assert.equal(h.opens.length, 1);
        assert.deepEqual(h.opens[0].questions, ['Pick A or B?', 'Why?']);
        assert.equal(h.opens[0].title, 'Decision');
        assert.equal(h.deps.registry.hasPending(), true);
        // timeoutMs = 15 min.
        assert.equal(h.timers[0].ms, 15 * 60_000);
        // The user answers; the tool result is the textarea text verbatim.
        assert.equal(h.submitLatest('1. A\n2. cheaper', 'vscode'), true);
        const result = await withTiming('tomAi_askUser:typical', () => call);
        assert.equal(result, '1. A\n2. cheaper');
        assert.equal(h.resolves[0].source, 'vscode');
    });

    test('telegram answer is returned verbatim', async () => {
        const h = makeHarness();
        const call = askUserImpl(h.deps, { questions: ['Ready?'] });
        assert.equal(h.submitLatest('go ahead', 'telegram'), true);
        assert.equal(await call, 'go ahead');
    });

    test('timeout resolves with the configured fallback prompt', async () => {
        const h = makeHarness({ maxWaitMinutes: 5, fallbackPrompt: 'no reply — use your judgement' });
        const call = askUserImpl(h.deps, { questions: ['Anything?'] });
        h.fireLatestTimer();
        assert.equal(await call, 'no reply — use your judgement');
        assert.equal(h.resolves[0].source, 'timeout');
    });

    test('no ceiling and no per-call timeout → no timer is armed at all', async () => {
        // This is the shipped default and the whole point of the feature: a
        // question the user has not read yet must not answer itself, however
        // long a queued prompt has to sit and wait for them.
        const h = makeHarness({ maxWaitMinutes: 0 });
        const call = askUserImpl(h.deps, { questions: ['Q?'] });
        assert.equal(h.timers.length, 0);
        assert.equal(h.opens[0].timeoutAt, undefined, 'the webview must render no countdown');
        h.submitLatest('x', 'vscode');
        await call;
    });

    test('fractional maxWaitMinutes is floored', async () => {
        const h = makeHarness({ maxWaitMinutes: 2.9 });
        const call = askUserImpl(h.deps, { questions: ['Q?'] });
        assert.equal(h.timers[0].ms, 2 * 60_000);
        h.submitLatest('x', 'vscode');
        await call;
    });

    test('per-call timeoutMinutes arms a timer even when there is no ceiling', async () => {
        const h = makeHarness({ maxWaitMinutes: 0 });
        const call = askUserImpl(h.deps, { questions: ['Q?'], timeoutMinutes: 3 });
        assert.equal(h.timers[0].ms, 3 * 60_000);
        h.submitLatest('x', 'vscode');
        await call;
    });

    test('per-call timeoutMinutes is capped by the configured ceiling', async () => {
        // The setting is the *user's* ceiling — the model may ask for less
        // time than the user allows, never for more.
        const h = makeHarness({ maxWaitMinutes: 10 });
        const call = askUserImpl(h.deps, { questions: ['Q?'], timeoutMinutes: 60 });
        assert.equal(h.timers[0].ms, 10 * 60_000);
        h.submitLatest('x', 'vscode');
        await call;
    });

    test('a shorter per-call timeoutMinutes wins over a longer ceiling', async () => {
        const h = makeHarness({ maxWaitMinutes: 60 });
        const call = askUserImpl(h.deps, { questions: ['Q?'], timeoutMinutes: 2 });
        assert.equal(h.timers[0].ms, 2 * 60_000);
        h.submitLatest('x', 'vscode');
        await call;
    });

    test('a per-call timeout fires with the configured fallback prompt', async () => {
        const h = makeHarness({ maxWaitMinutes: 0, fallbackPrompt: 'carry on' });
        const call = askUserImpl(h.deps, { questions: ['Q?'], timeoutMinutes: 1 });
        h.fireLatestTimer();
        assert.equal(await call, 'carry on');
        assert.equal(h.resolves[0].source, 'timeout');
    });

    test('whitespace-only questions are dropped; blank title becomes undefined', async () => {
        const h = makeHarness();
        const call = askUserImpl(h.deps, { questions: ['  keep me ', '   ', ''], title: '   ' });
        assert.deepEqual(h.opens[0].questions, ['keep me']);
        assert.equal(h.opens[0].title, undefined);
        h.submitLatest('done', 'vscode');
        await call;
    });

    test('empty questions array → error string, nothing opened', async () => {
        const h = makeHarness();
        const r = await askUserImpl(h.deps, { questions: [] });
        assert.match(r, /at least one non-empty question/);
        assert.equal(h.opens.length, 0);
        assert.equal(h.deps.registry.hasPending(), false);
    });

    test('all-whitespace questions → error string', async () => {
        const h = makeHarness();
        const r = await askUserImpl(h.deps, { questions: ['  ', '\t', ''] });
        assert.match(r, /at least one non-empty question/);
        assert.equal(h.opens.length, 0);
    });

    test('too many questions → error string naming the limit', async () => {
        const h = makeHarness();
        const tooMany = Array.from({ length: MAX_ASK_USER_QUESTIONS + 1 }, (_, i) => `Q${i}`);
        const r = await askUserImpl(h.deps, { questions: tooMany });
        assert.match(r, new RegExp(`maximum is ${MAX_ASK_USER_QUESTIONS}`));
        assert.equal(h.opens.length, 0);
    });

    test('exactly MAX questions is allowed', async () => {
        const h = makeHarness();
        const max = Array.from({ length: MAX_ASK_USER_QUESTIONS }, (_, i) => `Q${i}`);
        const call = askUserImpl(h.deps, { questions: max });
        assert.equal(h.opens.length, 1);
        assert.equal(h.opens[0].questions.length, MAX_ASK_USER_QUESTIONS);
        h.submitLatest('ok', 'vscode');
        await call;
    });

    test('second ask while one is pending → already-pending error string', async () => {
        const h = makeHarness();
        const first = askUserImpl(h.deps, { questions: ['First?'] });
        const second = await askUserImpl(h.deps, { questions: ['Second?'] });
        assert.match(second, /askUser error:.*already pending/);
        // The first ask is untouched and still resolvable.
        h.submitLatest('answer-1', 'vscode');
        assert.equal(await first, 'answer-1');
    });
});

describe('askUserImpl — questions journal', () => {

    test('an answered ask is journalled with questions, answer, source and timings', async () => {
        const h = makeHarness();
        const askedAt = h.deps.now!();
        const call = askUserImpl(h.deps, { questions: ['Pick A or B?', 'Why?'], title: 'Decision' });
        h.tick(90_000);
        h.submitLatest('1. A\n2. cheaper', 'vscode');
        await call;

        assert.equal(h.logged.length, 1);
        const entry = h.logged[0];
        assert.equal(entry.tool, 'tomAi_askUser');
        assert.equal(entry.title, 'Decision');
        assert.deepEqual([...entry.questions], ['Pick A or B?', 'Why?']);
        assert.equal(entry.answer, '1. A\n2. cheaper');
        assert.equal(entry.source, 'vscode');
        assert.equal(entry.askedAt, askedAt);
        assert.equal(entry.answeredAt, askedAt + 90_000);
    });

    test('a telegram answer is journalled with its own source', async () => {
        const h = makeHarness();
        const call = askUserImpl(h.deps, { questions: ['Ready?'] });
        h.submitLatest('go ahead', 'telegram');
        await call;
        assert.equal(h.logged[0].source, 'telegram');
        assert.equal(h.logged[0].title, undefined);
    });

    test('a timeout is journalled too — the fallback the model got is the record', async () => {
        const h = makeHarness({ maxWaitMinutes: 5, fallbackPrompt: 'FB' });
        const call = askUserImpl(h.deps, { questions: ['Anything?'] });
        h.fireLatestTimer();
        await call;
        assert.equal(h.logged.length, 1);
        assert.equal(h.logged[0].source, 'timeout');
        assert.equal(h.logged[0].answer, 'FB');
    });

    test('the journal never displaces the UI callback — both run', async () => {
        const h = makeHarness();
        const call = askUserImpl(h.deps, { questions: ['Q?'] });
        h.submitLatest('a', 'vscode');
        await call;
        assert.equal(h.resolves.length, 1, 'onResolve must still dismiss the webview');
        assert.equal(h.logged.length, 1);
    });

    test('a journal failure does not break the ask', async () => {
        // The log is diagnostics. Losing it must never cost the user their
        // answer or leave the queue blocked on a thrown callback.
        const h = makeHarness();
        h.deps.log = () => { throw new Error('disk full'); };
        const call = askUserImpl(h.deps, { questions: ['Q?'] });
        h.submitLatest('still mine', 'vscode');
        assert.equal(await call, 'still mine');
        assert.equal(h.resolves.length, 1);
    });

    test('a rejected ask is not journalled', async () => {
        const h = makeHarness();
        await askUserImpl(h.deps, { questions: ['  '] });
        assert.equal(h.logged.length, 0);
    });
});

describe('ASK_USER_TOOL definition', () => {

    test('name, tags and schema match the contract', () => {
        assert.equal(ASK_USER_TOOL.name, 'tomAi_askUser');
        assert.ok(ASK_USER_TOOL.tags.includes('telegram'));
        assert.ok(ASK_USER_TOOL.tags.includes('interactive'));
        assert.deepEqual(ASK_USER_TOOL.inputSchema.required, ['questions']);
        const q = (ASK_USER_TOOL.inputSchema.properties as Record<string, { maxItems?: number; minItems?: number }>).questions;
        assert.equal(q.minItems, 1);
        assert.equal(q.maxItems, MAX_ASK_USER_QUESTIONS);
    });

    test('timeoutMinutes is an optional number the model may set per call', () => {
        const props = ASK_USER_TOOL.inputSchema.properties as Record<string, { type?: string }>;
        assert.equal(props.timeoutMinutes?.type, 'number');
        assert.ok(!(ASK_USER_TOOL.inputSchema.required as string[]).includes('timeoutMinutes'));
    });

    test('the description tells the model waiting is open-ended by default', () => {
        assert.match(ASK_USER_TOOL.description, /timeoutMinutes/);
        assert.match(ASK_USER_TOOL.description, /indefinitely|forever|no deadline/i);
    });

    test('placeholder execute returns an error until the live bridge installs the real one', async () => {
        const r = await ASK_USER_TOOL.execute({ questions: ['x'] });
        assert.match(r, /must be installed by the live bridge/);
    });
});
