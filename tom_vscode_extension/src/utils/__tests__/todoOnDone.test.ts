/**
 * A todo's follow-up and origin (utils/todoOnDone.ts; ww_a_collab-3).
 *
 *   OD-1 the shape of `on_done`: closed keys, string fields, `todos` a list of ids, `action` a list of the two
 *        actions (unblock, notify); the retired `queue` and `none` are refused with what exists; `unblock` needs
 *        `todos`; absent / null pass
 *   OD-2 unblock targets must exist, each in its own quest (`<quest>/<id>`, a bare id in the todo's quest); without
 *        unblock the targets are not checked
 *   OD-3 targets: `<quest>/<id>` read and written back, a bare id in the own quest, repeats dropped; the instructions
 *        go to `quest` / `run`, unset: the own quest and the run the todo was completed in (another quest: `default`)
 *   OD-4 filed_by: the window quest, the session without its `@<run>`, the run from it (else the call's run, else
 *        `default`), the walk's claimed todo of that quest, the time with its offset; on another quest's request
 *        the sender's quest and run with the creating session (DP-part-todo-followups-3)
 *   OD-5 normalising: empty parts dropped, ids trimmed and deduplicated, nothing left → undefined
 */

/* eslint-disable @typescript-eslint/naming-convention -- the todo schema's YAML keys */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFiledBy, filedByShapeError, normaliseOnDone, onDoneInstructionTarget, onDoneShapeError, onDoneTargetEntry,
    onDoneTargetRef, onDoneTargetRefusal, onDoneTargets,
} from '../todoOnDone';

describe('todoOnDone', () => {
    test('OD-1: the shape of on_done', () => {
        assert.equal(onDoneShapeError(undefined), undefined);
        assert.equal(onDoneShapeError(null), undefined);
        assert.equal(onDoneShapeError({ todos: ['a'], action: ['unblock', 'notify'], report_to: 'x.md#t' }), undefined);
        assert.equal(onDoneShapeError({ action: ['notify'], notify_prompt: 'done' }), undefined, 'notify needs no todos');
        assert.match(onDoneShapeError('x') ?? '', /must be an object/);
        assert.match(onDoneShapeError({ when: 'later' }) ?? '', /unknown key "when"/);
        assert.match(onDoneShapeError({ action: 'unblock', todos: ['a'] }) ?? '', /must be a list/);
        assert.match(onDoneShapeError({ action: ['wake'], todos: ['a'] }) ?? '', /"wake"/);
        assert.match(onDoneShapeError({ action: ['unblock'] }) ?? '', /"unblock" needs `on_done.todos`/);
        assert.match(onDoneShapeError({ action: ['queue'], todos: ['a'] }) ?? '', /"queue" no longer exists; the actions are unblock, notify/);
        assert.match(onDoneShapeError({ action: ['none'] }) ?? '', /"none" no longer exists/);
        assert.equal(onDoneShapeError({ todos: ['other/b'], action: ['unblock'] }), undefined, 'a target of another quest');
        assert.match(onDoneShapeError({ todos: [3] }) ?? '', /list of todo ids/);
        assert.match(onDoneShapeError({ quest: 3 }) ?? '', /on_done.quest` must be a string/);
        assert.equal(filedByShapeError({ quest: 'q', at: '2026-11-15T05:00+01:00' }), undefined);
        assert.match(filedByShapeError({ host: 'mbp' }) ?? '', /unknown key/);
    });

    test('OD-2: unblock targets must exist, each in its quest', () => {
        const have = new Set(['own/a', 'other/b']);
        const exists = (q: string, id: string): boolean => have.has(`${q}/${id}`);
        assert.equal(onDoneTargetRefusal({ todos: ['a', 'other/b'], action: ['unblock'] }, 'own', exists), undefined);
        assert.match(onDoneTargetRefusal({ todos: ['a', 'zz'], action: ['unblock'] }, 'own', exists) ?? '', /names "zz", which is in no todo file/);
        assert.match(onDoneTargetRefusal({ todos: ['other/a'], action: ['unblock'] }, 'own', exists) ?? '', /"other\/a"/);
        assert.equal(onDoneTargetRefusal({ todos: ['zz'], action: ['notify'] }, 'own', exists), undefined, 'without unblock not checked');
        assert.equal(onDoneTargetRefusal(undefined, 'own', exists), undefined);
    });

    test('OD-3: targets with their quests; where the instructions go', () => {
        assert.deepEqual(onDoneTargetRef('a', 'q'), { quest: 'q', id: 'a' });
        assert.deepEqual(onDoneTargetRef(' r/b ', 'q'), { quest: 'r', id: 'b' });
        assert.equal(onDoneTargetEntry({ quest: 'q', id: 'a' }, 'q'), 'a');
        assert.equal(onDoneTargetEntry({ quest: 'r', id: 'b' }, 'q'), 'r/b');
        assert.deepEqual(onDoneTargets({ todos: ['a', 'q/a', 'r/b', 'r/b'] }, 'q'), [{ quest: 'q', id: 'a' }, { quest: 'r', id: 'b' }]);
        assert.deepEqual(onDoneInstructionTarget(undefined, 'q', 'chg1'), { quest: 'q', run: 'chg1' }, 'unset: the own quest and the completing run');
        assert.deepEqual(onDoneInstructionTarget({ run: 'r2' }, 'q', 'chg1'), { quest: 'q', run: 'r2' });
        assert.deepEqual(onDoneInstructionTarget({ quest: 'other' }, 'q', 'chg1'), { quest: 'other', run: 'default' }, 'another quest: its default run');
        assert.deepEqual(onDoneInstructionTarget({ quest: 'other', run: 'x' }, 'q', 'chg1'), { quest: 'other', run: 'x' });
    });

    test('OD-4: filed_by from the call context', () => {
        const now = new Date(2026, 10, 15, 6, 7);
        const at = buildFiledBy({}, now).at ?? '';
        assert.match(at, /^2026-11-15T06:07[+-]\d{2}:\d{2}$/);
        assert.deepEqual(buildFiledBy({ windowQuest: 'q', session: 'idea@collab', claim: { quest: 'q', id: 'w1' } }, now),
            { quest: 'q', run: 'collab', session: 'idea', todo: 'w1', at });
        assert.deepEqual(buildFiledBy({ windowQuest: 'q', session: 'chat', run: 'r2' }, now), { quest: 'q', run: 'r2', session: 'chat', at });
        assert.deepEqual(buildFiledBy({ windowQuest: 'q' }, now), { quest: 'q', run: 'default', at }, 'no session (Copilot, MCP)');
        assert.deepEqual(
            buildFiledBy({ windowQuest: 'q', session: 'default', claim: { quest: 'q', id: 'w1' }, sender: { quest: 'other', run: 'chg7' } }, now),
            { quest: 'other', run: 'chg7', session: 'default', at },
            'on request: the requester, with the creating session; the claim is no todo of the requester',
        );
        assert.equal(buildFiledBy({ windowQuest: 'q', sender: { quest: 'other' } }, now).run, 'default');
    });

    test('OD-5: normalising', () => {
        assert.equal(normaliseOnDone(undefined), undefined);
        assert.equal(normaliseOnDone({ todos: [' '], instructions: '  ' }), undefined);
        assert.deepEqual(normaliseOnDone({ quest: ' r ', todos: [' a', 'a', 'b'], action: ['unblock', 'unblock'], report_to: ' x ' }),
            { quest: 'r', todos: ['a', 'b'], action: ['unblock'], report_to: 'x' });
        assert.deepEqual(normaliseOnDone({ action: ['none', 'queue', 'notify'] as never, instructions: 'go' }), { action: ['notify'], instructions: 'go' },
            'the retired actions are read as nothing');
    });
});
