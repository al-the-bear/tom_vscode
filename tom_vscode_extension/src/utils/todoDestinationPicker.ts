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
    | { kind: 'pickQuest' };

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
 * grouping.js `qtTodoPrefix`): everything before the first digit; `''` when the
 * id starts with a digit or has none.
 */
export function todoIdPrefix(id: string): string {
    const m = /[0-9]/.exec(id);
    return m ? id.slice(0, m.index) : '';
}

/** The number after `prefix` in `id` (its first digit run), or undefined when `id` is not in that group. */
function numberIn(id: string, prefix: string): number | undefined {
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
 * What a move into a quest may rename the todos to: each prefix group of the
 * quest's todos (`targetIds`), largest first, starting after its highest
 * number — then a prefix the user enters, then "keep the ids".
 */
export function todoPrefixChoices(targetIds: readonly string[]): TodoPrefixOption[] {
    const groups = new Map<string, { count: number; high: number }>();
    for (const id of targetIds) {
        const prefix = todoIdPrefix(id);
        if (!prefix) { continue; }
        const g = groups.get(prefix) ?? { count: 0, high: 0 };
        g.count++;
        g.high = Math.max(g.high, numberIn(id, prefix) ?? 0);
        groups.set(prefix, g);
    }
    const options: TodoPrefixOption[] = [...groups.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
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
 * the group key — everything before an id's first digit — so it holds no
 * digit; it is part of an id, so no whitespace or path characters either.
 */
export function validateTodoPrefix(input: string): string | undefined {
    const prefix = input.trim();
    if (!prefix) { return 'Enter a prefix, e.g. qrm.'; }
    if (/[0-9]/.test(prefix)) { return 'A prefix holds no digit: the number follows it.'; }
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
 * group holds (a number the quest already has is skipped), each id keeping the
 * tail after its own number (`vscannot3_ajtf-tools` → `annot10_ajtf-tools`);
 * an id without a number keeps itself as the tail (`plain` → `annot13-plain`).
 */
export function todoRenames(movingIds: readonly string[], targetIds: readonly string[], prefix: string | null): Map<string, string> {
    const renames = new Map<string, string>();
    if (!prefix) { return renames; }
    const taken = new Set(targetIds);
    let next = Math.max(0, ...targetIds.map((id) => numberIn(id, prefix) ?? 0)) + 1;
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
