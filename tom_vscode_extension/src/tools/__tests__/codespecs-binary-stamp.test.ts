/**
 * The tomspecs build stamp (scripts/codespecs-binary-stamp.cjs,
 * vscimpa7): what the bundled binary was built from, compared with the source
 * as it is now — over a fake ai_build in a temp folder.
 *
 *   BS-1 the files the binary is built from: the clitool's lib, its entry, pubspec.yaml / .lock / overrides,
 *        and lib + pubspec.yaml of every sibling the overrides resolve by path; not its tests
 *   BS-2 freshness: no binary, no stamp, then a build's stamp is fresh; an edit in the clitool's lib or in a
 *        path-resolved sibling makes it stale, naming `npm run codespecs:build`; a rebuild (new stamp) is fresh
 *        again; an edit elsewhere (the clitool's tests) changes nothing
 *   BS-3 no clitool source: not measured
 *   BS-4 in a git checkout, a stale result names the feed files with uncommitted edits (modified or new, in the
 *        clitool or a path-resolved sibling; not tests): CV-8 skips on them; a committed change leaves the list
 *        empty, so a stale binary is a failure again
 *   BS-5 the clitool's commit only from ai_build's own repository (vscimpb105): an export inside another
 *        repository (TOM_SOM_AI_BUILD, `git archive HEAD`) gets `head: null`, `dirty: null` and a note, and no
 *        uncommitted files of the enclosing repository; ai_build's own checkout gets its HEAD
 *   BS-6 the build (scripts/build-validate-codespecs.cjs buildAll, compile stubbed): tomspecs compiled into a
 *        scratch folder and taken over with its stamp only when it built; a failing build leaves
 *        bin/<platform>/ (binaries and stamps, the retired ones too) as it was and says so; a build that goes
 *        through deletes the retired clitool binaries and their stamps, nothing else
 *   BS-7 tomspecs is the one clitool binary; the retired ones are named only for their removal
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stamp = require(path.join(EXT_ROOT, 'scripts', 'codespecs-binary-stamp.cjs')) as {
    feedFiles(aiBuild: string): string[];
    writeStamp(o: { extRoot: string; aiBuild: string; platform: string; dir?: string; name?: string }): { sourceHash: string; sourceFiles: number; clitool: { head: string | null; dirty?: boolean | null; note?: string } };
    gitInfo(aiBuild: string): { head: string | null; dirty: boolean | null; note?: string };
    isOwnGitRepo(aiBuild: string): boolean;
    uncommittedFeedFiles(aiBuild: string): string[];
    NOT_A_CHECKOUT_NOTE: string; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    CLITOOL_BINARIES: string[]; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    RETIRED_CLITOOL_BINARIES: string[]; // eslint-disable-line @typescript-eslint/naming-convention -- the script's constant
    retiredFiles(platform: string): string[];
    checkFreshness(o: { extRoot: string; aiBuild: string; platform: string }): { state: string; message: string; uncommitted?: string[] };
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
    put('tom_specs_clitool/bin/tomspecs.dart', 'void main() {}');
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

describe('the tomspecs build stamp', () => {
    test('BS-1: the files the binary is built from', () => {
        const { aiBuild } = fixture();
        assert.deepEqual(stamp.feedFiles(aiBuild), [
            'sib/lib/sib.dart',
            'sib/pubspec.yaml',
            'tom_specs_clitool/bin/tomspecs.dart',
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
        fs.writeFileSync(path.join(extRoot, 'bin', PLATFORM, 'tomspecs'), 'binary');
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
        fs.writeFileSync(path.join(extRoot, 'bin', PLATFORM, 'tomspecs'), 'binary');
        assert.equal(stamp.checkFreshness({ extRoot, aiBuild: path.join(extRoot, 'nowhere'), platform: PLATFORM }).state, 'noSource');
    });

    test('BS-4: uncommitted edits named on a stale result', () => {
        const { aiBuild, extRoot, put } = fixture();
        // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variables
        const git = (...args: string[]): string => execFileSync('git', args, { cwd: aiBuild, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' } });
        git('init', '-q');
        git('add', '-A');
        git('commit', '-q', '-m', 'seed');
        const o = { extRoot, aiBuild, platform: PLATFORM };
        fs.mkdirSync(path.join(extRoot, 'bin', PLATFORM), { recursive: true });
        fs.writeFileSync(path.join(extRoot, 'bin', PLATFORM, 'tomspecs'), 'binary');
        stamp.writeStamp(o);
        const fresh = stamp.checkFreshness(o);
        assert.equal(fresh.state, 'fresh');
        assert.equal(fresh.uncommitted, undefined, 'only a stale result names them');

        put('tom_specs_clitool/lib/src/a.dart', 'void a() { /* uncommitted */ }');
        put('sib/lib/new.dart', 'void n() {}');
        put('tom_specs_clitool/test/a_test.dart', 'void main() { /* not fed */ }');
        const dirty = stamp.checkFreshness(o);
        assert.equal(dirty.state, 'stale');
        assert.deepEqual(dirty.uncommitted, ['sib/lib/new.dart', 'tom_specs_clitool/lib/src/a.dart']);
        assert.match(dirty.message, /uncommitted: sib\/lib\/new\.dart, tom_specs_clitool\/lib\/src\/a\.dart/);

        git('add', '-A');
        git('commit', '-q', '-m', 'edits');
        const committed = stamp.checkFreshness(o);
        assert.equal(committed.state, 'stale', 'a committed change still needs a rebuild');
        assert.deepEqual(committed.uncommitted, []);
    });

    test('BS-5: the commit only from ai_build\'s own repository', () => {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variables
        const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid' };
        const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
        // An export: ai_build's files in a folder of another repository (as ztmp/ of the workspace).
        const { aiBuild, extRoot, put } = fixture();
        const outer = path.dirname(aiBuild);
        git(outer, 'init', '-q');
        git(outer, 'add', '-A');
        git(outer, 'commit', '-q', '-m', 'the enclosing repository');
        put('tom_specs_clitool/lib/src/a.dart', 'void a() { /* changed in the enclosing repository */ }');
        assert.equal(stamp.isOwnGitRepo(aiBuild), false);
        assert.deepEqual(stamp.gitInfo(aiBuild), { head: null, dirty: null, note: stamp.NOT_A_CHECKOUT_NOTE });
        assert.deepEqual(stamp.uncommittedFeedFiles(aiBuild), [], 'the enclosing repository\'s changes are not ai_build\'s');
        const written = stamp.writeStamp({ extRoot, aiBuild, platform: PLATFORM, dir: (fs.mkdirSync(path.join(extRoot, 's'), { recursive: true }), path.join(extRoot, 's')) });
        assert.deepEqual(written.clitool, { head: null, dirty: null, note: stamp.NOT_A_CHECKOUT_NOTE });
        assert.ok(fs.existsSync(path.join(extRoot, 's', 'tomspecs.build.json')), '`dir` names the stamp\'s folder');
        assert.match(fs.readFileSync(path.join(extRoot, 's', 'tomspecs.build.json'), 'utf8'), /"note": "ai_build is not a git checkout of its own/);
        // ai_build's own checkout: its HEAD.
        const own = fixture();
        git(own.aiBuild, 'init', '-q');
        git(own.aiBuild, 'add', '-A');
        git(own.aiBuild, 'commit', '-q', '-m', 'seed');
        assert.equal(stamp.isOwnGitRepo(own.aiBuild), true);
        assert.deepEqual(stamp.gitInfo(own.aiBuild), { head: git(own.aiBuild, 'rev-parse', 'HEAD'), dirty: false });
    });

    test('BS-6: the build, or nothing', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const build = require(path.join(EXT_ROOT, 'scripts', 'build-validate-codespecs.cjs')) as {
            buildAll(o: Record<string, unknown>): number;
        };
        const { aiBuild, extRoot } = fixture();
        const outDir = path.join(extRoot, 'bin', PLATFORM);
        fs.mkdirSync(outDir, { recursive: true });
        // What an earlier build left.
        for (const name of stamp.CLITOOL_BINARIES) {
            fs.writeFileSync(path.join(outDir, name), `old ${name}`);
            fs.writeFileSync(path.join(outDir, `${name}.build.json`), `{"old": "${name}"}`);
        }
        fs.writeFileSync(path.join(outDir, 'buildkit'), 'old buildkit');
        const retired = stamp.retiredFiles(PLATFORM);
        for (const f of retired) { fs.writeFileSync(path.join(outDir, f), `retired ${f}`); }
        const errors: string[] = [];
        const origError = console.error;
        const origLog = console.log;
        console.error = (m: string) => { errors.push(String(m)); };
        console.log = () => undefined;
        try {
            const scratch = path.join(extRoot, 'scratch');
            const stampFor = (name: string, dir: string) => stamp.writeStamp({ extRoot, aiBuild, platform: PLATFORM, name, dir });
            // tomspecs does not compile.
            const failing = build.buildAll({
                platform: PLATFORM, outDir, scratch, resolve: () => undefined, stampFor,
                compile: (name: string, outFile: string) => { if (name === 'tomspecs') { throw new Error('Type SpecGenerationUnit not found'); } fs.writeFileSync(outFile, `new ${name}`); },
            });
            assert.equal(failing, 1);
            for (const name of stamp.CLITOOL_BINARIES) {
                assert.equal(fs.readFileSync(path.join(outDir, name), 'utf8'), `old ${name}`, `${name} kept`);
                assert.equal(fs.readFileSync(path.join(outDir, `${name}.build.json`), 'utf8'), `{"old": "${name}"}`, `${name}'s stamp kept`);
            }
            assert.equal(fs.readFileSync(path.join(outDir, 'buildkit'), 'utf8'), 'old buildkit');
            for (const f of retired) { assert.ok(fs.existsSync(path.join(outDir, f)), `${f} kept by a failed build`); }
            assert.ok(!fs.existsSync(scratch), 'the scratch folder is cleared');
            const text = errors.join('\n');
            assert.match(text, /Building tomspecs failed: Type SpecGenerationUnit not found/);
            assert.match(text, /Nothing was copied: tomspecs is taken over only when it builds/);
            assert.match(text, /is unchanged: the previous binaries and stamps are kept \(buildkit, irspecs, spec_checks, tomspecs, validate_codespecs\)/);
            // A failed dependency resolution says the same.
            errors.length = 0;
            assert.equal(build.buildAll({ platform: PLATFORM, outDir, scratch, resolve: () => { throw new Error('pub get'); }, compile: () => undefined, stampFor }), 1);
            assert.match(errors.join('\n'), /previous binaries and stamps are kept/);
            // Every one builds: taken over with fresh stamps.
            const ok = build.buildAll({
                platform: PLATFORM, outDir, scratch, resolve: () => undefined, stampFor,
                compile: (name: string, outFile: string) => { fs.writeFileSync(outFile, `new ${name}`); },
            });
            assert.equal(ok, 0);
            for (const name of stamp.CLITOOL_BINARIES) {
                assert.equal(fs.readFileSync(path.join(outDir, name), 'utf8'), `new ${name}`);
                assert.match(fs.readFileSync(path.join(outDir, `${name}.build.json`), 'utf8'), /"sourceHash"/);
            }
            assert.deepEqual(fs.readdirSync(outDir).sort(), ['buildkit', 'tomspecs', 'tomspecs.build.json'], 'the retired binaries and stamps are gone, nothing else');
            assert.ok(!fs.existsSync(scratch));
        } finally {
            console.error = origError;
            console.log = origLog;
        }
    });

    test('BS-7: tomspecs is the one clitool binary', () => {
        assert.deepEqual(stamp.CLITOOL_BINARIES, ['tomspecs']);
        assert.deepEqual(stamp.RETIRED_CLITOOL_BINARIES, ['validate_codespecs', 'spec_checks', 'irspecs']);
        assert.deepEqual(stamp.retiredFiles('win32-x64'), [
            'validate_codespecs.exe', 'validate_codespecs.build.json', 'spec_checks.exe', 'spec_checks.build.json', 'irspecs.exe', 'irspecs.build.json',
        ]);
        assert.match(stamp.stampPath('/e', PLATFORM), /tomspecs\.build\.json$/, 'the default stamp is tomspecs\'');
    });
});
