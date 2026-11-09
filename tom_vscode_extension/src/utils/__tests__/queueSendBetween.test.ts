/**
 * "Send between iterations" (src/utils/queueSendBetween.ts).
 *
 *   SB-1 a loop item: a todo walk (`prefix*`) or a counter above 1; a single run is not one
 *   SB-2 Send next means "between iterations" only for the pending item directly under a sending loop
 *   SB-3 marking: one mark at a time (marking another moves it); clicking a marked item unmarks it;
 *        an item not under a running loop is not marked
 *   SB-4 at the boundary: the marked pending item, only after an iteration went out and while more are
 *        left (a loop ending after this iteration sends nothing between: the marked item simply runs next)
 *   SB-5 the order: the marked item moves directly in front of the loop item, everything else stays
 *   SB-6 where Queue next puts an item: directly under the sending item, in front of the first pending
 *        item when that comes earlier or nothing is sending, at the end when there is neither
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { isLoopItem, itemToSendBetween, nextQueuePosition, orderForBetween, runningLoopAbove, toggleSendBetween, type BetweenQueueItem } from '../queueSendBetween.js';

const items = (): BetweenQueueItem[] => [
    { id: 'done', status: 'sent' },
    { id: 'loop', status: 'sending', repeatCount: 'qr*' },
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'pending' },
];

describe('send between iterations', () => {
    test('SB-1: loop items', () => {
        assert.equal(isLoopItem({ id: 'x', status: 'sending', repeatCount: 'qr*' }), true);
        assert.equal(isLoopItem({ id: 'x', status: 'sending', repeatCount: 3 }), true);
        assert.equal(isLoopItem({ id: 'x', status: 'sending', repeatCount: 'count', resolvedRepeatCount: 2 }), true);
        assert.equal(isLoopItem({ id: 'x', status: 'sending', repeatCount: 1 }), false);
        assert.equal(isLoopItem({ id: 'x', status: 'sending' }), false);
    });

    test('SB-2: only directly under a sending loop', () => {
        const q = items();
        assert.equal(runningLoopAbove(q, 'a')?.id, 'loop');
        assert.equal(runningLoopAbove(q, 'b'), undefined, 'not directly under');
        assert.equal(runningLoopAbove([{ id: 'one', status: 'sending', repeatCount: 1 }, { id: 'a', status: 'pending' }], 'a'), undefined, 'not a loop');
        assert.equal(runningLoopAbove([{ id: 'loop', status: 'pending', repeatCount: 3 }, { id: 'a', status: 'pending' }], 'a'), undefined, 'loop not running');
        assert.equal(runningLoopAbove([{ id: 'loop', status: 'sending', repeatCount: 3 }, { id: 'a', status: 'staged' }], 'a'), undefined, 'not pending');
    });

    test('SB-3: one mark at a time, toggled', () => {
        const q = items();
        assert.deepEqual(toggleSendBetween(q, 'a'), ['a']);
        assert.equal(q[2].sendBetween, true);
        assert.deepEqual(toggleSendBetween(q, 'a'), ['a'], 'a second click unmarks');
        assert.equal(q[2].sendBetween, undefined);
        assert.deepEqual(toggleSendBetween(q, 'b'), [], 'not under the loop');
        q[2].sendBetween = true;
        const moved = [{ id: 'l1', status: 'sending', repeatCount: 2 }, { id: 'x', status: 'pending' }, ...q];
        moved[1].sendBetween = undefined;
        assert.deepEqual(toggleSendBetween(moved, 'x'), ['a', 'x'], 'marking another moves the mark');
        assert.equal(moved.find((i) => i.id === 'a')!.sendBetween, undefined);
    });

    test('SB-4: the boundary', () => {
        const q = items();
        q[2].sendBetween = true;
        const loop = q[1];
        assert.equal(itemToSendBetween(q, loop, 1, true)?.id, 'a');
        assert.equal(itemToSendBetween(q, loop, 0, true), undefined, 'before the first iteration');
        assert.equal(itemToSendBetween(q, loop, 3, false), undefined, 'the loop ends: no yield');
        q[2].status = 'staged';
        assert.equal(itemToSendBetween(q, loop, 1, true), undefined, 'a marked item no longer pending');
    });

    test('SB-5: the order', () => {
        const q = items();
        assert.deepEqual(orderForBetween(q, q[1], q[2]).map((i) => i.id), ['done', 'a', 'loop', 'b']);
    });

    test('SB-6: where Queue next goes', () => {
        assert.equal(nextQueuePosition(items()), 2, 'under the sending loop');
        assert.equal(nextQueuePosition([{ id: 's', status: 'staged' }, { id: 'p', status: 'pending' }, { id: 'x', status: 'sending' }]), 1, 'a pending item before the sending one goes first');
        assert.equal(nextQueuePosition([{ id: 's', status: 'staged' }, { id: 'p', status: 'pending' }]), 1, 'nothing sending: in front of the first pending');
        assert.equal(nextQueuePosition([{ id: 's', status: 'staged' }, { id: 'd', status: 'sent' }]), 2, 'neither: at the end');
        assert.equal(nextQueuePosition([]), 0);
    });
});
