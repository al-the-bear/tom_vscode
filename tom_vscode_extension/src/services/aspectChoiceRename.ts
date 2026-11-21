/**
 * The stored guideline choices carried over a section or option rename
 * (gsel7b): every level this machine can reach, rewritten in its file.
 *
 * - quest default — `aspectGuidelines` of every quest's shared
 *   `extension_config.<quest>.yaml`;
 * - window and the @CHAT panels' choices — `aspectGuidelines.window` /
 *   `aspectGuidelines.chat.*` of every quest's per-host
 *   `extension_config.<host>.<quest>.yaml` (every host's: the renamed folder
 *   reaches them through git too, and their choices stay in effect there);
 * - runs — `guidelines` of every run in the queue folder's `queue-settings.yaml`;
 * - queue items — every `*.queue.yaml` of the queue folder (entries, templates,
 *   inbox items);
 * - todos — every `*.todo.yaml` under every quest folder (the session todos and
 *   the `-archived` / `-deleted` siblings included, so a restored todo keeps
 *   its choice);
 * - roles and role types — `_ai/roles/<role>/role-config.yaml`,
 *   `_ai/role-types/<type>/role-type.yaml`.
 *
 * Only files that name the old id are parsed and only changed ones written,
 * through the YAML document API (comments and order kept). What the open
 * windows hold in memory (their queue items and run settings) is the caller's:
 * handlers/aspectChoiceCommands.ts carryAspectChoicesOver.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isMap, parseDocument, type Document } from 'yaml';

import { renameInGuidelinesNodes, renameInYamlChoiceMap, type AspectRename } from '../utils/aspectRename';

/** The level a rewritten choice belongs to. */
export type AspectRenameLevel = 'questDefault' | 'window' | 'chat' | 'run' | 'item' | 'todo' | 'role' | 'roleType';

/** One file rewritten: its level, the file, how many choice maps changed. */
export interface AspectRenameChange { level: AspectRenameLevel; file: string; count: number }

/** What a rewrite did: the files changed, and the files that could not be read or written. */
export interface AspectRenameResult { changes: AspectRenameChange[]; failed: Array<{ file: string; reason: string }> }

/** Where the levels are: the `_ai` folder, and the queue folder (default `_ai/queue`). */
export interface AspectRenameScope { aiRoot: string; queueFolder?: string }

const LEVEL_LABELS: Record<AspectRenameLevel, [string, string]> = {
    questDefault: ['quest default', 'quest defaults'],
    window: ['window', 'windows'],
    chat: ['@CHAT panel', '@CHAT panels'],
    run: ['run', 'runs'],
    item: ['queue item', 'queue items'],
    todo: ['todo', 'todos'],
    role: ['role', 'roles'],
    roleType: ['role type', 'role types'],
};

/** The order levels are listed in. */
const LEVEL_ORDER: AspectRenameLevel[] = ['questDefault', 'window', 'chat', 'run', 'item', 'todo', 'role', 'roleType'];

const SKIP_DIRS = new Set(['node_modules']);

function listDir(dir: string): fs.Dirent[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Every `*.todo.yaml` below `dir` (dot folders and node_modules skipped). */
function todoFilesBelow(dir: string, into: string[]): void {
    for (const e of listDir(dir)) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) { continue; }
        const file = path.join(dir, e.name);
        if (e.isDirectory()) { todoFilesBelow(file, into); } else if (e.isFile() && e.name.endsWith('.todo.yaml')) { into.push(file); }
    }
}

/** The text the old name has to appear in for a file to be worth parsing. */
function needleOf(rename: AspectRename): string {
    return rename.kind === 'section' ? rename.from : rename.section;
}

/**
 * Rewrite one file: `apply` changes the parsed document and answers the choice
 * maps it changed per level; the file is written only when something changed.
 */
function rewriteFile(
    file: string,
    rename: AspectRename,
    apply: (doc: Document) => Partial<Record<AspectRenameLevel, number>>,
    result: AspectRenameResult,
    lineWidth?: number,
): void {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (!text.includes(needleOf(rename)) || !text.includes('uidelines')) { return; }
    const doc = parseDocument(text);
    if (doc.errors.length) { result.failed.push({ file, reason: doc.errors[0].message.split('\n')[0] }); return; }
    const counts = apply(doc);
    const changed = Object.entries(counts).filter(([, n]) => (n ?? 0) > 0) as Array<[AspectRenameLevel, number]>;
    if (!changed.length) { return; }
    try {
        fs.writeFileSync(file, lineWidth ? doc.toString({ lineWidth }) : doc.toString(), 'utf8');
    } catch (e) {
        result.failed.push({ file, reason: (e as Error).message });
        return;
    }
    for (const [level, count] of changed) { result.changes.push({ level, file, count }); }
}

/** `aspectGuidelines` of an extension config file: flat (the shared file) or `{window, chat}` (a per-host file). */
function rewriteExtensionConfig(file: string, shared: boolean, rename: AspectRename, result: AspectRenameResult): void {
    rewriteFile(file, rename, (doc) => {
        const node = doc.get('aspectGuidelines', true);
        if (!isMap(node)) { return {}; }
        if (shared) { return { questDefault: renameInYamlChoiceMap(node, rename) ? 1 : 0 }; }
        const window = node.get('window', true);
        const chat = node.get('chat', true);
        let chats = 0;
        if (isMap(chat)) {
            for (const pair of chat.items) { if (isMap(pair.value) && renameInYamlChoiceMap(pair.value, rename)) { chats++; } }
        }
        return { window: isMap(window) && renameInYamlChoiceMap(window, rename) ? 1 : 0, chat: chats };
    }, result);
}

/** Rewrite the stored choices of every level under `scope` that name the renamed section or options. */
export function rewriteStoredAspectChoices(scope: AspectRenameScope, rename: AspectRename): AspectRenameResult {
    const result: AspectRenameResult = { changes: [], failed: [] };
    const ai = scope.aiRoot;
    const generic = (level: AspectRenameLevel, lineWidth?: number) => (file: string): void =>
        rewriteFile(file, rename, (doc) => ({ [level]: renameInGuidelinesNodes(doc, rename) }), result, lineWidth);

    // Quests: the two extension config files, the todo files (sessions and terminal siblings included).
    for (const quest of listDir(path.join(ai, 'quests'))) {
        if (!quest.isDirectory() || quest.name.startsWith('.')) { continue; }
        const folder = path.join(ai, 'quests', quest.name);
        for (const e of listDir(folder)) {
            const m = /^extension_config\.(.+)\.yaml$/.exec(e.name);
            if (e.isFile() && m) { rewriteExtensionConfig(path.join(folder, e.name), m[1] === quest.name, rename, result); }
        }
        const todos: string[] = [];
        todoFilesBelow(folder, todos);
        todos.sort().forEach(generic('todo'));
    }

    // Roles and role types.
    for (const role of listDir(path.join(ai, 'roles'))) {
        if (role.isDirectory()) { generic('role')(path.join(ai, 'roles', role.name, 'role-config.yaml')); }
    }
    for (const type of listDir(path.join(ai, 'role-types'))) {
        if (type.isDirectory()) { generic('roleType')(path.join(ai, 'role-types', type.name, 'role-type.yaml')); }
    }

    // The queue folder: the runs' settings, every entry, template and inbox item.
    const queue = scope.queueFolder ?? path.join(ai, 'queue');
    generic('run')(path.join(queue, 'queue-settings.yaml'));
    listDir(queue)
        .filter((e) => e.isFile() && e.name.endsWith('.queue.yaml'))
        .map((e) => path.join(queue, e.name))
        .sort()
        .forEach(generic('item', 120));
    return result;
}

/**
 * How many choice maps changed per level: the rewrite's, plus `extra` — what
 * this window changed in memory and wrote itself before the rewrite ran (those
 * files no longer name the old id, so the rewrite does not count them again).
 */
export function aspectRenameCounts(result: AspectRenameResult, extra?: Partial<Record<AspectRenameLevel, number>>): Partial<Record<AspectRenameLevel, number>> {
    const counts: Partial<Record<AspectRenameLevel, number>> = {};
    for (const c of result.changes) { counts[c.level] = (counts[c.level] ?? 0) + c.count; }
    for (const [level, n] of Object.entries(extra ?? {}) as Array<[AspectRenameLevel, number]>) {
        if (n > 0) { counts[level] = (counts[level] ?? 0) + n; }
    }
    return counts;
}

/**
 * What was rewritten, in one sentence: `Choices carried over: quest default 1,
 * runs 2, todos 3 (5 files).`, or that none named it; files that failed are named.
 */
export function aspectRenameSummary(result: AspectRenameResult, extra?: Partial<Record<AspectRenameLevel, number>>): string {
    const counts = aspectRenameCounts(result, extra);
    const parts = LEVEL_ORDER.filter((l) => (counts[l] ?? 0) > 0).map((l) => `${LEVEL_LABELS[l][counts[l] === 1 ? 0 : 1]} ${counts[l]}`);
    const files = new Set(result.changes.map((c) => c.file)).size;
    const done = parts.length
        ? `Choices carried over: ${parts.join(', ')}${files ? ` (${files} file${files === 1 ? '' : 's'})` : ''}.`
        : 'No stored choice named it.';
    const failed = result.failed.length
        ? ` Not rewritten: ${result.failed.map((f) => `${path.basename(f.file)} (${f.reason})`).join('; ')}.`
        : '';
    return done + failed;
}
