/**
 * The answers of every repetition of a repeated queue item.
 *
 * `answerText` holds the main prompt's latest answer, which each repetition
 * replaces. A repeated item also keeps one answer per repetition
 * (`repetitionAnswers`), so the queue editor can show any of them by a chip
 * under its Answer: the todo's id for a todo walk (`<prefix>*` repeat count),
 * the repetition's number for a counted repetition (repeat count, else template
 * repeat count). A repetition answered again (a resend) replaces its entry, in its place.
 *
 * vscode-free.
 */

/** One repetition's answer. */
export interface RepetitionAnswer {
    /** The todo id (a walk) or the repetition number (`3`). */
    key: string;
    /** The main prompt's answer of that repetition. */
    text: string;
    /** When it was recorded (ISO). */
    at: string;
}

/** What this module reads and writes of a queue item. */
export interface RepeatedItem {
    repeatCount?: number | string;
    repeatIndex?: number;
    repeatTodoId?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
    repetitionAnswers?: RepetitionAnswer[];
}

/** The most repetitions an item keeps answers for (the oldest go first). */
export const MAX_REPETITION_ANSWERS = 200;

function countOf(raw: number | string | undefined, resolve: (raw: number | string | undefined) => number): number {
    return typeof raw === 'string' && raw.trim().endsWith('*') ? 0 : resolve(raw);
}

/**
 * The key of the repetition `item` is in: the walked todo's id, else its
 * repetition number (1-based) when it repeats, else its template repetition
 * number; undefined for an item that does not repeat. `resolve` reads a
 * repeat count (a number or a chat-variable name).
 */
export function repetitionKeyOf(item: RepeatedItem, resolve: (raw: number | string | undefined) => number): string | undefined {
    if (typeof item.repeatCount === 'string' && item.repeatCount.trim().endsWith('*')) {
        return item.repeatTodoId || undefined;
    }
    if (countOf(item.repeatCount, resolve) > 1 && (item.repeatIndex ?? 0) > 0) { return String(item.repeatIndex); }
    if (countOf(item.templateRepeatCount, resolve) > 1 && (item.templateRepeatIndex ?? 0) > 0) { return String(item.templateRepeatIndex); }
    return undefined;
}

/** Record `text` as the answer of the repetition `item` is in (nothing for an item that does not repeat). */
export function recordRepetitionAnswer(
    item: RepeatedItem,
    text: string,
    resolve: (raw: number | string | undefined) => number,
    now: Date = new Date(),
): void {
    const key = repetitionKeyOf(item, resolve);
    if (!key || !text.trim()) { return; }
    const list = [...(item.repetitionAnswers ?? [])];
    const entry = { key, text, at: now.toISOString() };
    const at = list.findIndex((a) => a.key === key);
    if (at >= 0) { list[at] = entry; } else { list.push(entry); }
    item.repetitionAnswers = list.slice(-MAX_REPETITION_ANSWERS);
}

/** The `repetition-answers` list of a queue entry file, read back; undefined when there is none. */
export function repetitionAnswersFromYaml(raw: unknown): RepetitionAnswer[] | undefined {
    if (!Array.isArray(raw)) { return undefined; }
    const list = raw
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => (typeof a.key === 'string' || typeof a.key === 'number') && typeof a.text === 'string')
        .map((a) => ({ key: String(a.key), text: String(a.text), at: typeof a.at === 'string' ? a.at : '' }));
    return list.length ? list : undefined;
}
