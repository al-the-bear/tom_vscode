/**
 * AI workspaces (vscimpb144): one `_ai` serves several workspace folders
 * (tom_agent_container, al_the_bear, …), and a workspace works on some of the
 * quests. `_ai/workspaces/<workspace>.yaml` (versioned with `_ai`) lists them:
 *
 *   # yaml-language-server: $schema=../../.tom/json-schema/workspaces/ai-workspace.schema.json
 *   quests:
 *     - vscode_extension
 *     - tom_specs
 *
 * `<workspace>` is the name of the window's root folder — the first folder of
 * the window as VS Code reports it (a `.code-workspace` opened from inside the
 * workspace folder: that folder, e.g. `tom_agent_container`; not the
 * `.code-workspace` name, which is the quest, and not the target of a symlinked
 * `_ai`). A quest may be in several workspaces.
 *
 * The workspace's quests: the file's `quests` list (a listed quest that does
 * not exist is reported, not an error); without one, the quests recorded for
 * the workspace (the folders windows opened them in, workspace_layout
 * 02_wslayout-11) when there are any; else every quest. Every place that lists
 * quests for a choice offers these first, with an "all quests" escape.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument, stringify } from 'yaml';

/** The folder under `_ai` holding the workspace files. */
export const AI_WORKSPACES_FOLDER = 'workspaces';

/** The schema line a workspace file starts with (relative to `_ai/workspaces/`). */
export const AI_WORKSPACE_SCHEMA_LINE = '# yaml-language-server: $schema=../../.tom/json-schema/workspaces/ai-workspace.schema.json';

/** Where the workspace's quests came from. */
export type WorkspaceQuestSource = 'list' | 'recorded' | 'all';

export interface WorkspaceQuests {
    /** The workspace's name (the window's root folder name). */
    workspace: string;
    /** `_ai/workspaces/<workspace>.yaml`. */
    file: string;
    /** The file exists. */
    fileExists: boolean;
    source: WorkspaceQuestSource;
    /** The workspace's quests that exist, in the list's order (`list`), else sorted. */
    quests: string[];
    /** Quests the list names that do not exist. */
    unknown: string[];
    /** A problem reading the file (it is then treated as having no list). */
    error?: string;
}

/** The workspace's name: the last segment of the window's root folder. */
export function aiWorkspaceName(rootFolder: string): string {
    return path.basename(path.resolve(rootFolder));
}

/** `_ai/workspaces/<workspace>.yaml`. */
export function aiWorkspaceFile(aiRoot: string, workspace: string): string {
    return path.join(aiRoot, AI_WORKSPACES_FOLDER, `${workspace}.yaml`);
}

/** The file's `quests` list (undefined: none, or no file), and a reading problem. */
export function readAiWorkspaceQuestList(file: string): { exists: boolean; quests?: string[]; error?: string } {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { exists: false }; }
    const doc = parseDocument(text);
    if (doc.errors.length) { return { exists: true, error: doc.errors[0].message }; }
    const data = doc.toJS() as unknown;
    if (data === null || data === undefined) { return { exists: true }; }
    if (typeof data !== 'object' || Array.isArray(data)) { return { exists: true, error: 'the file is not a mapping' }; }
    const raw = (data as Record<string, unknown>).quests;
    if (raw === undefined || raw === null) { return { exists: true }; }
    if (!Array.isArray(raw)) { return { exists: true, error: '`quests` is not a list' }; }
    const quests = [...new Set(raw.filter((q): q is string => typeof q === 'string' && q.trim() !== '').map((q) => q.trim()))];
    return { exists: true, quests };
}

/**
 * The workspace's quests: the list, else the recorded ones (when any exist), else every quest. `allQuests` are
 * the quest folders under `_ai/quests/`.
 */
export function resolveWorkspaceQuests(aiRoot: string, workspace: string, allQuests: readonly string[], recorded?: readonly string[]): WorkspaceQuests {
    const file = aiWorkspaceFile(aiRoot, workspace);
    const read = readAiWorkspaceQuestList(file);
    const exists = new Set(allQuests);
    const base = { workspace, file, fileExists: read.exists, ...(read.error ? { error: read.error } : {}) };
    if (read.quests) {
        return { ...base, source: 'list', quests: read.quests.filter((q) => exists.has(q)), unknown: read.quests.filter((q) => !exists.has(q)) };
    }
    const fromRecord = [...new Set(recorded ?? [])].filter((q) => exists.has(q)).sort();
    if (fromRecord.length) { return { ...base, source: 'recorded', quests: fromRecord, unknown: [] }; }
    return { ...base, source: 'all', quests: [...allQuests].sort(), unknown: [] };
}

/**
 * Write the workspace's quest list (creating the file and its folder); `undefined` removes the list — the
 * workspace then has every quest. Other keys of the file and its comments stay. Answers the file.
 */
export function writeAiWorkspaceQuests(aiRoot: string, workspace: string, quests: readonly string[] | undefined): string {
    const file = aiWorkspaceFile(aiRoot, workspace);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* a new file */ }
    const list = quests ? [...new Set(quests)] : undefined;
    let out: string;
    const doc = text.trim() ? parseDocument(text) : undefined;
    if (doc && !doc.errors.length && doc.contents && typeof doc.toJS() === 'object' && !Array.isArray(doc.toJS())) {
        if (list) { doc.set('quests', doc.createNode(list)); } else { doc.delete('quests'); }
        out = doc.toString({ lineWidth: 0 });
        if (!out.includes('$schema=')) { out = `${AI_WORKSPACE_SCHEMA_LINE}\n${out}`; }
    } else {
        out = `${AI_WORKSPACE_SCHEMA_LINE}\n${list ? stringify({ quests: list }, { lineWidth: 0 }) : '{}\n'}`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out, 'utf8');
    return file;
}

/** The text of `short_description.<quest>.md` (vscimpb145): its lines after the title, trimmed; undefined without the file. */
export function readQuestShortDescription(questsRoot: string, quest: string): string | undefined {
    let text: string;
    try { text = fs.readFileSync(path.join(questsRoot, quest, `short_description.${quest}.md`), 'utf8'); } catch { return undefined; }
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const body = (lines[0]?.startsWith('# ') ? lines.slice(1) : lines).join('\n').trim();
    return body || undefined;
}
