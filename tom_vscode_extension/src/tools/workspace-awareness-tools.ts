/**
 * Wave A — workspace awareness tools (situational awareness, read-only).
 *
 * See `doc/llm_tools.md` §6.3 Wave A. All tools in this file are:
 *   - readOnly: true
 *   - requiresApproval: false
 *
 * They give the model visibility into the IDE state without any mutation.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SharedToolDefinition } from './shared-tool-registry';
import { WsPaths } from '../utils/workspacePaths';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelative(uri: vscode.Uri): string {
    const root = wsRoot();
    if (!root) { return uri.fsPath; }
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? uri.fsPath : rel;
}

function severityName(s: vscode.DiagnosticSeverity): string {
    switch (s) {
        case vscode.DiagnosticSeverity.Error: return 'error';
        case vscode.DiagnosticSeverity.Warning: return 'warning';
        case vscode.DiagnosticSeverity.Information: return 'information';
        case vscode.DiagnosticSeverity.Hint: return 'hint';
        default: return 'unknown';
    }
}

function severityFromName(name: string | undefined): vscode.DiagnosticSeverity | undefined {
    switch ((name || '').toLowerCase()) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'information':
        case 'info': return vscode.DiagnosticSeverity.Information;
        case 'hint': return vscode.DiagnosticSeverity.Hint;
        default: return undefined;
    }
}

async function resolveDocumentForPosition(
    filePath: string,
    line: number,
    character: number,
): Promise<{ uri: vscode.Uri; position: vscode.Position } | { error: string }> {
    const root = wsRoot();
    const abs = path.isAbsolute(filePath) ? filePath : (root ? path.join(root, filePath) : filePath);
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
// tomAi_getWorkspaceInfo — enhanced
// ---------------------------------------------------------------------------

interface GetWorkspaceInfoInput { includeGit?: boolean }

async function executeGetWorkspaceInfoFull(input: GetWorkspaceInfoInput): Promise<string> {
    const wsFile = vscode.workspace.workspaceFile?.fsPath ?? '';
    const wsName = vscode.workspace.name ?? '';
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f, idx) => ({
        index: idx,
        name: f.name,
        path: f.uri.fsPath,
    }));

    const questId = WsPaths.getWorkspaceQuestId();
    const root = wsRoot();

    let projects: Array<{ id: string; name: string; path?: string; type?: string }> = [];
    if (root) {
        try {
            const masterPath = WsPaths.metadata('tom_master.yaml');
            if (masterPath && fs.existsSync(masterPath)) {
                const yaml = await import('yaml');
                const doc = yaml.parse(fs.readFileSync(masterPath, 'utf8'));
                if (doc?.projects && Array.isArray(doc.projects)) {
                    projects = doc.projects.map((p: any) => ({
                        id: p.id || p.name || '',
                        name: p.name || p.id || '',
                        path: p.path,
                        type: p.type,
                    }));
                }
            }
        } catch { /* ignore */ }
    }

    let git: { branch?: string; commit?: string; dirty?: boolean; remote?: string } | undefined;
    if (input.includeGit !== false && root) {
        git = {};
        const opts = { cwd: root, timeout: 3000 };
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
            git.branch = stdout.trim();
        } catch { /* ignore */ }
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], opts);
            git.commit = stdout.trim();
        } catch { /* ignore */ }
        try {
            const { stdout } = await execFileAsync('git', ['status', '--porcelain'], opts);
            git.dirty = stdout.trim().length > 0;
        } catch { /* ignore */ }
        try {
            const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], opts);
            git.remote = stdout.trim();
        } catch { /* ignore */ }
    }

    return JSON.stringify({
        workspaceName: wsName,
        workspaceFile: wsFile,
        workspaceFolders: folders,
        quest: questId === 'default' ? '' : questId,
        projects,
        git,
    }, null, 2);
}

export const GET_WORKSPACE_INFO_FULL_TOOL: SharedToolDefinition<GetWorkspaceInfoInput> = {
    name: 'tomAi_getWorkspaceInfoFull',
    displayName: 'Get Workspace Info (Full)',
    description:
        'Return full workspace context: workspace name, .code-workspace file, folders, quest id, ' +
        'projects from tom_master.yaml, and current git branch/commit/dirty state. ' +
        'Prefer this over the legacy tomAi_getWorkspaceInfo when git details are useful.',
    tags: ['workspace', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeGit: { type: 'boolean', description: 'Include git branch/commit/dirty. Default true.' },
        },
    },
    execute: executeGetWorkspaceInfoFull,
};

// ---------------------------------------------------------------------------
// tomAi_getActiveEditor
// ---------------------------------------------------------------------------

interface GetActiveEditorInput { includeSelectionText?: boolean; maxSelectionChars?: number }

async function executeGetActiveEditor(input: GetActiveEditorInput): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return JSON.stringify({ active: false }); }
    const doc = editor.document;
    const sel = editor.selection;
    const maxChars = Math.max(0, input.maxSelectionChars ?? 4000);
    const includeText = input.includeSelectionText !== false;

    let selectionText: string | undefined;
    if (includeText) {
        const text = doc.getText(sel);
        selectionText = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    }

    const visible = editor.visibleRanges[0];
    return JSON.stringify({
        active: true,
        file: toRelative(doc.uri),
        absolutePath: doc.uri.fsPath,
        language: doc.languageId,
        lineCount: doc.lineCount,
        dirty: doc.isDirty,
        untitled: doc.isUntitled,
        encoding: (doc as any).encoding ?? undefined,
        selection: {
            startLine: sel.start.line,
            startCharacter: sel.start.character,
            endLine: sel.end.line,
            endCharacter: sel.end.character,
            isEmpty: sel.isEmpty,
            text: selectionText,
            charLength: selectionText?.length ?? 0,
        },
        cursor: { line: sel.active.line, character: sel.active.character },
        visibleRange: visible
            ? { startLine: visible.start.line, endLine: visible.end.line }
            : undefined,
    }, null, 2);
}

export const GET_ACTIVE_EDITOR_TOOL: SharedToolDefinition<GetActiveEditorInput> = {
    name: 'tomAi_getActiveEditor',
    displayName: 'Get Active Editor',
    description:
        'Return the active editor state: file path, language, selection range + selected text, cursor position, dirty flag, visible line range.',
    tags: ['editor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeSelectionText: { type: 'boolean', description: 'Include the selected text. Default true.' },
            maxSelectionChars: { type: 'number', description: 'Truncate selection text to N chars. Default 4000.' },
        },
    },
    execute: executeGetActiveEditor,
};

// ---------------------------------------------------------------------------
// tomAi_getOpenEditors
// ---------------------------------------------------------------------------

interface GetOpenEditorsInput { includePreview?: boolean }

async function executeGetOpenEditors(_input: GetOpenEditorsInput): Promise<string> {
    const groups = vscode.window.tabGroups.all;
    const tabs = groups.flatMap((g) =>
        g.tabs.map((t) => {
            const input: any = t.input;
            const uri: vscode.Uri | undefined = input?.uri;
            return {
                group: g.viewColumn,
                label: t.label,
                file: uri ? toRelative(uri) : undefined,
                absolutePath: uri?.fsPath,
                active: t.isActive,
                dirty: t.isDirty,
                pinned: t.isPinned,
                preview: t.isPreview,
            };
        }),
    );
    return JSON.stringify({ count: tabs.length, tabs }, null, 2);
}

export const GET_OPEN_EDITORS_TOOL: SharedToolDefinition<GetOpenEditorsInput> = {
    name: 'tomAi_getOpenEditors',
    displayName: 'Get Open Editors',
    description:
        'List all open editor tabs with file path, active/dirty/pinned/preview flags, and view-column group.',
    tags: ['editor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: executeGetOpenEditors,
};

// ---------------------------------------------------------------------------
// tomAi_getProblems
// ---------------------------------------------------------------------------

interface GetProblemsInput {
    filePath?: string;
    severity?: 'error' | 'warning' | 'information' | 'hint';
    source?: string;
    maxResults?: number;
}

async function executeGetProblems(input: GetProblemsInput): Promise<string> {
    const minSeverity = severityFromName(input.severity);
    const maxResults = Math.max(1, input.maxResults ?? 500);

    const allDiags: Array<[vscode.Uri, vscode.Diagnostic[]]> = input.filePath
        ? (() => {
            const root = wsRoot();
            const abs = path.isAbsolute(input.filePath!)
                ? input.filePath!
                : (root ? path.join(root, input.filePath!) : input.filePath!);
            const uri = vscode.Uri.file(abs);
            return [[uri, vscode.languages.getDiagnostics(uri)]];
        })()
        : vscode.languages.getDiagnostics();

    const items: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (const [uri, diags] of allDiags) {
        for (const d of diags) {
            if (minSeverity !== undefined && d.severity > minSeverity) { continue; }
            if (input.source && d.source !== input.source) { continue; }
            if (items.length >= maxResults) { truncated = true; break; }
            items.push({
                file: toRelative(uri),
                absolutePath: uri.fsPath,
                severity: severityName(d.severity),
                line: d.range.start.line,
                character: d.range.start.character,
                endLine: d.range.end.line,
                endCharacter: d.range.end.character,
                message: d.message,
                source: d.source,
                code: typeof d.code === 'object' ? (d.code as any).value : d.code,
            });
        }
        if (truncated) { break; }
    }

    return JSON.stringify({ count: items.length, truncated, problems: items }, null, 2);
}

export const GET_PROBLEMS_TOOL: SharedToolDefinition<GetProblemsInput> = {
    name: 'tomAi_getProblems',
    displayName: 'Get Problems',
    description:
        'Return VS Code Problems panel entries with severity/source filtering. ' +
        'Extends tomAi_getErrors with structured output and filters.',
    tags: ['diagnostics', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Optional file to limit to. Workspace-relative or absolute.' },
            severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'], description: 'Minimum severity (inclusive).' },
            source: { type: 'string', description: 'Filter by diagnostic source (e.g. "eslint", "ts", "dart").' },
            maxResults: { type: 'number', description: 'Cap on number of returned items. Default 500.' },
        },
    },
    execute: executeGetProblems,
};

// ---------------------------------------------------------------------------
// tomAi_getOutputChannel — minimal (third-party channels aren't readable via API)
// ---------------------------------------------------------------------------

interface GetOutputChannelInput { channel?: string; maxLines?: number }

async function executeGetOutputChannel(input: GetOutputChannelInput): Promise<string> {
    const registry: Record<string, string[]> = (globalThis as any).__tomAiOutputChannelRegistry ?? {};
    const names = Object.keys(registry).sort();
    if (!input.channel) {
        return JSON.stringify({
            channels: names,
            note: 'VS Code does not expose third-party output channels to other extensions. Only channels tracked by this extension are readable here.',
        }, null, 2);
    }
    const lines = registry[input.channel];
    if (!lines) {
        return JSON.stringify({
            error: `Output channel not tracked: "${input.channel}"`,
            available: names,
        }, null, 2);
    }
    const max = Math.max(1, input.maxLines ?? 500);
    const slice = lines.slice(-max);
    return JSON.stringify({ channel: input.channel, lineCount: slice.length, lines: slice }, null, 2);
}

export const GET_OUTPUT_CHANNEL_TOOL: SharedToolDefinition<GetOutputChannelInput> = {
    name: 'tomAi_getOutputChannel',
    displayName: 'Get Output Channel',
    description:
        'Read recent lines from an extension-tracked Output panel channel. ' +
        'Without a channel parameter, lists available tracked channels. ' +
        'Note: VS Code does not expose third-party output channels across extensions; only channels the Tom extension tracks are accessible.',
    tags: ['output', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            channel: { type: 'string', description: 'Name of a tracked output channel. Omit to list available channels.' },
            maxLines: { type: 'number', description: 'Max trailing lines to return. Default 500.' },
        },
    },
    execute: executeGetOutputChannel,
};

// ---------------------------------------------------------------------------
// tomAi_getTerminalOutput — limited (VS Code has no scrollback API)
// ---------------------------------------------------------------------------

interface GetTerminalOutputInput { name?: string }

async function executeGetTerminalOutput(input: GetTerminalOutputInput): Promise<string> {
    const terminals = vscode.window.terminals.map((t) => {
        const anyT: any = t;
        return {
            name: t.name,
            active: t === vscode.window.activeTerminal,
            processId: undefined as number | undefined,
            exitStatus: anyT.exitStatus ? { code: anyT.exitStatus.code } : undefined,
            hasShellIntegration: !!anyT.shellIntegration,
        };
    });

    // Fill process ids (async) — best-effort
    await Promise.all(
        vscode.window.terminals.map(async (t, idx) => {
            try { terminals[idx].processId = await t.processId; } catch { /* ignore */ }
        }),
    );

    if (input.name) {
        const match = terminals.find((t) => t.name === input.name);
        if (!match) {
            return JSON.stringify({ error: `Terminal not found: "${input.name}"`, available: terminals.map((t) => t.name) });
        }
        return JSON.stringify({
            terminal: match,
            note: 'VS Code exposes terminal metadata but not scrollback. Use shell integration or tomAi_runCommand for command output capture.',
        }, null, 2);
    }

    return JSON.stringify({
        count: terminals.length,
        terminals,
        note: 'VS Code exposes terminal metadata but not scrollback. To capture command output, use tomAi_runCommand (captures stdout/stderr directly).',
    }, null, 2);
}

export const GET_TERMINAL_OUTPUT_TOOL: SharedToolDefinition<GetTerminalOutputInput> = {
    name: 'tomAi_getTerminalOutput',
    displayName: 'Get Terminal Output',
    description:
        'List open terminals and their exit status / shell integration state. ' +
        'Note: VS Code has no API for terminal scrollback. Use tomAi_runCommand when you need captured command output.',
    tags: ['terminal', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Optional terminal name to focus on.' },
        },
    },
    execute: executeGetTerminalOutput,
};

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
// tomAi_getCodeActions
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
        'List available code actions (quick fixes / refactors) at a file range via the language server. ' +
        'Does not apply them — pair with tomAi_applyCodeAction (Wave C).',
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
// tomAi_listGuidelines + tomAi_searchGuidelines
// ---------------------------------------------------------------------------

interface ListGuidelinesInput { subfolder?: string }

function guidelinesRoot(): string | undefined {
    const root = wsRoot();
    if (!root) { return undefined; }
    const p = path.join(root, '_copilot_guidelines');
    return fs.existsSync(p) ? p : undefined;
}

function walkMarkdown(dir: string, baseDir: string): Array<{ path: string; size: number }> {
    const out: Array<{ path: string; size: number }> = [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.')) { continue; }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walkMarkdown(abs, baseDir));
        } else if (e.name.endsWith('.md')) {
            try {
                const stat = fs.statSync(abs);
                out.push({ path: path.relative(baseDir, abs), size: stat.size });
            } catch { /* ignore */ }
        }
    }
    return out;
}

async function executeListGuidelines(input: ListGuidelinesInput): Promise<string> {
    const root = guidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found' }); }
    const target = input.subfolder ? path.join(root, input.subfolder) : root;
    if (!fs.existsSync(target)) { return JSON.stringify({ error: `Subfolder not found: ${input.subfolder}` }); }
    const files = walkMarkdown(target, root).sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify({ folder: path.relative(root, target) || '.', count: files.length, files }, null, 2);
}

export const LIST_GUIDELINES_TOOL: SharedToolDefinition<ListGuidelinesInput> = {
    name: 'tomAi_listGuidelines',
    displayName: 'List Guidelines',
    description:
        'List all guideline markdown files under _copilot_guidelines/ (recursively). ' +
        'Optionally scope to a subfolder (e.g. "dart", "cloud").',
    tags: ['guidelines', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            subfolder: { type: 'string', description: 'Optional subfolder name (e.g. "dart", "cloud", "d4rt").' },
        },
    },
    execute: executeListGuidelines,
};

interface SearchGuidelinesInput { query: string; caseSensitive?: boolean; maxMatches?: number }

async function executeSearchGuidelines(input: SearchGuidelinesInput): Promise<string> {
    const root = guidelinesRoot();
    if (!root) { return JSON.stringify({ error: '_copilot_guidelines folder not found' }); }
    if (!input.query) { return JSON.stringify({ error: 'query is required' }); }
    const flags = input.caseSensitive ? 'g' : 'gi';
    const pattern = new RegExp(input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const max = Math.max(1, input.maxMatches ?? 100);

    const files = walkMarkdown(root, root);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
        if (matches.length >= max) { break; }
        let content: string;
        try { content = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                matches.push({ file: f.path, line: i + 1, text: lines[i].slice(0, 200) });
                if (matches.length >= max) { break; }
            }
            // Reset regex state for each test since /g keeps lastIndex
            pattern.lastIndex = 0;
        }
    }

    return JSON.stringify({
        query: input.query,
        count: matches.length,
        truncated: matches.length >= max,
        matches,
    }, null, 2);
}

export const SEARCH_GUIDELINES_TOOL: SharedToolDefinition<SearchGuidelinesInput> = {
    name: 'tomAi_searchGuidelines',
    displayName: 'Search Guidelines',
    description:
        'Search the _copilot_guidelines/ folder for a substring/regex and return file+line matches. ' +
        'Use to find conventions before writing code (e.g. query="test naming").',
    tags: ['guidelines', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'Substring to match. Regex special chars are escaped.' },
            caseSensitive: { type: 'boolean', description: 'Default false.' },
            maxMatches: { type: 'number', description: 'Max matches. Default 100.' },
        },
    },
    execute: executeSearchGuidelines,
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WAVE_A_TOOLS: SharedToolDefinition<any>[] = [
    GET_WORKSPACE_INFO_FULL_TOOL,
    GET_ACTIVE_EDITOR_TOOL,
    GET_OPEN_EDITORS_TOOL,
    GET_PROBLEMS_TOOL,
    GET_OUTPUT_CHANNEL_TOOL,
    GET_TERMINAL_OUTPUT_TOOL,
    FIND_SYMBOL_TOOL,
    GOTO_DEFINITION_TOOL,
    FIND_REFERENCES_TOOL,
    GET_CODE_ACTIONS_TOOL,
    LIST_GUIDELINES_TOOL,
    SEARCH_GUIDELINES_TOOL,
];
