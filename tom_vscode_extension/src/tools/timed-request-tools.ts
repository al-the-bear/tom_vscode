/**
 * Timed-request tools — `tomAi_addTimedRequest`,
 * `tomAi_listTimedRequests`, `tomAi_updateTimedRequest`,
 * `tomAi_removeTimedRequest`, `tomAi_setTimerEngineState`.
 *
 * Carved out of `chat-enhancement-tools.ts` for coverage entry #19.
 *
 * ## What this is NOT
 *
 *   - **NOT a cron scheduler.** There is no cron syntax. The two
 *     schedule modes are:
 *       - `interval`: fire every N minutes (minimum 1, no maximum).
 *       - `scheduled`: fire at specific HH:MM slots. Each slot is
 *         either daily (just `time`) or one-shot (`time` + `date` as
 *         `YYYY-MM-DD`). One-shot slots auto-remove themselves after
 *         firing.
 *   - **NOT a fast scheduler.** The engine polls every minute. A
 *     scheduled slot at 14:30:45 fires at the next minute boundary
 *     ≥ 14:30:45 — so usually 14:31, sometimes 14:30 if the engine
 *     poll runs in that second.
 *   - **NOT timezone-configurable.** All HH:MM slots are in the VS
 *     Code host's local timezone.
 *
 * ## Engine on/off semantics (THE TRAP)
 *
 * For an entry to fire, **TWO switches must both be on**:
 *
 *   1. **`timer.timerActivated`** (global engine kill switch) —
 *      controlled by `tomAi_setTimerEngineState`. When off, NO entries
 *      fire regardless of their individual `enabled` flag.
 *   2. **`entry.enabled`** (per-entry switch) — controlled by the
 *      `enabled` field on add/update. When off, that specific entry
 *      sleeps even if the engine is running.
 *
 * Toggling one without the other is the most common LLM mistake.
 * Every description now spells out both flags + their AND relationship.
 *
 * ## Missed-fire behaviour
 *
 *   - **`interval`**: the engine schedules the NEXT fire relative to
 *     the last actual fire. If you disable the entry mid-loop, the
 *     timer resets when you re-enable.
 *   - **`scheduled`**: missed slots (engine off, entry disabled, VS
 *     Code closed) do NOT catch up — the slot just didn't fire that
 *     day. The model should not rely on "exactly N fires per day"
 *     guarantees during periods of intermittent activity.
 *   - **Overlapping fires** (e.g. interval=1 but the entry's prompt
 *     takes 90 s to answer): the engine awaits each fire's answer (or
 *     `answerWaitMinutes` timeout) before scheduling the next one.
 *     No parallel fires per entry.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Shared shapes
// ===========================================================================

export type TimedScheduleMode = 'interval' | 'scheduled';
export type TimedEntryStatus = 'pending' | 'running' | 'paused' | 'completed' | 'cancelled';

export interface TimedScheduleSlot {
    /** HH:MM 24-hour. */
    time: string;
    /** Optional YYYY-MM-DD. When set, the slot fires once on that date and removes itself. */
    date?: string;
}

export interface TimedEntrySnapshot {
    id: string;
    status: TimedEntryStatus;
    enabled: boolean;
    template?: string;
    answerWrapper?: boolean;
    originalText: string;
    scheduleMode: TimedScheduleMode;
    intervalMinutes?: number;
    scheduledTimes?: TimedScheduleSlot[];
    repeatCount?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    sendMaximum?: number;
    answerWaitMinutes?: number;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    lastSentAt?: number;
}

export interface AddTimedEntryInput {
    text: string;
    template?: string;
    answerWrapper?: boolean;
    enabled?: boolean;
    /** Default `interval`. */
    scheduleMode?: TimedScheduleMode;
    /** For `interval` mode. Min 1, default 30. */
    intervalMinutes?: number;
    /** For `scheduled` mode. */
    scheduledTimes?: TimedScheduleSlot[];
    repeatCount?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    sendMaximum?: number;
    answerWaitMinutes?: number;
    reminderEnabled?: boolean;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
}

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface TimerEngineAccess {
    entries(): TimedEntrySnapshot[];
    /** Global engine kill switch. */
    isTimerActivated(): boolean;
    setTimerActivated(v: boolean): void;
    getEntry(id: string): TimedEntrySnapshot | undefined;
    addEntry(spec: Omit<TimedEntrySnapshot, 'id' | 'status'>): TimedEntrySnapshot;
    updateEntry(id: string, patch: Partial<Omit<TimedEntrySnapshot, 'id'>>): TimedEntrySnapshot | undefined;
    removeEntry(id: string): boolean;
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

function validateScheduleSlot(slot: TimedScheduleSlot): string | null {
    if (!slot.time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) {
        return `\`time\` must be 24-hour HH:MM (got "${slot.time}")`;
    }
    if (slot.date && !/^\d{4}-\d{2}-\d{2}$/.test(slot.date)) {
        return `\`date\` must be YYYY-MM-DD (got "${slot.date}")`;
    }
    return null;
}

function compactEntry(e: TimedEntrySnapshot): Record<string, unknown> {
    return {
        id: e.id,
        status: e.status,
        enabled: !!e.enabled,
        template: e.template,
        answerWrapper: !!e.answerWrapper,
        scheduleMode: e.scheduleMode,
        intervalMinutes: e.intervalMinutes ?? null,
        scheduledTimes: e.scheduledTimes ?? [],
        reminderEnabled: !!e.reminderEnabled,
        reminderTemplateId: e.reminderTemplateId ?? null,
        reminderTimeoutMinutes: e.reminderTimeoutMinutes ?? null,
        reminderRepeat: !!e.reminderRepeat,
        lastSentAt: e.lastSentAt ?? null,
        textPreview: String(e.originalText ?? '').slice(0, 160),
    };
}

// ===========================================================================
// tomAi_addTimedRequest
// ===========================================================================

export async function addTimedRequestImpl(access: TimerEngineAccess, input: AddTimedEntryInput): Promise<string> {
    try {
        if (!input.text || !input.text.trim()) {
            return err('`text` is required.');
        }
        const scheduleMode: TimedScheduleMode = input.scheduleMode ?? 'interval';
        if (scheduleMode === 'scheduled') {
            if (!input.scheduledTimes || input.scheduledTimes.length === 0) {
                return err('`scheduledTimes` is required when `scheduleMode: "scheduled"` (at least one HH:MM slot).');
            }
            for (const slot of input.scheduledTimes) {
                const slotErr = validateScheduleSlot(slot);
                if (slotErr) { return err(slotErr); }
            }
        }
        const entry = access.addEntry({
            enabled: input.enabled ?? false,
            template: input.template ?? '(None)',
            answerWrapper: input.answerWrapper,
            originalText: input.text,
            scheduleMode,
            intervalMinutes: scheduleMode === 'interval' ? Math.max(1, input.intervalMinutes ?? 30) : undefined,
            scheduledTimes: scheduleMode === 'scheduled' ? input.scheduledTimes : [],
            repeatCount: input.repeatCount,
            repeatPrefix: input.repeatPrefix,
            repeatSuffix: input.repeatSuffix,
            sendMaximum: input.sendMaximum,
            answerWaitMinutes: input.answerWaitMinutes,
            reminderEnabled: input.reminderEnabled,
            reminderTemplateId: input.reminderTemplateId,
            reminderTimeoutMinutes: input.reminderTimeoutMinutes,
            reminderRepeat: input.reminderRepeat,
        });
        return ok({
            id: entry.id,
            status: entry.status,
            enabled: entry.enabled,
            scheduleMode: entry.scheduleMode,
            intervalMinutes: entry.intervalMinutes ?? null,
            scheduledTimes: entry.scheduledTimes ?? [],
            // Warn the model when the entry won't fire because the global engine is off.
            warning: entry.enabled && !access.isTimerActivated()
                ? 'Entry created with `enabled: true` but the global timer engine is OFF. Call `tomAi_setTimerEngineState` to enable.'
                : undefined,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const ADD_TIMED_REQUEST_DESCRIPTION =
    'Add a timed request entry. **NO cron syntax** — two `scheduleMode` ' +
    'options: `interval` (default, fires every N `intervalMinutes`, min 1, ' +
    'default 30) and `scheduled` (fires at specific `scheduledTimes` HH:MM ' +
    'slots in the host\'s local timezone). For `scheduled`, each slot is ' +
    '`{time: "HH:MM"}` for daily recurrence or `{time: "HH:MM", date: ' +
    '"YYYY-MM-DD"}` for **one-shot** firing (slot auto-removes after). ' +
    '**ENGINE-AND-ENTRY DUAL SWITCH (THE TRAP)**: for an entry to fire, ' +
    '**BOTH** `entry.enabled` (this field, default false) AND the global ' +
    '`timer.timerActivated` (controlled by `tomAi_setTimerEngineState`) must ' +
    'be true. Response surfaces a `warning` when you set `enabled: true` ' +
    'while the global engine is off. Supports per-entry `repeatCount` ' +
    '(count/prefix/suffix), `sendMaximum` (auto-pause after N sends), and ' +
    '`reminder*` config.';

export const ADD_TIMED_REQUEST_TOOL: SharedToolDefinition<AddTimedEntryInput> = {
    name: 'tomAi_addTimedRequest',
    displayName: 'Add Timed Request',
    description: ADD_TIMED_REQUEST_DESCRIPTION,
    tags: ['timed', 'queue', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['text'],
        properties: {
            text: { type: 'string' },
            template: { type: 'string' },
            answerWrapper: { type: 'boolean' },
            enabled: { type: 'boolean', description: 'Per-entry switch. Default false. AND-ed with `timer.timerActivated`.' },
            scheduleMode: { type: 'string', enum: ['interval', 'scheduled'], description: 'Default `interval`.' },
            intervalMinutes: { type: 'number', description: 'For `interval` mode. Min 1, default 30.' },
            scheduledTimes: {
                type: 'array',
                description: 'For `scheduled` mode. Each slot: `{time: "HH:MM"}` (daily) or `{time, date: "YYYY-MM-DD"}` (one-shot).',
                items: {
                    type: 'object',
                    required: ['time'],
                    properties: {
                        time: { type: 'string', description: '24-hour HH:MM.' },
                        date: { type: 'string', description: 'Optional YYYY-MM-DD for one-shot.' },
                    },
                },
            },
            repeatCount: { type: 'number' },
            repeatPrefix: { type: 'string' },
            repeatSuffix: { type: 'string' },
            sendMaximum: { type: 'number', description: 'Auto-pause after N sends; 0 = no cap.' },
            answerWaitMinutes: { type: 'number' },
            reminderEnabled: { type: 'boolean' },
            reminderTemplateId: { type: 'string' },
            reminderTimeoutMinutes: { type: 'number' },
            reminderRepeat: { type: 'boolean' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_listTimedRequests
// ===========================================================================

export interface ListTimedRequestsInput {
    includeCompleted?: boolean;
}

export async function listTimedRequestsImpl(access: TimerEngineAccess, input: ListTimedRequestsInput): Promise<string> {
    try {
        const includeCompleted = !!input.includeCompleted;
        const entries = access.entries()
            .filter((e) => includeCompleted || e.status !== 'completed')
            .map(compactEntry);
        return JSON.stringify({
            ok: true,
            timerActivated: access.isTimerActivated(),
            totalCount: entries.length,
            entries,
        }, null, 2);
    } catch (e) {
        return err((e as Error).message);
    }
}

export const LIST_TIMED_REQUESTS_DESCRIPTION =
    'List timed-request entries with status, enabled flag, schedule, and ' +
    'reminder metadata. Response opens with **`timerActivated`** (the global ' +
    'engine state) so you can tell at a glance whether any entries will ' +
    'actually fire — an enabled entry with `timerActivated: false` is ' +
    'effectively paused. Default excludes `completed` entries; pass ' +
    '`includeCompleted: true` for the full history.';

export const LIST_TIMED_REQUESTS_TOOL: SharedToolDefinition<ListTimedRequestsInput> = {
    name: 'tomAi_listTimedRequests',
    displayName: 'Timed List',
    description: LIST_TIMED_REQUESTS_DESCRIPTION,
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeCompleted: { type: 'boolean' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_updateTimedRequest
// ===========================================================================

export interface UpdateTimedRequestInput {
    entryId: string;
    patch: {
        enabled?: boolean;
        template?: string;
        answerWrapper?: boolean;
        originalText?: string;
        scheduleMode?: TimedScheduleMode;
        intervalMinutes?: number;
        scheduledTimes?: TimedScheduleSlot[];
        reminderEnabled?: boolean;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        repeatCount?: number;
        repeatPrefix?: string;
        repeatSuffix?: string;
        sendMaximum?: number;
        answerWaitMinutes?: number;
    };
}

export async function updateTimedRequestImpl(access: TimerEngineAccess, input: UpdateTimedRequestInput): Promise<string> {
    try {
        if (!input.entryId || !input.patch) {
            return err('`entryId` and `patch` are both required.');
        }
        if (input.patch.scheduledTimes) {
            for (const slot of input.patch.scheduledTimes) {
                const slotErr = validateScheduleSlot(slot);
                if (slotErr) { return err(slotErr); }
            }
        }
        const updated = access.updateEntry(input.entryId, input.patch);
        if (!updated) {
            return err(`Timed entry "${input.entryId}" not found. Use \`tomAi_listTimedRequests\` to see available ids.`);
        }
        return ok({
            id: updated.id,
            status: updated.status,
            enabled: updated.enabled,
            scheduleMode: updated.scheduleMode,
            warning: updated.enabled && !access.isTimerActivated()
                ? 'Entry is enabled but the global timer engine is OFF. Call `tomAi_setTimerEngineState` to enable.'
                : undefined,
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const UPDATE_TIMED_REQUEST_DESCRIPTION =
    'Patch fields on an existing timed entry. **Switching scheduleMode** ' +
    '(interval ↔ scheduled) is supported — clear `intervalMinutes` or ' +
    '`scheduledTimes` as appropriate when switching. HH:MM slots are ' +
    'validated against `^([01]\\d|2[0-3]):[0-5]\\d$`; date slots against ' +
    '`^\\d{4}-\\d{2}-\\d{2}$`. Setting `enabled: true` while the global ' +
    'engine is off surfaces the same warning as add. **Repeat/wait/reminder/' +
    'sendMaximum** fields are independent of the schedule and persist across ' +
    'mode switches.';

export const UPDATE_TIMED_REQUEST_TOOL: SharedToolDefinition<UpdateTimedRequestInput> = {
    name: 'tomAi_updateTimedRequest',
    displayName: 'Timed Update Entry',
    description: UPDATE_TIMED_REQUEST_DESCRIPTION,
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['entryId', 'patch'],
        properties: {
            entryId: { type: 'string' },
            patch: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    template: { type: 'string' },
                    answerWrapper: { type: 'boolean' },
                    originalText: { type: 'string' },
                    scheduleMode: { type: 'string', enum: ['interval', 'scheduled'] },
                    intervalMinutes: { type: 'number' },
                    scheduledTimes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['time'],
                            properties: {
                                time: { type: 'string', description: '24-hour HH:MM.' },
                                date: { type: 'string', description: 'Optional YYYY-MM-DD for one-shot.' },
                            },
                        },
                    },
                    reminderEnabled: { type: 'boolean' },
                    reminderTemplateId: { type: 'string' },
                    reminderTimeoutMinutes: { type: 'number' },
                    reminderRepeat: { type: 'boolean' },
                    repeatCount: { type: 'number' },
                    repeatPrefix: { type: 'string' },
                    repeatSuffix: { type: 'string' },
                    sendMaximum: { type: 'number' },
                    answerWaitMinutes: { type: 'number' },
                },
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_removeTimedRequest
// ===========================================================================

export interface RemoveTimedRequestInput {
    entryId: string;
}

export async function removeTimedRequestImpl(access: TimerEngineAccess, input: RemoveTimedRequestInput): Promise<string> {
    try {
        if (!input.entryId) { return err('`entryId` is required.'); }
        const removed = access.removeEntry(input.entryId);
        return ok({ deletedId: input.entryId, existed: removed });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const REMOVE_TIMED_REQUEST_DESCRIPTION =
    'Remove a timed entry by id. **Idempotent** — succeeds whether the entry ' +
    'existed or not (`existed` flag in the response says which). To temporarily ' +
    'pause an entry without removing it, set `enabled: false` via ' +
    '`tomAi_updateTimedRequest` instead.';

export const REMOVE_TIMED_REQUEST_TOOL: SharedToolDefinition<RemoveTimedRequestInput> = {
    name: 'tomAi_removeTimedRequest',
    displayName: 'Timed Remove Entry',
    description: REMOVE_TIMED_REQUEST_DESCRIPTION,
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['entryId'],
        properties: { entryId: { type: 'string' } },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// tomAi_setTimerEngineState
// ===========================================================================

export interface SetTimerEngineStateInput {
    activated: boolean;
}

export async function setTimerEngineStateImpl(access: TimerEngineAccess, input: SetTimerEngineStateInput): Promise<string> {
    try {
        if (typeof input.activated !== 'boolean') {
            return err('`activated` (boolean) is required.');
        }
        const previous = access.isTimerActivated();
        access.setTimerActivated(input.activated);
        // Count enabled entries so the model can see how many will actually start firing.
        const enabledCount = access.entries().filter((e) => e.enabled).length;
        return ok({
            timerActivated: input.activated,
            wasPreviously: previous,
            enabledEntries: enabledCount,
            note: input.activated
                ? `${enabledCount} entry(ies) with enabled:true will now fire on their schedule.`
                : 'All entries paused. Re-enable to resume.',
        });
    } catch (e) {
        return err((e as Error).message);
    }
}

export const SET_TIMER_ENGINE_STATE_DESCRIPTION =
    'Toggle the **global timer engine** on or off. This is the kill switch ' +
    'that AND-gates every entry: with the engine off, no entries fire ' +
    'regardless of their per-entry `enabled` flag. Response surfaces ' +
    '`wasPreviously` (so idempotent calls are visible) and `enabledEntries` ' +
    '(count of entries that will resume firing when activated). To query ' +
    'the current state without changing it, use `tomAi_listTimedRequests` ' +
    'and read the `timerActivated` field at the top of the response.';

export const SET_TIMER_ENGINE_STATE_TOOL: SharedToolDefinition<SetTimerEngineStateInput> = {
    name: 'tomAi_setTimerEngineState',
    displayName: 'Timed Set Engine State',
    description: SET_TIMER_ENGINE_STATE_DESCRIPTION,
    tags: ['timed', 'copilot', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['activated'],
        properties: { activated: { type: 'boolean' } },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TIMED_REQUEST_TOOLS: SharedToolDefinition<any>[] = [
    ADD_TIMED_REQUEST_TOOL,
    LIST_TIMED_REQUESTS_TOOL,
    UPDATE_TIMED_REQUEST_TOOL,
    REMOVE_TIMED_REQUEST_TOOL,
    SET_TIMER_ENGINE_STATE_TOOL,
];
