/**
 * Editor & workspace context tools — `tomAi_getWorkspaceInfo`,
 * `tomAi_getActiveEditor`, `tomAi_getOpenEditors`.
 *
 * Read-only situational awareness: what workspace the user has open,
 * what file / selection they are looking at, and which tabs are
 * currently loaded. All tools here are `readOnly: true,
 * requiresApproval: false`.
 *
 * Refactored for coverage entry #9:
 *
 *   - **vscode-free at runtime.** Impls take snapshot-style deps —
 *     production captures a snapshot from `vscode.window.*` at call
 *     time, tests pass pre-built snapshots. The bridge is in
 *     `tool-executors.ts`.
 *
 *   - **getActiveEditor line numbers switched to 1-based** so the
 *     same model that uses `tomAi_readFile`/`tomAi_openFile` (both
 *     1-based after the entry #1 / #6 refactors) doesn't have to
 *     remember a third convention. Internally we still read vscode's
 *     0-based Position and convert at the boundary.
 *
 *   - **Output-channel / pseudo-document URIs flagged** explicitly
 *     via `scheme` field. A `vscode.TextDocument` for an Output
 *     channel has `uri.scheme: "output"`; previously the tool would
 *     return it like any other file with a strange fsPath. Now the
 *     model can tell.
 *
 *   - **Tab-input type surfaced** on getOpenEditors. The previous
 *     impl returned `file: undefined` for non-text tabs (diff,
 *     custom, webview, notebook) without saying why. Now `kind`
 *     reports the tab type so the model isn't left guessing.
 *
 *   - **`includePreview` removed** from getOpenEditors — it was a
 *     declared-but-unused param. `preview` is already in every tab
 *     entry, so the model can filter at the read site.
 *
 *   - **Empty / missing data surfaces explicit markers** instead of
 *     `undefined`: getWorkspaceInfo reports `git: null` when not a
 *     git repo, `projectsSource: null` when no `tom_master.yaml`.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Snapshot shapes — what the production bridge passes to the impls
// ===========================================================================

export interface WorkspaceFolderSnapshot {
    name: string;
    fsPath: string;
}

export interface ProjectSnapshot {
    id: string;
    name: string;
    path?: string;
    type?: string;
}

export interface GitSnapshot {
    branch?: string;
    commit?: string;
    dirty?: boolean;
    remote?: string;
}

export interface WorkspaceInfoSnapshot {
    workspaceName: string;
    workspaceFile: string;
    workspaceFolders: WorkspaceFolderSnapshot[];
    questId: string;
    projects: ProjectSnapshot[] | null;
    /** Whether `tom_master.yaml` exists at the metadata path. */
    projectsSource: string | null;
    /** Whether the workspace is a git repo. `null` means not a repo. */
    git: GitSnapshot | null;
}

export interface EditorSelectionSnapshot {
    /** 1-based, inclusive — converted from vscode's 0-based Position. */
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    isEmpty: boolean;
    /** Selected text (already truncated if it exceeded maxSelectionChars). */
    text?: string;
}

export interface EditorSnapshot {
    file: string;
    absolutePath: string;
    /** `file`, `untitled`, `output`, `git`, … — VS Code's URI scheme. */
    scheme: string;
    language: string;
    lineCount: number;
    dirty: boolean;
    untitled: boolean;
    /** 1-based cursor position. */
    cursor: { line: number; character: number };
    selection: EditorSelectionSnapshot;
    /** 1-based visible line range, or null if unavailable. */
    visibleRange: { startLine: number; endLine: number } | null;
}

export type TabKind = 'text' | 'text-diff' | 'notebook' | 'notebook-diff' | 'custom' | 'webview' | 'terminal' | 'unknown';

export interface TabSnapshot {
    /** View-column group number (1, 2, 3, …). */
    group: number | undefined;
    label: string;
    /** Workspace-relative file path. `null` for tabs that don't represent a file (webview, terminal, output). */
    file: string | null;
    absolutePath: string | null;
    kind: TabKind;
    active: boolean;
    dirty: boolean;
    pinned: boolean;
    preview: boolean;
}

// ===========================================================================
// Dep interfaces
// ===========================================================================

export interface WorkspaceInfoSource {
    /**
     * Build the workspace snapshot. Production reads from
     * `vscode.workspace.*`, parses `tom_master.yaml` if it exists,
     * and (optionally) runs git rev-parse/status. Tests pass a
     * pre-built snapshot.
     */
    snapshot(opts: { includeGit: boolean }): Promise<WorkspaceInfoSnapshot>;
}

export interface ActiveEditorSource {
    /**
     * Return the active editor snapshot, or `null` if no editor is
     * focused. `maxSelectionChars` is the upper bound for the
     * returned selection text; the source is responsible for
     * truncating + appending an ellipsis when the bound trips.
     */
    snapshot(opts: { includeSelectionText: boolean; maxSelectionChars: number }): EditorSnapshot | null;
}

export interface OpenEditorsSource {
    snapshot(): TabSnapshot[];
}

// ===========================================================================
// getWorkspaceInfo
// ===========================================================================

export interface GetWorkspaceInfoInput {
    /** Default true. Set false to skip the git CLI calls. */
    includeGit?: boolean;
}

export async function getWorkspaceInfoImpl(
    deps: { source: WorkspaceInfoSource },
    input: GetWorkspaceInfoInput,
): Promise<string> {
    const snap = await deps.source.snapshot({ includeGit: input.includeGit !== false });
    return JSON.stringify({
        workspaceName: snap.workspaceName,
        workspaceFile: snap.workspaceFile,
        workspaceFolders: snap.workspaceFolders.map((f, i) => ({ index: i, name: f.name, path: f.fsPath })),
        quest: snap.questId === 'default' ? '' : snap.questId,
        projects: snap.projects,
        projectsSource: snap.projectsSource,
        git: snap.git,
    }, null, 2);
}

export const GET_WORKSPACE_INFO_DESCRIPTION =
    'Return workspace context as JSON: `workspaceName`, `workspaceFile` ' +
    '(`.code-workspace` path if any), `workspaceFolders` (each with index/name/path), ' +
    '`quest` (active quest id, empty string when none), `projects` ' +
    '(parsed from `.tom_metadata/tom_master.yaml`; null when the file is ' +
    'absent), `projectsSource` (the path the projects came from, or null), ' +
    'and `git` (`{branch, commit, dirty, remote}`; null when not a git repo). ' +
    'Pass `includeGit: false` to skip the git CLI calls when you only need the ' +
    'workspace shape.';

export const GET_WORKSPACE_INFO_TOOL: SharedToolDefinition<GetWorkspaceInfoInput> = {
    name: 'tomAi_getWorkspaceInfo',
    displayName: 'Get Workspace Info',
    description: GET_WORKSPACE_INFO_DESCRIPTION,
    tags: ['workspace', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeGit: { type: 'boolean', description: 'Include git branch/commit/dirty. Default true.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// getActiveEditor
// ===========================================================================

export interface GetActiveEditorInput {
    includeSelectionText?: boolean;
    maxSelectionChars?: number;
}

export async function getActiveEditorImpl(
    deps: { source: ActiveEditorSource },
    input: GetActiveEditorInput,
): Promise<string> {
    const snap = deps.source.snapshot({
        includeSelectionText: input.includeSelectionText !== false,
        maxSelectionChars: Math.max(0, input.maxSelectionChars ?? 4000),
    });
    if (!snap) {
        return JSON.stringify({ active: false });
    }
    return JSON.stringify({
        active: true,
        file: snap.file,
        absolutePath: snap.absolutePath,
        scheme: snap.scheme,
        language: snap.language,
        lineCount: snap.lineCount,
        dirty: snap.dirty,
        untitled: snap.untitled,
        selection: {
            startLine: snap.selection.startLine,
            startCharacter: snap.selection.startCharacter,
            endLine: snap.selection.endLine,
            endCharacter: snap.selection.endCharacter,
            isEmpty: snap.selection.isEmpty,
            text: snap.selection.text,
            charLength: snap.selection.text?.length ?? 0,
        },
        cursor: snap.cursor,
        visibleRange: snap.visibleRange,
    }, null, 2);
}

export const GET_ACTIVE_EDITOR_DESCRIPTION =
    'Return the active editor as JSON: `file` (workspace-relative path), ' +
    '`absolutePath`, `scheme` (`file`/`untitled`/`output`/etc — distinguishes ' +
    'real files from Output channels and untitled buffers), `language`, ' +
    '`lineCount`, `dirty`, `untitled` flag, `selection` (1-based start/end ' +
    'positions + selected text), `cursor` (1-based line/character), and ' +
    '`visibleRange` (the lines currently scrolled into view). Returns ' +
    '`{active: false}` when no editor has focus. Selected text is truncated ' +
    'at `maxSelectionChars` (default 4000) with an ellipsis suffix. **Line/' +
    'character positions are 1-based** (consistent with `tomAi_readFile` and ' +
    '`tomAi_openFile`); converted from VS Code\'s 0-based API at the boundary.';

export const GET_ACTIVE_EDITOR_TOOL: SharedToolDefinition<GetActiveEditorInput> = {
    name: 'tomAi_getActiveEditor',
    displayName: 'Get Active Editor',
    description: GET_ACTIVE_EDITOR_DESCRIPTION,
    tags: ['editor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            includeSelectionText: { type: 'boolean', description: 'Include the selected text. Default true.' },
            maxSelectionChars: { type: 'number', description: 'Truncate selection text to N chars (with ellipsis). Default 4000.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// getOpenEditors
// ===========================================================================

export interface GetOpenEditorsInput {
    // No filters today — the response is small enough that the model
    // can filter at the read site.
    [k: string]: unknown;
}

export async function getOpenEditorsImpl(
    deps: { source: OpenEditorsSource },
    _input: GetOpenEditorsInput,
): Promise<string> {
    const tabs = deps.source.snapshot();
    return JSON.stringify({ count: tabs.length, tabs }, null, 2);
}

export const GET_OPEN_EDITORS_DESCRIPTION =
    'List every open editor tab across all view-column groups. Response: ' +
    '`{count, tabs[]}` where each tab has `group` (view-column number), ' +
    '`label`, `file` (workspace-relative path; **null** for non-file tabs ' +
    'like webviews, terminals, custom editors), `absolutePath`, `kind` ' +
    '(`text`/`text-diff`/`notebook`/`notebook-diff`/`custom`/`webview`/' +
    '`terminal`/`unknown`), `active`, `dirty`, `pinned`, `preview`. The ' +
    '`kind` field tells you why a tab might have `file: null` — a webview ' +
    'or terminal genuinely has no file path; a custom-editor tab represents ' +
    'a file but VS Code doesn\'t expose it in the standard place.';

export const GET_OPEN_EDITORS_TOOL: SharedToolDefinition<GetOpenEditorsInput> = {
    name: 'tomAi_getOpenEditors',
    displayName: 'Get Open Editors',
    description: GET_OPEN_EDITORS_DESCRIPTION,
    tags: ['editor', 'context', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// Master list
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EDITOR_CONTEXT_TOOLS: SharedToolDefinition<any>[] = [
    GET_WORKSPACE_INFO_TOOL,
    GET_ACTIVE_EDITOR_TOOL,
    GET_OPEN_EDITORS_TOOL,
];
