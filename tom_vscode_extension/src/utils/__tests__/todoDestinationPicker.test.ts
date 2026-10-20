/**
 * The todo panels' "Move to…" picker: wording and the destinations offered.
 *
 *   DP-1  the title follows the stack wording: one todo, or N stacked todos
 *   DP-2  a session or topic-file todo of a quest: its quest, the workspace, another quest
 *   DP-3  a todo already in its quest's own file: the workspace, another quest
 *   DP-4  a workspace todo: another quest only
 *   DP-5  todos of several quests: the workspace and another quest, no single "quest todos"
 *   DP-6  a workspace-relative path tells its quest and file
 *   DP-7  the prefix of an id is the panel's group key: everything before the first digit
 *   DP-8  the prefix choices for a target quest: its groups (largest first) with their next free number,
 *         then "keep the ids"; a quest without groups offers only "keep", to be confirmed
 *   DP-9  renaming: the moved todos get the chosen prefix and consecutive numbers after the group's
 *         highest, each keeping the tail after its number; an id without a number keeps itself as tail;
 *         a number the target already has is skipped; "keep" renames nothing
 *   DP-10 the id choice is asked only when a moved todo enters a quest it is not in
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { todoIdPrefix, todoMoveOptions, todoMovePickerTitle, todoOriginOfRelativePath, todoMoveNeedsIdChoice, todoPrefixChoices, todoRenames } from '../todoDestinationPicker.js';

const kinds = (origins: Parameters<typeof todoMoveOptions>[0]): string[] =>
    todoMoveOptions(origins).map((o) => (o.choice.kind === 'quest' ? `quest:${o.choice.questId}` : o.choice.kind));

describe('todo destination picker', () => {
    test('DP-1: wording', () => {
        assert.equal(todoMovePickerTitle(1), 'Move this todo to…');
        assert.equal(todoMovePickerTitle(3), 'Move 3 stacked todos to…');
    });

    test('DP-2: a session todo of a quest', () => {
        assert.deepEqual(kinds([{ questId: 'q', inQuestMainFile: false, inWorkspaceFile: false }]), ['quest:q', 'workspace', 'pickQuest']);
    });

    test('DP-3: already in the quest file', () => {
        assert.deepEqual(kinds([{ questId: 'q', inQuestMainFile: true, inWorkspaceFile: false }]), ['workspace', 'pickQuest']);
        assert.deepEqual(kinds([
            { questId: 'q', inQuestMainFile: true, inWorkspaceFile: false },
            { questId: 'q', inQuestMainFile: false, inWorkspaceFile: false },
        ]), ['quest:q', 'workspace', 'pickQuest'], 'one of them is not there yet');
    });

    test('DP-4: a workspace todo', () => {
        assert.deepEqual(kinds([{ inQuestMainFile: false, inWorkspaceFile: true }]), ['pickQuest']);
    });

    test('DP-5: todos of several quests', () => {
        assert.deepEqual(kinds([
            { questId: 'a', inQuestMainFile: false, inWorkspaceFile: false },
            { questId: 'b', inQuestMainFile: false, inWorkspaceFile: false },
        ]), ['workspace', 'pickQuest']);
        const quest = todoMoveOptions([{ questId: 'q', inQuestMainFile: false, inWorkspaceFile: false }])[0];
        assert.equal(quest.description, 'todos.q.todo.yaml');
    });

    test('DP-6: relative paths', () => {
        assert.deepEqual(todoOriginOfRelativePath('_ai/quests/q/todos.q.todo.yaml'), { questId: 'q', inQuestMainFile: true, inWorkspaceFile: false });
        assert.deepEqual(todoOriginOfRelativePath('_ai/quests/q/session-todo.mbp.q.todo.yaml'), { questId: 'q', inQuestMainFile: false, inWorkspaceFile: false });
        assert.deepEqual(todoOriginOfRelativePath('workspace.todo.yaml'), { inQuestMainFile: false, inWorkspaceFile: true });
        assert.deepEqual(todoOriginOfRelativePath('tom_ai/x/notes.todo.yaml'), { inQuestMainFile: false, inWorkspaceFile: false });
    });

    test('DP-7: the prefix of an id', () => {
        assert.equal(todoIdPrefix('vscimpa11_ajtf-md-browser'), 'vscimpa');
        assert.equal(todoIdPrefix('qr-4'), 'qr-');
        assert.equal(todoIdPrefix('nonumber'), '');
        assert.equal(todoIdPrefix('7up'), '');
    });

    test('DP-8: the prefix choices of a target quest', () => {
        const target = ['annot1_ajsq-a', 'annot7_ajtl-b', 'uamtc9_ajmv-c', 'annot4_ajtf-d', 'loose'];
        const choices = todoPrefixChoices(target);
        assert.deepEqual(choices.options.map((o) => [o.prefix, o.next, o.count]), [['annot', 8, 3], ['uamtc', 10, 1], [null, null, 0]]);
        assert.equal(choices.options[2].label, 'Keep the ids as they are');
        assert.equal(choices.confirmKeep, false);
        const empty = todoPrefixChoices(['loose', 'other']);
        assert.deepEqual(empty.options.map((o) => o.prefix), [null], 'no groups: only keep');
        assert.equal(empty.confirmKeep, true, 'and it is to be confirmed');
        assert.equal(todoPrefixChoices([]).confirmKeep, true);
    });

    test('DP-9: renaming', () => {
        const target = ['annot1_ajsq-a', 'annot7_ajtl-b', 'annot9_ajtl-c'];
        const renames = todoRenames(['vscannot3_ajtf-tools', 'vscannot4_ajtl-browser', 'qrd2', 'plain'], target, 'annot');
        assert.deepEqual([...renames], [
            ['vscannot3_ajtf-tools', 'annot10_ajtf-tools'],
            ['vscannot4_ajtl-browser', 'annot11_ajtl-browser'],
            ['qrd2', 'annot12'],
            ['plain', 'annot13-plain'],
        ]);
        assert.deepEqual([...todoRenames(['x1_a'], ['annot2_q', 'annot3_q'], 'annot')], [['x1_a', 'annot4_a']]);
        assert.deepEqual([...todoRenames(['x1_a'], [], 'qrf')], [['x1_a', 'qrf1_a']], 'a new prefix starts at 1');
        assert.equal(todoRenames(['x1_a'], target, null).size, 0, 'keep: nothing renamed');
    });

    test('DP-10: the id choice is asked only when a todo enters another quest', () => {
        const fromA = todoOriginOfRelativePath('_ai/quests/qa/todos.qa.todo.yaml');
        const fromWs = todoOriginOfRelativePath('workspace.todo.yaml');
        assert.equal(todoMoveNeedsIdChoice([fromA], { kind: 'quest', questId: 'qb' }), true);
        assert.equal(todoMoveNeedsIdChoice([fromWs], { kind: 'quest', questId: 'qb' }), true, 'from the workspace into a quest');
        assert.equal(todoMoveNeedsIdChoice([fromA], { kind: 'quest', questId: 'qa' }), false, 'within its quest');
        assert.equal(todoMoveNeedsIdChoice([fromA, fromWs], { kind: 'quest', questId: 'qa' }), true, 'one of the group enters');
        assert.equal(todoMoveNeedsIdChoice([fromA], { kind: 'workspace' }), false, 'the workspace file has no groups to join');
    });
});
