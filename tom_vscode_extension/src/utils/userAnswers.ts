/**
 * The answers agents give the user with tomAi_answerUser (vscimpb171): kept
 * out of the trails, in one store per `_ai` folder on this machine, shown in
 * the Answers page.
 *
 * **The store** is a folder in the extension's global storage,
 * `<globalStorage>/answers/<key of the real _ai folder>/`, so every window
 * whose workspace reaches the same `_ai` (the clone, or a link onto it) shares
 * it, across quests; it is not in git. One JSON file per answer
 * (`<id>.json`, written atomically), so windows add, mark and delete answers
 * without a lock: each operation rewrites or removes one file.
 *
 * An answer holds where it came from (window, quest, run, session, queue
 * item, time, the `filed_by` of a todo filed then), its title, the question
 * quoted, the Markdown answer, the suggested prompts (copied on a click) and
 * the suggested todos (complete records, added on a click; an added one
 * records its id). Answers stay until the user deletes them; past
 * {@link ANSWERS_WARN_LIMIT} the window offers to delete old ones.
 *
 * vscode-free.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite';
import { realPathOf } from './pathCompare';

/** Past this many stored answers the user is offered to delete old ones. */
export const ANSWERS_WARN_LIMIT = 500;

/** A prompt the answer suggests: copied to the clipboard on a click, never queued. */
export interface SuggestedPrompt {
    label: string;
    text: string;
}

/** A todo the answer suggests: the complete record, added on a click. */
export interface SuggestedTodo {
    /** The quest it goes to. */
    quest: string;
    /** The todo file in that quest; default the quest's own. */
    file?: string;
    /** The record as tomAi_createQuestTodo takes it. */
    todo: Record<string, unknown> & { id: string };
    /** Set once added: the id it was filed under, and when. */
    addedId?: string;
    addedAt?: string;
}

/** One stored answer. */
export interface UserAnswer {
    id: string;
    /** ISO time it was given. */
    at: string;
    windowId: string;
    quest: string;
    run: string;
    session?: string;
    queueItemId?: string;
    /** The question it answers, short. */
    title: string;
    /** The user's question, quoted. */
    question?: string;
    /** The answer, Markdown. */
    answer: string;
    suggestedPrompts: SuggestedPrompt[];
    suggestedTodos: SuggestedTodo[];
    read: boolean;
    /** The answering agent's context, written as `filed_by` of a todo added from this answer. */
    filedBy?: Record<string, string>;
}

/** The store's folder for the `_ai` folder `aiRoot` under `globalStorage`. */
export function answersStoreDir(globalStorage: string, aiRoot: string): string {
    const key = crypto.createHash('sha1').update(realPathOf(aiRoot)).digest('hex').slice(0, 16);
    return path.join(globalStorage, 'answers', key);
}

let counter = 0;

/** A new answer id: sortable by time, unique per process and call. */
export function newAnswerId(now: Date = new Date()): string {
    return `a${now.getTime().toString(36)}-${process.pid.toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function fileOf(dir: string, id: string): string {
    // An id is a file name of the store, never a path.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { throw new Error(`not an answer id: ${id}`); }
    return path.join(dir, `${id}.json`);
}

/** Store `answer` (its file written atomically; the folder created). */
export function writeAnswer(dir: string, answer: UserAnswer): void {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(fileOf(dir, answer.id), `${JSON.stringify(answer, null, 2)}\n`);
}

/** Answer `id`, or undefined when it is not there (or its file does not parse). */
export function readAnswer(dir: string, id: string): UserAnswer | undefined {
    try {
        const a = JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf8')) as UserAnswer;
        return a && typeof a.id === 'string' && typeof a.at === 'string' ? a : undefined;
    } catch { return undefined; }
}

/** Every stored answer, newest first (files that do not parse left out). */
export function readAnswers(dir: string): UserAnswer[] {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out: UserAnswer[] = [];
    for (const name of names) {
        if (!name.endsWith('.json')) { continue; }
        const a = readAnswer(dir, name.slice(0, -'.json'.length));
        if (a) { out.push(a); }
    }
    return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || (x.id < y.id ? 1 : -1));
}

/** How many answers the store holds (file count; no parsing). */
export function countAnswers(dir: string): number {
    try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
}

/** Change answer `id` in place; answers the changed answer, undefined when it is gone. */
function updateAnswer(dir: string, id: string, change: (a: UserAnswer) => void): UserAnswer | undefined {
    const a = readAnswer(dir, id);
    if (!a) { return undefined; }
    change(a);
    writeAnswer(dir, a);
    return a;
}

/** Mark answer `id` read (or unread). */
export function markAnswerRead(dir: string, id: string, read = true): UserAnswer | undefined {
    const a = readAnswer(dir, id);
    if (!a || a.read === read) { return a; }
    return updateAnswer(dir, id, (x) => { x.read = read; });
}

/** Record that suggested todo `index` of answer `id` was added as `todoId`. */
export function markTodoAdded(dir: string, id: string, index: number, todoId: string, now: Date = new Date()): UserAnswer | undefined {
    return updateAnswer(dir, id, (a) => {
        const t = a.suggestedTodos[index];
        if (t) { t.addedId = todoId; t.addedAt = now.toISOString(); }
    });
}

/** Delete the answers `ids`; answers how many files went. */
export function deleteAnswers(dir: string, ids: readonly string[]): number {
    let gone = 0;
    for (const id of ids) {
        try { fs.unlinkSync(fileOf(dir, id)); gone++; } catch { /* already gone */ }
    }
    return gone;
}

/** The ids of the `n` oldest answers. */
export function oldestAnswerIds(answers: readonly UserAnswer[], n: number): string[] {
    return [...answers].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).slice(0, Math.max(0, n)).map((a) => a.id);
}

/** The ids of the answers older than `days` days at `now`. */
export function answerIdsOlderThan(answers: readonly UserAnswer[], days: number, now: Date = new Date()): string[] {
    const cut = now.getTime() - days * 86_400_000;
    return answers.filter((a) => Date.parse(a.at) < cut).map((a) => a.id);
}

/** The ids of the read answers. */
export function readAnswerIds(answers: readonly UserAnswer[]): string[] {
    return answers.filter((a) => a.read).map((a) => a.id);
}

/** What the over-limit notice offers. */
export type AnswerCleanup = 'oldest100' | 'oldest200' | 'older7' | 'older30';

/** The offers' button labels, in order. */
export const ANSWER_CLEANUP_LABELS: Readonly<Record<AnswerCleanup, string>> = {
    oldest100: 'Delete the 100 oldest',
    oldest200: 'Delete the 200 oldest',
    older7: 'Older than 7 days',
    older30: 'Older than 30 days',
};

/** The answers a cleanup deletes. */
export function cleanupIds(answers: readonly UserAnswer[], cleanup: AnswerCleanup, now: Date = new Date()): string[] {
    switch (cleanup) {
        case 'oldest100': return oldestAnswerIds(answers, 100);
        case 'oldest200': return oldestAnswerIds(answers, 200);
        case 'older7': return answerIdsOlderThan(answers, 7, now);
        case 'older30': return answerIdsOlderThan(answers, 30, now);
    }
}
