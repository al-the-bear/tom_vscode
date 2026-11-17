/**
 * The todo panel's quest scope (vscimpb137): which quests' todos it shows and
 * from which files. Pure, so the host and the tests share it.
 *
 * - **one** quest (any quest folder; default the window's quest);
 * - **open**: the quests of the windows with a live heartbeat;
 * - **workspace**: the window's workspace quests (`_ai/workspaces/<workspace>.yaml`,
 *   utils/aiWorkspace.ts; every quest without a list; vscimpb144);
 * - **all**: every quest, narrowed by the quests ticked in `picked` (unset:
 *   every quest).
 *
 * `files` says which todo files: live (the quest and session files), the
 * `-archived` and the `-deleted` siblings. `order` arranges a list with more
 * than one quest: `combined` (the groups of all quests together), `quest-groups`
 * (quests, then each quest's groups) or `quest-list` (quests, then each quest's
 * todos as a list). `prefix` shows the quest in front of every todo id; unset,
 * it follows {@link questPrefixShown}.
 *
 * A scope of the panel's own quest with the live files only is the panel as it
 * always was ({@link isPlainScope}): it loads that quest the usual way.
 */

import type { TodoFileScope } from './todoArchiveNames';

export type TodoPanelScopeKind = 'one' | 'open' | 'workspace' | 'all';
export type TodoPanelQuestOrder = 'combined' | 'quest-groups' | 'quest-list';

export interface TodoPanelFiles {
    live: boolean;
    archived: boolean;
    deleted: boolean;
}

export interface TodoPanelScope {
    kind: TodoPanelScopeKind;
    /** With `one`: the quest. */
    quest?: string;
    /** With `all`: the quests ticked; unset, every quest. */
    picked?: string[];
    files: TodoPanelFiles;
    order: TodoPanelQuestOrder;
    /** The quest prefix in front of todo ids; unset, the default for the number of quests shown. */
    prefix?: boolean;
}

/** The quests the scope may name: every quest folder, the open windows' quests, the window's own, the workspace's. */
export interface TodoPanelQuestSources {
    all: readonly string[];
    open: readonly string[];
    windowQuest: string;
    /** The window's workspace quests; unset: every quest. */
    workspace?: readonly string[];
}

const KINDS: readonly TodoPanelScopeKind[] = ['one', 'open', 'workspace', 'all'];
const ORDERS: readonly TodoPanelQuestOrder[] = ['combined', 'quest-groups', 'quest-list'];

/** The panel's start: the window's quest, live todos, the groups combined, the prefix by default. */
export function defaultTodoPanelScope(windowQuest: string): TodoPanelScope {
    return { kind: 'one', quest: windowQuest, files: { live: true, archived: false, deleted: false }, order: 'combined' };
}

/** A stored or sent scope made whole: unknown kinds and orders fall back, `one` gets a quest. */
export function normalizeTodoPanelScope(raw: unknown, windowQuest: string): TodoPanelScope {
    const base = defaultTodoPanelScope(windowQuest);
    if (!raw || typeof raw !== 'object') { return base; }
    const r = raw as Record<string, unknown>;
    const kind = KINDS.includes(r.kind as TodoPanelScopeKind) ? r.kind as TodoPanelScopeKind : base.kind;
    const f = (r.files && typeof r.files === 'object' ? r.files : {}) as Record<string, unknown>;
    const files: TodoPanelFiles = {
        live: f.live === undefined ? true : f.live === true,
        archived: f.archived === true,
        deleted: f.deleted === true,
    };
    const scope: TodoPanelScope = {
        kind,
        files,
        order: ORDERS.includes(r.order as TodoPanelQuestOrder) ? r.order as TodoPanelQuestOrder : base.order,
    };
    if (kind === 'one') { scope.quest = typeof r.quest === 'string' && r.quest ? r.quest : windowQuest; }
    if (kind === 'all' && Array.isArray(r.picked)) { scope.picked = r.picked.filter((q): q is string => typeof q === 'string' && !!q); }
    if (typeof r.prefix === 'boolean') { scope.prefix = r.prefix; }
    return scope;
}

/**
 * The quests a scope shows, in order: `one` its quest (the window's when it no
 * longer exists); `open` the open windows' quests that exist, the window's
 * quest first; `workspace` the workspace's quests that exist, in the list's order;
 * `all` every quest, or the ticked ones.
 */
export function resolveScopeQuests(scope: TodoPanelScope, sources: TodoPanelQuestSources): string[] {
    const exists = new Set(sources.all);
    if (scope.kind === 'one') {
        const q = scope.quest && exists.has(scope.quest) ? scope.quest : sources.windowQuest;
        return q && exists.has(q) ? [q] : [];
    }
    if (scope.kind === 'open') {
        const open = [...new Set(sources.open)].filter((q) => exists.has(q)).sort();
        const own = open.indexOf(sources.windowQuest);
        if (own > 0) { open.splice(own, 1); open.unshift(sources.windowQuest); }
        return open;
    }
    if (scope.kind === 'workspace') {
        if (!sources.workspace) { return [...sources.all].sort(); }
        return [...new Set(sources.workspace)].filter((q) => exists.has(q));
    }
    const all = [...sources.all].sort();
    if (!scope.picked) { return all; }
    const picked = new Set(scope.picked);
    return all.filter((q) => picked.has(q));
}

/** The todo files the scope's toggles admit, as listTodoFiles takes them. */
export function scopeFileScope(files: TodoPanelFiles): TodoFileScope {
    return { showNormalFiles: files.live, showArchiveFiles: files.archived, showDeletedFiles: files.deleted };
}

/** Whether the panel works as it always did: one quest, `baseQuest` (its own), the live files only. */
export function isPlainScope(scope: TodoPanelScope, quests: readonly string[], baseQuest: string): boolean {
    return quests.length === 1 && quests[0] === baseQuest && scope.files.live && !scope.files.archived && !scope.files.deleted;
}

/**
 * Whether todo ids show their quest in front: the scope's choice, else on once
 * more than one quest is shown, and on in @TOM TODO (`alwaysByDefault`).
 */
export function questPrefixShown(scope: TodoPanelScope, questCount: number, alwaysByDefault = false): boolean {
    if (typeof scope.prefix === 'boolean') { return scope.prefix; }
    return alwaysByDefault || questCount > 1;
}

/** The scope button's text: the quest, or what is shown and how many. */
export function scopeButtonText(scope: TodoPanelScope, quests: readonly string[], allCount: number): string {
    if (scope.kind === 'one') { return quests[0] ?? scope.quest ?? '(no quest)'; }
    if (scope.kind === 'open') { return `Open windows (${quests.length})`; }
    if (scope.kind === 'workspace') { return `Workspace quests (${quests.length})`; }
    return scope.picked ? `All quests (${quests.length}/${allCount})` : `All quests (${allCount})`;
}

/** The workspaceState key of a panel instance's scope. */
export function todoPanelScopeKey(instance: string): string {
    return `tomAi.todoPanel.scope.${instance}`;
}

/** Whether a row's file is a retired sibling, and which: shown read-only, with Restore. */
export function retiredKindOf(fileName: string): 'archived' | 'deleted' | undefined {
    const base = fileName.slice(fileName.lastIndexOf('/') + 1);
    const dot = base.indexOf('.');
    const first = dot === -1 ? base : base.slice(0, dot);
    if (first.endsWith('-archived')) { return 'archived'; }
    if (first.endsWith('-deleted')) { return 'deleted'; }
    return undefined;
}
