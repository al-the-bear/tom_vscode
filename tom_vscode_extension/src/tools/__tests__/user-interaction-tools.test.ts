/**
 * Tool-impl tests for `user-interaction-tools.ts` — the picker tool
 * (`tomAi_askUserPicker`, quickpick selection via showQuickPick).
 *
 * (The blocking, multi-question `tomAi_askUser` moved to
 * `ask-user-tool.ts` + `askUser-handler.ts` and is covered by its own
 * test files; this file now covers only the picker.)
 *
 * Strategy: a stubbed `UserPrompter` that mirrors the documented
 * `vscode.window.showQuickPick` contract, plus a programmable return
 * value per call.  Each test swaps the return value (item / [] /
 * undefined) and observes how the impl folds it into the envelope.
 *
 * Ambiguities covered explicitly:
 *   - canPickMany empty selection (`[]`) vs cancellation (`undefined`) —
 *     both used to look the same to the caller; now distinguishable via
 *     `{dismissed, selected}`.
 *   - PickerItemInput.value fallback to label when omitted.
 *   - matchOnDescription default = true (forwarded to options).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// `user-interaction-tools.ts` imports `vscode` at module top to build the
// live executor.  The impl itself is vscode-free (it takes a
// `UserPrompter` dep) but the import would still trip up node:test.
// Install the shared stub before importing the module — see
// `_vscode-stub.ts` for the contract.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    askUserPickerImpl,
    type UserPrompter,
    type PickerItem,
    type QuickPickOpts,
    type AskUserPickerInput,
} from '../user-interaction-tools.js';

// ===========================================================================
// Stubbed prompter
// ===========================================================================

interface StubPickerCall { items: PickerItem[]; opts: QuickPickOpts }

interface StubPrompter extends UserPrompter {
    pickerCalls: StubPickerCall[];
    /** What `showQuickPick` returns next. */
    nextPick: PickerItem | PickerItem[] | undefined;
    throwOnPick?: Error;
}

function makePrompter(): StubPrompter {
    const p: StubPrompter = {
        pickerCalls: [],
        nextPick: undefined,
        async showQuickPick(items, opts) {
            p.pickerCalls.push({ items, opts });
            if (p.throwOnPick) { throw p.throwOnPick; }
            return p.nextPick;
        },
        // Not exercised by the picker tests, but required by the
        // `UserPrompter` contract (the Agent-SDK question interceptor uses it).
        async showInputBox() { return undefined; },
    };
    return p;
}

// ===========================================================================
// `tomAi_askUserPicker`
// ===========================================================================

describe('askUserPickerImpl', () => {

    test('typical: single-select returns one {label, value}', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'beta', value: 'beta' };
        const raw = await withTiming('tomAi_askUserPicker:typical', () =>
            askUserPickerImpl(p, { items: ['alpha', 'beta', 'gamma'] }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.dismissed, false);
        assert.equal(r.multiSelect, false);
        assert.deepEqual(r.selected, { label: 'beta', value: 'beta' });
    });

    test('object items: value falls back to label when omitted', async () => {
        const p = makePrompter();
        // Inspect what items the prompter receives.
        p.nextPick = undefined;
        await askUserPickerImpl(p, {
            items: [
                { label: 'A', description: 'first' },          // no value → falls back to label
                { label: 'B', value: 'b-val' },                  // explicit value
            ],
        });
        assert.deepEqual(
            p.pickerCalls[0].items.map((i) => ({ label: i.label, value: i.value })),
            [{ label: 'A', value: 'A' }, { label: 'B', value: 'b-val' }],
        );
    });

    test('cancellation → dismissed: true, selected: null', async () => {
        const p = makePrompter();
        p.nextPick = undefined;
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }));
        assert.equal(r.dismissed, true);
        assert.equal(r.selected, null);
        assert.equal(r.multiSelect, false);
    });

    test('multi-select with picks → selected is an array of {label, value}', async () => {
        const p = makePrompter();
        p.nextPick = [
            { label: 'A', value: 'A' },
            { label: 'C', value: 'c-val' },
        ];
        const r = JSON.parse(await askUserPickerImpl(p, {
            items: [
                { label: 'A' },
                { label: 'B' },
                { label: 'C', value: 'c-val' },
            ],
            canPickMany: true,
        }));
        assert.equal(r.multiSelect, true);
        assert.deepEqual(r.selected, [
            { label: 'A', value: 'A' },
            { label: 'C', value: 'c-val' },
        ]);
    });

    test('multi-select with EMPTY array (user pressed OK without picking) is DISTINCT from cancel', async () => {
        const p = makePrompter();
        p.nextPick = [];
        const r = JSON.parse(await askUserPickerImpl(p, {
            items: ['a', 'b'],
            canPickMany: true,
        }));
        assert.equal(r.dismissed, false, 'empty selection is not dismissal');
        assert.equal(r.multiSelect, true);
        assert.deepEqual(r.selected, []);
    });

    test('multi-select cancellation → dismissed: true, selected: null', async () => {
        const p = makePrompter();
        p.nextPick = undefined;
        const r = JSON.parse(await askUserPickerImpl(p, {
            items: ['a'], canPickMany: true,
        }));
        assert.equal(r.dismissed, true);
        assert.equal(r.multiSelect, true);
        assert.equal(r.selected, null);
    });

    test('options forwarded: matchOnDescription default true, ignoreFocusOut true', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'], prompt: 'pick', title: 'T' });
        const opts = p.pickerCalls[0].opts;
        assert.equal(opts.placeHolder, 'pick');
        assert.equal(opts.title, 'T');
        assert.equal(opts.matchOnDescription, true, 'default true');
        assert.equal(opts.ignoreFocusOut, true);
        assert.equal(opts.canPickMany, false);
    });

    test('matchOnDescription: false is respected', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'], matchOnDescription: false });
        assert.equal(p.pickerCalls[0].opts.matchOnDescription, false);
    });

    test('empty items array rejected → ok: false, prompter NOT invoked', async () => {
        const p = makePrompter();
        const r = JSON.parse(await askUserPickerImpl(p, { items: [] }));
        assert.equal(r.ok, false);
        assert.match(r.error, /non-empty array/);
        assert.equal(p.pickerCalls.length, 0);
    });

    test('non-array items → ok: false', async () => {
        const p = makePrompter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await askUserPickerImpl(p, { items: null as any } as AskUserPickerInput));
        assert.equal(r.ok, false);
    });

    test('prompter throws → ok: false with reason', async () => {
        const p = makePrompter();
        p.throwOnPick = new Error('quickpick crash');
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }));
        assert.equal(r.ok, false);
        assert.match(r.error, /askUserPicker failed: quickpick crash/);
    });

    test('defensive: single-select returning [] → dismissed (out-of-contract from prompter)', async () => {
        // VS Code's API shouldn't return [] when canPickMany is false, but
        // if some fake does, the impl treats it as a dismissal rather than
        // crashing on an undefined .label.
        const p = makePrompter();
        p.nextPick = [];
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }));
        assert.equal(r.dismissed, true);
        assert.equal(r.selected, null);
    });
});
