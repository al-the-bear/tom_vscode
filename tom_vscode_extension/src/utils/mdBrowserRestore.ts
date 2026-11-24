/**
 * MD Browser tabs across a window reload.
 *
 * VS Code brings every webview tab back after a reload, but revives it — calls
 * the MD Browser's panel serializer — only when the tab is shown. Until then
 * the tab exists, labelled as before, and nothing in the extension knows which
 * file it shows. So the extension remembers, per open tab, its label, column,
 * file and live mode (in the workspace state), and at activation registers each
 * tab that came back as a dormant panel with its file (mdBrowserRegistry). When
 * the tab is shown, the serializer revives it and the real panel replaces the
 * dormant entry.
 *
 * A tab is identified by its label and editor column: that is all VS Code's tab
 * API says about a webview tab, and the MD Browser's titles name their file.
 *
 * Each record also keeps the panel's **settings** (reading_view part *The MD
 * Browser*, DP-part-md-browser-1): its reading modes, indent on/off and size,
 * and the search selection (the search category). A restored panel takes them
 * back; a new panel opens with the reader's defaults (*Save as default*, kept
 * in the extension's global state under {@link MD_BROWSER_DEFAULTS_KEY}).
 *
 * vscode-free.
 */

/** An open MD Browser tab, as the tab API shows it. */
export interface MdTabRef {
    label: string;
    viewColumn: number | undefined;
}

/** How a panel shows its documents: what a reader sets and keeps. */
export interface MdPanelSettings {
    /** Headings and their sections indented by heading level. */
    indentOn: boolean;
    /** Spaces of indentation per level. */
    indentSize: number;
    /** The search category: the whole document, or only the errors (rejected blocks). */
    searchScope: 'all' | 'errors';
    /** The reader's mode per reading-notation kind (`{block, span}`); a kind left out has the notation's default. */
    readingModes: Record<string, { block?: string; span?: string }>;
}

/** What is remembered about one open tab. */
export interface MdPanelRecord extends MdTabRef {
    filePath: string;
    liveMode: boolean;
    /** The panel's settings, when it reported any. */
    settings?: MdPanelSettings;
}

/** The global-state key of the reader's defaults (*Save as default*), the same in every workspace. */
export const MD_BROWSER_DEFAULTS_KEY = 'tomAi.mdBrowser.defaultSettings';

/** The indent sizes the toolbar offers. */
export const MD_INDENT_SIZES: readonly number[] = [1, 2, 3, 4, 6, 8];

/** A kind name or mode name as the notation writes them. */
const NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * `value` as panel settings, every field checked: a wrong or missing field
 * takes the notation's default (indent off, 2 spaces, all, no modes chosen).
 * null when `value` is no object at all.
 */
export function normalizePanelSettings(value: unknown): MdPanelSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
    const v = value as Record<string, unknown>;
    const size = Number(v.indentSize);
    const modes: MdPanelSettings['readingModes'] = {};
    const raw = v.readingModes && typeof v.readingModes === 'object' && !Array.isArray(v.readingModes) ? v.readingModes as Record<string, unknown> : {};
    for (const [kind, m] of Object.entries(raw)) {
        if (!NAME.test(kind) || !m || typeof m !== 'object') { continue; }
        const mm = m as Record<string, unknown>;
        const entry: { block?: string; span?: string } = {};
        if (typeof mm.block === 'string' && NAME.test(mm.block)) { entry.block = mm.block; }
        if (typeof mm.span === 'string' && NAME.test(mm.span)) { entry.span = mm.span; }
        if (entry.block || entry.span) { modes[kind] = entry; }
    }
    return {
        indentOn: v.indentOn === true,
        indentSize: MD_INDENT_SIZES.includes(size) ? size : 2,
        searchScope: v.searchScope === 'errors' ? 'errors' : 'all',
        readingModes: modes,
    };
}

/**
 * The record a restored tab belongs to: the one with its label and column,
 * else the only one with its label (a moved tab); undefined when none, or when
 * two records carry the label and the column tells them apart from neither.
 */
export function recordForTab(records: readonly MdPanelRecord[], tab: MdTabRef): MdPanelRecord | undefined {
    const exact = records.find((r) => sameTab(r, tab));
    if (exact) { return exact; }
    const byLabel = records.filter((r) => r.label === tab.label);
    return byLabel.length === 1 ? byLabel[0] : undefined;
}

/** The workspace-state key the records are kept under. */
export const MD_BROWSER_RECORDS_KEY = 'tomAi.mdBrowser.openPanels';

/** At most this many records are kept. */
export const MAX_REMEMBERED_MD_PANELS = 100;

const sameTab = (a: MdTabRef, b: MdTabRef): boolean => a.label === b.label && a.viewColumn === b.viewColumn;

/** `tabs` without one tab per entry of `taken` (a multiset difference). */
function withoutTaken<T extends MdTabRef>(tabs: readonly T[], taken: readonly MdTabRef[]): T[] {
    const rest = [...tabs];
    for (const t of taken) {
        const i = rest.findIndex((r) => sameTab(r, t));
        if (i >= 0) { rest.splice(i, 1); }
    }
    return rest;
}

/**
 * The records to keep: every live panel, plus the earlier records whose tab is
 * still open and held by no live panel — a dormant tab, or a panel a shutdown
 * disposed while its tab stays to be restored. A record whose tab was closed is
 * dropped.
 */
export function rememberedRecords(
    live: readonly MdPanelRecord[],
    previous: readonly MdPanelRecord[],
    openTabs: readonly MdTabRef[],
): MdPanelRecord[] {
    let unheld = withoutTaken(openTabs, live);
    const kept: MdPanelRecord[] = [];
    for (const record of previous) {
        const i = unheld.findIndex((t) => sameTab(t, record));
        if (i < 0) { continue; }
        unheld = [...unheld.slice(0, i), ...unheld.slice(i + 1)];
        kept.push(record);
    }
    return [...live, ...kept].slice(0, MAX_REMEMBERED_MD_PANELS);
}

export interface DormantTabPlan {
    /** Tabs whose file is known and exists: registered as dormant panels. */
    dormant: Array<{ tab: MdTabRef; record: MdPanelRecord }>;
    /** Tabs whose file no longer exists: closed. */
    gone: Array<{ tab: MdTabRef; record: MdPanelRecord }>;
    /** Tabs no record names: registered without a file. */
    unknown: MdTabRef[];
}

/**
 * What to do with each open MD Browser tab that no live panel holds. A tab is
 * matched to a record by label and column; when its column changed, by label
 * alone if exactly one unused record carries it — two candidates are not
 * guessed between.
 */
export function planDormantTabs(
    openTabs: readonly MdTabRef[],
    heldByLive: readonly MdTabRef[],
    records: readonly MdPanelRecord[],
    exists: (filePath: string) => boolean,
): DormantTabPlan {
    const plan: DormantTabPlan = { dormant: [], gone: [], unknown: [] };
    const unused = [...records];
    const take = (i: number): MdPanelRecord => unused.splice(i, 1)[0];
    const tabs = withoutTaken(openTabs, heldByLive);
    // Exact matches first, so a moved tab cannot take the record of one that stayed.
    const matched = new Map<number, MdPanelRecord>();
    tabs.forEach((tab, t) => {
        const i = unused.findIndex((r) => sameTab(r, tab));
        if (i >= 0) { matched.set(t, take(i)); }
    });
    tabs.forEach((tab, t) => {
        if (matched.has(t)) { return; }
        const byLabel = unused.map((r, i) => ({ r, i })).filter((x) => x.r.label === tab.label);
        if (byLabel.length === 1) { matched.set(t, take(byLabel[0].i)); }
    });
    tabs.forEach((tab, t) => {
        const record = matched.get(t);
        if (!record) { plan.unknown.push(tab); return; }
        (exists(record.filePath) ? plan.dormant : plan.gone).push({ tab, record });
    });
    return plan;
}
