/**
 * The todo schema's date fields, and the six orchestration fields, as the
 * extension writes them (wonetestd7).
 *
 * `_ai/schemas/yaml/todo.schema.json` types `due`, `created`, `updated`,
 * `completed_date`, `archived` and `deleted` as `format: date`. The writers
 * took a caller's value verbatim, so timestamps such as
 * `2026-10-20T12:37:25+0200` reached the corpus, and the shared todo model
 * (Worktracker's TomTodo, which the Webwork todo-file editor uses too) refuses
 * every such todo. Here a timestamp is written as the date it names — in its
 * own offset, the date the person writing it meant — and anything that is not
 * a date is refused before a write.
 *
 * vscode-free.
 */

/** Every field the todo schema declares `format: date`. */
export const TODO_DATE_FIELDS = ['due', 'created', 'updated', 'completed_date', 'archived', 'deleted'] as const;
export type TodoDateField = (typeof TODO_DATE_FIELDS)[number];

/**
 * The orchestration fields the schema gained for Worktracker (optional strings):
 * who executes, who checks, who orchestrates, the execution bundle, the todo it
 * was derived from, the feedback that raised it.
 */
export const TODO_ORCHESTRATION_FIELDS = [
    'execution_role', 'qa_role', 'orchestration_role', 'bundle_id', 'derived_from', 'feedback_source',
] as const;
export type TodoOrchestrationField = (typeof TODO_ORCHESTRATION_FIELDS)[number];

/** `YYYY-MM-DD`, optionally followed by a time (`T` or a blank, then `HH:MM…` and an offset). */
const DATE_OR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The date to write for `field`: a date as it is, a timestamp as the date it
 * names (its own offset, never converted to UTC). `''` and `undefined` mean
 * "no value" and are passed through — the writers clear or skip on them.
 *
 * @throws when the value is not a date or a timestamp, naming field and value.
 */
export function toTodoDate(field: string, value: string): string;
export function toTodoDate(field: string, value: string | undefined): string | undefined;
export function toTodoDate(field: string, value: string | undefined): string | undefined {
    if (value === undefined || value === '') { return value; }
    const text = String(value).trim();
    const m = DATE_OR_TIMESTAMP.exec(text);
    if (m) {
        const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const probe = new Date(Date.UTC(year, month - 1, day));
        if (probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day) {
            return `${m[1]}-${m[2]}-${m[3]}`;
        }
    }
    throw new Error(
        `\`${field}\` must be a date (YYYY-MM-DD), as the todo schema declares it; got ${JSON.stringify(value)}. `
        + 'A timestamp is accepted and written as the date it names (2026-10-20T12:37:25+0200 → 2026-10-20).',
    );
}

/** `date` as `YYYY-MM-DD` in local time — the day the person at the machine is on. */
export function localDateOf(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, local time: what `created`, `updated` and a completion stamp record. */
export function todayLocalDate(): string {
    return localDateOf(new Date());
}

/**
 * `record` with every date field it carries written as a date (see
 * {@link toTodoDate}); other keys untouched. Returns a new object.
 *
 * @throws on the first field that is not a date.
 */
export function withTodoDates<T extends Record<string, unknown>>(record: T): T {
    const out: Record<string, unknown> = { ...record };
    for (const field of TODO_DATE_FIELDS) {
        const value = out[field];
        if (typeof value === 'string') { out[field] = toTodoDate(field, value); }
    }
    return out as T;
}
