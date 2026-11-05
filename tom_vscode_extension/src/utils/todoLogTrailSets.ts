/**
 * Where the TODO Log view (todoLogPanel-handler.ts) finds its trail pairs.
 *
 * The summary trail pairs (`*.prompts.md` / `*.answers.md`) are written per
 * Anthropic session, in `history/sessions/<session>/` of the quest; the
 * quest's `history/` folder itself holds the pairs of the other subsystems
 * (Copilot). The view reads both: one set per pair, keyed `<session>/<name>`
 * for a session's pair and `<name>` for the folder's own.
 *
 * vscode-free; `discover` is the trail editor's discoverTrailSets.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SESSIONS_FOLDER } from '../services/sessionStorage';

export interface TodoLogTrailSet {
    prompts?: string;
    answers?: string;
    directory?: string;
}

/** Every trail set the TODO Log reads, under the quest's history folder. */
export function todoLogTrailSets(
    historyFolder: string,
    discover: (folder: string) => Map<string, TodoLogTrailSet>,
): Map<string, TodoLogTrailSet> {
    const out = new Map<string, TodoLogTrailSet>();
    if (!historyFolder || !fs.existsSync(historyFolder)) { return out; }
    const add = (folder: string, label: string): void => {
        for (const [name, set] of discover(folder)) {
            out.set(label ? `${label}/${name}` : name, { ...set, directory: folder });
        }
    };
    add(historyFolder, '');
    const sessions = path.join(historyFolder, SESSIONS_FOLDER);
    if (fs.existsSync(sessions)) {
        for (const e of fs.readdirSync(sessions, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.isDirectory()) { add(path.join(sessions, e.name), e.name); }
        }
    }
    return out;
}
