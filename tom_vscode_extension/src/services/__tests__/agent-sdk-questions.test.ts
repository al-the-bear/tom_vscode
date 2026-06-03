/**
 * Tests for the pure Agent SDK `AskUserQuestion` interception logic
 * (spec: anthropic_sdk_integration.md §18, "Anthropic Interactive Questions").
 *
 * Coverage:
 *   - isAskUserQuestionTool: matches the built-in name, rejects others.
 *   - parseAskUserQuestionInput: accepts the SDK shape (with defaults for
 *     header/multiSelect/options), rejects malformed payloads.
 *   - summarizeQuestions: digest with headers + options.
 *   - formatInteractiveAnswers: pure rendering of collected selections.
 *   - collectInteractiveAnswers: single-select, multi-select, the "Other…"
 *     free-text fall-through, and dismissal (of the picker and of the
 *     free-text box) → null.
 *
 * The module under test imports `vscode` only as a type (erased at compile
 * time), so it loads directly under `node --test` with a stub prompter.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
    UserPrompter,
    PickerItem,
    InputBoxOpts,
    QuickPickOpts,
} from '../../tools/user-interaction-tools.js';
import {
    isAskUserQuestionTool,
    parseAskUserQuestionInput,
    summarizeQuestions,
    formatInteractiveAnswers,
    collectInteractiveAnswers,
    OTHER_OPTION_LABEL,
    ASK_USER_QUESTION_TOOL_NAME,
} from '../agent-sdk-questions.js';

// ---------------------------------------------------------------------------
// Scripted prompter — returns the queued response for each call in order.
// ---------------------------------------------------------------------------

type PickResponse = PickerItem | PickerItem[] | undefined;

function makePrompter(picks: PickResponse[], inputs: Array<string | undefined>): UserPrompter {
    const pickQueue = [...picks];
    const inputQueue = [...inputs];
    return {
        showInputBox(_opts: InputBoxOpts): Promise<string | undefined> {
            return Promise.resolve(inputQueue.shift());
        },
        showQuickPick(_items: PickerItem[], _opts: QuickPickOpts): Promise<PickResponse> {
            return Promise.resolve(pickQueue.shift());
        },
    };
}

const ITEM = (label: string): PickerItem => ({ label, value: label });

// ---------------------------------------------------------------------------

describe('isAskUserQuestionTool', () => {
    test('matches the built-in tool name', () => {
        assert.equal(isAskUserQuestionTool(ASK_USER_QUESTION_TOOL_NAME), true);
        assert.equal(isAskUserQuestionTool('AskUserQuestion'), true);
    });

    test('rejects other tool names', () => {
        assert.equal(isAskUserQuestionTool('Bash'), false);
        assert.equal(isAskUserQuestionTool('tomAi_askUser'), false);
        assert.equal(isAskUserQuestionTool(''), false);
    });
});

describe('parseAskUserQuestionInput', () => {
    test('parses a well-formed payload with defaults', () => {
        const parsed = parseAskUserQuestionInput({
            questions: [
                {
                    question: 'Pick a colour',
                    header: 'Colour',
                    multiSelect: true,
                    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
                },
                { question: 'Continue?' }, // header/multiSelect/options omitted
            ],
        });
        assert.ok(parsed);
        assert.equal(parsed!.questions.length, 2);
        assert.deepEqual(parsed!.questions[0], {
            question: 'Pick a colour',
            header: 'Colour',
            multiSelect: true,
            options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: undefined }],
        });
        // Defaults: empty header, multiSelect false, empty options.
        assert.deepEqual(parsed!.questions[1], {
            question: 'Continue?',
            header: '',
            multiSelect: false,
            options: [],
        });
    });

    test('rejects malformed payloads', () => {
        assert.equal(parseAskUserQuestionInput(null), null);
        assert.equal(parseAskUserQuestionInput('nope'), null);
        assert.equal(parseAskUserQuestionInput({}), null);
        assert.equal(parseAskUserQuestionInput({ questions: [] }), null);
        assert.equal(parseAskUserQuestionInput({ questions: ['x'] }), null);
        // A question missing its text invalidates the whole payload.
        assert.equal(parseAskUserQuestionInput({ questions: [{ header: 'h' }] }), null);
    });
});

describe('summarizeQuestions', () => {
    test('renders headers + options as bullets', () => {
        const digest = summarizeQuestions({
            questions: [
                { question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
                { question: 'Continue?', header: '', multiSelect: false, options: [] },
            ],
        });
        assert.equal(
            digest,
            '- [Colour] Pick a colour (options: Red, Blue)\n- Continue?',
        );
    });
});

describe('formatInteractiveAnswers', () => {
    test('renders one block per answer', () => {
        const text = formatInteractiveAnswers([
            { header: 'Colour', question: 'Pick a colour', selections: ['Red', 'Blue'] },
            { header: '', question: 'Continue?', selections: [] },
        ]);
        assert.match(text, /The user answered your questions:/);
        assert.match(text, /\*\*Colour\*\* — Pick a colour/);
        assert.match(text, /→ Red, Blue/);
        assert.match(text, /→ \(no selection\)/);
    });
});

describe('collectInteractiveAnswers', () => {
    test('single-select returns the chosen value', async () => {
        const parsed = parseAskUserQuestionInput({
            questions: [{ question: 'Pick a colour', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }] }],
        })!;
        const prompter = makePrompter([ITEM('Blue')], []);
        const text = await collectInteractiveAnswers(prompter, parsed);
        assert.ok(text);
        assert.match(text!, /→ Blue/);
    });

    test('multi-select returns all chosen values', async () => {
        const parsed = parseAskUserQuestionInput({
            questions: [{ question: 'Pick colours', header: 'Colour', multiSelect: true, options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] }],
        })!;
        const prompter = makePrompter([[ITEM('Red'), ITEM('Green')]], []);
        const text = await collectInteractiveAnswers(prompter, parsed);
        assert.match(text!, /→ Red, Green/);
    });

    test('"Other…" falls through to a free-text input box', async () => {
        const parsed = parseAskUserQuestionInput({
            questions: [{ question: 'Pick a colour', header: 'Colour', options: [{ label: 'Red' }] }],
        })!;
        const prompter = makePrompter([ITEM(OTHER_OPTION_LABEL)], ['Chartreuse']);
        const text = await collectInteractiveAnswers(prompter, parsed);
        assert.match(text!, /→ Chartreuse/);
    });

    test('dismissing the picker returns null (autonomous fallback)', async () => {
        const parsed = parseAskUserQuestionInput({
            questions: [{ question: 'Pick a colour', options: [{ label: 'Red' }] }],
        })!;
        const prompter = makePrompter([undefined], []);
        const text = await collectInteractiveAnswers(prompter, parsed);
        assert.equal(text, null);
    });

    test('dismissing the free-text box returns null', async () => {
        const parsed = parseAskUserQuestionInput({
            questions: [{ question: 'Pick a colour', options: [{ label: 'Red' }] }],
        })!;
        const prompter = makePrompter([ITEM(OTHER_OPTION_LABEL)], [undefined]);
        const text = await collectInteractiveAnswers(prompter, parsed);
        assert.equal(text, null);
    });
});
