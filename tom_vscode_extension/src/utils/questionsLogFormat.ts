/**
 * Markdown shapes for the **Questions** journal — `questions.<quest>.md`, one
 * entry per resolved ask-the-user call, shown in the @WS panel's Logs section.
 *
 * The ask tools block a running prompt until the user answers, and until now
 * that exchange left no trace: the question was in the model's tool call and
 * the answer in the tool result, both buried in the per-call trail. The journal
 * makes "what was I asked, and what did I say" a file you can read.
 *
 * Kept free of `vscode` and `fs` so the shape is pinned down by unit tests; the
 * appender (`services/questionsLog.ts`) supplies the paths and the I/O.
 *
 * Timestamps are ISO/UTC, matching `trailService`. The alternative — local time
 * — reads better but the `_ai` folder is shared across a four-machine fleet in
 * different zones, and a journal whose entries are only ordered per-host is not
 * a journal.
 */

/** One resolved ask, as it will be written to the journal. */
export interface QuestionLogEntry {
    /** Tool that asked — `tomAi_askUser` or `tomAi_askUserPicker`. */
    readonly tool: string;
    /** Context line shown above the questions, used as the entry heading. */
    readonly title?: string;
    /** The questions put to the user, in order. May be empty for the picker. */
    readonly questions: readonly string[];
    /** What came back, verbatim — including a timeout's fallback prompt. */
    readonly answer: string;
    /** What resolved the ask: `vscode`, `telegram`, `timeout`, `cancel`, … */
    readonly source: string;
    /** Epoch ms the ask opened. */
    readonly askedAt: number;
    /** Epoch ms it resolved. */
    readonly answeredAt: number;
}

/** `2m 24s` — how long the prompt sat blocked. Clamped at zero. */
export function formatWaited(ms: number): string {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    if (hours > 0) { return `${hours}h ${minutes}m ${seconds}s`; }
    if (minutes > 0) { return `${minutes}m ${seconds}s`; }
    return `${seconds}s`;
}

/** ISO stamp, or the epoch for a value that is not a usable time. */
function stamp(ms: number): string {
    return new Date(Number.isFinite(ms) ? ms : 0).toISOString();
}

/**
 * Block-quote the answer. It is verbatim user text and may carry its own `##`
 * headings; inlined, one of those would be indistinguishable from the heading
 * of the next journal entry.
 */
function quote(answer: string): string {
    if (!answer.trim()) { return '> _(no answer text)_'; }
    return answer
        .replace(/\r\n/g, '\n')
        .replace(/\s+$/, '')
        .split('\n')
        .map(line => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
}

/**
 * One appendable journal entry, ending in a single trailing newline.
 *
 * Every resolution is recorded, not just the answered ones — a timeout or a
 * cancel is exactly the exchange worth reviewing later, and the fallback prompt
 * a timeout produced *is* what the model received.
 */
export function formatQuestionLogEntry(e: QuestionLogEntry): string {
    const heading = e.title?.trim() ? e.title.trim() : e.tool;
    const lines = [
        `## ${stamp(e.askedAt)} — ${heading}`,
        '',
        `- **Tool:** \`${e.tool}\``,
        `- **Answered:** ${stamp(e.answeredAt)} via ${e.source}, after ${formatWaited(e.answeredAt - e.askedAt)}`,
        '',
    ];
    if (e.questions.length > 0) {
        lines.push('### Questions', '');
        e.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
        lines.push('');
    }
    lines.push('### Answer', '', quote(e.answer), '');
    return lines.join('\n');
}

/** Preamble written once, when the journal file is first created. */
export function questionsLogHeader(questId: string): string {
    return [
        `# Questions — ${questId}`,
        '',
        'Every question the ask-the-user tools put to you, with the answer that',
        'came back — including the ones resolved by a timeout or a cancel.',
        'Appended to: the newest entry is at the bottom.',
        '',
        '',
    ].join('\n');
}
