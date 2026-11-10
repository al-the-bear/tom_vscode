/**
 * Whether a save of the todo detail form would change anything: the panel
 * skips the write (and answers saved) when it would not. Every field the form
 * sends is compared — a field left out of this list is a field whose change
 * alone is never written, which is how "Your to do" (`user_action`) could be
 * ticked but no longer unticked.
 */

/** The fields of the detail form, as `qtSaveTodo` sends them. */
export const TODO_FORM_FIELDS = [
    'title', 'status', 'priority', 'description', 'tags', 'dependencies', 'blocked_by', 'notes', 'scope',
    'references', 'decisions', 'created', 'completed_date', 'completed_by', 'user_action', 'repeat',
] as const;

/** Absent, null, '' and [] are the same: no value. */
function normalise(value: unknown): unknown {
    if (value === undefined || value === null || value === '') { return null; }
    if (Array.isArray(value) && value.length === 0) { return null; }
    return value;
}

/** JSON with every object's keys sorted, so key order does not count. */
function canonical(value: unknown): string {
    return JSON.stringify(normalise(value), (_key, v: unknown) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { return v; }
        const o = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    });
}

/**
 * True when `form` (the detail form's values, `decisions` already normalised
 * as the writer stores them) holds nothing that differs from `current`.
 * `user_action` is a flag: absent and false agree, and a form without the
 * checkbox (undefined) changes nothing.
 */
export function todoFormUnchanged(current: Record<string, unknown>, form: Record<string, unknown>): boolean {
    return TODO_FORM_FIELDS.every((field) => {
        if (field === 'user_action') {
            return form.user_action === undefined || (current.user_action === true) === (form.user_action === true);
        }
        // A form without the Repeat section (undefined) changes nothing; null clears the rule.
        if (field === 'repeat' && form.repeat === undefined) { return true; }
        return canonical(current[field]) === canonical(form[field]);
    });
}
