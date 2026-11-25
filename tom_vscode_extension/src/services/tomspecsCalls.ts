/**
 * The calls of tom_specs_clitool, through its one binary, `tomspecs`
 * (tom_specs_clitool/README.md § "The tomspecs binary").
 *
 * A call names its command group and the command's arguments:
 *
 * | Group | Call | tomspecs |
 * | --- | --- | --- |
 * | `codespecs` | `<args>` | `:codespecs-validate <args>` |
 * | `spec` | `<check> <args>` (+ `specRoot`) | `:spec-<check> [--spec-root d] <args>` (`validate` → `:spec-render`, `project-idea-coverage` → `:spec-idea-coverage`) |
 * | `ir` | `<sub> <args>` | `:ir-<sub> <args>` |
 *
 * vscode-free.
 */

import { runDartBinary, type BinaryRun } from './dartBinariesStatus';

/** The tomspecs command groups the extension calls. */
export type ClitoolTool = 'codespecs' | 'spec' | 'ir';

/** A tomspecs call: its group, its arguments, and the spec checks' `--spec-root`. */
export interface ClitoolCall {
    tool: ClitoolTool;
    /** For `spec` and `ir` the first argument is the check / subcommand. */
    args: string[];
    /** The spec checks' `--spec-root <dir>`. */
    specRoot?: string;
}

/* eslint-disable @typescript-eslint/naming-convention -- the keys are check and subcommand names */
/** The spec checks → tomspecs commands. */
export const SPEC_COMMANDS: Readonly<Record<string, string>> = {
    'validate': ':spec-render',
    'import-answers': ':spec-import-answers',
    'accept-marks': ':spec-accept-marks',
    'required-fields': ':spec-required-fields',
    'question-register': ':spec-question-register',
    'feature-register': ':spec-feature-register',
    'project-idea-coverage': ':spec-idea-coverage',
    'authorization': ':spec-authorization',
    'coverage': ':spec-coverage',
    // The document-set commands (spec_sync_cli.dart): `--json` prints one JSON object.
    'sync-report': ':spec-sync-report',
    'backfill': ':spec-backfill',
    'prefill': ':spec-prefill',
    'derive-fields': ':spec-derive-fields',
    'rename-id': ':spec-rename-id',
};

/** The IR subcommands → tomspecs commands. */
export const IR_COMMANDS: Readonly<Record<string, string>> = {
    'from-codespecs': ':ir-from-codespecs',
    'map': ':ir-map',
    'emit': ':ir-emit',
    'export': ':ir-export',
};
/* eslint-enable @typescript-eslint/naming-convention */

/** The binary every clitool call runs. */
export const CLITOOL_BINARY = 'tomspecs';

/** The binary a call runs (always tomspecs) and its argument list. */
export function clitoolInvocation(call: ClitoolCall): { binary: typeof CLITOOL_BINARY; args: string[] } {
    const specRoot = call.specRoot ? ['--spec-root', call.specRoot] : [];
    switch (call.tool) {
        case 'codespecs':
            return { binary: CLITOOL_BINARY, args: [':codespecs-validate', ...call.args] };
        case 'spec': {
            const [check, ...rest] = call.args;
            const command = SPEC_COMMANDS[check];
            if (!command) { throw new Error(`spec check ${check}: no tomspecs command for it`); }
            return { binary: CLITOOL_BINARY, args: [command, ...specRoot, ...rest] };
        }
        case 'ir': {
            const [sub, ...rest] = call.args;
            const command = IR_COMMANDS[sub];
            if (!command) { throw new Error(`ir ${sub}: no tomspecs command for it`); }
            return { binary: CLITOOL_BINARY, args: [command, ...rest] };
        }
    }
}

/** The call as a command line, for an answer: `tomspecs :ir-map --mapper …`. */
export function clitoolCommandLine(call: ClitoolCall): string {
    const { binary, args } = clitoolInvocation(call);
    return [binary, ...args].join(' ');
}

/** Run a clitool call through tomspecs. */
export function runClitool(call: ClitoolCall, options: { cwd?: string; timeoutMs: number; extensionRoot?: string; env?: NodeJS.ProcessEnv }): Promise<BinaryRun> {
    const { binary, args } = clitoolInvocation(call);
    return runDartBinary(binary, args, options);
}
