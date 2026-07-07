/**
 * Resolve the workspace-level documentation directory for the "Workspace" group
 * of the documentation pickers (@WS Documentation panel + Markdown Browser).
 *
 * Workspace docs live in `doc/` (project convention) or `_doc/` (workspace-level
 * convention — see CLAUDE.md → "Workspace-level documentation goes in `_doc/`").
 * The precedence prefers whichever directory actually CONTAINS markdown so a
 * `doc/` folder that exists only to hold non-markdown artifacts (e.g. `testlog_*`
 * subfolders) does not shadow the real `_doc/` docs and leave the group empty.
 *
 * The directory checks are injected via {@link DirProbe} so this stays a pure,
 * unit-testable function — callers back it with `fs` (and can define
 * "hasMarkdown" to match their own listing semantics: top-level for the @WS
 * panel, recursive for the Markdown Browser).
 */
import * as path from 'path';

export interface DirProbe {
    /** True if the directory exists. */
    exists(dir: string): boolean;
    /** True if the directory contains at least one markdown file. */
    hasMarkdown(dir: string): boolean;
}

/**
 * @returns the resolved workspace docs directory, or `null` when neither
 * `doc/` nor `_doc/` exists under `wsRoot`.
 */
export function resolveWorkspaceDocsDir(wsRoot: string, probe: DirProbe): string | null {
    const docDir = path.join(wsRoot, 'doc');
    const altDir = path.join(wsRoot, '_doc');
    if (probe.hasMarkdown(docDir)) { return docDir; }
    if (probe.hasMarkdown(altDir)) { return altDir; }
    if (probe.exists(docDir)) { return docDir; }
    if (probe.exists(altDir)) { return altDir; }
    return null;
}
