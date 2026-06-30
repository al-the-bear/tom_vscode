/**
 * Sidebar notepad WebviewView providers for the @TOM sidebar.
 *
 * Three live providers, each backed by a file on disk:
 * - TomNotepad     — global notes (`~/.tom/notes/global_notes.md`).
 * - WorkspaceNotepad — a user-chosen workspace notes file.
 * - QuestNotes     — per-quest notes, path derived from the active quest.
 *
 * Each supports template-wrapped "send to Copilot", markdown preview, and a
 * shared preview-before-send modal ({@link showPreviewPanel}). The webview
 * HTML/JS/CSS lives in `media/sidebarNotes/<provider>/` + `media/shared/
 * notepadBase.css` and is loaded via {@link loadWebviewHtml}; data flows by
 * `postMessage` (`ready` → `state`), so there is no inline HTML in this file.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    loadSendToChatConfig,
    getExtensionPath,
} from './handler_shared';
import {
    expandTemplate as expandPlaceholders,
} from './promptTemplate';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { QuestTodoEmbeddedViewProvider, setQuestTodosProvider, setSessionTodosProvider } from './questTodoPanel-handler';
import { WsPaths } from '../utils/workspacePaths';
import { NotepadFileStorage } from './notepad/notepadFileStorage';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';

// View IDs
const VIEW_IDS = {
    tomNotepad: 'tomAi.vscodeNotes',
    workspaceNotepad: 'tomAi.workspaceNotes',
    workspaceTodos: 'tomAi.workspaceTodos',
    questNotes: 'tomAi.questNotes',
    questTodos: 'tomAi.questTodos',
    sessionTodos: 'tomAi.sessionTodos'
};

// ============================================================================
// Preview Panel - Centered in VS Code
// ============================================================================

let previewPanel: vscode.WebviewPanel | undefined;

async function showPreviewPanel(title: string, content: string, onSend: (text: string) => Promise<void>): Promise<void> {
    if (previewPanel) {
        previewPanel.dispose();
    }
    
    const mediaRoot = vscode.Uri.file(path.join(getExtensionPath() || '', 'media'));
    previewPanel = vscode.window.createWebviewPanel(
        'dsNotesPreview',
        `Preview: ${title}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [mediaRoot] }
    );

    previewPanel.webview.html = loadWebviewHtml(previewPanel.webview, 'sidebarNotes/preview', {
        init: { content },
    });
    wireCompletionMessages(previewPanel.webview);

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
    if (config?.copilot?.templates) {
        for (const [key, value] of Object.entries(config.copilot.templates)) {
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
    return vscode.workspace.getConfiguration('tomAi').get<string>('todo.workspaceTodoFile')
        || vscode.workspace.getConfiguration('tomAi').get<string>('todo.workspaceTodoFile')
        || DEFAULT_WORKSPACE_TODO_FILE;
}

function getQuestNotesPattern(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('notes.questNotesPattern')
        || vscode.workspace.getConfiguration('tomAi').get<string>('notes.questNotesPattern')
        || DEFAULT_QUEST_NOTES_PATTERN;
}

function getQuestTodoFilePattern(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('todo.questTodoPattern')
        || vscode.workspace.getConfiguration('tomAi').get<string>('todo.questTodoPattern')
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
    private _templates: { key: string; label: string; template: string }[] = [];
    private _selectedTemplate: string = '__none__';
    private readonly _storage: NotepadFileStorage;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._storage = new NotepadFileStorage(GLOBAL_NOTES_PATH);
        this._selectedTemplate = this._context.workspaceState.get<string>('tomAi.notes.tomNotepadTemplate') || '__none__';
        this._storage.ensureFile();
        this._loadTemplates();
        this._storage.load();
    }

    dispose(): void {
        this._storage.dispose();
    }

    private _loadTemplates(): void {
        this._templates = getCopilotTemplateOptions();
        if (!this._templates.some(t => t.key === this._selectedTemplate)) {
            this._selectedTemplate = this._templates[0]?.key || '__none__';
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/tomNotepad', {
            init: { homeTomFolder: WsPaths.homeTomFolder },
        });
        wireCompletionMessages(webviewView.webview);

        this._storage.watch(() => this._sendState());

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._loadTemplates();
                this._storage.load();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'updateContent':
                    this._storage.save(msg.content);
                    break;
                case 'sendToCopilot':
                    await this._sendToCopilot(msg.selectedText);
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('tomAi.notes.tomNotepadTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    await showNotesMarkdownPreview(this._context, 'VS CODE NOTES Preview', this._storage.content, this._storage.path);
                    break;
                case 'previewPrompt':
                    await showNotesPromptPreview(
                        'VS CODE NOTES Prompt Preview',
                        pickNotesTextForSend(this._storage.content, msg.selectedText),
                        this._selectedTemplate,
                        this._storage.path,
                    );
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(this._storage.content);
                    vscode.window.showInformationMessage('Copied to clipboard');
                    break;
                case 'clear':
                    this._storage.save('');
                    this._sendState();
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
            }
        });
    }

    private async _openInEditor(): Promise<void> {
        this._storage.ensureFile();
        const doc = await vscode.workspace.openTextDocument(this._storage.path);
        await vscode.window.showTextDocument(doc);
    }

    private async _sendToCopilot(selectedText?: string): Promise<void> {
        const textToSend = pickNotesTextForSend(this._storage.content, selectedText);
        if (!textToSend.trim()) {
            vscode.window.showWarningMessage('Notepad is empty');
            return;
        }
        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._storage.path);
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'state',
            content: this._storage.content,
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
            notesFilePath: this._storage.path,
        });
    }
}


// ============================================================================
// Workspace Notepad (file-based, stored in workspace root as notes.md)
// ============================================================================

class WorkspaceNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _templates: { key: string; label: string; template: string }[] = [];
    private _selectedTemplate: string = '__none__';
    /**
     * Storage is rebuilt whenever the user picks a new file — unlike Tom
     * and Quest whose paths are derived from ambient state, this provider
     * lets the user choose arbitrary paths via the Change/Create dialog.
     */
    private _storage: NotepadFileStorage | null = null;

    private static readonly STORAGE_KEY = 'tomAi.notes.workspaceNoteFile';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._selectedTemplate = this._context.workspaceState.get<string>('tomAi.notes.workspaceNotepadTemplate') || '__none__';
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
        this._storage?.dispose();
    }

    /** Detect workspace and resolve the notes file path from workspace state. */
    private _initNotesFilePath(): void {
        const storedPath = this._context.workspaceState.get<string>(WorkspaceNotepadProvider.STORAGE_KEY);
        if (storedPath && fs.existsSync(storedPath)) {
            this._setStorageFor(storedPath);
        } else if (storedPath) {
            // Stored path no longer exists — clear it
            this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, undefined);
        }
        // Fallback: try to find notes.md in workspace root if nothing stored
        if (!this._storage) {
            const wsRoot = this._getWorkspaceRoot();
            if (wsRoot) {
                const defaultPath = path.join(wsRoot, 'notes.md');
                if (fs.existsSync(defaultPath)) {
                    this._setStorageFor(defaultPath);
                    this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, defaultPath);
                }
            }
        }
    }

    /** Rebuild the storage wrapper + file watcher when the target file changes. */
    private _setStorageFor(filePath: string): void {
        this._storage?.dispose();
        this._storage = new NotepadFileStorage(filePath);
        this._storage.load();
        this._storage.watch(() => this._sendState());
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

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };

        this._storage?.load();
        this._loadTemplates();
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/workspace');
        wireCompletionMessages(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._storage?.load();
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
                    this._storage?.save(msg.content);
                    break;
                case 'openInEditor':
                    await this._openInEditor();
                    break;
                case 'sendToCopilot':
                    await this._sendToCopilot(msg.selectedText);
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('tomAi.notes.workspaceNotepadTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    if (this._storage) {
                        await showNotesMarkdownPreview(this._context, 'WORKSPACE NOTES Preview', this._storage.content, this._storage.path);
                    }
                    break;
                case 'previewPrompt':
                    if (this._storage) {
                        await showNotesPromptPreview(
                            'WORKSPACE NOTES Prompt Preview',
                            pickNotesTextForSend(this._storage.content, msg.selectedText),
                            this._selectedTemplate,
                            this._storage.path,
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
        const filePath = this._storage?.path ?? null;
        this._view.webview.postMessage({
            type: 'state',
            content: this._storage?.content ?? '',
            filePath,
            workspaceName: wsName,
            hasWorkspace,
            hasFile: !!filePath && fs.existsSync(filePath),
            templates: this._templates,
            selectedTemplate: this._selectedTemplate,
        });
    }

    private async _sendToCopilot(selectedText?: string): Promise<void> {
        if (!this._storage) {
            vscode.window.showWarningMessage('No workspace notes file configured');
            return;
        }
        const textToSend = pickNotesTextForSend(this._storage.content, selectedText);
        if (!textToSend.trim()) {
            vscode.window.showWarningMessage('Workspace notes are empty');
            return;
        }
        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._storage.path);
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
    }

    private async _openInEditor(): Promise<void> {
        if (!this._storage) {
            vscode.window.showErrorMessage('No notes file configured');
            return;
        }
        this._storage.ensureFile();
        const doc = await vscode.workspace.openTextDocument(this._storage.path);
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
        this._setStorageFor(filePath);
        this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, filePath);
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
        this._setStorageFor(filePath);
        this._context.workspaceState.update(WorkspaceNotepadProvider.STORAGE_KEY, filePath);
        this._sendState();
    }
}

class QuestNotesProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    /**
     * Storage is (re)built on every `_load()` because the target path
     * depends on the active quest id, which changes when the user opens
     * a different .code-workspace file. Null when no quest is active.
     */
    private _storage: NotepadFileStorage | null = null;
    private _selectedTemplate = '__none__';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._selectedTemplate = this._context.workspaceState.get<string>('tomAi.notes.questNotesTemplate') || '__none__';
    }

    dispose(): void {
        this._storage?.dispose();
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
        const filePath = this._resolveQuestFile();
        if (!filePath) {
            this._storage?.dispose();
            this._storage = null;
            return;
        }
        // Rebuild the storage wrapper only when the target path has
        // actually changed (opening a different quest workspace).
        if (this._storage?.path !== filePath) {
            this._storage?.dispose();
            this._storage = new NotepadFileStorage(filePath);
            this._storage.watch(() => this._sendState());
        }
        // Seed the file with a header on first creation so the user
        // sees something when they open the view on a fresh quest.
        if (!fs.existsSync(filePath)) {
            const questId = getQuestIdFromWorkspaceFile() || 'quest';
            this._storage.ensureFile();
            this._storage.save(`# Quest Notes — ${questId}\n\n`);
        }
        this._storage.load();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/questNotes');
        wireCompletionMessages(webviewView.webview);

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
                    this._storage?.save(msg.content || '');
                    break;
                case 'openInEditor':
                    if (this._storage) {
                        const doc = await vscode.workspace.openTextDocument(this._storage.path);
                        await vscode.window.showTextDocument(doc);
                    }
                    break;
                case 'sendToCopilot':
                    if (this._storage && this._storage.content.trim()) {
                        const textToSend = pickNotesTextForSend(this._storage.content, msg.selectedText);
                        const expanded = await applyCopilotTemplateToNotes(textToSend, this._selectedTemplate, this._storage.path);
                        await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
                    }
                    break;
                case 'selectTemplate':
                    this._selectedTemplate = msg.key || '__none__';
                    await this._context.workspaceState.update('tomAi.notes.questNotesTemplate', this._selectedTemplate);
                    this._sendState();
                    break;
                case 'previewMarkdown':
                    if (this._storage) {
                        await showNotesMarkdownPreview(this._context, 'QUEST NOTES Preview', this._storage.content, this._storage.path);
                    }
                    break;
                case 'previewPrompt':
                    if (this._storage) {
                        await showNotesPromptPreview(
                            'QUEST NOTES Prompt Preview',
                            pickNotesTextForSend(this._storage.content, msg.selectedText),
                            this._selectedTemplate,
                            this._storage.path,
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
            content: this._storage?.content ?? '',
            filePath: this._storage?.path ?? null,
            hasWorkspaceFile: !!vscode.workspace.workspaceFile,
            templates,
            selectedTemplate: this._selectedTemplate,
        });
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
    const hasWorkspaceFile = !!vscode.workspace.workspaceFile;
    vscode.commands.executeCommand('setContext', 'tomAi.hasWorkspaceFile', hasWorkspaceFile);
    vscode.commands.executeCommand('setContext', 'tomAi.hasWorkspaceFile', hasWorkspaceFile);
    const workspaceTodoPath = wsRoot ? path.join(wsRoot, getWorkspaceTodoRelativePath()) : getWorkspaceTodoRelativePath();

    const workspaceQuestId = getQuestIdFromWorkspaceFile();
    const questExists = questFolderExists(workspaceQuestId);
    const resolvedQuestId = workspaceQuestId && questExists ? workspaceQuestId : '__invalid_quest__';
    const questTodoFile = workspaceQuestId ? resolveQuestTodoFileName(workspaceQuestId) : 'all';
    // The file is now selectable via the picker, so the fixed label names the
    // quest only (not quest/file) — it acts as the quest indicator since the
    // quest select is hidden in this view.
    const questLabel = workspaceQuestId
        ? (questExists ? workspaceQuestId : `Quest doesn't exist`)
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
        // Pre-select the quest's primary file but leave the picker active so the
        // user can switch to any *.todo.yaml in the quest — including newly
        // created structured files (Bug 4 + Bug 5).
        defaultFile: questExists && questTodoFile !== 'all' ? questTodoFile : undefined,
        fixedFileLabel: questLabel,
        hideQuestSelect: true,
        hideFileSelect: false,
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
        vscode.commands.registerCommand('tomAi.focusChatPanel', async () => {
            // Focus the unified TOM AI panel
            await vscode.commands.executeCommand('tomAi.chatPanel.focus');
        })
    );
}

export { tomNotepadProvider, workspaceNotepadProvider };
