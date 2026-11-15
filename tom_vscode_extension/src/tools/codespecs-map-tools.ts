/**
 * tomAi_specCodeSpecsMap (vscimpb99): Phase 4's stage 5 (codespecs_mapping.md
 * §1.1.2) through the extension — each generation unit's package written from
 * the IR with the bundled `irspecs` (tom_specs_clitool's bin/irspecs.dart,
 * compiled by `npm run codespecs:build` beside validate_codespecs), so the
 * stage needs no Dart SDK and no ai_build checkout at run time.
 *
 * Per unit of the document's register (codespecs-units.ts registerOf) and per
 * mapper that unit names for its areas, one
 * `irspecs map --mapper <m> --ir <spec-root>/irspecs --spec <document> --unit <id> --out <out>`;
 * a document without units maps the trio with the Dart + Tom mapper
 * (`irspecs map --mapper dart-tom --ir … --out …`). A writer: approval-gated;
 * `dryRun` answers the runs it would make.
 *
 * The Dart + Tom mapper formats what it writes with the Dart SDK's
 * `dart format`: a Dart SDK is a prerequisite of that mapper (tom_specs
 * irfmt1). The compiled `irspecs` finds it from `TOM_DART`, else PATH; the
 * extension hands it the SDK the window knows (services/dartSdk.ts: the Dart
 * extension's settings, the environment, the host's usual places) as
 * `TOM_DART` (vscimpb114). Without one the run writes its files unformatted
 * and exits 1 naming TOM_DART / PATH: the tool answers that as
 * `formatterUnavailable`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SharedToolDefinition } from './shared-tool-registry';
import { FILE_PARAM, json, liveDeps, resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';
import { codeSpecsFailure } from './codespecs-tools';
import { registerOf, IR_DIR, type UnitView } from './codespecs-units';
import { DartBinaryMissing, currentDartBinary, dartBinariesHelp, runDartBinary, type BinaryRun } from '../services/dartBinariesStatus';
import { liveDartSdk, type DartSdkFound } from '../services/dartSdk';

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

/** The Dart + Tom mapper: the trio's mapper, and the one whose output `dart format` lays out. */
export const DART_TOM_MAPPER = 'dart-tom';

/** Generous: a mapper writes a package and the Dart one formats it. */
const MAP_TIMEOUT_MS = 10 * 60_000;

/** Runs `irspecs` with the arguments (and the environment, when one is given); replaceable in a test. */
export type IrspecsRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<BinaryRun>;
const liveRunner: IrspecsRunner = (args, env) => runDartBinary('irspecs', args, { timeoutMs: MAP_TIMEOUT_MS, ...(env ? { env } : {}) });
let runner: IrspecsRunner = liveRunner;
export function setIrspecsRunnerForTest(r: IrspecsRunner | undefined): void {
    runner = r ?? liveRunner;
}

/** The Dart SDK the dart-tom runs format with; replaceable in a test. */
let sdkResolver: () => DartSdkFound | undefined = () => liveDartSdk();
export function setDartSdkResolverForTest(r: (() => DartSdkFound | undefined) | undefined): void {
    sdkResolver = r ?? (() => liveDartSdk());
}

/** irspecs' message when it found no Dart SDK to format with (its IrMapException, tom_specs irfmt1). */
const NO_SDK_MESSAGE = /written unformatted: no Dart SDK to run `dart format` with/;

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

/** The note on the Dart + Tom mapper's prerequisite, with a plan or a run that names it. */
export const FORMATTER_NOTE = 'A Dart SDK is a prerequisite of the Dart + Tom mapper: it formats what it writes with the SDK\'s `dart format` '
    + '(the layout the trio is held to). The extension hands the bundled irspecs the SDK this window knows as TOM_DART — the Dart '
    + 'extension\'s dart.sdkPath or dart.flutterSdkPath, $DART_SDK, $FLUTTER_ROOT, `dart` or `flutter` on PATH, or the usual install '
    + 'folders; irspecs itself looks at TOM_DART, else PATH. Without one its files are written unformatted and the run fails: install '
    + 'Dart or Flutter, or set TOM_DART to the `dart` executable (or the SDK folder), and map again. The other mappers need no Dart SDK.';

export async function codeSpecsMapImpl(deps: SpecToolDeps, input: CodeSpecsMapInput): Promise<string> {
    try {
        if (!input || typeof input.file !== 'string' || !input.file.trim()) { return json({ ok: false, error: '`file` is required: the specification document' }); }
        if (typeof input.out !== 'string' || !input.out.trim()) { return json({ ok: false, error: '`out` is required: the folder the packages are written into' }); }
        const fileAbs = resolveInput(deps, input.file);
        const irAbs = input.ir ? resolveInput(deps, input.ir) : path.join(path.dirname(fileAbs), IR_DIR);
        const outAbs = resolveInput(deps, input.out);
        const rel = (p: string): string => toWorkspacePath(deps, p);
        if (!fs.existsSync(irAbs) || !fs.statSync(irAbs).isDirectory()) {
            return json({ ok: false, code: 'irMissing', error: `no IR folder at ${rel(irAbs)}: the authoring steps write it (<spec-root>/${IR_DIR}/<CE-CODE>.ir.yaml)` });
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
        const shown = (args: string[]): string => `irspecs ${args.map((a) => (path.isAbsolute(a) ? rel(a) : a)).join(' ')}`;
        const head = {
            file: rel(fileAbs), ir: rel(irAbs), out: rel(outAbs),
            ...(skipped.length ? { skipped: skipped.map((u) => ({ unit: u, reason: 'the unit names no mapper for any area' })) } : {}),
        };
        // The SDK the dart-tom runs format with (TOM_DART in their environment).
        const usesDartTom = plan.some((r) => r.mapper === DART_TOM_MAPPER);
        const sdk = usesDartTom ? sdkResolver() : undefined;
        const sdkView = usesDartTom ? { dartSdk: sdk ? { dart: sdk.dart, via: sdk.via } : null } : {};
        if (input.dryRun) {
            const binary = currentDartBinary('irspecs');
            return json({
                ok: true, dryRun: true, ...head,
                binary: binary.path ? 'available' : 'missing',
                ...sdkView,
                runs: plan.map((r) => ({ unit: r.unit, mapper: r.mapper, areas: r.areas, command: shown(r.args) })),
                ...(plan.some((r) => r.mapper === DART_TOM_MAPPER) ? { note: FORMATTER_NOTE } : {}),
            });
        }
        const runs: Array<Record<string, unknown>> = [];
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the environment variable irspecs reads
        const dartTomEnv = sdk ? { ...process.env, TOM_DART: sdk.dart } : undefined;
        for (const r of plan) {
            const result = await runner(r.args, r.mapper === DART_TOM_MAPPER ? dartTomEnv : undefined);
            const stderr = result.stderr.trim();
            // No SDK to format with (irspecs names TOM_DART / PATH), or an older irspecs that ran itself as `dart format`.
            const formatterUnavailable = result.exitCode !== 0 && r.mapper === DART_TOM_MAPPER
                && (NO_SDK_MESSAGE.test(stderr) || /^dart format failed: Could not find an option/.test(stderr));
            runs.push({
                unit: r.unit, mapper: r.mapper, areas: r.areas, command: shown(r.args), exitCode: result.exitCode,
                ...(result.stdout.trim() ? { written: result.stdout.trim() } : {}),
                ...(formatterUnavailable
                    ? { formatterUnavailable: true, error: NO_SDK_MESSAGE.test(stderr) ? stderr : 'the files were written unformatted: this irspecs could not run `dart format` (rebuild it: npm run codespecs:build). Set TOM_DART to the `dart` executable (or the SDK folder), or put `dart` on PATH.' }
                    : stderr ? { error: stderr } : {}),
            });
        }
        const ok = runs.every((r) => r.exitCode === 0);
        return json({
            ok, ...head, ...sdkView, runs,
            ...(runs.some((r) => r.formatterUnavailable) ? { formatterUnavailable: true, note: FORMATTER_NOTE } : {}),
        });
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
        'Phase 4 stage 5: write each generation unit\'s package from the IR with the bundled irspecs: per unit of the document\'s register (`unit`: one id; default every unit) and per mapper the unit names for its areas, `irspecs map --mapper <m> --ir <spec-root>/irspecs --spec <file> --unit <id> --out <out>`; a document without units maps the trio with dart-tom. '
        + 'Answers each run (unit, mapper, areas, command, exit code, what it wrote, error); ok when every run exited 0. `dryRun` answers the runs without making them. '
        + 'A Dart SDK is a prerequisite of dart-tom (it formats with `dart format`): the tool hands irspecs the SDK the window knows as TOM_DART (`dartSdk` in the answer); without one the run is `formatterUnavailable`, its files written unformatted, and its error names TOM_DART / PATH. '
        + '`binaryMissing` (no irspecs for this platform, with `help` and `page`) and `irMissing` / `unknownUnit` with ok false. A mapped package is never edited by hand: change the IR and map again. Then tomAi_specCodeSpecsValidate with `ir`.',
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
