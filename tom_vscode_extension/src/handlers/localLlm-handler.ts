/**
 * The Local LLM client: the Ollama and OpenAI-compatible chat calls the
 * Anthropic handler's `localLlm` transport makes (an Anthropic profile whose
 * configuration is a Local LLM configuration), and history compaction when it
 * runs on a Local LLM configuration. `callLocalLlmOnce` is the entry point;
 * `LocalLlmManager` is a singleton created in extension.ts.
 *
 * The Local LLM panel, the prompt-expander commands and the bridge API it
 * served were removed; the configurations live in `localLlm.configurations`
 * of tom_vscode_extension.json.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { bridgeLog } from './handler_shared';
import {
    OllamaTool, OllamaToolCall, SharedToolDefinition,
    toOllamaTools,
} from '../tools/shared-tool-registry';
import { apiKeyAuthHeader } from '../utils/apiKeyAuthHeader';
import { withRetryBudget, type RetryWait } from '../utils/retryWithBudget';
import { providerRetryDelayMs } from '../utils/rateLimitHeaders';
import { httpStatusError } from '../utils/httpStatusError';
import { localLlmChatUrl, localLlmRequestPath } from '../utils/localLlmEndpoint';

// ============================================================================
// Interfaces
// ============================================================================

/** Backend API protocol spoken by the endpoint. */
export type LocalLlmApiStyle = 'ollama' | 'openai';

/** Stats returned by Ollama in the final streaming chunk. */
export interface OllamaStats {
    promptTokens: number;
    completionTokens: number;
    totalDurationMs: number;
    loadDurationMs: number;
}

// ============================================================================
// LocalLlmManager — singleton, created in extension.ts
// ============================================================================

export class LocalLlmManager {
    /**
     * "Tom AI Local Log" output channel — technical diagnostics: HTTP POSTs
     * (URL + apiStyle), auth misses, retry countdowns, errors. Lines are
     * tagged `[openaiChat]`, `[ollamaChat]` so the source is obvious.
     */
    private logChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext) {
        this.logChannel = vscode.window.createOutputChannel('Tom AI Local Log');
        context.subscriptions.push(this.logChannel);
    }

    dispose(): void {
        // Nothing beyond the output channel, which the extension context disposes.
    }

    /** Append a line to the Tom AI Local Log output channel (used by module-level helpers). */
    appendToLog(line: string): void {
        this.logChannel.appendLine(line);
    }

    // -----------------------------------------------------------------------
    // Resolve helpers
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Think-tag processing
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Placeholder resolution (delegates to promptTemplate module)
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Ollama API
    // -----------------------------------------------------------------------

    /**
     * Build the optional `Authorization` header for a Local LLM request.
     *
     * `apiKeyEnv` names an environment variable; when it is set and that
     * variable holds a non-empty value, the request gets an
     * `Authorization: Bearer <value>` header. When `apiKeyEnv` is unset the
     * call is unauthenticated (the original behaviour). A configured-but-empty
     * variable is logged and treated as unset so a typo'd env name fails
     * loud-ish rather than silently sending `Bearer undefined`.
     */
    private apiKeyAuthHeader(apiKeyEnv?: string): Record<string, string> {
        return apiKeyAuthHeader(apiKeyEnv, process.env, (name) => {
            this.logChannel.appendLine(`[localLlm] apiKeyEnv='${name}' is configured but the environment variable is empty/undefined — sending the request without Authorization.`);
        });
    }

    /**
     * Low-level Ollama /api/chat call with full message history support.
     * Handles streaming, stats extraction, and tool-call detection.
     */
    private async ollamaChat(
        baseUrl: string,
        model: string,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>,
        temperature: number,
        onToken?: (token: string) => void,
        cancellationToken?: vscode.CancellationToken,
        keepAlive?: string,
        tools?: OllamaTool[],
        apiKeyEnv?: string,
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return new Promise((resolve, reject) => {
            // The base URL's own path is kept: it is the API root (localLlmEndpoint.ts).
            const url = localLlmChatUrl(baseUrl, 'ollama');
            // Diagnostic log so a /api/chat 404 in the vLLM server log
            // can be traced back to a specific code path. If the user
            // ever sees this URL hit a server that only speaks OpenAI,
            // the line in "Tom AI Local Log" will name the offender.
            this.logChannel.appendLine(`[ollamaChat] POST ${url.toString()} (apiStyle=ollama)`);
            // Capture a stack so we can identify the offending caller
            // when /api/chat lands on a vLLM URL by mistake. Only
            // emitted when the hostname doesn't look local — keeps
            // the channel quiet for legitimate Ollama servers.
            if (!/^(localhost|127\.|0\.0\.0\.0)/.test(url.hostname)) {
                const stack = new Error().stack ?? '(no stack)';
                this.logChannel.appendLine(`[ollamaChat] WARNING: /api/chat against non-local host '${url.hostname}'. Stack:\n${stack}`);
            }
            const ollamaStartedAt = Date.now();
            // Single-settle guards + outcome logging so a failure
            // shows ✗ <url> → <status> after Nms in the log channel.
            let ollamaSettled = false;
            const ollamaSafeResolve = (value: { text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }): void => {
                if (ollamaSettled) { return; }
                ollamaSettled = true;
                this.logChannel.appendLine(
                    `[ollamaChat] ✓ ${url.toString()} → ${value.text.length} chars + ${value.toolCalls?.length ?? 0} tool_call(s) after ${Date.now() - ollamaStartedAt}ms`,
                );
                resolve(value);
            };
            const ollamaSafeReject = (err: Error): void => {
                if (ollamaSettled) { return; }
                ollamaSettled = true;
                this.logChannel.appendLine(
                    `[ollamaChat] ✗ ${url.toString()} → ${err.message} after ${Date.now() - ollamaStartedAt}ms`,
                );
                reject(err);
            };
            const requestBody = {
                model,
                messages,
                stream: true,
                options: { temperature },
                // eslint-disable-next-line @typescript-eslint/naming-convention
                ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
                ...(tools && tools.length > 0 ? { tools } : {}),
            };
            const body = JSON.stringify(requestBody);

            // An https base (a hosted OpenAI-compatible API) goes over TLS; the query stays on the path.
            const req = (url.protocol === 'https:' ? https : http).request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: localLlmRequestPath(url),
                    method: 'POST',
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/json',
                        ...this.apiKeyAuthHeader(apiKeyEnv),
                    },
                },
                (res) => {
                    let fullResponse = '';
                    let buffer = '';
                    let stats: OllamaStats | undefined;
                    let toolCalls: OllamaToolCall[] | undefined;
                    let ollamaError: string | undefined;

                    // Check for HTTP-level errors (e.g. 404 model not found)
                    if (res.statusCode && res.statusCode >= 400) {
                        const status = res.statusCode;
                        let errorBody = '';
                        res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                        res.on('end', () => {
                            let errorMsg = `Ollama HTTP ${status}`;
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.error) { errorMsg = parsed.error; }
                            } catch { /* use default message */ }
                            // Status and headers on the error: the retry loop
                            // classifies by the status and waits as long as a
                            // `retry-after` says (utils/httpStatusError.ts).
                            ollamaSafeReject(httpStatusError(errorMsg, status, res.headers));
                        });
                        res.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
                        return;
                    }

                    res.on('data', (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.trim()) { continue; }
                            try {
                                const parsed = JSON.parse(line);
                                // Detect Ollama error in streaming response
                                if (parsed.error) {
                                    ollamaError = parsed.error;
                                }
                                if (parsed.message?.content) {
                                    fullResponse += parsed.message.content;
                                    onToken?.(parsed.message.content);
                                }
                                // Detect tool calls from model
                                if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
                                    toolCalls = parsed.message.tool_calls;
                                }
                                if (parsed.done === true) {
                                    stats = {
                                        promptTokens: parsed.prompt_eval_count ?? 0,
                                        completionTokens: parsed.eval_count ?? 0,
                                        totalDurationMs: Math.round((parsed.total_duration ?? 0) / 1e6),
                                        loadDurationMs: Math.round((parsed.load_duration ?? 0) / 1e6),
                                    };
                                }
                            } catch { /* partial JSON */ }
                        }
                    });

                    res.on('end', () => {
                        if (buffer.trim()) {
                            try {
                                const parsed = JSON.parse(buffer);
                                if (parsed.error) {
                                    ollamaError = parsed.error;
                                }
                                if (parsed.message?.content) {
                                    fullResponse += parsed.message.content;
                                }
                                if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
                                    toolCalls = parsed.message.tool_calls;
                                }
                                if (parsed.done === true && !stats) {
                                    stats = {
                                        promptTokens: parsed.prompt_eval_count ?? 0,
                                        completionTokens: parsed.eval_count ?? 0,
                                        totalDurationMs: Math.round((parsed.total_duration ?? 0) / 1e6),
                                        loadDurationMs: Math.round((parsed.load_duration ?? 0) / 1e6),
                                    };
                                }
                            } catch { /* ignore */ }
                        }
                        // If Ollama returned an error in the stream, reject with it
                        if (ollamaError && !fullResponse.trim()) {
                            ollamaSafeReject(new Error(ollamaError));
                        } else {
                            ollamaSafeResolve({ text: fullResponse, stats, toolCalls });
                        }
                    });
                    res.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
                },
            );

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    req.destroy();
                    ollamaSafeReject(new Error('Cancelled'));
                });
            }

            req.on('error', (e) => ollamaSafeReject(e instanceof Error ? e : new Error(String(e))));
            req.write(body);
            req.end();
        });
    }

    /**
     * OpenAI-compatible chat completion (vLLM, llama.cpp server, LM Studio,
     * any /v1/chat/completions endpoint). Signature mirrors {@link ollamaChat}
     * so callers can branch on apiStyle without restructuring.
     *
     * **Streaming (SSE).** Sends `stream: true` and parses Server-Sent
     * Events incrementally so `onToken` fires per content delta (used by
     * the live-trail writer to show the answer arriving). `stream_options.
     * include_usage` asks the server to emit a final non-content chunk
     * with `usage: {...}` so we still get prompt/completion token counts
     * — vLLM and llama.cpp honour this; servers that ignore the option
     * just don't get stats.
     *
     * Tool calls in OpenAI streaming arrive as **fragments keyed by `index`**.
     * The first fragment for an index carries the `name` and `id`; subsequent
     * fragments append to `arguments` as a streaming JSON string. We
     * accumulate them in `partialTools[]` and only parse the JSON once the
     * stream ends.
     */
    private async openaiChat(
        baseUrl: string,
        model: string,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>,
        temperature: number,
        onToken?: (token: string) => void,
        cancellationToken?: vscode.CancellationToken,
        tools?: OllamaTool[],
        apiKeyEnv?: string,
    ): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        return new Promise((resolve, reject) => {
            // The base URL's own path is kept: it is the API root (localLlmEndpoint.ts).
            const url = localLlmChatUrl(baseUrl, 'openai');
            this.logChannel.appendLine(`[openaiChat] POST ${url.toString()} (apiStyle=openai, stream=true)`);
            const startedAt = Date.now();
            // Double-settle guards. We deliberately do NOT install an
            // idle-stream watchdog here — local LLMs (especially large
            // MoE models like Gemma 4 26B) can legitimately think for
            // minutes between data chunks, especially after they
            // recover from a transient backend hiccup. The only valid
            // stop signal is the user clicking the stop button, which
            // trips `cancellationToken.onCancellationRequested` below.
            // safeResolve / safeReject also log the outcome so every
            // call has a paired ✓/✗ line in logChannel — easier to
            // correlate with the vLLM access log than entry-only logs.
            let settled = false;
            const safeResolve = (value: { text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }): void => {
                if (settled) { return; }
                settled = true;
                const elapsed = Date.now() - startedAt;
                const toolCount = value.toolCalls?.length ?? 0;
                this.logChannel.appendLine(`[openaiChat] ✓ ${url.toString()} → ${value.text.length} chars + ${toolCount} tool_call(s) after ${elapsed}ms`);
                resolve(value);
            };
            const safeReject = (err: Error): void => {
                if (settled) { return; }
                settled = true;
                const elapsed = Date.now() - startedAt;
                const status = (err as Error & { statusCode?: number }).statusCode;
                this.logChannel.appendLine(`[openaiChat] ✗ ${url.toString()} → ${status ?? 'no-status'} after ${elapsed}ms: ${err.message}`);
                reject(err);
            };
            // The Ollama wire shape matches OpenAI's tool-call shape closely
            // but with two gaps the OpenAI spec demands: (1) each tool_call
            // entry must have an `id`, and (2) each `role:'tool'` response
            // message must carry a matching `tool_call_id`. Ollama omits both.
            // We synthesise them here in a single forward pass: assign deterministic
            // ids to assistant tool_calls, then queue them so subsequent
            // `role:'tool'` messages (which the upper-layer loop appends in
            // emission order) can pop the next id off the front.
            // eslint-disable-next-line @typescript-eslint/naming-convention
            type OaMsg = { role: string; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string };
            const pendingIds: string[] = [];
            let callCounter = 0;
            const oaMessages: OaMsg[] = messages.map((m) => {
                if (m.tool_calls && m.tool_calls.length > 0) {
                    const calls = m.tool_calls.map((tc) => {
                        const id = (tc as { id?: string }).id ?? `call_${callCounter++}`;
                        pendingIds.push(id);
                        return {
                            id,
                            type: 'function' as const,
                            function: {
                                name: tc.function.name,
                                arguments: typeof tc.function.arguments === 'string'
                                    ? tc.function.arguments
                                    : JSON.stringify(tc.function.arguments ?? {}),
                            },
                        };
                    });
                    return { role: m.role, content: m.content ?? '', tool_calls: calls };
                }
                if (m.role === 'tool') {
                    const toolCallId = (m as { tool_call_id?: string }).tool_call_id ?? pendingIds.shift() ?? `call_${callCounter++}`;
                    return { role: 'tool', content: m.content ?? '', tool_call_id: toolCallId };
                }
                return { role: m.role, content: m.content ?? '' };
            });
            const requestBody = {
                model,
                messages: oaMessages,
                temperature,
                stream: true,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                stream_options: { include_usage: true },
                ...(tools && tools.length > 0 ? { tools } : {}),
            };
            const body = JSON.stringify(requestBody);

            // An https base (a hosted OpenAI-compatible API) goes over TLS; the query stays on the path.
            const req = (url.protocol === 'https:' ? https : http).request(
                {
                    hostname: url.hostname,
                    port: url.port,
                    path: localLlmRequestPath(url),
                    method: 'POST',
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/json',
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        Accept: 'text/event-stream',
                        ...this.apiKeyAuthHeader(apiKeyEnv),
                    },
                },
                (res) => {
                    // HTTP error: drain the body once so we can include the
                    // server's error message in the rejection.
                    if (res.statusCode && res.statusCode >= 400) {
                        // The status and headers go onto the rejection
                        // (httpStatusError): the retry loop classifies by the
                        // status and honours a `retry-after`.
                        const status = res.statusCode;
                        let errorBody = '';
                        res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
                        res.on('end', () => {
                            let errorMsg = `OpenAI-compatible HTTP ${status}`;
                            try {
                                const parsed = JSON.parse(errorBody);
                                if (parsed.error?.message) { errorMsg = parsed.error.message; }
                                else if (parsed.detail) { errorMsg = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail); }
                            } catch { /* use default */ }
                            safeReject(httpStatusError(errorMsg, status, res.headers));
                        });
                        res.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
                        return;
                    }

                    let buffer = '';
                    let fullText = '';
                    let stats: OllamaStats | undefined;
                    // Partial tool calls indexed by the `index` field on each
                    // delta — name + id arrive once on the first fragment,
                    // arguments stream in concatenated string fragments.
                    type PartialTool = { id?: string; name: string; args: string };
                    const partialTools: PartialTool[] = [];
                    let sawDone = false;

                    const handleEvent = (eventData: string): void => {
                        if (eventData === '[DONE]') {
                            sawDone = true;
                            return;
                        }
                        let parsed: any;
                        try { parsed = JSON.parse(eventData); }
                        catch { return; /* malformed/partial — skip */ }
                        // Usage frames have no `choices` — they arrive after
                        // the last content chunk when stream_options.include_usage
                        // is set.
                        if (parsed?.usage) {
                            const u = parsed.usage;
                            stats = {
                                promptTokens: u.prompt_tokens ?? 0,
                                completionTokens: u.completion_tokens ?? 0,
                                totalDurationMs: 0,
                                loadDurationMs: 0,
                            };
                        }
                        const choice = parsed?.choices?.[0];
                        if (!choice) { return; }
                        const delta = choice.delta ?? {};
                        if (typeof delta.content === 'string' && delta.content.length > 0) {
                            fullText += delta.content;
                            try { onToken?.(delta.content); } catch { /* listener errors must not abort the stream */ }
                        }
                        const tcDelta = delta.tool_calls;
                        if (Array.isArray(tcDelta)) {
                            for (const frag of tcDelta) {
                                const idx = typeof frag.index === 'number' ? frag.index : 0;
                                if (!partialTools[idx]) {
                                    partialTools[idx] = { id: undefined, name: '', args: '' };
                                }
                                const slot = partialTools[idx];
                                if (typeof frag.id === 'string' && frag.id.length > 0) { slot.id = frag.id; }
                                const fnName = frag.function?.name;
                                if (typeof fnName === 'string' && fnName.length > 0) { slot.name = fnName; }
                                const fnArgs = frag.function?.arguments;
                                if (typeof fnArgs === 'string') { slot.args += fnArgs; }
                            }
                        }
                    };

                    res.setEncoding('utf-8');
                    res.on('data', (chunk: string) => {
                        buffer += chunk;
                        // SSE event boundary: two consecutive newlines.
                        // We split on either `\n\n` or `\r\n\r\n` to be
                        // forgiving of intermediaries that rewrite line
                        // endings. Each event is a block of `field: value`
                        // lines; we only care about `data:` here.
                        let sepIdx: number;
                        // eslint-disable-next-line no-constant-condition
                        while (true) {
                            const idxLf = buffer.indexOf('\n\n');
                            const idxCrLf = buffer.indexOf('\r\n\r\n');
                            if (idxLf === -1 && idxCrLf === -1) { break; }
                            // Prefer whichever comes first
                            if (idxCrLf !== -1 && (idxLf === -1 || idxCrLf < idxLf)) {
                                sepIdx = idxCrLf;
                                const block = buffer.slice(0, sepIdx);
                                buffer = buffer.slice(sepIdx + 4);
                                processBlock(block);
                            } else {
                                sepIdx = idxLf;
                                const block = buffer.slice(0, sepIdx);
                                buffer = buffer.slice(sepIdx + 2);
                                processBlock(block);
                            }
                        }
                    });

                    const processBlock = (block: string): void => {
                        const dataLines: string[] = [];
                        for (const line of block.split(/\r?\n/)) {
                            if (line.startsWith('data:')) {
                                dataLines.push(line.slice(5).trimStart());
                            }
                            // We ignore `event:` / `id:` / comment lines —
                            // OpenAI-compat servers only use `data:`.
                        }
                        if (dataLines.length > 0) {
                            // Multi-line data fields are joined with newlines
                            // per the SSE spec; in practice OpenAI/vLLM
                            // always send one `data:` per event.
                            handleEvent(dataLines.join('\n'));
                        }
                    };

                    res.on('end', () => {
                        // Drain anything left in the buffer (some servers
                        // omit the trailing blank line before closing).
                        if (buffer.trim().length > 0) { processBlock(buffer); }

                        const toolCalls: OllamaToolCall[] | undefined = partialTools.length > 0
                            ? partialTools
                                .filter((t): t is PartialTool => !!t && (t.name.length > 0 || t.args.length > 0))
                                .map((t) => {
                                    let args: Record<string, unknown> = {};
                                    if (t.args) {
                                        try { args = JSON.parse(t.args); } catch { args = { _raw: t.args }; }
                                    }
                                    return {
                                        id: t.id,
                                        function: { name: t.name, arguments: args },
                                    } as OllamaToolCall;
                                })
                            : undefined;
                        // A clean stream end without [DONE] is unusual but
                        // not fatal — the body we've accumulated is still
                        // the answer. Log so it's visible if a server
                        // misbehaves.
                        if (!sawDone && fullText.length === 0 && (!toolCalls || toolCalls.length === 0)) {
                            return safeReject(new Error('OpenAI stream ended without any content or tool calls'));
                        }
                        safeResolve({ text: fullText, stats, toolCalls });
                    });
                    res.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
                },
            );

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => {
                    req.destroy();
                    safeReject(new Error('Cancelled'));
                });
            }

            req.on('error', (err) => safeReject(err instanceof Error ? err : new Error(String(err))));
            req.write(body);
            req.end();
        });
    }

    /**
     * Single-round Ollama API call — the "call API" primitive extracted per
     * multi_transport_prompt_queue_revised.md §4.4a. Takes already-composed
     * messages and a `SharedToolDefinition[]` (converted to Ollama's tool
     * schema inside), calls `/api/chat` once, returns one model response.
     * NO tool loop, NO approval gate, NO template handling — those live
     * one layer up, in `AnthropicHandler` (a Local-LLM-backed Anthropic
     * profile driven through the shared agent loop) and in history
     * compaction.
     */
    public async callLocalLlmOnce(opts: {
        baseUrl: string;
        model: string;
        temperature: number;
        messages: Array<{ role: string; content?: string; tool_calls?: OllamaToolCall[] }>;
        tools: SharedToolDefinition[];
        keepAlive?: string;
        onToken?: (token: string) => void;
        cancellationToken?: vscode.CancellationToken;
        /** Backend protocol. Defaults to `'ollama'`. */
        apiStyle?: LocalLlmApiStyle;
        /**
         * Name of the env var holding the bearer API key for this endpoint.
         * When set (and non-empty), requests carry `Authorization: Bearer …`.
         */
        apiKeyEnv?: string;
        /**
         * Status callback fired before each retry on a busy backend (HTTP
         * 429 / 503 / 529 / textual hints). The first arg is a UI-ready status
         * string; the second is the triggering error's text. Plumbed to the
         * Anthropic panel's status line and the quest live-trail by
         * `sendViaLocalLlm` so the user can watch the retry budget tick down.
         */
        onRetryStatus?: (message: string, cause?: string) => void;
        /**
         * Total cumulative wait time (ms) the retry loop is allowed before
         * giving up. Defaults to 10 minutes. Applies uniformly to both
         * Ollama and OpenAI/vLLM paths; the same backoff policy keeps
         * behaviour predictable across backends.
         */
        retryTotalWaitMs?: number;
        /**
         * Each retry wait in structured form (`null` when it is over), for the
         * prompt queue's `sendWait` — the same channel the direct transport uses.
         */
        onRetryWait?: (wait: RetryWait | null) => void;
    }): Promise<{ text: string; stats?: OllamaStats; toolCalls?: OllamaToolCall[] }> {
        const ollamaTools = toOllamaTools(opts.tools, () => true);
        const totalWaitMs = opts.retryTotalWaitMs ?? 10 * 60 * 1000;
        const label = opts.apiStyle === 'openai' ? 'OpenAI/vLLM busy' : 'Ollama busy';
        return withRetryBudget({
            call: () => opts.apiStyle === 'openai'
                ? this.openaiChat(
                    opts.baseUrl,
                    opts.model,
                    opts.messages,
                    opts.temperature,
                    opts.onToken,
                    opts.cancellationToken,
                    ollamaTools.length > 0 ? ollamaTools : undefined,
                    opts.apiKeyEnv,
                )
                : this.ollamaChat(
                    opts.baseUrl,
                    opts.model,
                    opts.messages,
                    opts.temperature,
                    opts.onToken,
                    opts.cancellationToken,
                    opts.keepAlive,
                    ollamaTools.length > 0 ? ollamaTools : undefined,
                    opts.apiKeyEnv,
                ),
            totalWaitMs,
            backendLabel: label,
            cancellationToken: opts.cancellationToken,
            // A 429 / 503 from vLLM or a gateway may say how long to wait
            // (`retry-after`, `retry-after-ms`): wait that, as on direct.
            waitFromError: providerRetryDelayMs,
            onRetryStatus: opts.onRetryStatus,
            onRetryWait: opts.onRetryWait,
        });
    }

    // -----------------------------------------------------------------------
    // Core processing — used by both the command handler and the bridge API
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Public API — for the Anthropic handler's localLlm transport and compaction
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Core process()
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Bridge API
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Ollama model listing + switch
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // VS Code command handler — interactive (with UI)
    // -----------------------------------------------------------------------

}

// ============================================================================
// Exported standalone handler (backward compat for extension.ts)
// ============================================================================

/** Global manager instance — set by extension.ts during activation. */
let _manager: LocalLlmManager | undefined;

export function setLocalLlmManager(mgr: LocalLlmManager): void {
    _manager = mgr;
    bridgeLog(`[LocalLlmManager] singleton set (instance=${!!mgr})`, 'INFO');
}

export function getLocalLlmManager(): LocalLlmManager | undefined {
    return _manager;
}

/**
 * Get or lazily create the LocalLlmManager singleton.
 * Use this in webview handlers where the manager MUST be available,
 * even if activate() didn't finish setting up the singleton.
 */
export function ensureLocalLlmManager(context: vscode.ExtensionContext): LocalLlmManager {
    if (!_manager) {
        bridgeLog('[LocalLlmManager] Auto-creating manager (singleton was null during ensureLocalLlmManager)', 'INFO');
        _manager = new LocalLlmManager(context);
    }
    return _manager;
}
