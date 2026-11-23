/**
 * Where the todo panel queues an item (vscimpb139): every queue button asks, in
 * four quick picks, the **quest** (one with an open window), its **run**, a
 * **free session** of that run and the **position** (next, or the end of the
 * queue). After the first use the first pick starts with "Last: …", which
 * queues there again with one Enter, and every later pick preselects the last
 * choice. A direct send (Send to Anthropic, Guide me's send) asks only for a
 * free session of this window's runs, with its own "Last: …".
 *
 * Pure (no vscode, no fs): the items the picks show and the defaults. The host
 * (questTodoPanel-handler.ts) shows them and delivers the item — into this
 * window's queue, or through another quest's inbox.
 */

import { DEFAULT_RUN } from './processRuns';
import { canonicalSessionName, runDefaultSession, runSessionName, sessionRun } from './runSessions';

export type TodoQueuePosition = 'next' | 'end';

/** Where an item goes. `session` unset: the run's queue default; `newSession`: a session made for it. */
export interface TodoQueueTarget {
    quest: string;
    run: string;
    /** The session (its name in the run, `<name>@<run>` in a run other than `default`). */
    session?: string;
    /** The session is new: created with this name when the item is sent. */
    newSession?: boolean;
    position: TodoQueuePosition;
}

/** Where a direct send goes: a session of one of this window's runs. */
export interface TodoSendTarget {
    run: string;
    session: string;
}

/** A run as the run pick shows it: its state from the window's run list (vscimpb123), else none. */
export interface TodoRunChoice {
    run: string;
    /** `waiting for user` / `waiting for event` / `waiting on task` / `running` / `paused` / `idle`. */
    state?: string;
    detail?: string;
    pending?: number;
    /** The run the window works on. */
    current?: boolean;
}

/** One item of a pick: what it shows and what it stands for. */
export interface TodoPickItem<T> {
    label: string;
    description?: string;
    detail?: string;
    value: T;
    /** Preselected (the last choice, or the default). */
    active?: boolean;
    /** A separator line. */
    separator?: true;
}

/** `<quest> / <run> / <session> / <next|end>`. */
export function queueTargetText(t: TodoQueueTarget): string {
    return `${t.quest} / ${t.run} / ${t.session ?? 'queue default'}${t.newSession ? ' (new)' : ''} / ${t.position}`;
}

/** The confirmation's words: `quest q, run r, session s, next in the queue` / `at the end of the queue`. */
export function queueTargetSentence(t: TodoQueueTarget): string {
    return `quest ${t.quest}, run ${t.run}, session ${t.session ?? `the queue default`}${t.newSession ? ' (new)' : ''}, ${t.position === 'next' ? 'next in the queue' : 'at the end of the queue'}`;
}

/** The quest the pick starts on: the todo's own when it has an open window, else the window's. */
export function defaultTargetQuest(todoQuest: string | undefined, windowQuest: string, openQuests: readonly string[]): string {
    if (todoQuest && openQuests.includes(todoQuest)) { return todoQuest; }
    return windowQuest || openQuests[0] || '';
}

/**
 * The quest pick: "Last: …" first (when its quest still has an open window), then the default quest, then the
 * other quests with an open window. The default is preselected unless Last is there.
 */
export function questPickItems(openQuests: readonly string[], defaultQuest: string, windowQuest: string, last?: TodoQueueTarget): Array<TodoPickItem<{ quest: string } | { last: TodoQueueTarget }>> {
    const items: Array<TodoPickItem<{ quest: string } | { last: TodoQueueTarget }>> = [];
    const lastOk = !!last && openQuests.includes(last.quest);
    if (lastOk) { items.push({ label: `$(history) Last: ${queueTargetText(last!)}`, description: 'queue there again', value: { last: last! }, active: true }); }
    const quests = [...new Set(openQuests)].sort();
    const ordered = quests.includes(defaultQuest) ? [defaultQuest, ...quests.filter((q) => q !== defaultQuest)] : quests;
    for (const q of ordered) {
        items.push({
            label: q,
            description: [q === windowQuest ? 'this window' : 'its window\'s inbox', q === defaultQuest ? 'default' : ''].filter(Boolean).join(' · '),
            value: { quest: q },
            ...(!lastOk && q === defaultQuest ? { active: true } : {}),
        });
    }
    return items;
}

/** A run's state in the pick: busy (an item out, or waiting for something), paused, idle. */
export function runStateText(r: TodoRunChoice): string {
    if (!r.state) { return ''; }
    const pending = r.pending ? `, ${r.pending} pending` : '';
    if (r.state === 'idle') { return `idle${pending}`; }
    if (r.state === 'paused') { return `paused${pending}`; }
    return `busy — ${r.state}${r.detail ? `: ${r.detail}` : ''}${pending}`;
}

/** The run pick: the quest's runs (`default` first) with their state; the last run, else the current one, preselected. */
export function runPickItems(runs: readonly TodoRunChoice[], preselect?: string): Array<TodoPickItem<string>> {
    const sorted = [...runs].sort((a, b) => (a.run === DEFAULT_RUN ? -1 : b.run === DEFAULT_RUN ? 1 : a.run.localeCompare(b.run)));
    const active = preselect && sorted.some((r) => r.run === preselect) ? preselect : (sorted.find((r) => r.current)?.run ?? sorted[0]?.run);
    return sorted.map((r) => ({
        label: r.run,
        description: [runStateText(r), r.current ? 'this window\'s run' : ''].filter(Boolean).join(' · ') || undefined,
        value: r.run,
        ...(r.run === active ? { active: true } : {}),
    }));
}

/**
 * The sessions of run `run` among a quest's session names: the ones of that run (`default` run: names without a
 * run), as they are named in the run, `chat` among them when `withChat`; never the run's default session
 * (`default@<run>`: it has its own entry), each once.
 */
export function runSessionCandidates(sessionNames: readonly string[], run: string, withChat: boolean): string[] {
    const own = sessionNames.map((n) => canonicalSessionName(n)).filter((n) => sessionRun(n) === (run || DEFAULT_RUN) && n !== runDefaultSession(run));
    const all = withChat ? [runSessionName('chat', run), ...own] : own;
    return [...new Set(all)];
}

/**
 * The session pick: the free sessions, the run's default session (the queue default of the run), a new session;
 * the last choice in this run preselected, else the run's default session — picking a run selects its default
 * session (vscimpb151).
 */
export function sessionPickItems(free: readonly string[], run: string, preselect?: { session?: string; newSession?: boolean }, runDefault?: string): Array<TodoPickItem<{ session?: string } | { newSession: true }>> {
    const items: Array<TodoPickItem<{ session?: string } | { newSession: true }>> = free.map((s) => ({ label: s, description: 'free', value: { session: s } }));
    // "Run default": no session on the item, it runs in its run's default session (now `runDefault`, default@<run>
    // unless the run's queue settings name another) — and follows when that default changes.
    const shownDefault = runDefault || runDefaultSession(run);
    items.push({ label: `$(list-ordered) Run default (${shownDefault})`, description: `the default session of run ${run}, when the item is sent`, value: {} });
    items.push({ label: '$(add) New session…', description: 'a name; made when the item is sent', value: { newSession: true } });
    const idx = preselect?.newSession ? items.length - 1
        : preselect?.session && preselect.session !== shownDefault && preselect.session !== runDefaultSession(run)
            ? items.findIndex((i) => 'session' in i.value && i.value.session === preselect.session)
            : items.length - 2;
    const at = idx >= 0 ? idx : 0;
    return items.map((i, k) => (k === at ? { ...i, active: true } : i));
}

/** The position pick: next (the front of the run's queue) or the end; the last choice preselected (default: end). */
export function positionPickItems(preselect?: TodoQueuePosition): Array<TodoPickItem<TodoQueuePosition>> {
    const p = preselect ?? 'end';
    return [
        { label: '$(arrow-up) Next', description: 'the front of the run\'s queue: sent next', value: 'next', ...(p === 'next' ? { active: true } : {}) },
        { label: '$(arrow-down) End of the queue', description: 'after the items queued now', value: 'end', ...(p === 'end' ? { active: true } : {}) },
    ];
}

/** `<session> — run <run>`. */
export function sendTargetText(t: TodoSendTarget): string {
    return `${t.session} — run ${t.run}`;
}

/** The direct send's session pick: "Last: …" first while that session is still free, then the free sessions of each run. */
export function sendSessionPickItems(free: readonly TodoSendTarget[], last?: TodoSendTarget): Array<TodoPickItem<TodoSendTarget>> {
    const items: Array<TodoPickItem<TodoSendTarget>> = [];
    const lastFree = !!last && free.some((f) => f.run === last.run && f.session === last.session);
    if (lastFree) { items.push({ label: `$(history) Last: ${sendTargetText(last!)}`, description: 'send there again', value: last!, active: true }); }
    free.forEach((f, k) => items.push({ label: f.session, description: `run ${f.run} · free`, value: f, ...(!lastFree && k === 0 ? { active: true } : {}) }));
    return items;
}

/**
 * The sessions busy in a quest, from its queue entries on disk (`_ai/queue/*_<quest>.<type>.entry.queue.yaml`):
 * an item sending or a chat send in flight (`sending` / `chat`) holds its session — the one it names, else its run's
 * queue default — what another quest's window has in its queue, read without that window.
 */
export function busySessionsOfEntries(entries: ReadonlyArray<{ status?: string; session?: string; run?: string }>): Set<string> {
    const busy = new Set<string>();
    for (const e of entries) {
        if (e.status !== 'sending' && e.status !== 'chat') { continue; }
        const run = e.run || DEFAULT_RUN;
        busy.add(canonicalSessionName(e.session) || runDefaultSession(run));
    }
    return busy;
}
