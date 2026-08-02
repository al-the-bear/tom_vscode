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
 * (the live trail routinely passes half a megabyte), so it reads only the last
 * {@link MAX_QUEST_LOG_BYTES} — see {@link computeTailStart} and
 * {@link trimToLineStart}.
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
    | 'docUpdate';

/**
 * How a tab presents its file: `rendered` runs it through the markdown
 * renderer, `source` shows the raw markdown with syntax colouring.
 */
export type QuestLogView = 'rendered' | 'source';

/** One entry of the Logs tab strip. */
export interface QuestLogTab {
    readonly id: QuestLogTabId;
    /** Label shown in the tab strip. */
    readonly label: string;
    /** Codicon name (without the `codicon-` prefix). */
    readonly icon: string;
    readonly view: QuestLogView;
}

/**
 * The Logs sub-tabs, in display order. The trail appears twice on purpose —
 * once rendered for reading, once as source for copying and for the times the
 * rendered view hides the structure you are debugging.
 */
export const QUEST_LOG_TABS: readonly QuestLogTab[] = [
    { id: 'mdTrail', label: 'MD Trail', icon: 'preview', view: 'rendered' },
    { id: 'trail', label: 'Trail', icon: 'pulse', view: 'source' },
    { id: 'prompts', label: 'Prompts', icon: 'comment', view: 'source' },
    { id: 'answers', label: 'Answers', icon: 'comment-discussion', view: 'source' },
    { id: 'progress', label: 'Progress', icon: 'graph', view: 'source' },
    { id: 'overview', label: 'Overview', icon: 'book', view: 'source' },
    { id: 'notes', label: 'Notes', icon: 'note', view: 'source' },
    { id: 'refresh', label: 'Refresh', icon: 'refresh', view: 'source' },
    { id: 'docUpdate', label: 'DocUpdate', icon: 'file-symlink-file', view: 'source' },
];

/** Tab selected when nothing has been persisted yet. */
export const DEFAULT_QUEST_LOG_TAB_ID: QuestLogTabId = 'mdTrail';

/**
 * Upper bound on how much of a log file is read per refresh. The live trail
 * grows without bound; the viewer only ever shows its end, so reading more
 * would cost I/O and webview memory for content nobody scrolls back to.
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
