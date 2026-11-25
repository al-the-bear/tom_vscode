/**
 * Workspace layout — where the root, the workspace folder, `_ai`, the
 * configuration layers and the guidelines of this window are.
 *
 * The rules are the workspace layout convention (the guideline
 * `workspace_layout.md`, §§ 2–5):
 *
 * - **Workspace folder:** the window's first folder (the `.code-workspace`
 *   file's first folder; a folder window: that folder). Further folders are
 *   only extra VS Code root folders; the active editor changes nothing.
 * - **Root:** the nearest folder at or above the workspace folder whose
 *   `.tom/tom_root.yaml` exists. None: the workspace folder is its own root
 *   (`standalone`). `tomAi.layout.root` replaces the walk up.
 * - **Default places:** `defaults:` (`ai`, `guidelines`, `config`) of
 *   `<workspace>/.tom/tom_workspace.yaml`, else of `<root>/.tom/tom_root.yaml`,
 *   else `_ai`, `_agent_guidelines`, `.tom`; a missing key takes the default.
 * - **`_ai`:** `<workspaceFolder>/<ai>` when it exists, else `<root>/<ai>`; the
 *   path keeps the form it was opened by (no realpath). Neither exists (or a
 *   broken symlink): `aiMissing`, nothing is created.
 * - **Layers:** `.tom` and the guidelines at the root, then the workspace
 *   folder, deduplicated.
 *
 * `computeLayout()` is pure (its file system and platform are injected), so
 * every rule is tested without VS Code; `getLayout()` computes it once per
 * window from VS Code and recomputes on a folder, setting or marker change
 * (`onDidChangeLayout`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// ============================================================================
// Types
// ============================================================================

/** The default folder names of a level (`defaults:` of the marker files). */
export interface LayoutDefaults {
    ai: string;
    guidelines: string;
    config: string;
}

/** Built-in default places (convention § 5). */
export const BUILTIN_LAYOUT_DEFAULTS: Readonly<LayoutDefaults> = Object.freeze({
    ai: '_ai',
    guidelines: '_agent_guidelines',
    config: '.tom',
});

export const ROOT_MARKER = path.join('.tom', 'tom_root.yaml');
export const WORKSPACE_MARKER = path.join('.tom', 'tom_workspace.yaml');

/** Why `_ai` could not be found. */
export type AiMissingReason = 'missing' | 'brokenLink';

/** The overrides from the window's settings (`tomAi.layout.*`, `tomAi.aiFolder`). */
export interface LayoutOverrides {
    /** `tomAi.layout.root` — absolute or relative to the workspace folder. */
    root?: string;
    /** `tomAi.layout.aiFolder` — absolute or relative to the workspace folder. */
    aiFolder?: string;
    /** `tomAi.layout.configFolder` — the workspace folder's configuration folder. */
    configFolder?: string;
    /** `tomAi.layout.guidelinesFolder` — the workspace folder's guidelines folder. */
    guidelinesFolder?: string;
    /** `tomAi.aiFolder` (deprecated alias) — a folder name under the workspace folder. */
    legacyAiFolder?: string;
}

/** The file system the resolver reads. */
export interface LayoutFs {
    /** The path exists, following symlinks and junctions. */
    exists(p: string): boolean;
    /** The path itself exists as an entry (a symlink counts, even a broken one). */
    entryExists(p: string): boolean;
    /** The file's text, or undefined when it cannot be read. */
    readText(p: string): string | undefined;
}

export interface LayoutInput {
    /** The window's folders, in order (fs paths). */
    workspaceFolders: readonly string[];
    /** The open `.code-workspace` file, when there is one. */
    workspaceFile?: string;
    overrides?: LayoutOverrides;
    /** Defaults to `process.platform`. */
    platform?: NodeJS.Platform;
    /** Defaults to the real file system. */
    fs?: LayoutFs;
    /** Defaults to `os.homedir()`; used to expand `~` in overrides. */
    homeDir?: string;
}

export interface TomLayout {
    workspaceFile?: string;
    /** The `.code-workspace` file name without its extension, else `default`. */
    questId: string;
    /** The window's first folder. */
    workspaceFolder: string;
    /** The root (the workspace folder itself when standalone). */
    root: string;
    /** No root marker above the workspace folder and no `tomAi.layout.root`. */
    standalone: boolean;
    /** The `_ai` folder (it may not exist: see `aiMissing`). */
    aiRoot: string;
    /** The name or relative path `_ai` was looked up by. */
    aiName: string;
    /** Set when neither candidate of `_ai` exists. */
    aiMissing?: AiMissingReason;
    /** The candidates `_ai` was looked up at, in order. */
    aiCandidates: string[];
    /** `.tom` layers, root first; deduplicated. */
    configLayers: string[];
    /** The configuration layers that exist. */
    existingConfigLayers: string[];
    /** Guidelines folders, root first; deduplicated. */
    guidelineDirs: string[];
    /** The defaults of the root level and of the workspace folder. */
    rootDefaults: LayoutDefaults;
    workspaceDefaults: LayoutDefaults;
    /** The override settings that took effect. */
    overridesApplied: (keyof LayoutOverrides)[];
}

// ============================================================================
// Helpers
// ============================================================================

export const realLayoutFs: LayoutFs = {
    exists(p) {
        try { fs.statSync(p); return true; } catch { return false; }
    },
    entryExists(p) {
        try { fs.lstatSync(p); return true; } catch { return false; }
    },
    readText(p) {
        try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; }
    },
};

function pathApiFor(platform: NodeJS.Platform): path.PlatformPath {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** A key two paths compare equal by: case-insensitive on Windows, no trailing separator. */
export function layoutPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
    const api = pathApiFor(platform);
    let n = api.normalize(p);
    const rootOf = api.parse(n).root;
    while (n.length > rootOf.length && (n.endsWith('/') || n.endsWith('\\'))) {
        n = n.slice(0, -1);
    }
    return platform === 'win32' ? n.toLowerCase() : n;
}

/** Paths in order, the later duplicates (by `layoutPathKey`) left out. */
export function dedupePaths(paths: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
        const key = layoutPathKey(p, platform);
        if (!seen.has(key)) { seen.add(key); out.push(p); }
    }
    return out;
}

function clean(value: string | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
}

/** An override path: `~` and `${workspaceFolder}` expanded; relative to `base`. */
export function resolveLayoutPath(value: string, base: string, platform: NodeJS.Platform, homeDir: string): string {
    const api = pathApiFor(platform);
    let v = value.replace(/\$\{workspaceFolder\}/g, base);
    if (v === '~') { v = homeDir; }
    else if (v.startsWith('~/') || v.startsWith('~\\')) { v = api.join(homeDir, v.slice(2)); }
    return api.isAbsolute(v) ? api.normalize(v) : api.join(base, v);
}

/** The `defaults:` of a marker file over `base`; an unreadable file or key keeps `base`. */
export function readLayoutDefaults(file: string, base: LayoutDefaults, lfs: LayoutFs): LayoutDefaults {
    const text = lfs.readText(file);
    if (text === undefined) { return { ...base }; }
    let doc: unknown;
    try { doc = parseYaml(text); } catch { return { ...base }; }
    const d = (doc && typeof doc === 'object') ? (doc as Record<string, unknown>).defaults : undefined;
    if (!d || typeof d !== 'object') { return { ...base }; }
    const rec = d as Record<string, unknown>;
    const pick = (k: keyof LayoutDefaults) => (typeof rec[k] === 'string' && (rec[k] as string).trim()) ? (rec[k] as string).trim() : base[k];
    return { ai: pick('ai'), guidelines: pick('guidelines'), config: pick('config') };
}

/** The quest id of a `.code-workspace` file (its name), else `default`. */
export function questIdOf(workspaceFile: string | undefined, platform: NodeJS.Platform = process.platform): string {
    if (!workspaceFile) { return 'default'; }
    const base = pathApiFor(platform).basename(workspaceFile).replace(/\.code-workspace$/, '').trim();
    return base || 'default';
}

/** The nearest folder at or above `start` holding `.tom/tom_root.yaml`. */
export function findRoot(start: string, lfs: LayoutFs, platform: NodeJS.Platform): string | undefined {
    const api = pathApiFor(platform);
    let dir = api.normalize(start);
    for (;;) {
        if (lfs.exists(api.join(dir, ROOT_MARKER))) { return dir; }
        const parent = api.dirname(dir);
        if (layoutPathKey(parent, platform) === layoutPathKey(dir, platform)) { return undefined; }
        dir = parent;
    }
}

// ============================================================================
// The resolver
// ============================================================================

/** The layout of a window; undefined without a folder. */
export function computeLayout(input: LayoutInput): TomLayout | undefined {
    const platform = input.platform ?? process.platform;
    const lfs = input.fs ?? realLayoutFs;
    const homeDir = input.homeDir ?? os.homedir();
    const api = pathApiFor(platform);
    const first = input.workspaceFolders[0];
    if (!first) { return undefined; }
    const workspaceFolder = api.normalize(first);
    const ov = input.overrides ?? {};
    const applied: (keyof LayoutOverrides)[] = [];

    // Root.
    let root: string;
    let standalone: boolean;
    const rootOverride = clean(ov.root);
    if (rootOverride) {
        root = resolveLayoutPath(rootOverride, workspaceFolder, platform, homeDir);
        standalone = false;
        applied.push('root');
    } else {
        const found = findRoot(workspaceFolder, lfs, platform);
        root = found ?? workspaceFolder;
        standalone = found === undefined;
    }

    // Defaults: the root's marker, then the workspace folder's over it.
    const rootDefaults = readLayoutDefaults(api.join(root, ROOT_MARKER), BUILTIN_LAYOUT_DEFAULTS, lfs);
    const workspaceDefaults = readLayoutDefaults(api.join(workspaceFolder, WORKSPACE_MARKER), rootDefaults, lfs);

    // _ai.
    let aiName = workspaceDefaults.ai;
    let aiCandidates: string[];
    const aiOverride = clean(ov.aiFolder);
    const legacyAi = clean(ov.legacyAiFolder);
    if (aiOverride) {
        aiName = aiOverride;
        aiCandidates = [resolveLayoutPath(aiOverride, workspaceFolder, platform, homeDir)];
        applied.push('aiFolder');
    } else if (legacyAi) {
        aiName = legacyAi;
        aiCandidates = [resolveLayoutPath(legacyAi, workspaceFolder, platform, homeDir)];
        applied.push('legacyAiFolder');
    } else {
        aiCandidates = dedupePaths([
            resolveLayoutPath(workspaceDefaults.ai, workspaceFolder, platform, homeDir),
            resolveLayoutPath(rootDefaults.ai, root, platform, homeDir),
        ], platform);
    }
    let aiRoot = aiCandidates.find((c) => lfs.exists(c));
    let aiMissing: AiMissingReason | undefined;
    if (!aiRoot) {
        const broken = aiCandidates.find((c) => lfs.entryExists(c));
        aiMissing = broken ? 'brokenLink' : 'missing';
        aiRoot = broken ?? aiCandidates[0];
    }

    // Layers.
    const configOverride = clean(ov.configFolder);
    if (configOverride) { applied.push('configFolder'); }
    const guidelinesOverride = clean(ov.guidelinesFolder);
    if (guidelinesOverride) { applied.push('guidelinesFolder'); }
    const configLayers = dedupePaths([
        resolveLayoutPath(rootDefaults.config, root, platform, homeDir),
        resolveLayoutPath(configOverride ?? workspaceDefaults.config, workspaceFolder, platform, homeDir),
    ], platform);
    const guidelineDirs = dedupePaths([
        resolveLayoutPath(rootDefaults.guidelines, root, platform, homeDir),
        resolveLayoutPath(guidelinesOverride ?? workspaceDefaults.guidelines, workspaceFolder, platform, homeDir),
    ], platform);

    return {
        workspaceFile: input.workspaceFile,
        questId: questIdOf(input.workspaceFile, platform),
        workspaceFolder,
        root,
        standalone,
        aiRoot,
        aiName,
        aiMissing,
        aiCandidates,
        configLayers,
        existingConfigLayers: configLayers.filter((l) => lfs.exists(l)),
        guidelineDirs,
        rootDefaults,
        workspaceDefaults,
        overridesApplied: applied,
    };
}

/** One sentence for the status page's Configuration Errors, or undefined. */
export function describeAiMissing(layout: TomLayout): string | undefined {
    if (!layout.aiMissing) { return undefined; }
    const where = layout.aiCandidates.join(', ');
    return layout.aiMissing === 'brokenLink'
        ? `The _ai folder is a broken link (${where}): its target does not exist. Repair the link or set tomAi.layout.aiFolder.`
        : `No _ai folder found (looked at ${where}). Create or link it, or set tomAi.layout.aiFolder.`;
}

/** The hint the fallback screen shows (DP-part-extension-1). */
export const FIRST_FOLDER_HINT =
    'The extension works in the first folder of the .code-workspace file; other folders are only extra root folders.';

// ============================================================================
// The window's layout (VS Code)
// ============================================================================

// Loaded on first use, so the pure resolver above runs without VS Code — and loaded once: VS Code's `require('vscode')`
// checks that the calling module's file exists on every call, and reinstalling the extension replaces its folder
// (same version, same path) under a running window, so a repeated require from the heartbeat failed with ENOENT on
// `out/utils/workspaceLayout.js` for as long as the install took.
let vscodeModule: typeof import('vscode') | undefined;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscodeApi = (): typeof import('vscode') => (vscodeModule ??= require('vscode') as typeof import('vscode'));

/** The settings that change the layout. */
export const LAYOUT_SETTINGS = [
    'tomAi.layout.root',
    'tomAi.layout.aiFolder',
    'tomAi.layout.configFolder',
    'tomAi.layout.guidelinesFolder',
    'tomAi.aiFolder',
    'tomAi.configPath',
] as const;

let cached: TomLayout | undefined;
let cachedValid = false;
let emitter: import('vscode').EventEmitter<TomLayout | undefined> | undefined;
let markerWatchers: import('vscode').Disposable[] = [];

/** An explicitly set value of a setting (a default from package.json does not count). */
function explicitSetting(section: import('vscode').WorkspaceConfiguration, key: string): string | undefined {
    const inspected = typeof section.inspect === 'function' ? section.inspect<string>(key) : undefined;
    if (inspected) {
        return clean(inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue);
    }
    return clean(section.get<string>(key));
}

/** The overrides the window's settings hold. */
export function readLayoutOverrides(): LayoutOverrides {
    const vscode = vscodeApi();
    const tomAi = vscode.workspace.getConfiguration('tomAi');
    const legacy = explicitSetting(tomAi, 'aiFolder');
    return {
        root: clean(tomAi.get<string>('layout.root')),
        aiFolder: clean(tomAi.get<string>('layout.aiFolder')),
        configFolder: clean(tomAi.get<string>('layout.configFolder')),
        guidelinesFolder: clean(tomAi.get<string>('layout.guidelinesFolder')),
        // The alias names the default `_ai` only when it means a change.
        legacyAiFolder: legacy && legacy !== BUILTIN_LAYOUT_DEFAULTS.ai ? legacy : undefined,
    };
}

function windowInput(): LayoutInput {
    const vscode = vscodeApi();
    const folders = (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === 'file' || f.uri.scheme === undefined)
        .map((f) => f.uri.fsPath);
    const wsFile = vscode.workspace.workspaceFile;
    const workspaceFile = wsFile && (wsFile.scheme === 'file' || wsFile.scheme === undefined) ? wsFile.fsPath : undefined;
    return { workspaceFolders: folders, workspaceFile, overrides: readLayoutOverrides() };
}

let cachedKey: string | undefined;

/**
 * This window's layout. Computed once and kept while its inputs (the
 * folders, the `.code-workspace` file, the layout settings) stay the same;
 * a marker file change recomputes it (`registerLayoutTracking`).
 */
export function getLayout(): TomLayout | undefined {
    const input = windowInput();
    const key = JSON.stringify(input);
    if (!cachedValid || key !== cachedKey) {
        cached = computeLayout(input);
        cachedKey = key;
        cachedValid = true;
    }
    return cached;
}

/** Fired after the layout was recomputed (with the new layout). */
export function onDidChangeLayout(listener: (layout: TomLayout | undefined) => void): import('vscode').Disposable {
    const vscode = vscodeApi();
    emitter ??= new vscode.EventEmitter<TomLayout | undefined>();
    return emitter.event(listener);
}

/** Recompute now; fires `onDidChangeLayout` when the layout changed. */
export function recomputeLayout(): TomLayout | undefined {
    const before = cachedValid ? JSON.stringify(cached) : undefined;
    cachedValid = false;
    const after = getLayout();
    if (JSON.stringify(after) !== before) {
        watchMarkers(after);
        emitter?.fire(after);
    }
    return after;
}

function watchMarkers(layout: TomLayout | undefined): void {
    for (const w of markerWatchers) { w.dispose(); }
    markerWatchers = [];
    if (!layout) { return; }
    const vscode = vscodeApi();
    const dirs = dedupePaths([layout.workspaceFolder, layout.root]);
    for (const dir of dirs) {
        const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), '.tom/{tom_root,tom_workspace}.yaml');
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const onChange = () => { recomputeLayout(); };
        watcher.onDidCreate?.(onChange);
        watcher.onDidChange?.(onChange);
        watcher.onDidDelete?.(onChange);
        markerWatchers.push(watcher);
    }
}

/**
 * Keep the layout current: recompute on a folder change, a layout setting
 * and a change of `tom_root.yaml` / `tom_workspace.yaml`.
 */
export function registerLayoutTracking(context: { subscriptions: { dispose(): unknown }[] }): void {
    const vscode = vscodeApi();
    watchMarkers(getLayout());
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { recomputeLayout(); }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (LAYOUT_SETTINGS.some((s) => e.affectsConfiguration(s))) { recomputeLayout(); }
        }),
        { dispose: () => { for (const w of markerWatchers) { w.dispose(); } markerWatchers = []; } },
    );
}

/** Forget the cached layout (tests). */
export function resetLayoutForTests(): void {
    cached = undefined;
    cachedKey = undefined;
    cachedValid = false;
}

/** The window's workspace folder (`getLayout().workspaceFolder`), or undefined without a folder. */
export function layoutWorkspaceFolder(): string | undefined {
    return getLayout()?.workspaceFolder;
}

/** The window's other root folders (every folder after the first): extra VS Code root folders only. */
export function layoutExtraRootFolders(): string[] {
    const vscode = vscodeApi();
    return (vscode.workspace.workspaceFolders ?? [])
        .slice(1)
        .filter((f) => f.uri.scheme === 'file' || f.uri.scheme === undefined)
        .map((f) => f.uri.fsPath);
}
