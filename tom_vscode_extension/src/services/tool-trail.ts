/**
 * Tool Trail — in-memory ring buffer of tool calls for the active Anthropic
 * session. Two purposes:
 *
 *  1. **Injected summary block.** `toSummaryString()` renders a compact
 *     one-line-per-call view that the handler prepends to every outgoing
 *     user message so the model has immediate context on what it just
 *     did. Each line carries a short `key` that can be fed back through
 *     the `tomAi_readPastToolResult` tool to retrieve the full result.
 *
 *  2. **Pull source for past-tool-access tools.** The full result bodies
 *     are retained (capped per-entry) so `tomAi_listPastToolCalls`,
 *     `tomAi_searchPastToolResults`, and `tomAi_readPastToolResult` can
 *     look calls up by key without reading the raw trail files off disk.
 *
 * Separate from the persistent raw trail files (those go to disk via
 * TrailService). This structure is session-scoped and never survives a
 * window reload; keep that in mind when deciding which tool surface to
 * use from the agent's side.
 */

export interface ToolTrailEntry {
    /** Short stable key, e.g. `t14`. The key embeds the call's position in
     *  the session so the model can pass it back to readPastToolResult. */
    key: string;
    /** HH:MM:SS wall-clock time of the call. */
    timestamp: string;
    /** Prompt round number (increments per user message). */
    round: number;
    /** Tool name, e.g. `tomAi_readFile`. */
    toolName: string;
    /** Key input fields (short summary — used in the prefix block). */
    inputSummary: string;
    /** Tool output. Full body, not truncated — readPastToolResult returns
     *  this verbatim. Callers that want a short preview use `preview()`. */
    result: string;
    /** Execution time in milliseconds. */
    durationMs: number;
    /** Error message if the call failed. */
    error?: string;
}

const DEFAULT_KEEP_ENTRIES = 40;
const DEFAULT_PREVIEW_CHARS = 500;
const DEFAULT_MAX_RESULT_CHARS = 100_000; // hard cap per entry so a runaway tool result can't blow memory

export class ToolTrail {
    private entries: ToolTrailEntry[] = [];
    private nextKeyIndex = 1;
    readonly keepEntries: number;
    readonly previewChars: number;
    readonly maxResultChars: number;

    constructor(options?: {
        keepEntries?: number;
        previewChars?: number;
        maxResultChars?: number;
    }) {
        this.keepEntries = options?.keepEntries ?? DEFAULT_KEEP_ENTRIES;
        this.previewChars = options?.previewChars ?? DEFAULT_PREVIEW_CHARS;
        this.maxResultChars = options?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    }

    /**
     * Append a new entry. The entry's `key` is assigned here so the
     * caller doesn't have to coordinate with anyone else. Result bodies
     * are clipped to `maxResultChars` so a runaway tool result can't
     * blow out memory; the short summary in `toSummaryString()` is
     * truncated further to `previewChars`.
     */
    add(entry: Omit<ToolTrailEntry, 'key'>): ToolTrailEntry {
        const full: ToolTrailEntry = {
            ...entry,
            key: `t${this.nextKeyIndex++}`,
            result: this.clip(entry.result),
        };
        this.entries.push(full);
        // Trim from the front once we cross the cap so the buffer stays
        // bounded on long sessions. Oldest-first eviction matches what
        // users expect when scrolling back through a chat.
        while (this.entries.length > this.keepEntries) {
            this.entries.shift();
        }
        return full;
    }

    /**
     * Render the trail as the injected block for the outgoing prompt.
     * Each line:
     *
     *   HH:MM:SS  [key]  R<round>  toolName(inputSummary) → preview
     *
     * Returns `""` when there are no entries so callers can omit the
     * block entirely.
     */
    toSummaryString(): string {
        if (this.entries.length === 0) {
            return '';
        }
        const lines = this.entries.map((e) => {
            const status = e.error ? `ERROR: ${e.error}` : this.preview(e.result);
            const compactStatus = status.replace(/\s+/g, ' ').trim();
            return `${e.timestamp} [${e.key}] R${e.round} ${e.toolName}(${e.inputSummary}) → ${compactStatus}`;
        });
        return [
            `[Tool history — last ${this.entries.length} calls; read full bodies via tomAi_readPastToolResult({ key })]`,
            ...lines,
        ].join('\n');
    }

    /** The key that the next `add()` call will assign. Lets callers
     *  reference an entry in a log line *before* the actual tool
     *  execution completes (e.g. the live-trail emits the tool_use
     *  event before runTool finishes). */
    peekNextKey(): string {
        return `t${this.nextKeyIndex}`;
    }

    /** Lookup by key (for `tomAi_readPastToolResult`). */
    getByKey(key: string): ToolTrailEntry | undefined {
        return this.entries.find((e) => e.key === key);
    }

    /** Shallow copy of the buffer (for `tomAi_listPastToolCalls` + search). */
    listEntries(): ToolTrailEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
        this.nextKeyIndex = 1;
    }

    private preview(s: string): string {
        return s.length <= this.previewChars ? s : s.slice(0, this.previewChars);
    }

    private clip(s: string): string {
        return s.length <= this.maxResultChars ? s : s.slice(0, this.maxResultChars) + '\n…(trimmed by ToolTrail maxResultChars)';
    }
}

// ============================================================================
// Module-level singleton pointer
// ============================================================================

/**
 * The Anthropic handler registers its own ToolTrail here at construction
 * time; the past-tool-access tools (list/search/read) fetch it via
 * `getActiveToolTrail()` without importing the handler module directly
 * (avoids a circular dep with tool-executors.ts).
 */
let _activeToolTrail: ToolTrail | undefined;

export function setActiveToolTrail(trail: ToolTrail): void {
    _activeToolTrail = trail;
}

export function getActiveToolTrail(): ToolTrail | undefined {
    return _activeToolTrail;
}
