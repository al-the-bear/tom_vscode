/**
 * Unit tests for {@link historySnapshotFormat} — the pure layer that makes
 * the `history.json` / `history.md` snapshot pair mergeable.
 *
 * The contract under test:
 *   - Each raw turn carries a per-entry ISO `ts`, so a git merge driver can
 *     union turns from two branches and sort by timestamp without losing any.
 *   - Timestamps are **stable** across rewrites: a turn that already has a `ts`
 *     (matched by role+content) keeps it, so the same logical turn carries the
 *     same timestamp on both sides of a divergence.
 *   - Legacy snapshots (entries with no `ts`) are migrated on the next write:
 *     the entries are stamped from "now" backwards at 1-second steps, oldest
 *     first, so existing history keeps a sensible chronological order.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    stampRawTurns,
    isLegacyHistoryFormat,
    extractRawTurns,
    formatHistoryAsMarkdown,
    type SnapshotTurn,
} from '../historySnapshotFormat.js';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('isLegacyHistoryFormat', () => {
    test('empty list is not legacy (nothing to migrate)', () => {
        assert.equal(isLegacyHistoryFormat([]), false);
    });
    test('all entries timestamped is not legacy', () => {
        assert.equal(isLegacyHistoryFormat([
            { role: 'user', content: 'a', ts: iso(NOW) },
        ]), false);
    });
    test('any entry missing ts is legacy', () => {
        assert.equal(isLegacyHistoryFormat([
            { role: 'user', content: 'a', ts: iso(NOW) },
            { role: 'assistant', content: 'b' },
        ]), true);
    });
});

describe('extractRawTurns', () => {
    test('pulls well-formed turns from the canonical messages object', () => {
        const turns = extractRawTurns({
            compactedSummary: 's',
            rawTurns: [
                { role: 'user', content: 'hi', ts: iso(NOW) },
                { role: 'assistant', content: 'yo' },
                { role: 'bogus' }, // dropped: no string content
                'nope', // dropped: not an object
            ],
        });
        assert.deepEqual(turns, [
            { role: 'user', content: 'hi', ts: iso(NOW) },
            { role: 'assistant', content: 'yo' },
        ]);
    });
    test('non-object / array payloads yield no turns', () => {
        assert.deepEqual(extractRawTurns(null), []);
        assert.deepEqual(extractRawTurns([1, 2, 3]), []);
        assert.deepEqual(extractRawTurns('x'), []);
    });
});

describe('stampRawTurns — fresh / legacy migration', () => {
    test('a single fresh turn is stamped at now', () => {
        const out = stampRawTurns([{ role: 'user', content: 'a' }], [], NOW);
        assert.deepEqual(out, [{ role: 'user', content: 'a', ts: iso(NOW) }]);
    });

    test('legacy entries (no prior ts) are stamped backwards at 1s, oldest first', () => {
        // Prior file is legacy: entries present but none carry a ts.
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
        ];
        const next = [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.deepEqual(out.map((t) => t.ts), [
            iso(NOW - 2000),
            iso(NOW - 1000),
            iso(NOW),
        ]);
    });

    test('no prior file at all is treated like a migration (backwards stamp)', () => {
        const next = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ];
        const out = stampRawTurns(next, [], NOW);
        assert.deepEqual(out.map((t) => t.ts), [iso(NOW - 1000), iso(NOW)]);
    });
});

describe('stampRawTurns — stable preservation across rewrites', () => {
    test('matched turns keep their existing ts; the new tail turn gets now', () => {
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'a', ts: iso(NOW - 5000) },
            { role: 'assistant', content: 'b', ts: iso(NOW - 4000) },
        ];
        const next = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.deepEqual(out, [
            { role: 'user', content: 'a', ts: iso(NOW - 5000) },
            { role: 'assistant', content: 'b', ts: iso(NOW - 4000) },
            { role: 'user', content: 'c', ts: iso(NOW) },
        ]);
    });

    test('front-trimmed turns (compaction) still match the surviving tail', () => {
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'a', ts: iso(NOW - 6000) },
            { role: 'assistant', content: 'b', ts: iso(NOW - 5000) },
            { role: 'user', content: 'c', ts: iso(NOW - 4000) },
        ];
        // 'a' got summarised away; 'd' is brand new.
        const next = [
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'assistant', content: 'd' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.deepEqual(out, [
            { role: 'assistant', content: 'b', ts: iso(NOW - 5000) },
            { role: 'user', content: 'c', ts: iso(NOW - 4000) },
            { role: 'assistant', content: 'd', ts: iso(NOW) },
        ]);
    });

    test('duplicate role+content pairs reuse prior ts in order', () => {
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'dup', ts: iso(NOW - 2000) },
            { role: 'user', content: 'dup', ts: iso(NOW - 1000) },
        ];
        const next = [
            { role: 'user', content: 'dup' },
            { role: 'user', content: 'dup' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.deepEqual(out.map((t) => t.ts), [iso(NOW - 2000), iso(NOW - 1000)]);
    });

    test('multiple new tail turns get strictly increasing timestamps', () => {
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'a', ts: iso(NOW - 1000) },
        ];
        const next = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.equal(out[0].ts, iso(NOW - 1000));
        assert.equal(out[1].ts, iso(NOW));
        assert.equal(out[2].ts, iso(NOW + 1));
    });

    test('new tail turns never precede an already-newer preserved ts', () => {
        // Preserved turn is in the future relative to `now`; new turns must
        // still sort after it, not at a stale `now`.
        const prev: SnapshotTurn[] = [
            { role: 'user', content: 'a', ts: iso(NOW + 10000) },
        ];
        const next = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
        ];
        const out = stampRawTurns(next, prev, NOW);
        assert.equal(out[0].ts, iso(NOW + 10000));
        assert.equal(out[1].ts, iso(NOW + 10001));
    });
});

describe('formatHistoryAsMarkdown', () => {
    test('renders summary and raw turns with per-entry timestamps', () => {
        const md = formatHistoryAsMarkdown({
            messages: {
                compactedSummary: 'the summary',
                rawTurns: [
                    { role: 'user', content: 'hello', ts: iso(NOW - 1000) },
                    { role: 'assistant', content: 'hi there', ts: iso(NOW) },
                ],
            },
            savedAt: iso(NOW),
            questId: 'demo',
        });
        assert.match(md, /# Session history — `demo`/);
        assert.match(md, /## Compacted summary — 11 chars/);
        assert.match(md, /the summary/);
        assert.match(md, /## Raw turns — 2 messages/);
        // Heading carries the timestamp so the .md is itself mergeable/inspectable.
        assert.match(md, /### \[1\] user — 5 chars — 2026-06-11T11:59:59\.000Z/);
        assert.match(md, /### \[2\] assistant — 8 chars — 2026-06-11T12:00:00\.000Z/);
        assert.match(md, /hello/);
        assert.match(md, /hi there/);
    });

    test('falls back to a raw JSON dump for non-canonical payloads', () => {
        const md = formatHistoryAsMarkdown({
            messages: ['just', 'an', 'array'],
            savedAt: iso(NOW),
            questId: 'demo',
        });
        assert.match(md, /## Raw payload/);
        assert.match(md, /```json/);
    });
});
