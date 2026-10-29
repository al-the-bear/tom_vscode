/**
 * Brings every quest under `_ai` to the current file formats, in one run.
 *
 * A window migrates its own quest's storage the first time it runs a build
 * that knows the new layout (sessionStorage.ts), and only once per machine (a
 * machine-local marker). Quests no window opens stay on the old layout, and a
 * file a window of an older build wrote after the marker, or a reconcile
 * brought from another machine, is never picked up. This walks every quest,
 * whatever the marker says, and with `apply: false` lists what it would do.
 *
 * Steps, per quest:
 *   - storage: the per-quest history files, the Anthropic trail pair, the
 *     quest's live trail, the raw Anthropic trail and flat quest memory move
 *     into the `default` session (rules: sessionStorage.ts). A file the session
 *     already has is merged with the reconcile's merge driver (`merge`); a
 *     machine-local scratch file keeps the newer copy; a tool result whose
 *     number is taken gets the next free one. The raw trail's `current_prompt.*`
 *     files are deleted (written per session now); `last_request*` stays.
 *   - sessions: a record stored as `fork-from-base` becomes `per-prompt`.
 *   - legacy config: `quest-refresh.yaml` / `quest-refresh.<host>.<quest>.yaml`
 *     fold into that host's `extension_config.<host>.<quest>.yaml`
 *     (`questRefresh`, when absent) and are removed.
 *   - todos: `user_action: true` where the tag `user-action` says so.
 * And once for the workspace:
 *   - the legacy `mcpServer` block of `.tom/tom_vscode_extension.json` folds
 *     into each quest's existing `extension_config.<quest>.yaml` that has no
 *     `mcpServer` section (as the extension does when a window opens), and is
 *     removed;
 *   - `blocking` (the reverse of `blocked_by`) is filled on every live todo.
 *
 * Idempotent: a second run lists nothing. vscode-free; the merge drivers are
 * passed in (scripts/migrate-ai-formats.cjs runs the ones git has registered).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, isMap, isSeq, parseDocument, YAMLMap } from 'yaml';

import {
    MIGRATION_MARKER_FILE,
    MIGRATION_TARGET_SESSION,
    SESSIONS_FOLDER,
    SESSION_LIVE_TRAIL_FILE,
    SESSION_TRAIL_FOLDER,
    STORAGE_VERSION,
    TOOL_RESULTS_FOLDER,
    isLegacyHistoryFile,
    nextFreeToolResultIndex,
    sessionMemoryFolder,
    sessionRoot,
} from '../services/sessionStorage';
import { expectedBlocking, sameRefs } from './todoBlocking';
import { liveQuestTodoFiles, relationsOfText, setBlocking } from './todoBlockingSync';

/** The reconcile's merge drivers (al_the_bear `.claude/skills/_lib/merge_drivers/`). */
export type MergeDriver = 'ai-trail' | 'ai-history-json' | 'ai-history-md' | 'ai-block-history';

export interface FormatMigrationOptions {
    /** The `_ai` folder. */
    aiRoot: string;
    /** This machine's host slug (the `<host>` of `extension_config.<host>.<quest>.yaml`). */
    hostSlug: string;
    /** false: list the changes, write nothing. */
    apply: boolean;
    /** Merge `legacy` into `target` the way a reconcile merges; the merged text, or undefined when it failed. */
    merge: (driver: MergeDriver, target: string, legacy: string) => string | undefined;
    /** The workspace config holding the legacy `mcpServer` block (`.tom/tom_vscode_extension.json`). */
    workspaceConfigPath?: string;
    /** Only these quests (default: every folder under `quests/`). The workspace-wide steps still run. */
    quests?: string[];
}

export interface FormatChange {
    /** The quest, or `(workspace)`. */
    quest: string;
    step: 'storage' | 'sessions' | 'legacy-config' | 'mcpServer' | 'blocking' | 'user_action';
    detail: string;
}

export interface FormatMigrationResult {
    changes: FormatChange[];
    /** What could not be migrated and stays as it is. */
    problems: FormatChange[];
}

const SCRATCH_FILES = new Set(['rawTurns.json', 'compaction_rounds.json']);

function driverFor(name: string, quest: string): MergeDriver | undefined {
    if (name === SESSION_LIVE_TRAIL_FILE || name === `${quest}.anthropic.prompts.md` || name === `${quest}.anthropic.answers.md`) { return 'ai-trail'; }
    if (name === 'history.json') { return 'ai-history-json'; }
    if (name === 'history.md') { return 'ai-history-md'; }
    if (name === 'compacted_history.md') { return 'ai-block-history'; }
    return undefined;
}

function list(folder: string): fs.Dirent[] {
    try { return fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
}

/** Every file below `folder`, relative to it. */
function filesBelow(folder: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of list(path.join(folder, rel))) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (e.isDirectory()) { out.push(...filesBelow(folder, r)); } else if (e.isFile()) { out.push(r); }
    }
    return out;
}

function removeEmptyDirs(folder: string): void {
    for (const e of list(folder)) {
        if (e.isDirectory()) { removeEmptyDirs(path.join(folder, e.name)); }
    }
    try { if (fs.readdirSync(folder).length === 0) { fs.rmdirSync(folder); } } catch { /* gone or not empty */ }
}

class Run {
    readonly result: FormatMigrationResult = { changes: [], problems: [] };
    constructor(readonly opts: FormatMigrationOptions) {}

    rel(p: string): string { return path.relative(this.opts.aiRoot, p).split(path.sep).join('/'); }
    change(quest: string, step: FormatChange['step'], detail: string): void { this.result.changes.push({ quest, step, detail }); }
    problem(quest: string, step: FormatChange['step'], detail: string): void { this.result.problems.push({ quest, step, detail }); }

    // ---- storage ----------------------------------------------------------

    /** Move (or merge) one legacy file into its place in the session. Answers whether anything was done. */
    private place(quest: string, from: string, to: string, opts: { tool?: { folder: string; next: Map<string, number> } } = {}): boolean {
        const { apply } = this.opts;
        if (!fs.existsSync(to)) {
            this.change(quest, 'storage', `move ${this.rel(from)} -> ${this.rel(to)}`);
            if (apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); }
            return true;
        }
        const name = path.basename(to);
        if (opts.tool) {
            const folder = opts.tool.folder;
            const n = opts.tool.next.get(folder) ?? nextFreeToolResultIndex(folder);
            opts.tool.next.set(folder, n + 1);
            const renamed = path.join(folder, `t${n}.json`);
            this.change(quest, 'storage', `move ${this.rel(from)} -> ${this.rel(renamed)} (number taken)`);
            if (apply) { fs.renameSync(from, renamed); }
            return true;
        }
        if (fs.readFileSync(from).equals(fs.readFileSync(to))) {
            this.change(quest, 'storage', `remove ${this.rel(from)} (identical to ${this.rel(to)})`);
            if (apply) { fs.unlinkSync(from); }
            return true;
        }
        if (SCRATCH_FILES.has(name)) {
            const legacyNewer = fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs;
            this.change(quest, 'storage', legacyNewer
                ? `replace ${this.rel(to)} with the newer ${this.rel(from)}`
                : `remove ${this.rel(from)} (the session's copy is newer)`);
            if (apply) { if (legacyNewer) { fs.renameSync(from, to); } else { fs.unlinkSync(from); } }
            return true;
        }
        const driver = driverFor(name, quest);
        if (!driver) {
            this.problem(quest, 'storage', `${this.rel(from)}: the session already has ${this.rel(to)} with other content, and no merge rule applies; both kept`);
            return false;
        }
        const merged = this.opts.merge(driver, to, from);
        if (merged === undefined) {
            this.problem(quest, 'storage', `${this.rel(from)}: the ${driver} merge into ${this.rel(to)} failed; both kept`);
            return false;
        }
        this.change(quest, 'storage', `merge ${this.rel(from)} into ${this.rel(to)} (${driver})`);
        if (apply) { fs.writeFileSync(to, merged, 'utf8'); fs.unlinkSync(from); }
        return true;
    }

    storage(quest: string): void {
        const ai = this.opts.aiRoot;
        const questFolder = path.join(ai, 'quests', quest);
        const historyRoot = path.join(questFolder, 'history');
        const target = sessionRoot(historyRoot, MIGRATION_TARGET_SESSION);
        let touched = false;

        for (const e of list(historyRoot)) {
            if (!e.isFile()) { continue; }
            const isPair = e.name === `${quest}.anthropic.prompts.md` || e.name === `${quest}.anthropic.answers.md`;
            if (isLegacyHistoryFile(e.name) || isPair) {
                touched = this.place(quest, path.join(historyRoot, e.name), path.join(target, e.name)) || touched;
            }
        }
        const liveTrail = path.join(questFolder, SESSION_LIVE_TRAIL_FILE);
        if (fs.existsSync(liveTrail)) {
            touched = this.place(quest, liveTrail, path.join(target, SESSION_LIVE_TRAIL_FILE)) || touched;
        }

        const rawTrail = path.join(ai, 'trail', 'anthropic', quest);
        const next = new Map<string, number>();
        for (const rel of filesBelow(rawTrail)) {
            const from = path.join(rawTrail, rel);
            const top = rel.split(path.sep)[0];
            if (top.startsWith('last_request')) { continue; }
            if (top.startsWith('current_prompt.')) {
                this.change(quest, 'storage', `remove ${this.rel(from)} (the current prompt is written per session)`);
                if (this.opts.apply) { fs.unlinkSync(from); }
                touched = true;
                continue;
            }
            const to = path.join(target, SESSION_TRAIL_FOLDER, rel);
            const inToolResults = top === TOOL_RESULTS_FOLDER;
            touched = this.place(quest, from, to, inToolResults ? { tool: { folder: path.dirname(to), next } } : {}) || touched;
        }
        if (this.opts.apply) { removeEmptyDirs(rawTrail); }

        const flatMemory = path.join(ai, 'memory', quest);
        for (const e of list(flatMemory)) {
            if (e.isFile() && e.name.endsWith('.md')) {
                const to = path.join(sessionMemoryFolder(path.join(ai, 'memory'), quest, MIGRATION_TARGET_SESSION), e.name);
                touched = this.place(quest, path.join(flatMemory, e.name), to) || touched;
            }
        }

        const marker = path.join(historyRoot, SESSIONS_FOLDER, MIGRATION_MARKER_FILE);
        if (touched && this.opts.apply && !fs.existsSync(marker)) {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, `${STORAGE_VERSION}\n`);
        }
    }

    // ---- sessions ---------------------------------------------------------

    sessions(quest: string): void {
        const historyRoot = path.join(this.opts.aiRoot, 'quests', quest, 'history');
        for (const e of list(historyRoot)) {
            if (!e.isFile() || !e.name.endsWith('.session.json')) { continue; }
            const file = path.join(historyRoot, e.name);
            let data: Record<string, unknown>;
            try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
                this.problem(quest, 'sessions', `${this.rel(file)} is not readable JSON`);
                continue;
            }
            if (data.mode !== 'fork-from-base') { continue; }
            this.change(quest, 'sessions', `${this.rel(file)}: mode fork-from-base -> per-prompt`);
            if (this.opts.apply) {
                data.mode = 'per-prompt';
                fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
            }
        }
    }

    // ---- legacy config ----------------------------------------------------

    /** Write `section` into a YAML config file (created when missing) unless it is there; answers whether it was absent. */
    private foldSection(file: string, section: string, value: unknown): boolean {
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const parsed = parseDocument(text);
        if (parsed.has(section)) { return false; }
        if (this.opts.apply) {
            // An empty or non-map file starts as a fresh map document.
            const doc = isMap(parsed.contents) ? parsed : new Document({});
            doc.set(section, doc.createNode(value));
            fs.writeFileSync(file, doc.toString(), 'utf8');
        }
        return true;
    }

    legacyConfig(quest: string): void {
        const folder = path.join(this.opts.aiRoot, 'quests', quest);
        for (const e of list(folder)) {
            if (!e.isFile()) { continue; }
            const m = /^quest-refresh(?:\.([^.]+)\.(.+))?\.yaml$/.exec(e.name);
            if (!m || (m[2] !== undefined && m[2] !== quest)) { continue; }
            const host = m[1] ?? this.opts.hostSlug;
            const file = path.join(folder, e.name);
            const legacy = parseDocument(fs.readFileSync(file, 'utf8')).toJS() as { panels?: unknown } | null;
            const target = path.join(folder, `extension_config.${host}.${quest}.yaml`);
            if (legacy && legacy.panels && this.foldSection(target, 'questRefresh', { panels: legacy.panels })) {
                this.change(quest, 'legacy-config', `fold ${this.rel(file)} into ${this.rel(target)} (questRefresh)`);
            }
            this.change(quest, 'legacy-config', `remove ${this.rel(file)}`);
            if (this.opts.apply) { fs.unlinkSync(file); }
        }
    }

    // ---- todos ------------------------------------------------------------

    /** Every live todo file of the quests walked, with its doc and the edits to make. */
    todos(quests: string[]): void {
        const questsRoot = path.join(this.opts.aiRoot, 'quests');
        const files = liveQuestTodoFiles(questsRoot);
        const records = files.flatMap((f) => relationsOfText(f, fs.readFileSync(f, 'utf8'), questsRoot));
        const walked = new Set(quests);
        for (const file of files) {
            const quest = path.basename(path.dirname(file));
            const doc = parseDocument(fs.readFileSync(file, 'utf8'));
            const todos = doc.get('todos', true);
            if (!isSeq(todos)) { continue; }
            let edited = false;
            for (const node of todos.items) {
                if (!isMap(node)) { continue; }
                const id = node.get('id');
                if (typeof id !== 'string') { continue; }
                // blocking: corpus-wide, whatever quests were asked for (a blocker may live anywhere).
                const have = node.get('blocking');
                const haveList = isSeq(have) ? have.items.map((i) => String((i as { value?: unknown }).value ?? i)) : [];
                const want = expectedBlocking({ scopeKey: `quest:${quest}`, id }, records);
                if (!sameRefs(haveList, want)) {
                    this.change(quest, 'blocking', `${this.rel(file)}: ${id} blocking ${JSON.stringify(want)}`);
                    setBlocking(doc, node as YAMLMap, want);
                    edited = true;
                }
                if (!walked.has(quest)) { continue; }
                const tags = node.get('tags');
                const tagged = isSeq(tags) && tags.items.some((t) => String((t as { value?: unknown }).value ?? t) === 'user-action');
                if (tagged && node.get('user_action') !== true) {
                    this.change(quest, 'user_action', `${this.rel(file)}: ${id} user_action: true (tagged user-action)`);
                    node.set('user_action', true);
                    edited = true;
                }
            }
            if (edited && this.opts.apply) { fs.writeFileSync(file, doc.toString(), 'utf8'); }
        }
    }

    // ---- workspace config -------------------------------------------------

    mcpServer(quests: string[]): void {
        const cfgPath = this.opts.workspaceConfigPath;
        if (!cfgPath || !fs.existsSync(cfgPath)) { return; }
        const raw = fs.readFileSync(cfgPath, 'utf8');
        let cfg: Record<string, unknown>;
        try { cfg = JSON.parse(raw); } catch {
            this.problem('(workspace)', 'mcpServer', `${cfgPath} is not readable JSON`);
            return;
        }
        const legacy = cfg.mcpServer;
        if (!legacy || typeof legacy !== 'object') { return; }
        const settings = { ...(legacy as Record<string, unknown>) };
        delete settings.autoStart;
        delete settings.autostart;
        for (const quest of quests) {
            const file = path.join(this.opts.aiRoot, 'quests', quest, `extension_config.${quest}.yaml`);
            if (!fs.existsSync(file)) { continue; }
            if (this.foldSection(file, 'mcpServer', settings)) {
                this.change(quest, 'mcpServer', `fold the legacy mcpServer block into ${this.rel(file)}`);
            }
        }
        this.change('(workspace)', 'mcpServer', `remove the legacy mcpServer block from ${cfgPath}`);
        if (this.opts.apply) {
            delete cfg.mcpServer;
            const indent = /^\{\r?\n(\s+)"/.exec(raw)?.[1] ?? '    ';
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
        }
    }
}

/** Run the migration (or, with `apply: false`, list it). */
export function migrateAiFormats(opts: FormatMigrationOptions): FormatMigrationResult {
    const run = new Run(opts);
    const questsRoot = path.join(opts.aiRoot, 'quests');
    const all = list(questsRoot).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const quests = opts.quests ? all.filter((q) => opts.quests!.includes(q)) : all;
    for (const quest of quests) {
        run.storage(quest);
        run.sessions(quest);
        run.legacyConfig(quest);
    }
    run.mcpServer(all);
    run.todos(quests);
    return run.result;
}
