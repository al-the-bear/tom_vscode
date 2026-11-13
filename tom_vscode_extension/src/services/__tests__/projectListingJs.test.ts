/**
 * The JavaScript port of `buildkit :projects --all --json` (services/projectListingJs.ts, qrfix14). Checked against
 * tom_build_base's own listing on this workspace when it was written (247 projects, the same JSON byte for byte,
 * order included); these cases pin the rules on a fixture tree.
 *
 *   PJ-1 the walk: hidden folders and kAlwaysSkipDirectories are left out; a folder with buildkit_master.yaml,
 *        tom_skip.yaml or buildkit_skip.yaml is left out with its subtree (the root is not); a project folder is
 *        listed but not entered; nor a folder whose buildkit.yaml says `recursive: false`; links to folders are
 *        followed; `zom_*` projects are filtered out
 *   PJ-2 the natures, in NatureDetector's order, and the entry: primary nature (Flutter over TypeScript, TypeScript
 *        over JavaScript), the name from buildkit.yaml, else the project file, else the folder; the id from
 *        `project_id`; description; version; Dart kinds (flutter / dart_console / dart_package / dart); Go's module,
 *        Rust's and Python's identity, Java's pom, C / C++ by their sources
 *   PJ-3 the order: the Dart projects in build order (dependencies first, ties by package name), the others after
 *        them; a dependency cycle keeps the walk order
 *   PJ-4 dartSort is Dart's List.sort: the same order of equal keys as the Dart VM gives (recorded reference)
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeBuildOrder, dartSort, listProjectsJs, scanFolders } from '../projectListingJs.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pjlisting-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function put(rel: string, text = ''): void {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}
const pubspec = (name: string, deps: string[] = [], extra = ''): string =>
    `name: ${name}\nversion: 1.0.0\n${deps.length ? `dependencies:\n${deps.map((d) => `  ${d}: any`).join('\n')}\n` : ''}${extra}`;

describe('the JavaScript project listing', () => {
    test('PJ-1: the walk', () => {
        const root = path.join(tmp, 'walk');
        put('walk/buildkit_master.yaml', 'navigation:\n  exclude: [x/**]\n');
        put('walk/a/pubspec.yaml', pubspec('a'));
        put('walk/a/test/fixture/pubspec.yaml', pubspec('nested_fixture')); // inside a project: not entered
        put('walk/.hidden/h/pubspec.yaml', pubspec('hidden'));
        put('walk/node_modules/n/pubspec.yaml', pubspec('in_node_modules'));
        put('walk/ztmp/z/pubspec.yaml', pubspec('in_ztmp'));
        put('walk/sub/buildkit_master.yaml', '');
        put('walk/sub/s/pubspec.yaml', pubspec('in_subworkspace'));
        put('walk/skipped/tom_skip.yaml', '');
        put('walk/skipped/k/pubspec.yaml', pubspec('in_tom_skip'));
        put('walk/bkskip/buildkit_skip.yaml', '');
        put('walk/bkskip/k/pubspec.yaml', pubspec('in_buildkit_skip'));
        put('walk/flat/buildkit.yaml', 'recursive: false\n');
        put('walk/flat/f/pubspec.yaml', pubspec('under_recursive_false'));
        put('walk/group/zom_fixture/pubspec.yaml', pubspec('zom_fixture'));
        put('walk/group/b/pubspec.yaml', pubspec('b'));
        put('walk/elsewhere/linked/pubspec.yaml', pubspec('linked_target'));
        fs.mkdirSync(path.join(root, 'links'));
        fs.symlinkSync(path.join(root, 'elsewhere', 'linked'), path.join(root, 'links', 'via_link'));
        const names = listProjectsJs(root).projects.map((p) => p.name).sort();
        assert.deepEqual(names, ['a', 'b', 'linked_target', 'linked_target']);
        assert.ok(scanFolders(root).includes(path.join(root, 'group', 'zom_fixture')), 'zom_ is walked, then filtered');
        assert.ok(listProjectsJs(root).projects.some((p) => p.path === 'links/via_link'), 'a link to a folder is followed');
    });

    test('PJ-2: natures and entries', () => {
        const root = path.join(tmp, 'natures');
        put('natures/buildkit_master.yaml', '');
        put('natures/app/pubspec.yaml', pubspec('my_app', [], 'dependencies:\n  flutter:\n    sdk: flutter\n'));
        put('natures/app/tsconfig.json', '{}');
        put('natures/app/package.json', '{"name": "app-js", "version": "9.9.9"}');
        put('natures/app/build.yaml', '');
        fs.mkdirSync(path.join(root, 'app', '.git'), { recursive: true });
        put('natures/cli/pubspec.yaml', pubspec('my_cli'));
        put('natures/cli/bin/main.dart');
        put('natures/cli/buildkit.yaml', 'project_id: CLI\nname: The CLI\ndescription: " A tool "\n');
        put('natures/lib/pubspec.yaml', pubspec('my_lib'));
        put('natures/lib/lib/src/x.dart');
        put('natures/plain/pubspec.yaml', 'name: 7\n'); // a name that is not a string: the folder's
        put('natures/ext/package.json', '{"name": "my-ext", "version": "0.1.0", "engines": {"vscode": "^1.90.0"}}');
        put('natures/ext/tsconfig.json', '{}');
        put('natures/js/package.json', '{"name": "plain-js"}');
        put('natures/py/pyproject.toml', '[project]\nname = "py-tool"\nversion = "2.0"\n');
        put('natures/java/pom.xml', '<project><parent><artifactId>parent</artifactId></parent><artifactId>jar-it</artifactId><version>3.1</version></project>');
        put('natures/go/go.mod', 'module example.com/org/go-svc\n');
        put('natures/rs/Cargo.toml', '[package]\nname = "rusty"\nversion = "0.3.0"\n');
        put('natures/cpp/CMakeLists.txt', '');
        put('natures/cpp/src/a.cpp');
        put('natures/c/Makefile', '');
        put('natures/c/main.c');
        put('natures/make_only/Makefile', ''); // no sources: not a project
        const byPath = new Map(listProjectsJs(root).projects.map((p) => [p.path, p]));
        assert.deepEqual(byPath.get('app'), {
            id: 'my_app', name: 'my_app', path: 'app', absolutePath: path.join(root, 'app'), language: 'dart', type: 'flutter',
            natures: ['git', 'flutter', 'typescript', 'build_runner'], version: '1.0.0',
        });
        assert.deepEqual(byPath.get('cli'), {
            id: 'CLI', name: 'The CLI', path: 'cli', absolutePath: path.join(root, 'cli'), language: 'dart', type: 'dart_console',
            natures: ['dart_console', 'buildkit'], version: '1.0.0', description: 'A tool',
        });
        assert.equal(byPath.get('lib')?.type, 'dart_package');
        assert.deepEqual([byPath.get('plain')?.name, byPath.get('plain')?.type, 'version' in (byPath.get('plain') ?? {})], ['plain', 'dart', false]);
        assert.deepEqual([byPath.get('ext')?.type, byPath.get('ext')?.natures, byPath.get('ext')?.name], ['typescript', ['vscode_extension', 'typescript'], 'my-ext']);
        assert.deepEqual([byPath.get('js')?.type, byPath.get('js')?.name, 'version' in (byPath.get('js') ?? {})], ['javascript', 'plain-js', false]);
        assert.deepEqual([byPath.get('py')?.name, byPath.get('py')?.version], ['py-tool', '2.0']);
        assert.deepEqual([byPath.get('java')?.name, byPath.get('java')?.version], ['jar-it', '3.1'], 'the pom\'s own artifactId, not the parent\'s');
        assert.deepEqual([byPath.get('go')?.name, byPath.get('go')?.language], ['go-svc', 'go']);
        assert.deepEqual([byPath.get('rs')?.name, byPath.get('rs')?.version], ['rusty', '0.3.0']);
        assert.deepEqual([byPath.get('cpp')?.type, byPath.get('cpp')?.name], ['cpp', 'cpp']);
        assert.equal(byPath.get('c')?.type, 'c');
        assert.equal(byPath.has('make_only'), false);
        assert.equal(byPath.has('.'), false, 'the root has no project nature here');
    });

    test('PJ-3: build order', () => {
        const root = path.join(tmp, 'order');
        put('order/buildkit_master.yaml', '');
        put('order/zeta/pubspec.yaml', pubspec('zeta'));
        put('order/app/pubspec.yaml', pubspec('app', ['core', 'util']));
        put('order/core/pubspec.yaml', pubspec('core', ['zeta']));
        put('order/util/pubspec.yaml', pubspec('util'));
        put('order/web/package.json', '{"name": "web"}');
        put('order/alpha/pubspec.yaml', pubspec('alpha'));
        const r = listProjectsJs(root);
        assert.equal(r.cycle, false);
        assert.deepEqual(r.projects.map((p) => p.name), ['alpha', 'util', 'zeta', 'core', 'app', 'web']);
        put('order/zeta/pubspec.yaml', pubspec('zeta', ['app']));
        const cyclic = path.join(root);
        assert.equal(computeBuildOrder(['core', 'app', 'zeta'].map((n) => path.join(cyclic, n))), undefined);
        assert.equal(listProjectsJs(root).cycle, true);
    });

    test('PJ-4: dartSort is Dart\'s List.sort', () => {
        // Recorded with the Dart VM (Dart 3, dart:_internal Sort): 50 items keyed i*13 % 7, sorted by key only.
        const items = Array.from({ length: 50 }, (_, i) => `k${(i * 13) % 7}-${i}`);
        dartSort(items, (a, b) => { const x = a.split('-')[0]; const y = b.split('-')[0]; return x < y ? -1 : x > y ? 1 : 0; });
        assert.equal(items.join(','), 'k0-42,k0-7,k0-14,k0-0,k0-21,k0-28,k0-49,k0-35,k1-48,k1-6,k1-41,k1-13,k1-20,k1-27,k1-34,k2-5,k2-12,k2-47,k2-19,k2-26,k2-33,k2-40,k3-32,k3-25,k3-18,k3-11,k3-39,k3-4,k3-46,k4-24,k4-10,k4-45,k4-31,k4-17,k4-3,k4-38,k5-23,k5-2,k5-9,k5-30,k5-44,k5-37,k5-16,k6-43,k6-36,k6-29,k6-22,k6-15,k6-1,k6-8');
        const small = [3, 1, 2, 1];
        dartSort(small, (a, b) => a - b);
        assert.deepEqual(small, [1, 1, 2, 3]);
    });
});
