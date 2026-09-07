/**
 * SCC84 — a todo write that does not reach disk must not be reported as success.
 *
 * THE OBSERVED FAILURE. `tomAi_createQuestTodo` returned `{ok: true}` with the
 * complete todo echoed back in its response, and the todo was in no
 * `*.todo.yaml` file afterwards — archived and deleted siblings included. It was
 * recovered only because a sibling todo's notes happened to mention the id. The
 * information lost was a measured, high-priority interpreter bug.
 *
 * WHAT THE CAUSE IS NOT. The obvious diagnosis is a read-modify-write race
 * between two creates in one burst, and the obvious fix is a mutex keyed on the
 * file path. Measured: `questTodoManager` contains no `async`, `await` or
 * `Promise` at all, so every mutator runs synchronously from `loadDocument` to
 * `writeFileSync` with no suspension point between. Two creates in one extension
 * host CANNOT interleave, and a mutex would serialise what is already serial.
 *
 * The write is therefore lost to a writer outside this process — another
 * extension host over the shared `_ai` clone, a panel saving a stale whole-file
 * buffer, or a git merge driver. None of those is reachable from a lock, and all
 * of them are visible to a read-back. That is what these cases pin.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createRequire } from 'module';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

/**
 * The REAL `fs` module object, not the `import * as fs` namespace.
 *
 * TypeScript compiles the namespace import into a wrapper whose properties are
 * getters, so assigning to it throws "which has only a getter". The wrapper
 * delegates to this object, so patching here is what the module under test
 * actually sees.
 */
const realFs = createRequire(__filename)('fs') as typeof fs;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-lostwrite-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, deleteTodo } from '../questTodoManager.js';

const QUEST = 'lostquest';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);
const todoFile = path.join(questDir, `todos.${QUEST}.todo.yaml`);

const FIXTURE = `quest: "${QUEST}"
created: "2026-01-01"
updated: "2026-01-01"
todos:
  - id: pre-existing
    description: Already here
    status: not-started
    created: "2026-01-01"
`;

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
    fs.writeFileSync(todoFile, FIXTURE, 'utf8');
});

/**
 * Stand in for the external writer. `writeFileSync` is patched to drop the
 * payload and restore the file to what it held before — exactly what another
 * process clobbering the file looks like from in here, and indistinguishable
 * from the observed failure.
 */
function withLostWrite<T>(body: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(realFs, 'writeFileSync')!;
    const real = realFs.writeFileSync;
    const before = fs.readFileSync(todoFile, 'utf8');
    Object.defineProperty(realFs, 'writeFileSync', {
        configurable: true,
        writable: true,
        value: (target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
            if (String(target) === todoFile) {
                return (real as (...a: unknown[]) => unknown)(target, before, 'utf8');
            }
            return (real as (...a: unknown[]) => unknown)(target, ...rest);
        },
    });
    try {
        return body();
    } finally {
        Object.defineProperty(realFs, 'writeFileSync', descriptor);
    }
}

describe('SCC84: a lost todo write is not reported as success', () => {
    test('F-SCC84-1: createTodo succeeds and the todo is readable back '
        + '[2026-09-07]', () => {
        const created = createTodo(QUEST, {
            id: 'landed-1', description: 'Reaches disk', status: 'not-started',
        });
        assert.equal(created.id, 'landed-1');
        assert.match(fs.readFileSync(todoFile, 'utf8'), /id: landed-1/);
    });

    test('F-SCC84-2: createTodo THROWS when the write is lost, rather than '
        + 'returning the echoed todo [2026-09-07]', () => {
        assert.throws(
            () => withLostWrite(() => createTodo(QUEST, {
                id: 'lost-1', description: 'Never reaches disk', status: 'not-started',
            })),
            /not in todos\.lostquest\.todo\.yaml when the file is read back/,
        );
        // The point of the case: the id really is absent, so the old behaviour
        // would have been a success response for a todo nobody can find.
        assert.doesNotMatch(fs.readFileSync(todoFile, 'utf8'), /id: lost-1/);
    });

    test('F-SCC84-3: deleteTodo THROWS when the removal is lost [2026-09-07]', () => {
        assert.throws(
            () => withLostWrite(() => deleteTodo(QUEST, 'pre-existing')),
            /STILL in todos\.lostquest\.todo\.yaml when the file is read back/,
        );
        assert.match(fs.readFileSync(todoFile, 'utf8'), /id: pre-existing/);
    });

    test('F-SCC84-4: deleteTodo succeeds normally and the todo is gone '
        + '[2026-09-07]', () => {
        assert.equal(deleteTodo(QUEST, 'pre-existing'), true);
        assert.doesNotMatch(fs.readFileSync(todoFile, 'utf8'), /id: pre-existing/);
    });
});
