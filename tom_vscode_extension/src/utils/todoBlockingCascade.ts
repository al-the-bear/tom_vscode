/**
 * Blocked todos follow their blockers (vscimpb121): when a todo's status
 * crosses between done (completed / cancelled) and not done, the live todos in
 * every quest that name it in `blocked_by` follow:
 *
 *   - the blocker is done now: a dependent that is `blocked` and whose every
 *     condition is met becomes `not-started` (`decision-needed` while it has
 *     open decisions);
 *   - the blocker is not done any more: a dependent that is `not-started` or
 *     `decision-needed` goes back to `blocked`. In-progress, completed,
 *     cancelled and waiting-for-repeat dependents are left alone.
 *
 * "Met" is what `_bin/check_todo_blocks.py` reads: a `blocked_by` entry names
 * a todo that exists — live or archived / deleted, in its quest — and is
 * completed or cancelled (an unknown id, or a bare quest name, is not met); a
 * `blocked_until` condition `<package> >= <x.y.z>` (or `>`) is met when
 * pub.dev's latest version satisfies it (not reachable: not met). Each change
 * adds a dated line to the dependent's notes.
 *
 * **A blocker that is done leaves the `blocked_by` lists.** When a todo goes to
 * completed (or cancelled), every live todo of every quest that names it in
 * `blocked_by` loses that entry, whatever its own status ({@link
 * blockerRemovals}); the notes line names what was removed. So `blocked_by`
 * holds only what still blocks, and a todo reopened later blocks only the
 * dependents that still name it.
 *
 * Only a crossing triggers it, so the dependents' own changes (blocked ↔
 * not-started) start no further cascade. The hook runs after every write of a
 * live quest todo file (todoBlockingSync.writeTodoFileText): the todo panel,
 * the todo editor, the todo tools, archiving and the queue alike.
 *
 * The rule ({@link cascadeDecisions}) is pure; the rest reads and writes files.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { relativeInside } from './pathCompare';
import { isMap, isSeq, parse, type YAMLMap } from 'yaml';
import { isArchivedOrDeletedTodoFile } from './todoArchiveNames';
import { liveQuestTodoFiles, setAfterTodoWriteHook, writeTodoFileText } from './todoBlockingSync';
import { loadTodoYaml } from './todoYamlDocument';
import { emitNotifications } from '../services/notificationLog';
import { groupDecisions, partOfRefs, type GroupRecord } from './todoGroups';

export const DONE_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled']);

/** Statuses a re-block applies to; the others are left alone (user decision a1). */
const REBLOCKABLE: ReadonlySet<string> = new Set(['not-started', 'decision-needed']);

export function isDone(status: string | undefined): boolean {
    return !!status && DONE_STATUSES.has(status.trim().toLowerCase());
}

/** A live todo that may depend on others. */
export interface DependentTodo {
    quest: string;
    id: string;
    status: string;
    blockedBy: string[];
    blockedUntil: string[];
    /** Has decisions without an answer. */
    openDecisions: boolean;
}

/** A todo whose status crossed between done and not done. */
export interface StatusCrossing {
    quest: string;
    id: string;
    /** Its status now. */
    status: string;
}

/** The status of a todo of a quest, live or archived / deleted; undefined when it exists nowhere. */
export type StatusLookup = (quest: string, id: string) => string | undefined;
/** pub.dev's latest version of a package; undefined when it is not known (not reachable, not fetched yet). */
export type VersionLookup = (pkg: string) => string | undefined;

export type Verdict = 'met' | 'open' | 'unknown';

/** Where a `blocked_by` entry written in `ownQuest` points: `{quest, id}`, or undefined for prose (a bare quest name). */
export function blockerOf(entry: string, ownQuest: string, quests: ReadonlySet<string>): { quest: string; id: string } | undefined {
    const value = entry.trim();
    const slash = value.indexOf('/');
    if (slash > 0) { return { quest: value.slice(0, slash), id: value.slice(slash + 1) }; }
    if (quests.has(value)) { return undefined; }
    return value ? { quest: ownQuest, id: value } : undefined;
}

/** Is a `blocked_by` entry met (check_todo_blocks' rule)? */
export function blockedByVerdict(entry: string, ownQuest: string, statusOf: StatusLookup, quests: ReadonlySet<string>): Verdict {
    const target = blockerOf(entry, ownQuest, quests);
    if (!target) { return 'open'; }
    const status = statusOf(target.quest, target.id);
    if (status === undefined) { return 'open'; }
    return isDone(status) ? 'met' : 'open';
}

const CONDITION = /^\s*([a-z0-9_]+)\s*(>=|>)\s*(\d+\.\d+\.\d+)\s*$/;

/** A version's numeric key: the first three numbers, build and pre-release dropped. */
export function versionKey(v: string): number[] {
    return (v.split('+')[0].split('-')[0].match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

function compareKeys(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d) { return d; }
    }
    return 0;
}

/** The package a `blocked_until` condition reads, or undefined when it is not one. */
export function conditionPackage(condition: string): string | undefined {
    return CONDITION.exec(condition)?.[1];
}

/** Is a `blocked_until` condition met by pub.dev's latest version? */
export function blockedUntilVerdict(condition: string, versionOf: VersionLookup): Verdict {
    const m = CONDITION.exec(condition);
    if (!m) { return 'open'; }
    const latest = versionOf(m[1]);
    if (latest === undefined) { return 'unknown'; }
    const c = compareKeys(versionKey(latest), versionKey(m[3]));
    return (m[2] === '>=' ? c >= 0 : c > 0) ? 'met' : 'open';
}

/** Are all of a dependent's conditions met? `unknown` when a version is not known (yet). */
export function allConditionsMet(todo: DependentTodo, statusOf: StatusLookup, versionOf: VersionLookup, quests: ReadonlySet<string>): Verdict {
    let unknown = false;
    for (const b of todo.blockedBy) {
        if (blockedByVerdict(b, todo.quest, statusOf, quests) !== 'met') { return 'open'; }
    }
    for (const c of todo.blockedUntil) {
        const v = blockedUntilVerdict(c, versionOf);
        if (v === 'open') { return 'open'; }
        if (v === 'unknown') { unknown = true; }
    }
    return unknown ? 'unknown' : 'met';
}

/** One status change the cascade makes. */
export interface BlockDecision {
    quest: string;
    id: string;
    from: string;
    to: string;
    /** The notes line (without the date). */
    note: string;
}

/**
 * The status changes that follow `crossings` (pure). A dependent waiting only
 * for an unknown version is reported in `pendingVersions` (packages to fetch),
 * not changed.
 */
export function cascadeDecisions(
    crossings: readonly StatusCrossing[],
    dependents: readonly DependentTodo[],
    statusOf: StatusLookup,
    versionOf: VersionLookup,
    quests: ReadonlySet<string>,
): { decisions: BlockDecision[]; pendingVersions: string[] } {
    const decisions: BlockDecision[] = [];
    const pending = new Set<string>();
    const seen = new Set<string>();
    for (const dep of dependents) {
        const key = `${dep.quest}/${dep.id}`;
        if (seen.has(key)) { continue; }
        const status = dep.status.trim().toLowerCase();
        const naming = crossings.filter((c) => dep.blockedBy.some((b) => {
            const t = blockerOf(b, dep.quest, quests);
            return !!t && t.quest === c.quest && t.id === c.id;
        }));
        if (!naming.length) { continue; }
        const ref = (c: StatusCrossing) => (c.quest === dep.quest ? c.id : `${c.quest}/${c.id}`);
        const reopened = naming.find((c) => !isDone(c.status));
        if (reopened) {
            if (REBLOCKABLE.has(status)) {
                seen.add(key);
                decisions.push({ quest: dep.quest, id: dep.id, from: status, to: 'blocked', note: `blocked again: ${ref(reopened)} is ${reopened.status}` });
            }
            continue;
        }
        if (status !== 'blocked') { continue; }
        const verdict = allConditionsMet(dep, statusOf, versionOf, quests);
        if (verdict === 'unknown') {
            for (const c of dep.blockedUntil) { const p = conditionPackage(c); if (p && versionOf(p) === undefined) { pending.add(p); } }
            continue;
        }
        if (verdict !== 'met') { continue; }
        seen.add(key);
        decisions.push({
            quest: dep.quest, id: dep.id, from: status, to: dep.openDecisions ? 'decision-needed' : 'not-started',
            note: `unblocked by ${naming.map(ref).join(', ')}`,
        });
    }
    return { decisions, pendingVersions: [...pending].sort() };
}

/** The `blocked_by` entries a done blocker leaves. */
export interface BlockerRemoval {
    quest: string;
    id: string;
    /** The entries to remove, as written. */
    entries: string[];
}

/**
 * The `blocked_by` entries to remove after `crossings` (pure): for every
 * crossing into done (completed or cancelled), the entry naming it in each
 * dependent, whatever the dependent's status.
 */
export function blockerRemovals(crossings: readonly StatusCrossing[], dependents: readonly DependentTodo[], quests: ReadonlySet<string>): BlockerRemoval[] {
    const done = crossings.filter((c) => isDone(c.status));
    if (!done.length) { return []; }
    const out: BlockerRemoval[] = [];
    for (const dep of dependents) {
        const entries = dep.blockedBy.filter((b) => {
            const t = blockerOf(b, dep.quest, quests);
            return !!t && done.some((c) => c.quest === t.quest && c.id === t.id);
        });
        if (entries.length) { out.push({ quest: dep.quest, id: dep.id, entries }); }
    }
    return out;
}

/** The todos whose status crossed between done and not done in one file write (pure). */
export function crossingsOfWrite(quest: string, beforeText: string | undefined, afterText: string | undefined): StatusCrossing[] {
    const statuses = (text: string | undefined): Map<string, string> => {
        const out = new Map<string, string>();
        if (!text) { return out; }
        let data: unknown;
        try { data = parse(text); } catch { return out; }
        const todos = (data as { todos?: unknown } | null)?.todos;
        if (!Array.isArray(todos)) { return out; }
        for (const t of todos) {
            const r = t as Record<string, unknown> | null;
            if (r && typeof r.id === 'string' && r.id) { out.set(r.id, typeof r.status === 'string' ? r.status : ''); }
        }
        return out;
    };
    const before = statuses(beforeText);
    const after = statuses(afterText);
    const out: StatusCrossing[] = [];
    for (const [id, status] of after) {
        const was = before.get(id);
        if (was === undefined) { continue; }
        if (isDone(was) !== isDone(status)) { out.push({ quest, id, status }); }
    }
    return out;
}

// ============================================================================
// Files
// ============================================================================

interface LoadedTodo { file: string; dependent: DependentTodo }

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()) : [];
}

export function hasOpenDecisions(value: unknown): boolean {
    return Array.isArray(value) && value.some((d) => {
        const dec = (d as { decision?: unknown } | null)?.decision;
        return !(typeof dec === 'string' && dec.trim());
    });
}

/** Parsed todo files by path, kept while the file's mtime and size are unchanged (archives are large and rarely change). */
const parsedTodoFiles = new Map<string, { mtimeNs: bigint; size: bigint; todos: Array<Record<string, unknown>> }>();

function readTodos(file: string): Array<Record<string, unknown>> {
    try {
        // Nanosecond mtime and size: a same-size rewrite within one millisecond still reads fresh.
        const st = fs.statSync(file, { bigint: true });
        const hit = parsedTodoFiles.get(file);
        if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) { return hit.todos; }
        const data = parse(fs.readFileSync(file, 'utf8')) as { todos?: unknown } | null;
        const todos = Array.isArray(data?.todos) ? (data!.todos as Array<Record<string, unknown>>).filter((t) => t && typeof t.id === 'string') : [];
        parsedTodoFiles.set(file, { mtimeNs: st.mtimeNs, size: st.size, todos });
        return todos;
    } catch { return []; }
}

/** Every quest's todo statuses, live first, then archived and deleted (a live status wins). */
export function questStatusIndex(questsRoot: string): { statusOf: StatusLookup; quests: Set<string> } {
    const byQuest = new Map<string, Map<string, string>>();
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(questsRoot, { withFileTypes: true }); } catch { /* none */ }
    for (const d of dirs) {
        if (!d.isDirectory()) { continue; }
        const map = new Map<string, string>();
        let names: string[] = [];
        try { names = fs.readdirSync(path.join(questsRoot, d.name)).filter((n) => n.endsWith('.todo.yaml')); } catch { /* none */ }
        const ordered = [...names.filter((n) => !isArchivedOrDeletedTodoFile(n)), ...names.filter((n) => isArchivedOrDeletedTodoFile(n))];
        for (const n of ordered) {
            for (const t of readTodos(path.join(questsRoot, d.name, n))) {
                if (!map.has(t.id as string)) { map.set(t.id as string, typeof t.status === 'string' ? t.status : ''); }
            }
        }
        byQuest.set(d.name, map);
    }
    return { statusOf: (quest, id) => byQuest.get(quest)?.get(id), quests: new Set(byQuest.keys()) };
}

function liveDependents(questsRoot: string): LoadedTodo[] {
    const out: LoadedTodo[] = [];
    for (const file of liveQuestTodoFiles(questsRoot)) {
        const quest = path.basename(path.dirname(file));
        for (const t of readTodos(file)) {
            const blockedBy = strings(t.blocked_by);
            if (!blockedBy.length) { continue; }
            out.push({ file, dependent: {
                quest, id: t.id as string, status: typeof t.status === 'string' ? t.status : '',
                blockedBy, blockedUntil: strings(t.blocked_until), openDecisions: hasOpenDecisions(t.decisions),
            } });
        }
    }
    return out;
}

// pub.dev versions, cached for ten minutes (check_todo_blocks reads the same source).
const VERSION_TTL_MS = 10 * 60_000;
const versionCache = new Map<string, { version: string | undefined; at: number }>();
let versionFetcher: (pkg: string) => Promise<string | undefined> = fetchLatestOnPub;

function cachedVersion(pkg: string): string | undefined {
    const hit = versionCache.get(pkg);
    return hit && Date.now() - hit.at < VERSION_TTL_MS ? hit.version : undefined;
}

function fetchLatestOnPub(pkg: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const req = https.get(`https://pub.dev/api/packages/${encodeURIComponent(pkg)}`, { timeout: 15_000 }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve((JSON.parse(body) as { latest?: { version?: string } }).latest?.version); } catch { resolve(undefined); }
            });
        });
        req.on('error', () => resolve(undefined));
        req.on('timeout', () => { req.destroy(); resolve(undefined); });
    });
}

/** For tests: replace how a package's latest version is fetched (undefined restores pub.dev), and empty the cache. */
export function setVersionFetcherForTest(fetcher: ((pkg: string) => Promise<string | undefined>) | undefined): void {
    versionFetcher = fetcher ?? fetchLatestOnPub;
    versionCache.clear();
}

let applying = false;
let lastRun: Promise<void> = Promise.resolve();

/** Resolves once the version fetches started by earlier writes have been applied (for tests). */
export function blockingCascadeSettled(): Promise<void> { return lastRun; }

/** A status change the cascade writes into a live todo file; `removeBlockedBy`: entries taken out of its `blocked_by` (alone when `to` is `from`). */
interface StatusWrite { quest: string; id: string; from: string; to: string; note: string; removeBlockedBy?: string[] }

/** The live todos naming another in `comprised_of` (any status), with their files. */
function liveGroups(questsRoot: string): Array<{ file: string; group: GroupRecord }> {
    const out: Array<{ file: string; group: GroupRecord }> = [];
    for (const file of liveQuestTodoFiles(questsRoot)) {
        const quest = path.basename(path.dirname(file));
        for (const t of readTodos(file)) {
            const comprisedOf = strings(t.comprised_of);
            if (!comprisedOf.length) { continue; }
            out.push({ file, group: { scopeKey: `quest:${quest}`, quest, id: t.id as string, status: typeof t.status === 'string' ? t.status : '', comprisedOf } });
        }
    }
    return out;
}

/** A member of a group as the todo panel lists it (vscimpb126). */
export interface GroupMemberInfo {
    /** As written in `comprised_of`. */
    ref: string;
    quest: string;
    id: string;
    title?: string;
    status?: string;
    /** The member exists (live, else archived / deleted). */
    found: boolean;
}

/**
 * What the todo panel shows of todo groups (vscimpb126), read once per list:
 * each todo's `part_of`, and each group's members with their title and status
 * (live first, else archived / deleted), in `comprised_of` order.
 */
export function groupListInfo(questsRoot: string): {
    partOf(quest: string, id: string): string[];
    members(quest: string, comprisedOf: readonly string[]): GroupMemberInfo[];
} {
    const groups = liveGroups(questsRoot).map((g) => g.group);
    const byQuest = new Map<string, Map<string, { title?: string; status?: string }>>();
    const questTodos = (quest: string): Map<string, { title?: string; status?: string }> => {
        let map = byQuest.get(quest);
        if (map) { return map; }
        map = new Map();
        let names: string[] = [];
        try { names = fs.readdirSync(path.join(questsRoot, quest)).filter((n) => n.endsWith('.todo.yaml')); } catch { /* no such quest */ }
        const ordered = [...names.filter((n) => !isArchivedOrDeletedTodoFile(n)), ...names.filter((n) => isArchivedOrDeletedTodoFile(n))];
        for (const n of ordered) {
            for (const t of readTodos(path.join(questsRoot, quest, n))) {
                if (map.has(t.id as string)) { continue; }
                const title = typeof t.title === 'string' && t.title ? t.title
                    : typeof t.description === 'string' ? t.description.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
                map.set(t.id as string, { ...(title ? { title } : {}), ...(typeof t.status === 'string' ? { status: t.status } : {}) });
            }
        }
        byQuest.set(quest, map);
        return map;
    };
    return {
        partOf: (quest, id) => partOfRefs({ scopeKey: `quest:${quest}`, id }, groups),
        members: (quest, comprisedOf) => comprisedOf.map((ref) => {
            const slash = ref.indexOf('/');
            const mq = slash > 0 ? ref.slice(0, slash) : quest;
            const mid = slash > 0 ? ref.slice(slash + 1) : ref;
            const t = questTodos(mq).get(mid);
            return { ref, quest: mq, id: mid, ...(t?.title ? { title: t.title } : {}), ...(t?.status ? { status: t.status } : {}), found: !!t };
        }),
    };
}

/**
 * The `part_of` of todo `id` of `quest` (vscimpb125): the live group todos
 * whose `comprised_of` names it, as their id in the same quest or
 * `<quest>/<id>` from another. Derived on read, never stored.
 */
export function todoPartOf(questsRoot: string, quest: string, id: string): string[] {
    return partOfRefs({ scopeKey: `quest:${quest}`, id }, liveGroups(questsRoot).map((g) => g.group));
}

/** Write `changes` (status, a notes line, `updated`; a completion's `completed_date`) into their live files. */
function writeStatusChanges(changes: readonly StatusWrite[], fileOf: ReadonlyMap<string, string>, today: string): void {
    const byFile = new Map<string, StatusWrite[]>();
    for (const d of changes) {
        const f = fileOf.get(`${d.quest}/${d.id}`);
        if (f) { byFile.set(f, [...(byFile.get(f) ?? []), d]); }
    }
    applying = true;
    try {
        for (const [file, list] of byFile) {
            const doc = loadTodoYaml(file);
            const todos = doc.get('todos', true);
            if (!isSeq(todos)) { continue; }
            for (const node of todos.items) {
                if (!isMap(node)) { continue; }
                const map = node as YAMLMap;
                const d = list.find((x) => x.id === map.get('id'));
                if (!d) { continue; }
                if (d.removeBlockedBy?.length) {
                    const kept = strings((map.toJSON() as Record<string, unknown>).blocked_by).filter((e) => !d.removeBlockedBy!.includes(e));
                    if (kept.length) { map.set('blocked_by', doc.createNode(kept)); } else { map.delete('blocked_by'); }
                }
                if (d.to !== d.from) { map.set('status', d.to); }
                if (d.to === 'completed') { map.set('completed_date', today); }
                if (d.from === 'completed' && d.to !== 'completed') { map.delete('completed_date'); map.delete('completed_by'); }
                const notes = map.get('notes');
                const line = `${today}: ${d.note}.`;
                map.set('notes', typeof notes === 'string' && notes.trim() ? `${notes.replace(/\s+$/, '')}\n\n${line}` : line);
                map.set('updated', today);
            }
            writeTodoFileText(file, doc.toString());
        }
    } finally {
        applying = false;
    }
}

let groupCompletedHook: ((quest: string, id: string) => void) | undefined;

/** Register what follows a group the members completed: its `on_done` (questTodoManager). */
export function setGroupCompletedHook(hook: ((quest: string, id: string) => void) | undefined): void {
    groupCompletedHook = hook;
}

/** How many levels of groups of groups one write follows. */
const GROUP_ROUNDS = 8;

/**
 * Apply the status changes that follow `crossings`: first the groups naming
 * a crossed todo (vscimpb125; a group's own change is a crossing too, so
 * groups of groups follow, up to {@link GROUP_ROUNDS} levels), then the todos
 * blocked by any of them (vscimpb121). Answers the blocking rule's changes.
 */
export function applyBlockingCascade(crossings: readonly StatusCrossing[], questsRoot: string, today = new Date().toISOString().slice(0, 10)): BlockDecision[] {
    if (!crossings.length || applying) { return []; }

    // 1. Groups follow their members.
    const all: StatusCrossing[] = [...crossings];
    let round: StatusCrossing[] = [...crossings];
    for (let i = 0; i < GROUP_ROUNDS && round.length; i++) {
        const { statusOf } = questStatusIndex(questsRoot);
        const groups = liveGroups(questsRoot);
        const changes = groupDecisions(round, groups.map((g) => g.group), statusOf);
        if (!changes.length) { break; }
        writeStatusChanges(changes, new Map(groups.map((g) => [`${g.group.quest}/${g.group.id}`, g.file])), today);
        emitNotifications(changes.map((d) => ({
            type: 'todoChanged' as const,
            todo: { id: d.id, quest: d.quest, fields: [{ field: 'status', old: d.from, new: d.to }] },
            who: { kind: 'extension' as const, label: 'todo groups follow their members' },
        })));
        for (const d of changes) {
            if (d.to === 'completed') { try { groupCompletedHook?.(d.quest, d.id); } catch { /* never fails the write */ } }
        }
        round = changes.map((d) => ({ quest: d.quest, id: d.id, status: d.to })).filter((c) => isDone(c.status) !== isDone(changes.find((d) => d.id === c.id && d.quest === c.quest)!.from));
        all.push(...round);
    }

    // 2. Blocked todos follow their blockers, the groups' changes included.
    const { statusOf, quests } = questStatusIndex(questsRoot);
    const loaded = liveDependents(questsRoot);
    const { decisions, pendingVersions } = cascadeDecisions(all, loaded.map((l) => l.dependent), statusOf, cachedVersion, quests);
    if (pendingVersions.length) {
        // Fetch the versions, then judge again (only these crossings, only blocked dependents change).
        lastRun = lastRun.then(async () => {
            for (const p of pendingVersions) { versionCache.set(p, { version: await versionFetcher(p), at: Date.now() }); }
            applyBlockingCascade(all, questsRoot, today);
        }).catch(() => undefined);
    }
    // 3. A blocker that is done leaves the `blocked_by` lists (with the status change of the same todo, in one write).
    // A blocked dependent whose release still waits for a version keeps its entries until that is known: the
    // run after the fetch judges it by them (and removes them then).
    const settled = loaded.map((l) => l.dependent).filter((d) =>
        !(d.status.trim().toLowerCase() === 'blocked' && allConditionsMet(d, statusOf, cachedVersion, quests) === 'unknown'));
    const removals = blockerRemovals(all, settled, quests);
    const writes: StatusWrite[] = decisions.map((d) => ({ ...d }));
    for (const r of removals) {
        const status = loaded.find((l) => l.dependent.quest === r.quest && l.dependent.id === r.id)!.dependent.status;
        const same = writes.find((w) => w.quest === r.quest && w.id === r.id);
        if (same) {
            same.removeBlockedBy = r.entries;
        } else {
            writes.push({ quest: r.quest, id: r.id, from: status, to: status, note: `no longer blocked by ${r.entries.join(', ')} (done)`, removeBlockedBy: r.entries });
        }
    }
    if (!writes.length) { return []; }
    writeStatusChanges(writes, new Map(loaded.map((l) => [`${l.dependent.quest}/${l.dependent.id}`, l.file])), today);
    // @TOM INFO › NOTIFICATIONS (vscimpb124): the dependents' status changes, done by the extension; then the entries removed.
    if (decisions.length) {
        emitNotifications(decisions.map((d) => ({
            type: 'todoChanged' as const,
            todo: { id: d.id, quest: d.quest, fields: [{ field: 'status', old: d.from, new: d.to }] },
            who: { kind: 'extension' as const, label: 'blocked todos follow their blockers' },
        })));
    }
    if (removals.length) {
        emitNotifications(removals.map((r) => ({
            type: 'todoUpdated' as const,
            todo: { id: r.id, quest: r.quest, fields: [{ field: 'blocked_by', old: r.entries.join(', '), new: '(removed: done)' }] },
            who: { kind: 'extension' as const, label: 'a done blocker leaves blocked_by' },
        })));
    }
    return decisions;
}

// The hook: after a write of a live quest todo file, the dependents of the todos that crossed follow.
setAfterTodoWriteHook((filePath, beforeText, afterText, questsRoot) => {
    if (isArchivedOrDeletedTodoFile(path.basename(filePath))) { return; }
    const rel = relativeInside(filePath, questsRoot);
    if (!rel || rel.length !== 2) { return; }
    const crossings = crossingsOfWrite(rel[0], beforeText, afterText);
    if (crossings.length) { applyBlockingCascade(crossings, questsRoot); }
});
