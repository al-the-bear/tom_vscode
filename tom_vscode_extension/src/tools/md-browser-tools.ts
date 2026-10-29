/**
 * MD Browser tools — `tomAi_listMdBrowserPanels`, and the MD Browser half of
 * `tomAi_getOpenEditors` (`markMdBrowserTabs`).
 *
 * An MD Browser tab is a webview, so VS Code's tab API says nothing about the
 * file it shows. The panels register themselves in the window's registry
 * (utils/mdBrowserRegistry.ts); these read it. vscode-free: the registry and
 * the workspace root are passed in.
 */

import { SharedToolDefinition } from './shared-tool-registry';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MD_BROWSER_TOOLS: SharedToolDefinition<any>[] = [LIST_MD_BROWSER_PANELS_TOOL];
