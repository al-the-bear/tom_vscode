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
    'The VS Code windows running on THIS machine and what is active in each, the sessions of each quest, and the '
    + 'Anthropic profiles — what to look up before tomAi_sendItemToQuest. `windows`: per window its workspace, quest, '
    + '`alive` (a heartbeat within 90 s) and the heartbeat\'s age, pid, CLI and MCP server (running, port), the '
    + 'subsystems with a prompt out, the role, the process position, the ANTHROPIC panel\'s profile and session, the '
    + 'queue (auto-send, paused, counts per status, default transport / profile / session, the item being sent with its '
    + 'stage, profile and session) and `isThisWindow`; windows without a live heartbeat are left out unless '
    + '`includeGone`. `quests`: per quest with a live window, and the `quest` asked for even when none runs, its '
    + 'sessions (base, lifetime, profile, last model, whether it has a conversation, temporary `tmp-*` ones flagged, the '
    + 'implicit `default` and `chat`) with the profile an item without its own runs with in each (session, else queue '
    + 'default), and the queue\'s default session. `profiles`: the profiles a sent item may name (`isDefault`, '
    + '`noApiKey`). Every profile is `{id, name, model, transport}`; an id the config no longer holds is '
    + '`unknownProfile: true`. `quest` narrows the answer to that quest; an unknown quest is refused. Reads only.';

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
