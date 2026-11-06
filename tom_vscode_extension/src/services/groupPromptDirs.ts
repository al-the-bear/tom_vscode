/**
 * The workspace's group prompt folders (`_ai/group_prompts/` and a quest's
 * `_ai/quests/<quest>/group_prompts/`), for the store in groupPromptStore.ts.
 */

import { WsPaths } from '../utils/workspacePaths';
import { groupPromptDirsUnder, type GroupPromptDirs } from './groupPromptStore';

/** The folders for `questId`; undefined without a workspace. */
export function groupPromptDirs(questId: string | undefined): GroupPromptDirs | undefined {
    const aiRoot = WsPaths.ai('');
    return aiRoot ? groupPromptDirsUnder(aiRoot, questId) : undefined;
}
