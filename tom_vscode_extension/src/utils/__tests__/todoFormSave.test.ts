/**
 * Saving the todo detail form (src/utils/todoFormSave.ts): the save is skipped only when nothing the
 * form sends differs from the todo on disk.
 *
 *   TFS-1 an untouched form is no change
 *   TFS-2 unticking (or ticking) "Your to do" alone is a change — it was skipped, so the mark could not be
 *         cleared; so is a changed Created date
 *   TFS-3 every other field the form sends counts too; absent and empty agree
 */

/* eslint-disable @typescript-eslint/naming-convention -- field names are the todo schema's YAML keys (snake_case) */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { todoFormUnchanged } from '../todoFormSave.js';

const CURRENT = {
    title: 'T', status: 'not-started', priority: 'high', description: 'D', tags: ['a'], dependencies: undefined,
    blocked_by: undefined, notes: undefined, scope: undefined, references: undefined, decisions: undefined,
    created: '2026-11-01', completed_date: undefined, completed_by: undefined, user_action: true,
};
const FORM = { ...CURRENT };

describe('todo form save', () => {
    test('TFS-1: untouched', () => {
        assert.equal(todoFormUnchanged(CURRENT, FORM), true);
    });

    test('TFS-2: Your to do and Created', () => {
        assert.equal(todoFormUnchanged(CURRENT, { ...FORM, user_action: false }), false, 'unticked');
        assert.equal(todoFormUnchanged({ ...CURRENT, user_action: undefined }, { ...FORM, user_action: true }), false, 'ticked');
        assert.equal(todoFormUnchanged({ ...CURRENT, user_action: undefined }, { ...FORM, user_action: false }), true, 'absent = false');
        assert.equal(todoFormUnchanged(CURRENT, { ...FORM, user_action: undefined }), true, 'a form without the box changes nothing');
        assert.equal(todoFormUnchanged(CURRENT, { ...FORM, created: '2026-11-02' }), false);
    });

    test('TFS-3: the other fields', () => {
        for (const [key, value] of Object.entries({
            title: 'U', status: 'completed', priority: 'low', description: 'E', tags: ['b'], dependencies: ['x'],
            blocked_by: ['y'], notes: 'n', scope: { area: 'a' }, references: [{ path: 'p' }],
            decisions: [{ summary: 's', decision_needed: 'd' }], completed_date: '2026-11-06', completed_by: 'me',
        })) {
            assert.equal(todoFormUnchanged(CURRENT, { ...FORM, [key]: value }), false, key);
        }
        assert.equal(todoFormUnchanged({ ...CURRENT, notes: '' }, { ...FORM, notes: undefined }), true, 'empty and absent agree');
    });
});
