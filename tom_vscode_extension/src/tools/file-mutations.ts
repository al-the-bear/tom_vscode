/**
 * File mutation primitives — `tomAi_createFile`, `tomAi_editFile`,
 * `tomAi_multiEditFile`, `tomAi_deleteFile`, `tomAi_moveFile`.
 *
 * Carved out of `tool-executors.ts` (same pattern as `file-primitives.ts`).
 * Each tool exposes a pure `*Impl(wsRoot, input)` so tests can drive it
 * against a temp on-disk fixture without spinning up a vscode extension
 * host.
 *
 * ## Safer-by-default redesign
 *
 * The previous implementations had three classes of foot-gun the LLM
 * routinely hit; these defaults change them into clear errors that the
 * model can recover from on its own, with an explicit opt-in for the
 * old permissive behaviour:
 *
 *   - **`createFile` no longer overwrites silently.** Default fails with
 *     a clear "already exists; pass `overwrite: true` to replace" error.
 *     Caller gets a chance to inspect before clobbering.
 *
 *   - **`editFile` requires `oldText` to match exactly once.** A
 *     multi-match input is almost always a bug (the model picked a
 *     non-unique anchor); the previous code replaced the first
 *     occurrence silently and the model never noticed it lost the
 *     other edits. Opt-in `replaceAll: true` for genuine bulk renames.
 *
 *   - **`multiEditFile` is atomic by default.** All edits are
 *     pre-validated against the on-disk files; if any one fails, none
 *     are applied. The previous non-atomic behaviour is available via
 *     `bestEffort: true` for the rare case where partial progress is
 *     useful (e.g., applying as many cherry-picks as possible).
 *
 * Additional fixes:
 *
 *   - `createFile` now enforces `isInsideWorkspace` (the previous impl
 *     skipped the check, so a `..`-traversal escaped the sandbox).
 *   - `deleteFile` returns a clear "is a directory" error instead of
 *     EISDIR from `unlink`.
 *   - `moveFile` falls back to copy+unlink on EXDEV (cross-filesystem)
 *     so a rename across an APFS volume boundary still works.
 *   - `moveFile` no longer silently overwrites the destination; same
 *     opt-in `overwrite: true` as `createFile`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SharedToolDefinition } from './shared-tool-registry';
import { isInsideWorkspace, resolveAgainstWsRoot } from './file-primitives';

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateFileInput {
    filePath: string;
    content: string;
    /** Default false — fail when the file already exists. */
    overwrite?: boolean;
}

export interface EditOperation {
    filePath: string;
    oldText: string;
    newText: string;
    /** Default false — fail when `oldText` matches 0 or >1 times. */
    replaceAll?: boolean;
}

export interface EditFileInput extends EditOperation {}

export interface MultiEditFileInput {
    edits: EditOperation[];
    /**
     * Default false (atomic). When true the executor applies every edit
     * it can and reports per-edit success/failure, matching the legacy
     * behaviour. Useful for "apply what works, tell me what didn't"
     * scripted patches; do not use for the kind of refactor where
     * partial application would leave the codebase broken.
     */
    bestEffort?: boolean;
}

export interface DeleteFileInput {
    path: string;
}

export interface MoveFileInput {
    from: string;
    to: string;
    /** Default false — fail when the destination already exists. */
    overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// createFile
// ---------------------------------------------------------------------------

export async function createFileImpl(wsRoot: string, input: CreateFileInput): Promise<string> {
    if (!input.filePath) { return 'Error: `filePath` is required.'; }
    const resolved = resolveAgainstWsRoot(input.filePath, wsRoot);
    if (!isInsideWorkspace(resolved, wsRoot)) {
        return `Error: path is outside the workspace: ${input.filePath}`;
    }
    if (fs.existsSync(resolved)) {
        if (!input.overwrite) {
            return `Error: file already exists at \`${input.filePath}\`. ` +
                   `Pass \`overwrite: true\` to replace it, or call \`tomAi_editFile\` to modify it in place.`;
        }
        // overwrite=true: surface the prior size as a guard-rail for the
        // model — if it's about to clobber a 50 KB file with 3 bytes,
        // the response makes the choice visible after the fact.
        const prevSize = fs.statSync(resolved).size;
        try {
            fs.writeFileSync(resolved, input.content ?? '', 'utf8');
        } catch (err) {
            return `Error writing file: ${(err as Error).message}`;
        }
        return `Overwrote file: ${input.filePath} (was ${prevSize} bytes, now ${Buffer.byteLength(input.content ?? '')} bytes).`;
    }
    try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, input.content ?? '', 'utf8');
    } catch (err) {
        return `Error creating file: ${(err as Error).message}`;
    }
    return `Created file: ${input.filePath} (${Buffer.byteLength(input.content ?? '')} bytes).`;
}

// ---------------------------------------------------------------------------
// editFile (single-file, single edit)
// ---------------------------------------------------------------------------

/**
 * Apply one edit to one file. Shared between `editFile` and (per-edit
 * step of) `multiEditFile`. Returns either the new content or an error
 * message; the caller decides whether to write to disk.
 */
function applyEditToContent(content: string, edit: EditOperation): { ok: true; content: string; replacements: number } | { ok: false; error: string } {
    if (!edit.oldText) {
        return { ok: false, error: '`oldText` is empty.' };
    }
    // Count occurrences without a global regex (the input may contain
    // regex specials). Walk via `indexOf`.
    let count = 0;
    let idx = content.indexOf(edit.oldText);
    while (idx !== -1) {
        count += 1;
        idx = content.indexOf(edit.oldText, idx + edit.oldText.length);
        if (count > 1 && !edit.replaceAll) { break; }    // early exit for the strict path
    }
    if (count === 0) {
        return { ok: false, error: '`oldText` not found in file. Make sure it matches exactly (whitespace + indentation).' };
    }
    if (count > 1 && !edit.replaceAll) {
        return {
            ok: false,
            error: '`oldText` matches more than once. Pass `replaceAll: true` if you mean to replace every occurrence, ' +
                   'or expand `oldText` with surrounding context to make it unique.',
        };
    }
    if (edit.replaceAll) {
        return { ok: true, content: content.split(edit.oldText).join(edit.newText), replacements: count };
    }
    // count === 1
    return { ok: true, content: content.replace(edit.oldText, edit.newText), replacements: 1 };
}

export async function editFileImpl(wsRoot: string, input: EditFileInput): Promise<string> {
    if (!input.filePath) { return 'Error: `filePath` is required.'; }
    const resolved = resolveAgainstWsRoot(input.filePath, wsRoot);
    if (!isInsideWorkspace(resolved, wsRoot)) {
        return `Error: path is outside the workspace: ${input.filePath}`;
    }
    if (!fs.existsSync(resolved)) {
        return `File not found: ${input.filePath}`;
    }
    let content: string;
    try {
        content = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
        return `Error reading file: ${(err as Error).message}`;
    }
    const result = applyEditToContent(content, input);
    if (!result.ok) {
        return `Error editing ${input.filePath}: ${result.error}`;
    }
    try {
        fs.writeFileSync(resolved, result.content, 'utf8');
    } catch (err) {
        return `Error writing file: ${(err as Error).message}`;
    }
    return `Edited ${input.filePath} (${result.replacements} replacement${result.replacements === 1 ? '' : 's'}).`;
}

// ---------------------------------------------------------------------------
// multiEditFile — atomic by default
// ---------------------------------------------------------------------------

export async function multiEditFileImpl(wsRoot: string, input: MultiEditFileInput): Promise<string> {
    if (!input.edits || input.edits.length === 0) {
        return 'Error: `edits` must be a non-empty array.';
    }

    // Group edits by absolute path so we load each file once and apply
    // its edits in declared order (later edits see earlier edits' result).
    const byFile = new Map<string, { rel: string; edits: EditOperation[] }>();
    for (const edit of input.edits) {
        if (!edit.filePath) {
            return 'Error: every edit must include `filePath`.';
        }
        const abs = resolveAgainstWsRoot(edit.filePath, wsRoot);
        if (!isInsideWorkspace(abs, wsRoot)) {
            return `Error: path is outside the workspace: ${edit.filePath}`;
        }
        const slot = byFile.get(abs) ?? { rel: edit.filePath, edits: [] };
        slot.edits.push(edit);
        byFile.set(abs, slot);
    }

    type PerFileResult =
        | { abs: string; rel: string; ok: true; nextContent: string; totalReplacements: number; perEdit: Array<{ edit: EditOperation; replacements: number }> }
        | { abs: string; rel: string; ok: false; error: string; failedEditIndex: number };

    // Phase 1 — validate & compute new content for every file without touching disk.
    const validations: PerFileResult[] = [];
    for (const [abs, slot] of byFile.entries()) {
        if (!fs.existsSync(abs)) {
            validations.push({ abs, rel: slot.rel, ok: false, error: `File not found: ${slot.rel}`, failedEditIndex: 0 });
            continue;
        }
        let content: string;
        try {
            content = fs.readFileSync(abs, 'utf8');
        } catch (err) {
            validations.push({ abs, rel: slot.rel, ok: false, error: `Read failed: ${(err as Error).message}`, failedEditIndex: 0 });
            continue;
        }
        const perEdit: Array<{ edit: EditOperation; replacements: number }> = [];
        let totalReplacements = 0;
        let failedIndex = -1;
        let failedError = '';
        for (let i = 0; i < slot.edits.length; i++) {
            const r = applyEditToContent(content, slot.edits[i]);
            if (!r.ok) {
                failedIndex = i;
                failedError = r.error;
                break;
            }
            content = r.content;
            totalReplacements += r.replacements;
            perEdit.push({ edit: slot.edits[i], replacements: r.replacements });
        }
        if (failedIndex !== -1) {
            validations.push({ abs, rel: slot.rel, ok: false, error: failedError, failedEditIndex: failedIndex });
        } else {
            validations.push({ abs, rel: slot.rel, ok: true, nextContent: content, totalReplacements, perEdit });
        }
    }

    const successes = validations.filter((v): v is Extract<PerFileResult, { ok: true }> => v.ok);
    const failures = validations.filter((v): v is Extract<PerFileResult, { ok: false }> => !v.ok);

    if (!input.bestEffort && failures.length > 0) {
        // Atomic mode: do not write anything. Report what would have happened.
        const lines = [
            `Aborted: ${failures.length} of ${validations.length} file(s) failed validation; no edits applied. ` +
            `Re-issue with the fixes below, or pass \`bestEffort: true\` to apply the successful files anyway.`,
            '',
        ];
        for (const f of failures) {
            lines.push(`❌ ${f.rel} (edit #${f.failedEditIndex + 1}): ${f.error}`);
        }
        for (const s of successes) {
            lines.push(`⏸ ${s.rel}: ${s.totalReplacements} replacement(s) ready (not applied)`);
        }
        return lines.join('\n');
    }

    // Phase 2 — write. Atomic mode reaches here only if all validations passed.
    const lines: string[] = [];
    for (const v of successes) {
        try {
            fs.writeFileSync(v.abs, v.nextContent, 'utf8');
            lines.push(`✅ ${v.rel}: ${v.totalReplacements} replacement(s)`);
        } catch (err) {
            lines.push(`❌ ${v.rel}: write failed: ${(err as Error).message}`);
        }
    }
    for (const f of failures) {
        lines.push(`❌ ${f.rel} (edit #${f.failedEditIndex + 1}): ${f.error}`);
    }
    const header = failures.length === 0
        ? `Applied ${successes.length} file(s) atomically.`
        : `Best-effort: ${successes.length} applied, ${failures.length} skipped.`;
    return [header, '', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------

export async function deleteFileImpl(wsRoot: string, input: DeleteFileInput): Promise<string> {
    if (!input?.path) { return 'Error: `path` is required.'; }
    const resolved = resolveAgainstWsRoot(input.path, wsRoot);
    if (!isInsideWorkspace(resolved, wsRoot)) {
        return `Error: path is outside the workspace: ${input.path}`;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(resolved);
    } catch {
        return `File not found: ${input.path}`;
    }
    if (stat.isDirectory()) {
        return `Error: \`${input.path}\` is a directory. This tool deletes files only — to remove a directory tree, use a shell command in a separate step with explicit confirmation.`;
    }
    try {
        fs.unlinkSync(resolved);
    } catch (err) {
        return `Error deleting file: ${(err as Error).message}`;
    }
    return `Deleted: ${input.path}`;
}

// ---------------------------------------------------------------------------
// moveFile
// ---------------------------------------------------------------------------

export async function moveFileImpl(wsRoot: string, input: MoveFileInput): Promise<string> {
    if (!input?.from || !input?.to) {
        return 'Error: both `from` and `to` are required.';
    }
    const fromAbs = resolveAgainstWsRoot(input.from, wsRoot);
    const toAbs = resolveAgainstWsRoot(input.to, wsRoot);
    if (!isInsideWorkspace(fromAbs, wsRoot) || !isInsideWorkspace(toAbs, wsRoot)) {
        return `Error: both paths must be inside the workspace.`;
    }
    if (!fs.existsSync(fromAbs)) {
        return `Error: source not found: ${input.from}`;
    }
    if (fromAbs === toAbs) {
        return `Error: \`from\` and \`to\` resolve to the same path: ${input.from}`;
    }
    if (fs.existsSync(toAbs) && !input.overwrite) {
        return `Error: destination already exists at \`${input.to}\`. Pass \`overwrite: true\` to replace it.`;
    }
    try {
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    } catch (err) {
        return `Error creating destination directory: ${(err as Error).message}`;
    }
    try {
        fs.renameSync(fromAbs, toAbs);
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // EXDEV — cross-filesystem rename. fs.rename can't span devices;
        // fall back to copy + unlink so APFS-volume / docker-bind cases
        // still work.
        if (e.code === 'EXDEV') {
            try {
                fs.copyFileSync(fromAbs, toAbs);
                fs.unlinkSync(fromAbs);
            } catch (innerErr) {
                return `Error moving across filesystems: ${(innerErr as Error).message}`;
            }
        } else {
            return `Error moving file: ${e.message}`;
        }
    }
    return `Moved: ${input.from} → ${input.to}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const CREATE_FILE_DESCRIPTION =
    'Create a new file with the given content. Parent directories are auto-created. ' +
    'Fails if the file already exists unless `overwrite: true` is passed — this guards ' +
    'against silent clobbering. Content is written as UTF-8 verbatim (no trailing ' +
    'newline added). Use `tomAi_editFile` to modify an existing file in place.';

export const CREATE_FILE_TOOL: SharedToolDefinition<CreateFileInput> = {
    name: 'tomAi_createFile',
    displayName: 'Create File',
    description: CREATE_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute path. Parent dirs auto-created.' },
            content: { type: 'string', description: 'UTF-8 content. Written verbatim, no trailing newline added.' },
            overwrite: { type: 'boolean', description: 'Replace an existing file. Default false (errors when present).' },
        },
        required: ['filePath', 'content'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const EDIT_FILE_DESCRIPTION =
    'String-replace edit: find `oldText` in the file, replace with `newText`. ' +
    'Patch semantics — `oldText` must match exactly **once** (whitespace and ' +
    'indentation included). A 0- or multi-match input fails with an explicit ' +
    'error explaining how to fix it (expand the anchor with surrounding context, ' +
    'or pass `replaceAll: true` for genuine bulk renames). This is NOT a unified ' +
    'diff and NOT a line-range patch.';

export const EDIT_FILE_TOOL: SharedToolDefinition<EditFileInput> = {
    name: 'tomAi_editFile',
    displayName: 'Edit File',
    description: EDIT_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            filePath: { type: 'string', description: 'Workspace-relative or absolute path.' },
            oldText: { type: 'string', description: 'Exact text to replace — must include enough context to be unique in the file.' },
            newText: { type: 'string', description: 'Replacement text.' },
            replaceAll: { type: 'boolean', description: 'Replace every occurrence. Default false (requires exactly one match).' },
        },
        required: ['filePath', 'oldText', 'newText'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const MULTI_EDIT_FILE_DESCRIPTION =
    'Apply multiple `editFile`-style operations across one or more files. ' +
    '**Atomic by default**: every edit is pre-validated against on-disk content; ' +
    'if any one fails (file missing, ambiguous oldText, etc.) NO edits are ' +
    'applied and a full report is returned. Within a single file, edits run ' +
    'sequentially — each later edit sees the result of the earlier ones. ' +
    'Pass `bestEffort: true` to revert to the legacy "apply what works, ' +
    'report failures" behaviour (useful for cherry-picks where partial ' +
    'progress is acceptable).';

export const MULTI_EDIT_FILE_TOOL: SharedToolDefinition<MultiEditFileInput> = {
    name: 'tomAi_multiEditFile',
    displayName: 'Multi Edit File',
    description: MULTI_EDIT_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    inputSchema: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                description: 'Array of {filePath, oldText, newText, replaceAll?} operations.',
                items: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string' },
                        oldText: { type: 'string' },
                        newText: { type: 'string' },
                        replaceAll: { type: 'boolean' },
                    },
                    required: ['filePath', 'oldText', 'newText'],
                },
            },
            bestEffort: {
                type: 'boolean',
                description: 'Disable atomicity; apply every edit that succeeds. Default false (atomic).',
            },
        },
        required: ['edits'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const DELETE_FILE_DESCRIPTION =
    'Delete a single file from the workspace. Directories are rejected with a ' +
    'clear error — recursive deletion is intentionally not exposed (too easy for ' +
    'a model to misfire). Requires user approval. Path traversal outside the ' +
    'workspace is rejected.';

export const DELETE_FILE_TOOL: SharedToolDefinition<DeleteFileInput> = {
    name: 'tomAi_deleteFile',
    displayName: 'Delete File',
    description: DELETE_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Workspace-relative or absolute path of the file to delete.' },
        },
        required: ['path'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const MOVE_FILE_DESCRIPTION =
    'Move or rename a file within the workspace. Parent directories of `to` ' +
    'are auto-created. Falls back to copy+unlink on EXDEV (cross-filesystem ' +
    'rename, e.g. APFS volumes or docker bind mounts). Fails if the destination ' +
    'already exists unless `overwrite: true`. Both paths must be inside the ' +
    'workspace. Requires user approval.';

export const MOVE_FILE_TOOL: SharedToolDefinition<MoveFileInput> = {
    name: 'tomAi_moveFile',
    displayName: 'Move/Rename File',
    description: MOVE_FILE_DESCRIPTION,
    tags: ['files', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        properties: {
            from: { type: 'string', description: 'Source path (workspace-relative or absolute).' },
            to: { type: 'string', description: 'Destination path (workspace-relative or absolute). Parent dirs auto-created.' },
            overwrite: { type: 'boolean', description: 'Replace an existing destination. Default false.' },
        },
        required: ['from', 'to'],
    },
    execute: async () => 'execute() must be installed by tool-executors.ts',
};

export const FILE_MUTATION_TOOLS = [
    CREATE_FILE_TOOL,
    EDIT_FILE_TOOL,
    MULTI_EDIT_FILE_TOOL,
    DELETE_FILE_TOOL,
    MOVE_FILE_TOOL,
];
