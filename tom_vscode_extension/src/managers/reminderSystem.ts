/**
 * Reminder System (§3.4 — "Are You Alive?")
 *
 * Detects when a sent prompt has not received an answer within a
 * configurable timeout and auto-queues a reminder prompt.
 * Templates are CRUD-managed and persisted to the config file.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getConfigPath } from '../handlers/handler_shared';
import { PromptQueueManager, QueuedPrompt } from './promptQueueManager';
import { logQueue } from '../utils/queueLogger';

// ============================================================================
// Types
// ============================================================================

export interface ReminderTemplate {
    id: string;
    name: string;
    prompt: string;      // Template text with ${variables}
    isDefault: boolean;
}

export interface ReminderConfig {
    enabled: boolean;
    defaultTemplateId: string;
    defaultTimeoutMinutes: number;   // min: 1, default: 5
}

// ============================================================================
// Singleton
// ============================================================================

const DEFAULT_TEMPLATE: ReminderTemplate = {
    id: 'default',
    name: 'Are you alive?',
    prompt: 'Are you still there? The previous prompt has been waiting for {{timeoutMinutes}} minutes without a response. Please continue or let me know if there\'s an issue.',
    isDefault: true,
};

const RETRY_TEMPLATE: ReminderTemplate = {
    id: 'retry',
    name: 'Retry last prompt',
    prompt: 'The previous prompt didn\'t receive a response. Please try again.',
    isDefault: false,
};

export class ReminderSystem {
    private static _inst: ReminderSystem | undefined;

    private _templates: ReminderTemplate[] = [];
    private _config: ReminderConfig = { enabled: true, defaultTemplateId: 'default', defaultTimeoutMinutes: 5 };
    private _timer?: ReturnType<typeof setInterval>;
    private _queueListener?: vscode.Disposable;
    private _answerListener?: vscode.Disposable;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    public readonly onDidChange = this._onDidChange.event;

    private _ctx!: vscode.ExtensionContext;

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (ReminderSystem._inst) { return; }
        const r = new ReminderSystem();
        r._ctx = ctx;
        r.loadFromConfig();
        r.startWatching();
        ReminderSystem._inst = r;
    }

    static get instance(): ReminderSystem {
        if (!ReminderSystem._inst) { throw new Error('ReminderSystem not initialised'); }
        return ReminderSystem._inst;
    }

    dispose(): void {
        this.stopWatching();
        this._onDidChange.dispose();
    }

    // ----- accessors ---------------------------------------------------------

    get templates(): readonly ReminderTemplate[] { return this._templates; }
    get config(): Readonly<ReminderConfig> { return { ...this._config }; }

    // ----- template CRUD -----------------------------------------------------

    addTemplate(t: Omit<ReminderTemplate, 'id'>): ReminderTemplate {
        const full: ReminderTemplate = { ...t, id: randomUUID() };
        if (full.isDefault) { this._templates.forEach(x => x.isDefault = false); }
        this._templates.push(full);
        this.saveToConfig();
        this._onDidChange.fire();
        return full;
    }

    updateTemplate(id: string, patch: Partial<Omit<ReminderTemplate, 'id'>>): void {
        const t = this._templates.find(x => x.id === id);
        if (!t) { return; }
        if (patch.isDefault) { this._templates.forEach(x => x.isDefault = false); }
        Object.assign(t, patch);
        this.saveToConfig();
        this._onDidChange.fire();
    }

    removeTemplate(id: string): void {
        this._templates = this._templates.filter(x => x.id !== id);
        if (this._config.defaultTemplateId === id && this._templates.length > 0) {
            this._templates[0].isDefault = true;
            this._config.defaultTemplateId = this._templates[0].id;
        }
        this.saveToConfig();
        this._onDidChange.fire();
    }

    // ----- config update -----------------------------------------------------

    updateConfig(patch: Partial<ReminderConfig>): void {
        Object.assign(this._config, patch);
        if (this._config.defaultTimeoutMinutes < 1) { this._config.defaultTimeoutMinutes = 1; }
        this.saveToConfig();
        this._onDidChange.fire();
    }

    // ----- watching & timeout check ------------------------------------------

    private startWatching(): void {
        // Check every 30 seconds for prompts that have been waiting too long
        this._timer = setInterval(() => this.checkTimeouts(), 30_000);

        // Listen for answers to cancel pending reminders
        try {
            const queue = PromptQueueManager.instance;
            this._answerListener = queue.onAnswerReceived(() => {
                this.cancelPendingReminders();
            });
        } catch { /* queue not ready yet; will bind later */ }
    }

    private stopWatching(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = undefined; }
        this._queueListener?.dispose();
        this._answerListener?.dispose();
    }

    /** Re-bind to queue if it wasn't ready during init. */
    bindToQueue(): void {
        if (this._answerListener) { return; }
        try {
            const queue = PromptQueueManager.instance;
            this._answerListener = queue.onAnswerReceived(() => {
                this.cancelPendingReminders();
            });
        } catch { /* still not ready */ }
    }

    private async checkTimeouts(): Promise<void> {
        if (!this._config.enabled) { return; }

        let queue: PromptQueueManager;
        try { queue = PromptQueueManager.instance; } catch { return; }

        const now = Date.now();

        // Check if there's already a pending reminder in the queue
        const hasPendingReminder = queue.items.some(i => i.type === 'reminder' && (i.status === 'pending' || i.status === 'staged'));

        for (const item of queue.items) {
            if (item.status !== 'sending') { continue; }
            // Skip if already has a queued reminder or there's already a pending reminder in queue
            if (item.reminderQueued || hasPendingReminder) {
                logQueue(`Reminder check for ${item.id}: skipped (reminderQueued=${item.reminderQueued}, hasPendingReminder=${hasPendingReminder})`);
                continue;
            }
            if (!item.sentAt) { continue; }

            const sentTime = new Date(item.sentAt).getTime();
            const timeoutMinutes = queue.responseFileTimeoutMinutes || this._config.defaultTimeoutMinutes;
            const timeoutMs = timeoutMinutes * 60_000;
            const elapsed = Math.round((now - sentTime) / 60_000);

            if (now - sentTime < timeoutMs) {
                logQueue(`Reminder check for ${item.id}: templateId=${item.reminderTemplateId}, reminderEnabled=${item.reminderEnabled}, elapsed=${elapsed}min, timeout=${timeoutMinutes}min → skipped: not due yet`);
                continue;
            }

            // Timeout exceeded — queue a reminder
            const templateId = item.reminderTemplateId ?? this._config.defaultTemplateId;

            // __none__ means explicitly no reminder for this item
            if (templateId === '__none__') {
                logQueue(`Reminder check for ${item.id}: templateId=__none__ → skipped: reminders disabled`);
                continue;
            }

            const template = this._templates.find(t => t.id === templateId) ?? this._templates[0];
            if (!template) {
                logQueue(`Reminder check for ${item.id}: no template found for id=${templateId} → skipped`);
                continue;
            }

            logQueue(`Reminder check for ${item.id}: templateId=${templateId}, reminderEnabled=${item.reminderEnabled}, elapsed=${elapsed}min, timeout=${timeoutMinutes}min → generating`);

            const templateLabel = item.template || '(None)';
            const requestId = item.requestId || '';
            const expectedRequestId = item.expectedRequestId || '';
            const createdAt = item.createdAt || '';
            const followUpIndex = item.followUpIndex || 0;
            const followUpTotal = (item.followUps || []).length;
            const activeFollowUp = followUpIndex > 0 && followUpIndex <= followUpTotal
                ? item.followUps?.[followUpIndex - 1]
                : undefined;
            const followUpText = activeFollowUp?.originalText || '';
            const reminderSentCount = item.reminderSentCount || 0;
            const queueLength = queue.items.length;
            const reminderText = template.prompt
                .replace(/\{\{timeoutMinutes\}\}/g, String(timeoutMinutes))
                .replace(/\{\{waitingMinutes\}\}/g, String(elapsed))
                .replace(/\{\{originalPrompt\}\}/g, item.originalText.substring(0, 200))
                .replace(/\{\{followUpIndex\}\}/g, String(followUpIndex))
                .replace(/\{\{followUpTotal\}\}/g, String(followUpTotal))
                .replace(/\{\{sentAt\}\}/g, item.sentAt || '')
                .replace(/\{\{followUpText\}\}/g, followUpText)
                .replace(/\{\{promptId\}\}/g, item.id)
                .replace(/\{\{promptType\}\}/g, item.type)
                .replace(/\{\{status\}\}/g, item.status)
                .replace(/\{\{template\}\}/g, templateLabel)
                .replace(/\{\{requestId\}\}/g, requestId)
                .replace(/\{\{expectedRequestId\}\}/g, expectedRequestId)
                .replace(/\{\{createdAt\}\}/g, createdAt)
                .replace(/\{\{reminderSentCount\}\}/g, String(reminderSentCount))
                .replace(/\{\{queueLength\}\}/g, String(queueLength));

            // Mark the item so we don't re-queue
            (item as QueuedPrompt).reminderQueued = true;

            // Insert reminder at position 1 (right after current sending item)
            // Reminders start as pending so they auto-send when nothing is sending
            await queue.enqueue({
                originalText: reminderText,
                type: 'reminder',
                position: 1,
                initialStatus: 'pending',
            });
        }
    }

    /** Remove pending reminder items from the queue when an answer arrives. */
    private cancelPendingReminders(): void {
        let queue: PromptQueueManager;
        try { queue = PromptQueueManager.instance; } catch { return; }

        // Find reminder items that are still pending
        const pendingReminders = queue.items.filter(
            i => i.type === 'reminder' && i.status === 'pending'
        );
        for (const r of pendingReminders) {
            queue.remove(r.id);
        }
    }

    // ----- persistence (config file) -----------------------------------------

    private loadFromConfig(): void {
        try {
            const configPath = getConfigPath();
            if (!configPath || !fs.existsSync(configPath)) {
                this._templates = [{ ...DEFAULT_TEMPLATE }, { ...RETRY_TEMPLATE }];
                return;
            }
            const raw = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw);
            const reminders = (config?.reminders && typeof config.reminders === 'object') ? config.reminders : {};

            if (Array.isArray(reminders.templates) && reminders.templates.length > 0) {
                this._templates = reminders.templates;
            } else {
                this._templates = [{ ...DEFAULT_TEMPLATE }, { ...RETRY_TEMPLATE }];
            }

            if (reminders.config && typeof reminders.config === 'object') {
                this._config = {
                    enabled: reminders.config.enabled ?? true,
                    defaultTemplateId: reminders.config.defaultTemplateId ?? 'default',
                    defaultTimeoutMinutes: Math.max(1, reminders.config.defaultTimeoutMinutes ?? 5),
                };
            }
        } catch {
            this._templates = [{ ...DEFAULT_TEMPLATE }, { ...RETRY_TEMPLATE }];
        }
    }

    private saveToConfig(): void {
        try {
            const configPath = getConfigPath();
            if (!configPath) { return; }
            let config: Record<string, unknown> = {};
            if (fs.existsSync(configPath)) {
                config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
            const reminders = (config.reminders && typeof config.reminders === 'object')
                ? (config.reminders as Record<string, unknown>)
                : {};
            reminders.templates = this._templates;
            reminders.config = this._config;
            config.reminders = reminders;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        } catch { /* ignore */ }
    }
}
