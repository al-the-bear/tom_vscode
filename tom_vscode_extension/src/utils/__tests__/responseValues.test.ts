/**
 * Tests for the shared response-value extractor used by both the Copilot and
 * Anthropic answer paths. The contract: the same three shapes (JSON
 * `responseValues`, YAML `responseValues:` block, `variables:` block) are
 * recognised everywhere, and TODO references survive the round-trip.
 *
 * The module imports neither `vscode` nor any SDK, so it loads directly under
 * `node --test`.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    extractResponseValuesFromText,
    extractTodoRefFromText,
    extractTodoResponseValues,
} from '../responseValues.js';

describe('extractResponseValuesFromText', () => {
    test('parses a JSON responseValues block', () => {
        const text = 'blah\n"responseValues": { "TODO": "_ai/quests/x/y.todo.yaml/AA1" }\nend';
        assert.deepEqual(extractResponseValuesFromText(text), {
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
        });
    });

    test('parses a YAML responseValues: block', () => {
        const text = 'answer text\nresponseValues:\n  TODO: _ai/quests/x/y.todo.yaml/AA1\n';
        assert.deepEqual(extractResponseValuesFromText(text), {
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
        });
    });

    test('parses a variables: block with `- key = value` lines', () => {
        const text = 'the answer\n\nvariables:\n - TODO = _ai/quests/x/y.todo.yaml/AA1\n - TODO2 = _ai/quests/x/y.todo.yaml/AA2\n';
        assert.deepEqual(extractResponseValuesFromText(text), {
            TODO: '_ai/quests/x/y.todo.yaml/AA1',
            TODO2: '_ai/quests/x/y.todo.yaml/AA2',
        });
    });

    test('returns an empty object for text with no response values', () => {
        assert.deepEqual(extractResponseValuesFromText('just a plain answer'), {});
    });

    test('returns an empty object for empty input', () => {
        assert.deepEqual(extractResponseValuesFromText(''), {});
    });
});

describe('extractTodoResponseValues', () => {
    test('keeps only keys containing TODO', () => {
        const text = 'variables:\n - TODO = ref/AA1\n - other = nope\n - firstTODO = ref/AA2\n';
        assert.deepEqual(extractTodoResponseValues(text), {
            TODO: 'ref/AA1',
            firstTODO: 'ref/AA2',
        });
    });
});

describe('extractTodoRefFromText', () => {
    test('falls back to an inline TODO = ref', () => {
        assert.equal(extractTodoRefFromText('done. TODO = _ai/quests/x/y.todo.yaml/AA1'),
            '_ai/quests/x/y.todo.yaml/AA1');
    });

    test('returns undefined when nothing matches', () => {
        assert.equal(extractTodoRefFromText('no reference here'), undefined);
    });
});
