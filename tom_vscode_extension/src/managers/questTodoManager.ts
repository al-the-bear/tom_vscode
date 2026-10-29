/**
 * QuestTodoManager — reads and writes quest YAML todo files using the
 * `yaml` package's document API to preserve formatting, comments, and
 * anchors exactly as specified in chat_enhancements.md §1.3.
 *
 * File structure:
 *   _ai/quests/{questId}/
 *   ├── todos.{questId}.todo.yaml          # main quest todo file
 *   └── {YYYYMMDD}_{HHMM}_{winId}.todo.yaml  # session-scoped
 *
 * The existing JSON-schema (`todo.schema.json`) defines the shape of
 * each todo item.  This manager does NOT change the schema — it reads
 * and writes YAML that conforms to it.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, YAMLMap, YAMLSeq, Scalar, isMap, isSeq } from 'yaml';
import { WsPaths } from '../utils/workspacePaths';
import { TODO_ORCHESTRATION_FIELDS, toTodoDate, todayLocalDate, withTodoDates, type TodoOrchestrationField } from '../utils/todoDates';
import { scanWorkspaceProjectsByDetectors } from '../utils/projectDetector';
import { forceBlockStyle, archiveTodos as archiveTodosInFile, deleteTodos as deleteTodosInFile, type TodoMoveResult as TodoFileMoveResult } from '../utils/todoArchive';
import { ALL_TODO_FILES, matchesTodoFileScope, type TodoFileScope } from '../utils/todoArchiveNames';
import { normaliseTodoDecisions, type TodoDecision } from '../utils/todoDecisions';
import { loadTodoYaml } from '../utils/todoYamlDocument';
import { setTodoQuestsRoot, writeTodoFileText } from '../utils/todoBlockingSync';

export { normaliseTodoDecisions, isDecisionResolved, hasUnresolvedDecisions, type TodoDecision } from '../utils/todoDecisions';

// Archive/delete move operations (TRA01) — implemented as pure fs+yaml
// utilities so they are unit-testable; surfaced here as manager API.
export {
    archiveTodos,
    deleteTodos,
    archiveAllCompleted,
    deleteAllCancelled,
    type TodoMoveResult,
    type TodoMoveSkip,
    type TodoMoveOptions,
} from '../utils/todoArchive';
export {
    ALL_TODO_FILES,
    archivedTodoFileName,
    deletedTodoFileName,
    isArchivedOrDeletedTodoFile,
    isArchivedTodoFile,
    isDeletedTodoFile,
    matchesTodoFileScope,
    type TodoFileScope,
} from '../utils/todoArchiveNames';

// ============================================================================
// Types (mirrors todo.schema.json)
// ============================================================================

export interface QuestTodoScope {
    project?: string;
    projects?: string[];
    module?: string;
    area?: string;
    files?: string[];
}

export interface QuestTodoReference {
    type?: string;
    path?: string;
    url?: string;
    description?: string;
    lines?: string;
}

export type QuestTodoStatus =
    | 'not-started'
    | 'in-progress'
    | 'blocked'
    | 'decision-needed'
    | 'completed'
    | 'cancelled';

export interface QuestTodoItem {
    id: string;
    title?: string;
    description: string;
    status: QuestTodoStatus;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    tags?: string[];
    scope?: QuestTodoScope;
    references?: QuestTodoReference[];
    dependencies?: string[];
    blocked_by?: string[];
    /**
     * The live todos whose `blocked_by` names this one (bare ids in the same
     * quest, `<quest>/<id>` from another): the reverse of `blocked_by`. Derived
     * — every write keeps it in step (utils/todoBlockingSync.ts) — so no update
     * path takes it.
     */
    blocking?: string[];
    /**
     * Publish conditions that block the todo, each `<package> >= <x.y.z>` (or
     * `>`): met when pub.dev's latest release satisfies it
     * (_bin/check_todo_blocks.py, the queue's unblock).
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    blocked_until?: string[];
    /** Decisions the user has to make before this todo can be started. */
    decisions?: TodoDecision[];
    notes?: string;
    created?: string;
    updated?: string;
    completed_date?: string;
    completed_by?: string;
    /** Worktracker orchestration: the role that carries the todo out. */
    execution_role?: string;
    /** Worktracker orchestration: the role that checks the result. */
    qa_role?: string;
    /** Worktracker orchestration: the role that orchestrates the bundle. */
    orchestration_role?: string;
    /** Worktracker orchestration: the execution bundle the todo is grouped into. */
    bundle_id?: string;
    /** Worktracker orchestration: the todo this one was derived from. */
    derived_from?: string;
    /** Worktracker orchestration: the feedback that raised this todo. */
    feedback_source?: string;
    /**
     * The todo is the user's to do (reviewing, answering, a look at a screen):
     * a `<prefix>*` queue walk passes it and the todo panel marks it. Written
     * only as `true`; `false` removes the key.
     */
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the todo schema's YAML key
    user_action?: boolean;
    /** Runtime: which file this item was loaded from (not persisted). */
    _sourceFile?: string;
}

export interface QuestTodoFile {
    quest?: string;
    scope?: QuestTodoScope;
    references?: QuestTodoReference[];
    created?: string;
    updated?: string;
    author?: string;
    todos: QuestTodoItem[];
}

// ============================================================================
// Helpers
// ============================================================================

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function questFolder(questId: string): string {
    return WsPaths.ai('quests', questId) || path.join(getWorkspaceRoot(), '_ai', 'quests', questId);
}

/**
 * Return the todo YAML files of a quest, scoped by `scope` (TRA13).
 *
 * By default this lists the LIVE todo files only — the quest and session
 * files. The `-archived` / `-deleted` terminal siblings are retired and
 * are excluded unless the caller asks for them; see `TodoFileScope`.
 */
export function listTodoFiles(questId: string, scope?: TodoFileScope): string[] {
    const folder = questFolder(questId);
    if (!fs.existsSync(folder)) { return []; }
    return fs.readdirSync(folder).filter(f =>
        f.endsWith('.todo.yaml') && matchesTodoFileScope(f, scope),
    ).sort();
}

/** Persistent todo file path. */
export function persistentTodoPath(questId: string): string {
    return path.join(questFolder(questId), `todos.${questId}.todo.yaml`);
}

/**
 * The todo file a caller names for a quest: an absolute path as it is, a bare
 * file name in the quest folder, a path with a `/` relative to the workspace
 * root; none is the quest's own `todos.<quest>.todo.yaml`. Callers outside the
 * extension (the scripting bridge) name files these three ways; read relative
 * to the process's working directory a bare name found nothing.
 */
export function questTodoFilePath(questId: string, file?: string): string {
    if (!file) { return persistentTodoPath(questId); }
    if (path.isAbsolute(file)) { return file; }
    return file.includes('/') ? path.join(getWorkspaceRoot(), file) : path.join(questFolder(questId), file);
}

/**
 * A workspace-level todo file a caller names: an absolute path as it is, any
 * other path relative to the workspace root (the shape `listWorkspaceTodoFiles`
 * answers); none is `<workspace root>/workspace.todo.yaml`.
 */
export function workspaceTodoFilePath(file?: string): string {
    if (!file) { return path.join(getWorkspaceRoot(), 'workspace.todo.yaml'); }
    return path.isAbsolute(file) ? file : path.join(getWorkspaceRoot(), file);
}

/**
 * Remove one todo recoverably, the way the todo panel and the todo tools do: a
 * completed todo to the file's `-archived` sibling (completed todos are only
 * ever archived), any other to its `-deleted` sibling. A missing todo is
 * reported in `skipped`.
 */
export function moveTodoToSiblingByStatus(filePath: string, todoId: string): TodoFileMoveResult {
    const todo = findTodoByIdInFile(filePath, todoId);
    return todo?.status === 'completed'
        ? archiveTodosInFile(filePath, [todoId])
        : deleteTodosInFile(filePath, [todoId]);
}

// ============================================================================
// YAML document helpers
// ============================================================================

/**
 * Parse a YAML file into a Document (preserving CST).
 *
 * Refuses a file the parser found problems in — chiefly a duplicate key, which
 * the yaml package reports without throwing. Tolerating it here would leave the
 * document unwritable (`doc.toString()` refuses) and the failure would surface
 * far from its cause; `TodoYamlError` names the file, the line and the
 * objection instead. See `utils/todoYamlDocument.ts`.
 */
function loadDocument(filePath: string): Document {
    return loadTodoYaml(filePath);
}

/** Write a Document back, preserving formatting. */
function saveDocument(filePath: string, doc: Document): void {
    configureBlockingSync();
    writeTodoFileText(filePath, doc.toString());
}

/**
 * Tell the `blocking` sync where this workspace's quests are. Every write of
 * a todo file goes through `writeTodoFileText` (utils/todoBlockingSync.ts),
 * which writes the text and then keeps `blocking` in step with `blocked_by`
 * for the todos the write can have changed.
 */
function configureBlockingSync(): void {
    setTodoQuestsRoot(WsPaths.ai('quests') || path.join(getWorkspaceRoot(), '_ai', 'quests'));
}

/**
 * Confirm a mutation that has just been written actually reached disk.
 *
 * The todo tools answer `ok: true` with the whole record echoed back, and every
 * caller reasonably reads that as durable. It was not. A `tomAi_createQuestTodo`
 * call returned success with the full todo in its response and the todo was in
 * no `*.todo.yaml` file afterwards — archived and deleted siblings included. It
 * survived only because a neighbouring todo's notes happened to mention the id.
 * A confirmation that is not verified is worse than no confirmation, so each
 * write now re-reads the file and checks the invariant it just established.
 *
 * WHAT THIS IS NOT. It is not protection against an in-process race, because
 * there is none to protect against: every mutator in this file is synchronous
 * from `loadDocument` through `writeFileSync`, with no `await` anywhere in the
 * module, so two calls inside one extension host cannot interleave their
 * read-modify-write. A mutex keyed on the file path — the obvious fix, and the
 * one originally proposed — would serialise operations that are already
 * serial.
 *
 * WHAT IT DOES CATCH is a write lost to anything OUTSIDE this process, which is
 * the only explanation left: another extension host writing the same file over
 * the shared `_ai` clone, a panel saving a stale whole-file buffer, or a git
 * merge driver rewriting the file underneath us. None of those is reachable
 * from a lock, and all of them are visible to a re-read.
 */
function assertTodoPersisted(
    filePath: string,
    todoId: string,
    expected: 'present' | 'absent',
    operation: string,
): void {
    let onDisk: Document;
    try {
        onDisk = loadDocument(filePath);
    } catch (err) {
        throw new Error(
            `${operation} wrote "${todoId}" to ${path.basename(filePath)}, but the file ` +
            `could not be re-read to confirm it: ${(err as Error).message}. The write ` +
            `is NOT confirmed — inspect the file before trusting either outcome.`,
        );
    }
    const seq = onDisk.get('todos', true);
    const present = isSeq(seq) && seq.items.some(
        (item: unknown) => isMap(item) && String((item as YAMLMap).get('id')) === todoId,
    );
    if (present === (expected === 'present')) { return; }

    throw new Error(
        expected === 'present'
            ? `${operation} reported success for "${todoId}" but the todo is not in ` +
              `${path.basename(filePath)} when the file is read back. The write was lost — ` +
              `most likely overwritten by another writer of this file. Nothing was saved; ` +
              `retry, and check whether another window or process is editing the same quest.`
            : `${operation} reported success for "${todoId}" but the todo is STILL in ` +
              `${path.basename(filePath)} when the file is read back. The removal was lost — ` +
              `most likely overwritten by another writer of this file.`,
    );
}

/**
 * Confirm the FIELDS a mutation just wrote are readable back, not only that the
 * record exists.
 *
 * WHY THE PRESENCE CHECK ABOVE IS NOT ENOUGH, measured rather than argued. A
 * lost CREATE leaves the todo missing, which `assertTodoPersisted` catches. A
 * lost UPDATE leaves the todo PRESENT with its old content, so presence proves
 * nothing and the caller is told the edit landed while the file holds the
 * previous text. Nothing is absent, no grep comes up empty, and the only
 * symptom is that the change quietly is not there.
 *
 * IT IS NOT HYPOTHETICAL. `createTodo` accepted `scope`, `references`,
 * `blocked_by`, `completed_date` and `completed_by`, echoed all five back in a
 * `{ok: true}` response, and wrote NONE of them — its plain-object builder
 * simply had no branch for them, while `createTodoInFile` beside it did. Every
 * todo created through `tomAi_createQuestTodo` lost its scope and references
 * that way, and the presence check passed on every one of them because the id
 * was there. This function is what turns that class of loss into an error.
 *
 * WHAT IT COMPARES, and why it is not the conservative "one scalar" the plan
 * called for. The fear was FALSE FAILURES from normalisation — that a correct
 * write would not compare equal after a YAML round trip, and a verification
 * that cries wolf gets deleted, taking the working checks with it. Measured on
 * this package's own writer: a plain string round-trips byte-for-byte through
 * folded blocks, blank lines, indented continuations, tabs, leading spaces and
 * a trailing newline; so do string arrays and normalised decisions. Ten of ten
 * cases, exactly equal.
 *
 * So the conservative plan was not merely cautious, it was aimed away from the
 * defect: comparing one representative SCALAR would never have looked at
 * `scope` or `references`, which is where the loss was.
 *
 * THE THREE REAL NORMALISATIONS, each measured, each narrow:
 *
 *   1. An empty value is a DELETE. The writers turn `''`, `[]` and an empty
 *      scope into an absent key on purpose, so "wrote empty, read nothing" is
 *      success rather than loss.
 *   2. `scope` is rebuilt from a known subset of keys and re-emitted in the
 *      reader's own order, so it is compared key by key over that subset
 *      rather than by serialised shape.
 *   3. The value compared is what the WRITER computed, not what the caller
 *      passed — `decisions` is normalised on the way in, and comparing against
 *      the raw input would fail on every correct write.
 *
 * A value this cannot compare is SKIPPED rather than guessed at. That is the
 * one place the original caution survives: a silent skip loses a check, an
 * invented comparison loses the whole mechanism.
 */
function assertTodoFieldsPersisted(
    filePath: string,
    todoId: string,
    written: Record<string, unknown>,
    operation: string,
): void {
    const onDisk = findTodoByIdInFile(filePath, todoId);
    if (!onDisk) {
        // `assertTodoPersisted` owns absence and says it better; do not report
        // the same fault twice in different words.
        return;
    }

    const mismatches: string[] = [];
    for (const [key, value] of Object.entries(written)) {
        if (!VERIFIED_TODO_FIELDS.has(key)) { continue; }
        const actual = (onDisk as unknown as Record<string, unknown>)[key];
        if (isEmptyTodoValue(value)) {
            // The writers delete a falsy key rather than storing it empty.
            if (!isEmptyTodoValue(actual)) {
                mismatches.push(`${key}: wrote nothing, read ${describe(actual)}`);
            }
            continue;
        }
        if (!todoValuesAgree(key, value, actual)) {
            mismatches.push(`${key}: wrote ${describe(value)}, read ${describe(actual)}`);
        }
    }

    if (mismatches.length === 0) { return; }

    throw new Error(
        `${operation} reported success for "${todoId}" but these fields are not ` +
        `readable back from ${path.basename(filePath)}:\n  ${mismatches.join('\n  ')}\n` +
        `The record is there and its content is not, which is the failure a ` +
        `presence check cannot see. Either the write was lost to another writer ` +
        `of this file, or the field is not persisted by this code path at all — ` +
        `check the file before retrying, because a retry will not fix the second.`,
    );
}

/**
 * Fields whose written value is comparable against the value read back.
 *
 * Derived from a measurement, not from the type: every one of these was written
 * and re-read through this module's own writer and reader and came back equal.
 * `created` and `updated` are absent deliberately — the writer stamps them
 * itself rather than taking them from the caller, so there is nothing the
 * caller asked for to compare.
 */
const VERIFIED_TODO_FIELDS = new Set<string>([
    'title', 'description', 'status', 'priority', 'notes',
    'completed_date', 'completed_by',
    'tags', 'dependencies', 'blocked_by', 'blocked_until', 'references',
    'decisions', 'scope', 'user_action',
    ...TODO_ORCHESTRATION_FIELDS,
]);

/** Whether [value] is what the writers store as an absent key. */
function isEmptyTodoValue(value: unknown): boolean {
    if (value === undefined || value === null || value === '') { return true; }
    if (Array.isArray(value)) { return value.length === 0; }
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).every(isEmptyTodoValue);
    }
    return false;
}

/** Whether a written and a read-back value are the same value. */
function todoValuesAgree(key: string, written: unknown, actual: unknown): boolean {
    if (key === 'scope') {
        // Rebuilt from a known subset and re-emitted in the reader's order, so
        // compare the subset rather than the serialised shape.
        const a = (written ?? {}) as Record<string, unknown>;
        const b = (actual ?? {}) as Record<string, unknown>;
        return ['project', 'module', 'area', 'projects', 'files'].every((k) => {
            if (isEmptyTodoValue(a[k]) && isEmptyTodoValue(b[k])) { return true; }
            return JSON.stringify(a[k]) === JSON.stringify(b[k]);
        });
    }
    return JSON.stringify(written) === JSON.stringify(actual);
}

/** A short, quotable rendering of a value for a failure message. */
function describe(value: unknown): string {
    if (value === undefined) { return 'nothing'; }
    const text = JSON.stringify(value) ?? String(value);
    return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

/**
 * Build the YAML schema comment for a todo file.
 * The relative schema path depends on where the file is located.
 */
function schemaComment(filePath: string): string {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) { return ''; }
    const schemaAbs = path.join(wsRoot, '_ai', 'schemas', 'yaml', 'todo.schema.json');
    const rel = path.relative(path.dirname(filePath), schemaAbs);
    return `# yaml-language-server: $schema=${rel}\n`;
}

/**
 * Write a Document with the schema comment prepended.
 * If the document already has the schema comment, it won't be duplicated.
 */
function saveDocumentWithSchema(filePath: string, doc: Document): void {
    let content = doc.toString();
    if (!content.startsWith('# yaml-language-server:')) {
        content = schemaComment(filePath) + content;
    }
    configureBlockingSync();
    writeTodoFileText(filePath, content);
}

/**
 * Write the `decisions` list onto a todo node, or remove the key when there is
 * nothing left to decide. Normalised on the way in so a hand-edited or
 * tool-supplied list cannot persist unlabelled rows.
 */
function setDecisions(doc: Document, item: YAMLMap, decisions: TodoDecision[] | undefined): void {
    const normalised = normaliseTodoDecisions(decisions);
    if (!normalised) {
        item.delete('decisions');
        return;
    }
    const node = doc.createNode(normalised);
    forceBlockStyle(node);
    item.set('decisions', node);
}

/** Convert a YAML map node to a plain QuestTodoItem. */
function nodeToTodo(node: YAMLMap, sourceFile?: string): QuestTodoItem {
    const get = (key: string): unknown => node.get(key);
    const getStr = (key: string): string | undefined => {
        const v = get(key);
        return v === undefined || v === null ? undefined : String(v);
    };
    const getArr = (key: string): string[] | undefined => {
        const seq = node.get(key, true);
        if (!isSeq(seq)) { return undefined; }
        return seq.items.map((i: unknown) =>
            i instanceof Scalar ? String(i.value) : String(i),
        );
    };

    const item: QuestTodoItem = {
        id: getStr('id') ?? '',
        description: getStr('description') ?? '',
        status: (getStr('status') as QuestTodoItem['status']) ?? 'not-started',
    };
    const title = getStr('title');
    if (title) { item.title = title; }
    const priority = getStr('priority');
    if (priority) { item.priority = priority as QuestTodoItem['priority']; }
    const tags = getArr('tags');
    if (tags) { item.tags = tags; }
    const deps = getArr('dependencies');
    if (deps) { item.dependencies = deps; }
    const blockedBy = getArr('blocked_by');
    if (blockedBy) { item.blocked_by = blockedBy; }
    const blocking = getArr('blocking');
    if (blocking) { item.blocking = blocking; }
    const blockedUntil = getArr('blocked_until');
    if (blockedUntil) { item.blocked_until = blockedUntil; }
    const notes = getStr('notes');
    if (notes) { item.notes = notes; }
    const created = getStr('created');
    if (created) { item.created = created; }
    const updated = getStr('updated');
    if (updated) { item.updated = updated; }
    const completedDate = getStr('completed_date');
    if (completedDate) { item.completed_date = completedDate; }
    const completedBy = getStr('completed_by');
    if (completedBy) { item.completed_by = completedBy; }
    for (const field of TODO_ORCHESTRATION_FIELDS) {
        const value = getStr(field);
        if (value) { item[field] = value; }
    }
    if (get('user_action') === true) { item.user_action = true; }

    // scope
    const scopeNode = node.get('scope', true);
    if (isMap(scopeNode)) {
        item.scope = {
            project: scopeNode.get('project') as string | undefined,
            module: scopeNode.get('module') as string | undefined,
            area: scopeNode.get('area') as string | undefined,
        };
        const projects = scopeNode.get('projects', true);
        if (isSeq(projects)) {
            item.scope.projects = projects.items.map((i: unknown) =>
                i instanceof Scalar ? String(i.value) : String(i));
        }
        const files = scopeNode.get('files', true);
        if (isSeq(files)) {
            item.scope.files = files.items.map((i: unknown) =>
                i instanceof Scalar ? String(i.value) : String(i));
        }
    }

    // references
    //
    // A PLAIN STRING IS STILL READ. The schema types references as maps, and
    // the tools reject anything else (SCE243). But a string already in a file,
    // written by hand or by an older build, must not make the todo lose its
    // references on the next read: this reader used to `.filter(isMap)`, which
    // did exactly that. Such a string is read as `{path}`.
    const refsNode = node.get('references', true);
    if (isSeq(refsNode)) {
        item.references = refsNode.items
            .map((entry: unknown): QuestTodoReference | undefined => {
                if (isMap(entry)) {
                    const m = entry as YAMLMap;
                    return {
                        type: m.get('type') as string | undefined,
                        path: m.get('path') as string | undefined,
                        url: m.get('url') as string | undefined,
                        description: m.get('description') as string | undefined,
                        lines: m.get('lines') as string | undefined,
                    };
                }
                const raw = entry instanceof Scalar ? entry.value : entry;
                return typeof raw === 'string' ? { path: raw } : undefined;
            })
            .filter((r): r is QuestTodoReference => r !== undefined);
    }

    // decisions — normalised so every reader gets a labelled list or nothing.
    const decisionsNode = node.get('decisions', true);
    if (isSeq(decisionsNode)) {
        item.decisions = normaliseTodoDecisions(decisionsNode.toJSON());
    }

    // SCE5: anything this reader does not recognise, kept so a move carries it.
    // `moveTodo` reads a todo here and writes it back through the builder, so a
    // key nobody enumerated — a later schema addition, or a hand-written field —
    // would otherwise be dropped in transit and the move would look clean.
    const extra: Record<string, unknown> = {};
    for (const pair of node.items) {
        const key = String((pair.key as Scalar)?.value ?? pair.key);
        if (BUILT_TODO_KEYS.has(key)) { continue; }
        extra[key] = (pair.value as Scalar)?.value ?? pair.value;
    }
    if (Object.keys(extra).length) {
        (item as { _extra?: Record<string, unknown> })._extra = extra;
    }

    if (sourceFile) { item._sourceFile = sourceFile; }
    return item;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read all todos from a single file.
 */
export function readTodoFile(filePath: string): QuestTodoItem[] {
    if (!fs.existsSync(filePath)) { return []; }
    const doc = loadDocument(filePath);
    const todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) { return []; }
    const basename = path.basename(filePath);
    return todosNode.items.filter(isMap).map((n: YAMLMap) => nodeToTodo(n, basename));
}

/**
 * Ensure a todo YAML file exists with minimal structure.
 */
export function ensureTodoFile(
    filePath: string,
    header?: Record<string, unknown>,
): void {
    if (fs.existsSync(filePath)) { return; }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Build YAML content as a string so todos: [] renders as block-style "todos: []"
    const parts: string[] = [];
    if (header) {
        for (const [k, v] of Object.entries(header)) {
            if (typeof v === 'string') { parts.push(`${k}: ${v}`); }
            else if (typeof v === 'object' && v !== null) {
                const subDoc = new Document(v);
                parts.push(`${k}:\n` + subDoc.toString().split('\n').map(l => '  ' + l).join('\n').trimEnd());
            }
        }
    }
    parts.push(`created: "${todayLocalDate()}"`);
    parts.push('todos: []');
    const doc = parseDocument(parts.join('\n') + '\n');
    saveDocumentWithSchema(filePath, doc);
}

/**
 * Find a single todo by ID in one specific file.
 */
export function findTodoByIdInFile(filePath: string, todoId: string): QuestTodoItem | undefined {
    return readTodoFile(filePath).find(t => t.id === todoId);
}

/**
 * Create a todo in an arbitrary todo YAML file.
 */
export function createTodoInFile(
    filePath: string,
    todo: Omit<QuestTodoItem, '_sourceFile'>,
    header?: Record<string, unknown>,
): QuestTodoItem {
    ensureTodoFile(filePath, header);
    const doc = loadDocument(filePath);

    let todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) {
        doc.set('todos', doc.createNode([]));
        todosNode = doc.get('todos', true) as YAMLSeq;
    }

    const plain = buildTodoPlain(todo);

    const newNode = doc.createNode(plain);
    forceBlockStyle(newNode);
    (todosNode as YAMLSeq).add(newNode);
    // Ensure the todos sequence itself is block-style
    forceBlockStyle(todosNode);
    doc.set('updated', todayLocalDate());
    saveDocument(filePath, doc);
    assertTodoPersisted(filePath, todo.id, 'present', 'createTodoInFile');
    assertTodoFieldsPersisted(filePath, todo.id, plain, 'createTodoInFile');

    return {
        ...todo,
        created: plain.created as string,
        _sourceFile: path.basename(filePath),
    };
}

/**
 * Every key the builder below writes from a named field.
 *
 * Used to decide what is LEFT OVER on a todo read off disk, so a move carries
 * it rather than dropping it.
 */
const BUILT_TODO_KEYS = new Set<string>([
    'id', 'description', 'status', 'title', 'priority', 'tags', 'notes',
    'dependencies', 'blocked_by', 'blocking', 'blocked_until', 'references', 'completed_date',
    'completed_by', 'scope', 'decisions', 'created', '_sourceFile', '_extra',
    'user_action',
    ...TODO_ORCHESTRATION_FIELDS,
]);

/**
 * The plain map a todo is written to YAML as — the ONE routine both create
 * paths use.
 *
 * SCE5. There were two of these, written as copies of one another, and they
 * drifted: `createTodoInFile` wrote `scope`, `references`, `blocked_by` and
 * the completion stamps while `createTodo` — the path the MCP tool uses —
 * wrote none of them. SCD202 repaired `createTodo` by adding the missing
 * branches, which fixed the behaviour and left the two copies standing; this
 * removes the second copy, because a pair that has drifted once will drift
 * again and the failure is silent by construction (`createTodo` returns
 * `{...todo}`, so a field it does not write still comes back in the response).
 *
 * KEY ORDER IS PART OF THE OUTPUT and is fixed here, which is the other thing
 * two copies could not guarantee: the same todo written by either path is the
 * same bytes.
 *
 * UNRECOGNISED KEYS ARE CARRIED, not enumerated away. A move reads a todo off
 * disk and writes it back, so anything this routine does not know about — a
 * field a later schema adds, or one somebody wrote by hand — would be lost in
 * transit. `nodeToTodo` collects them into `_extra` and they are written back
 * last.
 */
function buildTodoPlain(todo: Omit<QuestTodoItem, '_sourceFile'>): Record<string, unknown> {
    const plain: Record<string, unknown> = {
        id: todo.id,
        description: todo.description,
        status: todo.status,
    };
    if (todo.title) { plain.title = todo.title; }
    if (todo.priority) { plain.priority = todo.priority; }
    if (todo.tags && todo.tags.length) { plain.tags = todo.tags; }
    if (todo.notes) { plain.notes = todo.notes; }
    if (todo.dependencies && todo.dependencies.length) { plain.dependencies = todo.dependencies; }
    if (todo.blocked_by && todo.blocked_by.length) { plain.blocked_by = todo.blocked_by; }
    if (todo.blocking && todo.blocking.length) { plain.blocking = todo.blocking; }
    if (todo.blocked_until && todo.blocked_until.length) { plain.blocked_until = todo.blocked_until; }
    if (todo.references && todo.references.length) {
        // The tools reject bare strings (SCE243). An internal caller that
        // passes one anyway gets it stored as `{path}`, the shape
        // `nodeToTodo` reads it back as, so nothing reaches disk unreadable.
        plain.references = todo.references.map((ref) =>
            typeof ref === 'string' ? { path: ref } : ref,
        );
    }
    if (todo.completed_date) { plain.completed_date = toTodoDate('completed_date', todo.completed_date); }
    if (todo.completed_by) { plain.completed_by = todo.completed_by; }
    for (const field of TODO_ORCHESTRATION_FIELDS) {
        if (todo[field]) { plain[field] = todo[field]; }
    }
    if (todo.user_action === true) { plain.user_action = true; }
    if (todo.scope) {
        const scopeObj: Record<string, unknown> = {};
        if (todo.scope.project) { scopeObj.project = todo.scope.project; }
        if (todo.scope.projects?.length) { scopeObj.projects = todo.scope.projects; }
        if (todo.scope.module) { scopeObj.module = todo.scope.module; }
        if (todo.scope.area) { scopeObj.area = todo.scope.area; }
        if (todo.scope.files?.length) { scopeObj.files = todo.scope.files; }
        if (Object.keys(scopeObj).length) { plain.scope = scopeObj; }
    }
    const decisions = normaliseTodoDecisions(todo.decisions);
    if (decisions) { plain.decisions = decisions; }
    plain.created = todo.created ? toTodoDate('created', todo.created) : todayLocalDate();
    const extra = (todo as { _extra?: Record<string, unknown> })._extra;
    if (extra) {
        // Carried from disk (a move): a date field written as a timestamp is
        // written back as a date; one that is no date at all is carried as it
        // was rather than failing the move — it is not this caller's value.
        let carried: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(extra)) {
            if (!BUILT_TODO_KEYS.has(key)) { carried[key] = value; }
        }
        try { carried = withTodoDates(carried); } catch { /* keep as written */ }
        Object.assign(plain, carried);
    }
    return plain;
}

/**
 * Apply an update to a todo's YAML map, returning what was written (for the
 * read-back). The ONE routine both update paths use (`updateTodo`,
 * `updateTodoInFile`): they were copies and had drifted — `updateTodo`
 * cleared a field with `set(key, undefined)`, which the yaml package writes as
 * `key: null`, while the other used `setOrDelete`. Every value is checked
 * before anything is written, so a refused update changes nothing.
 *
 * @throws when `completed_date` is not a date (a timestamp is written as the
 *   date it names).
 */
function applyTodoUpdates(
    doc: Document,
    item: YAMLMap,
    updates: Partial<Omit<QuestTodoItem, 'id' | '_sourceFile'>>,
): Record<string, unknown> {
    const completedDate = toTodoDate('completed_date', updates.completed_date);
    const applied: Record<string, unknown> = {};
    if (updates.title !== undefined) { setOrDelete(item, 'title', updates.title); applied.title = updates.title; }
    if (updates.description !== undefined) { item.set('description', updates.description); applied.description = updates.description; }
    if (updates.status !== undefined) { item.set('status', updates.status); applied.status = updates.status; }
    if (updates.priority !== undefined) { setOrDelete(item, 'priority', updates.priority); applied.priority = updates.priority; }
    if (updates.notes !== undefined) { setOrDelete(item, 'notes', updates.notes); applied.notes = updates.notes; }
    if (updates.tags !== undefined) { setOrDelete(item, 'tags', updates.tags?.length ? doc.createNode(updates.tags) : undefined); applied.tags = updates.tags; }
    if (updates.dependencies !== undefined) { setOrDelete(item, 'dependencies', updates.dependencies?.length ? doc.createNode(updates.dependencies) : undefined); applied.dependencies = updates.dependencies; }
    if (updates.blocked_by !== undefined) { setOrDelete(item, 'blocked_by', updates.blocked_by?.length ? doc.createNode(updates.blocked_by) : undefined); applied.blocked_by = updates.blocked_by; }
    if (updates.blocked_until !== undefined) { setOrDelete(item, 'blocked_until', updates.blocked_until?.length ? doc.createNode(updates.blocked_until) : undefined); applied.blocked_until = updates.blocked_until; }
    if (updates.decisions !== undefined) { setDecisions(doc, item, updates.decisions); applied.decisions = normaliseTodoDecisions(updates.decisions) ?? []; }
    if (completedDate !== undefined) { setOrDelete(item, 'completed_date', completedDate); applied.completed_date = completedDate; }
    if (updates.completed_by !== undefined) { setOrDelete(item, 'completed_by', updates.completed_by); applied.completed_by = updates.completed_by; }
    for (const field of TODO_ORCHESTRATION_FIELDS as readonly TodoOrchestrationField[]) {
        if (updates[field] !== undefined) { setOrDelete(item, field, updates[field]); applied[field] = updates[field]; }
    }
    if (updates.user_action !== undefined) {
        const userAction = updates.user_action === true ? true : undefined;
        setOrDelete(item, 'user_action', userAction);
        applied.user_action = userAction;
    }
    if (updates.scope !== undefined) {
        if (updates.scope && (updates.scope.project || updates.scope.projects?.length || updates.scope.module || updates.scope.area || updates.scope.files?.length)) {
            const scopeObj: Record<string, unknown> = {};
            if (updates.scope.project) { scopeObj.project = updates.scope.project; }
            if (updates.scope.projects?.length) { scopeObj.projects = updates.scope.projects; }
            if (updates.scope.module) { scopeObj.module = updates.scope.module; }
            if (updates.scope.area) { scopeObj.area = updates.scope.area; }
            if (updates.scope.files?.length) { scopeObj.files = updates.scope.files; }
            item.set('scope', doc.createNode(scopeObj));
            applied.scope = scopeObj;
        } else {
            item.delete('scope');
            applied.scope = undefined;
        }
    }
    if (updates.references !== undefined) {
        applied.references = updates.references;
        if (updates.references?.length) {
            item.set('references', doc.createNode(updates.references));
        } else {
            item.delete('references');
        }
    }
    // A date already on the item that an earlier writer stored as a timestamp
    // is written as a date while the item is being rewritten anyway.
    for (const field of ['created', 'archived', 'deleted', 'due'] as const) {
        const current = item.get(field);
        if (typeof current === 'string') {
            try { const date = toTodoDate(field, current); if (date !== current) { item.set(field, date); } } catch { /* leave a non-date alone */ }
        }
    }
    return applied;
}

/**
 * Write an optional todo field, or remove it when there is no value.
 *
 * `map.set(key, undefined)` does not remove the key — the yaml package writes
 * `key: null`. Every optional field in the todo schema is typed as a string or
 * an array, so a null fails validation (`None is not of type 'string'`) and the
 * pre-commit hook then refuses the whole file. An absent field must be absent.
 */
function setOrDelete(item: YAMLMap, key: string, value: unknown): void {
    if (value === undefined || value === null || value === '') {
        item.delete(key);
    } else {
        item.set(key, value);
    }
}

/**
 * Update a todo in an arbitrary todo YAML file.
 */
export function updateTodoInFile(
    filePath: string,
    todoId: string,
    updates: Partial<Omit<QuestTodoItem, 'id' | '_sourceFile'>>,
): QuestTodoItem | undefined {
    if (!fs.existsSync(filePath)) { return undefined; }
    const doc = loadDocument(filePath);
    const todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) { return undefined; }

    for (const item of todosNode.items) {
        if (!isMap(item)) { continue; }
        if (String(item.get('id')) !== todoId) { continue; }

        // Collected as it is applied, so the read-back below compares the set
        // the writer touched. SCD202 covers this function for the same reason
        // it covers `updateTodo`: a lost update leaves the todo present with
        // its old content, which no presence check can see.
        const applied = applyTodoUpdates(doc, item as YAMLMap, updates);

        item.set('updated', todayLocalDate());
        doc.set('updated', todayLocalDate());
        saveDocument(filePath, doc);
        assertTodoPersisted(filePath, todoId, 'present', 'updateTodoInFile');
        assertTodoFieldsPersisted(filePath, todoId, applied, 'updateTodoInFile');
        return nodeToTodo(item as YAMLMap, path.basename(filePath));
    }

    return undefined;
}

/**
 * Read todos from the quest's live todo files (see `listTodoFiles`).
 *
 * Pass `ALL_TODO_FILES` to include archived/deleted todos — needed when
 * resolving a todo by id, not when counting or iterating "the todos".
 */
export function readAllTodos(questId: string, scope?: TodoFileScope): QuestTodoItem[] {
    const files = listTodoFiles(questId, scope);
    const folder = questFolder(questId);
    const all: QuestTodoItem[] = [];
    for (const f of files) {
        all.push(...readTodoFile(path.join(folder, f)));
    }
    return all;
}

/**
 * Read todos from ALL quest folders.
 * Each item's _sourceFile is prefixed with `questId/filename`.
 */
export function readAllQuestsTodos(): QuestTodoItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    const all: QuestTodoItem[] = [];
    const questDirs = fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort();
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                t._sourceFile = qid + '/' + (t._sourceFile ?? '');
            }
            all.push(...todos);
        } catch { /* skip */ }
    }
    return all;
}

/**
 * List all quest directory names.
 */
export function listQuestIds(): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    return fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort();
}

/**
 * Find all *.todo.yaml files across the entire workspace.
 * Returns items with _sourceFile set to workspace-relative path.
 */
export function readWorkspaceTodos(): QuestTodoItem[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const all: QuestTodoItem[] = [];
    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { walk(fp); }
            else if (e.name.endsWith('.todo.yaml')) {
                try {
                    const items = readTodoFile(fp);
                    const rel = path.relative(wsRoot, fp);
                    for (const t of items) { t._sourceFile = rel; }
                    all.push(...items);
                } catch { /* skip */ }
            }
        }
    }
    walk(wsRoot);
    return all;
}

/**
 * List all *.todo.yaml files across the workspace as relative paths.
 */
export function listWorkspaceTodoFiles(): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const files: string[] = [];
    function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { walk(fp); }
            else if (e.name.endsWith('.todo.yaml')) {
                files.push(path.relative(wsRoot, fp));
            }
        }
    }
    walk(wsRoot);
    return files.sort();
}

/**
 * Find a single todo by ID across all files in a quest.
 * Returns the item with `_sourceFile` set, or undefined.
 */
export function findTodoById(questId: string, todoId: string): QuestTodoItem | undefined {
    // Resolving an id must still reach a todo that was archived or deleted —
    // otherwise the caller cannot tell "no such todo" from "retired todo".
    return readAllTodos(questId, ALL_TODO_FILES).find(t => t.id === todoId);
}

/**
 * Create a new todo item in a file (appends to the `todos` sequence).
 * If the file does not exist, creates it with a minimal structure.
 */
export function createTodo(
    questId: string,
    todo: Omit<QuestTodoItem, '_sourceFile'>,
    targetFile?: string,
): QuestTodoItem {
    const folder = questFolder(questId);
    if (!fs.existsSync(folder)) { fs.mkdirSync(folder, { recursive: true }); }

    let fileName = targetFile ?? `todos.${questId}.todo.yaml`;
    // Ensure the file name always ends with .todo.yaml
    if (!fileName.endsWith('.todo.yaml')) {
        if (fileName.endsWith('.yaml')) {
            fileName = fileName.replace(/\.yaml$/, '.todo.yaml');
        } else {
            fileName = fileName + '.todo.yaml';
        }
    }
    const filePath = path.join(folder, fileName);

    let doc: Document;
    let isNewFile = false;
    if (fs.existsSync(filePath)) {
        doc = loadDocument(filePath);
    } else {
        // Create minimal file
        isNewFile = true;
        doc = parseDocument(`quest: "${questId}"\ncreated: "${todayLocalDate()}"\ntodos: []\n`);
    }

    let todosNode = doc.get('todos', true);
    if (!isSeq(todosNode)) {
        doc.set('todos', doc.createNode([]));
        todosNode = doc.get('todos', true) as YAMLSeq;
    }

    const plain = buildTodoPlain(todo);

    const newNode = doc.createNode(plain);
    forceBlockStyle(newNode);
    (todosNode as YAMLSeq).add(newNode);
    forceBlockStyle(todosNode);
    // Update file-level `updated` date
    doc.set('updated', todayLocalDate());
    if (isNewFile) {
        saveDocumentWithSchema(filePath, doc);
    } else {
        saveDocument(filePath, doc);
    }
    assertTodoPersisted(filePath, todo.id, 'present', 'createTodo');
    assertTodoFieldsPersisted(filePath, todo.id, plain, 'createTodo');

    return { ...todo, _sourceFile: fileName, created: plain.created as string };
}

/**
 * Update fields of an existing todo item in place (CST preservation).
 */
export function updateTodo(
    questId: string,
    todoId: string,
    updates: Partial<Omit<QuestTodoItem, 'id' | '_sourceFile'>>,
): QuestTodoItem | undefined {
    // Find which file contains this todo — including retired files, so an
    // archived todo can still be edited rather than silently not found.
    const folder = questFolder(questId);
    for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
        const filePath = path.join(folder, fileName);
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) { continue; }

        for (const item of todosNode.items) {
            if (!isMap(item)) { continue; }
            if (String(item.get('id')) === todoId) {
                // What was actually asked for, collected as it is applied, so
                // the read-back compares against the same set the writer
                // touched rather than against every field the caller's object
                // happens to carry.
                const applied = applyTodoUpdates(doc, item, updates);
                item.set('updated', todayLocalDate());
                doc.set('updated', todayLocalDate());
                saveDocument(filePath, doc);
                // SCD202. The presence check the other mutators use says
                // nothing here: a lost update leaves the todo present with its
                // OLD content, so the only evidence is the content itself.
                assertTodoPersisted(filePath, todoId, 'present', 'updateTodo');
                assertTodoFieldsPersisted(filePath, todoId, applied, 'updateTodo');
                return nodeToTodo(item, fileName);
            }
        }
    }
    return undefined;
}

/**
 * Delete a todo item from its underlying YAML file.
 * If sourceFile is provided, it is used first to locate the concrete file.
 */
export function deleteTodo(
    questId: string,
    todoId: string,
    sourceFile?: string,
): boolean {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return false;

    const deleteFromFile = (filePath: string): boolean => {
        if (!fs.existsSync(filePath)) return false;
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) return false;
        const idx = todosNode.items.findIndex((item: unknown) =>
            isMap(item) && String((item as YAMLMap).get('id')) === todoId,
        );
        if (idx < 0) return false;
        todosNode.items.splice(idx, 1);
        doc.set('updated', todayLocalDate());
        saveDocument(filePath, doc);
        assertTodoPersisted(filePath, todoId, 'absent', 'deleteTodo');
        return true;
    };

    if (sourceFile && sourceFile.endsWith('.todo.yaml')) {
        const candidates = new Set<string>();
        if (path.isAbsolute(sourceFile)) {
            candidates.add(sourceFile);
        } else {
            if (sourceFile.startsWith('_ai/')) {
                candidates.add(path.join(wsRoot, sourceFile));
            }
            if (sourceFile.includes('/')) {
                const parts = sourceFile.split('/');
                if (parts.length > 1 && !sourceFile.startsWith('_ai/')) {
                    const qid = parts[0];
                    const fileName = parts.slice(1).join('/');
                    candidates.add(path.join(questFolder(qid), fileName));
                }
                candidates.add(path.join(wsRoot, sourceFile));
            }
            if (questId && !questId.startsWith('__') && !sourceFile.includes('/')) {
                candidates.add(path.join(questFolder(questId), sourceFile));
            }
        }
        for (const fp of candidates) {
            if (deleteFromFile(fp)) return true;
        }
    }

    if (questId && !questId.startsWith('__')) {
        const folder = questFolder(questId);
        // Retired files included: purging a todo from the archive is valid.
        for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
            if (deleteFromFile(path.join(folder, fileName))) return true;
        }
    }

    for (const rel of listWorkspaceTodoFiles()) {
        if (deleteFromFile(path.join(wsRoot, rel))) return true;
    }

    return false;
}

/**
 * Move a todo from one file to another.
 */
export function moveTodo(
    questId: string,
    todoId: string,
    targetFileName: string,
): QuestTodoItem | undefined {
    // Ensure the target file name always ends with .todo.yaml
    let normalizedTarget = targetFileName;
    if (!normalizedTarget.endsWith('.todo.yaml')) {
        if (normalizedTarget.endsWith('.yaml')) {
            normalizedTarget = normalizedTarget.replace(/\.yaml$/, '.todo.yaml');
        } else {
            normalizedTarget = normalizedTarget + '.todo.yaml';
        }
    }
    const folder = questFolder(questId);

    // 1. Find and remove from source — retired files included, so moving a
    //    todo OUT of the archive (un-archiving) works.
    for (const fileName of listTodoFiles(questId, ALL_TODO_FILES)) {
        const filePath = path.join(folder, fileName);
        const doc = loadDocument(filePath);
        const todosNode = doc.get('todos', true);
        if (!isSeq(todosNode)) { continue; }

        const idx = todosNode.items.findIndex((item: unknown) =>
            isMap(item) && String((item as YAMLMap).get('id')) === todoId,
        );
        if (idx === -1) { continue; }

        const todoNode = todosNode.items[idx] as YAMLMap;
        const todoPlain = nodeToTodo(todoNode);

        // Remove from source
        todosNode.items.splice(idx, 1);
        doc.set('updated', todayLocalDate());
        saveDocument(filePath, doc);
        // SCD202. The target half verifies itself — `createTodo` below checks
        // both presence and fields. The SOURCE half had nothing, and a lost
        // removal here leaves the todo in BOTH files: a duplicate id, which
        // reads as a move that worked.
        assertTodoPersisted(filePath, todoId, 'absent', 'moveTodo');

        // 2. Add to target
        return createTodo(questId, todoPlain, normalizedTarget);
    }
    return undefined;
}

/**
 * The file in a quest's folder that holds `todoId`: `sourceFile` (a file name
 * in the quest folder) when given and it holds the id, else whichever of the
 * quest's todo files does, session and retired files included.
 */
export function questTodoSourcePath(questId: string, todoId: string, sourceFile?: string): string | undefined {
    const folder = questFolder(questId);
    if (sourceFile) {
        const candidate = path.join(folder, path.basename(sourceFile));
        if (findTodoByIdInFile(candidate, todoId)) { return candidate; }
    }
    const found = findTodoById(questId, todoId);
    return found?._sourceFile ? path.join(folder, found._sourceFile) : undefined;
}

/** True when `_ai/quests/<questId>/` exists. */
export function questExists(questId: string): boolean {
    return !!questId && !questId.startsWith('__') && fs.existsSync(questFolder(questId));
}

/** Where {@link moveTodoToDestination} moves a todo: a quest's own todo file, or `workspace.todo.yaml`. */
export type TodoMoveDestination = { kind: 'quest'; questId: string } | { kind: 'workspace' };

export type TodoTransferResult =
    | { ok: true; todo: QuestTodoItem; targetPath: string }
    | { ok: false; reason: string };

/** The file a destination writes to: `todos.<quest>.todo.yaml`, or `<wsRoot>/workspace.todo.yaml`. */
export function todoDestinationPath(dest: TodoMoveDestination): string | undefined {
    if (dest.kind === 'quest') { return persistentTodoPath(dest.questId); }
    const wsRoot = getWorkspaceRoot();
    return wsRoot ? path.join(wsRoot, 'workspace.todo.yaml') : undefined;
}

/**
 * Move one todo out of any todo file (a quest file, a session file,
 * `workspace.todo.yaml`, an archived sibling) into a quest's todo file or the
 * workspace todo file. Every field travels, unknown ones included
 * (`buildTodoPlain`). When `origin` is given and the todo leaves it, the
 * origin is noted in `notes` (`[moved from quest: <id>]`), so a todo that
 * crossed quests says where it came from.
 *
 * The target is written first and the source second, each verified: a failure
 * between them leaves a duplicate that the verifier reports, never a todo that
 * is in neither file. Refused, with nothing written: a source that does not
 * hold the id, a target that is the source, and a target that already holds a
 * todo with that id.
 */
export function moveTodoToDestination(
    sourcePath: string,
    todoId: string,
    dest: TodoMoveDestination,
    origin?: string,
    /**
     * New ids for the todos moved together (a prefix chosen for the target
     * quest): this todo takes its new id, and its `blocked_by` / `dependencies`
     * entries naming another moved todo follow that one's new id.
     */
    renames?: ReadonlyMap<string, string>,
): TodoTransferResult {
    const targetPath = todoDestinationPath(dest);
    if (!targetPath) { return { ok: false, reason: 'No workspace root.' }; }
    if (path.resolve(targetPath) === path.resolve(sourcePath)) {
        return { ok: false, reason: `${todoId} is already in ${path.basename(targetPath)}.` };
    }
    if (!fs.existsSync(sourcePath)) { return { ok: false, reason: `No todo file at ${sourcePath}.` }; }
    const doc = loadDocument(sourcePath);
    const todosNode = doc.get('todos', true);
    const idx = isSeq(todosNode)
        ? todosNode.items.findIndex((item: unknown) => isMap(item) && String((item as YAMLMap).get('id')) === todoId)
        : -1;
    if (!isSeq(todosNode) || idx === -1) {
        return { ok: false, reason: `${todoId} is not in ${path.basename(sourcePath)}.` };
    }
    const newId = renames?.get(todoId) ?? todoId;
    if (findTodoByIdInFile(targetPath, newId)) {
        return { ok: false, reason: `${path.basename(targetPath)} already holds a todo ${newId}.` };
    }

    const todo = nodeToTodo(todosNode.items[idx] as YAMLMap);
    const destLabel = dest.kind === 'quest' ? `quest: ${dest.questId}` : 'workspace';
    if (origin && origin !== destLabel) {
        todo.notes = `${todo.notes ?? ''}\n[moved from ${origin}${newId !== todoId ? ` as ${todoId}` : ''}]`.trim();
    } else if (newId !== todoId) {
        todo.notes = `${todo.notes ?? ''}\n[renamed from ${todoId}]`.trim();
    }
    if (renames?.size) {
        todo.id = newId;
        const follow = (ids?: string[]): string[] | undefined => ids?.map((d) => renames.get(d) ?? d);
        if (todo.blocked_by) { todo.blocked_by = follow(todo.blocked_by); }
        if (todo.dependencies) { todo.dependencies = follow(todo.dependencies); }
    }

    // 1. The target, verified by the create itself.
    const moved = dest.kind === 'quest'
        ? createTodo(dest.questId, todo)
        : createTodoInFile(targetPath, todo, { scope: { area: 'workspace' } });

    // 2. The source.
    todosNode.items.splice(idx, 1);
    doc.set('updated', todayLocalDate());
    saveDocument(sourcePath, doc);
    assertTodoPersisted(sourcePath, todoId, 'absent', 'moveTodoToDestination');

    return { ok: true, todo: { ...moved, _sourceFile: path.basename(targetPath) }, targetPath };
}

/**
 * Collect all unique tags from all todo files across all quests.
 */
export function collectAllTags(questId?: string): string[] {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return [];
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return [];
    const tagSet = new Set<string>();
    const questDirs = questId
        ? [questId]
        : fs.readdirSync(questsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                if (t.tags) t.tags.forEach(tag => tagSet.add(tag));
            }
        } catch { /* skip */ }
    }
    return [...tagSet].sort();
}

// ============================================================================
// Project / module / area scanning for scope editor
// ============================================================================

export interface ScannedProject {
    name: string;
    relativePath: string;
    type: 'dart' | 'node' | 'other';
}

/**
 * Scan workspace for projects by looking for pubspec.yaml and package.json.
 * Returns project names with their relative paths.
 */
export function scanWorkspaceProjects(): ScannedProject[] {
    const detected = scanWorkspaceProjectsByDetectors(4);
    return detected
        .map((project) => {
            const types = project.attributes.types || [];
            let type: 'dart' | 'node' | 'other' = 'other';
            if (types.some((item) => item.includes('dart') || item.includes('flutter'))) {
                type = 'dart';
            } else if (types.some((item) => item.includes('node') || item.includes('vscode_extension'))) {
                type = 'node';
            }
            return {
                name: project.name,
                relativePath: project.relativePath,
                type,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Collect unique project/module/area values from all existing todos.
 */
export function collectScopeValues(): { projects: string[], modules: string[], areas: string[] } {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) return { projects: [], modules: [], areas: [] };
    const questsDir = WsPaths.ai('quests') || path.join(wsRoot, '_ai', 'quests');
    if (!fs.existsSync(questsDir)) return { projects: [], modules: [], areas: [] };
    const projects = new Set<string>();
    const modules = new Set<string>();
    const areas = new Set<string>();
    const questDirs = fs.readdirSync(questsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
    for (const qid of questDirs) {
        try {
            const todos = readAllTodos(qid);
            for (const t of todos) {
                if (t.scope?.project) projects.add(t.scope.project);
                if (t.scope?.projects?.length) {
                    for (const p of t.scope.projects) {
                        if (p) projects.add(p);
                    }
                }
                if (t.scope?.module) modules.add(t.scope.module);
                if (t.scope?.area) areas.add(t.scope.area);
            }
        } catch { /* skip */ }
    }
    return {
        projects: [...projects].sort(),
        modules: [...modules].sort(),
        areas: [...areas].sort(),
    };
}
