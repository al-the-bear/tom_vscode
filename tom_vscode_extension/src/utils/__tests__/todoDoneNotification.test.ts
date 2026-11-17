/**
 * The todo done notification (vscimpb146): the template, the todo panel's box, who queued an item, the migration.
 *
 *   TN-1 the template: the configured one, else none — there is no default text; its placeholders are the ones
 *        `fillTodoPlaceholders` fills
 *   TN-2 the panel's box: off unless turned on; disabled (off) while no template is set; an older build's
 *        unset (then: on) and `false` both read off
 *   TN-3 queuedBy: read back from YAML (run default, session optional), written without unset parts, from a
 *        turn's item, from a tool call's filed_by; none for the `default` quest
 *   TN-4 the migration: a stored done notification marked `todo: true`, or carrying exactly the old default
 *        text (an older build's), is dropped with its prompt when read; any other done notification stays
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TODO_DONE_NOTIFICATION_PLACEHOLDERS, todoDoneNotificationTemplate } from '../todoDoneNotification';
import { todoPanelDoneNotificationOn } from '../todoPanelRunSession';
import { queuedByFrom, queuedByFromFiledBy, queuedByLine, queuedByOfItem, queuedByToYaml } from '../queuedBy';
import { doneNotificationMetaFromYaml, doneNotificationMetaToYaml } from '../doneNotification';
import { fillTodoPlaceholders } from '../todoOnDoneRun';

describe('the todo done notification', () => {
    test('TN-1: the template', () => {
        assert.equal(todoDoneNotificationTemplate(undefined), undefined);
        assert.equal(todoDoneNotificationTemplate({ todoPanel: { doneNotificationTemplate: '  ' } }), undefined, 'empty: none');
        assert.equal(todoDoneNotificationTemplate({ todoPanel: { doneNotificationTemplate: 'Mine ${todoId}' } }), 'Mine ${todoId}');
        const all = TODO_DONE_NOTIFICATION_PLACEHOLDERS.map(([p]) => p).join(' ');
        const filled = fillTodoPlaceholders(all, { id: 'n1', title: 't', sourceFile: 'f', last_answer: 'a', on_done: { action: ['notify'], report_to: 'r' } }, { quest: 'q', run: 'r1' });
        assert.doesNotMatch(filled, /\$\{/, 'every listed placeholder is filled');
    });

    test('TN-2: the panel box', () => {
        assert.equal(todoPanelDoneNotificationOn(undefined), false, 'unset: off');
        assert.equal(todoPanelDoneNotificationOn(false), false);
        assert.equal(todoPanelDoneNotificationOn(true), true);
        assert.equal(todoPanelDoneNotificationOn(true, false), false, 'no template: disabled');
    });

    test('TN-3: queuedBy', () => {
        assert.deepEqual(queuedByFrom({ quest: 'q', run: 'chg1', session: 'work' }), { quest: 'q', run: 'chg1', session: 'work' });
        assert.deepEqual(queuedByFrom({ quest: 'q' }), { quest: 'q', run: 'default' });
        assert.equal(queuedByFrom({ run: 'x' }), undefined);
        assert.equal(queuedByFrom('q'), undefined);
        assert.deepEqual(queuedByToYaml({ quest: 'q', run: 'default' }), { quest: 'q', run: 'default' });
        assert.deepEqual(queuedByOfItem({ run: 'r1', session: 'chat' }, 'q'), { quest: 'q', run: 'r1', session: 'chat' });
        assert.deepEqual(queuedByOfItem({ run: 'r1', processRun: { run: 'r2' } }, 'q'), { quest: 'q', run: 'r2' });
        assert.equal(queuedByOfItem({ run: 'r1' }, 'default'), undefined);
        assert.deepEqual(queuedByFromFiledBy({ quest: 'q', run: 'r', session: 's' }), { quest: 'q', run: 'r', session: 's' });
        assert.equal(queuedByFromFiledBy({ run: 'r' }), undefined);
        assert.equal(queuedByLine({ quest: 'q', run: 'r' }), 'q / r / queue default');
    });

    test('TN-4: the migration', () => {
        const legacy = doneNotificationMetaFromYaml({ 'done-notification': { prompt: 'Todo ${todoId} (${todoTitle}) is ${itemOutcome}.', todo: true, quest: 'r' } });
        assert.equal(legacy.doneNotificationPrompt, undefined, 'the old default prompt is gone');
        assert.equal(legacy.doneNotificationQuest, undefined);
        assert.deepEqual(doneNotificationMetaToYaml(legacy), {}, 'written back without it');
        const oldText = 'Todo ${todoId} (${todoTitle}) is ${itemOutcome}. Its follow-up: ${todoOnDone}. Do what it says; if it says nothing, '
            + 'there is nothing to do. If it is not done, report that and do not carry out the follow-up.';
        assert.equal(doneNotificationMetaFromYaml({ 'done-notification': { prompt: oldText } }).doneNotificationPrompt, undefined,
            'exactly the old default text, without the flag: dropped too');
        assert.equal(doneNotificationMetaFromYaml({ 'done-notification': { prompt: `${oldText} Also X.` } }).doneNotificationPrompt, `${oldText} Also X.`,
            'an edited text is the user\'s: kept');
        const plain = doneNotificationMetaFromYaml({ 'done-notification': { prompt: 'tell me', run: 'r2' } });
        assert.deepEqual([plain.doneNotificationPrompt, plain.doneNotificationRun], ['tell me', 'r2']);
    });
});
