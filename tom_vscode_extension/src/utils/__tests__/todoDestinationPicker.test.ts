/**
 * The todo panels' "Move to…" picker: wording and the destinations offered.
 *
 *   DP-1  the title follows the stack wording: one todo, or N stacked todos
 *   DP-2  a session or topic-file todo of a quest: its quest, another group of it, the workspace, another quest
 *   DP-3  a todo already in its quest's own file: another group of its quest, the workspace, another quest
 *   DP-4  a workspace todo: another quest only
 *   DP-5  todos of several quests: the workspace and another quest, no single "quest todos"
 *   DP-6  a workspace-relative path tells its quest and file
 *   DP-7  the prefix of an id is the panel's group key: everything before its number, a leading number included
 *         (`001_cleanup1` → `001_cleanup`)
 *   DP-8  the prefix choices for a target quest: its groups (alphabetically) with their next free number,
 *         then a prefix of your own, then "keep the ids"; a quest without groups offers those two
 *   DP-9  renaming: the moved todos get the chosen prefix and consecutive numbers after the group's
 *         highest, each keeping the tail after its number; an id without a number keeps itself as tail;
 *         a number the target already has is skipped; "keep" renames nothing
 *   DP-10 the id choice is asked only when a moved todo enters a quest it is not in
 *   DP-11 a prefix of your own: not empty, no digit after a leading number (the todo's number follows it), no
 *         whitespace or path characters; the ids it gives, as a preview
 *   DP-12 finalizers: `<prefix>999` and higher do not count for the next number — the moved todos are numbered
 *         after the highest below 999 (choices and renames); a rename into the finalizer range is detected
 *   DP-13 where a todo added to a group goes in a file: after the group's last todo below 999 (so before its
 *         finalizer), else before the first finalizer, else at the end
 *   DP-14 a new todo id: one word, not empty, no path characters, no id the quest already has (its own id is fine)
 *   DP-15 the groups offered are the non-empty groups of the live todos only (not those only archived or deleted
 *         todos hold), alphabetically; the next number still counts every id of the quest, archived and deleted
 *         ones included, so no id is taken twice; "Enter a prefix…" stays for a group typed by hand
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupInsertIndex, renamesReachFinalizer, todoIdInputError, todoIdPrefix, todoMoveOptions, todoMovePickerTitle, todoOriginOfRelativePath, todoMoveNeedsIdChoice, todoPrefixChoices, todoPrefixPreview, todoRenames, validateTodoPrefix } from '../todoDestinationPicker.js';

const kinds = (origins: Parameters<typeof todoMoveOptions>[0]): string[] =>
    todoMoveOptions(origins).map((o) => (o.choice.kind === 'quest' ? `quest:${o.choice.questId}` : o.choice.kind));

describe('todo destination picker', () => {
    test('DP-1: wording', () => {
        assert.equal(todoMovePickerTitle(1), 'Move this todo to…');
        assert.equal(todoMovePickerTitle(3), 'Move 3 stacked todos to…');
    });

    test('DP-2: a session todo of a quest', () => {
        assert.deepEqual(kinds([{ questId: 'q', inQuestMainFile: false, inWorkspaceFile: false }]), ['quest:q', 'pickGroup', 'workspace', 'pickQuest']);
        const group = todoMoveOptions([{ questId: 'q', inQuestMainFile: false, inWorkspaceFile: false }])[1];
        assert.match(group.label, /Move to another group…/);
        assert.deepEqual(group.choice, { kind: 'pickGroup', questId: 'q' });
    });

    test('DP-3: already in the quest file', () => {
        assert.deepEqual(kinds([{ questId: 'q', inQuestMainFile: true, inWorkspaceFile: false }]), ['pickGroup', 'workspace', 'pickQuest']);
        assert.deepEqual(kinds([
            { questId: 'q', inQuestMainFile: true, inWorkspaceFile: false },
            { questId: 'q', inQuestMainFile: false, inWorkspaceFile: false },
        ]), ['quest:q', 'pickGroup', 'workspace', 'pickQuest'], 'one of them is not there yet');
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
        assert.equal(todoIdPrefix('001_cleanup2_akkj-x'), '001_cleanup');
        assert.equal(todoIdPrefix('001_cleanup'), '');
        assert.equal(todoIdPrefix('42'), '');
    });

    test('DP-8: the prefix choices of a target quest', () => {
        const target = ['annot1_ajsq-a', 'annot7_ajtl-b', 'uamtc9_ajmv-c', 'annot4_ajtf-d', 'loose'];
        const options = todoPrefixChoices(target);
        assert.deepEqual(options.map((o) => [o.kind, o.prefix, o.next, o.count]), [
            ['group', 'annot', 8, 3], ['group', 'uamtc', 10, 1], ['custom', null, null, 0], ['keep', null, null, 0]]);
        assert.equal(options[2].label, 'Enter a prefix…');
        assert.equal(options[3].label, 'Keep the ids as they are');
        assert.deepEqual(todoPrefixChoices(['loose', 'other']).map((o) => o.kind), ['custom', 'keep'], 'no groups: your own prefix or keep');
        assert.deepEqual(todoPrefixChoices([]).map((o) => o.kind), ['custom', 'keep']);
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

    test('DP-11: a prefix of your own', () => {
        assert.equal(validateTodoPrefix('qrm'), undefined);
        assert.equal(validateTodoPrefix('vsc_move-'), undefined, 'underscores and dashes are fine');
        assert.match(validateTodoPrefix('') ?? '', /Enter/);
        assert.match(validateTodoPrefix('   ') ?? '', /Enter/);
        assert.match(validateTodoPrefix('q2r') ?? '', /digit/);
        assert.equal(validateTodoPrefix('001_cleanup'), undefined, 'a leading number names the group');
        assert.match(validateTodoPrefix('001') ?? '', /digit/, 'digits only');
        assert.match(validateTodoPrefix('001_c2') ?? '', /digit/);
        assert.match(validateTodoPrefix('q r') ?? '', /space/);
        assert.match(validateTodoPrefix('q/r') ?? '', /character/);
        assert.equal(todoPrefixPreview(['vscannot3_ajtf-tools', 'qrd2'], ['qrm4_x'], 'qrm'), 'vscannot3_ajtf-tools → qrm5_ajtf-tools, qrd2 → qrm6');
        assert.equal(todoPrefixPreview(['a1', 'b2', 'c3', 'd4', 'e5'], [], 'z'), 'a1 → z1, b2 → z2, c3 → z3, … (5 todos)', 'three, then the count');
    });

    test('DP-12: finalizers', () => {
        const target = ['qr1_a-x', 'qr2_b-y', 'qr999_c-final', 'qr1000_d-after'];
        assert.deepEqual([...todoRenames(['chat9_e-move', 'z7_f-other'], target, 'qr')], [['chat9_e-move', 'qr3_e-move'], ['z7_f-other', 'qr4_f-other']], 'after 2, not after 1000');
        const choice = todoPrefixChoices(target).find((o) => o.prefix === 'qr')!;
        assert.equal(choice.next, 3);
        assert.match(choice.description, /qr3, qr4/);
        assert.equal(renamesReachFinalizer(todoRenames(['m1'], target, 'qr'), 'qr'), false);
        const full = Array.from({ length: 998 }, (_, k) => `qr${k + 1}`);
        assert.equal(renamesReachFinalizer(todoRenames(['m1'], full, 'qr'), 'qr'), true, 'no free number below 999');
    });

    test('DP-13: the place in a file', () => {
        assert.equal(groupInsertIndex(['qr1', 'qr2', 'qr999', 'other1'], 'qr'), 2, 'after qr2, before the finalizer');
        assert.equal(groupInsertIndex(['qr1', 'other1', 'qr2', 'other2'], 'qr'), 3, 'after the last of the group');
        assert.equal(groupInsertIndex(['other1', 'qr999', 'qr1000'], 'qr'), 1, 'only finalizers: before them');
        assert.equal(groupInsertIndex(['other1', 'other2'], 'qr'), 2, 'a new group: at the end');
        assert.equal(groupInsertIndex(['qra1', 'qr5'], 'qr'), 2, 'qra is another group');
    });

    test('DP-14: a new todo id', () => {
        const taken = new Set(['a1', 'b2']);
        assert.equal(todoIdInputError('c3_x-new', 'a1', taken), undefined);
        assert.equal(todoIdInputError(' a1 ', 'a1', taken), undefined, 'its own id');
        assert.match(String(todoIdInputError('b2', 'a1', taken)), /already has a todo b2/);
        assert.match(String(todoIdInputError('', 'a1', taken)), /Enter/);
        assert.match(String(todoIdInputError('two words', 'a1', taken)), /one word/);
        assert.match(String(todoIdInputError('a/b', 'a1', taken)), /no \//);
    });

    test('DP-15: only the live groups, alphabetically', () => {
        const all = ['zeta1_a', 'beta3_b', 'beta12_c', 'old5_d', 'gone2_e', 'alpha1_f', 'alpha2_g', 'alpha3_h'];
        const live = ['zeta1_a', 'beta3_b', 'alpha1_f', 'alpha2_g', 'alpha3_h'];
        const options = todoPrefixChoices(all, live);
        assert.deepEqual(options.filter((o) => o.kind === 'group').map((o) => [o.prefix, o.count, o.next]), [
            ['alpha', 3, 4], ['beta', 1, 13], ['zeta', 1, 2]], 'live groups only, alphabetically; beta numbered after the archived beta12');
        assert.deepEqual(options.slice(-2).map((o) => o.kind), ['custom', 'keep'], 'typing a group by hand stays');
        assert.deepEqual(todoPrefixChoices(['old5_d'], []).map((o) => o.kind), ['custom', 'keep'], 'a quest whose groups are all archived offers none');
    });
});
