/**
 * Named Agent SDK sessions for agents:
 *
 *   tomAi_listSessions   the quest's sessions and how the next prompt in each starts
 *   tomAi_createSession  a new session, fresh or based on another one
 *
 * A queue item names its session with `session` on tomAi_addQueueItem /
 * tomAi_updateQueueItem, so an agent that prepares a step's work can run each
 * prompt in a session re-created from a prepared base. The files and rules are
 * src/services/agentSdkSessionStore.ts and src/utils/agentSdkSessions.ts.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import { createSession, listSessions, planSessionStartIn } from '../services/agentSdkSessionStore';
import type { SessionMode } from '../utils/agentSdkSessions';

export interface SessionToolDeps {
    /** The active quest's history folder. */
    folder(): string;
    quest(): string;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

function nextPromptText(folder: string, name: string): string {
    try {
        const start = planSessionStartIn(folder, name);
        if (start.note) { return start.note; }
        if (!start.resume) { return start.persist ? 'starts a new conversation' : 'starts fresh; nothing is saved'; }
        if (!start.fork) { return 'continues its conversation'; }
        return start.persist ? 'starts from a fork of the base\'s conversation, then continues on its own'
            : 'starts from a fork of the base\'s conversation; nothing is saved';
    } catch (e) {
        return `cannot start: ${(e as Error).message}`;
    }
}

export async function listSessionsImpl(deps: SessionToolDeps, _input: Record<string, never>): Promise<string> {
    const folder = deps.folder();
    return json({
        ok: true,
        quest: deps.quest(),
        sessions: listSessions(folder).map((s) => ({
            name: s.name,
            mode: s.mode,
            ...(s.basedOn ? { basedOn: s.basedOn } : {}),
            hasConversation: !!s.sessionId,
            nextPrompt: nextPromptText(folder, s.name),
            ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        })),
        note: 'The chat panel uses `chat` and the prompt queue `default` unless another session is chosen.',
    });
}

export interface CreateSessionInput {
    name: string;
    basedOn?: string;
    mode?: SessionMode;
}

export async function createSessionImpl(deps: SessionToolDeps, input: CreateSessionInput): Promise<string> {
    if (input.mode !== undefined && input.mode !== 'continue' && input.mode !== 'fork-from-base') {
        return json({ ok: false, error: `mode must be "continue" or "fork-from-base", not "${String(input.mode)}".` });
    }
    const r = createSession(deps.folder(), String(input.name ?? ''), { basedOn: input.basedOn || undefined, mode: input.mode });
    return json(r.ok ? { ok: true, session: r.session, quest: deps.quest() } : r);
}

function liveDeps(): SessionToolDeps {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TwoTierMemoryService } = require('../services/memory-service') as typeof import('../services/memory-service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    return {
        folder: () => TwoTierMemoryService.instance.agentSdkSessionsFolder(WsPaths.getWorkspaceQuestId() || undefined),
        quest: () => WsPaths.getWorkspaceQuestId(),
    };
}

export const LIST_SESSIONS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listSessions',
    displayName: 'List Sessions',
    description:
        'The named sessions of the active quest (`<name>.session.json` in its history folder; the Agent SDK conversation, '
        + 'or on the direct API transport the session\'s own history): each with its '
        + '`mode` (`continue`: prompts continue the session; `fork-from-base`: every prompt starts again from the base '
        + 'session\'s conversation and changes nothing), its `basedOn`, whether it has a conversation yet, and how the next '
        + 'prompt in it starts. A queue item runs in a session named by `session` on tomAi_addQueueItem / '
        + 'tomAi_updateQueueItem.',
    tags: ['queue', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (input) => listSessionsImpl(liveDeps(), input),
};

export const CREATE_SESSION_TOOL: SharedToolDefinition<CreateSessionInput> = {
    name: 'tomAi_createSession',
    displayName: 'Create Session',
    description:
        'Create a named session in the active quest (Agent SDK and direct API transport alike). Fresh (no `basedOn`), or based on another session: with '
        + '`mode: "continue"` its first prompt starts from the base\'s conversation and later prompts continue it; with '
        + '`mode: "fork-from-base"` every prompt starts again from the base, so the base can hold preparatory context '
        + 'while the prompts never change each other\'s context (e.g. one todo per prompt). Refuses an existing name, a '
        + 'missing base, and fork-from-base without a base. Run prompts in it with `session` on tomAi_addQueueItem.',
    tags: ['queue', 'session', 'tom-ai-chat'],
    readOnly: false,
    // A session file is state, not content; visible in the session pickers.
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Letters, digits, "_" and "-", starting with a letter or digit.' },
            basedOn: { type: 'string', description: 'The session the new one starts from.' },
            mode: { type: 'string', enum: ['continue', 'fork-from-base'], description: 'Default `continue`.' },
        },
        required: ['name'],
    },
    execute: async (input) => createSessionImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SESSION_TOOLS: SharedToolDefinition<any>[] = [LIST_SESSIONS_TOOL, CREATE_SESSION_TOOL];
