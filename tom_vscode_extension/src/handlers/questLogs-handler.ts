/**
 * Quest Logs fragments — two read-only viewers sharing one engine (see {@link QUEST_LOG_TABS}):
 *
 *   - the **Logs** section of @CHAT: one Anthropic session on this machine — its
 *     turns of this host's trail as prompt/answer pairs (the Trail tab,
 *     src/utils/sessionTrailTurns.ts) and its live trail rendered and as
 *     source — with a session switch (src/utils/sessionSwitch.ts) above the tabs;
 *   - the quest-document sub-tabs of the @WS **Documentation** section: progress /
 *     overview / notes / refresh / doc-update / deferred-steps / Q&A (this host's
 *     journal), beside its *Documents* editor.
 *
 * The view is
 * read-only; the toolbar's *Open in editor* button hands the file to a normal
 * text editor when the user wants to change something.
 *
 * Three constraints shape the implementation:
 *
 *   - **The files are large and polled.** The trail alone routinely passes half
 *     a megabyte and the webview refreshes every few seconds, so each request
 *     first compares `size`/`mtime` (the Trail tab: of every file it reads)
 *     against what the tab was last sent and answers `qlogUnchanged` when
 *     nothing moved. When it did move, only
 *     `MAX_QUEST_LOG_BYTES` are read — from whichever end of the file its
 *     newest content is at.
 *   - **The content is untrusted.** It quotes user prompts and model answers
 *     verbatim and is assigned with `innerHTML` into a CSP-free accordion, so
 *     both render paths escape (see `questLogMarkdown` / `markdownSourceHighlight`).
 *   - **Files may not exist.** Not every quest has a progress or refresh
 *     document; a missing file is a normal, quietly-reported state.
 *
 * Wired into `chatPanel-handler.ts` (the Logs viewer: the fragment and config go
 * in its init data, the client script is loaded as a file) and `wsPanel-handler.ts`
 * (the Documentation viewer, inlined); both route every `qlog*` message here.
 */

import { layoutWorkspaceFolder } from '../utils/workspaceLayout';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readMediaText } from '../utils/webviewLoader.js';
import { WsPaths } from '../utils/workspacePaths.js';
import { TwoTierMemoryService } from '../services/memory-service.js';
import { questTrailFolder, sanitizeQuestSegment } from '../utils/questPaths.js';
import { resolveDefaultQuestNotes } from '../utils/notesFiles.js';
import { renderQuestLogMarkdown } from '../utils/questLogMarkdown.js';
import { highlightMarkdownSource } from '../utils/markdownSourceHighlight.js';
import { listSessions } from '../services/agentSdkSessionStore.js';
import { sessionLiveTrailFile, sessionRoot, sessionsWithStorage } from '../services/sessionStorage.js';
import { readHostTrail } from '../services/hostTrail.js';
import { hostSlugOf } from '../utils/hostSlug.js';
import {
    olderSessionPairFiles,
    readOlderSessionPairs,
    renderSessionTrailHtml,
    sessionTrailTurnMarkdown,
    sessionTrailTurnTitle,
    sessionTrailTurns,
    type SessionTrailTurn,
} from '../utils/sessionTrailTurns.js';
import { planSessionSwitch, type SwitchSession } from '../utils/sessionSwitch.js';
import { runQueueSession } from '../utils/runSessions.js';
import {
    QUEST_LOG_TABS,
    DEFAULT_QUEST_LOG_TAB_ID,
    MAX_QUEST_LOG_BYTES,
    computeTailStart,
    DEFAULT_LOG_SESSION,
    isQuestLogTabId,
    isSessionTab,
    questLogTabsOf,
    questLogLocation,
    questLogSession,
    questLogViewKey,
    trimToLineStart,
    trimToLineEnd,
    type QuestLogNewestAt,
    type QuestLogTabId,
} from '../utils/questLogFiles.js';
import { CHAT_SESSION_ACTIONS, runChatSessionAction, type ChatSessionAction } from './chatPanel-handler';

// ---------------------------------------------------------------------------
// Fragment assets
// ---------------------------------------------------------------------------

/** The tab strip's buttons. */
function tabButtonsHtml(tabs: ReadonlyArray<{ id: string; label: string; icon: string }>): string {
    return tabs.map(tab =>
        `<button class="qlog-tab" data-qlog-tab="${tab.id}" title="${tab.label}">`
        + `<span class="codicon codicon-${tab.icon}"></span>`
        + `<span class="qlog-tab-label">${tab.label}</span></button>`,
    ).join('\n        ');
}

/** The Logs section: the session switch, the per-session tabs, the viewer. */
export function getQuestLogsHtmlFragment(): string {
    return `
<div class="toolbar qlog-toolbar qlog-session-bar">
    <span class="qlog-session-label">Session:</span>
    <div class="qlog-sessions" id="qlog-sessions"></div>
</div>
<div class="toolbar qlog-toolbar">
    <div class="qlog-tabs" id="qlog-tabs">
        ${tabButtonsHtml(questLogTabsOf('logs'))}
    </div>
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

/** A viewer of the engine: `logs` (the @CHAT Logs section) or `docs` (the @WS Documentation section). */
export type QuestLogViewerId = 'logs' | 'docs';

/**
 * The client's configuration — the global media/questLogs/main.js reads
 * (`qlogViewers`) — for the viewers a panel hosts. The tab catalogue is the
 * same array the HTML was built from, so the client never re-derives the tab list.
 */
export function getQuestLogsClientConfig(viewerIds: readonly QuestLogViewerId[] = ['logs', 'docs']): {
    viewers: unknown[];
} {
    const all = {
        logs: {
            id: 'logs', prefix: 'qlog', section: 'logs',
            tabIds: questLogTabsOf('logs').map(t => t.id),
            defaultTab: DEFAULT_QUEST_LOG_TAB_ID,
            sessions: true,
        },
        docs: {
            id: 'docs', prefix: 'qdoc', section: 'documentation',
            tabIds: [DOCUMENTS_PANE_TAB, ...questLogTabsOf('docs').map(t => t.id)],
            defaultTab: DOCUMENTS_PANE_TAB,
            paneTabs: { [DOCUMENTS_PANE_TAB]: 'qdoc-documents-pane' },
            sessions: false,
        },
    };
    return { viewers: viewerIds.map(id => all[id]) };
}

/**
 * Client script for a panel that inlines it (the @WS accordion): the config
 * lines, then the static body. The @CHAT panel loads the body as a file and
 * hands the config over in its init data instead.
 */
export function getQuestLogsScript(viewerIds: readonly QuestLogViewerId[] = ['logs', 'docs']): string {
    const cfg = getQuestLogsClientConfig(viewerIds);
    return `\n// ── Quest Logs variables ──\n`
        + `var qlogViewers = ${JSON.stringify(cfg.viewers)};\n`
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
 * `history/` subfolder, which holds this host's trail and every session's storage.
 */
function resolveQuestLogPath(
    tab: QuestLogTabId,
    session?: string,
): { questId: string; filePath: string; fileName: string } {
    const questId = activeQuestId();
    const { area, fileName } = questLogLocation(tab, questId, session);

    const questFolder = activeQuestFolder(questId);
    const dir = area === 'questHistory' ? questTrailFolder(questFolder) : questFolder;
    if (tab === 'notes') {
        // The default notes file, through the one rule that also knows the old place.
        const notes = resolveDefaultQuestNotes(path.join(dir, ...fileName.split('/')), questFolder, sanitizeQuestSegment(questId));
        return { questId: questId || 'default', fileName: path.basename(notes.filePath), filePath: notes.filePath };
    }
    // A session's file is in its storage folder, which sessionRoot decides (this host's
    // `history/<host>/sessions/<s>/`, or its old place `history/sessions/<s>/`).
    const inSession = area === 'questHistory' ? /^sessions\/([^/]+)\/(.+)$/.exec(fileName) : null;
    if (inSession) {
        return { questId: questId || 'default', fileName, filePath: path.join(sessionRoot(dir, inSession[1]), ...inSession[2].split('/')) };
    }
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

/**
 * What a view was last sent, so an unchanged file costs one `stat` and no
 * read: the file and the `size:mtime` of every file the view reads (the Trail
 * tab reads this host's trail and, OLD PLACE, the session's older pair).
 */
interface QuestLogSnapshot {
    filePath: string;
    signature: string;
}

/** Keyed by {@link questLogViewKey}: the tab, and on a Logs tab the session. */
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

/**
 * The session the Logs tabs show when none is chosen: the queue session of the
 * window's run (`default@<run>` in a run, the queue default in `default`),
 * else `default`.
 */
function windowRunLogSession(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProcessStateStore } = require('../managers/processStateStore.js') as typeof import('../managers/processStateStore');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PromptQueueManager } = require('../managers/promptQueueManager.js') as typeof import('../managers/promptQueueManager');
        const run = ProcessStateStore.instance?.currentRun;
        return runQueueSession(PromptQueueManager.instance.runQueueSettings(run).defaultAgentSdkSession, run) || DEFAULT_LOG_SESSION;
    } catch {
        return DEFAULT_LOG_SESSION;
    }
}

/** The session plan each webview was last sent, so an unchanged list is not re-sent every poll. */
const lastPlan = new WeakMap<vscode.Webview, string>();

/** The quest folder `_ai/quests/<quest>/` of the window's quest. */
function activeQuestFolder(questId: string): string {
    const wsRoot = layoutWorkspaceFolder() ?? '';
    const questsRoot = WsPaths.ai('quests') ?? path.join(wsRoot, WsPaths.aiFolder, 'quests');
    return path.join(questsRoot, sanitizeQuestSegment(questId));
}

/**
 * The Trail tab's turns of `session` in the quest at `questFolder`: its view
 * of this host's trail, plus (OLD PLACE) the older turns of its summary pair
 * of an older build. Other hosts' trails are not read.
 */
export function sessionTrailTurnsOf(questFolder: string, questId: string, session: string): SessionTrailTurn[] {
    const historyRoot = questTrailFolder(questFolder);
    const olderPairs = readOlderSessionPairs(historyRoot, sanitizeQuestSegment(questId), session);
    return sessionTrailTurns(readHostTrail(questFolder, hostSlugOf()), session, olderPairs);
}

/** The files the Trail tab of `session` reads: this host's trail, then (OLD PLACE) the session's older pair. */
function sessionTrailFiles(questFolder: string, questId: string, session: string): string[] {
    const older = olderSessionPairFiles(questTrailFolder(questFolder), sanitizeQuestSegment(questId), session);
    return [path.join(questTrailFolder(questFolder), questLogLocation('turns', questId).fileName), older.prompts, older.answers];
}

/** `size:mtime` of each file, `-` for a missing one. */
function filesSignature(files: readonly string[]): string {
    return files.map((f) => {
        try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
    }).join('|');
}

/** Handle a `qlog*` message from the @WS webview. */
export async function handleQuestLogsMessage(message: any, webview: vscode.Webview): Promise<void> {
    const tab: QuestLogTabId = isQuestLogTabId(message?.tab) ? message.tab : DEFAULT_QUEST_LOG_TAB_ID;
    const viewer = typeof message?.viewer === 'string' ? message.viewer : 'logs';
    // A Logs tab shows one session: the plan says which (and the webview draws it).
    let session: string | undefined;
    if (isSessionTab(tab)) {
        const plan = planSessionSwitch(questSessions(), typeof message?.session === 'string' ? message.session : undefined, windowRunLogSession());
        session = plan.selected;
        const json = JSON.stringify(plan);
        if (message?.type === 'qlogRequest' && (message.force || lastPlan.get(webview) !== json)) {
            lastPlan.set(webview, json);
            webview.postMessage({ type: 'qlogSessions', viewer, tab, plan });
        }
    }
    switch (message?.type) {
        case 'qlogRequest':
            sendQuestLogContent(webview, viewer, tab, session, !!message.force);
            return;
        case 'qlogOpenInEditor':
            await openQuestLogInEditor(tab, session);
            return;
        case 'qlogSessionAction': {
            // The trail / history / memory buttons behind the session switch:
            // the chat panel's action for the selected session.
            const action = String(message?.action || '') as ChatSessionAction;
            if (session && CHAT_SESSION_ACTIONS.includes(action)) {
                await runChatSessionAction(action, session);
            }
            return;
        }
        case 'qlogTurnAction':
            // A Trail tab pair's button: copy, Markdown overlay, open in its trail file.
            if (session) { await runTurnAction(webview, viewer, tab, session, String(message?.action || ''), String(message?.turn || '')); }
            return;
        case 'qlogGotoTodo': {
            // A todo reference of a Trail tab pair's answer.
            const { gotoWorkspaceTodo } = await import('./trailViewer-handler.js');
            await gotoWorkspaceTodo(String(message?.todo || ''));
            return;
        }
    }
}

/** Run a Trail tab pair's action on turn `turnId` of `session`. */
async function runTurnAction(webview: vscode.Webview, viewer: string, tab: QuestLogTabId, session: string, action: string, turnId: string): Promise<void> {
    const questId = activeQuestId();
    const questFolder = activeQuestFolder(questId);
    const turn = sessionTrailTurnsOf(questFolder, questId, questLogSession(session)).find((t) => t.id === turnId);
    if (!turn) {
        vscode.window.showInformationMessage(`The turn ${turnId} of session "${session}" is not in this machine's trail any more.`);
        return;
    }
    switch (action) {
        case 'copyPrompt':
        case 'copyAnswer':
            await vscode.env.clipboard.writeText(action === 'copyPrompt' ? turn.prompt : turn.answer);
            vscode.window.setStatusBarMessage(action === 'copyPrompt' ? 'Prompt copied' : 'Answer copied', 2000);
            return;
        case 'markdown':
            webview.postMessage({
                type: 'qlogMarkdown', viewer, tab, session,
                title: sessionTrailTurnTitle(turn), html: renderQuestLogMarkdown(sessionTrailTurnMarkdown(turn)),
            });
            return;
        case 'open':
            await openTurnInTrailFile(questFolder, questId, session, turn);
            return;
    }
}

/**
 * Open the file a turn is in at its block: this host's trail at the turn's
 * header line; OLD PLACE: an older build's turn in the session's answers file
 * at its `=== ANSWER <id>` line (else its prompts file).
 */
async function openTurnInTrailFile(questFolder: string, questId: string, session: string, turn: SessionTrailTurn): Promise<void> {
    const candidates: Array<{ file: string; match: (line: string) => boolean }> = [];
    if (turn.olderBuild) {
        const older = olderSessionPairFiles(questTrailFolder(questFolder), sanitizeQuestSegment(questId), questLogSession(session));
        candidates.push(
            { file: older.answers, match: (l) => l.startsWith(`=== ANSWER ${turn.id} `) },
            { file: older.prompts, match: (l) => l.startsWith(`=== PROMPT ${turn.id} `) },
        );
    } else {
        candidates.push({
            file: path.join(questTrailFolder(questFolder), questLogLocation('turns', questId).fileName),
            match: (l) => l.startsWith('<!--tom-trail-turn ') && l.includes(`"id":${JSON.stringify(turn.id)}`),
        });
    }
    for (const c of candidates) {
        let lines: string[];
        try { lines = fs.readFileSync(c.file, 'utf-8').split('\n'); } catch { continue; }
        const at = lines.findIndex(c.match);
        if (at < 0) { continue; }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(c.file));
        const position = new vscode.Position(at, 0);
        await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(position, position) });
        return;
    }
    vscode.window.showInformationMessage(`The turn ${turn.id} was not found in its trail file.`);
}

function sendQuestLogContent(
    webview: vscode.Webview,
    viewer: string,
    tab: QuestLogTabId,
    session: string | undefined,
    force: boolean,
): void {
    const entry = QUEST_LOG_TABS.find(t => t.id === tab);
    const view = entry?.view ?? 'source';
    const newestAt: QuestLogNewestAt = entry?.newestAt ?? 'end';
    const { questId, filePath, fileName } = resolveQuestLogPath(tab, session);
    const key = questLogViewKey(tab, session);
    const post = (fields: Record<string, unknown>): void => {
        webview.postMessage({ type: 'qlogContent', viewer, tab, session, questId, fileName, filePath, newestAt, ...fields });
    };

    if (view === 'turns') {
        // The session's turns of this host's trail (and, OLD PLACE, its older pair): built, not read as one file.
        const name = questLogSession(session);
        const quest = activeQuestId();
        const questFolder = activeQuestFolder(quest);
        const signature = filesSignature(sessionTrailFiles(questFolder, quest, name));
        const previous = lastSent.get(key);
        if (!force && previous && previous.filePath === filePath && previous.signature === signature) {
            webview.postMessage({ type: 'qlogUnchanged', viewer, tab, session });
            return;
        }
        try {
            const turns = sessionTrailTurnsOf(questFolder, quest, name);
            lastSent.set(key, { filePath, signature });
            let bytes = 0;
            try { bytes = fs.statSync(filePath).size; } catch { /* no trail on this machine yet */ }
            post({ exists: true, html: renderSessionTrailHtml(name, turns), truncated: false, bytes, turns: turns.length });
        } catch (err) {
            lastSent.delete(key);
            post({ exists: false, html: '', truncated: false, bytes: 0, error: err instanceof Error ? err.message : String(err) });
        }
        return;
    }

    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch {
        lastSent.delete(key);
        post({ exists: false, html: '', truncated: false, bytes: 0 });
        return;
    }

    const signature = `${stat.size}:${stat.mtimeMs}`;
    const previous = lastSent.get(key);
    if (!force && previous && previous.filePath === filePath && previous.signature === signature) {
        webview.postMessage({ type: 'qlogUnchanged', viewer, tab, session });
        return;
    }

    try {
        const { text, truncated } = readQuestLogSlice(filePath, stat.size, newestAt);
        const html = view === 'rendered'
            ? renderQuestLogMarkdown(text)
            : `<pre class="qlog-source">${highlightMarkdownSource(text)}</pre>`;
        lastSent.set(key, { filePath, signature });
        post({ exists: true, html, truncated, bytes: stat.size });
    } catch (err) {
        // A read that fails after a successful stat means the file changed
        // under us (rotated, deleted). Drop the snapshot so the next poll
        // retries rather than reporting the stale content as current.
        lastSent.delete(key);
        post({ exists: false, html: '', truncated: false, bytes: 0, error: err instanceof Error ? err.message : String(err) });
    }
}

/**
 * Open the tab's file in a normal text editor (the Trail tab: this host's
 * trail). `openTextDocument` + `showTextDocument` is deliberate: `vscode.open`
 * would hand `.md` files to whichever custom editor claims them, and the
 * point of this button is to get at the plain text.
 */
async function openQuestLogInEditor(tab: QuestLogTabId, session?: string): Promise<void> {
    const { filePath, fileName, questId } = resolveQuestLogPath(tab, session);
    if (!fs.existsSync(filePath)) {
        vscode.window.showInformationMessage(`Quest "${questId}" has no ${fileName} yet (${filePath}).`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
}
