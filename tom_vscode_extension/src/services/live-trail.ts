/**
 * Live Trail writer — continuously updates `_ai/quests/<quest>/live-trail.md`
 * as an Anthropic turn runs, so the user can watch the model's thinking /
 * tool calls / assistant text arrive step by step in the MD Browser.
 *
 * Design in `doc/chat_log_custom_editor.md`. Key invariants:
 *
 *   - One file per quest. Holds the **last 5 prompt blocks**; oldest is
 *     dropped on every new `## 🚀 PROMPT …` header the writer emits.
 *   - Synchronous writes (`fs.writeFileSync`). One write per event so
 *     the MD Browser's file-watcher sees progressive updates.
 *   - No concurrent-writer protection — the Anthropic handler owns the
 *     file for the duration of its turn, and only one send runs at a
 *     time per window. Last-writer-wins if something races.
 *   - Quiet on failure. Trail writes are observability; a broken one
 *     must never affect the turn's actual result.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';
import { InterruptionKind, interruptionLabel } from '../utils/anthropicErrorClassifier';

const HEADER_COMMENT = '<!-- tom-ai live-trail -->';
/** Per-kind marker used by `endPromptWithInterruption` — all yellow family. */
const INTERRUPTION_EMOJI: Record<InterruptionKind, string> = {
    rate_limit: '🟡',
    quota_exceeded: '🛑',
    overloaded: '⚡',
    cancelled: '⏹️',
    interrupted: '⏸️',
};
/** `## 🚀 PROMPT …` line marker used for block boundaries. */
const PROMPT_HEADER_PREFIX = '## 🚀 PROMPT ';
/** How many past prompt blocks to keep before the current one. */
const MAX_PROMPT_BLOCKS = 5;
/** Truncate previews of user text / tool input / tool result previews. */
const USER_TEXT_PREVIEW_CHARS = 1000;
const TOOL_INPUT_PREVIEW_CHARS = 2000;
const TOOL_RESULT_PREVIEW_CHARS = 800;

/** Canonical Anthropic-side live-trail filename (the writer's default). */
export const ANTHROPIC_LIVE_TRAIL_FILENAME = 'live-trail.md';
/**
 * Local LLM live-trail filename, written next to the Anthropic-side
 * `live-trail.md` so both transports update parallel trails without clobbering
 * each other. Lives here (not in the handler) so stateless consumers — e.g. the
 * Quest Refresh service truncating the trail — can resolve the same path without
 * importing the handler (which would create a cycle).
 */
export const LOCAL_LLM_LIVE_TRAIL_FILENAME = 'live-trail-localLLM.md';

/**
 * Where a prompt originated, so consumers can tell a queue-dispatched run apart
 * from a direct chat send (panel Send button, Send-to-Chat, scripting bridge,
 * or a Telegram `send_prompt`). A queue item and a direct send can run
 * concurrently — they use independent cancellation sources — so the Telegram
 * `/chat_status` reports each separately and `/cancel_queue` / `/cancel_chat`
 * target the right one.
 */
export type PromptSource = 'queue' | 'chat';

export interface LiveTrailPromptInfo {
    transport: string;
    config: string;
    userText: string;
    /** Origin of the prompt. Defaults to `'chat'` when omitted. */
    source?: PromptSource;
}

/**
 * Semantic events emitted by a {@link LiveTrailWriter} as a turn runs. These
 * mirror the markdown the writer appends to `live-trail.md`, but as structured
 * data so consumers (e.g. the Telegram forwarder) can follow a turn without
 * parsing the file. Every event carries the writer's `questId` so a consumer
 * can filter to the quest it cares about, plus the prompt's `source` (`'queue'`
 * vs `'chat'`) stamped by the writer so a consumer can attribute terminal
 * events — which carry no other identifying fields — to the run that ended.
 * `source` is optional on the type (so source-agnostic constructors, e.g. the
 * coalescer's tests, stay terse) but `emit` always stamps it in production.
 *
 * The `kind` discriminator drives which extra fields are present:
 *   - `prompt`       — a new prompt block opened (`transport`/`config`/`userText`).
 *   - `thinking`     — a chunk of model thinking text (`text`).
 *   - `toolCall`     — a tool invocation started (`toolName`/`replayKey`).
 *   - `toolResult`   — a tool returned (`fullLength` = result size in chars).
 *   - `assistant`    — a chunk of assistant text (`text`).
 *   - `retry`        — a transient failure is being retried mid-turn
 *                      (`message` = the UI status line, `cause` = the triggering
 *                      error). The turn has NOT ended; more events follow.
 *   - `done`         — the turn finished cleanly (`rounds`/`toolCalls`/`durationMs`).
 *   - `error`        — the turn failed (`message`).
 *   - `interruption` — the turn was interrupted/rate-limited (`label`/`message`).
 */
export type LiveTrailEvent =
    | { kind: 'prompt'; questId: string; source?: PromptSource; transport: string; config: string; userText: string }
    | { kind: 'thinking'; questId: string; source?: PromptSource; text: string }
    | { kind: 'toolCall'; questId: string; source?: PromptSource; toolName: string; replayKey: string }
    | { kind: 'toolResult'; questId: string; source?: PromptSource; fullLength: number }
    | { kind: 'assistant'; questId: string; source?: PromptSource; text: string }
    | { kind: 'retry'; questId: string; source?: PromptSource; message: string; cause?: string }
    | { kind: 'done'; questId: string; source?: PromptSource; rounds: number; toolCalls: number; durationMs: number }
    | { kind: 'error'; questId: string; source?: PromptSource; message: string }
    | { kind: 'interruption'; questId: string; source?: PromptSource; label: string; message: string };

/** Observer callback invoked for every {@link LiveTrailEvent}. */
export type LiveTrailObserver = (event: LiveTrailEvent) => void;

/**
 * Union-aware `Omit`: distributes over each member so dropping `questId` keeps
 * the per-member fields (a plain `Omit` over a union collapses to common keys).
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A {@link LiveTrailEvent} as supplied to `emit`, before `questId` and `source`
 * are stamped on from the writer's own fields.
 */
type LiveTrailEventInput = DistributiveOmit<LiveTrailEvent, 'questId' | 'source'>;

export class LiveTrailWriter {
    /**
     * Process-wide set of observers notified of every {@link LiveTrailEvent}
     * from any writer instance. Static so a consumer can subscribe once
     * (e.g. when a Telegram-driven prompt starts) and receive events from the
     * writer the handler creates per turn, without threading the writer
     * through. Observers filter by `event.questId` themselves.
     */
    private static observers = new Set<LiveTrailObserver>();

    /**
     * Subscribe to live-trail events from all writers. Returns a disposable
     * that removes the observer. Observer exceptions are swallowed so a broken
     * consumer can never affect a turn.
     */
    static addObserver(observer: LiveTrailObserver): { dispose(): void } {
        LiveTrailWriter.observers.add(observer);
        return {
            dispose(): void {
                LiveTrailWriter.observers.delete(observer);
            },
        };
    }

    /** Raw (unsanitized) quest id stamped onto every emitted event. */
    private readonly questId: string;
    /**
     * Which originator the current turn belongs to — `'queue'` for prompts
     * dispatched by the prompt queue, `'chat'` for direct sends (panel Send,
     * Send-to-Chat, Telegram `send_prompt`). Stamped onto every emitted event
     * (including terminal `done`/`error`/`interruption`, which carry no
     * identifying fields of their own) so observers like the Telegram forwarder
     * can attribute a run to its source. Set by {@link beginPrompt}; defaults
     * to `'chat'`.
     */
    private promptSource: PromptSource = 'chat';
    private filePath: string;
    private startedAtMs = 0;
    /**
     * Tracks whether we're currently appending text to an existing `### 💬
     * assistant` heading, so stream-style incremental text updates fold
     * into the same paragraph instead of producing a new heading per
     * chunk. Reset to `false` by every non-text event.
     */
    private currentlyInAssistantText = false;
    /** Same idea for `### 🧠 thinking` streaming. */
    private currentlyInThinking = false;
    /**
     * Extra prompt blocks to retain on top of {@link MAX_PROMPT_BLOCKS}.
     * Driven by the Quest Refresh feature: while a refresh interval is active
     * the handler sets this to the interval so every prompt since the last
     * refresh is retained for the refresh prompt to read. `0` (default) ⇒ the
     * original last-5-blocks behaviour. Reset to base happens via
     * {@link truncateToBase} when a refresh fires.
     */
    private extraBlockAllowance = 0;

    /**
     * @param questId    The quest folder name to target.
     * @param fileName   Markdown filename inside the quest's folder. Defaults
     *                   to `'live-trail.md'` (the Anthropic-side canonical
     *                   file). The Local LLM path passes
     *                   `'live-trail-localLLM.md'` so the two transports
     *                   write parallel trails in the same folder without
     *                   stomping on each other.
     */
    constructor(questId: string, fileName: string = 'live-trail.md') {
        this.questId = questId || 'default';
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
        const safeQuest = (questId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
        // Sanitize the filename the same way the quest segment is sanitized
        // — defensive: callers pass a literal string, but accepting a
        // user-supplied value via a future API would otherwise let a
        // malicious filename escape the quest folder.
        const safeName = fileName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'live-trail.md';
        this.filePath = path.join(questsRoot, safeQuest, safeName);
    }

    /** Absolute path the writer is targeting — useful for the chat panel's Open button. */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Set how many prompt blocks to retain **on top of** the base
     * {@link MAX_PROMPT_BLOCKS}. Used by Quest Refresh so the live-trail holds
     * every prompt since the last refresh (base + interval). Negative values
     * clamp to 0. `0` restores the original last-5-blocks behaviour.
     */
    setExtraBlockAllowance(n: number): void {
        this.extraBlockAllowance = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }

    /**
     * Force-trim the file down to the base {@link MAX_PROMPT_BLOCKS} blocks,
     * discarding the extra blocks accumulated under an active refresh
     * allowance. Called when a Quest Refresh fires so the trail starts the
     * next interval window clean. No-op if the file is missing or already at
     * or below the base size.
     */
    truncateToBase(): void {
        try {
            const trimmed = this.trimToKeep(MAX_PROMPT_BLOCKS);
            if (trimmed === undefined) { return; }
            this.write(trimmed);
        } catch {
            // swallowed — trail writes must never affect the turn
        }
    }

    /**
     * Emit a new `## 🚀 PROMPT …` block. Trims older blocks first so the
     * file never holds more than MAX_PROMPT_BLOCKS. Resets the streaming
     * state so the next text/thinking chunk starts a fresh heading.
     */
    beginPrompt(info: LiveTrailPromptInfo): void {
        try {
            this.promptSource = info.source ?? 'chat';
            this.ensureParentDir();
            const trimmed = this.trimOldBlocks();
            this.startedAtMs = Date.now();
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            const ts = this.formatTimestamp(new Date());
            const userPreview = this.clip(info.userText, USER_TEXT_PREVIEW_CHARS)
                .replace(/\r?\n/g, '\n> ');
            const lines = [
                trimmed.trim(),
                '',
                `${PROMPT_HEADER_PREFIX}${ts} [${info.transport} / ${info.config}]`,
                '',
                `> User: ${userPreview}`,
                '',
            ].filter((l, i) => !(i === 0 && l === ''));  // drop leading empty when trimmed body was empty
            this.write(lines.join('\n'));
            this.emit({ kind: 'prompt', transport: info.transport, config: info.config, userText: info.userText });
        } catch {
            // swallowed — trail writes must never affect the turn
        }
    }

    appendThinking(text: string): void {
        if (!text) { return; }
        try {
            const body = this.currentlyInThinking
                ? text
                : `\n### 🧠 thinking\n\n${text}`;
            this.currentlyInThinking = true;
            this.currentlyInAssistantText = false;
            this.append(body);
            this.emit({ kind: 'thinking', text });
        } catch { /* swallowed */ }
    }

    beginToolCall(toolName: string, input: unknown, replayKey: string): void {
        try {
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            const inputJson = this.clip(this.safeStringify(input), TOOL_INPUT_PREVIEW_CHARS);
            this.append(
                `\n### 🔧 ${toolName} [${replayKey}]\n\n` +
                '```json\n' +
                inputJson + '\n' +
                '```\n',
            );
            this.emit({ kind: 'toolCall', toolName, replayKey });
        } catch { /* swallowed */ }
    }

    appendToolResult(resultPreview: string, fullLength: number): void {
        try {
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            const preview = this.clip(resultPreview, TOOL_RESULT_PREVIEW_CHARS);
            const truncatedNote = fullLength > TOOL_RESULT_PREVIEW_CHARS ? ' — preview' : '';
            this.append(
                `\n<details><summary>📤 result (${fullLength} chars)${truncatedNote}</summary>\n\n` +
                '```text\n' +
                preview + '\n' +
                '```\n\n' +
                '</details>\n',
            );
            this.emit({ kind: 'toolResult', fullLength });
        } catch { /* swallowed */ }
    }

    appendAssistantText(text: string): void {
        if (!text) { return; }
        try {
            const body = this.currentlyInAssistantText
                ? text
                : `\n### 💬 assistant\n\n${text}`;
            this.currentlyInAssistantText = true;
            this.currentlyInThinking = false;
            this.append(body);
            this.emit({ kind: 'assistant', text });
        } catch { /* swallowed */ }
    }

    /**
     * Record a transient-failure retry **inside** the current prompt block,
     * so the user can see in the trail that an error occurred and is being
     * ridden out — without opening the Tom Tool Log. Unlike
     * {@link endPromptWithError} / {@link endPromptWithInterruption} this does
     * NOT close the block: the turn continues, and the next thinking / text /
     * tool event opens a fresh heading (the streaming flags are reset).
     *
     * @param message UI-ready status line (e.g. "Backend busy — retrying in 4s …").
     * @param cause   The triggering error text, rendered in a fenced block when set.
     */
    appendRetry(message: string, cause?: string): void {
        if (!message) { return; }
        try {
            const causeBlock = cause
                ? '\n\n```text\n' + this.clip(cause, 1000) + '\n```\n'
                : '\n';
            this.append(`\n### 🔁 retry\n\n${message}${causeBlock}`);
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            this.emit({ kind: 'retry', message, cause });
        } catch { /* swallowed */ }
    }

    endPrompt(summary: { rounds: number; toolCalls: number; durationMs?: number }): void {
        try {
            const ms = summary.durationMs ?? (this.startedAtMs ? Date.now() - this.startedAtMs : 0);
            this.append(`\n\n### ✅ DONE (rounds=${summary.rounds}, toolCalls=${summary.toolCalls}, ${ms}ms)\n`);
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            this.emit({ kind: 'done', rounds: summary.rounds, toolCalls: summary.toolCalls, durationMs: ms });
        } catch { /* swallowed */ }
    }

    endPromptWithError(message: string): void {
        try {
            this.append(`\n\n### ⚠️ ERROR\n\n\`\`\`text\n${this.clip(message, 2000)}\n\`\`\`\n`);
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            this.emit({ kind: 'error', message });
        } catch { /* swallowed */ }
    }

    /**
     * Close the current prompt block with a **yellow interruption banner**
     * instead of the red `### ⚠️ ERROR` — used for rate-limit / quota /
     * overload / cancellation / mid-stream interruption cases that the
     * user can recover from by resending.
     *
     * Each kind gets its own emoji so a glance at the live-trail file tells
     * the user what happened without having to read the message body.
     */
    endPromptWithInterruption(kind: InterruptionKind, message: string): void {
        try {
            const emoji = INTERRUPTION_EMOJI[kind] ?? '🟡';
            const label = interruptionLabel(kind).toUpperCase();
            this.append(
                `\n\n### ${emoji} ${label}\n\n` +
                '```text\n' +
                this.clip(message, 2000) + '\n' +
                '```\n',
            );
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
            this.emit({ kind: 'interruption', label, message });
        } catch { /* swallowed */ }
    }

    // ------------------------------------------------------------------------
    // Observer dispatch
    // ------------------------------------------------------------------------

    /**
     * Notify all static observers of an event. Each observer is isolated: a
     * throwing observer never affects the others or the turn. Events that omit
     * `questId` are stamped with this writer's quest id.
     */
    private emit(event: LiveTrailEventInput): void {
        if (LiveTrailWriter.observers.size === 0) { return; }
        const full = { ...event, questId: this.questId, source: this.promptSource } as LiveTrailEvent;
        for (const observer of LiveTrailWriter.observers) {
            try {
                observer(full);
            } catch {
                // swallowed — a broken observer must never affect the turn
            }
        }
    }

    // ------------------------------------------------------------------------
    // File I/O helpers
    // ------------------------------------------------------------------------

    private ensureParentDir(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private readFileSafe(): string {
        try {
            return fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, 'utf-8') : '';
        } catch {
            return '';
        }
    }

    private write(content: string): void {
        this.ensureParentDir();
        const body = content.startsWith(HEADER_COMMENT) ? content : `${HEADER_COMMENT}\n\n${content}`;
        fs.writeFileSync(this.filePath, body.endsWith('\n') ? body : body + '\n', 'utf-8');
    }

    private append(content: string): void {
        const current = this.readFileSafe();
        const next = (current.length > 0 ? current : `${HEADER_COMMENT}\n\n`) + content;
        this.ensureParentDir();
        fs.writeFileSync(this.filePath, next.endsWith('\n') ? next : next + '\n', 'utf-8');
    }

    /**
     * Read the current file, drop enough of its head that after the caller
     * appends a new PROMPT header only the effective limit remains, and
     * return the trimmed body. The effective limit is
     * `MAX_PROMPT_BLOCKS + extraBlockAllowance`. Never writes — the caller
     * composes the next write including the new header.
     */
    private trimOldBlocks(): string {
        const current = this.readFileSafe();
        if (!current) { return `${HEADER_COMMENT}\n`; }
        const effectiveLimit = MAX_PROMPT_BLOCKS + this.extraBlockAllowance;
        // After the caller adds one header we want exactly `effectiveLimit`
        // blocks, i.e. keep the last (effectiveLimit - 1) current blocks.
        const trimmed = this.trimToKeep(effectiveLimit - 1);
        return trimmed ?? current;
    }

    /**
     * Return the file body trimmed to keep only the **last `keepBlocks`**
     * prompt blocks (prefixed with the header comment). Returns `undefined`
     * when no trimming is needed — the file is missing, or already holds
     * `keepBlocks` or fewer blocks — so callers can skip a redundant write.
     */
    private trimToKeep(keepBlocks: number): string | undefined {
        const current = this.readFileSafe();
        if (!current) { return undefined; }
        const lines = current.split(/\r?\n/);
        const headerIdx: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(PROMPT_HEADER_PREFIX)) { headerIdx.push(i); }
        }
        if (headerIdx.length <= keepBlocks) { return undefined; }
        const keepFromIdx = headerIdx[headerIdx.length - keepBlocks];
        const keepFromLine = Math.max(0, keepFromIdx);
        const kept = lines.slice(keepFromLine).join('\n');
        return `${HEADER_COMMENT}\n\n${kept}`;
    }

    private safeStringify(v: unknown): string {
        try {
            return JSON.stringify(v, null, 2);
        } catch {
            return String(v);
        }
    }

    private clip(s: string, max: number): string {
        if (typeof s !== 'string') { s = String(s ?? ''); }
        if (s.length <= max) { return s; }
        return s.slice(0, max) + '\n…(trimmed)';
    }

    private formatTimestamp(d: Date): string {
        const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
        return (
            `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
            `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
        );
    }
}
