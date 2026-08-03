export interface RepeatDecision {
    shouldRepeat: boolean;
    nextRepeatIndex: number;
    progressLabel: string;
}

export interface RepetitionAffixInput {
    originalText: string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    repeatCount?: number | string;
    repeatIndex?: number;
}

/**
 * Compute repeat decision. repeatCount can be a number or a string.
 * If string, expects caller to have already resolved it via resolveRepeatCount().
 */
export function computeRepeatDecision(input: { repeatCount?: number | string; repeatIndex?: number }, resolvedCount?: number): RepeatDecision {
    // If resolvedCount is provided, use it; otherwise try to parse repeatCount directly
    let repeatCount: number;
    if (resolvedCount !== undefined) {
        repeatCount = Math.max(1, Math.round(resolvedCount));
    } else if (typeof input.repeatCount === 'number') {
        repeatCount = Math.max(1, Math.round(input.repeatCount || 1));
    } else {
        // String value - try to parse as number, default to 1
        const parsed = parseInt(String(input.repeatCount || '1'), 10);
        repeatCount = Math.max(1, isNaN(parsed) ? 1 : parsed);
    }
    const repeatIndex = Math.max(0, Math.round(input.repeatIndex || 0));
    if (repeatCount <= 1) {
        return {
            shouldRepeat: false,
            nextRepeatIndex: repeatIndex,
            progressLabel: '1/1',
        };
    }

    // repeatCount is total number of sends (including the original)
    // repeatIndex is 0-based: first send is index 0
    // shouldRepeat is true if we haven't yet reached the target count
    const currentSendNumber = repeatIndex + 1; // 1-based send number
    const shouldRepeat = currentSendNumber < repeatCount;
    const nextRepeatIndex = repeatIndex + 1;
    return {
        shouldRepeat,
        nextRepeatIndex,
        progressLabel: `${currentSendNumber}/${repeatCount}`,
    };
}

export function shouldAutoPauseOnEmpty(autoSendEnabled: boolean, pendingCount: number, autoPauseEnabled = true): boolean {
    return autoPauseEnabled && autoSendEnabled && pendingCount <= 0;
}

/** What happens to the queue once an item has finished its last stage. */
export interface QueueAdvanceDecision {
    /** Start the next pending item. */
    advance: boolean;
    /** Flip auto-send off and persist the setting. */
    disableAutoSend: boolean;
}

/**
 * Decide whether the queue moves on after a completed item.
 *
 * There are two independent reasons not to: the queue is paused
 * (`autoSendEnabled` off), or the item carries the per-item "pause after
 * this" flag. Both are answered here rather than at the call sites, because
 * answering them separately is precisely how the queue used to keep running
 * while paused — the Anthropic completion tails checked the flag but not the
 * toggle. One question, one answer, one place.
 *
 * `disableAutoSend` is the flag's side effect: pausing via `pauseAfter` puts
 * the queue in the same visible, reload-surviving state as pausing by hand,
 * instead of a silent one-off skip.
 */
export function decideAdvanceAfterCompletion(
    pauseAfter: boolean | undefined,
    autoSendEnabled: boolean,
): QueueAdvanceDecision {
    if (pauseAfter) {
        return { advance: false, disableAutoSend: autoSendEnabled };
    }
    return { advance: autoSendEnabled, disableAutoSend: false };
}

/**
 * Normalize a repeat-count value coming from a UI/webview input into the shape
 * the queue persists.
 *
 * Non-numeric strings — chat-variable names and `prefix*` patterns (e.g.
 * `dsa*`) — are preserved **verbatim** so they resolve at processing time
 * (see {@link resolveTodoPrefixRepeatCount} and the manager's
 * `resolveStableRepeatCount`). Numbers and purely-numeric strings are coerced
 * to a non-negative integer. Anything else falls back to `0`.
 *
 * Extracted so every enqueue entry point (chat panel, queue editor, …) shares
 * one rule; coercing `Number('dsa*')` at enqueue previously produced `NaN` and
 * silently dropped the variable before the deferred resolver ever saw it.
 */
export function normalizeRepeatCountInput(value: number | string | undefined): number | string {
    if (typeof value === 'string' && !/^[0-9]+$/.test(value)) {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'string') {
        return Math.max(0, Math.round(Number(value) || 0));
    }
    return 0;
}

/**
 * How editable a queue item's repeat controls are, keyed on its status.
 *
 * - `full`     — every repeat field (counters + prefix/suffix/answer-wait).
 *                Applies while the item is still ahead of dispatch.
 * - `counters` — only the loop counters (main + template repeat count and
 *                current index). Applies while the item is in flight so the
 *                user can steer a running loop; the change takes effect on the
 *                next repetition. Structural fields (prefix/suffix/answer-wait)
 *                are frozen for the run.
 * - `none`     — terminal / non-editable.
 */
export type RepeatEditMode = 'full' | 'counters' | 'none';

export function computeRepeatEditability(status: string): RepeatEditMode {
    if (status === 'staged' || status === 'pending') { return 'full'; }
    if (status === 'sending' || status === 'waiting') { return 'counters'; }
    return 'none';
}

/**
 * The repeat fields a queue item exposes to editing. Structurally a subset of
 * `QueuedPrompt`, kept vscode-free so the edit logic is unit-testable.
 */
export interface RepeatEditTarget {
    repeatCount?: number | string;
    resolvedRepeatCount?: number;
    repeatIndex?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    answerWaitMinutes?: number;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
}

/** The patch shape accepted by `updateItemRepeat` messages. */
export interface RepeatEditPatch {
    repeatCount?: number | string;
    repeatIndex?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    answerWaitMinutes?: number;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
}

/**
 * Apply a repeat-field patch to a queue item, honouring the editability `mode`.
 *
 * The counter fields (main/template repeat count + current index) are applied
 * in both `full` and `counters` mode — this is what lets a *sending* item's
 * index and template counters be steered mid-loop, and what makes a *pending*
 * item's status-bar inputs actually stick (both were silently dropped before,
 * because the old gate only wrote counters for `staged`). The structural fields
 * (prefix/suffix/answer-wait) are applied only in `full` mode; `none` is a
 * no-op. Mutates `target` in place; pure otherwise.
 */
export function applyRepeatEditToItem(target: RepeatEditTarget, patch: RepeatEditPatch, mode: RepeatEditMode): void {
    if (mode === 'none') { return; }

    if (patch.repeatCount !== undefined) {
        // Accept both number and string (variable name); either way the cached
        // resolved value is stale and must be recomputed on next dispatch.
        if (typeof patch.repeatCount === 'string' && isNaN(parseInt(patch.repeatCount, 10))) {
            target.repeatCount = patch.repeatCount;
        } else {
            target.repeatCount = Math.max(0, Math.round(typeof patch.repeatCount === 'string' ? parseInt(patch.repeatCount, 10) || 0 : patch.repeatCount || 0));
        }
        target.resolvedRepeatCount = undefined;
    }
    if (patch.repeatIndex !== undefined) {
        target.repeatIndex = Math.max(0, Math.round(patch.repeatIndex || 0));
    }
    if (patch.templateRepeatCount !== undefined) {
        if (typeof patch.templateRepeatCount === 'string' && isNaN(parseInt(patch.templateRepeatCount, 10))) {
            target.templateRepeatCount = patch.templateRepeatCount;
        } else {
            const val = typeof patch.templateRepeatCount === 'string' ? parseInt(patch.templateRepeatCount, 10) || 0 : patch.templateRepeatCount || 0;
            target.templateRepeatCount = val > 0 ? val : undefined;
        }
    }
    if (patch.templateRepeatIndex !== undefined) {
        // 0-based — clamped non-negative. The dispatcher's computeRepeatDecision
        // decides whether the item is still in range vs templateRepeatCount.
        target.templateRepeatIndex = Math.max(0, Math.round(patch.templateRepeatIndex || 0));
    }

    if (mode !== 'full') { return; }

    if (patch.repeatPrefix !== undefined) {
        target.repeatPrefix = patch.repeatPrefix;
    }
    if (patch.repeatSuffix !== undefined) {
        target.repeatSuffix = patch.repeatSuffix;
    }
    if (patch.answerWaitMinutes !== undefined) {
        target.answerWaitMinutes = patch.answerWaitMinutes > 0 ? patch.answerWaitMinutes : undefined;
    }
}

/** The subset of a quest todo the `prefix*` iteration needs. */
export interface TodoIterationSource {
    id: string;
    status?: string;
    title?: string;
}

/** A quest todo that matched a `prefix*` pattern, with its parsed number. */
export interface TodoIterationEntry {
    /** Full todo id, e.g. `dsa2-a`. */
    id: string;
    /** The digit run immediately after the prefix, e.g. `2`. */
    index: number;
    /** Todo title/description, when the source carried one. */
    title?: string;
    /** Normalised status — lower-case, dashes, never empty. */
    status: string;
}

/** The one status that makes a todo eligible for dispatch. */
const NOT_STARTED = 'not-started';

/** The status that says "the user has not answered this todo's questions yet". */
const DECISION_NEEDED = 'decision-needed';

/**
 * Parse a `prefix*` repeat-count value into its prefix.
 *
 * Returns `undefined` for anything that is not such a pattern — a plain count,
 * a chat-variable name, a non-string, or a bare `*` (an empty prefix would
 * match every todo, which is never what the user meant).
 */
export function parseTodoPrefixPattern(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed.endsWith('*')) {
        return undefined;
    }
    const prefix = trimmed.slice(0, -1);
    return prefix.length > 0 ? prefix : undefined;
}

/** Normalise a hand-editable YAML status to the canonical dashed lower-case form. */
function normaliseStatus(status: string | undefined): string {
    const normalised = (status || '').trim().toLowerCase().replace(/_/g, '-');
    return normalised.length > 0 ? normalised : NOT_STARTED;
}

/**
 * Collect the todos matching `prefix` + digits, ordered for iteration.
 *
 * The number is the run of digits **immediately after** the prefix; trailing
 * characters are allowed and ignored, so `dsa15b` and `dsa7-review` contribute
 * 15 and 7. Ids that don't start with the prefix, or whose first character
 * after it isn't a digit (`dsable`, `dsa_2`), are dropped.
 *
 * The order is number ascending, then id alphabetically — so a series that
 * shares a number (`dsa2-a`, `dsa2-b`) is walked in a stable, predictable
 * order rather than in readdir order.
 */
export function collectPrefixTodos(
    prefix: string,
    todos: readonly TodoIterationSource[],
): TodoIterationEntry[] {
    const entries: TodoIterationEntry[] = [];
    for (const todo of todos) {
        const id = todo?.id;
        if (typeof id !== 'string' || !id.startsWith(prefix)) {
            continue;
        }
        const match = /^(\d+)/.exec(id.slice(prefix.length));
        if (!match) {
            continue;
        }
        entries.push({
            id,
            index: parseInt(match[1], 10),
            title: todo.title,
            status: normaliseStatus(todo.status),
        });
    }
    entries.sort((a, b) => (a.index - b.index) || a.id.localeCompare(b.id));
    return entries;
}

/**
 * Pick the todo a `prefix*` iteration should dispatch next.
 *
 * Only `not-started` qualifies: `in-progress` means "we already dispatched
 * this one", and completed / cancelled / blocked todos are not work to do.
 * Because the dispatcher marks the picked todo `in-progress`, the candidate
 * set strictly shrinks — that is what makes the walk terminate.
 *
 * Returns `undefined` when the value is not a `prefix*` pattern, when nothing
 * matches the prefix, or when every matching todo has already been picked up.
 */
export function pickNextTodoForIteration(
    value: unknown,
    todos: readonly TodoIterationSource[],
): TodoIterationEntry | undefined {
    const prefix = parseTodoPrefixPattern(value);
    if (prefix === undefined) {
        return undefined;
    }
    return collectPrefixTodos(prefix, todos).find(e => e.status === NOT_STARTED);
}

/**
 * The todos of a `prefix*` series that are still waiting on the user.
 *
 * Returned in series order so the manager can name them in the order the user
 * will find them in the todo file.
 */
export function collectDecisionNeededTodos(
    value: unknown,
    todos: readonly TodoIterationSource[],
): TodoIterationEntry[] {
    const prefix = parseTodoPrefixPattern(value);
    if (prefix === undefined) {
        return [];
    }
    return collectPrefixTodos(prefix, todos).filter(e => e.status === DECISION_NEEDED);
}

/** What the main stage should send next — see {@link planMainStageDispatch}. */
export type MainStageDispatchPlan =
    | { mode: 'counter'; repeatIndex: number }
    | { mode: 'todo'; todo: TodoIterationEntry }
    | { mode: 'decision-needed'; todos: TodoIterationEntry[] }
    | { mode: 'exhausted' };

/**
 * Decide whether the main stage has another prompt to send, and what drives it.
 *
 * **Counter mode** (numeric or variable repeat count) sends while
 * `sentCount < repeatCount`, and reports the 0-based index of the repetition
 * about to go out.
 *
 * **Todo-iteration mode** (a `prefix*` repeat count) ignores `sentCount`
 * entirely: the loop runs while a `not-started` todo matching the prefix is
 * left. `repeatCount` stays meaningful only as the *displayed* series size.
 * Because the dispatcher marks the picked todo `in-progress`, the candidate
 * set strictly shrinks — the walk cannot loop forever.
 *
 * A prefix that matches no todo at all is `exhausted`, not a single run: a
 * "work on ${repeatTodoId}" prompt with no todo to name is worse than no
 * prompt. The caller logs that case.
 *
 * **Unmade decisions hold the whole series.** A `decision-needed` todo anywhere
 * in the matched set reports `decision-needed`, ahead of both the pick and the
 * exhausted check. Running a *sibling* todo past an open question means working
 * from a guess about the very thing still being decided; and reporting
 * `exhausted` would quietly finish the queue item with the question never
 * surfacing.
 */
export function planMainStageDispatch(
    repeatCountRaw: number | string | undefined,
    sentCount: number,
    repeatCount: number,
    todos: readonly TodoIterationSource[],
): MainStageDispatchPlan {
    if (parseTodoPrefixPattern(repeatCountRaw) !== undefined) {
        const waiting = collectDecisionNeededTodos(repeatCountRaw, todos);
        if (waiting.length > 0) {
            return { mode: 'decision-needed', todos: waiting };
        }
        const todo = pickNextTodoForIteration(repeatCountRaw, todos);
        return todo ? { mode: 'todo', todo } : { mode: 'exhausted' };
    }
    return sentCount < repeatCount ? { mode: 'counter', repeatIndex: sentCount } : { mode: 'exhausted' };
}

/**
 * Resolve a `prefix*` repeat-count against a set of quest-todo ids.
 *
 * The count is the **highest number** among the matching todos — see
 * {@link collectPrefixTodos} for the matching rule. It is the size of the
 * series, not the work left: status is deliberately ignored, so the displayed
 * total stays put while the iteration walks past already-completed todos.
 *
 * Returns `undefined` when `value` is not a `prefix*` pattern (so the caller
 * falls through to normal repeat-count resolution). When the pattern matches
 * but no numbered todo is found, returns `1` — a single run, never zero.
 *
 * Pure / context-free so it can be unit tested without the vscode-coupled
 * PromptQueueManager (mirrors the `computeRemovalEffect` pattern). Resolution
 * against the live quest todos must happen at **processing** time, not enqueue
 * time, so the manager reads the todo ids fresh and calls this helper from the
 * processing chokepoint.
 */
export function resolveTodoPrefixRepeatCount(
    value: number | string | undefined,
    todoIds: readonly string[],
): number | undefined {
    const prefix = parseTodoPrefixPattern(value);
    if (prefix === undefined) {
        return undefined;
    }
    const entries = collectPrefixTodos(prefix, todoIds.map(id => ({ id })));
    const highest = entries.length > 0 ? entries[entries.length - 1].index : 0;
    return Math.max(1, highest);
}

/** Outcome of removing one queue item — see {@link computeRemovalEffect}. */
export interface QueueRemovalEffect<T> {
    /** The items array with the target id filtered out. */
    items: T[];
    /** The removed item, or `undefined` when the id matched nothing. */
    removed: T | undefined;
    /** True when the removed item was the one currently `sending`. */
    wasSending: boolean;
    /**
     * Auto-send state the caller should adopt after the removal. Deleting the
     * `sending` item forces it OFF so the queue does not immediately dispatch
     * the next pending item after the user interrupted the running one;
     * otherwise the incoming value is preserved.
     */
    nextAutoSendEnabled: boolean;
}

/**
 * Pure decision for removing a queue item.
 *
 * Deleting the item that is currently `sending` must interrupt execution:
 * the caller has to abort the in-flight dispatch (signalled by `wasSending`)
 * and drop auto-send to OFF (`nextAutoSendEnabled`). Without this, the handler
 * keeps executing a prompt that no longer exists in the queue and the stop
 * button can't reach it (the sending item is gone), while auto-send would fire
 * the next pending prompt as if nothing happened.
 *
 * Kept pure/context-free so it can be unit tested without the vscode-coupled
 * PromptQueueManager (mirrors the `applyCrashRecovery` / `convertStagedToPending`
 * pattern).
 */
export function computeRemovalEffect<T extends { id: string; status: string }>(
    items: readonly T[],
    id: string,
    autoSendEnabled: boolean,
): QueueRemovalEffect<T> {
    const removed = items.find(i => i.id === id);
    const wasSending = removed?.status === 'sending';
    return {
        items: items.filter(i => i.id !== id),
        removed,
        wasSending,
        nextAutoSendEnabled: wasSending ? false : autoSendEnabled,
    };
}

/**
 * Put every `decision-needed` item back to `pending`, and report how many moved.
 *
 * Called when the user restarts the queue: the item re-enters the dispatch gate
 * and blocks again if the decisions are still open, so restarting is a *retry*
 * rather than an override. Only `status` is touched, so an item that had already
 * dispatched repetitions resumes on its counters instead of re-sending from the
 * top.
 *
 * Pure/context-free so it can be unit tested without the vscode-coupled
 * PromptQueueManager (mirrors the `convertStagedToPending` pattern).
 */
export function releaseDecisionNeededItems(items: Array<{ status: string }>): number {
    let changed = 0;
    for (const item of items) {
        if (item.status === DECISION_NEEDED) {
            item.status = 'pending';
            changed += 1;
        }
    }
    return changed;
}

export function convertStagedToPending(items: Array<{ status: string }>): number {
    let changed = 0;
    for (const item of items) {
        if (item.status === 'staged') {
            item.status = 'pending';
            changed += 1;
        }
    }
    return changed;
}

function fillRepetitionPlaceholders(template: string, repeatCount: number, repeatIndex: number): string {
    // Placeholder expansion is handled by the standard resolver in PromptQueueManager.
    // Keep this utility pure and context-free for deterministic unit tests.
    return template;
}

/**
 * Subset of a sending queue item the next-template-iteration builder
 * needs to read. Mirrors `QueuedPrompt` from `promptQueueManager.ts` for
 * the fields that survive across template iterations; kept local so the
 * pure helper has no dependency on the manager type.
 */
export interface NextTemplateIterationSource {
    originalText: string;
    template?: string;
    answerWrapper?: boolean;
    answerWaitMinutes?: number;
    type?: string;
    repeatCount?: number | string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    prePrompts?: Array<{
        text: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    followUps?: Array<{
        originalText: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
}

/**
 * Parameters for `PromptQueueManager.enqueue()` plus a `progressLabel`
 * the caller uses when logging. Returned by `buildNextTemplateIterationParams`
 * when another template iteration is required.
 */
export interface NextTemplateIterationParams {
    originalText: string;
    template?: string;
    answerWrapper?: boolean;
    answerWaitMinutes?: number;
    type?: string;
    repeatCount?: number | string;
    repeatIndex: 0;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string;
    templateRepeatIndex: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    prePrompts: Array<{
        text: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    followUps: Array<{
        originalText: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }>;
    initialStatus: 'pending';
    deferSend: true;
    /** Decision metadata — for logging. Not consumed by `enqueue()`. */
    progressLabel: string;
}

/**
 * Build the params to enqueue the next iteration of a template-repeat
 * sequence, or `null` when the sequence has reached its target count.
 *
 * Pure / unit-testable. Extracted from three identical inline blocks in
 * `PromptQueueManager` (answer-file, answer-wait timer, manual continue)
 * so the Anthropic-direct completion paths can share the same logic —
 * without this, items with `templateRepeatCount > 1` dispatched via the
 * synchronous Anthropic transport never spawned the second iteration
 * (the next-iteration enqueue lived only on Copilot/manual paths).
 */
export function buildNextTemplateIterationParams(
    sending: NextTemplateIterationSource,
    resolvedTemplateRepeatCount: number,
): NextTemplateIterationParams | null {
    const decision = computeRepeatDecision({
        repeatCount: sending.templateRepeatCount,
        repeatIndex: sending.templateRepeatIndex,
    }, resolvedTemplateRepeatCount);

    if (!decision.shouldRepeat) {
        return null;
    }

    return {
        originalText: sending.originalText,
        template: sending.template,
        answerWrapper: sending.answerWrapper,
        answerWaitMinutes: sending.answerWaitMinutes,
        type: sending.type,
        repeatCount: sending.repeatCount,
        repeatIndex: 0,
        repeatPrefix: sending.repeatPrefix,
        repeatSuffix: sending.repeatSuffix,
        templateRepeatCount: sending.templateRepeatCount,
        templateRepeatIndex: decision.nextRepeatIndex,
        reminderTemplateId: sending.reminderTemplateId,
        reminderTimeoutMinutes: sending.reminderTimeoutMinutes,
        reminderRepeat: sending.reminderRepeat,
        reminderEnabled: sending.reminderEnabled,
        prePrompts: (sending.prePrompts || []).map(pp => ({
            text: pp.text,
            template: pp.template,
            repeatCount: pp.repeatCount,
            answerWaitMinutes: pp.answerWaitMinutes,
            reminderTemplateId: pp.reminderTemplateId,
            reminderTimeoutMinutes: pp.reminderTimeoutMinutes,
            reminderRepeat: pp.reminderRepeat,
            reminderEnabled: pp.reminderEnabled,
        })),
        followUps: (sending.followUps || []).map(f => ({
            originalText: f.originalText,
            template: f.template,
            repeatCount: f.repeatCount,
            answerWaitMinutes: f.answerWaitMinutes,
            reminderTemplateId: f.reminderTemplateId,
            reminderTimeoutMinutes: f.reminderTimeoutMinutes,
            reminderRepeat: !!f.reminderRepeat,
            reminderEnabled: !!f.reminderEnabled,
        })),
        initialStatus: 'pending',
        deferSend: true,
        progressLabel: decision.progressLabel,
    };
}

export function applyRepetitionAffixes(input: RepetitionAffixInput): string {
    const rawCount = typeof input.repeatCount === 'string' ? parseInt(input.repeatCount, 10) || 0 : (input.repeatCount || 0);
    const repeatCount = Math.max(0, Math.round(rawCount));
    const repeatIndex = Math.max(0, Math.round(input.repeatIndex || 0));
    const prefix = (input.repeatPrefix || '').trim();
    const suffix = (input.repeatSuffix || '').trim();

    const segments: string[] = [];
    if (prefix.length > 0) {
        segments.push(fillRepetitionPlaceholders(prefix, repeatCount, repeatIndex));
    }

    segments.push(input.originalText);

    if (suffix.length > 0) {
        segments.push(fillRepetitionPlaceholders(suffix, repeatCount, repeatIndex));
    }

    return segments.join('\n\n');
}

/** Queue-level transport defaults, as surfaced by the dropdowns above the queue. */
export interface QueueTransportDefaults {
    transport: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

/** Minimal shape of a queued item's transport/profile override fields. */
export interface QueueTransportTarget {
    transport?: 'copilot' | 'anthropic';
    anthropicProfileId?: string;
    anthropicConfigId?: string;
}

/**
 * Copy the queue-level default transport + Anthropic profile (and its derived
 * config) onto a single item, mutating and returning it.
 *
 * This is the "adopt queue settings" action wired to the per-item header
 * button. Unlike the staged-only per-item override (`updateItemTransport`),
 * it is meant to run for an item in ANY status — including a currently
 * sending/repeating item — so the caller applies it without an
 * editable-status guard. Only the transport and Anthropic profile/config are
 * touched; status, repetition counters, template and text are deliberately
 * left intact, so a repeating item keeps its place and its next repetition's
 * transport resolution reads the freshly-adopted values.
 *
 * Empty/whitespace profile and config ids collapse to `undefined` so the item
 * mirrors the queue default exactly (no stale override left behind).
 */
export function applyQueueDefaultTransportToItem<T extends QueueTransportTarget>(
    item: T,
    defaults: QueueTransportDefaults,
): T {
    item.transport = defaults.transport === 'anthropic' ? 'anthropic' : 'copilot';
    item.anthropicProfileId = defaults.anthropicProfileId?.trim() ? defaults.anthropicProfileId : undefined;
    item.anthropicConfigId = defaults.anthropicConfigId?.trim() ? defaults.anthropicConfigId : undefined;
    return item;
}
