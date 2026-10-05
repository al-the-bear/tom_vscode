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
 * runs the follow-up turn itself, and the `idle` after it closes. The wait is
 * capped (`backgroundWaitMs`); at the cap a task that still shows progress (a
 * `task_progress` message, or an output file that grew) extends it by another
 * cap, and one that shows none is abandoned and named.
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
    | 'background-wait-capped'
    | (string & {});

/** A live, non-ambient background task the CLI reported. */
export interface BackgroundTaskInfo {
    taskId: string;
    taskType: string;
    description: string;
    /** Where a background Bash writes its output, from its tool result. */
    outputFile?: string;
}

/** What the channel reports about background work, for logging. */
export type InputChannelEvent =
    /** The CLI went idle with these tasks still running; waiting for them. */
    | { kind: 'waiting'; tasks: BackgroundTaskInfo[]; capMs: number }
    /** The cap was reached, but these tasks progressed; waiting one more cap. */
    | { kind: 'extended'; tasks: BackgroundTaskInfo[]; progressed: BackgroundTaskInfo[]; capMs: number }
    /** The cap was reached with no progress; closing despite these tasks. */
    | { kind: 'capped'; tasks: BackgroundTaskInfo[] }
    /** Background waiting is off (cap 0); closing despite these tasks. */
    | { kind: 'abandoned'; tasks: BackgroundTaskInfo[] };

export interface QueryInputChannelOptions {
    /** Uuid stamped on the prompt; defaults to a fresh v4 uuid. */
    uuid?: string;
    /** Wait after an unanswered `idle` before closing anyway. Default 10 s. */
    graceMs?: number;
    /**
     * How long to wait for background tasks that outlive the turn before
     * checking their progress. Default 30 min; 0 = do not wait.
     */
    backgroundWaitMs?: number;
    /**
     * A progress marker for a task, compared between cap checks (the transport
     * passes the output file's size). `undefined` = no marker.
     */
    progressOf?: (task: BackgroundTaskInfo) => number | undefined;
    /** Called once, when the channel closes. */
    onClose?: (reason: InputCloseReason) => void;
    /** Called on each background-wait event. */
    onEvent?: (event: InputChannelEvent) => void;
}

const DEFAULT_GRACE_MS = 10_000;
export const DEFAULT_BACKGROUND_WAIT_MS = 30 * 60_000;

/** The Bash tool's result for a command it moved to the background. */
// The path ends the sentence, so its full stop is not part of it.
const BACKGROUND_BASH_RESULT = /running in background with ID: (\S+?)\. Output is being written to: (\S+?)\.?(?=\s|$)/;

interface TrackedTask extends BackgroundTaskInfo {
    /** `task_progress` messages seen for this task. */
    progressCount: number;
}

export class QueryInputChannel {
    readonly uuid: string;
    private readonly text: string;
    private readonly graceMs: number;
    private readonly backgroundWaitMs: number;
    private readonly progressOf?: (task: BackgroundTaskInfo) => number | undefined;
    private readonly onClose?: (reason: InputCloseReason) => void;
    private readonly onEvent?: (event: InputChannelEvent) => void;
    private answered = false;
    private sawSessionState = false;
    private state: 'running' | 'idle' | undefined;
    private graceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Live non-ambient background tasks, by id (replace semantics). */
    private liveTasks = new Map<string, TrackedTask>();
    /** Output files by task id, from Bash tool results; outlives the task set. */
    private readonly outputFiles = new Map<string, string>();
    private backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    /** Each live task's progress marker at the previous cap check. */
    private progressSnapshot = new Map<string, string>();
    private reason: InputCloseReason | undefined;
    private resolveClosed!: () => void;
    private readonly closedPromise: Promise<void>;

    constructor(text: string, options: QueryInputChannelOptions = {}) {
        this.text = text;
        this.uuid = options.uuid ?? randomUUID();
        this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
        this.backgroundWaitMs = options.backgroundWaitMs ?? DEFAULT_BACKGROUND_WAIT_MS;
        this.progressOf = options.progressOf;
        this.onClose = options.onClose;
        this.onEvent = options.onEvent;
        this.closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
    }

    get closed(): boolean { return this.reason !== undefined; }
    get closeReason(): InputCloseReason | undefined { return this.reason; }

    /** The live non-ambient background tasks, as last reported. */
    liveBackgroundTasks(): BackgroundTaskInfo[] {
        return [...this.liveTasks.values()].map((t) => this.info(t));
    }

    /** The prompt stream: our one message, then open until {@link close}. */
    async *messages(): AsyncGenerator<SdkPromptMessage, void, unknown> {
        yield {
            type: 'user',
            uuid: this.uuid,
            message: { role: 'user', content: this.text },
            parent_tool_use_id: null,
            session_id: '',
        };
        await this.closedPromise;
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
        if (m.type === 'system' && m.subtype === 'task_progress') {
            const task = this.liveTasks.get(String((msg as { task_id?: unknown }).task_id));
            if (task) { task.progressCount++; }
            return;
        }
        if (m.type === 'user') {
            this.recordOutputFiles(msg);
            return;
        }
        if (m.type === 'result' && this.answers(msg)) {
            this.answered = true;
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
        if (this.backgroundWaitMs <= 0) {
            this.emit({ kind: 'abandoned', tasks: this.liveBackgroundTasks() });
            this.close('idle-after-answer');
            return;
        }
        if (this.backgroundTimer === undefined) {
            this.progressSnapshot = this.progressMarkers();
            this.emit({ kind: 'waiting', tasks: this.liveBackgroundTasks(), capMs: this.backgroundWaitMs });
            this.backgroundTimer = setTimeout(() => this.onBackgroundCap(), this.backgroundWaitMs);
        }
    }

    private onTasksChanged(raw: unknown): void {
        const next = new Map<string, TrackedTask>();
        for (const t of Array.isArray(raw) ? raw : []) {
            const task = t as { task_id?: unknown; task_type?: unknown; description?: unknown; ambient?: unknown };
            if (task.ambient === true || typeof task.task_id !== 'string') { continue; }
            const known = this.liveTasks.get(task.task_id);
            next.set(task.task_id, {
                taskId: task.task_id,
                taskType: typeof task.task_type === 'string' ? task.task_type : '',
                description: typeof task.description === 'string' ? task.description : '',
                progressCount: known?.progressCount ?? 0,
            });
        }
        this.liveTasks = next;
        if (next.size > 0) { return; }
        this.clearBackgroundWait();
        // The CLI normally runs a follow-up turn on the completion notification
        // ('running' cancels this) and the idle after it closes. If none comes,
        // there is nothing left to wait for.
        if (this.answered && this.state === 'idle') {
            this.startGrace('background-done');
        }
    }

    private onBackgroundCap(): void {
        this.backgroundTimer = undefined;
        if (this.closed || this.liveTasks.size === 0) { return; }
        const now = this.progressMarkers();
        const progressed = [...this.liveTasks.values()]
            .filter((t) => now.get(t.taskId) !== this.progressSnapshot.get(t.taskId))
            .map((t) => this.info(t));
        if (progressed.length === 0) {
            this.emit({ kind: 'capped', tasks: this.liveBackgroundTasks() });
            this.close('background-wait-capped');
            return;
        }
        this.progressSnapshot = now;
        this.emit({ kind: 'extended', tasks: this.liveBackgroundTasks(), progressed, capMs: this.backgroundWaitMs });
        this.backgroundTimer = setTimeout(() => this.onBackgroundCap(), this.backgroundWaitMs);
    }

    private progressMarkers(): Map<string, string> {
        const markers = new Map<string, string>();
        for (const t of this.liveTasks.values()) {
            let size: number | undefined;
            try { size = this.progressOf?.(this.info(t)); } catch { size = undefined; }
            markers.set(t.taskId, `${t.progressCount}:${size ?? ''}`);
        }
        return markers;
    }

    private recordOutputFiles(msg: unknown): void {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (!Array.isArray(content)) { return; }
        for (const block of content) {
            const b = block as { type?: unknown; content?: unknown };
            if (b?.type !== 'tool_result') { continue; }
            const text = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                    ? b.content.map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('')
                    : '';
            const match = BACKGROUND_BASH_RESULT.exec(text);
            if (match) { this.outputFiles.set(match[1], match[2]); }
        }
    }

    private info(t: TrackedTask): BackgroundTaskInfo {
        const outputFile = this.outputFiles.get(t.taskId);
        return {
            taskId: t.taskId,
            taskType: t.taskType,
            description: t.description,
            ...(outputFile ? { outputFile } : {}),
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
    }

    private answers(msg: object): boolean {
        const r = msg as { user_message_uuid?: unknown; user_message_uuids?: unknown };
        if (Array.isArray(r.user_message_uuids) && r.user_message_uuids.includes(this.uuid)) { return true; }
        return r.user_message_uuid === this.uuid;
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
    return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
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
                + `Progress is checked after ${formatMinutes(event.capMs)}.`;
        case 'extended':
            return `Background work still progressing (${listTasks(event.progressed)}); waiting another ${formatMinutes(event.capMs)}.`;
        case 'capped':
            return `Stopped waiting: no progress from ${countTasks(event.tasks.length)} (${listTasks(event.tasks)}). `
                + 'Their results will not be delivered to this turn.';
        case 'abandoned':
            return `Not waiting for ${countTasks(event.tasks.length)} still running (maxBackgroundWaitMinutes is 0): ${listTasks(event.tasks)}. `
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
