/**
 * The todo `decisions` model — the list of things the user has to decide
 * before a todo can be started.
 *
 * A todo that is waiting on one of these carries the `decision-needed` status;
 * once every entry has a recorded `decision` the todo can move to
 * `not-started` ({@link answerTodoDecision}). The Q&A page's Decisions tab
 * renders the decisions of the live and archived todos, and answers an open
 * one in place.
 *
 * This module is the gate between hand-written YAML and every reader (the
 * panel, the Q&A page, the MCP tools). Its one hard guarantee is that
 * **every decision it returns has a non-empty `summary`** — the collapsed UI
 * row shows nothing else, and an unlabelled row the user cannot identify is
 * worse than no row at all.
 *
 * Deliberately free of `vscode` imports so it can be unit-tested under
 * `node --test`.
 */

/** One thing the user has to decide before the todo can start. */
export interface TodoDecision {
    /** One-line label — what has to be decided. Always present, never blank. */
    summary: string;
    /** The full question, context and options. */
    decision_needed?: string;
    /** What the user decided. Absent until the decision is made. */
    decision?: string;
}

/** Longest derived summary we keep, so the collapsed row stays one line. */
const MAX_DERIVED_SUMMARY = 120;

/** Trimmed text, or `undefined` when there is nothing to say. */
function text(value: unknown): string | undefined {
    if (typeof value !== 'string') { return undefined; }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Label a decision that came without a summary, using the first line of its
 * `decision_needed`. Truncated because the collapsed row is one line — the
 * full text stays untouched in `decision_needed`.
 */
function deriveSummary(decisionNeeded: string): string {
    const firstLine = decisionNeeded.split('\n')[0].trim();
    return firstLine.length > MAX_DERIVED_SUMMARY
        ? `${firstLine.slice(0, MAX_DERIVED_SUMMARY)}…`
        : firstLine;
}

/** Normalise one raw entry, or `undefined` when it has nothing to say. */
function normaliseOne(raw: unknown): TodoDecision | undefined {
    // A bare string is shorthand for a summary-only decision.
    if (typeof raw === 'string') {
        const summary = text(raw);
        return summary ? { summary } : undefined;
    }
    if (!raw || typeof raw !== 'object') { return undefined; }

    const source = raw as { summary?: unknown; decision_needed?: unknown; decision?: unknown };
    const decisionNeeded = text(source.decision_needed);
    // An explicit summary is the user's own label — never second-guess it.
    const summary = text(source.summary)
        ?? (decisionNeeded ? deriveSummary(decisionNeeded) : undefined);
    if (!summary) { return undefined; }

    const out: TodoDecision = { summary };
    if (decisionNeeded) { out.decision_needed = decisionNeeded; }
    const decision = text(source.decision);
    if (decision) { out.decision = decision; }
    return out;
}

/**
 * Normalise the `decisions` value of a todo as it came off disk.
 *
 * Returns `undefined` — never `[]` — when there is nothing to show, so a todo
 * without decisions does not grow a `decisions: []` key on the next write.
 * Junk entries are dropped individually rather than failing the whole list; a
 * hand-edited YAML file should not lose its good rows to one bad one.
 */
export function normaliseTodoDecisions(raw: unknown): TodoDecision[] | undefined {
    if (!Array.isArray(raw)) { return undefined; }
    const out: TodoDecision[] = [];
    for (const entry of raw) {
        const decision = normaliseOne(entry);
        if (decision) { out.push(decision); }
    }
    return out.length > 0 ? out : undefined;
}

/** True once the user has recorded what they decided. */
export function isDecisionResolved(decision: TodoDecision): boolean {
    return text(decision.decision) !== undefined;
}

/** True when at least one decision is still waiting on the user. */
export function hasUnresolvedDecisions(decisions: TodoDecision[] | undefined): boolean {
    return Array.isArray(decisions) && decisions.some((d) => !isDecisionResolved(d));
}

/** The option letters a decision text offers: `(a)`, `(b)` … in order of first appearance, lower case. */
export function decisionOptionLetters(text: string | undefined): string[] {
    const out: string[] = [];
    for (const m of (text ?? '').matchAll(/(?:^|[\s*_])\(([a-z])\)/gim)) {
        const letter = m[1].toLowerCase();
        if (!out.includes(letter)) { out.push(letter); }
    }
    return out;
}

/** What answering one decision of a todo writes: the whole `decisions` list and, when it was the last open one, the status. */
export interface DecisionAnswerUpdate {
    decisions: TodoDecision[];
    /** `not-started` when the todo was `decision-needed` and no decision is open any more. */
    status?: 'not-started';
}

/**
 * Answer decision `index` of a todo with `answer` (trimmed; the option letter
 * first when the user picked one, `(b) because …`): the decisions with that
 * entry's `decision` set and, when the todo is `decision-needed` and every
 * decision now has its answer, the status `not-started` — the rule the todo
 * tools state (when every decision is answered and the status is
 * `decision-needed`, set it to `not-started` in the same update). Undefined for
 * an unknown index or an empty answer.
 */
export function answerTodoDecision(
    raw: unknown,
    status: string | undefined,
    index: number,
    answer: string,
): DecisionAnswerUpdate | undefined {
    const decisions = normaliseTodoDecisions(raw);
    const text = answer.trim();
    if (!decisions || !text || !Number.isInteger(index) || index < 0 || index >= decisions.length) { return undefined; }
    const next = decisions.map((d, i) => (i === index ? { ...d, decision: text } : d));
    return {
        decisions: next,
        ...(status === 'decision-needed' && !hasUnresolvedDecisions(next) ? { status: 'not-started' as const } : {}),
    };
}
