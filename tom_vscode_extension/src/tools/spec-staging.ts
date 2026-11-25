/**
 * Running a bundled `tomspecs` command on copies of specification files: the
 * helper the spec check tools (spec-checks-tools.ts) and the document-set
 * tools (spec-sync-tools.ts) share.
 *
 *   - **stage**: read a file through the document store (its editor buffer
 *     when open) and copy that text into a scratch folder, remembering the
 *     text and revision it had;
 *   - **run**: the command runs on the copies, never on the files themselves;
 *   - **write back**: what the command changed in a copy is written through
 *     the store's checks (a file dirty in an editor, a revision moved since it
 *     was staged, the caller's `expectedRevision`) — or only diffed on
 *     `dryRun`;
 *   - **scratch**: the copies live in a temporary folder of the workspace's
 *     `ztmp/` (a tool writes nowhere outside the workspace), removed whatever
 *     happens.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveInput, toWorkspacePath, type SpecToolDeps } from './spec-tool-common';

/** A temporary folder in the workspace's `ztmp/` for the copies, removed afterwards whatever happens. */
export async function withScratch<T>(deps: Pick<SpecToolDeps, 'wsRoot'>, work: (dir: string) => Promise<T>, prefix = 'tom-spec-checks-'): Promise<T> {
    const scratch = path.join(deps.wsRoot, 'ztmp');
    fs.mkdirSync(scratch, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratch, prefix));
    try { return await work(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One staged file: where it is, its copy, and what it was when read. */
export interface Staged {
    /** The file itself (absolute). */
    abs: string;
    /** Its copy in the scratch folder. */
    copy: string;
    /** The text it had when staged. */
    text: string;
    /** That text's revision (sha256): the write-back's `baseRevision`. */
    revision: string;
}

/**
 * Copy `file` (workspace-relative or absolute, inside the workspace) into
 * `dir` as `name` (default its file name; a sub-path keeps copies of the same
 * file name apart), as the store reads it.
 */
export function stage(deps: Pick<SpecToolDeps, 'wsRoot' | 'store'>, dir: string, file: string, name: string = path.basename(file)): Staged {
    const abs = resolveInput(deps as SpecToolDeps, file);
    const { text, revision } = deps.store.readText(abs);
    const copy = path.join(dir, name);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, text);
    return { abs, copy, text, revision };
}

/** Write what the command changed in the copies through the store; the answer's `files` entries. */
export async function writeBack(deps: Pick<SpecToolDeps, 'wsRoot' | 'store'>, files: Array<Staged & { expectedRevision?: string }>, dryRun: boolean): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const f of files) {
        const after = fs.readFileSync(f.copy, 'utf8');
        if (after === f.text) { out.push({ file: toWorkspacePath(deps as SpecToolDeps, f.abs), changed: false }); continue; }
        const saved = await deps.store.writeText(f.abs, after, { baseRevision: f.revision, expectedRevision: f.expectedRevision, dryRun });
        out.push({ file: toWorkspacePath(deps as SpecToolDeps, f.abs), changed: true, written: saved.written, revision: saved.revision, ...(dryRun ? { diff: saved.diff } : {}) });
    }
    return out;
}

/** `text` with every copy's path replaced by the workspace path of the file it stands for. */
export function renameCopyPaths(text: string, deps: Pick<SpecToolDeps, 'wsRoot'>, staged: readonly Staged[]): string {
    return staged.reduce((t, s) => t.split(s.copy).join(toWorkspacePath(deps as SpecToolDeps, s.abs)), text);
}
