/**
 * MD Browser tools — `tomAi_listMdBrowserPanels`, `tomAi_openInMdBrowser`,
 * `tomAi_closeMdBrowser`, and the MD Browser half of `tomAi_getOpenEditors`
 * (`markMdBrowserTabs`).
 *
 * An MD Browser tab is a webview, so VS Code's tab API says nothing about the
 * file it shows. The panels register themselves in the window's registry
 * (utils/mdBrowserRegistry.ts); these read it. vscode-free: the registry and
 * the workspace root are passed in.
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';
import type { TabSnapshot } from './editor-context-tools';
import type { MdBrowserRegistry } from '../utils/mdBrowserRegistry';

/** The MD Browser panels' webview view type (a tab reports it with a `mainThreadWebview-` prefix). */
export const MD_BROWSER_VIEW_TYPE = 'tomAi.markdownBrowser';

export interface MdBrowserToolDeps {
    registry: MdBrowserRegistry;
    workspaceRoot: string | undefined;
}

export async function listMdBrowserPanelsImpl(deps: MdBrowserToolDeps, _input: Record<string, unknown>): Promise<string> {
    const panels = deps.registry.list(deps.workspaceRoot);
    return JSON.stringify({ count: panels.length, panels }, null, 2);
}

/**
 * `tabs` with every MD Browser tab marked: `kind: "mdBrowser"`, and when the
 * registry knows the panel, its `file`, `absolutePath` and `panelId`.
 * `viewTypes[i]` is the webview view type of `tabs[i]` (undefined for a tab
 * that is not a webview).
 */
export function markMdBrowserTabs(
    tabs: TabSnapshot[],
    viewTypes: ReadonlyArray<string | undefined>,
    registry: MdBrowserRegistry,
    workspaceRoot: string | undefined,
): TabSnapshot[] {
    const isMdBrowser = tabs.map((_, i) => !!viewTypes[i] && viewTypes[i]!.endsWith(MD_BROWSER_VIEW_TYPE));
    const matched = registry.matchTabs(tabs.map((t, i) => (isMdBrowser[i] ? { group: t.group, label: t.label } : { group: undefined, label: '\u0000' })));
    const listed = new Map(registry.list(workspaceRoot).map((p) => [p.panelId, p]));
    return tabs.map((t, i) => {
        if (!isMdBrowser[i]) { return t; }
        const panel = matched[i] ? listed.get(matched[i]!.panelId) : undefined;
        return panel
            ? { ...t, kind: 'mdBrowser', file: panel.file, absolutePath: panel.absolutePath, panelId: panel.panelId }
            : { ...t, kind: 'mdBrowser' };
    });
}

export const LIST_MD_BROWSER_PANELS_DESCRIPTION =
    'List the open MD Browser panels of this window (static and live, including panels restored after a ' +
    'window reload): `{count, panels[]}`, each `{panelId, file, absolutePath, liveMode, title, viewColumn, ' +
    'active, visible, unsavedEdits}`. `file` is workspace-relative (absolute for a file outside the ' +
    'workspace). `unsavedEdits` is true while the panel has in-place editors open (answer fields or edit-mode ' +
    'text not yet saved), false when none, null before the panel reported. A panel\'s title names its file ' +
    '(`MD: <name>`, `MD (live): <name>`; the parent folder is added while another panel shows a different ' +
    'file of the same name). `tomAi_getOpenEditors` reports the same panels as tabs of `kind: "mdBrowser"`.';

export const LIST_MD_BROWSER_PANELS_TOOL: SharedToolDefinition<Record<string, unknown>> = {
    name: 'tomAi_listMdBrowserPanels',
    displayName: 'List MD Browser Panels',
    description: LIST_MD_BROWSER_PANELS_DESCRIPTION,
    tags: ['editor', 'context', 'md-browser', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// openInMdBrowser / closeMdBrowser
// ===========================================================================

/** What the tools need of the MD Browser: its registry, and opening, revealing and closing panels. */
export interface MdBrowserController extends MdBrowserToolDeps {
    exists(absPath: string): boolean;
    /** Open a new panel on `absPath` (a live request may land on the file's live panel); answers its id. */
    open(absPath: string, opts: { live: boolean; viewColumn?: number; preserveFocus?: boolean }): string | undefined;
    /** Bring a panel to the front (or into `viewColumn`) and render its file again. */
    reveal(panelId: string, opts: { viewColumn?: number; preserveFocus?: boolean }): boolean;
    /** Close these panels. */
    close(panelIds: string[]): void;
}

/** `filePath` resolved inside the workspace, or the error to answer. */
function resolveInWorkspace(filePath: string, workspaceRoot: string | undefined): { abs: string } | { error: string } {
    const root = workspaceRoot ?? '';
    const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : resolveAgainstWsRoot(filePath, root);
    if (!root || !isInsideWorkspace(abs, root)) { return { error: `Path is outside the workspace: ${filePath}` }; }
    return { abs };
}

function relativeFile(abs: string, workspaceRoot: string | undefined): string {
    if (!workspaceRoot) { return abs; }
    const rel = path.relative(workspaceRoot, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

export interface OpenInMdBrowserInput {
    filePath: string;
    live?: boolean;
    reuse?: boolean;
    viewColumn?: number;
    preserveFocus?: boolean;
}

export async function openInMdBrowserImpl(deps: MdBrowserController, input: OpenInMdBrowserInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: '`filePath` is required.' }); }
    if (!input.filePath.toLowerCase().endsWith('.md')) {
        return JSON.stringify({ error: `The MD Browser shows .md files only: ${input.filePath}` });
    }
    const resolved = resolveInWorkspace(input.filePath, deps.workspaceRoot);
    if ('error' in resolved) { return JSON.stringify({ error: resolved.error }); }
    const abs = resolved.abs;
    if (!deps.exists(abs)) { return JSON.stringify({ error: `File not found: ${abs}` }); }
    const live = input.live === true;
    const file = relativeFile(abs, deps.workspaceRoot);
    const show = { viewColumn: input.viewColumn, preserveFocus: input.preserveFocus };

    if (input.reuse !== false) {
        const onFile = deps.registry.entries().filter((e) => path.resolve(e.filePath) === abs);
        const match = onFile.find((e) => e.liveMode === live) ?? (live ? undefined : onFile[0]);
        if (match && deps.reveal(match.panelId, show)) {
            return JSON.stringify({ ok: true, panelId: match.panelId, reused: true, file });
        }
    }
    const before = new Set(deps.registry.entries().map((e) => e.panelId));
    const panelId = deps.open(abs, { live, ...show });
    if (!panelId) { return JSON.stringify({ error: `Could not open the MD Browser on ${abs}.` }); }
    return JSON.stringify({ ok: true, panelId, reused: before.has(panelId), file });
}

export const OPEN_IN_MD_BROWSER_DESCRIPTION =
    'Open a Markdown file in the MD Browser. `filePath`: a `.md` file, workspace-relative or absolute (inside ' +
    'the workspace). `reuse` (default true): a panel already showing that file is brought to the front and ' +
    'rendered again instead of opening a second one (a `live` request reuses only a live panel); `reuse: false` ' +
    'opens a new panel. `live` (default false): follow-tail mode, one live panel per file. `viewColumn` and ' +
    '`preserveFocus` place it. Answer: `{ok, panelId, reused, file}`. Close panels with `tomAi_closeMdBrowser`; ' +
    'list them with `tomAi_listMdBrowserPanels`. Requires approval.';

export const OPEN_IN_MD_BROWSER_TOOL: SharedToolDefinition<OpenInMdBrowserInput> = {
    name: 'tomAi_openInMdBrowser',
    displayName: 'Open in MD Browser',
    description: OPEN_IN_MD_BROWSER_DESCRIPTION,
    tags: ['editor', 'navigation', 'md-browser', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath'],
        properties: {
            filePath: { type: 'string', description: 'A .md file, workspace-relative or absolute.' },
            live: { type: 'boolean', description: 'Follow-tail (live) mode. Default false.' },
            reuse: { type: 'boolean', description: 'Reveal a panel already showing the file instead of opening a second. Default true.' },
            viewColumn: { type: 'number', description: 'Editor column (1, 2, 3). Default: the active one.' },
            preserveFocus: { type: 'boolean', description: 'Keep the focus where it is. Default false.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

export interface CloseMdBrowserInput {
    panelId?: string;
    filePath?: string;
    under?: string;
    exceptFilePath?: string;
    force?: boolean;
}

export async function closeMdBrowserImpl(deps: MdBrowserController, input: CloseMdBrowserInput): Promise<string> {
    const selectors = [input.panelId, input.filePath, input.under].filter((v) => typeof v === 'string' && v !== '');
    if (selectors.length !== 1) {
        return JSON.stringify({ error: 'Give exactly one of `panelId`, `filePath` or `under` (with `under`, `exceptFilePath` keeps one file open).' });
    }
    if (input.exceptFilePath && !input.under) {
        return JSON.stringify({ error: '`exceptFilePath` goes with `under`: "close the panels under this folder except this file".' });
    }
    const entries = deps.registry.entries();
    let chosen = entries;
    if (input.panelId) {
        chosen = entries.filter((e) => e.panelId === input.panelId);
        if (!chosen.length) { return JSON.stringify({ error: `No MD Browser panel ${input.panelId}; tomAi_listMdBrowserPanels lists them.` }); }
    } else if (input.filePath) {
        const r = resolveInWorkspace(input.filePath, deps.workspaceRoot);
        if ('error' in r) { return JSON.stringify({ error: r.error }); }
        chosen = entries.filter((e) => path.resolve(e.filePath) === r.abs);
    } else {
        const r = resolveInWorkspace(input.under!, deps.workspaceRoot);
        if ('error' in r) { return JSON.stringify({ error: r.error }); }
        let except: string | undefined;
        if (input.exceptFilePath) {
            const x = resolveInWorkspace(input.exceptFilePath, deps.workspaceRoot);
            if ('error' in x) { return JSON.stringify({ error: x.error }); }
            except = x.abs;
        }
        chosen = entries.filter((e) => {
            const f = path.resolve(e.filePath);
            return f.startsWith(r.abs + path.sep) && f !== except;
        });
    }
    const closed: Array<{ panelId: string; file: string }> = [];
    const kept: Array<{ panelId: string; file: string; reason: string }> = [];
    for (const e of chosen) {
        const file = relativeFile(path.resolve(e.filePath), deps.workspaceRoot);
        if (e.unsavedEdits === true && input.force !== true) {
            kept.push({ panelId: e.panelId, file, reason: 'unsaved in-place edits' });
        } else {
            closed.push({ panelId: e.panelId, file });
        }
    }
    if (closed.length) { deps.close(closed.map((c) => c.panelId)); }
    return JSON.stringify({ ok: true, closed, kept });
}

export const CLOSE_MD_BROWSER_DESCRIPTION =
    'Close MD Browser panels, by exactly one selector: `panelId`; `filePath` (every panel on that file); or ' +
    '`under` (every panel whose file lies under that folder), optionally with `exceptFilePath` (that file stays ' +
    'open) — "close the old versions, keep the current one". A panel with unsaved in-place edits (an answer ' +
    'or edit-mode text not yet saved) is kept and reported unless `force: true`, so a closing call never ' +
    'discards text the user is typing. Answer: `{ok, closed: [{panelId, file}], kept: [{panelId, file, ' +
    'reason}]}`. Paths workspace-relative or absolute, inside the workspace. Requires approval.';

export const CLOSE_MD_BROWSER_TOOL: SharedToolDefinition<CloseMdBrowserInput> = {
    name: 'tomAi_closeMdBrowser',
    displayName: 'Close MD Browser',
    description: CLOSE_MD_BROWSER_DESCRIPTION,
    tags: ['editor', 'navigation', 'md-browser', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            panelId: { type: 'string', description: 'A panel id from tomAi_listMdBrowserPanels.' },
            filePath: { type: 'string', description: 'Close every panel on this file.' },
            under: { type: 'string', description: 'Close every panel whose file lies under this folder.' },
            exceptFilePath: { type: 'string', description: 'With `under`: this file stays open.' },
            force: { type: 'boolean', description: 'Also close panels with unsaved in-place edits. Default false.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MD_BROWSER_TOOLS: SharedToolDefinition<any>[] = [
    LIST_MD_BROWSER_PANELS_TOOL,
    OPEN_IN_MD_BROWSER_TOOL,
    CLOSE_MD_BROWSER_TOOL,
];
