/**
 * Tests for the LiveTrailWriter `appendRetry` entry — the observability
 * feature that surfaces transient-failure retries in the quest live-trail so
 * the user can see an error occurred and is being ridden out without opening
 * the Tom Tool Log.
 *
 * Coverage:
 *   - appendRetry writes a `### 🔁 retry` heading with the status line.
 *   - The triggering cause is rendered in a fenced block when supplied.
 *   - A retry is written INSIDE the current prompt block and does NOT close it
 *     (no DONE / ERROR marker), so subsequent thinking/text reopen a heading.
 *   - The matching `{ kind: 'retry', message, cause }` event is emitted.
 *   - An empty message is a no-op.
 *
 * `LiveTrailWriter` requires `vscode` + a workspace folder to resolve the
 * `_ai/quests/<quest>/live-trail.md` path, so the shared vscode stub is
 * installed against a temp workspace root before importing the module.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-trail-'));

installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import {
    LiveTrailWriter,
    formatLiveTrailUsage,
    formatPromptHeaderTimestamp,
    type LiveTrailEvent,
} from '../live-trail.js';

/**
 * Fixed "recorded at" instant for the usage tests. `formatLiveTrailUsage`
 * takes the time as an argument rather than reading the clock, so every
 * assertion below is deterministic.
 */
const AT = new Date(2026, 7, 4, 9, 5, 3);

function newWriter(quest: string): LiveTrailWriter {
    const w = new LiveTrailWriter(quest);
    // Start a clean block so the retry has a prompt to attach to.
    w.beginPrompt({ transport: 'agentSdk', config: 'default', userText: 'do a thing' });
    return w;
}

describe('LiveTrailWriter.appendRetry', () => {
    let quest: string;
    beforeEach(() => {
        // Unique quest per test so the 5-block trimming / leftover files of
        // one test never bleed into the next.
        quest = `q_${Math.random().toString(36).slice(2)}`;
    });

    it('writes a 🔁 retry heading with the status line', () => {
        const w = newWriter(quest);
        w.appendRetry('Anthropic API busy — retrying in 4s (attempt 2)');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(body, /### 🔁 retry/);
        assert.match(body, /Anthropic API busy — retrying in 4s \(attempt 2\)/);
    });

    it('renders the triggering cause in a fenced block when supplied', () => {
        const w = newWriter(quest);
        w.appendRetry('Backend busy — retrying in 8s', 'API Error: 529 overloaded');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(body, /```text\nAPI Error: 529 overloaded\n```/);
    });

    it('does not close the prompt block (no DONE / ERROR marker)', () => {
        const w = newWriter(quest);
        w.appendRetry('retrying', 'boom');
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.doesNotMatch(body, /### ✅ DONE/);
        assert.doesNotMatch(body, /### ⚠️ ERROR/);
        // A turn that continues after the retry reopens a fresh heading.
        w.appendAssistantText('continuing after the retry');
        const after = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(after, /### 💬 assistant\n\ncontinuing after the retry/);
    });

    it('emits a retry event carrying message + cause', () => {
        const events: LiveTrailEvent[] = [];
        const sub = LiveTrailWriter.addObserver((e) => events.push(e));
        try {
            const w = newWriter(quest);
            w.appendRetry('retrying soon', 'HTTP 500 Internal server error');
            const retry = events.find((e) => e.kind === 'retry');
            assert.ok(retry, 'expected a retry event');
            assert.equal(retry.kind === 'retry' && retry.message, 'retrying soon');
            assert.equal(retry.kind === 'retry' && retry.cause, 'HTTP 500 Internal server error');
            assert.equal(retry.questId, quest);
            // beginPrompt stamps source 'chat' by default.
            assert.equal(retry.source, 'chat');
        } finally {
            sub.dispose();
        }
    });

    it('is a no-op for an empty message', () => {
        const w = newWriter(quest);
        const before = fs.readFileSync(w.getFilePath(), 'utf-8');
        w.appendRetry('');
        const after = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.equal(after, before);
    });
});

describe('LiveTrailWriter.appendNotice', () => {
    let quest: string;
    beforeEach(() => {
        quest = `q_${Math.random().toString(36).slice(2)}`;
    });

    it('writes a ⏳ notice inside the prompt block and emits a notice event', () => {
        const events: LiveTrailEvent[] = [];
        const sub = LiveTrailWriter.addObserver((e) => events.push(e));
        try {
            const w = newWriter(quest);
            w.appendNotice('Waiting for 1 background task: run the suites');
            const body = fs.readFileSync(w.getFilePath(), 'utf-8');
            assert.match(body, /### ⏳ notice\n\nWaiting for 1 background task: run the suites/);
            assert.doesNotMatch(body, /### ✅ DONE/);
            const notice = events.find((e) => e.kind === 'notice');
            assert.equal(notice?.kind === 'notice' && notice.message, 'Waiting for 1 background task: run the suites');
        } finally {
            sub.dispose();
        }
    });

    it('is a no-op for an empty message', () => {
        const w = newWriter(quest);
        const before = fs.readFileSync(w.getFilePath(), 'utf-8');
        w.appendNotice('');
        assert.equal(fs.readFileSync(w.getFilePath(), 'utf-8'), before);
    });
});

describe('formatLiveTrailUsage', () => {
    it('renders the aggregate token counts', () => {
        const md = formatLiveTrailUsage({
            totals: {
                inputTokens: 1234,
                outputTokens: 567,
                cacheReadInputTokens: 8901,
                cacheCreationInputTokens: 42,
            },
        }, AT);
        assert.match(md, /### 📊 usage/);
        assert.match(md, /in 1,234/);
        assert.match(md, /out 567/);
        assert.match(md, /cache read 8,901/);
        assert.match(md, /cache write 42/);
    });

    it('renders one table row per model with its own cost', () => {
        const md = formatLiveTrailUsage({
            models: [
                {
                    model: 'claude-opus-4-7',
                    inputTokens: 100,
                    outputTokens: 20,
                    cacheReadInputTokens: 3000,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.0421,
                    contextWindow: 1000000,
                },
                {
                    model: 'claude-haiku-4-5',
                    inputTokens: 5,
                    outputTokens: 1,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                    costUSD: 0.0001,
                },
            ],
        }, AT);
        assert.match(md, /\| claude-opus-4-7 \|/);
        assert.match(md, /\| claude-haiku-4-5 \|/);
        assert.match(md, /\$0\.0421/);
        assert.match(md, /1,000,000/);
    });

    it('renders the total cost and API time when supplied', () => {
        const md = formatLiveTrailUsage({
            totals: { inputTokens: 1, outputTokens: 1 },
            totalCostUsd: 1.5,
            durationApiMs: 12_300,
        }, AT);
        assert.match(md, /\$1\.5000/);
        assert.match(md, /12\.3s/);
    });

    it('omits the model table when there is no per-model breakdown', () => {
        const md = formatLiveTrailUsage({ totals: { inputTokens: 10, outputTokens: 2 } }, AT);
        assert.doesNotMatch(md, /\| model \|/);
    });

    it('omits the totals line when there are no token counts', () => {
        const md = formatLiveTrailUsage({
            models: [{ model: 'claude-opus-4-7', inputTokens: 1, outputTokens: 1 }],
        }, AT);
        assert.doesNotMatch(md, /tokens:/);
        assert.match(md, /\| model \|/);
    });

    it('returns an empty string when there is nothing to report', () => {
        assert.equal(formatLiveTrailUsage({}, AT), '');
        assert.equal(formatLiveTrailUsage({ models: [] }, AT), '');
    });

    it('treats an all-zero totals block as reportable (a turn really can cost nothing new)', () => {
        const md = formatLiveTrailUsage({
            totals: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        }, AT);
        assert.match(md, /in 0/);
    });

    it('stamps each model row with the time the usage was recorded', () => {
        const md = formatLiveTrailUsage({
            models: [{ model: 'claude-opus-4-7', inputTokens: 1, outputTokens: 1 }],
        }, AT);
        assert.match(md, /\| when \|/);
        assert.match(md, /\| 20260804_090503 \|/);
    });

    it('uses the same stamp format as the prompt header, so the two can be correlated', () => {
        // The header stamps when the turn *started*; this column stamps when
        // its accounting arrived, and a long turn puts minutes between them.
        const at = new Date(2026, 7, 4, 12, 58, 36);
        const md = formatLiveTrailUsage({
            models: [{ model: 'claude-opus-4-7', inputTokens: 1, outputTokens: 1 }],
        }, at);
        const header = formatPromptHeaderTimestamp(at);
        assert.equal(header, '20260804_125836');
        assert.ok(md.includes(`| ${header} |`));
    });

    it('gives every row of a multi-model turn the same stamp', () => {
        const md = formatLiveTrailUsage({
            models: [
                { model: 'claude-opus-4-7', inputTokens: 1, outputTokens: 1 },
                { model: 'claude-haiku-4-5', inputTokens: 2, outputTokens: 2 },
            ],
        }, AT);
        assert.equal(md.match(/20260804_090503/g)?.length, 2);
    });
});

describe('LiveTrailWriter.appendUsage', () => {
    let quest: string;
    beforeEach(() => {
        quest = `q_${Math.random().toString(36).slice(2)}`;
    });

    it('appends the usage block to the trail file', () => {
        const w = newWriter(quest);
        w.appendUsage({
            totals: { inputTokens: 10, outputTokens: 20 },
            models: [{ model: 'claude-opus-4-7', inputTokens: 10, outputTokens: 20, costUSD: 0.5 }],
            totalCostUsd: 0.5,
        });
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.match(body, /### 📊 usage/);
        assert.match(body, /claude-opus-4-7/);
    });

    it('does not close the prompt block — DONE still follows', () => {
        const w = newWriter(quest);
        w.appendUsage({ totals: { inputTokens: 1, outputTokens: 1 } });
        w.endPrompt({ rounds: 1, toolCalls: 0, durationMs: 5 });
        const body = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.ok(
            body.indexOf('### 📊 usage') < body.indexOf('### ✅ DONE'),
            'usage must be written before the DONE marker',
        );
    });

    it('emits a usage event carrying the payload', () => {
        const events: LiveTrailEvent[] = [];
        const sub = LiveTrailWriter.addObserver((e) => events.push(e));
        try {
            const w = newWriter(quest);
            w.appendUsage({ totals: { inputTokens: 7, outputTokens: 3 }, totalCostUsd: 0.25 });
            const usage = events.find((e) => e.kind === 'usage');
            assert.ok(usage, 'expected a usage event');
            assert.equal(usage.kind === 'usage' && usage.usage.totalCostUsd, 0.25);
            assert.equal(usage.questId, quest);
        } finally {
            sub.dispose();
        }
    });

    it('is a no-op when there is nothing to report', () => {
        const w = newWriter(quest);
        const before = fs.readFileSync(w.getFilePath(), 'utf-8');
        w.appendUsage({});
        const after = fs.readFileSync(w.getFilePath(), 'utf-8');
        assert.equal(after, before);
    });
});

/**
 * Streamed deltas (vscimpb116): a chunk passed with `delta: true` is appended as
 * it came, so one paragraph streamed in several chunks stays one unbroken
 * paragraph; the next block closes the open line, so headings start where they
 * always did and the file ends in a newline after DONE / ERROR. Whole blocks
 * (no `delta`) are written as before.
 */
describe('LiveTrailWriter streamed deltas', () => {
    let quest: string;
    beforeEach(() => { quest = `q_${Math.random().toString(36).slice(2)}`; });
    const read = (w: LiveTrailWriter): string => fs.readFileSync(w.getFilePath(), 'utf-8');

    it('LT-D1: thinking and text deltas each stay one unbroken paragraph; DONE closes with a newline', () => {
        const w = newWriter(quest);
        for (const chunk of ['The user wants ', 'the num', 'bers summed, ', 'so I add them.']) { w.appendThinking(chunk, { delta: true }); }
        for (const chunk of ['The sum ', 'of 2 and 3 ', 'is 5.']) { w.appendAssistantText(chunk, { delta: true }); }
        assert.ok(!read(w).endsWith('\n'), 'mid-stream the line stays open');
        w.endPrompt({ rounds: 1, toolCalls: 0, durationMs: 7 });
        const body = read(w);
        assert.ok(body.includes('### 🧠 thinking\n\nThe user wants the numbers summed, so I add them.\n\n### 💬 assistant\n\nThe sum of 2 and 3 is 5.\n\n\n### ✅ DONE (rounds=1, toolCalls=0, 7ms)\n'), body);
        assert.ok(body.endsWith('\n'));
    });

    it('LT-D2: a tool call after streamed text, and ERROR, close the open line', () => {
        const w = newWriter(quest);
        w.appendAssistantText('Let me ', { delta: true });
        w.appendAssistantText('look.', { delta: true });
        w.beginToolCall('tomAi_readFile', { path: 'a' }, 't1');
        w.appendAssistantText('Still ', { delta: true });
        w.appendAssistantText('going', { delta: true });
        w.endPromptWithError('boom');
        const body = read(w);
        assert.ok(body.includes('### 💬 assistant\n\nLet me look.\n\n### 🔧 tomAi_readFile [t1]'), body);
        assert.ok(body.includes('### 💬 assistant\n\nStill going\n\n\n### ⚠️ ERROR\n\n```text\nboom\n```\n'), body);
        assert.ok(body.endsWith('\n'));
    });

    it('LT-D3: whole blocks are written as before (a line each), so two whole text blocks never run together', () => {
        const w = newWriter(quest);
        w.appendAssistantText('First block.');
        w.appendAssistantText('Second block.');
        w.endPrompt({ rounds: 1, toolCalls: 0, durationMs: 1 });
        assert.ok(read(w).includes('### 💬 assistant\n\nFirst block.\nSecond block.\n\n\n### ✅ DONE'), read(w));
    });

    it('LT-D4: the next prompt after a stream left open starts its block on a line of its own', () => {
        const w = newWriter(quest);
        w.appendAssistantText('cut ', { delta: true });
        w.appendAssistantText('off', { delta: true });
        w.beginPrompt({ transport: 'agentSdk', config: 'default', userText: 'next' });
        const body = read(w);
        assert.match(body, /cut off\n\n## 🚀 PROMPT \d{8}_\d{6} \[agentSdk \/ default\]\n\n> User: next\n$/);
    });
});
