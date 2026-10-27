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
import { sessionToolResultsFolder } from './sessionStorage';
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
