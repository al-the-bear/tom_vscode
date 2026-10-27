/**
 * The scripting bridge's todo handlers (`todo.*Vce`, src/handlers/tomScriptingBridge-handler.ts) against
 * real todo files in a sandbox workspace — the wire contract tom_vscode_scripting_api's TomTodoApi reads.
 *
 *   SBT-1 deleting a workspace todo moves it to the file's `-deleted` sibling (a completed one to `-archived`);
 *         a missing one answers success false with the reason. A quest todo is deleted the same way
 *   SBT-2 `file` is honoured: get and list of workspace todos read only that file (a workspace-relative path,
 *         as listWorkspaceFilesVce answers); a quest's bare file name is read from the quest folder
 *   SBT-3 session todos: created `done` arrives done; an update carries the tags; an update that names no
 *         status leaves it as it is (it used to reopen a done todo); a missing one is an error; delete moves
 *         it to the session file's sibling
 *   SBT-4 get of a missing todo answers null, in all three scopes
 */

/* eslint-disable @typescript-eslint/naming-convention -- todo YAML keys */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-todos-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { TomScriptingBridgeHandler } from '../tomScriptingBridge-handler.js';
import { SessionTodoStore } from '../../managers/sessionTodoStore.js';
import { readTodoFile } from '../../managers/questTodoManager.js';

after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

function todoFile(rel: string, todos: Array<Record<string, unknown>>): string {
    const fp = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const items = todos.map((t) => '  - ' + Object.entries(t).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n    ')).join('\n');
    fs.writeFileSync(fp, `todos:\n${items}\n`);
    return fp;
}
const ids = (fp: string): string[] => (fs.existsSync(fp) ? readTodoFile(fp).map((t) => t.id) : []);

const bridge = new TomScriptingBridgeHandler({} as never);
const call = (method: string, params: Record<string, unknown>): Promise<any> => bridge.handleBridgeRequest(method, params);

describe('scripting bridge: todo handlers', () => {
    test('SBT-1: delete is recoverable and says when it did nothing', async () => {
        const ws = todoFile('workspace.todo.yaml', [
            { id: 'w1', description: 'open', status: 'not-started' },
            { id: 'w2', description: 'done', status: 'completed' },
        ]);
        const r1 = await call('todo.deleteWorkspaceVce', { todoId: 'w1' });
        assert.equal(r1.success, true);
        assert.deepEqual(ids(ws), ['w2'], 'gone from the file — it used to stay, set to cancelled');
        assert.deepEqual(ids(path.join(tmpRoot, 'workspace-deleted.todo.yaml')), ['w1']);
        assert.equal(r1.movedTo, path.join(tmpRoot, 'workspace-deleted.todo.yaml'));
        assert.equal((await call('todo.deleteWorkspaceVce', { todoId: 'w2' })).success, true);
        assert.deepEqual(ids(path.join(tmpRoot, 'workspace-archived.todo.yaml')), ['w2'], 'a completed todo is archived');
        const missing = await call('todo.deleteWorkspaceVce', { todoId: 'nope' });
        assert.equal(missing.success, false);
        assert.match(missing.error, /nope/);

        const qf = todoFile('_ai/quests/q1/todos.q1.todo.yaml', [{ id: 'q1a', description: 'x', status: 'not-started' }]);
        assert.equal((await call('todo.deleteQuestVce', { questId: 'q1', todoId: 'q1a' })).success, true);
        assert.deepEqual(ids(qf), []);
        assert.deepEqual(ids(path.join(tmpRoot, '_ai/quests/q1/todos-deleted.q1.todo.yaml')), ['q1a']);
    });

    test('SBT-2: file is honoured', async () => {
        todoFile('a/one.todo.yaml', [{ id: 'same', title: 'in one', description: 'x', status: 'not-started' }]);
        todoFile('b/two.todo.yaml', [{ id: 'same', title: 'in two', description: 'x', status: 'not-started' }, { id: 'only2', description: 'y', status: 'not-started' }]);
        assert.equal((await call('todo.getWorkspaceVce', { todoId: 'same', file: 'b/two.todo.yaml' })).title, 'in two');
        assert.equal((await call('todo.getWorkspaceVce', { todoId: 'same', file: 'a/one.todo.yaml' })).title, 'in one');
        assert.equal(await call('todo.getWorkspaceVce', { todoId: 'only2', file: 'a/one.todo.yaml' }), null, 'not in that file');
        const listed = await call('todo.listWorkspaceVce', { file: 'b/two.todo.yaml' });
        assert.deepEqual(listed.todos.map((t: any) => t.id), ['same', 'only2']);
        assert.equal(listed.file, 'b/two.todo.yaml');

        todoFile('_ai/quests/q2/topic.q2.todo.yaml', [{ id: 'q2a', title: 'topic', description: 'x', status: 'not-started' }]);
        assert.equal((await call('todo.getQuestVce', { questId: 'q2', todoId: 'q2a', file: 'topic.q2.todo.yaml' })).title, 'topic',
            'a bare name is read from the quest folder, not the working directory');
        assert.deepEqual((await call('todo.listQuestVce', { questId: 'q2', file: 'topic.q2.todo.yaml' })).todos.map((t: any) => t.id), ['q2a']);
    });

    test('SBT-3: session todos keep what the caller sent', async () => {
        SessionTodoStore.init({} as never);
        const created = await call('todo.createSessionVce', { todo: { title: 'already done', details: 'd', status: 'done', tags: ['a'] } });
        assert.equal(created.status, 'done', 'it used to arrive pending');
        const tagged = await call('todo.updateSessionVce', { todo: { id: created.id, tags: ['a', 'b'] } });
        assert.deepEqual(tagged.tags, ['a', 'b'], 'tags used to be dropped');
        assert.equal(tagged.status, 'done', 'an update without a status leaves it done');
        const renamed = await call('todo.updateSessionVce', { todo: { id: created.id, title: 'renamed' } });
        assert.equal(renamed.title, 'renamed');
        assert.equal(renamed.status, 'done');
        assert.deepEqual(renamed.tags, ['a', 'b'], 'tags not given stay');
        await assert.rejects(call('todo.updateSessionVce', { todo: { id: 'wt-999', title: 'x' } }), /not found/);
        const open = await call('todo.createSessionVce', { todo: { title: 'open' } });
        assert.equal(open.status, 'pending');
        const del = await call('todo.deleteSessionVce', { todoId: open.id });
        assert.equal(del.success, true);
        assert.equal(await call('todo.getSessionVce', { todoId: open.id }), null);
    });

    test('SBT-4: a missing todo is null', async () => {
        assert.equal(await call('todo.getQuestVce', { questId: 'q1', todoId: 'nope' }), null);
        assert.equal(await call('todo.getWorkspaceVce', { todoId: 'nope' }), null);
        assert.equal(await call('todo.getSessionVce', { todoId: 'nope' }), null);
    });
});
