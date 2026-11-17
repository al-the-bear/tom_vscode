/**
 * The command git runs for an `_ai` merge driver registered from the
 * extension (vscimpb142c; utils/aiMergeDriverSetup.ts):
 *
 *   <node> out/utils/aiMergeDriverCli.js <driver> %O %A %B %L %P
 *
 * It merges %B into %A with the TypeScript driver (utils/aiMergeDrivers/),
 * writes %A with LF line endings and exits 0, or exits 1 so git keeps its
 * conflict markers (an unrecognised or unparseable file, bad arguments).
 * Needs Node only — VS Code's own (`ELECTRON_RUN_AS_NODE=1`) or one on PATH.
 *
 * vscode-free.
 */

import { AI_MERGE_DRIVER_NAMES, isAiMergeDriver, runMergeDriverOnFiles } from './aiMergeDrivers';

/** Run the CLI with `argv` (without node and the script); answers the exit code. */
export function aiMergeDriverCliMain(argv: readonly string[], stderr: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): number {
    const [driver, ancestor, ours, theirs, , display] = argv;
    if (!driver || !isAiMergeDriver(driver)) {
        stderr(`aiMergeDriverCli: the first argument is the driver: ${AI_MERGE_DRIVER_NAMES.join(', ')}`);
        return 1;
    }
    if (argv.length < 6) {
        stderr(`${driver}: expected 5 args (%O %A %B %L %P)`);
        return 1;
    }
    try {
        const r = runMergeDriverOnFiles(driver, ancestor, ours, theirs, display ?? '');
        if (r.message) { stderr(r.message); }
        return r.code;
    } catch (e) {
        stderr(`${driver}: ${(e as Error).message}`);
        return 1;
    }
}

if (require.main === module) {
    process.exitCode = aiMergeDriverCliMain(process.argv.slice(2));
}
