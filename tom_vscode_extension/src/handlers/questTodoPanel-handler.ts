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

import { layoutWorkspaceFolder } from '../utils/workspaceLayout';
import { runOfStateFile } from '../utils/processRuns';
import { onDoneShapeError, onDoneTargetRefusal, type TodoOnDone } from '../utils/todoOnDone';
import { DuplicateSubmitGuard } from '../utils/duplicateSubmitGuard';
import { isTodoAlreadyQueued } from '../utils/todoQueueDuplicates';
import type { PromptQueueManager } from '../managers/promptQueueManager';
import { resolveTodoButtonTemplate, todoButtonTemplateUse, TODO_BUTTON_TEMPLATE_INFO, type TodoButtonTemplateUse } from '../utils/todoButtonTemplates';
import { queuedTodoPatterns, todoIdPatternMatches, todoIdPatternOf, todoQueueMarkEntries, todoQueueMarkTitle, type QueueItemForMarks } from '../utils/todoQueueMarks';
import { wireQuestHintMessages } from './questHint-handler';
import { copilotQueueWrapper, fillTemplate, fillWrapper, userMessageTemplateBody } from '../utils/copilotTemplates';
import * as vscode from 'vscode';
import { withAspectsForCopilot } from '../services/aspectGuidelinesStore';
import { questShortDescription, windowWorkspaceQuests, workspaceQuestChoices } from '../services/aiWorkspaceLive';
import * as fs from 'fs';
import * as path from 'path';
import { realPathOf, relativeInside } from '../utils/pathCompare';
import * as questTodo from '../managers/questTodoManager.js';
import { todoListItem, withTodoGroups, type TodoListItem } from '../utils/todoListItem';
import { isTodoOverdue, localDate } from '../utils/todoDue';
import { groupListInfo, questStatusIndex } from '../utils/todoBlockingCascade';
import { outsideBlockers, outsideBlockersQuestion, type OutsideBlocker } from '../utils/todoBlockState';
import { collectPrefixTodos } from '../utils/queueStep3Utils';
import { todoQuestsRoot } from '../utils/todoBlockingSync';
import { runDependencyCleanup, type CleanupScope } from '../services/todoDependencyCleanup';
import { cleanupSummaryText } from '../utils/todoDependencyCleanup';
import { collectAllTags, readAllQuestsTodos, readWorkspaceTodos, listQuestIds, listWorkspaceTodoFiles, scanWorkspaceProjects, collectScopeValues } from '../managers/questTodoManager.js';
import { SessionTodoStore } from '../managers/sessionTodoStore.js';
import { WsPaths } from '../utils/workspacePaths';
import { listRoleNames } from '../utils/roleNames';
import { applyAspectChoice, aspectPickerState, liveAspectChoiceWriters } from '../services/aspectPickerState';
import { handleAspectPickerMessage } from './aspectPickerMessages';
import { storedQueueTarget, storedSendTarget, TODO_PANEL_FRESH_KEY, TODO_PANEL_QUEUE_NEXT_KEY, todoPanelDoneNotificationKey, todoPanelDoneNotificationOn, todoPanelLastQueueTargetKey, todoPanelLastSendTargetKey, todoPanelQueuePosition } from '../utils/todoPanelRunSession';
import { busySessionsOfEntries, defaultTargetQuest, questPickItems, queueTargetSentence, runPickItems, runSessionCandidates, sendSessionPickItems, sessionPickItems, type TodoPickItem, type TodoQueuePosition, type TodoQueueTarget, type TodoRunChoice, type TodoSendTarget } from '../utils/todoQueueTarget';
import { runQueueSession, runSessionName } from '../utils/runSessions';
import { isAnthropicSendInFlight } from './sendToChatState.js';
import type { RunActivityEntry } from '../utils/runActivity';
import type { InboxItem } from '../utils/questInbox';
import { todoDoneNotificationTemplate } from '../utils/todoDoneNotification';
import { queuedByOfItem, type QueuedBy } from '../utils/queuedBy';
import { runDefaultSession } from '../utils/runSessions';
import { DEFAULT_RUN } from '../utils/processRuns';
import { questTrailFolder } from '../utils/questPaths.js';
import { busySessionWarning } from './sendToChatState.js';
import { planSessionSwitch, type SessionSwitchPlan } from '../utils/sessionSwitch';
import { sessionTodoSourceFile } from '../services/sessionTodoFiles';
import { computeMoveTargetFiles } from '../utils/questTodoMoveTargets';
import { isArchivedOrDeletedTodoFile } from '../utils/todoArchiveNames';
import { restoreTodos } from '../utils/todoArchive';
import { defaultTodoPanelScope, isPlainScope, normalizeTodoPanelScope, questPrefixShown, resolveScopeQuests, retiredKindOf, scopeButtonText, scopeFileScope, todoPanelScopeKey, type TodoPanelScope, type TodoPanelScopeKind } from '../utils/todoPanelScope';
import { FINALIZER_INDEX, newGroupTodoId, todoIdInputError, numberIn, renamesReachFinalizer, todoIdPrefix, todoMoveNeedsIdChoice, todoMoveOptions, todoMovePickerTitle, todoOriginOfRelativePath, todoPrefixChoices, todoPrefixPreview, todoRenames, validateTodoPrefix, type TodoMoveOrigin } from '../utils/todoDestinationPicker';
import { getExternalApplicationForFile, openInExternalApplication, resolvePathVariables } from './handler_shared';
import { expandTemplate } from './promptTemplate';
import { loadSendToChatConfig } from '../utils/sendToChatConfig';
import { isRunDefaultChoice, itemTemplateOfChoice } from '../utils/runDefaultChoice';
import { buildStackedTodoPrompt, buildTodoSendTemplateChoices, todoSendBlock, type StackedTodoFragment, type TodoSendTransport } from '../utils/todoSendTargets';
import { todoYamlBlock } from '../utils/todoIterationRecord';
import { unescapePlaceholders } from '../utils/placeholderEscape';
import { wireCompletionMessages } from '../utils/completionWiring';
import { todoFormUnchanged } from '../utils/todoFormSave';
import { groupPromptDirs } from '../services/groupPromptDirs';
import { readGroupPrompts } from '../services/groupPromptStore';
import { composeGroupPrompt, effectiveGroupDefault, groupPromptChoices, type GroupPromptChoice } from '../utils/groupPrompts';
import { TODO_ITEM_TEXT, isGroupTodo, todoQueueItemSpec } from '../utils/todoQueueItems';
import { showMultilineInput } from './textInput-handler';

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
/** Webviews that did not take the last `qtQueueChanged` (hidden at the time): told again on the next queue change or message. */
const _missedQueueChange = new Set<vscode.Webview>();

/** Tell `view` the queued todos changed; a view that does not take it now is told again later, a disposed one is dropped. */
function _postQueueChanged(view: vscode.Webview): void {
    Promise.resolve(view.postMessage({ type: 'qtQueueChanged' })).then(
        (delivered) => { if (delivered === false) { _missedQueueChange.add(view); } else { _missedQueueChange.delete(view); } },
        () => { _markedWebviews.delete(view); _missedQueueChange.delete(view); },
    );
}
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
            if (signature === _queueMarksSignature) {
                // Nothing new, but a view that missed the last change gets it now.
                for (const view of [..._missedQueueChange]) { _postQueueChanged(view); }
                return;
            }
            _queueMarksSignature = signature;
            for (const view of [..._markedWebviews]) { _postQueueChanged(view); }
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
    const marks = todoQueueMarkEntries(_queueItemsForMarks(), m.todos, { walks: m.questId === WsPaths.getWorkspaceQuestId() });
    if (marks.size === 0) { return m; }
    return {
        ...m,
        todos: m.todos.map((t: { id: string }) => {
            const entries = marks.get(t.id);
            // `queued`: the numbers as each run's tab of the queue editor shows them; `queuedRuns`: their runs.
            return entries
                ? { ...t, queued: entries.map((e) => e.number), queuedRuns: entries.map((e) => e.run), queuedTitle: todoQueueMarkTitle(entries) }
                : t;
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

/** The sort / filter / quest state of a panel: the shared one, or its own instance's (@TOM TODO). */
function _panelStateKey(instance?: string): string {
    return instance ? `${QT_STATE_KEY}.${instance}` : QT_STATE_KEY;
}

function _loadPanelState(instance?: string): QtPanelState {
    return _extensionContext?.workspaceState.get<QtPanelState>(_panelStateKey(instance)) ?? {};
}

function _loadPendingSelectState(): QtPendingSelectState {
    return _extensionContext?.workspaceState.get<QtPendingSelectState>(QT_PENDING_SELECT_KEY) ?? {};
}

async function _clearPendingSelectState(): Promise<void> {
    await _extensionContext?.workspaceState.update(QT_PENDING_SELECT_KEY, undefined);
}

async function _savePanelState(state: QtPanelState, instance?: string): Promise<void> {
    await _extensionContext?.workspaceState.update(_panelStateKey(instance), state);
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
    /**
     * A panel instance of its own (vscimpb138, @TOM TODO): its scope, toggles and sort / filter state are
     * kept under this name, apart from the other todo panels'.
     */
    scopeInstance?: string;
    /** The scope the instance starts on until it is changed; without an active quest it starts on all quests. */
    defaultScopeKind?: TodoPanelScopeKind;
    /** The quest prefix on by default, even with one quest (@TOM TODO). */
    questPrefixByDefault?: boolean;
}

/** Call once from extension.ts / wsPanel to store the extension context. */
export function setQuestTodoContext(ctx: vscode.ExtensionContext): void {
    _extensionContext = ctx;
}

// ---- The queue-target flow (vscimpb139, utils/todoQueueTarget.ts) ----

/** The views showing the Done notification toggle (every todo panel; one setting per quest). */
const _doneNotificationViews = new Set<vscode.Webview>();

/** The window's runs and its own run; `default` alone without a process store. */
function _windowRuns(): { runs: string[]; windowRun: string } {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = (require('../managers/processStateStore.js') as typeof import('../managers/processStateStore')).ProcessStateStore.instance;
        if (store) { return { runs: store.runs().map((r) => r.run), windowRun: store.currentRun }; }
    } catch { /* no process store */ }
    return { runs: ['default'], windowRun: 'default' };
}

/** How a pick of the flow is shown: a QuickPick with the active item preselected. A test may stand in. */
type TodoTargetPick = <T>(items: TodoPickItem<T>[], title: string, placeholder: string) => Promise<T | undefined>;

let _pickTargetItem: TodoTargetPick = <T>(items: TodoPickItem<T>[], title: string, placeholder: string): Promise<T | undefined> => {
    type Item = vscode.QuickPickItem & { value?: T };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = title;
    qp.placeholder = placeholder;
    const qpItems: Item[] = items.map((i) => (i.separator
        ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: i.label, description: i.description, detail: i.detail, value: i.value }));
    qp.items = qpItems;
    const active = items.findIndex((i) => i.active);
    if (active >= 0) { qp.activeItems = [qpItems[active]]; }
    return new Promise((resolve) => {
        let accepted = false;
        qp.onDidAccept(() => {
            const chosen = qp.selectedItems[0] ?? qp.activeItems[0];
            accepted = true;
            qp.hide();
            resolve(chosen?.value);
        });
        qp.onDidHide(() => { qp.dispose(); if (!accepted) { resolve(undefined); } });
        qp.show();
    });
};

/** Test seam: how a pick of the flow is answered. */
export function __setTodoTargetPickForTests(fn: TodoTargetPick): void { // eslint-disable-line @typescript-eslint/naming-convention -- a test seam
    _pickTargetItem = fn;
}

/** The quests with an open window on this machine, this window's first. */
function _openQuestsNow(): string[] {
    const own = _windowQuest();
    return [...new Set([...(own ? [own] : []), ..._openWindowQuests()])];
}

/** A quest's runs with their states, from its windows' run lists (vscimpb123); this window's from its process store too. */
function _runChoicesOf(quest: string): TodoRunChoice[] {
    const byRun = new Map<string, TodoRunChoice>();
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ws = require('./windowStatusPanel-handler.js') as typeof import('./windowStatusPanel-handler');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const hb = require('../utils/windowHeartbeat.js') as typeof import('../utils/windowHeartbeat');
        const now = Date.now();
        for (const state of ws.loadAllWindowStates()) {
            if (state.activeQuest !== quest || !hb.isWindowAlive(state, now)) { continue; }
            for (const r of ((state as unknown as { runs?: RunActivityEntry[] }).runs ?? [])) {
                if (!byRun.has(r.run)) { byRun.set(r.run, { run: r.run, state: r.state, detail: r.detail, pending: r.pending }); }
            }
        }
    } catch { /* no window states */ }
    if (quest === _windowQuest()) {
        const { runs, windowRun } = _windowRuns();
        for (const run of runs) { if (!byRun.has(run)) { byRun.set(run, { run }); } }
        const current = byRun.get(windowRun);
        if (current) { current.current = true; }
    }
    if (!byRun.has('default')) { byRun.set('default', { run: 'default' }); }
    return [...byRun.values()];
}

/** The quest's session names (its sessions folder). */
function _sessionNamesOf(quest: string): string[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { TwoTierMemoryService } = require('../services/memory-service.js') as typeof import('../services/memory-service');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { listSessions } = require('../services/agentSdkSessionStore.js') as typeof import('../services/agentSdkSessionStore');
        return listSessions(TwoTierMemoryService.instance.agentSdkSessionsFolder(quest)).map((r) => r.name);
    } catch {
        return [];
    }
}

/** A quest name as a literal inside a regular expression. */
function _regexLiteral(text: string): string {
    return text.split('').map((c) => ('.*+?^${}()|[]\\'.includes(c) ? `\\${c}` : c)).join('');
}

/**
 * Whether a session of `quest` is busy: in this window's quest, a queue item or a chat send runs in it
 * (vscimpb135's per-session slot); in another quest, its queue entries on disk say an item sends in it.
 */
function _busyTest(quest: string): (session: string) => boolean {
    if (quest === _windowQuest()) {
        let holder: ((s: string) => boolean) = () => false;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const qm = (require('../managers/promptQueueManager.js') as typeof import('../managers/promptQueueManager')).PromptQueueManager.instance;
            if (typeof qm.sessionHolder === 'function') { holder = (s) => !!qm.sessionHolder(s); }
        } catch { /* no queue */ }
        return (s) => isAnthropicSendInFlight(s) || holder(s);
    }
    const entries: Array<{ status?: string; session?: string; run?: string }> = [];
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const store = require('../storage/queueFileStorage.js') as typeof import('../storage/queueFileStorage');
        const folder = store.getQueueFolder();
        if (folder && fs.existsSync(folder)) {
            const pattern = new RegExp(`_${_regexLiteral(quest)}\\.[a-z]+\\.entry\\.queue\\.yaml$`);
            for (const f of fs.readdirSync(folder)) {
                if (!pattern.test(f)) { continue; }
                const entry = store.readEntry(path.join(folder, f));
                const meta = entry?.doc.meta as unknown as Record<string, unknown> | undefined;
                if (!entry || (meta?.quest && meta.quest !== quest)) { continue; }
                const main = (entry.doc['prompt-queue'] as unknown as Array<Record<string, unknown>>).find((p) => p.type === 'main') ?? {};
                entries.push({ status: String(meta?.status ?? ''), session: typeof main.session === 'string' ? main.session : undefined, run: typeof main.run === 'string' ? main.run : undefined });
            }
        }
    } catch { /* no queue folder */ }
    const busy = busySessionsOfEntries(entries);
    return (s) => busy.has(s);
}

/**
 * The flow every queue button of the panel calls (vscimpb139): quest (one with an open window; default the
 * todo's own when it has one, else the window's) → run (with its state) → a free session of the run, the queue
 * default or a new one. Next or end is the panel's Next toggle, never asked. "Last: …" first queues where the last
 * item went. Escape at any step: none.
 */
/**
 * Set while a message of the panel's default queue buttons is handled (`defaultTarget: true`, vscimpb151): the
 * queue target is then the todo's quest, its default run and that run's default session (`default@default`), at the
 * end of the queue, without asking — the flow's own buttons still ask.
 */
let _queueToDefaultTarget = false;

/** The Next toggle of the todo panels: every queue button queues next instead of at the end. */
function _todoQueuePosition(): TodoQueuePosition {
    return todoPanelQueuePosition(_extensionContext?.workspaceState.get(TODO_PANEL_QUEUE_NEXT_KEY));
}

/** The Fresh toggle of the todo panels: a queued or sent todo runs in a one-prompt session based on the one picked. */
function _todoFresh(): boolean {
    return _extensionContext?.workspaceState.get(TODO_PANEL_FRESH_KEY) === true;
}

/**
 * The target of the default queue buttons: the default run of the todo's quest, its default session, at the end —
 * or next with the Next toggle on (`position`).
 */
export function defaultTodoQueueTarget(todoQuest: string | undefined, windowQuest: string, position: TodoQueuePosition = 'end'): TodoQueueTarget {
    const quest = todoQuest && !todoQuest.startsWith('__') ? todoQuest : windowQuest;
    return { quest, run: DEFAULT_RUN, session: runDefaultSession(DEFAULT_RUN), position };
}

/** A one-prompt session of this window's quest based on `base`, for an item queued with Fresh on. */
function _createFreshSession(base: string, token: string): { ok: true; session: string } | { ok: false; error: string } {
    /* eslint-disable @typescript-eslint/no-require-imports -- the stores pull in the manager layer: loaded on use */
    const { TwoTierMemoryService } = require('../services/memory-service.js') as typeof import('../services/memory-service');
    const sessions = require('../services/agentSdkSessionStore.js') as typeof import('../services/agentSdkSessionStore');
    const { createTemporarySession } = require('../services/temporarySessions.js') as typeof import('../services/temporarySessions');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const folder = TwoTierMemoryService.instance.agentSdkSessionsFolder(_windowQuest());
    return createTemporarySession({
        sessionsFolder: () => folder,
        hasSession: (f, name) => sessions.readSession(f, name) !== undefined,
        createSession: (f, name, opts) => sessions.createSession(f, name, opts),
    }, base, token);
}

/** Remove a one-prompt session again (its send is over, or its item was not queued). */
function _discardFreshSession(session: string): void {
    try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { TwoTierMemoryService } = require('../services/memory-service.js') as typeof import('../services/memory-service');
        const { discardSessionCompletely } = require('../services/temporarySessions.js') as typeof import('../services/temporarySessions');
        /* eslint-enable @typescript-eslint/no-require-imports */
        discardSessionCompletely(TwoTierMemoryService.instance.agentSdkSessionsFolder(_windowQuest()), _windowQuest(), session);
    } catch { /* nothing left */ }
}

/**
 * A direct send of the panel in `target`, or with Fresh on in a one-prompt session based on its session, which is
 * discarded when the send is over.
 */
async function _sendTodoInTarget<T>(target: TodoSendTarget, send: (session: string) => Promise<T>): Promise<T> {
    if (!_todoFresh()) { return send(target.session); }
    const made = _createFreshSession(target.session, 'fresh');
    if (!made.ok) { throw new Error(made.error); }
    try { return await send(made.session); } finally { _discardFreshSession(made.session); }
}

/** This window's run's default session (its queue settings), for the session pick's "Run default" label. */
function _runQueueDefaultSession(run: string): string | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PromptQueueManager } = require('../managers/promptQueueManager.js') as typeof import('../managers/promptQueueManager');
        return runQueueSession(PromptQueueManager.instance.runQueueSettings(run).defaultAgentSdkSession, run);
    } catch { return undefined; }
}

async function pickTodoQueueTarget(instance: string, todoQuest: string | undefined, what: string): Promise<TodoQueueTarget | undefined> {
    const windowQuest = _windowQuest();
    if (_queueToDefaultTarget) { return defaultTodoQueueTarget(todoQuest, windowQuest, _todoQueuePosition()); }
    const open = _openQuestsNow();
    if (!open.length) {
        void vscode.window.showWarningMessage('Queue: no quest has an open window on this machine.');
        return undefined;
    }
    const state = _extensionContext?.workspaceState;
    const last = storedQueueTarget(state?.get(todoPanelLastQueueTargetKey(instance)));
    const title = `Queue ${what}`;
    const q = await _pickTargetItem(questPickItems(open, defaultTargetQuest(todoQuest, windowQuest, open), windowQuest, last), `${title} — 1/3 quest`, 'The quest whose queue gets it (a quest with an open window)');
    if (!q) { return undefined; }
    let target: TodoQueueTarget;
    if ('last' in q) {
        // Where the last item went; next or end is the Next toggle's, as for every queue button.
        target = { ...q.last, position: _todoQueuePosition() };
    } else {
        const quest = q.quest;
        const lastHere = last && last.quest === quest ? last : undefined;
        const run = await _pickTargetItem(runPickItems(_runChoicesOf(quest), lastHere?.run), `${title} — 2/3 run of ${quest}`, 'The process run whose queue gets it');
        if (!run) { return undefined; }
        const busy = _busyTest(quest);
        const free = runSessionCandidates(_sessionNamesOf(quest), run, quest === windowQuest).filter((s) => !busy(s));
        const lastSession = lastHere && lastHere.run === run ? lastHere : undefined;
        const s = await _pickTargetItem(sessionPickItems(free, run, lastSession, quest === windowQuest ? _runQueueDefaultSession(run) : undefined), `${title} — 3/3 session in run ${run}`, 'A free session: no item sends in it and no chat send runs in it');
        if (!s) { return undefined; }
        let session: string | undefined;
        let newSession = false;
        if ('newSession' in s) {
            const name = await vscode.window.showInputBox({
                title: `${title}: a new session in run ${run}`,
                prompt: 'Its name: letters, digits, "_" and "-", starting with a letter or digit. It is made when the item is sent.',
                validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.trim()) ? undefined : 'Letters, digits, "_" and "-", starting with a letter or digit.'),
            });
            if (!name) { return undefined; }
            session = runSessionName(name.trim(), run);
            newSession = true;
        } else {
            session = s.session;
        }
        const position = _todoQueuePosition();
        target = { quest, run, ...(session ? { session } : {}), ...(newSession ? { newSession: true } : {}), position };
    }
    // Kept for the next queue add of this panel: the new session exists by then.
    const keep: TodoQueueTarget = { quest: target.quest, run: target.run, ...(target.session ? { session: target.session } : {}), position: target.position };
    await state?.update(todoPanelLastQueueTargetKey(instance), keep);
    return target;
}

/** What one queued item carries, for this window's queue or another quest's inbox. */
interface TodoQueueEntry {
    todoId: string;
    text: string;
    template?: string;
    transport?: 'anthropic';
    repeatCount?: number | string;
    /** The todos the item is about: every item queued from the todo panel names them (an id, ids, `<prefix>*`). */
    todoIdPattern: string;
}

/**
 * Queue `entries` at `target`: in this window's queue (`enqueueNext` for next, the end otherwise), or through
 * the target quest's inbox (its window queues them with run, session and position, as TODO / GROUP / plain
 * items). A todo already queued here is offered to be queued again.
 */
async function deliverTodoQueueEntries(target: TodoQueueTarget, entries: TodoQueueEntry[], again = false): Promise<{ added: number; error?: string; held?: string }> {
    // Fresh: each item in a one-prompt session based on the session picked; a new named session is fresh as it is.
    const fresh = _todoFresh() && !target.newSession;
    if (target.quest !== _windowQuest()) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { liveQuestSendAccess } = require('../tools/chat-enhancement-tools.js') as typeof import('../tools/chat-enhancement-tools');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { postInboxItem } = require('../tools/send-to-quest-tools.js') as typeof import('../tools/send-to-quest-tools');
            const me = liveQuestSendAccess.sender();
            for (const e of entries) {
                const item: InboxItem = {
                    text: e.text,
                    ...(e.template ? { template: e.template } : {}),
                    ...(e.transport ? { transport: e.transport } : {}),
                    ...(e.repeatCount !== undefined ? { repeatCount: e.repeatCount } : {}),
                    ...(e.todoIdPattern ? { todoIdPattern: e.todoIdPattern } : {}),
                    run: target.run,
                    ...(target.session && !target.newSession && !fresh ? { session: target.session } : {}),
                    ...(target.session && target.newSession ? { newSession: { name: target.session } } : {}),
                    // Fresh: a temporary session there, based on the session picked (the run's default without one).
                    ...(fresh && !target.newSession ? { newSession: { basedOn: target.session ?? runDefaultSession(target.run) } } : {}),
                    ...(target.position === 'next' ? { position: 'next' as const } : {}),
                    ..._queuedByFields(target),
                    from: { quest: _windowQuest() || 'default', run: _windowRuns().windowRun, windowId: me.windowId, host: me.host, sentAt: new Date().toISOString() },
                };
                postInboxItem(liveQuestSendAccess, target.quest, item);
            }
            return { added: entries.length };
        } catch (e) {
            return { added: 0, error: (e as Error).message };
        }
    }
    let queue: PromptQueueManager;
    try {
        queue = (await import('../managers/promptQueueManager.js')).PromptQueueManager.instance;
    } catch {
        return { added: 0, error: 'Prompt queue not available' };
    }
    let added = 0;
    let held: string | undefined;
    const refused: TodoQueueEntry[] = [];
    const notices: string[] = [];
    for (const e of entries) {
        let freshSession: string | undefined;
        if (fresh) {
            const made = _createFreshSession(target.session ?? runDefaultSession(target.run), `fresh${added + refused.length}`);
            if (!made.ok) { return { added, error: made.error }; }
            freshSession = made.session;
        }
        const opts = {
            originalText: e.text,
            ...(e.template ? { template: e.template } : {}),
            ...(e.transport ? { transport: e.transport } : {}),
            ...(e.repeatCount !== undefined ? { repeatCount: e.repeatCount } : {}),
            ...(e.todoIdPattern ? { todoIdPattern: e.todoIdPattern } : {}),
            run: target.run,
            ...(freshSession ? { session: freshSession, temporarySession: true } : target.session ? { session: target.session } : {}),
            ...(again ? { allowDuplicateTodo: true } : {}),
            ..._queuedByFields(target),
        };
        try {
            const item = target.position === 'next' ? await queue.enqueueNext(opts) : await queue.enqueue({ ...opts, deferSend: true });
            added++;
            if (item.status === 'error') { held = item.error ?? 'it has nothing to walk over'; }
        } catch (err) {
            if (freshSession) { _discardFreshSession(freshSession); }
            if (isTodoAlreadyQueued(err)) { refused.push(e); notices.push(err.message); continue; }
            return { added, error: (err as Error).message };
        }
    }
    if (refused.length) {
        const notice = refused.length === 1 ? notices[0] : `Already in the prompt queue, not added again: ${refused.map((r) => r.todoId).join(', ')}.`;
        _offerQueueAgain(notice, async () => {
            const r = await deliverTodoQueueEntries(target, refused, true);
            if (r.added) { void vscode.window.showInformationMessage(`Queued ${r.added === 1 ? `todo ${refused[0].todoId}` : `${r.added} todos`} again — ${queueTargetSentence(target)}.`); }
        });
    }
    return { added, ...(held ? { held } : {}) };
}

/** Queue entries with the flow and confirm where they went; answers the target, none when cancelled. */
async function queueTodoEntriesWithFlow(instance: string, todoQuest: string | undefined, what: string, entries: TodoQueueEntry[], mustBeQuest?: string): Promise<TodoQueueTarget | undefined> {
    const target = await pickTodoQueueTarget(instance, todoQuest, what);
    if (!target) { return undefined; }
    if (mustBeQuest && target.quest !== mustBeQuest) {
        void vscode.window.showWarningMessage(`${what} walks the todos of quest ${mustBeQuest}: queue it into ${mustBeQuest}, not ${target.quest}.`);
        return undefined;
    }
    const result = await deliverTodoQueueEntries(target, entries);
    if (result.error) {
        void vscode.window.showWarningMessage(`Prompt queue: ${result.error}`);
    } else if (result.held) {
        void vscode.window.showWarningMessage(`Queued ${what} — ${queueTargetSentence(target)} — but held in error: ${result.held}`);
    } else if (result.added) {
        const via = target.quest !== _windowQuest() ? ' (through its window\'s inbox)' : '';
        const freshNote = _todoFresh() && !target.newSession ? ', in a fresh one-prompt session based on it' : '';
        void vscode.window.showInformationMessage(`Queued ${what} — ${queueTargetSentence(target)}${freshNote}${via}.`);
    }
    return target;
}

/**
 * A direct send's session (Send to Anthropic, Guide me's send): the free sessions of this window's runs, with
 * "Last: …" first while that one is free. It sends in the session's own slot (vscimpb135). Escape: none.
 */
async function pickTodoSendTarget(instance: string): Promise<TodoSendTarget | undefined> {
    const quest = _windowQuest();
    const busy = _busyTest(quest);
    const names = _sessionNamesOf(quest);
    const free: TodoSendTarget[] = [];
    const runs = [..._windowRuns().runs].sort((x, y) => (x === 'default' ? -1 : y === 'default' ? 1 : x.localeCompare(y)));
    for (const run of runs) {
        for (const session of runSessionCandidates(names, run, true)) {
            if (!busy(session)) { free.push({ run, session }); }
        }
    }
    if (!free.length) {
        void vscode.window.showWarningMessage('Send: every session of this window is busy — a queue item or a chat send runs in each. Queue it instead.');
        return undefined;
    }
    const state = _extensionContext?.workspaceState;
    const last = storedSendTarget(state?.get(todoPanelLastSendTargetKey(instance)));
    const picked = await _pickTargetItem(sendSessionPickItems(free, last), 'Send — the session', 'A free session of this window (no item and no chat send runs in it)');
    if (!picked) { return undefined; }
    await state?.update(todoPanelLastSendTargetKey(instance), picked);
    return picked;
}

/** The quest a todo of the list belongs to: the list's, or in a list of several quests the one its file names. */
function _todoQuestOf(questId: string, sourceFile?: string, todoId?: string): string {
    if (questId && !questId.startsWith('__')) { return questId; }
    const slash = (sourceFile ?? '').indexOf('/');
    if (slash > 0 && !path.isAbsolute(sourceFile!)) { return sourceFile!.slice(0, slash); }
    if (todoId) {
        for (const qid of listQuestIds()) { if (questTodo.findTodoById(qid, todoId)) { return qid; } }
    }
    return _windowQuest();
}

/** Only one dependency cleanup at a time (it reads and writes every todo file). */
let _dependencyCleanupRunning = false;

/**
 * The todo panel's dependency cleanup (utils/todoDependencyCleanup.ts): asks which todos — the ones the list
 * shows (`visible`), the open windows' quests, or every quest — then runs the pass with "Checking todo
 * dependencies n/m" in the status bar, and says what it changed.
 */
async function runTodoDependencyCleanup(visible: ReadonlyArray<{ quest: string; id: string }>): Promise<void> {
    if (_dependencyCleanupRunning) { void vscode.window.showInformationMessage('A todo dependency cleanup is running already.'); return; }
    const open = _openWindowQuests();
    type Pick = vscode.QuickPickItem & { scope: CleanupScope };
    const picks: Pick[] = [
        { label: '$(list-filter) The todos shown in the list', description: `${visible.length} todo${visible.length === 1 ? '' : 's'}`, scope: { kind: 'todos', todos: visible } },
        { label: "$(window) The open windows' quests", description: open.join(', ') || 'none open', scope: { kind: 'quests', quests: open } },
        { label: '$(globe) All quests', description: 'every live todo of every quest', scope: { kind: 'all' } },
    ];
    const picked = await vscode.window.showQuickPick(picks, {
        title: 'Todo dependency cleanup',
        placeHolder: 'Which todos? Done or vanished blockers leave blocked_by, released todos are unblocked, blocking is set from the others\' blocked_by',
        ignoreFocusOut: true,
    });
    if (!picked) { return; }
    const questsRoot = todoQuestsRoot() ?? WsPaths.ai('quests');
    if (!questsRoot) { void vscode.window.showWarningMessage('No quests folder: open a Tom workspace.'); return; }
    _dependencyCleanupRunning = true;
    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    bar.text = '$(sync~spin) Checking todo dependencies…';
    bar.tooltip = 'The todo panel\'s dependency cleanup';
    bar.show();
    try {
        const { summary } = await runDependencyCleanup(questsRoot, picked.scope, (n, m) => { bar.text = `$(sync~spin) Checking todo dependencies ${n}/${m}`; });
        void vscode.window.showInformationMessage(cleanupSummaryText(summary));
    } catch (e) {
        void vscode.window.showErrorMessage(`The todo dependency cleanup stopped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        bar.dispose();
        _dependencyCleanupRunning = false;
    }
}

/** Whether a todo done-notification template is set: without one the Done notification box is disabled. */
function _todoDoneNotificationTemplateSet(): boolean {
    return todoDoneNotificationTemplate(loadSendToChatConfig()) !== undefined;
}

/** The Done notification box of the active quest: on only when turned on and a template is set (vscimpb146). */
function _todoDoneNotificationOn(): boolean {
    return todoPanelDoneNotificationOn(_extensionContext?.workspaceState.get(todoPanelDoneNotificationKey(WsPaths.getWorkspaceQuestId())),
        _todoDoneNotificationTemplateSet());
}

/**
 * Who queued the panel's items (vscimpb146): the run and session they are queued into, so a todo they complete
 * sends its done notification there — its After done notify prompt always, the configured template only while the
 * panel's Done notification box is on (`withTemplate`).
 */
function _queuedByFields(target: { quest: string; run: string; session?: string }): { queuedBy?: QueuedBy } {
    if (!target.quest || target.quest === 'default') { return {}; }
    return { queuedBy: {
        quest: target.quest, run: target.run || 'default',
        ...(target.session ? { session: target.session } : {}),
        ...(_todoDoneNotificationOn() ? { withTemplate: true as const } : {}),
    } };
}

/** A chat send the panel made (Send, Guide me): its own run and session are who queued its todos. */
async function _recordChatQueuedBy(chatItemId: string | undefined): Promise<void> {
    if (!chatItemId) { return; }
    const queue = (await import('../managers/promptQueueManager.js')).PromptQueueManager.instance;
    const queuedBy = queuedByOfItem(queue.getById(chatItemId), _windowQuest());
    if (queuedBy) { queue.setItemQueuedBy(chatItemId, { ...queuedBy, ...(_todoDoneNotificationOn() ? { withTemplate: true as const } : {}) }); }
}

/** Tell every view showing the Done notification toggle its state (kept per quest) and whether it is available. */
function _postDoneNotification(): void {
    const message = { type: 'qtDoneNotification', on: _todoDoneNotificationOn(), available: _todoDoneNotificationTemplateSet() };
    for (const view of [..._doneNotificationViews]) {
        try { void view.postMessage(message); } catch { _doneNotificationViews.delete(view); }
    }
}

/** Tell every todo view the Next and Fresh toggles' state (one for all of the window's todo panels). */
function _postQueueToggles(): void {
    const message = { type: 'qtQueueToggles', next: _todoQueuePosition() === 'next', fresh: _todoFresh() };
    for (const view of [..._doneNotificationViews]) {
        try { void view.postMessage(message); } catch { _doneNotificationViews.delete(view); }
    }
}

/** Show the toggles' state in `view`, and again when it changes. */
function _watchDoneNotification(view: vscode.Webview): void {
    _doneNotificationViews.add(view);
    _postDoneNotification();
    _postQueueToggles();
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
import { GROUP_STATUS, moveIntoGroupTodo } from '../utils/todoGroups';
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
        + readMediaText('shared', 'aspectPicker.js')
        + readMediaText('questTodoPanel', 'grouping.js')
        + readMediaText('questTodoPanel', 'main.js');
}

// ============================================================================
// Backend message handler (for WS panel integration)
// ============================================================================

/**
 * Handle Quest TODO messages from the webview. Call from WS panel message handler. A message of the default queue
 * buttons (`defaultTarget: true`) queues into the default run's default session without asking (vscimpb151).
 */
export async function handleQuestTodoMessage(msg: any, webview: vscode.Webview): Promise<boolean> {
    if (msg?.defaultTarget !== true) { return _handleQuestTodoMessage(msg, webview); }
    _queueToDefaultTarget = true;
    try { return await _handleQuestTodoMessage(msg, webview); } finally { _queueToDefaultTarget = false; }
}

async function _handleQuestTodoMessage(msg: any, webview: vscode.Webview): Promise<boolean> {
    const post = (m: any) => webview.postMessage(_withQueueMarks(m, webview));
    // A view that missed a queue change (hidden then) and talks again: it loads its list anew.
    if (_missedQueueChange.has(webview) && msg?.type !== 'qtGetTodos') { _postQueueChanged(webview); }
    const cfg = _webviewConfigs.get(webview) || {};

    const isSessionMode = cfg.mode === 'session';
    const isWorkspaceFileMode = cfg.mode === 'workspace-file';
    // The panel instance whose last queue / send target the flow offers (vscimpb139).
    const instance = _scopeInstance(cfg) ?? (cfg.mode || 'panel');
    const isInvalidQuest = cfg.fixedQuestId === '__invalid_quest__';

    const effectiveQuestId = (incoming?: string): string => {
        // A panel showing several quests (its scope, vscimpb137) acts on each todo's own quest.
        const scoped = _scopeInstance(cfg);
        if (incoming === '__all_quests__' && scoped) { return incoming; }
        // A list of several quests names a group's or a todo's own quest: that quest, when the scope shows it.
        if (scoped && incoming && !incoming.startsWith('__') && incoming !== cfg.fixedQuestId
            && resolveScopeQuests(_scopeOf(scoped, cfg), _scopeSources()).includes(incoming)) { return incoming; }
        if (cfg.fixedQuestId) { return cfg.fixedQuestId; }
        return incoming || '';
    };

    const effectiveFile = (incoming?: string): string | undefined => {
        if (cfg.fixedFile) { return cfg.fixedFile; }
        return incoming;
    };

    const workspaceFilePath = (): string | undefined => {
        if (cfg.fixedFilePath) { return cfg.fixedFilePath; }
        const wsRoot = layoutWorkspaceFolder();
        if (!wsRoot) { return undefined; }
        return path.join(wsRoot, 'workspace.todo.yaml');
    };

    switch (msg.type) {
        case 'qtInitConfig':
            _webviewConfigs.set(webview, msg.config || {});
            return true;
        // The Done notification toggle's state (kept per quest); the run and session left the bar (vscimpb139).
        case 'qtGetDoneNotification':
            _watchDoneNotification(webview);
            return true;
        case 'qtSetDoneNotification': {
            // The Done notification toggle, kept per quest (unset: off); it cannot be turned on without a template.
            await _extensionContext?.workspaceState.update(todoPanelDoneNotificationKey(WsPaths.getWorkspaceQuestId()),
                msg.on === true && _todoDoneNotificationTemplateSet() ? true : undefined);
            _postDoneNotification();
            return true;
        }
        case 'qtSetQueueToggle': {
            // The Next and Fresh toggles (the bar and a todo's Run row): one state for the window's todo panels.
            const key = msg.which === 'fresh' ? TODO_PANEL_FRESH_KEY : msg.which === 'next' ? TODO_PANEL_QUEUE_NEXT_KEY : undefined;
            if (key) { await _extensionContext?.workspaceState.update(key, msg.on === true ? true : undefined); }
            _postQueueToggles();
            return true;
        }
        // The quest scope (vscimpb137): which quests and files the panel shows.
        case 'qtGetScope':
            _postScope(cfg, post);
            return true;
        case 'qtSetScope': {
            const instance = _scopeInstance(cfg);
            if (!instance) { return true; }
            await _saveScope(instance, normalizeTodoPanelScope(msg.scope, _windowQuest()));
            _postScope(cfg, post);
            return true;
        }
        case 'qtPickScope': {
            const instance = _scopeInstance(cfg);
            if (!instance) { return true; }
            const picked = await _pickScope(_scopeOf(instance, cfg));
            if (picked) { await _saveScope(instance, picked); }
            _postScope(cfg, post);
            return true;
        }
        case 'qtRestoreTodo': {
            // An archived or deleted todo back into the live file it came from.
            const todoId = String(msg.todoId || '');
            const abs = _resolveArchiveSourcePath(effectiveQuestId(msg.questId), undefined, msg.sourceFile, false, workspaceFilePath);
            if (!todoId || !abs) {
                vscode.window.showErrorMessage(`Restore: cannot find the file of ${todoId || 'the todo'}.`);
                return true;
            }
            const result = restoreTodos(abs, [todoId]);
            if (result.error || !result.moved.length) {
                vscode.window.showErrorMessage(`Restore of ${todoId} refused: ${result.error ?? result.skipped.map((k) => k.reason).join('; ')}`);
            } else {
                void vscode.window.showInformationMessage(`Restored ${todoId} into ${path.basename(result.targetFile)}.`);
                post({ type: 'qtRefreshRequest' });
            }
            return true;
        }
        case 'qtSaveState':
            if (msg.state) {
                await _savePanelState(msg.state as QtPanelState, cfg.scopeInstance);
            }
            return true;
        case 'qtGetState': {
            const saved = _loadPanelState(cfg.scopeInstance);
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
            const wsRoot = layoutWorkspaceFolder();
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
            const saved = _loadPanelState(cfg.scopeInstance);
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
                    const questsDir = WsPaths.ai('quests');
                    const inferred = questsDir ? relativeInside(activeFile, questsDir)?.[0] : undefined;
                    if (inferred && quests.indexOf(inferred) >= 0) {
                        activeQuest = inferred;
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
                const wsRoot = layoutWorkspaceFolder();
                if (wsRoot) {
                    const fp = WsPaths.ai('quests', cfg.fixedQuestId, ensureFile) || path.join(wsRoot, '_ai', 'quests', cfg.fixedQuestId, ensureFile);
                    questTodo.ensureTodoFile(fp, { quest: cfg.fixedQuestId });
                }
            }
            // A panel with a scope shows several quests as `__all_quests__`: its scope's quests and files.
            if (effectiveQuestId(msg.questId) === '__all_quests__' && _scopeInstance(cfg)) {
                _sendScopedTodoList(_scopeOf(_scopeInstance(cfg)!, cfg), post);
                return true;
            }
            _sendTodoList(effectiveQuestId(msg.questId), effectiveFile(msg.file), post);
            return true;
        case 'qtGetRuns': {
            // The After done group's run picker: the process runs of a quest.
            const runQuest = String(msg.questId || '');
            post({ type: 'qtRuns', questId: runQuest, runs: _questRuns(runQuest) });
            return true;
        }
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
                        questTodo.notifyTodoCreated(qid, questTodo.createTodo(qid, t, file));
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
            const wsRoot = layoutWorkspaceFolder();
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
                            questTodo.notifyTodoCreated(qid, questTodo.createTodo(qid, t, file));
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
            // "Move to a group todo…": when the todos' quest has group todos and none of the moved ones is one itself.
            const moveQuests = new Set(found.map(s => s.origin.questId));
            const moveQuest = moveQuests.size === 1 ? [...moveQuests][0] : undefined;
            const questTodosNow = moveQuest ? questTodo.readAllTodos(moveQuest) : [];
            // A prefix group's move button names every todo of the group: a group todo takes them all as members.
            const membershipIds: string[] = Array.isArray(msg.groupTodoIds) && msg.groupTodoIds.length
                ? msg.groupTodoIds.map(String) : found.map(s => s.todoId);
            const movingSet = new Set(membershipIds);
            const groupTodos = questTodosNow.some(t => t.status === GROUP_STATUS && !movingSet.has(t.id))
                && !questTodosNow.some(t => movingSet.has(t.id) && t.status === GROUP_STATUS);
            // "Move to a new group todo…": a prefix group's move button only (it names the group's todos).
            const newGroupTodo = Array.isArray(msg.groupTodoIds) && msg.groupTodoIds.length > 0
                && !questTodosNow.some(t => movingSet.has(t.id) && t.status === GROUP_STATUS);
            const options = todoMoveOptions(found.map(s => s.origin), { groupTodos, newGroupTodo });
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
            if (picked.choice.kind === 'newGroupTodo') {
                const createdId = await _moveTodosToNewGroupTodo(picked.choice.questId, membershipIds);
                if (createdId) {
                    // The list reloads with the new group todo selected: its detail opens, the members set.
                    post({ type: 'qtPendingSelect', state: { todoId: createdId } });
                    post({ type: 'qtArchiveResult', success: true, moved: [] });
                }
                return true;
            }
            if (picked.choice.kind === 'pickGroupTodo') {
                await _moveTodosToGroupTodo(picked.choice.questId, membershipIds);
                post({ type: 'qtArchiveResult', success: true, moved: [], refreshDetail: true });
                return true;
            }
            let dest: questTodo.TodoMoveDestination;
            if (picked.choice.kind === 'pickQuest') {
                const questId = await _pickQuestWithAllEscape(title.replace(/…$/, ' quest…'), (q) => `todos.${q}.todo.yaml`);
                if (!questId) return true;
                dest = { kind: 'quest', questId };
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
            await _runTodoButton(todo, questId, msg.sourceFile, use, msg.target === 'queue' ? 'queue' : 'chat', instance);
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
            const projs = await scanWorkspaceProjects();
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
            const projects = (await scanWorkspaceProjects()).map((p) => p.name);
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
            const wsRoot = layoutWorkspaceFolder();
            if (!wsRoot || !msg.questId) return true;
            const fileName = (!msg.file || msg.file === 'all') ? `todos.${msg.questId}.todo.yaml` : msg.file;
            const fp = WsPaths.ai('quests', msg.questId, fileName) || path.join(wsRoot, '_ai', 'quests', msg.questId, fileName);
            if (fs.existsSync(fp)) {
                await openInExternalApplication(fp);
            }
            return true;
        }
        case 'qtCheckExtApp': {
            // Check if there's an external app configured for .yaml files
            const wsRootChk = layoutWorkspaceFolder();
            if (!wsRootChk) {
                post({ type: 'qtExtAppAvailable', available: false });
                return true;
            }
            const testPath = path.join(wsRootChk, 'test.yaml');
            const extApp = getExternalApplicationForFile(testPath);
            post({ type: 'qtExtAppAvailable', available: !!extApp });
            return true;
        }
        case 'qtGetRoles': {
            // The Role field's choices (gsel3): the roles under _ai/roles.
            post({ type: 'qtRoles', roles: listRoleNames(WsPaths.ai('roles')) });
            return true;
        }
        case 'qtGetAspects': {
            // The guideline picker's sections and levels (gsel5): the todo button and the row indicators.
            // The view gets them again whenever a level changes (gsel5b, postTodoAspectsToAllViews).
            _aspectViews.add(webview);
            post(_todoAspectMessage());
            return true;
        }
        case 'aspectChoose':
        case 'aspectQuestDefault':
        case 'aspectWorkspaceDefault':
        case 'aspectEditSections': {
            if (msg.type === 'aspectChoose' && msg.level === 'todo') {
                if (isSessionMode || isWorkspaceFileMode) {
                    void vscode.window.showWarningMessage('Guideline choices are set on quest todos only.');
                    return true;
                }
                const questId = effectiveQuestId(msg.questId);
                const todoId = String(msg.todoId || '');
                let result;
                try {
                    result = applyAspectChoice({ level: 'todo', section: String(msg.section || ''), value: typeof msg.value === 'string' ? msg.value : '', questId, todoId }, liveAspectChoiceWriters());
                } catch (err) {
                    result = { ok: false, error: (err as Error).message };
                }
                if (!result.ok) {
                    void vscode.window.showWarningMessage(`Guideline choice not set: ${result.error ?? 'unknown reason'}`);
                    return true;
                }
                const todo = questTodo.findTodoById(questId, todoId);
                post({ type: 'qtAspectChanged', todoId, guidelines: todo?.guidelines ?? null });
                _sendTodoList(questId, undefined, post);
                return true;
            }
            // A change redraws this view, the other todo views and the queue editor (aspectViewsRefresh.ts).
            _aspectViews.add(webview);
            await handleAspectPickerMessage(msg);
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
        case 'qtPickTemplate': {
            // The top bar's template button: pick one of the templates its select offers.
            const templates = Array.isArray(msg.templates) ? (msg.templates as Array<{ id?: unknown; label?: unknown }>) : [];
            const items = templates
                .filter((t) => typeof t.id === 'string')
                .map((t) => ({ label: String(t.label ?? t.id), id: String(t.id), picked: t.id === msg.selected,
                    description: t.id === msg.selected ? 'selected' : undefined }));
            if (!items.length) { return true; }
            const picked = await vscode.window.showQuickPick(items, { title: 'Template', placeHolder: 'The template the Save to Queue and Send buttons use' });
            if (picked) { post({ type: 'qtTemplatePicked', id: picked.id }); }
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
            // "Run default": the item takes its run's default template when it is sent.
            const selectedTemplate = itemTemplateOfChoice(msg.template ? String(msg.template) : undefined);
            if (_isRepeatedTodoAction(`${questId}/${todo.id}`, 'queue', selectedTemplate, `queued: todo ${todo.id}`)) { return true; }
            // Where it goes: quest → run → free session (vscimpb139); next or end is the Next toggle.
            await queueTodoEntriesWithFlow(instance, _todoQuestOf(questId, msg.sourceFile, todo.id), `todo ${todoId}`, [{
                todoId: todo.id, text: wrappedText, template: selectedTemplate, todoIdPattern: todo.id,
            }]);
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
            if (_isRepeatedTodoAction(`${questId}/${todo.id}`, 'send', String(msg.template || '__none__'), `sent: todo ${todo.id}`)) { return true; }
            const todoPrompt = buildStackedTodoPrompt([_todoPromptFragment(todo, questId, msg.sourceFile)]);
            await _sendTodoPromptViaQueueTransport(todoPrompt, String(msg.template || '__none__'), [todo.id], instance);
            return true;
        }
        case 'qtQueueTodoGroup': {
            // A todo group's queue button (its header and its detail view, vscimpb126): a GROUP item.
            await queueTodoAsItem(effectiveQuestId(msg.questId), String(msg.todoId || ''), instance, 'group', msg.sourceFile);
            return true;
        }
        case 'qtDependencyCleanup': {
            // The dependency cleanup button: which todos (the list shown, the open windows' quests, all), then the pass.
            const visible = (Array.isArray(msg.visible) ? msg.visible : []) as Array<{ id?: string; sourceFile?: string }>;
            const listQuest = String(msg.questId || '');
            await runTodoDependencyCleanup(visible.filter((v) => typeof v.id === 'string' && v.id)
                .map((v) => ({ quest: _todoQuestOf(listQuest, v.sourceFile, v.id), id: v.id as string })));
            void post({ type: 'qtDependencyCleanupDone' });
            return true;
        }
        case 'qtQueueAsTodoItem': {
            // "Queue as todo item" (a tile, the detail view; vscimpb127): a TODO item, a GROUP item for a group todo —
            // except from a group todo's Run row (`asTodo`), whose own group buttons queue the GROUP item: there the
            // group todo itself is queued as a TODO item.
            await queueTodoAsItem(effectiveQuestId(msg.questId), String(msg.todoId || ''), instance, msg.asTodo === true ? 'todo' : undefined, msg.sourceFile);
            return true;
        }
        case 'qtQueueGroupPrompt': {
            const walkQuest = effectiveQuestId(msg.questId);
            const walkPrefix = String(msg.prefix || '');
            if (walkPrefix && _isRepeatedTodoAction(`${walkQuest}/${walkPrefix}*`, 'queue-walk', undefined, `queued: the walk over ${walkPrefix}*`)) { return true; }
            await queueGroupWalk(walkQuest, walkPrefix, instance);
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
            // "Run default": the item takes its run's default template when it is sent.
            const selectedTemplate = itemTemplateOfChoice(msg.template ? String(msg.template) : undefined);
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
            if (_isRepeatedTodoAction(`${questId}/${prepared.map((x) => x.todoId).join(',')}`, 'queue', selectedTemplate, `queued: ${prepared.length} stacked todo${prepared.length === 1 ? '' : 's'}`)) { return true; }
            // Where they go: one target for the whole stack (vscimpb139).
            const target = await queueTodoEntriesWithFlow(instance, _todoQuestOf(questId, entries[0]?.sourceFile, prepared[0].todoId),
                `${prepared.length} stacked todo${prepared.length === 1 ? '' : 's'}`,
                prepared.map(({ text, todoId }) => ({ todoId, text, template: selectedTemplate, todoIdPattern: todoId })));
            if (target && missing.length) {
                vscode.window.showInformationMessage(`Skipped missing stacked todos: ${missing.join(', ')}`);
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
            if (_isRepeatedTodoAction(`${questId}/${fragments.map((f) => f.ref).join(',')}`, 'send', String(msg.template || '__none__'), `sent: ${fragments.length} stacked todo${fragments.length === 1 ? '' : 's'}`)) { return true; }
            if (missing.length) {
                vscode.window.showWarningMessage(`Skipping missing stacked todos: ${missing.join(', ')}`);
            }
            await _sendTodoPromptViaQueueTransport(buildStackedTodoPrompt(fragments), String(msg.template || '__none__'), fragments.map((f) => f.ref.split('/').pop() ?? f.ref), instance);
            return true;
        }
        case 'qtOpenInEditor': {
            // Open a reference file in the VS Code editor
            if (msg.path) {
                const wsRootRef = layoutWorkspaceFolder();
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
            const wsRootExt = layoutWorkspaceFolder();
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
            const wsRoot = layoutWorkspaceFolder();
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
    // Watched at the real path of the `_ai` root: the workspace folder's `_ai` may be a link onto the root's
    // (the native watcher does not follow it), or there is only the root's; one watcher, each change once.
    const aiRoot = WsPaths.aiRoot;
    if (!aiRoot) { return undefined; }
    const pattern = new vscode.RelativePattern(realPathOf(aiRoot), 'quests/**/*.todo.yaml');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(refreshFn);
    watcher.onDidCreate(refreshFn);
    watcher.onDidDelete(refreshFn);
    return watcher;
}

/** Send the full todo list refresh to the webview */
export function sendQuestTodoRefresh(webview: vscode.Webview): void {
    // The panel reloads what it shows (its quest and file, or its scope's quests): a todo file of any
    // quest changed. Sending the window's quest list instead replaced a panel showing another quest.
    void webview.postMessage({ type: 'qtRefreshRequest' });
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
    const wsRoot = layoutWorkspaceFolder();
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
    const wsRoot = layoutWorkspaceFolder();
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

// ============================================================================
// The quest scope (vscimpb137)
// ============================================================================

/** The panel instance a scope is kept for: the quest todo views; none for session, workspace and single-file panels. */
function _scopeInstance(cfg: QuestTodoViewConfig): string | undefined {
    if (cfg.mode === 'session' || cfg.mode === 'workspace-file' || cfg.fixedFile || cfg.fixedQuestId === '__invalid_quest__') { return undefined; }
    if (cfg.scopeInstance) { return cfg.scopeInstance; }
    return cfg.mode === 'fixed-file' ? 'quest-todos' : 'ws';
}

function _windowQuest(): string {
    const q = WsPaths.getWorkspaceQuestId();
    return q && q !== 'default' ? q : '';
}

/** The quests of the windows with a live heartbeat on this machine (tomAi_getQuestWindowStatus's source). */
function _openWindowQuests(): string[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ws = require('./windowStatusPanel-handler.js') as typeof import('./windowStatusPanel-handler');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const hb = require('../utils/windowHeartbeat.js') as typeof import('../utils/windowHeartbeat');
        const now = Date.now();
        return ws.loadAllWindowStates().filter((s) => hb.isWindowAlive(s, now)).map((s) => s.activeQuest).filter((q) => !!q && q !== 'default');
    } catch {
        return [];
    }
}

function _scopeSources(): { all: string[]; open: string[]; windowQuest: string; workspace?: string[]; workspaceName?: string } {
    const windowQuest = _windowQuest();
    const open = _openWindowQuests();
    const ws = windowWorkspaceQuests();
    return {
        all: listQuestIds(),
        open: windowQuest && !open.includes(windowQuest) ? [windowQuest, ...open] : open,
        windowQuest,
        ...(ws && ws.source !== 'all' ? { workspace: ws.quests } : {}),
        ...(ws ? { workspaceName: ws.workspace } : {}),
    };
}

/** The panel's scope: stored per instance; unset, its own quest (the @WS section's last quest, else the window's). */
function _scopeOf(instance: string, cfg: QuestTodoViewConfig): TodoPanelScope {
    const stored = _extensionContext?.workspaceState.get<unknown>(todoPanelScopeKey(instance));
    const own = cfg.fixedQuestId || (instance === 'ws' ? (_loadPanelState().questId || '') : '') || _windowQuest();
    if (stored) { return normalizeTodoPanelScope(stored, own); }
    // An instance with a start of its own (@TOM TODO: the workspace's quests); without an active quest, the workspace's quests.
    if (cfg.defaultScopeKind && cfg.defaultScopeKind !== 'one') {
        return normalizeTodoPanelScope({ kind: _windowQuest() ? cfg.defaultScopeKind : 'workspace' }, own);
    }
    return defaultTodoPanelScope(own);
}

/**
 * A quest from the workspace's quests (vscimpb144), with **All quests…** to choose among every quest. Without a
 * workspace list it is one pick of every quest.
 */
async function _pickQuestWithAllEscape(title: string, describe?: (q: string) => string): Promise<string | undefined> {
    const choices = workspaceQuestChoices(_windowQuest());
    type Item = vscode.QuickPickItem & { quest?: string; all?: boolean };
    const toItem = (q: string): Item => ({ label: q, description: describe?.(q), detail: questShortDescription(q)?.split('\n')[0], quest: q });
    const items: Item[] = choices.quests.map(toItem);
    if (choices.limited) { items.push({ label: '$(list-flat) All quests…', description: `every quest (${choices.all.length})`, all: true }); }
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: choices.limited ? "The workspace's quests, or All quests…" : 'Select the quest', matchOnDetail: true });
    if (!picked) { return undefined; }
    if (!picked.all) { return picked.quest; }
    const any = await vscode.window.showQuickPick(choices.all.map(toItem), { title: `${title} (all quests)`, placeHolder: 'Select the quest', matchOnDetail: true });
    return any?.quest;
}

async function _saveScope(instance: string, scope: TodoPanelScope): Promise<void> {
    await _extensionContext?.workspaceState.update(todoPanelScopeKey(instance), scope);
}

/**
 * Tell the panel its scope: the quests it resolves to, whether it is the panel as it always was
 * (`plain`: its own quest, live files — loaded the usual way), the button text, the quest prefix.
 */
function _postScope(cfg: QuestTodoViewConfig, post: (m: any) => void): void {
    const instance = _scopeInstance(cfg);
    if (!instance) { post({ type: 'qtScope', available: false }); return; }
    const scope = _scopeOf(instance, cfg);
    const sources = _scopeSources();
    const quests = resolveScopeQuests(scope, sources);
    const plain = cfg.mode === 'fixed-file'
        ? isPlainScope(scope, quests, cfg.fixedQuestId || '')
        : scope.kind === 'one' && quests.length === 1 && isPlainScope(scope, quests, quests[0]);
    post({
        type: 'qtScope',
        available: true,
        scope,
        quests,
        plain,
        buttonText: scopeButtonText(scope, quests, sources.all.length),
        prefix: questPrefixShown(scope, quests.length, cfg.questPrefixByDefault === true),
    });
}

/** The scope picker: the workspace's quests, the open windows' quests, all quests (then which, with checkboxes), or one quest. */
async function _pickScope(current: TodoPanelScope): Promise<TodoPanelScope | undefined> {
    const sources = _scopeSources();
    type Item = vscode.QuickPickItem & { scope?: Partial<TodoPanelScope> };
    const items: Item[] = [
        {
            label: '$(folder-library) Workspace quests',
            description: sources.workspace
                ? `${sources.workspaceName ?? 'this workspace'}: ${sources.workspace.length} quest${sources.workspace.length === 1 ? '' : 's'}`
                : `${sources.workspaceName ?? 'this workspace'} lists none: every quest`,
            scope: { kind: 'workspace' }, picked: current.kind === 'workspace',
        },
        { label: "$(window) Open windows' quests", description: sources.open.join(', ') || 'none open', scope: { kind: 'open' }, picked: current.kind === 'open' },
        { label: '$(list-tree) All quests…', description: 'choose which with checkboxes', scope: { kind: 'all' }, picked: current.kind === 'all' },
        { label: 'One quest', kind: vscode.QuickPickItemKind.Separator },
        ...sources.all.map((q): Item => ({
            label: q,
            description: [q === sources.windowQuest ? 'this window' : '', current.kind === 'one' && current.quest === q ? 'shown' : ''].filter(Boolean).join(' · ') || undefined,
            detail: questShortDescription(q)?.split('\n')[0],
            scope: { kind: 'one', quest: q },
        })),
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Quests the todo panel shows', placeHolder: "The workspace's quests, the open windows' quests, all quests, or one quest" });
    if (!choice?.scope) { return undefined; }
    const next: TodoPanelScope = { ...current, kind: choice.scope.kind!, quest: choice.scope.quest, picked: undefined };
    if (next.kind !== 'one') { delete next.quest; }
    if (next.kind === 'all') {
        const was = new Set(current.kind === 'all' && current.picked ? current.picked : sources.all);
        const ticked = await vscode.window.showQuickPick(sources.all.map((q) => ({ label: q, picked: was.has(q) })), {
            title: 'All quests: the ones to see', canPickMany: true, placeHolder: 'Tick the quests the panel shows',
        });
        if (!ticked) { return undefined; }
        const names = ticked.map((t) => t.label);
        if (names.length < sources.all.length) { next.picked = names; }
    }
    return normalizeTodoPanelScope(next, sources.windowQuest);
}

/**
 * The todos of the scope's quests, from the files its toggles admit: each row's
 * source file `<quest>/<file>` (as the all-quests list has it), an archived or
 * deleted one marked `retired`.
 */
function _sendScopedTodoList(scope: TodoPanelScope, post: (m: any) => void): void {
    const quests = resolveScopeQuests(scope, _scopeSources());
    const fileScope = scopeFileScope(scope.files);
    const rows: TodoListItem[] = [];
    for (const qid of quests) {
        for (const file of questTodo.listTodoFiles(qid, fileScope)) {
            let items: questTodo.QuestTodoItem[] = [];
            try { items = questTodo.readTodoFile(questTodo.questTodoFilePath(qid, file)); } catch { continue; }
            const retired = retiredKindOf(file);
            for (const t of items) {
                const row = todoListItem(t, `${qid}/${file}`) as TodoListItem & { retired?: string };
                if (retired) { row.retired = retired; }
                rows.push(row);
            }
        }
    }
    post({ type: 'qtTodos', todos: _withTodoGroups(rows, '__all_quests__'), questId: '__all_quests__', file: 'all', scoped: true });
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
            const wsRoot = layoutWorkspaceFolder() ?? '';
            const fp = WsPaths.ai('quests', questId, file) || path.join(wsRoot, '_ai', 'quests', questId, file);
            items = questTodo.readTodoFile(fp);
        } else {
            const wsRoot = layoutWorkspaceFolder() ?? '';
            const mainFile = `todos.${questId}.todo.yaml`;
            const fp = WsPaths.ai('quests', questId, mainFile) || path.join(wsRoot, '_ai', 'quests', questId, mainFile);
            items = questTodo.readTodoFile(fp);
        }
        const list = _withTodoGroups(items.map(t => todoListItem(t, t._sourceFile ?? '')), questId);
        post({ type: 'qtTodos', todos: list, questId, file: file ?? 'all' });
        _sendFileList(questId, post);
    } catch { /* */ }
}

function _sendTodoDetail(questId: string, todoId: string, post: (m: any) => void, sourceFile?: string): void {
    let todo: questTodo.QuestTodoItem | undefined;
    let resolvedQuestId = questId;
    if (questId === '__all_quests__') {
        // The row's file (`<quest>/<file>`, archived and deleted siblings included), else every quest's live files.
        const slash = (sourceFile ?? '').indexOf('/');
        if (slash > 0 && !path.isAbsolute(sourceFile!)) {
            const qid = sourceFile!.slice(0, slash);
            const fp = questTodo.questTodoFilePath(qid, sourceFile!.slice(slash + 1));
            todo = fs.existsSync(fp) ? questTodo.findTodoByIdInFile(fp, todoId) : undefined;
            if (todo) { resolvedQuestId = qid; }
        }
        for (const qid of todo ? [] : listQuestIds()) {
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
    // The overdue state is derived (vscimpb152aa): the detail's Due field shows it.
    if (payload && isTodoOverdue(payload, localDate(new Date()))) { payload.overdue = true; }
    // An archived or deleted todo is shown read-only, with Restore (vscimpb137).
    const retired = payload && sourceFile ? retiredKindOf(sourceFile) : undefined;
    if (retired) { payload._retired = retired; }
    // Todo groups (vscimpb126): the groups it belongs to, and a group's members with title and status.
    if (payload && resolvedQuestId && !resolvedQuestId.startsWith('__')) {
        const root = todoQuestsRoot();
        if (root) {
            const info = groupListInfo(root);
            const partOf = info.partOf(resolvedQuestId, payload.id);
            if (partOf.length) { payload.part_of = partOf; }
            if (Array.isArray(payload.comprised_of) || payload.status === 'group') {
                payload.group_members = info.members(resolvedQuestId, payload.comprised_of ?? []);
            }
        }
    }
    post({ type: 'qtTodoDetail', todo: payload, questId, todoId });
}

/**
 * A quest list with its todo groups (vscimpb126): each row's `part_of`, each
 * group row's members. The quest of a row is the list's, or in the
 * all-quests list the one its source file names (`<quest>/<file>`).
 */
function _withTodoGroups(list: TodoListItem[], questId: string): TodoListItem[] {
    if (questId === '__all_workspace__' || questId === '__session__') { return list; }
    const root = todoQuestsRoot();
    if (!root) { return list; }
    try {
        const questOf = (item: TodoListItem): string | undefined => (questId === '__all_quests__'
            ? (item.sourceFile.includes('/') ? item.sourceFile.split('/')[0] : undefined)
            : questId);
        return withTodoGroups(list, questOf, groupListInfo(root));
    } catch {
        return list;
    }
}

/**
 * The guideline picker's data for a todo panel (gsel5): the sections and the
 * shared levels, and the window's run's choices and default role (a todo's
 * effective selection counts the run it would be queued into).
 */
/** The todo views that asked for the picker's data (qtGetAspects): told again when a level changes. */
const _aspectViews = new Set<vscode.Webview>();

/**
 * A fresh `qtAspects` to every todo view showing the picker (gsel5b): a level changed in another page, in this
 * one or in another window. A disposed view (its post throws or is refused) is dropped. Answers the views posted to.
 */
export function postTodoAspectsToAllViews(): number {
    if (_aspectViews.size === 0) { return 0; }
    const message = _todoAspectMessage();
    let posted = 0;
    for (const view of [..._aspectViews]) {
        try {
            Promise.resolve(view.postMessage(message)).then(undefined, () => { _aspectViews.delete(view); });
            posted++;
        } catch {
            _aspectViews.delete(view);
        }
    }
    return posted;
}

function _todoAspectMessage(): { type: 'qtAspects'; aspects: unknown; runGuidelines?: Record<string, string | string[]>; runDefaultRole?: string } {
    let aspects: unknown;
    try { aspects = aspectPickerState(); } catch { aspects = undefined; }
    let runGuidelines: Record<string, string | string[]> | undefined;
    let runDefaultRole: string | undefined;
    try {
        const { PromptQueueManager: pqm } = require('../managers/promptQueueManager') as typeof import('../managers/promptQueueManager');
        const settings = pqm.instance.runQueueSettings();
        runGuidelines = settings.guidelines;
        runDefaultRole = settings.defaultRole;
    } catch { /* no queue yet: the run adds nothing */ }
    return { type: 'qtAspects', aspects, ...(runGuidelines ? { runGuidelines } : {}), ...(runDefaultRole ? { runDefaultRole } : {}) };
}

function _saveTodo(questId: string, todoId: string, updates: any, post: (m: any) => void): void {
    // `filed_by` is the record of who filed it: never written from the form.
    if (updates && typeof updates === 'object') { delete updates.filed_by; }
    const onDoneError = _onDoneError(questId, updates?.on_done);
    if (onDoneError) {
        post({ type: 'qtSaved', success: false, todoId, error: onDoneError });
        void vscode.window.showWarningMessage(`After done: ${onDoneError}`);
        return;
    }
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

/** The process runs of `questId` (`default` and every `process-state.<quest>.<run>.yaml`). */
function _questRuns(questId: string): string[] {
    const runs = new Set<string>(['default']);
    const folder = WsPaths.ai('quests', questId);
    if (!questId || !folder) { return [...runs]; }
    try {
        for (const f of fs.readdirSync(folder)) {
            const run = runOfStateFile(questId, f);
            if (run) { runs.add(run); }
        }
    } catch { /* no folder: only default */ }
    return [...runs];
}

/** Why an `on_done` from the form cannot be written (its shape, unblock / queue targets that exist), or undefined. */
function _onDoneError(questId: string, onDone: unknown): string | undefined {
    if (!onDone) { return undefined; }
    return onDoneShapeError(onDone)
        ?? onDoneTargetRefusal(onDone as TodoOnDone, questId, (q, id) => !!questTodo.findTodoById(q, id));
}

function _createTodo(questId: string, todo: any, file: string | undefined, post: (m: any) => void): void {
    try {
        const onDoneError = _onDoneError(questId, todo?.on_done);
        if (onDoneError) { throw new Error(onDoneError); }
        // `fileTodo`: `filed_by` from where the call runs, and the unblock entries.
        const created = questTodo.fileTodo(questId, todo, file);
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
        const wsRoot = layoutWorkspaceFolder();
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
/**
 * The row's move button, "Move to a group todo…": pick one of the quest's group todos; the todos become its
 * members (at the end) and leave the other group todos of the quest they were in. The todos themselves stay
 * where they are (file, id, prefix group).
 */
/**
 * A prefix group's move button, "Move to a new group todo…": asks the new todo's id, appends the date code
 * (`<typed>_<code>`, as tomAi_generateIdPrefix gives it), refuses an id the quest has (archived and deleted
 * included) or the todo schema refuses, and creates a group todo in the quest's own file with the group's todos
 * as its members — as adding a todo and then the members by hand. Answers the new id; none when cancelled.
 */
async function _moveTodosToNewGroupTodo(questId: string, ids: readonly string[]): Promise<string | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildIdPrefix } = require('../tools/id-prefix-tools.js') as typeof import('../tools/id-prefix-tools');
    const code = buildIdPrefix(new Date());
    const taken = new Set(questTodo.readAllTodos(questId, questTodo.ALL_TODO_FILES).map((t) => t.id));
    const typed = await vscode.window.showInputBox({
        title: `New group todo of ${questId} with ${ids.length === 1 ? `todo ${ids[0]}` : `the ${ids.length} todos`} as its members`,
        prompt: `Its id; the date code is appended: <id>_${code}`,
        placeHolder: 'e.g. grp1',
        validateInput: (value) => {
            if (!value.trim()) { return 'Enter the id of the new group todo.'; }
            const id = newGroupTodoId(value, code);
            return todoIdInputError(id, '', taken) ?? questTodo.todoIdRefusal(id);
        },
    });
    if (!typed || !typed.trim()) { return undefined; }
    const id = newGroupTodoId(typed, code);
    const refused = todoIdInputError(id, '', taken) ?? questTodo.todoIdRefusal(id);
    if (refused) { vscode.window.showWarningMessage(refused); return undefined; }
    try {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
        questTodo.createTodo(questId, { id, title: typed.trim(), description: '', status: GROUP_STATUS, priority: 'medium', comprised_of: [...ids] } as never);
    } catch (e) {
        vscode.window.showWarningMessage(`Could not create the group todo ${id}: ${(e as Error).message}`);
        return undefined;
    }
    vscode.window.showInformationMessage(`Created the group todo ${id} with ${ids.length} member${ids.length === 1 ? '' : 's'}.`);
    return id;
}

async function _moveTodosToGroupTodo(questId: string, ids: readonly string[]): Promise<void> {
    const groups = questTodo.readAllTodos(questId).filter((t) => t.status === GROUP_STATUS && !ids.includes(t.id));
    const count = ids.length === 1 ? `todo ${ids[0]}` : `the ${ids.length} todos`;
    const pick = await vscode.window.showQuickPick(
        groups.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id))).map((g) => ({
            label: `$(folder-library) ${g.title || g.id}`,
            description: `${g.id} · ${(g.comprised_of ?? []).length} member${(g.comprised_of ?? []).length === 1 ? '' : 's'}`,
            groupId: g.id,
        })),
        { title: `Move ${count} to a group todo of ${questId}`, placeHolder: 'The group todo it becomes a member of' },
    );
    if (!pick) { return; }
    const changes = moveIntoGroupTodo(groups.map((g) => ({ id: g.id, comprisedOf: g.comprised_of ?? [] })), pick.groupId, ids, questId);
    const failed: string[] = [];
    for (const c of changes) {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
        try { if (!questTodo.updateTodo(questId, c.id, { comprised_of: c.comprisedOf } as never)) { failed.push(c.id); } } catch (e) { failed.push(`${c.id}: ${(e as Error).message}`); }
    }
    if (failed.length) { vscode.window.showWarningMessage(`Could not update the group todo${failed.length === 1 ? '' : 's'} ${failed.join(', ')}.`); return; }
    const left = changes.filter((c) => c.id !== pick.groupId).map((c) => c.id);
    vscode.window.showInformationMessage(changes.length
        ? `Moved ${count} to the group todo ${pick.groupId}${left.length ? ` (out of ${left.join(', ')})` : ''}.`
        : `${ids.length === 1 ? `Todo ${ids[0]} is` : 'The todos are'} already in the group todo ${pick.groupId}.`);
}

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
    const wsRoot = layoutWorkspaceFolder() ?? '';
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
    const wsRoot = layoutWorkspaceFolder();
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
    instance = 'panel',
): Promise<void> {
    const anthropic = loadSendToChatConfig()?.anthropic;
    const tpl = resolveTodoButtonTemplate(anthropic?.todoButtonTemplates, anthropic?.userMessageTemplates, use);
    if (tpl.missing || !tpl.body) {
        vscode.window.showWarningMessage(`The Todo buttons template "${tpl.id}" (${TODO_BUTTON_TEMPLATE_INFO[use].label}) is not among the Anthropic templates: choose one on the Status Page (Todo buttons).`);
        return;
    }
    if (target === 'queue') {
        await _queueTodo(todo, questId, sourceFile, tpl, instance);
        return;
    }
    const ctx = _extensionContext;
    if (!ctx) {
        vscode.window.showErrorMessage('Extension context unavailable — cannot send to Anthropic.');
        return;
    }
    const todoPrompt = buildStackedTodoPrompt([_todoPromptFragment(todo, questId, sourceFile)]);
    const { runAnthropicSend } = await import('./sendToChatRouter.js');
    // In a free session of this window's runs, asked for (vscimpb139).
    const sendTarget = await pickTodoSendTarget(instance);
    if (!sendTarget) { return; }
    const outcome = await _sendTodoInTarget(sendTarget, (session) => runAnthropicSend(ctx, todoPrompt, {
        userMessageTemplate: tpl.body, source: `todo panel: ${use === 'userAction' ? 'guide me' : 'send'}`, session, run: sendTarget.run,
        // Sent by the panel's buttons: its todo done notification (DP-part-done-notification-1).
        onChatItem: (chatItemId) => { void _recordChatQueuedBy(chatItemId); },
    }));
    if (outcome.rejected) {
        vscode.window.showWarningMessage(busySessionWarning(outcome.busySession ?? sendTarget.session));
    } else if (!outcome.ok && outcome.error) {
        vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
    } else if (outcome.ok && use === 'userAction' && questId) {
        await _guideMeClosing(todo.id, questId, sourceFile, instance);
    }
}

/** The todo added to the prompt queue on Anthropic, with template `tpl`, where the flow says (vscimpb139). */
async function _queueTodo(todo: questTodo.QuestTodoItem, questId: string | undefined, sourceFile: string | undefined, tpl: { id: string; name: string }, instance = 'panel'): Promise<void> {
    await queueTodoEntriesWithFlow(instance, _todoQuestOf(questId ?? '', sourceFile, todo.id), `todo ${todo.id} with the template "${tpl.name}"`, [{
        todoId: todo.id,
        text: _todoPromptFragment(todo, questId, sourceFile).yaml,
        template: tpl.id,
        transport: 'anthropic',
        todoIdPattern: todo.id,
    }]);
}

/** The open members of a `<prefix>*` group of `quest`, as the walk reads them (lowest number first). */
export function prefixGroupMembers(quest: string, prefix: string): questTodo.QuestTodoItem[] {
    const todos = questTodo.readAllTodos(quest);
    const ids = new Set(collectPrefixTodos(prefix, todos.map((t) => ({ id: t.id, status: t.status }))).map((e) => e.id));
    return todos.filter((t) => ids.has(t.id));
}

/** A group todo's members of its own quest, in `comprised_of` order. */
export function groupTodoMembers(quest: string, group: questTodo.QuestTodoItem | undefined): questTodo.QuestTodoItem[] {
    const todos = new Map(questTodo.readAllTodos(quest).map((t) => [t.id, t]));
    const out: questTodo.QuestTodoItem[] = [];
    for (const ref of group?.comprised_of ?? []) {
        const slash = ref.indexOf('/');
        if (slash >= 0 && ref.slice(0, slash) !== quest) { continue; }
        const member = todos.get(slash >= 0 ? ref.slice(slash + 1) : ref);
        if (member && !out.includes(member)) { out.push(member); }
    }
    return out;
}

/**
 * What the members of a group about to be queued wait for outside the group: unmet `blocked_by` entries
 * naming a todo that is no member. A blocker of this window's quest that the prompt queue already holds is
 * marked `queuedAhead`.
 */
export function groupOutsideBlockers(quest: string, members: readonly questTodo.QuestTodoItem[]): OutsideBlocker[] {
    const root = todoQuestsRoot() ?? WsPaths.ai('quests');
    if (!root || !members.length) { return []; }
    const index = questStatusIndex(root);
    const queued = (_queueItemsForMarks() ?? []).filter((i) => !['sent', 'chat', 'chat-sent'].includes(i.status)).map((i) => todoIdPatternOf(i)).filter((p): p is string => !!p);
    const windowQuest = _windowQuest();
    return outsideBlockers(members, quest, index.statusOf, index.quests, (blockerQuest, id) =>
        blockerQuest === windowQuest && queued.some((p) => todoIdPatternMatches(p, { id, status: index.statusOf(blockerQuest, id) })));
}

/**
 * Before a group is queued — a group todo's members, a `<prefix>*` group — its `blocked_by` dependencies are
 * checked first: when members wait for todos outside the group (not completed, or already in the queue
 * ahead), the user is asked whether to queue it all the same. Answers whether to go on.
 */
export async function confirmGroupBlockers(quest: string, members: readonly questTodo.QuestTodoItem[], what: string): Promise<boolean> {
    const blockers = groupOutsideBlockers(quest, members);
    if (!blockers.length) { return true; }
    const q = outsideBlockersQuestion(what, blockers);
    const picked = await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, 'Queue anyway');
    return picked === 'Queue anyway';
}

/**
 * A todo view's queue or send action that repeats one accepted within 3 s
 * (a double click, a bouncing mouse, one message posted several times) is
 * ignored with a status-bar note, as the detail's Send / Queue buttons are
 * (`_todoButtonGuard`, duplicateSubmitGuard.ts). `text` names the quest and the
 * todo(s), `transport` the action, `template` the template it uses.
 */
function _isRepeatedTodoAction(text: string, transport: string, template: string | undefined, what: string): boolean {
    if (!_todoButtonGuard.isDuplicate({ text, transport, template: template ?? '' })) { return false; }
    vscode.window.setStatusBarMessage(`$(info) Already ${what} within 3 s`, 4000);
    return true;
}

/** The notice for a todo already in the queue, with **Queue again** for a deliberate repeat. */
function _offerQueueAgain(notice: string, again: () => Promise<void>): void {
    void Promise.resolve(vscode.window.showWarningMessage(notice, 'Queue again')).then(async (choice) => {
        if (choice !== 'Queue again') { return; }
        try { await again(); } catch (e) { vscode.window.showWarningMessage(`Prompt queue: ${(e as Error).message}`); }
    });
}


/**
 * After Guide me's turn (guideMeClosing.ts): a todo not completed meanwhile is
 * offered to be marked completed or in progress, queued for the agent (the
 * other todos' template), or left; a typed reply goes into its notes.
 */
async function _guideMeClosing(todoId: string, questId: string, sourceFile: string | undefined, instance = 'panel'): Promise<void> {
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
        await _queueTodo(todo, questId, sourceFile, queueTpl, instance);
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

/** A run's default template (its queue settings), or `__none__`. */
async function _runDefaultTemplate(run: string): Promise<string> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        return PromptQueueManager.instance.runQueueSettings(run).defaultMessageTemplateId || '__none__';
    } catch { return '__none__'; }
}

async function _queueSendTarget(): Promise<{ transport: TodoSendTransport; templateId?: string }> {
    try {
        const { PromptQueueManager } = await import('../managers/promptQueueManager.js');
        const qm = PromptQueueManager.instance;
        // The queue defaults of this window's run (queue settings per run, vscimpb60a).
        const defaults = qm.runQueueSettings(_windowRuns().windowRun);
        return {
            transport: defaults.defaultTransport === 'anthropic' ? 'anthropic' : 'copilot',
            templateId: defaults.defaultMessageTemplateId || undefined,
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
async function _sendTodoPromptViaQueueTransport(todoPrompt: string, selectedTemplate: string, todoIds: string[] = [], instance = 'panel'): Promise<void> {
    const config = loadSendToChatConfig();
    const { transport } = await _queueSendTarget();
    if (transport === 'anthropic') {
        const ctx = _extensionContext;
        if (!ctx) {
            vscode.window.showErrorMessage('Extension context unavailable — cannot send to Anthropic.');
            return;
        }
        const { runAnthropicSend } = await import('./sendToChatRouter.js');
        // In a free session of this window's runs, asked for (vscimpb139).
        const sendTarget = await pickTodoSendTarget(instance);
        if (!sendTarget) { return; }
        // "Run default": the default template of the run it is sent in, looked up now.
        const template = isRunDefaultChoice(selectedTemplate) ? (await _runDefaultTemplate(sendTarget.run)) : selectedTemplate;
        const tplBody = (template && template !== '__none__')
            ? config?.anthropic?.userMessageTemplates?.find((t) => t.id === template)?.template
            : undefined;
        const outcome = await _sendTodoInTarget(sendTarget, (session) => runAnthropicSend(ctx, todoPrompt, {
            source: 'todo panel', session, run: sendTarget.run, ...(tplBody ? { userMessageTemplate: tplBody } : {}),
            // Sent by the panel's buttons: the todos' done notifications (DP-part-done-notification-1).
            onChatItem: (chatItemId) => { void _recordChatQueuedBy(chatItemId); },
        }));
        if (outcome.rejected) {
            vscode.window.showWarningMessage(busySessionWarning(outcome.busySession ?? sendTarget.session));
        } else if (!outcome.ok && outcome.error) {
            vscode.window.showErrorMessage(`Send to Anthropic failed: ${outcome.error}`);
        }
        return;
    }

    // A todo button waits for the answer: the template (one store) inside the
    // Copilot Queue Wrapper (src/utils/copilotTemplates.ts).
    // "Run default": the default template of this window's run, looked up now.
    const body = userMessageTemplateBody(config, isRunDefaultChoice(selectedTemplate) ? (await _queueSendTarget()).templateId ?? '' : selectedTemplate);
    const inner = body ? await expandTemplate(fillTemplate(body, todoPrompt)) : todoPrompt;
    const expanded = await expandTemplate(fillWrapper(copilotQueueWrapper(config), inner));

    // The record's `$${` (escaped against the passes above) become `${` here, where the text leaves.
    // The aspect guidelines go before the prompt: Copilot has no system prompt of its own (gsel2).
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: withAspectsForCopilot(unescapePlaceholders(expanded)) });
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
    const wsRoot = layoutWorkspaceFolder();
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
        // A row of the scoped list names its file `<quest>/<file>` (vscimpb137).
        const slash = (sourceFile ?? '').indexOf('/');
        if (sourceFile && slash > 0 && !path.isAbsolute(sourceFile)) {
            const fp = questTodo.questTodoFilePath(sourceFile.slice(0, slash), sourceFile.slice(slash + 1));
            if (fs.existsSync(fp)) {
                const found = questTodo.findTodoByIdInFile(fp, todoId);
                if (found) { return found; }
            }
        }
        if (sourceFile) {
            const wsRoot = layoutWorkspaceFolder();
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
            const wsRoot = layoutWorkspaceFolder();
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
        const wsRoot = layoutWorkspaceFolder();
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
 * Queue a todo as a TODO item, or a group todo as a GROUP item (vscimpb127), where the queue-target flow says
 * (vscimpb139: quest → run → free session; next or end is the Next toggle). A TODO item is the panel's todo prompt —
 * {@link TODO_ITEM_TEXT} in the Todo buttons template for that todo, on Anthropic, as the Queue button beside it;
 * a GROUP item has the quest's group prompt, as a `<prefix>*` walk. The walk appends each todo's record and goes
 * over the todos of the todo's own quest, so it is queued into that quest (another quest's through its window's
 * inbox).
 */
async function queueTodoAsItem(questId: string, todoId: string, instance = 'panel', forceKind?: 'group' | 'todo', sourceFile?: string): Promise<void> {
    if (!todoId) { void vscode.window.showErrorMessage('Select a todo first.'); return; }
    const todoQuest = _todoQuestOf(questId, sourceFile, todoId);
    const todo = todoQuest ? questTodo.findTodoById(todoQuest, todoId) : undefined;
    const kind = forceKind ?? (isGroupTodo(todo) ? 'group' : 'todo');
    const spec = todoQueueItemSpec(kind, todoQuest, todoId, todo);
    if (!spec.ok) { void vscode.window.showWarningMessage(spec.error); return; }
    if (_isRepeatedTodoAction(`${todoQuest}/${spec.id}`, `queue-${kind}-item`, undefined, `queued: ${kind} item ${spec.id}`)) { return; }
    // A group: its members' blockers outside the group first, before anything else is asked.
    if (kind === 'group' && !await confirmGroupBlockers(todoQuest, groupTodoMembers(todoQuest, todo), `The group ${spec.id}`)) { return; }
    let text: string;
    let template: string | undefined;
    if (kind === 'todo') {
        const anthropic = loadSendToChatConfig()?.anthropic;
        const use = todoButtonTemplateUse(todo!);
        const tpl = resolveTodoButtonTemplate(anthropic?.todoButtonTemplates, anthropic?.userMessageTemplates, use);
        if (tpl.missing || !tpl.body) {
            void vscode.window.showWarningMessage(`The Todo buttons template "${tpl.id}" (${TODO_BUTTON_TEMPLATE_INFO[use].label}) is not among the Anthropic templates: choose one on the Status Page (Todo buttons).`);
            return;
        }
        text = TODO_ITEM_TEXT;
        template = tpl.id;
    } else {
        const dirs = groupPromptDirs(todoQuest);
        text = effectiveGroupDefault(dirs ? readGroupPrompts(dirs) : []).text;
    }
    const noun = kind === 'group' ? `the group ${spec.id} as a GROUP item` : `todo ${spec.id} as a TODO item`;
    await queueTodoEntriesWithFlow(instance, todoQuest, noun, [{
        todoId: spec.id,
        text,
        ...(template ? { template } : {}),
        ...(kind === 'todo' ? { transport: 'anthropic' as const } : {}),
        repeatCount: spec.repeatCount,
        todoIdPattern: spec.todoIdPattern,
    }], todoQuest);
}

/**
 * The todo group headline's "Queue Group Prompt": pick a group prompt (the default, the default with an addition,
 * or one of the quest's own prompts) or open the group prompt editor, then queue a walk over `<prefix>*` with the
 * prompt picked, where the queue-target flow says (vscimpb139). The walk goes over the todos of the group's quest,
 * so it is queued into that quest. The queue holds a walk with nothing to walk over in `error` at once; that reason
 * is shown.
 */
async function queueGroupWalk(questId: string, prefix: string, instance = 'panel'): Promise<void> {
    if (!prefix) { return; }
    const walkQuest = questId && !questId.startsWith('__') ? questId : _windowQuest();
    if (!walkQuest) { void vscode.window.showWarningMessage('A group walk needs its quest: open the quest, or show it by quest.'); return; }
    // The group's blockers outside the group first, before anything else is asked.
    if (!await confirmGroupBlockers(walkQuest, prefixGroupMembers(walkQuest, prefix), `The walk over ${prefix}*`)) { return; }
    const dirs = groupPromptDirs(walkQuest);
    const choices = groupPromptChoices(dirs ? readGroupPrompts(dirs) : [], walkQuest);
    const picked = await pickGroupPrompt(prefix, choices);
    if (!picked) { return; }
    if (picked === 'editor') {
        await vscode.commands.executeCommand('tomAi.editor.groupPrompts', walkQuest);
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
    await queueTodoEntriesWithFlow(instance, walkQuest, `a walk over ${prefix}* with "${label}"`, [{
        // The item names the todos it is about, as every item queued from the todo panel does.
        todoId: `${prefix}*`, text, repeatCount: `${prefix}*`, todoIdPattern: `${prefix}*`,
    }], walkQuest);
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
