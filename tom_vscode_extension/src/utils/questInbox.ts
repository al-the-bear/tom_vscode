/**
 * The queue inbox: how a prompt reaches the queue of another quest's window
 * on this machine (tomAi_sendItemToQuest).
 *
 * The sender writes `<host>_<workspace>_<yymmdd_hhmmss>-<token>.inbox.queue.yaml`
 * into the shared queue folder, atomically (a dot-named temporary file renamed
 * into place), holding only what the sender says: the text and the optional
 * template, profile, done-notification prompt, pause-after flag and session.
 * The target window takes it up on its folder watcher, in the health check and
 * at start:
 *
 *   1. it CLAIMS the file by renaming it to `<file>.claimed-<claimant>`, so a
 *      second window on the same quest finds it gone and leaves it alone
 *      (a rename is atomic; the loser gets ENOENT);
 *   2. turns it into a normal queue item with its own queue defaults
 *      ({@link planInboxConversion}) and deletes the claimed file.
 *
 * A claim left behind by a window that stopped between the two steps is
 * claimed again once it is older than {@link STALE_CLAIM_MS}.
 *
 * vscode-free (fs and yaml only), so every rule here is tested directly.
 */

import * as fs from 'fs';
import * as path from 'path';

import { isValidSessionName, normalizeSessionMode, type SessionMode, type SessionRecord } from './agentSdkSessions';
import { sanitizeFilePart, sanitizeHostnameForFile } from './queueStep5Utils';

export const INBOX_SUFFIX = '.inbox.queue.yaml';
const CLAIM_MARK = '.claimed-';
const REJECTED_SUFFIX = '.rejected';
/** A claim older than this was left by a window that stopped mid-way; it is taken again. */
export const STALE_CLAIM_MS = 2 * 60_000;
/** The placeholder a sent prompt (and its done-notification prompt) can name its sender's quest with. */
export const SENDER_QUEST_PLACEHOLDER = '${senderQuest}';

/** Who sent an inbox item. */
export interface InboxSender {
    quest: string;
    windowId: string;
    host: string;
    sentAt: string;
}

/** A new session in the target quest, based on one it has. */
export interface InboxNewSession {
    basedOn: string;
    /** Unset: a temporary session, deleted once the item and its notification are done. */
    name?: string;
    lifetime?: SessionMode;
    /** Anthropic profile id the session is created with. */
    profile?: string;
}

/** What the sender says about the item; everything else is the target queue's default. */
export interface InboxItem {
    text: string;
    template?: string;
    anthropicProfileId?: string;
    doneNotificationPrompt?: string;
    pauseAfter?: boolean;
    /** An existing session of the target quest. */
    session?: string;
    newSession?: InboxNewSession;
    from: InboxSender;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** The file-name prefix of every inbox file for the windows of `workspace` on `host`. */
export function inboxFilePrefix(host: string, workspace: string): string {
    return `${sanitizeHostnameForFile(host)}_${sanitizeFilePart(workspace || 'default')}_`;
}

function stamp(now: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** `<host>_<workspace>_<yymmdd_hhmmss>-<token>.inbox.queue.yaml`. */
export function inboxFileName(host: string, workspace: string, now: Date, token: string): string {
    return `${inboxFilePrefix(host, workspace)}${stamp(now)}-${sanitizeFilePart(token)}${INBOX_SUFFIX}`;
}

/** The name of a temporary session: `tmp-<yymmdd-hhmmss>-<token>`. */
export function temporarySessionName(now: Date, token: string): string {
    return `tmp-${stamp(now).replace('_', '-')}-${sanitizeFilePart(token)}`;
}

// ---------------------------------------------------------------------------
// The file's content
// ---------------------------------------------------------------------------

function yaml(): typeof import('yaml') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('yaml');
}

/** The file's YAML: kebab-case keys like the queue entry files; unset fields left out. */
export function serializeInboxItem(item: InboxItem): string {
    const doc: Record<string, unknown> = {
        inbox: 1,
        from: { quest: item.from.quest, 'window-id': item.from.windowId, host: item.from.host, 'sent-at': item.from.sentAt },
        text: item.text,
    };
    if (item.template) { doc.template = item.template; }
    if (item.anthropicProfileId) { doc['anthropic-profile-id'] = item.anthropicProfileId; }
    if (item.doneNotificationPrompt) { doc['done-notification-prompt'] = item.doneNotificationPrompt; }
    if (item.pauseAfter) { doc['pause-after'] = true; }
    if (item.session) { doc.session = item.session; }
    if (item.newSession) {
        const n = item.newSession;
        doc['new-session'] = {
            'based-on': n.basedOn,
            ...(n.name ? { name: n.name } : {}),
            ...(n.lifetime ? { lifetime: n.lifetime } : {}),
            ...(n.profile ? { profile: n.profile } : {}),
        };
    }
    return yaml().stringify(doc, { lineWidth: 120 });
}

export type ParsedInboxItem = { ok: true; item: InboxItem } | { ok: false; error: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Read an inbox file's content; refuses one without text or sender, or with a malformed session. */
export function parseInboxItem(content: string): ParsedInboxItem {
    let raw: unknown;
    try { raw = yaml().parse(content); } catch (e) { return { ok: false, error: `not YAML: ${(e as Error).message}` }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, error: 'not an inbox item' }; }
    const r = raw as Record<string, unknown>;
    const text = str(r.text);
    if (!text) { return { ok: false, error: 'the item has no text' }; }
    const f = (r.from && typeof r.from === 'object' ? r.from : {}) as Record<string, unknown>;
    const quest = str(f.quest);
    if (!quest) { return { ok: false, error: 'the item names no sender quest' }; }
    const item: InboxItem = {
        text,
        from: { quest, windowId: str(f['window-id']) ?? '', host: str(f.host) ?? '', sentAt: str(f['sent-at']) ?? '' },
    };
    if (str(r.template)) { item.template = str(r.template); }
    if (str(r['anthropic-profile-id'])) { item.anthropicProfileId = str(r['anthropic-profile-id']); }
    if (str(r['done-notification-prompt'])) { item.doneNotificationPrompt = str(r['done-notification-prompt']); }
    if (r['pause-after'] === true) { item.pauseAfter = true; }
    if (r.session !== undefined) {
        const session = str(r.session);
        if (!session || !isValidSessionName(session)) { return { ok: false, error: `"${String(r.session)}" is not a session name` }; }
        item.session = session;
    }
    if (r['new-session'] !== undefined) {
        if (item.session) { return { ok: false, error: 'the item names both a session and a new session' }; }
        const n = (r['new-session'] && typeof r['new-session'] === 'object' ? r['new-session'] : {}) as Record<string, unknown>;
        const basedOn = str(n['based-on']);
        if (!basedOn) { return { ok: false, error: 'a new session needs the session it is based on' }; }
        const lifetime = n.lifetime === undefined ? undefined : normalizeSessionMode(n.lifetime);
        if (n.lifetime !== undefined && !lifetime) { return { ok: false, error: `"${String(n.lifetime)}" is not a session lifetime` }; }
        item.newSession = {
            basedOn,
            ...(str(n.name) ? { name: str(n.name) } : {}),
            ...(lifetime ? { lifetime } : {}),
            ...(str(n.profile) ? { profile: str(n.profile) } : {}),
        };
    }
    return { ok: true, item };
}

// ---------------------------------------------------------------------------
// Writing, listing, claiming
// ---------------------------------------------------------------------------

/** Write the item atomically: a dot-named temporary file (no watcher pattern matches it), renamed into place. */
export function writeInboxFile(folder: string, fileName: string, item: InboxItem): string {
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, fileName);
    const temp = path.join(folder, `.${fileName}.tmp`);
    fs.writeFileSync(temp, serializeInboxItem(item), 'utf-8');
    fs.renameSync(temp, target);
    return target;
}

/** The unclaimed inbox files of `workspace` on `host`, oldest first. */
export function listInboxFiles(folder: string, host: string, workspace: string): string[] {
    const prefix = inboxFilePrefix(host, workspace);
    try {
        return fs.readdirSync(folder).filter((f) => f.startsWith(prefix) && f.endsWith(INBOX_SUFFIX)).sort();
    } catch { return []; }
}

/** Claims of `workspace` on `host` older than `staleMs`: left by a window that stopped before finishing. */
export function listStaleClaims(folder: string, host: string, workspace: string, nowMs: number, staleMs = STALE_CLAIM_MS): string[] {
    const prefix = inboxFilePrefix(host, workspace);
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { return []; }
    return names.filter((f) => {
        if (!f.startsWith(prefix) || !f.includes(INBOX_SUFFIX + CLAIM_MARK)) { return false; }
        try { return nowMs - fs.statSync(path.join(folder, f)).mtimeMs > staleMs; } catch { return false; }
    }).sort();
}

/** The inbox file name a (possibly claimed) file name started as. */
export function unclaimedName(fileName: string): string {
    const at = fileName.indexOf(INBOX_SUFFIX + CLAIM_MARK);
    return at < 0 ? fileName : fileName.slice(0, at + INBOX_SUFFIX.length);
}

/**
 * Claim `fileName` for `claimant` by renaming it; the claimed path, or
 * undefined when another window took it first (the file is gone).
 */
export function claimInboxFile(folder: string, fileName: string, claimant: string): string | undefined {
    const claimed = path.join(folder, `${unclaimedName(fileName)}${CLAIM_MARK}${sanitizeFilePart(claimant)}`);
    try {
        fs.renameSync(path.join(folder, fileName), claimed);
        // A re-claimed stale file keeps its old time; touch it so it is not stale at once.
        const now = new Date();
        fs.utimesSync(claimed, now, now);
        return claimed;
    } catch {
        return undefined;
    }
}

/** Set a claimed file that cannot be read aside, so it is not taken again: `<inbox file>.rejected`. */
export function rejectClaimedFile(claimedPath: string): string {
    const target = path.join(path.dirname(claimedPath), unclaimedName(path.basename(claimedPath)) + REJECTED_SUFFIX);
    fs.renameSync(claimedPath, target);
    return target;
}

// ---------------------------------------------------------------------------
// Conversion into a queue item
// ---------------------------------------------------------------------------

/** What the target window needs to know to convert an item. */
export interface InboxConversionContext {
    profileExists(id: string): boolean;
    readSession(name: string): SessionRecord | undefined;
    now: Date;
    /** Makes a temporary session's name unique. */
    token: string;
}

/** How the target window creates the item's new session before queuing it. */
export interface InboxSessionToCreate {
    name: string;
    basedOn: string;
    mode: SessionMode;
    /** Unset: the base's (createSession inherits it). */
    profile?: string;
    temporary: boolean;
}

/** The queue item an inbox item becomes; `error` set when it is queued as failed. */
export interface InboxConversion {
    enqueue: {
        originalText: string;
        template?: string;
        transport?: 'anthropic';
        anthropicProfileId?: string;
        session?: string;
        pauseAfter?: boolean;
        doneNotificationPrompt?: string;
        from: InboxSender;
        temporarySession?: boolean;
    };
    createSession?: InboxSessionToCreate;
    /** Why the item cannot run: it is queued as an error, so its done-notification still tells the sender. */
    error?: string;
}

function fillSender(text: string | undefined, quest: string): string | undefined {
    return text === undefined ? undefined : text.split(SENDER_QUEST_PLACEHOLDER).join(quest);
}

/**
 * The queue item an inbox item becomes in the target window. What the sender
 * did not say is left unset, so the target's queue defaults apply exactly as
 * for an item added there. `${senderQuest}` in the text and the
 * done-notification prompt becomes the sender's quest. A profile or session
 * the target does not have makes the item an error (queued, so its
 * done-notification still reaches the sender).
 */
export function planInboxConversion(item: InboxItem, ctx: InboxConversionContext): InboxConversion {
    const enqueue: InboxConversion['enqueue'] = {
        originalText: fillSender(item.text, item.from.quest) ?? '',
        ...(item.template ? { template: item.template } : {}),
        ...(item.anthropicProfileId ? { transport: 'anthropic' as const, anthropicProfileId: item.anthropicProfileId } : {}),
        ...(item.pauseAfter ? { pauseAfter: true } : {}),
        ...(item.doneNotificationPrompt ? { doneNotificationPrompt: fillSender(item.doneNotificationPrompt, item.from.quest) } : {}),
        from: item.from,
    };
    if (item.anthropicProfileId && !ctx.profileExists(item.anthropicProfileId)) {
        return { enqueue, error: `There is no Anthropic profile "${item.anthropicProfileId}" in this workspace.` };
    }
    if (item.session) {
        if (!ctx.readSession(item.session)) {
            return { enqueue, error: `This quest has no session "${item.session}".` };
        }
        return { enqueue: { ...enqueue, session: item.session } };
    }
    const n = item.newSession;
    if (!n) { return { enqueue }; }
    const base = ctx.readSession(n.basedOn);
    if (!base) { return { enqueue, error: `This quest has no session "${n.basedOn}" to base the new session on.` }; }
    if (n.profile && !ctx.profileExists(n.profile)) {
        return { enqueue, error: `There is no Anthropic profile "${n.profile}" in this workspace.` };
    }
    const temporary = !n.name;
    const name = n.name ?? temporarySessionName(ctx.now, ctx.token);
    if (!isValidSessionName(name)) { return { enqueue, error: `"${name}" is not a session name.` }; }
    if (ctx.readSession(name)) { return { enqueue, error: `The session "${name}" already exists.` }; }
    // The profile: the one given, else the base's (inherited), else the item's own.
    const profile = n.profile ?? (base.profileId ? undefined : item.anthropicProfileId);
    return {
        enqueue: { ...enqueue, session: name, ...(temporary ? { temporarySession: true } : {}) },
        createSession: { name, basedOn: n.basedOn, mode: n.lifetime ?? 'continue', ...(profile ? { profile } : {}), temporary },
    };
}
