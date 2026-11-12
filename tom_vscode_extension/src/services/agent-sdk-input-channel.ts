/**
 * Agent SDK query input — decides when the CLI's stdin may close.
 *
 * The Claude Code CLI reaches the extension's in-process MCP server (every
 * `tomAi_*` tool) through control requests, and the responses travel back on
 * the CLI's stdin. Given a STRING prompt, the SDK closes stdin at the query's
 * first `result` message. The CLI does not always stop there:
 *
 *   - when a background agent finishes after the model has ended its turn, the
 *     CLI runs a continuation turn in the same process;
 *   - on resume, the CLI first runs an orphan-summary notification about the
 *     previous process's background tasks as a turn of its own, and that
 *     turn's result arrives before the prompt has started.
 *
 * Every in-process MCP call made after stdin closed fails within milliseconds
 * with "The tool call was interrupted before a result was received", and the
 * handler never runs. So the transport passes the prompt as a stream instead,
 * and this channel keeps that stream open until the CLI says the work is over:
 * a `session_state_changed: idle` after a result that answers THIS message
 * (matched by the uuid the message carries). `idle` is the CLI's own turn-over
 * signal; it comes after held-back results and background-agent continuations.
 * The CLI emits it only when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set,
 * which the transport does.
 *
 * A background Bash command does NOT hold the turn open: the CLI goes `idle`
 * while it still runs, and closing there would drop its result. The model
 * never saw it, and a follow-up it promised ("commit once the suites pass")
 * silently never happened. So an `idle` while non-ambient background tasks are
 * live (`background_tasks_changed`) waits instead. When they finish, the CLI
 * runs the follow-up turn itself, and the `idle` after it closes. A task is
 * alive while the CLI lists it — a silent waiter loop as much as a chatty
 * build. The wait is bounded by a hard limit (`backgroundLimitMs`, the queue
 * item's or the profile's, default 6 hours: utils/backgroundWait.ts); at the
 * limit the channel closes and names what was still running
 * (`stillRunningAtClose`), which the transport puts into the turn's answer.
 *
 * More user messages can go in while the query runs (push: an "update" to the
 * running prompt, the SDK's streaming input). The stream then stays open until
 * every message has its answering result, and each pushed message's own answer
 * is the text of the result that answers it.
 *
 * Two fallbacks keep a query from hanging on a CLI that behaves differently:
 * a CLI that emits no session-state events closes at the answering result
 * (the old behaviour), and an `idle` while our message is still unanswered
 * closes after a grace period unless the CLI starts running again.
 *
 * Pure: imports neither `vscode` nor the SDK.
 */

// The SDK's message fields are its snake_case wire format and cannot be renamed.
/* eslint-disable @typescript-eslint/naming-convention */
import { randomUUID } from 'node:crypto';
import { DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES, formatLimit } from '../utils/backgroundWait';

/**
 * Makes the CLI emit `session_state_changed`, whose `idle` the channel closes
 * on. The SDK's `env` replaces the subprocess environment, so callers add it
 * on top of whatever environment the subprocess would otherwise get.
 */
export const SESSION_STATE_EVENTS_ENV = 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS';

/** The user message the SDK's streaming-input mode expects. */
export interface SdkPromptMessage {
    type: 'user';
    uuid: string;
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
}

export type InputCloseReason =
    | 'idle-after-answer'
    | 'idle-unanswered-timeout'
    | 'result-without-session-state'
    | 'background-done'
    | 'background-wait-limit'
    | (string & {});

/** A live, non-ambient background task the CLI reported. */
export interface BackgroundTaskInfo {
    taskId: string;
    taskType: string;
    description: string;
    /** Where a background Bash writes its output, from its tool result. */
    outputFile?: string;
    /** The background Bash's command, from its tool call. */
    command?: string;
}

/** What the channel waits for, while it waits. */
export interface BackgroundWaitSnapshot {
    /** Epoch ms the wait began. */
    since: number;
    limitMs: number;
    tasks: BackgroundTaskInfo[];
}

/** What the channel reports about background work, for logging. */
export type InputChannelEvent =
    /** The CLI went idle with these tasks still running; waiting for them (at most `limitMs`). */
    | { kind: 'waiting'; tasks: BackgroundTaskInfo[]; limitMs: number }
    /** While waiting, the set of running tasks changed. */
    | { kind: 'changed'; tasks: BackgroundTaskInfo[] }
    /** Every task the wait was for has ended. */
    | { kind: 'done' }
    /** The limit was reached; closing despite these tasks. */
    | { kind: 'limit'; tasks: BackgroundTaskInfo[]; limitMs: number }
    /** Background waiting is off (limit 0); closing despite these tasks. */
    | { kind: 'abandoned'; tasks: BackgroundTaskInfo[] };

export interface QueryInputChannelOptions {
    /** Uuid stamped on the prompt; defaults to a fresh v4 uuid. */
    uuid?: string;
    /** Wait after an unanswered `idle` before closing anyway. Default 10 s. */
    graceMs?: number;
    /**
     * The longest the channel waits for background tasks that outlive the
     * turn (alive while the CLI lists them). Default 6 hours; 0 = do not wait.
     */
    backgroundLimitMs?: number;
    /** Called once, when the channel closes. */
    onClose?: (reason: InputCloseReason) => void;
    /** Called on each background-wait event. */
    onEvent?: (event: InputChannelEvent) => void;
}

const DEFAULT_GRACE_MS = 10_000;

/** A pushed message's answer, or why it has none. */
export interface PushedMessage {
    uuid: string;
    /** The text of the result that answers it; rejected when the stream closes first. */
    answer: Promise<string>;
}
export const DEFAULT_BACKGROUND_WAIT_MS = DEFAULT_BACKGROUND_WAIT_LIMIT_MINUTES * 60_000;

/** The Bash tool's result for a command it moved to the background. */
// The path ends the sentence, so its full stop is not part of it.
const BACKGROUND_BASH_RESULT = /running in background with ID: (\S+?)\. Output is being written to: (\S+?)\.?(?=\s|$)/;

type TrackedTask = BackgroundTaskInfo;

export class QueryInputChannel {
    readonly uuid: string;
    private readonly text: string;
    private readonly graceMs: number;
    private readonly backgroundLimitMs: number;
    private readonly onClose?: (reason: InputCloseReason) => void;
    private readonly onEvent?: (event: InputChannelEvent) => void;
    /** Messages without their answering result yet: the first, then each pushed one. */
    private readonly unanswered = new Set<string>();
    /** Pushed messages not yet yielded to the SDK. */
    private readonly outbox: SdkPromptMessage[] = [];
    /** The answer of each pushed message, by uuid. */
    private readonly answerOf = new Map<string, { resolve(text: string): void; reject(e: Error): void }>();
    /** Wakes the prompt stream when a message is pushed or the channel closes. */
    private wake: (() => void) | undefined;
    private sawSessionState = false;
    private state: 'running' | 'idle' | undefined;
    private graceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Live non-ambient background tasks, by id (replace semantics). */
    private liveTasks = new Map<string, TrackedTask>();
    /** Output files by task id, from Bash tool results; outlives the task set. */
    private readonly outputFiles = new Map<string, string>();
    /** Background Bash commands by tool_use id, then by task id once its result names the task. */
    private readonly commandsByToolUse = new Map<string, string>();
    private readonly commands = new Map<string, string>();
    private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    /** Epoch ms the current background wait began. */
    private waitingSince: number | undefined;
    /** The tasks still running when the channel closed at the limit (or with waiting off). */
    private stillRunning: BackgroundTaskInfo[] = [];
    private reason: InputCloseReason | undefined;
    private resolveClosed!: () => void;
    private readonly closedPromise: Promise<void>;

    constructor(text: string, options: QueryInputChannelOptions = {}) {
        this.text = text;
        this.uuid = options.uuid ?? randomUUID();
        this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
        this.backgroundLimitMs = options.backgroundLimitMs ?? DEFAULT_BACKGROUND_WAIT_MS;
        this.onClose = options.onClose;
        this.onEvent = options.onEvent;
        this.closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
        this.unanswered.add(this.uuid);
    }

    /** Whether every message has its answering result. */
    private get answered(): boolean { return this.unanswered.size === 0; }

    /**
     * Send another user message into the running query (an update to the
     * running prompt). Undefined when the channel is closed: the query is over.
     */
    push(text: string): PushedMessage | undefined {
        if (this.closed) { return undefined; }
        const uuid = randomUUID();
        this.unanswered.add(uuid);
        const answer = new Promise<string>((resolve, reject) => { this.answerOf.set(uuid, { resolve, reject }); });
        answer.catch(() => undefined);
        this.outbox.push({ type: 'user', uuid, message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
        // An idle CLI runs again for it; one that does not lets the grace period close the stream.
        if (this.state === 'idle') { this.startGrace(); }
        this.wake?.();
        return { uuid, answer };
    }

    get closed(): boolean { return this.reason !== undefined; }
    get closeReason(): InputCloseReason | undefined { return this.reason; }

    /** The live non-ambient background tasks, as last reported. */
    liveBackgroundTasks(): BackgroundTaskInfo[] {
        return [...this.liveTasks.values()].map((t) => this.info(t));
    }

    /** What the channel waits for now, or undefined when it is not waiting. */
    backgroundWait(): BackgroundWaitSnapshot | undefined {
        if (this.waitingSince === undefined || this.closed) { return undefined; }
        return { since: this.waitingSince, limitMs: this.backgroundLimitMs, tasks: this.liveBackgroundTasks() };
    }

    /** The tasks still running when the channel closed at the limit (or with waiting off); empty otherwise. */
    get stillRunningAtClose(): BackgroundTaskInfo[] { return this.stillRunning.slice(); }

    /** The limit the channel waits at most, in ms. */
    get backgroundLimit(): number { return this.backgroundLimitMs; }

    /** The prompt stream: our message, each pushed one as it comes, open until {@link close}. */
    async *messages(): AsyncGenerator<SdkPromptMessage, void, unknown> {
        yield {
            type: 'user',
            uuid: this.uuid,
            message: { role: 'user', content: this.text },
            parent_tool_use_id: null,
            session_id: '',
        };
        while (!this.closed) {
            const next = this.outbox.shift();
            if (next) { yield next; continue; }
            await Promise.race([this.closedPromise, new Promise<void>((resolve) => { this.wake = resolve; })]);
            this.wake = undefined;
        }
    }

    /** Feed every message of the query's output stream through here. */
    observe(msg: unknown): void {
        if (this.closed || !msg || typeof msg !== 'object') { return; }
        const m = msg as { type?: unknown; subtype?: unknown; state?: unknown };
        if (m.type === 'system' && m.subtype === 'session_state_changed') {
            this.sawSessionState = true;
            if (m.state === 'running') {
                this.state = 'running';
                this.clearGrace();
            } else if (m.state === 'idle') {
                this.state = 'idle';
                this.onIdle();
            }
            return;
        }
        if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
            this.onTasksChanged((msg as { tasks?: unknown }).tasks);
            return;
        }
        if (m.type === 'assistant') {
            this.recordBackgroundCommands(msg);
            return;
        }
        if (m.type === 'user') {
            this.recordOutputFiles(msg);
            return;
        }
        if (m.type === 'result' && this.settleAnswers(msg) && this.answered) {
            if (!this.sawSessionState) {
                this.close('result-without-session-state');
            }
        }
    }

    /** Close the stream (idempotent; the first reason is kept). */
    close(reason: InputCloseReason): void {
        if (this.closed) { return; }
        this.reason = reason;
        this.clearGrace();
        this.clearBackgroundWait();
        for (const [uuid, waiter] of this.answerOf) {
            waiter.reject(new Error(`the running prompt ended before it answered this update (${reason})`));
            this.answerOf.delete(uuid);
        }
        this.resolveClosed();
        try { this.onClose?.(reason); } catch { /* diagnostics only */ }
    }

    private onIdle(): void {
        if (!this.answered) {
            this.startGrace();
            return;
        }
        if (this.liveTasks.size === 0) {
            this.close('idle-after-answer');
            return;
        }
        if (this.backgroundLimitMs <= 0) {
            this.stillRunning = this.liveBackgroundTasks();
            this.emit({ kind: 'abandoned', tasks: this.stillRunning });
            this.close('idle-after-answer');
            return;
        }
        if (this.backgroundTimer === undefined) {
            // One limit for the whole wait: a follow-up turn while other tasks still run does not restart it.
            this.waitingSince = Date.now();
            this.emit({ kind: 'waiting', tasks: this.liveBackgroundTasks(), limitMs: this.backgroundLimitMs });
            this.backgroundTimer = setTimeout(() => this.onBackgroundLimit(), this.backgroundLimitMs);
        }
    }

    private onTasksChanged(raw: unknown): void {
        const next = new Map<string, TrackedTask>();
        for (const t of Array.isArray(raw) ? raw : []) {
            const task = t as { task_id?: unknown; task_type?: unknown; description?: unknown; ambient?: unknown };
            if (task.ambient === true || typeof task.task_id !== 'string') { continue; }
            next.set(task.task_id, {
                taskId: task.task_id,
                taskType: typeof task.task_type === 'string' ? task.task_type : '',
                description: typeof task.description === 'string' ? task.description : '',
            });
        }
        this.liveTasks = next;
        if (next.size > 0) {
            if (this.waitingSince !== undefined) { this.emit({ kind: 'changed', tasks: this.liveBackgroundTasks() }); }
            return;
        }
        if (this.waitingSince !== undefined) { this.emit({ kind: 'done' }); }
        this.clearBackgroundWait();
        // The CLI normally runs a follow-up turn on the completion notification
        // ('running' cancels this) and the idle after it closes. If none comes,
        // there is nothing left to wait for.
        if (this.answered && this.state === 'idle') {
            this.startGrace('background-done');
        }
    }

    private onBackgroundLimit(): void {
        this.backgroundTimer = undefined;
        if (this.closed || this.liveTasks.size === 0) { return; }
        this.stillRunning = this.liveBackgroundTasks();
        this.emit({ kind: 'limit', tasks: this.stillRunning, limitMs: this.backgroundLimitMs });
        this.close('background-wait-limit');
    }

    /** A Bash call with run_in_background: its command, by tool_use id (named by its task once the result comes). */
    private recordBackgroundCommands(msg: unknown): void {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) { return; }
        for (const block of content) {
            const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown; run_in_background?: unknown } };
            if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.run_in_background === true
                && typeof b.id === 'string' && typeof b.input.command === 'string') {
                this.commandsByToolUse.set(b.id, b.input.command);
            }
        }
    }

    private recordOutputFiles(msg: unknown): void {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) { return; }
        for (const block of content) {
            const b = block as { type?: unknown; content?: unknown; tool_use_id?: unknown };
            if (b?.type !== 'tool_result') { continue; }
            const text = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                    ? b.content.map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('')
                    : '';
            const match = BACKGROUND_BASH_RESULT.exec(text);
            if (match) {
                this.outputFiles.set(match[1], match[2]);
                const command = typeof b.tool_use_id === 'string' ? this.commandsByToolUse.get(b.tool_use_id) : undefined;
                if (command) { this.commands.set(match[1], command); }
            }
        }
    }

    private info(t: TrackedTask): BackgroundTaskInfo {
        const outputFile = this.outputFiles.get(t.taskId);
        const command = this.commands.get(t.taskId);
        return {
            taskId: t.taskId,
            taskType: t.taskType,
            description: t.description,
            ...(outputFile ? { outputFile } : {}),
            ...(command ? { command } : {}),
        };
    }

    private emit(event: InputChannelEvent): void {
        try { this.onEvent?.(event); } catch { /* diagnostics only */ }
    }

    private clearBackgroundWait(): void {
        if (this.backgroundTimer !== undefined) {
            clearTimeout(this.backgroundTimer);
            this.backgroundTimer = undefined;
        }
        this.waitingSince = undefined;
    }

    /**
     * Mark the messages a result answers (its `user_message_uuid(s)`) as
     * answered, and give a pushed one the result's text. Answers whether it
     * answered any of ours.
     */
    private settleAnswers(msg: object): boolean {
        const r = msg as { user_message_uuid?: unknown; user_message_uuids?: unknown; result?: unknown };
        const named = [
            ...(Array.isArray(r.user_message_uuids) ? r.user_message_uuids : []),
            ...(typeof r.user_message_uuid === 'string' ? [r.user_message_uuid] : []),
        ].filter((u): u is string => typeof u === 'string' && this.unanswered.has(u));
        for (const uuid of named) {
            this.unanswered.delete(uuid);
            const waiter = this.answerOf.get(uuid);
            if (waiter) {
                waiter.resolve(typeof r.result === 'string' ? r.result : '');
                this.answerOf.delete(uuid);
            }
        }
        return named.length > 0;
    }

    private startGrace(reason: InputCloseReason = 'idle-unanswered-timeout'): void {
        this.clearGrace();
        this.graceTimer = setTimeout(() => this.close(reason), this.graceMs);
    }

    private clearGrace(): void {
        if (this.graceTimer !== undefined) {
            clearTimeout(this.graceTimer);
            this.graceTimer = undefined;
        }
    }
}

function formatMinutes(ms: number): string {
    const min = ms / 60_000;
    return min >= 1 && Number.isInteger(min) ? formatLimit(min) : `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
}

function listTasks(tasks: BackgroundTaskInfo[]): string {
    return tasks.map((t) => `${t.description || t.taskType} [${t.taskId}]`).join('; ');
}

function countTasks(n: number): string {
    return `${n} background task${n === 1 ? '' : 's'}`;
}

/** One line for the tool log and the live trail, per background-wait event. */
export function describeInputChannelEvent(event: InputChannelEvent): string {
    switch (event.kind) {
        case 'waiting':
            return `Waiting for ${countTasks(event.tasks.length)} still running after the turn ended: ${listTasks(event.tasks)}. `
                + `They count as running while the CLI lists them; the wait ends at the latest after ${formatMinutes(event.limitMs)}.`;
        case 'changed':
            return `Still waiting for ${countTasks(event.tasks.length)}: ${listTasks(event.tasks)}.`;
        case 'done':
            return 'The background work has ended; the turn goes on with its result.';
        case 'limit':
            return `Stopped waiting after ${formatMinutes(event.limitMs)} (the background-wait limit): ${countTasks(event.tasks.length)} still running (${listTasks(event.tasks)}). `
                + 'Their results will not be delivered to this turn.';
        case 'abandoned':
            return `Not waiting for ${countTasks(event.tasks.length)} still running (the background-wait limit is 0): ${listTasks(event.tasks)}. `
                + 'Their results will not be delivered to this turn.';
    }
}

/**
 * The text the SDK puts in a tool result when the call never got an answer
 * from its MCP server. Matched on short results only, so a result that merely
 * quotes the sentence (a log excerpt) is not mistaken for one.
 */
const CHANNEL_DEAD_TEXT = 'interrupted before a result was received';
const CHANNEL_DEAD_MAX_LENGTH = 400;

export function isChannelDeadToolResult(text: string): boolean {
    return text.length <= CHANNEL_DEAD_MAX_LENGTH && text.includes(CHANNEL_DEAD_TEXT);
}
