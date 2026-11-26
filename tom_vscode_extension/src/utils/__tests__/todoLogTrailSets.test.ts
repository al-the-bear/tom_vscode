/**
 * Where the answers that report todos are read (src/utils/todoLogTrailSets.ts).
 *
 *   TL-1 the summary pairs of the history folder itself are read, keyed `<name>`; a session storage's
 *        files are not (an Anthropic session's turns are the host trail's)
 *   TL-2 a missing history folder or one without sessions: what there is, no error
 *   TL-3 the host trail: its turns whose answers carry TODO response values, with their session and refs, also as
 *        answer entries of a trail set (`variables` as ` - TODO = <ref>` lines); the TODO LOG reads the host trail
 *        first and opens a trail turn at its block
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hostTrailAnswerEntries, hostTrailTodoEntries, todoLogTrailSets } from '../todoLogTrailSets.js';
import { extractTodoRefsFromVariables } from '../todoLogRefs.js';
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
    test('TL-1: the folder\'s own pairs', () => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-log-'));
        put(h, 'q.copilot.prompts.md');
        put(h, 'q.copilot.answers.md');
        put(h, 'q.localllm-x.answers.md');
        put(h, 'mbp/sessions/chat/q.anthropic.answers.md');
        put(h, 'mbp/sessions/chat/live-trail.md');
        const sets = todoLogTrailSets(h, discoverTrailSets);
        assert.deepEqual([...sets.keys()].sort(), ['q.copilot', 'q.localllm-x']);
        assert.equal(sets.get('q.copilot')?.directory, h);
        assert.equal(sets.get('q.copilot')?.answers, 'q.copilot.answers.md');
        assert.equal(sets.get('q.localllm-x')?.prompts, undefined, 'an answers file alone is a set too');
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
        const entries = hostTrailAnswerEntries(turns);
        assert.deepEqual(entries.map((e) => [e.type, e.requestId, e.session, e.timestamp]), [
            ['ANSWER', 'a', 'walk', '2026-11-25T10:00:00.000Z'], ['ANSWER', 'c', 'walk', '2026-11-25T12:00:00.000Z'],
        ]);
        assert.deepEqual(extractTodoRefsFromVariables(entries[0].variables), ['_ai/quests/q/todos.q.todo.yaml/q1', '_ai/quests/q/todos.q.todo.yaml/q2']);
        assert.equal(entries[0].content, turns[0].answer);
        const handler = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'handlers', 'todoLogPanel-handler.ts'), 'utf8');
        const load = handler.slice(handler.indexOf('private _loadTodoExchanges('));
        assert.ok(load.indexOf('hostTrailTodoEntries(turns)') < load.indexOf('todoLogTrailSets(folder, discoverTrailSets)'), 'the host trail first');
        const open = handler.slice(handler.indexOf('private async _openAnswerInTrailEditor('));
        assert.ok(open.indexOf('hostTrailFile(') < open.indexOf('todoLogTrailSets('), 'a trail turn opens in the trail file');
    });
});
