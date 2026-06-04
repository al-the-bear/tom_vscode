/**
 * Two-tier memory service for the Anthropic handler and the memory panel.
 *
 * Spec: anthropic_sdk_integration.md §5 (memory system), §5.1 (scope
 * split), §5.2 (system-prompt injection), §11.2 (Memory Panel API).
 *
 * Tiers:
 *   - shared: `_ai/memory/shared/`       — workspace-wide facts
 *   - quest:  `_ai/memory/{quest}/`       — per-quest facts
 *
 * All write operations are idempotent (a re-run with the same content
 * yields the same file state) and create their parent directory on first
 * use. Reads return `""` for absent files so callers don't have to check.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FsUtils } from '../utils/fsUtils';
import { WsPaths } from '../utils/workspacePaths';
import { ChatVariablesStore } from '../managers/chatVariablesStore';

export type MemoryScope = 'quest' | 'shared';
export type MemoryReadScope = MemoryScope | 'all';

export interface MemoryListEntry {
    scope: MemoryScope;
    file: string;
    bytes: number;
    mtime: number;
}

export interface MemoryInjection {
    /** Formatted block ready to paste into the system prompt. Empty when nothing to inject. */
    text: string;
    /** Rough token count of `text`. */
    tokens: number;
    /** Files included in this snapshot, in the order they appear in `text`. */
    included: MemoryListEntry[];
}

const DEFAULT_MAX_INJECTED_TOKENS = 3000;
// Rough estimate: 1 token ≈ 4 chars of English prose. Compaction/memory
// budgeting doesn't need to be exact — the server tokeniser is the final
// authority anyway.
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Single-line bullet format (block-format redesign)
// ============================================================================

/**
 * Memory entries now live as one-line bullets carrying their own
 * provenance:
 *
 *   `- <iso-ts> [<host>] <text>`
 *
 * The leading `- ` keeps every entry a valid markdown bullet so files
 * still render cleanly when opened directly in an editor. The
 * timestamp + host make merging across machines lossless — two
 * machines extracting the same fact at different times produce two
 * lines whose `(ts, text)` keys differ, so the union via dedup picks
 * up both. Same machine extracting the same fact at the same iso
 * second is deduped on read.
 *
 * Legacy lines (anything without the leading-timestamp prefix) are
 * stripped on read. The migration command (one-shot) grandfathers
 * legacy content into the new format by stamping each unstamped line
 * with the file's mtime + the `[legacy]` host marker.
 */
export interface MemoryEntry {
    /** ISO-8601 timestamp the entry was first written. */
    ts: string;
    /** Host that produced the entry; `os.hostname()` at write time, or `legacy` for migrated content. */
    host: string;
    /** Entry text — already stripped of the `- <ts> [<host>] ` prefix. */
    text: string;
}

const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+\[([^\]]*)\]\s+(.+)$/;

/**
 * Parse a memory file body into typed entries.
 *
 * Drops every line that doesn't match the `- <iso> [<host>] <text>`
 * shape. Headings, blank lines, and legacy bullets without timestamps
 * are filtered out — the migration command is responsible for
 * grandfathering legacy lines before any normal write triggers this
 * read.
 */
export function parseMemoryEntries(body: string): MemoryEntry[] {
    if (!body) { return []; }
    const out: MemoryEntry[] = [];
    for (const line of body.split(/\r?\n/)) {
        const m = ENTRY_RE.exec(line);
        if (!m) { continue; }
        out.push({ ts: m[1], host: m[2], text: m[3].trim() });
    }
    return out;
}

/**
 * Serialise entries to disk format — one bullet per line, newest first
 * (so head-bounded reads at compaction time preserve the freshest
 * entries). The output always ends with a single trailing newline so
 * the file is POSIX-clean.
 */
export function serialiseMemoryEntries(entries: MemoryEntry[]): string {
    if (entries.length === 0) { return ''; }
    return entries
        .map((e) => `- ${e.ts} [${e.host}] ${e.text}`)
        .join('\n') + '\n';
}

/**
 * Dedup by `(ts, text)` then sort newest-first. Stable for tied
 * timestamps (entries with identical `ts` retain input order). When
 * two machines write the same fact at the same iso second under
 * different hosts, both entries survive — they share `(ts, text)` only
 * if both `ts` and `text` are byte-identical.
 */
export function dedupAndSortEntries(entries: MemoryEntry[]): MemoryEntry[] {
    const seen = new Map<string, MemoryEntry>();
    for (const e of entries) {
        const key = `${e.ts}${e.text}`;
        if (!seen.has(key)) {
            seen.set(key, e);
        }
    }
    // Newest first. localeCompare on ISO-8601 is lexicographic = chronological.
    return Array.from(seen.values()).sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * Strip the canonical prefix from a candidate entry line, returning
 * just the text. If the line is plain text (no prefix), it's returned
 * unchanged so callers can stamp it themselves.
 */
export function entryTextFromLine(line: string): string {
    const m = ENTRY_RE.exec(line);
    return m ? m[3].trim() : line.trim().replace(/^[-*+]\s+/, '').trim();
}

const HOST_NAME = (() => {
    try {
        return os.hostname() || 'unknown';
    } catch {
        return 'unknown';
    }
})();

/** Internal-use helper for tests: the host stamp this process writes with. */
export function currentMemoryHost(): string { return HOST_NAME; }

export class TwoTierMemoryService {
    private static _instance: TwoTierMemoryService | undefined;

    static init(_context: vscode.ExtensionContext): TwoTierMemoryService {
        if (!TwoTierMemoryService._instance) {
            TwoTierMemoryService._instance = new TwoTierMemoryService();
        }
        return TwoTierMemoryService._instance;
    }

    static get instance(): TwoTierMemoryService {
        if (!TwoTierMemoryService._instance) {
            TwoTierMemoryService._instance = new TwoTierMemoryService();
        }
        return TwoTierMemoryService._instance;
    }

    /** Absolute path to the memory root (`_ai/memory/`). */
    memoryRoot(): string {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // WsPaths.ai('memory') resolves via the configured AI folder name
        // (WsPaths.aiFolder, e.g. '_ai'). 'memory' is now in AI_SUBPATHS,
        // so WsPaths.ai('memory') should always succeed; the fallback uses
        // WsPaths.aiFolder to avoid hardcoding '_ai'.
        return WsPaths.ai('memory') ?? path.join(wsRoot, WsPaths.aiFolder, 'memory');
    }

    /** Absolute path to the folder for the given scope. */
    scopeFolder(scope: MemoryScope, questId?: string): string {
        if (scope === 'shared') {
            return path.join(this.memoryRoot(), 'shared');
        }
        const quest = questId || this.currentQuest();
        return path.join(this.memoryRoot(), quest || 'default');
    }

    /** Absolute path to a file within a scope. */
    filePath(scope: MemoryScope, file: string, questId?: string): string {
        return path.join(this.scopeFolder(scope, questId), this.sanitizeFile(file));
    }

    // ------------------------------------------------------------------------
    // Core operations
    // ------------------------------------------------------------------------

    /** Read `file` in `scope`. Returns `""` when the file is absent. */
    read(scope: MemoryScope, file: string, questId?: string): string {
        const target = this.filePath(scope, file, questId);
        return FsUtils.safeReadFile(target) ?? '';
    }

    /** Overwrite `file` in `scope`. Creates parents on first use. */
    write(scope: MemoryScope, file: string, content: string, questId?: string): void {
        const target = this.filePath(scope, file, questId);
        FsUtils.ensureDir(path.dirname(target));
        fs.writeFileSync(target, content, 'utf-8');
    }

    /** Append `content` to `file` (with a leading newline if the file is non-empty). */
    append(scope: MemoryScope, file: string, content: string, questId?: string): void {
        const existing = this.read(scope, file, questId);
        const body = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
        this.write(scope, file, body + content.trimEnd() + '\n', questId);
    }

    /**
     * Add new memory entries to `file`. Used for memory files so the
     * newest entries sit on top and the oldest fall off the bottom
     * when the file is head-bounded at inject time.
     *
     * **Format change (block-format redesign)**: entries are now
     * persisted as single-line bullets carrying their own timestamp +
     * host:
     *
     *     `- 2026-06-01T08:45:07.182Z [mbp.local] User prefers terse commits.`
     *
     * Each line in `content` becomes one entry, stamped with the
     * current time + `os.hostname()`. Lines already in canonical form
     * (carry a leading-timestamp prefix) are taken at face value — the
     * caller has already done the stamping (e.g. the migration command
     * stamping legacy lines with the file mtime). On write the full
     * file is re-serialised in canonical form: existing legacy lines
     * (those without timestamps) are stripped, all entries are
     * deduped by `(ts, text)`, and the result is sorted newest-first.
     *
     * Name kept as `prepend` for back-compat; semantics are now
     * "merge-and-sort" rather than literal prepend, but the on-disk
     * visual ordering (newest at top) is preserved.
     */
    prepend(scope: MemoryScope, file: string, content: string, questId?: string): void {
        const stamped = this.stampNewLines(content);
        const existing = parseMemoryEntries(this.read(scope, file, questId));
        const combined = dedupAndSortEntries([...stamped, ...existing]);
        this.write(scope, file, serialiseMemoryEntries(combined), questId);
    }

    /**
     * Append entries that are already in canonical form (one bullet per
     * line carrying their own `<ts>` + `[<host>]`). The migration
     * command uses this to inject grandfathered legacy lines without
     * re-stamping them. Same dedup/sort treatment as `prepend`.
     */
    prependStamped(scope: MemoryScope, file: string, lines: string[], questId?: string): void {
        const fresh = parseMemoryEntries(lines.join('\n'));
        const existing = parseMemoryEntries(this.read(scope, file, questId));
        const combined = dedupAndSortEntries([...fresh, ...existing]);
        this.write(scope, file, serialiseMemoryEntries(combined), questId);
    }

    /**
     * Turn a multi-line `content` blob into stamped entries. Lines that
     * already carry a canonical prefix are accepted verbatim (parsed
     * back into typed entries); plain bullet lines get a fresh `(now,
     * host)` stamp; blank lines are dropped.
     */
    private stampNewLines(content: string): MemoryEntry[] {
        const now = new Date().toISOString();
        const out: MemoryEntry[] = [];
        for (const raw of content.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) { continue; }
            const m = ENTRY_RE.exec(line);
            if (m) {
                out.push({ ts: m[1], host: m[2], text: m[3].trim() });
                continue;
            }
            // Plain bullet (or unmarked text) — stamp it.
            const text = line.replace(/^[-*+]\s+/, '').trim();
            if (!text) { continue; }
            out.push({ ts: now, host: HOST_NAME, text });
        }
        return out;
    }

    /**
     * Replace the content block under a named markdown heading. If the
     * heading is absent, the block is appended at the end under a new
     * heading. Only the innermost matching heading level is considered.
     */
    replaceSection(scope: MemoryScope, file: string, heading: string, newContent: string, questId?: string): void {
        const existing = this.read(scope, file, questId);
        const normalizedHeading = heading.replace(/^#+\s*/, '').trim();
        if (!existing) {
            this.write(scope, file, `## ${normalizedHeading}\n\n${newContent.trimEnd()}\n`, questId);
            return;
        }
        const lines = existing.split(/\r?\n/);
        const headingRegex = new RegExp(`^(#{1,6})\\s+${this.escapeRegex(normalizedHeading)}\\s*$`, 'i');
        let startIdx = -1;
        let level = 0;
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(headingRegex);
            if (match) {
                startIdx = i;
                level = match[1].length;
                break;
            }
        }
        if (startIdx < 0) {
            // Heading absent — append at end.
            const tail = existing.endsWith('\n') ? '' : '\n';
            this.write(scope, file, existing + tail + `\n## ${normalizedHeading}\n\n${newContent.trimEnd()}\n`, questId);
            return;
        }
        // Find the end of the section: the next heading of the same or
        // higher level, or end of file.
        let endIdx = lines.length;
        const sameOrHigher = new RegExp(`^#{1,${level}}\\s+`);
        for (let i = startIdx + 1; i < lines.length; i++) {
            if (sameOrHigher.test(lines[i])) {
                endIdx = i;
                break;
            }
        }
        const replacement = [
            lines[startIdx],
            '',
            newContent.trimEnd(),
            '',
        ];
        const next = [...lines.slice(0, startIdx), ...replacement, ...lines.slice(endIdx)].join('\n');
        this.write(scope, file, next.endsWith('\n') ? next : next + '\n', questId);
    }

    /** Delete `file` in `scope`. No-op if it doesn't exist. */
    delete(scope: MemoryScope, file: string, questId?: string): void {
        const target = this.filePath(scope, file, questId);
        try {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        } catch {
            // ignore — callers can re-list to confirm
        }
    }

    /**
     * List memory files in a scope. Returns relative paths under the
     * scope folder; nested files (e.g. `custom/topic.md`) are flattened
     * to forward-slash-joined names.
     */
    list(scope: MemoryScope, questId?: string): string[] {
        const root = this.scopeFolder(scope, questId);
        return this.walkRelative(root, '', (rel) => !rel.startsWith('history/'));
    }

    /** Same as `list()` but with full metadata. */
    listWithMeta(scope: MemoryScope, questId?: string): MemoryListEntry[] {
        const root = this.scopeFolder(scope, questId);
        const files = this.list(scope, questId);
        return files.map((rel) => {
            const abs = path.join(root, rel);
            const stat = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
            return {
                scope,
                file: rel,
                bytes: stat?.size ?? 0,
                mtime: stat?.mtimeMs ?? 0,
            };
        });
    }

    /** Concatenate all memory files in `scope` for injection. */
    readAll(scope: MemoryReadScope, questId?: string): string {
        const parts: string[] = [];
        const tiers: MemoryScope[] = scope === 'all' ? ['shared', 'quest'] : [scope];
        for (const tier of tiers) {
            for (const file of this.list(tier, questId)) {
                const body = this.read(tier, file, questId);
                if (!body.trim()) {
                    continue;
                }
                parts.push(`### ${tier}/${file}\n${body.trimEnd()}\n`);
            }
        }
        return parts.join('\n');
    }

    /**
     * Build a memory block for the system prompt, respecting a token
     * budget. Shared memory is included first (priority per §5.2);
     * quest memory files fill the remaining budget newest-first.
     *
     * When `suffix` is provided (e.g. 'gemma4'), the file selection is
     * restricted to `facts-<suffix>.md` only — used by LocalLLM profiles
     * that want their own isolated memory bucket without sharing files
     * with other profiles. Default (suffix omitted) preserves the
     * legacy "inject every file in scope" behaviour.
     */
    injectForSystemPrompt(maxTokens: number = DEFAULT_MAX_INJECTED_TOKENS, questId?: string, suffix?: string): MemoryInjection {
        const budget = Math.max(0, maxTokens);
        const charBudget = budget * CHARS_PER_TOKEN;
        const pieces: string[] = [];
        const included: MemoryListEntry[] = [];
        let usedChars = 0;

        const orderedShared = this.listWithMeta('shared', questId);
        const orderedQuest = this.listWithMeta('quest', questId).sort((a, b) => b.mtime - a.mtime);
        // When a suffix is set, ignore everything except the exact
        // `facts-<suffix>.md` file in each scope. We don't broaden to
        // any `*-<suffix>.md` because the user spec was precise.
        const filter = suffix
            ? (e: MemoryListEntry) => e.file === `facts-${suffix}.md`
            : () => true;

        const add = (entry: MemoryListEntry): boolean => {
            const body = this.read(entry.scope, entry.file, questId).trim();
            if (!body) {
                return false;
            }
            const block = `### ${entry.scope}/${entry.file}\n${body}\n`;
            if (usedChars + block.length > charBudget) {
                return false;
            }
            pieces.push(block);
            included.push(entry);
            usedChars += block.length;
            return true;
        };

        for (const entry of orderedShared.filter(filter)) { add(entry); }
        for (const entry of orderedQuest.filter(filter)) { add(entry); }

        const text = pieces.length > 0
            ? `## Memory\n\n${pieces.join('\n')}`
            : '';
        return {
            text,
            tokens: Math.ceil(text.length / CHARS_PER_TOKEN),
            included,
        };
    }

    // ------------------------------------------------------------------------
    // Compacted history snapshots (spec §5.2 — multi-session continuity)
    // ------------------------------------------------------------------------

    /**
     * Absolute path to the history snapshot folder for `questId`.
     *
     * Location: `_ai/quests/<quest>/history/` — inside the quest folder so
     * the compacted history moves across machines with the quest via git,
     * alongside the compact trail files. Previous location was under
     * `_ai/memory/<quest>/history/` (not typically committed).
     */
    historyFolder(questId?: string): string {
        const quest = questId || this.currentQuest() || 'default';
        const root = WsPaths.ai('quests')
            ?? path.join(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
                WsPaths.aiFolder,
                'quests',
            );
        return path.join(root, quest, 'history');
    }

    /**
     * Persist a compacted message array to the quest's history folder.
     *
     * Writes **two** files with matching base names every time:
     *   - `history.json` — structured payload the handler reloads from.
     *   - `history.md`   — human-readable version rendered by
     *                       `formatHistoryAsMarkdown`, intended for the
     *                       "Open session history" button in the chat
     *                       panel and for git-diff inspection.
     *
     * When `archive` is true, additionally writes `<ts>.history.json`
     * and `<ts>.history.md` alongside — same pair, timestamped. Archive
     * is opt-in via the Compaction section's "Archive every turn"
     * setting; default off to keep the folder lean.
     *
     * Quietly no-ops on I/O error — persistence failure must never
     * affect the user-visible turn result.
     */
    persistHistorySnapshot(messages: unknown, questId?: string, archive: boolean = false, suffix?: string): string | undefined {
        try {
            const folder = this.historyFolder(questId);
            FsUtils.ensureDir(folder);
            const savedAt = new Date().toISOString();
            const payload = { messages, savedAt };
            const jsonContent = JSON.stringify(payload, null, 2);
            const mdContent = formatHistoryAsMarkdown({
                messages,
                savedAt,
                questId: questId || this.currentQuest() || 'default',
            });
            // Single rolling pair. When a suffix is provided, write to
            // `history-<suffix>.{json,md}` in the same folder so each
            // profile can own its own conversation thread without
            // clobbering the canonical pair (used by Anthropic).
            const base = suffix ? `history-${suffix}` : 'history';
            const canonicalJson = path.join(folder, `${base}.json`);
            const canonicalMd = path.join(folder, `${base}.md`);
            fs.writeFileSync(canonicalJson, jsonContent, 'utf-8');
            fs.writeFileSync(canonicalMd, mdContent, 'utf-8');
            if (archive) {
                const stamp = this.timestampNow();
                const archiveJson = path.join(folder, `${stamp}.${base}.json`);
                const archiveMd = path.join(folder, `${stamp}.${base}.md`);
                fs.writeFileSync(archiveJson, jsonContent, 'utf-8');
                fs.writeFileSync(archiveMd, mdContent, 'utf-8');
            }
            return canonicalJson;
        } catch {
            return undefined;
        }
    }

    /**
     * Load the most recent history snapshot for `questId`. Prefers the
     * single `history.json`; falls back to the most recent
     * `<timestamp>.history.json` if only archived files exist (e.g. the
     * canonical file was deleted manually). Returns the raw messages
     * payload, or `undefined` when no snapshot can be read.
     */
    loadLatestHistorySnapshot<T = unknown>(questId?: string, suffix?: string): T | undefined {
        try {
            const folder = this.historyFolder(questId);
            if (!fs.existsSync(folder)) {
                return undefined;
            }
            const base = suffix ? `history-${suffix}` : 'history';
            const canonicalName = `${base}.json`;
            // 1. Prefer the rolling `<base>.json`.
            const canonical = path.join(folder, canonicalName);
            if (fs.existsSync(canonical)) {
                const raw = FsUtils.safeReadJson<{ messages?: T }>(canonical);
                if (raw?.messages !== undefined) { return raw.messages; }
            }
            // 2. Fall back to the most recent archive file MATCHING this
            //    suffix (`<ts>.<base>.json`). Cross-suffix files are
            //    ignored so a profile never resurrects another profile's
            //    snapshot when the canonical file is gone.
            const archiveTail = `.${base}.json`;
            const entries = fs.readdirSync(folder)
                .filter((n) => n !== canonicalName && n.endsWith(archiveTail))
                .map((n) => ({ n, mtime: fs.statSync(path.join(folder, n)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (entries.length === 0) {
                return undefined;
            }
            const raw = FsUtils.safeReadJson<{ messages?: T }>(path.join(folder, entries[0].n));
            return raw?.messages;
        } catch {
            return undefined;
        }
    }

    private timestampNow(): string {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    /** Active quest id from the chat variables store, or '' if unset. */
    currentQuest(): string {
        try {
            return ChatVariablesStore.instance.quest || '';
        } catch {
            return WsPaths.getWorkspaceQuestId() === 'default' ? '' : WsPaths.getWorkspaceQuestId();
        }
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private walkRelative(root: string, sub: string, accept: (rel: string) => boolean): string[] {
        const abs = sub ? path.join(root, sub) : root;
        if (!fs.existsSync(abs)) {
            return [];
        }
        const out: string[] = [];
        for (const name of fs.readdirSync(abs)) {
            const relChild = sub ? `${sub}/${name}` : name;
            const absChild = path.join(abs, name);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(absChild);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (!accept(relChild + '/')) {
                    continue;
                }
                out.push(...this.walkRelative(root, relChild, accept));
            } else if (stat.isFile()) {
                if (!accept(relChild)) {
                    continue;
                }
                out.push(relChild);
            }
        }
        return out;
    }

    /** Reject absolute paths and `..` traversal — file names are scope-relative. */
    private sanitizeFile(file: string): string {
        const trimmed = file.replace(/^[\\/]+/, '').replace(/\\/g, '/');
        if (trimmed.includes('..')) {
            throw new Error(`Invalid memory file path: ${file}`);
        }
        return trimmed;
    }

    // ------------------------------------------------------------------------
    // Agent SDK session-id persistence (per quest, machine-local)
    // ------------------------------------------------------------------------

    /**
     * Filename inside the quest's history folder, keyed by `sessionKey`:
     * `<sessionKey>.session.json` (e.g. `default.session.json` for the
     * prompt queue, `chat.session.json` for the Anthropic chat panel).
     * Keeping each entry point on its own key stops one surface from
     * resuming (or clearing) another's SDK session.
     *
     * Gitignored because SDK sessions are tied to a single machine/install
     * and can't move with git. A fixed path means the file is auto-recreated
     * when missing and survives VS Code window restarts — earlier versions
     * keyed on windowId, which defeated that goal (every reload produced an
     * orphan file and lost continuity).
     */
    private agentSdkSessionFile(questId?: string, sessionKey: string = 'default'): string {
        return path.join(this.historyFolder(questId), `${sessionKey}.session.json`);
    }

    /**
     * Read the stored session id for the quest. Undefined when missing
     * or unparseable. Empty (0-byte) files are treated as missing AND unlinked
     * so a subsequent save can rebuild cleanly — a stale empty file is
     * usually the residue of a write that was interrupted by a window
     * reload, and leaving it around would mask a good value from older
     * turns that aren't the user's fault.
     */
    loadAgentSdkSessionId(questId?: string, sessionKey: string = 'default'): string | undefined {
        try {
            const file = this.agentSdkSessionFile(questId, sessionKey);
            if (!fs.existsSync(file)) { return undefined; }
            try {
                const stat = fs.statSync(file);
                if (stat.size === 0) {
                    try { fs.unlinkSync(file); } catch { /* best-effort */ }
                    return undefined;
                }
            } catch { /* proceed to read */ }
            const raw = FsUtils.safeReadJson<{ sessionId?: unknown }>(file);
            const sid = raw?.sessionId;
            return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Persist the session id returned by the Claude Code SDK.
     *
     * Skips the write entirely when the file already holds the same id
     * — on the steady-state path (resume → SDK echoes same id → we'd
     * save the same id back) the file is effectively immutable, and
     * not rewriting it avoids VS Code watcher churn and reduces the
     * chance of a mid-write interruption corrupting it.
     *
     * When it DOES need to write (first turn, forked session, stale
     * stored id), it writes atomically via `<file>.tmp` + `rename` so
     * a window reload or process kill mid-write leaves either the old
     * file or the new file — never a zero-byte placeholder (the bug
     * we hit before: a non-atomic writeFileSync can truncate first,
     * and then interruption leaves an empty file, which on next load
     * looks like a fresh session and forks a new Claude Code session
     * per prompt).
     */
    saveAgentSdkSessionId(sessionId: string, questId?: string, model?: string, sessionKey: string = 'default'): void {
        try {
            if (!sessionId || sessionId.length === 0) { return; }
            const file = this.agentSdkSessionFile(questId, sessionKey);
            // Idempotent short-circuit: if the file already holds this
            // exact id, leave it alone. Reuses loadAgentSdkSessionId
            // so stale empty files also get cleaned up correctly.
            const existing = this.loadAgentSdkSessionId(questId, sessionKey);
            if (existing === sessionId) { return; }
            FsUtils.ensureDir(path.dirname(file));
            const tmp = `${file}.tmp`;
            fs.writeFileSync(
                tmp,
                JSON.stringify({ sessionId, updatedAt: new Date().toISOString(), model: model ?? '' }, null, 2),
                'utf-8',
            );
            fs.renameSync(tmp, file);
        } catch {
            // best-effort
        }
    }

    /** Remove the session-id file for `sessionKey` (used by clearSession). */
    clearAgentSdkSessionId(questId?: string, sessionKey: string = 'default'): void {
        try {
            const file = this.agentSdkSessionFile(questId, sessionKey);
            if (fs.existsSync(file)) { fs.unlinkSync(file); }
        } catch {
            // best-effort
        }
    }

    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

// ============================================================================
// History → Markdown rendering
// ============================================================================

export interface HistoryMarkdownInput {
    messages: unknown;
    savedAt: string;
    questId: string;
}

/**
 * Render a persisted session history payload as human-readable Markdown.
 *
 * Handles the canonical shape (`{ compactedSummary, rawTurns }`) with
 * nicely formatted sections; anything else falls through to a raw-JSON
 * code block so the file is still openable without a parser in the
 * middle. The legacy flat `ConversationMessage[]` shape no longer has
 * a first-class branch — it renders as JSON via the fallback.
 *
 * Written next to every `history.json` (see `persistHistorySnapshot`)
 * so the "Open session history" button in the chat panels has a
 * single stable path to open in the MD Browser.
 */
export function formatHistoryAsMarkdown(input: HistoryMarkdownInput): string {
    const { messages, savedAt, questId } = input;
    const lines: string[] = [];
    lines.push(`# Session history — \`${questId}\``);
    lines.push('');
    lines.push(`_Saved at ${savedAt}._`);
    lines.push('');

    // --- Canonical shape: { compactedSummary, rawTurns } ---
    if (messages && typeof messages === 'object' && !Array.isArray(messages)) {
        const obj = messages as { compactedSummary?: unknown; rawTurns?: unknown };
        const summary = typeof obj.compactedSummary === 'string' ? obj.compactedSummary : '';
        const rawTurnsRaw = Array.isArray(obj.rawTurns) ? obj.rawTurns : [];
        const rawTurns = rawTurnsRaw.filter((m): m is { role: string; content: string } =>
            !!m && typeof m === 'object' &&
            typeof (m as { role?: unknown }).role === 'string' &&
            typeof (m as { content?: unknown }).content === 'string',
        );

        lines.push(`## Compacted summary — ${summary.length} chars`);
        lines.push('');
        if (!summary) {
            lines.push('_(empty — no turns have been compacted into the summary yet.)_');
        } else {
            lines.push(summary);
        }
        lines.push('');
        lines.push(`## Raw turns — ${rawTurns.length} messages`);
        lines.push('');
        if (rawTurns.length === 0) {
            lines.push('_(empty — fresh session or just after a clear.)_');
        } else {
            for (let i = 0; i < rawTurns.length; i++) {
                const m = rawTurns[i];
                lines.push(`### [${i + 1}] ${m.role} — ${m.content.length} chars`);
                lines.push('');
                lines.push(m.content);
                lines.push('');
            }
        }
        return lines.join('\n');
    }

    // --- Fallback: raw JSON dump so the file is still inspectable ---
    lines.push('## Raw payload');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(messages, null, 2));
    lines.push('```');
    return lines.join('\n');
}
