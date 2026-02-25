/**
 * Unified Prompt Template Processing
 *
 * Central module for placeholder expansion and template processing across all
 * handler flows. Delegates to the unified variable resolver engine.
 *
 * Supports three syntaxes:
 *   ${name}             – Dollar-brace style (preferred)
 *   {{name}}            – Mustache style (legacy, fully supported)
 *   ${{expression}}     – Inline JavaScript evaluation
 *
 * Built-in placeholders are resolved automatically.  Callers may pass extra
 * key/value pairs via `PromptTemplateOptions.values` for domain-specific
 * variables like `${originalPrompt}`, `${response}`, `${goal}`, etc.
 *
 * See doc/file_and_prompt_placeholder.md for the complete placeholder reference.
 */

import * as vscode from 'vscode';
import { WsPaths } from '../utils/workspacePaths';

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
    resolveVariablesAsync,
    buildVariableMap,
    formatDateTime as formatDateTimeShared,
    PLACEHOLDER_HELP as RESOLVER_PLACEHOLDER_HELP,
} from '../utils/variableResolver.js';

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
 * Get the chat answer folder from VS Code settings.
 */
export function getChatAnswerFolder(): string {
    const setting = vscode.workspace
        .getConfiguration('dartscript.sendToChat')
        .get<string>('chatAnswerFolder');
    return setting || WsPaths.aiRelative('chatReplies');
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
 * Build the map of built-in placeholder values.
 * Delegates to the unified variable resolver and merges chat response values.
 *
 * @deprecated Prefer using `buildVariableMap()` from variableResolver directly.
 */
function buildBuiltinValues(): Record<string, string> {
    const values = buildVariableMap({ includeEditor: false });

    // Merge chat response values (lazy load to avoid circular dependency)
    const chatVals = _getChatResponseValues();
    for (const [k, v] of Object.entries(chatVals)) {
        const str = typeof v === 'string' ? v : (v !== null && v !== undefined ? JSON.stringify(v) : '');
        // Only add if not already present from ChatVariablesStore
        if (!(`chat.${k}` in values)) {
            values[`chat.${k}`] = str;
        }
    }

    return values;
}

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
 *   - `${{javascript}}` inline JS evaluation
 *   - `${date.FORMAT}` / `${time.FORMAT}` custom formatting
 *   - `${env.VARNAME}`, `${config.KEY}`, `${git.KEY}` namespace patterns
 */
function resolvePass(text: string, values: Record<string, string>): string {
    // Delegate ${{js}} expressions first
    let result = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
        try {
            // eslint-disable-next-line no-new-func
            const fn = new Function(
                'vscode', 'os', 'path', 'env', 'vars', 'editor',
                `"use strict"; return (${expr.trim()});`,
            );
            const res = fn(
                vscode,
                require('os'),
                require('path'),
                process.env,
                values,
                vscode.window.activeTextEditor,
            );
            return res !== null && res !== undefined ? String(res) : '';
        } catch {
            return '';
        }
    });

    // 1. Replace {{key}} mustache patterns (same variable map as ${key})
    result = result.replace(/\{\{([^{}]+)\}\}/g, (_match, rawKey: string) => {
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
    result = result.replace(/\$\{([^{}]+)\}/g, (match, rawKey: string) => {
        let key = rawKey.trim();

        // Direct lookup (case-sensitive)
        if (key in values) {
            return values[key];
        }

        // Case-insensitive fallback
        const lk = key.toLowerCase();
        for (const [k, v] of Object.entries(values)) {
            if (k.toLowerCase() === lk) { return v; }
        }

        // Dynamic namespace resolution
        const now = new Date();

        // ${date.FORMAT}
        if (key.startsWith('date.')) {
            const { formatDateTimeToken } = require('../utils/variableResolver.js');
            return formatDateTimeToken(now, key.slice(5));
        }
        // ${time.FORMAT}
        if (key.startsWith('time.')) {
            const { formatDateTimeToken } = require('../utils/variableResolver.js');
            return formatDateTimeToken(now, key.slice(5));
        }
        // ${env.VARNAME}
        if (key.startsWith('env.')) {
            return process.env[key.slice(4)] ?? '';
        }
        // ${config.KEY}
        if (key.startsWith('config.')) {
            const val = vscode.workspace.getConfiguration().get(key.slice(7));
            return val !== undefined && val !== null ? String(val) : '';
        }
        // ${git.KEY} — resolved in the values map by variableResolver
        // ${vscode.KEY} — resolved in the values map by variableResolver
        // ${chat.KEY} — resolved in the values map by variableResolver

        return ''; // unresolved → empty string
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
    // Build the values map
    const values = buildBuiltinValues();

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
