/**
 * Where the current-prompt files of a send go (decision finishvsc5, a): only the session's own trail
 * folder, `history/sessions/<session>/trail/` — the one the @WS Logs Current Prompt tab reads. A send
 * without a session (an isolated call: compaction, memory extraction) is not a user prompt and writes
 * none. The quest-level trail bucket (`_ai/trail/anthropic/<quest>/`) is no longer written.
 *
 *   CP-1 both phases write the three files of their origin into the session's trail folder only
 *   CP-2 a send without a session writes nothing anywhere
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'current-prompt-'));
installVscodeStub({ workspaceFolders: [ws] });

import { beginCurrentPrompt, writeCurrentPrompt } from '../current-prompt-dump.js';

/** Every file under the workspace, relative and sorted. */
function filesUnder(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) { walk(p); } else { out.push(path.relative(root, p).split(path.sep).join('/')); }
        }
    };
    walk(root);
    return out.sort();
}

describe('current-prompt files', () => {
    test('CP-1: into the session\'s trail folder only', () => {
        const quest = 'cpq1';
        beginCurrentPrompt({ source: 'queue', literal: 'do it', questId: quest, session: 'default' });
        const folder = `_ai/quests/${quest}/history/sessions/default/trail`;
        assert.deepEqual(filesUnder(ws).filter((f) => f.includes(quest)), [
            `${folder}/current_prompt.queue.literal.md`,
            `${folder}/current_prompt.queue.system.md`,
            `${folder}/current_prompt.queue.user.md`,
        ]);
        writeCurrentPrompt({ source: 'queue', literal: 'do it', user: 'do it, expanded', system: 'SYSTEM', questId: quest, session: 'default' });
        assert.equal(fs.readFileSync(path.join(ws, folder, 'current_prompt.queue.user.md'), 'utf-8').includes('do it, expanded'), true);
        assert.equal(filesUnder(ws).filter((f) => f.includes(quest)).length, 3, 'still the three files, nowhere else');
        assert.equal(filesUnder(path.join(ws, '_ai', 'trail')).length, 0, 'the quest-level trail bucket is not written');
    });

    test('CP-2: a send without a session writes nothing', () => {
        const quest = 'cpq2';
        beginCurrentPrompt({ source: 'chat', literal: 'internal', questId: quest });
        writeCurrentPrompt({ source: 'chat', literal: 'internal', user: 'internal', system: 'S', questId: quest });
        assert.deepEqual(filesUnder(ws).filter((f) => f.includes(quest)), []);
    });
});
