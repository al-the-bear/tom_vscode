/**
 * scripts/check-som-installed.cjs: after `npm install`, the installed TomSpecs
 * model must be the one `som:pack` just packed (vendor/tom_som/versions.json),
 * so an install that kept a stale tarball fails instead of shipping it.
 *
 *   SI-1  equal modelHash → ok
 *   SI-2  a different installed model → not ok, naming both versions and the remedy
 *   SI-3  a missing pack record or installed meta → not ok, naming what is missing
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkSomInstalled } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'check-som-installed.cjs')) as {
    checkSomInstalled(extRoot: string): { ok: boolean; message: string };
};

function ext(packed: object | null, installed: { version: string; modelHash: string } | null): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'som-installed-'));
    if (packed) {
        fs.mkdirSync(path.join(root, 'vendor', 'tom_som'), { recursive: true });
        fs.writeFileSync(path.join(root, 'vendor', 'tom_som', 'versions.json'), JSON.stringify(packed));
    }
    if (installed) {
        const facade = path.join(root, 'node_modules', 'tom_som_typescript_v0');
        fs.mkdirSync(path.join(facade, 'meta'), { recursive: true });
        fs.writeFileSync(path.join(facade, 'package.json'), JSON.stringify({ version: installed.version }));
        fs.writeFileSync(path.join(facade, 'meta', 'spec_model.meta.json'), JSON.stringify({ modelHash: installed.modelHash }));
    }
    return root;
}

describe('check-som-installed', () => {
    test('SI-1: the packed model is installed', () => {
        const r = checkSomInstalled(ext({ tom_som_typescript_v0: '1.6.1', modelHash: 'abc' }, { version: '1.6.1', modelHash: 'abc' }));
        assert.equal(r.ok, true, r.message);
    });

    test('SI-2: a stale installed model', () => {
        const r = checkSomInstalled(ext({ tom_som_typescript_v0: '1.6.1', modelHash: 'new' }, { version: '1.6.0', modelHash: 'old' }));
        assert.equal(r.ok, false);
        assert.match(r.message, /1\.6\.0/);
        assert.match(r.message, /1\.6\.1/);
        assert.match(r.message, /npm install/);
    });

    test('SI-3: missing inputs', () => {
        assert.match(checkSomInstalled(ext(null, { version: '1', modelHash: 'x' })).message, /versions\.json/);
        assert.match(checkSomInstalled(ext({ tom_som_typescript_v0: '1', modelHash: 'x' }, null)).message, /not installed/);
    });
});
