/**
 * The Markdown Browser's team review helpers (media/markdownBrowser/teamReview.js; SOM §11.9.8,
 * ccparity_f_teamreview-3), loaded into a vm sandbox and fed what the runtime's mergeReviews writes.
 *
 *   TR-1 individual answers: the `**Answer (<ids>):**` lines above a team answer, their members (a change
 *        time in the list dropped), the answer with its continuation lines and its option letter; a
 *        time-only list is the team answer, not an individual one; another question's lines are not taken
 *   TR-2 the option most chose, counting the members of a shared line; '' on a tie or without options
 *   TR-3 the `open:` summary by display name
 *   TR-4 a conflict block: id, topic, text, base, alternatives with members and continuation lines, the
 *        decision and its line, the block's lines; not a conflict: null
 *   TR-5 deciding a conflict: the chosen text (an alternative, the base, rewritten) replaces the paragraph
 *        before the block and the block goes, also with an annotation block between them; a whole-value
 *        conflict replaces the text run; the edit's `expected` is the text it replaces
 *   TR-6 a structural conflict or a form-field target only sets the decision line; `open:` keeps the block
 *        with the summary as its decision; a letter it has no alternative for is null
 *   TR-7 member colours: by team order, stable for a guest
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { mergeReviews } from 'tom_som_typescript_runtime';

const ROOT = join(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sandbox: Record<string, any> = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'media', 'markdownBrowser', 'teamReview.js'), 'utf-8'), sandbox);

const TEAM = [
    { memberId: 'alice', displayName: 'Alice Owner', role: 'Product owner' },
    { memberId: 'bob', displayName: 'Bob Dev', role: 'Developer' },
];
const BASE = '# Limits\n\nIntro.\n\nThe limit is 100 EUR.\n\nMore text here.\n\n> **❓ Q-1 — Currency:** EUR only?\n> - **(a)** yes\n> - (b) also CHF\n>\n> **Answer:**\n';
/** What mergeReviews writes when alice and bob change one sentence differently and answer Q-1. */
const MERGED: string = mergeReviews(BASE, [
    { ...TEAM[0], document: BASE.replace('100', '200').replace('**Answer:**', '**Answer:** (a)') },
    { ...TEAM[1], document: BASE.replace('100', '300').replace('**Answer:**', '**Answer:** (b) Swiss customers\n> pay in CHF') },
], { team: TEAM, date: '2026-11-05', author: 'Alice Owner' }).merged;
const LINES = MERGED.split('\n');
const lineOf = (re: RegExp): number => LINES.findIndex((l) => re.test(l));
const apply = (lines: string[], edit: Json): string => {
    assert.equal(lines.slice(edit.startLine, edit.endLine).join('\n'), edit.expected, 'expected is what the edit replaces');
    return [...lines.slice(0, edit.startLine), ...(edit.replacement === '' && edit.startLine === edit.endLine ? [] : edit.replacement.split('\n')), ...lines.slice(edit.endLine)].join('\n');
};

describe('Markdown Browser: team review helpers', () => {
    test('TR-1: individual answers', () => {
        const team = lineOf(/^> \*\*Answer:\*\*$/);
        const answers = sandbox.mdbIndividualAnswers(LINES, team);
        assert.deepEqual(JSON.parse(JSON.stringify(answers.map((a: Json) => [a.members, a.answer, a.letter]))), [
            [['alice'], '(a)', 'a'],
            [['bob'], '(b) Swiss customers\npay in CHF', 'b'],
        ]);
        const timed = ['> **❓ Q-2 — x:** y?', '> - (a) one', '>', '> **Answer (alice, bob, 2026-11-07T14:05+01:00):** (a)', '> **Answer (2026-11-07T14:05+01:00):** (a)'];
        assert.deepEqual(JSON.parse(JSON.stringify(sandbox.mdbIndividualAnswers(timed, 4).map((a: Json) => a.members))), [['alice', 'bob']], 'the time is not a member; a time-only list is the team answer');
        const two = ['> **❓ Q-1 — a:** a?', '> **Answer (alice):** (a)', '> **Answer:**', '', '> **❓ Q-2 — b:** b?', '> **Answer:**'];
        assert.equal(sandbox.mdbIndividualAnswers(two, 5).length, 0, 'Q-1\'s lines belong to Q-1');
    });

    test('TR-2: the option most chose', () => {
        assert.equal(sandbox.mdbMostChosen([{ members: ['alice', 'bob'], letter: 'b' }, { members: ['carol'], letter: 'a' }]), 'b');
        assert.equal(sandbox.mdbMostChosen([{ members: ['alice'], letter: 'a' }, { members: ['bob'], letter: 'b' }]), '', 'a tie');
        assert.equal(sandbox.mdbMostChosen([{ members: ['alice'], letter: '' }]), '');
    });

    test('TR-3: the open: summary', () => {
        assert.equal(sandbox.mdbOpenSummary([{ members: ['alice'], answer: '(a)' }, { members: ['bob', 'erin'], answer: '(b) Swiss\ncustomers' }], { alice: 'Alice Owner', bob: 'Bob Dev' }),
            'open: Alice Owner (a); Bob Dev, erin (b) Swiss customers');
    });

    test('TR-4: a conflict block', () => {
        const at = lineOf(/⚖️/);
        const c = sandbox.mdbConflictAt(LINES, at);
        assert.equal(c.id, 'X-1');
        assert.equal(c.topic, 'Conflicting changes');
        assert.equal(c.text, 'Limits, paragraph 1');
        assert.equal(c.base, 'The limit is 100 EUR.');
        assert.deepEqual(JSON.parse(JSON.stringify(c.alternatives)), [
            { letter: 'a', members: ['alice'], text: 'The limit is 200 EUR.' },
            { letter: 'b', members: ['bob'], text: 'The limit is 300 EUR.' },
        ]);
        assert.equal(c.decision, '');
        assert.equal(LINES[c.decisionLine], '> **Decision:**');
        assert.equal(c.startLine, at);
        assert.equal(LINES[c.endLine], '', 'the block ends before the blank line');
        assert.equal(c.structural, false);
        assert.equal(sandbox.mdbConflictAt(LINES, 0), null);
        const multi = ['> ⚖️ **X-2 — Conflicting changes:** A, paragraph 0', '> - (base) one', '>   two', '> - (a) **alice, bob:** three', '>   four', '>', '> **Decision:** (a)'];
        const m = sandbox.mdbConflictAt(multi, 0);
        assert.equal(m.base, 'one\ntwo');
        assert.deepEqual(JSON.parse(JSON.stringify(m.alternatives)), [{ letter: 'a', members: ['alice', 'bob'], text: 'three\nfour' }]);
        assert.equal(m.decision, '(a)');
    });

    test('TR-5: deciding a conflict writes the paragraph and removes the block', () => {
        const c = sandbox.mdbConflictAt(LINES, lineOf(/⚖️/));
        const decided = apply(LINES, sandbox.mdbConflictEdit(LINES, c, { letter: 'b' }));
        assert.match(decided, /Intro\.\n\nThe limit is 300 EUR\.\n\nMore text here\./);
        assert.doesNotMatch(decided, /⚖️|100 EUR|Decision/);
        assert.match(apply(LINES, sandbox.mdbConflictEdit(LINES, c, { letter: 'base' })), /\n\nThe limit is 100 EUR\.\n\nMore text here\./);
        assert.match(apply(LINES, sandbox.mdbConflictEdit(LINES, c, { text: 'The limit is 250 EUR.' })), /\n\nThe limit is 250 EUR\.\n\nMore text here\./);
        // A comment between the paragraph and the block stays, and the paragraph above it is replaced.
        const commented = ['# A', '', 'Old text.', '', '> ⬆️ **C-1** (alice): why?', '', '> ⚖️ **X-1 — Conflicting changes:** A, paragraph 0', '> - (base) Old text.', '> - (a) **alice:** New text.', '>', '> **Decision:**', '', 'After.'];
        const cc = sandbox.mdbConflictAt(commented, 6);
        assert.equal(apply(commented, sandbox.mdbConflictEdit(commented, cc, { letter: 'a' })), '# A\n\nNew text.\n\n> ⬆️ **C-1** (alice): why?\n\nAfter.');
        // A whole value: the run of text paragraphs above the block.
        const whole = ['## <!--[RSP]--> Requirements', '', 'First.', '', 'Second.', '', '> ⚖️ **X-1 — Conflicting changes:** RSP/content', '> - (base) First.', '> - (a) **alice:** One paragraph now.', '>', '> **Decision:**'];
        const w = sandbox.mdbConflictAt(whole, 6);
        assert.equal(apply(whole, sandbox.mdbConflictEdit(whole, w, { letter: 'a' })), '## <!--[RSP]--> Requirements\n\nOne paragraph now.', 'the text ends where the block ended');
    });

    test('TR-6: decisions the text cannot take, open:, an unknown letter', () => {
        const field = ['> ⚖️ **X-1 — Conflicting changes:** RSP/header title', '> - (base) Old', '> - (a) **alice:** New', '>', '> **Decision:**'];
        const f = sandbox.mdbConflictAt(field, 0);
        const edit = sandbox.mdbConflictEdit(field, f, { letter: 'a' });
        assert.equal(edit.decisionOnly, true);
        assert.equal(apply(field, edit), field.slice(0, 4).join('\n') + '\n> **Decision:** (a)');
        const structural = ['> ⚖️ **X-2 — Item removed:** RSP/RERE-REQU-LST-2', '> - (base) kept', '> - (a) **bob:** removed', '>', '> **Decision:**'];
        assert.equal(sandbox.mdbConflictEdit(structural, sandbox.mdbConflictAt(structural, 0), { letter: 'base' }).replacement, '> **Decision:** (base)');
        const c = sandbox.mdbConflictAt(LINES, lineOf(/⚖️/));
        const open = sandbox.mdbConflictEdit(LINES, c, { open: 'open: Alice Owner 200; Bob Dev 300' });
        assert.equal(open.decisionOnly, true);
        assert.match(apply(LINES, open), /⚖️[\s\S]*> \*\*Decision:\*\* open: Alice Owner 200; Bob Dev 300\n\nMore text here/);
        assert.equal(sandbox.mdbConflictEdit(LINES, c, { letter: 'z' }), null);
    });

    test('TR-7: member colours', () => {
        const team = ['alice', 'bob'];
        assert.equal(sandbox.mdbMemberColor('alice', team), sandbox.MDB_MEMBER_COLORS[0]);
        assert.equal(sandbox.mdbMemberColor('bob', team), sandbox.MDB_MEMBER_COLORS[1]);
        assert.equal(sandbox.mdbMemberColor('erin', team), sandbox.mdbMemberColor('erin', ['x']), 'a guest\'s colour does not depend on the team');
    });
});
