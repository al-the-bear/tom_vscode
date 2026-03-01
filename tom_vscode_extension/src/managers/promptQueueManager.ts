/**
 * Prompt Queue Manager (§3.2)
 *
 * Manages an ordered queue of prompts destined for Copilot Chat.
 * Supports auto-send on answer detection, manual reordering,
 * and integration with the Reminder and Timer systems.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { expandTemplate } from '../handlers/promptTemplate';
import { loadSendToChatConfig, getCopilotChatAnswerFolderAbsolute, DEFAULT_ANSWER_FILE_TEMPLATE, getConfigPath } from '../handlers/handler_shared';
import {
    readAllEntries,
    writeEntry,
    deleteEntry,
    generateEntryFileName,
    entryIdFromFileName,
    startWatching as startQueueWatching,
    stopWatching as stopQueueWatching,
    onQueueChanged,
    trimSentEntries,
    type QueueEntryFile,
    type QueueFileYaml,
    type QueuePromptYaml,
    type QueueReminderConfig,
} from '../storage/queueFileStorage';
import { debugLog } from '../utils/debugLogger';

// ============================================================================
// Types
// ============================================================================

export type QueuedPromptStatus = 'staged' | 'pending' | 'sending' | 'sent' | 'error';
export type QueuedPromptType = 'normal' | 'timed' | 'reminder';

export interface QueuedFollowUpPrompt {
    id: string;
    originalText: string;
    template?: string;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    createdAt: string;
}

export interface QueuedPrePrompt {
    text: string;
    template?: string;
    status: 'pending' | 'sent' | 'error';
}

export interface QueuedPrompt {
    id: string;
    template: string;             // Template name or "(None)"
    answerWrapper?: boolean;      // Whether to also wrap with answer file template
    originalText: string;         // User's raw prompt
    expandedText: string;         // After template processing
    status: QueuedPromptStatus;
    type: QueuedPromptType;
    createdAt: string;            // ISO timestamp
    sentAt?: string;              // When actually sent to Copilot
    error?: string;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    reminderQueued?: boolean;     // Whether a reminder has been queued for this item
    reminderSentCount?: number;
    lastReminderAt?: string;
    requestId?: string;           // Initial request id extracted from the wrapped prompt
    expectedRequestId?: string;   // Request id expected in the next answer file
    prePrompts?: QueuedPrePrompt[];  // Pre-prompts sent before the main prompt
    followUps?: QueuedFollowUpPrompt[];
    followUpIndex?: number;       // Number of follow-ups already sent
}

// ============================================================================
// Singleton
// ============================================================================

const MAX_SENT_HISTORY = 50;
const MAX_TOTAL_ITEMS = 100;
const DEFAULT_REMINDER_TEMPLATE_ID = 'default';
const DEFAULT_REMINDER_TEXT = 'Are you still there? The previous prompt has been waiting for {{timeoutMinutes}} minutes without a response. Please continue or let me know if there\'s an issue.';

/**
 * Resolve a template name to its template string.
 * Handles __answer_file__ (built-in default) and config-defined templates.
 * Exported so preview panels can use the exact same logic.
 */
export function resolveTemplateString(templateName: string): string | undefined {
    if (!templateName || templateName === '(None)') { return undefined; }
    try {
        const config = loadSendToChatConfig();
        const tpl = config?.copilot?.templates?.[templateName];
        if (tpl?.template) { return tpl.template; }
    } catch { /* config not available */ }
    // Built-in default for __answer_file__ when not in config
    if (templateName === '__answer_file__') {
        return DEFAULT_ANSWER_FILE_TEMPLATE;
    }
    return undefined;
}

/** Apply template wrapping to expanded text.
 *  Expands placeholders after each template application so that
 *  placeholders introduced by the named template are resolved before
 *  the result becomes ${originalPrompt} for the answer wrapper.
 *  Exported so preview panels can use the exact same logic.
 */
export async function applyTemplateWrapping(expanded: string, templateName: string, answerWrapper?: boolean): Promise<string> {
    // First: apply the named template (if any, and not __answer_file__ itself when answerWrapper handles it)
    if (templateName && templateName !== '(None)' && templateName !== '__answer_file__') {
        const tplStr = resolveTemplateString(templateName);
        if (tplStr) {
            expanded = tplStr.replace(/\$\{originalPrompt\}/g, expanded);
        }
        // Expand placeholders introduced by the named template
        expanded = await expandTemplate(expanded, { includeEditorContext: false });
    }
    // If template IS __answer_file__ (legacy) or answerWrapper is true, apply answer wrapper on top
    if (answerWrapper || templateName === '__answer_file__') {
        const awStr = resolveTemplateString('__answer_file__');
        if (awStr) {
            expanded = awStr.replace(/\$\{originalPrompt\}/g, expanded);
        }
        // Expand placeholders introduced by the answer wrapper
        expanded = await expandTemplate(expanded, { includeEditorContext: false });
    }
    return expanded;
}

export class PromptQueueManager {
    private static _inst: PromptQueueManager | undefined;

    private _items: QueuedPrompt[] = [];
    private _autoSendEnabled = true;
    private _autoSendDelayMs = 2000;
    private _responseFileTimeoutMinutes = 60;
    private _answerWatcher?: fs.FSWatcher;
    private _timeoutWatcher?: ReturnType<typeof setInterval>;
    private _processing = false;

    /** Maps QueuedPrompt.id → entry filename on disk. */
    private _fileNameMap = new Map<string, string>();
    /** Disposable for queue file change listener. */
    private _queueChangeDisposable?: vscode.Disposable;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private readonly _onPromptSent = new vscode.EventEmitter<QueuedPrompt>();
    public readonly onPromptSent = this._onPromptSent.event;

    private readonly _onAnswerReceived = new vscode.EventEmitter<Record<string, unknown> | undefined>();
    public readonly onAnswerReceived = this._onAnswerReceived.event;

    private _ctx!: vscode.ExtensionContext;

    private _extractRequestIdFromExpandedPrompt(expanded: string): string | undefined {
        const patterns = [
            /"requestId"\s*:\s*"([^"]+)"/,
            /requestId\s*[:=]\s*['"]([^'"]+)['"]/,
            /Request ID\s*[:=]\s*([\w.-]+)/i,
        ];
        for (const pattern of patterns) {
            const match = expanded.match(pattern);
            if (match?.[1]) {
                return match[1].trim();
            }
        }
        return undefined;
    }

    private async _buildExpandedText(originalText: string, template?: string, answerWrapper?: boolean): Promise<string> {
        let expanded = await expandTemplate(originalText, { includeEditorContext: false });
        expanded = await applyTemplateWrapping(expanded, template ?? '(None)', answerWrapper);
        return expanded;
    }

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (PromptQueueManager._inst) { return; }
        const m = new PromptQueueManager();
        m._ctx = ctx;
        m.restore();
        m.setupAnswerWatcher();
        m.startTimeoutWatcher();
        // Start file watcher for cross-window sync
        startQueueWatching();
        m._queueChangeDisposable = onQueueChanged(() => {
            debugLog('[PromptQueueManager] Queue files changed on disk, reloading', 'INFO', 'queue');
            m._reloadFromDisk();
        });
        PromptQueueManager._inst = m;
    }

    static get instance(): PromptQueueManager {
        if (!PromptQueueManager._inst) { throw new Error('PromptQueueManager not initialised'); }
        return PromptQueueManager._inst;
    }

    dispose(): void {
        this._answerWatcher?.close();
        if (this._timeoutWatcher) {
            clearInterval(this._timeoutWatcher);
            this._timeoutWatcher = undefined;
        }
        this._queueChangeDisposable?.dispose();
        stopQueueWatching();
        this._onDidChange.dispose();
        this._onPromptSent.dispose();
        this._onAnswerReceived.dispose();
    }

    // ----- answer file watcher -----------------------------------------------

    private get answerFilePath(): string {
        const session = vscode.env.sessionId.substring(0, 8);
        const machine = vscode.env.machineId.substring(0, 8);
        const folder = getCopilotChatAnswerFolderAbsolute();
        return path.join(folder, `${session}_${machine}_answer.json`);
    }

    private setupAnswerWatcher(): void {
        const dir = path.dirname(this.answerFilePath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

        const basename = path.basename(this.answerFilePath);
        this._answerWatcher = fs.watch(dir, (_, filename) => {
            if (filename === basename) {
                this.onAnswerFileChanged();
            }
        });
    }

    private startTimeoutWatcher(): void {
        if (this._timeoutWatcher) { return; }
        this._timeoutWatcher = setInterval(() => {
            void this.checkResponseTimeouts();
        }, 30_000);
    }

    private loadReminderDataFromConfig(): { templates: Array<{ id: string; prompt: string }>; defaultTemplateId: string } {
        try {
            const configPath = getConfigPath();
            if (!configPath || !fs.existsSync(configPath)) {
                return {
                    templates: [{ id: DEFAULT_REMINDER_TEMPLATE_ID, prompt: DEFAULT_REMINDER_TEXT }],
                    defaultTemplateId: DEFAULT_REMINDER_TEMPLATE_ID,
                };
            }
            const raw = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const reminders = (parsed?.reminders && typeof parsed.reminders === 'object') ? parsed.reminders : {};
            const templatesRaw = Array.isArray(reminders.templates) ? reminders.templates : [];
            const templates = templatesRaw
                .filter((t: any) => typeof t?.id === 'string' && typeof t?.prompt === 'string')
                .map((t: any) => ({ id: String(t.id), prompt: String(t.prompt) }));
            const defaultTemplateId = typeof reminders?.config?.defaultTemplateId === 'string'
                ? String(reminders.config.defaultTemplateId)
                : DEFAULT_REMINDER_TEMPLATE_ID;
            if (templates.length === 0) {
                templates.push({ id: DEFAULT_REMINDER_TEMPLATE_ID, prompt: DEFAULT_REMINDER_TEXT });
            }
            return { templates, defaultTemplateId };
        } catch {
            return {
                templates: [{ id: DEFAULT_REMINDER_TEMPLATE_ID, prompt: DEFAULT_REMINDER_TEXT }],
                defaultTemplateId: DEFAULT_REMINDER_TEMPLATE_ID,
            };
        }
    }

    private resolveReminderPrompt(templateId?: string): string {
        const cfg = this.loadReminderDataFromConfig();
        const byId = templateId ? cfg.templates.find(t => t.id === templateId)?.prompt : undefined;
        if (byId) { return byId; }
        const byDefault = cfg.templates.find(t => t.id === cfg.defaultTemplateId)?.prompt;
        return byDefault || DEFAULT_REMINDER_TEXT;
    }

    private getActiveReminderTimeoutMinutes(item: QueuedPrompt): number {
        const followUps = item.followUps || [];
        const sentFollowUps = item.followUpIndex || 0;
        const activeFollowUp = sentFollowUps > 0 && sentFollowUps <= followUps.length
            ? followUps[sentFollowUps - 1]
            : undefined;

        const timeoutCandidate = activeFollowUp?.reminderTimeoutMinutes
            ?? item.reminderTimeoutMinutes
            ?? this._responseFileTimeoutMinutes;

        return Math.max(1, Math.round(timeoutCandidate || this._responseFileTimeoutMinutes));
    }

    private isReminderEligible(item: QueuedPrompt): boolean {
        if (item.type !== 'timed') {
            return true;
        }

        const followUps = item.followUps || [];
        const sentFollowUps = item.followUpIndex || 0;
        const activeFollowUp = sentFollowUps > 0 && sentFollowUps <= followUps.length
            ? followUps[sentFollowUps - 1]
            : undefined;

        return !!(activeFollowUp?.reminderEnabled ?? item.reminderEnabled);
    }

    private buildReminderText(item: QueuedPrompt): string {
        const timeoutMinutes = this.getActiveReminderTimeoutMinutes(item);
        const now = Date.now();
        const sentAt = item.sentAt ? new Date(item.sentAt).getTime() : now;
        const waitingMinutes = Math.max(1, Math.round((now - sentAt) / 60000));

        const followUps = item.followUps || [];
        const sentFollowUps = item.followUpIndex || 0;
        const activeFollowUp = sentFollowUps > 0 && sentFollowUps <= followUps.length
            ? followUps[sentFollowUps - 1]
            : undefined;

        const reminderTemplateId = activeFollowUp?.reminderTemplateId || item.reminderTemplateId;
        const template = this.resolveReminderPrompt(reminderTemplateId);
        const sourcePrompt = activeFollowUp?.originalText || item.originalText;
        const followUpIndex = sentFollowUps;
        const followUpTotal = followUps.length;
        const sentAtIso = item.sentAt || '';
        const templateLabel = activeFollowUp?.template || item.template || '(None)';
        const requestId = item.requestId || '';
        const expectedRequestId = item.expectedRequestId || '';
        const createdAt = item.createdAt || '';
        const reminderSentCount = item.reminderSentCount || 0;
        const queueLength = this._items.length;

        return template
            .replace(/\{\{timeoutMinutes\}\}/g, String(timeoutMinutes))
            .replace(/\{\{waitingMinutes\}\}/g, String(waitingMinutes))
            .replace(/\{\{originalPrompt\}\}/g, sourcePrompt.substring(0, 400))
            .replace(/\{\{followUpIndex\}\}/g, String(followUpIndex))
            .replace(/\{\{followUpTotal\}\}/g, String(followUpTotal))
            .replace(/\{\{sentAt\}\}/g, sentAtIso)
            .replace(/\{\{followUpText\}\}/g, activeFollowUp?.originalText || '')
            .replace(/\{\{promptId\}\}/g, item.id)
            .replace(/\{\{promptType\}\}/g, item.type)
            .replace(/\{\{status\}\}/g, item.status)
            .replace(/\{\{template\}\}/g, templateLabel)
            .replace(/\{\{requestId\}\}/g, requestId)
            .replace(/\{\{expectedRequestId\}\}/g, expectedRequestId)
            .replace(/\{\{createdAt\}\}/g, createdAt)
            .replace(/\{\{reminderSentCount\}\}/g, String(reminderSentCount))
            .replace(/\{\{queueLength\}\}/g, String(queueLength));
    }

    private isReminderRepeatEnabled(item: QueuedPrompt): boolean {
        const followUps = item.followUps || [];
        const sentFollowUps = item.followUpIndex || 0;
        const activeFollowUp = sentFollowUps > 0 && sentFollowUps <= followUps.length
            ? followUps[sentFollowUps - 1]
            : undefined;
        return !!(activeFollowUp?.reminderRepeat || item.reminderRepeat);
    }

    private async checkResponseTimeouts(): Promise<void> {
        const sending = this._items.find(i => i.status === 'sending');
        if (!sending || !sending.sentAt) { return; }
        if (!this.isReminderEligible(sending)) { return; }

        const now = Date.now();
        const timeoutMs = this.getActiveReminderTimeoutMinutes(sending) * 60_000;
        const firstDue = new Date(sending.sentAt).getTime() + timeoutMs;
        if (now < firstDue) { return; }

        const reminderSentCount = sending.reminderSentCount || 0;
        const repeat = this.isReminderRepeatEnabled(sending);

        if (reminderSentCount > 0 && !repeat) {
            return;
        }

        if (reminderSentCount > 0 && sending.lastReminderAt) {
            const nextDue = new Date(sending.lastReminderAt).getTime() + timeoutMs;
            if (now < nextDue) {
                return;
            }
        }

        const reminderText = this.buildReminderText(sending);
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: reminderText });
            sending.reminderSentCount = reminderSentCount + 1;
            sending.lastReminderAt = new Date().toISOString();
            this.persist();
            this._onDidChange.fire();
        } catch {
            // keep waiting; next check can retry
        }
    }

    private async onAnswerFileChanged(): Promise<void> {
        const filePath = this.answerFilePath;
        if (!fs.existsSync(filePath)) { return; }

        let answer: Record<string, unknown> | undefined;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            answer = JSON.parse(raw);
        } catch { /* ignore parse errors */ }

        // Propagate responseValues to session-scoped chat response store only.
        // Do NOT write to persistent ChatVariablesStore — responseValues are
        // transient inter-prompt data, not intentional user-managed variables.
        if (answer && typeof answer === 'object') {
            const rv = (answer as any).responseValues;
            if (rv && typeof rv === 'object') {
                try {
                    const { updateChatResponseValues } = require('../handlers/handler_shared');
                    updateChatResponseValues(rv);
                } catch { /* handler not ready */ }
            }
        }

        this._onAnswerReceived.fire(answer);

        const answerRequestId = (answer && typeof answer === 'object' && typeof (answer as any).requestId === 'string')
            ? String((answer as any).requestId)
            : undefined;

        // Mark/update the current "sending" item (prefer exact request-id match)
        let sendingIdx = -1;
        if (answerRequestId) {
            sendingIdx = this._items.findIndex(i => i.status === 'sending' && i.expectedRequestId === answerRequestId);
        }
        if (sendingIdx < 0) {
            sendingIdx = this._items.findIndex(i => i.status === 'sending');
        }
        if (sendingIdx >= 0) {
            const item = this._items[sendingIdx];
            const followUps = item.followUps ?? [];
            const alreadySent = item.followUpIndex ?? 0;

            if (alreadySent < followUps.length) {
                const nextFollowUp = followUps[alreadySent];
                try {
                    const followUpExpanded = await this._buildExpandedText(
                        nextFollowUp.originalText,
                        nextFollowUp.template,
                        true,
                    );

                    item.expandedText = followUpExpanded;
                    item.expectedRequestId = this._extractRequestIdFromExpandedPrompt(followUpExpanded);
                    item.followUpIndex = alreadySent + 1;
                    item.sentAt = new Date().toISOString();
                    item.reminderSentCount = 0;
                    item.lastReminderAt = undefined;
                    this.persist();
                    this._onDidChange.fire();

                    try { fs.unlinkSync(this.answerFilePath); } catch { /* ok */ }
                    await vscode.commands.executeCommand('workbench.action.chat.open', { query: followUpExpanded });
                    this._onPromptSent.fire(item);
                    return;
                } catch (err) {
                    item.status = 'error';
                    item.error = String(err);
                    this.persist();
                    this._onDidChange.fire();
                    return;
                }
            }

            item.status = 'sent';
            item.expectedRequestId = undefined;
            item.reminderSentCount = 0;
            item.lastReminderAt = undefined;
            // Remove any pending reminder for this item
            this.removePendingReminderFor(item.id);
            this.persist();
            this._onDidChange.fire();
        }

        // Auto-send next
        if (this._autoSendEnabled) {
            await this.delaySendNext();
        }
    }

    // ----- queue CRUD --------------------------------------------------------

    get items(): readonly QueuedPrompt[] { return this._items; }
    get pendingCount(): number { return this._items.filter(i => i.status === 'pending').length; }
    get autoSendEnabled(): boolean { return this._autoSendEnabled; }
    get responseFileTimeoutMinutes(): number { return this._responseFileTimeoutMinutes; }

    set autoSendEnabled(v: boolean) {
        this._autoSendEnabled = v;
        this.persist();
        this._onDidChange.fire();
    }

    set responseFileTimeoutMinutes(v: number) {
        this._responseFileTimeoutMinutes = Math.max(5, Math.round(v || 60));
        this.persist();
        this._onDidChange.fire();
    }

    get autoSendDelayMs(): number { return this._autoSendDelayMs; }
    set autoSendDelayMs(v: number) { this._autoSendDelayMs = Math.max(500, v); }

    /**
     * Add a prompt to the queue.
     * @param position Insert index. -1 = end (default). 1 = high priority (after current sending).
     */
    async enqueue(opts: {
        originalText: string;
        template?: string;
        answerWrapper?: boolean;
        type?: QueuedPromptType;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
        position?: number;
        prePrompts?: Array<{ text: string; template?: string }>;
        followUps?: Array<{ originalText: string; template?: string; reminderTemplateId?: string; reminderTimeoutMinutes?: number; reminderRepeat?: boolean; reminderEnabled?: boolean }>;
        initialStatus?: 'staged' | 'pending';
        deferSend?: boolean;
    }): Promise<QueuedPrompt> {
        const expanded = await this._buildExpandedText(opts.originalText, opts.template, opts.answerWrapper);

        const item: QueuedPrompt = {
            id: randomUUID(),
            template: opts.template ?? '(None)',
            answerWrapper: opts.answerWrapper || false,
            originalText: opts.originalText,
            expandedText: expanded,
            status: opts.initialStatus ?? 'staged',
            type: opts.type ?? 'normal',
            createdAt: new Date().toISOString(),
            reminderTemplateId: opts.reminderTemplateId,
            reminderTimeoutMinutes: opts.reminderTimeoutMinutes,
            reminderRepeat: !!opts.reminderRepeat,
            reminderEnabled: !!opts.reminderEnabled,
            reminderQueued: false,
            reminderSentCount: 0,
            prePrompts: (opts.prePrompts || [])
                .filter(p => !!(p.text || '').trim())
                .map(p => ({
                    text: p.text,
                    template: p.template,
                    status: 'pending' as const,
                })),
            followUps: (opts.followUps || [])
                .filter(f => !!(f.originalText || '').trim())
                .map(f => ({
                    id: randomUUID(),
                    originalText: f.originalText,
                    template: f.template,
                    reminderTemplateId: f.reminderTemplateId,
                    reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                    reminderRepeat: !!f.reminderRepeat,
                    reminderEnabled: !!f.reminderEnabled,
                    createdAt: new Date().toISOString(),
                })),
            followUpIndex: 0,
        };

        const pos = opts.position ?? -1;
        if (pos >= 0 && pos < this._items.length) {
            this._items.splice(pos, 0, item);
        } else {
            this._items.push(item);
        }

        this.persist();
        this._onDidChange.fire();

        // If nothing is sending and auto-send is on, kick off unless explicitly deferred
        if (!opts.deferSend && this._autoSendEnabled && !this._items.some(i => i.status === 'sending')) {
            await this.sendNext();
        }

        return item;
    }

    /** Remove an item by id. */
    remove(id: string): void {
        this._items = this._items.filter(i => i.id !== id);
        this.persist();
        this._onDidChange.fire();
    }

    /** Move item up (index - 1) or down (index + 1). */
    move(id: string, direction: 'up' | 'down'): void {
        const idx = this._items.findIndex(i => i.id === id);
        if (idx < 0) { return; }
        const swap = direction === 'up' ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= this._items.length) { return; }
        [this._items[idx], this._items[swap]] = [this._items[swap], this._items[idx]];
        this.persist();
        this._onDidChange.fire();
    }

    /** Update the original text of a queued item and re-expand. */
    private isEditableStatus(status: QueuedPromptStatus): boolean {
        return status === 'staged';
    }

    async updateText(id: string, newText: string): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableStatus(item.status)) { return; }
        item.originalText = newText;
        item.expandedText = await this._buildExpandedText(newText, item.template, item.answerWrapper);
        this.persist();
        this._onDidChange.fire();
    }

    async updateItemTemplateAndWrapper(id: string, patch: { template?: string; answerWrapper?: boolean }): Promise<boolean> {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableStatus(item.status)) { return false; }

        let changed = false;
        if (patch.template !== undefined) {
            item.template = patch.template || '(None)';
            changed = true;
        }
        if (patch.answerWrapper !== undefined) {
            item.answerWrapper = !!patch.answerWrapper;
            changed = true;
        }

        if (!changed) { return false; }

        item.expandedText = await this._buildExpandedText(item.originalText, item.template, item.answerWrapper);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    updateItemReminder(id: string, patch: { reminderEnabled?: boolean; reminderTemplateId?: string; reminderTimeoutMinutes?: number; reminderRepeat?: boolean }): void {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableStatus(item.status)) { return; }
        if (patch.reminderEnabled !== undefined) {
            item.reminderEnabled = !!patch.reminderEnabled;
        }
        if (patch.reminderTemplateId !== undefined) {
            item.reminderTemplateId = patch.reminderTemplateId || undefined;
        }
        if (patch.reminderTimeoutMinutes !== undefined) {
            item.reminderTimeoutMinutes = patch.reminderTimeoutMinutes ? Math.max(1, Math.round(patch.reminderTimeoutMinutes)) : undefined;
        }
        if (patch.reminderRepeat !== undefined) {
            item.reminderRepeat = !!patch.reminderRepeat;
        }
        this.persist();
        this._onDidChange.fire();
    }

    getById(id: string): QueuedPrompt | undefined {
        return this._items.find(i => i.id === id);
    }

    getByRequestId(requestId: string): QueuedPrompt | undefined {
        if (!requestId) { return undefined; }
        return this._items.find(i => i.requestId === requestId || i.expectedRequestId === requestId);
    }

    addFollowUpPrompt(itemId: string, followUp: { originalText: string; template?: string; reminderTemplateId?: string; reminderTimeoutMinutes?: number; reminderRepeat?: boolean; reminderEnabled?: boolean }): QueuedFollowUpPrompt | undefined {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return undefined; }
        const text = (followUp.originalText || '').trim();
        if (!text) { return undefined; }
        const entry: QueuedFollowUpPrompt = {
            id: randomUUID(),
            originalText: text,
            template: followUp.template,
            reminderTemplateId: followUp.reminderTemplateId,
            reminderTimeoutMinutes: followUp.reminderTimeoutMinutes,
            reminderRepeat: !!followUp.reminderRepeat,
            reminderEnabled: !!followUp.reminderEnabled,
            createdAt: new Date().toISOString(),
        };
        if (!item.followUps) { item.followUps = []; }
        item.followUps.push(entry);
        this.persist();
        this._onDidChange.fire();
        return entry;
    }

    addEmptyFollowUpPrompt(itemId: string): QueuedFollowUpPrompt | undefined {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return undefined; }
        const entry: QueuedFollowUpPrompt = {
            id: randomUUID(),
            originalText: '',
            template: undefined,
            reminderTemplateId: undefined,
            reminderTimeoutMinutes: undefined,
            reminderRepeat: false,
            reminderEnabled: false,
            createdAt: new Date().toISOString(),
        };
        if (!item.followUps) { item.followUps = []; }
        item.followUps.push(entry);
        this.persist();
        this._onDidChange.fire();
        return entry;
    }

    updateFollowUpPrompt(itemId: string, followUpId: string, patch: { originalText?: string; template?: string; reminderTemplateId?: string; reminderTimeoutMinutes?: number; reminderRepeat?: boolean; reminderEnabled?: boolean }): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item?.followUps) { return false; }
        const follow = item.followUps.find(f => f.id === followUpId);
        if (!follow) { return false; }
        if (typeof patch.originalText === 'string') {
            follow.originalText = patch.originalText;
        }
        if (patch.template !== undefined) {
            follow.template = patch.template || undefined;
        }
        if (patch.reminderTemplateId !== undefined) {
            follow.reminderTemplateId = patch.reminderTemplateId || undefined;
        }
        if (patch.reminderTimeoutMinutes !== undefined) {
            follow.reminderTimeoutMinutes = patch.reminderTimeoutMinutes ? Math.max(1, Math.round(patch.reminderTimeoutMinutes)) : undefined;
        }
        if (patch.reminderRepeat !== undefined) {
            follow.reminderRepeat = !!patch.reminderRepeat;
        }
        if (patch.reminderEnabled !== undefined) {
            follow.reminderEnabled = !!patch.reminderEnabled;
        }
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    removeFollowUpPrompt(itemId: string, followUpId: string): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item?.followUps) { return false; }
        const before = item.followUps.length;
        item.followUps = item.followUps.filter(f => f.id !== followUpId);
        const removed = item.followUps.length !== before;
        if (removed) {
            this.persist();
            this._onDidChange.fire();
        }
        return removed;
    }

    // ----- pre-prompt management ---------------------------------------------

    /** Add a pre-prompt to a queue item. */
    addPrePrompt(itemId: string, text: string, template?: string): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item.prePrompts) { item.prePrompts = []; }
        item.prePrompts.push({ text, template, status: 'pending' });
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** Update a pre-prompt by index. */
    updatePrePrompt(itemId: string, index: number, patch: { text?: string; template?: string }): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item.prePrompts || index < 0 || index >= item.prePrompts.length) { return false; }
        const pp = item.prePrompts[index];
        if (patch.text !== undefined) pp.text = patch.text;
        if (patch.template !== undefined) pp.template = patch.template || undefined;
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** Remove a pre-prompt by index. */
    removePrePrompt(itemId: string, index: number): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item.prePrompts || index < 0 || index >= item.prePrompts.length) { return false; }
        item.prePrompts.splice(index, 1);
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /** Send a specific item immediately (skip queue order). */
    async sendNow(id: string): Promise<void> {
        const item = this._items.find(i => i.id === id);
        if (!item || !(item.status === 'pending' || item.status === 'staged')) { return; }
        await this.sendItem(item);
    }

    setStatus(id: string, status: 'staged' | 'pending'): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item) { return false; }
        if (item.status === 'sending' || item.status === 'sent' || item.status === 'error') { return false; }
        item.status = status;
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    /**
     * Explicitly send a queued prompt by queue item ID or request ID.
     * Only pending items are eligible.
     */
    async sendQueuedPrompt(target: { id?: string; requestId?: string }): Promise<QueuedPrompt | undefined> {
        let item: QueuedPrompt | undefined;
        if (target.id) {
            item = this._items.find(i => i.id === target.id);
        } else if (target.requestId) {
            item = this._items.find(i => i.requestId === target.requestId || i.expectedRequestId === target.requestId);
        }
        if (!item || !(item.status === 'pending' || item.status === 'staged')) {
            return undefined;
        }
        await this.sendItem(item);
        return item;
    }

    /** Clear all items with the given status. */
    clearByStatus(status: QueuedPromptStatus): void {
        this._items = this._items.filter(i => i.status !== status);
        this.trimSentHistory();
        this.persist();
        this._onDidChange.fire();
    }

    /** Clear entire queue (all statuses). */
    clearAll(): void {
        this._items = [];
        this.persist();
        this._onDidChange.fire();
    }

    // ----- sending -----------------------------------------------------------

    private async delaySendNext(): Promise<void> {
        if (this._processing) { return; }
        this._processing = true;
        await new Promise(r => setTimeout(r, this._autoSendDelayMs));
        this._processing = false;
        await this.sendNext();
    }

    async sendNext(): Promise<void> {
        const next = this._items.find(i => i.status === 'pending');
        if (!next) { return; }
        // Don't send if something is already sending
        if (this._items.some(i => i.status === 'sending')) { return; }
        await this.sendItem(next);
    }

    private async sendItem(item: QueuedPrompt): Promise<void> {
        // Send pre-prompts first (sequentially, each wrapped with answer wrapper)
        if (item.prePrompts && item.prePrompts.length > 0) {
            for (const pp of item.prePrompts) {
                if (pp.status === 'sent') continue; // skip already-sent pre-prompts
                try {
                    let prePromptText = pp.text;
                    // Apply answer wrapper template to pre-prompts
                    prePromptText = await this._buildExpandedText(prePromptText, pp.template, true);
                    await vscode.commands.executeCommand('workbench.action.chat.open', { query: prePromptText });
                    pp.status = 'sent';
                    this.persist();
                    this._onDidChange.fire();
                    // Brief delay between pre-prompts and main prompt
                    await new Promise(r => setTimeout(r, 2000));
                } catch (err) {
                    pp.status = 'error';
                    debugLog(`[PromptQueueManager] Pre-prompt send error: ${err}`, 'ERROR', 'queue');
                    // Continue — don't block main prompt on pre-prompt failure
                }
            }
        }

        // Re-expand with current variables and apply template wrapping
        try {
            item.expandedText = await this._buildExpandedText(item.originalText, item.template, item.answerWrapper);
        } catch { /* use existing expansion */ }

        item.requestId = this._extractRequestIdFromExpandedPrompt(item.expandedText);
        item.expectedRequestId = item.requestId;
        item.followUpIndex = 0;
        item.reminderSentCount = 0;
        item.lastReminderAt = undefined;

        item.status = 'sending';
        item.sentAt = new Date().toISOString();
        this.persist();
        this._onDidChange.fire();

        // Delete existing answer file
        try { fs.unlinkSync(this.answerFilePath); } catch { /* ok */ }

        // Send to Copilot Chat
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: item.expandedText });
            this._onPromptSent.fire(item);
        } catch (err) {
            item.status = 'error';
            item.error = String(err);
            this.persist();
            this._onDidChange.fire();
        }
    }

    // ----- reminder helpers --------------------------------------------------

    /** Remove a pending reminder queued for a specific prompt item. */
    private removePendingReminderFor(promptId: string): void {
        this._items = this._items.filter(i => !(i.type === 'reminder' && (i as any).parentPromptId === promptId));
    }

    /** Check if a timed request already has a pending item in the queue. */
    hasTimedPending(timedRequestId: string): boolean {
        // We encode the timed request ID in the item's id as a prefix convention
        // or check by matching originalText. For simplicity, check by type + template combo.
        // The TimerEngine should set a unique marker.
        return false; // TimerEngine will use its own deduplication
    }

    // ----- persistence -------------------------------------------------------

    private persist(): void {
        this.trimSentHistory();
        this._persistToFiles();
    }

    private restore(): void {
        const entries = readAllEntries();
        this._loadFromEntryFiles(entries);
        console.log('[PromptQueueManager] restore: loaded', this._items.length, 'items from queue files');

        // Reset any "sending" items back to pending (crash recovery)
        for (const item of this._items) {
            if (item.status === 'sending') { item.status = 'pending'; }
        }
    }

    /** Reload state from disk (called by file watcher). */
    private _reloadFromDisk(): void {
        const entries = readAllEntries();
        this._loadFromEntryFiles(entries);
        this._onDidChange.fire();
    }

    /** Load queue items from entry files into memory. */
    private _loadFromEntryFiles(entries: QueueEntryFile[]): void {
        this._items = [];
        this._fileNameMap.clear();

        for (const entry of entries) {
            const item = this._entryToQueuedPrompt(entry);
            if (item) {
                this._items.push(item);
                this._fileNameMap.set(item.id, entry.fileName);
            }
        }
    }

    /** Persist all items to individual entry files. */
    private _persistToFiles(): void {
        try {
            let quest: string | undefined;
            try { quest = (await_import_ChatVariablesStore())?.quest || ''; } catch { /* */ }

            // Write each item
            for (const item of this._items) {
                const doc = this._queuedPromptToDoc(item, quest);
                let fileName = this._fileNameMap.get(item.id);
                if (!fileName) {
                    fileName = generateEntryFileName(quest, item.type, new Date(item.createdAt));
                    this._fileNameMap.set(item.id, fileName);
                }
                writeEntry(entryIdFromFileName(fileName), doc, fileName);
            }

            // Delete files for items no longer in memory
            const currentIds = new Set(this._items.map(i => i.id));
            for (const [itemId, fileName] of this._fileNameMap.entries()) {
                if (!currentIds.has(itemId)) {
                    deleteEntry(entryIdFromFileName(fileName));
                    this._fileNameMap.delete(itemId);
                }
            }

            trimSentEntries();
        } catch (err) {
            debugLog(`[PromptQueueManager] _persistToFiles error: ${err}`, 'ERROR', 'queue');
        }
    }

    // ----- Conversion: QueueFileYaml ↔ QueuedPrompt -----------------------

    private _entryToQueuedPrompt(entry: QueueEntryFile): QueuedPrompt | undefined {
        try {
            const doc = entry.doc;
            const meta = doc.meta;
            const prompts = doc['prompt-queue'] || [];
            const mainId = meta['main-prompt'] || 'P1';
            const main = prompts.find(p => p.id === mainId) || prompts.find(p => p.type === 'main') || prompts[0];
            if (!main) return undefined;

            const prompt: QueuedPrompt = {
                id: meta.id || entry.entryId,
                template: main.template || '(None)',
                answerWrapper: main['answer-wrapper'],
                originalText: main['prompt-text'] || '',
                expandedText: main['expanded-text'] || main['prompt-text'] || '',
                status: (meta.status as QueuedPromptStatus) || 'staged',
                type: 'normal',
                createdAt: (meta.created as string) || new Date().toISOString(),
                sentAt: main.execution?.['sent-at'] || undefined,
                error: main.execution?.error || undefined,
                reminderTemplateId: main.reminder?.['template-id'],
                reminderTimeoutMinutes: main.reminder?.['timeout-minutes'],
                reminderRepeat: main.reminder?.repeat,
                reminderEnabled: main.reminder?.enabled,
                reminderQueued: main.reminder?.queued,
                reminderSentCount: main.reminder?.['sent-count'],
                lastReminderAt: main.reminder?.['last-sent-at'] || undefined,
                requestId: main.execution?.['request-id'] || undefined,
                expectedRequestId: main.execution?.['expected-request-id'] || undefined,
                followUpIndex: main.execution?.['follow-up-index'] || 0,
            };

            // Pre-prompts: resolve refs from the prompt-queue
            const preRefs = main['pre-prompt-refs'] || [];
            if (preRefs.length > 0) {
                prompt.prePrompts = preRefs.map(ref => {
                    const refId = typeof ref === 'string' ? ref : undefined;
                    const pp = refId ? prompts.find(p => p.id === refId) : undefined;
                    return {
                        text: pp?.['prompt-text'] || '',
                        template: pp?.template,
                        status: (pp?.execution?.['sent-at'] ? 'sent' : (pp?.execution?.error ? 'error' : 'pending')) as 'pending' | 'sent' | 'error',
                    };
                });
            }

            // Follow-ups: resolve refs from the prompt-queue
            const fuRefs = main['follow-up-refs'] || [];
            if (fuRefs.length > 0) {
                prompt.followUps = fuRefs.map(ref => {
                    const refId = typeof ref === 'string' ? ref : undefined;
                    const fu = refId ? prompts.find(p => p.id === refId) : undefined;
                    return {
                        id: refId || randomUUID(),
                        originalText: fu?.['prompt-text'] || '',
                        template: fu?.template,
                        reminderTemplateId: fu?.reminder?.['template-id'],
                        reminderTimeoutMinutes: fu?.reminder?.['timeout-minutes'],
                        reminderRepeat: fu?.reminder?.repeat,
                        reminderEnabled: fu?.reminder?.enabled,
                        createdAt: (fu?.metadata?.created as string) || (meta.created as string) || new Date().toISOString(),
                    };
                });
            } else {
                prompt.followUps = [];
            }

            return prompt;
        } catch (err) {
            debugLog(`[PromptQueueManager] _entryToQueuedPrompt error: ${err}`, 'ERROR', 'queue');
            return undefined;
        }
    }

    /** Convert an in-memory QueuedPrompt to a QueueFileYaml document for disk storage. */
    private _queuedPromptToDoc(item: QueuedPrompt, quest?: string): QueueFileYaml {
        const mainPrompt: QueuePromptYaml = {
            id: 'P1',
            name: 'Main Prompt',
            type: 'main',
            'prompt-text': item.originalText,
            'expanded-text': item.expandedText,
            template: item.template || '(None)',
            'answer-wrapper': item.answerWrapper,
        };

        // Reminder config
        if (item.reminderEnabled || item.reminderTemplateId) {
            const reminder: QueueReminderConfig = {
                enabled: item.reminderEnabled,
                'template-id': item.reminderTemplateId,
                'timeout-minutes': item.reminderTimeoutMinutes,
                repeat: item.reminderRepeat,
                'sent-count': item.reminderSentCount || 0,
                'last-sent-at': item.lastReminderAt || null,
                queued: item.reminderQueued,
            };
            mainPrompt.reminder = reminder;
        }

        // Execution state
        if (item.requestId || item.expectedRequestId || item.sentAt || item.error || (item.followUpIndex && item.followUpIndex > 0)) {
            mainPrompt.execution = {
                'request-id': item.requestId || null,
                'expected-request-id': item.expectedRequestId || null,
                'sent-at': item.sentAt || null,
                error: item.error || null,
                'follow-up-index': item.followUpIndex || 0,
            };
        }

        const allPrompts: QueuePromptYaml[] = [mainPrompt];

        // Pre-prompts
        if (item.prePrompts && item.prePrompts.length > 0) {
            const preRefs: string[] = [];
            item.prePrompts.forEach((pp, idx) => {
                const ppId = `pre-${idx + 1}`;
                preRefs.push(ppId);
                allPrompts.push({
                    id: ppId,
                    type: 'preprompt',
                    'prompt-text': pp.text,
                    template: pp.template,
                    execution: pp.status !== 'pending' ? {
                        'sent-at': pp.status === 'sent' ? new Date().toISOString() : null,
                        error: pp.status === 'error' ? 'pre-prompt failed' : null,
                    } : undefined,
                });
            });
            mainPrompt['pre-prompt-refs'] = preRefs;
        }

        // Follow-ups
        if (item.followUps && item.followUps.length > 0) {
            const fuRefs: string[] = [];
            item.followUps.forEach(fu => {
                const fuId = fu.id || randomUUID();
                fuRefs.push(fuId);
                const fuPrompt: QueuePromptYaml = {
                    id: fuId,
                    type: 'followup',
                    'prompt-text': fu.originalText,
                    template: fu.template,
                    metadata: { created: fu.createdAt },
                };
                if (fu.reminderEnabled || fu.reminderTemplateId) {
                    fuPrompt.reminder = {
                        enabled: fu.reminderEnabled,
                        'template-id': fu.reminderTemplateId,
                        'timeout-minutes': fu.reminderTimeoutMinutes,
                        repeat: fu.reminderRepeat,
                    };
                }
                allPrompts.push(fuPrompt);
            });
            mainPrompt['follow-up-refs'] = fuRefs;
        }

        return {
            meta: {
                id: item.id,
                quest: quest || undefined,
                status: item.status,
                created: item.createdAt,
                'main-prompt': 'P1',
            },
            'prompt-queue': allPrompts,
        };
    }

    private trimSentHistory(): void {
        // Keep at most MAX_SENT_HISTORY sent items
        const sent = this._items.filter(i => i.status === 'sent');
        if (sent.length > MAX_SENT_HISTORY) {
            const removeCount = sent.length - MAX_SENT_HISTORY;
            let removed = 0;
            this._items = this._items.filter(i => {
                if (i.status === 'sent' && removed < removeCount) { removed++; return false; }
                return true;
            });
        }
        // Hard cap on total items
        if (this._items.length > MAX_TOTAL_ITEMS) {
            // Remove oldest sent items first, then oldest pending
            const excess = this._items.length - MAX_TOTAL_ITEMS;
            const sentItems = this._items.filter(i => i.status === 'sent');
            const toRemove = new Set<string>();
            for (let i = 0; i < Math.min(excess, sentItems.length); i++) {
                toRemove.add(sentItems[i].id);
            }
            if (toRemove.size < excess) {
                // Also remove oldest pending/error items (from end)
                const rest = this._items.filter(i => i.status !== 'sending' && !toRemove.has(i.id));
                for (let i = rest.length - 1; i >= 0 && toRemove.size < excess; i--) {
                    toRemove.add(rest[i].id);
                }
            }
            this._items = this._items.filter(i => !toRemove.has(i.id));
        }
    }
}

// Lazy import helper to avoid circular dependency
function await_import_ChatVariablesStore(): { quest: string } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ChatVariablesStore } = require('../managers/chatVariablesStore');
        return ChatVariablesStore.instance;
    } catch { return undefined; }
}
