/**
 * Chat Panel (@CHAT)
 * 
 * A single webview containing multiple notepad sections with custom tab behavior:
 * - Accordion: opening one section collapses unpinned others
 * - Pin: pinned sections stay open regardless of accordion
 * - Rotate: collapsed sections show as vertical tabs
 * 
 * Sections:
 * - Local LLM
 * - AI Conversation  
 * - Copilot
 * - Tom AI Chat
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getConfigPath, SendToChatConfig, loadSendToChatConfig, saveSendToChatConfig, showPreviewPanel, getWorkspaceRoot, updateChatResponseValues, applyDefaultTemplate, getCopilotChatAnswerFolderAbsolute, DEFAULT_ANSWER_FILE_TEMPLATE, reportException, escapeHtml, openInExternalApplication, resolvePathVariables } from './handler_shared';
import { openGlobalTemplateEditor, TemplateCategory } from './globalTemplateEditor-handler';
import { openReusablePromptEditor } from './reusablePromptEditor-handler';
import { debugLog } from '../utils/debugLogger';
import { expandTemplate, PLACEHOLDER_HELP } from './promptTemplate';
import { getLocalLlmManager, ensureLocalLlmManager } from './localLlm-handler';
import { getAiConversationManager } from './aiConversation-handler';
import { interruptTomAiChatHandler } from './tomAiChat-handler';
import { setMetadataValue } from './tomAiChat-utils';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { WsPaths } from '../utils/workspacePaths';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { validateStrictAiConfiguration } from '../utils/sendToChatConfig';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { TrailService } from '../services/trailService';
import { TwoTierMemoryService } from '../services/memory-service';
import { writeWindowState } from './windowStatusPanel-handler.js';
import { AnthropicHandler, AnthropicProfile, AnthropicConfiguration, ANTHROPIC_CHAT_SESSION_KEY } from './anthropic-handler';
import { QuestRefreshService } from '../services/quest-refresh-service';
import { resolveProfileTools } from '../tools/tool-executors';
import { ACTIVE_ANTHROPIC_PROFILE_KEY } from '../tools/scripting-tools-bridge';
import { tryBeginAnthropicSend, endAnthropicSend, setAnthropicSendCancel } from './sendToChatState';
import { SharedToolDefinition } from '../tools/shared-tool-registry';
import { chatProviders, ChatDraftState } from './chat/chatProviderRegistry';
import { saveChatDrafts, loadChatDrafts } from '../services/chatDraftService';
import { wireCompletionMessages } from '../utils/completionWiring';

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
    getCopilotPromptsPath,
    getCopilotAnswersPath,
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
    getTrailFileTimestamp,
    getReadableTimestamp,
    getMaxTrailEntries,
    parseSequenceFromFile,
    trimTrailFile,
} from '../services/copilotTrailService';

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

interface Section {
    id: string;
    label: string;
    icon: string;
    content: string;
}

class ChatPanelViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _answerFileWatcher?: fs.FSWatcher;
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
    /**
     * Profile key of the most recent LocalLLM send. Recorded by
     * `_handleSendLocalLlm` so the Trail Summary Viewer button can
     * resolve the right per-profile trail folder. The LocalLLM trail
     * subsystem is sharded by profile (`_ai/trail/localllm/<quest>-<profile>/`),
     * so "open the summary trail" needs to know which profile.
     * `undefined` when the user has not sent anything in this window.
     */
    private _lastLocalLlmProfileKey: string | undefined = undefined;
    /**
     * One-shot guard for the LocalLLM status-update subscription. We
     * subscribe lazily on first send rather than in the panel
     * constructor because `_registerChatProviders` runs **before**
     * `extension.ts` finishes initialising the LocalLlmManager
     * singleton. Calling `ensureLocalLlmManager` from the constructor
     * auto-creates a transient instance, which extension.ts then
     * stomps via `setLocalLlmManager(...)`, leaving the transient
     * instance's output channels orphaned in the Output dropdown
     * (the user's "two of each channel" complaint).
     */
    private _localLlmStatusSubscribed: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._autoHideDelay = context.workspaceState.get('tomAi.copilot.autoHideDelay', 0);
        this._keepContentAfterSend = context.workspaceState.get('copilotKeepContent', false);
        this._setupAnswerFileWatcher();
        this._registerChatProviders();
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

        // Local LLM — cancel + summary-trail opener (the summary-viewer
        // dispatcher in the `openTrailSummaryViewer` message branch
        // routes here when section='localLlm'; otherwise it falls
        // through to the Copilot default which would open the wrong
        // trail).
        chatProviders.register('localLlm', {
            cancelInFlight: () => {
                const cts = this._activeCts.get('localLlm');
                if (!cts) {
                    // Nothing in flight — surface this so the click
                    // doesn't look like a no-op. The status reverts
                    // when the user next sends.
                    this._view?.webview.postMessage({ type: 'localLlmStatus', text: 'Nothing to cancel' });
                    return;
                }
                // Immediate UI feedback. The actual cancellation
                // propagates through the cancellation token to
                // `openaiChat`/`ollamaChat`, which destroy the socket
                // and reject with "Cancelled". `_handleSendLocalLlm`'s
                // catch block then writes the final "Cancelled" status
                // (or "Error: …" if the cancellation happened too late
                // to interrupt a tool-execution step).
                this._view?.webview.postMessage({ type: 'localLlmStatus', text: 'Cancelling…' });
                cts.cancel();
            },
            openTrailSummary: () => this._openLocalLlmSummaryTrail(),
            deleteProfile: async (profileId) => {
                const config = loadSendToChatConfig();
                if (!config?.localLlm?.profiles?.[profileId]) { return false; }
                delete config.localLlm.profiles[profileId];
                return !!saveSendToChatConfig(config);
            },
        });
        // NB: subscription to `localLlmManager.onStatusUpdate` happens
        // lazily inside `_handleSendLocalLlm` (guarded by
        // `_localLlmStatusSubscribed`). Subscribing here would force
        // `ensureLocalLlmManager` to auto-create a transient instance
        // before extension.ts finished setting the singleton — that
        // transient instance's output channels would then be orphaned
        // in the Output dropdown (the "two of each channel" complaint).

        // Tom AI Chat — handler owns its own CTS internally; cancel
        // hook calls the module-level interrupt.
        chatProviders.register('tomAiChat', {
            cancelInFlight: () => {
                interruptTomAiChatHandler();
            },
        });

        // AI Conversation — halt through the conversation manager.
        chatProviders.register('conversation', {
            cancelInFlight: () => {
                getAiConversationManager()?.haltConversation('Halted via chat panel stop button');
            },
            deleteProfile: async (profileId) => {
                const config = loadSendToChatConfig();
                if (!config?.aiConversation?.profiles?.[profileId]) { return false; }
                delete config.aiConversation.profiles[profileId];
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
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'togglePin':
                        // Pin state is handled client-side via localStorage
                        break;
                    case 'sendLocalLlm':
                        await this._handleSendLocalLlm(message.text, message.profile, message.llmConfig);
                        break;
                    case 'sendConversation':
                        await this._handleSendConversation(message.text, message.profile, message.aiSetup);
                        break;
                    case 'sendCopilot':
                        await this._handleSendCopilot(message.text, message.template, message.slot);
                        break;
                    case 'sendTomAiChat':
                        await this._handleSendTomAiChat(message.text, message.template);
                        break;
                    case 'sendAnthropic':
                        await this._handleSendAnthropic(message.text, message.profile, message.model, message.config, message.userMessageTemplate);
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
                    case 'clearAnthropicHistory':
                        AnthropicHandler.instance.clearSession(ANTHROPIC_CHAT_SESSION_KEY);
                        break;
                    case 'openAnthropicMemory':
                        await vscode.commands.executeCommand('tomAi.panel.memory');
                        break;
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
                        this._sendReusablePrompts();
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
                    case 'openChatFile':
                        await this._handleOpenChatFile();
                        break;
                    case 'insertToChatFile':
                        await this._handleInsertToChatFile(message.text, message.template);
                        break;
                    case 'preview':
                        await this._handlePreview(message.section, message.text, message.profile || message.template);
                        break;
                    case 'showTrail':
                        await this._showTrail();
                        break;
                    // Copilot answer file handlers
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
                            },
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
                    case 'openTimedRequestsEditor':
                        await vscode.commands.executeCommand('tomAi.editor.timedRequests');
                        break;
                    // openTrailRawFiles = Raw Trail Files Viewer (the grouped-exchanges
                    // webview panel over _ai/trail/{subsystem}/{quest}/). Forwards the
                    // originating section as a subsystem hint so the dropdown lands
                    // on the right subsystem.
                    case 'openTrailRawFiles':
                        await vscode.commands.executeCommand(
                            'tomAi.editor.rawTrailViewer',
                            undefined,
                            message.section || undefined,
                        );
                        break;
                    case 'openConversationTrailViewer':
                        await this._openConversationTrailViewer();
                        break;
                    case 'openConversationMarkdown':
                        await this._openConversationMarkdown();
                        break;
                    case 'openConversationCompactTrail':
                        await this._openConversationCompactTrail();
                        break;
                    case 'openConversationTurnFilesEditor':
                        await this._openConversationTurnFilesEditor();
                        break;
                    // openTrailSummaryViewer = Trail Summary Viewer (the per-file
                    // TrailEditorProvider custom editor over the concatenated
                    // *.prompts.md / *.answers.md files in _ai/quests/).
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
                    case 'openSessionHistory':
                        // Open `_ai/quests/<quest>/history/history.md` (the
                        // rolling markdown version of the session history
                        // written by persistHistorySnapshot) in the MD
                        // Browser custom editor.
                        await this._openSessionHistoryMarkdown();
                        break;
                    case 'openLiveTrail':
                        // Open the continuously-updating live-trail
                        // markdown for the section that triggered the
                        // button. The MD Browser auto-reloads on every
                        // write (debounced 200 ms).
                        //
                        //   anthropic → `_ai/quests/<quest>/live-trail.md`
                        //   localLlm  → `_ai/quests/<quest>/live-trail-localLLM.md`
                        //
                        // Both files are appended to during the
                        // respective transport's turn.
                        await this._openLiveTrailMarkdown(String(message.section || ''));
                        break;
                    case 'openStatusPage':
                        await vscode.commands.executeCommand('tomAi.statusPage');
                        break;
                    case 'recreateHistoryFromTrail': {
                        // Force the chunked trail-rebuild path even when an
                        // in-memory snapshot already exists. The handler's
                        // status-update stream surfaces per-chunk progress
                        // on the Anthropic panel's status line.
                        const { AnthropicHandler } = await import('./anthropic-handler.js');
                        void AnthropicHandler.instance.recreateHistoryFromTrail();
                        vscode.window.showInformationMessage('Recreating history.json from the trail files in chunks…');
                        break;
                    }
                    case 'recreateMemoryFromTrail': {
                        // Walk the trail in chunks of `runEveryNRounds −
                        // rawTurnsKept` rounds and run memory extraction
                        // per chunk. The memory-extraction template
                        // dedupes against `${existingMemory}`, so a
                        // rebuild against the current memory file is
                        // idempotent.
                        const { AnthropicHandler } = await import('./anthropic-handler.js');
                        void AnthropicHandler.instance.recreateMemoryFromTrail();
                        vscode.window.showInformationMessage('Recreating quest memory from the trail files in chunks…');
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
                        } else if (section === 'localLlm') {
                            const profileId = String(message.profile || '');
                            const llmConfig = String(message.llmConfig || '');
                            await QuestRefreshService.instance.runRefresh('localLlm', async (refreshText) => {
                                await this._handleSendLocalLlm(refreshText, profileId, llmConfig, true);
                            });
                            vscode.window.showInformationMessage('Quest Refresh run (Local LLM).');
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

    private _getEffectiveLlmConfigurations(config: SendToChatConfig | null): Array<{ id: string; name: string; isDefault?: boolean }> {
        const explicit = Array.isArray(config?.localLlm?.configurations) ? config!.localLlm!.configurations : [];
        if (explicit.length > 0) {
            return explicit
                .filter((c: any) => c && typeof c.id === 'string' && c.id.trim().length > 0)
                .map((c: any) => ({ id: c.id, name: c.name || c.id, isDefault: c.isDefault === true }));
        }
        return [];
    }

    private _getEffectiveAiConversationSetups(config: SendToChatConfig | null): Array<{ id: string; name: string; isDefault?: boolean }> {
        const explicit = Array.isArray(config?.aiConversation?.setups) ? config!.aiConversation!.setups : [];
        if (explicit.length > 0) {
            return explicit
                .filter((s: any) => s && typeof s.id === 'string' && s.id.trim().length > 0)
                .map((s: any) => ({ id: s.id, name: s.name || s.id, isDefault: s.isDefault === true }));
        }
        return [];
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
    private static async probeClaudeCli(): Promise<boolean> {
        if (!ChatPanelViewProvider._claudeCliProbe) {
            const execFileAsync = promisify(execFile);
            ChatPanelViewProvider._claudeCliProbe = (async () => {
                try {
                    await execFileAsync('claude', ['--version'], { timeout: 1500 });
                    ChatPanelViewProvider.claudeCliOk = true;
                    return true;
                } catch {
                    ChatPanelViewProvider.claudeCliOk = false;
                    return false;
                }
            })();
        }
        return ChatPanelViewProvider._claudeCliProbe;
    }
    /** Re-run the `claude --version` probe on next access (e.g. after config save). */
    static resetClaudeCliProbe(): void {
        ChatPanelViewProvider.claudeCliOk = null;
        ChatPanelViewProvider._claudeCliProbe = undefined;
    }

    private _sendProfiles(): void {
        const config = loadSendToChatConfig();
        const anthropicProfileEntries: Array<{ id: string; name: string; isDefault: boolean; configurationId: string }> = Array.isArray(config?.anthropic?.profiles)
            ? (config!.anthropic!.profiles! as Array<{ id: string; name?: string; isDefault?: boolean; configurationId?: string }>)
                .filter((p) => p && typeof p.id === 'string' && p.id.length > 0)
                .map((p) => ({ id: p.id, name: (p.name || p.id), isDefault: p.isDefault === true, configurationId: p.configurationId || '' }))
            : [];
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
        const envVar = config?.anthropic?.apiKeyEnvVar || 'ANTHROPIC_API_KEY';
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
            localLlm: config?.localLlm?.profiles ? Object.keys(config.localLlm.profiles) : [],
            conversation: config?.aiConversation?.profiles ? Object.keys(config.aiConversation.profiles) : [],
            // Filter out __answer_file__ since it's hardcoded in the dropdown as "Answer Wrapper"
            copilot: config?.copilot?.templates ? Object.keys(config.copilot.templates).filter(k => k !== '__answer_file__') : [],
            tomAiChat: config?.tomAiChat?.templates ? Object.keys(config.tomAiChat.templates) : [],
            anthropic: anthropicProfiles,
            configurations: this._getEffectiveLlmConfigurations(config),
            setups: this._getEffectiveAiConversationSetups(config),
            anthropicConfigurations,
            anthropicProfileEntries,
            anthropicUserMessageTemplates,
            anthropicApiKeyOk,
            claudeCliOk,
            claudeCliVisible: anyAgentSdkConfig,
            defaultCopilotTemplate: config?.copilot?.defaultTemplate || '',
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

    private _getProjectPromptsDir(): string | null {
        const activeFile = vscode.window.activeTextEditor?.document?.uri.fsPath;
        if (!activeFile) {
            return null;
        }
        const project = findNearestDetectedProject(path.dirname(activeFile));
        if (!project) {
            return null;
        }
        return path.join(project.absolutePath, 'prompt');
    }

    private _getProjectPromptScopes(): { id: string; label: string; dir: string }[] {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) {
            return [];
        }
        const projects = scanWorkspaceProjectsByDetectors({ traverseWholeWorkspace: true });
        const detectedScopes = projects
            .map((project) => {
                return {
                    id: encodeURIComponent(project.absolutePath),
                    label: project.name,
                    dir: path.join(project.absolutePath, 'prompt'),
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));

        if (detectedScopes.length > 0) {
            return detectedScopes;
        }

        const fallbackScopes: { id: string; label: string; dir: string }[] = [];
        const seen = new Set<string>();
        const maxDepth = 6;

        const shouldSkip = (name: string): boolean => {
            return name.startsWith('.') || name === 'node_modules' || name === 'build' || name === 'dist' || name === 'out' || name === '.dart_tool';
        };

        const walk = (dir: string, depth: number): void => {
            if (depth > maxDepth) {
                return;
            }
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            const hasPromptFolder = entries.some((entry) => entry.isDirectory() && entry.name === 'prompt');
            if (hasPromptFolder) {
                const relative = path.relative(wsRoot, dir) || '.';
                if (
                    relative !== '.' &&
                    !relative.startsWith('_ai') &&
                    !relative.includes(`${path.sep}_ai${path.sep}`) &&
                    !relative.includes(`${path.sep}prompt${path.sep}`)
                ) {
                    const key = path.resolve(dir);
                    if (!seen.has(key)) {
                        seen.add(key);
                        fallbackScopes.push({
                            id: encodeURIComponent(dir),
                            label: this._truncatePathFromStart(relative),
                            dir: path.join(dir, 'prompt'),
                        });
                    }
                }
            }

            for (const entry of entries) {
                if (!entry.isDirectory() || shouldSkip(entry.name)) {
                    continue;
                }
                walk(path.join(dir, entry.name), depth + 1);
            }
        };

        walk(wsRoot, 0);
        return fallbackScopes.sort((a, b) => a.label.localeCompare(b.label));
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

    private _getScanPromptScopes(): { id: string; label: string; dir: string }[] {
        const wsRoot = getWorkspaceRoot();
        return this._collectAllPromptDirs().map((promptDir) => {
            const relative = wsRoot ? path.relative(wsRoot, promptDir) : promptDir;
            return {
                id: encodeURIComponent(promptDir),
                label: this._truncatePathFromStart(relative),
                dir: promptDir,
            };
        });
    }

    private _truncatePathFromStart(fullPath: string, maxLength: number = 60): string {
        if (fullPath.length <= maxLength) {
            return fullPath;
        }
        const tail = fullPath.slice(fullPath.length - maxLength);
        const sepIndex = tail.indexOf(path.sep);
        if (sepIndex > -1 && sepIndex < tail.length - 1) {
            return `...${tail.slice(sepIndex)}`;
        }
        return `...${tail}`;
    }

    /**
     * Walk the entire workspace tree (up to depth 6) and collect every
     * `prompt/` directory that contains at least one `.prompt.md` file.
     * Unlike the former ancestor-walk approach this does not depend on
     * the active text editor, so it works from webview panels and
     * custom editors too.
     */
    private _collectAllPromptDirs(): string[] {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) {
            return [];
        }
        const maxDepth = 6;
        const shouldSkip = (name: string): boolean =>
            name.startsWith('.') || name === 'node_modules' || name === 'build'
            || name === 'dist' || name === 'out' || name === '.dart_tool';

        const unique = new Set<string>();
        const result: string[] = [];

        const walk = (dir: string, depth: number): void => {
            if (depth > maxDepth) { return; }
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

            for (const entry of entries) {
                if (!entry.isDirectory() || shouldSkip(entry.name)) { continue; }
                const childDir = path.join(dir, entry.name);
                if (entry.name === 'prompt') {
                    const key = path.resolve(childDir);
                    if (!unique.has(key)) {
                        unique.add(key);
                        result.push(childDir);
                    }
                    // Don't recurse into prompt/ itself
                } else {
                    walk(childDir, depth + 1);
                }
            }
        };
        walk(wsRoot, 0);
        return result.sort();
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

    private _sendReusablePrompts(): void {
        const globalDir = this._getGlobalPromptsDir();
        const projectScopes = this._getProjectPromptScopes();
        const questScopes = this._getQuestPromptScopes();
        const scanScopes = this._getScanPromptScopes();
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
        this._sendReusablePrompts();
    }

    private async _handleSendLocalLlm(text: string, profile: string, llmConfig?: string, skipQuestRefresh = false): Promise<void> {
        const manager = ensureLocalLlmManager(this._context);
        if (!manager) {
            vscode.window.showErrorMessage('Local LLM not available - extension not fully initialized. Please try again.');
            return;
        }
        // Lazy one-shot subscription to background-status events.
        // By now `extension.ts` has finished initialising the
        // singleton, so the manager we get here is the canonical one
        // and its output channels are the ones the user sees.
        if (!this._localLlmStatusSubscribed) {
            this._localLlmStatusSubscribed = true;
            this._context.subscriptions.push(
                manager.onStatusUpdate((text: string) => {
                    this._view?.webview.postMessage({ type: 'localLlmStatus', text });
                }),
            );
        }

        const config = loadSendToChatConfig();
        const strictErrors = validateStrictAiConfiguration(config);
        if (strictErrors.length > 0) {
            const msg = `Invalid AI configuration:\n- ${strictErrors.join('\n- ')}`;
            debugLog(`[ChatPanel] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage('Invalid AI configuration. Open Status Page for details.');
            return;
        }
        
        const defaultWrapped = applyDefaultTemplate(text, 'localLlm');
        const expanded = await expandTemplate(defaultWrapped);
        const profileKey = profile === '__none__' ? null : profile;
        // Remember the profile this send used so the per-panel Trail
        // Summary Viewer button can resolve the matching folder
        // (`_ai/trail/localllm/<quest>-<profile>/`). Falls back to a
        // sentinel so we can still try a sensible default when the
        // user never picked a profile.
        this._lastLocalLlmProfileKey = profileKey ?? 'default';
        let llmConfigKey = llmConfig && llmConfig !== '__default__' ? llmConfig : null;
        const profileLabel = profile === '__none__' ? 'None' : profile;
        debugLog(`[ChatPanel] _handleSendLocalLlm: llmConfig from webview='${llmConfig}' → llmConfigKey='${llmConfigKey}'`, 'INFO', 'extension');
        // Fall back to default configuration if none explicitly selected
        if (!llmConfigKey) {
            const configs = Array.isArray(config?.localLlm?.configurations) ? config!.localLlm!.configurations : [];
            const defaultCfg = configs.find((c: any) => c?.isDefault === true) || (configs.length > 0 ? configs[0] : null);
            llmConfigKey = defaultCfg?.id || null;
        }
        if (!llmConfigKey) {
            const msg = 'Missing required Local LLM configuration selection. Add at least one configuration in the Status Page.';
            debugLog(`[ChatPanel] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(msg);
            return;
        }
        
        // Resolve model name for status messages (pass llmConfigKey so it resolves the right model)
        const modelName = manager.getResolvedModelName(llmConfigKey ?? undefined);
        
        // Register a CTS so the panel's stop button can cancel the turn, not
        // only the progress notification's X.
        this._activeCts.get('localLlm')?.dispose();
        const externalCts = new vscode.CancellationTokenSource();
        this._activeCts.set('localLlm', externalCts);

        // Helper for the live panel status line. Cheap and centralised
        // so every phase update reads the same way.
        const setStatus = (text: string): void => {
            this._view?.webview.postMessage({ type: 'localLlmStatus', text });
        };

        const sendStart = Date.now();
        let roundsSeen = 0;
        let toolCallsSeen = 0;
        try {
            setStatus(`Checking ${modelName}…`);
            // Check if model needs loading (use the resolved model
            // name + the same config key so checkModelLoaded probes the
            // correct endpoint for the configuration's apiStyle —
            // /v1/models for vLLM, /api/ps for Ollama. Without the key
            // the probe always fell back to /api/ps and 404'd on
            // OpenAI-compat servers.)
            const modelLoaded = await manager.checkModelLoaded(modelName, llmConfigKey ?? undefined);
            setStatus(modelLoaded ? `Sending to ${modelName}…` : `Loading ${modelName}…`);

            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: modelLoaded ? `Sending to local ${modelName}...` : `Loading ${modelName}...`,
                    cancellable: true,
                },
                async (progress, token) => {
                    // Forward progress-notification cancellation into our external CTS so
                    // the handler only observes one token (externalCts.token).
                    token.onCancellationRequested(() => externalCts.cancel());
                    if (!modelLoaded) {
                        // Model is loading as part of generate — update status once process starts
                        // The loading happens at the start of the Ollama call
                        const checkInterval = setInterval(async () => {
                            const loaded = await manager.checkModelLoaded(modelName, llmConfigKey ?? undefined);
                            if (loaded) {
                                progress.report({ message: `Processing prompt with ${modelName}...` });
                                setStatus(`Processing with ${modelName}…`);
                                clearInterval(checkInterval);
                            }
                        }, 2000);
                        externalCts.token.onCancellationRequested(() => clearInterval(checkInterval));
                    } else {
                        // Model already loaded, go straight to processing
                        progress.report({ message: `Processing prompt with ${modelName}...` });
                        setStatus(`Processing with ${modelName}…`);
                    }
                    // Per-tool-call callback drives the live status line
                    // so the panel reflects each round the model triggers.
                    // `manager.process()` calls this AFTER the tool
                    // returns, so the format is "Round R - <tool>: ok"
                    // (the model is about to start round R+1).
                    const onToolCall = (toolName: string, _args: Record<string, unknown>, _result: string): void => {
                        toolCallsSeen += 1;
                        roundsSeen += 1;
                        setStatus(`Round ${roundsSeen} — tool ${toolName} done (calls so far: ${toolCallsSeen})`);
                    };
                    return manager.process(expanded, profileKey, llmConfigKey, undefined, externalCts.token, onToolCall, skipQuestRefresh);
                }
            );

            if (result.success) {
                const durSec = ((Date.now() - sendStart) / 1000).toFixed(1);
                const turns = (result as { turnsUsed?: number }).turnsUsed ?? roundsSeen;
                const toolCount = (result as { toolCallCount?: number }).toolCallCount ?? toolCallsSeen;
                setStatus(`Done — ${turns} round${turns === 1 ? '' : 's'}, ${toolCount} tool call${toolCount === 1 ? '' : 's'} (${durSec}s)`);
                await this._appendToTrail(expanded, result.result, profileLabel, llmConfigKey);
                await this._showTrail(llmConfigKey);
            } else {
                const errorMsg = result.error || 'Unknown error';
                setStatus(`Error: ${errorMsg}`);
                debugLog(`[ChatPanel] Local LLM error (config=${llmConfigKey}, model=${modelName}): ${errorMsg}`, 'ERROR', 'extension');
                vscode.window.showErrorMessage(`Local LLM error: ${errorMsg}`);
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // Treat user-initiated cancellation distinctly so the
            // status line doesn't read like a crash.
            if (externalCts.token.isCancellationRequested) {
                setStatus('Cancelled');
            } else {
                setStatus(`Error: ${message}`);
            }
            debugLog(`[ChatPanel] Local LLM failed (config=${llmConfigKey}, model=${modelName}): ${e}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(`Local LLM failed: ${message}`);
        } finally {
            if (this._activeCts.get('localLlm') === externalCts) {
                this._activeCts.delete('localLlm');
            }
            externalCts.dispose();
        }
    }

    private async _handleSendConversation(text: string, profile: string, aiSetupId?: string): Promise<void> {
        const defaultWrapped = applyDefaultTemplate(text, 'conversation');
        const expanded = await expandTemplate(defaultWrapped);
        const profileKey = profile === '__none__' ? null : profile;
        const config = loadSendToChatConfig();
        const strictErrors = validateStrictAiConfiguration(config);
        if (strictErrors.length > 0) {
            const msg = `Invalid AI configuration:\n- ${strictErrors.join('\n- ')}`;
            debugLog(`[ChatPanel] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage('Invalid AI configuration. Open Status Page for details.');
            return;
        }

        const setups = Array.isArray(config?.aiConversation?.setups) ? config!.aiConversation!.setups : [];
        // Fall back to default setup if none explicitly selected
        let effectiveSetupId = aiSetupId;
        if (!effectiveSetupId) {
            const defaultSetup = setups.find((s: any) => s?.isDefault === true) || (setups.length > 0 ? setups[0] : null);
            effectiveSetupId = defaultSetup?.id;
        }
        const selectedSetup = setups.find((s: any) => s?.id === effectiveSetupId);
        if (!selectedSetup) {
            const msg = `Missing required AI conversation setup: ${effectiveSetupId || '(none selected)'}. Add at least one setup in the Status Page.`;
            debugLog(`[ChatPanel] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(msg);
            return;
        }
        const llmConfigA = selectedSetup?.llmConfigA || null;
        const llmConfigB = selectedSetup?.llmConfigB || null;
        const summarizationModelConfig = selectedSetup?.trailSummarizationLlmConfig || null;
        const pauseBetweenTurns = selectedSetup?.pauseBetweenTurns === true;
        const maxTurns = typeof selectedSetup?.maxTurns === 'number' ? selectedSetup.maxTurns : null;
        const historyMode = typeof selectedSetup?.historyMode === 'string' ? selectedSetup.historyMode : null;

        if (!llmConfigA || !summarizationModelConfig || !maxTurns || !historyMode) {
            const msg = `AI setup "${selectedSetup?.id || '(unknown)'}" is incomplete: requires llmConfigA, trailSummarizationLlmConfig, maxTurns, and historyMode.`;
            debugLog(`[ChatPanel] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(msg);
            return;
        }

        const isCopilotMode = !llmConfigB || llmConfigB === 'copilot';
        
        try {
            const params: Record<string, any> = {
                goal: expanded,
                profileKey,
                pauseBetweenTurns,
                maxTurns,
                historyMode,
            };

            if (isCopilotMode) {
                if (llmConfigA) {
                    params.modelConfig = llmConfigA;
                }
                if (summarizationModelConfig) {
                    params.trailSummarizationLlmConfig = summarizationModelConfig;
                }
            } else {
                params.selfTalkOverrides = {
                    personA: llmConfigA ? { modelConfig: llmConfigA } : undefined,
                    personB: llmConfigB ? { modelConfig: llmConfigB } : undefined,
                };
            }

            await vscode.commands.executeCommand('tomAi.aiConversation.start', params);
        } catch {
            vscode.window.showInformationMessage(`Start conversation (profile: ${profileKey || 'None'}): ${expanded.substring(0, 50)}...`);
        }
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

    private async _handleSendCopilot(text: string, template: string, slot?: number): Promise<void> {
        const config = loadSendToChatConfig();
        const isAnswerFileTemplate = template === '__answer_file__';
        const panelSlot = Number.isInteger(slot) && (slot as number) >= 1 && (slot as number) <= 9 ? (slot as number) : 1;
        this._lastSentCopilotSlot = panelSlot;
        
        // Always log the prompt (before expansion)
        logCopilotPrompt(text, template);

        // Apply panel default template first (wraps all requests from this panel)
        const defaultWrapped = applyDefaultTemplate(text, 'copilot');
        
        // Get answer file template
        const answerFileTpl = config?.copilot?.templates?.['__answer_file__'];
        const answerFileTemplate = answerFileTpl?.template || DEFAULT_ANSWER_FILE_TEMPLATE;
        
        let expanded: string;
        if (isAnswerFileTemplate || !template || template === '__none__') {
            // Answer Wrapper or no template
            if (isAnswerFileTemplate) {
                // Delete existing answer file before sending
                deleteAnswerFile();
                this._notifyAnswerFileStatus();
                // Expand answer file template with originalPrompt
                expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: defaultWrapped } });
            } else {
                // No template: just expand placeholders in the text
                expanded = await expandTemplate(defaultWrapped);
            }
        } else {
            // Other template: first expand the template, then wrap with answer file
            const templateObj = config?.copilot?.templates?.[template];
            if (templateObj?.template) {
                // Step 1: Expand selected template with user text as originalPrompt
                const templateExpanded = await expandTemplate(templateObj.template, { values: { originalPrompt: defaultWrapped } });
                // Step 2: Wrap the result with answer file template
                expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: templateExpanded } });
            } else {
                expanded = await expandTemplate(defaultWrapped);
            }
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

    private async _handleSendTomAiChat(text: string, template: string): Promise<void> {
        const config = loadSendToChatConfig();
        const templateObj = template && template !== '__none__' ? config?.tomAiChat?.templates?.[template] : null;
        let content = applyDefaultTemplate(text, 'tomAiChat');
        if (templateObj?.contextInstructions) {
            content = templateObj.contextInstructions + '\n\n' + content;
        }
        const expanded = await expandTemplate(content);
        const requestId = this._extractRequestIdFromExpandedPrompt(expanded);
        writePromptTrail(text, template || '__none__', false, expanded, requestId);
        const templateId = templateObj ? (template || '') : '';
        await this._insertExpandedToChatFile(expanded, templateId);
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
        AnthropicHandler.instance.onApprovalNeeded((req) => {
            this._view?.webview.postMessage({
                type: 'anthropicToolApproval',
                toolId: req.toolUseId,
                toolName: req.toolName,
                inputSummary: req.inputSummary,
            });
        });
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

    private async _handleSendAnthropic(text: string, profileId: string, modelId: string, configId: string, userMessageTemplateId?: string, skipQuestRefresh = false): Promise<void> {
        if (!text || !text.trim()) { return; }
        // Spec: only one interactive Anthropic turn at a time. The webview
        // already disables Send during a panel turn, but the shared guard also
        // blocks a concurrent Send-to-Chat / scripting turn — and vice versa.
        if (!tryBeginAnthropicSend()) {
            this._view?.webview.postMessage({
                type: 'anthropicError',
                message: 'An Anthropic chat request is already running.',
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
            const result = await AnthropicHandler.instance.sendMessage({
                userText: text,
                profile,
                configuration: cfg,
                tools,
                cancellationToken: cts.token,
                // Chat panel keeps its Agent SDK continuity in its own
                // `chat.session.json`, separate from the prompt queue's
                // `default.session.json`, so the two never resume each
                // other's session.
                sessionKey: ANTHROPIC_CHAT_SESSION_KEY,
                skipQuestRefresh,
                ...(userMessageTemplate ? { userMessageTemplate } : {}),
            });
            this._updateAnthropicWindowStatus('answer-received');
            this._view?.webview.postMessage({
                type: 'anthropicResult',
                text: result.text,
                turnsUsed: result.turnsUsed,
                toolCallCount: result.toolCallCount,
                historyMode: cfg.historyMode || '',
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
        const result = await AnthropicHandler.instance.fetchModels();
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

    private async _openAnthropicSummaryTrail(): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId();
        const summaryPath = TrailService.instance.getSummaryFilePath('prompts', { type: 'anthropic' }, questId);
        if (!summaryPath || !fs.existsSync(summaryPath)) {
            vscode.window.showInformationMessage('No Anthropic summary trail exists yet. Send a prompt first.');
            return;
        }
        const uri = vscode.Uri.file(summaryPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
    }

    /**
     * Open the Trail Summary Viewer for the most-recently-used Local
     * LLM profile. Mirrors `_openAnthropicSummaryTrail`, but the
     * LocalLLM subsystem is sharded by profile name — there's one
     * summary trail per profile — so we use `_lastLocalLlmProfileKey`
     * (recorded by `_handleSendLocalLlm`) to pick the right one. When
     * the user hasn't sent anything yet this session, we surface that
     * fact in the info message rather than silently opening nothing.
     */
    private async _openLocalLlmSummaryTrail(): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId();
        const profileKey = this._lastLocalLlmProfileKey;
        if (!profileKey) {
            vscode.window.showInformationMessage(
                'No Local LLM summary trail yet — send a prompt first. The trail is sharded by profile; the viewer opens the trail for the profile you last sent with.',
            );
            return;
        }
        // Subsystem `configName` is the profile name run through the
        // same sanitizer the trail logger uses (see
        // `mapTypeToSubsystem` in trailLogging). Keep the two in sync
        // or the lookup misses.
        const configName = profileKey.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-');
        const subsystem = { type: 'localLlm' as const, configName };
        const summaryPath = TrailService.instance.getSummaryFilePath('prompts', subsystem, questId);
        if (!summaryPath || !fs.existsSync(summaryPath)) {
            vscode.window.showInformationMessage(
                `No Local LLM summary trail yet for profile "${profileKey}". Send a prompt with this profile first, or use the Raw Trail Files Viewer to browse other profiles.`,
            );
            return;
        }
        const uri = vscode.Uri.file(summaryPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
    }

    /**
     * Open the rolling session history (the markdown version written next
     * to history.json on every turn by TwoTierMemoryService.persistHistorySnapshot)
     * in the MD Browser custom editor. When the file is missing we
     * fall through to a warning instead of opening something blank.
     */
    private async _openSessionHistoryMarkdown(): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        const folder = TwoTierMemoryService.instance.historyFolder(questId || undefined);
        const target = path.join(folder, 'history.md');
        if (!fs.existsSync(target)) {
            vscode.window.showInformationMessage(
                `No session history yet for quest "${questId || 'default'}". The history file is written after the first completed turn (${target}).`,
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
     * Open the section's live-trail markdown in the MD Browser. The
     * MD Browser's file watcher (debounced 200 ms) re-renders the
     * webview as the handler appends new events, so the user watches
     * each thinking / tool_use / assistant chunk arrive.
     *
     *   section='anthropic' → `live-trail.md`         (default)
     *   section='localLlm'  → `live-trail-localLLM.md`
     *
     * The file is created on the first send of the session — we
     * tolerate it not existing yet with an info message that names
     * the relevant transport.
     */
    private async _openLiveTrailMarkdown(section: string = 'anthropic'): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        // Resolve the quest folder the same way LiveTrailWriter does.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
        const safeQuest = (questId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
        const fileName = section === 'localLlm' ? 'live-trail-localLLM.md' : 'live-trail.md';
        const transportLabel = section === 'localLlm' ? 'Local LLM' : 'Anthropic';
        const target = path.join(questsRoot, safeQuest, fileName);
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

    private async _insertExpandedToChatFile(expanded: string, templateId: string = ''): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.chat.md')) {
            vscode.window.showWarningMessage('Please open a .chat.md file first');
            return;
        }

        const doc = editor.document;
        const text = doc.getText();
        const chatHeaderMatch = text.match(/_{3,}\s*CHAT\s+\w+\s*_{3,}/);

        if (chatHeaderMatch) {
            // Persist the template id in the metadata block so
            // sendToTomAiChatHandler can apply its tool settings. We do this
            // by rewriting the whole file content (metadata block is small
            // and the header is always preserved).
            const withTemplate = setMetadataValue(text, 'template', templateId);
            const headerMatchAfter = withTemplate.match(/_{3,}\s*CHAT\s+\w+\s*_{3,}/);
            const headerIndex = withTemplate.indexOf(headerMatchAfter ? headerMatchAfter[0] : chatHeaderMatch[0]);
            const headerEnd = headerIndex + (headerMatchAfter ? headerMatchAfter[0].length : chatHeaderMatch[0].length);
            const insertedOffset = headerEnd;
            const newContent = withTemplate.slice(0, insertedOffset) + '\n\n' + expanded + withTemplate.slice(insertedOffset);
            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
            await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, newContent);
            });
        } else {
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, expanded);
            });
        }
    }

    private _getLocalTrailFolderPath(llmConfigKey?: string | null): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }

        if (llmConfigKey) {
            const config = loadSendToChatConfig();
            const llmConfigs = Array.isArray(config?.localLlm?.configurations) ? config!.localLlm!.configurations : [];
            const selected = llmConfigs.find((c: any) => c?.id === llmConfigKey);
            if (selected?.logFolder && typeof selected.logFolder === 'string' && selected.logFolder.trim().length > 0) {
                return path.join(workspaceFolder.uri.fsPath, selected.logFolder);
            }
        }

        return WsPaths.ai('trail', 'local_llm') || path.join(workspaceFolder.uri.fsPath, '_ai', 'trail', 'local_llm');
    }

    private _getLocalTrailPaths(llmConfigKey?: string | null): { prompts: string; answers: string; compact: string } | null {
        const folder = this._getLocalTrailFolderPath(llmConfigKey);
        if (!folder) {
            return null;
        }
        const workspaceName = getWorkspaceName();
        return {
            prompts: path.join(folder, `${workspaceName}.prompts.md`),
            answers: path.join(folder, `${workspaceName}.answers.md`),
            compact: path.join(folder, `${workspaceName}.trail.md`),
        };
    }

    private _getLocalTrailFileTimestamp(): string {
        const now = new Date();
        const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
        return `${date}_${time}`;
    }

    private async _appendToTrail(prompt: string, response: string, profile: string, llmConfigKey?: string | null): Promise<void> {
        const trailService = TrailService.instance;
        const questId = WsPaths.getWorkspaceQuestId();
        const subsystem = {
            type: 'localLlm' as const,
            configName: (llmConfigKey || profile || 'default').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-')
        };

        await trailService.writeSummaryPrompt(subsystem, prompt, questId);
        await trailService.writeSummaryAnswer(subsystem, response, { profile, llmConfigKey: llmConfigKey ?? undefined }, questId);
        await trailService.writeRawPrompt(subsystem, prompt, getWindowId(), undefined, questId);
        await trailService.writeRawAnswer(subsystem, response, getWindowId(), undefined, questId);
    }

    private async _showTrail(llmConfigKey?: string | null): Promise<void> {
        // Try to open the summary prompts file from the quest folder
        const questId = WsPaths.getWorkspaceQuestId();
        const configName = (llmConfigKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-');
        const subsystem = { type: 'localLlm' as const, configName };
        const trailService = TrailService.instance;
        const summaryPath = trailService.getSummaryFilePath('prompts', subsystem, questId);

        if (summaryPath && fs.existsSync(summaryPath)) {
            const uri = vscode.Uri.file(summaryPath);
            await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
            return;
        }

        // Fallback: open the old compact trail file
        const paths = this._getLocalTrailPaths();
        if (!paths) {
            vscode.window.showWarningMessage('No workspace folder');
            return;
        }

        if (!fs.existsSync(paths.compact)) {
            const dir = path.dirname(paths.compact);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(paths.compact, '# Local LLM Trail\n\nCompact conversation history with local LLM.\n', 'utf-8');
        }

        const doc = await vscode.workspace.openTextDocument(paths.compact);
        await vscode.window.showTextDocument(doc, { preview: false });
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

    private _getAiConversationLogDir(): string | null {
        const wsRoot = getWorkspaceRoot();
        if (!wsRoot) {
            return null;
        }

        const configured = (loadSendToChatConfig()?.aiConversation as any)?.conversationLogPath as string | undefined;
        const fallback = `${WsPaths.aiRelative('trail')}/ai_conversation`;
        const rawPath = (typeof configured === 'string' && configured.trim().length > 0) ? configured.trim() : fallback;
        const resolved = resolvePathVariables(rawPath, { silent: true }) ?? rawPath;
        return path.isAbsolute(resolved) ? resolved : path.join(wsRoot, resolved);
    }

    private _getLatestAiConversationMarkdown(logDir: string): string | null {
        if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) {
            return null;
        }

        const files = fs.readdirSync(logDir)
            .filter((file) => file.startsWith('bot_') && file.endsWith('.md'))
            .map((file) => {
                const fullPath = path.join(logDir, file);
                const mtime = fs.statSync(fullPath).mtimeMs;
                return { fullPath, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);

        return files.length > 0 ? files[0].fullPath : null;
    }

    private async _openConversationTrailViewer(): Promise<void> {
        const logDir = this._getAiConversationLogDir();
        if (!logDir) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }
        if (!fs.existsSync(logDir)) {
            vscode.window.showInformationMessage('No AI conversation trail folder exists yet. Start a conversation first.');
            return;
        }
        await vscode.commands.executeCommand('tomAi.editor.rawTrailViewer', vscode.Uri.file(logDir));
    }

    private async _openConversationMarkdown(): Promise<void> {
        const logDir = this._getAiConversationLogDir();
        if (!logDir) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }

        const latestLog = this._getLatestAiConversationMarkdown(logDir);
        if (!latestLog) {
            const isActive = getAiConversationManager()?.isActive === true;
            vscode.window.showInformationMessage(
                isActive
                    ? 'AI conversation is active, but no conversation markdown exists yet. It is written when the conversation ends.'
                    : 'No AI conversation markdown file found yet.',
            );
            return;
        }

        const doc = await vscode.workspace.openTextDocument(latestLog);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _openConversationCompactTrail(): Promise<void> {
        const logDir = this._getAiConversationLogDir();
        if (!logDir) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }

        const compactPath = path.join(logDir, `${getWorkspaceName()}.trail.md`);
        if (!fs.existsSync(compactPath)) {
            vscode.window.showInformationMessage('No compact AI conversation trail exists yet. Start and complete a conversation first.');
            return;
        }

        const doc = await vscode.workspace.openTextDocument(compactPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _openConversationTurnFilesEditor(): Promise<void> {
        const logDir = this._getAiConversationLogDir();
        if (!logDir) {
            vscode.window.showWarningMessage('No workspace folder found');
            return;
        }
        if (!fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) {
            vscode.window.showInformationMessage('No AI conversation turn files exist yet.');
            return;
        }

        const turnFiles = fs.readdirSync(logDir)
            .filter((file) => /_(prompt|answer)_/.test(file) && (file.endsWith('.userprompt.md') || file.endsWith('.answer.json')))
            .sort((a, b) => b.localeCompare(a));

        if (turnFiles.length === 0) {
            vscode.window.showInformationMessage('No AI conversation turn files found yet.');
            return;
        }

        const picked = await vscode.window.showQuickPick(
            turnFiles.map((file) => ({
                label: file,
                description: file.includes('_prompt_') ? 'Turn prompt file' : 'Turn answer file',
                filePath: path.join(logDir, file),
            })),
            { placeHolder: 'Select AI conversation per-turn file to open' },
        );

        if (!picked) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(picked.filePath);
        await vscode.window.showTextDocument(doc, { preview: false });
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
        this._sendReusablePrompts();
    }

    private async _handleAddToQueue(
        text: string,
        template: string,
        repeatCount?: number,
        answerWaitMinutes?: number,
        transportOpts?: {
            transport?: 'copilot' | 'anthropic';
            anthropicProfileId?: string;
            anthropicConfigId?: string;
        },
    ): Promise<void> {
        try {
            const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
            const queue = PromptQueueManager.instance;
            if (queue) {
                const transport = transportOpts?.transport ?? 'copilot';
                // Apply panel default template wrapping for Copilot; the
                // Anthropic path uses its own profile + user-message
                // template, so no wrapping here.
                const wrappedText = transport === 'copilot'
                    ? applyDefaultTemplate(text, 'copilot')
                    : text;
                await queue.enqueue({
                    originalText: wrappedText,
                    template: template || undefined,
                    repeatCount: Math.max(0, Math.round(Number(repeatCount || 0))),
                    templateRepeatCount: undefined,
                    // answerWait / reminder fields don't apply to anthropic
                    // items (spec §4.7). Leave them undefined.
                    answerWaitMinutes: transport === 'copilot' && answerWaitMinutes && answerWaitMinutes > 0
                        ? answerWaitMinutes
                        : undefined,
                    deferSend: true,
                    transport: transport === 'anthropic' ? 'anthropic' : undefined,
                    anthropicProfileId: transportOpts?.anthropicProfileId,
                    anthropicConfigId: transportOpts?.anthropicConfigId,
                });
                const count = queue.items.length;
                vscode.window.showInformationMessage(`Added to prompt queue (${count} items, ${transport})`);
                this._view?.webview.postMessage({ type: 'queueAdded', count });
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

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async _handlePreview(section: string, text: string, profileOrTemplate: string): Promise<void> {
        const config = loadSendToChatConfig();
        let title = section;
        let previewContent = text;
        let onSend: ((t: string) => Promise<void>) | undefined;
        
        switch (section) {
            case 'localLlm': {
                title = 'Local LLM';
                const profile = profileOrTemplate && profileOrTemplate !== '__none__' ? config?.localLlm?.profiles?.[profileOrTemplate] : null;
                if (profile?.systemPrompt) {
                    previewContent = `=== SYSTEM PROMPT ===\n${profile.systemPrompt}\n\n=== USER PROMPT ===\n${text}`;
                }
                onSend = async (t) => await this._handleSendLocalLlm(t, profileOrTemplate);
                break;
            }
            case 'conversation': {
                title = 'AI Conversation';
                const profile = profileOrTemplate && profileOrTemplate !== '__none__' ? config?.aiConversation?.profiles?.[profileOrTemplate] : null;
                if (profile?.initialPromptTemplate) {
                    // Use expandTemplate with goal as a value
                    previewContent = await expandTemplate(profile.initialPromptTemplate, { values: { goal: text } });
                }
                onSend = async (t) => await this._handleSendConversation(t, profileOrTemplate);
                break;
            }
            case 'copilot': {
                title = 'Copilot';
                // Get answer file template
                const answerFileTpl = config?.copilot?.templates?.['__answer_file__'];
                const answerFileTemplate = answerFileTpl?.template || DEFAULT_ANSWER_FILE_TEMPLATE;
                
                if (profileOrTemplate === '__answer_file__' || !profileOrTemplate || profileOrTemplate === '__none__') {
                    // Answer Wrapper or no template: just expand answer file template
                    if (profileOrTemplate === '__answer_file__') {
                        previewContent = await expandTemplate(answerFileTemplate, { values: { originalPrompt: text } });
                    }
                    // else: no template, previewContent stays as text (will be expanded below)
                } else {
                    // Other template: first expand the template, then wrap with answer file
                    const template = config?.copilot?.templates?.[profileOrTemplate];
                    if (template?.template) {
                        // Step 1: Expand selected template with user text as originalPrompt
                        const templateExpanded = await expandTemplate(template.template, { values: { originalPrompt: text } });
                        // Step 2: Wrap the result with answer file template
                        previewContent = await expandTemplate(answerFileTemplate, { values: { originalPrompt: templateExpanded } });
                    }
                }
                onSend = async (t) => {
                    await vscode.commands.executeCommand('workbench.action.chat.open', { query: t });
                };
                break;
            }
            case 'tomAiChat': {
                title = 'Tom AI Chat';
                const template = profileOrTemplate && profileOrTemplate !== '__none__' ? config?.tomAiChat?.templates?.[profileOrTemplate] : null;
                if (template?.contextInstructions) {
                    previewContent = `${template.contextInstructions}\n\n${text}`;
                }
                onSend = async (t) => await this._handleSendTomAiChat(t, profileOrTemplate);
                break;
            }
        }
        
        // Final expansion for any remaining placeholders
        const expanded = await expandTemplate(previewContent);
        await showPreviewPanel(title, expanded, onSend);
    }

    // --- Profile CRUD (localLlm, conversation) ---

    private async _handleAddProfile(section: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            localLlm: 'localLlm',
            conversation: 'conversation',
            anthropic: 'anthropicProfiles',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category });
        }
    }

    private async _handleEditProfile(section: string, name?: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            localLlm: 'localLlm',
            conversation: 'conversation',
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

        // Each section knows how to delete its own profile — the
        // provider registry dispatches to the right shape (object
        // map for localLlm / conversation, array for anthropic).
        // Sections without a deleteProfile hook are a no-op here.
        const provider = chatProviders.get(section);
        if (!provider?.deleteProfile) { return; }
        const deleted = await provider.deleteProfile(name);
        if (deleted) {
            this._sendProfiles();
            vscode.window.showInformationMessage('Profile deleted');
        }
    }

    // --- Template CRUD (copilot, tomAiChat) ---

    private async _handleAddTemplate(section: string): Promise<void> {
        const categoryMap: Record<string, TemplateCategory> = {
            copilot: 'copilot',
            tomAiChat: 'tomAiChat',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category });
        }
    }

    private async _handleEditTemplate(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const categoryMap: Record<string, TemplateCategory> = {
            copilot: 'copilot',
            tomAiChat: 'tomAiChat',
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

        if (section === 'copilot' && config.copilot?.templates?.[name]) {
            delete config.copilot.templates[name];
        } else if (section === 'tomAiChat' && config.tomAiChat?.templates?.[name]) {
            delete config.tomAiChat.templates[name];
        } else { return; }

        if (saveSendToChatConfig(config)) {
            this._sendProfiles();
            vscode.window.showInformationMessage('Template deleted');
        }
    }

    // --- Tom AI Chat file operations ---

    private async _handleOpenChatFile(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const chatDir = WsPaths.ai('tomAiChat') || path.join(workspaceFolder.uri.fsPath, '_ai', 'tom_ai_chat');
        if (!fs.existsSync(chatDir)) {
            fs.mkdirSync(chatDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const chatFile = path.join(chatDir, `chat_${timestamp}.chat.md`);

        if (!fs.existsSync(chatFile)) {
            const content = `toolInvocationToken:
modelId: claude-sonnet-4-20250514
tokenModelId: gpt-4.1-mini
preProcessingModelId: 
enablePromptOptimization: false
responsesTokenLimit: 16000
responseSummaryTokenLimit: 4000
maxIterations: 100
maxContextChars: 50000
maxToolResultChars: 50000
maxDraftChars: 8000
contextFilePath:

_________ CHAT chat_${timestamp} ____________

`;
            fs.writeFileSync(chatFile, content, 'utf-8');
        }

        const doc = await vscode.workspace.openTextDocument(chatFile);
        await vscode.window.showTextDocument(doc);
    }

    private async _handleInsertToChatFile(text: string, template: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open a .chat.md file first.');
            return;
        }
        if (!editor.document.fileName.endsWith('.chat.md')) {
            vscode.window.showWarningMessage('Active file is not a .chat.md file.');
            return;
        }

        let expanded = text;
        // Prepend contextInstructions from template if available
        if (template) {
            const config = loadSendToChatConfig();
            const tpl = config?.tomAiChat?.templates?.[template];
            if (tpl?.contextInstructions) {
                expanded = tpl.contextInstructions + '\n\n' + expanded;
            }
        }

        // Look for the CHAT header to insert after
        const docText = editor.document.getText();
        const headerMatch = docText.match(/_{3,}\s*CHAT\s+\w+\s*_{3,}/);
        if (headerMatch && headerMatch.index !== undefined) {
            const headerEnd = headerMatch.index + headerMatch[0].length;
            const pos = editor.document.positionAt(headerEnd);
            await editor.edit(editBuilder => {
                editBuilder.insert(pos, '\n\n' + expanded);
            });
        } else {
            // Insert at cursor
            await editor.edit(editBuilder => {
                editBuilder.insert(editor.selection.active, expanded);
            });
        }
    }
}

let _provider: ChatPanelViewProvider | undefined;

export function registerChatPanel(context: vscode.ExtensionContext): void {
    _provider = new ChatPanelViewProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, _provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

/**
 * External hook used by the status page (and any other configuration UI)
 * to push fresh Anthropic state into the chat panel after a config edit.
 * Re-emits profiles/configurations + the env-var-derived 🔑 status, then
 * fires a fresh `models.list()` so the Model dropdown reflects the new
 * `apiKeyEnvVar` without requiring a reload-window.
 *
 * Also resets the cached Anthropic SDK client and the `claude --version`
 * probe so the next request reads the new env var name and the 🤖 dot
 * re-checks against the host install.
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
    meta: { turnsUsed: number; toolCallCount: number; historyMode: string },
): void {
    const view = (_provider as unknown as { _view?: vscode.WebviewView })?._view;
    if (!view) { return; }
    view.webview.postMessage({
        type: 'anthropicResult',
        text,
        turnsUsed: meta.turnsUsed,
        toolCallCount: meta.toolCallCount,
        historyMode: meta.historyMode,
    });
}

