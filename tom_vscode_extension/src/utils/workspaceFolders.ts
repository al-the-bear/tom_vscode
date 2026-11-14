/**
 * Folder rules of the workspace walks that remain after the project
 * discovery moved onto buildkit's listing (services/workspaceProjects.ts,
 * vscimpb84): which folders a walk never enters (the `prompt/` folder walk of
 * promptScopes.ts), and the exclude globs (`tomAi.guidelines.excludeGlobs`).
 *
 * vscode-free.
 */

/**
 * Folders a walk never enters: hidden ones, test fixtures, and build output
 * and scratch (`ztmp`, Rust / Maven `target`), which hold no projects of their
 * own but most of a workspace's directories — on this workspace `ztmp/` and two
 * `target/` trees were 8,000 of 11,700.
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

/** A glob as a regular expression over `/`-separated paths: `*` within a segment, `**` across. */
export function globToRegExp(glob: string): RegExp {
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
    const normalized = relativePath.replace(/\\/g, '/');
    return globs.map(globToRegExp).some((regex) => regex.test(normalized) || regex.test(`${normalized}/`));
}
