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
 * pub.dev's latest version satisfies it (not reachable: not met). The met entry
 * stays in `blocked_by`, so the reverse direction still works. Each change adds
 * a dated line to the dependent's notes.
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
import { isMap, isSeq, parse, type YAMLMap } from 'yaml';
import { isArchivedOrDeletedTodoFile } from './todoArchiveNames';
import { liveQuestTodoFiles, setAfterTodoWriteHook, writeTodoFileText } from './todoBlockingSync';
import { loadTodoYaml } from './todoYamlDocument';
import { emitNotifications } from '../services/notificationLog';

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

function hasOpenDecisions(value: unknown): boolean {
    return Array.isArray(value) && value.some((d) => {
        const dec = (d as { decision?: unknown } | null)?.decision;
        return !(typeof dec === 'string' && dec.trim());
    });
}

function readTodos(file: string): Array<Record<string, unknown>> {
    try {
        const data = parse(fs.readFileSync(file, 'utf8')) as { todos?: unknown } | null;
        return Array.isArray(data?.todos) ? (data!.todos as Array<Record<string, unknown>>).filter((t) => t && typeof t.id === 'string') : [];
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

/** Apply the status changes that follow `crossings`; answers what changed. */
export function applyBlockingCascade(crossings: readonly StatusCrossing[], questsRoot: string, today = new Date().toISOString().slice(0, 10)): BlockDecision[] {
    if (!crossings.length || applying) { return []; }
    const { statusOf, quests } = questStatusIndex(questsRoot);
    const loaded = liveDependents(questsRoot);
    const { decisions, pendingVersions } = cascadeDecisions(crossings, loaded.map((l) => l.dependent), statusOf, cachedVersion, quests);
    if (pendingVersions.length) {
        // Fetch the versions, then judge again (only these crossings, only blocked dependents change).
        lastRun = lastRun.then(async () => {
            for (const p of pendingVersions) { versionCache.set(p, { version: await versionFetcher(p), at: Date.now() }); }
            applyBlockingCascade(crossings, questsRoot, today);
        }).catch(() => undefined);
    }
    if (!decisions.length) { return []; }
    const fileOf = new Map(loaded.map((l) => [`${l.dependent.quest}/${l.dependent.id}`, l.file]));
    const byFile = new Map<string, BlockDecision[]>();
    for (const d of decisions) {
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
                map.set('status', d.to);
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
    // @TOM INFO › NOTIFICATIONS (vscimpb124): the dependents' status changes, done by the extension.
    emitNotifications(decisions.map((d) => ({
        type: 'todoChanged' as const,
        todo: { id: d.id, quest: d.quest, fields: [{ field: 'status', old: d.from, new: d.to }] },
        who: { kind: 'extension' as const, label: 'blocked todos follow their blockers' },
    })));
    return decisions;
}

// The hook: after a write of a live quest todo file, the dependents of the todos that crossed follow.
setAfterTodoWriteHook((filePath, beforeText, afterText, questsRoot) => {
    if (isArchivedOrDeletedTodoFile(path.basename(filePath))) { return; }
    const rel = path.relative(questsRoot, filePath).split(path.sep);
    if (rel.length !== 2 || rel[0].startsWith('..')) { return; }
    const crossings = crossingsOfWrite(rel[0], beforeText, afterText);
    if (crossings.length) { applyBlockingCascade(crossings, questsRoot); }
});
