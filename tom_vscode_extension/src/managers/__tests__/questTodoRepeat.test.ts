/**
 * Repeated todos through the writers, the walk and the controller (utils/todoRepeat.ts; the manager's
 * applyRepeatOnDone; queueStep3Utils; services/repeatedTodoController.ts).
 *
 *   QR-1 a repeated todo created with a rule keeps it; a rule outside the schema is refused, nothing written
 *   QR-2 set to completed, a repeated todo goes to waiting-for-repeat with next_repeat, repeat_count and a
 *        line in its notes; the completion facts are not written; a second time counts on
 *   QR-3 a manual rule waits without next_repeat; a rule that has ended (count) completes for good
 *   QR-4 the controller releases a due todo to not-started, leaves a later or manual one waiting
 *   QR-5 a `<prefix>*` walk runs a manual repeated todo that waits, once per walk; it never runs a timed one
 *        before it is due
 *   QR-6 null removes a rule
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-repeat-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, findTodoById, listQuestIds, readAllTodos, updateTodo } from '../questTodoManager.js';
import { createQuestTodoImpl, type QuestTodoToolsDeps, type QuestTodoFull } from '../../tools/quest-todo-tools.js';
import { releaseDueRepeatedTodos } from '../../services/repeatedTodoController.js';
import { pickNextTodoForIteration, walkableRepeatIds } from '../../utils/queueStep3Utils.js';
import { formatRepeatMoment } from '../../utils/todoRepeat.js';

const QUEST = 'repeatq';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (impl: Promise<string>): Promise<Record<string, any>> => JSON.parse(await impl);

beforeEach(() => {
    fs.rmSync(questDir, { recursive: true, force: true });
    fs.mkdirSync(questDir, { recursive: true });
});
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('repeated todos: writers, walk, controller', () => {
    test('QR-1: create with a rule', async () => {
        const ok = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'weekly1', description: 'Weekly status', repeat: { rule: 'weekly', weekdays: ['mon'], time: '09:00' } } }));
        assert.equal(ok.ok, true, JSON.stringify(ok));
        assert.deepEqual(findTodoById(QUEST, 'weekly1')?.repeat, { rule: 'weekly', weekdays: ['mon'], time: '09:00' });
        assert.match(fs.readFileSync(todoFile, 'utf8'), /repeat:\n\s+rule: weekly\n\s+weekdays:\n\s+- mon\n\s+time: "?09:00"?/);
        const bad = await call(createQuestTodoImpl(deps, { questId: QUEST, todo: { id: 'bad1', description: 'x', repeat: { rule: 'weekly' } as never } }));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /repeat: `weekly` needs `weekdays`/);
        assert.equal(findTodoById(QUEST, 'bad1'), undefined);
    });

    test('QR-2: done, it waits for the next repetition', () => {
        createTodo(QUEST, { id: 'daily1', description: 'Daily check', status: 'in-progress', repeat: { rule: 'daily', time: '23:59' } } as never);
        const first = updateTodo(QUEST, 'daily1', { status: 'completed', completed_date: '2026-11-10', completed_by: 'alice' });
        assert.equal(first?.status, 'waiting-for-repeat');
        assert.equal(first?.repeat_count, 1);
        assert.match(first?.next_repeat ?? '', /^\d{4}-\d{2}-\d{2}T23:59(Z|[+-]\d{2}:\d{2})$/);
        assert.equal(first?.completed_date, undefined);
        assert.equal(first?.completed_by, undefined);
        assert.match(first?.notes ?? '', /: done \(1\), next /);
        updateTodo(QUEST, 'daily1', { status: 'not-started' });
        const second = updateTodo(QUEST, 'daily1', { status: 'completed' });
        assert.equal(second?.repeat_count, 2);
        assert.equal((second?.notes ?? '').split('done (').length - 1, 2, 'one line per time');
    });

    test('QR-3: manual, and a rule that has ended', () => {
        createTodo(QUEST, { id: 'manual1', description: 'By hand', status: 'not-started', repeat: { rule: 'manual' } } as never);
        const manual = updateTodo(QUEST, 'manual1', { status: 'completed' });
        assert.equal(manual?.status, 'waiting-for-repeat');
        assert.equal(manual?.next_repeat, undefined);
        createTodo(QUEST, { id: 'twice1', description: 'Twice', status: 'not-started', repeat: { rule: 'daily', count: 2 }, repeat_count: 1 } as never);
        const ended = updateTodo(QUEST, 'twice1', { status: 'completed', completed_date: '2026-11-10' });
        assert.equal(ended?.status, 'completed', 'the second time ends it');
        assert.equal(ended?.completed_date, '2026-11-10');
    });

    test('QR-4: the controller', () => {
        const now = new Date();
        const past = formatRepeatMoment(new Date(now.getTime() - 60_000));
        const future = formatRepeatMoment(new Date(now.getTime() + 3_600_000));
        createTodo(QUEST, { id: 'due1', description: 'Due', status: 'waiting-for-repeat', repeat: { rule: 'daily' }, next_repeat: past } as never);
        createTodo(QUEST, { id: 'later1', description: 'Later', status: 'waiting-for-repeat', repeat: { rule: 'daily' }, next_repeat: future } as never);
        createTodo(QUEST, { id: 'hand1', description: 'By hand', status: 'waiting-for-repeat', repeat: { rule: 'manual' } } as never);
        const port = {
            listQuestIds: () => listQuestIds(),
            readTodos: (q: string) => readAllTodos(q),
            setStatus: (q: string, id: string, status: 'not-started') => updateTodo(q, id, { status }) !== undefined,
        };
        const result = releaseDueRepeatedTodos(port, now);
        assert.deepEqual(result.released.map((r) => [r.questId, r.todoId]), [[QUEST, 'due1']]);
        assert.equal(findTodoById(QUEST, 'due1')?.status, 'not-started');
        assert.equal(findTodoById(QUEST, 'due1')?.next_repeat, past, 'the moment it was due stays: the schedule goes on from it');
        assert.equal(findTodoById(QUEST, 'later1')?.status, 'waiting-for-repeat');
        assert.equal(findTodoById(QUEST, 'hand1')?.status, 'waiting-for-repeat');
    });

    test('QR-5: a walk runs a manual repeated todo once', () => {
        const todos = [
            { id: 'walk1', status: 'completed' },
            { id: 'walk2', status: 'waiting-for-repeat', walkableRepeat: true },
            { id: 'walk3', status: 'waiting-for-repeat' },
            { id: 'walk4', status: 'not-started' },
        ];
        assert.equal(pickNextTodoForIteration('walk*', todos)?.id, 'walk2', 'the manual one waiting is walked');
        const ran = walkableRepeatIds({ repeatTodoId: 'walk2', repetitionAnswers: [{ key: 'walk1' }] });
        assert.deepEqual([...ran].sort(), ['walk1', 'walk2']);
        // The caller drops walkableRepeat for what the walk ran: the next pick is the not-started one.
        const after = todos.map((t) => (ran.has(t.id) ? { id: t.id, status: t.status } : t));
        assert.equal(pickNextTodoForIteration('walk*', after)?.id, 'walk4');
        assert.equal(pickNextTodoForIteration('walk*', [{ id: 'walk3', status: 'waiting-for-repeat' }]), undefined, 'a timed one waits for the controller');
    });

    test('QR-6: null removes a rule', () => {
        createTodo(QUEST, { id: 'rm1', description: 'x', status: 'not-started', repeat: { rule: 'manual' } } as never);
        updateTodo(QUEST, 'rm1', { repeat: null as never });
        assert.equal(findTodoById(QUEST, 'rm1')?.repeat, undefined);
        assert.doesNotMatch(fs.readFileSync(todoFile, 'utf8'), /^\s+repeat:/m);
    });
});
