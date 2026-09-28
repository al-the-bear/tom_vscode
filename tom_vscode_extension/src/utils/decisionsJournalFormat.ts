/**
 * Markdown shapes for the **Decisions** journal — `decisions.<quest>.md`, one
 * entry per archived *completed* todo that carried decisions, shown in the @WS
 * panel's Logs section next to the Questions journal. (`todoArchive.ts` owns
 * that eligibility rule; this module formats whatever it is handed.)
 *
 * A todo holds its open questions in `decisions[]` while it is alive. Archiving
 * moves the todo out of the active file, and with it the record of what was
 * decided and why — which is the part worth keeping longest. The journal is the
 * copy that stays behind: the todo id, when it was archived, and every decision
 * including the ones that were never answered.
 *
 * Kept free of `vscode` and `fs` so the shape is pinned down by unit tests; the
 * appender (`todoArchive.ts`) supplies the paths and the I/O.
 *
 * Timestamps are ISO/UTC, matching `questionsLogFormat` and `trailService`: the
 * `_ai` folder is shared across a four-machine fleet in different zones, and a
 * journal whose entries are only ordered per-host is not a journal.
 */

import type { TodoDecision } from './todoDecisions.js';

/** One archived todo's decisions, as they will be written to the journal. */
export interface DecisionJournalEntry {
    /** Id of the todo the decisions belonged to. */
    readonly todoId: string;
    /** The todo's title (or description), used to make the id readable. */
    readonly title?: string;
    /** The decisions, in the order they were listed on the todo. */
    readonly decisions: readonly TodoDecision[];
    /** Epoch ms the todo was archived. */
    readonly archivedAt: number;
}

/** Indentation that keeps a continuation line inside its `- ` bullet. */
const BULLET_CONTINUATION = '     ';

/** ISO stamp, or the epoch for a value that is not a usable time. */
function stamp(ms: number): string {
    return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * Fold a possibly multi-line value onto one bullet. A raw newline would close
 * the list item and let the continuation render as a sibling of the next
 * decision — silently reattributing an answer to the wrong question.
 */
function inline(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .trim()
        .split('\n')
        .join(`\n${BULLET_CONTINUATION}`);
}

/** `1. **summary**` plus its question and answer bullets. */
function decisionLines(decision: TodoDecision, index: number): string[] {
    const lines = [`${index + 1}. **${decision.summary}**`];
    if (decision.decision_needed?.trim()) {
        lines.push(`   - **Needed:** ${inline(decision.decision_needed)}`);
    }
    lines.push(decision.decision?.trim()
        ? `   - **Decided:** ${inline(decision.decision)}`
        // Archiving with the question still open is a real outcome, and the one
        // most worth being able to find again.
        : '   - **Decided:** _(not decided)_');
    return lines;
}

/**
 * One appendable journal entry, ending in a single trailing newline.
 *
 * A todo with no decisions produces the empty string, so the caller can hand
 * every archived todo over and let the formatter decide what is worth writing.
 */
export function formatDecisionJournalEntry(entry: DecisionJournalEntry): string {
    if (entry.decisions.length === 0) { return ''; }
    const title = entry.title?.trim();
    const heading = title ? `\`${entry.todoId}\` — ${title}` : `\`${entry.todoId}\``;
    const lines = [`## ${stamp(entry.archivedAt)} — ${heading}`, ''];
    entry.decisions.forEach((decision, i) => {
        lines.push(...decisionLines(decision, i));
    });
    lines.push('');
    return lines.join('\n');
}

/** Preamble written once, when the journal file is first created. */
export function decisionsJournalHeader(questId: string): string {
    return [
        `# Decisions — ${questId}`,
        '',
        'What was decided on the todos of this quest, copied here when each todo',
        'was archived so the reasoning outlives the todo. Only todos that reached',
        '`completed` are recorded — one archived half-done was abandoned, not',
        'concluded. Entries that say _(not decided)_ were archived with the',
        'question still open.',
        'Appended to: the newest entry is at the bottom.',
        '',
        '',
    ].join('\n');
}
