/**
 * Named Agent SDK sessions for agents:
 *
 *   tomAi_listSessions   the quest's sessions and how the next prompt in each starts
 *   tomAi_createSession  a new session, fresh or based on another one, with a lifetime and a profile
 *
 * A queue item names its session with `session` on tomAi_addQueueItem /
 * tomAi_updateQueueItem, so an agent that prepares a step's work can run each
 * prompt in a session re-created from a prepared base. The files and rules are
 * src/services/agentSdkSessionStore.ts and src/utils/agentSdkSessions.ts.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import { createSession, listSessions, planSessionStartIn } from '../services/agentSdkSessionStore';
import { normalizeSessionMode } from '../utils/agentSdkSessions';
import { lookupProfile, type ProfileSection, type SessionProfile } from '../utils/sessionSpecs';

export interface SessionToolDeps {
    /** The active quest's history folder. */
    folder(): string;
    quest(): string;
    /** The Anthropic profile with this id, and its model; undefined when there is none. */
    profile(id: string): SessionProfile | undefined;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

function nextPromptText(folder: string, name: string): string {
    try {
        const start = planSessionStartIn(folder, name);
        if (start.note) { return start.note; }
        if (!start.resume) { return start.persist ? 'starts a new conversation' : 'starts fresh; nothing is saved'; }
        // A per-iteration session asked without an iteration key: a queue iteration starts its own conversation.
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
            ...(s.profileId ? { profile: s.profileId } : {}),
            ...(s.model ? { model: s.model } : {}),
            hasConversation: !!s.sessionId || !!s.iteration?.sessionId,
            nextPrompt: nextPromptText(folder, s.name),
            ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
        })),
        note: 'The chat panel uses `chat` and the prompt queue `default` unless another session is chosen. '
            + 'A prompt runs with its queue item\'s profile, else its session\'s, else the queue default.',
    });
}

export interface CreateSessionInput {
    name: string;
    basedOn?: string;
    /** continue, per-prompt or per-iteration; the legacy fork-from-base reads as per-prompt. */
    mode?: string;
    /** An Anthropic profile id. */
    profile?: string;
}

export async function createSessionImpl(deps: SessionToolDeps, input: CreateSessionInput): Promise<string> {
    const mode = input.mode === undefined || input.mode === '' ? undefined : normalizeSessionMode(input.mode);
    if (input.mode !== undefined && input.mode !== '' && !mode) {
        return json({ ok: false, error: `mode must be "continue", "per-prompt" or "per-iteration", not "${String(input.mode)}".` });
    }
    let profile: SessionProfile | undefined;
    if (input.profile) {
        profile = deps.profile(input.profile);
        if (!profile) { return json({ ok: false, error: `There is no Anthropic profile "${input.profile}".` }); }
    }
    const r = createSession(deps.folder(), String(input.name ?? ''), {
        basedOn: input.basedOn || undefined,
        mode,
        ...(profile ? { profile: { id: profile.id, model: profile.model } } : {}),
    });
    return json(r.ok ? { ok: true, session: r.session, quest: deps.quest() } : r);
}

function liveDeps(): SessionToolDeps {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TwoTierMemoryService } = require('../services/memory-service') as typeof import('../services/memory-service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WsPaths } = require('../utils/workspacePaths') as typeof import('../utils/workspacePaths');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadSendToChatConfig } = require('../utils/sendToChatConfig') as typeof import('../utils/sendToChatConfig');
    return {
        folder: () => TwoTierMemoryService.instance.agentSdkSessionsFolder(WsPaths.getWorkspaceQuestId() || undefined),
        quest: () => WsPaths.getWorkspaceQuestId(),
        profile: (id) => lookupProfile(loadSendToChatConfig()?.anthropic as ProfileSection | undefined, id),
    };
}

export const LIST_SESSIONS_TOOL: SharedToolDefinition<Record<string, never>> = {
    name: 'tomAi_listSessions',
    displayName: 'List Sessions',
    description:
        'The named sessions of the active quest (`<name>.session.json` in its history folder; the Agent SDK conversation, '
        + 'or on the direct API transport the session\'s own history): each with its '
        + '`mode` (`continue`: prompts continue the session; `per-prompt`: every prompt starts again — from the base '
        + 'session\'s conversation, or fresh without a base — and changes nothing; `per-iteration`: one conversation per '
        + 'queue iteration, i.e. repeat round or `<prefix>*` todo, its pre-prompts and follow-ups included), its `basedOn`, '
        + 'its `profile` and `model` (the Anthropic profile it runs with unless a queue item names its own; without one the '
        + 'queue default), whether it has a conversation yet, and how the next prompt in it starts. A queue item runs in a '
        + 'session named by `session` on tomAi_addQueueItem / tomAi_updateQueueItem.',
    tags: ['queue', 'session', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (input) => listSessionsImpl(liveDeps(), input),
};

export const CREATE_SESSION_TOOL: SharedToolDefinition<CreateSessionInput> = {
    name: 'tomAi_createSession',
    displayName: 'Create Session',
    description:
        'Create a named session in the active quest (Agent SDK and direct API transport alike), fresh (no `basedOn`) or '
        + 'based on another session, with a lifetime: `continue` (default; with a base, its first prompt starts from the '
        + 'base\'s conversation and later prompts continue it), `per-prompt` (every prompt starts again from the base, or '
        + 'fresh without one, and changes nothing — the base can hold preparatory context, e.g. one todo per prompt; '
        + '`fork-from-base` is the old name) or `per-iteration` (one conversation per queue iteration: each repeat round '
        + 'or `<prefix>*` todo starts from the base, or fresh, and its pre-prompts and follow-ups continue it). '
        + '`profile` (an Anthropic profile id) is the profile its prompts run with unless a queue item names its own; '
        + 'its model is stored too. A based session without a profile takes the base\'s. Refuses an existing name, a '
        + 'missing base, an unknown lifetime and an unknown profile. Answers the session with its profile and model. '
        + 'Run prompts in it with `session` on tomAi_addQueueItem.',
    tags: ['queue', 'session', 'tom-ai-chat'],
    readOnly: false,
    // A session file is state, not content; visible in the session pickers.
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Letters, digits, "_" and "-", starting with a letter or digit.' },
            basedOn: { type: 'string', description: 'The session the new one starts from.' },
            mode: { type: 'string', enum: ['continue', 'per-prompt', 'per-iteration', 'fork-from-base'], description: 'Default `continue`; `fork-from-base` = `per-prompt`.' },
            profile: { type: 'string', description: 'Anthropic profile id the session runs with.' },
        },
        required: ['name'],
    },
    execute: async (input) => createSessionImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SESSION_TOOLS: SharedToolDefinition<any>[] = [LIST_SESSIONS_TOOL, CREATE_SESSION_TOOL];
