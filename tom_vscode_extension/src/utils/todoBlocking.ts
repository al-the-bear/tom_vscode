/**
 * `blocking`, the reverse of `blocked_by`: the rules, no IO.
 *
 * A todo's `blocking` lists the LIVE todos whose `blocked_by` names it, so the
 * relation can be read from either end. It is derived, never set by hand:
 * after every write of a todo file the sync (managers/todoBlockingSync.ts)
 * recomputes it for the todos the write can have affected.
 *
 * Where a todo lives — its SCOPE — decides how it is named:
 *   - a quest: every live `*.todo.yaml` in `_ai/quests/<quest>/` (the quest
 *     file, topic files, session files). Inside the quest a todo is its bare
 *     id; from elsewhere it is `<quest>/<id>`.
 *   - any other todo file (a `workspace.todo.yaml`): that file alone. Its
 *     todos are named by bare id inside it and cannot be named from outside.
 * Terminal siblings (`-archived` / `-deleted`) are not live: a todo in one
 * neither blocks nor is blocked, and those files are never rewritten.
 *
 * vscode-free.
 */

/** A todo as the sync sees it: where it lives, and both ends of the relation. */
export interface TodoRelationRecord {
    /** `quest:<quest>` or `file:<absolute path>`. */
    scopeKey: string;
    /** The quest, for a quest scope. */
    quest?: string;
    id: string;
    blockedBy: string[];
    blocking: string[];
}

export interface TodoScope {
    scopeKey: string;
    quest?: string;
}

/** A todo's place: its scope and its id. */
export interface TodoAddress {
    scopeKey: string;
    id: string;
}

/** Key of an address in maps and sets. */
export function addressKey(address: TodoAddress): string {
    return `${address.scopeKey}\u0000${address.id}`;
}

/**
 * The scope of the todo file at `filePath`: its quest when it lies directly in
 * `<questsRoot>/<quest>/`, else the file itself. Paths use `/` or the
 * platform's separator.
 */
export function todoScopeOf(filePath: string, questsRoot: string): TodoScope {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const file = norm(filePath);
    const root = norm(questsRoot);
    if (root && file.startsWith(root + '/')) {
        const rest = file.slice(root.length + 1).split('/');
        if (rest.length === 2 && rest[0]) {
            return { scopeKey: `quest:${rest[0]}`, quest: rest[0] };
        }
    }
    return { scopeKey: `file:${file}` };
}

/** What a `blocked_by` entry written in scope `from` names. */
export function resolveTodoRef(ref: string, from: TodoScope): TodoAddress | undefined {
    const value = ref.trim();
    if (!value) { return undefined; }
    const slash = value.indexOf('/');
    if (slash < 0) { return { scopeKey: from.scopeKey, id: value }; }
    const quest = value.slice(0, slash);
    const id = value.slice(slash + 1);
    if (!quest || !id || id.includes('/')) { return undefined; }
    return { scopeKey: `quest:${quest}`, id };
}

/**
 * How `blocker` is named in the `blocking` list of a todo in `targetScopeKey`:
 * its bare id in the same scope, `<quest>/<id>` from another; nothing when it
 * lives in a file scope (no other scope can name it).
 */
export function blockingRefFor(blocker: TodoRelationRecord, targetScopeKey: string): string | undefined {
    if (blocker.scopeKey === targetScopeKey) { return blocker.id; }
    return blocker.quest ? `${blocker.quest}/${blocker.id}` : undefined;
}

/**
 * The `blocking` list `target` should carry: every live todo in `records`
 * whose `blocked_by` names it, sorted and without repeats.
 */
export function expectedBlocking(target: TodoAddress, records: readonly TodoRelationRecord[]): string[] {
    const refs = new Set<string>();
    const key = addressKey(target);
    for (const r of records) {
        for (const ref of r.blockedBy) {
            const named = resolveTodoRef(ref, r);
            if (!named || addressKey(named) !== key) { continue; }
            const name = blockingRefFor(r, target.scopeKey);
            if (name) { refs.add(name); }
        }
    }
    return [...refs].sort();
}

/** Do two lists hold the same refs, in any order? */
export function sameRefs(a: readonly string[], b: readonly string[]): boolean {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) { return false; }
    for (const x of sa) { if (!sb.has(x)) { return false; } }
    return true;
}

/**
 * The todos whose `blocking` a write can have changed: those named by any
 * `blocked_by` of the written file, before or after the write (a ref added,
 * removed, or a blocker that left the file), and the file's own todos (a todo
 * that arrived by a move brings the `blocking` of its old place). A terminal
 * file's own todos are left out (`ownTodos: false`): they are never rewritten.
 */
export function affectedByWrite(
    before: readonly TodoRelationRecord[],
    after: readonly TodoRelationRecord[],
    ownTodos = true,
): TodoAddress[] {
    const out = new Map<string, TodoAddress>();
    const add = (a: TodoAddress | undefined) => { if (a) { out.set(addressKey(a), a); } };
    for (const r of [...before, ...after]) {
        for (const ref of r.blockedBy) { add(resolveTodoRef(ref, r)); }
    }
    if (ownTodos) {
        for (const r of after) { add({ scopeKey: r.scopeKey, id: r.id }); }
    }
    return [...out.values()];
}
