/**
 * Tool Result Store — disk-backed lookup of tool results by key (e.g. `t14`).
 *
 * Why this exists: the in-memory `ToolTrail` is a ring buffer (default 40
 * entries) and is window-scoped, so older results disappear after long
 * sessions or extension reloads. The compaction strategy described in
 * `doc/llm_configuration.md` only sends the most recent N tool_result
 * blocks inline; older ones become stubs that point the model at
 * `tomAi_readPastToolResult({key})`. For that pointer to actually
 * resolve, the full bodies have to live somewhere durable.
 *
 * Layout on disk (one file per call):
 *
 *   ${ai}/trail/<subsystem>/<quest>/tool_results/<key>.json
 *
 * The file contains the same shape as `ToolTrailEntry` so the read path
 * can rebuild a presentable view without re-parsing the trail summary.
 *
 * Both the Local LLM and the Anthropic handlers wire `ToolTrail.add()`
 * to call `writeToolResult()` on every successful tool execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths';
import { resolveTrailPath } from './trailPathResolver';
import { FsUtils } from '../utils/fsUtils';
import { TomAiConfiguration } from '../utils/tomAiConfiguration';
import {
    TOOL_RESULT_RETENTION_MARKER, readToolResultRetentionMarker, sessionToolResultsFolder, sessionsWithStorage,
    type ToolResultRetentionMarker,
} from './sessionStorage';
import { questHistoryRoot } from './trailService';

export type ToolResultSubsystem = 'localLlm' | 'anthropic';

export interface StoredToolResult {
    key: string;
    timestamp: string;
    round: number;
    toolName: string;
    inputSummary: string;
    result: string;
    durationMs: number;
    error?: string;
}

function getRawBase(subsystem: ToolResultSubsystem): string {
    const trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>;
    const raw = ((trail.raw ?? trail) as Record<string, unknown>);
    const paths = ((raw.paths ?? {}) as Record<string, string>);
    if (subsystem === 'anthropic') {
        return paths.anthropic ?? '${ai}/trail/anthropic/${quest}';
    }
    return paths.localLlm ?? '${ai}/trail/localllm/${quest}';
}

/**
 * The folder of the results. An Anthropic session's results are in its own
 * storage (`history/sessions/<session>/trail/tool_results/`), so two sessions
 * never share keys; without a session, the subsystem's raw trail folder.
 */
function resolveStoreDir(subsystem: ToolResultSubsystem, questId?: string, session?: string): string {
    const quest = questId || WsPaths.getWorkspaceQuestId();
    if (subsystem === 'anthropic' && session) {
        return sessionToolResultsFolder(questHistoryRoot(quest), session);
    }
    const base = getRawBase(subsystem);
    const expanded = resolveTrailPath(base, { subsystem, quest });
    return path.join(expanded, 'tool_results');
}

/** Sanity-check a key string before using it as a file name. Keys are
 *  short alphanumeric tokens (`t14`, `t142`, …); reject anything that
 *  could escape the directory. */
function isValidKey(key: string): boolean {
    return /^[A-Za-z0-9_-]{1,32}$/.test(key);
}

/** The folder `writeToolResult` writes to (to seed a ToolTrail's key counter past what is there). */
export function toolResultFolder(subsystem: ToolResultSubsystem, questId?: string, session?: string): string {
    return resolveStoreDir(subsystem, questId, session);
}

export function writeToolResult(
    subsystem: ToolResultSubsystem,
    entry: StoredToolResult,
    questId?: string,
    session?: string,
): void {
    if (!isValidKey(entry.key)) {
        return;
    }
    try {
        const dir = resolveStoreDir(subsystem, questId, session);
        FsUtils.ensureDir(dir);
        const filePath = path.join(dir, `${entry.key}.json`);
        FsUtils.safeWriteJson(filePath, entry);
    } catch {
        // Best-effort persistence — never break the tool loop on disk
        // failures. The in-memory ring buffer remains the primary surface.
    }
}

export function readToolResult(
    subsystem: ToolResultSubsystem,
    key: string,
    questId?: string,
    session?: string,
): StoredToolResult | undefined {
    if (!isValidKey(key)) {
        return undefined;
    }
    try {
        const filePath = path.join(resolveStoreDir(subsystem, questId, session), `${key}.json`);
        if (!fs.existsSync(filePath)) {
            return undefined;
        }
        const text = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(text) as StoredToolResult;
        if (!parsed || typeof parsed.key !== 'string') {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}

/** Resolution helper for `tomAi_readPastToolResult`: the Anthropic session's
 *  own results first (`session`, the session the call runs in), then every
 *  subsystem's folder without a session, so a key issued by the Local LLM is
 *  still readable when the user has since switched to Anthropic, and vice-versa. */
export function readToolResultAnySubsystem(
    key: string,
    questId?: string,
    session?: string,
): { entry: StoredToolResult; subsystem: ToolResultSubsystem } | undefined {
    if (session) {
        const own = readToolResult('anthropic', key, questId, session);
        if (own) { return { entry: own, subsystem: 'anthropic' }; }
    }
    for (const subsystem of ['anthropic', 'localLlm'] as ToolResultSubsystem[]) {
        const entry = readToolResult(subsystem, key, questId);
        if (entry) {
            return { entry, subsystem };
        }
    }
    return undefined;
}

/**
 * Every result Anthropic session `session` stored, oldest first (by key
 * number). The disk store keeps them all, so this reaches calls the session's
 * in-memory ring has evicted, and the calls of sessions other than the
 * caller's (tomAi_listPastToolCalls / tomAi_searchPastToolResults with
 * `sessions`).
 */
export function listStoredToolResults(questId: string | undefined, session: string): StoredToolResult[] {
    const folder = resolveStoreDir('anthropic', questId, session);
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { return []; }
    return names
        .map((n) => /^t(\d+)\.json$/.exec(n))
        .filter((m): m is RegExpExecArray => !!m)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((m) => readToolResult('anthropic', `t${m[1]}`, questId, session))
        .filter((r): r is StoredToolResult => !!r);
}

// ---------------------------------------------------------------------------
// Retention (vscimpb49)
// ---------------------------------------------------------------------------

/** How long and how many stored results a session keeps; 0 switches that limit off. */
export interface ToolResultRetention {
    /** Results older than this many days are pruned. Default 30. */
    maxAgeDays: number;
    /** At most this many results per session (per folder), the newest. Default 1000. */
    maxPerSession: number;
}

export const DEFAULT_TOOL_RESULT_RETENTION: ToolResultRetention = { maxAgeDays: 30, maxPerSession: 1000 };

/** The configured retention (`trail.toolResultsMaxAgeDays`, `trail.toolResultsMaxPerSession`; Status Page). */
export function configuredToolResultRetention(): ToolResultRetention {
    let trail: Record<string, unknown> = {};
    try { trail = TomAiConfiguration.instance.getTrail() as Record<string, unknown>; } catch { /* not initialised: the defaults */ }
    // The Status Page writes the keys at `trail`; a `trail.raw` section may hold them too.
    const raw = (typeof trail.raw === 'object' && trail.raw !== null ? trail.raw : {}) as Record<string, unknown>;
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
    return {
        maxAgeDays: num(trail.toolResultsMaxAgeDays ?? raw.toolResultsMaxAgeDays, DEFAULT_TOOL_RESULT_RETENTION.maxAgeDays),
        maxPerSession: num(trail.toolResultsMaxPerSession ?? raw.toolResultsMaxPerSession, DEFAULT_TOOL_RESULT_RETENTION.maxPerSession),
    };
}

/** What one prune did. */
export interface ToolResultPrune {
    folder: string;
    pruned: number;
    kept: number;
    /** Every key up to this number is gone (0: nothing ever pruned). */
    prunedThrough: number;
}

/**
 * Prune the stored results of one folder to `retention`: the oldest keys
 * first — those beyond the newest `maxPerSession`, and those older than
 * `maxAgeDays` (by the file's time). Keys only grow, so what is pruned is
 * always every key up to one number; that number is recorded in the
 * folder's retention marker, so a read of a pruned key can say so and the
 * key is never given out again. Cheap when nothing is due: the folder is
 * listed, and only the oldest files are looked at.
 */
export function pruneToolResultFolder(folder: string, retention: ToolResultRetention, now: number = Date.now()): ToolResultPrune {
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { return { folder, pruned: 0, kept: 0, prunedThrough: 0 }; }
    const keys = names
        .map((n) => /^t(\d+)\.json$/.exec(n))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b);
    let cut = retention.maxPerSession > 0 ? Math.max(0, keys.length - retention.maxPerSession) : 0;
    if (retention.maxAgeDays > 0) {
        const cutoff = now - retention.maxAgeDays * 24 * 60 * 60 * 1000;
        // From the oldest on, until a result young enough: everything before it goes.
        while (cut < keys.length) {
            let mtime: number;
            try { mtime = fs.statSync(path.join(folder, `t${keys[cut]}.json`)).mtimeMs; } catch { mtime = 0; }
            if (mtime >= cutoff) { break; }
            cut++;
        }
    }
    const before = readToolResultRetentionMarker(folder)?.prunedThrough ?? 0;
    if (cut === 0) { return { folder, pruned: 0, kept: keys.length, prunedThrough: before }; }
    for (const key of keys.slice(0, cut)) {
        try { fs.unlinkSync(path.join(folder, `t${key}.json`)); } catch { /* gone already */ }
    }
    const marker: ToolResultRetentionMarker = {
        prunedThrough: Math.max(before, keys[cut - 1]),
        prunedAt: new Date(now).toISOString(),
        maxAgeDays: retention.maxAgeDays,
        maxPerSession: retention.maxPerSession,
    };
    try { fs.writeFileSync(path.join(folder, TOOL_RESULT_RETENTION_MARKER), JSON.stringify(marker, null, 2), 'utf8'); } catch { /* the files are gone anyway */ }
    return { folder, pruned: cut, kept: keys.length - cut, prunedThrough: marker.prunedThrough };
}

/**
 * Prune every tool-results folder of `questId` to `retention`: each session's
 * and the subsystems' folders without a session. Run after each send (the
 * Anthropic handler), so no scheduler is needed; the first run takes a
 * quest's backlog.
 */
export function pruneQuestToolResults(questId: string | undefined, retention: ToolResultRetention = configuredToolResultRetention(), now: number = Date.now()): ToolResultPrune[] {
    const quest = questId || WsPaths.getWorkspaceQuestId();
    const folders = new Set<string>();
    for (const session of sessionsWithStorage(questHistoryRoot(quest))) { folders.add(resolveStoreDir('anthropic', quest, session)); }
    for (const subsystem of ['anthropic', 'localLlm'] as ToolResultSubsystem[]) {
        try { folders.add(resolveStoreDir(subsystem, quest)); } catch { /* no raw trail path */ }
    }
    return [...folders].map((folder) => pruneToolResultFolder(folder, retention, now)).filter((r) => r.pruned > 0);
}

/** Whether `key` of a folder was pruned by retention: no file, and its number is up to the marker's. */
export function prunedToolResultInfo(
    key: string,
    questId?: string,
    session?: string,
): (ToolResultRetentionMarker & { folder: string }) | undefined {
    const m = /^t(\d+)$/.exec(key);
    if (!m) { return undefined; }
    const n = Number(m[1]);
    const folders = session ? [resolveStoreDir('anthropic', questId, session)] : [];
    for (const subsystem of ['anthropic', 'localLlm'] as ToolResultSubsystem[]) {
        try { folders.push(resolveStoreDir(subsystem, questId)); } catch { /* no raw trail path */ }
    }
    for (const folder of folders) {
        const marker = readToolResultRetentionMarker(folder);
        if (marker && n <= marker.prunedThrough && !fs.existsSync(path.join(folder, `${key}.json`))) { return { ...marker, folder }; }
    }
    return undefined;
}
