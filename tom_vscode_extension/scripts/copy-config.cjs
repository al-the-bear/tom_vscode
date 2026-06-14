#!/usr/bin/env node
// Cross-platform replacement for `mkdir -p out/config && cp src/config/*.json out/config/`.
// The old shell one-liner only worked on macOS/Linux; on Windows npm runs scripts
// through cmd.exe where `mkdir -p` and `cp` don't exist (yielding "Syntaxfehler.").
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src', 'config');
const outDir = path.join(root, 'out', 'config');

fs.mkdirSync(outDir, { recursive: true });

const jsonFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json'));
for (const file of jsonFiles) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
}

console.log(`Copied ${jsonFiles.length} config file(s) to out/config`);
