#!/usr/bin/env node
/**
 * Run every test stage, whatever the earlier ones did.   (`npm test`)
 *
 *   node scripts/run-test-stages.cjs
 *
 * The stages are lint:media, every `test:*` script of package.json in the
 * order it lists them, and audit:tools last — so a stage added to
 * package.json is run without touching this file.
 *
 * `npm test` used to chain them with `&&`, so a failure in test:tools meant
 * utils, managers, handlers and the tool audit never ran, and the output gave
 * no sign of it: a "full suite" could report a few failures having skipped
 * half the tests. Now every stage runs, its output streams as before, and a
 * summary at the end lists each stage with its result and node:test's counts.
 *
 * Exit code: 0 when every stage passed, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXT_ROOT = path.resolve(__dirname, '..');

/** The stages, in order: lint:media, the `test:*` scripts, audit:tools. */
function stagesOf(scripts) {
    const tests = Object.keys(scripts).filter((name) => name.startsWith('test:'));
    return [
        ...(scripts['lint:media'] ? ['lint:media'] : []),
        ...tests,
        ...(scripts['audit:tools'] ? ['audit:tools'] : []),
    ];
}

/** node:test's closing counts (`ℹ tests N`, `ℹ pass N`, `ℹ fail N`), or null when the output has none. */
function parseCounts(output) {
    const count = (label) => {
        const m = new RegExp(`^ℹ ${label} (\\d+)\\s*$`, 'm').exec(output || '');
        return m ? Number(m[1]) : undefined;
    };
    const tests = count('tests');
    const pass = count('pass');
    const fail = count('fail');
    if (tests === undefined || pass === undefined || fail === undefined) { return null; }
    return { tests, pass, fail };
}

/**
 * Run `stages` in order with `run(stage) → {code, output}`; every stage runs,
 * whatever the ones before answered. A stage that cannot start counts as failed.
 */
async function runStages(stages, run) {
    const results = [];
    for (const stage of stages) {
        const start = Date.now();
        let code;
        let output = '';
        try {
            ({ code, output } = await run(stage));
        } catch (err) {
            code = 1;
            output = String(err && err.message ? err.message : err);
            process.stderr.write(`✖ ${stage} could not run: ${output}\n`);
        }
        results.push({ stage, code: code === 0 ? 0 : (code || 1), ms: Date.now() - start, counts: parseCounts(output) });
    }
    return results;
}

function exitCode(results) {
    return results.some((r) => r.code !== 0) ? 1 : 0;
}

/** One line per stage, then the verdict naming the failed stages. */
function summarize(results) {
    const width = Math.max(...results.map((r) => r.stage.length));
    const lines = ['', 'Test stages:'];
    for (const r of results) {
        const verdict = r.code === 0 ? 'ok    ' : 'FAILED';
        const counts = r.counts ? `  ${r.counts.pass} passed, ${r.counts.fail} failed` : '';
        const secs = `${(r.ms / 1000).toFixed(1)} s`.padStart(8);
        lines.push(`  ${r.stage.padEnd(width)}  ${verdict}${secs}${counts}`);
    }
    const failed = results.filter((r) => r.code !== 0).map((r) => r.stage);
    lines.push(failed.length === 0
        ? `✔ all ${results.length} stages passed`
        : `✖ ${failed.length} of ${results.length} stages failed: ${failed.join(', ')}`);
    return `${lines.join('\n')}\n`;
}

/** `npm run <stage>`, its output streamed through and kept for the counts. */
function npmRun(stage) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', stage], {
            cwd: EXT_ROOT,
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
        child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
    });
}

module.exports = { stagesOf, parseCounts, runStages, exitCode, summarize };

if (require.main === module) {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
    runStages(stagesOf(pkg.scripts), (stage) => {
        process.stdout.write(`\n▶▶ npm run ${stage}\n`);
        return npmRun(stage);
    }).then((results) => {
        process.stdout.write(summarize(results));
        process.exitCode = exitCode(results);
    });
}
