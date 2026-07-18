/**
 * Tests for computeMoveTargetFiles — the candidate list for the panel's
 * "Move selected to other todo file" action.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeMoveTargetFiles } from '../questTodoMoveTargets.js';

describe('computeMoveTargetFiles', () => {
    const files = [
        'todos.vscode_extension.todo.yaml',
        'prefix-test.vscode_extension.todo.yaml',
        'todos-archived.vscode_extension.todo.yaml',
        'todos-deleted.vscode_extension.todo.yaml',
        'session-todo.mbp.vscode_extension.todo.yaml',
    ];

    test('excludes terminal archive/delete siblings', () => {
        const targets = computeMoveTargetFiles(files, []);
        assert.ok(!targets.includes('todos-archived.vscode_extension.todo.yaml'));
        assert.ok(!targets.includes('todos-deleted.vscode_extension.todo.yaml'));
    });

    test('offers all non-terminal files when no source is given', () => {
        const targets = computeMoveTargetFiles(files, []);
        assert.deepEqual(targets, [
            'todos.vscode_extension.todo.yaml',
            'prefix-test.vscode_extension.todo.yaml',
            'session-todo.mbp.vscode_extension.todo.yaml',
        ]);
    });

    test('excludes the single common source file (no self-move)', () => {
        const targets = computeMoveTargetFiles(files, [
            'prefix-test.vscode_extension.todo.yaml',
        ]);
        assert.ok(!targets.includes('prefix-test.vscode_extension.todo.yaml'));
        assert.ok(targets.includes('todos.vscode_extension.todo.yaml'));
    });

    test('compares by basename so paths and names are equivalent', () => {
        const targets = computeMoveTargetFiles(files, [
            '_ai/quests/vscode_extension/prefix-test.vscode_extension.todo.yaml',
        ]);
        assert.ok(!targets.includes('prefix-test.vscode_extension.todo.yaml'));
    });

    test('offers every non-terminal file when the selection spans files', () => {
        const targets = computeMoveTargetFiles(files, [
            'prefix-test.vscode_extension.todo.yaml',
            'todos.vscode_extension.todo.yaml',
        ]);
        // Multiple distinct sources → no source is excluded (a todo from one
        // file can still be gathered into the other).
        assert.ok(targets.includes('prefix-test.vscode_extension.todo.yaml'));
        assert.ok(targets.includes('todos.vscode_extension.todo.yaml'));
    });

    test('ignores non-todo files defensively', () => {
        const targets = computeMoveTargetFiles(
            ['todos.q.todo.yaml', 'notes.md', 'overview.q.md'],
            [],
        );
        assert.deepEqual(targets, ['todos.q.todo.yaml']);
    });
});
