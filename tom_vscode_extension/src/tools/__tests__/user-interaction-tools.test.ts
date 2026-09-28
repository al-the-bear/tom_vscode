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
 *   - timing out vs the user dismissing — a third outcome, and a different
 *     one: nobody was there, as opposed to somebody who said no.
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
    QUICK_PICK_TIMED_OUT,
    type UserPrompter,
    type PickerItem,
    type QuickPickOpts,
    type QuickPickResult,
    type InputBoxOpts,
    type AskUserPickerInput,
} from '../user-interaction-tools.js';
import { OTHER_OPTION_LABEL } from '../../services/free-text-picker.js';
import type { QuestionLogEntry } from '../../utils/questionsLogFormat.js';

// ===========================================================================
// Stubbed prompter
// ===========================================================================

interface StubPickerCall { items: PickerItem[]; opts: QuickPickOpts }

interface StubPrompter extends UserPrompter {
    pickerCalls: StubPickerCall[];
    /** What `showQuickPick` returns next. */
    nextPick: QuickPickResult;
    throwOnPick?: Error;
    /** Options every `showInputBox` call was made with, in order. */
    inputCalls: InputBoxOpts[];
    /** What `showInputBox` returns next (the "Other…" free-text answer). */
    nextInput: string | undefined;
}

function makePrompter(): StubPrompter {
    const p: StubPrompter = {
        pickerCalls: [],
        nextPick: undefined,
        inputCalls: [],
        nextInput: undefined,
        async showQuickPick(items, opts) {
            p.pickerCalls.push({ items, opts });
            if (p.throwOnPick) { throw p.throwOnPick; }
            return p.nextPick;
        },
        async showInputBox(opts) {
            p.inputCalls.push(opts);
            return p.nextInput;
        },
    };
    return p;
}

/** The picked item for the appended free-text entry. */
const OTHER: PickerItem = { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL };

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
            [
                { label: 'A', value: 'A' },
                { label: 'B', value: 'b-val' },
                // Every picker ends with the free-text entry — see the
                // "free-text answers" block below.
                { label: OTHER_OPTION_LABEL, value: OTHER_OPTION_LABEL },
            ],
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

// ===========================================================================
// Free-text answers — the offered options are a guess, not the vocabulary
// ===========================================================================

describe('askUserPickerImpl — free-text answers', () => {

    test('an "Other…" entry is appended to every item list', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'alpha', value: 'alpha' };
        await askUserPickerImpl(p, { items: ['alpha', 'beta'] });
        assert.deepEqual(
            p.pickerCalls[0].items.map((i) => i.label),
            ['alpha', 'beta', OTHER_OPTION_LABEL],
        );
    });

    test('a caller that already offers "Other…" does not get a duplicate', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'alpha', value: 'alpha' };
        await askUserPickerImpl(p, { items: ['alpha', OTHER_OPTION_LABEL] });
        assert.deepEqual(
            p.pickerCalls[0].items.map((i) => i.label),
            ['alpha', OTHER_OPTION_LABEL],
        );
    });

    test('picking "Other…" opens an input box and returns what the user typed', async () => {
        const p = makePrompter();
        p.nextPick = OTHER;
        p.nextInput = '  SQLite  ';
        const r = JSON.parse(await askUserPickerImpl(p, {
            items: ['Postgres', 'MySQL'],
            prompt: 'Which database?',
            title: 'Database',
        }));
        assert.equal(p.inputCalls.length, 1, 'the free-text box was shown');
        assert.equal(p.inputCalls[0].prompt, 'Which database?');
        assert.equal(p.inputCalls[0].title, 'Database');
        assert.equal(p.inputCalls[0].ignoreFocusOut, true);
        assert.equal(r.dismissed, false);
        // Trimmed, and it becomes both label and value — there is no
        // caller-side vocabulary for an answer the caller did not foresee.
        assert.deepEqual(r.selected, { label: 'SQLite', value: 'SQLite' });
    });

    test('no input box is shown when the user picks a listed option', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'Postgres', value: 'pg' };
        await askUserPickerImpl(p, { items: ['Postgres'] });
        assert.equal(p.inputCalls.length, 0);
    });

    test('multi-select: the typed answer joins the ticked options', async () => {
        const p = makePrompter();
        p.nextPick = [{ label: 'A', value: 'a-val' }, OTHER];
        p.nextInput = 'C';
        const r = JSON.parse(await askUserPickerImpl(p, {
            items: ['A', 'B'], canPickMany: true,
        }));
        assert.deepEqual(r.selected, [
            { label: 'A', value: 'a-val' },
            { label: 'C', value: 'C' },
        ]);
    });

    test('dismissing the free-text box dismisses the whole question', async () => {
        // A half-answer is indistinguishable from a deliberate one, so the
        // caller gets a dismissal rather than the options ticked so far.
        const p = makePrompter();
        p.nextPick = [{ label: 'A', value: 'A' }, OTHER];
        p.nextInput = undefined;
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['A'], canPickMany: true }));
        assert.equal(r.dismissed, true);
        assert.equal(r.selected, null);
    });

    test('a blank free-text answer is an answer with nothing in it, not a pick', async () => {
        const p = makePrompter();
        p.nextPick = OTHER;
        p.nextInput = '   ';
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['A'] }));
        assert.equal(r.selected, null);
    });

    test('the typed answer is what lands in the questions journal', async () => {
        const p = makePrompter();
        p.nextPick = OTHER;
        p.nextInput = 'DuckDB';
        const logged: QuestionLogEntry[] = [];
        await askUserPickerImpl(p, { items: ['Postgres'], prompt: 'Which database?' }, {
            log: (e) => logged.push(e),
        });
        assert.equal(logged.length, 1);
        assert.equal(logged[0].answer, 'DuckDB');
    });
});

// ===========================================================================
// Deadline — the picker blocks the queue exactly like `tomAi_askUser`
// ===========================================================================

describe('askUserPickerImpl — deadline', () => {

    test('no ceiling and no per-call timeout → the prompter gets no deadline', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'] });
        assert.equal(p.pickerCalls[0].opts.timeoutMs, undefined);
    });

    test('per-call timeoutMinutes is forwarded as milliseconds', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'], timeoutMinutes: 3 });
        assert.equal(p.pickerCalls[0].opts.timeoutMs, 3 * 60_000);
    });

    test('the configured ceiling caps the per-call request', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'], timeoutMinutes: 60 }, { ceilingMinutes: 10 });
        assert.equal(p.pickerCalls[0].opts.timeoutMs, 10 * 60_000);
    });

    test('the ceiling alone arms a deadline', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        await askUserPickerImpl(p, { items: ['a'] }, { ceilingMinutes: 5 });
        assert.equal(p.pickerCalls[0].opts.timeoutMs, 5 * 60_000);
    });

    test('a timeout is its own outcome — not a dismissal', async () => {
        // Dismissed means the user saw the question and declined. Timed out
        // means nobody was there. The model must be able to tell them apart.
        const p = makePrompter();
        p.nextPick = QUICK_PICK_TIMED_OUT;
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['a'], timeoutMinutes: 1 }));
        assert.equal(r.ok, true);
        assert.equal(r.timedOut, true);
        assert.equal(r.dismissed, false);
        assert.equal(r.selected, null);
    });

    test('a normal outcome reports timedOut: false', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        const picked = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }));
        assert.equal(picked.timedOut, false);
        p.nextPick = undefined;
        const dismissed = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }));
        assert.equal(dismissed.timedOut, false);
    });
});

// ===========================================================================
// Questions journal
// ===========================================================================

describe('askUserPickerImpl — questions journal', () => {

    function makeLogger() {
        const logged: QuestionLogEntry[] = [];
        let clock = 500_000;
        return {
            logged,
            tick(ms: number) { clock += ms; },
            deps: { log: (e: QuestionLogEntry) => logged.push(e), now: () => clock },
        };
    }

    test('a pick is journalled with the prompt, the chosen labels and the timings', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'Postgres', value: 'pg' };
        const l = makeLogger();
        const askedAt = l.deps.now();
        // The stub resolves synchronously, so advance the clock inside it.
        p.showQuickPick = async (items, opts) => {
            p.pickerCalls.push({ items, opts });
            l.tick(30_000);
            return p.nextPick;
        };
        await askUserPickerImpl(p, { items: ['Postgres', 'MySQL'], prompt: 'Which database?' }, l.deps);

        assert.equal(l.logged.length, 1);
        const e = l.logged[0];
        assert.equal(e.tool, 'tomAi_askUserPicker');
        assert.deepEqual([...e.questions], ['Which database?']);
        assert.equal(e.answer, 'Postgres');
        assert.equal(e.source, 'vscode');
        assert.equal(e.askedAt, askedAt);
        assert.equal(e.answeredAt, askedAt + 30_000);
    });

    test('a multi-select pick is journalled with every chosen label', async () => {
        const p = makePrompter();
        p.nextPick = [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }];
        const l = makeLogger();
        await askUserPickerImpl(p, { items: ['a', 'b'], canPickMany: true }, l.deps);
        assert.match(l.logged[0].answer, /\ba\b/);
        assert.match(l.logged[0].answer, /\bb\b/);
    });

    test('a dismissal is journalled as a cancel, not as a silent nothing', async () => {
        const p = makePrompter();
        p.nextPick = undefined;
        const l = makeLogger();
        await askUserPickerImpl(p, { items: ['a'] }, l.deps);
        assert.equal(l.logged.length, 1);
        assert.equal(l.logged[0].source, 'cancel');
    });

    test('a timeout is journalled as a timeout', async () => {
        const p = makePrompter();
        p.nextPick = QUICK_PICK_TIMED_OUT;
        const l = makeLogger();
        await askUserPickerImpl(p, { items: ['a'], timeoutMinutes: 1 }, l.deps);
        assert.equal(l.logged[0].source, 'timeout');
    });

    test('a rejected call and a crashed prompter are not journalled', async () => {
        const p = makePrompter();
        const l = makeLogger();
        await askUserPickerImpl(p, { items: [] }, l.deps);
        p.throwOnPick = new Error('boom');
        await askUserPickerImpl(p, { items: ['a'] }, l.deps);
        assert.equal(l.logged.length, 0);
    });

    test('a journal failure does not break the pick', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        const r = JSON.parse(await askUserPickerImpl(p, { items: ['a'] }, {
            log: () => { throw new Error('disk full'); },
        }));
        assert.equal(r.ok, true);
        assert.equal(r.selected.value, 'a');
    });

    test('the title is preferred over the prompt as the journal heading', async () => {
        const p = makePrompter();
        p.nextPick = { label: 'a', value: 'a' };
        const l = makeLogger();
        await askUserPickerImpl(p, { items: ['a'], prompt: 'pick one', title: 'Database' }, l.deps);
        assert.equal(l.logged[0].title, 'Database');
    });
});
