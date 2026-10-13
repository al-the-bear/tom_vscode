/**
 * Reading a CodeSpecs run after the fact: the extracts it wrote and the
 * back-links the generated code carries, so that a spec value and the code
 * generated from it can be found from either end.
 *
 * The links (codespecs_derivation_contract.md §2.5, codespecs_mapping.md §9.6):
 *   - an extract entry carries its section-id TOKEN, document path, class,
 *     field and the verbatim value;
 *   - a generated declaration carries `@CodeSpec(id, source: [tokens])` and
 *     `@DocSpec([DocRef(token, …)])` — its back-links;
 *   - checks 35 and 36 compare TOKEN SETS: a token the extracts hold a value
 *     for that no back-link cites, and a back-link token no extract holds.
 * Tracing is therefore by token, as the checks are. Which declaration
 * *should* carry a token is the authoring step's judgement and is not decided
 * here, as the contract does not decide it either.
 *
 * Extracts are read file by file through the runtime's reader, so an extract
 * in a format this runtime does not read is reported by name, never misread,
 * and the other files still answer. The back-link index is the JSON
 * `validate_codespecs --backlinks` writes (format `codespecs-backlinks`/1);
 * the code is never parsed here.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    CodeSpecsExtract,
    CodeSpecsGateRecord,
    CodeSpecsGateVerdict,
    K_CODE_SPECS_EXTRACT_FILE_SUFFIX,
    K_CODE_SPECS_GATE_RECORD_FILE,
} from 'tom_som_typescript_runtime';
import type { CodeSpecsExtractEntry } from 'tom_som_typescript_runtime';

export const BACKLINKS_FORMAT = 'codespecs-backlinks';
export const BACKLINKS_FORMAT_VERSION = 1;

/** One declaration of the back-link index. */
export interface BacklinkDeclaration {
    locus: string;
    package: string;
    name: string;
    owner: string | null;
    path: string;
    kind: string;
    file: string;
    line: number;
    markers: string[];
    codeSpec: { id: string; source: string[]; line: number } | null;
    docSpec: Array<{ token: string; description: string }> | null;
    docSpecLine: number | null;
    tokens: string[];
}

export interface BacklinkIndex {
    format: string;
    formatVersion: number;
    inputs: Record<string, string | null>;
    declarations: BacklinkDeclaration[];
}

/** A back-link index read from JSON, refusing any format but the one this reader knows. */
export function parseBacklinkIndex(text: string, source: string): BacklinkIndex {
    let json: Partial<BacklinkIndex>;
    try {
        json = JSON.parse(text) as Partial<BacklinkIndex>;
    } catch (e) {
        throw new Error(`${source} is not JSON: ${(e as Error).message}`);
    }
    if (json.format !== BACKLINKS_FORMAT || json.formatVersion !== BACKLINKS_FORMAT_VERSION) {
        throw new Error(`${source} declares ${json.format ?? 'no format'}/${json.formatVersion ?? '?'}; this reader understands `
            + `${BACKLINKS_FORMAT}/${BACKLINKS_FORMAT_VERSION} only (the output of validate_codespecs --backlinks).`);
    }
    if (!Array.isArray(json.declarations)) {
        throw new Error(`${source} has no declarations list.`);
    }
    return json as BacklinkIndex;
}

export interface ExtractFile {
    file: string;
    extract: CodeSpecsExtract;
    /** False when a gate record puts the area out of this pass (any verdict but sufficient). */
    inScope: boolean;
}

export interface ExtractDirectory {
    dir: string;
    files: ExtractFile[];
    unreadable: Array<{ file: string; error: string }>;
    /** The gate record beside the extracts, when there is one and it reads. */
    gate: CodeSpecsGateRecord | null;
    gateError?: string;
}

/** Every extract in `dir`, each read on its own; the gate record scopes them when present. */
export function readExtractDirectory(dir: string): ExtractDirectory {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`No extract directory at ${dir}. Write the extracts first (tomAi_specCodeSpecsWriteExtracts).`);
    }
    const out: ExtractDirectory = { dir, files: [], unreadable: [], gate: null };
    const recordFile = path.join(dir, K_CODE_SPECS_GATE_RECORD_FILE);
    if (fs.existsSync(recordFile)) {
        try {
            out.gate = CodeSpecsGateRecord.fromYaml(fs.readFileSync(recordFile, 'utf8'), K_CODE_SPECS_GATE_RECORD_FILE);
        } catch (e) {
            out.gateError = (e as Error).message;
        }
    }
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(K_CODE_SPECS_EXTRACT_FILE_SUFFIX)).sort()) {
        try {
            const extract = CodeSpecsExtract.fromYaml(fs.readFileSync(path.join(dir, name), 'utf8'), name);
            const verdict = out.gate?.verdictFor(extract.area.code)?.verdict ?? null;
            out.files.push({ file: name, extract, inScope: out.gate === null || verdict === CodeSpecsGateVerdict.sufficient });
        } catch (e) {
            out.unreadable.push({ file: name, error: (e as Error).message });
        }
    }
    return out;
}

export interface EntryView {
    area: string;
    token: string;
    path: string;
    className: string;
    field: string;
    instanceId?: string;
    headline?: string;
    routedBy: string;
    value: string;
}

export function entryView(e: CodeSpecsExtractEntry): EntryView {
    return {
        area: e.areaCode,
        token: e.sectionId,
        path: e.path,
        className: e.className,
        field: e.formField ? `${e.fieldName}.${e.formField}` : e.fieldName,
        ...(e.instanceId ? { instanceId: e.instanceId } : {}),
        ...(e.headline ? { headline: e.headline } : {}),
        routedBy: e.routedBy,
        value: e.value,
    };
}

export interface EntryFilter {
    area?: string;
    token?: string;
    /** That path or below it. */
    path?: string;
    /** Case-insensitive substring of the value. */
    text?: string;
}

export function queryEntries(dir: ExtractDirectory, filter: EntryFilter): Array<{ entry: CodeSpecsExtractEntry; inScope: boolean }> {
    const text = filter.text?.toLowerCase();
    const out: Array<{ entry: CodeSpecsExtractEntry; inScope: boolean }> = [];
    for (const f of dir.files) {
        if (filter.area && f.extract.area.code !== filter.area) { continue; }
        for (const e of f.extract.entries) {
            if (filter.token && e.sectionId !== filter.token) { continue; }
            if (filter.path && e.path !== filter.path && !e.path.startsWith(`${filter.path}/`)) { continue; }
            if (text && !e.value.toLowerCase().includes(text)) { continue; }
            out.push({ entry: e, inScope: f.inScope });
        }
    }
    return out;
}

/** Tokens the in-scope extracts hold a value for, and tokens the back-links cite. */
export interface TokenAgreement {
    /** Check 35's shape: extracted, cited by no declaration. */
    uncited: Array<{ token: string; areas: string[]; values: number }>;
    /** Check 36's shape: cited, held by no in-scope extract. */
    dangling: Array<{ token: string; citedBy: string[] }>;
}

export function tokenAgreement(dir: ExtractDirectory, index: BacklinkIndex): TokenAgreement {
    const extracted = new Map<string, { areas: Set<string>; values: number }>();
    for (const f of dir.files.filter((x) => x.inScope)) {
        for (const e of f.extract.entries) {
            const t = extracted.get(e.sectionId) ?? { areas: new Set<string>(), values: 0 };
            t.areas.add(e.areaCode);
            t.values++;
            extracted.set(e.sectionId, t);
        }
    }
    const cited = new Map<string, string[]>();
    for (const d of index.declarations) {
        for (const t of d.tokens) { cited.set(t, [...(cited.get(t) ?? []), declarationLabel(d)]); }
    }
    return {
        uncited: [...extracted].filter(([t]) => !cited.has(t)).map(([token, v]) => ({ token, areas: [...v.areas].sort(), values: v.values })),
        dangling: [...cited].filter(([t]) => !extracted.has(t)).map(([token, citedBy]) => ({ token, citedBy })),
    };
}

export function declarationLabel(d: BacklinkDeclaration): string {
    return `${d.locus}:${d.file}:${d.line} ${d.owner ? `${d.owner}.` : ''}${d.name}`;
}

export function declarationView(d: BacklinkDeclaration): Record<string, unknown> {
    return {
        locus: d.locus,
        package: d.package,
        name: d.owner ? `${d.owner}.${d.name}` : d.name,
        kind: d.kind,
        file: d.file,
        line: d.line,
        ...(d.codeSpec ? { codeSpecId: d.codeSpec.id } : {}),
        tokens: d.tokens,
    };
}

/**
 * The declaration a code location names: in that file (matched by suffix, as
 * the index stores package-relative paths), the declaration whose line is the
 * nearest at or above `line`.
 */
export function declarationAt(index: BacklinkIndex, file: string, line: number): BacklinkDeclaration | null {
    const wanted = file.split(path.sep).join('/');
    let best: BacklinkDeclaration | null = null;
    for (const d of index.declarations) {
        const sameFile = wanted === d.file || wanted.endsWith(`/${d.file}`);
        if (!sameFile || d.line > line) { continue; }
        if (!best || d.line > best.line) { best = d; }
    }
    return best;
}
