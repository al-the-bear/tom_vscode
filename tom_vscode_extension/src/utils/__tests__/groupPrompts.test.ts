/**
 * Group prompts: the prompt a todo-group walk sends for each todo
 * (src/utils/groupPrompts.ts) and their files (src/services/groupPromptStore.ts).
 *
 *   GP-1 the picker's choices: the default, the default with each global addition, with each quest
 *        addition, the quest's own prompts — names in natural order; an addition follows the default
 *        after a blank line
 *   GP-2 the default a set uses: the quest's own, else the global one, else the built-in one
 *   GP-3 names: what may become `<name>.md`; files of the folders map back to their kind and name, other
 *        files are not entries
 *   GP-4 the preview of an entry: what a walk sends with it, and a note
 *   GP-5 the store reads both folders, writes (folders created) and deletes; a scope refuses a kind it
 *        does not hold and a name that cannot be a file
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    BUILTIN_GROUP_PROMPT,
    composeGroupPrompt,
    effectiveGroupDefault,
    groupPromptChoices,
    groupPromptNameError,
    groupPromptOfFile,
    groupPromptPreview,
    type GroupPromptEntry,
} from '../groupPrompts.js';
import { deleteGroupPrompt, groupPromptDirsUnder, readGroupPrompts, writeGroupPrompt } from '../../services/groupPromptStore.js';

const e = (scope: GroupPromptEntry['scope'], kind: GroupPromptEntry['kind'], name: string, text: string): GroupPromptEntry => ({ scope, kind, name, text });

describe('group prompts', () => {
    test('GP-1: the picker choices, in order', () => {
        const entries = [
            e('quest', 'prompt', 'review only', 'Review ${repeatTodoId}.'),
            e('global', 'addition', 'tests10', 'Run the tests.'),
            e('global', 'default', '', 'Do ${repeatTodoId}.'),
            e('quest', 'addition', 'gates', 'Run the gates.'),
            e('global', 'addition', 'tests2', '\n  Commit.  \n'),
        ];
        const choices = groupPromptChoices(entries, 'q1');
        assert.deepEqual(choices.map((c) => [c.label, c.description]), [
            ['Default', 'the default'],
            ['Default + tests2', 'global addition'],
            ['Default + tests10', 'global addition'],
            ['Default + gates', 'q1 addition'],
            ['review only', 'q1 prompt'],
        ]);
        assert.equal(choices[0].text, 'Do ${repeatTodoId}.');
        assert.equal(choices[1].text, 'Do ${repeatTodoId}.\n\nCommit.', 'after a blank line, trimmed');
        assert.equal(choices[4].text, 'Review ${repeatTodoId}.', 'a quest prompt is sent as it is');
        assert.equal(composeGroupPrompt('A\n\n', '  '), 'A', 'an empty addition adds nothing');
    });

    test('GP-2: the default a set uses', () => {
        assert.deepEqual(effectiveGroupDefault([]), { text: BUILTIN_GROUP_PROMPT, from: 'builtin' });
        assert.equal(groupPromptChoices([], 'q1')[0].description, 'the built-in default');
        const global = e('global', 'default', '', 'G');
        assert.deepEqual(effectiveGroupDefault([global]), { text: 'G', from: 'global' });
        const both = [global, e('quest', 'default', '', 'Q'), e('global', 'addition', 'x', 'X')];
        assert.deepEqual(effectiveGroupDefault(both), { text: 'Q', from: 'quest' });
        const choices = groupPromptChoices(both, 'q1');
        assert.equal(choices[0].description, "q1's default");
        assert.equal(choices[1].text, 'Q\n\nX', 'additions follow the default the quest uses');
        assert.match(BUILTIN_GROUP_PROMPT, /\$\{repeatTodoId\}/);
    });

    test('GP-3: names and files', () => {
        assert.equal(groupPromptNameError('run tests_2.v1'), undefined);
        for (const bad of ['', ' ', '../x', 'a/b', '-x', 'x.', 'ä']) { assert.ok(groupPromptNameError(bad), `refused: "${bad}"`); }
        assert.deepEqual(groupPromptOfFile('default.md'), { kind: 'default', name: '' });
        assert.deepEqual(groupPromptOfFile('additions/run tests.md'), { kind: 'addition', name: 'run tests' });
        assert.deepEqual(groupPromptOfFile('prompts/review.md'), { kind: 'prompt', name: 'review' });
        for (const other of ['notes.md', 'additions/x.txt', 'other/x.md', 'additions/sub/x.md', 'additions/.hidden.md']) {
            assert.equal(groupPromptOfFile(other), undefined, other);
        }
    });

    test('GP-4: the preview', () => {
        const entries = [e('global', 'default', '', 'G'), e('global', 'addition', 'x', 'X'), e('quest', 'prompt', 'p', 'P')];
        assert.deepEqual(groupPromptPreview(entries, 'global:addition:x'), { text: 'G\n\nX', note: 'after the default' });
        assert.deepEqual(groupPromptPreview(entries, 'quest:prompt:p'), { text: 'P', note: 'sent instead of the default' });
        assert.deepEqual(groupPromptPreview(entries, 'global:default:'), { text: 'G', note: 'sent as it is' });
        const overridden = [...entries, e('quest', 'default', '', 'Q')];
        assert.deepEqual(groupPromptPreview(overridden, 'global:default:'), { text: 'G', note: 'this quest uses its own default instead' });
        assert.equal(groupPromptPreview(entries, 'quest:addition:none'), undefined);
    });

    test('GP-5: the store', (t) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-prompts-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const dirs = groupPromptDirsUnder(path.join(root, '_ai'), 'q1');
        assert.deepEqual(dirs, { global: path.join(root, '_ai', 'group_prompts'), quest: path.join(root, '_ai', 'quests', 'q1', 'group_prompts') });
        assert.deepEqual(groupPromptDirsUnder(path.join(root, '_ai'), undefined), { global: dirs.global }, 'no quest, no quest folder');
        assert.deepEqual(readGroupPrompts(dirs), [], 'no folders yet');
        writeGroupPrompt(dirs, e('global', 'default', '', 'G'));
        writeGroupPrompt(dirs, e('global', 'addition', 'x', 'X'));
        writeGroupPrompt(dirs, e('quest', 'prompt', 'p', 'P'));
        writeGroupPrompt(dirs, e('quest', 'default', '', 'Q'));
        assert.equal(fs.readFileSync(path.join(dirs.global, 'additions', 'x.md'), 'utf8'), 'X');
        fs.writeFileSync(path.join(dirs.global, 'README.md'), 'not an entry');
        fs.mkdirSync(path.join(dirs.global, 'prompts'), { recursive: true });
        fs.writeFileSync(path.join(dirs.global, 'prompts', 'g.md'), 'a global prompt is not a kind of the global folder');
        assert.deepEqual(readGroupPrompts(dirs).map((x) => [x.scope, x.kind, x.name, x.text]), [
            ['global', 'default', '', 'G'],
            ['global', 'addition', 'x', 'X'],
            ['quest', 'default', '', 'Q'],
            ['quest', 'prompt', 'p', 'P'],
        ]);
        assert.throws(() => writeGroupPrompt(dirs, e('global', 'prompt', 'g', 'x')), /cannot be a prompt/);
        assert.throws(() => writeGroupPrompt(dirs, e('quest', 'addition', '../escape', 'x')), /Letters, digits/);
        assert.throws(() => writeGroupPrompt({ global: dirs.global }, e('quest', 'addition', 'x', 'x')), /no quest group prompt folder/);
        assert.equal(deleteGroupPrompt(dirs, 'quest', 'default', ''), true);
        assert.equal(deleteGroupPrompt(dirs, 'quest', 'default', ''), false, 'gone already');
        assert.equal(effectiveGroupDefault(readGroupPrompts(dirs)).text, 'G', 'the global default is used again');
    });
});
