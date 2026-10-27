#!/usr/bin/env node
// Write out/build-info.json: the commit the extension was built from, whether
// the sources had uncommitted changes, and the build time. A running window
// reads it once at activation and compares it with the installed copy's
// (src/utils/buildStamp.ts), so it can say when a newer build is installed and
// it needs a reload to run it. Runs as the last step of `npm run compile`.
//
// Outside a git checkout (a source tarball) the commit is left out; the build
// time alone still orders builds.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const git = (args) => {
    try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return undefined;
    }
};

const commit = git(['rev-parse', '--short', 'HEAD']);
// Only this package's sources count: other folders of the repo do not change the build.
const status = commit === undefined ? undefined : git(['status', '--porcelain', '--', '.']);
const info = {
    ...(commit ? { commit } : {}),
    ...(status ? { dirty: true } : {}),
    builtAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`Wrote out/build-info.json (${info.commit ?? 'no commit'}${info.dirty ? ', dirty' : ''}, ${info.builtAt})`);
