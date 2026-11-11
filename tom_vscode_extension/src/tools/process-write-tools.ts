/**
 * Process creation tools — `tomAi_validateProcess` and `tomAi_writeProcess` —
 * so an agent can create a process (the process_design process, idea_to_todos).
 *
 * A draft definition (YAML text, or a file) is checked on four levels: it
 * parses as YAML; it matches `src/config/process.schema.json`; it passes the
 * rules the process editor applies (`validateProcessDefinition`: every phase
 * ends with a gate, `onFail` inside its phase, user-action steps without
 * prompts, ids unique in their scope, sessions naming profiles that exist);
 * and every `role` it names exists under `_ai/roles/` or is drafted alongside
 * it (`draftRoles`). The writer writes `_ai/processes/<id>/<id>.process.yaml`
 * and `<id>.md` only when all four pass, refuses an existing id unless
 * `replace` is set, and opens the result in the process editor.
 *
 * vscode-free: the folders, the profiles, the write and the editor come in as
 * {@link ProcessWriteDeps}.
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import { parse } from 'yaml';

import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';
import { phaseSteps, validateProcessDefinition, type ProcessDefinition } from '../utils/processDefinition';
import { listRoleNames } from '../utils/roleNames';

export interface ProcessWriteDeps {
    workspaceRoot: string;
    /** `_ai/processes`, absolute. */
    processesDir: string;
    /** `_ai/roles`, absolute. */
    rolesDir: string;
    /** The window's Anthropic profile ids (a session's profile must be one). */
    profileIds?(): readonly string[];
    /** The processes under `_ai/processes/`, by id (a follow-up's process, phase and step must exist). */
    processOf?(id: string): ProcessDefinition | undefined;
    /** Write both files (the store re-reads its processes afterwards). */
    write(def: ProcessDefinition, description: string): { ok: boolean; error?: string };
    /** Open the process editor on `id`. */
    openEditor?(id: string): void;
}

export type ProcessFindingSource = 'yaml' | 'schema' | 'rules' | 'roles' | 'input';

export interface ProcessFinding {
    source: ProcessFindingSource;
    /** Where in the definition (`phases[0].gate.onFail`); '' for the whole. */
    path: string;
    message: string;
}

export interface ProcessDraftInput {
    /** The definition as YAML text. Exactly one of `yaml` / `file`. */
    yaml?: string;
    /** A `.process.yaml` file in the workspace. */
    file?: string;
    /** Roles the draft introduces that do not exist yet (they are written with it). */
    draftRoles?: string[];
}

export interface ProcessDraftCheck {
    valid: boolean;
    id?: string;
    findings: ProcessFinding[];
    definition?: ProcessDefinition;
}

let schemaValidator: ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string; params?: Record<string, unknown> }> | null } | undefined;

/** The schema's validator, compiled once (`out/config/` beside `out/tools/`, copied there by the compile). */
function schemaCheck(): typeof schemaValidator & object {
    if (!schemaValidator) {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'process.schema.json'), 'utf8')) as object;
        const ajv = new Ajv2020({ allErrors: true, strict: false });
        schemaValidator = ajv.compile(schema);
    }
    return schemaValidator!;
}

/** `/phases/0/gate/onFail` as the rules write it: `phases[0].gate.onFail`. */
function schemaPath(instancePath: string, params?: Record<string, unknown>): string {
    const parts = instancePath.split('/').filter(Boolean).map((p) => (/^\d+$/.test(p) ? `[${p}]` : `.${p}`));
    if (params && typeof params.additionalProperty === 'string') { parts.push(`.${params.additionalProperty}`); }
    if (params && typeof params.missingProperty === 'string') { parts.push(`.${params.missingProperty}`); }
    return parts.join('').replace(/^\./, '');
}

/** Every `role` the definition names, with where. */
function rolesNamed(def: ProcessDefinition): Array<{ role: string; path: string }> {
    const out: Array<{ role: string; path: string }> = [];
    def.phases.forEach((phase, i) => {
        let k = 0;
        for (const entry of phaseSteps(phase)) {
            const step = entry.step;
            const at = entry.kind === 'gate' ? `phases[${i}].gate` : entry.kind === 'post-gate' ? `phases[${i}].postGate` : `phases[${i}].steps[${k++}]`;
            if (step.role) { out.push({ role: step.role, path: `${at}.role` }); }
            (step.substeps ?? []).forEach((sub, s) => { if (sub.role) { out.push({ role: sub.role, path: `${at}.substeps[${s}].role` }); } });
        }
    });
    return out;
}

/** The draft's text: `yaml`, or the file (inside the workspace). */
function draftText(deps: ProcessWriteDeps, input: ProcessDraftInput): { text: string } | { error: string } {
    const hasYaml = typeof input.yaml === 'string' && input.yaml.trim() !== '';
    const hasFile = typeof input.file === 'string' && input.file.trim() !== '';
    if (hasYaml === hasFile) { return { error: 'Give exactly one of `yaml` (the definition as text) and `file` (a .process.yaml in the workspace).' }; }
    if (hasYaml) { return { text: input.yaml! }; }
    const abs = resolveAgainstWsRoot(input.file!, deps.workspaceRoot);
    if (!isInsideWorkspace(abs, deps.workspaceRoot)) { return { error: `Path is outside the workspace: ${input.file}` }; }
    try { return { text: fs.readFileSync(abs, 'utf8') }; } catch { return { error: `File not found: ${input.file}` }; }
}

/** Check a draft on all four levels; every finding, not only the first. */
export function checkProcessDraft(deps: ProcessWriteDeps, input: ProcessDraftInput): ProcessDraftCheck {
    const text = draftText(deps, input);
    if ('error' in text) { return { valid: false, findings: [{ source: 'input', path: '', message: text.error }] }; }
    let raw: unknown;
    try {
        raw = parse(text.text);
    } catch (e) {
        return { valid: false, findings: [{ source: 'yaml', path: '', message: (e as Error).message.split('\n')[0] }] };
    }
    const findings: ProcessFinding[] = [];
    const validate = schemaCheck();
    if (!validate(raw)) {
        for (const e of validate.errors ?? []) {
            findings.push({ source: 'schema', path: schemaPath(e.instancePath, e.params), message: e.message ?? 'does not match the schema' });
        }
    }
    const rules = validateProcessDefinition(raw, {
        ...(deps.profileIds ? { profileIds: deps.profileIds() } : {}),
        ...(deps.processOf ? { processOf: (id: string) => deps.processOf!(id) } : {}),
    });
    for (const e of rules.errors) { findings.push({ source: 'rules', path: e.path, message: e.message }); }
    const id = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : undefined;
    if (rules.definition) {
        const known = new Set([...listRoleNames(deps.rolesDir), ...(input.draftRoles ?? []).map((r) => String(r).trim()).filter(Boolean)]);
        for (const { role, path: at } of rolesNamed(rules.definition)) {
            if (!known.has(role)) {
                findings.push({ source: 'roles', path: at, message: `no role "${role}" under _ai/roles/ — name an existing role or list it in \`draftRoles\` (and write it)` });
            }
        }
    }
    const valid = findings.length === 0 && !!rules.definition;
    return { valid, ...(id ? { id } : {}), findings, ...(valid ? { definition: rules.definition } : {}) };
}

export async function validateProcessImpl(deps: ProcessWriteDeps, input: ProcessDraftInput): Promise<string> {
    const check = checkProcessDraft(deps, input);
    const exists = check.id ? fs.existsSync(path.join(deps.processesDir, check.id)) : false;
    return JSON.stringify({ valid: check.valid, id: check.id ?? null, exists, findings: check.findings });
}

export interface WriteProcessInput extends ProcessDraftInput {
    /** The process description, `<id>.md`. */
    description: string;
    /** Replace a process of the same id. Default false. */
    replace?: boolean;
    /** Open the result in the process editor. Default true. */
    open?: boolean;
}

export async function writeProcessImpl(deps: ProcessWriteDeps, input: WriteProcessInput): Promise<string> {
    if (typeof input.description !== 'string' || input.description.trim() === '') {
        return JSON.stringify({ ok: false, error: '`description` is required: the text of `<id>.md` — what the process is for and how it is worked through.' });
    }
    const check = checkProcessDraft(deps, input);
    if (!check.valid || !check.definition) {
        return JSON.stringify({ ok: false, error: 'The draft is not valid; nothing was written.', findings: check.findings });
    }
    const id = check.definition.id;
    const dir = path.join(deps.processesDir, id);
    const existed = fs.existsSync(dir);
    if (existed && input.replace !== true) {
        return JSON.stringify({ ok: false, error: `A process "${id}" exists already (${path.relative(deps.workspaceRoot, dir).split(path.sep).join('/')}); pass \`replace: true\` to replace it.` });
    }
    const written = deps.write(check.definition, input.description.endsWith('\n') ? input.description : `${input.description}\n`);
    if (!written.ok) { return JSON.stringify({ ok: false, error: written.error ?? 'the files could not be written' }); }
    const rel = (f: string) => path.relative(deps.workspaceRoot, path.join(dir, f)).split(path.sep).join('/');
    const opened = input.open !== false && !!deps.openEditor;
    if (opened) { deps.openEditor!(id); }
    return JSON.stringify({ ok: true, id, replaced: existed, files: [rel(`${id}.process.yaml`), rel(`${id}.md`)], openedInEditor: opened });
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const DRAFT_PROPS = {
    yaml: { type: 'string', description: 'The definition as YAML text (the `.process.yaml` content). Exactly one of yaml / file.' },
    file: { type: 'string', description: 'A draft `.process.yaml` in the workspace instead of `yaml`.' },
    draftRoles: { type: 'array', items: { type: 'string' }, description: 'Roles the draft names that do not exist under _ai/roles/ yet (write them too).' },
};

export const VALIDATE_PROCESS_TOOL: SharedToolDefinition<ProcessDraftInput> = {
    name: 'tomAi_validateProcess',
    displayName: 'Validate Process',
    description:
        'Check a draft process definition (`yaml` text or a `file`) before writing it: YAML, `src/config/process.schema.json`, the ' +
        'rules the process editor applies (every phase ends with a gate; `onFail` names a step of its phase; a user-action step has ' +
        'no prompt or session; ids unique in their scope; maxIterations only on a repeatable level; a session\'s profile exists; a `followUps:` entry\'s ' +
        'process, phase and step exist) and the ' +
        'roles (each `role` exists under `_ai/roles/` or is in `draftRoles`). Answers `{valid, id, exists, findings: [{source: yaml | ' +
        'schema | rules | roles | input, path, message}]}` — every finding, not just the first. Read-only; tomAi_writeProcess writes.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: { ...DRAFT_PROPS } },
    execute: async (input) => validateProcessImpl(liveDeps(), input),
};

export const WRITE_PROCESS_TOOL: SharedToolDefinition<WriteProcessInput> = {
    name: 'tomAi_writeProcess',
    displayName: 'Write Process',
    description:
        'Create a process: writes `_ai/processes/<id>/<id>.process.yaml` (the definition, `yaml` or `file`) and `<id>.md` (`description`) ' +
        'when the draft passes everything tomAi_validateProcess checks — otherwise nothing is written and the findings are answered. An ' +
        'existing id is refused unless `replace: true`. Opens the result in the process editor (`open: false` not to). Answers ' +
        '`{ok, id, replaced, files, openedInEditor}`.',
    tags: ['process', 'quest', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
            ...DRAFT_PROPS,
            description: { type: 'string', description: 'The process description (`<id>.md`): what it is for and how it is worked through.' },
            replace: { type: 'boolean', description: 'Replace a process of the same id. Default false.' },
            open: { type: 'boolean', description: 'Open the result in the process editor. Default true.' },
        },
    },
    execute: async (input) => writeProcessImpl(liveDeps(), input),
};

/* eslint-disable @typescript-eslint/no-require-imports */
function liveDeps(): ProcessWriteDeps {
    const paths = require('../utils/workspacePaths.js') as typeof import('../utils/workspacePaths');
    const processesDir = paths.WsPaths.ai('processes') ?? '';
    return {
        workspaceRoot: paths.WsPaths.wsRoot ?? '',
        processesDir,
        rolesDir: paths.WsPaths.ai('roles') ?? '',
        profileIds: () => {
            const { loadSendToChatConfig } = require('../utils/sendToChatConfig.js') as typeof import('../utils/sendToChatConfig');
            return (loadSendToChatConfig()?.anthropic?.profiles ?? []).map((p) => p.id);
        },
        processOf: (id) => {
            const store = require('../managers/processStateStore.js').ProcessStateStore.instance as import('../managers/processStateStore').ProcessStateStore | undefined;
            if (store) { return store.entry(id)?.definition ?? undefined; }
            const repository = require('../utils/processRepository.js') as typeof import('../utils/processRepository');
            return new repository.ProcessRepository(processesDir, paths.WsPaths.ai('quests') ?? '').list().find((e) => e.id === id)?.definition ?? undefined;
        },
        write: (def, description) => {
            // Through the store, so the PROCESS view and the editor see the new process at once.
            const store = require('../managers/processStateStore.js').ProcessStateStore.instance as import('../managers/processStateStore').ProcessStateStore | undefined;
            if (store) { return store.save(def, description); }
            const repository = require('../utils/processRepository.js') as typeof import('../utils/processRepository');
            return new repository.ProcessRepository(processesDir, paths.WsPaths.ai('quests') ?? '').save(def, description);
        },
        openEditor: (id) => {
            const vscode = require('vscode') as typeof import('vscode');
            void vscode.commands.executeCommand('tomAi.editor.process', id);
        },
    };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROCESS_WRITE_TOOLS: SharedToolDefinition<any>[] = [VALIDATE_PROCESS_TOOL, WRITE_PROCESS_TOOL];
