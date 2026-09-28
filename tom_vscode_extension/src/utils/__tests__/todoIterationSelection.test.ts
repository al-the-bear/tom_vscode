/**
 * Tests for the pure selection layer of the `<prefix>*` TODO ITERATION mode.
 *
 * In todo-iteration mode a queued prompt does not repeat a fixed number of
 * times — it walks the quest's numbered todos. Each dispatch picks the first
 * todo that is still `not-started`, ordered by its number and then by id, and
 * the dispatcher marks it `in-progress`. That status write is what makes the
 * walk terminate: a dispatched todo no longer qualifies, so the candidate set
 * strictly shrinks. Todos that are already in-progress / blocked / completed /
 * cancelled are skipped — an in-progress todo means "we already dispatched
 * this one".
 *
 * Everything here is context-free so the iteration rules can be pinned without
 * the vscode-coupled PromptQueueManager.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseTodoPrefixPattern,
    collectPrefixTodos,
    pickNextTodoForIteration,
    resolveTodoPrefixRepeatCount,
} from '../queueStep3Utils.js';

/** Terse fixture builder: `t('dsa2', 'not-started', 'Fix the thing')`. */
function t(id: string, status?: string, title?: string) {
    return { id, status, title };
}

describe('parseTodoPrefixPattern', () => {
    test('returns the prefix for a `prefix*` value', () => {
        assert.equal(parseTodoPrefixPattern('dsa*'), 'dsa');
    });

    test('trims surrounding whitespace', () => {
        assert.equal(parseTodoPrefixPattern('  dsa*  '), 'dsa');
    });

    test('returns undefined for values that are not a prefix pattern', () => {
        assert.equal(parseTodoPrefixPattern('3'), undefined);
        assert.equal(parseTodoPrefixPattern('batchCount'), undefined);
        assert.equal(parseTodoPrefixPattern(3), undefined);
        assert.equal(parseTodoPrefixPattern(undefined), undefined);
    });

    test('returns undefined for a bare `*` — an empty prefix matches nothing meaningful', () => {
        assert.equal(parseTodoPrefixPattern('*'), undefined);
    });
});

describe('collectPrefixTodos', () => {
    test('keeps only ids of the form prefix + digits, carrying the number', () => {
        const todos = [t('dsa1'), t('dsa2'), t('xyz3'), t('dsable'), t('dsa_4')];
        assert.deepEqual(
            collectPrefixTodos('dsa', todos).map(e => [e.id, e.index]),
            [['dsa1', 1], ['dsa2', 2]],
        );
    });

    test('takes the leading digit run and tolerates a trailing remainder', () => {
        const todos = [t('dsa15b'), t('dsa7-review'), t('dsa2x9')];
        assert.deepEqual(
            collectPrefixTodos('dsa', todos).map(e => [e.id, e.index]),
            [['dsa2x9', 2], ['dsa7-review', 7], ['dsa15b', 15]],
        );
    });

    test('sorts by number ascending, then by id alphabetically for ties', () => {
        const todos = [t('dsa2-b'), t('dsa10'), t('dsa2-a'), t('dsa1')];
        assert.deepEqual(
            collectPrefixTodos('dsa', todos).map(e => e.id),
            ['dsa1', 'dsa2-a', 'dsa2-b', 'dsa10'],
        );
    });

    test('carries the title through and normalises a missing status', () => {
        const [entry] = collectPrefixTodos('dsa', [t('dsa1', undefined, 'Fix the thing')]);
        assert.equal(entry.title, 'Fix the thing');
        assert.equal(entry.status, 'not-started');
    });

    test('normalises status case and underscores from hand-edited YAML', () => {
        const entries = collectPrefixTodos('dsa', [t('dsa1', 'Not_Started'), t('dsa2', ' IN-PROGRESS ')]);
        assert.deepEqual(entries.map(e => e.status), ['not-started', 'in-progress']);
    });

    test('returns an empty list when nothing matches', () => {
        assert.deepEqual(collectPrefixTodos('zzz', [t('dsa1')]), []);
    });
});

describe('pickNextTodoForIteration', () => {
    test('picks the lowest-numbered not-started todo', () => {
        const todos = [t('dsa3'), t('dsa1'), t('dsa2')];
        assert.equal(pickNextTodoForIteration('dsa*', todos)?.id, 'dsa1');
    });

    test('starts at the first index that actually exists, not at 1', () => {
        const todos = [t('dsa7'), t('dsa9')];
        const next = pickNextTodoForIteration('dsa*', todos);
        assert.equal(next?.id, 'dsa7');
        assert.equal(next?.index, 7);
    });

    test('skips in-progress todos — they were already dispatched', () => {
        const todos = [t('dsa1', 'in-progress'), t('dsa2', 'not-started')];
        assert.equal(pickNextTodoForIteration('dsa*', todos)?.id, 'dsa2');
    });

    test('skips completed, cancelled and blocked todos', () => {
        const todos = [
            t('dsa1', 'completed'),
            t('dsa2', 'cancelled'),
            t('dsa3', 'blocked'),
            t('dsa4', 'not-started'),
        ];
        assert.equal(pickNextTodoForIteration('dsa*', todos)?.id, 'dsa4');
    });

    test('walks same-numbered todos in alphabetical order', () => {
        // Both carry index 2, so the loop counter stays at 2 while the id
        // advances — `dsa2-a` first, then `dsa2-b` once the first is marked.
        const todos = [t('dsa2-b'), t('dsa2-a')];
        assert.equal(pickNextTodoForIteration('dsa*', todos)?.id, 'dsa2-a');
        const afterFirst = [t('dsa2-b'), t('dsa2-a', 'in-progress')];
        const next = pickNextTodoForIteration('dsa*', afterFirst);
        assert.equal(next?.id, 'dsa2-b');
        assert.equal(next?.index, 2);
    });

    test('returns undefined once every matching todo has been picked up', () => {
        const todos = [t('dsa1', 'in-progress'), t('dsa2', 'completed')];
        assert.equal(pickNextTodoForIteration('dsa*', todos), undefined);
    });

    test('returns undefined when the prefix matches no numbered todo', () => {
        assert.equal(pickNextTodoForIteration('zzz*', [t('dsa1')]), undefined);
    });

    test('returns undefined when the value is not a prefix pattern', () => {
        assert.equal(pickNextTodoForIteration('3', [t('dsa1')]), undefined);
        assert.equal(pickNextTodoForIteration(3, [t('dsa1')]), undefined);
    });
});

describe('resolveTodoPrefixRepeatCount still agrees with the shared parsing', () => {
    test('the count is the highest index among the matching todos', () => {
        const ids = ['dsa1', 'dsa2', 'dsa15', 'dsable', 'xyz4'];
        assert.equal(resolveTodoPrefixRepeatCount('dsa*', ids), 15);
    });

    test('the count ignores status — it is the series size, not the work left', () => {
        // Iteration skips completed todos; the displayed total does not shrink.
        const todos = [t('dsa1', 'completed'), t('dsa2', 'completed'), t('dsa9', 'not-started')];
        assert.equal(resolveTodoPrefixRepeatCount('dsa*', todos.map(x => x.id)), 9);
        assert.equal(pickNextTodoForIteration('dsa*', todos)?.id, 'dsa9');
    });
});
