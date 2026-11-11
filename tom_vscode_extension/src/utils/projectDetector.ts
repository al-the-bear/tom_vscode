import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../handlers/handler_shared';
import { TtlPromiseCache } from './ttlPromiseCache';
import { WsPaths } from './workspacePaths';

export interface DetectorContainsRule {
    file: string;
    contains?: string;
    containsNot?: string;
    flags?: string;
}

export interface ProjectDetectionRule {
    hasFile?: string[];
    hasFolder?: string[];
    contains?: DetectorContainsRule[];
}

export interface ProjectDetector {
    name: string;
    detection: ProjectDetectionRule;
    attributes?: Record<string, string>;
}

export interface ProjectDetectorConfig {
    projectAnalysis?: {
        projectDetectors?: ProjectDetector[];
    };
}

export interface ProjectDetectionResult {
    projectRoot: string;
    detectorNames: string[];
    attributes: Record<string, string[]>;
}

function splitAttributeValues(value: string | undefined): string[] {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function mergeAttributes(target: Record<string, Set<string>>, attrs?: Record<string, string>): void {
    if (!attrs) {
        return;
    }
    for (const [key, csv] of Object.entries(attrs)) {
        if (!target[key]) {
            target[key] = new Set<string>();
        }
        for (const value of splitAttributeValues(csv)) {
            target[key].add(value);
        }
    }
}

function toArrayMap(values: Record<string, Set<string>>): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [key, set] of Object.entries(values)) {
        out[key] = [...set].sort();
    }
    return out;
}

function getRegex(pattern: string, flags?: string): RegExp {
    try {
        return new RegExp(pattern, flags || 'm');
    } catch {
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || 'm');
    }
}

/** What a directory listing says about one entry. */
type EntryKind = 'file' | 'dir' | 'link';

/**
 * A directory's entries by name, from the `readdirSync` / `readdir` the walk
 * does anyway. Detector rules naming a direct child (`pubspec.yaml`, `lib`)
 * are answered from it instead of an `existsSync` + `statSync` per rule per
 * directory — on this workspace that was 140,000 stat calls per scan.
 */
export type DirListing = ReadonlyMap<string, EntryKind>;

export function listingOf(entries: readonly fs.Dirent[]): DirListing {
    const listing = new Map<string, EntryKind>();
    for (const entry of entries) {
        if (entry.isDirectory()) {
            listing.set(entry.name, 'dir');
        } else if (entry.isFile()) {
            listing.set(entry.name, 'file');
        } else if (entry.isSymbolicLink()) {
            listing.set(entry.name, 'link');
        }
    }
    return listing;
}

function statKind(fullPath: string): 'file' | 'dir' | undefined {
    try {
        const stat = fs.statSync(fullPath);
        return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : undefined;
    } catch {
        return undefined;
    }
}

/** Is `relPath` under `projectRoot` a file or a folder (symlinks followed)? */
function kindAt(projectRoot: string, relPath: string, listing?: DirListing): 'file' | 'dir' | undefined {
    const direct = listing && !/[\\/]/.test(relPath) ? relPath : undefined;
    if (direct !== undefined && listing) {
        const kind = listing.get(direct);
        if (kind === undefined) {
            return undefined;
        }
        if (kind !== 'link') {
            return kind;
        }
    }
    return statKind(path.join(projectRoot, relPath));
}

function evaluateContainsRule(
    projectRoot: string,
    rule: DetectorContainsRule,
    listing: DirListing | undefined,
    contents: Map<string, string>,
): boolean {
    if (kindAt(projectRoot, rule.file, listing) !== 'file') {
        return false;
    }
    let content = contents.get(rule.file);
    if (content === undefined) {
        try {
            content = fs.readFileSync(path.join(projectRoot, rule.file), 'utf-8');
        } catch {
            return false;
        }
        contents.set(rule.file, content);
    }

    if (rule.contains) {
        const regex = getRegex(rule.contains, rule.flags);
        if (!regex.test(content)) {
            return false;
        }
    }
    if (rule.containsNot) {
        const regex = getRegex(rule.containsNot, rule.flags);
        if (regex.test(content)) {
            return false;
        }
    }
    return true;
}

function matchesDetector(
    projectRoot: string,
    detector: ProjectDetector,
    listing: DirListing | undefined,
    contents: Map<string, string>,
): boolean {
    const rule = detector.detection || {};

    for (const relPath of rule.hasFile ?? []) {
        if (kindAt(projectRoot, relPath, listing) !== 'file') {
            return false;
        }
    }
    for (const relPath of rule.hasFolder ?? []) {
        if (kindAt(projectRoot, relPath, listing) !== 'dir') {
            return false;
        }
    }
    for (const containsRule of rule.contains ?? []) {
        if (!evaluateContainsRule(projectRoot, containsRule, listing, contents)) {
            return false;
        }
    }
    return true;
}

function defaultConfigPath(): string {
    // At runtime __dirname is out/utils/; look for config/ as a sibling of the parent (out/config/)
    // Also try the src/ location for development when running without packaging
    const outBased = path.resolve(__dirname, '..', 'config', 'project_types.json');
    if (fs.existsSync(outBased)) {
        return outBased;
    }
    return path.resolve(__dirname, '../..', 'src', 'config', 'project_types.json');
}

function overrideConfigPath(): string | undefined {
    return WsPaths.wsConfig('project_detection.json') || undefined;
}

function readConfigFile(filePath: string): ProjectDetectorConfig | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as ProjectDetectorConfig;
    } catch {
        return undefined;
    }
}

export function loadProjectDetectorConfig(): ProjectDetectorConfig {
    const defaultConfig = readConfigFile(defaultConfigPath()) || { projectAnalysis: { projectDetectors: [] } };
    const overridePath = overrideConfigPath();
    if (!overridePath) {
        return defaultConfig;
    }

    const override = readConfigFile(overridePath);
    if (!override?.projectAnalysis?.projectDetectors?.length) {
        return defaultConfig;
    }

    const merged: ProjectDetector[] = [];
    const byName = new Map<string, ProjectDetector>();

    const defaults = defaultConfig.projectAnalysis?.projectDetectors || [];
    for (const det of defaults) {
        byName.set(det.name, det);
        merged.push(det);
    }

    for (const det of override.projectAnalysis.projectDetectors) {
        if (!det?.name) {
            continue;
        }
        const index = merged.findIndex((item) => item.name === det.name);
        if (index >= 0) {
            merged[index] = det;
        } else {
            merged.push(det);
        }
        byName.set(det.name, det);
    }

    return {
        projectAnalysis: {
            projectDetectors: merged,
        },
    };
}

/** The configured detectors (built-in, merged with the workspace's override). */
export function loadProjectDetectors(): ProjectDetector[] {
    return loadProjectDetectorConfig().projectAnalysis?.projectDetectors || [];
}

/**
 * The detectors matching `projectRoot`. A walk passes the detectors it loaded
 * once and the directory's listing; a single call loads them itself.
 */
export function detectProjectAttributes(
    projectRoot: string,
    detectors: readonly ProjectDetector[] = loadProjectDetectors(),
    listing?: DirListing,
): ProjectDetectionResult {
    const matchedDetectors: string[] = [];
    const attrMap: Record<string, Set<string>> = {};
    const contents = new Map<string, string>();

    for (const detector of detectors) {
        if (!detector?.name || !detector?.detection) {
            continue;
        }
        if (!matchesDetector(projectRoot, detector, listing, contents)) {
            continue;
        }
        matchedDetectors.push(detector.name);
        mergeAttributes(attrMap, detector.attributes);
    }

    return {
        projectRoot,
        detectorNames: matchedDetectors,
        attributes: toArrayMap(attrMap),
    };
}

export function hasDetectedProjectType(projectRoot: string): boolean {
    const result = detectProjectAttributes(projectRoot);
    return (result.attributes.types || []).length > 0;
}

/**
 * Folders the project walk never enters: hidden ones, test fixtures, and
 * build output and scratch (`ztmp`, Rust / Maven `target`), which hold no
 * projects of their own but most of a workspace's directories — on this
 * workspace `ztmp/` and two `target/` trees were 8,000 of 11,700.
 */
export function isIgnoredWorkspaceFolder(name: string): boolean {
    return (
        name.startsWith('.') ||
        name.startsWith('zom_') ||
        name === 'node_modules' ||
        name === 'build' ||
        name === 'dist' ||
        name === 'out' ||
        name === 'target' ||
        name === 'ztmp'
    );
}

export interface DetectedWorkspaceProject {
    name: string;
    relativePath: string;
    absolutePath: string;
    attributes: Record<string, string[]>;
    detectorNames: string[];
}

export interface DetectorScanOptions {
    maxDepth?: number;
    traverseWholeWorkspace?: boolean;
    excludeGlobs?: string[];
}

function getConfiguredExcludeGlobs(): string[] {
    const configTomAi = vscode.workspace.getConfiguration('tomAi');
    const configured = configTomAi.get<string[]>('projectDetection.excludeGlobs')
        || ['tom/zom_*/**'];
    if (!Array.isArray(configured) || configured.length === 0) {
        return ['tom/zom_*/**'];
    }
    return configured
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0);
}

function globToRegExp(glob: string): RegExp {
    const normalized = glob.replace(/\\/g, '/');
    const escaped = normalized
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '::DOUBLE_STAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLE_STAR::/g, '.*');
    return new RegExp(`^${escaped}$`);
}

/** Whether a workspace-relative path matches one of `globs` (`*` within a segment, `**` across). */
export function matchesExcludeGlob(relativePath: string, globs: readonly string[]): boolean {
    return isExcludedRelativePath(relativePath, globs.map(globToRegExp));
}

function isExcludedRelativePath(relativePath: string, regexes: readonly RegExp[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return regexes.some((regex) => regex.test(normalized) || regex.test(`${normalized}/`));
}

/** Everything a walk needs, resolved once per scan. */
interface ScanPlan {
    roots: Array<{ name: string; root: string }>;
    maxDepth: number;
    excludes: RegExp[];
    detectors: ProjectDetector[];
}

function scanPlan(maxDepthOrOptions: number | DetectorScanOptions): ScanPlan | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    const roots: Array<{ name: string; root: string }> = [];
    const seenRoots = new Set<string>();
    for (const folder of workspaceFolders) {
        const rootPath = folder.uri.fsPath;
        const key = path.resolve(rootPath);
        if (seenRoots.has(key)) {
            continue;
        }
        seenRoots.add(key);
        roots.push({ name: path.basename(rootPath) || folder.name, root: rootPath });
    }

    const options: DetectorScanOptions = typeof maxDepthOrOptions === 'number'
        ? { maxDepth: maxDepthOrOptions }
        : (maxDepthOrOptions || {});
    const maxDepth = options.traverseWholeWorkspace
        ? Number.POSITIVE_INFINITY
        : (options.maxDepth ?? 5);
    const excludeGlobs = options.excludeGlobs && options.excludeGlobs.length > 0
        ? options.excludeGlobs
        : getConfiguredExcludeGlobs();
    return { roots, maxDepth, excludes: excludeGlobs.map(globToRegExp), detectors: loadProjectDetectors() };
}

/**
 * One directory of a walk, given its entries (undefined when it could not be
 * read): the project it is, if any, and the child directories to walk next.
 * A detected project is not descended into, except a workspace root.
 */
function visitDirectory(
    plan: ScanPlan,
    rootInfo: { name: string; root: string },
    dir: string,
    entries: readonly fs.Dirent[] | undefined,
): { project?: DetectedWorkspaceProject; children: string[] } {
    const detection = detectProjectAttributes(dir, plan.detectors, entries ? listingOf(entries) : undefined);
    let project: DetectedWorkspaceProject | undefined;
    if ((detection.attributes.types || []).length > 0) {
        const relWithinRoot = path.relative(rootInfo.root, dir) || '.';
        project = {
            name: path.basename(dir),
            relativePath: plan.roots.length > 1 ? `${rootInfo.name}/${relWithinRoot}` : relWithinRoot,
            absolutePath: dir,
            attributes: detection.attributes,
            detectorNames: detection.detectorNames,
        };
        if (dir !== rootInfo.root) {
            return { project, children: [] };
        }
    }

    const children: string[] = [];
    for (const entry of entries ?? []) {
        if (!entry.isDirectory() || isIgnoredWorkspaceFolder(entry.name)) {
            continue;
        }
        const childDir = path.join(dir, entry.name);
        const relWithinRoot = path.relative(rootInfo.root, childDir) || '.';
        const relForMatching = plan.roots.length > 1 ? `${rootInfo.name}/${relWithinRoot}` : relWithinRoot;
        if (
            relWithinRoot !== '.' &&
            (isExcludedRelativePath(relWithinRoot, plan.excludes) || isExcludedRelativePath(relForMatching, plan.excludes))
        ) {
            continue;
        }
        children.push(childDir);
    }
    return { project, children };
}

function sortedProjects(found: Map<string, DetectedWorkspaceProject>): DetectedWorkspaceProject[] {
    return [...found.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * The projects of the workspace folders, found by the detectors.
 *
 * Synchronous: it holds the extension host for the whole walk (seconds on a
 * large workspace). Code on a panel's start-up path uses
 * `scanWorkspaceProjectsCached`, which walks asynchronously and once for
 * every caller.
 */
export function scanWorkspaceProjectsByDetectors(maxDepthOrOptions: number | DetectorScanOptions = 5): DetectedWorkspaceProject[] {
    const plan = scanPlan(maxDepthOrOptions);
    if (!plan) {
        return [];
    }
    const found = new Map<string, DetectedWorkspaceProject>();
    const walk = (rootInfo: { name: string; root: string }, dir: string, depth: number): void => {
        if (depth > plan.maxDepth) {
            return;
        }
        let entries: fs.Dirent[] | undefined;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            entries = undefined;
        }
        const { project, children } = visitDirectory(plan, rootInfo, dir, entries);
        if (project) {
            found.set(path.resolve(dir), project);
        }
        for (const child of children) {
            walk(rootInfo, child, depth + 1);
        }
    };
    for (const rootInfo of plan.roots) {
        walk(rootInfo, rootInfo.root, 0);
    }
    return sortedProjects(found);
}

/**
 * The same walk as `scanWorkspaceProjectsByDetectors`, reading every
 * directory asynchronously, so the extension host serves other panels and
 * extensions between directories. Same result, same order.
 */
export async function scanWorkspaceProjectsByDetectorsAsync(
    maxDepthOrOptions: number | DetectorScanOptions = 5,
): Promise<DetectedWorkspaceProject[]> {
    const plan = scanPlan(maxDepthOrOptions);
    if (!plan) {
        return [];
    }
    const found = new Map<string, DetectedWorkspaceProject>();
    const walk = async (rootInfo: { name: string; root: string }, dir: string, depth: number): Promise<void> => {
        if (depth > plan.maxDepth) {
            return;
        }
        let entries: fs.Dirent[] | undefined;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            entries = undefined;
        }
        const { project, children } = visitDirectory(plan, rootInfo, dir, entries);
        if (project) {
            found.set(path.resolve(dir), project);
        }
        for (const child of children) {
            await walk(rootInfo, child, depth + 1);
        }
    };
    for (const rootInfo of plan.roots) {
        await walk(rootInfo, rootInfo.root, 0);
    }
    return sortedProjects(found);
}

/** How long a finished scan is reused before the next caller walks again. */
export const PROJECT_SCAN_TTL_MS = 60_000;

const scanCache = new TtlPromiseCache<DetectedWorkspaceProject[]>(PROJECT_SCAN_TTL_MS);

/**
 * The asynchronous scan, shared: callers asking with the same options while a
 * walk runs, or within `PROJECT_SCAN_TTL_MS` after it finished, get its
 * result instead of walking again. @WS's Guidelines and Documentation groups
 * and the prompt scopes ask at start. `fresh` walks again.
 */
export function scanWorkspaceProjectsCached(
    options: DetectorScanOptions = {},
    fresh = false,
): Promise<DetectedWorkspaceProject[]> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return scanCache.get(
        JSON.stringify({ roots, options }),
        () => scanWorkspaceProjectsByDetectorsAsync(options),
        fresh,
    );
}

/** Forget every cached scan (tests; a change of workspace folders). */
export function clearProjectScanCache(): void {
    scanCache.clear();
}

export function findNearestDetectedProject(startDir: string): DetectedWorkspaceProject | undefined {
    const wsRoot = getWorkspaceRoot();
    let current = startDir;

    while (current) {
        const detection = detectProjectAttributes(current);
        if ((detection.attributes.types || []).length > 0) {
            const rel = wsRoot ? (path.relative(wsRoot, current) || '.') : current;
            return {
                name: path.basename(current),
                relativePath: rel,
                absolutePath: current,
                attributes: detection.attributes,
                detectorNames: detection.detectorNames,
            };
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        if (wsRoot && current.length < wsRoot.length) {
            break;
        }
        current = parent;
    }

    return undefined;
}
