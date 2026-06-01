/**
 * Tests for the block-format compacted-history module.
 *
 * Coverage:
 *   - parse/serialise round-trip on a typical multi-block file
 *   - parser tolerates blocks without `modified` (defaults to created)
 *   - parser tolerates blocks without `created` (drops them — no identity)
 *   - dedup-by-created keeps the higher `modified` when two blocks
 *     collide on `created`
 *   - sort puts blocks in chronological order regardless of input order
 *   - `diffAndStamp` keeps `created` unchanged on unedited blocks and
 *     stamps `modified=now` on edited / new blocks
 *   - `concatenateBodies` strips markers and joins with blank lines
 *   - `renderBlocksForLlm` includes `created` but drops `modified`
 *   - `loadFromDisk` / `saveToDisk` round-trip via a real tmp folder
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// compacted-history.ts only imports `fs` + `path`, no vscode — but its
// sibling history-compaction.ts (re-exported through type imports) does.
// Install the shared stub before importing anything from the service
// tree to make the require graph satisfiable in a node:test process.
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import {
    type Block,
    concatenateBodies,
    dedupAndSort,
    diffAndStamp,
    loadFromDisk,
    parseBlocks,
    renderBlocksForLlm,
    saveToDisk,
    serialiseBlocks,
} from '../compacted-history.js';

describe('compacted-history.parseBlocks / serialiseBlocks', () => {
    test('round-trips a typical multi-block file', () => {
        const blocks: Block[] = [
            {
                created: '2026-05-12T10:01:23.456Z',
                modified: '2026-05-30T15:44:01.000Z',
                body: '- Decision: dropped the speculative `none` history mode.\n- File: `src/services/history-compaction.ts` (rewrote runFull).',
            },
            {
                created: '2026-05-13T08:00:00.000Z',
                modified: '2026-05-13T08:00:00.000Z',
                body: 'Plain prose without bullets is also a valid block body.',
            },
        ];
        const serialised = serialiseBlocks(blocks);
        const reparsed = parseBlocks(serialised);
        assert.deepEqual(reparsed, blocks);
    });

    test('tolerates a missing `modified` attribute (falls back to created)', () => {
        const text = [
            '<!-- tom:block created="2026-01-01T00:00:00.000Z" -->',
            'body without modified',
            '<!-- /tom:block -->',
        ].join('\n');
        const parsed = parseBlocks(text);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].created, parsed[0].modified);
        assert.equal(parsed[0].body, 'body without modified');
    });

    test('drops blocks lacking a `created` attribute (no identity)', () => {
        const text = [
            '<!-- tom:block -->',
            'orphan body',
            '<!-- /tom:block -->',
            '',
            '<!-- tom:block created="2026-01-01T00:00:00.000Z" -->',
            'good body',
            '<!-- /tom:block -->',
        ].join('\n');
        const parsed = parseBlocks(text);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].body, 'good body');
    });

    test('preserves internal blank lines within a body', () => {
        const blocks: Block[] = [{
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-01-01T00:00:00.000Z',
            body: 'first paragraph\n\nsecond paragraph',
        }];
        const reparsed = parseBlocks(serialiseBlocks(blocks));
        assert.equal(reparsed[0].body, 'first paragraph\n\nsecond paragraph');
    });

    test('re-syncs at the next open marker when a close marker is missing', () => {
        // Simulates a botched git merge that dropped the first block's
        // close marker. Without self-healing the second block would be
        // swallowed into the first block's body and lost as a distinct block.
        const text = [
            '<!-- tom:block created="2026-01-01T00:00:00.000Z" -->',
            'first body',
            // <-- close marker for block 1 is MISSING here
            '<!-- tom:block created="2026-01-02T00:00:00.000Z" -->',
            'second body',
            '<!-- /tom:block -->',
        ].join('\n');
        const parsed = parseBlocks(text);
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].created, '2026-01-01T00:00:00.000Z');
        assert.equal(parsed[0].body, 'first body');
        assert.equal(parsed[1].created, '2026-01-02T00:00:00.000Z');
        assert.equal(parsed[1].body, 'second body');
    });
});

describe('compacted-history.dedupAndSort', () => {
    test('keeps the higher `modified` when two blocks share `created`', () => {
        const older: Block = {
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-02-01T00:00:00.000Z',
            body: 'older body',
        };
        const newer: Block = {
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-02-15T00:00:00.000Z',
            body: 'newer body',
        };
        const result = dedupAndSort([older, newer]);
        assert.equal(result.length, 1);
        assert.equal(result[0].body, 'newer body');
        assert.equal(result[0].modified, '2026-02-15T00:00:00.000Z');
    });

    test('sorts by `created` chronologically regardless of input order', () => {
        const a: Block = { created: '2026-03-01T00:00:00.000Z', modified: 'x', body: 'a' };
        const b: Block = { created: '2026-01-01T00:00:00.000Z', modified: 'x', body: 'b' };
        const c: Block = { created: '2026-02-01T00:00:00.000Z', modified: 'x', body: 'c' };
        const sorted = dedupAndSort([a, b, c]);
        assert.deepEqual(sorted.map((s) => s.created), [
            '2026-01-01T00:00:00.000Z',
            '2026-02-01T00:00:00.000Z',
            '2026-03-01T00:00:00.000Z',
        ]);
    });
});

describe('compacted-history.diffAndStamp', () => {
    const now = '2026-06-01T12:00:00.000Z';

    test('keeps the prior `modified` when a block body is unchanged', () => {
        const prev: Block[] = [{
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-04-15T00:00:00.000Z',
            body: 'unchanged body',
        }];
        const next = [{ created: '2026-01-01T00:00:00.000Z', body: 'unchanged body' }];
        const stamped = diffAndStamp(prev, next, now);
        assert.equal(stamped.length, 1);
        assert.equal(stamped[0].modified, '2026-04-15T00:00:00.000Z');
    });

    test('bumps `modified=now` when the body differs', () => {
        const prev: Block[] = [{
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-04-15T00:00:00.000Z',
            body: 'old body',
        }];
        const next = [{ created: '2026-01-01T00:00:00.000Z', body: 'edited body' }];
        const stamped = diffAndStamp(prev, next, now);
        assert.equal(stamped[0].modified, now);
        assert.equal(stamped[0].body, 'edited body');
    });

    test('brand-new blocks get `modified=now`', () => {
        const prev: Block[] = [];
        const next = [{ created: '2026-06-01T12:00:00.000Z', body: 'new block' }];
        const stamped = diffAndStamp(prev, next, now);
        assert.equal(stamped[0].modified, now);
        assert.equal(stamped[0].created, '2026-06-01T12:00:00.000Z');
    });

    test('whitespace-only changes do not bump `modified`', () => {
        const prev: Block[] = [{
            created: '2026-01-01T00:00:00.000Z',
            modified: '2026-04-15T00:00:00.000Z',
            body: 'line one\nline two',
        }];
        const next = [{
            created: '2026-01-01T00:00:00.000Z',
            body: 'line one   \nline two\n\n',  // trailing whitespace + extra newlines
        }];
        const stamped = diffAndStamp(prev, next, now);
        assert.equal(stamped[0].modified, '2026-04-15T00:00:00.000Z');
    });
});

describe('compacted-history.concatenateBodies / renderBlocksForLlm', () => {
    test('concatenateBodies joins bodies with blank lines and strips markers', () => {
        const blocks: Block[] = [
            { created: 't1', modified: 't1', body: 'body one' },
            { created: 't2', modified: 't2', body: 'body two' },
        ];
        assert.equal(concatenateBodies(blocks), 'body one\n\nbody two');
    });

    test('renderBlocksForLlm preserves `created` but drops `modified`', () => {
        const blocks: Block[] = [
            { created: '2026-01-01T00:00:00.000Z', modified: '2026-05-15T00:00:00.000Z', body: 'x' },
        ];
        const rendered = renderBlocksForLlm(blocks);
        assert.match(rendered, /created="2026-01-01T00:00:00\.000Z"/);
        assert.equal(rendered.includes('modified='), false);
    });
});

describe('compacted-history disk IO', () => {
    test('saveToDisk + loadFromDisk round-trip', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tom-ch-'));
        try {
            const blocks: Block[] = [{
                created: '2026-01-01T00:00:00.000Z',
                modified: '2026-01-01T00:00:00.000Z',
                body: 'persisted body',
            }];
            assert.equal(saveToDisk(tmp, blocks), true);
            const loaded = loadFromDisk(tmp);
            assert.deepEqual(loaded, blocks);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('loadFromDisk on a missing folder returns []', () => {
        const fake = path.join(os.tmpdir(), 'tom-ch-does-not-exist-xyz');
        const loaded = loadFromDisk(fake);
        assert.deepEqual(loaded, []);
    });
});
