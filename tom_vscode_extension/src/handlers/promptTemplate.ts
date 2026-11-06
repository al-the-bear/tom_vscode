/**
 * Unified Prompt Template Processing
 *
 * Central module for placeholder expansion and template processing across all
 * handler flows. Delegates to the unified variable resolver engine.
 *
 * Supports three syntaxes:
 *   ${name}             – Dollar-brace style (preferred)
 *   {{name}}            – Mustache style (legacy, fully supported)
 *   ${{expression}}     – An expression (templateExpression.ts)
 *
 * Built-in placeholders are resolved automatically.  Callers may pass extra
 * key/value pairs via `PromptTemplateOptions.values` for domain-specific
 * variables like `${originalPrompt}`, `${response}`, `${goal}`, etc.
 *
 * See doc/file_and_prompt_placeholder.md for the complete placeholder reference.
 */

import * as vscode from 'vscode';

/**
 * Lazy loader for getChatResponseValues to break circular dependency.
 * handler_shared imports promptTemplate, so we cannot import handler_shared statically.
 */
function _getChatResponseValues(): Record<string, unknown> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getChatResponseValues } = require('./handler_shared');
        return getChatResponseValues();
    } catch {
        return {};
    }
}
import {
    buildVariableMap,
    formatDateTime as formatDateTimeShared,
    resolveDynamicKey,
    PLACEHOLDER_HELP as RESOLVER_PLACEHOLDER_HELP,
} from '../utils/variableResolver.js';
import { evaluateExpression, forEachExpressionPlaceholder } from '../utils/templateExpression';

// ============================================================================
// Public types
// ============================================================================

export interface PromptTemplateOptions {
    /** Additional caller-specific values to expand (e.g. originalPrompt, response). */
    values?: Record<string, string>;
    /**
    * If true, resolve editor-dependent placeholders (selection, file, …).
     * Defaults to true.
     */
    includeEditorContext?: boolean;
    /**
     * Maximum depth for recursive resolution.  0 = single pass (default).
     */
    maxDepth?: number;
}

// ============================================================================
// Utility functions (exported for reuse)
// ============================================================================

/**
 * Format a Date as `YYYYMMDD_HHMMSS`.
 * Delegates to the unified variable resolver.
 */
export function formatDateTime(date: Date = new Date()): string {
    return formatDateTimeShared(date);
}

/**
 * Resolve a dot-separated path against a nested data object.
 * Returns the stringified value, or undefined if not found.
 */
export function resolveDotPath(
    data: Record<string, any>,
    dotPath: string,
): string | undefined {
    const parts = dotPath.split('.');
    let value: any = data;
    for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
            value = value[part];
        } else {
            return undefined;
        }
    }
    if (typeof value === 'string') { return value; }
    if (value !== null && value !== undefined) { return JSON.stringify(value); }
    return undefined;
}

// ============================================================================
// Core expansion — delegates to unified variable resolver
// ============================================================================

/**
 * Add editor-dependent values to the map.
 * These are provided by the unified resolver via `buildVariableMap()`.
 */
function addEditorValues(values: Record<string, string>): void {
    const editorValues = buildVariableMap({ includeEditor: true });

    // Merge in editor values from unified resolver
    for (const [k, v] of Object.entries(editorValues)) {
        if (!(k in values)) {
            values[k] = v;
        }
    }

}

/**
 * Add async values (clipboard) to the map.
 */
async function addAsyncValues(values: Record<string, string>): Promise<void> {
    try {
        const clip = await vscode.env.clipboard.readText();
        values['clipboard'] = clip || '';
    } catch {
        values['clipboard'] = '';
    }
}

/**
 * Perform a single resolution pass over `text`, replacing `${key}` patterns
 * from the supplied values map.
 *
 * Also handles:
 *   - `${{ expression }}` placeholders (templateExpression.ts)
 *   - `${date.FORMAT}` / `${time.FORMAT}` custom formatting
 *   - `${env.VARNAME}`, `${config.KEY}`, `${git.KEY}` namespace patterns
 */
function resolvePass(text: string, values: Record<string, string>): string {
    // ${{ expression }} placeholders first (templateExpression.ts).
    // An escaped `$${…}` / `$${{…}}` stays as written (variableResolver.ts, unescapePlaceholders).
    const now = new Date();
    const lookup = (key: string): string | undefined => {
        if (key in values) { return values[key]; }
        const lk = key.toLowerCase();
        for (const [k, v] of Object.entries(values)) {
            if (k.toLowerCase() === lk) { return v; }
        }
        return resolveDynamicKey(key, values, now);
    };
    let result = forEachExpressionPlaceholder(text, (expr) => {
        try {
            return evaluateExpression(expr, lookup);
        } catch (e) {
            console.error(`[promptTemplate] expression error in $\{{ ${expr} }}: ${(e as Error).message}`);
            return '';
        }
    });

    // 1. Replace {{key}} mustache patterns (same variable map as ${key})
    result = result.replace(/(?<!\$)\{\{([^{}]+)\}\}/g, (_match, rawKey: string) => {
        const key = rawKey.trim();
        // Direct lookup (case-sensitive)
        if (key in values) { return values[key]; }
        // Case-insensitive fallback
        const lk = key.toLowerCase();
        for (const [k, v] of Object.entries(values)) {
            if (k.toLowerCase() === lk) { return v; }
        }
        return ''; // unresolved → empty string
    });

    // 2. Replace ${key} patterns (including dot paths, namespaces)
    result = result.replace(/(?<!\$)\$\{([^{}]+)\}/g, (_match, rawKey: string) => {
        const key = rawKey.trim();

        // Map, any case, then the dynamic namespaces (date.*, env.*, config.*,
        // git.*, vscode.*, chat.* and the file-injection placeholders) — as the
        // unified resolver reads them.
        return lookup(key) ?? '';
    });

    return result;
}

/**
 * Expand all placeholders in a template string.
 *
 * Delegates to the unified variable resolver engine for all built-in
 * variables, plus supports caller-provided values for domain-specific
 * placeholders like `${prompt}`, `${goal}`, `${response}`, etc.
 *
 * See doc/file_and_prompt_placeholder.md for the complete reference.
 *
 * Caller-provided values in `options.values` override built-ins.
 */
export async function expandTemplate(
    template: string,
    options?: PromptTemplateOptions,
): Promise<string> {
    // Build the values map — unified variable resolver + chat response values.
    const values = buildVariableMap({ includeEditor: false });
    const chatVals = _getChatResponseValues();
    for (const [k, v] of Object.entries(chatVals)) {
        const str = typeof v === 'string' ? v : (v !== null && v !== undefined ? JSON.stringify(v) : '');
        // Only add if not already present from ChatVariablesStore
        if (!(`chat.${k}` in values)) {
            values[`chat.${k}`] = str;
        }
    }

    const includeEditor = options?.includeEditorContext !== false;
    if (includeEditor) {
        addEditorValues(values);
        await addAsyncValues(values);
    }

    // Merge caller-provided values (override built-ins)
    if (options?.values) {
        Object.assign(values, options.values);
    }

    // Resolve (potentially recursive)
    const maxDepth = Math.max(1, (options?.maxDepth ?? 0) + 1);
    let result = template;
    let prev = '';
    for (let i = 0; i < maxDepth && result !== prev; i++) {
        prev = result;
        result = resolvePass(result, values);
    }

    return result;
}

/**
 * Synchronous placeholder resolution for callers that already have a
 * complete values map (no editor/clipboard lookups needed).
 * Supports ${key} syntax.
 */
export function resolveTemplate(
    template: string,
    values: Record<string, string>,
    maxDepth: number = 1,
): string {
    let result = template;
    let prev = '';
    for (let i = 0; i < maxDepth && result !== prev; i++) {
        prev = result;
        result = resolvePass(result, values);
    }
    return result;
}

// ============================================================================
// Placeholder help text
// ============================================================================

/**
 * HTML help text listing all available placeholders (for template editors).
 * Delegates to the comprehensive list from the unified variable resolver.
 */
export const PLACEHOLDER_HELP = RESOLVER_PLACEHOLDER_HELP;
