#!/usr/bin/env node
/**
 * check-bridge-fresh.cjs — are tom_vscode_bridge's committed d4rt bridges
 * (`*.b.dart`) what the generator produces from the current sources, the
 * scripting API included?
 *
 * Runs the bridge package's own guard, BRIDGE-FRESH-01
 * (tom_vscode_bridge/test/bridges_fresh_test.dart): it regenerates into a
 * scratch tree under `.dart_tool/` and compares, writing nothing to the
 * package. A stale bridge is what a scripting-API change without a
 * regeneration leaves behind: tom_bs then compiles without the new members
 * and nothing else says so. About 6 s on mbp.
 *
 * Usage: node scripts/check-bridge-fresh.cjs   (npm run check:bridges)
 * Exit: the test's exit code; 2 when Dart is not on PATH (not measured).
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

/** The command: `dart test test/bridges_fresh_test.dart` in the bridge package beside the extension. */
function bridgeFreshCommand(extRoot) {
    return { cwd: path.resolve(extRoot, '..', 'tom_vscode_bridge'), args: ['test', 'test/bridges_fresh_test.dart'] };
}

if (require.main === module) {
    const { cwd, args } = bridgeFreshCommand(path.resolve(__dirname, '..'));
    const r = spawnSync('dart', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.error) {
        console.error(`NOT MEASURED: could not run dart (${r.error.message}); put the Dart SDK on PATH.`);
        process.exit(2);
    }
    if (r.status !== 0) {
        console.error('The committed bridges of tom_vscode_bridge are stale: run compile_and_install.sh (or d4rtgen in the bridge) and commit the bridges it changes.');
    }
    process.exit(r.status ?? 1);
}

module.exports = { bridgeFreshCommand };
