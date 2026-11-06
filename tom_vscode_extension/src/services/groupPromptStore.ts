/**
 * Reads and writes the group prompt files (`src/utils/groupPrompts.ts` holds
 * the rules and the layout): the global folder `_ai/group_prompts/` and a
 * quest's `_ai/quests/<quest>/group_prompts/`. The folders are passed in, so
 * the functions work on any directory; `groupPromptDirs.ts` names the
 * workspace's.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    GROUP_PROMPTS_FOLDER,
    GROUP_PROMPT_KINDS,
    groupPromptFileName,
    groupPromptNameError,
    groupPromptOfFile,
    type GroupPromptEntry,
    type GroupPromptKind,
    type GroupPromptScope,
} from '../utils/groupPrompts';

/** The two folders of one quest's group prompt set; a missing quest has no quest folder. */
export interface GroupPromptDirs {
    global: string;
    quest?: string;
}

/** The `_ai` folder's group prompt folders for `questId`: the global one and the quest's. */
export function groupPromptDirsUnder(aiRoot: string, questId: string | undefined): GroupPromptDirs {
    const global = path.join(aiRoot, GROUP_PROMPTS_FOLDER);
    return questId ? { global, quest: path.join(aiRoot, 'quests', questId, GROUP_PROMPTS_FOLDER) } : { global };
}

function dirOf(dirs: GroupPromptDirs, scope: GroupPromptScope): string {
    const dir = scope === 'global' ? dirs.global : dirs.quest;
    if (!dir) { throw new Error('No quest is given, so there is no quest group prompt folder.'); }
    return dir;
}

function readScope(dir: string | undefined, scope: GroupPromptScope): GroupPromptEntry[] {
    if (!dir || !fs.existsSync(dir)) { return []; }
    const out: GroupPromptEntry[] = [];
    const candidates = ['default.md', ...['additions', 'prompts'].flatMap((sub) => {
        const subDir = path.join(dir, sub);
        return fs.existsSync(subDir) ? fs.readdirSync(subDir).map((f) => `${sub}/${f}`) : [];
    })];
    for (const rel of candidates) {
        const of = groupPromptOfFile(rel);
        if (!of || !GROUP_PROMPT_KINDS[scope].includes(of.kind)) { continue; }
        const file = path.join(dir, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { continue; }
        out.push({ scope, kind: of.kind, name: of.name, text: fs.readFileSync(file, 'utf8') });
    }
    return out;
}

/** Every group prompt of the global folder and the quest folder. */
export function readGroupPrompts(dirs: GroupPromptDirs): GroupPromptEntry[] {
    return [...readScope(dirs.global, 'global'), ...readScope(dirs.quest, 'quest')];
}

/** Refuse a kind the scope does not hold, or a name that cannot be a file name. */
function check(scope: GroupPromptScope, kind: GroupPromptKind, name: string): void {
    if (!GROUP_PROMPT_KINDS[scope].includes(kind)) { throw new Error(`A ${scope} group prompt cannot be a ${kind}.`); }
    if (kind !== 'default') {
        const error = groupPromptNameError(name);
        if (error) { throw new Error(error); }
    }
}

/** Write one entry (creating its folder). */
export function writeGroupPrompt(dirs: GroupPromptDirs, entry: GroupPromptEntry): void {
    check(entry.scope, entry.kind, entry.name);
    const file = path.join(dirOf(dirs, entry.scope), groupPromptFileName(entry.kind, entry.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.text, 'utf8');
}

/** Delete one entry's file; `false` when there was none. A global default deleted falls back to the built-in one. */
export function deleteGroupPrompt(dirs: GroupPromptDirs, scope: GroupPromptScope, kind: GroupPromptKind, name: string): boolean {
    check(scope, kind, name);
    const file = path.join(dirOf(dirs, scope), groupPromptFileName(kind, name));
    if (!fs.existsSync(file)) { return false; }
    fs.unlinkSync(file);
    return true;
}
