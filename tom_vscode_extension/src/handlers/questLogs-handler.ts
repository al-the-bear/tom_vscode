/**
 * Quest Logs fragment — the **Logs** section of the @WS accordion panel.
 *
 * Presents the active quest's log-style markdown files as a strip of sub-tabs
 * (see {@link QUEST_LOG_TABS}): the live trail rendered, the same trail as
 * highlighted source, the Anthropic prompt/answer trails, and the quest's
 * progress / overview / notes / refresh / doc-update / deferred-steps /
 * questions / decisions documents. The view is
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
import { currentPromptDir } from '../services/current-prompt-dump.js';
import {
    QUEST_LOG_TABS,
    CURRENT_PROMPT_VARIANTS,
    DEFAULT_QUEST_LOG_TAB_ID,
    DEFAULT_QUEST_LOG_VARIANT_ID,
    MAX_QUEST_LOG_BYTES,
    computeTailStart,
    isQuestLogTabId,
    isQuestLogVariantId,
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
export function getQuestLogsHtmlFragment(): string {
    const tabs = QUEST_LOG_TABS.map(tab =>
        `<button class="qlog-tab" data-qlog-tab="${tab.id}" title="${tab.label}">`
        + `<span class="codicon codicon-${tab.icon}"></span>`
        + `<span class="qlog-tab-label">${tab.label}</span></button>`,
    ).join('\n        ');

    const variants = CURRENT_PROMPT_VARIANTS.map(v =>
        `<option value="${v.id}">${v.label}</option>`,
    ).join('\n        ');

    return `
<div class="toolbar qlog-toolbar">
    <div class="qlog-tabs" id="qlog-tabs">
        ${tabs}
    </div>
    <select class="qlog-variant" id="qlog-variant" title="Which prompt to show" hidden>
        ${variants}
    </select>
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
    const variantTabsJson = JSON.stringify(QUEST_LOG_TABS.filter(t => t.variants).map(t => t.id));
    const variantIdsJson = JSON.stringify(CURRENT_PROMPT_VARIANTS.map(v => v.id));
    return `\n// ── Quest Logs variables ──\n`
        + `var qlogTabIds = ${tabsJson};\n`
        + `var qlogDefaultTab = ${JSON.stringify(DEFAULT_QUEST_LOG_TAB_ID)};\n`
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
 * function's only real job. `quest` is the quest folder; `trail` is the quest's
 * Anthropic trail bucket, resolved by the module that writes into it so the two
 * ends of the current-prompt files never derive the path differently.
 */
function resolveQuestLogPath(
    tab: QuestLogTabId,
    variant?: QuestLogVariantId,
): { questId: string; filePath: string; fileName: string } {
    const questId = WsPaths.getWorkspaceQuestId() ?? TwoTierMemoryService.instance.currentQuest() ?? '';
    const { area, fileName } = questLogLocation(tab, questId, variant);

    if (area === 'trail') {
        return { questId: questId || 'default', fileName, filePath: path.join(currentPromptDir(questId), fileName) };
    }

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
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

/** Handle a `qlog*` message from the @WS webview. */
export async function handleQuestLogsMessage(message: any, webview: vscode.Webview): Promise<void> {
    const tab: QuestLogTabId = isQuestLogTabId(message?.tab) ? message.tab : DEFAULT_QUEST_LOG_TAB_ID;
    const variant: QuestLogVariantId = isQuestLogVariantId(message?.variant)
        ? message.variant
        : DEFAULT_QUEST_LOG_VARIANT_ID;
    switch (message?.type) {
        case 'qlogRequest':
            sendQuestLogContent(webview, tab, variant, !!message.force);
            return;
        case 'qlogOpenInEditor':
            await openQuestLogInEditor(tab, variant);
            return;
    }
}

function sendQuestLogContent(
    webview: vscode.Webview,
    tab: QuestLogTabId,
    variant: QuestLogVariantId,
    force: boolean,
): void {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    const view = entry?.view ?? 'source';
    const newestAt: QuestLogNewestAt = entry?.newestAt ?? 'end';
    const { questId, filePath, fileName } = resolveQuestLogPath(tab, variant);
    const key = questLogViewKey(tab, variant);

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        lastSent.delete(key);
        webview.postMessage({
            type: 'qlogContent', tab, variant, questId, fileName, filePath, newestAt,
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
        webview.postMessage({ type: 'qlogUnchanged', tab, variant });
        return;
    }

    try {
        const { text, truncated } = readQuestLogSlice(filePath, stat.size, newestAt);
        const html = view === 'rendered'
            ? renderQuestLogMarkdown(text)
            : `<pre class="qlog-source">${highlightMarkdownSource(text)}</pre>`;
        lastSent.set(key, { filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        webview.postMessage({
            type: 'qlogContent', tab, variant, questId, fileName, filePath, newestAt,
            exists: true, html, truncated, bytes: stat.size,
        });
    } catch (err) {
        // A read that fails after a successful stat means the file changed
        // under us (rotated, deleted). Drop the snapshot so the next poll
        // retries rather than reporting the stale content as current.
        lastSent.delete(key);
        webview.postMessage({
            type: 'qlogContent', tab, variant, questId, fileName, filePath, newestAt,
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
async function openQuestLogInEditor(tab: QuestLogTabId, variant?: QuestLogVariantId): Promise<void> {
    const { filePath, fileName, questId } = resolveQuestLogPath(tab, variant);
    if (!fs.existsSync(filePath)) {
        vscode.window.showInformationMessage(`Quest "${questId}" has no ${fileName} yet (${filePath}).`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}
