/**
 * User-interaction tools — elicit input or let the user pick.
 *
 * `tomAi_notifyUser` (notification + Telegram fallback) lives in
 * `chat-enhancement-tools.ts` for historical reasons; this file is for the
 * synchronous prompts that return a value.
 */

import * as vscode from 'vscode';
import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// tomAi_askUser — free-form text input
// ---------------------------------------------------------------------------

interface AskUserInput {
    prompt: string;
    placeholder?: string;
    defaultValue?: string;
    password?: boolean;
    title?: string;
}

async function executeAskUser(input: AskUserInput): Promise<string> {
    if (!input.prompt) { return JSON.stringify({ error: 'prompt is required' }); }
    try {
        const result = await vscode.window.showInputBox({
            prompt: input.prompt,
            placeHolder: input.placeholder,
            value: input.defaultValue,
            password: !!input.password,
            title: input.title,
            ignoreFocusOut: true,
        });
        return JSON.stringify({
            dismissed: result === undefined,
            value: result ?? '',
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Ask user failed: ${err?.message ?? err}` });
    }
}

export const ASK_USER_TOOL: SharedToolDefinition<AskUserInput> = {
    name: 'tomAi_askUser',
    displayName: 'Ask User',
    description:
        'Prompt the user for free-form text input via the command palette input box. ' +
        'Returns the entered text, or dismissed=true if the user cancelled.',
    tags: ['user', 'interactive', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
            prompt: { type: 'string', description: 'Prompt text shown to the user.' },
            placeholder: { type: 'string', description: 'Greyed-out placeholder inside the input.' },
            defaultValue: { type: 'string', description: 'Pre-filled value (user can accept or edit).' },
            password: { type: 'boolean', description: 'Mask input as password. Default false.' },
            title: { type: 'string', description: 'Optional title bar text.' },
        },
    },
    execute: executeAskUser,
};

// ---------------------------------------------------------------------------
// tomAi_askUserPicker — quickpick selection
// ---------------------------------------------------------------------------

interface PickerItemInput {
    label: string;
    description?: string;
    detail?: string;
    value?: string;
}

interface AskUserPickerInput {
    prompt?: string;
    title?: string;
    items: Array<string | PickerItemInput>;
    canPickMany?: boolean;
    matchOnDescription?: boolean;
}

async function executeAskUserPicker(input: AskUserPickerInput): Promise<string> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
        return JSON.stringify({ error: 'items must be a non-empty array' });
    }
    const qpItems: Array<vscode.QuickPickItem & { value?: string }> = input.items.map((i) =>
        typeof i === 'string'
            ? { label: i, value: i }
            : { label: i.label, description: i.description, detail: i.detail, value: i.value ?? i.label },
    );
    try {
        const result = await vscode.window.showQuickPick(qpItems, {
            placeHolder: input.prompt,
            title: input.title,
            canPickMany: !!input.canPickMany,
            matchOnDescription: input.matchOnDescription ?? true,
            ignoreFocusOut: true,
        });
        if (result === undefined) {
            return JSON.stringify({ dismissed: true });
        }
        if (Array.isArray(result)) {
            return JSON.stringify({
                dismissed: false,
                selected: result.map((r) => ({ label: r.label, value: (r as any).value })),
            });
        }
        return JSON.stringify({
            dismissed: false,
            selected: { label: result.label, value: (result as any).value },
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Ask user picker failed: ${err?.message ?? err}` });
    }
}

export const ASK_USER_PICKER_TOOL: SharedToolDefinition<AskUserPickerInput> = {
    name: 'tomAi_askUserPicker',
    displayName: 'Ask User (Picker)',
    description:
        'Show a VS Code QuickPick so the user selects from a list of items. ' +
        'Items may be plain strings or {label, description?, detail?, value?}. ' +
        'Returns the selected item(s) or dismissed=true.',
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
                description: 'List of items. Each may be a plain string, or an object with label/description/detail/value.',
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
                                value: { type: 'string', description: 'Machine-readable value returned if selected.' },
                            },
                        },
                    ],
                },
            },
            canPickMany: { type: 'boolean', description: 'Allow multi-select. Default false.' },
            matchOnDescription: { type: 'boolean', description: 'Match filter against description too. Default true.' },
        },
    },
    execute: executeAskUserPicker,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const USER_INTERACTION_TOOLS: SharedToolDefinition<any>[] = [
    ASK_USER_TOOL,
    ASK_USER_PICKER_TOOL,
];
