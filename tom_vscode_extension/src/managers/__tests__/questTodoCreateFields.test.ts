/**
 * The two create paths must persist the same fields, and a move must lose
 * nothing.
 *
 * THE BUG THIS PINS (SCE5). `createTodo` and `createTodoInFile` were written as
 * copies of one another and drifted: `createTodoInFile` wrote `scope`,
 * `references`, `blocked_by` and the completion stamps; `createTodo` — the path
 * the MCP tool uses — wrote none of them. The caller could not tell, because
 * `createTodo` returns `{...todo}`, so every field it failed to write came back
 * in the response as though it had. Measured on a live quest file: every todo
 * created through the tool lost its `scope` and `references`.
 *
 * `moveTodo` is the second victim and the worse one. It re-creates the todo in
 * the target file through `createTodo`, so MOVING a todo stripped the same
 * fields — data loss on a routine operation rather than only at creation.
 *
 * WHY A TEST PER FIELD IS NOT ENOUGH, and why the last case exists. Pinning the
 * known field list only proves the copies agree about the fields somebody
 * thought of. A move reads a todo off disk and writes it back, so anything the
 * builder does not know about is dropped — a field a future schema adds, or one
 * a person wrote by hand. The round-trip case holds the builder to carrying
 * what it does not recognise, which is the property that makes a move lossless
 * rather than merely current.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-create-fields-'));
installVscodeStub({ workspaceFolders: [tmpRoot] });

// Safe to import after the stub is wired into the resolver.
import { createTodo, createTodoInFile, moveTodo } from '../questTodoManager.js';

const QUEST = 'cfquest';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);

/** Every optional field the two builders are expected to agree about. */
const RICH = {
    title: 'A richly furnished todo',
    priority: 'high',
    tags: ['alpha', 'beta'],
    notes: 'some notes',
    dependencies: ['dep-one'],
    blocked_by: ['blocker-one'],
    references: ['doc/a.md', 'doc/b.md'],
    scope: {
        area: 'tooling',
        projects: ['proj_one', 'proj_two'],
        files: ['lib/a.dart'],
    },
};

function readTodo(file: string, id: string): Record<string, unknown> | undefined {
    const doc = yaml.parse(fs.readFileSync(path.join(questDir, file), 'utf8')) as {
        todos?: Record<string, unknown>[];
    };
    return (doc.todos ?? []).find((t) => t.id === id);
}

describe('SCE5: both create paths persist the same fields, and a move is lossless', () => {
    before(() => {
        fs.mkdirSync(questDir, { recursive: true });
    });
    after(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('SCE5-1: createTodo — the MCP path — writes scope, references and '
        + 'blocked_by to disk [2026-09-18] (PASS)', () => {
        createTodo(QUEST, {
            id: 'mcp-path',
            description: 'created through the tool path',
            status: 'not-started',
            ...RICH,
        } as never);

        const onDisk = readTodo(`todos.${QUEST}.todo.yaml`, 'mcp-path');
        assert.ok(onDisk, 'the todo was not written at all');
        assert.deepEqual(onDisk!.blocked_by, RICH.blocked_by);
        assert.deepEqual(onDisk!.scope, RICH.scope);
        // A reference given as a bare string is stored as `{path}` — the shape
        // the schema types and the reader expects. Before SCE5 the writer put
        // the strings on disk verbatim and the reader, which filtered to maps,
        // read the list back EMPTY; the field then vanished on the next write.
        // Pinning the normalised shape is what makes the two forms one value.
        assert.deepEqual(onDisk!.references, RICH.references.map((r) => ({ path: r })));
    });

    test('SCE5-2: createTodoInFile writes the same fields as createTodo '
        + '[2026-09-18] (PASS)', () => {
        createTodoInFile(path.join(questDir, `other.${QUEST}.todo.yaml`), {
            id: 'in-file-path',
            description: 'created through the file path',
            status: 'not-started',
            ...RICH,
        } as never);

        const a = readTodo(`todos.${QUEST}.todo.yaml`, 'mcp-path')!;
        const b = readTodo(`other.${QUEST}.todo.yaml`, 'in-file-path')!;
        const shape = (t: Record<string, unknown>) =>
            Object.keys(t).filter((k) => k !== 'id' && k !== 'description').sort();

        assert.deepEqual(
            shape(b),
            shape(a),
            'the two create paths wrote different field sets — they have drifted again',
        );
        assert.deepEqual(b.scope, a.scope, 'the two paths disagree about how scope is written');
    });

    test('SCE5-3: moving a todo keeps every field it arrived with '
        + '[2026-09-18] (PASS)', () => {
        const before = readTodo(`todos.${QUEST}.todo.yaml`, 'mcp-path')!;
        moveTodo(QUEST, 'mcp-path', `moved.${QUEST}.todo.yaml`);
        const after = readTodo(`moved.${QUEST}.todo.yaml`, 'mcp-path');

        assert.ok(after, 'the todo did not arrive in the target file');
        for (const key of Object.keys(before)) {
            assert.deepEqual(
                after![key],
                before[key],
                `moving the todo changed or dropped \`${key}\``,
            );
        }
    });

    test('SCE5-4: a move carries a field the builder does not know about '
        + '[2026-09-18] (PASS)', () => {
        // Written by hand into the source file, as a schema addition or a
        // person would. A builder that enumerates known keys drops this; one
        // that carries the rest does not.
        const src = path.join(questDir, `todos.${QUEST}.todo.yaml`);
        const doc = yaml.parse(fs.readFileSync(src, 'utf8')) as {
            todos: Record<string, unknown>[];
        };
        doc.todos.push({
            id: 'unknown-field',
            description: 'carries a field no builder enumerates',
            status: 'not-started',
            future_field: 'must survive a move',
        });
        fs.writeFileSync(src, yaml.stringify(doc), 'utf8');

        moveTodo(QUEST, 'unknown-field', `moved.${QUEST}.todo.yaml`);
        const after = readTodo(`moved.${QUEST}.todo.yaml`, 'unknown-field');

        assert.ok(after, 'the todo did not arrive in the target file');
        assert.equal(
            after!.future_field,
            'must survive a move',
            'the move dropped a field the builder does not enumerate',
        );
    });
});
