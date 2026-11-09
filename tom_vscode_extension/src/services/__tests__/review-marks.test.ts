/**
 * Deciding inline review marks in Markdown text through the TomSpecs runtime's
 * annot4 API (src/services/review-marks.ts) — what the Markdown Browser's
 * accept / reject / remove buttons do.
 *
 *   RM-1 one change mark, named by its markup: accepted, or rejected, with the runtime's whitespace rules;
 *        the other marks stay
 *   RM-2 among identical markups the occurrence picks the one meant
 *   RM-3 an inline comment is removed: a highlight keeps its text, a lone comment goes
 *   RM-4 accept all / reject all: every change mark of the text, comments and highlights left, marks in
 *        code untouched; the count of decided marks
 *   RM-5 a mark that is not in the text is refused, the text unchanged
 *   RM-6 in a file: the block's lines must still be what the browser showed; the decided block replaces
 *        them, `remove` takes a comment out; a changed file is refused
 *   RM-7 comment a change (SOM §11.9.3): the change comment is written right after it, quoting it, with the
 *        change time (§11.9.10) after it; a change that has one already, a mark that is not a change and an
 *        empty or delimiter text are refused
 *   RM-8 edit an inline comment: a lone comment, a highlight's, a change comment (its quote kept), each with
 *        the time of the edit; a mark without a comment is refused
 *   RM-9 deciding a commented change keeps its comment and records the outcome in the quote; accept all
 *        leaves change comments; `comment` / `edit` in a file go through the same line check
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { commentMark, decideAllChanges, decideMark, reviewMarkEdit } from '../review-marks.js';
import { withoutChangeTimes } from '../../tools/__tests__/_reviewTimes.js';

const TEXT = 'The system {++ must ++}{-- should --} keep {~~ two ~> three ~~} copies. '
    + '{== Orders ==}{>> how long? <<} are kept{>> check with OPS <<}.';

describe('review marks', () => {
    test('RM-1: one change mark', () => {
        const accepted = decideMark(TEXT, { markup: '{~~ two ~> three ~~}', occurrence: 0, decision: 'accept' });
        assert.deepEqual(accepted, { ok: true, text: TEXT.replace('{~~ two ~> three ~~}', 'three') });
        const rejected = decideMark(TEXT, { markup: '{++ must ++}', occurrence: 0, decision: 'reject' });
        assert.equal(rejected.ok, true);
        assert.match(rejected.ok ? rejected.text : '', /^The system {-- should --} keep/, 'the added word goes, no double space');
        const deletion = decideMark(TEXT, { markup: '{-- should --}', occurrence: 0, decision: 'accept' });
        assert.match(deletion.ok ? deletion.text : '', /^The system {\+\+ must \+\+} keep/);
    });

    test('RM-2: the occurrence', () => {
        const text = 'A {++ x ++} and B {++ x ++} end.';
        const second = decideMark(text, { markup: '{++ x ++}', occurrence: 1, decision: 'reject' });
        assert.deepEqual(second, { ok: true, text: 'A {++ x ++} and B end.' });
    });

    test('RM-3: removing inline comments', () => {
        const highlight = decideMark(TEXT, { markup: '{== Orders ==}{>> how long? <<}', occurrence: 0, decision: 'accept' });
        assert.match(highlight.ok ? highlight.text : '', /copies\. Orders are kept/, 'the commented text stays');
        const lone = decideMark(TEXT, { markup: '{>> check with OPS <<}', occurrence: 0, decision: 'accept' });
        assert.match(lone.ok ? lone.text : '', /are kept\.$/, 'a lone comment goes, no space before the full stop');
    });

    test('RM-4: all changes at once', () => {
        const text = `${TEXT}\n\n\`\`\`\n{++ code ++}\n\`\`\`\n\nLast {-- old --} line.`;
        const accepted = decideAllChanges(text, 'accept');
        assert.equal(accepted.decided, 4);
        assert.equal(accepted.text, 'The system must keep three copies. {== Orders ==}{>> how long? <<} are kept{>> check with OPS <<}.'
            + '\n\n```\n{++ code ++}\n```\n\nLast line.');
        const rejected = decideAllChanges(text, 'reject');
        assert.equal(rejected.decided, 4);
        assert.match(rejected.text, /^The system should keep two copies\. \{== Orders/);
        assert.match(rejected.text, /Last old line\.$/);
        assert.deepEqual(decideAllChanges('no marks', 'accept'), { text: 'no marks', decided: 0 });
    });

    test('RM-5: an unknown mark', () => {
        const r = decideMark(TEXT, { markup: '{++ nope ++}', occurrence: 0, decision: 'accept' });
        assert.equal(r.ok, false);
        assert.match(r.ok ? '' : r.reason, /not in the text/);
        assert.equal(decideMark(TEXT, { markup: '{++ must ++}', occurrence: 1, decision: 'accept' }).ok, false, 'only one such mark');
    });

    test('RM-6: in a file', () => {
        const file = ['# T', '', 'Keep {++ two ++} copies{>> why? <<}.', '', 'End.'].join('\n');
        const edit = { startLine: 2, endLine: 3, expected: 'Keep {++ two ++} copies{>> why? <<}.' };
        assert.deepEqual(reviewMarkEdit(file, { ...edit, markup: '{++ two ++}', occurrence: 0, decision: 'accept' }),
            { ok: true, text: '# T\n\nKeep two copies{>> why? <<}.\n\nEnd.' });
        assert.deepEqual(reviewMarkEdit(file, { ...edit, markup: '{>> why? <<}', occurrence: 0, decision: 'remove' }),
            { ok: true, text: '# T\n\nKeep {++ two ++} copies.\n\nEnd.' });
        const stale = reviewMarkEdit(file, { ...edit, expected: 'something else', markup: '{++ two ++}', occurrence: 0, decision: 'accept' });
        assert.equal(stale.ok, false);
        assert.match(stale.ok ? '' : stale.reason, /changed since/);
    });

    test('RM-7: comment a change', () => {
        const text = 'Expire after {~~ 30 ~> 15 ~~} minutes{++ on shared devices ++}.';
        const since = new Date();
        const done = commentMark(text, { markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, op: 'comment', comment: '  why shorter?  ' });
        assert.equal(done.ok, true);
        assert.equal(withoutChangeTimes(done.ok ? done.text : '', since),
            'Expire after {~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<}{@<time>} minutes{++ on shared devices ++}.');
        const again = commentMark(done.ok ? done.text : '', { markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, op: 'comment', comment: 'and?' });
        assert.equal(again.ok, false, 'a change has one comment');
        const added = commentMark(text, { markup: '{++ on shared devices ++}', occurrence: 0, op: 'comment', comment: 'needed?' });
        assert.match(added.ok ? added.text : '', /\{\+\+ on shared devices \+\+\}\{>> \[\+\+ on shared devices \+\+\] needed\? <<\}/);
        for (const bad of ['', '   ', 'see {++ x ++}']) {
            assert.equal(commentMark(text, { markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, op: 'comment', comment: bad }).ok, false, `refused: "${bad}"`);
        }
        const notChange = commentMark('A {>> note <<} b.', { markup: '{>> note <<}', occurrence: 0, op: 'comment', comment: 'x' });
        assert.equal(notChange.ok, false);
    });

    test('RM-8: edit an inline comment', () => {
        const since = new Date();
        const lone = commentMark('A {>> note <<} b.', { markup: '{>> note <<}', occurrence: 0, op: 'edit', comment: 'better note' });
        assert.equal(lone.ok, true);
        assert.match(withoutChangeTimes(lone.ok ? lone.text : '', since), /^A \{>> ?better note ?<<\}\{@<time>\} b\.$/);
        const hl = commentMark('{== x ==}{>> why <<} y', { markup: '{== x ==}{>> why <<}', occurrence: 0, op: 'edit', comment: 'because' });
        assert.match(withoutChangeTimes(hl.ok ? hl.text : '', since), /^\{== x ==\}\{>> ?because ?<<\}\{@<time>\} y$/);
        const withComment = 'after {~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<} minutes';
        const cc = commentMark(withComment, { markup: '{>> [~~ 30 ~> 15 ~~] why shorter? <<}', occurrence: 0, op: 'edit', comment: 'is 15 enough?' });
        assert.match(withoutChangeTimes(cc.ok ? cc.text : '', since), /\{>> \[~~ 30 ~> 15 ~~\] is 15 enough\? <<\}\{@<time>\} minutes$/, 'the quote stays');
        assert.equal(commentMark('{++ x ++} y', { markup: '{++ x ++}', occurrence: 0, op: 'edit', comment: 'z' }).ok, false, 'no comment to edit');
    });

    test('RM-9: deciding a commented change, and in a file', () => {
        const withComment = 'after {~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why shorter? <<} minutes';
        const accepted = decideMark(withComment, { markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, decision: 'accept' });
        assert.match(accepted.ok ? accepted.text : '', /^after 15\{>> \[~~ 30 ~> 15 ~~ \| accepted\] why shorter\? <<\} minutes$/);
        const all = decideAllChanges(withComment, 'reject');
        assert.equal(all.decided, 1, 'the comment is not a change');
        assert.match(all.text, /^after 30\{>> \[~~ 30 ~> 15 ~~ \| rejected\] why shorter\? <<\} minutes$/);
        const file = '# T\n\nExpire after {~~ 30 ~> 15 ~~} minutes.\n';
        const since = new Date();
        const edited = reviewMarkEdit(file, { startLine: 2, endLine: 3, expected: 'Expire after {~~ 30 ~> 15 ~~} minutes.', markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, decision: 'comment', text: 'why?' });
        assert.equal(edited.ok, true);
        assert.equal(withoutChangeTimes(edited.ok ? edited.text : '', since), '# T\n\nExpire after {~~ 30 ~> 15 ~~}{>> [~~ 30 ~> 15 ~~] why? <<}{@<time>} minutes.\n');
        const stale = reviewMarkEdit(file, { startLine: 2, endLine: 3, expected: 'something else', markup: '{~~ 30 ~> 15 ~~}', occurrence: 0, decision: 'comment', text: 'why?' });
        assert.equal(stale.ok, false);
    });
});
