/**
 * Editor & workspace context tools.
 *
 * Read-only situational awareness: what workspace the user has open, what
 * file / selection they are looking at, and which tabs are currently loaded.
 * All tools here are `readOnly: true, requiresApproval: false`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SharedToolDefinition } from './shared-tool-registry';
import { WsPaths } from '../utils/workspacePaths';

const execFileAsync = promisify(execFile);

function wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toRelative(uri: vscode.Uri): string {
    const root = wsRoot();
    if (!root) { return uri.fsPath; }
    const rel = path.relative(root, uri.fsPath);
    return rel.startsWith('..') ? uri.fsPath : rel;
}

// ---------------------------------------------------------------------------
// tomAi_getWorkspaceInfoFull
// ---------------------------------------------------------------------------

interface GetWorkspaceInfoFullInput { includeGit?: boolean }

async function executeGetWorkspaceInfoFull(input: GetWorkspaceInfoFullInput): Promise<string> {
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

export const GET_WORKSPACE_INFO_FULL_TOOL: SharedToolDefinition<GetWorkspaceInfoFullInput> = {
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
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EDITOR_CONTEXT_TOOLS: SharedToolDefinition<any>[] = [
    GET_WORKSPACE_INFO_FULL_TOOL,
    GET_ACTIVE_EDITOR_TOOL,
    GET_OPEN_EDITORS_TOOL,
];
