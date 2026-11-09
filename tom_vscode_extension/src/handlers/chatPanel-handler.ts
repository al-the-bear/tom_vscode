/**
 * Chat Panel (@CHAT)
 * 
 * A single webview containing multiple notepad sections with custom tab behavior:
 * - Accordion: opening one section collapses unpinned others
 * - Pin: pinned sections stay open regardless of accordion
 * - Rotate: collapsed sections show as vertical tabs
 * 
 * Sections:
 * - Anthropic
 * - Copilot
 */

import { resolveBusySession } from './busySessionChoice';
import { agentSdkAvailable } from '../services/providerRuntime';
import { locateAgentSdkCli } from '../services/agentSdkCli';
import { wireQuestHintMessages } from './questHint-handler';
import { ApprovalRelay } from '../utils/approvalRelay';
import { ANSWER_WRAPPER_ID, copilotQueueWrapper, fillTemplate, fillWrapper, userMessageTemplateBody, userMessageTemplateOptions } from '../utils/copilotTemplates';
import { sessionLiveTrailFile, sessionRoot, sessionsWithStorage, sessionTrailFolder } from '../services/sessionStorage';
import { pickSessions } from './sessionSelectionPicker';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadSendToChatConfig, saveSendToChatConfig, showPreviewPanel, getWorkspaceRoot, updateChatResponseValues, reportException, escapeHtml, openInExternalApplication } from './handler_shared';
import { openGlobalTemplateEditor, TemplateCategory } from './globalTemplateEditor-handler';
import { openReusablePromptEditor } from './reusablePromptEditor-handler';
import { debugLog } from '../utils/debugLogger';
import { expandTemplate, PLACEHOLDER_HELP } from './promptTemplate';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { trackChatSend } from './chatQueueTracking';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { WsPaths } from '../utils/workspacePaths';
import { sanitizeQuestSegment } from '../utils/questPaths';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { normalizeRepeatCountInput } from '../utils/queueStep3Utils';
import { projectPromptScopes, scanPromptScopes } from '../utils/promptScopes';
import { TrailService } from '../services/trailService';
import { TwoTierMemoryService } from '../services/memory-service';
import { writeWindowState } from './windowStatusPanel-handler.js';
import { AnthropicHandler, AnthropicProfile, AnthropicConfiguration, ANTHROPIC_CHAT_SESSION_KEY } from './anthropic-handler';
import { QuestRefreshService } from '../services/quest-refresh-service';
import { resolveProfileTools } from '../tools/tool-executors';
import { chatSessionFor, pickAgentSdkSession, sessionsFolder, setChatSessionFor } from './sessionPicker';
import { readSession } from '../services/agentSdkSessionStore';
import { sessionTransportMismatch } from '../services/directSessionHistory';
import { resolveEffectiveHistoryMode } from '../services/anthropicPayload';
import type { SessionRecord } from '../utils/agentSdkSessions';
import { sessionLabel } from '../utils/sessionPickerPlan';
import { ACTIVE_ANTHROPIC_PROFILE_KEY } from '../tools/scripting-tools-bridge';
import { tryBeginAnthropicSend, endAnthropicSend, setAnthropicSendCancel, isAnthropicSendInFlight } from './sendToChatState';
import { SharedToolDefinition } from '../tools/shared-tool-registry';
import { chatProviders, ChatDraftState } from './chat/chatProviderRegistry';
import { saveChatDrafts, loadChatDrafts } from '../services/chatDraftService';
import { wireCompletionMessages } from '../utils/completionWiring';
import { NO_API_KEY_LABEL, directApiKeyEnvVar, profileKeyStates } from '../utils/anthropicApiKeyCheck';

// ============================================================================
// Answer File Utilities (for Copilot answer file feature)
//
// Extracted to `../services/copilotAnswerService.ts` as part of Wave 3.2.
// Imports below keep the short in-file names used throughout this
// handler unchanged so existing call sites stay readable.
// ============================================================================

import {
    getWindowId,
    getAnswerFilePath,
    isAnswerJsonFilename,
    generateRequestId,
    answerFileExists,
    deleteAnswerFile,
    readAnswerFile,
    getCopilotAnswersMdPath,
    logCopilotPrompt,
} from '../services/copilotAnswerService';

// ============================================================================
// Trail Logging System
//
// Extracted to `../services/copilotTrailService.ts` as part of Wave 3.2.
// Re-exports preserve the external surface (todoLogPanel imports
// `getTrailFolder` / `getCopilotSummaryTrailPaths` from this module).
// ============================================================================

import {
    getTrailFolder,
    getIndividualTrailFolder,
    getTrailFilePrefix,
    getCopilotSummaryTrailPaths,
    getWorkspaceName,
    writePromptTrail,
    writeAnswerTrail,
} from '../services/copilotTrailService';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { isPlanModeActive, leavePlanModeByUser, onPlanModeChanged, registerPlanDecider, type PlanDecision } from '../tools/planning-tools';
import { usageSummaryLine } from '../utils/usageCost';
import type { LiveTrailTokenCounts } from '../services/live-trail';

// Re-export the trail helpers that external modules (todoLogPanel,
// windowStatusPanel) import from this module today. Keeps their
// imports working without a cross-file rename.
export {
    getTrailFolder,
    getIndividualTrailFolder,
    getTrailFilePrefix,
    getCopilotSummaryTrailPaths,
};

const VIEW_ID = 'tomAi.chatPanel';

/** How often the chat panel checks the answer file when its watcher failed. */
const ANSWER_POLL_MS = 3000;

class ChatPanelViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _answerFileWatcher?: fs.FSWatcher;
    /** Checks the answer file when the watcher failed (see _setupAnswerFileWatcher). */
    private _answerPollTimer?: ReturnType<typeof setInterval>;
    private _autoHideDelay: number = 0; // 0 = keep open, otherwise ms
    private _keepContentAfterSend: boolean = false;
    private _lastLoggedAnswerId: string = ''; // Track last logged answer to avoid duplicates
    private _lastSentCopilotSlot: number = 1;
    private _currentAnswerSlot: number = 1;
    private _copilotRequestSlotMap: Map<string, number> = new Map();
    /**
     * Active cancellation-token sources keyed by section. Created when a send
     * starts, cancelled from the panel's stop button, disposed on completion.
     * Only one entry per section (the panels are strictly sequential).
     */
    private _activeCts: Map<string, vscode.CancellationTokenSource> = new Map();
    /** Whether the webview script has started and can show an approval dialog. */
    private _approvalUiReady = false;
    /** Tool-approval requests, shown in front of the user (src/utils/approvalRelay.ts). */
    private readonly _approvals = new ApprovalRelay({
        isReady: () => !!this._view && this._approvalUiReady,
        reveal: () => this._revealForApproval(),
        post: (message) => { void this._view?.webview.postMessage(message); },
    });
    /** Plans proposed with tomAi_exitPlanMode, waiting for the user's decision: id → plan and resolver. */
    private readonly _planProposals = new Map<string, { plan: string; resolve: (d: PlanDecision) => void }>();
    private _planProposalSeq = 0;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        // Plan mode (CC-3, CC-27): the badge follows the flag, and a proposed
        // plan is shown here for the user to accept or keep planning.
        registerPlanDecider((plan) => this._decidePlan(plan));
        const stopPlanFollow = onPlanModeChanged((active) => {
            this._postPlanMode();
            // Left with the badge while a plan was shown: plan mode has ended,
            // so the proposals waiting are settled as accepted.
            if (!active) { this._settlePlanProposals({ accepted: true }); }
        });
        context.subscriptions.push({ dispose: () => { stopPlanFollow(); registerPlanDecider(undefined); } });
        this._autoHideDelay = context.workspaceState.get('tomAi.copilot.autoHideDelay', 0);
        this._keepContentAfterSend = context.workspaceState.get('copilotKeepContent', false);
        this._setupAnswerFileWatcher();
        this._registerChatProviders();
        // Why here and not at the first panel send: a queue item's tool can
        // ask for approval before the panel ever sent anything.
        this._ensureAnthropicApprovalListener();
    }

    /** The plan-mode badge's state, to the webview. */
    private _postPlanMode(): void {
        void this._view?.webview.postMessage({ type: 'planMode', active: isPlanModeActive() });
    }

    /** Show the waiting plan proposals (again, after the webview restarted). */
    private _postPlanProposals(): void {
        for (const [id, p] of this._planProposals) {
            void this._view?.webview.postMessage({ type: 'planProposal', id, html: renderQuestLogMarkdown(p.plan) });
        }
    }

    private _settlePlanProposals(decision: PlanDecision): void {
        for (const [id, p] of [...this._planProposals]) {
            this._planProposals.delete(id);
            p.resolve(decision);
            void this._view?.webview.postMessage({ type: 'planProposalSettled', id });
        }
    }

    /**
     * Show a proposed plan and wait for the user: in the ANTHROPIC/LLM
     * subpanel when the panel is up, else as a modal dialog (a queued prompt
     * can propose a plan before the panel was ever opened).
     */
    private async _decidePlan(plan: string): Promise<PlanDecision> {
        if (!this._view || !this._approvalUiReady) {
            const accept = 'Accept and leave plan mode';
            const answer = await vscode.window.showInformationMessage('The agent proposes a plan', { modal: true, detail: plan }, accept, 'Keep planning');
            return { accepted: answer === accept };
        }
        const id = `plan-${++this._planProposalSeq}`;
        return new Promise<PlanDecision>((resolve) => {
            this._planProposals.set(id, { plan, resolve });
            this._view?.show(true);
            this._postPlanProposals();
        });
    }

    /**
     * Bring the @CHAT view to the front of the bottom panel without taking
     * the keyboard focus; open it when it was never resolved (its webview
     * then reports `approvalUiReady` and the relay shows the request).
     */
    private _revealForApproval(): void {
        if (this._view) {
            this._view.show(true);
            return;
        }
        void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }

    /**
     * Wave 3.3 — register per-section providers so message handlers
     * can look up section-specific behaviour through a map instead
     * of branching on `section === 'anthropic'`. Hooks are optional
     * and the handler falls back to sensible defaults where a hook
     * isn't registered.
     */
    private _registerChatProviders(): void {
        chatProviders.clear();

        // Anthropic — the richest section: own trail-summary, own
        // cancel primitive (CTS), own reusable-send entry, and
        // extra draft fields (model / config / userMessageTemplate)
        // that other sections don't carry.
        chatProviders.register('anthropic', {
            openTrailSummary: () => this._openAnthropicSummaryTrail(),
            cancelInFlight: () => {
                // Three-part cancel:
                //   1) CTS.cancel() — tells the SDK / VS Code LM / Local LLM
                //      stream to abort their network I/O.
                //   2) abortPendingApprovals() — rejects any approval
                //      awaiter so a runTool sitting on the approval bar
                //      unblocks and exits the loop (without this, the
                //      network-cancel wakes the send, but the tool loop
                //      remains pinned inside awaitApproval forever).
                //   3) anthropicError ping — forces the webview to reset
                //      `anthropicSending=false` and re-enable the Send
                //      button, even in the idle case where there was
                //      nothing in-flight to abort.
                const cts = this._activeCts.get('anthropic');
                const hadInFlight = !!cts;
                cts?.cancel();
                const rejected = AnthropicHandler.instance.abortPendingApprovals();
                const reason = hadInFlight
                    ? (rejected > 0
                        ? `Cancelled by user (${rejected} pending approval${rejected === 1 ? '' : 's'} rejected)`
                        : 'Cancelled by user')
                    : 'Cancelled by user (nothing in flight — resetting UI)';
                this._view?.webview.postMessage({
                    type: 'anthropicError',
                    message: reason,
                });
            },
            sendReusablePrompt: async (content, state) => {
                await this._handleSendAnthropic(
                    content,
                    state?.profile as string || '',
                    state?.model as string || '',
                    state?.config as string || '',
                    state?.userMessageTemplate as string || '',
                );
            },
            persistDraftExtras: (d) => ({
                model: (d.model as string) || '',
                config: (d.config as string) || '',
                userMessageTemplate: (d.userMessageTemplate as string) || '',
            }),
            hydrateDraft: (raw) => ({
                model: (raw.model as string) || '',
                config: (raw.config as string) || '',
                userMessageTemplate: (raw.userMessageTemplate as string) || '',
            }),
            deleteProfile: async (profileId) => {
                const config = loadSendToChatConfig();
                if (!config || !Array.isArray(config.anthropic?.profiles)) { return false; }
                const before = config.anthropic!.profiles!.length;
                config.anthropic!.profiles = config.anthropic!.profiles!.filter((p: any) => p?.id !== profileId);
                if (config.anthropic!.profiles!.length === before) { return false; }
                return !!saveSendToChatConfig(config);
            },
        });

        // Copilot — no non-default hooks today, but the registration
        // keeps the section discoverable and documents that it uses
        // the default fallbacks (send-via-Copilot, no extras, no
        // cancel primitive — Copilot writes to a file and waits).
        chatProviders.register('copilot', {});
    }

    private _setupAnswerFileWatcher(): void {
        const answerDir = path.dirname(getAnswerFilePath());
        // Ensure directory exists
        if (!fs.existsSync(answerDir)) {
            fs.mkdirSync(answerDir, { recursive: true });
        }
        
        // Watch the directory for changes
        this._answerFileWatcher = fs.watch(answerDir, (_eventType, filename) => {
            const expectedFile = path.basename(getAnswerFilePath());
            const filenameStr = typeof filename === 'string' ? filename : undefined;
            if (!filenameStr || filenameStr === expectedFile || isAnswerJsonFilename(filenameStr)) {
                this._notifyAnswerFileStatus();
            }
        });
        // A watcher can fail after it started (EMFILE when the machine runs out
        // of watch handles); unhandled, that is an uncaught exception. Drop it
        // and look for the answer by polling instead.
        this._answerFileWatcher.on('error', (err: NodeJS.ErrnoException) => {
            debugLog(`[ChatPanel] answer-file watcher failed (${err.code ?? err.message}); polling every ${ANSWER_POLL_MS} ms`, 'WARN', 'extension');
            this._answerFileWatcher?.close();
            this._answerFileWatcher = undefined;
            if (!this._answerPollTimer) {
                this._answerPollTimer = setInterval(() => this._notifyAnswerFileStatus(), ANSWER_POLL_MS);
            }
        });
    }

    private _notifyAnswerFileStatus(): void {
        const exists = answerFileExists();
        const answer = exists ? readAnswerFile() : undefined;
        let answerSlot = this._currentAnswerSlot;

        if (answer?.requestId) {
            const mappedSlot = this._copilotRequestSlotMap.get(answer.requestId);
            if (mappedSlot) {
                answerSlot = mappedSlot;
                this._copilotRequestSlotMap.delete(answer.requestId);
            } else {
                answerSlot = this._lastSentCopilotSlot;
            }
            this._currentAnswerSlot = answerSlot;
        }
        
        // Propagate responseValues to shared store for ${chat.KEY} access
        if (answer?.responseValues && typeof answer.responseValues === 'object') {
            updateChatResponseValues(answer.responseValues);
        }
        
        // Auto-write to answer trail when a new answer is detected
        // Fix: validate requestId — if it looks like an unresolved template placeholder, generate a new one
        let answerRequestId = answer?.requestId;
        if (answerRequestId && /\{\{.*\}\}/.test(answerRequestId)) {
            answerRequestId = generateRequestId();
        }
        if (answer?.generatedMarkdown && answerRequestId && answerRequestId !== this._lastLoggedAnswerId) {
            this._lastLoggedAnswerId = answerRequestId;
            writeAnswerTrail({
                requestId: answerRequestId,
                generatedMarkdown: answer.generatedMarkdown,
                comments: answer.comments,
                references: answer.references,
                requestedAttachments: answer.requestedAttachments,
                responseValues: answer.responseValues
            });
        }
        
        this._view?.webview.postMessage({
            type: 'answerFileStatus',
            exists,
            hasAnswer: !!answer?.generatedMarkdown,
            answerSlot,
        });
    }

    public dispose(): void {
        if (this._answerFileWatcher) {
            this._answerFileWatcher.close();
        }
        if (this._answerPollTimer) {
            clearInterval(this._answerPollTimer);
            this._answerPollTimer = undefined;
        }
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        this._approvalUiReady = false;
        webviewView.onDidDispose(() => {
            if (this._view === webviewView) { this._view = undefined; this._approvalUiReady = false; }
        });
        debugLog('[T2] resolveWebviewView start', 'INFO', 'extension');

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        const codiconsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        try {
            webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'chatPanel', {
                init: {
                    codiconsUri: codiconsUri.toString(),
                    placeholderHelp: PLACEHOLDER_HELP
                }
            });
            debugLog('[T2] webview HTML assigned', 'INFO', 'extension');
        } catch (error) {
            reportException('T2.resolveWebviewView.assignHtml', error);
            const errorText = error instanceof Error ? (error.stack || error.message) : String(error);
            webviewView.webview.html = `<html><body><pre style="color:var(--vscode-errorForeground);padding:8px;white-space:pre-wrap;">T2 render error:\n${escapeHtml(errorText)}</pre></body></html>`;
            return;
        }

        // /skill + @file completion: the shared webview component posts
        // `requestCompletion`; this wiring shows the picker and posts the
        // chosen `insertCompletion` back. Registered as its own listener so it
        // coexists with the panel's message switch below.
        wireCompletionMessages(webviewView.webview);
        // The "no quest is open" banner (media/shared/questHint.js).
        this._context.subscriptions.push(wireQuestHintMessages(webviewView.webview));

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'togglePin':
                        // Pin state is handled client-side via localStorage
                        break;
                    case 'sendCopilot':
                        await this._handleSendCopilot(message.text, message.template, message.slot, message.wrap === true);
                        break;
                    case 'sendAnthropic':
                        await this._handleSendAnthropic(message.text, message.profile, message.model, message.config, message.userMessageTemplate, false, typeof message.slot === 'number' ? message.slot : undefined);
                        break;
                    case 'cancel':
                        this._handleCancel(String(message.section || ''));
                        break;
                    case 'refreshAnthropicModels':
                        await this._sendAnthropicModels();
                        break;
                    case 'refreshVsCodeLmModels':
                        await this._sendVsCodeLmModels();
                        break;
                    case 'pickAnthropicSession': {
                        const quest = WsPaths.getWorkspaceQuestId();
                        const picked = await pickAgentSdkSession({
                            questId: quest,
                            current: this._chatSessionKey(),
                            title: 'Anthropic chat session',
                            defaultLabel: `The panel's own session (${ANTHROPIC_CHAT_SESSION_KEY})`,
                        });
                        if (picked !== undefined) {
                            await setChatSessionFor(this._context.workspaceState, quest, picked);
                        }
                        // A picked session with a profile preselects it in the panel's profile select;
                        // the panel's choice still wins on send (item -> session -> default).
                        this._sendChatSession(picked !== undefined);
                        break;
                    }
                    case 'approvalUiReady':
                        this._approvalUiReady = true;
                        this._approvals.ready();
                        this._postPlanMode();
                        this._postPlanProposals();
                        break;
                    case 'leavePlanMode':
                        // The user leaves plan mode with the badge (CC-27).
                        leavePlanModeByUser();
                        break;
                    case 'planDecision': {
                        const pending = this._planProposals.get(String(message.id || ''));
                        if (pending) {
                            this._planProposals.delete(String(message.id));
                            const feedback = typeof message.feedback === 'string' && message.feedback.trim() ? message.feedback.trim() : undefined;
                            pending.resolve({ accepted: !!message.accepted, ...(feedback ? { feedback } : {}) });
                            void this._view?.webview.postMessage({ type: 'planProposalSettled', id: String(message.id) });
                        }
                        break;
                    }
                    case 'anthropicToolApprovalResponse':
                        AnthropicHandler.instance.handleApprovalResponse(
                            String(message.toolId || ''),
                            !!message.approved,
                            !!message.approveAll,
                        );
                        break;
                    case 'anthropicProfileSelected':
                        // Mirror the webview's active Anthropic profile so the
                        // scripting-API bridge can resolve the same profile's
                        // tool set (tools.getJsonVce) without a round-trip.
                        await this._context.workspaceState.update(
                            ACTIVE_ANTHROPIC_PROFILE_KEY,
                            String(message.profileId || ''),
                        );
                        break;
                    case 'getProfiles':
                        this._sendProfiles();
                        // Fire-and-forget: models arrive asynchronously via postMessage
                        void this._sendAnthropicModels();
                        break;
                    case 'getReusablePrompts':
                        await this._sendReusablePrompts();
                        break;
                    case 'sendReusablePrompt':
                        await this._sendReusablePrompt(message.reusableId, message.section, {
                            profile: message.profile,
                            model: message.model,
                            config: message.config,
                            userMessageTemplate: message.userMessageTemplate,
                        });
                        break;
                    case 'editAnthropicProfile':
                        await this._handleEditProfile('anthropic', message.name || '');
                        break;
                    case 'editAnthropicUserMessage':
                        await this._handleEditAnthropicUserMessage(message.name || '');
                        break;
                    case 'loadReusablePromptContent':
                        this._loadReusablePromptContent(message.reusableId);
                        break;
                    case 'openReusablePromptInEditor':
                        await this._openReusablePromptInEditor(message.section || '', message.reusableId);
                        break;
                    case 'openReusablePromptInOverlay':
                        await this._openReusablePromptInOverlay(message.reusableId);
                        break;
                    case 'openReusablePromptInExternalApp':
                        await this._openReusablePromptInExternalApp(message.reusableId);
                        break;
                    case 'saveReusablePrompt':
                        await this._saveReusablePrompt(message.section, message.text, message.selection || {});
                        break;
                    case 'openPromptPanelEditor':
                        await this._openPromptPanelEditor(message.section, message.draft || {});
                        break;
                    case 'showMessage':
                        vscode.window.showInformationMessage(message.message);
                        break;
                    case 'addProfile':
                        await this._handleAddProfile(message.section);
                        break;
                    case 'editProfile':
                        await this._handleEditProfile(message.section, message.name);
                        break;
                    case 'deleteProfile':
                        await this._handleDeleteProfile(message.section, message.name);
                        break;
                    case 'addTemplate':
                        await this._handleAddTemplate(message.section);
                        break;
                    case 'editTemplate':
                        await this._handleEditTemplate(message.section, message.name);
                        break;
                    case 'deleteTemplate':
                        await this._handleDeleteTemplate(message.section, message.name);
                        break;
                    case 'preview':
                        await this._handlePreview(message.section, message.text, message.profile || message.template, message.wrap === true);
                        break;
                    case 'setAutoHideDelay':
                        this._autoHideDelay = message.value;
                        this._context.workspaceState.update('tomAi.copilot.autoHideDelay', message.value);
                        break;
                    case 'getAutoHideDelay':
                        this._view?.webview.postMessage({ type: 'autoHideDelay', value: this._autoHideDelay });
                        break;
                    case 'checkAnswerFile':
                        this._notifyAnswerFileStatus();
                        break;
                    case 'showAnswerViewer':
                        await this._showAnswerViewer();
                        break;
                    case 'extractAnswer':
                        await this._extractAnswerToMd();
                        break;
                    case 'setKeepContent':
                        this._keepContentAfterSend = message.value;
                        this._context.workspaceState.update('copilotKeepContent', message.value);
                        break;
                    case 'getKeepContent':
                        this._view?.webview.postMessage({ type: 'keepContent', value: this._keepContentAfterSend });
                        break;
                    case 'openPromptsFile':
                        await this._openPromptsFile();
                        break;
                    case 'openAnswersFile':
                        await this._openAnswersFile();
                        break;
                    case 'getContextData':
                        await this._sendContextData();
                        break;
                    case 'getContextSummary':
                        this._sendContextSummary();
                        break;
                    case 'applyContext':
                        await this._applyContext(message);
                        break;
                    case 'addToQueue':
                        await this._handleAddToQueue(
                            message.text,
                            message.template,
                            message.repeatCount,
                            message.answerWaitMinutes,
                            {
                                transport: message.transport,
                                anthropicProfileId: message.anthropicProfileId,
                                anthropicConfigId: message.anthropicConfigId,
                                usePanelTarget: message.usePanelTarget === true,
                                next: message.next === true,
                            },
                            { section: typeof message.section === 'string' ? message.section : undefined, slot: typeof message.slot === 'number' ? message.slot : undefined },
                        );
                        break;
                    case 'openQueueEditor':
                        await vscode.commands.executeCommand('tomAi.editor.promptQueue');
                        break;
                    case 'openQueueTemplatesEditor':
                        await vscode.commands.executeCommand('tomAi.editor.queueTemplates');
                        break;
                    case 'openContextSettingsEditor':
                        await vscode.commands.executeCommand('tomAi.editor.contextSettings');
                        break;
                    case 'openChatVariablesEditor':
                        await vscode.commands.executeCommand('tomAi.editor.chatVariables');
                        break;
                    case 'openProcessEditor':
                        await vscode.commands.executeCommand('tomAi.editor.process');
                        break;
                    case 'openTimedRequestsEditor':
                        await vscode.commands.executeCommand('tomAi.editor.timedRequests');
                        break;
                    // openTrailRawFiles = Raw Trail Files Viewer (the grouped-exchanges
                    // webview panel over _ai/trail/{subsystem}/{quest}/). Forwards the
                    // originating section as a subsystem hint so the dropdown lands
                    // on the right subsystem.
                    case 'openTrailRawFiles':
                        // The Copilot section's raw trail; an Anthropic session's is opened
                        // from the @WS Logs panel (runChatSessionAction).
                        await vscode.commands.executeCommand(
                            'tomAi.editor.rawTrailViewer',
                            undefined,
                            message.section || undefined,
                        );
                        break;
                    case 'openTrailSummaryViewer': {
                        // Wave 3.3 — route through the chat-provider
                        // registry. Anthropic registers its own trail
                        // summary opener; every other section falls
                        // through to the shared default.
                        const provider = chatProviders.get(message.section);
                        if (provider?.openTrailSummary) {
                            await provider.openTrailSummary();
                        } else {
                            await this._openTrailFiles();
                        }
                        break;
                    }
                    case 'openStatusPage':
                        await vscode.commands.executeCommand('tomAi.statusPage');
                        break;
                    case 'recreateHistoryFromTrail': {
                        // Force the chunked trail-rebuild path even when an
                        // in-memory snapshot already exists. The handler's
                        // status-update stream surfaces per-chunk progress
                        // on the Anthropic panel's status line.
                        const names = await this._pickPanelSessions('Recreate history from the trail', 'Recreate history');
                        if (!names) { break; }
                        const { AnthropicHandler } = await import('./anthropic-handler.js');
                        // One after the other: each rebuild runs its own chunked compaction.
                        void (async () => {
                            for (const name of names) { await AnthropicHandler.instance.recreateHistoryFromTrail(undefined, name); }
                        })();
                        vscode.window.showInformationMessage(`Recreating the history of ${names.join(', ')} from its trail, in chunks…`);
                        break;
                    }
                    case 'recreateMemoryFromTrail': {
                        // Walk the trail in chunks of `runEveryNRounds −
                        // rawTurnsKept` rounds and run memory extraction
                        // per chunk. The memory-extraction template
                        // dedupes against `${existingMemory}`, so a
                        // rebuild against the current memory file is
                        // idempotent.
                        const names = await this._pickPanelSessions('Recreate quest memory from the trail', 'Recreate memory');
                        if (!names) { break; }
                        const { AnthropicHandler } = await import('./anthropic-handler.js');
                        void (async () => {
                            for (const name of names) { await AnthropicHandler.instance.recreateMemoryFromTrail(undefined, name); }
                        })();
                        vscode.window.showInformationMessage(`Recreating the quest memory of ${names.join(', ')} from its trail, in chunks…`);
                        break;
                    }
                    case 'runQuestRefresh': {
                        // Manual Quest Refresh (Status Page button analog on the
                        // chat panel): dispatch the configured refresh prompt
                        // through this panel's transport with quest-refresh
                        // skipping (so the refresh prompt itself neither counts
                        // nor re-triggers), then the service truncates the
                        // live-trail back to base and resets the prompt counter.
                        const section = String(message.section || '');
                        if (section === 'anthropic') {
                            const profileId = String(message.profile || '');
                            await QuestRefreshService.instance.runRefresh('anthropic', async (refreshText) => {
                                await this._handleSendAnthropic(refreshText, profileId, '', '', undefined, true);
                            });
                            vscode.window.showInformationMessage('Quest Refresh run (Anthropic).');
                        }
                        break;
                    }
                    case 'openQuestHistoryInMdBrowser':
                        // Routes through the same helper as the legacy
                        // "Open Session History" entry point — both end
                        // up at `_ai/quests/<quest>/history/history.md`
                        // in a fresh MD Browser panel.
                        await this._openSessionHistoryMarkdown();
                        break;
                    case 'openQuestMemoryInMdBrowser':
                        await this._openMemoryMarkdown('quest');
                        break;
                    case 'openSharedMemoryInMdBrowser':
                        await this._openMemoryMarkdown('shared');
                        break;
                    case 'openGlobalTemplateEditor':
                        await vscode.commands.executeCommand('tomAi.editor.promptTemplates');
                        break;
                    case 'openReusablePromptEditor':
                        await vscode.commands.executeCommand('tomAi.editor.reusablePrompts');
                        break;
                    case 'saveAsTimedRequest':
                        await this._saveAsTimedRequest(message.text, message.template);
                        break;
                    case 'saveDrafts':
                        await this._saveDrafts(message.drafts);
                        break;
                    case 'loadDrafts':
                        await this._loadDrafts();
                        break;
                    case 'showPanelsFile':
                        await this._showPanelsFile();
                        break;
                    case 'getTodosForFile':
                        await this._sendTodosForFile(message.file);
                        break;
                    case 'getContextDataForQuest':
                        await this._sendTodoFilesForQuest(message.quest);
                        break;
                }
            },
            undefined,
            this._context.subscriptions
        );
    }

    /**
     * Detect whether the host `claude` CLI (used by the Agent SDK transport
     * per spec §18.6) is installed and reachable. Cached at module scope
     * after first resolution so we don't spawn a subprocess on every panel
     * event. Returns `null` while the probe is in flight, `true`/`false`
     * after.
     */
    private static claudeCliOk: boolean | null = null;
    private static _claudeCliProbe: Promise<boolean> | undefined;
    /**
     * Whether the Agent SDK transport can run here: the Anthropic provider's
     * Agent SDK and its Claude CLI for this platform are installed (Provider
     * SDKs page). The 🤖 dot shows it.
     */
    private static async probeClaudeCli(): Promise<boolean> {
        if (!ChatPanelViewProvider._claudeCliProbe) {
            ChatPanelViewProvider._claudeCliProbe = (async () => {
                const ok = agentSdkAvailable() && locateAgentSdkCli() !== null;
                ChatPanelViewProvider.claudeCliOk = ok;
                return ok;
            })();
        }
        return ChatPanelViewProvider._claudeCliProbe;
    }
    /** Re-run the Agent SDK probe on next access (e.g. after config save). */
    static resetClaudeCliProbe(): void {
        ChatPanelViewProvider.claudeCliOk = null;
        ChatPanelViewProvider._claudeCliProbe = undefined;
    }

    /** The session the panel sends in: the one chosen for the quest, else `chat`. */
    private _chatSessionKey(): string {
        return chatSessionFor(this._context.workspaceState, WsPaths.getWorkspaceQuestId(), ANTHROPIC_CHAT_SESSION_KEY);
    }

    /** The panel's session file, if it has one. */
    private _chatSessionRecord(): SessionRecord | undefined {
        try {
            return readSession(sessionsFolder(WsPaths.getWorkspaceQuestId()), this._chatSessionKey());
        } catch {
            return undefined;
        }
    }

    /**
     * Tell the webview which session the panel sends in, as its button reads
     * (name, base, lifetime, model). `preselectProfile`: the session was just
     * picked, so its profile (if any) becomes the panel's selected profile.
     */
    private _sendChatSession(preselectProfile = false): void {
        const name = this._chatSessionKey();
        const record = this._chatSessionRecord();
        const { label, tooltip } = sessionLabel(name, record);
        void this._view?.webview.postMessage({
            type: 'anthropicSession',
            name,
            label,
            tooltip,
            ...(preselectProfile && record?.profileId ? { profileId: record.profileId } : {}),
        });
    }

    private _sendProfiles(): void {
        this._sendChatSession();
        const config = loadSendToChatConfig();
        // A profile on the direct API whose key variable is not in this VS Code's
        // environment is marked in its label: every send through it would fail.
        const anthropicProfileEntries = profileKeyStates(config?.anthropic, process.env)
            .map((p) => ({ ...p, name: p.name + (p.noApiKey ? NO_API_KEY_LABEL : '') }));
        const anthropicProfiles = anthropicProfileEntries.map((p) => p.id);
        const anthropicConfigurations = Array.isArray(config?.anthropic?.configurations)
            ? config!.anthropic!.configurations!
                .filter((c: any) => c && typeof c.id === 'string')
                .map((c: any) => ({
                    id: c.id,
                    name: c.name || c.id,
                    isDefault: c.isDefault === true,
                    model: typeof c.model === 'string' ? c.model : '',
                    // Spec §4.12 — needed by the webview to decide when
                    // to show the VS Code LM model dropdown row.
                    transport: typeof c.transport === 'string' ? c.transport : 'direct',
                }))
            : [];
        // Spec §4.3 — the Anthropic profile's configurationId may also
        // point at a Local LLM configuration. Surface those to the
        // webview (with transport='localLlm' so the status-line +
        // VS Code LM dropdown logic can tell them apart) so things like
        // buildAnthropicStatusLine() show the correct model for
        // Local-LLM-backed profiles.
        const localLlmConfigsForAnthropicPanel = Array.isArray((config as { localLlm?: { configurations?: Array<{ id?: string; name?: string; model?: string }> } })?.localLlm?.configurations)
            ? (config as { localLlm: { configurations: Array<{ id?: string; name?: string; model?: string }> } }).localLlm.configurations
                .filter((c) => c && typeof c.id === 'string')
                .map((c) => ({
                    id: c.id as string,
                    name: c.name || (c.id as string),
                    isDefault: false,
                    model: typeof c.model === 'string' ? c.model : '',
                    transport: 'localLlm' as const,
                }))
            : [];
        // Concatenate so the webview sees a single merged list. The
        // status-line + VS Code LM dropdown check the `transport` field
        // to decide behaviour per entry.
        anthropicConfigurations.push(...localLlmConfigsForAnthropicPanel);
        const anthropicUserMessageTemplates = Array.isArray(config?.anthropic?.userMessageTemplates)
            ? config!.anthropic!.userMessageTemplates!
                .filter((t: any) => t && typeof t.id === 'string')
                .map((t: any) => t.id)
            : [];
        const envVar = directApiKeyEnvVar(config?.anthropic);
        const anthropicApiKeyOk = !!process.env[envVar];
        // Spec §18.6: the 🤖 dot appears only when at least one
        // configuration opts into the Agent SDK transport. Configs are
        // typed loosely here since the schema is validated elsewhere.
        const anyAgentSdkConfig = Array.isArray(config?.anthropic?.configurations) &&
            config!.anthropic!.configurations!.some((c) => c?.transport === 'agentSdk');
        const claudeCliOk = ChatPanelViewProvider.claudeCliOk;
        if (anyAgentSdkConfig) {
            // Fire the probe; when it resolves we emit a typed status
            // message so the webview can toggle the dot without waiting
            // for the next _sendProfiles() call.
            void ChatPanelViewProvider.probeClaudeCli().then((ok) => {
                this._view?.webview.postMessage({ type: 'anthropicClaudeCliStatus', ok, visible: true });
            });
        }
        this._view?.webview.postMessage({
            type: 'profiles',
            // The Copilot template dropdown: the one template store.
            copilotTemplates: userMessageTemplateOptions(config).map((t) => ({ id: t.id, name: t.label })),
            anthropic: anthropicProfiles,
            anthropicConfigurations,
            anthropicProfileEntries,
            anthropicUserMessageTemplates,
            anthropicApiKeyOk,
            claudeCliOk,
            claudeCliVisible: anyAgentSdkConfig,
        });
        // §11.4: dedicated anthropicProfiles message for downstream consumers
        // that subscribe to the typed Anthropic message stream.
        this._view?.webview.postMessage({
            type: 'anthropicProfiles',
            profiles: anthropicProfiles.map((id) => ({ id })),
            configurations: anthropicConfigurations.map((c) => ({ id: c.id, name: c.name })),
        });
    }

    private _getGlobalPromptsDir(): string | null {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) {
            return null;
        }
        return WsPaths.ai('prompt') || path.join(wsRoot, '_ai', 'prompt');
    }

    private _getActiveQuestId(): string {
        try {
            return ChatVariablesStore.instance.quest.trim();
        } catch {
            // Store not yet initialised (activation order edge case).
            return '';
        }
    }

    private _getPreferredQuestId(): string {
        const activeQuest = this._getActiveQuestId();
        if (activeQuest) {
            return activeQuest;
        }
        const workspaceFile = vscode.workspace.workspaceFile?.fsPath;
        if (workspaceFile && workspaceFile.endsWith('.code-workspace')) {
            const guessed = getWorkspaceName().trim();
            if (guessed && guessed !== 'default') {
                return guessed;
            }
        }
        return '';
    }

    private _getQuestPromptsDir(questId: string): string | null {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot || !questId) {
            return null;
        }
        return WsPaths.ai('quests', questId, 'prompt') || path.join(wsRoot, '_ai', 'quests', questId, 'prompt');
    }

    private _getQuestPromptScopes(): { id: string; label: string; dir: string }[] {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) {
            return [];
        }
        const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
        if (!fs.existsSync(questsDir) || !fs.statSync(questsDir).isDirectory()) {
            return [];
        }
        return fs.readdirSync(questsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const questId = entry.name;
                return {
                    id: questId,
                    label: questId,
                    dir: this._getQuestPromptsDir(questId) || path.join(questsDir, questId, 'prompt'),
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    private _parseReusablePromptId(reusableId: string): { filePath: string; fileName: string } | null {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot || !reusableId) {
            return null;
        }

        if (reusableId.startsWith('global::')) {
            const fileName = reusableId.substring('global::'.length);
            if (!fileName) {
                return null;
            }
            const dir = this._getGlobalPromptsDir();
            if (!dir) {
                return null;
            }
            return { filePath: path.join(dir, fileName), fileName };
        }

        if (reusableId.startsWith('quest::')) {
            const parts = reusableId.split('::');
            if (parts.length !== 3) {
                return null;
            }
            const questId = parts[1] || '';
            const fileName = parts[2] || '';
            if (!questId || !fileName) {
                return null;
            }
            const dir = this._getQuestPromptsDir(questId);
            if (!dir) {
                return null;
            }
            return { filePath: path.join(dir, fileName), fileName };
        }

        if (reusableId.startsWith('project::') || reusableId.startsWith('scan::') || reusableId.startsWith('path::')) {
            const parts = reusableId.split('::');
            if (parts.length !== 3) {
                return null;
            }
            const dir = decodeURIComponent(parts[1] || '');
            const fileName = parts[2] || '';
            if (!dir || !fileName) {
                return null;
            }
            return { filePath: path.join(dir, fileName), fileName };
        }

        return null;
    }

    private async _sendReusablePrompts(): Promise<void> {
        const wsRoot = getWorkspaceRoot();
        const globalDir = this._getGlobalPromptsDir();
        // Both walk the workspace: asynchronously and shared, so asking for
        // the prompts while the window opens does not hold the extension host.
        const [projectScopes, scanScopes] = wsRoot
            ? await Promise.all([projectPromptScopes(wsRoot), scanPromptScopes(wsRoot)])
            : [[], []];
        const questScopes = this._getQuestPromptScopes();
        const preferredQuestId = this._getPreferredQuestId();

        const listPromptFiles = (dir: string): { id: string; label: string }[] => {
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
                return [];
            }
            return fs.readdirSync(dir)
                .filter((file) => file.endsWith('.prompt.md'))
                .sort()
                .map((file) => ({ id: file, label: file }));
        };

        const model = {
            scopes: {
                project: projectScopes.map((scope) => ({ id: scope.id, label: scope.label })),
                quest: questScopes.map((scope) => ({ id: scope.id, label: scope.label })),
                scan: scanScopes.map((scope) => ({ id: scope.id, label: scope.label })),
            },
            files: {
                global: globalDir ? listPromptFiles(globalDir) : [],
                project: Object.fromEntries(projectScopes.map((scope) => [scope.id, listPromptFiles(scope.dir)])),
                quest: Object.fromEntries(questScopes.map((scope) => [scope.id, listPromptFiles(scope.dir)])),
                scan: Object.fromEntries(scanScopes.map((scope) => [scope.id, listPromptFiles(scope.dir)])),
            },
        };

        // Pre-select project containing the active editor file
        let preferredProjectId = projectScopes[0]?.id || '';
        const activeFilePath = vscode.window.activeTextEditor?.document?.uri.fsPath;
        if (activeFilePath && projectScopes.length > 0) {
            // Find the most specific (deepest) project whose absolutePath contains the active file
            let bestMatch: { id: string; depth: number } | undefined;
            for (const scope of projectScopes) {
                const projectDir = decodeURIComponent(scope.id);
                if (activeFilePath.startsWith(projectDir + path.sep) || activeFilePath === projectDir) {
                    const depth = projectDir.split(path.sep).length;
                    if (!bestMatch || depth > bestMatch.depth) {
                        bestMatch = { id: scope.id, depth };
                    }
                }
            }
            if (bestMatch) {
                preferredProjectId = bestMatch.id;
            }
        }

        this._view?.webview.postMessage({
            type: 'reusablePrompts',
            model,
            preferredQuestId,
            preferredProjectId,
            preferredScanId: scanScopes[0]?.id || '',
        });
    }

    private _loadReusablePromptContent(reusableId: string): void {
        const parsed = this._parseReusablePromptId(reusableId);
        if (!parsed || !fs.existsSync(parsed.filePath)) {
            this._view?.webview.postMessage({ type: 'reusablePromptContent', reusableId, content: '' });
            return;
        }
        const content = fs.readFileSync(parsed.filePath, 'utf-8');
        this._view?.webview.postMessage({ type: 'reusablePromptContent', reusableId, content });
    }

    private async _sendReusablePrompt(
        reusableId: string,
        section?: string,
        anthropicState?: { profile?: string; model?: string; config?: string; userMessageTemplate?: string },
    ): Promise<void> {
        const parsed = this._parseReusablePromptId(reusableId);
        if (!parsed || !fs.existsSync(parsed.filePath)) {
            vscode.window.showWarningMessage('Reusable prompt file not found.');
            return;
        }
        const content = fs.readFileSync(parsed.filePath, 'utf-8');
        if (!content.trim()) {
            vscode.window.showWarningMessage('Reusable prompt is empty.');
            return;
        }
        // Route by originating section so the Send icon behaves like typing
        // the reusable prompt into the section's textarea and clicking Send
        // (spec: user expectation). Sections without a `sendReusablePrompt`
        // hook fall back to Copilot for backwards compatibility.
        const provider = chatProviders.get(section);
        if (provider?.sendReusablePrompt) {
            await provider.sendReusablePrompt(content, anthropicState as Record<string, unknown>);
            return;
        }
        await this._handleSendCopilot(content, '__answer_file__', 1);
    }

    private async _openReusablePromptInEditor(section: string, reusableId: string): Promise<void> {
        const parsed = this._parseReusablePromptId(reusableId);
        if (!parsed || !fs.existsSync(parsed.filePath)) {
            vscode.window.showWarningMessage('Reusable prompt file not found.');
            return;
        }

        // Map reusableId prefix to PromptScope for the new editor
        let scope: 'global' | 'project' | 'quest' | 'scan' = 'global';
        let subScopeId: string | undefined;
        if (reusableId.startsWith('global::')) {
            scope = 'global';
        } else if (reusableId.startsWith('quest::')) {
            scope = 'quest';
            subScopeId = reusableId.split('::')[1];
        } else if (reusableId.startsWith('project::')) {
            scope = 'project';
            subScopeId = decodeURIComponent(reusableId.split('::')[1] || '');
        } else if (reusableId.startsWith('scan::') || reusableId.startsWith('path::')) {
            scope = 'scan';
            subScopeId = decodeURIComponent(reusableId.split('::')[1] || '');
        }

        openReusablePromptEditor(this._context, {
            scope,
            subScopeId,
            fileId: parsed.fileName,
        });
    }

    private async _openReusablePromptInOverlay(reusableId: string): Promise<void> {
        const parsed = this._parseReusablePromptId(reusableId);
        if (!parsed || !fs.existsSync(parsed.filePath)) {
            vscode.window.showWarningMessage('Reusable prompt file not found.');
            return;
        }
        const content = fs.readFileSync(parsed.filePath, 'utf-8');
        await showMarkdownHtmlPreview(this._context, {
            title: parsed.fileName,
            markdown: content,
            meta: parsed.filePath,
        });
    }

    private async _openReusablePromptInExternalApp(reusableId: string): Promise<void> {
        const parsed = this._parseReusablePromptId(reusableId);
        if (!parsed || !fs.existsSync(parsed.filePath)) {
            vscode.window.showWarningMessage('Reusable prompt file not found.');
            return;
        }
        const opened = await openInExternalApplication(parsed.filePath);
        if (!opened) {
            vscode.window.showWarningMessage('No external application configured for this file type.');
        }
    }

    private _resolveReusablePromptTargetDir(selection: { type?: string; scopeId?: string }): string | null {
        const selectedType = (selection.type || '').toLowerCase();
        if (selectedType === 'global') {
            return this._getGlobalPromptsDir();
        }
        if (selectedType === 'project') {
            const projectRoot = decodeURIComponent(selection.scopeId || '');
            return projectRoot ? path.join(projectRoot, 'prompt') : null;
        }
        if (selectedType === 'quest') {
            const questId = selection.scopeId || '';
            return this._getQuestPromptsDir(questId);
        }
        if (selectedType === 'scan') {
            const folder = decodeURIComponent(selection.scopeId || '');
            return folder || null;
        }
        return null;
    }

    private async _saveReusablePrompt(_section: string, text: string, selection: { type?: string; scopeId?: string }): Promise<void> {
        if (!text || !text.trim()) {
            vscode.window.showWarningMessage('Current tab text is empty; nothing to save.');
            return;
        }

        const dir = this._resolveReusablePromptTargetDir(selection || {});
        if (!dir) {
            vscode.window.showWarningMessage('Please select a folder first.');
            return;
        }

        const fileBase = await vscode.window.showInputBox({
            prompt: 'Enter filename (without .prompt.md)',
            placeHolder: 'documentation_update',
        });
        if (!fileBase) {
            return;
        }

        const normalized = fileBase.trim().replace(/\.prompt\.md$/i, '').replace(/\.md$/i, '');
        if (!normalized) {
            return;
        }

        const fileName = `${normalized}.prompt.md`;
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, fileName);
        if (fs.existsSync(filePath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `Prompt "${fileName}" already exists. Overwrite?`,
                { modal: true },
                'Overwrite'
            );
            if (overwrite !== 'Overwrite') {
                return;
            }
        }

        fs.writeFileSync(filePath, text, 'utf-8');
        vscode.window.showInformationMessage(`Saved reusable prompt: ${fileName}`);
        void this._sendReusablePrompts();
    }

    private _extractRequestIdFromExpandedPrompt(expanded: string): string | undefined {
        const regexes = [
            /"requestId"\s*:\s*"([^"]+)"/,
            /requestId\s*[:=]\s*['"]([^'"]+)['"]/,
        ];
        for (const re of regexes) {
            const match = expanded.match(re);
            if (match?.[1]) {
                return match[1].trim();
            }
        }
        return undefined;
    }

    /**
     * Send to Copilot Chat: the text in the chosen template (one store, the
     * Anthropic user-message templates), put into the Copilot Queue Wrapper when
     * `wrap` is on (the panel's Wrap checkbox; `__answer_file__` as the template
     * means "no template, wrapped").
     */
    private async _handleSendCopilot(text: string, template: string, slot?: number, wrap?: boolean): Promise<void> {
        const config = loadSendToChatConfig();
        const isAnswerFileTemplate = wrap === true || template === ANSWER_WRAPPER_ID;
        const panelSlot = Number.isInteger(slot) && (slot as number) >= 1 && (slot as number) <= 9 ? (slot as number) : 1;
        this._lastSentCopilotSlot = panelSlot;

        // Always log the prompt (before expansion)
        logCopilotPrompt(text, template);

        const body = userMessageTemplateBody(config, template);
        let expanded = body ? await expandTemplate(fillTemplate(body, text)) : await expandTemplate(text);
        if (isAnswerFileTemplate) {
            // Delete the existing answer file before sending, so a stale one is not read as the answer.
            deleteAnswerFile();
            this._notifyAnswerFileStatus();
            expanded = await expandTemplate(fillWrapper(copilotQueueWrapper(config), expanded));
        }

        // Extract requestId from expanded prompt so trail and answer share the same ID
        const requestId = this._extractRequestIdFromExpandedPrompt(expanded);

        // Write to trail (consolidated + individual files)
        writePromptTrail(text, template, isAnswerFileTemplate, expanded, requestId);
        if (requestId) {
            this._copilotRequestSlotMap.set(requestId, panelSlot);
        }
        
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
        
        // Clear the textarea if keepContent is false
        if (!this._keepContentAfterSend) {
            this._view?.webview.postMessage({ type: 'clearCopilotText' });
        }
        
        // Apply auto-hide if configured
        if (this._autoHideDelay > 0) {
            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            }, this._autoHideDelay);
        }
    }

    /**
     * Cancel the in-flight turn on the given section. Cancel
     * primitives vary per section (CTS, module-level interrupt,
     * conversation manager halt) so each section contributes its
     * own `cancelInFlight` hook to the chat-provider registry. A
     * section without a registered hook is a no-op.
     */
    private _handleCancel(section: string): void {
        debugLog(`[ChatPanel] cancel requested for section=${section}`, 'INFO', 'extension');
        chatProviders.get(section)?.cancelInFlight?.();
    }

    // --- Anthropic: send, model fetch, trail -------------------------------
    // Spec §11 — ANTHROPIC panel section. The handler funnels the user
    // input through AnthropicHandler.sendMessage(), which runs the full
    // tool loop (with approval gating) and returns a single answer string.

    private _anthropicApprovalListenerAttached = false;
    private _anthropicStatusListenerAttached = false;

    private _ensureAnthropicApprovalListener(): void {
        if (this._anthropicApprovalListenerAttached) {
            return;
        }
        this._anthropicApprovalListenerAttached = true;
        AnthropicHandler.instance.onApprovalNeeded((req) => this._approvals.request(req));
        AnthropicHandler.instance.onApprovalSettled((toolUseId) => this._approvals.settled(toolUseId));
    }

    /**
     * Forward handler status events ("waiting for history compaction…",
     * "Rebuild history from last N prompts…") to the webview so they
     * show up in place of the generic "Sending…" status while the
     * handler waits on background work.
     */
    private _ensureAnthropicStatusListener(): void {
        if (this._anthropicStatusListenerAttached) {
            return;
        }
        this._anthropicStatusListenerAttached = true;
        AnthropicHandler.instance.onStatusUpdate((text) => {
            this._view?.webview.postMessage({
                type: 'anthropicStatus',
                text,
            });
        });
    }

    /**
     * Mirror an Anthropic chat-panel turn into the window-status panel
     * so the sidebar's `anthropic` dot reflects this window's panel
     * activity (orange while waiting, green once the turn returns). Uses
     * the same windowId/workspace/quest source as the Copilot trail so
     * all subsystem dots land on a single window card. Best-effort —
     * a status-panel failure must never break the chat send.
     */
    private _updateAnthropicWindowStatus(status: 'prompt-sent' | 'answer-received'): void {
        try {
            writeWindowState(getWindowId(), getWorkspaceName(), WsPaths.getWorkspaceQuestId(), 'anthropic', status);
        } catch (e) {
            debugLog(`[ChatPanel] Failed to update anthropic window status: ${e}`, 'WARN', 'windowStatus');
        }
    }

    private async _handleSendAnthropic(text: string, profileId: string, modelId: string, configId: string, userMessageTemplateId?: string, skipQuestRefresh = false, slot?: number): Promise<void> {
        if (!text || !text.trim()) { return; }
        // Two prompts never share a conversation: a busy session (a queue item
        // or another chat send runs in it) makes the user choose — queue it
        // next or after the current item, or send it in a free session.
        let targetSession = this._chatSessionKey();
        // A send of this panel still runs: the replies below must not end its "sending" state,
        // and no second send can start now (one interactive turn at a time).
        const panelBusy = isAnthropicSendInFlight();
        const busy = await resolveBusySession({
            session: targetSession,
            send: { text, ...(profileId ? { profileId } : {}), ...(configId ? { configId } : {}), ...(userMessageTemplateId ? { template: userMessageTemplateId } : {}) },
            interactive: true,
            canSendElsewhere: !panelBusy,
        });
        if (busy.kind === 'cancelled') {
            this._view?.webview.postMessage({ type: 'anthropicNotSent', message: busy.message, ...(panelBusy ? { panelBusy } : {}) });
            return;
        }
        if (busy.kind === 'queued' || busy.kind === 'update') {
            this._view?.webview.postMessage({
                type: 'anthropicNotSent',
                message: busy.kind === 'update'
                    ? `Sent as an update to the running prompt in session ${busy.session}.`
                    : busy.how === 'next' ? `Queued to run next in session ${busy.session}.` : `Queued to run after the current item in session ${busy.session}.`,
                queued: true,
                ...(panelBusy ? { panelBusy } : {}),
                ...(slot ? { slot } : {}),
            });
            return;
        }
        if (busy.kind === 'send') { targetSession = busy.session; }
        // Spec: only one interactive Anthropic turn at a time. The webview
        // already disables Send during a panel turn, but the shared guard also
        // blocks a concurrent Send-to-Chat / scripting turn — and vice versa.
        if (!tryBeginAnthropicSend()) {
            this._view?.webview.postMessage({
                type: 'anthropicNotSent',
                message: 'Not sent: an Anthropic chat request is already running here, and its prompt takes no updates.',
                panelBusy: true,
            });
            return;
        }
        const config = loadSendToChatConfig();
        const userMessageTemplates: Array<{ id: string; template: string; isDefault?: boolean }> = Array.isArray(config?.anthropic?.userMessageTemplates)
            ? (config!.anthropic!.userMessageTemplates! as Array<{ id: string; template: string; isDefault?: boolean }>)
            : [];
        const userMessageTemplate = (userMessageTemplateId
            ? userMessageTemplates.find((t) => t.id === userMessageTemplateId)?.template
            : userMessageTemplates.find((t) => t.isDefault)?.template)
            || undefined;

        // Spec §4.3: profile's configurationId can resolve to either an
        // Anthropic configuration or a Local LLM configuration. Use the
        // shared resolver so this flow matches the queue dispatcher.
        const { resolveAnthropicTargets } = await import('../utils/resolveAnthropicTargets.js');
        const resolved = resolveAnthropicTargets({
            profileId,
            configId,
            modelOverride: modelId || undefined,
        });

        let profile: AnthropicProfile;
        let cfg: AnthropicConfiguration;
        if ('error' in resolved) {
            // Fall back to an inline (no-config) send when the user has
            // explicitly picked a model via the model dropdown — preserves
            // the legacy escape hatch for users who haven't defined a
            // configuration yet. Otherwise surface the error to the webview.
            if (!modelId) {
                this._view?.webview.postMessage({
                    type: 'anthropicError',
                    message: resolved.error + ' — add a configuration on the Status Page or pick a model.',
                });
                endAnthropicSend();
                return;
            }
            profile = {
                id: '__inline__',
                name: '(inline)',
                description: '',
                systemPrompt: '',
            };
            cfg = {
                id: '__inline__',
                name: '(inline)',
                model: modelId,
                maxTokens: 8192,
                maxRounds: 10,
            };
        } else {
            profile = resolved.profile;
            cfg = resolved.configuration;
        }

        // A profile that keeps its conversation elsewhere than the session's
        // existing one (an Agent SDK session vs. our own history) cannot continue it.
        const mismatch = sessionTransportMismatch(sessionsFolder(WsPaths.getWorkspaceQuestId()), targetSession, {
            id: profile.id,
            ...(cfg.model ? { model: cfg.model } : {}),
            continuity: resolveEffectiveHistoryMode(cfg.historyMode, cfg.transport ?? 'direct') === 'sdk-managed' ? 'sdk' : 'history',
        });
        if (mismatch) {
            this._view?.webview.postMessage({ type: 'anthropicError', message: mismatch });
            endAnthropicSend();
            return;
        }

        // Tool resolution — profile is the single source of truth.
        // Filtering lives in resolveProfileTools() so the chat panel and the
        // scripting-API bridge (tools.getJsonVce) stay in lockstep.
        const tools: SharedToolDefinition[] = resolveProfileTools(
            profile as unknown as { enabledTools?: string[]; toolsEnabled?: boolean },
        );

        this._ensureAnthropicApprovalListener();
        this._ensureAnthropicStatusListener();

        // Register a cancellation source so the panel's stop button can abort the turn.
        this._activeCts.get('anthropic')?.dispose();
        const cts = new vscode.CancellationTokenSource();
        this._activeCts.set('anthropic', cts);

        // Arm the shared cancel hook so a remote driver (Telegram `/cancel_chat`)
        // can interrupt this panel turn exactly like the Stop button: cancel the
        // token and abort any pending tool-approval gate. The slot was already
        // claimed above; `setAnthropicSendCancel` attaches to that claim.
        setAnthropicSendCancel(() => {
            cts.cancel();
            AnthropicHandler.instance.abortPendingApprovals();
        });

        // Light the window-status panel's `anthropic` dot (orange) for
        // the duration of the turn; flipped to green on success below.
        this._updateAnthropicWindowStatus('prompt-sent');

        try {
            // The send is shown in the prompt queue (status chat, then chat-sent with its answer).
            // The session picked in the panel, or the free one chosen above.
            const sessionKey = targetSession;
            // It has started: the slot it came from is cleared unless it keeps its text.
            this._view?.webview.postMessage({ type: 'anthropicSendStarted', ...(slot ? { slot } : {}) });
            const result = await trackChatSend(
                { text, profileId: profile.id, session: sessionKey, source: skipQuestRefresh ? 'quest refresh' : 'panel' },
                () => AnthropicHandler.instance.sendMessage({
                    userText: text,
                    profile,
                    configuration: cfg,
                    tools,
                    cancellationToken: cts.token,
                    // The session picked in the panel (its own `chat` unless another was picked),
                    // separate from the prompt queue's `default`, so the two never resume each other.
                    sessionKey,
                    skipQuestRefresh,
                    ...(userMessageTemplate ? { userMessageTemplate } : {}),
                }),
                // Ended by its timeout or by removing its entry: stopped like the Stop button.
                { cancel: () => { cts.cancel(); AnthropicHandler.instance.abortPendingApprovals(); } },
            );
            this._updateAnthropicWindowStatus('answer-received');
            this._view?.webview.postMessage({
                type: 'anthropicResult',
                text: result.text,
                turnsUsed: result.turnsUsed,
                toolCallCount: result.toolCallCount,
                historyMode: cfg.historyMode || '',
                // The send's tokens (input / output / cache read / cache write) for the status line.
                usageLine: usageSummaryLine(result.usage),
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            debugLog(`[ChatPanel] Anthropic send failed: ${msg}`, 'ERROR', 'extension');
            this._view?.webview.postMessage({ type: 'anthropicError', message: msg });
        } finally {
            if (this._activeCts.get('anthropic') === cts) {
                this._activeCts.delete('anthropic');
            }
            cts.dispose();
            endAnthropicSend();
        }
    }

    private async _sendAnthropicModels(): Promise<void> {
        const started = Date.now();
        const result = await AnthropicHandler.instance.fetchModels();
        const elapsedMs = Date.now() - started;
        // The webview only shows the error in the status line, which the
        // next status update overwrites — log it so an empty Model
        // dropdown can be diagnosed afterwards.
        if (result.error) {
            debugLog(`[Anthropic] models.list failed in ${elapsedMs}ms: ${result.error}`, 'ERROR', 'chatPanel');
        } else {
            debugLog(`[Anthropic] models.list returned ${result.models.length} model(s) in ${elapsedMs}ms`, 'INFO', 'chatPanel');
        }
        this._view?.webview.postMessage({
            type: 'anthropicModels',
            models: result.models,
            ...(result.error ? { error: result.error } : {}),
        });
    }

    /**
     * Populate the informational VS Code LM model dropdown on the
     * Anthropic panel (spec §4.12). Called on Refresh click. Purely
     * informational — selection does not retarget sends.
     */
    private async _sendVsCodeLmModels(): Promise<void> {
        try {
            const started = Date.now();
            const models = await vscode.lm.selectChatModels({});
            const elapsedMs = Date.now() - started;
            const entries = models.map((m) => ({
                id: m.id,
                vendor: m.vendor,
                family: m.family,
                name: m.name,
                label: `${m.vendor} · ${m.family} — ${m.name || m.id}`,
            }));
            debugLog(
                `[VsCodeLm] selectChatModels returned ${entries.length} model(s) in ${elapsedMs}ms`,
                'INFO',
                'chatPanel',
            );
            // Empty result usually means Copilot hasn't finished booting
            // or the user isn't signed in. Include an informational hint
            // so the dropdown empty-state is actionable; the webview
            // picks this up and renders a human-readable message.
            let hint: string | undefined;
            if (entries.length === 0) {
                const copilotExt = vscode.extensions.getExtension('GitHub.copilot-chat')
                    ?? vscode.extensions.getExtension('GitHub.copilot');
                hint = copilotExt
                    ? (copilotExt.isActive
                        ? 'no models — sign into GitHub Copilot or wait for models to load'
                        : 'Copilot extension inactive — open Copilot Chat once to activate')
                    : 'GitHub Copilot not installed';
                debugLog(`[VsCodeLm] empty result; hint: ${hint}`, 'WARN', 'chatPanel');
            }
            this._view?.webview.postMessage({
                type: 'vscodeLmModels',
                models: entries,
                hint,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            debugLog(`[VsCodeLm] selectChatModels threw: ${msg}`, 'ERROR', 'chatPanel');
            this._view?.webview.postMessage({
                type: 'vscodeLmModels',
                models: [],
                error: msg,
            });
        }
    }

    /**
     * Open the summary trail of `sessions` — each session's own trail pair
     * (src/services/sessionStorage.ts) — or, without them, of the sessions the
     * user picks (the panel's own button).
     */
    private async _openAnthropicSummaryTrail(sessions?: string[]): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId();
        const names = sessions ?? await this._pickPanelSessions('Open the summary trail');
        for (const session of names ?? []) {
            const summaryPath = TrailService.instance.getSummaryFilePath('prompts', { type: 'anthropic', session }, questId);
            if (!summaryPath || !fs.existsSync(summaryPath)) {
                vscode.window.showInformationMessage(`No Anthropic summary trail yet for session "${session}".`);
                continue;
            }
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(summaryPath), 'tomAi.trailViewer');
        }
    }

    /**
     * The sessions an action of the panel works on: the session selection
     * (src/handlers/sessionSelectionPicker.ts) with the panel's session
     * preselected; `destructive` adds the confirmation. Undefined when dismissed.
     */
    /**
     * A per-session action for the given sessions: the raw trail viewer, the
     * trail summary, the history, the live trail, the memory panel, clearing the
     * history. The @WS Logs panel calls it for its selected session
     * (runChatSessionAction); the panel's own handlers for the sessions picked.
     */
    async runSessionAction(action: ChatSessionAction, names: string[]): Promise<void> {
        switch (action) {
            case 'rawTrail': {
                const quest = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
                const root = TwoTierMemoryService.instance.historyFolder(quest || undefined);
                const folders = names.map((n) => sessionTrailFolder(root, n)).filter((f) => fs.existsSync(f));
                if (folders.length === 0) {
                    vscode.window.showInformationMessage(`No raw trail yet for ${names.join(', ')}.`);
                    return;
                }
                for (const folder of folders) {
                    await vscode.commands.executeCommand('tomAi.editor.rawTrailViewer', vscode.Uri.file(folder), 'anthropic');
                }
                return;
            }
            case 'trailSummary':
                // The given sessions' summary trails, not a picker preselected on the panel's session.
                await this._openAnthropicSummaryTrail(names);
                return;
            case 'history':
                for (const name of names) { await this._openSessionHistoryMarkdown(name); }
                return;
            case 'liveTrail':
                for (const name of names) { await this._openLiveTrailMarkdown('anthropic', name); }
                return;
            case 'memory':
                // The memory panel shows one session's quest memory: the first given.
                await vscode.commands.executeCommand('tomAi.panel.memory', names[0]);
                return;
            case 'clearHistory': {
                const choice = await vscode.window.showWarningMessage(
                    `Clear the history of session ${names.join(', ')}? Its conversation and compacted history are removed; the trails stay.`,
                    { modal: true },
                    'Clear history',
                );
                if (choice === 'Clear history') { this._clearSessions(names); }
                return;
            }
        }
    }

    private _clearSessions(names: string[]): void {
        for (const name of names) { AnthropicHandler.instance.clearSession(name); }
        this._view?.webview.postMessage({
            type: 'anthropicHistoryCleared',
            sessions: names,
            panelSession: names.includes(this._chatSessionKey()),
        });
    }

    private async _pickPanelSessions(title: string, destructive?: string): Promise<string[] | undefined> {
        const quest = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        return pickSessions(quest, {
            title,
            current: this._chatSessionKey(),
            extra: sessionsWithStorage(TwoTierMemoryService.instance.historyFolder(quest || undefined)),
            ...(destructive ? { destructive } : {}),
        });
    }

    /**
     * Open the rolling session history (the markdown version written next
     * to history.json on every turn by TwoTierMemoryService.persistHistorySnapshot)
     * in the MD Browser custom editor. When the file is missing we
     * fall through to a warning instead of opening something blank.
     */
    private async _openSessionHistoryMarkdown(session: string = this._chatSessionKey()): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        // Every session keeps its own history.
        const folder = sessionRoot(TwoTierMemoryService.instance.historyFolder(questId || undefined), session);
        const target = path.join(folder, 'history.md');
        if (!fs.existsSync(target)) {
            vscode.window.showInformationMessage(
                `No history yet for session "${session}" of quest "${questId || 'default'}". The history file is written after the first completed turn (${target}).`,
            );
            return;
        }
        const uri = vscode.Uri.file(target);
        await vscode.commands.executeCommand('tomAi.openInMdBrowser', uri);
    }

    /**
     * Open the canonical memory file for `scope` in the MD Browser.
     * Both quest-scoped and shared-scoped memory live as `facts.md`
     * inside `_ai/memory/<scope>/` (see TwoTierMemoryService's
     * `scopeFolder()` + `filePath()`); the default memory-extraction
     * template writes there. When the file is missing we surface an
     * informational notice naming the path the next extraction pass
     * would create — same pattern as `_openSessionHistoryMarkdown`.
     */
    private async _openMemoryMarkdown(scope: 'quest' | 'shared'): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        const target = TwoTierMemoryService.instance.filePath(scope, 'facts.md', questId || undefined);
        const scopeLabel = scope === 'shared' ? 'shared' : `quest "${questId || 'default'}"`;
        if (!fs.existsSync(target)) {
            vscode.window.showInformationMessage(
                `No ${scopeLabel} memory yet. The file is written after the first memory-extraction pass that finds something memory-worthy (${target}).`,
            );
            return;
        }
        const uri = vscode.Uri.file(target);
        await vscode.commands.executeCommand('tomAi.openInMdBrowser', uri);
    }

    /**
     * Open a session's live-trail markdown in the MD Browser, in its live
     * variant: the file watcher (debounced 200 ms) re-renders it as the
     * handler appends events. The file is created on the session's first
     * send; before that an info message names it.
     */
    private async _openLiveTrailMarkdown(section: string = 'anthropic', session: string = this._chatSessionKey()): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        // Resolve the quest folder the same way LiveTrailWriter does.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
        const safeQuest = sanitizeQuestSegment(questId);
        const transportLabel = section === 'anthropic' ? 'Anthropic/LLM' : section;
        const target = sessionLiveTrailFile(path.join(questsRoot, safeQuest, 'history'), session);
        if (!fs.existsSync(target)) {
            vscode.window.showInformationMessage(
                `No ${transportLabel} live trail yet for quest "${questId || 'default'}". The file is created on the first ${transportLabel} send (${target}).`,
            );
            return;
        }
        const uri = vscode.Uri.file(target);
        // Use the live variant so the MD Browser auto-scrolls to the
        // bottom on each re-render as events stream in.
        await vscode.commands.executeCommand('tomAi.openInMdBrowserLive', uri);
    }

    // =========================================================================
    // Copilot Answer File Methods
    // =========================================================================

    private async _showAnswerViewer(): Promise<void> {
        const answer = readAnswerFile();
        if (!answer?.generatedMarkdown) {
            await showMarkdownHtmlPreview(this._context, {
                title: 'Copilot Answer',
                markdown: 'No answer file found.',
                meta: 'No metadata available',
            });
            return;
        }

        const references = (answer.references || []).join(', ');
        const meta = `Slot ${this._currentAnswerSlot} • Request ID: ${answer.requestId || 'N/A'}${references ? ` • References: ${references}` : ''}`;

        await showMarkdownHtmlPreview(this._context, {
            title: 'Copilot Answer',
            markdown: answer.generatedMarkdown,
            meta,
        });
    }

    private async _extractAnswerToMd(): Promise<void> {
        const answer = readAnswerFile();
        if (!answer?.generatedMarkdown) {
            vscode.window.showWarningMessage('No answer to extract');
            return;
        }
        
        const mdPath = getCopilotAnswersMdPath();
        const dir = path.dirname(mdPath);
        
        // Ensure directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Create marker for this answer
        const marker = `<!-- answer-id: ${answer.requestId} -->`;
        
        // Read existing file or create new
        let existingContent = '';
        if (fs.existsSync(mdPath)) {
            existingContent = fs.readFileSync(mdPath, 'utf-8');
        }
        
        // Check if this answer is already in the file
        if (existingContent.includes(marker)) {
            // Just open the file
            const doc = await vscode.workspace.openTextDocument(mdPath);
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
        }
        
        // Format the new entry
        const timestamp = new Date().toISOString();
        const entry = `${marker}\n## Answer ${timestamp}\n\n${answer.generatedMarkdown}\n\n`;
        
        // Prepend to file (after header if exists)
        let newContent: string;
        if (existingContent.startsWith('# ')) {
            // Find end of first line (header)
            const headerEnd = existingContent.indexOf('\n');
            if (headerEnd > 0) {
                newContent = existingContent.substring(0, headerEnd + 1) + '\n' + entry + existingContent.substring(headerEnd + 1);
            } else {
                newContent = existingContent + '\n\n' + entry;
            }
        } else if (existingContent.trim()) {
            newContent = entry + existingContent;
        } else {
            newContent = '# Copilot Answers\n\n' + entry;
        }
        
        fs.writeFileSync(mdPath, newContent, 'utf-8');
        
        // Write to trail (consolidated + individual files)
        writeAnswerTrail({
            requestId: answer.requestId,
            generatedMarkdown: answer.generatedMarkdown,
            comments: answer.comments,
            references: answer.references,
            requestedAttachments: answer.requestedAttachments,
            responseValues: answer.responseValues
        });
        
        // Open the file
        const doc = await vscode.workspace.openTextDocument(mdPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _openPromptsFile(): Promise<void> {
        const summaryPaths = getCopilotSummaryTrailPaths();
        if (!summaryPaths) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }

        if (!fs.existsSync(summaryPaths.promptsPath)) {
            vscode.window.showInformationMessage('No summary prompts trail exists yet. Send a prompt first.');
            return;
        }
        
        // Open or focus the file
        const doc = await vscode.workspace.openTextDocument(summaryPaths.promptsPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _openAnswersFile(): Promise<void> {
        const summaryPaths = getCopilotSummaryTrailPaths();
        if (!summaryPaths) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }

        if (!fs.existsSync(summaryPaths.answersPath)) {
            vscode.window.showInformationMessage('No summary answers trail exists yet. Extract an answer first.');
            return;
        }
        
        // Open or focus the file
        const doc = await vscode.workspace.openTextDocument(summaryPaths.answersPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    /**
     * Open the trail custom editor (tomAi.trailViewer) for the copilot prompts trail file.
     * Uses TrailService for path resolution so it is consistent with _openAnthropicSummaryTrail.
     */
    private async _openTrailFiles(): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId();
        const summaryPath = TrailService.instance.getSummaryFilePath('prompts', { type: 'copilot' }, questId);
        if (!summaryPath || !fs.existsSync(summaryPath)) {
            vscode.window.showInformationMessage('No Copilot summary trail exists yet. Send a prompt first.');
            return;
        }
        const uri = vscode.Uri.file(summaryPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
    }

    // ========================================================================
    // §3.1 Context & Settings Popup + Queue Integration
    // ========================================================================

    private async _sendContextData(): Promise<void> {
        const wsRoot = getWorkspaceRoot();
        let quests: string[] = [];
        let roles: string[] = [];
        let projects: string[] = [];
        let todoFiles: string[] = [];
        let todos: { id: string; title?: string; description?: string; status?: string }[] = [];

        // Scan quests from _ai/quests/
        if (wsRoot) {
            const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
            if (fs.existsSync(questsDir)) {
                try {
                    const entries = fs.readdirSync(questsDir, { withFileTypes: true });
                    quests = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
                } catch { /* ignore */ }
            }
        }

        // Scan roles from _ai/roles/
        if (wsRoot) {
            const rolesDir = WsPaths.ai('roles') || path.join(wsRoot, '_ai', 'roles');
            if (fs.existsSync(rolesDir)) {
                try {
                    const entries = fs.readdirSync(rolesDir, { withFileTypes: true });
                    roles = entries.filter(e => e.isDirectory() || e.name.endsWith('.md') || e.name.endsWith('.yaml'))
                        .map(e => e.isDirectory() ? e.name : e.name.replace(/\.(md|yaml)$/, ''))
                        .sort();
                } catch { /* ignore */ }
            }
        }

        // Get projects via scanWorkspaceProjects (scans for pubspec.yaml/package.json)
        try {
            const { scanWorkspaceProjects } = await import('../managers/questTodoManager.js');
            const scanned = scanWorkspaceProjects();
            projects = scanned.map(p => p.name);
        } catch { /* ignore */ }

        // Fallback: try tom_master.yaml if no projects found
        if (projects.length === 0 && wsRoot) {
            const masterYaml = WsPaths.metadata('tom_master.yaml') || path.join(wsRoot, '.tom_metadata', 'tom_master.yaml');
            if (fs.existsSync(masterYaml)) {
                try {
                    const yaml = await import('yaml');
                    const content = fs.readFileSync(masterYaml, 'utf-8');
                    const parsed = yaml.parse(content);
                    if (parsed?.projects) {
                        projects = Object.keys(parsed.projects).sort();
                    }
                } catch { /* ignore */ }
            }
        }

        // Get current values from ChatVariablesStore (if available)
        let currentQuest = '';
        let currentRole = '';
        let activeProjects: string[] = [];
        let currentTodoFile = '';
        let currentTodo = '';

        try {
            const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
            const store = ChatVariablesStore.instance;
            currentQuest = store.quest || '';
            currentRole = store.role || '';
            activeProjects = store.activeProjects || [];
            currentTodo = store.todo || '';
            currentTodoFile = store.todoFile || '';
        } catch { /* ChatVariablesStore may not be available */ }

        // Get todo files for current quest
        if (currentQuest && wsRoot) {
            const questDir = WsPaths.ai('quests', currentQuest) || path.join(wsRoot, '_ai', 'quests', currentQuest);
            if (fs.existsSync(questDir)) {
                try {
                    const files = fs.readdirSync(questDir);
                    todoFiles = files.filter(f => f.endsWith('.yaml') && f.includes('todo')).sort();
                } catch { /* ignore */ }
            }
        }

        // Get todos from current todo file
        if (currentQuest && currentTodoFile && wsRoot) {
            const todoPath = WsPaths.ai('quests', currentQuest, currentTodoFile) || path.join(wsRoot, '_ai', 'quests', currentQuest, currentTodoFile);
            if (fs.existsSync(todoPath)) {
                try {
                    const yaml = await import('yaml');
                    const content = fs.readFileSync(todoPath, 'utf-8');
                    const parsed = yaml.parse(content);
                    if (parsed?.todos && Array.isArray(parsed.todos)) {
                        todos = parsed.todos.map((t: any) => ({
                            id: t.id || '',
                            title: t.title || '',
                            description: t.description || '',
                            status: t.status || 'not-started'
                        }));
                    }
                } catch { /* ignore */ }
            }
        }

        this._view?.webview.postMessage({
            type: 'contextData',
            quests,
            roles,
            projects,
            todoFiles,
            todos,
            currentQuest,
            currentRole,
            activeProjects,
            currentTodoFile,
            currentTodo
        });
    }

    private _sendContextSummary(): void {
        let parts: string[] = [];
        try {
            const store = ChatVariablesStore.instance;
            if (store.quest) parts.push('Q:' + store.quest);
            if (store.role)  parts.push('R:' + store.role);
        } catch { /* store not yet initialised */ }
        this._view?.webview.postMessage({
            type: 'contextSummary',
            text: parts.length > 0 ? parts.join(' | ') : ''
        });
    }

    private async _applyContext(msg: any): Promise<void> {
        try {
            const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
            const store = ChatVariablesStore.instance;
            
            if (msg.quest !== undefined) store.set('quest', msg.quest, 'user');
            if (msg.role !== undefined) store.set('role', msg.role, 'user');
            if (msg.activeProjects !== undefined) store.setActiveProjects(msg.activeProjects || [], 'user');
            if (msg.todoFile !== undefined) store.set('todoFile', msg.todoFile, 'user');
            if (msg.todo !== undefined) store.set('todo', msg.todo, 'user');
        } catch { /* ignore */ }

        // Update context summary
        this._sendContextSummary();
        void this._sendReusablePrompts();
    }

    private async _handleAddToQueue(
        text: string,
        template: string,
        repeatCount?: number | string,
        answerWaitMinutes?: number,
        transportOpts?: {
            transport?: 'copilot' | 'anthropic';
            anthropicProfileId?: string;
            anthropicConfigId?: string;
            /** Pin this panel's profile and session; without it the queue's own apply. */
            usePanelTarget?: boolean;
            /** Queue next: pending at the front, between a running loop's iterations (enqueueNext). */
            next?: boolean;
        },
        /** Where the prompt came from, echoed in `queueAdded` so that slot is cleared unless it keeps its text. */
        origin?: { section?: string; slot?: number },
    ): Promise<void> {
        try {
            const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
            const queue = PromptQueueManager.instance;
            if (queue) {
                const transport = transportOpts?.transport ?? 'copilot';
                const next = transportOpts?.next === true;
                await (next ? queue.enqueueNext.bind(queue) : queue.enqueue.bind(queue))({
                    originalText: text,
                    template: template || undefined,
                    // Preserve non-numeric strings (chat variables, `prefix*`
                    // patterns like `tod*`) verbatim so they resolve when the
                    // item is processed; only coerce actual numeric input.
                    repeatCount: normalizeRepeatCountInput(repeatCount),
                    templateRepeatCount: undefined,
                    // answerWait / reminder fields don't apply to anthropic
                    // items (spec §4.7). Leave them undefined.
                    answerWaitMinutes: transport === 'copilot' && answerWaitMinutes && answerWaitMinutes > 0
                        ? answerWaitMinutes
                        : undefined,
                    // Queue next goes out on its own (pending); Save to Queue stages it.
                    deferSend: !next,
                    transport: transport === 'anthropic' ? 'anthropic' : undefined,
                    // Save to Queue: the prompt queue's own profile and session (nothing pinned).
                    // Save to Queue with the panel's target: this panel's profile and session,
                    // so the queued prompt continues the panel's conversation as Send would.
                    ...(transport === 'anthropic' && transportOpts?.usePanelTarget && !next
                        ? { anthropicProfileId: transportOpts.anthropicProfileId, anthropicConfigId: transportOpts.anthropicConfigId, session: this._chatSessionKey() }
                        : {}),
                });
                const count = queue.items.length;
                vscode.window.showInformationMessage(next
                    ? `Queued next (${count} items, ${transport})`
                    : `Added to prompt queue (${count} items, ${transport})`);
                this._view?.webview.postMessage({ type: 'queueAdded', count, ...(origin?.section ? { section: origin.section } : {}), ...(origin?.slot ? { slot: origin.slot } : {}) });
            } else {
                vscode.window.showWarningMessage('Prompt queue not available');
            }
        } catch (err) {
            // Surface the real failure instead of swallowing it. A bare
            // `catch {}` here previously masked every enqueue/import error as
            // a generic "queue not available" toast, so a prompt that failed
            // to queue gave the user no idea why.
            const msg = err instanceof Error ? err.message : String(err);
            debugLog(`[ChatPanel] addToQueue failed: ${msg}\n${err instanceof Error ? err.stack ?? '' : ''}`, 'ERROR', 'queue');
            vscode.window.showErrorMessage(`Failed to add prompt to queue: ${msg}`);
        }
    }

    private async _sendTodosForFile(file: string): Promise<void> {
        const wsRoot = getWorkspaceRoot();
        const currentQuest = WsPaths.getWorkspaceQuestId();

        if (currentQuest === 'default' || !file || !wsRoot) {
            this._view?.webview.postMessage({ type: 'contextData', todos: [] });
            return;
        }

        const todoPath = WsPaths.ai('quests', currentQuest, file) || path.join(wsRoot, '_ai', 'quests', currentQuest, file);
        let todos: any[] = [];
        if (fs.existsSync(todoPath)) {
            try {
                const yaml = await import('yaml');
                const content = fs.readFileSync(todoPath, 'utf-8');
                const parsed = yaml.parse(content);
                if (parsed?.todos && Array.isArray(parsed.todos)) {
                    todos = parsed.todos.map((t: any) => ({
                        id: t.id || '',
                        title: t.title || '',
                        description: t.description || '',
                        status: t.status || 'not-started'
                    }));
                }
            } catch { /* ignore */ }
        }
        // Send partial update — only the todo dropdown, not the full context form
        this._view?.webview.postMessage({ type: 'contextTodosUpdate', todos });
    }

    private async _sendTodoFilesForQuest(quest: string): Promise<void> {
        const wsRoot = getWorkspaceRoot();
        let todoFiles: string[] = [];
        if (quest && wsRoot) {
            const questDir = WsPaths.ai('quests', quest) || path.join(wsRoot, '_ai', 'quests', quest);
            if (fs.existsSync(questDir)) {
                try {
                    const files = fs.readdirSync(questDir);
                    todoFiles = files.filter(f => f.endsWith('.yaml') && f.includes('todo')).sort();
                } catch { /* ignore */ }
            }
        }
        this._view?.webview.postMessage({ type: 'contextTodoFiles', todoFiles });
    }

    private async _saveAsTimedRequest(text: string, template?: string): Promise<void> {
        try {
            const { TimerEngine } = await import('../managers/timerEngine.js');
            const te = TimerEngine.instance;
            te.addEntry({
                enabled: false,
                template: template || '(None)',
                originalText: text,
                scheduleMode: 'interval',
                intervalMinutes: 30,
                scheduledTimes: [],
            });
            vscode.window.showInformationMessage('Saved as timed request (disabled, 30min default). Open Timed Requests editor to configure and enable.');
        } catch {
            vscode.window.showWarningMessage('Could not save timed request — TimerEngine not available.');
        }
    }

    private async _saveDrafts(drafts: Record<string, ChatDraftState>): Promise<void> {
        await saveChatDrafts(drafts);
    }

    private async _loadDrafts(): Promise<void> {
        const loaded = await loadChatDrafts();
        this._view?.webview.postMessage({ type: 'draftsLoaded', sections: loaded });
    }

    private async _showPanelsFile(): Promise<void> {
        try {
            const { openPromptPanelFile, getPromptPanelFilePath } = await import('../utils/panelYamlStore.js');
            const section = 'copilot';
            const promptFile = getPromptPanelFilePath(section);
            if (promptFile && fs.existsSync(promptFile)) {
                await openPromptPanelFile(section);
                return;
            }
        } catch { /* not available */ }
    }

    private async _openPromptPanelEditor(section: string, draft: { text?: string; profile?: string; activeSlot?: number; slots?: Record<string, string> }): Promise<void> {
        if (!section) {
            return;
        }
        try {
            const { getPromptPanelFilePath, writePromptPanelYaml, openPromptPanelFile } = await import('../utils/panelYamlStore.js');
            const filePath = getPromptPanelFilePath(section);
            if (!filePath || !fs.existsSync(filePath)) {
                await writePromptPanelYaml(section, {
                    text: draft.text || '',
                    profile: draft.profile || '',
                    activeSlot: draft.activeSlot || 1,
                    slots: draft.slots || {},
                });
            }
            await openPromptPanelFile(section);
        } catch { /* not available */ }
    }

    private async _handlePreview(section: string, text: string, profileOrTemplate: string, wrap = false): Promise<void> {
        const config = loadSendToChatConfig();
        let title = section;
        let previewContent = text;
        let onSend: ((t: string) => Promise<void>) | undefined;
        
        switch (section) {
            case 'copilot': {
                title = 'Copilot';
                // As _handleSendCopilot sends it: the template, then the
                // Copilot Queue Wrapper when Wrap is on.
                const body = userMessageTemplateBody(config, profileOrTemplate);
                const inner = body ? await expandTemplate(fillTemplate(body, text)) : text;
                previewContent = wrap || profileOrTemplate === ANSWER_WRAPPER_ID
                    ? await expandTemplate(fillWrapper(copilotQueueWrapper(config), inner))
                    : inner;
                onSend = async (t) => {
                    await vscode.commands.executeCommand('workbench.action.chat.open', { query: t });
                };
                break;
            }
        }
        
        // Final expansion for any remaining placeholders
        const expanded = await expandTemplate(previewContent);
        await showPreviewPanel(title, expanded, onSend);
    }

    // --- Profile CRUD (anthropic) ---

    private async _handleAddProfile(section: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            anthropic: 'anthropicProfiles',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category });
        }
    }

    private async _handleEditProfile(section: string, name?: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            anthropic: 'anthropicProfiles',
        };
        const category = categoryMap[section];
        if (!category) { return; }
        // When no profile is selected, open the editor on the category
        // root so the user can pick / add one. Previously returned early.
        openGlobalTemplateEditor(this._context, { category, ...(name ? { itemId: name } : {}) });
    }

    private async _handleEditAnthropicUserMessage(name?: string): Promise<void> {
        openGlobalTemplateEditor(this._context, {
            category: 'anthropicUserMessage',
            ...(name ? { itemId: name } : {}),
        });
    }

    private async _handleDeleteProfile(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${name}"?`, { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }

        // The section's provider deletes its own profile (anthropic);
        // sections without a deleteProfile hook are a no-op here.
        const provider = chatProviders.get(section);
        if (!provider?.deleteProfile) { return; }
        const deleted = await provider.deleteProfile(name);
        if (deleted) {
            this._sendProfiles();
            vscode.window.showInformationMessage('Profile deleted');
        }
    }

    // --- Template CRUD (the Copilot dropdown: user-message templates) ---

    private async _handleAddTemplate(section: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            copilot: 'anthropicUserMessage',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category });
        }
    }

    private async _handleEditTemplate(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const categoryMap: Record<string, TemplateCategory> = {
            copilot: 'anthropicUserMessage',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category, itemId: name });
        }
    }

    private async _handleDeleteTemplate(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete template "${name}"?`, { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (!config) { return; }

        // The Copilot dropdown lists the user-message templates (the one store).
        const templates = config.anthropic?.userMessageTemplates;
        if (section !== 'copilot' || !templates?.some((t) => t.id === name)) { return; }
        config.anthropic!.userMessageTemplates = templates.filter((t) => t.id !== name);

        if (saveSendToChatConfig(config)) {
            this._sendProfiles();
            vscode.window.showInformationMessage('Template deleted');
        }
    }

}

let _provider: ChatPanelViewProvider | undefined;

/** The per-session actions of the ANTHROPIC/LLM chat (runSessionAction). */
export type ChatSessionAction = 'rawTrail' | 'trailSummary' | 'history' | 'liveTrail' | 'memory' | 'clearHistory';
export const CHAT_SESSION_ACTIONS: readonly ChatSessionAction[] = ['rawTrail', 'trailSummary', 'history', 'liveTrail', 'memory', 'clearHistory'];

/** Run a per-session action for `session` (the @WS Logs panel's buttons). */
export async function runChatSessionAction(action: ChatSessionAction, session: string): Promise<void> {
    if (!_provider) { vscode.window.showWarningMessage('The chat panel is not ready yet.'); return; }
    await _provider.runSessionAction(action, [session]);
}

export function registerChatPanel(context: vscode.ExtensionContext): void {
    _provider = new ChatPanelViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, _provider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        // Closes the answer-folder watcher and the answer poll timer on deactivate.
        _provider,
    );
}

/**
 * External hook used by the status page (and any other configuration UI)
 * to push fresh Anthropic state into the chat panel after a config edit.
 * Re-emits profiles/configurations + the env-var-derived 🔑 status, then
 * fires a fresh `models.list()` so the Model dropdown reflects the new
 * `apiKeyEnvVar` without requiring a reload-window.
 *
 * Also resets the cached Anthropic SDK client and the Agent SDK probe so
 * the next request reads the new env var name and the 🤖 dot re-checks what
 * the Provider SDKs page installed (it calls this after every change).
 */
export function notifyAnthropicConfigChanged(): void {
    AnthropicHandler.instance.resetClient();
    ChatPanelViewProvider.resetClaudeCliProbe();
    if (!_provider) { return; }
    // Re-emit profiles + 🔑 / 🤖 dot states.
    (_provider as unknown as { _sendProfiles: () => void })._sendProfiles();
    // Trigger model list refresh.
    void (_provider as unknown as { _sendAnthropicModels: () => Promise<void> })._sendAnthropicModels();
}

/**
 * Whether the chat panel webview has been materialised at least once. The view
 * is created the first time the panel is revealed and — with
 * `retainContextWhenHidden` — is never torn down afterwards, so this stays
 * `true` for the rest of the window's life once the user has opened @CHAT.
 *
 * Used by the Telegram `send_prompt` command to refuse driving a panel that was
 * never opened (the user asked for an explicit "chat is not open" reply rather
 * than silently spinning up a hidden turn).
 */
export function isChatPanelOpen(): boolean {
    return !!(_provider as unknown as { _view?: vscode.WebviewView })?._view;
}

/**
 * External hook used by the Send-to-Chat router to mirror an Anthropic turn it
 * initiated (from the command/menu or the scripting bridge) into the chat panel
 * UI — so a routed send shows up just like a panel send. A no-op when the panel
 * has never been opened (`_view` is undefined); the turn is still written to
 * `live-trail.md` by the handler regardless.
 */
export function showAnthropicResultInPanel(
    text: string,
    meta: { turnsUsed: number; toolCallCount: number; historyMode: string; usage?: LiveTrailTokenCounts },
): void {
    const view = (_provider as unknown as { _view?: vscode.WebviewView })?._view;
    if (!view) { return; }
    view.webview.postMessage({
        type: 'anthropicResult',
        text,
        turnsUsed: meta.turnsUsed,
        toolCallCount: meta.toolCallCount,
        historyMode: meta.historyMode,
        usageLine: usageSummaryLine(meta.usage),
    });
}

