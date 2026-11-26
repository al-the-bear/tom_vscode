/**
 * Format version 11, step `copilot-leftovers` (see context.ts): what the Copilot transport, the answer
 * wrapper and the reminders left in stored files (ai_format_migration.md § 3.6, § 3.7, AC-1, AC-3, AC-22).
 *
 *   - queue entries and queue templates (`*.queue.yaml` under `_ai/queue/` and `_ai/local/`): `transport:
 *     copilot` becomes `anthropic` on every prompt (main, pre-prompts, follow-ups) and in
 *     `execution.last-dispatched`; `answer-wrapper`, `answer-wait-minutes`, `reminder`,
 *     `execution.request-id` and `execution.expected-request-id` go; a template `__answer_file__` becomes
 *     `(None)` (an `answer-template` naming it goes). An item `meta.type: reminder` (a generated "are you
 *     still there?" nudge asking for the answer file) is deleted with its file;
 *   - `queue-settings.yaml`: `default-transport`, `response-timeout-minutes` and
 *     `default-reminder-template-id` go, at the top level, under `runs.<run>` and under
 *     `runs-by-quest.<quest>.<run>`;
 *   - timed requests (`entries` of `_ai/local/*.timed.yaml`, `timedRequests` of the configuration):
 *     `answerWrapper`, `answerWaitMinutes` and the reminder fields go; a template `__answer_file__`
 *     becomes `(None)`;
 *   - the configuration — the workspace config (JSON), the user overlay (YAML, its comments and the text
 *     of every value not changed kept) and every quest's `config/extension_config*.yaml`: the sections
 *     `copilot` and `reminders`, `questRefresh.copilot`, `questRefresh.panels.copilot`,
 *     `trail.raw.paths.copilot` and `aspectGuidelines.chat.copilot` go;
 *   - the Copilot panel's drafts (`_ai/local/*.copilot.prompt-panel.yaml`) are deleted, and a
 *     `sections.copilot` of a `*.panels.yaml` goes;
 *   - the chat variables' change log (`_ai/chat_variables/*.chatvariable.yaml`): `source: copilot` (set by
 *     an agent's tool call) becomes `source: agent`;
 *   - what nothing writes any more is deleted: `_ai/answers/copilot/`, `_ai/trail/copilot/` and every
 *     `<quest>.copilot.prompts.md` / `.answers.md` in a quest's folder or its `history/`.
 *
 * Every file here is machine-local except the quests' configuration (tracked: the first host that migrates
 * rewrites it). Idempotent; with `apply: false` it only reports. vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, type YAMLMap } from 'yaml';

import { ANSWER_WRAPPER_ID } from '../userMessageTemplateLookup';
import { mergeYamlLayout } from '../yamlLayoutMerge';
import type { V11Context } from './context';

const STEP = 'copilot-leftovers' as const;

/** The template id of the removed answer wrapper: stored, it means no template. */
const ANSWER_FILE_TEMPLATE = ANSWER_WRAPPER_ID;

/** What the queue writes for no template. */
const NO_TEMPLATE = '(None)';

/** Keys of a stored queue prompt nothing reads. */
const DROPPED_PROMPT_KEYS = ['answer-wrapper', 'answer-wait-minutes', 'reminder'] as const;

/** Keys of a stored prompt's execution state nothing reads. */
const DROPPED_EXECUTION_KEYS = ['request-id', 'expected-request-id'] as const;

/** Keys of `queue-settings.yaml` (top level and per run) nothing reads. */
const DROPPED_SETTINGS_KEYS = ['default-transport', 'response-timeout-minutes', 'default-reminder-template-id'] as const;

/** Keys of a timed request nothing reads. */
const DROPPED_TIMED_KEYS = [
    'answerWrapper', 'answerWaitMinutes', 'reminderEnabled', 'reminderTemplateId', 'reminderTimeoutMinutes', 'reminderRepeat',
] as const;

/** The change source the chat variables' change log keeps for an agent's tool call. */
const AGENT_SOURCE = 'agent';

/** The queue writer's line width (storage/queueFileStorage.ts, utils/panelYamlStore.ts). */
const LINE_WIDTH = 120;

export function migrateV11CopilotLeftovers(ctx: V11Context): void {
    const machineFiles = [...filesBelow(path.join(ctx.aiRoot, 'queue')), ...filesBelow(path.join(ctx.aiRoot, 'local'))];
    for (const file of machineFiles) {
        const name = path.basename(file);
        if (name.endsWith('.queue.yaml')) { queueFile(ctx, file); }
        else if (name === 'queue-settings.yaml') { queueSettingsFile(ctx, file); }
        else if (name.endsWith('.timed.yaml')) { timedFile(ctx, file); }
        else if (name.endsWith('.copilot.prompt-panel.yaml')) { removeFile(ctx, '(machine)', file, 'the Copilot panel\'s draft'); }
        else if (name.endsWith('.panels.yaml')) { panelsFile(ctx, file); }
    }
    for (const file of filesBelow(path.join(ctx.aiRoot, 'chat_variables'))) {
        if (file.endsWith('.chatvariable.yaml')) { chatVariablesFile(ctx, file); }
    }
    configFiles(ctx);
    removedFolders(ctx);
}

// ---- files ----------------------------------------------------------------

function filesBelow(folder: string): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
    const out: string[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(folder, e.name);
        if (e.isDirectory()) { out.push(...filesBelow(p)); } else if (e.isFile()) { out.push(p); }
    }
    return out;
}

function removeFile(ctx: V11Context, quest: string, file: string, what: string): void {
    ctx.change(quest, STEP, `delete ${ctx.rel(file)} (${what})`);
    if (ctx.apply) { fs.rmSync(file, { force: true }); }
}

function removeFolder(ctx: V11Context, quest: string, folder: string, what: string): void {
    if (!fs.existsSync(folder)) { return; }
    ctx.change(quest, STEP, `delete ${ctx.rel(folder)}/ (${what})`);
    if (ctx.apply) { fs.rmSync(folder, { recursive: true, force: true }); }
}

/**
 * Edit a YAML file through its document (comments and the scalars' styles kept; written in the queue
 * writer's line width). `edit` answers what it changed; nothing: the file stays as it is. A file that does
 * not parse is a problem only when it holds something this step rewrites.
 */
function editYamlDocument(ctx: V11Context, quest: string, file: string, edit: (doc: Document) => string[]): void {
    const text = fs.readFileSync(file, 'utf8');
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
        if (/copilot|reminder|answer-wrapper|answer-wait|request-id|response-timeout|default-transport|__answer_file__|answerWrapper|answerWait/.test(text)) {
            ctx.problem(quest, STEP, `${ctx.rel(file)} is not readable YAML (${doc.errors[0].message.split('\n')[0]}): left as it is`);
        }
        return;
    }
    const done = edit(doc);
    if (done.length === 0) { return; }
    ctx.change(quest, STEP, `${ctx.rel(file)}: ${done.join('; ')}`);
    if (ctx.apply) { fs.writeFileSync(file, doc.toString({ lineWidth: LINE_WIDTH }), 'utf8'); }
}

function mapItems(node: unknown): YAMLMap[] {
    return isSeq(node) ? node.items.filter((i): i is YAMLMap => isMap(i)) : [];
}

/** Count `what` once more. */
function tally(counts: Map<string, number>, what: string): void {
    counts.set(what, (counts.get(what) ?? 0) + 1);
}

function tallied(counts: Map<string, number>): string[] {
    return [...counts].map(([what, n]) => (n > 1 ? `${what} (${n})` : what));
}

// ---- the queue ------------------------------------------------------------

/** A queue entry or template. */
function queueFile(ctx: V11Context, file: string): void {
    const text = fs.readFileSync(file, 'utf8');
    const doc = parseDocument(text);
    const meta = doc.errors.length === 0 ? doc.get('meta') : undefined;
    if (isMap(meta) && meta.get('type') === 'reminder') {
        removeFile(ctx, '(machine)', file, `a reminder item (${String(meta.get('status') ?? 'no status')}), not a prompt of its own`);
        return;
    }
    editYamlDocument(ctx, '(machine)', file, (d) => {
        const counts = new Map<string, number>();
        for (const prompt of mapItems(d.get('prompt-queue'))) {
            if (prompt.get('transport') === 'copilot') { prompt.set('transport', 'anthropic'); tally(counts, 'transport copilot as anthropic'); }
            for (const key of DROPPED_PROMPT_KEYS) {
                if (prompt.has(key)) { prompt.delete(key); tally(counts, `drop ${key}`); }
            }
            if (prompt.get('template') === ANSWER_FILE_TEMPLATE) { prompt.set('template', NO_TEMPLATE); tally(counts, `template ${ANSWER_FILE_TEMPLATE} as ${NO_TEMPLATE}`); }
            if (prompt.get('answer-template') === ANSWER_FILE_TEMPLATE) { prompt.delete('answer-template'); tally(counts, `drop answer-template ${ANSWER_FILE_TEMPLATE}`); }
            const execution = prompt.get('execution');
            if (!isMap(execution)) { continue; }
            for (const key of DROPPED_EXECUTION_KEYS) {
                if (execution.has(key)) { execution.delete(key); tally(counts, `drop execution.${key}`); }
            }
            const last = execution.get('last-dispatched');
            if (isMap(last) && last.get('transport') === 'copilot') {
                last.set('transport', 'anthropic');
                tally(counts, 'execution.last-dispatched.transport copilot as anthropic');
            }
        }
        return tallied(counts);
    });
}

/** `queue-settings.yaml`: the dropped keys at the top level and in every run's entry. */
function queueSettingsFile(ctx: V11Context, file: string): void {
    editYamlDocument(ctx, '(machine)', file, (doc) => {
        const counts = new Map<string, number>();
        const drop = (map: unknown, where: string) => {
            if (!isMap(map)) { return; }
            for (const key of DROPPED_SETTINGS_KEYS) {
                if (map.has(key)) { map.delete(key); tally(counts, `drop ${where}${key}`); }
            }
        };
        drop(doc.contents, '');
        const runs = doc.get('runs');
        if (isMap(runs)) { for (const run of runs.items) { drop(run.value, 'runs.<run>.'); } }
        const byQuest = doc.get('runs-by-quest');
        if (isMap(byQuest)) {
            for (const quest of byQuest.items) {
                if (isMap(quest.value)) { for (const run of quest.value.items) { drop(run.value, 'runs-by-quest.<quest>.<run>.'); } }
            }
        }
        return tallied(counts);
    });
}

// ---- timed requests -------------------------------------------------------

/** A timed request as stored (a plain object): the dropped keys gone, the wrapper template as no template; counted in `counts`. */
function cleanTimedEntry(entry: Record<string, unknown>, counts: Map<string, number>): void {
    for (const key of DROPPED_TIMED_KEYS) {
        if (key in entry) { delete entry[key]; tally(counts, `drop timed ${key}`); }
    }
    if (entry.template === ANSWER_FILE_TEMPLATE) { entry.template = NO_TEMPLATE; tally(counts, `timed template ${ANSWER_FILE_TEMPLATE} as ${NO_TEMPLATE}`); }
}

function timedFile(ctx: V11Context, file: string): void {
    editYamlDocument(ctx, '(machine)', file, (doc) => {
        const counts = new Map<string, number>();
        for (const entry of mapItems(doc.get('entries'))) {
            for (const key of DROPPED_TIMED_KEYS) {
                if (entry.has(key)) { entry.delete(key); tally(counts, `drop ${key}`); }
            }
            if (entry.get('template') === ANSWER_FILE_TEMPLATE) { entry.set('template', NO_TEMPLATE); tally(counts, `template ${ANSWER_FILE_TEMPLATE} as ${NO_TEMPLATE}`); }
        }
        return tallied(counts);
    });
}

// ---- drafts and chat variables --------------------------------------------

function panelsFile(ctx: V11Context, file: string): void {
    editYamlDocument(ctx, '(machine)', file, (doc) => {
        const sections = doc.get('sections');
        if (!isMap(sections) || !sections.has('copilot')) { return []; }
        sections.delete('copilot');
        return ['drop sections.copilot (the Copilot panel\'s draft)'];
    });
}

function chatVariablesFile(ctx: V11Context, file: string): void {
    editYamlDocument(ctx, '(machine)', file, (doc) => {
        let renamed = 0;
        for (const entry of mapItems(doc.get('changeLog'))) {
            if (entry.get('source') === 'copilot') { entry.set('source', AGENT_SOURCE); renamed++; }
        }
        return renamed === 0 ? [] : [`change source copilot as ${AGENT_SOURCE} (${renamed})`];
    });
}

// ---- the configuration ----------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Delete `key` of the object at `parents` (a path of keys); an object this empties goes too. Answers whether it was there. */
function dropPath(config: Record<string, unknown>, parents: string[], key: string): boolean {
    const chain: Array<Record<string, unknown>> = [config];
    for (const p of parents) {
        const next = chain[chain.length - 1][p];
        if (!isObject(next)) { return false; }
        chain.push(next);
    }
    const holder = chain[chain.length - 1];
    if (!(key in holder)) { return false; }
    delete holder[key];
    for (let i = chain.length - 1; i > 0 && Object.keys(chain[i]).length === 0; i--) { delete chain[i - 1][parents[i - 1]]; }
    return true;
}

/**
 * The configuration (the workspace config, the user overlay, a quest's extension config) without what the
 * Copilot transport and the reminders left. Changes `config` in place; answers what it did ([] for nothing).
 */
export function dropCopilotConfig(config: unknown): string[] {
    if (!isObject(config)) { return []; }
    const done: string[] = [];
    const paths: Array<[string[], string]> = [
        [[], 'copilot'], [[], 'reminders'], [['questRefresh'], 'copilot'], [['questRefresh', 'panels'], 'copilot'],
        [['trail', 'raw', 'paths'], 'copilot'], [['aspectGuidelines', 'chat'], 'copilot'],
    ];
    for (const [parents, key] of paths) {
        if (dropPath(config, parents, key)) { done.push(`remove ${[...parents, key].join('.')}`); }
    }
    if (Array.isArray(config.timedRequests)) {
        const counts = new Map<string, number>();
        for (const entry of config.timedRequests) { if (isObject(entry)) { cleanTimedEntry(entry, counts); } }
        done.push(...tallied(counts));
    }
    return done;
}

/** The `yaml` writer's `indentSeq` for a file: false when its block sequences sit at their key's own indent. */
function indentSeqOf(text: string): boolean {
    return !/^( *)[^\s#-][^\n]*:\n\1- /m.test(text);
}

/** `config` as YAML in the layout of `original` (yamlLayoutMerge.ts): unchanged entries keep their text and comments. */
function yamlKeepingLayout(original: string, config: unknown): string {
    const encoded = new Document(config).toString({ indentSeq: indentSeqOf(original) });
    const merged = mergeYamlLayout(original, encoded);
    return isDeepStrictEqual(parseYaml(merged), parseYaml(encoded)) ? merged : encoded;
}

function configFile(ctx: V11Context, quest: string, file: string): void {
    const raw = fs.readFileSync(file, 'utf8');
    const isYaml = /\.ya?ml$/i.test(file);
    let config: unknown;
    try { config = isYaml ? parseDocument(raw).toJS() : JSON.parse(raw); } catch {
        if (/copilot|reminders|answerWrapper|answerWait/.test(raw)) { ctx.problem(quest, STEP, `${file} is not readable: left as it is`); }
        return;
    }
    const done = dropCopilotConfig(config);
    if (done.length === 0) { return; }
    ctx.change(quest, STEP, `${quest.startsWith('(') ? file : ctx.rel(file)}: ${done.join('; ')}`);
    if (!ctx.apply) { return; }
    if (isYaml) {
        fs.writeFileSync(file, yamlKeepingLayout(raw, config ?? {}), 'utf8');
    } else {
        const indent = /^\{\r?\n(\s+)"/.exec(raw)?.[1] ?? '    ';
        fs.writeFileSync(file, JSON.stringify(config, null, indent) + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
    }
}

function configFiles(ctx: V11Context): void {
    for (const file of [ctx.workspaceConfigPath, ctx.userConfigPath]) {
        if (file && fs.existsSync(file)) { configFile(ctx, '(workspace)', file); }
    }
    for (const quest of ctx.quests) {
        const folder = path.join(ctx.aiRoot, 'quests', quest, 'config');
        let names: string[];
        try { names = fs.readdirSync(folder).sort(); } catch { continue; }
        for (const name of names) {
            if (/^extension_config\..+\.ya?ml$/.test(name)) { configFile(ctx, quest, path.join(folder, name)); }
        }
    }
}

// ---- what nothing writes any more -----------------------------------------

function removedFolders(ctx: V11Context): void {
    removeFolder(ctx, '(machine)', path.join(ctx.aiRoot, 'answers', 'copilot'), 'the Copilot answer files');
    removeFolder(ctx, '(machine)', path.join(ctx.aiRoot, 'trail', 'copilot'), 'the Copilot raw trail');
    for (const quest of ctx.quests) {
        const questDir = path.join(ctx.aiRoot, 'quests', quest);
        for (const folder of [questDir, path.join(questDir, 'history')]) {
            for (const name of [`${quest}.copilot.prompts.md`, `${quest}.copilot.answers.md`]) {
                const file = path.join(folder, name);
                if (fs.existsSync(file)) { removeFile(ctx, quest, file, 'the Copilot prompt trail'); }
            }
        }
    }
}
