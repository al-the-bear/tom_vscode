/**
 * Notebook tools — edit and run Jupyter notebook cells.
 *
 * Edits go through `NotebookEdit` + `WorkspaceEdit` so they are transactional.
 * Cell execution is dispatched via the VS Code commands
 * `notebook.execute` / `notebook.cell.execute`; outputs stream asynchronously
 * after dispatch.
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
// tomAi_notebookEdit
// ---------------------------------------------------------------------------

interface NotebookCellInput { kind: 'code' | 'markdown'; text: string; language?: string }

interface NotebookEditOp {
    op: 'insert' | 'replace' | 'delete';
    index?: number;
    endIndex?: number;
    cells?: NotebookCellInput[];
}

interface NotebookEditInput { filePath: string; operations: NotebookEditOp[] }

function toCellData(c: NotebookCellInput): vscode.NotebookCellData {
    const kind = c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const language = c.language ?? (c.kind === 'markdown' ? 'markdown' : 'python');
    return new vscode.NotebookCellData(kind, c.text ?? '', language);
}

async function executeNotebookEdit(input: NotebookEditInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: 'filePath is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `Notebook not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);

    let doc: vscode.NotebookDocument;
    try { doc = await vscode.workspace.openNotebookDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open notebook: ${err?.message ?? err}` }); }

    const edit = new vscode.WorkspaceEdit();
    const edits: vscode.NotebookEdit[] = [];
    for (const op of input.operations) {
        try {
            if (op.op === 'insert') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'insert requires index' }); }
                if (!op.cells?.length) { return JSON.stringify({ error: 'insert requires cells' }); }
                edits.push(vscode.NotebookEdit.insertCells(op.index, op.cells.map(toCellData)));
            } else if (op.op === 'replace') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'replace requires index' }); }
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.replaceCells(
                    new vscode.NotebookRange(op.index, end),
                    (op.cells ?? []).map(toCellData),
                ));
            } else if (op.op === 'delete') {
                if (typeof op.index !== 'number') { return JSON.stringify({ error: 'delete requires index' }); }
                const end = op.endIndex ?? op.index + 1;
                edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(op.index, end)));
            } else {
                return JSON.stringify({ error: `Unknown op: ${op.op}` });
            }
        } catch (err: any) {
            return JSON.stringify({ error: `Failed to prepare ${op.op}: ${err?.message ?? err}` });
        }
    }
    edit.set(uri, edits);
    try {
        const applied = await vscode.workspace.applyEdit(edit);
        return JSON.stringify({
            applied,
            operationCount: input.operations.length,
            cellCountAfter: doc.cellCount,
        });
    } catch (err: any) {
        return JSON.stringify({ error: `Notebook edit failed: ${err?.message ?? err}` });
    }
}

export const NOTEBOOK_EDIT_TOOL: SharedToolDefinition<NotebookEditInput> = {
    name: 'tomAi_notebookEdit',
    displayName: 'Notebook Edit',
    description:
        'Insert / replace / delete cells in a Jupyter notebook. Operations are applied transactionally via a WorkspaceEdit.',
    tags: ['notebook', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'operations'],
        properties: {
            filePath: { type: 'string' },
            operations: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { type: 'string', enum: ['insert', 'replace', 'delete'] },
                        index: { type: 'number', description: 'Zero-based cell index.' },
                        endIndex: { type: 'number', description: 'Exclusive end index for replace/delete.' },
                        cells: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['kind', 'text'],
                                properties: {
                                    kind: { type: 'string', enum: ['code', 'markdown'] },
                                    text: { type: 'string' },
                                    language: { type: 'string', description: 'Cell language id. Default python (code) / markdown.' },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    execute: executeNotebookEdit,
};

// ---------------------------------------------------------------------------
// tomAi_notebookRun
// ---------------------------------------------------------------------------

interface NotebookRunInput { filePath: string; cellIndices?: number[]; runAll?: boolean }

async function executeNotebookRun(input: NotebookRunInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: 'filePath is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `Notebook not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try {
        const doc = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(doc);

        if (input.runAll) {
            await vscode.commands.executeCommand('notebook.execute');
            return JSON.stringify({ ran: 'all', cellCount: doc.cellCount, note: 'Execution dispatched; outputs may still be streaming.' });
        }

        if (Array.isArray(input.cellIndices) && input.cellIndices.length > 0) {
            for (const idx of input.cellIndices) {
                if (idx < 0 || idx >= doc.cellCount) { continue; }
                await vscode.commands.executeCommand('notebook.cell.execute', { start: idx, end: idx + 1 });
            }
            return JSON.stringify({ ran: input.cellIndices, note: 'Execution dispatched; outputs may still be streaming.' });
        }

        return JSON.stringify({ error: 'Provide runAll=true or a non-empty cellIndices array.' });
    } catch (err: any) {
        return JSON.stringify({ error: `Notebook run failed: ${err?.message ?? err}` });
    }
}

export const NOTEBOOK_RUN_TOOL: SharedToolDefinition<NotebookRunInput> = {
    name: 'tomAi_notebookRun',
    displayName: 'Notebook Run',
    description:
        'Execute cells in a Jupyter notebook. Either runAll=true or a cellIndices array. ' +
        'Note: outputs stream asynchronously after dispatch; re-open the file to inspect results.',
    tags: ['notebook', 'execution', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string' },
            cellIndices: { type: 'array', items: { type: 'number' } },
            runAll: { type: 'boolean' },
        },
    },
    execute: executeNotebookRun,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NOTEBOOK_TOOLS: SharedToolDefinition<any>[] = [
    NOTEBOOK_EDIT_TOOL,
    NOTEBOOK_RUN_TOOL,
];
