/**
 * The workspace folders of a root and the workspace folder each quest was
 * opened in (02_wslayout-11): both derived, never a hand-kept table.
 *
 * - **A quest's workspace folder** is recorded when a window opens the quest:
 *   `workspaceFolder: <path relative to the root, posix form>` in the quest's
 *   host-independent `config/extension_config.<quest>.yaml` (`.` for a standalone
 *   layout). It is written only when it changed.
 * - **The workspace folders of a root** are found by scanning it for folders
 *   that hold an `_ai` entry and a `.tom` (or a CLAUDE.md), skipping `ztmp`,
 *   `node_modules`, build folders and hidden folders; a workspace folder is not
 *   searched further down.
 *
 * The recorded quests of a workspace folder are one input of the window's
 * workspace quests (utils/aiWorkspace.ts resolveWorkspaceQuests).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

import { sharedExtensionConfigFile } from './questConfigFiles';

/** The section of `config/extension_config.<quest>.yaml` that records the quest's workspace folder. */
export const SECTION_WORKSPACE_FOLDER = 'workspaceFolder';

/** Folders the scan never enters. */
const SKIPPED = new Set(['ztmp', 'node_modules', 'build', 'out', 'dist', 'target', 'coverage', '_ai']);

/** How deep below the root the scan looks for workspace folders. */
export const WORKSPACE_SCAN_DEPTH = 6;

/** The workspace folder relative to the root, posix form; `.` when it is the root (standalone). */
export function relativeWorkspaceFolder(root: string, workspaceFolder: string): string {
    const rel = path.relative(path.resolve(root), path.resolve(workspaceFolder));
    if (!rel) { return '.'; }
    return rel.split(path.sep).join('/');
}

function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function exists(p: string): boolean {
    try { fs.lstatSync(p); return true; } catch { return false; }
}

/** Whether `dir` is a workspace folder: an `_ai` entry (folder or link) and a `.tom` folder or a CLAUDE.md. */
export function isWorkspaceFolderDir(dir: string): boolean {
    return exists(path.join(dir, '_ai')) && (isDir(path.join(dir, '.tom')) || exists(path.join(dir, 'CLAUDE.md')));
}

/**
 * The workspace folders below `root` (relative, posix form, sorted). The root
 * itself is answered (`.`) only when no folder below it is one (a standalone
 * workspace). Symbolic links are not followed.
 */
export function scanWorkspaceFolders(root: string, maxDepth = WORKSPACE_SCAN_DEPTH): string[] {
    const found: string[] = [];
    const visit = (dir: string, depth: number): void => {
        if (depth > maxDepth) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith('.') || SKIPPED.has(e.name)) { continue; }
            const child = path.join(dir, e.name);
            if (isWorkspaceFolderDir(child)) {
                found.push(relativeWorkspaceFolder(root, child));
                continue;
            }
            visit(child, depth + 1);
        }
    };
    visit(path.resolve(root), 1);
    if (found.length === 0 && isWorkspaceFolderDir(root)) { return ['.']; }
    return found.sort();
}

/** The recorded workspace folder of quest `quest` (its host-independent config file); undefined when none. */
export function readRecordedWorkspaceFolder(questsRoot: string, quest: string): string | undefined {
    try {
        const raw = parse(fs.readFileSync(sharedExtensionConfigFile(path.join(questsRoot, quest), quest), 'utf8')) as Record<string, unknown> | null;
        const v = raw && typeof raw === 'object' ? raw[SECTION_WORKSPACE_FOLDER] : undefined;
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** Every quest under `questsRoot` with its recorded workspace folder (or none yet), sorted by id. */
export function questsWithWorkspaceFolders(questsRoot: string): Array<{ quest: string; workspaceFolder?: string }> {
    let names: string[] = [];
    try {
        names = fs.readdirSync(questsRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
            .map((e) => e.name);
    } catch { return []; }
    return names.sort().map((quest) => {
        const workspaceFolder = readRecordedWorkspaceFolder(questsRoot, quest);
        return { quest, ...(workspaceFolder ? { workspaceFolder } : {}) };
    });
}

/** The quests whose recorded workspace folder is `workspaceFolder` (relative, posix form), sorted. */
export function recordedQuestsOf(questsRoot: string, workspaceFolder: string): string[] {
    return questsWithWorkspaceFolders(questsRoot).filter((q) => q.workspaceFolder === workspaceFolder).map((q) => q.quest);
}

/**
 * Record `relFolder` as quest `quest`'s workspace folder through `io` (the
 * quest config store), only when it changed. Answers whether it wrote.
 */
export function recordQuestWorkspaceFolder(
    io: { read(key: string, quest: string): unknown; write(key: string, value: unknown, quest: string): void },
    quest: string,
    relFolder: string,
): boolean {
    if (!quest || quest === 'default') { return false; }
    if (io.read(SECTION_WORKSPACE_FOLDER, quest) === relFolder) { return false; }
    io.write(SECTION_WORKSPACE_FOLDER, relFolder, quest);
    return true;
}
