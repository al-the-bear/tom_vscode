/**
 * Notebook tools — edit and run Jupyter notebook cells.
 *
 *   - `tomAi_notebookEdit` — insert / replace / delete cells. Edits go
 *     through a single `WorkspaceEdit` so the whole batch is applied
 *     atomically (or not at all when the host rejects).
 *   - `tomAi_notebookRun`  — dispatch execution of cells. Outputs
 *     stream **asynchronously** after dispatch; the tool returns when
 *     the execute command resolves, not when cells have finished.
 *
 * ## Coverage entry #26 refactor (audit notes)
 *
 *   - Old impls reached into `vscode.workspace.openNotebookDocument`,
 *     `vscode.NotebookEdit.*` constructors, and `vscode.commands.
 *     executeCommand('notebook.execute')` directly — untestable
 *     without the editor. Carve-out introduces a narrow
 *     `NotebookHost` dep that the impls drive; the bridge wraps the
 *     real vscode surface.
 *   - **Conventions documented**: cell indices are 0-based (matches
 *     `vscode.NotebookRange`); `endIndex` is exclusive; `insert` at
 *     `index === cellCount` appends; cell `kind` defaults: code →
 *     python, markdown → markdown.
 *   - **Mixed envelopes cleaned up**: success returns `{ok, applied,
 *     operationCount, cellCountBefore, cellCountAfter}`; errors
 *     return `{ok: false, error, ...}` with an `opIndex` when the
 *     failure is at a specific operation.
 *   - **Path traversal closed**: `filePath` is normalised against the
 *     workspace and rejected when it escapes.
 *   - **Operation-level validation**: indices must be non-negative
 *     integers; `insert` requires non-empty `cells`; `replace`
 *     requires `cells` (may be empty to effectively delete);
 *     `endIndex` defaults to `index + 1` (single-cell op) and is
 *     documented.
 *   - **`runAll` vs `cellIndices` precedence is rejected as a conflict
 *     instead of silently preferring one**. Previously `runAll: true`
 *     silently overrode `cellIndices: [3]`; now both set is an error
 *     so the model can't ambiguously dispatch.
 *   - **Skipped cell indices are surfaced** in the run response:
 *     `dispatched` lists what was sent to the kernel, `skipped` lists
 *     the out-of-range indices the caller asked for. Old code
 *     silently dropped them via `continue`.
 *   - **Kernel selection** is documented as out-of-scope — the host
 *     uses whatever kernel is bound by VS Code's notebook
 *     controller; selecting one requires the user UI for now.
 *   - **No execution timeout** — `notebookRun` returns immediately
 *     after dispatch; long cells continue running. Documented.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep
// ===========================================================================

export interface NotebookCellInput {
    kind: 'code' | 'markdown';
    text: string;
    language?: string;
}

export type NotebookEditOp =
    | { op: 'insert';  index: number; cells: NotebookCellInput[] }
    | { op: 'replace'; index: number; endIndex?: number; cells: NotebookCellInput[] }
    | { op: 'delete';  index: number; endIndex?: number };

export interface NotebookHost {
    /** Workspace-relative paths are resolved against this absolute root. */
    workspaceRoot(): string | undefined;
    /** `true` when the file exists and is a regular file. */
    fileExists(absolutePath: string): boolean;
    /**
     * Open the notebook + return a small snapshot.  Production uses
     * `vscode.workspace.openNotebookDocument(uri)`; tests just hand
     * back a fake object recorded in their fixture map.
     */
    openNotebook(absolutePath: string): Promise<{ cellCount: number }>;
    /**
     * Apply the prepared edit batch.  Returns the boolean the host
     * returned (typically `vscode.WorkspaceEdit` applied successfully).
     */
    applyEdits(absolutePath: string, ops: NotebookEditOp[]): Promise<boolean>;
    /** Display the notebook (production: showNotebookDocument). No-op for tests. */
    showNotebook(absolutePath: string): Promise<void>;
    /**
     * Dispatch a notebook command.  Two shapes used here:
     *   - command === 'notebook.execute' (no payload) → run all cells
     *   - command === 'notebook.cell.execute', payload {start, end}  → run a single cell
     */
    executeNotebookCommand(command: string, payload?: object): Promise<void>;
}

// ===========================================================================
// JSON envelopes
// ===========================================================================

function ok<T extends object>(extra: T): string { return JSON.stringify({ ok: true, ...extra }); }
function err(message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ ok: false, error: message, ...extra });
}

// ===========================================================================
// Path resolution + traversal guard
// ===========================================================================

import * as path from 'path';

function resolveInsideWorkspace(host: NotebookHost, filePath: string): { absolute: string; error?: string } {
    if (!filePath || !filePath.trim()) { return { absolute: '', error: '`filePath` is required.' }; }
    const root = host.workspaceRoot();
    const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : root ? path.normalize(path.join(root, filePath)) : path.normalize(filePath);
    if (root) {
        const rootAbs = path.resolve(root);
        const fileAbs = path.resolve(abs);
        if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + path.sep)) {
            return { absolute: abs, error: '`filePath` escapes the workspace root.' };
        }
    }
    return { absolute: abs };
}

// ===========================================================================
// `tomAi_notebookEdit`
// ===========================================================================

export interface NotebookEditInput {
    filePath: string;
    operations: NotebookEditOp[];
}

function validateOp(op: NotebookEditOp, opIndex: number, cellCount: number): string | undefined {
    if (typeof op.index !== 'number' || !Number.isInteger(op.index) || op.index < 0) {
        return `operations[${opIndex}].index must be a non-negative integer.`;
    }
    if (op.op === 'insert') {
        if (op.index > cellCount) {
            return `operations[${opIndex}].index (${op.index}) exceeds cellCount (${cellCount}). insert allows index === cellCount to append.`;
        }
        if (!Array.isArray(op.cells) || op.cells.length === 0) {
            return `operations[${opIndex}] (insert) requires a non-empty cells array.`;
        }
    } else if (op.op === 'replace') {
        const end = op.endIndex ?? op.index + 1;
        if (!Number.isInteger(end) || end < op.index) {
            return `operations[${opIndex}].endIndex must be an integer >= index.`;
        }
        if (end > cellCount) {
            return `operations[${opIndex}] (replace) range [${op.index}, ${end}) exceeds cellCount (${cellCount}).`;
        }
        if (!Array.isArray(op.cells)) {
            return `operations[${opIndex}] (replace) requires a cells array (may be empty).`;
        }
    } else if (op.op === 'delete') {
        const end = op.endIndex ?? op.index + 1;
        if (!Number.isInteger(end) || end < op.index) {
            return `operations[${opIndex}].endIndex must be an integer >= index.`;
        }
        if (end > cellCount) {
            return `operations[${opIndex}] (delete) range [${op.index}, ${end}) exceeds cellCount (${cellCount}).`;
        }
    } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return `operations[${opIndex}].op must be one of: insert, replace, delete (got ${(op as any).op}).`;
    }
    return undefined;
}

export async function notebookEditImpl(host: NotebookHost, input: NotebookEditInput): Promise<string> {
    try {
        const resolved = resolveInsideWorkspace(host, input.filePath);
        if (resolved.error) { return err(resolved.error); }
        if (!host.fileExists(resolved.absolute)) {
            return err(`Notebook not found: ${resolved.absolute}`);
        }
        if (!Array.isArray(input.operations) || input.operations.length === 0) {
            return err('`operations` must be a non-empty array.');
        }
        const opened = await host.openNotebook(resolved.absolute);
        const cellCount = opened.cellCount;
        // Validate every op before dispatching — operations are atomic,
        // so a single invalid op rejects the whole batch.
        for (let i = 0; i < input.operations.length; i++) {
            const reason = validateOp(input.operations[i], i, cellCount);
            if (reason) { return err(reason, { opIndex: i }); }
        }
        const applied = await host.applyEdits(resolved.absolute, input.operations);
        // Re-open to read the post-edit cell count so the response is
        // accurate even when the host hands back a stale snapshot from
        // openNotebook().
        const after = await host.openNotebook(resolved.absolute);
        return ok({
            applied,
            operationCount: input.operations.length,
            cellCountBefore: cellCount,
            cellCountAfter: after.cellCount,
        });
    } catch (e) {
        return err(`Notebook edit failed: ${(e as Error).message}`);
    }
}

export const NOTEBOOK_EDIT_DESCRIPTION =
    'Insert / replace / delete cells in a Jupyter notebook. The full ' +
    'operations array is applied atomically via a single ' +
    '`WorkspaceEdit` — a single invalid op rejects the whole batch ' +
    'before anything reaches disk. **Cell indices are 0-based**; ' +
    '`endIndex` is **exclusive** and defaults to `index + 1` ' +
    '(single-cell op). **`insert` at `index === cellCount` appends**. ' +
    '**Cell defaults**: `kind: "code"` → language `python`; ' +
    '`kind: "markdown"` → language `markdown`. Response: ' +
    '`{ok, applied, operationCount, cellCountBefore, cellCountAfter}`. ' +
    'On error: `{ok: false, error, opIndex?}` — `opIndex` is set when ' +
    'the failure is on a specific operation. Path traversal is ' +
    'rejected (filePath must stay inside the workspace).';

export const NOTEBOOK_EDIT_TOOL: SharedToolDefinition<NotebookEditInput> = {
    name: 'tomAi_notebookEdit',
    displayName: 'Notebook Edit',
    description: NOTEBOOK_EDIT_DESCRIPTION,
    tags: ['notebook', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'operations'],
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute path to a .ipynb file.' },
            operations: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    required: ['op', 'index'],
                    properties: {
                        op: { type: 'string', enum: ['insert', 'replace', 'delete'] },
                        index: { type: 'number', description: '0-based cell index. For insert, index === cellCount appends.' },
                        endIndex: { type: 'number', description: 'Exclusive end index for replace/delete. Defaults to index + 1 (single cell).' },
                        cells: {
                            type: 'array',
                            description: 'Required for insert (non-empty) and replace (may be empty to delete the range).',
                            items: {
                                type: 'object',
                                required: ['kind', 'text'],
                                properties: {
                                    kind: { type: 'string', enum: ['code', 'markdown'] },
                                    text: { type: 'string' },
                                    language: { type: 'string', description: 'Cell language id. Default: python (code) / markdown.' },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// `tomAi_notebookRun`
// ===========================================================================

export interface NotebookRunInput {
    filePath: string;
    cellIndices?: number[];
    runAll?: boolean;
}

export async function notebookRunImpl(host: NotebookHost, input: NotebookRunInput): Promise<string> {
    try {
        const resolved = resolveInsideWorkspace(host, input.filePath);
        if (resolved.error) { return err(resolved.error); }
        if (!host.fileExists(resolved.absolute)) {
            return err(`Notebook not found: ${resolved.absolute}`);
        }
        // Disambiguate runAll vs cellIndices — both set is a hard error,
        // not a silent preference for runAll. Forces the model to pick.
        const wantRunAll = input.runAll === true;
        const wantSpecific = Array.isArray(input.cellIndices) && input.cellIndices.length > 0;
        if (wantRunAll && wantSpecific) {
            return err('Specify either `runAll: true` OR a non-empty `cellIndices` array, not both.');
        }
        if (!wantRunAll && !wantSpecific) {
            return err('Specify `runAll: true` OR a non-empty `cellIndices` array.');
        }

        const opened = await host.openNotebook(resolved.absolute);
        const cellCount = opened.cellCount;
        await host.showNotebook(resolved.absolute);

        if (wantRunAll) {
            await host.executeNotebookCommand('notebook.execute');
            return ok({
                ran: 'all',
                cellCount,
                note: 'Execution dispatched; outputs may still be streaming. Re-open the notebook to inspect results.',
            });
        }

        // Specific cells: dispatched vs skipped (out-of-range).
        const indices = (input.cellIndices ?? [])
            .filter((n) => Number.isInteger(n));
        const dispatched: number[] = [];
        const skipped: number[] = [];
        for (const idx of indices) {
            if (idx < 0 || idx >= cellCount) { skipped.push(idx); continue; }
            await host.executeNotebookCommand('notebook.cell.execute', { start: idx, end: idx + 1 });
            dispatched.push(idx);
        }
        return ok({
            ran: 'cells',
            cellCount,
            dispatched,
            skipped,
            note: 'Execution dispatched; outputs may still be streaming. Re-open the notebook to inspect results.',
        });
    } catch (e) {
        return err(`Notebook run failed: ${(e as Error).message}`);
    }
}

export const NOTEBOOK_RUN_DESCRIPTION =
    'Dispatch execution of cells in a Jupyter notebook. **Either** ' +
    '`runAll: true` OR a non-empty `cellIndices` array — setting both ' +
    'is rejected (not a silent precedence). **Dispatch only** — the ' +
    'tool returns when the execute command resolves, NOT when the ' +
    'cells have finished; outputs stream asynchronously after that. ' +
    '**Out-of-range cell indices are surfaced**, not silently dropped: ' +
    'the response distinguishes `dispatched` (sent to the kernel) from ' +
    '`skipped` (out of [0, cellCount) range). **Kernel selection is ' +
    'out of scope** — the tool uses whatever kernel VS Code\'s ' +
    'notebook controller has bound; selecting a different kernel ' +
    'currently requires user UI. **No execution timeout**: long-' +
    'running cells continue after the tool returns.';

export const NOTEBOOK_RUN_TOOL: SharedToolDefinition<NotebookRunInput> = {
    name: 'tomAi_notebookRun',
    displayName: 'Notebook Run',
    description: NOTEBOOK_RUN_DESCRIPTION,
    tags: ['notebook', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute path to a .ipynb file.' },
            cellIndices: { type: 'array', items: { type: 'number' }, description: '0-based cell indices to execute. Mutually exclusive with runAll.' },
            runAll: { type: 'boolean', description: 'Run every cell in document order. Mutually exclusive with cellIndices.' },
        },
    },
    execute: async () => '{"ok":false,"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Live vscode bridge
// ===========================================================================

import * as vscode from 'vscode';
import * as fs from 'fs';

function toCellData(c: NotebookCellInput): vscode.NotebookCellData {
    const kind = c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const language = c.language ?? (c.kind === 'markdown' ? 'markdown' : 'python');
    return new vscode.NotebookCellData(kind, c.text ?? '', language);
}

const liveNotebookHost: NotebookHost = {
    workspaceRoot() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; },
    fileExists(absolutePath) {
        try { return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile(); }
        catch { return false; }
    },
    async openNotebook(absolutePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = await vscode.workspace.openNotebookDocument(uri);
        return { cellCount: doc.cellCount };
    },
    async applyEdits(absolutePath, ops) {
        const uri = vscode.Uri.file(absolutePath);
        const edit = new vscode.WorkspaceEdit();
        const edits: vscode.NotebookEdit[] = [];
        for (const op of ops) {
            if (op.op === 'insert') {
                edits.push(vscode.NotebookEdit.insertCells(op.index, op.cells.map(toCellData)));
            } else if (op.op === 'replace') {
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.replaceCells(
                    new vscode.NotebookRange(op.index, end),
                    (op.cells ?? []).map(toCellData),
                ));
            } else {
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(op.index, end)));
            }
        }
        edit.set(uri, edits);
        return vscode.workspace.applyEdit(edit);
    },
    async showNotebook(absolutePath) {
        const uri = vscode.Uri.file(absolutePath);
        const doc = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(doc);
    },
    async executeNotebookCommand(command, payload) {
        if (payload === undefined) { await vscode.commands.executeCommand(command); }
        else { await vscode.commands.executeCommand(command, payload); }
    },
};

// Tool defs are exported above with stub execute(); the executors are
// installed here from the live bridge.
NOTEBOOK_EDIT_TOOL.execute = (input) => notebookEditImpl(liveNotebookHost, input);
NOTEBOOK_RUN_TOOL.execute  = (input) => notebookRunImpl(liveNotebookHost, input);

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NOTEBOOK_TOOLS: SharedToolDefinition<any>[] = [
    NOTEBOOK_EDIT_TOOL,
    NOTEBOOK_RUN_TOOL,
];
