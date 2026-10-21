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

import { SharedToolDefinition } from './shared-tool-registry';
import { todoPrefixPatternError } from '../utils/queueStep3Utils';

// ===========================================================================
// Shared shapes
// ===========================================================================

export type QueueStatus = 'staged' | 'pending' | 'sending' | 'sent' | 'error' | 'decision-needed' | 'interrupted';
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
    answerText?: string;
    lastDispatched?: string;
    warning?: string;
}

// ===========================================================================
// Enqueue input — composite that drives addQueueItem
// ===========================================================================

export interface EnqueueInput {
    originalText: string;
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
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    session?: string;
    prePrompts?: PrePromptSpec[];
    followUps?: FollowUpSpec[];
}

// ===========================================================================
// Narrow PromptQueueAccess dep
// ===========================================================================

export interface PromptQueueAccess {
    /** Snapshot of `queue.items`, in queue order. */
    items(): QueueItemSnapshot[];
    autoSendEnabled(): boolean;
    responseFileTimeoutMinutes(): number;
    pendingCount(): number;

    getById(id: string): QueueItemSnapshot | undefined;
    getByRequestId(requestId: string): QueueItemSnapshot | undefined;

    enqueue(input: EnqueueInput): Promise<QueueItemSnapshot>;
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
    updateItemRepetition(id: string, opts: {
        repeatCount?: number | string;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        answerWaitMinutes?: number;
    }): void;
    updateItemTransport(id: string, opts: {
        transport?: QueueTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): void;
    /** Set an item's Agent SDK session ('' = the queue default); false when the item cannot change. */
    updateItemSession?(id: string, session: string): boolean;

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
const API_KEY_WARNING_DOC = ' The answer carries `warning` when a stage of the item runs on an Anthropic profile '
    + 'whose configuration uses the direct API and whose key variable is not in this VS Code\'s environment: every '
    + 'send of that stage would fail. The item is kept; pick another profile (an Agent SDK one) or have the key set '
    + 'and VS Code restarted.';

function apiKeyWarning(access: PromptQueueAccess, itemId: string | undefined): { warning?: string } {
    const lines = itemId ? access.missingApiKeyWarnings?.(itemId) ?? [] : [];
    return lines.length > 0 ? { warning: lines.join('\n') } : {};
}

/** What a queue item's `session` is. */
const SESSION_DOC = 'The named session the item runs in: a `<name>.session.json` of the quest\'s history folder '
    + '(tomAi_listSessions; create one with tomAi_createSession, e.g. a session re-created from a prepared base for every '
    + 'prompt). Unset: the queue default, else the queue\'s own `default`. On the Agent SDK transport it is the SDK '
    + 'conversation; on the direct API transport the session\'s own history (`chat` and `default` share the quest\'s).';

/** How a repeat count is written, for every tool that takes one. */
const REPEAT_COUNT_DOC = 'Literal number, chat-variable name, or `<prefix>*`: walk the quest\'s todos whose id starts with '
    + '<prefix>, lowest number first (the number is the first digit run after the prefix). The prefix may hold digits '
    + '(`p2s2ss3-*`) but must not end in one (refused with code invalidTodoPrefix). The text names the todo each dispatch '
    + 'picked with `${repeatTodoId}` (its id), `${repeatTodoTitle}` and `${repeatNumber}`, filled in when it is sent; the '
    + 'picked todo is set in-progress, and a todo the work creates with the next free number joins the walk.';

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
        transport: i.transport || 'copilot',
        anthropicProfileId: i.anthropicProfileId || null,
        anthropicConfigId: i.anthropicConfigId || null,
        session: i.session || null,
        answerText: i.answerText || null,
    };
}

// ===========================================================================
// tomAi_addQueueItem
// ===========================================================================

export interface AddQueueItemInput {
    text: string;
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
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The named Agent SDK session the item runs in ('' = the queue default). */
    session?: string;
}

export async function addQueueItemImpl(access: PromptQueueAccess, input: AddQueueItemInput): Promise<string> {
    try {
        if (!input.text || !input.text.trim()) {
            return err('`text` is required.');
        }
        const refused = repeatCountRefusal(input.repeatCount, input.templateRepeatCount,
            ...(input.prePrompts ?? []).map((p) => p.repeatCount), ...(input.followUps ?? []).map((f) => f.repeatCount));
        if (refused) { return refused; }
        const item = await access.enqueue({
            originalText: input.text,
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
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
            reminderEnabled: input.reminderEnabled,
            transport: input.transport,
            anthropicProfileId: input.anthropicProfileId,
            anthropicConfigId: input.anthropicConfigId,
            ...(input.session ? { session: input.session } : {}),
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
            ...apiKeyWarning(access, item.id),
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const ADD_QUEUE_ITEM_DESCRIPTION =
    'Stage a new prompt-queue item with optional pre-prompts, main-prompt ' +
    'config, and follow-ups all in one call. **Default `deferSend: true`** ' +
    '— the item is created in the `staged` state, NOT sent immediately. ' +
    'Call `tomAi_sendQueuedPrompt` afterwards to start the lifecycle ' +
    '(manager auto-chains through pre-prompts → main → follow-ups, waiting ' +
    'on each answer). `repeatCount`/`templateRepeatCount` accept a literal ' +
    'number or a chat-variable name (resolved at send time, decremented per ' +
    'iteration). `transport` defaults to `copilot`; pass `anthropic` for ' +
    'unattended Anthropic dispatch (requires `anthropicProfileId`; falls back ' +
    'to the default profile when omitted). The canonical add → addFollowUp → ' +
    'sendQueuedPrompt workflow is documented in detail on the Prompt Queue ' +
    'spec — this tool is step 1.' + API_KEY_WARNING_DOC;

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
            prePrompts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            followUps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            repeatCount: { description: REPEAT_COUNT_DOC },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            templateRepeatCount: { description: 'Literal number or chat-variable name.' },
            answerWaitMinutes: { type: 'number' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
            reminderEnabled: { type: 'boolean' },
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
            session: { type: 'string', description: SESSION_DOC },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listQueue
// ===========================================================================

export interface ListQueueInput { includeSent?: boolean }

export async function listQueueImpl(access: PromptQueueAccess, input: ListQueueInput): Promise<string> {
    try {
        const includeSent = !!input.includeSent;
        const items = access.items()
            .filter((i) => includeSent || i.status !== 'sent')
            .map(compactItem);
        return JSON.stringify({
            ok: true,
            autoSendEnabled: access.autoSendEnabled(),
            responseTimeoutMinutes: access.responseFileTimeoutMinutes(),
            pendingCount: access.pendingCount(),
            totalCount: items.length,
            items,
        }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_QUEUE_DESCRIPTION =
    'List queue items with status, ids, reminder metadata, transport, and ' +
    'follow-up counts. **Default excludes `sent` items** — pass ' +
    '`includeSent: true` to see the whole history. Response includes ' +
    '`autoSendEnabled`, `responseTimeoutMinutes`, and `pendingCount` so the ' +
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

export interface ResendQueueItemInput { queueItemId: string }

export async function resendQueueItemImpl(access: PromptQueueAccess, input: ResendQueueItemInput): Promise<string> {
    try {
        if (!input.queueItemId) { return err('`queueItemId` is required.'); }
        await access.resendLastPrompt(input.queueItemId);
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
    'least once); resend on a never-sent item is an error.';

export const RESEND_QUEUE_ITEM_TOOL: SharedToolDefinition<ResendQueueItemInput> = {
    name: 'tomAi_resendQueueItem',
    displayName: 'Queue Resend Last Prompt',
    description: RESEND_QUEUE_ITEM_DESCRIPTION,
    tags: ['queue', 'copilot', 'tom-ai-chat', 'anthropic'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['queueItemId'],
        properties: { queueItemId: { type: 'string' } },
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
    transport?: QueueTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The named Agent SDK session the item runs in ('' = the queue default). */
    session?: string;
}

export async function updateQueueItemImpl(access: PromptQueueAccess, input: UpdateQueueItemInput): Promise<string> {
    try {
        if (!input.queueItemId) { return err('`queueItemId` is required.'); }
        const refused = repeatCountRefusal(input.repeatCount, input.templateRepeatCount);
        if (refused) { return refused; }
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
            input.answerWaitMinutes !== undefined) {
            access.updateItemRepetition(input.queueItemId, {
                repeatCount: input.repeatCount,
                repeatPrefix: input.repeatPrefix,
                repeatSuffix: input.repeatSuffix,
                templateRepeatCount: input.templateRepeatCount,
                answerWaitMinutes: input.answerWaitMinutes,
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
        const updated = access.getById(input.queueItemId);
        return ok({
            id: input.queueItemId,
            status: updated?.status,
            template: updated?.template,
            answerWrapper: !!updated?.answerWrapper,
            reminderEnabled: !!updated?.reminderEnabled,
            repeatCount: updated?.repeatCount ?? null,
            templateRepeatCount: updated?.templateRepeatCount ?? null,
            answerWaitMinutes: updated?.answerWaitMinutes ?? null,
            transport: updated?.transport ?? 'copilot',
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
    'for follow-ups use `tomAi_updateQueueFollowUp`.';

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
            transport: { type: 'string', enum: ['copilot', 'anthropic'] },
            anthropicProfileId: { type: 'string' },
            anthropicConfigId: { type: 'string' },
            session: { type: 'string', description: SESSION_DOC },
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
