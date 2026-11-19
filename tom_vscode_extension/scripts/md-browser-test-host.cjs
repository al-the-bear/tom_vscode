#!/usr/bin/env node
/**
 * Write the MD Browser's test host: one plain HTML file that shows the page
 * (media/markdownBrowser/) without VS Code — it publishes the host object
 * `window.__tomVscodeApi`, loads the page's files from this folder by URL,
 * logs the messages the page posts and answers `webviewReady` with a document
 * (src/handlers/mdBrowserTestHost.ts).
 *
 *   node scripts/md-browser-test-host.cjs --out <file.html> [--doc <file.md>] [--first-paint] [--capabilities <a,b,…|none>]
 *
 * `--capabilities` names what the host declares (editing, reviewMarks, teamReview, assists, askBar,
 * navigation; default all): the page hides the controls of the others.
 *
 * Open the file in a browser. Needs `npm run compile` first (it runs the
 * compiled module from out/).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const out = value('--out');
if (!out) {
    console.error('usage: node scripts/md-browser-test-host.cjs --out <file.html> [--doc <file.md>] [--first-paint] [--capabilities <a,b,…|none>]');
    process.exit(2);
}
const compiled = path.join(root, 'out', 'handlers', 'mdBrowserTestHost.js');
if (!fs.existsSync(compiled)) {
    console.error(`✖ ${path.relative(process.cwd(), compiled)} is missing: run \`npm run compile\` first.`);
    process.exit(1);
}
const { writeMdBrowserTestHost } = require(compiled);
const doc = value('--doc');
const file = writeMdBrowserTestHost(out, {
    extensionRoot: root,
    ...(doc ? { document: fs.readFileSync(doc, 'utf8'), documentPath: path.basename(doc) } : {}),
    firstPaint: args.includes('--first-paint'),
    ...(value('--capabilities') !== undefined ? { capabilities: value('--capabilities') === 'none' ? [] : value('--capabilities').split(',').map((c) => c.trim()).filter(Boolean) } : {}),
});
console.log(`MD Browser test host written: ${file}`);
console.log('Open it in a browser; the page\'s messages are listed at the bottom right and in the console.');
