/**
 * Prompt-queue tools — 14 tools that manipulate the multi-transport
 * Prompt Queue (Copilot Chat + Anthropic via `AnthropicHandler`).
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #18.
 *
 * ## Conceptual model
 *
 * A queue **item** has three layers of prompts that fire in order:
 *
 *   1. **Pre-prompts** — sent before the main prompt, in order. Each
 *      waits for the prior answer (or `answerWaitMinutes`) before the
 *      next fires.
 *   2. **Main prompt** — the original text + any answer wrapper.
 *   3. **Follow-ups** — sent after each answer to the main prompt, in
 *      sequence. The queue manager auto-advances through follow-ups.
 *
 * Items live in one of these states (the **status enum**):
 *
 *   - `staged`   — created with `deferSend: true`, not yet ready
 *   - `pending`  — ready to dispatch
 *   - `sending`  — currently in flight
 *   - `sent`     — completed (success path)
 *   - `error`    — failed (rate limit, transport error, etc.)
 *   - `interrupted` — cancelled on purpose (interrupt for continuation);
 *     resent when auto-send is re-armed
 *
 * Transport routing happens at the item or per-stage level:
 *
 *   - `copilot` (default): routes through VS Code's Copilot Chat
 *   - `anthropic`: routes through `AnthropicHandler.sendMessage` with
 *     a resolved profile + configuration. Approval mode is forced to
 *     `never` (the queue is unattended).
 *
 * ## Sending
 *
 * **`tomAi_sendQueuedPrompt`** is the one way an agent sends an item: it
 * hands the item to the manager's run loop, which waits for the answer,
 * sends the next follow-up, etc., chaining all the way through the item's
 * stages.
 *
 * The canonical model-side workflow is:
 *
 *   1. `tomAi_addQueueItem` with `deferSend: true` (default) to stage
 *      the main prompt.
 *   2. `tomAi_addQueueFollowUp` 0…N times to append follow-ups.
 *   3. `tomAi_sendQueuedPrompt` to start the lifecycle (manager
 *      handles all the chaining + answer waiting).
 *
 * `tomAi_resendQueueItem` is the recovery
 * tool for rate-limited/interrupted dispatches (re-runs the LAST
 * dispatched stage without touching repetition counters).
 */

import { todoIdPatternOf } from '../utils/todoQueueMarks';
import { SharedToolDefinition } from './shared-tool-registry';
import { todoPrefixPatternError } from '../utils/queueStep3Utils';
import { parseSessionSpec } from '../utils/sessionSpecs';

// ===========================================================================
// Shared shapes
// ===========================================================================

export type QueueStatus = 'staged' | 'pending' | 'sending' | 'sent' | 'error' | 'decision-needed' | 'interrupted' | 'chat' | 'chat-sent';
export type QueueTransport = 'copilot' | 'anthropic';

export interface PrePromptSpec {
    text: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export interface FollowUpSpec {
    originalText: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export interface FollowUpItem extends FollowUpSpec {
    id: string;
}

export interface QueueItemSnapshot {
    id: string;
    status: QueueStatus;
    /** The todos it runs: a todo id, `<prefix>*`, or several separated by commas. */
    todoIdPattern?: string;
    /** "Let the next item go first" armed: yields after its running iteration (vscimpb60e). */
    yieldAfterIteration?: boolean;
    type?: string;
    originalText: string;
    template?: string;
    answerWrapper?: boolean;
    requestId?: string;
    expectedRequestId?: string;
    createdAt: number;
    sentAt?: number;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    followUpIndex?: number;
    followUps?: FollowUpItem[];
    prePrompts?: PrePromptSpec[];
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The named Agent SDK session the item runs in (unset: the queue default). */
    session?: string;
    /** How the session is created when missing at dispatch (the item's session was given as a spec). */
    sessionCreate?: { basedOn?: string; mode?: string; profile?: string };
    /** The process run of the quest the item belongs to (`default` for the quest's own position). */
    run?: string;
    answerText?: string;
    lastDispatched?: string;
    /** Why the last send did not complete (rate limit, quota, overload, …), as the queue records it. */
    warning?: { kind: string; message: string; at?: string };
    /** Why the item is in `error` (a failed send, or a `prefix*` walk with nothing to walk over). */
    error?: string;
    /** The stage stopped for a too-low credit balance (src/utils/outOfBudget.ts): which profile, where, when. */
    outOfBudget?: { profileId: string; profileName?: string; session: string; message: string; at: string; suggestedProfileId?: string };
    /** Its later stages run on another profile (set by Continue on profile). */
    budgetFallback?: { fromProfileId: string; toProfileId: string; session?: string };
    /** Queued right after the item when it is finished (src/utils/doneNotification.ts). */
    doneNotificationPrompt?: string;
    doneNotificationDisabled?: boolean;
    /** The quest the done notification is posted to; unset: this quest. */
    doneNotificationQuest?: string;
    /** The process run it is queued in; unset: the item's run here, `default` in another quest. */
    doneNotificationRun?: string;
    /** Where a done notification for another quest was posted, and whether it waits there for a window. */
    doneNotificationPosted?: { quest: string; run: string; file: string; waiting: boolean; at: string };
    /** On a done-notification item: the item it reports on. */
    notificationOf?: string;
    /** On an item another quest's window sent: its sender. */
    from?: { quest: string; windowId: string; host: string; sentAt: string };
    /** While its turn waits in tomAi_waitFor (utils/waitFor.ts): reason, details, since, until. */
    waitingFor?: { reason: string; details?: string; since: string; until: string };
}

/**
 * Every field of {@link QueueItemSnapshot}, in one list. The live access
 * (chat-enhancement-tools.ts) copies a queue item through
 * {@link projectQueueItem}; a field missing here once made tomAi_listQueue
 * answer `session: null` for items that had one. The check below fails the
 * build when a field is added to the interface but not to this list.
 */
export const QUEUE_ITEM_SNAPSHOT_FIELDS = [
    'id', 'status', 'type', 'originalText', 'template', 'answerWrapper', 'requestId', 'expectedRequestId',
    'createdAt', 'sentAt', 'reminderEnabled', 'reminderTemplateId', 'reminderTimeoutMinutes', 'reminderRepeat',
    'repeatCount', 'repeatPrefix', 'repeatSuffix', 'templateRepeatCount', 'answerWaitMinutes', 'followUpIndex',
    'followUps', 'prePrompts', 'transport', 'anthropicProfileId', 'anthropicConfigId', 'session', 'sessionCreate', 'run',
    'answerText', 'lastDispatched', 'warning', 'error', 'outOfBudget', 'budgetFallback', 'doneNotificationPrompt', 'doneNotificationDisabled', 'doneNotificationQuest', 'doneNotificationRun', 'doneNotificationPosted', 'notificationOf', 'from', 'todoIdPattern',
    'yieldAfterIteration', 'waitingFor',
] as const satisfies readonly (keyof QueueItemSnapshot)[];

type UnprojectedSnapshotField = Exclude<keyof QueueItemSnapshot, (typeof QUEUE_ITEM_SNAPSHOT_FIELDS)[number]>;
/** Compile-time: `never` unless every field of QueueItemSnapshot is in QUEUE_ITEM_SNAPSHOT_FIELDS. */
export const SNAPSHOT_FIELDS_COMPLETE: [UnprojectedSnapshotField] extends [never] ? true : UnprojectedSnapshotField = true;

/** A queue item as the queue tools see it: every snapshot field copied, `originalText` never undefined. */
export function projectQueueItem(item: object): QueueItemSnapshot {
    const source = item as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const field of QUEUE_ITEM_SNAPSHOT_FIELDS) { out[field] = source[field]; }
    out.originalText = source.originalText || '';
    return out as unknown as QueueItemSnapshot;
}

// ===========================================================================
// Enqueue input — composite that drives addQueueItem
// ===========================================================================

export interface EnqueueInput {
    originalText: string;
    todoIdPattern?: string;
    template?: string;
    answerWrapper?: boolean;
    position?: number;
    deferSend?: boolean;
    /**
     * The status the item starts in. The manager's default is `pending` — the
     * queue sends it when its turn comes — and `deferSend` only skips the
     * immediate send, so a caller that means "staged" says so here.
     */
    initialStatus?: 'staged' | 'pending';
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    backgroundWaitLimitMinutes?: number;
    walkContinuations?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** A session name or a spec `{name, basedOn?, mode?, profile?}`. */
    session?: QueueSessionInput;
    /** The process run the item belongs to; default the window's current run. */
    run?: string;
    prePrompts?: PrePromptSpec[];
    followUps?: FollowUpSpec[];
    doneNotificationPrompt?: string;
    /** The quest the done notification is posted to; unset: this quest. */
    doneNotificationQuest?: string;
    /** The process run the done notification is queued in. */
    doneNotificationRun?: string;
}

/** A queue item's session as a tool takes it: a name, or how to create it when missing. */
export type QueueSessionInput = string | { name: string; basedOn?: string; mode?: string; profile?: string };

// ===========================================================================
// Narrow PromptQueueAccess dep
// ===========================================================================

export interface PromptQueueAccess {
    /** Snapshot of `queue.items`, in queue order. */
    items(): QueueItemSnapshot[];
    /** The window's run's auto-send. */
    autoSendEnabled(): boolean;
    /** The window's run's Copilot answer timeout. */
    responseFileTimeoutMinutes(): number;
    pendingCount(): number;
    /**
     * The queue settings per run (vscimpb60a): those of `run` (default: the
     * window's run) and every run's auto-send. Unset: not reported.
     */
    runSettings?(run?: string): { run: string; settings: Record<string, unknown>; runs: Array<{ run: string; autoSend: boolean }> };

    getById(id: string): QueueItemSnapshot | undefined;
    getByRequestId(requestId: string): QueueItemSnapshot | undefined;

    enqueue(input: EnqueueInput): Promise<QueueItemSnapshot>;
    /** The quest's process runs (`tomAi_addQueueItem {run}` must name one); unset: not checked. */
    runs?(): string[];
    /** Whether `quest` exists (`_ai/quests/<quest>/`); for a done notification posted to another quest. */
    questExists?(quest: string): boolean;
    /** Whether `quest` has the process run `run` (`default` always). */
    questRunExists?(quest: string, run: string): boolean;
    /** This window's quest. */
    currentQuest?(): string;
    remove(id: string): void;
    setStatus(id: string, status: 'staged' | 'pending'): boolean;

    updateText(id: string, text: string): Promise<void>;
    updateItemTemplateAndWrapper(id: string, opts: { template?: string; answerWrapper?: boolean }): Promise<void>;
    updateItemReminder(id: string, opts: {
        reminderEnabled?: boolean;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
    }): void;
    /** "Let the next item go first" (vscimpb60e); unset: not offered. */
    letNextGoFirst?(id: string): { ok: true; mode: 'moved' | 'armed' | 'cancelled'; behind?: string } | { ok: false; reason: string };
    updateItemRepetition(id: string, opts: {
        repeatCount?: number | string;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        answerWaitMinutes?: number;
        backgroundWaitLimitMinutes?: number;
        walkContinuations?: number;
    }): void;
    updateItemTransport(id: string, opts: {
        transport?: QueueTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): void;
    /**
     * Set an item's session — a name or a spec ('' = the queue default); false when the item cannot
     * change. Throws when the item's profile cannot continue the session's conversation.
     */
    updateItemSession?(id: string, session: QueueSessionInput): boolean;
    /** Set an item's done-notification prompt and / or switch it off ('' removes it); false when the item is finished. */
    updateItemDoneNotification?(id: string, patch: { prompt?: string; disabled?: boolean; quest?: string; run?: string }): boolean;

    addPrePrompt(id: string, text: string, template: string | undefined, opts?: {
        transport?: QueueTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): boolean;
    updatePrePrompt(id: string, index: number, opts: Partial<PrePromptSpec>): boolean;
    removePrePrompt(id: string, index: number): boolean;

    addFollowUpPrompt(id: string, opts: Omit<FollowUpSpec, 'repeatCount' | 'answerWaitMinutes'> & {
        repeatCount?: never;
        answerWaitMinutes?: never;
    }): FollowUpItem | undefined;
    updateFollowUpPrompt(id: string, followUpId: string, opts: Partial<FollowUpSpec>): boolean;
    removeFollowUpPrompt(id: string, followUpId: string): boolean;

    sendQueuedPrompt(selector: { id?: string; requestId?: string }): Promise<QueueItemSnapshot | null>;
    resendLastPrompt(id: string): Promise<void>;
    /**
     * Send the stopped stage again on another profile as the out-of-budget
     * prompt (PromptQueueManager.continueOnProfile: the session rule, later
     * stages following).
     */
    continueOnProfile?(id: string, profileId: string): Promise<void>;
    /** Stages of the item that would fail for a missing API key, one line per cause (vscimpa21). */
    missingApiKeyWarnings?(id: string): string[];
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string {
    return JSON.stringify({ ok: true, ...extra });
}

function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

/**
 * `{ warning }` when stages of the item would fail for a missing API key (a
 * direct-API profile whose key variable is not in this VS Code's
 * environment), else `{}` — spread into the answer of every tool that
 * queues, changes or sends an item. The item is queued all the same: the
 * caller decides.
 */
/** The sentence the queue tools' descriptions carry about {@link apiKeyWarning}. */
const API_KEY_WARNING_DOC =
    ' A `warning` in the answer names stages whose direct-API key is missing (they would fail; the item is kept).';

function apiKeyWarning(access: PromptQueueAccess, itemId: string | undefined): { warning?: string } {
    const lines = itemId ? access.missingApiKeyWarnings?.(itemId) ?? [] : [];
    return lines.length > 0 ? { warning: lines.join('\n') } : {};
}

/**
 * The warning of a just-queued item: the item held in `error` at once (a
 * `prefix*` walk with nothing to walk over) and the stages a missing API key
 * would fail, one line each.
 */
function queuedItemWarning(access: PromptQueueAccess, item: { id: string; status?: string; error?: string }): { warning?: string } {
    const lines = [
        ...(item.status === 'error' && item.error ? [`The item is held in error: ${item.error}`] : []),
        ...(access.missingApiKeyWarnings?.(item.id) ?? []),
    ];
    return lines.length > 0 ? { warning: lines.join('\n') } : {};
}

/** What a queue item's `session` is. */
const SESSION_DOC =
    'The named session the item runs in (tomAi_listSessions): a name, or `{name, basedOn?, mode?, profile?}` to create it on first dispatch if missing. Unset: the queue default. A malformed spec or a profile of the other conversation kind is refused (`invalidSession`).';

/** The JSON schema of a queue item's `session`. */
const SESSION_SCHEMA = {
    description: SESSION_DOC,
    anyOf: [
        { type: 'string' },
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                basedOn: { type: 'string' },
                mode: { type: 'string', enum: ['continue', 'per-prompt', 'per-iteration', 'fork-from-base'] },
                profile: { type: 'string', description: 'Anthropic profile id the session is created with.' },
            },
            required: ['name'],
            additionalProperties: false,
        },
    ],
};

/** The refusal of a malformed session (name or spec), or null. */
function sessionRefusal(session: unknown): string | null {
    if (session === undefined || session === '') { return null; }
    const parsed = parseSessionSpec(session);
    return parsed.ok ? null : err(parsed.error, { code: 'invalidSession' });
}

/** How a repeat count is written, for every tool that takes one. */
const REPEAT_COUNT_DOC =
    'A number, a chat-variable name, or `<prefix>*`: walk the quest\'s todos whose id starts with <prefix>, lowest number first (`${repeatTodoId}`, `${repeatTodoTitle}`, `${repeatNumber}` in the text; each prompt of the walk ends with the todo\'s whole record). The prefix must not end in a digit (`invalidTodoPrefix`); a walk over nothing without a pre-prompt is held in `error`.';

/** The refusal of the first repeat count no queue item may carry (a todo prefix ending in a digit), or null. */
function repeatCountRefusal(...values: unknown[]): string | null {
    for (const v of values) {
        const error = todoPrefixPatternError(v);
        if (error) { return err(error, { code: 'invalidTodoPrefix' }); }
    }
    return null;
}

function compactItem(i: QueueItemSnapshot): Record<string, unknown> {
    return {
        id: i.id,
        status: i.status,
        type: i.type,
        template: i.template,
        answerWrapper: !!i.answerWrapper,
        requestId: i.requestId || null,
        expectedRequestId: i.expectedRequestId || null,
        createdAt: i.createdAt,
        sentAt: i.sentAt || null,
        reminderEnabled: !!i.reminderEnabled,
        reminderTemplateId: i.reminderTemplateId || null,
        reminderTimeoutMinutes: i.reminderTimeoutMinutes ?? null,
        reminderRepeat: !!i.reminderRepeat,
        followUpIndex: i.followUpIndex || 0,
        followUpCount: i.followUps?.length ?? 0,
        textPreview: String(i.originalText || '').slice(0, 160),
        ...(todoIdPatternOf(i) ? { todoIdPattern: todoIdPatternOf(i) } : {}),
        transport: i.transport || 'copilot',
        anthropicProfileId: i.anthropicProfileId || null,
        anthropicConfigId: i.anthropicConfigId || null,
        session: i.session || null,
        ...(i.sessionCreate ? { sessionSpec: { name: i.session, ...i.sessionCreate } } : {}),
        // The process run the item belongs to (a chat send: none).
        ...(i.run ? { run: i.run } : {}),
        answerText: i.answerText || null,
        ...(i.doneNotificationPrompt ? { doneNotificationPrompt: i.doneNotificationPrompt, doneNotificationDisabled: !!i.doneNotificationDisabled } : {}),
        ...(i.doneNotificationQuest ? { doneNotificationQuest: i.doneNotificationQuest } : {}),
        ...(i.doneNotificationRun ? { doneNotificationRun: i.doneNotificationRun } : {}),
        ...(i.doneNotificationPosted ? { doneNotificationPosted: i.doneNotificationPosted } : {}),
        ...(i.notificationOf ? { notificationOf: i.notificationOf } : {}),
        ...(i.from ? { from: i.from } : {}),
        // Its turn waits in tomAi_waitFor (vscimpb82): reason, since, until.
        ...(i.status === 'sending' && i.waitingFor ? { waitingFor: { reason: i.waitingFor.reason, since: i.waitingFor.since, until: i.waitingFor.until, ...(i.waitingFor.details ? { details: i.waitingFor.details } : {}) } } : {}),
    };
}

// ===========================================================================
// tomAi_addQueueItem
// ===========================================================================

export interface AddQueueItemInput {
    text: string;
    /** The todos it runs (marked as queued in the todo panel); a `<prefix>*` repeatCount gives it when omitted. */
    todoIdPattern?: string;
    template?: string;
    answerWrapper?: boolean;
    position?: number;
    deferSend?: boolean;
    prePrompts?: PrePromptSpec[];
    followUps?: { text: string } & Omit<FollowUpSpec, 'originalText'>[] extends infer _ ? Array<{
        text: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }> : never;
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    backgroundWaitLimitMinutes?: number;
    walkContinuations?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The session the item runs in: a name or a spec ('' = the queue default). */
    session?: QueueSessionInput;
    doneNotificationPrompt?: string;
    /** The quest the done notification is posted to (its inbox); default this quest. */
    doneNotificationQuest?: string;
    /** The process run the done notification is queued in; default the item's run here, `default` in another quest. */
    doneNotificationRun?: string;
    /** The process run of the quest the item belongs to (tomAi_listProcessRuns); default the window's. */
    run?: string;
}

/**
 * Why a done-notification target cannot be used, or undefined: an unknown
 * quest, or a run that quest does not have. '' (unset) passes.
 */
export function doneNotificationTargetRefusal(access: PromptQueueAccess, quest: string | undefined, run: string | undefined): string | undefined {
    const q = quest?.trim() || '';
    const r = run?.trim() || '';
    const own = access.currentQuest?.() || '';
    if (q && q !== own) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(q) || (access.questExists && !access.questExists(q))) {
            return `There is no quest "${q}" for the done notification (_ai/quests/${q}/).`;
        }
        if (r && access.questRunExists && !access.questRunExists(q, r)) {
            return `The quest "${q}" has no process run "${r}" for the done notification.`;
        }
        return undefined;
    }
    if (r && access.runs) {
        const known = access.runs();
        if (!known.includes(r)) { return `The quest has no run "${r}" for the done notification; its runs: ${known.join(', ') || '(none)'}.`; }
    }
    return undefined;
}

export async function addQueueItemImpl(access: PromptQueueAccess, input: AddQueueItemInput): Promise<string> {
    try {
        if (!input.text || !input.text.trim()) {
            return err('`text` is required.');
        }
        const refused = repeatCountRefusal(input.repeatCount, input.templateRepeatCount,
            ...(input.prePrompts ?? []).map((p) => p.repeatCount), ...(input.followUps ?? []).map((f) => f.repeatCount));
        if (refused) { return refused; }
        const badSession = sessionRefusal(input.session);
        if (badSession) { return badSession; }
        const run = typeof input.run === 'string' && input.run.trim() ? input.run.trim() : undefined;
        if (run && access.runs) {
            const known = access.runs();
            if (!known.includes(run)) { return err(`The quest has no run "${run}"; its runs: ${known.join(', ') || '(none)'}. tomAi_listProcessRuns lists them.`); }
        }
        const badTarget = doneNotificationTargetRefusal(access, input.doneNotificationQuest, input.doneNotificationRun);
        if (badTarget) { return err(badTarget); }
        const item = await access.enqueue({
            ...(run ? { run } : {}),
            ...(input.doneNotificationQuest?.trim() ? { doneNotificationQuest: input.doneNotificationQuest.trim() } : {}),
            ...(input.doneNotificationRun?.trim() ? { doneNotificationRun: input.doneNotificationRun.trim() } : {}),
            originalText: input.text,
            ...(input.todoIdPattern?.trim() ? { todoIdPattern: input.todoIdPattern.trim() } : {}),
            template: input.template,
            answerWrapper: input.answerWrapper,
            position: input.position,
            deferSend: input.deferSend ?? true,
            // Staged unless deferSend is false: a staged item waits for
            // tomAi_sendQueuedPrompt, so auto-send cannot dispatch it before the
            // caller has added its pre-prompts and follow-ups.
            initialStatus: input.deferSend === false ? 'pending' : 'staged',
            repeatCount: input.repeatCount,
            repeatPrefix: input.repeatPrefix,
            repeatSuffix: input.repeatSuffix,
            templateRepeatCount: input.templateRepeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            ...(input.backgroundWaitLimitMinutes !== undefined ? { backgroundWaitLimitMinutes: input.backgroundWaitLimitMinutes } : {}),
            ...(input.walkContinuations !== undefined ? { walkContinuations: input.walkContinuations } : {}),
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
            ...(input.session ? { session: input.session } : {}),
            ...(input.doneNotificationPrompt ? { doneNotificationPrompt: input.doneNotificationPrompt } : {}),
            prePrompts: input.prePrompts ?? [],
            followUps: (input.followUps ?? []).map((f) => ({
                originalText: f.text,
                template: f.template,
                repeatCount: f.repeatCount,
                answerWaitMinutes: f.answerWaitMinutes,
                reminderTemplateId: f.reminderTimeoutMinutes !== undefined ? f.reminderTemplateId : f.reminderTemplateId,
                reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                reminderRepeat: f.reminderRepeat,
                reminderEnabled: f.reminderEnabled,
            })),
        });
        return ok({
            id: item.id,
            status: item.status,
            queueLength: access.items().length,
            prePromptCount: item.prePrompts?.length ?? 0,
            followUpCount: item.followUps?.length ?? 0,
            ...queuedItemWarning(access, item),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

/** What a queue item's `doneNotificationPrompt` is. */
const DONE_NOTIFICATION_DOC =
    'A prompt queued right after the item, ahead of the others, once it is finished (done, or an error that will not recover); `${itemOutcome}` reads `done` or `error: <message>`, `${senderQuest}` / `${senderRun}` the quest and run it comes from. Where: `doneNotificationQuest` / `doneNotificationRun`.';
const DONE_NOTIFICATION_QUEST_DOC =
    'The quest the done notification is posted to: another quest\'s inbox (queued there with its queue\'s defaults; with no window of it running it waits until one starts, and the item says so). Default: this quest. \'\' resets.';
const DONE_NOTIFICATION_RUN_DOC =
    'The process run the done notification is queued in (its lane; sessions `<session>@<run>`). Default: the item\'s run in this quest, `default` in another. \'\' resets.';

export const ADD_QUEUE_ITEM_DESCRIPTION =
    'Queue a prompt item: the main prompt `text` with optional `prePrompts` and `followUps`, run in that order, each waiting for its answer. By default the item is staged (`deferSend: true`), NOT sent: start it with tomAi_sendQueuedPrompt. `transport` defaults to `copilot`; `anthropic` with `anthropicProfileId` runs unattended. `repeatCount` repeats the main prompt or walks `<prefix>*` todos; `session` names the session it runs in.' + API_KEY_WARNING_DOC;

export const ADD_QUEUE_ITEM_TOOL: SharedToolDefinition<AddQueueItemInput> = {
    name: 'tomAi_addQueueItem',
    displayName: 'Add To Prompt Queue',
    description: ADD_QUEUE_ITEM_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string', description: 'Initial prompt text (main prompt).' },
            template: { type: 'string' },
            answerWrapper: { type: 'boolean' },
            position: { type: 'number', description: 'Insert index. -1 appends.' },
            deferSend: { type: 'boolean', description: 'Default true → staged. False → enqueue as pending.' },
            todoIdPattern: { type: 'string', description: 'The todos it runs: a todo id, `<prefix>*`, or several, comma-separated; the todo panel marks them queued. Default: a `<prefix>*` repeatCount.' },
            prePrompts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            followUps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            repeatCount: { description: REPEAT_COUNT_DOC },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            templateRepeatCount: { description: 'Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number' },
            backgroundWaitLimitMinutes: { type: 'number', description: "The longest a turn of the item waits for its own background work (background tasks / command streams) before it ends with a hint naming what still runs, in minutes; 0 = no wait. Unset: the profile's limit, else 360 (6 h)." },
            walkContinuations: { type: 'number', description: "Continuations a `<prefix>*` walk iteration gets when its todo is not completed after the turn (sent into the same session; then the item stops as needs attention). Unset: the queue's walk-continuations, default 2; 0 = none." },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
            session: SESSION_SCHEMA,
            run: { type: 'string', description: 'The process run of the quest the item belongs to (tomAi_listProcessRuns): its sessions are the run\'s (`<session>@<run>`). Default: the run of the Proceed prompt it is queued from, else the window\'s run.' },
            doneNotificationPrompt: { type: 'string', description: DONE_NOTIFICATION_DOC },
            doneNotificationQuest: { type: 'string', description: DONE_NOTIFICATION_QUEST_DOC },
            doneNotificationRun: { type: 'string', description: DONE_NOTIFICATION_RUN_DOC },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listQueue
// ===========================================================================

export interface ListQueueInput { includeSent?: boolean; run?: string }

export async function listQueueImpl(access: PromptQueueAccess, input: ListQueueInput): Promise<string> {
    try {
        const includeSent = !!input.includeSent;
        const items = access.items()
            .filter((i) => includeSent || (i.status !== 'sent' && i.status !== 'chat-sent'))
            .map(compactItem);
        const run = typeof input.run === 'string' && input.run.trim() ? input.run.trim() : undefined;
        const perRun = access.runSettings ? access.runSettings(run) : undefined;
        return JSON.stringify({
            ok: true,
            ...(perRun
                ? {
                    run: perRun.run,
                    autoSendEnabled: perRun.settings.autoSend,
                    responseTimeoutMinutes: perRun.settings.responseTimeoutMinutes,
                    settings: perRun.settings,
                    runs: perRun.runs,
                }
                : { autoSendEnabled: access.autoSendEnabled(), responseTimeoutMinutes: access.responseFileTimeoutMinutes() }),
            pendingCount: access.pendingCount(),
            totalCount: items.length,
            items,
        }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_QUEUE_DESCRIPTION =
    'List queue items with status, ids, the process run each belongs to, reminder metadata, transport, and ' +
    'follow-up counts. **Default excludes `sent` items** — pass ' +
    '`includeSent: true` to see the whole history. Response includes ' +
    'the queue settings of one process run (`run`, default the window\'s run; each run has its own, its lane sending ' +
    'beside the others): `autoSendEnabled`, `responseTimeoutMinutes` and all of them as `settings`, every run\'s ' +
    'auto-send as `runs`, and `pendingCount` so the ' +
    'model can see the queue\'s run-loop state at a glance. Items have ' +
    '`textPreview` (first 160 chars) — use `tomAi_listQueue` for browsing, ' +
    'and inspect specific items with the other queue tools using `id`.';

export const LIST_QUEUE_TOOL: SharedToolDefinition<ListQueueInput> = {
    name: 'tomAi_listQueue',
    displayName: 'Queue List',
    description: LIST_QUEUE_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeSent: { type: 'boolean', description: 'Default false.' },
            run: { type: 'string', description: 'The process run whose queue settings are reported. Default: the window\'s run.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_sendQueuedPrompt — canonical lifecycle entry
// ===========================================================================

export interface SendQueuedPromptInput {
    queueItemId?: string;
    requestId?: string;
}

export async function sendQueuedPromptImpl(access: PromptQueueAccess, input: SendQueuedPromptInput): Promise<string> {
    try {
        const sent = await access.sendQueuedPrompt({ id: input.queueItemId, requestId: input.requestId });
        if (!sent) {
            return err('No pending queued prompt matched. Provide queueItemId (preferred) or requestId of a pending item.');
        }
        return ok({
            id: sent.id,
            status: sent.status,
            requestId: sent.requestId || null,
            followUpCount: sent.followUps?.length ?? 0,
            ...apiKeyWarning(access, sent.id),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const SEND_QUEUED_PROMPT_DESCRIPTION =
    'Hand a staged or pending queue item to the manager\'s run loop — the ' +
    '**canonical lifecycle entry point**. The manager will then: send pre-' +
    'prompts → wait → send main → wait → send follow-up #1 → wait → … → ' +
    'mark sent. All follow-ups are auto-wrapped with the Answer Wrapper. ' +
    'Pass `queueItemId` (preferred) or `requestId` (when id is unknown).' + API_KEY_WARNING_DOC;

export const SEND_QUEUED_PROMPT_TOOL: SharedToolDefinition<SendQueuedPromptInput> = {
    name: 'tomAi_sendQueuedPrompt',
    displayName: 'Send Queued Prompt',
    description: SEND_QUEUED_PROMPT_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            queueItemId: { type: 'string' },
            requestId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_resendQueueItem
// ===========================================================================

export interface ResendQueueItemInput {
    queueItemId: string;
    /** Continue on this Anthropic profile instead of replaying on the same one (an item stopped for lack of credit). */
    profileId?: string;
}

export async function resendQueueItemImpl(access: PromptQueueAccess, input: ResendQueueItemInput): Promise<string> {
    try {
        if (!input.queueItemId) { return err('`queueItemId` is required.'); }
        // Read before the send: a send clears what the stop recorded.
        const stopped = access.getById(input.queueItemId)?.outOfBudget;
        const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : '';
        if (profileId) {
            if (!access.continueOnProfile) { return err('Continuing on another profile is not available here.'); }
            await access.continueOnProfile(input.queueItemId, profileId);
        } else {
            await access.resendLastPrompt(input.queueItemId);
        }
        const item = access.getById(input.queueItemId);
        if (!item) { return err(`Queue item "${input.queueItemId}" not found after resend.`); }
        return ok({
            id: input.queueItemId,
            status: item.status,
            transport: item.transport || 'copilot',
            anthropicProfileId: item.anthropicProfileId || null,
            anthropicConfigId: item.anthropicConfigId || null,
            lastDispatched: item.lastDispatched || null,
            warning: item.warning || null,
            ...(profileId ? { continuedOn: profileId, budgetFallback: item.budgetFallback ?? null } : {}),
            ...(stopped ? {
                outOfBudget: stopped,
                note: profileId
                    ? `The item had stopped for lack of credit on ${stopped.profileName ?? stopped.profileId}; it continues on ${profileId} with the out-of-budget prompt, and its later stages run there too.`
                    : `The item had stopped for lack of credit on ${stopped.profileName ?? stopped.profileId}: this resend replays it on the same profile, which only works once there is credit again. Pass \`profileId\` to continue on another profile${stopped.suggestedProfileId ? ` (its fallback: ${stopped.suggestedProfileId})` : ''}.`,
            } : {}),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const RESEND_QUEUE_ITEM_DESCRIPTION =
    'Re-send the **last dispatched stage** (pre-prompt / main / follow-up) of ' +
    'a queue item without touching repetition counters. Use to recover from ' +
    'rate-limit, quota-exceeded, overload, or interrupted responses — the ' +
    'manager picks up where it left off without losing loop state. ' +
    '**Distinct from `tomAi_addQueueItem`**: resend reuses the SAME item id ' +
    'and re-runs the previous stage; adding a new item starts fresh. The item ' +
    'must have a recorded `lastDispatched` (i.e. it was previously sent at ' +
    'least once); resend on a never-sent item is an error. An item stopped for ' +
    'lack of credit (its answer carries `outOfBudget`): pass `profileId` to ' +
    'continue it on another Anthropic profile — the stopped stage is sent as ' +
    'the out-of-budget prompt (what stopped where, the session\'s live trail, ' +
    'the original prompt), in the item\'s session unless that profile cannot ' +
    'continue its conversation (then `default`), and its later stages run on ' +
    'that profile too; without it the same profile is tried again.';

export const RESEND_QUEUE_ITEM_TOOL: SharedToolDefinition<ResendQueueItemInput> = {
    name: 'tomAi_resendQueueItem',
    displayName: 'Queue Resend Last Prompt',
    description: RESEND_QUEUE_ITEM_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string' },
            profileId: { type: 'string', description: 'Continue on this Anthropic profile (an item stopped for lack of credit), as the queue editor\'s Continue on profile does.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_setQueueItemStatus
// ===========================================================================

export interface SetQueueItemStatusInput {
    queueItemId: string;
    status: 'staged' | 'pending';
}

export async function setQueueItemStatusImpl(access: PromptQueueAccess, input: SetQueueItemStatusInput): Promise<string> {
    try {
        if (!input.queueItemId || !input.status) {
            return err('`queueItemId` and `status` are both required.');
        }
        const ok2 = access.setStatus(input.queueItemId, input.status);
        if (!ok2) { return err(`Unable to set status for "${input.queueItemId}".`); }
        return ok({ id: input.queueItemId, status: input.status });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const SET_QUEUE_ITEM_STATUS_DESCRIPTION =
    'Flip queue item status between `staged` (held back from the run loop) ' +
    'and `pending` (eligible for dispatch). Other statuses (`sending`, ' +
    '`sent`, `error`, `decision-needed`, `interrupted`) are state-machine-managed and cannot ' +
    'be set manually — an item held on `decision-needed` is released by ' +
    'answering the todo decisions and restarting the queue. ' +
    'Use this to temporarily unstage a pending item without removing it.';

export const SET_QUEUE_ITEM_STATUS_TOOL: SharedToolDefinition<SetQueueItemStatusInput> = {
    name: 'tomAi_setQueueItemStatus',
    displayName: 'Queue Set Status',
    description: SET_QUEUE_ITEM_STATUS_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'status'],
        properties: {
            queueItemId: { type: 'string' },
            status: { type: 'string', enum: ['staged', 'pending'] },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updateQueueItem
// ===========================================================================

export interface UpdateQueueItemInput {
    queueItemId: string;
    text?: string;
    template?: string;
    answerWrapper?: boolean;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    answerWaitMinutes?: number;
    backgroundWaitLimitMinutes?: number;
    walkContinuations?: number;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The session the item runs in: a name or a spec ('' = the queue default). */
    session?: QueueSessionInput;
    /** '' removes it. */
    doneNotificationPrompt?: string;
    doneNotificationDisabled?: boolean;
    /** '' resets to this quest. */
    doneNotificationQuest?: string;
    /** '' resets to the default run. */
    doneNotificationRun?: string;
    /**
     * "Let the next item go first" (vscimpb60e): true lets the next pending item of its lane go before this iteration
     * item (a pending one moves behind it now, a sending one after its running iteration); false cancels an armed one.
     */
    letNextGoFirst?: boolean;
}

export async function updateQueueItemImpl(access: PromptQueueAccess, input: UpdateQueueItemInput): Promise<string> {
    try {
        if (!input.queueItemId) { return err('`queueItemId` is required.'); }
        const refused = repeatCountRefusal(input.repeatCount, input.templateRepeatCount);
        if (refused) { return refused; }
        const badSession = sessionRefusal(input.session);
        if (badSession) { return badSession; }
        if (!access.getById(input.queueItemId)) {
            return err(`Queue item "${input.queueItemId}" not found.`);
        }
        if (input.text !== undefined) {
            await access.updateText(input.queueItemId, input.text);
        }
        if (input.template !== undefined || input.answerWrapper !== undefined) {
            await access.updateItemTemplateAndWrapper(input.queueItemId, {
                template: input.template,
                answerWrapper: input.answerWrapper,
            });
        }
        if (input.reminderEnabled !== undefined || input.reminderTemplateId !== undefined ||
            input.reminderTimeoutMinutes !== undefined || input.reminderRepeat !== undefined) {
            access.updateItemReminder(input.queueItemId, {
                reminderEnabled: input.reminderEnabled,
                reminderTemplateId: input.reminderTemplateId,
                reminderTimeoutMinutes: input.reminderTimeoutMinutes,
                reminderRepeat: input.reminderRepeat,
            });
        }
        if (input.repeatCount !== undefined || input.repeatPrefix !== undefined ||
            input.repeatSuffix !== undefined || input.templateRepeatCount !== undefined ||
            input.answerWaitMinutes !== undefined || input.backgroundWaitLimitMinutes !== undefined || input.walkContinuations !== undefined) {
            access.updateItemRepetition(input.queueItemId, {
                repeatCount: input.repeatCount,
                repeatPrefix: input.repeatPrefix,
                repeatSuffix: input.repeatSuffix,
                templateRepeatCount: input.templateRepeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
                ...(input.backgroundWaitLimitMinutes !== undefined ? { backgroundWaitLimitMinutes: input.backgroundWaitLimitMinutes } : {}),
                ...(input.walkContinuations !== undefined ? { walkContinuations: input.walkContinuations } : {}),
            });
        }
        if (input.transport !== undefined || input.anthropicProfileId !== undefined ||
            input.anthropicConfigId !== undefined) {
            access.updateItemTransport(input.queueItemId, {
                transport: input.transport,
                anthropicProfileId: input.anthropicProfileId,
                anthropicConfigId: input.anthropicConfigId,
            });
        }
        if (input.session !== undefined) {
            if (!access.updateItemSession || !access.updateItemSession(input.queueItemId, input.session)) {
                return err(`The session of queue item "${input.queueItemId}" cannot be changed (only staged or pending items).`);
            }
        }
        if (input.doneNotificationQuest !== undefined || input.doneNotificationRun !== undefined) {
            const current = access.getById(input.queueItemId);
            const badTarget = doneNotificationTargetRefusal(access,
                input.doneNotificationQuest ?? current?.doneNotificationQuest, input.doneNotificationRun ?? current?.doneNotificationRun);
            if (badTarget) { return err(badTarget); }
        }
        if (input.doneNotificationPrompt !== undefined || input.doneNotificationDisabled !== undefined
            || input.doneNotificationQuest !== undefined || input.doneNotificationRun !== undefined) {
            const changed = access.updateItemDoneNotification?.(input.queueItemId, {
                ...(input.doneNotificationPrompt !== undefined ? { prompt: input.doneNotificationPrompt } : {}),
                ...(input.doneNotificationDisabled !== undefined ? { disabled: input.doneNotificationDisabled } : {}),
                ...(input.doneNotificationQuest !== undefined ? { quest: input.doneNotificationQuest } : {}),
                ...(input.doneNotificationRun !== undefined ? { run: input.doneNotificationRun } : {}),
            });
            if (!changed) {
                return err(`The done-notification of queue item "${input.queueItemId}" cannot be changed (the item is finished).`);
            }
        }
        let letNextGoFirst: { mode: string; behind?: string } | undefined;
        if (input.letNextGoFirst !== undefined) {
            const armed = access.getById(input.queueItemId)?.yieldAfterIteration === true;
            // true on an armed item and false on an unarmed one change nothing.
            if (input.letNextGoFirst !== armed) {
                const r = access.letNextGoFirst?.(input.queueItemId);
                if (!r) { return err('Let the next item go first is not available here.'); }
                if (!r.ok) { return err(`Let the next item go first: ${r.reason}.`); }
                letNextGoFirst = { mode: r.mode, ...(r.behind ? { behind: r.behind } : {}) };
            }
        }
        const updated = access.getById(input.queueItemId);
        return ok({
            ...(letNextGoFirst ? { letNextGoFirst } : {}),
            id: input.queueItemId,
            status: updated?.status,
            template: updated?.template,
            answerWrapper: !!updated?.answerWrapper,
            reminderEnabled: !!updated?.reminderEnabled,
            repeatCount: updated?.repeatCount ?? null,
            templateRepeatCount: updated?.templateRepeatCount ?? null,
            answerWaitMinutes: updated?.answerWaitMinutes ?? null,
            transport: updated?.transport ?? 'copilot',
            ...(updated?.doneNotificationPrompt ? { doneNotificationPrompt: updated.doneNotificationPrompt, doneNotificationDisabled: !!updated.doneNotificationDisabled } : {}),
            ...(updated?.doneNotificationQuest ? { doneNotificationQuest: updated.doneNotificationQuest } : {}),
            ...(updated?.doneNotificationRun ? { doneNotificationRun: updated.doneNotificationRun } : {}),
            ...apiKeyWarning(access, input.queueItemId),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_QUEUE_ITEM_DESCRIPTION =
    'Update an editable queue item: text, template, answer-wrapper, reminder ' +
    'config, main-prompt repetition (count/prefix/suffix), templateRepeatCount, ' +
    'answerWaitMinutes, transport, anthropic target. **Only editable in ' +
    '`staged` / `pending` states** — items in `sending`/`sent`/`error` are ' +
    'frozen. `repeatCount`/`templateRepeatCount` accept literal numbers or ' +
    'chat-variable names. To change pre-prompts use `tomAi_updateQueuePrePrompt`; ' +
    'for follow-ups use `tomAi_updateQueueFollowUp`. `doneNotificationPrompt` (\'\' removes it), ' +
    '`doneNotificationDisabled` and where the notification goes (`doneNotificationQuest`, `doneNotificationRun`; \'\' resets) ' +
    'can be changed until the item is finished, also while it is sending. ' +
    '`letNextGoFirst: true` on a pending or sending iteration item (a `<prefix>*` walk or a repeat count) lets the ' +
    'next pending item of its lane go first — a pending one moves behind it now, a sending one after its running ' +
    'iteration, the walk resuming after it; `false` cancels it. Refused without a following item in its lane.';

export const UPDATE_QUEUE_ITEM_TOOL: SharedToolDefinition<UpdateQueueItemInput> = {
    name: 'tomAi_updateQueueItem',
    displayName: 'Queue Update Item',
    description: UPDATE_QUEUE_ITEM_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: {
            queueItemId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            answerWrapper: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            repeatCount: { description: REPEAT_COUNT_DOC },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            templateRepeatCount: { description: 'Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number' },
            backgroundWaitLimitMinutes: { type: 'number', description: "The longest a turn of the item waits for its own background work (background tasks / command streams) before it ends with a hint naming what still runs, in minutes; 0 = no wait. Unset: the profile's limit, else 360 (6 h). A negative number clears it." },
            walkContinuations: { type: 'number', description: "Continuations a `<prefix>*` walk iteration gets when its todo is not completed after the turn (sent into the same session; then the item stops as needs attention). Unset: the queue's walk-continuations, default 2; 0 = none." },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
            session: SESSION_SCHEMA,
            doneNotificationPrompt: { type: 'string', description: DONE_NOTIFICATION_DOC },
            doneNotificationQuest: { type: 'string', description: DONE_NOTIFICATION_QUEST_DOC },
            doneNotificationRun: { type: 'string', description: DONE_NOTIFICATION_RUN_DOC },
            doneNotificationDisabled: { type: 'boolean', description: 'Keep the done-notification prompt but do not queue it.' },
            letNextGoFirst: { type: 'boolean', description: 'An iteration item lets the next pending item of its lane go first (a sending one after its running iteration); false cancels it.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_removeQueueItem
// ===========================================================================

export interface RemoveQueueItemInput { queueItemId: string }

export async function removeQueueItemImpl(access: PromptQueueAccess, input: RemoveQueueItemInput): Promise<string> {
    try {
        if (!input.queueItemId) { return err('`queueItemId` is required.'); }
        access.remove(input.queueItemId);
        return ok({ deletedId: input.queueItemId });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const REMOVE_QUEUE_ITEM_DESCRIPTION =
    'Remove a queue item by id. **Idempotent** — succeeds whether the item ' +
    'existed or not (the manager treats removal of a missing id as a no-op). ' +
    'Use `tomAi_setQueueItemStatus` to temporarily unstage instead of ' +
    'removing; use this when you want the item gone permanently.';

export const REMOVE_QUEUE_ITEM_TOOL: SharedToolDefinition<RemoveQueueItemInput> = {
    name: 'tomAi_removeQueueItem',
    displayName: 'Queue Remove Item',
    description: REMOVE_QUEUE_ITEM_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: { queueItemId: { type: 'string' } },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Pre-prompt tools (3): add / update / remove
// ===========================================================================

export interface AddQueuePrePromptInput {
    queueItemId: string;
    text: string;
    template?: string;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export async function addQueuePrePromptImpl(access: PromptQueueAccess, input: AddQueuePrePromptInput): Promise<string> {
    try {
        if (!input.queueItemId || !input.text) {
            return err('`queueItemId` and `text` are both required.');
        }
        const ok2 = access.addPrePrompt(input.queueItemId, input.text, input.template, {
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!ok2) { return err('Could not add pre-prompt (item not found or not editable).'); }
        const updated = access.getById(input.queueItemId);
        return ok({
            queueItemId: input.queueItemId,
            prePromptCount: updated?.prePrompts?.length ?? 0,
            ...apiKeyWarning(access, input.queueItemId),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const ADD_QUEUE_PRE_PROMPT_DESCRIPTION =
    'Append a pre-prompt to an existing staged/pending queue item. ' +
    '**Pre-prompts run BEFORE the main prompt**, in insertion order, each ' +
    'waiting for its own answer (or `answerWaitMinutes`) before the next ' +
    'fires. Use `tomAi_updateQueuePrePrompt` to add `repeatCount`/' +
    '`answerWaitMinutes`/reminder settings after creation. Transport defaults ' +
    'to the item\'s transport; override per pre-prompt with the `transport` ' +
    'field.' + API_KEY_WARNING_DOC;

export const ADD_QUEUE_PRE_PROMPT_TOOL: SharedToolDefinition<AddQueuePrePromptInput> = {
    name: 'tomAi_addQueuePrePrompt',
    displayName: 'Add Pre-Prompt',
    description: ADD_QUEUE_PRE_PROMPT_DESCRIPTION,
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'text'],
        properties: {
            queueItemId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ---

export interface UpdateQueuePrePromptInput {
    queueItemId: string;
    index: number;
    text?: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export async function updateQueuePrePromptImpl(access: PromptQueueAccess, input: UpdateQueuePrePromptInput): Promise<string> {
    try {
        if (!input.queueItemId || typeof input.index !== 'number') {
            return err('`queueItemId` and zero-based `index` are both required.');
        }
        const refusedPre = repeatCountRefusal(input.repeatCount);
        if (refusedPre) { return refusedPre; }
        const ok2 = access.updatePrePrompt(input.queueItemId, input.index, {
            text: input.text,
            template: input.template,
            repeatCount: input.repeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!ok2) { return err('Could not update pre-prompt (item/index not found or item not editable).'); }
        return ok({ queueItemId: input.queueItemId, index: input.index, ...apiKeyWarning(access, input.queueItemId) });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_QUEUE_PRE_PROMPT_DESCRIPTION =
    'Patch fields on an existing pre-prompt by **zero-based index** within ' +
    'the item\'s pre-prompt array. Same field surface as the create form plus ' +
    'repeat/wait/reminder. Reordering is NOT supported — remove and re-add.';

export const UPDATE_QUEUE_PRE_PROMPT_TOOL: SharedToolDefinition<UpdateQueuePrePromptInput> = {
    name: 'tomAi_updateQueuePrePrompt',
    displayName: 'Update Pre-Prompt',
    description: UPDATE_QUEUE_PRE_PROMPT_DESCRIPTION,
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'index'],
        properties: {
            queueItemId: { type: 'string' },
            index: { type: 'number', description: 'Zero-based pre-prompt index.' },
            text: { type: 'string' },
            template: { type: 'string' },
            repeatCount: { description: REPEAT_COUNT_DOC },
            answerWaitMinutes: { type: 'number' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ---

export interface RemoveQueuePrePromptInput {
    queueItemId: string;
    index: number;
}

export async function removeQueuePrePromptImpl(access: PromptQueueAccess, input: RemoveQueuePrePromptInput): Promise<string> {
    try {
        if (!input.queueItemId || typeof input.index !== 'number') {
            return err('`queueItemId` and zero-based `index` are both required.');
        }
        const ok2 = access.removePrePrompt(input.queueItemId, input.index);
        if (!ok2) { return err('Could not remove pre-prompt (item/index not found or item not editable).'); }
        return ok({ queueItemId: input.queueItemId, index: input.index });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const REMOVE_QUEUE_PRE_PROMPT_DESCRIPTION =
    'Remove a pre-prompt by **zero-based index**. Subsequent pre-prompts ' +
    'shift down by one — re-issue `tomAi_listQueue` if you need fresh indices.';

export const REMOVE_QUEUE_PRE_PROMPT_TOOL: SharedToolDefinition<RemoveQueuePrePromptInput> = {
    name: 'tomAi_removeQueuePrePrompt',
    displayName: 'Remove Pre-Prompt',
    description: REMOVE_QUEUE_PRE_PROMPT_DESCRIPTION,
    tags: ['queue', 'pre-prompt', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'index'],
        properties: {
            queueItemId: { type: 'string' },
            index: { type: 'number' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Follow-up tools (3): add / update / remove
// ===========================================================================

export interface AddQueueFollowUpInput {
    queueItemId?: string;
    requestId?: string;
    text: string;
    template?: string;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export async function addQueueFollowUpImpl(access: PromptQueueAccess, input: AddQueueFollowUpInput): Promise<string> {
    try {
        if (!input.text) { return err('`text` is required.'); }
        const refusedFollow = repeatCountRefusal(input.repeatCount);
        if (refusedFollow) { return refusedFollow; }
        const item = input.queueItemId
            ? access.getById(input.queueItemId)
            : (input.requestId ? access.getByRequestId(input.requestId) : undefined);
        if (!item) {
            return err('Queue item not found. Provide queueItemId (preferred) or requestId of an existing queued/sending item.');
        }
        const follow = access.addFollowUpPrompt(item.id, {
            originalText: input.text,
            template: input.template,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!follow) { return err('Failed to add follow-up prompt.'); }
        // The manager's addFollowUpPrompt doesn't accept repeatCount / answerWaitMinutes
        // — patch via update if provided.
        if (input.repeatCount !== undefined || input.answerWaitMinutes !== undefined) {
            access.updateFollowUpPrompt(item.id, follow.id, {
                repeatCount: input.repeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
            });
        }
        const updated = access.getById(item.id);
        return ok({
            queueItemId: item.id,
            followUpId: follow.id,
            followUpCount: updated?.followUps?.length ?? 0,
            ...apiKeyWarning(access, item.id),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const ADD_QUEUE_FOLLOW_UP_DESCRIPTION =
    'Append a follow-up to an existing queue item. **Follow-ups run AFTER the ' +
    'main prompt**, in insertion order — the manager sends follow-up #1, ' +
    'waits for its answer, sends #2, etc., until done. All follow-ups are ' +
    'auto-wrapped with the Answer Wrapper. `repeatCount`/`answerWaitMinutes` ' +
    'are accepted here (they\'re applied to the new follow-up via an internal ' +
    'update call, since the manager\'s create form doesn\'t take them). Pass ' +
    '`queueItemId` (preferred) or `requestId` to target the item. Transport ' +
    'override available per follow-up.' + API_KEY_WARNING_DOC;

export const ADD_QUEUE_FOLLOW_UP_TOOL: SharedToolDefinition<AddQueueFollowUpInput> = {
    name: 'tomAi_addQueueFollowUp',
    displayName: 'Add Follow-Up Prompt',
    description: ADD_QUEUE_FOLLOW_UP_DESCRIPTION,
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            queueItemId: { type: 'string' },
            requestId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            repeatCount: { description: REPEAT_COUNT_DOC },
            answerWaitMinutes: { type: 'number' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ---

export interface UpdateQueueFollowUpInput {
    queueItemId: string;
    followUpId: string;
    text?: string;
    template?: string;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    repeatCount?: number | string;
    answerWaitMinutes?: number;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

export async function updateQueueFollowUpImpl(access: PromptQueueAccess, input: UpdateQueueFollowUpInput): Promise<string> {
    try {
        if (!input.queueItemId || !input.followUpId) {
            return err('`queueItemId` and `followUpId` are both required.');
        }
        const refusedUpd = repeatCountRefusal(input.repeatCount);
        if (refusedUpd) { return refusedUpd; }
        const ok2 = access.updateFollowUpPrompt(input.queueItemId, input.followUpId, {
            originalText: input.text,
            template: input.template,
            reminderEnabled: input.reminderEnabled,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            repeatCount: input.repeatCount,
            answerWaitMinutes: input.answerWaitMinutes,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
        });
        if (!ok2) { return err('Queue item or follow-up not found.'); }
        return ok({ queueItemId: input.queueItemId, followUpId: input.followUpId, ...apiKeyWarning(access, input.queueItemId) });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_QUEUE_FOLLOW_UP_DESCRIPTION =
    'Update fields on an existing follow-up by its id: text, template, ' +
    'reminder config, repeat/wait, transport. **Targeted by `followUpId`** ' +
    '(NOT by index — follow-ups have stable ids the manager generates). ' +
    'Get follow-up ids from the `followUps[].id` array in a queue item ' +
    'inspection.';

export const UPDATE_QUEUE_FOLLOW_UP_TOOL: SharedToolDefinition<UpdateQueueFollowUpInput> = {
    name: 'tomAi_updateQueueFollowUp',
    displayName: 'Queue Update Follow-Up',
    description: UPDATE_QUEUE_FOLLOW_UP_DESCRIPTION,
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'followUpId'],
        properties: {
            queueItemId: { type: 'string' },
            followUpId: { type: 'string' },
            text: { type: 'string' },
            template: { type: 'string' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            repeatCount: { description: REPEAT_COUNT_DOC },
            answerWaitMinutes: { type: 'number' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ---

export interface RemoveQueueFollowUpInput {
    queueItemId: string;
    followUpId: string;
}

export async function removeQueueFollowUpImpl(access: PromptQueueAccess, input: RemoveQueueFollowUpInput): Promise<string> {
    try {
        if (!input.queueItemId || !input.followUpId) {
            return err('`queueItemId` and `followUpId` are both required.');
        }
        const ok2 = access.removeFollowUpPrompt(input.queueItemId, input.followUpId);
        if (!ok2) { return err('Queue item or follow-up not found.'); }
        return ok({ queueItemId: input.queueItemId, followUpId: input.followUpId });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const REMOVE_QUEUE_FOLLOW_UP_DESCRIPTION =
    'Remove a follow-up by its id from a queue item. Remaining follow-ups ' +
    'keep their original ids (no shifting like with pre-prompt indices).';

export const REMOVE_QUEUE_FOLLOW_UP_TOOL: SharedToolDefinition<RemoveQueueFollowUpInput> = {
    name: 'tomAi_removeQueueFollowUp',
    displayName: 'Queue Remove Follow-Up',
    description: REMOVE_QUEUE_FOLLOW_UP_DESCRIPTION,
    tags: ['queue', 'follow-up', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId', 'followUpId'],
        properties: {
            queueItemId: { type: 'string' },
            followUpId: { type: 'string' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROMPT_QUEUE_TOOLS: SharedToolDefinition<any>[] = [
    ADD_QUEUE_ITEM_TOOL,
    LIST_QUEUE_TOOL,
    SEND_QUEUED_PROMPT_TOOL,
    RESEND_QUEUE_ITEM_TOOL,
    SET_QUEUE_ITEM_STATUS_TOOL,
    UPDATE_QUEUE_ITEM_TOOL,
    REMOVE_QUEUE_ITEM_TOOL,
    ADD_QUEUE_PRE_PROMPT_TOOL,
    UPDATE_QUEUE_PRE_PROMPT_TOOL,
    REMOVE_QUEUE_PRE_PROMPT_TOOL,
    ADD_QUEUE_FOLLOW_UP_TOOL,
    UPDATE_QUEUE_FOLLOW_UP_TOOL,
    REMOVE_QUEUE_FOLLOW_UP_TOOL,
];
