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
 *   PR-4 refused, nothing written: a target prefix with a digit (so one ending in a digit), the same prefix, a
 *        group with no live todo, a target whose ids collide with existing todos (archived and deleted count)
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-prefix-rename-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { createTodoInFile, readTodoFile, renameQuestTodo, renameTodoPrefix } from '../questTodoManager.js';

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
