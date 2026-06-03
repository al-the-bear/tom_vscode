/**
 * User-interaction tools — elicit input or let the user pick.
 *
 * `tomAi_notifyUser` (notification + Telegram fallback) lives in
 * `chat-enhancement-tools.ts` for historical reasons; this file is for the
 * synchronous prompts that return a value.
 *
 * ## Coverage entry #24 refactor (audit notes)
 *
 *   - Old impls reached straight into `vscode.window.show{InputBox,QuickPick}`
 *     and were untestable without the editor.  This carve-out adds a narrow
 *     `UserPrompter` dep + `*Impl(prompter, input)` overloads; the vscode-
 *     bound bridge stays as `executeAskUser` / `executeAskUserPicker`.
 *   - Old envelopes conflated three distinct outcomes for `askUser`:
 *       (a) Escape / close button             → `result === undefined`
 *       (b) submit empty string                → `result === ''`
 *       (c) submit text                        → `result === '<text>'`
 *     The old `value: result ?? ''` flattened (a) and (b) — the model
 *     could not distinguish "user cancelled" from "user submitted blank".
 *     The new envelope keeps `dismissed` + adds `emptyInput` so the three
 *     outcomes are recoverable.
 *   - `askUserPicker` used to silently change the shape of `selected` based
 *     on `canPickMany`.  The new envelope adds `multiSelect: boolean` and
 *     always returns an array for the multi-select case (even when the
 *     user picked nothing — which is distinct from dismissing the picker).
 *
 * ## Blocking + cancellation behaviour
 *
 *   - Both tools are **blocking**: they await user input and resolve only
 *     when the user submits OR cancels.  There is **no timeout** — VS
 *     Code's `showInputBox` / `showQuickPick` do not auto-dismiss.
 *   - `ignoreFocusOut: true` is enabled on both, so clicking outside the
 *     widget does not cancel — only the Escape key or the close button.
 *   - On Escape / close → `dismissed: true`.  On empty submit (Enter on a
 *     blank input box) → `dismissed: false, emptyInput: true, value: ''`.
 */

import * as vscode from 'vscode';
import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep (the only seam between vscode and the impls)
// ===========================================================================

export interface InputBoxOpts {
    prompt: string;
    placeHolder?: string;
    value?: string;
    password?: boolean;
    title?: string;
    ignoreFocusOut?: boolean;
}

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
}

export interface UserPrompter {
    /** Returns the entered text, or `undefined` when cancelled. */
    showInputBox(opts: InputBoxOpts): Promise<string | undefined>;
    /**
     * Returns the picked item, an array of items when `canPickMany: true`,
     * or `undefined` when cancelled.  When `canPickMany` is true but the
     * user picks nothing (presses OK on an empty selection), an empty
     * array is returned — NOT `undefined`.
     */
    showQuickPick(items: PickerItem[], opts: QuickPickOpts): Promise<PickerItem | PickerItem[] | undefined>;
}

// ===========================================================================
// JSON-envelope helpers
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// `tomAi_askUser`
// ===========================================================================

export interface AskUserInput {
    prompt: string;
    placeholder?: string;
    defaultValue?: string;
    password?: boolean;
    title?: string;
}

export async function askUserImpl(prompter: UserPrompter, input: AskUserInput): Promise<string> {
    if (!input.prompt || !input.prompt.trim()) {
        return err('`prompt` is required.');
    }
    try {
        const result = await prompter.showInputBox({
            prompt: input.prompt,
            placeHolder: input.placeholder,
            value: input.defaultValue,
            password: !!input.password,
            title: input.title,
            ignoreFocusOut: true,
        });
        if (result === undefined) {
            return ok({ dismissed: true, value: null, emptyInput: false });
        }
        return ok({ dismissed: false, value: result, emptyInput: result === '' });
    } catch (e) {
        return err(`askUser failed: ${(e as Error).message}`);
    }
}

export const ASK_USER_DESCRIPTION =
    'Prompt the user for free-form text via the VS Code input box. ' +
    '**BLOCKING** — awaits the user; no timeout (the widget stays open ' +
    'indefinitely). `ignoreFocusOut: true` is set, so clicking outside ' +
    'does NOT cancel — only the Escape key or the close button. ' +
    'Response: `{ok, dismissed, value, emptyInput}`. Three distinguishable ' +
    'outcomes: (1) submitted text → `dismissed: false, value: "<text>", ' +
    'emptyInput: false`; (2) submitted empty → `dismissed: false, value: "", ' +
    'emptyInput: true` (Enter pressed on a blank input — still a valid ' +
    'submission); (3) cancelled (Escape / close) → `dismissed: true, value: ' +
    'null, emptyInput: false`. Use `password: true` to mask input; use ' +
    '`defaultValue` to pre-fill an editable suggestion.';

// `liveUserPrompter` is defined further down (vscode bridge); the live
// executor is bound when the tool def is constructed at the bottom of
// this file.  Tests skip the tool def entirely and call `askUserImpl`
// against a stubbed `UserPrompter`.

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
}

interface SelectedItemOut {
    label: string;
    value: string;
}

export async function askUserPickerImpl(prompter: UserPrompter, input: AskUserPickerInput): Promise<string> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
        return err('`items` must be a non-empty array.');
    }
    const multiSelect = input.canPickMany === true;
    const items: PickerItem[] = input.items.map((i) =>
        typeof i === 'string'
            ? { label: i, value: i }
            : { label: i.label, description: i.description, detail: i.detail, value: i.value ?? i.label },
    );
    try {
        const result = await prompter.showQuickPick(items, {
            placeHolder: input.prompt,
            title: input.title,
            canPickMany: multiSelect,
            matchOnDescription: input.matchOnDescription ?? true,
            ignoreFocusOut: true,
        });
        if (result === undefined) {
            return ok({ dismissed: true, multiSelect, selected: null });
        }
        if (multiSelect) {
            // VS Code returns [] when the user pressed OK without selecting
            // anything — distinct from dismissal.  Pass the empty array
            // through faithfully.
            const arr = Array.isArray(result) ? result : [result];
            const selected: SelectedItemOut[] = arr.map((r) => ({ label: r.label, value: r.value }));
            return ok({ dismissed: false, multiSelect: true, selected });
        }
        // Single-select: VS Code returns a single item (never an array
        // when `canPickMany: false`).  Defensive flatten anyway.
        const chosen = Array.isArray(result) ? result[0] : result;
        if (!chosen) {
            // Defensive: if the prompter handed us an empty array on single-select
            // (out of contract), treat as dismissed.
            return ok({ dismissed: true, multiSelect: false, selected: null });
        }
        const selected: SelectedItemOut = { label: chosen.label, value: chosen.value };
        return ok({ dismissed: false, multiSelect: false, selected });
    } catch (e) {
        return err(`askUserPicker failed: ${(e as Error).message}`);
    }
}

export const ASK_USER_PICKER_DESCRIPTION =
    'Show a VS Code QuickPick and let the user choose one or more items. ' +
    '**BLOCKING** — awaits the user; no timeout. `ignoreFocusOut: true` is ' +
    'set (clicking outside does NOT cancel). Items may be plain strings ' +
    '(label = value) or objects `{label, description?, detail?, value?}` ' +
    '(when `value` is omitted it falls back to `label`). Response: ' +
    '`{ok, dismissed, multiSelect, selected}`. ' +
    'Shape of `selected`: (1) `canPickMany: false` (default) and user picked ' +
    '→ `selected: {label, value}`; (2) `canPickMany: true` and user pressed ' +
    'OK → `selected: [{label, value}, ...]` (array — possibly empty, which ' +
    'is distinct from dismissal); (3) cancelled (Escape) → `selected: null`. ' +
    '`matchOnDescription` controls whether the typed filter matches against ' +
    'the description column too (default true).';

// (Picker tool def lives at the bottom alongside `askUser`, after the
// live bridge — keeps the tool defs colocated for easier scanning.)

// ===========================================================================
// Live vscode bridge
// ===========================================================================

export const liveUserPrompter: UserPrompter = {
    showInputBox(opts) {
        return Promise.resolve(vscode.window.showInputBox({
            prompt: opts.prompt,
            placeHolder: opts.placeHolder,
            value: opts.value,
            password: opts.password,
            title: opts.title,
            ignoreFocusOut: opts.ignoreFocusOut,
        }));
    },
    async showQuickPick(items, opts) {
        const qpItems = items.map((i) => ({
            label: i.label,
            description: i.description,
            detail: i.detail,
            value: i.value,
        }));
        const result = await vscode.window.showQuickPick(qpItems, {
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
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                value: (r as any).value ?? r.label,
            }));
        }
        return {
            label: result.label,
            description: result.description,
            detail: result.detail,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            value: (result as any).value ?? result.label,
        };
    },
};

// ===========================================================================
// Tool defs (with live bridge bound)
// ===========================================================================

export const ASK_USER_TOOL: SharedToolDefinition<AskUserInput> = {
    name: 'tomAi_askUser',
    displayName: 'Ask User',
    description: ASK_USER_DESCRIPTION,
    tags: ['user', 'interactive', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string', description: 'Prompt text shown above the input.' },
            placeholder: { type: 'string', description: 'Greyed-out placeholder inside the empty input.' },
            defaultValue: { type: 'string', description: 'Pre-filled value (user can accept or edit).' },
            password: { type: 'boolean', description: 'Mask input as password. Default false.' },
            title: { type: 'string', description: 'Optional title bar text.' },
        },
    },
    execute: (input) => askUserImpl(liveUserPrompter, input),
};

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
        },
    },
    execute: (input) => askUserPickerImpl(liveUserPrompter, input),
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const USER_INTERACTION_TOOLS: SharedToolDefinition<any>[] = [
    ASK_USER_TOOL,
    ASK_USER_PICKER_TOOL,
];
