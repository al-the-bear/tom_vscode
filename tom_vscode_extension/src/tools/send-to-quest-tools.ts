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

import { todoQueueItemSpec, type TodoForQueueItem } from '../utils/todoQueueItems';
import { SharedToolDefinition } from './shared-tool-registry';
import { isValidSessionName, normalizeSessionMode, type SessionRecord } from '../utils/agentSdkSessions';
import type { InboxItem, InboxNewSession } from '../utils/questInbox';
import type { QueuedBy } from '../utils/queuedBy';
import { todoPrefixPatternError } from '../utils/queueStep3Utils';
import { roleRefusal } from '../utils/roleNames';
import { GUIDELINES_SCHEMA, guidelinesRefusal, type AspectSectionsReader } from './aspect-guideline-tools';
import { normalizeAspectChoices } from '../utils/aspectChoices';

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
    /** The role the item runs as in the target quest (a folder of `_ai/roles/`). */
    role?: string;
    /** The item's guideline choices there: aspect → choice or `remove` (gsel4). */
    guidelines?: Record<string, string> | null;
    /** The target quest's process run the item is queued in; unset: `default`. */
    run?: string;
    /** How often the target repeats the item: a number, a chat variable there, or `<prefix>*` (a walk over the target quest's todos). */
    repeatCount?: number | string;
    /** The target quest's todos the item runs (an id, `<prefix>*`, several comma-separated); a `<prefix>*` repeatCount gives it when omitted. */
    todoIdPattern?: string;
    /** A TODO item: one todo of the target quest (vscimpb127). */
    todo?: string;
    /** A GROUP item: a group todo of the target quest; it walks its members there. */
    group?: string;
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
    /** The roles folder (`_ai/roles/`, shared by every quest) a role is checked against; undefined: only its form. */
    rolesDir?(): string | undefined;
    /** The guideline aspects (`_ai/aspect_guidelines/`, shared by every quest) `guidelines` are checked against; undefined: only their form. */
    aspectSections?: AspectSectionsReader;
    /** The windows of the quest with a live heartbeat. */
    liveWindows(quest: string): TargetWindow[];
    /** This window, as the item names its sender. */
    sender(): { windowId: string; host: string };
    /** Write the inbox file for the workspace; its path. */
    deliver(workspace: string, item: InboxItem): string;
    /** The calling agent's quest, run and session (the item's `queuedBy`); unset: not recorded. */
    callerQueuedBy?(): QueuedBy | undefined;
    now(): Date;
    /** A todo of `quest` for a TODO / GROUP item; undefined when there is none. Unset: `todo` / `group` are refused. */
    findTodo?(quest: string, id: string): TodoForQueueItem | undefined;
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
        const badRole = roleRefusal(input.role, access.rolesDir?.());
        if (badRole) { return err(badRole, { code: 'unknownRole' }); }
        const badGuidelines = guidelinesRefusal(input.guidelines, access.aspectSections);
        if (badGuidelines) { return err(badGuidelines, { code: 'unknownGuidelines' }); }
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
        let walk = walkFields(input);
        if ('error' in walk) { return err(walk.error, { code: walk.code }); }
        // A TODO / GROUP item (vscimpb127): its walk value and todo pattern, checked against the target quest's todos.
        if (input.todo?.trim() || input.group?.trim()) {
            if (input.todo?.trim() && input.group?.trim()) { return err('`todo` and `group` exclude each other.', { code: 'invalidTodoItem' }); }
            if (walk.repeatCount !== undefined) { return err('`repeatCount` goes with neither `todo` nor `group`: the item walks its todos.', { code: 'invalidTodoItem' }); }
            if (!access.findTodo) { return err('TODO and GROUP items are not available here.', { code: 'invalidTodoItem' }); }
            const kind = input.group?.trim() ? 'group' as const : 'todo' as const;
            const id = (input.group ?? input.todo)!.trim();
            const spec = todoQueueItemSpec(kind, quest, id, access.findTodo(quest, id));
            if (!spec.ok) { return err(spec.error, { code: kind === 'group' && /no todo group/.test(spec.error) ? 'notAGroup' : 'unknownTodo' }); }
            walk = { repeatCount: spec.repeatCount, todoIdPattern: walk.todoIdPattern ?? spec.todoIdPattern };
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
        const queuedBy = access.callerQueuedBy?.();
        const item: InboxItem = {
            text: input.text,
            ...(input.template ? { template: input.template } : {}),
            ...(input.anthropicProfileId ? { anthropicProfileId: input.anthropicProfileId } : {}),
            ...(input.doneNotificationPrompt ? { doneNotificationPrompt: input.doneNotificationPrompt } : {}),
            ...(input.pauseAfter ? { pauseAfter: true } : {}),
            ...(input.session ? { session: input.session } : {}),
            ...(newSession ? { newSession } : {}),
            ...(input.role ? { role: input.role } : {}),
            ...(normalizeAspectChoices(input.guidelines) ? { guidelines: normalizeAspectChoices(input.guidelines) } : {}),
            ...(run ? { run } : {}),
            ...(walk.repeatCount !== undefined ? { repeatCount: walk.repeatCount } : {}),
            ...(walk.todoIdPattern ? { todoIdPattern: walk.todoIdPattern } : {}),
            ...(dnQuest ? { doneNotificationQuest: dnQuest } : {}),
            ...(dnRun ? { doneNotificationRun: dnRun } : {}),
            ...(queuedBy ? { queuedBy } : {}),
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
 * The item's repeat count and todo pattern, checked: a whole number of 1 or
 * more, a chat-variable name, or `<prefix>*` (whose prefix must not end in a
 * digit); a pattern of todo ids and `<prefix>*` entries. The walk runs over
 * the target quest's todos, in the item's run.
 */
function walkFields(input: SendItemToQuestInput): { repeatCount?: number | string; todoIdPattern?: string } | { error: string; code: string } {
    let repeatCount: number | string | undefined;
    const rc = input.repeatCount;
    if (typeof rc === 'number') {
        if (!Number.isInteger(rc) || rc < 1) { return { error: '`repeatCount` must be a whole number of 1 or more, a chat-variable name or `<prefix>*`.', code: 'invalidRepeatCount' }; }
        repeatCount = rc;
    } else if (typeof rc === 'string' && rc.trim()) {
        repeatCount = rc.trim();
        const prefixError = todoPrefixPatternError(repeatCount);
        if (prefixError) { return { error: prefixError, code: 'invalidTodoPrefix' }; }
    } else if (rc !== undefined && rc !== null && rc !== '') {
        return { error: '`repeatCount` must be a number or a string.', code: 'invalidRepeatCount' };
    }
    let todoIdPattern: string | undefined;
    if (input.todoIdPattern !== undefined && input.todoIdPattern !== null && input.todoIdPattern !== '') {
        if (typeof input.todoIdPattern !== 'string') { return { error: '`todoIdPattern` must be a string.', code: 'invalidTodoPattern' }; }
        const parts = input.todoIdPattern.split(',').map((p) => p.trim()).filter(Boolean);
        const bad = parts.find((p) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*\*?$/.test(p));
        if (bad !== undefined || parts.length === 0) {
            return { error: `\`todoIdPattern\` must be todo ids or \`<prefix>*\`, comma-separated${bad ? `, not "${bad}"` : ''}.`, code: 'invalidTodoPattern' };
        }
        const prefixError = parts.map((p) => todoPrefixPatternError(p)).find(Boolean);
        if (prefixError) { return { error: prefixError, code: 'invalidTodoPrefix' }; }
        todoIdPattern = parts.join(',');
    }
    return { ...(repeatCount !== undefined ? { repeatCount } : {}), ...(todoIdPattern ? { todoIdPattern } : {}) };
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
    'Put a prompt into the queue of ANOTHER quest\'s window on this machine (your own quest: tomAi_addQueueItem). The target queues it with ITS OWN defaults unless `anthropicProfileId`, `session` (an existing session of the target) or `newSession` (`{basedOn, name?, lifetime?, profile?}`; without a name temporary) override them. `run` queues it in that process run of the target (its lane; sessions `<session>@<run>`; a run the target lacks is refused, `unknownRun`). `repeatCount` / `todoIdPattern` make it a todo walk there, `todo` / `group` a TODO / GROUP item over the target quest\'s todo or group, e.g. `repeatCount: "tsm_a*"` walks the target quest\'s `tsm_a*` todos in that run. `doneNotificationPrompt` is queued after the item when it is done or fails for good (`${itemOutcome}`, `${itemAnswer}` — what the item answered —, `${itemTitle}`, `${itemTodos}`, `${senderQuest}`, `${senderRun}`): in the target quest, or with `doneNotificationQuest` in another (this one, to hear back directly), in `doneNotificationRun`. `pauseAfter` pauses the target queue. Look the quest, sessions and profiles up first with tomAi_getQuestWindowStatus. Answers `{delivered, targetRunning}`.';

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
            run: { type: 'string', description: 'The target quest\'s process run the item is queued in (tomAi_listProcessRuns there). Default: `default`. A run the target lacks is refused.' },
            repeatCount: { type: ['number', 'string'], description: 'A number, a chat-variable name of the target, or `<prefix>*`: a walk over the target quest\'s todos with that prefix, lowest number first, in `run` (the prefix must not end in a digit).' },
            todoIdPattern: { type: 'string', description: 'The target quest\'s todos the item runs: an id, `<prefix>*`, or several comma-separated. Default: from a `<prefix>*` repeatCount.' },
            todo: { type: 'string', description: 'A TODO item: one todo of the target quest, run like a walk iteration there (record appended, claimed when sent, completion checked). Refused for an unknown todo; not with `repeatCount`.' },
            group: { type: 'string', description: 'A GROUP item: a group todo of the target quest; it walks its members there in `comprised_of` order. Refused for an unknown todo or one that is no group.' },
            pauseAfter: { type: 'boolean' },
            session: { type: 'string', description: 'An existing session of the target quest.' },
            role: { type: 'string', description: 'The role the item runs as there: a folder of `_ai/roles/` (shared by every quest). Its stages run as this role unless the todo it runs names its own. An unknown role is refused (`unknownRole`).' },
            ...GUIDELINES_SCHEMA,
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
