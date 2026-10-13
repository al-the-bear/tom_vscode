/**
 * The bundled validate_codespecs binary: where it is, how it is run, and the
 * two documents it writes — the `codespecs-validation` report (`--json`) and
 * the `codespecs-backlinks` index (`--backlinks`).
 *
 * The binary is tom_specs_clitool's `bin/validate_codespecs.dart`, compiled
 * with `dart compile exe` into `<extension>/bin/<platform>/` by
 * scripts/build-validate-codespecs.cjs (which the install scripts run). It
 * parses source text only, so it needs no Dart SDK at run time; nothing here
 * ever falls back to `dart run`.
 *
 * vscode-free.
 */

import * as path from 'path';
import { execFile } from 'child_process';
import { getCurrentPlatform, resolveBundledBinary } from '../utils/executableResolver';

export const VALIDATION_FORMAT = 'codespecs-validation';
export const VALIDATION_FORMAT_VERSION = 1;

/** The command that puts the binary in place, named by every "missing" error. */
export const BUILD_COMMAND = 'npm run codespecs:build';

/** The extension root: this file is out/services/. */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

/** Generous for a run measured at under a second; a hung binary must not hang a tool call. */
const RUN_TIMEOUT_MS = 60_000;

export class CodeSpecsBinaryMissing extends Error {
    constructor(readonly expected: string) {
        super(`The validate_codespecs binary is not in this extension (expected at ${expected}). `
            + `It is compiled from tom_ai/ai_build/tom_specs_clitool by \`${BUILD_COMMAND}\` in the extension `
            + '(compile_and_install.sh / .ps1 run it), which needs a Dart SDK at build time only.');
    }
}

/** A usage error: the binary refused its arguments (exit 2); the message is its stderr. */
export class CodeSpecsUsageError extends Error {}

function binaryName(): string {
    return process.platform === 'win32' ? 'validate_codespecs.exe' : 'validate_codespecs';
}

/** The binary's path; throws {@link CodeSpecsBinaryMissing} naming the build step when it is absent. */
export function validateCodespecsBinary(extensionRoot: string = EXTENSION_ROOT): string {
    const found = resolveBundledBinary(binaryName(), extensionRoot);
    if (!found) {
        throw new CodeSpecsBinaryMissing(path.join(extensionRoot, 'bin', getCurrentPlatform(), binaryName()));
    }
    return found;
}

export interface BinaryRun {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/** Run the binary with `args`; resolves with its exit code and both streams (a non-zero exit is not a rejection). */
export function runValidateCodespecs(args: string[], extensionRoot?: string): Promise<BinaryRun> {
    const binary = validateCodespecsBinary(extensionRoot);
    return new Promise((resolve, reject) => {
        execFile(binary, args, { maxBuffer: 64 << 20, timeout: RUN_TIMEOUT_MS }, (error, stdout, stderr) => {
            const code = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
            if (error && typeof code !== 'number') {
                // Spawn failure, timeout or signal — no exit code to interpret.
                reject(new Error(`validate_codespecs did not run to completion: ${error.message}`));
                return;
            }
            resolve({ exitCode: typeof code === 'number' ? code : 0, stdout, stderr });
        });
    });
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
        throw new CodeSpecsUsageError('The shared package is missing: pass `shared` (the <app>_codespec_shared folder).');
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
    violations: CodeSpecsViolation[];
}

/** A `--json` report, refusing a format this reader does not know. */
export function parseValidationReport(text: string): CodeSpecsValidationReport {
    let json: Partial<CodeSpecsValidationReport>;
    try {
        json = JSON.parse(text) as Partial<CodeSpecsValidationReport>;
    } catch (e) {
        throw new Error(`validate_codespecs --json did not write JSON: ${(e as Error).message}`);
    }
    if (json.format !== VALIDATION_FORMAT || json.formatVersion !== VALIDATION_FORMAT_VERSION) {
        throw new Error(`validate_codespecs wrote ${json.format ?? 'no format'}/${json.formatVersion ?? '?'}; this reader understands `
            + `${VALIDATION_FORMAT}/${VALIDATION_FORMAT_VERSION} only. Rebuild the binary with \`${BUILD_COMMAND}\` from a matching tom_specs_clitool.`);
    }
    return json as CodeSpecsValidationReport;
}

export interface ValidationOptions extends Trio {
    extracts?: string;
    migrations?: string;
    csVocabulary?: string;
    coreSource?: string;
    regenerated?: Trio;
}

/** The binary's arguments for `options`, in its own option names. */
export function validationArgs(options: ValidationOptions): string[] {
    const args = ['--json', '--shared', options.shared, '--client', options.client, '--server', options.server];
    const optional: Array<[string, string | undefined]> = [
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
    return args;
}

/**
 * Run the checks. Clean (exit 0) and violations (exit 1) both resolve with the
 * report; a usage error (exit 2) rejects with {@link CodeSpecsUsageError}.
 */
export async function validateCodeSpecs(options: ValidationOptions, extensionRoot?: string): Promise<CodeSpecsValidationReport> {
    const run = await runValidateCodespecs(validationArgs(options), extensionRoot);
    if (run.exitCode === 2) {
        throw new CodeSpecsUsageError(run.stderr.trim() || 'validate_codespecs refused its arguments.');
    }
    if (run.exitCode !== 0 && run.exitCode !== 1) {
        throw new Error(`validate_codespecs exited ${run.exitCode}: ${run.stderr.trim()}`);
    }
    const report = parseValidationReport(run.stdout);
    if (report.passed !== (run.exitCode === 0)) {
        throw new Error(`validate_codespecs exited ${run.exitCode} with a report that says passed=${report.passed}.`);
    }
    return report;
}

/** The trio's back-link index (`codespecs-backlinks` JSON), from the binary. */
export async function backlinkIndexJson(dirs: { shared?: string; client?: string; server?: string }, extensionRoot?: string): Promise<string> {
    const trio = resolveTrio(dirs);
    const run = await runValidateCodespecs(['--backlinks', '--shared', trio.shared, '--client', trio.client, '--server', trio.server], extensionRoot);
    if (run.exitCode !== 0) {
        throw new CodeSpecsUsageError(run.stderr.trim() || `validate_codespecs --backlinks exited ${run.exitCode}.`);
    }
    return run.stdout;
}
