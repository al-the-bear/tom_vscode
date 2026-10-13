/**
 * Open search cursors for the TomSpecs search tools: the only state in the
 * spec-tool series (every other spec tool loads, acts and forgets).
 *
 * A cursor holds the runtime's SpecQueryCursor over the document as it was
 * loaded, the revision of that load, and how many matches it has handed out.
 * Cursors expire after a quiet period and the number kept is capped; the
 * least recently used one is dropped to make room. An id that expired or was
 * dropped is remembered for a while, so asking for it again says what
 * happened rather than "unknown".
 *
 * vscode-free; the clock is injectable for tests.
 */

import * as crypto from 'crypto';
import type { SpecQueryCursor, SpecQueryInit } from 'tom_som_typescript_runtime';

export const SEARCH_CURSOR_TTL_MS = 10 * 60 * 1000;
export const SEARCH_CURSOR_CAP = 32;
/** How many retired ids are remembered to explain a late iterate. */
const RETIRED_MEMORY = 256;

export interface SearchCursorEntry {
    readonly id: string;
    readonly filePath: string;
    /** The file revision the matches come from. */
    revision: string;
    /** The query as given, to re-run it when the file changes. */
    readonly query: SpecQueryInit;
    cursor: SpecQueryCursor;
    /** Matches handed out so far from {@link cursor}. */
    delivered: number;
    /** All matches {@link cursor} had when it was opened. */
    total: number;
    lastUsed: number;
}

export type SearchCursorLookup =
    | { found: true; entry: SearchCursorEntry }
    | { found: false; reason: 'unknown' | 'expired' | 'evicted' | 'exhausted' };

export class SomSearchCursors {
    private readonly open = new Map<string, SearchCursorEntry>();
    private readonly retired = new Map<string, 'expired' | 'evicted' | 'exhausted'>();

    constructor(
        private readonly now: () => number = Date.now,
        readonly ttlMs: number = SEARCH_CURSOR_TTL_MS,
        readonly cap: number = SEARCH_CURSOR_CAP,
    ) {}

    /** Register a new cursor; drops the least recently used one when the cap is reached. */
    add(init: Omit<SearchCursorEntry, 'id' | 'lastUsed' | 'delivered'>): SearchCursorEntry {
        this.sweep();
        while (this.open.size >= this.cap) {
            let oldest: SearchCursorEntry | undefined;
            for (const e of this.open.values()) {
                if (!oldest || e.lastUsed < oldest.lastUsed) { oldest = e; }
            }
            this.retire(oldest!.id, 'evicted');
        }
        const entry: SearchCursorEntry = { ...init, id: `sc-${crypto.randomBytes(6).toString('hex')}`, delivered: 0, lastUsed: this.now() };
        this.open.set(entry.id, entry);
        return entry;
    }

    /** The open cursor `id`, refreshed; or why there is none. */
    get(id: string): SearchCursorLookup {
        this.sweep();
        const entry = this.open.get(id);
        if (entry) {
            entry.lastUsed = this.now();
            return { found: true, entry };
        }
        return { found: false, reason: this.retired.get(id) ?? 'unknown' };
    }

    /** Close a cursor whose matches have all been handed out. */
    finish(id: string): void {
        this.retire(id, 'exhausted');
    }

    get size(): number {
        this.sweep();
        return this.open.size;
    }

    private sweep(): void {
        const limit = this.now() - this.ttlMs;
        for (const e of [...this.open.values()]) {
            if (e.lastUsed < limit) { this.retire(e.id, 'expired'); }
        }
    }

    private retire(id: string, reason: 'expired' | 'evicted' | 'exhausted'): void {
        if (!this.open.delete(id)) { return; }
        this.retired.set(id, reason);
        if (this.retired.size > RETIRED_MEMORY) {
            this.retired.delete(this.retired.keys().next().value as string);
        }
    }
}
