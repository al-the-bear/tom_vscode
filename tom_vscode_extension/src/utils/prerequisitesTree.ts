/**
 * The SECRETS view's model (src/handlers/prerequisitesView-handler.ts): the
 * workspace's `prerequisites.yaml` files grouped repository → project →
 * section → secret / tool → option, each level with its roll-up, from the
 * parsed files and the cached check results. vscode-free and without IO.
 */

import * as path from 'path';

import {
    combineRollUps, optionKey, rollUp, secretStatus, toolKey,
    type CheckResult, type CheckStatus, type ParseResult, type PrerequisitesProblem, type ProvideOption, type RollUp,
} from './prerequisites';

/** A project of the listing, with the repository it is in. */
export interface DiscoveredProject {
    name: string;
    /** Absolute folder. */
    dir: string;
    /** The repository root holding it (nearest folder with `.git`), or the workspace root. */
    repoDir: string;
}

/** A `prerequisites.yaml` found: of a project, or of a repository root that is no project itself. */
export interface DiscoveredFile {
    /** Absolute path of the file. */
    file: string;
    kind: 'project' | 'repository';
    name: string;
    dir: string;
    repoDir: string;
    parsed: ParseResult;
}

export interface ViewOption {
    key: string;
    via: string;
    /** E.g. `env ANTHROPIC_API_KEY`. */
    label: string;
    description?: string;
    /** The option's own fields (names, paths, services — never a value). */
    fields: Record<string, string>;
    result?: CheckResult;
}

export interface ViewItem {
    /** The node id under its file: `<section>/<secret>` or `<section>/tool:<tool>`. */
    nodeId: string;
    kind: 'secret' | 'tool';
    id: string;
    title: string;
    required: boolean;
    /** Secret type (with its note), or `tool`. */
    type: string;
    description?: string;
    obtain?: string;
    status: CheckStatus;
    /** A secret's ways to provide it. */
    options: ViewOption[];
    /** A tool's command and its result. */
    command?: string;
    check?: string;
    result?: CheckResult;
}

export interface ViewSection {
    nodeId: string;
    id: string;
    title: string;
    description?: string;
    items: ViewItem[];
    rollup: RollUp;
}

export interface ViewFile {
    /** The file's absolute path: its node id. */
    file: string;
    kind: 'project' | 'repository';
    name: string;
    /** Relative to the workspace root. */
    relDir: string;
    error?: string;
    problems: PrerequisitesProblem[];
    sections: ViewSection[];
    rollup: RollUp;
}

export interface ViewRepository {
    dir: string;
    name: string;
    relDir: string;
    files: ViewFile[];
    rollup: RollUp;
}

export interface ViewProjectWithoutFile {
    name: string;
    dir: string;
    relDir: string;
    repoName: string;
}

export interface PrerequisitesTree {
    repositories: ViewRepository[];
    withoutFile: ViewProjectWithoutFile[];
    rollup: RollUp;
    /** Items to check (secrets' options + tools). */
    checkCount: number;
}

const EMPTY: RollUp = { status: 'set', set: 0, missing: 0, unknown: 0, total: 0 };

/** The label of an option: its via and what it names. */
export function optionLabel(o: ProvideOption): string {
    const what = o.via === 'env' ? o.name
        : o.via === 'dotenv' ? `${o.file} ${o.name}`
            : o.via === 'file' ? o.path
                : o.via === 'keychain' ? [o.service, o.account].filter(Boolean).join(' / ')
                    : o.via === 'vscode_secret' ? o.key
                        : o.via === 'kdbx' ? `${o.database} › ${o.entry}`
                            : o.via === 'cli_login' ? o.tool
                                : o.via === 'ssh_agent' ? (o.fingerprint ?? 'a key loaded')
                                    : o.via === 'cloud_secret_manager' ? `${o.provider} ${o.name}`
                                        : o.viaNote;
    return `${o.via}${what ? ` ${what}` : ''}`;
}

function optionFields(o: ProvideOption): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
        if (k !== 'via' && k !== 'description' && typeof v === 'string') { out[k] = v; }
    }
    return out;
}

/** Build the view's tree from the files found, the projects without a file and the cached results. */
export function buildPrerequisitesTree(
    files: readonly DiscoveredFile[],
    projectsWithout: readonly DiscoveredProject[],
    results: Readonly<Record<string, CheckResult>>,
    workspaceRoot: string,
): PrerequisitesTree {
    const rel = (dir: string): string => path.relative(workspaceRoot, dir).split(path.sep).join('/') || '.';
    let checkCount = 0;
    const byRepo = new Map<string, ViewFile[]>();
    for (const f of files) {
        const sections: ViewSection[] = [];
        if (f.parsed.ok) {
            for (const s of f.parsed.file.sections) {
                const items: ViewItem[] = [];
                for (const secret of s.secrets) {
                    const options = secret.options.map((o, i): ViewOption => {
                        checkCount++;
                        const key = optionKey(f.file, s.id, secret.id, i, o.via);
                        return { key, via: o.via, label: optionLabel(o), description: o.description, fields: optionFields(o), result: results[key] };
                    });
                    items.push({
                        nodeId: `${s.id}/${secret.id}`, kind: 'secret', id: secret.id, title: secret.title, required: secret.required,
                        type: secret.typeNote ? `${secret.type} (${secret.typeNote})` : secret.type,
                        description: secret.description, obtain: secret.obtain,
                        status: secretStatus(options.map((o) => o.result)), options,
                    });
                }
                for (const tool of s.tools) {
                    checkCount++;
                    const result = results[toolKey(f.file, s.id, tool.id)];
                    items.push({
                        nodeId: `${s.id}/tool:${tool.id}`, kind: 'tool', id: tool.id, title: tool.title, required: tool.required, type: 'tool',
                        description: tool.description, obtain: tool.obtain, command: tool.command, check: tool.check,
                        status: result?.status ?? 'unknown', options: [], result,
                    });
                }
                sections.push({ nodeId: s.id, id: s.id, title: s.title, description: s.description, items, rollup: rollUp(items) });
            }
        }
        const view: ViewFile = {
            file: f.file, kind: f.kind, name: f.name, relDir: rel(f.dir),
            ...(f.parsed.ok ? {} : { error: f.parsed.error }),
            problems: f.parsed.problems, sections,
            rollup: f.parsed.ok ? combineRollUps(sections.map((s) => s.rollup)) : { ...EMPTY, status: 'unknown' },
        };
        const list = byRepo.get(f.repoDir) ?? [];
        list.push(view);
        byRepo.set(f.repoDir, list);
    }
    const repositories: ViewRepository[] = [...byRepo.entries()].map(([dir, list]) => ({
        dir, name: path.basename(dir), relDir: rel(dir),
        // The repository's own file first, then its projects by path.
        files: list.sort((a, b) => (a.kind === b.kind ? a.relDir.localeCompare(b.relDir) : a.kind === 'repository' ? -1 : 1)),
        rollup: combineRollUps(list.map((v) => v.rollup)),
    })).sort((a, b) => a.relDir.localeCompare(b.relDir));
    const withoutFile = projectsWithout
        .map((p) => ({ name: p.name, dir: p.dir, relDir: rel(p.dir), repoName: path.basename(p.repoDir) }))
        .sort((a, b) => a.relDir.localeCompare(b.relDir));
    return { repositories, withoutFile, rollup: combineRollUps(repositories.map((r) => r.rollup)), checkCount };
}
