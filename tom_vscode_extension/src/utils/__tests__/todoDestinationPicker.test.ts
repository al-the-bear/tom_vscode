/**
 * The todo panels' "Move to…" picker: wording and the destinations offered.
 *
 *   DP-1  the title follows the stack wording: one todo, or N stacked todos
 *   DP-2  a session or topic-file todo of a quest: its quest, the workspace, another quest
 *   DP-3  a todo already in its quest's own file: the workspace, another quest
 *   DP-4  a workspace todo: another quest only
 *   DP-5  todos of several quests: the workspace and another quest, no single "quest todos"
 *   DP-6  a workspace-relative path tells its quest and file
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { todoMoveOptions, todoMovePickerTitle, todoOriginOfRelativePath } from '../todoDestinationPicker.js';

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
});
