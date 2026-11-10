/**
 * The TomSpecs process checks: tom_specs_clitool's `spec_checks`
 * (doc/process_checks.md there), compiled into `<extension>/bin/<platform>/`
 * by scripts/build-validate-codespecs.cjs, run here and its lines read back
 * as structure — one finding per line, the summary counts, the exit verdict.
 *
 * Exit codes: 0 clean, 1 findings, 2 a usage error or a refused import. The
 * project's data comes from `<spec root>/checks/`; the spec root is the
 * nearest folder above the document holding `checks/`, else the document
 * folder's parent, unless `--spec-root` names it.
 *
 * Only the reading is here; the tools (src/tools/spec-checks-tools.ts) choose
 * the arguments and do the writes. vscode-free.
 */

import { runDartBinary, type BinaryRun } from './dartBinariesStatus';

/** The checks the tools run (`validate` and `accept-marks` have tools of their own: tomAi_specValidate, tomAi_specDecideMarks). */
export type SpecCheck =
    | 'import-answers' | 'required-fields' | 'question-register' | 'feature-register'
    | 'project-idea-coverage' | 'authorization' | 'coverage';

/** A large Blueprint (16 MB YAML) takes seconds per check; a hung binary must still not hang a tool call. */
export const SPEC_CHECKS_TIMEOUT_MS = 5 * 60_000;

/** Run `spec_checks [--spec-root <dir>] <check> <args>`. */
export function runSpecChecks(check: SpecCheck, args: string[], options: { specRoot?: string; extensionRoot?: string } = {}): Promise<BinaryRun> {
    const head = options.specRoot ? ['--spec-root', options.specRoot] : [];
    return runDartBinary('spec_checks', [...head, check, ...args], { timeoutMs: SPEC_CHECKS_TIMEOUT_MS, extensionRoot: options.extensionRoot });
}

export interface SpecCheckFinding {
    /** The line's tag (`MISSING`, `TYPE`, `FEATURES`, `REGISTER`, `UNKNOWN`, `uncovered`, `REJECTED`, `REFUSED`, `SCHEMA`, `INSTANCE`, …) or the authorization check's name. */
    kind: string;
    text: string;
}

/** What one run says, read back. */
export interface SpecCheckReport {
    check: SpecCheck;
    exitCode: number;
    /** 0 clean, 1 findings, 2 usage error / refused import. */
    outcome: 'clean' | 'findings' | 'usageError' | 'refused';
    findings: SpecCheckFinding[];
    /** The check's summary line(s), as numbers where they are counts. */
    summary: Record<string, unknown>;
    /** Lines of stdout no rule read (kept so nothing the check said is lost). */
    lines: string[];
    /** stderr lines that are not findings (a usage text, a decode failure). */
    stderr: string[];
}

const linesOf = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.trim() !== '');

/** The report of a run: the exit verdict and the check's lines, read by its rules. */
export function readSpecCheckRun(check: SpecCheck, run: BinaryRun): SpecCheckReport {
    const report: SpecCheckReport = {
        check,
        exitCode: run.exitCode,
        outcome: run.exitCode === 0 ? 'clean' : run.exitCode === 1 ? 'findings' : 'usageError',
        findings: [],
        summary: {},
        lines: [],
        stderr: [],
    };
    READERS[check](linesOf(run.stdout), linesOf(run.stderr), report);
    if (run.exitCode === 2 && report.findings.some((f) => f.kind === 'REFUSED')) { report.outcome = 'refused'; }
    return report;
}

type Reader = (out: string[], err: string[], r: SpecCheckReport) => void;

/** `TAG  text` lines become findings of that tag; the rest goes to `rest`. */
function tagged(lines: string[], tags: string[], r: SpecCheckReport, rest: string[]): void {
    for (const line of lines) {
        const m = /^([A-Z]+(?: FAILED)?)\s+(.*)$/.exec(line);
        if (m && tags.includes(m[1])) { r.findings.push({ kind: m[1], text: m[2] }); } else { rest.push(line); }
    }
}

const num = (s: string): number => Number(s);

/* eslint-disable @typescript-eslint/naming-convention -- keyed by the CLI's check names */
const READERS: Record<SpecCheck, Reader> = {
    'required-fields': (out, err, r) => {
        const rest: string[] = [];
        tagged(out, ['MISSING', 'TYPE'], r, rest);
        for (const line of rest) {
            const m = /^forms checked (\d+) missing (\d+) bad types (\d+)$/.exec(line);
            if (m) { r.summary = { forms: num(m[1]), missing: num(m[2]), badTypes: num(m[3]) }; } else { r.lines.push(line); }
        }
        r.stderr = err;
    },
    'feature-register': (out, err, r) => {
        const rest: string[] = [];
        tagged(out, ['FEATURES'], r, rest);
        for (const line of rest) {
            const m = /^features\s+(\d+) features, (\d+) functional requirements, (\d+) prototype features — (\d+) finding\(s\)$/.exec(line);
            if (m) { r.summary = { features: num(m[1]), functionalRequirements: num(m[2]), prototypeFeatures: num(m[3]), findings: num(m[4]) }; } else { r.lines.push(line); }
        }
        r.stderr = err;
    },
    'question-register': (out, err, r) => {
        const rest: string[] = [];
        tagged(out, ['REGISTER'], r, rest);
        for (const line of rest) {
            const m = /^register\s+(\d+) index rows, (\d+) blocks in the Blueprint, (\d+) waiting \((\d+) ★\) — (\d+) finding\(s\)$/.exec(line);
            const answered = /^answered in the Blueprint, not yet applied: (.*)$/.exec(line);
            if (m) {
                r.summary = { ...r.summary, indexRows: num(m[1]), blocks: num(m[2]), waiting: num(m[3]), waitingStarred: num(m[4]), findings: num(m[5]) };
            } else if (answered) {
                r.summary = { ...r.summary, answeredNotApplied: answered[1].split(',').map((s) => s.trim()).filter(Boolean) };
            } else if (/^counts\s+rewritten$/.test(line)) {
                r.summary = { ...r.summary, countsRewritten: true };
            } else { r.lines.push(line); }
        }
        r.stderr = err;
    },
    'project-idea-coverage': (out, err, r) => {
        const entries: Array<{ class: string; id: string; kind: string; detail: string }> = [];
        for (const line of out) {
            const entry = /^(covered|area|via|excluded|uncovered)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
            const unknown = /^UNKNOWN\s+(.*)$/.exec(line);
            const ids = /^ids\s+(\d+) \((.*)\); (\d+) requirements read$/.exec(line);
            const coverage = /^coverage\s+(.*)$/.exec(line);
            if (entry) {
                entries.push({ class: entry[1], id: entry[2], kind: entry[3], detail: entry[4] });
                if (entry[1] === 'uncovered') { r.findings.push({ kind: 'uncovered', text: `${entry[2]} ${entry[3]} ${entry[4]}`.trim() }); }
            } else if (unknown) {
                r.findings.push({ kind: 'UNKNOWN', text: unknown[1] });
            } else if (ids) {
                r.summary = { ...r.summary, ids: num(ids[1]), idKinds: kindCounts(ids[2]), requirements: num(ids[3]) };
            } else if (coverage) {
                r.summary = { ...r.summary, classes: kindCounts(coverage[1], true) };
            } else { r.lines.push(line); }
        }
        r.summary = { ...r.summary, entries };
        r.stderr = err;
    },
    authorization: (out, err, r) => {
        const sections: Array<{ name: string; count: number; items: string[]; finding: boolean }> = [];
        for (const line of out) {
            const finding = /^## (.+?): (\d+) finding\(s\)$/.exec(line);
            const info = /^## (.+?): (\d+)$/.exec(line);
            const item = /^ {2}- (.*)$/.exec(line);
            const summary = /^SUMMARY .* operations (\d+) screens (\d+) use cases (\d+)$/.exec(line);
            if (finding) { sections.push({ name: finding[1], count: num(finding[2]), items: [], finding: true }); }
            else if (info) { sections.push({ name: info[1], count: num(info[2]), items: [], finding: false }); }
            else if (item && sections.length) {
                const s = sections[sections.length - 1];
                s.items.push(item[1]);
                if (s.finding) { r.findings.push({ kind: s.name, text: item[1] }); }
            } else if (summary) {
                r.summary = { ...r.summary, operations: num(summary[1]), screens: num(summary[2]), useCases: num(summary[3]) };
            } else { r.lines.push(line); }
        }
        r.summary = {
            ...r.summary,
            checks: Object.fromEntries(sections.filter((s) => s.finding).map((s) => [s.name, s.count])),
            notes: sections.filter((s) => !s.finding).map((s) => ({ name: s.name, count: s.count, items: s.items })),
        };
        r.stderr = err;
    },
    coverage: (out, err, r) => {
        // The coverage table, as the check renders it: its lines are the report.
        r.summary = { table: out };
        r.stderr = err;
    },
    'import-answers': (out, err, r) => {
        const answers: Array<{ questionId: string; path: string; answer: string }> = [];
        const values: string[] = [];
        for (const line of out) {
            // `VALUE  <id path>` and `<question id>  <id path>  "<first line>"` (or `(cleared)`); an id path holds spaces (`SBP > DOCTL > content`).
            const value = /^VALUE {2}(.+)$/.exec(line);
            const answer = /^(\S+) {2}(.+?) {2}(".*"|\(cleared\))$/.exec(line);
            const imported = /^import\s+(\d+) answer\(s\), (\d+) other value\(s\)$/.exec(line);
            const tier = /^(schema|instance)\s+(\d+) finding\(s\)$/.exec(line);
            if (value) { values.push(value[1]); }
            else if (imported) { r.summary = { ...r.summary, answers: num(imported[1]), otherValues: num(imported[2]) }; }
            else if (tier) { r.summary = { ...r.summary, [tier[1]]: num(tier[2]) }; }
            else if (/^decode\s+OK$/.test(line)) { r.summary = { ...r.summary, decode: 'OK' }; }
            else if (/^dry run\s+nothing written$/.test(line)) { r.summary = { ...r.summary, dryRun: true }; }
            else if (/^(written|rendition)\s+/.test(line)) { r.lines.push(line); }
            else if (answer) { answers.push({ questionId: answer[1], path: answer[2], answer: answer[3] }); }
            else { r.lines.push(line); }
        }
        const rest: string[] = [];
        tagged(err, ['REJECTED', 'REFUSED', 'SCHEMA', 'INSTANCE', 'VERIFY', 'DECODE FAILED', 'RENDER FAILED'], r, rest);
        r.stderr = rest;
        r.summary = { ...r.summary, imported: answers, values };
    },
};
/* eslint-enable @typescript-eslint/naming-convention */

/** `150 capability, 12 expectation` → {capability: 150, …}; with `nameFirst`, `covered 342, area 9` → {covered: 342, …}. */
function kindCounts(text: string, nameFirst = false): Record<string, number> {
    const out: Record<string, number> = {};
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = nameFirst ? /^(\S+) (\d+)$/.exec(part) : /^(\d+) (\S+)$/.exec(part);
        if (m) { if (nameFirst) { out[m[1]] = num(m[2]); } else { out[m[2]] = num(m[1]); } }
    }
    return out;
}
