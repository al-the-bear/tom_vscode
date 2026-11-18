/**
 * tomAi_specCodeSpecsMap (vscimpb99): Phase 4's stage 5 (codespecs_mapping.md
 * §1.1.2) through the extension — each generation unit's package written from
 * the IR with the bundled `tomspecs :ir-map` (tom_specs_clitool's bin/tomspecs.dart,
 * compiled by `npm run codespecs:build`), so the
 * stage needs no Dart SDK and no ai_build checkout at run time.
 *
 * Per unit of the document's register (codespecs-units.ts registerOf) and per
 * mapper that unit names for its areas, one
 * `tomspecs :ir-map --mapper <m> --ir <spec-root>/irspecs --spec <document> --unit <id> --out <out>`;
 * a document without units maps the trio with the Dart + Tom mapper
 * (`tomspecs :ir-map --mapper dart-tom --ir … --out …`). A writer: approval-gated;
 * `dryRun` answers the runs it would make.
 *
 * The Dart + Tom mapper lays out what it writes with `dart_style`, linked
 * into tomspecs and pinned to the SDK formatter (tom_specs irfmt2): every
 * mapper runs without a Dart SDK on the machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { codeSpecsFailure } from './codespecs-tools';
import { registerOf, IR_DIR, type UnitView } from './codespecs-units';
import { DartBinaryMissing, currentDartBinary, dartBinariesHelp, type BinaryRun } from '../services/dartBinariesStatus';
import { CLITOOL_BINARY, clitoolInvocation, runClitool } from '../services/tomspecsCalls';

export interface CodeSpecsMapInput {
    /** The specification document whose register names the generation units. */
    file: string;
    /** One unit id; default (or `all`) every unit of the register. */
    unit?: string;
    /** The folder the packages are written into (workspace-relative or absolute, inside the workspace). */
    out: string;
    /** The IR folder; default `<spec root>/irspecs` beside the document. */
    ir?: string;
    /** Answer the runs without making them. */
    dryRun?: boolean;
}

/** The Dart + Tom mapper: the trio's mapper. */
export const DART_TOM_MAPPER = 'dart-tom';

/** Generous: a mapper writes a whole package (the Dart one formats it in-process). */
const MAP_TIMEOUT_MS = 10 * 60_000;

/** Runs an IR call (`map …`, run as `tomspecs :ir-map …`, services/tomspecsCalls.ts); replaceable in a test. */
export type IrRunner = (args: string[]) => Promise<BinaryRun>;
const liveRunner: IrRunner = (args) => runClitool({ tool: 'ir', args }, { timeoutMs: MAP_TIMEOUT_MS });
let runner: IrRunner = liveRunner;
export function setIrRunnerForTest(r: IrRunner | undefined): void {
    runner = r ?? liveRunner;
}

/** One run of the plan: a unit (null: the trio without units), a mapper, the areas it writes, the arguments. */
interface PlannedRun {
    unit: string | null;
    mapper: string;
    areas: string[];
    args: string[];
}

/** The mappers a unit names, in the order its areas first name them, each with its areas. */
function mappersOf(unit: UnitView): Array<{ mapper: string; areas: string[] }> {
    const out: Array<{ mapper: string; areas: string[] }> = [];
    for (const [area, mapper] of Object.entries(unit.mappers)) {
        const at = out.find((m) => m.mapper === mapper);
        if (at) { at.areas.push(area); } else { out.push({ mapper, areas: [area] }); }
    }
    return out;
}

export async function codeSpecsMapImpl(deps: SpecToolDeps, input: CodeSpecsMapInput): Promise<string> {
    try {
        if (!input || typeof input.file !== 'string' || !input.file.trim()) { return json({ ok: false, error: '`file` is required: the specification document' }); }
        if (typeof input.out !== 'string' || !input.out.trim()) { return json({ ok: false, error: '`out` is required: the folder the packages are written into' }); }
        const fileAbs = resolveInput(deps, input.file);
        const irAbs = input.ir ? resolveInput(deps, input.ir) : path.join(path.dirname(fileAbs), IR_DIR);
        const outAbs = resolveInput(deps, input.out);
        const rel = (p: string): string => toWorkspacePath(deps, p);
        if (!fs.existsSync(irAbs) || !fs.statSync(irAbs).isDirectory()) {
            return json({ ok: false, code: 'irMissing', error: `no IR folder at ${rel(irAbs)}: the authoring steps write it (<spec-root>/${IR_DIR}/<CE-CODE>_<canonical id>.ir.yaml)` });
        }
        const register = registerOf(deps, input.file);
        const wanted = input.unit && input.unit !== 'all' ? input.unit : undefined;
        const plan: PlannedRun[] = [];
        const skipped: string[] = [];
        if (register.length === 0) {
            if (wanted) { return json({ ok: false, code: 'unknownUnit', error: `${rel(fileAbs)} declares no generation units; without \`unit\` the trio is mapped with ${DART_TOM_MAPPER}` }); }
            plan.push({ unit: null, mapper: DART_TOM_MAPPER, areas: [], args: ['map', '--mapper', DART_TOM_MAPPER, '--ir', irAbs, '--out', outAbs] });
        } else {
            const units = wanted ? register.filter((u) => u.unitId === wanted) : register;
            if (units.length === 0) {
                return json({ ok: false, code: 'unknownUnit', error: `${rel(fileAbs)} declares no generation unit "${wanted}"; its units: ${register.map((u) => u.unitId).join(', ')}` });
            }
            for (const unit of units) {
                const mappers = mappersOf(unit);
                if (mappers.length === 0) { skipped.push(unit.unitId); continue; }
                for (const m of mappers) {
                    plan.push({ unit: unit.unitId, mapper: m.mapper, areas: m.areas, args: ['map', '--mapper', m.mapper, '--ir', irAbs, '--spec', fileAbs, '--unit', unit.unitId, '--out', outAbs] });
                }
            }
        }
        const shown = (args: string[]): string => {
            const call = clitoolInvocation({ tool: 'ir', args });
            return [call.binary, ...call.args.map((a) => (path.isAbsolute(a) ? rel(a) : a))].join(' ');
        };
        const head = {
            file: rel(fileAbs), ir: rel(irAbs), out: rel(outAbs),
            ...(skipped.length ? { skipped: skipped.map((u) => ({ unit: u, reason: 'the unit names no mapper for any area' })) } : {}),
        };
        if (input.dryRun) {
            const binary = currentDartBinary(CLITOOL_BINARY);
            return json({
                ok: true, dryRun: true, ...head,
                binary: binary.path ? 'available' : 'missing',
                runs: plan.map((r) => ({ unit: r.unit, mapper: r.mapper, areas: r.areas, command: shown(r.args) })),
            });
        }
        const runs: Array<Record<string, unknown>> = [];
        for (const r of plan) {
            const result = await runner(r.args);
            const stderr = result.stderr.trim();
            runs.push({
                unit: r.unit, mapper: r.mapper, areas: r.areas, command: shown(r.args), exitCode: result.exitCode,
                ...(result.stdout.trim() ? { written: result.stdout.trim() } : {}),
                ...(stderr ? { error: stderr } : {}),
            });
        }
        const ok = runs.every((r) => r.exitCode === 0);
        return json({ ok, ...head, runs });
    } catch (e) {
        if (e instanceof DartBinaryMissing) {
            // Mapping is what this tool does: say how to get the binary.
            return json({ ok: false, outcome: 'binaryMissing', error: e.message, expected: e.expected, ...dartBinariesHelp() });
        }
        return codeSpecsFailure(e);
    }
}

export const CODESPECS_MAP_TOOL: SharedToolDefinition<CodeSpecsMapInput> = {
    name: 'tomAi_specCodeSpecsMap',
    displayName: 'CodeSpecs: Map',
    description:
        'Phase 4 stage 5: write each generation unit\'s package from the IR with the bundled tomspecs: per unit of the document\'s register (`unit`: one id; default every unit) and per mapper the unit names for its areas, `tomspecs :ir-map --mapper <m> --ir <spec-root>/irspecs --spec <file> --unit <id> --out <out>`; a document without units maps the trio with dart-tom. '
        + 'Answers each run (unit, mapper, areas, command, exit code, what it wrote, error); ok when every run exited 0. `dryRun` answers the runs without making them. '
        + '`binaryMissing` (no tomspecs for this platform, with `help` and `page`) and `irMissing` / `unknownUnit` with ok false. A mapped package is never edited by hand: change the IR and map again. Then tomAi_specCodeSpecsValidate with `ir`.',
    tags: ['tomspecs', 'codespecs', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['file', 'out'],
        properties: {
            file: { ...FILE_PARAM, description: 'The specification document whose generation-unit register names the units (its folder is the spec root). Workspace-relative or absolute (inside the workspace).' },
            unit: { type: 'string', description: 'One generation unit id; default (or `all`) every unit of the register.' },
            out: { type: 'string', description: 'The folder the packages are written into (workspace-relative or absolute, inside the workspace).' },
            ir: { type: 'string', description: 'The IR folder. Default: `irspecs/` beside the document.' },
            dryRun: { type: 'boolean', description: 'Answer the runs without making them. Default false.' },
        },
    },
    execute: async (input) => codeSpecsMapImpl(liveDeps(), input),
};
