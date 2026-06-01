/**
 * One-shot migration command for the compaction redesign.
 *
 * Converts every quest's history + every memory file from the legacy
 * format (single-string `compactedSummary` in `history.json` + free-form
 * markdown bullets in memory files) to the new block-format and
 * single-line-bullet format.
 *
 * Per-quest steps:
 *
 *   1. Read `_ai/quests/<q>/history/history.json` (the legacy file).
 *      - If `compactedSummary` is non-empty, write
 *        `_ai/quests/<q>/history/compacted_history.md` with ONE block:
 *        `created = modified = savedAt`, `body = compactedSummary text`.
 *      - Write `_ai/quests/<q>/history/rawTurns.json` from the legacy
 *        `rawTurns` field, capped to `rawTurnsKept`.
 *      - Delete `history.json` and `history.md`.
 *
 *   2. For each `.md` file under `_ai/memory/<q>/` and `_ai/memory/shared/`:
 *      - Parse lines. Lines already in canonical form
 *        (`- <iso> [<host>] <text>`) are preserved as-is. Lines missing
 *        the prefix are stamped with the file's mtime + `[legacy]` host
 *        marker. Blank lines and pure-heading lines are dropped.
 *      - Rewrite the file with the resulting entries (newest first).
 *
 * Idempotent: a second invocation finds `compacted_history.md` already
 * present (no `history.json` to migrate) and finds every memory line
 * already stamped (no `[legacy]` work to do). The function is safe to
 * re-run after a partial first pass.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { WsPaths } from '../utils/workspacePaths';
import { FsUtils } from '../utils/fsUtils';
import {
    parseMemoryEntries,
    serialiseMemoryEntries,
    dedupAndSortEntries,
    type MemoryEntry,
} from './memory-service';
import {
    saveToDisk as saveBlocksToDisk,
    compactedHistoryPath,
    type Block,
} from './compacted-history';
import {
    save as saveRawTurns,
    rawTurnsToRounds,
    rawTurnsPath,
} from './raw-turns-store';
import type { ConversationMessage } from './history-compaction';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';

const ENTRY_PREFIX_RE = /^-\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\s+\[[^\]]*\]\s+/;

export interface MigrationReport {
    questsScanned: number;
    questsMigrated: number;
    questsAlreadyCurrent: number;
    questsFailed: number;
    memoryFilesScanned: number;
    memoryFilesMigrated: number;
    memoryFilesAlreadyCurrent: number;
    memoryFilesFailed: number;
    progressLines: string[];
}

interface MigrationCallbacks {
    onProgress?: (msg: string) => void;
}

/**
 * Run the migration. Returns a structured report so the caller can
 * surface a final notification + raw progress lines.
 */
export function migrateCompactionFormat(opts?: MigrationCallbacks): MigrationReport {
    const report: MigrationReport = {
        questsScanned: 0,
        questsMigrated: 0,
        questsAlreadyCurrent: 0,
        questsFailed: 0,
        memoryFilesScanned: 0,
        memoryFilesMigrated: 0,
        memoryFilesAlreadyCurrent: 0,
        memoryFilesFailed: 0,
        progressLines: [],
    };
    const emit = (line: string): void => {
        report.progressLines.push(line);
        opts?.onProgress?.(line);
    };

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
        emit('No workspace open — nothing to migrate.');
        return report;
    }
    const aiRoot = WsPaths.aiFolder
        ? path.join(wsRoot, WsPaths.aiFolder)
        : path.join(wsRoot, '_ai');
    const questsRoot = path.join(aiRoot, 'quests');
    const memoryRoot = path.join(aiRoot, 'memory');

    const rawTurnsKept = readRawTurnsKept();

    // --- Quests ---
    if (fs.existsSync(questsRoot)) {
        const questDirs = listSubdirectories(questsRoot);
        for (const quest of questDirs) {
            report.questsScanned += 1;
            const historyFolder = path.join(questsRoot, quest, 'history');
            try {
                const outcome = migrateOneQuestHistory(historyFolder, rawTurnsKept);
                if (outcome === 'migrated') {
                    report.questsMigrated += 1;
                    emit(`quest: ${quest} — migrated`);
                } else if (outcome === 'already-current') {
                    report.questsAlreadyCurrent += 1;
                    emit(`quest: ${quest} — already in block format`);
                } else {
                    emit(`quest: ${quest} — no history to migrate`);
                }
            } catch (e) {
                report.questsFailed += 1;
                emit(`quest: ${quest} — FAILED: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    // --- Memory files ---
    if (fs.existsSync(memoryRoot)) {
        for (const sub of listSubdirectories(memoryRoot)) {
            const subFolder = path.join(memoryRoot, sub);
            for (const file of listMarkdownFiles(subFolder)) {
                const rel = `${sub}/${path.basename(file)}`;
                report.memoryFilesScanned += 1;
                try {
                    const outcome = migrateOneMemoryFile(file);
                    if (outcome === 'migrated') {
                        report.memoryFilesMigrated += 1;
                        emit(`memory: ${rel} — migrated`);
                    } else {
                        report.memoryFilesAlreadyCurrent += 1;
                        emit(`memory: ${rel} — already in single-line format`);
                    }
                } catch (e) {
                    report.memoryFilesFailed += 1;
                    emit(`memory: ${rel} — FAILED: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }
    }

    emit(
        `Done — ${report.questsMigrated} quest(s) migrated (${report.questsAlreadyCurrent} already current, ${report.questsFailed} failed); ` +
        `${report.memoryFilesMigrated} memory file(s) migrated (${report.memoryFilesAlreadyCurrent} already current, ${report.memoryFilesFailed} failed).`,
    );
    return report;
}

/**
 * Migrate `<quest>/history/history.json` → `compacted_history.md` +
 * `rawTurns.json`, deleting the legacy files on success.
 *
 * Returns:
 *   - `migrated`         — found legacy state, wrote new state.
 *   - `already-current`  — `compacted_history.md` already present (no legacy to read).
 *   - `nothing-to-do`    — neither file present.
 */
function migrateOneQuestHistory(
    historyFolder: string,
    rawTurnsKept: number,
): 'migrated' | 'already-current' | 'nothing-to-do' {
    if (!fs.existsSync(historyFolder)) { return 'nothing-to-do'; }
    const blocksFile = compactedHistoryPath(historyFolder);
    const legacyJson = path.join(historyFolder, 'history.json');
    const legacyMd = path.join(historyFolder, 'history.md');

    if (fs.existsSync(blocksFile) && !fs.existsSync(legacyJson)) {
        return 'already-current';
    }
    if (!fs.existsSync(legacyJson)) { return 'nothing-to-do'; }

    const raw = FsUtils.safeReadJson<{ messages?: unknown; savedAt?: unknown }>(legacyJson);
    let blocks: Block[] = [];
    let rawTurnRounds: ConversationMessage[][] = [];
    let savedAt = new Date().toISOString();

    if (raw && typeof raw === 'object') {
        if (typeof raw.savedAt === 'string' && raw.savedAt.length > 0) {
            savedAt = raw.savedAt;
        }
        const messages = raw.messages;
        if (messages && typeof messages === 'object' && !Array.isArray(messages)) {
            const obj = messages as { compactedSummary?: unknown; rawTurns?: unknown };
            const summary = typeof obj.compactedSummary === 'string' ? obj.compactedSummary.trim() : '';
            if (summary.length > 0) {
                blocks = [{ created: savedAt, modified: savedAt, body: summary }];
            }
            if (Array.isArray(obj.rawTurns)) {
                const validRoles = new Set(['user', 'assistant', 'system']);
                const flat: ConversationMessage[] = [];
                for (const item of obj.rawTurns) {
                    if (!item || typeof item !== 'object') { continue; }
                    const role = (item as { role?: unknown }).role;
                    const content = (item as { content?: unknown }).content;
                    if (typeof role !== 'string' || !validRoles.has(role)) { continue; }
                    if (typeof content !== 'string') { continue; }
                    flat.push({ role: role as ConversationMessage['role'], content });
                }
                rawTurnRounds = rawTurnsToRounds(flat);
            }
        }
    }

    // Write block file (overwrites if already present — safe under
    // idempotency because we just parsed it the same way each time).
    saveBlocksToDisk(historyFolder, blocks);

    // Write rolling tail capped at rawTurnsKept (oldest rounds dropped).
    const cap = Math.max(0, rawTurnsKept);
    const capped = cap === 0 ? [] : rawTurnRounds.slice(-cap);
    saveRawTurns(historyFolder, capped);

    // Remove the legacy files now that the new files have been written.
    try { if (fs.existsSync(legacyJson)) { fs.unlinkSync(legacyJson); } } catch { /* best-effort */ }
    try { if (fs.existsSync(legacyMd)) { fs.unlinkSync(legacyMd); } } catch { /* best-effort */ }

    return 'migrated';
}

/**
 * Migrate one memory `.md` file to single-line entry format.
 *
 * Lines already in canonical form are preserved. Plain bullet lines
 * are stamped with the file's mtime + `[legacy]` host. Blank lines and
 * markdown headings (lines starting with `#`) are dropped from the
 * output — the new format encodes metadata in the entry itself, so
 * heading sections are no longer meaningful.
 *
 * Returns `already-current` when every existing line already matches
 * the canonical prefix; otherwise `migrated`.
 */
function migrateOneMemoryFile(filePath: string): 'migrated' | 'already-current' {
    const body = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    const mtimeIso = new Date(stat.mtimeMs).toISOString();

    const lines = body.split(/\r?\n/);
    const everyLineCanonical = lines
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .every((l) => ENTRY_PREFIX_RE.test(l));
    if (everyLineCanonical) {
        // Still re-canonicalise (dedup/sort) on the off chance the file
        // is unsorted; treat that as a no-op when the output matches.
        const parsed = parseMemoryEntries(body);
        const next = serialiseMemoryEntries(dedupAndSortEntries(parsed));
        if (next === body) { return 'already-current'; }
        fs.writeFileSync(filePath, next, 'utf-8');
        return 'migrated';
    }

    // Mixed / fully legacy file — stamp every non-canonical bullet.
    const entries: MemoryEntry[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { continue; }
        if (line.startsWith('#')) { continue; }      // drop headings
        const match = /^[-*+]\s+(.+)$/.exec(line);
        const text = match ? match[1].trim() : line;
        if (!text) { continue; }
        if (ENTRY_PREFIX_RE.test(line)) {
            const parsed = parseMemoryEntries(line);
            if (parsed.length > 0) {
                entries.push(parsed[0]);
                continue;
            }
        }
        entries.push({ ts: mtimeIso, host: 'legacy', text });
    }
    const next = serialiseMemoryEntries(dedupAndSortEntries(entries));
    fs.writeFileSync(filePath, next, 'utf-8');
    return 'migrated';
}

function readRawTurnsKept(): number {
    try {
        const section = TomAiConfiguration.instance.getSection<{ rawTurnsKept?: number }>('compaction') ?? {};
        return Number.isFinite(section.rawTurnsKept) ? Math.max(0, section.rawTurnsKept as number) : 4;
    } catch {
        return 4;
    }
}

function listSubdirectories(root: string): string[] {
    try {
        return fs.readdirSync(root)
            .filter((name) => {
                try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
            })
            .sort();
    } catch {
        return [];
    }
}

function listMarkdownFiles(folder: string): string[] {
    try {
        return fs.readdirSync(folder)
            .filter((name) => name.endsWith('.md'))
            .map((name) => path.join(folder, name))
            .filter((p) => {
                try { return fs.statSync(p).isFile(); } catch { return false; }
            })
            .sort();
    } catch {
        return [];
    }
}

// Silence the unused-import warning for rawTurnsPath — kept exported
// so tests / future callers have a single place to resolve the path.
void rawTurnsPath;
