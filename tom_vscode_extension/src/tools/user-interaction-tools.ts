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
 *     prompter drives `createQuickPick()` instead and calls `hide()`. Leaving
 *     it up would let the user pick into a void after the model moved on.
 */

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
    'Show a VS Code QuickPick and let the user choose one or more items. ' +
    `An "${OTHER_OPTION_LABEL}" entry is appended to your list automatically — do NOT ` +
    'add one yourself. Taking it opens a free-text box, so the user can always ' +
    'answer in their own words. Consequence: `selected.value` may be text that ' +
    'is not among the `items` you offered (for a free-text answer `label` and ' +
    '`value` are both the typed text). Never assume the answer is one of your ' +
    'options. ' +
    '**BLOCKING** — awaits the user, and by default waits **indefinitely**; ' +
    'this works the same for a prompt running in the prompt queue. Set the ' +
    'optional `timeoutMinutes` to give up after a while and continue on your ' +
    'own — only do that when you have a sensible default to fall back on. ' +
    '`ignoreFocusOut: true` is ' +
    'set (clicking outside does NOT cancel). Items may be plain strings ' +
    '(label = value) or objects `{label, description?, detail?, value?}` ' +
    '(when `value` is omitted it falls back to `label`). Response: ' +
    '`{ok, dismissed, timedOut, multiSelect, selected}`. ' +
    'Shape of `selected`: (1) `canPickMany: false` (default) and user picked ' +
    '→ `selected: {label, value}`; (2) `canPickMany: true` and user pressed ' +
    'OK → `selected: [{label, value}, ...]` (array — possibly empty, which ' +
    'is distinct from dismissal); (3) cancelled (Escape) → `selected: null` ' +
    'with `dismissed: true`; (4) deadline elapsed → `selected: null` with ' +
    '`timedOut: true`. Treat (3) and (4) differently: dismissed means the ' +
    'user saw the question and declined, timed out means nobody was there. ' +
    '`matchOnDescription` controls whether the typed filter matches against ' +
    'the description column too (default true). Every exchange is logged to ' +
    'the quest questions journal.';

// (Picker tool def lives at the bottom, after the live bridge.)

// ===========================================================================
// Live vscode bridge
// ===========================================================================

/** `PickerItem` is already structurally a `QuickPickItem`, plus `value`. */
type LiveQuickPickItem = PickerItem & vscode.QuickPickItem;

function toLiveItems(items: PickerItem[]): LiveQuickPickItem[] {
    return items.map((i) => ({
        label: i.label,
        description: i.description,
        detail: i.detail,
        value: i.value,
    }));
}

/**
 * The plain, deadline-free path — `showQuickPick` is the simplest API and the
 * one with the longest mileage here, so it stays in charge whenever nothing
 * needs to interrupt the user.
 */
async function showQuickPickUntimed(items: PickerItem[], opts: QuickPickOpts): Promise<QuickPickResult> {
    const result = await vscode.window.showQuickPick(toLiveItems(items), {
        placeHolder: opts.placeHolder,
        title: opts.title,
        canPickMany: opts.canPickMany,
        matchOnDescription: opts.matchOnDescription,
        ignoreFocusOut: opts.ignoreFocusOut,
    });
    if (result === undefined) { return undefined; }
    if (Array.isArray(result)) {
        return result.map((r) => ({
            label: r.label,
            description: r.description,
            detail: r.detail,
            value: r.value ?? r.label,
        }));
    }
    return {
        label: result.label,
        description: result.description,
        detail: result.detail,
        value: result.value ?? result.label,
    };
}

/**
 * The deadline path. `showQuickPick` returns a Promise but hands back no
 * handle, so a timed-out picker would stay on screen and let the user choose
 * into a void long after the model moved on. `createQuickPick` gives us the
 * `hide()` we need to actually retract the question.
 */
function showQuickPickWithDeadline(
    items: PickerItem[],
    opts: QuickPickOpts,
    timeoutMs: number,
): Promise<QuickPickResult> {
    return new Promise<QuickPickResult>((resolve) => {
        const qp = vscode.window.createQuickPick<LiveQuickPickItem>();
        qp.items = toLiveItems(items);
        qp.title = opts.title;
        qp.placeholder = opts.placeHolder;
        qp.canSelectMany = opts.canPickMany === true;
        qp.matchOnDescription = opts.matchOnDescription === true;
        qp.ignoreFocusOut = opts.ignoreFocusOut === true;

        let settled = false;
        // `hide()` fires onDidHide, so every exit funnels through here and the
        // guard is what keeps the first outcome the real one.
        const finish = (result: QuickPickResult) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            resolve(result);
            qp.dispose();
        };
        const timer = setTimeout(() => {
            if (settled) { return; }
            qp.hide();
            finish(QUICK_PICK_TIMED_OUT);
        }, timeoutMs);

        qp.onDidAccept(() => {
            const picked = [...qp.selectedItems];
            qp.hide();
            finish(qp.canSelectMany ? picked : picked[0]);
        });
        qp.onDidHide(() => finish(undefined));
        qp.show();
    });
}

export const liveUserPrompter: UserPrompter = {
    async showQuickPick(items, opts) {
        return opts.timeoutMs === undefined || opts.timeoutMs <= 0
            ? showQuickPickUntimed(items, opts)
            : showQuickPickWithDeadline(items, opts, opts.timeoutMs);
    },
    async showInputBox(opts) {
        return vscode.window.showInputBox({
            prompt: opts.prompt,
            placeHolder: opts.placeHolder,
            value: opts.value,
            password: opts.password,
            title: opts.title,
            ignoreFocusOut: opts.ignoreFocusOut,
        });
    },
};

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
