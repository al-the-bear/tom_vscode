/**
 * `tomAi_askBigBrother` — query VS Code language models from the
 * local-LLM tool loop.  Carved out of `tool-executors.ts` for coverage
 * entry #25.
 *
 * ## What the tool does
 *
 *   - `operation: "list"`  — return the catalogue of available VS Code
 *     language models (`vscode.lm.selectChatModels()`) plus the
 *     human-readable recommendations from config.
 *   - `operation: "query"` — pick a model (id → family → partial-name
 *     fallback chain) and run a bounded tool-use loop against it.
 *
 * ## Coverage entry #25 (audit notes)
 *
 *   - Old impl reached straight into `vscode.lm.*`, `vscode.Cancellation
 *     TokenSource`, and `vscode.LanguageModelChatMessage` constructors;
 *     untestable without the editor.  Carve-out introduces a narrow
 *     `LanguageModelBridge` dep — the bridge's contract is just enough
 *     to drive the orchestration (selectModels, sendRequest streaming
 *     text/tool-call parts, invokeTool, listTools, a cancel signal),
 *     so a single in-memory fake can exercise the entire control flow.
 *   - Model selection is now a pure helper (`selectModelByQuery`) over
 *     the bridge's `selectModels` calls — fully unit-testable.
 *   - Mixed envelope cleaned up: success and failure both return
 *     `{ok, ...}` / `{ok: false, error, ...}`; old code returned
 *     "Error querying model: …" free-form strings on the failure path.
 *   - **Timeout** path is exposed via the `signal` parameter on the
 *     bridge — tests can simulate "model takes too long" by flipping
 *     `signal.cancelled` mid-stream, and the impl unwinds with a
 *     `cancelled: true, reason: "timeout"` envelope.
 *   - **Tool-loop bounds**: `maxIterations` defaults to 1 when
 *     `enableTools: false`; documented + tested.
 *   - **Summarisation gate** is exposed at the dep boundary
 *     (`shouldSummarise` + `summarise` are both on the bridge) so a
 *     test can verify the threshold-driven shortening without
 *     spinning up a second model.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Cross-cut: model + chat shapes (vscode-free).  The bridge maps these
// onto vscode.lm types; tests construct them directly.
// ===========================================================================

export interface BigBrotherModel {
    id: string;
    name: string;
    family: string;
    vendor: string;
    maxInputTokens: number;
}

export interface BigBrotherToolDef {
    name: string;
    description?: string;
    inputSchema?: object;
}

export type ResponsePart =
    | { kind: 'text'; text: string }
    | { kind: 'tool_call'; callId: string; name: string; input: object };

export type ChatTurn =
    | { role: 'user'; content: string }
    | { role: 'assistant'; parts: ResponsePart[] }
    | { role: 'tool_result'; results: Array<{ callId: string; text: string }> };

export interface CancelSignal { cancelled: boolean }

export interface BigBrotherConfig {
    enabled: boolean;
    defaultModel: string;
    enableToolsByDefault: boolean;
    maxIterations: number;
    responseTimeoutMs: number;
    summarisation: {
        enabled: boolean;
        thresholdChars: number;
    };
    modelRecommendations: string;
}

/**
 * Narrow dep.  Tests pass a fake; production wraps `vscode.lm` +
 * the live config loader.
 */
export interface LanguageModelBridge {
    /** Pull the full catalogue (used for `operation: "list"`). */
    listAllModels(): Promise<BigBrotherModel[]>;
    /** Filter by id / family. */
    selectModels(filter: { id?: string; family?: string }): Promise<BigBrotherModel[]>;
    /** Catalogue of tools available to the queried model. */
    listAvailableTools(): BigBrotherToolDef[];
    /**
     * Run one round-trip against the model: send the conversation,
     * stream back text + tool-call parts (in order).  Tests just push
     * a canned array; production wires this to vscode.lm streaming.
     */
    sendRequest(modelId: string, messages: ChatTurn[], tools: BigBrotherToolDef[], signal: CancelSignal): Promise<ResponsePart[]>;
    /** Invoke a tool by name; result is plain text (already truncated). */
    invokeTool(name: string, input: object): Promise<string>;
    /** Optional summariser; respected only when config.summarisation.enabled is true. */
    summarise(text: string): Promise<string>;
    /** Config snapshot — the impl reads each call to avoid stale config. */
    getConfig(): BigBrotherConfig;
}

// ===========================================================================
// Helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

/**
 * Model resolution: exact id → family → partial-name substring (case-
 * insensitive on name OR id).  Returns the first match.  Pure helper —
 * exported for tests.
 */
export async function selectModelByQuery(bridge: LanguageModelBridge, query: string): Promise<BigBrotherModel | undefined> {
    if (!query) { return undefined; }
    let models = await bridge.selectModels({ id: query });
    if (models.length > 0) { return models[0]; }
    models = await bridge.selectModels({ family: query });
    if (models.length > 0) { return models[0]; }
    const all = await bridge.listAllModels();
    const q = query.toLowerCase();
    const hit = all.find((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    return hit;
}

// ===========================================================================
// Inputs
// ===========================================================================

export interface AskBigBrotherInput {
    operation: 'list' | 'query';
    modelId?: string;
    prompt?: string;
    enableTools?: boolean;
    maxIterations?: number;
}

// ===========================================================================
// Impl
// ===========================================================================

export async function askBigBrotherImpl(bridge: LanguageModelBridge, input: AskBigBrotherInput, signal: CancelSignal = { cancelled: false }): Promise<string> {
    try {
        const config = bridge.getConfig();
        if (!config.enabled) {
            return err('Ask Big Brother tool is disabled.', { hint: 'Enable it in the status page settings.' });
        }

        if (input.operation === 'list') {
            const models = await bridge.listAllModels();
            return ok({
                operation: 'list',
                count: models.length,
                models,
                recommendations: config.modelRecommendations,
            });
        }

        if (input.operation !== 'query') {
            return err(`Unknown operation: ${input.operation}. Use "list" or "query".`);
        }

        if (!input.prompt || !input.prompt.trim()) {
            return err('`prompt` is required for query operation.');
        }

        const target = input.modelId || config.defaultModel;
        const model = await selectModelByQuery(bridge, target);
        if (!model) {
            return err(`No model found matching "${target}".`, {
                hint: 'Use operation: "list" to see available models.',
            });
        }

        const enableTools = input.enableTools ?? config.enableToolsByDefault;
        const tools = enableTools ? bridge.listAvailableTools() : [];
        // When tools are off, one round is enough (no follow-up call needed).
        const maxIter = enableTools ? Math.max(1, input.maxIterations ?? config.maxIterations) : 1;

        const messages: ChatTurn[] = [{ role: 'user', content: input.prompt }];

        let finalResponse = '';
        let iterationsUsed = 0;
        let toolCallsMade = 0;
        let timedOut = false;

        for (let iter = 1; iter <= maxIter; iter++) {
            if (signal.cancelled) { timedOut = true; break; }
            iterationsUsed = iter;
            const parts = await bridge.sendRequest(model.id, messages, tools, signal);
            if (signal.cancelled) { timedOut = true; break; }

            let iterationText = '';
            const toolCalls: Array<{ callId: string; name: string; input: object }> = [];
            for (const part of parts) {
                if (part.kind === 'text') {
                    iterationText += part.text;
                } else {
                    toolCalls.push({ callId: part.callId, name: part.name, input: part.input });
                }
            }

            if (toolCalls.length === 0) {
                finalResponse = iterationText.trim();
                break;
            }

            // Tool calls: record + invoke + push results, then continue.
            messages.push({
                role: 'assistant',
                parts: [
                    ...(iterationText ? [{ kind: 'text' as const, text: iterationText }] : []),
                    ...toolCalls.map((c) => ({ kind: 'tool_call' as const, callId: c.callId, name: c.name, input: c.input })),
                ],
            });
            const results: Array<{ callId: string; text: string }> = [];
            for (const c of toolCalls) {
                toolCallsMade++;
                try {
                    const text = await bridge.invokeTool(c.name, c.input);
                    results.push({ callId: c.callId, text });
                } catch (e) {
                    results.push({ callId: c.callId, text: `Tool ${c.name} error: ${(e as Error).message}` });
                }
            }
            messages.push({ role: 'tool_result', results });
        }

        if (timedOut) {
            return err('Response timed out.', {
                cancelled: true,
                reason: 'timeout',
                model: model.id,
                iterationsUsed,
                toolCallsMade,
            });
        }

        // Optional summarisation gate.
        let summarised = false;
        if (config.summarisation.enabled && finalResponse.length > config.summarisation.thresholdChars) {
            try {
                finalResponse = await bridge.summarise(finalResponse);
                summarised = true;
            } catch {
                // Keep original on summarisation failure (best-effort).
            }
        }

        return ok({
            operation: 'query',
            model: { id: model.id, name: model.name, family: model.family },
            response: finalResponse,
            enableTools,
            iterationsUsed,
            toolCallsMade,
            summarised,
        });
    } catch (e) {
        return err(`askBigBrother failed: ${(e as Error).message}`);
    }
}

// ===========================================================================
// Tool def
// ===========================================================================

export const ASK_BIG_BROTHER_DESCRIPTION =
    'Query a VS Code language model (GitHub Copilot, Claude, GPT-4, …) ' +
    'from the local-LLM tool loop. **Two operations**: `"list"` returns ' +
    'the model catalogue + recommendations; `"query"` runs a bounded ' +
    'tool-use loop against the chosen model. **Model selection** is a ' +
    'fallback chain: exact id → family → case-insensitive substring on ' +
    'name OR id; the first hit wins. **Tool loop**: when ' +
    '`enableTools: true`, the model may call up to `maxIterations` ' +
    'rounds of tools before returning its final answer (default from ' +
    'config); when `enableTools: false`, exactly one round runs. ' +
    '**Timeout**: configured via `responseTimeoutMs`; on expiry the ' +
    'response is `{ok: false, error: "Response timed out.", cancelled: ' +
    'true, reason: "timeout", iterationsUsed, toolCallsMade}` so the ' +
    'caller can tell how far the conversation got. **Response chunking**: ' +
    'responses longer than the summarisation threshold are passed through ' +
    'a second model (when `summarisationEnabled`); the envelope reports ' +
    '`summarised: true` when this fired. Network-bound — typical latency ' +
    'is several seconds, well above the local-tool budget.';

export const ASK_BIG_BROTHER_TOOL: SharedToolDefinition<AskBigBrotherInput> = {
    name: 'tomAi_askBigBrother',
    displayName: 'Ask Big Brother',
    description: ASK_BIG_BROTHER_DESCRIPTION,
    tags: ['ai', 'llm', 'local-llm', 'local-llm-bridge'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['operation'],
        properties: {
            operation: { type: 'string', enum: ['list', 'query'], description: '"list" → model catalogue; "query" → run a chat round-trip.' },
            modelId: { type: 'string', description: 'Model selector. Fallback chain: exact id → family → case-insensitive substring on name OR id. Defaults to config.defaultModel.' },
            prompt: { type: 'string', description: 'Required for "query". The user-turn text.' },
            enableTools: { type: 'boolean', description: 'When true, model can call other tools before answering. Default from config.' },
            maxIterations: { type: 'number', description: 'Max tool-use rounds when enableTools is true. Default from config.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};
