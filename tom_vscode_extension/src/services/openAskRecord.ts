/**
 * An ask that survives a window reload (vscimpb166).
 *
 * While a queue item's turn waits in an ask tool — `tomAi_askUser`,
 * `tomAi_askUserPicker`, `tomAi_askInMdBrowser` — the call (the tool and its
 * input) is recorded on the item and persisted in its entry file (`open-ask`);
 * it is removed when the tool returns. A reload ends the turn but not the
 * record: the queue (promptQueueManager `_applyCrashRecoveryTo`) keeps such an
 * item `sending` instead of resetting it, runs the same tool again for the item
 * (the "Waiting for you" panel, the picker, the MD Browser come back as they
 * were), and sends its answer into the item's session as the continuation of
 * the turn ({@link openAskContinuationPrompt}).
 *
 * A send of the @CHAT panel (a chat item, status `chat`) is recorded the same
 * way; after the reload its ask is shown again and the answer goes out as a new
 * chat send in the same session and run ({@link setOpenAskChatSender}); the
 * session resumes the conversation the interrupted turn ran in.
 *
 * The queue registers the store ({@link setOpenAskStore}); the live tools call
 * through {@link recordingAsk}, and the queue runs a restored call through the
 * runner the tool executors register ({@link setOpenAskRunner}).
 *
 * vscode-free.
 */

import { currentQueueItemId } from './userWaits';

/** The ask tools whose open call survives a reload. */
export const OPEN_ASK_TOOLS = ['tomAi_askUser', 'tomAi_askUserPicker', 'tomAi_askInMdBrowser'] as const;
export type OpenAskTool = (typeof OPEN_ASK_TOOLS)[number];

/** An open ask as the queue item keeps it. */
export interface OpenAskRecord {
    tool: OpenAskTool;
    /** The tool's input, as the turn called it. */
    input: Record<string, unknown>;
    /** The window that shows it (the window-status id); a reload or another window takes it over. */
    windowId: string;
    /** When the turn called the tool (ISO). */
    startedAt: string;
}

/** Where the records live: the queue items. */
export interface OpenAskStore {
    /** Record the open call on item `itemId` (only a sending queue item keeps one). */
    record(itemId: string, call: { tool: OpenAskTool; input: Record<string, unknown> }): void;
    /** The call returned: drop the record. */
    clear(itemId: string): void;
}

let store: OpenAskStore | undefined;
let runner: ((tool: OpenAskTool, input: Record<string, unknown>) => Promise<string>) | undefined;
let shuttingDown = false;
const liveHere = new Set<string>();
let chatSender: ((p: { text: string; session?: string; run?: string }) => Promise<void>) | undefined;

/**
 * How a chat send's continuation goes out (a panel send that waited in an ask when the window reloaded): the
 * extension registers the chat send path (runAnthropicSend) here.
 */
export function setOpenAskChatSender(s: ((p: { text: string; session?: string; run?: string }) => Promise<void>) | undefined): void { chatSender = s; }

/** Send a chat continuation; false when no chat send path is registered. */
export async function sendOpenAskChatContinuation(p: { text: string; session?: string; run?: string }): Promise<boolean> {
    if (!chatSender) { return false; }
    await chatSender(p);
    return true;
}

/** The queue registers where the records go. */
export function setOpenAskStore(s: OpenAskStore | undefined): void { store = s; }

/** The tool executors register how a recorded call runs again. */
export function setOpenAskRunner(r: ((tool: OpenAskTool, input: Record<string, unknown>) => Promise<string>) | undefined): void { runner = r; }

/** The recorded call run again (a restore); undefined when no runner is registered. */
export function runOpenAskTool(tool: OpenAskTool, input: Record<string, unknown>): Promise<string> | undefined {
    return runner?.(tool, input);
}

/**
 * The window is going down (deactivate): the asks its shutdown closes keep
 * their record, so the reloaded window finds them.
 */
export function markShuttingDown(): void { shuttingDown = true; }

/** Whether item `itemId`'s ask is open in this extension host (not one a reload left behind). */
export function isAskLiveHere(itemId: string): boolean { return liveHere.has(itemId); }

/** A tool name that is one of the ask tools. */
export function isOpenAskTool(name: unknown): name is OpenAskTool {
    return typeof name === 'string' && (OPEN_ASK_TOOLS as readonly string[]).includes(name);
}

/**
 * Run an ask tool's call, recorded on the queue item whose turn makes it while
 * it is open. Outside a queue item's turn (the chat panel, a script) nothing is
 * recorded.
 */
export async function recordingAsk<T>(tool: OpenAskTool, input: unknown, fn: () => Promise<T>): Promise<T> {
    const itemId = currentQueueItemId();
    if (!itemId || !store) { return fn(); }
    const s = store;
    try { s.record(itemId, { tool, input: toRecordInput(input) }); } catch { /* the ask still runs */ }
    liveHere.add(itemId);
    let result: T;
    try {
        result = await fn();
    } catch (err) {
        if (shuttingDown) { return holdUntilGone<T>(); }
        liveHere.delete(itemId);
        try { s.clear(itemId); } catch { /* best effort */ }
        throw err;
    }
    // A call closed by the window's shutdown stays recorded, and its turn does not go on with the closing note
    // (it would finish the item before the window is gone): the reload restores the ask.
    if (shuttingDown) { return holdUntilGone<T>(); }
    liveHere.delete(itemId);
    try { s.clear(itemId); } catch { /* best effort */ }
    return result;
}

/** Never settles: the turn waits until the extension host is gone. */
function holdUntilGone<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
}

function toRecordInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object') { return {}; }
    try { return JSON.parse(JSON.stringify(input)) as Record<string, unknown>; } catch { return {}; }
}

/** A recorded ask read back from an entry file (`open-ask`); undefined when it is not one. */
export function parseOpenAskRecord(raw: unknown): OpenAskRecord | undefined {
    if (!raw || typeof raw !== 'object') { return undefined; }
    const r = raw as Record<string, unknown>;
    if (!isOpenAskTool(r.tool) || !r.input || typeof r.input !== 'object') { return undefined; }
    return {
        tool: r.tool,
        input: r.input as Record<string, unknown>,
        windowId: typeof r['window-id'] === 'string' ? r['window-id'] : '',
        startedAt: typeof r['started-at'] === 'string' ? r['started-at'] : '',
    };
}

/** A record as the entry file keeps it. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- the entry file's YAML keys
export function openAskRecordToYaml(r: OpenAskRecord): Record<string, unknown> {
    return { tool: r.tool, input: r.input, 'window-id': r.windowId, 'started-at': r.startedAt };
}

/**
 * Whether this window restores the ask: it is this window's own, or the window
 * that showed it is gone (reloaded or closed). A live other window keeps it.
 */
export function shouldRestoreOpenAsk(record: OpenAskRecord, ownWindowId: string, liveWindowIds: ReadonlySet<string>): boolean {
    return record.windowId === ownWindowId || !record.windowId || !liveWindowIds.has(record.windowId);
}

/** What the turn asked, as text (the questions, the picker's items, the document and its buttons). */
export function describeOpenAsk(record: OpenAskRecord): string {
    const i = record.input;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const lines: string[] = [];
    if (str(i.title)) { lines.push(`Title: ${str(i.title)}`); }
    if (record.tool === 'tomAi_askUser') {
        const questions = Array.isArray(i.questions) ? i.questions.map(String) : [];
        questions.forEach((q, n) => lines.push(`${n + 1}. ${q}`));
    } else if (record.tool === 'tomAi_askUserPicker') {
        if (str(i.prompt)) { lines.push(`Prompt: ${str(i.prompt)}`); }
        const items = Array.isArray(i.items) ? i.items : [];
        lines.push(`Items: ${items.map((it) => (typeof it === 'string' ? it : str((it as Record<string, unknown>)?.label))).filter(Boolean).join(' | ')}`);
        if (i.canPickMany === true) { lines.push('(several could be picked)'); }
    } else {
        lines.push(`Document: ${str(i.filePath)}`);
        const buttons = Array.isArray(i.buttons) ? i.buttons : [];
        const labels = buttons.map((b) => str((b as Record<string, unknown>)?.label) || str((b as Record<string, unknown>)?.id)).filter(Boolean);
        if (labels.length) { lines.push(`Buttons: ${labels.join(' | ')}`); }
        for (const flag of ['finishReviewRound', 'reopenDecision', 'gateDecision']) {
            if (i[flag] === true) { lines.push(`${flag}: true`); }
        }
    }
    return lines.join('\n');
}

/**
 * The prompt that continues the turn a reload ended: the agent learns that its
 * turn ended while it waited, what it asked and what the user answered, and
 * goes on from there in the same session.
 */
export function openAskContinuationPrompt(record: OpenAskRecord, answer: string): string {
    return [
        `[The VS Code window was reloaded while you were waiting in ${record.tool} for the user's answer. ` +
        'The reload ended your turn, but your question stayed open and the user has answered it now. ' +
        'This prompt continues your conversation in the same session and process run: carry on from where you were, with this answer.]',
        '',
        `What you asked (${record.tool}):`,
        '',
        describeOpenAsk(record).split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        `What ${record.tool} answered:`,
        '',
        answer,
    ].join('\n');
}
