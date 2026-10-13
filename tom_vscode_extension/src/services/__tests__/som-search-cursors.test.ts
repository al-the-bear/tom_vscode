/**
 * SomSearchCursors — the open search cursors of the spec search tools (vsctsa4).
 *
 *   SC-1  an added cursor is found by its id, and finding it refreshes it
 *   SC-2  a cursor unused for the TTL expires and says so
 *   SC-3  at the cap, the least recently used cursor is evicted and says so
 *   SC-4  a finished cursor reports exhausted; an id never issued reports unknown
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import type { SpecQueryCursor } from 'tom_som_typescript_runtime';
import { SomSearchCursors } from '../som-search-cursors.js';

const fakeCursor = {} as SpecQueryCursor;
const init = { filePath: '/x.docspecs.yaml', revision: 'r1', query: {}, cursor: fakeCursor, total: 3 };

function clock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_000_000;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('SomSearchCursors', () => {
    test('SC-1: an added cursor is found, and finding it refreshes it', () => {
        const c = clock();
        const cursors = new SomSearchCursors(c.now, 1000, 4);
        const entry = cursors.add(init);
        assert.match(entry.id, /^sc-[0-9a-f]{12}$/);
        assert.equal(entry.delivered, 0);
        c.advance(900);
        assert.equal(cursors.get(entry.id).found, true);
        c.advance(900); // 1800 ms since add, 900 since the last use
        assert.equal(cursors.get(entry.id).found, true);
    });

    test('SC-2: a cursor unused for the TTL expires', () => {
        const c = clock();
        const cursors = new SomSearchCursors(c.now, 1000, 4);
        const entry = cursors.add(init);
        c.advance(1001);
        assert.deepEqual(cursors.get(entry.id), { found: false, reason: 'expired' });
        assert.equal(cursors.size, 0);
    });

    test('SC-3: at the cap the least recently used cursor is evicted', () => {
        const c = clock();
        const cursors = new SomSearchCursors(c.now, 60_000, 2);
        const a = cursors.add(init);
        c.advance(10);
        const b = cursors.add(init);
        c.advance(10);
        cursors.get(a.id); // a is now the more recently used
        c.advance(10);
        const d = cursors.add(init);
        assert.deepEqual(cursors.get(b.id), { found: false, reason: 'evicted' });
        assert.equal(cursors.get(a.id).found, true);
        assert.equal(cursors.get(d.id).found, true);
        assert.equal(cursors.size, 2);
    });

    test('SC-4: finished and unknown cursors', () => {
        const cursors = new SomSearchCursors();
        const entry = cursors.add(init);
        cursors.finish(entry.id);
        assert.deepEqual(cursors.get(entry.id), { found: false, reason: 'exhausted' });
        assert.deepEqual(cursors.get('sc-000000000000'), { found: false, reason: 'unknown' });
    });
});
