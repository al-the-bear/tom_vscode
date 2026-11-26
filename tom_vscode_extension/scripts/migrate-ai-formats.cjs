#!/usr/bin/env node
/**
 * Bring every quest under `_ai` to the current file formats
 * (src/utils/aiFormatMigration.ts). Runs without a window, from the compiled
 * extension (`npm run compile` first).
 *
 *   node scripts/migrate-ai-formats.cjs                 # dry run: list every change
 *   node scripts/migrate-ai-formats.cjs --apply         # do it
 *   node scripts/migrate-ai-formats.cjs --quest d4rt    # one quest (repeatable); workspace steps still run
 *   node scripts/migrate-ai-formats.cjs --report FILE   # also write the changes as Markdown, per quest
 *   --workspace DIR   the workspace root holding `_ai` and `.tom/` (default: found upward from here)
 *
 * Files the session already has are merged the way a reconcile merges, with
 * the extension's own `_ai` merge drivers (src/utils/aiMergeDrivers/): no git
 * and no registered driver needed.
 *
 * Last, when nothing is left as a problem, `_ai/format-version.yaml` gets the
 * format version migrated to and the date (src/utils/aiFormatVersion.ts), and
 * `_ai/local/format-version.<host>.yaml` the same for this machine's own files
 * (src/utils/aiFormatMigrationRun.ts). The extension opens its migration
 * screen at start while either is missing or older than its build (the
 * command @T: Migrate _ai Formats does the same without a checkout).
 *
 * Exit 0 when everything listed could be (or was) done, 1 when problems
 * remain, 2 on a usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out', 'utils');
const { runAiFormatMigration, makeMigrationMerger, makeGitUntrack, migrationReportMarkdown } = require(path.join(OUT, 'aiFormatMigrationRun.js'));
const { hostSlugOf } = require(path.join(OUT, 'hostSlug.js'));

function parseArgs(argv) {
    const args = { apply: false, quests: [], report: undefined, workspace: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') { args.apply = true; }
        else if (a === '--quest') { args.quests.push(argv[++i]); }
        else if (a === '--report') { args.report = argv[++i]; }
        else if (a === '--workspace') { args.workspace = argv[++i]; }
        else { console.error(`unknown argument: ${a}`); process.exit(2); }
    }
    return args;
}

/** The nearest folder upward holding both `_ai/quests` and `.tom`. */
function findWorkspace(start) {
    let dir = path.resolve(start);
    for (;;) {
        if (fs.existsSync(path.join(dir, '_ai', 'quests')) && fs.existsSync(path.join(dir, '.tom'))) { return dir; }
        const up = path.dirname(dir);
        if (up === dir) { return undefined; }
        dir = up;
    }
}

const args = parseArgs(process.argv.slice(2));
const workspace = args.workspace ? path.resolve(args.workspace) : findWorkspace(process.cwd());
if (!workspace) { console.error('no workspace root (a folder with _ai/quests and .tom) above the current directory; pass --workspace'); process.exit(2); }
const result = runAiFormatMigration({
    aiRoot: path.join(workspace, '_ai'),
    hostSlug: hostSlugOf(),
    apply: args.apply,
    merge: makeMigrationMerger(),
    workspaceConfigPath: path.join(workspace, '.tom', 'tom_vscode_extension.json'),
    userConfigPath: path.join(require('os').homedir(), '.tom', 'vscode', 'tom_vscode_extension.user.yaml'),
    quests: args.quests.length ? args.quests : undefined,
    // Format version 11 takes the files its ignore rules now cover out of git's index (step untrack).
    ...makeGitUntrack(path.join(workspace, '_ai')),
});

const counts = {};
for (const c of result.changes) { counts[c.step] = (counts[c.step] || 0) + 1; }
console.log(`${args.apply ? 'applied' : 'dry run'}: ${result.changes.length} change(s) ${JSON.stringify(counts)}, ${result.problems.length} problem(s)`);
for (const p of result.problems) { console.log(`  problem ${p.quest} (${p.step}): ${p.detail}`); }
if (args.report) { fs.writeFileSync(args.report, migrationReportMarkdown(result, args.apply) + '\n', 'utf8'); console.log(`report: ${args.report}`); }
process.exit(result.problems.length ? 1 : 0);
