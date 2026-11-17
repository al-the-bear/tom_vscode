/**
 * The five `_ai` merge drivers in TypeScript, shipped with the extension
 * (vscimpb142c): `ai-trail`, `ai-history-json`, `ai-history-md`,
 * `ai-block-history`, `ai-yaml-smart` — the ports of the Python drivers in
 * al_the_bear/.claude/skills/_lib/merge_drivers/, with the same results on
 * their fixtures (aiMergeDriversParity.test.ts). The `_ai` format migration
 * calls them directly ({@link makeBuiltinMerger}); git calls them through
 * `out/utils/aiMergeDriverCli.js` once registered (utils/aiMergeDriverSetup.ts).
 *
 * vscode-free.
 */

import * as fs from 'fs';

import { mergeBlockHistory } from './blockHistory';
import type { MergeOutcome, MergeSides } from './common';
import { mergeHistoryJson } from './historyJson';
import { mergeHistoryMd } from './historyMd';
import { mergeTrail } from './trail';
import { mergeYamlSmart } from './yamlSmart';

export type { MergeOutcome, MergeSides } from './common';

/** The drivers by the names `.gitattributes` binds files to. */
export const AI_MERGE_DRIVERS = {
    'ai-yaml-smart': mergeYamlSmart,
    'ai-block-history': mergeBlockHistory,
    'ai-trail': mergeTrail,
    'ai-history-json': mergeHistoryJson,
    'ai-history-md': mergeHistoryMd,
} as const;

export type AiMergeDriverName = keyof typeof AI_MERGE_DRIVERS;

export const AI_MERGE_DRIVER_NAMES = Object.keys(AI_MERGE_DRIVERS) as AiMergeDriverName[];

/** The `merge.<driver>.name` git shows. */
export const AI_MERGE_DRIVER_TITLES: Record<AiMergeDriverName, string> = {
    'ai-yaml-smart': 'AI state YAML smart merge',
    'ai-block-history': 'AI compacted_history.md block merge',
    'ai-trail': 'AI trail block/timestamp merge',
    'ai-history-json': 'AI history.json timestamp merge',
    'ai-history-md': 'AI history.md timestamp merge',
};

export function isAiMergeDriver(name: string): name is AiMergeDriverName {
    return Object.prototype.hasOwnProperty.call(AI_MERGE_DRIVERS, name);
}

/** Merge two texts with `driver`. */
export function mergeWith(driver: AiMergeDriverName, sides: MergeSides): MergeOutcome {
    return AI_MERGE_DRIVERS[driver](sides);
}

/** A side's text as Python's `Path.read_text()` gives it: `\r\n` and `\r` read as `\n`; undefined when missing. */
function readIf(file: string): string | undefined {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
    return text.replace(/\r\n?/g, '\n');
}

/**
 * Run `driver` as git does: %O %A %B %P; the result written to %A with LF line endings. Answers the exit
 * code (0 merged, 1 git keeps its conflict markers) and the message for stderr.
 */
export function runMergeDriverOnFiles(driver: AiMergeDriverName, ancestor: string, ours: string, theirs: string, display = ''): { code: number; message?: string } {
    const outcome = mergeWith(driver, { ancestor: readIf(ancestor), ours: readIf(ours), theirs: readIf(theirs), display });
    if (outcome.status === 'fail') { return { code: 1, message: outcome.message }; }
    if (outcome.status === 'merged') { fs.writeFileSync(ours, outcome.text, 'utf8'); }
    return { code: 0 };
}

/**
 * The migration's merger (utils/aiFormatMigration.ts `merge`): `target` (ours, the file in its new place)
 * with `legacy` (theirs, the file in its old place), no git needed. Answers the merged text, or undefined
 * when the driver cannot merge them (a problem in the report).
 */
export function makeBuiltinMerger(): (driver: AiMergeDriverName, target: string, legacy: string) => string | undefined {
    return (driver, target, legacy) => {
        const ours = readIf(target);
        const outcome = mergeWith(driver, { ancestor: '', ours, theirs: readIf(legacy), display: target });
        if (outcome.status === 'fail') { return undefined; }
        return outcome.status === 'merged' ? outcome.text : ours ?? '';
    };
}
