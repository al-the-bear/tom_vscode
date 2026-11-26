/**
 * The configuration files of a quest and where they live: the folder `config/` of the quest folder
 * (ai_format_migration.md § 3.2).
 *
 *   <quest folder>/config/process-state.<quest>.yaml           the `default` run's process state
 *   <quest folder>/config/process-state.<quest>.<run>.yaml     another run's (processRuns.ts)
 *   <quest folder>/config/extension_config.<quest>.yaml        the extension settings, the same on every host
 *   <quest folder>/config/extension_config.<host>.<quest>.yaml one host's extension settings
 *
 * Every reader and writer of these files builds the path here. Pure path rules, no `fs`, no `vscode`.
 */

import * as path from 'path';

import { DEFAULT_RUN, runStateFileName } from './processRuns';

/** The folder of a quest folder that holds its process states and extension configurations. */
export const QUEST_CONFIG_FOLDER = 'config';

/** The `config/` folder of the quest whose folder is `questFolder` (an empty input stays empty). */
export function questConfigFolder(questFolder: string): string {
    if (!questFolder) { return ''; }
    return path.join(questFolder, QUEST_CONFIG_FOLDER);
}

/** The process state file of `run` of `quest`, in the quest folder `questFolder`. */
export function processStateFile(questFolder: string, quest: string, run: string = DEFAULT_RUN): string {
    return path.join(questConfigFolder(questFolder), runStateFileName(quest, run));
}

/** The file name of the quest's machine-independent extension configuration. */
export function sharedExtensionConfigFileName(quest: string): string {
    return `extension_config.${quest}.yaml`;
}

/** The file name of one host's extension configuration of the quest. */
export function hostExtensionConfigFileName(host: string, quest: string): string {
    return `extension_config.${host}.${quest}.yaml`;
}

/** The quest's machine-independent extension configuration, in the quest folder `questFolder`. */
export function sharedExtensionConfigFile(questFolder: string, quest: string): string {
    return path.join(questConfigFolder(questFolder), sharedExtensionConfigFileName(quest));
}

/** One host's extension configuration of the quest, in the quest folder `questFolder`. */
export function hostExtensionConfigFile(questFolder: string, host: string, quest: string): string {
    return path.join(questConfigFolder(questFolder), hostExtensionConfigFileName(host, quest));
}

/** Whether `name` is a file name of the config families (`process-state.*.yaml`, `extension_config.*.yaml`). */
export function isQuestConfigFileName(name: string): boolean {
    return /^(?:process-state|extension_config)\..+\.yaml$/.test(name);
}
