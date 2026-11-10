/**
 * Deciding inline review marks (CriticMarkup, SOM §11.9.3) in Markdown text
 * through the TomSpecs runtime's annot4 API — what the Markdown Browser's
 * accept / reject / remove buttons do. The text (a block, or a whole file) is
 * held as one content value of a scratch `SpecDocument`, so the runtime's own
 * rules decide what the text becomes: accepted changes stay, rejected ones are
 * undone, a removed comment leaves the text it was on, and the whitespace rules
 * hold. Any Markdown file works this way, a TomSpecs document or not, and a
 * SOM document that loads read-only (parse rejections) too: only the marks'
 * text changes.
 *
 * vscode-free.
 */

import { SpecDocument, SpecMarkDecision, SpecReviewAnnotations, type SpecMarkDecisionValue } from 'tom_som_typescript_runtime';

import { applyMdLineEdit, type MdLineEditResult } from '../utils/markdownBrowserEdits';

const SCRATCH = 'text';

/** The kinds that are changes; highlights and comments are not. */
const CHANGE_KINDS = new Set<string>(['insertion', 'deletion', 'substitution']);

function scratch(text: string): { doc: SpecDocument; notes: SpecReviewAnnotations } {
    const doc = new SpecDocument();
    doc.setContent(SCRATCH, text);
    return { doc, notes: new SpecReviewAnnotations(doc) };
}

export type MarkDecisionResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * `text` with one mark decided: the `occurrence`-th (0-based) mark whose markup
 * is `markup`. `accept` takes a change (and removes a highlight or a comment,
 * keeping the text it was on); `reject` undoes a change.
 */
export function decideMark(
    text: string,
    mark: { markup: string; occurrence: number; decision: 'accept' | 'reject' },
): MarkDecisionResult {
    const { doc, notes } = scratch(text);
    const same = notes.listMarks().filter((m) => m.markup === mark.markup);
    const entry = same[mark.occurrence];
    if (!entry) {
        return { ok: false, reason: `The mark ${mark.markup} is not in the text (any more). Reload the document.` };
    }
    const decision: SpecMarkDecisionValue = mark.decision === 'accept' ? SpecMarkDecision.ACCEPT : SpecMarkDecision.REJECT;
    notes.decideMarks({ [entry.id]: decision }, { revision: notes.revision() });
    return { ok: true, text: doc.content(SCRATCH) ?? '' };
}

/**
 * `text` with a comment written through the runtime (SOM §11.9.3): `comment`
 * puts a change comment, quoting the change, right after the
 * `occurrence`-th change mark whose markup is `markup` (`commentChange`);
 * `edit` replaces the comment of a comment mark, a change comment (its quote
 * kept) or a commented highlight (`editMarkComment`). The runtime refuses an
 * empty text, one holding a mark delimiter or a blank line, a change that has
 * its comment already and a mark that is not a change (comment) or holds no
 * comment (edit); its reason is passed on.
 */
export function commentMark(
    text: string,
    mark: { markup: string; occurrence: number; op: 'comment' | 'edit'; comment: string },
): MarkDecisionResult {
    const { doc, notes } = scratch(text);
    const entry = notes.listMarks().filter((m) => m.markup === mark.markup)[mark.occurrence];
    if (!entry) {
        return { ok: false, reason: `The mark ${mark.markup} is not in the text (any more). Reload the document.` };
    }
    try {
        if (mark.op === 'comment') {
            notes.commentChange(entry.id, mark.comment.trim(), { revision: notes.revision() });
        } else {
            notes.editMarkComment(entry.id, mark.comment.trim(), { revision: notes.revision() });
        }
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, text: doc.content(SCRATCH) ?? '' };
}

/**
 * `text` with every change mark accepted or rejected; highlights and comments
 * stay for their own decision, and a change's comment records the outcome.
 */
export function decideAllChanges(text: string, decision: 'accept' | 'reject'): { text: string; decided: number } {
    const { doc, notes } = scratch(text);
    const changes = notes.listMarks().filter((m) => CHANGE_KINDS.has(m.markKind));
    if (changes.length === 0) { return { text, decided: 0 }; }
    const value: SpecMarkDecisionValue = decision === 'accept' ? SpecMarkDecision.ACCEPT : SpecMarkDecision.REJECT;
    notes.decideMarks(Object.fromEntries(changes.map((m) => [m.id, value])), { revision: notes.revision() });
    return { text: doc.content(SCRATCH) ?? '', decided: changes.length };
}

/**
 * `text` with every change mark `author` made (its attribution token names
 * them, alone or with others, SOM §11.9.8) accepted or rejected — "accept all
 * of Bob's". Votes do not count as authorship; other marks stay.
 */
export function decideAuthorChanges(text: string, author: string, decision: 'accept' | 'reject'): { text: string; decided: number } {
    const { doc, notes } = scratch(text);
    const changes = notes.listMarks().filter((m) => CHANGE_KINDS.has(m.markKind) && m.authors.includes(author));
    if (changes.length === 0) { return { text, decided: 0 }; }
    const value: SpecMarkDecisionValue = decision === 'accept' ? SpecMarkDecision.ACCEPT : SpecMarkDecision.REJECT;
    notes.decideMarks(Object.fromEntries(changes.map((m) => [m.id, value])), { revision: notes.revision() });
    return { text: doc.content(SCRATCH) ?? '', decided: changes.length };
}

/**
 * `fileText` with one mark of a block decided, for the Markdown Browser: lines
 * `startLine..endLine` must still hold `expected` (what the browser showed);
 * the decided block replaces them. `remove` takes a comment or a highlight's
 * comment out, the text it was on staying; `comment` and `edit` write `text`
 * (commentMark).
 */
export function reviewMarkEdit(
    fileText: string,
    edit: {
        startLine: number; endLine: number; expected: string; markup: string; occurrence: number;
        decision: 'accept' | 'reject' | 'remove' | 'comment' | 'edit';
        /** For `comment` and `edit`: the comment's text. */
        text?: string;
    },
): MdLineEditResult {
    const check = applyMdLineEdit(fileText, { startLine: edit.startLine, endLine: edit.endLine, expected: edit.expected, replacement: edit.expected });
    if (!check.ok) { return check; }
    const block = edit.expected.replace(/\r\n/g, '\n');
    const decided = edit.decision === 'comment' || edit.decision === 'edit'
        ? commentMark(block, { markup: edit.markup, occurrence: edit.occurrence, op: edit.decision, comment: edit.text ?? '' })
        : decideMark(block, { markup: edit.markup, occurrence: edit.occurrence, decision: edit.decision === 'reject' ? 'reject' : 'accept' });
    if (!decided.ok) { return decided; }
    return applyMdLineEdit(fileText, { startLine: edit.startLine, endLine: edit.endLine, expected: edit.expected, replacement: decided.text });
}
