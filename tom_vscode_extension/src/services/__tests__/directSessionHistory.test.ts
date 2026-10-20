/**
 * Named sessions for the direct API transport (vsctasc2): which history a
 * send reads and writes, chosen by the same session name the Agent SDK path
 * uses (src/services/directSessionHistory.ts).
 *
 *   DH-1 the plan: the panel's `chat` and the queue's `default` share the quest's history; any other
 *        session has its own; `continue` with a base copies the base's history once; `fork-from-base`
 *        reads its base's history (through bases that are themselves forks) and writes nothing; a
 *        cycle or a fork without a base is refused
 *   DH-2 the folders: the shared history is the quest's history folder, a session's its own
 *        `sessions/<name>/` beside it
 *   DH-3 the scope: a session reads and writes only its own folder; a fork reads its base's folder
 *        and is marked not to persist; a based session is seeded from its base once — later
 *        changes to the base do not reach it, and the base is never changed
 *   DH-4 the scope key changes with the quest, the folder and persisting, so the handler knows when
 *        to load another history
 *   DH-5 the wiring (the handler and the queue manager import vscode and cannot run under node:test, so
 *        their sources are read): sendMessage chooses the scope from options.sessionKey before seeding,
 *        never for an isolated send; every history read and write goes through the scope's folder and
 *        no quest-keyed accumulator call is left; a fork's exchange is not saved and not compacted;
 *        the queue item's session is `session`, read from either YAML key and written as `session`
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SessionRecord } from '../../utils/agentSdkSessions.js';
import {
    SHARED_HISTORY_SESSIONS,
    hasSessionHistory,
    planDirectHistory,
    resolveHistoryScope,
    sessionHistoryFolder,
} from '../directSessionHistory.js';

const records = (list: SessionRecord[]): ((n: string) => SessionRecord | undefined) => (n) => list.find((r) => r.name === n);

describe('direct-transport session history', () => {
    test('DH-1: the plan', () => {
        assert.deepEqual([...SHARED_HISTORY_SESSIONS], ['chat', 'default']);
        const read = records([
            { name: 'prep', mode: 'continue' },
            { name: 'work', mode: 'continue', basedOn: 'prep' },
            { name: 'todo', mode: 'fork-from-base', basedOn: 'prep' },
            { name: 'todo2', mode: 'fork-from-base', basedOn: 'todo' },
            { name: 'from-queue', mode: 'continue', basedOn: 'default' },
            { name: 'loop-a', mode: 'fork-from-base', basedOn: 'loop-b' },
            { name: 'loop-b', mode: 'fork-from-base', basedOn: 'loop-a' },
            { name: 'baseless', mode: 'fork-from-base' },
        ]);
        assert.deepEqual(planDirectHistory('default', read), { own: 'default', readFrom: 'default', persist: true });
        assert.deepEqual(planDirectHistory('chat', read), { own: 'chat', readFrom: 'chat', persist: true });
        assert.deepEqual(planDirectHistory('unknown', read), { own: 'unknown', readFrom: 'unknown', persist: true }, 'no file yet: its own history');
        assert.deepEqual(planDirectHistory('prep', read), { own: 'prep', readFrom: 'prep', persist: true });
        assert.deepEqual(planDirectHistory('work', read), { own: 'work', readFrom: 'work', persist: true, seedFrom: 'prep' });
        assert.deepEqual(planDirectHistory('todo', read), { own: 'todo', readFrom: 'prep', persist: false });
        assert.deepEqual(planDirectHistory('todo2', read), { own: 'todo2', readFrom: 'prep', persist: false }, 'a fork of a fork reads the first real history');
        assert.deepEqual(planDirectHistory('from-queue', read), { own: 'from-queue', readFrom: 'from-queue', persist: true, seedFrom: 'default' });
        assert.throws(() => planDirectHistory('loop-a', read), /cycle/);
        assert.throws(() => planDirectHistory('baseless', read), /names no base/);
    });

    test('DH-2: the folders', () => {
        const root = path.join('q', 'history');
        assert.equal(sessionHistoryFolder(root, 'default'), root);
        assert.equal(sessionHistoryFolder(root, 'chat'), root);
        assert.equal(sessionHistoryFolder(root, 'p2s3r1'), path.join(root, 'sessions', 'p2s3r1'));
    });

    test('DH-3: the scope a send reads and writes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-sessions-'));
        const write = (folder: string, file: string, text: string): void => {
            fs.mkdirSync(folder, { recursive: true });
            fs.writeFileSync(path.join(folder, file), text);
        };
        const session = (name: string, body: Record<string, unknown>): void => write(root, `${name}.session.json`, JSON.stringify(body));
        session('prep', { mode: 'continue' });
        session('work', { mode: 'continue', basedOn: 'prep' });
        session('todo', { mode: 'fork-from-base', basedOn: 'prep' });
        const prepFolder = path.join(root, 'sessions', 'prep');
        write(prepFolder, 'compacted_history.md', 'prep blocks');
        write(prepFolder, 'rawTurns.json', '{"rounds":[["prep"]]}');
        write(root, 'rawTurns.json', '{"rounds":[["shared"]]}');

        const shared = resolveHistoryScope('q1', root, 'default');
        assert.deepEqual([shared.folder, shared.persist, shared.shared], [root, true, true]);

        const prep = resolveHistoryScope('q1', root, 'prep');
        assert.deepEqual([prep.folder, prep.persist, prep.shared], [prepFolder, true, false]);

        const todo = resolveHistoryScope('q1', root, 'todo');
        assert.deepEqual([todo.folder, todo.persist], [prepFolder, false], 'a fork reads its base and writes nothing');

        const workFolder = path.join(root, 'sessions', 'work');
        assert.equal(hasSessionHistory(workFolder), false);
        const work = resolveHistoryScope('q1', root, 'work');
        assert.deepEqual([work.folder, work.persist], [workFolder, true]);
        assert.equal(fs.readFileSync(path.join(workFolder, 'compacted_history.md'), 'utf8'), 'prep blocks', 'seeded from its base');
        assert.equal(fs.readFileSync(path.join(workFolder, 'rawTurns.json'), 'utf8'), '{"rounds":[["prep"]]}');
        assert.match(work.note ?? '', /started from "prep"/);

        write(prepFolder, 'compacted_history.md', 'prep moved on');
        write(workFolder, 'rawTurns.json', '{"rounds":[["work"]]}');
        resolveHistoryScope('q1', root, 'work');
        assert.equal(fs.readFileSync(path.join(workFolder, 'compacted_history.md'), 'utf8'), 'prep blocks', 'seeded once: later base changes do not reach it');
        assert.equal(fs.readFileSync(path.join(workFolder, 'rawTurns.json'), 'utf8'), '{"rounds":[["work"]]}', 'its own history is kept');
        assert.equal(fs.readFileSync(path.join(prepFolder, 'compacted_history.md'), 'utf8'), 'prep moved on', 'the base is never written');
        assert.equal(fs.readFileSync(path.join(root, 'rawTurns.json'), 'utf8'), '{"rounds":[["shared"]]}', 'the shared history is untouched');
    });

    test('DH-4: the scope key', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-keys-'));
        fs.writeFileSync(path.join(root, 'todo.session.json'), JSON.stringify({ mode: 'fork-from-base', basedOn: 'prep' }));
        fs.writeFileSync(path.join(root, 'prep.session.json'), JSON.stringify({ mode: 'continue' }));
        const key = (quest: string, name: string): string => resolveHistoryScope(quest, root, name).key;
        assert.equal(key('q1', 'default'), key('q1', 'chat'), 'the panel and the queue share the quest history');
        assert.notEqual(key('q1', 'default'), key('q2', 'default'), 'another quest: another history');
        assert.notEqual(key('q1', 'prep'), key('q1', 'default'));
        assert.notEqual(key('q1', 'todo'), key('q1', 'prep'), 'the same folder, but a fork does not persist: reloaded from its base each time');
    });

    test('DH-5: the wiring', () => {
        const src = (...p: string[]): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', ...p), 'utf8');
        const handler = src('handlers', 'anthropic-handler.ts');
        const code = handler.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        const select = code.indexOf('await this.selectHistoryScope(quest, options.sessionKey);');
        const seed = code.indexOf('this.seedHistoryFromSnapshot(quest);');
        assert.ok(select > 0 && seed > select, 'the scope is chosen before the history is seeded');
        assert.match(code, /if \(!options\.isolated\) \{\s*await this\.selectHistoryScope/, 'an isolated send never changes it');
        assert.doesNotMatch(code, /\b(saveCompactionRounds|loadCompactionRounds|clearCompactionRounds)\(/, 'no quest-keyed accumulator call is left');
        const body = (name: string): string => {
            const start = code.indexOf(`private ${name}(`);
            assert.ok(start > 0, `${name} not found`);
            return code.slice(start, code.indexOf('\n    }\n', start));
        };
        for (const m of ['persistRoundAndReloadUnion', 'seedHistoryFromSnapshot', 'persistSessionHistory']) {
            assert.match(body(m), /this\.scopeFolder\(questId\)/, `${m} uses the scope's folder`);
            assert.doesNotMatch(body(m), /historyFolder\(questId\)/, `${m} does not take the quest's folder itself`);
        }
        assert.match(body('persistRoundAndReloadUnion'), /if \(!this\.persistsHistory\)/, 'a fork saves no round');
        assert.match(body('persistSessionHistory'), /if \(!this\.persistsHistory\) \{ return; \}/, 'a fork saves no history');
        assert.match(body('scheduleBackgroundCompactionAndExtraction'), /if \(!this\.persistsHistory\) \{ return; \}/, 'a fork is not compacted');

        const queue = src('managers', 'promptQueueManager.ts');
        assert.doesNotMatch(queue, /\bagentSdkSession\b/, 'the item field is `session`');
        assert.match(queue, /session: main\.session \|\| main\['agent-sdk-session'\] \|\| undefined/, 'read from either key');
        assert.match(queue, /\.\.\.\(item\.session \? \{ session: item\.session \} : \{\}\)/, 'written as session');
        assert.doesNotMatch(queue, /'agent-sdk-session': item/, 'never written under the old key');
    });
});
