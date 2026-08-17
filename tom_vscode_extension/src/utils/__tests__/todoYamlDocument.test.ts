/**
 * Tests for the todo-YAML parse guard.
 *
 * The failure this guards against is silent at the moment it is created and
 * opaque at the moment it bites: a todo file with a duplicate map key parses
 * (the yaml package records the problem in `doc.errors` rather than throwing),
 * so every reader carries on — but `doc.toString()` then refuses with
 * `Document with errors cannot be stringified`, naming neither the file nor
 * the line. These tests pin the replacement: a named error carrying the path,
 * the line and the parser's own message.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    TodoYamlError,
    parseTodoYaml,
    loadTodoYaml,
} from '../todoYamlDocument.js';

/** Run `fn`, asserting it threw a {@link TodoYamlError}, and return it. */
function thrownError(fn: () => unknown): TodoYamlError {
    try {
        fn();
    } catch (e) {
        assert.ok(e instanceof TodoYamlError, `expected TodoYamlError, got ${String(e)}`);
        return e;
    }
    assert.fail('expected TodoYamlError, nothing was thrown');
}

/** A todo entry carrying `completed_date` twice — the real corruption shape. */
const DUPLICATE_KEY_YAML = `quest: "myquest"
created: "2026-01-01"
todos:
  - id: t1
    description: A completed todo
    status: completed
    completed_date: 2026-08-09
    notes: some notes
    completed_date: 2026-08-09
    archived: 2026-08-09
`;

describe('parseTodoYaml', () => {
    test('returns the Document for well-formed YAML', () => {
        const doc = parseTodoYaml('/x/todos.q.todo.yaml', 'quest: q\ntodos: []\n');
        assert.equal(doc.get('quest'), 'q');
    });

    test('throws TodoYamlError naming the file, the line and the parser message', () => {
        const filePath = '/x/todos-archived.q.todo.yaml';
        const err = thrownError(() => parseTodoYaml(filePath, DUPLICATE_KEY_YAML));

        assert.equal(err.filePath, filePath);
        assert.equal(err.problems.length, 1);

        const [problem] = err.problems;
        assert.equal(problem.code, 'DUPLICATE_KEY');
        assert.equal(problem.line, 9, 'the second completed_date is on line 9');
        assert.equal(problem.column, 5);
        assert.match(problem.message, /Map keys must be unique/);

        // The rendered message is what a user actually sees — it must carry all
        // three, since the whole point is that the old error carried none.
        assert.match(err.message, /todos-archived\.q\.todo\.yaml/);
        assert.match(err.message, /line 9/);
        assert.match(err.message, /Map keys must be unique/);
        assert.doesNotMatch(err.message, /cannot be stringified/);
    });

    test('reports every problem, not just the first', () => {
        const twice = `todos:
  - id: t1
    status: completed
    status: completed
  - id: t2
    notes: a
    notes: b
`;
        const err = thrownError(() => parseTodoYaml('/x/f.todo.yaml', twice));
        assert.equal(err.problems.length, 2);
        assert.deepEqual(err.problems.map(p => p.line), [4, 7]);
    });
});

describe('loadTodoYaml', () => {
    test('reads and parses a file from disk', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-yaml-'));
        try {
            const file = path.join(tmp, 'todos.q.todo.yaml');
            fs.writeFileSync(file, 'quest: q\ntodos: []\n', 'utf8');
            assert.equal(loadTodoYaml(file).get('quest'), 'q');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('names the real on-disk path in the error', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-yaml-'));
        try {
            const file = path.join(tmp, 'todos-archived.q.todo.yaml');
            fs.writeFileSync(file, DUPLICATE_KEY_YAML, 'utf8');
            const err = thrownError(() => loadTodoYaml(file));
            assert.equal(err.filePath, file);
            assert.match(err.message, /line 9/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
