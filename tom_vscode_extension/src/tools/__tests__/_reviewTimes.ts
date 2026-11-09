/**
 * Change times in review annotations (SOM §11.9.10). Every write of a comment or
 * a change comment records when it was made — `(Eve, 2026-11-09T17:57+01:00)` in
 * a comment block's header, `{@2026-11-09T17:57+01:00}` or
 * `{@agent_spec_author 2026-11-09T17:57+01:00}` after an inline comment — from the
 * system clock in the writer's offset. Tests take the clock reading before the
 * write and compare the written text with the times replaced by `<time>`.
 */

import assert from 'node:assert/strict';
import { systemReviewTime } from 'tom_som_typescript_runtime';

/** A change time anywhere in a text. */
const CHANGE_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * `text` with every change time replaced by `<time>`, after asserting each is
 * the system clock's reading at a minute between `since` and now — the time the
 * write recorded, not a fixed or stale one.
 */
export function withoutChangeTimes(text: string, since: Date): string {
    const allowed = new Set<string>();
    const end = Date.now();
    for (let t = since.getTime() - 60_000; t <= end + 60_000; t += 30_000) {
        allowed.add(systemReviewTime(new Date(t)));
    }
    return text.replace(CHANGE_TIME, (time) => {
        assert.ok(allowed.has(time), `${time} is not the clock's time during the write (${[...allowed].join(', ')})`);
        return '<time>';
    });
}
