/**
 * Catalogue of the quest log files shown in the @WS panel's **Logs** section,
 * plus the pure helpers the viewer needs to read them cheaply.
 *
 * The files use fixed, derivable names — there is no globbing to do — so the
 * whole sub-tab → file mapping is a lookup table. Keeping it here (free of
 * `vscode` and `fs`) lets the handler stay a thin I/O shell and lets the
 * mapping be pinned down by unit tests. The **Current Prompt** writer resolves
 * its file names through this module too ({@link currentPromptFiles}), so the
 * side that writes and the side that reads cannot drift apart — a mismatch
 * there would not fail anywhere, it would just show an empty tab forever.
 *
 * Files live in one of two {@link QuestLogArea}s. Most are quest documents in
 * the quest folder. The Logs tabs read a session's storage under the quest's
 * `history/` folder: its live trail, its summary prompt/answer pair and, in its
 * gitignored `trail/`, the current-prompt files rewritten on every send.
 *
 * The viewer polls these files every few seconds and some of them are large
 * (the live trail routinely passes half a megabyte), so it reads only
 * {@link MAX_QUEST_LOG_BYTES} of each — the slice taken from whichever end the
 * file's newest content is at (see {@link QuestLogTab.newestAt}), snapped to a
 * line boundary by {@link trimToLineStart} / {@link trimToLineEnd}.
 */

import { MIGRATION_TARGET_SESSION, SESSION_LIVE_TRAIL_FILE, SESSION_TRAIL_FOLDER, SESSIONS_FOLDER } from '../services/sessionStorage';
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
    | 'deferred'
    | 'questions'
    | 'decisions'
    | 'currentPrompt';

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
 * renderer, `source` shows the raw markdown with syntax colouring.
 */
export type QuestLogView = 'rendered' | 'source';

/**
 * Which end of a file holds its newest content. The viewer reads its slice from
 * that end and opens the view scrolled to it.
 */
export type QuestLogNewestAt = 'end' | 'start';

/**
 * Which @WS section shows a tab: `logs` (the per-session files: live trail,
 * trail pair, current prompt — with a session switch) or `docs` (the quest's
 * own documents, sub-tabs of Documentation).
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
     * written, not a display preference. The trail and the three journals
     * (deferred steps, questions, decisions) are appended to, so they are read
     * from the end; the remaining quest documents are prepended to or rewritten
     * wholesale, so they are read from the start.
     */
    readonly newestAt: QuestLogNewestAt;
    /**
     * Set when the tab shows one of several files chosen from a dropdown. Only
     * Current Prompt does; for every other tab a tab *is* a file, and the
     * toolbar hides the selector.
     */
    readonly variants?: readonly QuestLogVariant[];
}

// ---------------------------------------------------------------------------
// Current Prompt — the two dimensions of the dropdown
// ---------------------------------------------------------------------------

/**
 * Which running prompt. A queue item and a chat message can be in flight at the
 * same time, so each keeps its own set of files. These are the values of
 * `PromptSource`, which the Anthropic send path already threads through as
 * `options.source`.
 */
export type QuestLogPromptSource = 'chat' | 'queue';

/**
 * Which of the three texts that make up a dispatched prompt:
 *
 *   - `literal` — what the user typed, before placeholder expansion and before
 *     keyword triggers were stripped out.
 *   - `user` — the user message that actually went to the model.
 *   - `system` — the assembled system prompt, empty when the profile has none.
 */
export type QuestLogPromptPart = 'literal' | 'user' | 'system';

/** Identifier of one dropdown option: an origin crossed with a part. */
export type QuestLogVariantId =
    | 'chatLiteral' | 'chatUser' | 'chatSystem'
    | 'queueLiteral' | 'queueUser' | 'queueSystem';

/** One dropdown option, carrying the two dimensions it was built from. */
export interface QuestLogVariant {
    readonly id: QuestLogVariantId;
    readonly label: string;
    readonly source: QuestLogPromptSource;
    readonly part: QuestLogPromptPart;
}

const PROMPT_SOURCES: readonly { source: QuestLogPromptSource; label: string }[] = [
    { source: 'chat', label: 'Chat' },
    { source: 'queue', label: 'Queue' },
];

const PROMPT_PARTS: readonly { part: QuestLogPromptPart; label: string }[] = [
    { part: 'literal', label: 'Literal Prompt' },
    { part: 'user', label: 'User Prompt' },
    { part: 'system', label: 'System Prompt' },
];

/**
 * The six dropdown options — the full product of the two dimensions above,
 * derived rather than listed so an option and its file can never drift apart.
 */
export const CURRENT_PROMPT_VARIANTS: readonly QuestLogVariant[] = PROMPT_SOURCES.flatMap(
    ({ source, label: sourceLabel }) => PROMPT_PARTS.map(({ part, label: partLabel }): QuestLogVariant => ({
        id: `${source}${part[0].toUpperCase()}${part.slice(1)}` as QuestLogVariantId,
        label: `${sourceLabel} ${partLabel}`,
        source,
        part,
    })),
);

/** Option selected when nothing has been persisted yet. */
export const DEFAULT_QUEST_LOG_VARIANT_ID: QuestLogVariantId = 'chatLiteral';

/** File name backing one (origin, part) pair, in a session's trail folder. */
function currentPromptFileName(source: QuestLogPromptSource, part: QuestLogPromptPart): string {
    // No quest id in the name — the quest is already the containing directory,
    // and repeating it would only invite the two to disagree.
    return `current_prompt.${source}.${part}.md`;
}

/** Type guard for dropdown selections arriving from the webview / stored state. */
export function isQuestLogVariantId(value: unknown): value is QuestLogVariantId {
    return typeof value === 'string' && CURRENT_PROMPT_VARIANTS.some(v => v.id === value);
}

/** One file to write, as produced by {@link currentPromptFiles}. */
export interface CurrentPromptFile {
    readonly fileName: string;
    readonly text: string;
}

/** The three texts a single send produces. */
export interface CurrentPromptTexts {
    readonly literal: string;
    readonly user: string;
    readonly system: string;
}

/**
 * The files one send writes: all three parts of the given origin, every time.
 *
 * "Every time" is the contract. An empty system prompt is written as an empty
 * file rather than skipped — skipping it would leave the previous send's system
 * prompt in place and present it as the current one, which is the failure mode
 * that looks like working software.
 */
export function currentPromptFiles(
    source: QuestLogPromptSource,
    texts: CurrentPromptTexts,
): CurrentPromptFile[] {
    return PROMPT_PARTS.map(({ part }) => ({
        fileName: currentPromptFileName(source, part),
        text: texts[part] ?? '',
    }));
}

/**
 * Stand-in for a text the send has not resolved yet.
 *
 * Not the empty string: empty is a legitimate value for the system prompt (a
 * profile without one), and the reader would have no way to tell "this profile
 * has no system prompt" from "we don't know yet".
 */
export const CURRENT_PROMPT_PENDING =
    '(not resolved yet — this send is still waiting on the previous turn'
    + ' before it can expand its user message and assemble its system prompt)\n';

/**
 * The files a send claims when it *starts*, before it knows what it will send.
 *
 * Only the literal is final at that point; the user message still has to be
 * expanded and the system prompt assembled, and both wait on the previous
 * turn's history compaction and memory extraction — a minute or more of real
 * time. Leaving the three files alone until then would keep presenting the
 * previous send as the current one, so all three are replaced here and the two
 * unknowns are filled with {@link CURRENT_PROMPT_PENDING}.
 *
 * Same files, same order as {@link currentPromptFiles}: this is the first of
 * two writes, not a different set.
 */
export function pendingCurrentPromptFiles(
    source: QuestLogPromptSource,
    literal: string,
): CurrentPromptFile[] {
    return currentPromptFiles(source, {
        literal,
        user: CURRENT_PROMPT_PENDING,
        system: CURRENT_PROMPT_PENDING,
    });
}

/**
 * The Logs sub-tabs, in display order. The trail appears twice on purpose —
 * once rendered for reading, once as source for copying and for the times the
 * rendered view hides the structure you are debugging.
 */
export const QUEST_LOG_TABS: readonly QuestLogTab[] = [
    // Logs: what one session wrote — the session switch picks which.
    { id: 'mdTrail', section: 'logs', label: 'MD Trail', icon: 'preview', view: 'rendered', newestAt: 'end' },
    { id: 'trail', section: 'logs', label: 'Trail', icon: 'pulse', view: 'source', newestAt: 'end' },
    { id: 'prompts', section: 'logs', label: 'Prompts', icon: 'comment', view: 'source', newestAt: 'start' },
    { id: 'answers', section: 'logs', label: 'Answers', icon: 'comment-discussion', view: 'source', newestAt: 'start' },
    // The only tab that shows *now* rather than history: the prompt the
    // session last sent, replaced on every send. Its files are rewritten
    // wholesale, so like the quest documents it is read and opened from the top.
    {
        id: 'currentPrompt', section: 'logs', label: 'Current Prompt', icon: 'send',
        view: 'source', newestAt: 'start', variants: CURRENT_PROMPT_VARIANTS,
    },
    // Documentation: the quest's own documents, one set for every session.
    { id: 'progress', section: 'docs', label: 'Quest Progress', icon: 'graph', view: 'source', newestAt: 'start' },
    { id: 'overview', section: 'docs', label: 'Quest Overview', icon: 'book', view: 'source', newestAt: 'start' },
    { id: 'notes', section: 'docs', label: 'Quest Notes', icon: 'note', view: 'source', newestAt: 'start' },
    { id: 'refresh', section: 'docs', label: 'Quest Refresh', icon: 'refresh', view: 'source', newestAt: 'start' },
    { id: 'docUpdate', section: 'docs', label: 'DocUpdate', icon: 'file-symlink-file', view: 'source', newestAt: 'start' },
    // The three journals. Unlike their neighbours these are appended to — a
    // deferred step, an answered question and a recorded decision are all added
    // after the ones already there — so they grow at the bottom.
    { id: 'deferred', section: 'docs', label: 'Deferred', icon: 'bookmark', view: 'source', newestAt: 'end' },
    { id: 'questions', section: 'docs', label: 'Questions', icon: 'question', view: 'source', newestAt: 'end' },
    { id: 'decisions', section: 'docs', label: 'Decisions', icon: 'checklist', view: 'source', newestAt: 'end' },
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
export const DEFAULT_QUEST_LOG_TAB_ID: QuestLogTabId = 'mdTrail';

/**
 * Upper bound on how much of a log file is read per refresh. These files grow
 * without bound; the viewer only ever shows the newest end of one, so reading
 * more would cost I/O and webview memory for content nobody scrolls to.
 */
export const MAX_QUEST_LOG_BYTES = 256 * 1024;

/** The session the Logs tabs show when none is chosen: the prompt queue's. */
export const DEFAULT_LOG_SESSION = MIGRATION_TARGET_SESSION;

/** A session name a Logs tab may read (the rule of session names; anything else falls back to the default). */
function safeSession(session: string | undefined | null): string {
    return typeof session === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session) ? session : DEFAULT_LOG_SESSION;
}

/** Type guard for values arriving from the webview / persisted state. */
export function isQuestLogTabId(value: unknown): value is QuestLogTabId {
    return typeof value === 'string' && QUEST_LOG_TABS.some(t => t.id === value);
}

/**
 * The area and file name behind a Logs sub-tab — the single mapping both the
 * viewer and the current-prompt writer resolve through.
 *
 * `variant` only applies to a tab that declares {@link QuestLogTab.variants};
 * elsewhere it is ignored. Because it arrives from the webview (a live
 * selection or one persisted by an older build), an unrecognised value falls
 * back to {@link DEFAULT_QUEST_LOG_VARIANT_ID} rather than throwing — a stale
 * selection should show the default file, not break the panel.
 */
export function questLogLocation(
    tab: QuestLogTabId,
    questId: string | undefined | null,
    variant?: QuestLogVariantId,
    session?: string,
): QuestLogLocation {
    const quest = sanitizeQuestSegment(questId);
    // The Logs tabs read the chosen session's storage (src/services/sessionStorage.ts).
    const folder = `${SESSIONS_FOLDER}/${safeSession(session)}`;
    switch (tab) {
        case 'mdTrail':
        case 'trail':
            return { area: 'questHistory', fileName: `${folder}/${SESSION_LIVE_TRAIL_FILE}` };
        case 'prompts':
            return { area: 'questHistory', fileName: `${folder}/${quest}.anthropic.prompts.md` };
        case 'answers':
            return { area: 'questHistory', fileName: `${folder}/${quest}.anthropic.answers.md` };
        case 'progress':
            return { area: 'quest', fileName: `progress.${quest}.md` };
        case 'overview':
            return { area: 'quest', fileName: `overview.${quest}.md` };
        case 'notes':
            return { area: 'quest', fileName: `quest-notes.${quest}.md` };
        case 'refresh':
            return { area: 'quest', fileName: `quest_refresh.${quest}.md` };
        case 'docUpdate':
            return { area: 'quest', fileName: `quest_documentation_update.${quest}.md` };
        case 'deferred':
            return { area: 'quest', fileName: `deferred.${quest}.md` };
        case 'questions':
            return { area: 'quest', fileName: `questions.${quest}.md` };
        case 'decisions':
            return { area: 'quest', fileName: `decisions.${quest}.md` };
        case 'currentPrompt': {
            // The session's own copy, in its trail folder (current-prompt-dump.ts).
            const id = isQuestLogVariantId(variant) ? variant : DEFAULT_QUEST_LOG_VARIANT_ID;
            const entry = CURRENT_PROMPT_VARIANTS.find(v => v.id === id)!;
            return { area: 'questHistory', fileName: `${folder}/${SESSION_TRAIL_FOLDER}/${currentPromptFileName(entry.source, entry.part)}` };
        }
    }
}

/**
 * Identity of what the viewer is currently showing, used as the key of the
 * host's "what did I last send" cache.
 *
 * A tab used to be a file, so the tab id was key enough. The Current Prompt
 * dropdown breaks that: keyed by tab alone, the host would answer "unchanged"
 * for one variant because a different one had not moved, and five of the six
 * options would never load.
 */
export function questLogViewKey(tab: QuestLogTabId, variant?: QuestLogVariantId, session?: string): string {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    const base = entry?.variants ? `${tab}:${isQuestLogVariantId(variant) ? variant : DEFAULT_QUEST_LOG_VARIANT_ID}` : tab;
    // A Logs tab is one file per session: keyed by tab alone, switching the
    // session would be answered "unchanged" and keep the other session's text.
    return entry?.section === 'logs' ? `${base}@${safeSession(session)}` : base;
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
