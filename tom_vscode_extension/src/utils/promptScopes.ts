/**
 * The project and scanned `prompt/` folders offered by the chat panel's
 * reusable prompts and the Reusable Prompt Editor.
 *
 * Both walk the workspace, so both run asynchronously (the extension host
 * keeps serving other panels between directories) and share one walk per
 * TTL: the chat panel asks while a window opens, and the editor resolves a
 * scope id on every load, save and delete.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isIgnoredWorkspaceFolder } from './workspaceFolders';
import { listedProjects } from '../services/workspaceProjects';
import { TtlPromiseCache } from './ttlPromiseCache';

export interface PromptScopeItem {
    /** `encodeURIComponent` of the project folder (project) or the prompt folder (scan). */
    id: string;
    label: string;
    /** The folder holding the `.prompt.md` files. */
    dir: string;
}

/** How deep the `prompt/` folder walks go below the workspace root. */
const PROMPT_WALK_MAX_DEPTH = 6;

/** How long a finished walk is reused. */
export const PROMPT_SCOPE_TTL_MS = 60_000;

const promptDirCache = new TtlPromiseCache<string[]>(PROMPT_SCOPE_TTL_MS);

/** Shorten a path from its start to at most `maxLength` characters, cut at a separator. */
export function truncatePathFromStart(fullPath: string, maxLength = 60): string {
    if (fullPath.length <= maxLength) {
        return fullPath;
    }
    const tail = fullPath.slice(fullPath.length - maxLength);
    const sepIndex = tail.indexOf(path.sep);
    if (sepIndex > -1 && sepIndex < tail.length - 1) {
        return `...${tail.slice(sepIndex)}`;
    }
    return `...${tail}`;
}

/**
 * Walk the directories under `root` (depth 0) down to `maxDepth`, skipping
 * the folders no project walk enters. `visit` sees each readable directory's
 * entries and returns the child directories to descend into.
 */
async function walkDirectories(
    root: string,
    maxDepth: number,
    visit: (dir: string, entries: fs.Dirent[]) => string[],
): Promise<void> {
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const child of visit(dir, entries)) {
            await walk(child, depth + 1);
        }
    };
    await walk(root, 0);
}

function childDirectories(entries: fs.Dirent[]): fs.Dirent[] {
    return entries.filter((entry) => entry.isDirectory() && !isIgnoredWorkspaceFolder(entry.name));
}

/** Every `prompt/` folder under `wsRoot` (not descending into one), sorted. */
async function collectPromptDirs(wsRoot: string): Promise<string[]> {
    const found = new Set<string>();
    const result: string[] = [];
    await walkDirectories(wsRoot, PROMPT_WALK_MAX_DEPTH, (dir, entries) => {
        const descend: string[] = [];
        for (const entry of childDirectories(entries)) {
            const childDir = path.join(dir, entry.name);
            if (entry.name !== 'prompt') {
                descend.push(childDir);
                continue;
            }
            const key = path.resolve(childDir);
            if (!found.has(key)) {
                found.add(key);
                result.push(childDir);
            }
        }
        return descend;
    });
    return result.sort();
}

/** The scanned scopes: every `prompt/` folder of the workspace. */
export async function scanPromptScopes(wsRoot: string, fresh = false): Promise<PromptScopeItem[]> {
    const dirs = await promptDirCache.get(wsRoot, () => collectPromptDirs(wsRoot), fresh);
    return dirs.map((promptDir) => ({
        id: encodeURIComponent(promptDir),
        label: truncatePathFromStart(path.relative(wsRoot, promptDir)),
        dir: promptDir,
    }));
}

/** The listed projects of a workspace (services/workspaceProjects.ts); a seam for tests. */
export type ProjectLister = (wsRoot: string, fresh: boolean) => Promise<Array<{ name: string; absolutePath: string }>>;

const defaultProjectLister: ProjectLister = (wsRoot, fresh) => listedProjects(wsRoot, { fresh });

/**
 * The project scopes: each listed project's `prompt/` folder (buildkit's
 * listing, the extension's one project discovery). Without listed projects,
 * every folder holding a `prompt/` folder outside `_ai`.
 */
export async function projectPromptScopes(wsRoot: string, fresh = false, lister: ProjectLister = defaultProjectLister): Promise<PromptScopeItem[]> {
    const projects = await lister(wsRoot, fresh);
    if (projects.length > 0) {
        return projects
            .map((project) => ({
                id: encodeURIComponent(project.absolutePath),
                label: project.name,
                dir: path.join(project.absolutePath, 'prompt'),
            }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    const seen = new Set<string>();
    const fallback: PromptScopeItem[] = [];
    await walkDirectories(wsRoot, PROMPT_WALK_MAX_DEPTH, (dir, entries) => {
        if (entries.some((entry) => entry.isDirectory() && entry.name === 'prompt')) {
            const relative = path.relative(wsRoot, dir) || '.';
            const key = path.resolve(dir);
            if (
                relative !== '.' &&
                !relative.startsWith('_ai') &&
                !relative.includes(`${path.sep}_ai${path.sep}`) &&
                !relative.includes(`${path.sep}prompt${path.sep}`) &&
                !seen.has(key)
            ) {
                seen.add(key);
                fallback.push({
                    id: encodeURIComponent(dir),
                    label: truncatePathFromStart(relative),
                    dir: path.join(dir, 'prompt'),
                });
            }
        }
        return childDirectories(entries).map((entry) => path.join(dir, entry.name));
    });
    return fallback.sort((a, b) => a.label.localeCompare(b.label));
}

/** Forget the cached walks (tests). */
export function clearPromptScopeCache(): void {
    promptDirCache.clear();
}
