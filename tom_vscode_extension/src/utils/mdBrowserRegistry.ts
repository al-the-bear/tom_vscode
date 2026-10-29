/**
 * The open MD Browser panels of this window, static and live alike: which file
 * each shows, where it is, and whether it holds unsaved in-place edits.
 *
 * Every panel registers when it is made (opened, or restored after a reload)
 * and unregisters when it is disposed. The handler reports navigation, view
 * state and the webview's open-editor count. Read by `tomAi_listMdBrowserPanels`
 * and by `tomAi_getOpenEditors`, which matches a webview tab to its panel by
 * view column and label — so a panel's title names its file: `MD: <name>`,
 * with the parent folder added while another panel shows a different file of
 * the same name (a step folder's copy of a document, say).
 *
 * vscode-free.
 */

import * as path from 'path';

export interface MdBrowserPanelState {
    filePath: string;
    liveMode: boolean;
    viewColumn?: number;
    active?: boolean;
    visible?: boolean;
    /** The webview has in-place editors open (unsaved text). null: not reported yet. */
    unsavedEdits?: boolean | null;
}

export interface MdBrowserEntry extends Required<Omit<MdBrowserPanelState, 'viewColumn' | 'unsavedEdits'>> {
    panelId: string;
    viewColumn: number | undefined;
    unsavedEdits: boolean | null;
}

/** One panel as the tools answer it. */
export interface MdBrowserPanelInfo {
    panelId: string;
    /** Workspace-relative path, or the absolute one for a file outside the workspace. */
    file: string;
    absolutePath: string;
    liveMode: boolean;
    title: string;
    viewColumn: number | undefined;
    active: boolean;
    visible: boolean;
    /** In-place editors open in the panel (text not yet saved); null when the webview has not reported. */
    unsavedEdits: boolean | null;
}

export class MdBrowserRegistry {
    private readonly entriesById = new Map<string, MdBrowserEntry>();
    private nextId = 1;

    /** Register a new panel; answers its id. */
    register(state: MdBrowserPanelState): string {
        const panelId = `mdb-${this.nextId++}`;
        this.entriesById.set(panelId, {
            panelId,
            filePath: state.filePath,
            liveMode: state.liveMode,
            viewColumn: state.viewColumn,
            active: state.active ?? false,
            visible: state.visible ?? false,
            unsavedEdits: state.unsavedEdits ?? null,
        });
        return panelId;
    }

    update(panelId: string, changes: Partial<MdBrowserPanelState>): void {
        const entry = this.entriesById.get(panelId);
        if (!entry) { return; }
        for (const [key, value] of Object.entries(changes)) {
            if (value !== undefined) { (entry as unknown as Record<string, unknown>)[key] = value; }
        }
    }

    unregister(panelId: string): void {
        this.entriesById.delete(panelId);
    }

    /** The registered panels, in registration order. */
    entries(): MdBrowserEntry[] {
        return [...this.entriesById.values()];
    }

    /**
     * The title a panel shows: `MD: <name>` (`MD (live): ` when live), plus
     * ` (<parent folder>)` while another panel shows a different file of the
     * same name.
     */
    titleOf(panelId: string): string {
        const entry = this.entriesById.get(panelId);
        if (!entry) { return 'MD Browser'; }
        const name = path.basename(entry.filePath);
        const prefix = entry.liveMode ? 'MD (live): ' : 'MD: ';
        const clash = this.entries().some((e) =>
            e.panelId !== panelId && path.basename(e.filePath) === name && path.resolve(e.filePath) !== path.resolve(entry.filePath));
        return clash ? `${prefix}${name} (${path.basename(path.dirname(entry.filePath))})` : `${prefix}${name}`;
    }

    /**
     * The panel each tab shows, by view column and label; undefined for a tab
     * no panel matches. Panels with one label in one column (the same file
     * opened twice) are taken in registration order.
     */
    matchTabs(tabs: ReadonlyArray<{ group: number | undefined; label: string }>): Array<MdBrowserEntry | undefined> {
        const taken = new Set<string>();
        return tabs.map((tab) => {
            const hit = this.entries().find((e) =>
                !taken.has(e.panelId) && e.viewColumn === tab.group && this.titleOf(e.panelId) === tab.label);
            if (hit) { taken.add(hit.panelId); }
            return hit;
        });
    }

    /** The panels as the tools answer them; paths relative to `workspaceRoot` where they lie inside it. */
    list(workspaceRoot: string | undefined): MdBrowserPanelInfo[] {
        return this.entries().map((e) => {
            const rel = workspaceRoot ? path.relative(workspaceRoot, e.filePath) : '';
            const inside = !!workspaceRoot && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
            return {
                panelId: e.panelId,
                file: inside ? rel.split(path.sep).join('/') : e.filePath,
                absolutePath: e.filePath,
                liveMode: e.liveMode,
                title: this.titleOf(e.panelId),
                viewColumn: e.viewColumn,
                active: e.active,
                visible: e.visible,
                unsavedEdits: e.unsavedEdits,
            };
        });
    }
}

/** This window's registry. */
export const mdBrowserRegistry = new MdBrowserRegistry();
