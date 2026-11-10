/**
 * tomAi_getQuestWindowStatus — which VS Code windows run on this machine, what
 * is active in each, each quest's sessions and the Anthropic profiles: what an
 * agent (or an MCP client) looks up before it sends an item to another quest
 * with tomAi_sendItemToQuest. Read-only; the answer is built by
 * src/utils/questWindowStatus.ts from the window-state files, the session files
 * and the workspace config.
 *
 * vscode-free: the live access is wired in chat-enhancement-tools.ts.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import { buildQuestWindowStatus, type QuestWindowStatusInput } from '../utils/questWindowStatus';

export interface GetQuestWindowStatusInput {
    quest?: string;
    includeGone?: boolean;
}

/** What the tool reads, besides the input. */
export interface QuestWindowStatusAccess {
    /** `_ai/quests/<quest>/` exists. */
    questExists(quest: string): boolean;
    /** Everything but the input's `quest` / `includeGone`. */
    snapshot(): Omit<QuestWindowStatusInput, 'quest' | 'includeGone'>;
}

export async function getQuestWindowStatusImpl(access: QuestWindowStatusAccess, input: GetQuestWindowStatusInput): Promise<string> {
    try {
        const quest = typeof input.quest === 'string' && input.quest.trim() !== '' ? input.quest.trim() : undefined;
        if (quest && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(quest) || !access.questExists(quest))) {
            return JSON.stringify({ ok: false, code: 'unknownQuest', error: `There is no quest "${quest}" (_ai/quests/${quest}/).` });
        }
        const status = buildQuestWindowStatus({ ...access.snapshot(), ...(quest ? { quest } : {}), includeGone: input.includeGone === true });
        return JSON.stringify({ ok: true, ...status }, null, 2);
    } catch (e) {
        return JSON.stringify({ ok: false, error: (e as Error).message });
    }
}

export const GET_QUEST_WINDOW_STATUS_DESCRIPTION =
    'The VS Code windows on THIS machine and what each is doing, each quest\'s sessions and the Anthropic profiles — what to look up before tomAi_sendItemToQuest. `windows`: quest, `alive` (heartbeat within 90 s), servers, role, process position, the ANTHROPIC/LLM panel\'s profile and session, the queue, `build` (`reloadNeeded`), `dartBinaries` (tom_bs / validate_codespecs / spec_checks on its platform). `quests`: sessions with the profile each runs with. `profiles`: what a sent item may name (`noApiKey`). `quest` narrows it; `includeGone` adds windows without a heartbeat. Read-only.';

export const GET_QUEST_WINDOW_STATUS_TOOL: SharedToolDefinition<GetQuestWindowStatusInput> = {
    name: 'tomAi_getQuestWindowStatus',
    displayName: 'Quest Window Status',
    description: GET_QUEST_WINDOW_STATUS_DESCRIPTION,
    tags: ['queue', 'anthropic', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            quest: { type: 'string', description: 'Only this quest\'s windows and sessions.' },
            includeGone: { type: 'boolean', description: 'Also list windows without a live heartbeat (alive: false).' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by chat-enhancement-tools.ts"}',
};
