/**
 * The Copilot answer-file round trip for a caller that is no queue item: the
 * scripting API's `sendToChatVce` with `target: 'copilot'`
 * (handlers/sendToChatRouter.ts sendToChatForScript). It opens Copilot Chat
 * with the prompt wrapped in the Copilot Queue Wrapper
 * (utils/copilotTemplates.ts), which tells Copilot to write its answer to
 * `<copilot.answerFolder>/<requestId>_answer.json`, and waits for that file.
 *
 * This was the tool `tomAi_askCopilot` until vscimpb108 removed it; the round
 * trip stayed because scripts use it. Its timing is fixed (two minutes, a poll
 * every two seconds); the template is the wrapper alone.
 *
 * The pure part (`copilotRoundTripImpl`, narrow deps) is vscode-free and
 * tested with fakes; `askCopilotForScript` wires the live deps.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { copilotQueueWrapper } from '../utils/copilotTemplates';
import { updateChatResponseValues, loadSendToChatConfig, getWorkspaceRoot } from '../handlers/handler_shared';
import { expandTemplate } from '../handlers/promptTemplate';
import { generateShortUUID, getCopilotAnswerFile } from '../utils/variableResolver';
import { logPrompt, logResponse } from './trailLogging';
import { WsPaths } from '../utils/workspacePaths';

/** How long a script waits for Copilot's answer file, and how often it looks. */
export const COPILOT_ROUND_TRIP_TIMEOUT_MS = 120_000;
export const COPILOT_ROUND_TRIP_POLL_MS = 2_000;

export interface CopilotConfigSnapshot {
    /** Default polling timeout when input.timeoutMs is omitted. */
    answerFileTimeoutMs: number;
    pollIntervalMs: number;
    /** Active template id; pass `'__none__'` or `'__answer_file__'` to skip the user template. */
    selectedTemplateId: string;
    /** Template body for the active selected template (when not __none__/__answer_file__). */
    selectedTemplateBody?: string;
    /** Required wrapper template that tells Copilot how to write the answer file. */
    answerFileTemplate: string;
}

export interface CopilotChatOpener {
    /** Open Copilot Chat with the rendered query.  Resolves on success, rejects on failure. */
    open(query: string): Promise<void>;
}

export interface AnswerFileSink {
    /** Absolute on-disk path the impl should report in envelope (for diagnostics). */
    absolutePath(): string;
    /** Wipe any pre-existing answer file (idempotent). */
    clear(): void;
    /**
     * Return the answer-file contents (already trimmed) when it exists
     * and is non-empty; return `null` while still waiting.  Throw to
     * surface an unrecoverable read error.
     */
    read(): string | null;
}

export interface TemplateExpander {
    /** `values` override the built-in placeholders of the same name. */
    expand(template: string, values: { originalPrompt: string; userMessage?: string; requestId?: string; copilotAnswerFile?: string }): Promise<string>;
}

/** Optional callback for `responseValues` extracted from JSON answer payloads. */
export type ResponseValuesSink = (values: Record<string, unknown>) => void;

/** Optional clock for testing timeout deterministically. */
export interface PollClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

const realClock: PollClock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ===========================================================================
// Envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Inputs
// ===========================================================================

export interface CopilotRoundTripInput {
    prompt: string;
    waitForAnswer?: boolean;
    timeoutMs?: number;
}

export interface CopilotRoundTripDeps {
    config: () => CopilotConfigSnapshot;
    opener: CopilotChatOpener;
    /** A fresh request id for one ask. */
    newRequestId: () => string;
    /** The answer file of request `requestId` (the one the wrapper's `${copilotAnswerFile}` names). */
    sinkFor: (requestId: string) => AnswerFileSink;
    expander: TemplateExpander;
    onResponseValues?: ResponseValuesSink;
    clock?: PollClock;
    /** True once the caller gave up: the polling stops. */
    promptEnded?: () => boolean;
}

/** The answer of an ask whose prompt ended while it waited. */
function promptEndedAnswer(answerFile: string, elapsedMs: number): string {
    return err('cancelled: the prompt was ended — stopped waiting for Copilot\'s answer file.', { cancelled: true, reason: 'prompt-ended', answerFile, elapsedMs });
}

// ===========================================================================
// Impl
// ===========================================================================

export async function copilotRoundTripImpl(deps: CopilotRoundTripDeps, input: CopilotRoundTripInput): Promise<string> {
    try {
        if (!input.prompt || !input.prompt.trim()) {
            return err('`prompt` is required.');
        }
        const config = deps.config();
        const clock = deps.clock ?? realClock;
        const waitForAnswer = input.waitForAnswer ?? true;
        const timeoutMs = input.timeoutMs ?? config.answerFileTimeoutMs;
        // One request id for the ask: the wrapper names it and the file to write; the tool waits for that file.
        const requestId = deps.newRequestId();
        const sink = deps.sinkFor(requestId);
        const wrapperValues = { requestId, copilotAnswerFile: sink.absolutePath() };

        // Render the prompt through the template chain.
        let expanded: string;
        const wrapperOnly = !config.selectedTemplateId
            || config.selectedTemplateId === '__answer_file__'
            || config.selectedTemplateId === '__none__';
        if (!wrapperOnly && config.selectedTemplateBody) {
            // A user-message template's body holds ${userMessage}; ${originalPrompt} is filled the same way.
            const inner = await deps.expander.expand(config.selectedTemplateBody, { originalPrompt: input.prompt, userMessage: input.prompt });
            expanded = await deps.expander.expand(config.answerFileTemplate, { originalPrompt: inner, ...wrapperValues });
        } else {
            expanded = await deps.expander.expand(config.answerFileTemplate, { originalPrompt: input.prompt, ...wrapperValues });
        }

        // Clear the answer file BEFORE opening Copilot, so a stale read
        // can't masquerade as a fresh answer.
        sink.clear();

        // Open Copilot Chat.
        try {
            await deps.opener.open(expanded);
        } catch (e) {
            return err(`Error opening Copilot Chat: ${(e as Error).message}`);
        }

        if (!waitForAnswer) {
            return ok({
                sent: true,
                waitForAnswer: false,
                answerFile: sink.absolutePath(),
                requestId,
                note: 'Prompt sent to Copilot Chat. Caller chose not to wait.',
            });
        }

        // Poll for the answer file.
        const start = clock.now();
        const pollInterval = config.pollIntervalMs;
        while (clock.now() - start < timeoutMs) {
            if (deps.promptEnded?.()) { return promptEndedAnswer(sink.absolutePath(), clock.now() - start); }
            await clock.sleep(pollInterval);
            if (deps.promptEnded?.()) { return promptEndedAnswer(sink.absolutePath(), clock.now() - start); }
            let content: string | null;
            try {
                content = sink.read();
            } catch (e) {
                return err(`Error reading answer file: ${(e as Error).message}`, {
                    answerFile: sink.absolutePath(),
                });
            }
            if (content === null) { continue; }
            // Try JSON first; fall back to plain text.
            try {
                const parsed = JSON.parse(content) as {
                    generatedMarkdown?: unknown;
                    response?: unknown;
                    responseValues?: unknown;
                    requestId?: string;
                };
                if (parsed.responseValues && typeof parsed.responseValues === 'object') {
                    deps.onResponseValues?.(parsed.responseValues as Record<string, unknown>);
                }
                // The wrapper's schema puts the answer in `generatedMarkdown`; `response` is read too.
                const text = typeof parsed.generatedMarkdown === 'string' ? parsed.generatedMarkdown
                    : typeof parsed.response === 'string' ? parsed.response : null;
                if (text !== null) {
                    return ok({
                        format: 'json' as const,
                        response: text,
                        requestId: parsed.requestId ?? requestId,
                        elapsedMs: clock.now() - start,
                    });
                }
                return ok({
                    format: 'json' as const,
                    response: JSON.stringify(parsed, null, 2),
                    requestId: parsed.requestId ?? requestId,
                    elapsedMs: clock.now() - start,
                });
            } catch {
                return ok({
                    format: 'text' as const,
                    response: content,
                    elapsedMs: clock.now() - start,
                });
            }
        }
        return err(`Timeout waiting for Copilot response after ${Math.round(timeoutMs / 1000)}s.`, {
            timedOut: true,
            timeoutMs,
            hint: 'The answer file was not created. Copilot may still be processing — check the chat window.',
            answerFile: sink.absolutePath(),
        });
    } catch (e) {
        return err(`Copilot round trip failed: ${(e as Error).message}`);
    }
}


// ===========================================================================
// Live
// ===========================================================================

/** The answer file of a request, where the Copilot Queue Wrapper tells Copilot to write it. */
function liveSink(requestId: string): AnswerFileSink {
    const absPath = getCopilotAnswerFile(requestId);
    const folder = path.dirname(absPath);
    return {
        absolutePath() { return absPath; },
        clear() {
            if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { recursive: true }); }
            if (fs.existsSync(absPath)) { fs.unlinkSync(absPath); }
        },
        read() {
            if (!fs.existsSync(absPath)) { return null; }
            const content = fs.readFileSync(absPath, 'utf-8').trim();
            return content ? content : null;
        },
    };
}

/**
 * Send `prompt` to Copilot Chat and wait for its answer file. Answers the JSON
 * envelope: `{ok: true, format, response, requestId, elapsedMs}`, or
 * `{ok: false, error, …}` (a timeout: `timedOut: true`).
 */
export async function askCopilotForScript(input: CopilotRoundTripInput): Promise<string> {
    if (!getWorkspaceRoot()) {
        return JSON.stringify({ ok: false, error: 'No workspace folder open.' });
    }
    const questId = WsPaths.getWorkspaceQuestId();
    logPrompt('copilot', 'github_copilot', input.prompt, undefined, { questId, source: 'script' });
    const raw = await copilotRoundTripImpl({
        config: () => ({
            answerFileTimeoutMs: COPILOT_ROUND_TRIP_TIMEOUT_MS,
            pollIntervalMs: COPILOT_ROUND_TRIP_POLL_MS,
            selectedTemplateId: '__none__',
            answerFileTemplate: copilotQueueWrapper(loadSendToChatConfig()),
        }),
        opener: { async open(query) { await vscode.commands.executeCommand('workbench.action.chat.open', { query }); } },
        newRequestId: generateShortUUID,
        sinkFor: liveSink,
        expander: { expand: (template, values) => expandTemplate(template, { values }) },
        onResponseValues(values) { updateChatResponseValues(values); },
    }, input);
    try {
        const parsed = JSON.parse(raw) as { response?: string; requestId?: string };
        if (parsed.response) {
            logResponse('copilot', 'github_copilot', parsed.response, true, { questId, source: 'script', requestId: parsed.requestId });
        }
    } catch { /* the log only */ }
    return raw;
}
