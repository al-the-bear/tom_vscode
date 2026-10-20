/**
 * The validate_codespecs build stamp (scripts/codespecs-binary-stamp.cjs,
 * vscimpa7): what the bundled binary was built from, compared with the source
 * as it is now — over a fake ai_build in a temp folder.
 *
 *   BS-1 the files the binary is built from: the clitool's lib, its entry, pubspec.yaml / .lock / overrides,
 *        and lib + pubspec.yaml of every sibling the overrides resolve by path; not its tests
 *   BS-2 freshness: no binary, no stamp, then a build's stamp is fresh; an edit in the clitool's lib or in a
 *        path-resolved sibling makes it stale, naming `npm run codespecs:build`; a rebuild (new stamp) is fresh
 *        again; an edit elsewhere (the clitool's tests) changes nothing
 *   BS-3 no clitool source: not measured
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stamp = require(path.join(EXT_ROOT, 'scripts', 'codespecs-binary-stamp.cjs')) as {
    feedFiles(aiBuild: string): string[];
    writeStamp(o: { extRoot: string; aiBuild: string; platform: string }): { sourceHash: string; sourceFiles: number; clitool: { head: string | null } };
    checkFreshness(o: { extRoot: string; aiBuild: string; platform: string }): { state: string; message: string };
    stampPath(extRoot: string, platform: string): string;
};

const PLATFORM = 'darwin-arm64';

function fixture(): { aiBuild: string; extRoot: string; put(rel: string, text: string): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-stamp-'));
    const aiBuild = path.join(root, 'ai_build');
    const extRoot = path.join(root, 'ext');
    const put = (rel: string, text: string): void => {
        const p = path.join(aiBuild, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
    };
    put('tom_specs_clitool/lib/tom_specs_clitool.dart', 'export "src/a.dart";');
    put('tom_specs_clitool/lib/src/a.dart', 'void a() {}');
    put('tom_specs_clitool/bin/validate_codespecs.dart', 'void main() {}');
    put('tom_specs_clitool/bin/other_tool.dart', 'void main() {}');
    put('tom_specs_clitool/test/a_test.dart', 'void main() {}');
    put('tom_specs_clitool/pubspec.yaml', 'name: tom_specs_clitool');
    put('tom_specs_clitool/pubspec.lock', 'packages: {}');
    put('tom_specs_clitool/pubspec_overrides.yaml', 'dependency_overrides:\n  sib:\n    path: ../sib\n');
    put('sib/lib/sib.dart', 'void s() {}');
    put('sib/test/sib_test.dart', 'void main() {}');
    put('sib/pubspec.yaml', 'name: sib');
    return { aiBuild, extRoot, put };
}

describe('the validate_codespecs build stamp', () => {
    test('BS-1: the files the binary is built from', () => {
        const { aiBuild } = fixture();
        assert.deepEqual(stamp.feedFiles(aiBuild), [
            'sib/lib/sib.dart',
            'sib/pubspec.yaml',
            'tom_specs_clitool/bin/validate_codespecs.dart',
            'tom_specs_clitool/lib/src/a.dart',
            'tom_specs_clitool/lib/tom_specs_clitool.dart',
            'tom_specs_clitool/pubspec.lock',
            'tom_specs_clitool/pubspec.yaml',
            'tom_specs_clitool/pubspec_overrides.yaml',
        ]);
    });

    test('BS-2: fresh, stale, rebuilt', () => {
        const { aiBuild, extRoot, put } = fixture();
        const o = { extRoot, aiBuild, platform: PLATFORM };
        assert.equal(stamp.checkFreshness(o).state, 'noBinary');
        fs.mkdirSync(path.join(extRoot, 'bin', PLATFORM), { recursive: true });
        fs.writeFileSync(path.join(extRoot, 'bin', PLATFORM, 'validate_codespecs'), 'binary');
        const none = stamp.checkFreshness(o);
        assert.equal(none.state, 'noStamp');
        assert.match(none.message, /npm run codespecs:build/);

        const written = stamp.writeStamp(o);
        assert.equal(written.sourceFiles, 8);
        assert.match(written.sourceHash, /^[0-9a-f]{64}$/);
        assert.equal(written.clitool.head, null, 'not a git checkout');
        assert.ok(fs.existsSync(stamp.stampPath(extRoot, PLATFORM)));
        assert.equal(stamp.checkFreshness(o).state, 'fresh');

        put('tom_specs_clitool/test/a_test.dart', 'void main() { /* changed */ }');
        put('tom_specs_clitool/bin/other_tool.dart', 'void main() { /* changed */ }');
        assert.equal(stamp.checkFreshness(o).state, 'fresh', 'tests and other tools do not feed the binary');

        put('tom_specs_clitool/lib/src/a.dart', 'void a() { /* changed */ }');
        const stale = stamp.checkFreshness(o);
        assert.equal(stale.state, 'stale');
        assert.match(stale.message, /npm run codespecs:build/);
        stamp.writeStamp(o);
        assert.equal(stamp.checkFreshness(o).state, 'fresh', 'a rebuild writes a new stamp');

        put('sib/lib/sib.dart', 'void s() { /* changed */ }');
        assert.equal(stamp.checkFreshness(o).state, 'stale', 'a path-resolved sibling feeds the binary');
    });

    test('BS-3: no clitool source', () => {
        const { extRoot } = fixture();
        fs.mkdirSync(path.join(extRoot, 'bin', PLATFORM), { recursive: true });
        fs.writeFileSync(path.join(extRoot, 'bin', PLATFORM, 'validate_codespecs'), 'binary');
        assert.equal(stamp.checkFreshness({ extRoot, aiBuild: path.join(extRoot, 'nowhere'), platform: PLATFORM }).state, 'noSource');
    });
});
