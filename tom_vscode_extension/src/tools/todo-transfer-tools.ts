/**
 * tomAi_transferTodos — move todos between levels: out of any todo file of a
 * quest (its own file, a topic file, the session file, an archive) or out of
 * `workspace.todo.yaml`, into a quest's own todo file (the same quest or
 * another one) or into `workspace.todo.yaml`. The tool behind the todo
 * panels' "Move to…" picker; `tomAi_moveQuestTodo` stays the tool for moving
 * between two files of one quest.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import type { TodoMoveDestination, TodoTransferResult } from '../managers/questTodoManager';

export interface TransferTodosInput {
    todoIds: string[];
    /** The quest whose folder holds the todos. Exactly one of sourceQuestId / fromWorkspace. */
    sourceQuestId?: string;
    /** A file name in the source quest's folder; default: whichever of its todo files holds each id. */
    sourceFile?: string;
    /** The todos are in workspace.todo.yaml. */
    fromWorkspace?: boolean;
    /** Move into `todos.<targetQuestId>.todo.yaml`. Exactly one of targetQuestId / toWorkspace. */
    targetQuestId?: string;
    /** Move into workspace.todo.yaml. */
    toWorkspace?: boolean;
}

/** What the tool needs from the todo store; the live one is questTodoManager. */
export interface TransferTodosDeps {
    questExists(questId: string): boolean;
    questTodoSourcePath(questId: string, todoId: string, sourceFile?: string): string | undefined;
    workspaceTodoPath(): string | undefined;
    move(sourcePath: string, todoId: string, dest: TodoMoveDestination, origin?: string): TodoTransferResult;
    onMutate?(): void;
}

const fail = (error: string): string => JSON.stringify({ ok: false, error });

export async function transferTodosImpl(deps: TransferTodosDeps, input: TransferTodosInput): Promise<string> {
    const ids = Array.isArray(input.todoIds) ? input.todoIds.filter((id) => typeof id === 'string' && id.trim()) : [];
    if (ids.length === 0) { return fail('`todoIds` must name at least one todo.'); }
    if (!!input.sourceQuestId === !!input.fromWorkspace) {
        return fail('Give exactly one source: `sourceQuestId` (a quest folder) or `fromWorkspace: true` (workspace.todo.yaml).');
    }
    if (!!input.targetQuestId === !!input.toWorkspace) {
        return fail('Give exactly one target: `targetQuestId` (that quest\'s todos.<quest>.todo.yaml) or `toWorkspace: true`.');
    }
    for (const q of [input.sourceQuestId, input.targetQuestId]) {
        if (q && !deps.questExists(q)) { return fail(`No quest "${q}" (no _ai/quests/${q}/ folder). tomAi_listQuests lists them.`); }
    }
    if (input.fromWorkspace && input.sourceFile) {
        return fail('`sourceFile` names a file in the source quest\'s folder; it does not apply with `fromWorkspace`.');
    }
    const dest: TodoMoveDestination = input.targetQuestId ? { kind: 'quest', questId: input.targetQuestId } : { kind: 'workspace' };
    const origin = input.sourceQuestId ? `quest: ${input.sourceQuestId}` : 'workspace';

    const moved: Array<{ id: string; to: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
        const source = input.sourceQuestId
            ? deps.questTodoSourcePath(input.sourceQuestId, id, input.sourceFile)
            : deps.workspaceTodoPath();
        if (!source) {
            skipped.push({ id, reason: `not found in ${input.sourceFile ?? `quest ${input.sourceQuestId}`}` });
            continue;
        }
        try {
            const r = deps.move(source, id, dest, origin);
            if (r.ok) { moved.push({ id, to: r.targetPath }); } else { skipped.push({ id, reason: r.reason }); }
        } catch (e) {
            skipped.push({ id, reason: (e as Error).message });
        }
    }
    if (moved.length) { deps.onMutate?.(); }
    return JSON.stringify({
        ok: moved.length > 0,
        target: dest.kind === 'quest' ? `todos.${dest.questId}.todo.yaml` : 'workspace.todo.yaml',
        moved: moved.map((m) => m.id),
        ...(skipped.length ? { skipped } : {}),
    });
}

export const TRANSFER_TODOS_DESCRIPTION =
    'Move todos between levels: from a quest\'s todo files (its own file, a topic file, the session file '
    + '`session-todo.<host>.<quest>.todo.yaml`, or an archived sibling) or from `workspace.todo.yaml`, into a quest\'s own '
    + 'todo file `todos.<quest>.todo.yaml` (the same quest or ANOTHER one) or into `workspace.todo.yaml`. Give exactly one '
    + 'source (`sourceQuestId`, optionally `sourceFile`; or `fromWorkspace: true`) and exactly one target (`targetQuestId` '
    + 'or `toWorkspace: true`). Every field travels; a todo that leaves its quest gets `[moved from quest: <id>]` in its '
    + 'notes. Per id, refused with a reason and nothing written: an id not in the source, a target that is the source '
    + 'file, a target already holding that id. Answers `{ok, target, moved, skipped?}`. To move between two files of '
    + 'ONE quest use tomAi_moveQuestTodo.';

export const TRANSFER_TODOS_TOOL: SharedToolDefinition<TransferTodosInput> = {
    name: 'tomAi_transferTodos',
    displayName: 'Transfer Todos (quest / workspace)',
    description: TRANSFER_TODOS_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['todoIds'],
        properties: {
            todoIds: { type: 'array', items: { type: 'string' }, description: 'The todo ids to move.' },
            sourceQuestId: { type: 'string', description: 'The quest whose folder holds the todos.' },
            sourceFile: { type: 'string', description: 'A todo file in that quest folder; default: whichever holds each id.' },
            fromWorkspace: { type: 'boolean', description: 'The todos are in workspace.todo.yaml.' },
            targetQuestId: { type: 'string', description: 'Move into this quest\'s todos.<quest>.todo.yaml.' },
            toWorkspace: { type: 'boolean', description: 'Move into workspace.todo.yaml.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by chat-enhancement-tools.ts"}',
};
