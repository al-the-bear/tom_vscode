/**
 * Moving an entry of an editor's list one place (src/utils/listOrder.ts).
 *
 *   LO-1 moveById swaps the entry with its neighbour and leaves the input alone; it answers undefined at the
 *        list's ends and for an id the list does not have
 *   LO-2 applyListOrder: the ids the stored order names first, in its order; entries it does not name follow
 *        as they were; ids it names that are gone are passed over; no order leaves the list as it is
 *   LO-3 movedListOrder is the whole shown list in its new order, so a first move of a list without a stored
 *        order fixes every entry's place
 *   LO-4 canMove is what the buttons show: off at the ends and without a selection; moveDirection reads only
 *        `up` and `down`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyListOrder, canMove, moveById, moveDirection, movedListOrder } from '../listOrder.js';

const item = (id: string) => ({ id });
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

describe('editor lists: moving an entry', () => {
    test('LO-1: moveById', () => {
        const list = [item('a'), item('b'), item('c')];
        assert.deepEqual(ids(moveById(list, 'b', 'up', (i) => i.id)!), ['b', 'a', 'c']);
        assert.deepEqual(ids(moveById(list, 'b', 'down', (i) => i.id)!), ['a', 'c', 'b']);
        assert.deepEqual(ids(list), ['a', 'b', 'c'], 'the input is not changed');
        assert.equal(moveById(list, 'a', 'up', (i) => i.id), undefined);
        assert.equal(moveById(list, 'c', 'down', (i) => i.id), undefined);
        assert.equal(moveById(list, 'x', 'up', (i) => i.id), undefined);
    });

    test('LO-2: applyListOrder', () => {
        const list = [item('a'), item('b'), item('c'), item('d')];
        assert.deepEqual(ids(applyListOrder(list, ['c', 'gone', 'a'], (i) => i.id)), ['c', 'a', 'b', 'd']);
        assert.deepEqual(ids(applyListOrder(list, undefined, (i) => i.id)), ['a', 'b', 'c', 'd']);
        assert.deepEqual(ids(applyListOrder(list, [], (i) => i.id)), ['a', 'b', 'c', 'd']);
        assert.deepEqual(ids(applyListOrder(list, ['d', 'd', 'a'], (i) => i.id)), ['d', 'a', 'b', 'c'], 'an id named twice counts once');
    });

    test('LO-3: movedListOrder', () => {
        assert.deepEqual(movedListOrder(['a', 'b', 'c'], 'c', 'up'), ['a', 'c', 'b']);
        assert.equal(movedListOrder(['a', 'b', 'c'], 'c', 'down'), undefined);
        const shown = ids(applyListOrder([item('a'), item('b'), item('c')], movedListOrder(['a', 'b', 'c'], 'a', 'down'), (i) => i.id));
        assert.deepEqual(shown, ['b', 'a', 'c']);
    });

    test('LO-4: canMove and moveDirection', () => {
        assert.deepEqual(canMove(['a', 'b', 'c'], 'a'), { up: false, down: true });
        assert.deepEqual(canMove(['a', 'b', 'c'], 'b'), { up: true, down: true });
        assert.deepEqual(canMove(['a', 'b', 'c'], 'c'), { up: true, down: false });
        assert.deepEqual(canMove(['a'], 'a'), { up: false, down: false });
        assert.deepEqual(canMove(['a', 'b'], undefined), { up: false, down: false });
        assert.deepEqual(canMove(['a', 'b'], 'x'), { up: false, down: false });
        assert.equal(moveDirection('up'), 'up');
        assert.equal(moveDirection('down'), 'down');
        assert.equal(moveDirection('sideways'), undefined);
        assert.equal(moveDirection(undefined), undefined);
    });
});
