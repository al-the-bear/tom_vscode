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
        return WsPaths.ai('memory') ?? path.join(wsRoot, '_ai', 'memory');
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
     */
    injectForSystemPrompt(maxTokens: number = DEFAULT_MAX_INJECTED_TOKENS, questId?: string): MemoryInjection {
        const budget = Math.max(0, maxTokens);
        const charBudget = budget * CHARS_PER_TOKEN;
        const pieces: string[] = [];
        const included: MemoryListEntry[] = [];
        let usedChars = 0;

        const orderedShared = this.listWithMeta('shared', questId);
        const orderedQuest = this.listWithMeta('quest', questId).sort((a, b) => b.mtime - a.mtime);

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

        for (const entry of orderedShared) { add(entry); }
        for (const entry of orderedQuest) { add(entry); }

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

    /** Absolute path to the history snapshot folder for `questId`. */
    historyFolder(questId?: string): string {
        return path.join(this.scopeFolder('quest', questId), 'history');
    }

    /**
     * Persist a compacted message array as a timestamped snapshot under
     * `_ai/memory/{quest}/history/`. Filename format:
     * `YYYYMMDD_HHMMSS.history.json`. Quietly no-ops on I/O error — the
     * user-visible result must not depend on persistence succeeding.
     */
    persistHistorySnapshot(messages: unknown, questId?: string): string | undefined {
        try {
            const folder = this.historyFolder(questId);
            FsUtils.ensureDir(folder);
            const stamp = this.timestampNow();
            const file = path.join(folder, `${stamp}.history.json`);
            fs.writeFileSync(file, JSON.stringify({ messages, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
            return file;
        } catch {
            return undefined;
        }
    }

    /**
     * Load the most recent history snapshot for `questId`. Returns the
     * raw messages payload or `undefined` when no snapshot exists.
     */
    loadLatestHistorySnapshot<T = unknown>(questId?: string): T | undefined {
        try {
            const folder = this.historyFolder(questId);
            if (!fs.existsSync(folder)) {
                return undefined;
            }
            const entries = fs.readdirSync(folder)
                .filter((n) => n.endsWith('.history.json'))
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

    private escapeRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}
