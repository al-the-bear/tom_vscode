/**
 * The `default` run runs no process (vscimpb122): the `_ai` format migration
 * moves a process a quest still follows on `default` into a run of its own
 * (format version 9, aiFormatMigration.ts). Per quest whose
 * `process-state.<quest>.yaml` names a process:
 *
 *   - a new run named after the process (`idea_to_todos`, `idea_to_todos-2`
 *     when taken) gets the whole state stack — levels, iterations, skipped,
 *     jumps, origins — as the file holds it;
 *   - the `default` state is left with no process, and records the run it went
 *     to (`movedTo`), so a window that works on `default` switches to it once
 *     (ProcessStateStore);
 *   - the default run's custom chat variables the process uses go to the new
 *     run's set, in every chat-variable file of the quest
 *     (`<quest>.<host>.chatvariable.yaml` → `<quest>.<host>.<run>.chatvariable.yaml`):
 *     its declared `runParameters`, `process-subject`, and every variable its
 *     definition or the prompts it includes (`${file-…}`) name;
 *   - the named sessions the process uses (its `session:` entries) become the
 *     run's (`<session>@<run>`, runSessions.ts): the session file, its storage
 *     folder and its quest memory are renamed, a `basedOn` naming one of them
 *     follows, so the conversations go on; `default` and `chat` stay shared;
 *   - the default run's staged / pending queue items of the process (a Proceed's
 *     prompt and marker, a process item, an item in one of its sessions) move
 *     to the new run, their sessions renamed;
 *   - the quest's Q&A journal records the move.
 *
 * Idempotent: a `default` without a process is left alone. vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml, parseDocument, stringify } from 'yaml';

import { EMPTY_PROCESS_STATE, PROCESS_SUBJECT_VARIABLE, parseProcessStateStack, parseProcessYaml, type ProcessDefinition, type ProcessSessionSpec } from './processDefinition';
import { runStateFileName } from './processRuns';
import { runSessionName } from './runSessions';
import { appendQaBlocks, processDecisionBlock } from './qaJournal';
import { hostSlugOf } from './hostSlug';

/** What one quest's move did (for the migration's listing and the tests). */
export interface DefaultRunMove {
    quest: string;
    process: string;
    run: string;
    variables: string[];
    sessions: Array<{ from: string; to: string }>;
    queueItems: string[];
}

export interface DefaultRunMigrationContext {
    /** The `_ai` folder. */
    aiRoot: string;
    quest: string;
    /** false: list the move, write nothing. */
    apply: boolean;
    /** The time recorded (journal, `updated`); default now. */
    now?: Date;
    change(detail: string): void;
    problem(detail: string): void;
}

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A run name for process `id`: the id itself when it is one, else its letters, digits, `_` and `-`. */
export function runNameForProcess(id: string): string {
    if (RUN_NAME.test(id) && id !== 'default') { return id; }
    const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60);
    return cleaned && cleaned !== 'default' ? cleaned : 'process';
}

/** The first of `base`, `base-2`, `base-3`, … that `taken` does not hold. */
export function freeRunName(base: string, taken: (run: string) => boolean): string {
    if (!taken(base)) { return base; }
    for (let n = 2; ; n++) {
        const name = `${base.slice(0, 60)}-${n}`;
        if (!taken(name)) { return name; }
    }
}

function specName(spec: ProcessSessionSpec | undefined): { name?: string; basedOn?: string } {
    if (!spec) { return {}; }
    return typeof spec === 'string' ? { name: spec } : { name: spec.name, basedOn: spec.basedOn };
}

/** The literal session names a definition names (process, phases, steps, sub-steps; a based-on session too). */
export function processSessionNames(def: ProcessDefinition): string[] {
    const names = new Set<string>();
    const add = (spec: ProcessSessionSpec | undefined): void => {
        const { name, basedOn } = specName(spec);
        for (const n of [name, basedOn]) {
            if (n && !n.includes('${') && n !== 'default' && n !== 'chat') { names.add(n); }
        }
    };
    add(def.session);
    for (const phase of def.phases) {
        add(phase.session);
        for (const step of [...phase.steps, ...(phase.gate ? [phase.gate] : []), ...(phase.postGate ? [phase.postGate] : [])]) {
            add(step.session);
            for (const sub of step.substeps ?? []) { add(sub.session); }
        }
    }
    return [...names].sort();
}

const VARIABLE_REF = /\$\{\s*(?:custom\.)?([A-Za-z][A-Za-z0-9_-]*)\s*\}/g;
const FILE_REF = /\$\{file-([^}]+)\}/g;

/** The chat variables a process's text names: its definition and the prompt files it includes. */
export function processVariableNames(aiRoot: string, definitionText: string): Set<string> {
    const names = new Set<string>();
    const scan = (text: string): void => { for (const m of text.matchAll(VARIABLE_REF)) { names.add(m[1]); } };
    scan(definitionText);
    const workspace = path.dirname(aiRoot);
    for (const m of definitionText.matchAll(FILE_REF)) {
        const rel = m[1].trim();
        const file = rel.startsWith('_ai/') ? path.join(aiRoot, rel.slice(4)) : path.join(workspace, rel);
        try { scan(fs.readFileSync(file, 'utf8')); } catch { /* an include that is not there names nothing */ }
    }
    return names;
}

function list(folder: string): string[] {
    try { return fs.readdirSync(folder); } catch { return []; }
}

function readYaml(file: string): Record<string, unknown> | undefined {
    try {
        const v = parseYaml(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
    } catch { return undefined; }
}

/** Move the process `quest` still follows on `default` into a run of its own. Undefined when there is none. */
export function migrateDefaultRunProcess(ctx: DefaultRunMigrationContext): DefaultRunMove | undefined {
    const { aiRoot, quest, apply } = ctx;
    const questFolder = path.join(aiRoot, 'quests', quest);
    const stateFile = path.join(questFolder, runStateFileName(quest));
    if (!fs.existsSync(stateFile)) { return undefined; }
    const stateText = fs.readFileSync(stateFile, 'utf8');
    const stack = parseProcessStateStack(stateText);
    const process = stack.levels[0]?.process ?? '';
    if (!process) { return undefined; }

    const run = freeRunName(runNameForProcess(process), (r) => fs.existsSync(path.join(questFolder, runStateFileName(quest, r))));
    const move: DefaultRunMove = { quest, process, run, variables: [], sessions: [], queueItems: [] };
    const now = ctx.now ?? new Date();

    // The definition: its sessions and the variables it names (a process that is gone moves its state only).
    const defFile = path.join(aiRoot, 'processes', process, `${process}.process.yaml`);
    let def: ProcessDefinition | null = null;
    let defText = '';
    try { defText = fs.readFileSync(defFile, 'utf8'); def = parseProcessYaml(defText).definition ?? null; } catch { /* gone */ }
    if (!def) { ctx.problem(`the process ${process} has no readable definition; its state moves, its variables and sessions stay`); }

    // 1. The state stack, as the file holds it, into the run; `default` keeps no process and names the run.
    ctx.change(`the default run's process ${process} -> run ${run} (process-state.${quest}.${run}.yaml)`);
    if (apply) {
        fs.copyFileSync(stateFile, path.join(questFolder, runStateFileName(quest, run)));
        fs.writeFileSync(stateFile, stringify({ levels: [{ ...EMPTY_PROCESS_STATE }], updated: now.toISOString(), movedTo: run }), 'utf8');
    }

    // 2. The chat variables the process uses, in every chat-variable file of the quest.
    const wanted = new Set<string>([PROCESS_SUBJECT_VARIABLE, ...(def?.runParameters ?? []), ...(defText ? processVariableNames(aiRoot, defText) : [])]);
    const varsFolder = path.join(aiRoot, 'chat_variables');
    const own = new RegExp(`^${quest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([^.]+)\\.chatvariable\\.yaml$`);
    for (const name of list(varsFolder)) {
        const m = own.exec(name);
        if (!m) { continue; }
        const file = path.join(varsFolder, name);
        const doc = parseDocument(fs.readFileSync(file, 'utf8'));
        const custom = doc.toJS()?.custom;
        if (!custom || typeof custom !== 'object') { continue; }
        const moving = Object.keys(custom).filter((k) => wanted.has(k)).sort();
        if (!moving.length) { continue; }
        const target = path.join(varsFolder, `${quest}.${m[1]}.${run}.chatvariable.yaml`);
        ctx.change(`chat variables ${moving.join(', ')}: ${name} -> ${path.basename(target)}`);
        for (const k of moving) { if (!move.variables.includes(k)) { move.variables.push(k); } }
        if (apply) {
            const existing = readYaml(target);
            const targetCustom = { ...((existing?.custom as Record<string, string>) ?? {}) };
            for (const k of moving) { targetCustom[k] = String(custom[k] ?? ''); doc.deleteIn(['custom', k]); }
            fs.writeFileSync(target, stringify({ ...(existing ?? {}), run, custom: targetCustom }), 'utf8');
            fs.writeFileSync(file, doc.toString(), 'utf8');
        }
    }

    // 3. The named sessions the process uses become the run's.
    const historyRoot = path.join(questFolder, 'history');
    const sessions = def ? processSessionNames(def) : [];
    const renamed = new Map<string, string>();
    for (const from of sessions) {
        const to = runSessionName(from, run);
        if (to === from) { continue; }
        const places: Array<[string, string]> = [
            [path.join(historyRoot, `${from}.session.json`), path.join(historyRoot, `${to}.session.json`)],
            [path.join(historyRoot, 'sessions', from), path.join(historyRoot, 'sessions', to)],
            [path.join(aiRoot, 'memory', quest, from), path.join(aiRoot, 'memory', quest, to)],
        ];
        const present = places.filter(([a]) => fs.existsSync(a));
        renamed.set(from, to);
        if (!present.length) { continue; }
        const clash = present.find(([, b]) => fs.existsSync(b));
        if (clash) { ctx.problem(`session ${from}: ${path.relative(aiRoot, clash[1])} exists already; ${from} stays`); renamed.delete(from); continue; }
        ctx.change(`session ${from} -> ${to}`);
        move.sessions.push({ from, to });
        if (apply) { for (const [a, b] of present) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); } }
    }
    // A session file based on a renamed session follows it.
    if (apply && renamed.size) {
        for (const name of list(historyRoot).filter((n) => n.endsWith('.session.json'))) {
            const file = path.join(historyRoot, name);
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                const to = typeof data.basedOn === 'string' ? renamed.get(data.basedOn) : undefined;
                if (to && name.endsWith(`@${run}.session.json`)) { data.basedOn = to; fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
            } catch { /* not ours to repair */ }
        }
    }

    // 4. The default run's staged / pending queue items of the process.
    const queueFolder = path.join(aiRoot, 'queue');
    const rename = (s: unknown): unknown => {
        if (typeof s === 'string') { return renamed.get(s) ?? s; }
        if (s && typeof s === 'object' && typeof (s as { name?: unknown }).name === 'string') {
            const spec = s as { name: string; basedOn?: string };
            return { ...spec, name: renamed.get(spec.name) ?? spec.name, ...(spec.basedOn ? { basedOn: renamed.get(spec.basedOn) ?? spec.basedOn } : {}) };
        }
        return s;
    };
    for (const name of list(queueFolder)) {
        if (!name.endsWith('.entry.queue.yaml') || !name.includes(`_${quest}.`)) { continue; }
        const file = path.join(queueFolder, name);
        const doc = parseDocument(fs.readFileSync(file, 'utf8'));
        const data = doc.toJS() as { meta?: { quest?: string; status?: string; id?: string }; 'prompt-queue'?: Array<Record<string, unknown>> };
        if (data?.meta?.quest !== quest || !['staged', 'pending'].includes(String(data.meta.status))) { continue; }
        const prompts = data['prompt-queue'] ?? [];
        const index = prompts.findIndex((p) => p.type === 'main');
        if (index < 0) { continue; }
        const main = prompts[index];
        if (typeof main.run === 'string' && main.run && main.run !== 'default') { continue; }
        const pr = main['process-run'] as { quest?: string; run?: string; state?: { process?: string } } | undefined;
        const session = main.session;
        const sessionName = typeof session === 'string' ? session : (session as { name?: string } | undefined)?.name;
        const ofProcess = (pr && pr.quest === quest && (!pr.run || pr.run === 'default'))
            || main['process-move'] !== undefined || main['process-item'] === true
            || (sessionName !== undefined && renamed.has(sessionName));
        if (!ofProcess) { continue; }
        ctx.change(`queue item ${data.meta.id ?? name} -> run ${run}`);
        move.queueItems.push(String(data.meta.id ?? name));
        if (apply) {
            doc.setIn(['prompt-queue', index, 'run'], run);
            if (pr) { doc.setIn(['prompt-queue', index, 'process-run', 'run'], run); }
            if (session !== undefined) { doc.setIn(['prompt-queue', index, 'session'], rename(session)); }
            fs.writeFileSync(file, doc.toString(), 'utf8');
        }
    }

    // 5. The Q&A journal (this host's).
    if (apply) {
        const lines = [
            `## ${now.toISOString()} — the default run's process moved into run ${run}`,
            '',
            `- **Process:** ${process} (the \`default\` run runs no process; vscimpb122)`,
            `- **Run:** ${run} (\`process-state.${quest}.${run}.yaml\`)`,
            ...(move.variables.length ? [`- **Chat variables:** ${move.variables.map((v) => `\`${v}\``).join(', ')}`] : []),
            ...(move.sessions.length ? [`- **Sessions:** ${move.sessions.map((s) => `\`${s.from}\` → \`${s.to}\``).join(', ')}`] : []),
            ...(move.queueItems.length ? [`- **Queue items:** ${move.queueItems.length}`] : []),
            '',
        ];
        const host = hostSlugOf();
        appendQaBlocks(questFolder, quest, host, [processDecisionBlock(lines.join('\n'), { host, run, now })]);
    }
    return move;
}

/** The run a `default` state file says its process went to (`movedTo`), if any. */
export function movedToRunOf(stateText: string): string | undefined {
    try {
        const raw = parseYaml(stateText) as { movedTo?: unknown } | null;
        return raw && typeof raw.movedTo === 'string' && RUN_NAME.test(raw.movedTo) ? raw.movedTo : undefined;
    } catch { return undefined; }
}
