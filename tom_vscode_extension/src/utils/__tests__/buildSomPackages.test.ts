/**
 * Packing the TomSpecs SOM packages (scripts/build-som-packages.cjs): the runtime and the facade carry
 * the model version and move together.
 *
 *   SP-1 equal versions: nothing to say
 *   SP-2 different versions while their package.json files have uncommitted changes in ai_build: the
 *        message says the chain is being released there right now, names the files, and offers
 *        `--from-head` (an install ran while another session had raised the runtime, not yet the facade)
 *   SP-3 different versions, nothing uncommitted: raise the other one
 *   SP-4 the versions are compared before anything is built, so a mismatch leaves node_modules and the
 *        lockfile as they were
 *   SP-5 after removing the installed copies and their lockfile entries it installs the new tarballs at
 *        once, so a build running meanwhile never finds node_modules without the SOM packages for longer
 *        than that install
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'build-som-packages.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { versionMismatchMessage } = require(SCRIPT) as {
    versionMismatchMessage(versions: Record<string, string>, dirty: string[]): string | null;
};

/* eslint-disable @typescript-eslint/naming-convention -- the package names as npm writes them */
const versions = (runtime: string, facade: string): Record<string, string> =>
    ({ tom_som_typescript_runtime: runtime, tom_som_typescript_v0: facade });
/* eslint-enable @typescript-eslint/naming-convention */

describe('build-som-packages', () => {
    test('SP-1: equal', () => {
        assert.equal(versionMismatchMessage(versions('1.7.2', '1.7.2'), [' M tom_som_typescript_v0/package.json']), null);
    });

    test('SP-2: a release in progress', () => {
        const message = versionMismatchMessage(versions('1.7.2', '1.7.1'), [
            ' M tom_som_typescript_runtime/CHANGELOG.md',
            ' M tom_som_typescript_runtime/package.json',
        ]) ?? '';
        assert.match(message, /^version mismatch: tom_som_typescript_runtime 1\.7\.2, tom_som_typescript_v0 1\.7\.1\./);
        assert.match(message, / M tom_som_typescript_runtime\/package\.json/);
        assert.doesNotMatch(message, /CHANGELOG/, 'only the manifests are named');
        assert.match(message, /being released there right now/);
        assert.match(message, /npm run som:pack -- --from-head/);
    });

    test('SP-3: nothing uncommitted', () => {
        assert.match(versionMismatchMessage(versions('1.7.2', '1.7.1'), []) ?? '', /Raise the other one in ai_build\.$/);
    });

    test('SP-4: compared before anything is built', () => {
        const source = readFileSync(SCRIPT, 'utf8');
        const main = source.slice(source.indexOf('function main('));
        assert.ok(main.indexOf('versionMismatchMessage(versions, dirty)') > 0);
        assert.ok(main.indexOf('versionMismatchMessage(versions, dirty)') < main.indexOf("npm(['install'"), 'before npm install');
        assert.ok(main.indexOf('versionMismatchMessage(versions, dirty)') < main.indexOf('fs.rmSync'), 'before node_modules is touched');
    });

    test('SP-5: installed at once', () => {
        const main = readFileSync(SCRIPT, 'utf8');
        const body = main.slice(main.indexOf('function main('));
        const removed = body.indexOf("fs.rmSync(path.join(EXT_ROOT, 'node_modules', pkg)");
        const reinstalled = body.indexOf("npm(['install', '--no-audit', '--no-fund'], EXT_ROOT)");
        assert.ok(removed > 0 && reinstalled > removed, 'npm install in the extension after the copies are removed');
    });
});
