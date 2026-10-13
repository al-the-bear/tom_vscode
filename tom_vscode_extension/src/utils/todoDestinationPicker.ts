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
