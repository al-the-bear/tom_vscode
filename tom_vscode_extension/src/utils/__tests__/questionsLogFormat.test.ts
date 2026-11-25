/**
 * The reader of the old questions journal `questions.<quest>.md` (old place, read-only): the Q&A page lists its
 * entries, of unknown host, beside the per-host Q&A journals.
 *
 *   QL-1 an entry: title, time, tool, run, the numbered questions, the quoted answer with its time and source
 *   QL-2 an answer holding its own `##` heading and a fenced block stays one entry, the text unquoted
 *   QL-3 entries without questions; the empty-answer marker reads as an empty answer; text before the first entry
 *        (the header) is skipped
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseLegacyQuestionsJournal } from '../questionsLogFormat.js';

const OLD = [
    '# Questions — demo',
    '',
    'Every question the ask-the-user tools put to you, with the answer that',
    'came back.',
    '',
    '## 2026-08-03T12:22:07.000Z — Migration plan',
    '',
    '- **Tool:** `tomAi_askUser`',
    '- **Run:** collab',
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
    '> ## not a heading',
    '>',
    '> ```',
    '> code',
    '> ```',
    '',
    '## 2026-08-04T08:00:00.000Z — tomAi_askUserPicker',
    '',
    '- **Tool:** `tomAi_askUserPicker`',
    '- **Run:** default',
    '- **Answered:** 2026-08-04T08:01:00.000Z via timeout, after 1m 0s',
    '',
    '### Answer',
    '',
    '> _(no answer text)_',
    '',
].join('\n');

describe('parseLegacyQuestionsJournal', () => {
    const items = parseLegacyQuestionsJournal(OLD);

    test('QL-1: an entry with its questions and answer', () => {
        assert.equal(items.length, 2);
        const [first] = items;
        assert.equal(first.kind, 'question');
        assert.equal(first.legacy, true);
        assert.equal(first.host, '');
        assert.equal(first.title, 'Migration plan');
        assert.equal(first.time, '2026-08-03T12:22:07.000Z');
        assert.equal(first.tool, 'tomAi_askUser');
        assert.equal(first.run, 'collab');
        assert.deepEqual(first.questions, ['Which database should I target?', 'Is a destructive migration acceptable?']);
        assert.equal(first.reply?.time, '2026-08-03T12:24:31.000Z');
        assert.equal(first.reply?.source, 'vscode');
    });

    test('QL-2: an answer with a heading and a fenced block is one entry, unquoted', () => {
        assert.equal(items[0].reply?.text, 'Postgres, and no.\n## not a heading\n\n```\ncode\n```');
    });

    test('QL-3: no questions, the empty-answer marker, the header skipped', () => {
        assert.deepEqual(items[1].questions, []);
        assert.equal(items[1].reply?.source, 'timeout');
        assert.equal(items[1].reply?.text, '');
        assert.equal(parseLegacyQuestionsJournal('# Questions — x\n\nno entries\n').length, 0);
    });
});
