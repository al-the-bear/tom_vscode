/**
 * Quest TODO Panel — §4
 *
 * Originally a standalone webview view, now embedded as a section
 * inside the WS panel accordion.  Exports HTML fragment, CSS,
 * script, and message handler for accordion integration.
 *
 * Shows a two-pane layout:
 *   Left  → scrollable todo list (status-color-coded, click to select)
 *   Right → todo detail editor with full schema fields
 *
 * All YAML operations use the CST-preserving `questTodoManager`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { ChatVariablesStore } from '../managers/chatVariablesStore.js';
import * as questTodo from '../managers/questTodoManager.js';
import { collectAllTags, readAllQuestsTodos, readWorkspaceTodos, listQuestIds, listWorkspaceTodoFiles, scanWorkspaceProjects, collectScopeValues } from '../managers/questTodoManager.js';
import { SessionTodoStore } from '../managers/sessionTodoStore.js';
import { WsPaths } from '../utils/workspacePaths';
import { isSessionTodoFileName } from '../utils/sessionTodoNames';
import { getExternalApplicationForFile, openInExternalApplication, resolvePathVariables, applyDefaultTemplate, DEFAULT_ANSWER_FILE_TEMPLATE } from './handler_shared';
import { expandTemplate } from './promptTemplate';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { BUILTIN_TODO_TEMPLATES, buildTodoSendTemplateChoices, type TodoSendTransport } from '../utils/todoSendTargets';
import { wireCompletionMessages } from '../utils/completionWiring';

// Module-level state
let _extensionContext: vscode.ExtensionContext | undefined;
let _popoutPanel: vscode.WebviewPanel | undefined;
const _webviewConfigs = new WeakMap<vscode.Webview, QuestTodoViewConfig>();

/** Storage key for persisting Quest TODO panel state per workspace. */
const QT_STATE_KEY = 'tomAi.questTodo.panelState';
const QT_PENDING_SELECT_KEY = 'tomAi.questTodo.pendingSelect';
const SESSION_TODO_ID_SEPARATOR = '::';

interface QtPanelState {
    questId?: string;
    file?: string;
    tagScope?: 'quest' | 'all';
    sortFields?: { field: string; asc: boolean }[];
    filterState?: {
        status?: string[];
        priority?: string[];
        tags?: string[];
        createdFrom?: string;
        createdTo?: string;
        updatedFrom?: string;
        updatedTo?: string;
        completedFrom?: string;
        completedTo?: string;
    };
}

interface QtPendingSelectState {
    file?: string;
    todoId?: string;
}

function _loadPanelState(): QtPanelState {
    return _extensionContext?.workspaceState.get<QtPanelState>(QT_STATE_KEY) ?? {};
}

function _loadPendingSelectState(): QtPendingSelectState {
    return _extensionContext?.workspaceState.get<QtPendingSelectState>(QT_PENDING_SELECT_KEY) ?? {};
}

async function _savePendingSelectState(state: QtPendingSelectState): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_PENDING_SELECT_KEY, state);
}

async function _clearPendingSelectState(): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_PENDING_SELECT_KEY, undefined);
}

async function _savePanelState(state: QtPanelState): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_STATE_KEY, state);
}

export interface QuestTodoViewConfig {
    mode?: 'default' | 'fixed-file' | 'workspace-file' | 'session';
    fixedQuestId?: string;
    /**
     * Lock the view to a single file (the file picker is then meaningless and
     * usually hidden). Mutually exclusive in practice with {@link defaultFile}.
     */
    fixedFile?: string;
    /**
     * Pre-select this file on load while still leaving the file picker active,
     * so the user can switch to any other `*.todo.yaml` in the quest. Used by
     * the left-sidebar quest TODO view, which fixes the quest but lets the user
     * pick the file (Bug 4 + Bug 5).
     */
    defaultFile?: string;
    fixedFilePath?: string;
    fixedFileLabel?: string;
    hideQuestSelect?: boolean;
    hideFileSelect?: boolean;
    disableFileActions?: boolean;
}

/** Call once from extension.ts / wsPanel to store the extension context. */
export function setQuestTodoContext(ctx: vscode.ExtensionContext): void {
    _extensionContext = ctx;
}

// ---- Global provider references for cross-module access ----
let _questTodosProvider: QuestTodoEmbeddedViewProvider | undefined;
let _sessionTodosProvider: QuestTodoEmbeddedViewProvider | undefined;

/** Register the quest-todos provider instance for cross-module access. */
export function setQuestTodosProvider(provider: QuestTodoEmbeddedViewProvider): void {
    _questTodosProvider = provider;
}

/** Register the session-todos provider instance for cross-module access. */
export function setSessionTodosProvider(provider: QuestTodoEmbeddedViewProvider): void {
    _sessionTodosProvider = provider;
}

/** Refresh the session todo panel (e.g. after copilot tool adds a session todo). */
export function refreshSessionPanel(): void {
    _sessionTodosProvider?.refresh();
}

/**
 * Delete a session todo by moving it to the -deleted / -archived sibling
 * of the session file (TRA01 semantics; called from copilot tools).
 * Returns true when the todo was moved.
 */
export function deleteSessionTodoToFile(todoId: string): boolean {
    try {
        const sessionFp = SessionTodoStore.instance.filePath;
        const result = _moveTodoToSiblingByStatus(sessionFp, todoId);
        return result.moved.length > 0;
    } catch {
        return false;
    }
}



/**
 * Select a todo in the bottom-panel WS Quest TODO accordion and focus it.
 * Uses the WS panel (bottom panel), NOT the sidebar quest todos view.
 * Focuses the WS panel first (which triggers resolveWebviewView if needed),
 * then sends the selection message.
 * Returns true if the selection was sent successfully.
 */
export async function selectTodoInBottomPanel(todoId: string, file?: string, questId?: string): Promise<boolean> {
    const { getWsPanelProvider } = await import('./wsPanel-handler.js');
    const ws = getWsPanelProvider();
    if (!ws) return false;

    // Focus the WS panel first — this reveals it and triggers resolveWebviewView
    try {
        await vscode.commands.executeCommand('tomAi.wsPanel.focus');
    } catch {
        return false;
    }

    // If the view wasn't already resolved, wait briefly for resolveWebviewView to run
    if (!ws.isViewAvailable) {
        await new Promise<void>(resolve => setTimeout(resolve, 500));
    }

    if (ws.isViewAvailable) {
        ws.selectTodo(todoId, file, questId);
        return true;
    }

    return false;
}

// ============================================================================
// Embeddable content for WS panel accordion
// ============================================================================

/** CSS + HTML fragment accessors from the extracted assets module (they read
 *  media/questTodoPanel/{style.css,fragment.html} raw). getQuestTodoScript
 *  stays in-handler because it prepends the one config-dependent line. */
import { getQuestTodoCss, getQuestTodoHtmlFragment } from './questTodo/questTodoAssets';
import { readMediaText } from '../utils/webviewLoader';
export { getQuestTodoCss, getQuestTodoHtmlFragment };


/**
 * Client-side JavaScript for the Quest TODO section.
 *
 * The static body lives in `media/questTodoPanel/main.js` (Phase B.5 webview
 * restructuring); here we only prepend the single config-dependent line. The
 * body uses the global `vscode` handle defined by each host shell (popout /
 * embedded / accordion), so it does not call acquireVsCodeApi() itself.
 */
export function getQuestTodoScript(config?: QuestTodoViewConfig): string {
    const cfgJson = JSON.stringify(config ?? {});
    return `\n// ── Quest TODO variables ──\nvar qtViewConfig = ${cfgJson};\n`
        + readMediaText('questTodoPanel', 'main.js');
}

// ============================================================================
// Backend message handler (for WS panel integration)
// ============================================================================

/** Handle Quest TODO messages from the webview. Call from WS panel message handler. */
export async function handleQuestTodoMessage(msg: any, webview: vscode.Webview): Promise<boolean> {
    const post = (m: any) => webview.postMessage(m);
    const cfg = _webviewConfigs.get(webview) || {};

    const isSessionMode = cfg.mode === 'session';
    const isWorkspaceFileMode = cfg.mode === 'workspace-file';
    const isInvalidQuest = cfg.fixedQuestId === '__invalid_quest__';

    const effectiveQuestId = (incoming?: string): string => {
        if (cfg.fixedQuestId) { return cfg.fixedQuestId; }
        return incoming || '';
    };

    const effectiveFile = (incoming?: string): string | undefined => {
        if (cfg.fixedFile) { return cfg.fixedFile; }
        return incoming;
    };

    const workspaceFilePath = (): string | undefined => {
        if (cfg.fixedFilePath) { return cfg.fixedFilePath; }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) { return undefined; }
        return path.join(wsRoot, 'workspace.todo.yaml');
    };

    switch (msg.type) {
        case 'qtInitConfig':
            _webviewConfigs.set(webview, msg.config || {});
            return true;
        case 'qtSaveState':
            if (msg.state) {
                await _savePanelState(msg.state as QtPanelState);
            }
            return true;
        case 'qtGetState': {
            const saved = _loadPanelState();
            post({ type: 'qtState', state: saved });
            return true;
        }
        case 'qtGetPendingSelect': {
            const pending = _loadPendingSelectState();
            post({ type: 'qtPendingSelect', state: pending });
            return true;
        }
        case 'qtConsumePendingSelect': {
            await _clearPendingSelectState();
            return true;
        }
        case 'qtGetQuests': {
            if (isSessionMode) {
                post({ type: 'qtQuests', quests: ['__session__'], activeQuest: '__session__' });
                return true;
            }
            if (cfg.fixedQuestId) {
                post({ type: 'qtQuests', quests: [cfg.fixedQuestId], activeQuest: cfg.fixedQuestId });
                _sendTodoList(cfg.fixedQuestId, cfg.fixedFile || 'all', post);
                return true;
            }
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            let quests: string[] = [];
            if (wsRoot) {
                const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
                if (fs.existsSync(questsDir)) {
                    quests = fs.readdirSync(questsDir, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name)
                        .sort();
                }
            }
            let activeQuest = '';
            // 1. Check persisted state first
            const saved = _loadPanelState();
            if (saved.questId && quests.indexOf(saved.questId) >= 0) {
                activeQuest = saved.questId;
            }
            // 2. Fall back to workspace file name
            if (!activeQuest) {
                const wsQuest = WsPaths.getWorkspaceQuestId();
                if (wsQuest !== 'default' && quests.indexOf(wsQuest) >= 0) {
                    activeQuest = wsQuest;
                }
            }
            // 3. If no explicit quest, try to infer from the active editor file path
            if (!activeQuest && wsRoot) {
                const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
                if (activeFile) {
                    const questsPrefix = (WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests')) + path.sep;
                    if (activeFile.startsWith(questsPrefix)) {
                        const remainder = activeFile.substring(questsPrefix.length);
                        const slashIdx = remainder.indexOf(path.sep);
                        const inferred = slashIdx > 0 ? remainder.substring(0, slashIdx) : remainder;
                        if (inferred && quests.indexOf(inferred) >= 0) {
                            activeQuest = inferred;
                        }
                    }
                }
            }
            const resolvedQuest = activeQuest || quests[0] || '';
            // Determine the default file — prefer persisted, then primary, then single-file
            let defaultFile = '';
            if (resolvedQuest) {
                const questFiles = questTodo.listTodoFiles(resolvedQuest);
                // Use persisted file if it still exists in this quest
                if (saved.file && saved.file !== 'all' && saved.questId === resolvedQuest && questFiles.indexOf(saved.file) >= 0) {
                    defaultFile = saved.file;
                } else {
                    const primaryName = `todos.${resolvedQuest}.todo.yaml`;
                    if (questFiles.indexOf(primaryName) >= 0) {
                        defaultFile = primaryName;
                    } else if (questFiles.length === 1) {
                        defaultFile = questFiles[0];
                    }
                }
            }
            // Also send persisted sort/filter state to client
            post({ type: 'qtState', state: saved });
            post({ type: 'qtQuests', quests, activeQuest, defaultFile });
            // Also send initial todo list (filtered to default file when available)
            _sendTodoList(resolvedQuest, defaultFile || 'all', post);
            return true;
        }
        case 'qtGetTodos':
            if (isInvalidQuest) {
                post({ type: 'qtTodos', todos: [], questId: '__invalid_quest__', file: cfg.fixedFile || 'all' });
                post({ type: 'qtFiles', files: [], questId: '__invalid_quest__' });
                return true;
            }
            if (isSessionMode) {
                const sessionQuestId = _getSessionQuestId();
                const todos = _collectSessionTodos(sessionQuestId);
                post({ type: 'qtTodos', todos, questId: '__session__', file: 'all' });
                post({ type: 'qtFiles', files: ['session'], questId: '__session__' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (!fp) {
                    post({ type: 'qtTodos', todos: [], questId: '__all_workspace__', file: cfg.fixedFile || 'workspace.todo.yaml' });
                    return true;
                }
                questTodo.ensureTodoFile(fp, { scope: { area: 'workspace' } });
                const items = questTodo.readTodoFile(fp);
                const todos = items.map(t => ({
                    id: t.id,
                    title: t.title ?? t.description?.substring(0, 60),
                    status: t.status,
                    priority: t.priority,
                    tags: t.tags,
                    created: t.created,
                    updated: t.updated,
                    sourceFile: path.basename(fp),
                }));
                post({ type: 'qtTodos', todos, questId: '__all_workspace__', file: path.basename(fp) });
                post({ type: 'qtFiles', files: [path.basename(fp)], questId: '__all_workspace__' });
                return true;
            }
            // Ensure the quest's primary todo file exists so a fixed-quest view
            // is never empty on a fresh quest. `defaultFile` (file-picker mode)
            // is honoured as well as a hard `fixedFile`.
            const ensureFile = cfg.fixedFile || cfg.defaultFile;
            if (cfg.mode === 'fixed-file' && cfg.fixedQuestId && ensureFile) {
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (wsRoot) {
                    const fp = WsPaths.ai('quests', cfg.fixedQuestId, ensureFile) || path.join(wsRoot, '_ai', 'quests', cfg.fixedQuestId, ensureFile);
                    questTodo.ensureTodoFile(fp, { quest: cfg.fixedQuestId });
                }
            }
            _sendTodoList(effectiveQuestId(msg.questId), effectiveFile(msg.file), post);
            return true;
        case 'qtGetTodo':
            if (isSessionMode) {
                const sessionQuestId = _getSessionQuestId();
                const target = _parseSessionTodoTarget(String(msg.todoId || ''), typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined);
                let item: questTodo.QuestTodoItem | undefined;

                if (target.sourceFile) {
                    const fp = _sessionTodoAbsolutePath(sessionQuestId, target.sourceFile);
                    if (fp) {
                        item = questTodo.findTodoByIdInFile(fp, target.todoId);
                    }
                } else {
                    for (const fileName of _listSessionTodoFiles(sessionQuestId)) {
                        const fp = _sessionTodoAbsolutePath(sessionQuestId, fileName);
                        if (!fp) { continue; }
                        const found = questTodo.findTodoByIdInFile(fp, target.todoId);
                        if (found) {
                            item = found;
                            target.sourceFile = fileName;
                            break;
                        }
                    }
                }

                if (!item) {
                    post({ type: 'qtTodoDetail', todo: null, questId: '__session__', todoId: msg.todoId });
                    return true;
                }
                post({
                    type: 'qtTodoDetail',
                    todo: {
                        ...item,
                        id: target.todoId,
                        _sourceFile: target.sourceFile,
                    },
                    questId: '__session__',
                    todoId: msg.todoId,
                });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                const todo = fp ? questTodo.findTodoByIdInFile(fp, msg.todoId) : undefined;
                post({ type: 'qtTodoDetail', todo: todo ? { ...todo } : null, questId: '__all_workspace__', todoId: msg.todoId });
                return true;
            }
            _sendTodoDetail(effectiveQuestId(msg.questId), msg.todoId, post);
            return true;
        case 'qtSaveTodo':
            if (isSessionMode) {
                const sessionQuestId = _getSessionQuestId();
                const target = _parseSessionTodoTarget(String(msg.todoId || ''), typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined);
                const fp = target.sourceFile ? _sessionTodoAbsolutePath(sessionQuestId, target.sourceFile) : undefined;
                const updated = fp
                    ? questTodo.updateTodoInFile(fp, target.todoId, {
                        title: msg.updates?.title,
                        description: msg.updates?.description,
                        priority: msg.updates?.priority,
                        status: _normalizeSessionStatus(String(msg.updates?.status || 'not-started')),
                        completed_date: msg.updates?.completed_date,
                        completed_by: msg.updates?.completed_by,
                        notes: msg.updates?.notes,
                        tags: msg.updates?.tags,
                        dependencies: msg.updates?.dependencies,
                        blocked_by: msg.updates?.blocked_by,
                        scope: msg.updates?.scope,
                        references: msg.updates?.references,
                    })
                    : undefined;
                post({ type: 'qtSaved', success: !!updated, todoId: msg.todoId });
                post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                const updated = fp ? questTodo.updateTodoInFile(fp, msg.todoId, msg.updates) : undefined;
                post({ type: 'qtSaved', success: !!updated, todoId: msg.todoId });
                if (fp) {
                    const items = questTodo.readTodoFile(fp).map(t => ({
                        id: t.id,
                        title: t.title ?? t.description?.substring(0, 60),
                        status: t.status,
                        priority: t.priority,
                        tags: t.tags,
                        created: t.created,
                        updated: t.updated,
                        sourceFile: path.basename(fp),
                    }));
                    post({ type: 'qtTodos', todos: items, questId: '__all_workspace__', file: path.basename(fp) });
                }
                return true;
            }
            _saveTodo(effectiveQuestId(msg.questId), msg.todoId, msg.updates, post);
            return true;
        case 'qtCreateTodo':
            if (isSessionMode) {
                const created = SessionTodoStore.instance.add(msg.todo?.title || msg.todo?.id || 'todo', 'copilot', {
                    details: msg.todo?.description || '',
                    priority: msg.todo?.priority || 'medium',
                    tags: msg.todo?.tags || [],
                });
                if (msg.todo?.status === 'completed' || msg.todo?.status === 'cancelled') {
                    SessionTodoStore.instance.update(created.id, { status: 'done' });
                }
                post({ type: 'qtCreated', success: true, todo: { id: created.id, title: created.title, description: created.details || '', status: created.status === 'done' ? 'completed' : 'not-started', priority: created.priority, tags: created.tags } });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (!fp) {
                    post({ type: 'qtCreated', success: false, error: 'No workspace root' });
                    return true;
                }
                const created = questTodo.createTodoInFile(fp, msg.todo, { scope: { area: 'workspace' } });
                post({ type: 'qtCreated', success: true, todo: created });
                return true;
            }
            _createTodo(effectiveQuestId(msg.questId), msg.todo, effectiveFile(msg.file), post);
            return true;
        case 'qtDeleteTodo':
            if (isSessionMode) {
                const confirmSess = await vscode.window.showWarningMessage(
                    `Delete todo "${msg.todoId}" from session?`, { modal: true }, 'Delete',
                );
                if (confirmSess !== 'Delete') return true;

                const sessionQuestId = _getSessionQuestId();
                const target = _parseSessionTodoTarget(String(msg.todoId || ''), typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined);
                const sessionFp = target.sourceFile ? _sessionTodoAbsolutePath(sessionQuestId, target.sourceFile) : undefined;
                let okSess = false;
                if (sessionFp) {
                    const result = _moveTodoToSiblingByStatus(sessionFp, target.todoId);
                    okSess = result.moved.length > 0;
                    if (!okSess) { _notifyMoveResult('Deleted', result); }
                }
                post({ type: 'qtDeleted', success: okSess, todoId: msg.todoId });
                post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const confirmWs = await vscode.window.showWarningMessage(
                    `Delete todo "${msg.todoId}" from workspace?`, { modal: true }, 'Delete',
                );
                if (confirmWs !== 'Delete') return true;
                const fp = workspaceFilePath();
                let okWs = false;
                if (fp) {
                    const result = _moveTodoToSiblingByStatus(fp, msg.todoId);
                    okWs = result.moved.length > 0;
                    if (!okWs) { _notifyMoveResult('Deleted', result); }
                }
                post({ type: 'qtDeleted', success: okWs, todoId: msg.todoId });
                return true;
            }
            await _deleteTodo(effectiveQuestId(msg.questId), msg.todoId, post, msg.sourceFile);
            return true;
        case 'qtArchiveTodo':
        case 'qtDeleteTodoToFile': {
            // TRA02: move a single todo to the -archived / -deleted sibling file.
            const isArchive = msg.type === 'qtArchiveTodo';
            if (isSessionMode) {
                vscode.window.showErrorMessage('Archive/delete-to-file is not available for session todos yet (TRB1).');
                post({ type: 'qtArchiveResult', success: false });
                return true;
            }
            const fp = _resolveArchiveSourcePath(
                effectiveQuestId(msg.questId), effectiveFile(msg.file), msg.sourceFile,
                isWorkspaceFileMode, workspaceFilePath,
            );
            if (!fp) {
                vscode.window.showErrorMessage('Could not resolve the todo file for this action.');
                post({ type: 'qtArchiveResult', success: false });
                return true;
            }
            const result = isArchive
                ? questTodo.archiveTodos(fp, [String(msg.todoId)])
                : questTodo.deleteTodos(fp, [String(msg.todoId)]);
            _notifyMoveResult(isArchive ? 'Archived' : 'Deleted', result);
            post({ type: 'qtArchiveResult', success: !result.error, moved: result.moved });
            return true;
        }
        case 'qtArchiveAllCompleted':
        case 'qtDeleteAllCancelled': {
            // TRA02: bulk move over the currently selected file scope.
            const isArchive = msg.type === 'qtArchiveAllCompleted';
            if (isSessionMode) {
                vscode.window.showErrorMessage('Archive/delete-to-file is not available for session todos yet (TRB1).');
                post({ type: 'qtArchiveResult', success: false });
                return true;
            }
            const fp = _resolveArchiveSourcePath(
                effectiveQuestId(msg.questId), effectiveFile(msg.file), undefined,
                isWorkspaceFileMode, workspaceFilePath,
            );
            if (!fp) {
                vscode.window.showErrorMessage('Select a concrete todo file first — bulk archive/delete needs a single file scope.');
                post({ type: 'qtArchiveResult', success: false });
                return true;
            }
            const result = isArchive
                ? questTodo.archiveAllCompleted(fp)
                : questTodo.deleteAllCancelled(fp);
            _notifyMoveResult(isArchive ? 'Archived' : 'Deleted', result);
            post({ type: 'qtArchiveResult', success: !result.error, moved: result.moved });
            return true;
        }
        case 'qtMassCreate': {
            const todos = Array.isArray(msg.todos) ? msg.todos : [];
            let created = 0;
            if (isSessionMode) {
                for (const t of todos) {
                    try {
                        SessionTodoStore.instance.add(t.title || t.id, 'copilot', {
                            details: t.description || '',
                            priority: t.priority || 'medium',
                            tags: t.tags || [],
                        });
                        created++;
                    } catch { /* skip */ }
                }
            } else if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    for (const t of todos) {
                        try {
                            questTodo.createTodoInFile(fp, t, { scope: { area: 'workspace' } });
                            created++;
                        } catch { /* skip */ }
                    }
                }
            } else {
                const qid = effectiveQuestId(msg.questId);
                const file = effectiveFile(msg.file);
                for (const t of todos) {
                    try {
                        questTodo.createTodo(qid, t, file);
                        created++;
                    } catch { /* skip */ }
                }
            }
            post({ type: 'qtMassCreated', success: true, count: created });
            vscode.window.showInformationMessage(`Created ${created} todo(s).`);
            return true;
        }
        case 'qtReopenTodo': {
            if (isSessionMode) {
                const sessionQuestId = _getSessionQuestId();
                const target = _parseSessionTodoTarget(String(msg.todoId || ''), typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined);
                const fp = target.sourceFile ? _sessionTodoAbsolutePath(sessionQuestId, target.sourceFile) : undefined;
                if (fp) {
                    questTodo.updateTodoInFile(fp, target.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
                }
                const items = _collectSessionTodos(sessionQuestId);
                post({ type: 'qtTodos', todos: items, questId: '__session__', file: 'all' });

                if (fp) {
                    const rTodo = questTodo.findTodoByIdInFile(fp, target.todoId);
                    if (rTodo) {
                        post({
                            type: 'qtTodoDetail',
                            todo: { ...rTodo, _sourceFile: target.sourceFile, id: target.todoId },
                            questId: '__session__',
                            todoId: msg.todoId,
                        });
                    }
                }
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    questTodo.updateTodoInFile(fp, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
                    const items = questTodo.readTodoFile(fp).map(t => ({
                        id: t.id, title: t.title ?? t.description?.substring(0, 60),
                        status: t.status, priority: t.priority, tags: t.tags,
                        created: t.created, updated: t.updated,
                        sourceFile: path.basename(fp),
                    }));
                    post({ type: 'qtTodos', todos: items, questId: '__all_workspace__', file: path.basename(fp) });
                    // Refresh detail view
                    const rTodo = questTodo.findTodoByIdInFile(fp, msg.todoId);
                    if (rTodo) {
                        post({ type: 'qtTodoDetail', todo: { ...rTodo }, questId: '__all_workspace__', todoId: msg.todoId });
                    }
                }
                return true;
            }
            const reqId = effectiveQuestId(msg.questId);
            questTodo.updateTodo(reqId, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
            _sendTodoList(reqId, undefined, post);
            // Refresh detail view for quest mode
            _sendTodoDetail(reqId, msg.todoId, post);
            return true;
        }
        case 'qtImportFromFile':
        case 'qtImportSessionFile': {
            // Open file picker for *.todo.yaml, import todos into current panel's target
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) return true;
            // Determine default directory for the file picker
            let importDefaultDir = wsRoot;
            if (isSessionMode) {
                const sessionQid = SessionTodoStore.instance.sessionQuestId;
                const questDir = WsPaths.ai('quests', sessionQid) || path.join(wsRoot, '_ai', 'quests', sessionQid);
                if (fs.existsSync(questDir)) { importDefaultDir = questDir; }
            } else if (!isWorkspaceFileMode) {
                const qid = effectiveQuestId(msg.questId);
                if (qid && !qid.startsWith('__')) {
                    const questDir = WsPaths.ai('quests', qid) || path.join(wsRoot, '_ai', 'quests', qid);
                    if (fs.existsSync(questDir)) { importDefaultDir = questDir; }
                }
            }
            const defaultUri = vscode.Uri.file(importDefaultDir);
            const uris = await vscode.window.showOpenDialog({
                defaultUri,
                filters: { 'Todo YAML': ['yaml'] },
                canSelectMany: false,
                openLabel: 'Import',
            });
            if (!uris || !uris.length) return true;
            const importPath = uris[0].fsPath;
            try {
                const items = questTodo.readTodoFile(importPath);
                let imported = 0;
                if (isSessionMode) {
                    for (const t of items) {
                        try {
                            SessionTodoStore.instance.add(t.title || t.id, 'copilot', {
                                details: t.description || '',
                                priority: t.priority || 'medium',
                                tags: t.tags || [],
                            });
                            imported++;
                        } catch { /* skip */ }
                    }
                    vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                    const refresh = SessionTodoStore.instance.list({ status: 'all' }).map(t => ({
                        id: t.id, title: t.title,
                        status: t.status === 'done' ? 'completed' : 'not-started',
                        priority: t.priority, tags: t.tags,
                        created: t.createdAt.slice(0, 10), updated: t.updatedAt.slice(0, 10),
                        sourceFile: 'session',
                    }));
                    post({ type: 'qtTodos', todos: refresh, questId: '__session__', file: 'all' });
                } else if (isWorkspaceFileMode) {
                    const fp = workspaceFilePath();
                    if (fp) {
                        for (const t of items) {
                            try {
                                questTodo.createTodoInFile(fp, t, { scope: { area: 'workspace' } });
                                imported++;
                            } catch { /* skip */ }
                        }
                        vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                        const refreshItems = questTodo.readTodoFile(fp).map(t => ({
                            id: t.id, title: t.title ?? t.description?.substring(0, 60),
                            status: t.status, priority: t.priority, tags: t.tags,
                            created: t.created, updated: t.updated,
                            sourceFile: path.basename(fp),
                        }));
                        post({ type: 'qtTodos', todos: refreshItems, questId: '__all_workspace__', file: path.basename(fp) });
                    }
                } else {
                    // Quest mode — import into current quest/file
                    const qid = effectiveQuestId(msg.questId);
                    const file = effectiveFile(msg.file);
                    for (const t of items) {
                        try {
                            questTodo.createTodo(qid, t, file);
                            imported++;
                        } catch { /* skip */ }
                    }
                    vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                    _sendTodoList(qid, file, post);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Import failed: ${err.message ?? err}`);
            }
            return true;
        }
        case 'qtConfirmStatusUpdate': {
            const status = String(msg.status || '');
            const answer = await vscode.window.showWarningMessage(
                `Set status to "${status}" and set completion date/by?`,
                { modal: true },
                'Set',
                'Cancel',
            );
            post({ type: 'qtStatusConfirmResult', confirmed: answer === 'Set', status });
            return true;
        }
        case 'qtMoveTodo':
            _moveTodo(msg.questId, msg.todoId, msg.targetFile, post);
            return true;
        case 'qtMoveToWorkspace':
            _moveToWorkspace(msg.questId, msg.todoId, post);
            return true;
        case 'qtDeleteAllSessionTodos': {
            if (!isSessionMode) {
                return true;
            }

            const sessionQuestId = _getSessionQuestId();
            const sessionFiles = _listSessionTodoFiles(sessionQuestId);
            if (!sessionFiles.length) {
                vscode.window.showInformationMessage(`No session todo files found for quest ${sessionQuestId}.`);
                post({ type: 'qtTodos', todos: [], questId: '__session__', file: 'all' });
                return true;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete all session todos for quest "${sessionQuestId}"?`,
                { modal: true },
                'Delete All',
            );
            if (confirm !== 'Delete All') {
                return true;
            }

            let deletedFiles = 0;
            const currentSessionFile = path.basename(SessionTodoStore.instance.filePath);
            for (const fileName of sessionFiles) {
                const fp = _sessionTodoAbsolutePath(sessionQuestId, fileName);
                if (!fp || !fs.existsSync(fp)) {
                    continue;
                }
                try {
                    if (fileName === currentSessionFile) {
                        const currentItems = SessionTodoStore.instance.list({ status: 'all' });
                        for (const item of currentItems) {
                            SessionTodoStore.instance.delete(item.id);
                        }
                    }
                    fs.unlinkSync(fp);
                    deletedFiles++;
                } catch {
                    // Best-effort: continue deleting remaining files.
                }
            }

            post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all' });
            vscode.window.showInformationMessage(`Deleted ${deletedFiles} session todo file(s) for quest ${sessionQuestId}.`);
            return true;
        }
        case 'qtOpenYaml':
            if (isSessionMode) {
                try {
                    const sessionFp = SessionTodoStore.instance.filePath;
                    if (fs.existsSync(sessionFp)) {
                        const doc = await vscode.workspace.openTextDocument(sessionFp);
                        await vscode.window.showTextDocument(doc);
                    } else {
                        vscode.window.showWarningMessage('Session todo file does not exist yet. Add a todo first.');
                    }
                } catch {
                    vscode.window.showWarningMessage('Session todo store not initialised.');
                }
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                if (fp) {
                    const doc = await vscode.workspace.openTextDocument(fp);
                    await vscode.window.showTextDocument(doc);
                }
                return true;
            }
            _openYamlFile(msg.questId, msg.file);
            return true;
        case 'qtGetFiles':
            if (isSessionMode) {
                post({ type: 'qtFiles', files: ['session'], questId: '__session__' });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                post({ type: 'qtFiles', files: [path.basename(fp || 'workspace.todo.yaml')], questId: '__all_workspace__' });
                return true;
            }
            _sendFileList(msg.questId, post);
            return true;
        case 'qtGetAllTags': {
            // For session/workspace modes, collect tags from all quests
            const tagQuestId = (msg.questId === '__session__' || msg.questId === '__all_workspace__') ? undefined : (msg.questId || undefined);
            const allTags = collectAllTags(tagQuestId);
            // For session mode, also merge tags from session todos
            if (isSessionMode) {
                const sessionItems = SessionTodoStore.instance.list({ status: 'all' });
                for (const si of sessionItems) {
                    if (si.tags) { for (const tg of si.tags) { if (!allTags.includes(tg)) allTags.push(tg); } }
                }
                allTags.sort();
            }
            post({ type: 'qtAllTags', tags: allTags });
            return true;
        }
        case 'qtGetScopeData': {
            const projs = scanWorkspaceProjects();
            const scopeVals = collectScopeValues();
            // Merge scanned project names with existing scope values
            const projNames = new Set(scopeVals.projects);
            for (const p of projs) projNames.add(p.name);
            post({
                type: 'qtScopeData',
                projects: [...projNames].sort(),
                modules: scopeVals.modules,
                areas: scopeVals.areas,
            });
            return true;
        }
        case 'qtBrowseFile': {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (!wsFolder) return true;
            const uris = await vscode.window.showOpenDialog({
                defaultUri: wsFolder.uri,
                canSelectMany: msg.purpose === 'scope-files',
                openLabel: 'Select',
            });
            if (uris) {
                for (const uri of uris) {
                    const rel = path.relative(wsFolder.uri.fsPath, uri.fsPath);
                    post({ type: 'qtBrowsedFile', purpose: msg.purpose, path: rel });
                }
            }
            return true;
        }
        case 'qtPickProjects': {
            const projects = scanWorkspaceProjects().map((p) => p.name);
            const selected = Array.isArray(msg.selected) ? msg.selected : [];
            const picked = await vscode.window.showQuickPick(
                projects.map((name) => ({ label: name, picked: selected.includes(name) })),
                {
                    canPickMany: true,
                    placeHolder: 'Select projects',
                    title: 'Scope Projects',
                },
            );
            if (picked) {
                post({ type: 'qtPickedProjects', projects: picked.map((item) => item.label) });
            }
            return true;
        }
        case 'qtPopout':
            _openPopoutPanel();
            return true;
        case 'qtOpenExtApp': {
            // Open the current YAML file in an external application
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot || !msg.questId) return true;
            const fileName = (!msg.file || msg.file === 'all') ? `todos.${msg.questId}.todo.yaml` : msg.file;
            const fp = WsPaths.ai('quests', msg.questId, fileName) || path.join(wsRoot, '_ai', 'quests', msg.questId, fileName);
            if (fs.existsSync(fp)) {
                await openInExternalApplication(fp);
            }
            return true;
        }
        case 'qtOpenTrailFiles': {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRoot) return true;
            const questId = WsPaths.getWorkspaceQuestId();
            const questFolder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
            if (!fs.existsSync(questFolder)) {
                fs.mkdirSync(questFolder, { recursive: true });
            }
            const promptsPath = path.join(questFolder, `${questId}.copilot.prompts.md`);
            if (!fs.existsSync(promptsPath)) {
                fs.writeFileSync(promptsPath, '', 'utf-8');
            }
            const uri = vscode.Uri.file(promptsPath);
            await vscode.commands.executeCommand('vscode.openWith', uri, 'tomAi.trailViewer');
            return true;
        }
        case 'qtCheckExtApp': {
            // Check if there's an external app configured for .yaml files
            const wsRootChk = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRootChk) {
                post({ type: 'qtExtAppAvailable', available: false });
                return true;
            }
            const testPath = path.join(wsRootChk, 'test.yaml');
            const extApp = getExternalApplicationForFile(testPath);
            post({ type: 'qtExtAppAvailable', available: !!extApp });
            return true;
        }
        case 'qtGetUserName': {
            const config = loadSendToChatConfig();
            const envOverride = (process.env.TOM_USER ?? '').trim();
            let userName = envOverride;
            if (!userName) {
                let userNameTemplate = config?.userName || '${username}';
                const resolved = resolvePathVariables(userNameTemplate, { silent: true });
                userName = (resolved ?? userNameTemplate ?? '').trim();
                if (!userName || userName === '${username}') {
                    try { userName = require('os').userInfo().username; } catch { /* */ }
                }
            }
            post({ type: 'qtUserNameResult', userName });
            return true;
        }
        case 'qtShowError': {
            const message = String(msg.message || 'Action failed');
            vscode.window.showErrorMessage(message);
            return true;
        }
        case 'qtGetTemplates': {
            // The send button + template dropdown follow the prompt queue's
            // current transport (Bug 3): copilot → copilot todo templates,
            // anthropic → anthropic user-message templates.
            const config = loadSendToChatConfig();
            const { transport, templateId } = await _queueSendTarget();
            const choices = buildTodoSendTemplateChoices(transport, config ?? undefined, templateId);
            post({
                type: 'qtTemplates',
                templates: choices.templates,
                selected: choices.selected,
                transport: choices.transport,
            });
            return true;
        }
        case 'qtAddCurrentTodoToQueue': {
            const questId = effectiveQuestId(msg.questId);
            const todoId = String(msg.todoId || '');
            if (!todoId) {
                vscode.window.showErrorMessage('Select a todo first.');
                return true;
            }
            const todo = _findTodoForPromptAction(questId, todoId, msg.sourceFile);
            if (!todo) {
                vscode.window.showErrorMessage(`Todo not found: ${todoId}`);
                return true;
            }
            const todoYaml = _todoYamlFragment(todo, questId, msg.sourceFile);
            const wrappedText = applyDefaultTemplate(todoYaml, 'copilot');
            const selectedTemplate = (msg.template && msg.template !== '__none__') ? String(msg.template) : undefined;
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                const queue = PromptQueueManager.instance;
                await queue.enqueue({
                    originalText: wrappedText,
                    template: selectedTemplate,
                    deferSend: true,
                });
                vscode.window.showInformationMessage(`Added todo ${todoId} to prompt queue`);
            } catch {
                vscode.window.showWarningMessage('Prompt queue not available');
            }
            return true;
        }
        case 'qtSendCurrentTodoToCopilot': {
            const questId = effectiveQuestId(msg.questId);
            const todoId = String(msg.todoId || '');
            if (!todoId) {
                vscode.window.showErrorMessage('Select a todo first.');
                return true;
            }
            const todo = _findTodoForPromptAction(questId, todoId, msg.sourceFile);
            if (!todo) {
                vscode.window.showErrorMessage(`Todo not found: ${todoId}`);
                return true;
            }
            const todoYaml = _todoYamlFragment(todo, questId, msg.sourceFile);
            const todoRef = _extractTodoRefFromYamlFragment(todoYaml) || todoId;
            const todoPrompt = `${todoYaml}\n\nREQUIRED: Add responseValue #TODO=${todoRef}\n\n`;
            const selectedTemplate = String(msg.template || '__none__');
            const config = loadSendToChatConfig();

            // Follow the prompt queue's selected transport (Bug 3): route to the
            // Anthropic chat transport when the queue is set to Anthropic,
            // otherwise open Copilot chat as before.
            const { transport } = await _queueSendTarget();
            if (transport === 'anthropic') {
                const ctx = _extensionContext;
                if (!ctx) {
                    vscode.window.showErrorMessage('Extension context unavailable — cannot send to Anthropic.');
                    return true;
                }
                const tplBody = (selectedTemplate && selectedTemplate !== '__none__')
                    ? config?.anthropic?.userMessageTemplates?.find((t) => t.id === selectedTemplate)?.template
                    : undefined;
                const { runAnthropicSend } = await import('./sendToChatRouter.js');
                const outcome = await runAnthropicSend(ctx, todoPrompt, tplBody ? { userMessageTemplate: tplBody } : {});
                if (outcome.rejected) {
                    vscode.window.showWarningMessage('Anthropic chat is busy — try again once the current request finishes.');
                } else if (!outcome.ok && outcome.error) {
                    vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
                }
                return true;
            }

            const wrappedText = applyDefaultTemplate(todoPrompt, 'copilot');
            const answerFileTemplate = config?.copilot?.templates?.['__answer_file__']?.template || DEFAULT_ANSWER_FILE_TEMPLATE;

            let expanded: string;
            if (!selectedTemplate || selectedTemplate === '__none__') {
                expanded = await expandTemplate(wrappedText);
            } else if (selectedTemplate === '__answer_file__') {
                expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: wrappedText } });
            } else {
                const selectedTemplateText = config?.copilot?.templates?.[selectedTemplate]?.template || BUILTIN_TODO_TEMPLATES[selectedTemplate];
                if (selectedTemplateText) {
                    const templateExpanded = await expandTemplate(selectedTemplateText, { values: { originalPrompt: wrappedText } });
                    expanded = await expandTemplate(answerFileTemplate, { values: { originalPrompt: templateExpanded } });
                } else {
                    expanded = await expandTemplate(wrappedText);
                }
            }

            await vscode.commands.executeCommand('workbench.action.chat.open', { query: expanded });
            return true;
        }
        case 'qtOpenInEditor': {
            // Open a reference file in the VS Code editor
            if (msg.path) {
                const wsRootRef = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!wsRootRef) return true;
                const absPath = path.isAbsolute(msg.path) ? msg.path : path.join(wsRootRef, msg.path);
                if (fs.existsSync(absPath)) {
                    const doc = await vscode.workspace.openTextDocument(absPath);
                    const editor = await vscode.window.showTextDocument(doc);
                    if (msg.lines) {
                        const match = String(msg.lines).match(/^(\d+)/);
                        if (match) {
                            const line = Math.max(0, parseInt(match[1], 10) - 1);
                            const pos = new vscode.Position(line, 0);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                        }
                    }
                }
            } else if (msg.url) {
                try {
                    await vscode.commands.executeCommand('simpleBrowser.show', msg.url);
                } catch {
                    await vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
            }
            return true;
        }
        case 'qtOpenRefExtApp': {
            // Open a reference path in external application
            const wsRootExt = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!wsRootExt || !msg.path) return true;
            const absPathExt = path.isAbsolute(msg.path) ? msg.path : path.join(wsRootExt, msg.path);
            if (fs.existsSync(absPathExt)) {
                await openInExternalApplication(absPathExt);
            }
            return true;
        }
        case 'qtGetTodosForPicker': {
            // Return all todos for the current quest for the todo picker
            try {
                let items: questTodo.QuestTodoItem[];
                const source = msg.source || 'local';
                const qid = effectiveQuestId(msg.questId);
                const rawQuestId = typeof msg.questId === 'string' ? msg.questId : '';
                // Session mode: 'local' returns session todos, 'quest' reads specified quest, 'workspace' reads all
                if (isSessionMode && source === 'local') {
                    const sessionItems = SessionTodoStore.instance.list({ status: 'all' });
                    items = sessionItems.map(si => ({
                        id: si.id,
                        title: si.title,
                        description: si.details || '',
                        status: si.status === 'done' ? 'completed' as const : 'not-started' as const,
                        priority: si.priority,
                        tags: si.tags,
                        _sourceFile: 'session',
                    }));
                } else if (source === 'workspace' || qid === '__all_workspace__') {
                    items = readWorkspaceTodos();
                } else if (source === 'quest') {
                    // In fixed-file mode (sidebar QUEST TODOS), allow picker-selected quest IDs
                    // to bypass the panel's fixed quest so cross-quest references work.
                    const requestedQid = rawQuestId && !rawQuestId.startsWith('__') ? rawQuestId : '';
                    const realQid = requestedQid || ((qid === '__session__' || qid === '__all_workspace__') ? rawQuestId : qid);
                    items = realQid && !realQid.startsWith('__') ? questTodo.readAllTodos(realQid) : [];
                } else {
                    if (qid && qid !== '__all_quests__' && qid !== '__all_workspace__' && qid !== '__session__') {
                        items = questTodo.readAllTodos(qid);
                    } else {
                        items = [];
                    }
                }
                const list = items.map(t => {
                    const sourcePath = t._sourceFile || '';
                    let sourceQuest = qid;
                    const wsQuestMatch = sourcePath.match(/^_ai\/quests\/([^/]+)\//);
                    if (wsQuestMatch && wsQuestMatch[1]) {
                        sourceQuest = wsQuestMatch[1];
                    } else {
                        const qMatch = sourcePath.match(/^([^/]+)\//);
                        if (qMatch && qMatch[1]) {
                            sourceQuest = qMatch[1];
                        }
                    }
                    const useQualified = source === 'workspace' || source === 'quest';
                    return {
                        id: t.id,
                        ref: useQualified && sourceQuest ? `${sourceQuest}/${t.id}` : t.id,
                        title: t.title ?? t.description?.substring(0, 60),
                        status: t.status,
                    };
                });
                const questIds = listQuestIds();
                post({ type: 'qtTodosForPicker', todos: list, questIds });
            } catch {
                post({ type: 'qtTodosForPicker', todos: [], questIds: [] });
            }
            return true;
        }
        case 'qtCheckPathExtApps': {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const result: Record<string, boolean> = {};
            if (wsRoot && Array.isArray(msg.paths)) {
                for (const p of msg.paths) {
                    if (!p || typeof p !== 'string') continue;
                    const abs = path.isAbsolute(p) ? p : path.join(wsRoot, p);
                    result[p] = !!getExternalApplicationForFile(abs);
                }
            }
            post({ type: 'qtPathExtAppAvailability', paths: result });
            return true;
        }
    }
    return false;
}

/** Set up a file watcher that calls refreshFn when quest YAML files change. */
export function setupQuestTodoWatcher(refreshFn: () => void): vscode.Disposable | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return undefined; }
    const pattern = new vscode.RelativePattern(wsRoot, WsPaths.questTodoGlob);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(refreshFn);
    watcher.onDidCreate(refreshFn);
    watcher.onDidDelete(refreshFn);
    return watcher;
}

/** Send the full todo list refresh to the webview */
export function sendQuestTodoRefresh(webview: vscode.Webview): void {
    const activeQuest = WsPaths.getWorkspaceQuestId();
    if (activeQuest === 'default') return;
    const post = (m: any) => webview.postMessage(m);
    _sendTodoList(activeQuest, 'all', post);
}

// ============================================================================
// Data helpers (shared between standalone and embedded modes)
// ============================================================================

function _sendFileList(questId: string, post: (m: any) => void): void {
    if (!questId) return;
    try {
        let files: string[];
        if (questId === '__all_workspace__') {
            files = listWorkspaceTodoFiles();
        } else if (questId === '__all_quests__') {
            // For all-quests, show quest IDs as pseudo-files
            files = listQuestIds().map(q => q + '/');
        } else {
            files = questTodo.listTodoFiles(questId);
        }
        post({ type: 'qtFiles', files, questId });
    } catch { /* quest folder may not exist */ }
}

function _getSessionQuestId(): string {
    try {
        return SessionTodoStore.instance.sessionQuestId;
    } catch {
        return WsPaths.getWorkspaceQuestId();
    }
}

function _listSessionTodoFiles(questId: string): string[] {
    if (!questId || questId.startsWith('__')) {
        return [];
    }
    return questTodo.listTodoFiles(questId)
        .filter((f) => isSessionTodoFileName(f));
}

function _sessionTodoAbsolutePath(questId: string, sourceFile: string): string | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot || !questId || !sourceFile) {
        return undefined;
    }
    return WsPaths.ai('quests', questId, sourceFile) || path.join(wsRoot, '_ai', 'quests', questId, sourceFile);
}

function _composeSessionTodoId(sourceFile: string, todoId: string): string {
    return `${sourceFile}${SESSION_TODO_ID_SEPARATOR}${todoId}`;
}

function _parseSessionTodoTarget(todoId: string, sourceFile?: string): { sourceFile?: string; todoId: string } {
    if (sourceFile && sourceFile.trim()) {
        return { sourceFile: sourceFile.trim(), todoId };
    }
    const idx = todoId.indexOf(SESSION_TODO_ID_SEPARATOR);
    if (idx <= 0) {
        return { todoId };
    }
    return {
        sourceFile: todoId.slice(0, idx),
        todoId: todoId.slice(idx + SESSION_TODO_ID_SEPARATOR.length),
    };
}

function _normalizeSessionStatus(status: string): 'not-started' | 'completed' {
    return (status === 'completed' || status === 'cancelled') ? 'completed' : 'not-started';
}

function _collectSessionTodos(questId: string): Array<Record<string, unknown>> {
    const todos: Array<Record<string, unknown>> = [];
    for (const sourceFile of _listSessionTodoFiles(questId)) {
        const fp = _sessionTodoAbsolutePath(questId, sourceFile);
        if (!fp || !fs.existsSync(fp)) {
            continue;
        }
        const items = questTodo.readTodoFile(fp);
        for (const t of items) {
            if (t.status === 'cancelled') {
                continue;
            }
            todos.push({
                id: _composeSessionTodoId(sourceFile, t.id),
                title: t.title ?? t.description?.substring(0, 60),
                status: t.status,
                priority: t.priority,
                tags: t.tags,
                created: t.created,
                updated: t.updated,
                sourceFile,
            });
        }
    }
    return todos;
}

/**
 * Resolve the absolute path of the todo file an archive/delete-to-file
 * action (TRA02) operates on.
 *
 * `sourceFile` (set for single-todo actions) wins over the `file` scope and
 * comes in different shapes depending on the view:
 *   - quest view:            basename (`todos.x.todo.yaml`)
 *   - __all_quests__ view:   `questId/filename`
 *   - __all_workspace__ view: workspace-relative path
 * Bulk actions pass no sourceFile and require a concrete `file` scope
 * (or a real quest, which falls back to its main todo file).
 */
function _resolveArchiveSourcePath(
    questId: string,
    file: string | undefined,
    sourceFile: string | undefined,
    isWorkspaceFileMode: boolean,
    workspaceFilePath: () => string | undefined,
): string | undefined {
    if (isWorkspaceFileMode) { return workspaceFilePath(); }
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) { return undefined; }
    const sf = (sourceFile ?? '').trim();
    if (sf) {
        if (path.isAbsolute(sf)) { return sf; }
        if (questId === '__all_workspace__') { return path.join(wsRoot, sf); }
        if (questId === '__all_quests__' && sf.includes('/')) {
            const idx = sf.indexOf('/');
            const qid = sf.slice(0, idx);
            const fn = sf.slice(idx + 1);
            return WsPaths.ai('quests', qid, fn) || path.join(wsRoot, '_ai', 'quests', qid, fn);
        }
        if (questId && !questId.startsWith('__')) {
            return WsPaths.ai('quests', questId, sf) || path.join(wsRoot, '_ai', 'quests', questId, sf);
        }
        return undefined;
    }
    if (!questId || questId.startsWith('__')) { return undefined; }
    const fn = (file && file !== 'all') ? file : `todos.${questId}.todo.yaml`;
    return WsPaths.ai('quests', questId, fn) || path.join(wsRoot, '_ai', 'quests', questId, fn);
}

/** Surface a TodoMoveResult as a user notification (TRA02 summary path). */
function _notifyMoveResult(pastVerb: string, result: questTodo.TodoMoveResult): void {
    if (result.error) {
        vscode.window.showErrorMessage(`${pastVerb} failed: ${result.error}`);
        return;
    }
    const target = result.targetFile ? path.basename(result.targetFile) : '';
    const movedPart = result.moved.length
        ? `${pastVerb} ${result.moved.length} todo(s) to ${target}: ${result.moved.join(', ')}`
        : `${pastVerb}: no todos moved`;
    if (result.skipped.length) {
        const skippedPart = result.skipped.map(s => `${s.id} (${s.reason})`).join('; ');
        vscode.window.showWarningMessage(`${movedPart}. Skipped: ${skippedPart}`);
    } else if (result.moved.length) {
        vscode.window.showInformationMessage(movedPart);
    } else {
        vscode.window.showInformationMessage(`${pastVerb}: nothing to move.`);
    }
}

/**
 * Move a single todo to the status-appropriate sibling file (TRA03 delete
 * path): completed todos can only be archived, so they route to the
 * `-archived` sibling; everything else goes to the `-deleted` sibling.
 * A missing todo falls through to deleteTodos, which reports it in skipped.
 */
function _moveTodoToSiblingByStatus(filePath: string, todoId: string): questTodo.TodoMoveResult {
    const todo = questTodo.findTodoByIdInFile(filePath, todoId);
    return todo?.status === 'completed'
        ? questTodo.archiveTodos(filePath, [todoId])
        : questTodo.deleteTodos(filePath, [todoId]);
}

function _sendTodoList(questId: string, file: string | undefined, post: (m: any) => void): void {
    if (!questId) return;
    try {
        let items: questTodo.QuestTodoItem[];
        if (questId === '__all_quests__') {
            items = readAllQuestsTodos();
        } else if (questId === '__all_workspace__') {
            items = readWorkspaceTodos();
        } else if (file && file !== 'all') {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const fp = WsPaths.ai('quests', questId, file) || path.join(wsRoot, '_ai', 'quests', questId, file);
            items = questTodo.readTodoFile(fp);
        } else {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            const mainFile = `todos.${questId}.todo.yaml`;
            const fp = WsPaths.ai('quests', questId, mainFile) || path.join(wsRoot, '_ai', 'quests', questId, mainFile);
            items = questTodo.readTodoFile(fp);
        }
        const list = items.map(t => ({
            id: t.id,
            title: t.title ?? t.description?.substring(0, 60),
            status: t.status,
            priority: t.priority,
            tags: t.tags,
            created: t.created,
            updated: t.updated,
            sourceFile: t._sourceFile,
        }));
        post({ type: 'qtTodos', todos: list, questId, file: file ?? 'all' });
        _sendFileList(questId, post);
    } catch { /* */ }
}

function _sendTodoDetail(questId: string, todoId: string, post: (m: any) => void): void {
    let todo: questTodo.QuestTodoItem | undefined;
    let resolvedQuestId = questId;
    if (questId === '__all_quests__') {
        // Search across all quests
        for (const qid of listQuestIds()) {
            todo = questTodo.findTodoById(qid, todoId);
            if (todo) { resolvedQuestId = qid; break; }
        }
    } else if (questId === '__all_workspace__') {
        // Search across all workspace todo files
        const all = readWorkspaceTodos();
        todo = all.find(t => t.id === todoId);
        // Try to resolve the quest id from the source path
        if (todo?._sourceFile) {
            const m = todo._sourceFile.match(/^_ai\/quests\/([^/]+)\//);
            if (m) resolvedQuestId = m[1];
        }
    } else {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const mainFile = `todos.${questId}.todo.yaml`;
        const fp = WsPaths.ai('quests', questId, mainFile) || path.join(wsRoot, '_ai', 'quests', questId, mainFile);
        todo = questTodo.findTodoByIdInFile(fp, todoId);
    }
    const payload: any = todo ? { ...todo } : null;
    if (payload && resolvedQuestId !== questId) { payload._resolvedQuestId = resolvedQuestId; }
    post({ type: 'qtTodoDetail', todo: payload, questId, todoId });
}

function _saveTodo(questId: string, todoId: string, updates: any, post: (m: any) => void): void {
    const current = questTodo.findTodoById(questId, todoId);
    if (current) {
        const normalize = (v: any) => v === undefined ? null : v;
        const same =
            normalize(current.title) === normalize(updates.title) &&
            normalize(current.status) === normalize(updates.status) &&
            normalize(current.priority) === normalize(updates.priority) &&
            normalize(current.description) === normalize(updates.description) &&
            JSON.stringify(normalize(current.tags)) === JSON.stringify(normalize(updates.tags)) &&
            JSON.stringify(normalize(current.dependencies)) === JSON.stringify(normalize(updates.dependencies)) &&
            JSON.stringify(normalize(current.blocked_by)) === JSON.stringify(normalize(updates.blocked_by)) &&
            normalize(current.notes) === normalize(updates.notes) &&
            JSON.stringify(normalize(current.scope)) === JSON.stringify(normalize(updates.scope)) &&
            JSON.stringify(normalize(current.references)) === JSON.stringify(normalize(updates.references)) &&
            normalize(current.completed_date) === normalize(updates.completed_date) &&
            normalize(current.completed_by) === normalize(updates.completed_by);
        if (same) {
            post({ type: 'qtSaved', success: true, todoId });
            return;
        }
    }
    const updated = questTodo.updateTodo(questId, todoId, updates);
    post({ type: 'qtSaved', success: !!updated, todoId });
    if (updated) _sendTodoList(questId, undefined, post);
}

function _createTodo(questId: string, todo: any, file: string | undefined, post: (m: any) => void): void {
    try {
        const created = questTodo.createTodo(questId, todo, file);
        post({ type: 'qtCreated', success: true, todo: created });
        _sendTodoList(questId, undefined, post);
    } catch (err: any) {
        post({ type: 'qtCreated', success: false, error: err.message ?? String(err) });
    }
}

/**
 * Resolve the absolute todo file containing `todoId` for a quest-mode delete.
 * Mirrors the candidate order the legacy backup path used: absolute source,
 * workspace-relative, quest folder + basename, `_ai/quests/<sourceFile>` when
 * it contains a slash, then a scan of the quest's todo files.
 */
function _resolveDeleteSourcePath(questId: string, todoId: string, sourceFile?: string): string | undefined {
    try {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return undefined;
        if (sourceFile) {
            const candidates: string[] = [];
            if (path.isAbsolute(sourceFile)) {
                candidates.push(sourceFile);
            } else {
                candidates.push(path.join(wsRoot, sourceFile));
                if (questId && !questId.startsWith('__')) {
                    const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
                    candidates.push(path.join(folder, sourceFile));
                }
                if (sourceFile.includes('/')) {
                    candidates.push(path.join(wsRoot, '_ai', 'quests', sourceFile));
                }
            }
            for (const absSource of candidates) {
                if (fs.existsSync(absSource) && questTodo.findTodoByIdInFile(absSource, todoId)) {
                    return absSource;
                }
            }
        }
        // Fallback: scan all quest files
        if (questId && !questId.startsWith('__')) {
            const folder = WsPaths.ai('quests', questId) || path.join(wsRoot, '_ai', 'quests', questId);
            for (const fileName of questTodo.listTodoFiles(questId)) {
                const fp = path.join(folder, fileName);
                if (questTodo.findTodoByIdInFile(fp, todoId)) {
                    return fp;
                }
            }
        }
    } catch (e) {
        console.error('[QuestTodo] _resolveDeleteSourcePath failed:', e);
    }
    return undefined;
}

async function _deleteTodo(questId: string, todoId: string, post: (m: any) => void, sourceFile?: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
        `Delete todo "${todoId}" from quest "${questId}"?`,
        { modal: true },
        'Delete',
    );
    if (answer !== 'Delete') return;
    const fp = _resolveDeleteSourcePath(questId, todoId, sourceFile);
    if (!fp) {
        vscode.window.showErrorMessage(`Delete failed: todo "${todoId}" not found in quest "${questId}".`);
        post({ type: 'qtDeleted', success: false, todoId });
        return;
    }
    const result = _moveTodoToSiblingByStatus(fp, todoId);
    if (result.error || result.skipped.length) {
        _notifyMoveResult('Deleted', result);
    }
    post({ type: 'qtDeleted', success: result.moved.length > 0, todoId });
}

function _moveTodo(questId: string, todoId: string, targetFile: string, post: (m: any) => void): void {
    const moved = questTodo.moveTodo(questId, todoId, targetFile);
    post({ type: 'qtMoved', success: !!moved, todoId });
    _sendTodoList(questId, undefined, post);
}

function _moveToWorkspace(questId: string, todoId: string, post: (m: any) => void): void {
    // Resolve the actual quest ID when in aggregated modes
    let resolvedQuestId = questId;
    if (questId === '__all_quests__') {
        for (const qid of listQuestIds()) {
            const found = questTodo.findTodoById(qid, todoId);
            if (found) { resolvedQuestId = qid; break; }
        }
    } else if (questId === '__all_workspace__') {
        // Workspace todos are already "workspace-level" — nothing to move
        const all = readWorkspaceTodos();
        const todo = all.find(t => t.id === todoId);
        if (todo?._sourceFile) {
            const m = todo._sourceFile.match(/^_ai\/quests\/([^/]+)\//);
            if (m) resolvedQuestId = m[1];
        }
    }
    const moved = questTodo.moveToWorkspaceTodo(resolvedQuestId, todoId);
    post({ type: 'qtMoved', success: !!moved, todoId });
    _sendTodoList(questId, undefined, post);
}

function _openYamlFile(questId: string, file: string): void {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot || !questId) return;
    // If 'all' selected, open the main quest todo file
    const fileName = (!file || file === 'all') ? `todos.${questId}.todo.yaml` : file;
    const fp = WsPaths.ai('quests', questId, fileName) || path.join(wsRoot, '_ai', 'quests', questId, fileName);
    if (fs.existsSync(fp)) {
        vscode.workspace.openTextDocument(fp).then(doc => vscode.window.showTextDocument(doc));
    } else {
        vscode.window.showWarningMessage(`File not found: ${fileName}`);
    }
}

/** Built-in template texts used when config doesn't define them. */
/**
 * Read the prompt queue's current send target — the transport the Quest TODO
 * send button + template dropdown should follow (Bug 3), plus the queue's
 * default (transport-scoped) message-template id. Defaults to copilot when the
 * queue manager is unavailable.
 */
async function _queueSendTarget(): Promise<{ transport: TodoSendTransport; templateId?: string }> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const qm = PromptQueueManager.instance;
        return {
            transport: qm.defaultTransport === 'anthropic' ? 'anthropic' : 'copilot',
            templateId: qm.defaultMessageTemplateId || undefined,
        };
    } catch {
        return { transport: 'copilot' };
    }
}

function _todoYamlFragment(todo: questTodo.QuestTodoItem, questId?: string, sourceFileHint?: string): string {
    const sourcePath = _resolveTodoSourcePath(todo, questId, sourceFileHint);
    const qualifiedId = sourcePath ? `${sourcePath}/${todo.id}` : todo.id;
    const clean: Record<string, unknown> = {
        id: qualifiedId,
        title: todo.title,
        description: todo.description,
        status: todo.status,
        priority: todo.priority,
        tags: todo.tags,
        dependencies: todo.dependencies,
        blocked_by: todo.blocked_by,
        notes: todo.notes,
        scope: todo.scope,
        references: todo.references,
        created: todo.created,
        updated: todo.updated,
        completed_date: todo.completed_date,
        completed_by: todo.completed_by,
    };
    Object.keys(clean).forEach((key) => {
        if (clean[key] === undefined || clean[key] === null || clean[key] === '') {
            delete clean[key];
        }
    });
    return yaml.stringify([clean]).trim();
}

function _extractTodoRefFromYamlFragment(todoYaml: string): string | undefined {
    const m = todoYaml.match(/(?:^|\n)-\s*id:\s*([^\n]+)/);
    if (!m?.[1]) return undefined;
    const value = m[1].trim().replace(/^['"]|['"]$/g, '');
    return value || undefined;
}

function _resolveTodoSourcePath(todo: questTodo.QuestTodoItem, questId?: string, sourceFileHint?: string): string | undefined {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const normalize = (p: string): string => p.replace(/\\/g, '/');
    const normalizeRel = (p: string): string => normalize(p).replace(/^\.\//, '');

    const hinted = sourceFileHint || todo._sourceFile;
    if (hinted && wsRoot) {
        const abs = path.isAbsolute(hinted) ? hinted : path.join(wsRoot, hinted);
        const rel = normalizeRel(path.relative(wsRoot, abs));
        const hintedNorm = normalizeRel(hinted);
        const hintedLooksRelativePath = hintedNorm.includes('/');
        if (!rel.startsWith('..') && rel !== '' && (hintedLooksRelativePath || fs.existsSync(abs))) return rel;
    }

    const sf = todo._sourceFile ? normalizeRel(todo._sourceFile) : '';
    if (!sf) return undefined;
    if (sf.endsWith('.todo.yaml') && sf.includes('/')) return sf;
    if (questId && questId !== '__all_quests__' && questId !== '__all_workspace__') {
        return normalizeRel(path.join('_ai', 'quests', questId, sf));
    }
    if (questId === '__all_quests__' && sf.includes('/')) {
        return normalizeRel(path.join('_ai', 'quests', sf));
    }
    return sf;
}

function _findTodoForPromptAction(questId: string, todoId: string, sourceFile?: string): questTodo.QuestTodoItem | undefined {
    if (!questId || !todoId) return undefined;

    if (questId === '__all_quests__') {
        if (sourceFile) {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
                if (fs.existsSync(absSource)) {
                    return questTodo.findTodoByIdInFile(absSource, todoId);
                }
            }
        }
        for (const qid of listQuestIds()) {
            const found = questTodo.findTodoById(qid, todoId);
            if (found) return found;
        }
        return undefined;
    }

    if (questId === '__all_workspace__') {
        if (sourceFile) {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsRoot) {
                const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
                if (fs.existsSync(absSource)) {
                    return questTodo.findTodoByIdInFile(absSource, todoId);
                }
            }
        }
        return readWorkspaceTodos().find((t) => t.id === todoId);
    }

    if (sourceFile) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
            const absSource = path.isAbsolute(sourceFile) ? sourceFile : path.join(wsRoot, sourceFile);
            if (fs.existsSync(absSource)) {
                const inFile = questTodo.findTodoByIdInFile(absSource, todoId);
                if (inFile) return inFile;
            }
        }
    }

    return questTodo.findTodoById(questId, todoId);
}

// ============================================================================
// Popout panel — opens the same TODO editor in a full editor tab
// ============================================================================

/** Webview options shared by the fresh-open and reload-restore paths. */
function _getPopoutWebviewOptions(ctx: vscode.ExtensionContext): vscode.WebviewOptions {
    return {
        enableScripts: true,
        localResourceRoots: [
            vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            vscode.Uri.joinPath(ctx.extensionUri, 'media'),
        ],
    };
}

function _openPopoutPanel(): void {
    if (_popoutPanel) {
        _popoutPanel.reveal();
        return;
    }
    const ctx = _extensionContext;
    if (!ctx) return;

    const panel = vscode.window.createWebviewPanel(
        'questTodoEditor',
        'Quest TODO Editor',
        vscode.ViewColumn.Active,
        {
            ..._getPopoutWebviewOptions(ctx),
            retainContextWhenHidden: true,
        },
    );
    _bindPopoutPanel(ctx, panel);
}

/**
 * Wire a (freshly-created or reload-restored) popout panel: paint HTML, install
 * the message + completion handlers, attach the auto-refresh watcher, and clear
 * the singleton on dispose. The popout carries no per-panel serializer state —
 * on load the webview asks for `qtGetQuests`, which resolves the active quest
 * from the persisted panel state (`_loadPanelState`), so the same quest/file
 * comes back after a reload without anything extra to persist here.
 */
function _bindPopoutPanel(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
    _popoutPanel = panel;

    const codiconsUri = vscode.Uri.joinPath(ctx.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
    const webviewCodiconsUri = panel.webview.asWebviewUri(codiconsUri);
    const completionUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(ctx.extensionUri, 'media', 'shared', 'completion.js'),
    );
    panel.webview.html = _getPopoutHtml(webviewCodiconsUri.toString(), completionUri.toString());

    panel.webview.onDidReceiveMessage(
        async (message) => {
            await handleQuestTodoMessage(message, panel.webview);
        },
        undefined,
        ctx.subscriptions,
    );
    ctx.subscriptions.push(wireCompletionMessages(panel.webview));

    // File watcher for auto-refresh
    const watcher = setupQuestTodoWatcher(() => {
        if (_popoutPanel) sendQuestTodoRefresh(_popoutPanel.webview);
    });

    panel.onDidDispose(() => {
        _popoutPanel = undefined;
        watcher?.dispose();
    });
}

/**
 * Register the serializer that restores the Quest TODO popout after a window
 * reload. The popout's viewType (`questTodoEditor`) is distinct from the
 * *.todo.yaml custom editor (`tomAi.todoEditor`), so there is no collision.
 * `_extensionContext` is set eagerly at activation (the @WS panel handler
 * constructor calls `setQuestTodoContext`), so it is available here. Called
 * once from `registerWsPanel`.
 */
export function registerQuestTodoPopoutSerializer(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('questTodoEditor', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
                if (_popoutPanel) { panel.dispose(); return; }
                const context = _extensionContext ?? ctx;
                panel.webview.options = _getPopoutWebviewOptions(context);
                _bindPopoutPanel(context, panel);
            },
        }),
    );
}

function _getPopoutHtml(codiconsUri: string, completionUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
${getQuestTodoCss()}
</style>
</head>
<body>
${getQuestTodoHtmlFragment()}
<script>
const vscode = acquireVsCodeApi();
window.__tomVscodeApi = vscode;
window.addEventListener('message', function(event) { qtHandleMessage(event.data); });
${getQuestTodoScript()}
</script>
<script src="${completionUri}"></script>
</body>
</html>`;
}

function _getEmbeddedQuestTodoHtml(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    config?: QuestTodoViewConfig,
): string {
    const codiconsUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
    );
    const completionUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'media', 'shared', 'completion.js'),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
<style>
body { margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
${getQuestTodoCss()}
</style>
</head>
<body>
${getQuestTodoHtmlFragment()}
<script>
const vscode = acquireVsCodeApi();
window.__tomVscodeApi = vscode;
window.addEventListener('message', function(event) { qtHandleMessage(event.data); });
${getQuestTodoScript(config)}
</script>
<script src="${completionUri}"></script>
</body>
</html>`;
}

export class QuestTodoEmbeddedViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext,
        private readonly config?: QuestTodoViewConfig,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };
        webviewView.webview.html = _getEmbeddedQuestTodoHtml(webviewView.webview, this.extensionUri, this.config);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            await handleQuestTodoMessage(message, webviewView.webview);
        }, undefined, this.context.subscriptions);
        this.context.subscriptions.push(wireCompletionMessages(webviewView.webview));

        const cfgMode = this.config?.mode;
        const watcher = setupQuestTodoWatcher(() => {
            if (cfgMode === 'workspace-file' || cfgMode === 'session') {
                // For workspace-file and session modes, re-invoke the correct handler
                handleQuestTodoMessage(
                    { type: 'qtGetTodos', questId: cfgMode === 'session' ? '__session__' : '__all_workspace__', file: 'all' },
                    webviewView.webview,
                );
            } else {
                sendQuestTodoRefresh(webviewView.webview);
            }
        });
        if (watcher) {
            this.context.subscriptions.push(watcher);
        }

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });
    }

    /**
     * Select a todo by ID in this embedded view.
     * Sends the pending-select message to the webview and triggers a refresh.
     */
    selectTodo(todoId: string, file?: string): void {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'qtPendingSelect',
            state: { todoId, file: file || '' },
        });
        // Also trigger a refresh so the todo list re-renders and picks up the selection
        sendQuestTodoRefresh(this._view.webview);
    }

    /** Whether the embedded view is currently resolved and available. */
    get isViewAvailable(): boolean {
        return !!this._view;
    }

    /** Trigger a full refresh of the todo list in this panel. */
    refresh(): void {
        if (!this._view) return;
        // Re-invoke the message handler with a synthetic qtGetTodos request
        handleQuestTodoMessage(
            { type: 'qtGetTodos', questId: '__session__', file: 'all' },
            this._view.webview
        );
    }
}

