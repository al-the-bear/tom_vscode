/**
 * The quest-todo writers write the schema's dates as dates and carry the six
 * Worktracker orchestration fields (wonetestd7).
 *
 * The todo schema declares `due`, `created`, `updated`, `completed_date`,
 * `archived`, `deleted` as `format: date`; agents passed timestamps
 * (`2026-10-20T12:37:25+0200`) through tomAi_createQuestTodo / tomAi_updateQuestTodo
 * and the writers stored them verbatim — 341 archived todos the shared todo
 * model refuses. The schema also gained `execution_role`, `qa_role`,
 * `orchestration_role`, `bundle_id`, `derived_from`, `feedback_source`; the
 * writers knew none of them, so an update naming one silently did nothing.
 *
 * The tools are driven through a store built on the real manager functions —
 * the same calls the live adapter (chat-enhancement-tools.ts) makes.
 *
 *   QD-1 create and update through the tools write a timestamp as the date it names; it reads back date-only
 *   QD-2 a value that is not a date is refused, ok: false, and the file is unchanged
 *   QD-3 the six orchestration fields are written on create, read back, changed one at a time by an
 *        update (the others kept), and removed by ''
 *   QD-4 an update rewrites a timestamped `created` already on the item as its date, and clearing a field
 *        through the tool path removes the key instead of writing `null`
 *   QD-5 the writer's own stamps are the local date
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-dates-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, findTodoById, updateTodo } from '../questTodoManager.js';
import { createQuestTodoImpl, updateQuestTodoImpl, type QuestTodoToolsDeps, type QuestTodoFull } from '../../tools/quest-todo-tools.js';
import { todayLocalDate } from '../../utils/todoDates.js';

const QUEST = 'datesq';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);
const todoFile = path.join(questDir, `todos.${QUEST}.todo.yaml`);

const toFull = (t: { _sourceFile?: string } & Record<string, unknown>): QuestTodoFull => {
    const { _sourceFile, ...rest } = t;
    return { ...rest, sourceFile: _sourceFile } as QuestTodoFull;
};
const deps: QuestTodoToolsDeps = {
    store: {
        listFiles: () => [],
        listTodos: () => [],
        findById: (q, id) => { const t = findTodoById(q, id); return t ? toFull(t as never) : undefined; },
        create: (q, todo, file) => toFull(createTodo(q, todo as never, file) as never),
        update: (q, id, updates) => { const t = updateTodo(q, id, updates as never); return t ? toFull(t as never) : undefined; },
        move: () => undefined,
        delete: () => false,
    },
};

const call = async (impl: Promise<string>): Promise<Record<string, any>> => JSON.parse(await impl);
const raw = (): string => fs.readFileSync(todoFile, 'utf8');
/** The top-level `key: value` lines of the one todo, as written. */
const fieldLine = (key: string): string | undefined => raw().split('\n').find((l) => l.trimStart().startsWith(`${key}:`) && l.startsWith('    '))?.trim();

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
});
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('quest-todo writers: schema dates and orchestration fields', () => {
    test('QD-1: a timestamp is written as the date it names', async () => {
        const created = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: {
            id: 'd1', description: 'dated', status: 'completed', completed_date: '2026-10-20T12:37:25+0200',
        } }));
        assert.equal(created.ok, true, created.error);
        assert.equal(fieldLine('completed_date'), 'completed_date: 2026-10-20');
        const updated = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'd1', updates: { completed_date: '2026-10-21T00:30:00+02:00' } }));
        assert.equal(updated.ok, true, updated.error);
        assert.equal(updated.todo.completed_date, '2026-10-21', 'the date in its own offset, not the UTC date');
        assert.equal(findTodoById(QUEST, 'd1')?.completed_date, '2026-10-21');
        assert.equal(fieldLine('completed_date'), 'completed_date: 2026-10-21');
    });

    test('QD-2: not a date is refused and nothing is written', async () => {
        await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'd2', description: 'x', notes: 'keep me' } }));
        const before = raw();
        const r = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'd2', updates: { notes: 'changed', completed_date: 'last tuesday' } }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`completed_date` must be a date \(YYYY-MM-DD\)/);
        assert.equal(raw(), before, 'the notes were not written either');
        const c = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'd3', description: 'x', completed_date: '2026-02-30' } }));
        assert.equal(c.ok, false);
        assert.equal(findTodoById(QUEST, 'd3'), undefined);
    });

    test('QD-3: the six orchestration fields', async () => {
        const six = {
            execution_role: 'software_engineer', qa_role: 'reviewer', orchestration_role: 'lead',
            bundle_id: 'bundle-7', derived_from: 'd0', feedback_source: 'user review 2026-10-21',
        };
        const created = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'o1', description: 'orchestrated', ...six } }));
        assert.equal(created.ok, true, created.error);
        for (const [k, v] of Object.entries(six)) { assert.equal(fieldLine(k), `${k}: ${v}`, `${k} on disk`); }
        const read = findTodoById(QUEST, 'o1') as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(six)) { assert.equal(read[k], v, `${k} read back`); }
        assert.equal('_extra' in read && (read._extra as Record<string, unknown>)?.qa_role !== undefined, false, 'read as fields, not as leftovers');

        const changed = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'o1', updates: { qa_role: 'tester' } }));
        assert.equal(changed.ok, true, changed.error);
        assert.equal(changed.todo.qa_role, 'tester');
        assert.equal(changed.todo.bundle_id, 'bundle-7', 'an update that does not name a field keeps it');
        const notes = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'o1', updates: { notes: 'only notes' } }));
        assert.equal(notes.todo.execution_role, 'software_engineer');

        const cleared = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'o1', updates: { derived_from: '' } }));
        assert.equal(cleared.ok, true, cleared.error);
        assert.equal(fieldLine('derived_from'), undefined, "'' removes the field");
    });

    test('QD-4: an old timestamp is repaired on update, and clearing writes no null', async () => {
        fs.writeFileSync(todoFile, [
            `quest: ${QUEST}`, 'created: "2026-01-01"', 'todos:',
            '  - id: old', '    description: written by an older build', '    status: completed',
            '    title: A title', '    completed_date: 2026-10-04T22:59:31+02:00', '    created: 2026-10-01T08:00:00+0200', '',
        ].join('\n'));
        const r = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'old', updates: { title: '' } }));
        assert.equal(r.ok, true, r.error);
        assert.equal(fieldLine('created'), 'created: 2026-10-01');
        assert.equal(fieldLine('title'), undefined, 'cleared, not `title: null`');
        assert.doesNotMatch(raw(), /: null$/m);
        // completed_date is not named by the update: it is left to the date the caller set, untouched.
        assert.equal(fieldLine('completed_date'), 'completed_date: 2026-10-04T22:59:31+02:00');
        const fix = await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 'old', updates: { completed_date: '2026-10-04T22:59:31+02:00' } }));
        assert.equal(fix.todo.completed_date, '2026-10-04');
    });

    test('QD-5: the writer stamps the local date', async () => {
        await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 's1', description: 'stamped' } }));
        assert.equal(fieldLine('created'), `created: ${todayLocalDate()}`);
        await call(updateQuestTodoImpl(deps, { questId: QUEST, todoId: 's1', updates: { notes: 'n' } }));
        assert.equal(fieldLine('updated'), `updated: ${todayLocalDate()}`);
    });
});
