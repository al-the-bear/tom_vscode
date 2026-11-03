/**
 * The open MD Browser panels of this window, static and live alike: which file
 * each shows, where it is, and whether it holds unsaved in-place edits.
 *
 * Every panel registers when it is made (opened, or revived after a reload)
 * and unregisters when it is disposed. A tab VS Code restored after a reload is
 * revived only when it is shown; until then it is a dormant entry, registered
 * at activation with the file remembered for it (utils/mdBrowserRestore.ts),
 * and dropped when the tab is revived or closed. The handler reports navigation, view
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
    /** A restored tab not revived yet: no webview runs behind it. Its `filePath` is '' when no record named it. */
    dormant: boolean;
    /** A dormant tab's label, as it came back (its title cannot change until it is revived). */
    label?: string;
}

/** A restored tab to register as dormant. */
export interface MdBrowserDormantTab {
    label: string;
    viewColumn: number | undefined;
    /** The file remembered for the tab; omitted when nothing named it. */
    filePath?: string;
    liveMode: boolean;
}

/** One panel as the tools answer it. */
export interface MdBrowserPanelInfo {
    panelId: string;
    /** Workspace-relative path, or the absolute one for a file outside the workspace; null for a dormant tab no record named. */
    file: string | null;
    absolutePath: string | null;
    liveMode: boolean;
    title: string;
    viewColumn: number | undefined;
    active: boolean;
    visible: boolean;
    /** In-place editors open in the panel (text not yet saved); null when the webview has not reported. */
    unsavedEdits: boolean | null;
    /** A tab restored after a reload and not shown since: it is revived when shown. */
    dormant: boolean;
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
            dormant: false,
        });
        return panelId;
    }

    /** Register a restored tab that is not revived yet; answers its id. */
    registerDormant(tab: MdBrowserDormantTab): string {
        const panelId = `mdb-${this.nextId++}`;
        this.entriesById.set(panelId, {
            panelId,
            filePath: tab.filePath ?? '',
            liveMode: tab.liveMode,
            viewColumn: tab.viewColumn,
            active: false,
            visible: false,
            unsavedEdits: false,
            dormant: true,
            label: tab.label,
        });
        return panelId;
    }

    /** Remove the dormant entry of this tab (revived, or closed); answers its id. */
    dropDormant(tab: { viewColumn: number | undefined; label: string }): string | undefined {
        const hit = this.entries().find((e) => e.dormant && e.viewColumn === tab.viewColumn && e.label === tab.label);
        if (hit) { this.entriesById.delete(hit.panelId); }
        return hit?.panelId;
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
        if (entry.dormant && entry.label) { return entry.label; }
        const name = path.basename(entry.filePath);
        const prefix = entry.liveMode ? 'MD (live): ' : 'MD: ';
        const clash = this.entries().some((e) =>
            e.panelId !== panelId && e.filePath !== '' && path.basename(e.filePath) === name && path.resolve(e.filePath) !== path.resolve(entry.filePath));
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
            const known = e.filePath !== '';
            const rel = workspaceRoot && known ? path.relative(workspaceRoot, e.filePath) : '';
            const inside = !!workspaceRoot && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
            return {
                panelId: e.panelId,
                file: !known ? null : inside ? rel.split(path.sep).join('/') : e.filePath,
                absolutePath: known ? e.filePath : null,
                liveMode: e.liveMode,
                title: this.titleOf(e.panelId),
                viewColumn: e.viewColumn,
                active: e.active,
                visible: e.visible,
                unsavedEdits: e.unsavedEdits,
                dormant: e.dormant,
            };
        });
    }
}

/** This window's registry. */
export const mdBrowserRegistry = new MdBrowserRegistry();
