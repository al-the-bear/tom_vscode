/**
 * Where the notes views read and write, as pure rules (vscode-free):
 *
 * - **Quest notes**: the `.md` files of the quest's notes folder,
 *   `_ai/quests/<quest>/notes/`. `quest-notes.md` is the default file (the
 *   setting `tomAi.notes.questNotesPattern` names it; its folder is the notes
 *   folder); more notes files stand beside it. {@link resolveDefaultQuestNotes}
 *   says which file the default is, {@link listQuestNotesFiles} what a picker
 *   offers, {@link newNotesFileName} whether a name can become a new file.
 * - **Workspace notes**: one file per workspace,
 *   `_ai/workspaces/<workspace>.notes.md` ({@link workspaceNotesFile}), beside
 *   the workspace's quest list (utils/aiWorkspace.ts, which also names the
 *   workspace). {@link ensureWorkspaceNotesFile} creates it.
 *
 * Notes are the user's: the views write them on the user's behalf, no agent
 * tool does.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AI_WORKSPACES_FOLDER } from './aiWorkspace';

/** The folder of a quest that holds its notes files. */
export const QUEST_NOTES_FOLDER = 'notes';
/** The default notes file of a quest, in its notes folder. */
export const DEFAULT_QUEST_NOTES_FILE = 'quest-notes.md';
/** The default of `tomAi.notes.questNotesPattern`: the default notes file, relative to the workspace folder. */
export const DEFAULT_QUEST_NOTES_PATTERN = `_ai/quests/\${quest}/${QUEST_NOTES_FOLDER}/${DEFAULT_QUEST_NOTES_FILE}`;

/** A new quest notes file's first lines. */
export function questNotesHeader(questId: string): string {
    return `# Quest Notes — ${questId}\n\n`;
}

/** The default notes file of a quest. */
export interface DefaultQuestNotes {
    /** The file the views show and save as the default. */
    filePath: string;
    /** The name a picker shows for it (the configured default's file name). */
    name: string;
    /** The notes folder: where the other notes files are, and where a new one is created. */
    folder: string;
}

/** The default notes file of a quest folder as the setting's default names it. */
export function defaultQuestNotesPath(questFolder: string): string {
    return path.join(questFolder, QUEST_NOTES_FOLDER, DEFAULT_QUEST_NOTES_FILE);
}

/**
 * Which file a quest's default notes file is. `configured` is the default file
 * as `tomAi.notes.questNotesPattern` resolves it ({@link defaultQuestNotesPath}
 * for the setting's default); its folder is the notes folder.
 */
export function resolveDefaultQuestNotes(configured: string): DefaultQuestNotes {
    return { name: path.basename(configured), folder: path.dirname(configured), filePath: configured };
}

/** A notes file a picker offers. */
export interface QuestNotesFile {
    /** Its name in the picker: the file name in the notes folder. */
    name: string;
    filePath: string;
    isDefault: boolean;
}

const byName = (a: string, b: string): number => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The notes files of a quest: the default first (listed whether or not it
 * exists yet), then the other `.md` files of the notes folder alphabetically
 * by name (case-insensitively).
 */
export function listQuestNotesFiles(def: DefaultQuestNotes): QuestNotesFile[] {
    let names: string[] = [];
    try {
        names = fs.readdirSync(def.folder, { withFileTypes: true })
            .filter((e) => !e.isDirectory() && /\.md$/i.test(e.name) && e.name.toLowerCase() !== def.name.toLowerCase())
            .map((e) => e.name);
    } catch { /* no notes folder yet: the default alone */ }
    return [
        { name: def.name, filePath: def.filePath, isDefault: true },
        ...names.sort(byName).map((name) => ({ name, filePath: path.join(def.folder, name), isDefault: false })),
    ];
}

/**
 * The notes files of a quest folder as names relative to it (`notes/<file>`, sorted): what a list of the quest
 * folder's own `.md` files adds so that it shows the quest's notes too.
 */
export function questFolderNotesEntries(questFolder: string): string[] {
    try {
        return fs.readdirSync(path.join(questFolder, QUEST_NOTES_FOLDER), { withFileTypes: true })
            .filter((e) => !e.isDirectory() && /\.md$/i.test(e.name))
            .map((e) => `${QUEST_NOTES_FOLDER}/${e.name}`)
            .sort(byName);
    } catch {
        return [];
    }
}

/** The file a kept choice names (case as listed); the default when the choice is none or its file is gone. */
export function pickQuestNotesFile(files: readonly QuestNotesFile[], chosen: string | undefined): QuestNotesFile {
    return files.find((f) => f.name === chosen) ?? files.find((f) => f.isDefault) ?? files[0];
}

/** The answer of {@link newNotesFileName}. */
export type NewNotesFileName =
    | { ok: true; fileName: string; heading: string }
    | { ok: false; problem: string };

/**
 * Whether `input` can name a new notes file beside `existing` (the names the
 * notes folder holds, the default's included). Refused: an empty name, one
 * with a path separator or `..`, one that exists (compared without case).
 * `.md` is appended when missing; `heading` is the new file's first line.
 */
export function newNotesFileName(input: string, existing: readonly string[]): NewNotesFileName {
    const name = input.trim();
    const title = name.replace(/\.md$/i, '').trim();
    if (!title) { return { ok: false, problem: 'Enter a name for the notes file.' }; }
    if (/[\\/]/.test(name)) { return { ok: false, problem: 'The name must not contain a path separator (/ or \\).' }; }
    if (name.includes('..')) { return { ok: false, problem: 'The name must not contain "..".' }; }
    const fileName = /\.md$/i.test(name) ? name : `${name}.md`;
    const taken = existing.find((e) => e.toLowerCase() === fileName.toLowerCase());
    if (taken) { return { ok: false, problem: `A notes file named ${taken} exists already.` }; }
    return { ok: true, fileName, heading: `# ${title}\n\n` };
}

// ---------------------------------------------------------------------------
// Workspace notes
// ---------------------------------------------------------------------------

/** A new workspace notes file's first lines. */
export const WORKSPACE_NOTES_HEADER = '# Workspace notes\n\n';

/** `_ai/workspaces/<workspace>.notes.md`; `workspace` as `aiWorkspaceName` names the window's root folder. */
export function workspaceNotesFile(aiRoot: string, workspace: string): string {
    return path.join(aiRoot, AI_WORKSPACES_FOLDER, `${workspace}.notes.md`);
}

/**
 * The file a new workspace notes file takes its content from, once: the file
 * the window had picked for WORKSPACE NOTES (`pickedFile`), else
 * `<workspace folder>/notes.md` — the first of them that exists and is not
 * empty. Undefined when the workspace notes file exists already, or neither
 * has content.
 */
export function workspaceNotesImportSource(target: string, pickedFile: string | undefined, workspaceFolder: string | undefined): string | undefined {
    if (fs.existsSync(target)) { return undefined; }
    const candidates = [pickedFile, workspaceFolder ? path.join(workspaceFolder, 'notes.md') : undefined];
    for (const c of candidates) {
        if (!c || path.resolve(c) === path.resolve(target)) { continue; }
        try {
            if (fs.statSync(c).isFile() && fs.readFileSync(c, 'utf8').trim() !== '') { return c; }
        } catch { /* not there */ }
    }
    return undefined;
}

/**
 * Create the workspace notes file (and `_ai/workspaces/`) when it is missing:
 * with the content of its import source ({@link workspaceNotesImportSource}),
 * which is left as it is, else with {@link WORKSPACE_NOTES_HEADER}. An
 * existing file is not touched. Answers what happened.
 */
export function ensureWorkspaceNotesFile(target: string, pickedFile: string | undefined, workspaceFolder: string | undefined): { created: boolean; importedFrom?: string } {
    if (fs.existsSync(target)) { return { created: false }; }
    const source = workspaceNotesImportSource(target, pickedFile, workspaceFolder);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source ? fs.readFileSync(source, 'utf8') : WORKSPACE_NOTES_HEADER, 'utf8');
    return { created: true, ...(source ? { importedFrom: source } : {}) };
}
