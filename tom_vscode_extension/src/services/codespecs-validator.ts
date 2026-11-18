/**
 * The CodeSpecs validation (`tomspecs :codespecs-validate`, the old
 * validate_codespecs; services/tomspecsCalls.ts): where the binary is, how it
 * is run, and the two documents it writes — the `codespecs-validation` report
 * (`--json`) and the `codespecs-backlinks` index (`--backlinks`).
 *
 * The binary is tom_specs_clitool's `bin/tomspecs.dart`, compiled with
 * `dart compile exe` into `<extension>/bin/<platform>/` by
 * scripts/build-validate-codespecs.cjs (which the install scripts run). It
 * parses source text only, so it needs no Dart SDK at run time; nothing here
 * ever falls back to `dart run`. A binary configured for the platform
 * (`bridge.executables.tomspecs`) is used instead when it exists.
 * `TOM_SPECS_LEGACY_BINARIES=1` runs the old validate_codespecs instead
 * (until tom_specs' tsbin8).
 *
 * vscode-free.
 */

import * as path from 'path';
import { getCurrentPlatform } from '../utils/executableResolver';
import { binaryFileName, currentDartBinary, dartBinariesExtensionRoot, dartBinariesHelp, HELP_COMMAND, runBinaryFile, type BinaryRun } from './dartBinariesStatus';
import { clitoolBinary, clitoolInvocation } from './tomspecsCalls';

/** What a message names as the validator: `tomspecs :codespecs-validate` (validate_codespecs in legacy mode). */
function validatorLabel(): string {
    const call = clitoolInvocation({ tool: 'validate_codespecs', args: [] });
    return [call.binary, ...call.args].join(' ');
}

/** The binary CodeSpecs validation runs: tomspecs (validate_codespecs in legacy mode). */
function validatorBinary(): 'tomspecs' | 'validate_codespecs' {
    return clitoolBinary('validate_codespecs') as 'tomspecs' | 'validate_codespecs';
}

export const VALIDATION_FORMAT = 'codespecs-validation';
export const VALIDATION_FORMAT_VERSION = 1;

/** The command that puts the binary in place, named by every "missing" error. */
export const BUILD_COMMAND = 'npm run codespecs:build';

/** The extension root: this file is out/services/. */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/**
 * tom_code_specs' vocabulary source (`lib/src/annotations/vocabulary.dart`),
 * packaged by `npm run som:pack`: its csFeatureHooks / csFeatureReservedPaths
 * are the hook catalogue checks 40 and 41 hold the trio against, and its enum
 * catalogues one side of check 9.
 */
export const CS_VOCABULARY_FILE = path.join(EXTENSION_ROOT, 'resources', 'codespecs', 'vocabulary.dart');

/** Generous for a run measured at under a second; a hung binary must not hang a tool call. */
const RUN_TIMEOUT_MS = 60_000;

/** Where a tomspecs of the user's own is configured. */
export const VALIDATOR_CONFIG_KEY = 'bridge.executables.tomspecs';

export class CodeSpecsBinaryMissing extends Error {
    constructor(readonly expected: string, readonly platform: string = getCurrentPlatform()) {
        super(`${validatorBinary()} is not available on ${platform}: it is not bundled with this extension (expected at ${expected}) `
            + `and none is configured (\`bridge.executables.${validatorBinary()}\` in .tom/tom_vscode_extension.json). `
            + `It is compiled from tom_ai/ai_build/tom_specs_clitool by \`${BUILD_COMMAND}\` in the extension `
            + '(compile_and_install.sh / .ps1 run it), which needs a Dart SDK at build time only. '
            + `How to get or configure it: ${dartBinariesHelp().page} (command ${HELP_COMMAND}).`);
    }
}

// ── Working around a missing binary ───────────────────────────────────────────

/** Whether the validator (tomspecs) is there (configured or bundled) for this platform, read now. */
export function isValidatorAvailable(): boolean {
    return currentDartBinary(validatorBinary()).source !== 'missing';
}

/** The warning a tool answer carries when it skipped what needs the binary: `tomspecs missing on <platform>: <what>`. */
export function validatorMissingWarning(what: string, platform: string = getCurrentPlatform()): string {
    return `${validatorBinary()} missing on ${platform}: ${what}`;
}

/** The message shown to the user when a tool skipped validation. */
export function validationSkippedMessage(platform: string = getCurrentPlatform()): string {
    return `CodeSpecs validation skipped: ${validatorBinary()} is not available on ${platform}.`;
}

let skippedNotifier: ((message: string) => void) | null = null;
const notifiedTools = new Set<string>();

/** How the user is told (the extension: a warning with the Dart binaries help button); set at activation. */
export function setValidationSkippedNotifier(notifier: ((message: string) => void) | null): void {
    skippedNotifier = notifier;
}

/**
 * A tool skipped validation: tell the user, at most once per tool in this
 * window session (a queue walk calls the same tool many times). The tool's
 * answer carries the warning every time.
 */
export function noteValidationSkipped(tool: string): void {
    if (notifiedTools.has(tool)) { return; }
    notifiedTools.add(tool);
    skippedNotifier?.(validationSkippedMessage());
}

/** Forget which tools have told the user (a test's fresh session). */
export function resetValidationSkippedNotices(): void {
    notifiedTools.clear();
}

/** A usage error: the binary refused its arguments (exit 2); the message is its stderr. */
export class CodeSpecsUsageError extends Error {}

function binaryName(): string {
    return binaryFileName(validatorBinary());
}

/**
 * The binary's path: a configured `bridge.executables.tomspecs` that
 * exists first, else the bundled one (services/dartBinariesStatus.ts); throws
 * {@link CodeSpecsBinaryMissing} naming the build step when neither is there.
 */
export function validateCodespecsBinary(extensionRoot: string = dartBinariesExtensionRoot()): string {
    const found = currentDartBinary(validatorBinary(), extensionRoot);
    if (!found.path) {
        throw new CodeSpecsBinaryMissing(path.join(extensionRoot, 'bin', getCurrentPlatform(), binaryName()));
    }
    return found.path;
}

export type { BinaryRun };

/** Run the binary with `args`; resolves with its exit code and both streams (a non-zero exit is not a rejection). */
export function runValidateCodespecs(args: string[], extensionRoot?: string): Promise<BinaryRun> {
    const call = clitoolInvocation({ tool: 'validate_codespecs', args });
    return runBinaryFile(validateCodespecsBinary(extensionRoot), call.args, call.binary, { timeoutMs: RUN_TIMEOUT_MS });
}

/** The trio's three package folders, absolute. */
export interface Trio {
    shared: string;
    client: string;
    server: string;
}

/**
 * The trio from what was given. The binary needs all three; a missing client
 * or server is taken as the shared folder's sibling when the shared folder's
 * name ends in `shared` (`<app>_codespec_shared` → `<app>_codespec_client`,
 * `codespec/shared` → `codespec/client`) — the naming the slices fix. Anything
 * else is a usage error naming what is missing.
 */
export function resolveTrio(dirs: { shared?: string; client?: string; server?: string }): Trio {
    const sibling = (locus: 'client' | 'server'): string => {
        const given = dirs[locus];
        if (given) { return given; }
        const shared = dirs.shared;
        if (shared && /shared$/.test(path.basename(shared))) {
            return path.join(path.dirname(shared), path.basename(shared).replace(/shared$/, locus));
        }
        throw new CodeSpecsUsageError(`The ${locus} package is missing: pass \`${locus}\`, or a \`shared\` folder named …shared `
            + 'so its siblings can be found.');
    };
    if (!dirs.shared) {
        throw new CodeSpecsUsageError('The shared package is missing: pass `shared` (the <app>_codespec_shared folder), or `ir` (the trio\'s IR folder) instead.');
    }
    return { shared: dirs.shared, client: sibling('client'), server: sibling('server') };
}

/** One violation, as the `--json` report writes it. */
export interface CodeSpecsViolation {
    check: number;
    checkTitle: string | null;
    definedIn: string;
    severity: string;
    file: string | null;
    line: number | null;
    token: string | null;
    area: string | null;
    message: string;
}

export interface CodeSpecsValidationReport {
    format: string;
    formatVersion: number;
    inputs: Record<string, string | null>;
    passed: boolean;
    summary: string;
    checks: Array<{ number: number; definedIn: string; title: string }>;
    notRun: Array<{ checks: number[]; reason: string }>;
    excludedAreas: Array<Record<string, unknown>>;
    /**
     * The coverage gaps settled `leaveAsIs` (codespecs_derivation_contract.md
     * §2.11) whose tokens check 35 did not hold against the trio; only when
     * there are any.
     */
    leftAsIsGaps?: Array<Record<string, unknown>>;
    /** With `recordGaps`: the gaps the run appended to coverage_gaps.yaml (possibly none). */
    recordedGaps?: Array<Record<string, unknown>>;
    violations: CodeSpecsViolation[];
}

/** A `--json` report, refusing a format this reader does not know. */
export function parseValidationReport(text: string): CodeSpecsValidationReport {
    let json: Partial<CodeSpecsValidationReport>;
    try {
        json = JSON.parse(text) as Partial<CodeSpecsValidationReport>;
    } catch (e) {
        throw new Error(`${validatorLabel()} --json did not write JSON: ${(e as Error).message}`);
    }
    if (json.format !== VALIDATION_FORMAT || json.formatVersion !== VALIDATION_FORMAT_VERSION) {
        throw new Error(`${validatorLabel()} wrote ${json.format ?? 'no format'}/${json.formatVersion ?? '?'}; this reader understands `
            + `${VALIDATION_FORMAT}/${VALIDATION_FORMAT_VERSION} only. Rebuild the binary with \`${BUILD_COMMAND}\` from a matching tom_specs_clitool.`);
    }
    return json as CodeSpecsValidationReport;
}

export interface ValidationOptions extends Partial<Trio> {
    /** The trio's IR (irspecs_ir.md): a folder of `*.ir.yaml` documents, checked in place of the trio. */
    ir?: string;
    /** With `ir`: a second generation run's IR folder, for the determinism check (31). */
    regeneratedIr?: string;
    extracts?: string;
    migrations?: string;
    csVocabulary?: string;
    coreSource?: string;
    regenerated?: Partial<Trio>;
    /**
     * `--record-gaps` (needs `extracts`): every token check 35 reports becomes
     * a coverage gap (needs: unknown, foundBy: mechanical) in
     * `coverage_gaps.yaml` beside the extracts, unless an open or `leaveAsIs`
     * gap names it already. The checks run as without it.
     */
    recordGaps?: boolean;
}

/**
 * The binary's arguments for `options`, in its own option names. Every input
 * given is passed on as given: `--ir` together with `--shared` / `--client` /
 * `--server` (or `--regenerated-ir` without `--ir`) is the binary's to refuse
 * (exit 2), so the caller gets its own message.
 */
export function validationArgs(options: ValidationOptions): string[] {
    const args = ['--json'];
    const optional: Array<[string, string | undefined]> = [
        ['--shared', options.shared],
        ['--client', options.client],
        ['--server', options.server],
        ['--ir', options.ir],
        ['--regenerated-ir', options.regeneratedIr],
        ['--extracts', options.extracts],
        ['--migrations', options.migrations],
        ['--cs-vocabulary', options.csVocabulary],
        ['--core-source', options.coreSource],
        ['--regenerated-shared', options.regenerated?.shared],
        ['--regenerated-client', options.regenerated?.client],
        ['--regenerated-server', options.regenerated?.server],
    ];
    for (const [flag, value] of optional) {
        if (value !== undefined) { args.push(flag, value); }
    }
    if (options.recordGaps) { args.push('--record-gaps'); }
    return args;
}

/**
 * Run the checks. Clean (exit 0) and violations (exit 1) both resolve with the
 * report; a usage error (exit 2) rejects with {@link CodeSpecsUsageError}.
 */
export async function validateCodeSpecs(options: ValidationOptions, extensionRoot?: string): Promise<CodeSpecsValidationReport> {
    const run = await runValidateCodespecs(validationArgs(options), extensionRoot);
    if (run.exitCode === 2) {
        throw new CodeSpecsUsageError(run.stderr.trim() || `${validatorLabel()} refused its arguments.`);
    }
    if (run.exitCode !== 0 && run.exitCode !== 1) {
        throw new Error(`${validatorLabel()} exited ${run.exitCode}: ${run.stderr.trim()}`);
    }
    const report = parseValidationReport(run.stdout);
    if (report.passed !== (run.exitCode === 0)) {
        throw new Error(`${validatorLabel()} exited ${run.exitCode} with a report that says passed=${report.passed}.`);
    }
    return report;
}

/** The trio's back-link index (`codespecs-backlinks` JSON), from the binary. */
export async function backlinkIndexJson(dirs: { shared?: string; client?: string; server?: string }, extensionRoot?: string): Promise<string> {
    const trio = resolveTrio(dirs);
    const run = await runValidateCodespecs(['--backlinks', '--shared', trio.shared, '--client', trio.client, '--server', trio.server], extensionRoot);
    if (run.exitCode !== 0) {
        throw new CodeSpecsUsageError(run.stderr.trim() || `${validatorLabel()} --backlinks exited ${run.exitCode}.`);
    }
    return run.stdout;
}
