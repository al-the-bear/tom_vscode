/**
 * DS Notes WebviewView Providers - Config-based Templates
 * 
 * Each notepad uses templates from its dedicated config section:
 * - Guidelines: File-based editor (no templates)
 * - Notes: Simple multi-note storage (no templates)
 * - Local LLM: Uses promptExpander.profiles
 * - Conversation: Uses botConversation.profiles
 * - Copilot: Uses templates section (prefix/suffix)
 * - Tom AI Chat: Uses tomAiChat.templates
 * 
 * Features:
 * - Config reload on focus-in, draft save on focus-out
 * - Placeholder expansion
 * - Preview modal before sending
 * - Add/Delete template management
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getPromptExpanderManager } from './expandPrompt-handler';
import * as fs from 'fs';
import {
    getConfigPath,
    SendToChatConfig,
    loadSendToChatConfig,
    saveSendToChatConfig,
    escapeHtml,
} from './handler_shared';
import { openGlobalTemplateEditor } from './globalTemplateEditor-handler';
import {
    expandTemplate as expandPlaceholders,
    PLACEHOLDER_HELP,
} from './promptTemplate';
import {
    clearTrail, logPrompt, isTrailEnabled, loadTrailConfig,
} from './trailLogger-handler';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { WindowSessionTodoStore } from '../managers/windowSessionTodoStore';
import { QuestTodoEmbeddedViewProvider, setQuestTodosProvider, setSessionTodosProvider } from './questTodoPanel-handler';
import { WsPaths } from '../utils/workspacePaths';

// View IDs
const VIEW_IDS = {
    guidelines: 'dartscript.guidelinesNotepad',
    notes: 'dartscript.notesNotepad',
    localLlm: 'dartscript.localLlmNotepad',
    conversation: 'dartscript.conversationNotepad',
    copilot: 'dartscript.copilotNotepad',
    tomAiChat: 'dartscript.tomAiChatNotepad',
    tomNotepad: 'dartscript.tomNotepad',
    workspaceNotepad: 'dartscript.workspaceNotepad',
    workspaceTodos: 'dartscript.workspaceTodosView',
    questNotes: 'dartscript.questNotesView',
    questTodos: 'dartscript.questTodosView',
    sessionTodos: 'dartscript.sessionTodosView'
};

// Storage keys for drafts
const STORAGE_KEYS = {
    localLlmDraft: 'dartscript.dsNotes.localLlmDraft',
    localLlmProfile: 'dartscript.dsNotes.localLlmProfile',
    localLlmModel: 'dartscript.dsNotes.localLlmModel',
    conversationDraft: 'dartscript.dsNotes.conversationDraft',
    conversationProfile: 'dartscript.dsNotes.conversationProfile',
    conversationLlmProfileA: 'dartscript.dsNotes.conversationLlmProfileA',
    conversationLlmProfileB: 'dartscript.dsNotes.conversationLlmProfileB',
    copilotDraft: 'dartscript.dsNotes.copilotDraft',
    copilotTemplate: 'dartscript.dsNotes.copilotTemplate',
    tomAiChatDraft: 'dartscript.dsNotes.tomAiChatDraft',
    tomAiChatTemplate: 'dartscript.dsNotes.tomAiChatTemplate',
    notes: 'dartscript.dsNotes.notes',
    tomNotepad: 'dartscript.dsNotes.tomNotepad'
};

// ============================================================================
// Shared Styles
// ============================================================================

function getBaseStyles(): string {
    return `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            padding: 8px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-panel-background);
            color: var(--vscode-foreground);
        }
        .toolbar {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-shrink: 0;
            flex-wrap: wrap;
            align-items: center;
        }
        .toolbar-row {
            display: flex;
            gap: 4px;
            width: 100%;
            align-items: center;
            margin-bottom: 4px;
        }
        .toolbar-row label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        button, select {
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            border-radius: 2px;
            font-size: 12px;
        }
        button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.primary:hover { background-color: var(--vscode-button-hoverBackground); }
        button.danger { color: var(--vscode-errorForeground); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        button.icon-btn {
            padding: 4px 6px;
            min-width: 24px;
        }
        select {
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            flex: 1;
            min-width: 80px;
        }
        textarea {
            flex: 1;
            width: 100%;
            resize: none;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 8px;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            line-height: 1.4;
            outline: none;
        }
        textarea:focus { border-color: var(--vscode-focusBorder); }
        .status-bar {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            display: flex;
            justify-content: space-between;
        }
        .empty-state {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
        }
        .profile-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 8px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
            margin-bottom: 8px;
            max-height: 60px;
            overflow-y: auto;
        }
        .placeholder-help {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
            padding: 8px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }
        .placeholder-help code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 2px;
        }
    `;
}

// ============================================================================
// Preview Panel - Centered in VS Code
// ============================================================================

let previewPanel: vscode.WebviewPanel | undefined;

async function showPreviewPanel(title: string, content: string, onSend: (text: string) => Promise<void>): Promise<void> {
    if (previewPanel) {
        previewPanel.dispose();
    }
    
    previewPanel = vscode.window.createWebviewPanel(
        'dsNotesPreview',
        `Preview: ${title}`,
        vscode.ViewColumn.Active,
        { enableScripts: true }
    );
    
    previewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        padding: 20px;
        height: 100vh;
        display: flex;
        flex-direction: column;
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-editor-background);
        color: var(--vscode-foreground);
    }
    h2 { margin-bottom: 16px; }
    textarea {
        flex: 1;
        width: 100%;
        resize: none;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 12px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.5;
        border-radius: 4px;
    }
    .buttons {
        display: flex;
        gap: 12px;
        margin-top: 16px;
        justify-content: flex-end;
    }
    button {
        padding: 8px 16px;
        border: 1px solid var(--vscode-input-border);
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
        border-radius: 4px;
        font-size: 13px;
    }
    button:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
    button.primary {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover { background-color: var(--vscode-button-hoverBackground); }
    .info { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
</style>
</head>
<body>
    <h2>Preview</h2>
    <p class="info">Review and edit the expanded content before sending:</p>
    <textarea id="content">${escapeHtml(content)}</textarea>
    <div class="buttons">
        <button onclick="cancel()">Cancel</button>
        <button class="primary" onclick="send()">Send</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function cancel() { vscode.postMessage({ type: 'cancel' }); }
        function send() { vscode.postMessage({ type: 'send', content: document.getElementById('content').value }); }
    </script>
</body></html>`;
    
    previewPanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'cancel') {
            previewPanel?.dispose();
        } else if (msg.type === 'send') {
            await onSend(msg.content);
            previewPanel?.dispose();
        }
    });
    
    previewPanel.onDidDispose(() => {
        previewPanel = undefined;
    });
}

function getCopilotTemplateOptions(): { key: string; label: string; template: string }[] {
    const config = loadSendToChatConfig();
    const displayNames: Record<string, string> = {
        make_ws_todo: 'Make WS TODOs',
        make_quest_todo: 'Make Quest TODOs',
        make_session_todo: 'Make Session TODOs',
        analyze_ws_todo: 'Analyze WS TODOs',
        analyze_quest_todo: 'Analyze Quest TODOs',
        analyze_session_todo: 'Analyze Session TODOs',
        answer_ws_todo: 'Answer WS TODOs',
        answer_quest_todo: 'Answer Quest TODOs',
        answer_session_todo: 'Answer Session TODOs',
        implement_ws_todo: 'Implement WS TODOs',
        implement_quest_todo: 'Implement Quest TODOs',
        implement_session_todo: 'Implement Session TODOs',
    };
    const defaults: Array<{ key: string; template: string }> = [
        {
            key: 'make_ws_todo',
            template:
`Create workspace TODOs from this request.

Goals:
- Identify concrete, action-oriented tasks for workspace-level execution.
- Prefer a small set of high-value TODOs over noisy micro-steps.
- Include dependencies only when sequencing is required.

Instructions:
- Use todo IDs starting with ws_.
- Default status: not-started.
- Add tags that help discovery (e.g. [workspace, planning, implementation]).
- Keep titles short and specific.

Request:

\${originalPrompt}`,
        },
        {
            key: 'analyze_ws_todo',
            template:
`Analyze existing workspace TODOs before implementation.

Checklist:
- Detect duplicates or overlapping TODOs.
- Propose merges where appropriate.
- Identify blockers, missing dependencies, and stale items.
- Recommend priority updates (low/medium/high/critical).

Output expectations:
- Brief analysis summary.
- Concrete update suggestions.

Context:

\${originalPrompt}`,
        },
        {
            key: 'answer_ws_todo',
            template:
`Provide a concise answer focused on workspace TODO progress and outcomes.

Requirements:
- Summarize what was completed, what remains, and what is blocked.
- Reference TODO IDs when possible.
- Keep next actions explicit and actionable.

User context:

\${originalPrompt}`,
        },
        {
            key: 'implement_ws_todo',
            template:
`Implement the workspace TODO work described below.

Execution rules:
- Work from highest-priority TODOs first.
- Update statuses as work progresses.
- If scope is ambiguous, choose the smallest correct implementation.
- Capture follow-up work as new TODOs instead of leaving implicit debt.

Work request:

\${originalPrompt}`,
        },
        {
            key: 'make_quest_todo',
            template:
`Create quest TODOs from this request.

Requirements:
- Target quest-scoped files and conventions.
- Use meaningful IDs and concise titles.
- Add tags for filtering (e.g. [quest, analysis, coding, docs, tests]).
- Add dependencies only when strictly necessary.

Request:

\${originalPrompt}`,
        },
        {
            key: 'analyze_quest_todo',
            template:
`Analyze quest TODOs and recommend cleanup.

Focus areas:
- Outdated, blocked, or duplicate TODOs.
- Missing breakdown for large TODOs.
- Inconsistent statuses or priorities.
- Suggested sequencing improvements.

Context:

\${originalPrompt}`,
        },
        {
            key: 'answer_quest_todo',
            template:
`Answer with a quest TODO-centric summary.

Include:
- Current quest status snapshot.
- Completed vs pending TODOs.
- Critical blockers and decisions needed.
- Immediate next 1-3 actions.

Prompt:

\${originalPrompt}`,
        },
        {
            key: 'implement_quest_todo',
            template:
`Implement quest TODO items requested below.

Rules:
- Prioritize critical/high TODOs.
- Keep edits aligned with quest objectives.
- Update TODO status transitions clearly.
- Add minimal follow-up TODOs for deferred work.

Task details:

\${originalPrompt}`,
        },
        {
            key: 'make_session_todo',
            template:
`Create session TODO reminders from this request.

Guidance:
- Keep items short, practical, and execution-ready.
- Prefer 3-7 word titles.
- Use pending status by default.
- Add priority when urgency is clear.

Input:

\${originalPrompt}`,
        },
        {
            key: 'analyze_session_todo',
            template:
`Analyze session TODOs for this conversation.

Tasks:
- Identify stale reminders.
- Suggest merges or deletions.
- Highlight what should be done before ending session.

Context:

\${originalPrompt}`,
        },
        {
            key: 'answer_session_todo',
            template:
`Answer with session TODO progress.

Format guidance:
- What was completed this session.
- What remains pending.
- What should be carried over.

Request:

\${originalPrompt}`,
        },
        {
            key: 'implement_session_todo',
            template:
`Execute session TODO work from this request.

Rules:
- Handle highest-priority pending reminders first.
- Mark done items explicitly.
- Keep remaining items actionable for handoff.

Task:

\${originalPrompt}`,
        },
    ];

    const keyToTemplate = new Map<string, string>();
    for (const item of defaults) {
        keyToTemplate.set(item.key, item.template);
    }
    if (config?.templates) {
        for (const [key, value] of Object.entries(config.templates)) {
            keyToTemplate.set(key, value.template || '${originalPrompt}');
        }
    }

    const templates: { key: string; label: string; template: string }[] = [
        { key: '__none__', label: '(None)', template: '${originalPrompt}' },
    ];
    for (const [key, template] of keyToTemplate.entries()) {
        templates.push({
            key,
            label: key === '__answer_file__' ? 'Answer Wrapper' : (displayNames[key] || key),
            template,
        });
    }
    return templates;
}

function pickNotesTextForSend(fullText: string, selectedText?: string): string {
    if (typeof selectedText === 'string' && selectedText.length > 0) {
        return selectedText;
    }
    return fullText;
}

async function applyCopilotTemplateToNotes(
    rawNotes: string,
    selectedTemplateKey: string,
    notesFilePath: string,
): Promise<string> {
    const templates = getCopilotTemplateOptions();
    const selected = templates.find(t => t.key === selectedTemplateKey) || templates[0];
    const merged = selected.template.replace(/\$\{originalPrompt\}/g, rawNotes);
    return expandPlaceholders(merged, {
        values: {
            notesFile: notesFilePath,
        },
    });
}

async function showNotesMarkdownPreview(
    context: vscode.ExtensionContext,
    title: string,
    markdown: string,
    notesFilePath: string,
): Promise<void> {
    const expanded = await expandPlaceholders(markdown, {
        values: { notesFile: notesFilePath },
    });
    await showMarkdownHtmlPreview(context, {
        title,
        markdown: expanded,
        meta: notesFilePath,
    });
}

async function showNotesPromptPreview(
    title: string,
    rawNotes: string,
    selectedTemplateKey: string,
    notesFilePath: string,
): Promise<void> {
    const expanded = await applyCopilotTemplateToNotes(rawNotes, selectedTemplateKey, notesFilePath);
    await showPreviewPanel(title, expanded, async (text) => {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: text });
    });
}

// ============================================================================
// TOM NOTEPAD (Simple explorer notepad with send to copilot)
// Uses file at ~/.tom/notes/global_notes.md for cross-window persistence
// ============================================================================

// Default global notes path (configurable)
const GLOBAL_NOTES_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', WsPaths.homeTomFolder, 'notes', 'global_notes.md');

const DEFAULT_WORKSPACE_TODO_FILE = 'workspace.todo.yaml';
const DEFAULT_QUEST_NOTES_PATTERN = '_ai/quests/${quest}/quest-notes.${quest}.md';
const DEFAULT_QUEST_TODO_FILE_PATTERN = 'todos.${quest}.todo.yaml';

function getWorkspaceTodoRelativePath(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('notes.workspaceTodoFile')
        || vscode.workspace.getConfiguration('dartscript').get<string>('notes.workspaceTodoFile')
        || DEFAULT_WORKSPACE_TODO_FILE;
}

function getQuestNotesPattern(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('notes.questNotesFilePattern')
        || vscode.workspace.getConfiguration('dartscript').get<string>('notes.questNotesFilePattern')
        || DEFAULT_QUEST_NOTES_PATTERN;
}

function getQuestTodoFilePattern(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('notes.questTodoFilePattern')
        || vscode.workspace.getConfiguration('dartscript').get<string>('notes.questTodoFilePattern')
        || DEFAULT_QUEST_TODO_FILE_PATTERN;
}

function resolveQuestTodoFileName(questId: string): string {
    const pattern = getQuestTodoFilePattern();
    return pattern.replace(/\$\{quest\}/g, questId);
}

function resolveQuestNotesPath(questId: string, wsRoot: string): string {
    const pattern = getQuestNotesPattern();
    const rel = pattern
        .replace(/\$\{quest\}/g, questId)
        .replace(/\$\{workspaceFolder\}/g, wsRoot);
    return path.isAbsolute(rel) ? rel : path.join(wsRoot, rel);
}

function getQuestIdFromWorkspaceFile(): string {
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    if (!wsFile) { return ''; }
    return path.basename(wsFile).replace(/\.code-workspace$/, '').trim();
}

function questFolderExists(questId: string): boolean {
    if (!questId) { return false; }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return false; }
    const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
    return fs.existsSync(folder) && fs.statSync(folder).isDirectory();
}

class TomNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _content: string = '';
    private _templates: { key: string; label: string; template: string }[] = [];
    private _selectedTemplate: string = '__none__';
    private _notesFilePath: string;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];
    private _ignoreNextFileChange: boolean = false;
    private _lastSaveTime: number = 0;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._notesFilePath = GLOBAL_NOTES_PATH;
        this._selectedTemplate = this._context.workspaceState.get<string>('dartscript.dsNotes.tomNotepadTemplate') || '__none__';
        this._ensureFileExists();
        this._loadTemplates();
        this._loadContent();
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }

    private _ensureFileExists(): void {
        const dir = path.dirname(this._notesFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this._notesFilePath)) {
            fs.writeFileSync(this._notesFilePath, '', 'utf-8');
        }
    }

    private _loadContent(): void {
        try {
            if (fs.existsSync(this._notesFilePath)) {
                this._content = fs.readFileSync(this._notesFilePath, 'utf-8');
            }
        } catch {
            this._content = '';
        }
    }

    private _loadTemplates(): void {
        this._templates = getCopilotTemplateOptions();
        if (!this._templates.some(t => t.key === this._selectedTemplate)) {
            this._selectedTemplate = this._templates[0]?.key || '__none__';
        }
    }

    private _saveContent(): void {
        try {
            this._ensureFileExists();
            this._ignoreNextFileChange = true;
            this._lastSaveTime = Date.now();
            fs.writeFileSync(this._notesFilePath, this._content, 'utf-8');
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save notes: ${e}`);
        }
    }

    private _setupFileWatcher(): void {
        const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(this._notesFilePath)), path.basename(this._notesFilePath));
        this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const handleFileChange = () => {
            // Ignore if we just saved (within 1 second)
            if (this._ignoreNextFileChange || Date.now() - this._lastSaveTime < 1000) {
                this._ignoreNextFileChange = false;
                return;
            }
            this._loadContent();
            this._sendState();
        };

        this._disposables.push(
            this._fileWatcher.onDidChange(handleFileChange),
            this._fileWatcher.onDidCreate(handleFileChange),
            this._fileWatcher
        );
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        this._setupFileWatcher();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadTemplates();
                this._loadContent();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'updateContent':
                    this._content = msg.content;
                    this._saveContent();
                    break;
                case 'sendToCopilot':
                    await this._sendToCopilot(msg.selectedText);
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('dartscript.dsNotes.tomNotepadTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    await showNotesMarkdownPreview(this._context, 'VS CODE NOTES Preview', this._content, this._notesFilePath);
                    break;
                case 'previewPrompt':
                    await showNotesPromptPreview(
                        'VS CODE NOTES Prompt Preview',
                        pickNotesTextForSend(this._content, msg.selectedText),
                        this._selectedTemplate,
                        this._notesFilePath,
                    );
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(this._content);
                    vscode.window.showInformationMessage('Copied to clipboard');
                    break;
                case 'clear':
                    this._content = '';
                    this._saveContent();
                    this._sendState();
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
            }
        });
    }

    private async _openInEditor(): Promise<void> {
        this._ensureFileExists();
        const doc = await vscode.workspace.openTextDocument(this._notesFilePath);
        await vscode.window.showTextDocument(doc);
    }

    private async _sendToCopilot(selectedText?: string): Promise<void> {
        const textToSend = pickNotesTextForSend(this._content, selectedText);
        if (!textToSend.trim()) {
            vscode.window.showWarningMessage('Notepad is empty');
            return;
        }
        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._notesFilePath);
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'state',
            content: this._content,
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
            notesFilePath: this._notesFilePath,
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <select id="templateSelect" onchange="selectTemplate(this.value)"></select>
            <span id="notesFileName" style="flex:1; font-size:11px; color:var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">global_notes.md</span>
            <button class="icon-btn" onclick="previewPrompt()" title="Prompt Preview">🧠</button>
            <button class="icon-btn" onclick="previewMarkdown()" title="Preview Markdown">👁️</button>
            <button class="primary icon-btn" onclick="sendToCopilot()" title="Send to Copilot">➤</button>
            <button class="icon-btn" onclick="copy()" title="Copy to Clipboard">📋</button>
            <button class="icon-btn" onclick="openInEditor()" title="Open in Editor">📄</button>
            <button class="danger icon-btn" onclick="clear()" title="Clear">🗑️</button>
        </div>
    </div>
    <textarea id="content" placeholder="Write your notes here..." oninput="updateContent()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
        <span style="font-size:10px; color:var(--vscode-descriptionForeground);">~/${WsPaths.homeTomFolder}/notes/global_notes.md</span>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let saveTimeout;
        
        function updateContent() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                vscode.postMessage({ type: 'updateContent', content: document.getElementById('content').value });
            }, 300);
            document.getElementById('charCount').textContent = document.getElementById('content').value.length + ' chars';
        }
        function selectTemplate(key) { vscode.postMessage({ type: 'selectTemplate', key }); }
        function previewPrompt() {
            const el = document.getElementById('content');
            const start = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
            const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : 0;
            const selectedText = start !== end ? el.value.slice(start, end) : '';
            vscode.postMessage({ type: 'previewPrompt', selectedText });
        }
        function previewMarkdown() { vscode.postMessage({ type: 'previewMarkdown' }); }
        function sendToCopilot() {
            const el = document.getElementById('content');
            const start = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
            const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : 0;
            const selectedText = start !== end ? el.value.slice(start, end) : '';
            vscode.postMessage({ type: 'sendToCopilot', selectedText });
        }
        function copy() { vscode.postMessage({ type: 'copy' }); }
        function openInEditor() { vscode.postMessage({ type: 'openInEditor' }); }
        function clear() { 
            if (confirm('Clear notepad?')) {
                vscode.postMessage({ type: 'clear' }); 
            }
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                document.getElementById('content').value = e.data.content;
                document.getElementById('charCount').textContent = e.data.content.length + ' chars';
                const select = document.getElementById('templateSelect');
                const templates = e.data.templates || [];
                select.innerHTML = templates.map(t => '<option value="' + t.key + '"' + (t.key === e.data.selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>').join('');
                const fp = e.data.notesFilePath || '';
                const name = fp.split('/').pop() || fp.split('\\\\').pop() || fp;
                document.getElementById('notesFileName').textContent = name || 'global_notes.md';
                document.getElementById('notesFileName').title = fp || 'global_notes.md';
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Copilot Notepad (uses templates section)
// ============================================================================

class CopilotNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _templates: { key: string; label: string; template: string }[] = [];
    private _selectedTemplate: string = '';
    private _draft: string = '';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._loadDraft();
    }

    private _loadDraft(): void {
        this._draft = this._context.workspaceState.get<string>(STORAGE_KEYS.copilotDraft) || '';
        this._selectedTemplate = this._context.workspaceState.get<string>(STORAGE_KEYS.copilotTemplate) || '';
    }

    private async _saveDraft(): Promise<void> {
        await this._context.workspaceState.update(STORAGE_KEYS.copilotDraft, this._draft);
        await this._context.workspaceState.update(STORAGE_KEYS.copilotTemplate, this._selectedTemplate);
    }

    private _loadTemplates(): void {
        this._templates = getCopilotTemplateOptions();
        if (!this._selectedTemplate && this._templates.length > 0) {
            this._selectedTemplate = this._templates[0].key;
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        
        this._loadTemplates();
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadTemplates();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'updateDraft':
                    this._draft = msg.content;
                    await this._saveDraft();
                    break;
                case 'preview':
                    await this._preview();
                    break;
                case 'send':
                    await this._send();
                    break;
                case 'addTemplate':
                    await this._addTemplate();
                    break;
                case 'editTemplate':
                    await this._editTemplate();
                    break;
                case 'deleteTemplate':
                    await this._deleteTemplate();
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        this._view.webview.postMessage({
            type: 'state',
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
            draft: this._draft,
            templateInfo: template ? `Template: ${template.template.substring(0, 50)}...` : ''
        });
    }

    private async _preview(): Promise<void> {
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        const templateStr = template?.template || '${originalPrompt}';
        
        // Build preview showing template structure + draft
        let previewContent = '';
        if (template && template.key !== '__none__') {
            previewContent = `=== TEMPLATE: ${template?.label || 'None'} ===\n\n[TEMPLATE]\n${templateStr}\n\n[YOUR INPUT]\n${this._draft}\n\n=== FULL EXPANDED PROMPT ===\n${templateStr.replace(/\$\{originalPrompt\}/g, this._draft)}`;
        } else {
            previewContent = this._draft;
        }
        
        const expanded = await expandPlaceholders(previewContent);
        await showPreviewPanel('Copilot', expanded, async (text) => {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: text });
        });
    }

    private async _send(): Promise<void> {
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        const templateStr = template?.template || '${originalPrompt}';
        const full = templateStr.replace(/\$\{originalPrompt\}/g, this._draft);
        const expanded = await expandPlaceholders(full);
        
        // Trail: Log prompt being sent to Copilot
        loadTrailConfig();
        clearTrail('copilot');
        logPrompt('copilot', 'github_copilot', expanded, undefined, {
            template: template?.label || '(None)',
            templateKey: this._selectedTemplate || null,
            draftLength: this._draft.length,
        });
        
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
    }

    private async _addTemplate(): Promise<void> {
        await openGlobalTemplateEditor(this._context, { category: 'copilot' });
    }

    private async _editTemplate(): Promise<void> {
        if (!this._selectedTemplate) { return; }
        await openGlobalTemplateEditor(this._context, { category: 'copilot', itemId: this._selectedTemplate });
    }

    private async _deleteTemplate(): Promise<void> {
        if (!this._selectedTemplate) { return; }
        const confirm = await vscode.window.showWarningMessage(
            `Delete template "${this._selectedTemplate}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (config && config.templates[this._selectedTemplate]) {
            delete config.templates[this._selectedTemplate];
            if (saveSendToChatConfig(config)) {
                this._loadTemplates();
                this._selectedTemplate = this._templates[0]?.key || '';
                await this._saveDraft();
                this._sendState();
                vscode.window.showInformationMessage('Template deleted');
            }
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <label>Template:</label>
            <select id="templateSelect" onchange="selectTemplate(this.value)"></select>
            <button class="icon-btn" onclick="addTemplate()" title="Add Template">+</button>
            <button class="icon-btn" onclick="editTemplate()" title="Edit Template">✏️</button>
            <button class="icon-btn danger" onclick="deleteTemplate()" title="Delete Template">🗑️</button>
        </div>
        <div class="toolbar-row">
            <button onclick="preview()">Preview</button>
            <button class="primary" onclick="send()">Send to Copilot</button>
        </div>
    </div>
    <div id="templateInfo" class="profile-info" style="display:none;"></div>
    <textarea id="content" placeholder="Enter your prompt... The selected template's prefix/suffix will wrap this content." oninput="updateDraft()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
    </div>
    <div class="placeholder-help">
        <strong>Placeholders:</strong> <code>\${selection}</code>, <code>\${file}</code>, <code>\${clipboard}</code>, <code>\${date}</code>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let templates = [], selectedTemplate = '', draft = '';
        
        function selectTemplate(key) { vscode.postMessage({ type: 'selectTemplate', key }); }
        function updateDraft() {
            draft = document.getElementById('content').value;
            vscode.postMessage({ type: 'updateDraft', content: draft });
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        function preview() { vscode.postMessage({ type: 'preview' }); }
        function send() { vscode.postMessage({ type: 'send' }); }
        function addTemplate() { vscode.postMessage({ type: 'addTemplate' }); }
        function editTemplate() { vscode.postMessage({ type: 'editTemplate' }); }
        function deleteTemplate() { vscode.postMessage({ type: 'deleteTemplate' }); }
        
        function updateUI() {
            const select = document.getElementById('templateSelect');
            select.innerHTML = templates.map(t => 
                '<option value="' + t.key + '"' + (t.key === selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>'
            ).join('');
            document.getElementById('content').value = draft;
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                templates = e.data.templates;
                selectedTemplate = e.data.selectedTemplate;
                draft = e.data.draft;
                updateUI();
                const info = document.getElementById('templateInfo');
                if (e.data.templateInfo) {
                    info.textContent = e.data.templateInfo;
                    info.style.display = 'block';
                } else {
                    info.style.display = 'none';
                }
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Local LLM Notepad (uses promptExpander.profiles)
// ============================================================================

class LocalLlmNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _profiles: { key: string; label: string; description?: string; systemPrompt?: string }[] = [];
    private _selectedProfile: string = '';
    private _llmConfigs: { id: string; name: string; description: string; ollamaUrl?: string; model?: string }[] = [];
    private _selectedLlmConfig: string = '';
    private _draft: string = '';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._loadDraft();
    }

    private _loadDraft(): void {
        this._draft = this._context.workspaceState.get<string>(STORAGE_KEYS.localLlmDraft) || '';
        this._selectedProfile = this._context.workspaceState.get<string>(STORAGE_KEYS.localLlmProfile) || '';
        this._selectedLlmConfig = this._context.workspaceState.get<string>('llmSelectedConfig') || '';
    }

    private async _saveDraft(): Promise<void> {
        await this._context.workspaceState.update(STORAGE_KEYS.localLlmDraft, this._draft);
        await this._context.workspaceState.update(STORAGE_KEYS.localLlmProfile, this._selectedProfile);
        await this._context.workspaceState.update('llmSelectedConfig', this._selectedLlmConfig);
    }

    private _loadLlmConfigs(): void {
        const config = loadSendToChatConfig();
        this._llmConfigs = [];
        // Add "(Default)" option for top-level config
        this._llmConfigs.push({ 
            id: '__default__', 
            name: '(Default)', 
            description: 'Use top-level config settings',
            ollamaUrl: config?.promptExpander?.ollamaUrl || 'http://localhost:11434',
            model: config?.promptExpander?.model || 'qwen3:8b'
        });
        // Load llmConfigurations from root level of config
        if (Array.isArray(config?.llmConfigurations)) {
            for (const lc of config.llmConfigurations) {
                if (lc && typeof lc.id === 'string') {
                    this._llmConfigs.push({
                        id: lc.id,
                        name: lc.name || lc.id,
                        description: `${lc.model || 'unknown'} @ ${lc.ollamaUrl || 'localhost'}`,
                        ollamaUrl: lc.ollamaUrl,
                        model: lc.model
                    });
                }
            }
        }
        if (!this._selectedLlmConfig && this._llmConfigs.length > 0) {
            // Find config with isDefault or use first
            const defaultConfig = Array.isArray(config?.llmConfigurations) 
                ? config.llmConfigurations.find((c: any) => c.isDefault)?.id
                : undefined;
            this._selectedLlmConfig = defaultConfig || this._llmConfigs[0].id;
        }
    }

    private _loadProfiles(): void {
        const config = loadSendToChatConfig();
        this._profiles = [];
        // Add "(None)" option for raw prompt
        this._profiles.push({ key: '__none__', label: '(None)', description: 'Send prompt as-is', systemPrompt: undefined });
        if (config?.promptExpander?.profiles) {
            for (const [key, value] of Object.entries(config.promptExpander.profiles)) {
                this._profiles.push({
                    key,
                    label: value.label || key,
                    description: value.systemPrompt?.substring(0, 100) || '',
                    systemPrompt: value.systemPrompt || undefined
                });
            }
        }
        if (!this._selectedProfile && this._profiles.length > 0) {
            this._selectedProfile = this._profiles[0].key;
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        
        this._loadLlmConfigs();
        this._loadProfiles();
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadLlmConfigs();
                this._loadProfiles();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'selectLlmConfig':
                    this._selectedLlmConfig = msg.id;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'selectProfile':
                    this._selectedProfile = msg.key;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'updateDraft':
                    this._draft = msg.content;
                    await this._saveDraft();
                    break;
                case 'preview':
                    await this._preview();
                    break;
                case 'send':
                    await this._send();
                    break;
                case 'showTrail':
                    await this._showTrail();
                    break;
                case 'addProfile':
                    await this._addProfile();
                    break;
                case 'editProfile':
                    await this._editProfile();
                    break;
                case 'deleteProfile':
                    await this._deleteProfile();
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        const llmConfig = this._llmConfigs.find(c => c.id === this._selectedLlmConfig);
        this._view.webview.postMessage({
            type: 'state',
            llmConfigs: this._llmConfigs,
            selectedLlmConfig: this._selectedLlmConfig,
            llmConfigInfo: llmConfig ? `${llmConfig.model || 'unknown'} @ ${llmConfig.ollamaUrl || 'localhost'}` : '',
            profiles: this._profiles,
            selectedProfile: this._selectedProfile,
            draft: this._draft,
            profileInfo: profile?.description || ''
        });
    }

    private async _preview(): Promise<void> {
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        const expandedUser = await expandPlaceholders(this._draft);
        
        // If there's a system prompt, show both; title indicates profile
        // The editable area should contain exactly what will be sent
        let previewContent = '';
        let title = `Local LLM - ${profile?.label || 'Default'}`;
        
        if (profile?.systemPrompt) {
            const expandedSystem = await expandPlaceholders(profile.systemPrompt);
            // User prompt is what gets sent, system prompt is separate API param
            previewContent = expandedUser;
            title += ' (has system prompt)';
        } else {
            previewContent = expandedUser;
        }
        
        await showPreviewPanel(title, previewContent, async (text) => {
            // Send the edited text
            await this._sendExpanded(text);
        });
    }

    private async _send(): Promise<void> {
        const expanded = await expandPlaceholders(this._draft);
        await this._sendExpanded(expanded);
    }

    private async _sendExpanded(text: string): Promise<void> {
        const manager = getPromptExpanderManager();
        if (!manager) {
            vscode.window.showErrorMessage('Local LLM not available - extension not fully initialized');
            return;
        }
        
        // Use __none__ as null profile for raw prompt
        const profileKey = this._selectedProfile === '__none__' ? null : this._selectedProfile;
        const profileLabel = this._selectedProfile === '__none__' ? 'None' : this._selectedProfile;
        
        // Use __default__ as null LLM config for top-level settings
        const llmConfigId = this._selectedLlmConfig === '__default__' ? null : this._selectedLlmConfig;
        
        // Resolve model name for status messages
        const modelName = manager.getResolvedModelName(llmConfigId || undefined);
        
        try {
            // Check if model needs loading (uses default config URL for checking)
            const modelLoaded = await manager.checkModelLoaded(modelName);
            
            const result = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: modelLoaded ? `Sending to local ${modelName}...` : `Loading ${modelName}...`,
                    cancellable: true,
                },
                async (progress, token) => {
                    if (!modelLoaded) {
                        const checkInterval = setInterval(async () => {
                            const loaded = await manager.checkModelLoaded(modelName);
                            if (loaded) {
                                progress.report({ message: `Processing prompt with ${modelName}...` });
                                clearInterval(checkInterval);
                            }
                        }, 2000);
                        token.onCancellationRequested(() => clearInterval(checkInterval));
                    } else {
                        progress.report({ message: `Processing prompt with ${modelName}...` });
                    }
                    return manager.process(text, profileKey, llmConfigId, undefined, token);
                }
            );
            
            if (result.success) {
                // Write to trail file
                await this._appendToTrail(text, result.result, profileLabel);
                // Open the trail file
                await this._showTrail();
            } else {
                vscode.window.showErrorMessage(`Local LLM error: ${result.error || 'Unknown error'}`);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Local LLM failed: ${e}`);
        }
    }

    private _getTrailFilePath(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }
        return WsPaths.ai('local', 'chat_trail.md') || path.join(workspaceFolder.uri.fsPath, '_ai', 'local', 'chat_trail.md');
    }

    private async _appendToTrail(prompt: string, response: string, profile: string): Promise<void> {
        const trailPath = this._getTrailFilePath();
        if (!trailPath) {
            vscode.window.showWarningMessage('No workspace folder - cannot save to trail file');
            return;
        }
        
        // Ensure directory exists
        const dir = path.dirname(trailPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Build entry
        const timestamp = new Date().toISOString();
        const entry = `\n---\n\n## ${timestamp} (${profile})\n\n### Prompt\n\n${prompt}\n\n### Response\n\n${response}\n`;
        
        // Append to file
        fs.appendFileSync(trailPath, entry, 'utf-8');
    }

    private async _showTrail(): Promise<void> {
        const trailPath = this._getTrailFilePath();
        if (!trailPath) {
            vscode.window.showWarningMessage('No workspace folder');
            return;
        }
        
        if (!fs.existsSync(trailPath)) {
            // Create empty file with header
            const dir = path.dirname(trailPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(trailPath, '# Local LLM Chat Trail\n\nConversation history with local LLM.\n', 'utf-8');
        }
        
        const doc = await vscode.workspace.openTextDocument(trailPath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async _addProfile(): Promise<void> {
        await openGlobalTemplateEditor(this._context, { category: 'localLlm' });
    }

    private async _editProfile(): Promise<void> {
        if (!this._selectedProfile) { return; }
        await openGlobalTemplateEditor(this._context, { category: 'localLlm', itemId: this._selectedProfile });
    }

    private async _deleteProfile(): Promise<void> {
        if (!this._selectedProfile) { return; }
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${profile?.label || this._selectedProfile}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (config?.promptExpander?.profiles?.[this._selectedProfile]) {
            delete config.promptExpander.profiles[this._selectedProfile];
            if (saveSendToChatConfig(config)) {
                this._loadProfiles();
                this._selectedProfile = this._profiles[0]?.key || '';
                await this._saveDraft();
                this._sendState();
                vscode.window.showInformationMessage('Profile deleted');
            }
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <label>LLM Config:</label>
            <select id="llmConfigSelect" onchange="selectLlmConfig(this.value)"></select>
        </div>
        <div class="toolbar-row">
            <label>Profile:</label>
            <select id="profileSelect" onchange="selectProfile(this.value)"></select>
            <button class="icon-btn" onclick="addProfile()" title="Add Profile">+</button>
            <button class="icon-btn" onclick="editProfile()" title="Edit Profile">✏️</button>
            <button class="icon-btn danger" onclick="deleteProfile()" title="Delete Profile">🗑️</button>
        </div>
        <div class="toolbar-row">
            <button class="icon-btn" onclick="preview()" title="Prompt Preview">🧠</button>
            <button class="primary icon-btn" onclick="send()" title="Send to LLM">➤</button>
            <button class="icon-btn" onclick="showTrail()" title="Open chat trail file">📜</button>
        </div>
    </div>
    <div id="llmConfigInfo" class="model-info" style="display:none; font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 4px;"></div>
    <div id="profileInfo" class="profile-info" style="display:none;"></div>
    <textarea id="content" placeholder="Enter your prompt for the local LLM..." oninput="updateDraft()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
    </div>
    <div class="placeholder-help">
        <strong>Placeholders:</strong> <code>\${selection}</code>, <code>\${file}</code>, <code>\${clipboard}</code>, <code>\${date}</code>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let llmConfigs = [], selectedLlmConfig = '', profiles = [], selectedProfile = '', draft = '';
        
        function selectLlmConfig(id) { vscode.postMessage({ type: 'selectLlmConfig', id }); }
        function selectProfile(key) { vscode.postMessage({ type: 'selectProfile', key }); }
        function updateDraft() {
            draft = document.getElementById('content').value;
            vscode.postMessage({ type: 'updateDraft', content: draft });
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        function preview() { vscode.postMessage({ type: 'preview' }); }
        function send() { vscode.postMessage({ type: 'send' }); }
        function showTrail() { vscode.postMessage({ type: 'showTrail' }); }
        function addProfile() { vscode.postMessage({ type: 'addProfile' }); }
        function editProfile() { vscode.postMessage({ type: 'editProfile' }); }
        function deleteProfile() { vscode.postMessage({ type: 'deleteProfile' }); }
        
        function updateUI() {
            const llmConfigSel = document.getElementById('llmConfigSelect');
            llmConfigSel.innerHTML = llmConfigs.map(c => 
                '<option value="' + c.id + '"' + (c.id === selectedLlmConfig ? ' selected' : '') + '>' + c.name + '</option>'
            ).join('');
            const select = document.getElementById('profileSelect');
            select.innerHTML = profiles.map(p => 
                '<option value="' + p.key + '"' + (p.key === selectedProfile ? ' selected' : '') + '>' + p.label + '</option>'
            ).join('');
            document.getElementById('content').value = draft;
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                llmConfigs = e.data.llmConfigs || [];
                selectedLlmConfig = e.data.selectedLlmConfig || '';
                profiles = e.data.profiles;
                selectedProfile = e.data.selectedProfile;
                draft = e.data.draft;
                updateUI();
                const llmConfigInfo = document.getElementById('llmConfigInfo');
                if (e.data.llmConfigInfo) {
                    llmConfigInfo.textContent = e.data.llmConfigInfo;
                    llmConfigInfo.style.display = 'block';
                } else {
                    llmConfigInfo.style.display = 'none';
                }
                const info = document.getElementById('profileInfo');
                if (e.data.profileInfo) {
                    info.textContent = e.data.profileInfo;
                    info.style.display = 'block';
                } else {
                    info.style.display = 'none';
                }
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Conversation Notepad (uses botConversation.profiles)
// ============================================================================

class ConversationNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _profiles: { key: string; label: string; description?: string; maxTurns?: number; initialPromptTemplate?: string }[] = [];
    private _selectedProfile: string = '';
    private _draft: string = '';
    // AI Conversation Setup selection
    private _aiSetups: { id: string; name: string; description: string; llmConfigA: string; llmConfigB: string; maxTurns?: number; historyMode?: string; trailSummarizationTemperature?: number }[] = [];
    private _selectedAiSetup: string = '';
    private _conversationMode: 'ollama-copilot' | 'ollama-ollama' = 'ollama-copilot';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._loadDraft();
    }

    private _loadDraft(): void {
        this._draft = this._context.workspaceState.get<string>(STORAGE_KEYS.conversationDraft) || '';
        this._selectedProfile = this._context.workspaceState.get<string>(STORAGE_KEYS.conversationProfile) || '';
        this._selectedAiSetup = this._context.workspaceState.get<string>('conversationAiSetup') || '';
    }

    private async _saveDraft(): Promise<void> {
        await this._context.workspaceState.update(STORAGE_KEYS.conversationDraft, this._draft);
        await this._context.workspaceState.update(STORAGE_KEYS.conversationProfile, this._selectedProfile);
        await this._context.workspaceState.update('conversationAiSetup', this._selectedAiSetup);
    }

    private _loadAiSetups(): void {
        const config = loadSendToChatConfig();
        this._aiSetups = [];
        // Add "(Default)" option
        this._aiSetups.push({ 
            id: '__default__', 
            name: '(Default)', 
            description: 'Use default settings',
            llmConfigA: '__default__',
            llmConfigB: '__default__'
        });
        // Load aiConversationSetups from root level of config
        if (Array.isArray(config?.aiConversationSetups)) {
            for (const setup of config.aiConversationSetups) {
                if (setup && typeof setup.id === 'string') {
                    this._aiSetups.push({
                        id: setup.id,
                        name: setup.name || setup.id,
                        description: `A: ${setup.llmConfigA || 'default'} | B: ${setup.llmConfigB || 'default'}`,
                        llmConfigA: setup.llmConfigA || '__default__',
                        llmConfigB: setup.llmConfigB || '__default__',
                        maxTurns: setup.maxTurns,
                        historyMode: setup.historyMode
                    });
                }
            }
        }
        // Also load mode from config
        const botConfig = (loadSendToChatConfig() as any)?.botConversation;
        this._conversationMode = botConfig?.conversationMode || 'ollama-copilot';
        
        // Set default if not selected
        if (!this._selectedAiSetup && this._aiSetups.length > 0) {
            const defaultSetup = Array.isArray(config?.aiConversationSetups)
                ? config.aiConversationSetups.find((s: any) => s.isDefault)?.id
                : undefined;
            this._selectedAiSetup = defaultSetup || this._aiSetups[0].id;
        }
    }

    private _loadProfiles(): void {
        const config = loadSendToChatConfig();
        this._profiles = [];
        // Add "(None)" option for raw prompt
        this._profiles.push({ key: '__none__', label: '(None)', description: 'Send prompt as-is', maxTurns: undefined, initialPromptTemplate: undefined });
        if (config?.botConversation?.profiles) {
            for (const [key, value] of Object.entries(config.botConversation.profiles)) {
                this._profiles.push({
                    key,
                    label: value.label || key,
                    description: value.description || value.goal || '',
                    maxTurns: value.maxTurns,
                    initialPromptTemplate: value.initialPromptTemplate || undefined
                });
            }
        }
        if (!this._selectedProfile && this._profiles.length > 0) {
            this._selectedProfile = this._profiles[0].key;
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        
        this._loadProfiles();
        this._loadAiSetups();
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadProfiles();
                this._loadAiSetups();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'selectProfile':
                    this._selectedProfile = msg.key;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'selectAiSetup':
                    this._selectedAiSetup = msg.id;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'updateDraft':
                    this._draft = msg.content;
                    await this._saveDraft();
                    break;
                case 'preview':
                    await this._preview();
                    break;
                case 'startConversation':
                    await this._startConversation();
                    break;
                case 'addProfile':
                    await this._addProfile();
                    break;
                case 'editProfile':
                    await this._editProfile();
                    break;
                case 'deleteProfile':
                    await this._deleteProfile();
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        const aiSetup = this._aiSetups.find(s => s.id === this._selectedAiSetup);
        this._view.webview.postMessage({
            type: 'state',
            profiles: this._profiles,
            selectedProfile: this._selectedProfile,
            draft: this._draft,
            profileInfo: profile ? `${profile.description}${profile.maxTurns ? ` (max ${profile.maxTurns} turns)` : ''}` : '',
            aiSetups: this._aiSetups,
            selectedAiSetup: this._selectedAiSetup,
            aiSetupInfo: aiSetup ? aiSetup.description : '',
            conversationMode: this._conversationMode
        });
    }

    private async _preview(): Promise<void> {
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        let content = this._draft;
        
        // Build preview showing template + draft interaction
        let previewContent = '';
        if (profile?.initialPromptTemplate) {
            // Replace ${goal} with draft in template
            previewContent = profile.initialPromptTemplate.replace(/\$\{goal\}/gi, this._draft);
            // If template doesn't contain ${goal}, append draft
            if (!profile.initialPromptTemplate.toLowerCase().includes('${goal}')) {
                previewContent = `=== TEMPLATE (${profile.label}) ===\n${profile.initialPromptTemplate}\n\n=== YOUR INPUT ===\n${this._draft}`;
            }
        } else {
            previewContent = `=== Profile: ${profile?.label || 'None'} ===\n\n${this._draft}`;
        }
        
        const expanded = await expandPlaceholders(previewContent);
        await showPreviewPanel('AI Conversation', expanded, async (text) => {
            await this._startConversationWithGoal(text);
        });
    }

    private async _startConversation(): Promise<void> {
        const expanded = await expandPlaceholders(this._draft);
        await this._startConversationWithGoal(expanded);
    }

    private async _startConversationWithGoal(goal: string): Promise<void> {
        // Use null for __none__ profile to send raw prompt
        const profileKey = this._selectedProfile === '__none__' ? null : this._selectedProfile;
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        
        // Resolve AI Conversation Setup for llmConfigA/B
        const aiSetup = this._aiSetups.find(s => s.id === this._selectedAiSetup);
        const llmConfigA = aiSetup?.llmConfigA === '__default__' ? null : aiSetup?.llmConfigA;
        const llmConfigB = aiSetup?.llmConfigB === '__default__' ? null : aiSetup?.llmConfigB;
        
        // Trail: Log conversation start
        loadTrailConfig();
        logPrompt('conversation', 'bot_conversation', goal, undefined, {
            profile: profile?.label || '(None)',
            profileKey: profileKey || null,
            maxTurns: aiSetup?.maxTurns || profile?.maxTurns || 10,
            aiSetup: aiSetup?.name || '(Default)',
            llmConfigA: llmConfigA || '(Default)',
            llmConfigB: llmConfigB || '(Default)',
        });
        
        try {
            // Build params including AI Setup's LLM config selection
            const params: Record<string, any> = {
                goal,
                profileKey,
            };
            // For ollama-copilot, use llmConfigA as the main modelConfig
            // For ollama-ollama, we pass selfTalk persona overrides
            if (this._conversationMode === 'ollama-copilot') {
                if (llmConfigA) {
                    params.modelConfig = llmConfigA;
                }
            } else if (this._conversationMode === 'ollama-ollama') {
                // Pass selfTalk overrides for both personas
                params.selfTalkOverrides = {
                    personA: llmConfigA ? { modelConfig: llmConfigA } : undefined,
                    personB: llmConfigB ? { modelConfig: llmConfigB } : undefined,
                };
            }
            
            await vscode.commands.executeCommand('tomAi.aiConversation.start', params);
        } catch {
            vscode.window.showInformationMessage(`Start conversation (profile: ${profileKey || 'None'}): ${goal.substring(0, 50)}...`);
        }
    }

    private async _addProfile(): Promise<void> {
        await openGlobalTemplateEditor(this._context, { category: 'conversation' });
    }

    private async _editProfile(): Promise<void> {
        if (!this._selectedProfile) { return; }
        await openGlobalTemplateEditor(this._context, { category: 'conversation', itemId: this._selectedProfile });
    }

    private async _deleteProfile(): Promise<void> {
        if (!this._selectedProfile) { return; }
        const profile = this._profiles.find(p => p.key === this._selectedProfile);
        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${profile?.label || this._selectedProfile}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (config?.botConversation?.profiles?.[this._selectedProfile]) {
            delete config.botConversation.profiles[this._selectedProfile];
            if (saveSendToChatConfig(config)) {
                this._loadProfiles();
                this._selectedProfile = this._profiles[0]?.key || '';
                await this._saveDraft();
                this._sendState();
                vscode.window.showInformationMessage('Profile deleted');
            }
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <label>Profile:</label>
            <select id="profileSelect" onchange="selectProfile(this.value)"></select>
            <button class="icon-btn" onclick="addProfile()" title="Add Profile">+</button>
            <button class="icon-btn" onclick="editProfile()" title="Edit Profile">✏️</button>
            <button class="icon-btn danger" onclick="deleteProfile()" title="Delete Profile">🗑️</button>
        </div>
        <div class="toolbar-row">
            <label>AI Setup:</label>
            <select id="aiSetupSelect" onchange="selectAiSetup(this.value)" title="AI Conversation Setup (LLM A/B, max turns, history mode)"></select>
        </div>
        <div class="toolbar-row">
            <button class="icon-btn" onclick="preview()" title="Prompt Preview">🧠</button>
            <button class="primary icon-btn" onclick="startConversation()" title="Start Conversation">▶</button>
        </div>
    </div>
    <div id="profileInfo" class="profile-info" style="display:none;"></div>
    <div id="aiSetupInfo" class="model-info" style="display:none; font-size: 10px; color: var(--vscode-descriptionForeground); padding: 2px 4px;"></div>
    <textarea id="content" placeholder="Enter your goal/description for the conversation..." oninput="updateDraft()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
    </div>
    <div class="placeholder-help">
        <strong>Tip:</strong> Describe the goal clearly. The bot will orchestrate a multi-turn conversation.
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let profiles = [], selectedProfile = '', draft = '';
        let aiSetups = [], selectedAiSetup = '', conversationMode = 'ollama-copilot';
        
        function selectProfile(key) { vscode.postMessage({ type: 'selectProfile', key }); }
        function selectAiSetup(id) { vscode.postMessage({ type: 'selectAiSetup', id }); }
        function updateDraft() {
            draft = document.getElementById('content').value;
            vscode.postMessage({ type: 'updateDraft', content: draft });
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        function preview() { vscode.postMessage({ type: 'preview' }); }
        function startConversation() { vscode.postMessage({ type: 'startConversation' }); }
        function addProfile() { vscode.postMessage({ type: 'addProfile' }); }
        function editProfile() { vscode.postMessage({ type: 'editProfile' }); }
        function deleteProfile() { vscode.postMessage({ type: 'deleteProfile' }); }
        
        function updateUI() {
            const select = document.getElementById('profileSelect');
            select.innerHTML = profiles.map(p => 
                '<option value="' + p.key + '"' + (p.key === selectedProfile ? ' selected' : '') + '>' + p.label + '</option>'
            ).join('');
            
            // AI Setup dropdown
            const aiSetupSelect = document.getElementById('aiSetupSelect');
            aiSetupSelect.innerHTML = aiSetups.map(s =>
                '<option value="' + s.id + '"' + (s.id === selectedAiSetup ? ' selected' : '') + '>' + s.name + '</option>'
            ).join('');
            
            document.getElementById('content').value = draft;
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                profiles = e.data.profiles;
                selectedProfile = e.data.selectedProfile;
                draft = e.data.draft;
                aiSetups = e.data.aiSetups || [];
                selectedAiSetup = e.data.selectedAiSetup || '';
                conversationMode = e.data.conversationMode || 'ollama-copilot';
                updateUI();
                const info = document.getElementById('profileInfo');
                if (e.data.profileInfo) {
                    info.textContent = e.data.profileInfo;
                    info.style.display = 'block';
                } else {
                    info.style.display = 'none';
                }
                const aiSetupInfo = document.getElementById('aiSetupInfo');
                if (e.data.aiSetupInfo) {
                    aiSetupInfo.textContent = e.data.aiSetupInfo;
                    aiSetupInfo.style.display = 'block';
                } else {
                    aiSetupInfo.style.display = 'none';
                }
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Tom AI Chat Notepad (uses tomAiChat.templates)
// ============================================================================

class TomAiChatNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _templates: { key: string; label: string; description?: string; contextInstructions?: string }[] = [];
    private _selectedTemplate: string = '';
    private _draft: string = '';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._loadDraft();
    }

    private _loadDraft(): void {
        this._draft = this._context.workspaceState.get<string>(STORAGE_KEYS.tomAiChatDraft) || '';
        this._selectedTemplate = this._context.workspaceState.get<string>(STORAGE_KEYS.tomAiChatTemplate) || '';
    }

    private async _saveDraft(): Promise<void> {
        await this._context.workspaceState.update(STORAGE_KEYS.tomAiChatDraft, this._draft);
        await this._context.workspaceState.update(STORAGE_KEYS.tomAiChatTemplate, this._selectedTemplate);
    }

    private _loadTemplates(): void {
        const config = loadSendToChatConfig();
        this._templates = [];
        
        // Add "(None)" option for raw prompt
        this._templates.push({ key: '__none__', label: '(None)', description: 'Send prompt as-is', contextInstructions: '' });
        
        if (config?.tomAiChat?.templates) {
            for (const [key, value] of Object.entries(config.tomAiChat.templates)) {
                this._templates.push({
                    key,
                    label: value.label || key,
                    description: value.description || '',
                    contextInstructions: value.contextInstructions || ''
                });
            }
        }
        
        if (this._templates.length === 1) {
            // Only "(None)" exists, add defaults
            this._templates.push(
                { key: 'standard', label: 'Standard', description: 'General-purpose prompt', contextInstructions: '' },
                { key: 'implement', label: 'Implement', description: 'Implement a feature', contextInstructions: 'Focus on implementation, testing, and documentation.' },
                { key: 'debug', label: 'Debug', description: 'Debug an issue', contextInstructions: 'Focus on finding root cause and fixing the issue.' }
            );
        }
        
        if (!this._selectedTemplate && this._templates.length > 0) {
            this._selectedTemplate = this._templates[0].key;
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        
        this._loadTemplates();
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadTemplates();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key;
                    await this._saveDraft();
                    this._sendState();
                    break;
                case 'updateDraft':
                    this._draft = msg.content;
                    await this._saveDraft();
                    break;
                case 'preview':
                    await this._preview();
                    break;
                case 'insertToChatFile':
                    await this._insertToChatFile();
                    break;
                case 'openChatFile':
                    await this._openOrCreateChatFile();
                    break;
                case 'addTemplate':
                    await this._addTemplate();
                    break;
                case 'editTemplate':
                    await this._editTemplate();
                    break;
                case 'deleteTemplate':
                    await this._deleteTemplate();
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        this._view.webview.postMessage({
            type: 'state',
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
            draft: this._draft,
            templateInfo: template ? `${template.description}${template.contextInstructions ? '\n' + template.contextInstructions : ''}` : ''
        });
    }

    private async _preview(): Promise<void> {
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        let content = this._draft;
        if (template?.contextInstructions) {
            content = template.contextInstructions + '\n\n' + content;
        }
        const expanded = await expandPlaceholders(content);
        await showPreviewPanel('Tom AI Chat', expanded, async (text) => {
            await this._insertExpandedToChatFile(text);
        });
    }

    private async _insertToChatFile(): Promise<void> {
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        let content = this._draft;
        if (template?.contextInstructions) {
            content = template.contextInstructions + '\n\n' + content;
        }
        const expanded = await expandPlaceholders(content);
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

    private async _openOrCreateChatFile(): Promise<void> {
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

    private async _addTemplate(): Promise<void> {
        await openGlobalTemplateEditor(this._context, { category: 'tomAiChat' });
    }

    private async _editTemplate(): Promise<void> {
        if (!this._selectedTemplate) { return; }
        await openGlobalTemplateEditor(this._context, { category: 'tomAiChat', itemId: this._selectedTemplate });
    }

    private async _deleteTemplate(): Promise<void> {
        if (!this._selectedTemplate) { return; }
        const template = this._templates.find(t => t.key === this._selectedTemplate);
        const confirm = await vscode.window.showWarningMessage(
            `Delete template "${template?.label || this._selectedTemplate}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        const config = loadSendToChatConfig();
        if (config?.tomAiChat?.templates?.[this._selectedTemplate]) {
            delete config.tomAiChat.templates[this._selectedTemplate];
            if (saveSendToChatConfig(config)) {
                this._loadTemplates();
                this._selectedTemplate = this._templates[0]?.key || '';
                await this._saveDraft();
                this._sendState();
                vscode.window.showInformationMessage('Template deleted');
            }
        }
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <label>Template:</label>
            <select id="templateSelect" onchange="selectTemplate(this.value)"></select>
            <button class="icon-btn" onclick="addTemplate()" title="Add Template">+</button>
            <button class="icon-btn" onclick="editTemplate()" title="Edit Template">✏️</button>
            <button class="icon-btn danger" onclick="deleteTemplate()" title="Delete Template">🗑️</button>
        </div>
        <div class="toolbar-row">
            <button onclick="openChatFile()">Open Chat</button>
            <button class="icon-btn" onclick="preview()" title="Prompt Preview">🧠</button>
            <button class="primary" onclick="insertToChatFile()">Insert</button>
        </div>
    </div>
    <div id="templateInfo" class="profile-info" style="display:none;"></div>
    <textarea id="content" placeholder="Enter your prompt for Tom AI Chat..." oninput="updateDraft()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
    </div>
    <div class="placeholder-help">
        <strong>Tip:</strong> Write your prompt, then click "Insert" to add it to an open .chat.md file.
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let templates = [], selectedTemplate = '', draft = '';
        
        function selectTemplate(key) { vscode.postMessage({ type: 'selectTemplate', key }); }
        function updateDraft() {
            draft = document.getElementById('content').value;
            vscode.postMessage({ type: 'updateDraft', content: draft });
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        function preview() { vscode.postMessage({ type: 'preview' }); }
        function insertToChatFile() { vscode.postMessage({ type: 'insertToChatFile' }); }
        function openChatFile() { vscode.postMessage({ type: 'openChatFile' }); }
        function addTemplate() { vscode.postMessage({ type: 'addTemplate' }); }
        function editTemplate() { vscode.postMessage({ type: 'editTemplate' }); }
        function deleteTemplate() { vscode.postMessage({ type: 'deleteTemplate' }); }
        
        function updateUI() {
            const select = document.getElementById('templateSelect');
            select.innerHTML = templates.map(t => 
                '<option value="' + t.key + '"' + (t.key === selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>'
            ).join('');
            document.getElementById('content').value = draft;
            document.getElementById('charCount').textContent = draft.length + ' chars';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                templates = e.data.templates;
                selectedTemplate = e.data.selectedTemplate;
                draft = e.data.draft;
                updateUI();
                const info = document.getElementById('templateInfo');
                if (e.data.templateInfo) {
                    info.textContent = e.data.templateInfo;
                    info.style.display = 'block';
                } else {
                    info.style.display = 'none';
                }
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Notes Notepad (simple multi-note storage, no templates)
// ============================================================================

interface NoteItem {
    id: string;
    title: string;
    filePath: string;
    content: string;
}

// Default notes folder (configurable via settings)
const NOTES_FOLDER = WsPaths.aiRelative('notes');

class NotesNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _notes: NoteItem[] = [];
    private _activeNoteId: string | null = null;
    private _notesFolder: string | null = null;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._initNotesFolder();
        this._loadNotes();
        // Remember active note ID
        this._activeNoteId = this._context.workspaceState.get<string>('dartscript.dsNotes.activeNoteFile') || null;
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }

    private _initNotesFolder(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this._notesFolder = path.join(workspaceFolder.uri.fsPath, NOTES_FOLDER);
            // Create folder if it doesn't exist
            if (!fs.existsSync(this._notesFolder)) {
                fs.mkdirSync(this._notesFolder, { recursive: true });
            }
        }
    }

    private _setupFileWatcher(): void {
        if (!this._notesFolder) { return; }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const pattern = new vscode.RelativePattern(workspaceFolder, `${NOTES_FOLDER}/*.md`);
        this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const reload = () => {
            this._loadNotes();
            this._sendState();
        };

        this._disposables.push(
            this._fileWatcher.onDidCreate(reload),
            this._fileWatcher.onDidDelete(reload),
            this._fileWatcher.onDidChange((uri) => {
                if (this._activeNoteId && uri.fsPath.endsWith(this._activeNoteId)) {
                    this._sendState();
                }
            }),
            this._fileWatcher
        );
    }

    private _loadNotes(): void {
        if (!this._notesFolder) { return; }
        try {
            const files = fs.readdirSync(this._notesFolder)
                .filter(f => f.endsWith('.md'))
                .sort();
            this._notes = files.map(f => ({
                id: f,
                title: f.replace(/\.md$/, ''),
                filePath: path.join(this._notesFolder!, f),
                content: ''
            }));
        } catch {
            this._notes = [];
        }
    }

    private _loadNoteContent(noteId: string): string {
        const note = this._notes.find(n => n.id === noteId);
        if (!note) { return ''; }
        try {
            return fs.readFileSync(note.filePath, 'utf-8');
        } catch {
            return '';
        }
    }

    private _saveNoteContent(noteId: string, content: string): void {
        const note = this._notes.find(n => n.id === noteId);
        if (!note) { return; }
        try {
            fs.writeFileSync(note.filePath, content, 'utf-8');
            note.content = content;
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save note: ${e}`);
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        this._setupFileWatcher();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadNotes();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'requestAddNote':
                    await this._requestAddNote();
                    break;
                case 'selectNote':
                    this._activeNoteId = msg.id;
                    await this._context.workspaceState.update('dartscript.dsNotes.activeNoteFile', this._activeNoteId);
                    this._sendState();
                    break;
                case 'deleteNote':
                    await this._deleteNote(msg.id);
                    break;
                case 'updateContent':
                    if (this._activeNoteId) {
                        this._saveNoteContent(this._activeNoteId, msg.content);
                    }
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
                case 'previewMarkdown': {
                    if (this._activeNoteId) {
                        const note = this._notes.find(n => n.id === this._activeNoteId);
                        if (note) {
                            await showNotesMarkdownPreview(this._context, `Documentation Preview: ${note.title}`, this._loadNoteContent(this._activeNoteId), note.filePath);
                        }
                    }
                    break;
                }
            }
        });
    }

    private async _requestAddNote(): Promise<void> {
        const fileName = await vscode.window.showInputBox({
            prompt: 'Note file name (no path, no extension)',
            placeHolder: 'my_note',
            validateInput: (value) => {
                if (!value) { return 'File name is required'; }
                if (value.includes('/') || value.includes('\\\\')) { return 'Path separators not allowed'; }
                if (value.includes('.')) { return 'Extension not allowed (will be .md)'; }
                return null;
            }
        });
        if (fileName) {
            await this._addNote(fileName);
        }
    }

    private async _addNote(fileName: string): Promise<void> {
        if (!this._notesFolder) { return; }
        const filePath = path.join(this._notesFolder, `${fileName}.md`);
        
        if (fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`Note "${fileName}.md" already exists`);
            return;
        }
        
        try {
            fs.writeFileSync(filePath, '', 'utf-8');
            this._loadNotes();
            this._activeNoteId = `${fileName}.md`;
            await this._context.workspaceState.update('dartscript.dsNotes.activeNoteFile', this._activeNoteId);
            this._sendState();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to create note: ${e}`);
        }
    }

    private async _deleteNote(id: string): Promise<void> {
        const note = this._notes.find(n => n.id === id);
        if (!note) { return; }
        
        const confirm = await vscode.window.showWarningMessage(
            `Delete note "${note.title}"? This will delete the file.`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }
        
        try {
            fs.unlinkSync(note.filePath);
            this._loadNotes();
            if (this._activeNoteId === id) {
                this._activeNoteId = this._notes.length > 0 ? this._notes[0].id : null;
                await this._context.workspaceState.update('dartscript.dsNotes.activeNoteFile', this._activeNoteId);
            }
            this._sendState();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to delete note: ${e}`);
        }
    }

    private async _openInEditor(): Promise<void> {
        if (!this._activeNoteId) { return; }
        const note = this._notes.find(n => n.id === this._activeNoteId);
        if (!note) { return; }
        
        const doc = await vscode.workspace.openTextDocument(note.filePath);
        await vscode.window.showTextDocument(doc);
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const content = this._activeNoteId ? this._loadNoteContent(this._activeNoteId) : '';
        this._view.webview.postMessage({
            type: 'state',
            notes: this._notes.map(n => ({ id: n.id, title: n.title })),
            activeNoteId: this._activeNoteId,
            content
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <select id="noteSelect" onchange="selectNote(this.value)"></select>
            <button class="icon-btn" onclick="addNote()" title="Add Note">+</button>
            <button class="icon-btn" onclick="previewMarkdown()" title="Preview Markdown">👁️</button>
            <button class="icon-btn" onclick="openInEditor()" title="Open in Editor">📄</button>
            <button class="icon-btn danger" onclick="deleteNote()" title="Delete Note">🗑️</button>
        </div>
    </div>
    <div id="emptyState" class="empty-state" style="display:none;">
        No notes yet. Click "+" to create one.
    </div>
    <textarea id="content" placeholder="Write your notes here..." oninput="updateContent()"></textarea>
    <div class="status-bar">
        <span id="charCount">0 chars</span>
        <span id="location" style="font-size:10px; color:var(--vscode-descriptionForeground);">${WsPaths.aiRelative('notes')}/</span>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let notes = [], activeNoteId = null;
        let saveTimeout;
        
        function addNote() { vscode.postMessage({ type: 'requestAddNote' }); }
        function selectNote(id) { vscode.postMessage({ type: 'selectNote', id }); }
        function previewMarkdown() { vscode.postMessage({ type: 'previewMarkdown' }); }
        function openInEditor() { vscode.postMessage({ type: 'openInEditor' }); }
        function deleteNote() {
            if (activeNoteId) {
                vscode.postMessage({ type: 'deleteNote', id: activeNoteId });
            }
        }
        function updateContent() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                vscode.postMessage({ type: 'updateContent', content: document.getElementById('content').value });
            }, 500);
            document.getElementById('charCount').textContent = document.getElementById('content').value.length + ' chars';
        }
        
        function updateUI() {
            const select = document.getElementById('noteSelect');
            const textarea = document.getElementById('content');
            const empty = document.getElementById('emptyState');
            
            select.innerHTML = notes.map(n => 
                '<option value="' + n.id + '"' + (n.id === activeNoteId ? ' selected' : '') + '>' + n.title + '</option>'
            ).join('');
            
            empty.style.display = notes.length === 0 ? 'flex' : 'none';
            textarea.style.display = notes.length > 0 ? 'block' : 'none';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                notes = e.data.notes;
                activeNoteId = e.data.activeNoteId;
                document.getElementById('content').value = e.data.content;
                document.getElementById('charCount').textContent = e.data.content.length + ' chars';
                updateUI();
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Guidelines Notepad (file-based, no templates)
// ============================================================================

class GuidelinesNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _files: { path: string; name: string }[] = [];
    private _activeFilePath: string | null = null;
    private _content: string = '';
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _context: vscode.ExtensionContext) {}

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        this._setupFileWatcher();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadFiles();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._loadFiles();
                    this._sendState();
                    break;
                case 'selectFile':
                    this._activeFilePath = msg.path;
                    this._loadContent();
                    this._sendState();
                    break;
                case 'saveContent':
                    await this._saveContent(msg.content);
                    break;
                case 'addFile':
                    await this._addFile();
                    break;
                case 'deleteFile':
                    await this._deleteFile(msg.path);
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
                case 'previewMarkdown':
                    if (this._activeFilePath) {
                        await showNotesMarkdownPreview(this._context, 'Guidelines Preview', this._content, this._activeFilePath);
                    }
                    break;
                case 'reload':
                    this._loadFiles();
                    this._sendState();
                    break;
            }
        });
    }

    private _setupFileWatcher(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const pattern = new vscode.RelativePattern(workspaceFolder, `${WsPaths.guidelinesFolder}/**/*.md`);
        this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const reload = () => {
            this._loadFiles();
            this._sendState();
        };

        this._disposables.push(
            this._fileWatcher.onDidCreate(reload),
            this._fileWatcher.onDidDelete(reload),
            this._fileWatcher.onDidChange((uri) => {
                if (uri.fsPath === this._activeFilePath) {
                    this._loadContent();
                    this._sendState();
                }
            }),
            this._fileWatcher
        );
    }

    private _loadFiles(): void {
        this._files = [];
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const rootPath = workspaceFolder.uri.fsPath;

        const instructionsPath = WsPaths.github('copilot-instructions.md') || path.join(rootPath, '.github', 'copilot-instructions.md');
        if (fs.existsSync(instructionsPath)) {
            this._files.push({ path: instructionsPath, name: '📋 copilot-instructions.md' });
        }

        const guidelinesDir = WsPaths.guidelines() || path.join(rootPath, '_copilot_guidelines');
        if (fs.existsSync(guidelinesDir)) {
            const files = fs.readdirSync(guidelinesDir).filter(f => f.endsWith('.md')).sort();
            for (const file of files) {
                const filePath = path.join(guidelinesDir, file);
                if (fs.statSync(filePath).isFile()) {
                    this._files.push({ path: filePath, name: file });
                }
            }
        }

        if (this._files.length > 0 && !this._activeFilePath) {
            this._activeFilePath = this._files[0].path;
        }
        this._loadContent();
    }

    private _loadContent(): void {
        if (this._activeFilePath && fs.existsSync(this._activeFilePath)) {
            this._content = fs.readFileSync(this._activeFilePath, 'utf-8');
        } else {
            this._content = '';
        }
    }

    private async _saveContent(content: string): Promise<void> {
        if (this._activeFilePath) {
            fs.writeFileSync(this._activeFilePath, content, 'utf-8');
            this._content = content;
        }
    }

    private async _addFile(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'Guideline file name',
            placeHolder: 'my_guideline.md'
        });
        if (!name) { return; }

        let fileName = name.trim();
        if (!fileName.endsWith('.md')) { fileName += '.md'; }

        const guidelinesDir = WsPaths.guidelines() || path.join(workspaceFolder.uri.fsPath, '_copilot_guidelines');
        if (!fs.existsSync(guidelinesDir)) {
            fs.mkdirSync(guidelinesDir, { recursive: true });
        }

        const filePath = path.join(guidelinesDir, fileName);
        if (fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`File ${fileName} already exists`);
            return;
        }

        const title = fileName.replace('.md', '').replace(/_/g, ' ');
        fs.writeFileSync(filePath, `# ${title}\n\n`, 'utf-8');
        
        this._loadFiles();
        this._activeFilePath = filePath;
        this._loadContent();
        this._sendState();
        vscode.window.showInformationMessage(`Created ${fileName}`);
    }

    private async _deleteFile(filePath: string): Promise<void> {
        const file = this._files.find(f => f.path === filePath);
        if (!file || file.name.includes('copilot-instructions.md')) {
            vscode.window.showErrorMessage('Cannot delete this file');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Delete "${file.name}"?`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return; }

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        this._loadFiles();
        this._sendState();
        vscode.window.showInformationMessage('File deleted');
    }

    private async _openInEditor(): Promise<void> {
        if (this._activeFilePath && fs.existsSync(this._activeFilePath)) {
            const doc = await vscode.workspace.openTextDocument(this._activeFilePath);
            await vscode.window.showTextDocument(doc);
        }
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'state',
            files: this._files,
            activeFilePath: this._activeFilePath,
            content: this._content
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head>
<body>
    <div class="toolbar">
        <div class="toolbar-row">
            <select id="fileSelect" onchange="selectFile(this.value)" style="flex:1;"></select>
            <button class="icon-btn" onclick="reload()" title="Reload">🔄</button>
        </div>
        <div class="toolbar-row">
            <button class="icon-btn" onclick="addFile()" title="Add File">+</button>
            <button class="icon-btn danger" onclick="deleteFile()" title="Delete File">🗑️</button>
            <button class="icon-btn" onclick="previewMarkdown()" title="Preview Markdown">👁️</button>
            <button onclick="openInEditor()">Open in Editor</button>
        </div>
    </div>
    <div id="emptyState" class="empty-state" style="display:none;">
        No guideline files found.
    </div>
    <textarea id="content" placeholder="Guideline content..." oninput="saveContent()"></textarea>
    <div class="status-bar">
        <span id="fileName">-</span>
        <span id="charCount">0 chars</span>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let files = [], activeFilePath = null;
        let saveTimeout;
        
        function selectFile(path) { vscode.postMessage({ type: 'selectFile', path }); }
        function reload() { vscode.postMessage({ type: 'reload' }); }
        function addFile() { vscode.postMessage({ type: 'addFile' }); }
        function deleteFile() {
            if (activeFilePath) {
                vscode.postMessage({ type: 'deleteFile', path: activeFilePath });
            }
        }
        function previewMarkdown() { vscode.postMessage({ type: 'previewMarkdown' }); }
        function openInEditor() { vscode.postMessage({ type: 'openInEditor' }); }
        function saveContent() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                vscode.postMessage({ type: 'saveContent', content: document.getElementById('content').value });
            }, 500);
            document.getElementById('charCount').textContent = document.getElementById('content').value.length + ' chars';
        }
        
        function updateUI() {
            const select = document.getElementById('fileSelect');
            const textarea = document.getElementById('content');
            const empty = document.getElementById('emptyState');
            const fileName = document.getElementById('fileName');
            
            select.innerHTML = files.map(f => 
                '<option value="' + f.path + '"' + (f.path === activeFilePath ? ' selected' : '') + '>' + f.name + '</option>'
            ).join('');
            
            empty.style.display = files.length === 0 ? 'flex' : 'none';
            textarea.style.display = files.length > 0 ? 'block' : 'none';
            
            const active = files.find(f => f.path === activeFilePath);
            fileName.textContent = active?.name || '-';
        }
        
        window.addEventListener('message', e => {
            if (e.data.type === 'state') {
                files = e.data.files;
                activeFilePath = e.data.activeFilePath;
                document.getElementById('content').value = e.data.content;
                document.getElementById('charCount').textContent = e.data.content.length + ' chars';
                updateUI();
            }
        });
        
        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

// ============================================================================
// Workspace Notepad (file-based, stored in workspace root as notes.md)
// ============================================================================

class WorkspaceNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _content: string = '';
    private _templates: { key: string; label: string; template: string }[] = [];
    private _selectedTemplate: string = '__none__';
    private _notesFilePath: string | null = null;
    private _fileWatcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];
    private _ignoreNextFileChange: boolean = false;
    private _lastSaveTime: number = 0;

    private static readonly STORAGE_KEY = 'workspaceNotesPath';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._selectedTemplate = this._context.workspaceState.get<string>('dartscript.dsNotes.workspaceNotepadTemplate') || '__none__';
        this._loadTemplates();
        this._initNotesFilePath();
    }

    private _loadTemplates(): void {
        this._templates = getCopilotTemplateOptions();
        if (!this._templates.some(t => t.key === this._selectedTemplate)) {
            this._selectedTemplate = this._templates[0]?.key || '__none__';
        }
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
    }

    /** Detect workspace and resolve the notes file path from workspace state. */
    private _initNotesFilePath(): void {
        const storedPath = this._context.workspaceState.get<string>(WorkspaceNotepadProvider.STORAGE_KEY);
        if (storedPath && fs.existsSync(storedPath)) {
            this._notesFilePath = storedPath;
        } else if (storedPath) {
            // Stored path no longer exists — clear it
            this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, undefined);
            this._notesFilePath = null;
        }
        // Fallback: try to find notes.md in workspace root if nothing stored
        if (!this._notesFilePath) {
            const wsRoot = this._getWorkspaceRoot();
            if (wsRoot) {
                const defaultPath = path.join(wsRoot, 'notes.md');
                if (fs.existsSync(defaultPath)) {
                    this._notesFilePath = defaultPath;
                    this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, defaultPath);
                }
            }
        }
    }

    /** Returns true if a .code-workspace file is open. */
    private _hasWorkspaceFile(): boolean {
        return !!vscode.workspace.workspaceFile;
    }

    /** Get workspace name from the .code-workspace filename (without extension). */
    private _getWorkspaceName(): string {
        const wsFile = vscode.workspace.workspaceFile;
        if (wsFile) {
            const base = path.basename(wsFile.fsPath);
            return base.replace(/\.code-workspace$/, '');
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder ? path.basename(folder.uri.fsPath) : 'Workspace';
    }

    /** Get the first workspace folder root path. */
    private _getWorkspaceRoot(): string | undefined {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder?.uri.fsPath;
    }

    private _loadContent(): void {
        if (!this._notesFilePath) { return; }
        try {
            if (fs.existsSync(this._notesFilePath)) {
                this._content = fs.readFileSync(this._notesFilePath, 'utf-8');
            } else {
                this._content = '';
            }
        } catch {
            this._content = '';
        }
    }

    private _saveContent(): void {
        if (!this._notesFilePath) { return; }
        try {
            this._ignoreNextFileChange = true;
            this._lastSaveTime = Date.now();
            fs.writeFileSync(this._notesFilePath, this._content, 'utf-8');
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save notes: ${e}`);
        }
    }

    private _setupFileWatcher(): void {
        // Dispose existing watcher
        if (this._fileWatcher) {
            this._fileWatcher.dispose();
            this._fileWatcher = undefined;
        }
        if (!this._notesFilePath) { return; }
        const folder = vscode.workspace.workspaceFolders?.find(
            f => this._notesFilePath!.startsWith(f.uri.fsPath)
        );
        if (!folder) { return; }

        const relPath = path.relative(folder.uri.fsPath, this._notesFilePath);
        const pattern = new vscode.RelativePattern(folder, relPath);
        this._fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const handleFileChange = () => {
            if (this._ignoreNextFileChange || Date.now() - this._lastSaveTime < 1000) {
                this._ignoreNextFileChange = false;
                return;
            }
            this._loadContent();
            this._sendState();
        };

        this._disposables.push(
            this._fileWatcher.onDidChange(handleFileChange),
            this._fileWatcher.onDidCreate(handleFileChange),
            this._fileWatcher
        );
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        this._loadContent();
        this._loadTemplates();
        this._setupFileWatcher();
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadContent();
                this._loadTemplates();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'updateContent':
                    this._content = msg.content;
                    this._saveContent();
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
                case 'sendToCopilot':
                    await this._sendToCopilot(msg.selectedText);
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('dartscript.dsNotes.workspaceNotepadTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    if (this._notesFilePath) {
                        await showNotesMarkdownPreview(this._context, 'WORKSPACE NOTES Preview', this._content, this._notesFilePath);
                    }
                    break;
                case 'previewPrompt':
                    if (this._notesFilePath) {
                        await showNotesPromptPreview(
                            'WORKSPACE NOTES Prompt Preview',
                            pickNotesTextForSend(this._content, msg.selectedText),
                            this._selectedTemplate,
                            this._notesFilePath,
                        );
                    }
                    break;
                case 'createNotesFile':
                    await this._createNotesFile();
                    break;
                case 'changeFile':
                    await this._changeFile();
                    break;
                case 'openWorkspace':
                    await vscode.commands.executeCommand('workbench.action.openWorkspace');
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const wsName = this._getWorkspaceName();
        const hasWorkspace = this._hasWorkspaceFile() || !!vscode.workspace.workspaceFolders?.length;
        this._view.webview.postMessage({
            type: 'state',
            content: this._content,
            filePath: this._notesFilePath,
            workspaceName: wsName,
            hasWorkspace,
            hasFile: !!this._notesFilePath && fs.existsSync(this._notesFilePath),
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
        });
    }

    private async _sendToCopilot(selectedText?: string): Promise<void> {
        const textToSend = pickNotesTextForSend(this._content, selectedText);
        if (!this._notesFilePath || !textToSend.trim()) {
            vscode.window.showWarningMessage('Workspace notes are empty');
            return;
        }
        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._notesFilePath);
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
    }

    private async _openInEditor(): Promise<void> {
        if (!this._notesFilePath) {
            vscode.window.showErrorMessage('No notes file configured');
            return;
        }
        if (!fs.existsSync(this._notesFilePath)) {
            fs.writeFileSync(this._notesFilePath, '', 'utf-8');
        }
        const doc = await vscode.workspace.openTextDocument(this._notesFilePath);
        await vscode.window.showTextDocument(doc);
    }

    /** Prompt user to create a new notes file via save dialog. */
    private async _createNotesFile(): Promise<void> {
        const wsRoot = this._getWorkspaceRoot();
        const wsName = this._getWorkspaceName();
        const defaultUri = wsRoot ? vscode.Uri.file(path.join(wsRoot, 'notes.md')) : undefined;
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Markdown': ['md'], 'Text': ['txt'], 'All Files': ['*'] },
            title: 'Create Workspace Notes File',
        });
        if (!uri) { return; }
        const filePath = uri.fsPath;
        const header = `# Workspace Notes — ${wsName}\n\n`;
        fs.writeFileSync(filePath, header, 'utf-8');
        this._notesFilePath = filePath;
        this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, filePath);
        this._loadContent();
        this._setupFileWatcher();
        this._sendState();
    }

    /** Prompt user to pick a different notes file. */
    private async _changeFile(): Promise<void> {
        const wsRoot = this._getWorkspaceRoot();
        const defaultUri = wsRoot ? vscode.Uri.file(wsRoot) : undefined;
        const uris = await vscode.window.showOpenDialog({
            defaultUri,
            canSelectMany: false,
            filters: { 'Markdown': ['md'], 'Text': ['txt'], 'All Files': ['*'] },
            title: 'Select Workspace Notes File',
        });
        if (!uris || uris.length === 0) { return; }
        const filePath = uris[0].fsPath;
        this._notesFilePath = filePath;
        this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, filePath);
        this._loadContent();
        this._setupFileWatcher();
        this._sendState();
    }

    private _getHtml(): string {
        const wsName = this._getWorkspaceName();
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${getBaseStyles()}
.ws-header { font-size: 10px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; text-align: center; color: var(--vscode-descriptionForeground); padding: 16px; }
.empty-state .message { font-size: 12px; line-height: 1.4; }
.empty-state button { min-width: 140px; }
</style></head>
<body>
    <div id="headerBar" class="toolbar" style="display:none;">
        <div class="ws-header" id="wsHeader"></div>
        <div class="toolbar-row">
            <select id="templateSelect" onchange="selectTemplate(this.value)"></select>
            <span id="fileName" style="flex:1; font-size:11px; color:var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
            <button class="icon-btn" onclick="previewPrompt()" title="Prompt Preview">🧠</button>
            <button class="icon-btn" onclick="previewMarkdown()" title="Preview Markdown">👁️</button>
            <button class="primary icon-btn" onclick="sendToCopilot()" title="Send to Copilot">➤</button>
            <button class="icon-btn" onclick="changeFile()" title="Change file...">📁</button>
            <button class="icon-btn" onclick="openInEditor()" title="Open in Editor">📄</button>
        </div>
    </div>
    <div id="noWorkspace" class="empty-state" style="display:none;">
        <div class="message">No workspace is open</div>
        <button class="primary" onclick="openWorkspace()">Open Workspace...</button>
    </div>
    <div id="noFile" class="empty-state" style="display:none;">
        <div class="message">No workspace notes file configured</div>
        <button class="primary" onclick="createNotesFile()">Create Notes File</button>
        <button onclick="changeFile()">Select Existing File...</button>
    </div>
    <textarea id="content" style="display:none;" placeholder="Workspace notes..." oninput="updateContent()"></textarea>
    <div id="statusBar" class="status-bar" style="display:none;">
        <span id="charCount">0 chars</span>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let content = '';
        let saveTimeout;

        function updateContent() {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                vscode.postMessage({ type: 'updateContent', content: document.getElementById('content').value });
            }, 500);
            document.getElementById('charCount').textContent = document.getElementById('content').value.length + ' chars';
        }
        function selectTemplate(key) { vscode.postMessage({ type: 'selectTemplate', key }); }
        function sendToCopilot() {
            const el = document.getElementById('content');
            const start = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
            const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : 0;
            const selectedText = start !== end ? el.value.slice(start, end) : '';
            vscode.postMessage({ type: 'sendToCopilot', selectedText });
        }
        function previewPrompt() {
            const el = document.getElementById('content');
            const start = typeof el.selectionStart === 'number' ? el.selectionStart : 0;
            const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : 0;
            const selectedText = start !== end ? el.value.slice(start, end) : '';
            vscode.postMessage({ type: 'previewPrompt', selectedText });
        }
        function previewMarkdown() { vscode.postMessage({ type: 'previewMarkdown' }); }
        function openInEditor() { vscode.postMessage({ type: 'openInEditor' }); }
        function createNotesFile() { vscode.postMessage({ type: 'createNotesFile' }); }
        function changeFile() { vscode.postMessage({ type: 'changeFile' }); }
        function openWorkspace() { vscode.postMessage({ type: 'openWorkspace' }); }

        function applyState(data) {
            const headerBar = document.getElementById('headerBar');
            const noWorkspace = document.getElementById('noWorkspace');
            const noFile = document.getElementById('noFile');
            const contentEl = document.getElementById('content');
            const statusBar = document.getElementById('statusBar');
            const wsHeader = document.getElementById('wsHeader');
            const fileName = document.getElementById('fileName');
            const templateSelect = document.getElementById('templateSelect');

            // Hide all states
            headerBar.style.display = 'none';
            noWorkspace.style.display = 'none';
            noFile.style.display = 'none';
            contentEl.style.display = 'none';
            statusBar.style.display = 'none';

            if (!data.hasWorkspace) {
                noWorkspace.style.display = 'flex';
                return;
            }
            if (!data.hasFile) {
                noFile.style.display = 'flex';
                return;
            }
            // Show editor
            headerBar.style.display = '';
            contentEl.style.display = '';
            statusBar.style.display = '';
            wsHeader.textContent = 'Workspace Notes — ' + (data.workspaceName || 'Workspace');
            const templates = data.templates || [];
            templateSelect.innerHTML = templates.map(t => '<option value="' + t.key + '"' + (t.key === data.selectedTemplate ? ' selected' : '') + '>' + t.label + '</option>').join('');
            const fp = data.filePath || 'notes.md';
            fileName.textContent = fp.split('/').pop() || fp.split('\\\\').pop() || fp;
            fileName.title = fp;
            content = data.content || '';
            contentEl.value = content;
            document.getElementById('charCount').textContent = content.length + ' chars';
        }

        window.addEventListener('message', e => {
            if (e.data.type === 'state') { applyState(e.data); }
        });

        document.addEventListener('DOMContentLoaded', () => vscode.postMessage({ type: 'ready' }));
    </script>
</body></html>`;
    }
}

class QuestNotesProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _content = '';
    private _filePath: string | null = null;
    private _selectedTemplate = '__none__';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._selectedTemplate = this._context.workspaceState.get<string>('dartscript.dsNotes.questNotesTemplate') || '__none__';
    }

    private _resolveQuestFile(): string | null {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot || !vscode.workspace.workspaceFile) { return null; }
        const questId = getQuestIdFromWorkspaceFile();
        if (!questId) { return null; }
        if (!questFolderExists(questId)) { return null; }
        return resolveQuestNotesPath(questId, wsRoot);
    }

    private _load(): void {
        this._filePath = this._resolveQuestFile();
        if (!this._filePath) { this._content = ''; return; }
        const dir = path.dirname(this._filePath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        if (!fs.existsSync(this._filePath)) {
            const questId = getQuestIdFromWorkspaceFile() || 'quest';
            fs.writeFileSync(this._filePath, `# Quest Notes — ${questId}\n\n`, 'utf-8');
        }
        this._content = fs.readFileSync(this._filePath, 'utf-8');
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._load();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._load();
                    this._sendState();
                    break;
                case 'updateContent':
                    this._content = msg.content || '';
                    if (this._filePath) { fs.writeFileSync(this._filePath, this._content, 'utf-8'); }
                    break;
                case 'openInEditor':
                    if (this._filePath) {
                        const doc = await vscode.workspace.openTextDocument(this._filePath);
                        await vscode.window.showTextDocument(doc);
                    }
                    break;
                case 'sendToCopilot':
                    if (this._filePath && this._content.trim()) {
                        const textToSend = pickNotesTextForSend(this._content, msg.selectedText);
                        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._filePath);
                        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
                    }
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('dartscript.dsNotes.questNotesTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    if (this._filePath) {
                        await showNotesMarkdownPreview(this._context, 'QUEST NOTES Preview', this._content, this._filePath);
                    }
                    break;
                case 'previewPrompt':
                    if (this._filePath) {
                        await showNotesPromptPreview(
                            'QUEST NOTES Prompt Preview',
                            pickNotesTextForSend(this._content, msg.selectedText),
                            this._selectedTemplate,
                            this._filePath,
                        );
                    }
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const templates = getCopilotTemplateOptions();
        this._view.webview.postMessage({
            type: 'state',
            content: this._content,
            filePath: this._filePath,
            hasWorkspaceFile: !!vscode.workspace.workspaceFile,
            templates,
            selectedTemplate: this._selectedTemplate,
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${getBaseStyles()}</style></head><body>
<div id="toolbar" class="toolbar" style="display:none;">
    <div class="toolbar-row"><select id="templateSelect" onchange="selectTemplate(this.value)"></select><span id="fileName" style="flex:1; font-size:11px; color:var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">-</span><button class="icon-btn" onclick="previewPrompt()" title="Prompt Preview">🧠</button><button class="icon-btn" onclick="previewMarkdown()" title="Preview Markdown">👁️</button><button class="primary icon-btn" onclick="sendToCopilot()" title="Send to Copilot">➤</button><button class="icon-btn" onclick="openInEditor()" title="Open in Editor">📄</button></div>
</div>
<div id="empty" class="empty-state" style="display:none;">Open a quest .code-workspace file. If its quest folder does not exist, QUEST NOTES stays hidden.</div>
<textarea id="content" style="display:none;" oninput="updateContent()"></textarea>
<div id="status" class="status-bar" style="display:none;"><span id="charCount">0 chars</span></div>
<script>
const vscode = acquireVsCodeApi(); let saveTimeout;
function updateContent(){ clearTimeout(saveTimeout); saveTimeout=setTimeout(()=>vscode.postMessage({type:'updateContent',content:document.getElementById('content').value}),300); document.getElementById('charCount').textContent=document.getElementById('content').value.length+' chars'; }
function openInEditor(){vscode.postMessage({type:'openInEditor'});} function sendToCopilot(){const el=document.getElementById('content'); const s=typeof el.selectionStart==='number'?el.selectionStart:0; const e=typeof el.selectionEnd==='number'?el.selectionEnd:0; const selectedText=s!==e?el.value.slice(s,e):''; vscode.postMessage({type:'sendToCopilot', selectedText});} function selectTemplate(key){vscode.postMessage({type:'selectTemplate',key});} function previewMarkdown(){vscode.postMessage({type:'previewMarkdown'});} function previewPrompt(){const el=document.getElementById('content'); const s=typeof el.selectionStart==='number'?el.selectionStart:0; const e=typeof el.selectionEnd==='number'?el.selectionEnd:0; const selectedText=s!==e?el.value.slice(s,e):''; vscode.postMessage({type:'previewPrompt', selectedText});} 
window.addEventListener('message',e=>{ if(e.data.type!=='state')return; const ok=e.data.hasWorkspaceFile&&e.data.filePath; document.getElementById('toolbar').style.display=ok?'':'none'; document.getElementById('content').style.display=ok?'':'none'; document.getElementById('status').style.display=ok?'':'none'; document.getElementById('empty').style.display=ok?'none':'flex'; if(!ok)return; document.getElementById('content').value=e.data.content||''; document.getElementById('charCount').textContent=(e.data.content||'').length+' chars'; const fp=(e.data.filePath||''); const fn=fp.split('/').pop()||fp.split('\\\\').pop()||fp; document.getElementById('fileName').textContent=fn||'-'; document.getElementById('fileName').title=fp||''; const sel=document.getElementById('templateSelect'); const t=e.data.templates||[]; sel.innerHTML=t.map(x=>'<option value="'+x.key+'"'+(x.key===e.data.selectedTemplate?' selected':'')+'>'+x.label+'</option>').join(''); });
document.addEventListener('DOMContentLoaded',()=>vscode.postMessage({type:'ready'}));
</script></body></html>`;
    }
}

class SessionTodosProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready' || msg.type === 'refresh') {
                this._sendState();
            } else if (msg.type === 'toggleDone') {
                const item = WindowSessionTodoStore.instance.get(msg.id);
                if (item) {
                    WindowSessionTodoStore.instance.update(msg.id, { status: item.status === 'done' ? 'pending' : 'done' });
                }
                this._sendState();
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({ type: 'state', todos: WindowSessionTodoStore.instance.list({ status: 'all' }) });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${getBaseStyles()} .todo{display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border);} .done{opacity:0.6;text-decoration:line-through;}</style></head><body>
<div class="toolbar"><div class="toolbar-row"><button class="icon-btn" onclick="refresh()" title="Refresh">🔄</button></div></div>
<div id="list" style="flex:1;overflow:auto;"></div>
<script>
const vscode=acquireVsCodeApi(); function refresh(){vscode.postMessage({type:'refresh'});} function toggle(id){vscode.postMessage({type:'toggleDone',id});}
window.addEventListener('message',e=>{ if(e.data.type!=='state')return; const todos=e.data.todos||[]; document.getElementById('list').innerHTML=todos.length?todos.map(t=>'<div class="todo '+(t.status==='done'?'done':'')+'"><input type="checkbox" '+(t.status==='done'?'checked':'')+' onchange="toggle(\''+t.id+'\')"><span>'+t.title+'</span></div>').join(''):'<div class="empty-state">No session todos</div>';});
document.addEventListener('DOMContentLoaded',()=>vscode.postMessage({type:'ready'}));
</script></body></html>`;
    }
}

// ============================================================================
// Registration
// ============================================================================

let tomNotepadProvider: TomNotepadProvider | undefined;
let workspaceNotepadProvider: WorkspaceNotepadProvider | undefined;
let questNotesProvider: QuestNotesProvider | undefined;

export function registerDsNotesViews(context: vscode.ExtensionContext): void {
    // Explorer panel views
    tomNotepadProvider = new TomNotepadProvider(context);
    workspaceNotepadProvider = new WorkspaceNotepadProvider(context);
    questNotesProvider = new QuestNotesProvider(context);

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    vscode.commands.executeCommand('setContext', 'dartscript.hasWorkspaceFile', !!vscode.workspace.workspaceFile);
    const workspaceTodoPath = wsRoot ? path.join(wsRoot, getWorkspaceTodoRelativePath()) : getWorkspaceTodoRelativePath();

    const workspaceQuestId = getQuestIdFromWorkspaceFile();
    const questExists = questFolderExists(workspaceQuestId);
    const resolvedQuestId = workspaceQuestId && questExists ? workspaceQuestId : '__invalid_quest__';
    const questTodoFile = workspaceQuestId ? resolveQuestTodoFileName(workspaceQuestId) : 'all';
    const questLabel = workspaceQuestId
        ? (questExists ? `${workspaceQuestId}/${questTodoFile}` : `Quest doesn't exist`)
        : 'Active quest not set';

    const workspaceTodosProvider = new QuestTodoEmbeddedViewProvider(context.extensionUri, context, {
        mode: 'workspace-file',
        fixedFilePath: workspaceTodoPath,
        fixedFileLabel: getWorkspaceTodoRelativePath(),
        hideQuestSelect: true,
        hideFileSelect: true,
    });
    const questTodosProvider = new QuestTodoEmbeddedViewProvider(context.extensionUri, context, {
        mode: 'fixed-file',
        fixedQuestId: resolvedQuestId,
        fixedFile: questTodoFile,
        fixedFileLabel: questLabel,
        hideQuestSelect: true,
        hideFileSelect: true,
        disableFileActions: !workspaceQuestId || !questExists,
    });
    setQuestTodosProvider(questTodosProvider);
    const sessionTodosProvider = new QuestTodoEmbeddedViewProvider(context.extensionUri, context, {
        mode: 'session',
        fixedFileLabel: 'Session (*.todo.yaml)',
        hideQuestSelect: true,
        hideFileSelect: true,
    });
    setSessionTodosProvider(sessionTodosProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(VIEW_IDS.tomNotepad, tomNotepadProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.workspaceNotepad, workspaceNotepadProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.workspaceTodos, workspaceTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.questNotes, questNotesProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.questTodos, questTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerWebviewViewProvider(VIEW_IDS.sessionTodos, sessionTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('dartscript.focusTomAI', async () => {
            // Focus the unified TOM AI panel
            await vscode.commands.executeCommand('dartscript.chatPanel.focus');
        })
    );
}

export { tomNotepadProvider, workspaceNotepadProvider };
