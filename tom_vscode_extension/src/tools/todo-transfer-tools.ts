/**
 * tomAi_transferTodos — move todos between levels: out of any todo file of a
 * quest (its own file, a topic file, the session file, an archive) or out of
 * `workspace.todo.yaml`, into a quest's own todo file (the same quest or
 * another one) or into `workspace.todo.yaml`. The tool behind the todo
 * panels' "Move to…" picker; `tomAi_moveQuestTodo` stays the tool for moving
 * between two files of one quest.
 *
 * tomAi_renameTodoPrefix — rename an id group of a quest in one step (the tool
 * behind the todo panel's "Rename group…" on a group separator).
 *
 * tomAi_renameQuestTodo — rename one todo (the tool behind the todo panel's ID
 * edit), optionally placing it at the end of an id group.
 */

import type { SharedToolDefinition } from './shared-tool-registry';
import type { TodoMoveDestination, TodoPrefixRenameResult, TodoRenameResult, TodoTransferResult } from '../managers/questTodoManager';

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

// ---------------------------------------------------------------------------
// tomAi_renameTodoPrefix — rename a todo group's prefix in one step
// ---------------------------------------------------------------------------

export interface RenameTodoPrefixInput {
    questId: string;
    /** The group's prefix: everything before the first digit of its ids. */
    from: string;
    /** The new prefix. */
    to: string;
    /** Answer the renames and the documents, write nothing. */
    dryRun?: boolean;
}

/** What the tool needs from the todo store; the live one is questTodoManager.renameTodoPrefix. */
export interface RenameTodoPrefixDeps {
    questExists(questId: string): boolean;
    renameTodoPrefix(questId: string, from: string, to: string, opts: { dryRun?: boolean }): TodoPrefixRenameResult;
    onMutate?(): void;
}

export async function renameTodoPrefixImpl(deps: RenameTodoPrefixDeps, input: RenameTodoPrefixInput): Promise<string> {
    const questId = typeof input.questId === 'string' ? input.questId.trim() : '';
    const from = typeof input.from === 'string' ? input.from.trim() : '';
    const to = typeof input.to === 'string' ? input.to : '';
    if (!questId) { return fail('`questId` names the quest.'); }
    if (!from) { return fail('`from` names the group\'s prefix (everything before the first digit of its ids).'); }
    if (!deps.questExists(questId)) { return fail(`No quest "${questId}" (no _ai/quests/${questId}/ folder). tomAi_listQuests lists them.`); }
    const r = deps.renameTodoPrefix(questId, from, to, { dryRun: input.dryRun === true });
    if (r.ok && !r.dryRun) { deps.onMutate?.(); }
    return JSON.stringify(r.ok ? r : { ok: false, error: r.reason, ...(r.collisions ? { collisions: r.collisions } : {}) });
}

export const RENAME_TODO_PREFIX_DESCRIPTION =
    'Rename a todo group\'s prefix in one step: every live todo of quest `questId` whose id prefix (everything before its '
    + 'first digit) is `from` becomes `<to><the rest of its id>` (`ww3_akfd-x` → `xx3_akfd-x`), in whichever live todo file '
    + 'it is. Every `blocked_by` / `dependencies` entry naming it follows — plain and `<quest>/<id>` in the quest, '
    + '`<quest>/<id>` in other quests; each old id keeps a cancelled stub naming the new id in the `-deleted` sibling of its '
    + 'file, so the `_ai` commit guard (an id may not vanish) accepts the change. Archived and deleted todos of the group '
    + 'stay as they are. Answers `{ok, dryRun, renames: [{from, to}], references, stubs, keptArchived, documents: [{file, '
    + 'count}]}` — `documents` are the quest\'s Markdown / YAML files still naming `<from><number>`, which are not rewritten. '
    + 'Refused, nothing written: a `to` that is no prefix (empty, holding a digit, a space or a path character), the same '
    + 'prefix, a group without live todos, new ids the quest already has (archived and deleted included; `collisions` '
    + 'lists them). `dryRun: true` answers the plan and writes nothing.';

export const RENAME_TODO_PREFIX_TOOL: SharedToolDefinition<RenameTodoPrefixInput> = {
    name: 'tomAi_renameTodoPrefix',
    displayName: 'Rename Todo Group Prefix',
    description: RENAME_TODO_PREFIX_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'from', 'to'],
        properties: {
            questId: { type: 'string', description: 'The quest whose todo group is renamed.' },
            from: { type: 'string', description: 'The group\'s prefix, e.g. `ww`.' },
            to: { type: 'string', description: 'The new prefix, e.g. `xx` (no digit, space or path character).' },
            dryRun: { type: 'boolean', description: 'Answer the renames and the documents naming the old prefix; write nothing. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by chat-enhancement-tools.ts"}',
};

// ---------------------------------------------------------------------------
// tomAi_renameQuestTodo — rename one quest todo
// ---------------------------------------------------------------------------

export interface RenameQuestTodoInput {
    questId: string;
    /** The todo's id now. */
    todoId: string;
    /** Its new id. */
    newId: string;
    /** An id group (prefix) to place it at the end of, before the group's finalizers. */
    group?: string;
    /** Check and count, write nothing. */
    dryRun?: boolean;
}

/** What the tool needs from the todo store; the live one is questTodoManager.renameQuestTodo. */
export interface RenameQuestTodoDeps {
    questExists(questId: string): boolean;
    renameQuestTodo(questId: string, oldId: string, newId: string, opts: { group?: string; dryRun?: boolean }): TodoRenameResult;
    onMutate?(): void;
}

export async function renameQuestTodoImpl(deps: RenameQuestTodoDeps, input: RenameQuestTodoInput): Promise<string> {
    const questId = typeof input.questId === 'string' ? input.questId.trim() : '';
    const todoId = typeof input.todoId === 'string' ? input.todoId.trim() : '';
    const newId = typeof input.newId === 'string' ? input.newId.trim() : '';
    const group = typeof input.group === 'string' && input.group.trim() ? input.group.trim() : undefined;
    if (!questId) { return fail('`questId` names the quest.'); }
    if (!todoId) { return fail('`todoId` names the todo to rename.'); }
    if (!deps.questExists(questId)) { return fail(`No quest "${questId}" (no _ai/quests/${questId}/ folder). tomAi_listQuests lists them.`); }
    if (newId === todoId && !group) { return fail(`\`newId\` is ${todoId}'s own id: nothing to rename.`); }
    const r = deps.renameQuestTodo(questId, todoId, newId, { ...(group ? { group } : {}), dryRun: input.dryRun === true });
    if (!r.ok) { return fail(r.reason); }
    if (!r.dryRun) { deps.onMutate?.(); }
    return JSON.stringify({ ...r, from: todoId, to: newId, ...(group ? { group } : {}) });
}

export const RENAME_QUEST_TODO_DESCRIPTION =
    'Rename one todo of quest `questId`: `todoId` becomes `newId`, in its live todo file, with every field kept and '
    + '`[renamed from <old>]` added to its notes. Every `blocked_by` / `dependencies` entry naming it follows — plain and '
    + '`<quest>/<id>` in the quest, `<quest>/<id>` in other quests; the old id keeps a cancelled stub naming the new id in the '
    + '`-deleted` sibling of its file, so the `_ai` commit guard (an id may not vanish) accepts the change. `group` (a prefix) '
    + 'also moves it to the end of that id group, before the group\'s finalizers. Answers `{ok, dryRun, from, to, file, '
    + 'references, stubFile}`. Refused, nothing written: an unknown todo, a `newId` that is empty or holds a space or a / \\ : '
    + '* ? " < > | # character, an id the quest already has (archived and deleted included), its own id without `group`, a '
    + '`group` that is no prefix. `dryRun: true` checks the same and counts the references, writing nothing. A whole group: '
    + 'tomAi_renameTodoPrefix.';

export const RENAME_QUEST_TODO_TOOL: SharedToolDefinition<RenameQuestTodoInput> = {
    name: 'tomAi_renameQuestTodo',
    displayName: 'Rename Quest Todo',
    description: RENAME_QUEST_TODO_DESCRIPTION,
    tags: ['todo', 'quest', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        required: ['questId', 'todoId', 'newId'],
        properties: {
            questId: { type: 'string', description: 'The quest the todo belongs to.' },
            todoId: { type: 'string', description: 'The todo\'s id now.' },
            newId: { type: 'string', description: 'Its new id (one word; generate the date code with tomAi_generateIdPrefix).' },
            group: { type: 'string', description: 'An id group prefix, e.g. `vscimpb`: place the todo at the end of that group.' },
            dryRun: { type: 'boolean', description: 'Check the rename and count the references; write nothing. Default false.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by chat-enhancement-tools.ts"}',
};
