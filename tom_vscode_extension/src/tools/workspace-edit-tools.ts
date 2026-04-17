/**
 * Workspace-edit tools — transactional multi-file changes via WorkspaceEdit.
 *
 * This is the atomic-undo counterpart to the per-file mutating tools
 * (`tomAi_editFile`, `tomAi_createFile`, etc.) that live in `tool-executors.ts`.
 */

import * as vscode from 'vscode';
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
// tomAi_applyEdit
// ---------------------------------------------------------------------------

interface ApplyEditInputRange { startLine: number; startCharacter: number; endLine: number; endCharacter: number }

interface ApplyEditOp {
    op: 'replace' | 'insert' | 'delete' | 'createFile' | 'deleteFile' | 'renameFile';
    filePath?: string;
    fromPath?: string;
    toPath?: string;
    range?: ApplyEditInputRange;
    position?: { line: number; character: number };
    text?: string;
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    ignoreIfNotExists?: boolean;
}

interface ApplyEditInput { operations: ApplyEditOp[] }

async function executeApplyEdit(input: ApplyEditInput): Promise<string> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
        return JSON.stringify({ error: 'operations must be a non-empty array' });
    }
    const edit = new vscode.WorkspaceEdit();

    for (const op of input.operations) {
        try {
            if (op.op === 'createFile') {
                if (!op.filePath) { return JSON.stringify({ error: 'createFile requires filePath' }); }
                edit.createFile(vscode.Uri.file(resolvePath(op.filePath)), {
                    overwrite: !!op.overwrite,
                    ignoreIfExists: op.ignoreIfExists ?? true,
                });
                continue;
            }
            if (op.op === 'deleteFile') {
                if (!op.filePath) { return JSON.stringify({ error: 'deleteFile requires filePath' }); }
                edit.deleteFile(vscode.Uri.file(resolvePath(op.filePath)), {
                    ignoreIfNotExists: op.ignoreIfNotExists ?? false,
                });
                continue;
            }
            if (op.op === 'renameFile') {
                if (!op.fromPath || !op.toPath) {
                    return JSON.stringify({ error: 'renameFile requires fromPath and toPath' });
                }
                edit.renameFile(
                    vscode.Uri.file(resolvePath(op.fromPath)),
                    vscode.Uri.file(resolvePath(op.toPath)),
                    { overwrite: !!op.overwrite, ignoreIfExists: op.ignoreIfExists ?? false },
                );
                continue;
            }
            if (!op.filePath) { return JSON.stringify({ error: `${op.op} requires filePath` }); }
            const uri = vscode.Uri.file(resolvePath(op.filePath));
            if (op.op === 'insert') {
                if (!op.position) { return JSON.stringify({ error: 'insert requires position' }); }
                edit.insert(uri, new vscode.Position(op.position.line, op.position.character), op.text ?? '');
                continue;
            }
            if (op.op === 'delete') {
                if (!op.range) { return JSON.stringify({ error: 'delete requires range' }); }
                edit.delete(uri, new vscode.Range(
                    new vscode.Position(op.range.startLine, op.range.startCharacter),
                    new vscode.Position(op.range.endLine, op.range.endCharacter),
                ));
                continue;
            }
            if (op.op === 'replace') {
                if (!op.range) { return JSON.stringify({ error: 'replace requires range' }); }
                edit.replace(uri, new vscode.Range(
                    new vscode.Position(op.range.startLine, op.range.startCharacter),
                    new vscode.Position(op.range.endLine, op.range.endCharacter),
                ), op.text ?? '');
                continue;
            }
            return JSON.stringify({ error: `Unknown op: ${op.op}` });
        } catch (err: any) {
            return JSON.stringify({ error: `Failed to prepare ${op.op}: ${err?.message ?? err}` });
        }
    }

    try {
        const applied = await vscode.workspace.applyEdit(edit);
        return JSON.stringify({ applied, operationCount: input.operations.length });
    } catch (err: any) {
        return JSON.stringify({ error: `applyEdit failed: ${err?.message ?? err}` });
    }
}

export const APPLY_EDIT_TOOL: SharedToolDefinition<ApplyEditInput> = {
    name: 'tomAi_applyEdit',
    displayName: 'Apply Workspace Edit',
    description:
        'Apply a transactional multi-file WorkspaceEdit (atomic undo). ' +
        'Operations: replace/insert/delete within a file; createFile/deleteFile/renameFile at the workspace level. ' +
        'Prefer this over multiple tomAi_editFile calls for refactors.',
    tags: ['files', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['operations'],
        properties: {
            operations: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { type: 'string', enum: ['replace', 'insert', 'delete', 'createFile', 'deleteFile', 'renameFile'] },
                        filePath: { type: 'string' },
                        fromPath: { type: 'string' },
                        toPath: { type: 'string' },
                        text: { type: 'string' },
                        range: {
                            type: 'object',
                            properties: {
                                startLine: { type: 'number' },
                                startCharacter: { type: 'number' },
                                endLine: { type: 'number' },
                                endCharacter: { type: 'number' },
                            },
                        },
                        position: {
                            type: 'object',
                            properties: {
                                line: { type: 'number' },
                                character: { type: 'number' },
                            },
                        },
                        overwrite: { type: 'boolean' },
                        ignoreIfExists: { type: 'boolean' },
                        ignoreIfNotExists: { type: 'boolean' },
                    },
                },
            },
        },
    },
    execute: executeApplyEdit,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKSPACE_EDIT_TOOLS: SharedToolDefinition<any>[] = [
    APPLY_EDIT_TOOL,
];
