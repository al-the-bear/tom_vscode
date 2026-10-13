/**
 * The CodeSpecs derivation contract (tom_core_codespecs'
 * `codespecs_derivation_contract.md`), read as sections, and the choice of
 * which §3 contract entries an authoring step is handed (§2.9's `<ENTRIES>`).
 *
 * The packaged copy lives in `<extension>/resources/codespecs/`;
 * scripts/build-som-packages.cjs copies it there from tom_core.
 *
 * Which entries a step gets is read off the contract's own headings: §3 is
 * organised by slice (`### 3.<slice>`), and each entry's heading names its
 * marker (`@CsTable`) and its area code (`CE-DB`). A step is handed the entries
 * of its slice that name one of its areas' markers or codes, and §3.0's
 * entries, which hold across every slice. An area whose markers no entry of
 * the step's slice names — a marker that follows its host into a later slice,
 * as CE-AZ, CE-LG and CE-TX do — gets the entries naming its markers in any
 * slice, and failing that the entries naming its code.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Where the packaged contract lives (this file is out/services/). */
export const CONTRACT_FILE = path.resolve(__dirname, '..', '..', 'resources', 'codespecs', 'codespecs_derivation_contract.md');

export interface ContractSection {
    /** The section number, e.g. `3.3.1`. */
    number: string;
    /** The heading text after the number, verbatim. */
    title: string;
    /** 1-based line of the heading. */
    line: number;
    /** The heading line and body, up to the next heading of the same or a higher level. */
    text: string;
}

export interface ContractView {
    file: string;
    /** `##`/`###` sections of §2, by number. */
    universal: ContractSection[];
    /** §3's `####` entries, in document order. */
    entries: ContractSection[];
}

const HEADING = /^(#{2,4})\s+(\d+(?:\.\d+)*)\.?\s+(.*)$/;

/** The contract's §2 sections and §3 entries. */
export function readContract(file: string = CONTRACT_FILE): ContractView {
    if (!fs.existsSync(file)) {
        throw new Error(`The CodeSpecs derivation contract is missing at ${file}. Run \`npm run som:pack\` in the extension `
            + '(it copies the contract from tom_ai/core/tom_core_codespecs/doc/).');
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const heads: Array<{ level: number; number: string; title: string; index: number }> = [];
    let fenced = false;
    lines.forEach((l, index) => {
        if (/^```/.test(l)) { fenced = !fenced; return; }
        const m = fenced ? null : HEADING.exec(l);
        if (m) { heads.push({ level: m[1].length, number: m[2], title: m[3].trim(), index }); }
    });
    const sectionOf = (i: number): ContractSection => {
        const h = heads[i];
        const end = heads.slice(i + 1).find((n) => n.level <= h.level)?.index ?? lines.length;
        return { number: h.number, title: h.title, line: h.index + 1, text: lines.slice(h.index, end).join('\n').trimEnd() };
    };
    const universal: ContractSection[] = [];
    const entries: ContractSection[] = [];
    heads.forEach((h, i) => {
        if (h.level <= 3 && (h.number === '2' || h.number.startsWith('2.'))) { universal.push(sectionOf(i)); }
        if (h.level === 4 && h.number.startsWith('3.')) { entries.push(sectionOf(i)); }
    });
    return { file, universal, entries };
}

/** An area as the entry choice needs it. */
export interface AreaMarkers {
    code: string;
    /** Marker names without `@`, e.g. `CsTable`. */
    annotations: string[];
}

const namesMarker = (s: ContractSection, marker: string): boolean => new RegExp(`@${marker}(?![A-Za-z0-9_])`).test(s.title);
const namesCode = (s: ContractSection, code: string): boolean => new RegExp(`(?<![A-Z-])${code}(?![A-Z])`).test(s.title);
const inSlice = (s: ContractSection, slice: number): boolean => s.number.startsWith(`3.${slice}.`);

export interface StepEntries {
    entries: ContractSection[];
    /** Per area, how its entries were found: `slice` (the step's own), `marker` (any slice) or `code` (any slice); `none` when nothing names it. */
    matchedBy: Record<string, 'slice' | 'marker' | 'code' | 'none'>;
}

/** The §3 entries a step of `slice` authoring `areas` is handed, in document order. */
export function entriesForStep(contract: ContractView, slice: number, areas: AreaMarkers[]): StepEntries {
    const chosen = new Set<ContractSection>(contract.entries.filter((s) => s.number.startsWith('3.0.')));
    const matchedBy: StepEntries['matchedBy'] = {};
    for (const area of areas) {
        const names = (s: ContractSection): boolean => area.annotations.some((m) => namesMarker(s, m)) || namesCode(s, area.code);
        let found = contract.entries.filter((s) => inSlice(s, slice) && names(s));
        matchedBy[area.code] = 'slice';
        if (found.length === 0) {
            found = contract.entries.filter((s) => area.annotations.some((m) => namesMarker(s, m)));
            matchedBy[area.code] = 'marker';
        }
        if (found.length === 0) {
            found = contract.entries.filter((s) => namesCode(s, area.code));
            matchedBy[area.code] = 'code';
        }
        if (found.length === 0) { matchedBy[area.code] = 'none'; }
        found.forEach((s) => chosen.add(s));
    }
    return { entries: contract.entries.filter((s) => chosen.has(s)), matchedBy };
}
