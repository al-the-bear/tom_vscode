/**
 * Queue File Storage — File-per-entry storage layer for prompt queue entries.
 *
 * Stores each queue entry and template as an individual YAML file
 * using the *.queue.yaml format (meta + prompt-queue).
 *
 * File naming conventions:
 *   - Queue entries:  `<hostname>_<workspace>_<YYMMDD_HHMMSS>_<quest-id>.<type>.entry.queue.yaml`
 *   - Templates:      `<name>.template.queue.yaml`
 *
 * Default folder: `${workspaceRoot}/_ai/queue/`
 * Configurable via: `tomAi.queueFolder` setting
 *
 * Single schema: `queue-entry.schema.json` — used for both entries and templates.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WsPaths } from '../utils/workspacePaths.js';
import { debugLog } from '../utils/debugLogger.js';
import { buildQueueEntryFileName, sanitizeHostnameForFile } from '../utils/queueStep5Utils.js';
import { getWorkspaceName } from '../utils/panelYamlStore.js';

// ============================================================================
// Constants
// ============================================================================

/** File extension for queue entry files. */
const ENTRY_SUFFIX = '.entry.queue.yaml';

/** File extension for template files. */
const TEMPLATE_SUFFIX = '.template.queue.yaml';

/** Filename for queue settings (stored in queue folder). */
const QUEUE_SETTINGS_FILE = 'queue-settings.yaml';

/** Single schema path — used for both entries and templates. */
const SCHEMA_REL = '../../_ai/schemas/yaml/queue-entry.schema.json';

/** Maximum number of sent entries to keep on disk. */
const MAX_SENT_ON_DISK = 50;

/** Maximum total entries on disk. */
const MAX_TOTAL_ON_DISK = 100;

/** Debug flag for this module. */
let QUEUE_STORAGE_DEBUG = false;

export function setQueueStorageDebug(enabled: boolean): void {
    QUEUE_STORAGE_DEBUG = enabled;
}

// ============================================================================
// Types — queue.yaml schema (meta + prompt-queue)
// ============================================================================

/** Reminder configuration, shared between prompts and follow-ups. */
export interface QueueReminderConfig {
    enabled?: boolean;
    'template-id'?: string;
    'timeout-minutes'?: number;
    repeat?: boolean;
    'sent-count'?: number;
    'last-sent-at'?: string | null;
    queued?: boolean;
}

/** Execution state tracked at runtime. */
export interface QueueExecutionState {
    'request-id'?: string | null;
    'expected-request-id'?: string | null;
    'sent-at'?: string | null;
    error?: string | null;
    'follow-up-index'?: number;
}

/** Reference to another prompt (string ID or external file ref). */
export type QueuePromptRef = string | { file: string; 'prompt-id'?: string };

/** A single prompt within a queue file. */
export interface QueuePromptYaml {
    id: string;
    name?: string;
    type: 'main' | 'followup' | 'preprompt' | 'gate' | 'decision';
    'prompt-text'?: string;
    'expanded-text'?: string;
    file?: string;
    template?: string;
    'answer-template'?: string;
    'answer-wrapper'?: boolean;
    'repeat-count'?: number;
    'repeat-index'?: number;
    'repeat-prefix'?: string;
    'repeat-suffix'?: string;
    'answer-wait-minutes'?: number;
    'llm-profile'?: string;
    reminder?: QueueReminderConfig;
    'gate-ref'?: string;
    'pre-prompt-refs'?: QueuePromptRef[];
    'follow-up-refs'?: QueuePromptRef[];
    'gate-condition'?: string;
    'case-expression'?: string;
    'case-mapping'?: Array<{ value: string; 'prompt-ref': QueuePromptRef }>;
    'case-reminder-ref'?: QueuePromptRef;
    metadata?: Record<string, unknown>;
    execution?: QueueExecutionState;
}

/** File-level metadata block. Allows arbitrary additional properties. */
export interface QueueMetaYaml {
    id: string;
    name?: string;
    description?: string;
    'main-prompt'?: string;
    imports?: string[];
    quest?: string;
    status?: 'staged' | 'pending' | 'sending' | 'sent' | 'error';
    collapsed?: boolean;
    'template-name'?: string;
    category?: 'prompt' | 'answer' | 'system';
    'show-in-menu'?: boolean;
    created?: string;
    updated?: string;
    /** Additional metadata attributes. */
    [key: string]: unknown;
}

/** Top-level queue.yaml document structure. */
export interface QueueFileYaml {
    meta: QueueMetaYaml;
    'prompt-queue': QueuePromptYaml[];
}

/** File info including parsed content and path metadata. */
export interface QueueEntryFile {
    /** Absolute file path. */
    filePath: string;
    /** File name only (no directory). */
    fileName: string;
    /** Entry ID derived from the filename (without suffix). */
    entryId: string;
    /** Parsed YAML document. */
    doc: QueueFileYaml;
}

/** Template file info. */
export interface QueueTemplateFile {
    filePath: string;
    fileName: string;
    templateId: string;
    data: QueueFileYaml;
}

// ============================================================================
// Folder Resolution
// ============================================================================

/**
 * Get the queue folder path. Uses:
 * 1. `tomAi.queueFolder` setting (absolute or workspace-relative)
 * 2. Fallback: `${wsRoot}/_ai/queue/`
 */
export function getQueueFolder(): string | undefined {
    const wsRoot = WsPaths.wsRoot;
    if (!wsRoot) return undefined;

    const configured = vscode.workspace.getConfiguration('tomAi').get<string>('queueFolder');
    if (configured && configured.trim()) {
        const trimmed = configured.trim();
        if (path.isAbsolute(trimmed)) return trimmed;
        return path.join(wsRoot, trimmed);
    }

    return WsPaths.ai('queue');
}

/**
 * Ensure the queue folder exists, creating it if needed.
 */
export function ensureQueueFolder(): string | undefined {
    const folder = getQueueFolder();
    if (!folder) return undefined;
    if (!fs.existsSync(folder)) {
        try {
            fs.mkdirSync(folder, { recursive: true });
            if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Created queue folder: ${folder}`, 'INFO', 'queueStorage');
        } catch (err) {
            debugLog(`[QueueStorage] Failed to create queue folder: ${err}`, 'ERROR', 'queueStorage');
            return undefined;
        }
    }
    return folder;
}

// ============================================================================
// Queue Settings Persistence
// ============================================================================

/** Queue-level settings persisted to disk. */
export interface QueueReloadAfterReloadSetting {
    enabled?: boolean;
    prompt?: string;
}

const QUEUE_SCOPE_WORKSPACE = '__workspace__';

export interface QueueSettings {
    'response-timeout-minutes'?: number;
    'default-reminder-template-id'?: string;
    'auto-send-enabled'?: boolean;
    'auto-start-enabled'?: boolean;
    'auto-pause-enabled'?: boolean;
    'auto-continue-enabled'?: boolean;
    'reload-prompt-by-scope'?: Record<string, QueueReloadAfterReloadSetting>;
}

export function getQueueSettingsScopeKey(questId?: string): string {
    const quest = (questId || '').trim();
    return quest ? `quest:${quest}` : QUEUE_SCOPE_WORKSPACE;
}

export function getQueueReloadAfterReloadSetting(
    settings: QueueSettings | undefined,
    questId?: string,
): QueueReloadAfterReloadSetting {
    const byScope = settings?.['reload-prompt-by-scope'];
    if (!byScope || typeof byScope !== 'object') {
        return {};
    }

    const direct = byScope[getQueueSettingsScopeKey(questId)];
    if (direct && typeof direct === 'object') {
        return {
            enabled: direct.enabled === true,
            prompt: typeof direct.prompt === 'string' ? direct.prompt : '',
        };
    }

    // Quest-specific settings fall back to workspace-level defaults.
    if (questId) {
        const fallback = byScope[QUEUE_SCOPE_WORKSPACE];
        if (fallback && typeof fallback === 'object') {
            return {
                enabled: fallback.enabled === true,
                prompt: typeof fallback.prompt === 'string' ? fallback.prompt : '',
            };
        }
    }

    return {};
}

export function setQueueReloadAfterReloadSetting(
    settings: QueueSettings,
    questId: string | undefined,
    value: QueueReloadAfterReloadSetting,
): QueueSettings {
    const byScope = {
        ...(settings['reload-prompt-by-scope'] || {}),
    };

    byScope[getQueueSettingsScopeKey(questId)] = {
        enabled: value.enabled === true,
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
    };

    return {
        ...settings,
        'reload-prompt-by-scope': byScope,
    };
}

/**
 * Read queue settings from the settings file.
 * Returns undefined if file doesn't exist or can't be parsed.
 */
export function readQueueSettings(): QueueSettings | undefined {
    try {
        const folder = getQueueFolder();
        if (!folder) return undefined;
        const settingsPath = path.join(folder, QUEUE_SETTINGS_FILE);
        if (!fs.existsSync(settingsPath)) return undefined;
        const content = fs.readFileSync(settingsPath, 'utf8');
        const yaml = requireYaml();
        const raw = yaml.parse(content);
        if (typeof raw !== 'object' || raw === null) return undefined;
        return raw as QueueSettings;
    } catch (err) {
        debugLog(`[QueueStorage] Failed to read queue settings: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Write queue settings to the settings file.
 */
export function writeQueueSettings(settings: QueueSettings): boolean {
    try {
        const folder = ensureQueueFolder();
        if (!folder) return false;
        const settingsPath = path.join(folder, QUEUE_SETTINGS_FILE);
        const yaml = requireYaml();
        const existing = readQueueSettings() || {};
        const merged: QueueSettings = {
            ...existing,
            ...settings,
        };
        const content = yaml.stringify(merged, { lineWidth: 120 });
        fs.writeFileSync(settingsPath, content, 'utf8');
        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Wrote queue settings`, 'INFO', 'queueStorage');
        return true;
    } catch (err) {
        debugLog(`[QueueStorage] Failed to write queue settings: ${err}`, 'ERROR', 'queueStorage');
        return false;
    }
}

// ============================================================================
// File Naming
// ============================================================================

/**
 * Generate a queue entry filename.
 * Format: `<hostname>_<workspace>_<YYMMDD_HHMMSS>_<quest>.<type>.entry.queue.yaml`
 */
export function generateEntryFileName(
    quest?: string,
    type?: string,
    timestamp?: Date,
): string {
    return buildQueueEntryFileName({
        hostname: os.hostname(),
        workspaceName: getWorkspaceName(),
        timestamp: timestamp || new Date(),
        quest: quest || 'default',
        type: type || 'prompt',
        entrySuffix: ENTRY_SUFFIX,
    });
}

/**
 * Generate a template filename.
 * Format: `<name>.template.queue.yaml`
 */
export function generateTemplateFileName(name: string): string {
    return `${sanitizeFilePart(name)}${TEMPLATE_SUFFIX}`;
}

/**
 * Extract entry ID from a filename (strip suffix).
 */
export function entryIdFromFileName(fileName: string): string {
    if (fileName.endsWith(ENTRY_SUFFIX)) {
        return fileName.slice(0, -ENTRY_SUFFIX.length);
    }
    return fileName;
}

/**
 * Extract template ID from a filename (strip suffix).
 */
export function templateIdFromFileName(fileName: string): string {
    if (fileName.endsWith(TEMPLATE_SUFFIX)) {
        return fileName.slice(0, -TEMPLATE_SUFFIX.length);
    }
    return fileName;
}

/** Sanitize a string for use in filenames. */
function sanitizeFilePart(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

// ============================================================================
// Entry CRUD
// ============================================================================

/**
 * Write a queue entry to disk.
 *
 * @param entryId Entry ID (used as base filename)
 * @param doc The queue file document
 * @param fileName Optional specific filename to use
 * @returns The absolute file path written, or undefined on failure
 */
export function writeEntry(
    entryId: string,
    doc: QueueFileYaml,
    fileName?: string,
): string | undefined {
    try {
        const folder = ensureQueueFolder();
        if (!folder) return undefined;

        const fname = fileName || (entryId + ENTRY_SUFFIX);
        const filePath = path.join(folder, fname);

        doc.meta.updated = new Date().toISOString();
        if (!doc.meta.created) doc.meta.created = doc.meta.updated;

        const yaml = requireYaml();
        const schemaLine = `# yaml-language-server: $schema=${SCHEMA_REL}\n`;
        const content = schemaLine + yaml.stringify(doc, { lineWidth: 120 });

        fs.writeFileSync(filePath, content, 'utf-8');
        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Wrote entry: ${fname}`, 'INFO', 'queueStorage');
        return filePath;
    } catch (err) {
        debugLog(`[QueueStorage] writeEntry error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Read a single queue entry from disk.
 * Only accepts new format (meta + prompt-queue). Old format files are ignored.
 */
export function readEntry(filePath: string): QueueEntryFile | undefined {
    try {
        if (!fs.existsSync(filePath)) return undefined;
        const content = fs.readFileSync(filePath, 'utf-8');
        const yaml = requireYaml();
        const raw = yaml.parse(content);
        if (!raw || !isQueueFileYaml(raw)) return undefined;

        const fileName = path.basename(filePath);
        const entryId = entryIdFromFileName(fileName);
        const doc: QueueFileYaml = raw;

        return { filePath, fileName, entryId, doc };
    } catch (err) {
        debugLog(`[QueueStorage] readEntry error for ${filePath}: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Read all queue entries from the queue folder.
 * Sorted by filename (timestamp-based, oldest first).
 */
export function readAllEntries(): QueueEntryFile[] {
    try {
        const folder = getQueueFolder();
        if (!folder || !fs.existsSync(folder)) return [];

        const entries: QueueEntryFile[] = [];
        const hostPrefix = `${sanitizeHostnameForFile(os.hostname())}_`;
        const wsName = getWorkspaceName().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        const fullPrefix = `${hostPrefix}${wsName}_`;
        const files = fs
            .readdirSync(folder)
            .filter(f => f.endsWith(ENTRY_SUFFIX) && f.startsWith(fullPrefix))
            .sort();

        for (const fileName of files) {
            const entry = readEntry(path.join(folder, fileName));
            if (entry) entries.push(entry);
        }

        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] readAllEntries: found ${entries.length} entries`, 'INFO', 'queueStorage');
        return entries;
    } catch (err) {
        debugLog(`[QueueStorage] readAllEntries error: ${err}`, 'ERROR', 'queueStorage');
        return [];
    }
}

/**
 * Delete a queue entry file from disk.
 */
export function deleteEntry(entryId: string): boolean {
    try {
        const folder = getQueueFolder();
        if (!folder) return false;

        // Try exact match first
        const exactPath = path.join(folder, entryId + ENTRY_SUFFIX);
        if (fs.existsSync(exactPath)) {
            fs.unlinkSync(exactPath);
            if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Deleted entry: ${entryId}`, 'INFO', 'queueStorage');
            return true;
        }

        // Search by entryId prefix
        const files = fs.readdirSync(folder).filter(f => f.endsWith(ENTRY_SUFFIX));
        for (const f of files) {
            if (entryIdFromFileName(f) === entryId) {
                fs.unlinkSync(path.join(folder, f));
                if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Deleted entry by scan: ${f}`, 'INFO', 'queueStorage');
                return true;
            }
        }

        return false;
    } catch (err) {
        debugLog(`[QueueStorage] deleteEntry error: ${err}`, 'ERROR', 'queueStorage');
        return false;
    }
}

/**
 * Find an entry file by its entryId.
 */
export function findEntryById(entryId: string): QueueEntryFile | undefined {
    const folder = getQueueFolder();
    if (!folder || !fs.existsSync(folder)) return undefined;

    // Direct file
    const directPath = path.join(folder, entryId + ENTRY_SUFFIX);
    if (fs.existsSync(directPath)) {
        return readEntry(directPath);
    }

    // Scan
    const files = fs.readdirSync(folder).filter(f => f.endsWith(ENTRY_SUFFIX));
    for (const f of files) {
        if (entryIdFromFileName(f) === entryId) {
            return readEntry(path.join(folder, f));
        }
    }
    return undefined;
}

/**
 * Trim old sent entries to keep disk usage bounded.
 */
export function trimSentEntries(): void {
    try {
        const entries = readAllEntries();
        const sent = entries.filter(e => e.doc.meta.status === 'sent');

        if (sent.length <= MAX_SENT_ON_DISK) return;

        // Remove oldest sent entries
        const toRemove = sent.slice(0, sent.length - MAX_SENT_ON_DISK);
        for (const entry of toRemove) {
            try {
                fs.unlinkSync(entry.filePath);
                if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Trimmed sent entry: ${entry.fileName}`, 'INFO', 'queueStorage');
            } catch { /* ignore */ }
        }

        // Check total count
        const remaining = readAllEntries();
        if (remaining.length > MAX_TOTAL_ON_DISK) {
            const sentRemaining = remaining.filter(e => e.doc.meta.status === 'sent');
            const excess = remaining.length - MAX_TOTAL_ON_DISK;
            const removable = sentRemaining.slice(0, Math.min(excess, sentRemaining.length));
            for (const entry of removable) {
                try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ }
            }
        }
    } catch (err) {
        debugLog(`[QueueStorage] trimSentEntries error: ${err}`, 'ERROR', 'queueStorage');
    }
}

// ============================================================================
// Template CRUD
// ============================================================================

/**
 * Write a template to disk.
 */
export function writeTemplate(
    templateId: string,
    data: QueueFileYaml,
): string | undefined {
    try {
        const folder = ensureQueueFolder();
        if (!folder) return undefined;

        const fname = generateTemplateFileName(templateId);
        const filePath = path.join(folder, fname);

        data.meta.updated = new Date().toISOString();
        if (!data.meta.created) data.meta.created = data.meta.updated;

        const yaml = requireYaml();
        const schemaLine = `# yaml-language-server: $schema=${SCHEMA_REL}\n`;
        const content = schemaLine + yaml.stringify(data, { lineWidth: 120 });

        fs.writeFileSync(filePath, content, 'utf-8');
        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Wrote template: ${fname}`, 'INFO', 'queueStorage');
        return filePath;
    } catch (err) {
        debugLog(`[QueueStorage] writeTemplate error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Read a template from disk by ID.
 */
export function readTemplate(templateId: string): QueueTemplateFile | undefined {
    try {
        const folder = getQueueFolder();
        if (!folder) return undefined;

        const fname = generateTemplateFileName(templateId);
        const filePath = path.join(folder, fname);
        if (!fs.existsSync(filePath)) return undefined;

        const content = fs.readFileSync(filePath, 'utf-8');
        const yaml = requireYaml();
        const raw = yaml.parse(content);
        if (!raw || !isQueueFileYaml(raw)) return undefined;

        return { filePath, fileName: fname, templateId, data: raw };
    } catch (err) {
        debugLog(`[QueueStorage] readTemplate error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Read all templates from the queue folder.
 */
export function readAllTemplates(): QueueTemplateFile[] {
    try {
        const folder = getQueueFolder();
        if (!folder || !fs.existsSync(folder)) return [];

        const templates: QueueTemplateFile[] = [];
        const files = fs.readdirSync(folder).filter(f => f.endsWith(TEMPLATE_SUFFIX)).sort();

        for (const fileName of files) {
            try {
                const filePath = path.join(folder, fileName);
                const content = fs.readFileSync(filePath, 'utf-8');
                const yaml = requireYaml();
                const raw = yaml.parse(content);
                if (!raw || !isQueueFileYaml(raw)) continue;

                const templateId = templateIdFromFileName(fileName);
                templates.push({ filePath, fileName, templateId, data: raw });
            } catch { /* skip invalid templates */ }
        }

        return templates;
    } catch (err) {
        debugLog(`[QueueStorage] readAllTemplates error: ${err}`, 'ERROR', 'queueStorage');
        return [];
    }
}

/**
 * Delete a template from disk.
 */
export function deleteTemplate(templateId: string): boolean {
    try {
        const folder = getQueueFolder();
        if (!folder) return false;

        const fname = generateTemplateFileName(templateId);
        const filePath = path.join(folder, fname);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Deleted template: ${templateId}`, 'INFO', 'queueStorage');
            return true;
        }
        return false;
    } catch (err) {
        debugLog(`[QueueStorage] deleteTemplate error: ${err}`, 'ERROR', 'queueStorage');
        return false;
    }
}

// ============================================================================
// File Watcher
// ============================================================================

let _entryWatcher: vscode.FileSystemWatcher | undefined;
const _changeListeners: Array<() => void> = [];

/**
 * Start watching the queue folder for changes.
 * Fires listeners when entries are created, changed, or deleted.
 */
export function startWatching(): void {
    if (_entryWatcher) return;

    const folder = getQueueFolder();
    if (!folder) return;

    const hostPrefix = `${sanitizeHostnameForFile(os.hostname())}_`;
    const wsName = getWorkspaceName().replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fullPrefix = `${hostPrefix}${wsName}_`;
    const pattern = new vscode.RelativePattern(folder, `${fullPrefix}*${ENTRY_SUFFIX}`);
    _entryWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const notify = (): void => {
        for (const listener of _changeListeners) {
            try { listener(); } catch { /* swallow */ }
        }
    };

    _entryWatcher.onDidCreate(notify);
    _entryWatcher.onDidChange(notify);
    _entryWatcher.onDidDelete(notify);

    if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Started watching: ${folder}`, 'INFO', 'queueStorage');
}

/**
 * Stop watching the queue folder.
 */
export function stopWatching(): void {
    if (_entryWatcher) {
        _entryWatcher.dispose();
        _entryWatcher = undefined;
        if (QUEUE_STORAGE_DEBUG) debugLog('[QueueStorage] Stopped watching', 'INFO', 'queueStorage');
    }
}

/**
 * Register a listener for queue file changes.
 * Returns a disposable to unregister.
 */
export function onQueueChanged(listener: () => void): vscode.Disposable {
    _changeListeners.push(listener);
    return new vscode.Disposable(() => {
        const idx = _changeListeners.indexOf(listener);
        if (idx >= 0) _changeListeners.splice(idx, 1);
    });
}

// ============================================================================
// Helpers
// ============================================================================

/** Type guard: check if a parsed YAML object matches the queue.yaml schema. */
function isQueueFileYaml(data: unknown): data is QueueFileYaml {
    return !!data && typeof data === 'object' && 'meta' in data && 'prompt-queue' in data;
}

/** Generate a unique ID. */
export function generateId(): string {
    return 'e-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================================================
// YAML import helper
// ============================================================================

let _yamlModule: typeof import('yaml') | undefined;

function requireYaml(): typeof import('yaml') {
    if (!_yamlModule) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _yamlModule = require('yaml');
    }
    return _yamlModule!;
}
