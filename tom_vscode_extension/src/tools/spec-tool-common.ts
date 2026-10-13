/**
 * What the TomSpecs (SOM) tool modules share: the dependency set, input path
 * resolution inside the workspace, the document header every document answer
 * carries, failure answers, and the live dependencies for the extension.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';
import { SomDocumentError, SomDocumentStore } from '../services/som-document-store';
import type { LoadedSomDocument } from '../services/som-document-store';
import { SomModelService } from '../services/som-model-service';
import { SpecPathError } from '../services/som-spec-inspector';
import { SomSearchCursors } from '../services/som-search-cursors';
import { somDocumentStore } from '../services/som-document-io-vscode';

export interface SpecToolDeps {
    /** Workspace root; relative `file` / `dir` inputs resolve against it, and nothing outside it is read. */
    wsRoot: string;
    store: SomDocumentStore;
    service: SomModelService;
    /** specListDocuments' walk budget; default SPEC_LIST_TIME_BUDGET_MS (spec-tools.ts). */
    listTimeBudgetMs?: number;
    /** Open search cursors; default the extension-wide set. */
    cursors?: SomSearchCursors;
}

export const json = (value: unknown): string => JSON.stringify(value);

/** A failure answer: the message, plus the error code and recovery hint when there is one. */
export function failure(e: unknown): string {
    if (e instanceof SomDocumentError) {
        return json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SpecPathError) {
        return json({ ok: false, code: 'unresolvedPath', error: e.message, ...(e.nearest ? { nearest: e.nearest } : {}) });
    }
    return json({ ok: false, error: (e as Error).message });
}

export function toWorkspacePath(deps: SpecToolDeps, absolute: string): string {
    return path.relative(deps.wsRoot, absolute).split(path.sep).join('/');
}

export function resolveInput(deps: SpecToolDeps, file: string): string {
    const resolved = resolveAgainstWsRoot(file, deps.wsRoot);
    if (!isInsideWorkspace(resolved, deps.wsRoot)) {
        throw new Error(`Path is outside the workspace: ${file}`);
    }
    return resolved;
}

export function loadDocument(deps: SpecToolDeps, file: string): LoadedSomDocument {
    return deps.store.load(resolveInput(deps, file));
}

/** The document-level facts every document answer carries. */
export function documentHeader(deps: SpecToolDeps, loaded: LoadedSomDocument): Record<string, unknown> {
    return {
        file: toWorkspacePath(deps, loaded.filePath),
        format: loaded.format,
        root: loaded.root.sectionId ?? loaded.root.type,
        stamp: loaded.stamp,
        editability: loaded.editability,
        readOnlyReason: loaded.readOnlyReason,
        revision: loaded.revision,
    };
}

// ---------------------------------------------------------------------------
// Live dependencies and shared parameter text
// ---------------------------------------------------------------------------

/** The extension's open search cursors (tomAi_specSearch / tomAi_specSearchIterate). */
export const sharedCursors = new SomSearchCursors();

export function liveDeps(): SpecToolDeps {
    return {
        wsRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        store: somDocumentStore(),
        service: SomModelService.instance,
        cursors: sharedCursors,
    };
}

export const FILE_PARAM = {
    type: 'string',
    description: 'A TomSpecs document: `*.docspecs.yaml` or a SOM-rendered `*.md`. Workspace-relative or absolute (inside the workspace).',
};
export const PATH_PARAM_HINT =
    'A document path: the root section id, then field segments (a field\'s @SectionId, else its name) and list items `<LIST>-<n>`, '
    + 'e.g. `SBP/introductionAndScope/requirements/functionalRequirements/FRE-REQU-LST-1`. Take paths from tomAi_specOutline rather than composing them.';
/** Where an agent should look before reading or writing a document. */
export const FIRST_LOOK =
    ' Look first with tomAi_specOutline (paths, editability, revision) or tomAi_specReflect (what the model allows at a path).';
/** Every single-edit tool points to the batch. */
export const BATCH_HINT =
    ' For more than one change use tomAi_specApplyEdits: one approval, one write, all or nothing.';
export const UNRESOLVED_NOTE =
    'A path that does not resolve returns `{ok:false, code:"unresolvedPath", nearest:{path, kind, children}}`: the nearest node that does, with its child paths.';

