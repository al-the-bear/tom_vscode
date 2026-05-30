/**
 * VS Code command tools — `tomAi_runVscodeCommand`,
 * `tomAi_runVscodeCommandTyped`, `tomAi_listCommands`, `tomAi_openFile`.
 *
 * Refactored for coverage entry #6:
 *
 *   - **vscode-free at runtime.** Impls take narrow dep interfaces
 *     (`CommandRunner`, `FileOpener`) so tests pass plain-object
 *     fakes. Live deps live in `tool-executors.ts`.
 *
 *   - **The run-command duplication is acknowledged**, not papered over.
 *     `tomAi_runVscodeCommand` and `tomAi_runVscodeCommandTyped` share
 *     the same runtime — both pass args verbatim to
 *     `vscode.commands.executeCommand`. The only difference was the
 *     argument-schema hint (string-only vs any JSON). The descriptions
 *     now spell out the relationship: `runVscodeCommand` is the
 *     simple-args entry point kept for back-compat; new code should
 *     prefer `runVscodeCommandTyped`. Output format is now JSON for
 *     both (was text on the older one), and `runVscodeCommand` also
 *     gains the safe-list hint.
 *
 *   - **`openFile` line/column switched to 1-based** to match the rest
 *     of the tool surface (`readFile`, error messages, anything humans
 *     read). Translated to vscode's 0-based API internally. Documented
 *     explicitly so the model doesn't get tripped by a hidden conversion.
 *
 *   - **`openFile` honours `isInsideWorkspace`**. The previous impl
 *     resolved any path against `wsRoot` and called `vscode.window.
 *     showTextDocument` on it — so `../../../etc/passwd` would happily
 *     open out-of-tree files in the editor.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';

// ---------------------------------------------------------------------------
// Narrow deps — production wires vscode.commands / vscode.window
// ---------------------------------------------------------------------------

export interface CommandRunner {
    /** Execute a VS Code command by id; returns whatever it returns. */
    executeCommand(commandId: string, args: unknown[]): Promise<unknown>;
    /** List registered commands. `filterInternal: true` strips underscore-prefixed ids. */
    listCommands(filterInternal: boolean): Promise<string[]>;
}

export interface OpenFileRange {
    /** 0-based — already converted from the 1-based user-facing input. */
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
}

export interface OpenFileShowOptions {
    preview: boolean;
    preserveFocus: boolean;
    viewColumn?: number;
    selection?: OpenFileRange;
}

export interface FileOpener {
    wsRoot: string;
    /**
     * Open `absPath` in the editor and apply the show options.
     * Returns rich metadata on success, or a `reason` on failure.
     */
    openInEditor(absPath: string, opts: OpenFileShowOptions): Promise<
        | { ok: true; languageId: string; lineCount: number }
        | { ok: false; reason: string }
    >;
    /** Sync existence check separated for testability. */
    exists(absPath: string): boolean;
}

// ---------------------------------------------------------------------------
// Safe-list (informational hint only — not an enforcement boundary;
// the LLM tool gate already requires user approval for these tools)
// ---------------------------------------------------------------------------

export const VSCODE_SAFE_COMMAND_PREFIXES: ReadonlyArray<string> = [
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

export function isSafeVscodeCommand(cmd: string): boolean {
    return VSCODE_SAFE_COMMAND_PREFIXES.some((p) => cmd.startsWith(p));
}

// ===========================================================================
// runVscodeCommand + runVscodeCommandTyped (shared impl, two tool defs)
// ===========================================================================

export interface RunVscodeCommandInput {
    command: string;
    args?: unknown[];
}

/**
 * Shared impl for both `runVscodeCommand` and `runVscodeCommandTyped`.
 * Production-wise they're the same call; the two tool defs differ
 * only in their argument-schema hint to the model (string-only on the
 * back-compat tool, any-JSON on the newer one). Centralising the
 * impl here means a fix lands once.
 */
export async function runVscodeCommandImpl(deps: CommandRunner, input: RunVscodeCommandInput): Promise<string> {
    if (!input.command) { return JSON.stringify({ error: '`command` is required.' }); }
    try {
        const result = await deps.executeCommand(input.command, input.args ?? []);
        return JSON.stringify({
            success: true,
            command: input.command,
            safeListed: isSafeVscodeCommand(input.command),
            result: result === undefined ? null : result,
        });
    } catch (err) {
        return JSON.stringify({
            error: `Command failed: ${(err as Error).message}`,
            command: input.command,
        });
    }
}

export const RUN_VSCODE_COMMAND_DESCRIPTION =
    'Execute a VS Code command by ID with a string-args array. This is the ' +
    'simpler back-compat entry point — for arbitrary JSON-typed args (objects, ' +
    'numbers, booleans) prefer `tomAi_runVscodeCommandTyped`. Both tools have ' +
    'identical runtime semantics (pass args verbatim to `vscode.commands.' +
    'executeCommand`); they differ only in the input-schema hint. Pair with ' +
    '`tomAi_listCommands` to discover IDs. The response includes `safeListed: ' +
    'true` when the command id matches a known-safe prefix (`editor.action.*`, ' +
    '`workbench.view.*`, `cursorMove`, …); commands outside the safe list ' +
    'should be reviewed before approval.';

export const RUN_VSCODE_COMMAND_TOOL: SharedToolDefinition<RunVscodeCommandInput> = {
    name: 'tomAi_runVscodeCommand',
    displayName: 'Run VS Code Command',
    description: RUN_VSCODE_COMMAND_DESCRIPTION,
    tags: ['vscode', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'VS Code command ID. See `tomAi_listCommands`.' },
            args: {
                type: 'array',
                description: 'String arguments. For typed args (objects/numbers/booleans) use `tomAi_runVscodeCommandTyped`.',
                items: { type: 'string' },
            },
        },
        required: ['command'],
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

export const RUN_VSCODE_COMMAND_TYPED_DESCRIPTION =
    'Execute a VS Code command by ID with any JSON-typed args array (objects, ' +
    'numbers, booleans, nested structures). Pair with `tomAi_listCommands` to ' +
    'discover IDs. Same runtime as `tomAi_runVscodeCommand` — the difference ' +
    'is purely the input-schema hint: this tool advertises a typed `args` ' +
    'array and is the preferred entry point when the command needs anything ' +
    'beyond plain string arguments (e.g. `vscode.executeFormatDocumentProvider` ' +
    'wants a Uri, `editor.action.insertSnippet` wants `{ snippet: "..." }`). ' +
    'Response includes `safeListed: true` when the command id matches a known-' +
    'safe prefix (`editor.action.*`, `workbench.view.*`, `cursorMove`, …); ' +
    'commands outside the safe list should be reviewed before approval.';

export const RUN_VSCODE_COMMAND_TYPED_TOOL: SharedToolDefinition<RunVscodeCommandInput> = {
    name: 'tomAi_runVscodeCommandTyped',
    displayName: 'Run VS Code Command (Typed Args)',
    description: RUN_VSCODE_COMMAND_TYPED_DESCRIPTION,
    tags: ['vscode', 'meta', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
            command: { type: 'string', description: 'VS Code command ID. See `tomAi_listCommands`.' },
            args: { type: 'array', description: 'JSON-typed args (any shape).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// listCommands
// ===========================================================================

export interface ListCommandsInput {
    filter?: string;
    includeInternal?: boolean;
    maxResults?: number;
}

export async function listCommandsImpl(deps: CommandRunner, input: ListCommandsInput): Promise<string> {
    try {
        const all = await deps.listCommands(!input.includeInternal);
        const max = Math.max(1, input.maxResults ?? 500);
        const filter = (input.filter ?? '').toLowerCase();
        const matches = filter ? all.filter((c) => c.toLowerCase().includes(filter)) : all;
        // Sort for stable output — `vscode.commands.getCommands` order is unspecified.
        matches.sort();
        const slice = matches.slice(0, max);
        return JSON.stringify({
            totalMatches: matches.length,
            returned: slice.length,
            truncated: matches.length > slice.length,
            commands: slice,
        }, null, 2);
    } catch (err) {
        return JSON.stringify({ error: `List commands failed: ${(err as Error).message}` });
    }
}

export const LIST_COMMANDS_DESCRIPTION =
    'List registered VS Code command IDs, optionally filtered by substring ' +
    '(case-insensitive). Results are sorted alphabetically for stable output. ' +
    'Use before `tomAi_runVscodeCommand` / `tomAi_runVscodeCommandTyped` when ' +
    'the exact command id is unknown — e.g. `filter: "editor.action.format"` ' +
    'to find formatter commands. Internal (`_`-prefixed) commands are hidden ' +
    'by default; pass `includeInternal: true` to see them too. Default cap ' +
    '500; the response flags `truncated: true` when the cap dropped matches.';

export const LIST_COMMANDS_TOOL: SharedToolDefinition<ListCommandsInput> = {
    name: 'tomAi_listCommands',
    displayName: 'List VS Code Commands',
    description: LIST_COMMANDS_DESCRIPTION,
    tags: ['vscode', 'discovery', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filter: { type: 'string', description: 'Substring filter (case-insensitive). Example: "editor.action".' },
            includeInternal: { type: 'boolean', description: 'Include VS Code internal commands (underscore-prefixed). Default false.' },
            maxResults: { type: 'number', description: 'Max commands returned (default 500).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// openFile
// ===========================================================================

export interface OpenFileInput {
    filePath: string;
    /** 1-based line to reveal. Default: scroll to top. */
    line?: number;
    /** 1-based column. Default 1. */
    column?: number;
    /** 1-based end line for a selection range. Default = line. */
    endLine?: number;
    /** 1-based end column. Default = column. */
    endColumn?: number;
    preview?: boolean;
    preserveFocus?: boolean;
    viewColumn?: number;
}

export async function openFileImpl(deps: FileOpener, input: OpenFileInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: '`filePath` is required.' }); }
    const abs = path.isAbsolute(input.filePath)
        ? input.filePath
        : resolveAgainstWsRoot(input.filePath, deps.wsRoot);
    if (!isInsideWorkspace(abs, deps.wsRoot)) {
        return JSON.stringify({ error: `Path is outside the workspace: ${input.filePath}` });
    }
    if (!deps.exists(abs)) {
        return JSON.stringify({ error: `File not found: ${abs}` });
    }

    const options: OpenFileShowOptions = {
        preview: input.preview ?? false,
        preserveFocus: input.preserveFocus ?? false,
        viewColumn: input.viewColumn,
    };

    // Convert 1-based (user-facing) → 0-based (vscode API). Translation
    // lives here, not in the production bridge, so the dep contract
    // matches what vscode expects.
    if (typeof input.line === 'number') {
        const startLine = Math.max(0, input.line - 1);
        const startCol = Math.max(0, (input.column ?? 1) - 1);
        const endLine = Math.max(startLine, (input.endLine ?? input.line) - 1);
        const endCol = Math.max(0, (input.endColumn ?? input.column ?? 1) - 1);
        options.selection = { startLine, startCol, endLine, endCol };
    }

    const result = await deps.openInEditor(abs, options);
    if (!result.ok) {
        return JSON.stringify({ error: `Could not open: ${result.reason}` });
    }
    return JSON.stringify({
        success: true,
        file: abs,
        language: result.languageId,
        lineCount: result.lineCount,
    });
}

export const OPEN_FILE_DESCRIPTION =
    'Open a file in the editor and optionally scroll to a line/column or ' +
    'select a range. **Line/column are 1-based** (consistent with `tomAi_readFile` ' +
    'and the rest of the tool surface) — translated to VS Code\'s 0-based ' +
    'API internally. Purely navigational; does not modify file contents. ' +
    'Path traversal outside the workspace is rejected. Missing file returns ' +
    'a clear `File not found` error rather than a vscode internal failure.';

export const OPEN_FILE_TOOL: SharedToolDefinition<OpenFileInput> = {
    name: 'tomAi_openFile',
    displayName: 'Open File',
    description: OPEN_FILE_DESCRIPTION,
    tags: ['editor', 'navigation', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute file path.' },
            line: { type: 'number', description: '1-based line to reveal (optional).' },
            column: { type: 'number', description: '1-based column. Default 1.' },
            endLine: { type: 'number', description: '1-based end line for a selection range. Default = line.' },
            endColumn: { type: 'number', description: '1-based end column. Default = column.' },
            preview: { type: 'boolean', description: 'Open in preview mode (italic tab). Default false.' },
            preserveFocus: { type: 'boolean', description: 'Keep focus in the current editor. Default false.' },
            viewColumn: { type: 'number', description: 'Split view column (1, 2, 3). Default: active.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// Master list — now includes RUN_VSCODE_COMMAND_TOOL too (relocated from
// tool-executors.ts so the impl + def + tests live in one place).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const VSCODE_COMMAND_TOOLS: SharedToolDefinition<any>[] = [
    RUN_VSCODE_COMMAND_TOOL,
    RUN_VSCODE_COMMAND_TYPED_TOOL,
    LIST_COMMANDS_TOOL,
    OPEN_FILE_TOOL,
];
