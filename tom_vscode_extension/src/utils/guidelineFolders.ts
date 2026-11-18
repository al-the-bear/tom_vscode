/**
 * The guidelines in levels, under both folder names (workspace layout
 * convention § 5, BP-3; DP-part-root-tom-6).
 *
 * - **Levels:** the root's guidelines, then the workspace folder's
 *   (`getLayout().guidelineDirs`). A file of the same relative path in the
 *   workspace folder wins; listings show each file once, with its level.
 *   Root == workspace folder: one level, the root.
 * - **Both names:** at every level, and for project guidelines,
 *   `_agent_guidelines` and `_copilot_guidelines` are both read, the new name
 *   first: a file in both folders of one level is taken from
 *   `_agent_guidelines`.
 * - **The indexes:** each level has its own, `index_root.md` at the root and
 *   `index_workspace.md` in the workspace folder, else the level's `index.md`.
 *
 * Pure (`fs` only), so every rule is tested on temporary folders
 * (`__tests__/guidelineFolders.test.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';

/** The guidelines folder's name. */
export const GUIDELINE_FOLDER = '_agent_guidelines';
/** The older name, still read. */
// legacy name, removed by 06a_wslayout-8 (if it goes: both names may stay readable)
export const LEGACY_GUIDELINE_FOLDER = '_copilot_guidelines';
/** Both names, in the order they are read. */
export const GUIDELINE_FOLDER_NAMES: readonly string[] = [GUIDELINE_FOLDER, LEGACY_GUIDELINE_FOLDER];

/** A glob matching every guideline Markdown file under either name. */
export const GUIDELINES_GLOB = `{${GUIDELINE_FOLDER},${LEGACY_GUIDELINE_FOLDER}}/**/*.md`;

export type GuidelineLevelName = 'root' | 'workspace';

/** One level: its name and the guideline folders it has (new name first), existing only. */
export interface GuidelineLevel {
    level: GuidelineLevelName;
    dirs: string[];
}

/** The index file each level names. */
export const LEVEL_INDEX_FILE: Readonly<Record<GuidelineLevelName, string>> = {
    root: 'index_root.md',
    workspace: 'index_workspace.md',
};

function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function realOrSelf(p: string): string {
    try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * The guideline folders of one level, existing ones only, new name first.
 * `configured` is the level's folder as the layout names it; when its name is
 * one of the two guideline names, the other name beside it is read too.
 */
export function guidelineDirsAt(configured: string): string[] {
    const base = path.basename(configured);
    if (!GUIDELINE_FOLDER_NAMES.includes(base)) {
        return isDir(configured) ? [configured] : [];
    }
    const parent = path.dirname(configured);
    return GUIDELINE_FOLDER_NAMES.map((n) => path.join(parent, n)).filter(isDir);
}

/**
 * The levels from the layout's guideline folders (root first, as
 * `TomLayout.guidelineDirs`). A level without any guideline folder is left
 * out; a level that is the same folders as an earlier one too.
 */
export function guidelineLevels(configuredDirs: readonly string[]): GuidelineLevel[] {
    const out: GuidelineLevel[] = [];
    const seen = new Set<string>();
    configuredDirs.forEach((configured, i) => {
        const level: GuidelineLevelName = i === 0 ? 'root' : 'workspace';
        const dirs = guidelineDirsAt(configured).filter((d) => {
            const key = realOrSelf(d);
            if (seen.has(key)) { return false; }
            seen.add(key);
            return true;
        });
        if (dirs.length > 0) { out.push({ level, dirs }); }
    });
    return out;
}

/** A project's guideline folders (both names, new first), existing only. Not layered. */
export function projectGuidelineDirs(projectAbs: string): string[] {
    return GUIDELINE_FOLDER_NAMES.map((n) => path.join(projectAbs, n)).filter(isDir);
}

/** A guideline file as listed: its path relative to its folder, where it is, its size. */
export interface GuidelineFile {
    /** Relative to its guidelines folder, with `/`. */
    path: string;
    level: GuidelineLevelName | 'project';
    /** The guidelines folder it was found in. */
    dir: string;
    abs: string;
    size: number;
}

function walk(dir: string, base: string, out: Array<{ rel: string; abs: string; size: number }>): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.')) { continue; }
        const abs = path.join(dir, e.name);
        let directory = e.isDirectory();
        if (e.isSymbolicLink()) { directory = isDir(abs); }
        if (directory) {
            walk(abs, base, out);
        } else if (e.name.endsWith('.md')) {
            try {
                out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs, size: fs.statSync(abs).size });
            } catch { /* gone meanwhile */ }
        }
    }
}

/**
 * Every guideline file of the folders, each relative path once. Folders are
 * given lowest priority first; a later folder's file of the same path wins.
 * `sub` limits the walk to a subfolder (relative, `/`).
 */
function collect(folders: Array<{ dir: string; level: GuidelineFile['level'] }>, sub?: string): GuidelineFile[] {
    const byPath = new Map<string, GuidelineFile>();
    for (const f of folders) {
        const start = sub ? path.join(f.dir, sub) : f.dir;
        if (!isDir(start)) { continue; }
        const found: Array<{ rel: string; abs: string; size: number }> = [];
        walk(start, f.dir, found);
        for (const x of found) { byPath.set(x.rel, { path: x.rel, level: f.level, dir: f.dir, abs: x.abs, size: x.size }); }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The folders in priority order, lowest first: root before workspace, legacy name before the new one. */
function foldersLowestFirst(levels: readonly GuidelineLevel[]): Array<{ dir: string; level: GuidelineLevelName }> {
    return levels.flatMap((l) => [...l.dirs].reverse().map((dir) => ({ dir, level: l.level })));
}

/** Every guideline file of the levels, each path once (the workspace's, the new name's winning). */
export function listLevelFiles(levels: readonly GuidelineLevel[], sub?: string): GuidelineFile[] {
    return collect(foldersLowestFirst(levels), sub);
}

/** Every file of a project's guideline folders, each path once (the new name's winning). */
export function listProjectFiles(projectDirs: readonly string[], sub?: string): GuidelineFile[] {
    return collect([...projectDirs].reverse().map((dir) => ({ dir, level: 'project' as const })), sub);
}

/** The subfolders of the folders (names, sorted, once each). */
export function subfoldersOf(dirs: readonly string[]): string[] {
    const names = new Set<string>();
    for (const d of dirs) {
        try {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                if (!e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(d, e.name))))) { names.add(e.name); }
            }
        } catch { /* none */ }
    }
    return [...names].sort();
}

/** How a requested guideline was found. */
export interface ResolvedGuideline {
    file: GuidelineFile;
    /** Found by its file name in another place, not at the requested path. */
    byName: boolean;
}

/**
 * Find a guideline: the exact relative path (`.md` added when missing) in the
 * highest-priority folder that has it, else a file of the same name anywhere
 * (`byName`), again by priority.
 */
export function resolveInFiles(files: readonly GuidelineFile[], relPath: string): ResolvedGuideline | undefined {
    if (!relPath) { return undefined; }
    const target = (relPath.endsWith('.md') ? relPath : `${relPath}.md`).replace(/\\/g, '/');
    const exact = files.find((f) => f.path === target);
    if (exact) { return { file: exact, byName: false }; }
    const name = path.posix.basename(target);
    const byName = files.filter((f) => path.posix.basename(f.path) === name);
    if (byName.length === 0) { return undefined; }
    // The workspace's before the root's, then the shortest path.
    const rank = (f: GuidelineFile) => (f.level === 'workspace' ? 0 : 1);
    byName.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return { file: byName[0], byName: true };
}

/** A level's index file: `index_root.md` / `index_workspace.md`, else its `index.md`. */
export function levelIndexFile(level: GuidelineLevel): string | undefined {
    for (const name of [LEVEL_INDEX_FILE[level.level], 'index.md']) {
        for (const d of level.dirs) {
            const p = path.join(d, name);
            try { if (fs.statSync(p).isFile()) { return p; } } catch { /* next */ }
        }
    }
    return undefined;
}

/** The indexes of the levels, root first, read. */
export function levelIndexes(levels: readonly GuidelineLevel[]): Array<{ level: GuidelineLevelName; file: string; content: string }> {
    const out: Array<{ level: GuidelineLevelName; file: string; content: string }> = [];
    for (const l of levels) {
        const file = levelIndexFile(l);
        if (!file) { continue; }
        try { out.push({ level: l.level, file, content: fs.readFileSync(file, 'utf8') }); } catch { /* unreadable */ }
    }
    return out;
}

/** Where a path segment names a guideline folder (either name): the last such segment. */
export function lastGuidelineSegment(normalised: string): { before: string; after: string } | undefined {
    let best: { before: string; after: string; at: number } | undefined;
    for (const name of GUIDELINE_FOLDER_NAMES) {
        if (normalised.startsWith(`${name}/`) && !best) {
            best = { before: '', after: normalised.slice(name.length + 1), at: 0 };
        }
        const marker = `/${name}/`;
        const i = normalised.lastIndexOf(marker);
        if (i >= 0 && (!best || i + 1 > best.at)) {
            best = { before: normalised.slice(0, i), after: normalised.slice(i + marker.length), at: i + 1 };
        }
    }
    return best ? { before: best.before, after: best.after } : undefined;
}

/**
 * The Guidelines section's groups for the guideline levels: the top level's
 * first folder is `global` ("Workspace"), then the other folders as `level:<level>:<i>`, the root
 * labelled "Root"; a level with both folder names names each.
 */
export function guidelineLevelGroups(levels: readonly GuidelineLevel[]): { id: string; label: string }[] {
    const out: { id: string; label: string }[] = [];
    const top = levels[levels.length - 1];
    const ordered = top ? [top, ...levels.filter((l) => l !== top)] : [];
    for (const l of ordered) {
        const base = l.level === 'root' && levels.length > 1 ? 'Root' : 'Workspace';
        l.dirs.forEach((d, i) => {
            const id = l === top && i === 0 ? 'global' : `level:${l.level}:${i}`;
            const label = l.dirs.length > 1 ? `${base} (${path.basename(d)})` : base;
            out.push({ id, label });
        });
    }
    return out;
}
