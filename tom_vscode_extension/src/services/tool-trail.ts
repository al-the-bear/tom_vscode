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
const DEFAULT_KEEP_ROUNDS = 2;            // tool-result blocks kept inline; older replaced with stub
const DEFAULT_INLINE_MAX_CHARS = 1000;    // truncation applied to the inline-kept tool_result content

export class ToolTrail {
    private entries: ToolTrailEntry[] = [];
    private nextKeyIndex = 1;
    readonly keepEntries: number;
    readonly previewChars: number;
    readonly maxResultChars: number;
    /** Number of most-recent tool_result blocks kept inline (full text up to
     *  `inlineMaxChars`). Older ones are replaced with `renderStubByKey()`.
     *  Set from `compaction.toolTrailKeepRounds` (or the per-configuration
     *  override). */
    keepRounds: number;
    /** Per-result inline truncation cap. Set from
     *  `compaction.toolTrailMaxResultChars` (or per-config override). */
    inlineMaxChars: number;

    constructor(options?: {
        keepEntries?: number;
        previewChars?: number;
        maxResultChars?: number;
        keepRounds?: number;
        inlineMaxChars?: number;
    }) {
        this.keepEntries = options?.keepEntries ?? DEFAULT_KEEP_ENTRIES;
        this.previewChars = options?.previewChars ?? DEFAULT_PREVIEW_CHARS;
        this.maxResultChars = options?.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
        this.keepRounds = options?.keepRounds ?? DEFAULT_KEEP_ROUNDS;
        this.inlineMaxChars = options?.inlineMaxChars ?? DEFAULT_INLINE_MAX_CHARS;
    }

    /** Apply the configured inline cap to a single tool result, prefixing
     *  with a `[Truncated…]` marker that names the replay key so the model
     *  can fetch the full body via `tomAi_readPastToolResult({key})`. */
    truncateInline(key: string, toolName: string, inputSummary: string, result: string): string {
        if (!result) { return result; }
        if (result.length <= this.inlineMaxChars) { return result; }
        const head = result.slice(0, this.inlineMaxChars);
        return (
            `[Truncated inline view: ${this.inlineMaxChars}/${result.length} chars. ` +
            `Full result available via tomAi_readPastToolResult({"key":"${key}"}). ` +
            `Tool: ${toolName}(${inputSummary})]\n${head}`
        );
    }

    /** Render a one-line stub used to replace older tool_result content when
     *  the round is dropped from the inline window. The model still sees the
     *  `<tool_use, tool_result>` pairing (so the API stays valid) but the
     *  content is just a pointer. */
    renderStubByKey(key: string): string {
        const e = this.getByKey(key);
        if (!e) {
            return `[Past tool call ${key} — full body not retained. Use tomAi_listPastToolCalls to enumerate available keys.]`;
        }
        const status = e.error ? `ERROR: ${e.error}` : `${(e.result ?? '').length} chars`;
        return (
            `[Past tool call ${e.key} — ${e.toolName}(${e.inputSummary}) — ${status}. ` +
            `Use tomAi_readPastToolResult({"key":"${e.key}"}) to retrieve the full result.]`
        );
    }

    /** Convenience overload for callers that have the entry already. */
    renderStub(entry: ToolTrailEntry): string {
        return this.renderStubByKey(entry.key);
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
        // Persist to disk so the entry stays reachable by key after eviction
        // or window reload. The hook is set by the handler at construction
        // time so this module stays decoupled from quest/subsystem details.
        if (this.persistHook) {
            try {
                this.persistHook(full);
            } catch {
                // best-effort; ring buffer remains primary
            }
        }
        return full;
    }

    /** Hook installed by the owning handler so `add()` can durably persist
     *  every entry without the ToolTrail caring about subsystem / quest.
     *  Set via `setPersistHook(fn)` after construction. */
    private persistHook?: (entry: ToolTrailEntry) => void;

    setPersistHook(hook: (entry: ToolTrailEntry) => void): void {
        this.persistHook = hook;
    }

    /**
     * Render the trail as a compact YAML-style block that can be expanded
     * via the `${toolHistory}` placeholder in a profile's system prompt
     * (or user-message template). Emits the most recent `limit` entries;
     * older entries stay in the ring buffer so `readPastToolResult` can
     * still reach them by key.
     *
     * Format (readable block YAML, no mid-entry cut-off — the per-entry
     * preview is placed inside a `|-` block scalar so line breaks in
     * the result are preserved instead of wrapping the host line):
     *
     *   # Tool history — last N calls. Use tomAi_readPastToolResult({ key: "tX" }) for full bodies.
     *   - key: t14
     *     t: 14:32:07
     *     round: 3
     *     tool: tomAi_openFile
     *     input: {path: src/foo.ts}
     *     preview: |-
     *       first N chars of the result,
     *       line breaks preserved
     *
     * Returns `""` when the buffer is empty so the placeholder disappears
     * cleanly on the first turn of a session.
     */
    toSummaryString(limit: number = 25): string {
        if (this.entries.length === 0) {
            return '';
        }
        const slice = limit > 0 && this.entries.length > limit
            ? this.entries.slice(-limit)
            : this.entries;
        const blocks: string[] = [
            `# Tool history — last ${slice.length} of ${this.entries.length} calls. ` +
            `Use tomAi_readPastToolResult({ key: "tX" }) for full bodies.`,
        ];
        for (const e of slice) {
            const previewBody = e.error ? `ERROR: ${e.error}` : this.preview(e.result);
            blocks.push(
                `- key: ${e.key}\n` +
                `  t: ${e.timestamp}\n` +
                `  round: ${e.round}\n` +
                `  tool: ${e.toolName}\n` +
                `  input: ${this.yamlInlineScalar(e.inputSummary)}\n` +
                `  preview: |-\n` +
                this.yamlIndentBlock(previewBody, 4),
            );
        }
        return blocks.join('\n');
    }

    /** Quote an inline scalar only when it needs it — `{...}` / leading-space
     *  strings become double-quoted; plain strings stay unquoted for
     *  readability. Newlines are collapsed to a single space. */
    private yamlInlineScalar(s: string): string {
        const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
        if (oneLine === '') { return '""'; }
        // Quote when the value starts with a character that would otherwise
        // parse as a flow mapping/sequence or reserved YAML indicator.
        if (/^[\s\-?:,\[\]\{\}#&*!|>%@`'"]/.test(oneLine) || oneLine.includes(': ')) {
            return `"${oneLine.replace(/"/g, '\\"')}"`;
        }
        return oneLine;
    }

    /** Indent every line of `body` by `spaces` — no trailing empty line so
     *  the outer join doesn't insert a stray blank between entries. */
    private yamlIndentBlock(body: string, spaces: number): string {
        const pad = ' '.repeat(spaces);
        const lines = (body ?? '').split(/\r?\n/);
        // Drop trailing empty entries so `|-` chomps cleanly.
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }
        if (lines.length === 0) { return `${pad}\n`; }
        return lines.map((l) => `${pad}${l}`).join('\n') + '\n';
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
