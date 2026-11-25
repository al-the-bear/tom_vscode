/**
 * Where the TODO Log view reads its trail pairs (src/utils/todoLogTrailSets.ts).
 *
 *   TL-1 the summary pairs of every Anthropic session (history/sessions/<session>/) are read, keyed
 *        `<session>/<name>` with their own folder, beside the history folder's own pairs (`<name>`);
 *        the view was empty because it read only the history folder, where no session writes
 *   TL-2 a missing history folder or one without sessions: what there is, no error
 *   TL-3 the host trail: its turns whose answers carry TODO response values, with their session and refs; an
 *        older pair's answer counts only when the trail does not have it and it is older than the trail's oldest
 *        turn; the TODO LOG reads the host trail first and opens a trail turn at its block
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hostTrailTodoEntries, keepOlderPairAnswer, todoLogTrailSets } from '../todoLogTrailSets.js';
import type { HostTrailTurn } from '../../services/hostTrail.js';
/** The trail editor's discoverTrailSets (which needs vscode), as it pairs the files. */
function discoverTrailSets(folder: string): Map<string, { prompts?: string; answers?: string }> {
    const sets = new Map<string, { prompts?: string; answers?: string }>();
    for (const f of fs.readdirSync(folder)) {
        const m = /^(.*)\.(prompts|answers)\.md$/.exec(f);
        if (!m) { continue; }
        const set = sets.get(m[1]) ?? {};
        set[m[2] as 'prompts' | 'answers'] = f;
        sets.set(m[1], set);
    }
    return sets;
}

function put(root: string, rel: string): void {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
}

describe('TODO Log trail sets', () => {
    test('TL-1: the sessions\' pairs and the folder\'s own', () => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-log-'));
        put(h, 'q.copilot.prompts.md');
        put(h, 'q.copilot.answers.md');
        put(h, 'sessions/default/q.anthropic.prompts.md');
        put(h, 'sessions/default/q.anthropic.answers.md');
        put(h, 'sessions/chat/q.anthropic.answers.md');
        put(h, 'sessions/chat/live-trail.md');
        const sets = todoLogTrailSets(h, discoverTrailSets);
        assert.deepEqual([...sets.keys()].sort(), ['chat/q.anthropic', 'default/q.anthropic', 'q.copilot']);
        assert.equal(sets.get('default/q.anthropic')?.directory, path.join(h, 'sessions', 'default'));
        assert.equal(sets.get('default/q.anthropic')?.answers, 'q.anthropic.answers.md');
        assert.equal(sets.get('q.copilot')?.directory, h);
        assert.equal(sets.get('chat/q.anthropic')?.prompts, undefined, 'an answers file alone is a set too');
        fs.rmSync(h, { recursive: true, force: true });
    });

    test('TL-2: missing folders', () => {
        assert.equal(todoLogTrailSets(path.join(os.tmpdir(), 'no-such-history-folder'), discoverTrailSets).size, 0);
        const h = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-log-'));
        put(h, 'q.copilot.answers.md');
        assert.deepEqual([...todoLogTrailSets(h, discoverTrailSets).keys()], ['q.copilot']);
        fs.rmSync(h, { recursive: true, force: true });
    });
    test('TL-3: the host trail', () => {
        const turn = (id: string, time: string, answer: string): HostTrailTurn => ({ id, time, host: 'mbp', session: 'walk', profile: 'p', model: 'm', prompt: 'x', answer });
        const turns = [
            turn('a', '2026-11-25T10:00:00.000Z', 'Done.\n\nvariables:\n - TODO = _ai/quests/q/todos.q.todo.yaml/q1\n - TODO2 = _ai/quests/q/todos.q.todo.yaml/q2\n'),
            turn('b', '2026-11-25T11:00:00.000Z', 'No todo here.'),
            turn('c', '2026-11-25T12:00:00.000Z', '{"responseValues": {"TODO": "_ai/quests/q/todos.q.todo.yaml/q3"}}'),
        ];
        assert.deepEqual(hostTrailTodoEntries(turns), [
            { requestId: 'a', timestamp: '2026-11-25T10:00:00.000Z', session: 'walk', refs: ['_ai/quests/q/todos.q.todo.yaml/q1', '_ai/quests/q/todos.q.todo.yaml/q2'] },
            { requestId: 'c', timestamp: '2026-11-25T12:00:00.000Z', session: 'walk', refs: ['_ai/quests/q/todos.q.todo.yaml/q3'] },
        ]);
        assert.equal(keepOlderPairAnswer('old', '2026-11-24T10:00:00.000Z', turns), true, 'older than the trail');
        assert.equal(keepOlderPairAnswer('a', '2026-11-24T10:00:00.000Z', turns), false, 'the trail has it');
        assert.equal(keepOlderPairAnswer('late', '2026-11-25T10:30:00.000Z', turns), false, 'after the trail began');
        assert.equal(keepOlderPairAnswer('any', '2026-11-25T10:30:00.000Z', []), true, 'no trail yet: every answer');
        const handler = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'todoLogPanel-handler.ts'), 'utf8');
        const load = handler.slice(handler.indexOf('private _loadTodoExchanges('));
        assert.ok(load.indexOf('hostTrailTodoEntries(turns)') < load.indexOf('todoLogTrailSets(folder, discoverTrailSets)'), 'the host trail first');
        assert.match(load, /if \(!keepOlderPairAnswer\(entry\.requestId, entry\.timestamp, turns\)\) \{ continue; \}/);
        const open = handler.slice(handler.indexOf('private async _openAnswerInTrailEditor('));
        assert.ok(open.indexOf('hostTrailFile(') < open.indexOf('todoLogTrailSets('), 'a trail turn opens in the trail file');
    });
});
