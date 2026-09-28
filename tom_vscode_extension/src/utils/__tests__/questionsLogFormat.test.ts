/**
 * Tests for the Questions journal formatter — the markdown appended to
 * `questions.<quest>.md` every time an ask-the-user tool resolves.
 *
 * The formatter is pure (no `vscode`, no `fs`) so the shape of the journal can
 * be pinned down here. Three contracts matter:
 *
 *   - **One entry per resolved ask, whatever resolved it.** A timeout and a
 *     cancel are as much part of the record as a typed answer — a journal that
 *     only recorded the happy path would silently lose exactly the exchanges
 *     worth reviewing.
 *   - **The answer cannot break the outline.** It is verbatim user text and may
 *     contain its own `##` headings, so it is quoted rather than inlined.
 *   - **Entries are self-contained and appendable.** The file is read from its
 *     end by the Logs viewer, so an entry must make sense without the header.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    formatQuestionLogEntry,
    questionsLogHeader,
    formatWaited,
    type QuestionLogEntry,
} from '../questionsLogFormat.js';

const ASKED_AT = Date.parse('2026-08-03T12:22:07.000Z');

function entry(overrides: Partial<QuestionLogEntry> = {}): QuestionLogEntry {
    return {
        tool: 'tomAi_askUser',
        title: 'Migration plan',
        questions: ['Which database should I target?', 'Is a destructive migration acceptable?'],
        answer: 'Postgres, and no.',
        source: 'vscode',
        askedAt: ASKED_AT,
        answeredAt: ASKED_AT + 144_000,
        ...overrides,
    };
}

describe('formatQuestionLogEntry', () => {
    test('renders a complete exchange', () => {
        assert.equal(formatQuestionLogEntry(entry()), [
            '## 2026-08-03T12:22:07.000Z — Migration plan',
            '',
            '- **Tool:** `tomAi_askUser`',
            '- **Answered:** 2026-08-03T12:24:31.000Z via vscode, after 2m 24s',
            '',
            '### Questions',
            '',
            '1. Which database should I target?',
            '2. Is a destructive migration acceptable?',
            '',
            '### Answer',
            '',
            '> Postgres, and no.',
            '',
        ].join('\n'));
    });

    test('falls back to the tool name as the heading when there is no title', () => {
        // The heading is what the reader scans; leaving it as a bare timestamp
        // would make the journal unscannable.
        const text = formatQuestionLogEntry(entry({ title: undefined }));
        assert.equal(text.split('\n')[0], '## 2026-08-03T12:22:07.000Z — tomAi_askUser');
    });

    test('quotes every answer line so user markdown cannot break the outline', () => {
        // A verbatim answer containing its own heading would otherwise be
        // indistinguishable from a journal entry heading.
        const text = formatQuestionLogEntry(entry({ answer: '## not a heading\n\nsecond para' }));
        assert.ok(text.includes('> ## not a heading\n>\n> second para\n'));
        assert.equal(text.split('\n').filter(l => l.startsWith('## ')).length, 1);
    });

    test('records an empty answer explicitly rather than as blank space', () => {
        const text = formatQuestionLogEntry(entry({ answer: '   ' }));
        assert.ok(text.includes('> _(no answer text)_'));
    });

    test('records a timeout as a resolution in its own right', () => {
        // The fallback prompt is what the model actually received, so it is the
        // answer of record even though no human typed it.
        const text = formatQuestionLogEntry(entry({
            source: 'timeout',
            answer: "The user didn't answer. Please follow your recommendations.",
        }));
        assert.ok(text.includes('via timeout, after 2m 24s'));
        assert.ok(text.includes("> The user didn't answer."));
    });

    test('numbers the questions in the order they were put', () => {
        const text = formatQuestionLogEntry(entry({ questions: ['a', 'b', 'c'] }));
        assert.ok(text.includes('\n1. a\n2. b\n3. c\n'));
    });

    test('omits the Questions section when there is nothing to number', () => {
        // The picker asks with a single prompt line that is carried by the
        // title; an empty numbered list would just be noise.
        const text = formatQuestionLogEntry(entry({ questions: [] }));
        assert.equal(text.includes('### Questions'), false);
        assert.ok(text.includes('### Answer'));
    });

    test('ends with exactly one blank-line separator so entries do not run together', () => {
        const text = formatQuestionLogEntry(entry());
        assert.ok(text.endsWith('\n'));
        assert.equal(text.endsWith('\n\n\n'), false);
    });

    test('a clock that went backwards does not produce a negative wait', () => {
        const text = formatQuestionLogEntry(entry({ answeredAt: ASKED_AT - 5_000 }));
        assert.ok(text.includes('after 0s'), text);
    });
});

describe('formatWaited', () => {
    test('renders seconds, minutes and hours in descending units', () => {
        assert.equal(formatWaited(0), '0s');
        assert.equal(formatWaited(45_000), '45s');
        assert.equal(formatWaited(144_000), '2m 24s');
        assert.equal(formatWaited(3_600_000), '1h 0m 0s');
        assert.equal(formatWaited(3_903_000), '1h 5m 3s');
    });

    test('clamps a negative or non-finite duration to zero', () => {
        assert.equal(formatWaited(-1), '0s');
        assert.equal(formatWaited(Number.NaN), '0s');
    });
});

describe('questionsLogHeader', () => {
    test('names the quest so a file opened on its own identifies itself', () => {
        assert.ok(questionsLogHeader('vscode_extension').startsWith('# Questions — vscode_extension\n'));
    });

    test('ends with a blank line so the first entry starts cleanly', () => {
        assert.ok(questionsLogHeader('demo').endsWith('\n\n'));
    });
});
