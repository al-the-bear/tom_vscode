/**
 * Sidebar notepad WebviewView providers for the @TOM sidebar.
 *
 * Three live providers, each backed by a file on disk:
 * - TomNotepad     — global notes (`~/.tom/notes/global_notes.md`).
 * - WorkspaceNotepad — a user-chosen workspace notes file.
 * - QuestNotes     — per-quest notes, path derived from the active quest.
 *
 * Each offers a markdown preview, copy / clear where it has them, and opens its
 * file in the editor, the MD Browser or the MD Viewer ({@link
 * handleNotesFileMessage}). The webview HTML/JS/CSS lives in
 * `media/sidebarNotes/<provider>/` + `media/shared/notepadBase.css` and is
 * loaded via {@link loadWebviewHtml}; data flows by `postMessage` (`ready` →
 * `state`), so there is no inline HTML in this file.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    expandTemplate as expandPlaceholders,
} from './promptTemplate';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { QuestTodoEmbeddedViewProvider, setSessionTodosProvider } from './questTodoPanel-handler';
import { WsPaths } from '../utils/workspacePaths';
import { NotepadFileStorage } from './notepad/notepadFileStorage';
import { loadWebviewHtml } from '../utils/webviewLoader';
import { wireCompletionMessages } from '../utils/completionWiring';
import { handleNotesFileMessage } from './notepad/notesFileActions';

// View IDs
const VIEW_IDS = {
    tomNotepad: 'tomAi.vscodeNotes',
    workspaceNotepad: 'tomAi.workspaceNotes',
    workspaceTodos: 'tomAi.workspaceTodos',
    questNotes: 'tomAi.questNotes',
    questTodos: 'tomAi.questTodos',
    sessionTodos: 'tomAi.sessionTodos'
};

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

// ============================================================================
// TOM NOTEPAD (VS CODE NOTES)
// Uses file at ~/.tom/notes/global_notes.md for cross-window persistence
// ============================================================================

// Default global notes path (configurable)
const GLOBAL_NOTES_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', WsPaths.homeTomFolder, 'notes', 'global_notes.md');

/** The file dialogs' filters for a workspace notes file; the keys are the labels the dialog shows. */
// eslint-disable-next-line @typescript-eslint/naming-convention
const NOTES_FILE_FILTERS = { 'Markdown': ['md'], 'Text': ['txt'], 'All Files': ['*'] };

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
    private readonly _storage: NotepadFileStorage;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._storage = new NotepadFileStorage(GLOBAL_NOTES_PATH);
        this._storage.ensureFile();
        this._storage.load();
    }

    dispose(): void {
        this._storage.dispose();
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
                this._storage.load();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (await handleNotesFileMessage(msg.type, this._storage, this._context)) { return; }
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'updateContent':
                    this._storage.save(msg.content);
                    break;
                case 'previewMarkdown':
                    await showNotesMarkdownPreview(this._context, 'VS CODE NOTES Preview', this._storage.content, this._storage.path);
                    break;
                case 'copy':
                    await vscode.env.clipboard.writeText(this._storage.content);
                    vscode.window.showInformationMessage('Copied to clipboard');
                    break;
                case 'clear':
                    this._storage.save('');
                    this._sendState();
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'state',
            content: this._storage.content,
            notesFilePath: this._storage.path,
        });
    }
}


// ============================================================================
// Workspace Notepad (file-based, stored in workspace root as notes.md)
// ============================================================================

class WorkspaceNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    /**
     * Storage is rebuilt whenever the user picks a new file — unlike Tom
     * and Quest whose paths are derived from ambient state, this provider
     * lets the user choose arbitrary paths via the Change/Create dialog.
     */
    private _storage: NotepadFileStorage | null = null;

    private static readonly storageKey = 'tomAi.notes.workspaceNoteFile';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._initNotesFilePath();
    }

    dispose(): void {
        this._storage?.dispose();
    }

    /** Detect workspace and resolve the notes file path from workspace state. */
    private _initNotesFilePath(): void {
        const storedPath = this._context.workspaceState.get<string>(WorkspaceNotepadProvider.storageKey);
        if (storedPath && fs.existsSync(storedPath)) {
            this._setStorageFor(storedPath);
        } else if (storedPath) {
            // Stored path no longer exists — clear it
            this._context.workspaceState.update(WorkspaceNotepadProvider.storageKey, undefined);
        }
        // Fallback: try to find notes.md in workspace root if nothing stored
        if (!this._storage) {
            const wsRoot = this._getWorkspaceRoot();
            if (wsRoot) {
                const defaultPath = path.join(wsRoot, 'notes.md');
                if (fs.existsSync(defaultPath)) {
                    this._setStorageFor(defaultPath);
                    this._context.workspaceState.update(WorkspaceNotepadProvider.storageKey, defaultPath);
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
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/workspace');
        wireCompletionMessages(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._storage?.load();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (await handleNotesFileMessage(msg.type, this._storage, this._context)) { return; }
            switch (msg.type) {
                case 'ready':
                    this._sendState();
                    break;
                case 'updateContent':
                    this._storage?.save(msg.content);
                    break;
                case 'previewMarkdown':
                    if (this._storage) {
                        await showNotesMarkdownPreview(this._context, 'WORKSPACE NOTES Preview', this._storage.content, this._storage.path);
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
        });
    }

    /** Prompt user to create a new notes file via save dialog. */
    private async _createNotesFile(): Promise<void> {
        const wsRoot = this._getWorkspaceRoot();
        const wsName = this._getWorkspaceName();
        const defaultUri = wsRoot ? vscode.Uri.file(path.join(wsRoot, 'notes.md')) : undefined;
        const uri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: NOTES_FILE_FILTERS,
            title: 'Create Workspace Notes File',
        });
        if (!uri) { return; }
        const filePath = uri.fsPath;
        const header = `# Workspace Notes — ${wsName}\n\n`;
        fs.writeFileSync(filePath, header, 'utf-8');
        this._setStorageFor(filePath);
        this._context.workspaceState.update(WorkspaceNotepadProvider.storageKey, filePath);
        this._sendState();
    }

    /** Prompt user to pick a different notes file. */
    private async _changeFile(): Promise<void> {
        const wsRoot = this._getWorkspaceRoot();
        const defaultUri = wsRoot ? vscode.Uri.file(wsRoot) : undefined;
        const uris = await vscode.window.showOpenDialog({
            defaultUri,
            canSelectMany: false,
            filters: NOTES_FILE_FILTERS,
            title: 'Select Workspace Notes File',
        });
        if (!uris || uris.length === 0) { return; }
        const filePath = uris[0].fsPath;
        this._setStorageFor(filePath);
        this._context.workspaceState.update(WorkspaceNotepadProvider.storageKey, filePath);
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

    constructor(private readonly _context: vscode.ExtensionContext) {}

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
            if (await handleNotesFileMessage(msg.type, this._storage, this._context)) { return; }
            switch (msg.type) {
                case 'ready':
                    this._load();
                    this._sendState();
                    break;
                case 'updateContent':
                    this._storage?.save(msg.content || '');
                    break;
                case 'previewMarkdown':
                    if (this._storage) {
                        await showNotesMarkdownPreview(this._context, 'QUEST NOTES Preview', this._storage.content, this._storage.path);
                    }
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            type: 'state',
            content: this._storage?.content ?? '',
            filePath: this._storage?.path ?? null,
            hasWorkspaceFile: !!vscode.workspace.workspaceFile,
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
