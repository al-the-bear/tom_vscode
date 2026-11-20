/**
 * The role a prompt runs as and the chat variable while queue items with roles send (gsel3; utils/promptRole.ts).
 *
 *   PR-1 the order: todo > item > step > run default > chat variable; '' and `default` name no role
 *   PR-2 which origins the chat variable shows: the queue's own (todo, item, run default), not the step's
 *   PR-3 RoleOverrides: one hold shown and put back; overlapping holds show the newest and put back the first
 *        value after the last; holding again moves a key to the end; releasing an unknown key does nothing
 *   PR-4 a value changed by someone else while held is kept: nothing more is written until every hold is released
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { effectivePromptRole, RoleOverrides, rolesShownInChatVariable } from '../promptRole.js';

describe('prompt role', () => {
    test('PR-1: the order', () => {
        const all = { queued: { todoRole: 'a', itemRole: 'b', runDefaultRole: 'd' }, stepRole: 'c', chatRole: 'e' };
        assert.deepEqual(effectivePromptRole(all), { role: 'a', from: 'todo' });
        assert.deepEqual(effectivePromptRole({ ...all, queued: { itemRole: 'b', runDefaultRole: 'd' } }), { role: 'b', from: 'item' });
        assert.deepEqual(effectivePromptRole({ ...all, queued: { runDefaultRole: 'd' } }), { role: 'c', from: 'step' }, 'the step before the run default');
        assert.deepEqual(effectivePromptRole({ ...all, queued: { runDefaultRole: 'd' }, stepRole: '' }), { role: 'd', from: 'runDefault' }, 'a step naming none');
        assert.deepEqual(effectivePromptRole({ chatRole: 'e' }), { role: 'e', from: 'chat' });
        assert.deepEqual(effectivePromptRole({ queued: { itemRole: '' }, chatRole: 'default' }), { role: '', from: 'none' }, '"" and default name none');
        assert.deepEqual(effectivePromptRole({ queued: { todoRole: '  ' }, stepRole: 'c' }), { role: 'c', from: 'step' });
    });

    test('PR-2: what the chat variable shows', () => {
        assert.deepEqual(['todo', 'item', 'step', 'runDefault', 'chat', 'none'].map((f) => rolesShownInChatVariable(f as never)), [true, true, false, true, false, false]);
    });

    test('PR-3: holds and releases', () => {
        let value = 'base';
        const writes: string[] = [];
        const r = new RoleOverrides(() => value, (v) => { value = v; writes.push(v); });
        r.hold('i1', 'a');
        assert.equal(value, 'a');
        r.hold('i2', 'b');
        assert.equal(value, 'b', 'the newest');
        r.hold('i1', 'a');
        assert.equal(value, 'a', 'holding again moves it to the end');
        r.release('i1');
        assert.equal(value, 'b', 'the remaining hold');
        r.release('nobody');
        assert.equal(value, 'b');
        r.release('i2');
        assert.equal(value, 'base', 'the value before the first hold');
        assert.deepEqual(r.keys(), []);
        assert.deepEqual(writes, ['a', 'b', 'a', 'b', 'base']);
        // The same value as the base: nothing written.
        writes.length = 0;
        r.hold('i3', 'base');
        r.release('i3');
        assert.deepEqual(writes, [], 'nothing written when the held role is the value already');
    });

    test('PR-4: a value changed by someone else is kept', () => {
        let value = 'base';
        const r = new RoleOverrides(() => value, (v) => { value = v; });
        r.hold('i1', 'a');
        value = 'user';
        r.hold('i2', 'b');
        assert.equal(value, 'user', 'not overwritten');
        r.release('i1');
        r.release('i2');
        assert.equal(value, 'user', 'nor put back');
        r.hold('i3', 'c');
        assert.equal(value, 'c', 'a new round starts again');
        r.release('i3');
        assert.equal(value, 'user');
    });
});
