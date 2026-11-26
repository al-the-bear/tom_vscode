/**
 * The exclude globs of the workspace walks (`tomAi.guidelines.excludeGlobs`):
 * a glob as a regular expression, and whether a path matches one.
 *
 * vscode-free.
 */

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
