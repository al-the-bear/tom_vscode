/**
 * `tomAi_askCopilot` — send a prompt to GitHub Copilot Chat and wait
 * for an answer file written back by a guidance-following Copilot
 * session.  Carved out of `tool-executors.ts` for coverage entry #25.
 *
 * ## How it works
 *
 *   1. Render the user's prompt through the configured template chain
 *      (optional `promptTemplate` → required `__answer_file__`
 *      wrapper).  The wrapper instructs Copilot to dump its final
 *      answer into a JSON file.
 *   2. Clear the previous answer file (so a stale read doesn't masquerade
 *      as fresh).
 *   3. Open Copilot Chat with the expanded prompt via the VS Code
 *      command surface.
 *   4. Poll the answer-file path at `pollInterval` until it appears
 *      OR the per-call timeout elapses.
 *
 * ## Coverage entry #25 (audit notes)
 *
 *   - Old impl reached into `vscode.commands`, `vscode.env`, `fs`, and
 *     the template engine directly — untestable.  Carve-out introduces:
 *       - `CopilotChatOpener`            : open chat + record query
 *       - `AnswerFileSink`               : clear / poll / read the file
 *       - `TemplateExpander`             : pure async fn over the prompt
 *       - `CopilotConfigSnapshot`        : config + workspace + session ids
 *     Tests pass a fake sink whose `read()` queues canned content per
 *     poll, plus an in-memory expander, so the whole flow runs in <10 ms.
 *   - Mixed envelope (success → "**Copilot Response:**\n\n…" strings,
 *     failure → "Error opening Copilot Chat: …" strings) replaced with
 *     `{ok, ...}` / `{ok: false, error, ...}` everywhere.  The actual
 *     response text moves into a `response` field so callers can pipe
 *     it to other tools.
 *   - JSON vs plain-text answer file: both supported; the envelope
 *     surfaces `format: "json" | "text"` so the model knows what it
 *     got.  When the file is JSON with `responseValues`, those flow
 *     to the chat-variable store via the `onResponseValues` callback.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow deps (the seam between vscode/fs and the impl)
// ===========================================================================

export interface CopilotConfigSnapshot {
    enabled: boolean;
    /** Default polling timeout when input.timeoutMs is omitted. */
    answerFileTimeoutMs: number;
    pollIntervalMs: number;
    /** Workspace-relative answer folder (e.g. `_ai/chat_replies`). */
    answerFolder: string;
    /** Per-session answer filename (typically `${sessionId}_${machineId}_answer.json`). */
    answerFilename: string;
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
    expand(template: string, values: { originalPrompt: string }): Promise<string>;
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

export interface AskCopilotInput {
    prompt: string;
    waitForAnswer?: boolean;
    timeoutMs?: number;
}

export interface AskCopilotDeps {
    config: () => CopilotConfigSnapshot;
    opener: CopilotChatOpener;
    sink: AnswerFileSink;
    expander: TemplateExpander;
    onResponseValues?: ResponseValuesSink;
    clock?: PollClock;
}

// ===========================================================================
// Impl
// ===========================================================================

export async function askCopilotImpl(deps: AskCopilotDeps, input: AskCopilotInput): Promise<string> {
    try {
        if (!input.prompt || !input.prompt.trim()) {
            return err('`prompt` is required.');
        }
        const config = deps.config();
        if (!config.enabled) {
            return err('Ask Copilot tool is disabled.', { hint: 'Enable it in the status page settings.' });
        }
        const clock = deps.clock ?? realClock;
        const waitForAnswer = input.waitForAnswer ?? true;
        const timeoutMs = input.timeoutMs ?? config.answerFileTimeoutMs;

        // Render the prompt through the template chain.
        let expanded: string;
        const wrapperOnly = !config.selectedTemplateId
            || config.selectedTemplateId === '__answer_file__'
            || config.selectedTemplateId === '__none__';
        if (!wrapperOnly && config.selectedTemplateBody) {
            const inner = await deps.expander.expand(config.selectedTemplateBody, { originalPrompt: input.prompt });
            expanded = await deps.expander.expand(config.answerFileTemplate, { originalPrompt: inner });
        } else {
            expanded = await deps.expander.expand(config.answerFileTemplate, { originalPrompt: input.prompt });
        }

        // Clear the answer file BEFORE opening Copilot, so a stale read
        // can't masquerade as a fresh answer.
        deps.sink.clear();

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
                answerFile: deps.sink.absolutePath(),
                note: 'Prompt sent to Copilot Chat. Caller chose not to wait.',
            });
        }

        // Poll for the answer file.
        const start = clock.now();
        const pollInterval = config.pollIntervalMs;
        while (clock.now() - start < timeoutMs) {
            await clock.sleep(pollInterval);
            let content: string | null;
            try {
                content = deps.sink.read();
            } catch (e) {
                return err(`Error reading answer file: ${(e as Error).message}`, {
                    answerFile: deps.sink.absolutePath(),
                });
            }
            if (content === null) { continue; }
            // Try JSON first; fall back to plain text.
            try {
                const parsed = JSON.parse(content) as {
                    response?: unknown;
                    responseValues?: unknown;
                    requestId?: string;
                };
                if (parsed.responseValues && typeof parsed.responseValues === 'object') {
                    deps.onResponseValues?.(parsed.responseValues as Record<string, unknown>);
                }
                if (typeof parsed.response === 'string') {
                    return ok({
                        format: 'json' as const,
                        response: parsed.response,
                        requestId: parsed.requestId ?? null,
                        elapsedMs: clock.now() - start,
                    });
                }
                return ok({
                    format: 'json' as const,
                    response: JSON.stringify(parsed, null, 2),
                    requestId: parsed.requestId ?? null,
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
            answerFile: deps.sink.absolutePath(),
        });
    } catch (e) {
        return err(`askCopilot failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// Tool def
// ===========================================================================

export const ASK_COPILOT_DESCRIPTION =
    'Send a prompt to GitHub Copilot Chat and (by default) block until ' +
    'Copilot writes an answer file. **How it works**: (1) render the ' +
    'prompt through the configured template chain — an optional user ' +
    'template wraps `${originalPrompt}`, then the required ' +
    '`__answer_file__` wrapper instructs Copilot to dump its final ' +
    'answer to a JSON file; (2) clear any stale answer file; (3) open ' +
    'Copilot Chat via the VS Code command; (4) poll the answer-file ' +
    'path at `pollInterval` until it appears or `timeoutMs` elapses. ' +
    '**Response formats**: when the answer file is JSON with a ' +
    '`response` string, the envelope returns `{format: "json", response, ' +
    'requestId, elapsedMs}` and any sibling `responseValues` object is ' +
    'forwarded to the chat-variable store. Plain-text answers come back ' +
    'as `{format: "text", response}`. **Timeout** returns ' +
    '`{ok: false, timedOut: true, timeoutMs, answerFile}` — Copilot may ' +
    'still finish processing in the chat window after the tool gives up. ' +
    '**Set `waitForAnswer: false`** for fire-and-forget (response ' +
    'returns immediately with the answer-file path). Network-bound — ' +
    'expect multi-second latency.';

export const ASK_COPILOT_TOOL: SharedToolDefinition<AskCopilotInput> = {
    name: 'tomAi_askCopilot',
    displayName: 'Ask Copilot',
    description: ASK_COPILOT_DESCRIPTION,
    tags: ['ai', 'copilot', 'local-llm', 'local-llm-bridge'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string', description: 'The question/instruction for Copilot.' },
            waitForAnswer: { type: 'boolean', description: 'Block until the answer file appears. Default true. When false, returns immediately with the answer-file path.' },
            timeoutMs: { type: 'number', description: 'Max milliseconds to poll for the answer file. Default from config.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
