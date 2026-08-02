/**
 * Catalogue of the quest log files shown in the @WS panel's **Logs** section,
 * plus the pure helpers the viewer needs to read them cheaply.
 *
 * The quest folder uses fixed, derivable file names — there is no globbing to
 * do — so the whole sub-tab → file mapping is a lookup table. Keeping it here
 * (free of `vscode` and `fs`) lets the handler stay a thin I/O shell and lets
 * the mapping be pinned down by unit tests.
 *
 * The viewer polls these files every few seconds and some of them are large
 * (the live trail routinely passes half a megabyte), so it reads only
 * {@link MAX_QUEST_LOG_BYTES} of each — the slice taken from whichever end the
 * file's newest content is at (see {@link QuestLogTab.newestAt}), snapped to a
 * line boundary by {@link trimToLineStart} / {@link trimToLineEnd}.
 */

import { sanitizeQuestSegment } from './questPaths.js';

/** Identifier of one Logs sub-tab. */
export type QuestLogTabId =
    | 'mdTrail'
    | 'trail'
    | 'prompts'
    | 'answers'
    | 'progress'
    | 'overview'
    | 'notes'
    | 'refresh'
    | 'docUpdate'
    | 'deferred';

/**
 * How a tab presents its file: `rendered` runs it through the markdown
 * renderer, `source` shows the raw markdown with syntax colouring.
 */
export type QuestLogView = 'rendered' | 'source';

/**
 * Which end of a file holds its newest content. The viewer reads its slice from
 * that end and opens the view scrolled to it.
 */
export type QuestLogNewestAt = 'end' | 'start';

/** One entry of the Logs tab strip. */
export interface QuestLogTab {
    readonly id: QuestLogTabId;
    /** Label shown in the tab strip. */
    readonly label: string;
    /** Codicon name (without the `codicon-` prefix). */
    readonly icon: string;
    readonly view: QuestLogView;
    /**
     * Where this file's newest content is — a property of how each file is
     * written, not a display preference. The trail and the deferred-steps
     * document are appended to, so they are read from the end; the remaining
     * quest documents are prepended to or rewritten wholesale, so they are read
     * from the start.
     */
    readonly newestAt: QuestLogNewestAt;
}

/**
 * The Logs sub-tabs, in display order. The trail appears twice on purpose —
 * once rendered for reading, once as source for copying and for the times the
 * rendered view hides the structure you are debugging.
 */
export const QUEST_LOG_TABS: readonly QuestLogTab[] = [
    { id: 'mdTrail', label: 'MD Trail', icon: 'preview', view: 'rendered', newestAt: 'end' },
    { id: 'trail', label: 'Trail', icon: 'pulse', view: 'source', newestAt: 'end' },
    { id: 'prompts', label: 'Prompts', icon: 'comment', view: 'source', newestAt: 'start' },
    { id: 'answers', label: 'Answers', icon: 'comment-discussion', view: 'source', newestAt: 'start' },
    { id: 'progress', label: 'Progress', icon: 'graph', view: 'source', newestAt: 'start' },
    { id: 'overview', label: 'Overview', icon: 'book', view: 'source', newestAt: 'start' },
    { id: 'notes', label: 'Notes', icon: 'note', view: 'source', newestAt: 'start' },
    { id: 'refresh', label: 'Refresh', icon: 'refresh', view: 'source', newestAt: 'start' },
    { id: 'docUpdate', label: 'DocUpdate', icon: 'file-symlink-file', view: 'source', newestAt: 'start' },
    // Deferred steps are added *after* the ones already recorded, so unlike its
    // neighbours this document grows at the bottom.
    { id: 'deferred', label: 'Deferred', icon: 'bookmark', view: 'source', newestAt: 'end' },
];

/** Tab selected when nothing has been persisted yet. */
export const DEFAULT_QUEST_LOG_TAB_ID: QuestLogTabId = 'mdTrail';

/**
 * Upper bound on how much of a log file is read per refresh. These files grow
 * without bound; the viewer only ever shows the newest end of one, so reading
 * more would cost I/O and webview memory for content nobody scrolls to.
 */
export const MAX_QUEST_LOG_BYTES = 256 * 1024;

/** Type guard for values arriving from the webview / persisted state. */
export function isQuestLogTabId(value: unknown): value is QuestLogTabId {
    return typeof value === 'string' && QUEST_LOG_TABS.some(t => t.id === value);
}

/** File name (relative to the quest folder) backing a Logs sub-tab. */
export function questLogFileName(tab: QuestLogTabId, questId: string | undefined | null): string {
    const quest = sanitizeQuestSegment(questId);
    switch (tab) {
        case 'mdTrail':
        case 'trail':
            return 'live-trail.md';
        case 'prompts':
            return `${quest}.anthropic.prompts.md`;
        case 'answers':
            return `${quest}.anthropic.answers.md`;
        case 'progress':
            return `progress.${quest}.md`;
        case 'overview':
            return `overview.${quest}.md`;
        case 'notes':
            return `quest-notes.${quest}.md`;
        case 'refresh':
            return `quest_refresh.${quest}.md`;
        case 'docUpdate':
            return `quest_documentation_update.${quest}.md`;
        case 'deferred':
            return `completion_steps.${quest}.md`;
    }
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
