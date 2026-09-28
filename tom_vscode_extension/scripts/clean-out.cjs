#!/usr/bin/env node
// Remove the whole `out/` tree so the next compile rebuilds it from scratch.
//
// Why this exists: `tsc` only ever *writes* files — it never removes an output
// whose source has gone away. The test scripts glob `out/**/__tests__/*.test.js`,
// so a deleted test source leaves a zombie behind that keeps running forever
// against a contract that no longer exists. That is not hypothetical: deleting
// `src/utils/__tests__/mcpServerSchema.test.ts` left its June build in place and
// `npm run test:utils` reported 12 failures for six weeks. The reverse case is
// worse — a zombie that keeps *passing* grants confidence in code that is gone.
//
// Wiping the directory makes `out/` a pure function of `src/`, so the invariant
// holds by construction rather than by a pruning heuristic that has to be kept
// in step with the build. `tsc` here is a full (non-incremental) build anyway,
// so this costs nothing.
//
// Written as a `.cjs` script rather than `rm -rf out` because npm runs scripts
// through cmd.exe on Windows, where `rm` does not exist — the same reason
// `copy-config.cjs` exists.

const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'out');

fs.rmSync(outDir, { recursive: true, force: true });

console.log('Cleaned out/');
