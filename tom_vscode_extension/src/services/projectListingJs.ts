/**
 * The workspace's projects without buildkit (qrfix14): a TypeScript port of
 * what `buildkit :projects --all --json` answers — tom_build_base's
 * `listProjectsFor(args, navigationDefaults: false)` with the defaults of a
 * plain `buildkit -R <root> :projects --all`:
 *
 *  - the walk (`FolderScanner.scan('.', recursive: false)`): from the root,
 *    every folder except hidden ones and `kAlwaysSkipDirectories`; a folder
 *    with `buildkit_master.yaml` (a nested workspace), `tom_skip.yaml` or
 *    `buildkit_skip.yaml` is left out with everything under it (not the root);
 *    a project folder (pubspec.yaml or another language's project file) is
 *    listed but not entered; nor is a folder whose `buildkit.yaml` says
 *    `recursive: false`;
 *  - the natures (`NatureDetector`), in its order: git, the Dart project kind
 *    (flutter / dart_console / dart_package / dart), vscode_extension,
 *    typescript, javascript, python, java, go, rust, c / cpp, buildkit,
 *    build_runner, workspace_root;
 *  - the test-project filter: `zom_*` folders are left out;
 *  - the entry (`ListedProject.fromContext`): the primary nature (Flutter,
 *    Dart, TypeScript, JavaScript, Python, Java, Go, Rust, C++, C) gives the
 *    language and type; the name is `buildkit.yaml`'s `name`, else the
 *    project file's, else the folder's; the id `project_id`, else the name;
 *    folders without a project nature are not listed;
 *  - the order: build order (`BuildOrderComputer`: Kahn over the Dart
 *    projects' `dependencies` inside the workspace, ties by package name),
 *    the other projects after them in walk order; on a dependency cycle, the
 *    walk order.
 *
 * It is the fallback while no buildkit runs here; keep it in step with
 * tom_build_base (test PJ-* compares it with the Dart listing's rules).
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import type { WorkspaceProject } from './workspaceProjects';

/** tom_build_base's `kAlwaysSkipDirectories`. */
export const ALWAYS_SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
    '.dart_tool', '.git', '.idea', '.vscode', 'build', 'node_modules', 'coverage', '.pub-cache', '.pub', '__pycache__', '.fvm',
    'ztmp', '_ai',
]);

/** tom_build_base's `languageProjectFiles`. */
const LANGUAGE_PROJECT_FILES = [
    'package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'Cargo.toml',
];
const NATIVE_BUILD_FILES = ['Makefile', 'makefile', 'GNUmakefile', 'CMakeLists.txt'];
const CPP_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hxx', '.hh']);
const SOURCE_SKIP_DIRS = new Set(['.git', 'build', 'target', 'node_modules', 'dist', '.dart_tool', 'ztmp']);

function exists(p: string): boolean {
    try { fs.statSync(p); return true; } catch { return false; }
}
function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
function isDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function readText(p: string): string | undefined {
    try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; }
}
function readYamlMap(p: string): Record<string, unknown> | undefined {
    const text = readText(p);
    if (text === undefined) { return undefined; }
    try {
        const doc = parseYaml(text) as unknown;
        return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc as Record<string, unknown> : undefined;
    } catch { return undefined; }
}
function readJson(p: string): Record<string, unknown> {
    try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
        return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc as Record<string, unknown> : {};
    } catch { return {}; }
}
function str(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}
/** `_nonEmpty` / `_string`: trimmed, undefined when empty. */
function nonEmpty(v: unknown): string | undefined {
    if (v === undefined || v === null) { return undefined; }
    const t = String(v).trim();
    return t === '' ? undefined : t;
}

// ----- project files (project_files.dart) -----------------------------------

/** `tomlTableStrings`: the quoted string values of one TOML table. */
export function tomlTableStrings(text: string, table: string): Record<string, string> {
    const values: Record<string, string> = {};
    let current: string | undefined;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) { continue; }
        const header = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
        if (header) { current = header[1]; continue; }
        if (current !== table) { continue; }
        const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
        if (kv) { values[kv[1]] = kv[2] ?? kv[3]; }
    }
    return values;
}

function pyprojectIdentity(text: string): { name?: string; version?: string } {
    for (const table of ['project', 'tool.poetry']) {
        const v = tomlTableStrings(text, table);
        if ('name' in v || 'version' in v) { return { name: v.name, version: v.version }; }
    }
    return {};
}

const POM_NESTED = ['parent', 'dependencies', 'dependencyManagement', 'build', 'reporting', 'profiles', 'plugins', 'pluginManagement', 'extensions'];
function pomElement(pom: string, element: string): string | undefined {
    let masked = pom.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
    for (const section of POM_NESTED) {
        masked = masked.replace(new RegExp(`<${section}(\\s[^>]*)?>[\\s\\S]*?</${section}>`, 'g'), (m) => ' '.repeat(m.length));
    }
    return new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`).exec(masked)?.[1];
}

/** `nativeSourceLanguages`: `c` / `cpp` sources up to three levels down. */
export function nativeSourceLanguages(dir: string): Set<string> {
    const found = new Set<string>();
    const walk = (d: string, depth: number): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (depth < 3 && !SOURCE_SKIP_DIRS.has(e.name)) { walk(path.join(d, e.name), depth + 1); }
                continue;
            }
            const ext = path.extname(e.name).toLowerCase();
            if (ext === '.c') { found.add('c'); }
            if (CPP_EXTENSIONS.has(ext)) { found.add('cpp'); }
            if (found.size === 2) { return; }
        }
    };
    walk(dir, 0);
    return found;
}

/** `isProjectFolder`. */
export function isProjectFolder(dir: string): boolean {
    if (isFile(path.join(dir, 'pubspec.yaml'))) { return true; }
    if (LANGUAGE_PROJECT_FILES.some((f) => isFile(path.join(dir, f)))) { return true; }
    if (NATIVE_BUILD_FILES.some((f) => isFile(path.join(dir, f)))) { return nativeSourceLanguages(dir).size > 0; }
    return false;
}

// ----- the walk (folder_scanner.dart) ---------------------------------------

function skipMarker(dir: string): boolean {
    return isFile(path.join(dir, 'buildkit_master.yaml'))
        || isFile(path.join(dir, 'tom_skip.yaml'))
        || isFile(path.join(dir, 'buildkit_skip.yaml'));
}

function buildkitRecursiveFalse(dir: string): boolean {
    const text = readText(path.join(dir, 'buildkit.yaml'));
    if (text === undefined) { return false; }
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('recursive:')) {
            const v = t.slice('recursive:'.length).trim();
            return v === 'false' || v === 'no';
        }
    }
    return false;
}

/**
 * A folder's entries in the order the file system gives them — what Dart's
 * `Directory.list` returns. (`fs.readdirSync` sorts them: libuv's scandir.)
 */
function rawEntries(dir: string): string[] {
    const names: string[] = [];
    let handle: fs.Dir | undefined;
    try {
        handle = fs.opendirSync(dir);
        for (let e = handle.readSync(); e; e = handle.readSync()) { names.push(e.name); }
    } catch { /* unreadable: no entries */ } finally {
        try { handle?.closeSync(); } catch { /* already closed */ }
    }
    return names;
}

/** The folders the walk visits, in walk order. */
export function scanFolders(root: string): string[] {
    const out: string[] = [];
    // A link that leads back up would walk forever; Dart has no guard, this one stops there.
    const onPath = new Set<string>();
    const visit = (dir: string, isRoot: boolean): void => {
        if (!isRoot && skipMarker(dir)) { return; }
        out.push(dir);
        if (isProjectFolder(dir)) { return; }
        if (buildkitRecursiveFalse(dir)) { return; }
        let real: string;
        try { real = fs.realpathSync(dir); } catch { return; }
        if (onPath.has(real)) { return; }
        onPath.add(real);
        for (const name of rawEntries(dir)) {
            if (name.startsWith('.')) { continue; }
            if (ALWAYS_SKIP_DIRECTORIES.has(name)) { continue; }
            const full = path.join(dir, name);
            // Dart's Directory.list follows links: a link to a folder is a folder.
            if (!isDir(full)) { continue; }
            visit(full, false);
        }
        onPath.delete(real);
    };
    if (isDir(root)) { visit(root, true); }
    return out;
}

// ----- natures (nature_detector.dart, language_detector.dart) ----------------

/** One nature: its short name, and the identity a project nature carries. */
interface Nature {
    name: string;
    /** Set on a project nature (Dart or another language). */
    project?: { language: string; name?: string; version?: string; rank: number };
    buildkit?: { projectId?: string; projectName?: string; description?: string };
}

/** The rank of each primary nature (primaryProjectNature): lower wins. */
const RANK: Record<string, number> = { flutter: 0, dart: 1, typescript: 2, javascript: 3, python: 4, java: 5, go: 6, rust: 7, cpp: 8, c: 9 };

function dartNature(dir: string): Nature {
    const folderName = path.basename(dir);
    const pubspec = readYamlMap(path.join(dir, 'pubspec.yaml')) ?? {};
    let projectName = folderName;
    let version: string | undefined;
    // `pubspec['name'] as String?` throws on another type: the name and version stay unread.
    if (pubspec.name === undefined || pubspec.name === null || typeof pubspec.name === 'string') {
        projectName = str(pubspec.name) ?? folderName;
        if (pubspec.version === undefined || pubspec.version === null || typeof pubspec.version === 'string') { version = str(pubspec.version); }
    }
    const deps = pubspec.dependencies;
    const flutter = deps && typeof deps === 'object' ? (deps as Record<string, unknown>).flutter : undefined;
    const hasFlutter = !!flutter && typeof flutter === 'object' && (flutter as Record<string, unknown>).sdk === 'flutter';
    const kind = hasFlutter ? 'flutter'
        : isDir(path.join(dir, 'bin')) ? 'dart_console'
            : isDir(path.join(dir, 'lib', 'src')) ? 'dart_package'
                : 'dart';
    return { name: kind, project: { language: 'dart', name: projectName, version, rank: hasFlutter ? RANK.flutter : RANK.dart } };
}

/** The natures of folder `dir`, in NatureDetector's order. */
export function detectNatures(dir: string): Nature[] {
    const natures: Nature[] = [];
    if (exists(path.join(dir, '.git'))) { natures.push({ name: 'git' }); }
    if (isFile(path.join(dir, 'pubspec.yaml'))) { natures.push(dartNature(dir)); }
    const packageJsonPath = path.join(dir, 'package.json');
    const hasPackageJson = isFile(packageJsonPath);
    if (hasPackageJson) {
        const text = readText(packageJsonPath) ?? '';
        if (text.includes('"engines"') && text.includes('"vscode"')) { natures.push({ name: 'vscode_extension' }); }
    }
    const hasTsconfig = isFile(path.join(dir, 'tsconfig.json'));
    if (hasTsconfig) {
        const json = hasPackageJson ? readJson(packageJsonPath) : {};
        natures.push({ name: 'typescript', project: { language: 'typescript', name: str(json.name), version: str(json.version), rank: RANK.typescript } });
    }
    // LanguageDetector
    if (hasPackageJson && !hasTsconfig) {
        const json = readJson(packageJsonPath);
        natures.push({ name: 'javascript', project: { language: 'javascript', name: str(json.name), version: str(json.version), rank: RANK.javascript } });
    }
    for (const file of ['pyproject.toml', 'setup.py', 'setup.cfg']) {
        if (!isFile(path.join(dir, file))) { continue; }
        const id = file === 'pyproject.toml' ? pyprojectIdentity(readText(path.join(dir, file)) ?? '') : {};
        natures.push({ name: 'python', project: { language: 'python', ...id, rank: RANK.python } });
        break;
    }
    const pomPath = path.join(dir, 'pom.xml');
    if (isFile(pomPath)) {
        const pom = readText(pomPath) ?? '';
        natures.push({ name: 'java', project: { language: 'java', name: pomElement(pom, 'artifactId'), version: pomElement(pom, 'version'), rank: RANK.java } });
    } else if (['build.gradle.kts', 'build.gradle'].some((f) => isFile(path.join(dir, f)))) {
        natures.push({ name: 'java', project: { language: 'java', rank: RANK.java } });
    }
    const goMod = path.join(dir, 'go.mod');
    if (isFile(goMod)) {
        const modulePath = /^module\s+(\S+)/m.exec(readText(goMod) ?? '')?.[1];
        natures.push({ name: 'go', project: { language: 'go', name: modulePath?.split('/').pop(), rank: RANK.go } });
    }
    const cargo = path.join(dir, 'Cargo.toml');
    if (isFile(cargo)) {
        const v = tomlTableStrings(readText(cargo) ?? '', 'package');
        natures.push({ name: 'rust', project: { language: 'rust', name: v.name, version: v.version, rank: RANK.rust } });
    }
    const hasNativeBuild = NATIVE_BUILD_FILES.some((f) => isFile(path.join(dir, f)));
    if (hasNativeBuild) {
        const langs = nativeSourceLanguages(dir);
        if (langs.has('cpp')) { natures.push({ name: 'cpp', project: { language: 'cpp', rank: RANK.cpp } }); }
        else if (langs.has('c')) { natures.push({ name: 'c', project: { language: 'c', rank: RANK.c } }); }
    }
    if (isFile(path.join(dir, 'buildkit.yaml'))) {
        const cfg = readYamlMap(path.join(dir, 'buildkit.yaml')) ?? {};
        natures.push({ name: 'buildkit', buildkit: { projectId: nonEmpty(cfg.project_id), projectName: nonEmpty(cfg.name), description: nonEmpty(cfg.description) } });
    }
    if (isFile(path.join(dir, 'build.yaml'))) { natures.push({ name: 'build_runner' }); }
    if (isFile(path.join(dir, 'buildkit_master.yaml'))) { natures.push({ name: 'workspace_root' }); }
    return natures;
}

/** `ListedProject.fromContext`: the entry of folder `dir`, or undefined when it has no project nature. */
export function listedProject(dir: string, root: string, natures: readonly Nature[]): WorkspaceProject | undefined {
    let primary: Nature | undefined;
    for (const n of natures) {
        if (n.project && (!primary || n.project.rank < primary.project!.rank)) { primary = n; }
    }
    if (!primary?.project) { return undefined; }
    const buildkit = natures.find((n) => n.buildkit)?.buildkit;
    const name = buildkit?.projectName ?? nonEmpty(primary.project.name) ?? path.basename(dir);
    const rel = path.relative(root, dir).split(path.sep).join('/');
    const version = nonEmpty(primary.project.version);
    return {
        id: buildkit?.projectId ?? name,
        name,
        path: rel === '' ? '.' : rel,
        absolutePath: path.normalize(path.resolve(dir)),
        language: primary.project.language,
        type: primary.name,
        natures: natures.map((n) => n.name),
        ...(version !== undefined ? { version } : {}),
        ...(buildkit?.description !== undefined ? { description: buildkit.description } : {}),
    };
}

// ----- Dart's List.sort (dart:_internal Sort) -------------------------------

/**
 * Dart's `List.sort`: insertion sort up to 32 elements, else a dual-pivot
 * quicksort — not stable. Ported as it is, so equal keys (two packages of one
 * name, the non-Dart projects of the build order) land where buildkit puts
 * them; JavaScript's stable sort keeps them in input order instead.
 */
export function dartSort<E>(a: E[], compare: (x: E, y: E) => number): void {
    doSort(a, 0, a.length - 1, compare);
}

function doSort<E>(a: E[], left: number, right: number, compare: (x: E, y: E) => number): void {
    if (right - left <= 32) { insertionSort(a, left, right, compare); } else { dualPivotQuicksort(a, left, right, compare); }
}

function insertionSort<E>(a: E[], left: number, right: number, compare: (x: E, y: E) => number): void {
    for (let i = left + 1; i <= right; i++) {
        const el = a[i];
        let j = i;
        while (j > left && compare(a[j - 1], el) > 0) { a[j] = a[j - 1]; j--; }
        a[j] = el;
    }
}

function dualPivotQuicksort<E>(a: E[], left: number, right: number, compare: (x: E, y: E) => number): void {
    const sixth = Math.trunc((right - left + 1) / 6);
    const index1 = left + sixth;
    const index5 = right - sixth;
    const index3 = Math.trunc((left + right) / 2);
    const index2 = index3 - sixth;
    const index4 = index3 + sixth;
    let el1 = a[index1]; let el2 = a[index2]; let el3 = a[index3]; let el4 = a[index4]; let el5 = a[index5];
    let t: E;
    if (compare(el1, el2) > 0) { t = el1; el1 = el2; el2 = t; }
    if (compare(el4, el5) > 0) { t = el4; el4 = el5; el5 = t; }
    if (compare(el1, el3) > 0) { t = el1; el1 = el3; el3 = t; }
    if (compare(el2, el3) > 0) { t = el2; el2 = el3; el3 = t; }
    if (compare(el1, el4) > 0) { t = el1; el1 = el4; el4 = t; }
    if (compare(el3, el4) > 0) { t = el3; el3 = el4; el4 = t; }
    if (compare(el2, el5) > 0) { t = el2; el2 = el5; el5 = t; }
    if (compare(el2, el3) > 0) { t = el2; el2 = el3; el3 = t; }
    if (compare(el4, el5) > 0) { t = el4; el4 = el5; el5 = t; }
    const pivot1 = el2;
    const pivot2 = el4;
    a[index1] = el1; a[index3] = el3; a[index5] = el5;
    a[index2] = a[left]; a[index4] = a[right];
    let less = left + 1;
    let great = right - 1;
    const pivotsAreEqual = compare(pivot1, pivot2) === 0;
    if (pivotsAreEqual) {
        const pivot = pivot1;
        for (let k = less; k <= great; k++) {
            const ak = a[k];
            let comp = compare(ak, pivot);
            if (comp === 0) { continue; }
            if (comp < 0) {
                if (k !== less) { a[k] = a[less]; a[less] = ak; }
                less++;
            } else {
                for (;;) {
                    comp = compare(a[great], pivot);
                    if (comp > 0) { great--; continue; }
                    else if (comp < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; break; }
                    else { a[k] = a[great]; a[great--] = ak; break; }
                }
            }
        }
    } else {
        for (let k = less; k <= great; k++) {
            const ak = a[k];
            if (compare(ak, pivot1) < 0) {
                if (k !== less) { a[k] = a[less]; a[less] = ak; }
                less++;
            } else if (compare(ak, pivot2) > 0) {
                for (;;) {
                    let comp = compare(a[great], pivot2);
                    if (comp > 0) { great--; if (great < k) { break; } continue; }
                    comp = compare(a[great], pivot1);
                    if (comp < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; }
                    else { a[k] = a[great]; a[great--] = ak; }
                    break;
                }
            }
        }
    }
    a[left] = a[less - 1]; a[less - 1] = pivot1;
    a[right] = a[great + 1]; a[great + 1] = pivot2;
    doSort(a, left, less - 2, compare);
    doSort(a, great + 2, right, compare);
    if (pivotsAreEqual) { return; }
    if (less < index1 && great > index5) {
        while (compare(a[less], pivot1) === 0) { less++; }
        while (compare(a[great], pivot2) === 0) { great--; }
        for (let k = less; k <= great; k++) {
            const ak = a[k];
            if (compare(ak, pivot1) === 0) {
                if (k !== less) { a[k] = a[less]; a[less] = ak; }
                less++;
            } else if (compare(ak, pivot2) === 0) {
                for (;;) {
                    let comp = compare(a[great], pivot2);
                    if (comp === 0) { great--; if (great < k) { break; } continue; }
                    comp = compare(a[great], pivot1);
                    if (comp < 0) { a[k] = a[less]; a[less++] = a[great]; a[great--] = ak; }
                    else { a[k] = a[great]; a[great--] = ak; }
                    break;
                }
            }
        }
        doSort(a, less, great, compare);
    } else {
        doSort(a, less, great, compare);
    }
}

// ----- build order (build_order.dart) ---------------------------------------

/** `BuildOrderComputer.computeBuildOrderResult` without dev dependencies: the order, or undefined on a cycle. */
export function computeBuildOrder(projectPaths: readonly string[]): string[] | undefined {
    const nameOf = new Map<string, string>();
    const pathOf = new Map<string, string>();
    const pubspecs = new Map<string, Record<string, unknown> | undefined>();
    for (const p of projectPaths) {
        const pubspec = readYamlMap(path.join(p, 'pubspec.yaml'));
        pubspecs.set(p, pubspec);
        const name = pubspec?.name !== undefined && pubspec?.name !== null ? String(pubspec.name) : path.basename(p);
        nameOf.set(p, name);
        pathOf.set(name, p);
    }
    const deps = new Map<string, Set<string>>();
    for (const p of projectPaths) {
        const set = new Set<string>();
        const d = pubspecs.get(p)?.dependencies;
        if (d && typeof d === 'object') {
            for (const dep of Object.keys(d)) { if (pathOf.has(dep)) { set.add(pathOf.get(dep)!); } }
        }
        deps.set(p, set);
    }
    const inDegree = new Map<string, number>();
    for (const p of projectPaths) { inDegree.set(p, deps.get(p)!.size); }
    const byName = (a: string, b: string): number => { const x = nameOf.get(a)!; const y = nameOf.get(b)!; return x < y ? -1 : x > y ? 1 : 0; };
    const queue = projectPaths.filter((p) => inDegree.get(p) === 0);
    dartSort(queue, byName);
    const order: string[] = [];
    while (queue.length) {
        const current = queue.shift()!;
        order.push(current);
        for (const [p, set] of deps) {
            if (!set.has(current)) { continue; }
            inDegree.set(p, inDegree.get(p)! - 1);
            if (inDegree.get(p) === 0) { queue.push(p); dartSort(queue, byName); }
        }
    }
    return order.length === projectPaths.length ? order : undefined;
}

/** The projects of the workspace at `root`, as `buildkit :projects --all --json` lists them. */
export function listProjectsJs(root: string): { projects: WorkspaceProject[]; cycle: boolean } {
    const absRoot = path.normalize(path.resolve(root));
    const scanned = scanFolders(absRoot);
    // The build order is computed from every scanned folder with a pubspec (before the test-project filter),
    // like BuildBase.traverse.
    const order = computeBuildOrder(scanned.filter((dir) => isFile(path.join(dir, 'pubspec.yaml'))));
    // Every folder the filter keeps is sorted, project or not (BuildBase.traverse sorts its contexts, then
    // skips those without a project nature): with Dart's unstable sort they decide where equal keys land.
    const contexts = scanned
        .filter((dir) => !path.basename(dir).startsWith('zom_'))
        .map((dir) => ({ dir, project: listedProject(dir, absRoot, detectNatures(dir)) }));
    if (order && order.length) {
        const pos = new Map(order.map((p, i) => [p, i]));
        dartSort(contexts, (a, b) => {
            const pa = pos.get(a.dir);
            const pb = pos.get(b.dir);
            if (pa !== undefined && pb !== undefined) { return pa - pb; }
            if (pa !== undefined) { return -1; }
            if (pb !== undefined) { return 1; }
            return 0;
        });
    }
    return { projects: contexts.flatMap((c) => (c.project ? [c.project] : [])), cycle: order === undefined };
}
