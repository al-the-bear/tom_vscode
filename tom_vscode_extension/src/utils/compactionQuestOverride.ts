/**
 * A quest's own compaction settings over the workspace's.
 *
 * The workspace config (`compaction` in `.tom/tom_vscode_extension.json`)
 * applies to every quest. A quest can override part of it in its
 * machine-independent `extension_config.<quest>.yaml`, section `compaction`:
 * switch compaction on or off, or point it at another model, for that quest
 * only. Only the known keys are taken, each only with a value of the right
 * type; everything else falls back to the workspace setting.
 *
 * vscode-free.
 */

/** The section key in `extension_config.<quest>.yaml`. */
export const SECTION_COMPACTION = 'compaction';

const BOOLEAN_KEYS = ['disabled', 'runMemoryExtractionOnCompaction', 'archiveHistoryEveryTurn'] as const;
const STRING_KEYS = ['llmConfigId', 'compactionTemplateId', 'memoryExtractionTemplateId'] as const;
const COUNT_KEYS = [
    'runEveryNRounds', 'rawTurnsKept', 'maxHistoryTokens', 'historyMaxChars', 'memoryMaxChars',
    'compactionMaxRounds', 'toolTrailMaxResultChars', 'toolTrailKeepRounds', 'fullTrailMaxTurns', 'rebuildFromLastNPrompts',
] as const;

/** `workspace` with the valid entries of the quest's `compaction` section applied. */
export function applyQuestCompactionOverride<T extends object>(workspace: T, quest: unknown): T {
    if (typeof quest !== 'object' || quest === null || Array.isArray(quest)) { return workspace; }
    const q = quest as Record<string, unknown>;
    const out = { ...workspace } as Record<string, unknown>;
    for (const k of BOOLEAN_KEYS) { if (typeof q[k] === 'boolean') { out[k] = q[k]; } }
    for (const k of STRING_KEYS) { if (typeof q[k] === 'string' && q[k] !== '') { out[k] = q[k]; } }
    for (const k of COUNT_KEYS) {
        const v = q[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) { out[k] = v; }
    }
    if (q.llmProvider === 'anthropic' || q.llmProvider === 'localLlm') { out.llmProvider = q.llmProvider; }
    return out as T;
}
