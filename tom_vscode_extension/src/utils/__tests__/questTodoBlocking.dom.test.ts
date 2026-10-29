/**
 * The todo panel shows `blocking`, the reverse of `blocked_by`
 * (media/questTodoPanel/main.js).
 *
 *   QB-1 a list row whose `blocking` names an open todo carries ⛓️, its tooltip naming the todos it
 *        blocks; a row blocking only completed or cancelled todos, or nothing, carries none; a todo of
 *        another quest (`<quest>/<id>`) counts as open
 *   QB-2 the detail form shows a read-only "Blocking" row (no remove, no add) whose badges navigate
 *   QB-3 the list row carries `blocking` from the host (todoListItem), and only when it has entries
 */

/* eslint-disable @typescript-eslint/naming-convention -- `blocked_by` is the todo schema's YAML key */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { todoListItem } from '../todoListItem';

function media(...parts: string[]): string {
    return readFileSync(join(__dirname, '..', '..', '..', 'media', ...parts), 'utf-8');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(t: { after(fn: () => void): void }): Win {
    const dom = new JSDOM(`<body>${media('questTodoPanel', 'fragment.html')}</body>`, { runScripts: 'outside-only' });
    const w = dom.window as Win;
    t.after(() => w.close());
    w.vscode = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
    w.eval('var qtViewConfig = {};\n' + media('questTodoPanel', 'grouping.js') + media('questTodoPanel', 'main.js'));
    return w;
}

describe('todo panel: blocking', () => {
    test('QB-1: the list row', (t) => {
        const w = setup(t);
        w.eval(`qtTodos = ${JSON.stringify([
            { id: 'open1', status: 'not-started' },
            { id: 'done1', status: 'completed' },
            { id: 'gone1', status: 'cancelled' },
        ])};`);
        const blocker = w.qtRenderTodoRow({ id: 'b', title: 'B', status: 'not-started', blocking: ['open1', 'done1'] });
        assert.match(blocker, /class="qt-blocking"[^>]*title="Blocks: open1"[^>]*>⛓️</);
        const finished = w.qtRenderTodoRow({ id: 'c', title: 'C', status: 'not-started', blocking: ['done1', 'gone1'] });
        assert.doesNotMatch(finished, /qt-blocking/);
        const none = w.qtRenderTodoRow({ id: 'd', title: 'D', status: 'not-started' });
        assert.doesNotMatch(none, /qt-blocking/);
        const far = w.qtRenderTodoRow({ id: 'e', title: 'E', status: 'not-started', blocking: ['qb/x'] });
        assert.match(far, /title="Blocks: qb\/x"/);
    });

    test('QB-2: the detail form row is read-only and navigates', (t) => {
        const w = setup(t);
        const badges = w.qtRenderTodoBadges(['a1', 'qb/x'], 'blocking');
        assert.match(badges, /data-qt-badge-id="a1"/);
        assert.doesNotMatch(badges, /qt-badge-remove/);
        assert.match(w.qtRenderTodoBadges(['a1'], 'blocked-by'), /qt-badge-remove/, 'blocked-by stays editable');
        const js = media('questTodoPanel', 'main.js');
        assert.match(js, /qtFormRow\('Blocking'/);
        assert.match(js, /qtAttachTodoBadgeHandlers\('blocking'\)/);
        assert.doesNotMatch(js, /id="qt-d-blocking-add"/);
    });

    test('QB-3: the host row carries blocking', () => {
        assert.deepEqual(todoListItem({ id: 'b', status: 'not-started', blocking: ['a'] }, 'f').blocking, ['a']);
        assert.equal('blocking' in todoListItem({ id: 'b', status: 'not-started', blocking: [] }, 'f'), false);
        assert.equal('blocking' in todoListItem({ id: 'b', status: 'not-started' }, 'f'), false);
    });
});
