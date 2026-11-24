/**
 * @TOM INFO › USER NOTIFICATIONS (vscimpb170): everything an agent or the
 * extension directs at the user, read from the machine's notification log
 * (services/notificationLog.ts) — one row per event, never merged, newest
 * first. An ask (`askOpened`) is shown as open, with how long, until its
 * `askClosed` arrives; then as answered, with the answer or why it closed.
 *
 * A todo waiting for the user's decisions is one row too, whatever wrote it:
 * from the todo events every window writes (`todoCreated` with status
 * `decision-needed`, `todoChanged` into it) and the `userTodo` event of the
 * windows that emit one, merged. It is open until a later `todoChanged` takes
 * the todo out of `decision-needed`; then it is answered ("now not-started"),
 * and when a queue item was held at that todo (`queueHolding`, kind
 * `decision-needed`, naming the todo) it offers to continue that run.
 *
 * Dismissing a row hides it here only: the user list keeps its own set of
 * dismissed event ids (a file in the extension's global storage, so every
 * window shares it); the NOTIFICATIONS log is not touched.
 *
 * vscode-free and pure (the dismissed-set file helpers aside).
 */

import * as fs from 'fs';
import * as path from 'path';
import { NOTIFICATION_TYPE_INFO, USER_NOTIFICATION_TYPES, type NotificationEvent, type NotificationType } from './notificationEvents';

/** The state a row shows: an ask still open or answered, anything else a plain notice. */
export type UserRowState = 'open' | 'answered' | 'notice';

/** One row of USER NOTIFICATIONS. */
export interface UserNotificationRow {
    /** The event's id (an ask: its `askOpened`). */
    id: string;
    type: NotificationType;
    icon: string;
    /** The ask's or the event's kind (question, picker, …; decision-needed, …). */
    kind?: string;
    title: string;
    windowId: string;
    quest: string;
    run: string;
    /** ISO time it happened (an ask: it opened). */
    at: string;
    state: UserRowState;
    /** An answered ask: when, and how. */
    closedAt?: string;
    outcome?: string;
    /** The interaction's id (an ask), to open it in its window. */
    key?: string;
    /** What it asks or says, and the context, as lines. */
    details: string[];
    /** A decision row: the todo whose decisions it is about. */
    todo?: { quest: string; id: string };
    /** A decision row whose todo held a queue item: the window, run and item to continue. */
    continueQueue?: { windowId: string; run: string; itemId?: string };
}

/** How close a `userTodo` event and the todo event of the same change are (one write, two events). */
const SAME_CHANGE_MS = 10_000;

/** The status a todo event sets: `{old, new}` of its status field, when it has one. */
function statusChange(e: NotificationEvent): { old?: string; new?: string } | undefined {
    const f = e.todo?.fields.find((x) => x.field === 'status');
    return f ? { old: f.old, new: f.new } : undefined;
}

/** Does event `e` put a todo into `decision-needed` (filed so, or changed into it)? */
export function entersDecisionNeeded(e: NotificationEvent): boolean {
    if (e.type === 'userTodo') { return e.user?.kind === 'decision-needed'; }
    if (e.type !== 'todoCreated' && e.type !== 'todoChanged') { return false; }
    const s = statusChange(e);
    return !!s && s.new === 'decision-needed' && s.old !== 'decision-needed';
}

/** Does event `e` take a todo out of `decision-needed`? Answers the new status. */
export function leavesDecisionNeeded(e: NotificationEvent): string | undefined {
    if (e.type !== 'todoChanged') { return undefined; }
    const s = statusChange(e);
    return s && s.old === 'decision-needed' && s.new !== 'decision-needed' ? (s.new ?? 'changed') : undefined;
}

/**
 * The decision rows: one per time a todo went into `decision-needed` (the
 * `userTodo` event and the todo event of the same change merged, the
 * `userTodo` preferred for its title and open decisions), open until it left.
 */
export function decisionRows(events: readonly NotificationEvent[], dismissed: ReadonlySet<string> = new Set()): UserNotificationRow[] {
    const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const rows: UserNotificationRow[] = [];
    type Episode = { start: NotificationEvent; user?: NotificationEvent; end?: { at: string; status: string } };
    const open = new Map<string, Episode>();
    const episodes: Array<{ key: string; ep: Episode }> = [];
    for (const e of sorted) {
        if (!e.todo) { continue; }
        const key = `${e.todo.quest}/${e.todo.id}`;
        if (entersDecisionNeeded(e)) {
            const cur = open.get(key);
            if (cur && Math.abs(Date.parse(e.at) - Date.parse(cur.start.at)) <= SAME_CHANGE_MS) {
                // The other event of the same change.
                if (e.type === 'userTodo') { cur.user = e; }
                continue;
            }
            if (cur) { continue; } // still waiting since the earlier one
            const ep: Episode = { start: e, ...(e.type === 'userTodo' ? { user: e } : {}) };
            open.set(key, ep);
            episodes.push({ key, ep });
            continue;
        }
        const left = leavesDecisionNeeded(e);
        if (left) {
            const cur = open.get(key);
            if (cur) { cur.end = { at: e.at, status: left }; open.delete(key); }
        }
    }
    const holds = sorted.filter((e) => e.type === 'queueHolding' && e.user?.kind === 'decision-needed' && e.todo);
    for (const { key, ep } of episodes) {
        const first = ep.start;
        if (dismissed.has(first.id) || (ep.user && dismissed.has(ep.user.id))) { continue; }
        const todo = { quest: first.todo!.quest, id: first.todo!.id };
        const title = ep.user?.user?.title ?? `Decision needed in todo ${todo.id}${first.todo!.title ? `: ${first.todo!.title}` : ''}`;
        const hold = [...holds].reverse().find((h) => `${h.todo!.quest}/${h.todo!.id}` === key && Date.parse(h.at) >= Date.parse(first.at) - SAME_CHANGE_MS);
        const continueQueue = ep.end && hold ? { windowId: hold.windowId, run: hold.run, ...(hold.user?.queueItemId ? { itemId: hold.user.queueItemId } : {}) } : undefined;
        rows.push({
            id: first.id,
            type: 'userTodo',
            icon: NOTIFICATION_TYPE_INFO.userTodo.icon,
            kind: 'decision-needed',
            title,
            windowId: first.windowId,
            quest: first.quest,
            run: first.run,
            at: first.at,
            state: ep.end ? 'answered' : 'open',
            ...(ep.end ? { closedAt: ep.end.at, outcome: `now ${ep.end.status}` } : {}),
            details: [
                ...(ep.user?.user?.details ?? []),
                ...(ep.end ? [`Answered: the todo is now ${ep.end.status}`] : []),
                ...(hold ? [`Held queue item ${hold.user?.queueItemId ?? ''} in run ${hold.run} (${hold.quest || hold.windowId})`] : []),
                `Todo: ${todo.quest}/${todo.id}`,
            ],
            todo,
            ...(continueQueue ? { continueQueue } : {}),
        });
    }
    return rows;
}

/** The types that make a row (an `askClosed` only marks its ask answered). */
const ROW_TYPES = new Set<NotificationType>(USER_NOTIFICATION_TYPES.filter((t) => t !== 'askClosed'));

/** How long, in words: `3 min`, `2 h 5 min`, `1 d 4 h`. */
export function durationText(ms: number): string {
    const min = Math.max(0, Math.floor(ms / 60_000));
    if (min < 60) { return `${min} min`; }
    const h = Math.floor(min / 60);
    if (h < 24) { return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`; }
    return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

/**
 * The rows: every user-directed event of the log not dismissed — what still
 * waits for the user (open asks, decisions) first, then the rest, each part
 * newest first — an ask paired with its close (by key) when the log holds it.
 */
export function userNotificationRows(events: readonly NotificationEvent[], dismissed: ReadonlySet<string> = new Set()): UserNotificationRow[] {
    const closes = new Map<string, NotificationEvent>();
    for (const e of events) {
        if (e.type === 'askClosed' && e.user?.key) { closes.set(`${e.windowId}|${e.user.key}`, e); }
    }
    const rows: UserNotificationRow[] = [];
    for (const e of events) {
        if (!ROW_TYPES.has(e.type) || dismissed.has(e.id)) { continue; }
        // A todo waiting for decisions is one row, open until answered (decisionRows).
        if (e.type === 'userTodo' && e.user?.kind === 'decision-needed') { continue; }
        const u = e.user;
        const close = e.type === 'askOpened' && u?.key ? closes.get(`${e.windowId}|${u.key}`) : undefined;
        const state: UserRowState = e.type !== 'askOpened' ? 'notice' : close ? 'answered' : 'open';
        const who = e.who.kind === 'agent'
            ? [e.who.session && `session ${e.who.session}`, e.who.transport && `transport ${e.who.transport}`].filter(Boolean).join(', ')
            : e.who.kind === 'user' ? 'you' : (e.who.label ?? 'the extension');
        const details = [
            ...(u?.details ?? []),
            ...(close?.user?.outcome ? [`Answer: ${close.user.outcome}`] : []),
            ...(u?.urgency || u?.channel ? [[u.urgency && `urgency ${u.urgency}`, u.channel && `channel ${u.channel}`].filter(Boolean).join(', ')] : []),
            `Window: ${e.quest || e.windowId} · run ${e.run}`,
            ...(who ? [`From: ${who}`] : []),
            ...(u?.queueItemId || e.who.queueItemId ? [`Queue item: ${u?.queueItemId ?? e.who.queueItemId}`] : []),
            ...(e.todo ? [`Todo: ${e.todo.quest}/${e.todo.id}`] : []),
        ];
        rows.push({
            id: e.id,
            type: e.type,
            icon: NOTIFICATION_TYPE_INFO[e.type].icon,
            ...(u?.kind ? { kind: u.kind } : {}),
            title: u?.title ?? e.type,
            windowId: e.windowId,
            quest: e.quest,
            run: e.run,
            at: e.at,
            state,
            ...(close ? { closedAt: close.at, ...(close.user?.outcome ? { outcome: close.user.outcome } : {}) } : {}),
            ...(u?.key ? { key: u.key } : {}),
            details,
        });
    }
    rows.push(...decisionRows(events, dismissed));
    const open = (r: UserNotificationRow): number => (r.state === 'open' ? 0 : 1);
    return rows.sort((a, b) => (open(a) - open(b)) || (Date.parse(b.at) - Date.parse(a.at)));
}

/** How many rows are open asks (the view's badge). */
export function openAskCount(rows: readonly UserNotificationRow[]): number {
    return rows.filter((r) => r.state === 'open').length;
}

/** The ids "dismiss all answered" hides: the answered asks and every plain notice. */
export function dismissibleAnsweredIds(rows: readonly UserNotificationRow[]): string[] {
    return rows.filter((r) => r.state !== 'open').map((r) => r.id);
}

// ---- The dismissed set (one file in the extension's global storage, shared by every window) ----

/** The dismissed event ids in `file`; an empty set when it is missing or unreadable. */
export function readDismissed(file: string): Set<string> {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
    } catch { return new Set(); }
}

/**
 * Add `ids` to the dismissed set in `file`, dropping ids no longer in the log
 * (`known`, when given) so the file does not grow without end. Written whole
 * through a temporary file.
 */
export function addDismissed(file: string, ids: readonly string[], known?: ReadonlySet<string>): Set<string> {
    const set = readDismissed(file);
    for (const id of ids) { set.add(id); }
    const kept = known ? new Set([...set].filter((id) => known.has(id))) : set;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify([...kept].sort())}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return kept;
}
