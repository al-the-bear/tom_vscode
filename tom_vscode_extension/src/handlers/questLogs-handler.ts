/**
 * Quest Logs fragment — the **Logs** section of the @WS accordion panel.
 *
 * Presents the active quest's log-style markdown files as a strip of sub-tabs
 * (see {@link QUEST_LOG_TABS}): the live trail rendered, the same trail as
 * highlighted source, the Anthropic prompt/answer trails, and the quest's
 * progress / overview / notes / refresh / doc-update / deferred-steps
 * documents. The view is
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
import { sanitizeQuestSegment } from '../utils/questPaths.js';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown.js';
import { highlightMarkdownSource } from '../utils/markdownSourceHighlight.js';
import {
    QUEST_LOG_TABS,
    DEFAULT_QUEST_LOG_TAB_ID,
    MAX_QUEST_LOG_BYTES,
    computeTailStart,
    isQuestLogTabId,
    questLogFileName,
    trimToLineStart,
    trimToLineEnd,
    type QuestLogNewestAt,
    type QuestLogTabId,
} from '../utils/questLogFiles.js';

// ---------------------------------------------------------------------------
// Fragment assets
// ---------------------------------------------------------------------------

/** HTML for the Logs accordion section: tab strip, toolbar, viewer, status. */
export function getQuestLogsHtmlFragment(): string {
    const tabs = QUEST_LOG_TABS.map(tab =>
        `<button class="qlog-tab" data-qlog-tab="${tab.id}" title="${tab.label}">`
        + `<span class="codicon codicon-${tab.icon}"></span>`
        + `<span class="qlog-tab-label">${tab.label}</span></button>`,
    ).join('\n        ');

    return `
<div class="toolbar qlog-toolbar">
    <div class="qlog-tabs" id="qlog-tabs">
        ${tabs}
    </div>
    <button class="icon-btn" id="qlog-refresh" title="Refresh from disk"><span class="codicon codicon-refresh"></span></button>
    <button class="icon-btn" id="qlog-open" title="Open in editor"><span class="codicon codicon-go-to-file"></span></button>
</div>
<div class="qlog-body" id="qlog-body"><div class="qlog-empty">Loading…</div></div>
<div class="status-bar" id="qlog-status">Quest logs</div>`;
}

export function getQuestLogsCss(): string {
    return readMediaText('questLogs', 'style.css');
}

/**
 * Client script. The tab catalogue is the same array the HTML was built from,
 * handed to the webview as data so the client never re-derives the tab list.
 */
export function getQuestLogsScript(): string {
    const tabsJson = JSON.stringify(QUEST_LOG_TABS.map(t => t.id));
    return `\n// ── Quest Logs variables ──\n`
        + `var qlogTabIds = ${tabsJson};\n`
        + `var qlogDefaultTab = ${JSON.stringify(DEFAULT_QUEST_LOG_TAB_ID)};\n`
        + readMediaText('questLogs', 'main.js');
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/** Absolute path of the file behind a sub-tab, plus the quest it belongs to. */
function resolveQuestLogPath(tab: QuestLogTabId): { questId: string; filePath: string; fileName: string } {
    const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
    const fileName = questLogFileName(tab, questId);
    return {
        questId: questId || 'default',
        fileName,
        filePath: path.join(questsRoot, sanitizeQuestSegment(questId), fileName),
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

/** What a tab was last sent, so an unchanged file costs one `stat` and no read. */
interface QuestLogSnapshot {
    filePath: string;
    size: number;
    mtimeMs: number;
}

const lastSent = new Map<QuestLogTabId, QuestLogSnapshot>();

/** Handle a `qlog*` message from the @WS webview. */
export async function handleQuestLogsMessage(message: any, webview: vscode.Webview): Promise<void> {
    const tab: QuestLogTabId = isQuestLogTabId(message?.tab) ? message.tab : DEFAULT_QUEST_LOG_TAB_ID;
    switch (message?.type) {
        case 'qlogRequest':
            sendQuestLogContent(webview, tab, !!message.force);
            return;
        case 'qlogOpenInEditor':
            await openQuestLogInEditor(tab);
            return;
    }
}

function sendQuestLogContent(webview: vscode.Webview, tab: QuestLogTabId, force: boolean): void {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    const view = entry?.view ?? 'source';
    const newestAt: QuestLogNewestAt = entry?.newestAt ?? 'end';
    const { questId, filePath, fileName } = resolveQuestLogPath(tab);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        lastSent.delete(tab);
        webview.postMessage({
            type: 'qlogContent', tab, questId, fileName, filePath, newestAt,
            exists: false, html: '', truncated: false, bytes: 0,
        });
        return;
    }

    const previous = lastSent.get(tab);
    const unchanged = previous
        && previous.filePath === filePath
        && previous.size === stat.size
        && previous.mtimeMs === stat.mtimeMs;
    if (unchanged && !force) {
        webview.postMessage({ type: 'qlogUnchanged', tab });
        return;
    }

    try {
        const { text, truncated } = readQuestLogSlice(filePath, stat.size, newestAt);
        const html = view === 'rendered'
            ? renderQuestLogMarkdown(text)
            : `<pre class="qlog-source">${highlightMarkdownSource(text)}</pre>`;
        lastSent.set(tab, { filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        webview.postMessage({
            type: 'qlogContent', tab, questId, fileName, filePath, newestAt,
            exists: true, html, truncated, bytes: stat.size,
        });
    } catch (err) {
        // A read that fails after a successful stat means the file changed
        // under us (rotated, deleted). Drop the snapshot so the next poll
        // retries rather than reporting the stale content as current.
        lastSent.delete(tab);
        webview.postMessage({
            type: 'qlogContent', tab, questId, fileName, filePath, newestAt,
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
async function openQuestLogInEditor(tab: QuestLogTabId): Promise<void> {
    const { filePath, fileName, questId } = resolveQuestLogPath(tab);
    if (!fs.existsSync(filePath)) {
        vscode.window.showInformationMessage(`Quest "${questId}" has no ${fileName} yet (${filePath}).`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}
