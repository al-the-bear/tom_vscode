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
    readQueueSettings,
    writeQueueSettings,
    type QueueEntryFile,
    type QueueFileYaml,
    type QueuePromptYaml,
    type QueueReminderConfig,
} from '../storage/queueFileStorage';
import { debugLog } from '../utils/debugLogger';
import { logQueue, logQueueError, promptPreview } from '../utils/queueLogger';
import { applyRepetitionAffixes, computeRepeatDecision, convertStagedToPending, shouldAutoPauseOnEmpty } from '../utils/queueStep3Utils';
import { resolveVariables } from '../utils/variableResolver.js';
import {
    buildAnswerFilePath,
    shouldWatchAnswerFile,
    extractRequestIdFromAnswerFilename,
    findMatchingAnswerFile,
    resolveDetectedRequestId,
    computeHealthCheckDecisions,
} from '../utils/queueStep4Utils';
import { writeWindowState } from '../handlers/windowStatusPanel-handler';
import { TrailService } from '../services/trailService';

// ============================================================================
// Types
// ============================================================================

export type QueuedPromptStatus = 'staged' | 'pending' | 'sending' | 'sent' | 'error';
export type QueuedPromptType = 'normal' | 'timed' | 'reminder';

/**
 * Which backend a queued prompt goes through. `copilot` is the
 * historical behaviour (answer-file polling); `anthropic` routes the
 * prompt through AnthropicHandler.sendMessage, which itself forks
 * into Direct / Agent SDK / VS Code LM / Local LLM based on the
 * profile's selected configuration. See
 * `doc/multi_transport_prompt_queue_revised.md` §2 decision 1.
 */
export type QueuedTransport = 'copilot' | 'anthropic';

export interface QueuedFollowUpPrompt {
    id: string;
    originalText: string;
    template?: string;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;         // How many times this follow-up has been sent (0-based counter)
    answerWaitMinutes?: number;
    createdAt: string;
    // Multi-transport fields (design doc §4.1).
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;   // may reference an Anthropic config OR a Local LLM config
    answerText?: string;          // captured text from a direct (anthropic) send
}

export interface QueuedPrePrompt {
    text: string;
    template?: string;
    status: 'pending' | 'sent' | 'error';
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;         // How many times this pre-prompt has been sent (0-based counter)
    answerWaitMinutes?: number;
    reminderTemplateId?: string;
    reminderTimeoutMinutes?: number;
    reminderRepeat?: boolean;
    reminderEnabled?: boolean;
    // Multi-transport fields (design doc §4.1).
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    answerText?: string;
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
    repeatCount?: number | string;
    resolvedRepeatCount?: number; // Cached resolved value when repeatCount is a variable name
    repeatIndex?: number;
    repeatPrefix?: string;
    repeatSuffix?: string;
    templateRepeatCount?: number | string; // Repeat the entire template this many times
    templateRepeatIndex?: number;  // Current template repeat iteration (0-based)
    answerWaitMinutes?: number;   // If > 0, auto-advance after N minutes instead of waiting for answer file
    // Multi-transport fields (design doc §4.1). Items without `transport`
    // resolve to 'copilot' at dispatch time — byte-identical to the
    // pre-multi-transport behaviour.
    transport?: QueuedTransport;
    anthropicProfileId?: string;
    anthropicConfigId?: string;
    answerText?: string;
}

// ============================================================================
// Singleton
// ============================================================================

const MAX_SENT_HISTORY = 50;
const MAX_TOTAL_ITEMS = 100;
const DEFAULT_REMINDER_TEMPLATE_ID = 'default';
const DEFAULT_REMINDER_TEXT = 'Are you still there? The previous prompt has been waiting for {{timeoutMinutes}} minutes without a response. Please continue or let me know if there\'s an issue.';
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const ANSWER_POLL_INTERVAL_MS = 30_000;

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

/**
 * Resolve a repeat count value. If it's a number, return it directly.
 * If it's a string, try to get the value from a chat variable with that name.
 * Returns 1 if the value cannot be determined.
 */
export function resolveRepeatCount(value: number | string | undefined): number {
    if (value === undefined || value === null) {
        return 1;
    }
    if (typeof value === 'number') {
        return Math.max(1, Math.round(value));
    }
    // String value - try to parse as number first
    const parsed = parseInt(String(value), 10);
    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }
    // Try to get from chat variable
    const varName = String(value).trim();
    if (!varName) {
        return 1;
    }
    try {
        const chatStore = await_import_ChatVariablesStore() as any;
        if (chatStore && typeof chatStore.getRaw === 'function') {
            // Try both with and without 'custom.' prefix
            let varValue = chatStore.getRaw(`custom.${varName}`);
            if (varValue === undefined || varValue === '' || varValue === null) {
                varValue = chatStore.getRaw(varName);
            }
            if (varValue !== undefined && varValue !== '' && varValue !== null) {
                const resolved = parseInt(String(varValue), 10);
                if (!isNaN(resolved) && resolved > 0) {
                    debugLog(`[PromptQueueManager] Resolved repeat count '${varName}' = ${resolved}`, 'DEBUG', 'queue');
                    return resolved;
                }
            }
        }
    } catch (e) {
        debugLog(`[PromptQueueManager] Failed to resolve repeat count variable '${varName}': ${e}`, 'WARN', 'queue');
    }
    debugLog(`[PromptQueueManager] Could not resolve repeat count '${varName}', defaulting to 1`, 'DEBUG', 'queue');
    return 1;
}

export class PromptQueueManager {
    private static _inst: PromptQueueManager | undefined;

    private _items: QueuedPrompt[] = [];
    private _autoSendEnabled = true;
    private _autoSendDelayMs = 2000;
    private _autoStartEnabled = false;
    private _autoPauseEnabled = true;
    private _autoContinueEnabled = false;
    private _responseFileTimeoutMinutes = 60;
    private _defaultReminderTemplateId: string | undefined;
    private _autoContinueTimer?: ReturnType<typeof setTimeout>;
    private _answerWatcher?: fs.FSWatcher;
    private _timeoutWatcher?: ReturnType<typeof setInterval>;
    private _healthCheckTimer?: ReturnType<typeof setInterval>;
    private _answerPollTimer?: ReturnType<typeof setInterval>;
    private _statusBarItem?: vscode.StatusBarItem;
    private _statusBarChangeDisposable?: vscode.Disposable;
    private _processing = false;
    private _processingAnswerFile = false;

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
        const lastMatch = (pattern: RegExp): string | undefined => {
            const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
            const matcher = new RegExp(pattern.source, flags);
            let match: RegExpExecArray | null = null;
            let last: string | undefined;
            while ((match = matcher.exec(expanded)) !== null) {
                const candidate = match[1]?.trim();
                if (candidate) {
                    last = candidate;
                }
            }
            return last;
        };

        // Prefer explicit trailing request-id markers in the prompt body.
        const explicitRequestId = lastMatch(/Request ID(?: for this prompt)?\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
        if (explicitRequestId) {
            return explicitRequestId;
        }

        // If a concrete answer-file path is included, use the filename stem.
        const answerPathRequestId = lastMatch(/\/([A-Za-z0-9_.-]+)_answer\.json\b/i);
        if (answerPathRequestId) {
            return answerPathRequestId;
        }

        // Fallback: pick the last requestId-like occurrence rather than the first,
        // because templates can contain examples and context blocks with older IDs.
        const jsonRequestId = lastMatch(/"requestId"\s*:\s*"([^"]+)"/i);
        if (jsonRequestId) {
            return jsonRequestId;
        }

        const inlineRequestId = lastMatch(/\brequestId\b\s*[:=]\s*['"]([^'"]+)['"]/i);
        if (inlineRequestId) {
            return inlineRequestId;
        }

        return undefined;
    }

    private _promptLikelyTargetsRequestId(expanded: string, requestId: string): boolean {
        if (!expanded || !requestId) {
            return false;
        }
        return expanded.includes(`${requestId}_answer.json`)
            || expanded.includes(`Request ID: ${requestId}`)
            || expanded.includes(`Request ID for this prompt: ${requestId}`)
            || expanded.includes(`"requestId": "${requestId}"`);
    }

    private async _buildExpandedText(
        originalText: string,
        template?: string,
        answerWrapper?: boolean,
        repetition?: { repeatCount?: number; repeatIndex?: number; repeatPrefix?: string; repeatSuffix?: string },
    ): Promise<string> {
        const repeatCount = Math.max(0, Math.round(repetition?.repeatCount || 0));
        const repeatIndex = Math.max(0, Math.round(repetition?.repeatIndex || 0));
        const repeatNumber = repeatIndex + 1;
        const withAffixes = applyRepetitionAffixes({
            originalText,
            repeatCount,
            repeatIndex,
            repeatPrefix: repetition?.repeatPrefix,
            repeatSuffix: repetition?.repeatSuffix,
        });

        // Resolve repeat affix placeholders via the standard variable resolver.
        // repeatIndex is 0-based, repeatNumber is 1-based (repeatIndex + 1).
        // Supported syntax for repeat placeholders is ${repeatNumber}, ${repeatIndex}, ${repeatCount}.
        // Mustache placeholders are intentionally not supported for repeat affixes.
        const withResolvedAffixes = resolveVariables(withAffixes, {
            includeEditor: false,
            unresolvedBehavior: 'empty',
            enableJsExpressions: true,
            values: {
                repeatCount: String(repeatCount),
                repeatIndex: String(repeatIndex),
                repeatNumber: String(repeatNumber),
            },
        });

        let expanded = await expandTemplate(withResolvedAffixes, { includeEditorContext: false });
        expanded = await applyTemplateWrapping(expanded, template ?? '(None)', answerWrapper);
        return expanded;
    }

    private updateWindowStatus(status: 'prompt-sent' | 'answer-received'): void {
        try {
            const quest = (await_import_ChatVariablesStore())?.quest || '';
            const windowId = getWindowStatusWindowId();
            const workspaceName = getWindowStatusWorkspaceName();
            // Keep queue status for future multi-subsystem routing, and mirror
            // current queue processing into copilot subsystem status.
            writeWindowState(windowId, workspaceName, quest, 'queue', status);
            writeWindowState(windowId, workspaceName, quest, 'copilot', status);
        } catch {
            // Best-effort status panel update; queue processing must continue.
        }
    }

    // ----- lifecycle ---------------------------------------------------------

    static init(ctx: vscode.ExtensionContext): void {
        if (PromptQueueManager._inst) { return; }
        logQueue('PromptQueueManager initialising');
        const m = new PromptQueueManager();
        m._ctx = ctx;
        m.restore();
        m.setupAnswerWatcher();
        m.startTimeoutWatcher();
        m.startHealthCheck();
        m.startAnswerPolling();
        m.setupStatusBarItem();
        // Start file watcher for cross-window sync
        startQueueWatching();
        m._queueChangeDisposable = onQueueChanged(() => {
            debugLog('[PromptQueueManager] Queue files changed on disk, reloading', 'INFO', 'queue');
            m._reloadFromDisk();
        });
        PromptQueueManager._inst = m;
        logQueue(`PromptQueueManager initialised — ${m._items.length} items restored, autoSend=${m._autoSendEnabled}`);
    }

    static get instance(): PromptQueueManager {
        if (!PromptQueueManager._inst) { throw new Error('PromptQueueManager not initialised'); }
        return PromptQueueManager._inst;
    }

    dispose(): void {
        logQueue('PromptQueueManager disposing');
        this._answerWatcher?.close();
        for (const timer of this._renameDebounceTimers.values()) { clearTimeout(timer); }
        this._renameDebounceTimers.clear();
        if (this._autoContinueTimer) {
            clearTimeout(this._autoContinueTimer);
            this._autoContinueTimer = undefined;
        }
        if (this._timeoutWatcher) {
            clearInterval(this._timeoutWatcher);
            this._timeoutWatcher = undefined;
        }
        this.stopHealthCheck();
        this.stopAnswerPolling();
        this._queueChangeDisposable?.dispose();
        this._statusBarChangeDisposable?.dispose();
        this._statusBarItem?.dispose();
        stopQueueWatching();
        this._onDidChange.dispose();
        this._onPromptSent.dispose();
        this._onAnswerReceived.dispose();
    }

    private setupStatusBarItem(): void {
        if (this._statusBarItem) { return; }
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this._statusBarItem.command = 'tomAi.editor.promptQueue';
        this._statusBarItem.name = 'Prompt Queue Status';
        this._statusBarItem.show();
        this._statusBarChangeDisposable = this.onDidChange(() => this.updateStatusBarItem());
        this.updateStatusBarItem();
    }

    private updateStatusBarItem(): void {
        if (!this._statusBarItem) { return; }
        const pending = this._items.filter(i => i.status === 'pending').length;
        const sending = this._items.filter(i => i.status === 'sending').length;

        if (sending > 0) {
            this._statusBarItem.text = '$(sync~spin) Queue Sending...';
            this._statusBarItem.tooltip = `Prompt Queue active: sending ${sending}, pending ${pending}`;
            return;
        }

        if (this._autoSendEnabled) {
            this._statusBarItem.text = `$(play) Queue Active (${pending} pending)`;
            this._statusBarItem.tooltip = 'Prompt Queue auto-send enabled';
            return;
        }

        this._statusBarItem.text = '$(debug-pause) Queue Paused';
        this._statusBarItem.tooltip = `Prompt Queue paused (${pending} pending)`;
    }

    // ----- answer file watcher -----------------------------------------------

    private get answerDirectory(): string {
        return getCopilotChatAnswerFolderAbsolute();
    }

    private getAnswerFilePathForRequestId(requestId?: string): string {
        return buildAnswerFilePath({
            folder: this.answerDirectory,
            sessionId: vscode.env.sessionId,
            machineId: vscode.env.machineId,
            requestId,
        });
    }

    private get answerFilePath(): string {
        const sending = this._items.find(i => i.status === 'sending');
        return this.getAnswerFilePathForRequestId(sending?.expectedRequestId);
    }

    private _renameDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private setupAnswerWatcher(): void {
        const dir = this.answerDirectory;
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

        this._answerWatcher?.close();

        logQueue(`Answer watcher started for ${dir} (pattern: *_answer.json)`);
        debugLog(`[PromptQueueManager] Setting up answer watcher for ${dir}`, 'INFO', 'queue');
        this._answerWatcher = fs.watch(dir, (event, filename) => {
            const fileNameText = typeof filename === 'string' ? filename : undefined;
            debugLog(`[PromptQueueManager] File watch event: ${event} ${fileNameText || '(none)'}`, 'DEBUG', 'queue');
            if (!shouldWatchAnswerFile(fileNameText)) { return; }
            const changedPath = path.join(dir, String(fileNameText));

            if (event === 'change') {
                // Direct modification — process immediately.
                logQueue(`Answer file changed (event=${event}, file=${fileNameText})`);
                debugLog(`[PromptQueueManager] Answer file changed, calling onAnswerFileChanged for ${changedPath}`, 'INFO', 'queue');
                void this.onAnswerFileChanged(changedPath);
            } else if (event === 'rename') {
                // 'rename' fires on file creation — delay briefly so content is flushed.
                const key = String(fileNameText);
                const existing = this._renameDebounceTimers.get(key);
                if (existing) { clearTimeout(existing); }
                this._renameDebounceTimers.set(key, setTimeout(() => {
                    this._renameDebounceTimers.delete(key);
                    if (fs.existsSync(changedPath)) {
                        try {
                            const stat = fs.statSync(changedPath);
                            if (stat.size > 2) {
                                logQueue(`Answer file created (rename event, file=${fileNameText})`);
                                debugLog(`[PromptQueueManager] Rename event with content, calling onAnswerFileChanged for ${changedPath}`, 'INFO', 'queue');
                                void this.onAnswerFileChanged(changedPath);
                            }
                        } catch { /* stat failed, skip */ }
                    }
                }, 500));
            }
        });
    }

    private restartAnswerWatcher(): void {
        try {
            this._answerWatcher?.close();
        } catch {
            // no-op
        }
        this._answerWatcher = undefined;
        this.setupAnswerWatcher();
    }

    private startTimeoutWatcher(): void {
        if (this._timeoutWatcher) { return; }
        this._timeoutWatcher = setInterval(() => {
            void this.checkResponseTimeouts();
        }, 30_000);
    }

    private startHealthCheck(): void {
        if (this._healthCheckTimer) { return; }
        this._healthCheckTimer = setInterval(() => {
            void this.runHealthCheck();
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthCheck(): void {
        if (!this._healthCheckTimer) { return; }
        clearInterval(this._healthCheckTimer);
        this._healthCheckTimer = undefined;
    }

    private startAnswerPolling(): void {
        if (this._answerPollTimer) { return; }
        this._answerPollTimer = setInterval(() => {
            void this.pollForExpectedAnswer();
        }, ANSWER_POLL_INTERVAL_MS);
    }

    private stopAnswerPolling(): void {
        if (!this._answerPollTimer) { return; }
        clearInterval(this._answerPollTimer);
        this._answerPollTimer = undefined;
    }

    private async runHealthCheck(): Promise<void> {
        const pendingCount = this._items.filter(i => i.status === 'pending').length;
        const sendingCount = this._items.filter(i => i.status === 'sending').length;
        const sending = this._items.find(i => i.status === 'sending');
        const decisions = computeHealthCheckDecisions({
            hasAnswerWatcher: !!this._answerWatcher,
            autoSendEnabled: this._autoSendEnabled,
            pendingCount,
            sendingCount,
            answerDirectoryExists: fs.existsSync(this.answerDirectory),
            sendingSentAtIso: sending?.sentAt,
            responseFileTimeoutMinutes: this._responseFileTimeoutMinutes,
        });

        logQueue(`Health check: items=${this._items.length}, sending=${sendingCount}, pending=${pendingCount}, autoSend=${this._autoSendEnabled}`);

        if (decisions.shouldEnsureDirectory) {
            fs.mkdirSync(this.answerDirectory, { recursive: true });
            logQueue(`Health check recreated missing answer directory: ${this.answerDirectory}`);
        }

        if (decisions.shouldRestartWatcher) {
            logQueue('Health check restarting answer watcher');
            this.restartAnswerWatcher();
        }

        if (decisions.shouldTriggerSendNext) {
            logQueue('Health check detected pending prompts without active sending; triggering sendNext');
            await this.sendNext();
        }

        // Secondary safety net from Issue 7: scan for expected answer during health check.
        await this.pollForExpectedAnswer();
    }

    private async pollForExpectedAnswer(): Promise<void> {
        if (this._processingAnswerFile) {
            return;
        }
        const sending = this._items.find(i => i.status === 'sending');
        if (!sending || !sending.expectedRequestId) {
            return;
        }
        const dir = this.answerDirectory;
        if (!fs.existsSync(dir)) {
            return;
        }
        let files: string[] = [];
        try {
            files = fs.readdirSync(dir);
        } catch {
            return;
        }
        const matchingFile = findMatchingAnswerFile(files, sending.expectedRequestId);
        if (!matchingFile) {
            logQueue(`Poll: no matching answer file for requestId=${sending.expectedRequestId}`);
            return;
        }

        const fullPath = path.join(dir, matchingFile);
        debugLog(`[PromptQueueManager] Polling fallback matched expected answer file: ${fullPath}`, 'INFO', 'queue');
        await this.onAnswerFileChanged(fullPath);
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
        // Fix Issue 3 Bug A: respect reminderEnabled for ALL item types
        if (item.reminderEnabled === false) { return false; }
        if (item.type !== 'timed') { return true; }

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

        // Answer-wait timer: auto-advance after N minutes without waiting for answer file.
        if (sending.answerWaitMinutes && sending.answerWaitMinutes > 0) {
            const elapsedMs = Date.now() - new Date(sending.sentAt).getTime();
            const waitMs = sending.answerWaitMinutes * 60_000;
            if (elapsedMs >= waitMs) {
                logQueue(`Answer-wait timer expired for ${sending.id}: ${sending.answerWaitMinutes}min elapsed — auto-advancing`);
                try {
                    const hasNextStage = await this.dispatchNextStageForSendingItem(sending);
                    if (!hasNextStage) {
                        sending.status = 'sent';
                        sending.expectedRequestId = undefined;
                        sending.reminderSentCount = 0;
                        sending.lastReminderAt = undefined;
                        this.removePendingReminderFor(sending.id);

                        const resolvedTemplateRepeatCount = resolveRepeatCount(sending.templateRepeatCount);
                        logQueue(`Template repeat check (answer-wait): templateRepeatCount=${String(sending.templateRepeatCount)}, resolved=${resolvedTemplateRepeatCount}, templateRepeatIndex=${sending.templateRepeatIndex}, repeatCount=${String(sending.repeatCount)}`);
                        const repeatDecision = computeRepeatDecision({
                            repeatCount: sending.templateRepeatCount,
                            repeatIndex: sending.templateRepeatIndex,
                        }, resolvedTemplateRepeatCount);
                        if (repeatDecision.shouldRepeat) {
                            await this.enqueue({
                                originalText: sending.originalText,
                                template: sending.template,
                                answerWrapper: sending.answerWrapper,
                                answerWaitMinutes: sending.answerWaitMinutes,
                                type: sending.type,
                                repeatCount: sending.repeatCount,
                                repeatIndex: 0,
                                repeatPrefix: sending.repeatPrefix,
                                repeatSuffix: sending.repeatSuffix,
                                templateRepeatCount: sending.templateRepeatCount,
                                templateRepeatIndex: repeatDecision.nextRepeatIndex,
                                reminderTemplateId: sending.reminderTemplateId,
                                reminderTimeoutMinutes: sending.reminderTimeoutMinutes,
                                reminderRepeat: sending.reminderRepeat,
                                reminderEnabled: sending.reminderEnabled,
                                prePrompts: (sending.prePrompts || []).map(pp => ({
                                    text: pp.text,
                                    template: pp.template,
                                    repeatCount: pp.repeatCount,
                                    answerWaitMinutes: pp.answerWaitMinutes,
                                    reminderTemplateId: pp.reminderTemplateId,
                                    reminderTimeoutMinutes: pp.reminderTimeoutMinutes,
                                    reminderRepeat: pp.reminderRepeat,
                                    reminderEnabled: pp.reminderEnabled,
                                })),
                                followUps: (sending.followUps || []).map(f => ({
                                    originalText: f.originalText,
                                    template: f.template,
                                    repeatCount: f.repeatCount,
                                    answerWaitMinutes: f.answerWaitMinutes,
                                    reminderTemplateId: f.reminderTemplateId,
                                    reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                                    reminderRepeat: !!f.reminderRepeat,
                                    reminderEnabled: !!f.reminderEnabled,
                                })),
                                initialStatus: 'pending',
                                deferSend: true,
                            });
                            logQueue(`Repeat queued for answer-wait item ${sending.id}`);
                        }

                        this.persist();
                        this._onDidChange.fire();

                        if (this._autoSendEnabled) {
                            const pendingCount = this._items.filter(i => i.status === 'pending').length;
                            if (shouldAutoPauseOnEmpty(this._autoSendEnabled, pendingCount, this._autoPauseEnabled)) {
                                this._autoSendEnabled = false;
                                this.persistSettings();
                                this._onDidChange.fire();
                                logQueue('Queue empty — auto-pausing');
                            } else {
                                await this.delaySendNext();
                            }
                        }
                    }
                } catch (err) {
                    logQueueError(`checkResponseTimeouts/answerWait(${sending.id})`, err);
                }
            }
            return; // Skip reminder logic for answer-wait items
        }

        const timeoutMinutes = this.getActiveReminderTimeoutMinutes(sending);
        const elapsed = Math.round((Date.now() - new Date(sending.sentAt).getTime()) / 60_000);

        if (!this.isReminderEligible(sending)) {
            logQueue(`Reminder check for ${sending.id}: not eligible (reminderEnabled=${sending.reminderEnabled}, type=${sending.type}) — skipped`);
            return;
        }

        // Fix Issue 3 Defense: skip if template is explicitly '__none__'
        if (sending.reminderTemplateId === '__none__') {
            logQueue(`Reminder check for ${sending.id}: templateId=__none__ — skipped (no reminder)`);
            return;
        }

        const now = Date.now();
        const timeoutMs = timeoutMinutes * 60_000;
        const firstDue = new Date(sending.sentAt).getTime() + timeoutMs;
        if (now < firstDue) { return; }

        const reminderSentCount = sending.reminderSentCount || 0;
        const repeat = this.isReminderRepeatEnabled(sending);

        if (reminderSentCount > 0 && !repeat) {
            logQueue(`Reminder check for ${sending.id}: already sent ${reminderSentCount}x, repeat=false — skipped`);
            return;
        }

        if (reminderSentCount > 0 && sending.lastReminderAt) {
            const nextDue = new Date(sending.lastReminderAt).getTime() + timeoutMs;
            if (now < nextDue) {
                return;
            }
        }

        logQueue(`Reminder check for ${sending.id}: templateId=${sending.reminderTemplateId}, reminderEnabled=${sending.reminderEnabled}, elapsed=${elapsed}min, timeout=${timeoutMinutes}min → generating`);
        const reminderText = this.buildReminderText(sending);
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: reminderText });
            sending.reminderSentCount = reminderSentCount + 1;
            sending.lastReminderAt = new Date().toISOString();
            this.persist();
            this._onDidChange.fire();
            logQueue(`Reminder sent for ${sending.id} (count=${sending.reminderSentCount})`);
        } catch (err) {
            logQueueError('checkResponseTimeouts', err);
        }
    }

    private async onAnswerFileChanged(changedFilePath?: string): Promise<void> {
        if (this._processingAnswerFile) {
            debugLog('[PromptQueueManager] Answer processing already in progress; skipping re-entrant event', 'DEBUG', 'queue');
            return;
        }
        this._processingAnswerFile = true;

        try {
        const sending = this._items.find(i => i.status === 'sending');
        const filePath = changedFilePath || this.getAnswerFilePathForRequestId(sending?.expectedRequestId);
        logQueue(`Watching for answer at ${filePath}`);
        debugLog(`[PromptQueueManager] onAnswerFileChanged called, checking: ${filePath}`, 'DEBUG', 'queue');
        if (!fs.existsSync(filePath)) { 
            debugLog(`[PromptQueueManager] Answer file does not exist`, 'DEBUG', 'queue');
            return; 
        }

        let answer: Record<string, unknown> | undefined;
        let rawAnswerContent = '';
        let parseErrorMessage = '';
        try {
            rawAnswerContent = fs.readFileSync(filePath, 'utf-8');
            answer = JSON.parse(rawAnswerContent);
            debugLog(`[PromptQueueManager] Parsed answer file, requestId: ${(answer as any)?.requestId}`, 'DEBUG', 'queue');
        } catch (e) { 
            debugLog(`[PromptQueueManager] Failed to parse answer file: ${e}`, 'ERROR', 'queue');
            parseErrorMessage = String(e);
        }

        const answerAlreadyProcessed = !!(answer && typeof answer === 'object' && (answer as any).processed);

        // Fallback: recover requestId from raw content if JSON parsing failed.
        const recoveredRequestId = this._extractRequestIdFromExpandedPrompt(rawAnswerContent);
        if (!answer && recoveredRequestId) {
            const preview = rawAnswerContent.slice(0, 2000);
            answer = {
                requestId: recoveredRequestId,
                generatedMarkdown:
                    `An invalid answer file was received and recovered via fallback.\n\n`
                    + `source: ${filePath}\n`
                    + `parseError: ${parseErrorMessage || 'unknown'}\n\n`
                    + `--- raw content preview ---\n\n`
                    + `\`\`\`text\n${preview}\n\`\`\``,
            };
            debugLog(`[PromptQueueManager] Recovered requestId from invalid answer file: ${recoveredRequestId}`, 'WARN', 'queue');
        }

        this._onAnswerReceived.fire(answer);

        const answerRequestId = (answer && typeof answer === 'object' && typeof (answer as any).requestId === 'string')
            ? String((answer as any).requestId)
            : undefined;

        const filenameRequestId = extractRequestIdFromAnswerFilename(path.basename(filePath));
        const detectedRequest = resolveDetectedRequestId(filenameRequestId, answerRequestId);
        const resolvedAnswerRequestId = detectedRequest.requestId;
        if (detectedRequest.source !== 'none') {
            logQueue(`Answer requestId detected via ${detectedRequest.source}: ${resolvedAnswerRequestId}`);
        }

        // Strict sequencing and ownership:
        // - only active sending item may process an answer
        // - already-processed files are never processed again
        // - expected requestId must match when present
        if (!sending) {
            logQueue(`No sending item found in queue — ignoring answer file without processing. Items: ${this._items.map(i => `${i.id.substring(0, 8)}:${i.status}`).join(', ')}`);
            debugLog(`[PromptQueueManager] No sending item found in queue, ignoring without mutation: ${filePath}`, 'INFO', 'queue');
            return;
        }

        if (answerAlreadyProcessed) {
            debugLog(`[PromptQueueManager] Answer file already processed at ${(answer as any).processed}, skipping: ${filePath}`, 'DEBUG', 'queue');
            return;
        }

        if (sending.expectedRequestId && sending.expectedRequestId !== resolvedAnswerRequestId) {
            logQueue(`Answer file not matching — expected ${sending.expectedRequestId}, got ${resolvedAnswerRequestId}`);
            debugLog(`[PromptQueueManager] Ignoring answer with requestId=${resolvedAnswerRequestId}; waiting for expectedRequestId=${sending.expectedRequestId}`, 'DEBUG', 'queue');
            return;
        }

        // At this point the answer is relevant for the active sending item.
        if (resolvedAnswerRequestId) {
            try {
                const generatedMarkdown = (answer && typeof answer === 'object' && typeof (answer as any).generatedMarkdown === 'string')
                    ? String((answer as any).generatedMarkdown)
                    : '';
                const fallbackText = rawAnswerContent
                    ? `An answer file without generatedMarkdown was received.\n\nsource: ${filePath}\n\n\`\`\`json\n${rawAnswerContent}\n\`\`\``
                    : `An answer file event was received, but no readable content was available.\n\nsource: ${filePath}`;
                const trailText = generatedMarkdown.trim().length > 0 ? generatedMarkdown : fallbackText;
                const quest = await_import_ChatVariablesStore()?.quest || undefined;

                TrailService.instance.writeRawAnswer({ type: 'copilot' }, trailText, getWindowStatusWindowId(), resolvedAnswerRequestId, quest);
                TrailService.instance.writeSummaryAnswer(
                    { type: 'copilot' },
                    trailText,
                    {
                        requestId: resolvedAnswerRequestId,
                        comments: generatedMarkdown.trim().length > 0
                            ? undefined
                            : `invalid answer schema received from ${filePath}`,
                        references: [filePath],
                    },
                    quest,
                );
            } catch (trailErr) {
                debugLog(`[PromptQueueManager] Failed to write fallback trail answer: ${trailErr}`, 'WARN', 'queue');
            }
        }

        // At this point the answer is relevant for the active sending item.
        this.propagateAnswerResponseValues(answer);
        this.markAnswerFileProcessed(filePath, answer);

        logQueue(`Answer detected for ${sending.id}, requestId=${resolvedAnswerRequestId || '(none)'}`);
        debugLog(`[PromptQueueManager] Processing answer for sending item ${sending.id}`, 'INFO', 'queue');
        this.updateWindowStatus('answer-received');

        try {
            const hasNextStage = await this.dispatchNextStageForSendingItem(sending);
            if (!hasNextStage) {
                logQueue(`Marking item ${sending.id} as sent — status: sending → sent`);
                debugLog(`[PromptQueueManager] Marking item ${sending.id} as sent`, 'INFO', 'queue');
                sending.status = 'sent';
                sending.expectedRequestId = undefined;
                sending.reminderSentCount = 0;
                sending.lastReminderAt = undefined;
                this.removePendingReminderFor(sending.id);

                const resolvedTemplateRepeatCount = resolveRepeatCount(sending.templateRepeatCount);
                logQueue(`Template repeat check (answer-file): templateRepeatCount=${String(sending.templateRepeatCount)}, resolved=${resolvedTemplateRepeatCount}, templateRepeatIndex=${sending.templateRepeatIndex}, repeatCount=${String(sending.repeatCount)}`);
                const repeatDecision = computeRepeatDecision({
                    repeatCount: sending.templateRepeatCount,
                    repeatIndex: sending.templateRepeatIndex,
                }, resolvedTemplateRepeatCount);
                if (repeatDecision.shouldRepeat) {
                    await this.enqueue({
                        originalText: sending.originalText,
                        template: sending.template,
                        answerWrapper: sending.answerWrapper,
                        answerWaitMinutes: sending.answerWaitMinutes,
                        type: sending.type,
                        repeatCount: sending.repeatCount,
                        repeatIndex: 0,
                        repeatPrefix: sending.repeatPrefix,
                        repeatSuffix: sending.repeatSuffix,
                        templateRepeatCount: sending.templateRepeatCount,
                        templateRepeatIndex: repeatDecision.nextRepeatIndex,
                        reminderTemplateId: sending.reminderTemplateId,
                        reminderTimeoutMinutes: sending.reminderTimeoutMinutes,
                        reminderRepeat: sending.reminderRepeat,
                        reminderEnabled: sending.reminderEnabled,
                        prePrompts: (sending.prePrompts || []).map(pp => ({
                            text: pp.text,
                            template: pp.template,
                            repeatCount: pp.repeatCount,
                            answerWaitMinutes: pp.answerWaitMinutes,
                            reminderTemplateId: pp.reminderTemplateId,
                            reminderTimeoutMinutes: pp.reminderTimeoutMinutes,
                            reminderRepeat: pp.reminderRepeat,
                            reminderEnabled: pp.reminderEnabled,
                        })),
                        followUps: (sending.followUps || []).map(f => ({
                            originalText: f.originalText,
                            template: f.template,
                            repeatCount: f.repeatCount,
                            answerWaitMinutes: f.answerWaitMinutes,
                            reminderTemplateId: f.reminderTemplateId,
                            reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                            reminderRepeat: !!f.reminderRepeat,
                            reminderEnabled: !!f.reminderEnabled,
                        })),
                        initialStatus: 'pending',
                        deferSend: true,
                    });
                    logQueue(`Repeat ${repeatDecision.progressLabel} queued for item ${sending.id}`);
                }

                this.persist();
                this._onDidChange.fire();

                if (this._autoSendEnabled) {
                    const pendingCount = this._items.filter(i => i.status === 'pending').length;
                    if (shouldAutoPauseOnEmpty(this._autoSendEnabled, pendingCount, this._autoPauseEnabled)) {
                        this._autoSendEnabled = false;
                        this.persistSettings();
                        this._onDidChange.fire();
                        logQueue('Queue empty — auto-pausing');
                    } else {
                        // Send next pending item after delay
                        await this.delaySendNext();
                    }
                }
            }
        } catch (err) {
            sending.status = 'error';
            sending.error = String(err);
            logQueueError(`onAnswerFileChanged(${sending.id})`, err);
            this.persist();
            this._onDidChange.fire();
        }
        } finally {
            this._processingAnswerFile = false;
        }
    }

    private markAnswerFileProcessed(filePath: string, answer: Record<string, unknown> | undefined): void {
        if (!answer || typeof answer !== 'object') {
            debugLog(`[PromptQueueManager] markAnswerFileProcessed: no answer object`, 'DEBUG', 'queue');
            return;
        }
        try {
            const updated = { ...answer, processed: new Date().toISOString() };
            fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
            debugLog(`[PromptQueueManager] markAnswerFileProcessed: marked ${filePath}`, 'DEBUG', 'queue');
        } catch (e) {
            debugLog(`[PromptQueueManager] markAnswerFileProcessed: failed to update ${filePath}: ${e}`, 'WARN', 'queue');
        }
    }

    private propagateAnswerResponseValues(answer: Record<string, unknown> | undefined): void {
        debugLog(`[PromptQueueManager] propagateAnswerResponseValues called`, 'DEBUG', 'queue');
        if (!answer || typeof answer !== 'object') {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no answer object`, 'DEBUG', 'queue');
            return;
        }

        const rv = (answer as any).responseValues;
        if (!rv || typeof rv !== 'object') {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no responseValues in answer`, 'DEBUG', 'queue');
            return;
        }

        const normalized: Record<string, string> = {};
        for (const [k, v] of Object.entries(rv as Record<string, unknown>)) {
            if (!k) { continue; }
            if (v === undefined || v === null) { continue; }
            normalized[k] = String(v);
        }

        if (Object.keys(normalized).length === 0) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no values to propagate`, 'DEBUG', 'queue');
            return;
        }

        debugLog(`[PromptQueueManager] propagateAnswerResponseValues: propagating ${Object.keys(normalized).length} values: ${JSON.stringify(normalized)}`, 'INFO', 'queue');

        const answerRequestId = typeof (answer as any).requestId === 'string' ? (answer as any).requestId : undefined;

        try {
            const { updateChatResponseValues } = require('../handlers/handler_shared');
            updateChatResponseValues(normalized);
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: updated handler_shared`, 'DEBUG', 'queue');
        } catch (e) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: handler_shared error: ${e}`, 'WARN', 'queue');
        }

        try {
            const chatStore = await_import_ChatVariablesStore() as any;
            if (chatStore && typeof chatStore.setCustomBulk === 'function') {
                const builtIn = new Set(['quest', 'role', 'activeProjects', 'todo', 'todoFile']);
                const customValues: Record<string, string> = {};
                for (const [k, v] of Object.entries(normalized)) {
                    if (builtIn.has(k)) { continue; }
                    const key = k.startsWith('custom.') ? k.substring('custom.'.length) : k;
                    if (!key) { continue; }
                    customValues[key] = v;
                }
                if (Object.keys(customValues).length > 0) {
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: calling setCustomBulk with ${Object.keys(customValues).length} values: ${JSON.stringify(customValues)}`, 'INFO', 'queue');
                    chatStore.setCustomBulk(customValues, 'copilot', answerRequestId);
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: setCustomBulk completed`, 'DEBUG', 'queue');
                } else {
                    debugLog(`[PromptQueueManager] propagateAnswerResponseValues: no custom values to set (all built-in)`, 'DEBUG', 'queue');
                }
            } else {
                debugLog(`[PromptQueueManager] propagateAnswerResponseValues: chatStore not available or setCustomBulk not a function`, 'WARN', 'queue');
            }
        } catch (e) {
            debugLog(`[PromptQueueManager] propagateAnswerResponseValues: chatStore error: ${e}`, 'WARN', 'queue');
        }
    }

    // ----- queue CRUD --------------------------------------------------------

    get items(): readonly QueuedPrompt[] { return this._items; }
    get pendingCount(): number { return this._items.filter(i => i.status === 'pending').length; }
    get autoSendEnabled(): boolean { return this._autoSendEnabled; }
    get responseFileTimeoutMinutes(): number { return this._responseFileTimeoutMinutes; }

    set autoSendEnabled(v: boolean) {
        this._autoSendEnabled = v;
        logQueue(`Auto-send toggled: ${v ? 'on' : 'off'}`);
        this.persistSettings();
        this._onDidChange.fire();

        // If enabling auto-send and there are pending items not currently sending, start processing
        if (v && this._items.some(i => i.status === 'pending') && !this._items.some(i => i.status === 'sending')) {
            void this.sendNext();
        }
    }

    set responseFileTimeoutMinutes(v: number) {
        this._responseFileTimeoutMinutes = Math.max(5, Math.round(v || 60));
        this.persistSettings();
        this._onDidChange.fire();
    }

    get defaultReminderTemplateId(): string | undefined { return this._defaultReminderTemplateId; }

    set defaultReminderTemplateId(v: string | undefined) {
        this._defaultReminderTemplateId = v || undefined;
        this.persistSettings();
        this._onDidChange.fire();
    }

    get autoSendDelayMs(): number { return this._autoSendDelayMs; }
    set autoSendDelayMs(v: number) { this._autoSendDelayMs = Math.max(500, v); }

    get autoContinueEnabled(): boolean { return this._autoContinueEnabled; }
    set autoContinueEnabled(v: boolean) {
        this._autoContinueEnabled = v;
        logQueue(`Auto-continue toggled: ${v ? 'on' : 'off'}`);
        this.persistSettings();
        this._onDidChange.fire();
    }

    get autoStartEnabled(): boolean { return this._autoStartEnabled; }
    set autoStartEnabled(v: boolean) {
        this._autoStartEnabled = v;
        logQueue(`Auto-start toggled: ${v ? 'on' : 'off'}`);
        this.persistSettings();
        this._onDidChange.fire();
    }

    get autoPauseEnabled(): boolean { return this._autoPauseEnabled; }
    set autoPauseEnabled(v: boolean) {
        this._autoPauseEnabled = v;
        logQueue(`Auto-pause toggled: ${v ? 'on' : 'off'}`);
        this.persistSettings();
        this._onDidChange.fire();
    }

    /** Restart the queue: reset stuck "sending" items to "pending" and restart processing. */
    restartQueue(): void {
        logQueue('Restarting queue processing');
        let resetCount = 0;
        for (const item of this._items) {
            if (item.status === 'sending') {
                item.status = 'pending';
                resetCount++;
            }
        }
        this._processing = false;
        this._processingAnswerFile = false;
        if (resetCount > 0) {
            logQueue(`Reset ${resetCount} stuck sending items to pending`);
        }
        this._onDidChange.fire();
        // If auto-send is on, start processing
        if (this._autoSendEnabled && this._items.some(i => i.status === 'pending')) {
            void this.sendNext();
        }
    }

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
        prePrompts?: Array<{
            text: string;
            template?: string;
            repeatCount?: number | string;
            answerWaitMinutes?: number;
            reminderTemplateId?: string;
            reminderTimeoutMinutes?: number;
            reminderRepeat?: boolean;
            reminderEnabled?: boolean;
        }>;
        followUps?: Array<{
            originalText: string;
            template?: string;
            repeatCount?: number | string;
            answerWaitMinutes?: number;
            reminderTemplateId?: string;
            reminderTimeoutMinutes?: number;
            reminderRepeat?: boolean;
            reminderEnabled?: boolean;
        }>;
        repeatCount?: number | string;
        repeatIndex?: number;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        templateRepeatIndex?: number;
        answerWaitMinutes?: number;
        initialStatus?: 'staged' | 'pending';
        deferSend?: boolean;
    }): Promise<QueuedPrompt> {
        const resolvedRepeatCount = resolveRepeatCount(opts.repeatCount);
        const expanded = await this._buildExpandedText(
            opts.originalText,
            opts.template,
            opts.answerWrapper,
            {
                repeatCount: resolvedRepeatCount,
                repeatIndex: opts.repeatIndex,
                repeatPrefix: opts.repeatPrefix,
                repeatSuffix: opts.repeatSuffix,
            },
        );

        // Compute effective reminder template: provided value, or fall back to default
        let effectiveReminderTemplateId = opts.reminderTemplateId ?? this._defaultReminderTemplateId;
        // Fix Issue 3 Bug B: keep '__none__' as stored value (do NOT clear to undefined)
        // This preserves the explicit "no reminder" signal through the entire pipeline.
        const isNoReminder = effectiveReminderTemplateId === '__none__';

        const item: QueuedPrompt = {
            id: randomUUID(),
            template: opts.template ?? '(None)',
            answerWrapper: opts.answerWrapper || false,
            originalText: opts.originalText,
            expandedText: expanded,
            status: opts.initialStatus ?? 'pending',
            type: opts.type ?? 'normal',
            createdAt: new Date().toISOString(),
            reminderTemplateId: effectiveReminderTemplateId,
            reminderTimeoutMinutes: opts.reminderTimeoutMinutes,
            reminderRepeat: !!opts.reminderRepeat,
            reminderEnabled: isNoReminder ? false : !!opts.reminderEnabled,
            reminderQueued: false,
            reminderSentCount: 0,
            prePrompts: (opts.prePrompts || [])
                .filter(p => !!(p.text || '').trim())
                .map(p => ({
                    text: p.text,
                    template: p.template,
                    status: 'pending' as const,
                    repeatCount: p.repeatCount,
                    answerWaitMinutes: p.answerWaitMinutes,
                    reminderTemplateId: p.reminderTemplateId,
                    reminderTimeoutMinutes: p.reminderTimeoutMinutes,
                    reminderRepeat: p.reminderRepeat,
                    reminderEnabled: p.reminderEnabled,
                })),
            followUps: (opts.followUps || [])
                .filter(f => !!(f.originalText || '').trim())
                .map(f => ({
                    id: randomUUID(),
                    originalText: f.originalText,
                    template: f.template,
                    repeatCount: f.repeatCount,
                    answerWaitMinutes: f.answerWaitMinutes,
                    reminderTemplateId: f.reminderTemplateId,
                    reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                    reminderRepeat: !!f.reminderRepeat,
                    reminderEnabled: !!f.reminderEnabled,
                    createdAt: new Date().toISOString(),
                })),
            followUpIndex: 0,
            repeatCount: opts.repeatCount,
            repeatIndex: Math.max(0, Math.round(opts.repeatIndex || 0)),
            repeatPrefix: opts.repeatPrefix,
            repeatSuffix: opts.repeatSuffix,
            templateRepeatCount: opts.templateRepeatCount,
            templateRepeatIndex: Math.max(0, Math.round(opts.templateRepeatIndex || 0)),
            answerWaitMinutes: opts.answerWaitMinutes && opts.answerWaitMinutes > 0 ? opts.answerWaitMinutes : undefined,
        };

        logQueue(`Item enqueued: id=${item.id}, type=${item.type}, status=${item.status}, text=${promptPreview(item.originalText)}`);

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
        const removed = this._items.find(i => i.id === id);
        this._items = this._items.filter(i => i.id !== id);
        if (removed) {
            logQueue(`Item removed: id=${removed.id}, type=${removed.type}, status=${removed.status}`);
        }
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
        item.expandedText = await this._buildExpandedText(newText, item.template, item.answerWrapper, {
            repeatCount: resolveRepeatCount(item.repeatCount),
            repeatIndex: item.repeatIndex,
            repeatPrefix: item.repeatPrefix,
            repeatSuffix: item.repeatSuffix,
        });
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

        item.expandedText = await this._buildExpandedText(item.originalText, item.template, item.answerWrapper, {
            repeatCount: resolveRepeatCount(item.repeatCount),
            repeatIndex: item.repeatIndex,
            repeatPrefix: item.repeatPrefix,
            repeatSuffix: item.repeatSuffix,
        });
        this.persist();
        this._onDidChange.fire();
        return true;
    }

    updateItemReminder(id: string, patch: { reminderEnabled?: boolean; reminderTemplateId?: string; reminderTimeoutMinutes?: number; reminderRepeat?: boolean }): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }
        // Allow reminderEnabled toggle for sending items, but other changes only for staged
        const isToggleOnly = patch.reminderEnabled !== undefined && 
            patch.reminderTemplateId === undefined && 
            patch.reminderTimeoutMinutes === undefined && 
            patch.reminderRepeat === undefined;
        if (!isToggleOnly && !this.isEditableStatus(item.status)) { return; }
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

    /**
     * Patch the main item's repetition / answer-wait fields. Editable while the
     * item is in an editable status (staged or pending).
     */
    updateItemRepetition(id: string, patch: {
        repeatCount?: number | string;
        repeatPrefix?: string;
        repeatSuffix?: string;
        templateRepeatCount?: number | string;
        answerWaitMinutes?: number;
    }): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (patch.repeatCount !== undefined) {
            item.repeatCount = patch.repeatCount;
            item.resolvedRepeatCount = undefined;
        }
        if (patch.repeatPrefix !== undefined) { item.repeatPrefix = patch.repeatPrefix || undefined; }
        if (patch.repeatSuffix !== undefined) { item.repeatSuffix = patch.repeatSuffix || undefined; }
        if (patch.templateRepeatCount !== undefined) { item.templateRepeatCount = patch.templateRepeatCount; }
        if (patch.answerWaitMinutes !== undefined) {
            item.answerWaitMinutes = patch.answerWaitMinutes > 0 ? patch.answerWaitMinutes : undefined;
        }
        this.persist();
        this._onDidChange.fire();
        return true;
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

    updateFollowUpPrompt(itemId: string, followUpId: string, patch: {
        originalText?: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }): boolean {
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
        if (patch.repeatCount !== undefined) {
            follow.repeatCount = patch.repeatCount;
            follow.resolvedRepeatCount = undefined;
        }
        if (patch.answerWaitMinutes !== undefined) {
            follow.answerWaitMinutes = patch.answerWaitMinutes > 0 ? patch.answerWaitMinutes : undefined;
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
    updatePrePrompt(itemId: string, index: number, patch: {
        text?: string;
        template?: string;
        repeatCount?: number | string;
        answerWaitMinutes?: number;
        reminderTemplateId?: string;
        reminderTimeoutMinutes?: number;
        reminderRepeat?: boolean;
        reminderEnabled?: boolean;
    }): boolean {
        const item = this._items.find(i => i.id === itemId);
        if (!item || !this.isEditableStatus(item.status)) { return false; }
        if (!item.prePrompts || index < 0 || index >= item.prePrompts.length) { return false; }
        const pp = item.prePrompts[index];
        if (patch.text !== undefined) pp.text = patch.text;
        if (patch.template !== undefined) pp.template = patch.template || undefined;
        if (patch.repeatCount !== undefined) {
            pp.repeatCount = patch.repeatCount;
            pp.resolvedRepeatCount = undefined;
        }
        if (patch.answerWaitMinutes !== undefined) pp.answerWaitMinutes = patch.answerWaitMinutes > 0 ? patch.answerWaitMinutes : undefined;
        if (patch.reminderTemplateId !== undefined) pp.reminderTemplateId = patch.reminderTemplateId || undefined;
        if (patch.reminderTimeoutMinutes !== undefined) pp.reminderTimeoutMinutes = patch.reminderTimeoutMinutes;
        if (patch.reminderRepeat !== undefined) pp.reminderRepeat = patch.reminderRepeat;
        if (patch.reminderEnabled !== undefined) pp.reminderEnabled = patch.reminderEnabled;
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

    /**
     * Abort waiting for the current sending item and continue queue progression.
     * This behaves like receiving an answer for progression purposes:
     * - send next pre/main/follow-up stage if one exists,
     * - otherwise mark sent, enqueue repeat (if configured), and send next pending item.
     */
    async continueSending(id?: string): Promise<boolean> {
        const sending = this._items.find(i => i.status === 'sending');
        if (!sending) {
            return false;
        }
        if (id && sending.id !== id) {
            return false;
        }

        logQueue(`Manual continue requested for sending item ${sending.id}`);
        this.updateWindowStatus('answer-received');

        try {
            return await this.advanceSendingItemWithoutAnswer(sending, 'manual-continue');
        } catch (err) {
            sending.status = 'error';
            sending.error = String(err);
            logQueueError(`continueSending(${sending.id})`, err);
            this.persist();
            this._onDidChange.fire();
            return false;
        }
    }

    private async advanceSendingItemWithoutAnswer(sending: QueuedPrompt, reason: string): Promise<boolean> {
        const hasNextStage = await this.dispatchNextStageForSendingItem(sending);
        if (hasNextStage) {
            logQueue(`Advanced sending item ${sending.id} to next stage (${reason})`);
            return true;
        }

        sending.status = 'sent';
        sending.expectedRequestId = undefined;
        sending.reminderSentCount = 0;
        sending.lastReminderAt = undefined;
        this.removePendingReminderFor(sending.id);

        const resolvedTemplateRepeatCount = resolveRepeatCount(sending.templateRepeatCount);
        logQueue(`Template repeat check (no-answer): templateRepeatCount=${String(sending.templateRepeatCount)}, resolved=${resolvedTemplateRepeatCount}, templateRepeatIndex=${sending.templateRepeatIndex}, repeatCount=${String(sending.repeatCount)}`);
        const repeatDecision = computeRepeatDecision({
            repeatCount: sending.templateRepeatCount,
            repeatIndex: sending.templateRepeatIndex,
        }, resolvedTemplateRepeatCount);

        if (repeatDecision.shouldRepeat) {
            await this.enqueue({
                originalText: sending.originalText,
                template: sending.template,
                answerWrapper: sending.answerWrapper,
                answerWaitMinutes: sending.answerWaitMinutes,
                type: sending.type,
                repeatCount: sending.repeatCount,
                repeatIndex: 0,
                repeatPrefix: sending.repeatPrefix,
                repeatSuffix: sending.repeatSuffix,
                templateRepeatCount: sending.templateRepeatCount,
                templateRepeatIndex: repeatDecision.nextRepeatIndex,
                reminderTemplateId: sending.reminderTemplateId,
                reminderTimeoutMinutes: sending.reminderTimeoutMinutes,
                reminderRepeat: sending.reminderRepeat,
                reminderEnabled: sending.reminderEnabled,
                prePrompts: (sending.prePrompts || []).map(pp => ({
                    text: pp.text,
                    template: pp.template,
                    repeatCount: pp.repeatCount,
                    answerWaitMinutes: pp.answerWaitMinutes,
                    reminderTemplateId: pp.reminderTemplateId,
                    reminderTimeoutMinutes: pp.reminderTimeoutMinutes,
                    reminderRepeat: pp.reminderRepeat,
                    reminderEnabled: pp.reminderEnabled,
                })),
                followUps: (sending.followUps || []).map(f => ({
                    originalText: f.originalText,
                    template: f.template,
                    repeatCount: f.repeatCount,
                    answerWaitMinutes: f.answerWaitMinutes,
                    reminderTemplateId: f.reminderTemplateId,
                    reminderTimeoutMinutes: f.reminderTimeoutMinutes,
                    reminderRepeat: !!f.reminderRepeat,
                    reminderEnabled: !!f.reminderEnabled,
                })),
                initialStatus: 'pending',
                deferSend: true,
            });
            logQueue(`Repeat ${repeatDecision.progressLabel} queued for item ${sending.id} (${reason})`);
        }

        this.persist();
        this._onDidChange.fire();

        if (this._autoSendEnabled) {
            const pendingCount = this._items.filter(i => i.status === 'pending').length;
            if (shouldAutoPauseOnEmpty(this._autoSendEnabled, pendingCount, this._autoPauseEnabled)) {
                this._autoSendEnabled = false;
                this.persistSettings();
                this._onDidChange.fire();
                logQueue('Queue empty — auto-pausing');
            } else {
                await this.delaySendNext();
            }
        }

        logQueue(`Manual continue completed for ${sending.id} (${reason})`);
        return true;
    }

    setStatus(id: string, status: 'staged' | 'pending'): boolean {
        const item = this._items.find(i => i.id === id);
        if (!item) { return false; }
        const fromStatus = item.status;
        // Allow interrupting a sending item back to staged.
        if (item.status === 'sending' && status === 'staged') {
            if (item.prePrompts && item.prePrompts.length > 0) {
                for (const pp of item.prePrompts) {
                    pp.status = 'pending';
                }
            }
            item.status = 'staged';
            item.requestId = undefined;
            item.expectedRequestId = undefined;
            item.followUpIndex = 0;
            item.sentAt = undefined;
            item.reminderSentCount = 0;
            item.lastReminderAt = undefined;
            item.error = undefined;
            logQueue(`Status changed: id=${item.id}, from=${fromStatus} → to=${item.status}`);
            this.removePendingReminderFor(item.id);
            this.persist();
            this._onDidChange.fire();
            this.updateWindowStatus('answer-received');
            return true;
        }
        // Allow sent items to be re-staged, but not error items
        if (item.status === 'error') { return false; }
        if (item.status === 'sending') { return false; }
        item.status = status;
        logQueue(`Status changed: id=${item.id}, from=${fromStatus} → to=${item.status}`);
        this.persist();
        this._onDidChange.fire();
        
        // If changed to pending and autoSend is on, try to send
        if (status === 'pending' && this._autoSendEnabled && !this._items.some(i => i.status === 'sending')) {
            void this.sendNext();
        }
        return true;
    }

    sendAllStaged(): number {
        const changed = convertStagedToPending(this._items);
        if (changed === 0) { return 0; }

        this.persist();
        this._onDidChange.fire();
        logQueue(`Converted ${changed} staged items to pending`);

        if (this._autoSendEnabled && !this._items.some(i => i.status === 'sending')) {
            void this.sendNext();
        }
        return changed;
    }

    updateRepeat(id: string, patch: { repeatCount?: number | string; repeatIndex?: number; repeatPrefix?: string; repeatSuffix?: string; answerWaitMinutes?: number; templateRepeatCount?: number | string }): void {
        const item = this._items.find(i => i.id === id);
        if (!item) { return; }

        const isSending = item.status === 'sending';
        const allowFullEdit = this.isEditableStatus(item.status);
        if (!allowFullEdit && !isSending) { return; }

        if (patch.repeatCount !== undefined) {
            // Accept both number and string (variable name)
            if (typeof patch.repeatCount === 'string' && isNaN(parseInt(patch.repeatCount, 10))) {
                // String variable name
                item.repeatCount = patch.repeatCount;
                item.resolvedRepeatCount = undefined;
            } else {
                const requested = Math.max(0, Math.round(typeof patch.repeatCount === 'string' ? parseInt(patch.repeatCount, 10) || 0 : patch.repeatCount || 0));
                item.repeatCount = requested;
                item.resolvedRepeatCount = undefined;
            }
        }
        if (!allowFullEdit) {
            this.persist();
            this._onDidChange.fire();
            return;
        }
        if (patch.repeatIndex !== undefined) {
            item.repeatIndex = Math.max(0, Math.round(patch.repeatIndex || 0));
        }
        if (patch.repeatPrefix !== undefined) {
            item.repeatPrefix = patch.repeatPrefix;
        }
        if (patch.repeatSuffix !== undefined) {
            item.repeatSuffix = patch.repeatSuffix;
        }
        if (patch.answerWaitMinutes !== undefined) {
            item.answerWaitMinutes = patch.answerWaitMinutes > 0 ? patch.answerWaitMinutes : undefined;
        }
        if (patch.templateRepeatCount !== undefined) {
            // Accept both number and string (variable name)
            if (typeof patch.templateRepeatCount === 'string' && isNaN(parseInt(patch.templateRepeatCount, 10))) {
                item.templateRepeatCount = patch.templateRepeatCount;
            } else {
                const val = typeof patch.templateRepeatCount === 'string' ? parseInt(patch.templateRepeatCount, 10) || 0 : patch.templateRepeatCount || 0;
                item.templateRepeatCount = val > 0 ? val : undefined;
            }
        }

        this.persist();
        this._onDidChange.fire();
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
        // Note: We don't use _processing guard here anymore because it could cause 
        // repeat items to get stuck. sendNext() has its own guard against concurrent sending.
        await new Promise(r => setTimeout(r, this._autoSendDelayMs));
        await this.sendNext();
    }

    async sendNext(): Promise<void> {
        const next = this._items.find(i => i.status === 'pending');
        if (!next) {
            logQueue('sendNext: no pending items');
            if (shouldAutoPauseOnEmpty(this._autoSendEnabled, 0, this._autoPauseEnabled)) {
                this._autoSendEnabled = false;
                this.persistSettings();
                this._onDidChange.fire();
                logQueue('Queue empty — auto-pausing');
            }
            return;
        }
        // Don't send if something is already sending
        if (this._items.some(i => i.status === 'sending')) {
            logQueue(`sendNext: skipped — another item is already sending`);
            return;
        }
        logQueue(`sendNext: sending item ${next.id}`);
        await this.sendItem(next);
    }

    private async sendItem(item: QueuedPrompt): Promise<void> {
        if (item.status === 'sending') { return; }
        logQueue(`Sending prompt ${item.id} to Copilot — text=${promptPreview(item.originalText)}`);

        // Reset run state before first dispatch of this item.
        if (item.prePrompts && item.prePrompts.length > 0) {
            for (let idx = 0; idx < item.prePrompts.length; idx++) {
                const pp = item.prePrompts[idx];
                pp.status = 'pending';
                pp.repeatIndex = 0;
                pp.resolvedRepeatCount = undefined;
            }
        }
        if (item.followUps && item.followUps.length > 0) {
            for (let idx = 0; idx < item.followUps.length; idx++) {
                const fu = item.followUps[idx];
                fu.repeatIndex = 0;
                fu.resolvedRepeatCount = undefined;
            }
        }
        item.repeatIndex = 0;
        item.resolvedRepeatCount = undefined;
        item.requestId = undefined;
        item.expectedRequestId = undefined;
        item.followUpIndex = 0;
        item.reminderSentCount = 0;
        item.lastReminderAt = undefined;
        item.error = undefined;
        item.status = 'sending';
        this.persist();
        this._onDidChange.fire();

        try {
            await this.dispatchNextStageForSendingItem(item);
            logQueue(`Prompt ${item.id} sent, waiting for answer at ${this.getAnswerFilePathForRequestId(item.expectedRequestId)}`);
        } catch (err) {
            item.status = 'error';
            item.error = String(err);
            logQueueError(`sendItem(${item.id})`, err);
            this.persist();
            this._onDidChange.fire();
        }
    }

    private resolveStableRepeatCount(
        repeatCountRaw: number | string | undefined,
        cachedResolved: number | undefined,
        sentCount: number,
        scope: string,
    ): number {
        const normalizedCached = cachedResolved !== undefined && cachedResolved !== null
            ? Math.max(1, Math.round(Number(cachedResolved) || 1))
            : undefined;
        if (normalizedCached) {
            return normalizedCached;
        }

        const isVariableRepeat = typeof repeatCountRaw === 'string' && isNaN(parseInt(repeatCountRaw, 10));
        if (isVariableRepeat && sentCount > 0) {
            // Keep variable-driven repeats from expanding if cache was lost mid-run.
            const fallback = Math.max(1, sentCount);
            logQueue(`${scope} dispatch: recovered stable repeat from sentCount=${fallback} for repeatCount=${String(repeatCountRaw)}`);
            return fallback;
        }

        return Math.max(1, resolveRepeatCount(repeatCountRaw));
    }

    private async dispatchNextStageForSendingItem(item: QueuedPrompt): Promise<boolean> {
        // Stage 1: Pre-prompts with individual repeat support.
        // Each stage uses a stable numeric repeat target for normal loop control.
        const prePrompts = item.prePrompts || [];
        for (let ppIndex = 0; ppIndex < prePrompts.length; ppIndex++) {
            const pp = prePrompts[ppIndex];
            const ppSentCount = pp.repeatIndex || 0;
            const ppRepeatCount = this.resolveStableRepeatCount(pp.repeatCount, pp.resolvedRepeatCount, ppSentCount, `PP#${ppIndex + 1}`);
            if (pp.resolvedRepeatCount !== ppRepeatCount) {
                pp.resolvedRepeatCount = ppRepeatCount;
                this.persist();
                this._onDidChange.fire();
            }
            logQueue(`PP dispatch: repeatCount=${String(pp.repeatCount)}, resolved=${ppRepeatCount}, cachedResolved=${pp.resolvedRepeatCount}, sentCount=${ppSentCount}`);
            if (ppSentCount < ppRepeatCount) {
                const prePromptExpanded = await this._buildExpandedText(pp.text, pp.template, true, {
                    repeatCount: ppRepeatCount,
                    repeatIndex: ppSentCount,
                });
                pp.status = 'sent';
                pp.repeatIndex = ppSentCount + 1;
                item.expandedText = prePromptExpanded;
                item.expectedRequestId = this._extractRequestIdFromExpandedPrompt(prePromptExpanded);
                item.sentAt = new Date().toISOString();
                item.reminderSentCount = 0;
                item.lastReminderAt = undefined;
                this.persist();
                this._onDidChange.fire();

                this.clearExpectedAnswerFiles(item.expectedRequestId);
                await vscode.commands.executeCommand('workbench.action.chat.open', { query: prePromptExpanded });
                this._onPromptSent.fire(item);
                this.updateWindowStatus('prompt-sent');
                logQueue(`Pre-prompt sent (${ppSentCount + 1}/${ppRepeatCount})`);
                return true;
            }
        }

        // Stage 2: Main prompt with repeat support.
        const mainSentCount = item.repeatIndex || 0;
        const mainRepeatCount = this.resolveStableRepeatCount(item.repeatCount, item.resolvedRepeatCount, mainSentCount, 'MP');
        if (item.resolvedRepeatCount !== mainRepeatCount) {
            item.resolvedRepeatCount = mainRepeatCount;
            this.persist();
            this._onDidChange.fire();
        }
        if (mainSentCount < mainRepeatCount) {
            item.expandedText = await this._buildExpandedText(item.originalText, item.template, item.answerWrapper, {
                repeatCount: mainRepeatCount,
                repeatIndex: mainSentCount,
                repeatPrefix: item.repeatPrefix,
                repeatSuffix: item.repeatSuffix,
            });
            const newRequestId = this._extractRequestIdFromExpandedPrompt(item.expandedText);
            if (!item.requestId) {
                item.requestId = newRequestId; // Preserve first request ID
            }
            item.expectedRequestId = newRequestId;
            item.repeatIndex = mainSentCount + 1;
            item.sentAt = new Date().toISOString();
            item.reminderSentCount = 0;
            item.lastReminderAt = undefined;
            this.persist();
            this._onDidChange.fire();

            this.clearExpectedAnswerFiles(item.expectedRequestId);
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: item.expandedText });
            this._onPromptSent.fire(item);
            this.updateWindowStatus('prompt-sent');
            logQueue(`Main prompt sent (${mainSentCount + 1}/${mainRepeatCount})`);
            return true;
        }

        // Stage 3: Follow-ups with individual repeat support.
        const followUps = item.followUps ?? [];
        const currentFuIndex = item.followUpIndex ?? 0;
        if (currentFuIndex < followUps.length) {
            const nextFollowUp = followUps[currentFuIndex];
            const fuSentCount = nextFollowUp.repeatIndex || 0;
            const fuRepeatCount = this.resolveStableRepeatCount(nextFollowUp.repeatCount, nextFollowUp.resolvedRepeatCount, fuSentCount, `FU#${currentFuIndex + 1}`);
            if (nextFollowUp.resolvedRepeatCount !== fuRepeatCount) {
                nextFollowUp.resolvedRepeatCount = fuRepeatCount;
                this.persist();
                this._onDidChange.fire();
            }
            logQueue(`FU dispatch: repeatCount=${String(nextFollowUp.repeatCount)}, resolved=${fuRepeatCount}, cachedResolved=${nextFollowUp.resolvedRepeatCount}, sentCount=${fuSentCount}`);
            if (fuSentCount < fuRepeatCount) {
                const followUpExpanded = await this._buildExpandedText(nextFollowUp.originalText, nextFollowUp.template, true, {
                    repeatCount: fuRepeatCount,
                    repeatIndex: fuSentCount,
                });
                nextFollowUp.repeatIndex = fuSentCount + 1;
                item.expandedText = followUpExpanded;
                item.expectedRequestId = this._extractRequestIdFromExpandedPrompt(followUpExpanded);
                // Advance to next follow-up only when all repeats for this one are done
                if (nextFollowUp.repeatIndex >= fuRepeatCount) {
                    item.followUpIndex = currentFuIndex + 1;
                }
                item.sentAt = new Date().toISOString();
                item.reminderSentCount = 0;
                item.lastReminderAt = undefined;
                this.persist();
                this._onDidChange.fire();

                this.clearExpectedAnswerFiles(item.expectedRequestId);
                await vscode.commands.executeCommand('workbench.action.chat.open', { query: followUpExpanded });
                this._onPromptSent.fire(item);
                this.updateWindowStatus('prompt-sent');
                logQueue(`Follow-up ${currentFuIndex + 1} sent (${fuSentCount + 1}/${fuRepeatCount})`);
                return true;
            }
            // All repeats done for this follow-up, advance to next
            item.followUpIndex = currentFuIndex + 1;
            return this.dispatchNextStageForSendingItem(item);
        }

        // No more stages left.
        return false;
    }

    private clearExpectedAnswerFiles(expectedRequestId?: string): void {
        const candidatePaths = new Set<string>([
            this.getAnswerFilePathForRequestId(expectedRequestId),
            this.answerFilePath,
        ]);
        for (const candidate of candidatePaths) {
            try {
                fs.unlinkSync(candidate);
            } catch {
                // File may not exist yet.
            }
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

        // Restore queue-level settings
        this.restoreSettings();

        // Auto-start: if enabled, keep auto-send on after restore; otherwise start paused.
        if (this._autoStartEnabled) {
            logQueue('Auto-start: enabling auto-send on activation');
            this._autoSendEnabled = true;
        } else {
            this._autoSendEnabled = false;
        }

        // Auto-continue: if enabled and there are pending items with remaining repetitions,
        // schedule auto-start after 30 seconds to let VS Code fully initialize.
        if (this._autoContinueEnabled && !this._autoStartEnabled) {
            const hasPendingRepetitions = this._items.some(i =>
                i.status === 'pending' &&
                ((resolveRepeatCount(i.templateRepeatCount) > 1 && (i.templateRepeatIndex ?? 0) >= 1) ||
                 (resolveRepeatCount(i.repeatCount ?? 1) > 1 && (i.repeatIndex ?? 0) >= 1)),
            );
            if (hasPendingRepetitions) {
                logQueue('Auto-continue: pending repetitions found, scheduling auto-start in 30s');
                this._autoContinueTimer = setTimeout(() => {
                    logQueue('Auto-continue: enabling auto-send to resume repetitions');
                    this._autoSendEnabled = true;
                    this.persistSettings();
                    this._onDidChange.fire();
                    if (this._items.some(i => i.status === 'pending') && !this._items.some(i => i.status === 'sending')) {
                        void this.sendNext();
                    }
                }, 30_000);
            }
        }

        // If auto-send is now enabled (via auto-start) and there are pending items, kick off
        if (this._autoSendEnabled && this._items.some(i => i.status === 'pending') && !this._items.some(i => i.status === 'sending')) {
            void this.sendNext();
        }
    }

    /** Persist queue-level settings to disk. */
    private persistSettings(): void {
        writeQueueSettings({
            'response-timeout-minutes': this._responseFileTimeoutMinutes,
            'default-reminder-template-id': this._defaultReminderTemplateId,
            'auto-send-enabled': this._autoSendEnabled,
            'auto-start-enabled': this._autoStartEnabled,
            'auto-pause-enabled': this._autoPauseEnabled,
            'auto-continue-enabled': this._autoContinueEnabled,
        });
    }

    /** Restore queue-level settings from disk. */
    private restoreSettings(): void {
        const settings = readQueueSettings();
        if (settings) {
            if (typeof settings['response-timeout-minutes'] === 'number') {
                this._responseFileTimeoutMinutes = Math.max(5, settings['response-timeout-minutes']);
            }
            if (settings['default-reminder-template-id']) {
                this._defaultReminderTemplateId = settings['default-reminder-template-id'];
            }
            if (typeof settings['auto-send-enabled'] === 'boolean') {
                this._autoSendEnabled = settings['auto-send-enabled'];
            }
            if (typeof settings['auto-start-enabled'] === 'boolean') {
                this._autoStartEnabled = settings['auto-start-enabled'];
            }
            if (typeof settings['auto-pause-enabled'] === 'boolean') {
                this._autoPauseEnabled = settings['auto-pause-enabled'];
            }
            if (typeof settings['auto-continue-enabled'] === 'boolean') {
                this._autoContinueEnabled = settings['auto-continue-enabled'];
            }
            console.log('[PromptQueueManager] restoreSettings:', {
                timeout: this._responseFileTimeoutMinutes,
                defaultTemplate: this._defaultReminderTemplateId,
                autoSend: this._autoSendEnabled,
            });
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

        const orderedEntries = [...entries].sort((a, b) => {
            const aOrder = Number((a.doc?.meta as Record<string, unknown> | undefined)?.['queue-order-index']);
            const bOrder = Number((b.doc?.meta as Record<string, unknown> | undefined)?.['queue-order-index']);
            const aHasOrder = Number.isFinite(aOrder);
            const bHasOrder = Number.isFinite(bOrder);
            if (aHasOrder && bHasOrder && aOrder !== bOrder) {
                return aOrder - bOrder;
            }
            if (aHasOrder !== bHasOrder) {
                return aHasOrder ? -1 : 1;
            }
            return a.fileName.localeCompare(b.fileName);
        });

        for (const entry of orderedEntries) {
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
            for (let index = 0; index < this._items.length; index++) {
                const item = this._items[index];
                const doc = this._queuedPromptToDoc(item, quest, index);
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
                status: (meta.status as QueuedPromptStatus) || 'pending',
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
                repeatCount: typeof main['repeat-count'] === 'string' ? main['repeat-count'] : Math.max(0, Math.round(Number(main['repeat-count'] || 0))),
                resolvedRepeatCount: main['resolved-repeat-count'] ? Math.max(1, Math.round(Number(main['resolved-repeat-count']))) : undefined,
                repeatIndex: Math.max(0, Math.round(Number(main['repeat-index'] || 0))),
                repeatPrefix: main['repeat-prefix'],
                repeatSuffix: main['repeat-suffix'],
                templateRepeatCount: typeof main['template-repeat-count'] === 'string' ? main['template-repeat-count'] : (main['template-repeat-count'] ? Math.max(0, Math.round(Number(main['template-repeat-count']))) : undefined),
                templateRepeatIndex: main['template-repeat-index'] ? Math.max(0, Math.round(Number(main['template-repeat-index']))) : undefined,
                answerWaitMinutes: main['answer-wait-minutes'] && Number(main['answer-wait-minutes']) > 0 ? Number(main['answer-wait-minutes']) : undefined,
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
                        repeatCount: pp?.['repeat-count'],
                        resolvedRepeatCount: pp?.['resolved-repeat-count'] ? Math.max(1, Math.round(Number(pp['resolved-repeat-count']))) : undefined,
                        repeatIndex: Math.max(0, Math.round(Number(pp?.['repeat-index'] || 0))),
                        answerWaitMinutes: pp?.['answer-wait-minutes'],
                        reminderTemplateId: pp?.reminder?.['template-id'],
                        reminderTimeoutMinutes: pp?.reminder?.['timeout-minutes'],
                        reminderRepeat: pp?.reminder?.repeat,
                        reminderEnabled: pp?.reminder?.enabled,
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
                        repeatCount: fu?.['repeat-count'],
                        resolvedRepeatCount: fu?.['resolved-repeat-count'] ? Math.max(1, Math.round(Number(fu['resolved-repeat-count']))) : undefined,
                        repeatIndex: Math.max(0, Math.round(Number(fu?.['repeat-index'] || 0))),
                        answerWaitMinutes: fu?.['answer-wait-minutes'],
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
    private _queuedPromptToDoc(item: QueuedPrompt, quest?: string, orderIndex?: number): QueueFileYaml {
        const mainPrompt: QueuePromptYaml = {
            id: 'P1',
            name: 'Main Prompt',
            type: 'main',
            'prompt-text': item.originalText,
            'expanded-text': item.expandedText,
            template: item.template || '(None)',
            'answer-wrapper': item.answerWrapper,
            'repeat-count': item.repeatCount || 0,
            'resolved-repeat-count': item.resolvedRepeatCount,
            'repeat-index': Math.max(0, Math.round(item.repeatIndex || 0)),
            'repeat-prefix': item.repeatPrefix,
            'repeat-suffix': item.repeatSuffix,
            'template-repeat-count': item.templateRepeatCount,
            'template-repeat-index': item.templateRepeatIndex,
            'answer-wait-minutes': item.answerWaitMinutes,
        };

        // Reminder config: persist explicit no-reminder state (reminderEnabled === false)
        const hasMainReminderConfig =
            item.reminderEnabled !== undefined ||
            item.reminderTemplateId !== undefined ||
            item.reminderTimeoutMinutes !== undefined ||
            item.reminderRepeat !== undefined ||
            item.reminderQueued !== undefined ||
            item.reminderSentCount !== undefined ||
            item.lastReminderAt !== undefined;
        if (hasMainReminderConfig) {
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
                const ppYaml: QueuePromptYaml = {
                    id: ppId,
                    type: 'preprompt',
                    'prompt-text': pp.text,
                    template: pp.template,
                    'repeat-count': pp.repeatCount,
                    'resolved-repeat-count': pp.resolvedRepeatCount,
                    'repeat-index': pp.repeatIndex || 0,
                    'answer-wait-minutes': pp.answerWaitMinutes,
                    execution: pp.status !== 'pending' ? {
                        'sent-at': pp.status === 'sent' ? new Date().toISOString() : null,
                        error: pp.status === 'error' ? 'pre-prompt failed' : null,
                    } : undefined,
                };
                const hasPpReminderConfig =
                    pp.reminderEnabled !== undefined ||
                    pp.reminderTemplateId !== undefined ||
                    pp.reminderTimeoutMinutes !== undefined ||
                    pp.reminderRepeat !== undefined;
                if (hasPpReminderConfig) {
                    ppYaml.reminder = {
                        enabled: pp.reminderEnabled,
                        'template-id': pp.reminderTemplateId,
                        'timeout-minutes': pp.reminderTimeoutMinutes,
                        repeat: pp.reminderRepeat,
                    };
                }
                allPrompts.push(ppYaml);
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
                    'repeat-count': fu.repeatCount,
                    'resolved-repeat-count': fu.resolvedRepeatCount,
                    'repeat-index': fu.repeatIndex || 0,
                    'answer-wait-minutes': fu.answerWaitMinutes,
                    metadata: { created: fu.createdAt },
                };
                const hasFollowUpReminderConfig =
                    fu.reminderEnabled !== undefined ||
                    fu.reminderTemplateId !== undefined ||
                    fu.reminderTimeoutMinutes !== undefined ||
                    fu.reminderRepeat !== undefined;
                if (hasFollowUpReminderConfig) {
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
                'queue-order-index': Number.isFinite(orderIndex as number) ? orderIndex : undefined,
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

function getWindowStatusWindowId(): string {
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return `${session}_${machine}`;
}

function getWindowStatusWorkspaceName(): string {
    if (vscode.workspace.name) {
        return vscode.workspace.name;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder?.name) {
        return folder.name;
    }
    return 'workspace';
}
