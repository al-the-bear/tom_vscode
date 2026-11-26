/**
 * Where the answers that report todos are found (the TODO Log view, a todo's
 * agent answer, a sent walk's repetition answers).
 *
 * - This host's compact trail `history/trail.<host>.md` (src/services/hostTrail.ts):
 *   every turn whose answer carries `TODO` response values
 *   ({@link hostTrailTodoEntries}, {@link hostTrailAnswerEntries}), labelled
 *   with its session.
 * - The summary trail pairs (`*.prompts.md` / `*.answers.md`) of the other
 *   subsystems in the quest's `history/` folder: one set per pair, keyed by
 *   its name ({@link todoLogTrailSets}).
 *
 * vscode-free; `discover` is the trail editor's discoverTrailSets.
 */

import * as fs from 'fs';

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
    for (const [name, set] of discover(historyFolder)) {
        out.set(name, { ...set, directory: historyFolder });
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

/** A host trail turn as an answer entry of a trail set (its `TODO*` response values as the `variables` lines). */
export interface HostTrailAnswerEntry {
    type: 'ANSWER';
    requestId: string;
    timestamp: string;
    rawTimestamp: string;
    content: string;
    variables: string;
    session: string;
}

/**
 * The host trail's turns that report todos as answer entries, in file order:
 * what the readers of trail sets (todoAgentAnswer.ts, repetitionAnswers.ts)
 * take, `variables` in the answers files' form (` - TODO = <ref>`).
 */
export function hostTrailAnswerEntries(turns: readonly HostTrailTurn[]): HostTrailAnswerEntry[] {
    const out: HostTrailAnswerEntry[] = [];
    for (const t of turns) {
        const values = Object.entries(extractTodoResponseValues(t.answer));
        if (values.length === 0) { continue; }
        out.push({
            type: 'ANSWER', requestId: t.id, timestamp: t.time, rawTimestamp: t.time, content: t.answer, session: t.session,
            variables: values.map(([k, v]) => ` - ${k} = ${v}`).join('\n'),
        });
    }
    return out;
}
