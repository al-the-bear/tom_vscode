/**
 * Shared Tool Registry — unified tool definitions usable by both:
 *   1. Ollama's /api/chat tool-calling (OpenAI-compatible format)
 *   2. VS Code Language Model API (vscode.lm.registerTool)
 *
 * Each SharedToolDefinition bundles the JSON Schema, metadata, and executor
 * in one place so adding a tool once makes it available everywhere.
 */

import * as vscode from 'vscode';

// ============================================================================
// Core interfaces
// ============================================================================

/**
 * A single, provider-agnostic tool definition.
 *
 * TInput is the shape of the validated input (matches the JSON Schema).
 */
export interface SharedToolDefinition<TInput = Record<string, unknown>> {
    /** Unique tool identifier, e.g. 'tom_readFile'. */
    name: string;

    /** Human-readable name shown in UI. */
    displayName: string;

    /**
     * Description sent to the model so it knows *when* to call the tool,
     * shared between Ollama and VS Code LM.
     */
    description: string;

    /** JSON Schema (type: "object") describing the input parameters. */
    inputSchema: Record<string, unknown>;

    /** Tags for VS Code LM registration (e.g. ['files', 'tom-ai-chat']). */
    tags: string[];

    /** Whether the tool only reads data and never mutates state. */
    readOnly: boolean;

    /**
     * Whether users can reference the tool directly in Copilot Chat
     * via `#toolName`. Defaults to false.
     */
    canBeReferencedInPrompt?: boolean;

    /** The actual executor — receives validated input, returns a plain string. */
    execute: (input: TInput) => Promise<string>;
}

// ============================================================================
// Ollama tool format (OpenAI-compatible)
// ============================================================================

/** Ollama /api/chat `tools` array element. */
export interface OllamaTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/** The tool-call the model emits in its response. */
export interface OllamaToolCall {
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}

/**
 * Convert shared definitions to the Ollama tools array.
 *
 * @param tools   All shared tools
 * @param filter  Optional predicate (default: read-only only)
 */
export function toOllamaTools(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: SharedToolDefinition<any>[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter?: (t: SharedToolDefinition<any>) => boolean,
): OllamaTool[] {
    const predicate = filter ?? ((t) => t.readOnly);
    return tools.filter(predicate).map((t) => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}

// ============================================================================
// VS Code LM tool adapter
// ============================================================================

/**
 * Wrap a SharedToolDefinition as a `vscode.LanguageModelTool<TInput>`.
 * The returned object can be passed to `vscode.lm.registerTool()`.
 */
export function toVsCodeTool<TInput>(
    tool: SharedToolDefinition<TInput>,
): vscode.LanguageModelTool<TInput> {
    return {
        async invoke(
            options: vscode.LanguageModelToolInvocationOptions<TInput>,
            _token: vscode.CancellationToken,
        ): Promise<vscode.LanguageModelToolResult> {
            const result = await tool.execute(options.input);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(result),
            ]);
        },
    };
}

// ============================================================================
// Tool executor dispatcher (for Ollama tool-call loop)
// ============================================================================

/** Look up a SharedToolDefinition by name and execute it. */
export async function executeToolCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: SharedToolDefinition<any>[],
    toolCall: OllamaToolCall,
): Promise<string> {
    const tool = tools.find((t) => t.name === toolCall.function.name);
    if (!tool) {
        return `Error: unknown tool "${toolCall.function.name}"`;
    }
    try {
        return await tool.execute(toolCall.function.arguments);
    } catch (err: any) {
        return `Error executing ${toolCall.function.name}: ${err.message ?? err}`;
    }
}
