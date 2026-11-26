/**
 * Unified Variable Resolver
 *
 * Central module for placeholder expansion across all contexts:
 * path/filename fields, prompt templates, configuration values, etc.
 *
 * Supports two syntaxes:
 *   ${name}            — Dollar-brace (standard)
 *   ${{expression}}    — An expression (templateExpression.ts): conditionals, comparisons, helpers
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

import { expandLineImports } from './lineImports';
import { layoutWorkspaceFolder } from './workspaceLayout';
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WsPaths } from './workspacePaths';
import { levelIndexes, listLevelFiles } from './guidelineFolders';
import { PROCESS_VARIABLE_KEYS } from './processDefinition';
import { logConfigAccess } from './toolLog';
import { osLoginName } from './osUserName';
import { evaluateExpression, forEachExpressionPlaceholder } from './templateExpression';
import { collectClaudeMd, collectWithImports, renderClaudeMd } from '../services/claudeMd';
import { AGENTS_MD, CLAUDE_MD } from './agentInstructions';
import { defaultQuestNotesPath } from './notesFiles';

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
     * Evaluate `${{ expression }}` placeholders (templateExpression.ts).
     * Defaults to true for prompts, false for paths.
     */
    enableExpressions?: boolean;
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

    const wsRoot = layoutWorkspaceFolder();
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
// Path sub-properties helper
// ============================================================================

/** The set of variable keys treated as path values (get .name / .extension). */
const PATH_VARIABLE_KEYS = new Set([
    'workspaceFolder', 'tomRoot', 'home', 'file', 'fileFolder', 'configfile',
    'configfile-workspace', 'configfile-user', 'configfile-vscode',
    'workspace-file', 'tmpdir', 'shell',
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
        .getConfiguration('tomAi')
        .get<string>('configPath');

    let configPath = setting || path.join('~', '.tom', 'vscode', 'tom_vscode_extension.json');

    // Expand ~/
    if (configPath.startsWith('~/') || configPath === '~') {
        configPath = path.join(os.homedir(), configPath.slice(2));
    }

    // Expand ${home}
    configPath = configPath.replace(/\$\{home\}/g, os.homedir());

    // Expand ${workspaceFolder}
    const wsRoot = layoutWorkspaceFolder();
    if (wsRoot) {
        configPath = configPath.replace(/\$\{workspaceFolder\}/g, wsRoot);
    }
    const tomRoot = WsPaths.tomRoot;
    if (tomRoot) {
        configPath = configPath.replace(/\$\{tomRoot\}/g, tomRoot);
    }

    logConfigAccess('variableResolver.getConfigFilePath', configPath, {
        action: 'resolve',
        branch: setting ? 'setting' : 'home default',
        setting: setting ?? '',
    });
    return configPath;
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
    const wsRoot = layoutWorkspaceFolder() || '';
    const requestId = generateShortUUID();
    const configPath = getConfigFilePath();

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
        username:         osLoginName(),
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

    // The window's workspace quests (02_wslayout-11): the list, else the recorded ones, else every quest.
    if (!('workspaceQuests' in values)) { defineLazyValue(values, 'workspaceQuests', workspaceQuestsValue); }

    // Tier 4c — File-injection placeholders (role/quest descriptions) and
    // the universal ${userMessage} default. Runs after Tier 4 so chat
    // values are populated, and after WsPaths so rolesPath/questsPath exist.
    addFileInjectionPlaceholders(values);

    // Add .name / .extension sub-properties for path variables
    addPathSubProperties(values);

    return values;
}

// ============================================================================
// Tier 2 — Editor values
// ============================================================================

function addEditorValues(values: Record<string, string>): void {
    const editor = vscode.window.activeTextEditor;
    const wsFolder = layoutWorkspaceFolder();

    if (editor) {
        const doc = editor.document;
        const filePath = doc.uri.fsPath;
        const fileDir = path.dirname(filePath);
        const fileExt = path.extname(filePath);
        const fileName = path.basename(filePath, fileExt);
        const sel = doc.getText(editor.selection);
        const hasSelection = !editor.selection.isEmpty;

        values['file']            = filePath;
        values['file.name']       = fileName;
        values['file.extension']  = fileExt;
        values['file.content']    = doc.getText();
        values['file.selection']  = hasSelection ? sel : doc.getText();
        values['file.relative']   = wsFolder ? path.relative(wsFolder, filePath) : filePath;
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
        const builtInChatKeys = new Set<string>(['quest', 'role', 'activeProjects', 'todo', 'todoFile', ...PROCESS_VARIABLE_KEYS]);
        const exposeCustomAliases = (rawKey: string, rawValue: string): void => {
            const normalizedKey = rawKey.startsWith('custom.') ? rawKey.substring('custom.'.length) : rawKey;
            if (!normalizedKey || builtInChatKeys.has(normalizedKey)) {
                return;
            }
            if (!("custom." + normalizedKey in values)) {
                values[`custom.${normalizedKey}`] = rawValue;
            }
            if (!(normalizedKey in values)) {
                values[normalizedKey] = rawValue;
            }
        };

        // The ChatVariablesStore is a singleton; access it dynamically
        // to avoid circular dependency with handler_shared.
        const chatStore = getChatVariablesStoreInstance();
        if (chatStore) {
            const tv = chatStore.toTemplateValues();
            for (const [k, v] of Object.entries(tv)) {
                values[`chat.${k}`] = v;
                exposeCustomAliases(k, v);
            }
            for (const key of builtInChatKeys) {
                if (key in tv) {
                    values[key] = tv[key];
                }
            }
        }

        // Also expose session-scoped response values from answer files.
        // These power placeholders like ${chat.sessionCount} between prompts.
        const responseValues = getChatResponseValuesSnapshot();
        for (const [k, v] of Object.entries(responseValues)) {
            const normalizedKey = k.startsWith('custom.') ? k.substring('custom.'.length) : k;
            if (!("chat." + k in values)) {
                values[`chat.${k}`] = v;
            }
            if (k !== normalizedKey && !("chat." + normalizedKey in values)) {
                values[`chat.${normalizedKey}`] = v;
            }
            exposeCustomAliases(k, v);
        }
    } catch {
        // ChatVariablesStore not yet initialized — skip
    }
    // The role the send runs as (services/queueRoleContext.ts, gsel3): a queue
    // stage's todo or item role, a queued Proceed prompt's step role (although
    // the quest may have moved on since it was queued), the run's default role.
    const promptRole = getPromptRoleOverride();
    if (promptRole) {
        values['role'] = promptRole;
        values['chat.role'] = promptRole;
    }
}

/** The role the current send runs as when it is not the chat variable's; undefined otherwise. */
function getPromptRoleOverride(): string | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../services/queueRoleContext.js') as typeof import('../services/queueRoleContext');
        const r = mod.livePromptRole();
        return r.from === 'chat' || r.from === 'none' ? undefined : r.role;
    } catch {
        return undefined;
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

/**
 * Get session-scoped chat response values from handler_shared.
 */
function getChatResponseValuesSnapshot(): Record<string, string> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../handlers/handler_shared');
        const raw = typeof mod.getChatResponseValues === 'function'
            ? mod.getChatResponseValues()
            : {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw || {})) {
            if (!k || v === undefined || v === null) { continue; }
            out[k] = String(v);
        }
        return out;
    } catch {
        return {};
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
    const tv = chatStore ? chatStore.toTemplateValues() : {};
    const obj: Record<string, string> = {};
    for (const [k, v] of Object.entries(tv)) {
        obj[k] = v || 'not set';
    }
    const responseValues = getChatResponseValuesSnapshot();
    for (const [k, v] of Object.entries(responseValues)) {
        if (!(k in obj)) {
            obj[k] = v || 'not set';
        }
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
        'workspaceFolder', 'tomRoot', 'workspace', 'requestId', 'datetime',
        'windowId', 'machineId', 'os', 'arch', 'locale',
        'configfile',
        'git.branch', 'git.commit', 'git.dirty',
    ];
    const obj: Record<string, string> = {};
    const gitValues = getGitValues();
    for (const key of contextKeys) {
        let val = values[`chat.${key}`] ?? values[key] ?? '';
        if (!val && key.startsWith('git.')) {
            val = gitValues[key.substring(4)] ?? '';
        }
        obj[key] = val || 'not set';
    }
    return `Current Context:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
}

/**
 * Add composite block placeholders to the values map.
 * Must be called AFTER addChatValues() so chat.* keys are populated.
 */
function addCompositeBlocks(values: Record<string, string>): void {
    // Lazy: the blocks are built when a template reads them. Building
    // `contextInfo` runs four synchronous git commands (git status among
    // them), and every placeholder resolution builds this map — a folder
    // path, the bridge profile's cwd at activation — so building them eagerly
    // held the extension host for seconds while a window opened.
    defineLazyValue(values, 'chatVariables', () => buildChatVariablesBlock(values));
    defineLazyValue(values, 'contextInfo', () => buildContextInfoBlock(values));
    defineLazyValue(values, 'contextAndVariables', () => `${values['contextInfo']}\n\n${values['chatVariables']}`);
}

/**
 * Put `key` into `values` as a value computed on its first read and kept.
 * An assignment replaces it with a plain value. Exported for its test.
 */
export function defineLazyValue(values: Record<string, string>, key: string, compute: () => string): void {
    let cached: string | undefined;
    Object.defineProperty(values, key, {
        enumerable: true,
        configurable: true,
        get: () => (cached ??= compute()),
        set: (value: string) => {
            Object.defineProperty(values, key, { value, writable: true, enumerable: true, configurable: true });
        },
    });
}

// ============================================================================
// Tier 4c — File-injection & user-message placeholders
// ============================================================================

/** The files already imported in one resolution (keyed by its value map): each file is imported once (gsel18). */
const IMPORTS_SEEN = new WeakMap<Record<string, string>, Set<string>>();

/**
 * An injected file's text with its `@<path>` import lines expanded
 * (utils/lineImports.ts), once per file in the resolution `values` belongs to.
 */
function withImports(content: string, file: string, values: Record<string, string>): string {
    if (!content || !file) { return content; }
    let seen = IMPORTS_SEEN.get(values);
    if (!seen) { seen = new Set(); IMPORTS_SEEN.set(values, seen); }
    return expandLineImports(content, file, { seen });
}

/** A file read for injection: its text with its imports expanded; '' when it cannot be read. */
function injectFile(filePath: string, values: Record<string, string>): string {
    return withImports(safeReadFileSync(filePath), filePath, values);
}

function safeReadFileSync(filePath: string): string {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return '';
        }
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}

/**
 * Add `${role-description}`, `${quest-description}`, and `${userMessage}`.
 *
 * - `role-description` reads `${rolesPath}/${role}/role.md`; empty if
 *   either `role` or the file is missing.
 * - `quest-description` reads
 *   `${questsPath}/${quest}/overview.${quest}.md`; empty if either
 *   `quest` or the file is missing.
 * - `userMessage` defaults to `""`; callers that expand an Anthropic
 *   user-message template inject the actual user text via
 *   `options.values.userMessage` on `resolve()`.
 */
function addFileInjectionPlaceholders(values: Record<string, string>): void {
    const role = values['role'] || '';
    const rolesPath = values['rolesPath'] || '';
    if (role && rolesPath) {
        values['role-description'] = injectFile(path.join(rolesPath, role, 'role.md'), values);
    } else {
        values['role-description'] = '';
    }

    const quest = values['quest'] || '';
    const questsPath = values['questsPath'] || '';
    if (quest && questsPath) {
        values['quest-description'] = injectFile(path.join(questsPath, quest, `overview.${quest}.md`), values);
    } else {
        values['quest-description'] = '';
    }

    if (!('userMessage' in values)) {
        values['userMessage'] = '';
    }

    // The quest's process as one block for system prompts; '' without one.
    values['process-context'] = getProcessContextBlock();
}

/** The active quest's `${process-context}` block (src/managers/processStateStore.ts). */
function getProcessContextBlock(): string {
    try {
        // Required lazily, as the chat variable store is: no static cycle.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../managers/processStateStore.js');
        return mod.ProcessStateStore?.instance?.contextBlock() ?? '';
    } catch {
        return '';
    }
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

/** Generate a short UUID for request identification (8-char hex + 8-char hex) — a `${requestId}`. */
export function generateShortUUID(): string {
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}_${hex()}`;
}

// ============================================================================
// Dynamic namespace resolution
// ============================================================================

/**
 * Resolve a variable key that wasn't found in the static values map.
 * Handles dynamic namespaces: env.*, config.*, git.*, vscode.*, date.FORMAT, time.FORMAT,
 * plus file-injection placeholders (claude.md, agents.md, instructions, agent-instructions,
 * guidelines-*, role-*, quest-*, file-*).
 *
 * Exported so the older `promptTemplate.resolvePass()` can share the same
 * dispatch rules instead of forking.
 */
export function resolveDynamicKey(key: string, values: Record<string, string>, now: Date): string | undefined {
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

    // File-injection placeholders — read a file and inline its contents.
    // Missing files resolve to "" (never throw).
    const fileInjection = resolveFileInjectionKey(key, values);
    if (fileInjection !== undefined) { return fileInjection; }

    return undefined; // truly unresolved
}

/**
 * Dynamic file-injection placeholders.
 *
 *   ${claude.md}              → <workspace>/CLAUDE.md
 *   ${agents.md}              → <workspace>/AGENTS.md
 *   ${instructions}           → CLAUDE.md if present, else AGENTS.md
 *   ${agent-instructions}     → the workspace folder's CLAUDE.md with the files
 *                                it imports (`@…`), as Claude Code expands them
 *                                (services/claudeMd.ts collectWithImports);
 *                                AGENTS.md when there is no CLAUDE.md
 *   ${copilot-instructions}   → deprecated alias of ${agent-instructions}
 *   ${claudeMd}               → every CLAUDE.md as Claude Code loads it — the
 *                                user-level file, the folder chain with the
 *                                CLAUDE.local.md files, the @imports
 *                                (services/claudeMd.ts)
 *   ${guidelines-<name>}      → <name>.md of the guidelines: the workspace
 *                                folder's, else the root's (either folder name;
 *                                fallback: _guidelines/<name>.md). `<name>` can
 *                                already include `.md`; no double-extension.
 *   ${guidelines-index}       → the levels' indexes concatenated, the root's
 *                                first (`index_root.md`, `index_workspace.md`,
 *                                each else its level's index.md)
 *   ${root-guidelines-index} / ${workspace-guidelines-index} → one level's index
 *   ${role-<name>}            → <workspace>/_ai/roles/<name>.md
 *                                (fallback: _ai/roles/<name>/role.md)
 *   ${quest-<type>}           → first file matching
 *                                _ai/quests/${quest}/<type>.${quest}.* —
 *                                e.g. ${quest-overview} → overview.${quest}.md;
 *                                ${quest-quest-notes} → the quest's default
 *                                notes file, notes/quest-notes.md
 *   ${file-<path>}            → <path> (relative to workspace root, or
 *                                absolute when it starts with `/`)
 *
 * All of these resolve to "" when the target file does not exist.
 */
function resolveFileInjectionKey(key: string, values: Record<string, string>): string | undefined {
    const wsRoot = values['workspaceFolder'] || '';

    // Fixed keys — explicit matches first.
    if (key === 'claude.md') {
        return safeReadFileSync(path.join(wsRoot, 'CLAUDE.md'));
    }
    if (key === 'agents.md') {
        return safeReadFileSync(path.join(wsRoot, AGENTS_MD));
    }
    // `${copilot-instructions}` is a deprecated alias (removed with 06a_wslayout-8); the Copilot file is not read.
    if (key === 'agent-instructions' || key === 'copilot-instructions' || key === 'copilot-instructions.md') {
        if (!wsRoot) { return ''; }
        const claude = path.join(wsRoot, CLAUDE_MD);
        if (fs.existsSync(claude)) { return renderClaudeMd(collectWithImports(claude, os.homedir())); }
        return safeReadFileSync(path.join(wsRoot, AGENTS_MD));
    }
    if (key === 'claudeMd') {
        return wsRoot ? renderClaudeMd(collectClaudeMd({ wsRoot, homeDir: os.homedir() })) : '';
    }
    if (key === 'instructions') {
        const claude = safeReadFileSync(path.join(wsRoot, CLAUDE_MD));
        if (claude) { return claude; }
        return safeReadFileSync(path.join(wsRoot, AGENTS_MD));
    }

    // ${skills-list} (gsel21): the skills of `.claude/skills/` as the system prompt lists them — the text of the aspect `skills`.
    if (key === 'skills-list') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { listSkills, skillsSystemSection } = require('../services/skills') as typeof import('../services/skills');
        return wsRoot ? skillsSystemSection(listSkills(wsRoot)) : '';
    }

    // The guideline indexes: both levels concatenated, or one level's.
    if (key === 'guidelines-index' || key === 'root-guidelines-index' || key === 'workspace-guidelines-index') {
        const wanted = key === 'guidelines-index' ? undefined : key.slice(0, key.indexOf('-'));
        return levelIndexes(WsPaths.guidelineLevels())
            .filter((ix) => !wanted || ix.level === wanted)
            .map((ix) => withImports(ix.content, ix.file, values).trimEnd())
            .join('\n\n');
    }

    // ${guidelines-<name>} — one file of the guidelines: the workspace
    // folder's, else the root's, under either folder name; then the old
    // `_guidelines/<name>` fallback. Appends `.md` if the caller didn't.
    if (key.startsWith('guidelines-')) {
        const rawName = key.slice('guidelines-'.length);
        if (!rawName) { return ''; }
        const fileName = rawName.endsWith('.md') ? rawName : `${rawName}.md`;
        const found = listLevelFiles(WsPaths.guidelineLevels()).find((f) => f.path === fileName);
        const content = found ? injectFile(found.abs, values) : '';
        if (content) { return content; }
        const fallback = wsRoot ? path.join(wsRoot, '_guidelines') : '';
        return fallback ? injectFile(path.join(fallback, fileName), values) : '';
    }

    // ${role-<name>} — read a specific role file. Tries both the flat
    // layout (`_ai/roles/<name>.md`) and the folder layout
    // (`_ai/roles/<name>/role.md`), preferring the flat file when both exist.
    if (key.startsWith('role-')) {
        const rawName = key.slice('role-'.length);
        // Preserve the existing `${role-description}` behavior: that entry is
        // eagerly populated in addFileInjectionPlaceholders(), so it will have
        // already hit the static-map lookup before reaching here. We only
        // handle `role-<other-name>`.
        if (!rawName || rawName === 'description') { return undefined; }
        const rolesPath = values['rolesPath'] || (wsRoot ? path.join(wsRoot, '_ai', 'roles') : '');
        if (!rolesPath) { return ''; }
        const flat = injectFile(path.join(rolesPath, `${rawName}.md`), values);
        if (flat) { return flat; }
        return injectFile(path.join(rolesPath, rawName, 'role.md'), values);
    }

    // ${quest-<type>} — read the first file matching
    // <type>.<current quest>.* inside the current quest folder.
    if (key.startsWith('quest-')) {
        const rawType = key.slice('quest-'.length);
        // `${quest-description}` is eagerly populated elsewhere; fall through
        // to the static-map lookup for that one.
        if (!rawType || rawType === 'description') { return undefined; }
        const quest = values['quest'] || '';
        const questsPath = values['questsPath'] || (wsRoot ? path.join(wsRoot, '_ai', 'quests') : '');
        if (!quest || !questsPath) { return ''; }
        const dir = path.join(questsPath, quest);
        if (rawType === 'quest-notes') {
            // The quest's default notes file (utils/notesFiles.ts).
            return injectFile(defaultQuestNotesPath(dir), values);
        }
        const name = firstMatchingFile(dir, `${rawType}.${quest}.`);
        return name ? injectFile(path.join(dir, name), values) : '';
    }

    // ${file-<path>} — read an arbitrary workspace-relative or absolute file.
    // Absolute = starts with `/` or a Windows drive letter.
    if (key.startsWith('file-')) {
        const rawPath = key.slice('file-'.length);
        if (!rawPath) { return ''; }
        const isAbsolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath);
        const resolved = isAbsolute ? rawPath : (wsRoot ? path.join(wsRoot, rawPath) : rawPath);
        return injectFile(resolved, values);
    }

    // ${memory}         — the quest memory block (`_ai/quests/<quest>/memory/`): the curated
    //                     files, newest first, then this host's candidates
    // ${memory-quest}   — the same (kept for templates that name it)
    // ${memory-shared}  — resolves to nothing: the shared memory is gone (al_the_bear
    //                     ai_format_migration AC-18); an old template does not show the raw placeholder
    //
    // The budget (chars) is sourced from anthropic.memory.maxInjectedTokens
    // (token × 4). Drop the placeholder into either the profile system
    // prompt or a user-message template — wherever you want the block to
    // appear. When you put it in the user prompt, the (often long) system
    // prompt above stays byte-identical turn-to-turn, so prompt caching
    // keeps hitting.
    if (key === 'memory-shared') { return ''; }
    if (key === 'memory' || key === 'memory-quest') {
        return resolveMemoryPlaceholder(key, values);
    }

    return undefined;
}

/**
 * Compute a memory block for the `${memory*}` placeholders. Lazy-loads
 * TwoTierMemoryService to avoid a static circular dep with handler_shared.
 * Uses the current `${quest}` value (from the chat variables) and the
 * `anthropic.memory.maxInjectedTokens` setting as the char budget; falls
 * back to 3000 tokens when neither is configured.
 */
function resolveMemoryPlaceholder(
    key: 'memory' | 'memory-quest',
    values: Record<string, string>,
): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('./memory-service') as typeof import('../services/memory-service');
        // ...but that import path is wrong from this file's perspective.
        void mod;
    } catch { /* ignored — actual load below */ }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('../services/memory-service') as typeof import('../services/memory-service');
        const svc = mod.TwoTierMemoryService.instance;
        // Read the memory injection budget off the active config.
        let budgetTokens = 3000;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const handlerShared = require('../handlers/handler_shared') as typeof import('../handlers/handler_shared');
            const cfg = handlerShared.loadSendToChatConfig();
            const v = cfg?.anthropic?.memory?.maxInjectedTokens;
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0) { budgetTokens = v; }
        } catch { /* fallback stays */ }
        const quest = values['quest'] || values['chat.quest'] || '';
        // Profile-supplied memory suffix (e.g. 'gemma4'). When present,
        // restricts injection to `facts-<suffix>.md` and this host's
        // candidates meant for it. Passed in via `values.memorySuffix` by
        // the caller at send time; without it every curated file is offered.
        const memorySuffix = values['memorySuffix'] || undefined;
        // The quest memory is the only one, so `${memory}` and `${memory-quest}` are the same block.
        void key;
        return svc.injectForSystemPrompt(budgetTokens, quest || undefined, memorySuffix).text;
    } catch {
        return '';
    }
}

/**
 * Return the contents of the first file in `dir` whose basename starts with
 * `prefix`. Returns '' when the directory is missing or nothing matches.
 */
/** The name of the first file of `dir` whose name starts with `prefix`; undefined when none. */
function firstMatchingFile(dir: string, prefix: string): string | undefined {
    try {
        if (!dir || !fs.existsSync(dir)) { return undefined; }
        return fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isFile() && e.name.startsWith(prefix))?.name;
    } catch {
        return undefined;
    }
}

/**
 * A variable's value as a placeholder reads it: the map (exact, then any case),
 * then the dynamic namespaces (`date.*`, `env.*`, `chat.*`, …); undefined when
 * it has none. `${name}` and the `${{ … }}` expressions read variables alike.
 */
function lookupVariable(key: string, values: Record<string, string>, now: Date): string | undefined {
    if (key in values) { return values[key]; }
    const lk = key.toLowerCase();
    // Keys, not entries: reading every value would build the lazy blocks.
    for (const k of Object.keys(values)) {
        if (k.toLowerCase() === lk) { return values[k]; }
    }
    return resolveDynamicKey(key, values, now);
}

// ============================================================================
// Resolution pass
// ============================================================================

/**
 * A variable lookup as `${{ … }}` expressions read variables: the chat
 * variables and every placeholder `${name}` resolves, with `extra` over them
 * (aspect conditions, gsel20). The map is built once per call.
 */
export function variableLookup(extra: Record<string, string> = {}, options?: ResolveOptions): (name: string) => string | undefined {
    const values = { ...buildVariableMap(options), ...extra };
    const now = new Date();
    return (name) => lookupVariable(name, values, now);
}

/**
 * Perform a single resolution pass, replacing placeholders with values.
 *
 * Resolution order:
 *   1. ${{ expression }} placeholders (if enabled)
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

    const lookup = (key: string): string | undefined => lookupVariable(key, values, now);

    // 1. Evaluate ${{ expression }} placeholders
    if (options?.enableExpressions !== false) {
        result = forEachExpressionPlaceholder(result, (expr) => {
            try {
                return evaluateExpression(expr, lookup);
            } catch (e) {
                console.error(`[VariableResolver] expression error in $\{{ ${expr} }}: ${(e as Error).message}`);
                return '';
            }
        });
    }

    // 2. Replace ${key} dollar-brace patterns (an escaped `$${key}` stays as written)
    result = result.replace(/(?<!\$)\$\{([^{}]+)\}/g, (match, rawKey: string) => {
        const value = lookup(rawKey.trim());
        if (value !== undefined) { return value; }
        return unresolvedBehavior === 'keep' ? match : '';
    });

    return result;
}

// ============================================================================
// Public API
// ============================================================================

// A literal placeholder (`$${name}`): see placeholderEscape.ts.
export { unescapePlaceholders } from './placeholderEscape';

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
        enableExpressions: false,

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
<code>\${config.KEY}</code> – Any VS Code setting value<br>
<br>
<em>Workspace Folders:</em><br>
<code>\${workspaceFolder}</code> – The workspace folder (the window's first folder)<br>
<code>\${tomRoot}</code> – The root of the Tom workspace (the folder with .tom/tom_root.yaml; the workspace folder when standalone)<br>
<code>\${aiFolder}</code> – AI folder name (_ai)<br>
<code>\${guidelinesFolder}</code> – Guidelines folder name (_agent_guidelines; _copilot_guidelines is read too)<br>
<code>\${githubFolder}</code> – GitHub folder name (.github)<br>
<code>\${homeTomFolder}</code> – Home Tom folder name (.tom)<br>
<code>\${wsConfigFolder}</code> – Workspace config folder name (.tom)<br>
<code>\${aiPath}</code> – AI folder absolute path (the workspace folder's _ai, else the root's)<br>
<code>\${guidelinesPath}</code> – The workspace folder's guidelines folder, absolute (else the root's)<br>
<code>\${questsPath}</code> – Quests folder absolute path<br>
<code>\${workspaceQuests}</code> – The window's workspace quests, sorted, comma-separated: the list in _ai/workspaces/&lt;workspace&gt;.yaml, else the quests whose recorded workspace folder is this window's, else every quest<br>
<code>\${rolesPath}</code> – Roles folder absolute path<br>
<code>\${wsConfigPath}</code> – Config folder absolute path (the root's .tom)<br>
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
<code>\${custom.KEY}</code> – User-defined custom variable (set via Chat Variables Editor or an answer's response values)<br>
<code>\${KEY}</code> – Alias for custom/session variable keys when no built-in variable with that name exists<br>
Custom variables are created from two sources:<br>
&nbsp;&nbsp;1. <strong>Manually</strong> via the Chat Variables Editor "+ Add" button<br>
&nbsp;&nbsp;2. <strong>Automatically</strong> from an answer's <code>responseValues</code> — when a prompt queue answer<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;contains <code>"responseValues": {"key": "value"}</code>, each non-built-in key is stored<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;as <code>custom.key</code> in the persistent chat variables store.<br>
Custom variables persist across window reloads. Delete them via the Chat Variables Editor.<br>
<br>
<em>Chat Response Values (session-scoped):</em><br>
<code>\${chat.KEY}</code> – Also resolves response values from the current session's answers<br>
<code>\${custom.KEY}</code> / <code>\${KEY}</code> – Also available as aliases for non-built-in response values<br>
These are populated from the answers of queue items and chat sends.<br>
Session response values are <strong>not persisted</strong> across window reloads — they exist only for the current session.<br>
Use <code>#key=description</code> notation in prompts to request specific response values.<br>
<br>
<em>Composite Blocks:</em><br>
<code>\${chatVariables}</code> – All chat variables as a formatted JSON code block<br>
<code>\${contextInfo}</code> – All context settings as a formatted JSON code block ("not set" for empty values)<br>
<code>\${contextAndVariables}</code> – Both context info and chat variables blocks combined<br>
<br>
<em>Prompt Repetition (inner — current prompt/pre-prompt/follow-up only):</em><br>
<code>\${repeatCount}</code> – Total repeats configured for this stage (resolves from chat variables when configured as a name)<br>
<code>\${repeatIndex}</code> – 0-based index of the current repeat (0 on first send)<br>
<code>\${repeatNumber}</code> – 1-based counter of the current repeat (<code>\${repeatIndex} + 1</code>); use this in human-facing text like "Run 3 of 5"<br>
These also resolve inside <code>repeatPrefix</code> / <code>repeatSuffix</code> affixes.<br>
<br>
<em>Todo Iteration (main prompt only; repeat count entered as <code>prefix*</code>, e.g. <code>dsa*</code>):</em><br>
<code>\${repeatTodoId}</code> – Full id of the quest todo this dispatch is working on (e.g. <code>dsa7-review</code>)<br>
<code>\${repeatTodoTitle}</code> – That todo's title (its description when it has no title)<br>
Each dispatch takes the lowest-numbered <code>not-started</code> todo matching the prefix and marks it <code>in-progress</code>; <code>\${repeatNumber}</code> is the todo's own number. Both resolve to an empty string outside todo iteration.<br>
<br>
<em>Template Repetition (outer — whole pre-prompt → main → follow-up sequence):</em><br>
<code>\${templateRepeatCount}</code> – Total times the full template will replay<br>
<code>\${templateRepeatIndex}</code> – 0-based index of the current template replay<br>
<code>\${templateRepeatNumber}</code> – 1-based counter of the current template replay<br>
All three resolve to <code>0</code> / <code>1</code> when the item isn't part of a template-repeat cycle, so it's safe to reference them unconditionally.<br>
<br>
<em>File-Injection (inlines file contents; empty when the file does not exist):</em><br>
<code>\${role-description}</code> – <code>_ai/roles/\${role}/role.md</code><br>
<code>\${quest-description}</code> – <code>_ai/quests/\${quest}/overview.\${quest}.md</code><br>
<code>\${process-context}</code> – the active quest's process: where it is (phase, step, sub-step, iterations, roles), the post-gate todos and the descriptions; empty without a process<br>
<code>\${process}</code>, <code>\${phase}</code>, <code>\${step}</code>, <code>\${substep}</code>, <code>\${phase-iteration}</code>, <code>\${step-iteration}</code>, <code>\${substep-iteration}</code> – the quest's process state (<code>_ai/quests/\${quest}/config/process-state.\${quest}.yaml</code>)<br>
<code>\${process-description}</code> – <code>_ai/processes/\${process}/\${process}.md</code>; <code>\${phase-description}</code>, <code>\${step-description}</code>, <code>\${substep-description}</code> – from its <code>.process.yaml</code>; <code>\${phase-prompt}</code>, <code>\${step-prompt}</code>, <code>\${substep-prompt}</code> – their <code>prompt</code> fields; <code>\${session}</code> – the Agent SDK session the step runs in<br>
<code>\${claude.md}</code> – Workspace-root <code>CLAUDE.md</code><br>
<code>\${agents.md}</code> – <code>AGENTS.md</code><br>
<code>\${instructions}</code> – <code>CLAUDE.md</code> if present, else <code>AGENTS.md</code><br>
<code>\${agent-instructions}</code> – <code>CLAUDE.md</code> with the files it imports (else <code>AGENTS.md</code>)<br>
<code>\${copilot-instructions}</code> – deprecated: the same as <code>\${agent-instructions}</code><br>
<code>\${claudeMd}</code> – Every <code>CLAUDE.md</code> as Claude Code loads it: <code>~/.claude/CLAUDE.md</code>, the folder chain with <code>CLAUDE.local.md</code>, the <code>@imports</code> (for direct, Local LLM and VS Code LM profiles; the Agent SDK loads them itself)<br>
<code>\${guidelines-NAME}</code> – <code>NAME.md</code> of the guidelines: the workspace folder's, else the root's (<code>_agent_guidelines/</code> or <code>_copilot_guidelines/</code>; fallback: <code>_guidelines/NAME.md</code>). Omit or include <code>.md</code>. Example: <code>\${guidelines-project_guidelines}</code>.<br>
<code>\${guidelines-index}</code> – Both levels' guideline indexes, the root's first (<code>index_root.md</code>, <code>index_workspace.md</code>, each else its level's <code>index.md</code>); <code>\${root-guidelines-index}</code>, <code>\${workspace-guidelines-index}</code> – one level's<br>
<code>\${role-NAME}</code> – <code>_ai/roles/NAME.md</code> (fallback: <code>_ai/roles/NAME/role.md</code>). Example: <code>\${role-reviewer}</code>.<br>
<code>\${quest-TYPE}</code> – First file matching <code>_ai/quests/\${quest}/TYPE.\${quest}.*</code>. Example: <code>\${quest-overview}</code>, <code>\${quest-open_topics}</code>.<br>
<code>\${file-PATH}</code> – Inline any file; <code>PATH</code> is workspace-relative, or absolute when it starts with <code>/</code>. Example: <code>\${file-README.md}</code>, <code>\${file-/etc/hosts}</code>.<br>
<code>\${memory}</code> – The quest memory block (<code>_ai/quests/QUEST/memory/</code>): the curated files, newest first, then this host's candidates from the automatic extraction under their own heading. Char budget comes from <code>anthropic.memory.maxInjectedTokens</code> (× 4). Put this in the user-message template (preferred, so prompt caching on the system prompt keeps hitting) or directly in the system prompt.<br>
<code>\${memory-quest}</code> – The same as <code>\${memory}</code>.<br>
<br>
<em>Path variables support sub-properties:</em><br>
<code>\${KEY.name}</code> – Filename/basename without extension<br>
<code>\${KEY.extension}</code> – File extension including dot<br>
<br>
<em>Compaction &amp; Tool Trail (see <code>doc/llm_configuration.md</code>):</em><br>
The following placeholders are populated by the handler that drives the request. They are <strong>not</strong> automatically present in every template — they resolve to the empty string outside the contexts noted below.<br>
<br>
<code>\${compactedSummary}</code> – The quest's compacted history (<code>_ai/quests/QUEST/history/compacted_history.md</code>, built from every host's trail and the todo archive), the same for every session of the quest. Resolves inside the Anthropic profile's <code>userPromptWrapper</code> field. (On the wire, the summary is also injected automatically as a synthetic user/assistant pair between <code>rawTurns</code> and the current prompt, so you usually do <em>not</em> need to reference it explicitly.)<br>
<code>\${rawTurns}</code> – The most recent verbatim user/assistant turns kept inline, formatted as one block. Resolves inside the Anthropic profile's <code>userPromptWrapper</code>.<br>
<code>\${rawTurnCount}</code> – Number of raw turn messages currently kept (≤ <code>rawTurnsKept × 2</code>). Useful for guarding the surrounding markup, e.g. <code>\${{ rawTurnCount &gt; 0 ? "## Raw turns…" : "" }}</code>.<br>
<code>\${toolHistory}</code> – Compact YAML rendering of the last ~25 tool calls in the session ring buffer (key, time, round, tool, input, preview). Resolves inside the Anthropic profile's <code>systemPrompt</code> and inside user-message templates. Empty on the Agent SDK transport and on the first turn. Each line names a replay <code>key</code> that the model can pass to <code>tomAi_readPastToolResult({"key":"tX"})</code> to recover the full body.<br>
<br>
<em>Compaction-only placeholders</em> (resolve only inside the <code>compaction.templates[*].template</code> field — see the History Compaction editor for the inline help):<br>
<code>\${existingSummary}</code>, <code>\${lastTurn}</code>, <code>\${lastTurnCharCount}</code>, <code>\${maxHistoryTokens}</code>, <code>\${maxHistorySize}</code>, <code>\${historyMaxChars}</code>.<br>
<br>
<em>Memory-extraction-only placeholders</em> (resolve only inside the <code>compaction.memoryExtractionTemplates[*].template</code> field — see the Memory Extraction editor):<br>
<code>\${lastTurn}</code>, <code>\${compactedSummary}</code>, <code>\${existingMemory}</code>, <code>\${memoryFilePath}</code>, <code>\${memoryScope}</code>, <code>\${historyMaxChars}</code>, <code>\${memoryMaxChars}</code>.<br>
<br>
<em>Transport-retry-only placeholders</em> (resolve only inside the <code>anthropic.transportRetry.templates[*].template</code> field — see the Anthropic/LLM Transport Retry section of the Status page):<br>
<code>\${errorText}</code> – The error message from the failed Agent SDK attempt that triggered the retry. Inject this into the continuation prompt so the model knows what went wrong.<br>
<code>\${userMessage}</code> / <code>\${originalPrompt}</code> – The original user prompt text being retried.<br>
<br>
<em>Tool-trail retention contract:</em> within a single user turn, a tool result is cut to <code>toolTrailMaxResultChars</code> when it arrives and older rounds are replaced with a stub naming the replay key — without prompt caching every round past <code>toolTrailKeepRounds</code>, with caching in batches (once more than <code>toolTrailCollapseRounds</code> rounds or <code>toolTrailCollapseChars</code> characters are kept whole, down to <code>toolTrailKeepRounds</code>). Full bodies are persisted under <code>_ai/trail/&lt;subsystem&gt;/&lt;quest&gt;/tool_results/&lt;key&gt;.json</code> and are recoverable via <code>tomAi_readPastToolResult({"key":"tX"})</code>.<br>
<br>
<em>Expressions:</em><br>
<code>\${{expression}}</code> – Evaluate an expression at resolution time; its text is spliced into the template. The expression language is small and runs no JavaScript:<br>
<code>name</code> – a variable, read as <code>\${name}</code> reads it ('' when unset): <code>role-description</code>, <code>git.dirty</code>, <code>file.name</code>, <code>env.HOME</code>.<br>
<code>"text"</code> / <code>'text'</code> (escapes <code>\\n \\t \\" \\\\</code>), numbers, <code>true</code> / <code>false</code>.<br>
<code>a + b</code> – joins text. <code>a == b</code>, <code>a != b</code> – equal as text. <code>&lt; &lt;= &gt; &gt;=</code> – numeric when both are numbers, else text order.<br>
<code>a &amp;&amp; b</code>, <code>a || b</code>, <code>!a</code> – <code>a || b</code> is <code>a</code> when it is set, else <code>b</code>. <code>a ? b : c</code> – the conditional. Parentheses group.<br>
Helpers: <code>empty(a)</code>, <code>notEmpty(a)</code>, <code>lower(a)</code>, <code>upper(a)</code>, <code>default(a, b)</code>.<br>
A value is set when it is non-empty text, <code>true</code> or a non-zero number. Names start with a letter or <code>_</code> and may hold <code>.</code> and <code>-</code>; there is no arithmetic. A syntax error, or JavaScript such as <code>vars["x"]</code>, yields <code>""</code> and is logged; <code>npm run migrate:ai-formats</code> converts templates still in JavaScript.<br>
<br>
<em>Evaluation order:</em> <code>\${{ ... }}</code> runs <strong>before</strong> <code>\${...}</code> in each pass. The resolver loops up to 10 passes, so a <code>\${...}</code> value produced in pass 1 is visible to <code>\${{ ... }}</code> in pass 2.<br>
<br>
<em>Examples:</em><br>
<code>\${{ git.branch == "main" ? "PROD" : "DEV" }}</code><br>
<code>\${{ role-description ? "## Role\\n" + role-description : "" }}</code><br>
<code>\${{ default(file.name, "(no file)") }}</code><br>
<code>\${{ git.dirty == "true" ? " · uncommitted changes" : "" }}</code><br>
<br>
<em>Recursive resolution:</em> placeholders inside file-injection results are resolved on the next pass (max 10). A role.md file that contains <code>\${guidelines-coding_guidelines}</code> will have the guidelines text inlined automatically.<br>
<em>Imports:</em> in every injected file a line that is only <code>@&lt;path&gt;</code> (relative to that file, <code>~/…</code> or absolute) is replaced by that file, nested up to five levels, each file once; not in fenced code, and any other <code>@</code> stays.<br>
<br>
`;

/** `${workspaceQuests}`: the window's workspace quests, sorted, comma-separated; empty without `_ai` (02_wslayout-11). */
function workspaceQuestsValue(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const live = require('../services/aiWorkspaceLive') as typeof import('../services/aiWorkspaceLive');
        return [...(live.windowWorkspaceQuests()?.quests ?? [])].sort().join(', ');
    } catch {
        return '';
    }
}
