/**
 * Tests for mergeQueueReload — the targeted reload merge that fixes the
 * "prompt queue no longer updates reliably" regression.
 *
 * The old behaviour dropped the entire disk reload whenever any item was
 * `sending`, so externally-added prompts never surfaced and completed prompts
 * didn't refresh during active auto-send. The merge takes disk state for every
 * item while preserving the *exact* live object reference for `sending` items
 * (the in-flight send chain mutates that reference).
 *
 * Pure function (no `vscode`); no stub needed.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeQueueReload, ReloadMergeItem } from '../queueReloadMergeUtils.js';

interface Item extends ReloadMergeItem {
    id: string;
    status: string;
    tag?: string;
}

describe('mergeQueueReload', () => {
    test('surfaces an externally-added item while another item is sending', () => {
        const sending: Item = { id: 'A', status: 'sending' };
        const inMemory: Item[] = [sending, { id: 'B', status: 'sent' }];
        // Disk has A (still sending), B (sent), and a new C added elsewhere.
        const disk: Item[] = [
            { id: 'A', status: 'sending' },
            { id: 'B', status: 'sent' },
            { id: 'C', status: 'pending' },
        ];

        const { merged, preservedIds } = mergeQueueReload(inMemory, disk);

        assert.deepEqual(merged.map(i => i.id), ['A', 'B', 'C']);
        // The new prompt is now visible — the old code would have dropped the
        // whole reload because A was sending.
        assert.ok(merged.some(i => i.id === 'C'));
        assert.deepEqual([...preservedIds], ['A']);
    });

    test('keeps the exact live object reference for sending items', () => {
        const sending: Item = { id: 'A', status: 'sending', tag: 'live' };
        const inMemory: Item[] = [sending];
        // Disk version of A is a different object (and would, e.g., still read
        // as sending from the file the send chain wrote).
        const disk: Item[] = [{ id: 'A', status: 'sending', tag: 'disk' }];

        const { merged } = mergeQueueReload(inMemory, disk);

        // Reference identity matters: the send chain holds `sending` and will
        // set .status = 'sent' on it later.
        assert.strictEqual(merged[0], sending);
        assert.equal(merged[0].tag, 'live');
    });

    test('takes the disk version for non-sending items (reflects completions)', () => {
        const inMemory: Item[] = [{ id: 'A', status: 'sending' }];
        // A finished elsewhere (disk now says sent) — but in our window it is
        // still the live sending object, so the live ref wins for A. B is a
        // pure disk item and is taken verbatim.
        const disk: Item[] = [
            { id: 'A', status: 'sending' },
            { id: 'B', status: 'sent', tag: 'disk' },
        ];

        const { merged } = mergeQueueReload(inMemory, disk);
        const b = merged.find(i => i.id === 'B');
        assert.equal(b?.status, 'sent');
        assert.equal(b?.tag, 'disk');
    });

    test('retains an in-memory sending item absent from disk', () => {
        const sending: Item = { id: 'A', status: 'sending' };
        const inMemory: Item[] = [sending];
        const disk: Item[] = [{ id: 'B', status: 'pending' }];

        const { merged, preservedIds } = mergeQueueReload(inMemory, disk);

        assert.deepEqual(merged.map(i => i.id).sort(), ['A', 'B']);
        assert.strictEqual(merged.find(i => i.id === 'A'), sending);
        assert.deepEqual([...preservedIds], ['A']);
    });

    test('no sending items → merged equals disk', () => {
        const inMemory: Item[] = [{ id: 'A', status: 'sent' }];
        const disk: Item[] = [
            { id: 'A', status: 'sent' },
            { id: 'B', status: 'pending' },
        ];

        const { merged, preservedIds } = mergeQueueReload(inMemory, disk);

        assert.deepEqual(merged, disk);
        assert.equal(preservedIds.size, 0);
    });

    test('disk ordering is honoured', () => {
        const sending: Item = { id: 'B', status: 'sending' };
        const inMemory: Item[] = [sending];
        const disk: Item[] = [
            { id: 'A', status: 'pending' },
            { id: 'B', status: 'sending' },
            { id: 'C', status: 'pending' },
        ];

        const { merged } = mergeQueueReload(inMemory, disk);
        assert.deepEqual(merged.map(i => i.id), ['A', 'B', 'C']);
        assert.strictEqual(merged[1], sending);
    });
});
