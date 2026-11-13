/**
 * User-interaction tools — let the user pick from a list.
 *
 * `tomAi_notifyUser` (notification + Telegram fallback) lives in
 * `chat-enhancement-tools.ts`; the blocking, multi-question `tomAi_askUser`
 * lives in `ask-user-tool.ts` (+ the `askUser-handler.ts` live bridge). This
 * file now hosts only `tomAi_askUserPicker`.
 *
 * ## `askUserPicker` envelope
 *
 *   - `askUserPicker` used to silently change the shape of `selected` based
 *     on `canPickMany`.  The envelope adds `multiSelect: boolean` and
 *     always returns an array for the multi-select case (even when the
 *     user picked nothing — which is distinct from dismissing the picker).
 *
 * ## Free-text answers
 *
 *   - The offered items are the caller's guess at the answer, and the real
 *     answer is regularly none of them. Every picker therefore ends with an
 *     "Other…" entry that opens a free-text box
 *     (`services/free-text-picker.ts`, shared with the Agent-SDK question
 *     interceptor). `selected.value` may consequently be text the caller never
 *     offered — that is the point, not a violation.
 *   - Two things make that hold at the widget. The entry is pinned with
 *     `alwaysShow`, so typing an answer that matches no option cannot filter
 *     it away; and Enter with nothing selected submits the typed text directly
 *     (`showLiveQuickPick`), so the natural move — type the answer, press
 *     Enter — just works, with no detour through the entry.
 *
 * ## Blocking + cancellation behaviour
 *
 *   - The picker is **blocking**: it awaits user input and resolves only when
 *     the user submits, cancels, or an optional deadline elapses. Like
 *     `tomAi_askUser` it waits **indefinitely** unless somebody asked for a
 *     deadline — the model per call (`timeoutMinutes`) or the user as a
 *     standing ceiling (`maxWaitMinutes`).
 *   - `ignoreFocusOut: true` is enabled, so clicking outside the widget does
 *     not cancel — only the Escape key or the close button.
 *   - Timing out is a **third outcome**, distinct from dismissal: dismissed
 *     means the user saw the question and declined, timed out means nobody was
 *     there. Honouring a deadline means actually taking the widget off the
 *     screen, which `vscode.window.showQuickPick` cannot do — so the live
 *     prompter drives `createQuickPick()` for every pick (it is also the only
 *     API that exposes the typed text) and retracts it with `dispose()`.
 *     Leaving it up would let the user pick into a void after the model moved on.
 *   - The prompt that asked owns the question (`services/askOwners.ts`): when
 *     that Anthropic send ends first — answered, stopped, failed — the picker
 *     or input box closes and answers as on Escape (the tool: `dismissed`; the
 *     Agent SDK's AskUserQuestion: its fallback). Outside a send nothing
 *     owns it.
 */

import { currentInteractionRun, currentQueueItemId, whileWaitingForUser } from '../services/userWaits';
import { userInteractions } from '../services/userInteractions';
import { registerAskCancel } from '../services/askOwners';
import * as vscode from 'vscode';
import { SharedToolDefinition } from './shared-tool-registry';
import { resolveAskTimeoutMs } from '../utils/askTimeout';
import { QuestionLogEntry } from '../utils/questionsLogFormat';
import { appendQuestionLogEntry } from '../services/questionsLog';
import { readChatQuestionsConfig } from '../handlers/chatQuestions-config';
import { pickWithFreeTextOption, OTHER_OPTION_LABEL } from '../services/free-text-picker';

// ===========================================================================
// Narrow dep (the only seam between vscode and the impls)
// ===========================================================================

export interface PickerItem {
    label: string;
    description?: string;
    detail?: string;
    /** Caller-provided machine-readable value; defaults to `label` when omitted. */
    value: string;
    /**
     * Keep the entry on screen whatever the user types. The QuickPick filters
     * its list by the typed text, so an ordinary entry vanishes the moment the
     * user types an answer that matches no option — which is exactly when the
     * free-text entry is needed.
     */
    alwaysShow?: boolean;
}

export interface QuickPickOpts {
    placeHolder?: string;
    title?: string;
    canPickMany?: boolean;
    matchOnDescription?: boolean;
    ignoreFocusOut?: boolean;
    /**
     * Take the picker off the screen and resolve with
     * {@link QUICK_PICK_TIMED_OUT} after this many milliseconds. Omitted means
     * wait for the user indefinitely.
     */
    timeoutMs?: number;
}

/**
 * Returned by {@link UserPrompter.showQuickPick} when `opts.timeoutMs` elapsed
 * before the user chose. A symbol rather than another `undefined` so it cannot
 * be silently mistaken for a dismissal at any call site.
 */
export const QUICK_PICK_TIMED_OUT = Symbol('quickPickTimedOut');

/** Everything {@link UserPrompter.showQuickPick} may resolve with. */
export type QuickPickResult = PickerItem | PickerItem[] | undefined | typeof QUICK_PICK_TIMED_OUT;

export interface InputBoxOpts {
    prompt?: string;
    placeHolder?: string;
    value?: string;
    password?: boolean;
    title?: string;
    ignoreFocusOut?: boolean;
}

export interface UserPrompter {
    /**
     * Returns the picked item, an array of items when `canPickMany: true`,
     * `undefined` when cancelled, or {@link QUICK_PICK_TIMED_OUT} when
     * `opts.timeoutMs` elapsed first.  When `canPickMany` is true but the
     * user picks nothing (presses OK on an empty selection), an empty
     * array is returned — NOT `undefined`.
     */
    showQuickPick(items: PickerItem[], opts: QuickPickOpts): Promise<QuickPickResult>;
    /**
     * Free-text input box. Returns the entered string (possibly empty when the
     * user submits a blank field) or `undefined` when cancelled. Used by the
     * Agent-SDK question interceptor's "Other…" free-text affordance — the
     * deleted single-question `askUser` tool no longer relies on it.
     */
    showInputBox(opts: InputBoxOpts): Promise<string | undefined>;
}

// ===========================================================================
// JSON-envelope helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// `tomAi_askUserPicker`
// ===========================================================================

export interface PickerItemInput {
    label: string;
    description?: string;
    detail?: string;
    /** Machine-readable value returned when selected; defaults to `label` when omitted. */
    value?: string;
}

export interface AskUserPickerInput {
    prompt?: string;
    title?: string;
    items: Array<string | PickerItemInput>;
    canPickMany?: boolean;
    matchOnDescription?: boolean;
    /**
     * Optional deadline for *this* pick, in minutes. Omitted means wait
     * indefinitely; the user's configured ceiling still caps it.
     */
    timeoutMinutes?: number;
}

/** Optional collaborators — the deadline ceiling and the questions journal. */
export interface AskUserPickerDeps {
    /** The user's standing `maxWaitMinutes` ceiling (0 / absent = no ceiling). */
    ceilingMinutes?: number;
    /** Append the resolved exchange to the quest's questions journal. */
    log?(entry: QuestionLogEntry): void;
    /** Clock seam for the journal timings. Defaults to `Date.now`. */
    now?(): number;
}

interface SelectedItemOut {
    label: string;
    value: string;
}

export async function askUserPickerImpl(
    prompter: UserPrompter,
    input: AskUserPickerInput,
    deps: AskUserPickerDeps = {},
): Promise<string> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
        return err('`items` must be a non-empty array.');
    }
    const multiSelect = input.canPickMany === true;
    const items: PickerItem[] = input.items.map((i) =>
        typeof i === 'string'
            ? { label: i, value: i }
            : { label: i.label, description: i.description, detail: i.detail, value: i.value ?? i.label },
    );
    const now = deps.now ?? (() => Date.now());
    const askedAt = now();
    // The question we put on the record is what the user actually read: the
    // placeholder line. An items-only picker asks nothing in words, so the
    // journal entry carries no question list at all.
    const question = input.prompt?.trim() || '';
    const journal = (source: string, answer: string) => {
        if (!deps.log) { return; }
        try {
            deps.log({
                tool: 'tomAi_askUserPicker',
                title: input.title?.trim() || input.prompt?.trim() || undefined,
                questions: question ? [question] : [],
                answer,
                source,
                askedAt,
                answeredAt: now(),
            });
        } catch {
            // Diagnostics only — never cost the user their pick.
        }
    };

    try {
        const result = await pickWithFreeTextOption(
            prompter,
            items,
            {
                placeHolder: input.prompt,
                title: input.title,
                canPickMany: multiSelect,
                matchOnDescription: input.matchOnDescription ?? true,
                ignoreFocusOut: true,
                timeoutMs: resolveAskTimeoutMs(deps.ceilingMinutes, input.timeoutMinutes),
            },
            { prompt: input.prompt, title: input.title },
        );
        if (result.kind === 'timedOut') {
            journal('timeout', '_(timed out — nobody answered)_');
            return ok({ dismissed: false, timedOut: true, multiSelect, selected: null });
        }
        if (result.kind === 'dismissed') {
            journal('cancel', '_(dismissed without choosing)_');
            return ok({ dismissed: true, timedOut: false, multiSelect, selected: null });
        }
        if (multiSelect) {
            // The user may press OK without ticking anything — an empty array,
            // distinct from dismissal. Pass it through faithfully.
            const selected: SelectedItemOut[] = result.selections.map((r) => ({ label: r.label, value: r.value }));
            journal('vscode', selected.map((s) => s.label).join(', ') || '_(nothing selected)_');
            return ok({ dismissed: false, timedOut: false, multiSelect: true, selected });
        }
        const chosen = result.selections[0];
        if (!chosen) {
            // Nothing to report: either the prompter handed us an empty
            // single-select (out of contract), or the user took "Other…" and
            // submitted a blank box.
            journal('cancel', '_(dismissed without choosing)_');
            return ok({ dismissed: true, timedOut: false, multiSelect: false, selected: null });
        }
        const selected: SelectedItemOut = { label: chosen.label, value: chosen.value };
        journal('vscode', selected.label);
        return ok({ dismissed: false, timedOut: false, multiSelect: false, selected });
    } catch (e) {
        return err(`askUserPicker failed: ${(e as Error).message}`);
    }
}

export const ASK_USER_PICKER_DESCRIPTION =
    'Show a QuickPick and let the user choose one or more `items` (strings or `{label, description?, detail?, value?}`). '
    + `An "${OTHER_OPTION_LABEL}" entry is added automatically`
    + ' (do not add one): `selected.value` may be free text that is none of your items. BLOCKING, by default without a deadline (`timeoutMinutes` to give up, only with a sensible default). Answers `{dismissed, timedOut, selected}`: `{label, value}`, or an array with `canPickMany`; dismissed (the user declined) and timed out (nobody there) are different. One picker per process run at a time; while another run\'s picker is on screen it is answered in the user-input panel. Logged to the quest questions journal.';

// (Picker tool def lives at the bottom, after the live bridge.)

// ===========================================================================
// Live vscode bridge
// ===========================================================================

/** `PickerItem` is already structurally a `QuickPickItem`, plus `value`. */
type LiveQuickPickItem = PickerItem & vscode.QuickPickItem;

/** What the prompter uses of a `vscode.QuickPick`. */
export type LiveQuickPick<T extends vscode.QuickPickItem> = Pick<
    vscode.QuickPick<T>,
    | 'items' | 'title' | 'placeholder' | 'canSelectMany' | 'matchOnDescription' | 'ignoreFocusOut'
    | 'value' | 'selectedItems' | 'onDidAccept' | 'onDidHide' | 'show' | 'hide' | 'dispose'
>;

/**
 * The slice of `vscode.window` the live prompter needs. A seam, so the prompter
 * can be driven against a scriptable QuickPick in tests: the free-text
 * guarantee lives in how the widget is wired, which a stubbed `UserPrompter`
 * cannot show.
 */
export interface LiveWindow {
    createQuickPick<T extends vscode.QuickPickItem>(): LiveQuickPick<T>;
    showInputBox(options: vscode.InputBoxOptions, token?: vscode.CancellationToken): Thenable<string | undefined>;
}

function toLiveItems(items: PickerItem[]): LiveQuickPickItem[] {
    return items.map((i) => ({
        label: i.label,
        description: i.description,
        detail: i.detail,
        value: i.value,
        alwaysShow: i.alwaysShow,
    }));
}

/** Back from the widget's item shape, without inventing `undefined` fields. */
function fromLiveItem(item: LiveQuickPickItem): PickerItem {
    return {
        label: item.label,
        value: item.value ?? item.label,
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
    };
}

/**
 * One QuickPick path for the timed and the untimed case alike, built on
 * `createQuickPick` rather than `showQuickPick` because only the former exposes
 * what the user *typed*. That is the second half of the free-text guarantee:
 * Enter with nothing selected and text in the box submits the text — it
 * matched no item, which is the whole point of typing it. Ticked / active items
 * always win over leftover filter text.
 *
 * `createQuickPick` is also what makes a deadline honest: `dispose()` retracts
 * the widget, so a timed-out question does not stay on screen for the user to
 * answer into a void.
 */
function showLiveQuickPick(win: LiveWindow, items: PickerItem[], opts: QuickPickOpts): Promise<QuickPickResult> {
    return new Promise<QuickPickResult>((resolve) => {
        const qp = win.createQuickPick<LiveQuickPickItem>();
        qp.items = toLiveItems(items);
        qp.title = opts.title;
        qp.placeholder = opts.placeHolder;
        qp.canSelectMany = opts.canPickMany === true;
        qp.matchOnDescription = opts.matchOnDescription === true;
        qp.ignoreFocusOut = opts.ignoreFocusOut === true;

        let settled = false;
        // Every exit funnels through here and the guard keeps the first outcome
        // the real one. Settling *before* disposing matters: `dispose()` hides
        // the widget, and `onDidHide` would otherwise turn an accept or a
        // timeout into a dismissal.
        const finish = (result: QuickPickResult) => {
            if (settled) { return; }
            settled = true;
            if (timer !== undefined) { clearTimeout(timer); }
            unregister();
            resolve(result);
            qp.dispose();
        };
        // The prompt that asked owns the question (services/askOwners.ts): when it ends
        // first, the picker closes as on Escape — its answer would reach nobody.
        const unregister = registerAskCancel(() => finish(undefined));
        const timer = opts.timeoutMs !== undefined && opts.timeoutMs > 0
            ? setTimeout(() => finish(QUICK_PICK_TIMED_OUT), opts.timeoutMs)
            : undefined;

        qp.onDidAccept(() => {
            const picked = qp.selectedItems.map(fromLiveItem);
            const typed = qp.value.trim();
            // A real QuickPick always has an active row. When the typed text
            // matches no option, the only row left is a pinned (`alwaysShow`)
            // one — the free-text entry — so Enter "selects" it although the
            // user meant their text. Treat a selection made only of pinned rows,
            // with text in the box, as the text: anything else would discard
            // what was typed and ask for it again.
            const pinnedOnly = qp.selectedItems.length > 0 && qp.selectedItems.every((i) => i.alwaysShow === true);
            if ((picked.length === 0 || pinnedOnly) && typed.length > 0) {
                const own: PickerItem = { label: typed, value: typed };
                finish(qp.canSelectMany ? [own] : own);
                return;
            }
            finish(qp.canSelectMany ? picked : picked[0]);
        });
        qp.onDidHide(() => finish(undefined));
        qp.show();
    });
}

/**
 * A cancellation token of our own (the shape `showInputBox` reads), so the
 * prompter needs no `vscode.CancellationTokenSource` and runs under a test stub.
 */
function cancellationSource(): { token: vscode.CancellationToken; cancel: () => void } {
    const listeners = new Set<(e: unknown) => unknown>();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: (e: unknown) => unknown) => {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
        },
    };
    return {
        token: token as unknown as vscode.CancellationToken,
        cancel: () => {
            if (token.isCancellationRequested) { return; }
            token.isCancellationRequested = true;
            for (const l of [...listeners]) { try { l(undefined); } catch { /* the others still hear it */ } }
        },
    };
}

/**
 * A picker shown in the user-input panel instead of a QuickPick (vscimpb81):
 * VS Code shows one QuickPick at a time, so a picker of another run than the
 * one whose QuickPick is showing is answered there, on its run's tab. Answers
 * what the QuickPick answers: the item(s), the typed text as an item, undefined
 * when dismissed, or {@link QUICK_PICK_TIMED_OUT}.
 */
export function panelQuickPick(items: PickerItem[], opts: QuickPickOpts, run: string): Promise<QuickPickResult> {
    return new Promise<QuickPickResult>((resolve) => {
        const id = `pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let done = false;
        let remove: () => void = () => undefined;
        const finish = (result: QuickPickResult): void => {
            if (done) { return; }
            done = true;
            if (timer !== undefined) { clearTimeout(timer); }
            unregister();
            remove();
            resolve(result);
        };
        const unregister = registerAskCancel(() => finish(undefined));
        const timer = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? setTimeout(() => finish(QUICK_PICK_TIMED_OUT), opts.timeoutMs) : undefined;
        const queueItemId = currentQueueItemId();
        remove = userInteractions.add({
            id,
            kind: 'picker',
            run,
            ...(queueItemId ? { queueItemId } : {}),
            createdAt: Date.now(),
            title: opts.title ?? 'Pick',
            data: {
                title: opts.title,
                prompt: opts.placeHolder,
                items: items.map((i) => ({ label: i.label, ...(i.description ? { description: i.description } : {}) })),
                canPickMany: opts.canPickMany === true,
            },
            respond: (r) => {
                if (r.dismissed === true) { finish(undefined); return; }
                const picked = (Array.isArray(r.selected) ? r.selected : []).map(Number).filter((n) => items[n] !== undefined).map((n) => items[n]);
                const other = typeof r.other === 'string' ? r.other.trim() : '';
                if (other) { picked.push({ label: other, value: other }); }
                finish(opts.canPickMany === true ? picked : picked[0]);
            },
        });
    });
}

/** Build a prompter over a window; {@link liveUserPrompter} is the one over `vscode.window`. */
export function createLiveUserPrompter(win: LiveWindow): UserPrompter {
    // The run whose QuickPick / input box VS Code shows now (one at a time), and each run's last picker:
    // a run's next picker waits for its previous one, another run's is answered in the user-input panel.
    let showingRun: string | undefined;
    const lastOfRun = new Map<string, Promise<unknown>>();
    function inTurn<T>(run: string, fn: () => Promise<T>): Promise<T> {
        // Without an earlier picker of the run it is shown at once (synchronously, as before).
        const previous = lastOfRun.get(run);
        const next = previous ? previous.catch(() => undefined).then(fn) : fn();
        lastOfRun.set(run, next);
        void next.finally(() => { if (lastOfRun.get(run) === next) { lastOfRun.delete(run); } }).catch(() => undefined);
        return next;
    }
    function onScreen<T>(run: string, show: () => Promise<T>): Promise<T> {
        showingRun = run;
        return show().finally(() => { if (showingRun === run) { showingRun = undefined; } });
    }
    return {
        showQuickPick(items, opts) {
            const run = currentInteractionRun();
            return inTurn(run, () => whileWaitingForUser('question', () => (showingRun === undefined
                ? onScreen(run, () => showLiveQuickPick(win, items, opts))
                : panelQuickPick(items, opts, run))));
        },
        async showInputBox(opts) {
            const run = currentInteractionRun();
            return inTurn(run, () => whileWaitingForUser('question', async () => {
                if (showingRun !== undefined) {
                    // Another run's picker is on screen: the text is typed in the user-input panel.
                    const answer = await panelQuickPick([], { title: opts.title ?? opts.prompt, placeHolder: opts.placeHolder ?? opts.prompt }, run);
                    return answer === undefined || answer === QUICK_PICK_TIMED_OUT ? undefined : (answer as PickerItem).value;
                }
                return onScreen(run, async () => {
                    // Ended with the prompt that asked, like the QuickPick: the box closes, the answer is undefined.
                    const cancel = cancellationSource();
                    const unregister = registerAskCancel(cancel.cancel);
                    try {
                        return await win.showInputBox({
                            prompt: opts.prompt,
                            placeHolder: opts.placeHolder,
                            value: opts.value,
                            password: opts.password,
                            title: opts.title,
                            ignoreFocusOut: opts.ignoreFocusOut,
                        }, cancel.token);
                    } finally {
                        unregister();
                    }
                });
            }));
        },
    };
}

export const liveUserPrompter: UserPrompter = createLiveUserPrompter(vscode.window);

// ===========================================================================
// Tool defs (with live bridge bound)
// ===========================================================================

/**
 * The picker's live collaborators, resolved per call so a settings change
 * takes effect on the next ask rather than at the next window reload.
 */
function livePickerDeps(): AskUserPickerDeps {
    return {
        ceilingMinutes: readChatQuestionsConfig().maxWaitMinutes,
        log: (entry) => appendQuestionLogEntry(entry),
    };
}

export const ASK_USER_PICKER_TOOL: SharedToolDefinition<AskUserPickerInput> = {
    name: 'tomAi_askUserPicker',
    displayName: 'Ask User (Picker)',
    description: ASK_USER_PICKER_DESCRIPTION,
    tags: ['user', 'interactive', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
            prompt: { type: 'string', description: 'Placeholder text in the search box.' },
            title: { type: 'string', description: 'Optional title bar text.' },
            items: {
                type: 'array',
                description: 'List of items. Each may be a plain string, or an object {label, description?, detail?, value?}.',
                items: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            required: ['label'],
                            properties: {
                                label: { type: 'string' },
                                description: { type: 'string' },
                                detail: { type: 'string' },
                                value: { type: 'string', description: 'Machine-readable value returned if selected. Defaults to `label`.' },
                            },
                        },
                    ],
                },
            },
            canPickMany: { type: 'boolean', description: 'Allow multi-select. Default false. When true, `selected` is always an array (possibly empty).' },
            matchOnDescription: { type: 'boolean', description: 'Match the typed filter against `description` as well as `label`. Default true.' },
            timeoutMinutes: {
                type: 'number',
                description:
                    'Optional. Retract the picker after this many minutes and answer with ' +
                    '`timedOut: true`. Omit it to wait indefinitely for the user (the default). ' +
                    "The user's configured maximum wait still caps this value.",
            },
        },
    },
    execute: (input) => askUserPickerImpl(liveUserPrompter, input, livePickerDeps()),
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const USER_INTERACTION_TOOLS: SharedToolDefinition<any>[] = [
    ASK_USER_PICKER_TOOL,
];
