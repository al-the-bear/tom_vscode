/**
 * Quest Logs fragments — two read-only viewers of the @WS accordion panel,
 * sharing one engine (see {@link QUEST_LOG_TABS}):
 *
 *   - the **Logs** section: what one Anthropic session wrote — its live trail
 *     rendered and as source, its prompt/answer pair and the last prompt it
 *     sent — with a session switch (src/utils/sessionSwitch.ts) above the tabs;
 *   - the quest-document sub-tabs of the **Documentation** section: progress /
 *     overview / notes / refresh / doc-update / deferred-steps / questions /
 *     decisions, beside its *Documents* editor.
 *
 * The view is
 * read-only; the toolbar's *Open in editor* button hands the file to a normal
 * text editor when the user wants to change something.
 *
 * Three constraints shape the implementation:
 *
 *   - **The files are large and polled.** The trail alone routinely passes half
 *     a megabyte and the webview refreshes every few seconds, so each request
 *     first compares `size`/`mtime` against what the tab was last sent and
 *     answers `qlogUnchanged` when nothing moved. When it did move, only
 *     `MAX_QUEST_LOG_BYTES` are read — from whichever end of the file its
 *     newest content is at.
 *   - **The content is untrusted.** It quotes user prompts and model answers
 *     verbatim and is assigned with `innerHTML` into a CSP-free accordion, so
 *     both render paths escape (see `questLogMarkdown` / `markdownSourceHighlight`).
 *   - **Files may not exist.** Not every quest has a progress or refresh
 *     document; a missing file is a normal, quietly-reported state.
 *
 * Wired into `wsPanel-handler.ts`, which routes every `qlog*` message here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readMediaText } from '../utils/webviewLoader.js';
import { WsPaths } from '../utils/workspacePaths.js';
import { TwoTierMemoryService } from '../services/memory-service.js';
import { questTrailFolder, sanitizeQuestSegment } from '../utils/questPaths.js';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown.js';
import { highlightMarkdownSource } from '../utils/markdownSourceHighlight.js';
import { currentPromptDir } from '../services/current-prompt-dump.js';
import { listSessions } from '../services/agentSdkSessionStore.js';
import { sessionLiveTrailFile, sessionsWithStorage } from '../services/sessionStorage.js';
import { planSessionSwitch, type SwitchSession } from '../utils/sessionSwitch.js';
import {
    QUEST_LOG_TABS,
    CURRENT_PROMPT_VARIANTS,
    DEFAULT_QUEST_LOG_TAB_ID,
    DEFAULT_QUEST_LOG_VARIANT_ID,
    MAX_QUEST_LOG_BYTES,
    computeTailStart,
    DEFAULT_LOG_SESSION,
    isQuestLogTabId,
    isQuestLogVariantId,
    isSessionTab,
    questLogTabsOf,
    questLogLocation,
    questLogViewKey,
    trimToLineStart,
    trimToLineEnd,
    type QuestLogNewestAt,
    type QuestLogTabId,
    type QuestLogVariantId,
} from '../utils/questLogFiles.js';

// ---------------------------------------------------------------------------
// Fragment assets
// ---------------------------------------------------------------------------

/**
 * HTML for the Logs accordion section: tab strip, toolbar, viewer, status.
 *
 * The variant selector is part of the toolbar but hidden until a tab that has
 * variants is active — only Current Prompt does, and a selector floating above
 * a fixed file would just be a lie.
 */
function tabButtonsHtml(tabs: ReadonlyArray<{ id: string; label: string; icon: string }>): string {
    return tabs.map(tab =>
        `<button class="qlog-tab" data-qlog-tab="${tab.id}" title="${tab.label}">`
        + `<span class="codicon codicon-${tab.icon}"></span>`
        + `<span class="qlog-tab-label">${tab.label}</span></button>`,
    ).join('\n        ');
}

/** The Logs section: the session switch, the per-session tabs, the viewer. */
export function getQuestLogsHtmlFragment(): string {
    const variants = CURRENT_PROMPT_VARIANTS.map(v =>
        `<option value="${v.id}">${v.label}</option>`,
    ).join('\n        ');

    return `
<div class="toolbar qlog-toolbar qlog-session-bar">
    <span class="qlog-session-label">Session:</span>
    <div class="qlog-sessions" id="qlog-sessions"></div>
</div>
<div class="toolbar qlog-toolbar">
    <div class="qlog-tabs" id="qlog-tabs">
        ${tabButtonsHtml(questLogTabsOf('logs'))}
    </div>
    <select class="qlog-variant" id="qlog-variant" title="Which prompt to show" hidden>
        ${variants}
    </select>
    <button class="icon-btn" id="qlog-refresh" title="Refresh from disk"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" id="qlog-open" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
</div>
<div class="qlog-body" id="qlog-body"><div class="qlog-empty">Loading…</div></div>
<div class="status-bar" id="qlog-status">Session logs</div>`;
}

/** The sub-tab of the Documentation section that holds its document editor (not a quest document). */
export const DOCUMENTS_PANE_TAB = 'documents';

/**
 * The Documentation section: a tab strip — *Documents* (the existing editor,
 * `documentsHtml`) then the quest documents — and the quest-document viewer.
 */
export function getQuestDocsHtmlFragment(documentsHtml: string): string {
    const tabs = [{ id: DOCUMENTS_PANE_TAB, label: 'Documents', icon: 'files' }, ...questLogTabsOf('docs')];
    return `
<div class="toolbar qlog-toolbar">
    <div class="qlog-tabs" id="qdoc-tabs">
        ${tabButtonsHtml(tabs)}
    </div>
    <button class="icon-btn" id="qdoc-refresh" title="Refresh from disk"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" id="qdoc-open" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
</div>
<div class="qdoc-pane" id="qdoc-documents-pane">${documentsHtml}</div>
<div class="qlog-body" id="qdoc-body" hidden><div class="qlog-empty">Loading…</div></div>
<div class="status-bar" id="qdoc-status" hidden>Quest documents</div>`;
}

export function getQuestLogsCss(): string {
    return readMediaText('questLogs', 'style.css');
}

/**
 * Client script. The tab catalogue is the same array the HTML was built from,
 * handed to the webview as data so the client never re-derives the tab list.
 */
export function getQuestLogsScript(): string {
    const viewers = [
        {
            id: 'logs', prefix: 'qlog', section: 'logs',
            tabIds: questLogTabsOf('logs').map(t => t.id),
            defaultTab: DEFAULT_QUEST_LOG_TAB_ID,
            sessions: true,
        },
        {
            id: 'docs', prefix: 'qdoc', section: 'documentation',
            tabIds: [DOCUMENTS_PANE_TAB, ...questLogTabsOf('docs').map(t => t.id)],
            defaultTab: DOCUMENTS_PANE_TAB,
            paneTabs: { [DOCUMENTS_PANE_TAB]: 'qdoc-documents-pane' },
            sessions: false,
        },
    ];
    const variantTabsJson = JSON.stringify(QUEST_LOG_TABS.filter(t => t.variants).map(t => t.id));
    const variantIdsJson = JSON.stringify(CURRENT_PROMPT_VARIANTS.map(v => v.id));
    return `\n// ── Quest Logs variables ──\n`
        + `var qlogViewers = ${JSON.stringify(viewers)};\n`
        + `var qlogVariantTabs = ${variantTabsJson};\n`
        + `var qlogVariantIds = ${variantIdsJson};\n`
        + `var qlogDefaultVariant = ${JSON.stringify(DEFAULT_QUEST_LOG_VARIANT_ID)};\n`
        + readMediaText('questLogs', 'main.js');
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/**
 * Absolute path of the file behind a sub-tab, plus the quest it belongs to.
 *
 * The catalogue names the *area*; resolving it to a directory is this
 * function's only real job. `quest` is the quest folder and `questHistory` its
 * `history/` subfolder; `trail` is the quest's Anthropic trail bucket, resolved
 * by the module that writes into it so the two ends of the current-prompt files
 * never derive the path differently.
 */
function resolveQuestLogPath(
    tab: QuestLogTabId,
    variant?: QuestLogVariantId,
    session?: string,
): { questId: string; filePath: string; fileName: string } {
    const questId = activeQuestId();
    const { area, fileName } = questLogLocation(tab, questId, variant, session);

    if (area === 'trail') {
        return { questId: questId || 'default', fileName, filePath: path.join(currentPromptDir(questId), fileName) };
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
    const questFolder = path.join(questsRoot, sanitizeQuestSegment(questId));
    const dir = area === 'questHistory' ? questTrailFolder(questFolder) : questFolder;
    return {
        questId: questId || 'default',
        fileName,
        filePath: path.join(dir, fileName),
    };
}

/**
 * Read at most {@link MAX_QUEST_LOG_BYTES} from the end of the file `newestAt`
 * names — the tail for the appended-to trail, the head for the quest documents,
 * which are prepended to or rewritten wholesale.
 *
 * The slice is bounded by a byte offset, which can land inside a multi-byte
 * character as easily as inside a line — dropping the partial line at the cut
 * end discards both problems at once.
 */
function readQuestLogSlice(
    filePath: string,
    size: number,
    newestAt: QuestLogNewestAt,
): { text: string; truncated: boolean } {
    const length = Math.min(Math.max(size, 0), MAX_QUEST_LOG_BYTES);
    if (length === size) {
        return { text: fs.readFileSync(filePath, 'utf8'), truncated: false };
    }
    const start = newestAt === 'end' ? computeTailStart(size) : 0;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, start);
        const raw = buffer.subarray(0, read).toString('utf8');
        return { text: newestAt === 'end' ? trimToLineStart(raw) : trimToLineEnd(raw), truncated: true };
    } finally {
        fs.closeSync(fd);
    }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

/** What a view was last sent, so an unchanged file costs one `stat` and no read. */
interface QuestLogSnapshot {
    filePath: string;
    size: number;
    mtimeMs: number;
}

/**
 * Keyed by {@link questLogViewKey}, not by tab: the Current Prompt dropdown
 * puts six files behind one tab, and a tab-keyed cache would answer "unchanged"
 * for the variant just selected because a different one had not moved.
 */
const lastSent = new Map<string, QuestLogSnapshot>();

function activeQuestId(): string {
    return WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
}

/**
 * The quest's Anthropic sessions with their last use: the built-in `default`
 * and `chat`, every session file and every session with storage. Last use is
 * the newest of the session file's `updatedAt` and its live trail's change.
 */
function questSessions(): SwitchSession[] {
    const historyRoot = TwoTierMemoryService.instance.historyFolder(activeQuestId() || undefined);
    const byName = new Map<string, number | undefined>();
    const note = (name: string, at: number | undefined): void => {
        const prev = byName.get(name);
        byName.set(name, at === undefined ? prev : Math.max(prev ?? -Infinity, at));
    };
    for (const name of [DEFAULT_LOG_SESSION, 'chat']) { note(name, undefined); }
    try {
        for (const r of listSessions(historyRoot)) {
            const at = Date.parse(r.updatedAt ?? r.createdAt ?? '');
            note(r.name, Number.isFinite(at) ? at : undefined);
        }
    } catch { /* no session files yet */ }
    for (const name of sessionsWithStorage(historyRoot)) {
        let at: number | undefined;
        try { at = fs.statSync(sessionLiveTrailFile(historyRoot, name)).mtimeMs; } catch { /* no live trail yet */ }
        note(name, at);
    }
    return [...byName].map(([name, lastUse]) => ({ name, ...(lastUse !== undefined ? { lastUse } : {}) }));
}

/** The session plan each webview was last sent, so an unchanged list is not re-sent every poll. */
const lastPlan = new WeakMap<vscode.Webview, string>();

/** Handle a `qlog*` message from the @WS webview. */
export async function handleQuestLogsMessage(message: any, webview: vscode.Webview): Promise<void> {
    const tab: QuestLogTabId = isQuestLogTabId(message?.tab) ? message.tab : DEFAULT_QUEST_LOG_TAB_ID;
    const variant: QuestLogVariantId = isQuestLogVariantId(message?.variant)
        ? message.variant
        : DEFAULT_QUEST_LOG_VARIANT_ID;
    const viewer = typeof message?.viewer === 'string' ? message.viewer : 'logs';
    // A Logs tab shows one session: the plan says which (and the webview draws it).
    let session: string | undefined;
    if (isSessionTab(tab)) {
        const plan = planSessionSwitch(questSessions(), typeof message?.session === 'string' ? message.session : undefined, DEFAULT_LOG_SESSION);
        session = plan.selected;
        const json = JSON.stringify(plan);
        if (message?.type === 'qlogRequest' && (message.force || lastPlan.get(webview) !== json)) {
            lastPlan.set(webview, json);
            webview.postMessage({ type: 'qlogSessions', viewer, tab, variant, plan });
        }
    }
    switch (message?.type) {
        case 'qlogRequest':
            sendQuestLogContent(webview, viewer, tab, variant, session, !!message.force);
            return;
        case 'qlogOpenInEditor':
            await openQuestLogInEditor(tab, variant, session);
            return;
    }
}

function sendQuestLogContent(
    webview: vscode.Webview,
    viewer: string,
    tab: QuestLogTabId,
    variant: QuestLogVariantId,
    session: string | undefined,
    force: boolean,
): void {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    const view = entry?.view ?? 'source';
    const newestAt: QuestLogNewestAt = entry?.newestAt ?? 'end';
    const { questId, filePath, fileName } = resolveQuestLogPath(tab, variant, session);
    const key = questLogViewKey(tab, variant, session);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        lastSent.delete(key);
        webview.postMessage({
            type: 'qlogContent', viewer, tab, variant, session, questId, fileName, filePath, newestAt,
            exists: false, html: '', truncated: false, bytes: 0,
        });
        return;
    }

    const previous = lastSent.get(key);
    const unchanged = previous
        && previous.filePath === filePath
        && previous.size === stat.size
        && previous.mtimeMs === stat.mtimeMs;
    if (unchanged && !force) {
        webview.postMessage({ type: 'qlogUnchanged', viewer, tab, variant, session });
        return;
    }

    try {
        const { text, truncated } = readQuestLogSlice(filePath, stat.size, newestAt);
        const html = view === 'rendered'
            ? renderQuestLogMarkdown(text)
            : `<pre class="qlog-source">${highlightMarkdownSource(text)}</pre>`;
        lastSent.set(key, { filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        webview.postMessage({
            type: 'qlogContent', viewer, tab, variant, session, questId, fileName, filePath, newestAt,
            exists: true, html, truncated, bytes: stat.size,
        });
    } catch (err) {
        // A read that fails after a successful stat means the file changed
        // under us (rotated, deleted). Drop the snapshot so the next poll
        // retries rather than reporting the stale content as current.
        lastSent.delete(key);
        webview.postMessage({
            type: 'qlogContent', viewer, tab, variant, session, questId, fileName, filePath, newestAt,
            exists: false, html: '', truncated: false, bytes: 0,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Open the tab's file in a normal text editor. `openTextDocument` +
 * `showTextDocument` is deliberate: `vscode.open` would hand `.md` files to
 * whichever custom editor claims them, and the point of this button is to get
 * at the plain text.
 */
async function openQuestLogInEditor(tab: QuestLogTabId, variant?: QuestLogVariantId, session?: string): Promise<void> {
    const { filePath, fileName, questId } = resolveQuestLogPath(tab, variant, session);
    if (!fs.existsSync(filePath)) {
        vscode.window.showInformationMessage(`Quest "${questId}" has no ${fileName} yet (${filePath}).`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}
