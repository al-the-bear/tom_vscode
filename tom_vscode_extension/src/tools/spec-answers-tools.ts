/**
 * A step's `answers.md` (SOM §11.9.7): what the reviewer wrote into TomSpecs
 * documents — answers to the agent's questions, comments, optionally the open
 * questions and the inline marks — collected through the runtime's
 * extractAnswers / renderAnswers, never by a second parser here. The same
 * rules as tom_specs' `extract_answers` CLI: documents grouped by root in the
 * order given (fragments of one root assembled into one document), each
 * labelled by its file name without the format suffix, a malformed, misplaced
 * or duplicate annotation reported because the extraction would miss it.
 *
 *   tomAi_specExtractAnswers  the text and the counts; never writes (read-only floor)
 *   tomAi_specWriteAnswers    write it to the step folder's answers.md (approval)
 *
 * The annotations stay in the documents; removing them is
 * tomAi_specRemoveAllAnnotations (spec-annotation-tools.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    SpecAnswerCounts,
    SpecAnswerRenderOptions,
    SpecReviewAnnotations,
    SpecValidationCode,
    assembleSpecDocuments,
    extractAnswers,
    renderAnswers,
    type SpecAnswerExtract,
    type SpecDocument,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, FIRST_LOOK, PATH_PARAM_HINT, SpecToolDeps, failure, json, liveDeps, loadDocument, resolveInput, toWorkspacePath } from './spec-tool-common';
import { SomSpecInspector } from '../services/som-spec-inspector';
import type { LoadedSomDocument } from '../services/som-document-store';
import { unifiedDiff } from '../utils/unifiedDiff';

export interface SpecExtractAnswersInput {
    file?: string;
    /** Several documents (or fragments of one), in the order answers.md lists them. */
    files?: string[];
    /** Only the subtree at this document path. */
    path?: string;
    /** Also list the questions still open. */
    includeOpen?: boolean;
    /** Also list the inline marks. */
    includeMarks?: boolean;
    /** The file's title (default `Answers`). */
    title?: string;
}

export interface SpecWriteAnswersInput extends SpecExtractAnswersInput {
    /** The answers.md to write, inside the workspace. */
    output: string;
    /** Replace an existing file whose text differs. */
    overwrite?: boolean;
    dryRun?: boolean;
}

/** Annotation findings the extraction would silently miss (the CLI fails on them too). */
const MISSED: ReadonlySet<string> = new Set([
    SpecValidationCode.ANNOTATION_MALFORMED,
    SpecValidationCode.ANNOTATION_MISPLACED,
    SpecValidationCode.DUPLICATE_ANNOTATION_ID,
]);

/** A document's label: its file name without the format suffix (`tom_uam.sbp.docspecs.yaml` → `tom_uam.sbp`). */
export function answersLabel(file: string): string {
    const name = path.basename(file);
    for (const suffix of ['.docspecs.yaml', '.yaml', '.md']) {
        if (name.endsWith(suffix)) { return name.slice(0, -suffix.length); }
    }
    return name;
}

/** Refused before anything is extracted: the answer names the code. */
class AnswersRefusal extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
    }
}

interface AnswersBuild {
    extracts: SpecAnswerExtract[];
    documents: Array<{ label: string; root: string; files: string[]; counts: Record<string, number> }>;
    counts: Record<string, number>;
    findings: Array<{ document: string; path: string; code: string; message: string }>;
    markdown: string;
}

function buildAnswers(deps: SpecToolDeps, input: SpecExtractAnswersInput): AnswersBuild {
    if (input.file && input.files) { throw new AnswersRefusal('invalidInput', 'Pass `file` or `files`, not both.'); }
    const names = input.files ?? (input.file ? [input.file] : []);
    if (names.length === 0) { throw new AnswersRefusal('invalidInput', 'Name the document(s): `file` or `files`.'); }

    // Group by root, in the order given; the first file of a root names it.
    const groups = new Map<string, Array<{ name: string; loaded: LoadedSomDocument }>>();
    for (const name of names) {
        const loaded = loadDocument(deps, name);
        const key = loaded.root.type;
        if (!groups.has(key)) { groups.set(key, []); }
        groups.get(key)!.push({ name, loaded });
    }

    const scope = input.path || null;
    const extracts: SpecAnswerExtract[] = [];
    const documents: AnswersBuild['documents'] = [];
    const findings: AnswersBuild['findings'] = [];
    for (const fragments of groups.values()) {
        const first = fragments[0].loaded;
        const label = answersLabel(fragments[0].name);
        let document: SpecDocument;
        if (fragments.length === 1) {
            document = first.document;
        } else {
            const assembly = assembleSpecDocuments(fragments.map((f) => [f.name, f.loaded.document] as const));
            if (!assembly.document) {
                throw new AnswersRefusal('overlap', `The fragments of ${label} overlap, so they do not assemble into one document.`, {
                    overlaps: assembly.overlaps.map((o) => ({ path: o.path, field: o.field, message: o.message })),
                });
            }
            document = assembly.document;
        }
        if (scope) { new SomSpecInspector(deps.service, document).resolve(scope); }
        const qualifier = first.root.sectionId ?? null;
        for (const e of new SpecReviewAnnotations(document, { qualifier }).validate()) {
            if (MISSED.has(e.code)) { findings.push({ document: label, path: e.path, code: e.code, message: e.message }); }
        }
        const extract = extractAnswers(deps.service.model, document, { label, path: scope });
        extracts.push(extract);
        documents.push({ label, root: first.root.sectionId ?? first.root.type, files: fragments.map((f) => f.name), counts: extract.counts.toJson() });
    }
    const total = extracts.reduce((sum, x) => sum.plus(x.counts), new SpecAnswerCounts());
    const markdown = renderAnswers(extracts, new SpecAnswerRenderOptions({
        includeOpen: input.includeOpen === true,
        includeMarks: input.includeMarks === true,
        ...(input.title ? { title: input.title } : {}),
    }));
    return { extracts, documents, counts: total.toJson(), findings, markdown };
}

function answersFailure(e: unknown): string {
    if (e instanceof AnswersRefusal) { return json({ ok: false, code: e.code, error: e.message, ...e.details }); }
    return failure(e);
}

export async function specExtractAnswersImpl(deps: SpecToolDeps, input: SpecExtractAnswersInput): Promise<string> {
    try {
        const built = buildAnswers(deps, input);
        return json({
            ok: true,
            ...(input.path ? { path: input.path } : {}),
            counts: built.counts,
            documents: built.documents,
            findings: built.findings,
            ...(built.findings.length > 0 ? { complete: false } : {}),
            markdown: built.markdown,
        });
    } catch (e) {
        return answersFailure(e);
    }
}

export async function specWriteAnswersImpl(deps: SpecToolDeps, input: SpecWriteAnswersInput): Promise<string> {
    try {
        if (typeof input.output !== 'string' || input.output.trim() === '') {
            throw new AnswersRefusal('invalidInput', '`output` names the answers.md to write, e.g. `<step folder>/answers.md`.');
        }
        const target = resolveInput(deps, input.output);
        const built = buildAnswers(deps, input);
        if (built.findings.length > 0) {
            throw new AnswersRefusal('annotationsMalformed',
                'Some annotations cannot be read, so answers.md would miss them; fix them first (the findings name where). Nothing was written.',
                { findings: built.findings });
        }
        const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        const status = before === null ? 'new' : before === built.markdown ? 'unchanged' : 'changed';
        if (status === 'changed' && input.overwrite !== true) {
            throw new AnswersRefusal('exists',
                `${toWorkspacePath(deps, target)} exists with other text. Pass \`overwrite: true\` to replace it (see the diff with \`dryRun\`).`,
                { file: toWorkspacePath(deps, target) });
        }
        const write = !input.dryRun && status !== 'unchanged';
        if (write) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, built.markdown, 'utf8');
        }
        return json({
            ok: true,
            written: write,
            file: toWorkspacePath(deps, target),
            status,
            counts: built.counts,
            documents: built.documents,
            ...(input.dryRun ? { diff: unifiedDiff(before ?? '', built.markdown, path.basename(target)), markdown: built.markdown } : {}),
        });
    } catch (e) {
        return answersFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const WHAT =
    'The answers of a review round (SOM §11.9.7), as a step folder\'s `answers.md`: per document (labelled by its file '
    + 'name without the format suffix, e.g. `tom_uam.sbp`) the answered questions and the reviewer comments, each with '
    + 'its section-id chain, its line in the document\'s Markdown rendition, the question and its answer verbatim or the '
    + 'comment and its author; `includeOpen` adds the open questions, `includeMarks` the inline marks. Read through the '
    + 'runtime\'s extractAnswers / renderAnswers — the text tom_specs\' `extract_answers` CLI writes. `files` lists '
    + 'several documents in the order answers.md shows them; fragments of one root are assembled into one document. '
    + '`path` keeps the subtree at that path. The annotations stay in the documents (tomAi_specRemoveAllAnnotations '
    + 'removes them). Counts: answered, open, comments, marks.';
const INPUT_PROPS = {
    file: { ...FILE_PARAM, description: `${FILE_PARAM.description} Or pass \`files\`.` },
    files: { type: 'array', items: { type: 'string' }, description: 'Several documents (or fragments of one), in the order answers.md lists them.' },
    path: { type: 'string', description: `Only the subtree at this document path. ${PATH_PARAM_HINT}` },
    includeOpen: { type: 'boolean', description: 'Also list the questions still open. Default false.' },
    includeMarks: { type: 'boolean', description: 'Also list the inline marks. Default false.' },
    title: { type: 'string', description: 'The file\'s title. Default `Answers`.' },
};

export const SPEC_EXTRACT_ANSWERS_TOOL: SharedToolDefinition<SpecExtractAnswersInput> = {
    name: 'tomAi_specExtractAnswers',
    displayName: 'Spec: Extract Answers',
    description:
        WHAT + ' Answers `{counts, documents: [{label, root, files, counts}], findings, markdown}` and writes nothing; '
        + 'tomAi_specWriteAnswers writes the file. `findings` lists annotations the runtime cannot read (malformed, '
        + 'misplaced, duplicate id) — the extraction misses them, so `complete: false`.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: INPUT_PROPS },
    execute: async (input) => specExtractAnswersImpl(liveDeps(), input),
};

export const SPEC_WRITE_ANSWERS_TOOL: SharedToolDefinition<SpecWriteAnswersInput> = {
    name: 'tomAi_specWriteAnswers',
    displayName: 'Spec: Write Answers',
    description:
        WHAT + ' Writes it to `output` (inside the workspace; folders are created). Answers `{written, file, status '
        + '(new / changed / unchanged), counts, documents}`; an unchanged file is not touched. An existing file with other '
        + 'text is refused (`exists`) unless `overwrite: true`; `dryRun` returns the `diff` and the text and writes '
        + 'nothing. Annotations the runtime cannot read are refused (`annotationsMalformed`, with the findings): the file '
        + 'would miss them. Read the counts and the text first with tomAi_specExtractAnswers.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            ...INPUT_PROPS,
            output: { type: 'string', description: 'The answers.md to write, e.g. `<spec-root>/phase2_solution_blueprint/02_Deepening/answers.md`.' },
            overwrite: { type: 'boolean', description: 'Replace an existing file whose text differs. Default false.' },
            dryRun: { type: 'boolean', description: 'Return the diff and the text without writing. Default false.' },
        },
        required: ['output'],
    },
    approvalSummary: (input) => `Write the answers of ${(input.files ?? [input.file]).join(', ')} to ${input.output}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => specWriteAnswersImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_ANSWERS_TOOLS: SharedToolDefinition<any>[] = [SPEC_EXTRACT_ANSWERS_TOOL, SPEC_WRITE_ANSWERS_TOOL];
