/**
 * Renaming todos so the `_ai` commit guard accepts it (questTodoManager renameQuestTodo, renameTodoPrefix).
 *
 * The guard (`_ai/schemas/todo_schema_guard.py`, invariant 5, check_id_erasure) refuses a commit in which an id
 * that a todo file held at HEAD is in no todo file any more. A rename therefore leaves a stub under the old id.
 *
 *   PR-1 renaming one todo: a cancelled stub under the old id in the -deleted sibling of the file it was in,
 *        naming the new id; `<quest>/<old>` references in another quest's todo files follow
 *   PR-2 renaming a group's prefix: every live todo of the group renamed (each keeping the rest of its id, in
 *        whichever live file it is), every blocked_by / dependencies reference in the quest (plain and
 *        `<quest>/<id>`) and in other quests (`<quest>/<id>`) rewritten, a stub per old id; archived todos of the
 *        group stay as they are; the quest's documents still naming the old prefix are reported; every id the
 *        files held before is still in the corpus (the guard's rule)
 *   PR-3 a dry run answers the renames and the documents and writes nothing
 *   PR-6 an id the todo schema's id pattern refuses (read from the schema itself) is refused with the rule named, nothing
 *        written: renaming one todo, a group (`cleanup` → `_cleanup`), a move with renumbering, creating a todo; the
 *        pattern followed when the schema changes
 *   PR-7 a group with an internal dependency: the dry run answers the same references and stubs as the real run
 *   PR-8 a stub only for an id committed at HEAD: in a git repository, the never committed todo of a renamed group
 *        gets none (dry run and real run alike)
 *   PR-5 a group named with a leading number (`001_cleanup`) is renamed like any other, its numbers kept
 *   PR-4 refused, nothing written: a target prefix with a digit (so one ending in a digit), the same prefix, a
 *        group with no live todo, a target whose ids collide with existing todos (archived and deleted count)
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { spawnSync } from 'child_process';
import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-prefix-rename-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodo, createTodoInFile, moveTodoToDestination, readTodoFile, renameQuestTodo, renameTodoPrefix } from '../questTodoManager.js';
import { createQuestTodoImpl } from '../../tools/quest-todo-tools.js';

/** The workspace's own todo schema: the id rule is read from it (utils/todoIdRule). */
const REAL_SCHEMA = path.join(__dirname, '..', '..', '..', '..', '..', '..', '_ai', 'schemas', 'yaml', 'todo.schema.json');
const schemaFile = path.join(tmpRoot, '_ai', 'schemas', 'yaml', 'todo.schema.json');
const hasSchema = fs.existsSync(REAL_SCHEMA);

const Q = 'rq';
const OTHER = 'oq';
const qDir = path.join(tmpRoot, '_ai', 'quests', Q);
const oDir = path.join(tmpRoot, '_ai', 'quests', OTHER);
const main = path.join(qDir, `todos.${Q}.todo.yaml`);
const topic = path.join(qDir, `topic.${Q}.todo.yaml`);
const archived = path.join(qDir, `todos-archived.${Q}.todo.yaml`);
const deleted = path.join(qDir, `todos-deleted.${Q}.todo.yaml`);
const topicDeleted = path.join(qDir, `topic-deleted.${Q}.todo.yaml`);
const otherMain = path.join(oDir, `todos.${OTHER}.todo.yaml`);

const add = (file: string, id: string, extra: Record<string, unknown> = {}): void => {
    createTodoInFile(file, { id, title: `T ${id}`, description: `do ${id}`, status: 'not-started', ...extra } as never);
};
const ids = (file: string): string[] => (fs.existsSync(file) ? readTodoFile(file).map((t) => t.id) : []);
const todo = (file: string, id: string) => readTodoFile(file).find((t) => t.id === id);
/** Every todo file under `_ai/quests` with its ids — the corpus the guard compares. */
const corpus = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    const root = path.join(tmpRoot, '_ai', 'quests');
    for (const q of fs.readdirSync(root)) {
        for (const f of fs.readdirSync(path.join(root, q))) {
            if (f.endsWith('.todo.yaml')) { out.set(`${q}/${f}`, ids(path.join(root, q, f))); }
        }
    }
    return out;
};
/** check_id_erasure: an id some file held before that no file holds after. */
const erased = (before: Map<string, string[]>, afterC: Map<string, string[]>): string[] => {
    const surviving = new Set([...afterC.values()].flat());
    return [...before.values()].flat().filter((id) => !surviving.has(id));
};

beforeEach(() => {
    fs.rmSync(path.join(tmpRoot, '_ai'), { recursive: true, force: true });
    fs.mkdirSync(qDir, { recursive: true });
    fs.mkdirSync(oDir, { recursive: true });
    fs.rmSync(path.join(tmpRoot, '.git'), { recursive: true, force: true });
    if (hasSchema) {
        fs.mkdirSync(path.dirname(schemaFile), { recursive: true });
        fs.copyFileSync(REAL_SCHEMA, schemaFile);
    }
});
after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('renames the commit guard accepts', () => {
    test('PR-1: one todo — a stub, and the other quest\'s references', () => {
        add(main, 'abc1_x-one');
        add(otherMain, 'far1_x-dep', { blocked_by: [`${Q}/abc1_x-one`] });
        const before = corpus();
        const r = renameQuestTodo(Q, 'abc1_x-one', 'abd1_x-one');
        assert.equal(r.ok, true, JSON.stringify(r));
        const stub = todo(deleted, 'abc1_x-one');
        assert.ok(stub, 'a stub under the old id in the -deleted sibling');
        assert.equal(stub!.status, 'cancelled');
        assert.match(String(stub!.title), /renamed to abd1_x-one/);
        assert.deepEqual(todo(otherMain, 'far1_x-dep')!.blocked_by, [`${Q}/abd1_x-one`], 'the other quest follows');
        assert.deepEqual(erased(before, corpus()), [], 'no id vanished');
    });

    test('PR-2: a group\'s prefix', () => {
        add(main, 'ww1_x-a');
        add(main, 'ww2_x-b', { blocked_by: ['ww1_x-a'], dependencies: [`${Q}/ww1_x-a`] });
        add(main, 'keep1_x-c', { dependencies: ['ww2_x-b'] });
        add(topic, 'ww3_x-d', { blocked_by: ['keep1_x-c'] });
        add(archived, 'ww0_x-old', { status: 'completed' });
        add(otherMain, 'far1_x-dep', { blocked_by: [`${Q}/ww3_x-d`] });
        fs.writeFileSync(path.join(qDir, `overview.${Q}.md`), 'The ww group: ww1 and ww2.\nAlso wwx and aww1 are other words.\n');
        fs.writeFileSync(path.join(qDir, 'notes.md'), 'nothing about it\n');
        const before = corpus();

        const dry = renameTodoPrefix(Q, 'ww', 'xx', { dryRun: true });
        const r = renameTodoPrefix(Q, 'ww', 'xx');
        assert.equal(r.ok, true, JSON.stringify(r));
        if (!r.ok) { return; }
        assert.deepEqual(r.renames, [
            { from: 'ww1_x-a', to: 'xx1_x-a' }, { from: 'ww2_x-b', to: 'xx2_x-b' }, { from: 'ww3_x-d', to: 'xx3_x-d' }]);
        assert.deepEqual(ids(main), ['xx1_x-a', 'xx2_x-b', 'keep1_x-c']);
        assert.deepEqual(ids(topic), ['xx3_x-d'], 'renamed in its own file');
        assert.deepEqual(todo(main, 'xx2_x-b')!.blocked_by, ['xx1_x-a']);
        assert.deepEqual(todo(main, 'xx2_x-b')!.dependencies, [`${Q}/xx1_x-a`]);
        assert.deepEqual(todo(main, 'keep1_x-c')!.dependencies, ['xx2_x-b']);
        assert.deepEqual(todo(otherMain, 'far1_x-dep')!.blocked_by, [`${Q}/xx3_x-d`]);
        assert.deepEqual(ids(deleted).sort(), ['ww1_x-a', 'ww2_x-b'], 'stubs beside the main file');
        assert.deepEqual(ids(topicDeleted), ['ww3_x-d'], 'and beside the topic file');
        assert.deepEqual(ids(archived), ['ww0_x-old'], 'archived todos stay');
        assert.equal(r.stubs, 3);
        assert.ok(r.references >= 4, `references: ${r.references}`);
        assert.ok(dry.ok);
        if (dry.ok) { assert.deepEqual({ references: dry.references, stubs: dry.stubs }, { references: r.references, stubs: r.stubs }, 'PR-7 in passing'); }
        assert.deepEqual(r.documents, [{ file: `overview.${Q}.md`, count: 2 }], 'the documents still naming ww<n>');
        assert.deepEqual(erased(before, corpus()), [], 'the guard\'s corpus rule holds');
    });

    test('PR-3: a dry run writes nothing', () => {
        add(main, 'ww1_x-a');
        fs.writeFileSync(path.join(qDir, `overview.${Q}.md`), 'ww1\n');
        const text = fs.readFileSync(main, 'utf8');
        const r = renameTodoPrefix(Q, 'ww', 'xx', { dryRun: true });
        assert.equal(r.ok, true);
        if (!r.ok) { return; }
        assert.equal(r.dryRun, true);
        assert.deepEqual(r.renames, [{ from: 'ww1_x-a', to: 'xx1_x-a' }]);
        assert.deepEqual(r.documents, [{ file: `overview.${Q}.md`, count: 1 }]);
        assert.equal(fs.readFileSync(main, 'utf8'), text);
        assert.equal(fs.existsSync(deleted), false);
    });

    test('PR-5: a group named with a leading number', () => {
        add(main, '001_cleanup1_x-a');
        add(main, '001_cleanup2_x-b', { blocked_by: ['001_cleanup1_x-a'] });
        add(main, '002_other1_x-c');
        const r = renameTodoPrefix(Q, '001_cleanup', '003_tidy');
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(ids(main).sort(), ['002_other1_x-c', '003_tidy1_x-a', '003_tidy2_x-b']);
        assert.deepEqual(todo(main, '003_tidy2_x-b')?.blocked_by, ['003_tidy1_x-a']);
        assert.deepEqual(ids(deleted).sort(), ['001_cleanup1_x-a', '001_cleanup2_x-b']);
    });

    test('PR-6: an id the todo schema refuses', { skip: hasSchema ? false : 'no todo schema in this checkout' }, async () => {
        add(main, 'cleanup1_x-a');
        add(main, 'cleanup2_x-b', { blocked_by: ['cleanup1_x-a'] });
        const text = fs.readFileSync(main, 'utf8');
        const named = /todo schema \(_ai\/schemas\/yaml\/todo\.schema\.json\) requires .*pattern \^\(\?=/;
        for (const dryRun of [true, false]) {
            const g = renameTodoPrefix(Q, 'cleanup', '_cleanup', { dryRun });
            assert.equal(g.ok, false);
            if (!g.ok) { assert.match(g.reason, named); assert.match(g.reason, /"_cleanup1_x-a" is no todo id.*Also refused: _cleanup2_x-b/); }
        }
        const one = renameQuestTodo(Q, 'cleanup1_x-a', '_cleanup1_x-a');
        assert.equal(one.ok, false);
        if (!one.ok) { assert.match(one.reason, named); }
        assert.equal(renameQuestTodo(Q, 'cleanup1_x-a', '1234').ok, false, 'digits only');
        const move = moveTodoToDestination(main, 'cleanup1_x-a', { kind: 'quest', questId: OTHER }, `quest: ${Q}`, new Map([['cleanup1_x-a', 'Bad1_x']]));
        assert.equal(move.ok, false);
        assert.throws(() => createTodo(Q, { id: '_new1', title: 't', description: 'd', status: 'not-started' } as never), named);
        const tool = JSON.parse(await createQuestTodoImpl({ store: { findById: () => undefined, listTodos: () => [], create: (q: string, t: never, f?: string) => createTodo(q, t, f) } } as never,
            { questId: Q, todo: { id: '-x1', description: 'd' } } as never));
        assert.equal(tool.ok, false);
        assert.match(tool.error, named);
        assert.equal(fs.readFileSync(main, 'utf8'), text, 'nothing written');
        assert.equal(fs.existsSync(deleted), false);
        assert.deepEqual(ids(otherMain), []);
        // The rule is the schema's: a changed pattern is followed (the file is re-read when it changed).
        const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
        schema.$defs.todo.properties.id.pattern = '^[a-z_][a-z0-9_-]*$';
        fs.writeFileSync(schemaFile, JSON.stringify(schema));
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(schemaFile, later, later);
        assert.equal(renameTodoPrefix(Q, 'cleanup', '_cleanup', { dryRun: true }).ok, true, 'the changed schema allows it');
    });

    test('PR-8: a stub only for an id committed at HEAD', () => {
        const git = (...args: string[]): void => {
            const r = spawnSync('git', ['-C', tmpRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
        };
        add(main, 'cc1_x-a');
        git('init', '-q');
        git('add', '-A');
        git('commit', '-q', '--no-verify', '-m', 'cc1');
        add(main, 'cc2_x-b', { blocked_by: ['cc1_x-a'] });
        const dry = renameTodoPrefix(Q, 'cc', 'dd', { dryRun: true });
        const r = renameTodoPrefix(Q, 'cc', 'dd');
        assert.ok(dry.ok && r.ok, JSON.stringify(r));
        if (!dry.ok || !r.ok) { return; }
        assert.equal(r.stubs, 1, 'cc2 was never committed');
        assert.deepEqual(ids(deleted), ['cc1_x-a']);
        assert.deepEqual({ references: dry.references, stubs: dry.stubs }, { references: r.references, stubs: r.stubs });
        assert.equal(r.references, 1);
        const one = renameQuestTodo(Q, 'dd2_x-b', 'ee2_x-b');
        assert.ok(one.ok && !one.stubFile, 'one todo: no stub for an uncommitted id either');
    });

    test('PR-4: refusals', () => {
        add(main, 'ww1_x-a');
        add(main, 'ww2_x-b');
        add(archived, 'xx2_x-b', { status: 'completed' });
        const text = fs.readFileSync(main, 'utf8');
        const refused = (from: string, to: string): string => {
            const r = renameTodoPrefix(Q, from, to);
            assert.equal(r.ok, false, `${from} -> ${to} refused`);
            return r.ok ? '' : r.reason;
        };
        assert.match(refused('ww', 'xx2'), /digit/);
        assert.match(refused('ww', 'ww'), /same/);
        assert.match(refused('nope', 'xx'), /no live todo/);
        assert.match(refused('ww', ''), /Enter a prefix/);
        const collision = renameTodoPrefix(Q, 'ww', 'xx');
        assert.equal(collision.ok, false);
        if (!collision.ok) {
            assert.match(collision.reason, /already has/);
            assert.deepEqual(collision.collisions, ['xx2_x-b']);
        }
        assert.equal(fs.readFileSync(main, 'utf8'), text, 'nothing written');
        assert.equal(fs.existsSync(deleted), false);
    });
});
