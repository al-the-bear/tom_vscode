/**
 * Unified Variable Resolver
 *
 * Central module for placeholder expansion across all contexts:
 * path/filename fields, prompt templates, configuration values, etc.
 *
 * Supports two syntaxes:
 *   ${name}            — Dollar-brace (standard)
 *   ${{expression}}    — Inline JavaScript evaluation
 *
 * Variables are organized into tiers:
 *   Tier 1 — Universal:    always available (workspace, env, date/time, machine, etc.)
 *   Tier 2 — Editor:       active editor context (file, selection, cursor, etc.)
 *   Tier 3 — Config files: extension config paths with .name/.extension support
 *   Tier 4 — Chat:         values from ChatVariablesStore
 *   Tier 5 — Prompt-only:  caller-provided (prompt, goal, response, turns, etc.)
 *   Tier 6 — Git:          branch, commit, remote info (cached, lazy)
 *   Tier 7 — VS Code meta: version, appName, uiKind, etc.
 *
 * Namespace patterns resolved dynamically:
 *   ${env.VARNAME}     — process.env lookup
 *   ${config.KEY}      — VS Code setting lookup
 *   ${chat.KEY}        — ChatVariablesStore lookup
 *   ${git.KEY}         — Git repository info (cached 5s)
 *   ${vscode.KEY}      — VS Code environment properties
 *   ${date.FORMAT}     — Formatted date (e.g. ${date.YYYY-MM-DD})
 *   ${time.FORMAT}     — Formatted time (e.g. ${time.HH:mm:ss})
 *
 * Path variables automatically get .name and .extension sub-properties.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { WsPaths } from './workspacePaths';

// ============================================================================
// Public types
// ============================================================================

export interface ResolveOptions {
    /** Additional caller-provided key/value pairs (prompt, goal, response, etc.). */
    values?: Record<string, string>;
    /**
     * Include editor-dependent variables (file, selection, cursor, etc.).
     * Defaults to true.
     */
    includeEditor?: boolean;
    /**
     * What to do with placeholders that cannot be resolved.
     *   'empty' — replace with '' (default)
     *   'keep'  — leave ${...} in place (useful for two-pass resolution)
     */
    unresolvedBehavior?: 'empty' | 'keep';
    /** Maximum recursive depth. Default: 1 (single pass). */
    maxDepth?: number;
    /**
     * When true, suppress error messages for missing editor context.
     * Defaults to false.
     */
    silent?: boolean;
    /**
     * Enable ${{javascript}} expression evaluation.
     * Defaults to true for prompts, false for paths.
     */
    enableJsExpressions?: boolean;
}

// ============================================================================
// Git cache
// ============================================================================

let _gitCache: { time: number; values: Record<string, string> } | null = null;
const GIT_CACHE_TTL = 5000;

function getGitValues(): Record<string, string> {
    if (_gitCache && Date.now() - _gitCache.time < GIT_CACHE_TTL) {
        return _gitCache.values;
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) {
        _gitCache = { time: Date.now(), values: {} };
        return {};
    }

    const values: Record<string, string> = {};
    const opts = { cwd: wsRoot, encoding: 'utf-8' as const, timeout: 3000 };

    try { values.branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim(); } catch { values.branch = ''; }
    try { values.commit = execSync('git rev-parse --short HEAD', opts).trim(); } catch { values.commit = ''; }
    try { values.remote = execSync('git remote get-url origin 2>/dev/null', opts).trim(); } catch { values.remote = ''; }
    try {
        const status = execSync('git status --porcelain', opts).trim();
        values.dirty = status.length > 0 ? 'true' : 'false';
    } catch { values.dirty = ''; }

    _gitCache = { time: Date.now(), values };
    return values;
}

// ============================================================================
// Date/time formatting
// ============================================================================

/**
 * Format a Date using simple token-based patterns.
 *
 * Supported tokens:
 *   YYYY (4-digit year), YY (2-digit), MM (month 01-12), DD (day 01-31),
 *   HH (hour 00-23), hh (hour 01-12), mm (minutes), ss (seconds),
 *   SSS (milliseconds), A (AM/PM), ddd (day name short), d (day of week 0-6)
 */
export function formatDateTimeToken(date: Date, format: string): string {
    const tokens: [RegExp, string][] = [
        [/YYYY/g, String(date.getFullYear())],
        [/YY/g,   String(date.getFullYear()).slice(-2)],
        [/MM/g,   String(date.getMonth() + 1).padStart(2, '0')],
        [/DD/g,   String(date.getDate()).padStart(2, '0')],
        [/HH/g,   String(date.getHours()).padStart(2, '0')],
        [/hh/g,   String(((date.getHours() % 12) || 12)).padStart(2, '0')],
        [/mm/g,   String(date.getMinutes()).padStart(2, '0')],
        [/ss/g,   String(date.getSeconds()).padStart(2, '0')],
        [/SSS/g,  String(date.getMilliseconds()).padStart(3, '0')],
        [/A/g,    date.getHours() >= 12 ? 'PM' : 'AM'],
        [/ddd/g,  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]],
        [/(?<![A-Za-z])d(?![A-Za-z])/g, String(date.getDay())],
    ];

    let result = format;
    for (const [pattern, value] of tokens) {
        result = result.replace(pattern, value);
    }
    return result;
}

/**
 * Format a Date as YYYYMMDD_HHMMSS (request ID format).
 */
export function formatDateTime(date: Date = new Date()): string {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d  = String(date.getDate()).padStart(2, '0');
    const h  = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s  = String(date.getSeconds()).padStart(2, '0');
    return `${y}${mo}${d}_${h}${mi}${s}`;
}

// ============================================================================
// JavaScript expression evaluation
// ============================================================================

/**
 * Evaluate an inline JavaScript expression in a controlled context.
 * Returns the stringified result, or empty string on error.
 */
function evaluateJsExpression(expr: string, vars: Record<string, string>): string {
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(
            'vscode', 'os', 'path', 'env', 'vars', 'editor',
            `"use strict"; return (${expr});`,
        );
        const result = fn(
            vscode,
            os,
            path,
            process.env,
            vars,
            vscode.window.activeTextEditor,
        );
        return result !== null && result !== undefined ? String(result) : '';
    } catch (e: any) {
        console.error(`[VariableResolver] JS expression error in $\{{${expr}}}: ${e.message}`);
        return '';
    }
}

// ============================================================================
// Path sub-properties helper
// ============================================================================

/** The set of variable keys treated as path values (get .name / .extension). */
const PATH_VARIABLE_KEYS = new Set([
    'workspaceFolder', 'home', 'file', 'fileFolder', 'configfile',
    'configfile-workspace', 'configfile-user', 'configfile-vscode',
    'workspace-file', 'answer-file', 'chatAnswerFolder', 'tmpdir', 'shell',
]);

/**
 * For each path variable in the map, add KEY.name and KEY.extension entries.
 */
function addPathSubProperties(values: Record<string, string>): void {
    for (const key of PATH_VARIABLE_KEYS) {
        const val = values[key];
        if (val && val !== '') {
            const ext = path.extname(val);
            values[`${key}.name`] = path.basename(val, ext);
            values[`${key}.extension`] = ext;
        }
    }
}

// ============================================================================
// Config file path (self-contained, no circular dependency)
// ============================================================================

/**
 * Compute the extension config file path without importing handler_shared.
 * Expands ~/ but does NOT recursively resolve ${...} variables (avoids circularity).
 */
function getConfigFilePath(): string {
    const setting = vscode.workspace
        .getConfiguration('dartscript')
        .get<string>('configPath');

    let configPath = setting || path.join('~', '.tom', 'vscode', 'tom_vscode_extension.json');

    // Expand ~/
    if (configPath.startsWith('~/') || configPath === '~') {
        configPath = path.join(os.homedir(), configPath.slice(2));
    }

    // Expand ${home}
    configPath = configPath.replace(/\$\{home\}/g, os.homedir());

    // Expand ${workspaceFolder}
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        configPath = configPath.replace(/\$\{workspaceFolder\}/g, wsRoot);
    }

    return configPath;
}

/**
 * Get the chat answer folder from VS Code settings.
 */
function getChatAnswerFolder(): string {
    const setting = vscode.workspace
        .getConfiguration('dartscript.sendToChat')
        .get<string>('chatAnswerFolder');
    return setting || '_ai/chat_replies';
}

/**
 * Compute the answer file path for the current window.
 */
function getAnswerFilePath(): string {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const folder = wsRoot
        ? path.join(wsRoot, getChatAnswerFolder())
        : path.join(os.homedir(), '.tom', 'chat_replies');

    const session = vscode.env.sessionId;
    const machine = vscode.env.machineId;
    return path.join(folder, `${session}_${machine}_answer.json`);
}

/**
 * Compute the Copilot chat answer file path for the current window.
 * Uses the configurable copilotChatAnswerFolder (default: _ai/answers/copilot).
 */
function getCopilotAnswerFile(): string {
    const folder = _getCopilotChatAnswerFolderAbsolute();
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return path.join(folder, `${session}_${machine}_answer.json`);
}

/**
 * Local helper to get the copilot chat answer folder (workspace-relative).
 * Reads config lazily to avoid circular dependency with handler_shared.
 */
function _getCopilotChatAnswerFolder(): string {
    try {
        // Lazy import to break circular dependency
        const { loadSendToChatConfig } = require('../handlers/handler_shared');
        const config = loadSendToChatConfig();
        if (config?.copilotChatAnswerFolder) {
            return config.copilotChatAnswerFolder;
        }
    } catch { /* fallback */ }
    return WsPaths.aiRelative('answersCopilot');
}

/**
 * Local helper to get the absolute copilot chat answer folder.
 * Falls back to ~/.tom/copilot-chat-answers/ when no workspace is open.
 */
function _getCopilotChatAnswerFolderAbsolute(): string {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
        return path.join(wsRoot, _getCopilotChatAnswerFolder());
    }
    return WsPaths.home('copilotChatAnswers');
}

// ============================================================================
// Core variable map builder
// ============================================================================

/**
 * Build the complete map of built-in variable values.
 * This is the authoritative list of all automatically resolved variables.
 */
export function buildVariableMap(options?: ResolveOptions): Record<string, string> {
    const now = new Date();
    const wf = vscode.workspace.workspaceFolders?.[0];
    const wsRoot = wf?.uri.fsPath || '';
    const requestId = generateShortUUID();
    const configPath = getConfigFilePath();
    const answerFolder = getChatAnswerFolder();

    // Derive workspace name from .code-workspace file (quest-aware)
    const workspaceFile = vscode.workspace.workspaceFile;
    let vsCodeWorkspaceName = 'default';
    if (workspaceFile && workspaceFile.fsPath.endsWith('.code-workspace')) {
        vsCodeWorkspaceName = path.basename(workspaceFile.fsPath).replace('.code-workspace', '');
    }

    // Tier 1 — Universal
    const values: Record<string, string> = {
        // Workspace
        workspaceFolder:  wsRoot,
        workspace:        wf?.name || '',
        workspacepath:    wsRoot,
        'vs-code-workspace-name':   vsCodeWorkspaceName,
        'vs-code-workspace-folder': wsRoot || '',

        // User / Host
        username:         os.userInfo().username,
        hostname:         os.hostname(),
        home:             os.homedir(),

        // Platform
        os:               process.platform,
        arch:             process.arch,
        shell:            vscode.env.shell,
        locale:           vscode.env.language,
        separator:        path.sep,
        pathSeparator:    path.delimiter,
        tmpdir:           os.tmpdir(),

        // Date / Time
        date:             now.toLocaleDateString(),
        time:             now.toLocaleTimeString(),
        datetime:         requestId,
        requestId:        requestId,

        // Identity
        windowId:         vscode.env.sessionId,
        machineId:        vscode.env.machineId,
        uuid:             generateUUID(),

        // Config files (all currently resolve to same file)
        configfile:              configPath,
        'configfile-workspace':  configPath,
        'configfile-user':       configPath,
        'configfile-vscode':     configPath,
        'workspace-file':        configPath,

        // Answer file
        'answer-file':    getAnswerFilePath(),
        chatAnswerFolder: answerFolder,
        copilotAnswerFolder: _getCopilotChatAnswerFolder(),
        copilotAnswerPath: _getCopilotChatAnswerFolderAbsolute(),
        copilotAnswerFile: getCopilotAnswerFile(),

        // VS Code meta (Tier 7)
        'vscode.version':     vscode.version,
        'vscode.appName':     vscode.env.appName,
        'vscode.appHost':     vscode.env.appHost,
        'vscode.uiKind':      vscode.env.uiKind === vscode.UIKind.Desktop ? 'Desktop' : 'Web',
        'extension.version':  getExtensionVersion(),
    };

    // Tier 2 — Editor-dependent
    if (options?.includeEditor !== false) {
        addEditorValues(values);
    }

    // Tier 4 — Chat variables
    addChatValues(values);

    // Tier 4b — Composite chat/context block placeholders
    addCompositeBlocks(values);

    // Tier 1b — Workspace folder names & paths (from WsPaths registry)
    Object.assign(values, WsPaths.getResolverVariables());

    // Add .name / .extension sub-properties for path variables
    addPathSubProperties(values);

    return values;
}

// ============================================================================
// Tier 2 — Editor values
// ============================================================================

function addEditorValues(values: Record<string, string>): void {
    const editor = vscode.window.activeTextEditor;
    const wf = vscode.workspace.workspaceFolders?.[0];

    if (editor) {
        const doc = editor.document;
        const filePath = doc.uri.fsPath;
        const fileDir = path.dirname(filePath);
        const fileExt = path.extname(filePath);
        const fileName = path.basename(filePath, fileExt);
        const fileBaseName = path.basename(filePath);
        const sel = doc.getText(editor.selection);
        const hasSelection = !editor.selection.isEmpty;

        values['file']            = filePath;
        values['file.name']       = fileName;
        values['file.extension']  = fileExt;
        values['file.content']    = doc.getText();
        values['file.selection']  = hasSelection ? sel : doc.getText();
        values['file.relative']   = wf ? path.relative(wf.uri.fsPath, filePath) : filePath;
        values['file.language']   = doc.languageId;
        values['fileFolder']      = fileDir;
        values['selection']       = sel || '';
        values['line']            = String(editor.selection.active.line + 1);
        values['column']          = String(editor.selection.active.character + 1);

    } else {
        values['file']            = '';
        values['file.name']       = '';
        values['file.extension']  = '';
        values['file.content']    = '';
        values['file.selection']  = '';
        values['file.relative']   = '';
        values['file.language']   = '';
        values['fileFolder']      = '';
        values['selection']       = '';
        values['line']            = '';
        values['column']          = '';
    }
}

// ============================================================================
// Tier 4 — Chat variable values
// ============================================================================

/**
 * Add chat variable values from the ChatVariablesStore.
 * Uses dynamic import to avoid circular dependencies.
 */
function addChatValues(values: Record<string, string>): void {
    try {
        // The ChatVariablesStore is a singleton; access it dynamically
        // to avoid circular dependency with handler_shared.
        // We look up the global _chatResponseValues via a shared accessor.
        const chatStore = getChatVariablesStoreInstance();
        if (chatStore) {
            const tv = chatStore.toTemplateValues();
            for (const [k, v] of Object.entries(tv)) {
                values[`chat.${k}`] = v;
            }
            // Also expose quest directly for convenience
            if (tv['quest']) {
                values['quest'] = tv['quest'];
            }
        }
    } catch {
        // ChatVariablesStore not yet initialized — skip
    }
}

/**
 * Get the ChatVariablesStore singleton instance (if available).
 * Returns null if not yet activated.
 */
function getChatVariablesStoreInstance(): { toTemplateValues(): Record<string, string> } | null {
    try {
        // Use require to avoid static circular dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../managers/chatVariablesStore.js');
        const cls = mod.ChatVariablesStore;
        return cls?.instance ?? null;
    } catch {
        return null;
    }
}

// ============================================================================
// Tier 4b — Composite block placeholders (chatVariables, contextInfo, contextAndVariables)
// ============================================================================

/**
 * Build the ${chatVariables} block: all chat variables as a JSON code block.
 * Includes built-in variables (quest, role, etc.) and all custom.* variables.
 */
function buildChatVariablesBlock(values: Record<string, string>): string {
    const chatStore = getChatVariablesStoreInstance();
    if (!chatStore) {
        return 'Current Chat Variables:\n\n```json\n{}\n```';
    }
    const tv = chatStore.toTemplateValues();
    const obj: Record<string, string> = {};
    for (const [k, v] of Object.entries(tv)) {
        obj[k] = v || 'not set';
    }
    return `Current Chat Variables:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

/**
 * Build the ${contextInfo} block: all context settings as a JSON code block.
 * Shows "not set" for empty values.
 */
function buildContextInfoBlock(values: Record<string, string>): string {
    const contextKeys = [
        'quest', 'role', 'activeProjects', 'todo', 'todoFile',
        'workspaceFolder', 'workspace', 'requestId', 'datetime',
        'windowId', 'machineId', 'os', 'arch', 'locale',
        'copilotAnswerFile', 'copilotAnswerFolder',
        'configfile', 'chatAnswerFolder',
        'git.branch', 'git.commit', 'git.dirty',
    ];
    const obj: Record<string, string> = {};
    for (const key of contextKeys) {
        const val = values[`chat.${key}`] ?? values[key] ?? '';
        obj[key] = val || 'not set';
    }
    return `Current Context:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

/**
 * Add composite block placeholders to the values map.
 * Must be called AFTER addChatValues() so chat.* keys are populated.
 */
function addCompositeBlocks(values: Record<string, string>): void {
    const chatVarsBlock = buildChatVariablesBlock(values);
    const contextBlock = buildContextInfoBlock(values);

    values['chatVariables'] = chatVarsBlock;
    values['contextInfo'] = contextBlock;
    values['contextAndVariables'] = `${contextBlock}\n\n${chatVarsBlock}`;
}

// ============================================================================
// Async values (clipboard)
// ============================================================================

async function addAsyncValues(values: Record<string, string>): Promise<void> {
    try {
        const clip = await vscode.env.clipboard.readText();
        values['clipboard'] = clip || '';
    } catch {
        values['clipboard'] = '';
    }
}

// ============================================================================
// Extension version helper
// ============================================================================

let _extensionVersion: string | null = null;

function getExtensionVersion(): string {
    if (_extensionVersion !== null) { return _extensionVersion; }
    try {
        const ext = vscode.extensions.getExtension('tom.tom-vscode-extension')
            ?? vscode.extensions.getExtension('undefined_publisher.tom-vscode-extension');
        _extensionVersion = ext?.packageJSON?.version ?? '0.0.0';
    } catch {
        _extensionVersion = '0.0.0';
    }
    return _extensionVersion!;
}

// ============================================================================
// UUID v4 generator (simple, no crypto dependency)
// ============================================================================

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/** Generate a short UUID for request identification (8-char hex + 8-char hex). */
function generateShortUUID(): string {
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}_${hex()}`;
}

// ============================================================================
// Dynamic namespace resolution
// ============================================================================

/**
 * Resolve a variable key that wasn't found in the static values map.
 * Handles dynamic namespaces: env.*, config.*, git.*, vscode.*, date.FORMAT, time.FORMAT.
 */
function resolveDynamicKey(key: string, values: Record<string, string>, now: Date): string | undefined {
    // ${date.FORMAT} — custom date formatting
    if (key.startsWith('date.')) {
        return formatDateTimeToken(now, key.slice(5));
    }

    // ${time.FORMAT} — custom time formatting
    if (key.startsWith('time.')) {
        return formatDateTimeToken(now, key.slice(5));
    }

    // ${env.VARNAME} — environment variable
    if (key.startsWith('env.')) {
        return process.env[key.slice(4)] ?? '';
    }

    // ${config.KEY} — VS Code setting
    if (key.startsWith('config.')) {
        const settingKey = key.slice(7);
        const val = vscode.workspace.getConfiguration().get(settingKey);
        return val !== undefined && val !== null ? String(val) : '';
    }

    // ${git.KEY} — Git repository info (lazily cached)
    if (key.startsWith('git.')) {
        const gitVals = getGitValues();
        return gitVals[key.slice(4)] ?? '';
    }

    // ${vscode.KEY} — VS Code environment (already in static map for known keys)
    // Handle any remaining vscode.* lookups dynamically
    if (key.startsWith('vscode.')) {
        const prop = key.slice(7);
        const envObj: Record<string, any> = vscode.env as any;
        if (prop in envObj) {
            const v = envObj[prop];
            return v !== null && v !== undefined ? String(v) : '';
        }
        return '';
    }

    // ${chat.KEY} — already in static map if ChatVariablesStore was available
    // Try dynamic lookup for chat response values
    if (key.startsWith('chat.')) {
        return values[key] ?? '';
    }

    return undefined; // truly unresolved
}

// ============================================================================
// Resolution pass
// ============================================================================

/**
 * Perform a single resolution pass, replacing placeholders with values.
 *
 * Resolution order:
 *   1. ${{javascript}} expressions (if enabled)
 *   2. ${key} patterns
 */
function resolvePass(
    text: string,
    values: Record<string, string>,
    now: Date,
    options?: ResolveOptions,
): string {
    let result = text;
    const unresolvedBehavior = options?.unresolvedBehavior ?? 'empty';

    // 1. Evaluate ${{javascript}} expressions
    if (options?.enableJsExpressions !== false) {
        result = result.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
            return evaluateJsExpression(expr.trim(), values);
        });
    }

    // 2. Replace ${key} dollar-brace patterns
    result = result.replace(/\$\{([^{}]+)\}/g, (match, rawKey: string) => {
        const key = rawKey.trim();

        // Direct lookup (case-sensitive first, then case-insensitive)
        if (key in values) {
            return values[key];
        }

        // Case-insensitive fallback
        const lk = key.toLowerCase();
        for (const [k, v] of Object.entries(values)) {
            if (k.toLowerCase() === lk) { return v; }
        }

        // Dynamic namespace resolution
        const dynamic = resolveDynamicKey(key, values, now);
        if (dynamic !== undefined) { return dynamic; }

        return unresolvedBehavior === 'keep' ? match : '';
    });

    return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve all placeholders in a string (synchronous).
 *
 * Suitable for path/filename fields, configuration values, and any context
 * where async operations (clipboard) are not needed.
 *
 * @param input   The string containing placeholders.
 * @param options Resolution options.
 * @returns The resolved string.
 */
export function resolveVariables(input: string, options?: ResolveOptions): string {
    const now = new Date();

    // Handle leading ~/ (home directory shorthand)
    let result = input;
    if (result.startsWith('~/') || result === '~') {
        result = path.join(os.homedir(), result.slice(2));
    }

    // Build values map
    const values = buildVariableMap(options);

    // Merge caller-provided values (override built-ins)
    if (options?.values) {
        Object.assign(values, options.values);
    }

    // Resolve (potentially recursive, default 10 levels)
    const maxDepth = options?.maxDepth ?? 10;
    let prev = '';
    for (let i = 0; i < maxDepth && result !== prev; i++) {
        prev = result;
        result = resolvePass(result, values, now, options);
    }

    return result;
}

/**
 * Resolve a folder path constant with placeholder support.
 *
 * This is the central function for resolving folder paths from configurable
 * constants. Use this for ALL folder path resolution to enable future
 * configuration-based folder paths (e.g. "workspace-config:chat.flow.folder").
 *
 * @param folderPath The folder path (may contain placeholders like ${aiPath})
 * @returns Resolved absolute path
 */
export function resolveFolderPath(folderPath: string): string {
    return resolveVariables(folderPath, {
        maxDepth: 10,
        unresolvedBehavior: 'empty',
        includeEditor: false,
        enableJsExpressions: false,

    });
}

/**
 * Resolve all placeholders in a string (asynchronous).
 *
 * Same as resolveVariables but also resolves ${clipboard} and any other
 * async values. Use this for prompt templates and user-facing text.
 *
 * @param input   The string containing placeholders.
 * @param options Resolution options.
 * @returns The resolved string.
 */
export async function resolveVariablesAsync(input: string, options?: ResolveOptions): Promise<string> {
    const now = new Date();

    // Handle leading ~/
    let result = input;
    if (result.startsWith('~/') || result === '~') {
        result = path.join(os.homedir(), result.slice(2));
    }

    // Build values map with async additions
    const values = buildVariableMap(options);
    await addAsyncValues(values);

    // Merge caller-provided values
    if (options?.values) {
        Object.assign(values, options.values);
    }

    // Resolve (potentially recursive, default 10 levels)
    const maxDepth = options?.maxDepth ?? 10;
    let prev = '';
    for (let i = 0; i < maxDepth && result !== prev; i++) {
        prev = result;
        result = resolvePass(result, values, now, options);
    }

    return result;
}

// ============================================================================
// Placeholder help text
// ============================================================================

/** HTML help text listing all available placeholders (for template editor UIs). */
export const PLACEHOLDER_HELP = `<strong>Available Placeholders:</strong><br>
<br>
<em>Workspace &amp; Environment:</em><br>
<code>\${workspaceFolder}</code> – Workspace root path (absolute)<br>
<code>\${workspacepath}</code> – Alias for workspaceFolder<br>
<code>\${workspace}</code> – Workspace name<br>
<code>\${vs-code-workspace-name}</code> – Name from .code-workspace file (falls back to "default")<br>
<code>\${vs-code-workspace-folder}</code> – Workspace root folder path (absolute)<br>
<code>\${home}</code> – User home directory<br>
<code>\${username}</code> – OS username<br>
<code>\${hostname}</code> – Machine hostname<br>
<code>\${os}</code> – Platform (linux, darwin, win32)<br>
<code>\${arch}</code> – CPU architecture (x64, arm64)<br>
<code>\${shell}</code> – Default shell path<br>
<code>\${locale}</code> – VS Code language (en, de, …)<br>
<code>\${separator}</code> – Path separator (/ or \\)<br>
<code>\${pathSeparator}</code> – Path list delimiter (: or ;)<br>
<code>\${tmpdir}</code> – OS temp directory<br>
<code>\${env.VARNAME}</code> – Any environment variable<br>
<br>
<em>Date &amp; Time:</em><br>
<code>\${date}</code> – Current date (locale)<br>
<code>\${time}</code> – Current time (locale)<br>
<code>\${date.FORMAT}</code> – Formatted date (e.g. <code>\${date.YYYY-MM-DD}</code>)<br>
<code>\${time.FORMAT}</code> – Formatted time (e.g. <code>\${time.HH:mm:ss}</code>)<br>
<code>\${datetime}</code> – Timestamp YYYYMMDD_HHMMSS<br>
<code>\${requestId}</code> – Same as datetime (alias)<br>
<code>\${uuid}</code> – Random UUID v4<br>
<br>
<em>Editor Context:</em><br>
<code>\${file}</code> – Current file path (absolute)<br>
<code>\${file.name}</code> – Filename without extension<br>
<code>\${file.extension}</code> – File extension (.dart, .ts, …)<br>
<code>\${file.content}</code> – Full file content<br>
<code>\${file.selection}</code> – Selection (falls back to full content)<br>
<code>\${file.relative}</code> – File path relative to workspace<br>
<code>\${file.language}</code> – Language ID (dart, typescript, …)<br>
<code>\${fileFolder}</code> – Directory of current file<br>
<code>\${selection}</code> – Current text selection<br>
<code>\${clipboard}</code> – Clipboard contents (async only)<br>
<code>\${line}</code> / <code>\${column}</code> – Cursor position (1-based)<br>
<br>
<em>Identity &amp; Config:</em><br>
<code>\${windowId}</code> – VS Code session ID<br>
<code>\${machineId}</code> – VS Code machine ID<br>
<code>\${configfile}</code> – Extension config file path<br>
<code>\${configfile-workspace}</code> / <code>\${configfile-user}</code> / <code>\${configfile-vscode}</code> – Config variants<br>
<code>\${answer-file}</code> – Answer file path (sendToChat system)<br>
<code>\${chatAnswerFolder}</code> – Answer folder path (sendToChat system)<br>
<code>\${copilotAnswerFile}</code> – Copilot chat answer file path (absolute)<br>
<code>\${copilotAnswerFolder}</code> – Copilot chat answer folder (workspace-relative)<br>
<code>\${copilotAnswerPath}</code> – Copilot chat answer folder (absolute path)<br>
<code>\${config.KEY}</code> – Any VS Code setting value<br>
<br>
<em>Workspace Folders:</em><br>
<code>\${aiFolder}</code> – AI folder name (_ai)<br>
<code>\${guidelinesFolder}</code> – Guidelines folder name (_copilot_guidelines)<br>
<code>\${metadataFolder}</code> – Metadata folder name (.tom_metadata)<br>
<code>\${githubFolder}</code> – GitHub folder name (.github)<br>
<code>\${homeTomFolder}</code> – Home Tom folder name (.tom)<br>
<code>\${wsConfigFolder}</code> – Workspace config folder name (.tom)<br>
<code>\${aiPath}</code> – AI folder absolute path<br>
<code>\${guidelinesPath}</code> – Guidelines folder absolute path<br>
<code>\${metadataPath}</code> – Metadata folder absolute path<br>
<code>\${questsPath}</code> – Quests folder absolute path<br>
<code>\${rolesPath}</code> – Roles folder absolute path<br>
<code>\${wsConfigPath}</code> – Workspace config folder absolute path<br>
<br>
<em>Git:</em><br>
<code>\${git.branch}</code> – Current branch name<br>
<code>\${git.commit}</code> – Short commit hash (HEAD)<br>
<code>\${git.remote}</code> – Remote origin URL<br>
<code>\${git.dirty}</code> – "true" if uncommitted changes<br>
<br>
<em>VS Code:</em><br>
<code>\${vscode.version}</code> – VS Code version<br>
<code>\${vscode.appName}</code> – Application name<br>
<code>\${vscode.appHost}</code> – Application host string<br>
<code>\${vscode.uiKind}</code> – "Desktop" or "Web"<br>
<code>\${extension.version}</code> – Extension version<br>
<br>
<em>Chat Variables (built-in):</em><br>
<code>\${quest}</code> – Active quest ID (set in Context &amp; Settings)<br>
<code>\${role}</code> – Active role (set in Context &amp; Settings)<br>
<code>\${activeProjects}</code> – Comma-separated active project names<br>
<code>\${todo}</code> – Selected todo item ID<br>
<code>\${todoFile}</code> – Selected todo YAML file path<br>
<code>\${chat.quest}</code> – Same as \${quest}<br>
<code>\${chat.role}</code> – Same as \${role}<br>
<code>\${chat.activeProjects}</code> – Same as \${activeProjects}<br>
<code>\${chat.todo}</code> – Same as \${todo}<br>
<code>\${chat.todoFile}</code> – Same as \${todoFile}<br>
<br>
<em>Chat Variables (custom):</em><br>
<code>\${custom.KEY}</code> – User-defined custom variable (set via Chat Variables Editor or answer files)<br>
Custom variables are created from two sources:<br>
&nbsp;&nbsp;1. <strong>Manually</strong> via the Chat Variables Editor "+ Add" button<br>
&nbsp;&nbsp;2. <strong>Automatically</strong> from Copilot answer file <code>responseValues</code> — when a prompt queue answer<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;contains <code>"responseValues": {"key": "value"}</code>, each non-built-in key is stored<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;as <code>custom.key</code> in the persistent chat variables store.<br>
Custom variables persist across window reloads. Delete them via the Chat Variables Editor.<br>
<br>
<em>Chat Response Values (session-scoped):</em><br>
<code>\${chat.KEY}</code> – Also resolves response values from the current session's answer files<br>
These are populated from Copilot answer files, send-to-chat answer files, and escalation tool answers.<br>
Session response values are <strong>not persisted</strong> across window reloads — they exist only for the current session.<br>
Use <code>#key=description</code> notation in prompts to request specific response values from Copilot.<br>
<br>
<em>Composite Blocks:</em><br>
<code>\${chatVariables}</code> – All chat variables as a formatted JSON code block<br>
<code>\${contextInfo}</code> – All context settings as a formatted JSON code block ("not set" for empty values)<br>
<code>\${contextAndVariables}</code> – Both context info and chat variables blocks combined<br>
<br>
<em>Path variables support sub-properties:</em><br>
<code>\${KEY.name}</code> – Filename/basename without extension<br>
<code>\${KEY.extension}</code> – File extension including dot<br>
<br>
<em>Inline JavaScript:</em><br>
<code>\${{expression}}</code> – Evaluate JS at resolution time<br>
<br>
`;
