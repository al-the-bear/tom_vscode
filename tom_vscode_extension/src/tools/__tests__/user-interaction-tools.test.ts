/**
 * Tool-impl tests for `user-interaction-tools.ts` — the 2 blocking
 * user-input tools (coverage entry #24):
 *
 *   - tomAi_askUser        — free-form input (showInputBox)
 *   - tomAi_askUserPicker  — quickpick selection (showQuickPick)
 *
 * Strategy: a stubbed `UserPrompter` that mirrors the documented
 * `vscode.window.{showInputBox, showQuickPick}` contract, plus
 * programmable return values per call.  The dep is a single
 * interface so each test can swap the return value (text / "" /
 * undefined) and observe how the impl folds it into the envelope.
 *
 * Coverage entry #24 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file; blocking
 *      semantics, no-timeout, ignoreFocusOut: true behaviour, escape-
 *      vs-empty distinction, and the multi-select shape change are all
 *      spelled out.
 *   b) Ambiguities covered explicitly:
 *        - escape (`undefined`) vs empty submission (`""`) — the new
 *          envelope distinguishes `{dismissed: true}` from
 *          `{dismissed: false, emptyInput: true, value: ""}`
 *        - canPickMany empty selection (`[]`) vs cancellation
 *          (`undefined`) — both used to look the same to the caller;
 *          now distinguishable via `{dismissed, selected}`
 *        - PickerItemInput.value fallback to label when omitted
 *        - matchOnDescription default = true (forwarded to options)
 *   c) Tests via a stubbed prompter (no vscode import needed) — the
 *      coverage doc's b-row asks for "stubbed vscode.window.* " and
 *      this is exactly what `UserPrompter` provides.
 *   d) Timing — sub-ms per call (no real UI, no network).
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { withTiming } from './_timing.js';

// `user-interaction-tools.ts` imports `vscode` at module top to build the
// live executor.  The impls themselves are vscode-free (they take a
// `UserPrompter` dep) but the import would still trip up node:test.
// Install the shared stub before importing the module — see
// `_vscode-stub.ts` for the contract.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    askUserImpl,
    askUserPickerImpl,
    type UserPrompter,
    type PickerItem,
    type InputBoxOpts,
    type QuickPickOpts,
    type AskUserInput,
    type AskUserPickerInput,
} from '../user-interaction-tools.js';

// ===========================================================================
// Stubbed prompter
// ===========================================================================

interface StubInputCall { opts: InputBoxOpts }
interface StubPickerCall { items: PickerItem[]; opts: QuickPickOpts }

interface StubPrompter extends UserPrompter {
    inputCalls: StubInputCall[];
    pickerCalls: StubPickerCall[];
    /** What `showInputBox` returns next. */
    nextInput: string | undefined;
    /** What `showQuickPick` returns next. */
    nextPick: PickerItem | PickerItem[] | undefined;
    /** Force `showInputBox` to throw. */
    throwOnInput?: Error;
    throwOnPick?: Error;
}

function makePrompter(): StubPrompter {
    const p: StubPrompter = {
        inputCalls: [],
        pickerCalls: [],
        nextInput: undefined,
        nextPick: undefined,
        async showInputBox(opts) {
            p.inputCalls.push({ opts });
            if (p.throwOnInput) { throw p.throwOnInput; }
            return p.nextInput;
        },
        async showQuickPick(items, opts) {
            p.pickerCalls.push({ items, opts });
            if (p.throwOnPick) { throw p.throwOnPick; }
            return p.nextPick;
        },
    };
    return p;
}

// ===========================================================================
// `tomAi_askUser`
// ===========================================================================

describe('askUserImpl', () => {

    test('typical: user submits text → ok, value, emptyInput: false', async () => {
        const p = makePrompter();
        p.nextInput = 'hello world';
        const raw = await withTiming('tomAi_askUser:typical', () =>
            askUserImpl(p, { prompt: 'Say something' }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.dismissed, false);
        assert.equal(r.value, 'hello world');
        assert.equal(r.emptyInput, false);
        // verify the dep was called once with the expected opts
        assert.equal(p.inputCalls.length, 1);
        assert.equal(p.inputCalls[0].opts.prompt, 'Say something');
        assert.equal(p.inputCalls[0].opts.ignoreFocusOut, true);
    });

    test('cancellation (Escape → undefined) → dismissed: true, value: null', async () => {
        const p = makePrompter();
        p.nextInput = undefined;
        const r = JSON.parse(await askUserImpl(p, { prompt: 'x' }));
        assert.equal(r.dismissed, true);
        assert.equal(r.value, null);
        assert.equal(r.emptyInput, false);
    });

    test('empty submission ("" — Enter on blank input) is DISTINCT from cancel', async () => {
        const p = makePrompter();
        p.nextInput = '';
        const r = JSON.parse(await askUserImpl(p, { prompt: 'x' }));
        assert.equal(r.dismissed, false, 'empty submission is a valid submission');
        assert.equal(r.value, '');
        assert.equal(r.emptyInput, true, 'flag lets the caller detect blank');
    });

    test('forwards placeholder + defaultValue + password + title', async () => {
        const p = makePrompter();
        p.nextInput = 'secret';
        await askUserImpl(p, {
            prompt: 'Pwd?',
            placeholder: 'enter password',
            defaultValue: '',
            password: true,
            title: 'Auth',
        } as AskUserInput);
        const opts = p.inputCalls[0].opts;
        assert.equal(opts.placeHolder, 'enter password');
        assert.equal(opts.value, '');
        assert.equal(opts.password, true);
        assert.equal(opts.title, 'Auth');
    });

    test('missing prompt → ok: false, prompter NOT invoked', async () => {
        const p = makePrompter();
        const r = JSON.parse(await askUserImpl(p, { prompt: '' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`prompt` is required/);
        assert.equal(p.inputCalls.length, 0);
    });

    test('blank-only prompt rejected', async () => {
        const p = makePrompter();
        const r = JSON.parse(await askUserImpl(p, { prompt: '   ' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`prompt` is required/);
    });

    test('prompter throws → ok: false with reason', async () => {
        const p = makePrompter();
        p.throwOnInput = new Error('boom');
        const r = JSON.parse(await askUserImpl(p, { prompt: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /askUser failed: boom/);
    });
});

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
