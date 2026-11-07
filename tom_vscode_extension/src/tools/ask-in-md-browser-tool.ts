/**
 * `tomAi_askInMdBrowser` — an agent asks through a document: the file opens in
 * the MD Browser with the agent's buttons (`{id, label}`) and a *Keep this
 * file* checkbox (on by default) in the top area, and the tool blocks until a
 * button is clicked.
 *
 * It behaves like `tomAi_askUser`: the round awaits the answer, so the prompt
 * queue is held while it waits; one such ask is open at a time; there is no
 * deadline unless the model asks for one (`timeoutMinutes`) or the user's
 * standing ceiling (`maxWaitMinutes`) sets one. The answer is
 * `{button, keepFile, ...}`; when the box is unchecked as the flow goes on —
 * a click, a timeout, the panel closed — the file is deleted.
 *
 * vscode-free: the MD Browser side (open the panel with the bar, take it off,
 * close the panel, delete the file) comes in through {@link AskInMdBrowserDeps};
 * the live wiring is in `handlers/markdownBrowser-handler.ts`.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';
import { resolveAskTimeoutMs } from '../utils/askTimeout';
import { QuestionLogEntry } from '../utils/questionsLogFormat';

/** At most this many buttons in the bar. */
export const MAX_ASK_MD_BUTTONS = 8;

export interface AskMdButton {
    id: string;
    label: string;
}

/** What the webview's top area shows while the ask is open. */
export interface AskMdBar {
    requestId: string;
    title?: string;
    buttons: AskMdButton[];
    keepFile: boolean;
    /** Epoch ms the timeout fires; undefined: no deadline. */
    timeoutAt?: number;
}

export type AskMdSource = 'click' | 'timeout' | 'closed' | 'cancel';

type TimerHandle = ReturnType<typeof setTimeout>;

/** The MD Browser side and the collaborators of the ask. */
export interface AskInMdBrowserDeps {
    workspaceRoot: string | undefined;
    exists(absPath: string): boolean;
    /** Open (or reveal) a panel on the file and show the bar; answers its panel id. */
    openWithBar(absPath: string, bar: AskMdBar): string | undefined;
    /** Take the bar off the panel, leaving `note` in its place. */
    clearBar(panelId: string, requestId: string, note: string): void;
    closePanel(panelId: string): void;
    deleteFile(absPath: string): void;
    /** The user's standing ceiling for asks, in minutes (0 / absent: none). */
    ceilingMinutes?(): number | undefined;
    log?(entry: QuestionLogEntry): void;
    now?(): number;
    setTimer?(ms: number, cb: () => void): TimerHandle;
    clearTimer?(handle: TimerHandle): void;
    genId?(): string;
}

interface OpenAsk {
    bar: AskMdBar;
    panelId: string;
    absPath: string;
    file: string;
    keepFile: boolean;
    askedAt: number;
    timer: TimerHandle | undefined;
    deps: AskInMdBrowserDeps;
    resolve(answer: string): void;
}

/**
 * The one open ask. The webview's messages (a click, the checkbox) and the
 * panel's close come in here by request id; a stale id is ignored.
 */
export class MdBrowserAskSlot {
    private open: OpenAsk | undefined;

    hasOpen(): boolean { return this.open !== undefined; }

    /** The open ask's request id and panel, for the panel to tell whether it carries it. */
    current(): { requestId: string; panelId: string } | undefined {
        return this.open ? { requestId: this.open.bar.requestId, panelId: this.open.panelId } : undefined;
    }

    /** @internal Used by {@link askInMdBrowserImpl}. */
    begin(ask: OpenAsk): void { this.open = ask; }

    /** @internal Free the slot without answering (the panel did not open). */
    abandon(): void {
        if (this.open?.timer !== undefined) { (this.open.deps.clearTimer ?? clearTimeout)(this.open.timer); }
        this.open = undefined;
    }

    /** The checkbox changed. */
    setKeepFile(requestId: string, keepFile: boolean): boolean {
        if (!this.open || this.open.bar.requestId !== requestId) { return false; }
        this.open.keepFile = keepFile;
        return true;
    }

    /** A button was clicked. Unknown button ids are refused. */
    click(requestId: string, buttonId: string, keepFile: boolean): boolean {
        if (!this.open || this.open.bar.requestId !== requestId) { return false; }
        const button = this.open.bar.buttons.find((b) => b.id === buttonId);
        if (!button) { return false; }
        this.open.keepFile = keepFile;
        this.finish('click', button);
        return true;
    }

    /** The panel carrying the ask was closed. */
    panelClosed(panelId: string): void {
        if (this.open && this.open.panelId === panelId) { this.finish('closed'); }
    }

    /** Queue stop / window dispose: the ask ends unanswered. */
    cancel(): void {
        if (this.open) { this.finish('cancel'); }
    }

    /** @internal */
    finish(source: AskMdSource, button?: AskMdButton): void {
        const ask = this.open;
        if (!ask) { return; }
        this.open = undefined;
        const deps = ask.deps;
        if (ask.timer !== undefined) { (deps.clearTimer ?? clearTimeout)(ask.timer); }
        // The flow goes on: an unchecked file goes, and its panel with it.
        let fileDeleted = false;
        let deleteError: string | undefined;
        if (!ask.keepFile) {
            try {
                if (source !== 'closed') { deps.closePanel(ask.panelId); }
                deps.deleteFile(ask.absPath);
                fileDeleted = true;
            } catch (e) {
                deleteError = (e as Error).message;
            }
        } else if (source !== 'closed') {
            deps.clearBar(ask.panelId, ask.bar.requestId, barNote(source, button));
        }
        const answer: Record<string, unknown> = {
            button: button ? button.id : null,
            keepFile: ask.keepFile,
        };
        if (button) { answer.label = button.label; }
        if (source === 'timeout') { answer.timedOut = true; }
        if (source === 'closed') { answer.closed = true; }
        if (source === 'cancel') { answer.cancelled = true; }
        answer.fileDeleted = fileDeleted;
        if (deleteError) { answer.deleteError = deleteError; }
        answer.file = ask.file;
        answer.panelId = ask.panelId;
        journal(ask, source, button);
        ask.resolve(JSON.stringify(answer));
    }
}

function barNote(source: AskMdSource, button?: AskMdButton): string {
    switch (source) {
        case 'click': return `Answered: ${button?.label ?? ''}`;
        case 'timeout': return 'Timed out — the assistant goes on without an answer.';
        case 'cancel': return 'The question was cancelled.';
        default: return '';
    }
}

function journal(ask: OpenAsk, source: AskMdSource, button?: AskMdButton): void {
    if (!ask.deps.log) { return; }
    const answers: Record<AskMdSource, string> = {
        click: button?.label ?? '',
        timeout: '_(timed out — nobody answered)_',
        closed: '_(panel closed without an answer)_',
        cancel: '_(cancelled)_',
    };
    try {
        ask.deps.log({
            tool: 'tomAi_askInMdBrowser',
            title: ask.bar.title,
            questions: [`${ask.file} — ${ask.bar.buttons.map((b) => b.label).join(' / ')}`],
            answer: answers[source] + (ask.keepFile ? '' : ' (file not kept)'),
            source: source === 'click' ? 'vscode' : source === 'closed' ? 'cancel' : source,
            askedAt: ask.askedAt,
            answeredAt: (ask.deps.now ?? Date.now)(),
        });
    } catch {
        // Diagnostics only — never cost the user their answer.
    }
}

/** The window's one slot. */
export const mdBrowserAskSlot = new MdBrowserAskSlot();

export interface AskInMdBrowserInput {
    filePath: string;
    buttons: AskMdButton[];
    keepFile?: boolean;
    title?: string;
    timeoutMinutes?: number;
}

const err = (error: string): string => JSON.stringify({ error });

export async function askInMdBrowserImpl(
    deps: AskInMdBrowserDeps,
    input: AskInMdBrowserInput,
    slot: MdBrowserAskSlot = mdBrowserAskSlot,
): Promise<string> {
    if (!input.filePath) { return err('`filePath` is required.'); }
    if (!input.filePath.toLowerCase().endsWith('.md')) { return err(`The MD Browser shows .md files only: ${input.filePath}`); }
    const root = deps.workspaceRoot ?? '';
    const abs = path.isAbsolute(input.filePath) ? path.resolve(input.filePath) : resolveAgainstWsRoot(input.filePath, root);
    if (!root || !isInsideWorkspace(abs, root)) { return err(`Path is outside the workspace: ${input.filePath}`); }
    if (!deps.exists(abs)) { return err(`File not found: ${abs}`); }

    const raw = Array.isArray(input.buttons) ? input.buttons : [];
    const buttons = raw.map((b) => ({ id: String(b?.id ?? '').trim(), label: String(b?.label ?? '').trim() }));
    if (buttons.length === 0) { return err('`buttons` must hold at least one `{id, label}`.'); }
    if (buttons.length > MAX_ASK_MD_BUTTONS) { return err(`Too many buttons (${buttons.length}); the maximum is ${MAX_ASK_MD_BUTTONS}.`); }
    if (buttons.some((b) => !b.id || !b.label)) { return err('Every button needs a non-empty `id` and `label`.'); }
    if (new Set(buttons.map((b) => b.id)).size !== buttons.length) { return err('Button ids must be unique.'); }

    if (slot.hasOpen()) {
        return err('An askInMdBrowser request is already open — one at a time; wait for its answer before asking again.');
    }

    const now = deps.now ?? Date.now;
    const askedAt = now();
    const timeoutMs = resolveAskTimeoutMs(deps.ceilingMinutes?.(), input.timeoutMinutes);
    const rel = path.relative(root, abs);
    const file = rel.split(path.sep).join('/');
    const bar: AskMdBar = {
        requestId: (deps.genId ?? (() => `mdask_${askedAt}_${Math.random().toString(36).slice(2, 8)}`))(),
        title: input.title?.trim() || undefined,
        buttons,
        keepFile: input.keepFile !== false,
        timeoutAt: timeoutMs ? askedAt + timeoutMs : undefined,
    };

    return new Promise<string>((resolve) => {
        const ask: OpenAsk = {
            bar, panelId: '', absPath: abs, file, keepFile: bar.keepFile, askedAt, timer: undefined, deps, resolve,
        };
        // In the slot before the panel opens, so a fast answer finds it.
        slot.begin(ask);
        let panelId: string | undefined;
        try {
            panelId = deps.openWithBar(abs, bar);
        } catch (e) {
            slot.abandon();
            resolve(err(`Could not open the MD Browser on ${abs}: ${(e as Error).message}`));
            return;
        }
        if (!panelId) {
            slot.abandon();
            resolve(err(`Could not open the MD Browser on ${abs}.`));
            return;
        }
        ask.panelId = panelId;
        if (timeoutMs) {
            ask.timer = (deps.setTimer ?? ((ms, cb) => setTimeout(cb, ms)))(timeoutMs, () => slot.finish('timeout'));
        }
    });
}

export const ASK_IN_MD_BROWSER_DESCRIPTION =
    'Ask the user through a document: `filePath` (a .md file in the workspace) opens in the MD Browser with ' +
    '`buttons` (`[{id, label}]`, 1–8, e.g. Continue / Cancel) and a *Keep this file* checkbox (`keepFile`, ' +
    'default on) in its top area. For questionnaires, choices, confirmations, reviews: write the document ' +
    'first, then ask. BLOCKING like tomAi_askUser — the queue is held until a button is clicked; one such ask ' +
    'at a time; no deadline unless `timeoutMinutes`. Answers `{button, label, keepFile, fileDeleted, file, ' +
    'panelId}` (`button` the id clicked; null with `timedOut`, `closed` (the panel was closed) or `cancelled`). ' +
    'When the box is unchecked as the flow goes on, the file is deleted and its panel closed; otherwise the ' +
    'panel stays open with the answer in place of the bar. Logged to the quest questions journal.';

export const ASK_IN_MD_BROWSER_TOOL: SharedToolDefinition<AskInMdBrowserInput> = {
    name: 'tomAi_askInMdBrowser',
    displayName: 'Ask in MD Browser',
    description: ASK_IN_MD_BROWSER_DESCRIPTION,
    tags: ['user', 'interactive', 'md-browser', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'buttons'],
        properties: {
            filePath: { type: 'string', description: 'The .md file to show, workspace-relative or absolute (inside the workspace).' },
            buttons: {
                type: 'array',
                description: `1–${MAX_ASK_MD_BUTTONS} buttons for the top area, in order.`,
                minItems: 1,
                maxItems: MAX_ASK_MD_BUTTONS,
                items: {
                    type: 'object',
                    required: ['id', 'label'],
                    properties: {
                        id: { type: 'string', description: 'What the answer reports when it is clicked.' },
                        label: { type: 'string', description: 'The button text.' },
                    },
                },
            },
            keepFile: { type: 'boolean', description: 'The *Keep this file* checkbox\'s initial state. Default true.' },
            title: { type: 'string', description: 'A line shown beside the buttons.' },
            timeoutMinutes: {
                type: 'number',
                description: 'Optional. Give up after this many minutes (answer `timedOut: true`). Omit to wait indefinitely; the user\'s maximum wait still caps it.',
            },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};
