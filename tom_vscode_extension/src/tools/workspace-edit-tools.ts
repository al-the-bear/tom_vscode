/**
 * Workspace-edit tools — `tomAi_applyEdit`.
 *
 * Transactional multi-file changes via VS Code's `WorkspaceEdit` —
 * the atomic-undo counterpart to the per-file mutating tools
 * (`tomAi_editFile`, `tomAi_createFile`, etc.) in `file-mutations.ts`.
 *
 * Refactored for coverage entry #11:
 *
 *   - **vscode-free at runtime.** Impl takes a narrow
 *     `WorkspaceEditService` dep that does the `vscode.WorkspaceEdit`
 *     construction + `applyEdit` call. Tests pass a fake that records
 *     the ops handed to it.
 *
 *   - **1-based line/character on user-facing API.** Translated to
 *     0-based at the service boundary so vscode sees what it expects.
 *
 *   - **Workspace traversal guard added.** Any op-list path that
 *     escapes the workspace root is rejected before the edit is
 *     constructed (previously you could `renameFile` from inside
 *     the workspace to `/tmp/owned`).
 *
 *   - **`createFile` default flipped to `ignoreIfExists: false`** to
 *     match `file-mutations.ts createFile` (which now requires
 *     `overwrite: true` to clobber). Silent no-op on collision was
 *     the same trap `file-mutations.ts` removed for entry #2 —
 *     fixing it here keeps the two file-creation paths consistent.
 *     Pass `ignoreIfExists: true` explicitly to opt back in.
 *
 *   - **Per-op validation surfaces full context** — the response
 *     lists every requested op with `{op, ok, reason?}` so the
 *     model knows which one failed and why, instead of just getting
 *     "Failed to prepare delete: undefined".
 */

import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';

// ===========================================================================
// Input + dep types
// ===========================================================================

export interface ApplyEditInputRange {
    /** 1-based. */
    startLine: number;
    /** 1-based. */
    startCharacter: number;
    /** 1-based. */
    endLine: number;
    /** 1-based. */
    endCharacter: number;
}

export interface ApplyEditOp {
    op: 'replace' | 'insert' | 'delete' | 'createFile' | 'deleteFile' | 'renameFile';
    filePath?: string;
    fromPath?: string;
    toPath?: string;
    range?: ApplyEditInputRange;
    position?: { line: number; character: number };
    text?: string;
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    ignoreIfNotExists?: boolean;
}

export interface ApplyEditInput {
    operations: ApplyEditOp[];
}

/** Op shape handed to the service, with paths already resolved + positions 0-based. */
export interface ResolvedApplyEditOp {
    op: ApplyEditOp['op'];
    absPath?: string;
    fromAbs?: string;
    toAbs?: string;
    range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
    position?: { line: number; character: number };
    text?: string;
    overwrite?: boolean;
    ignoreIfExists?: boolean;
    ignoreIfNotExists?: boolean;
}

export interface WorkspaceEditService {
    wsRoot: string;
    /**
     * Build the vscode.WorkspaceEdit, apply it, and report back. The
     * impl has already validated + resolved every op; the service
     * doesn't need to second-guess.
     */
    applyOps(ops: ResolvedApplyEditOp[]): Promise<{ applied: boolean; affectedFiles: string[] }>;
}

// ===========================================================================
// Impl
// ===========================================================================

type Validation =
    | { ok: true; resolved: ResolvedApplyEditOp }
    | { ok: false; reason: string };

function validateOp(op: ApplyEditOp, wsRoot: string): Validation {
    const resolveInWs = (filePath: string): { ok: true; abs: string } | { ok: false; reason: string } => {
        if (!filePath) { return { ok: false, reason: 'filePath is required' }; }
        const abs = resolveAgainstWsRoot(filePath, wsRoot);
        if (!isInsideWorkspace(abs, wsRoot)) { return { ok: false, reason: `path escapes workspace: ${filePath}` }; }
        return { ok: true, abs };
    };
    const downRange = (r: ApplyEditInputRange): ResolvedApplyEditOp['range'] => ({
        startLine: Math.max(0, Math.floor(r.startLine) - 1),
        startCharacter: Math.max(0, Math.floor(r.startCharacter) - 1),
        endLine: Math.max(0, Math.floor(r.endLine) - 1),
        endCharacter: Math.max(0, Math.floor(r.endCharacter) - 1),
    });
    const downPosition = (p: { line: number; character: number }): ResolvedApplyEditOp['position'] => ({
        line: Math.max(0, Math.floor(p.line) - 1),
        character: Math.max(0, Math.floor(p.character) - 1),
    });

    switch (op.op) {
        case 'createFile': {
            const r = resolveInWs(op.filePath ?? '');
            if (!r.ok) { return { ok: false, reason: r.reason }; }
            return { ok: true, resolved: { op: 'createFile', absPath: r.abs, overwrite: !!op.overwrite, ignoreIfExists: op.ignoreIfExists ?? false } };
        }
        case 'deleteFile': {
            const r = resolveInWs(op.filePath ?? '');
            if (!r.ok) { return { ok: false, reason: r.reason }; }
            return { ok: true, resolved: { op: 'deleteFile', absPath: r.abs, ignoreIfNotExists: op.ignoreIfNotExists ?? false } };
        }
        case 'renameFile': {
            const f = resolveInWs(op.fromPath ?? '');
            if (!f.ok) { return { ok: false, reason: `fromPath: ${f.reason}` }; }
            const t = resolveInWs(op.toPath ?? '');
            if (!t.ok) { return { ok: false, reason: `toPath: ${t.reason}` }; }
            return { ok: true, resolved: { op: 'renameFile', fromAbs: f.abs, toAbs: t.abs, overwrite: !!op.overwrite, ignoreIfExists: op.ignoreIfExists ?? false } };
        }
        case 'insert': {
            const r = resolveInWs(op.filePath ?? '');
            if (!r.ok) { return { ok: false, reason: r.reason }; }
            if (!op.position) { return { ok: false, reason: 'insert requires position' }; }
            return { ok: true, resolved: { op: 'insert', absPath: r.abs, position: downPosition(op.position), text: op.text ?? '' } };
        }
        case 'delete': {
            const r = resolveInWs(op.filePath ?? '');
            if (!r.ok) { return { ok: false, reason: r.reason }; }
            if (!op.range) { return { ok: false, reason: 'delete requires range' }; }
            return { ok: true, resolved: { op: 'delete', absPath: r.abs, range: downRange(op.range) } };
        }
        case 'replace': {
            const r = resolveInWs(op.filePath ?? '');
            if (!r.ok) { return { ok: false, reason: r.reason }; }
            if (!op.range) { return { ok: false, reason: 'replace requires range' }; }
            return { ok: true, resolved: { op: 'replace', absPath: r.abs, range: downRange(op.range), text: op.text ?? '' } };
        }
        default:
            return { ok: false, reason: `unknown op: ${(op as { op: string }).op}` };
    }
}

export async function applyEditImpl(service: WorkspaceEditService, input: ApplyEditInput): Promise<string> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
        return JSON.stringify({ error: '`operations` must be a non-empty array.' });
    }
    // Validate every op up front; surface ALL failures, not just the first.
    const validations = input.operations.map((op) => ({ op, validation: validateOp(op, service.wsRoot) }));
    const failures = validations.filter((v) => !v.validation.ok);
    if (failures.length > 0) {
        return JSON.stringify({
            error: `Validation failed for ${failures.length} op(s); nothing applied.`,
            failures: failures.map((f) => ({
                op: f.op.op,
                reason: (f.validation as { ok: false; reason: string }).reason,
            })),
        });
    }
    const resolved = validations.map((v) => (v.validation as { ok: true; resolved: ResolvedApplyEditOp }).resolved);
    try {
        const { applied, affectedFiles } = await service.applyOps(resolved);
        return JSON.stringify({
            applied,
            operationCount: input.operations.length,
            affectedFiles,
        });
    } catch (err) {
        return JSON.stringify({ error: `applyEdit failed: ${(err as Error).message}` });
    }
}

export const APPLY_EDIT_DESCRIPTION =
    'Apply a transactional multi-file `WorkspaceEdit` — atomic undo across ' +
    'every operation. **Ops**: `replace`/`insert`/`delete` within a file; ' +
    '`createFile`/`deleteFile`/`renameFile` at the workspace level. Prefer ' +
    'this over multiple `tomAi_editFile` calls for any cross-file refactor — ' +
    'the user gets one undo step instead of N. **Validation is up front**: ' +
    'every op is checked before any are applied; a single bad op aborts ' +
    'the whole batch with `failures: [{op, reason}, …]` listing every ' +
    'problem (not just the first). **Path traversal outside the workspace ' +
    'is rejected.** **createFile defaults to `ignoreIfExists: false`** ' +
    '(same as `tomAi_createFile`) — pass `ignoreIfExists: true` to no-op ' +
    'on collision. **Positions are 1-based** (consistent with the rest of ' +
    'the tool surface). Requires user approval.';

export const APPLY_EDIT_TOOL: SharedToolDefinition<ApplyEditInput> = {
    name: 'tomAi_applyEdit',
    displayName: 'Apply Workspace Edit',
    description: APPLY_EDIT_DESCRIPTION,
    tags: ['files', 'edit', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['operations'],
        properties: {
            operations: {
                type: 'array',
                items: {
                    type: 'object',
                    required: ['op'],
                    properties: {
                        op: { type: 'string', enum: ['replace', 'insert', 'delete', 'createFile', 'deleteFile', 'renameFile'] },
                        filePath: { type: 'string', description: 'For replace/insert/delete/createFile/deleteFile.' },
                        fromPath: { type: 'string', description: 'For renameFile.' },
                        toPath: { type: 'string', description: 'For renameFile.' },
                        text: { type: 'string', description: 'For replace/insert.' },
                        range: {
                            type: 'object',
                            properties: {
                                startLine: { type: 'number', description: '1-based.' },
                                startCharacter: { type: 'number', description: '1-based.' },
                                endLine: { type: 'number', description: '1-based.' },
                                endCharacter: { type: 'number', description: '1-based.' },
                            },
                        },
                        position: {
                            type: 'object',
                            properties: {
                                line: { type: 'number', description: '1-based.' },
                                character: { type: 'number', description: '1-based.' },
                            },
                        },
                        overwrite: { type: 'boolean', description: 'For createFile/renameFile.' },
                        ignoreIfExists: { type: 'boolean', description: 'For createFile/renameFile. Default false.' },
                        ignoreIfNotExists: { type: 'boolean', description: 'For deleteFile. Default false.' },
                    },
                },
            },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// Tiny helper for the bridge to use when surfacing affectedFiles —
// keeps the impl's contract pure (workspace-relative when possible).
export function relativeIfInWs(absPath: string, wsRoot: string): string {
    if (!wsRoot) { return absPath; }
    const rel = path.relative(wsRoot, absPath);
    return rel.startsWith('..') ? absPath : rel;
}

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKSPACE_EDIT_TOOLS: SharedToolDefinition<any>[] = [
    APPLY_EDIT_TOOL,
];
