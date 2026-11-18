/**
 * Phase 4's generation units and IR documents, for the CodeSpecs tools
 * (vscimpb67e; codespecs_mapping.md §1.1.1 item 4 and §1.1.2,
 * codespecs_prompt.md §7, codespecs_derivation_contract.md §2.9).
 *
 *   - The **register**: the generation units a document declares
 *     (`GENUN-UNIT-LST`), each with its kind and the mapper of every area it
 *     holds — read through the runtime's `specGenerationUnits`.
 *   - The **IR folder**: `<spec-root>/irspecs/`, one
 *     `<CE-CODE>_<canonical id in snake case>.ir.yaml` per area
 *     (`CE-DB_data_access.ir.yaml`; tom_specs irout2), which the authoring
 *     steps write and `tomspecs :ir-map --unit` turns into each unit's package. The
 *     readers still take the older `<CE-CODE>.ir.yaml`; a folder holding both
 *     names for one area is refused by `tomspecs :ir-map` and reported here.
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

/** `DataAccess` → `data_access` (the IR mapper's `snakeCase`: an underscore before a capital that follows a lower-case letter or digit). */
export function snakeCase(pascal: string): string {
    return pascal.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1').toLowerCase();
}

/**
 * The file name of `area`'s IR document: `<CE-CODE>_<snake(canonicalId)>.ir.yaml` (tom_specs irout2). Without a
 * canonical id (an area the catalogue does not know) the older `<CE-CODE>.ir.yaml`.
 */
export function irDocumentName(area: string, canonicalId: string | undefined): string {
    return canonicalId ? `${area}_${snakeCase(canonicalId)}${IR_SUFFIX}` : `${area}${IR_SUFFIX}`;
}

/** The name IR folders used before descriptive names, which the readers still take. */
export function legacyIrDocumentName(area: string): string {
    return `${area}${IR_SUFFIX}`;
}

/** Where an area's IR document is in a folder, under which name. */
export interface IrDocumentFound {
    area: string;
    /** The name it is written to (the new one). */
    name: string;
    /** The name found on disk: the new one, else the older one; null when neither exists. */
    found: string | null;
    /** Set when the folder holds both names for the area (`tomspecs :ir-map` refuses that folder). */
    bothNames?: { names: [string, string]; message: string };
}

/** The canonical id of an area code, from the catalogue; undefined for an unknown area. */
export function canonicalIdOf(deps: Pick<SpecToolDeps, 'service'>, area: string): string | undefined {
    try { return deps.service.codeSpecsCatalog.byCode(area)?.canonicalId; } catch { return undefined; }
}

/** `area`'s IR document in `irDir`: the new name first, else the older one; both present is reported. */
export function irDocumentOf(irDir: string, area: string, canonicalId: string | undefined): IrDocumentFound {
    const name = irDocumentName(area, canonicalId);
    const legacy = legacyIrDocumentName(area);
    const isFile = (n: string): boolean => { try { return fs.statSync(path.join(irDir, n)).isFile(); } catch { return false; } };
    const hasNew = isFile(name);
    const hasLegacy = name !== legacy && isFile(legacy);
    return {
        area, name,
        found: hasNew ? name : hasLegacy ? legacy : null,
        ...(hasNew && hasLegacy ? {
            bothNames: {
                names: [name, legacy],
                message: `${area} has two IR documents, ${name} and ${legacy}; tomspecs (:ir-map, :codespecs-validate) refuses the folder: keep ${name} and remove ${legacy}.`,
            },
        } : {}),
    };
}

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

/**
 * The IR documents of `areas` under `specRoot`: the workspace-relative path (the document found, else the name it
 * is written to) and whether it exists yet; `legacyName` when it was found under the older `<CE-CODE>.ir.yaml`,
 * `finding` when the folder holds both names for the area.
 */
export function irDocuments(deps: SpecToolDeps, specRoot: string, areas: string[]): Array<{ area: string; path: string; exists: boolean; legacyName?: true; finding?: string }> {
    const irDir = path.join(specRoot, IR_DIR);
    return areas.map((area) => {
        const doc = irDocumentOf(irDir, area, canonicalIdOf(deps, area));
        return {
            area,
            path: toWorkspacePath(deps, path.join(irDir, doc.found ?? doc.name)),
            exists: doc.found !== null,
            ...(doc.found && doc.found !== doc.name ? { legacyName: true as const } : {}),
            ...(doc.bothNames ? { finding: doc.bothNames.message } : {}),
        };
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
