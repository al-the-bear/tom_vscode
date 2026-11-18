/**
 * The instruction files the extension reads (workspace layout DP-part-claude-4 (b)):
 * a workspace folder's `CLAUDE.md` (which imports the shared
 * `workspace_agents.md` and the folder's `AGENTS.md`), else its `AGENTS.md`.
 * `.github/copilot-instructions.md` is no longer read; only the deprecated
 * placeholder `${copilot-instructions}` names it, as an alias of
 * `${agent-instructions}`.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { samePath } from './pathCompare';

export const AGENTS_MD = 'AGENTS.md';
export const CLAUDE_MD = 'CLAUDE.md';

/** The id of the Guidelines / MD Browser group of a level's AGENTS.md. */
export const AGENTS_MD_GROUP_PREFIX = 'agents-md:';

function readNonEmpty(file: string): string | undefined {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.trim() ? text : undefined;
    } catch { return undefined; }
}

/**
 * What an Agent SDK send that loads the project's settings gets from the
 * workspace folder `wsRoot`: `project` when it has a CLAUDE.md (Claude Code
 * loads it and follows its imports), else the AGENTS.md text to put into the
 * system prompt, else nothing.
 */
export type WorkspaceInstructions =
    | { kind: 'project'; file: string }
    | { kind: 'inject'; file: string; block: string }
    | { kind: 'none' };

export function workspaceInstructions(wsRoot: string): WorkspaceInstructions {
    if (!wsRoot) { return { kind: 'none' }; }
    const claude = path.join(wsRoot, CLAUDE_MD);
    if (fs.existsSync(claude)) { return { kind: 'project', file: claude }; }
    const agents = path.join(wsRoot, AGENTS_MD);
    const body = readNonEmpty(agents);
    if (body) { return { kind: 'inject', file: agents, block: `## Workspace instructions (from ${AGENTS_MD})\n\n${body}` }; }
    return { kind: 'none' };
}

/** A level's AGENTS.md group: id, label, the folder it is in. */
export interface AgentsMdGroup { id: string; label: string; dir: string; level: 'root' | 'workspace' }

/**
 * The AGENTS.md files of the root and of the workspace folder, one group each
 * (one when they are the same folder); a level without the file has none.
 */
export function agentsMdGroups(root: string | undefined, workspaceFolder: string | undefined): AgentsMdGroup[] {
    const out: AgentsMdGroup[] = [];
    const same = !!root && !!workspaceFolder && samePath(root, workspaceFolder);
    const add = (dir: string | undefined, level: 'root' | 'workspace', label: string): void => {
        if (dir && fs.existsSync(path.join(dir, AGENTS_MD))) { out.push({ id: `${AGENTS_MD_GROUP_PREFIX}${level}`, label, dir, level }); }
    };
    if (same) {
        add(workspaceFolder, 'workspace', 'Agent Instructions (AGENTS.md)');
    } else {
        add(root, 'root', 'Agent Instructions (root AGENTS.md)');
        add(workspaceFolder, 'workspace', 'Agent Instructions (workspace AGENTS.md)');
    }
    return out;
}

/** The folder of the AGENTS.md group `group`, or undefined when it is none. */
export function agentsMdGroupDir(group: string, root: string | undefined, workspaceFolder: string | undefined): string | undefined {
    if (!group.startsWith(AGENTS_MD_GROUP_PREFIX)) { return undefined; }
    return group.slice(AGENTS_MD_GROUP_PREFIX.length) === 'root' ? root : workspaceFolder;
}
