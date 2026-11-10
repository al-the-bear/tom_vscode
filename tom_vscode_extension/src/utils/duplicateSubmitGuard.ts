/**
 * The host side of the @CHAT panel's double-click guard: a queue add or a
 * send whose text, transport, profile and template equal one accepted within
 * the last {@link DUPLICATE_WINDOW_MS} is ignored (the panel also pauses the
 * clicked button for 2 s). Queue adds and sends are checked separately — a
 * send right after queuing the same text is not a duplicate.
 *
 * vscode-free.
 */

/** How long an accepted submission blocks an identical one. */
export const DUPLICATE_WINDOW_MS = 3000;

/** What makes two submissions the same. */
export interface SubmissionFields {
    text: string;
    transport?: string;
    profile?: string;
    template?: string;
}

/** One kind of submission (queue adds, sends) with its own memory. */
export class DuplicateSubmitGuard {
    private readonly accepted = new Map<string, number>();

    constructor(private readonly windowMs: number = DUPLICATE_WINDOW_MS) {}

    /**
     * Whether `fields` repeats a submission accepted within the window. A
     * submission that is not a duplicate is recorded as accepted; an ignored
     * one does not extend the window.
     */
    isDuplicate(fields: SubmissionFields, now: number = Date.now()): boolean {
        for (const [k, at] of this.accepted) {
            if (now - at >= this.windowMs) { this.accepted.delete(k); }
        }
        const key = submissionKey(fields);
        if (this.accepted.has(key)) { return true; }
        this.accepted.set(key, now);
        return false;
    }
}

/** The comparison key: the four fields, unset ones as empty strings. */
export function submissionKey(fields: SubmissionFields): string {
    return JSON.stringify([fields.text, fields.transport ?? '', fields.profile ?? '', fields.template ?? '']);
}
