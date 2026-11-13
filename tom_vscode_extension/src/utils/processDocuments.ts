/**
 * The documents a process position puts in front of the user (vscimpb64): a
 * step or sub-step declares them (`documents:`, each `{path, label}`), the
 * PROCESS view shows one link per document and the process tools name them.
 *
 * A sub-step without documents of its own takes its step's. A path may hold
 * placeholders, resolved from the position's run:
 *
 * - `${<chat variable>}`: a chat variable as the placeholder engine has it
 *   (`${quest}`, `${idea-document}`, a custom variable with or without `custom.`);
 * - `${input.<name>}` / `${output.<name>}`: the level's inputs and outputs;
 * - `${dirname:<name>}`: the folder of the path that variable holds (e.g. the
 *   todos document beside the working document).
 *
 * A placeholder without a value leaves the link unresolved (shown, not
 * openable). A `.md` file opens in the MD Browser, a `.process.yaml` under
 * `_ai/processes/` in the process editor, any other file in its default editor.
 *
 * Pure: the variables and the file check come in.
 */

import * as path from 'path';
import { findPhase, findStep, findSubstep, type ProcessDefinition, type ProcessDocument, type ProcessState } from './processDefinition';

/** Where a document opens. */
export type DocumentOpener = 'mdBrowser' | 'processEditor' | 'editor';

/** One document link as the PROCESS view shows it. */
export interface DocumentLink {
    label: string;
    /** The path as resolved, workspace-relative with `/` when it lies in the workspace, else absolute; '' when unresolved. */
    path: string;
    /** Absolute; '' when unresolved. */
    absPath: string;
    opener: DocumentOpener;
    exists: boolean;
    /** The placeholders that had no value (the link cannot open then). */
    unresolved: string[];
    /** For the process editor: the process id (the folder under `_ai/processes/`). */
    processId?: string;
}

/** The documents the position declares: the sub-step's when it has its own, else the step's. */
export function positionDocuments(def: ProcessDefinition | null, state: ProcessState): ProcessDocument[] {
    if (!def || !state.process || state.completed) { return []; }
    const step = findStep(findPhase(def, state.phase), state.step);
    const sub = findSubstep(step, state.substep);
    const own = sub?.documents !== undefined ? sub : step;
    return (own?.documents ?? []).filter((d) => d && typeof d.path === 'string' && d.path.trim() !== '');
}

/** A variable's value by name; `input.` / `output.` names read the level, the rest the chat variables. */
export type DocumentLookup = (name: string) => string | undefined;

/** A lookup over the chat variables (as the placeholder engine has them) and the level's inputs and outputs. */
export function documentLookup(values: Readonly<Record<string, string>>, state?: ProcessState): DocumentLookup {
    return (name) => {
        const v = name.startsWith('input.') ? state?.inputs?.[name.slice('input.'.length)]
            : name.startsWith('output.') ? state?.outputs?.[name.slice('output.'.length)]
                : values[name] ?? values[`custom.${name}`] ?? (name.startsWith('custom.') ? values[name.slice('custom.'.length)] : undefined);
        return v === undefined || v === '' ? undefined : String(v);
    };
}

/** Resolve the placeholders of `text`; answers the text and the placeholders that had no value. */
export function resolveDocumentPath(text: string, lookup: DocumentLookup): { path: string; unresolved: string[] } {
    const unresolved: string[] = [];
    // `${dirname:x}/file` with x in the workspace root: the folder is '' and the path is `file`, not `/file`.
    let emptyDirAtStart = false;
    const out = text.replace(/\$\{([^}]+)\}/g, (whole, inner: string, offset: number) => {
        const name = inner.trim();
        const dir = name.startsWith('dirname:');
        const v = lookup(dir ? name.slice('dirname:'.length).trim() : name);
        if (v === undefined) { unresolved.push(whole); return whole; }
        if (!dir) { return v; }
        const d = path.posix.dirname(v.split(path.sep).join('/'));
        if (d === '.') { if (offset === 0) { emptyDirAtStart = true; } return ''; }
        return d;
    });
    return { path: emptyDirAtStart && out.startsWith('/') ? out.slice(1) : out, unresolved };
}

/** Where a path opens. */
export function documentOpener(relPath: string): { opener: DocumentOpener; processId?: string } {
    const p = relPath.split(path.sep).join('/');
    const proc = /(?:^|\/)_ai\/processes\/([^/]+)\/\1\.process\.yaml$/.exec(p);
    if (proc) { return { opener: 'processEditor', processId: proc[1] }; }
    return { opener: /\.md$/i.test(p) ? 'mdBrowser' : 'editor' };
}

/** The position's documents as links: resolved, located, checked. */
export function documentLinks(
    docs: readonly ProcessDocument[],
    lookup: DocumentLookup,
    workspaceRoot: string,
    exists: (absPath: string) => boolean,
): DocumentLink[] {
    return docs.map((d) => {
        const { path: resolved, unresolved } = resolveDocumentPath(d.path.trim(), lookup);
        const fallbackLabel = path.posix.basename(resolved.split(path.sep).join('/')) || d.path;
        const label = d.label?.trim() || fallbackLabel;
        if (unresolved.length) {
            return { label, path: '', absPath: '', opener: documentOpener(resolved).opener, exists: false, unresolved };
        }
        const absPath = path.isAbsolute(resolved) ? path.normalize(resolved) : path.join(workspaceRoot, resolved);
        const rel = path.relative(workspaceRoot, absPath);
        const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : absPath;
        return { label, path: shown, absPath, ...documentOpener(shown), exists: exists(absPath), unresolved: [] };
    });
}
