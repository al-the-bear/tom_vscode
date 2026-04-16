/**
 * Wave B — IDE navigation tools (low/no approval).
 *
 * See `doc/llm_tools.md` §6.3 Wave B. These tools navigate, elicit user input,
 * or discover VS Code command IDs. Note: `tomAi_notifyUser` is implemented in
 * chat-enhancement-tools.ts and is not duplicated here.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = wsRoot();
    return root ? path.join(root, filePath) : filePath;
}

// ---------------------------------------------------------------------------
// tomAi_openFile
// ---------------------------------------------------------------------------

interface OpenFileInput {
    filePath: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    preview?: boolean;
    preserveFocus?: boolean;
    viewColumn?: number;
}

async function executeOpenFile(input: OpenFileInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: 'filePath is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }

    try {
        const uri = vscode.Uri.file(abs);
        const doc = await vscode.workspace.openTextDocument(uri);
        const options: vscode.TextDocumentShowOptions = {
            preview: input.preview ?? false,
            preserveFocus: input.preserveFocus ?? false,
            viewColumn: input.viewColumn as vscode.ViewColumn | undefined,
        };
        if (typeof input.line === 'number') {
            const startLine = Math.max(0, input.line);
            const startCol = Math.max(0, input.column ?? 0);
            const endLine = Math.max(startLine, input.endLine ?? startLine);
            const endCol = Math.max(0, input.endColumn ?? startCol);
            options.selection = new vscode.Range(
                new vscode.Position(startLine, startCol),
                new vscode.Position(endLine, endCol),
            );
        }
        await vscode.window.showTextDocument(doc, options);
        return JSON.stringify({
            success: true,
            file: abs,
            language: doc.languageId,
            lineCount: doc.lineCount,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Could not open: ${err?.message ?? err}` });
    }
}

export const OPEN_FILE_TOOL: SharedToolDefinition<OpenFileInput> = {
    name: 'tomAi_openFile',
    displayName: 'Open File',
    description:
        'Open a file in the editor, optionally scrolling to a line/column or selecting a range. ' +
        'Purely navigational — does not modify file contents.',
    tags: ['editor', 'navigation', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute file path.' },
            line: { type: 'number', description: 'Zero-based line to reveal (optional).' },
            column: { type: 'number', description: 'Zero-based column. Default 0.' },
            endLine: { type: 'number', description: 'End line for a selection range.' },
            endColumn: { type: 'number', description: 'End column for a selection range.' },
            preview: { type: 'boolean', description: 'Open in preview mode (italic tab). Default false.' },
            preserveFocus: { type: 'boolean', description: 'Keep focus in the current editor. Default false.' },
            viewColumn: { type: 'number', description: 'Split view column (1, 2, 3). Default: active.' },
        },
    },
    execute: executeOpenFile,
};

// ---------------------------------------------------------------------------
// tomAi_listCommands
// ---------------------------------------------------------------------------

interface ListCommandsInput {
    filter?: string;
    includeInternal?: boolean;
    maxResults?: number;
}

async function executeListCommands(input: ListCommandsInput): Promise<string> {
    try {
        const all = await vscode.commands.getCommands(!input.includeInternal);
        const max = Math.max(1, input.maxResults ?? 500);
        const filter = (input.filter ?? '').toLowerCase();
        const matches = filter
            ? all.filter((c) => c.toLowerCase().includes(filter))
            : all;
        const slice = matches.slice(0, max);
        return JSON.stringify({
            totalMatches: matches.length,
            returned: slice.length,
            truncated: matches.length > slice.length,
            commands: slice,
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `List commands failed: ${err?.message ?? err}` });
    }
}

export const LIST_COMMANDS_TOOL: SharedToolDefinition<ListCommandsInput> = {
    name: 'tomAi_listCommands',
    displayName: 'List VS Code Commands',
    description:
        'List registered VS Code command IDs, optionally filtered by substring. ' +
        'Use before tomAi_runVscodeCommand when the exact command id is unknown.',
    tags: ['vscode', 'discovery', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filter: { type: 'string', description: 'Substring filter (case-insensitive). Example: "editor.action".' },
            includeInternal: { type: 'boolean', description: 'Include VS Code internal commands (underscore-prefixed). Default false.' },
            maxResults: { type: 'number', description: 'Max commands returned. Default 500.' },
        },
    },
    execute: executeListCommands,
};

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
export const WAVE_B_TOOLS: SharedToolDefinition<any>[] = [
    OPEN_FILE_TOOL,
    LIST_COMMANDS_TOOL,
    ASK_USER_TOOL,
    ASK_USER_PICKER_TOOL,
];
