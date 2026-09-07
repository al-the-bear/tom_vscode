/**
 * Todo archive/delete move operations (TRA01).
 *
 * Moves todos between a source *.todo.yaml file and its derived sibling
 * (see todoArchiveNames.ts for the naming rule):
 *
 *   - archiveTodos:        only status=completed todos, stamped `archived:`
 *   - deleteTodos:         only NON-completed todos (completed can only be
 *                          archived), stamped `deleted:`
 *   - archiveAllCompleted: bulk archive over the whole file
 *   - deleteAllCancelled:  bulk delete of status=cancelled todos
 *
 * The target sibling lives in the same folder and is created on demand
 * with the same schema header as the source. All operations return a
 * `TodoMoveResult` so UI and tools can report precisely which todos were
 * moved and which were skipped (and why).
 *
 * **A move is a move, and moving twice is moving once.** The target is written
 * before the source is rewritten, so an interrupted move can leave a todo in
 * both files — recoverable only because the target write is keyed by id: an id
 * already there is replaced in place (and reported in `replaced`), never added
 * a second time. Without that, the natural recovery — run it again — is what
 * corrupts the archive, which is how `todos-archived.tom_core.todo.yaml` came
 * to hold six ids five times over.
 *
 * **A malformed file is refused, not written over.** Both files are read
 * through `todoYamlDocument.ts`, so a duplicate key — illegal YAML the parser
 * reports without throwing — aborts the move before its first write and comes
 * back in `TodoMoveResult.error` naming the file, the line and the parser's
 * objection. Left to `doc.toString()` it would instead surface, much later, as
 * `Document with errors cannot be stringified`.
 *
 * Pure fs + yaml — no vscode import — so the module is unit-testable
 * under plain `node --test`. Source YAML formatting/comments are
 * preserved via the yaml package's Document (CST) API.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml';
import {
    archivedTodoFileName,
    deletedTodoFileName,
    isArchivedOrDeletedTodoFile,
} from './todoArchiveNames';
import { questLogLocation } from './questLogFiles';
import { normaliseTodoDecisions } from './todoDecisions';
import {
    decisionsJournalHeader,
    formatDecisionJournalEntry,
} from './decisionsJournalFormat';
import { TodoYamlError, loadTodoYaml, parseTodoYaml } from './todoYamlDocument';

// ============================================================================
// Result types
// ============================================================================

export interface TodoMoveSkip {
    id: string;
    reason: string;
}

export interface TodoMoveResult {
    /** IDs of todos actually moved to the target file. */
    moved: string[];
    /**
     * Subset of {@link moved} whose id was already present in the target and was
     * therefore replaced in place rather than added. Non-empty means the target
     * had a stale (or duplicated) copy — normally the trace of a re-run after an
     * interrupted move.
     */
    replaced: string[];
    /** IDs that were requested (or matched) but not moved, with reasons. */
    skipped: TodoMoveSkip[];
    /** Absolute path of the target sibling file ('' on error). */
    targetFile: string;
    /** Set when the whole operation was refused (terminal/missing source). */
    error?: string;
}

export interface TodoMoveOptions {
    /**
     * Move todos regardless of their status. The status-based eligibility
     * guard (archive=completed / delete=non-completed) is bypassed. Used by
     * the panel's Archive/Delete buttons, which act on the user's explicit
     * selection or stack and must work for any status.
     */
    anyStatus?: boolean;
}

// ============================================================================
// Shared YAML helpers
// ============================================================================

/**
 * Ensure a YAML node tree uses block style (not flow/JSON style).
 * Recursively sets `flow = false` on all maps and sequences.
 * (Also consumed by questTodoManager — single owner lives here.)
 */
export function forceBlockStyle(node: unknown): void {
    if (isSeq(node)) {
        (node as YAMLSeq).flow = false;
        for (const item of (node as YAMLSeq).items) { forceBlockStyle(item); }
    } else if (isMap(node)) {
        (node as YAMLMap).flow = false;
        for (const pair of (node as YAMLMap).items) {
            forceBlockStyle((pair as { value?: unknown }).value);
        }
    }
}

function isoDate(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Stamp the file-level `updated:` key with today's date.
 *
 * `doc.set` alone is not enough. When the key is absent the yaml package
 * *appends* the new pair, which on a todo file means after the `todos:`
 * sequence — legal YAML, but it puts a header field thousands of lines below
 * the header and (having written it once) every later run then updates it in
 * that wrong place forever. So an absent key is inserted before `todos:`.
 */
function stampUpdated(doc: Document): void {
    const date = isoDate();
    const contents = doc.contents;
    if (!isMap(contents)) { return; }

    const map = contents as YAMLMap;
    const has = map.items.some(pair => String((pair as { key?: unknown }).key ?? '') === 'updated');
    if (has) {
        doc.set('updated', date);
        return;
    }
    const todosIdx = map.items.findIndex(
        pair => String((pair as { key?: unknown }).key ?? '') === 'todos',
    );
    const pair = doc.createPair('updated', date);
    if (todosIdx < 0) {
        map.items.push(pair);
    } else {
        map.items.splice(todosIdx, 0, pair);
    }
}

/** Extract the `# yaml-language-server:` schema comment line, if any. */
function schemaCommentOf(raw: string): string {
    const firstLine = raw.split('\n', 1)[0] ?? '';
    return firstLine.startsWith('# yaml-language-server:') ? firstLine + '\n' : '';
}

// ============================================================================
// Decisions journal
// ============================================================================

/**
 * Quest id of a todo file. The `quest:` field is authoritative — the file name
 * carries the quest too, but session todo files put a host slug in front of it,
 * so parsing the name would need to know which shape it is looking at.
 */
function questIdOf(sourceFilePath: string, doc?: Document): string {
    let source = doc;
    if (!source) {
        try {
            source = parseDocument(fs.readFileSync(sourceFilePath, 'utf8'));
        } catch {
            return '';
        }
    }
    const quest = source.get('quest');
    return quest === undefined || quest === null ? '' : String(quest);
}

/**
 * Path of the Decisions journal for a todo file — resolved through
 * {@link questLogLocation}, the same table the Logs viewer reads through, so
 * the writer and the reader cannot disagree about the name.
 *
 * The journal sits beside the todo file. For quest todos that directory *is*
 * the quest folder, which is where the viewer looks.
 */
export function decisionsJournalPathFor(sourceFilePath: string, questId?: string): string {
    const quest = questId?.trim() || questIdOf(sourceFilePath);
    const { fileName } = questLogLocation('decisions', quest);
    return path.join(path.dirname(sourceFilePath), fileName);
}

/**
 * Copy the decisions of the todos being archived into the quest's Decisions
 * journal. A copy, not a move: the archived todo stays a complete record of
 * itself, and the journal is what you can still find once nobody remembers
 * which todo it was.
 *
 * **Only `completed` todos are journalled.** Archiving is normally the end of a
 * finished todo, but the panel's Archive button acts on the user's selection
 * whatever its status (`anyStatus`) — and a todo archived half-done was
 * abandoned, not concluded. Its `decisions[]` are questions the project never
 * got to; filing them under "what was decided" would misrepresent them.
 *
 * Best-effort — a journal that could fail the archive it was recording would
 * be worse than no journal.
 */
function journalDecisions(
    sourceFilePath: string,
    todos: Record<string, unknown>[],
    sourceDoc: Document,
): void {
    try {
        const at = Date.now();
        const entries = todos.map(plain => {
            if (String(plain.status ?? 'not-started') !== 'completed') { return ''; }
            const decisions = normaliseTodoDecisions(plain.decisions);
            if (!decisions) { return ''; }
            const title = plain.title ?? plain.description;
            return formatDecisionJournalEntry({
                todoId: String(plain.id ?? ''),
                title: typeof title === 'string' ? title : undefined,
                decisions,
                archivedAt: at,
            });
        }).filter(text => text.length > 0);
        if (entries.length === 0) { return; }

        const quest = questIdOf(sourceFilePath, sourceDoc);
        const file = decisionsJournalPathFor(sourceFilePath, quest);
        const preamble = fs.existsSync(file) ? '' : decisionsJournalHeader(quest);
        fs.appendFileSync(file, preamble + entries.join('\n'), 'utf8');
    } catch {
        // Best-effort journalling — never fail an archive over its own log file.
    }
}

// ============================================================================
// Core move
// ============================================================================

type Stamp = 'archived' | 'deleted';

interface MoveSpec {
    /** Explicit ids to move, or undefined for a bulk predicate move. */
    todoIds?: string[];
    /** Eligibility predicate on the todo's status. */
    eligible: (status: string) => boolean;
    /** Skip reason for an ineligible explicitly-requested todo. */
    ineligibleReason: string;
    /** Field stamped on the moved todo (`archived:` / `deleted:`). */
    stamp: Stamp;
    /** Target sibling derivation. */
    targetName: (sourceFilePath: string) => string;
}

/**
 * Move todos to the spec's sibling file, reporting a malformed file rather
 * than failing on it opaquely.
 *
 * Either file may be illegal YAML — most often a duplicate key introduced by a
 * hand edit or a text merge. The parser does not throw on that, so without this
 * guard the move proceeds until `doc.toString()` refuses with a message naming
 * neither file nor line. {@link TodoYamlError} carries all three, and it aborts
 * the move *before* the first write: a malformed archive is left exactly as
 * found, for a human to repair, with the todo still in its source file.
 */
function moveTodosToSibling(sourceFilePath: string, spec: MoveSpec): TodoMoveResult {
    try {
        return moveTodosOrThrow(sourceFilePath, spec);
    } catch (e) {
        if (!(e instanceof TodoYamlError)) { throw e; }
        return {
            moved: [],
            replaced: [],
            skipped: (spec.todoIds ?? []).map(id => ({
                id,
                reason: `Todo file is malformed: ${e.filePath}`,
            })),
            targetFile: '',
            error: e.message,
        };
    }
}

function moveTodosOrThrow(sourceFilePath: string, spec: MoveSpec): TodoMoveResult {
    if (isArchivedOrDeletedTodoFile(sourceFilePath)) {
        const reason = 'Source file is already an archived/deleted todo file';
        return {
            moved: [],
            replaced: [],
            skipped: (spec.todoIds ?? []).map(id => ({ id, reason })),
            targetFile: '',
            error: reason,
        };
    }
    if (!fs.existsSync(sourceFilePath)) {
        return {
            moved: [],
            replaced: [],
            skipped: [],
            targetFile: '',
            error: `Source todo file not found: ${sourceFilePath}`,
        };
    }

    const raw = fs.readFileSync(sourceFilePath, 'utf8');
    const sourceDoc = parseTodoYaml(sourceFilePath, raw);
    const todosNode = sourceDoc.get('todos', true);
    if (!isSeq(todosNode)) {
        return {
            moved: [],
            replaced: [],
            skipped: [],
            targetFile: '',
            error: `No todos list in source file: ${sourceFilePath}`,
        };
    }

    const targetFile = spec.targetName(sourceFilePath);
    const moved: string[] = [];
    const skipped: TodoMoveSkip[] = [];
    const movedPlain: Record<string, unknown>[] = [];
    const removeIdx: number[] = [];

    const wanted = spec.todoIds ? new Set(spec.todoIds) : undefined;
    const seen = new Set<string>();

    todosNode.items.forEach((item, idx) => {
        if (!isMap(item)) { return; }
        const id = String(item.get('id') ?? '');
        if (wanted && !wanted.has(id)) { return; }
        seen.add(id);
        const status = String(item.get('status') ?? 'not-started');
        if (!spec.eligible(status)) {
            if (wanted) { skipped.push({ id, reason: spec.ineligibleReason }); }
            return;
        }
        const plain = item.toJSON() as Record<string, unknown>;
        plain[spec.stamp] = isoDate();
        movedPlain.push(plain);
        moved.push(id);
        removeIdx.push(idx);
    });

    if (wanted) {
        for (const id of wanted) {
            if (!seen.has(id)) {
                skipped.push({ id, reason: 'Todo not found in source file' });
            }
        }
    }

    if (moved.length === 0) {
        return { moved, replaced: [], skipped, targetFile };
    }

    // Target first, source second — the order that cannot lose a todo. A crash
    // between the two writes leaves the todo in both files, and the fix for that
    // is to run the move again: the target write is keyed by id, so the re-run
    // reconciles the copy it finds instead of adding a second one. (Source-first
    // would fail the other way, with the todo in neither file.)
    const replaced = writeTodosIntoTarget(targetFile, movedPlain, raw, sourceDoc);

    // Archiving retires a todo; deleting throws it away. Only the former is a
    // decision the project stands by, so only the former is journalled — and
    // within it, only the todos that actually completed (see journalDecisions).
    if (spec.stamp === 'archived') {
        journalDecisions(sourceFilePath, movedPlain, sourceDoc);
    }

    // Remove from source (descending indices).
    for (const idx of removeIdx.reverse()) {
        todosNode.items.splice(idx, 1);
    }
    stampUpdated(sourceDoc);
    fs.writeFileSync(sourceFilePath, sourceDoc.toString(), 'utf8');

    assertMovePersisted(sourceFilePath, targetFile, moved);

    return { moved, replaced, skipped, targetFile };
}

/**
 * Confirm a completed move actually reached disk on BOTH sides.
 *
 * The writes are ordered target-first so that an interruption leaves a todo in
 * both files rather than neither, and the documented recovery is to run the move
 * again. That is a safe failure, but it is a SILENT one: the caller is handed a
 * populated `moved` list and reports success, while the source still holds every
 * id it claims to have relocated. Exactly that state has been observed in the
 * wild — seven ids present in both the active file and its archived sibling,
 * with nothing in the result to say so.
 *
 * SCC84 is the general form: a confirmation that is not verified is worse than
 * no confirmation. Re-reading both files costs one parse each and turns a
 * half-done move into an error the caller can act on.
 */
function assertMovePersisted(
    sourceFilePath: string,
    targetFile: string,
    movedIds: string[],
): void {
    const idsIn = (filePath: string): Set<string> => {
        const doc = loadTodoYaml(filePath);
        const seq = doc.get('todos', true);
        const out = new Set<string>();
        if (isSeq(seq)) {
            for (const item of seq.items) {
                if (isMap(item)) {
                    const id = item.get('id');
                    if (id !== undefined && id !== null) { out.add(String(id)); }
                }
            }
        }
        return out;
    };

    let inTarget: Set<string>;
    let inSource: Set<string>;
    try {
        // A target that does not exist is a lost write, not an unreadable file:
        // the move creates it when absent, so its absence here means the write
        // never landed. Reporting it as "did not reach <target>" names the
        // actual fault; letting the read throw would blame the reader.
        inTarget = fs.existsSync(targetFile) ? idsIn(targetFile) : new Set<string>();
        inSource = idsIn(sourceFilePath);
    } catch (err) {
        throw new Error(
            `The move wrote ${movedIds.length} todo(s), but the files could not be ` +
            `re-read to confirm it: ${(err as Error).message}. The move is NOT ` +
            `confirmed — inspect both files before trusting the result.`,
        );
    }

    const missing = movedIds.filter(id => !inTarget.has(id));
    const stillInSource = movedIds.filter(id => inSource.has(id));
    if (missing.length === 0 && stillInSource.length === 0) { return; }

    const parts: string[] = [];
    if (missing.length) {
        parts.push(
            `did not reach ${path.basename(targetFile)}: ${missing.join(', ')}`,
        );
    }
    if (stillInSource.length) {
        parts.push(
            `are still in ${path.basename(sourceFilePath)}: ${stillInSource.join(', ')}`,
        );
    }
    throw new Error(
        `The move reported success but is only half done — ${parts.join('; ')}. ` +
        `Re-run it: the target write is keyed by id, so a re-run reconciles the ` +
        `copy it finds instead of adding a second one.`,
    );
}

/**
 * Write todos into the target sibling file, keyed by id: an id already present
 * is replaced where it sits, an id not present is added at the end. Returns the
 * ids that were replaced.
 *
 * Replacing **in place** (rather than removing and re-adding) keeps the archive
 * ordered by when things were first archived, so a re-run produces a diff of the
 * one changed entry instead of moving it to the bottom.
 *
 * Surplus copies of an id being written are dropped in the same pass. That is a
 * repair path: files corrupted by the pre-fix appending writer hold the same id
 * several times over, and reconciling them on the next touch is cheaper than
 * asking anyone to find them by hand. Ids that are *not* being written are left
 * exactly as they are — this reconciles, it does not tidy.
 */
function writeTodosIntoTarget(
    targetFile: string,
    todos: Record<string, unknown>[],
    sourceRaw: string,
    sourceDoc: Document,
): string[] {
    let doc: Document;
    let prefix = '';
    if (fs.existsSync(targetFile)) {
        doc = loadTodoYaml(targetFile);
    } else {
        // Same schema header as the source; same quest, fresh created date.
        prefix = schemaCommentOf(sourceRaw);
        const headerParts: string[] = [];
        const quest = sourceDoc.get('quest');
        if (quest !== undefined && quest !== null) {
            headerParts.push(`quest: "${String(quest)}"`);
        }
        headerParts.push(`created: "${isoDate()}"`);
        headerParts.push('todos: []');
        doc = parseDocument(headerParts.join('\n') + '\n');
    }

    let todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) {
        doc.set('todos', doc.createNode([]));
        todosNode = doc.get('todos', true) as YAMLSeq;
    }
    const seq = todosNode as YAMLSeq;

    const replaced: string[] = [];
    for (const plain of todos) {
        const id = String(plain.id ?? '');
        const node = doc.createNode(plain);
        forceBlockStyle(node);

        const at = id ? indexesOfTodoId(seq, id) : [];
        if (at.length === 0) {
            seq.add(node);
            continue;
        }
        seq.items[at[0]] = node;
        // Drop any surplus copies of this id, back to front so the earlier
        // indices stay valid.
        for (let i = at.length - 1; i >= 1; i--) { seq.items.splice(at[i], 1); }
        replaced.push(id);
    }
    forceBlockStyle(seq);
    stampUpdated(doc);

    let content = doc.toString();
    if (prefix && !content.startsWith('# yaml-language-server:')) {
        content = prefix + content;
    }
    fs.writeFileSync(targetFile, content, 'utf8');
    return replaced;
}

/** Positions of every entry in a todos sequence carrying the given id. */
function indexesOfTodoId(seq: YAMLSeq, id: string): number[] {
    const found: number[] = [];
    seq.items.forEach((item, idx) => {
        if (isMap(item) && String((item as YAMLMap).get('id') ?? '') === id) {
            found.push(idx);
        }
    });
    return found;
}

// ============================================================================
// Public operations
// ============================================================================

/**
 * Move the given completed todos to the `-archived` sibling file,
 * stamping each with `archived: <ISO date>`. Non-completed todos are
 * skipped per-todo; a terminal source file refuses the whole operation.
 */
export function archiveTodos(
    sourceFilePath: string,
    todoIds: string[],
    opts?: TodoMoveOptions,
): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        todoIds,
        eligible: opts?.anyStatus ? () => true : s => s === 'completed',
        ineligibleReason: 'Only completed todos can be archived',
        stamp: 'archived',
        targetName: archivedTodoFileName,
    });
}

/**
 * Move the given NON-completed todos to the `-deleted` sibling file,
 * stamping each with `deleted: <ISO date>`. Completed todos are skipped
 * (they can only be archived); a terminal source file refuses the whole
 * operation.
 */
export function deleteTodos(
    sourceFilePath: string,
    todoIds: string[],
    opts?: TodoMoveOptions,
): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        todoIds,
        eligible: opts?.anyStatus ? () => true : s => s !== 'completed',
        ineligibleReason: 'Completed todos can only be archived, not deleted',
        stamp: 'deleted',
        targetName: deletedTodoFileName,
    });
}

/** Archive every completed todo in the file. */
export function archiveAllCompleted(sourceFilePath: string): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        eligible: s => s === 'completed',
        ineligibleReason: 'Only completed todos can be archived',
        stamp: 'archived',
        targetName: archivedTodoFileName,
    });
}

/** Move every cancelled todo in the file to the `-deleted` sibling. */
export function deleteAllCancelled(sourceFilePath: string): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        eligible: s => s === 'cancelled',
        ineligibleReason: 'Only cancelled todos are moved by delete-all-cancelled',
        stamp: 'deleted',
        targetName: deletedTodoFileName,
    });
}
