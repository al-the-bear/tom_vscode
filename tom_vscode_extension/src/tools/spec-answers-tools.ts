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

/** A question the members answered one by one (SOM §11.9.8), beside its team answer. */
export interface IndividualAnswers {
    id: string;
    topic: string | null;
    path: string;
    field: string | null;
    /** The team answer; '' while the team has not answered. */
    teamAnswer: string;
    answers: Array<{ members: string[]; answer: string; changedAt: string | null }>;
}

interface AnswersBuild {
    extracts: SpecAnswerExtract[];
    documents: Array<{ label: string; root: string; files: string[]; counts: Record<string, number>; individualAnswers: IndividualAnswers[] }>;
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
        const notes = new SpecReviewAnnotations(document, { qualifier });
        const inScope = (p: string): boolean => !scope || p === scope || p.startsWith(`${scope}/`);
        const individualAnswers: IndividualAnswers[] = notes.list()
            .filter((a) => a.kind === 'question' && a.answers.length > 0 && inScope(a.path))
            .map((a) => ({
                id: a.id ?? '', topic: a.topic, path: a.path, field: a.field, teamAnswer: a.answer,
                answers: a.answers.map((x) => ({ members: [...x.members], answer: x.answer, changedAt: x.changedAt })),
            }));
        for (const e of notes.validate()) {
            if (MISSED.has(e.code)) { findings.push({ document: label, path: e.path, code: e.code, message: e.message }); }
        }
        const extract = extractAnswers(deps.service.model, document, { label, path: scope });
        extracts.push(extract);
        documents.push({ label, root: first.root.sectionId ?? first.root.type, files: fragments.map((f) => f.name), counts: extract.counts.toJson(), individualAnswers });
    }
    const total = extracts.reduce((sum, x) => sum.plus(x.counts), new SpecAnswerCounts());
    const markdown = renderAnswers(extracts, new SpecAnswerRenderOptions({
        includeOpen: input.includeOpen === true,
        includeMarks: input.includeMarks === true,
        ...(input.title ? { title: input.title } : {}),
    }));
    return { extracts, documents, counts: total.toJson(), findings, markdown: withIndividualAnswers(markdown, documents) };
}

/**
 * `answers.md` with each document's individual answers (SOM §11.9.8) as a
 * last section of its block: the runtime's rendering lists the team answer
 * only. A document whose members answered nothing one by one gets none.
 */
export function withIndividualAnswers(markdown: string, documents: AnswersBuild['documents']): string {
    const lines = markdown.replace(/\n$/, '').split('\n');
    const starts: number[] = [];
    let k = 0;
    for (const d of documents) {
        while (k < lines.length && lines[k] !== `## ${d.label}`) { k++; }
        starts.push(k);
        k++;
    }
    for (let i = documents.length - 1; i >= 0; i--) {
        const d = documents[i];
        if (!d.individualAnswers.length || starts[i] >= lines.length) { continue; }
        const end = i + 1 < documents.length ? starts[i + 1] : lines.length;
        const block = ['', '### Individual answers'];
        for (const q of d.individualAnswers) {
            block.push('', `#### ${q.id}${q.topic ? ` — ${q.topic}` : ''}`, '', `- **Path:** \`${q.path}\``);
            if (q.field) { block.push(`- **Field:** \`${q.field}\``); }
            block.push(`- **Team answer:**${q.teamAnswer ? ` ${q.teamAnswer.split('\n').join('\n  ')}` : ' (none yet)'}`);
            for (const a of q.answers) { block.push(`- **${a.members.join(', ')}:** ${a.answer.split('\n').join('\n  ')}`); }
        }
        // Before the blank line that separates the next document's heading.
        lines.splice(end < lines.length && lines[end - 1] === '' ? end - 1 : end, 0, ...block);
    }
    return `${lines.join('\n')}\n`;
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
        'A review round\'s answers (SOM §11.9.7) as the text of a step folder\'s `answers.md`, written nowhere: per document the answered questions (the team answer) and the comments with their section-id chain and line, and the members\' individual answers (§11.9.8, `individualAnswers` per document) (`includeOpen`, `includeMarks` add more); `files` takes several documents in order. Answers `{counts, documents, findings, markdown}`; `findings` (annotations the runtime cannot read) make it `complete: false`. tomAi_specWriteAnswers writes the file.' + FIRST_LOOK,
    tags: ['tomspecs', 'som', 'docspecs', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', properties: INPUT_PROPS },
    execute: async (input) => specExtractAnswersImpl(liveDeps(), input),
};

export const SPEC_WRITE_ANSWERS_TOOL: SharedToolDefinition<SpecWriteAnswersInput> = {
    name: 'tomAi_specWriteAnswers',
    displayName: 'Spec: Write Answers',
    description:
        'Write a review round\'s answers (SOM §11.9.7) to `output` as the step folder\'s `answers.md`: per document the answered questions and the comments (`includeOpen`, `includeMarks` add more); `files` takes several documents in order. An existing file with other text is refused (`exists`) unless `overwrite: true`; unreadable annotations are refused (`annotationsMalformed`). The annotations stay in the documents. Read it first with tomAi_specExtractAnswers.' + FIRST_LOOK,
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
