import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../handlers/handler_shared';
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

function evaluateContainsRule(projectRoot: string, rule: DetectorContainsRule): boolean {
    const filePath = path.join(projectRoot, rule.file);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return false;
    }
    const content = fs.readFileSync(filePath, 'utf-8');

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

function matchesDetector(projectRoot: string, detector: ProjectDetector): boolean {
    const rule = detector.detection || {};

    if (rule.hasFile) {
        for (const relPath of rule.hasFile) {
            const filePath = path.join(projectRoot, relPath);
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                return false;
            }
        }
    }

    if (rule.hasFolder) {
        for (const relPath of rule.hasFolder) {
            const folderPath = path.join(projectRoot, relPath);
            if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
                return false;
            }
        }
    }

    if (rule.contains) {
        for (const containsRule of rule.contains) {
            if (!evaluateContainsRule(projectRoot, containsRule)) {
                return false;
            }
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

export function detectProjectAttributes(projectRoot: string): ProjectDetectionResult {
    const config = loadProjectDetectorConfig();
    const detectors = config.projectAnalysis?.projectDetectors || [];

    const matchedDetectors: string[] = [];
    const attrMap: Record<string, Set<string>> = {};

    for (const detector of detectors) {
        if (!detector?.name || !detector?.detection) {
            continue;
        }
        if (!matchesDetector(projectRoot, detector)) {
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

function isIgnoredFolder(name: string): boolean {
    return (
        name.startsWith('.') ||
        name.startsWith('zom_') ||
        name === 'node_modules' ||
        name === 'build' ||
        name === '.dart_tool' ||
        name === 'dist' ||
        name === 'out'
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
    const configLegacy = vscode.workspace.getConfiguration('tomAi');
    const configured = configTomAi.get<string[]>('projectDetection.excludeGlobs')
        || configLegacy.get<string[]>('projectDetection.excludeGlobs')
        || configTomAi.get<string[]>('guidelines.projectExcludeGlobs')
        || configLegacy.get<string[]>('guidelines.projectExcludeGlobs')
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

function isExcludedRelativePath(relativePath: string, globs: string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return globs.some((glob) => {
        const regex = globToRegExp(glob);
        return regex.test(normalized) || regex.test(`${normalized}/`);
    });
}

export function scanWorkspaceProjectsByDetectors(maxDepthOrOptions: number | DetectorScanOptions = 5): DetectedWorkspaceProject[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return [];
    }
    const discoveredRoots: Array<{ name: string; root: string }> = [];
    const seenRoots = new Set<string>();

    for (const folder of workspaceFolders) {
        const folderRoot = folder.uri.fsPath;
        const rootPath = folderRoot;
        const rootName = path.basename(rootPath) || folder.name;
        const key = path.resolve(rootPath);
        if (seenRoots.has(key)) {
            continue;
        }
        seenRoots.add(key);
        discoveredRoots.push({ name: rootName, root: rootPath });
    }

    const workspaceRoots = discoveredRoots;

    const options: DetectorScanOptions = typeof maxDepthOrOptions === 'number'
        ? { maxDepth: maxDepthOrOptions }
        : (maxDepthOrOptions || {});
    const maxDepth = options.traverseWholeWorkspace
        ? Number.POSITIVE_INFINITY
        : (options.maxDepth ?? 5);
    const excludeGlobs = options.excludeGlobs && options.excludeGlobs.length > 0
        ? options.excludeGlobs
        : getConfiguredExcludeGlobs();

    const found = new Map<string, DetectedWorkspaceProject>();

    function walk(rootInfo: { name: string; root: string }, dir: string, depth: number): void {
        if (depth > maxDepth) {
            return;
        }

        const detection = detectProjectAttributes(dir);
        const isDetectedProject = (detection.attributes.types || []).length > 0;
        if (isDetectedProject) {
            const relWithinRoot = path.relative(rootInfo.root, dir) || '.';
            const rel = workspaceRoots.length > 1
                ? `${rootInfo.name}/${relWithinRoot}`
                : relWithinRoot;
            found.set(path.resolve(dir), {
                name: path.basename(dir),
                relativePath: rel,
                absolutePath: dir,
                attributes: detection.attributes,
                detectorNames: detection.detectorNames,
            });
            // Don't recurse into detected projects (except if this is the workspace root itself)
            if (dir !== rootInfo.root) {
                return;
            }
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (isIgnoredFolder(entry.name)) {
                continue;
            }
            const childDir = path.join(dir, entry.name);
            const relWithinRoot = path.relative(rootInfo.root, childDir) || '.';
            const relForMatching = workspaceRoots.length > 1
                ? `${rootInfo.name}/${relWithinRoot}`
                : relWithinRoot;
            if (
                relWithinRoot !== '.' &&
                (isExcludedRelativePath(relWithinRoot, excludeGlobs) || isExcludedRelativePath(relForMatching, excludeGlobs))
            ) {
                continue;
            }
            walk(rootInfo, childDir, depth + 1);
        }
    }

    for (const rootInfo of workspaceRoots) {
        walk(rootInfo, rootInfo.root, 0);
    }

    return [...found.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
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
