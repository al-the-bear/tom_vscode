/**
 * @TOM INFO › USER NOTIFICATIONS (vscimpb170): everything an agent or the
 * extension directs at the user, read from the machine's notification log
 * (services/notificationLog.ts) — one row per event, never merged, newest
 * first. An ask (`askOpened`) is shown as open, with how long, until its
 * `askClosed` arrives; then as answered, with the answer or why it closed.
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
 * The rows: every user-directed event of the log not dismissed, newest first,
 * an ask paired with its close (by key) when the log holds it.
 */
export function userNotificationRows(events: readonly NotificationEvent[], dismissed: ReadonlySet<string> = new Set()): UserNotificationRow[] {
    const closes = new Map<string, NotificationEvent>();
    for (const e of events) {
        if (e.type === 'askClosed' && e.user?.key) { closes.set(`${e.windowId}|${e.user.key}`, e); }
    }
    const rows: UserNotificationRow[] = [];
    for (const e of events) {
        if (!ROW_TYPES.has(e.type) || dismissed.has(e.id)) { continue; }
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
    return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
