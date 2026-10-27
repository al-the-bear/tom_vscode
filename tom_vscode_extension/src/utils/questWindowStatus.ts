/**
 * What tomAi_getQuestWindowStatus answers — pure, over what the window-state
 * files (`_ai/local/<window>.window-state.json`), the session files and the
 * workspace config say; nothing is read or written here.
 *
 * - **windows**: the windows of THIS host (a file names its `host`, else its
 *   window id ends with this machine's id), with `alive` by the heartbeat rule
 *   (src/utils/windowHeartbeat.ts), the servers, the subsystems active, and
 *   what each window writes about itself ({@link WindowActivity}): role,
 *   process position, the ANTHROPIC panel's profile and session, the queue
 *   summary and the item being sent. Gone windows are left out unless asked.
 * - **quests**: per quest with a live window (and the quest asked for): its
 *   sessions — the same rows as the SESSIONS view (src/utils/sessionsViewRows.ts),
 *   with each profile resolved and temporary sessions (`tmp-*`) flagged — and
 *   the queue's default session.
 * - **profiles**: the Anthropic profiles a sent item may name, the default
 *   marked, and which one an item without its own would run with in each
 *   session (item → session → queue default).
 *
 * Wherever a profile is named it is `{id, name, model, transport}` from the
 * workspace config; an id the config no longer holds is `unknownProfile: true`.
 */

import type { SessionRecord } from './agentSdkSessions';
import { sessionRows } from './sessionsViewRows';
import { HEARTBEAT_STALE_MS, isWindowAlive, type HeartbeatState } from './windowHeartbeat';

// ---------------------------------------------------------------------------
// What a window writes about itself
// ---------------------------------------------------------------------------

/** The process position a window's quest stands at (processStateStore). */
export interface WindowProcessPosition {
    process: string;
    phase?: string;
    phaseIteration?: number;
    step?: string;
    stepIteration?: number;
    substep?: string;
    substepIteration?: number;
    decision?: boolean;
    completed?: boolean;
}

/** The item a window's queue is sending now. */
export interface WindowSendingItem {
    id: string;
    /** The first 80 characters of its prompt. */
    preview: string;
    /** pre-prompt / main / follow-up. */
    stage?: string;
    transport?: string;
    profileId?: string;
    session?: string;
    /** ISO time the send started. */
    since?: string;
}

/** The queue of a window, summed up. */
export interface WindowQueueSummary {
    autoSend: boolean;
    /** A sending item held by "pause" / auto-send off. */
    paused: boolean;
    /** Items per status. */
    counts: Record<string, number>;
    defaultTransport?: string;
    defaultProfileId?: string;
    defaultSession?: string;
    sending?: WindowSendingItem;
}

/** What a window writes about itself into its state file, besides the heartbeat. */
export interface WindowActivity {
    /** os.hostname() of the window's machine. */
    host?: string;
    role?: string;
    process?: WindowProcessPosition | null;
    /** The ANTHROPIC panel: its selected profile and its session. */
    panel?: { profileId?: string; session?: string };
    queue?: WindowQueueSummary;
}

/** A window-state file as this module reads it. */
export interface WindowStateInput extends HeartbeatState, WindowActivity {
    windowId: string;
    workspace: string;
    activeQuest: string;
    status?: Array<{ subsystem: string; status: string }>;
    aiConversationActive?: boolean;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** The `anthropic` section of the workspace config, as far as profiles go. */
export interface ProfileConfig {
    profiles?: Array<{ id?: string; name?: string; configurationId?: string; isDefault?: boolean } | null | undefined>;
    configurations?: Array<{ id?: string; model?: string; transport?: string } | null | undefined>;
}

/** A profile as the answer names it. */
export interface ResolvedProfile {
    id: string;
    name?: string;
    model?: string;
    transport?: string;
    /** The workspace config holds no profile with this id (renamed or removed since). */
    unknownProfile?: true;
}

/** A profile id resolved against the config; undefined for none. */
export function resolveProfile(config: ProfileConfig | undefined, id: string | undefined): ResolvedProfile | undefined {
    if (!id) { return undefined; }
    const profile = (config?.profiles ?? []).find((p) => p?.id === id);
    if (!profile) { return { id, unknownProfile: true }; }
    const configuration = (config?.configurations ?? []).find((c) => !!c && c.id === profile.configurationId);
    return {
        id,
        name: profile.name || id,
        ...(configuration?.model ? { model: configuration.model } : {}),
        transport: configuration?.transport ?? 'direct',
    };
}

/** A profile in the `profiles` list. */
export interface ProfileListEntry extends ResolvedProfile {
    isDefault: boolean;
    /** A direct-API profile whose key variable is not in this VS Code's environment. */
    noApiKey: boolean;
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface WindowStatusEntry {
    windowId: string;
    workspace: string;
    quest: string;
    alive: boolean;
    /** Seconds since the last heartbeat; absent without one. */
    heartbeatAgeSeconds?: number;
    pid?: number;
    cliServer?: { running: boolean; port?: number };
    mcpServer?: { running: boolean; host?: string; port?: number };
    /** queue / anthropic / copilot / … whose prompt is out, and the AI conversation. */
    activeSubsystems: string[];
    aiConversationActive: boolean;
    role?: string;
    process?: WindowProcessPosition | null;
    panel?: { profile?: ResolvedProfile; session?: string };
    queue?: Omit<WindowQueueSummary, 'defaultProfileId' | 'sending'> & {
        defaultProfile?: ResolvedProfile;
        sending?: Omit<WindowSendingItem, 'profileId'> & { profile?: ResolvedProfile };
    };
    isThisWindow: boolean;
}

export interface QuestSessionEntry {
    name: string;
    /** `default` (the queue's) and `chat` (the ANTHROPIC panel's) exist without a file. */
    implicit?: true;
    usedBy?: string;
    basedOn?: string;
    /** continue / per-prompt / per-iteration. */
    lifetime: string;
    profile?: ResolvedProfile;
    /** The model the last send in it reported. */
    model?: string;
    hasConversation: boolean;
    createdAt?: string;
    updatedAt?: string;
    /** A temporary session of a sent item (`tmp-*`): deleted once its item is done. */
    temporary?: true;
    /** The profile an item without its own runs with here: the session's, else the queue default. */
    effectiveProfile?: ResolvedProfile;
}

export interface QuestStatusEntry {
    quest: string;
    windows: string[];
    sessions: QuestSessionEntry[];
    /** The queue's default session, from a live window of the quest. */
    queueDefaultSession?: string;
}

export interface QuestWindowStatus {
    host: string;
    windows: WindowStatusEntry[];
    quests: QuestStatusEntry[];
    profiles: ProfileListEntry[];
}

/** What the status is built from. */
export interface QuestWindowStatusInput {
    states: WindowStateInput[];
    /** The session files of a quest's history folder. */
    sessionsOf(quest: string): SessionRecord[];
    config: ProfileConfig | undefined;
    /** Profile ids whose direct-API key is missing in this environment. */
    noApiKey: ReadonlySet<string>;
    thisHost: string;
    /** The first 8 characters of this machine's id (the second half of a window id). */
    thisMachine: string;
    thisWindowId: string;
    nowMs: number;
    /** Only this quest's windows and sessions. */
    quest?: string;
    includeGone?: boolean;
}

function onThisHost(s: WindowStateInput, host: string, machine: string): boolean {
    if (s.host) { return s.host === host; }
    return s.windowId.endsWith(`_${machine}`);
}

const MODE_TEXT: Record<string, string> = { continue: 'continue', 'per-prompt': 'per-prompt', 'per-iteration': 'per-iteration' };

/** Build the answer of tomAi_getQuestWindowStatus. */
export function buildQuestWindowStatus(input: QuestWindowStatusInput): QuestWindowStatus {
    const { config, nowMs } = input;
    const resolve = (id: string | undefined): ResolvedProfile | undefined => resolveProfile(config, id);

    const windows: WindowStatusEntry[] = input.states
        .filter((s) => onThisHost(s, input.thisHost, input.thisMachine))
        .filter((s) => !input.quest || s.activeQuest === input.quest || (!s.activeQuest && s.workspace === input.quest))
        .map((s): WindowStatusEntry => {
            const at = s.heartbeat ? Date.parse(s.heartbeat) : NaN;
            const q = s.queue;
            return {
                windowId: s.windowId,
                workspace: s.workspace,
                quest: s.activeQuest || '',
                alive: isWindowAlive(s, nowMs, HEARTBEAT_STALE_MS),
                ...(Number.isFinite(at) ? { heartbeatAgeSeconds: Math.max(0, Math.round((nowMs - at) / 1000)) } : {}),
                ...(s.pid ? { pid: s.pid } : {}),
                ...(s.cliServer ? { cliServer: s.cliServer } : {}),
                ...(s.mcpServer ? { mcpServer: s.mcpServer } : {}),
                activeSubsystems: (s.status ?? []).filter((x) => x.status === 'prompt-sent').map((x) => x.subsystem),
                aiConversationActive: s.aiConversationActive === true,
                ...(s.role ? { role: s.role } : {}),
                ...(s.process !== undefined ? { process: s.process } : {}),
                ...(s.panel ? {
                    panel: {
                        ...(s.panel.profileId ? { profile: resolve(s.panel.profileId) } : {}),
                        ...(s.panel.session ? { session: s.panel.session } : {}),
                    },
                } : {}),
                ...(q ? {
                    queue: {
                        autoSend: q.autoSend,
                        paused: q.paused,
                        counts: q.counts,
                        ...(q.defaultTransport ? { defaultTransport: q.defaultTransport } : {}),
                        ...(q.defaultProfileId ? { defaultProfile: resolve(q.defaultProfileId) } : {}),
                        ...(q.defaultSession ? { defaultSession: q.defaultSession } : {}),
                        ...(q.sending ? {
                            sending: (({ profileId, ...rest }) => ({ ...rest, ...(profileId ? { profile: resolve(profileId) } : {}) }))(q.sending),
                        } : {}),
                    },
                } : {}),
                isThisWindow: s.windowId === input.thisWindowId,
            };
        })
        .filter((w) => w.alive || input.includeGone || w.isThisWindow);

    const defaultProfileId = (config?.profiles ?? []).find((p) => p?.isDefault)?.id ?? undefined;
    const questNames = new Set<string>();
    for (const w of windows) { if (w.alive && w.quest) { questNames.add(w.quest); } }
    if (input.quest) { questNames.add(input.quest); }

    const quests: QuestStatusEntry[] = [...questNames].sort().map((quest) => {
        const live = windows.filter((w) => w.alive && w.quest === quest);
        const queueWindow = live.find((w) => w.queue);
        const queueDefaultProfileId = queueWindow?.queue?.defaultProfile?.id ?? defaultProfileId;
        const records = input.sessionsOf(quest);
        const byName = new Map(records.map((r) => [r.name, r]));
        const sessions = sessionRows(records).map((row): QuestSessionEntry => {
            const r = byName.get(row.name);
            const profileId = r?.profileId;
            return {
                name: row.name,
                ...(row.usedBy ? { implicit: true as const, usedBy: row.usedBy } : {}),
                ...(row.basedOn ? { basedOn: row.basedOn } : {}),
                lifetime: MODE_TEXT[r?.mode ?? 'continue'] ?? 'continue',
                ...(profileId ? { profile: resolve(profileId) } : {}),
                ...(row.model ? { model: row.model } : {}),
                hasConversation: row.hasConversation,
                ...(r?.createdAt ? { createdAt: r.createdAt } : {}),
                ...(r?.updatedAt ? { updatedAt: r.updatedAt } : {}),
                ...(row.temporary ? { temporary: true as const } : {}),
                ...((profileId ?? queueDefaultProfileId) ? { effectiveProfile: resolve(profileId ?? queueDefaultProfileId) } : {}),
            };
        });
        return {
            quest,
            windows: live.map((w) => w.windowId),
            sessions,
            ...(queueWindow?.queue?.defaultSession ? { queueDefaultSession: queueWindow.queue.defaultSession } : {}),
        };
    });

    const profiles: ProfileListEntry[] = (config?.profiles ?? [])
        .filter((p): p is NonNullable<typeof p> & { id: string } => !!p && typeof p.id === 'string' && p.id !== '')
        .map((p) => ({
            ...(resolve(p.id) as ResolvedProfile),
            isDefault: p.isDefault === true,
            noApiKey: input.noApiKey.has(p.id),
        }));

    return { host: input.thisHost, windows, quests, profiles };
}
