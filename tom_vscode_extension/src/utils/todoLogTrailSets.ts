/**
 * Where the TODO Log view (todoLogPanel-handler.ts) finds its answers.
 *
 * - This host's compact trail `history/trail.<host>.md` (src/services/hostTrail.ts):
 *   every turn whose answer carries `TODO` response values
 *   ({@link hostTrailTodoEntries}), labelled with its session.
 * - OLD PLACE (until the `_ai` format migration): the summary trail pairs
 *   (`*.prompts.md` / `*.answers.md`) an older build wrote per Anthropic
 *   session, in `history/sessions/<session>/`, and the quest's `history/`
 *   folder's own pairs of the other subsystems: one set per pair, keyed
 *   `<session>/<name>` for a session's pair and `<name>` for the folder's own
 *   ({@link todoLogTrailSets}). Their answers count only when they are older
 *   than the host trail's oldest turn and not in it ({@link keepOlderPairAnswer}).
 *
 * vscode-free; `discover` is the trail editor's discoverTrailSets.
 */

import * as fs from 'fs';
import * as path from 'path';

import { SESSIONS_FOLDER } from '../services/sessionStorage';
import type { HostTrailTurn } from '../services/hostTrail';
import { extractTodoResponseValues } from './responseValues';

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

/** A host trail turn whose answer references todos. */
export interface HostTrailTodoEntry {
    requestId: string;
    timestamp: string;
    session: string;
    /** The `TODO*` response values of its answer, in their order (not yet deduplicated). */
    refs: string[];
}

/** The host trail's turns that reference todos (the `TODO*` response values of their answers), in file order. */
export function hostTrailTodoEntries(turns: readonly HostTrailTurn[]): HostTrailTodoEntry[] {
    const out: HostTrailTodoEntry[] = [];
    for (const t of turns) {
        const refs = Object.values(extractTodoResponseValues(t.answer));
        if (refs.length > 0) { out.push({ requestId: t.id, timestamp: t.time, session: t.session, refs }); }
    }
    return out;
}

/**
 * OLD PLACE: whether an answer of an older build's pair still counts beside
 * the host trail: its request id is not in the trail and it is older than the
 * trail's oldest turn (every answer counts while the trail is empty).
 */
export function keepOlderPairAnswer(requestId: string, timestamp: string, turns: readonly HostTrailTurn[]): boolean {
    if (turns.some((t) => t.id === requestId)) { return false; }
    const oldest = turns.reduce<string | undefined>((min, t) => (min === undefined || t.time < min ? t.time : min), undefined);
    return oldest === undefined || timestamp < oldest;
}
