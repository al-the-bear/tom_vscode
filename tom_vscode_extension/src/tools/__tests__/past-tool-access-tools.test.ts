/**
 * Tool-impl tests for `past-tool-access-tools.ts` — coverage entry #32.
 *
 *   - tomAi_listPastToolCalls
 *   - tomAi_searchPastToolResults
 *   - tomAi_readPastToolResult
 *
 * Strategy: a real `ToolTrail` instance is populated with a handful
 * of entries, then a `ToolHistoryAccess` fake wraps it + an in-memory
 * disk store map so we can exercise the ring-buffer vs disk-store
 * layering end-to-end. The c-row's "populated ToolTrail + on-disk
 * store fixture" is satisfied by:
 *
 *   - using the actual `ToolTrail` class (not a fake) for the
 *     ring-buffer surface, including its `keepEntries` eviction
 *     semantics
 *   - a small `Map<key, PastToolEntry>` standing in for the on-disk
 *     `${ai}/trail/<subsystem>/<quest>/tool_results/<key>.json`
 *     layout; the impl's `readFromDisk` dep is fed from this map
 *
 * Coverage entry #32 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: ring-buffer +
 *      disk-store layering, `tNN` key format, retention.
 *   b) Ambiguities closed:
 *        - bare numeric `"14"` vs `tNN` form `"t14"` — both work
 *          now via `normalisePastToolKey`; tested
 *        - search regex syntax: JS regex, gi/g flags, invalid
 *          regex → ok:false, zero-width guard tested
 *        - `sinceRound` is **inclusive** lower bound — tested
 *          against round 1, round 2 boundaries
 *        - ring-buffer-only vs disk fallback distinguished by
 *          `source: "memory" | "disk"` in the read response
 *   c) Tests with populated ToolTrail + on-disk fixture (Map).
 *   d) Timing — sub-ms per call.
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// `past-tool-access-tools.ts` imports tool-trail + tool-result-store
// at module top, which drag in vscode — install the stub first.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    listPastToolCallsImpl,
    searchPastToolResultsImpl,
    readPastToolResultImpl,
    normalisePastToolKey,
    type ToolHistoryAccess,
    type PastToolEntry,
} from '../past-tool-access-tools.js';
import { ToolTrail } from '../../services/tool-trail.js';

// ===========================================================================
// Fake disk store (Map-backed)
// ===========================================================================

class FakeDiskStore {
    readonly entries = new Map<string, PastToolEntry>();
    write(entry: PastToolEntry): void { this.entries.set(entry.key, { ...entry }); }
    read(key: string): PastToolEntry | undefined {
        const e = this.entries.get(key);
        return e ? { ...e } : undefined;
    }
}

// ===========================================================================
// Access bridge — wraps a real ToolTrail + the fake disk store
// ===========================================================================

function makeAccess(trail: ToolTrail | undefined, disk: FakeDiskStore): ToolHistoryAccess {
    return {
        listRingBuffer() {
            if (!trail) { return undefined; }
            return trail.listEntries().map((e) => ({
                key: e.key, timestamp: e.timestamp, round: e.round, toolName: e.toolName,
                inputSummary: e.inputSummary, result: e.result, durationMs: e.durationMs,
                error: e.error,
            }));
        },
        ringBufferCapacity() { return trail?.keepEntries; },
        readFromDisk(key) { return disk.read(key); },
    };
}

// ===========================================================================
// Fixture: populate trail + disk with a small set of entries
// ===========================================================================

let trail: ToolTrail;
let disk: FakeDiskStore;
let access: ToolHistoryAccess;

function seedEntries(): void {
    // Wire the persist hook so add() also writes to "disk" — mirrors what
    // the live handler does.
    trail.setPersistHook((e) => {
        disk.write({
            key: e.key, timestamp: e.timestamp, round: e.round, toolName: e.toolName,
            inputSummary: e.inputSummary, result: e.result, durationMs: e.durationMs,
            error: e.error,
        });
    });
    trail.add({ timestamp: '10:00:00', round: 1, toolName: 'tomAi_readFile',
                inputSummary: 'path=foo.ts', result: 'foo file contents include ERROR_KEYWORD here', durationMs: 5 });
    trail.add({ timestamp: '10:00:01', round: 1, toolName: 'tomAi_readFile',
                inputSummary: 'path=bar.ts', result: 'bar file contents', durationMs: 6 });
    trail.add({ timestamp: '10:00:02', round: 2, toolName: 'tomAi_findSymbol',
                inputSummary: 'symbol=foo', result: 'no matches', durationMs: 3 });
    trail.add({ timestamp: '10:00:03', round: 2, toolName: 'tomAi_runCommandStream',
                inputSummary: 'ls', result: 'a.txt\nb.txt\nERROR_KEYWORD.txt', durationMs: 10 });
    trail.add({ timestamp: '10:00:04', round: 3, toolName: 'tomAi_readFile',
                inputSummary: 'path=baz.ts', result: 'baz file', durationMs: 2 });
}

beforeEach(() => {
    trail = new ToolTrail({ keepEntries: 40 });
    disk = new FakeDiskStore();
    access = makeAccess(trail, disk);
});

// ===========================================================================
// `normalisePastToolKey` — pure helper
// ===========================================================================

describe('normalisePastToolKey', () => {

    test('bare numeric becomes t-prefixed', () => {
        assert.equal(normalisePastToolKey('14'), 't14');
        assert.equal(normalisePastToolKey('0'), 't0');
    });

    test('already-prefixed keys pass through', () => {
        assert.equal(normalisePastToolKey('t14'), 't14');
        assert.equal(normalisePastToolKey('t142'), 't142');
    });

    test('non-numeric, non-t-prefixed keys pass through unchanged', () => {
        assert.equal(normalisePastToolKey('custom-key'), 'custom-key');
    });

    test('whitespace trimmed', () => {
        assert.equal(normalisePastToolKey('  t14  '), 't14');
        assert.equal(normalisePastToolKey('  14  '), 't14');
    });

    test('empty becomes empty', () => {
        assert.equal(normalisePastToolKey(''), '');
        assert.equal(normalisePastToolKey('   '), '');
    });
});

// ===========================================================================
// listPastToolCallsImpl
// ===========================================================================

describe('listPastToolCallsImpl', () => {

    test('typical: returns all 5 entries with metadata + capacity', async () => {
        seedEntries();
        const raw = await withTiming('tomAi_listPastToolCalls:typical', () =>
            listPastToolCallsImpl(access, {}));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.count, 5);
        assert.equal(r.totalMatches, 5);
        assert.equal(r.bufferSize, 5);
        assert.equal(r.capacity, 40);
        assert.equal(r.entries.length, 5);
        // Sanity: each entry has the expected fields
        const first = r.entries[0];
        assert.match(first.key, /^t\d+$/);
        assert.equal(typeof first.timestamp, 'string');
        assert.equal(typeof first.round, 'number');
        assert.equal(typeof first.resultSize, 'number');
        assert.equal(first.status, 'ok');
    });

    test('toolName filter: only returns matching tool', async () => {
        seedEntries();
        const r = JSON.parse(await listPastToolCallsImpl(access, { toolName: 'tomAi_readFile' }));
        assert.equal(r.totalMatches, 3);
        for (const e of r.entries) { assert.equal(e.toolName, 'tomAi_readFile'); }
    });

    test('sinceRound: INCLUSIVE lower bound (round 2 returns rounds 2 and 3)', async () => {
        seedEntries();
        const r = JSON.parse(await listPastToolCallsImpl(access, { sinceRound: 2 }));
        const rounds = r.entries.map((e: { round: number }) => e.round);
        assert.deepEqual(rounds.sort(), [2, 2, 3]);
    });

    test('sinceRound = 3 returns only round 3 entries', async () => {
        seedEntries();
        const r = JSON.parse(await listPastToolCallsImpl(access, { sinceRound: 3 }));
        assert.equal(r.totalMatches, 1);
        assert.equal(r.entries[0].round, 3);
    });

    test('limit: caps output AND surfaces truncated flag', async () => {
        seedEntries();
        const r = JSON.parse(await listPastToolCallsImpl(access, { limit: 2 }));
        assert.equal(r.count, 2);
        assert.equal(r.totalMatches, 5);
        assert.equal(r.truncated, true);
    });

    test('limit clamped to [1, 200]', async () => {
        seedEntries();
        const r1 = JSON.parse(await listPastToolCallsImpl(access, { limit: 0 }));
        assert.equal(r1.count, 1, '0 clamps to 1');
        const r2 = JSON.parse(await listPastToolCallsImpl(access, { limit: 10_000 }));
        assert.equal(r2.count, 5, '10000 clamps to 200 (then matches.length)');
    });

    test('combined filters: toolName + sinceRound + limit', async () => {
        seedEntries();
        const r = JSON.parse(await listPastToolCallsImpl(access, {
            toolName: 'tomAi_readFile', sinceRound: 2, limit: 10,
        }));
        assert.equal(r.totalMatches, 1, 'only readFile at round 3');
        assert.equal(r.entries[0].round, 3);
    });

    test('empty trail → ok:true, count:0, note explains', async () => {
        // no seed → empty trail
        const r = JSON.parse(await listPastToolCallsImpl(access, {}));
        assert.equal(r.ok, true);
        assert.equal(r.count, 0);
        assert.equal(r.bufferSize, 0);
        assert.match(r.note, /empty/);
    });

    test('no ToolTrail active (ring buffer undefined) → ok:false with hint', async () => {
        const inactive = makeAccess(undefined, disk);
        const r = JSON.parse(await listPastToolCallsImpl(inactive, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /No ToolTrail active/);
        assert.match(r.hint, /Anthropic session/);
    });
});

// ===========================================================================
// searchPastToolResultsImpl
// ===========================================================================

describe('searchPastToolResultsImpl', () => {

    test('typical: pattern matches across multiple entries; both hits surface', async () => {
        seedEntries();
        const raw = await withTiming('tomAi_searchPastToolResults:typical', () =>
            searchPastToolResultsImpl(access, { pattern: 'ERROR_KEYWORD' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.hitCount, 2);
        assert.equal(r.entriesScanned, 5);
        // Both hits include the matched word
        for (const h of r.hits) { assert.match(h.snippet, /ERROR_KEYWORD/); }
    });

    test('caseSensitive: false (default) matches "error_keyword" lowercase pattern against uppercase body', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, { pattern: 'error_keyword' }));
        assert.equal(r.hitCount, 2);
        assert.equal(r.caseSensitive, false);
    });

    test('caseSensitive: true skips the uppercase body when pattern is lowercase', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, {
            pattern: 'error_keyword', caseSensitive: true,
        }));
        assert.equal(r.hitCount, 0);
        assert.equal(r.caseSensitive, true);
    });

    test('toolName filter: only the specified tool is scanned', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, {
            pattern: 'ERROR_KEYWORD', toolName: 'tomAi_readFile',
        }));
        assert.equal(r.entriesScanned, 3);
        assert.equal(r.hitCount, 1, 'only the foo.ts read had the keyword');
    });

    test('limit: caps total hits, breaks across entries', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, {
            pattern: 'ERROR_KEYWORD', limit: 1,
        }));
        assert.equal(r.hitCount, 1);
    });

    test('contextChars: snippet length grows/shrinks with the parameter', async () => {
        seedEntries();
        const small = JSON.parse(await searchPastToolResultsImpl(access, {
            pattern: 'ERROR_KEYWORD', contextChars: 5,
        }));
        const large = JSON.parse(await searchPastToolResultsImpl(access, {
            pattern: 'ERROR_KEYWORD', contextChars: 500,
        }));
        // larger context window → snippet at least as long
        assert.ok(large.hits[0].snippet.length >= small.hits[0].snippet.length);
    });

    test('invalid regex → ok:false with reason + pattern echoed', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, { pattern: '(unclosed' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /Invalid regex/);
        assert.equal(r.pattern, '(unclosed');
    });

    test('empty pattern rejected', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, { pattern: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`pattern` is required/);
    });

    test('zero-width pattern is guarded against (no infinite loop)', async () => {
        seedEntries();
        // `(?:)` matches empty string at every position; lastIndex guard bumps
        // past it so the loop terminates instead of spinning forever.
        const r = JSON.parse(await searchPastToolResultsImpl(access, { pattern: '(?:)', limit: 3 }));
        assert.equal(r.ok, true);
        assert.equal(r.hitCount, 3, 'limit reached without infinite loop');
    });

    test('no hits returns empty array (not an error)', async () => {
        seedEntries();
        const r = JSON.parse(await searchPastToolResultsImpl(access, { pattern: 'NEVER_PRESENT_XYZZY' }));
        assert.equal(r.ok, true);
        assert.equal(r.hitCount, 0);
        assert.deepEqual(r.hits, []);
    });

    test('no ToolTrail active → ok:false', async () => {
        const inactive = makeAccess(undefined, disk);
        const r = JSON.parse(await searchPastToolResultsImpl(inactive, { pattern: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /No ToolTrail active/);
    });
});

// ===========================================================================
// readPastToolResultImpl
// ===========================================================================

describe('readPastToolResultImpl', () => {

    test('typical: reads from in-memory ring buffer; source: "memory"', async () => {
        seedEntries();
        const raw = await withTiming('tomAi_readPastToolResult:typical', () =>
            readPastToolResultImpl(access, { key: 't1' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.key, 't1');
        assert.equal(r.source, 'memory');
        assert.equal(r.toolName, 'tomAi_readFile');
        assert.equal(r.round, 1);
        assert.match(r.result, /ERROR_KEYWORD/);
    });

    test('bare numeric "1" normalises to "t1" and resolves', async () => {
        seedEntries();
        const r = JSON.parse(await readPastToolResultImpl(access, { key: '1' }));
        assert.equal(r.ok, true);
        assert.equal(r.key, 't1', 'normalised key');
        assert.equal(r.rawKey, '1', 'raw key echoed');
    });

    test('disk fallback: ring buffer empty, entry exists on disk → source: "disk"', async () => {
        // Don't seed — but write a stray entry to disk
        disk.write({
            key: 't99', timestamp: '09:00:00', round: 1, toolName: 'tomAi_readFile',
            inputSummary: 'path=stale.ts', result: 'evicted contents', durationMs: 4,
        });
        const r = JSON.parse(await readPastToolResultImpl(access, { key: 't99' }));
        assert.equal(r.ok, true);
        assert.equal(r.source, 'disk');
        assert.equal(r.result, 'evicted contents');
    });

    test('ring buffer takes precedence over disk for the same key', async () => {
        seedEntries();
        // Overwrite disk with a different body for t1 — ring buffer should win
        disk.write({
            key: 't1', timestamp: 'X', round: 99, toolName: 'WRONG',
            inputSummary: '', result: 'DISK VERSION', durationMs: 0,
        });
        const r = JSON.parse(await readPastToolResultImpl(access, { key: 't1' }));
        assert.equal(r.source, 'memory', 'memory takes precedence');
        assert.match(r.result, /ERROR_KEYWORD/, 'memory body returned, not disk');
    });

    test('unknown key → ok:false with hint referencing list tool', async () => {
        seedEntries();
        const r = JSON.parse(await readPastToolResultImpl(access, { key: 't404' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /No past tool result with key "t404"/);
        assert.match(r.hint, /tomAi_listPastToolCalls/);
        assert.equal(r.normalisedKey, 't404');
    });

    test('unknown key with no trail → hint mentions stubs', async () => {
        const inactive = makeAccess(undefined, disk);
        const r = JSON.parse(await readPastToolResultImpl(inactive, { key: 't404' }));
        assert.equal(r.ok, false);
        assert.match(r.hint, /No ToolTrail active/);
    });

    test('empty key rejected', async () => {
        const r = JSON.parse(await readPastToolResultImpl(access, { key: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`key` is required/);
    });

    test('errored entry: errorMessage field populated', async () => {
        trail.setPersistHook(() => { /* no disk for this case */ });
        trail.add({ timestamp: '10:00:99', round: 1, toolName: 'tomAi_readFile',
                    inputSummary: 'path=nope', result: '', durationMs: 1, error: 'ENOENT' });
        const r = JSON.parse(await readPastToolResultImpl(access, { key: 't1' }));
        assert.equal(r.ok, true);
        assert.equal(r.errorMessage, 'ENOENT');
    });
});

// ===========================================================================
// Integration: ring buffer eviction → disk fallback proves layering
// ===========================================================================

describe('layering: ring eviction + disk fallback (entry #32 c-row)', () => {

    test('after ring eviction, key still resolves via disk', async () => {
        // Build a tiny ring (keepEntries: 2) so eviction is observable in
        // a 3-entry sequence; the disk persist hook keeps everything.
        const smallTrail = new ToolTrail({ keepEntries: 2 });
        const smallAccess = makeAccess(smallTrail, disk);
        smallTrail.setPersistHook((e) => disk.write({
            key: e.key, timestamp: e.timestamp, round: e.round, toolName: e.toolName,
            inputSummary: e.inputSummary, result: e.result, durationMs: e.durationMs,
            error: e.error,
        }));
        smallTrail.add({ timestamp: 'T', round: 1, toolName: 'a', inputSummary: '', result: 'first', durationMs: 1 });
        smallTrail.add({ timestamp: 'T', round: 1, toolName: 'a', inputSummary: '', result: 'second', durationMs: 1 });
        smallTrail.add({ timestamp: 'T', round: 1, toolName: 'a', inputSummary: '', result: 'third', durationMs: 1 });

        // The ring now holds t2 and t3 (t1 was evicted).
        const listed = JSON.parse(await listPastToolCallsImpl(smallAccess, {}));
        assert.deepEqual(listed.entries.map((e: { key: string }) => e.key), ['t2', 't3']);

        // But t1 is still reachable through the disk fallback.
        const r = JSON.parse(await readPastToolResultImpl(smallAccess, { key: 't1' }));
        assert.equal(r.ok, true);
        assert.equal(r.source, 'disk');
        assert.equal(r.result, 'first');
    });
});
