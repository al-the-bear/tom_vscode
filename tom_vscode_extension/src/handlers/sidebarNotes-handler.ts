/**
 * Sidebar notepad WebviewView providers for the @TOM sidebar.
 *
 * Three live providers, each backed by a file on disk:
 * - TomNotepad     — global notes (`~/.tom/notes/global_notes.md`).
 * - WorkspaceNotepad — the workspace's notes file (`_ai/workspaces/<workspace>.notes.md`).
 * - QuestNotes     — the active quest's notes files (`_ai/quests/<quest>/notes/*.md`), one at a
 *                    time, chosen with the view's picker ({@link QuestNotesSession}).
 *
 * Each offers a markdown preview, copy / clear where it has them, and opens its
 * file in the editor, the MD Browser or the MD Viewer ({@link
 * handleNotesFileMessage}). The webview HTML/JS/CSS lives in
 * `media/sidebarNotes/<provider>/` + `media/shared/notepadBase.css` and is
 * loaded via {@link loadWebviewHtml}; data flows by `postMessage` (`ready` →
 * `state`), so there is no inline HTML in this file.
 */

import { layoutWorkspaceFolder } from '../utils/workspaceLayout';
import { wireQuestHintMessages } from './questHint-handler';
import * as vscode from 'vscode';
import { registerGatedWebviewViewProvider } from './webviewViewGate';
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
import { QuestNotesSession } from './notepad/questNotesSession';
import { ensureWorkspaceNotesFile, workspaceNotesFile } from '../utils/notesFiles';
import { aiWorkspaceName } from '../utils/aiWorkspace';

// View IDs
const VIEW_IDS = {
    tomNotepad: 'tomAi.vscodeNotes',
    workspaceNotepad: 'tomAi.workspaceNotes',
    workspaceTodos: 'tomAi.workspaceTodos',
    questNotes: 'tomAi.questNotes',
    questTodos: 'tomAi.questTodos',
    sessionTodos: 'tomAi.sessionTodos',
    tomTodo: 'tomAi.tomTodo',
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

const DEFAULT_WORKSPACE_TODO_FILE = 'workspace.todo.yaml';
const DEFAULT_QUEST_TODO_FILE_PATTERN = 'todos.${quest}.todo.yaml';

function getWorkspaceTodoRelativePath(): string {
    return vscode.workspace.getConfiguration('tomAi').get<string>('todo.workspaceTodoFile')
        || vscode.workspace.getConfiguration('tomAi').get<string>('todo.workspaceTodoFile')
        || DEFAULT_WORKSPACE_TODO_FILE;
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

function getQuestIdFromWorkspaceFile(): string {
    const wsFile = vscode.workspace.workspaceFile?.fsPath;
    if (!wsFile) { return ''; }
    return path.basename(wsFile).replace(/\.code-workspace$/, '').trim();
}

function questFolderExists(questId: string): boolean {
    if (!questId) { return false; }
    const wsRoot = layoutWorkspaceFolder();
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
// Workspace Notepad (one file per workspace: _ai/workspaces/<workspace>.notes.md)
// ============================================================================

/**
 * workspaceState key under which a window kept a freely picked workspace notes
 * file. Read only by the one-time import into the workspace notes file
 * (`ensureWorkspaceNotesFile`), and dropped once that file exists.
 */
const PICKED_WORKSPACE_NOTES_KEY = 'tomAi.notes.workspaceNoteFile';

/** The window's workspace notes file and workspace name; null without a workspace folder or an `_ai` folder. */
export function windowWorkspaceNotesFile(): { workspace: string; filePath: string } | null {
    const wsRoot = layoutWorkspaceFolder();
    const aiRoot = WsPaths.aiRoot;
    if (!wsRoot || !aiRoot || !fs.existsSync(aiRoot)) { return null; }
    const workspace = aiWorkspaceName(wsRoot);
    return { workspace, filePath: workspaceNotesFile(aiRoot, workspace) };
}

class WorkspaceNotepadProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    /** On the workspace's notes file; null without a workspace folder or an `_ai` folder. */
    private _storage: NotepadFileStorage | null = null;
    private _workspace = '';

    constructor(private readonly _context: vscode.ExtensionContext) {}

    dispose(): void {
        this._storage?.dispose();
    }

    /**
     * The storage on the workspace notes file, read from disk. A missing file is created the moment the view
     * shows it: with what the window's notes held before (the one-time import), else with its heading.
     */
    private _load(): void {
        const notes = windowWorkspaceNotesFile();
        if (!notes) {
            this._storage?.dispose();
            this._storage = null;
            this._workspace = '';
            return;
        }
        this._workspace = notes.workspace;
        try {
            ensureWorkspaceNotesFile(notes.filePath, this._context.workspaceState.get<string>(PICKED_WORKSPACE_NOTES_KEY), layoutWorkspaceFolder());
            if (this._context.workspaceState.get<string>(PICKED_WORKSPACE_NOTES_KEY) !== undefined) {
                void this._context.workspaceState.update(PICKED_WORKSPACE_NOTES_KEY, undefined);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to create the workspace notes file: ${e}`);
        }
        if (this._storage?.path !== notes.filePath) {
            this._storage?.dispose();
            this._storage = new NotepadFileStorage(notes.filePath);
            this._storage.watch(() => this._sendState());
        }
        this._storage.load();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };

        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/workspace');
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
                    this._storage?.save(msg.content);
                    break;
                case 'previewMarkdown':
                    if (this._storage) {
                        await showNotesMarkdownPreview(this._context, 'WORKSPACE NOTES Preview', this._storage.content, this._storage.path);
                    }
                    break;
                case 'openWorkspace':
                    await vscode.commands.executeCommand('workbench.action.openWorkspace');
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
            workspaceName: this._workspace,
            hasWorkspace: !!this._storage,
        });
    }
}

class QuestNotesProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    /** The notes file shown and the picker's list; shared logic with the QUEST NOTES side panel. */
    private readonly _session: QuestNotesSession;

    constructor(private readonly _context: vscode.ExtensionContext) {
        // A change on disk: the storage is current. A change of the choice: the session loaded the file chosen.
        this._session = new QuestNotesSession(_context, () => this._sendState());
    }

    dispose(): void {
        this._session.dispose();
    }

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        webviewView.webview.html = loadWebviewHtml(webviewView.webview, 'sidebarNotes/questNotes');
        wireCompletionMessages(webviewView.webview);
        // The "no quest is open" banner (media/shared/questHint.js).
        this._context.subscriptions.push(wireQuestHintMessages(webviewView.webview));

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._session.load();
                this._sendState();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            const storage = this._session.storage;
            if (await handleNotesFileMessage(msg.type, storage, this._context)) { return; }
            if (await this._session.handleMessage(msg)) { return; }
            switch (msg.type) {
                case 'ready':
                    this._session.load();
                    this._sendState();
                    break;
                case 'updateContent':
                    storage?.save(msg.content || '');
                    break;
                case 'previewMarkdown':
                    if (storage) {
                        await showNotesMarkdownPreview(this._context, 'QUEST NOTES Preview', storage.content, storage.path);
                    }
                    break;
            }
        });
    }

    private _sendState(): void {
        if (!this._view) { return; }
        const storage = this._session.storage;
        this._view.webview.postMessage({
            type: 'state',
            content: storage?.content ?? '',
            filePath: storage?.path ?? null,
            hasWorkspaceFile: !!vscode.workspace.workspaceFile,
            ...this._session.pickerState,
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

    const wsRoot = layoutWorkspaceFolder();
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
        questHint: true,
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
        questHint: true,
        hideQuestSelect: true,
        hideFileSelect: true,
    });
    setSessionTodosProvider(sessionTodosProvider);
    // @TOM TODO (vscimpb138): the todo panel on its own in an activity-bar container, a panel instance with
    // its own scope and toggles, starting on the open windows' quests with the quest prefix shown.
    const tomTodoProvider = new QuestTodoEmbeddedViewProvider(context.extensionUri, context, {
        scopeInstance: 'tom-todo',
        defaultScopeKind: 'workspace',
        questPrefixByDefault: true,
        hideQuestSelect: true,
    });

    context.subscriptions.push(
        registerGatedWebviewViewProvider(VIEW_IDS.tomNotepad, tomNotepadProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.workspaceNotepad, workspaceNotepadProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.workspaceTodos, workspaceTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.questNotes, questNotesProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.questTodos, questTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.sessionTodos, sessionTodosProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        registerGatedWebviewViewProvider(VIEW_IDS.tomTodo, tomTodoProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('tomAi.focusChatPanel', async () => {
            // Focus the unified TOM AI panel
            await vscode.commands.executeCommand('tomAi.chatPanel.focus');
        })
    );
}

export { tomNotepadProvider, workspaceNotepadProvider };
