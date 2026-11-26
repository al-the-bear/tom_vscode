/**
 * Prompt Queue Manager (§3.2)
 *
 * Manages an ordered queue of prompts sent through the Anthropic handler.
 * Supports auto-send on answer detection, manual reordering,
 * and integration with the Timer system.
 */

import { canUpdateRunningPrompt, sendUpdateToRunningPrompt } from '../services/agentSdkLiveInputs';
import { DEFAULT_RUN, normalizeRun } from '../utils/processRuns';
import { BUILTIN_RUN_QUEUE_SETTINGS, DEFAULT_RUN_ROLE, DEFAULT_SETTING_FIELDS, RUNS_BY_QUEST_KEY, defaultSettingsDiff, questRunsInFile, readQuestRunQueueSettings, runQueueSettingsToKeys, startWithDefaultsFrom, type RunQueueSettings } from '../utils/runQueueSettings';
import { runQueueSession, runSessionName, sessionBaseName } from '../utils/runSessions';
import { itemRun, laneConflict, laneOf, laneSummaries, pickLaneStarts, type LaneSummary, type LaneTarget } from '../utils/queueLanes';
import { runQueueRemovalPlan, type RunQueueRemovalMode } from '../utils/runQueueRemoval';
import { resolveItemTemplate, isRunDefaultChoice, RUN_DEFAULT_TEMPLATE } from '../utils/runDefaultChoice';
import { applyRunDefaultsToItem, runDefaultFieldsOf, type RunDefaultField, type RunDefaultsApplyResult, type RunDefaultsMode } from '../utils/queueRunDefaultsApply';
import * as vscode from 'vscode';
import { normalizeAspectChoices } from '../utils/aspectChoices';
import { renameInChoices, type AspectRename } from '../utils/aspectRename';
import { inheritedProcessRun, parseProcessRun, runInProcessPosition, type ProcessRun } from '../services/processRunContext';
import { livePromptRole, runWithQueueRole } from '../services/queueRoleContext';
import { RoleOverrides, queueItemRoleView, rolesShownInChatVariable, type QueueItemRoleView, type QueueRoleSource } from '../utils/promptRole';
import { markerInsertIndex, markerVerdict, openMarkerIds, stepRunProgress, type ProcessMoveSpec, type StepRunProgress } from '../utils/processMoveMarker';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { expandTemplate } from '../handlers/promptTemplate';
import { loadSendToChatConfig } from '../handlers/handler_shared';
import {
    readAllEntries,
    writeEntry,
    deleteEntry,
    generateEntryFileName,
    entryIdFromFileName,
    startWatching as startQueueWatching,
    stopWatching as stopQueueWatching,
    onQueueChanged,
    onInboxChanged,
    getQueueFolder,
    trimSentEntries,
    countEntryFiles,
    readQueueSettings,
    writeQueueSettings,
    type QueueEntryFile,
    type QueueFileYaml,
    type QueuePromptYaml,
} from '../storage/queueFileStorage';
import { appendSentRecord, pruneSentTexts, referencedSentTexts, sentRecordsFromYaml, sentRecordsToYaml, sentStageLabel, withComposedTexts, type SentPromptRecord } from '../utils/sentPrompts';
import { debugLog } from '../utils/debugLogger';
import { logQueue, logQueueError, promptPreview } from '../utils/queueLogger';
import { describeQueueSendTarget } from '../utils/queueSendTarget';
import { applyQueueDefaultTransportToItem, collectWalkTodos, applyRepeatEditToItem, applyRepetitionAffixes, buildNextTemplateIterationParams, computeRemovalEffect, computeRepeatEditability, convertStagedToPending, decideAdvanceAfterCompletion, emptyTodoIterationReason, isEmptyTodoIterationError, parseTodoWalk, pickNextTodoForIteration, planMainStageDispatch, todoPrefixPatternError, walkableRepeatIds, releaseResolvedDecisionItems, releaseUnblockedTodos, blockHoldingWalk, resolveResendText, resolveTodoPrefixRepeatCount, shouldAutoPauseOnEmpty, type TodoIterationSource, type TodoUnblockPort } from '../utils/queueStep3Utils';
import { todoForStage, todoYamlBlock, withTodoYaml, type IterationStage } from '../utils/todoIterationRecord';
import { runMainStageWithRefresh } from '../utils/questRefreshDispatch.js';
import { applyCrashRecovery } from '../utils/queueCrashRecoveryUtils';
import { mergeQueueReload } from '../utils/queueReloadMergeUtils';
import { applyErrorTransition, applyInterruptForContinuation, applyResetToPending, applyWaitingTransition, clearWaitingState, dispatchWasSuperseded, isWaitingDue, itemHasInFlightProgress, pickInterruptedResume, resolveAnswerContainer } from '../utils/queueErrorTransitions';
import { canSendNow, pausesBeforeNextDispatch, resetItemRunState } from '../utils/queueSendNow';
import { addStageUsage, type ItemSendUsage } from '../utils/usageCost';
import type { LiveTrailTokenCounts } from '../services/live-trail';
import { applyBudgetFallback, decideOutOfBudget, isOutOfBudgetFailure, outOfBudgetPrompt, type BudgetFallback, type OutOfBudgetMark } from '../utils/outOfBudget';
import { applyRetryScheduling, applyStopRetrying, clearRetryBookkeeping, computeRetryDecision, fireRetry, isPreviousMessageIdError, isRetryDue, isUnretryableRequestError, rollbackInFlightRepetition, type InFlightRepetition } from '../utils/queueRetryTransitions';
import { parseResetClause } from '../utils/queueResetClause';
import { apiRateLimitClause, readRetryNotBefore } from '../utils/rateLimitHeaders';
import type { RetryWait } from '../utils/retryBudgetLoop';
import { questTodoUnblockPort } from '../utils/questTodoUnblockPort';
import { todoBlockState } from '../utils/todoBlockState';
import { questStatusIndex } from '../utils/todoBlockingCascade';
import { effectiveBlock, walkBlockView, type ViewTodo, type WalkBlockContext } from '../utils/walkBlockView';
import { todoQuestsRoot } from '../utils/todoBlockingSync';
import { queuedByFrom, queuedByToYaml, type QueuedBy } from '../utils/queuedBy';
import { onDoneDueAtSettle } from '../utils/todoOnDoneRun';
import { runTodoOnDone, takeDeferredTodoOnDone } from '../services/todoOnDoneRunner';
import { recordTodoAnswer, type TodoAnswerPort } from '../utils/todoLastAnswer';
import { itemToSendBetween, isLoopItem, orderForBetween, toggleSendBetween, nextQueuePosition, runningLoopAbove } from '../utils/queueSendBetween';
import { ACTIVE_QUEUE_STATUSES, PARKED_QUEUE_STATUSES, canRelocateQueueItem, laneInsertIndex, queueStatusChoices, type LaneItem, type LanePlace, type ManualQueueStatus } from '../utils/queueStatusChange';
import { orderForYield, yieldTarget, yieldUnavailableReason } from '../utils/queueYield';
import { groupItemMembers, parseGroupSelection, selectionOf, withMemberChoice, withSelectionFlags, type GroupMemberView, type GroupSelection } from '../utils/groupItemSelection';
import { claimTodo, reclaimForResend, releaseTodoClaim, settleGroupClaim, todoClaimFromYaml, todoClaimToYaml, type TodoClaim, type TodoStatusPort } from '../utils/queueTodoClaim';
import { resolveVariables } from '../utils/variableResolver.js';
import { computeHealthCheckDecisions } from '../utils/queueStep4Utils';
import { setWindowSubsystemActive, loadAllWindowStates } from '../handlers/windowStatusPanel-handler';
import { isWindowAlive } from '../utils/windowHeartbeat';
import { onUserWaitsChanged, queueItemsWaitingForUser, runAsQueueItem, type UserWaitKind } from '../services/userWaits';
import { isAskLiveHere, openAskContinuationPrompt, sendOpenAskChatContinuation, openAskRecordToYaml, parseOpenAskRecord, runOpenAskTool, setOpenAskStore, shouldRestoreOpenAsk, type OpenAskRecord, type OpenAskTool } from '../services/openAskRecord';
import { AskUserRegistry } from '../services/askUserRegistry';
import { QUESTION_CLOSED_BY_RESEND, QUESTION_CLOSED_BY_SKIP, QUESTION_CLOSED_BY_STOP, RESEND_INTERRUPTED_NOTE } from '../utils/pendingQuestion';
import { backgroundWaitFromYaml, backgroundWaitToYaml, validLimit, type BackgroundWaitControl, type BackgroundWaitState } from '../utils/backgroundWait';
import { WAIT_RESUME_NOTE, waitForFromYaml, waitForToYaml, type WaitForState } from '../utils/waitFor';
import { runStatusBarText } from '../utils/queueRunStatus';
import { BACKGROUND_WORK_HOLD, heldForLine, heldResultResendLine, prefixHeldConversation, SoftInterruptRegistry, softInterruptFromYaml, softInterruptToYaml, type SoftInterruptState } from '../services/softInterrupt';
import { WaitForRegistry } from '../services/waitForRegistry';
import { keptAnswer, lastOpenWaitMessage, waitMessageProblem, waitMessagesFromYaml, waitMessagesToYaml, withWaitMessage, type ItemWaitMessage } from '../utils/itemWaitMessages';
import { appendQuestionLogEntry } from '../services/qaJournal';
import { completionVerdict, continuationPrompt, needsAttentionReason, validContinuations, type WalkedTodo } from '../utils/walkCompletionCheck';
import { recordRepetitionAnswer, repetitionAnswersFromYaml, type RepetitionAnswer } from '../utils/repetitionAnswers';
import { todoIdPatternOf } from '../utils/todoQueueMarks';
import { deriveQueueItemKind, parseQueueItemKind, type QueueItemKind } from '../utils/queueItemKind';
import { queuedItemForTodoPattern, TodoAlreadyQueuedError } from '../utils/todoQueueDuplicates';
import { queueItemKindFromYaml } from '../utils/timedQueueItems';
import { queueMoveTarget } from '../utils/queueMove';
import { CHAT_SENT_STATUS, CHAT_STATUS, appendChatItemNote, finishChatItem, isChatStatus, newChatItem, settleRunningChatItems, type ChatQueueItem } from '../utils/chatQueueItems';
import { sessionHolderOf, type SessionBusyItem, type SessionHolder } from '../utils/sessionBusy';
import { abandonChatSend, isChatSendActive } from '../handlers/chatQueueTracking';
import { WsPaths } from '../utils/workspacePaths';
import { normalizeResponseValues, splitResponseValues } from '../utils/answerResponseValues';
import { extractResponseValuesFromText } from '../utils/responseValues';
import { fillTemplate, userMessageTemplateBody } from '../utils/userMessageTemplateLookup';
import { directApiKeyEnvVar, isMissingApiKeyFailure, missingApiKeyFailureText, missingDirectApiKey, missingApiKeyMessage, stageKeyRefusal } from '../utils/anthropicApiKeyCheck';
import type { ChangeSource } from './chatVariablesStore';
import { createSession, deleteSession, ensureSession, readSession } from '../services/agentSdkSessionStore';
import { sessionTransportMismatch } from '../services/directSessionHistory';
import { removeSessionStorage } from '../services/sessionStorage';
import {
    applyPlanToItem,
    deletesTemporarySession,
    doneNotificationMetaFromYaml,
    doneNotificationMetaToYaml,
    planDoneNotification,
    type DoneNotificationItem,
    type DoneNotificationPosted,
    type ItemOutcome,
} from '../utils/doneNotification';
import {
    claimInboxFile,
    listInboxFiles,
    listStaleClaims,
    parseInboxItem,
    planInboxConversion,
    rejectClaimedFile,
    type InboxItem,
    type InboxSender,
} from '../utils/questInbox';
import { getWorkspaceName } from '../utils/panelYamlStore';
import * as os from 'os';
import { lookupProfile, parseSessionSpec, specExtras, type ProfileSection, type SessionSpec } from '../utils/sessionSpecs';
import { pickAnthropicProfile } from '../utils/anthropicApiKeyCheck';
import { ensureRunId, iterationKeyFor } from '../utils/queueIterations';
import { emitNotifications } from '../services/notificationLog';
import { queueItemDraft } from '../utils/notificationDrafts';
import { DEFAULT_RUN_SESSION, canonicalSessionName, isRunDefaultSession } from '../utils/runSessions';
import { emitRunPaused, emitRunResumed, type HoldingItem } from '../services/userNotificationEmitter';
import { hasUnresolvedDecisions, normaliseTodoDecisions } from '../utils/todoDecisions';

// ============================================================================
// Types
// ============================================================================

/**
 * `'decision-needed'` is the todo-iteration block: the todo the `prefix*` walk
 * of this item would take next has questions the user has not answered, so the
 * item is held rather than run on a guess (a decision further down the series
 * holds nothing until the walk reaches it). Restarting the queue puts it back to
 * `'pending'` once that todo's decisions are answered (see
 * `releaseResolvedDecisionItems`); while the decisions are still open the item
 * stays held and the rest of the queue runs past it.
 *
 * `'todo-blocked'` is the same hold for a blocked todo: the todo the item is
 * about — the one its walk would take next, or the one a plain item names in
 * `todoIdPattern` — waits for a todo that is not completed (`blockedOn` says
 * which). Blockers completed in the meantime never hold it: the todo is
 * released and runs. The item goes back to `'pending'` once its todo is no
 * longer blocked.
 *
 * `'interrupted'` is interrupt-for-continuation: the in-flight dispatch was
 * cancelled on purpose (the network is about to go away) and the item is
 * held at that exact rep with auto-send off. Re-arming auto-send replays the
 * rep — same expanded text — before anything else moves. See
 * `interruptActiveItemForContinuation` / `pickInterruptedResume`.
 */
export type QueuedPromptStatus = 'staged' | 'pending' | 'sending' | 'sent' | 'error' | 'waiting' | 'retry' | 'decision-needed' | 'todo-blocked' | 'interrupted' | 'chat' | 'chat-sent';
export type QueuedPromptType = 'normal' | 'timed';

/** The error a held process-move marker shows. */
export const PROCESS_MARKER_HELD_ERROR = 'held: an item of this process step failed — repeat the step or move on (PROCESS view, Proceed)';

/** A process-move marker's move as stored in the queue file; undefined when it is not one. */
export function parseProcessMove(raw: unknown): ProcessMoveSpec | undefined {
    if (typeof raw !== 'object' || raw === null) { return undefined; }
    const r = raw as Record<string, unknown>;
    if (typeof r.kind !== 'string' || typeof r.label !== 'string' || typeof r.to !== 'string') { return undefined; }
    const level = r.level === 'phase' || r.level === 'step' || r.level === 'substep' ? r.level : undefined;
    return { kind: r.kind as ProcessMoveSpec['kind'], ...(level ? { level } : {}), label: r.label, to: r.to };
}

/**
 * Outcome of one `dispatchNextStageForSendingItem` invocation. Drives
 * the two branches every caller has to differentiate:
 *
 *   - `'done'`       — all stages + all repetitions are complete.
 *     Callers mark the item `'sent'` and advance the queue.
 *   - `'paused'`     — no further repetition starts, for one of two
 *     reasons. (a) Auto-send is OFF and this item has at least one
 *     prior dispatch on record: the in-flight repetition (if any)
 *     finishes naturally and callers MUST leave the item in
 *     `'sending'` so the webview can render "SENDING (PAUSED)" and
 *     `set autoSendEnabled(true)` knows where to resume. (b) The
 *     todo the item's `prefix*` walk would take next is an unanswered
 *     `decision-needed` todo: the gate has already moved the item to `'decision-needed'`
 *     and switched auto-send off before returning. (c) The frame must not
 *     dispatch at all (vscimpb53): its item is no longer `sending` (sent,
 *     removed, error), or another dispatch frame took the item over — the
 *     frame stands down, and leaving the item alone is what its caller does.
 *
 * Both reasons share one outcome deliberately. Every caller of this
 * method reacts to `'paused'` by logging and leaving the item alone,
 * which is exactly right for both; a distinct fourth value would have
 * to be handled at each of them, and a missed one marks the item
 * `'sent'` — silently completing a queue item that never ran.
 */
export type DispatchOutcome = 'done' | 'paused';

/** Appended to the answer of a stage the user moved past with Continue while its turn still ran. */
export const CONTINUE_ANSWER_MARK = '\n\n_(Ended by Continue: the turn was still running; this is its last text.)_';

/**
 * Snapshot of the last prompt dispatched on a queue item — pre-prompt,
 * main, or follow-up. Written **right before** every `dispatchStage` call
 * so the Resend button can re-send the exact same expanded text without
 * touching repetition counters. See multi_transport_prompt_queue_revised.md.
 */
export interface LastDispatchedInfo {
    kind: 'prePrompt' | 'main' | 'followUp';
    /** Index into `item.prePrompts` when kind === 'prePrompt'. */
    prePromptIndex?: number;
    /** Index into `item.followUps` when kind === 'followUp'. */
    followUpIndex?: number;
    /** Byte-identical expanded text — what `dispatchStage` was called with. */
    expandedText: string;
    transport: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /** The queue iteration it belonged to (src/utils/queueIterations.ts), so a resend runs in it again. */
    iterationKey?: string;
    /** ISO timestamp of the last dispatch. Updated on each resend. */
    dispatchedAt: string;
}

/** Classified interruption kinds — mirrors `anthropicErrorClassifier.InterruptionKind`. */
export type QueueWarningKind = 'rate_limit' | 'quota_exceeded' | 'overloaded' | 'cancelled' | 'interrupted';

/**
 * Yellow interruption banner on a queue item. Recorded when a dispatch
 * throws with a classified cause so the webview can render a chip and
 * the user can decide whether to resend.
 */
export interface QueueItemWarning {
    kind: QueueWarningKind;
    message: string;
    at: string;
}

/**
 * The backend a queued prompt goes through: the Anthropic handler
 * (`AnthropicHandler.sendMessage`), which forks into Direct / Agent SDK /
 * VS Code LM / Local LLM by the profile's configuration.
 */
export type QueuedTransport = 'anthropic';

/** A stored `transport` value as read: `anthropic`; undefined for none. */
export function readStoredTransport(value: unknown): QueuedTransport | undefined {
    return value === 'anthropic' ? 'anthropic' : undefined;
}

export interface QueuedFollowUpPrompt {
    id: string;
    originalText: string;
    template?: string;
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;         // How many times this follow-up has been sent (0-based counter)
    createdAt: string;
    // Multi-transport fields (design doc §4.1).
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;   // may reference an Anthropic config OR a Local LLM config
    answerText?: string;          // captured text from a direct (anthropic) send
}

export interface QueuedPrePrompt {
    text: string;
    template?: string;
    status: 'pending' | 'sent' | 'error';
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;         // How many times this pre-prompt has been sent (0-based counter)
    // Multi-transport fields (design doc §4.1).
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    answerText?: string;
}

/** A retry wait inside one send on the direct, Local LLM or VS Code LM transport (`QueuedPrompt.sendWait`). */
export interface QueueSendWait {
    /** `rate_limit`: the server said when to retry (`retry-after`, reset headers); `backoff`: overload / 5xx backoff. */
    kind: 'rate_limit' | 'backoff';
    /** ISO instant the next attempt goes out. */
    until: string;
    /** That attempt's number (2 = the first retry). */
    attempt: number;
}

export interface QueuedPrompt {
    id: string;
    template: string;             // Template name or "(None)"
    originalText: string;         // User's raw prompt
    expandedText: string;         // After template processing
    status: QueuedPromptStatus;
    type: QueuedPromptType;
    /**
     * On an item a timed request queued (`type: 'timed'`): the id of that
     * timed request. How the timer engine finds its own items (one in flight
     * per entry, removed with the entry); `template` is the entry's template.
     */
    timedEntryId?: string;
    /** A chat send shown in the queue (status `chat` / `chat-sent`): where it came from. */
    chatSource?: string;
    /**
     * Queued with a queue button of the @CHAT panel (Save to Queue, Queue next): the subpanel (`anthropic`).
     * The queue editor's "From the chat panel" filter shows these and the chat sends.
     */
    fromChatPanel?: string;
    /** A chat send shown in the queue: the window that ran it (src/utils/chatQueueItems.ts). */
    chatWindowId?: string;
    createdAt: string;            // ISO timestamp
    sentAt?: string;              // When actually sent
    error?: string;
    prePrompts?: QueuedPrePrompt[];  // Pre-prompts sent before the main prompt
    followUps?: QueuedFollowUpPrompt[];
    followUpIndex?: number;       // Number of follow-ups already sent
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;
    /**
     * TODO ITERATION only (`prefix*` repeat count): the id of the quest todo
     * the last main-prompt dispatch picked up. Persisted so the queue entry
     * can name it after a reload; the title is re-derived at pick time.
     */
    repeatTodoId?: string;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string; // Repeat the entire template this many times
    templateRepeatIndex?: number;  // Current template repeat iteration (0-based)
    /**
     * The longest a turn of this item waits for its own background work
     * before it ends with a hint naming what still runs; wins over the
     * profile's (utils/backgroundWait.ts). Unset: the profile's, else 6 h; 0: no wait.
     */
    backgroundWaitLimitMinutes?: number;
    /**
     * While a turn of the sending item waits for its background work: what it
     * waits for, since when and the limit. Persisted, so a reload shows it;
     * cleared when the wait ends.
     */
    backgroundWait?: BackgroundWaitState;
    /** The latest main answer's turn ended with background work still running (its answer carries the hint): shown red. */
    answerBackgroundLeft?: true;
    /**
     * While a turn of the sending item waits in `tomAi_waitFor` (utils/waitFor.ts):
     * the reason, since when and until when. Persisted, so the editor shows it after a
     * merge reload; cleared when the wait ends and by crash recovery.
     */
    waitingFor?: WaitForState;
    /**
     * The messages the user wrote to the item's waiting turn from the item (vscimpb173;
     * utils/itemWaitMessages.ts), with the agent's answer where known and whether the wait went on.
     * Persisted as `wait-messages`.
     */
    waitMessages?: ItemWaitMessage[];
    /**
     * Interrupt for continuation, soft (vscimpb112; services/softInterrupt.ts):
     * while the item is `sending`, the request and — once a hold point has it —
     * the held tool result; on an `interrupted` item, what the lost or
     * hard-interrupted turn held, for the resend. Persisted.
     */
    softInterrupt?: SoftInterruptState;
    /** The conversation the item's current turn runs in (the Agent SDK session id, captured at its first message). */
    turnSessionId?: string;
    /**
     * The item was hard-interrupted or its turn was lost (vscimpb112): its
     * resend starts with RESEND_INTERRUPTED_NOTE (plus a held result the agent
     * never saw) and continues the conversation `turnSessionId` names.
     */
    interruptNote?: true;
    /**
     * Direct API / Local LLM: the file holding the conversation a soft
     * interrupt held, so the turn continues from it after a restart.
     */
    heldConversationFile?: string;
    /**
     * The user interrupted the item's wait and moved on: the item stepped back to
     * pending (or staged) and, when it runs again, sends its last stage again with
     * WAIT_RESUME_NOTE instead of starting afresh.
     */
    resumeAfterWait?: boolean;
    /** Continuations a walk iteration of this item gets while its todo is not completed; unset: the queue's (default 2). */
    walkContinuations?: number;
    /**
     * Why the item stopped as needs attention: a walk iteration whose todo was
     * still not completed after its continuations. Auto-send was switched off;
     * cleared when the item sends its next main prompt.
     */
    needsAttention?: string;
    /** While the item is `todo-blocked`: the todo it is held at and what that waits for. Persisted as `blocked-on`. */
    blockedOn?: string;
    /** While the item is `todo-blocked`: the id of the todo it is held at. Persisted as `blocked-todo`. */
    blockedTodo?: string;
    /**
     * The item's hold (`todo-blocked` or `decision-needed`) switched its run's auto-send off: once the hold is
     * over (the blocker completed, the decisions answered), the queue switches it on again by itself, unless the
     * run's `autoResumeHeld` is off or the run's auto-send was set since (by the user or a tool). Persisted as
     * `hold-paused-run`.
     */
    holdPausedRun?: boolean;
    /** Todos the user skipped on this held item (Continue): its walk passes them. Persisted as `skipped-todos`. */
    skippedTodos?: string[];
    /** Todos the user runs anyway on this held item: their blockers do not hold. Persisted as `ignore-block-todos`. */
    ignoreBlockTodos?: string[];
    /**
     * "Pause after this": when set, the queue stops once this item has
     * finished its **last** stage / repetition — the item itself always runs
     * to completion. Sticky, not one-shot: it stays on the item, so sending
     * it again pauses the queue again, which is what the flag says on the tin.
     */
    pauseAfter?: boolean;
    /**
     * "Send between iterations" (src/utils/queueSendBetween.ts): this pending
     * item, directly under a running loop, is sent after the loop's current
     * iteration and before its next one. At most one item carries it.
     */
    sendBetween?: boolean;
    /**
     * "Let the next item go first" (src/utils/queueYield.ts): this sending
     * iteration item steps back after its running iteration and moves behind
     * the next pending item of its lane; the walk resumes after that item.
     */
    yieldAfterIteration?: boolean;
    // The transport (always `anthropic`) and the profile / configuration it runs with.
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    /**
     * The named session the item's stages run in (a `<name>.session.json`
     * of the quest's history folder; see src/utils/agentSdkSessions.ts): the
     * Agent SDK conversation it continues, or the direct transport's history
     * (src/services/directSessionHistory.ts). Unset: the queue default, else
     * the queue's own `default` session.
     */
    session?: string;
    /**
     * The role the item's stages run as (a folder of `_ai/roles/`; gsel3):
     * after its todo's role, before the process step's, the run's default and
     * the chat variable (utils/promptRole.ts). Unset: none of its own.
     */
    role?: string;
    /**
     * The item's guideline choices (gsel4): aspect section → option or
     * `remove`; the item level, under its todo's (utils/aspectGuidelines.ts).
     */
    guidelines?: Record<string, string | string[]>;
    /**
     * How to create `session` when it is missing at dispatch (the item's
     * session was given as a spec `{name, basedOn, mode, profile}`); absent
     * for a bare name, which creates a fresh `continue` session.
     */
    sessionCreate?: Omit<SessionSpec, 'name'>;
    /** This run of the item and the main prompts it sent (src/utils/queueIterations.ts). */
    runId?: string;
    iterationSeq?: number;
    /**
     * The process position this item's prompt belongs to (a Proceed prompt,
     * or what a running Proceed prompt queued): while it is sent, the role and
     * the *Current process* section are those of this position, wherever the
     * quest has moved since (src/services/processRunContext.ts).
     */
    processRun?: ProcessRun;
    /**
     * The process run of the quest the item belongs to (vscimpb45;
     * src/utils/processRuns.ts): its Proceed's run, else the run of the
     * Proceed prompt it was queued from, else the one named when it was
     * added, else the window's run then — `default` for the quest's own
     * position. Chat sends carry none (they are outside the runs).
     */
    run?: string;
    /**
     * Set on a process-move marker (src/utils/processMoveMarker.ts): the item
     * is never sent to a model; when the queue reaches it and every earlier
     * item of its Proceed run is sent, it moves the process (`processRun` is
     * the position it moves from).
     */
    processMove?: ProcessMoveSpec;
    /**
     * A process item (vscimpb97): the work of a process step — the prompt
     * Proceed queues for a position, its process-move marker, and what the
     * step's agent queues with `processItem: true`. Its stages do not count
     * towards the quest refresh and do not trigger a due one.
     */
    processItem?: boolean;
    /**
     * The Status Page's *Send prompt after reload* (vscimpb109): queued at the
     * front of the window's run when the window starts, by the window named
     * here, and sent as Continue does. The queue editor badges it.
     */
    reloadPrompt?: { windowId: string };
    answerText?: string;
    /**
     * Snapshot of the last prompt actually dispatched for this item —
     * stamped right before each `dispatchStage` call. Consumed by
     * `resendLastPrompt()` to re-send without touching repetition counters.
     */
    lastDispatched?: LastDispatchedInfo;
    /**
     * Every stage this item sent, oldest first: its label, when, and the user
     * message and system prompt as sent (references into the queue folder's
     * `sent-prompts/`; utils/sentPrompts.ts). The Recent Prompts panel's *As
     * sent* view.
     */
    sentPrompts?: SentPromptRecord[];
    /**
     * Classified interruption warning (rate-limit / quota / overload /
     * cancelled / mid-stream interrupted). Renders as a yellow chip in
     * the queue editor; cleared on the next successful dispatch or on
     * resend.
     */
    warning?: QueueItemWarning;
    /**
     * A stage stopped because the API credit balance is too low: which
     * profile, in which session. The queue editor offers "Continue on
     * profile" and "Resend"; cleared when either starts (src/utils/outOfBudget.ts).
     */
    outOfBudget?: OutOfBudgetMark;
    /**
     * The item continues on another profile after running out of credit:
     * every later stage that would run on `fromProfileId` runs on
     * `toProfileId` instead (and in `session` when the original one cannot
     * take that profile).
     */
    budgetFallback?: BudgetFallback;
    /**
     * When `status === 'waiting'`: the ISO instant at which the item
     * should auto-retry. Set to the reset time parsed from a
     * "resets <time> (<tz>)" rate-limit error **plus a 5-minute buffer**
     * (see `RESET_RETRY_BUFFER_MS`). The health-check timer flips the
     * item back to `pending` and drives `sendNext()` once this instant
     * is reached, so the retry survives a window reload.
     */
    waitingUntil?: string;
    /**
     * Human-friendly reset time shown in the "Waiting for <date/time>"
     * header — rendered in the source timezone of the error clause,
     * e.g. "Sun, Jul 20, 11:00 AM". This is the reset time *stated in
     * the message*, not the +5-minute retry instant.
     */
    waitingResetLabel?: string;
    /**
     * When `status === 'retry'`: number of retries already consumed in the
     * current failure cascade (0-based index into `RETRY_BACKOFF_MS`). Set by
     * `applyRetryScheduling`, preserved by `fireRetry` so a fired retry that
     * fails again continues the backoff instead of restarting at 30s, and
     * cleared on the next successful dispatch so a later repetition starts a
     * fresh cascade.
     */
    /**
     * While `sending` on the direct transport: the wait the retry loop is in
     * (a rate limit waited out until the stated reset, or a backoff after an
     * overload / 5xx), so the queue shows why the item is not answering. Set
     * and cleared by the dispatch; never meaningful outside `sending`.
     */
    sendWait?: QueueSendWait;
    /**
     * The token usage the item's direct-transport stages reported in its
     * current run (pre-prompts, main prompt, repetitions, follow-ups), summed;
     * the queue editor shows it on the item. Reset when the item starts again.
     */
    sendUsage?: ItemSendUsage;
    retryAttempt?: number;
    /**
     * When `status === 'retry'`: the ISO instant at which the next retry
     * should fire. The health-check timer flips the item back to `pending`
     * and drives `sendNext()` once this instant is reached, so the retry
     * survives a window reload (mirrors `waitingUntil`).
     */
    retryUntil?: string;
    /**
     * True while a dispatched prompt is genuinely in flight — set at each
     * dispatch and cleared the moment the queue stops actively processing this
     * item (pause gate, completion, or error). Drives the webview's green→amber
     * header: a `sending` item stays green while `awaitingAnswer`, and turns
     * amber once it is idle/paused between iterations — so a stopped queue shows
     * at a glance whether the current iteration is still running or already
     * done. Transient runtime state (not persisted); the resume path re-derives
     * it on reload by re-entering the dispatch path.
     */
    awaitingAnswer?: boolean;
    /**
     * Snapshot of the single repetition-counter advance the in-flight dispatch
     * made, so a failed send can be rolled back to re-send the *same* prompt
     * (see `rollbackInFlightRepetition`). The dispatcher advances a stage's
     * counter optimistically before the send resolves; on a genuine failure the
     * item is parked in `retry`/`waiting` and later re-dispatched — without this
     * rollback the re-dispatch would skip to the next repetition, so a retry
     * cascade would walk the loop index forward instead of retrying the failure.
     * Transient runtime state (not persisted); cleared at the top of every
     * dispatch attempt and consumed on rollback.
     */
    inFlightRepetition?: InFlightRepetition;
    /**
     * TODO ITERATION: the runner's claim on the quest todo its current main
     * dispatch works on — the `in-progress` it wrote and the status that write
     * overwrote. Settled (dropped) once the dispatch concludes; released
     * (prior status restored, only if the todo still holds the runner's write)
     * when the run stops, is interrupted or errors before the answer arrives.
     * Persisted, so a reload in between does not lose what is owed. See
     * `utils/queueTodoClaim.ts`.
     */
    todoClaim?: TodoClaim;
    /**
     * The todos this item runs: a todo's id when one todo was queued,
     * `<prefix>*` for a todo-group walk (taken from a `<prefix>*` repeat count
     * when not given), several separated by commas. The todo panel marks those
     * todos as queued while the item has not finished (utils/todoQueueMarks.ts).
     */
    todoIdPattern?: string;
    /**
     * What the item holds (utils/queueItemKind.ts, vscimpb127): todo, group,
     * prefix, iteration, chat or prompt. Persisted as `item-kind`, derived for
     * an item written before it, and written from the item's fields on every
     * save, so it follows an edit of the repeat count.
     */
    itemKind?: QueueItemKind;
    /**
     * A GROUP item's selection of its members (utils/groupItemSelection.ts,
     * vscimpb129): the members checked and unchecked by hand; a member without
     * a choice follows the walk's rules. The walk sends exactly the checked
     * members, in order. Persisted as `group-selection`.
     */
    groupSelection?: GroupSelection;
    /**
     * The ask tool call the item's turn waits in (tomAi_askUser,
     * tomAi_askUserPicker, tomAi_askInMdBrowser): recorded while it is open and
     * persisted as `open-ask`, so a window reload shows it again and its answer
     * continues the item (services/openAskRecord.ts, vscimpb166).
     */
    openAsk?: OpenAskRecord;
    /**
     * The todos the item's walk claimed and sent, in order (the walk's own
     * record, beside the repetition answers, which an empty answer does not
     * extend). Persisted as `walked-todos`.
     */
    walkedTodos?: string[];
    /**
     * A repeated item's main-prompt answer per repetition (the walked todo's
     * id, or the repetition number), shown as chips under the Answer in the
     * queue editor (utils/repetitionAnswers.ts). `answerText` is the latest.
     */
    repetitionAnswers?: RepetitionAnswer[];
    /**
     * Queued right after this item when it is finished — done, or ended in an
     * error that will not recover (src/utils/doneNotification.ts).
     * `${itemOutcome}` in it reads `done` / `error: <message>`; `${itemAnswer}`,
     * `${itemTitle}` and `${itemTodos}` what came out (vscimpb72).
     */
    doneNotificationPrompt?: string;
    /** The done-notification prompt is kept but not queued. */
    doneNotificationDisabled?: boolean;
    /**
     * Who queued the item (utils/queuedBy.ts): the calling agent's quest, run and session, or the run and session
     * the user chose in the todo panel. A todo it completes sends its done notification (on_done `notify`) there.
     */
    queuedBy?: QueuedBy;
    /** The send-run the done-notification was queued for (not again for the same send-run). */
    doneNotificationQueuedFor?: string;
    /** The quest the done-notification is posted to (through its inbox); unset: this item's own. */
    doneNotificationQuest?: string;
    /** The process run the done-notification is queued in; unset: the item's run here, `default` in another quest. */
    doneNotificationRun?: string;
    /** Where a done-notification for another quest was posted, and whether it waits there for a window. */
    doneNotificationPosted?: DoneNotificationPosted;
    /** On a done-notification item: the id of the item it reports on. */
    notificationOf?: string;
    /** On an item another quest's window sent (tomAi_sendItemToQuest): who sent it. */
    from?: InboxSender;
    /** The item's session is temporary: deleted (file and history) once the item and its notification are done. */
    temporarySession?: boolean;
}

// ============================================================================
// Singleton
// ============================================================================

const MAX_SENT_HISTORY = 50;
const MAX_TOTAL_ITEMS = 100;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
/**
 * Grace period added to a parsed rate-limit reset time before the queue
 * auto-retries a `waiting` item. The reset instant is when the *provider*
 * lifts the limit; retrying a hair earlier just earns another block, so
 * the queue waits 5 minutes past it.
 */
const RESET_RETRY_BUFFER_MS = 5 * 60_000;
/** A missing-API-key notice with the same text is sent at most this often (a run of items on one keyless profile). */
const MISSING_KEY_NOTICE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Resolve a template name to its body: a user-message template of the one
 * store (`anthropic.userMessageTemplates`, by id or name). Exported so
 * preview panels can use the exact same logic.
 */
export function resolveTemplateString(templateName: string): string | undefined {
    if (!templateName || templateName === '(None)') { return undefined; }
    let config: ReturnType<typeof loadSendToChatConfig> | undefined;
    try { config = loadSendToChatConfig(); } catch { config = undefined; }
    return userMessageTemplateBody(config, templateName);
}

/** Apply template wrapping to expanded text, expanding the placeholders the
 *  template introduces. Exported so preview panels can use the exact same logic.
 */
export async function applyTemplateWrapping(expanded: string, templateName: string): Promise<string> {
    const body = resolveTemplateString(templateName);
    if (body !== undefined) {
        expanded = await expandTemplate(fillTemplate(body, expanded), { includeEditorContext: false });
    }
    return expanded;
}

/**
 * Resolve a repeat count value. If it's a number, return it directly.
 * If it's a string, try to get the value from a chat variable with that name.
 * Returns 1 if the value cannot be determined.
 */
/**
 * Refuse a repeat count no queue item may carry: a `prefix*` todo pattern whose
 * prefix ends in a digit (todoPrefixPatternError). Thrown where the value is
 * set, so the item is never queued; callers show the message.
 */
export function assertValidRepeatCount(value: unknown): void {
    const error = todoPrefixPatternError(value);
    if (error) { throw new Error(error); }
}

export function resolveRepeatCount(value: number | string | undefined): number {
    if (value === undefined || value === null) {
        return 1;
    }
    if (typeof value === 'number') {
        return Math.max(1, Math.round(value));
    }
    // String value - try to parse as number first
    const parsed = parseInt(String(value), 10);
    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }
    // Try to get from chat variable
    const varName = String(value).trim();
    if (!varName) {
        return 1;
    }
    try {
        const chatStore = await_import_ChatVariablesStore() as any;
        if (chatStore && typeof chatStore.getRaw === 'function') {
            // Try both with and without 'custom.' prefix
            let varValue = chatStore.getRaw(`custom.${varName}`);
            if (varValue === undefined || varValue === '' || varValue === null) {
                varValue = chatStore.getRaw(varName);
            }
            if (varValue !== undefined && varValue !== '' && varValue !== null) {
                const resolved = parseInt(String(varValue), 10);
                if (!isNaN(resolved) && resolved > 0) {
                    debugLog(`[PromptQueueManager] Resolved repeat count '${varName}' = ${resolved}`, 'DEBUG', 'queue');
                    return resolved;
                }
            }
        }
    } catch (e) {
        debugLog(`[PromptQueueManager] Failed to resolve repeat count variable '${varName}': ${e}`, 'WARN', 'queue');
    }
    debugLog(`[PromptQueueManager] Could not resolve repeat count '${varName}', defaulting to 1`, 'DEBUG', 'queue');
    return 1;
}

export class PromptQueueManager {
    private static _inst: PromptQueueManager | undefined;

    private _items: QueuedPrompt[] = [];
    /** Items run again with Send Now whose current run must not queue their next template iteration again. */
    private readonly _repeatRuns = new Set<string>();
    // Last 'queue' window-status active state written, to skip redundant
    // writes in _refreshQueueWindowStatus(). undefined = never written yet.
    private _lastQueueActiveWritten?: boolean;
    private _autoSendDelayMs = 2000;
    /**
     * The queue settings of each process run (vscimpb60a, utils/runQueueSettings.ts):
     * auto-send, Auto-Start / -Pause / -Continue, the walk continuations, the
     * defaults new items take (profile, configuration, session, prompt
     * template).
     * `default` always; another run once a setting of it was set. A run with
     * none of its own reads {@link _runStart}.
     */
    private _runSettings = new Map<string, RunQueueSettings>([[DEFAULT_RUN, { ...BUILTIN_RUN_QUEUE_SETTINGS }]]);
    /** The start values of a run without settings of its own: the settings file's top-level keys over the built-in ones (Make default writes them). */
    private _runStart: RunQueueSettings = { ...BUILTIN_RUN_QUEUE_SETTINGS };
    /** Auto-Continue's start, by run. */
    private _autoContinueTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private _reloadDebounceTimer?: ReturnType<typeof setTimeout>;
    private _healthCheckTimer?: ReturnType<typeof setInterval>;
    private _statusBarItem?: vscode.StatusBarItem;
    private _statusBarChangeDisposable?: vscode.Disposable;

    /**
     * Cancellation source of each in-flight Anthropic dispatch, by the id of
     * the item it runs for (`''` for a dispatch of no item) — with Queue per
     * run several items dispatch at once (src/utils/queueLanes.ts).
     * Created in `dispatchStage` immediately before `sendMessage`,
     * disposed in the matching `finally`. The Stop button in the queue
     * editor triggers `stopActiveItem()`, which cancels this CTS so the
     * Anthropic round loop bails out at its next checkpoint.
     */
    private _activeAnthropicCts = new Map<string, vscode.CancellationTokenSource>();

    /**
     * Monotonic "dispatch epoch" bumped every time an in-flight dispatch
     * is intentionally cancelled via `_cancelActiveDispatch` (i.e. from
     * the user-facing Continue / Stop / set-to-staged actions). A
     * send-owning frame captures this value before awaiting its dispatch
     * and, when the await settles, asks `dispatchWasSuperseded` whether a
     * cancel happened in the meantime — if so the frame becomes a no-op
     * instead of promoting the item to `error` / advancing the queue.
     * See `dispatchWasSuperseded` for the full rationale. Kept per item (a
     * cancel of one lane's item does not stand down another lane's frames)
     * plus one for a cancel of no item in particular, which concerns all:
     * a frame's epoch is their sum. With one item sending at a time this is
     * the single counter it always was.
     */
    private _itemEpochs = new Map<string, number>();
    private _globalEpoch = 0;

    /**
     * The dispatch frame that owns each item (vscimpb53): one frame per item
     * runs its stages — `sendItem`, a resume, a resend, an answer's advance,
     * Continue. A frame takes the item over when it starts; an older frame
     * still running for it (its stage was in flight) stops at its next stage
     * instead of dispatching beside the new one. While an item has an owner,
     * a stage of it is in flight: it is not "paused", whatever auto-send says.
     */
    private _frameOwners = new Map<string, symbol>();
    /** The controls of each sending item's background wait (Wait without limit, Keep waiting, Stop waiting), while its send runs. */
    private readonly _backgroundControls = new Map<string, BackgroundWaitControl>();
    /** The sending items whose wait (tomAi_waitFor) the user interrupted: they step back when their turn ends. */
    private readonly _waitInterrupted = new Set<string>();


    /** Maps QueuedPrompt.id → entry filename on disk. */
    private _fileNameMap = new Map<string, string>();
    /** Disposable for queue file change listener. */
    private _queueChangeDisposable?: vscode.Disposable;
    private _inboxChangeDisposable?: vscode.Disposable;
    /** A take-up of the inbox is running (the watcher and the health check may both call it). */
    private _takingInbox = false;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    /**
     * The chat variable `role` while items whose role comes from their todo,
     * themselves or their run's default send (gsel3; utils/promptRole.ts):
     * held per item id by {@link _holdStageRole}, released when the item stops
     * sending ({@link _syncRoleHolds}, on every queue change).
     */
    private readonly _roleHolds = new RoleOverrides(
        () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                return (require('./chatVariablesStore') as typeof import('./chatVariablesStore')).ChatVariablesStore.instance?.role ?? '';
            } catch { return ''; }
        },
        (role) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                (require('./chatVariablesStore') as typeof import('./chatVariablesStore')).ChatVariablesStore.instance?.set('role', role, 'anthropic');
            } catch { /* no chat variables */ }
        },
    );
    public readonly onDidChange = this._onDidChange.event;

    private readonly _onPromptSent = new vscode.EventEmitter<QueuedPrompt>();
    public readonly onPromptSent = this._onPromptSent.event;

    private readonly _onAnswerReceived = new vscode.EventEmitter<Record<string, unknown> | undefined>();
    public readonly onAnswerReceived = this._onAnswerReceived.event;

    /** The quest the queue resolves todos against, or `undefined` when none is set. */
    private activeQuestId(): string | undefined {
        return await_import_ChatVariablesStore()?.quest;
    }

    /**
     * Why the item's main prompt, a `prefix*` walk (only the main prompt
     * walks), would go over nothing (emptyTodoIterationReason); undefined when
     * it has work or is no walk. An item with pre-prompts is not judged: they
     * run first and may create the todos the walk goes over.
     */
    private emptyIterationReason(item: QueuedPrompt): string | undefined {
        if (item.processMove || (item.prePrompts?.length ?? 0) > 0) { return undefined; }
        if (parseTodoWalk(item.repeatCount) === undefined) { return undefined; }
        const questId = this.activeQuestId();
        return emptyTodoIterationReason(item.repeatCount, questId ? walkEntriesOf(item, questId) : [], questId);
    }

    /** The item is held in `error` because its walk had nothing to walk over. */
    private isEmptyIterationItem(item: QueuedPrompt): boolean {
        return item.status === 'error' && isEmptyTodoIterationError(item.error);
    }

    /** May the item be edited: staged, or held for an empty walk (an edit may give it work). */
    private isEditableItem(item: QueuedPrompt): boolean {
        return this.isEditableStatus(item.status) || this.isEmptyIterationItem(item);
    }

    /**
     * After an edit of an item held for an empty walk: still nothing to walk
     * over → the reason is renewed; work now → the item is staged again.
     */
    private recheckEmptyIteration(item: QueuedPrompt): void {
        if (!this.isEmptyIterationItem(item)) { return; }
        const reason = this.emptyIterationReason(item);
        if (reason) { item.error = reason; return; }
        item.error = undefined;
        item.status = 'staged';
        logQueue(`Item ${item.id}: its walk has work now — error → staged`);
    }

    /**
     * Claim a quest todo for the dispatch that is about to go out: write
     * `in-progress` and record on the item what that write overwrote. Returns
     * `false` when the status could not be written — see
     * {@link writeQuestTodoStatus} for why the caller must then stop.
     */
    private claimQuestTodo(item: QueuedPrompt, todo: { id: string; status?: string }): boolean {
        const questId = this.activeQuestId();
        if (!questId) {
            logQueue(`MP dispatch: no active quest — cannot claim todo '${todo.id}'`);
            return false;
        }
        const claim = claimTodo(QUEST_TODO_STATUS_PORT, questId, todo.id, todo.status);
        if (!claim) { return false; }
        item.todoClaim = claim;
        // What the walk sent, whatever its answer: a checked member of a GROUP item is sent once (vscimpb129).
        if (!item.walkedTodos?.includes(todo.id)) { item.walkedTodos = [...(item.walkedTodos ?? []), todo.id]; }
        return true;
    }

    /**
     * Whether a sending item holds a live claim on the todo (a walk runs it):
     * the todo writer then leaves the todo's `on_done` to that claim's settle.
     */
    holdsTodoClaim(questId: string, todoId: string): boolean {
        return this._items.some((i) => i.status === 'sending' && !!i.todoClaim && !i.todoClaim.released
            && i.todoClaim.questId === questId && i.todoClaim.todoId === todoId);
    }

    /**
     * At a claim's settle: the todo's `on_done` is carried out when its completion was left here or it is
     * completed now; its `notify` goes to whoever queued the item (`queuedBy`).
     */
    private async _settleTodoOnDone(claim: TodoClaim, item: QueuedPrompt): Promise<void> {
        const wasDeferred = takeDeferredTodoOnDone(claim.questId, claim.todoId);
        if (onDoneDueAtSettle(wasDeferred, readQuestTodoStatus(claim.questId, claim.todoId))) {
            this._runTodoOnDone(claim.questId, claim.todoId, item.run, item.queuedBy);
        }
    }

    /**
     * The roles a stage of `item` runs with (gsel3; utils/promptRole.ts): the
     * todo it runs — for a `<prefix>*` walk the todo the stage's record names
     * (src/utils/todoIterationRecord.ts: a pre-prompt the todo its iteration is
     * about to run, the main prompt the claimed one, a follow-up the
     * iteration's); for another item its claimed todo or the one it ran
     * (a TODO item) — the item's own role and its run's default role.
     */
    stageRoleSource(item: QueuedPrompt | undefined, stage: 'prePrompt' | 'main' | 'followUp', todoId?: string): QueueRoleSource | undefined {
        if (!item) { return undefined; }
        const questId = item.todoClaim?.questId ?? this.activeQuestId();
        const isTodoIteration = parseTodoWalk(item.repeatCount) !== undefined;
        const id = todoId ?? (isTodoIteration
            ? todoForStage(stage, {
                isTodoIteration,
                claimedId: item.todoClaim?.todoId ?? item.repeatTodoId,
                nextId: stage === 'prePrompt' && questId ? pickNextTodoForIteration(item.repeatCount, walkEntriesOf(item, questId))?.id : undefined,
                lastId: item.repeatTodoId,
            })
            : (item.todoClaim?.todoId ?? item.repeatTodoId));
        let todoRole: string | undefined;
        let todoGuidelines: Record<string, string | string[]> | undefined;
        if (id && questId) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { findTodoById } = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
                const todo = findTodoById(questId, id);
                todoRole = todo?.role || undefined;
                todoGuidelines = todo?.guidelines && Object.keys(todo.guidelines).length ? { ...todo.guidelines } : undefined;
            } catch { /* no todo store */ }
        }
        const settings = this._settingsOf(itemRun(item));
        const runDefaultRole = settings.defaultRole;
        return {
            ...(todoRole ? { todoRole } : {}),
            ...(item.role ? { itemRole: item.role } : {}),
            ...(runDefaultRole ? { runDefaultRole } : {}),
            ...(todoGuidelines ? { todoGuidelines } : {}),
            ...(item.guidelines && Object.keys(item.guidelines).length ? { itemGuidelines: { ...item.guidelines } } : {}),
            ...(settings.guidelines && Object.keys(settings.guidelines).length ? { runGuidelines: { ...settings.guidelines } } : {}),
            // The prompt facts aspect conditions read (gsel20).
            kind: id ? 'todo' : item.type === 'timed' ? 'timed' : item.processRun && !item.processItem ? 'proceed' : 'queue',
            ...(id ? { todoId: id } : {}),
            run: itemRun(item),
        };
    }

    /**
     * The role chip of `item` in the Prompt Queue editor (gsel11;
     * utils/promptRole.ts queueItemRoleView): the role it runs as by the
     * queue's order and where that comes from. The todo is the one it runs: its
     * claim, a TODO item's todo, a finished walk's last one; a walk over several
     * todos with none in hand shows `perTodo`. The step role is its Proceed
     * run's position. `todoRoleOf` reads a todo's role (the editor passes one
     * that reads each quest's todos once per state it builds).
     */
    roleViewOf(item: QueuedPrompt, todoRoleOf: (quest: string, id: string) => string | undefined = readTodoRole): QueueItemRoleView {
        const active = this.activeQuestId();
        const walk = parseTodoWalk(item.repeatCount);
        let todo: { quest: string; id: string } | undefined;
        let perTodo = false;
        if (item.todoClaim) {
            todo = { quest: item.todoClaim.questId, id: item.todoClaim.todoId };
        } else if (walk?.kind === 'todo') {
            todo = { quest: walk.quest, id: walk.id };
        } else if (walk) {
            const quest = walk.kind === 'group' ? walk.quest : active;
            if (item.status === 'sent' && item.repeatTodoId && quest) { todo = { quest, id: item.repeatTodoId }; } else { perTodo = true; }
        } else if (item.repeatTodoId && active) {
            todo = { quest: active, id: item.repeatTodoId };
        }
        let todoRole: string | undefined;
        if (todo) { try { todoRole = todoRoleOf(todo.quest, todo.id); } catch { /* no todo store */ } }
        let stepRole: string | undefined;
        if (item.processRun && active && item.processRun.quest === active) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ProcessStateStore } = require('./processStateStore') as typeof import('./processStateStore');
                stepRole = ProcessStateStore.instance?.runOverview(item.processRun.run ?? 'default').role || undefined;
            } catch { /* no process store */ }
        }
        return queueItemRoleView({ todoRole, itemRole: item.role, stepRole, runDefaultRole: this._settingsOf(itemRun(item)).defaultRole, perTodo });
    }

    /**
     * The chat variable `role` while `item`'s stage sends: held at the role the
     * stage runs as when that role is the queue's own (its todo's, the item's,
     * the run default's), else released (gsel3).
     */
    private async _holdStageRole(item: QueuedPrompt | undefined, processRun: ProcessRun | undefined, source: QueueRoleSource | undefined): Promise<void> {
        if (!item) { return; }
        const decided = await runInProcessPosition(processRun, () => runWithQueueRole(source, async () => livePromptRole()));
        if (rolesShownInChatVariable(decided.from)) {
            this._roleHolds.hold(item.id, decided.role);
            logQueue(`Item ${item.id}: runs as role ${decided.role} (${decided.from}); the chat variable role shows it while it sends`);
        } else {
            this._roleHolds.release(item.id);
        }
    }

    /** Release the chat-variable role of every item that no longer sends (gsel3). */
    private _syncRoleHolds(): void {
        for (const key of this._roleHolds.keys()) {
            const item = this._items.find((i) => i.id === key);
            if (!item || item.status !== 'sending') { this._roleHolds.release(key); }
        }
    }

    private _runTodoOnDone(questId: string, todoId: string, run: string | undefined, queuedBy: QueuedBy | undefined): void {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { findTodoById } = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
            const todo = findTodoById(questId, todoId);
            if (!todo) { return; }
            void runTodoOnDone(questId, { ...todo, sourceFile: todo._sourceFile }, run || DEFAULT_RUN, queuedBy ? { queuedBy } : {})
                .catch((err) => logQueueError(`on_done of ${questId}/${todoId} failed`, err));
        } catch (err) {
            logQueueError(`on_done of ${questId}/${todoId} failed`, err);
        }
    }

    /**
     * The run ended before the claimed todo's answer arrived (stop, interrupt,
     * error, removal): put back the status the claim overwrote — only if the
     * todo still holds the runner's `in-progress`. Anything else is somebody
     * else's write and stays.
     */
    private releaseQuestTodoClaim(item: QueuedPrompt, reason: string): void {
        // A completion the todo writer left to this claim is still carried out: the agent completed it before the stop.
        if (item.todoClaim && !item.todoClaim.released && takeDeferredTodoOnDone(item.todoClaim.questId, item.todoClaim.todoId)) {
            this._runTodoOnDone(item.todoClaim.questId, item.todoClaim.todoId, item.run, item.queuedBy);
        }
        const result = releaseTodoClaim(QUEST_TODO_STATUS_PORT, item.todoClaim);
        if (result.outcome === 'none') { return; }
        item.todoClaim = result.claim;
        const claim = result.claim!;
        if (result.outcome === 'restored') {
            logQueue(`Todo claim released (${reason}): ${claim.questId}/${claim.todoId} back to '${claim.priorStatus}'`);
        } else if (result.outcome === 'left') {
            logQueue(`Todo claim released (${reason}): ${claim.questId}/${claim.todoId} is '${result.found}', not the runner's 'in-progress' — left as it is`);
        } else {
            logQueue(`Todo claim release FAILED (${reason}): could not restore ${claim.questId}/${claim.todoId} to '${claim.priorStatus}'`);
        }
    }

    /**
     * The todo record a stage of a todo iteration carries, or undefined
     * (src/utils/todoIterationRecord.ts): the main prompt its claimed todo, a
     * pre-prompt the todo the walk picks next, a follow-up the todo walked last.
     */
    private iterationTodoBlock(item: QueuedPrompt, stage: IterationStage, claimedId?: string): string | undefined {
        const isTodoIteration = parseTodoWalk(item.repeatCount) !== undefined;
        const questId = isTodoIteration ? this.activeQuestId() : undefined;
        if (!questId) { return undefined; }
        const todoId = todoForStage(stage, {
            isTodoIteration,
            claimedId,
            nextId: stage === 'prePrompt' ? pickNextTodoForIteration(item.repeatCount, walkEntriesOf(item, questId))?.id : undefined,
            lastId: item.repeatTodoId,
        });
        return todoId ? readQuestTodoBlock(questId, todoId) : undefined;
    }

    /**
     * The template an item's text is built with: "Run default" (RUN_DEFAULT_TEMPLATE) is the item's run's default
     * template at this moment (utils/runDefaultChoice.ts), anything else the template as stored.
     */
    private _templateOf(template: string | undefined, item: { run?: string } | undefined): string | undefined {
        return resolveItemTemplate(template, this._settingsOf(item ? itemRun(item as QueuedPrompt) : undefined).defaultMessageTemplateId);
    }

    private async _buildExpandedText(
        originalText: string,
        template?: string,
        repetition?: {
            repeatCount?: number;
            repeatIndex?: number;
            repeatPrefix?: string;
            repeatSuffix?: string;
            /** TODO ITERATION: the todo this dispatch is working on. */
            repeatTodoId?: string;
            repeatTodoTitle?: string;
        },
        templateRepetition?: { templateRepeatCount?: number; templateRepeatIndex?: number },
        /** A todo iteration's stage: the todo's record, appended (src/utils/todoIterationRecord.ts). */
        todoBlock?: string,
    ): Promise<string> {
        const repeatCount = Math.max(0, Math.round(repetition?.repeatCount || 0));
        const repeatIndex = Math.max(0, Math.round(repetition?.repeatIndex || 0));
        const repeatNumber = repeatIndex + 1;
        // Outer (template-level) repetition — same semantics as the inner
        // repeat, but counts how many times this item's entire PP/main/FU
        // sequence has been replayed. Zero when the item isn't part of a
        // template-repeat cycle, in which case the placeholders still
        // resolve to `0` / `1` rather than leaking `${...}` into prompts.
        const templateRepeatCount = Math.max(0, Math.round(templateRepetition?.templateRepeatCount || 0));
        const templateRepeatIndex = Math.max(0, Math.round(templateRepetition?.templateRepeatIndex || 0));
        const templateRepeatNumber = templateRepeatIndex + 1;
        const withAffixes = applyRepetitionAffixes({
            originalText,
            repeatCount,
            repeatIndex,
            repeatPrefix: repetition?.repeatPrefix,
            repeatSuffix: repetition?.repeatSuffix,
        });

        // Resolve repeat affix placeholders via the standard variable resolver.
        // repeatIndex is 0-based, repeatNumber is 1-based (repeatIndex + 1).
        // Supported syntax for repeat placeholders is ${repeatNumber}, ${repeatIndex}, ${repeatCount}.
        // Outer (template-repeat) variants use the templateRepeat* prefix.
        // Mustache placeholders are intentionally not supported for repeat affixes.
        const withResolvedAffixes = resolveVariables(withAffixes, {
            includeEditor: false,
            unresolvedBehavior: 'empty',
            enableExpressions: true,
            values: {
                repeatCount: String(repeatCount),
                repeatIndex: String(repeatIndex),
                repeatNumber: String(repeatNumber),
                templateRepeatCount: String(templateRepeatCount),
                templateRepeatIndex: String(templateRepeatIndex),
                templateRepeatNumber: String(templateRepeatNumber),
                // TODO ITERATION: empty outside `prefix*` mode, so a prompt
                // that references them in counter mode gets '' rather than a
                // leaked `${...}`.
                repeatTodoId: repetition?.repeatTodoId ?? '',
                repeatTodoTitle: repetition?.repeatTodoTitle ?? '',
            },
        });

        // The todo's record goes with the prompt text, inside the template's
        // `${userMessage}`. Its `${`
        // are escaped, so the passes below leave it as stored.
        let expanded = await expandTemplate(withTodoYaml(withResolvedAffixes, todoBlock), { includeEditorContext: false });
        expanded = await applyTemplateWrapping(expanded, template ?? '(None)');
        return expanded;
    }

    /**
     * Refresh the 'queue' window-status dot to reflect this window's *live*
     * local queue state — not a per-event stamp.
     *
     * The prompt queue is a single global queue shared by every window (it
     * lives in the symlinked `_ai/queue`). A discrete prompt-sent /
     * answer-received stamp would therefore show the same colour in every
     * window. What actually differs per window is whether *this* window is
     * driving the queue: auto-send enabled AND an item pending, or an item
     * mid-send. We light the dot in that case and clear it (idle/grey)
     * otherwise.
     *
     * Skips redundant writes when the computed active state is unchanged.
     */
    private _refreshQueueWindowStatus(): void {
        try {
            const hasSending = this._items.some(i => i.status === 'sending');
            const hasPending = this._items.some(i => i.status === 'pending');
            const active = hasSending || (hasPending && this._anyRunMayStart());
            if (active === this._lastQueueActiveWritten) { return; }
            const quest = (await_import_ChatVariablesStore())?.quest || '';
            const windowId = getWindowStatusWindowId();
            const workspaceName = getWindowStatusWorkspaceName();
            setWindowSubsystemActive(windowId, workspaceName, quest, 'queue', active);
            this._lastQueueActiveWritten = active;
        } catch {
            // Best-effort status panel update; queue processing must continue.
        }
    }

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (PromptQueueManager._inst) { return; }
        logQueue('PromptQueueManager initialising');
        const m = new PromptQueueManager();
        m.restore();
        m.startHealthCheck();
        m.setupStatusBarItem();
        // Start file watcher for cross-window sync
        startQueueWatching();
        m._queueChangeDisposable = onQueueChanged(() => {
            debugLog('[PromptQueueManager] Queue files changed on disk, reloading', 'INFO', 'queue');
            m._reloadFromDisk();
        });
        PromptQueueManager._inst = m;
        // What the walk view reads of the queue: the todos items ahead run, the todos running items claim.
        walkQueueFacts = (item, questId) => m._walkQueueFacts(item, questId);
        PromptQueueManager._readyResolve?.(m);
        // An open ask is recorded on its item; asks a reload left open are shown again (vscimpb166).
        setOpenAskStore({ record: (itemId, call) => m._recordOpenAsk(itemId, call), clear: (itemId) => m._clearOpenAsk(itemId) });
        ctx.subscriptions?.push({ dispose: () => setOpenAskStore(undefined) });
        m._scheduleOpenAskRestore();
        // An item that stops sending (done, failed, interrupted, stopped, removed) gives the chat variable role back (gsel3).
        const stopRoleHolds = m._onDidChange.event(() => m._syncRoleHolds());
        ctx.subscriptions?.push(stopRoleHolds);
        // A prompt starts or stops waiting for the user: the editor shows it on the item.
        const stopWaits = onUserWaitsChanged(() => m._onDidChange.fire());
        ctx.subscriptions?.push({ dispose: stopWaits });
        // A question opens or closes: the editor shows it (and its Open question button) on the item.
        const stopQuestions = AskUserRegistry.instance.onDidChange(() => m._onDidChange.fire());
        ctx.subscriptions?.push({ dispose: stopQuestions });
        // A turn starts or stops waiting in tomAi_waitFor: the item shows it (vscimpb82).
        const stopWaitFor = WaitForRegistry.instance.onChange((wait, phase, outcome) => m._onWaitForChange(wait.queueItemId, phase === 'begin' ? wait.state : undefined, outcome));
        ctx.subscriptions?.push({ dispose: stopWaitFor });
        // A soft interrupt is requested, holds, is released or ends: the item records it (vscimpb112).
        const stopSoft = SoftInterruptRegistry.instance.onDidChange((itemId) => m._onSoftInterruptChange(itemId));
        ctx.subscriptions?.push({ dispose: stopSoft });
        // Items other quests' windows sent while this window was not running, and from now on as they arrive.
        m._inboxChangeDisposable = onInboxChanged(() => { void m.takeInbox(); });
        void m.takeInbox();
        logQueue(`PromptQueueManager initialised — ${m._items.length} items restored, runs paused: ${m._pausedRuns().join(', ') || 'none'}`);
    }

    static get instance(): PromptQueueManager {
        if (!PromptQueueManager._inst) { throw new Error('PromptQueueManager not initialised'); }
        return PromptQueueManager._inst;
    }

    private static _readyResolve: ((m: PromptQueueManager) => void) | undefined;
    private static readonly _ready: Promise<PromptQueueManager> = new Promise((resolve) => { PromptQueueManager._readyResolve = resolve; });

    /**
     * The manager once it runs. A view that subscribes while the extension
     * activates — an editor tab VS Code restores after a reload, before
     * `init` — subscribes through this, or it would listen to nothing.
     */
    static whenReady(): Promise<PromptQueueManager> {
        return PromptQueueManager._inst ? Promise.resolve(PromptQueueManager._inst) : PromptQueueManager._ready;
    }

    dispose(): void {
        logQueue('PromptQueueManager disposing');
        for (const timer of this._autoContinueTimers.values()) { clearTimeout(timer); }
        this._autoContinueTimers.clear();
        if (this._reloadDebounceTimer) {
            clearTimeout(this._reloadDebounceTimer);
            this._reloadDebounceTimer = undefined;
        }
        this.stopHealthCheck();
        this._queueChangeDisposable?.dispose();
        this._inboxChangeDisposable?.dispose();
        this._statusBarChangeDisposable?.dispose();
        this._statusBarItem?.dispose();
        stopQueueWatching();
        this._onDidChange.dispose();
        this._onPromptSent.dispose();
        this._onAnswerReceived.dispose();
    }

    private setupStatusBarItem(): void {
        if (this._statusBarItem) { return; }
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this._statusBarItem.command = 'tomAi.editor.promptQueue';
        this._statusBarItem.name = 'Prompt Queue Status';
        this._statusBarItem.show();
        this._statusBarChangeDisposable = this.onDidChange(() => this.updateStatusBarItem());
        this.updateStatusBarItem();
    }

    private updateStatusBarItem(): void {
        if (!this._statusBarItem) { return; }
        const pending = this._items.filter(i => i.status === 'pending').length;
        const sending = this._items.filter(i => i.status === 'sending').length;

        // The window's run held or waiting: the same icon and word as its run tab (vscimpb112).
        const runSending = this._items.find((i) => i.status === 'sending' && itemRun(i) === this._windowRun());
        const held = runSending ? runStatusBarText({
            run: this._windowRun(),
            softInterrupt: SoftInterruptRegistry.instance.stateOf(runSending.id) ?? runSending.softInterrupt,
            ...(this.waitingForUserOf(runSending.id).includes('question') ? { question: { firstLine: this.pendingQuestionOf(runSending.id)?.firstLine } } : {}),
            waitingFor: runSending.waitingFor,
        }) : undefined;
        if (held) {
            this._statusBarItem.text = held.text;
            this._statusBarItem.tooltip = held.tooltip;
            return;
        }
        if (sending > 0) {
            this._statusBarItem.text = '$(sync~spin) Queue Sending...';
            this._statusBarItem.tooltip = `Prompt Queue active: sending ${sending}, pending ${pending}`;
            return;
        }

        const paused = this._pausedRuns();
        if (this.allRunQueueSettings().some((r) => r.settings.autoSend) || this._items.some((i) => i.status === 'pending' && this._autoSendFor(i))) {
            this._statusBarItem.text = `$(play) Queue Active (${pending} pending)`;
            this._statusBarItem.tooltip = `Prompt Queue auto-send on${paused.length ? `; paused runs: ${paused.join(', ')}` : ''}`;
            return;
        }

        this._statusBarItem.text = '$(debug-pause) Queue Paused';
        this._statusBarItem.tooltip = `Prompt Queue paused (${pending} pending)`;
    }

    private startHealthCheck(): void {
        if (this._healthCheckTimer) { return; }
        this._healthCheckTimer = setInterval(() => {
            void this.runHealthCheck();
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthCheck(): void {
        if (!this._healthCheckTimer) { return; }
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = undefined;
    }

    private async runHealthCheck(): Promise<void> {
        // The inbox: a file the folder watcher missed, or a claim a stopped window left behind.
        await this.takeInbox();
        // Resume rate-limit "waiting" items whose reset+buffer instant has
        // arrived: flip them back to `pending` so the normal send path retries
        // them. Because this runs on the health-check timer (which survives a
        // window reload) the retry fires at the right instant even if the
        // window was reloaded while the item was parked.
        const nowMs = Date.now();
        /** The runs of the parked items that became due: they resume even while their run is paused. */
        const resumedRuns = new Set<string>();
        let resumedWaiting = false;
        for (const item of this._items) {
            if (item.status === 'waiting' && isWaitingDue(item.waitingUntil, nowMs)) {
                clearWaitingState(item);
                resumedWaiting = true;
                resumedRuns.add(itemRun(item));
                logQueue(`Health check: reset window elapsed for item ${item.id}; resuming as pending`);
            }
        }

        // Fire due `retry` items: flip them back to `pending` (preserving the
        // backoff attempt) so the normal send path retries them. Because this
        // runs on the health-check timer the retry fires at the right instant
        // even across a window reload. See queueRetryTransitions.fireRetry.
        let resumedRetry = false;
        for (const item of this._items) {
            if (item.status === 'retry' && isRetryDue(item.retryUntil, nowMs)) {
                fireRetry(item);
                resumedRetry = true;
                resumedRuns.add(itemRun(item));
                logQueue(`Health check: retry countdown elapsed for item ${item.id}; resuming as pending`);
            }
        }

        // An ask whose window has gone since (closed, or reloaded while its heartbeat was still fresh) is taken
        // over and shown here (vscimpb166).
        this._keepItemsWithOpenAsk(this._items);
        this._scheduleOpenAskRestore(0);

        if (resumedWaiting || resumedRetry) {
            this.persistSettings();
            this.persist();
            this._onDidChange.fire();
        }

        // While any item is still parked in `waiting` (rate-limit reset not yet
        // due) or `retry` (backoff countdown not yet due), hold every send: the
        // parked item keeps its queue position at the top and the queue stays
        // visibly stopped rather than draining past the stuck prompt. The
        // health-check above resumes the parked item when its instant arrives.
        const hasBlockingWaiting = this._items.some(i => i.status === 'waiting' || i.status === 'retry');

        const pendingCount = this._items.filter(i => i.status === 'pending').length;
        const interruptedCount = this._items.filter(i => i.status === 'interrupted').length;
        const sendingCount = this._items.filter(i => i.status === 'sending').length;
        const decisions = computeHealthCheckDecisions({
            autoSendEnabled: this._anyRunMayStart(),
            // A lane can be idle while another sends: the drain is due whenever an item could start
            // (the stale-sending check still sees what sends).
            laneStartPossible: this._laneStarts().length > 0,
            // An interrupted item is work the drain must pick up — it resumes via
            // the hook at the top of `sendNext` — so it counts towards the
            // trigger. This is what lets Auto-Start replay it after a reload.
            pendingCount: pendingCount + interruptedCount,
            sendingCount,
        });

        logQueue(`Health check: items=${this._items.length}, sending=${sendingCount}, pending=${pendingCount}, pausedRuns=${this._pausedRuns().join(',') || 'none'}, blockingWaiting=${hasBlockingWaiting}`);

        if (hasBlockingWaiting) {
            logQueue('Health check holding all sends: an item is waiting for its rate-limit reset or retry backoff');
        } else if (decisions.shouldTriggerSendNext) {
            logQueue('Health check detected pending prompts without active sending; triggering sendNext');
            await this.sendNext();
        } else if (resumedWaiting || resumedRetry) {
            // A parked item (waiting reset OR retry backoff) just became due,
            // but auto-send may be off (the
            // queue could have been paused independently). Drive the drain
            // directly so it resumes regardless of the auto-send flag.
            logQueue('Health check resuming after a parked window (rate-limit reset, retry backoff, or deferred start)');
            await this.sendNext(resumedRuns);
        }
    }

    /**
     * Apply the chat-variable updates carried by one *final* answer. Every
     * final answer goes through here so a repeating / multi-stage queue item
     * propagates responseValues for EVERY stage — each pre-prompt, the main
     * prompt, every repeat, and every follow-up: {@link _propagateDirectAnswer}
     * parses responseValues out of the answer text and passes
     * `source: 'anthropic'`.
     */
    private propagateAnswerResponseValues(
        answer: Record<string, unknown> | undefined,
        source: ChangeSource,
        item?: QueuedPrompt,
    ): void {
        debugLog(`[PromptQueueManager] propagateAnswerResponseValues called (source=${source})`, 'DEBUG', 'queue');
        if (!answer || typeof answer !== 'object') {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no answer object`, 'DEBUG', 'queue');
            return;
        }

        const normalized = normalizeResponseValues((answer as any).responseValues as Record<string, unknown> | undefined);
        if (Object.keys(normalized).length === 0) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no values to propagate`, 'DEBUG', 'queue');
            return;
        }

        const { chatResponseValues, customValues } = splitResponseValues(normalized);
        debugLog(`[PromptQueueManager] propagateAnswerResponseValues: propagating ${Object.keys(chatResponseValues).length} values: ${JSON.stringify(chatResponseValues)}`, 'INFO', 'queue');

        const answerRequestId = typeof (answer as any).requestId === 'string' ? (answer as any).requestId : undefined;

        try {
            const { updateChatResponseValues } = require('../handlers/handler_shared');
            updateChatResponseValues(chatResponseValues);
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: updated handler_shared`, 'DEBUG', 'queue');
        } catch (e) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: handler_shared error: ${e}`, 'WARN', 'queue');
        }

        try {
            const chatStore = await_import_ChatVariablesStore() as any;
            if (chatStore && typeof chatStore.setCustomBulk === 'function') {
                if (Object.keys(customValues).length > 0) {
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: calling setCustomBulk with ${Object.keys(customValues).length} values: ${JSON.stringify(customValues)}`, 'INFO', 'queue');
                    // Lanes send several runs at once (Queue per run): the values go to the answering item's run.
                    const write = (): void => chatStore.setCustomBulk(customValues, source, answerRequestId);
                    if (item && typeof chatStore.withRun === 'function') {
                        chatStore.withRun(laneOf(item, true), write);
                    } else {
                        write();
                    }
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: setCustomBulk completed`, 'DEBUG', 'queue');
                } else {
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no custom values to set (all built-in)`, 'DEBUG', 'queue');
                }
            } else {
                debugLog(`[PromptQueueManager] propagateAnswerResponseValues: chatStore not available or setCustomBulk not a function`, 'WARN', 'queue');
            }
        } catch (e) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: chatStore error: ${e}`, 'WARN', 'queue');
        }
    }

    /**
     * Propagate responseValues carried by a *direct* (Anthropic) answer. The
     * queue's Anthropic transport returns the model's answer text inline rather
     * than through an answer file, so we parse the structured responseValues out
     * of the free-form text here. Called once per direct dispatch — i.e. for
     * every pre-prompt, the main prompt, every repeat, and every follow-up — so
     * variable setting works on every final answer, not only the last.
     */
    private _propagateDirectAnswer(text: string, item?: QueuedPrompt): void {
        if (!text) { return; }
        this.propagateAnswerResponseValues({ responseValues: extractResponseValuesFromText(text) }, 'anthropic', item);
    }

    // ----- queue CRUD --------------------------------------------------------

    get items(): readonly QueuedPrompt[] { return this._items; }

    /** The items as USER NOTIFICATIONS reads their holding state (vscimpb170). */
    holdingItems(): HoldingItem[] {
        return this._items.map((i) => {
            const decisionTodo = i.status === 'decision-needed' ? this._decisionTodoOf(i) : undefined;
            return {
                id: i.id,
                status: i.status,
                run: itemRun(i),
                ...(i.needsAttention ? { needsAttention: i.needsAttention } : {}),
                ...(i.error ? { error: i.error } : {}),
                ...(i.blockedOn ? { blockedOn: i.blockedOn } : {}),
                ...(decisionTodo ? { decisionTodo } : {}),
                preview: (i.originalText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || i.id,
            };
        });
    }

    /**
     * The todo a `decision-needed` item waits at (USER NOTIFICATIONS offers to continue the queue once its
     * decisions are answered): a walk's first todo still `decision-needed`, else the first of its
     * `todoIdPattern` todos that is. Undefined when none is found.
     */
    private _decisionTodoOf(item: QueuedPrompt): { quest: string; id: string } | undefined {
        const questId = this.activeQuestId();
        if (!questId) { return undefined; }
        try {
            const walk = parseTodoWalk(item.repeatCount);
            if (walk) {
                const hit = collectWalkTodos(walk, walkEntriesOf(item, questId)).find((e) => e.status === 'decision-needed' && !e.excluded);
                if (hit) { return { quest: walk.kind === 'prefix' ? questId : walk.quest, id: hit.id }; }
            }
            const ids = (item.todoIdPattern ?? '').split(',').map((p) => p.trim()).filter((p) => p && !p.endsWith('*'));
            const entries = readQuestTodoEntries(questId);
            const hit = ids.find((id) => entries.some((e) => e.id === id && e.status === 'decision-needed'));
            return hit ? { quest: questId, id: hit } : undefined;
        } catch { return undefined; }
    }
    get pendingCount(): number { return this._items.filter(i => i.status === 'pending').length; }
    /** The window's run's auto-send (settings per run: {@link runQueueSettings}). */
    get autoSendEnabled(): boolean { return this._settingsOf(undefined).autoSend; }

    /**
     * Switch the window's run's auto-send. Pausing has no immediate effect —
     * the pause gate catches the run's next repetition; an in-flight rep
     * finishes naturally. Switching on replays the run's interrupted item,
     * else resumes its paused item, else starts its lane (setRunQueueSettings).
     */
    set autoSendEnabled(v: boolean) {
        this.setRunAutoSend(undefined, v);
    }

    /**
     * Put back to `pending` the items whose decision block is over, just before
     * picking the next one to send.
     *
     * Held items are re-checked here rather than when auto-send is switched on,
     * because the answer can arrive at any point — while the queue is draining
     * other prompts, not only while it is paused. Reading the todos on every
     * drain step is cheap next to dispatching a prompt, and the alternative
     * (release on resume) re-blocked the item immediately and switched auto-send
     * back off, which is what made the play button look like a no-op.
     */
    private _releaseResolvedDecisionItems(): void {
        const unblocked = this._releaseUnblockedItems();
        const decided = this._releaseDecidedItems();
        this._resumeRunsAfterHolds([...unblocked, ...decided]);
    }

    /** Put back to `pending` the `decision-needed` items whose todo's decisions are answered. Answers them. */
    private _releaseDecidedItems(): QueuedPrompt[] {
        if (!this._items.some(i => i.status === 'decision-needed')) { return []; }
        const questId = this.activeQuestId();
        if (questId) { settleDecidedTodos(questId); }
        const released = releaseResolvedDecisionItems(this._items, (item) => (questId ? walkEntriesOf(item, questId) : []));
        if (released.length === 0) { return []; }
        logQueue(`Decisions answered — releasing ${released.map(i => i.id).join(', ')} back to pending`);
        this.persist();
        this._onDidChange.fire();
        return released;
    }

    /**
     * Held items were released (blocker completed, decisions answered): switch on again the runs their hold had
     * paused (`holdPausedRun`), when the run's `autoResumeHeld` is on, its auto-send was not set since, and no
     * other item of it is still held by a hold that paused it. A run the user paused stays paused.
     */
    private _resumeRunsAfterHolds(released: readonly QueuedPrompt[]): void {
        const runs = new Map<string, QueuedPrompt[]>();
        for (const item of released) {
            if (!item.holdPausedRun) { continue; }
            delete item.holdPausedRun;
            const run = itemRun(item);
            runs.set(run, [...(runs.get(run) ?? []), item]);
        }
        for (const [run, items] of runs) {
            const settings = this._settingsOf(run);
            const stillHeld = this._items.some((i) => i.holdPausedRun && itemRun(i) === run && (i.status === 'todo-blocked' || i.status === 'decision-needed'));
            if (settings.autoSend || !settings.autoResumeHeld || stillHeld) {
                logQueue(`Run ${run}: held item(s) ${items.map((i) => i.id).join(', ')} released; not resumed (${settings.autoSend ? 'it sends already' : !settings.autoResumeHeld ? 'auto-resume after a hold is off' : 'another item of it is still held'})`);
                continue;
            }
            const why = `${items.map((i) => i.id).join(', ')} no longer held (blocker completed or decisions answered)`;
            logQueue(`Run ${run} resumed by itself: ${why}`);
            emitRunResumed(run, why, items[0]?.id);
            this.setRunAutoSend(run, true);
        }
        if (runs.size) { this.persist(); }
    }

    /**
     * Look again at the held items (`todo-blocked`, `decision-needed`) now: a todo file changed (a blocker was
     * completed, decisions answered — in this window, another window or another quest). Released items go back to
     * pending and the runs their hold paused go on ({@link _resumeRunsAfterHolds}).
     */
    recheckHeldItems(): void {
        if (!this._items.some((i) => i.status === 'todo-blocked' || i.status === 'decision-needed')) { return; }
        this._releaseResolvedDecisionItems();
    }

    /**
     * Put back to `pending` the `todo-blocked` items whose todo is no longer
     * blocked: its blockers were completed (a todo still marked `blocked` whose
     * blockers are all done is set back to `not-started` first).
     */
    private _releaseUnblockedItems(): QueuedPrompt[] {
        const held = this._items.filter(i => i.status === 'todo-blocked');
        if (!held.length) { return []; }
        const questId = this.activeQuestId();
        const released: QueuedPrompt[] = [];
        for (const item of held) {
            if (questId && this._todoBlockOf(item, questId)) { continue; }
            item.status = 'pending';
            delete item.blockedOn;
            delete item.blockedTodo;
            released.push(item);
        }
        if (!released.length) { return []; }
        logQueue(`Blockers completed — releasing ${released.map((i) => i.id).join(', ')} back to pending`);
        this.persist();
        this._onDidChange.fire();
        return released;
    }

    /**
     * What blocks the todo item `item` is about, or undefined when nothing
     * does. A walk: the todo it would take next (the todos whose blockers are
     * done are released first). A plain item naming todos in `todoIdPattern`:
     * the first of them that is blocked. Blockers completed in the meantime
     * never block: a todo still marked `blocked` is set back to `not-started`.
     */
    private _todoBlockOf(item: QueuedPrompt, questId: string): { id: string; why: string } | undefined {
        if (parseTodoWalk(item.repeatCount) !== undefined) {
            releaseUnblockedTodos(item.repeatCount, questId, QUEST_TODO_UNBLOCK_PORT);
            const blocked = blockHoldingWalk(item.repeatCount, walkEntriesOf(item, questId));
            return blocked.length ? { id: blocked[0].id, why: `todo ${blocked[0].id} ${blocked[0].blockedReason}` } : undefined;
        }
        const ids = (item.todoIdPattern ?? '').split(',').map((p) => p.trim()).filter((p) => p && !p.endsWith('*'));
        if (!ids.length) { return undefined; }
        const { states, todos } = questTodoBlockData(questId, new Set(ids));
        const ctx = walkBlockContextOf(item, questId);
        for (const id of ids) {
            const state = states.get(id);
            if (!state) { continue; }
            if (state.releasable) {
                logQueue(`Item ${item.id}: todo ${id} unblocked (blockers done: ${state.met.join(', ')})`);
                // Through the unblock port, as the walk's release (the claim rules write no status back themselves).
                QUEST_TODO_UNBLOCK_PORT.writeStatus(questId, id, 'not-started');
                continue;
            }
            const todo = todos.get(id);
            const block = effectiveBlock({ id, status: todo?.status, blockedBy: todo?.blocked_by, blockedUntil: todo?.blocked_until }, state, ctx);
            if (block.blocked) { return { id, why: `todo ${id} ${block.reason}` }; }
        }
        return undefined;
    }

    /** Hold `item` as `todo-blocked` (`why`: the todo and what it waits for) and pause its run, as an open decision does. */
    private _holdTodoBlocked(item: QueuedPrompt, why: string, todoId?: string): void {
        logQueue(`Item ${item.id}: held, ${why}`);
        item.status = 'todo-blocked';
        item.blockedOn = why;
        if (todoId) { item.blockedTodo = todoId; } else { delete item.blockedTodo; }
        item.awaitingAnswer = false;
        item.inFlightRepetition = undefined;
        if (this._pauseRunOf(item, `item ${item.id} is blocked: ${why}`)) { item.holdPausedRun = true; }
        this.persist();
        this._onDidChange.fire();
    }

    /**
     * What the walk view (utils/walkBlockView.ts) reads of the queue for `item`:
     * the todos the items ahead of it run — the single todos they name, the open
     * todos of their walks and groups — and the todos another running item holds
     * a claim on. Ahead: before it in the queue and not finished (sent, failed
     * and chat sends do not count).
     */
    private _walkQueueFacts(item: QueuedPrompt, questId: string): { queuedAhead(quest: string, id: string): boolean; claimedElsewhere(id: string): boolean } {
        let ahead: Set<string> | undefined;
        const aheadSet = (): Set<string> => {
            if (ahead) { return ahead; }
            ahead = new Set<string>();
            const at = this._items.indexOf(item);
            const before = at < 0 ? [] : this._items.slice(0, at).filter((i) => !['sent', 'error', 'chat', 'chat-sent'].includes(i.status));
            let entries: TodoIterationSource[] | undefined;
            for (const i of before) {
                for (const id of (i.todoIdPattern ?? '').split(',').map((p) => p.trim()).filter((p) => p && !p.endsWith('*'))) { ahead.add(id); }
                const walk = parseTodoWalk(i.repeatCount);
                if (!walk) { continue; }
                entries ??= readQuestTodoEntries(questId);
                for (const e of collectWalkTodos(walk, entries)) {
                    if (e.status !== 'completed' && e.status !== 'cancelled') { ahead.add(e.id); }
                }
            }
            return ahead;
        };
        return {
            queuedAhead: (quest, id) => quest === questId && aheadSet().has(id),
            claimedElsewhere: (id) => this._items.some((i) => i !== item && i.status === 'sending' && !!i.todoClaim && !i.todoClaim.released
                && i.todoClaim.questId === questId && i.todoClaim.todoId === id),
        };
    }

    /** The todo a held (`todo-blocked`) item waits at: `blockedTodo`, else read from `blockedOn` (an item held by an older build). */
    private _blockedTodoOf(item: QueuedPrompt): string | undefined {
        if (item.blockedTodo) { return item.blockedTodo; }
        const m = /^todo (\S+) /.exec(item.blockedOn ?? '');
        return m ? m[1] : undefined;
    }

    /** Which actions a held item offers (the queue editor's buttons): Continue only for a walk or a GROUP item. */
    blockedItemActions(id: string): { canSkip: boolean; canRunAnyway: boolean } {
        const item = this._items.find((i) => i.id === id);
        if (!item || item.status !== 'todo-blocked') { return { canSkip: false, canRunAnyway: false }; }
        return { canSkip: parseTodoWalk(item.repeatCount) !== undefined && parseTodoWalk(item.repeatCount)?.kind !== 'todo', canRunAnyway: !!this._blockedTodoOf(item) };
    }

    /**
     * Continue past the todo a held walk or GROUP item waits at: the todo is
     * skipped for this item (its walk passes it), the item goes back to
     * `pending` and its run's auto-send comes on, so the walk goes on with its
     * next todo. A single-todo item has no next todo: refused.
     */
    skipBlockedTodo(id: string): boolean {
        const item = this._items.find((i) => i.id === id);
        if (!item || item.status !== 'todo-blocked') { return false; }
        const walk = parseTodoWalk(item.repeatCount);
        const todoId = this._blockedTodoOf(item);
        if (!walk || walk.kind === 'todo' || !todoId) { return false; }
        item.skippedTodos = [...new Set([...(item.skippedTodos ?? []), todoId])];
        logQueue(`Item ${item.id}: todo ${todoId} skipped by the user — the walk goes on`);
        this._releaseHeldByUser(item);
        return true;
    }

    /**
     * Run the todo a held item waits at anyway (its blocking information may be
     * out of date): its blockers no longer hold it for this item, a todo still
     * marked `blocked` is set to `not-started`, the item goes back to `pending`
     * and its run's auto-send comes on.
     */
    runBlockedTodoAnyway(id: string): boolean {
        const item = this._items.find((i) => i.id === id);
        if (!item || item.status !== 'todo-blocked') { return false; }
        const todoId = this._blockedTodoOf(item);
        if (!todoId) { return false; }
        item.ignoreBlockTodos = [...new Set([...(item.ignoreBlockTodos ?? []), todoId])];
        const questId = this.activeQuestId();
        if (questId) {
            const raw = questTodoBlockData(questId, new Set([todoId])).todos.get(todoId);
            if (raw?.status === 'blocked') { QUEST_TODO_UNBLOCK_PORT.writeStatus(questId, todoId, 'not-started'); }
        }
        logQueue(`Item ${item.id}: todo ${todoId} run anyway by the user (its blockers are not waited for)`);
        this._releaseHeldByUser(item);
        return true;
    }

    /** A held item the user released: `pending`, the hold's record gone, its run's auto-send on. */
    private _releaseHeldByUser(item: QueuedPrompt): void {
        item.status = 'pending';
        delete item.blockedOn;
        delete item.blockedTodo;
        this.persist();
        this._onDidChange.fire();
        this.setRunAutoSend(itemRun(item), true);
    }

    /**
     * Continue a paused 'sending' item from where the pause gate
     * stopped it. The item's counters already reflect the last
     * dispatched repetition; we just re-enter the dispatch loop so
     * the next repetition (or stage, or follow-up) goes out.
     *
     * Mirrors the tail of `sendItem` for outcome bookkeeping:
     *
     *   - `'paused'`     — somehow paused again (e.g. user toggled
     *     off in the same tick); leave item alone.
     *   - `'done'`       — mark sent + advance queue.
     */
    private async _resumePausedSendingItem(item: QueuedPrompt): Promise<void> {
        const epoch = this._epochOf(item);
        try {
            const outcome = await this._runDispatchFrame(item);
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                logQueue(`_resumePausedSendingItem(${item.id}): dispatch superseded by an explicit action — original frame stands down`);
                return;
            }
            if (outcome === 'paused') {
                logQueue(`_resumePausedSendingItem(${item.id}): re-paused`);
            } else {
                const liveItem = this._items.find(i => i.id === item.id) ?? item;
                liveItem.status = 'sent';
                // Continue the outer template-repeat loop — see the
                // matching call in sendItem for the rationale.
                await this._afterItemDone(liveItem, 'resume/anthropic');
                this.persist();
                this._onDidChange.fire();
                logQueue(`Resumed item ${item.id} completed`);
                if (this._shouldAdvanceQueueAfter(liveItem)) {
                    void this.sendNext();
                }
            }
        } catch (err) {
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                logQueue(`_resumePausedSendingItem(${item.id}): dispatch cancelled by an explicit action — error suppressed`);
                return;
            }
            const liveItem = this._items.find(i => i.id === item.id) ?? item;
            this._markItemError(liveItem, err, `_resumePausedSendingItem(${item.id})`, readInterruptionFromError(err));
        }
    }


    get autoSendDelayMs(): number { return this._autoSendDelayMs; }
    set autoSendDelayMs(v: number) { this._autoSendDelayMs = Math.max(500, v); }

    get autoContinueEnabled(): boolean { return this._settingsOf(undefined).autoContinue; }
    set autoContinueEnabled(v: boolean) { this.setRunQueueSettings(undefined, { autoContinue: v }); }

    get autoStartEnabled(): boolean { return this._settingsOf(undefined).autoStart; }
    set autoStartEnabled(v: boolean) { this.setRunQueueSettings(undefined, { autoStart: v }); }

    get autoPauseEnabled(): boolean { return this._settingsOf(undefined).autoPause; }
    set autoPauseEnabled(v: boolean) { this.setRunQueueSettings(undefined, { autoPause: v }); }

    /** Restart the queue: reset stuck "sending" items to "pending" and restart processing. */
    restartQueue(run?: string): void {
        logQueue(`Restarting queue processing${run !== undefined ? ` of run ${normalizeRun(run)}` : ''}`);
        let resetCount = 0;
        for (const item of this._items) {
            if (item.status === 'sending' && this._inRun(item, run)) {
                item.status = 'pending';
                resetCount++;
            }
        }
        if (resetCount > 0) {
            logQueue(`Reset ${resetCount} stuck sending items to pending`);
        }
        this._onDidChange.fire();
        // If auto-send is on, start processing
        if (this._anyRunMayStart()) {
            void this.sendNext();
        }
    }

    /**
     * Add a prompt to the queue.
     * @param position Insert index. -1 = end (default). 1 = high priority (after current sending).
     */
    async enqueue(opts: {
        originalText: string;
        /** The todos it runs (QueuedPrompt.todoIdPattern); a `<prefix>*` repeat count gives it when omitted. */
        todoIdPattern?: string;
        template?: string;
        type?: QueuedPromptType;
        /** With `type: 'timed'`: the timed request that queued it (QueuedPrompt.timedEntryId). */
        timedEntryId?: string;
        position?: number;
        prePrompts?: Array<{
            text: string;
            template?: string;
            repeatCount?: number | string;
        }>;
        followUps?: Array<{
            originalText: string;
            template?: string;
            repeatCount?: number | string;
        }>;
        repeatCount?: number | string;
        repeatIndex?: number;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        templateRepeatIndex?: number;
        /** The background-wait limit in minutes (0 = no wait); unset: the profile's. */
        backgroundWaitLimitMinutes?: number;
        /** Continuations a walk iteration gets while its todo is not completed; unset: the queue's. */
        walkContinuations?: number;
        initialStatus?: 'staged' | 'pending';
        deferSend?: boolean;
        // Multi-transport pin-through (spec §4.1).
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
        /** The named session the item runs in: a name, or a spec `{name, basedOn?, mode?, profile?}`. */
        session?: string | Record<string, unknown>;
        /** The role the item runs as (a folder of `_ai/roles/`); unset or "": none of its own. */
        role?: string;
        /** The item's guideline choices (gsel4; the caller validated them); unset or {}: none. */
        guidelines?: Record<string, string | string[]>;
        /** The process position the item belongs to; default: the one the current send runs for, if any. */
        processRun?: ProcessRun;
        /** The process run the item belongs to; default the Proceed's, else the window's current run. */
        run?: string;
        /** Make the item a process-move marker (with `processRun`, the position it moves from). */
        processMove?: ProcessMoveSpec;
        /** A process item: does not count towards the quest refresh (vscimpb97). */
        processItem?: boolean;
        /** Queued with a queue button of the @CHAT panel: its subpanel (QueuedPrompt.fromChatPanel). */
        fromChatPanel?: string;
        /** The reload prompt of the window named (vscimpb109). */
        reloadPrompt?: { windowId: string };
        /** "Pause after this". */
        pauseAfter?: boolean;
        doneNotificationPrompt?: string;
        doneNotificationDisabled?: boolean;
        /** Who queued it (QueuedPrompt.queuedBy). */
        queuedBy?: QueuedBy;
        /** The quest the done-notification is posted to; unset: this quest. */
        doneNotificationQuest?: string;
        /** The process run the done-notification is queued in. */
        doneNotificationRun?: string;
        notificationOf?: string;
        from?: InboxSender;
        temporarySession?: boolean;
        /** `run` is named on purpose: a running Proceed's position is not inherited (a done notification for another run). */
        runIsExplicit?: boolean;
        /** Queue the todo(s) even while an item with the same todo id pattern is staged, pending or sending (a deliberate repeat). */
        allowDuplicateTodo?: boolean;
    }): Promise<QueuedPrompt> {
        // One todo, one waiting item (todoQueueDuplicates.ts): a second enqueue of a queued todo is refused.
        const duplicatePattern = todoIdPatternOf({ todoIdPattern: opts.todoIdPattern, repeatCount: opts.repeatCount });
        if (duplicatePattern && !opts.allowDuplicateTodo) {
            const existing = queuedItemForTodoPattern(this._items, duplicatePattern);
            if (existing) {
                logQueue(`Enqueue refused: ${duplicatePattern} is already queued (item ${existing.id}, ${existing.status})`);
                throw new TodoAlreadyQueuedError(duplicatePattern, existing.id, existing.status);
            }
        }
        for (const value of [opts.repeatCount, opts.templateRepeatCount, ...(opts.prePrompts ?? []).map((p) => p.repeatCount),
            ...(opts.followUps ?? []).map((f) => f.repeatCount)]) {
            assertValidRepeatCount(value);
        }
        const parsedSession = this.parseItemSession(opts.session);
        // The item's process run: its Proceed's (also inherited while one runs), else the one named,
        // else the window's. It uses the run's own sessions: a named session becomes `<session>@<run>`
        // (src/utils/runSessions.ts).
        const inherited = opts.runIsExplicit ? opts.processRun : inheritedProcessRun(opts.processRun);
        const itemRun = normalizeRun(inherited?.run ?? opts.run ?? windowProcessRun());
        const sessionSpec = parsedSession ? { ...parsedSession, name: runSessionName(parsedSession.name, itemRun) } : parsedSession;
        const resolvedRepeatCount = resolveRepeatCount(opts.repeatCount);
        const expanded = await this._buildExpandedText(
            opts.originalText,
            resolveItemTemplate(opts.template, this._settingsOf(itemRun).defaultMessageTemplateId),
            {
                repeatCount: resolvedRepeatCount,
                repeatIndex: opts.repeatIndex,
                repeatPrefix: opts.repeatPrefix,
                repeatSuffix: opts.repeatSuffix,
            },
            {
                templateRepeatCount: resolveRepeatCount(opts.templateRepeatCount),
                templateRepeatIndex: opts.templateRepeatIndex,
            },
        );

        const item: QueuedPrompt = {
            id: randomUUID(),
            template: isRunDefaultChoice(opts.template) ? RUN_DEFAULT_TEMPLATE : (opts.template ?? '(None)'),
            originalText: opts.originalText,
            expandedText: expanded,
            status: opts.initialStatus ?? 'pending',
            type: opts.type ?? 'normal',
            ...(opts.timedEntryId ? { timedEntryId: opts.timedEntryId } : {}),
            createdAt: new Date().toISOString(),
            prePrompts: (opts.prePrompts || [])
                .filter(p => !!(p.text || '').trim())
                .map(p => ({
                    text: p.text,
                    template: p.template,
                    status: 'pending' as const,
                    repeatCount: p.repeatCount,
                })),
            followUps: (opts.followUps || [])
                .filter(f => !!(f.originalText || '').trim())
                .map(f => ({
                    id: randomUUID(),
                    originalText: f.originalText,
                    template: f.template,
                    repeatCount: f.repeatCount,
                    createdAt: new Date().toISOString(),
                })),
            followUpIndex: 0,
            repeatCount: opts.repeatCount,
            repeatIndex: Math.max(0, Math.round(opts.repeatIndex || 0)),
            repeatPrefix: opts.repeatPrefix,
            repeatSuffix: opts.repeatSuffix,
            templateRepeatCount: opts.templateRepeatCount,
            templateRepeatIndex: Math.max(0, Math.round(opts.templateRepeatIndex || 0)),
            ...(validLimit(opts.backgroundWaitLimitMinutes) !== undefined ? { backgroundWaitLimitMinutes: validLimit(opts.backgroundWaitLimitMinutes) } : {}),
            ...(validContinuations(opts.walkContinuations) !== undefined ? { walkContinuations: validContinuations(opts.walkContinuations) } : {}),
            transport: opts.transport,
            anthropicProfileId: opts.anthropicProfileId,
            anthropicConfigId: opts.anthropicConfigId,
            ...(sessionSpec ? { session: sessionSpec.name } : {}),
            ...(sessionSpec && specExtras(sessionSpec) ? { sessionCreate: specExtras(sessionSpec) } : {}),
            ...(opts.role && opts.role.trim() ? { role: opts.role.trim() } : {}),
            ...(normalizeAspectChoices(opts.guidelines) ? { guidelines: normalizeAspectChoices(opts.guidelines) } : {}),
            // A prompt queued while a Proceed prompt runs (a planning step queuing
            // its todo walks) belongs to the same position.
            ...(inherited ? { processRun: inherited } : {}),
            run: itemRun,
            itemKind: deriveQueueItemKind({ status: opts.initialStatus ?? 'pending', repeatCount: opts.repeatCount }),
            ...(todoIdPatternOf({ todoIdPattern: opts.todoIdPattern, repeatCount: opts.repeatCount }) ? { todoIdPattern: todoIdPatternOf({ todoIdPattern: opts.todoIdPattern, repeatCount: opts.repeatCount }) } : {}),
            ...(opts.processMove ? { processMove: opts.processMove } : {}),
            ...(opts.processItem ? { processItem: true } : {}),
            ...(opts.fromChatPanel ? { fromChatPanel: opts.fromChatPanel } : {}),
            ...(opts.reloadPrompt ? { reloadPrompt: { windowId: opts.reloadPrompt.windowId } } : {}),
            ...(opts.pauseAfter ? { pauseAfter: true } : {}),
            ...(opts.doneNotificationPrompt !== undefined && opts.doneNotificationPrompt !== '' ? { doneNotificationPrompt: opts.doneNotificationPrompt } : {}),
            ...(opts.doneNotificationDisabled ? { doneNotificationDisabled: true } : {}),
            ...(opts.queuedBy ? { queuedBy: { ...opts.queuedBy } } : {}),
            // This quest is the default: stored as unset.
            ...(opts.doneNotificationQuest && opts.doneNotificationQuest !== (WsPaths.getWorkspaceQuestId() || 'default') ? { doneNotificationQuest: opts.doneNotificationQuest } : {}),
            ...(opts.doneNotificationRun ? { doneNotificationRun: normalizeRun(opts.doneNotificationRun) } : {}),
            ...(opts.notificationOf ? { notificationOf: opts.notificationOf } : {}),
            ...(opts.from ? { from: opts.from } : {}),
            ...(opts.temporarySession ? { temporarySession: true } : {}),
        };

        const sessionRefusal = this.sessionRefusal(item);
        if (sessionRefusal) { throw new Error(sessionRefusal); }

        // A walk with nothing to walk over is held in error at once, with the
        // reason, instead of ending later without a single send.
        const emptyIteration = this.emptyIterationReason(item);
        if (emptyIteration) {
            item.status = 'error';
            item.error = emptyIteration;
            logQueue(`Item ${item.id} held in error: ${emptyIteration}`);
        }

        logQueue(`Item enqueued: id=${item.id}, type=${item.type}, status=${item.status}, text=${promptPreview(item.originalText)}`);

        // An item of a running Proceed goes before that run's process-move
        // marker, so the process moves on only once it is done too.
        const pos = opts.position ?? (item.processMove ? -1 : markerInsertIndex(this._items, item.processRun));
        if (pos >= 0 && pos < this._items.length) {
            this._items.splice(pos, 0, item);
        } else {
            this._items.push(item);
        }

        this.persist();
        // @TOM INFO › NOTIFICATIONS (vscimpb124): every path that queues an item comes through here.
        emitNotifications([queueItemDraft('itemQueued', item)]);
        this._onDidChange.fire();

        if (emptyIteration) {
            // Its done-notification (if any) reports the error, as for any item that cannot run.
            await this._itemFinished(item, { kind: 'error', message: emptyIteration });
            return item;
        }

        // If nothing is sending and auto-send is on, kick off unless explicitly deferred
        if (!opts.deferSend && this._autoSendFor(item) && this._mayDrain()) {
            await this.sendNext();
        }

        return item;
    }

    /**
     * "Queue next" (the @CHAT ANTHROPIC panel): the item is queued pending
     * where it is sent next (nextQueuePosition) — directly under the item that
     * is sending — and, when that item is a repeating loop, marked to go
     * between its iterations (as Send next does in the queue editor). The
     * other options are enqueue's; `position` and `initialStatus` are set here.
     */
    async enqueueNext(opts: Parameters<PromptQueueManager['enqueue']>[0]): Promise<QueuedPrompt> {
        const item = await this.enqueue({ ...opts, initialStatus: 'pending', position: nextQueuePosition(this._items) });
        if (item.status === 'pending' && runningLoopAbove(this._items, item.id)) {
            this.toggleSendBetween(item.id);
        }
        return item;
    }

    // ----- editing a pending item's text ------------------------------------

    /** Pending items whose text the user is editing: the queue holds before sending one. */
    private readonly _textEdits = new Set<string>();

    /**
     * The user opened the text of a staged or pending item for editing. While
     * it is open the item keeps its place, and when its turn comes the queue
     * waits (sendNext holds) until the edit is saved or cancelled
     * (endTextEdit). Answers false when the item cannot be edited.
     */
    beginTextEdit(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.canEditText(item.status)) { return false; }
        this._textEdits.add(id);
        logQueue(`Text edit opened on item ${id} (${item.status}): the queue waits for it`);
        return true;
    }

    /** Whether the text of `id` is open for editing. */
    isTextBeingEdited(id: string): boolean {
        return this._textEdits.has(id);
    }

    /**
     * The edit of `id` is saved (`text` given: the new text) or cancelled;
     * the queue goes on — if it was waiting for this item, it sends it now.
     * `id` undefined ends every open edit (the editor closed).
     */
    async endTextEdit(id: string | undefined, text?: string): Promise<void> {
        if (id !== undefined && text !== undefined) { await this.updateText(id, text); }
        const ended = id === undefined ? [...this._textEdits] : (this._textEdits.has(id) ? [id] : []);
        for (const e of ended) { this._textEdits.delete(e); }
        if (ended.length === 0) { return; }
        logQueue(`Text edit closed on ${ended.join(', ')}${text !== undefined ? ' (saved)' : ''}`);
        this._onDidChange.fire();
        if (this._anyRunMayStart() && this._mayDrain()) {
            // Not awaited: the send runs until its turn ends, and the editor's Save must not wait for that.
            void this.sendNext();
        }
    }

    /** Remove an item by id. */
    remove(id: string): void {
        this._textEdits.delete(id);
        const removing = this._items.find(i => i.id === id);
        // A chat send still running in this window is stopped with its entry
        // (its send ends with an error and frees the chat send slot).
        if (removing?.status === CHAT_STATUS && abandonChatSend(id)) {
            logQueue(`Chat send ${id} stopped: its entry was removed`);
        }
        if (removing && (removing.status === 'sending' || removing.status === 'interrupted')) {
            this.releaseQuestTodoClaim(removing, `removed while ${removing.status}`);
        }
        const removingAutoSend = removing ? this._autoSendFor(removing) : false;
        const effect = computeRemovalEffect(this._items, id, removingAutoSend);
        this._items = effect.items;
        if (effect.removed) {
            logQueue(`Item removed: id=${effect.removed.id}, type=${effect.removed.type}, status=${effect.removed.status}`);
            emitNotifications([queueItemDraft('itemDeleted', effect.removed)]);
        }

        // Deleting the item that is currently sending must interrupt it: abort
        // the in-flight dispatch (otherwise the handler keeps executing a prompt
        // that no longer exists in the queue, and the stop button can't reach it
        // because the sending item is gone) and drop auto-send to OFF so the
        // queue doesn't immediately fire the next pending prompt.
        if (effect.wasSending) {
            this._cancelActiveDispatch(removing);
            if (removingAutoSend && !effect.nextAutoSendEnabled) {
                this._pauseRunOf(removing, `its sending item ${id} was deleted`);
            }
        }

        this.persist();
        this._onDidChange.fire();
    }

    /**
     * Remove a deleted run's queue (vscimpb86): `all` deletes every item of the
     * run — a sending one is stopped, as {@link remove} stops it — and the run's
     * queue settings (`runs.<run>`), so a run created again under that name
     * starts from the defaults; `finished` deletes only its sent and failed
     * items, and the settings too when nothing is left. `default` and the
     * quest's live runs are the caller's to refuse (utils/runQueueRemoval.ts).
     */
    removeRunQueue(run: string, mode: RunQueueRemovalMode = 'all'): { removed: number; kept: number; settingsRemoved: boolean } {
        const plan = runQueueRemovalPlan(this._items, run);
        const ids = mode === 'all' ? [...plan.finished, ...plan.open] : plan.finished;
        for (const id of ids) { this.remove(id); }
        const kept = this._items.filter((i) => itemRun(i) === run).length;
        let settingsRemoved = false;
        if (kept === 0 && run !== DEFAULT_RUN && this._runSettings.has(run)) {
            this._dropRunSettings(run);
            const timer = this._autoContinueTimers.get(run);
            if (timer) { clearTimeout(timer); this._autoContinueTimers.delete(run); }
            this.persistSettings();
            settingsRemoved = true;
        }
        logQueue(`Run queue removed: run=${run}, mode=${mode}, removed=${ids.length}, kept=${kept}${settingsRemoved ? ', settings removed' : ''}`);
        this._onDidChange.fire();
        return { removed: ids.length, kept, settingsRemoved };
    }

    /**
     * Move item up (index - 1), down (index + 1), or to the front of the pending
     * queue (`'front'`).
     *
     * `'front'` only applies to pending items: it relocates the item to the index
     * of the first *other* pending item, so it becomes the next one `sendNext()`
     * will dispatch (sendNext picks the first item with status === 'pending').
     */
    move(id: string, direction: 'up' | 'down' | 'front'): void {
        const idx = this._items.findIndex(i => i.id === id);
        if (idx < 0) { return; }

        if (direction === 'front') {
            const item = this._items[idx];
            if (item.status !== 'pending') { return; }
            const firstPendingIdx = this._items.findIndex(i => i.status === 'pending' && i.id !== id);
            if (firstPendingIdx < 0 || firstPendingIdx >= idx) { return; }
            this._items.splice(idx, 1);
            this._items.splice(firstPendingIdx, 0, item);
            this.persist();
            this._onDidChange.fire();
            return;
        }

        // One place as the editor shows it: past the nearest item of the same status (queueMove.ts),
        // not the array neighbour — often a sent item, so the swap changed nothing visible.
        const swap = queueMoveTarget(this._items, idx, direction);
        if (swap < 0) { return; }
        [this._items[idx], this._items[swap]] = [this._items[swap], this._items[idx]];
        this.persist();
        this._onDidChange.fire();
    }

    /** Update the original text of a queued item and re-expand. */
    private isEditableStatus(status: QueuedPromptStatus): boolean {
        return status === 'staged';
    }

    /**
     * May the item's session change: staged or pending. Unlike the other
     * edits, the session changes nothing already built into the item (text,
     * expansion, repetitions) — the run loop reads it when the item is
     * dispatched — so a pending item can change it until it starts sending.
     */
    private canChangeSession(status: QueuedPromptStatus): boolean {
        return status === 'staged' || status === 'pending';
    }

    /**
     * May the item's text change: staged or pending. A pending item has not
     * been dispatched, so its expansion is simply built again; the queue waits
     * for an open edit (beginTextEdit).
     */
    private canEditText(status: QueuedPromptStatus): boolean {
        return status === 'staged' || status === 'pending';
    }

    async updateText(id: string, newText: string): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.canEditText(item.status)) { return; }
        item.originalText = newText;
        // Pass the item's effective transport so template lookup hits
        // the right store (spec §4.16). Falls back to the queue default
        // when the item has no explicit transport set.
        item.expandedText = await this._buildExpandedText(newText, this._templateOf(item.template, item), {
            repeatCount: resolveRepeatCount(item.repeatCount),
            repeatIndex: item.repeatIndex,
            repeatPrefix: item.repeatPrefix,
            repeatSuffix: item.repeatSuffix,
        }, {
            templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
            templateRepeatIndex: item.templateRepeatIndex,
        });
        this.persist();
        this._onDidChange.fire();
    }

    async updateItemTemplate(id: string, patch: { template?: string }): Promise<boolean> {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableStatus(item.status)) { return false; }

        let changed = false;
        if (patch.template !== undefined) {
            item.template = isRunDefaultChoice(patch.template) ? RUN_DEFAULT_TEMPLATE : (patch.template || '(None)');
            changed = true;
        }

        if (!changed) { return false; }

        item.expandedText = await this._buildExpandedText(item.originalText, this._templateOf(item.template, item), {
            repeatCount: resolveRepeatCount(item.repeatCount),
            repeatIndex: item.repeatIndex,
            repeatPrefix: item.repeatPrefix,
            repeatSuffix: item.repeatSuffix,
        }, {
            templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
            templateRepeatIndex: item.templateRepeatIndex,
        });
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Patch the queued item's transport + anthropic target ids. Editable
     * only while the item is in an editable status — once sending has
     * started the dispatcher has already resolved the transport and a
     * mid-flight change would desync the stage state.
     */
    updateItemTransport(id: string, patch: {
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }
        if (!this.isEditableStatus(item.status)) { return; }
        // `'key' in patch` lets us differentiate "field omitted" (no
        // change) from "field present but undefined" (clear the
        // override — semantic used by the queue editor's Inherit
        // option at stage + item level).
        if ('transport' in patch) {
            item.transport = patch.transport;
        }
        if ('anthropicProfileId' in patch) {
            item.anthropicProfileId = patch.anthropicProfileId || undefined;
        }
        if ('anthropicConfigId' in patch) {
            item.anthropicConfigId = patch.anthropicConfigId || undefined;
        }
        this.persist();
        this._onDidChange.fire();
    }

    /**
     * Adopt the queue-level default transport + Anthropic profile (the
     * selection shown in the dropdowns above the queue) onto a single item.
     *
     * Unlike {@link updateItemTransport}, this is intentionally allowed for an
     * item in ANY status — including a currently sending/repeating item.
     * Only the transport and Anthropic profile/config are changed; the item's
     * status, repetition counters, template and text are left intact. For a
     * repeating item the in-flight dispatch has already resolved its
     * transport, so the change takes effect on the next repetition, whose
     * {@link resolveStageTransport} then reads the freshly-adopted values.
     */
    applyQueueDefaultsToItem(id: string): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }
        const runDefaults = this._itemSettings(item);
        applyQueueDefaultTransportToItem(item, {
            transport: runDefaults.defaultTransport,
            anthropicProfileId: runDefaults.defaultAnthropicProfileId,
            anthropicConfigId: runDefaults.defaultAnthropicConfigId,
        });
        this.persist();
        this._onDidChange.fire();
    }

    /**
     * Put run `run`'s current defaults onto every item of its queue (the queue
     * editor's *Apply run defaults to all items*): for each of `fields` —
     * profile, template, session, role — `set` writes the run's default onto
     * the item, `clear` removes the item's own setting so it follows the run's
     * default (the template: none). Only staged and pending items change;
     * process-move markers and chat sends are not queue items of that kind
     * and are passed over, items that already started are counted. An item
     * whose session its profile cannot continue keeps its session. Items whose
     * template or transport changed get their text built again.
     */
    async applyRunDefaultsToItems(run: string | undefined, fields: readonly RunDefaultField[], mode: RunDefaultsMode): Promise<RunDefaultsApplyResult> {
        const r = normalizeRun(run);
        const picked = runDefaultFieldsOf(fields);
        const result: RunDefaultsApplyResult = { run: r, mode, fields: picked, changed: 0, unchanged: 0, notEditable: 0, refused: [] };
        if (!picked.length) { return result; }
        const defaults = this._settingsOf(r);
        const rebuild: QueuedPrompt[] = [];
        for (const item of this._items) {
            if (!this._inRun(item, r) || item.processMove || isChatStatus(item.status)) { continue; }
            if (!this.canChangeSession(item.status)) { result.notEditable++; continue; }
            const before = {
                transport: item.transport, anthropicProfileId: item.anthropicProfileId, anthropicConfigId: item.anthropicConfigId,
                template: item.template, session: item.session, sessionCreate: item.sessionCreate, role: item.role,
            };
            const changed = applyRunDefaultsToItem(item, defaults, r, picked, mode);
            if (!changed.length) { result.unchanged++; continue; }
            if (changed.includes('session') || changed.includes('profile')) {
                // A session its profile cannot continue (utils sessionTransportMismatch): the item stays as it was.
                const refusal = this.sessionRefusal(item);
                if (refusal) {
                    Object.assign(item, before);
                    for (const key of Object.keys(before) as Array<keyof typeof before>) {
                        if (before[key] === undefined) { delete item[key]; }
                    }
                    result.refused.push({ id: item.id, reason: refusal });
                    continue;
                }
            }
            result.changed++;
            if (changed.includes('template') || before.transport !== item.transport) { rebuild.push(item); }
        }
        for (const item of rebuild) {
            item.expandedText = await this._buildExpandedText(item.originalText, this._templateOf(item.template, item), {
                repeatCount: resolveRepeatCount(item.repeatCount),
                repeatIndex: item.repeatIndex,
                repeatPrefix: item.repeatPrefix,
                repeatSuffix: item.repeatSuffix,
            }, {
                templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
                templateRepeatIndex: item.templateRepeatIndex,
            });
        }
        if (result.changed) {
            logQueue(`Run defaults applied to run ${r}: ${mode} ${picked.join(', ')} on ${result.changed} item(s)`);
            this.persist();
            this._onDidChange.fire();
        }
        return result;
    }

    /**
     * Toggle "pause after this" on an item: it runs to the end of its repeat
     * loop, then the queue stops instead of starting the next item.
     *
     * Settable in **every** status — the point of the flag is that the user
     * can arm it on the item that is already sending, once they notice they
     * want to stop after it. Returns the flag's new value, or `undefined`
     * when the id is unknown.
     */
    /**
     * Mark or unmark a pending item to be sent between two iterations of the
     * running loop directly above it (queueSendBetween.ts); marking it clears
     * any other mark. Returns its new value, or `undefined` when the id is
     * unknown or the item is not under a running loop.
     */
    /** The items of `item`'s lane (its run), in queue order. */
    private _laneItemsOf(item: QueuedPrompt): QueuedPrompt[] {
        return this._items.filter(i => i === item || laneOf(i, true) === laneOf(item, true));
    }

    /** Why "Let the next item go first" is not offered on item `id` now (undefined when it is; vscimpb60e). */
    letNextGoFirstUnavailable(id: string): string | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item) { return `Queue item ${id} not found`; }
        if (item.yieldAfterIteration) { return undefined; }
        return yieldUnavailableReason(this._laneItemsOf(item), item);
    }

    /**
     * "Let the next item go first" (src/utils/queueYield.ts): a pending
     * iteration item moves at once behind the next pending item of its lane
     * (`moved`); a sending one is armed and yields after its running
     * iteration (`armed`); pressed again while armed, it is cancelled
     * (`cancelled`). Refused (`{ok: false, reason}`) without a following
     * pending item in its lane, or on an item that does not iterate.
     */
    letNextGoFirst(id: string): { ok: true; mode: 'moved' | 'armed' | 'cancelled'; behind?: string } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item) { return { ok: false, reason: `Queue item ${id} not found` }; }
        if (item.yieldAfterIteration) {
            item.yieldAfterIteration = undefined;
            logQueue(`Let the next item go first: cancelled on ${id}`);
            this.persist();
            this._onDidChange.fire();
            return { ok: true, mode: 'cancelled' };
        }
        const lane = this._laneItemsOf(item);
        const reason = yieldUnavailableReason(lane, item);
        if (reason) { return { ok: false, reason }; }
        const target = yieldTarget(lane, item)!;
        if (item.status === 'pending') {
            this._items = orderForYield(this._items, item, target);
            logQueue(`Let the next item go first: pending ${id} moved behind ${target.id}`);
            this.persist();
            this._onDidChange.fire();
            return { ok: true, mode: 'moved', behind: target.id };
        }
        item.yieldAfterIteration = true;
        logQueue(`Let the next item go first: ${id} yields to ${target.id} after its running iteration`);
        this.persist();
        this._onDidChange.fire();
        return { ok: true, mode: 'armed', behind: target.id };
    }

    toggleSendBetween(id: string): boolean | undefined {
        const changed = toggleSendBetween(this._items, id);
        if (changed.length === 0) { return undefined; }
        this.persist();
        this._onDidChange.fire();
        const item = this._items.find(i => i.id === id);
        logQueue(`Send-between ${item?.sendBetween ? 'set' : 'cleared'} on item ${id}`);
        return !!item?.sendBetween;
    }

    /**
     * Give an item the answers of its repetitions read back from the trail
     * (repetitionAnswersFromTrail: a walk that ran before answers were kept).
     * Only an item that has none; answers already kept are never replaced.
     */
    backfillRepetitionAnswers(id: string, answers: RepetitionAnswer[]): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || item.repetitionAnswers?.length || answers.length === 0) { return false; }
        item.repetitionAnswers = answers;
        this.persist();
        this._onDidChange.fire();
        logQueue(`Repetition answers of item ${id} read back from the trail: ${answers.length}`);
        return true;
    }

    setPauseAfter(id: string, pauseAfter: boolean): boolean | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item) { return undefined; }
        item.pauseAfter = pauseAfter || undefined;
        this.persist();
        this._onDidChange.fire();
        logQueue(`Pause-after ${pauseAfter ? 'set' : 'cleared'} on item ${id}`);
        return !!item.pauseAfter;
    }

    /**
     * Patch the main item's repetition fields. Editable while the
     * item is in an editable status (staged or pending).
     */
    updateItemRepetition(id: string, patch: {
        repeatCount?: number | string;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        /** The background-wait limit in minutes; a negative number clears it (the profile's applies). */
        backgroundWaitLimitMinutes?: number;
        /** Continuations a walk iteration gets; a negative number clears it (the queue's applies). */
        walkContinuations?: number;
    }): boolean {
        assertValidRepeatCount(patch.repeatCount);
        assertValidRepeatCount(patch.templateRepeatCount);
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableItem(item)) { return false; }
        if (patch.repeatCount !== undefined) {
            item.repeatCount = patch.repeatCount;
            item.resolvedRepeatCount = undefined;
        }
        if (patch.repeatPrefix !== undefined) { item.repeatPrefix = patch.repeatPrefix || undefined; }
        if (patch.repeatSuffix !== undefined) { item.repeatSuffix = patch.repeatSuffix || undefined; }
        if (patch.templateRepeatCount !== undefined) { item.templateRepeatCount = patch.templateRepeatCount; }
        if (patch.backgroundWaitLimitMinutes !== undefined) {
            item.backgroundWaitLimitMinutes = validLimit(patch.backgroundWaitLimitMinutes);
        }
        if (patch.walkContinuations !== undefined) {
            item.walkContinuations = validContinuations(patch.walkContinuations);
        }
        this.recheckEmptyIteration(item);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    getById(id: string): QueuedPrompt | undefined {
        return this._items.find(i => i.id === id);
    }

    /**
     * A GROUP item's members — or a `<prefix>*` walk's todos — with their
     * markers (utils/groupItemSelection.ts, vscimpb129): → the todo being sent,
     * ✓ those it sent, a checkbox for the others. Read from the todo files each
     * time, so a todo added, renumbered, cancelled or archived shows at once.
     * Undefined for an item that walks no group or prefix.
     */
    groupMembers(id: string): GroupMemberView[] | undefined {
        const item = this.getById(id);
        const walk = item ? parseTodoWalk(item.repeatCount) : undefined;
        if (!item || !walk || walk.kind === 'todo') { return undefined; }
        const questId = this.activeQuestId() ?? (walk.kind === 'group' ? walk.quest : undefined);
        if (!questId) { return undefined; }
        const sent = walkableRepeatIds(item);
        const sendingId = item.status === 'sending' && item.todoClaim && !item.todoClaim.released ? item.todoClaim.todoId : undefined;
        if (sendingId) { sent.delete(sendingId); }
        return groupItemMembers({ walk, todos: readQuestTodoEntries(questId), selection: item.groupSelection, sent, sendingId });
    }

    /**
     * Change a GROUP item's selection: check or uncheck one member, check all
     * (`all`), back to the rules (`rules`), or check exactly `checked`. Only
     * while the item is staged, pending or sending (or held for a walk with
     * nothing to send); a member already sent or
     * being sent keeps its marker. False when refused.
     */
    setGroupSelection(id: string, change: { member: string; checked: boolean } | { all: true } | { rules: true } | { checked: readonly string[] }): boolean {
        const item = this.getById(id);
        // An item held because its walk had nothing to send may change too: checking a member gives it work.
        if (!item || !(['staged', 'pending', 'sending'].includes(item.status) || this.isEmptyIterationItem(item))) { return false; }
        const members = this.groupMembers(id);
        if (!members) { return false; }
        const open = members.filter((m) => m.marker === 'todo').map((m) => m.id);
        let next: GroupSelection | undefined;
        if ('member' in change) {
            if (!open.includes(change.member)) { return false; }
            next = withMemberChoice(item.groupSelection, change.member, change.checked);
        } else if ('all' in change) {
            next = selectionOf(open, open);
        } else if ('rules' in change) {
            next = undefined;
        } else {
            const unknown = change.checked.filter((m) => !members.some((x) => x.id === m));
            if (unknown.length) { return false; }
            next = selectionOf(open, change.checked);
        }
        item.groupSelection = next && (next.checked.length || next.unchecked.length) ? next : undefined;
        this.recheckEmptyIteration(item);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Why stages of an item would fail before they are sent: each stage that
     * resolves to an Anthropic profile on the direct API whose key variable is
     * not in this VS Code's environment. One line per distinct cause, naming
     * the stages it affects; [] when every stage can be sent (or the item is
     * unknown). Asked by the queue tools and the queue editor, so a missing
     * key is said when the item is queued, not after hours of retries.
     */
    missingApiKeyWarnings(id: string, env: Record<string, string | undefined> = process.env): string[] {
        const item = this.getById(id);
        if (!item) { return []; }
        const section = loadSendToChatConfig()?.anthropic;
        const stages: Array<{ label: string; stage?: QueuedPrePrompt | QueuedFollowUpPrompt }> = [
            { label: 'the main prompt' },
            ...(item.prePrompts ?? []).map((stage, i) => ({ label: `pre-prompt ${i + 1}`, stage })),
            ...(item.followUps ?? []).map((stage, i) => ({ label: `follow-up ${i + 1}`, stage })),
        ];
        const byMessage = new Map<string, string[]>();
        for (const { label, stage } of stages) {
            const resolved = this.resolveStageTransport(item, stage);
            if (resolved.transport !== 'anthropic') { continue; }
            const missing = missingDirectApiKey(section, { profileId: resolved.anthropicProfileId, configId: resolved.anthropicConfigId }, env);
            if (!missing) { continue; }
            const message = missingApiKeyMessage(missing);
            byMessage.set(message, [...(byMessage.get(message) ?? []), label]);
        }
        return [...byMessage].map(([message, labels]) => `${labels.join(', ')}: ${message}`);
    }


    addFollowUpPrompt(itemId: string, followUp: {
        originalText: string;
        template?: string;
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): QueuedFollowUpPrompt | undefined {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return undefined; }
        const text = (followUp.originalText || '').trim();
        if (!text) { return undefined; }
        const entry: QueuedFollowUpPrompt = {
            id: randomUUID(),
            originalText: text,
            template: followUp.template,
            createdAt: new Date().toISOString(),
            transport: followUp.transport,
            anthropicProfileId: followUp.anthropicProfileId,
            anthropicConfigId: followUp.anthropicConfigId,
        };
        if (!item.followUps) { item.followUps = []; }
        item.followUps.push(entry);
        this.persist();
        this._onDidChange.fire();
        return entry;
    }

    addEmptyFollowUpPrompt(itemId: string): QueuedFollowUpPrompt | undefined {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return undefined; }
        const entry: QueuedFollowUpPrompt = {
            id: randomUUID(),
            originalText: '',
            template: undefined,
            createdAt: new Date().toISOString(),
        };
        if (!item.followUps) { item.followUps = []; }
        item.followUps.push(entry);
        this.persist();
        this._onDidChange.fire();
        return entry;
    }

    updateFollowUpPrompt(itemId: string, followUpId: string, patch: {
        originalText?: string;
        template?: string;
        repeatCount?: number | string;
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): boolean {
        assertValidRepeatCount(patch.repeatCount);
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item?.followUps) { return false; }
        const follow = item.followUps.find(f => f.id === followUpId);
        if (!follow) { return false; }
        if (typeof patch.originalText === 'string') {
            follow.originalText = patch.originalText;
        }
        if (patch.template !== undefined) {
            follow.template = patch.template || undefined;
        }
        if (patch.repeatCount !== undefined) {
            follow.repeatCount = patch.repeatCount;
            follow.resolvedRepeatCount = undefined;
        }
        // `'key' in patch` → differentiate "no change" from "clear".
        if ('transport' in patch) { follow.transport = patch.transport; }
        if ('anthropicProfileId' in patch) { follow.anthropicProfileId = patch.anthropicProfileId || undefined; }
        if ('anthropicConfigId' in patch) { follow.anthropicConfigId = patch.anthropicConfigId || undefined; }
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    removeFollowUpPrompt(itemId: string, followUpId: string): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item?.followUps) { return false; }
        const before = item.followUps.length;
        item.followUps = item.followUps.filter(f => f.id !== followUpId);
        const removed = item.followUps.length !== before;
        if (removed) {
            this.persist();
            this._onDidChange.fire();
        }
        return removed;
    }

    // ----- pre-prompt management ---------------------------------------------

    /** Add a pre-prompt to a queue item. */
    addPrePrompt(itemId: string, text: string, template?: string, opts?: {
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableItem(item)) { return false; }
        if (!item.prePrompts) { item.prePrompts = []; }
        item.prePrompts.push({
            text,
            template,
            status: 'pending',
            transport: opts?.transport,
            anthropicProfileId: opts?.anthropicProfileId,
            anthropicConfigId: opts?.anthropicConfigId,
        });
        this.recheckEmptyIteration(item);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** Update a pre-prompt by index. */
    updatePrePrompt(itemId: string, index: number, patch: {
        text?: string;
        template?: string;
        repeatCount?: number | string;
        transport?: QueuedTransport;
        anthropicProfileId?: string;
        anthropicConfigId?: string;
    }): boolean {
        assertValidRepeatCount(patch.repeatCount);
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableItem(item)) { return false; }
        if (!item.prePrompts || index < 0 || index >= item.prePrompts.length) { return false; }
        const pp = item.prePrompts[index];
        if (patch.text !== undefined) pp.text = patch.text;
        if (patch.template !== undefined) pp.template = patch.template || undefined;
        if (patch.repeatCount !== undefined) {
            pp.repeatCount = patch.repeatCount;
            pp.resolvedRepeatCount = undefined;
        }
        // `'key' in patch` → differentiate "no change" from "clear".
        if ('transport' in patch) { pp.transport = patch.transport; }
        if ('anthropicProfileId' in patch) { pp.anthropicProfileId = patch.anthropicProfileId || undefined; }
        if ('anthropicConfigId' in patch) { pp.anthropicConfigId = patch.anthropicConfigId || undefined; }
        this.recheckEmptyIteration(item);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** Remove a pre-prompt by index. */
    removePrePrompt(itemId: string, index: number): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableItem(item)) { return false; }
        if (!item.prePrompts || index < 0 || index >= item.prePrompts.length) { return false; }
        item.prePrompts.splice(index, 1);
        this.recheckEmptyIteration(item);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Send a specific item immediately (skip queue order). A `sent` item is
     * started again from its first prompt: the whole item runs once more —
     * every repetition or `prefix*` todo and every follow-up. With auto-send
     * off it holds after its first prompt like any other item.
     */
    async sendNow(id: string): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item || !canSendNow(item.status)) { return; }
        if (item.status === 'sent') {
            logQueue(`Send Now on sent item ${id}: starting it again from its first prompt`);
            resetItemRunState(item);
            // Its template iteration already queued the next one when it
            // first finished; a repeat run must not queue it twice.
            this._repeatRuns.add(id);
        }
        await this.sendItem(item);
    }

    /**
     * The Status Page's *Send prompt after reload* (vscimpb109): `text` becomes
     * an item of `run` (default: the window's current run) with that run's
     * defaults, inserted at the front of the queue (position 0), and is sent as
     * Continue / Send Now send it — also while the run is paused, without
     * switching its auto-send on. An unsent reload item this window queued
     * before is replaced; another window's stays (several windows of a quest
     * may each queue one). When the run's lane is busy (an item of it runs a
     * stage) it is sent as soon as none does — a sending item held at the pause
     * gate does not count. Answers the item.
     */
    async queueReloadPrompt(text: string, opts: { run?: string; windowId?: string } = {}): Promise<QueuedPrompt | undefined> {
        const prompt = text.trim();
        if (!prompt) { return undefined; }
        const windowId = opts.windowId ?? getWindowStatusWindowId();
        const run = normalizeRun(opts.run ?? windowProcessRun());
        for (const old of this._items.filter((i) => i.reloadPrompt?.windowId === windowId && itemRun(i) === run && (i.status === 'staged' || i.status === 'pending'))) {
            logQueue(`Reload prompt: replacing the unsent reload item ${old.id} of an earlier reload`);
            this.remove(old.id);
        }
        const item = await this.enqueue({
            originalText: prompt,
            run,
            runIsExplicit: true,
            position: 0,
            initialStatus: 'pending',
            deferSend: true,
            reloadPrompt: { windowId },
        });
        logQueue(`Reload prompt: queued item ${item.id} at the front of run ${run}`);
        this._sendReloadPromptWhenFree(item.id, run);
        return item;
    }

    /** Whether an item of `run` runs a stage now (a sending item held at the pause gate does not). */
    runLaneBusy(run: string | undefined): boolean {
        const name = normalizeRun(run);
        return this._items.some((i) => itemRun(i) === name && i.status === 'sending' && !this._isPausedAtGate(i));
    }

    /** Send the reload item now, or once its run's lane is free. */
    private _sendReloadPromptWhenFree(id: string, run: string): void {
        const trySend = (): boolean => {
            const item = this._items.find((i) => i.id === id);
            if (!item || item.status !== 'pending') { return true; }
            if (this.runLaneBusy(run)) { return false; }
            logQueue(`Reload prompt: sending item ${id} (as Continue: the run's auto-send is ${this._settingsOf(run).autoSend ? 'on' : 'off'})`);
            void this.sendNow(id);
            return true;
        };
        if (trySend()) { return; }
        logQueue(`Reload prompt: run ${run} is busy — item ${id} is sent once its running stage has ended`);
        const sub = this._onDidChange.event(() => { if (trySend()) { sub.dispose(); } });
    }

    /**
     * Abort waiting for the current sending item and continue queue progression.
     * This behaves like receiving an answer for progression purposes:
     * - send next pre/main/follow-up stage if one exists,
     * - otherwise mark sent, enqueue repeat (if configured), and send next pending item.
     */
    async continueSending(id?: string): Promise<boolean> {
        const sending = id
            ? this._items.find(i => i.id === id && i.status === 'sending')
            : this._items.find(i => i.status === 'sending');
        if (!sending) {
            return false;
        }
        if (id && sending.id !== id) {
            return false;
        }

        logQueue(`Manual continue requested for sending item ${sending.id}`);

        // Cancel any in-flight Anthropic dispatch for this item before advancing.
        // Without this, the next stage/item is dispatched while the original handler
        // is still running, and the late answer triggers a duplicate send.
        // The CTS lifecycle guard in dispatchStage (`if (this._activeAnthropicCts === cts)`)
        // ensures the cancelled handler's `finally` will not clobber the freshly-set
        // CTS for the next stage's dispatch.
        // The advance is the item's frame from now on — claimed before the cancel, so the
        // cancelled frame, whenever its turn ends, finds the item taken over (vscimpb54).
        const frame = this._claimFrame(sending);
        this._cancelActiveDispatch(sending);
        // A question the turn waits in is closed with it, answered so (vscimpb55): the
        // user chose to skip it, and a question left open would block the next ask.
        if (AskUserRegistry.instance.cancelForQueueItem(sending.id, QUESTION_CLOSED_BY_SKIP)) {
            logQueue(`continueSending(${sending.id}): closed the question the turn waited in`);
        }

        // Baseline epoch *after* our own cancel: this advance frame now
        // owns the item. If a *further* explicit action (a second
        // Continue / Stop) bumps the epoch again while we await, stand
        // down rather than marking `error` — that later action owns the
        // item's next state.
        const epoch = this._epochOf(sending);
        try {
            return await this.advanceSendingItemWithoutAnswer(sending, 'manual-continue', frame);
        } catch (err) {
            if (dispatchWasSuperseded(epoch, this._epochOf(sending))) {
                logQueue(`continueSending(${sending.id}): superseded by a later explicit action — error suppressed`);
                return false;
            }
            this._markItemError(sending, err, `continueSending(${sending.id})`);
            return false;
        }
    }

    private async advanceSendingItemWithoutAnswer(sending: QueuedPrompt, reason: string, frame?: symbol): Promise<boolean> {
        // Capture the most-recent LLM answer as the completing stage's
        // answer. The user clicks Continue precisely when the model
        // produced an answer that the queue didn't auto-detect as final
        // (e.g. it stalled mid tool-loop). For Anthropic-transport
        // stages the handler tracks the latest assistant text; route it
        // onto the stage that was last dispatched so the captured answer
        // is persisted (and ${answer} placeholders resolve) before we
        // advance.
        await this._captureLastAnswerForSendingItem(sending, reason === 'manual-continue');

        const outcome = await this._runDispatchFrame(sending, frame);
        if (outcome === 'paused') {
            logQueue(`advanceSendingItemWithoutAnswer paused for ${sending.id} (${reason}): auto-send off, item kept in 'sending' for resume`);
            this.persist();
            this._onDidChange.fire();
            return true;
        }
        sending.status = 'sent';

        await this._afterItemDone(sending, reason);

        this.persist();
        this._onDidChange.fire();

        // Continue is a completion path like any other: driving the item over
        // the finish line by hand does not entitle the queue to start the next
        // one — a paused queue stays paused, and "pause after this" still bites.
        if (this._shouldAdvanceQueueAfter(sending)) {
            // Auto-Pause per run: the run whose lane has nothing left pauses; the other runs go on.
            const runSettings = this._itemSettings(sending);
            const pendingCount = this._items.filter(i => i.status === 'pending' && itemRun(i) === itemRun(sending)).length;
            if (shouldAutoPauseOnEmpty(runSettings.autoSend, pendingCount, runSettings.autoPause)) {
                this._pauseRunOf(sending, 'its lane is empty (Auto-Pause)');
            } else {
                await this.delaySendNext();
            }
        }

        logQueue(`Manual continue completed for ${sending.id} (${reason})`);
        return true;
    }

    /**
     * Record the LLM's most-recent answer onto the stage the item last
     * dispatched, so a manual continue treats the in-flight (aborted)
     * send as if it had completed normally with that answer.
     *
     * Only applies to Anthropic-transport stages: the handler tracks
     * `lastAssistantText` across the round loop, so even a send that
     * stalled mid tool-loop has the latest assistant text available.
     * Never clobbers a stage
     * that already has an `answerText` (the normal direct-completion
     * path already recorded the real answer).
     */
    private async _captureLastAnswerForSendingItem(sending: QueuedPrompt, byContinue = false): Promise<void> {
        const last = sending.lastDispatched;
        if (!last || last.transport !== 'anthropic') {
            return;
        }
        const container = resolveAnswerContainer(sending);
        if (!container || (container.answerText && container.answerText.length > 0)) {
            return;
        }
        try {
            const { AnthropicHandler } = await import('../handlers/anthropic-handler.js');
            const answer = AnthropicHandler.instance.lastAssistantText;
            if (answer && answer.length > 0) {
                // The turn's last text, marked: the stage did not finish, the user moved past it.
                const kept = byContinue ? `${answer}${CONTINUE_ANSWER_MARK}` : answer;
                container.answerText = kept;
                if (container === sending) { recordRepetitionAnswer(sending, kept, resolveRepeatCount); }
                logQueue(`Captured most-recent LLM answer (${answer.length} chars) for ${sending.id} stage=${last.kind}`);
            }
        } catch (err) {
            logQueue(`captureLastAnswer: failed to read last assistant text: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    setStatus(id: string, status: 'staged' | 'pending'): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item) { return false; }
        const fromStatus = item.status;
        // Allow interrupting a sending item back to staged — and abandoning an
        // interrupted (held-for-continuation) item the same way.
        if ((item.status === 'sending' || item.status === 'interrupted') && status === 'staged') {
            // Cancel any in-flight Anthropic dispatch for this item so
            // the handler stops executing even when setStatus is called
            // directly (e.g. from the queue editor's "set to staged"
            // action, not through stopActiveItem).
            this._cancelActiveDispatch(item);
            // Stopped before the answer: hand back a todo this dispatch claimed.
            this.releaseQuestTodoClaim(item, `stopped (${fromStatus} → staged)`);
            // A fresh restart: nothing of an interrupt for continuation carries over (vscimpb112).
            delete item.interruptNote;
            delete item.softInterrupt;
            this._dropHeldConversation(item);
            if (item.prePrompts && item.prePrompts.length > 0) {
                for (const pp of item.prePrompts) {
                    pp.status = 'pending';
                }
            }
            item.status = 'staged';
            item.followUpIndex = 0;
            // The cancelled dispatch is over, so its counter snapshot is spent.
            // Leaving it set would let a *later* failure (a Resend that fails,
            // say) roll back a repetition that was actually dispatched — see
            // the lifecycle contract on `InFlightRepetition`.
            item.inFlightRepetition = undefined;
            item.sentAt = undefined;
            item.error = undefined;
            logQueue(`Status changed: id=${item.id}, from=${fromStatus} → to=${item.status}`);
            this.persist();
            this._onDidChange.fire();
            return true;
        }
        // An item held for an empty walk goes back when its walk has work now.
        if (this.isEmptyIterationItem(item)) {
            const reason = this.emptyIterationReason(item);
            if (reason) {
                item.error = reason;
                this.persist();
                this._onDidChange.fire();
                return false;
            }
            item.error = undefined;
        } else if (item.status === 'error') {
            // Allow sent items to be re-staged, but not error items
            return false;
        }
        if (item.status === 'sending') { return false; }
        // `interrupted` -> `pending` would re-dispatch with the counter one ahead
        // and skip the interrupted rep; its only exits are resume or staged.
        if (item.status === 'interrupted') { return false; }
        if (item.status === 'todo-blocked') { delete item.blockedOn; delete item.blockedTodo; }
        item.status = status;
        logQueue(`Status changed: id=${item.id}, from=${fromStatus} → to=${item.status}`);
        this.persist();
        this._onDidChange.fire();
        
        // If changed to pending and autoSend is on, try to send
        if (status === 'pending' && this._autoSendFor(item) && this._mayDrain()) {
            void this.sendNext();
        }
        return true;
    }

    /**
     * Set an item's status by hand (the queue editor's status label, utils/queueStatusChange.ts): an item in
     * `error`, `waiting` or `retry` goes back to `pending` or `staged` — its failure, wait and retry countdown
     * cleared — or is marked `sent` when its work was done; a running or held item is stopped first (as
     * Stop does: its dispatch cancelled, its todo claim handed back) and then takes the status chosen.
     * Answers why it is refused.
     */
    changeItemStatus(id: string, to: ManualQueueStatus): { ok: true } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item) { return { ok: false, reason: 'no such item' }; }
        if (!queueStatusChoices(item.status).some((c) => c.status === to)) {
            return { ok: false, reason: `an item that is ${item.status} cannot be set to ${to}` };
        }
        const fromStatus = item.status;
        if (ACTIVE_QUEUE_STATUSES.includes(item.status)) {
            // Stopped first, as Stop does; then the status chosen.
            if (item.status === 'sending' || item.status === 'interrupted') {
                this.setStatus(id, 'staged');
            } else {
                delete item.blockedOn;
                delete item.blockedTodo;
                item.status = 'staged';
            }
        }
        if (PARKED_QUEUE_STATUSES.includes(item.status)) {
            item.waitingUntil = undefined;
            item.waitingResetLabel = undefined;
            clearRetryBookkeeping(item);
            item.outOfBudget = undefined;
            item.warning = undefined;
            item.error = undefined;
            item.status = 'staged';
        }
        if (to === 'sent') {
            item.status = 'sent';
            item.sentAt = item.sentAt || new Date().toISOString();
            item.sendBetween = undefined;
            item.yieldAfterIteration = undefined;
            logQueue(`Status set by hand: id=${item.id}, from=${fromStatus} → to=${item.status}`);
            this.persist();
            this._onDidChange.fire();
            // Done by hand is a completion like any other: its lane goes on — unless the run is paused or the
            // item says "pause after this" (the one gate every completion asks).
            if (this._shouldAdvanceQueueAfter(item)) {
                void this.sendNext();
            }
            return { ok: true };
        }
        item.status = to;
        logQueue(`Status set by hand: id=${item.id}, from=${fromStatus} → to=${item.status}`);
        this.persist();
        this._onDidChange.fire();
        if (to === 'pending' && this._autoSendFor(item) && this._mayDrain()) {
            void this.sendNext();
        }
        return { ok: true };
    }

    /**
     * Move an item that is not sent (staged, pending, parked after a failure, running or held) to run `run`,
     * with session `session` (a name in that run, `''` for the run's queue default, undefined to keep its own
     * as that run's), at `place` in the run's lane (utils/queueStatusChange.ts laneInsertIndex): the end, the
     * top, or next — between the iterations of the run's iterating sending item. A running or held item is
     * stopped first and goes on as pending, a parked one as pending too. Refused for an item of a Proceed run
     * and a process-move marker (they belong to their run), and for a session the item's profile cannot
     * continue.
     */
    relocateItem(id: string, opts: { run: string; session?: string; place: LanePlace }): { ok: true; sendBetween: boolean } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item) { return { ok: false, reason: 'no such item' }; }
        if (!canRelocateQueueItem(item.status)) { return { ok: false, reason: `an item that is ${item.status} stays where it is` }; }
        if (item.processMove) { return { ok: false, reason: 'a process-move marker stays with its Proceed run' }; }
        const to = normalizeRun(opts.run);
        if (item.processRun && to !== itemRun(item)) { return { ok: false, reason: 'the item belongs to a Proceed run and runs as its process position' }; }
        const nextSession = opts.session === undefined
            ? (item.session ? runSessionName(sessionBaseName(item.session), to) : undefined)
            : (opts.session || undefined);
        const refusal = this.sessionRefusal({ ...item, session: nextSession, sessionCreate: undefined });
        if (refusal) { return { ok: false, reason: refusal }; }
        if (ACTIVE_QUEUE_STATUSES.includes(item.status) || PARKED_QUEUE_STATUSES.includes(item.status)) {
            const r = this.changeItemStatus(id, 'staged');
            if (!r.ok) { return r; }
            item.status = 'pending';
        }
        item.run = to;
        item.session = nextSession;
        item.sessionCreate = undefined;
        item.sendBetween = undefined;
        item.yieldAfterIteration = undefined;
        this._items.splice(this._items.indexOf(item), 1);
        const lane: LaneItem[] = this._items.map((i) => ({ id: i.id, status: i.status, run: itemRun(i), iterates: isLoopItem(i) }));
        const at = laneInsertIndex(lane, to, opts.place);
        this._items.splice(at, 0, item);
        let between = false;
        if (opts.place === 'next' && item.status === 'pending' && runningLoopAbove(this._items, item.id)) {
            between = toggleSendBetween(this._items, item.id).length > 0 && !!item.sendBetween;
        }
        logQueue(`Item ${item.id} moved by hand to run ${to}${item.session ? `, session ${item.session}` : ''}, ${opts.place}${between ? ' (between iterations)' : ''}`);
        this.persist();
        this._onDidChange.fire();
        if (item.status === 'pending' && this._autoSendFor(item) && this._mayDrain()) {
            void this.sendNext();
        }
        return { ok: true, sendBetween: between };
    }

    /**
     * Give every item of run `run` that is not sent yet and may change its session (staged, pending) session
     * `session` (`''`: the run's queue default). Answers how many changed and which could not (their profile
     * cannot continue it).
     */
    setSessionOfRunItems(run: string, session: string, exceptId?: string): { changed: number; refused: string[] } {
        const to = normalizeRun(run);
        let changed = 0;
        const refused: string[] = [];
        for (const item of this._items) {
            if (item.id === exceptId || itemRun(item) !== to || !this.canChangeSession(item.status)) { continue; }
            const next = session || undefined;
            if (this.sessionRefusal({ ...item, session: next, sessionCreate: undefined })) { refused.push(item.id); continue; }
            if (item.session === next) { continue; }
            item.session = next;
            item.sessionCreate = undefined;
            changed++;
        }
        if (changed) {
            this.persist();
            this._onDidChange.fire();
        }
        return { changed, refused };
    }

    /**
     * Cancel the in-flight Anthropic dispatch, if any.
     *
     * Cancels `_activeAnthropicCts` (idempotent — safe to call when
     * nothing is running or when already cancelled) and releases any
     * pending approval-bar awaiters.  The CTS is NOT cleared here;
     * it is disposed and unset by `dispatchStage`'s `finally` block
     * once the handler call returns.
     */
    private _cancelActiveDispatch(item?: QueuedPrompt): void {
        // Bump the dispatch epoch so any send-owning frame currently
        // awaiting a dispatch (sendItem / resume / resend / continue)
        // recognises that this cancellation was intentional and turns
        // its completion into a no-op rather than an `error` transition
        // or a duplicate queue advance. See `dispatchWasSuperseded`.
        // The item's dispatch (and one of no item); without an item, every dispatch.
        if (item) {
            this._itemEpochs.set(item.id, (this._itemEpochs.get(item.id) ?? 0) + 1);
            // A soft interrupt of its turn ends with it (a held result is let go as aborted, vscimpb112).
            SoftInterruptRegistry.instance.clear(item.id);
            // A wait its turn is in (tomAi_waitFor) ends with it.
            if (WaitForRegistry.instance.cancelForQueueItem(item.id)) {
                logQueue(`Item ${item.id}: its wait (tomAi_waitFor) was cancelled with the dispatch`);
            }
            this._waitInterrupted.delete(item.id);
        } else {
            this._globalEpoch++;
        }
        const keys = item ? [item.id, ''] : [...this._activeAnthropicCts.keys()];
        for (const key of keys) {
            const cts = this._activeAnthropicCts.get(key);
            if (!cts) { continue; }
            try {
                cts.cancel();
            } catch (err) {
                logQueue(`cancelActiveDispatch: CTS cancel failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // Release approval awaiters. Best-effort dynamic import so
        // the queue manager doesn't pull in the Anthropic SDK at
        // module load. If the import fails we fall through.
        void (async () => {
            try {
                const { AnthropicHandler } = await import('../handlers/anthropic-handler.js');
                // This item's approvals only: another run's turn keeps its open approval (vscimpb81).
                AnthropicHandler.instance.abortPendingApprovals(item ? (a) => a.queueItemId === item.id : undefined);
            } catch (err) {
                logQueue(`cancelActiveDispatch: abortPendingApprovals skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
    }

    /**
     * Stop whichever queue item is currently `sending` and revert it
     * to `staged`.
     *
     * Behaviour:
     *  - Uses `_activeAnthropicCts` as ground truth for whether an
     *    Anthropic dispatch is actually executing, independent of the
     *    item's status field.  If the CTS is set, the call is
     *    cancelled even when no item shows `status === 'sending'`
     *    (e.g. a status-race that left the item in a stale state
     *    while the handler is still mid-flight).
     *  - Releases any approval-bar awaiters via
     *    `AnthropicHandler.abortPendingApprovals()`.
     *  - Reverts the item to `staged` via `setStatus`, which clears
     *    `sentAt` and
     *    flips any `sent` pre-prompts back to `pending`.
     *
     * Returns `true` if a sending item was found and/or an active
     * dispatch was cancelled; `false` if there was nothing to stop.
     */
    stopActiveItem(id?: string, run?: string): boolean {
        // Without an id: the sending item (of `run`, when given — a tab of the queue editor).
        const sending = id
            ? this._items.find(i => i.id === id && i.status === 'sending')
            : this._items.find(i => i.status === 'sending' && this._inRun(i, run));
        const hasActiveCts = sending
            ? this._activeAnthropicCts.has(sending.id) || this._activeAnthropicCts.has('')
            : run === undefined && this._activeAnthropicCts.size > 0;

        if (!sending && !hasActiveCts) {
            // A held item of the run (todo-blocked) is stopped too: back to staged, so its todos can be rearranged
            // and the item restarted.
            const held = this._heldTodoBlockedItem(id, run);
            if (held) {
                logQueue(`stopActiveItem: ${held.id} was held at a blocked todo — back to staged`);
                return this.setStatus(held.id, 'staged');
            }
            logQueue('stopActiveItem: no sending item and no active dispatch to stop');
            return false;
        }

        // Cancel the in-flight Anthropic dispatch regardless of item
        // status — the CTS is the authoritative signal that the handler
        // is actually executing.
        this._cancelActiveDispatch(sending);
        if (sending && AskUserRegistry.instance.cancelForQueueItem(sending.id, QUESTION_CLOSED_BY_STOP)) {
            logQueue(`stopActiveItem(${sending.id}): closed the question the turn waited in`);
        }

        if (!sending) {
            // The handler was mid-flight but the item's status had
            // already drifted out of 'sending' (race / stale state).
            // Cancellation is done; nothing to revert status-wise.
            logQueue('stopActiveItem: cancelled active dispatch (item was no longer in sending state)');
            return true;
        }

        logQueue(`stopActiveItem: stopping ${sending.id}`);
        // Revert item to staged. setStatus handles the full reset
        // (pre-prompts → pending, requestId cleared,
        // persist + onDidChange + window status update).
        // It also calls _cancelActiveDispatch() again — harmless
        // because cancel on an already-cancelled token is a no-op.
        return this.setStatus(sending.id, 'staged');
    }

    /**
     * Interrupt the running item **for continuation** (vscimpb112). The first
     * press asks for a SOFT interrupt: the result of the turn's next tool call
     * is held (services/softInterrupt.ts), so the turn stays open without a
     * request in flight; the run's auto-send goes off. Re-arming auto-send (or
     * Resume) releases the result and the turn goes on — nothing is resent.
     * Nothing held within 15 s: a turn waiting in an ask* tool, tomAi_waitFor or
     * for its background work counts as held, any other gets the HARD interrupt. A second press while it still
     * waits for its hold point: it waits WITHOUT A LIMIT (no hard interrupt by the timer; a long tool call may
     * take many minutes before its result can be held). A third press — or a press once held, or `hard`, or
     * a turn that cannot hold: the hard interrupt now — the dispatch is cancelled, the item `interrupted`, and its resend
     * starts with RESEND_INTERRUPTED_NOTE in the conversation it ran in.
     * Between two stages (no turn running) the press only pauses the run.
     *
     * `id` narrows the action to one item (the per-row button); omitted, the
     * currently `sending` item of `run` is taken (the toolbar button). Returns
     * `true` when something was done.
     */
    interruptActiveItemForContinuation(id?: string, run?: string, opts?: { hard?: boolean }): boolean {
        const sending = id
            ? this._items.find(i => i.id === id && i.status === 'sending')
            : this._items.find(i => i.status === 'sending' && this._inRun(i, run));
        if (!sending) {
            // A held item (todo-blocked) has no turn to interrupt: it is stopped (back to staged), as Stop does.
            const held = this._heldTodoBlockedItem(id, run);
            if (held) {
                logQueue(`interruptActiveItemForContinuation: ${held.id} was held at a blocked todo — back to staged`);
                return this.setStatus(held.id, 'staged');
            }
            logQueue(`interruptActiveItemForContinuation: no sending item${id ? ` with id ${id}` : ''}`);
            return false;
        }
        const soft = SoftInterruptRegistry.instance.stateOf(sending.id);
        const requested = soft !== undefined;
        // Second press: still waiting for the hold point — wait for it without a limit instead of the hard interrupt.
        if (!opts?.hard && soft && soft.heldAt === undefined && !soft.unlimited && SoftInterruptRegistry.instance.waitWithoutLimit(sending.id)) {
            this.persist();
            this._onDidChange.fire();
            logQueue(`interruptActiveItemForContinuation: ${sending.id} waits for its hold point without a limit (second click)`);
            return true;
        }
        if (opts?.hard || requested) {
            this._hardInterrupt(sending, opts?.hard ? 'hard interrupt' : soft?.unlimited ? 'third click' : 'click while held');
            return true;
        }
        if (!this._activeAnthropicCts.has(sending.id)) {
            // Between two stages: nothing runs, so the press only pauses the run; the next stage goes out on resume.
            this._pauseRunOf(sending, `${sending.id} interrupted between two stages`);
            this.persist();
            this._onDidChange.fire();
            logQueue(`interruptActiveItemForContinuation: ${sending.id} runs no turn — run paused`);
            return true;
        }
        const pausedAutoSend = this._settingsOf(itemRun(sending)).autoSend;
        SoftInterruptRegistry.instance.request(sending.id, () => this._softInterruptTimedOut(sending.id), undefined, { pausedAutoSend });
        // A turn already waiting for the user, in tomAi_waitFor or for its background work counts as held.
        this._markHeldIfWaiting(sending);
        this._pauseRunOf(sending, `${sending.id} soft-interrupted for continuation`);
        this.persist();
        this._onDidChange.fire();
        logQueue(`interruptActiveItemForContinuation: ${sending.id} soft interrupt requested — its next tool result is held; hard interrupt in 15 s unless held`);
        return true;
    }

    /** The item held at a blocked todo: `id`'s, else the first of `run`. */
    private _heldTodoBlockedItem(id: string | undefined, run: string | undefined): QueuedPrompt | undefined {
        return id
            ? this._items.find((i) => i.id === id && i.status === 'todo-blocked')
            : this._items.find((i) => i.status === 'todo-blocked' && this._inRun(i, run));
    }

    /** The hard interrupt (vscimpb112): cancel the turn now; the item is `interrupted` and its run paused. */
    private _hardInterrupt(sending: QueuedPrompt, why: string): void {
        const soft = SoftInterruptRegistry.instance.stateOf(sending.id) ?? sending.softInterrupt;
        this._cancelActiveDispatch(sending);
        // Interrupted before the answer: hand the todo back. The resume replays
        // the same main prompt through Resend, which claims it again.
        this.releaseQuestTodoClaim(sending, 'interrupted for continuation');
        const result = applyInterruptForContinuation(sending);
        // The resend says the turn was interrupted, carries a result it held, and goes on in its conversation.
        sending.interruptNote = true;
        if (soft) { sending.softInterrupt = soft; } else { delete sending.softInterrupt; }
        this._dropHeldConversation(sending);
        SoftInterruptRegistry.instance.clear(sending.id);
        // Off, not merely paused: the pause gate only refuses the *next* rep,
        // and the point here is that nothing at all goes out of its run until re-armed.
        this._pauseRunOf(sending, `${sending.id} interrupted for continuation`);
        this.persist();
        this._onDidChange.fire();
        logQueue(`interruptActiveItemForContinuation: ${sending.id} hard-interrupted (${why}; ${result.canResend ? 'will resend its last dispatch with the interrupted note' : 'nothing dispatched yet — will restart as pending'}); auto-send off`);
    }

    /** No hold point within the wait: a turn waiting for the user, in tomAi_waitFor or for its background work counts as held, any other is hard-interrupted. */
    private _softInterruptTimedOut(id: string): void {
        const item = this._items.find(i => i.id === id && i.status === 'sending');
        if (!item) { SoftInterruptRegistry.instance.clear(id); return; }
        if (this._markHeldIfWaiting(item)) { return; }
        this._hardInterrupt(item, 'no tool result to hold within 15 s');
    }

    /**
     * Mark `item`'s soft interrupt held when its turn waits for the user (a
     * question), in tomAi_waitFor, or for its background work (the model has
     * ended its answer and the turn waits for its background tasks: no tool
     * result comes until one of them reports).
     */
    private _markHeldIfWaiting(item: QueuedPrompt): boolean {
        const question = AskUserRegistry.instance.pendingForQueueItem(item.id);
        if (question || this.waitingForUserOf(item.id).length > 0) {
            return SoftInterruptRegistry.instance.markHeld(item.id, 'question', question ? 'tomAi_askUser' : undefined);
        }
        if (item.waitingFor) {
            return SoftInterruptRegistry.instance.markHeld(item.id, 'wait', 'tomAi_waitFor');
        }
        if (item.backgroundWait) {
            return SoftInterruptRegistry.instance.markHeld(item.id, 'wait', BACKGROUND_WORK_HOLD);
        }
        return false;
    }

    /**
     * The soft interrupt of item `itemId` changed (registry): a sending item
     * records the state (and a direct API conversation held with it, saved for
     * a restart); an interrupted item keeps what it recorded for its resend.
     */
    private _onSoftInterruptChange(itemId: string): void {
        const item = this._items.find(i => i.id === itemId);
        if (!item || item.status !== 'sending') { this._onDidChange.fire(); return; }
        const state = SoftInterruptRegistry.instance.stateOf(itemId);
        if (state) {
            item.softInterrupt = state;
            const conversation = SoftInterruptRegistry.instance.extrasOf(itemId)?.conversation;
            if (conversation && state.heldAt !== undefined && !item.heldConversationFile) {
                item.heldConversationFile = this._saveHeldConversation(item, conversation);
            }
        } else {
            delete item.softInterrupt;
            this._dropHeldConversation(item);
        }
        this.persist();
        this._onDidChange.fire();
    }

    /** Write the conversation a soft interrupt held (direct API / Local LLM) beside the queue files; answers its path. */
    private _saveHeldConversation(item: QueuedPrompt, conversation: unknown): string | undefined {
        try {
            const folder = getQueueFolder();
            if (!folder) { return undefined; }
            const dir = path.join(folder, 'held');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${item.id}.conversation.json`);
            fs.writeFileSync(file, JSON.stringify(conversation));
            return file;
        } catch (err) {
            logQueue(`Item ${item.id}: the held conversation could not be saved: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }

    /** The held conversation of `item`, when it reads (a restart continues it). */
    private _readHeldConversation(item: QueuedPrompt): { transport: 'direct' | 'localLlm'; messages: unknown[] } | undefined {
        if (!item.heldConversationFile) { return undefined; }
        try {
            const c = JSON.parse(fs.readFileSync(item.heldConversationFile, 'utf8')) as { transport?: unknown; messages?: unknown };
            if ((c.transport === 'direct' || c.transport === 'localLlm') && Array.isArray(c.messages)) { return { transport: c.transport, messages: c.messages }; }
        } catch { /* gone or unreadable: the resend takes over */ }
        return undefined;
    }

    private _dropHeldConversation(item: QueuedPrompt): void {
        if (!item.heldConversationFile) { return; }
        try { fs.rmSync(item.heldConversationFile, { force: true }); } catch { /* best effort */ }
        delete item.heldConversationFile;
    }

    /**
     * The turn of a soft-interrupted item is gone (the SDK process ended, the
     * window reloaded): the item becomes `interrupted`, its run stays paused,
     * and its resume continues a saved conversation or resends with the note.
     */
    private _softTurnLost(item: QueuedPrompt, why: string): void {
        const soft = SoftInterruptRegistry.instance.stateOf(item.id) ?? item.softInterrupt;
        this.releaseQuestTodoClaim(item, 'interrupted for continuation');
        // Interrupted first: the registry's change then leaves the item's record (and its saved conversation) alone.
        applyInterruptForContinuation(item);
        item.interruptNote = true;
        if (soft) { item.softInterrupt = soft; }
        SoftInterruptRegistry.instance.clear(item.id);
        this._pauseRunOf(item, `${item.id}: its held turn was lost (${why})`);
        this.persist();
        this._onDidChange.fire();
        logQueue(`Item ${item.id}: its soft-interrupted turn was lost (${why}) — interrupted; resume ${item.heldConversationFile ? 'continues the saved conversation' : 'resends with the interrupted note'}`);
    }

    /**
     * Release the held items of `run`: their turns go on (vscimpb112). A soft
     * interrupt still waiting for its hold point is withdrawn. Answers whether
     * an item was released.
     */
    private _releaseHeldItems(run: string): boolean {
        let released = false;
        for (const item of this._items.filter((i) => i.status === 'sending' && itemRun(i) === run)) {
            if (SoftInterruptRegistry.instance.stateOf(item.id) === undefined) { continue; }
            SoftInterruptRegistry.instance.release(item.id);
            delete item.softInterrupt;
            this._dropHeldConversation(item);
            released = true;
            logQueue(`Item ${item.id}: released — its turn goes on where the soft interrupt held it`);
        }
        if (released) { this.persist(); this._onDidChange.fire(); }
        return released;
    }

    /**
     * Cancel item `id`'s interruption (the item's panel): a request still waiting for its hold point is
     * withdrawn, a held turn goes on; when the press switched the run's auto-send off it comes back on (as
     * Resume does), else it stays off. Answers whether there was one.
     */
    cancelSoftInterrupt(id: string): boolean {
        const item = this._items.find(i => i.id === id && i.status === 'sending');
        const state = SoftInterruptRegistry.instance.stateOf(id);
        if (!item || !state) { return false; }
        if (state.pausedAutoSend) { return this.resumeHeldItem(id); }
        SoftInterruptRegistry.instance.release(id);
        delete item.softInterrupt;
        this._dropHeldConversation(item);
        this.persist();
        this._onDidChange.fire();
        logQueue(`Item ${id}: interruption cancelled — its turn goes on; the run's auto-send stays off`);
        return true;
    }

    /** What item `id`'s soft interrupt is: requested (waiting for a hold point), held, or none. */
    softInterruptOf(id: string): SoftInterruptState | undefined {
        return SoftInterruptRegistry.instance.stateOf(id);
    }

    /**
     * Resume a soft-interrupted item (Continue's Resume, Telegram `continue`):
     * the run's auto-send comes back on, which releases the held result. A held
     * item whose turn cannot go on is hard-interrupted and resent with the note.
     * Answers whether the item was held.
     */
    resumeHeldItem(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending' || (!item.softInterrupt && !SoftInterruptRegistry.instance.stateOf(id))) { return false; }
        if (!SoftInterruptRegistry.instance.stateOf(id)) {
            // Recorded as held, but no turn holds it any more: resend with the note.
            this._hardInterrupt(item, 'the held turn cannot be resumed');
        }
        const run = itemRun(item);
        if (this._settingsOf(run).autoSend) {
            if (!this._releaseHeldItems(run)) { this._onRunResumed(run); }
        } else {
            this.setRunAutoSend(run, true);
        }
        return true;
    }

    /**
     * Replay the interrupted item of a run whose auto-send is on (or of `run`
     * only), if its lane sends nothing. Returns `true` when a resume was
     * started, so the caller stops draining.
     */
    private _resumeInterruptedItem(run?: string): boolean {
        const runs = run !== undefined ? [normalizeRun(run)]
            : [...new Set(this._items.filter((i) => i.status === 'interrupted' && this._autoSendFor(i)).map((i) => itemRun(i)))];
        for (const name of runs) {
            if (this._resumeInterruptedItemOfRun(name)) { return true; }
        }
        return false;
    }

    private _resumeInterruptedItemOfRun(run: string): boolean {
        const resume = pickInterruptedResume(this._items.filter((i) => itemRun(i) === run));
        if (!resume) { return false; }
        const item = this._items.find(i => i.id === resume.id);
        if (!item) { return false; }
        if (resume.action === 'resend') {
            logQueue(`Resuming interrupted item ${item.id}: resending its last dispatch`);
            void this.resendLastPrompt(item.id).catch(err => {
                this._markItemError(item, err, `_resumeInterruptedItem(${item.id})`, readInterruptionFromError(err));
            });
            return true;
        }
        // Nothing was dispatched before the interrupt — re-enter the backlog.
        // The fresh-vs-resume gate in `sendItem` keeps whatever cursor it has.
        logQueue(`Resuming interrupted item ${item.id}: nothing dispatched yet — restarting as pending`);
        item.status = 'pending';
        this.persist();
        this._onDidChange.fire();
        void this.sendNext();
        return true;
    }

    sendAllStaged(run?: string): number {
        const changed = convertStagedToPending(this._items.filter((i) => this._inRun(i, run)));
        if (changed === 0) { return 0; }

        this.persist();
        this._onDidChange.fire();
        logQueue(`Converted ${changed} staged items to pending`);

        if (this._anyRunMayStart() && this._mayDrain()) {
            void this.sendNext();
        }
        return changed;
    }

    updateRepeat(id: string, patch: { repeatCount?: number | string; repeatIndex?: number; repeatPrefix?: string; repeatSuffix?: string; templateRepeatCount?: number | string; templateRepeatIndex?: number }): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }

        // staged/pending → every field; sending/waiting → loop counters only
        // (so a running loop can be steered, applying next repetition); terminal
        // → frozen. computeRepeatEditability + applyRepeatEditToItem hold the
        // decision + field logic (pure, unit-tested in repeatEditability.test).
        const mode = computeRepeatEditability(item.status);
        if (mode === 'none') { return; }

        applyRepeatEditToItem(item, patch, mode);

        this.persist();
        this._onDidChange.fire();
    }

    /**
     * Explicitly send a queued prompt by queue item ID.
     * Only pending items are eligible.
     */
    async sendQueuedPrompt(target: { id?: string }): Promise<QueuedPrompt | undefined> {
        const item = target.id ? this._items.find(i => i.id === target.id) : undefined;
        if (!item || !(item.status === 'pending' || item.status === 'staged')) {
            return undefined;
        }
        await this.sendItem(item);
        return item;
    }

    /** Clear all items with the given status. */
    // ----- chat sends shown in the queue (src/utils/chatQueueItems.ts) ---------

    /**
     * Show a chat send in the queue: an item with status `chat` while it runs.
     * The queue never picks, sends or counts it. A stale `chat` item (this
     * window's older one, or one of a window that is gone) is settled first.
     * Answers the item's id for completeChatItem.
     */
    addChatItem(opts: { text: string; profileId?: string; session: string; source: string; run?: string }): string {
        const ownWindowId = getWindowStatusWindowId();
        const chat = newChatItem({ id: randomUUID(), text: opts.text, profileId: opts.profileId, session: opts.session, source: opts.source, windowId: ownWindowId, now: new Date(), run: opts.run });
        const item: QueuedPrompt = {
            ...(chat as unknown as QueuedPrompt),
            prePrompts: [],
            followUps: [],
            itemKind: 'chat',
        };
        this._items.push(item);
        settleRunningChatItems(this._items, { ownWindowId, liveWindowIds: liveWindowIdSet(), keepId: item.id, isActive: (id) => isChatSendActive(id) || this._openAsksToRestore.has(id) || this._restoringAsks.has(id) });
        this.trimSentHistory();
        this.persist();
        this._onDidChange.fire();
        logQueue(`Chat send shown in the queue: ${item.id} (${opts.source}, session ${opts.session})`);
        return item.id;
    }

    /** A chat send's prompt as sent (the Recent Prompts panel's As sent view, utils/sentPrompts.ts). */
    recordChatPrompt(id: string, sent: { systemPrompt: string; userMessage: string }): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }
        const record = this._beginSentRecord(item, 'Chat send');
        this._fillSentRecord(record, sent);
        this.persist();
    }

    /** The chat send ended: `chat-sent`, with its answer or its error. A queue item waiting for its session goes now. */
    completeChatItem(id: string, result: { answerText?: string; error?: string; usage?: LiveTrailTokenCounts }): void {
        const item = this._items.find(i => i.id === id);
        if (item) {
            finishChatItem(item as unknown as ChatQueueItem, result);
            if (result.usage) { this._addItemSendUsage(item, result.usage); }
            this.persist();
            this._onDidChange.fire();
        }
        if (this._anyRunMayStart() && this._mayDrain()) {
            void this.sendNext();
        }
    }

    /**
     * Add what followed an ended chat send to its entry (an assist's closing answer, vscimpb63): the note goes
     * under its answer and into the Tom Prompt Queue channel. Answers whether the entry was there.
     */
    noteChatItem(id: string, note: string): boolean {
        const item = this._items.find(i => i.id === id);
        logQueue(`Chat send ${id}: ${note.replace(/\s+/g, ' ').trim()}`);
        if (!item || !isChatStatus(item.status)) { return false; }
        appendChatItemNote(item as unknown as ChatQueueItem, note);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    // ----- busy sessions (src/utils/sessionBusy.ts) --------------------------

    /** The session a queue item runs in when it runs on the Anthropic transport, else undefined. */
    private anthropicSessionOf(item: QueuedPrompt): string {
        return canonicalSessionName(this.resolveStageTransport(item).session ?? DEFAULT_RUN_SESSION);
    }

    /** Whether a `chat` item's send still runs: this window's active send, or one of another live window. */
    private chatAlive(item: { id: string; chatWindowId?: string }): boolean {
        const own = getWindowStatusWindowId();
        if (!item.chatWindowId || item.chatWindowId === own) { return isChatSendActive(item.id); }
        return liveWindowIdSet().has(item.chatWindowId);
    }

    /**
     * Who holds `session`: a queue item running in it or a chat send running
     * in it (this or another window of the quest); undefined when it is free.
     */
    /** What item `id`'s running dispatch waits for the user for (a question, an approval); none when it waits for nothing. */
    waitingForUserOf(id: string): UserWaitKind[] {
        return queueItemsWaitingForUser().get(id) ?? [];
    }

    /** The tomAi_askUser question item `id`'s turn waits in: its request id and when it was asked. */
    pendingQuestionOf(id: string): { requestId: string; askedAt: number; title?: string; firstLine: string } | undefined {
        const pending = AskUserRegistry.instance.pendingForQueueItem(id);
        if (!pending) { return undefined; }
        // The first line of what it asks (its title, else its first question): the run tab's tooltip (vscimpb112).
        const firstLine = (pending.title || pending.questions[0] || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
        return { requestId: pending.requestId, askedAt: pending.createdAt, ...(pending.title ? { title: pending.title } : {}), firstLine };
    }

    /**
     * The Anthropic session item `id` runs (or will run) in — its own, else its
     * run's queue session — whose live trail the queue editor's item icon opens;
     * undefined for an unknown item.
     */
    stageSessionOf(id: string): string | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item) { return undefined; }
        const resolved = this.resolveStageTransport(item);
        return canonicalSessionName(resolved.session || DEFAULT_RUN_SESSION);
    }

    /** The transport item `id`'s running stage went out on (its last dispatch, else as resolved now). */
    stageTransportOf(id: string): QueuedTransport | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item) { return undefined; }
        return item.lastDispatched?.transport ?? this.resolveStageTransport(item).transport;
    }

    /** The transport and profile the item's main prompt is sent with now: its own, else its session's, else the queue default's. */
    resolvedProfileOf(id: string): { transport: QueuedTransport; anthropicProfileId?: string } | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item) { return undefined; }
        const resolved = this.resolveStageTransport(item);
        return { transport: resolved.transport, ...(resolved.anthropicProfileId ? { anthropicProfileId: resolved.anthropicProfileId } : {}) };
    }

    /**
     * Give the item a profile of its own (the click on its header's profile),
     * whatever the profile's transport: it is sent on the Anthropic transport
     * with that profile and the profile's own configuration. `undefined`
     * takes its own profile away again: the session's, else the queue default.
     * Allowed until the item has finished; on a sending item it applies from
     * its next stage or iteration. A profile chosen by hand ends an
     * out-of-budget fallback.
     *
     * Refused when the profile cannot continue the conversation of the item's
     * session (`sessionMismatch` names the session); `defaultSession: true`
     * then moves a staged or pending item to the queue's default session.
     */
    setItemProfile(id: string, profileId: string | undefined, opts: { defaultSession?: boolean } = {}): { ok: true } | { ok: false; reason: string; sessionMismatch?: string } {
        const item = this._items.find(i => i.id === id);
        if (!item) { return { ok: false, reason: 'no such item' }; }
        if (item.status === 'sent' || isChatStatus(item.status)) { return { ok: false, reason: 'the item has finished' }; }
        if (item.processMove) { return { ok: false, reason: 'a process-move marker is never sent to a model' }; }
        if (profileId) {
            const section = loadSendToChatConfig()?.anthropic as ProfileSection | undefined;
            if (!lookupProfile(section, profileId)) { return { ok: false, reason: `there is no Anthropic profile "${profileId}"` }; }
        }
        if (opts.defaultSession && !this.canChangeSession(item.status)) { return { ok: false, reason: 'only a staged or pending item can change its session' }; }
        const next: QueuedPrompt = {
            ...item,
            transport: profileId ? 'anthropic' : undefined,
            anthropicProfileId: profileId || undefined,
            anthropicConfigId: undefined,
            budgetFallback: undefined,
            ...(opts.defaultSession ? { session: undefined, sessionCreate: undefined } : {}),
        };
        const refusal = this.sessionRefusal(next);
        if (refusal) { return { ok: false, reason: refusal, ...(next.session ? { sessionMismatch: next.session } : {}) }; }
        item.transport = next.transport;
        item.anthropicProfileId = next.anthropicProfileId;
        item.anthropicConfigId = undefined;
        delete item.budgetFallback;
        if (opts.defaultSession) { item.session = undefined; item.sessionCreate = undefined; }
        this.persist();
        this._onDidChange.fire();
        return { ok: true };
    }

    /**
     * Resend the stage a sending item runs now (vscimpb55): its turn is ended, the
     * question it waits in closed, and the same stage dispatched again with a note
     * that the turn was interrupted, so the agent picks up from its trail. The
     * counters stay as they are; the walk goes on from the resent stage.
     */
    async resendSendingStage(id: string): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') {
            throw new Error(`Queue item ${id} is not sending`);
        }
        if (!item.lastDispatched) {
            throw new Error(`Queue item ${id} has not dispatched a stage yet`);
        }
        logQueue(`resendSendingStage(${item.id}): resending the running ${item.lastDispatched.kind} stage`);
        await this.resendLastPrompt(id, undefined, { interruptRunning: true });
    }

    sessionHolder(session: string, exceptId?: string): SessionHolder | undefined {
        return sessionHolderOf(this._items as unknown as SessionBusyItem[], session, {
            queueSession: (i) => this.anthropicSessionOf(i as unknown as QueuedPrompt),
            chatAlive: (i) => this.chatAlive(i as unknown as { id: string; chatWindowId?: string }),
            exceptId,
        });
    }

    /** The sessions of `candidates` nobody runs in now, in their order. */
    freeSessions(candidates: readonly string[]): string[] {
        return candidates.filter((s, i) => candidates.indexOf(s) === i && !this.sessionHolder(s));
    }

    /** A chat send holding the session `item` would run in, if any: then the item waits. */
    chatHoldingSessionOf(item: QueuedPrompt): { session: string; holder: SessionHolder } | undefined {
        if (isChatStatus(item.status)) { return undefined; }
        const session = this.anthropicSessionOf(item);
        if (!session) { return undefined; }
        const holder = this.sessionHolder(session, item.id);
        return holder?.kind === 'chat' ? { session, holder } : undefined;
    }

    /**
     * "Run after the current item" (a chat send into a busy session): queued
     * pending directly under the item that is sending — after all of its
     * iterations, not between them — or at the front of the pending items.
     */
    async enqueueAfterCurrent(opts: Parameters<PromptQueueManager['enqueue']>[0]): Promise<QueuedPrompt> {
        return this.enqueue({ ...opts, initialStatus: 'pending', position: nextQueuePosition(this._items) });
    }

    clearByStatus(status: QueuedPromptStatus, run?: string): void {
        // "Clear sent" also clears the finished chat sends shown in the queue; `run`: only that run's items.
        const matches = (i: QueuedPrompt): boolean => (i.status === status || (status === 'sent' && i.status === CHAT_SENT_STATUS)) && this._inRun(i, run);
        this._releaseClaimsOfDroppedItems(this._items.filter(matches), 'cleared');
        emitNotifications(this._items.filter(matches).map((i) => queueItemDraft('itemDeleted', i)));
        this._items = this._items.filter(i => !matches(i));
        this.trimSentHistory();
        this.persist();
        this._onDidChange.fire();
    }

    /** Clear entire queue (all statuses); `run`: only that run's items. */
    clearAll(run?: string): void {
        const dropped = this._items.filter((i) => this._inRun(i, run));
        this._releaseClaimsOfDroppedItems(dropped, 'queue cleared');
        emitNotifications(dropped.map((i) => queueItemDraft('itemDeleted', i)));
        this._items = this._items.filter((i) => !this._inRun(i, run));
        this.persist();
        this._onDidChange.fire();
    }

    /** Release the todo claims of in-flight items that are about to be dropped. */
    private _releaseClaimsOfDroppedItems(items: QueuedPrompt[], reason: string): void {
        for (const item of items) {
            if (item.status === 'sending' || item.status === 'interrupted') {
                this.releaseQuestTodoClaim(item, reason);
            }
        }
    }

    // ----- lanes: Queue per run (src/utils/queueLanes.ts) --------------------

    /**
     * The lanes: always one per run (vscimpb60a); a run whose auto-send is off
     * is held — its lane starts nothing (`force`: runs started anyway, by an
     * explicit retry).
     */
    private _laneOptions(force?: ReadonlySet<string>): { perRun: boolean; heldRuns: readonly string[] } {
        return { perRun: true, heldRuns: this._pausedRuns(force) };
    }

    /** The dispatch epoch a frame of `item` watches (see `_itemEpochs`). */
    private _epochOf(item: QueuedPrompt | undefined): number {
        return this._globalEpoch + (item ? this._itemEpochs.get(item.id) ?? 0 : 0);
    }

    /** How `item` runs now: its session. */
    private _laneTarget(item: QueuedPrompt): LaneTarget {
        return { session: this.anthropicSessionOf(item) };
    }

    /**
     * Whether a drain may be started: with one lane only while nothing sends
     * (as always); with lanes whenever — `sendNext` fills the free lanes.
     */
    private _mayDrain(): boolean {
        return true;
    }

    /** The items that may start now, one per free lane. */
    private _laneStarts(force?: ReadonlySet<string>): QueuedPrompt[] {
        return pickLaneStarts(this._items, this._laneOptions(force), (i) => this._laneTarget(i))
            .filter((i) => !this._textEdits.has(i.id) && !this.chatHoldingSessionOf(i));
    }

    /** `sendNext`: every free lane of a run that sends takes its next item; they send in parallel. */
    private async _sendNextInLanes(force?: ReadonlySet<string>): Promise<void> {
        if (!this._items.some(i => i.status === 'pending')) {
            logQueue('sendNext: no pending items');
            this._autoPauseIdleRuns();
            return;
        }
        const starts = this._laneStarts(force);
        if (starts.length === 0) {
            logQueue('sendNext: every lane with pending items is sending, paused, waiting for a session or being edited');
            return;
        }
        logQueue(`sendNext: starting ${starts.map(i => `${i.id} (run ${laneOf(i, true)})`).join(', ')}`);
        await Promise.all(starts.map((item) => this.sendItem(item)));
    }

    /** Auto-Pause per run: a sending run with Auto-Pause whose items are all done (none pending, sending or interrupted) pauses. */
    private _autoPauseIdleRuns(): void {
        const runs = new Set(this._items.map((i) => itemRun(i)));
        for (const run of runs) {
            const settings = this._settingsOf(run);
            const own = this._items.filter((i) => itemRun(i) === run);
            if (own.some((i) => i.status === 'pending' || i.status === 'sending' || i.status === 'interrupted')) { continue; }
            if (shouldAutoPauseOnEmpty(settings.autoSend, 0, settings.autoPause)) {
                const first = own[0];
                this._pauseRunOf(first, 'its lane is empty (Auto-Pause)');
            }
        }
    }

    /** Resume the paused sending items of the runs that send (of `run` only when given): auto-send just came on. */
    private _resumePausedLanes(run?: string): void {
        for (const item of this._items) {
            if (!this._isPausedAtGate(item)) { continue; }
            if (!this._autoSendFor(item) || (run !== undefined && itemRun(item) !== normalizeRun(run))) { continue; }
            logQueue(`Resuming paused item ${item.id} of run ${itemRun(item)}`);
            void this._resumePausedSendingItem(item);
        }
    }

    /** The queue always runs one lane per run (vscimpb60a): kept for callers reading it. */
    get queuePerRun(): boolean { return true; }

    /** The runs whose auto-send is off. */
    get heldRuns(): readonly string[] { return this._pausedRuns(); }

    /** Pause or resume one run (its auto-send). Returns whether it changed. */
    setRunHeld(run: string, held: boolean): boolean {
        const name = normalizeRun(run);
        if (this._settingsOf(name).autoSend === !held) { return false; }
        this.setRunAutoSend(name, !held);
        return true;
    }

    /** The lanes as the queue editor shows them. */
    laneSummaries(runs: readonly string[]): LaneSummary[] {
        return laneSummaries(this._items, runs, this._laneOptions());
    }

    // ----- sending -----------------------------------------------------------

    /**
     * The one gate every completion path asks before starting the next item:
     * is the queue still running, and did this item ask to stop after itself?
     *
     * Call it at each point where an item reaches `'sent'` and advance only
     * when it returns true. `sendNext()` deliberately does **not** check
     * auto-send itself — the explicit escape hatches (health-check resume,
     * per-item "retry now", "retry all errors") rely on being able to kick a
     * paused queue. That makes checking it here mandatory rather than
     * optional, which is why the check lives in one method instead of being
     * re-written at six call sites.
     */
    private _shouldAdvanceQueueAfter(item: QueuedPrompt): boolean {
        const decision = decideAdvanceAfterCompletion(item.pauseAfter, this._autoSendFor(item));
        if (decision.disableAutoSend) { this._pauseRunOf(item, `"pause after this" on ${item.id}`); }
        if (!decision.advance) {
            logQueue(
                `Queue held after item ${item.id} — `
                + (item.pauseAfter ? '"pause after this" is set' : 'auto-send is off'),
            );
        }
        return decision.advance;
    }

    private async delaySendNext(): Promise<void> {
        // No guard here: sendNext() has its own guard against concurrent sending.
        await new Promise(r => setTimeout(r, this._autoSendDelayMs));
        await this.sendNext();
    }

    /**
     * Start what may start: the interrupted item of a run that sends goes
     * first (ahead of its backlog); else every free lane of a run that sends
     * takes its next item. `force`: runs started even while paused — the
     * explicit escape hatches (health-check resume of a parked item, retry now).
     */
    async sendNext(force?: ReadonlySet<string>): Promise<void> {
        this._releaseResolvedDecisionItems();
        if (this._resumeInterruptedItem()) { return; }
        await this._sendNextInLanes(force);
    }

    // ----- process-move markers (src/utils/processMoveMarker.ts) ------------

    private _processMoveHandler?: (marker: QueuedPrompt) => Promise<{ ok: true } | { ok: false; error: string }>;

    /** Install what a process-move marker does when it moves (processActionService: the process state store). */
    setProcessMoveHandler(handler: (marker: QueuedPrompt) => Promise<{ ok: true } | { ok: false; error: string }>): void {
        this._processMoveHandler = handler;
    }

    /** The running step of `quest`: its open marker and how many of its run's items are left. */
    /** The open Proceed run of `quest` (its `level`, its run `run` when given). */
    stepRunProgress(quest: string, level?: number, run?: string): StepRunProgress | undefined {
        return stepRunProgress(this._items, quest, level, run);
    }

    /** Remove the open process-move markers of `quest` (Skip, Back, a state set by hand). Answers how many. */
    dropProcessMoveMarkers(quest: string, why: string, run?: string): number {
        const ids = new Set(openMarkerIds(this._items, quest, run));
        if (ids.size === 0) { return 0; }
        emitNotifications(this._items.filter((i) => ids.has(i.id)).map((i) => queueItemDraft('itemDeleted', i, { kind: 'extension', label: why })));
        this._items = this._items.filter((i) => !ids.has(i.id));
        logQueue(`Process-move marker(s) of ${quest} removed (${why}): ${[...ids].join(', ')}`);
        this.persist();
        this._onDidChange.fire();
        return ids.size;
    }

    /**
     * The queue reached a process-move marker: move the process when every
     * earlier item of its Proceed run is sent; hold it (status error) when one
     * failed; otherwise leave it pending — the queue waits here.
     */
    private async _runProcessMoveMarker(item: QueuedPrompt): Promise<void> {
        const verdict = markerVerdict(this._items, item);
        if (verdict === 'wait') {
            logQueue(`Process-move marker ${item.id}: waiting for the items of its step`);
            return;
        }
        if (verdict === 'held') {
            item.status = 'error';
            item.error = PROCESS_MARKER_HELD_ERROR;
            logQueue(`Process-move marker ${item.id}: held — an item of its step failed`);
        } else {
            const result = this._processMoveHandler
                ? await this._processMoveHandler(item)
                : { ok: false as const, error: 'the process state is not ready' };
            if (result.ok) {
                item.status = 'sent';
                item.sentAt = new Date().toISOString();
                item.error = undefined;
                logQueue(`Process-move marker ${item.id}: ${item.originalText}`);
            } else {
                item.status = 'error';
                item.error = `the process could not move: ${result.error}`;
                logQueue(`Process-move marker ${item.id}: ${item.error}`);
            }
        }
        this.persist();
        this._onDidChange.fire();
        if (this._shouldAdvanceQueueAfter(item)) { void this.sendNext(); }
    }

    private async sendItem(item: QueuedPrompt): Promise<void> {
        if (item.status === 'sending') { return; }
        // A chat send runs in the session this item runs in: it waits (two
        // prompts never share a conversation). completeChatItem starts it.
        const waitingFor = this.chatHoldingSessionOf(item);
        if (waitingFor) {
            logQueue(`sendItem: held — item ${item.id} waits for session ${waitingFor.session}, where the chat send ${waitingFor.holder.id} runs`);
            this._onDidChange.fire();
            return;
        }
        // Its turn has come: a "send between iterations" mark has done its job.
        if (item.sendBetween) { item.sendBetween = undefined; }
        if (item.processMove) {
            await this._runProcessMoveMarker(item);
            return;
        }
        // Its wait was interrupted (vscimpb82): the stage it waited in is sent again, with a note.
        if (item.resumeAfterWait) {
            item.resumeAfterWait = undefined;
            if (item.lastDispatched) {
                logQueue(`sendItem: item ${item.id} resumes after its interrupted wait — its last stage is sent again`);
                try {
                    await this.resendLastPrompt(item.id, undefined, { note: WAIT_RESUME_NOTE });
                } catch (err) {
                    this._markItemError(item, err, `sendItem(${item.id}) after an interrupted wait`, readInterruptionFromError(err));
                }
                return;
            }
        }

        // **Resume vs fresh-start gate.** Items that carry prior
        // dispatch counters (paused mid-flight, reset from error
        // via `applyResetToPending`, or post-reload after crash
        // recovery flipped them back to 'pending') keep their
        // cursors so the dispatcher picks up at the next
        // un-dispatched repetition. Fresh items (never sent or
        // explicitly reset to staged) get the full reset.
        const hasProgress = this._itemHasInFlightProgress(item);
        // The main stage's target, resolved as dispatchStage resolves it — the log names where it goes.
        const target = describeQueueSendTarget(this.resolveStageTransport(item));
        if (hasProgress) {
            logQueue(`Resuming prompt ${item.id} ${target} from prior progress (mp.idx=${item.repeatIndex ?? 0}, fu.idx=${item.followUpIndex ?? 0}) — text=${promptPreview(item.originalText)}`);
            // Clear only the transient error markers so the
            // resumed dispatch isn't shadowed by them. `lastDispatched`
            // and counters survive so the user can still Resend the
            // last stage if needed.
            item.error = undefined;
            item.warning = undefined;
        } else {
            logQueue(`Sending prompt ${item.id} ${target} — text=${promptPreview(item.originalText)}`);
            // Fresh start: reset run state before first dispatch.
            resetItemRunState(item);
        }
        item.status = 'sending';
        this.persist();
        this._onDidChange.fire();

        // Snapshot the dispatch epoch: if it advances while we await the
        // dispatch, an explicit Continue / Stop / set-to-staged cancelled
        // this send and now owns the item's next state. We must then
        // neither advance the queue (success path) nor mark `error`
        // (catch path). See `dispatchWasSuperseded`.
        const epoch = this._epochOf(item);

        try {
            const outcome = await this._runDispatchFrame(item);
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                logQueue(`sendItem(${item.id}): dispatch superseded by an explicit action — original frame stands down`);
                return;
            }
            // An item cascades through all its stages; on 'done' it is
            // finished. On 'paused' the item stays in 'sending' so the UI
            // shows "SENDING (PAUSED)" and `set autoSendEnabled(true)`
            // knows where to resume.
            if (outcome === 'paused') {
                logQueue(`sendItem(${item.id}): paused — held in 'sending' for resume`);
            } else {
                // Re-look up the live item by ID: if _reloadFromDisk() ran
                // during the async dispatch (despite the guard above, a
                // reload could still have happened in an earlier tick before
                // the guard was reached), the original `item` reference may
                // no longer be the object stored in _items.  Updating a
                // discarded object would leave _items showing 'sending' and
                // stall the queue permanently.
                const liveItem = this._items.find(i => i.id === item.id) ?? item;
                liveItem.status = 'sent';
                // Continue the outer template-repeat loop. Without this,
                // Anthropic items with templateRepeatCount > 1 terminate
                // after iteration 1 and the user perceives "the outer
                // loop always starts at 1 again" when they retry.
                await this._afterItemDone(liveItem, 'sendItem/anthropic');
                this.persist();
                this._onDidChange.fire();
                logQueue(`Prompt ${item.id} completed`);
                // A completion like any other: same gate as every other
                // tail, so a paused queue does not march on from here.
                if (this._shouldAdvanceQueueAfter(liveItem)) {
                    void this.sendNext();
                }
            }
        } catch (err) {
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                // The throw is the byproduct of an intentional cancel
                // (Continue / Stop / set-to-staged); the action that
                // cancelled already set the item's terminal state. Do
                // NOT mark `error` or disable auto-send.
                logQueue(`sendItem(${item.id}): dispatch cancelled by an explicit action — error suppressed`);
                return;
            }
            const liveItem = this._items.find(i => i.id === item.id) ?? item;
            // If the Anthropic leaf stamped an Interruption onto the
            // thrown error, surface it as a yellow warning chip so the
            // user can tell a recoverable rate-limit / quota / cancel
            // apart from a hard protocol failure.
            this._markItemError(liveItem, err, `sendItem(${item.id})`, readInterruptionFromError(err));
        }
    }

    /**
     * Resend the most recent dispatch on a queue item — the exact
     * expanded text that `dispatchStage` was last called with, routed
     * through the same transport / profile / configuration. Repetition
     * counters are **not** touched; they were already incremented for
     * the stage the resend replays, so after the resend
     * `dispatchNextStageForSendingItem` advances naturally to the next
     * stage.
     *
     * Used by (a) the Resend icon in the queue editor webview and
     * (b) the `tomAi_resendQueueItem` tool. Throws when there is no
     * recorded `lastDispatched` (never sent) or when another item is
     * currently `sending` (serialisation invariant — see sendNext).
     */
    async resendLastPrompt(
        id: string,
        override?: { text: string; anthropicProfileId: string; session: string },
        opts?: { interruptRunning?: boolean; note?: string; continuation?: string },
    ): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item) {
            throw new Error(`Queue item ${id} not found`);
        }
        const last = item.lastDispatched;
        if (!last) {
            throw new Error(`Queue item ${id} has no previously-dispatched prompt to resend`);
        }
        // Resending a running stage (resendSendingStage): the item itself is sending, and is not in its own way.
        const interruptRunning = opts?.interruptRunning === true && item.status === 'sending';
        // The continuation of a turn a reload ended while it waited in an ask (vscimpb166): the item is sending
        // (no turn runs); the answer goes into the conversation that turn ran in, the stage's text stays.
        const continuation = opts?.continuation;
        const others = this._items.filter(i => i.status === 'sending' && !((interruptRunning || continuation !== undefined) && i.id === item.id));
        const busy = laneConflict(item, others, this._laneOptions(), (i) => this._laneTarget(i));
        if (busy) {
            throw new Error(`Cannot resend now: ${busy}; wait for it to finish before resending`);
        }

        logQueue(`Resending last ${last.kind} prompt for item ${item.id} via ${last.transport}${interruptRunning ? ' (its running turn is ended)' : ''}`);
        // The running turn's frame loses the item before its turn is cancelled, so however the
        // cancelled turn ends, it does not go on (vscimpb54); its question is closed with it.
        const takeover = interruptRunning ? this._claimFrame(item) : undefined;
        if (interruptRunning) {
            this._cancelActiveDispatch(item);
            if (AskUserRegistry.instance.cancelForQueueItem(item.id, QUESTION_CLOSED_BY_RESEND)) {
                logQueue(`resendLastPrompt(${item.id}): closed the question the running turn waited in`);
            }
        }

        // Clear prior failure markers so the UI reflects the in-flight resend.
        item.error = undefined;
        item.warning = undefined;
        item.outOfBudget = undefined;
        // A resend is a fresh dispatch attempt that advances no counter, so any
        // snapshot still hanging off the item belongs to an earlier dispatch and
        // is moot — same rule as the top of `dispatchNextStageForSendingItem`.
        // Without this, a resend that fails would hit `rollbackInFlightRepetition`
        // and silently rewind a counter, contradicting the contract above that
        // repetition counters are not touched.
        item.inFlightRepetition = undefined;
        // Replaying a main prompt whose todo claim was released (stop,
        // interrupt, error) claims that todo again — it is being worked on.
        if (last.kind === 'main' && item.todoClaim?.released) {
            item.todoClaim = reclaimForResend(QUEST_TODO_STATUS_PORT, item.todoClaim);
        }
        item.status = 'sending';
        item.sentAt = new Date().toISOString();
        this.persist();
        this._onDidChange.fire();

        // Resolve the container that should absorb the returned answer
        // text — same contract as the dispatch loop.
        const container = resolveAnswerContainer(item);

        // The item's session and process position, and the iteration the
        // replayed prompt ran in, so the resend continues the same conversation.
        const resolved = {
            ...this.resolveStageTransport(item),
            transport: last.transport,
            anthropicProfileId: override?.anthropicProfileId ?? last.anthropicProfileId,
            anthropicConfigId: override ? undefined : last.anthropicConfigId,
            iterationKey: last.iterationKey,
            ...(override ? { session: override.session } : {}),
            item,
        };

        const epoch = this._epochOf(item);
        // The resend is the item's frame from its replayed stage on: an older frame stops at its next stage.
        const frame = takeover ?? this._claimFrame(item);
        try {
            // An edit made after the last dispatch wins over the snapshot for
            // the main stage — cancel / correct / resend is a workflow the
            // queue invites, and replaying the snapshot there sent the very
            // text the user had just cancelled. See `resolveResendText`.
            const resendText = continuation !== undefined ? last.expandedText : (override?.text ?? resolveResendText(last, item.expandedText));
            // After a hard interrupt or a lost turn (vscimpb112): a held direct / Local LLM conversation goes on
            // where it stopped (no resend); else the resend says the turn was interrupted, carries a result the
            // agent never saw, and continues the conversation the turn ran in.
            const interrupted = item.interruptNote === true && !override;
            const heldConversation = interrupted && last.transport === 'anthropic' ? this._readHeldConversation(item) : undefined;
            const soft = item.softInterrupt;
            const resumeConversation = heldConversation
                ? prefixHeldConversation(heldConversation, soft?.heldAt !== undefined ? heldForLine(Date.now() - soft.heldAt) : undefined)
                : undefined;
            const continueSessionId = (interrupted && !resumeConversation) || continuation !== undefined ? item.turnSessionId : undefined;
            delete item.interruptNote;
            delete item.softInterrupt;
            if (!resumeConversation) { this._dropHeldConversation(item); }
            // A running turn resent: the agent is told its turn was interrupted (not recorded as the stage's text).
            // A stage sent again after an interrupted wait carries its own note (vscimpb82).
            const note = interruptRunning || (interrupted && !resumeConversation)
                ? [RESEND_INTERRUPTED_NOTE, interrupted ? heldResultResendLine(soft) : undefined].filter(Boolean).join('\n\n')
                : opts?.note;
            const sentText = continuation ?? (note ? `${note}\n\n${resendText}` : resendText);
            if (resumeConversation) { logQueue(`resendLastPrompt(${item.id}): continuing the held conversation (${resumeConversation.transport})`); }
            await this.dispatchStage(sentText, {
                ...resolved,
                ...(continueSessionId ? { continueSessionId } : {}),
                ...(resumeConversation ? { resumeConversation } : {}),
                sentLabel: `${continuation !== undefined ? 'Continuation' : 'Resend'} of ${sentStageLabel(item).replace(/^Main prompt/, 'the main prompt')}`,
            }, container);
            if (resumeConversation) { this._dropHeldConversation(item); }
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                logQueue(`resendLastPrompt(${item.id}): dispatch superseded by an explicit action — original frame stands down`);
                return;
            }
            // Refresh the timestamp so the user can see the resend happened,
            // and record the text that actually went out — otherwise a second
            // resend would replay the superseded snapshot all over again.
            item.lastDispatched = {
                ...last,
                expandedText: resendText,
                ...(override ? { anthropicProfileId: override.anthropicProfileId, anthropicConfigId: undefined } : {}),
                dispatchedAt: new Date().toISOString(),
            };
            this._onPromptSent.fire(item);
            this.persist();
            this._onDidChange.fire();

            {
                // The counters for the resent stage were already
                // incremented by the original send, so the next dispatch
                // advances to the *next* stage. Mirrors the tail of sendItem.
                const outcome = await this._runDispatchFrame(item, frame);
                const liveItem = this._items.find(i => i.id === item.id) ?? item;
                if (outcome === 'done') {
                    liveItem.status = 'sent';
                    // Continue the outer template-repeat loop — same
                    // rationale as in sendItem / _resumePausedSendingItem.
                    // Without this a Resend on the last iteration of a
                    // failed multi-iteration sequence would never spawn
                    // the next iteration.
                    await this._afterItemDone(liveItem, 'resend/anthropic');
                    this.persist();
                    this._onDidChange.fire();
                    if (this._shouldAdvanceQueueAfter(liveItem)) {
                        void this.sendNext();
                    }
                } else if (outcome === 'paused') {
                    logQueue(`resendLastPrompt(${item.id}): paused after resending the failed rep — held in 'sending' for resume`);
                }
            }
        } catch (err) {
            if (dispatchWasSuperseded(epoch, this._epochOf(item))) {
                logQueue(`resendLastPrompt(${item.id}): dispatch cancelled by an explicit action — error suppressed`);
                return;
            }
            const liveItem = this._items.find(i => i.id === item.id) ?? item;
            this._markItemError(liveItem, err, `resendLastPrompt(${item.id})`, readInterruptionFromError(err));
        } finally {
            this._releaseFrame(item, frame);
        }
    }

    /**
     * Promote a queue item to `error`. Centralises the four catch
     * sites (sendItem / resendLastPrompt / continueSending /
     * onAnswerFileChanged) so they all:
     *   - stamp `error` and (when classifiable) `warning`,
     *   - log the error,
     *   - flip the queue's auto-send flag off so a single failure
     *     doesn't burn quota by cascading through the next pending
     *     items (which usually fail for the same root cause —
     *     rate-limit, quota, overload, network outage),
     *   - persist and fire the change event exactly once.
     *
     * Idempotent: a second call on an already-errored item refreshes
     * the error/warning markers but doesn't re-trip the auto-send
     * brake. The user re-enables auto-send when they're ready (via
     * the toggle, by clicking Send, or via Retry All Errors).
     */
    /**
     * Assemble the text scanned for a rate-limit "resets …" clause. The
     * clause can live in the thrown error's string form *or* in the
     * classified interruption message the Anthropic leaf attaches — scan
     * both so the reset time is found regardless of which layer surfaced it.
     */
    private _errorSearchText(
        err: unknown,
        interruption?: { kind: QueueWarningKind; message: string } | null,
    ): string {
        const parts: string[] = [];
        try { parts.push(String(err)); } catch { /* non-stringifiable */ }
        if (interruption?.message) { parts.push(interruption.message); }
        return parts.join('\n');
    }

    private _markItemError(
        item: QueuedPrompt,
        err: unknown,
        scope: string,
        interruption?: { kind: QueueWarningKind; message: string } | null,
    ): void {
        // Rate-limit "resets <time> (<tz>)" clause → park the item in
        // 'waiting' and auto-retry after the stated reset time (plus a
        // 5-minute buffer) instead of hard-failing. The item keeps its
        // queue position; the health-check timer drives the retry, so it
        // survives a window reload. See queueResetClause / applyWaitingTransition.
        // The dispatch that was in flight has now failed — no longer awaiting.
        item.awaitingAnswer = false;
        // Roll back the optimistic repetition-counter advance the failed
        // dispatch made, so whichever recovery path runs (waiting / retry /
        // hard error) re-sends the *same* prompt rather than skipping to the
        // next repetition. No-op when the send failed before any counter was
        // bumped (e.g. during prompt expansion).
        //
        // TODO ITERATION: release the todo claim so the retry picks up the
        // same todo rather than skipping past it. The release restores the
        // status the claim overwrote, and only while the todo still holds the
        // runner's `in-progress` (see utils/queueTodoClaim.ts). Rolling the
        // counter back without releasing the todo would lose it silently.
        rollbackInFlightRepetition(item);
        this.releaseQuestTodoClaim(item, `error in ${scope}`);
        const searchText = this._errorSearchText(err, interruption);
        // A direct send rate limited past its retry budget stamps the reset
        // instant the API stated (rateLimitHeaders); that is exact, so the
        // item resumes right after it rather than five minutes later.
        const notBefore = readRetryNotBefore(err);
        const clause = notBefore !== undefined ? apiRateLimitClause(notBefore) : parseResetClause(searchText);
        if (clause) {
            applyWaitingTransition(item, clause, {
                retryBufferMs: notBefore !== undefined ? 0 : RESET_RETRY_BUFFER_MS,
                kind: interruption?.kind ?? 'rate_limit',
            });
            logQueue(`Item ${item.id} hit a usage limit (${scope}); waiting for ${item.waitingResetLabel}, auto-retry at ${item.waitingUntil}`);
            this.persist();
            this._onDidChange.fire();
            return;
        }

        // No API key for the direct transport: a configuration error, which no
        // retry can fix — straight to `error`, with why and what to do.
        if (isMissingApiKeyFailure(searchText)) {
            this._failForMissingApiKey(item, scope);
            return;
        }

        // Out of credit (400 "Your credit balance is too low"): no retry can
        // help. The profile's policy continues on another profile; else the
        // item waits for the user — continue on a profile, or resend.
        if (isOutOfBudgetFailure(searchText)) {
            this._handleOutOfBudget(item, err, scope, searchText);
            return;
        }

        // A request the API refused as malformed (400 invalid_request_error):
        // every retry would send the same messages and be refused the same way.
        // Fails like an exhausted retry schedule: error, auto-send off.
        if (isUnretryableRequestError(searchText)) {
            clearRetryBookkeeping(item);
            const refused = applyErrorTransition(item, err, { interruption: interruption ?? null });
            logQueueError(scope, err);
            logQueue(`Item ${item.id} failed (${scope}): the API refused the request (400 invalid_request_error) — not retried`);
            if (refused.shouldDisableAutoSend) { this._pauseRunOf(item, `error on item ${item.id} (${scope})`); }
            this.persist();
            this._onDidChange.fire();
            void this._itemFinished(item, { kind: 'error', message: item.error ?? String(err) });
            return;
        }

        // Generic (non-rate-limit) failure: instead of hard-failing straight to
        // `error`, park the item in `retry` on a fixed backoff schedule
        // (30s, +15m, +30m, +45m, +60m, +60m, +60m — 7 attempts). The item
        // keeps its queue position; the health-check timer fires due retries so
        // a reload doesn't strand it. Only once the schedule is exhausted does
        // the item drop to `error` and the queue pause. See queueRetryTransitions.
        const decision = computeRetryDecision(item.retryAttempt);
        if (decision.kind === 'retry') {
            // The Claude Agent SDK "stale previous_message_id" 400 survives an
            // ordinary session reset — the bad id lives in default.session.json.
            // Delete it *now*, before the retry fires, so the next dispatch
            // starts a clean SDK session. See isPreviousMessageIdError.
            if (isPreviousMessageIdError(searchText)) {
                this._clearAgentSdkSessionForRetry(item, scope);
            }
            applyRetryScheduling(item, decision, {
                nowMs: Date.now(),
                interruption: interruption ?? null,
                errorText: searchText,
            });
            logQueueError(scope, err);
            logQueue(`Item ${item.id} failed (${scope}); scheduled retry ${decision.attempt}/${decision.total} at ${item.retryUntil}`);
            this.persist();
            this._onDidChange.fire();
            return;
        }

        // Schedule exhausted → hard-fail and pause the queue (existing behaviour).
        const result = applyErrorTransition(item, err, { interruption: interruption ?? null });
        logQueueError(scope, err);

        if (result.shouldDisableAutoSend) { this._pauseRunOf(item, `error on item ${item.id} (${scope})`); }

        this.persist();
        this._onDidChange.fire();
        // The schedule is exhausted: the item will not recover by itself.
        void this._itemFinished(item, { kind: 'error', message: item.error ?? String(err) });
    }

    /** When each missing-key notice was last sent (by its text), so a run of items on one keyless profile notifies once. */
    private readonly _missingKeyNoticeAt = new Map<string, number>();

    /**
     * A send failed because the direct transport has no API key. Retrying
     * cannot help (the key comes from the environment VS Code was launched
     * with), so the item goes to `error` at once with the causes and the fix,
     * and the user is told (Telegram when configured, else a VS Code message;
     * the same text at most once in ten minutes). Auto-send stays on: items on
     * other profiles keep running — an item on the same keyless profile fails
     * the same way, at once.
     */
    private _failForMissingApiKey(item: QueuedPrompt, scope: string): void {
        const envVar = directApiKeyEnvVar(loadSendToChatConfig()?.anthropic);
        const text = missingApiKeyFailureText(this.missingApiKeyWarnings(item.id), envVar);
        clearRetryBookkeeping(item);
        applyErrorTransition(item, text);
        logQueue(`Item ${item.id} failed (${scope}): no API key (${envVar}) — not retried`);
        this.persist();
        this._onDidChange.fire();
        void this._itemFinished(item, { kind: 'error', message: item.error ?? text });
        const now = Date.now();
        const last = this._missingKeyNoticeAt.get(text);
        if (last !== undefined && now - last < MISSING_KEY_NOTICE_INTERVAL_MS) { return; }
        this._missingKeyNoticeAt.set(text, now);
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { notifyUserLive } = require('../tools/chat-enhancement-tools') as typeof import('../tools/chat-enhancement-tools');
            void notifyUserLive({ title: 'Queue item not sent: no API key', message: text, urgency: 'error' }).catch(() => undefined);
        } catch { /* the notice is best-effort; the item carries the reason */ }
    }

    /**
     * A stage stopped for a too-low credit balance: record where (profile,
     * session), then switch to the profile's fallback when it switches by
     * itself, else stop the item and auto-send so the user decides — the
     * queue editor offers "Continue on profile" and "Resend".
     */
    private _handleOutOfBudget(item: QueuedPrompt, err: unknown, scope: string, searchText: string): void {
        clearRetryBookkeeping(item);
        const section = loadSendToChatConfig()?.anthropic;
        const profiles = (section?.profiles ?? []) as Array<{ id: string; name?: string; configurationId?: string; outOfBudget?: { fallbackProfileId?: string; autoSwitch?: boolean } }>;
        const resolved = this.resolveStageTransport(item);
        const profileId = item.lastDispatched?.anthropicProfileId ?? resolved.anthropicProfileId ?? '';
        const profile = profiles.find((p) => p?.id === profileId);
        const model = (section?.configurations ?? []).find((c) => c?.id === profile?.configurationId)?.model;
        let decision = decideOutOfBudget(profileId, profiles);
        // Switch by itself once per item: a fallback out of credit too asks,
        // so two profiles naming each other cannot pass the item back and forth.
        if (decision.kind === 'switch' && item.budgetFallback) {
            decision = { kind: 'ask', suggestedProfileId: decision.profileId };
        }
        const message = /Your credit balance is too low[^"\n]*/.exec(searchText)?.[0] ?? 'The API credit balance is too low.';
        item.outOfBudget = {
            profileId,
            ...(profile?.name ? { profileName: profile.name } : {}),
            ...(model ? { model } : {}),
            session: canonicalSessionName(resolved.session ?? DEFAULT_RUN_SESSION),
            message,
            at: new Date().toISOString(),
            ...(decision.kind === 'ask' && decision.suggestedProfileId ? { suggestedProfileId: decision.suggestedProfileId } : {}),
        };
        applyErrorTransition(item, err, { interruption: { kind: 'quota_exceeded', message } });
        logQueueError(scope, err);
        if (decision.kind === 'switch') {
            logQueue(`Item ${item.id} ran out of credit on profile ${profileId} (${scope}); continuing on ${decision.profileId}`);
            this.persist();
            this._onDidChange.fire();
            void this.continueOnProfile(item.id, decision.profileId, { automatic: true })
                .catch((e) => logQueueError(`continueOnProfile(${item.id})`, e));
            return;
        }
        logQueue(`Item ${item.id} ran out of credit on profile ${profileId} (${scope}); waiting for the user (continue on a profile, or resend)`);
        this._pauseRunOf(item, `out of credit on item ${item.id}`);
        this.persist();
        this._onDidChange.fire();
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { notifyUserLive } = require('../tools/chat-enhancement-tools') as typeof import('../tools/chat-enhancement-tools');
            void notifyUserLive({
                title: 'Queue stopped: credit balance too low',
                message: `Profile "${profile?.name ?? profileId}" ran out of credit in session "${item.outOfBudget.session}". Continue on another profile or resend from the queue editor.`,
                urgency: 'warning',
            }).catch(() => undefined);
        } catch { /* the notice is best-effort; the item carries the reason */ }
    }

    /**
     * Send the stage an item stopped at (out of credit) again on another
     * profile, as the out-of-budget prompt: what stopped where, the session's
     * live trail, and the original prompt. Later stages of the item run on
     * that profile too. The session stays the item's unless its conversation
     * is kept where the profile cannot continue it; then `default`.
     */
    async continueOnProfile(id: string, profileId: string, opts: { automatic?: boolean } = {}): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item) { throw new Error(`Queue item ${id} not found`); }
        const last = item.lastDispatched;
        if (!last) { throw new Error(`Queue item ${id} has no previously-dispatched prompt to continue`); }
        const config = loadSendToChatConfig();
        const section = config?.anthropic as ProfileSection | undefined;
        const target = (section?.profiles ?? []).find((p) => p?.id === profileId) as { id?: string; name?: string } | undefined;
        if (!target) { throw new Error(`There is no Anthropic profile "${profileId}"`); }
        const resolved = this.resolveStageTransport(item);
        const mark: OutOfBudgetMark = item.outOfBudget ?? {
            profileId: last.anthropicProfileId ?? resolved.anthropicProfileId ?? '',
            session: canonicalSessionName(resolved.session ?? DEFAULT_RUN_SESSION),
            message: item.error ?? 'The API credit balance is too low.',
            at: last.dispatchedAt,
        };
        const session = mark.session;
        const runsInSession = sessionTransportMismatch(this.sessionsFolder(), session, lookupProfile(section, profileId)) ? DEFAULT_RUN_SESSION : session;
        const quest = await_import_ChatVariablesStore()?.quest || undefined;
        const text = outOfBudgetPrompt(mark, {
            quest,
            toProfileName: target.name || profileId,
            runsInSession,
            originalPrompt: resolveResendText(last, item.expandedText),
        }, config?.assistPrompts);
        item.budgetFallback = {
            fromProfileId: mark.profileId,
            toProfileId: profileId,
            ...(runsInSession !== session ? { session: runsInSession } : {}),
        };
        logQueue(`${opts.automatic ? 'Automatically continuing' : 'Continuing'} item ${id} on profile ${profileId} (out of credit on ${mark.profileId}, session ${session}${runsInSession !== session ? ` → ${runsInSession}` : ''})`);
        await this.resendLastPrompt(id, { text, anthropicProfileId: profileId, session: runsInSession });
    }

    /**
     * Delete the Agent SDK session file (`default.session.json`) for the active
     * quest so the next retry of `item` starts a fresh SDK session. Called only
     * for the "stale previous_message_id" 400, whose bad id survives a normal
     * reset. Lazy `require` mirrors the other manager helpers so the memory
     * service (which pulls in heavy history machinery) stays out of the import
     * graph. Best-effort — a failure here must not block the retry.
     */
    private _clearAgentSdkSessionForRetry(item: QueuedPrompt, scope: string): void {
        try {
            const questId = await_import_ChatVariablesStore()?.quest || undefined;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { TwoTierMemoryService } = require('../services/memory-service');
            TwoTierMemoryService.instance.clearAgentSdkSessionId(questId, canonicalSessionName(item.session) ?? runQueueSession(this._itemSettings(item).defaultAgentSdkSession, item.run));
            logQueue(`Item ${item.id} (${scope}): cleared Agent SDK session (previous_message_id 400) for quest '${questId ?? 'none'}' before retry`);
        } catch (e) {
            logQueue(`Item ${item.id} (${scope}): failed to clear Agent SDK session before retry: ${String(e)}`);
        }
    }

    /**
     * Reset an error item back to `pending` *without* sending it.
     * Used by the per-item "Set to Pending" button in the queue
     * editor — the user has reviewed the failure and wants the
     * prompt to wait its turn again. Auto-send is *not* touched: the
     * error transition already flipped it off, and pressing this
     * button is deliberately a soft action ("queue this for later",
     * not "send now"). Even when the user has separately re-enabled
     * auto-send, this method does not call `sendNext()` — the
     * pending item will be picked up by the next normal dispatch
     * cycle, not by the click itself. The user re-enables auto-send
     * via the queue toggle when they're ready.
     *
     * No-op (returns false) on items whose status is not `error`, so
     * an accidental webview message can't downgrade an in-flight
     * item.
     */
    resetItemToPending(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item) {
            throw new Error(`Queue item ${id} not found`);
        }
        if (this.isEmptyIterationItem(item)) {
            // Held because its walk had nothing to walk over: back only when it has work now.
            const reason = this.emptyIterationReason(item);
            if (reason) {
                item.error = reason;
                this.persist();
                this._onDidChange.fire();
                throw new Error(reason);
            }
        }
        const ok = applyResetToPending(item);
        if (!ok) {
            logQueue(`resetItemToPending(${id}): no-op (status was ${item.status})`);
            return false;
        }
        logQueue(`resetItemToPending(${id}): error → pending`);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Manually cut a `waiting` (rate-limit parked) item short: clear its
     * reset countdown, flip it back to `pending`, and — unless another item
     * is already sending — dispatch it immediately. This is the "retry now"
     * escape hatch for when the user knows the limit has lifted early (or
     * simply wants to try). It bypasses the reset-time gate that the
     * health-check driver otherwise enforces.
     *
     * No-op (returns false) on items whose status is not `waiting`.
     */
    async retryWaitingNow(id: string): Promise<boolean> {
        const item = this._items.find(i => i.id === id);
        if (!item) {
            throw new Error(`Queue item ${id} not found`);
        }
        if (item.status !== 'waiting') {
            logQueue(`retryWaitingNow(${id}): no-op (status was ${item.status})`);
            return false;
        }
        clearWaitingState(item);
        logQueue(`retryWaitingNow(${id}): waiting → pending (manual retry)`);
        this.persist();
        this._onDidChange.fire();
        // An explicit retry: its run starts it even while paused.
        if (this._mayDrain()) {
            await this.sendNext(new Set([itemRun(item)]));
        }
        return true;
    }

    /**
     * Manually fire a parked `retry` item now: flip it back to `pending`
     * (preserving the backoff attempt so a further failure continues the
     * cascade) and — unless another item is already sending — dispatch it
     * immediately. This is the per-item "retry now" button, bypassing the
     * backoff countdown the health-check driver otherwise enforces.
     *
     * No-op (returns false) on items whose status is not `retry`.
     */
    async retryRetryingNow(id: string): Promise<boolean> {
        const item = this._items.find(i => i.id === id);
        if (!item) {
            throw new Error(`Queue item ${id} not found`);
        }
        if (item.status !== 'retry') {
            logQueue(`retryRetryingNow(${id}): no-op (status was ${item.status})`);
            return false;
        }
        fireRetry(item);
        logQueue(`retryRetryingNow(${id}): retry → pending (manual retry, attempt ${item.retryAttempt ?? 0})`);
        this.persist();
        this._onDidChange.fire();
        // An explicit retry: its run starts it even while paused.
        if (this._mayDrain()) {
            await this.sendNext(new Set([itemRun(item)]));
        }
        return true;
    }

    /**
     * Give up retrying a parked `retry` item (the per-item "Stop retrying"
     * button): promote it to `error`, stop the countdown, and pause the queue —
     * mirroring the exhausted-schedule path so the user reviews the failure and
     * explicitly re-arms. The item keeps its queue position and its warning
     * chip so the cause stays visible.
     *
     * No-op (returns false) on items whose status is not `retry`.
     */
    stopRetrying(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item) {
            throw new Error(`Queue item ${id} not found`);
        }
        const ok = applyStopRetrying(item);
        if (!ok) {
            logQueue(`stopRetrying(${id}): no-op (status was ${item.status})`);
            return false;
        }
        this._pauseRunOf(item, `stopRetrying on item ${item.id}`);
        logQueue(`stopRetrying(${id}): retry → error (queue paused)`);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Bulk-retry every queue item currently in `error` state. Mirrors
     * the per-item Resend icon, but scoped to the whole queue so the
     * user can recover from a batch-wide interruption (rate-limit,
     * quota, overload) with a single click.
     *
     * Strategy:
     *   - The first error item with a recorded `lastDispatched` is
     *     resent via `resendLastPrompt` — that call takes the single
     *     sending slot and drives the item through the remainder of
     *     its stages.
     *   - All other error items are flipped back to `pending`,
     *     clearing their error/warning markers. Queue order is
     *     preserved. When the first resend completes, `sendNext()`
     *     (called at the tail of `resendLastPrompt`) picks
     *     the next pending item — so retries cascade even when
     *     auto-send is off.
     *   - Items without `lastDispatched` (defensive — shouldn't
     *     normally happen, since error implies a prior dispatch) are
     *     also reset to `pending`.
     *
     * Throws when another item is currently `sending` — same
     * serialisation invariant as `resendLastPrompt`.
     *
     * Returns `{ resent, requeued }`: `resent` is 1 when the lead
     * error item was re-dispatched, 0 otherwise; `requeued` counts
     * the remaining error items that were flipped to `pending`.
     */
    async retryAllErrors(run?: string): Promise<{ resent: number; requeued: number }> {
        // `run`: only that run's errors, and only its own lane must be free.
        if (this._items.some(i => i.status === 'sending' && this._inRun(i, run))) {
            throw new Error(run !== undefined
                ? `Run ${normalizeRun(run)} is sending an item; wait for it to finish before retrying its errors`
                : 'Another queue item is currently sending; wait for it to finish before retrying errors');
        }
        const errorItems = this._items.filter(i => i.status === 'error' && this._inRun(i, run));
        if (errorItems.length === 0) {
            return { resent: 0, requeued: 0 };
        }

        // Pick the first error item with a recorded dispatch — it
        // becomes the lead resend. Everything else falls through to
        // the pending-reset branch.
        const lead = errorItems.find(i => i.lastDispatched);

        let requeued = 0;
        for (const item of errorItems) {
            if (item === lead) { continue; }
            applyResetToPending(item);
            requeued += 1;
        }

        // The error transitions that produced these failures will
        // have flipped auto-send off — see `_markItemError`. The user
        // clicking "Retry All Errors" is an explicit opt-in to a
        // cascade, so re-enable auto-send before kicking the queue;
        // otherwise the lead resend would complete and the answer-
        // file poll loop / sendNext call would refuse to start the
        // next pending item.
        for (const run of new Set(errorItems.map((i) => itemRun(i)))) {
            if (this._settingsOf(run).autoSend) { continue; }
            this._putRunSettings(run, { ...this._settingsOf(run), autoSend: true });
            logQueue(`retryAllErrors: re-enabled auto-send of run ${run} for the retry cascade`);
        }
        this.persistSettings();

        this.persist();
        this._onDidChange.fire();
        logQueue(`retryAllErrors: ${errorItems.length} error item(s); lead=${lead?.id ?? 'none'} requeued=${requeued}`);

        if (!lead) {
            // No dispatchable lead — kick the queue so the first
            // requeued item goes out even if auto-send is off.
            void this.sendNext();
            return { resent: 0, requeued };
        }

        await this.resendLastPrompt(lead.id);
        return { resent: 1, requeued };
    }

    private resolveStableRepeatCount(
        repeatCountRaw: number | string | undefined,
        cachedResolved: number | undefined,
        sentCount: number,
        scope: string,
    ): number {
        const normalizedCached = cachedResolved !== undefined && cachedResolved !== null
            ? Math.max(1, Math.round(Number(cachedResolved) || 1))
            : undefined;
        if (normalizedCached) {
            return normalizedCached;
        }

        // `prefix*` repeat counts (e.g. `dsa*`) resolve at processing time
        // against the active quest's todos: the count is the highest trailing
        // number among ids matching the prefix. Resolved here — never at
        // enqueue — so a series can grow between queuing and dispatch. Takes
        // priority over the variable-recovery branch below because it is
        // deterministic against the live todos rather than a sentCount guess.
        // A TODO item counts 1, a GROUP item its members in this quest (vscimpb127).
        if (parseTodoWalk(repeatCountRaw) !== undefined) {
            const questId = await_import_ChatVariablesStore()?.quest;
            const todoIds = questId ? readQuestTodoEntries(questId) : [];
            const prefixCount = resolveTodoPrefixRepeatCount(repeatCountRaw, todoIds);
            if (prefixCount !== undefined) {
                logQueue(`${scope} dispatch: resolved prefix repeat '${repeatCountRaw}' -> ${prefixCount} from quest '${questId ?? 'none'}' todos`);
                return prefixCount;
            }
        }

        const isVariableRepeat = typeof repeatCountRaw === 'string' && isNaN(parseInt(repeatCountRaw, 10));
        if (isVariableRepeat && sentCount > 0) {
            // Keep variable-driven repeats from expanding if cache was lost mid-run.
            const fallback = Math.max(1, sentCount);
            logQueue(`${scope} dispatch: recovered stable repeat from sentCount=${fallback} for repeatCount=${String(repeatCountRaw)}`);
            return fallback;
        }

        return Math.max(1, resolveRepeatCount(repeatCountRaw));
    }

    /**
     * Resolve the profile, configuration and session a stage runs with —
     * the stage's own win over the item's, the item's over the run's
     * queue defaults.
     */
    private resolveStageTransport(
        item: QueuedPrompt,
        stage?: { transport?: QueuedTransport; anthropicProfileId?: string; anthropicConfigId?: string },
    ): { transport: QueuedTransport; anthropicProfileId?: string; anthropicConfigId?: string; session?: string; processRun?: ProcessRun; iterationKey?: string; item?: QueuedPrompt } {
        // After running out of credit the item continues on another profile.
        return applyBudgetFallback(this.resolveStageTransportAsQueued(item, stage), item.budgetFallback);
    }

    /** The stage's transport, profile and session as the item and the queue defaults name them. */
    private resolveStageTransportAsQueued(
        item: QueuedPrompt,
        stage?: { transport?: QueuedTransport; anthropicProfileId?: string; anthropicConfigId?: string },
    ): { transport: QueuedTransport; anthropicProfileId?: string; anthropicConfigId?: string; session?: string; processRun?: ProcessRun; iterationKey?: string; item?: QueuedPrompt } {
        // A run's item without its own session runs in the run's queue session (default@<run>), never in another run's.
        const runDefaults = this._itemSettings(item);
        // A stored bare `default` (an older build's) is `default@default`.
        const session = canonicalSessionName(item.session) ?? runQueueSession(runDefaults.defaultAgentSdkSession, item.run);
        const processRun = item.processRun;
        // The profile: the stage's, else the item's, else the session's, else the queue default.
        const sessionProfile = this.sessionProfileOf(session, session === item.session ? item.sessionCreate : undefined);
        if (stage?.transport) {
            return {
                session,
                processRun,
                transport: stage.transport,
                anthropicProfileId: stage.anthropicProfileId ?? item.anthropicProfileId ?? sessionProfile ?? runDefaults.defaultAnthropicProfileId,
                anthropicConfigId: stage.anthropicConfigId ?? item.anthropicConfigId ?? runDefaults.defaultAnthropicConfigId,
            };
        }
        if (item.transport) {
            return {
                session,
                processRun,
                transport: item.transport,
                anthropicProfileId: item.anthropicProfileId ?? sessionProfile ?? runDefaults.defaultAnthropicProfileId,
                anthropicConfigId: item.anthropicConfigId ?? runDefaults.defaultAnthropicConfigId,
            };
        }
        return {
            session,
            processRun,
            transport: runDefaults.defaultTransport,
            anthropicProfileId: sessionProfile ?? runDefaults.defaultAnthropicProfileId,
            anthropicConfigId: runDefaults.defaultAnthropicConfigId,
        };
    }

    /**
     * Dispatch one stage's expanded text: it goes
     * through `AnthropicHandler.sendMessage` with the profile's
     * `toolApprovalMode` coerced to `'never'` (queue runs are unattended
     * — see spec §2 decision 7); the returned text is captured into the
     * target container's `answerText` field.
     */
    /** Append the record of the stage `item` sends now (texts filled when the transport composed them). */
    private _beginSentRecord(item: QueuedPrompt, label?: string): SentPromptRecord {
        const record: SentPromptRecord = { label: label ?? sentStageLabel(item), sentAt: new Date().toISOString() };
        item.sentPrompts = appendSentRecord(item.sentPrompts, record);
        return record;
    }

    /** Fill a record with the stage's texts as sent (kept once in the queue folder's `sent-prompts/`). */
    private _fillSentRecord(record: SentPromptRecord, sent: { systemPrompt: string; userMessage: string }): void {
        const folder = getQueueFolder();
        if (!folder) { return; }
        try {
            Object.assign(record, withComposedTexts(folder, record, sent));
            pruneSentTexts(folder, referencedSentTexts(this._items.flatMap((i) => i.sentPrompts ?? [])));
        } catch (err) {
            logQueue(`sent prompt not kept: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async dispatchStage(
        expandedText: string,
        resolved: ReturnType<typeof this.resolveStageTransport> & {
            /** Continue exactly this Agent SDK conversation (a resend after a hard interrupt, vscimpb112). */
            continueSessionId?: string;
            /** Go on with this saved conversation (a held direct / Local LLM turn lost to a restart). */
            resumeConversation?: { transport: 'direct' | 'localLlm'; messages: unknown[] };
            /** The label of the sent-prompt record, when not the stage's own (a resend, a continuation). */
            sentLabel?: string;
        },
        stageForAnswer: { answerText?: string } | undefined,
        // Quest Refresh exemption forwarded to `sendMessage`. Only the **main**
        // queue stage counts toward the refresh interval; pre-prompts,
        // follow-ups, and resends pass `true` so they neither count nor trigger
        // a refresh. Since qr1 the main stage also passes `true` — the refresh
        // runs as a separate sequential step in the dispatch loop, not via the
        // re-entrant `sendMessage` hook.
        skipQuestRefresh = true,
        // Propagate this answer's responseValues (chat variables / TODO
        // analysis). `true` for real queue stages; `false` for the internal
        // Quest Refresh dispatch, whose maintenance answer must not drive
        // downstream chat-variable / TODO side-effects.
        propagateAnswer = true,
    ): Promise<{ answerText: string; superseded?: true }> {
        // The role this stage runs as (gsel3): its todo's (none for a pre-prompt),
        // the item's, the step's, the run default's; the chat variable shows the
        // queue's own while the item sends. The Quest Refresh dispatch has none.
        const stageItem = resolved.item;
        const isPrePrompt = !!stageItem && !!stageForAnswer && (stageItem.prePrompts ?? []).some((pp) => pp === stageForAnswer);
        const roleSource = stageForAnswer ? this.stageRoleSource(stageItem, isPrePrompt ? 'prePrompt' : 'main') : undefined;
        await this._holdStageRole(stageItem, resolved.processRun, roleSource);
        // Deferred imports because promptQueueManager is
        // a module-level singleton and we don't want its module init to
        // pull in the Anthropic handler (which pulls in the SDK).
        const { AnthropicHandler } = await import('../handlers/anthropic-handler.js');
        type AnthropicProfile = import('../handlers/anthropic-handler.js').AnthropicProfile;
        const { resolveAnthropicTargets } = await import('../utils/resolveAnthropicTargets.js');
        const resolvedTargets = resolveAnthropicTargets({
            profileId: resolved.anthropicProfileId,
            configId: resolved.anthropicConfigId,
        });
        if ('error' in resolvedTargets) {
            throw new Error(resolvedTargets.error);
        }
        const { profile, configuration } = resolvedTargets;

        const { ALL_SHARED_TOOLS } = await import('../tools/tool-executors.js');
        // Queue runs are unattended — force auto-approve to prevent
        // deadlock on the tool-approval bar (spec §2 decision 7).
        const coercedProfile: AnthropicProfile = {
            ...profile,
            toolApprovalMode: 'never',
        };

        logQueue(`dispatchStage: anthropic profile=${profile.id} config=${configuration.id}${resolved.session ? ` session=${resolved.session}` : ''}${resolved.iterationKey ? ` iteration=${resolved.iterationKey}` : ''}`);
        // A stage whose direct-API key is missing is not sent: the refusal is the
        // transport's own no-key failure, so the error path fails the item at
        // once without retry (`_failForMissingApiKey`). Read from the config
        // file as it is now — the same section the warnings were given from.
        const keyRefusal = stageKeyRefusal(loadSendToChatConfig()?.anthropic, {
            profileId: resolved.anthropicProfileId,
            configId: resolved.anthropicConfigId,
        }, process.env);
        if (keyRefusal) {
            logQueue(`dispatchStage: not sent — ${keyRefusal}`);
            throw new Error(keyRefusal);
        }
        // A missing named session is created from the item's spec before the first send.
        if (resolved.item) { this.ensureItemSession(resolved.item, resolved.session); }
        // The item whose retry waits the queue shows (unset for the internal
        // Quest Refresh dispatch, which belongs to no item).
        const waitItem = resolved.item;
        // The record of this stage as sent (no item: the Quest Refresh dispatch keeps none).
        const sentRecord = waitItem ? this._beginSentRecord(waitItem, resolved.sentLabel) : undefined;
        // CTS scope: created here so the Stop button (`stopActiveItem`)
        // can cancel the in-flight round loop. Disposed in `finally` so
        // a stale token never lingers across dispatches.
        const cts = new vscode.CancellationTokenSource();
        const ctsKey = waitItem?.id ?? '';
        // A Continue / Stop / Resend while the turn runs bumps the item's epoch. The turn may still end
        // normally (the Agent SDK ends a turn whose tool call was cancelled): its result is then not the
        // stage's answer, and the frame that sent it must not go on (vscimpb54).
        const sendEpoch = this._epochOf(waitItem);
        this._activeAnthropicCts.set(ctsKey, cts);
        // The conversation this turn runs in is captured anew at its first message (vscimpb112).
        if (waitItem) { delete waitItem.turnSessionId; }
        try {
            // The prompt runs as the process position it belongs to (processRunContext).
            // Its tool calls run as this item: a wait for the user they open is shown on it (userWaits).
            const result = await runAsQueueItem(waitItem?.id, () => runInProcessPosition(resolved.processRun, () => runWithQueueRole(roleSource, () => AnthropicHandler.instance.sendMessage({
                userText: expandedText,
                profile: coercedProfile,
                configuration,
                tools: ALL_SHARED_TOOLS,
                cancellationToken: cts.token,
                skipQuestRefresh,
                source: 'queue',
                // The item's named session, else the queue default, else `default`.
                ...(resolved.session ? { sessionKey: resolved.session } : {}),
                // The queue iteration (a per-iteration session keeps one conversation per key).
                ...(resolved.iterationKey ? { iterationKey: resolved.iterationKey } : {}),
                onRetryWait: (wait) => this._showSendWait(waitItem, wait),
                // The turn waits for its own background work, at most the item's (else the profile's) limit.
                ...(waitItem?.backgroundWaitLimitMinutes !== undefined ? { backgroundWaitLimitMinutes: waitItem.backgroundWaitLimitMinutes } : {}),
                onBackgroundWait: (state) => this._showBackgroundWait(waitItem, state),
                // The user's controls of the wait (the editor's and @CHAT's buttons, Continue's choices).
                onBackgroundWaitControl: (control) => {
                    if (!waitItem) { return; }
                    if (control) { this._backgroundControls.set(waitItem.id, control); } else { this._backgroundControls.delete(waitItem.id); }
                },
                // The conversation the turn runs in: a resend after a hard interrupt continues it (vscimpb112).
                onTurnSessionId: (sid) => {
                    if (!waitItem || waitItem.turnSessionId === sid) { return; }
                    waitItem.turnSessionId = sid;
                    this.persist();
                },
                ...(resolved.continueSessionId ? { continueSessionId: resolved.continueSessionId } : {}),
                ...(resolved.resumeConversation ? { resumeConversation: resolved.resumeConversation } : {}),
                // The stage as sent, for the Recent Prompts panel's As sent view (utils/sentPrompts.ts).
                ...(sentRecord ? { onPromptComposed: (sent: { systemPrompt: string; userMessage: string }) => this._fillSentRecord(sentRecord, sent) } : {}),
            }))), waitItem ? itemRun(waitItem) : undefined).catch((err: unknown) => {
                // The turn of a soft-interrupted item ended without our cancel (the SDK process ended):
                // the item becomes interrupted, its run stays paused (vscimpb112).
                if (waitItem && waitItem.status === 'sending' && !cts.token.isCancellationRequested
                    && SoftInterruptRegistry.instance.stateOf(waitItem.id) !== undefined) {
                    this._softTurnLost(waitItem, err instanceof Error ? err.message : String(err));
                    return undefined;
                }
                throw err;
            });
            if (result === undefined) {
                return { answerText: '', superseded: true };
            }
            // The turn ended by itself within the soft interrupt's wait: the stage is done, the run stays paused.
            if (waitItem && SoftInterruptRegistry.instance.stateOf(waitItem.id) !== undefined && !SoftInterruptRegistry.instance.hasLiveHold(waitItem.id)) {
                SoftInterruptRegistry.instance.clear(waitItem.id);
                logQueue(`Item ${waitItem.id}: its turn ended within the soft interrupt's wait — the stage is done, the run stays paused`);
            }
            if (dispatchWasSuperseded(sendEpoch, this._epochOf(waitItem))) {
                logQueue(`dispatchStage: the turn of ${waitItem?.id ?? '(no item)'} ended after an explicit Continue / Stop / Resend — its result is not taken as the stage's answer`);
                if (waitItem) { this._addItemSendUsage(waitItem, result.usage); }
                return { answerText: result.text, superseded: true };
            }
            // The user interrupted the turn's wait and moved on (vscimpb82): the turn ended with its note, and
            // the item steps back behind the next item of its lane instead of going on with its next stage.
            if (waitItem && this._waitInterrupted.delete(waitItem.id)) {
                this._addItemSendUsage(waitItem, result.usage);
                this._stepBackAfterWaitInterrupt(waitItem);
                return { answerText: result.text, superseded: true };
            }
            if (stageForAnswer) {
                stageForAnswer.answerText = result.text;
                if (waitItem && stageForAnswer === waitItem) {
                    // A turn that ended with background work still running: its answer (the hint in it) shows red.
                    recordRepetitionAnswer(waitItem, result.text, resolveRepeatCount, new Date(), result.backgroundLeft === true);
                    if (result.backgroundLeft) { waitItem.answerBackgroundLeft = true; } else { delete waitItem.answerBackgroundLeft; }
                }
            }
            if (waitItem) { this._addItemSendUsage(waitItem, result.usage); }
            // Propagate responseValues on EVERY direct answer — pre-prompt,
            // main prompt, each repeat, follow-up — so chat-variable setting and
            // TODO analysis run on all final answers, not only the last stage.
            // The internal Quest Refresh dispatch opts out (`propagateAnswer`).
            if (propagateAnswer) {
                this._propagateDirectAnswer(result.text, waitItem);
            }
            this._clearRetryOnDispatchSuccess(waitItem);
            return { answerText: result.text };
        } finally {
            this._showSendWait(waitItem, null);
            this._showBackgroundWait(waitItem, undefined);
            if (waitItem) { this._backgroundControls.delete(waitItem.id); }
            if (this._activeAnthropicCts.get(ctsKey) === cts) {
                this._activeAnthropicCts.delete(ctsKey);
            }
            cts.dispose();
        }
    }

    /**
     * A stage dispatch just succeeded — clear the retry backoff cascade on the
     * currently-sending item so a *later* failure (e.g. a subsequent
     * repetition) starts a fresh cascade at 30s instead of continuing a stale
     * one. Only touches the retry bookkeeping (attempt + countdown); if there
     * is nothing to clear this is a cheap no-op and no change event fires.
     */
    /**
     * Show (or clear, `wait === null`) the retry wait a direct send is in on
     * its queue item, so the queue editor says "rate limited until …" instead
     * of a silent SENDING. Persisted like every item change, but only
     * meaningful while the item is `sending`.
     */
    private _showSendWait(item: QueuedPrompt | undefined, wait: RetryWait | null): void {
        if (!item) { return; }
        const live = this._items.find(i => i.id === item.id) ?? item;
        if (wait === null) {
            if (live.sendWait === undefined) { return; }
            delete live.sendWait;
        } else {
            live.sendWait = {
                kind: wait.kind,
                until: new Date(wait.untilMs).toISOString(),
                attempt: wait.attempt,
            };
            logQueue(`Item ${live.id}: ${wait.kind === 'rate_limit' ? 'rate limited' : 'API busy'} — attempt ${wait.attempt} at ${live.sendWait.until}`);
        }
        this.persist();
        this._onDidChange.fire();
    }

    /**
     * Show (or clear, `undefined`) what a turn of the item waits for in the
     * background: persisted, so the editor shows it after a reload too.
     */
    private _showBackgroundWait(item: QueuedPrompt | undefined, state: BackgroundWaitState | undefined): void {
        if (!item) { return; }
        const live = this._items.find(i => i.id === item.id) ?? item;
        if (state === undefined) {
            if (live.backgroundWait === undefined) { return; }
            delete live.backgroundWait;
            logQueue(`Item ${live.id}: the background wait is over`);
        } else {
            const changed = JSON.stringify(live.backgroundWait) !== JSON.stringify(state);
            if (!changed) { return; }
            // The wait begins again after a message the user wrote into it (the direct transports end the
            // wait for the message's turn): shown as resumed.
            if (live.backgroundWait === undefined) {
                const written = lastOpenWaitMessage(live.waitMessages, 'background');
                if (written) { written.resumed = true; }
            }
            live.backgroundWait = state;
            logQueue(`Item ${live.id}: waiting for ${state.items.length} background item(s) since ${state.since}, limit ${state.limitMinutes} min`);
        }
        this.persist();
        this._onDidChange.fire();
    }

    /** What a turn of item `id` waits for in the background, while it waits. */
    backgroundWaitOf(id: string): BackgroundWaitState | undefined {
        return this._items.find(i => i.id === id)?.backgroundWait;
    }

    /** The controls of the background wait of the sending item `id`, while it waits. */
    private _backgroundControlOf(id: string): BackgroundWaitControl | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending' || !item.backgroundWait) { return undefined; }
        return this._backgroundControls.get(id);
    }

    /** Wait without limit for the background work item `id`'s turn waits for. Answers whether it waited. */
    waitWithoutLimit(id: string): boolean {
        const control = this._backgroundControlOf(id);
        if (!control) { return false; }
        logQueue(`Item ${id}: wait without limit for its background work (the user's choice)`);
        control.waitWithoutLimit();
        return true;
    }

    /** Start the background-wait limit of item `id` again from now. Answers whether it waited. */
    keepWaitingForBackground(id: string): boolean {
        const control = this._backgroundControlOf(id);
        if (!control) { return false; }
        logQueue(`Item ${id}: keep waiting for its background work, the limit again from now (the user's choice)`);
        control.keepWaiting();
        return true;
    }

    /**
     * Stop waiting for the background work of item `id`: its turn ends with the
     * still-running hint and the queue goes on with the next stage or item. Answers whether it waited.
     */
    stopBackgroundWait(id: string): boolean {
        const control = this._backgroundControlOf(id);
        if (!control) { return false; }
        logQueue(`Item ${id}: stop waiting for its background work (the user's choice)`);
        control.stop();
        return true;
    }

    // ----- A message to the item's waiting turn (vscimpb173) ------------------

    /** The messages the user wrote to item `id`'s waiting turn. */
    waitMessagesOf(id: string): ItemWaitMessage[] {
        return this._items.find(i => i.id === id)?.waitMessages ?? [];
    }

    /** Whether a message can be written to item `id` now: its turn waits in tomAi_waitFor or for its background work. */
    /** The session the sending item `id` runs its prompt in; undefined when it does not run. */
    runningSessionOf(id: string): string | undefined {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') { return undefined; }
        return this.anthropicSessionOf(item);
    }

    /** Whether a message can go into the running prompt of item `id`: an Agent SDK query runs in its session. */
    canMessageRunningItem(id: string): boolean {
        const session = this.runningSessionOf(id);
        return !!session && canUpdateRunningPrompt(session);
    }

    /**
     * The user writes `text` into the running prompt of the sending item `id`, from the speech bubble of its
     * header: another user message of the running Agent SDK conversation (services/agentSdkLiveInputs.ts), which
     * the agent answers in the same turn. Kept on the item (`wait-messages`, `into: running`) with its answer.
     * Answers the session and the answer to come (the caller shows it as a chat send of source `update`).
     */
    messageRunningItem(id: string, text: string): { ok: true; session: string; answer: Promise<string> } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') { return { ok: false, reason: 'The item is not running.' }; }
        const problem = waitMessageProblem(text);
        if (problem) { return { ok: false, reason: problem }; }
        const session = this.anthropicSessionOf(item);
        const pushed = sendUpdateToRunningPrompt(session, text.trim());
        if (!pushed) { return { ok: false, reason: `No Agent SDK prompt runs in session ${session} now: only an Agent SDK prompt takes a message while it runs.` }; }
        const message: ItemWaitMessage = { at: new Date().toISOString(), into: 'running', text: text.trim() };
        item.waitMessages = withWaitMessage(item.waitMessages, message);
        pushed.answer.then((answer) => {
            message.answer = keptAnswer(answer);
            this.persist();
            this._onDidChange.fire();
        }).catch(() => undefined);
        logQueue(`Item ${id}: the user wrote into its running prompt (session ${session}): ${message.text.split('\n')[0].slice(0, 80)}`);
        const run = itemRun(item);
        try {
            const now = Date.now();
            appendQuestionLogEntry({
                tool: 'message to a running prompt',
                title: `Written from queue item ${id} into session ${session}`,
                questions: [],
                answer: message.text,
                source: 'queue item',
                askedAt: now,
                answeredAt: now,
                run,
            });
        } catch { /* the journal is best effort */ }
        this.persist();
        this._onDidChange.fire();
        return { ok: true, session, answer: pushed.answer };
    }

    canMessageWaitingItem(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') { return false; }
        return item.waitingFor !== undefined || (item.backgroundWait !== undefined && this._backgroundControls.get(id)?.message !== undefined);
    }

    /**
     * The user writes `text` to the waiting turn of the sending item `id`, from the item itself: it goes to the
     * item's own turn (its session and run, no chat send) — a tomAi_waitFor call returns with it (`message`) and
     * the agent waits on; a turn waiting for its background work gets it as its next user message and waits on
     * after its answer. The message is kept on the item, logged to the Q&A journal and to NOTIFICATIONS.
     */
    messageWaitingItem(id: string, text: string): { ok: true; into: ItemWaitMessage['into'] } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') { return { ok: false, reason: 'The item is not running.' }; }
        const problem = waitMessageProblem(text);
        if (problem) { return { ok: false, reason: problem }; }
        const message: ItemWaitMessage = { at: new Date().toISOString(), into: item.waitingFor ? 'waitFor' : 'background', text: text.trim() };
        if (item.waitingFor) {
            // Recorded first: the wait's end fires the change the editor draws from.
            item.waitMessages = withWaitMessage(item.waitMessages, message);
            if (!WaitForRegistry.instance.message(id, message.text)) {
                item.waitMessages = item.waitMessages.filter((m) => m !== message);
                return { ok: false, reason: 'The item no longer waits.' };
            }
        } else {
            const control = item.backgroundWait ? this._backgroundControls.get(id) : undefined;
            if (!control) { return { ok: false, reason: 'The item no longer waits.' }; }
            if (!control.message) { return { ok: false, reason: 'This transport takes no message into a waiting turn.' }; }
            const sent = control.message(message.text);
            if (!sent) { return { ok: false, reason: 'The item no longer waits.' }; }
            item.waitMessages = withWaitMessage(item.waitMessages, message);
            // The agent's answer (the Agent SDK knows it): kept with the message; the wait goes on after it.
            sent.answer?.then((answer) => {
                message.answer = keptAnswer(answer);
                if (this._items.find(i => i.id === id)?.backgroundWait) { message.resumed = true; }
                this.persist();
                this._onDidChange.fire();
            }).catch(() => undefined);
        }
        logQueue(`Item ${id}: the user wrote to its waiting turn (${message.into === 'waitFor' ? 'tomAi_waitFor' : 'background work'}): ${message.text.split('\n')[0].slice(0, 80)}`);
        const run = itemRun(item);
        try {
            const now = Date.now();
            appendQuestionLogEntry({
                tool: message.into === 'waitFor' ? 'message to a waiting turn (tomAi_waitFor)' : 'message to a waiting turn (background work)',
                title: `Written from queue item ${id}${item.waitingFor ? `, waiting: ${item.waitingFor.reason}` : ''}`,
                questions: [],
                answer: message.text,
                source: 'queue item',
                askedAt: now,
                answeredAt: now,
                run,
            });
        } catch { /* the journal is best effort */ }
        emitNotifications([{
            type: 'message',
            run,
            who: { kind: 'user' },
            user: {
                kind: message.into,
                title: message.text.split('\n')[0].slice(0, 120),
                details: [`To the waiting turn of queue item ${id} (${message.into === 'waitFor' ? 'tomAi_waitFor' : 'its background work'})`, ...message.text.split('\n').slice(0, 20)],
                queueItemId: id,
            },
        }]);
        this.persist();
        this._onDidChange.fire();
        return { ok: true, into: message.into };
    }

    // ----- tomAi_waitFor (vscimpb82; src/utils/waitFor.ts) -------------------

    /**
     * A turn of item `id` starts (`state`) or stops (undefined) waiting in
     * tomAi_waitFor: the item shows it; an interrupted wait marks the item to
     * step back when its turn ends.
     */
    private _onWaitForChange(id: string | undefined, state: WaitForState | undefined, outcome?: string): void {
        if (!id) { this._onDidChange.fire(); return; }
        const live = this._items.find(i => i.id === id);
        if (!live) { return; }
        if (state) {
            live.waitingFor = state;
            // The agent waits again after a message the user wrote into its wait: shown as resumed.
            const written = lastOpenWaitMessage(live.waitMessages, 'waitFor');
            if (written) { written.resumed = true; }
            logQueue(`Item ${id}: its turn waits until ${state.until} — ${state.reason}`);
        } else {
            if (live.waitingFor === undefined) { return; }
            delete live.waitingFor;
            logQueue(`Item ${id}: its wait ended (${outcome ?? 'ended'})`);
        }
        this.persist();
        this._onDidChange.fire();
    }

    /** What a turn of item `id` waits for in tomAi_waitFor, while it waits. */
    waitForOf(id: string): WaitForState | undefined {
        const item = this._items.find(i => i.id === id);
        return item?.status === 'sending' ? item.waitingFor : undefined;
    }

    /**
     * Interrupt the wait of the sending item `id` and move on (decision (a)):
     * the tool answers that the user interrupted it, the agent ends its turn
     * with a note of what is still to do, and the item then steps back behind
     * the next item of its lane. Answers whether it waited.
     */
    interruptWaitFor(id: string): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status !== 'sending') { return false; }
        this._waitInterrupted.add(id);
        if (!WaitForRegistry.instance.interrupt(id)) {
            this._waitInterrupted.delete(id);
            return false;
        }
        logQueue(`Item ${id}: the user interrupted its wait and moved on — it steps back when its turn ends`);
        return true;
    }

    /**
     * After the turn whose wait the user interrupted: the item goes back to
     * pending behind the next pending item of its lane (staged when none
     * follows, so it does not run again at once), its counters, run id and
     * answers kept; when it runs again its last stage is sent again with
     * WAIT_RESUME_NOTE (`resumeAfterWait`). The lane goes on.
     */
    private _stepBackAfterWaitInterrupt(item: QueuedPrompt): void {
        const live = this._items.find(i => i.id === item.id) ?? item;
        // This frame's dispatch is over; a frame still holding the item stands down.
        this._itemEpochs.set(live.id, (this._itemEpochs.get(live.id) ?? 0) + 1);
        const target = yieldTarget(this._laneItemsOf(live), live);
        if (target) { this._items = orderForYield(this._items, live, target); }
        live.status = target ? 'pending' : 'staged';
        live.resumeAfterWait = true;
        live.awaitingAnswer = false;
        live.inFlightRepetition = undefined;
        live.yieldAfterIteration = undefined;
        delete live.waitingFor;
        logQueue(target
            ? `Item ${live.id}: after its interrupted wait it steps back behind ${target.id}; it resumes after it`
            : `Item ${live.id}: after its interrupted wait nothing follows in its lane — held as staged until sent again`);
        this.persist();
        this._onDidChange.fire();
        setTimeout(() => { void this.sendNext(); }, 0);
    }

    /** Add one stage's usage to the item's run sum (`sendUsage`), so the queue editor shows it while the item runs. */
    private _addItemSendUsage(item: QueuedPrompt, usage: LiveTrailTokenCounts | undefined): void {
        const live = this._items.find(i => i.id === item.id) ?? item;
        const next = addStageUsage(live.sendUsage, usage);
        if (next === live.sendUsage) { return; }
        live.sendUsage = next;
        this.persist();
        this._onDidChange.fire();
    }

    private _clearRetryOnDispatchSuccess(item?: QueuedPrompt): void {
        const sending = item ?? this._items.find(i => i.status === 'sending');
        if (!sending) { return; }
        if (sending.retryAttempt === undefined && sending.retryUntil === undefined) { return; }
        clearRetryBookkeeping(sending);
        this.persist();
    }

    /**
     * Dispatch the **main** queue stage, running a Quest Refresh first when due.
     *
     * qr1: the refresh used to fire re-entrantly inside the queued turn's own
     * `sendMessage` (the queue never modelled that nested send, and a failing
     * refresh dropped the user's prompt). It now runs here as an explicit,
     * sequential step via {@link runMainStageWithRefresh}: the refresh is its
     * own dispatch, its failure is isolated, then the main prompt is sent with
     * `skipQuestRefresh:true` so `sendMessage`'s own hook stays inert for the
     * queue. The interactive send path keeps that hook (it works there).
     *
     */
    private async _dispatchMainStageWithRefresh(
        item: QueuedPrompt,
        resolved: ReturnType<typeof this.resolveStageTransport>,
    ): Promise<{ answerText: string; superseded?: true }> {
        const { QuestRefreshService } = await import('../services/quest-refresh-service.js');
        const { QuestRefreshStore } = await import('./questRefreshStore.js');
        const quest = WsPaths.getWorkspaceQuestId();
        return runMainStageWithRefresh({
            shouldRefresh: () => QuestRefreshService.instance.shouldAutoRefresh('anthropic', quest),
            runRefresh: () => QuestRefreshService.instance.runRefresh(
                'anthropic',
                // The refresh prompt is its own sequential dispatch: skip the
                // refresh hook (no count / no recursion) and don't propagate its
                // maintenance answer's responseValues.
                (refreshText) => this.dispatchStage(refreshText, { ...resolved, iterationKey: undefined }, undefined, true, false).then(() => undefined),
                quest,
            ),
            incrementCount: () => { QuestRefreshStore.instance.incrementCount('anthropic', quest); },
            // A process item (the work of a process step) neither counts nor triggers a due refresh.
            counts: !item.processItem,
            onRefreshError: (err) => logQueue(
                `Quest Refresh failed — the main prompt is dispatched next: ${err instanceof Error ? err.message : String(err)}`,
            ),
            // A stage dispatchStage would refuse (no direct-API key) runs no
            // refresh: it would be refused the same way, and the refresh stays
            // due for the next stage that can run.
            stageRefused: () => stageKeyRefusal(loadSendToChatConfig()?.anthropic, {
                profileId: resolved.anthropicProfileId,
                configId: resolved.anthropicConfigId,
            }, process.env),
            sendMain: () => this.dispatchStage(item.expandedText, resolved, item, true),
        });
    }

    /**
     * Delegates to the shared `itemHasInFlightProgress` helper in
     * `queueErrorTransitions.ts` — kept as a thin private wrapper so
     * call sites in this file stay readable. See the helper's doc
     * comment for the contract.
     */
    private _itemHasInFlightProgress(item: QueuedPrompt): boolean {
        return itemHasInFlightProgress(item);
    }

    /**
     * The pause gate, checked just before a further prompt of `item` would go
     * out: with auto-send off, an item that has already sent a prompt holds
     * here in `sending` (SENDING (PAUSED)), and turning auto-send on resumes
     * it. The first prompt always goes out, which is how Send Now runs an item
     * while the queue is paused.
     */
    private _pauseBeforeNextDispatch(item: QueuedPrompt): boolean {
        // The item's run's auto-send (settings per run).
        if (!pausesBeforeNextDispatch(this._autoSendFor(item), item)) { return false; }
        // Between prompts and paused: none is in flight, so the item is idle
        // (its header goes amber).
        item.awaitingAnswer = false;
        item.inFlightRepetition = undefined;
        logQueue(`dispatchNext: run ${laneOf(item, true)} paused, leaving item ${item.id} in 'sending' with progress preserved`);
        return true;
    }

    /**
     * If `sending` is one iteration of a template-repeat sequence and
     * more iterations remain, enqueue the next one as a fresh pending
     * item with `templateRepeatIndex` advanced by one. Returns `true`
     * iff an iteration was actually enqueued.
     *
     * Called from every completion site:
     *  - manual continue (`continueSending`),
     *  - `sendItem` completion,
     *  - `_resumePausedSendingItem` completion,
     *  - `resendLastPrompt` completion.
     *
     * The last three were missing prior to this method and caused
     * Anthropic items with `templateRepeatCount > 1` to terminate
     * after the first iteration — so retrying the same prompt after
     * an error appeared to "always start at iteration 1 again" instead
     * of continuing the outer loop.
     */
    /**
     * Take up the inbox files other quests' windows wrote for this window's
     * workspace (tomAi_sendItemToQuest; src/utils/questInbox.ts): claim each
     * by renaming it (so a second window on the quest leaves it), queue it as
     * an item with this queue's defaults, delete it. A file that cannot be
     * read is set aside as `<file>.rejected`. Answers how many were queued.
     */
    async takeInbox(): Promise<number> {
        if (this._takingInbox) { return 0; }
        const folder = getQueueFolder();
        if (!folder || !fs.existsSync(folder)) { return 0; }
        this._takingInbox = true;
        let taken = 0;
        try {
            const host = os.hostname();
            const workspace = getWorkspaceName();
            const files = [...listInboxFiles(folder, host, workspace), ...listStaleClaims(folder, host, workspace, Date.now())];
            for (const file of files) {
                const claimed = claimInboxFile(folder, file, getWindowStatusWindowId());
                if (!claimed) { continue; }
                const parsed = parseInboxItem(fs.readFileSync(claimed, 'utf-8'));
                if (!parsed.ok) {
                    const aside = rejectClaimedFile(claimed);
                    logQueue(`Inbox file ${file} rejected (${parsed.error}); kept as ${path.basename(aside)}`);
                    continue;
                }
                await this._queueInboxItem(parsed.item, file);
                fs.rmSync(claimed, { force: true });
                taken += 1;
            }
        } catch (err) {
            logQueueError('inbox', err);
        } finally {
            this._takingInbox = false;
        }
        return taken;
    }

    /**
     * Queue one inbox item with this queue's defaults (what the sender left
     * unset stays unset). Its new session is created now, before the first
     * send. A profile or session this window does not have makes the item an
     * error — queued all the same, so its done-notification tells the sender.
     */
    private async _queueInboxItem(inbox: InboxItem, file: string): Promise<void> {
        const section = loadSendToChatConfig()?.anthropic as ProfileSection | undefined;
        const folder = this.sessionsFolder();
        const conversion = planInboxConversion(inbox, {
            profileExists: (id) => !!lookupProfile(section, id),
            readSession: (name) => readSession(folder, name),
            now: new Date(),
            token: randomUUID().slice(0, 8),
            runExists: (run) => questRunExists(WsPaths.getWorkspaceQuestId() || 'default', run),
        });
        let error = conversion.error;
        let created: string | undefined;
        if (!error && conversion.createSession) {
            const c = conversion.createSession;
            const model = c.profile ? lookupProfile(section, c.profile)?.model : undefined;
            const made = createSession(folder, c.name, {
                basedOn: c.basedOn,
                mode: c.mode,
                ...(c.profile ? { profile: { id: c.profile, ...(model ? { model } : {}) } } : {}),
                ...(c.contributesToTrailAndMemory !== undefined ? { contributesToTrailAndMemory: c.contributesToTrailAndMemory } : {}),
            });
            if (made.ok) { created = c.name; } else { error = made.error; }
        }
        // An item another quest sends is deliberate: it is queued even when its todos already are.
        // `queueNext` (the todo panel's "next", vscimpb139): at the front of its run's queue.
        // Its run: the one the sender named, else `default` (vscimpb168) — never this window's current run, nor a
        // process position the take-up happens to run in: a delivered item does not land in the run the user works on.
        const { queueNext, ...named } = conversion.enqueue;
        const asQueued = { ...named, run: named.run ?? DEFAULT_RUN, runIsExplicit: true as const };
        const withoutSession = { ...asQueued, session: undefined, temporarySession: undefined, allowDuplicateTodo: true };
        let item: QueuedPrompt;
        try {
            item = error
                ? await this.enqueue({ ...withoutSession, initialStatus: 'staged', deferSend: true })
                : queueNext
                    ? await this.enqueueNext({ ...asQueued, allowDuplicateTodo: true })
                    : await this.enqueue({ ...asQueued, initialStatus: 'pending', allowDuplicateTodo: true });
        } catch (refused) {
            // The item's profile cannot continue the session's conversation (sessionRefusal).
            error = (refused as Error).message;
            if (created && conversion.createSession?.temporary) { this._deleteTemporarySession(created); }
            item = await this.enqueue({ ...withoutSession, initialStatus: 'staged', deferSend: true });
        }
        if (error) {
            applyErrorTransition(item, `Sent by ${inbox.from.quest}: ${error}`);
            this.persist();
            this._onDidChange.fire();
            logQueue(`Inbox item from ${inbox.from.quest} (${file}) queued as error ${item.id}: ${error}`);
            await this._itemFinished(item, { kind: 'error', message: item.error ?? error });
            return;
        }
        logQueue(`Inbox item from ${inbox.from.quest} (${file}) queued as ${item.id}${created ? ` in new session ${created}` : ''}`);
    }

    /**
     * Everything that follows an item reaching `sent`: its next template
     * iteration, or — when it was the last — its done-notification and the
     * clean-up of a temporary session. Called on every completion path,
     * before the queue decides whether to advance (so a "pause after this"
     * the notification takes over is already moved).
     */
    private async _afterItemDone(sending: QueuedPrompt, reason: string): Promise<void> {
        const nextIteration = await this._enqueueNextTemplateIterationIfNeeded(sending, reason);
        if (nextIteration) { return; }
        await this._itemFinished(sending, { kind: 'done' });
    }

    /**
     * The item is finished — done, or ended in an error that will not recover:
     * queue its done-notification (once per run) ahead of every pending item,
     * and delete its temporary session unless the notification runs in it.
     */
    private async _itemFinished(item: QueuedPrompt, outcome: ItemOutcome): Promise<void> {
        try {
            const ownQuest = WsPaths.getWorkspaceQuestId() || 'default';
            const plan = planDoneNotification(item as DoneNotificationItem, outcome, this._items, ownQuest, this._todoStatusLookup(ownQuest));
            const deleteSessionNow = deletesTemporarySession(item as DoneNotificationItem, plan);
            if (plan) {
                applyPlanToItem(item as DoneNotificationItem, plan);
                await this._deliverDoneNotification(item, plan, outcome);
            }
            if (deleteSessionNow && item.session) {
                item.temporarySession = false;
                this.persist();
                this._deleteTemporarySession(item.session);
            }
        } catch (err) {
            logQueueError(`done-notification of ${item.id}`, err);
        }
    }

    /** `${itemTodos}`: each todo's status now, archived todos included. */
    private _todoStatusLookup(ownQuest: string): { todoStatus(id: string): string | undefined } {
        return {
            todoStatus: (id) => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const qt = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
                    return qt.readAllTodos(ownQuest, qt.ALL_TODO_FILES).find((t) => t.id === id)?.status;
                } catch { return undefined; }
            },
        };
    }

    /** Who queued item `id` (QueuedPrompt.queuedBy), for the todo completion hook. */
    queuedByOf(id: string): QueuedBy | undefined {
        const q = this._items.find((i) => i.id === id)?.queuedBy;
        return q ? { ...q } : undefined;
    }

    /** Record who queued item `id` (a chat send the todo panel made with its Done notification box on). */
    setItemQueuedBy(id: string, queuedBy: QueuedBy | undefined): void {
        const item = this._items.find((i) => i.id === id);
        if (!item) { return; }
        if (queuedBy) { item.queuedBy = { ...queuedBy }; } else { delete item.queuedBy; }
        this.persist();
    }

    /** Queue a planned done notification: into this queue, or another quest's inbox. */
    private async _deliverDoneNotification(item: QueuedPrompt, plan: NonNullable<ReturnType<typeof planDoneNotification>>, outcome: ItemOutcome): Promise<void> {
        const ownQuest = WsPaths.getWorkspaceQuestId() || 'default';
        if (plan.targetQuest) {
            // Another quest: posted into its inbox, queued there with its own defaults in the named run.
            const posted = this._doneNotificationPoster()({
                quest: plan.targetQuest,
                run: plan.targetRun,
                text: plan.text,
                notificationOf: item.id,
                from: { quest: ownQuest, run: item.run || DEFAULT_RUN },
            });
            item.doneNotificationPosted = {
                quest: plan.targetQuest, run: plan.targetRun, file: posted.file, waiting: !posted.targetRunning, at: new Date().toISOString(),
            };
            this.persist();
            this._onDidChange.fire();
            logQueue(`Item ${item.id} finished (${outcome.kind}): done-notification posted to ${plan.targetQuest} / ${plan.targetRun}`
                + `${posted.targetRunning ? '' : ' (no window of that quest is running: it waits in its inbox)'}`);
        } else {
            this.persist();
            const notification = await this.enqueue({
                run: plan.targetRun,
                ...(plan.explicitRun ? { runIsExplicit: true } : {}),
                originalText: plan.text,
                position: plan.position,
                initialStatus: 'pending',
                deferSend: true,
                transport: plan.transport,
                anthropicProfileId: plan.anthropicProfileId,
                anthropicConfigId: plan.anthropicConfigId,
                ...(plan.session ? { session: plan.session } : {}),
                pauseAfter: plan.pauseAfter,
                notificationOf: plan.notificationOf,
                temporarySession: plan.temporarySession,
                ...(item.from ? { from: item.from } : {}),
            });
            logQueue(`Item ${item.id} finished (${outcome.kind}): done-notification ${notification.id} queued next in run ${notification.run ?? DEFAULT_RUN}`);
        }
    }

    /** Posts a done notification into another quest's inbox; replaceable for tests. */
    private _postDoneNotification?: DoneNotificationPoster;

    /** Set the poster of done notifications for other quests (tests); undefined restores the live one. */
    setDoneNotificationPoster(poster: DoneNotificationPoster | undefined): void {
        this._postDoneNotification = poster;
    }

    private _doneNotificationPoster(): DoneNotificationPoster {
        if (this._postDoneNotification) { return this._postDoneNotification; }
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { liveQuestSendAccess } = require('../tools/chat-enhancement-tools') as typeof import('../tools/chat-enhancement-tools');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { postInboxItem } = require('../tools/send-to-quest-tools') as typeof import('../tools/send-to-quest-tools');
        return (n) => postInboxItem(liveQuestSendAccess, n.quest, {
            text: n.text,
            run: n.run,
            notificationOf: n.notificationOf,
            from: { ...n.from, ...liveQuestSendAccess.sender(), sentAt: new Date().toISOString() },
        });
    }

    /**
     * Delete a temporary session: its file and its whole storage — history,
     * trails, live trail, tool results (src/services/sessionStorage.ts).
     */
    private _deleteTemporarySession(name: string): void {
        if (isRunDefaultSession(name) || name === 'chat') { return; }
        try {
            const folder = this.sessionsFolder();
            const result = deleteSession(folder, name);
            if (!result.ok) { logQueue(`Temporary session ${name} kept: ${result.error}`); return; }
            removeSessionStorage(folder, name);
            logQueue(`Temporary session ${name} deleted`);
        } catch (err) {
            logQueueError(`delete temporary session ${name}`, err);
        }
    }

    private async _enqueueNextTemplateIterationIfNeeded(
        sending: QueuedPrompt,
        reason: string,
    ): Promise<boolean> {
        if (this._repeatRuns.delete(sending.id)) {
            logQueue(`Template repeat check (${reason}): item ${sending.id} was run again with Send Now — its next template iteration was queued by its first run`);
            return false;
        }
        const resolvedTemplateRepeatCount = resolveRepeatCount(sending.templateRepeatCount);
        logQueue(`Template repeat check (${reason}): templateRepeatCount=${String(sending.templateRepeatCount)}, resolved=${resolvedTemplateRepeatCount}, templateRepeatIndex=${sending.templateRepeatIndex}, repeatCount=${String(sending.repeatCount)}`);
        const params = buildNextTemplateIterationParams(sending, resolvedTemplateRepeatCount);
        if (!params) {
            return false;
        }
        const { progressLabel: _progressLabel, ...enqueueParams } = params;
        await this.enqueue({
            ...enqueueParams,
            type: enqueueParams.type as QueuedPromptType | undefined,
        });
        logQueue(`Repeat ${params.progressLabel} queued for item ${sending.id} (${reason})`);
        return true;
    }

    /**
     * See `DispatchOutcome` for the return-value contract. Callers
     * that interpret the result wrongly (e.g. marking the item
     * `'sent'` on `'paused'`) will leak the in-flight cursor and
     * break the resume semantics — keep them in sync with this
     * comment and `_itemHasInFlightProgress`.
     */
    /** Take item `item` over for a new dispatch frame (an older one stops at its next stage). */
    private _claimFrame(item: QueuedPrompt): symbol {
        const frame = Symbol(item.id);
        this._frameOwners.set(item.id, frame);
        return frame;
    }

    /** The frame is done: the item has no owner any more, unless another frame took it over meanwhile. */
    private _releaseFrame(item: QueuedPrompt, frame: symbol): void {
        if (this._frameOwners.get(item.id) === frame) { this._frameOwners.delete(item.id); }
    }

    /**
     * Right after a stage's dispatch returned: whether this frame must stop
     * instead of going on (vscimpb54) — the turn ended after an explicit
     * Continue / Stop / Resend (`superseded`: the Agent SDK ends a cancelled
     * turn normally), another frame took the item over, or the item is no
     * longer `sending`. Whatever the transport reported.
     */
    private _frameLostAfterDispatch(item: QueuedPrompt, frame: symbol | undefined, result: { superseded?: true }): boolean {
        const why = result.superseded
            ? 'its turn ended after an explicit Continue / Stop / Resend'
            : frame && this._frameOwners.get(item.id) !== frame
                ? 'another dispatch frame took the item over'
                : this._items.find(i => i.id === item.id)?.status !== 'sending'
                    ? 'the item is no longer sending'
                    : '';
        if (!why) { return false; }
        logQueue(`dispatchNext: ${item.id} — ${why}; this frame stops without going on`);
        return true;
    }

    /** Whether a dispatch frame is running for item `id` (a stage of it is in flight). */
    private _frameActive(id: string): boolean {
        return this._frameOwners.has(id);
    }

    /** Run the item's next stages as one frame that owns the item (see `_frameOwners`). */
    private async _runDispatchFrame(item: QueuedPrompt, frame: symbol = this._claimFrame(item)): Promise<DispatchOutcome> {
        try {
            return await this.dispatchNextStageForSendingItem(item, frame);
        } finally {
            this._releaseFrame(item, frame);
        }
    }

    /**
     * Whether `item` is held at the pause gate and so may be resumed: it is
     * `sending` with progress, no dispatch frame runs for it and no prompt of
     * it awaits its answer. An item whose stage is still in flight is not —
     * switching auto-send on lets its running frame go on past the gate by
     * itself; a second frame beside it would dispatch the same walk twice.
     */
    private _isPausedAtGate(item: QueuedPrompt): boolean {
        return item.status === 'sending' && this._itemHasInFlightProgress(item)
            && !this._frameActive(item.id) && item.awaitingAnswer !== true;
    }

    /** Continuations a walk iteration of `item` gets: its own, else the queue's. */
    walkContinuationsOf(item: QueuedPrompt): number {
        return item.walkContinuations ?? this._itemSettings(item).walkContinuations;
    }

    /** The window's run's default for walk continuations (setting `walk-continuations`). */
    get walkContinuations(): number { return this._settingsOf(undefined).walkContinuations; }
    set walkContinuations(n: number) {
        if (validContinuations(n) === undefined) { return; }
        this.setRunQueueSettings(undefined, { walkContinuations: n });
    }

    /**
     * A walk iteration's todo is not completed after its main prompt answered
     * (utils/walkCompletionCheck.ts): unless the todo says why — blocked,
     * decision-needed, an open decision — or a question waits, send the
     * continuation into the iteration's own session, up to the item's (or the
     * queue's) number of continuations. The iteration's answer is the last
     * turn's; the earlier ones go on its repetition answer, folded. Still not
     * completed: the item stops as needs attention — auto-send off, the reason
     * on the item — and is held before the next todo. 'stop': this frame ends here.
     */
    private async _continueUnfinishedIteration(
        item: QueuedPrompt,
        frame: symbol | undefined,
        todoId: string,
        resolved: Parameters<PromptQueueManager['dispatchStage']>[1],
    ): Promise<'ok' | 'stop'> {
        const questId = this.activeQuestId();
        if (!questId) { return 'ok'; }
        const max = this.walkContinuationsOf(item);
        const earlier: string[] = [];
        for (let n = 0; ; n++) {
            const verdict = completionVerdict(readQuestTodo(questId, todoId), AskUserRegistry.instance.pendingForQueueItem(item.id) !== undefined);
            if (verdict.kind !== 'continue') {
                if (verdict.kind === 'reason') { logQueue(`Walk ${item.id}: todo ${todoId} not completed, but ${verdict.why} — no continuation`); }
                return 'ok';
            }
            if (n >= max) {
                item.needsAttention = needsAttentionReason(todoId, verdict.status, n);
                this._pauseRunOf(item, `walk ${item.id} needs attention`);
                this.persist();
                this._onDidChange.fire();
                logQueue(`Walk ${item.id}: todo ${todoId} still ${verdict.status} after ${n} continuation(s) — needs attention, auto-send off`);
                // Settle the iteration (its answer onto the todo) and hold before the next todo.
                return 'ok';
            }
            earlier.push(item.answerText ?? '');
            logQueue(`Walk ${item.id}: todo ${todoId} is ${verdict.status} after its turn — continuation ${n + 1} of ${max} in the same session`);
            const result = await this.dispatchStage(continuationPrompt(todoId), resolved, item);
            if (this._frameLostAfterDispatch(item, frame, result)) { return 'stop'; }
            // The iteration's answer is this last turn's; its chip says how many continuations it took.
            const entry = item.repetitionAnswers?.find((a) => a.key === todoId);
            if (entry) {
                entry.continuations = n + 1;
                entry.earlier = earlier.filter((t) => t.trim() !== '');
            }
            this.persist();
            this._onDidChange.fire();
        }
    }

    private async dispatchNextStageForSendingItem(item: QueuedPrompt, frame?: symbol): Promise<DispatchOutcome> {
        // A frame dispatches only for an item that is still sending and still its own (vscimpb53):
        // a stage that ended after the item was sent, removed or failed, or after another
        // frame took the item over, must not send the next one.
        const live = this._items.find(i => i.id === item.id);
        if (!live || live.status !== 'sending') {
            logQueue(`dispatchNext: item ${item.id} is ${live ? `'${live.status}'` : 'gone'} — this frame stops, nothing more is dispatched`);
            return 'paused';
        }
        if (frame && this._frameOwners.get(item.id) !== frame) {
            logQueue(`dispatchNext: item ${item.id} was taken over by another dispatch frame — this one stops`);
            return 'paused';
        }
        // Re-entering the dispatcher means the previous dispatch concluded
        // (its answer arrived, or the user advanced past it), so a todo claim
        // it made is settled: the todo keeps whatever status it now has, and
        // when it is completed it keeps the main prompt's answer (todoLastAnswer.ts).
        if (item.todoClaim) {
            const answer = item.lastDispatched?.kind === 'main' ? item.answerText : undefined;
            const outcome = recordTodoAnswer(QUEST_TODO_ANSWER_PORT, item.todoClaim, answer);
            if (outcome === 'written' || outcome === 'write-failed') {
                logQueue(`Todo answer ${outcome === 'written' ? 'kept on' : 'could not be written to'} ${item.todoClaim.questId}/${item.todoClaim.todoId} (${answer?.length ?? 0} chars)`);
            }
            // The todo's follow-up, once its answer is on it (ww_a_collab-5).
            if (!item.todoClaim.released) { await this._settleTodoOnDone(item.todoClaim, item); }
            // A group todo the item ran as a TODO item stays a group unless it was completed.
            const group = settleGroupClaim(QUEST_TODO_STATUS_PORT, item.todoClaim);
            if (group === 'restored' || group === 'failed') {
                logQueue(`Group todo ${item.todoClaim.questId}/${item.todoClaim.todoId} not completed by its TODO item — ${group === 'restored' ? 'back to group' : 'could not be set back to group'}`);
            }
            item.todoClaim = undefined;
        }
        // The pause gate (auto-send off) is checked in each stage just before
        // a further prompt would go out (`_pauseBeforeNextDispatch`), not
        // here: an item with nothing left falls through to 'done' and becomes
        // `sent` whether auto-send is on or off.

        // Entering a fresh dispatch attempt: any snapshot from the previous
        // (now-succeeded) dispatch is moot. Clear it so that a failure during
        // prompt expansion — before this attempt advances any counter — does
        // not roll back the *previous* repetition. The snapshot is re-set the
        // instant this attempt bumps a stage counter.
        item.inFlightRepetition = undefined;
        // The run the iteration keys belong to (src/utils/queueIterations.ts).
        ensureRunId(item, () => randomUUID().slice(0, 8));

        // Stage 1: Pre-prompts with individual repeat support.
        // Each stage uses a stable numeric repeat target for normal loop control.
        const prePrompts = item.prePrompts || [];
        for (let ppIndex = 0; ppIndex < prePrompts.length; ppIndex++) {
            const pp = prePrompts[ppIndex];
            const ppSentCount = pp.repeatIndex || 0;
            const ppRepeatCount = this.resolveStableRepeatCount(pp.repeatCount, pp.resolvedRepeatCount, ppSentCount, `PP#${ppIndex + 1}`);
            if (pp.resolvedRepeatCount !== ppRepeatCount) {
                pp.resolvedRepeatCount = ppRepeatCount;
                this.persist();
                this._onDidChange.fire();
            }
            logQueue(`PP dispatch: repeatCount=${String(pp.repeatCount)}, resolved=${ppRepeatCount}, cachedResolved=${pp.resolvedRepeatCount}, sentCount=${ppSentCount}`);
            if (ppSentCount < ppRepeatCount) {
                if (this._pauseBeforeNextDispatch(item)) { return 'paused'; }
                // A pre-prompt runs in the iteration it precedes.
                const resolved = { ...this.resolveStageTransport(item, pp), iterationKey: iterationKeyFor(item, 'prePrompt'), item };
                const prePromptExpanded = await runInProcessPosition(item.processRun, () => runWithQueueRole(this.stageRoleSource(item, 'prePrompt'), () => this._buildExpandedText(
                    pp.text,
                    this._templateOf(pp.template, item),
                    { repeatCount: ppRepeatCount, repeatIndex: ppSentCount },
                    {
                        templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
                        templateRepeatIndex: item.templateRepeatIndex,
                    },
                    this.iterationTodoBlock(item, 'prePrompt'),
                )));
                pp.status = 'sent';
                pp.repeatIndex = ppSentCount + 1;
                // Record the advance so a failed send can roll back to re-send
                // this same pre-prompt repetition (not the next one).
                item.inFlightRepetition = { stage: 'prePrompt', stageIndex: ppIndex, prevRepeatIndex: ppSentCount };
                item.expandedText = prePromptExpanded;
                item.sentAt = new Date().toISOString();
                item.awaitingAnswer = true; // in flight — a prompt is being processed
                this.persist();
                this._onDidChange.fire();

                // Snapshot what we're about to send so Resend can replay it.
                item.lastDispatched = {
                    kind: 'prePrompt',
                    prePromptIndex: ppIndex,
                    expandedText: prePromptExpanded,
                    transport: resolved.transport,
                    anthropicProfileId: resolved.anthropicProfileId,
                    anthropicConfigId: resolved.anthropicConfigId,
                    iterationKey: resolved.iterationKey,
                    dispatchedAt: new Date().toISOString(),
                };
                const dispatchResult = await this.dispatchStage(prePromptExpanded, resolved, pp);
                if (this._frameLostAfterDispatch(item, frame, dispatchResult)) { return 'paused'; }
                this._onPromptSent.fire(item);
                logQueue(`Pre-prompt sent (${ppSentCount + 1}/${ppRepeatCount}) via ${resolved.transport}`);
                // Advance to the next stage. The recursive call hits the pause
                // gate first thing, so pause-mid-flight propagates up.
                this.persist();
                this._onDidChange.fire();
                return await this.dispatchNextStageForSendingItem(item, frame);
            }
        }

        // Stage 2: Main prompt with repeat support.
        const mainSentCount = item.repeatIndex || 0;
        const mainRepeatCount = this.resolveStableRepeatCount(item.repeatCount, item.resolvedRepeatCount, mainSentCount, 'MP');
        if (item.resolvedRepeatCount !== mainRepeatCount) {
            item.resolvedRepeatCount = mainRepeatCount;
            this.persist();
            this._onDidChange.fire();
        }
        // TODO ITERATION (`prefix*` repeat count): the loop is driven by the
        // quest's numbered todos rather than by a counter. `planMainStageDispatch`
        // reduces both modes to one gate.
        const isTodoIteration = parseTodoWalk(item.repeatCount) !== undefined;
        const iterationQuestId = isTodoIteration ? this.activeQuestId() : undefined;
        if (iterationQuestId) {
            // A blocked todo of the series whose blockers are all done (or gone)
            // goes back to not-started first, so this pick can take it — e.g. a
            // todo that waited on an earlier one of the same list.
            const unblocked = releaseUnblockedTodos(item.repeatCount, iterationQuestId, QUEST_TODO_UNBLOCK_PORT);
            for (const u of unblocked.released) {
                logQueue(`MP dispatch: todo ${u.id} unblocked (blockers done or gone: ${u.blockers.join(', ')})`);
            }
            for (const id of unblocked.failed) {
                logQueue(`MP dispatch: todo ${id} could be unblocked, but writing not-started failed — it stays blocked`);
            }
        }
        // A plain item that names its todo (the todo panel's Queue button): a blocked todo holds it before its
        // prompt goes out; blockers completed in the meantime never do.
        if (!isTodoIteration && mainSentCount === 0) {
            const plainQuest = this.activeQuestId();
            const blockedOn = plainQuest ? this._todoBlockOf(item, plainQuest) : undefined;
            if (blockedOn) {
                this._holdTodoBlocked(item, blockedOn.why, blockedOn.id);
                return 'paused';
            }
        }
        const plan = planMainStageDispatch(
            item.repeatCount,
            mainSentCount,
            mainRepeatCount,
            iterationQuestId ? walkEntriesOf(item, iterationQuestId) : [],
        );
        if (plan.mode === 'todo-blocked') {
            // The todo the walk would take next waits for a todo that is not completed: hold the item there
            // (the todos before it have run), as at an open decision.
            const t = plan.todos[0];
            this._holdTodoBlocked(item, `todo ${t.id} ${t.blockedReason ?? 'is blocked'}`, t.id);
            return 'paused';
        }
        if (plan.mode === 'decision-needed') {
            // The todo the walk would take next is still waiting on the user:
            // hold the item there (the todos before it have run). Auto-send goes OFF so the queue
            // does not simply move on to the next item and bury the question.
            const waiting = plan.todos.map(t => (t.title ? `${t.id} (${t.title})` : t.id)).join(', ');
            logQueue(`MP dispatch: todo iteration '${String(item.repeatCount)}' blocked — decision needed on ${waiting}`);
            item.status = 'decision-needed';
            item.awaitingAnswer = false;
            item.inFlightRepetition = undefined;
            if (this._pauseRunOf(item, `walk ${item.id} waits for a decision`)) { item.holdPausedRun = true; }
            this.persist();
            this._onDidChange.fire();
            return 'paused';
        }
        if ((plan.mode === 'todo' || plan.mode === 'exhausted') && plan.waitingForUser) {
            // The user's own todos are passed, not sent: they stay not-started
            // for the user, and the series goes on without them.
            const forUser = plan.waitingForUser.map(t => (t.title ? `${t.id} (${t.title})` : t.id)).join(', ');
            logQueue(`MP dispatch: todo iteration '${String(item.repeatCount)}' passes the user's todos (user_action): ${forUser}`);
        }
        // Something of the main stage is left to send: hold here when paused,
        // before a todo is claimed for it.
        if (plan.mode !== 'exhausted' && this._pauseBeforeNextDispatch(item)) { return 'paused'; }
        // An item marked "send between iterations" goes now, before this
        // loop's next iteration: it moves in front of the loop item, which
        // steps back to pending with its counters kept and resumes after it.
        // With lanes (Queue per run) only a marked item of this loop's own lane steps in; another lane's runs on its own.
        // "Let the next item go first" (vscimpb60e): the iteration that ran is finished — its answer, its waits,
        // its continuation check — and the next one has not started. The item steps back (counters, run id and
        // answers kept) behind the next pending item of its lane, which goes now; the walk resumes after it.
        if (item.yieldAfterIteration) {
            item.yieldAfterIteration = undefined;
            const target = mainSentCount >= 1 && plan.mode !== 'exhausted' ? yieldTarget(this._laneItemsOf(item), item) : undefined;
            if (target) {
                this._items = orderForYield(this._items, item, target);
                item.status = 'pending';
                item.awaitingAnswer = false;
                item.inFlightRepetition = undefined;
                logQueue(`MP dispatch: item ${item.id} lets ${target.id} go first after iteration ${mainSentCount}; it resumes after it`);
                this.persist();
                this._onDidChange.fire();
                setTimeout(() => { void this.sendNext(); }, 0);
                return 'paused';
            }
            logQueue(`MP dispatch: item ${item.id} was to let the next item go first, but ${plan.mode === 'exhausted' ? 'its walk is done' : 'no pending item follows it in its lane'} — it goes on`);
            this.persist();
        }
        const between = itemToSendBetween(this._items.filter(i => i === item || laneOf(i, true) === laneOf(item, true)), item, mainSentCount, plan.mode !== 'exhausted');
        if (between) {
            this._items = orderForBetween(this._items, item, between);
            item.status = 'pending';
            item.awaitingAnswer = false;
            item.inFlightRepetition = undefined;
            logQueue(`MP dispatch: item ${item.id} steps aside after iteration ${mainSentCount} — ${between.id} is sent between iterations`);
            this.persist();
            this._onDidChange.fire();
            // After this frame unwinds (its callers leave a 'paused' item alone).
            setTimeout(() => { void this.sendNext(); }, 0);
            return 'paused';
        }
        // The todo that this dispatch will work on, already marked in-progress.
        // Marking happens BEFORE the send: an in-progress todo no longer
        // qualifies, and that is what makes the walk terminate. A write that
        // doesn't stick would have the same todo picked on every pass, so it
        // ends the iteration rather than spinning.
        const iterationTodo = plan.mode === 'todo' && this.claimQuestTodo(item, plan.todo)
            ? plan.todo
            : undefined;
        const hasMainToSend = plan.mode === 'counter' || iterationTodo !== undefined;
        if (isTodoIteration && !hasMainToSend && mainSentCount === 0) {
            // Nothing ever went out. Silence here looks like a dropped prompt,
            // so name the reason.
            logQueue(`MP dispatch: todo iteration '${String(item.repeatCount)}' has no dispatchable todo — main prompt skipped`);
        }
        if (hasMainToSend) {
            // The main prompt starts the next iteration.
            const resolved = { ...this.resolveStageTransport(item), iterationKey: iterationKeyFor(item, 'main'), item };
            item.expandedText = await runInProcessPosition(item.processRun, () => runWithQueueRole(this.stageRoleSource(item, 'main', iterationTodo?.id), () => this._buildExpandedText(
                item.originalText,
                this._templateOf(item.template, item),
                {
                    repeatCount: mainRepeatCount,
                    // In todo mode the "repetition number" is the todo's own
                    // number, so `${repeatNumber}` prints `7` for `dsa7` —
                    // uniform with counter mode, where it prints the rep.
                    repeatIndex: iterationTodo ? iterationTodo.index - 1 : mainSentCount,
                    repeatPrefix: item.repeatPrefix,
                    repeatSuffix: item.repeatSuffix,
                    repeatTodoId: iterationTodo?.id,
                    repeatTodoTitle: iterationTodo?.title,
                },
                {
                    templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
                    templateRepeatIndex: item.templateRepeatIndex,
                },
                this.iterationTodoBlock(item, 'main', iterationTodo?.id),
            )));
            // In todo mode the counter follows the todo's own number, so the
            // entry reads "todo 7 of 9" rather than "rep 3 of 9".
            const prevRepeatTodoId = item.repeatTodoId;
            item.repeatIndex = iterationTodo ? iterationTodo.index : mainSentCount + 1;
            item.repeatTodoId = iterationTodo?.id ?? item.repeatTodoId;
            // Record the advance so a failed send can roll back to re-send this
            // same main-prompt repetition instead of skipping to the next.
            const prevIterationSeq = item.iterationSeq ?? 0;
            item.iterationSeq = prevIterationSeq + 1;
            item.inFlightRepetition = {
                stage: 'main',
                prevRepeatIndex: mainSentCount,
                todoId: iterationTodo?.id,
                prevRepeatTodoId,
                prevIterationSeq,
            };
            item.sentAt = new Date().toISOString();
            item.awaitingAnswer = true; // in flight — a prompt is being processed
            // The walk goes on: a needs-attention stop is over.
            delete item.needsAttention;
            this.persist();
            this._onDidChange.fire();

            // Snapshot what we're about to send so Resend can replay it.
            item.lastDispatched = {
                kind: 'main',
                expandedText: item.expandedText,
                transport: resolved.transport,
                anthropicProfileId: resolved.anthropicProfileId,
                anthropicConfigId: resolved.anthropicConfigId,
                iterationKey: resolved.iterationKey,
                dispatchedAt: new Date().toISOString(),
            };
            // Main stage: counts toward the Quest Refresh interval (and may
            // trigger an auto-refresh before it sends). qr1 — the refresh runs
            // as an explicit sequential pre-step here, not via a re-entrant
            // `sendMessage` hook, so a failing refresh can't drop this prompt.
            const dispatchResult = await this._dispatchMainStageWithRefresh(item, resolved);
            if (this._frameLostAfterDispatch(item, frame, dispatchResult)) { return 'paused'; }
            this._onPromptSent.fire(item);
            logQueue(iterationTodo
                ? `Main prompt sent for todo ${iterationTodo.id} (${iterationTodo.index}/${mainRepeatCount}) via ${resolved.transport}`
                : `Main prompt sent (${mainSentCount + 1}/${mainRepeatCount}) via ${resolved.transport}`);
            this.persist();
            this._onDidChange.fire();
            // A walk iteration whose todo is not completed gets continuations in its own session first.
            if (iterationTodo && await this._continueUnfinishedIteration(item, frame, iterationTodo.id, resolved) === 'stop') {
                return 'paused';
            }
            return await this.dispatchNextStageForSendingItem(item, frame);
        }

        // Stage 3: Follow-ups with individual repeat support.
        const followUps = item.followUps ?? [];
        const currentFuIndex = item.followUpIndex ?? 0;
        if (currentFuIndex < followUps.length) {
            const nextFollowUp = followUps[currentFuIndex];
            const fuSentCount = nextFollowUp.repeatIndex || 0;
            const fuRepeatCount = this.resolveStableRepeatCount(nextFollowUp.repeatCount, nextFollowUp.resolvedRepeatCount, fuSentCount, `FU#${currentFuIndex + 1}`);
            if (nextFollowUp.resolvedRepeatCount !== fuRepeatCount) {
                nextFollowUp.resolvedRepeatCount = fuRepeatCount;
                this.persist();
                this._onDidChange.fire();
            }
            logQueue(`FU dispatch: repeatCount=${String(nextFollowUp.repeatCount)}, resolved=${fuRepeatCount}, cachedResolved=${nextFollowUp.resolvedRepeatCount}, sentCount=${fuSentCount}`);
            if (fuSentCount < fuRepeatCount) {
                if (this._pauseBeforeNextDispatch(item)) { return 'paused'; }
                // A follow-up runs in the iteration it follows (the last).
                const resolved = { ...this.resolveStageTransport(item, nextFollowUp), iterationKey: iterationKeyFor(item, 'followUp'), item };
                const followUpExpanded = await runInProcessPosition(item.processRun, () => runWithQueueRole(this.stageRoleSource(item, 'followUp'), () => this._buildExpandedText(
                    nextFollowUp.originalText,
                    this._templateOf(nextFollowUp.template, item),
                    { repeatCount: fuRepeatCount, repeatIndex: fuSentCount },
                    {
                        templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
                        templateRepeatIndex: item.templateRepeatIndex,
                    },
                    this.iterationTodoBlock(item, 'followUp'),
                )));
                nextFollowUp.repeatIndex = fuSentCount + 1;
                item.expandedText = followUpExpanded;
                // Advance to next follow-up only when all repeats for this one are done
                if (nextFollowUp.repeatIndex >= fuRepeatCount) {
                    item.followUpIndex = currentFuIndex + 1;
                }
                // Record the advance (this follow-up's repeat counter plus any
                // followUpIndex bump) so a failed send can roll back to re-send
                // this same follow-up repetition instead of skipping ahead.
                item.inFlightRepetition = {
                    stage: 'followUp',
                    stageIndex: currentFuIndex,
                    prevRepeatIndex: fuSentCount,
                    prevFollowUpIndex: currentFuIndex,
                };
                item.sentAt = new Date().toISOString();
                item.awaitingAnswer = true; // in flight — a prompt is being processed
                this.persist();
                this._onDidChange.fire();

                // Snapshot what we're about to send so Resend can replay it.
                item.lastDispatched = {
                    kind: 'followUp',
                    followUpIndex: currentFuIndex,
                    expandedText: followUpExpanded,
                    transport: resolved.transport,
                    anthropicProfileId: resolved.anthropicProfileId,
                    anthropicConfigId: resolved.anthropicConfigId,
                    iterationKey: resolved.iterationKey,
                    dispatchedAt: new Date().toISOString(),
                };
                const dispatchResult = await this.dispatchStage(followUpExpanded, resolved, nextFollowUp);
                if (this._frameLostAfterDispatch(item, frame, dispatchResult)) { return 'paused'; }
                this._onPromptSent.fire(item);
                logQueue(`Follow-up ${currentFuIndex + 1} sent (${fuSentCount + 1}/${fuRepeatCount}) via ${resolved.transport}`);
                this.persist();
                this._onDidChange.fire();
                return await this.dispatchNextStageForSendingItem(item, frame);
            }
            // All repeats done for this follow-up, advance to next.
            // The recursive call hits the pause gate first, so pause
            // between follow-ups behaves like pause between reps.
            item.followUpIndex = currentFuIndex + 1;
            return this.dispatchNextStageForSendingItem(item, frame);
        }

        // No more stages left.
        item.awaitingAnswer = false;
        item.inFlightRepetition = undefined;
        return 'done';
    }

    /** Check if a timed request already has a pending item in the queue. */
    hasTimedPending(timedRequestId: string): boolean {
        // We encode the timed request ID in the item's id as a prefix convention
        // or check by matching originalText. For simplicity, check by type + template combo.
        // The TimerEngine should set a unique marker.
        return false; // TimerEngine will use its own deduplication
    }

    // ----- persistence -------------------------------------------------------

    /**
     * A guideline section or option renamed (gsel7b): the choices this window
     * holds in memory — its queue items' and its runs' — carried over to the new
     * name and written (only the items and runs that changed; the runs as changed
     * by this window, so another window's write does not take them back).
     * Answers how many items and runs changed.
     */
    applyAspectRename(rename: AspectRename): { items: number; runs: number } {
        let items = 0;
        for (const item of this._items) {
            const next = renameInChoices(item.guidelines, rename);
            if (next) { item.guidelines = next; items++; }
        }
        let runs = 0;
        for (const [run, settings] of [...this._runSettings]) {
            const next = renameInChoices(settings.guidelines, rename);
            if (next) { this._putRunSettings(run, { ...settings, guidelines: next }); runs++; }
        }
        if (items) { this.persist(); }
        if (runs) { this.persistSettings(); }
        if (items || runs) { this._onDidChange.fire(); }
        return { items, runs };
    }

    private persist(): void {
        this.trimSentHistory();
        this._persistToFiles();
        this._refreshQueueWindowStatus();
    }

    private restore(): void {
        const entries = readAllEntries();
        this._loadFromEntryFiles(entries);
        console.log('[PromptQueueManager] restore: loaded', this._items.length, 'items from queue files');
        // Chat sends that can no longer report back (their window is gone) are settled.
        // A chat send that waited in an ask is kept and its ask shown again (vscimpb166); the others are settled.
        this._keepItemsWithOpenAsk(this._items.filter((i) => i.status === CHAT_STATUS));
        if (settleRunningChatItems(this._items, { ownWindowId: getWindowStatusWindowId(), liveWindowIds: liveWindowIdSet(), isActive: (id) => this._openAsksToRestore.has(id) || this._restoringAsks.has(id) }) > 0) {
            this._persistToFiles();
        }

        // Crash recovery is applied inside _loadFromEntryFiles so it runs
        // for both initial activation and subsequent file-watcher reloads.
        // lastDispatched is preserved so the Resend button can replay the
        // interrupted stage after a VS Code crash or window reload.

        // Restore queue-level settings
        this.restoreSettings();

        this._applyActivationRunSettings();
        // Runs whose soft-interrupted turn the reload lost stay paused, whatever Auto-Start says (vscimpb112).
        this._pauseLostSoftRuns();

        if (this._anyRunMayStart() && this._mayDrain()) {
            void this.sendNext();
        }

        // Reflect the restored queue state in the window-status dot.
        this._refreshQueueWindowStatus();
    }

    /**
     * At activation, per run: Auto-Start decides whether the run sends (every
     * run with settings of its own and every run that has items now; a run
     * created later starts from the start values), and a paused run with
     * Auto-Continue and pending repetitions (or an interrupted item) starts
     * after 30 seconds.
     */
    private _applyActivationRunSettings(): void {
        for (const item of this._items) {
            const run = itemRun(item);
            if (!this._runSettings.has(run)) { this._runSettings.set(run, { ...this._runStart }); }
        }
        for (const [run, settings] of this._runSettings) {
            settings.autoSend = settings.autoStart;
            if (settings.autoStart) { logQueue(`Auto-start: run ${run} sends on activation`); continue; }
            if (!settings.autoContinue) { continue; }
            const own = this._items.filter((i) => itemRun(i) === run);
            const hasPendingRepetitions = own.some(i =>
                i.status === 'pending' &&
                ((resolveRepeatCount(i.templateRepeatCount) > 1 && (i.templateRepeatIndex ?? 0) >= 1) ||
                 (resolveRepeatCount(i.repeatCount ?? 1) > 1 && (i.repeatIndex ?? 0) >= 1)),
            );
            if (!hasPendingRepetitions && !own.some(i => i.status === 'interrupted')) { continue; }
            logQueue(`Auto-continue: run ${run} has pending repetitions, scheduling its start in 30s`);
            this._autoContinueTimers.set(run, setTimeout(() => {
                this._autoContinueTimers.delete(run);
                logQueue(`Auto-continue: run ${run} sends again to resume its repetitions`);
                this.setRunAutoSend(run, true);
            }, 30_000));
        }
    }

    /**
     * Persist the run settings (`runs:` of queue-settings.yaml). The file's
     * top-level keys stay as they are — read as the start values of a new run —
     * and are written only by {@link setDefaultQueueSettings}.
     */
    private persistSettings(): void {
        // Auto-send toggling changes whether this window drives the queue, so
        // refresh the live 'queue' window-status dot.
        this._refreshQueueWindowStatus();
        writeQueueSettings({ [RUNS_BY_QUEST_KEY]: this._changedRunsInFile() });
    }

    /** The runs this window changed since it last wrote them (vscimpb168: only those are written). */
    private readonly _changedRuns = new Set<string>();
    private readonly _droppedRuns = new Set<string>();

    /** Store a run's settings as changed by this window (written at the next persist). */
    private _putRunSettings(run: string, settings: RunQueueSettings): void {
        this._runSettings.set(run, settings);
        this._changedRuns.add(run);
        this._droppedRuns.delete(run);
    }

    /** Drop a run's settings (written at the next persist). */
    private _dropRunSettings(run: string): void {
        this._runSettings.delete(run);
        this._changedRuns.delete(run);
        this._droppedRuns.add(run);
    }

    /** The quest whose run settings this window keeps (`runs-by-quest.<quest>`). */
    private _settingsQuest(): string {
        return this.activeQuestId() || 'default';
    }

    /**
     * The file's `runs-by-quest` with this window's changes in it (vscimpb168): read fresh, so the runs another
     * window changed and the runs this window only holds in memory (a run's auto-send set from its Auto-Start at
     * activation) are left as the file has them. One window cannot switch another's run off.
     */
    private _changedRunsInFile(): Record<string, Record<string, unknown>> {
        const changed = new Map<string, RunQueueSettings>();
        for (const run of this._changedRuns) {
            const s = this._runSettings.get(run);
            if (s) { changed.set(run, s); }
        }
        const value = questRunsInFile(readQueueSettings(), this._settingsQuest(), changed, this._droppedRuns);
        this._changedRuns.clear();
        this._droppedRuns.clear();
        return value;
    }

    /** Restore the run settings from disk: this quest's (`runs-by-quest`), else the old shared `runs:`. */
    private restoreSettings(): void {
        const stored = readQuestRunQueueSettings(readQueueSettings(), this._settingsQuest());
        this._runStart = stored.start;
        this._runSettings = stored.runs;
        logQueue(`restoreSettings: runs ${[...this._runSettings.keys()].join(', ')}`);
    }

    // ----- settings per run (vscimpb60a) ---------------------------------------

    /** The window's run: the run the queue-wide accessors (autoSendEnabled, defaultTransport, ...) read and set. */
    private _windowRun(): string {
        return normalizeRun(windowProcessRun());
    }

    /** The live settings of `run` (its own, else the start values; never stored by reading). */
    private _settingsOf(run: string | undefined): RunQueueSettings {
        const name = normalizeRun(run ?? this._windowRun());
        return this._runSettings.get(name) ?? this._runStart;
    }

    /** Whether `item` belongs to `run` (every item when `run` is undefined; a chat send to the run it ran in, else `default`). */
    private _inRun(item: QueuedPrompt, run: string | undefined): boolean {
        return run === undefined || itemRun(item) === normalizeRun(run);
    }

    /** The settings of the run `item` belongs to. */
    private _itemSettings(item: QueuedPrompt): RunQueueSettings {
        return this._settingsOf(itemRun(item));
    }

    /** Whether the run of `item` sends (its auto-send). */
    private _autoSendFor(item: QueuedPrompt): boolean {
        return this._itemSettings(item).autoSend;
    }

    /** The runs whose auto-send is off: their lanes start nothing (utils/queueLanes.ts). */
    private _pausedRuns(force?: ReadonlySet<string>): string[] {
        const runs = new Set<string>([...this._runSettings.keys()]);
        for (const i of this._items) { runs.add(itemRun(i)); }
        return [...runs].filter((run) => !this._settingsOf(run).autoSend && !force?.has(run)).sort();
    }

    /** Whether some run with auto-send on has an item to start. */
    private _anyRunMayStart(): boolean {
        return this._items.some((i) => (i.status === 'pending' || i.status === 'interrupted') && this._autoSendFor(i));
    }

    /** The window's run (the run the queue-wide accessors and a command without a run act on). */
    get windowRun(): string { return this._windowRun(); }


    /** The settings of `run` (default: the window's run), a copy. */
    runQueueSettings(run?: string): RunQueueSettings {
        return { ...this._settingsOf(run) };
    }

    /** Every run with settings of its own, `default` first, with a copy of them. */
    allRunQueueSettings(): Array<{ run: string; settings: RunQueueSettings }> {
        return [...this._runSettings.keys()]
            .sort((a, b) => Number(b === DEFAULT_RUN) - Number(a === DEFAULT_RUN) || a.localeCompare(b))
            .map((run) => ({ run, settings: { ...this._runSettings.get(run)! } }));
    }

    /**
     * Change settings of `run` (default: the window's run): stored, persisted,
     * shown. Auto-send coming on starts the run's lane (its paused item first).
     */
    setRunQueueSettings(run: string | undefined, patch: Partial<RunQueueSettings>): void {
        const name = normalizeRun(run ?? this._windowRun());
        const before = this._settingsOf(name);
        const next: RunQueueSettings = { ...before, ...patch };
        if (patch.walkContinuations !== undefined) { next.walkContinuations = validContinuations(patch.walkContinuations) ?? before.walkContinuations; }
        for (const key of ['defaultAnthropicProfileId', 'defaultAnthropicConfigId', 'defaultAgentSdkSession', 'defaultMessageTemplateId', 'defaultRole'] as const) {
            if (key in patch) { next[key] = (typeof patch[key] === 'string' ? (patch[key] as string).trim() : '') || undefined; }
        }
        // Auto-send set by the user or a tool: a hold that paused the run no longer decides its resume.
        if (patch.autoSend !== undefined) {
            for (const i of this._items) { if (i.holdPausedRun && itemRun(i) === name) { delete i.holdPausedRun; } }
        }
        this._putRunSettings(name, next);
        const changed = Object.keys(patch).filter((k) => (before as unknown as Record<string, unknown>)[k] !== (next as unknown as Record<string, unknown>)[k]);
        if (changed.length) { logQueue(`Run ${name}: ${changed.map((k) => `${k}=${String((next as unknown as Record<string, unknown>)[k])}`).join(', ')}`); }
        this.persistSettings();
        this._onDidChange.fire();
        // Auto-send set on (also when it already was: the run's lane is started, as switching it on always did).
        if (patch.autoSend === true) { this._onRunResumed(name); }
    }

    /** The start values: what a run without settings of its own (and a run created later) has; the file's top-level keys. */
    startQueueSettings(): RunQueueSettings {
        return { ...this._runStart };
    }

    /** The shown settings in which `run` (default: the window's run) differs from the start values; none = Make default has nothing to write. */
    defaultQueueSettingsDiff(run?: string): Array<keyof RunQueueSettings> {
        return defaultSettingsDiff(this._settingsOf(run), this._runStart);
    }

    /**
     * Make default (vscimpb60g): write the shown settings of `run` (default: the
     * window's run; utils/runQueueSettings.ts DEFAULT_SETTING_FIELDS) as the
     * top-level keys of queue-settings.yaml — the start values. A run with
     * settings of its own (`run` included) keeps them; runs without, and runs
     * created later, take the new values. `runs:` and the file's other keys stay
     * as they are. Answers the fields that changed.
     */
    setDefaultQueueSettings(run?: string): Array<keyof RunQueueSettings> {
        const name = normalizeRun(run ?? this._windowRun());
        const from = this._settingsOf(name);
        const changed = defaultSettingsDiff(from, this._runStart);
        this._runStart = startWithDefaultsFrom(this._runStart, from);
        logQueue(`Make default from run ${name}: ${changed.length ? changed.join(', ') : 'nothing changed'}`);
        this._refreshQueueWindowStatus();
        writeQueueSettings({ ...runQueueSettingsToKeys(this._runStart, DEFAULT_SETTING_FIELDS), [RUNS_BY_QUEST_KEY]: this._changedRunsInFile() });
        this._onDidChange.fire();
        return changed;
    }

    /** Switch the auto-send of `run` on or off (default: the window's run). */
    setRunAutoSend(run: string | undefined, on: boolean): void {
        this.setRunQueueSettings(run, { autoSend: on });
    }

    /** Switch off the auto-send of the run `item` belongs to (an error, an interrupt, needs attention, ...), saying why. */
    private _pauseRunOf(item: QueuedPrompt | undefined, why: string): boolean {
        const run = item ? itemRun(item) : this._windowRun();
        if (!this._settingsOf(run).autoSend) { return false; }
        this._putRunSettings(run, { ...this._settingsOf(run), autoSend: false });
        logQueue(`Run ${run} paused: ${why}`);
        // USER NOTIFICATIONS: the queue holds for the user (vscimpb170).
        emitRunPaused(run, why, item?.id);
        this.persistSettings();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Auto-send of `run` just came on: its interrupted item goes first, else
     * its paused sending item resumes, else the free lanes take their next
     * items. A sending item whose stage is still in flight goes on by itself
     * (a second frame beside it would send the walk twice, vscimpb53).
     */
    private _onRunResumed(run: string): void {
        // A held turn goes on first: nothing is resent (vscimpb112).
        if (this._releaseHeldItems(run)) { return; }
        if (this._resumeInterruptedItem(run)) { return; }
        this._resumePausedLanes(run);
        const hasWork = this._items.some(i => i.status === 'pending' || i.status === 'decision-needed' || i.status === 'todo-blocked');
        if (hasWork && this._mayDrain()) { void this.sendNext(); }
    }

    /**
     * Queue-level default transport + anthropic target ids. New items
     * without an explicit transport inherit from this default at dispatch
     * time (spec §4.10). The defaults also drive what the Add form in
     * the queue editor pre-selects.
     */
    get defaultTransport(): QueuedTransport { return this._settingsOf(undefined).defaultTransport; }
    get defaultAnthropicProfileId(): string | undefined { return this._settingsOf(undefined).defaultAnthropicProfileId; }
    get defaultAnthropicConfigId(): string | undefined { return this._settingsOf(undefined).defaultAnthropicConfigId; }
    get defaultMessageTemplateId(): string | undefined { return this._settingsOf(undefined).defaultMessageTemplateId; }
    get defaultAgentSdkSession(): string | undefined { return this._settingsOf(undefined).defaultAgentSdkSession; }

    /** Set a run's default Agent SDK session (default: the window's run); '' / undefined = the run's own `default`. */
    setDefaultAgentSdkSession(name: string | undefined, run?: string): void {
        this.setRunQueueSettings(run, { defaultAgentSdkSession: name });
    }

    /** Set a run's default role (default: the window's run); '' / undefined = the role `default` (gsel3; utils/promptRole.ts). */
    setDefaultRole(role: string | undefined, run?: string): void {
        this.setRunQueueSettings(run, { defaultRole: role && role.trim() ? role.trim() : DEFAULT_RUN_ROLE });
    }

    /**
     * The guideline choices of a staged or pending item (gsel4); undefined or
     * {} clears them. False when the item cannot change them (missing, or past
     * pending); the caller checks them against the sections.
     */
    updateItemGuidelines(id: string, guidelines: Record<string, string | string[]> | undefined): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.canChangeSession(item.status)) { return false; }
        const next = normalizeAspectChoices(guidelines);
        if (next) { item.guidelines = next; } else { delete item.guidelines; }
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** The guideline choices of `run` (default: the window's run; gsel4); undefined or {} clears them. */
    setRunGuidelines(guidelines: Record<string, string | string[]> | undefined, run?: string): void {
        this.setRunQueueSettings(run, { guidelines: normalizeAspectChoices(guidelines) });
    }

    /**
     * The role a staged or pending item runs as (gsel3); `''` / undefined
     * clears it. False when the item cannot change it (missing, or past
     * pending); the caller checks the name (utils/roleNames.ts roleRefusal).
     */
    updateItemRole(id: string, role: string | undefined): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.canChangeSession(item.status)) { return false; }
        const next = role && role.trim() ? role.trim() : undefined;
        if (next) { item.role = next; } else { delete item.role; }
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Set an item's session (staged or pending items): a name or a spec
     * `{name, basedOn?, mode?, profile?}`; '' = inherit the queue default.
     * Throws for a malformed spec or a session the item's profile cannot
     * continue; false when the item cannot change.
     */
    updateItemSession(id: string, session: string | Record<string, unknown> | undefined): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.canChangeSession(item.status)) { return false; }
        const spec = this.parseItemSession(session);
        const next = { ...item, session: spec?.name, sessionCreate: spec ? specExtras(spec) : undefined };
        const refusal = this.sessionRefusal(next);
        if (refusal) { throw new Error(refusal); }
        item.session = next.session;
        item.sessionCreate = next.sessionCreate;
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Move a staged or pending item into the queue of another run (the queue
     * editor's run tag): it takes `run`, its named session becomes that run's
     * (`<session>@<run>`, src/utils/runSessions.ts), and it goes to the end of
     * the queue, behind the items the run has. A *between iterations* or *let
     * the next item go first* mark is dropped: both refer to the old run's
     * lane. Refused for an item of a Proceed run (its process position and
     * marker belong to that run) and for a process-move marker.
     */
    moveItemToRun(id: string, run: string): { ok: true; moved: boolean } | { ok: false; reason: string } {
        const item = this._items.find(i => i.id === id);
        if (!item) { return { ok: false, reason: 'no such item' }; }
        if (!this.canChangeSession(item.status)) { return { ok: false, reason: 'only a staged or pending item can move to another run' }; }
        if (item.processMove) { return { ok: false, reason: 'a process-move marker stays with its Proceed run' }; }
        if (item.processRun) { return { ok: false, reason: 'the item belongs to a Proceed run and runs as its process position' }; }
        const to = normalizeRun(run);
        if (itemRun(item) === to) { return { ok: true, moved: false }; }
        item.run = to;
        if (item.session) { item.session = runSessionName(sessionBaseName(item.session), to); }
        item.sendBetween = undefined;
        item.yieldAfterIteration = undefined;
        this._items.splice(this._items.indexOf(item), 1);
        this._items.push(item);
        this.persist();
        this._onDidChange.fire();
        return { ok: true, moved: true };
    }

    /**
     * Move several items into the queue of run `run` (the queue editor's *Move items to another run* overlay), in
     * their queue order: each as {@link moveItemToRun}, and then its own profile (transport, profile,
     * configuration), session, role and template removed, so it follows the target run's defaults — the template
     * as "Run default" (utils/runDefaultChoice.ts). The text of each moved item is built again. Items that cannot
     * move (started, a Proceed run's, a process-move marker) are answered with the reason.
     */
    async moveItemsToRun(ids: readonly string[], run: string): Promise<{ run: string; moved: string[]; refused: Array<{ id: string; reason: string }> }> {
        const to = normalizeRun(run);
        const wanted = new Set(ids);
        const order = this._items.filter((i) => wanted.has(i.id));
        const moved: string[] = [];
        const refused: Array<{ id: string; reason: string }> = [];
        for (const id of ids) { if (!order.some((i) => i.id === id)) { refused.push({ id, reason: 'no such item' }); } }
        for (const item of order) {
            const r = this.moveItemToRun(item.id, to);
            if (!r.ok) { refused.push({ id: item.id, reason: r.reason }); continue; }
            applyRunDefaultsToItem(item, this._settingsOf(to), to, ['profile', 'template', 'session', 'role'], 'clear');
            item.expandedText = await this._buildExpandedText(item.originalText, this._templateOf(item.template, item), {
                repeatCount: resolveRepeatCount(item.repeatCount),
                repeatIndex: item.repeatIndex,
                repeatPrefix: item.repeatPrefix,
                repeatSuffix: item.repeatSuffix,
            }, {
                templateRepeatCount: resolveRepeatCount(item.templateRepeatCount),
                templateRepeatIndex: item.templateRepeatIndex,
            });
            moved.push(item.id);
        }
        if (moved.length) {
            logQueue(`Moved ${moved.length} item(s) to run ${to} (their own profile, session, role and template removed)`);
            this.persist();
            this._onDidChange.fire();
        }
        return { run: to, moved, refused };
    }

    /**
     * Set an item's done-notification prompt ('' removes it) and / or switch it
     * off or on. Possible until the item is finished — also while it is
     * sending; false for an unknown or finished (`sent`) item.
     */
    updateItemDoneNotification(id: string, patch: { prompt?: string; disabled?: boolean; quest?: string; run?: string }): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || item.status === 'sent') { return false; }
        // '' resets to the default: this quest, the item's run.
        if (patch.quest !== undefined) {
            const own = WsPaths.getWorkspaceQuestId() || 'default';
            item.doneNotificationQuest = patch.quest.trim() === '' || patch.quest.trim() === own ? undefined : patch.quest.trim();
        }
        if (patch.run !== undefined) {
            item.doneNotificationRun = patch.run.trim() === '' ? undefined : normalizeRun(patch.run);
        }
        if (patch.prompt !== undefined) {
            item.doneNotificationPrompt = patch.prompt.trim() === '' ? undefined : patch.prompt;
        }
        if (patch.disabled !== undefined) {
            item.doneNotificationDisabled = patch.disabled ? true : undefined;
        }
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** An item's session as given (name or spec), checked; undefined for none. Throws for a malformed one. */
    private parseItemSession(raw: string | Record<string, unknown> | undefined): SessionSpec | undefined {
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) { return undefined; }
        const parsed = parseSessionSpec(raw);
        if (!parsed.ok) { throw new Error(parsed.error); }
        return parsed.spec;
    }

    /** The folder of the active quest's session files. */
    private sessionsFolder(): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { TwoTierMemoryService } = require('../services/memory-service') as typeof import('../services/memory-service');
        return TwoTierMemoryService.instance.agentSdkSessionsFolder(WsPaths.getWorkspaceQuestId() || undefined);
    }

    /** The profile session `name` runs with: its file's, else the spec it will be created from. */
    private sessionProfileOf(name: string | undefined, create?: Omit<SessionSpec, 'name'>): string | undefined {
        if (!name) { return undefined; }
        try {
            return readSession(this.sessionsFolder(), name)?.profileId ?? create?.profile;
        } catch {
            return create?.profile;
        }
    }

    /**
     * Why the item cannot run in its session, checked when it is queued or its
     * session changes: the spec names a profile that does not exist, or a stage
     * would run with a profile that keeps its conversation elsewhere than the
     * session's existing one (an Agent SDK session continued by a profile with
     * our own history, or the reverse). Undefined when it can.
     */
    private sessionRefusal(item: QueuedPrompt): string | undefined {
        const section = loadSendToChatConfig()?.anthropic as (ProfileSection & { profiles?: Array<{ id?: string; isDefault?: boolean } | null> }) | undefined;
        if (item.sessionCreate?.profile && !lookupProfile(section, item.sessionCreate.profile)) {
            return `Session "${item.session}": there is no Anthropic profile "${item.sessionCreate.profile}".`;
        }
        const stages: Array<QueuedPrePrompt | QueuedFollowUpPrompt | undefined> = [undefined, ...(item.prePrompts ?? []), ...(item.followUps ?? [])];
        for (const stage of stages) {
            const resolved = this.resolveStageTransport(item, stage);
            if (resolved.transport !== 'anthropic' || !resolved.session) { continue; }
            const profileId = pickAnthropicProfile(section?.profiles ?? [], resolved.anthropicProfileId)?.id;
            const mismatch = sessionTransportMismatch(this.sessionsFolder(), resolved.session, lookupProfile(section, profileId));
            if (mismatch) { return mismatch; }
        }
        return undefined;
    }

    /**
     * Create the item's session when it is missing, before its first send:
     * from its spec (a missing base is created plainly; the profile is the
     * spec's, else the item's own), or — a bare name — a fresh `continue`
     * session. `chat` and the runs' default sessions (`default@<run>`, created with the run) are never created here.
     */
    private ensureItemSession(item: QueuedPrompt, sessionName: string | undefined): void {
        if (!sessionName || isRunDefaultSession(sessionName) || sessionName === 'chat') { return; }
        const section = loadSendToChatConfig()?.anthropic as ProfileSection | undefined;
        const spec: SessionSpec = sessionName === item.session ? { name: sessionName, ...(item.sessionCreate ?? {}) } : { name: sessionName };
        const result = ensureSession(this.sessionsFolder(), spec, (id) => lookupProfile(section, id), item.anthropicProfileId);
        if (!result.ok) { throw new Error(result.error); }
        if (result.created.length > 0) {
            logQueue(`Item ${item.id}: created session(s) ${result.created.join(', ')} before the first send`);
        }
    }
    setDefaultTransport(
        transport: QueuedTransport,
        anthropicProfileId?: string,
        anthropicConfigId?: string,
        run?: string,
    ): void {
        // A run's defaults (default: the window's run). The configuration is derived from the profile; an explicit one is kept.
        this.setRunQueueSettings(run, { defaultTransport: transport, defaultAnthropicProfileId: anthropicProfileId, defaultAnthropicConfigId: anthropicConfigId });
    }
    /**
     * Update the queue-level default message-wrapping template: a
     * user-message template id. Passing '' clears it.
     */
    setDefaultMessageTemplate(templateId?: string, run?: string): void {
        this.setRunQueueSettings(run, { defaultMessageTemplateId: templateId });
    }

    /** Reload state from disk (called by file watcher). */
    private _reloadFromDisk(): void {
        // Debounce rapid bursts of file events (one persist() call writes
        // multiple files, each of which fires its own watcher event).
        if (this._reloadDebounceTimer) {
            clearTimeout(this._reloadDebounceTimer);
        }
        this._reloadDebounceTimer = setTimeout(() => {
            this._reloadDebounceTimer = undefined;
            // Merge the disk state onto the current in-memory list instead of
            // replacing it wholesale. During an Anthropic dispatch the live
            // in-memory object for the `sending` item is authoritative: status
            // updates (pending→sending→sent) flow through the reference held by
            // sendItem(). A wholesale rebuild would swap that object out from
            // under the async chain, so its final item.status = 'sent' would
            // land on a discarded object and the queue would stall. The merge
            // keeps the live reference for `sending` items while still applying
            // disk state for everything else — so externally-added prompts and
            // completed prompts surface even while an item is sending.
            const diskBuild = this._buildItemsFromEntries(readAllEntries());
            const previousFileNameMap = this._fileNameMap;
            const { merged, preservedIds } = mergeQueueReload(this._items, diskBuild.items);

            this._items = merged;
            this._fileNameMap = diskBuild.fileNameMap;
            // Carry over the filename mapping for any preserved live item that
            // isn't on disk yet, so a later persist() reuses its file instead
            // of orphaning it under a freshly generated name.
            for (const item of this._items) {
                if (!this._fileNameMap.has(item.id)) {
                    const previous = previousFileNameMap.get(item.id);
                    if (previous) { this._fileNameMap.set(item.id, previous); }
                }
            }

            // Crash recovery only for `sending` items whose live reference was
            // NOT preserved — those are genuine crash leftovers on disk (no
            // in-flight send in this window). Preserved items are legitimately
            // mid-send and must keep their `sending` status.
            const recoverable = this._items.filter(i => !preservedIds.has(i.id));
            const recovered = this._applyCrashRecoveryTo(recoverable);
            this._pauseLostSoftRuns();
            this._scheduleOpenAskRestore(0);
            if (recovered > 0) {
                this._persistToFiles();
            }

            // A cross-window queue change may have added/removed pending items;
            // refresh this window's live 'queue' dot to match.
            this._refreshQueueWindowStatus();

            this._onDidChange.fire();
        }, 300);
    }

    /** Load queue items from entry files into memory (full replace). */
    private _loadFromEntryFiles(entries: QueueEntryFile[]): void {
        const { items, fileNameMap } = this._buildItemsFromEntries(entries);
        this._items = items;
        this._fileNameMap = fileNameMap;

        // Crash recovery — runs for the initial activation/full-load path. Any
        // `sending` entry on disk implies a prior crash/reload (restore() runs
        // at construction with empty in-memory state). Resetting to `pending`
        // re-exposes the Resend icon in the queue editor (hidden while
        // isSending) so the user can replay the interrupted stage via
        // `item.lastDispatched`, which is preserved on purpose.
        const recovered = this._applyCrashRecovery();
        if (recovered > 0) {
            // Align disk with the recovered in-memory state so a subsequent
            // watcher event doesn't reintroduce the stale `sending` status.
            this._persistToFiles();
        }
    }

    /**
     * Build an ordered list of queue items (and the id→fileName map) from raw
     * entry files, without mutating manager state. Shared by the full-load and
     * merge-reload paths.
     */
    private _buildItemsFromEntries(entries: QueueEntryFile[]): { items: QueuedPrompt[]; fileNameMap: Map<string, string> } {
        const items: QueuedPrompt[] = [];
        const fileNameMap = new Map<string, string>();

        const orderedEntries = [...entries].sort((a, b) => {
            const aOrder = Number((a.doc?.meta as Record<string, unknown> | undefined)?.['queue-order-index']);
            const bOrder = Number((b.doc?.meta as Record<string, unknown> | undefined)?.['queue-order-index']);
            const aHasOrder = Number.isFinite(aOrder);
            const bHasOrder = Number.isFinite(bOrder);
            if (aHasOrder && bHasOrder && aOrder !== bOrder) {
                return aOrder - bOrder;
            }
            if (aHasOrder !== bHasOrder) {
                return aHasOrder ? -1 : 1;
            }
            return a.fileName.localeCompare(b.fileName);
        });

        for (const entry of orderedEntries) {
            const item = this._entryToQueuedPrompt(entry);
            if (item) {
                items.push(item);
                fileNameMap.set(item.id, entry.fileName);
            }
        }

        return { items, fileNameMap };
    }

    /**
     * Reset any items still marked `sending` to `pending`. Called from
     * `_loadFromEntryFiles` — see that method for the invariant that
     * guarantees we aren't stomping an in-flight send.
     *
     * Preserves `lastDispatched` (the Resend button depends on it) and
     * `warning` (the last known interruption cause is still meaningful
     * to the user). Clears transient send-tracking fields so the item
     * looks like a fresh `pending` item from the dispatcher's POV.
     *
     * Returns the count of items reset.
     */
    private _applyCrashRecovery(): number {
        return this._applyCrashRecoveryTo(this._items);
    }

    /**
     * Crash-recover a specific subset of items (used by the merge-reload path,
     * which must exclude live `sending` references that are legitimately
     * mid-send). Mutates the given objects in place; returns the count reset.
     */
    /** Runs whose soft-interrupted turn a reload lost: paused once the run settings are read (vscimpb112). */
    private readonly _lostSoftRuns = new Set<string>();

    /** Items whose open ask is being shown again in this window (the restore runs until it is answered). */
    private readonly _restoringAsks = new Set<string>();

    /** Record the ask tool call queue item `itemId`'s turn waits in (services/openAskRecord.ts). */
    _recordOpenAsk(itemId: string, call: { tool: OpenAskTool; input: Record<string, unknown> }): void {
        const item = this._items.find((i) => i.id === itemId);
        if (!item || (item.status !== 'sending' && item.status !== CHAT_STATUS)) { return; }
        item.openAsk = { tool: call.tool, input: call.input, windowId: getWindowStatusWindowId(), startedAt: new Date().toISOString() };
        this.persist();
    }

    /** The ask returned: its record goes. */
    _clearOpenAsk(itemId: string): void {
        const item = this._items.find((i) => i.id === itemId);
        if (!item?.openAsk) { return; }
        delete item.openAsk;
        this.persist();
    }

    /**
     * The sending items among `items` whose turn a reload (or a closed window) left waiting in an ask: kept
     * sending, not reset. Those this window takes over are claimed (their window id becomes this window's) and
     * restored once the window is up; an ask a live other window shows is left alone.
     */
    private _keepItemsWithOpenAsk(items: QueuedPrompt[]): Set<string> {
        const kept = new Set<string>();
        const withAsk = items.filter((i) => (i.status === 'sending' || i.status === CHAT_STATUS) && i.openAsk);
        if (withAsk.length === 0) { return kept; }
        const own = getWindowStatusWindowId();
        const live = liveWindowIdSet();
        for (const item of withAsk) {
            kept.add(item.id);
            if (isAskLiveHere(item.id) || this._restoringAsks.has(item.id)) { continue; }
            if (!shouldRestoreOpenAsk(item.openAsk!, own, live)) { continue; }
            item.openAsk = { ...item.openAsk!, windowId: own };
            // A chat send is this window's from now on (its item is not settled as abandoned).
            if (item.status === CHAT_STATUS) { item.chatWindowId = own; }
            this._openAsksToRestore.add(item.id);
            logQueue(`Reload: item ${item.id} waited in ${item.openAsk.tool} — it stays sending; the ask is shown again and its answer continues the item`);
        }
        return kept;
    }

    private readonly _openAsksToRestore = new Set<string>();

    /** Show the asks a reload left open again, once the window's tools are installed. */
    _scheduleOpenAskRestore(delayMs = 1000): void {
        if (this._openAsksToRestore.size === 0) { return; }
        setTimeout(() => { void this._restoreOpenAsks(); }, delayMs);
    }

    /** Show each ask a reload left open again; answers when every one has been answered (tests wait for it). */
    async _restoreOpenAsks(): Promise<void> {
        const ids = [...this._openAsksToRestore];
        this._openAsksToRestore.clear();
        if (ids.length > 0) { this.persist(); }
        await Promise.all(ids.map((id) => this._restoreOpenAsk(id)));
    }

    /**
     * Run the item's recorded ask again (the panel, the picker or the MD Browser come back as they were),
     * then send its answer into the item's session as the continuation of the turn the reload ended. A Resend,
     * Skip or Stop meanwhile closes the ask and takes the item over: then nothing is sent.
     */
    private async _restoreOpenAsk(id: string): Promise<void> {
        const item = this._items.find((i) => i.id === id);
        const record = item?.openAsk;
        if (!item || !record || (item.status !== 'sending' && item.status !== CHAT_STATUS) || this._restoringAsks.has(id)) { return; }
        const chat = item.status === CHAT_STATUS;
        this._restoringAsks.add(id);
        const epoch = this._epochOf(item);
        try {
            const run = runAsQueueItem(item.id, () => runOpenAskTool(record.tool, record.input) ?? Promise.reject(new Error('the ask tools are not installed')), itemRun(item));
            const answer = await run;
            const live = this._items.find((i) => i.id === id);
            if (!live || live.status !== (chat ? CHAT_STATUS : 'sending') || dispatchWasSuperseded(epoch, this._epochOf(live))) {
                logQueue(`Reload: item ${id}'s restored ${record.tool} was answered after the item moved on — nothing sent`);
                return;
            }
            delete live.openAsk;
            if (chat) {
                // A panel send: its entry ends here, and the answer goes out as a new chat send in its session and run.
                this.completeChatItem(id, { answerText: RELOADED_CHAT_SEND_NOTE });
                logQueue(`Reload: chat send ${id}'s restored ${record.tool} answered — the answer continues it as a new chat send in session ${live.session ?? 'chat'}`);
                if (!await sendOpenAskChatContinuation({ text: openAskContinuationPrompt(record, answer), ...(live.session ? { session: live.session } : {}), ...(live.run ? { run: live.run } : {}) })) {
                    logQueue(`Reload: no chat send path is registered — the answer of chat send ${id} was not sent`);
                }
                return;
            }
            logQueue(`Reload: item ${id}'s restored ${record.tool} answered — the answer continues the item in its session`);
            await this.resendLastPrompt(id, undefined, { continuation: openAskContinuationPrompt(record, answer) });
        } catch (err) {
            const live = this._items.find((i) => i.id === id);
            if (live && live.status === CHAT_STATUS) {
                delete live.openAsk;
                this.completeChatItem(id, { error: `the question asked before the reload could not be shown again: ${(err as Error).message}` });
            } else if (live && live.status === 'sending' && !dispatchWasSuperseded(epoch, this._epochOf(live))) {
                delete live.openAsk;
                this._markItemError(live, err, `restoreOpenAsk(${id})`);
            }
        } finally {
            this._restoringAsks.delete(id);
        }
    }

    private _pauseLostSoftRuns(): void {
        for (const run of this._lostSoftRuns) {
            const item = this._items.find((i) => itemRun(i) === run && i.status === 'interrupted');
            this._pauseRunOf(item, 'its soft-interrupted turn was lost to a reload');
        }
        this._lostSoftRuns.clear();
    }

    private _applyCrashRecoveryTo(items: QueuedPrompt[]): number {
        // A turn that waited in an ask tool (vscimpb166): the item stays sending, its ask is shown again and its
        // answer continues the item; an ask a live other window shows is left to that window.
        const keptForAsk = this._keepItemsWithOpenAsk(items);
        if (keptForAsk.size > 0) { items = items.filter((i) => !keptForAsk.has(i.id)); }
        // A turn held (or about to be held) by a soft interrupt is gone with the reload (vscimpb112): the item
        // becomes interrupted — its resume continues a saved conversation or resends with the note — and its run
        // stays paused. Its todo claim stays: the resume works on the same todo.
        for (const item of items) {
            if (item.status !== 'sending' || !item.softInterrupt) { continue; }
            applyInterruptForContinuation(item);
            item.interruptNote = true;
            item.backgroundWait = undefined;
            item.waitingFor = undefined;
            this._lostSoftRuns.add(itemRun(item));
            logQueue(`Crash recovery: item ${item.id} was soft-interrupted — interrupted, its run stays paused (resume ${item.heldConversationFile ? 'continues the saved conversation' : 'resends with the interrupted note'})`);
        }
        // Snapshot ids that will be recovered so we can log each one
        // (applyCrashRecovery is pure and only returns the count).
        const toRecover = items
            .filter(item => item.status === 'sending')
            .map(item => ({ id: item.id, hasLastDispatched: !!item.lastDispatched }));
        const count = applyCrashRecovery(items);
        for (const info of toRecover) {
            logQueue(`Crash recovery: reset item ${info.id} from 'sending' to 'pending' (Resend available via item.lastDispatched=${info.hasLastDispatched ? 'yes' : 'no'})`);
        }
        return count;
    }

    /** Persist all items to individual entry files. */
    /**
     * What each item's file was last written from (item id → fingerprint):
     * the quest, the item's place in the queue and the item itself as JSON —
     * everything `_queuedPromptToDoc` builds the file from. An item whose
     * fingerprint is unchanged is not serialised or written again.
     */
    private readonly _writtenFingerprints = new Map<string, string>();

    /**
     * Write the queue to its entry files: only the items that changed since
     * their file was last written (a dispatch changes one item; serialising
     * every item with the yaml package held the extension host for hundreds of
     * ms on a long queue), and delete the files of removed items.
     */
    private _persistToFiles(): void {
        try {
            let quest: string | undefined;
            try { quest = (await_import_ChatVariablesStore())?.quest || ''; } catch { /* */ }

            // Write each item that changed
            for (let index = 0; index < this._items.length; index++) {
                const item = this._items[index];
                const fingerprint = `${quest ?? ''}\u0000${index}\u0000${JSON.stringify(item)}`;
                if (this._fileNameMap.has(item.id) && this._writtenFingerprints.get(item.id) === fingerprint) { continue; }
                const doc = this._queuedPromptToDoc(item, quest, index);
                let fileName = this._fileNameMap.get(item.id);
                if (!fileName) {
                    // Second-resolution timestamps collide when several items are
                    // enqueued in the same clock second (one prompt per stacked
                    // todo). Seed the name with a slice of the unique item id so
                    // each entry gets its own file instead of overwriting.
                    const token = item.id.replace(/-/g, '').slice(0, 8);
                    fileName = generateEntryFileName(quest, item.type, new Date(item.createdAt), token);
                    this._fileNameMap.set(item.id, fileName);
                }
                if (writeEntry(entryIdFromFileName(fileName), doc, fileName)) {
                    this._writtenFingerprints.set(item.id, fingerprint);
                } else {
                    this._writtenFingerprints.delete(item.id);
                }
            }

            // Delete files for items no longer in memory
            const currentIds = new Set(this._items.map(i => i.id));
            for (const [itemId, fileName] of this._fileNameMap.entries()) {
                if (!currentIds.has(itemId)) {
                    deleteEntry(entryIdFromFileName(fileName));
                    this._fileNameMap.delete(itemId);
                    this._writtenFingerprints.delete(itemId);
                }
            }

            // The sent history on disk: the items in memory are trimmed already
            // (trimSentHistory), so only entry files this window does not own
            // can push it over the limit — and only then is it worth reading
            // and parsing every file.
            if (countEntryFiles() > this._fileNameMap.size) { trimSentEntries(); }
        } catch (err) {
            debugLog(`[PromptQueueManager] _persistToFiles error: ${err}`, 'ERROR', 'queue');
        }
    }

    // ----- Conversion: QueueFileYaml ↔ QueuedPrompt -----------------------

    private _entryToQueuedPrompt(entry: QueueEntryFile): QueuedPrompt | undefined {
        try {
            const doc = entry.doc;
            const meta = doc.meta;
            const prompts = doc['prompt-queue'] || [];
            const mainId = meta['main-prompt'] || 'P1';
            const main = prompts.find(p => p.id === mainId) || prompts.find(p => p.type === 'main') || prompts[0];
            if (!main) return undefined;

            const kind = queueItemKindFromYaml(meta, main.template);
            const prompt: QueuedPrompt = {
                id: meta.id || entry.entryId,
                template: kind.template,
                originalText: main['prompt-text'] || '',
                expandedText: main['expanded-text'] || main['prompt-text'] || '',
                status: (meta.status as QueuedPromptStatus) || 'pending',
                pauseAfter: meta['pause-after'] === true ? true : undefined,
                sendBetween: meta['send-between'] === true ? true : undefined,
                yieldAfterIteration: meta['yield-after-iteration'] === true ? true : undefined,
                resumeAfterWait: meta['resume-after-wait'] === true ? true : undefined,
                type: kind.type,
                ...(kind.timedEntryId ? { timedEntryId: kind.timedEntryId } : {}),
                createdAt: (meta.created as string) || new Date().toISOString(),
                sentAt: main.execution?.['sent-at'] || undefined,
                error: main.execution?.error || undefined,
                followUpIndex: main.execution?.['follow-up-index'] || 0,
                repeatCount: typeof main['repeat-count'] === 'string' ? main['repeat-count'] : Math.max(0, Math.round(Number(main['repeat-count'] || 0))),
                resolvedRepeatCount: main['resolved-repeat-count'] ? Math.max(1, Math.round(Number(main['resolved-repeat-count']))) : undefined,
                repeatIndex: Math.max(0, Math.round(Number(main['repeat-index'] || 0))),
                repeatTodoId: main['repeat-todo-id'] || undefined,
                repeatPrefix: main['repeat-prefix'],
                repeatSuffix: main['repeat-suffix'],
                templateRepeatCount: typeof main['template-repeat-count'] === 'string' ? main['template-repeat-count'] : (main['template-repeat-count'] ? Math.max(0, Math.round(Number(main['template-repeat-count']))) : undefined),
                templateRepeatIndex: main['template-repeat-index'] ? Math.max(0, Math.round(Number(main['template-repeat-index']))) : undefined,
                ...(validLimit(main['background-wait-limit-minutes']) !== undefined ? { backgroundWaitLimitMinutes: validLimit(main['background-wait-limit-minutes']) } : {}),
                ...(backgroundWaitFromYaml(main['background-wait']) ? { backgroundWait: backgroundWaitFromYaml(main['background-wait']) } : {}),
                ...(waitForFromYaml(main['waiting-for']) ? { waitingFor: waitForFromYaml(main['waiting-for']) } : {}),
                ...(waitMessagesFromYaml(main['wait-messages']) ? { waitMessages: waitMessagesFromYaml(main['wait-messages']) } : {}),
                ...(softInterruptFromYaml(main['soft-interrupt']) ? { softInterrupt: softInterruptFromYaml(main['soft-interrupt']) } : {}),
                ...(typeof main['turn-session-id'] === 'string' && main['turn-session-id'] ? { turnSessionId: main['turn-session-id'] } : {}),
                ...(main['interrupt-note'] === true ? { interruptNote: true as const } : {}),
                ...(typeof main['held-conversation-file'] === 'string' && main['held-conversation-file'] ? { heldConversationFile: main['held-conversation-file'] } : {}),
                transport: readStoredTransport(main.transport),
                anthropicProfileId: main['anthropic-profile-id'] || undefined,
                anthropicConfigId: main['anthropic-config-id'] || undefined,
                // `agent-sdk-session` is the key's older name (it now chooses the
                // direct transport's history too); read either, write `session`.
                // A spec is written as a map ({name, basedOn, mode, profile}).
                ...readItemSession(main.session ?? main['agent-sdk-session']),
                ...(typeof main.role === 'string' && main.role.trim() ? { role: main.role.trim() } : {}),
                ...(normalizeAspectChoices(main.guidelines) ? { guidelines: normalizeAspectChoices(main.guidelines) } : {}),
                runId: typeof main.execution?.['run-id'] === 'string' ? main.execution['run-id'] : undefined,
                iterationSeq: typeof main.execution?.['iteration-seq'] === 'number' ? main.execution['iteration-seq'] : undefined,
                processRun: parseProcessRun(main['process-run']),
                ...(typeof main.run === 'string' && main.run ? { run: main.run } : {}),
                ...(parseProcessMove(main['process-move']) ? { processMove: parseProcessMove(main['process-move']) } : {}),
                ...(main['process-item'] === true ? { processItem: true } : {}),
                ...(typeof main['reload-prompt']?.['window-id'] === 'string' ? { reloadPrompt: { windowId: main['reload-prompt']['window-id'] } } : {}),
                answerText: main['answer-text'] || undefined,
                chatSource: main['chat-source'] || undefined,
                ...(typeof main['from-chat-panel'] === 'string' && main['from-chat-panel'] ? { fromChatPanel: main['from-chat-panel'] } : {}),
                chatWindowId: main['chat-window-id'] || undefined,
                todoClaim: todoClaimFromYaml(main['todo-claim']),
                ...(typeof main['todo-id-pattern'] === 'string' && main['todo-id-pattern'].trim() ? { todoIdPattern: main['todo-id-pattern'].trim() } : {}),
                ...(queuedByFrom(main['queued-by']) ? { queuedBy: queuedByFrom(main['queued-by']) } : {}),
                ...(parseGroupSelection(main['group-selection']) ? { groupSelection: parseGroupSelection(main['group-selection']) } : {}),
                ...(parseOpenAskRecord(main['open-ask']) ? { openAsk: parseOpenAskRecord(main['open-ask']) } : {}),
                ...(Array.isArray(main['walked-todos']) ? { walkedTodos: main['walked-todos'].filter((t): t is string => typeof t === 'string') } : {}),
                ...(repetitionAnswersFromYaml(main['repetition-answers']) ? { repetitionAnswers: repetitionAnswersFromYaml(main['repetition-answers']) } : {}),
                ...(main['answer-background-left'] === true ? { answerBackgroundLeft: true } : {}),
                ...(validContinuations(main['walk-continuations']) !== undefined ? { walkContinuations: validContinuations(main['walk-continuations']) } : {}),
                ...(typeof main['needs-attention'] === 'string' && main['needs-attention'] ? { needsAttention: main['needs-attention'] } : {}),
                ...(typeof main['blocked-on'] === 'string' && main['blocked-on'] ? { blockedOn: main['blocked-on'] } : {}),
                ...(typeof main['blocked-todo'] === 'string' && main['blocked-todo'] ? { blockedTodo: main['blocked-todo'] } : {}),
                ...(main['hold-paused-run'] === true ? { holdPausedRun: true } : {}),
                ...(Array.isArray(main['skipped-todos']) ? { skippedTodos: main['skipped-todos'].filter((t): t is string => typeof t === 'string') } : {}),
                ...(Array.isArray(main['ignore-block-todos']) ? { ignoreBlockTodos: main['ignore-block-todos'].filter((t): t is string => typeof t === 'string') } : {}),
                ...doneNotificationMetaFromYaml(meta as Record<string, unknown>),
            };
            // What the item holds: stored, else derived (an item written before vscimpb127).
            prompt.itemKind = parseQueueItemKind(main['item-kind']) ?? deriveQueueItemKind(prompt);

            // Resend metadata + warning chip — persisted under execution.
            const sentRecords = sentRecordsFromYaml(main.execution?.['sent-prompts']);
            if (sentRecords) { prompt.sentPrompts = sentRecords; }
            const ld = main.execution?.['last-dispatched'];
            if (ld && typeof ld === 'object' && typeof ld['expanded-text'] === 'string') {
                prompt.lastDispatched = {
                    kind: ld.kind,
                    prePromptIndex: typeof ld['pre-prompt-index'] === 'number' ? ld['pre-prompt-index'] : undefined,
                    followUpIndex: typeof ld['follow-up-index'] === 'number' ? ld['follow-up-index'] : undefined,
                    expandedText: ld['expanded-text'],
                    transport: readStoredTransport(ld.transport) ?? 'anthropic',
                    anthropicProfileId: ld['anthropic-profile-id'] || undefined,
                    anthropicConfigId: ld['anthropic-config-id'] || undefined,
                    iterationKey: typeof ld['iteration-key'] === 'string' ? ld['iteration-key'] : undefined,
                    dispatchedAt: ld['dispatched-at'] || new Date().toISOString(),
                };
            }
            const warn = main.execution?.warning;
            if (warn && typeof warn === 'object' && typeof warn.kind === 'string' && typeof warn.message === 'string') {
                prompt.warning = {
                    kind: warn.kind,
                    message: warn.message,
                    at: warn.at || new Date().toISOString(),
                };
            }

            // Rate-limit "waiting" state — restored so the health-check
            // auto-retry resumes at the right instant after a reload.
            if (typeof main.execution?.['waiting-until'] === 'string') {
                prompt.waitingUntil = main.execution['waiting-until'];
            }
            if (typeof main.execution?.['waiting-reset-label'] === 'string') {
                prompt.waitingResetLabel = main.execution['waiting-reset-label'];
            }

            // Retry "backoff" state — restored so the health-check auto-fire
            // resumes at the right instant and continues the backoff cascade
            // (not restart at 30s) after a reload.
            if (typeof main.execution?.['retry-attempt'] === 'number') {
                prompt.retryAttempt = main.execution['retry-attempt'];
            }
            if (typeof main.execution?.['retry-until'] === 'string') {
                prompt.retryUntil = main.execution['retry-until'];
            }

            // Pre-prompts: resolve refs from the prompt-queue
            const preRefs = main['pre-prompt-refs'] || [];
            if (preRefs.length > 0) {
                prompt.prePrompts = preRefs.map(ref => {
                    const refId = typeof ref === 'string' ? ref : undefined;
                    const pp = refId ? prompts.find(p => p.id === refId) : undefined;
                    return {
                        text: pp?.['prompt-text'] || '',
                        template: pp?.template,
                        status: (pp?.execution?.['sent-at'] ? 'sent' : (pp?.execution?.error ? 'error' : 'pending')) as 'pending' | 'sent' | 'error',
                        repeatCount: pp?.['repeat-count'],
                        resolvedRepeatCount: pp?.['resolved-repeat-count'] ? Math.max(1, Math.round(Number(pp['resolved-repeat-count']))) : undefined,
                        repeatIndex: Math.max(0, Math.round(Number(pp?.['repeat-index'] || 0))),
                        // Multi-transport (spec §4.14).
                        transport: readStoredTransport(pp?.transport),
                        anthropicProfileId: pp?.['anthropic-profile-id'] || undefined,
                        anthropicConfigId: pp?.['anthropic-config-id'] || undefined,
                        answerText: pp?.['answer-text'] || undefined,
                    };
                });
            }

            // Follow-ups: resolve refs from the prompt-queue
            const fuRefs = main['follow-up-refs'] || [];
            if (fuRefs.length > 0) {
                prompt.followUps = fuRefs.map(ref => {
                    const refId = typeof ref === 'string' ? ref : undefined;
                    const fu = refId ? prompts.find(p => p.id === refId) : undefined;
                    return {
                        id: refId || randomUUID(),
                        originalText: fu?.['prompt-text'] || '',
                        template: fu?.template,
                        repeatCount: fu?.['repeat-count'],
                        resolvedRepeatCount: fu?.['resolved-repeat-count'] ? Math.max(1, Math.round(Number(fu['resolved-repeat-count']))) : undefined,
                        repeatIndex: Math.max(0, Math.round(Number(fu?.['repeat-index'] || 0))),
                        createdAt: (fu?.metadata?.created as string) || (meta.created as string) || new Date().toISOString(),
                        // Multi-transport (spec §4.14).
                        transport: readStoredTransport(fu?.transport),
                        anthropicProfileId: fu?.['anthropic-profile-id'] || undefined,
                        anthropicConfigId: fu?.['anthropic-config-id'] || undefined,
                        answerText: fu?.['answer-text'] || undefined,
                    };
                });
            } else {
                prompt.followUps = [];
            }

            return prompt;
        } catch (err) {
            debugLog(`[PromptQueueManager] _entryToQueuedPrompt error: ${err}`, 'ERROR', 'queue');
            return undefined;
        }
    }

    /** Convert an in-memory QueuedPrompt to a QueueFileYaml document for disk storage. */
    private _queuedPromptToDoc(item: QueuedPrompt, quest?: string, orderIndex?: number): QueueFileYaml {
        const mainPrompt: QueuePromptYaml = {
            id: 'P1',
            name: 'Main Prompt',
            type: 'main',
            'prompt-text': item.originalText,
            'expanded-text': item.expandedText,
            template: item.template || '(None)',
            'repeat-count': item.repeatCount || 0,
            'resolved-repeat-count': item.resolvedRepeatCount,
            'repeat-index': Math.max(0, Math.round(item.repeatIndex || 0)),
            'repeat-todo-id': item.repeatTodoId,
            'repeat-prefix': item.repeatPrefix,
            'repeat-suffix': item.repeatSuffix,
            'template-repeat-count': item.templateRepeatCount,
            'template-repeat-index': item.templateRepeatIndex,
            ...(item.backgroundWaitLimitMinutes !== undefined ? { 'background-wait-limit-minutes': item.backgroundWaitLimitMinutes } : {}),
            ...(item.backgroundWait ? { 'background-wait': backgroundWaitToYaml(item.backgroundWait) } : {}),
            ...(item.waitingFor ? { 'waiting-for': waitForToYaml(item.waitingFor) } : {}),
            ...(item.waitMessages?.length ? { 'wait-messages': waitMessagesToYaml(item.waitMessages) } : {}),
            ...(item.softInterrupt ? { 'soft-interrupt': softInterruptToYaml(item.softInterrupt) } : {}),
            ...(item.turnSessionId ? { 'turn-session-id': item.turnSessionId } : {}),
            ...(item.interruptNote ? { 'interrupt-note': true } : {}),
            ...(item.heldConversationFile ? { 'held-conversation-file': item.heldConversationFile } : {}),
            // Omitted when not set, so the YAML stays clean.
            ...(item.transport ? { transport: item.transport } : {}),
            ...(item.anthropicProfileId ? { 'anthropic-profile-id': item.anthropicProfileId } : {}),
            ...(item.anthropicConfigId ? { 'anthropic-config-id': item.anthropicConfigId } : {}),
            ...(item.session ? { session: item.sessionCreate ? { name: item.session, ...item.sessionCreate } : item.session } : {}),
            ...(item.role ? { role: item.role } : {}),
            ...(item.guidelines && Object.keys(item.guidelines).length ? { guidelines: { ...item.guidelines } } : {}),
            ...(item.processRun ? { 'process-run': item.processRun } : {}),
            ...(item.run ? { run: item.run } : {}),
            ...(item.processMove ? { 'process-move': item.processMove } : {}),
            ...(item.processItem ? { 'process-item': true } : {}),
            ...(item.reloadPrompt ? { 'reload-prompt': { 'window-id': item.reloadPrompt.windowId } } : {}),
            ...(item.answerText ? { 'answer-text': item.answerText } : {}),
            ...(item.chatSource ? { 'chat-source': item.chatSource } : {}),
            ...(item.fromChatPanel ? { 'from-chat-panel': item.fromChatPanel } : {}),
            ...(item.chatWindowId ? { 'chat-window-id': item.chatWindowId } : {}),
            ...(item.todoClaim ? { 'todo-claim': todoClaimToYaml(item.todoClaim) } : {}),
            ...(item.todoIdPattern ? { 'todo-id-pattern': item.todoIdPattern } : {}),
            ...(item.queuedBy ? { 'queued-by': queuedByToYaml(item.queuedBy) } : {}),
            'item-kind': (item.itemKind = deriveQueueItemKind(item)),
            ...(item.walkedTodos?.length ? { 'walked-todos': [...item.walkedTodos] } : {}),
            ...(item.openAsk ? { 'open-ask': openAskRecordToYaml(item.openAsk) } : {}),
            ...(item.groupSelection ? { 'group-selection': { checked: [...item.groupSelection.checked], unchecked: [...item.groupSelection.unchecked] } } : {}),
            ...(item.repetitionAnswers?.length ? { 'repetition-answers': item.repetitionAnswers.map((a) => ({
                key: a.key, text: a.text, at: a.at,
                ...(a.backgroundLeft ? { 'background-left': true } : {}),
                ...(a.continuations ? { continuations: a.continuations, ...(a.earlier?.length ? { earlier: a.earlier } : {}) } : {}),
            })) } : {}),
            ...(item.answerBackgroundLeft ? { 'answer-background-left': true } : {}),
            ...(item.walkContinuations !== undefined ? { 'walk-continuations': item.walkContinuations } : {}),
            ...(item.needsAttention ? { 'needs-attention': item.needsAttention } : {}),
            ...(item.blockedOn ? { 'blocked-on': item.blockedOn } : {}),
            ...(item.blockedTodo ? { 'blocked-todo': item.blockedTodo } : {}),
            ...(item.holdPausedRun ? { 'hold-paused-run': true } : {}),
            ...(item.skippedTodos?.length ? { 'skipped-todos': [...item.skippedTodos] } : {}),
            ...(item.ignoreBlockTodos?.length ? { 'ignore-block-todos': [...item.ignoreBlockTodos] } : {}),
        };

        // Execution state
        if (
            item.sentAt || item.error
            || (item.followUpIndex && item.followUpIndex > 0)
            || item.lastDispatched || item.warning
            || item.waitingUntil
            || item.retryUntil || item.retryAttempt
        ) {
            mainPrompt.execution = {
                'sent-at': item.sentAt || null,
                error: item.error || null,
                'follow-up-index': item.followUpIndex || 0,
                ...(item.runId ? { 'run-id': item.runId } : {}),
                ...(item.iterationSeq ? { 'iteration-seq': item.iterationSeq } : {}),
                ...(item.waitingUntil ? { 'waiting-until': item.waitingUntil } : {}),
                ...(item.waitingResetLabel ? { 'waiting-reset-label': item.waitingResetLabel } : {}),
                ...(item.retryAttempt ? { 'retry-attempt': item.retryAttempt } : {}),
                ...(item.retryUntil ? { 'retry-until': item.retryUntil } : {}),
                ...(item.sentPrompts?.length ? { 'sent-prompts': sentRecordsToYaml(item.sentPrompts) } : {}),
                ...(item.lastDispatched ? {
                    'last-dispatched': {
                        kind: item.lastDispatched.kind,
                        ...(item.lastDispatched.prePromptIndex !== undefined ? { 'pre-prompt-index': item.lastDispatched.prePromptIndex } : {}),
                        ...(item.lastDispatched.followUpIndex !== undefined ? { 'follow-up-index': item.lastDispatched.followUpIndex } : {}),
                        'expanded-text': item.lastDispatched.expandedText,
                        transport: item.lastDispatched.transport,
                        ...(item.lastDispatched.anthropicProfileId ? { 'anthropic-profile-id': item.lastDispatched.anthropicProfileId } : {}),
                        ...(item.lastDispatched.anthropicConfigId ? { 'anthropic-config-id': item.lastDispatched.anthropicConfigId } : {}),
                        ...(item.lastDispatched.iterationKey ? { 'iteration-key': item.lastDispatched.iterationKey } : {}),
                        'dispatched-at': item.lastDispatched.dispatchedAt,
                    },
                } : {}),
                ...(item.warning ? {
                    warning: {
                        kind: item.warning.kind,
                        message: item.warning.message,
                        at: item.warning.at,
                    },
                } : {}),
            };
        }

        const allPrompts: QueuePromptYaml[] = [mainPrompt];

        // Pre-prompts
        if (item.prePrompts && item.prePrompts.length > 0) {
            const preRefs: string[] = [];
            item.prePrompts.forEach((pp, idx) => {
                const ppId = `pre-${idx + 1}`;
                preRefs.push(ppId);
                const ppYaml: QueuePromptYaml = {
                    id: ppId,
                    type: 'preprompt',
                    'prompt-text': pp.text,
                    template: pp.template,
                    'repeat-count': pp.repeatCount,
                    'resolved-repeat-count': pp.resolvedRepeatCount,
                    'repeat-index': pp.repeatIndex || 0,
                    execution: pp.status !== 'pending' ? {
                        'sent-at': pp.status === 'sent' ? new Date().toISOString() : null,
                        error: pp.status === 'error' ? 'pre-prompt failed' : null,
                    } : undefined,
                    // Multi-transport round-trip (spec §4.14).
                    ...(pp.transport ? { transport: pp.transport } : {}),
                    ...(pp.anthropicProfileId ? { 'anthropic-profile-id': pp.anthropicProfileId } : {}),
                    ...(pp.anthropicConfigId ? { 'anthropic-config-id': pp.anthropicConfigId } : {}),
                    ...(pp.answerText ? { 'answer-text': pp.answerText } : {}),
                };
                allPrompts.push(ppYaml);
            });
            mainPrompt['pre-prompt-refs'] = preRefs;
        }

        // Follow-ups
        if (item.followUps && item.followUps.length > 0) {
            const fuRefs: string[] = [];
            item.followUps.forEach(fu => {
                const fuId = fu.id || randomUUID();
                fuRefs.push(fuId);
                const fuPrompt: QueuePromptYaml = {
                    id: fuId,
                    type: 'followup',
                    'prompt-text': fu.originalText,
                    template: fu.template,
                    'repeat-count': fu.repeatCount,
                    'resolved-repeat-count': fu.resolvedRepeatCount,
                    'repeat-index': fu.repeatIndex || 0,
                    metadata: { created: fu.createdAt },
                    // Multi-transport round-trip (spec §4.14).
                    ...(fu.transport ? { transport: fu.transport } : {}),
                    ...(fu.anthropicProfileId ? { 'anthropic-profile-id': fu.anthropicProfileId } : {}),
                    ...(fu.anthropicConfigId ? { 'anthropic-config-id': fu.anthropicConfigId } : {}),
                    ...(fu.answerText ? { 'answer-text': fu.answerText } : {}),
                };
                allPrompts.push(fuPrompt);
            });
            mainPrompt['follow-up-refs'] = fuRefs;
        }

        return {
            meta: {
                id: item.id,
                quest: quest || undefined,
                status: item.status,
                // Omitted when unset so untouched entries round-trip unchanged.
                ...(item.pauseAfter ? { 'pause-after': true } : {}),
                ...(item.sendBetween ? { 'send-between': true } : {}),
                ...(item.yieldAfterIteration ? { 'yield-after-iteration': true } : {}),
                ...(item.resumeAfterWait ? { 'resume-after-wait': true } : {}),
                ...(item.type === 'timed' ? { type: item.type } : {}),
                // eslint-disable-next-line @typescript-eslint/naming-convention -- the entry file's YAML key
                ...(item.timedEntryId ? { 'timed-entry-id': item.timedEntryId } : {}),
                ...doneNotificationMetaToYaml(item),
                created: item.createdAt,
                'main-prompt': 'P1',
                'queue-order-index': Number.isFinite(orderIndex as number) ? orderIndex : undefined,
            },
            'prompt-queue': allPrompts,
        };
    }

    private trimSentHistory(): void {
        // Keep at most MAX_SENT_HISTORY sent items
        // Finished chat sends count as sent history.
        const isDone = (i: QueuedPrompt): boolean => i.status === 'sent' || i.status === CHAT_SENT_STATUS;
        const sent = this._items.filter(isDone);
        if (sent.length > MAX_SENT_HISTORY) {
            const removeCount = sent.length - MAX_SENT_HISTORY;
            let removed = 0;
            this._items = this._items.filter(i => {
                if (isDone(i) && removed < removeCount) { removed++; return false; }
                return true;
            });
        }
        // Hard cap on total items
        if (this._items.length > MAX_TOTAL_ITEMS) {
            // Remove oldest sent items first, then oldest pending
            const excess = this._items.length - MAX_TOTAL_ITEMS;
            const sentItems = this._items.filter(isDone);
            const toRemove = new Set<string>();
            for (let i = 0; i < Math.min(excess, sentItems.length); i++) {
                toRemove.add(sentItems[i].id);
            }
            if (toRemove.size < excess) {
                // Also remove oldest pending/error items (from end)
                const rest = this._items.filter(i => i.status !== 'sending' && !toRemove.has(i.id));
                for (let i = rest.length - 1; i >= 0 && toRemove.size < excess; i--) {
                    toRemove.add(rest[i].id);
                }
            }
            this._items = this._items.filter(i => !toRemove.has(i.id));
        }
    }
}

// Lazy import helper to avoid circular dependency
function await_import_ChatVariablesStore(): { quest: string } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ChatVariablesStore } = require('../managers/chatVariablesStore');
        return ChatVariablesStore.instance;
    } catch { return undefined; }
}

/**
 * Lazily read the live todos of a quest, reduced to what the `prefix*`
 * iteration needs. Lazy `require` mirrors the ChatVariablesStore pattern above
 * so the manager doesn't pull the questTodoManager into its import graph.
 * Returns `[]` on any failure so prefix resolution degrades to "no work left"
 * rather than throwing out of the dispatch path.
 *
 * The read is scoped to the **live** todo files — the `-archived` / `-deleted`
 * siblings are excluded by `readAllTodos`' default scope, so a retired todo
 * neither inflates the series count nor gets dispatched again.
 */
function readQuestTodoEntries(questId: string, ran?: ReadonlySet<string>): TodoIterationSource[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readAllTodos } = require('../managers/questTodoManager');
        // eslint-disable-next-line @typescript-eslint/naming-convention -- `user_action` is the todo schema's YAML key
        const todos = readAllTodos(questId) as Array<{ id: string; title?: string; description?: string; status?: string; user_action?: boolean; repeat?: { rule?: string }; comprised_of?: string[] }>;
        return todos.map(t => ({
            id: t.id, title: t.title || t.description, status: t.status,
            ...(t.user_action === true ? { userAction: true } : {}),
            // A GROUP item walks these (vscimpb127).
            ...(Array.isArray(t.comprised_of) ? { comprisedOf: t.comprised_of } : {}),
            // A manual repeated todo waiting to be repeated is walked, once per walk.
            ...(t.status === 'waiting-for-repeat' && t.repeat?.rule === 'manual' && !(ran?.has(t.id)) ? { walkableRepeat: true } : {}),
        }));
    } catch { return []; }
}

/**
 * The todos an item's walk reads: the quest's todos with what the item ran
 * (walkableRepeatIds) and a GROUP item's selection applied (vscimpb129).
 */
/** The `role` of todo `id` of `quest` (gsel11: the queue item's role chip); undefined: none or no such todo. */
function readTodoRole(quest: string, id: string): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findTodoById } = require('../managers/questTodoManager') as typeof import('../managers/questTodoManager');
    return findTodoById(quest, id)?.role || undefined;
}

function walkEntriesOf(item: QueuedPrompt, questId: string): TodoIterationSource[] {
    const ran = walkableRepeatIds(item);
    const entries = withSelectionFlags(readQuestTodoEntries(questId, ran), item.groupSelection, ran);
    // What blocks each todo now (utils/todoBlockState.ts), as the item sees it (utils/walkBlockView.ts): a blocker
    // the item or an item ahead runs first does not hold, stale in-progress todos run, the user's skips are passed.
    const { states, todos } = questTodoBlockData(questId);
    const viewed: ViewTodo[] = entries.map((e) => {
        const raw = todos.get(e.id);
        return raw ? { ...e, blockedBy: raw.blocked_by, blockedUntil: raw.blocked_until } : e;
    });
    return walkBlockView(item.repeatCount, viewed, states, walkBlockContextOf(item, questId, ran, states.size > 0));
}

/** What the queue knows that the walk view needs (the items ahead, the claims); set by the manager. */
let walkQueueFacts: ((item: QueuedPrompt, questId: string) => { queuedAhead(quest: string, id: string): boolean; claimedElsewhere(id: string): boolean }) | undefined;

/** The context the walk view reads for `item` (utils/walkBlockView.ts). */
function walkBlockContextOf(item: QueuedPrompt, questId: string, ran: ReadonlySet<string> = walkableRepeatIds(item), withIndex = true): WalkBlockContext {
    // The status index reads every quest: only when a todo carries a block to judge.
    let index: { statusOf: (quest: string, id: string) => string | undefined; quests: Set<string> } = { statusOf: () => undefined, quests: new Set<string>() };
    const root = withIndex ? (todoQuestsRoot() ?? WsPaths.ai('quests')) : undefined;
    try { if (root) { index = questStatusIndex(root); } } catch { /* nothing known */ }
    const facts = walkQueueFacts?.(item, questId);
    return {
        questId,
        quests: index.quests,
        statusOf: index.statusOf,
        queuedAhead: (quest, id) => facts?.queuedAhead(quest, id) ?? false,
        claimedElsewhere: (id) => facts?.claimedElsewhere(id) ?? false,
        ran,
        skipped: new Set(item.skippedTodos ?? []),
        ignoreBlock: new Set(item.ignoreBlockTodos ?? []),
    };
}

// eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML keys
type BlockRawTodo = { id: string; status?: string; blocked_by?: string[]; blocked_until?: string[] };

/**
 * The block state of the live todos of `questId` that carry a block (`blocked_by`, or status `blocked`), with
 * the raw todos read (their `blocked_by` / `blocked_until`); `only`: of these ids. Blockers are looked up in every
 * quest, live and archived.
 */
function questTodoBlockData(questId: string, only?: ReadonlySet<string>): { states: Map<string, ReturnType<typeof todoBlockState>>; todos: Map<string, BlockRawTodo> } {
    const out = new Map<string, ReturnType<typeof todoBlockState>>();
    const raw = new Map<string, BlockRawTodo>();
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readAllTodos } = require('../managers/questTodoManager');
        const todos = (readAllTodos(questId) as BlockRawTodo[])
            .filter((t) => (!only || only.has(t.id)) && ((t.blocked_by?.length ?? 0) > 0 || t.status === 'blocked'));
        if (!todos.length) { return { states: out, todos: raw }; }
        // The quests folder: the todo writers', else the workspace's (nothing was written yet in this window).
        const root = todoQuestsRoot() ?? WsPaths.ai('quests');
        const index = root ? questStatusIndex(root) : { statusOf: () => undefined, quests: new Set<string>() };
        for (const t of todos) { out.set(t.id, todoBlockState(t, questId, index.statusOf, index.quests)); raw.set(t.id, t); }
    } catch { /* unreadable todos block nothing */ }
    return { states: out, todos: raw };
}

/** A todo's record as the block a todo iteration appends; undefined when it cannot be read. */
function readQuestTodoBlock(questId: string, todoId: string): string | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readAllTodos } = require('../managers/questTodoManager');
        const todo = (readAllTodos(questId) as Array<Record<string, unknown>>).find((t) => t.id === todoId);
        if (!todo) { return undefined; }
        const file = typeof todo._sourceFile === 'string' ? `_ai/quests/${questId}/${todo._sourceFile}` : undefined;
        return todoYamlBlock(todo, file);
    } catch { return undefined; }
}

/** The live todo store, for {@link releaseUnblockedTodos}; the status write is the claim's own. */
/**
 * The todos of `questId` still `decision-needed` whose decisions are all answered (each has a `decision`): set
 * to `not-started`, as the todo guideline says the one answering them does. So a walk held at such a todo goes on
 * once the user has answered in the todo panel, without changing the status by hand. Answers the ids set.
 */
function settleDecidedTodos(questId: string): string[] {
    const set: string[] = [];
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readAllTodos } = require('../managers/questTodoManager');
        const todos = readAllTodos(questId) as Array<{ id: string; status?: string; decisions?: unknown }>;
        for (const t of todos) {
            if (t.status !== 'decision-needed') { continue; }
            const decisions = normaliseTodoDecisions(t.decisions);
            if (!decisions?.length || hasUnresolvedDecisions(decisions)) { continue; }
            // Through the unblock port, as a released blocked todo (the claim rules write no status back themselves).
            if (QUEST_TODO_UNBLOCK_PORT.writeStatus(questId, t.id, 'not-started')) {
                logQueue(`Todo ${t.id}: every decision answered — set to not-started`);
                set.push(t.id);
            }
        }
    } catch { /* no todo manager: nothing settled */ }
    return set;
}

const QUEST_TODO_UNBLOCK_PORT: TodoUnblockPort = questTodoUnblockPort((questId, todoId, status) => writeQuestTodoStatus(questId, todoId, status));


/**
 * Write a status onto a quest todo. Returns `false` when the write did not
 * stick (unknown id, unreadable file, …) — the todo-iteration dispatcher must
 * treat that as a hard stop, because a status that can't be written means the
 * same todo would be picked again on every pass.
 */
function writeQuestTodoStatus(questId: string, todoId: string, status: string): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { updateTodo } = require('../managers/questTodoManager');
        return updateTodo(questId, todoId, { status }) !== undefined;
    } catch (err) {
        logQueueError(`Failed to set todo '${todoId}' to '${status}'`, err);
        return false;
    }
}

/** Read a quest todo (live files) as the walk's completion check needs it, `undefined` when unknown. */
function readQuestTodo(questId: string, todoId: string): WalkedTodo | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { findTodoById } = require('../managers/questTodoManager');
        return findTodoById(questId, todoId) as WalkedTodo | undefined;
    } catch (err) {
        logQueueError(`Failed to read todo '${todoId}'`, err);
        return undefined;
    }
}

/** Read a quest todo's current status (live files), `undefined` when unknown. */
function readQuestTodoStatus(questId: string, todoId: string): string | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { findTodoById } = require('../managers/questTodoManager');
        const todo = findTodoById(questId, todoId) as { status?: string } | undefined;
        return todo?.status;
    } catch (err) {
        logQueueError(`Failed to read todo '${todoId}'`, err);
        return undefined;
    }
}

/** The todo status port the queue's claims go through. */
const QUEST_TODO_STATUS_PORT: TodoStatusPort = {
    readStatus: readQuestTodoStatus,
    writeStatus: writeQuestTodoStatus,
};

/** Where a settled claim's answer goes: the todo's `last_answer`. */
const QUEST_TODO_ANSWER_PORT: TodoAnswerPort = {
    readStatus: readQuestTodoStatus,
    writeLastAnswer: (questId, todoId, answer) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { updateTodo } = require('../managers/questTodoManager');
            // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
            return updateTodo(questId, todoId, { last_answer: answer }) !== undefined;
        } catch (err) {
            logQueueError(`Failed to write the answer onto todo '${todoId}'`, err);
            return false;
        }
    },
};

/** What a chat send's entry says when a reload ended it while it waited in an ask (vscimpb166). */
export const RELOADED_CHAT_SEND_NOTE =
    'The window was reloaded while this send waited for your answer. The question was shown again after the reload; ' +
    'your answer continues it as a new chat send in the same session.';

/** The windows of this machine with a live heartbeat (their window-state files). */
function liveWindowIdSet(): Set<string> {
    const now = Date.now();
    try {
        return new Set(loadAllWindowStates().filter((s) => isWindowAlive(s as unknown as { heartbeat?: string }, now)).map((s) => String((s as unknown as { windowId?: string }).windowId || '')));
    } catch {
        return new Set();
    }
}

function getWindowStatusWindowId(): string {
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return `${session}_${machine}`;
}

function getWindowStatusWorkspaceName(): string {
    if (vscode.workspace.name) {
        return vscode.workspace.name;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.name) {
        return folder.name;
    }
    return 'workspace';
}

/**
 * Read the Interruption the Anthropic handler's leaf catch blocks stamp
 * onto thrown errors (non-enumerable `__tomAnthropicInterruption`
 * property; see `closeLiveTrailForThrown` in anthropic-handler.ts).
 * Returns `null` for unclassified errors so the caller can leave the
 * queue item's `warning` unset.
 *
 * Kept as a free function rather than importing `getAttachedInterruption`
 * from the anthropic-handler module so the queue manager doesn't pull
 * the entire Anthropic SDK into its cold-start import graph.
 */
function readInterruptionFromError(err: unknown): { kind: QueueWarningKind; message: string } | null {
    if (!err || typeof err !== 'object') { return null; }
    const attached = (err as { __tomAnthropicInterruption?: unknown }).__tomAnthropicInterruption;
    if (attached && typeof attached === 'object' && 'kind' in attached && 'message' in attached) {
        const kind = (attached as { kind: unknown }).kind;
        const message = (attached as { message: unknown }).message;
        if (typeof kind === 'string' && typeof message === 'string'
            && (kind === 'rate_limit' || kind === 'quota_exceeded' || kind === 'overloaded' || kind === 'cancelled' || kind === 'interrupted')) {
            return { kind, message };
        }
    }
    return null;
}

/**
 * A queue entry's `session` as read from its YAML: a name, or a spec map
 * `{name, basedOn, mode, profile}` (written for an item queued with a spec).
 * An unreadable spec keeps its name, if any, so the item still runs there.
 */
function readItemSession(raw: unknown): { session?: string; sessionCreate?: Omit<SessionSpec, 'name'> } {
    if (raw === undefined || raw === null || raw === '') { return {}; }
    const parsed = parseSessionSpec(raw);
    if (parsed.ok) {
        const extras = specExtras(parsed.spec);
        return { session: parsed.spec.name, ...(extras ? { sessionCreate: extras } : {}) };
    }
    if (typeof raw === 'string') { return { session: raw }; }
    const name = (raw as { name?: unknown }).name;
    return typeof name === 'string' && name ? { session: name } : {};
}

/**
 * The run the window works on (ProcessStateStore.currentRun), for an item
 * added without one; `default` while the process store is not there.
 */
function windowProcessRun(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return (require('./processStateStore.js') as typeof import('./processStateStore')).ProcessStateStore.instance?.currentRun ?? 'default';
    } catch {
        return 'default';
    }
}

/** A done notification for another quest, as the poster delivers it. */
export interface DoneNotificationPost {
    quest: string;
    run: string;
    text: string;
    notificationOf: string;
    from: { quest: string; run: string };
}

/** Delivers a done notification into another quest's inbox: the file's name and whether a window of that quest runs. */
export type DoneNotificationPoster = (post: DoneNotificationPost) => { file: string; targetRunning: boolean };

/** Whether `quest` has the process run `run` (`default` always; src/utils/processRepository.ts). */
export function questRunExists(quest: string, run: string): boolean {
    const r = normalizeRun(run);
    if (r === DEFAULT_RUN) { return true; }
    const processes = WsPaths.ai('processes');
    const quests = WsPaths.ai('quests');
    if (!processes || !quests) { return false; }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProcessRepository } = require('../utils/processRepository') as typeof import('../utils/processRepository');
    return new ProcessRepository(processes, quests).hasRun(quest, r);
}
