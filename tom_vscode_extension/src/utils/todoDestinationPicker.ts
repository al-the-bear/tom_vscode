/**
 * The "move to…" picker of the todo panels: which destinations to offer for a
 * set of todos, and how to word it. vscode-free; the panel handler shows the
 * QuickPick and runs the moves (questTodoManager.moveTodoToDestination).
 */

/** Where one todo currently lives. */
export interface TodoMoveOrigin {
    /** The quest whose folder holds the file; undefined for workspace.todo.yaml and files outside quests. */
    questId?: string;
    /** The file is the quest's own `todos.<quest>.todo.yaml`. */
    inQuestMainFile: boolean;
    /** The file is the workspace's `workspace.todo.yaml`. */
    inWorkspaceFile: boolean;
}

export type TodoMoveChoice =
    | { kind: 'quest'; questId: string }
    | { kind: 'workspace' }
    | { kind: 'pickQuest' }
    /** Another id group of the todos' own quest (a second picker names it). */
    | { kind: 'pickGroup'; questId: string };

export interface TodoMoveOption {
    label: string;
    description?: string;
    choice: TodoMoveChoice;
}

/** "Move this todo to…" or "Move 3 stacked todos to…", the wording the stack's other actions use. */
export function todoMovePickerTitle(count: number): string {
    return count === 1 ? 'Move this todo to…' : `Move ${count} stacked todos to…`;
}

/**
 * The destinations for these todos, in order:
 *   - their quest's todos, when they all belong to one quest and not all are in its own file already;
 *   - another id group of their quest, when they all belong to one quest (a second picker names it);
 *   - the workspace todos, unless all are there already;
 *   - another quest, always (a second picker names it).
 */
export function todoMoveOptions(origins: readonly TodoMoveOrigin[]): TodoMoveOption[] {
    const options: TodoMoveOption[] = [];
    const quests = new Set(origins.map((o) => o.questId));
    const [onlyQuest] = [...quests];
    if (quests.size === 1 && onlyQuest && !origins.every((o) => o.inQuestMainFile)) {
        options.push({
            label: '$(checklist) Quest todos',
            description: `todos.${onlyQuest}.todo.yaml`,
            choice: { kind: 'quest', questId: onlyQuest },
        });
    }
    if (quests.size === 1 && onlyQuest) {
        options.push({
            label: '$(symbol-number) Move to another group…',
            description: `renumbered at the end of a group of ${onlyQuest}, before its finalizers (999)`,
            choice: { kind: 'pickGroup', questId: onlyQuest },
        });
    }
    if (!origins.every((o) => o.inWorkspaceFile)) {
        options.push({ label: '$(globe) Workspace todos', description: 'workspace.todo.yaml', choice: { kind: 'workspace' } });
    }
    options.push({ label: '$(folder) Move to quest…', description: 'the todo file of another quest', choice: { kind: 'pickQuest' } });
    return options;
}

/** The origin of a todo file given as a workspace-relative path (`_ai/quests/<q>/<file>` or `workspace.todo.yaml`). */
export function todoOriginOfRelativePath(relPath: string): TodoMoveOrigin {
    const norm = relPath.split('\\').join('/');
    const m = /(?:^|\/)_ai\/quests\/([^/]+)\/([^/]+)$/.exec(norm);
    if (m) {
        return { questId: m[1], inQuestMainFile: m[2] === `todos.${m[1]}.todo.yaml`, inWorkspaceFile: false };
    }
    return { inQuestMainFile: false, inWorkspaceFile: norm === 'workspace.todo.yaml' };
}

// ---------------------------------------------------------------------------
// Renaming todos moved into another quest
// ---------------------------------------------------------------------------

/**
 * The prefix of a todo id — the todo panel's group key (media/questTodoPanel/
 * grouping.js `qtTodoPrefix`, tom_todo_model `tomTodoGroupOf`): a leading
 * number is part of the group's name and only sorts the groups
 * (`001_cleanup1` → `001_cleanup`); after it, everything up to the first
 * digit, which starts the todo's number. `''` when no number follows
 * (`aaa_cleanup`, `001_cleanup`).
 */
export function todoIdPrefix(id: string): string {
    const m = /^([0-9]*)([^0-9]*)[0-9]/.exec(id);
    // A leading number names a group only together with the text after it.
    if (!m || (m[1] && !m[2])) { return ''; }
    return m[1] + m[2];
}

/**
 * The first index of a group's finalizers: a todo `<prefix>999` (or higher)
 * closes the group, so todos added to the group are numbered and placed before
 * it.
 */
export const FINALIZER_INDEX = 999;

/** The number after `prefix` in `id` (the digit run right after it), or undefined when `id` is not in that group. */
export function numberIn(id: string, prefix: string): number | undefined {
    if (todoIdPrefix(id) !== prefix || !prefix) { return undefined; }
    const m = /^[0-9]+/.exec(id.slice(prefix.length));
    return m ? Number(m[0]) : undefined;
}

export interface TodoPrefixOption {
    /** A group of the target quest, a prefix the user enters, or the ids kept. */
    kind: 'group' | 'custom' | 'keep';
    label: string;
    description: string;
    /** A group's prefix; null for "custom" (asked for next) and "keep". */
    prefix: string | null;
    /** The first number the moved todos get in a group; null otherwise. */
    next: number | null;
    /** How many todos of the target quest hold this prefix. */
    count: number;
}

/**
 * What a move into a quest may rename the todos to: each non-empty prefix
 * group of the quest's live todos (`liveIds`; default `targetIds`),
 * alphabetically, starting after its highest number among all the quest's
 * todos (`targetIds`, archived and deleted ones included, so no id is taken
 * twice) — then a prefix the user enters, then "keep the ids". A group only
 * archived or deleted todos hold is not offered: it can still be typed.
 */
export function todoPrefixChoices(targetIds: readonly string[], liveIds: readonly string[] = targetIds): TodoPrefixOption[] {
    const groups = new Map<string, { count: number; high: number }>();
    for (const id of liveIds) {
        const prefix = todoIdPrefix(id);
        if (!prefix) { continue; }
        const g = groups.get(prefix) ?? { count: 0, high: 0 };
        g.count++;
        groups.set(prefix, g);
    }
    for (const id of targetIds) {
        const prefix = todoIdPrefix(id);
        const g = groups.get(prefix);
        if (!g) { continue; }
        const n = numberIn(id, prefix) ?? 0;
        if (n < FINALIZER_INDEX) { g.high = Math.max(g.high, n); }
    }
    const options: TodoPrefixOption[] = [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([prefix, g]) => ({
            kind: 'group' as const,
            label: prefix,
            description: `${g.count} todo${g.count === 1 ? '' : 's'} — the moved ones become ${prefix}${g.high + 1}, ${prefix}${g.high + 2}, …`,
            prefix,
            next: g.high + 1,
            count: g.count,
        }));
    options.push({ kind: 'custom', label: 'Enter a prefix…', description: 'a new group, numbered from 1 (or after the highest of an existing one)', prefix: null, next: null, count: 0 });
    options.push({ kind: 'keep', label: 'Keep the ids as they are', description: '', prefix: null, next: null, count: 0 });
    return options;
}

/**
 * Why `input` cannot be a todo prefix, or undefined when it can. The prefix is
 * the group key ({@link todoIdPrefix}) — a leading number may open it
 * (`001_cleanup`), after that it holds no digit, since the todo's number
 * follows it; it is part of an id, so no whitespace or path characters either.
 */
export function validateTodoPrefix(input: string): string | undefined {
    const prefix = input.trim();
    if (!prefix) { return 'Enter a prefix, e.g. qrm.'; }
    // A leading number is part of a group's name (`001_cleanup`); after it, no digit: the todo's number follows the prefix.
    if (!/^[0-9]*[^0-9]+$/.test(prefix)) { return 'A prefix holds no digit after its leading number (as in 001_cleanup): the number follows it.'; }
    if (/\s/.test(prefix)) { return 'A prefix holds no space.'; }
    if (/[/\\:*?"<>|#]/.test(prefix)) { return 'A prefix holds no / \\ : * ? " < > | # character.'; }
    return undefined;
}

/** The renames a prefix gives, for the prompt: the first three, then the count. */
export function todoPrefixPreview(movingIds: readonly string[], targetIds: readonly string[], prefix: string): string {
    const pairs = [...todoRenames(movingIds, targetIds, prefix)].map(([from, to]) => `${from} → ${to}`);
    return pairs.length > 3 ? `${pairs.slice(0, 3).join(', ')}, … (${pairs.length} todos)` : pairs.join(', ');
}

/**
 * The new id of each moved todo when `prefix` is chosen (empty for "keep"):
 * the prefix with consecutive numbers after the highest the target quest's
 * group holds below its finalizers ({@link FINALIZER_INDEX}: `<prefix>999` and
 * higher are left after the added todos; a number the quest already has is
 * skipped), each id keeping the
 * tail after its own number (`vscannot3_ajtf-tools` → `annot10_ajtf-tools`);
 * an id without a number keeps itself as the tail (`plain` → `annot13-plain`).
 */
export function todoRenames(movingIds: readonly string[], targetIds: readonly string[], prefix: string | null): Map<string, string> {
    const renames = new Map<string, string>();
    if (!prefix) { return renames; }
    const taken = new Set(targetIds);
    let next = Math.max(0, ...targetIds.map((id) => numberIn(id, prefix) ?? 0).filter((n) => n < FINALIZER_INDEX)) + 1;
    for (const id of movingIds) {
        const digits = /[0-9]+/.exec(id);
        const tail = digits ? id.slice(digits.index + digits[0].length) : `-${id}`;
        let candidate = `${prefix}${next}${tail}`;
        while (taken.has(candidate) || [...taken].some((t) => numberIn(t, prefix) === next)) {
            next++;
            candidate = `${prefix}${next}${tail}`;
        }
        renames.set(id, candidate);
        taken.add(candidate);
        next++;
    }
    return renames;
}

/**
 * Whether a move asks how the moved todos are named: only when at least one of
 * them enters a quest it is not in. The workspace file has no groups to join,
 * and a move within a quest keeps its ids.
 */
export function todoMoveNeedsIdChoice(
    origins: readonly TodoMoveOrigin[],
    dest: { kind: 'quest'; questId: string } | { kind: 'workspace' },
): boolean {
    return dest.kind === 'quest' && origins.some((o) => o.questId !== dest.questId);
}

/** Whether some rename numbers a todo into the group's finalizer range (the group has no free number below it). */
export function renamesReachFinalizer(renames: ReadonlyMap<string, string>, prefix: string): boolean {
    return [...renames.values()].some((id) => (numberIn(id, prefix) ?? 0) >= FINALIZER_INDEX);
}

/**
 * Where a todo added to group `prefix` goes among the todos of one file
 * (`ids`, in file order): after the group's last todo numbered below its
 * finalizers, else before its first finalizer, else at the end.
 */
export function groupInsertIndex(ids: readonly string[], prefix: string): number {
    let last = -1;
    for (const [k, id] of ids.entries()) {
        const n = numberIn(id, prefix);
        if (n !== undefined && n < FINALIZER_INDEX) { last = k; }
    }
    if (last >= 0) { return last + 1; }
    const finalizer = ids.findIndex((id) => (numberIn(id, prefix) ?? -1) >= FINALIZER_INDEX);
    return finalizer >= 0 ? finalizer : ids.length;
}

/**
 * Why `input` cannot become the new id of todo `oldId`, or undefined when it
 * can (the ID edit of the todo panel): one word, not empty, and no other todo
 * of the quest (`taken`, archived and deleted ones included) has it.
 */
export function todoIdInputError(input: string, oldId: string, taken: ReadonlySet<string>): string | undefined {
    const id = input.trim();
    if (!id) { return 'Enter the new id.'; }
    if (/\s/.test(id)) { return 'A todo id is one word: no spaces.'; }
    if (/[/\\:*?"<>|#]/.test(id)) { return 'A todo id holds no / \\ : * ? " < > | # character.'; }
    if (id !== oldId && taken.has(id)) { return `The quest already has a todo ${id}.`; }
    return undefined;
}
