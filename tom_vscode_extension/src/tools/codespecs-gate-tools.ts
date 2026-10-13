/**
 * CodeSpecs Stage A and Stage B (codespecs_prompt.md §4–§6):
 *
 *   tomAi_specCodeSpecsGate        the mechanical gate, A1–A5, in one report
 *   tomAi_specCodeSpecsVerdicts    the Stage-B gate record (gate.verdicts.yaml): verdicts, missing areas
 *   tomAi_specCodeSpecsSetVerdict  record one area's verdict (approval)
 *
 * The gate is the runtime's CodeSpecsGate; the record is its
 * CodeSpecsGateRecord, whose rules (verdict words, `resolution: descoped`
 * only on an insufficient area, one verdict per area, active areas only) the
 * tools apply by parsing what they would write. The record lives beside the
 * extracts: `<spec root>/generated-doc/codespecs_extracts/gate.verdicts.yaml`,
 * the spec root being the folder that holds the specification document.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    CodeSpecsExtractSet,
    CodeSpecsGate,
    CodeSpecsGateCheck,
    CodeSpecsGateEntry,
    CodeSpecsGateRecord,
    CodeSpecsGateVerdict,
    CodeSpecsRecordError,
    DocSpecsValidator,
    K_CODE_SPECS_GATE_DESCOPED,
    K_CODE_SPECS_GATE_RECORD_FILE,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, SpecToolDeps, documentHeader, json, liveDeps, loadDocument, resolveInput, toWorkspacePath } from './spec-tool-common';
import { CodeSpecsRefusal, EXTRACTS_DIR, ROUTING_FIX, codeSpecsFailure, refuseProjection } from './codespecs-tools';
import { SomSpecValidation } from '../services/som-spec-validation';
import { nodeSomDocumentIo } from '../services/som-document-store';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CodeSpecsGateInput {
    file: string;
}
/** The record is found from the spec document or its folder. */
export interface CodeSpecsRecordLocator {
    file?: string;
    specRoot?: string;
}
export type CodeSpecsVerdictsInput = CodeSpecsRecordLocator;
export interface CodeSpecsSetVerdictInput extends CodeSpecsRecordLocator {
    area: string;
    verdict: string;
    resolution?: string;
    note?: string;
    expectedRevision?: string;
    dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const DOCSPEC_SCHEMA = /^<!-- docspec: ([^/\s]+)\/\S+ -->/;

const CHECKS: Record<string, { what: string; fix: string }> = {
    a1: {
        what: 'the document is complete against its DocSpecs schema',
        fix: 'Fill the section the finding names (tomAi_specSetContent / tomAi_specSetFormField / tomAi_specAddNode).',
    },
    a2: {
        what: 'the document\'s values are valid (validateDocument)',
        fix: 'Correct the value at the path (the edit tools); tomAi_specValidate gives the same finding with the full picture.',
    },
    a3: {
        what: 'every section the walk reaches is routed (ROUTE-TOTAL)',
        fix: ROUTING_FIX,
    },
    a4: {
        what: 'every required marker argument has its source filled, and a reference it names exists',
        fix: 'Fill the source field the message names in the section at the path, or make the value it names exist.',
    },
    a5: {
        what: 'the model still offers every structured carrier the catalogue relies on',
        fix: 'A model-level finding: the TomSpecs model lost a field the CodeSpecs catalogue needs; restore it in tom_specs_model (no document edit fixes it).',
    },
};

export async function codeSpecsGateImpl(deps: SpecToolDeps, input: CodeSpecsGateInput): Promise<string> {
    try {
        const loaded = loadDocument(deps, input.file);
        refuseProjection(deps, loaded);
        const model = deps.service.model;
        const markdown = loaded.document.toMarkdown(model, loaded.root.type);
        const schemaId = DOCSPEC_SCHEMA.exec(markdown)?.[1] ?? null;
        const schema = schemaId && deps.service.schemaIds.includes(schemaId) ? deps.service.schema(schemaId) : null;
        const report = new CodeSpecsGate({
            model, document: loaded.document, catalog: deps.service.codeSpecsCatalog, schema, rootType: loaded.root.type,
        }).run();

        // A1 findings carry a section id; locate the document path the same way tomAi_specValidate does.
        let a1Paths: Array<string | null> = [];
        const a1 = report.resultFor(CodeSpecsGateCheck.a1);
        if (schema && a1.findings.length > 0) {
            const violations = new DocSpecsValidator(schema).validateMarkdown(markdown);
            if (violations.length === a1.findings.length) {
                a1Paths = new SomSpecValidation(deps.service, deps.store).locate(loaded.document, loaded.root, markdown, violations);
            }
        }
        const pathFor = (check: string, location: string, i: number): string | undefined => {
            if (check === 'a1') { return a1Paths[i] ?? undefined; }
            return check === 'a5' ? undefined : location; // A5 names a model member, not a document path
        };
        const checks = report.results.map((r) => ({
            check: r.check.label,
            what: CHECKS[r.check.name].what,
            ran: r.ran,
            passed: r.passed,
            ...(r.notRunReason ? { notRunReason: r.notRunReason } : {}),
            ...(r.findings.length > 0 ? { fix: CHECKS[r.check.name].fix } : {}),
            findings: r.findings.map((f, i) => {
                const p = pathFor(r.check.name, f.location, i);
                return { code: f.code, location: f.location, ...(p ? { path: p } : {}), message: f.message };
            }),
        }));
        const failing = checks.filter((c) => !c.passed).map((c) => c.check);
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            gateOpen: report.passed,
            summary: report.passed
                ? 'gate open: A1–A5 pass; next, record a Stage-B verdict per area (tomAi_specCodeSpecsSetVerdict)'
                : `gate closed: ${failing.join(', ')} ${failing.length === 1 ? 'does' : 'do'} not pass`,
            schema: schemaId ? { id: schemaId, version: deps.service.schemaVersion(schemaId), found: schema !== null } : null,
            checks,
        });
    } catch (e) {
        return codeSpecsFailure(e);
    }
}

// ---------------------------------------------------------------------------
// The gate record
// ---------------------------------------------------------------------------

/** The record file for a spec document or spec root. */
function recordPath(deps: SpecToolDeps, input: CodeSpecsRecordLocator): string {
    if ((input.file ? 1 : 0) + (input.specRoot ? 1 : 0) !== 1) {
        throw new CodeSpecsRefusal('invalidInput', 'Pass `file` (the spec document) or `specRoot` (the folder holding it), not both.');
    }
    const root = input.file ? path.dirname(resolveInput(deps, input.file)) : resolveInput(deps, input.specRoot as string);
    return path.join(root, EXTRACTS_DIR, K_CODE_SPECS_GATE_RECORD_FILE);
}

/** The record's leading comment lines; the runtime's toYaml does not carry them, so they are kept by hand. */
function leadingComments(text: string): string {
    const lines: string[] = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('#')) { break; }
        lines.push(line);
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

interface RecordState {
    file: string;
    exists: boolean;
    text: string;
    revision: string | null;
    record: CodeSpecsGateRecord;
}

function readRecord(deps: SpecToolDeps, file: string): RecordState {
    if (!fs.existsSync(file)) {
        return { file, exists: false, text: '', revision: null, record: new CodeSpecsGateRecord([]) };
    }
    const { text, revision } = deps.store.readText(file);
    const record = CodeSpecsGateRecord.fromYaml(text, path.basename(file));
    record.checkAgainst(deps.service.codeSpecsCatalog, path.basename(file));
    return { file, exists: true, text, revision, record };
}

function verdictView(e: CodeSpecsGateEntry): Record<string, unknown> {
    return { area: e.area, verdict: e.verdict.word, ...(e.resolution ? { resolution: e.resolution } : {}), ...(e.note ? { note: e.note } : {}) };
}

function missingAreas(deps: SpecToolDeps, record: CodeSpecsGateRecord): string[] {
    return deps.service.codeSpecsCatalog.activeAreas.map((a) => a.code).filter((code) => !record.verdictFor(code));
}

/** The record against the extracts on disk, by the runtime's rules; null when there are no extracts. */
function consistency(file: string): { ok: boolean; message?: string } | null {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.extract.yaml'))) { return null; }
    try {
        CodeSpecsExtractSet.fromDirectory(dir);
        return { ok: true };
    } catch (e) {
        return { ok: false, message: (e as Error).message };
    }
}

function recordFailure(e: unknown): string {
    if (e instanceof CodeSpecsRecordError) {
        return json({ ok: false, code: 'recordError', error: e.message });
    }
    return codeSpecsFailure(e);
}

export async function codeSpecsVerdictsImpl(deps: SpecToolDeps, input: CodeSpecsVerdictsInput): Promise<string> {
    try {
        const state = readRecord(deps, recordPath(deps, input));
        const missing = missingAreas(deps, state.record);
        const counts: Record<string, number> = {};
        for (const e of state.record.verdicts) { counts[e.verdict.word] = (counts[e.verdict.word] ?? 0) + 1; }
        const check = consistency(state.file);
        return json({
            ok: true,
            file: toWorkspacePath(deps, state.file),
            exists: state.exists,
            ...(state.revision ? { revision: state.revision } : {}),
            complete: missing.length === 0,
            counts,
            verdicts: state.record.verdicts.map(verdictView),
            missing,
            ...(check ? { againstExtracts: check } : {}),
            ...(state.exists ? {} : { note: 'No gate record yet: until there is one, the whole extract tree is the obligation set (codespecs_mapping.md).' }),
        });
    } catch (e) {
        return recordFailure(e);
    }
}

function parseVerdict(word: string): CodeSpecsGateVerdict | null {
    return CodeSpecsGateVerdict.parse(word) ?? CodeSpecsGateVerdict.values.find((v) => v.name === word) ?? null;
}

export async function codeSpecsSetVerdictImpl(deps: SpecToolDeps, input: CodeSpecsSetVerdictInput): Promise<string> {
    try {
        const file = recordPath(deps, input);
        const state = readRecord(deps, file);
        const area = deps.service.codeSpecsCatalog.byCode(input.area);
        if (!area || !area.active) {
            return json({ ok: false, code: 'unknownArea', error: `'${input.area}' is not an active area. Areas: ${deps.service.codeSpecsCatalog.activeAreas.map((a) => a.code).join(', ')}.` });
        }
        const verdict = parseVerdict(input.verdict);
        if (!verdict) {
            return json({ ok: false, code: 'unknownVerdict', error: `'${input.verdict}' is not a verdict. Verdicts: ${CodeSpecsGateVerdict.values.map((v) => v.word).join(', ')}.` });
        }
        const entry = new CodeSpecsGateEntry({ area: area.code, verdict, resolution: input.resolution ?? null, note: input.note ?? null });
        const next = state.record.withVerdict(entry);
        // The runtime's own rules, applied by reading back exactly what would be written.
        const text = leadingComments(state.text) + next.toYaml();
        CodeSpecsGateRecord.fromYaml(text, K_CODE_SPECS_GATE_RECORD_FILE).checkAgainst(deps.service.codeSpecsCatalog);

        let written = false;
        let revision: string;
        let diff: string | undefined;
        if (state.exists) {
            const saved = await deps.store.writeText(file, text, {
                baseRevision: state.revision as string, expectedRevision: input.expectedRevision, dryRun: input.dryRun,
            });
            written = saved.written;
            revision = saved.revision;
            diff = saved.diff;
        } else {
            if (input.expectedRevision !== undefined) {
                return json({ ok: false, code: 'revisionConflict', error: `${toWorkspacePath(deps, file)} does not exist yet, so it has no revision to expect.` });
            }
            if (!input.dryRun) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                await nodeSomDocumentIo.write(file, text);
                written = true;
            }
            revision = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        }
        const reminder = verdict === CodeSpecsGateVerdict.insufficient
            ? entry.resolution === K_CODE_SPECS_GATE_DESCOPED
                ? 'Descoped: this pass proceeds without the area, and the gap is still owed. Record it as a csopen todo.'
                : 'Insufficient and not descoped: the run may not continue past this area (codespecs_prompt.md §6.2). '
                    + 'Either fill the spec and re-take the verdict, or descope it (`resolution: descoped`) and open a csopen todo for the gap.'
            : null;
        return json({
            ok: true,
            written,
            file: toWorkspacePath(deps, file),
            revision,
            recorded: verdictView(entry),
            ...(state.record.verdictFor(area.code) ? { replaced: verdictView(state.record.verdictFor(area.code) as CodeSpecsGateEntry) } : {}),
            missing: missingAreas(deps, next),
            ...(reminder ? { reminder } : {}),
            ...(input.dryRun && diff !== undefined ? { diff } : {}),
        });
    } catch (e) {
        return recordFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const LOCATOR = {
    file: { ...FILE_PARAM, description: 'The specification document; its folder is the spec root. Or pass `specRoot`.' },
    specRoot: { type: 'string', description: 'The folder holding the specification document. Or pass `file`.' },
};

export const CODESPECS_GATE_TOOL: SharedToolDefinition<CodeSpecsGateInput> = {
    name: 'tomAi_specCodeSpecsGate',
    displayName: 'CodeSpecs: Gate',
    description:
        'The CodeSpecs Stage-A gate, which a spec must pass before Phase-4 authoring (codespecs_prompt.md §4), as one report '
        + 'from the runtime\'s CodeSpecsGate: A1 the document is complete against its DocSpecs schema, A2 its values are '
        + 'valid, A3 every section the walk reaches is routed, A4 every required marker argument has its source filled '
        + 'and its reference exists, A5 the model still offers every structured carrier the catalogue relies on. Answers '
        + '`{gateOpen, summary, checks: [{check, what, ran, passed, notRunReason, fix, findings: [{code, location, path, '
        + 'message}]}]}`; `path` is the document path to fix as the edit tools take it (A5 findings are model-level and '
        + 'have none). The CodeSpecs projection document is refused.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: { file: FILE_PARAM }, required: ['file'] },
    execute: async (input) => codeSpecsGateImpl(liveDeps(), input),
};

export const CODESPECS_VERDICTS_TOOL: SharedToolDefinition<CodeSpecsVerdictsInput> = {
    name: 'tomAi_specCodeSpecsVerdicts',
    displayName: 'CodeSpecs: Verdicts',
    description:
        'The Stage-B gate record of a spec (`gate.verdicts.yaml` beside the extracts, `<spec root>/generated-doc/'
        + 'codespecs_extracts/`): each area\'s verdict (sufficient / not applicable / insufficient), its resolution and '
        + 'note, the active areas with no verdict yet (`missing`), and — when extracts are on disk — whether record and '
        + 'extracts agree by the runtime\'s rules (a not-applicable area with entries, an insufficient area not descoped, '
        + 'an extract without a verdict). Without a record yet: `exists: false` and every active area missing.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: LOCATOR },
    execute: async (input) => codeSpecsVerdictsImpl(liveDeps(), input),
};

export const CODESPECS_SET_VERDICT_TOOL: SharedToolDefinition<CodeSpecsSetVerdictInput> = {
    name: 'tomAi_specCodeSpecsSetVerdict',
    displayName: 'CodeSpecs: Set Verdict',
    description:
        'Record one area\'s Stage-B verdict in the spec\'s gate record (`gate.verdicts.yaml`), creating the record if needed. '
        + '`verdict`: sufficient, not applicable (or notApplicable), insufficient; `resolution: descoped` is allowed only '
        + 'on insufficient (it lets the pass continue without the area); `note` is free text. An unknown or inactive area, '
        + 'an unknown verdict, or a record the runtime would reject is refused, and nothing is written. The record is '
        + 'rewritten in the runtime\'s format, its leading comments kept; `expectedRevision` and `dryRun` (a diff) as for '
        + 'every edit. Answers the recorded and any replaced verdict and the areas still missing; an insufficient verdict '
        + 'comes with what is owed next.',
    tags: ['tomspecs', 'codespecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...LOCATOR,
            area: { type: 'string', description: 'The area code, e.g. `CE-EN`.' },
            verdict: { type: 'string', enum: ['sufficient', 'not applicable', 'notApplicable', 'insufficient'] },
            resolution: { type: 'string', enum: ['descoped'], description: 'Only with `insufficient`.' },
            note: { type: 'string', description: 'Why, in a sentence.' },
            expectedRevision: { type: 'string', description: 'The record\'s `revision` from tomAi_specCodeSpecsVerdicts.' },
            dryRun: { type: 'boolean', description: 'Return the result and the diff, write nothing.' },
        },
        required: ['area', 'verdict'],
    },
    approvalSummary: (input) => `Record ${input.area}: ${input.verdict}${input.resolution ? ` (${input.resolution})` : ''} in the gate record of ${input.file ?? input.specRoot}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => codeSpecsSetVerdictImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CODESPECS_GATE_TOOLS: SharedToolDefinition<any>[] = [
    CODESPECS_GATE_TOOL,
    CODESPECS_VERDICTS_TOOL,
    CODESPECS_SET_VERDICT_TOOL,
];
