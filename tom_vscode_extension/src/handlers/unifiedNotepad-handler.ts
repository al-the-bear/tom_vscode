/**
 * Unified Notepad Panel (T2)
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
import { getConfigPath, SendToChatConfig, loadSendToChatConfig, saveSendToChatConfig, PLACEHOLDER_HELP, showPreviewPanel, getWorkspaceRoot, updateChatResponseValues, applyDefaultTemplate, getCopilotChatAnswerFolderAbsolute, DEFAULT_ANSWER_FILE_TEMPLATE, reportException, escapeHtml, openInExternalApplication } from './handler_shared';
import { openGlobalTemplateEditor, TemplateCategory } from './globalTemplateEditor-handler';
import { openReusablePromptEditor } from './reusablePromptEditor-handler';
import { debugLog } from '../utils/debugLogger';
import { expandTemplate } from './promptTemplate';
import { getPromptExpanderManager } from './expandPrompt-handler';
import { getAccordionStyles } from './accordionPanel';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { WsPaths } from '../utils/workspacePaths';
import { validateStrictAiConfiguration } from '../utils/sendToChatConfig';
import { findNearestDetectedProject, scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';

// ============================================================================
// Answer File Utilities (for Copilot answer file feature)
// ============================================================================

/** Get a short window identifier: first 8 chars of sessionId + first 8 of machineId. */
function getWindowId(): string {
    const session = vscode.env.sessionId.substring(0, 8);
    const machine = vscode.env.machineId.substring(0, 8);
    return `${session}_${machine}`;
}

/** Get the answer file path for the current window. */
function getAnswerFilePath(): string {
    const folder = getCopilotChatAnswerFolderAbsolute();
    return path.join(folder, `${getWindowId()}_answer.json`);
}

function isAnswerJsonFilename(filename: string | null | undefined): boolean {
    if (!filename) {
        return false;
    }
    return filename.endsWith('_answer.json');
}

/** Generate a UUID-based request identifier (8-char hex prefix + 8-char hex suffix). */
function generateRequestId(): string {
    // Use short UUID format: xxxxxxxx_xxxxxxxx (16 hex chars)
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}_${hex()}`;
}

/** Check if answer file exists. */
function answerFileExists(): boolean {
    return fs.existsSync(getAnswerFilePath());
}

/** Delete the answer file. */
function deleteAnswerFile(): void {
    const filePath = getAnswerFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

/** Read and parse the answer file. Returns undefined if not found/invalid. */
function readAnswerFile(): { requestId: string; generatedMarkdown: string; comments?: string; references?: string[]; requestedAttachments?: string[]; responseValues?: Record<string, string> } | undefined {
    const filePath = getAnswerFilePath();
    if (!fs.existsSync(filePath)) return undefined;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return undefined;
    }
}

/** Get the copilot answers markdown file path. */
function getCopilotAnswersMdPath(): string {
    const config = loadSendToChatConfig();
    const wsRoot = getWorkspaceRoot();
    const basePath = config?.copilotAnswerPath || WsPaths.aiRelative('copilot');
    const fullBase = wsRoot ? path.join(wsRoot, basePath) : WsPaths.home('copilotAnswers');
    return path.join(fullBase, getWindowId(), 'copilot-answer.md');
}

/** Get the copilot prompts markdown file path. */
function getCopilotPromptsPath(): string {
    const config = loadSendToChatConfig();
    const wsRoot = getWorkspaceRoot();
    const basePath = config?.copilotAnswerPath || WsPaths.aiRelative('copilot');
    const fullBase = wsRoot ? path.join(wsRoot, basePath) : WsPaths.home('copilotPrompts');
    return path.join(fullBase, getWindowId(), 'copilot-prompts.md');
}

/** Get the copilot answers markdown file path. */
function getCopilotAnswersPath(): string {
    const config = loadSendToChatConfig();
    const wsRoot = getWorkspaceRoot();
    const basePath = config?.copilotAnswerPath || WsPaths.aiRelative('copilot');
    const fullBase = wsRoot ? path.join(wsRoot, basePath) : WsPaths.home('copilotAnswers');
    return path.join(fullBase, getWindowId(), 'copilot-answers.md');
}

/** Log a prompt to the copilot-prompts.md file (prepended at top). */
function logCopilotPrompt(prompt: string, template: string): void {
    const promptsPath = getCopilotPromptsPath();
    const dir = path.dirname(promptsPath);
    
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Format the entry
    const timestamp = new Date().toISOString();
    const templateLabel = template || '(none)';
    const entry = `## ${timestamp}\n\n**Template:** ${templateLabel}\n\n${prompt}\n\n---\n\n`;
    
    // Read existing file or create new
    let existingContent = '';
    if (fs.existsSync(promptsPath)) {
        existingContent = fs.readFileSync(promptsPath, 'utf-8');
    }
    
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
        newContent = '# Copilot Prompts\n\n' + entry;
    }
    
    fs.writeFileSync(promptsPath, newContent, 'utf-8');
}

// ============================================================================
// Trail Logging System
// ============================================================================

/** Configurable max trail entries before cleanup (reads from config, default 1000) */
function getMaxTrailEntries(): number {
    const config = loadSendToChatConfig();
    return config?.trailMaxEntries ?? 1000;
}

/** Configurable trail cleanup days (reads from config, default 2) */
function getTrailCleanupDays(): number {
    const config = loadSendToChatConfig();
    return config?.trailCleanupDays ?? 2;
}

/** Track last cleanup date to only cleanup once per day */
let lastCleanupDate: string | null = null;

/** Generate ISO-based timestamp for individual trail file names (YYYYMMDD_HHMMSSmmm) */
function getTrailFileTimestamp(): string {
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`;
    return `${date}_${time}`;
}

/** Generate human-readable timestamp for trail entries */
function getReadableTimestamp(): string {
    return new Date().toISOString();
}

/** Get the workspace file name without extension, or 'default' if none */
function getWorkspaceName(): string {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile && workspaceFile.fsPath.endsWith('.code-workspace')) {
        const basename = path.basename(workspaceFile.fsPath);
        return basename.replace('.code-workspace', '');
    }
    return 'default';
}

/** Detect the active quest from the open .code-workspace file.
 *  Returns the quest ID if the workspace name matches a quest folder in _ai/quests/, otherwise null. */
function detectQuestFromWorkspace(): string | null {
    const wsName = getWorkspaceName();
    if (wsName === 'default') return null;
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return null;
    const questFolder = WsPaths.ai('quests', wsName) || path.join(wsRoot, '_ai', 'quests', wsName);
    if (fs.existsSync(questFolder)) {
        return wsName;
    }
    return null;
}

/** Get the trail folder path — uses quest directory for consolidated trail files when a quest .code-workspace is open, falls back to _ai/trail */
export function getTrailFolder(): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return '';
    const questId = detectQuestFromWorkspace();
    if (questId) {
        const questFolder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
        return questFolder;
    }
    return WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
}

/** Get the folder for individual trail files (userprompt.md, answer.json) — always _ai/trail */
export function getIndividualTrailFolder(): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return '';
    return WsPaths.ai('trail') || path.join(wsRoot, '_ai', 'trail');
}

/** Get the trail file name prefix — quest ID from .code-workspace when a quest is active, 'default' otherwise */
export function getTrailFilePrefix(): string {
    return detectQuestFromWorkspace() || 'default';
}

/** Migrate old trail files from _prompts.md/_answers.md to .prompts.md/.answers.md */
const _migratedPaths = new Set<string>();
function migrateTrailFiles(trailFolder: string, workspaceName: string): void {
    const key = `${trailFolder}/${workspaceName}`;
    if (_migratedPaths.has(key)) { return; }
    _migratedPaths.add(key);
    
    const oldPrompts = path.join(trailFolder, `${workspaceName}_prompts.md`);
    const newPrompts = path.join(trailFolder, `${workspaceName}.prompts.md`);
    const oldAnswers = path.join(trailFolder, `${workspaceName}_answers.md`);
    const newAnswers = path.join(trailFolder, `${workspaceName}.answers.md`);
    
    try {
        if (fs.existsSync(oldPrompts) && !fs.existsSync(newPrompts)) {
            fs.renameSync(oldPrompts, newPrompts);
            debugLog(`[Trail] Migrated ${oldPrompts} → ${newPrompts}`, 'INFO', 'extension');
        }
        if (fs.existsSync(oldAnswers) && !fs.existsSync(newAnswers)) {
            fs.renameSync(oldAnswers, newAnswers);
            debugLog(`[Trail] Migrated ${oldAnswers} → ${newAnswers}`, 'INFO', 'extension');
        }
    } catch (e) {
        console.error('[Trail] Migration error:', e);
    }
}

/** Parse sequence number from first line of trail file */
function parseSequenceFromFile(filePath: string): number {
    if (!fs.existsSync(filePath)) { return 0; }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) { return 0; }
        // Extract sequence number from first line: "=== PROMPT|ANSWER <ID> <TIMESTAMP> <SEQ> ==="
        const firstLine = content.split('\n')[0];
        const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
        return match ? parseInt(match[1], 10) : 0;
    } catch { return 0; }
}

/** Remove oldest entry from trail file if over max entries */
function trimTrailFile(filePath: string, maxEntries: number): void {
    if (!fs.existsSync(filePath)) { return; }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n')[0];
        const match = firstLine.match(/===\s+(?:PROMPT|ANSWER)\s+\S+\s+\S+\s+(\d+)\s+===/);
        const currentSeq = match ? parseInt(match[1], 10) : 0;
        
        if (currentSeq <= maxEntries) { return; }
        
        // Find and remove the last entry (oldest, at bottom)
        // Entries start with "=== PROMPT" or "=== ANSWER"
        const lines = content.split('\n');
        let lastEntryStart = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].match(/^===\s+(?:PROMPT|ANSWER)/)) {
                lastEntryStart = i;
                break;
            }
        }
        
        if (lastEntryStart > 0) {
            // Remove from lastEntryStart to end
            const trimmed = lines.slice(0, lastEntryStart).join('\n').trimEnd() + '\n';
            fs.writeFileSync(filePath, trimmed, 'utf-8');
        }
    } catch (e) {
        console.error('[Trail] Failed to trim trail file:', e);
    }
}

/** Clean up old individual trail files (older than today - 2 days) */
function cleanupOldTrailFiles(trailFolder: string): void {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (lastCleanupDate === today) { return; } // Already cleaned today
    lastCleanupDate = today;
    
    try {
        if (!fs.existsSync(trailFolder)) { return; }
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - getTrailCleanupDays());
        const cutoffStr = `${cutoffDate.getFullYear()}${String(cutoffDate.getMonth() + 1).padStart(2, '0')}${String(cutoffDate.getDate()).padStart(2, '0')}`;
        
        const files = fs.readdirSync(trailFolder);
        for (const file of files) {
            // Match both old pattern (YYYYMMDD_HHMMSS_copilot.*) and new pattern (YYYYMMDD_HHMMSSmmm_prompt_*|YYYYMMDD_HHMMSSmmm_answer_*)
            const match = file.match(/^(\d{8})_\d{6,9}(?:_copilot\.|_(?:prompt|answer)_)/);
            if (match) {
                const fileDate = match[1];
                if (fileDate < cutoffStr) {
                    const filePath = path.join(trailFolder, file);
                    fs.unlinkSync(filePath);
                }
            }
        }
    } catch (e) {
        console.error('[Trail] Failed to cleanup old files:', e);
    }
}

/** Write to consolidated prompt trail file */
function writePromptTrail(originalPrompt: string, templateName: string, isAnswerWrapper: boolean, expandedPrompt: string, overrideRequestId?: string): void {
    const trailFolder = getTrailFolder();
    if (!trailFolder) { return; }
    
    try {
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }
        
        // Cleanup old individual files on first write of the day (from _ai/trail)
        const cleanupDir = getIndividualTrailFolder();
        if (cleanupDir) {
            cleanupOldTrailFiles(cleanupDir);
        }
        
        const trailPrefix = getTrailFilePrefix();
        migrateTrailFiles(trailFolder, trailPrefix);
        const promptsFile = path.join(trailFolder, `${trailPrefix}.prompts.md`);
        const timestamp = getTrailFileTimestamp();
        const readableTs = getReadableTimestamp();
        const requestId = overrideRequestId || generateRequestId();
        
        // Get next sequence number
        const currentSeq = parseSequenceFromFile(promptsFile);
        const nextSeq = currentSeq + 1;
        
        // Build entry
        const entry = `=== PROMPT ${requestId} ${readableTs} ${nextSeq} ===

${originalPrompt}

TEMPLATE: ${templateName || '(none)'}
ANSWER-WRAPPER: ${isAnswerWrapper ? 'yes' : 'no'}

`;
        
        // Read existing content and prepend
        let existingContent = '';
        if (fs.existsSync(promptsFile)) {
            existingContent = fs.readFileSync(promptsFile, 'utf-8');
        }
        fs.writeFileSync(promptsFile, entry + existingContent, 'utf-8');
        
        // Trim if over max entries
        trimTrailFile(promptsFile, getMaxTrailEntries());
        
        // Also write individual file with expanded prompt to _ai/trail
        const individualDir = getIndividualTrailFolder();
        if (individualDir) {
            if (!fs.existsSync(individualDir)) { fs.mkdirSync(individualDir, { recursive: true }); }
            const individualFile = path.join(individualDir, `${timestamp}_prompt_${requestId}.userprompt.md`);
            fs.writeFileSync(individualFile, expandedPrompt, 'utf-8');
        }
        
    } catch (e) {
        console.error('[Trail] Failed to write prompt trail:', e);
    }
}

/** Write to consolidated answer trail file */
function writeAnswerTrail(answer: { requestId: string; generatedMarkdown: string; comments?: string; references?: string[]; requestedAttachments?: string[]; responseValues?: Record<string, string> }): void {
    const trailFolder = getTrailFolder();
    if (!trailFolder) { return; }
    
    try {
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }
        
        const trailPrefix = getTrailFilePrefix();
        migrateTrailFiles(trailFolder, trailPrefix);
        const answersFile = path.join(trailFolder, `${trailPrefix}.answers.md`);
        const timestamp = getTrailFileTimestamp();
        const readableTs = getReadableTimestamp();
        
        // Get next sequence number
        const currentSeq = parseSequenceFromFile(answersFile);
        const nextSeq = currentSeq + 1;
        
        // Build comments section
        let commentsSection = '';
        if (answer.comments) {
            commentsSection = '\ncomments: ' + answer.comments + '\n';
        }
        
        // Build variables section
        let variablesSection = '';
        if (answer.responseValues && Object.keys(answer.responseValues).length > 0) {
            variablesSection = '\nvariables:\n' + Object.entries(answer.responseValues)
                .map(([k, v]) => ` - ${k} = ${v}`)
                .join('\n') + '\n';
        }
        
        // Build references section
        let referencesSection = '';
        if (answer.references && answer.references.length > 0) {
            referencesSection = '\nreferences:\n' + answer.references
                .map(r => ` - ${r}`)
                .join('\n') + '\n';
        }
        
        // Build requestFileAttachments section
        let attachmentsSection = '';
        if (answer.requestedAttachments && answer.requestedAttachments.length > 0) {
            attachmentsSection = '\nrequestFileAttachments:\n' + answer.requestedAttachments
                .map(a => ` - ${a}`)
                .join('\n') + '\n';
        }
        
        // Build entry
        const entry = `=== ANSWER ${answer.requestId} ${readableTs} ${nextSeq} ===

${answer.generatedMarkdown}
${commentsSection}${variablesSection}${referencesSection}${attachmentsSection}
`;
        
        // Read existing content and prepend
        let existingContent = '';
        if (fs.existsSync(answersFile)) {
            existingContent = fs.readFileSync(answersFile, 'utf-8');
        }
        fs.writeFileSync(answersFile, entry + existingContent, 'utf-8');
        
        // Trim if over max entries
        trimTrailFile(answersFile, getMaxTrailEntries());
        
        // Also write individual JSON answer file to _ai/trail
        const individualDir = getIndividualTrailFolder();
        if (individualDir) {
            if (!fs.existsSync(individualDir)) { fs.mkdirSync(individualDir, { recursive: true }); }
            const individualFile = path.join(individualDir, `${timestamp}_answer_${answer.requestId}.answer.json`);
            fs.writeFileSync(individualFile, JSON.stringify(answer, null, 2), 'utf-8');
        }
        
    } catch (e) {
        console.error('[Trail] Failed to write answer trail:', e);
    }
}

/**
 * Legacy function - kept for Trail Viewer compatibility.
 * File format: YYYYMMDD_HHMMSS_<session>.<type>.md
 */
function writeToTrailViewer(session: string, type: 'userprompt' | 'answer', content: string): void {
    // This function is now replaced by writePromptTrail and writeAnswerTrail
    // Keeping for backward compatibility with Trail Viewer panel
    const trailFolder = getTrailFolder();
    if (!trailFolder) { return; }
    
    try {
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }
        
        const timestamp = getTrailFileTimestamp();
        const filename = `${timestamp}_${session}.${type}.md`;
        const filePath = path.join(trailFolder, filename);
        
        fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e) {
        console.error('[unifiedNotepad] Failed to write trail file:', e);
    }
}

const VIEW_ID = 'tomAi.chatPanel';

interface Section {
    id: string;
    label: string;
    icon: string;
    content: string;
}

class UnifiedNotepadViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _answerFileWatcher?: fs.FSWatcher;
    private _autoHideDelay: number = 0; // 0 = keep open, otherwise ms
    private _keepContentAfterSend: boolean = false;
    private _lastLoggedAnswerId: string = ''; // Track last logged answer to avoid duplicates
    private _lastSentCopilotSlot: number = 1;
    private _currentAnswerSlot: number = 1;
    private _copilotRequestSlotMap: Map<string, number> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._autoHideDelay = context.workspaceState.get('copilotAutoHideDelay', 0);
        this._keepContentAfterSend = context.workspaceState.get('copilotKeepContent', false);
        this._setupAnswerFileWatcher();
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
                    case 'getProfiles':
                        this._sendProfiles();
                        break;
                    case 'getReusablePrompts':
                        this._sendReusablePrompts();
                        break;
                    case 'sendReusablePrompt':
                        await this._sendReusablePrompt(message.reusableId);
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
                        this._context.workspaceState.update('copilotAutoHideDelay', message.value);
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
                    case 'showAnswerViewerLegacy':
                        await this._showAnswerViewerLegacy();
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
                        await this._handleAddToQueue(message.text, message.template);
                        break;
                    case 'openQueueEditor':
                        await vscode.commands.executeCommand('tomAi.editor.promptQueue');
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
                    case 'openTrailViewer':
                        await vscode.commands.executeCommand('tomAi.editor.rawTrailViewer');
                        break;
                    case 'openTrailFiles':
                        await this._openTrailFiles();
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

    private _getEffectiveLlmConfigurations(config: SendToChatConfig | null): Array<{ id: string; name: string }> {
        const explicit = Array.isArray(config?.llmConfigurations) ? config!.llmConfigurations : [];
        if (explicit.length > 0) {
            return explicit
                .filter((c: any) => c && typeof c.id === 'string' && c.id.trim().length > 0)
                .map((c: any) => ({ id: c.id, name: c.name || c.id }));
        }
        return [];
    }

    private _getEffectiveAiConversationSetups(config: SendToChatConfig | null): Array<{ id: string; name: string }> {
        const explicit = Array.isArray(config?.aiConversationSetups) ? config!.aiConversationSetups : [];
        if (explicit.length > 0) {
            return explicit
                .filter((s: any) => s && typeof s.id === 'string' && s.id.trim().length > 0)
                .map((s: any) => ({ id: s.id, name: s.name || s.id }));
        }
        return [];
    }

    private _sendProfiles(): void {
        const config = loadSendToChatConfig();
        this._view?.webview.postMessage({
            type: 'profiles',
            localLlm: config?.promptExpander?.profiles ? Object.keys(config.promptExpander.profiles) : [],
            conversation: config?.botConversation?.profiles ? Object.keys(config.botConversation.profiles) : [],
            // Filter out __answer_file__ since it's hardcoded in the dropdown as "Answer Wrapper"
            copilot: config?.templates ? Object.keys(config.templates).filter(k => k !== '__answer_file__') : [],
            tomAiChat: config?.tomAiChat?.templates ? Object.keys(config.tomAiChat.templates) : [],
            llmConfigurations: this._getEffectiveLlmConfigurations(config),
            aiConversationSetups: this._getEffectiveAiConversationSetups(config),
            defaultTemplates: config?.defaultTemplates || {},
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
        return this._context.workspaceState.get<string>('chatVar_quest', '').trim();
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
        return this._collectAncestorPromptDirs().map((promptDir) => {
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

    private _collectAncestorPromptDirs(): string[] {
        const wsRoot = getWorkspaceRoot();
        const activeFile = vscode.window.activeTextEditor?.document?.uri.fsPath;
        if (!wsRoot || !activeFile || !activeFile.startsWith(wsRoot)) {
            return [];
        }
        const unique = new Set<string>();
        const result: string[] = [];
        let current = path.dirname(activeFile);
        while (current && current.startsWith(wsRoot)) {
            const promptDir = path.join(current, 'prompt');
            if (fs.existsSync(promptDir) && fs.statSync(promptDir).isDirectory()) {
                const key = path.resolve(promptDir);
                if (!unique.has(key)) {
                    unique.add(key);
                    result.push(promptDir);
                }
            }
            if (current === wsRoot) {
                break;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return result;
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

    private async _sendReusablePrompt(reusableId: string): Promise<void> {
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
        const manager = getPromptExpanderManager();
        if (!manager) {
            vscode.window.showErrorMessage('Local LLM not available - extension not fully initialized');
            return;
        }

        const config = loadSendToChatConfig();
        const strictErrors = validateStrictAiConfiguration(config);
        if (strictErrors.length > 0) {
            const msg = `Invalid AI configuration:\n- ${strictErrors.join('\n- ')}`;
            debugLog(`[UnifiedNotepad] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage('Invalid AI configuration. Open Status Page for details.');
            return;
        }
        
        const defaultWrapped = applyDefaultTemplate(text, 'localLlm');
        const expanded = await expandTemplate(defaultWrapped);
        const profileKey = profile === '__none__' ? null : profile;
        const llmConfigKey = llmConfig && llmConfig !== '__default__' ? llmConfig : null;
        const profileLabel = profile === '__none__' ? 'None' : profile;
        if (!llmConfigKey) {
            const msg = 'Missing required Local LLM configuration selection.';
            debugLog(`[UnifiedNotepad] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage(msg);
            return;
        }
        
        // Resolve model name for status messages
        const modelName = manager.getResolvedModelName();
        
        try {
            // Check if model needs loading
            const modelLoaded = await manager.checkModelLoaded();
            
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: modelLoaded ? `Sending to local ${modelName}...` : `Loading ${modelName}...`,
                    cancellable: true,
                },
                async (progress, token) => {
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
                        token.onCancellationRequested(() => clearInterval(checkInterval));
                    } else {
                        // Model already loaded, go straight to processing
                        progress.report({ message: `Processing prompt with ${modelName}...` });
                    }
                    return manager.process(expanded, profileKey, llmConfigKey, undefined, token);
                }
            );
            
            if (result.success) {
                await this._appendToTrail(expanded, result.result, profileLabel, llmConfigKey);
                await this._showTrail();
            } else {
                vscode.window.showErrorMessage(`Local LLM error: ${result.error || 'Unknown error'}`);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Local LLM failed: ${e}`);
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
            debugLog(`[UnifiedNotepad] ${msg}`, 'ERROR', 'extension');
            vscode.window.showErrorMessage('Invalid AI configuration. Open Status Page for details.');
            return;
        }

        const setups = Array.isArray(config?.aiConversationSetups) ? config!.aiConversationSetups : [];
        const selectedSetup = setups.find((s: any) => s?.id === aiSetupId);
        if (!selectedSetup) {
            const msg = `Missing required AI conversation setup: ${aiSetupId || '(none selected)'}`;
            debugLog(`[UnifiedNotepad] ${msg}`, 'ERROR', 'extension');
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
            debugLog(`[UnifiedNotepad] ${msg}`, 'ERROR', 'extension');
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
        const answerFileTpl = config?.templates?.['__answer_file__'];
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
            const templateObj = config?.templates?.[template];
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
        await this._insertExpandedToChatFile(expanded);
    }

    private async _insertExpandedToChatFile(expanded: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.chat.md')) {
            vscode.window.showWarningMessage('Please open a .chat.md file first');
            return;
        }

        const doc = editor.document;
        const text = doc.getText();
        const chatHeaderMatch = text.match(/_{3,}\s*CHAT\s+\w+\s*_{3,}/);
        
        if (chatHeaderMatch) {
            const headerIndex = text.indexOf(chatHeaderMatch[0]);
            const headerEnd = headerIndex + chatHeaderMatch[0].length;
            const position = doc.positionAt(headerEnd);
            
            await editor.edit(editBuilder => {
                editBuilder.insert(position, '\n\n' + expanded);
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
            const llmConfigs = Array.isArray(config?.llmConfigurations) ? config!.llmConfigurations : [];
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
        const paths = this._getLocalTrailPaths(llmConfigKey);
        if (!paths) {
            vscode.window.showWarningMessage('No workspace folder - cannot save to trail file');
            return;
        }

        const dir = path.dirname(paths.compact);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const timestamp = new Date().toISOString();
        const requestId = generateRequestId();
        const fileTs = this._getLocalTrailFileTimestamp();

        const promptEntry = `=== PROMPT ${requestId} ${timestamp} ===\n\n${prompt}\n\nPROFILE: ${profile}\n\n`;
        const answerEntry = `=== ANSWER ${requestId} ${timestamp} ===\n\n${response}\n\nPROFILE: ${profile}\n\n`;
        const compactEntry = `\n---\n\n## ${timestamp} (${profile})\n\n### Prompt\n\n${prompt}\n\n### Response\n\n${response}\n`;

        const existingPrompts = fs.existsSync(paths.prompts) ? fs.readFileSync(paths.prompts, 'utf-8') : '# Local LLM Prompts Trail\n\n';
        const existingAnswers = fs.existsSync(paths.answers) ? fs.readFileSync(paths.answers, 'utf-8') : '# Local LLM Answers Trail\n\n';
        fs.writeFileSync(paths.prompts, promptEntry + existingPrompts, 'utf-8');
        fs.writeFileSync(paths.answers, answerEntry + existingAnswers, 'utf-8');

        const promptFile = path.join(dir, `${fileTs}_prompt_${requestId}.userprompt.md`);
        const answerFile = path.join(dir, `${fileTs}_answer_${requestId}.answer.json`);
        fs.writeFileSync(promptFile, prompt, 'utf-8');
        fs.writeFileSync(answerFile, JSON.stringify({ requestId, generatedMarkdown: response }, null, 2), 'utf-8');

        fs.appendFileSync(paths.compact, compactEntry, 'utf-8');
    }

    private async _showTrail(): Promise<void> {
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

    private async _showAnswerViewerLegacy(): Promise<void> {
        const answer = readAnswerFile();
        const references = (answer?.references || []).join(', ');
        const legacyHeader = answer?.generatedMarkdown
            ? `# Copilot Answer (Legacy Preview)\n\n**Slot:** ${this._currentAnswerSlot}\n\n**Request ID:** ${answer.requestId || 'N/A'}${references ? `\n\n**References:** ${references}` : ''}\n\n---\n\n`
            : '# Copilot Answer (Legacy Preview)\n\nNo answer file found.';
        const legacyBody = answer?.generatedMarkdown || '';
        await showPreviewPanel('Copilot Answer (Legacy)', `${legacyHeader}${legacyBody}`);
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
        const entry = `${marker}\n## Answer ${timestamp}\n\n${answer.generatedMarkdown}\n\n---\n\n`;
        
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
        const trailFolder = getTrailFolder();
        const trailPrefix = getTrailFilePrefix();
        migrateTrailFiles(trailFolder, trailPrefix);
        const promptsPath = path.join(trailFolder, `${trailPrefix}.prompts.md`);
        
        // Ensure directory exists
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }
        
        // Create file if it doesn't exist
        if (!fs.existsSync(promptsPath)) {
            fs.writeFileSync(promptsPath, '# Copilot Prompts Trail\n\n', 'utf-8');
        }
        
        // Open or focus the file
        const doc = await vscode.workspace.openTextDocument(promptsPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _openAnswersFile(): Promise<void> {
        const trailFolder = getTrailFolder();
        const trailPrefix = getTrailFilePrefix();
        migrateTrailFiles(trailFolder, trailPrefix);
        const answersPath = path.join(trailFolder, `${trailPrefix}.answers.md`);
        
        // Ensure directory exists
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }
        
        // Create file if it doesn't exist
        if (!fs.existsSync(answersPath)) {
            fs.writeFileSync(answersPath, '# Copilot Answers Trail\n\n', 'utf-8');
        }
        
        // Open or focus the file
        const doc = await vscode.workspace.openTextDocument(answersPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    /**
     * Open the trail custom editor (trailViewer.editor) for the current workspace's prompts trail file.
     */
    private async _openTrailFiles(): Promise<void> {
        const trailFolder = getTrailFolder();
        const trailPrefix = getTrailFilePrefix();
        migrateTrailFiles(trailFolder, trailPrefix);
        const promptsPath = path.join(trailFolder, `${trailPrefix}.prompts.md`);

        // Ensure directory exists
        if (!fs.existsSync(trailFolder)) {
            fs.mkdirSync(trailFolder, { recursive: true });
        }

        // Create file if it doesn't exist
        if (!fs.existsSync(promptsPath)) {
            fs.writeFileSync(promptsPath, '# Copilot Prompts Trail\n\n', 'utf-8');
        }

        // Open with the custom trail editor
        const uri = vscode.Uri.file(promptsPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'trailViewer.editor');
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
        let reminderEnabled = false;
        let reminderTimeout = 600000;

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

        // Get reminder state
        try {
            const { ReminderSystem } = await import('../managers/reminderSystem.js');
            const reminder = ReminderSystem.instance;
            if (reminder) {
                reminderEnabled = reminder.config.enabled;
                reminderTimeout = reminder.config.defaultTimeoutMinutes * 60000;
            }
        } catch { /* ignore */ }

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
            currentTodo,
            reminderEnabled,
            reminderTimeout
        });
    }

    private _sendContextSummary(): void {
        let parts: string[] = [];
        try {
            // We need a sync approach — use workspace state cache  
            const quest = this._context.workspaceState.get<string>('chatVar_quest', '');
            const role = this._context.workspaceState.get<string>('chatVar_role', '');
            if (quest) parts.push('Q:' + quest);
            if (role) parts.push('R:' + role);
        } catch { /* ignore */ }
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

        // Update reminder
        try {
            const { ReminderSystem } = await import('../managers/reminderSystem.js');
            const reminder = ReminderSystem.instance;
            if (reminder) {
                const timeoutMinutes = Math.max(1, Math.round((msg.reminderTimeout || 600000) / 60000));
                reminder.updateConfig({
                    enabled: !!msg.reminderEnabled,
                    defaultTimeoutMinutes: timeoutMinutes
                });
            }
        } catch { /* ignore */ }

        // Update context summary
        this._sendContextSummary();
        this._sendReusablePrompts();
    }

    private async _handleAddToQueue(text: string, template: string): Promise<void> {
        try {
            const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
            const queue = PromptQueueManager.instance;
            if (queue) {
                // Apply panel default template wrapping
                const wrappedText = applyDefaultTemplate(text, 'copilot');
                await queue.enqueue({ originalText: wrappedText, template: template || undefined, deferSend: true });
                const count = queue.items.length;
                vscode.window.showInformationMessage(`Added to prompt queue (${count} items)`);
                // Notify webview so it can clear text and show feedback
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
        let currentQuest = '';
        try {
            const { ChatVariablesStore } = await import('../managers/chatVariablesStore.js');
            currentQuest = ChatVariablesStore.instance.quest || '';
        } catch { /* ignore */ }

        if (!currentQuest || !file || !wsRoot) {
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

    private async _saveDrafts(drafts: Record<string, { text?: string; profile?: string; llmConfig?: string; aiSetup?: string; activeSlot?: number; slots?: Record<string, string> }>): Promise<void> {
        try {
            const { writePromptPanelYaml } = await import('../utils/panelYamlStore.js');
            const sections = ['localLlm', 'conversation', 'copilot', 'tomAiChat'];
            await Promise.all(
                sections.map(async (section) => {
                    const sectionDraft = drafts[section] || {};
                    await writePromptPanelYaml(section, {
                        text: sectionDraft.text || '',
                        profile: sectionDraft.profile || '',
                        llmConfig: sectionDraft.llmConfig || '',
                        aiSetup: sectionDraft.aiSetup || '',
                        activeSlot: sectionDraft.activeSlot || 1,
                        slots: sectionDraft.slots || {},
                    });
                })
            );
        } catch (e) {
            console.error('[unifiedNotepad] Failed to save drafts:', e);
        }
    }

    private async _loadDrafts(): Promise<void> {
        try {
            const { readPromptPanelYaml, readPanelYaml } = await import('../utils/panelYamlStore.js');
            const sections = ['localLlm', 'conversation', 'copilot', 'tomAiChat'];
            const loaded: Record<string, { text?: string; profile?: string; llmConfig?: string; aiSetup?: string; activeSlot?: number; slots?: Record<string, string> }> = {};
            for (const section of sections) {
                const data = await readPromptPanelYaml<{ text?: string; profile?: string; llmConfig?: string; aiSetup?: string; activeSlot?: number; slots?: Record<string, string> }>(section);
                if (data) {
                    loaded[section] = {
                        text: data.text || '',
                        profile: data.profile || '',
                        llmConfig: data.llmConfig || '',
                        aiSetup: data.aiSetup || '',
                        activeSlot: data.activeSlot || 1,
                        slots: data.slots || {},
                    };
                }
            }

            if (Object.keys(loaded).length > 0) {
                this._view?.webview.postMessage({ type: 'draftsLoaded', sections: loaded });
                return;
            }

            const legacy = await readPanelYaml<{ sections?: Record<string, { text?: string; profile?: string; activeSlot?: number; slots?: Record<string, string> }> }>('panels');
            if (legacy?.sections) {
                this._view?.webview.postMessage({ type: 'draftsLoaded', sections: legacy.sections });
                return;
            }
            // No data found — still signal so the webview unlocks draft saving
            this._view?.webview.postMessage({ type: 'draftsLoaded', sections: {} });
        } catch {
            // File may not exist yet — unlock draft saving anyway
            this._view?.webview.postMessage({ type: 'draftsLoaded', sections: {} });
        }
    }

    private async _showPanelsFile(): Promise<void> {
        try {
            const { openPromptPanelFile, openPanelFile, getPromptPanelFilePath } = await import('../utils/panelYamlStore.js');
            const section = 'copilot';
            const promptFile = getPromptPanelFilePath(section);
            if (promptFile && fs.existsSync(promptFile)) {
                await openPromptPanelFile(section);
                return;
            }
            await openPanelFile('panels');
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
                const profile = profileOrTemplate && profileOrTemplate !== '__none__' ? config?.promptExpander?.profiles?.[profileOrTemplate] : null;
                if (profile?.systemPrompt) {
                    previewContent = `=== SYSTEM PROMPT ===\n${profile.systemPrompt}\n\n=== USER PROMPT ===\n${text}`;
                }
                onSend = async (t) => await this._handleSendLocalLlm(t, profileOrTemplate);
                break;
            }
            case 'conversation': {
                title = 'AI Conversation';
                const profile = profileOrTemplate && profileOrTemplate !== '__none__' ? config?.botConversation?.profiles?.[profileOrTemplate] : null;
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
                const answerFileTpl = config?.templates?.['__answer_file__'];
                const answerFileTemplate = answerFileTpl?.template || DEFAULT_ANSWER_FILE_TEMPLATE;
                
                if (profileOrTemplate === '__answer_file__' || !profileOrTemplate || profileOrTemplate === '__none__') {
                    // Answer Wrapper or no template: just expand answer file template
                    if (profileOrTemplate === '__answer_file__') {
                        previewContent = await expandTemplate(answerFileTemplate, { values: { originalPrompt: text } });
                    }
                    // else: no template, previewContent stays as text (will be expanded below)
                } else {
                    // Other template: first expand the template, then wrap with answer file
                    const template = config?.templates?.[profileOrTemplate];
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
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category });
        }
    }

    private async _handleEditProfile(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const categoryMap: Record<string, TemplateCategory> = {
            localLlm: 'localLlm',
            conversation: 'conversation',
        };
        const category = categoryMap[section];
        if (category) {
            openGlobalTemplateEditor(this._context, { category, itemId: name });
        }
    }

    private async _handleDeleteProfile(section: string, name?: string): Promise<void> {
        if (!name) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${name}"?`, { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (!config) { return; }

        if (section === 'localLlm' && config.promptExpander?.profiles?.[name]) {
            delete config.promptExpander.profiles[name];
        } else if (section === 'conversation' && config.botConversation?.profiles?.[name]) {
            delete config.botConversation.profiles[name];
        } else { return; }

        if (saveSendToChatConfig(config)) {
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

        if (section === 'copilot' && config.templates?.[name]) {
            delete config.templates[name];
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
    { id: 'tomAiChat', icon: '<span class="codicon codicon-comment-discussion-sparkle"></span>', title: 'Tom AI Chat' }
];
var state = { expanded: ['localLlm'], pinned: [] };
var profiles = { localLlm: [], conversation: [], copilot: [], tomAiChat: [] };
var llmConfigurations = [];
var aiConversationSetups = [];
var defaultTemplates = {};
var reusablePromptModel = { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
var pendingReusableCopySection = '';
var reusablePreferredQuestId = '';
var reusablePreferredProjectId = '';
var reusablePreferredScanId = '';
var reusablePromptState = {};
var copilotHasAnswer = false;
var copilotAnswerSlot = 0;
var slotEnabledSections = ['localLlm', 'conversation', 'copilot', 'tomAiChat'];
var sectionSlotState = {};

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
        '<button class="icon-btn" data-action="sendReusablePrompt" data-id="' + sectionId + '" title="Send reusable prompt to Copilot (Answer Wrapper)"><span class="codicon codicon-send"></span></button>' +
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
                '<button class="icon-btn" data-action="clearText" data-id="conversation" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
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
                '<button class="icon-btn" data-action="addToQueue" data-id="copilot" title="Save to Queue"><span class="codicon codicon-add"></span><span class="codicon codicon-list-ordered"></span></button>' +
                '<button class="icon-btn" data-action="openQueueEditor" data-id="copilot" title="Open Queue Editor"><span class="codicon codicon-inbox"></span></button>' +
                '<button class="icon-btn" data-action="saveAsTimedRequest" data-id="copilot" title="Save as Timed Request"><span class="codicon codicon-save"></span></button>' +
                '<button class="icon-btn" data-action="openTimedRequestsEditor" data-id="copilot" title="Timed Requests"><span class="codicon codicon-watch"></span></button>' +
                '<button class="icon-btn" data-action="openTrailFiles" data-id="copilot" title="Open Trail"><span class="codicon codicon-history"></span></button>' +
                '<button class="icon-btn" data-action="openTrailViewer" data-id="copilot" title="Open Trail Files Viewer"><span class="codicon codicon-list-flat"></span></button>' +
                '<label class="checkbox-label compact-keep"><input type="checkbox" id="copilot-keep-content"> Keep</label>' +
                '<button class="icon-btn" data-action="clearText" data-id="copilot" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            afterToolbarHtml:
                '<div class="toolbar answers-toolbar" id="copilot-answers-toolbar" style="display:none;">' +
                '<span id="copilot-answer-indicator" class="answer-indicator">Answer Ready</span>' +
                '<button class="icon-btn" data-action="showAnswerViewer" data-id="copilot" title="View Answer"><span class="codicon codicon-eye"></span></button>' +
                '<button class="icon-btn" data-action="showAnswerViewerLegacy" data-id="copilot" title="View Answer (Legacy)"><span class="codicon codicon-file"></span></button>' +
                '<button class="icon-btn" data-action="extractAnswer" data-id="copilot" title="Extract to Markdown"><span class="codicon codicon-file-symlink-file"></span></button>' +
                '</div>' +
                '<div id="copilot-context-overlay" class="context-overlay" style="display:none;">' +
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
            '<fieldset class="context-group"><legend>Reminder Template</legend>' +
            '<div class="context-row"><label>Template:</label><select id="ctx-template"><option value="">(None)</option><option value="__answer_file__">Answer Wrapper</option></select>' +
            '<button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add"><span class="codicon codicon-add"></span></button>' +
            '<button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit"><span class="codicon codicon-edit"></span></button>' +
            '<button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete"><span class="codicon codicon-trash"></span></button></div>' +
            '<div class="context-row"><label>Auto-hide:</label><select id="copilot-autohide"><option value="0">Keep open</option><option value="1000">1s</option><option value="5000">5s</option><option value="10000">10s</option></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Reminder</legend>' +
            '<div class="context-row"><label><input type="checkbox" id="ctx-reminder-enabled"> Alive check</label>' +
            '<select id="ctx-reminder-timeout"><option value="300000">5m</option><option value="600000">10m</option><option value="900000">15m</option><option value="1800000">30m</option></select></div>' +
            '</fieldset>' +
            '<fieldset class="context-group"><legend>Quick Links</legend>' +
            '<div class="context-links">' +
            '<button class="link-btn" data-action="openStatusPage" title="Extension Status"><span class="codicon codicon-dashboard"></span> Status Page</button>' +
            '<button class="link-btn" data-action="openGlobalTemplateEditor" title="Prompt Template Editor"><span class="codicon codicon-file-code"></span> Template Editor</button>' +
            '<button class="link-btn" data-action="openReusablePromptEditor" title="Reusable Prompt Editor"><span class="codicon codicon-note"></span> Reusable Prompts</button>' +
            '<button class="link-btn" data-action="openContextSettingsEditor" title="Context & Settings Editor"><span class="codicon codicon-settings-gear"></span> Context Editor</button>' +
            '<button class="link-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span> Chat Variables</button>' +
            '<button class="link-btn" data-action="openTrailFiles" data-id="copilot" title="Trail Custom Editor"><span class="codicon codicon-history"></span> Trail File</button>' +
            '<button class="link-btn" data-action="openTrailViewer" data-id="copilot" title="Trail Files Viewer"><span class="codicon codicon-list-flat"></span> Trail Viewer</button>' +
            '</div>' +
            '</fieldset>' +
            '</div>' +
            '<div class="context-popup-footer"><button class="primary" data-action="applyContext">Apply</button><button data-action="closeContextPopup">Cancel</button></div>' +
            '</div>' +
            '</div>',
            infoId: 'copilot-templateInfo',
            placeholder: 'Enter your prompt...',
            helpTitle: '',
            afterEditorHtml:
                '<div class="status-bar"><span id="copilot-context-summary" class="context-summary"></span><span class="status-bar-actions"><button class="icon-btn" data-action="openChatVariablesEditor" title="Chat Variables Editor"><span class="codicon codicon-symbol-key"></span></button></span></div>',
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
                '<button class="primary" data-action="insertToChatFile" data-id="tomAiChat" title="Insert into .chat.md file">Insert</button>' +
                '<button class="icon-btn" data-action="clearText" data-id="tomAiChat" title="Clear text"><span class="codicon codicon-clear-all"></span></button>',
            infoId: 'tomAiChat-templateInfo',
            placeholder: 'Enter your prompt for Tom AI Chat...',
            helpTitle: 'Show Placeholder Help',
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
    document.querySelectorAll('[data-toggle]').forEach(function(el) { el.addEventListener('click', function() { toggleSection(el.dataset.toggle); }); });
    document.querySelectorAll('[data-pin]').forEach(function(el) { el.addEventListener('click', function(e) { togglePin(el.dataset.pin, e); }); });
    document.querySelectorAll('[data-action]').forEach(function(el) { el.addEventListener('click', function() { handleAction(el.dataset.action, el.dataset.id, el.dataset.slot); }); });
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
        case 'send': { var text = document.getElementById(id + '-text'); text = text ? text.value : ''; if (!text.trim()) return; var profile = document.getElementById(id + '-profile'); profile = profile ? profile.value : ''; var template = document.getElementById(id + '-template'); template = template ? template.value : ''; var llmConfig = document.getElementById('localLlm-llmConfig'); llmConfig = llmConfig ? llmConfig.value : ''; var aiSetup = document.getElementById('conversation-aiSetup'); aiSetup = aiSetup ? aiSetup.value : ''; var slotNo = ensureSlotState(id).activeSlot; vscode.postMessage({ type: 'send' + id.charAt(0).toUpperCase() + id.slice(1), text: text, profile: profile, template: template, llmConfig: llmConfig, aiSetup: aiSetup, slot: slotNo }); break; }
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
        case 'sendReusablePrompt': {
            var reusableToSend = getSelectedReusablePromptId(id);
            if (!reusableToSend) return;
            vscode.postMessage({ type: 'sendReusablePrompt', reusableId: reusableToSend });
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
        case 'showAnswerViewerLegacy': vscode.postMessage({ type: 'showAnswerViewerLegacy' }); break;
        case 'extractAnswer': vscode.postMessage({ type: 'extractAnswer' }); break;
        case 'openPromptsFile': vscode.postMessage({ type: 'openPromptsFile' }); break;
        case 'openAnswersFile': vscode.postMessage({ type: 'openAnswersFile' }); break;
        case 'openContextPopup': vscode.postMessage({ type: 'openContextSettingsEditor' }); break;
        case 'closeContextPopup': closeContextPopup(); break;
        case 'applyContext': applyContextPopup(); break;
        case 'send': sendCopilotPrompt(); break;
        case 'addToQueue': addCopilotToQueue(); break;
        case 'openQueueEditor': vscode.postMessage({ type: 'openQueueEditor' }); break;
        case 'openTimedRequestsEditor': vscode.postMessage({ type: 'openTimedRequestsEditor' }); break;
        case 'openTrailFiles': vscode.postMessage({ type: 'openTrailFiles' }); break;
        case 'openTrailViewer': vscode.postMessage({ type: 'openTrailViewer' }); break;
        case 'saveAsTimedRequest': { var trText = document.getElementById('copilot-text'); trText = trText ? trText.value : ''; if (!trText.trim()) return; var trTpl = document.getElementById('copilot-template'); trTpl = trTpl ? trTpl.value : ''; vscode.postMessage({ type: 'saveAsTimedRequest', text: trText, template: trTpl }); break; }
        case 'openChatVariablesEditor': vscode.postMessage({ type: 'openChatVariablesEditor' }); break;
        case 'addTemplate': vscode.postMessage({ type: 'addProfile', section: action.id }); break;
        case 'editTemplate': { var tsel = document.getElementById(action.id + '-template'); if (tsel && tsel.value && tsel.value !== '__answer_file__') vscode.postMessage({ type: 'editProfile', section: action.id, name: tsel.value }); break; }
        case 'deleteTemplate': { var dsel = document.getElementById(action.id + '-template'); if (dsel && dsel.value && dsel.value !== '__answer_file__') vscode.postMessage({ type: 'deleteProfile', section: action.id, name: dsel.value }); break; }
        case 'openStatusPage': vscode.postMessage({ type: 'openStatusPage' }); break;
        case 'openGlobalTemplateEditor': vscode.postMessage({ type: 'openGlobalTemplateEditor' }); break;
        case 'openReusablePromptEditor': vscode.postMessage({ type: 'openReusablePromptEditor' }); break;
        case 'openContextSettingsEditor': vscode.postMessage({ type: 'openContextSettingsEditor' }); break;
    }
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
    populateEntitySelect('localLlm-llmConfig', llmConfigurations, '(Select LLM Config)');
    populateEntitySelect('conversation-aiSetup', aiConversationSetups, '(Select AI Setup)');
    ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(sectionId) {
        populateReusablePromptSelectors(sectionId);
    });
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
    var baseOption = '<option value="">' + (defaultLabel || '(Select)') + '</option>';
    sel.innerHTML = baseOption + (options || []).map(function(o) {
        var value = (o && typeof o.id === 'string') ? o.id : '';
        var label = (o && typeof o.name === 'string' && o.name) ? o.name : value;
        return '<option value="' + value + '">' + label + '</option>';
    }).join('');
    if (cur && (options || []).some(function(o) { return o && o.id === cur; })) {
        sel.value = cur;
    } else {
        sel.value = '';
    }
}

window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'profiles') {
        profiles = { localLlm: msg.localLlm || [], conversation: msg.conversation || [], copilot: msg.copilot || [], tomAiChat: msg.tomAiChat || [] };
        llmConfigurations = msg.llmConfigurations || [];
        aiConversationSetups = msg.aiConversationSetups || [];
        defaultTemplates = msg.defaultTemplates || {};
        populateDropdowns();
        updateDefaultTemplateIndicator();
    } else if (msg.type === 'reusablePrompts') {
        reusablePromptModel = msg.model || { scopes: { project: [], quest: [], scan: [] }, files: { global: [], project: {}, quest: {}, scan: {} } };
        reusablePreferredQuestId = msg.preferredQuestId || '';
        reusablePreferredProjectId = msg.preferredProjectId || '';
        reusablePreferredScanId = msg.preferredScanId || '';
        ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(sectionId) {
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
        refreshCopilotAnswerToolbarVisibility();
        _draftsLoaded = true;
    }
});

function updateDefaultTemplateIndicator() {
    var tplInfo = document.getElementById('copilot-templateInfo');
    if (tplInfo && defaultTemplates.copilot) {
        tplInfo.textContent = 'Default template: ' + defaultTemplates.copilot;
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
    var slot = ensureSlotState('copilot').activeSlot;
    vscode.postMessage({ type: 'addToQueue', text: text, template: template, slot: slot });
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
    // Template sync
    var ctxTemplate = document.getElementById('ctx-template');
    var mainTemplate = document.getElementById('copilot-template');
    if (ctxTemplate && mainTemplate) ctxTemplate.value = mainTemplate.value;
    // Reminder
    var reminderCb = document.getElementById('ctx-reminder-enabled');
    if (reminderCb) reminderCb.checked = !!data.reminderEnabled;
    var reminderTimeout = document.getElementById('ctx-reminder-timeout');
    if (reminderTimeout && data.reminderTimeout) reminderTimeout.value = String(data.reminderTimeout);
}

function applyContextPopup() {
    var questSel = document.getElementById('ctx-quest');
    var roleSel = document.getElementById('ctx-role');
    var projSel = document.getElementById('ctx-projects');
    var todoFileSel = document.getElementById('ctx-todoFile');
    var todoSel = document.getElementById('ctx-todo');
    var ctxTemplate = document.getElementById('ctx-template');
    var reminderCb = document.getElementById('ctx-reminder-enabled');
    var reminderTimeout = document.getElementById('ctx-reminder-timeout');

    var selectedProjects = [];
    if (projSel) {
        for (var i = 0; i < projSel.options.length; i++) {
            if (projSel.options[i].selected) selectedProjects.push(projSel.options[i].value);
        }
    }

    // Sync template back to main dropdown
    var mainTemplate = document.getElementById('copilot-template');
    if (ctxTemplate && mainTemplate) mainTemplate.value = ctxTemplate.value;

    vscode.postMessage({
        type: 'applyContext',
        quest: questSel ? questSel.value : '',
        role: roleSel ? roleSel.value : '',
        activeProjects: selectedProjects,
        todoFile: todoFileSel ? todoFileSel.value : '',
        todo: todoSel ? todoSel.value : '',
        reminderEnabled: reminderCb ? reminderCb.checked : false,
        reminderTimeout: reminderTimeout ? parseInt(reminderTimeout.value, 10) : 600000
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
    ['localLlm', 'conversation', 'copilot', 'tomAiChat'].forEach(function(sectionId) {
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
        vscode.postMessage({ type: 'saveDrafts', drafts: drafts });
    }, 1000);
}
// Attach save to all textareas and dropdowns
['localLlm-text', 'conversation-text', 'copilot-text', 'tomAiChat-text'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', saveDrafts);
});
['localLlm-profile', 'conversation-profile', 'copilot-template', 'tomAiChat-template'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', saveDrafts);
});
['localLlm-llmConfig', 'conversation-aiSetup'].forEach(function(id) {
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
    <title>T2 Unified Notepad</title>
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
                copilot: '<div class="toolbar"><div class="toolbar-row"><label>Template:</label><select id="copilot-template"><option value="">(None)</option><option value="__answer_file__">Answer Wrapper</option></select><button class="icon-btn" data-action="addTemplate" data-id="copilot" title="Add Template">+</button><button class="icon-btn" data-action="editTemplate" data-id="copilot" title="Edit Template">✏️</button><button class="icon-btn danger" data-action="deleteTemplate" data-id="copilot" title="Delete Template">🗑️</button></div><div class="toolbar-row"><button data-action="preview" data-id="copilot">Preview</button><button class="primary" data-action="send" data-id="copilot">Send to Copilot</button><label style="margin-left:8px;">Auto-hide:</label><select id="copilot-autohide"><option value="0">Keep</option><option value="1000">1s</option><option value="5000">5s</option><option value="10000">10s</option></select><button class="icon-btn" data-action="openTrailFiles" data-id="copilot" title="Open Trail" style="margin-left:4px;">📜</button><button class="icon-btn" data-action="openTrailViewer" data-id="copilot" title="Open Trail Files Viewer" style="margin-left:4px;">📋</button><label style="margin-left:4px;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="copilot-keep-content"> Keep</label></div></div><div class="toolbar answers-toolbar" id="copilot-answers-toolbar" style="display:none;"><span id="copilot-answer-indicator" class="answer-indicator">Answer Ready</span><button class="icon-btn" data-action="showAnswerViewer" data-id="copilot" title="View Answer">👁️</button><button class="icon-btn" data-action="extractAnswer" data-id="copilot" title="Extract to Markdown">📄</button></div><div id="copilot-templateInfo" class="profile-info" style="display:none;"></div><textarea id="copilot-text" placeholder="Enter your prompt... The selected template\'s prefix/suffix will wrap this content." data-input="copilot"></textarea><div class="status-bar"><span id="copilot-charCount">0 chars</span></div>',
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
                    vscode.postMessage({ type: 'openTrailFiles' });
                    break;
                case 'openTrailViewer':
                    vscode.postMessage({ type: 'openTrailViewer' });
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

let _provider: UnifiedNotepadViewProvider | undefined;

export function registerUnifiedNotepad(context: vscode.ExtensionContext): void {
    _provider = new UnifiedNotepadViewProvider(context);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_ID, _provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );
}

