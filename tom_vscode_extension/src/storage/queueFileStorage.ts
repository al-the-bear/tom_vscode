/**
 * Queue File Storage — File-per-entry storage layer for prompt queue entries.
 *
 * Replaces the monolithic panelYamlStore-based queue storage with
 * individual YAML files in a configurable queue folder.
 *
 * File naming conventions:
 *   - Queue entries:  `<YYMMDD_HHMM>_<quest-id>.<type>.entry.queue.yaml`
 *   - Templates:      `<name>.template.queue.yaml`
 *
 * Default folder: `${workspaceRoot}/_ai/queue/`
 * Configurable via: `tomAi.queueFolder` setting
 *
 * Features:
 *   - Each queue entry is a separate YAML file
 *   - Shared between windows working on the same quest
 *   - File watcher for cross-window synchronisation
 *   - Schema validation via JSON schema reference
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WsPaths } from '../utils/workspacePaths.js';
import { debugLog } from '../utils/debugLogger.js';

// ============================================================================
// Constants
// ============================================================================

/** File extension for queue entry files. */
const ENTRY_SUFFIX = '.entry.queue.yaml';

/** File extension for template files. */
const TEMPLATE_SUFFIX = '.template.queue.yaml';

/** Relative schema path for entry files. */
const ENTRY_SCHEMA_REL = '../../_ai/schemas/yaml/queue-entry.schema.json';

/** Relative schema path for template files. */
const TEMPLATE_SCHEMA_REL = '../../_ai/schemas/yaml/queue-template.schema.json';

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
// Types — New queue.yaml schema (meta + prompt-queue)
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

/** File-level metadata block. */
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

// --- Legacy types kept for backward compat / migration ---

/** @deprecated Use QueueFileYaml instead. Old flat entry format. */
export interface QueueEntryYaml {
    type: 'prompt' | 'timed' | 'reminder';
    quest?: string;
    created: string;
    updated?: string;
    status: 'staged' | 'pending' | 'sending' | 'sent' | 'error';
    prompt: {
        text: string;
        'expanded-text'?: string;
        template?: string;
        'answer-wrapper'?: boolean;
    };
    reminder?: QueueReminderConfig;
    'pre-prompts'?: Array<{
        text: string;
        template?: string;
        status?: 'pending' | 'sent' | 'error';
    }>;
    'follow-ups'?: Array<{
        id: string;
        text: string;
        template?: string;
        reminder?: QueueReminderConfig;
        created?: string;
    }>;
    execution?: QueueExecutionState;
}

/** File info including parsed content and path metadata. */
export interface QueueEntryFile {
    /** Absolute file path. */
    filePath: string;
    /** File name only (no directory). */
    fileName: string;
    /** Entry ID derived from the filename (without suffix). */
    entryId: string;
    /** Parsed YAML content (new format). */
    data: QueueEntryYaml;
    /** New-format document (always populated). */
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
// File Naming
// ============================================================================

/**
 * Generate a queue entry filename.
 * Format: `<YYMMDD_HHMM>_<quest>.<type>.entry.queue.yaml`
 *
 * @param quest Quest ID (defaults to 'default')
 * @param type Entry type (defaults to 'prompt')
 * @param timestamp Optional specific timestamp
 */
export function generateEntryFileName(
    quest?: string,
    type?: string,
    timestamp?: Date,
): string {
    const now = timestamp || new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const q = sanitizeFilePart(quest || 'default');
    const t = sanitizeFilePart(type || 'prompt');
    return `${yy}${mm}${dd}_${hh}${min}${ss}_${q}.${t}${ENTRY_SUFFIX}`;
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
// Conversion Helpers — Old flat format ↔ New meta+prompt-queue format
// ============================================================================

/**
 * Convert old flat QueueEntryYaml → new QueueFileYaml.
 */
export function entryYamlToFileYaml(old: QueueEntryYaml, entryId: string): QueueFileYaml {
    const mainPrompt: QueuePromptYaml = {
        id: 'P1',
        name: 'Main Prompt',
        type: 'main',
        'prompt-text': old.prompt?.text || '',
        'expanded-text': old.prompt?.['expanded-text'],
        template: old.prompt?.template,
        'answer-wrapper': old.prompt?.['answer-wrapper'],
        reminder: old.reminder,
        execution: old.execution,
    };

    const prompts: QueuePromptYaml[] = [mainPrompt];

    // Convert pre-prompts
    if (old['pre-prompts'] && old['pre-prompts'].length > 0) {
        const preRefs: string[] = [];
        old['pre-prompts'].forEach((pp, idx) => {
            const ppId = `pre-${idx + 1}`;
            preRefs.push(ppId);
            prompts.push({
                id: ppId,
                type: 'preprompt',
                'prompt-text': pp.text,
                template: pp.template,
                execution: pp.status ? { 'sent-at': pp.status === 'sent' ? new Date().toISOString() : null, error: pp.status === 'error' ? 'error' : null } : undefined,
            });
        });
        mainPrompt['pre-prompt-refs'] = preRefs;
    }

    // Convert follow-ups
    if (old['follow-ups'] && old['follow-ups'].length > 0) {
        const fuRefs: string[] = [];
        old['follow-ups'].forEach(fu => {
            const fuId = fu.id || `fu-${fuRefs.length + 1}`;
            fuRefs.push(fuId);
            prompts.push({
                id: fuId,
                type: 'followup',
                'prompt-text': fu.text,
                template: fu.template,
                reminder: fu.reminder,
            });
        });
        mainPrompt['follow-up-refs'] = fuRefs;
    }

    return {
        meta: {
            id: entryId,
            quest: old.quest,
            status: old.status,
            created: old.created,
            updated: old.updated,
            'main-prompt': 'P1',
        },
        'prompt-queue': prompts,
    };
}

/**
 * Convert new QueueFileYaml → legacy QueueEntryYaml (for backward compat with manager).
 */
export function fileYamlToEntryYaml(doc: QueueFileYaml): QueueEntryYaml {
    const mainId = doc.meta['main-prompt'] || 'P1';
    const main = doc['prompt-queue'].find(p => p.id === mainId) || doc['prompt-queue'].find(p => p.type === 'main') || doc['prompt-queue'][0];

    const result: QueueEntryYaml = {
        type: 'prompt',
        quest: doc.meta.quest as string | undefined,
        created: (doc.meta.created as string) || new Date().toISOString(),
        updated: doc.meta.updated as string | undefined,
        status: (doc.meta.status as QueueEntryYaml['status']) || 'staged',
        prompt: {
            text: main?.['prompt-text'] || '',
            'expanded-text': main?.['expanded-text'],
            template: main?.template,
            'answer-wrapper': main?.['answer-wrapper'],
        },
        reminder: main?.reminder,
        execution: main?.execution,
    };

    // Reconstruct pre-prompts
    const preRefs = main?.['pre-prompt-refs'] || [];
    if (preRefs.length > 0) {
        result['pre-prompts'] = preRefs.map(ref => {
            const refId = typeof ref === 'string' ? ref : undefined;
            const pp = refId ? doc['prompt-queue'].find(p => p.id === refId) : undefined;
            return {
                text: pp?.['prompt-text'] || '',
                template: pp?.template,
                status: pp?.execution?.['sent-at'] ? 'sent' as const : (pp?.execution?.error ? 'error' as const : 'pending' as const),
            };
        });
    }

    // Reconstruct follow-ups
    const fuRefs = main?.['follow-up-refs'] || [];
    if (fuRefs.length > 0) {
        result['follow-ups'] = fuRefs.map(ref => {
            const refId = typeof ref === 'string' ? ref : undefined;
            const fu = refId ? doc['prompt-queue'].find(p => p.id === refId) : undefined;
            return {
                id: refId || generateId(),
                text: fu?.['prompt-text'] || '',
                template: fu?.template,
                reminder: fu?.reminder,
                created: fu?.metadata?.created as string | undefined,
            };
        });
    }

    return result;
}

/**
 * Detect whether a parsed YAML object is in the new `meta + prompt-queue` format
 * or the old flat format.
 */
function isNewFormat(data: unknown): data is QueueFileYaml {
    return !!data && typeof data === 'object' && 'meta' in data && 'prompt-queue' in data;
}

// ============================================================================
// Entry CRUD
// ============================================================================

/**
 * Write a queue entry to disk in the new meta+prompt-queue format.
 *
 * @param entryId Entry ID (used as base filename)
 * @param data The entry data (legacy format — converted automatically)
 * @param fileName Optional specific filename to use
 * @param doc Optional new-format document (takes priority over data)
 * @returns The absolute file path written, or undefined on failure
 */
export function writeEntry(
    entryId: string,
    data: QueueEntryYaml,
    fileName?: string,
    doc?: QueueFileYaml,
): string | undefined {
    try {
        const folder = ensureQueueFolder();
        if (!folder) return undefined;

        const fname = fileName || (entryId + ENTRY_SUFFIX);
        const filePath = path.join(folder, fname);

        // Convert to new format if doc not provided
        const document = doc || entryYamlToFileYaml(data, entryId);
        document.meta.updated = new Date().toISOString();
        // Sync status from data to meta
        if (data.status) document.meta.status = data.status;

        const yaml = requireYaml();
        const schemaLine = `# yaml-language-server: $schema=${ENTRY_SCHEMA_REL}\n`;
        const content = schemaLine + yaml.stringify(document, { lineWidth: 120 });

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
 * Handles both new format (meta+prompt-queue) and legacy flat format.
 */
export function readEntry(filePath: string): QueueEntryFile | undefined {
    try {
        if (!fs.existsSync(filePath)) return undefined;
        const content = fs.readFileSync(filePath, 'utf-8');
        const yaml = requireYaml();
        const raw = yaml.parse(content);
        if (!raw) return undefined;

        const fileName = path.basename(filePath);
        const entryId = entryIdFromFileName(fileName);

        let doc: QueueFileYaml;
        let data: QueueEntryYaml;

        if (isNewFormat(raw)) {
            // New format
            doc = raw;
            data = fileYamlToEntryYaml(doc);
        } else if (raw.prompt) {
            // Legacy flat format — convert
            data = raw as QueueEntryYaml;
            doc = entryYamlToFileYaml(data, entryId);
        } else {
            return undefined;
        }

        return { filePath, fileName, entryId, data, doc };
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
        const files = fs.readdirSync(folder).filter(f => f.endsWith(ENTRY_SUFFIX)).sort();

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
        const sent = entries.filter(e => e.data.status === 'sent');

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
            const sentRemaining = remaining.filter(e => e.data.status === 'sent');
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
 * Write a template to disk in the new meta+prompt-queue format.
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
        const schemaLine = `# yaml-language-server: $schema=${TEMPLATE_SCHEMA_REL}\n`;
        const content = schemaLine + yaml.stringify(data, { lineWidth: 120 });

        fs.writeFileSync(filePath, content, 'utf-8');
        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Wrote template: ${fname}`, 'INFO', 'queueStorage');
        return filePath;
    } catch (err) {
        debugLog(`[QueueStorage] writeTemplate error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}
    }
}

/**
 * Read a template from disk by ID. Handles new and legacy formats.
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
        if (!raw) return undefined;

        let doc: QueueFileYaml;
        if (isNewFormat(raw)) {
            doc = raw;
        } else if (raw.name && raw.template) {
            // Legacy template format — convert to new
            doc = convertLegacyTemplate(raw, templateId);
        } else {
            return undefined;
        }

        return { filePath, fileName: fname, templateId, data: doc };
    } catch (err) {
        debugLog(`[QueueStorage] readTemplate error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

/**
 * Convert a legacy QueueTemplateYaml to the new QueueFileYaml format.
 */
function convertLegacyTemplate(old: Record<string, unknown>, templateId: string): QueueFileYaml {
    return {
        meta: {
            id: templateId,
            name: String(old.name || templateId),
            description: old.description ? String(old.description) : undefined,
            'template-name': templateId,
            category: (old.category as 'prompt' | 'answer' | 'system') || 'prompt',
            'show-in-menu': old['show-in-menu'] !== false,
            created: old.created ? String(old.created) : new Date().toISOString(),
            updated: old.updated ? String(old.updated) : new Date().toISOString(),
        },
        'prompt-queue': [{
            id: 'P1',
            name: 'Main Prompt',
            type: 'main',
            'prompt-text': '', // Template main prompt text is empty (filled when used)
            template: String(old.template || ''),
            'answer-wrapper': true,
        }],
    };
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
                if (!raw) continue;

                const templateId = templateIdFromFileName(fileName);
                let doc: QueueFileYaml;
                if (isNewFormat(raw)) {
                    doc = raw;
                } else if (raw.name && raw.template) {
                    doc = convertLegacyTemplate(raw, templateId);
                } else {
                    continue;
                }

                templates.push({ filePath, fileName, templateId, data: doc });
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

    const pattern = new vscode.RelativePattern(folder, `*${ENTRY_SUFFIX}`);
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
// Migration Helper
// ============================================================================

/**
 * Migrate from the old panelYamlStore queue format to file-per-entry.
 * Called once on first load if the old queue file exists and no new entries do.
 *
 * @param oldItems Array of old QueuedPrompt-style objects
 * @param quest Current quest ID
 * @returns Number of entries migrated
 */
export function migrateFromOldFormat(
    oldItems: Array<Record<string, unknown>>,
    quest?: string,
): number {
    let count = 0;
    try {
        const folder = ensureQueueFolder();
        if (!folder) return 0;

        for (const item of oldItems) {
            const entryData = convertOldItemToEntry(item, quest);
            if (!entryData) continue;

            const createdDate = item.createdAt
                ? new Date(String(item.createdAt))
                : new Date();
            const fileName = generateEntryFileName(quest, String(item.type || 'prompt'), createdDate);
            const filePath = path.join(folder, fileName);

            const yaml = requireYaml();
            const schemaLine = `# yaml-language-server: $schema=${ENTRY_SCHEMA_REL}\n`;
            fs.writeFileSync(filePath, schemaLine + yaml.stringify(entryData, { lineWidth: 120 }), 'utf-8');
            count++;
        }

        if (QUEUE_STORAGE_DEBUG) debugLog(`[QueueStorage] Migrated ${count} entries from old format`, 'INFO', 'queueStorage');
    } catch (err) {
        debugLog(`[QueueStorage] Migration error: ${err}`, 'ERROR', 'queueStorage');
    }
    return count;
}

/**
 * Convert a single old QueuedPrompt object to the new QueueEntryYaml format.
 */
function convertOldItemToEntry(
    item: Record<string, unknown>,
    quest?: string,
): QueueEntryYaml | undefined {
    try {
        const text = String(item.originalText || item.text || '');
        if (!text) return undefined;

        const rawType = String(item.type || 'prompt');
        const entry: QueueEntryYaml = {
            type: rawType === 'normal' ? 'prompt' : (rawType as 'prompt' | 'timed' | 'reminder') || 'prompt',
            quest: quest || undefined,
            created: String(item.createdAt || new Date().toISOString()),
            status: normalizeStatus(String(item.status || 'staged')),
            prompt: {
                text,
                'expanded-text': String(item.expandedText || text),
                template: String(item.template || '(None)'),
                'answer-wrapper': Boolean(item.answerWrapper),
            },
        };

        // Reminder
        if (item.reminderEnabled) {
            entry.reminder = {
                enabled: Boolean(item.reminderEnabled),
                'template-id': item.reminderTemplateId ? String(item.reminderTemplateId) : undefined,
                'timeout-minutes': item.reminderTimeoutMinutes ? Number(item.reminderTimeoutMinutes) : undefined,
                repeat: Boolean(item.reminderRepeat),
                'sent-count': Number(item.reminderSentCount || 0),
                'last-sent-at': item.lastReminderAt ? String(item.lastReminderAt) : null,
                queued: Boolean(item.reminderQueued),
            };
        }

        // Follow-ups
        const followUps = item.followUps as Array<Record<string, unknown>> | undefined;
        if (followUps && followUps.length > 0) {
            entry['follow-ups'] = followUps.map(fu => ({
                id: String(fu.id || generateId()),
                text: String(fu.originalText || fu.text || ''),
                template: fu.template ? String(fu.template) : undefined,
                reminder: fu.reminderEnabled ? {
                    enabled: Boolean(fu.reminderEnabled),
                    'template-id': fu.reminderTemplateId ? String(fu.reminderTemplateId) : undefined,
                    'timeout-minutes': fu.reminderTimeoutMinutes ? Number(fu.reminderTimeoutMinutes) : undefined,
                    repeat: Boolean(fu.reminderRepeat),
                } : undefined,
                created: String(fu.createdAt || new Date().toISOString()),
            }));
        }

        // Execution state
        if (item.requestId || item.expectedRequestId || item.sentAt || item.error || item.followUpIndex) {
            entry.execution = {
                'request-id': item.requestId ? String(item.requestId) : null,
                'expected-request-id': item.expectedRequestId ? String(item.expectedRequestId) : null,
                'sent-at': item.sentAt ? String(item.sentAt) : null,
                error: item.error ? String(item.error) : null,
                'follow-up-index': Number(item.followUpIndex || 0),
            };
        }

        return entry;
    } catch (err) {
        debugLog(`[QueueStorage] convertOldItemToEntry error: ${err}`, 'ERROR', 'queueStorage');
        return undefined;
    }
}

function normalizeStatus(status: string): QueueEntryYaml['status'] {
    switch (status) {
        case 'staged': case 'pending': case 'sending': case 'sent': case 'error':
            return status;
        default:
            return 'staged';
    }
}

function generateId(): string {
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
