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
    /** IDs that were requested (or matched) but not moved, with reasons. */
    skipped: TodoMoveSkip[];
    /** Absolute path of the target sibling file ('' on error). */
    targetFile: string;
    /** Set when the whole operation was refused (terminal/missing source). */
    error?: string;
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

/** Extract the `# yaml-language-server:` schema comment line, if any. */
function schemaCommentOf(raw: string): string {
    const firstLine = raw.split('\n', 1)[0] ?? '';
    return firstLine.startsWith('# yaml-language-server:') ? firstLine + '\n' : '';
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

function moveTodosToSibling(sourceFilePath: string, spec: MoveSpec): TodoMoveResult {
    if (isArchivedOrDeletedTodoFile(sourceFilePath)) {
        const reason = 'Source file is already an archived/deleted todo file';
        return {
            moved: [],
            skipped: (spec.todoIds ?? []).map(id => ({ id, reason })),
            targetFile: '',
            error: reason,
        };
    }
    if (!fs.existsSync(sourceFilePath)) {
        return {
            moved: [],
            skipped: [],
            targetFile: '',
            error: `Source todo file not found: ${sourceFilePath}`,
        };
    }

    const raw = fs.readFileSync(sourceFilePath, 'utf8');
    const sourceDoc = parseDocument(raw);
    const todosNode = sourceDoc.get('todos', true);
    if (!isSeq(todosNode)) {
        return {
            moved: [],
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
        return { moved, skipped, targetFile };
    }

    // Append to target first (safer failure mode: worst case a re-run
    // duplicates in the target rather than losing todos).
    appendToTargetFile(targetFile, movedPlain, raw, sourceDoc);

    // Remove from source (descending indices).
    for (const idx of removeIdx.reverse()) {
        todosNode.items.splice(idx, 1);
    }
    sourceDoc.set('updated', isoDate());
    fs.writeFileSync(sourceFilePath, sourceDoc.toString(), 'utf8');

    return { moved, skipped, targetFile };
}

/** Create (if needed) and append todos to the target sibling file. */
function appendToTargetFile(
    targetFile: string,
    todos: Record<string, unknown>[],
    sourceRaw: string,
    sourceDoc: Document,
): void {
    let doc: Document;
    let prefix = '';
    if (fs.existsSync(targetFile)) {
        doc = parseDocument(fs.readFileSync(targetFile, 'utf8'));
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
    for (const plain of todos) {
        const node = doc.createNode(plain);
        forceBlockStyle(node);
        (todosNode as YAMLSeq).add(node);
    }
    forceBlockStyle(todosNode);
    doc.set('updated', isoDate());

    let content = doc.toString();
    if (prefix && !content.startsWith('# yaml-language-server:')) {
        content = prefix + content;
    }
    fs.writeFileSync(targetFile, content, 'utf8');
}

// ============================================================================
// Public operations
// ============================================================================

/**
 * Move the given completed todos to the `-archived` sibling file,
 * stamping each with `archived: <ISO date>`. Non-completed todos are
 * skipped per-todo; a terminal source file refuses the whole operation.
 */
export function archiveTodos(sourceFilePath: string, todoIds: string[]): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        todoIds,
        eligible: s => s === 'completed',
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
export function deleteTodos(sourceFilePath: string, todoIds: string[]): TodoMoveResult {
    return moveTodosToSibling(sourceFilePath, {
        todoIds,
        eligible: s => s !== 'completed',
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
