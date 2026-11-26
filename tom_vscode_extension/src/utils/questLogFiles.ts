/**
 * Catalogue of the quest log files shown in the @CHAT panel's **Logs** section,
 * plus the pure helpers the viewer needs to read them cheaply.
 *
 * The files use fixed, derivable names — there is no globbing to do — so the
 * whole sub-tab → file mapping is a lookup table. Keeping it here (free of
 * `vscode` and `fs`) lets the handler stay a thin I/O shell and lets the
 * mapping be pinned down by unit tests.
 *
 * Files live in one of two {@link QuestLogArea}s. Most are quest documents in
 * the quest folder. The Logs tabs read the quest's `history/` folder: this
 * host's trail `trail.<host>.md` (the **Trail** tab, the session's turns,
 * src/utils/sessionTrailTurns.ts) and the session's live trail in its storage.
 *
 * The viewer polls these files every few seconds and some of them are large
 * (the live trail routinely passes half a megabyte), so it reads only
 * {@link MAX_QUEST_LOG_BYTES} of each — the slice taken from whichever end the
 * file's newest content is at (see {@link QuestLogTab.newestAt}), snapped to a
 * line boundary by {@link trimToLineStart} / {@link trimToLineEnd}.
 */

import { MIGRATION_TARGET_SESSION, SESSION_LIVE_TRAIL_FILE, SESSIONS_FOLDER } from '../services/sessionStorage';
import { hostTrailFileName } from '../services/hostTrail';
import { canonicalSessionName } from './runSessions';
import { sanitizeQuestSegment } from './questPaths.js';
import { DEFAULT_QUEST_NOTES_FILE, QUEST_NOTES_FOLDER } from './notesFiles.js';
import { SESSION_NAME_PATTERN } from './agentSdkSessions.js';
import { qaJournalFileName } from './qaJournal.js';
import { hostSlugOf } from './hostSlug.js';

/** Identifier of one Logs sub-tab. */
export type QuestLogTabId =
    | 'turns'
    | 'mdTrail'
    | 'trail'
    | 'progress'
    | 'overview'
    | 'notes'
    | 'refresh'
    | 'docUpdate'
    | 'deferred'
    | 'questions';

/**
 * Which directory a tab's file lives in: the active quest's folder under
 * `_ai/quests/<quest>/`, or that folder's `history/` subfolder. The handler
 * owns the absolute paths; this module only says which applies.
 */
export type QuestLogArea = 'quest' | 'questHistory';

/** Where a tab reads from — the pair the handler joins into a path. */
export interface QuestLogLocation {
    readonly area: QuestLogArea;
    readonly fileName: string;
}

/**
 * How a tab presents its file: `rendered` runs it through the markdown
 * renderer, `source` shows the raw markdown with syntax colouring, `turns`
 * shows the session's turns of the host trail as prompt/answer pairs
 * (src/utils/sessionTrailTurns.ts).
 */
export type QuestLogView = 'rendered' | 'source' | 'turns';

/**
 * Which end of a file holds its newest content. The viewer reads its slice from
 * that end and opens the view scrolled to it.
 */
export type QuestLogNewestAt = 'end' | 'start';

/**
 * Which section shows a tab: `logs` (one session on this machine: its trail
 * and its live trail — with a session switch) or `docs` (the quest's own
 * documents, sub-tabs of Documentation).
 */
export type QuestLogSection = 'logs' | 'docs';

/** One entry of the Logs / Documentation tab strips. */
export interface QuestLogTab {
    readonly id: QuestLogTabId;
    readonly section: QuestLogSection;
    /** Label shown in the tab strip. */
    readonly label: string;
    /** Codicon name (without the `codicon-` prefix). */
    readonly icon: string;
    readonly view: QuestLogView;
    /**
     * Where this file's newest content is — a property of how each file is
     * written, not a display preference. The trail and the two journals
     * (deferred steps, Q&A) are appended to, so they are read
     * from the end; the remaining quest documents are prepended to or rewritten
     * wholesale, so they are read from the start.
     */
    readonly newestAt: QuestLogNewestAt;
}

/**
 * The Logs sub-tabs, in display order. The live trail appears twice on
 * purpose — once rendered for reading, once as source for copying and for the
 * times the rendered view hides the structure you are debugging.
 */
export const QUEST_LOG_TABS: readonly QuestLogTab[] = [
    // Logs: one session on this machine — the session switch picks which.
    // Trail: the session's turns of this host's trail, newest first, prompt then answer.
    { id: 'turns', section: 'logs', label: 'Trail', icon: 'comment-discussion', view: 'turns', newestAt: 'start' },
    { id: 'mdTrail', section: 'logs', label: 'Live Trail', icon: 'preview', view: 'rendered', newestAt: 'end' },
    { id: 'trail', section: 'logs', label: 'Live Source', icon: 'pulse', view: 'source', newestAt: 'end' },
    // Documentation: the quest's own documents, one set for every session.
    { id: 'progress', section: 'docs', label: 'Quest Progress', icon: 'graph', view: 'source', newestAt: 'start' },
    { id: 'overview', section: 'docs', label: 'Quest Overview', icon: 'book', view: 'source', newestAt: 'start' },
    { id: 'notes', section: 'docs', label: 'Quest Notes', icon: 'note', view: 'source', newestAt: 'start' },
    { id: 'refresh', section: 'docs', label: 'Quest Refresh', icon: 'refresh', view: 'source', newestAt: 'start' },
    { id: 'docUpdate', section: 'docs', label: 'DocUpdate', icon: 'file-symlink-file', view: 'source', newestAt: 'start' },
    // The two journals. Unlike their neighbours these are appended to — a
    // deferred step and a Q&A block are added after the ones already there —
    // so they grow at the bottom. Q&A is this host's journal (qa.<host>.<quest>.md);
    // the Q&A page shows every host's.
    { id: 'deferred', section: 'docs', label: 'Deferred', icon: 'bookmark', view: 'source', newestAt: 'end' },
    { id: 'questions', section: 'docs', label: 'Q&A', icon: 'question', view: 'source', newestAt: 'end' },
];

/** The tabs of one section, in display order. */
export function questLogTabsOf(section: QuestLogSection): readonly QuestLogTab[] {
    return QUEST_LOG_TABS.filter(t => t.section === section);
}

/** Whether a tab shows a session's file (the Logs tabs). */
export function isSessionTab(tab: QuestLogTabId): boolean {
    return QUEST_LOG_TABS.find(t => t.id === tab)?.section === 'logs';
}

/** Tab selected when nothing has been persisted yet. */
export const DEFAULT_QUEST_LOG_TAB_ID: QuestLogTabId = 'turns';

/**
 * Upper bound on how much of a log file is read per refresh. These files grow
 * without bound; the viewer only ever shows the newest end of one, so reading
 * more would cost I/O and webview memory for content nobody scrolls to.
 */
export const MAX_QUEST_LOG_BYTES = 256 * 1024;

/** The session the Logs tabs show when none is chosen: the prompt queue's. */
export const DEFAULT_LOG_SESSION = MIGRATION_TARGET_SESSION;

/**
 * A session name a Logs tab may read — the rule of session names, a run's
 * `<session>@<run>` included (SESSION_NAME_PATTERN); anything else falls back
 * to the default. Without the `@` every run's session read `default`'s files.
 */
export function questLogSession(session: string | undefined | null): string {
    // An older build's bare `default` is `default@default` (vscimpb151).
    return typeof session === 'string' && SESSION_NAME_PATTERN.test(session) ? canonicalSessionName(session) : DEFAULT_LOG_SESSION;
}

/** Type guard for values arriving from the webview / persisted state. */
export function isQuestLogTabId(value: unknown): value is QuestLogTabId {
    return typeof value === 'string' && QUEST_LOG_TABS.some(t => t.id === value);
}

/**
 * The area and file name behind a sub-tab. The **Trail** tab's file is this
 * host's trail (the file *Open in editor* opens); its content is the chosen
 * session's turns of it (src/utils/sessionTrailTurns.ts).
 */
export function questLogLocation(
    tab: QuestLogTabId,
    questId: string | undefined | null,
    session?: string,
): QuestLogLocation {
    const quest = sanitizeQuestSegment(questId);
    // The Logs tabs read the chosen session's storage (src/services/sessionStorage.ts).
    const folder = `${SESSIONS_FOLDER}/${questLogSession(session)}`;
    switch (tab) {
        case 'turns':
            return { area: 'questHistory', fileName: hostTrailFileName(hostSlugOf()) };
        case 'mdTrail':
        case 'trail':
            return { area: 'questHistory', fileName: `${folder}/${SESSION_LIVE_TRAIL_FILE}` };
        case 'progress':
            return { area: 'quest', fileName: `progress.${quest}.md` };
        case 'overview':
            return { area: 'quest', fileName: `overview.${quest}.md` };
        case 'notes':
            // The quest's default notes file (utils/notesFiles.ts).
            return { area: 'quest', fileName: `${QUEST_NOTES_FOLDER}/${DEFAULT_QUEST_NOTES_FILE}` };
        case 'refresh':
            return { area: 'quest', fileName: `quest_refresh.${quest}.md` };
        case 'docUpdate':
            return { area: 'quest', fileName: `quest_documentation_update.${quest}.md` };
        case 'deferred':
            return { area: 'quest', fileName: `deferred.${quest}.md` };
        case 'questions':
            // This host's Q&A journal (utils/qaJournal.ts).
            return { area: 'quest', fileName: qaJournalFileName(quest, hostSlugOf()) };
    }
}

/**
 * Identity of what the viewer is currently showing, used as the key of the
 * host's "what did I last send" cache: the tab, and on a Logs tab the session
 * — keyed by tab alone, switching the session would be answered "unchanged"
 * and keep the other session's text.
 */
export function questLogViewKey(tab: QuestLogTabId, session?: string): string {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    return entry?.section === 'logs' ? `${tab}@${questLogSession(session)}` : tab;
}

/**
 * Byte offset at which to start reading a file of `size` bytes so that at most
 * `maxBytes` are read. Returns 0 whenever the whole file fits (including for a
 * nonsensical negative size, which a stat race can produce).
 */
export function computeTailStart(size: number, maxBytes: number = MAX_QUEST_LOG_BYTES): number {
    return Math.max(0, size - maxBytes);
}

/**
 * Drop the leading partial line of a tail slice. Reading from a byte offset
 * almost always lands mid-line, and a half line at the top would be rendered
 * as if it were a whole one. Text with no newline at all is returned unchanged
 * — there is nothing to snap to, and dropping it would show an empty view.
 */
export function trimToLineStart(text: string): string {
    const nl = text.indexOf('\n');
    return nl < 0 ? text : text.slice(nl + 1);
}

/**
 * Drop the trailing partial line of a head slice — the mirror of
 * {@link trimToLineStart} for the files that are read from their start.
 */
export function trimToLineEnd(text: string): string {
    const nl = text.lastIndexOf('\n');
    return nl < 0 ? text : text.slice(0, nl + 1);
}
