/**
 * Wiring guard for the live quest-todo store adapter.
 *
 * `tomAi_createQuestTodo` accepts a `decisions` list and
 * `questTodoManager.createTodo` persists one. Between them sits
 * `liveQuestTodoStore` in `chat-enhancement-tools.ts`, which used to rebuild
 * the todo field by field:
 *
 *     questTodo.createTodo(questId, { id: todo.id, title: todo.title, ... })
 *
 * `decisions` was not in that list, so every decision the model recorded was
 * accepted by the tool, reported back in its `ok` response, and silently
 * dropped on the way to disk. The whole point of `status: decision-needed` is
 * that the questions travel with the todo; a todo that says it is waiting on a
 * decision nobody can read is worse than one that never claimed to be.
 *
 * The unit tests did not catch it because the fake store they inject spreads
 * `...todo` — it is *more permissive than production*, so it round-trips any
 * field including ones the real adapter discards. A test double that accepts
 * more than the real collaborator cannot fail on a field the real one drops.
 *
 * The fix is not to add `decisions` to the whitelist — it is to delete the
 * whitelist. `createTodo` / `updateTodo` already build the persisted node from
 * an explicit field list of their own, so a second hand-maintained copy one
 * layer up buys nothing and silently eats every field added after it was
 * written. This guard pins that: the adapter forwards what it was given.
 *
 * Asserted against the source because `chat-enhancement-tools.ts` imports
 * `vscode` and cannot be loaded under `node:test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Project root is three levels up from out/tools/__tests__. */
const root = join(__dirname, '..', '..', '..');
const source = readFileSync(join(root, 'src', 'tools', 'chat-enhancement-tools.ts'), 'utf-8');

/** The body of a method in the `liveQuestTodoStore` object literal. */
function methodBody(name: string): string {
    const start = source.indexOf(`    ${name}(questId`);
    assert.ok(start >= 0, `no ${name}( method found on the live quest-todo store`);
    const end = source.indexOf('\n    },', start);
    assert.ok(end > start, `could not find the end of ${name}()`);
    return source.slice(start, end);
}

describe('the live quest-todo store forwards what it was handed', () => {
    test('create passes the todo through instead of rebuilding it field by field', () => {
        const body = methodBody('create');
        assert.match(
            body,
            /questTodo\.createTodo\(\s*questId,\s*todo\b/,
            'create() must hand the todo to the manager as one object. Rebuilding it from a '
            + 'field list means every field added later — `decisions` was the first — is dropped '
            + 'silently, with the tool still reporting success.',
        );
        assert.doesNotMatch(
            body,
            /id:\s*todo\.id/,
            'create() is rebuilding the todo from individual fields again; that whitelist is '
            + 'exactly what dropped `decisions`.',
        );
    });

    test('update passes the patch through instead of rebuilding it field by field', () => {
        const body = methodBody('update');
        assert.match(
            body,
            /questTodo\.updateTodo\(\s*questId,\s*todoId,\s*updates\b/,
            'update() must forward the patch as one object — answering a decision goes through '
            + 'this path, so a whitelist here makes the answers unsaveable too.',
        );
        assert.doesNotMatch(
            body,
            /title:\s*updates\.title/,
            'update() is rebuilding the patch from individual fields again.',
        );
    });
});
