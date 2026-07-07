/**
 * The TODO Log view lists the TODO references extracted from each answer's
 * persisted `variables:` metadata. Two facts about that data make these helpers
 * necessary:
 *
 *  1. The same ref can appear more than once in one answer — the model writes
 *     its own `variables:` block AND the trail service appends a second block
 *     built from `responseValues`, so a single TODO shows up twice. The view
 *     must render one link per distinct TODO, not one per line.
 *  2. A ref is the qualified id `<ws-path>/<file>.todo.yaml/<todoId>`. To show a
 *     human label (and to look up the title) the view needs the file path and
 *     the todo id split back out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseTodoRef, dedupeTodoRefs } from '../todoLogRefs.js';

describe('parseTodoRef', () => {
    it('splits a qualified ref into file path and todo id', () => {
        const r = parseTodoRef('_ai/quests/tom_brain/todos.tom_brain.todo.yaml/ub4');
        assert.equal(r.file, '_ai/quests/tom_brain/todos.tom_brain.todo.yaml');
        assert.equal(r.fileName, 'todos.tom_brain.todo.yaml');
        assert.equal(r.id, 'ub4');
        assert.equal(r.ref, '_ai/quests/tom_brain/todos.tom_brain.todo.yaml/ub4');
    });

    it('handles a bare file name with no directory', () => {
        const r = parseTodoRef('mydoc.todo.yaml/AA1');
        assert.equal(r.file, 'mydoc.todo.yaml');
        assert.equal(r.fileName, 'mydoc.todo.yaml');
        assert.equal(r.id, 'AA1');
    });

    it('falls back to the whole string as id when there is no .todo.yaml marker', () => {
        const r = parseTodoRef('not-a-real-ref');
        assert.equal(r.file, '');
        assert.equal(r.fileName, '');
        assert.equal(r.id, 'not-a-real-ref');
    });

    it('trims surrounding whitespace', () => {
        const r = parseTodoRef('  _ai/q/x.todo.yaml/z1  ');
        assert.equal(r.file, '_ai/q/x.todo.yaml');
        assert.equal(r.id, 'z1');
    });
});

describe('dedupeTodoRefs', () => {
    it('removes exact duplicate refs, preserving first-seen order', () => {
        const refs = [
            '_ai/quests/tom_brain/todos.tom_brain.todo.yaml/ub4',
            '_ai/quests/tom_brain/todos.tom_brain.todo.yaml/ub4',
        ];
        assert.deepEqual(dedupeTodoRefs(refs), [
            '_ai/quests/tom_brain/todos.tom_brain.todo.yaml/ub4',
        ]);
    });

    it('keeps distinct refs and preserves order', () => {
        const refs = ['a.todo.yaml/1', 'b.todo.yaml/2', 'a.todo.yaml/1', 'c.todo.yaml/3'];
        assert.deepEqual(dedupeTodoRefs(refs), [
            'a.todo.yaml/1',
            'b.todo.yaml/2',
            'c.todo.yaml/3',
        ]);
    });

    it('ignores blank / whitespace-only entries and trims', () => {
        const refs = ['  a.todo.yaml/1  ', '', '   ', 'a.todo.yaml/1'];
        assert.deepEqual(dedupeTodoRefs(refs), ['a.todo.yaml/1']);
    });

    it('returns an empty array for empty input', () => {
        assert.deepEqual(dedupeTodoRefs([]), []);
    });
});
