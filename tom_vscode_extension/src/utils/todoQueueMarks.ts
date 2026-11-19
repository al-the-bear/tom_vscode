/**
 * Which todos the prompt queue will run, and from which queue items.
 *
 * A queue item that runs todos carries a todo id pattern (`todoIdPattern`): a
 * todo's id when one todo was queued, `<prefix>*` for a todo-group walk, or
 * several of these separated by commas. A todo is queued while an item that
 * has not finished names it: an exact id names that todo whatever its status; a
 * `<prefix>*` names the open todos (not completed, not cancelled) whose id
 * starts with the prefix — the ones the walk will reach.
 *
 * The todo panel marks those todos; the mark names the queue items by the
 * number the queue editor shows them with (`#1`, `#2`, …) and their run: the
 * editor has one tab per process run, and an item's number is its position in
 * its run's list, which orders by status (statusSortRank in
 * media/shared/queueEntryUtils.js), then queue order, the finished ones newest
 * first. The numbers change as the queue moves on (an item finishing moves the
 * ones behind it up); the todo panel is told and shows them anew.
 *
 * vscode-free.
 */

/** What this module reads of a queue item. */
export interface QueueItemForMarks {
    id: string;
    status: string;
    createdAt?: string;
    repeatCount?: number | string;
    todoIdPattern?: string;
    /** The process run the item belongs to (its queue editor tab); unset: its Proceed's, else `default`. */
    run?: string;
    processRun?: { run?: string };
}

/** The run tab an item shows in (tabRunOf in media/queueEditor/main.js). */
export function queueItemRun(item: Pick<QueueItemForMarks, 'run' | 'processRun'>): string {
    return item.run || item.processRun?.run || 'default';
}

/** One queue item that will run a todo: its number in its run's list and the run. */
export interface TodoQueueMarkEntry { number: number; run: string }

/** What this module reads of a todo. */
export interface TodoForMarks {
    id: string;
    status?: string;
}

/** A queued todo: the numbers of the queue items that will run it, in queue order. */
export type TodoQueueMarks = Map<string, number[]>;

/** Queue item statuses that are done: their todos are not queued by them any more. */
const FINISHED = new Set(['sent', 'chat', 'chat-sent']);

/** Todo statuses a group walk passes over. */
const CLOSED_TODO = new Set(['completed', 'cancelled']);

/** The walk prefix of a repeat count `<prefix>*`, else undefined. */
function walkPattern(repeatCount: number | string | undefined): string | undefined {
    if (typeof repeatCount !== 'string') { return undefined; }
    const t = repeatCount.trim();
    return t.length > 1 && t.endsWith('*') ? t : undefined;
}

/**
 * The todo id pattern of an item: its own `todoIdPattern`, else the walk its
 * repeat count names (`<prefix>*`), else undefined.
 */
export function todoIdPatternOf(item: Pick<QueueItemForMarks, 'repeatCount' | 'todoIdPattern'>): string | undefined {
    const own = item.todoIdPattern?.trim();
    return own ? own : walkPattern(item.repeatCount);
}

/** Whether `pattern` names the todo (`id`, `status`). */
export function todoIdPatternMatches(pattern: string, todo: TodoForMarks): boolean {
    return pattern.split(',').map((p) => p.trim()).filter(Boolean).some((p) => {
        if (p.endsWith('*')) {
            return todo.id.startsWith(p.slice(0, -1)) && !CLOSED_TODO.has(todo.status ?? '');
        }
        return todo.id === p;
    });
}

/**
 * The status rank the queue editor sorts by (statusSortRank in
 * media/shared/queueEntryUtils.js; QM-3 holds the two equal).
 */
export function statusSortRank(status: string): number {
    switch (status) {
        case 'decision-needed':
        case 'todo-blocked': return 0;
        case 'error': return 1;
        case 'retry': return 2;
        case 'waiting': return 3;
        case 'interrupted': return 4;
        case 'sending':
        case 'chat': return 5;
        case 'pending': return 6;
        case 'staged': return 7;
        case 'sent':
        case 'chat-sent': return 8;
        default: return 9;
    }
}

/** Each item's number in its run's list of the queue editor (`#1` first in every run tab), by id. */
export function queueDisplayNumbers(items: readonly QueueItemForMarks[]): Map<string, number> {
    const done = statusSortRank('sent');
    const out = new Map<string, number>();
    const runs = [...new Set(items.map(queueItemRun))];
    for (const run of runs) {
        const order = items
            .map((item, idx) => ({ item, idx }))
            .filter((x) => queueItemRun(x.item) === run)
            .sort((a, b) => {
                const ra = statusSortRank(a.item.status || 'staged');
                const rb = statusSortRank(b.item.status || 'staged');
                if (ra !== rb) { return ra - rb; }
                if (ra === done) { return new Date(b.item.createdAt || 0).getTime() - new Date(a.item.createdAt || 0).getTime(); }
                return a.idx - b.idx;
            });
        order.forEach((x, k) => out.set(x.item.id, k + 1));
    }
    return out;
}

/** The unfinished items that name todos: each item's pattern, number and run, in queue order. */
export function queuedTodoPatterns(items: readonly QueueItemForMarks[]): Array<{ pattern: string; number: number; run: string }> {
    const numbers = queueDisplayNumbers(items);
    return items
        .filter((i) => !FINISHED.has(i.status))
        .map((i) => ({ pattern: todoIdPatternOf(i), number: numbers.get(i.id) ?? 0, run: queueItemRun(i) }))
        .filter((x): x is { pattern: string; number: number; run: string } => !!x.pattern);
}

/**
 * The queued todos among `todos`: each with the numbers of the unfinished
 * items that name it, ascending. `walks: false` (todos of another quest than
 * the queue's: a walk only walks its own quest) counts exact ids only.
 */
export function todoQueueMarks(items: readonly QueueItemForMarks[], todos: readonly TodoForMarks[], opts: { walks?: boolean } = {}): TodoQueueMarks {
    const marks: TodoQueueMarks = new Map();
    for (const [id, entries] of todoQueueMarkEntries(items, todos, opts)) { marks.set(id, entries.map((e) => e.number)); }
    return marks;
}

/**
 * The same with each item's run: the default run's items first, then the
 * others by run name, each by number.
 */
export function todoQueueMarkEntries(items: readonly QueueItemForMarks[], todos: readonly TodoForMarks[], opts: { walks?: boolean } = {}): Map<string, TodoQueueMarkEntry[]> {
    const walks = opts.walks !== false;
    const naming = queuedTodoPatterns(items)
        .map((x) => ({ ...x, pattern: walks ? x.pattern : x.pattern.split(',').map((p) => p.trim()).filter((p) => p && !p.endsWith('*')).join(',') }))
        .filter((x) => x.pattern);
    const marks = new Map<string, TodoQueueMarkEntry[]>();
    if (naming.length === 0) { return marks; }
    const runOrder = (run: string): string => (run === 'default' ? '' : run);
    for (const todo of todos) {
        const by = naming.filter((x) => todoIdPatternMatches(x.pattern, todo))
            .map((x) => ({ number: x.number, run: x.run }))
            .sort((a, b) => runOrder(a.run).localeCompare(runOrder(b.run)) || a.number - b.number);
        if (by.length) { marks.set(todo.id, by); }
    }
    return marks;
}

/** An entry as the mark writes it: `#2`, or `#2 (run chg1)` outside the default run. */
export function todoQueueMarkLabel(entry: TodoQueueMarkEntry): string {
    return entry.run === 'default' ? `#${entry.number}` : `#${entry.number} (run ${entry.run})`;
}

/** The mark's tooltip: `Queued: #2` or `Queued: #2 (first), #5`. */
export function todoQueueMarkTitle(numbers: ReadonlyArray<number | TodoQueueMarkEntry>): string {
    const labels = numbers.map((n) => (typeof n === 'number' ? `#${n}` : todoQueueMarkLabel(n)));
    if (labels.length === 1) { return `Queued: ${labels[0]}`; }
    return `Queued: ${labels[0]} (first), ${labels.slice(1).join(', ')}`;
}
