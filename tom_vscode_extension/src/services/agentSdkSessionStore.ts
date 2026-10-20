/**
 * The Agent SDK session files of one history folder
 * (`_ai/quests/<quest>/history/<name>.session.json`, machine-local): list,
 * read, create, and save a session id without losing what else the file says.
 * The rules — what a session's next prompt resumes — are in
 * src/utils/agentSdkSessions.ts.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    isValidSessionName,
    parseSessionRecord,
    planSessionStart,
    sortSessions,
    type SessionMode,
    type SessionRecord,
    type SessionStart,
} from '../utils/agentSdkSessions';

const SUFFIX = '.session.json';

function fileOf(folder: string, name: string): string {
    return path.join(folder, `${name}${SUFFIX}`);
}

export function readSession(folder: string, name: string): SessionRecord | undefined {
    const file = fileOf(folder, name);
    try {
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) { return undefined; }
        return parseSessionRecord(name, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
        return undefined;
    }
}

/** Every session of the folder, sorted by name; unreadable files are skipped. */
export function listSessions(folder: string): SessionRecord[] {
    if (!fs.existsSync(folder)) { return []; }
    const out: SessionRecord[] = [];
    for (const f of fs.readdirSync(folder)) {
        if (!f.endsWith(SUFFIX)) { continue; }
        const r = readSession(folder, f.slice(0, -SUFFIX.length));
        if (r) { out.push(r); }
    }
    return sortSessions(out);
}

function write(folder: string, record: SessionRecord): void {
    fs.mkdirSync(folder, { recursive: true });
    const { name: _name, ...body } = record;
    const file = fileOf(folder, record.name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
}

export type CreateSessionResult = { ok: true; session: SessionRecord } | { ok: false; error: string };

/** Create a session, fresh or based on another one; nothing is overwritten. */
export function createSession(folder: string, name: string, opts: { basedOn?: string; mode?: SessionMode }): CreateSessionResult {
    if (!isValidSessionName(name)) {
        return { ok: false, error: `"${name}" is not a session name: letters, digits, "_" and "-" only, starting with a letter or digit.` };
    }
    if (readSession(folder, name) || fs.existsSync(fileOf(folder, name))) {
        return { ok: false, error: `The session "${name}" already exists.` };
    }
    const mode: SessionMode = opts.mode ?? 'continue';
    if (mode === 'fork-from-base' && !opts.basedOn) {
        return { ok: false, error: `A session re-created from its base for every prompt needs a base (\`basedOn\`).` };
    }
    if (opts.basedOn && !readSession(folder, opts.basedOn)) {
        return { ok: false, error: `There is no session "${opts.basedOn}" to base "${name}" on.` };
    }
    const now = new Date().toISOString();
    const session: SessionRecord = { name, mode, ...(opts.basedOn ? { basedOn: opts.basedOn } : {}), createdAt: now, updatedAt: now };
    write(folder, session);
    return { ok: true, session };
}

/** Save the SDK session id `name` continues, keeping the file's other fields. */
export function saveSessionId(folder: string, name: string, sessionId: string, model?: string): void {
    if (!sessionId) { return; }
    const existing = readSession(folder, name);
    if (existing?.sessionId === sessionId) { return; }
    write(folder, {
        ...(existing ?? { name, mode: 'continue' as const }),
        name,
        sessionId,
        updatedAt: new Date().toISOString(),
        ...(model ? { model } : {}),
    });
}

/**
 * Forget the conversation of `name` (the panel's "clear session"). A file that
 * is only a stored id (the panel's and the queue's own buckets) is removed; a
 * session someone created — by name, with a base or a mode — keeps its
 * definition and starts again from it.
 */
export function clearSessionId(folder: string, name: string): void {
    const existing = readSession(folder, name);
    const file = fileOf(folder, name);
    if (!existing || (!existing.basedOn && existing.mode === 'continue' && !existing.createdAt)) {
        if (fs.existsSync(file)) { fs.unlinkSync(file); }
        return;
    }
    const { sessionId: _dropped, model: _model, ...rest } = existing;
    write(folder, { ...rest, updatedAt: new Date().toISOString() });
}

/** How the next prompt in session `name` starts, from the folder's files. */
export function planSessionStartIn(folder: string, name: string): SessionStart {
    return planSessionStart(name, (n) => readSession(folder, n));
}
