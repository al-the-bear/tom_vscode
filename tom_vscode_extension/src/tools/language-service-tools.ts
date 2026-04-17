/**
 * Language-service tools — symbol search, navigation, refactor, rename.
 *
 * All tools here talk to VS Code's language servers via `executeCommand`. A
 * module-level **code-action registry** caches `vscode.CodeAction` objects
 * returned by `tomAi_getCodeActionsCached` so `tomAi_applyCodeAction` can
 * apply them by id. Entries expire after 5 minutes.
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

// ---------------------------------------------------------------------------
// tomAi_findSymbol
// ---------------------------------------------------------------------------

interface FindSymbolInput { query: string; maxResults?: number }

async function executeFindSymbol(input: FindSymbolInput): Promise<string> {
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const max = Math.max(1, input.maxResults ?? 100);
    try {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            input.query,
        );
        const items = (symbols ?? []).slice(0, max).map((s) => ({
            name: s.name,
            kind: vscode.SymbolKind[s.kind],
            containerName: s.containerName,
            file: toRelative(s.location.uri),
            line: s.location.range.start.line,
            character: s.location.range.start.character,
        }));
        return JSON.stringify({
            query: input.query,
            count: items.length,
            truncated: (symbols?.length ?? 0) > items.length,
            symbols: items,
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Symbol search failed: ${err?.message ?? err}` });
    }
}

export const FIND_SYMBOL_TOOL: SharedToolDefinition<FindSymbolInput> = {
    name: 'tomAi_findSymbol',
    displayName: 'Find Symbol',
    description:
        'Workspace-wide symbol search (LSP) — find classes, functions, methods matching a query string.',
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'Symbol name or substring to search for.' },
            maxResults: { type: 'number', description: 'Max results. Default 100.' },
        },
    },
    execute: executeFindSymbol,
};

// ---------------------------------------------------------------------------
// tomAi_gotoDefinition
// ---------------------------------------------------------------------------

interface GotoDefinitionInput { filePath: string; line: number; character: number }

async function executeGotoDefinition(input: GotoDefinitionInput): Promise<string> {
    const resolved = await resolveDocumentForPosition(input.filePath, input.line, input.character);
    if ('error' in resolved) { return JSON.stringify({ error: resolved.error }); }
    try {
        const locs = await vscode.commands.executeCommand<
            Array<vscode.Location | vscode.LocationLink>
        >('vscode.executeDefinitionProvider', resolved.uri, resolved.position);
        const items = (locs ?? []).map((l) => {
            const loc = l as vscode.Location;
            const link = l as vscode.LocationLink;
            const uri = loc.uri ?? link.targetUri;
            const range = loc.range ?? link.targetRange;
            return {
                file: toRelative(uri),
                absolutePath: uri.fsPath,
                startLine: range.start.line,
                startCharacter: range.start.character,
                endLine: range.end.line,
                endCharacter: range.end.character,
            };
        });
        return JSON.stringify({ count: items.length, definitions: items }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Goto definition failed: ${err?.message ?? err}` });
    }
}

export const GOTO_DEFINITION_TOOL: SharedToolDefinition<GotoDefinitionInput> = {
    name: 'tomAi_gotoDefinition',
    displayName: 'Go To Definition',
    description:
        'Resolve the definition(s) of the symbol at a given file/line/character via the language server.',
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character'],
        properties: {
            filePath: { type: 'string', description: 'File containing the symbol.' },
            line: { type: 'number', description: 'Zero-based line number.' },
            character: { type: 'number', description: 'Zero-based column.' },
        },
    },
    execute: executeGotoDefinition,
};

// ---------------------------------------------------------------------------
// tomAi_findReferences
// ---------------------------------------------------------------------------

interface FindReferencesInput {
    filePath: string;
    line: number;
    character: number;
    includeDeclaration?: boolean;
    maxResults?: number;
}

async function executeFindReferences(input: FindReferencesInput): Promise<string> {
    const resolved = await resolveDocumentForPosition(input.filePath, input.line, input.character);
    if ('error' in resolved) { return JSON.stringify({ error: resolved.error }); }
    const max = Math.max(1, input.maxResults ?? 500);
    try {
        const locs = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            resolved.uri,
            resolved.position,
        );
        const items = (locs ?? []).slice(0, max).map((l) => ({
            file: toRelative(l.uri),
            absolutePath: l.uri.fsPath,
            startLine: l.range.start.line,
            startCharacter: l.range.start.character,
            endLine: l.range.end.line,
            endCharacter: l.range.end.character,
        }));
        return JSON.stringify({
            count: items.length,
            truncated: (locs?.length ?? 0) > items.length,
            references: items,
        }, null, 2);
    } catch (err: any) {
        return JSON.stringify({ error: `Find references failed: ${err?.message ?? err}` });
    }
}

export const FIND_REFERENCES_TOOL: SharedToolDefinition<FindReferencesInput> = {
    name: 'tomAi_findReferences',
    displayName: 'Find References',
    description:
        'Find all references to the symbol at a given file/line/character via the language server.',
    tags: ['symbols', 'navigation', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character'],
        properties: {
            filePath: { type: 'string', description: 'File containing the symbol.' },
            line: { type: 'number', description: 'Zero-based line number.' },
            character: { type: 'number', description: 'Zero-based column.' },
            includeDeclaration: { type: 'boolean', description: 'Include the declaration itself. Default true.' },
            maxResults: { type: 'number', description: 'Max references returned. Default 500.' },
        },
    },
    execute: executeFindReferences,
};

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
