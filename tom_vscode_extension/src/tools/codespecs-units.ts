/**
 * Phase 4's generation units and IR documents, for the CodeSpecs tools
 * (vscimpb67e; codespecs_mapping.md §1.1.1 item 4 and §1.1.2,
 * codespecs_prompt.md §7, codespecs_derivation_contract.md §2.9).
 *
 *   - The **register**: the generation units a document declares
 *     (`GENUN-UNIT-LST`), each with its kind and the mapper of every area it
 *     holds — read through the runtime's `specGenerationUnits`.
 *   - The **IR folder**: `<spec-root>/irspecs/`, one `<CE-CODE>.ir.yaml` per
 *     area, which the authoring steps write and `irspecs map --unit` turns into
 *     each unit's package.
 *   - A step's **units**: the units its extracts' entries go to, read off the
 *     entries' `units` (the nearest stored `units`, else the register's default).
 */

import * as fs from 'fs';
import * as path from 'path';
import { specGenerationUnits } from 'tom_som_typescript_runtime';

import { loadDocument, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { EXTRACTS_DIR } from './codespecs-tools';

/** The IR folder's name under the spec root (codespecs_mapping.md §1.1.2 stage 3). */
export const IR_DIR = 'irspecs';
/** An IR document's file-name suffix. */
export const IR_SUFFIX = '.ir.yaml';

export interface UnitView {
    unitId: string;
    /** `client`, `server`, `shared` or `other`; empty when the register leaves it unset. */
    kind: string;
    /** Area code → the mapper that writes it for this unit. */
    mappers: Record<string, string>;
}

/** The units `file` declares, in register order; [] when it declares none. */
export function registerOf(deps: SpecToolDeps, file: string): UnitView[] {
    const loaded = loadDocument(deps, file);
    return specGenerationUnits(deps.service.model, loaded.document).map((u) => ({
        unitId: u.unitId,
        kind: u.kind,
        mappers: Object.fromEntries(u.mappings.map((m) => [m.area, m.mapping])),
    }));
}

/**
 * The spec root of an extract folder: two levels up when it is the standard
 * `<spec-root>/generated-doc/codespecs_extracts`, else null.
 */
export function specRootOfExtracts(extractsDir: string): string | null {
    const normalized = path.normalize(extractsDir).replace(/[\\/]+$/, '');
    return normalized.endsWith(path.normalize(EXTRACTS_DIR)) ? path.dirname(path.dirname(normalized)) : null;
}

/** The IR documents of `areas` under `specRoot`: workspace-relative path and whether it exists yet. */
export function irDocuments(deps: SpecToolDeps, specRoot: string, areas: string[]): Array<{ area: string; path: string; exists: boolean }> {
    return areas.map((area) => {
        const abs = path.join(specRoot, IR_DIR, `${area}${IR_SUFFIX}`);
        return { area, path: toWorkspacePath(deps, abs), exists: fs.existsSync(abs) };
    });
}

/** The units a set of entries goes to, ordered by the register when it is known, else as first met. */
export function unitsOfEntries(entries: Array<{ units?: string[] }>, register: UnitView[] = []): string[] {
    const seen = new Set<string>();
    for (const e of entries) { for (const u of e.units ?? []) { seen.add(u); } }
    const inRegister = register.map((u) => u.unitId).filter((id) => seen.has(id));
    return [...inRegister, ...[...seen].filter((id) => !inRegister.includes(id))];
}

/**
 * The step's units with their kind and the mapper of each of `areas` (from the
 * register; an id the register does not declare is marked `undeclared`).
 */
export function stepUnits(ids: string[], register: UnitView[] | null, areas: string[]): Array<Record<string, unknown>> {
    return ids.map((id) => {
        if (!register) { return { unitId: id }; }
        const unit = register.find((u) => u.unitId === id);
        if (!unit) { return { unitId: id, undeclared: true }; }
        const mappers = Object.fromEntries(areas.filter((a) => unit.mappers[a] !== undefined).map((a) => [a, unit.mappers[a]]));
        return { unitId: id, kind: unit.kind, mappers };
    });
}
