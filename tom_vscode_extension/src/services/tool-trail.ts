/**
 * Tool Trail — in-memory ring buffer of tool calls from the last N prompt
 * rounds. Injected as a plain-text block before every outgoing Anthropic
 * message so the model has immediate context on what it just did.
 *
 * Separate from the persistent raw trail files (those go to disk via
 * TrailService). This structure is never compacted by the LLM — keeping
 * only the last `keepRounds` rounds is what bounds its size.
 */

export interface ToolTrailEntry {
    /** HH:MM:SS wall-clock time of the call. */
    timestamp: string;
    /** Prompt round number (increments per user message). */
    round: number;
    /** Tool name, e.g. `tomAi_readFile`. */
    toolName: string;
    /** Key input fields, truncated to `maxResultChars`. */
    inputSummary: string;
    /** Tool output, truncated to `maxResultChars`. */
    result: string;
    /** Execution time in milliseconds. */
    durationMs: number;
    /** Error message if the call failed. */
    error?: string;
}

export class ToolTrail {
    private entries: ToolTrailEntry[] = [];
    readonly maxResultChars: number;
    readonly keepRounds: number;

    constructor(options?: { maxResultChars?: number; keepRounds?: number }) {
        this.maxResultChars = options?.maxResultChars ?? 500;
        this.keepRounds = options?.keepRounds ?? 2;
    }

    /** Append a new entry, truncating strings to `maxResultChars`. */
    add(entry: ToolTrailEntry): void {
        this.entries.push({
            ...entry,
            inputSummary: this.truncate(entry.inputSummary),
            result: this.truncate(entry.result),
        });
    }

    /**
     * Drop entries whose `round` is older than the last `keepRounds`
     * distinct round values. Called once per exchange so the buffer stays
     * bounded.
     */
    evictOldRounds(): void {
        if (this.entries.length === 0) {
            return;
        }
        const distinctRounds = Array.from(new Set(this.entries.map((e) => e.round)))
            .sort((a, b) => a - b);
        if (distinctRounds.length <= this.keepRounds) {
            return;
        }
        const keepFrom = distinctRounds[distinctRounds.length - this.keepRounds];
        this.entries = this.entries.filter((e) => e.round >= keepFrom);
    }

    /**
     * Render the trail as an injected block for the outgoing prompt.
     * Returns `""` when there are no entries so callers can omit the
     * block entirely.
     */
    toSummaryString(): string {
        if (this.entries.length === 0) {
            return '';
        }
        const lines = this.entries.map((e) => {
            const status = e.error ? `ERROR: ${e.error}` : e.result;
            const compactStatus = status.replace(/\s+/g, ' ').trim();
            return `${e.timestamp} R${e.round} ${e.toolName}(${e.inputSummary})  ${compactStatus}`;
        });
        return `[Tool history — last ${this.keepRounds} prompts]\n${lines.join('\n')}`;
    }

    clear(): void {
        this.entries = [];
    }

    private truncate(s: string): string {
        if (s.length <= this.maxResultChars) {
            return s;
        }
        return s.slice(0, this.maxResultChars);
    }
}
