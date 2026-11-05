/**
 * Where the TODO Log view reads its trail pairs (src/utils/todoLogTrailSets.ts).
 *
 *   TL-1 the summary pairs of every Anthropic session (history/sessions/<session>/) are read, keyed
 *        `<session>/<name>` with their own folder, beside the history folder's own pairs (`<name>`);
 *        the view was empty because it read only the history folder, where no session writes
 *   TL-2 a missing history folder or one without sessions: what there is, no error
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { todoLogTrailSets } from '../todoLogTrailSets.js';
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
});
