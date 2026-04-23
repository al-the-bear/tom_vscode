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

export interface LiveTrailPromptInfo {
    transport: string;
    config: string;
    userText: string;
}

export class LiveTrailWriter {
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

    constructor(questId: string) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
        const safeQuest = (questId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
        this.filePath = path.join(questsRoot, safeQuest, 'live-trail.md');
    }

    /** Absolute path the writer is targeting — useful for the chat panel's Open button. */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Emit a new `## 🚀 PROMPT …` block. Trims older blocks first so the
     * file never holds more than MAX_PROMPT_BLOCKS. Resets the streaming
     * state so the next text/thinking chunk starts a fresh heading.
     */
    beginPrompt(info: LiveTrailPromptInfo): void {
        try {
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
        } catch { /* swallowed */ }
    }

    endPrompt(summary: { rounds: number; toolCalls: number; durationMs?: number }): void {
        try {
            const ms = summary.durationMs ?? (this.startedAtMs ? Date.now() - this.startedAtMs : 0);
            this.append(`\n\n### ✅ DONE (rounds=${summary.rounds}, toolCalls=${summary.toolCalls}, ${ms}ms)\n`);
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
        } catch { /* swallowed */ }
    }

    endPromptWithError(message: string): void {
        try {
            this.append(`\n\n### ⚠️ ERROR\n\n\`\`\`text\n${this.clip(message, 2000)}\n\`\`\`\n`);
            this.currentlyInAssistantText = false;
            this.currentlyInThinking = false;
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
        } catch { /* swallowed */ }
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
     * appends a new PROMPT header only MAX_PROMPT_BLOCKS remain, and
     * return the trimmed body. Never writes — the caller composes the
     * next write including the new header.
     */
    private trimOldBlocks(): string {
        const current = this.readFileSafe();
        if (!current) { return `${HEADER_COMMENT}\n`; }
        const lines = current.split(/\r?\n/);
        const headerIdx: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(PROMPT_HEADER_PREFIX)) { headerIdx.push(i); }
        }
        // If we already have N blocks, after the caller adds one we'd
        // have N+1. We want exactly MAX_PROMPT_BLOCKS afterwards, i.e.
        // keep the last (MAX_PROMPT_BLOCKS - 1) current blocks. Drop
        // lines above the (headerIdx[length - (MAX_PROMPT_BLOCKS - 1)])
        // entry.
        if (headerIdx.length < MAX_PROMPT_BLOCKS) {
            return current;
        }
        const keepFromIdx = headerIdx[headerIdx.length - (MAX_PROMPT_BLOCKS - 1)];
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
