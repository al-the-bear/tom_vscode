/**
 * Session todos per session (services/sessionTodoFiles.ts, managers/sessionTodoStore.ts).
 *
 *   ST-1 a todo goes to the session the tool call runs in, else to the session the view shows, else
 *        `default`; each session's file is history/sessions/<session>/session-todos.todo.yaml and lists
 *        only its own todos; ids count per session
 *   ST-2 the counts per session (open, all, most recently written first) and a session's file path as the
 *        panel names it (relative to the quest folder, and back)
 *   ST-3 the former per-machine file is taken over once: its open todos go to `default`, done ones are
 *        dropped, the file and its siblings are removed
 *   ST-4 the session's storage removed (a deleted session) takes its todos with it
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-todos-')));
installVscodeStub({ workspaceFolders: [tmpRoot] });

import { WsPaths } from '../../utils/workspacePaths.js';
import { sessionTodoFilename } from '../../utils/sessionTodoNames.js';
import { createTodoInFile, ensureTodoFile, readTodoFile } from '../questTodoManager.js';
import { SessionTodoStore } from '../sessionTodoStore.js';
import { sessionOfTodoSourceFile, sessionTodoCounts, sessionTodoSourceFile } from '../../services/sessionTodoFiles.js';
import { removeSessionStorage } from '../../services/sessionStorage.js';
import { setActiveToolTrail } from '../../services/tool-trail.js';

const QUEST = 'default';
const questDir = path.join(tmpRoot, '_ai', 'quests', QUEST);
const historyRoot = path.join(questDir, 'history');
const statuses = (file: string): string[] => readTodoFile(file).map((t) => String(t.status));

// The former per-machine file, with an open and a done todo, before the store starts.
fs.mkdirSync(questDir, { recursive: true });
const formerName = sessionTodoFilename(WsPaths.hostSlug(), QUEST);
const former = path.join(questDir, formerName);
ensureTodoFile(former, { quest: QUEST });
createTodoInFile(former, { id: 'wt-1', title: 'carried over', description: 'carried over', status: 'not-started' }, { quest: QUEST });
createTodoInFile(former, { id: 'wt-2', title: 'already done', description: 'already done', status: 'completed' }, { quest: QUEST });
const formerArchived = path.join(questDir, formerName.replace(/^session-todo\./, 'session-todo-archived.'));
ensureTodoFile(formerArchived, { quest: QUEST });

const store = SessionTodoStore.init();
const onTrail = (session: string | undefined): void => { setActiveToolTrail({ session } as never); };

after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('session todos per session', () => {
    test('ST-3: the former per-machine file is taken over', () => {
        assert.equal(fs.existsSync(former), false);
        assert.equal(fs.existsSync(formerArchived), false, 'its siblings go too');
        const defaults = store.list({ status: 'all' }, 'default');
        assert.deepEqual(defaults.map((t) => t.title), ['carried over'], 'the open one; the done one is dropped');
    });

    test('ST-1: the session a todo goes to', () => {
        onTrail('alpha');
        const a = store.add('in alpha', 'copilot');
        assert.equal(a.id, 'wt-1', 'ids count per session');
        onTrail(undefined);
        store.shownSession = 'beta';
        const b = store.add('in beta (the view\'s session)', 'copilot');
        assert.equal(b.id, 'wt-1');
        store.shownSession = 'default';
        assert.deepEqual(store.list({ status: 'all' }, 'alpha').map((t) => t.title), ['in alpha']);
        assert.deepEqual(store.list({ status: 'all' }, 'beta').map((t) => t.title), ['in beta (the view\'s session)']);
        assert.ok(fs.existsSync(path.join(historyRoot, 'sessions', 'alpha', 'session-todos.todo.yaml')));
        onTrail('alpha');
        assert.equal(store.getAll().session, 'alpha');
        store.update('wt-1', { status: 'done' });
        assert.equal(store.get('wt-1', 'alpha')?.status, 'done');
        assert.equal(store.get('wt-1', 'beta')?.status, 'pending', 'another session\'s todo of the same id is untouched');
        onTrail(undefined);
    });

    test('ST-2: counts and paths', () => {
        store.add('second in beta', 'copilot', undefined, 'beta');
        const counts = sessionTodoCounts(historyRoot, statuses);
        const bySession = Object.fromEntries(counts.map((c) => [c.session, [c.open, c.total]]));
        assert.deepEqual(bySession, { alpha: [0, 1], beta: [2, 2], default: [1, 1] });
        assert.equal(counts[0].session, 'beta', 'most recently written first');
        assert.equal(sessionTodoSourceFile('beta'), 'history/sessions/beta/session-todos.todo.yaml');
        assert.equal(sessionOfTodoSourceFile('history/sessions/beta/session-todos.todo.yaml'), 'beta');
        assert.equal(sessionOfTodoSourceFile('todos.default.todo.yaml'), undefined);
        assert.equal(store.openCount('beta'), 2);
    });

    test('ST-4: deleting a session takes its todos', () => {
        removeSessionStorage(historyRoot, path.join(tmpRoot, '_ai', 'memory'), QUEST, 'beta');
        assert.deepEqual(store.list({ status: 'all' }, 'beta'), []);
        assert.deepEqual(sessionTodoCounts(historyRoot, statuses).map((c) => c.session).sort(), ['alpha', 'default']);
    });
});
