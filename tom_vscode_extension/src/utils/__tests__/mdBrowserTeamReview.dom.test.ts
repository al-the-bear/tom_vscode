/**
 * The Markdown Browser for consolidating a team review (ccparity_f_teamreview-3; CC-74, CC-71, CC-89,
 * CC-90), in a JSDOM running the real webview script, on a document as the runtime's mergeReviews writes it.
 *
 *   TD-1 author chips: marks, a base mark's votes (✓ / ✗), comment blocks and individual answers carry chips
 *        in the member's colour with the display name the round names; `**Answer (alice):**` is shown as
 *        `Answer (Alice Owner):`, its ids kept in data-members; the user's own answer is still marked
 *   TD-2 the Team popup: a legend of the members (role, guest marked); "only Alice's" dims the others' marks,
 *        comments and answers and leaves them out of the arrows; Everyone undoes it
 *   TD-3 Accept / Reject all of one member's changes posts reviewAuthorChanges
 *   TD-4 a conflict block: a choice per alternative and Keep base; Decide (only after a choice) posts the edit
 *        writing the chosen text into the paragraph and removing the block; Rewrite opens the editor with the
 *        chosen text; Keep open opens it with `open:` and the positions, written as the decision
 *   TD-5 a question the members answered: the team-answer editor opens with the option most chose; Keep open
 *        opens it with `open:` and each member's answer by display name
 *   TD-6 the counter of conflicts, open questions and undecided changes, and Next unresolved stepping through them
 *   TD-7 the revision history (from the SOM reading): each entry's version, date and author, its team and
 *        reviewers, a guest marked
 *   TD-8 a change several members made (`{@alice,bob}`, as the merge writes it) names each of them: a chip
 *        for each, and either member's filter finds it
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { mergeReviews } from 'tom_som_typescript_runtime';

const ROOT = join(__dirname, '..', '..', '..');
const asset = (file: string): string => readFileSync(join(ROOT, 'media', 'markdownBrowser', file), 'utf-8');
const MARKED = readFileSync(join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf-8');
const OVERLAY = readFileSync(join(ROOT, 'media', 'shared', 'mdOverlay.js'), 'utf-8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;

function setup(): { window: Win; posted: Array<Record<string, unknown>> } {
    const body = asset('index.html').split('<body>')[1].split('<script')[0].replace(/\{\{[a-zA-Z]+\}\}/g, '');
    const dom = new JSDOM(`<!DOCTYPE html><head><style>${asset('style.css')}</style></head><body>${body}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const window = dom.window as Win;
    const posted: Array<Record<string, unknown>> = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => posted.push(m), setState: () => undefined });
    window.eval(MARKED);
    window.eval(OVERLAY);
    window.eval(readFileSync(join(ROOT, 'media', 'shared', 'mdQuestions.js'), 'utf-8'));
    window.eval(asset('blocks.js'));
    window.eval(asset('teamReview.js'));
    window.eval(asset('main.js'));
    return { window, posted };
}
const send = (window: Win, msg: Record<string, unknown>): void => { window.dispatchEvent(new window.MessageEvent('message', { data: msg })); };
const FILE = '/ws/round/merged/limits.md';
const show = (window: Win, text: string, memberId = ''): void =>
    send(window, { type: 'mdContent', content: text, filePath: FILE, relativePath: 'round/merged/limits.md', crlf: false, memberId });
const $ = (window: Win, sel: string): Win[] => [...window.document.querySelectorAll(sel)];

const TEAM = [
    { memberId: 'alice', displayName: 'Alice Owner', role: 'Product owner' },
    { memberId: 'bob', displayName: 'Bob Dev', role: 'Developer' },
];
const GUEST = { memberId: 'erin', displayName: 'Erin Ops', role: 'Operations', guest: true };
const BASE = '# Limits\n\nIntro {++ fast ++} text.\n\nThe limit is 100 EUR.\n\nMore text here.\n\n> **❓ Q-1 — Currency:** EUR only?\n> - **(a)** yes\n> - (b) also CHF\n>\n> **Answer:**\n';
/** A merged document: a base mark voted on, a conflict, two answers, a guest's change, and a comment. */
const MERGED: string = mergeReviews(BASE, [
    { ...TEAM[0], document: BASE.replace('{++ fast ++}', 'fast').replace('100', '200').replace('**Answer:**', '**Answer:** (b)') },
    { ...TEAM[1], document: BASE.replace('100', '300').replace('**Answer:**', '**Answer:** (b)').replace('More text here.', 'More text here.\n\n> ⬆️ **C-1** (bob): check the limit') },
    { ...GUEST, document: BASE.replace('More text', 'More, revised, text').replace('**Answer:**', '**Answer:** (a) Swiss') },
], { team: TEAM, date: '2026-11-05', author: 'Alice Owner' }).merged;

function showMerged(window: Win, memberId = ''): void {
    show(window, MERGED, memberId);
    send(window, { type: 'reviewTeam', filePath: FILE, members: [...TEAM, GUEST] });
}

describe('Markdown Browser: consolidating a team review', () => {
    test('TD-1: author chips', () => {
        const { window } = setup();
        showMerged(window, 'alice');
        const vote = $(window, '.mdb-rm[data-votes]')[0];
        assert.ok(vote, 'the base mark keeps its votes: ' + MERGED.split('\n')[2]);
        const voteChips = [...vote.querySelectorAll('.mdb-vote')].map((c: Win) => c.textContent);
        assert.deepEqual(voteChips, ['✓ Alice Owner'], 'alice accepted the base mark');
        const guestMark = $(window, '.mdb-rm[data-authors="erin"] .mdb-chip')[0];
        assert.equal(guestMark.textContent, 'Erin Ops (guest)');
        assert.match(guestMark.title, /erin — Operations — guest/);
        assert.ok(guestMark.style.getPropertyValue('--mdb-member'), 'coloured');
        const comment = $(window, '.mdb-comment-block[data-authors="bob"]')[0];
        assert.equal(comment.querySelector('.mdb-chip').textContent, 'Bob Dev');
        const labels = $(window, 'strong[data-members]');
        assert.deepEqual(labels.map((s) => [s.textContent, s.dataset.members]), [['Answer (Alice Owner, Bob Dev):', 'alice|bob'], ['Answer (Erin Ops (guest)):', 'erin']].map(([t, m]) => [t.replace(' (guest)', ''), m]));
        assert.ok(labels[0].closest('p, li').classList.contains('mdb-own'), 'alice\'s own answer is marked');
        assert.equal($(window, '.mdb-chip-row-answer')[0].querySelectorAll('.mdb-chip').length, 2);
    });

    test('TD-2: the legend and "only Alice\'s"', () => {
        const { window } = setup();
        showMerged(window);
        assert.equal(window.document.getElementById('teamReview').hidden, false);
        window.document.getElementById('teamBtn').click();
        const pop = window.document.getElementById('teamPop');
        assert.equal(pop.hidden, false);
        const rows = [...pop.querySelectorAll('.mdb-team-only')].map((b: Win) => b.textContent);
        assert.deepEqual(rows, ['Alice Owner', 'Bob Dev', 'Erin Ops (guest)']);
        assert.match(pop.textContent, /Product owner[\s\S]*Developer[\s\S]*Operations/);
        pop.querySelector('[data-team-only="erin"]').click();
        assert.equal(window.document.getElementById('teamBtn').textContent, 'Only Erin Ops');
        assert.ok($(window, '.mdb-comment-block[data-authors="bob"]')[0].classList.contains('mdb-team-dim'));
        assert.ok(!$(window, '.mdb-rm[data-authors="erin"]')[0].classList.contains('mdb-team-dim'));
        // The arrows: only Erin's change is left among the changes.
        const boxes = $(window, '#navKindPop input[data-nav-kind]');
        boxes.forEach((b) => { b.checked = b.dataset.navKind === 'changes'; });
        boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.match(window.document.getElementById('navCount').textContent, /\/1$/);
        window.document.getElementById('teamBtn').click();
        window.document.querySelector('#teamPop [data-team-only=""]').click();
        assert.equal($(window, '.mdb-team-dim').length, 0);
        assert.equal(window.document.getElementById('teamBtn').textContent, 'Team');
    });

    test('TD-3: all of one member\'s changes', () => {
        const { window, posted } = setup();
        showMerged(window);
        window.document.getElementById('teamBtn').click();
        const accept = window.document.querySelector('#teamPop [data-team-decide="accept"][data-team-author="erin"]');
        assert.ok(accept, 'erin made a change');
        assert.equal(window.document.querySelector('#teamPop [data-team-decide][data-team-author="bob"]'), null, 'bob made no change mark');
        accept.click();
        assert.deepEqual(posted.filter((m) => m.type === 'reviewAuthorChanges').map((m) => [m.author, m.decision, m.name]), [['erin', 'accept', 'Erin Ops']]);
    });

    test('TD-4: a conflict block', () => {
        const { window, posted } = setup();
        showMerged(window);
        const conflict = $(window, '.mdb-conflict')[0];
        assert.equal(conflict.dataset.open, '1');
        const choices = [...conflict.querySelectorAll('.mdb-conflict-choice')].map((b: Win) => b.textContent.trim());
        assert.deepEqual(choices, ['(a) Alice Owner', '(b) Bob Dev', 'Keep base']);
        const decide = conflict.querySelector('.mdb-conflict-decide');
        assert.equal(decide.disabled, true, 'nothing chosen yet');
        conflict.querySelector('.mdb-conflict-choice[data-choice="b"]').click();
        assert.equal(decide.disabled, false);
        decide.click();
        const edit = posted.filter((m) => m.type === 'applyEdit').pop() as Win;
        assert.equal(edit.replacement.split('\n')[0], 'The limit is 300 EUR.');
        assert.match(edit.expected, /^The limit is 100 EUR\.\n\n> ⚖️ \*\*X-1/);
        assert.doesNotMatch(edit.replacement, /⚖️/);
        // Rewrite starts from the chosen text.
        conflict.querySelector('.mdb-conflict-choice[data-choice="a"]').click();
        conflict.querySelector('.mdb-conflict-rewrite').click();
        assert.equal(window.document.querySelector('.mdb-editor textarea').value, 'The limit is 200 EUR.');
        window.document.querySelector('.mdb-editor .mdb-editor-btn:nth-child(2)').click();
        // Keep open: the positions, by name.
        conflict.querySelector('.mdb-conflict-open').click();
        const area = window.document.querySelector('.mdb-editor textarea');
        assert.equal(area.value, 'open: Alice Owner (a) The limit is 200 EUR.; Bob Dev (b) The limit is 300 EUR.');
        window.document.querySelector('.mdb-editor .mdb-editor-btn').click();
        const open = posted.filter((m) => m.type === 'applyEdit').pop() as Win;
        assert.equal(open.replacement, '> **Decision:** open: Alice Owner (a) The limit is 200 EUR.; Bob Dev (b) The limit is 300 EUR.');
    });

    test('TD-5: the team answer', () => {
        const { window } = setup();
        showMerged(window);
        const answer = $(window, '.mdb-answer-btn')[0];
        assert.equal($(window, '.mdb-answer-btn').length, 2, 'Q-1 and the guest question; Keep open is no answer button');
        answer.click();
        assert.equal(window.document.querySelector('.mdb-editor textarea').value, '(b)', 'alice and bob chose (b), erin (a)');
        window.document.querySelector('.mdb-editor .mdb-editor-btn:nth-child(2)').click();
        $(window, '.mdb-keep-open-btn')[0].click();
        assert.equal(window.document.querySelector('.mdb-editor textarea').value, 'open: Alice Owner, Bob Dev (b); Erin Ops (a) Swiss');
    });

    test('TD-6: what is left, and Next unresolved', () => {
        const { window } = setup();
        showMerged(window);
        const counter = window.document.getElementById('unresolvedCount');
        assert.equal(counter.hidden, false);
        assert.equal(counter.textContent, '1 ⚖ · 2 ? · 2 ±', 'the conflict; Q-1 and the guest question RQ-1; the base mark and erin\'s change');
        const next = window.document.getElementById('nextUnresolvedBtn');
        assert.equal(next.disabled, false);
        next.click();
        const first = window.document.querySelector('.mdb-nav-current');
        assert.ok(first, 'a target is current');
        next.click();
        assert.notEqual(window.document.querySelector('.mdb-nav-current'), first);
    });

    test('TD-7: the revision history', () => {
        const { window } = setup();
        show(window, MERGED);
        send(window, {
            type: 'somComments', filePath: FILE, contentLength: MERGED.length, nextCommentNumber: 2, formFieldRanges: [], questions: {},
            team: TEAM,
            revisions: [{
                version: '0.2.0', date: '2026-11-05', author: 'Alice Owner', summary: 'First team round',
                team: TEAM, reviewers: [TEAM[0], { ...GUEST }],
            }],
        });
        window.document.getElementById('teamBtn').click();
        const entry = window.document.querySelector('#teamPop .mdb-team-revision');
        assert.equal(entry.querySelector('.mdb-team-revision-title').textContent, 'v0.2.0 · 2026-11-05 · Alice Owner — First team round');
        const lines = [...entry.querySelectorAll('.mdb-team-revision-line')].map((l: Win) => l.textContent);
        assert.deepEqual(lines, ['Team: Alice OwnerBob Dev', 'Reviewers: Alice OwnerErin Ops (guest)']);
        assert.ok(entry.querySelector('.mdb-chip-guest'));
    });
    test('TD-8: a change several members made', () => {
        const { window } = setup();
        show(window, '# A\n\nSessions expire after {~~ 30 ~> 15 ~~}{@alice,bob} minutes.\n');
        send(window, { type: 'reviewTeam', filePath: FILE, members: TEAM });
        const mark = $(window, '.mdb-rm[data-kind="change"]')[0];
        assert.equal(mark.dataset.authors, 'alice|bob');
        assert.deepEqual([...mark.querySelectorAll('.mdb-chip')].map((c: Win) => c.textContent), ['Alice Owner', 'Bob Dev']);
        assert.deepEqual(JSON.parse(JSON.stringify(window.mdbAttribution('{@alice,bob +carol}'))).authors, ['alice', 'bob']);
    });
});
