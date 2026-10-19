/**
 * The CodeSpecs workflow guides — the documents Phase 4 of TomSpecs is written
 * in — and the stage runbooks built from them.
 *
 * - `prompt`  — codespecs_prompt.md (tom_specs_model/doc in ai_build): the run
 *   procedure: Stage A, the extraction run, Stage B, Stage C, the prompt.
 * - `mapping` — codespecs_mapping.md (tom_core_codespecs/doc in tom_ai/core):
 *   the concepts, the Phase-4 contract, the todo tree, the parts catalogue.
 *
 * Both are packaged in `<extension>/resources/codespecs/` by
 * scripts/build-som-packages.cjs, so an agent outside this workspace reads
 * them too: through tomAi_specCodeSpecsGuide (every transport) and as MCP
 * resources and prompts of the extension's MCP server.
 *
 * A section is addressed by its number (`6.2`, `1.1.2`) and is its whole
 * subtree; an unnumbered subheading belongs to the section above it.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

const RESOURCES = path.resolve(__dirname, '..', '..', 'resources', 'codespecs');

export interface GuideInfo {
    id: 'prompt' | 'mapping';
    title: string;
    /** The packaged copy. */
    file: string;
    /** Where it comes from, for people. */
    source: string;
    summary: string;
}

export const GUIDES: readonly GuideInfo[] = [
    {
        id: 'prompt',
        title: 'CodeSpecs Starting Prompt (the Phase-4 run procedure)',
        file: path.join(RESOURCES, 'codespecs_prompt.md'),
        source: 'tom_ai/ai_build/tom_specs_model/doc/codespecs_prompt.md',
        summary: 'What a run is handed and hands back; Stage A (A1–A5), the extraction run, Stage B verdicts, Stage C todo tree, the prompt.',
    },
    {
        id: 'mapping',
        title: 'CodeSpecs Mapping (concepts and contract)',
        file: path.join(RESOURCES, 'codespecs_mapping.md'),
        source: 'tom_ai/core/tom_core_codespecs/doc/codespecs_mapping.md',
        summary: 'Purpose, the Phase-4 production contract and run procedure (§1.1), the todo tree, the parts catalogue, slices and authoring order (§4.4), DocSpecs ↔ CodeSpecs linking (§9).',
    },
];

export interface GuideSection {
    /** The section number, e.g. `6.2`. */
    number: string;
    title: string;
    /** Heading level (2 for `##`). */
    level: number;
    /** 1-based heading line. */
    line: number;
}

interface ParsedSection extends GuideSection {
    /** 0-based index of the heading line and of the first line after the subtree. */
    start: number;
    end: number;
}

const NUMBERED = /^(#{2,6})\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/;
const ANY_HEADING = /^(#{1,6})\s/;

function parse(lines: string[]): ParsedSection[] {
    const heads: Array<{ level: number; number?: string; title: string; index: number }> = [];
    let fenced = false;
    lines.forEach((l, index) => {
        if (/^\s*```/.test(l)) { fenced = !fenced; return; }
        if (fenced) { return; }
        const m = NUMBERED.exec(l);
        if (m) { heads.push({ level: m[1].length, number: m[2], title: m[3].trim(), index }); return; }
        const any = ANY_HEADING.exec(l);
        if (any) { heads.push({ level: any[1].length, title: l, index }); }
    });
    const out: ParsedSection[] = [];
    heads.forEach((h, i) => {
        if (!h.number) { return; }
        const next = heads.slice(i + 1).find((x) => x.level <= h.level && x.number !== undefined || x.level < h.level);
        out.push({ number: h.number, title: h.title, level: h.level, line: h.index + 1, start: h.index, end: next ? next.index : lines.length });
    });
    return out;
}

/** The numbered sections of a guide's text, in document order. */
export function parseGuide(text: string): GuideSection[] {
    return parse(text.split('\n')).map(({ number, title, level, line }) => ({ number, title, level, line }));
}

function guideInfo(id: string): GuideInfo | undefined {
    return GUIDES.find((g) => g.id === id);
}

function readGuide(file: string): string {
    if (!fs.existsSync(file)) {
        throw new Error(`The CodeSpecs guide is missing at ${file}. Run \`npm run som:pack\` in the extension (it copies the guides into resources/codespecs/).`);
    }
    return fs.readFileSync(file, 'utf8');
}

/** A guide's outline: its numbered sections. */
export function guideOutline(id: string): GuideInfo & { sections: GuideSection[] } {
    const g = guideInfo(id);
    if (!g) { throw new Error(`Unknown guide "${id}". Guides: ${GUIDES.map((x) => x.id).join(', ')}.`); }
    return { ...g, sections: parseGuide(readGuide(g.file)) };
}

/** The whole text of a guide. */
export function guideText(id: string): string {
    const g = guideInfo(id);
    if (!g) { throw new Error(`Unknown guide "${id}". Guides: ${GUIDES.map((x) => x.id).join(', ')}.`); }
    return readGuide(g.file);
}

export const DEFAULT_SECTION_LIMIT = 60_000;

export type GuideSectionResult =
    | { ok: true; number: string; title: string; line: number; text: string; truncated?: boolean; children?: GuideSection[] }
    | { ok: false; error: string };

/**
 * One section of the guide at `file`, its whole subtree. Longer than `limit`
 * characters, it answers its own text up to its first subsection and lists
 * its children, so the caller reads them one at a time.
 */
export function guideSection(file: string, number: string, limit: number = DEFAULT_SECTION_LIMIT): GuideSectionResult {
    const lines = readGuide(file).split('\n');
    const sections = parse(lines);
    const wanted = number.trim().replace(/^§/, '').replace(/\.$/, '');
    const s = sections.find((x) => x.number === wanted);
    if (!s) {
        return { ok: false, error: `No section ${wanted}. Sections: ${sections.map((x) => x.number).join(', ')}.` };
    }
    const text = lines.slice(s.start, s.end).join('\n').trimEnd();
    if (text.length <= limit) { return { ok: true, number: s.number, title: s.title, line: s.line, text }; }
    const children = sections.filter((c) => c.start > s.start && c.end <= s.end && c.level === Math.min(
        ...sections.filter((x) => x.start > s.start && x.end <= s.end).map((x) => x.level)));
    const ownEnd = children.length > 0 ? children[0].start : s.end;
    return {
        ok: true, number: s.number, title: s.title, line: s.line, truncated: true,
        text: lines.slice(s.start, ownEnd).join('\n').trimEnd().slice(0, limit),
        children: children.map(({ number: n, title, level, line }) => ({ number: n, title, level, line })),
    };
}

// ---------------------------------------------------------------------------
// Stage runbooks
// ---------------------------------------------------------------------------

export interface RunbookArgument {
    name: 'file' | 'questId' | 'step' | 'shared';
    description: string;
    required: boolean;
}

export interface Runbook {
    name: string;
    title: string;
    description: string;
    arguments: RunbookArgument[];
    /** The instructions; `{file}`, `{questId}`, `{step}`, `{shared}` are filled in. */
    body: string;
    /** Guide sections appended to the instructions. */
    guideSections: Array<{ guide: GuideInfo['id']; section: string }>;
}

const FILE_ARG: RunbookArgument = { name: 'file', description: 'The specification document (`*.docspecs.yaml` or SOM Markdown).', required: true };
const QUEST_ARG: RunbookArgument = { name: 'questId', description: 'The quest the Phase-4 todo tree lives in.', required: false };

export const RUNBOOKS: readonly Runbook[] = [
    {
        name: 'codespecs-next-step',
        title: 'CodeSpecs: do the next Phase-4 step',
        description: 'Find where a specification is in Phase 4 and do the next step.',
        arguments: [FILE_ARG, QUEST_ARG, { name: 'shared', description: 'The generated <app>_codespec_shared folder, once the trio exists.', required: false }],
        body: [
            'Phase 4 turns the specification {file} into code-generation inputs. Call tomAi_specCodeSpecsStatus with',
            '`file: "{file}"` (and `questId: "{questId}"`, `shared: "{shared}"` when given). It answers every stage in order —',
            'Stage A gate, extraction, Stage B verdicts, the todo tree (Stage C), authoring, validation — and `next`: the',
            'first stage that is not done, with the tool that moves it. Do that step, following the runbook of its stage',
            '(tomAi_specCodeSpecsGuide with `runbook`), then call tomAi_specCodeSpecsStatus again to confirm it moved.',
            'Never work around a failing stage: the fix belongs in the specification.',
        ].join('\n'),
        guideSections: [{ guide: 'mapping', section: '1.1.2' }],
    },
    {
        name: 'codespecs-stage-a',
        title: 'CodeSpecs Stage A: the mechanical gate',
        description: 'Run Stage A (A1–A5) on a specification and fix what fails, in the specification.',
        arguments: [FILE_ARG],
        body: [
            'Run tomAi_specCodeSpecsGate on {file}. For each failing check read its findings: each names the document path',
            'to fix (A5 findings are model-level and are reported, not fixed in the document). Fix A1/A2/A4 findings with',
            'the spec edit tools (tomAi_specApplyEdits, tomAi_specSetFormField, …) after reading the node with',
            'tomAi_specOutline / tomAi_specGetSection; an A3 (routing) finding is fixed in the model, not the document',
            '(tomAi_specCodeSpecsRouting shows the unrouted classes). Run the gate again until it is open.',
        ].join('\n'),
        guideSections: [{ guide: 'prompt', section: '3' }, { guide: 'prompt', section: '4' }],
    },
    {
        name: 'codespecs-extraction',
        title: 'CodeSpecs: the extraction run',
        description: 'Write (or refresh) the per-area extracts of a specification.',
        arguments: [FILE_ARG],
        body: [
            'Run tomAi_specCodeSpecsWriteExtracts on {file} with `dryRun: true` first: it lists every extract file as new,',
            'changed or unchanged. Then run it without dryRun to write them beside the document',
            '(generated-doc/codespecs_extracts/). Read an area\'s extract with tomAi_specCodeSpecsExtract.',
        ].join('\n'),
        guideSections: [{ guide: 'prompt', section: '5' }],
    },
    {
        name: 'codespecs-stage-b',
        title: 'CodeSpecs Stage B: a verdict per area',
        description: 'Record a Stage-B verdict for every active area.',
        arguments: [FILE_ARG],
        body: [
            'tomAi_specCodeSpecsVerdicts on {file} lists the verdicts recorded and the active areas still `missing`. For',
            'each missing area read its extract (tomAi_specCodeSpecsExtract with `area`) and the area itself',
            '(tomAi_specCodeSpecsAreas), answer the fixed question, and record the verdict with',
            'tomAi_specCodeSpecsSetVerdict: sufficient, not applicable, or insufficient with one gap line per missing',
            'input (sectionId, required, carrier). An empty extract is a candidate for "not applicable", never the verdict.',
        ].join('\n'),
        guideSections: [{ guide: 'prompt', section: '6' }],
    },
    {
        name: 'codespecs-stage-c',
        title: 'CodeSpecs Stage C: the todo tree',
        description: 'Create the csopen / csproj / csgen todo tree from the gate record.',
        arguments: [FILE_ARG, QUEST_ARG],
        body: [
            'Run tomAi_specCodeSpecsPlanTodos with `file: "{file}"`, `questId: "{questId}"` and `dryRun: true`; check the',
            'proposed csopen (open questions, decision-needed), csproj1 (the trio scaffolding) and csgen1–31 (the authoring',
            'steps). Then run it without dryRun. It is idempotent: items already in the quest are reported, not duplicated.',
        ].join('\n'),
        guideSections: [{ guide: 'prompt', section: '7' }, { guide: 'mapping', section: '1.1.3' }],
    },
    {
        name: 'codespecs-authoring-step',
        title: 'CodeSpecs: one authoring step',
        description: 'Do one authoring step (csgen<n>) of the Phase-4 todo tree.',
        arguments: [FILE_ARG, { name: 'step', description: 'The authoring step number, 1–31.', required: true }],
        body: [
            'Authoring step csgen{step} for {file}: read everything the step may read with tomAi_specCodeSpecsStepContext',
            '(`file: "{file}"`, `step: {step}`) — its areas\' extracts, the contract entries for their markers, the output',
            'project — and nothing else (not the Phase-3 documents). Write the step\'s code into that project, analyze it',
            'clean, commit, and mark csgen{step} completed.',
        ].join('\n'),
        guideSections: [{ guide: 'mapping', section: '4.4.6' }],
    },
    {
        name: 'codespecs-validate',
        title: 'CodeSpecs: validate the generated trio',
        description: 'Run the derivation-contract checks over the generated trio and trace what fails.',
        arguments: [FILE_ARG, { name: 'shared', description: 'The generated <app>_codespec_shared folder.', required: true }],
        body: [
            'Run tomAi_specCodeSpecsValidate with `shared: "{shared}"` and the run\'s extracts',
            '(`extractsDir`: generated-doc/codespecs_extracts beside {file}). Every violation names its check and file;',
            'tomAi_specCodeSpecsTrace connects a token to its spec path and the declarations citing it. Send each',
            'violation back to the authoring step that wrote the code. `notRun` checks did not pass: give their input.',
        ].join('\n'),
        guideSections: [{ guide: 'mapping', section: '9.3' }, { guide: 'mapping', section: '9.6' }],
    },
];

/** A runbook with its arguments filled in and its guide sections appended. */
export function runbookText(name: string, args: Partial<Record<RunbookArgument['name'], string>>): { ok: true; title: string; text: string } | { ok: false; error: string } {
    const r = RUNBOOKS.find((x) => x.name === name);
    if (!r) { return { ok: false, error: `Unknown runbook "${name}". Runbooks: ${RUNBOOKS.map((x) => x.name).join(', ')}.` }; }
    const body = r.body.replace(/\{(file|questId|step|shared)\}/g, (_m, k: RunbookArgument['name']) => args[k] ?? `<${k}>`);
    const parts = [`# ${r.title}`, '', body];
    for (const ref of r.guideSections) {
        const g = GUIDES.find((x) => x.id === ref.guide) as GuideInfo;
        const s = guideSection(g.file, ref.section);
        parts.push('', '---', '', `From the guide (${ref.guide} §${ref.section}):`, '', s.ok ? s.text : s.error);
    }
    return { ok: true, title: r.title, text: parts.join('\n') };
}
