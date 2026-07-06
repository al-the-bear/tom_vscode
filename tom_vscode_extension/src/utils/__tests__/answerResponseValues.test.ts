/**
 * Pure analysis that turns a *final LLM answer* into the chat-variable updates
 * the prompt queue must apply. This is the transport-agnostic core of "variable
 * setting must work on every answer": the Copilot answer-file path and the
 * Anthropic direct-send path both feed their final answer through this so a
 * repeating / multi-stage queue item propagates responseValues for EVERY stage
 * (pre-prompt, main, each repeat, follow-up), not just the last.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeAnswerText,
    normalizeResponseValues,
    splitResponseValues,
    BUILTIN_CHAT_VARIABLE_KEYS,
} from '../answerResponseValues.js';

describe('normalizeResponseValues', () => {
    it('stringifies values and drops null/undefined and empty keys', () => {
        const out = normalizeResponseValues({
            foo: 'bar',
            count: 3 as unknown as string,
            nada: null as unknown as string,
            gone: undefined as unknown as string,
            '': 'x',
        });
        assert.deepEqual(out, { foo: 'bar', count: '3' });
    });

    it('returns an empty object for undefined input', () => {
        assert.deepEqual(normalizeResponseValues(undefined), {});
    });
});

describe('splitResponseValues', () => {
    it('keeps every value for the chat-response store, filters built-ins out of custom', () => {
        const { chatResponseValues, customValues } = splitResponseValues({
            quest: 'vscode_extension',
            role: 'engineer',
            myVar: 'hello',
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
        });
        // ${chat.KEY} store carries everything, built-ins included.
        assert.deepEqual(chatResponseValues, {
            quest: 'vscode_extension',
            role: 'engineer',
            myVar: 'hello',
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
        });
        // Custom variables exclude the built-in keys.
        assert.deepEqual(customValues, {
            myVar: 'hello',
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
        });
    });

    it('strips a leading custom. prefix from custom variable keys', () => {
        const { customValues } = splitResponseValues({ 'custom.myVar': 'v' });
        assert.deepEqual(customValues, { myVar: 'v' });
    });

    it('exposes the built-in key set it filters on', () => {
        assert.ok(BUILTIN_CHAT_VARIABLE_KEYS.includes('quest'));
        assert.ok(BUILTIN_CHAT_VARIABLE_KEYS.includes('todoFile'));
    });
});

describe('analyzeAnswerText', () => {
    it('extracts a variables: block into chat + custom updates', () => {
        const text = [
            'All done.',
            '',
            'variables:',
            '  - myVar = hello',
            '  - TODO = _ai/quests/x/y.todo.yaml/AA1',
        ].join('\n');
        const { chatResponseValues, customValues } = analyzeAnswerText(text);
        assert.deepEqual(chatResponseValues, { myVar: 'hello', TODO: '_ai/quests/x/y.todo.yaml/AA1' });
        assert.deepEqual(customValues, { myVar: 'hello', TODO: '_ai/quests/x/y.todo.yaml/AA1' });
    });

    it('extracts a responseValues JSON block', () => {
        const text = 'prose "responseValues": { "score": "9", "quest": "q1" } more';
        const { chatResponseValues, customValues } = analyzeAnswerText(text);
        assert.deepEqual(chatResponseValues, { score: '9', quest: 'q1' });
        // quest is a built-in → not a custom variable.
        assert.deepEqual(customValues, { score: '9' });
    });

    it('returns empty updates for plain prose', () => {
        const { chatResponseValues, customValues } = analyzeAnswerText('just a plain answer');
        assert.deepEqual(chatResponseValues, {});
        assert.deepEqual(customValues, {});
    });

    it('returns empty updates for empty text', () => {
        const { chatResponseValues, customValues } = analyzeAnswerText('');
        assert.deepEqual(chatResponseValues, {});
        assert.deepEqual(customValues, {});
    });
});
