/**
 * tomAi_sendItemToQuest — put a prompt into the queue of another quest's
 * window on this machine (src/utils/questInbox.ts: the inbox file the target
 * window takes up and turns into a queue item with its own defaults).
 *
 * The checks the sender can make are made here — an unknown quest, the
 * sender's own quest, an unknown profile, a session the target quest does
 * not have, a new session whose base is missing or whose name is taken — and
 * the target checks profile and session again when it converts the file.
 * `targetRunning` says whether a window of the target quest has a live
 * heartbeat (src/utils/windowHeartbeat.ts); without one the file waits until
 * a window of that quest starts.
 *
 * vscode-free: the live access is wired in chat-enhancement-tools.ts.
 */

import { SharedToolDefinition } from './shared-tool-registry';
import { isValidSessionName, normalizeSessionMode, type SessionRecord } from '../utils/agentSdkSessions';
import type { InboxItem, InboxNewSession } from '../utils/questInbox';

export interface SendItemToQuestInput {
    quest: string;
    text: string;
    template?: string;
    anthropicProfileId?: string;
    doneNotificationPrompt?: string;
    /** The quest the item's done notification is posted to; unset: the target quest. */
    doneNotificationQuest?: string;
    /** The process run its done notification is queued in. */
    doneNotificationRun?: string;
    pauseAfter?: boolean;
    session?: string;
    newSession?: { basedOn: string; name?: string; lifetime?: string; profile?: string };
    /** The target quest's process run the item is queued in; unset: `default`. */
    run?: string;
}

/** A window of the target quest, as its state file says. */
export interface TargetWindow {
    windowId: string;
    workspace: string;
}

/** What the tool needs from the extension. */
export interface QuestSendAccess {
    /** The quest of this window ('' or undefined: none). */
    currentQuest(): string | undefined;
    /** This window's process run. */
    currentRun(): string;
    /** Whether `quest` has the process run `run` (`default` always). */
    runExists(quest: string, run: string): boolean;
    /** `_ai/quests/<quest>/` exists. */
    questExists(quest: string): boolean;
    profileExists(id: string): boolean;
    /** The target quest's sessions (its history folder). */
    listSessions(quest: string): SessionRecord[];
    /** The windows of the quest with a live heartbeat. */
    liveWindows(quest: string): TargetWindow[];
    /** This window, as the item names its sender. */
    sender(): { windowId: string; host: string };
    /** Write the inbox file for the workspace; its path. */
    deliver(workspace: string, item: InboxItem): string;
    now(): Date;
}

function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

export async function sendItemToQuestImpl(access: QuestSendAccess, input: SendItemToQuestInput): Promise<string> {
    try {
        const quest = String(input.quest ?? '').trim();
        if (!quest) { return err('`quest` is required.', { code: 'invalidQuest' }); }
        if (!input.text || !String(input.text).trim()) { return err('`text` is required.'); }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(quest) || !access.questExists(quest)) {
            return err(`There is no quest "${quest}" (_ai/quests/${quest}/).`, { code: 'unknownQuest' });
        }
        if (access.currentQuest() === quest) {
            return err(`"${quest}" is this window's own quest: use tomAi_addQueueItem.`, { code: 'ownQuest' });
        }
        if (input.anthropicProfileId && !access.profileExists(input.anthropicProfileId)) {
            return err(`There is no Anthropic profile "${input.anthropicProfileId}" in this workspace.`, { code: 'unknownProfile' });
        }
        if (input.session && input.newSession) {
            return err('Give `session` or `newSession`, not both.', { code: 'invalidSession' });
        }
        const sessions = (input.session || input.newSession) ? access.listSessions(quest) : [];
        const names = sessions.map((s) => s.name);
        if (input.session && !names.includes(input.session)) {
            return err(`The quest "${quest}" has no session "${input.session}".`, { code: 'unknownSession', sessions: names });
        }
        let newSession: InboxNewSession | undefined;
        if (input.newSession) {
            const n = input.newSession;
            if (!n.basedOn || !names.includes(n.basedOn)) {
                return err(`The quest "${quest}" has no session "${n.basedOn ?? ''}" to base the new session on.`, { code: 'unknownSession', sessions: names });
            }
            if (n.name !== undefined && n.name !== '') {
                if (!isValidSessionName(n.name)) {
                    return err(`"${n.name}" is not a session name: letters, digits, "_" and "-", starting with a letter or digit.`, { code: 'invalidSession' });
                }
                if (names.includes(n.name)) {
                    return err(`The quest "${quest}" already has a session "${n.name}".`, { code: 'invalidSession', sessions: names });
                }
            }
            const lifetime = n.lifetime === undefined || n.lifetime === '' ? undefined : normalizeSessionMode(n.lifetime);
            if (n.lifetime && !lifetime) {
                return err(`"${n.lifetime}" is not a session lifetime: continue, per-prompt or per-iteration.`, { code: 'invalidSession' });
            }
            if (n.profile && !access.profileExists(n.profile)) {
                return err(`There is no Anthropic profile "${n.profile}" in this workspace.`, { code: 'unknownProfile' });
            }
            newSession = {
                basedOn: n.basedOn,
                ...(n.name ? { name: n.name } : {}),
                ...(lifetime ? { lifetime } : {}),
                ...(n.profile ? { profile: n.profile } : {}),
            };
        }
        const run = input.run?.trim() || undefined;
        if (run && !access.runExists(quest, run)) {
            return err(`The quest "${quest}" has no process run "${run}".`, { code: 'unknownRun' });
        }
        const dnQuest = input.doneNotificationQuest?.trim() || undefined;
        if (dnQuest && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(dnQuest) || !access.questExists(dnQuest))) {
            return err(`There is no quest "${dnQuest}" for the done notification.`, { code: 'unknownQuest' });
        }
        const dnRun = input.doneNotificationRun?.trim() || undefined;
        if (dnRun && !access.runExists(dnQuest ?? quest, dnRun)) {
            return err(`The quest "${dnQuest ?? quest}" has no process run "${dnRun}" for the done notification.`, { code: 'unknownRun' });
        }
        const me = access.sender();
        const item: InboxItem = {
            text: input.text,
            ...(input.template ? { template: input.template } : {}),
            ...(input.anthropicProfileId ? { anthropicProfileId: input.anthropicProfileId } : {}),
            ...(input.doneNotificationPrompt ? { doneNotificationPrompt: input.doneNotificationPrompt } : {}),
            ...(input.pauseAfter ? { pauseAfter: true } : {}),
            ...(input.session ? { session: input.session } : {}),
            ...(newSession ? { newSession } : {}),
            ...(run ? { run } : {}),
            ...(dnQuest ? { doneNotificationQuest: dnQuest } : {}),
            ...(dnRun ? { doneNotificationRun: dnRun } : {}),
            from: {
                quest: access.currentQuest() || 'default', run: access.currentRun(),
                windowId: me.windowId, host: me.host, sentAt: access.now().toISOString(),
            },
        };
        const posted = postInboxItem(access, quest, item);
        return JSON.stringify({
            ok: true,
            delivered: posted.delivered,
            targetRunning: posted.targetRunning,
            targetWindows: posted.windows,
            ...(posted.targetRunning ? {} : { note: `No window of "${quest}" is running; the item is queued when one starts.` }),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

/**
 * Write `item` into the inbox of `quest`'s windows on this machine: the
 * workspace a running window reads, else the quest's own. Also how a queue
 * item's done notification reaches another quest (promptQueueManager).
 */
export function postInboxItem(access: Pick<QuestSendAccess, 'liveWindows' | 'deliver'>, quest: string, item: InboxItem):
    { delivered: string; file: string; targetRunning: boolean; windows: TargetWindow[] } {
    const windows = access.liveWindows(quest);
    const workspace = windows[0]?.workspace || quest;
    const delivered = access.deliver(workspace, item);
    return { delivered, file: delivered.split(/[\\/]/).pop() ?? delivered, targetRunning: windows.length > 0, windows };
}

export const SEND_ITEM_TO_QUEST_DESCRIPTION =
    'Put a prompt into the queue of ANOTHER quest\'s window on this machine (your own quest: tomAi_addQueueItem). The target queues it with ITS OWN defaults unless `anthropicProfileId`, `session` (an existing session of the target) or `newSession` (`{basedOn, name?, lifetime?, profile?}`; without a name temporary) override them. `run` queues it in that process run of the target (its lane; sessions `<session>@<run>`). `doneNotificationPrompt` is queued after the item when it is done or fails for good (`${itemOutcome}`, `${itemAnswer}` — what the item answered —, `${itemTitle}`, `${itemTodos}`, `${senderQuest}`, `${senderRun}`): in the target quest, or with `doneNotificationQuest` in another (this one, to hear back directly), in `doneNotificationRun`. `pauseAfter` pauses the target queue. Look the quest, sessions and profiles up first with tomAi_getQuestWindowStatus. Answers `{delivered, targetRunning}`.';

export const SEND_ITEM_TO_QUEST_TOOL: SharedToolDefinition<SendItemToQuestInput> = {
    name: 'tomAi_sendItemToQuest',
    displayName: 'Send Item To Quest',
    description: SEND_ITEM_TO_QUEST_DESCRIPTION,
    tags: ['queue', 'anthropic', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['quest', 'text'],
        properties: {
            quest: { type: 'string', description: 'The target quest id (a folder under _ai/quests/).' },
            text: { type: 'string', description: 'The prompt.' },
            template: { type: 'string', description: 'A message template of the target queue.' },
            anthropicProfileId: { type: 'string', description: 'Anthropic profile the item runs with (transport anthropic).' },
            doneNotificationPrompt: { type: 'string', description: 'Queued when the item is done or fails for good: in the target queue, or in `doneNotificationQuest`. `${itemOutcome}`, `${itemAnswer}` (the item\'s answer), `${itemTitle}`, `${itemTodos}`.' },
            doneNotificationQuest: { type: 'string', description: 'The quest the done notification is posted to (e.g. your own, to hear back). Default: the target quest.' },
            doneNotificationRun: { type: 'string', description: 'The process run the done notification is queued in. Default: the item\'s run in the target quest, `default` in another.' },
            run: { type: 'string', description: 'The target quest\'s process run the item is queued in (tomAi_listProcessRuns there). Default: `default`.' },
            pauseAfter: { type: 'boolean' },
            session: { type: 'string', description: 'An existing session of the target quest.' },
            newSession: {
                type: 'object',
                properties: {
                    basedOn: { type: 'string' },
                    name: { type: 'string', description: 'Omit for a temporary session.' },
                    lifetime: { type: 'string', enum: ['continue', 'per-prompt', 'per-iteration'] },
                    profile: { type: 'string' },
                },
                required: ['basedOn'],
                additionalProperties: false,
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by chat-enhancement-tools.ts"}',
};
