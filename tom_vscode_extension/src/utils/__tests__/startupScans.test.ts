/**
 * A load that several callers ask for while a window opens
 * (src/utils/ttlPromiseCache.ts) runs once for all of them.
 *
 *   SS-6 TtlPromiseCache: a failed load is forgotten; after the TTL the next
 *        caller loads again
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { TtlPromiseCache } from '../ttlPromiseCache.js';

describe('TtlPromiseCache', () => {
    test('SS-6: a failed load is forgotten; the TTL counts from the end of the load', async () => {
        let clock = 0;
        const cache = new TtlPromiseCache<number>(1000, () => clock);
        let loads = 0;
        await assert.rejects(cache.get('k', async () => { loads++; throw new Error('boom'); }));
        assert.equal(await cache.get('k', async () => ++loads), 2, 'the failure was not kept');
        clock = 999;
        assert.equal(await cache.get('k', async () => ++loads), 2, 'within the TTL');
        clock = 1000;
        assert.equal(await cache.get('k', async () => ++loads), 3, 'after the TTL');
    });
});
