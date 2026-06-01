/**
 * Tests for the single-line bullet memory format helpers.
 *
 * Coverage:
 *   - parseMemoryEntries drops lines lacking the canonical prefix
 *   - parseMemoryEntries extracts ts/host/text correctly
 *   - serialiseMemoryEntries emits one bullet per line ending with `\n`
 *   - dedupAndSortEntries dedups by (ts, text) and sorts newest first
 *   - round-trip parse/serialise preserves canonical entries
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

// memory-service.ts imports `vscode` for its TwoTierMemoryService
// runtime methods; the pure helpers don't use it but the require has
// to resolve. Install the shared stub before importing.
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    dedupAndSortEntries,
    parseMemoryEntries,
    serialiseMemoryEntries,
    type MemoryEntry,
} from '../memory-service.js';

describe('memory-service.parseMemoryEntries', () => {
    test('extracts ts/host/text from a canonical bullet', () => {
        const line = '- 2026-06-01T08:45:07.182Z [mbp.local] User prefers terse commits.';
        const parsed = parseMemoryEntries(line);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].ts, '2026-06-01T08:45:07.182Z');
        assert.equal(parsed[0].host, 'mbp.local');
        assert.equal(parsed[0].text, 'User prefers terse commits.');
    });

    test('drops legacy lines without the prefix', () => {
        const body = [
            '## Heading',
            '',
            '- legacy bullet without a timestamp',
            '- 2026-06-01T08:45:07.182Z [host1] modern bullet',
            'random prose',
        ].join('\n');
        const parsed = parseMemoryEntries(body);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].text, 'modern bullet');
    });

    test('handles a Z-suffixed ISO timestamp and an offset suffix', () => {
        const body = [
            '- 2026-06-01T08:45:07Z [h1] no-millis Z',
            '- 2026-06-01T08:45:07.000+02:00 [h2] millis with offset',
        ].join('\n');
        const parsed = parseMemoryEntries(body);
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].ts, '2026-06-01T08:45:07Z');
        assert.equal(parsed[1].ts, '2026-06-01T08:45:07.000+02:00');
    });
});

describe('memory-service.serialiseMemoryEntries', () => {
    test('emits one bullet per line terminated with a single newline', () => {
        const entries: MemoryEntry[] = [
            { ts: '2026-06-01T08:00:00.000Z', host: 'a', text: 'fact one' },
            { ts: '2026-06-01T09:00:00.000Z', host: 'b', text: 'fact two' },
        ];
        const text = serialiseMemoryEntries(entries);
        assert.equal(
            text,
            '- 2026-06-01T08:00:00.000Z [a] fact one\n- 2026-06-01T09:00:00.000Z [b] fact two\n',
        );
    });

    test('empty entries → empty string (no trailing newline)', () => {
        assert.equal(serialiseMemoryEntries([]), '');
    });
});

describe('memory-service.dedupAndSortEntries', () => {
    test('dedups by (ts, text) — different hosts at same ts are kept iff text differs', () => {
        const entries: MemoryEntry[] = [
            { ts: 'T', host: 'a', text: 'same' },
            { ts: 'T', host: 'b', text: 'same' },     // dropped: same (ts, text)
            { ts: 'T', host: 'b', text: 'different' }, // kept
        ];
        const result = dedupAndSortEntries(entries);
        assert.equal(result.length, 2);
    });

    test('sorts newest-first by ts (lex/iso)', () => {
        const entries: MemoryEntry[] = [
            { ts: '2026-01-01T00:00:00.000Z', host: 'a', text: 'oldest' },
            { ts: '2026-03-01T00:00:00.000Z', host: 'a', text: 'newest' },
            { ts: '2026-02-01T00:00:00.000Z', host: 'a', text: 'middle' },
        ];
        const result = dedupAndSortEntries(entries);
        assert.deepEqual(result.map((e) => e.text), ['newest', 'middle', 'oldest']);
    });
});

describe('memory-service round-trip', () => {
    test('parse → serialise preserves canonical entries exactly', () => {
        const original =
            '- 2026-06-01T08:00:00.000Z [a] fact one\n' +
            '- 2026-06-01T09:00:00.000Z [b] fact two\n';
        const parsed = parseMemoryEntries(original);
        const re = serialiseMemoryEntries(dedupAndSortEntries(parsed));
        // After dedupAndSortEntries the order is newest-first, which is the
        // opposite of the input here — sort the input to compare.
        const reparsed = parseMemoryEntries(re);
        const flat = reparsed.map((e) => `- ${e.ts} [${e.host}] ${e.text}`);
        assert.deepEqual(flat.sort(), [
            '- 2026-06-01T08:00:00.000Z [a] fact one',
            '- 2026-06-01T09:00:00.000Z [b] fact two',
        ]);
    });
});
