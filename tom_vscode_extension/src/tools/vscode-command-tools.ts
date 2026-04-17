/**
 * VS Code command tools — discover, execute, and open files.
 *
 * `tomAi_runVscodeCommand` (string-only args, no approval) lives in
 * `tool-executors.ts` for historical reasons; this file hosts the newer
 * typed-args meta-tool + the list/open helpers.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';

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
// tomAi_vscode — meta-tool (wrapper over executeCommand)
// ---------------------------------------------------------------------------

const VSCODE_SAFE_COMMAND_PREFIXES: ReadonlyArray<string> = [
    'editor.action.',
    'workbench.action.focus',
    'workbench.action.navigate',
    'workbench.action.showCommands',
    'workbench.action.openSettings',
    'workbench.action.quickOpen',
    'workbench.action.toggle',
    'workbench.view.',
    'cursorMove',
    'revealLine',
    'cursorHome',
    'cursorEnd',
];

function isSafeVscodeCommand(cmd: string): boolean {
    return VSCODE_SAFE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
}

interface VscodeMetaInput { command: string; args?: unknown[] }

async function executeVscodeMeta(input: VscodeMetaInput): Promise<string> {
    if (!input.command) { return JSON.stringify({ error: 'command is required' }); }
    try {
        const result = await vscode.commands.executeCommand(input.command, ...(input.args ?? []));
        return JSON.stringify({
            success: true,
            command: input.command,
            safeListed: isSafeVscodeCommand(input.command),
            result: result === undefined ? null : result,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Command failed: ${err?.message ?? err}`, command: input.command });
    }
}

export const VSCODE_META_TOOL: SharedToolDefinition<VscodeMetaInput> = {
    name: 'tomAi_vscode',
    displayName: 'VS Code Meta Command',
    description:
        'Execute any VS Code command with typed args array. Complements tomAi_runVscodeCommand ' +
        '(string-only args) by passing arbitrary JSON-typed arguments. ' +
        'The description includes a safe-list prefix hint (editor.action.*, cursorMove, etc.); ' +
        'commands outside the hint should be reviewed before approval. ' +
        'Pair with tomAi_listCommands to discover IDs.',
    tags: ['vscode', 'meta', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string', description: 'VS Code command ID (see tomAi_listCommands).' },
            args: { type: 'array', description: 'Optional JSON-typed arguments.' },
        },
    },
    execute: executeVscodeMeta,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const VSCODE_COMMAND_TOOLS: SharedToolDefinition<any>[] = [
    OPEN_FILE_TOOL,
    LIST_COMMANDS_TOOL,
    VSCODE_META_TOOL,
];
