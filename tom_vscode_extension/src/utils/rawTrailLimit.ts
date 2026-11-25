/**
 * The raw trail's file limit, `trail.raw.maxRawFiles`: the raw trail files (prompt, answer, payload, tool request
 * and tool answer, and the `compaction/` / `memory/` categories) kept per folder before the oldest are deleted
 * (TrailService.pruneRawTrailDir). One key, read and written here: the trail service prunes with it and the
 * Status Page shows and saves it.
 *
 * Older configs (and older Status Pages) wrote the flat `trail.maxRawFiles`; it is read when `trail.raw` has no
 * value, and a save moves it under `raw`.
 */

/** The default of `trail.raw.maxRawFiles`. */
export const RAW_TRAIL_DEFAULT_MAX_FILES = 1000;

const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1;

/** `trail.raw.maxRawFiles`, else the flat `trail.maxRawFiles` of an older config, else the default. */
export function rawTrailMaxFiles(trail: unknown): number {
    const t = (trail ?? {}) as { raw?: { maxRawFiles?: unknown }; maxRawFiles?: unknown };
    if (valid(t.raw?.maxRawFiles)) { return Math.floor(t.raw!.maxRawFiles as number); }
    if (valid(t.maxRawFiles)) { return Math.floor(t.maxRawFiles); }
    return RAW_TRAIL_DEFAULT_MAX_FILES;
}

/**
 * Write `value` as `trail.raw.maxRawFiles` into a trail config section (created when missing) and drop the flat
 * key of older configs, so the two can never disagree. A value that is no whole number ≥ 1 changes nothing.
 */
export function setRawTrailMaxFiles<T extends Record<string, unknown>>(trail: T, value: unknown): T {
    if (!valid(value)) { return trail; }
    const t = trail as Record<string, unknown> & { raw?: Record<string, unknown> };
    t.raw = { ...(t.raw && typeof t.raw === 'object' ? t.raw : {}), maxRawFiles: Math.floor(value) };
    delete t.maxRawFiles;
    return trail;
}
