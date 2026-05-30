/**
 * Language-service tools — refactor + rename + code actions.
 *
 * Navigation tools (`findSymbol`, `gotoDefinition`, `findReferences`)
 * were carved out into `language-navigation.ts` by the entry #10
 * coverage refactor — they're vscode-free and live there with their
 * own tests. The four tools left here all need to touch
 * `vscode.workspace.applyEdit` / `vscode.commands` / the in-memory
 * code-action registry; they'll get their own coverage pass under
 * entry #11.
 *
 * The module-level **code-action registry** caches `vscode.CodeAction`
 * objects returned by `tomAi_getCodeActionsCached` so
 * `tomAi_applyCodeAction` can apply them by id. Entries expire
 * after 5 minutes.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import {
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
} from './language-navigation';

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }
    const root = wsRoot();
    return root ? path.join(root, filePath) : filePath;
}

function toRelative(uri: vscode.Uri): string {
    const root = wsRoot();
    if (!root) { return uri.fsPath; }
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? uri.fsPath : rel;
}

async function resolveDocumentForPosition(
    filePath: string,
    line: number,
    character: number,
): Promise<{ uri: vscode.Uri; position: vscode.Position } | { error: string }> {
    const abs = resolvePath(filePath);
    if (!fs.existsSync(abs)) { return { error: `File not found: ${abs}` }; }
    const uri = vscode.Uri.file(abs);
    try {
        await vscode.workspace.openTextDocument(uri);
    } catch (err: any) {
        return { error: `Could not open document: ${err?.message ?? err}` };
    }
    return { uri, position: new vscode.Position(Math.max(0, line), Math.max(0, character)) };
}

// ---------------------------------------------------------------------------
// Code-action registry
// ---------------------------------------------------------------------------

interface CachedCodeAction {
    action: vscode.CodeAction;
    uri: vscode.Uri;
    expires: number;
}

const CODE_ACTION_REGISTRY = new Map<string, CachedCodeAction>();
const ACTION_TTL_MS = 5 * 60 * 1000;
let actionCounter = 0;

export function registerCodeAction(action: vscode.CodeAction, uri: vscode.Uri): string {
    const now = Date.now();
    for (const [k, v] of CODE_ACTION_REGISTRY.entries()) {
        if (v.expires < now) { CODE_ACTION_REGISTRY.delete(k); }
    }
    const id = `ca_${++actionCounter}_${now.toString(36)}`;
    CODE_ACTION_REGISTRY.set(id, { action, uri, expires: now + ACTION_TTL_MS });
    return id;
}

function lookupCodeAction(id: string): CachedCodeAction | undefined {
    const entry = CODE_ACTION_REGISTRY.get(id);
    if (!entry) { return undefined; }
    if (entry.expires < Date.now()) {
        CODE_ACTION_REGISTRY.delete(id);
        return undefined;
    }
    return entry;
}

// Navigation tools (findSymbol / gotoDefinition / findReferences) live in
// `language-navigation.ts` after the entry #10 refactor. They're spread
// into LANGUAGE_SERVICE_TOOLS below so the registration surface is
// unchanged; the consts are re-exported for any direct importers.
export { FIND_SYMBOL_TOOL, GOTO_DEFINITION_TOOL, FIND_REFERENCES_TOOL };

// ---------------------------------------------------------------------------
// tomAi_getCodeActions (preview only, no cache)
// ---------------------------------------------------------------------------

interface GetCodeActionsInput {
    filePath: string;
    startLine: number;
    startCharacter: number;
    endLine?: number;
    endCharacter?: number;
    only?: string;
}

async function executeGetCodeActions(input: GetCodeActionsInput): Promise<string> {
    const resolved = await resolveDocumentForPosition(input.filePath, input.startLine, input.startCharacter);
    if ('error' in resolved) { return JSON.stringify({ error: resolved.error }); }
    const endLine = input.endLine ?? input.startLine;
    const endChar = input.endCharacter ?? input.startCharacter;
    const range = new vscode.Range(
        resolved.position,
        new vscode.Position(Math.max(0, endLine), Math.max(0, endChar)),
    );
    try {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider',
            resolved.uri,
            range,
            input.only,
        );
        const items = (actions ?? []).map((a) => ({
            title: a.title,
            kind: a.kind?.value,
            isPreferred: a.isPreferred,
            hasEdit: !!a.edit,
            hasCommand: !!a.command,
            commandId: a.command?.command,
            diagnosticsCount: a.diagnostics?.length ?? 0,
        }));
        return JSON.stringify({ count: items.length, actions: items }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Code actions failed: ${err?.message ?? err}` });
    }
}

export const GET_CODE_ACTIONS_TOOL: SharedToolDefinition<GetCodeActionsInput> = {
    name: 'tomAi_getCodeActions',
    displayName: 'Get Code Actions',
    description:
        'List available code actions (quick fixes / refactors) at a file range. ' +
        'Does not apply them — use tomAi_getCodeActionsCached + tomAi_applyCodeAction when you plan to apply.',
    tags: ['refactor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'startLine', 'startCharacter'],
        properties: {
            filePath: { type: 'string' },
            startLine: { type: 'number', description: 'Zero-based start line.' },
            startCharacter: { type: 'number', description: 'Zero-based start column.' },
            endLine: { type: 'number', description: 'Zero-based end line. Defaults to startLine.' },
            endCharacter: { type: 'number', description: 'Zero-based end column. Defaults to startCharacter.' },
            only: { type: 'string', description: 'Optional CodeActionKind filter, e.g. "quickfix", "refactor".' },
        },
    },
    execute: executeGetCodeActions,
};

// ---------------------------------------------------------------------------
// tomAi_getCodeActionsCached + tomAi_applyCodeAction
// ---------------------------------------------------------------------------

interface GetCodeActionsCachedInput {
    filePath: string;
    startLine: number;
    startCharacter: number;
    endLine?: number;
    endCharacter?: number;
    only?: string;
}

async function executeGetCodeActionsCached(input: GetCodeActionsCachedInput): Promise<string> {
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try { await vscode.workspace.openTextDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open: ${err?.message ?? err}` }); }

    const endLine = input.endLine ?? input.startLine;
    const endChar = input.endCharacter ?? input.startCharacter;
    const range = new vscode.Range(
        new vscode.Position(Math.max(0, input.startLine), Math.max(0, input.startCharacter)),
        new vscode.Position(Math.max(0, endLine), Math.max(0, endChar)),
    );
    try {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            'vscode.executeCodeActionProvider', uri, range, input.only,
        );
        const items = (actions ?? []).map((a) => ({
            actionId: registerCodeAction(a, uri),
            title: a.title,
            kind: a.kind?.value,
            isPreferred: a.isPreferred,
            hasEdit: !!a.edit,
            hasCommand: !!a.command,
            commandId: a.command?.command,
            diagnosticsCount: a.diagnostics?.length ?? 0,
        }));
        return JSON.stringify({ count: items.length, actions: items }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Code actions failed: ${err?.message ?? err}` });
    }
}

export const GET_CODE_ACTIONS_CACHED_TOOL: SharedToolDefinition<GetCodeActionsCachedInput> = {
    name: 'tomAi_getCodeActionsCached',
    displayName: 'Get Code Actions (Cached)',
    description:
        'Like tomAi_getCodeActions but registers each action in a 5-minute cache and returns ' +
        'an actionId you can pass to tomAi_applyCodeAction. Use when you intend to apply an action.',
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'startLine', 'startCharacter'],
        properties: {
            filePath: { type: 'string' },
            startLine: { type: 'number' },
            startCharacter: { type: 'number' },
            endLine: { type: 'number' },
            endCharacter: { type: 'number' },
            only: { type: 'string' },
        },
    },
    execute: executeGetCodeActionsCached,
};

interface ApplyCodeActionInput { actionId: string }

async function executeApplyCodeAction(input: ApplyCodeActionInput): Promise<string> {
    if (!input.actionId) { return JSON.stringify({ error: 'actionId is required' }); }
    const entry = lookupCodeAction(input.actionId);
    if (!entry) {
        return JSON.stringify({
            error: `Action not found or expired: ${input.actionId}. ` +
                'Re-run tomAi_getCodeActionsCached and use a fresh actionId.',
        });
    }
    const { action } = entry;
    const result: Record<string, unknown> = { actionId: input.actionId, title: action.title };
    try {
        if (action.edit) {
            const applied = await vscode.workspace.applyEdit(action.edit);
            result.editApplied = applied;
        }
        if (action.command) {
            const cmdResult = await vscode.commands.executeCommand(
                action.command.command, ...(action.command.arguments ?? []),
            );
            result.commandResult = cmdResult ?? null;
        }
        result.success = true;
        return JSON.stringify(result, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Apply code action failed: ${err?.message ?? err}` });
    }
}

export const APPLY_CODE_ACTION_TOOL: SharedToolDefinition<ApplyCodeActionInput> = {
    name: 'tomAi_applyCodeAction',
    displayName: 'Apply Code Action',
    description:
        'Apply a code action previously returned by tomAi_getCodeActionsCached. ' +
        'Executes the action\'s workspace edit and/or command. IDs expire after 5 minutes.',
    tags: ['refactor', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['actionId'],
        properties: {
            actionId: { type: 'string', description: 'The actionId returned from tomAi_getCodeActionsCached.' },
        },
    },
    execute: executeApplyCodeAction,
};

// ---------------------------------------------------------------------------
// tomAi_rename
// ---------------------------------------------------------------------------

interface RenameInput { filePath: string; line: number; character: number; newName: string }

async function executeRename(input: RenameInput): Promise<string> {
    if (!input.newName) { return JSON.stringify({ error: 'newName is required' }); }
    const abs = resolvePath(input.filePath);
    if (!fs.existsSync(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }
    const uri = vscode.Uri.file(abs);
    try { await vscode.workspace.openTextDocument(uri); }
    catch (err: any) { return JSON.stringify({ error: `Could not open: ${err?.message ?? err}` }); }
    const pos = new vscode.Position(Math.max(0, input.line), Math.max(0, input.character));
    try {
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            'vscode.executeDocumentRenameProvider', uri, pos, input.newName,
        );
        if (!edit || typeof (edit as any).size !== 'number' || (edit as any).size === 0) {
            return JSON.stringify({ error: 'Rename provider returned no edits. Position may not be a renameable symbol.' });
        }
        const applied = await vscode.workspace.applyEdit(edit);
        const affected: string[] = [];
        for (const [uri] of (edit as any).entries() as Iterable<[vscode.Uri, unknown]>) {
            affected.push(toRelative(uri));
        }
        return JSON.stringify({ applied, newName: input.newName, affectedFiles: affected }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Rename failed: ${err?.message ?? err}` });
    }
}

export const RENAME_TOOL: SharedToolDefinition<RenameInput> = {
    name: 'tomAi_rename',
    displayName: 'Rename Symbol',
    description:
        'Workspace-wide rename of the symbol at a given file/line/character using the language server. ' +
        'Safer than text replacement because the LSP understands scope.',
    tags: ['refactor', 'symbols', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character', 'newName'],
        properties: {
            filePath: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' },
            newName: { type: 'string' },
        },
    },
    execute: executeRename,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LANGUAGE_SERVICE_TOOLS: SharedToolDefinition<any>[] = [
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
    GET_CODE_ACTIONS_TOOL,
    GET_CODE_ACTIONS_CACHED_TOOL,
    APPLY_CODE_ACTION_TOOL,
    RENAME_TOOL,
];
