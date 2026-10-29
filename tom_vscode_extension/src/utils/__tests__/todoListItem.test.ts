/**
 * One row of the todo panel's list (src/utils/todoListItem.ts): the fields a
 * list row, its filters and its sort read, built in one place.
 *
 * The list used to be built by five copies of the same object literal in
 * questTodoPanel-handler.ts, each copying eight fields. `user_action` was not
 * among them, so no row ever showed the 👤 mark and the 👤 filter found
 * nothing; `completed_date`, which the list's "Completed" sort reads, was lost
 * the same way.
 *
 *   TL-1  a user-action todo keeps `user_action: true`; any other todo carries no such key
 *   TL-2  `completed_date` reaches the row (the list sorts by it)
 *   TL-3  the title falls back to the first 60 characters of the description; the id and source file are the given ones
 *   TL-4  questTodoPanel-handler.ts builds every list row through todoListItem — no copy of the old literal is left
 *   TL-5  the user-action title does not take the blocked border's colour
 */

// `user_action` and `completed_date` are the todo files' own field names.
/* eslint-disable @typescript-eslint/naming-convention */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { todoListItem } from '../todoListItem';

const SRC = join(__dirname, '..', '..', '..');

describe('todoListItem', () => {
    test('TL-1: user_action reaches the row, and only when true', () => {
        const mine = todoListItem({ id: 'a', title: 'Look', status: 'not-started', user_action: true }, 'todos.q.todo.yaml');
        assert.equal(mine.user_action, true);
        const other = todoListItem({ id: 'b', title: 'Do', status: 'not-started' }, 'todos.q.todo.yaml');
        assert.equal('user_action' in other, false);
        const falsy = todoListItem({ id: 'c', title: 'Do', status: 'not-started', user_action: false }, 'todos.q.todo.yaml');
        assert.equal('user_action' in falsy, false);
    });

    test('TL-2: completed_date reaches the row', () => {
        const row = todoListItem({ id: 'a', status: 'completed', completed_date: '2026-10-29' }, 'f');
        assert.equal(row.completed_date, '2026-10-29');
    });

    test('TL-3: title fallback, id and source file', () => {
        const long = 'x'.repeat(80);
        const row = todoListItem(
            { id: 'a', description: long, status: 'blocked', priority: 'high', tags: ['t'], created: '2026-10-01', updated: '2026-10-02' },
            'todos.q.todo.yaml',
            'session-file::a',
        );
        assert.deepEqual(row, {
            id: 'session-file::a',
            title: 'x'.repeat(60),
            status: 'blocked',
            priority: 'high',
            tags: ['t'],
            created: '2026-10-01',
            updated: '2026-10-02',
            sourceFile: 'todos.q.todo.yaml',
        });
    });

    test('TL-4: the handler builds every list row through todoListItem', () => {
        const handler = readFileSync(join(SRC, 'src', 'handlers', 'questTodoPanel-handler.ts'), 'utf-8');
        // The old literal: `title: t.title ?? t.description?.substring(0, 60)` next to `status: t.status`.
        const copies = handler.match(/title:\s*t\.title\s*\?\?\s*t\.description\?\.substring\(0,\s*60\),\s*\n?\s*status:\s*t\.status,\s*priority/g) ?? [];
        assert.equal(copies.length, 0, 'a list row is built by hand instead of todoListItem');
        const uses = handler.match(/todoListItem\(/g) ?? [];
        assert.ok(uses.length >= 6, `expected the six list builders to use todoListItem, found ${uses.length}`);
    });

    test('TL-5: the user-action title does not reuse the blocked colour', () => {
        const css = readFileSync(join(SRC, 'media', 'questTodoPanel', 'style.css'), 'utf-8');
        const blocked = /\.qt-todo-item\.status-blocked\s*\{[^}]*var\((--vscode-[\w-]+)/.exec(css);
        const mine = /\.qt-todo-item\.user-action \.ttitle\s*\{[^}]*var\((--vscode-[\w-]+)/.exec(css);
        assert.ok(blocked, 'blocked style not found');
        assert.ok(mine, 'user-action title style not found');
        assert.notEqual(mine[1], blocked[1]);
    });
});
