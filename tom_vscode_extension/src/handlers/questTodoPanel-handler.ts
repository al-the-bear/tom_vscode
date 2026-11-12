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

import { DuplicateSubmitGuard } from '../utils/duplicateSubmitGuard';
import { resolveTodoButtonTemplate, todoButtonTemplateUse, TODO_BUTTON_TEMPLATE_INFO, type TodoButtonTemplateUse } from '../utils/todoButtonTemplates';
import { queuedTodoPatterns, todoQueueMarks, todoQueueMarkTitle, type QueueItemForMarks } from '../utils/todoQueueMarks';
import { wireQuestHintMessages } from './questHint-handler';
import { copilotQueueWrapper, fillTemplate, fillWrapper, userMessageTemplateBody } from '../utils/copilotTemplates';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as questTodo from '../managers/questTodoManager.js';
import { todoListItem } from '../utils/todoListItem';
import { collectAllTags, readAllQuestsTodos, readWorkspaceTodos, listQuestIds, listWorkspaceTodoFiles, scanWorkspaceProjects, collectScopeValues } from '../managers/questTodoManager.js';
import { SessionTodoStore } from '../managers/sessionTodoStore.js';
import { WsPaths } from '../utils/workspacePaths';
import { questTrailFolder } from '../utils/questPaths.js';
import { planSessionSwitch, type SessionSwitchPlan } from '../utils/sessionSwitch';
import { sessionTodoSourceFile } from '../services/sessionTodoFiles';
import { computeMoveTargetFiles } from '../utils/questTodoMoveTargets';
import { isArchivedOrDeletedTodoFile } from '../utils/todoArchiveNames';
import { FINALIZER_INDEX, todoIdInputError, numberIn, renamesReachFinalizer, todoIdPrefix, todoMoveNeedsIdChoice, todoMoveOptions, todoMovePickerTitle, todoOriginOfRelativePath, todoPrefixChoices, todoPrefixPreview, todoRenames, validateTodoPrefix, type TodoMoveOrigin } from '../utils/todoDestinationPicker';
import { getExternalApplicationForFile, openInExternalApplication, resolvePathVariables } from './handler_shared';
import { expandTemplate } from './promptTemplate';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { buildStackedTodoPrompt, buildTodoSendTemplateChoices, todoSendBlock, type StackedTodoFragment, type TodoSendTransport } from '../utils/todoSendTargets';
import { todoYamlBlock } from '../utils/todoIterationRecord';
import { unescapePlaceholders } from '../utils/placeholderEscape';
import { wireCompletionMessages } from '../utils/completionWiring';
import { todoFormUnchanged } from '../utils/todoFormSave';
import { groupPromptDirs } from '../services/groupPromptDirs';
import { readGroupPrompts } from '../services/groupPromptStore';
import { composeGroupPrompt, groupPromptChoices, type GroupPromptChoice } from '../utils/groupPrompts';
import { showMultilineInput } from './textInput-handler';
import { ChatVariablesStore } from '../managers/chatVariablesStore';

// Module-level state
let _extensionContext: vscode.ExtensionContext | undefined;
let _popoutPanel: vscode.WebviewPanel | undefined;
const _webviewConfigs = new WeakMap<vscode.Webview, QuestTodoViewConfig>();

// ---- Queued todos (utils/todoQueueMarks.ts) --------------------------------
// Every todo list posted to a webview carries, on each todo the prompt queue
// will run, `queued` (the numbers of those queue items, as the queue editor
// shows them) and `queuedTitle` (the mark's tooltip). When the queued patterns
// or their numbers change, the webviews are told (`qtQueueChanged`) and load
// their list again.

/** The webviews a todo list was posted to. */
const _markedWebviews = new Set<vscode.Webview>();
let _queueMarksSignature = '';
let _queueMarksListener: { dispose(): void } | undefined;

/** The prompt queue's items, or none when the queue is not up (tests, early start). */
function _queueItemsForMarks(): QueueItemForMarks[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily: the queue manager imports this module's neighbours
        const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        return PromptQueueManager.instance.items as unknown as QueueItemForMarks[];
    } catch {
        return [];
    }
}

function _ensureQueueMarksListener(): void {
    if (_queueMarksListener) { return; }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- see _queueItemsForMarks
        const { PromptQueueManager } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        _queueMarksSignature = JSON.stringify(queuedTodoPatterns(_queueItemsForMarks()));
        const onQueueChange = (): void => {
            const signature = JSON.stringify(queuedTodoPatterns(_queueItemsForMarks()));
            if (signature === _queueMarksSignature) { return; }
            _queueMarksSignature = signature;
            for (const view of [..._markedWebviews]) {
                Promise.resolve(view.postMessage({ type: 'qtQueueChanged' })).then(
                    (delivered) => { if (delivered === false) { _markedWebviews.delete(view); } },
                    () => _markedWebviews.delete(view),
                );
            }
        };
        // Bound through whenReady: a todo view restored before the queue manager starts
        // would otherwise subscribe to nothing.
        let listener: { dispose(): void } | undefined;
        const holder = { dispose: (): void => { listener?.dispose(); listener = undefined; } };
        _queueMarksListener = holder;
        void PromptQueueManager.whenReady().then((qm) => {
            if (_queueMarksListener !== holder || listener) { return; }
            listener = qm.onDidChange(onQueueChange);
            onQueueChange();
        });
    } catch { /* no queue: no marks to keep current */ }
}

/** `m` with the queue marks on its todos when it is a todo list. */
function _withQueueMarks(m: any, webview: vscode.Webview): any {
    if (!m || m.type !== 'qtTodos' || !Array.isArray(m.todos)) { return m; }
    _markedWebviews.add(webview);
    _ensureQueueMarksListener();
    const marks = todoQueueMarks(_queueItemsForMarks(), m.todos, { walks: m.questId === WsPaths.getWorkspaceQuestId() });
    if (marks.size === 0) { return m; }
    return {
        ...m,
        todos: m.todos.map((t: { id: string }) => {
            const numbers = marks.get(t.id);
            return numbers ? { ...t, queued: numbers, queuedTitle: todoQueueMarkTitle(numbers) } : t;
        }),
    };
}

/** Storage key for persisting Quest TODO panel state per workspace. */
const QT_STATE_KEY = 'tomAi.questTodo.panelState';
const QT_PENDING_SELECT_KEY = 'tomAi.questTodo.pendingSelect';
const SESSION_TODO_ID_SEPARATOR = '::';

interface QtPanelState {
    questId?: string;
    file?: string;
    tagScope?: 'quest' | 'all';
    sortFields?: { field: string; asc: boolean }[];
    /** The list grouped by id prefix (default true; the sort picker's Group checkbox). */
    grouped?: boolean;
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
    /**
     * Show the "no quest is open" banner (media/shared/questHint.js) — the
     * @TOM views that need a quest (QUEST TODOS, SESSION TODOS).
     */
    questHint?: boolean;
}

/** Call once from extension.ts / wsPanel to store the extension context. */
export function setQuestTodoContext(ctx: vscode.ExtensionContext): void {
    _extensionContext = ctx;
}

// ---- Global provider references for cross-module access ----
let _sessionTodosProvider: QuestTodoEmbeddedViewProvider | undefined;

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
        const sessionFp = SessionTodoStore.instance.filePathFor(SessionTodoStore.instance.shownSession);
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
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown';
import { showMarkdownHtmlPreview } from './markdownHtmlPreview';
import { discoverTrailSets, loadTrailSet } from './trailEditor-handler';
import { todoLogTrailSets } from '../utils/todoLogTrailSets';
import { latestTodoAnswer } from '../utils/todoAgentAnswer';
import { todayLocalDate } from '../utils/todoDates';
import { appendTodoNote, guideMeClosingAsk, interpretGuideMeReply } from '../utils/guideMeClosing';
export { getQuestTodoCss, getQuestTodoHtmlFragment };


/**
 * Client-side JavaScript for the Quest TODO section.
 *
 * The static body lives in `media/questTodoPanel/main.js` (Phase B.5 webview
 * restructuring); here we only prepend the single config-dependent line. The
 * body uses the global `vscode` handle defined by each host shell (popout /
 * embedded / accordion), so it does not call acquireVsCodeApi() itself.
 *
 * `grouping.js` comes first: it holds the pure prefix-grouping rule that
 * `main.js` calls while rendering the list. It is a separate file precisely
 * because it has no DOM or host dependency, which lets it be unit-tested in a
 * bare sandbox (see `src/utils/__tests__/questTodoPrefixGroups.test.ts`).
 */
export function getQuestTodoScript(config?: QuestTodoViewConfig): string {
    const cfgJson = JSON.stringify(config ?? {});
    return `\n// ── Quest TODO variables ──\nvar qtViewConfig = ${cfgJson};\n`
        + readMediaText('shared', 'mdOverlay.js')
        + readMediaText('questTodoPanel', 'grouping.js')
        + readMediaText('questTodoPanel', 'main.js');
}

// ============================================================================
// Backend message handler (for WS panel integration)
// ============================================================================

/** Handle Quest TODO messages from the webview. Call from WS panel message handler. */
export async function handleQuestTodoMessage(msg: any, webview: vscode.Webview): Promise<boolean> {
    const post = (m: any) => webview.postMessage(_withQueueMarks(m, webview));
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
                // Same scope as the picker — a persisted selection pointing at
                // an archive file must still be recognised on reload.
                const questFiles = questTodo.listTodoFiles(resolvedQuest, questTodo.ALL_TODO_FILES);
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
                const todos = items.map(t => todoListItem(t, path.basename(fp)));
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
            _sendTodoDetail(
                effectiveQuestId(msg.questId), msg.todoId, post,
                typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined,
            );
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
                post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
                return true;
            }
            if (isWorkspaceFileMode) {
                const fp = workspaceFilePath();
                const updated = fp ? questTodo.updateTodoInFile(fp, msg.todoId, msg.updates) : undefined;
                post({ type: 'qtSaved', success: !!updated, todoId: msg.todoId });
                if (fp) {
                    const items = questTodo.readTodoFile(fp).map(t => todoListItem(t, path.basename(fp)));
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
                }, SessionTodoStore.instance.shownSession);
                if (msg.todo?.status === 'completed' || msg.todo?.status === 'cancelled') {
                    SessionTodoStore.instance.update(created.id, { status: 'done' }, SessionTodoStore.instance.shownSession);
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
                post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
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
            // The panel's Archive/Delete buttons work for any status (the
            // completed-only / non-completed-only guard is a bulk-tool rule).
            const result = isArchive
                ? questTodo.archiveTodos(fp, [String(msg.todoId)], { anyStatus: true })
                : questTodo.deleteTodos(fp, [String(msg.todoId)], { anyStatus: true });
            _notifyMoveResult(isArchive ? 'Archived' : 'Deleted', result);
            post({ type: 'qtArchiveResult', success: !result.error, moved: result.moved });
            return true;
        }
        case 'qtArchiveStackedTodos':
        case 'qtDeleteStackedTodos': {
            // Archive/delete every stacked todo (any status) to its
            // -archived / -deleted sibling. Requires an explicit modal
            // confirmation since it moves a whole batch at once.
            const isArchive = msg.type === 'qtArchiveStackedTodos';
            if (isSessionMode) {
                vscode.window.showErrorMessage('Archive/delete-to-file is not available for session todos yet (TRB1).');
                post({ type: 'qtArchiveResult', success: false });
                return true;
            }
            const entries: Array<{ todoId?: string; sourceFile?: string }> = Array.isArray(msg.todos) ? msg.todos : [];
            if (!entries.length) {
                vscode.window.showErrorMessage('Todo stack is empty.');
                return true;
            }
            const verb = isArchive ? 'Archive' : 'Delete';
            const sibling = isArchive ? '-archived' : '-deleted';
            const confirm = await vscode.window.showWarningMessage(
                `${verb} ${entries.length} stacked todo${entries.length === 1 ? '' : 's'}? They will be moved to the ${sibling} sibling file.`,
                { modal: true },
                verb,
            );
            if (confirm !== verb) return true;
            // Group by resolved source file so the mover runs once per file.
            const byFile = new Map<string, string[]>();
            const unresolved: string[] = [];
            for (const entry of entries) {
                const todoId = String(entry?.todoId || '');
                if (!todoId) continue;
                const fp = _resolveArchiveSourcePath(
                    effectiveQuestId(msg.questId), effectiveFile(msg.file), entry?.sourceFile,
                    isWorkspaceFileMode, workspaceFilePath,
                );
                if (!fp) { unresolved.push(todoId); continue; }
                const ids = byFile.get(fp) ?? [];
                ids.push(todoId);
                byFile.set(fp, ids);
            }
            const moved: string[] = [];
            const replaced: string[] = [];
            const skipped: questTodo.TodoMoveSkip[] = [];
            let targetFile = '';
            let firstError: string | undefined;
            for (const [fp, ids] of byFile) {
                const result = isArchive
                    ? questTodo.archiveTodos(fp, ids, { anyStatus: true })
                    : questTodo.deleteTodos(fp, ids, { anyStatus: true });
                moved.push(...result.moved);
                replaced.push(...result.replaced);
                skipped.push(...result.skipped);
                if (result.targetFile) targetFile = result.targetFile;
                if (result.error && !firstError) firstError = result.error;
            }
            for (const id of unresolved) { skipped.push({ id, reason: 'Could not resolve source file' }); }
            _notifyMoveResult(isArchive ? 'Archived' : 'Deleted', { moved, replaced, skipped, targetFile, error: firstError });
            post({ type: 'qtArchiveResult', success: !firstError, moved });
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
        case 'qtCompleteTodo':
        case 'qtCancelTodo':
        case 'qtReopenSelectedTodo':
        case 'qtCompleteStackedTodos':
        case 'qtCancelStackedTodos':
        case 'qtReopenStackedTodos': {
            // Set status in place to completed / cancelled / not-started (no
            // file move). Complete asks for the completion timestamp ONCE and
            // applies the same stamp to every todo in the batch; cancel and
            // reopen confirm only when acting on a stack (analogous to the
            // delete stack action).
            const isComplete = msg.type === 'qtCompleteTodo' || msg.type === 'qtCompleteStackedTodos';
            const isReopen = msg.type === 'qtReopenSelectedTodo' || msg.type === 'qtReopenStackedTodos';
            const isStack = msg.type === 'qtCompleteStackedTodos' || msg.type === 'qtCancelStackedTodos' || msg.type === 'qtReopenStackedTodos';
            if (isSessionMode) {
                vscode.window.showErrorMessage('Complete/cancel is not available for session todos yet.');
                post({ type: 'qtStatusResult', success: false, wasStack: isStack });
                return true;
            }
            const entries: Array<{ todoId?: string; sourceFile?: string }> = isStack
                ? (Array.isArray(msg.todos) ? msg.todos : [])
                : [{ todoId: msg.todoId, sourceFile: msg.sourceFile }];
            const validEntries = entries.filter(e => String(e?.todoId || ''));
            if (!validEntries.length) {
                vscode.window.showErrorMessage(isStack ? 'Todo stack is empty.' : 'No todo selected.');
                post({ type: 'qtStatusResult', success: false, wasStack: isStack });
                return true;
            }
            const count = validEntries.length;
            const stamp = todayLocalDate();
            const completedBy = isComplete ? String(msg.completedBy || '') : '';
            // Confirmation: complete always confirms (the timestamp prompt, asked
            // once); cancel confirms only for a stack batch.
            if (isComplete) {
                const confirm = await vscode.window.showWarningMessage(
                    `Mark ${count} todo${count === 1 ? '' : 's'} completed with completion date ${stamp}${completedBy ? ' by ' + completedBy : ''}?`
                        + ' A repeated todo is not completed: it waits for its next repetition.',
                    { modal: true },
                    'Complete',
                );
                if (confirm !== 'Complete') return true;
            } else if (isStack) {
                const targetLabel = isReopen ? 'not-started' : 'cancelled';
                const actionLabel = isReopen ? 'Set Not-Started' : 'Set Cancelled';
                const confirm = await vscode.window.showWarningMessage(
                    `Set ${count} stacked todo${count === 1 ? '' : 's'} to ${targetLabel}?`,
                    { modal: true },
                    actionLabel,
                );
                if (confirm !== actionLabel) return true;
            }
            const updates: Partial<Omit<questTodo.QuestTodoItem, 'id' | '_sourceFile'>> = isComplete
                ? { status: 'completed', completed_date: stamp, completed_by: completedBy || undefined }
                : isReopen
                    ? { status: 'not-started', completed_date: '', completed_by: '' }
                    : { status: 'cancelled' };
            const updated: string[] = [];
            const failed: string[] = [];
            const waiting: string[] = [];
            for (const entry of validEntries) {
                const todoId = String(entry?.todoId || '');
                const fp = _resolveArchiveSourcePath(
                    effectiveQuestId(msg.questId), effectiveFile(msg.file), entry?.sourceFile,
                    isWorkspaceFileMode, workspaceFilePath,
                );
                if (!fp) { failed.push(todoId); continue; }
                const res = questTodo.updateTodoInFile(fp, todoId, updates);
                if (res) { updated.push(todoId); } else { failed.push(todoId); }
                if (res?.status === 'waiting-for-repeat') { waiting.push(todoId); }
            }
            const verb = isComplete ? 'Completed' : isReopen ? 'Reset' : 'Cancelled';
            if (updated.length) {
                const done = updated.length - waiting.length;
                const text = isComplete && waiting.length
                    ? `${done ? `Completed ${done} todo${done === 1 ? '' : 's'}; ` : ''}${waiting.length} repeated todo${waiting.length === 1 ? ' waits' : 's wait'} for the next repetition.`
                    : `${verb} ${updated.length} todo${updated.length === 1 ? '' : 's'}.`;
                vscode.window.showInformationMessage(text);
            }
            if (failed.length) {
                vscode.window.showWarningMessage(`Could not update ${failed.length} todo${failed.length === 1 ? '' : 's'}.`);
            }
            post({ type: 'qtStatusResult', success: updated.length > 0, wasStack: isStack });
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
                        }, SessionTodoStore.instance.shownSession);
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
                post({ type: 'qtTodos', todos: items, questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });

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
                    const items = questTodo.readTodoFile(fp).map(t => todoListItem(t, path.basename(fp)));
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
            const reopenSource = typeof msg.sourceFile === 'string' ? msg.sourceFile : undefined;
            const reopenFp = _resolveDeleteSourcePath(reqId, String(msg.todoId), reopenSource);
            if (reopenFp) {
                questTodo.updateTodoInFile(reopenFp, String(msg.todoId), { status: 'not-started', completed_date: '', completed_by: '' });
            } else {
                questTodo.updateTodo(reqId, msg.todoId, { status: 'not-started', completed_date: '', completed_by: '' });
            }
            _sendTodoList(reqId, effectiveFile(msg.file), post);
            // Refresh detail view for quest mode
            _sendTodoDetail(reqId, msg.todoId, post, reopenSource);
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
                            }, SessionTodoStore.instance.shownSession);
                            imported++;
                        } catch { /* skip */ }
                    }
                    vscode.window.showInformationMessage(`Imported ${imported} todo(s) from ${path.basename(importPath)}.`);
                    const refresh = SessionTodoStore.instance.list({ status: 'all' }, SessionTodoStore.instance.shownSession).map(t => ({
                        id: t.id, title: t.title,
                        status: t.status === 'done' ? 'completed' : 'not-started',
                        priority: t.priority, tags: t.tags,
                        created: t.createdAt.slice(0, 10), updated: t.updatedAt.slice(0, 10),
                        sourceFile: 'session',
                    }));
                    post({ type: 'qtTodos', todos: refresh, questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
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
                        const refreshItems = questTodo.readTodoFile(fp).map(t => todoListItem(t, path.basename(fp)));
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
        case 'qtMoveTodosToPickedFile': {
            // Move the selected / stacked todo(s) to another of the quest's
            // todo files, chosen via a quick pick limited to the quest's
            // non-terminal *.todo.yaml files (plus a "new file" option).
            if (isSessionMode || isWorkspaceFileMode) {
                vscode.window.showErrorMessage('Move to another todo file is only available in quest todo mode.');
                return true;
            }
            const questId = effectiveQuestId(msg.questId);
            if (!questId || questId.startsWith('__')) {
                vscode.window.showErrorMessage('Select a specific quest to move todos between files.');
                return true;
            }
            const entries: Array<{ todoId?: string; sourceFile?: string }> = Array.isArray(msg.todos) ? msg.todos : [];
            const validEntries = entries.filter(e => String(e?.todoId || ''));
            if (!validEntries.length) {
                vscode.window.showErrorMessage('No todo selected.');
                return true;
            }
            const sourceFiles = validEntries.map(e => String(e?.sourceFile || '')).filter(Boolean);
            const candidates = computeMoveTargetFiles(questTodo.listTodoFiles(questId), sourceFiles);
            const NEW_FILE = '$(new-file) New todo file…';
            const picked = await vscode.window.showQuickPick(
                [...candidates, NEW_FILE],
                {
                    title: `Move ${validEntries.length} todo${validEntries.length === 1 ? '' : 's'} to file`,
                    placeHolder: 'Select a target todo file in this quest',
                },
            );
            if (!picked) return true;
            let targetFile = picked;
            if (picked === NEW_FILE) {
                const entered = await vscode.window.showInputBox({
                    title: 'New todo file name',
                    prompt: 'File name for the new todo file (a .todo.yaml suffix is added if missing)',
                    value: `todos.${questId}.todo.yaml`,
                    validateInput: v => v && v.trim() ? undefined : 'Enter a file name',
                });
                if (!entered) return true;
                targetFile = entered.trim();
            }
            const moved: string[] = [];
            const failed: string[] = [];
            for (const entry of validEntries) {
                const todoId = String(entry?.todoId || '');
                const res = questTodo.moveTodo(questId, todoId, targetFile);
                if (res) { moved.push(todoId); } else { failed.push(todoId); }
            }
            const targetLabel = path.basename(targetFile).endsWith('.todo.yaml')
                ? path.basename(targetFile)
                : path.basename(targetFile).replace(/(\.yaml)?$/, '.todo.yaml');
            if (moved.length) {
                vscode.window.showInformationMessage(`Moved ${moved.length} todo${moved.length === 1 ? '' : 's'} to ${targetLabel}.`);
            }
            if (failed.length) {
                vscode.window.showWarningMessage(`Could not move ${failed.length} todo${failed.length === 1 ? '' : 's'}.`);
            }
            // Reuse the archive-result client path: refresh list + file dropdown
            // (a brand-new target file may have just been created).
            post({ type: 'qtArchiveResult', success: moved.length > 0, moved });
            return true;
        }
        case 'qtRenameTodo': {
            // The detail pane's ID edit button: the new id from an input box,
            // the todo renamed and every reference to it in the quest following.
            const questId = effectiveQuestId(msg.questId);
            const oldId = String(msg.todoId || '');
            if (!oldId || isSessionMode || isWorkspaceFileMode) { return true; }
            const taken = new Set(questTodo.readAllTodos(questId, questTodo.ALL_TODO_FILES).map((t) => t.id));
            if (!taken.has(oldId)) {
                vscode.window.showErrorMessage(`Todo not found: ${oldId}`);
                return true;
            }
            const typed = await vscode.window.showInputBox({
                title: `Rename todo ${oldId}`,
                prompt: `The new id. blocked_by / dependencies entries naming it in quest ${questId} follow; a prompt already queued keeps the old id in its text.`,
                value: oldId,
                // In place: the shape, a taken id, and the todo schema's id pattern (utils/todoIdRule).
                validateInput: (value) => todoIdInputError(value, oldId, taken) ?? (value.trim() !== oldId ? questTodo.todoIdRefusal(value.trim()) : undefined),
            });
            if (typed === undefined || typed.trim() === oldId) { return true; }
            const r = questTodo.renameQuestTodo(questId, oldId, typed.trim());
            if (!r.ok) {
                vscode.window.showErrorMessage(`Could not rename ${oldId}: ${r.reason}`);
                return true;
            }
            vscode.window.showInformationMessage(`Renamed ${oldId} → ${typed.trim()}${r.references ? ` (${r.references} reference${r.references === 1 ? '' : 's'} updated)` : ''}.`);
            post({ type: 'qtRenamed', oldId, todoId: typed.trim() });
            _sendTodoDetail(questId, typed.trim(), post, r.file);
            return true;
        }
        case 'qtRenameGroup': {
            // A group separator's rename button: the new prefix from an input
            // box (its info line the dry run's renames), then every live todo of
            // the group renamed, references following, a stub per old id
            // (questTodoManager.renameTodoPrefix).
            const questId = effectiveQuestId(msg.questId);
            const from = String(msg.prefix || '');
            if (!from || isSessionMode || isWorkspaceFileMode) { return true; }
            const typed = await vscode.window.showInputBox({
                title: `Rename group ${from} of quest ${questId}`,
                prompt: 'The new prefix. Every live todo of the group keeps the rest of its id; blocked_by / dependencies follow, in this quest and others; each committed old id keeps a stub in the -deleted sibling. The new ids must match the todo schema\'s id pattern.',
                value: from,
                validateInput: (value) => {
                    if (value.trim() === from) { return undefined; }
                    const plan = questTodo.renameTodoPrefix(questId, from, value, { dryRun: true });
                    if (!plan.ok) { return plan.reason; }
                    return { message: renamePreview(plan.renames), severity: vscode.InputBoxValidationSeverity.Info };
                },
            });
            if (typed === undefined || typed.trim() === from) { return true; }
            const r = questTodo.renameTodoPrefix(questId, from, typed);
            if (!r.ok) {
                vscode.window.showErrorMessage(`Could not rename group ${from}: ${r.reason}`);
                return true;
            }
            const docs = r.documents.length
                ? ` Still naming ${from}<n>: ${r.documents.map((d) => `${d.file} (${d.count})`).join(', ')}.`
                : '';
            const kept = r.keptArchived ? ` ${r.keptArchived} archived or deleted todo${r.keptArchived === 1 ? '' : 's'} keep the old prefix.` : '';
            vscode.window.showInformationMessage(`Renamed ${r.renames.length} todo${r.renames.length === 1 ? '' : 's'} of ${from} to ${typed.trim()} (${r.references} reference${r.references === 1 ? '' : 's'} updated).${kept}${docs}`);
            post({ type: 'qtGroupRenamed', renames: r.renames });
            return true;
        }
        case 'qtMoveTodosToDestination': {
            // The row's move button: the clicked todo, or every stacked todo
            // when more than one is stacked. A picker asks where to: the
            // todos' quest, the workspace todos, or another quest.
            const entries: Array<{ todoId?: string; sourceFile?: string }> = Array.isArray(msg.todos) ? msg.todos : [];
            const sources = entries.filter(e => String(e?.todoId || '')).map(e => _resolveMoveSource(
                { isSessionMode, isWorkspaceFileMode, workspaceFilePath, questId: effectiveQuestId(msg.questId) },
                String(e.todoId), typeof e.sourceFile === 'string' ? e.sourceFile : undefined,
            ));
            const found = sources.filter((s): s is MoveSource => !!s.path) as MoveSource[];
            const lost = sources.filter(s => !s.path).map(s => s.todoId);
            if (!found.length) {
                vscode.window.showErrorMessage(`Could not find ${lost.join(', ') || 'the todo'} in a todo file.`);
                return true;
            }
            const title = todoMovePickerTitle(found.length);
            const options = todoMoveOptions(found.map(s => s.origin));
            const picked = await vscode.window.showQuickPick(
                options.map(o => ({ label: o.label, description: o.description, choice: o.choice })),
                { title, placeHolder: 'Where should the todos go?' },
            );
            if (!picked) return true;
            if (picked.choice.kind === 'pickGroup') {
                await _moveTodosToGroup(picked.choice.questId, found, lost);
                post({ type: 'qtArchiveResult', success: true, moved: [] });
                return true;
            }
            let dest: questTodo.TodoMoveDestination;
            if (picked.choice.kind === 'pickQuest') {
                const quest = await vscode.window.showQuickPick(
                    listQuestIds().map(q => ({ label: q, description: `todos.${q}.todo.yaml` })),
                    { title: title.replace(/…$/, ' quest…'), placeHolder: 'Select the quest' },
                );
                if (!quest) return true;
                dest = { kind: 'quest', questId: quest.label };
            } else {
                dest = picked.choice;
            }
            // Into another quest: one id decision for every moved todo —
            // number them into one of the quest's groups, under a prefix of
            // your own, or keep the ids.
            let renames: Map<string, string> | undefined;
            if (dest.kind === 'quest' && todoMoveNeedsIdChoice(found.map(s => s.origin), dest)) {
                const targetIds = questTodo.readAllTodos(dest.questId, questTodo.ALL_TODO_FILES).map(t => t.id);
                const liveTargetIds = questTodo.readAllTodos(dest.questId).map(t => t.id);
                const movingIds = found.map(s => s.todoId);
                const icon = { group: '$(symbol-number)', custom: '$(edit)', keep: '$(circle-slash)' };
                const idPick = await vscode.window.showQuickPick(
                    todoPrefixChoices(targetIds, liveTargetIds).map(o => ({ label: `${icon[o.kind]} ${o.label}`, description: o.description, option: o })),
                    { title: `Ids of the ${found.length === 1 ? 'moved todo' : `${found.length} moved todos`} in quest ${dest.questId}`, placeHolder: 'Number them into one of the quest\'s groups, under a prefix of your own, or keep the ids' },
                );
                if (!idPick) { return true; }
                let prefix = idPick.option.prefix;
                if (idPick.option.kind === 'custom') {
                    const typed = await vscode.window.showInputBox({
                        title: `Prefix for the ${found.length === 1 ? 'moved todo' : `${found.length} moved todos`} in quest ${dest.questId}`,
                        prompt: 'Each todo gets the prefix and the next free number, keeping the rest of its id.',
                        placeHolder: 'e.g. qrm',
                        validateInput: (value) => {
                            const error = validateTodoPrefix(value) ?? questTodo.todoIdsRefusal(todoRenames(movingIds, targetIds, value.trim()).values());
                            if (error) { return error; }
                            return { message: todoPrefixPreview(movingIds, targetIds, value.trim()), severity: vscode.InputBoxValidationSeverity.Info };
                        },
                    });
                    if (typed === undefined) { return true; }
                    prefix = typed.trim();
                }
                renames = todoRenames(movingIds, targetIds, prefix);
                const refused = questTodo.todoIdsRefusal(renames.values());
                if (refused) {
                    vscode.window.showErrorMessage(`Could not move: ${refused}`);
                    return true;
                }
            }
            const moved: string[] = [];
            const failed: string[] = [];
            for (const s of found) {
                try {
                    const r = questTodo.moveTodoToDestination(s.path, s.todoId, dest, s.originLabel, renames);
                    if (r.ok) { moved.push(renames?.get(s.todoId) ?? s.todoId); } else { failed.push(`${s.todoId}: ${r.reason}`); }
                } catch (e) {
                    failed.push(`${s.todoId}: ${(e as Error).message}`);
                }
            }
            const target = dest.kind === 'quest' ? `quest ${dest.questId}` : 'workspace todos';
            if (moved.length) {
                const renamed = renames && renames.size ? ` as ${moved.join(', ')}` : '';
                vscode.window.showInformationMessage(`Moved ${moved.length} todo${moved.length === 1 ? '' : 's'} to ${target}${renamed}.`);
            }
            if (failed.length || lost.length) {
                vscode.window.showWarningMessage(`Could not move: ${[...failed, ...lost.map(id => `${id}: not found`)].join('; ')}`);
            }
            post({ type: 'qtArchiveResult', success: moved.length > 0, moved });
            if (isSessionMode) {
                const sessionQuestId = _getSessionQuestId();
                post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
            }
            return true;
        }
        case 'qtSelectSession': {
            if (!isSessionMode) { return true; }
            try { SessionTodoStore.instance.shownSession = String(msg.session || 'default'); } catch { return true; }
            post({ type: 'qtTodos', todos: _collectSessionTodos(_getSessionQuestId()), questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
            return true;
        }
        case 'qtDeleteAllSessionTodos': {
            if (!isSessionMode) {
                return true;
            }

            const sessionQuestId = _getSessionQuestId();
            const sessionFiles = _listSessionTodoFiles(sessionQuestId);
            if (!sessionFiles.length) {
                vscode.window.showInformationMessage(`The session "${SessionTodoStore.instance.shownSession}" has no todos.`);
                post({ type: 'qtTodos', todos: [], questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
                return true;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Delete all todos of the session "${SessionTodoStore.instance.shownSession}"?`,
                { modal: true },
                'Delete All',
            );
            if (confirm !== 'Delete All') {
                return true;
            }

            let deletedFiles = 0;
            const currentSessionFile = path.basename(SessionTodoStore.instance.filePathFor(SessionTodoStore.instance.shownSession));
            for (const fileName of sessionFiles) {
                const fp = _sessionTodoAbsolutePath(sessionQuestId, fileName);
                if (!fp || !fs.existsSync(fp)) {
                    continue;
                }
                try {
                    if (fileName === currentSessionFile) {
                        const currentItems = SessionTodoStore.instance.list({ status: 'all' }, SessionTodoStore.instance.shownSession);
                        for (const item of currentItems) {
                            SessionTodoStore.instance.delete(item.id, SessionTodoStore.instance.shownSession);
                        }
                    }
                    fs.unlinkSync(fp);
                    deletedFiles++;
                } catch {
                    // Best-effort: continue deleting remaining files.
                }
            }

            post({ type: 'qtTodos', todos: _collectSessionTodos(sessionQuestId), questId: '__session__', file: 'all', sessionSwitch: _sessionSwitchState() });
            vscode.window.showInformationMessage(`Deleted the todos of the session "${SessionTodoStore.instance.shownSession}" (${deletedFiles} file).`);
            return true;
        }
        case 'qtRenderMarkdown':
            // A todo's description, notes or last_answer as safe HTML for the panel's markdown overlay.
            post({ type: 'qtMarkdownHtml', title: String(msg.title || ''), html: renderQuestLogMarkdown(String(msg.markdown || '')) });
            return true;
        case 'qtShowAgentAnswer': {
            // A todo's agent answer: the newest trail answer that reported it,
            // else the stored last_answer; in the overlay or the preview editor.
            const todoId = String(msg.todoId || '');
            const quest = (effectiveQuestId(msg.questId) && effectiveQuestId(msg.questId) !== '__session__')
                ? effectiveQuestId(msg.questId) : (WsPaths.getWorkspaceQuestId() || '');
            const found = _latestAgentAnswer(quest, todoId, msg.sourceFile ? String(msg.sourceFile) : undefined);
            const markdown = found?.content ?? (String(msg.fallback || '').trim() ? String(msg.fallback) : '');
            const title = `${todoId} \u2014 Agent answer` + (found ? ` (${found.session}, ${found.when})` : (markdown ? ' (stored)' : ''));
            if (!markdown) {
                if (msg.mode === 'editor') {
                    void vscode.window.showInformationMessage(`No agent answer recorded for ${todoId} yet.`);
                } else {
                    post({ type: 'qtMarkdownHtml', title, html: '<p class="tom-md-empty">No agent answer recorded for this todo yet: no answer in the quest\'s session trails reports it (TODO=&lt;ref&gt;), and no todo walk stored one.</p>' });
                }
                return true;
            }
            if (msg.mode === 'editor') {
                if (_extensionContext) { await showMarkdownHtmlPreview(_extensionContext, { title, markdown }); }
            } else {
                post({ type: 'qtMarkdownHtml', title, html: renderQuestLogMarkdown(markdown) });
            }
            return true;
        }
        case 'qtGuideUserAction':
        case 'qtTodoButton': {
            // The todo detail's buttons, always on Anthropic: Send runs the todo now
            // in the @CHAT panel (its profile and session), Queue adds it to the
            // prompt queue (staged). The template is the Status Page's Todo buttons
            // setting: the user-action one for Guide me and for a user-action todo,
            // the other one for every other todo (todoButtonTemplates.ts).
            const questId = effectiveQuestId(msg.questId);
            const todoId = String(msg.todoId || '');
            const todo = todoId ? _findTodoForPromptAction(questId, todoId, msg.sourceFile) : undefined;
            if (!todo) {
                vscode.window.showErrorMessage(`Todo not found: ${todoId || '(none selected)'}`);
                return true;
            }
            const use = msg.type === 'qtGuideUserAction' ? 'userAction' : todoButtonTemplateUse(todo);
            // The same todo sent the same way within 3 s is a double click (duplicateSubmitGuard.ts).
            if (_todoButtonGuard.isDuplicate({ text: `${questId}/${todo.id}`, transport: msg.target === 'queue' ? 'queue' : 'chat', template: use })) {
                vscode.window.setStatusBarMessage(`$(info) Already ${msg.target === 'queue' ? 'queued' : 'sent'}: todo ${todo.id} within 3 s`, 4000);
                return true;
            }
            await _runTodoButton(todo, questId, msg.sourceFile, use, msg.target === 'queue' ? 'queue' : 'chat');
            return true;
        }
        case 'qtOpenMarkdownPreview':
            // The same text in the markdown preview editor, in the editor area.
            if (_extensionContext) {
                await showMarkdownHtmlPreview(_extensionContext, { title: String(msg.title || 'Markdown'), markdown: String(msg.markdown || '') });
            }
            return true;
        case 'qtOpenYaml':
            if (isSessionMode) {
                try {
                    const sessionFp = SessionTodoStore.instance.filePathFor(SessionTodoStore.instance.shownSession);
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
                const sessionItems = SessionTodoStore.instance.list({ status: 'all' }, SessionTodoStore.instance.shownSession);
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
            const trailFolder = questTrailFolder(questFolder);
            if (!fs.existsSync(trailFolder)) {
                fs.mkdirSync(trailFolder, { recursive: true });
            }
            const promptsPath = path.join(trailFolder, `${questId}.copilot.prompts.md`);
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
            const wrappedText = _todoPromptFragment(todo, questId, msg.sourceFile).yaml;
            const selectedTemplate = (msg.template && msg.template !== '__none__') ? String(msg.template) : undefined;
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                const queue = PromptQueueManager.instance;
                await queue.enqueue({
                    originalText: wrappedText,
                    todoIdPattern: todo.id,
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
            const todoPrompt = buildStackedTodoPrompt([_todoPromptFragment(todo, questId, msg.sourceFile)]);
            await _sendTodoPromptViaQueueTransport(todoPrompt, String(msg.template || '__none__'));
            return true;
        }
        case 'qtQueueGroupPrompt': {
            await queueGroupWalk(effectiveQuestId(msg.questId), String(msg.prefix || ''));
            return true;
        }
        case 'qtQueueStackedTodos': {
            // One prompt PER stacked todo, enqueued in stack order. Each todo is
            // embedded exactly like the single-todo queue add: default-template
            // wrapped yaml fragment as originalText, the selected template id
            // (e.g. TODO Execution / execute-todo) applied by the queue at send
            // time via its ${originalPrompt} / ${userMessage} placeholder.
            const questId = effectiveQuestId(msg.questId);
            const entries: Array<{ todoId?: string; sourceFile?: string }> = Array.isArray(msg.todos) ? msg.todos : [];
            if (!entries.length) {
                vscode.window.showErrorMessage('Todo stack is empty.');
                return true;
            }
            const selectedTemplate = (msg.template && msg.template !== '__none__') ? String(msg.template) : undefined;
            const prepared: Array<{ text: string; todoId: string }> = [];
            const missing: string[] = [];
            for (const entry of entries) {
                const todoId = String(entry?.todoId || '');
                const todo = todoId ? _findTodoForPromptAction(questId, todoId, entry?.sourceFile) : undefined;
                if (!todo) {
                    missing.push(todoId || '?');
                    continue;
                }
                prepared.push({ text: _todoPromptFragment(todo, questId, entry?.sourceFile).yaml, todoId: todo.id });
            }
            if (!prepared.length) {
                vscode.window.showErrorMessage(`No stacked todos found (missing: ${missing.join(', ')})`);
                return true;
            }
            try {
                const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
                const queue = PromptQueueManager.instance;
                for (const { text: originalText, todoId } of prepared) {
                    await queue.enqueue({
                        originalText,
                        todoIdPattern: todoId,
                        template: selectedTemplate,
                        deferSend: true,
                    });
                }
                const suffix = missing.length ? ` (skipped missing: ${missing.join(', ')})` : '';
                vscode.window.showInformationMessage(`Added ${prepared.length} stacked todo${prepared.length === 1 ? '' : 's'} to prompt queue${suffix}`);
            } catch {
                vscode.window.showWarningMessage('Prompt queue not available');
            }
            return true;
        }
        case 'qtSendStackedTodos': {
            // ALL stacked todos combine into a SINGLE prompt: the yaml fragments
            // concatenate into one todo list, with one numbered REQUIRED
            // responseValue line per todo (buildStackedTodoPrompt). The combined
            // block then rides the same template embedding as a single todo.
            const questId = effectiveQuestId(msg.questId);
            const entries: Array<{ todoId?: string; sourceFile?: string }> = Array.isArray(msg.todos) ? msg.todos : [];
            if (!entries.length) {
                vscode.window.showErrorMessage('Todo stack is empty.');
                return true;
            }
            const fragments: StackedTodoFragment[] = [];
            const missing: string[] = [];
            for (const entry of entries) {
                const todoId = String(entry?.todoId || '');
                const todo = todoId ? _findTodoForPromptAction(questId, todoId, entry?.sourceFile) : undefined;
                if (!todo) {
                    missing.push(todoId || '?');
                    continue;
                }
                fragments.push(_todoPromptFragment(todo, questId, entry?.sourceFile));
            }
            if (!fragments.length) {
                vscode.window.showErrorMessage(`No stacked todos found (missing: ${missing.join(', ')})`);
                return true;
            }
            if (missing.length) {
                vscode.window.showWarningMessage(`Skipping missing stacked todos: ${missing.join(', ')}`);
            }
            await _sendTodoPromptViaQueueTransport(buildStackedTodoPrompt(fragments), String(msg.template || '__none__'));
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
                    const sessionItems = SessionTodoStore.instance.list({ status: 'all' }, SessionTodoStore.instance.shownSession);
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
    const post = (m: any) => webview.postMessage(_withQueueMarks(m, webview));
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
            // The picker is how the user BROWSES to the archive/delete
            // siblings, so it lists every todo file of the quest.
            files = questTodo.listTodoFiles(questId, questTodo.ALL_TODO_FILES);
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
    // The session the view shows: its own file in its storage root.
    let store: SessionTodoStore;
    try { store = SessionTodoStore.instance; } catch { return []; }
    return fs.existsSync(store.filePathFor(store.shownSession)) ? [sessionTodoSourceFile(store.shownSession)] : [];
}

/**
 * The SESSION TODOS view's session switch: the sessions that have todos, most
 * recently written first, one button each for the most recent (a dropdown with
 * all of them when there are more), each with its open-todo count; the shown
 * session always among them.
 */
function _sessionSwitchState(): { plan: SessionSwitchPlan; counts: Record<string, { open: number; total: number }> } | undefined {
    let store: SessionTodoStore;
    try { store = SessionTodoStore.instance; } catch { return undefined; }
    const counts = store.counts().filter((c) => c.total > 0);
    const shown = store.shownSession;
    const sessions = counts.map((c) => ({ name: c.session, lastUse: c.lastWrite }));
    if (!sessions.some((x) => x.name === shown)) { sessions.push({ name: shown } as { name: string; lastUse: number }); }
    const plan = planSessionSwitch(sessions, shown, 'default');
    return { plan, counts: Object.fromEntries(counts.map((c) => [c.session, { open: c.open, total: c.total }])) };
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
            todos.push({ ...todoListItem(t, sourceFile, _composeSessionTodoId(sourceFile, t.id)) });
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
    return questTodo.moveTodoToSiblingByStatus(filePath, todoId);
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
        const list = items.map(t => todoListItem(t, t._sourceFile ?? ''));
        post({ type: 'qtTodos', todos: list, questId, file: file ?? 'all' });
        _sendFileList(questId, post);
    } catch { /* */ }
}

function _sendTodoDetail(questId: string, todoId: string, post: (m: any) => void, sourceFile?: string): void {
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
        // Resolve the file that actually holds the todo. The selected file may
        // be any of the quest's `*.todo.yaml` files, not just the main one, so
        // honour the caller's sourceFile hint and fall back to scanning the
        // quest's files — reading only the main file strands the detail pane
        // empty when a secondary file is being browsed.
        const fp = _resolveDeleteSourcePath(questId, todoId, sourceFile);
        todo = fp ? questTodo.findTodoByIdInFile(fp, todoId) : undefined;
    }
    const payload: any = todo ? { ...todo } : null;
    if (payload && resolvedQuestId !== questId) { payload._resolvedQuestId = resolvedQuestId; }
    post({ type: 'qtTodoDetail', todo: payload, questId, todoId });
}

function _saveTodo(questId: string, todoId: string, updates: any, post: (m: any) => void): void {
    const current = questTodo.findTodoById(questId, todoId);
    if (current) {
        // Nothing the form sends differs: answer saved without a write.
        const same = todoFormUnchanged(current as unknown as Record<string, unknown>,
            { ...updates, decisions: questTodo.normaliseTodoDecisions(updates.decisions) });
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
            for (const fileName of questTodo.listTodoFiles(questId, questTodo.ALL_TODO_FILES)) {
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

/** The renames of a group rename, for the input box: the first three, then the count. */
function renamePreview(renames: ReadonlyArray<{ from: string; to: string }>): string {
    const pairs = renames.map((r) => `${r.from} → ${r.to}`);
    return pairs.length > 3 ? `${pairs.slice(0, 3).join(', ')}, … (${pairs.length} todos)` : pairs.join(', ');
}

/** A todo the move picker acts on: its file, its plain id, and where it lives. */
/**
 * Move todos into another id group of their quest: a group picked (or a new
 * prefix typed), each todo renamed to the group's next numbers below its
 * finalizers (`<prefix>999` and higher), placed at the end of the group before
 * them — in the file that holds the group's last todo — and every reference to
 * it in the quest following (questTodoManager.renameQuestTodo).
 */
async function _moveTodosToGroup(questId: string, found: readonly MoveSource[], lost: readonly string[]): Promise<void> {
    const movingIds = found.map((s) => s.todoId);
    const all = questTodo.readAllTodos(questId, questTodo.ALL_TODO_FILES);
    const otherIds = all.map((t) => t.id).filter((id) => !movingIds.includes(id));
    const liveOtherIds = all.filter((t) => !t._sourceFile || !isArchivedOrDeletedTodoFile(path.basename(t._sourceFile))).map((t) => t.id).filter((id) => !movingIds.includes(id));
    const ownGroups = new Set(movingIds.map(todoIdPrefix));
    const groups = todoPrefixChoices(otherIds, liveOtherIds)
        .filter((o) => o.kind !== 'keep' && !(o.kind === 'group' && ownGroups.size === 1 && ownGroups.has(o.prefix ?? '')));
    const count = found.length === 1 ? 'the todo' : `the ${found.length} todos`;
    const icon = { group: '$(symbol-number)', custom: '$(edit)', keep: '' };
    const pick = await vscode.window.showQuickPick(
        groups.map((o) => ({ label: `${icon[o.kind]} ${o.label}`, description: o.description, option: o })),
        { title: `Move ${count} to another group of ${questId}`, placeHolder: 'The group they are numbered into, at its end (before its finalizers, 999)' },
    );
    if (!pick) { return; }
    let prefix = pick.option.prefix;
    if (pick.option.kind === 'custom') {
        const typed = await vscode.window.showInputBox({
            title: `Group prefix for ${count} in quest ${questId}`,
            prompt: 'Each todo gets the prefix and the next free number below 999, keeping the rest of its id.',
            placeHolder: 'e.g. qrm',
            validateInput: (value) => {
                const error = validateTodoPrefix(value) ?? questTodo.todoIdsRefusal(todoRenames(movingIds, otherIds, value.trim()).values());
                if (error) { return error; }
                return { message: todoPrefixPreview(movingIds, otherIds, value.trim()), severity: vscode.InputBoxValidationSeverity.Info };
            },
        });
        if (typed === undefined) { return; }
        prefix = typed.trim();
    }
    if (!prefix) { return; }
    const renames = todoRenames(movingIds, otherIds, prefix);
    const refused = questTodo.todoIdsRefusal(renames.values());
    if (refused) {
        vscode.window.showErrorMessage(`Could not move to group ${prefix}: ${refused}`);
        return;
    }
    if (renamesReachFinalizer(renames, prefix)) {
        vscode.window.showErrorMessage(`Group ${prefix} has no free number below its finalizers (999) for ${count}.`);
        return;
    }
    // The group's file: the one holding its last todo below the finalizers, else a finalizer, else the quest's own.
    const live = all.filter((t) => !movingIds.includes(t.id) && t._sourceFile && !/-(archived|deleted)\./.test(t._sourceFile));
    const inGroup = live.filter((t) => todoIdPrefix(t.id) === prefix);
    const below = inGroup.filter((t) => (numberIn(t.id, prefix!) ?? 0) < FINALIZER_INDEX);
    const holder = (below.length ? below : inGroup).sort((a, b) => (numberIn(b.id, prefix!) ?? 0) - (numberIn(a.id, prefix!) ?? 0))[0];
    const targetFile = holder?._sourceFile ? questTodo.questTodoFilePath(questId, holder._sourceFile) : questTodo.persistentTodoPath(questId);
    const moved: string[] = [];
    const failed: string[] = [];
    let references = 0;
    for (const s of found) {
        const to = renames.get(s.todoId)!;
        try {
            const r = questTodo.renameQuestTodo(questId, s.todoId, to, { group: prefix, targetFile });
            if (r.ok) { moved.push(`${s.todoId} → ${to}`); references += r.references; } else { failed.push(`${s.todoId}: ${r.reason}`); }
        } catch (e) {
            failed.push(`${s.todoId}: ${(e as Error).message}`);
        }
    }
    if (moved.length) {
        vscode.window.showInformationMessage(`Moved to group ${prefix}: ${moved.join(', ')}${references ? ` (${references} reference${references === 1 ? '' : 's'} updated)` : ''}.`);
    }
    if (failed.length || lost.length) {
        vscode.window.showWarningMessage(`Could not move: ${[...failed, ...lost.map((id) => `${id}: not found`)].join('; ')}`);
    }
}

interface MoveSource {
    todoId: string;
    path: string;
    origin: TodoMoveOrigin;
    /** Written into the todo's notes when it leaves (`quest: <id>` / `workspace` / the file). */
    originLabel: string;
}

/** Find the file a todo of this panel lives in, by the panel's mode. */
function _resolveMoveSource(
    mode: { isSessionMode: boolean; isWorkspaceFileMode: boolean; workspaceFilePath: () => string | undefined; questId: string },
    rawTodoId: string,
    sourceFile: string | undefined,
): { todoId: string; path?: string; origin: TodoMoveOrigin; originLabel: string } {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const questOrigin = (questId: string, file: string): { origin: TodoMoveOrigin; originLabel: string } => ({
        origin: { questId, inQuestMainFile: path.basename(file) === `todos.${questId}.todo.yaml`, inWorkspaceFile: false },
        originLabel: `quest: ${questId}`,
    });
    if (mode.isSessionMode) {
        const target = _parseSessionTodoTarget(rawTodoId, sourceFile);
        const questId = _getSessionQuestId();
        const fp = target.sourceFile ? _sessionTodoAbsolutePath(questId, target.sourceFile) : undefined;
        return { todoId: target.todoId, path: fp, ...questOrigin(questId, fp ?? '') };
    }
    if (mode.isWorkspaceFileMode) {
        const fp = mode.workspaceFilePath();
        const origin = todoOriginOfRelativePath(fp ? path.relative(wsRoot, fp) : '');
        return { todoId: rawTodoId, path: fp, origin, originLabel: origin.inWorkspaceFile ? 'workspace' : path.basename(fp ?? '') };
    }
    if (mode.questId === '__all_workspace__' && sourceFile) {
        const origin = todoOriginOfRelativePath(sourceFile);
        return {
            todoId: rawTodoId,
            path: path.join(wsRoot, sourceFile),
            origin,
            originLabel: origin.questId ? `quest: ${origin.questId}` : (origin.inWorkspaceFile ? 'workspace' : sourceFile),
        };
    }
    const questIds = mode.questId && !mode.questId.startsWith('__') ? [mode.questId] : listQuestIds();
    for (const questId of questIds) {
        const fp = questTodo.questTodoSourcePath(questId, rawTodoId, sourceFile);
        if (fp) { return { todoId: rawTodoId, path: fp, ...questOrigin(questId, fp) }; }
    }
    return { todoId: rawTodoId, origin: { inQuestMainFile: false, inWorkspaceFile: false }, originLabel: '' };
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
/**
 * A todo detail button (Send / Queue, Guide me): the todo with the template of
 * `use` (the Status Page's Todo buttons setting), on Anthropic whatever the
 * queue's transport — sent now in the @CHAT panel, or added to the queue staged.
 */
/** The double-click guard of the todo detail's buttons. */
const _todoButtonGuard = new DuplicateSubmitGuard();

async function _runTodoButton(
    todo: questTodo.QuestTodoItem,
    questId: string | undefined,
    sourceFile: string | undefined,
    use: TodoButtonTemplateUse,
    target: 'chat' | 'queue',
): Promise<void> {
    const anthropic = loadSendToChatConfig()?.anthropic;
    const tpl = resolveTodoButtonTemplate(anthropic?.todoButtonTemplates, anthropic?.userMessageTemplates, use);
    if (tpl.missing || !tpl.body) {
        vscode.window.showWarningMessage(`The Todo buttons template "${tpl.id}" (${TODO_BUTTON_TEMPLATE_INFO[use].label}) is not among the Anthropic templates: choose one on the Status Page (Todo buttons).`);
        return;
    }
    if (target === 'queue') {
        await _queueTodo(todo, questId, sourceFile, tpl);
        return;
    }
    const ctx = _extensionContext;
    if (!ctx) {
        vscode.window.showErrorMessage('Extension context unavailable — cannot send to Anthropic.');
        return;
    }
    const todoPrompt = buildStackedTodoPrompt([_todoPromptFragment(todo, questId, sourceFile)]);
    const { runAnthropicSend } = await import('./sendToChatRouter.js');
    const outcome = await runAnthropicSend(ctx, todoPrompt, { userMessageTemplate: tpl.body, source: `todo panel: ${use === 'userAction' ? 'guide me' : 'send'}` });
    if (outcome.rejected) {
        vscode.window.showWarningMessage('Anthropic chat is busy — try again once the current request finishes.');
    } else if (!outcome.ok && outcome.error) {
        vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
    } else if (outcome.ok && use === 'userAction' && questId) {
        await _guideMeClosing(todo.id, questId, sourceFile);
    }
}

/** The todo added to the prompt queue, staged, on Anthropic, with template `tpl`. */
async function _queueTodo(todo: questTodo.QuestTodoItem, questId: string | undefined, sourceFile: string | undefined, tpl: { id: string; name: string }): Promise<void> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        await PromptQueueManager.instance.enqueue({
            originalText: _todoPromptFragment(todo, questId, sourceFile).yaml,
            todoIdPattern: todo.id,
            template: tpl.id,
            transport: 'anthropic',
            deferSend: true,
        });
        vscode.window.showInformationMessage(`Added todo ${todo.id} to the prompt queue with the template "${tpl.name}" (staged, Anthropic).`);
    } catch {
        vscode.window.showWarningMessage('Prompt queue not available');
    }
}

/**
 * After Guide me's turn (guideMeClosing.ts): a todo not completed meanwhile is
 * offered to be marked completed or in progress, queued for the agent (the
 * other todos' template), or left; a typed reply goes into its notes.
 */
async function _guideMeClosing(todoId: string, questId: string, sourceFile: string | undefined): Promise<void> {
    const todo = _findTodoForPromptAction(questId, todoId, sourceFile);
    if (!todo || todo.status === 'completed' || todo.status === 'cancelled') { return; }
    const anthropic = loadSendToChatConfig()?.anthropic;
    const queueTpl = resolveTodoButtonTemplate(anthropic?.todoButtonTemplates, anthropic?.userMessageTemplates, 'other');
    const { askUserWithChoices } = await import('./askUser-handler.js');
    const { readChatQuestionsConfig } = await import('./chatQuestions-config.js');
    const reply = await askUserWithChoices(guideMeClosingAsk(todo, queueTpl.name || queueTpl.id));
    const pick = interpretGuideMeReply(reply, readChatQuestionsConfig().fallbackPrompt);
    if (!pick) { return; }
    // The user's own words, beside a choice or alone, go into the todo's notes.
    const note = pick.kind === 'note' ? pick.text : pick.note;
    const noted: Partial<Omit<questTodo.QuestTodoItem, 'id' | '_sourceFile'>> = note ? { notes: appendTodoNote(todo.notes, note, todayLocalDate()) } : {};
    if (pick.kind === 'queue') {
        if (queueTpl.missing || !queueTpl.body) {
            vscode.window.showWarningMessage(`The Todo buttons template "${queueTpl.id}" is not among the Anthropic templates: choose one on the Status Page (Todo buttons).`);
            return;
        }
        if (note) { questTodo.updateTodo(questId, todo.id, noted); }
        await _queueTodo(todo, questId, sourceFile, queueTpl);
        return;
    }
    const updates: Partial<Omit<questTodo.QuestTodoItem, 'id' | '_sourceFile'>> = pick.kind === 'complete'
        ? { status: 'completed', completed_date: todayLocalDate(), ...noted }
        : pick.kind === 'inProgress'
            ? { status: 'in-progress', ...noted }
            : noted;
    const updated = questTodo.updateTodo(questId, todo.id, updates);
    if (!updated) { vscode.window.showWarningMessage(`Todo ${todo.id} could not be updated.`); return; }
    const done = pick.kind === 'complete' ? 'completed' : pick.kind === 'inProgress' ? 'in progress' : 'given the note';
    vscode.window.setStatusBarMessage(`$(check) Todo ${todo.id} ${done}`, 4000);
}

/**
 * The newest answer in the quest's session trails that reported the todo
 * (todoAgentAnswer), with the session it was in and when.
 */
function _latestAgentAnswer(questId: string, todoId: string, sourceFile?: string): { content: string; session: string; when: string } | undefined {
    if (!questId || !todoId) { return undefined; }
    const folder = questTrailFolder(WsPaths.ai('quests', questId) || '');
    if (!folder || !fs.existsSync(folder)) { return undefined; }
    const sets = todoLogTrailSets(folder, discoverTrailSets);
    let best: { content: string; session: string; when: string; timestamp: string } | undefined;
    for (const [name] of sets) {
        const hit = latestTodoAnswer(loadTrailSet(name, sets), { questId, todoId, sourceFile });
        if (hit && (!best || hit.timestamp.localeCompare(best.timestamp) > 0)) {
            best = { content: hit.content, session: name, when: hit.rawTimestamp || hit.timestamp, timestamp: hit.timestamp };
        }
    }
    return best;
}

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

/**
 * Send a fully built todo prompt (single or stacked, incl. the REQUIRED
 * responseValue footer) via the prompt queue's currently selected transport
 * (Bug 3): the Anthropic chat transport when the queue targets Anthropic
 * (template body applied as the user-message wrapper), Copilot chat otherwise
 * (template applied through the ${originalPrompt} / answer-file expansion).
 */
async function _sendTodoPromptViaQueueTransport(todoPrompt: string, selectedTemplate: string): Promise<void> {
    const config = loadSendToChatConfig();
    const { transport } = await _queueSendTarget();
    if (transport === 'anthropic') {
        const ctx = _extensionContext;
        if (!ctx) {
            vscode.window.showErrorMessage('Extension context unavailable — cannot send to Anthropic.');
            return;
        }
        const tplBody = (selectedTemplate && selectedTemplate !== '__none__')
            ? config?.anthropic?.userMessageTemplates?.find((t) => t.id === selectedTemplate)?.template
            : undefined;
        const { runAnthropicSend } = await import('./sendToChatRouter.js');
        const outcome = await runAnthropicSend(ctx, todoPrompt, { source: 'todo panel', ...(tplBody ? { userMessageTemplate: tplBody } : {}) });
        if (outcome.rejected) {
            vscode.window.showWarningMessage('Anthropic chat is busy — try again once the current request finishes.');
        } else if (!outcome.ok && outcome.error) {
            vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
        }
        return;
    }

    // A todo button waits for the answer: the template (one store) inside the
    // Copilot Queue Wrapper (src/utils/copilotTemplates.ts).
    const body = userMessageTemplateBody(config, selectedTemplate);
    const inner = body ? await expandTemplate(fillTemplate(body, todoPrompt)) : todoPrompt;
    const expanded = await expandTemplate(fillWrapper(copilotQueueWrapper(config), inner));

    // The record's `$${` (escaped against the passes above) become `${` here, where the text leaves.
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: unescapePlaceholders(expanded) });
}

/**
 * A todo as the panel sends it: its qualified reference and its whole stored
 * record (todoSendBlock, todoYamlBlock) — the same record a todo iteration
 * appends, so every template (Execute TODO, Guide me, Explain TODO, …) gets it.
 */
function _todoPromptFragment(todo: questTodo.QuestTodoItem, questId?: string, sourceFileHint?: string): StackedTodoFragment {
    const sourcePath = _resolveTodoSourcePath(todo, questId, sourceFileHint);
    const ref = sourcePath ? `${sourcePath}/${todo.id}` : todo.id;
    return { ref, yaml: todoSendBlock(ref, todoYamlBlock(todo as unknown as Record<string, unknown>, sourcePath)) };
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
    const shared = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'shared', file)).toString();
    const questHintCss = config?.questHint ? `<link rel="stylesheet" href="${shared('questHint.css')}">` : '';
    const questHintJs = config?.questHint ? `<script src="${shared('questHint.js')}"></script>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconsUri}">
${questHintCss}
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
${questHintJs}
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
        if (this.config?.questHint) {
            this.context.subscriptions.push(wireQuestHintMessages(webviewView.webview));
        }

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

/**
 * The todo group headline's "Queue Group Prompt": pick a group prompt (the
 * default, the default with an addition, or one of the quest's own prompts)
 * or open the group prompt editor, then queue a walk over `<prefix>*` with the
 * prompt picked. A walk goes over the todos of the window's quest, so a list
 * showing another quest is refused. The queue holds a walk with nothing to
 * walk over in `error` at once; that reason is shown.
 */
async function queueGroupWalk(questId: string, prefix: string): Promise<void> {
    if (!prefix) { return; }
    let windowQuest = '';
    try { windowQuest = ChatVariablesStore.instance.quest || ''; } catch { windowQuest = ''; }
    if (!questId || questId !== windowQuest) {
        void vscode.window.showWarningMessage(`A group walk goes over the todos of this window's quest${windowQuest ? ` (${windowQuest})` : ''}; `
            + `this list shows ${questId ? `"${questId}"` : 'no quest'}. Queue it from that quest's window.`);
        return;
    }
    const dirs = groupPromptDirs(questId);
    const choices = groupPromptChoices(dirs ? readGroupPrompts(dirs) : [], questId);
    const picked = await pickGroupPrompt(prefix, choices);
    if (!picked) { return; }
    if (picked === 'editor') {
        await vscode.commands.executeCommand('tomAi.editor.groupPrompts', questId);
        return;
    }
    let text = picked.choice.text;
    let label = picked.choice.label;
    if (picked.withAddition) {
        // An addition typed for this walk only, appended like a stored one.
        const addition = await showMultilineInput({
            title: `Queue Group Prompt: ${prefix}*`,
            prompt: `What to add to "${picked.choice.label}" for this walk (not stored). It follows the prompt after a blank line.`,
            placeholder: 'e.g. Run the tests of every package you touch.',
            okLabel: 'Queue',
            contextLabel: `${picked.choice.label} (${picked.choice.description})`,
            context: picked.choice.text,
        });
        if (addition === undefined) { return; }
        text = composeGroupPrompt(text, addition);
        if (addition.trim()) { label = `${label} + typed addition`; }
    }
    try {
        const queue = (await import('../managers/promptQueueManager.js')).PromptQueueManager.instance;
        const item = await queue.enqueue({ originalText: text, repeatCount: `${prefix}*`, deferSend: true });
        if (item.status === 'error') {
            void vscode.window.showWarningMessage(`Queued, but held in error — ${item.error ?? 'the walk has nothing to walk over'}`);
        } else {
            void vscode.window.showInformationMessage(`Queued a walk over ${prefix}* with "${label}".`);
        }
    } catch (e) {
        void vscode.window.showWarningMessage(`Prompt queue: ${(e as Error).message}`);
    }
}

/**
 * The Queue Group Prompt picker: the group prompts, each with a ✎ button that
 * picks it with an addition typed for this walk; "Default + an addition I
 * type…"; and the group prompt editor.
 */
function pickGroupPrompt(prefix: string, choices: GroupPromptChoice[]): Promise<{ choice: GroupPromptChoice; withAddition: boolean } | 'editor' | undefined> {
    type Item = vscode.QuickPickItem & { choice?: GroupPromptChoice; typed?: boolean; editor?: boolean };
    const typeButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'With an addition I type for this walk…' };
    const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';
    const items: Item[] = [
        ...choices.map((c) => ({ label: c.label, description: c.description, detail: firstLine(c.text), choice: c, buttons: [typeButton] })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(edit) Default + an addition I type…', description: 'multi-line, for this walk only', choice: choices[0], typed: true },
        { label: '$(gear) Open Group Prompt Editor…', editor: true },
    ];
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Queue Group Prompt: a walk over ${prefix}*`;
    qp.placeholder = 'The prompt each todo of the group is sent with (✎: add text of your own)';
    qp.matchOnDescription = true;
    qp.items = items;
    return new Promise((resolve) => {
        let result: { choice: GroupPromptChoice; withAddition: boolean } | 'editor' | undefined;
        qp.onDidAccept(() => {
            const item = qp.selectedItems[0];
            if (item?.editor) { result = 'editor'; } else if (item?.choice) { result = { choice: item.choice, withAddition: !!item.typed }; }
            qp.hide();
        });
        qp.onDidTriggerItemButton((e) => {
            if (e.item.choice) { result = { choice: e.item.choice, withAddition: true }; }
            qp.hide();
        });
        qp.onDidHide(() => { qp.dispose(); resolve(result); });
        qp.show();
    });
}
