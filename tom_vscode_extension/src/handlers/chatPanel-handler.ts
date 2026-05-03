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
import { getAccordionStyles } from './accordionPanel';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { WsPaths } from '../utils/workspacePaths';
import { ChatVariablesStore } from '../managers/chatVariablesStore';
import { validateStrictAiConfiguration } from '../utils/sendToChatConfig';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { TrailService } from '../services/trailService';
import { TwoTierMemoryService } from '../services/memory-service';
import { writeWindowState } from './windowStatusPanel-handler.js';
import { AnthropicHandler, AnthropicProfile, AnthropicConfiguration } from './anthropic-handler';
import { ALL_SHARED_TOOLS } from '../tools/tool-executors';
import { SharedToolDefinition } from '../tools/shared-tool-registry';
import { chatProviders, ChatDraftState } from './chat/chatProviderRegistry';
import { saveChatDrafts, loadChatDrafts } from '../services/chatDraftService';

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

        // Local LLM — just the cancel hook (own CTS like Anthropic).
        chatProviders.register('localLlm', {
            cancelInFlight: () => {
                this._activeCts.get('localLlm')?.cancel();
            },
            deleteProfile: async (profileId) => {
                const config = loadSendToChatConfig();
                if (!config?.localLlm?.profiles?.[profileId]) { return false; }
                delete config.localLlm.profiles[profileId];
                return !!saveSendToChatConfig(config);
            },
        });

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
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        const codiconsUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );
        try {
            webviewView.webview.html = this._getHtmlContent(codiconsUri.toString());
            debugLog('[T2] webview HTML assigned', 'INFO', 'extension');
        } catch (error) {
            reportException('T2.resolveWebviewView.assignHtml', error);
            const errorText = error instanceof Error ? (error.stack || error.message) : String(error);
            webviewView.webview.html = `<html><body><pre style="color:var(--vscode-errorForeground);padding:8px;white-space:pre-wrap;">T2 render error:\n${escapeHtml(errorText)}</pre></body></html>`;
            return;
        }

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
                        AnthropicHandler.instance.clearSession();
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
                        // Open `_ai/quests/<quest>/live-trail.md` — the
                        // continuously-updating markdown written by
                        // the LiveTrailWriter as an Anthropic turn
                        // runs. The MD Browser auto-reloads as the
                        // file is updated (debounced 200 ms).
                        await this._openLiveTrailMarkdown();
                        break;
                    case 'openStatusPage':
                        await vscode.commands.executeCommand('tomAi.statusPage');
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

    private async _handleSendLocalLlm(text: string, profile: string, llmConfig?: string): Promise<void> {
        const manager = ensureLocalLlmManager(this._context);
        if (!manager) {
            vscode.window.showErrorMessage('Local LLM not available - extension not fully initialized. Please try again.');
            return;
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

        try {
            // Check if model needs loading (use the resolved model name)
            const modelLoaded = await manager.checkModelLoaded(modelName);

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
                            const loaded = await manager.checkModelLoaded();
                            if (loaded) {
                                progress.report({ message: `Processing prompt with ${modelName}...` });
                                clearInterval(checkInterval);
                            }
                        }, 2000);
                        externalCts.token.onCancellationRequested(() => clearInterval(checkInterval));
                    } else {
                        // Model already loaded, go straight to processing
                        progress.report({ message: `Processing prompt with ${modelName}...` });
                    }
                    return manager.process(expanded, profileKey, llmConfigKey, undefined, externalCts.token);
                }
            );
            
            if (result.success) {
                await this._appendToTrail(expanded, result.result, profileLabel, llmConfigKey);
                await this._showTrail(llmConfigKey);
            } else {
                const errorMsg = result.error || 'Unknown error';
                debugLog(`[ChatPanel] Local LLM error (config=${llmConfigKey}, model=${modelName}): ${errorMsg}`, 'ERROR', 'extension');
                vscode.window.showErrorMessage(`Local LLM error: ${errorMsg}`);
            }
        } catch (e) {
            debugLog(`[ChatPanel] Local LLM failed (config=${llmConfigKey}, model=${modelName}): ${e}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(`Local LLM failed: ${e}`);
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

    private async _handleSendAnthropic(text: string, profileId: string, modelId: string, configId: string, userMessageTemplateId?: string): Promise<void> {
        if (!text || !text.trim()) { return; }
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

        // Tool resolution — profile is the single source of truth
        // (see globalTemplateEditor-handler.ts `anthropicProfiles` case):
        //  1. profile.toolsEnabled !== false  → ALL tools (ALL_SHARED_TOOLS)
        //  2. profile.toolsEnabled === false  → profile.enabledTools subset
        //     (empty array → no tools)
        const profileOverride = (profile as unknown as { enabledTools?: string[]; toolsEnabled?: boolean });
        const allToolsEnabled = profileOverride.toolsEnabled !== false;
        let tools: SharedToolDefinition[];
        if (allToolsEnabled) {
            tools = [...ALL_SHARED_TOOLS];
        } else {
            const enabledIds = Array.isArray(profileOverride.enabledTools) ? profileOverride.enabledTools : [];
            tools = enabledIds.length > 0
                ? ALL_SHARED_TOOLS.filter((t) => enabledIds.includes(t.name))
                : [];
        }

        this._ensureAnthropicApprovalListener();
        this._ensureAnthropicStatusListener();

        // Register a cancellation source so the panel's stop button can abort the turn.
        this._activeCts.get('anthropic')?.dispose();
        const cts = new vscode.CancellationTokenSource();
        this._activeCts.set('anthropic', cts);

        try {
            const result = await AnthropicHandler.instance.sendMessage({
                userText: text,
                profile,
                configuration: cfg,
                tools,
                cancellationToken: cts.token,
                ...(userMessageTemplate ? { userMessageTemplate } : {}),
            });
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
     * Open `_ai/quests/<quest>/live-trail.md` in the MD Browser. The
     * MD Browser's file watcher (debounced 200 ms) re-renders the
     * webview as the Anthropic handler appends new events, so the
     * user watches each thinking / tool_use / assistant chunk arrive.
     * The file is created on the first send of the session — we
     * tolerate it not existing yet with an info message.
     */
    private async _openLiveTrailMarkdown(): Promise<void> {
        const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
        // Resolve the quest folder the same way LiveTrailWriter does.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
        const safeQuest = (questId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
        const target = path.join(questsRoot, safeQuest, 'live-trail.md');
        if (!fs.existsSync(target)) {
            vscode.window.showInformationMessage(
                `No live trail yet for quest "${questId || 'default'}". The live trail is created on the first Anthropic send (${target}).`,
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
        } catch {
            vscode.window.showWarningMessage('Prompt queue not available');
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

        private _getHtmlContent(codiconsUri: string): string {
        const css = this._getStyles();
        const script = this._getScript();
            try {
                new Function(script);
            } catch (error) {
                reportException('T2.webviewScript.parse', error, { length: script.length });
                throw error;
            }

            const safeScript = script.replace(/<\/script/gi, '<\\/script');

        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link href="${codiconsUri}" rel="stylesheet" />
<style>${css}</style></head>
<body>
<div class="accordion-container" id="container">Loading T2...</div>
<div class="placeholder-popup-overlay" id="placeholderOverlay" onclick="closePlaceholderPopup()"></div>
<div class="placeholder-popup" id="placeholderPopup"></div>
<div id="placeholder-help-source" style="display:none;">${PLACEHOLDER_HELP}</div>
    <script>${safeScript}</script>
</body></html>`;
    }

    private _getStyles(): string {
        // Use base accordion styles from shared component
        const baseStyles = getAccordionStyles();
        
        // Add custom styles specific to unified notepad
        const customStyles = `
.profile-info { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; margin-top: 4px; max-height: 60px; overflow-y: auto; }
.toolbar-spacer { flex: 1; min-width: 16px; }
.answers-toolbar { background: rgba(200, 170, 0, 0.15); border: 1px solid rgba(200, 170, 0, 0.4); border-radius: 4px; padding: 4px 8px !important; }
.answer-indicator { font-size: 12px; font-weight: 600; color: var(--vscode-editorWarning-foreground, #cca700); margin-right: 8px; }
.checkbox-label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.checkbox-label input[type="checkbox"] { margin: 0; cursor: pointer; }
.copilot-compact-toolbar { gap: 2px !important; }
.copilot-compact-toolbar .compact-select { max-width: 90px; font-size: 11px; }
.reusable-prompt-type { min-width: 90px; max-width: 130px; }
.reusable-prompt-scope { min-width: 140px; max-width: 240px; }
.reusable-prompt-file { min-width: 180px; max-width: 320px; }
.copilot-compact-toolbar .compact-keep { margin-left: auto; }
.copilot-compact-toolbar .icon-btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-radius: 4px; }
.copilot-compact-toolbar .icon-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.copilot-compact-toolbar .icon-btn.queue-active { color: var(--vscode-editorWarning-foreground, #cca700); }
.context-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 200; background: rgba(0,0,0,0.4); display: flex; align-items: flex-start; justify-content: center; padding: 12px 0; }
.context-popup { position: relative; z-index: 201; width: 100%; max-width: 420px; background: var(--vscode-editorWidget-background, var(--vscode-panel-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); overflow-y: auto; max-height: calc(100vh - 24px); }
.context-popup-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; font-size: 14px; }
.context-popup-body { padding: 10px 14px; }
.context-popup-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border); }
.context-popup-footer button { padding: 6px 16px; font-size: 14px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; }
.context-popup-footer button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.context-group { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 8px 10px; margin-bottom: 8px; }
.context-group legend { font-size: 13px; font-weight: 600; color: var(--vscode-descriptionForeground); padding: 0 4px; }
.context-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 14px; }
.context-row label { min-width: 70px; font-size: 13px; }
.context-row select { flex: 1; font-size: 13px; padding: 3px 4px; }
.context-row select[multiple] { min-height: 56px; }
.context-links { display: flex; flex-wrap: wrap; gap: 4px; }
.link-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 12px; border: 1px solid var(--vscode-input-border); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; white-space: nowrap; }
.link-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.link-btn .codicon { font-size: 12px; }
.context-summary { font-size: 10px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.placeholder-popup-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 300; background: rgba(0,0,0,0.35); display: none; }
.placeholder-popup { position: fixed; top: 6%; left: 4px; right: 4px; bottom: 6%; z-index: 301; background: var(--vscode-editorWidget-background, var(--vscode-panel-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.3); overflow-y: auto; padding: 12px; font-size: 11px; line-height: 1.6; font-family: var(--vscode-editor-font-family); display: none; }
.placeholder-popup h4 { font-size: 12px; color: var(--vscode-editorWarning-foreground, #cca700); margin: 10px 0 4px; }
.placeholder-popup h4:first-child { margin-top: 0; }
.placeholder-popup .close-popup { position: sticky; top: 0; float: right; background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font-size: 14px; color: var(--vscode-foreground); border-radius: 4px; padding: 2px 8px; z-index: 302; }
.placeholder-popup code { font-size: 11px; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
.placeholder-popup .ph-row { display: flex; gap: 6px; margin: 2px 0; }
.placeholder-popup .ph-row code { min-width: 160px; flex-shrink: 0; }
.status-bar-actions { display: flex; gap: 4px; align-items: center; }
.slot-buttons { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; }
.slot-btn { width: 18px; height: 18px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); font-size: 10px; font-weight: 700; line-height: 1; cursor: pointer; padding: 0; }
.slot-btn:hover { background: var(--vscode-list-hoverBackground); }
.slot-btn.active { background: #f2f2f2; color: #111; border-color: #c8c8c8; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08); }
.slot-btn.active:hover { background: #f2f2f2; color: #111; border-color: #c8c8c8; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08); }
.slot-btn.answer-ready { background: var(--vscode-editorWarning-foreground, #cca700); color: #111; border-color: transparent; }
.slot-btn.answer-ready:hover { background: var(--vscode-editorWarning-foreground, #cca700); color: #111; border-color: transparent; }
.slot-btn.answer-ready.active { background: var(--vscode-editorWarning-foreground, #cca700); color: #111; border-color: #111; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35); }
.slot-btn.answer-ready.active:hover { background: var(--vscode-editorWarning-foreground, #cca700); color: #111; border-color: #111; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35); }
.answer-slot-badge { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; margin-left: 6px; background: var(--vscode-editorWarning-foreground, #cca700); color: #111; font-size: 11px; font-weight: 700; }
`;
        return baseStyles + customStyles;
    }

    private _getScript(): string {
        return `
var vscode = acquireVsCodeApi();
var sectionsConfig = [
    { id: 'localLlm', icon: '<span class="codicon codicon-robot"></span>', title: 'Local LLM' },
    { id: 'conversation', icon: '<span class="codicon codicon-comment-discussion"></span>', title: 'AI Conversation' },
    { id: 'copilot', icon: '<span class="codicon codicon-copilot"></span>', title: 'Copilot' },
    { id: 'tomAiChat', icon: '<span class="codicon codicon-comment-discussion-sparkle"></span>', title: 'Tom AI Chat' },
    { id: 'anthropic', icon: '<span class="codicon codicon-sparkle"></span>', title: 'Anthropic' }
];
var state = { expanded: ['localLlm'], pinned: [] };
var profiles = { localLlm: [], conversation: [], copilot: [], tomAiChat: [], anthropic: [] };
var configurations = [];
var setups = [];
var anthropicConfigurations = [];
var anthropicProfileEntries = [];
var anthropicUserMessageTemplates = [];
var anthropicModels = [];
var anthropicApiKeyOk = false;
var claudeCliOk = null;      // null = probing, true/false = resolved (spec §18.6)
var claudeCliVisible = false; // true when any config uses transport: 'agentSdk'
var anthropicSending = false;
var anthropicSessionTurns = 0;
var anthropicLastToolCalls = 0;
var pendingAnthropicApprovals = {};
var defaultCopilotTemplate = '';
var reusablePromptModel = { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
var pendingReusableCopySection = '';
var reusablePreferredQuestId = '';
var reusablePreferredProjectId = '';
var reusablePreferredScanId = '';
var reusablePromptState = {};
var copilotHasAnswer = false;
var copilotAnswerSlot = 0;
var slotEnabledSections = ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'];
var sectionSlotState = {};
var delegatedUiHandlersAttached = false;

function ensureSlotState(sectionId) {
    if (!sectionSlotState[sectionId]) {
        sectionSlotState[sectionId] = { activeSlot: 1, slots: {} };
    }
    if (!sectionSlotState[sectionId].slots) {
        sectionSlotState[sectionId].slots = {};
    }
    return sectionSlotState[sectionId];
}

function getSlotText(sectionId, slot) {
    var sectionState = ensureSlotState(sectionId);
    return sectionState.slots[String(slot)] || '';
}

function setSlotText(sectionId, slot, text) {
    var sectionState = ensureSlotState(sectionId);
    sectionState.slots[String(slot)] = text || '';
}

function getPanelSlotButtonsHtml(sectionId) {
    if (slotEnabledSections.indexOf(sectionId) < 0) {
        return '';
    }
    var sectionState = ensureSlotState(sectionId);
    var buttons = '';
    for (var i = 1; i <= 9; i++) {
        var activeClass = sectionState.activeSlot === i ? ' active' : '';
        buttons += '<button class="slot-btn' + activeClass + '" data-action="switchSlot" data-id="' + sectionId + '" data-slot="' + i + '" title="Prompt Slot ' + i + '">' + i + '</button>';
    }
    return '<span class="slot-buttons">' + buttons + '</span>';
}

function getReusablePromptControlsHtml(sectionId) {
    return '<label>Type:</label>' +
    '<select id="' + sectionId + '-reusable-type" class="reusable-prompt-type" title="Reusable prompt type"><option value="global">global</option><option value="project">project</option><option value="quest">quest</option><option value="scan">scan</option></select>' +
    '<label id="' + sectionId + '-reusable-scope-label" style="display:none;">Project:</label>' +
    '<select id="' + sectionId + '-reusable-scope" class="reusable-prompt-scope" title="Reusable prompt scope" style="display:none;"><option value="">(Select)</option></select>' +
    '<label>Files:</label>' +
    '<select id="' + sectionId + '-reusable-file" class="reusable-prompt-file" title="Reusable prompt file"><option value="">(File)</option></select>' +
    '<button class="icon-btn" data-action="previewReusablePrompt" data-id="' + sectionId + '" title="Preview in overlay"><span class="codicon codicon-open-preview"></span></button>' +
        '<button class="icon-btn" data-action="openReusablePromptExternal" data-id="' + sectionId + '" title="Open in MD viewer"><span class="codicon codicon-link-external"></span></button>' +
        '<button class="icon-btn" data-action="sendReusablePrompt" data-id="' + sectionId + '" title="Send reusable prompt to this section"><span class="codicon codicon-send"></span></button>' +
        '<button class="icon-btn" data-action="copyReusablePrompt" data-id="' + sectionId + '" title="Copy reusable prompt into this tab"><span class="codicon codicon-copy"></span></button>' +
        '<button class="icon-btn" data-action="openReusablePrompt" data-id="' + sectionId + '" title="Open reusable prompt file in editor"><span class="codicon codicon-edit"></span></button>' +
        '<button class="icon-btn" data-action="saveReusablePrompt" data-id="' + sectionId + '" title="Save current tab as reusable prompt"><span class="codicon codicon-save"></span></button>';
}

function switchPanelSlot(sectionId, slot) {
    var sectionState = ensureSlotState(sectionId);
    var textarea = document.getElementById(sectionId + '-text');
    if (textarea) {
        setSlotText(sectionId, sectionState.activeSlot, textarea.value || '');
    }
    sectionState.activeSlot = slot;
    if (textarea) {
        textarea.value = getSlotText(sectionId, slot);
    }
    updateSlotButtonsUI(sectionId);
    if (sectionId === 'copilot') {
        refreshCopilotAnswerToolbarVisibility();
    }
    saveDrafts();
}

function updateSlotButtonsUI(sectionId) {
    var sectionState = ensureSlotState(sectionId);
    document.querySelectorAll('.slot-btn[data-id="' + sectionId + '"]').forEach(function(btn) {
        var slotNo = parseInt(btn.dataset.slot || '0', 10);
        btn.classList.toggle('active', slotNo === sectionState.activeSlot);
        if (sectionId === 'copilot') {
            btn.classList.toggle('answer-ready', copilotHasAnswer && slotNo === copilotAnswerSlot);
        }
    });
}

function refreshCopilotAnswerToolbarVisibility() {
    var toolbar = document.getElementById('copilot-answers-toolbar');
    if (!toolbar) return;
    var activeSlot = ensureSlotState('copilot').activeSlot;
    toolbar.style.display = (copilotHasAnswer && activeSlot === copilotAnswerSlot) ? 'flex' : 'none';
}

function getPlaceholderPopupHtml() {
    var source = document.getElementById('placeholder-help-source');
    var html = source ? source.innerHTML : '<p>Placeholder help not available.</p>';
    return '<button class="close-popup" onclick="closePlaceholderPopup()">\\u2715 Close</button>' + html;
}

function showPlaceholderPopup() {
    var popup = document.getElementById('placeholderPopup');
    var overlay = document.getElementById('placeholderOverlay');
    if (popup && overlay) {
        popup.innerHTML = getPlaceholderPopupHtml();
        popup.style.display = 'block';
        overlay.style.display = 'block';
    }
}

function closePlaceholderPopup() {
    var popup = document.getElementById('placeholderPopup');
    var overlay = document.getElementById('placeholderOverlay');
    if (popup) popup.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

var PLACEHOLDER_TOOLTIP = 'Click for placeholder help';

function loadState() {
    try {
        var s = vscode.getState();
        if (s && s.expanded && Array.isArray(s.expanded)) state.expanded = s.expanded;
        if (s && s.pinned && Array.isArray(s.pinned)) state.pinned = s.pinned;
    } catch(e) {}
}

function saveState() { vscode.setState(state); }

function isExpanded(id) { return state.expanded && state.expanded.includes(id); }
function isPinned(id) { return state.pinned && state.pinned.includes(id); }

function toggleSection(id) {
    if (isExpanded(id)) {
        state.expanded = state.expanded.filter(function(s) { return s !== id; });
    } else {
        state.expanded.push(id);
        sectionsConfig.forEach(function(sec) {
            if (sec.id !== id && !isPinned(sec.id)) {
                state.expanded = state.expanded.filter(function(s) { return s !== sec.id; });
            }
        });
    }
    if (state.expanded.length === 0) state.expanded = [id];
    saveState();
    render();
}

function togglePin(id, e) {
    e.stopPropagation();
    var idx = state.pinned.indexOf(id);
    if (idx >= 0) { state.pinned.splice(idx, 1); }
    else { state.pinned.push(id); if (!isExpanded(id)) state.expanded.push(id); }
    saveState();
    render();
}

function getPromptEditorComponent(options) {
    var selectorId = options.sectionId + '-' + options.selectorKind;
    var selectorClass = options.selectorClass ? ' class="' + options.selectorClass + '"' : '';
    var selectorTitle = options.selectorTitle ? ' title="' + options.selectorTitle + '"' : '';
    var selectorHtml =
        '<label>' + options.selectorLabel + ':</label>' +
        '<select id="' + selectorId + '"' + selectorClass + selectorTitle + '>' +
        (options.selectorOptions || '<option value="">(None)</option>') +
        '</select>';

    return '<div class="toolbar' + (options.toolbarClass ? ' ' + options.toolbarClass : '') + '">' +
        (options.prefixButtons || '') +
        selectorHtml +
        (options.secondarySelectorHtml || '') +
        (options.manageButtons || '') +
        (options.actionButtons || '') +
        getReusablePromptControlsHtml(options.sectionId) +
        '<span class="toolbar-spacer"></span>' +
        getPanelSlotButtonsHtml(options.sectionId) +
        '<button class="icon-btn placeholder-help-btn" title="' + (options.helpTitle || '') + '"><span class="codicon codicon-question"></span></button>' +
        '</div>' +
        (options.afterToolbarHtml || '') +
        '<div id="' + options.infoId + '" class="profile-info" style="display:none;"></div>' +
        '<textarea id="' + options.sectionId + '-text" placeholder="' + options.placeholder + '" data-input="' + options.sectionId + '"></textarea>' +
        (options.afterEditorHtml || '');
}

function getSectionContent(id) {
    var contents = {
        localLlm: getPromptEditorComponent({
            sectionId: 'localLlm',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            secondarySelectorHtml: '<label>LLM Config:</label><select id="localLlm-llmConfig" style="width:70%"></select>',
            manageButtons:
                '<button class="icon-btn" data-action="addProfile" data-id="localLlm" title="Add Profile"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editProfile" data-id="localLlm" title="Edit Profile"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteProfile" data-id="localLlm" title="Delete Profile"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="preview" data-id="localLlm" title="Preview expanded prompt">Preview</button>' +
                '<button class="primary" data-action="send" data-id="localLlm" title="Send prompt to Local LLM">Send to LLM</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="localLlm" title="Stop current Local LLM turn"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="icon-btn" data-action="trail" data-id="localLlm" title="Open Trail File"><span class="codicon codicon-list-flat"></span></button>' +
                '<button class="icon-btn" data-action="clearText" data-id="localLlm" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            infoId: 'localLlm-profileInfo',
            placeholder: 'Enter your prompt for the local LLM...',
            helpTitle: '',
        }),
        conversation: getPromptEditorComponent({
            sectionId: 'conversation',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            secondarySelectorHtml: '<label>AI Setup:</label><select id="conversation-aiSetup" style="width:70%"></select>',
            manageButtons:
                '<button class="icon-btn" data-action="addProfile" data-id="conversation" title="Add Profile"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editProfile" data-id="conversation" title="Edit Profile"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteProfile" data-id="conversation" title="Delete Profile"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="preview" data-id="conversation" title="Preview expanded prompt">Preview</button>' +
                '<button class="primary" data-action="send" data-id="conversation" title="Start AI Conversation">Start</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="conversation" title="Halt AI conversation"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="icon-btn" data-action="clearText" data-id="conversation" title="Clear text"><span class="codicon codicon-clear-all"></span></button>' +
                '<button class="icon-btn" data-action="openConversationTrailViewer" data-id="conversation" title="Open AI conversation trail viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<button class="icon-btn" data-action="openConversationMarkdown" data-id="conversation" title="Open latest AI conversation markdown"><span class="codicon codicon-file"></span></button>' +
                '<button class="icon-btn" data-action="openConversationCompactTrail" data-id="conversation" title="Open AI conversation compact trail"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openConversationTurnFilesEditor" data-id="conversation" title="Open AI conversation per-turn files"><span class="codicon codicon-files"></span></button>',
            infoId: 'conversation-profileInfo',
            placeholder: 'Enter your goal/description for the conversation...',
            helpTitle: 'Tip: Describe the goal clearly. The bot will orchestrate a multi-turn conversation with Copilot.',
        }),
        copilot: getPromptEditorComponent({
            sectionId: 'copilot',
            selectorKind: 'template',
            selectorLabel: 'Template',
            selectorOptions: '<option value="">(None)</option><option value="__answer_file__">Answer Wrapper</option>',
            selectorClass: 'compact-select',
            selectorTitle: 'Template',
            toolbarClass: 'copilot-compact-toolbar',
            prefixButtons:
                '<button class="icon-btn" data-action="openContextPopup" data-id="copilot" title="Context & Settings"><span class="codicon codicon-tools"></span></button>',
            manageButtons:
                '<button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add Template"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit Template"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete Template"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button class="icon-btn" data-action="preview" data-id="copilot" title="Preview"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn primary" id="copilot-send-btn" data-action="send" data-id="copilot" title="Send to Copilot"><span class="codicon codicon-send"></span></button>' +
                '<label class="checkbox-label compact-keep" title="Queue repeats"><span style="opacity:0.8;">R</span><input type="text" id="copilot-repeat-count" value="1" style="width:24px"></label>' +
                '<label class="checkbox-label compact-keep" title="Answer wait minutes (0 = wait for answer file)"><span style="opacity:0.8;">W</span><input type="text" id="copilot-answer-wait" value="0" style="width:24px"></label>' +
                '<button class="icon-btn" data-action="addToQueue" data-id="copilot" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="saveAsTimedRequest" data-id="copilot" title="Save as Timed Request"><span class="codicon codicon-save"></span></button>' +
                '<button class="icon-btn" data-action="openTimedRequestsEditor" data-id="copilot" title="Timed Requests"><span class="codicon codicon-watch"></span></button>' +
                '<button class="icon-btn" data-action="openTrailRawFiles" data-id="copilot" title="Open Raw Trail Files Viewer"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailSummaryViewer" data-id="copilot" title="Open Trail Summary Viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<label class="checkbox-label compact-keep"><input type="checkbox" id="copilot-keep-content"> Keep</label>' +
                '<button class="icon-btn" data-action="clearText" data-id="copilot" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            afterToolbarHtml:
                '<div class="toolbar answers-toolbar" id="copilot-answers-toolbar" style="display:none;">' +
                '<span id="copilot-answer-indicator" class="answer-indicator">Answer Ready</span>' +
                '<button class="icon-btn" data-action="showAnswerViewer" data-id="copilot" title="View Answer"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn" data-action="extractAnswer" data-id="copilot" title="Extract to Markdown"><span class="codicon codicon-file-symlink-file"></span></button>' +
                '</div>',
            // Context + Settings overlay no longer lives in this section;
            // it is rendered once at container level by render() so that
            // collapsing the Copilot section does not hide the popup when
            // another section invokes it.
            infoId: 'copilot-templateInfo',
            placeholder: 'Enter your prompt...',
            helpTitle: '',
            afterEditorHtml:
                '<div class="status-bar"><span id="copilot-context-summary" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                '<button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="copilot" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="copilot" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '</span></div>',
        }),
        tomAiChat: getPromptEditorComponent({
            sectionId: 'tomAiChat',
            selectorKind: 'template',
            selectorLabel: 'Template',
            selectorOptions: '<option value="">(None)</option>',
            manageButtons:
                '<button class="icon-btn" data-action="addTemplate" data-id="tomAiChat" title="Add Template"><span class="codicon codicon-add"></span></button>' +
                '<button class="icon-btn" data-action="editTemplate" data-id="tomAiChat" title="Edit Template"><span class="codicon codicon-edit"></span></button>' +
                '<button class="icon-btn danger" data-action="deleteTemplate" data-id="tomAiChat" title="Delete Template"><span class="codicon codicon-trash"></span></button>',
            actionButtons:
                '<button data-action="openChatFile" data-id="tomAiChat" title="Open or create .chat.md file">Open</button>' +
                '<button data-action="preview" data-id="tomAiChat" title="Preview expanded prompt">Preview</button>' +
                '<button class="icon-btn" data-action="cancel" data-id="tomAiChat" title="Interrupt Tom AI Chat turn"><span class="codicon codicon-debug-stop"></span></button>' +
                '<button class="primary" data-action="insertToChatFile" data-id="tomAiChat" title="Insert into .chat.md file">Insert</button>' +
                '<button class="icon-btn" data-action="clearText" data-id="tomAiChat" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            infoId: 'tomAiChat-templateInfo',
            placeholder: 'Enter your prompt for Tom AI Chat...',
            helpTitle: 'Show Placeholder Help',
        }),
        anthropic: getPromptEditorComponent({
            sectionId: 'anthropic',
            selectorKind: 'profile',
            selectorLabel: 'Profile',
            selectorOptions: '<option value="">(None)</option>',
            prefixButtons:
                '<button class="icon-btn" data-action="openContextPopup" data-id="anthropic" title="Context & Settings"><span class="codicon codicon-tools"></span></button>',
            secondarySelectorHtml:
                // Edit-profile icon sits immediately after the Profile
                // dropdown — opens the Global Template Editor on the
                // 'anthropicProfiles' category for the selected profile.
                '<button class="icon-btn" data-action="editAnthropicProfile" data-id="anthropic" title="Edit Anthropic profile (system prompt)"><span class="codicon codicon-edit"></span></button>' +
                // Config dropdown intentionally removed — the profile
                // owns configurationId and the handler resolves via
                // profile.configurationId → isDefault → first. Pick a
                // different configuration by switching profile.
                '<span id="anthropic-apikey-dot" class="api-status-dot" title="API key status" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:6px;"></span>' +
                '<span id="anthropic-claude-dot" class="api-status-dot" title="Claude Code install status (Agent SDK transport)" style="display:none;width:10px;height:10px;border-radius:50%;background:var(--vscode-errorForeground);margin-left:4px;"></span>' +
                // User-message template dropdown + inline edit icon (§7.3)
                '<label>User Prompt:</label><select id="anthropic-userMessage" style="width:40%" title="Anthropic user-message template"><option value="">(None)</option></select>' +
                '<button class="icon-btn" data-action="editAnthropicUserMessage" data-id="anthropic" title="Edit Anthropic user-message template"><span class="codicon codicon-edit"></span></button>',
            // Intentionally empty: add/delete for profiles and user-message
            // templates is done inside the Global Template Editor, not here.
            manageButtons: '',
            actionButtons:
                '<button data-action="preview" data-id="anthropic" title="Preview expanded prompt">Preview</button>' +
                '<button class="icon-btn primary" id="anthropic-send-btn" data-action="send" data-id="anthropic" title="Send to Anthropic"><span class="codicon codicon-send"></span></button>' +
                '<button class="icon-btn" data-action="cancel" data-id="anthropic" title="Stop current Anthropic turn"><span class="codicon codicon-debug-stop"></span></button>' +
                // Queue-only repeat count — applied when staging via "Save to Queue";
                // ignored by the inline send button.
                '<label class="checkbox-label compact-keep" title="Queue repeats (used when adding to queue)"><span style="opacity:0.8;">R</span><input type="text" id="anthropic-repeat-count" value="1" style="width:24px"></label>' +
                // Queue buttons — mirror the Copilot section (spec §4.11).
                // Stages the prompt as a queued item with transport='anthropic'
                // and pins the current profile / user-message template.
                '<button class="icon-btn" data-action="addToQueue" data-id="anthropic" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openTrailRawFiles" data-id="anthropic" title="Open Raw Trail Files Viewer"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailSummaryViewer" data-id="anthropic" title="Open Trail Summary Viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<button class="icon-btn" data-action="openSessionHistory" data-id="anthropic" title="Open session history — the rolling history.md from the quest folder, rendered in the MD Browser"><span class="codicon codicon-file-text"></span></button>' +
                '<button class="icon-btn" data-action="openLiveTrail" data-id="anthropic" title="Open live trail — continuously-updating MD of the current + last 4 prompts (thinking, tool calls + results, assistant text); opens in the MD Browser which auto-reloads as the turn runs"><span class="codicon codicon-pulse"></span></button>' +
                '<button class="icon-btn" data-action="openAnthropicMemory" data-id="anthropic" title="Memory Panel"><span class="codicon codicon-book"></span></button>' +
                '<button class="icon-btn" data-action="clearAnthropicHistory" data-id="anthropic" title="Clear session history"><span class="codicon codicon-clear-all"></span></button>',
            afterToolbarHtml:
                '<div id="anthropic-approval-overlay" class="context-overlay" style="display:none;">' +
                '<div id="anthropic-approval-popup" class="context-popup">' +
                '<div class="context-popup-header"><span>Tool Approval Required</span></div>' +
                '<div class="context-popup-body">' +
                '<div id="anthropic-approval-body" style="padding:8px;font-family:var(--vscode-editor-font-family);white-space:pre-wrap;max-height:40vh;overflow:auto;"></div>' +
                '</div>' +
                '<div class="context-popup-footer">' +
                '<button class="primary" data-action="anthropicApprovalApprove">Approve</button>' +
                '<button data-action="anthropicApprovalApproveAll">Allow All (session)</button>' +
                '<button data-action="anthropicApprovalDeny">Deny</button>' +
                '<button data-action="anthropicApprovalDenyAll">Deny All (session)</button>' +
                '</div>' +
                '</div>' +
                '</div>',
            infoId: 'anthropic-profileInfo',
            placeholder: 'Enter your prompt for Anthropic...',
            helpTitle: '',
            afterEditorHtml:
                // The Model dropdown here is informational only — configurations
                // are the source of truth. It lets the user eyeball which models
                // the API currently returns so they can add configurations when
                // new models ship. The value is never read when sending.
                '<div class="status-bar"><span id="anthropic-status" class="context-summary"></span>' +
                '<span class="status-bar-actions">' +
                '<button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="anthropic" title="Open Prompt Queue"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="openQueueTemplatesEditor" data-id="anthropic" title="Open Queue Templates"><span class="codicon codicon-files"></span></button>' +
                '<button class="icon-btn" data-action="openStatusPage" data-id="anthropic" title="Open Extension Status Page"><span class="codicon codicon-dashboard"></span></button>' +
                '<label style="margin-left:6px;">Available Models:</label>' +
                '<select id="anthropic-model" style="max-width:240px;" title="Read-only list of models returned by the Anthropic API. The selected configuration controls which model is actually used."><option value="">(loading...)</option></select>' +
                '<button class="icon-btn" data-action="refreshAnthropicModels" data-id="anthropic" title="Refresh models from API"><span class="codicon codicon-refresh"></span></button>' +
                // VS Code LM model dropdown (informational — spec §4.12).
                // Always visible on the Anthropic bottom bar regardless of
                // the active configuration's transport; the user wants
                // ambient visibility of which LM-API models Copilot has
                // on this machine. Auto-populated on panel ready;
                // refresh re-queries vscode.lm.selectChatModels().
                // Selection does NOT retarget sends — the stored modelId
                // of the active configuration drives sends.
                '<span id="anthropic-vscodelm-row">' +
                  '<label style="margin-left:6px;">VS Code LM Models:</label>' +
                  '<select id="anthropic-vscodelm-models" style="max-width:240px;" title="Read-only list of models available via vscode.lm.selectChatModels(). Informational — the stored modelId of the active configuration drives sends. Click Refresh to re-query."><option value="">(loading...)</option></select>' +
                  '<button class="icon-btn" data-action="refreshVsCodeLmModels" data-id="anthropic" title="Refresh VS Code LM model list"><span class="codicon codicon-refresh"></span></button>' +
                '</span>' +
                '</span></div>',
        })
    };
    return contents[id] || '<div>Unknown section</div>';
}

var _rendered = false;

function render() {
    var container = document.getElementById('container');
    if (!_rendered) {
        // --- Initial render: build full DOM ---
        var html = '';
        sectionsConfig.forEach(function(sec, idx) {
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            html += '<div class="accordion-section ' + (exp ? 'expanded' : 'collapsed') + '" data-section="' + sec.id + '">';
            html += '<div class="header-expanded" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-right"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span><button class="pin-btn ' + (pin ? 'pinned' : '') + '" data-pin="' + sec.id + '" title="' + (pin ? 'Unpin' : 'Pin') + '"><span class="codicon ' + (pin ? 'codicon-pinned' : 'codicon-pin') + '"></span></button></div>';
            html += '<div class="header-collapsed" data-toggle="' + sec.id + '"><span class="arrow"><span class="codicon codicon-chevron-down"></span></span><span class="icon">' + sec.icon + '</span><span class="title">' + sec.title + '</span></div>';
            html += '<div class="section-content">' + getSectionContent(sec.id) + '</div></div>';
        });
        // Shared Context & Settings overlay — rendered at container level
        // (not inside any accordion section) so collapsing or switching
        // sections never hides the popup. Same id as before so existing
        // openContextPopup()/closeContextPopup() wiring still works.
        html += '<div id="copilot-context-overlay" class="context-overlay" style="display:none;">' +
            '<div id="copilot-context-popup" class="context-popup">' +
            '<div class="context-popup-header"><span>Context & Settings</span><button class="icon-btn" data-action="closeContextPopup" title="Close"><span class="codicon codicon-close"></span></button></div>' +
            '<div class="context-popup-body">' +
            '<fieldset class="context-group"><legend>Context</legend>' +
            '<div class="context-row"><label>Quest:</label><select id="ctx-quest"></select></div>' +
            '<div class="context-row"><label>Role:</label><select id="ctx-role"></select></div>' +
            '<div class="context-row"><label>Projects:</label><select id="ctx-projects" multiple size="3"></select></div>' +
            '<div class="context-row"><label>Todo File:</label><select id="ctx-todoFile"></select></div>' +
            '<div class="context-row"><label>Todo:</label><select id="ctx-todo"></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Auto-Hide</legend>' +
            '<div class="context-row"><label>Auto-hide:</label><select id="copilot-autohide"><option value="0">Keep open</option><option value="1000">1s</option><option value="5000">5s</option><option value="10000">10s</option></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Quick Links</legend>' +
            '<div class="context-links">' +
            '<button class="link-btn" data-action="openStatusPage" title="Extension Status"><span class="codicon codicon-dashboard"></span> Status Page</button>' +
            '<button class="link-btn" data-action="openGlobalTemplateEditor" title="Prompt Template Editor"><span class="codicon codicon-file-code"></span> Template Editor</button>' +
            '<button class="link-btn" data-action="openReusablePromptEditor" title="Reusable Prompt Editor"><span class="codicon codicon-note"></span> Reusable Prompts</button>' +
            '<button class="link-btn" data-action="openContextSettingsEditor" title="Context & Settings Editor"><span class="codicon codicon-settings-gear"></span> Context Editor</button>' +
            '<button class="link-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span> Chat Variables</button>' +
            '<button class="link-btn" data-action="openTrailRawFiles" data-id="copilot" title="Raw Trail Files Viewer"><span class="codicon codicon-history"></span> Raw Trail Files Viewer</button>' +
            '<button class="link-btn" data-action="openTrailSummaryViewer" data-id="copilot" title="Trail Summary Viewer"><span class="codicon codicon-list-flat"></span> Trail Summary Viewer</button>' +
            '</div>' +
            '</fieldset>' +
            '</div>' +
            '<div class="context-popup-footer"><button class="primary" data-action="applyContext">Apply</button><button data-action="closeContextPopup">Cancel</button></div>' +
            '</div>' +
            '</div>';
        container.innerHTML = html;
        _rendered = true;
        attachEventListeners();
        updateResizeHandles();
        populateDropdowns();
    } else {
        // --- Subsequent renders: preserve DOM, toggle classes only ---
        sectionsConfig.forEach(function(sec) {
            var el = container.querySelector('[data-section="' + sec.id + '"]');
            if (!el) return;
            var exp = isExpanded(sec.id);
            var pin = isPinned(sec.id);
            if (exp) { el.classList.remove('collapsed'); el.classList.add('expanded'); el.style.flex = ''; }
            else { el.classList.remove('expanded'); el.classList.add('collapsed'); el.style.flex = ''; }
            var pinBtn = el.querySelector('[data-pin="' + sec.id + '"]');
            if (pinBtn) {
                if (pin) { pinBtn.classList.add('pinned'); pinBtn.title = 'Unpin'; }
                else { pinBtn.classList.remove('pinned'); pinBtn.title = 'Pin'; }
                var pinIcon = pinBtn.querySelector('.codicon');
                if (pinIcon) {
                    pinIcon.classList.remove('codicon-pin', 'codicon-pinned');
                    pinIcon.classList.add(pin ? 'codicon-pinned' : 'codicon-pin');
                }
            }
        });
        updateResizeHandles();
    }
}

function updateResizeHandles() {
    var container = document.getElementById('container');
    container.querySelectorAll('.resize-handle').forEach(function(h) { h.remove(); });
    var expandedIds = [];
    sectionsConfig.forEach(function(sec) { if (isExpanded(sec.id)) expandedIds.push(sec.id); });
    for (var i = 1; i < expandedIds.length; i++) {
        var rightEl = container.querySelector('[data-section="' + expandedIds[i] + '"]');
        if (rightEl) {
            var handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.dataset.resizeLeft = expandedIds[i - 1];
            handle.dataset.resizeRight = expandedIds[i];
            container.insertBefore(handle, rightEl);
            handle.addEventListener('mousedown', function(e) { startResize(e, this); });
        }
    }
}

function attachEventListeners() {
    if (!delegatedUiHandlersAttached) {
        document.addEventListener('click', function(event) {
            var target = event.target;
            if (!target || !target.closest) return;

            var actionEl = target.closest('[data-action]');
            if (actionEl) {
                event.preventDefault();
                handleAction(actionEl.dataset.action, actionEl.dataset.id, actionEl.dataset.slot);
                return;
            }

            var pinEl = target.closest('[data-pin]');
            if (pinEl) {
                togglePin(pinEl.dataset.pin, event);
                return;
            }

            var toggleEl = target.closest('[data-toggle]');
            if (toggleEl) {
                toggleSection(toggleEl.dataset.toggle);
            }
        });
        delegatedUiHandlersAttached = true;
    }

    slotEnabledSections.forEach(function(sectionId) {
        var ta = document.getElementById(sectionId + '-text');
        if (!ta) return;
        ta.addEventListener('input', function() {
            var sectionState = ensureSlotState(sectionId);
            setSlotText(sectionId, sectionState.activeSlot, ta.value || '');
        });
    });
    // Set placeholder help buttons to open popup on click
    document.querySelectorAll('.placeholder-help-btn').forEach(function(el) { el.addEventListener('click', function() { showPlaceholderPopup(); }); });
}

var resizing = null;
var DRAG_THRESHOLD = 5;
function startResize(e, handle) {
    e.preventDefault();
    var leftId = handle.dataset.resizeLeft;
    var rightId = handle.dataset.resizeRight;
    var leftEl = document.querySelector('[data-section="' + leftId + '"]');
    var rightEl = document.querySelector('[data-section="' + rightId + '"]');
    if (!leftEl || !rightEl) return;
    var startX = e.clientX;
    var leftWidth = leftEl.offsetWidth;
    var rightWidth = rightEl.offsetWidth;
    var dragStarted = false;
    function onMove(ev) {
        var dx = ev.clientX - startX;
        if (!dragStarted) { if (Math.abs(dx) < DRAG_THRESHOLD) return; dragStarted = true; handle.classList.add('dragging'); }
        leftEl.style.flex = '0 0 ' + Math.max(120, leftWidth + dx) + 'px';
        rightEl.style.flex = '0 0 ' + Math.max(120, rightWidth - dx) + 'px';
    }
    function onUp() { if (dragStarted) handle.classList.remove('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}
function doResize() { /* legacy */ }
function stopResize() { /* legacy */ }

function handleAction(action, id, slot) {
    switch(action) {
        case 'send': { var text = document.getElementById(id + '-text'); text = text ? text.value : ''; if (!text.trim()) return; var profile = document.getElementById(id + '-profile'); profile = profile ? profile.value : ''; var template = document.getElementById(id + '-template'); template = template ? template.value : ''; var llmConfig = document.getElementById('localLlm-llmConfig'); llmConfig = llmConfig ? llmConfig.value : ''; var aiSetup = document.getElementById('conversation-aiSetup'); aiSetup = aiSetup ? aiSetup.value : ''; var anthropicUserMessage = document.getElementById('anthropic-userMessage'); anthropicUserMessage = anthropicUserMessage ? anthropicUserMessage.value : ''; var slotNo = ensureSlotState(id).activeSlot; if (id === 'anthropic') { anthropicSending = true; updateAnthropicSendButton(); setAnthropicStatus('Sending…'); } vscode.postMessage({ type: 'send' + id.charAt(0).toUpperCase() + id.slice(1), text: text, profile: profile, template: template, llmConfig: llmConfig, aiSetup: aiSetup, model: '', config: '', userMessageTemplate: anthropicUserMessage, slot: slotNo }); break; }
        case 'preview': { var prvText = document.getElementById(id + '-text'); prvText = prvText ? prvText.value : ''; var prvTpl = document.getElementById(id + '-template'); prvTpl = prvTpl ? prvTpl.value : ''; vscode.postMessage({ type: 'preview', section: id, text: prvText, template: prvTpl }); break; }
        case 'clearText': {
            if (!id) break;
            var clearTextArea = document.getElementById(id + '-text');
            if (!clearTextArea) break;
            clearTextArea.value = '';
            if (slotEnabledSections.indexOf(id) >= 0) {
                setSlotText(id, ensureSlotState(id).activeSlot, '');
                updateSlotButtonsUI(id);
            }
            saveDrafts();
            break;
        }
        case 'switchSlot': { var slotNo = parseInt(slot || '1', 10); if (slotNo >= 1 && slotNo <= 9) switchPanelSlot(id, slotNo); break; }
        case 'trail': vscode.postMessage({ type: 'showTrail', section: id }); break;
        case 'reload': vscode.postMessage({ type: 'reload', section: id }); break;
        case 'open': vscode.postMessage({ type: 'openInEditor', section: id }); break;
        case 'addNote': vscode.postMessage({ type: 'addNote' }); break;
        case 'addProfile': vscode.postMessage({ type: 'addProfile', section: id }); break;
        case 'editProfile': { var epSel = document.getElementById(id + '-profile'); vscode.postMessage({ type: 'editProfile', section: id, name: epSel ? epSel.value : '' }); break; }
        case 'addTemplate': vscode.postMessage({ type: 'addTemplate', section: id }); break;
        case 'editTemplate': { var etSel = document.getElementById(id + '-template'); var etVal = etSel ? etSel.value : ''; vscode.postMessage({ type: 'editTemplate', section: id, name: etVal }); break; }
        case 'deleteProfile': confirmDelete('profile', id); break;
        case 'deleteTemplate': { var dtSel = document.getElementById(id + '-template'); var dtVal = dtSel ? dtSel.value : ''; if (dtVal === '__answer_file__') { vscode.postMessage({ type: 'showMessage', message: 'The Answer File template is built-in and cannot be deleted.' }); return; } confirmDelete('template', id); break; }
        case 'openChatFile': vscode.postMessage({ type: 'openChatFile' }); break;
        case 'insertToChatFile': { var insertText = document.getElementById(id + '-text'); insertText = insertText ? insertText.value : ''; if (!insertText.trim()) return; var insertTemplate = document.getElementById(id + '-template'); insertTemplate = insertTemplate ? insertTemplate.value : ''; vscode.postMessage({ type: 'insertToChatFile', text: insertText, template: insertTemplate }); break; }
        case 'editAnthropicProfile': {
            var epaSel = document.getElementById('anthropic-profile');
            vscode.postMessage({ type: 'editAnthropicProfile', name: epaSel ? epaSel.value : '' });
            break;
        }
        case 'editAnthropicUserMessage': {
            var eumSel = document.getElementById('anthropic-userMessage');
            vscode.postMessage({ type: 'editAnthropicUserMessage', name: eumSel ? eumSel.value : '' });
            break;
        }
        case 'sendReusablePrompt': {
            var reusableToSend = getSelectedReusablePromptId(id);
            if (!reusableToSend) return;
            var rpMsg = { type: 'sendReusablePrompt', reusableId: reusableToSend, section: id };
            if (id === 'anthropic') {
                // Pass current panel state so the reusable prompt is
                // sent just like a manual "Send to Anthropic" — same
                // profile and user-message template. Configuration is
                // always resolved from the profile (no per-send config
                // override in the chat panel).
                var rpProfile = document.getElementById('anthropic-profile');
                var rpUserMsg = document.getElementById('anthropic-userMessage');
                rpMsg.profile = rpProfile ? rpProfile.value : '';
                rpMsg.model = '';
                rpMsg.config = '';
                rpMsg.userMessageTemplate = rpUserMsg ? rpUserMsg.value : '';
                anthropicSending = true;
                updateAnthropicSendButton();
                setAnthropicStatus('Sending reusable prompt…');
            }
            vscode.postMessage(rpMsg);
            break;
        }
        case 'copyReusablePrompt': {
            var reusableToCopy = getSelectedReusablePromptId(id);
            if (!reusableToCopy) return;
            pendingReusableCopySection = id || '';
            vscode.postMessage({ type: 'loadReusablePromptContent', reusableId: reusableToCopy });
            break;
        }
        case 'openReusablePrompt': {
            var reusableToOpen = getSelectedReusablePromptId(id);
            if (!reusableToOpen) return;
            vscode.postMessage({ type: 'openReusablePromptInEditor', section: id || '', reusableId: reusableToOpen });
            break;
        }
        case 'saveReusablePrompt': {
            var currentText = document.getElementById((id || '') + '-text');
            var selState = ensureReusablePromptState(id || '');
            vscode.postMessage({ type: 'saveReusablePrompt', section: id || '', text: currentText ? currentText.value : '', selection: { type: selState.type || '', scopeId: selState.scope || '' } });
            break;
        }
        case 'previewReusablePrompt': {
            var reusableToPreview = getSelectedReusablePromptId(id);
            if (!reusableToPreview) return;
            vscode.postMessage({ type: 'openReusablePromptInOverlay', reusableId: reusableToPreview });
            break;
        }
        case 'openReusablePromptExternal': {
            var reusableToExternal = getSelectedReusablePromptId(id);
            if (!reusableToExternal) return;
            vscode.postMessage({ type: 'openReusablePromptInExternalApp', reusableId: reusableToExternal });
            break;
        }
        case 'showAnswerViewer': vscode.postMessage({ type: 'showAnswerViewer' }); break;
        case 'extractAnswer': vscode.postMessage({ type: 'extractAnswer' }); break;
        case 'openPromptsFile': vscode.postMessage({ type: 'openPromptsFile' }); break;
        case 'openAnswersFile': vscode.postMessage({ type: 'openAnswersFile' }); break;
        case 'openContextPopup': openContextPopup(); break;
        case 'closeContextPopup': closeContextPopup(); break;
        case 'applyContext': applyContextPopup(); break;
        case 'cancel': vscode.postMessage({ type: 'cancel', section: id || '' }); break;
        case 'addToQueue':
            if (id === 'anthropic') { addAnthropicToQueue(); }
            else { addCopilotToQueue(); }
            break;
        case 'openQueueEditor': vscode.postMessage({ type: 'openQueueEditor' }); break;
        case 'openTimedRequestsEditor': vscode.postMessage({ type: 'openTimedRequestsEditor' }); break;
        case 'openTrailRawFiles': vscode.postMessage({ type: 'openTrailRawFiles', section: id || '' }); break;
        case 'openTrailSummaryViewer': vscode.postMessage({ type: 'openTrailSummaryViewer', section: id || '' }); break;
        case 'openSessionHistory': vscode.postMessage({ type: 'openSessionHistory', section: id || '' }); break;
        case 'openLiveTrail': vscode.postMessage({ type: 'openLiveTrail', section: id || '' }); break;
        case 'openConversationTrailViewer': vscode.postMessage({ type: 'openConversationTrailViewer' }); break;
        case 'openConversationMarkdown': vscode.postMessage({ type: 'openConversationMarkdown' }); break;
        case 'openConversationCompactTrail': vscode.postMessage({ type: 'openConversationCompactTrail' }); break;
        case 'openConversationTurnFilesEditor': vscode.postMessage({ type: 'openConversationTurnFilesEditor' }); break;
        case 'saveAsTimedRequest': { var trText = document.getElementById('copilot-text'); trText = trText ? trText.value : ''; if (!trText.trim()) return; var trTpl = document.getElementById('copilot-template'); trTpl = trTpl ? trTpl.value : ''; vscode.postMessage({ type: 'saveAsTimedRequest', text: trText, template: trTpl }); break; }
        case 'openChatVariablesEditor': vscode.postMessage({ type: 'openChatVariablesEditor' }); break;
        case 'openStatusPage': vscode.postMessage({ type: 'openStatusPage' }); break;
        case 'openGlobalTemplateEditor': vscode.postMessage({ type: 'openGlobalTemplateEditor' }); break;
        case 'openReusablePromptEditor': vscode.postMessage({ type: 'openReusablePromptEditor' }); break;
        case 'openContextSettingsEditor': vscode.postMessage({ type: 'openContextSettingsEditor' }); break;
        case 'refreshAnthropicModels': vscode.postMessage({ type: 'refreshAnthropicModels' }); break;
        case 'refreshVsCodeLmModels': vscode.postMessage({ type: 'refreshVsCodeLmModels' }); break;
        case 'clearAnthropicHistory': vscode.postMessage({ type: 'clearAnthropicHistory' }); _anthropicSessionDeny = {}; anthropicSessionTurns = 0; anthropicLastToolCalls = 0; setAnthropicStatus('History cleared'); break;
        case 'openAnthropicMemory': vscode.postMessage({ type: 'openAnthropicMemory' }); break;
        case 'anthropicApprovalApprove': resolveAnthropicApproval(true, false); break;
        case 'anthropicApprovalApproveAll': resolveAnthropicApproval(true, true); break;
        case 'anthropicApprovalDeny': resolveAnthropicApproval(false, false); break;
        case 'anthropicApprovalDenyAll': resolveAnthropicApproval(false, true); break;
    }
}

var _currentAnthropicApprovalId = '';
var _currentAnthropicApprovalTool = '';
var _anthropicSessionDeny = {};
function showAnthropicApprovalDialog(toolId, toolName, inputSummary) {
    // Session-level auto-deny — suppresses the dialog entirely.
    if (_anthropicSessionDeny[toolName]) {
        vscode.postMessage({
            type: 'anthropicToolApprovalResponse',
            toolId: toolId,
            approved: false,
            approveAll: false,
        });
        return;
    }
    _currentAnthropicApprovalId = toolId;
    _currentAnthropicApprovalTool = toolName;
    var body = document.getElementById('anthropic-approval-body');
    if (body) {
        body.textContent = 'Tool: ' + toolName + '\\n\\nInput:\\n' + (inputSummary || '(no input)');
    }
    var overlay = document.getElementById('anthropic-approval-overlay');
    if (overlay) overlay.style.display = 'block';
}

function resolveAnthropicApproval(approved, approveAll) {
    var overlay = document.getElementById('anthropic-approval-overlay');
    if (overlay) overlay.style.display = 'none';
    if (!_currentAnthropicApprovalId) return;
    // Deny with approveAll (labelled "Deny All session") — remember locally
    // so the rest of the session short-circuits without round-tripping.
    if (!approved && approveAll && _currentAnthropicApprovalTool) {
        _anthropicSessionDeny[_currentAnthropicApprovalTool] = true;
    }
    vscode.postMessage({
        type: 'anthropicToolApprovalResponse',
        toolId: _currentAnthropicApprovalId,
        approved: approved,
        approveAll: !!approveAll,
    });
    _currentAnthropicApprovalId = '';
    _currentAnthropicApprovalTool = '';
}

function confirmDelete(itemType, sectionId) {
    var selectId = sectionId + '-' + itemType;
    var sel = document.getElementById(selectId);
    var selectedValue = sel ? sel.value : '';
    if (!selectedValue) { vscode.postMessage({ type: 'showMessage', message: 'Please select a ' + itemType + ' to delete.' }); return; }
    // Send directly to extension - VS Code will show its own confirmation dialog
    vscode.postMessage({ type: 'delete' + itemType.charAt(0).toUpperCase() + itemType.slice(1), section: sectionId, name: selectedValue });
}

function populateDropdowns() {
    populateSelect('localLlm-profile', profiles.localLlm);
    populateSelect('conversation-profile', profiles.conversation);
    populateSelect('copilot-template', profiles.copilot);
    populateSelect('tomAiChat-template', profiles.tomAiChat);
    // Use populateEntitySelect for anthropic profiles so the entry marked
    // isDefault is preselected; the label shown is the human-readable name.
    if (anthropicProfileEntries && anthropicProfileEntries.length > 0) {
        populateEntitySelect('anthropic-profile', anthropicProfileEntries, '(Select Profile)');
    } else {
        populateSelect('anthropic-profile', profiles.anthropic);
    }
    populateSelect('anthropic-userMessage', anthropicUserMessageTemplates);
    populateEntitySelect('localLlm-llmConfig', configurations, '(Select LLM Config)');
    populateEntitySelect('conversation-aiSetup', setups, '(Select AI Setup)');
    populateAnthropicModels();
    updateAnthropicApiKeyDot();
    // Profile dropdown: configuration is resolved from the profile on
    // every send, so the status line (model / history mode) must follow
    // the profile selection.
    var anthropicProfileSel = document.getElementById('anthropic-profile');
    if (anthropicProfileSel && !anthropicProfileSel._anthropicStatusBound) {
        anthropicProfileSel._anthropicStatusBound = true;
        anthropicProfileSel.addEventListener('change', function() {
            setAnthropicStatus(buildAnthropicStatusLine());
        });
    }
    // Kick off the initial vscode.lm model fetch once per panel lifetime
    // so the dropdown shows content without requiring a manual refresh.
    // The flag lives on window so repeated populate calls (e.g. config
    // reloads) don't re-request.
    if (!window._anthropicVsCodeLmBooted) {
        window._anthropicVsCodeLmBooted = true;
        vscode.postMessage({ type: 'refreshVsCodeLmModels' });
    }
    ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
        populateReusablePromptSelectors(sectionId);
    });
}

function populateAnthropicModels() {
    // Informational: list the models the API currently returns so the user
    // can add configurations when new models ship. The value is never read
    // when sending — configurations drive model selection.
    var sel = document.getElementById('anthropic-model');
    if (!sel) return;
    var opts = '';
    if (!anthropicModels || anthropicModels.length === 0) {
        opts = '<option value="">(no models — check API key)</option>';
    } else {
        opts = '<option value="">(' + anthropicModels.length + ' models available)</option>' + anthropicModels.map(function(m) {
            var label = m.display_name ? (m.display_name + ' (' + m.id + ')') : m.id;
            return '<option value="' + m.id + '">' + label + '</option>';
        }).join('');
    }
    sel.innerHTML = opts;
    updateAnthropicSendButton();
}

function updateAnthropicApiKeyDot() {
    var dot = document.getElementById('anthropic-apikey-dot');
    if (!dot) return;
    dot.style.background = anthropicApiKeyOk
        ? 'var(--vscode-testing-iconPassed, #3fb950)'
        : 'var(--vscode-errorForeground, #f85149)';
    dot.title = anthropicApiKeyOk ? 'Anthropic API key OK' : 'Anthropic API key missing or invalid';
}

function updateClaudeCliDot() {
    var dot = document.getElementById('anthropic-claude-dot');
    if (!dot) return;
    if (!claudeCliVisible) {
        dot.style.display = 'none';
        return;
    }
    dot.style.display = 'inline-block';
    if (claudeCliOk === null) {
        dot.style.background = 'var(--vscode-editorWarning-foreground, #cca700)';
        dot.title = 'Claude CLI: probing...';
    } else if (claudeCliOk) {
        dot.style.background = 'var(--vscode-testing-iconPassed, #3fb950)';
        dot.title = 'Claude CLI detected — Agent SDK transport available';
    } else {
        dot.style.background = 'var(--vscode-errorForeground, #f85149)';
        dot.title = "Claude CLI not found. Install Claude Code and run 'claude login' to use Agent SDK configurations.";
    }
}

function updateAnthropicSendButton() {
    var btn = document.getElementById('anthropic-send-btn');
    if (!btn) return;
    // Empty config value means "Profile default" — still valid to send.
    // Disable only on missing API key or in-flight request.
    btn.disabled = !!(anthropicSending || !anthropicApiKeyOk);
}

function setAnthropicStatus(text) {
    var el = document.getElementById('anthropic-status');
    if (el) el.textContent = text || '';
}

function buildAnthropicStatusLine(historyMode) {
    // Resolve the effective configuration the same way _handleSendAnthropic
    // does: profile.configurationId → isDefault → first. Configuration
    // is owned by the profile; there's no per-send override in the
    // chat panel anymore.
    var profileSel = document.getElementById('anthropic-profile');
    var profileId = profileSel ? profileSel.value : '';
    var profile = (anthropicProfileEntries || []).find(function(p) { return p.id === profileId; });
    var configs = anthropicConfigurations || [];
    var cfg = (profile && profile.configurationId ? configs.find(function(c) { return c.id === profile.configurationId; }) : undefined)
        || configs.find(function(c) { return c.isDefault; })
        || configs[0];
    var modelName = cfg && cfg.model ? cfg.model : '';
    if (!historyMode) {
        historyMode = cfg && cfg.historyMode ? cfg.historyMode : '';
    }
    var parts = [];
    if (modelName) parts.push(modelName);
    if (historyMode) parts.push(historyMode);
    parts.push('last ' + anthropicLastToolCalls + ' tool calls');
    parts.push(anthropicSessionTurns + ' session turns');
    return parts.join(' · ');
}

function ensureReusablePromptState(sectionId) {
    if (!reusablePromptState[sectionId]) {
        reusablePromptState[sectionId] = { type: 'global', scope: '', file: '' };
    }
    return reusablePromptState[sectionId];
}

function reusableScopeLabel(type) {
    if (type === 'project') return 'Project:';
    if (type === 'quest') return 'Quest:';
    if (type === 'scan') return 'Folder:';
    return '';
}

function scopesForType(type) {
    if (type === 'project') return reusablePromptModel.scopes.project || [];
    if (type === 'quest') return reusablePromptModel.scopes.quest || [];
    if (type === 'scan') return reusablePromptModel.scopes.scan || [];
    return [];
}

function filesForSelection(type, scopeId) {
    if (type === 'global') {
        return reusablePromptModel.files.global || [];
    }
    if (type === 'project') {
        return (reusablePromptModel.files.project && reusablePromptModel.files.project[scopeId || '']) || [];
    }
    if (type === 'quest') {
        return (reusablePromptModel.files.quest && reusablePromptModel.files.quest[scopeId || '']) || [];
    }
    if (type === 'scan') {
        return (reusablePromptModel.files.scan && reusablePromptModel.files.scan[scopeId || '']) || [];
    }
    return [];
}

function populateReusablePromptSelectors(sectionId) {
    var typeSel = document.getElementById(sectionId + '-reusable-type');
    var scopeLabel = document.getElementById(sectionId + '-reusable-scope-label');
    var scopeSel = document.getElementById(sectionId + '-reusable-scope');
    var fileSel = document.getElementById(sectionId + '-reusable-file');
    if (!typeSel || !scopeSel || !fileSel || !scopeLabel) return;

    var state = ensureReusablePromptState(sectionId);

    if (!state.type) {
        state.type = 'global';
        state.scope = '';
        state.file = '';
    }

    typeSel.value = state.type;

    var needsScope = state.type === 'project' || state.type === 'quest' || state.type === 'scan';
    scopeLabel.style.display = needsScope ? '' : 'none';
    scopeSel.style.display = needsScope ? '' : 'none';
    scopeLabel.textContent = reusableScopeLabel(state.type);

    var scopes = scopesForType(state.type);
    var hasScope = scopes.some(function(s) { return s.id === state.scope; });
    if (!hasScope) {
        if (state.type === 'quest' && reusablePreferredQuestId) {
            var preferredQuest = scopes.find(function(s) { return s.id === reusablePreferredQuestId; });
            state.scope = preferredQuest ? preferredQuest.id : '';
        }
        if (!state.scope && state.type === 'project' && reusablePreferredProjectId) {
            var preferredProject = scopes.find(function(s) { return s.id === reusablePreferredProjectId; });
            state.scope = preferredProject ? preferredProject.id : '';
        }
        if (!state.scope && state.type === 'scan' && reusablePreferredScanId) {
            var preferredScan = scopes.find(function(s) { return s.id === reusablePreferredScanId; });
            state.scope = preferredScan ? preferredScan.id : '';
        }
        if (!state.scope) {
            state.scope = scopes.length > 0 ? scopes[0].id : '';
        }
        state.file = '';
    }
    scopeSel.innerHTML = '<option value="">(Select)</option>' + scopes.map(function(scope) {
        return '<option value="' + scope.id + '"' + (scope.id === state.scope ? ' selected' : '') + '>' + scope.label + '</option>';
    }).join('');

    var files = filesForSelection(state.type, state.scope);
    var hasFile = files.some(function(f) { return (f.id || '') === state.file; });
    if (!hasFile) {
        state.file = files.length > 0 ? (files[0].id || '') : '';
    }

    fileSel.innerHTML = '<option value="">(File)</option>' + files.map(function(file) {
        var value = file.id || '';
        var label = file.label || value;
        return '<option value="' + value + '"' + (value === state.file ? ' selected' : '') + '>' + label + '</option>';
    }).join('');

    typeSel.disabled = false;
    scopeSel.disabled = !needsScope || scopes.length === 0;
    fileSel.disabled = files.length === 0;
}

function getSelectedReusablePromptId(sectionId) {
    var state = ensureReusablePromptState(sectionId);
    if (!state.file) {
        return '';
    }
    if (state.type === 'global') {
        return 'global::' + state.file;
    }
    if (state.type === 'project') {
        return 'project::' + (state.scope || '') + '::' + state.file;
    }
    if (state.type === 'quest') {
        return 'quest::' + (state.scope || '') + '::' + state.file;
    }
    if (state.type === 'scan') {
        return 'scan::' + (state.scope || '') + '::' + state.file;
    }
    return '';
}

function populateSelect(id, options) {
    var sel = document.getElementById(id);
    if (!sel) return;
    var cur = sel.value;
    var baseOptions = '<option value="">(None)</option>';
    if (id === 'copilot-template') baseOptions += '<option value="__answer_file__">Answer Wrapper</option>';
    sel.innerHTML = baseOptions + (options || []).map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('');
    if (cur && (options && options.includes(cur) || cur === '__answer_file__')) sel.value = cur;
}

function populateEntitySelect(id, options, defaultLabel) {
    var sel = document.getElementById(id);
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = (options || []).map(function(o) {
        var value = (o && typeof o.id === 'string') ? o.id : '';
        var label = (o && typeof o.name === 'string' && o.name) ? o.name : value;
        return '<option value="' + value + '">' + label + '</option>';
    }).join('');
    // Restore previous selection if still available
    if (cur && (options || []).some(function(o) { return o && o.id === cur; })) {
        sel.value = cur;
    } else {
        // Preselect the default entry, or fall back to the first entry
        var defaultOption = (options || []).find(function(o) { return o && o.isDefault; });
        sel.value = defaultOption ? defaultOption.id : ((options && options.length > 0) ? options[0].id : '');
    }
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'profiles') {
        profiles = { localLlm: msg.localLlm || [], conversation: msg.conversation || [], copilot: msg.copilot || [], tomAiChat: msg.tomAiChat || [], anthropic: msg.anthropic || [] };
        configurations = msg.configurations || [];
        setups = msg.setups || [];
        anthropicConfigurations = msg.anthropicConfigurations || [];
        anthropicProfileEntries = msg.anthropicProfileEntries || [];
        anthropicUserMessageTemplates = msg.anthropicUserMessageTemplates || [];
        anthropicApiKeyOk = !!msg.anthropicApiKeyOk;
        claudeCliVisible = !!msg.claudeCliVisible;
        claudeCliOk = (msg.claudeCliOk === true || msg.claudeCliOk === false) ? msg.claudeCliOk : null;
        defaultCopilotTemplate = msg.defaultCopilotTemplate || '';
        populateDropdowns();
        updateDefaultTemplateIndicator();
        updateAnthropicApiKeyDot();
        updateClaudeCliDot();
    } else if (msg.type === 'anthropicClaudeCliStatus') {
        claudeCliOk = !!msg.ok;
        claudeCliVisible = msg.visible !== false;
        updateClaudeCliDot();
    } else if (msg.type === 'anthropicModels') {
        anthropicModels = msg.models || [];
        if (msg.error) {
            setAnthropicStatus('Models unavailable: ' + msg.error);
        } else {
            setAnthropicStatus('');
        }
        populateAnthropicModels();
    } else if (msg.type === 'vscodeLmModels') {
        // Informational — populate the VS Code LM dropdown (spec §4.12).
        // Does NOT retarget sends; the configuration's stored modelId
        // drives sends.
        var vlmSelect = document.getElementById('anthropic-vscodelm-models');
        if (vlmSelect) {
            var vlmList = msg.models || [];
            if (vlmList.length === 0) {
                var emptyMsg = msg.error
                    ? ('(error: ' + msg.error + ')')
                    : ('(' + (msg.hint || 'no models') + ')');
                vlmSelect.innerHTML = '<option value="">' + emptyMsg + '</option>';
                // One-shot retry — Copilot often takes a few seconds to
                // finish activating after VS Code startup. The first
                // query can legitimately return 0 models; try again
                // after a short delay instead of leaving the user with
                // an empty dropdown that requires a manual refresh.
                if (!msg.error && !window._anthropicVsCodeLmRetried) {
                    window._anthropicVsCodeLmRetried = true;
                    setTimeout(function() {
                        vscode.postMessage({ type: 'refreshVsCodeLmModels' });
                    }, 3000);
                }
            } else {
                vlmSelect.innerHTML = '<option value="">(' + vlmList.length + ' models available)</option>' +
                    vlmList.map(function(m) {
                        return '<option value="' + m.id + '">' + m.label + '</option>';
                    }).join('');
            }
        }
    } else if (msg.type === 'anthropicApiKeyStatus') {
        anthropicApiKeyOk = !!msg.ok;
        updateAnthropicApiKeyDot();
        updateAnthropicSendButton();
    } else if (msg.type === 'anthropicStatus') {
        // Handler-driven status text (e.g. "waiting for history
        // compaction…", "Rebuild history from last N prompts…").
        // Only apply while we're actively sending — after a result
        // we want the result's own status line (tool-call summary /
        // session turn count), not a stale "waiting…" entry.
        if (anthropicSending && typeof msg.text === 'string' && msg.text.length > 0) {
            setAnthropicStatus(msg.text);
        }
    } else if (msg.type === 'anthropicResult') {
        anthropicSending = false;
        updateAnthropicSendButton();
        anthropicSessionTurns += 1;
        anthropicLastToolCalls = msg.toolCallCount || 0;
        setAnthropicStatus(buildAnthropicStatusLine(msg.historyMode || ''));
    } else if (msg.type === 'anthropicError') {
        anthropicSending = false;
        updateAnthropicSendButton();
        setAnthropicStatus('Error: ' + (msg.message || 'unknown'));
    } else if (msg.type === 'anthropicToolApproval') {
        showAnthropicApprovalDialog(msg.toolId || '', msg.toolName || '', msg.inputSummary || '');
    } else if (msg.type === 'reusablePrompts') {
        reusablePromptModel = msg.model || { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
        reusablePreferredQuestId = msg.preferredQuestId || '';
        reusablePreferredProjectId = msg.preferredProjectId || '';
        reusablePreferredScanId = msg.preferredScanId || '';
        ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
            populateReusablePromptSelectors(sectionId);
        });
    } else if (msg.type === 'reusablePromptContent') {
        var targetSection = pendingReusableCopySection;
        pendingReusableCopySection = '';
        if (targetSection && msg.content) {
            var targetTextArea = document.getElementById(targetSection + '-text');
            if (targetTextArea) {
                var existing = targetTextArea.value || '';
                targetTextArea.value = msg.content + (existing ? '\\n\\n' + existing : '');
                if (slotEnabledSections.indexOf(targetSection) >= 0) {
                    setSlotText(targetSection, ensureSlotState(targetSection).activeSlot, targetTextArea.value || '');
                }
                saveDrafts();
            }
        }
    } else if (msg.type === 'answerFileStatus') {
        copilotHasAnswer = !!msg.hasAnswer;
        copilotAnswerSlot = msg.answerSlot || 0;
        updateSlotButtonsUI('copilot');
        refreshCopilotAnswerToolbarVisibility();
        var indicator = document.getElementById('copilot-answer-indicator');
        if (indicator && msg.hasAnswer) {
            var slotNo = msg.answerSlot || 1;
            indicator.innerHTML = 'Answer Ready <span class="answer-slot-badge">' + slotNo + '</span>';
        }
    } else if (msg.type === 'autoHideDelay') {
        var select = document.getElementById('copilot-autohide');
        if (select) select.value = String(msg.value || 0);
    } else if (msg.type === 'keepContent') {
        var cb = document.getElementById('copilot-keep-content');
        if (cb) cb.checked = msg.value;
    } else if (msg.type === 'clearCopilotText') {
        var ta = document.getElementById('copilot-text');
        if (ta) {
            ta.value = '';
            setSlotText('copilot', ensureSlotState('copilot').activeSlot, '');
            saveDrafts();
        }
    } else if (msg.type === 'contextData') {
        populateContextPopup(msg);
    } else if (msg.type === 'contextTodoFiles') {
        // Update todoFile and todo dropdowns when quest changes in popup
        var todoFileSel = document.getElementById('ctx-todoFile');
        if (todoFileSel) {
            todoFileSel.innerHTML = '<option value="">(None)</option>' + (msg.todoFiles || []).map(function(f) {
                return '<option value="' + f + '">' + f + '</option>';
            }).join('');
        }
        var todoSel = document.getElementById('ctx-todo');
        if (todoSel) todoSel.innerHTML = '<option value="">(None)</option>';
    } else if (msg.type === 'contextTodosUpdate') {
        // Partial update: only refresh the todo dropdown, leave everything else untouched
        var todoSelPartial = document.getElementById('ctx-todo');
        if (todoSelPartial) {
            todoSelPartial.innerHTML = '<option value="">(None)</option>' + (msg.todos || []).map(function(t) {
                var icon = t.status === 'completed' ? '\u2705' : t.status === 'in-progress' ? '\uD83D\uDD04' : t.status === 'blocked' ? '\u26D4' : '\u2B1C';
                return '<option value="' + t.id + '">' + icon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
            }).join('');
        }
    } else if (msg.type === 'contextSummary') {
        var summaryEl = document.getElementById('copilot-context-summary');
        if (summaryEl) summaryEl.textContent = msg.text || '';
    } else if (msg.type === 'queueAdded') {
        // Clear textarea after successful queue add (respecting keep checkbox)
        var keepCb = document.getElementById('copilot-keep-content');
        if (!keepCb || !keepCb.checked) {
            var ta = document.getElementById('copilot-text');
            if (ta) {
                ta.value = '';
                setSlotText('copilot', ensureSlotState('copilot').activeSlot, '');
            }
        }
        // Flash the send button green briefly
        var sendBtn = document.getElementById('copilot-send-btn');
        if (sendBtn) {
            sendBtn.style.background = 'var(--vscode-charts-green, #388a34)';
            setTimeout(function() { sendBtn.style.background = ''; }, 600);
        }
    } else if (msg.type === 'draftsLoaded') {
        var secs = msg.sections || {};
        ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(s) {
            var d = secs[s];
            if (!d) return;
            var sectionState = ensureSlotState(s);
            if (d.slots && typeof d.slots === 'object') {
                sectionState.slots = d.slots;
            }
            if (d.activeSlot && d.activeSlot >= 1 && d.activeSlot <= 9) {
                sectionState.activeSlot = d.activeSlot;
            }
            var ta = document.getElementById(s + '-text');
            if (ta) {
                var slotText = getSlotText(s, sectionState.activeSlot);
                ta.value = slotText || d.text || '';
            }
            var profileId = s === 'copilot' || s === 'tomAiChat' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            if (sel && d.profile) sel.value = d.profile;
            if (s === 'localLlm') {
                var llmSel = document.getElementById('localLlm-llmConfig');
                if (llmSel && d.llmConfig) {
                    llmSel.value = d.llmConfig;
                }
            }
            if (s === 'conversation') {
                var aiSel = document.getElementById('conversation-aiSetup');
                if (aiSel && d.aiSetup) {
                    aiSel.value = d.aiSetup;
                }
            }
            updateSlotButtonsUI(s);
        });
        // Restore Anthropic-specific state
        var da = secs['anthropic'];
        if (da) {
            var anthrSectionState = ensureSlotState('anthropic');
            if (da.slots && typeof da.slots === 'object') { anthrSectionState.slots = da.slots; }
            if (da.activeSlot && da.activeSlot >= 1 && da.activeSlot <= 9) { anthrSectionState.activeSlot = da.activeSlot; }
            var anthrTa = document.getElementById('anthropic-text');
            if (anthrTa) { anthrTa.value = getSlotText('anthropic', anthrSectionState.activeSlot) || da.text || ''; }
            var anthrProfile = document.getElementById('anthropic-profile');
            if (anthrProfile && da.profile) { anthrProfile.value = da.profile; }
            // (Model + Config dropdowns removed — nothing to restore.)
            var anthrUserMsg = document.getElementById('anthropic-userMessage');
            if (anthrUserMsg && da.userMessageTemplate) { anthrUserMsg.value = da.userMessageTemplate; }
            updateSlotButtonsUI('anthropic');
        }
        refreshCopilotAnswerToolbarVisibility();
        _draftsLoaded = true;
    }
});

function updateDefaultTemplateIndicator() {
    var tplInfo = document.getElementById('copilot-templateInfo');
    if (tplInfo && defaultCopilotTemplate) {
        tplInfo.textContent = 'Default template: ' + defaultCopilotTemplate;
        tplInfo.style.display = 'block';
    } else if (tplInfo) {
        tplInfo.style.display = 'none';
    }
}

function sendCopilotPrompt() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) return;
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'sendCopilot', text: text, template: template, slot: slot });
}

function addCopilotToQueue() {
    var text = document.getElementById('copilot-text');
    text = text ? text.value : '';
    if (!text.trim()) return;
    var template = document.getElementById('copilot-template');
    template = template ? template.value : '';
    var repeat = document.getElementById('copilot-repeat-count');
    repeat = repeat ? repeat.value : '1';
    var repeatCount = Math.max(1, parseInt(String(repeat || '1'), 10) || 1);
    var waitEl = document.getElementById('copilot-answer-wait');
    var answerWaitMinutes = Math.max(0, parseInt(String(waitEl ? waitEl.value : '0'), 10) || 0);
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'addToQueue', text: text, template: template, repeatCount: repeatCount, answerWaitMinutes: answerWaitMinutes, slot: slot });
}

function addAnthropicToQueue() {
    // Spec §4.11 — stage a queue item with transport='anthropic' and
    // pin the active profile + user-message template from this panel's
    // own dropdowns (never inherit from the queue default).
    var text = document.getElementById('anthropic-text');
    text = text ? text.value : '';
    if (!text.trim()) return;
    var profileEl = document.getElementById('anthropic-profile');
    var profileId = profileEl ? profileEl.value : '';
    var templateEl = document.getElementById('anthropic-userMessage');
    var templateName = templateEl ? templateEl.value : '';
    var repeatEl = document.getElementById('anthropic-repeat-count');
    var repeatVal = repeatEl ? repeatEl.value : '1';
    var repeatCount = Math.max(1, parseInt(String(repeatVal || '1'), 10) || 1);
    vscode.postMessage({
        type: 'addToQueue',
        text: text,
        template: templateName,
        repeatCount: repeatCount,
        transport: 'anthropic',
        anthropicProfileId: profileId,
    });
}

function openContextPopup() {
    var overlay = document.getElementById('copilot-context-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        vscode.postMessage({ type: 'getContextData' });
    }
}

function closeContextPopup() {
    var overlay = document.getElementById('copilot-context-overlay');
    if (overlay) overlay.style.display = 'none';
}

function populateContextPopup(data) {
    // Quest picker
    var questSel = document.getElementById('ctx-quest');
    if (questSel) {
        questSel.innerHTML = '<option value="">(None)</option>' + (data.quests || []).map(function(q) {
            return '<option value="' + q + '"' + (q === data.currentQuest ? ' selected' : '') + '>' + q + '</option>';
        }).join('');
    }
    // Role selector
    var roleSel = document.getElementById('ctx-role');
    if (roleSel) {
        roleSel.innerHTML = '<option value="">(None)</option>' + (data.roles || []).map(function(r) {
            return '<option value="' + r + '"' + (r === data.currentRole ? ' selected' : '') + '>' + r + '</option>';
        }).join('');
    }
    // Project multi-select
    var projSel = document.getElementById('ctx-projects');
    if (projSel) {
        var activeProjects = data.activeProjects || [];
        projSel.innerHTML = (data.projects || []).map(function(p) {
            return '<option value="' + p + '"' + (activeProjects.includes(p) ? ' selected' : '') + '>' + p + '</option>';
        }).join('');
    }
    // Todo file picker
    var todoFileSel = document.getElementById('ctx-todoFile');
    if (todoFileSel) {
        todoFileSel.innerHTML = '<option value="">(None)</option>' + (data.todoFiles || []).map(function(f) {
            return '<option value="' + f + '"' + (f === data.currentTodoFile ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
    }
    // Todo selector
    var todoSel = document.getElementById('ctx-todo');
    if (todoSel) {
        todoSel.innerHTML = '<option value="">(None)</option>' + (data.todos || []).map(function(t) {
            var icon = t.status === 'completed' ? '\\u2705' : t.status === 'in-progress' ? '\\uD83D\\uDD04' : t.status === 'blocked' ? '\\u26D4' : '\\u2B1C';
            return '<option value="' + t.id + '"' + (t.id === data.currentTodo ? ' selected' : '') + '>' + icon + ' ' + t.id + ': ' + (t.title || t.description || '').substring(0, 40) + '</option>';
        }).join('');
    }
}

function applyContextPopup() {
    var questSel = document.getElementById('ctx-quest');
    var roleSel = document.getElementById('ctx-role');
    var projSel = document.getElementById('ctx-projects');
    var todoFileSel = document.getElementById('ctx-todoFile');
    var todoSel = document.getElementById('ctx-todo');

    var selectedProjects = [];
    if (projSel) {
        for (var i = 0; i < projSel.options.length; i++) {
            if (projSel.options[i].selected) selectedProjects.push(projSel.options[i].value);
        }
    }

    vscode.postMessage({
        type: 'applyContext',
        quest: questSel ? questSel.value : '',
        role: roleSel ? roleSel.value : '',
        activeProjects: selectedProjects,
        todoFile: todoFileSel ? todoFileSel.value : '',
        todo: todoSel ? todoSel.value : ''
    });
    closeContextPopup();
}

function initCopilotSection() {
    var autohideSelect = document.getElementById('copilot-autohide');
    if (autohideSelect) {
        autohideSelect.addEventListener('change', function() {
            vscode.postMessage({ type: 'setAutoHideDelay', value: parseInt(this.value, 10) });
        });
    }
    var keepContentCb = document.getElementById('copilot-keep-content');
    if (keepContentCb) {
        keepContentCb.addEventListener('change', function() {
            vscode.postMessage({ type: 'setKeepContent', value: this.checked });
        });
    }
    // When popup todo file changes, request todos for that file
    var todoFileSel = document.getElementById('ctx-todoFile');
    if (todoFileSel) {
        todoFileSel.addEventListener('change', function() {
            vscode.postMessage({ type: 'getTodosForFile', file: this.value });
        });
    }
    // When popup quest changes, re-fetch todoFiles and todos for new quest
    var questSel = document.getElementById('ctx-quest');
    if (questSel) {
        questSel.addEventListener('change', function() {
            vscode.postMessage({ type: 'getContextDataForQuest', quest: this.value });
        });
    }
}

function initReusablePromptSelectors() {
    ['localLlm', 'conversation', 'copilot', 'tomAiChat', 'anthropic'].forEach(function(sectionId) {
        var typeSel = document.getElementById(sectionId + '-reusable-type');
        if (typeSel) {
            typeSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.type = typeSel.value || '';
                state.scope = '';
                state.file = '';
                // Re-fetch from disk so newly added files appear
                vscode.postMessage({ type: 'getReusablePrompts' });
            });
        }

        var scopeSel = document.getElementById(sectionId + '-reusable-scope');
        if (scopeSel) {
            scopeSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.scope = scopeSel.value || '';
                state.file = '';
                // Re-fetch from disk so newly added files appear
                vscode.postMessage({ type: 'getReusablePrompts' });
            });
        }

        var fileSel = document.getElementById(sectionId + '-reusable-file');
        if (fileSel) {
            fileSel.addEventListener('change', function() {
                var state = ensureReusablePromptState(sectionId);
                state.file = fileSel.value || '';
            });
        }
    });
}

loadState();
render();
initCopilotSection();
initReusablePromptSelectors();
vscode.postMessage({ type: 'getProfiles' });
vscode.postMessage({ type: 'getReusablePrompts' });
vscode.postMessage({ type: 'getAutoHideDelay' });
vscode.postMessage({ type: 'getKeepContent' });
vscode.postMessage({ type: 'checkAnswerFile' });
vscode.postMessage({ type: 'getContextSummary' });
vscode.postMessage({ type: 'loadDrafts' });

// Guard: do not persist drafts until the initial load has completed.
var _draftsLoaded = false;

// Draft auto-save (debounced, every 1s of inactivity)
var _draftSaveTimer = null;
function saveDrafts() {
    if (!_draftsLoaded) return;
    clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(function() {
        var drafts = {};
        ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(s) {
            var ta = document.getElementById(s + '-text');
            var profileId = s === 'copilot' || s === 'tomAiChat' ? s + '-template' : s + '-profile';
            var sel = document.getElementById(profileId);
            var sectionState = ensureSlotState(s);
            var llmSel = document.getElementById('localLlm-llmConfig');
            var aiSel = document.getElementById('conversation-aiSetup');
            if (ta) {
                setSlotText(s, sectionState.activeSlot, ta.value || '');
            }
            drafts[s] = {
                text: ta ? ta.value : '',
                profile: sel ? sel.value : '',
                llmConfig: s === 'localLlm' && llmSel ? llmSel.value : '',
                aiSetup: s === 'conversation' && aiSel ? aiSel.value : '',
                activeSlot: sectionState.activeSlot,
                slots: sectionState.slots,
            };
        });
        // Anthropic section — save Anthropic-specific dropdowns in addition to the standard fields
        var anthrTa = document.getElementById('anthropic-text');
        var anthrSectionState = ensureSlotState('anthropic');
        if (anthrTa) { setSlotText('anthropic', anthrSectionState.activeSlot, anthrTa.value || ''); }
        var anthrProfile = document.getElementById('anthropic-profile');
        var anthrUserMsg = document.getElementById('anthropic-userMessage');
        drafts['anthropic'] = {
            text: anthrTa ? anthrTa.value : '',
            profile: anthrProfile ? anthrProfile.value : '',
            userMessageTemplate: anthrUserMsg ? anthrUserMsg.value : '',
            activeSlot: anthrSectionState.activeSlot,
            slots: anthrSectionState.slots,
        };
        vscode.postMessage({ type: 'saveDrafts', drafts: drafts });
    }, 1000);
}
// Attach save to all textareas and dropdowns
['localLlm-text', 'conversation-text', 'copilot-text', 'tomAiChat-text', 'anthropic-text'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', saveDrafts);
});
['localLlm-profile', 'conversation-profile', 'copilot-template', 'tomAiChat-template', 'anthropic-profile'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', saveDrafts);
});
['localLlm-llmConfig', 'conversation-aiSetup', 'anthropic-userMessage'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', saveDrafts);
});
`;
    }

    /* FULL_ORIGINAL_START
    private _getHtmlContent(): string {
        return \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>@CHAT Panel</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-panel-background);
            height: 100vh;
            display: flex;
            flex-direction: row;
            overflow: hidden;
        }
        
        .accordion-container {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        
        .accordion-section {
            display: flex;
            flex-direction: column;
            border-right: 1px solid var(--vscode-panel-border);
            overflow: hidden;
        }
        .accordion-section:last-child { border-right: none; }
        
        .accordion-section.collapsed {
            flex: 0 0 18px;
            width: 18px;
        }
        .accordion-section.collapsed .section-content { display: none; }
        .accordion-section.collapsed .header-expanded { display: none; }
        .accordion-section.collapsed .header-collapsed { display: flex; }
        
        .accordion-section.expanded {
            flex: 1 1 auto;
            min-width: 120px;
        }
        .accordion-section.expanded .section-content { display: flex; }
        .accordion-section.expanded .header-expanded { display: flex; }
        .accordion-section.expanded .header-collapsed { display: none; }
        
        .resize-handle {
            flex: 0 0 4px;
            width: 4px;
            background: transparent;
            cursor: col-resize;
            transition: background 0.1s;
        }
        .resize-handle:hover, .resize-handle.dragging {
            background: var(--vscode-focusBorder);
        }
        
        .header-expanded {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 2px 10px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            cursor: pointer;
            white-space: nowrap;
        }
        .header-expanded:hover { background: var(--vscode-list-hoverBackground); }
        .header-expanded .arrow { font-size: 11px; }
        .header-expanded .icon { font-size: 16px; }
        .header-expanded .title { font-size: 13px; font-weight: 500; text-transform: uppercase; }
        .header-expanded .pin-btn {
            margin-left: auto;
            opacity: 0.3;
            cursor: pointer;
            background: none;
            border: none;
            font-size: 13px;
            color: var(--vscode-foreground);
            padding: 3px 5px;
        }
        .header-expanded .pin-btn:hover { opacity: 0.7; }
        .header-expanded .pin-btn.pinned { opacity: 1; }
        
        .header-collapsed {
            writing-mode: vertical-lr;
            display: none;
            align-items: center;
            padding: 8px 4px 8px 2px;
            background: var(--vscode-sideBarSectionHeader-background);
            cursor: pointer;
            white-space: nowrap;
            height: 100%;
        }
        .header-collapsed:hover { background: var(--vscode-list-hoverBackground); }
        .header-collapsed .arrow { font-size: 11px; margin-bottom: 6px; }
        .header-collapsed .icon { font-size: 16px; margin-bottom: 11px; }
        .header-collapsed .title { font-size: 13px; font-weight: 500; text-transform: uppercase; }
        
        .section-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            padding: 8px;
            gap: 6px;
            overflow: hidden;
        }
        
        .toolbar { display: flex; flex-direction: column; gap: 6px; }
        .toolbar-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .toolbar-row label { font-size: 13px; min-width: 55px; }
        .toolbar-row select {
            flex: 1;
            padding: 4px 6px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
            font-size: 13px;
            min-width: 80px;
            max-width: 150px;
        }
        .toolbar-row button {
            padding: 4px 10px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
        }
        .toolbar-row button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .toolbar-row button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .toolbar-row button.primary:hover { background: var(--vscode-button-hoverBackground); }
        .icon-btn { padding: 4px 8px; font-size: 14px; }
        .icon-btn.danger { color: var(--vscode-errorForeground); }
        .answers-toolbar { background: rgba(200, 170, 0, 0.15); border: 1px solid rgba(200, 170, 0, 0.4); border-radius: 4px; padding: 4px 8px !important; }
        .answer-indicator { font-size: 12px; font-weight: 600; color: var(--vscode-editorWarning-foreground, #cca700); margin-right: 8px; }
        .profile-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 8px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
            margin-top: 4px;
            max-height: 60px;
            overflow-y: auto;
        }
        
        textarea {
            flex: 1;
            min-height: 50px;
            resize: none;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
        
        .status-bar { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .placeholder-help { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
        .placeholder-help code { background: var(--vscode-textCodeBlock-background); padding: 1px 3px; border-radius: 2px; }
    </style>
</head>
<body>
    <div class="accordion-container" id="container">Loading T2...</div>
    
    <script>
        (function() { document.getElementById('container').textContent = 'Step 1: Script started'; })();
        window.onerror = function(msg, url, line, col, err) {
            var c = document.getElementById('container');
            if (c) c.innerHTML = '<div style="color:red;padding:10px;white-space:pre-wrap;">JS Error: ' + msg + '\\nLine: ' + line + ', Col: ' + col + '</div>';
        };
        (function() { document.getElementById('container').textContent = 'Step 2: After onerror'; })();
        const vscode = acquireVsCodeApi();
        (function() { document.getElementById('container').textContent = 'Step 3: After vscode'; })();
        const sectionsConfig = [
            { id: 'guidelines', icon: '📋', title: 'Guidelines' },
            { id: 'notes', icon: '📝', title: 'Documentation' },
            { id: 'localLlm', icon: '🤖', title: 'Local LLM' },
            { id: 'conversation', icon: '💬', title: 'Conversation' },
            { id: 'copilot', icon: '✨', title: 'Copilot' },
            { id: 'tomAiChat', icon: '🗨️', title: 'Tom AI' }
        ];
        (function() { document.getElementById('container').textContent = 'Step 4: After sectionsConfig'; })();
        
        let state = { expanded: ['localLlm'], pinned: [] };
        let profiles = { localLlm: [], conversation: [], copilot: [], tomAiChat: [] };
        (function() { document.getElementById('container').textContent = 'Step 5: After state/profiles'; })();
        
        function loadState() {
            try {
                const s = vscode.getState();
                if (s && s.expanded && Array.isArray(s.expanded)) {
                    state.expanded = s.expanded;
                }
                if (s && s.pinned && Array.isArray(s.pinned)) {
                    state.pinned = s.pinned;
                }
            } catch(e) {}
        }
        
        function saveState() {
            vscode.setState(state);
        }
        
        function isExpanded(id) { return state.expanded && state.expanded.includes(id); }
        function isPinned(id) { return state.pinned && state.pinned.includes(id); }
        
        function toggleSection(id) {
            if (isExpanded(id)) {
                // Always allow manual close, even if pinned
                state.expanded = state.expanded.filter(s => s !== id);
            } else {
                state.expanded.push(id);
                // Auto-collapse only non-pinned sections
                sectionsConfig.forEach(sec => {
                    if (sec.id !== id && !isPinned(sec.id)) {
                        state.expanded = state.expanded.filter(s => s !== sec.id);
                    }
                });
            }
            if (state.expanded.length === 0) state.expanded = [id];
            saveState();
            render();
        }
        
        function togglePin(id, e) {
            e.stopPropagation();
            const idx = state.pinned.indexOf(id);
            if (idx >= 0) {
                state.pinned.splice(idx, 1);
            } else {
                state.pinned.push(id);
                if (!isExpanded(id)) state.expanded.push(id);
            }
            saveState();
            render();
        }
        
        function getSectionContent(id) {
            const contents = {
                guidelines: '<div class="toolbar"><div class="toolbar-row"><button data-action="reload" data-id="guidelines">Reload</button><button data-action="open" data-id="guidelines">Open</button></div></div><div style="flex:1;overflow:auto;font-size:11px;color:var(--vscode-descriptionForeground);">Guidelines panel - coming soon</div>',
                notes: '<div class="toolbar"><div class="toolbar-row"><button data-action="reload" data-id="notes">Reload</button><button data-action="addNote">Add</button><button data-action="open" data-id="notes">Open</button></div></div><textarea id="notes-text" placeholder="Documentation..." readonly></textarea>',
                localLlm: '<div class="toolbar"><div class="toolbar-row"><label>Profile:</label><select id="localLlm-profile"><option value="">(None)</option></select><button class="icon-btn" data-action="addProfile" data-id="localLlm" title="Add Profile">+</button><button class="icon-btn" data-action="editProfile" data-id="localLlm" title="Edit Profile">✏️</button><button class="icon-btn danger" data-action="deleteProfile" data-id="localLlm" title="Delete Profile">🗑️</button></div><div class="toolbar-row"><button data-action="preview" data-id="localLlm">Preview</button><button class="primary" data-action="send" data-id="localLlm">Send to LLM</button><button data-action="trail" data-id="localLlm">📜 Trail</button></div></div><div id="localLlm-profileInfo" class="profile-info" style="display:none;"></div><textarea id="localLlm-text" placeholder="Enter your prompt for the local LLM..." data-input="localLlm"></textarea><div class="status-bar"><span id="localLlm-charCount">0 chars</span></div>',
                conversation: '<div class="toolbar"><div class="toolbar-row"><label>Profile:</label><select id="conversation-profile"><option value="">(None)</option></select><button class="icon-btn" data-action="addProfile" data-id="conversation" title="Add Profile">+</button><button class="icon-btn" data-action="editProfile" data-id="conversation" title="Edit Profile">✏️</button><button class="icon-btn danger" data-action="deleteProfile" data-id="conversation" title="Delete Profile">🗑️</button></div><div class="toolbar-row"><button data-action="preview" data-id="conversation">Preview</button><button class="primary" data-action="send" data-id="conversation">Start Conversation</button><button class="icon-btn placeholder-help-btn" title="Show Placeholder Help" style="margin-left:auto;">?</button></div></div><div id="conversation-profileInfo" class="profile-info" style="display:none;"></div><textarea id="conversation-text" placeholder="Enter your goal/description for the conversation..." data-input="conversation"></textarea><div class="status-bar"><span id="conversation-charCount">0 chars</span></div>',
                copilot: '<div class="toolbar"><div class="toolbar-row"><label>Template:</label><select id="copilot-template"><option value="">(None)</option><option value="__answer_file__">Answer Wrapper</option></select><button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add Template">+</button><button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit Template">✏️</button><button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete Template">🗑️</button></div><div class="toolbar-row"><button data-action="preview" data-id="copilot">Preview</button><button class="primary" data-action="send" data-id="copilot">Send to Copilot</button><label style="margin-left:8px;">Auto-hide:</label><select id="copilot-autohide"><option value="0">Keep</option><option value="1000">1s</option><option value="5000">5s</option><option value="10000">10s</option></select><button class="icon-btn" data-action="openTrailFiles" data-id="copilot" title="Open Trail" style="margin-left:4px;">📜</button><button class="icon-btn" data-action="openTrailViewer" data-id="copilot" title="Open Trail Files Viewer" style="margin-left:4px;">📋</button><label style="margin-left:4px;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="copilot-keep-content"> Keep</label></div></div><div class="toolbar answers-toolbar" id="copilot-answers-toolbar" style="display:none;"><span id="copilot-answer-indicator" class="answer-indicator">Answer Ready</span><button class="icon-btn" data-action="showAnswerViewer" data-id="copilot" title="View Answer">👁️</button><button class="icon-btn" data-action="extractAnswer" data-id="copilot" title="Extract to Markdown">📄</button></div><div id="copilot-templateInfo" class="profile-info" style="display:none;"></div><textarea id="copilot-text" placeholder="Enter your prompt... The prefix/suffix of the selected template will wrap this content." data-input="copilot"></textarea><div class="status-bar"><span id="copilot-charCount">0 chars</span></div>',
                tomAiChat: '<div class="toolbar"><div class="toolbar-row"><label>Template:</label><select id="tomAiChat-template"><option value="">(None)</option></select><button class="icon-btn" data-action="addTemplate" data-id="tomAiChat" title="Add Template">+</button><button class="icon-btn" data-action="editTemplate" data-id="tomAiChat" title="Edit Template">✏️</button><button class="icon-btn danger" data-action="deleteTemplate" data-id="tomAiChat" title="Delete Template">🗑️</button></div><div class="toolbar-row"><button data-action="openChatFile" data-id="tomAiChat">Open Chat</button><button data-action="preview" data-id="tomAiChat">Preview</button><button class="primary" data-action="insertToChatFile" data-id="tomAiChat">Insert</button><button class="icon-btn placeholder-help-btn" title="Show Placeholder Help" style="margin-left:auto;">?</button></div></div><div id="tomAiChat-templateInfo" class="profile-info" style="display:none;"></div><textarea id="tomAiChat-text" placeholder="Enter your prompt for Tom AI Chat..." data-input="tomAiChat"></textarea><div class="status-bar"><span id="tomAiChat-charCount">0 chars</span></div>'
            };
            return contents[id] || '<div>Unknown section</div>';
        }
        
        function render() {
            const container = document.getElementById('container');
            let html = '';
            
            // Find nearest expanded section to the left of index i
            function findExpandedLeft(i) {
                for (let j = i - 1; j >= 0; j--) {
                    if (isExpanded(sectionsConfig[j].id)) return sectionsConfig[j].id;
                }
                return null;
            }
            
            // Find nearest expanded section to the right of index i
            function findExpandedRight(i) {
                for (let j = i + 1; j < sectionsConfig.length; j++) {
                    if (isExpanded(sectionsConfig[j].id)) return sectionsConfig[j].id;
                }
                return null;
            }
            
            sectionsConfig.forEach((sec, idx) => {
                const exp = isExpanded(sec.id);
                const pin = isPinned(sec.id);
                // Add resize handle if this expanded section has an expanded one to its left
                if (exp) {
                    const leftExpanded = findExpandedLeft(idx);
                    if (leftExpanded) {
                        html += '<div class="resize-handle" data-resize-left="' + leftExpanded + '" data-resize-right="' + sec.id + '"></div>';
                    }
                } else {
                    // For collapsed sections, add handle on left side if there are expanded on both sides
                    const leftExpanded = findExpandedLeft(idx);
                    const rightExpanded = findExpandedRight(idx);
                    if (leftExpanded && rightExpanded) {
                        html += '<div class="resize-handle" data-resize-left="' + leftExpanded + '" data-resize-right="' + rightExpanded + '"></div>';
                    }
                }
                html += '<div class="accordion-section ' + (exp ? 'expanded' : 'collapsed') + '" data-section="' + sec.id + '">';
                html += '<div class="header-expanded" data-toggle="' + sec.id + '">';
                html += '<span class="arrow">' + (exp ? '▶' : '▼') + '</span>';
                html += '<span class="icon">' + sec.icon + '</span>';
                html += '<span class="title">' + sec.title + '</span>';
                html += '<button class="pin-btn ' + (pin ? 'pinned' : '') + '" data-pin="' + sec.id + '" title="' + (pin ? 'Unpin' : 'Pin') + '">📌</button>';
                html += '</div>';
                html += '<div class="header-collapsed" data-toggle="' + sec.id + '">';
                html += '<span class="arrow">▼</span>';
                html += '<span class="icon">' + sec.icon + '</span>';
                html += '<span class="title">' + sec.title + '</span>';
                html += '</div>';
                html += '<div class="section-content">' + getSectionContent(sec.id) + '</div>';
                html += '</div>';
            });
            container.innerHTML = html;
            attachEventListeners();
            populateDropdowns();
        }
        
        function attachEventListeners() {
            // Toggle sections
            document.querySelectorAll('[data-toggle]').forEach(el => {
                el.addEventListener('click', () => toggleSection(el.dataset.toggle));
            });
            // Pin buttons
            document.querySelectorAll('[data-pin]').forEach(el => {
                el.addEventListener('click', (e) => togglePin(el.dataset.pin, e));
            });
            // Action buttons
            document.querySelectorAll('[data-action]').forEach(el => {
                el.addEventListener('click', () => handleAction(el.dataset.action, el.dataset.id));
            });
            // Textarea input for char count
            document.querySelectorAll('[data-input]').forEach(el => {
                el.addEventListener('input', () => updateCharCount(el.dataset.input));
            });
            // Resize handles
            document.querySelectorAll('.resize-handle').forEach(handle => {
                handle.addEventListener('mousedown', (e) => startResize(e, handle));
            });
        }
        
        let resizing = null;
        
        function startResize(e, handle) {
            e.preventDefault();
            const leftId = handle.dataset.resizeLeft;
            const rightId = handle.dataset.resizeRight;
            const leftEl = document.querySelector('[data-section="' + leftId + '"]');
            const rightEl = document.querySelector('[data-section="' + rightId + '"]');
            if (!leftEl || !rightEl) return;
            
            handle.classList.add('dragging');
            resizing = {
                handle: handle,
                leftEl: leftEl,
                rightEl: rightEl,
                startX: e.clientX,
                leftWidth: leftEl.offsetWidth,
                rightWidth: rightEl.offsetWidth
            };
            
            document.addEventListener('mousemove', doResize);
            document.addEventListener('mouseup', stopResize);
        }
        
        function doResize(e) {
            if (!resizing) return;
            const dx = e.clientX - resizing.startX;
            const newLeftWidth = Math.max(120, resizing.leftWidth + dx);
            const newRightWidth = Math.max(120, resizing.rightWidth - dx);
            resizing.leftEl.style.flex = '0 0 ' + newLeftWidth + 'px';
            resizing.rightEl.style.flex = '0 0 ' + newRightWidth + 'px';
        }
        
        function stopResize() {
            if (resizing) {
                resizing.handle.classList.remove('dragging');
                resizing = null;
            }
            document.removeEventListener('mousemove', doResize);
            document.removeEventListener('mouseup', stopResize);
        }
        
        function handleAction(action, id) {
            switch(action) {
                case 'send': {
                    const text = document.getElementById(id + '-text')?.value || '';
                    if (!text.trim()) return;
                    const profile = document.getElementById(id + '-profile')?.value || '';
                    const template = document.getElementById(id + '-template')?.value || '';
                    vscode.postMessage({ type: 'send' + id.charAt(0).toUpperCase() + id.slice(1), text, profile, template });
                    break;
                }
                case 'preview': {
                    const prvText = document.getElementById(id + '-text')?.value || '';
                    const prvTpl = document.getElementById(id + '-template')?.value || '';
                    vscode.postMessage({ type: 'preview', section: id, text: prvText, template: prvTpl });
                    break;
                }
                case 'trail':
                    vscode.postMessage({ type: 'showTrail', section: id });
                    break;
                case 'cancel':
                    vscode.postMessage({ type: 'cancel', section: id });
                    break;
                case 'reload':
                    vscode.postMessage({ type: 'reload', section: id });
                    break;
                case 'open':
                    vscode.postMessage({ type: 'openInEditor', section: id });
                    break;
                case 'addNote':
                    vscode.postMessage({ type: 'addNote' });
                    break;
                case 'addProfile':
                    vscode.postMessage({ type: 'addProfile', section: id });
                    break;
                case 'editProfile': {
                    const epSel = document.getElementById(id + '-profile');
                    vscode.postMessage({ type: 'editProfile', section: id, name: epSel?.value || '' });
                    break;
                }
                case 'addTemplate':
                    vscode.postMessage({ type: 'addTemplate', section: id });
                    break;
                case 'editTemplate': {
                    const etSel = document.getElementById(id + '-template');
                    const etVal = etSel?.value || '';
                    vscode.postMessage({ type: 'editTemplate', section: id, name: etVal });
                    break;
                }
                case 'deleteProfile':
                    confirmDelete('profile', id);
                    break;
                case 'deleteTemplate': {
                    const dtSel = document.getElementById(id + '-template');
                    const dtVal = dtSel?.value || '';
                    if (dtVal === '__answer_file__') {
                        vscode.postMessage({ type: 'showMessage', message: 'The Answer File template is built-in and cannot be deleted.' });
                        return;
                    }
                    confirmDelete('template', id);
                    break;
                }
                case 'openChatFile':
                    vscode.postMessage({ type: 'openChatFile' });
                    break;
                case 'insertToChatFile': {
                    const insertText = document.getElementById(id + '-text')?.value || '';
                    if (!insertText.trim()) return;
                    const insertTemplate = document.getElementById(id + '-template')?.value || '';
                    vscode.postMessage({ type: 'insertToChatFile', text: insertText, template: insertTemplate });
                    break;
                }
                case 'showAnswerViewer':
                    vscode.postMessage({ type: 'showAnswerViewer' });
                    break;
                case 'extractAnswer':
                    vscode.postMessage({ type: 'extractAnswer' });
                    break;
                case 'openPromptsFile':
                    vscode.postMessage({ type: 'openPromptsFile' });
                    break;
                case 'openTrailFiles':
                    vscode.postMessage({ type: 'openTrailFiles', section: id || '' });
                    break;
                case 'openTrailViewer':
                    vscode.postMessage({ type: 'openTrailViewer', section: id || '' });
                    break;
            }
        }
        
        function confirmDelete(itemType, sectionId) {
            const selectId = sectionId + '-' + itemType;
            const sel = document.getElementById(selectId);
            const selectedValue = sel?.value;
            if (!selectedValue) {
                vscode.postMessage({ type: 'showMessage', message: 'Please select a ' + itemType + ' to delete.' });
                return;
            }
            // Send directly to extension - VS Code will show its own confirmation dialog
            vscode.postMessage({ type: 'delete' + itemType.charAt(0).toUpperCase() + itemType.slice(1), section: sectionId, name: selectedValue });
        }
        
        function populateDropdowns() {
            populateSelect('localLlm-profile', profiles.localLlm);
            populateSelect('conversation-profile', profiles.conversation);
            populateSelect('copilot-template', profiles.copilot);
            populateSelect('tomAiChat-template', profiles.tomAiChat);
        }
        
        function populateSelect(id, options) {
            const sel = document.getElementById(id);
            if (!sel) return;
            const cur = sel.value;
            let baseOptions = '<option value="">(None)</option>';
            if (id === 'copilot-template') baseOptions += '<option value="__answer_file__">Answer Wrapper</option>';
            sel.innerHTML = baseOptions + (options || []).map(o => '<option value="' + o + '">' + o + '</option>').join('');
            if (cur && (options && options.includes(cur) || cur === '__answer_file__')) sel.value = cur;
        }
        
        function updateCharCount(id) {
            const ta = document.getElementById(id + '-text');
            const cc = document.getElementById(id + '-charCount');
            if (ta && cc) cc.textContent = ta.value.length + ' chars';
        }
        
        window.addEventListener('message', e => {
            const msg = e.data;
            if (msg.type === 'profiles') {
                profiles = { localLlm: msg.localLlm || [], conversation: msg.conversation || [], copilot: msg.copilot || [], tomAiChat: msg.tomAiChat || [] };
                populateDropdowns();
            } else if (msg.type === 'answerFileStatus') {
                var toolbar = document.getElementById('copilot-answers-toolbar');
                if (toolbar) toolbar.style.display = msg.exists ? 'flex' : 'none';
            } else if (msg.type === 'autoHideDelay') {
                var select = document.getElementById('copilot-autohide');
                if (select) select.value = String(msg.value || 0);
            } else if (msg.type === 'keepContent') {
                var cb = document.getElementById('copilot-keep-content');
                if (cb) cb.checked = msg.value;
            } else if (msg.type === 'clearCopilotText') {
                var ta = document.getElementById('copilot-text');
                if (ta) { ta.value = ''; updateCharCount('copilot'); }
            }
        });
        
        function initCopilotSection() {
            var autohideSelect = document.getElementById('copilot-autohide');
            if (autohideSelect) {
                autohideSelect.addEventListener('change', function() {
                    vscode.postMessage({ type: 'setAutoHideDelay', value: parseInt(this.value, 10) });
                });
            }
            var keepContentCb = document.getElementById('copilot-keep-content');
            if (keepContentCb) {
                keepContentCb.addEventListener('change', function() {
                    vscode.postMessage({ type: 'setKeepContent', value: this.checked });
                });
            }
        }
        
        (function() { document.getElementById('container').textContent = 'Step 6: Before init try'; })();
        try {
            (function() { document.getElementById('container').textContent = 'Step 7: Inside try'; })();
            loadState();
            (function() { document.getElementById('container').textContent = 'Step 8: After loadState'; })();
            render();
            (function() { document.getElementById('container').textContent = 'Step 9: After render'; })();
            initCopilotSection();
            vscode.postMessage({ type: 'getProfiles' });
            vscode.postMessage({ type: 'getAutoHideDelay' });
            vscode.postMessage({ type: 'getKeepContent' });
            vscode.postMessage({ type: 'checkAnswerFile' });
        } catch(err) {
            var errMsg = (err && err.message) ? err.message : String(err);
            document.getElementById('container').innerHTML = '<div style="color:red;padding:10px;white-space:pre-wrap;">Init Error: ' + errMsg + '</div>';
        }
    </script>
</body>
</html>\`;
    }
    FULL_ORIGINAL_END */
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

