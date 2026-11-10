/**
 * A team review round (SOM §11.9.8, §11.9.9), files only (CC-64): the round
 * folder, the members' copies, their status, the merge and the conflict
 * decisions — through the TypeScript runtime's merge API (mergeReviews), for
 * TomSpecs documents and plain annotated Markdown alike.
 *
 *   tomAi_specReviewRoundCreate   the round folder: base, one copy per member, round.yaml
 *   tomAi_specReviewRoundStatus   per member: returned, valid, counts; guest copies (read-only)
 *   tomAi_specMergeReviews        merge the returned copies into merged/ with the report
 *   tomAi_specDecideConflicts     write conflict decisions (`**Decision:**`)
 *
 * The folder layout and the text rules are src/utils/reviewRound.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    SpecReviewAnnotations,
    SpecReviewMergeError,
    mergeReviews,
    type SpecDocument,
    type SpecReviewMember,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, SpecToolDeps, failure, json, liveDeps, resolveInput, toWorkspacePath } from './spec-tool-common';
import { EDIT_PARAMS, SpecEditRefusal, editFailure, runEdit } from './spec-edit-core';
import type { LoadedSomDocument } from '../services/som-document-store';
import { MEMBER_LIST, documentTeam, pathsOfClass, readTeamMembers } from '../services/review-team';
import {
    MERGED_FOLDER, MERGE_REPORT_FILE, ROUND_FILE, ROUND_FORMAT,
    checkTeam, copyFileName, defaultRoundFolderName, documentExtension, headingPaths, memberOfFile, parseRound,
    plainReviewCounts, setConflictDecisionText, stringifyRound, textConflicts,
    type ReviewRound, type RoundMember,
} from '../utils/reviewRound';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SpecReviewRoundCreateInput {
    /** The document to review: a TomSpecs document or a plain Markdown file. */
    file: string;
    /** The round folder; default `<document folder>/review-rounds/<stem>-<YYYYMMDD-HHMM>`. */
    round?: string;
    /** The team; default the document's own review team, else the blueprint's (SOM only). */
    members?: RoundMember[];
    /** The solution blueprint the team falls back to; default found beside the document or above it. */
    sbp?: string;
    /** The revision entry's author; default the team's owner, else the first member. */
    author?: string;
    /** The round's date (YYYY-MM-DD); default today. */
    date?: string;
}

export interface SpecReviewRoundStatusInput {
    round: string;
}

export interface SpecMergeReviewsInput {
    round: string;
    /** Names and roles of guests (copies from people not on the team); kept in round.yaml. */
    guests?: RoundMember[];
    /** Merge copies identical to the base too (a member who returned it unchanged). Default false. */
    includeUnchanged?: boolean;
    /** The id prefix of the questions the merge writes (default `RQ`). */
    questionPrefix?: string;
    dryRun?: boolean;
}

export interface SpecDecideConflictsInput {
    file: string;
    /** Conflict id → a letter of its alternatives, `base`, or rewritten text; '' reopens it. */
    decisions: Record<string, string>;
    expectedRevision?: string;
    dryRun?: boolean;
}

/** A refusal of a round tool: the code and what helps correct it. */
class RoundRefusal extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
        super(message);
    }
}

function roundFailure(e: unknown): string {
    if (e instanceof RoundRefusal) { return json({ ok: false, code: e.code, error: e.message, ...e.details }); }
    if (e instanceof SpecReviewMergeError) { return json({ ok: false, code: 'structureMismatch', error: e.message }); }
    return failure(e);
}

const today = (): string => {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ---------------------------------------------------------------------------
// The team (C-59, C-66): the document's own, else the blueprint's for its
// document type, else the blueprint's default; the most specific replaces.
// ---------------------------------------------------------------------------

/** The nodes of `className` under the blueprint's own root. */
function pathsOfSbpClass(deps: SpecToolDeps, doc: SpecDocument, className: string): string[] {
    return pathsOfClass(deps.service.model, doc, 'SBP', className);
}

/** `D04RequirementsSpecification` → `d04`. */
export function documentTypeCode(rootType: string): string | null {
    const m = /^D([0-9]{2})/.exec(rootType);
    return m ? `d${m[1]}` : null;
}

/** The solution blueprint beside the document or in a folder above it (inside the workspace). */
function findBlueprint(deps: SpecToolDeps, documentPath: string): string | null {
    let dir = path.dirname(documentPath);
    for (let level = 0; level < 5; level++) {
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { names = []; }
        for (const name of names.sort()) {
            if (!/\.(md|docspecs\.yaml)$/.test(name)) { continue; }
            const file = path.join(dir, name);
            if (file === documentPath) { continue; }
            const peek = deps.store.peek(file);
            if (peek && peek.root.sectionId === 'SBP') { return file; }
        }
        const up = path.dirname(dir);
        if (up === dir || path.relative(deps.wsRoot, up).startsWith('..')) { break; }
        dir = up;
    }
    return null;
}

interface TeamSource { members: Array<RoundMember & { owner?: boolean }>; source: string }

function resolveTeam(deps: SpecToolDeps, loaded: LoadedSomDocument, sbp: string | undefined): TeamSource | null {
    const rootId = loaded.root.sectionId;
    if (rootId) {
        const own = documentTeam(loaded.document, rootId);
        if (own.length) { return { members: own, source: 'document' }; }
    }
    const sbpPath = sbp ? resolveInput(deps, sbp) : findBlueprint(deps, loaded.filePath);
    if (!sbpPath) { return null; }
    const blueprint = deps.store.load(sbpPath);
    const where = toWorkspacePath(deps, sbpPath);
    const code = documentTypeCode(loaded.root.type);
    const entries = pathsOfSbpClass(deps, blueprint.document, 'DocumentReviewTeamEntry');
    for (const entry of entries) {
        // The enum names the type in full (`d04RequirementsSpecification`); its `d04` prefix is enough.
        const type = (blueprint.document.formField(`${entry}/content`, 'documentType') ?? '').trim();
        if (code && (type === code || type.startsWith(code))) {
            const members = readTeamMembers(blueprint.document, `${entry}/${MEMBER_LIST}`);
            if (members.length) { return { members, source: `${where} (${code})` }; }
        }
    }
    for (const team of pathsOfSbpClass(deps, blueprint.document, 'ReviewTeam')) {
        if (entries.some((e) => team.startsWith(`${e}/`))) { continue; }
        const members = readTeamMembers(blueprint.document, `${team}/${MEMBER_LIST}`);
        if (members.length) { return { members, source: `${where} (default team)` }; }
    }
    return null;
}

// ---------------------------------------------------------------------------
// The round folder
// ---------------------------------------------------------------------------

/** A plain Markdown file is one the store does not read as a SOM document. */
function isSomFile(deps: SpecToolDeps, absolute: string): boolean {
    return /\.docspecs\.yaml$/i.test(absolute) || deps.store.peek(absolute) !== null;
}

function readRound(deps: SpecToolDeps, roundInput: string): { folder: string; round: ReviewRound } {
    if (!roundInput) { throw new RoundRefusal('invalidInput', '`round` names the round folder (tomAi_specReviewRoundCreate answered it).'); }
    const folder = resolveInput(deps, roundInput);
    const file = path.join(folder, ROUND_FILE);
    if (!fs.existsSync(file)) { throw new RoundRefusal('notARound', `${toWorkspacePath(deps, folder)} has no ${ROUND_FILE}.`); }
    try {
        return { folder, round: parseRound(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
        throw new RoundRefusal('notARound', (e as Error).message);
    }
}

function writeRound(folder: string, round: ReviewRound): void {
    fs.writeFileSync(path.join(folder, ROUND_FILE), stringifyRound(round), 'utf8');
}

function ownerOf(team: ReadonlyArray<RoundMember & { owner?: boolean }>): RoundMember | undefined {
    return team.find((m) => m.owner) ?? team[0];
}

export async function specReviewRoundCreateImpl(deps: SpecToolDeps, input: SpecReviewRoundCreateInput): Promise<string> {
    try {
        if (!input.file) { throw new RoundRefusal('invalidInput', '`file` names the document to review.'); }
        const documentPath = resolveInput(deps, input.file);
        if (!fs.existsSync(documentPath)) { throw new RoundRefusal('notFound', `${input.file} does not exist.`); }
        const som = isSomFile(deps, documentPath);
        let team: TeamSource | null = null;
        if (input.members && input.members.length) {
            team = { members: input.members, source: 'members' };
        } else if (som) {
            team = resolveTeam(deps, deps.store.load(documentPath), input.sbp);
        }
        if (!team) {
            throw new RoundRefusal('noTeam', som
                ? 'Neither the document nor a solution blueprint names a review team; pass `members` ([{memberId, displayName, role}]).'
                : 'A plain Markdown file names no team; pass `members` ([{memberId, displayName, role}]).');
        }
        const members: RoundMember[] = team.members.map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role }));
        const bad = checkTeam(members);
        if (bad) { throw new RoundRefusal('invalidTeam', bad); }
        if (input.date !== undefined && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(input.date)) { throw new RoundRefusal('invalidInput', '`date` is YYYY-MM-DD.'); }

        const folder = input.round
            ? resolveInput(deps, input.round)
            : path.join(path.dirname(documentPath), 'review-rounds', defaultRoundFolderName(documentPath));
        if (fs.existsSync(path.join(folder, ROUND_FILE))) {
            throw new RoundRefusal('exists', `${toWorkspacePath(deps, folder)} already holds a round; name another \`round\` folder.`);
        }
        const extension = documentExtension(documentPath);
        const text = deps.store.readText(documentPath).text;
        const base = `base${extension}`;
        const round: ReviewRound = {
            format: ROUND_FORMAT,
            document: toWorkspacePath(deps, documentPath),
            kind: som ? 'som' : 'markdown',
            base,
            extension,
            created: new Date().toISOString(),
            date: input.date ?? today(),
            author: input.author ?? ownerOf(team.members)?.displayName ?? members[0].displayName,
            team: members,
            guests: [],
        };
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, base), text, 'utf8');
        const copies = members.map((m) => {
            const name = copyFileName(m.memberId, extension);
            fs.writeFileSync(path.join(folder, name), text, 'utf8');
            return { memberId: m.memberId, file: toWorkspacePath(deps, path.join(folder, name)) };
        });
        writeRound(folder, round);
        return json({
            ok: true,
            round: toWorkspacePath(deps, folder),
            document: round.document,
            kind: round.kind,
            teamSource: team.source,
            team: members,
            base: toWorkspacePath(deps, path.join(folder, base)),
            copies,
            next: 'Send each member their copy; each writes into their own file. tomAi_specReviewRoundStatus says who returned, tomAi_specMergeReviews merges.',
        });
    } catch (e) {
        return roundFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

interface CopyCheck {
    memberId: string;
    file: string;
    exists: boolean;
    returned: boolean;
    valid: boolean;
    problem?: string;
    counts?: Record<string, number>;
}

interface RoundContext {
    folder: string;
    round: ReviewRound;
    baseText: string;
    baseLoaded: LoadedSomDocument | null;
}

function roundContext(deps: SpecToolDeps, roundInput: string): RoundContext {
    const { folder, round } = readRound(deps, roundInput);
    const basePath = path.join(folder, round.base);
    if (!fs.existsSync(basePath)) { throw new RoundRefusal('notARound', `The round's base ${round.base} is missing.`); }
    return {
        folder, round,
        baseText: fs.readFileSync(basePath, 'utf8'),
        baseLoaded: round.kind === 'som' ? deps.store.load(basePath) : null,
    };
}

/** Checks one copy against the base: read, structure (a one-copy merge), counts. Never writes. */
function checkCopy(deps: SpecToolDeps, ctx: RoundContext, member: RoundMember): CopyCheck {
    const file = path.join(ctx.folder, copyFileName(member.memberId, ctx.round.extension));
    const view: CopyCheck = { memberId: member.memberId, file: toWorkspacePath(deps, file), exists: fs.existsSync(file), returned: false, valid: false };
    if (!view.exists) { return { ...view, problem: 'The copy is missing.' }; }
    const text = fs.readFileSync(file, 'utf8');
    view.returned = text !== ctx.baseText;
    const options = { team: ctx.round.team, date: ctx.round.date, author: ctx.round.author, model: deps.service.model };
    try {
        if (ctx.baseLoaded) {
            const copy = deps.store.load(file);
            if (copy.root.type !== ctx.baseLoaded.root.type) {
                return { ...view, problem: `The copy is a ${copy.root.type}, the base a ${ctx.baseLoaded.root.type}.` };
            }
            view.counts = new SpecReviewAnnotations(copy.document, { qualifier: copy.root.sectionId ?? null }).counts().toJson();
            mergeReviews(ctx.baseLoaded.document, [{ ...member, document: copy.document }], options);
        } else {
            view.counts = plainReviewCounts(text);
            const missing = headingPaths(ctx.baseText).filter((h) => !headingPaths(text).includes(h));
            if (missing.length) { return { ...view, problem: `Headings of the base are missing: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? ' …' : ''}` }; }
            mergeReviews(ctx.baseText, [{ ...member, document: text }], options);
        }
        view.valid = true;
        return view;
    } catch (e) {
        // A copy whose structure does not fit the base (CC-65, C-43), or one that does not read.
        return { ...view, problem: (e as Error).message };
    }
}

/** Files in the round folder that are copies of nobody on the team: guests' copies. */
function guestFiles(ctx: RoundContext): string[] {
    const team = new Set(ctx.round.team.map((m) => m.memberId));
    let names: string[] = [];
    try { names = fs.readdirSync(ctx.folder); } catch { names = []; }
    return names.filter((n) => {
        const id = memberOfFile(n, ctx.round.extension);
        return id !== null && !team.has(id);
    }).sort();
}

export async function specReviewRoundStatusImpl(deps: SpecToolDeps, input: SpecReviewRoundStatusInput): Promise<string> {
    try {
        const ctx = roundContext(deps, input.round);
        const members = ctx.round.team.map((m) => ({ displayName: m.displayName, role: m.role, ...checkCopy(deps, ctx, m) }));
        const guests = guestFiles(ctx).map((name) => {
            const memberId = memberOfFile(name, ctx.round.extension) as string;
            const known = ctx.round.guests.find((g) => g.memberId === memberId);
            const check = checkCopy(deps, ctx, known ?? { memberId, displayName: memberId, role: 'guest' });
            return { ...check, guest: true, named: Boolean(known), ...(known ? { displayName: known.displayName, role: known.role } : {}) };
        });
        return json({
            ok: true,
            round: toWorkspacePath(deps, ctx.folder),
            document: ctx.round.document,
            kind: ctx.round.kind,
            date: ctx.round.date,
            members,
            guests,
            summary: {
                members: members.length,
                returned: members.filter((m) => m.returned).length,
                invalid: [...members, ...guests].filter((m) => m.exists && !m.valid).length,
                guests: guests.length,
                unnamedGuests: guests.filter((g) => !g.named).length,
            },
            ...(ctx.round.merged ? { merged: ctx.round.merged } : {}),
        });
    } catch (e) {
        return roundFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export async function specMergeReviewsImpl(deps: SpecToolDeps, input: SpecMergeReviewsInput): Promise<string> {
    try {
        const ctx = roundContext(deps, input.round);
        const named = new Map(ctx.round.guests.map((g) => [g.memberId, g] as const));
        for (const g of input.guests ?? []) { named.set(g.memberId, g); }
        const guestNames = guestFiles(ctx).map((n) => memberOfFile(n, ctx.round.extension) as string);
        const unnamed = guestNames.filter((id) => !named.has(id) || !named.get(id)?.displayName || !named.get(id)?.role);
        if (unnamed.length) {
            throw new RoundRefusal('guestUnnamed',
                `Copies from people not on the team: ${unnamed.join(', ')}. Ask each one's name and role and pass them as \`guests\` ([{memberId, displayName, role}]); they are kept in ${ROUND_FILE}.`,
                { guests: unnamed });
        }
        const guests = guestNames.map((id) => named.get(id) as RoundMember);
        const bad = guests.length ? checkTeam(guests) : null;
        if (bad) { throw new RoundRefusal('invalidInput', `guests: ${bad}`); }

        const checks = [...ctx.round.team, ...guests].map((m) => ({ member: m, check: checkCopy(deps, ctx, m) }));
        const invalid = checks.filter((c) => c.check.exists && (input.includeUnchanged || c.check.returned) && !c.check.valid);
        if (invalid.length) {
            throw new RoundRefusal('structureMismatch',
                'Some copies do not fit the base, so nothing was merged; their reviewers fix them, or the copy is replaced by a fresh one.',
                { copies: invalid.map((c) => ({ memberId: c.member.memberId, file: c.check.file, problem: c.check.problem })) });
        }
        const merging = checks.filter((c) => c.check.exists && (input.includeUnchanged || c.check.returned));
        if (!merging.length) { throw new RoundRefusal('nothingReturned', 'No copy differs from the base yet: nobody has returned one.'); }
        const notReturned = checks.filter((c) => !merging.includes(c)).map((c) => c.member.memberId);

        const options = {
            team: ctx.round.team, date: ctx.round.date, author: ctx.round.author, model: deps.service.model,
            ...(input.questionPrefix ? { questionPrefix: input.questionPrefix } : {}),
        };
        const docName = path.basename(ctx.round.document);
        const mergedPath = path.join(ctx.folder, MERGED_FOLDER, docName);
        const reportPath = path.join(ctx.folder, MERGED_FOLDER, MERGE_REPORT_FILE);
        let mergedText: string;
        let report: Record<string, unknown>;
        if (ctx.baseLoaded) {
            const copies = merging.map((c) => ({ ...c.member, document: deps.store.load(path.join(ctx.folder, copyFileName(c.member.memberId, ctx.round.extension))).document }));
            const result = mergeReviews(ctx.baseLoaded.document, copies, options);
            mergedText = deps.store.render({ ...ctx.baseLoaded, document: result.merged });
            report = result.report.toJson();
        } else {
            const copies = merging.map((c) => ({ ...c.member, document: fs.readFileSync(path.join(ctx.folder, copyFileName(c.member.memberId, ctx.round.extension)), 'utf8') }));
            const result = mergeReviews(ctx.baseText, copies, options);
            mergedText = result.merged;
            report = result.report.toJson();
        }
        const conflicts = (report.conflicts as unknown[] | undefined)?.length ?? 0;
        if (!input.dryRun) {
            fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
            fs.writeFileSync(mergedPath, mergedText, 'utf8');
            fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
            writeRound(ctx.folder, {
                ...ctx.round,
                guests,
                merged: { at: new Date().toISOString(), file: `${MERGED_FOLDER}/${docName}`, report: `${MERGED_FOLDER}/${MERGE_REPORT_FILE}` },
            });
        }
        return json({
            ok: true,
            written: !input.dryRun,
            round: toWorkspacePath(deps, ctx.folder),
            merged: toWorkspacePath(deps, mergedPath),
            reportFile: toWorkspacePath(deps, reportPath),
            mergedCopies: merging.map((c) => c.member.memberId),
            notReturned,
            summary: {
                conflicts,
                votes: (report.votes as unknown[] | undefined)?.length ?? 0,
                unanimous: (report.unanimous as unknown[] | undefined)?.length ?? 0,
                answers: (report.answers as unknown[] | undefined)?.length ?? 0,
                comments: (report.comments as unknown[] | undefined)?.length ?? 0,
                additions: (report.additions as unknown[] | undefined)?.length ?? 0,
                guestQuestions: (report.guestQuestions as unknown[] | undefined)?.length ?? 0,
            },
            report,
            ...(input.dryRun ? { mergedText } : {}),
            next: conflicts
                ? `Decide the ${conflicts} conflict(s) in the merged document with tomAi_specDecideConflicts (tomAi_specAnnotations lists them).`
                : 'No conflicts: review the merged document; tomAi_specRemoveAllAnnotations finishes it once every question is answered.',
        });
    } catch (e) {
        return roundFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Conflict decisions
// ---------------------------------------------------------------------------

function checkDecisions(decisions: unknown): Array<[string, string]> {
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
        throw new SpecEditRefusal('invalidInput', '`decisions` maps conflict ids to a decision, e.g. {"X-1": "a", "X-2": "base"}.');
    }
    const entries = Object.entries(decisions as Record<string, unknown>);
    if (!entries.length) { throw new SpecEditRefusal('invalidInput', '`decisions` is empty.'); }
    for (const [id, d] of entries) {
        if (!/^X-[1-9][0-9]*$/.test(id)) { throw new SpecEditRefusal('invalidInput', `"${id}" is not a conflict id (X-<n>).`); }
        if (typeof d !== 'string') { throw new SpecEditRefusal('invalidInput', `The decision for ${id} is not text.`); }
    }
    return entries as Array<[string, string]>;
}

function decideInText(text: string, id: string, decision: string): string | null {
    try {
        return setConflictDecisionText(text, id, decision);
    } catch (e) {
        throw new SpecEditRefusal('unknownAlternative', (e as Error).message);
    }
}

export async function specDecideConflictsImpl(deps: SpecToolDeps, input: SpecDecideConflictsInput): Promise<string> {
    let absolute: string;
    try {
        absolute = resolveInput(deps, input.file);
    } catch (e) {
        return failure(e);
    }
    if (isSomFile(deps, absolute)) {
        return runEdit(deps, input, (ctx) => {
            const entries = checkDecisions(input.decisions);
            const conflicts = new SpecReviewAnnotations(ctx.loaded.document).list().filter((a) => a.kind === 'conflict');
            const touched: string[] = [];
            for (const [id, decision] of entries) {
                const at = conflicts.find((c) => c.id === id);
                if (!at) { throw new SpecEditRefusal('unknownConflict', `The document has no conflict ${id}; it has ${conflicts.map((c) => c.id).join(', ') || 'none'}.`); }
                const doc = ctx.loaded.document;
                const value = (at.field ? doc.formField(at.path, at.field) : doc.content(at.path)) ?? '';
                const next = decideInText(value, id, decision);
                if (next === null) { throw new SpecEditRefusal('unknownConflict', `The conflict ${id} is not where it was listed.`); }
                if (at.field) { doc.setFormField(at.path, at.field, next); } else { doc.setContent(at.path, next); }
                touched.push(at.path);
            }
            const after = new SpecReviewAnnotations(ctx.loaded.document).list().filter((a) => a.kind === 'conflict');
            return {
                touched,
                result: {
                    decided: entries.map(([id, decision]) => ({ id, decision: decision.trim() })),
                    openConflicts: after.filter((c) => c.open || c.unresolved).map((c) => c.id),
                },
            };
        });
    }
    try {
        if (!/\.md$/i.test(absolute)) { throw new SpecEditRefusal('invalidInput', `Not a TomSpecs document or a Markdown file: ${input.file}`); }
        const entries = checkDecisions(input.decisions);
        const { text, revision } = deps.store.readText(absolute);
        let next = text;
        for (const [id, decision] of entries) {
            const written = decideInText(next, id, decision);
            if (written === null) {
                throw new SpecEditRefusal('unknownConflict', `The file has no conflict ${id}; it has ${textConflicts(text).map((c) => c.id).join(', ') || 'none'}.`);
            }
            next = written;
        }
        const saved = await deps.store.writeText(absolute, next, { baseRevision: revision, expectedRevision: input.expectedRevision, dryRun: input.dryRun });
        return json({
            ok: true,
            written: saved.written,
            revision: saved.revision,
            file: toWorkspacePath(deps, absolute),
            decided: entries.map(([id, decision]) => ({ id, decision: decision.trim() })),
            openConflicts: textConflicts(next).filter((c) => !c.decision || /^open:/i.test(c.decision)).map((c) => c.id),
            ...(input.dryRun ? { diff: saved.diff } : {}),
        });
    } catch (e) {
        return editFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ROUND_PARAM = { type: 'string', description: 'The round folder (workspace-relative or absolute), as tomAi_specReviewRoundCreate answered it.' };
const MEMBER_SCHEMA = {
    type: 'object',
    properties: {
        memberId: { type: 'string', description: 'Lowercase letters, digits and `_`, e.g. `alice`.' },
        displayName: { type: 'string' },
        role: { type: 'string', description: 'e.g. `product owner`, `architect`.' },
    },
    required: ['memberId', 'displayName', 'role'],
};
const FOLDER =
    ' The round folder (files only): `round.yaml` (document, base, team, guests, last merge), `base.<ext>` (the document as sent out), one copy per member named by member id (`alice.<ext>`, nothing written into it), `merged/` (the merged document and `merge-report.json`). TomSpecs documents and plain annotated Markdown alike; for a TomSpecs document look first with tomAi_specOutline or tomAi_specReflect.';

export const SPEC_REVIEW_ROUND_CREATE_TOOL: SharedToolDefinition<SpecReviewRoundCreateInput> = {
    name: 'tomAi_specReviewRoundCreate',
    displayName: 'Spec: Create Review Round',
    description:
        'Start a team review round (SOM §11.9.8) of a TomSpecs document or a plain Markdown file: the round folder with the base and one copy per member. The team is `members`, else the document\'s own review team, else the solution blueprint\'s team for its document type, else the blueprint\'s default team (the blueprint `sbp`, or found beside the document or above it); a plain Markdown file needs `members`. Refused: no team (`noTeam`), a member id twice or not `[a-z0-9_]+` (`invalidTeam`), a folder that already holds a round (`exists`).' + FOLDER,
    tags: ['tomspecs', 'som', 'docspecs', 'review', 'files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file'],
        properties: {
            file: { ...FILE_PARAM, description: 'The document to review: a TomSpecs document or a plain Markdown file, workspace-relative or absolute.' },
            round: { type: 'string', description: 'The round folder. Default `<document folder>/review-rounds/<stem>-<YYYYMMDD-HHMM>`.' },
            members: { type: 'array', items: MEMBER_SCHEMA, description: 'The team, in order. Default: the document\'s or the blueprint\'s review team.' },
            sbp: { type: 'string', description: 'The solution blueprint whose teams apply. Default: found beside the document or in a folder above it.' },
            author: { type: 'string', description: 'The merged revision entry\'s author. Default: the team\'s owner, else the first member.' },
            date: { type: 'string', description: 'The round\'s date, YYYY-MM-DD (the revision entry\'s, and generated item ids\'). Default today.' },
        },
    },
    approvalSummary: (input) => `Create a review round for ${input.file}${input.round ? ` in ${input.round}` : ''}`,
    execute: async (input) => specReviewRoundCreateImpl(liveDeps(), input),
};

export const SPEC_REVIEW_ROUND_STATUS_TOOL: SharedToolDefinition<SpecReviewRoundStatusInput> = {
    name: 'tomAi_specReviewRoundStatus',
    displayName: 'Spec: Review Round Status',
    description:
        'Where a team review round stands, per member: `exists`, `returned` (the copy differs from the base), `valid` (it reads and its structure fits the base; a copy that does not is reported with its `problem`, CC-65), and its annotation `counts`. `guests` lists copies of people not on the team (`named` once their name and role are in round.yaml). Writes nothing.' + FOLDER,
    tags: ['tomspecs', 'som', 'docspecs', 'review', 'files', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: { type: 'object', required: ['round'], properties: { round: ROUND_PARAM } },
    execute: async (input) => specReviewRoundStatusImpl(liveDeps(), input),
};

export const SPEC_MERGE_REVIEWS_TOOL: SharedToolDefinition<SpecMergeReviewsInput> = {
    name: 'tomAi_specMergeReviews',
    displayName: 'Spec: Merge Reviews',
    description:
        'Merge a round\'s returned copies (SOM §11.9.9, the runtime\'s mergeReviews) into `merged/<document>` in the team notation — marks naming their authors and votes, individual answers `**Answer (alice, bob):**`, conflict blocks `X-<n>` where members changed one passage differently, a question proposing each guest — and write the report (conflicts, votes, unanimous, answers, comments, additions, guestQuestions, revision) to `merged/merge-report.json`. Copies identical to the base are left out unless `includeUnchanged`. Refused, nothing written: a guest copy without name and role (`guestUnnamed`: ask, pass `guests`), a copy that does not fit the base (`structureMismatch`), nothing returned (`nothingReturned`). `dryRun` answers the merged text. Then tomAi_specDecideConflicts; tomAi_describeTool has the long form.' + FOLDER,
    tags: ['tomspecs', 'som', 'docspecs', 'review', 'edit', 'files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['round'],
        properties: {
            round: ROUND_PARAM,
            guests: { type: 'array', items: MEMBER_SCHEMA, description: 'Name and role of each guest copy\'s reviewer (its file name is the member id); kept in round.yaml.' },
            includeUnchanged: { type: 'boolean', description: 'Merge copies identical to the base too. Default false.' },
            questionPrefix: { type: 'string', description: 'The id prefix of the questions the merge writes. Default `RQ`.' },
            dryRun: { type: 'boolean', description: 'Answer the merged text and the report, write nothing. Default false.' },
        },
    },
    approvalSummary: (input) => `Merge the review round ${input.round}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => specMergeReviewsImpl(liveDeps(), input),
};

export const SPEC_DECIDE_CONFLICTS_TOOL: SharedToolDefinition<SpecDecideConflictsInput> = {
    name: 'tomAi_specDecideConflicts',
    displayName: 'Spec: Decide Conflicts',
    description:
        'Decide conflict blocks (SOM §11.9.8) of a merged TomSpecs document or plain Markdown file, like tomAi_specDecideMarks for marks: `decisions` maps `X-<n>` to a letter of its alternatives (written `(a)`), `base` (keep the base text, written `(base)`), or rewritten text (`open: …` hands it back); "" reopens it. The decision is written after the block\'s `> **Decision:**`; tomAi_specRemoveAllAnnotations applies it. Refused, nothing written: an unknown conflict (`unknownConflict`), a letter it has no alternative for (`unknownAlternative`). Answers `decided` and the `openConflicts` left. Written like every edit: refused when the file is dirty in an editor or has changed since `expectedRevision`; `dryRun` answers the diff. tomAi_specAnnotations lists a TomSpecs document\'s conflicts; look first with tomAi_specOutline or tomAi_specReflect.',
    tags: ['tomspecs', 'som', 'docspecs', 'review', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file', 'decisions'],
        properties: {
            ...EDIT_PARAMS,
            file: { ...FILE_PARAM, description: 'The merged document: a TomSpecs document or a plain Markdown file.' },
            decisions: { type: 'object', additionalProperties: { type: 'string' }, description: 'Conflict id → decision, e.g. {"X-1": "a", "X-2": "base", "X-3": "The limit is 150 EUR."}.' },
        },
    },
    approvalSummary: (input) => `Decide ${Object.keys(input.decisions ?? {}).join(', ')} in ${input.file}${input.dryRun ? ' (dry run)' : ''}`,
    execute: async (input) => specDecideConflictsImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_REVIEW_ROUND_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_REVIEW_ROUND_CREATE_TOOL,
    SPEC_REVIEW_ROUND_STATUS_TOOL,
    SPEC_MERGE_REVIEWS_TOOL,
    SPEC_DECIDE_CONFLICTS_TOOL,
];

export type { SpecReviewMember };
