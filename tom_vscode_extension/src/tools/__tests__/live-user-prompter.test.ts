/**
 * The live QuickPick prompter, driven through a fake `window`.
 *
 * What the model-facing pickers promise — "you can always answer in your own
 * words" — is only true if the widget cooperates: the "Other…" entry must stay
 * visible while the user types (`alwaysShow`), and the text they typed must be
 * accepted on Enter even though it matches no item. Neither is visible from a
 * stubbed `UserPrompter`, so this drives the real prompter against a
 * scriptable QuickPick.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    createLiveUserPrompter,
    QUICK_PICK_TIMED_OUT,
    type LiveWindow,
    type PickerItem,
} from '../user-interaction-tools.js';

/** Just enough of `vscode.QuickPick` for the prompter, plus a way to act as the user. */
class FakeQuickPick {
    items: readonly any[] = [];
    title?: string;
    placeholder?: string;
    canSelectMany = false;
    matchOnDescription = false;
    ignoreFocusOut = false;
    value = '';
    selectedItems: readonly any[] = [];
    shown = 0;
    disposed = 0;
    private acceptListener?: () => void;
    private hideListener?: () => void;
    onDidAccept = (listener: () => void) => { this.acceptListener = listener; return { dispose() { /* noop */ } }; };
    onDidHide = (listener: () => void) => { this.hideListener = listener; return { dispose() { /* noop */ } }; };
    show() { this.shown++; }
    hide() { this.hideListener?.(); }
    dispose() { this.disposed++; }
    /** The user types `typed`, has `selected` ticked/active, and presses Enter. */
    pressEnter(typed: string, selected: any[]) {
        this.value = typed;
        this.selectedItems = selected;
        this.acceptListener?.();
    }
}

function fakeWindow(): { win: LiveWindow; qp: () => FakeQuickPick } {
    let last: FakeQuickPick | undefined;
    const win: LiveWindow = {
        createQuickPick() { last = new FakeQuickPick(); return last as any; },
        async showInputBox() { return undefined; },
    };
    return { win, qp: () => last! };
}

const RED: PickerItem = { label: 'Red', value: 'red' };
const OTHER: PickerItem = { label: 'Other…', value: 'Other…', alwaysShow: true };

describe('live prompter — the free-text guarantee at the widget', () => {
    test('alwaysShow reaches the live items, so "Other…" survives the filter', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED, OTHER], {});
        assert.equal(qp().items[1].alwaysShow, true);
        assert.equal(qp().items[0].alwaysShow, undefined);
        qp().pressEnter('', [qp().items[0]]);
        assert.deepEqual(await pending, { label: 'Red', value: 'red' });
    });

    test('typing an answer that matches nothing and pressing Enter submits it', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED, OTHER], {});
        qp().pressEnter('  a colour nobody offered ', []);
        assert.deepEqual(await pending, { label: 'a colour nobody offered', value: 'a colour nobody offered' });
    });

    test('multi-select: typed text with nothing ticked is the one selection', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED, OTHER], { canPickMany: true });
        qp().pressEnter('Teal', []);
        assert.deepEqual(await pending, [{ label: 'Teal', value: 'Teal' }]);
    });

    test('multi-select: ticked items win over leftover filter text', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED, OTHER], { canPickMany: true });
        qp().pressEnter('re', [qp().items[0]]);
        assert.deepEqual(await pending, [{ label: 'Red', value: 'red' }]);
    });

    test('multi-select: Enter with nothing ticked and nothing typed confirms an empty selection', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED], { canPickMany: true });
        qp().pressEnter('   ', []);
        assert.deepEqual(await pending, []);
    });

    test('single-select: Enter with nothing chosen and nothing typed is a dismissal', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED], {});
        qp().pressEnter('', []);
        assert.equal(await pending, undefined);
    });

    test('closing the widget without accepting is a dismissal', async () => {
        const { win, qp } = fakeWindow();
        const pending = createLiveUserPrompter(win).showQuickPick([RED], {});
        qp().hide();
        assert.equal(await pending, undefined);
        assert.equal(qp().disposed, 1);
    });

    test('the deadline retracts the widget and reports a timeout, not a dismissal', async () => {
        const { win, qp } = fakeWindow();
        const result = await createLiveUserPrompter(win).showQuickPick([RED], { timeoutMs: 15 });
        assert.equal(result, QUICK_PICK_TIMED_OUT);
        assert.equal(qp().disposed, 1);
    });

    test('description and detail come back only when they were set', async () => {
        const { win, qp } = fakeWindow();
        const item: PickerItem = { label: 'Blue', value: 'blue', description: 'cool', detail: 'sky' };
        const pending = createLiveUserPrompter(win).showQuickPick([item], {});
        qp().pressEnter('', [qp().items[0]]);
        assert.deepEqual(await pending, item);
    });

    test('widget options are forwarded', () => {
        const { win, qp } = fakeWindow();
        void createLiveUserPrompter(win).showQuickPick([RED], {
            title: 'T', placeHolder: 'P', canPickMany: true, matchOnDescription: true, ignoreFocusOut: true,
        });
        assert.equal(qp().title, 'T');
        assert.equal(qp().placeholder, 'P');
        assert.equal(qp().canSelectMany, true);
        assert.equal(qp().matchOnDescription, true);
        assert.equal(qp().ignoreFocusOut, true);
        assert.equal(qp().shown, 1);
    });
});
