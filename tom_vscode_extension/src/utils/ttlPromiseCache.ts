/**
 * Share one asynchronous load between callers: a caller asking for a key
 * while its load runs, or within `ttlMs` after it finished, gets that load's
 * promise instead of starting another. A load that fails is forgotten, so the
 * next caller tries again. Used for the workspace walks several panels ask
 * for at once when a window opens.
 */
export class TtlPromiseCache<T> {
    private readonly entries = new Map<string, { finishedAt: number; result: Promise<T> }>();

    constructor(
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** The cached result for `key`, or `load()`'s; `fresh` always loads. */
    get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
        const cached = this.entries.get(key);
        // While the load runs `finishedAt` is +Infinity: the difference is
        // -Infinity, so concurrent callers share the running load.
        if (!fresh && cached && this.now() - cached.finishedAt < this.ttlMs) {
            return cached.result;
        }
        const entry = { finishedAt: Number.POSITIVE_INFINITY, result: load() };
        this.entries.set(key, entry);
        entry.result.then(
            () => { entry.finishedAt = this.now(); },
            () => { if (this.entries.get(key) === entry) { this.entries.delete(key); } },
        );
        return entry.result;
    }

    clear(): void {
        this.entries.clear();
    }
}
