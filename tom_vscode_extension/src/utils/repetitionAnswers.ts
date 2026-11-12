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
    /** The repetition's turn ended with background work still running (its answer carries the hint): a red chip. */
    backgroundLeft?: true;
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
    backgroundLeft = false,
): void {
    const key = repetitionKeyOf(item, resolve);
    if (!key || !text.trim()) { return; }
    const list = [...(item.repetitionAnswers ?? [])];
    const entry: RepetitionAnswer = { key, text, at: now.toISOString(), ...(backgroundLeft ? { backgroundLeft: true as const } : {}) };
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
        .map((a) => ({ key: String(a.key), text: String(a.text), at: typeof a.at === 'string' ? a.at : '', ...(a['background-left'] === true ? { backgroundLeft: true as const } : {}) }));
    return list.length ? list : undefined;
}

/** The todo-id prefix a walk runs (`<prefix>*` repeat count), or undefined for any other item. */
export function walkPrefixOf(item: { repeatCount?: number | string }): string | undefined {
    const raw = typeof item.repeatCount === 'string' ? item.repeatCount.trim() : '';
    return raw.endsWith('*') && raw.length > 1 ? raw.slice(0, -1) : undefined;
}

/** What the trail lookup reads of a trail entry (trailEditor-handler's TrailEntry). */
export interface TrailAnswerEntry {
    type: string;
    /** Sortable (ISO) timestamp. */
    timestamp: string;
    content: string;
    variables?: string;
}

/**
 * The answers of a walk's repetitions, read back from the quest's session
 * trails — for an item whose answers were not kept (it ran before the queue
 * kept them, or they were lost): every ANSWER entry that reports a todo of the
 * walk (`TODO=<ref>` naming `<prefix><number>…` in `questId`), the latest per
 * todo, in the walk's order (lowest number first). `until` (ISO): only answers
 * up to then (the item's end), when given.
 */
export function repetitionAnswersFromTrail(
    entries: Iterable<TrailAnswerEntry>,
    questId: string,
    prefix: string,
    extractRefs: (variables: string | undefined) => string[],
    parseRef: (ref: string) => { id: string; file: string },
    until?: string,
): RepetitionAnswer[] {
    const latest = new Map<string, RepetitionAnswer>();
    for (const e of entries) {
        if (e.type !== 'ANSWER' || !e.content.trim()) { continue; }
        if (until && e.timestamp.localeCompare(until) > 0) { continue; }
        for (const ref of extractRefs(e.variables)) {
            const parsed = parseRef(ref);
            const file = parsed.file.replace(/\\/g, '/');
            if (questId && !file.includes(`quests/${questId}/`)) { continue; }
            if (!parsed.id.startsWith(prefix) || !/^\d/.test(parsed.id.slice(prefix.length))) { continue; }
            const had = latest.get(parsed.id);
            if (!had || e.timestamp.localeCompare(had.at) > 0) { latest.set(parsed.id, { key: parsed.id, text: e.content, at: e.timestamp }); }
        }
    }
    const num = (id: string): number => parseInt(id.slice(prefix.length), 10);
    return [...latest.values()].sort((a, b) => num(a.key) - num(b.key) || a.key.localeCompare(b.key)).slice(-MAX_REPETITION_ANSWERS);
}
