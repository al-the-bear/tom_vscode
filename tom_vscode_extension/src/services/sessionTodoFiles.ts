/**
 * Session todos are todos of ONE session of a quest: the small steps an agent
 * notes for itself while it carries out a quest todo, in the flow of that
 * session. Each session keeps them in its own file inside its storage root,
 * `_ai/quests/<quest>/history/sessions/<session>/session-todos.todo.yaml`
 * (with its `-archived` / `-deleted` siblings), which is not versioned (the
 * `_ai` .gitignore) and goes when the session is deleted (removeSessionStorage).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SESSIONS_FOLDER, sessionRoot } from './sessionStorage';

/** The session todo file's name in a session's storage root. */
export const SESSION_TODOS_FILE = 'session-todos.todo.yaml';

/** The session todo file of `session` (it may not exist yet). */
export function sessionTodoFile(historyRoot: string, session: string): string {
    return path.join(sessionRoot(historyRoot, session), SESSION_TODOS_FILE);
}

/** The session todo file relative to the quest folder (`history/sessions/<session>/session-todos.todo.yaml`). */
export function sessionTodoSourceFile(session: string): string {
    return ['history', SESSIONS_FOLDER, session, SESSION_TODOS_FILE].join('/');
}

/** The session a quest-folder-relative session todo file belongs to; undefined for any other path. */
export function sessionOfTodoSourceFile(sourceFile: string): string | undefined {
    const m = /^history\/sessions\/([^/]+)\/session-todos\.todo\.yaml$/.exec(sourceFile.replace(/\\/g, '/'));
    return m ? m[1] : undefined;
}

/** A session's todo counts, for the SESSIONS view and the session switch. */
export interface SessionTodoCount {
    session: string;
    /** Todos not done (not completed or cancelled). */
    open: number;
    /** Every todo in the file, done ones included (cancelled ones are not). */
    total: number;
    /** When the file was last written, ms since the epoch. */
    lastWrite: number;
}

/** The counts of one session todo file; null when it does not exist or does not read. */
export function countSessionTodos(file: string, readStatuses: (file: string) => string[]): Omit<SessionTodoCount, 'session'> | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return null; }
    let statuses: string[];
    try { statuses = readStatuses(file); } catch { return null; }
    const live = statuses.filter((s) => s !== 'cancelled');
    return {
        open: live.filter((s) => s !== 'completed').length,
        total: live.length,
        lastWrite: stat.mtimeMs,
    };
}

/** The counts of every session of the quest that has a session todo file, most recently written first. */
export function sessionTodoCounts(historyRoot: string, readStatuses: (file: string) => string[]): SessionTodoCount[] {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(historyRoot, SESSIONS_FOLDER)); } catch { return []; }
    const out: SessionTodoCount[] = [];
    for (const session of names) {
        const counts = countSessionTodos(sessionTodoFile(historyRoot, session), readStatuses);
        if (counts) { out.push({ session, ...counts }); }
    }
    return out.sort((a, b) => b.lastWrite - a.lastWrite || a.session.localeCompare(b.session));
}
