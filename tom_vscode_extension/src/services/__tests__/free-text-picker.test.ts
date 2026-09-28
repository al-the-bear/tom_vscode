/**
 * `services/free-text-picker.ts` — the guarantee that every picker can be
 * answered in the user's own words.
 *
 * The "Other…" entry is only a guarantee if it is still there when the user
 * needs it. A QuickPick filters its list by what is typed, so an ordinary entry
 * disappears the moment the user types an answer that matches no option —
 * which is exactly the moment they need it. `alwaysShow` is what keeps it on
 * screen; the live prompter additionally accepts the typed text itself on
 * Enter (covered in `tools/__tests__/live-user-prompter.test.ts`).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withFreeTextOption, pickWithFreeTextOption, OTHER_OPTION_LABEL } from '../free-text-picker.js';
import type { UserPrompter, QuickPickResult } from '../../tools/user-interaction-tools.js';

describe('withFreeTextOption', () => {
    test('appends an "Other…" entry that survives the QuickPick filter', () => {
        const items = withFreeTextOption([{ label: 'Red', value: 'red' }]);
        const other = items[items.length - 1];
        assert.equal(other.label, OTHER_OPTION_LABEL);
        assert.equal(other.value, OTHER_OPTION_LABEL);
        // Typing an answer that matches no option must not hide the way to give it.
        assert.equal(other.alwaysShow, true);
        assert.ok(other.description && other.description.length > 0, 'a hint says what the entry is for');
    });

    test("leaves the caller's items untouched and in order", () => {
        const mine = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b', description: 'second' }];
        const items = withFreeTextOption(mine);
        assert.deepEqual(items.slice(0, 2), mine);
        assert.equal(items.length, 3);
    });

    test('keeps a caller-supplied "Other…" instead of adding a second — but still pins it', () => {
        const items = withFreeTextOption([
            { label: 'A', value: 'a' },
            { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL },
        ]);
        const others = items.filter((i) => i.label === OTHER_OPTION_LABEL);
        assert.equal(others.length, 1);
        assert.equal(others[0].alwaysShow, true);
    });
});

describe('pickWithFreeTextOption', () => {
    function prompter(pick: QuickPickResult, typed?: string): UserPrompter & { inputCalls: number } {
        const p: UserPrompter & { inputCalls: number } = {
            inputCalls: 0,
            async showQuickPick() { return pick; },
            async showInputBox() { p.inputCalls++; return typed; },
        };
        return p;
    }

    test('text the widget accepted directly (typed + Enter) is the answer — no input box', async () => {
        const p = prompter({ label: 'Chartreuse', value: 'Chartreuse' });
        const r = await pickWithFreeTextOption(p, [{ label: 'Red', value: 'red' }], {}, {});
        assert.deepEqual(r, { kind: 'picked', selections: [{ label: 'Chartreuse', value: 'Chartreuse' }] });
        assert.equal(p.inputCalls, 0);
    });

    test('taking "Other…" opens the input box and the trimmed text becomes the selection', async () => {
        const p = prompter({ label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL }, '  Teal ');
        const r = await pickWithFreeTextOption(p, [{ label: 'Red', value: 'red' }], {}, {});
        assert.deepEqual(r, { kind: 'picked', selections: [{ label: 'Teal', value: 'Teal' }] });
        assert.equal(p.inputCalls, 1);
    });
});
