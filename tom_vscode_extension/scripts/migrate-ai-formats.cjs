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
 * Files the session already has are merged the way a reconcile merges: with
 * the `_ai` merge drivers git has registered (`git config --global
 * merge.<driver>.driver`, set up by the al_the_bear skills). Scratch files for
 * a merge go to `<workspace>/ztmp/migrate-ai-formats-<time>/` and are removed.
 *
 * Exit 0 when everything listed could be (or was) done, 1 when problems
 * remain, 2 on a usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'out', 'utils');
const { migrateAiFormats } = require(path.join(OUT, 'aiFormatMigration.js'));
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

function makeMerger(scratchRoot) {
    let n = 0;
    return (driver, target, legacy) => {
        let command;
        try { command = execSync(`git config --global --get merge.${driver}.driver`, { encoding: 'utf8' }).trim(); } catch { command = ''; }
        if (!command) { return undefined; }
        fs.mkdirSync(scratchRoot, { recursive: true });
        const dir = path.join(scratchRoot, String(n++));
        fs.mkdirSync(dir);
        const base = path.join(dir, 'base');
        const ours = path.join(dir, 'ours');
        fs.writeFileSync(base, '');
        fs.copyFileSync(target, ours);
        const q = (p) => `"${p}"`;
        const line = command.replace('%O', q(base)).replace('%A', q(ours)).replace('%B', q(legacy))
            .replace('%L', '7').replace('%P', q(path.basename(target)));
        try {
            execSync(line, { stdio: 'pipe' });
            return fs.readFileSync(ours, 'utf8');
        } catch {
            return undefined;
        }
    };
}

function markdownReport(result, apply) {
    const lines = [`# _ai format migration (${apply ? 'applied' : 'dry run'}, ${new Date().toISOString()})`, ''];
    const byQuest = new Map();
    for (const c of result.changes) {
        if (!byQuest.has(c.quest)) { byQuest.set(c.quest, []); }
        byQuest.get(c.quest).push(c);
    }
    for (const [quest, changes] of [...byQuest].sort((a, b) => a[0].localeCompare(b[0]))) {
        const counts = {};
        for (const c of changes) { counts[c.step] = (counts[c.step] || 0) + 1; }
        lines.push(`## ${quest}`, '', Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '), '');
        for (const c of changes.filter((x) => x.step !== 'storage' || !/ -> .*\/trail\//.test(x.detail)).slice(0, 40)) {
            lines.push(`- ${c.step}: ${c.detail}`);
        }
        const trailMoves = changes.filter((x) => x.step === 'storage' && / -> .*\/trail\//.test(x.detail)).length;
        if (trailMoves) { lines.push(`- storage: ${trailMoves} raw trail file(s) moved into the session's trail/`); }
        lines.push('');
    }
    if (result.problems.length) {
        lines.push('## Problems', '');
        for (const p of result.problems) { lines.push(`- ${p.quest} (${p.step}): ${p.detail}`); }
        lines.push('');
    }
    return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const workspace = args.workspace ? path.resolve(args.workspace) : findWorkspace(process.cwd());
if (!workspace) { console.error('no workspace root (a folder with _ai/quests and .tom) above the current directory; pass --workspace'); process.exit(2); }
const scratch = path.join(workspace, 'ztmp', `migrate-ai-formats-${Date.now()}`);
const result = migrateAiFormats({
    aiRoot: path.join(workspace, '_ai'),
    hostSlug: hostSlugOf(),
    apply: args.apply,
    merge: makeMerger(scratch),
    workspaceConfigPath: path.join(workspace, '.tom', 'tom_vscode_extension.json'),
    quests: args.quests.length ? args.quests : undefined,
});
fs.rmSync(scratch, { recursive: true, force: true });

const counts = {};
for (const c of result.changes) { counts[c.step] = (counts[c.step] || 0) + 1; }
console.log(`${args.apply ? 'applied' : 'dry run'}: ${result.changes.length} change(s) ${JSON.stringify(counts)}, ${result.problems.length} problem(s)`);
for (const p of result.problems) { console.log(`  problem ${p.quest} (${p.step}): ${p.detail}`); }
if (args.report) { fs.writeFileSync(args.report, markdownReport(result, args.apply) + '\n', 'utf8'); console.log(`report: ${args.report}`); }
process.exit(result.problems.length ? 1 : 0);
