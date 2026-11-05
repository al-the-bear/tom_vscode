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
 *   - process state: a `process-state.<quest>.yaml` holding one position at
 *     its top becomes a stack of that one level (processDefinition.ts,
 *     ProcessStateStack); its `updated` time stays. Format version 2.
 * And once for the workspace:
 *   - the legacy `mcpServer` block of `.tom/tom_vscode_extension.json` folds
 *     into each quest's existing `extension_config.<quest>.yaml` that has no
 *     `mcpServer` section (as the extension does when a window opens), and is
 *     removed;
 *   - `blocking` (the reverse of `blocked_by`) is filled on every live todo;
 *   - the Anthropic profiles of that config: `thinkingEnabled` /
 *     `thinkingBudgetTokens` become `thinking` / `legacyThinkingBudgetTokens`
 *     (thinkingAndEffort.ts). Format version 3;
 *   - the user-message template `explain-and-ask` becomes Explain TODO
 *     (`explain-todo`, explainTodoTemplate.ts), and every setting naming the
 *     old id names the new one — in that config and in the user-global
 *     overlay (`userConfigPath`). Format version 4;
 *   - the removed panels (localLlmProfileMigration.ts): every
 *     `localLlm.profiles` entry becomes an Anthropic profile `local-<key>` on
 *     its Local LLM configuration and the block goes; and, when the files come
 *     from a format version below 5, what only those panels wrote is deleted.
 *     Format version 5;
 *   - `copilot.templates` and `copilot.defaultTemplate` are removed from that
 *     config and the user overlay, nothing of them copied; only an own Answer
 *     Wrapper becomes `copilot.queueWrapper` (copilotTemplates.ts). Format
 *     version 6;
 *   - last, when nothing is left as a problem: `_ai/format-version.yaml` gets
 *     the format version this build migrated to and the date
 *     (aiFormatVersion.ts). A stamp newer than this build is a problem and is
 *     left as it is.
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
import { migrateProfileThinkingKeys } from './thinkingAndEffort';
import { renameExplainTemplate } from './explainTodoTemplate';
import { dropCopilotTemplates } from './copilotTemplates';
import { defaultLocalLlmConfigId, dropRemovedPanelSections, localLlmProfileToAnthropic, removedPanelPaths, REMOVED_PANELS_FORMAT_VERSION, type LocalLlmProfileEntry } from './localLlmProfileMigration';
import { isFlatProcessStateText, parseProcessStateStack, processStateUpdated, stringifyProcessStateStack } from './processDefinition';
import { AI_FORMAT_FILE, AI_FORMAT_VERSION, localDate, readAiFormatStamp, writeAiFormatStamp } from './aiFormatVersion';
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
    /** The user-global overlay (`~/.tom/vscode/tom_vscode_extension.user.yaml`), when it exists. */
    userConfigPath?: string;
    /** The format version to stamp (default AI_FORMAT_VERSION; tests). */
    formatVersion?: number;
    /** Today, for the stamp (default the local date; tests). */
    today?: string;
}

export interface FormatChange {
    /** The quest, or `(workspace)`. */
    quest: string;
    step: 'storage' | 'sessions' | 'legacy-config' | 'mcpServer' | 'blocking' | 'user_action' | 'process-state' | 'profiles' | 'templates' | 'copilot-templates' | 'local-llm-profiles' | 'removed-panels' | 'format-version';
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

    /** Every `localLlm.profiles` entry as an Anthropic profile on its Local LLM configuration; the block removed. */
    localLlmProfiles(): void {
        const cfgPath = this.opts.workspaceConfigPath;
        if (!cfgPath || !fs.existsSync(cfgPath)) { return; }
        const raw = fs.readFileSync(cfgPath, 'utf8');
        let cfg: { anthropic?: { profiles?: Array<Record<string, unknown>> }; localLlm?: { profiles?: Record<string, LocalLlmProfileEntry>; configurations?: unknown } };
        try { cfg = JSON.parse(raw); } catch {
            this.problem('(workspace)', 'local-llm-profiles', `${cfgPath} is not readable JSON`);
            return;
        }
        const locals = cfg.localLlm?.profiles;
        if (!locals || typeof locals !== 'object') { return; }
        const configIds = new Set(Array.isArray(cfg.localLlm?.configurations) ? (cfg.localLlm!.configurations as Array<{ id?: unknown }>).map((c) => c?.id) : []);
        const fallback = defaultLocalLlmConfigId(cfg.localLlm?.configurations);
        const anthropic = (cfg.anthropic ??= {});
        const profiles = (anthropic.profiles ??= []);
        const taken = new Set(profiles.map((p) => p.id));
        for (const [key, entry] of Object.entries(locals)) {
            const named = typeof entry?.modelConfig === 'string' && entry.modelConfig ? entry.modelConfig : undefined;
            const configId = named && configIds.has(named) ? named : fallback;
            if (!configId) {
                this.problem('(workspace)', 'local-llm-profiles', `Local LLM profile ${key}: no Local LLM configuration to put it on`);
                return;
            }
            const { profile, dropped } = localLlmProfileToAnthropic(key, entry ?? {}, configId);
            if (taken.has(profile.id)) {
                this.change('(workspace)', 'local-llm-profiles', `Local LLM profile ${key}: Anthropic profile ${String(profile.id)} already there, kept`);
                continue;
            }
            taken.add(profile.id);
            profiles.push(profile);
            const note = named && named !== configId ? ` (its configuration ${named} no longer exists)` : '';
            this.change('(workspace)', 'local-llm-profiles', `Local LLM profile ${key} -> Anthropic profile ${String(profile.id)} on ${configId}${note}${dropped.length ? `; dropped: ${dropped.join(', ')}` : ''}`);
        }
        delete cfg.localLlm!.profiles;
        this.change('(workspace)', 'local-llm-profiles', 'remove the localLlm.profiles block');
        this.write(cfgPath, raw, cfg);
    }

    /** The removed panels' config sections: tomAiChat, aiConversation (but telegram), localLlm.expansionProfile. */
    removedPanelConfig(): void {
        const cfgPath = this.opts.workspaceConfigPath;
        if (!cfgPath || !fs.existsSync(cfgPath)) { return; }
        const raw = fs.readFileSync(cfgPath, 'utf8');
        let cfg: Record<string, unknown>;
        try { cfg = JSON.parse(raw); } catch {
            this.problem('(workspace)', 'removed-panels', `${cfgPath} is not readable JSON`);
            return;
        }
        const removed = dropRemovedPanelSections(cfg);
        if (removed.length === 0) { return; }
        this.change('(workspace)', 'removed-panels', `remove the removed panels' config: ${removed.join(', ')}`);
        this.write(cfgPath, raw, cfg);
    }

    /** Write `cfg` over the JSON file `cfgPath` held `raw`, in its indent (when applying). */
    write(cfgPath: string, raw: string, cfg: unknown): void {
        if (this.opts.apply) {
            const indent = /^\{\r?\n(\s+)"/.exec(raw)?.[1] ?? '    ';
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
        }
    }

    /** Delete what only the removed panels wrote (format version < 5 only). */
    removedPanels(quests: string[]): void {
        for (const p of removedPanelPaths(this.opts.aiRoot, quests)) {
            const dir = fs.statSync(p).isDirectory();
            this.change(dir ? '(workspace)' : this.questOf(p), 'removed-panels', `delete ${this.rel(p)}${dir ? '/' : ''}`);
            if (this.opts.apply) { fs.rmSync(p, { recursive: true, force: true }); }
        }
    }

    /** The quest a path under `quests/<quest>/` belongs to, else `(workspace)`. */
    questOf(p: string): string {
        const parts = this.rel(p).split('/');
        return parts[0] === 'quests' && parts[1] ? parts[1] : '(workspace)';
    }

    /**
     * Run `edit` over the workspace config and the user overlay (JSON or
     * YAML); a file `edit` changed (answering what it did, and the config to
     * write) is written back.
     */
    editConfigFiles(step: FormatChange['step'], edit: (config: unknown) => { config: unknown; done: string[] }): void {
        for (const file of [this.opts.workspaceConfigPath, this.opts.userConfigPath]) {
            if (!file || !fs.existsSync(file)) { continue; }
            const raw = fs.readFileSync(file, 'utf8');
            const isYaml = /\.ya?ml$/i.test(file);
            let parsed: unknown;
            try { parsed = isYaml ? parseDocument(raw).toJS() : JSON.parse(raw); } catch {
                this.problem('(workspace)', step, `${file} is not readable`);
                continue;
            }
            const { config, done } = edit(parsed);
            if (done.length === 0) { continue; }
            for (const d of done) { this.change('(workspace)', step, `${file}: ${d}`); }
            if (!this.opts.apply) { continue; }
            if (isYaml) {
                fs.writeFileSync(file, new Document(config).toString(), 'utf8');
            } else {
                const indent = /^\{\r?\n(\s+)"/.exec(raw)?.[1] ?? '    ';
                fs.writeFileSync(file, JSON.stringify(config, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
            }
        }
    }

    /** The Explain-then-ask template as Explain TODO, in the workspace config and the user overlay. */
    templates(): void {
        this.editConfigFiles('templates', (parsed) => {
            const { config, changed } = renameExplainTemplate(parsed);
            return { config, done: changed === 0 ? [] : [`explain-and-ask as explain-todo (Explain TODO), ${changed} place(s)`] };
        });
    }

    /** `copilot.templates` and `copilot.defaultTemplate` removed; an own Answer Wrapper kept as `copilot.queueWrapper`. */
    copilotTemplates(): void {
        this.editConfigFiles('copilot-templates', (parsed) => ({ config: parsed, done: dropCopilotTemplates(parsed) }));
    }

    /** The workspace config's Anthropic profiles in the current thinking keys. */
    profiles(): void {
        const cfgPath = this.opts.workspaceConfigPath;
        if (!cfgPath || !fs.existsSync(cfgPath)) { return; }
        const raw = fs.readFileSync(cfgPath, 'utf8');
        let cfg: { anthropic?: { profiles?: unknown[] } } & Record<string, unknown>;
        try { cfg = JSON.parse(raw); } catch {
            this.problem('(workspace)', 'profiles', `${cfgPath} is not readable JSON`);
            return;
        }
        const profiles = cfg.anthropic?.profiles;
        if (!Array.isArray(profiles)) { return; }
        let changed = false;
        profiles.forEach((profile, i) => {
            if (!profile || typeof profile !== 'object') { return; }
            const next = migrateProfileThinkingKeys(profile as Record<string, unknown>);
            if (!next) { return; }
            changed = true;
            profiles[i] = next;
            this.change('(workspace)', 'profiles', `profile ${(profile as { id?: string }).id ?? i}: thinkingEnabled / thinkingBudgetTokens as thinking / legacyThinkingBudgetTokens`);
        });
        if (changed && this.opts.apply) {
            const indent = /^\{\r?\n(\s+)"/.exec(raw)?.[1] ?? '    ';
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
        }
    }

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

/** A quest's flat process-state file as a stack of its one level. */
function processStateStack(opts: FormatMigrationOptions, run: Run, quest: string): void {
    const file = path.join(opts.aiRoot, 'quests', quest, `process-state.${quest}.yaml`);
    if (!fs.existsSync(file)) { return; }
    const text = fs.readFileSync(file, 'utf8');
    if (!isFlatProcessStateText(text)) { return; }
    run.change(quest, 'process-state', `process-state.${quest}.yaml: the position as the one level of a stack`);
    if (opts.apply) {
        const updated = processStateUpdated(text) || new Date().toISOString();
        fs.writeFileSync(file, stringifyProcessStateStack(parseProcessStateStack(text), updated), 'utf8');
    }
}

/**
 * The format-version stamp, written last and only when every step could be
 * done: the stamp says the files ARE in that format. A stamp of a newer build
 * stays, as a problem — this build cannot say what that format needs.
 */
function stampFormatVersion(opts: FormatMigrationOptions, run: Run): void {
    const version = opts.formatVersion ?? AI_FORMAT_VERSION;
    const stamp = readAiFormatStamp(opts.aiRoot);
    if (stamp && stamp.version > version) {
        run.problem('(workspace)', 'format-version', `${AI_FORMAT_FILE} says version ${stamp.version}, newer than this build's ${version}: migrate with the newer build`);
        return;
    }
    if (stamp && stamp.version === version) { return; }
    if (run.result.problems.length > 0) {
        run.problem('(workspace)', 'format-version', `${AI_FORMAT_FILE} not written: the problems above remain`);
        return;
    }
    run.change('(workspace)', 'format-version', `write ${AI_FORMAT_FILE}: version ${version}${stamp ? ` (was ${stamp.version})` : ''}`);
    if (opts.apply) { writeAiFormatStamp(opts.aiRoot, { version, date: opts.today ?? localDate() }); }
}

/** Run the migration (or, with `apply: false`, list it). */
export function migrateAiFormats(opts: FormatMigrationOptions): FormatMigrationResult {
    const run = new Run(opts);
    // Read before anything is written: the stamp decides whether the removed
    // panels' files are still to be deleted (below version 5 only).
    const prior = readAiFormatStamp(opts.aiRoot);
    const deletePanelFiles = !prior || prior.version < REMOVED_PANELS_FORMAT_VERSION;
    const questsRoot = path.join(opts.aiRoot, 'quests');
    const all = list(questsRoot).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const quests = opts.quests ? all.filter((q) => opts.quests!.includes(q)) : all;
    for (const quest of quests) {
        run.storage(quest);
        run.sessions(quest);
        run.legacyConfig(quest);
        processStateStack(opts, run, quest);
    }
    run.mcpServer(all);
    run.profiles();
    run.templates();
    run.copilotTemplates();
    run.localLlmProfiles();
    run.removedPanelConfig();
    if (deletePanelFiles) { run.removedPanels(all); }
    run.todos(quests);
    stampFormatVersion(opts, run);
    return run.result;
}
