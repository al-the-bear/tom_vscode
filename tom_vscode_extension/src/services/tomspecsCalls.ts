/**
 * The calls of tom_specs_clitool, through the one `tomspecs` binary.
 *
 * Every old clitool binary is a command of `tomspecs`, run in-process with
 * the old tool's options unchanged after the command name (tom_specs tsbin7;
 * tom_specs_clitool/README.md § "The tomspecs binary"):
 *
 * | Old call | tomspecs |
 * | --- | --- |
 * | `validate_codespecs <args>` | `:codespecs-validate <args>` |
 * | `spec_checks [--spec-root d] <check> <args>` | `:spec-<check> [--spec-root d] <args>` (`validate` → `:spec-render`, `project-idea-coverage` → `:spec-idea-coverage`) |
 * | `irspecs <sub> <args>` | `:ir-<sub> <args>` |
 *
 * The tools call `tomspecs` only. The old binaries stay bundled until
 * tom_specs' tsbin8 removes them; `TOM_SPECS_LEGACY_BINARIES=1` routes the
 * same calls to them (the tests run each spec, CodeSpecs and IR tool test
 * through both). vscode-free.
 */

import { legacyBinariesMode, runDartBinary, type BinaryRun, type DartBinaryName } from './dartBinariesStatus';

export { LEGACY_BINARIES_ENV, legacyBinariesMode } from './dartBinariesStatus';

/** The old clitool binaries, each now a group of tomspecs commands. */
export type ClitoolTool = 'validate_codespecs' | 'spec_checks' | 'irspecs';

/** A call in the old form: the tool, its arguments, and spec_checks' global `--spec-root`. */
export interface ClitoolCall {
    tool: ClitoolTool;
    /** For spec_checks and irspecs the first argument is the check / subcommand. */
    args: string[];
    /** spec_checks' `--spec-root <dir>`. */
    specRoot?: string;
}

/* eslint-disable @typescript-eslint/naming-convention -- the keys are the old tools' check and subcommand names */
/** spec_checks' checks → tomspecs commands. */
export const SPEC_CHECKS_COMMANDS: Readonly<Record<string, string>> = {
    'validate': ':spec-render',
    'import-answers': ':spec-import-answers',
    'accept-marks': ':spec-accept-marks',
    'required-fields': ':spec-required-fields',
    'question-register': ':spec-question-register',
    'feature-register': ':spec-feature-register',
    'project-idea-coverage': ':spec-idea-coverage',
    'authorization': ':spec-authorization',
    'coverage': ':spec-coverage',
};

/** irspecs' subcommands → tomspecs commands. */
export const IRSPECS_COMMANDS: Readonly<Record<string, string>> = {
    'from-codespecs': ':ir-from-codespecs',
    'map': ':ir-map',
    'emit': ':ir-emit',
    'export': ':ir-export',
};
/* eslint-enable @typescript-eslint/naming-convention */

/** The binary a call runs and its argument list: tomspecs, or the old tool in legacy mode. */
export function clitoolInvocation(call: ClitoolCall, legacy: boolean = legacyBinariesMode()): { binary: DartBinaryName; args: string[] } {
    const specRoot = call.specRoot ? ['--spec-root', call.specRoot] : [];
    if (legacy) {
        return { binary: call.tool, args: call.tool === 'spec_checks' ? [...specRoot, ...call.args] : [...call.args] };
    }
    switch (call.tool) {
        case 'validate_codespecs':
            return { binary: 'tomspecs', args: [':codespecs-validate', ...call.args] };
        case 'spec_checks': {
            const [check, ...rest] = call.args;
            const command = SPEC_CHECKS_COMMANDS[check];
            if (!command) { throw new Error(`spec_checks ${check}: no tomspecs command for it`); }
            return { binary: 'tomspecs', args: [command, ...specRoot, ...rest] };
        }
        case 'irspecs': {
            const [sub, ...rest] = call.args;
            const command = IRSPECS_COMMANDS[sub];
            if (!command) { throw new Error(`irspecs ${sub}: no tomspecs command for it`); }
            return { binary: 'tomspecs', args: [command, ...rest] };
        }
    }
}

/** The call as a command line, for an answer: `tomspecs :ir-map --mapper …`. */
export function clitoolCommandLine(call: ClitoolCall, legacy: boolean = legacyBinariesMode()): string {
    const { binary, args } = clitoolInvocation(call, legacy);
    return [binary, ...args].join(' ');
}

/** The binary the clitool calls need in this mode: tomspecs, or the old tool. */
export function clitoolBinary(tool: ClitoolTool, legacy: boolean = legacyBinariesMode()): DartBinaryName {
    return legacy ? tool : 'tomspecs';
}

/** Run a clitool call (tomspecs, or the old binary in legacy mode). */
export function runClitool(call: ClitoolCall, options: { cwd?: string; timeoutMs: number; extensionRoot?: string; env?: NodeJS.ProcessEnv }): Promise<BinaryRun> {
    const { binary, args } = clitoolInvocation(call);
    return runDartBinary(binary, args, options);
}
