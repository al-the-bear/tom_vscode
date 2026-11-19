/**
 * The events of @TOM INFO › NOTIFICATIONS (vscimpb124): what agents, the user
 * and the extension do to queues and todos across the windows of this machine.
 *
 * The queue and todo types: an item queued or deleted (a queue item of any
 * run), a todo created, a todo updated (fields or text edited) and a todo
 * changed (its status changed). The user-directed types (vscimpb170, listed
 * in {@link USER_NOTIFICATION_TYPES}, shown again in USER NOTIFICATIONS):
 * something waits for the user (an ask, a picker, an MD Browser ask, a plan, a
 * tool approval) and its close, a tomAi_notifyUser message, an answer given
 * with tomAi_answerUser (vscimpb171, opened in the Answers page), suggested
 * subprocesses, a process decision waiting, a todo filed for the user
 * (decision-needed or a user action), the queue holding for the user. Each
 * event records when, the window (quest), the run, who (an agent — transport,
 * profile, session, the queue item and todo it was working on —, the user, or
 * the extension on its own) and what (the item, the todo with the fields
 * changed, or what the user is asked or told).
 *
 * The log keeps the events as they happened (services/notificationLog.ts);
 * the view merges them here: events of one type from the same source in the
 * same quest within 60 s of the group's first become one, listing its members.
 *
 * vscode-free and pure.
 */

export type NotificationType =
    | 'itemQueued' | 'itemDeleted' | 'todoCreated' | 'todoUpdated' | 'todoChanged'
    | 'askOpened' | 'askClosed' | 'userNotified' | 'answer' | 'subprocessSuggested' | 'decisionWaiting' | 'userTodo' | 'queueHolding';

/** Every type, in the order the view's toggles show them. */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
    'itemQueued', 'itemDeleted', 'todoCreated', 'todoUpdated', 'todoChanged',
    'askOpened', 'askClosed', 'userNotified', 'answer', 'subprocessSuggested', 'decisionWaiting', 'userTodo', 'queueHolding',
];

/** The types directed at the user (USER NOTIFICATIONS shows them; `askClosed` marks its ask answered there). */
export const USER_NOTIFICATION_TYPES: readonly NotificationType[] = ['askOpened', 'askClosed', 'userNotified', 'answer', 'subprocessSuggested', 'decisionWaiting', 'userTodo', 'queueHolding'];

/** A type's toggle label and codicon. */
export const NOTIFICATION_TYPE_INFO: Readonly<Record<NotificationType, { label: string; icon: string }>> = {
    itemQueued: { label: 'Queued', icon: 'add' },
    itemDeleted: { label: 'Deleted', icon: 'trash' },
    todoCreated: { label: 'Todo created', icon: 'new-file' },
    todoUpdated: { label: 'Todo edited', icon: 'edit' },
    todoChanged: { label: 'Status', icon: 'arrow-right' },
    askOpened: { label: 'Asks you', icon: 'comment-discussion' },
    askClosed: { label: 'Answered', icon: 'pass' },
    userNotified: { label: 'Tells you', icon: 'bell-dot' },
    answer: { label: 'Answers you', icon: 'comment' },
    subprocessSuggested: { label: 'Suggests', icon: 'type-hierarchy-sub' },
    decisionWaiting: { label: 'Decision', icon: 'git-compare' },
    userTodo: { label: 'Todo for you', icon: 'person' },
    queueHolding: { label: 'Queue holds', icon: 'debug-pause' },
};

/** What kind of thing waits for the user (an `askOpened` / `askClosed` event). */
export type UserAskKind = 'question' | 'picker' | 'mdBrowser' | 'plan' | 'approval';

/** What a user-directed event is about. */
export interface NotificationUser {
    /** An ask: what kind; the other types: their own kind (e.g. a todo's `decision-needed` / `user action`). */
    kind?: string;
    /** Pairs an `askClosed` with its `askOpened` (the interaction's id); unique per ask. An `answer`: the answer's id in the store. */
    key?: string;
    /** One line. */
    title: string;
    /** What it asks or says: the questions with their choices, the items, the document, the message, the plan. */
    details?: string[];
    /** An `askClosed`: how it was settled (the answer, the choice, or why it closed). */
    outcome?: string;
    /** `tomAi_notifyUser`: its urgency and channel. */
    urgency?: string;
    channel?: string;
    /** The session and queue item whose turn it is, when known. */
    session?: string;
    queueItemId?: string;
}

/** Who did it. */
export interface NotificationWho {
    kind: 'agent' | 'user' | 'extension';
    /** An agent's transport (anthropic, mcp, copilot, …). */
    transport?: string;
    profile?: string;
    session?: string;
    /** The queue item whose turn did it. */
    queueItemId?: string;
    /** The todo that item works on (`<quest>/<id>`). */
    todo?: string;
    /** The quest an inbox item came from. */
    fromQuest?: string;
    /** What the extension did it for (e.g. "blocked todos follow their blockers"). */
    label?: string;
}

/** A queue item an event names. */
export interface NotificationItem {
    id: string;
    run: string;
    /** normal / timed / reminder / process-move marker / … */
    kind: string;
    preview: string;
}

/** A field a todo event changed: old → new, as one-line previews. */
export interface NotificationField {
    field: string;
    old?: string;
    new?: string;
}

/** A todo an event names. */
export interface NotificationTodo {
    id: string;
    title?: string;
    quest: string;
    fields: NotificationField[];
}

/** One event, as the log stores it. */
export interface NotificationEvent {
    id: string;
    type: NotificationType;
    /** ISO time. */
    at: string;
    windowId: string;
    /** The window's quest. */
    quest: string;
    run: string;
    who: NotificationWho;
    item?: NotificationItem;
    todo?: NotificationTodo;
    /** A user-directed event: what the user is asked or told. */
    user?: NotificationUser;
}

/** Events merged for the view: one or more of one type, source and quest. */
export interface NotificationGroup {
    /** The first member's id. */
    id: string;
    type: NotificationType;
    /** The quest the group is about (the todo's, else the window's). */
    quest: string;
    who: NotificationWho;
    /** The first and the last member's time. */
    first: string;
    last: string;
    members: NotificationEvent[];
}

/** How far after a group's first event another one still joins it. */
export const GROUP_WINDOW_MS = 60_000;

/** The quest an event is about: the todo's, else the window's. */
export function eventQuest(e: NotificationEvent): string {
    return e.todo?.quest || e.quest;
}

/** Who did it, as one key: the same agent (transport, profile, session), the user, or the extension. */
export function sourceKey(who: NotificationWho): string {
    if (who.kind === 'agent') { return `agent|${who.transport ?? ''}|${who.profile ?? ''}|${who.session ?? ''}|${who.fromQuest ?? ''}`; }
    return who.kind === 'extension' ? `extension|${who.label ?? ''}` : 'user';
}

/** Who did it, in a line: the agent's session (else transport), `you`, or the extension. */
export function whoLabel(who: NotificationWho): string {
    if (who.kind === 'user') { return 'you'; }
    if (who.kind === 'extension') { return who.label ? `the extension (${who.label})` : 'the extension'; }
    if (who.fromQuest) { return `${who.session || who.transport || 'an agent'} of ${who.fromQuest}`; }
    return who.session || who.transport || 'an agent';
}

/**
 * Merge the events, oldest first, into groups: one type, one source, one
 * quest, each event within {@link GROUP_WINDOW_MS} of the group's first.
 * The answer is newest first.
 */
export function groupNotifications(events: readonly NotificationEvent[], windowMs = GROUP_WINDOW_MS): NotificationGroup[] {
    const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const groups: NotificationGroup[] = [];
    const open = new Map<string, NotificationGroup>();
    for (const e of sorted) {
        const key = `${e.type}|${eventQuest(e)}|${sourceKey(e.who)}`;
        const g = open.get(key);
        if (g && Date.parse(e.at) - Date.parse(g.first) <= windowMs) {
            g.members.push(e);
            g.last = e.at;
            continue;
        }
        const fresh: NotificationGroup = { id: e.id, type: e.type, quest: eventQuest(e), who: e.who, first: e.at, last: e.at, members: [e] };
        open.set(key, fresh);
        groups.push(fresh);
    }
    return groups.sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

/** The view's filters (per window). */
export interface NotificationFilters {
    /** The windows shown; empty: every window. */
    windows: string[];
    /** The types shown; absent: every type. */
    types?: NotificationType[];
    /** Events before this ISO time are hidden (Clear). */
    clearedAt?: string;
}

/** The events the filters let through. */
export function filterNotifications(events: readonly NotificationEvent[], f: NotificationFilters): NotificationEvent[] {
    const types = new Set(f.types ?? NOTIFICATION_TYPES);
    const windows = new Set(f.windows);
    const cleared = f.clearedAt ? Date.parse(f.clearedAt) : NaN;
    return events.filter((e) => types.has(e.type)
        && (windows.size === 0 || windows.has(e.windowId))
        && !(Number.isFinite(cleared) && Date.parse(e.at) <= cleared));
}

/** The windows the events name, newest first, each with its quest: the window filter's choices. */
export function notificationWindows(events: readonly NotificationEvent[]): Array<{ windowId: string; quest: string }> {
    const seen = new Map<string, { windowId: string; quest: string; at: number }>();
    for (const e of events) {
        const at = Date.parse(e.at);
        const known = seen.get(e.windowId);
        if (!known || at > known.at) { seen.set(e.windowId, { windowId: e.windowId, quest: e.quest, at }); }
    }
    return [...seen.values()].sort((a, b) => b.at - a.at).map(({ windowId, quest }) => ({ windowId, quest }));
}

const NOUN: Record<NotificationType, [string, string, string]> = {
    itemQueued: ['item', 'items', 'queued'],
    itemDeleted: ['item', 'items', 'deleted'],
    todoCreated: ['todo', 'todos', 'created'],
    todoUpdated: ['todo', 'todos', 'edited'],
    todoChanged: ['todo', 'todos', 'changed'],
    askOpened: ['ask', 'asks', 'opened'],
    askClosed: ['ask', 'asks', 'answered'],
    userNotified: ['message', 'messages', 'sent'],
    answer: ['answer', 'answers', 'given'],
    subprocessSuggested: ['suggestion', 'suggestions', 'made'],
    decisionWaiting: ['decision', 'decisions', 'waiting'],
    userTodo: ['todo for you', 'todos for you', 'filed'],
    queueHolding: ['queue hold', 'queue holds', 'reported'],
};

/** The verb of a user-directed event's line. */
const USER_VERB: Partial<Record<NotificationType, string>> = {
    askOpened: 'waits for you',
    askClosed: 'answered',
    userNotified: 'tells you',
    answer: 'answers you',
    subprocessSuggested: 'suggested',
    decisionWaiting: 'decision waits',
    userTodo: 'todo for you',
    queueHolding: 'queue holds',
};

/** One event's short text. */
export function eventText(e: NotificationEvent): string {
    if (e.user) {
        const outcome = e.type === 'askClosed' && e.user.outcome ? ` — ${previewValue(e.user.outcome, 60)}` : '';
        return `${USER_VERB[e.type] ?? e.type}: ${e.user.title}${outcome} · ${e.run}`;
    }
    if (e.item) {
        return `${e.type === 'itemQueued' ? 'queued' : 'deleted'} ${e.item.kind === 'normal' ? '' : `${e.item.kind} `}"${e.item.preview}" · ${e.item.run}`;
    }
    const t = e.todo;
    if (!t) { return e.type; }
    if (e.type === 'todoCreated') { return `todo ${t.id} created · ${t.quest}`; }
    if (e.type === 'todoChanged') {
        const status = t.fields.find((f) => f.field === 'status');
        return `todo ${t.id} → ${status?.new ?? '?'} · ${t.quest}`;
    }
    return `todo ${t.id} edited (${t.fields.map((f) => f.field).join(', ') || 'no field'}) · ${t.quest}`;
}

/** A group's line: the event's text, or "5 todos created by default@another · vscode_extension". */
export function groupLine(g: NotificationGroup): string {
    if (g.members.length === 1) { return eventText(g.members[0]); }
    const [, plural, verb] = NOUN[g.type];
    if (g.type === 'todoChanged') {
        const to = [...new Set(g.members.map((m) => m.todo?.fields.find((f) => f.field === 'status')?.new).filter(Boolean))];
        return `${g.members.length} ${plural} → ${to.join(' / ')} by ${whoLabel(g.who)} · ${g.quest}`;
    }
    return `${g.members.length} ${plural} ${verb} by ${whoLabel(g.who)} · ${g.quest}`;
}

/** A group's details: who, what agent, working on what, the fields, the members. */
export function groupDetails(g: NotificationGroup): string[] {
    const lines: string[] = [];
    const w = g.who;
    lines.push(`Who: ${w.kind === 'agent' ? 'an agent' : w.kind === 'user' ? 'you (the UI)' : whoLabel(w)}`);
    if (w.kind === 'agent') {
        const agent = [w.transport && `transport ${w.transport}`, w.profile && `profile ${w.profile}`, w.session && `session ${w.session}`].filter(Boolean).join(', ');
        if (agent) { lines.push(`Agent: ${agent}`); }
        if (w.fromQuest) { lines.push(`Sent from quest ${w.fromQuest}`); }
        const on = [w.queueItemId && `queue item ${w.queueItemId}`, w.todo && `todo ${w.todo}`].filter(Boolean).join(', ');
        if (on) { lines.push(`Working on: ${on}`); }
    }
    const first = g.members[0];
    lines.push(`Window: ${first.quest || first.windowId} · run ${first.run}`);
    lines.push(g.first === g.last ? `When: ${g.first}` : `When: ${g.first} … ${g.last}`);
    for (const m of g.members) {
        if (g.members.length > 1) { lines.push(`• ${eventText(m)}`); }
        if (m.user) {
            const pad = g.members.length > 1 ? '  ' : '';
            if (m.user.kind) { lines.push(`${pad}Kind: ${m.user.kind}`); }
            for (const d of m.user.details ?? []) { lines.push(`${pad}${d}`); }
            if (m.user.outcome) { lines.push(`${pad}Outcome: ${m.user.outcome}`); }
            if (m.user.urgency || m.user.channel) { lines.push(`${pad}${[m.user.urgency && `urgency ${m.user.urgency}`, m.user.channel && `channel ${m.user.channel}`].filter(Boolean).join(', ')}`); }
        }
        if (m.item) { lines.push(`${g.members.length > 1 ? '  ' : ''}Item ${m.item.id} (${m.item.kind}, run ${m.item.run})`); }
        if (m.todo) {
            if (m.todo.title) { lines.push(`${g.members.length > 1 ? '  ' : ''}Todo ${m.todo.id}: ${m.todo.title}`); }
            for (const f of m.todo.fields) {
                lines.push(`${g.members.length > 1 ? '    ' : '  '}${f.field}: ${f.old === undefined ? '—' : f.old} → ${f.new === undefined ? '—' : f.new}`);
            }
        }
    }
    return lines;
}

/** A value as one short line (texts cut at 80 characters). */
export function previewValue(value: unknown, max = 80): string | undefined {
    if (value === undefined || value === null || value === '') { return undefined; }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Fields of a todo record no change is reported for (and every `_`-prefixed bookkeeping key, e.g. `_extra`, `_sourceFile`). */
const NOT_A_CHANGE = new Set(['updated', 'blocking']);

/** The fields that differ between two records of a todo, old → new. */
export function changedTodoFields(before: Record<string, unknown>, after: Record<string, unknown>): NotificationField[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !NOT_A_CHANGE.has(k) && !k.startsWith('_')).sort();
    const out: NotificationField[] = [];
    for (const k of keys) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) { continue; }
        const old = previewValue(before[k]);
        const now = previewValue(after[k]);
        out.push({ field: k, ...(old !== undefined ? { old } : {}), ...(now !== undefined ? { new: now } : {}) });
    }
    return out;
}

/** The type of a todo update: a status change, else an edit; none when nothing changed. */
export function todoUpdateType(fields: readonly NotificationField[]): 'todoChanged' | 'todoUpdated' | undefined {
    if (!fields.length) { return undefined; }
    return fields.some((f) => f.field === 'status') ? 'todoChanged' : 'todoUpdated';
}
