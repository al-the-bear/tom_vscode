/**
 * `tomAi_answerUser` (vscimpb171): the tool (src/tools/answer-user-tool.ts), the machine's answer store
 * (src/utils/userAnswers.ts); the Q&A page's webview is tested in src/handlers/__tests__/qaPanel.dom.test.ts.
 *
 *   AU-1 the call stores the answer and returns at once: title, answer, the question, where it ran (window, quest,
 *        run, session, queue item) and the caller's filed_by; unread; the Q&A journal gets it; the listener is told; a failing listener does
 *        not fail the call
 *   AU-2 title and answer are required; a suggested prompt needs its text (its label defaults to the first line)
 *   AU-3 a suggested todo is checked as tomAi_createQuestTodo checks it: an incomplete one (no id, no description,
 *        a bare-string reference, an id the quest has, the same id twice, no quest) refuses the whole call with
 *        every reason and stores nothing; nothing is created by the call
 *   AU-4 Add todo creates exactly the record given, with the answering agent's filed_by, in the suggested quest
 *        and file, marks it added, and does not add it twice; a refusal by the create leaves it unadded
 *   AU-5 the store: one file per answer under a folder per real `_ai` path; newest first; read / unread; delete,
 *        delete read; the cleanups (the 100 / 200 oldest, older than 7 / 30 days); an id is never a path
 *   AU-7 the tool: named, in the lists (always on, core, plan mode), described within the limit, not read-only
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { withTiming } from './_timing.js';
import { ANSWER_USER_DESCRIPTION, ANSWER_USER_TOOL, addSuggestedTodo, answerUserImpl, type AnswerUserDeps } from '../answer-user-tool.js';
import { createQuestTodoImpl, createQuestTodoProblem, type CreateQuestTodoInput, type QuestTodoFull, type QuestTodoToolsDeps } from '../quest-todo-tools.js';
import {
    ANSWERS_WARN_LIMIT, ANSWER_CLEANUP_LABELS, answersStoreDir, cleanupIds, countAnswers, deleteAnswers, markAnswerRead, newAnswerId, readAnswer,
    readAnswerIds, readAnswers, writeAnswer, type UserAnswer,
} from '../../utils/userAnswers.js';
import { PLAN_MODE_ALLOWED_TOOLS } from '../planning-tools.js';
import { ALWAYS_ON_TOOLS } from '../../utils/roleTypes.js';
import { DEFAULT_CORE_TOOLS } from '../../utils/toolSelection.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_vscimpb171_au-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A quest todo store in memory: quest → id → todo. */
function todoDeps(filedBy?: Record<string, string>): QuestTodoToolsDeps & { todos: Map<string, Map<string, QuestTodoFull>> } {
    const todos = new Map<string, Map<string, QuestTodoFull>>();
    const of = (q: string): Map<string, QuestTodoFull> => { if (!todos.has(q)) { todos.set(q, new Map()); } return todos.get(q)!; };
    return {
        todos,
        idRefusal: (id) => (/\s/.test(id) ? `"${id}" is no todo id: it holds a space.` : undefined),
        store: {
            listFiles: () => [],
            listTodos: (q) => [...of(q).values()] as never,
            findById: (q, id) => of(q).get(id),
            create: (q, todo, file) => {
                const full = { ...todo, ...(filedBy ? { filed_by: filedBy } : {}), sourceFile: file ?? `todos.${q}.todo.yaml` } as QuestTodoFull;
                of(q).set(String(todo.id), full);
                return full;
            },
            update: () => undefined,
            move: () => undefined,
            delete: () => false,
        },
    };
}

let dirs = 0;
function setup(ctx: Partial<ReturnType<AnswerUserDeps['context']>> = {}): { deps: AnswerUserDeps; dir: string; todos: ReturnType<typeof todoDeps>; told: UserAnswer[]; journalled: UserAnswer[] } {
    const dir = path.join(SANDBOX, `store-${++dirs}`);
    const todos = todoDeps();
    const told: UserAnswer[] = [];
    const journalled: UserAnswer[] = [];
    const deps: AnswerUserDeps = {
        context: () => ({ windowId: 'w1', quest: 'q1', run: 'default', ...ctx }),
        todoProblem: (quest, todo, file) => createQuestTodoProblem(todos, { questId: quest, todo, ...(file ? { file } : {}) } as CreateQuestTodoInput),
        store: (a) => writeAnswer(dir, a),
        journal: (a) => { journalled.push(a); },
        onStored: (a) => { told.push(a); },
        now: () => new Date('2026-11-19T10:00:00Z'),
    };
    return { deps, dir, todos, told, journalled };
}
const TODO = { id: 'x1_akss-follow-up', title: 'Follow up', description: 'Do the follow-up.\n\nDONE WHEN: done.', status: 'not-started', priority: 'medium', tags: ['a'], references: [{ path: 'doc/x.md' }] };

describe('tomAi_answerUser', () => {
    test('AU-1: the call stores the answer and returns at once', async () => {
        const { deps, dir, told, journalled } = setup({ run: 'r2', session: 'default@r2', queueItemId: 'item-7', filedBy: { tool: 'agent', session: 'default@r2' } });
        const raw = await withTiming('tomAi_answerUser:typical', () => answerUserImpl(deps, { title: '  Why is it slow?  ', answer: 'Because of **x**.', question: 'Why is the build slow?' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.stored, true);
        assert.match(r.note, /go on with your work/);
        const stored = readAnswers(dir);
        assert.equal(stored.length, 1);
        assert.deepEqual(stored[0], {
            id: r.id, at: '2026-11-19T10:00:00.000Z', windowId: 'w1', quest: 'q1', run: 'r2', session: 'default@r2', queueItemId: 'item-7',
            title: 'Why is it slow?', question: 'Why is the build slow?', answer: 'Because of **x**.', suggestedPrompts: [], suggestedTodos: [], read: false,
            filedBy: { tool: 'agent', session: 'default@r2' },
        });
        assert.deepEqual(told.map((a) => a.id), [r.id], 'the listener is told once');
        assert.deepEqual(journalled, [stored[0]], 'the answer goes to the Q&A journal');
        // A journal that throws does not fail the call.
        const noJournal = setup();
        noJournal.deps.journal = () => { throw new Error('no journal'); };
        assert.equal(JSON.parse(await answerUserImpl(noJournal.deps, { title: 't', answer: 'a' })).ok, true);
        assert.equal(noJournal.told.length, 1);
        // A listener that throws does not fail the call.
        const failing = setup();
        failing.deps.onStored = () => { throw new Error('page broke'); };
        assert.equal(JSON.parse(await answerUserImpl(failing.deps, { title: 't', answer: 'a' })).ok, true);
        assert.equal(countAnswers(failing.dir), 1);
        // A store that cannot write: the call says so.
        const broken = setup();
        broken.deps.store = () => { throw new Error('no answer store'); };
        const bad = JSON.parse(await answerUserImpl(broken.deps, { title: 't', answer: 'a' }));
        assert.equal(bad.ok, false);
        assert.match(bad.error, /not stored: no answer store/);
    });

    test('AU-2: title, answer and prompt texts', async () => {
        const { deps, dir } = setup();
        assert.match(JSON.parse(await answerUserImpl(deps, { title: ' ', answer: 'a' })).error, /`title` is required/);
        assert.match(JSON.parse(await answerUserImpl(deps, { title: 't', answer: '  ' })).error, /`answer` is required/);
        const bad = JSON.parse(await answerUserImpl(deps, { title: 't', answer: 'a', suggestedPrompts: [{ label: 'x' }, { text: 'ok' }] }));
        assert.equal(bad.ok, false);
        assert.deepEqual(bad.problems, ['suggestedPrompts[0]: `text` is required (the prompt to copy).']);
        assert.equal(countAnswers(dir), 0, 'nothing stored');
        const ok = JSON.parse(await answerUserImpl(deps, { title: 't', answer: 'a', suggestedPrompts: [{ text: 'Do the next step\nwith care' }, { label: ' Second ', text: 'two' }] }));
        assert.equal(ok.suggestedPrompts, 2);
        assert.deepEqual(readAnswer(dir, ok.id)!.suggestedPrompts, [{ label: 'Do the next step', text: 'Do the next step\nwith care' }, { label: 'Second', text: 'two' }]);
    });

    test('AU-3: an incomplete suggested todo refuses the whole call', async () => {
        const { deps, dir, todos } = setup();
        todos.store.create('q1', { id: 'taken1', description: 'there' } as never);
        const r = JSON.parse(await answerUserImpl(deps, {
            title: 't', answer: 'a',
            suggestedPrompts: [{ text: 'fine' }],
            suggestedTodos: [
                { todo: { ...TODO } },
                { todo: { title: 'no id', description: 'd' } },
                { todo: { id: 'nodesc1' } },
                { todo: { id: 'refs1', description: 'd', references: ['doc/x.md'] } },
                { todo: { id: 'taken1', description: 'd' } },
                { todo: { ...TODO } },
                { todo: { id: 'has space', description: 'd' } },
                {},
            ],
        }));
        assert.equal(r.ok, false);
        assert.match(r.error, /^Nothing was stored: 7 suggestions are not complete\./);
        assert.equal(r.problems.length, 7);
        assert.match(r.problems[0], /^suggestedTodos\[1\] \(no id\): `todo\.id` is required/);
        assert.match(r.problems[1], /^suggestedTodos\[2\] \(nodesc1\): `todo\.description` is required/);
        assert.match(r.problems[2], /^suggestedTodos\[3\] \(refs1\): .*references/);
        assert.match(r.problems[3], /^suggestedTodos\[4\] \(taken1\): Todo "taken1" already exists in quest "q1"/);
        assert.match(r.problems[4], /^suggestedTodos\[5\]: the id x1_akss-follow-up is suggested twice for quest q1\./);
        assert.match(r.problems[5], /^suggestedTodos\[6\] \(has space\): .*holds a space/);
        assert.match(r.problems[6], /^suggestedTodos\[7\]: `todo` is required: the complete todo record/);
        assert.equal(countAnswers(dir), 0, 'nothing stored');
        // No quest open and none named.
        const none = setup({ quest: 'default' });
        assert.match(JSON.parse(await answerUserImpl(none.deps, { title: 't', answer: 'a', suggestedTodos: [{ todo: { ...TODO } }] })).problems[0], /no quest: name it in `quest`/);
        assert.equal(JSON.parse(await answerUserImpl(none.deps, { title: 't', answer: 'a', suggestedTodos: [{ quest: 'q2', todo: { ...TODO } }] })).ok, true);
        // A complete one is stored as given, and NOT created.
        const ok = JSON.parse(await answerUserImpl(deps, { title: 't', answer: 'a', suggestedTodos: [{ todo: { ...TODO } }, { quest: 'q2', file: 'side.q2.todo.yaml', todo: { ...TODO } }] }));
        assert.equal(ok.suggestedTodos, 2);
        assert.deepEqual(readAnswer(dir, ok.id)!.suggestedTodos, [{ quest: 'q1', todo: TODO }, { quest: 'q2', file: 'side.q2.todo.yaml', todo: TODO }]);
        assert.equal(todos.store.findById('q1', TODO.id), undefined, 'the call creates no todo');
    });

    test('AU-4: Add todo creates exactly the record, once', async () => {
        const { deps, dir } = setup({ filedBy: { tool: 'agent', session: 'chat', run: 'default' } });
        const r = JSON.parse(await answerUserImpl(deps, { title: 't', answer: 'a', suggestedTodos: [{ todo: { ...TODO } }, { quest: 'q2', file: 'side.q2.todo.yaml', todo: { ...TODO, id: 'x2_akss-other' } }] }));
        const calls: Json[] = [];
        const target = todoDeps();
        const create = async (quest: string, todo: Record<string, unknown>, file: string | undefined, filedBy: Record<string, string> | undefined): Promise<string> => {
            calls.push({ quest, todo, file, filedBy });
            // As the live deps do: the store writes the given filed_by with the record.
            const deps: QuestTodoToolsDeps = { ...target, store: { ...target.store, create: (q, t, f) => target.store.create(q, { ...t, filed_by: filedBy } as never, f) } };
            return createQuestTodoImpl(deps, { questId: quest, todo, ...(file ? { file } : {}) } as CreateQuestTodoInput);
        };
        const first = await addSuggestedTodo(dir, r.id, 0, create);
        assert.deepEqual(first, { ok: true, todoId: TODO.id, quest: 'q1' });
        assert.deepEqual(calls[0], { quest: 'q1', todo: TODO, file: undefined, filedBy: { tool: 'agent', session: 'chat', run: 'default' } });
        const created = target.store.findById('q1', TODO.id) as Json;
        assert.deepEqual({ ...created, sourceFile: undefined, filed_by: undefined }, { ...TODO, sourceFile: undefined, filed_by: undefined }, 'exactly the record given');
        assert.deepEqual(created.filed_by, { tool: 'agent', session: 'chat', run: 'default' }, 'filed by the answering agent');
        const marked = readAnswer(dir, r.id)!.suggestedTodos[0];
        assert.equal(marked.addedId, TODO.id);
        assert.ok(marked.addedAt);
        // Not twice.
        const again = await addSuggestedTodo(dir, r.id, 0, create);
        assert.deepEqual(again, { ok: false, error: `Already added as ${TODO.id}.`, alreadyAdded: TODO.id });
        assert.equal(calls.length, 1);
        // The other quest and file.
        const second = await addSuggestedTodo(dir, r.id, 1, create);
        assert.equal(second.ok, true);
        assert.equal((target.store.findById('q2', 'x2_akss-other') as Json).sourceFile, 'side.q2.todo.yaml');
        // A refusal by the create (the id was taken meanwhile) leaves it unadded.
        const late = JSON.parse(await answerUserImpl(deps, { title: 't2', answer: 'a', suggestedTodos: [{ quest: 'q9', todo: { ...TODO } }] }));
        target.store.create('q9', { ...TODO } as never);
        const refused = await addSuggestedTodo(dir, late.id, 0, create);
        assert.equal(refused.ok, false);
        assert.match((refused as Json).error, /already exists in quest "q9"/);
        assert.equal(readAnswer(dir, late.id)!.suggestedTodos[0].addedId, undefined);
        assert.deepEqual(await addSuggestedTodo(dir, 'agone', 0, create), { ok: false, error: 'This answer or its suggested todo is no longer stored.' });
        assert.equal((await addSuggestedTodo(dir, r.id, 5, create)).ok, false);
    });

    test('AU-5: the store', () => {
        const ai = path.join(SANDBOX, 'ai-real');
        const link = path.join(SANDBOX, 'ai-link');
        fs.mkdirSync(ai);
        fs.symlinkSync(ai, link);
        const gs = path.join(SANDBOX, 'gs');
        assert.equal(answersStoreDir(gs, link), answersStoreDir(gs, ai), 'a symlinked _ai is the same store');
        assert.notEqual(answersStoreDir(gs, ai), answersStoreDir(gs, path.join(SANDBOX, 'other-ai')));
        assert.match(path.relative(gs, answersStoreDir(gs, ai)), /^answers[\\/][0-9a-f]{16}$/);
        const dir = answersStoreDir(gs, ai);
        assert.deepEqual(readAnswers(dir), [], 'no folder yet: no answers');
        const now = new Date('2026-11-19T10:00:00Z');
        const mk = (daysAgo: number, read = false): UserAnswer => {
            const at = new Date(now.getTime() - daysAgo * 86_400_000);
            const a: UserAnswer = { id: newAnswerId(at), at: at.toISOString(), windowId: 'w1', quest: 'q1', run: 'default', title: `d${daysAgo}`, answer: 'a', suggestedPrompts: [], suggestedTodos: [], read };
            writeAnswer(dir, a);
            return a;
        };
        const a0 = mk(0); const a3 = mk(3, true); const a10 = mk(10); const a40 = mk(40, true);
        assert.deepEqual(readAnswers(dir).map((a) => a.title), ['d0', 'd3', 'd10', 'd40'], 'newest first');
        assert.equal(new Set([a0.id, a3.id, a10.id, a40.id, newAnswerId(now), newAnswerId(now)]).size, 6, 'ids are unique');
        fs.writeFileSync(path.join(dir, 'broken.json'), '{');
        fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
        assert.equal(readAnswers(dir).length, 4, 'a file that does not parse is left out');
        fs.rmSync(path.join(dir, 'broken.json'));
        assert.equal(countAnswers(dir), 4);
        assert.equal(markAnswerRead(dir, a0.id)!.read, true);
        assert.equal(readAnswer(dir, a0.id)!.read, true);
        assert.equal(markAnswerRead(dir, a0.id, false)!.read, false);
        assert.equal(markAnswerRead(dir, 'agone'), undefined);
        assert.throws(() => readAnswer(dir, '../x') ?? writeAnswer(dir, { ...a0, id: '../x' }), /not an answer id/);
        const all = readAnswers(dir);
        assert.deepEqual(readAnswerIds(all).sort(), [a3.id, a40.id].sort());
        assert.deepEqual(cleanupIds(all, 'older7', now).sort(), [a10.id, a40.id].sort());
        assert.deepEqual(cleanupIds(all, 'older30', now), [a40.id]);
        assert.equal(cleanupIds(all, 'oldest100', now).length, 4);
        const many: UserAnswer[] = Array.from({ length: 250 }, (_, i) => ({ ...a0, id: `m${i}`, at: new Date(now.getTime() - i * 60_000).toISOString() }));
        assert.deepEqual(cleanupIds(many, 'oldest100', now).slice(0, 2), ['m249', 'm248'], 'the oldest first');
        assert.equal(cleanupIds(many, 'oldest100', now).length, 100);
        assert.equal(cleanupIds(many, 'oldest200', now).length, 200);
        assert.deepEqual(Object.values(ANSWER_CLEANUP_LABELS), ['Delete the 100 oldest', 'Delete the 200 oldest', 'Older than 7 days', 'Older than 30 days']);
        assert.equal(ANSWERS_WARN_LIMIT, 500);
        assert.equal(deleteAnswers(dir, [a3.id, 'agone']), 1);
        assert.deepEqual(readAnswers(dir).map((a) => a.title), ['d0', 'd10', 'd40']);
    });

    test('AU-7: the tool', () => {
        assert.equal(ANSWER_USER_TOOL.name, 'tomAi_answerUser');
        assert.equal(ANSWER_USER_TOOL.readOnly, false);
        assert.ok(ANSWER_USER_DESCRIPTION.length <= 1250, `description ${ANSWER_USER_DESCRIPTION.length} chars`);
        assert.match(ANSWER_USER_DESCRIPTION, /WITHOUT waiting/);
        assert.match(ANSWER_USER_DESCRIPTION, /tomAi_askUser instead/);
        assert.deepEqual((ANSWER_USER_TOOL.inputSchema as Json).required, ['title', 'answer']);
        assert.ok([...ALWAYS_ON_TOOLS].includes('tomAi_answerUser'), 'always on, whatever the role');
        assert.ok([...DEFAULT_CORE_TOOLS].includes('tomAi_answerUser'));
        assert.ok([...PLAN_MODE_ALLOWED_TOOLS].includes('tomAi_answerUser'), 'answering is no write of the workspace');
    });
});
