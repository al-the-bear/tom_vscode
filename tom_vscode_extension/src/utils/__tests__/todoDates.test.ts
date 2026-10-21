/**
 * The todo schema's date fields are dates (wonetestd7).
 *
 * `_ai/schemas/yaml/todo.schema.json` declares `due`, `created`, `updated`,
 * `completed_date`, `archived` and `deleted` as `format: date`. The extension
 * wrote whatever a caller passed, so agents' timestamps (`2026-10-20T12:37:25+0200`)
 * reached 341 archived todos, and the shared todo model (Worktracker's TomTodo,
 * the Webwork todo-file editor) refuses every one of them.
 *
 *   TD-1 a date is kept; a timestamp keeps the date it names in its own offset (not the UTC date);
 *        surrounding blanks are trimmed
 *   TD-2 anything that is not a date is refused, naming the field and the value — an impossible
 *        calendar day included
 *   TD-3 '' and undefined are "no value", passed through for the writers to clear or skip
 *   TD-4 today's date is the LOCAL date (the writers used the UTC date, which is yesterday after
 *        local midnight east of Greenwich)
 *   TD-5 the field lists match the schema
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
    TODO_DATE_FIELDS,
    TODO_ORCHESTRATION_FIELDS,
    localDateOf,
    toTodoDate,
} from '../todoDates.js';

describe('todoDates', () => {
    test('TD-1: dates and timestamps', () => {
        assert.equal(toTodoDate('completed_date', '2026-10-20'), '2026-10-20');
        assert.equal(toTodoDate('completed_date', '2026-10-20T12:37:25+0200'), '2026-10-20');
        assert.equal(toTodoDate('completed_date', '2026-10-21T00:30:00+02:00'), '2026-10-21', 'the date in its own offset, not UTC (2026-10-20)');
        assert.equal(toTodoDate('updated', '2026-10-04T22:59:31Z'), '2026-10-04');
        assert.equal(toTodoDate('created', '2026-10-05 14:00'), '2026-10-05');
        assert.equal(toTodoDate('due', '  2026-11-01 '), '2026-11-01');
    });

    test('TD-2: not a date is refused', () => {
        for (const bad of ['yesterday', '2026-13-01', '2026-02-30', '20261020', '2026-10-2', '2026-10-20Tlater']) {
            assert.throws(() => toTodoDate('completed_date', bad), (e: Error) =>
                /`completed_date` must be a date \(YYYY-MM-DD\)/.test(e.message) && e.message.includes(JSON.stringify(bad)), bad);
        }
    });

    test('TD-3: no value', () => {
        assert.equal(toTodoDate('completed_date', ''), '');
        assert.equal(toTodoDate('completed_date', undefined), undefined);
    });

    test('TD-4: today is local', () => {
        const d = new Date(2026, 9, 21, 0, 30); // 00:30 local on 2026-10-21
        assert.equal(localDateOf(d), '2026-10-21');
        assert.equal(localDateOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    });

    test('TD-5: the fields are the schema\'s', () => {
        const schemaPath = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '_ai', 'schemas', 'yaml', 'todo.schema.json');
        if (!fs.existsSync(schemaPath)) { return; } // a checkout without the _ai layer
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        let props: Record<string, { format?: string; type?: unknown }> | undefined;
        const walk = (o: unknown): void => {
            if (props || !o || typeof o !== 'object') { return; }
            const rec = o as Record<string, unknown>;
            if (rec.properties && typeof rec.properties === 'object' && 'status' in (rec.properties as object)) {
                props = rec.properties as Record<string, { format?: string; type?: unknown }>; return;
            }
            Object.values(rec).forEach(walk);
        };
        walk(schema);
        assert.ok(props, 'the todo item properties');
        const dates = Object.entries(props!).filter(([, v]) => v.format === 'date').map(([k]) => k).sort();
        assert.deepEqual([...TODO_DATE_FIELDS].sort(), dates);
        for (const f of TODO_ORCHESTRATION_FIELDS) { assert.ok(props![f], `${f} is in the schema`); }
    });
});
