/**
 * `tomAi_rename` — workspace-wide rename via the language server's
 * rename provider. Carved out of `language-service-tools.ts` for
 * coverage entry #11.
 *
 * Changes vs the previous impl:
 *
 *   - **vscode-free at runtime.** Takes a narrow `RenameService` dep.
 *
 *   - **1-based line/character** (was 0-based — inconsistent with the
 *     rest of the tool surface after the entries #1/#6/#9/#10 sweep).
 *
 *   - **Three-way result instead of binary success/error:**
 *     `{ kind: 'no-provider' }` (language has no rename provider) is
 *     distinguished from `{ kind: 'no-edits' }` (provider returned an
 *     empty edit — usually means "not a renameable symbol") so the
 *     model knows whether to give up vs. try a different position.
 *
 *   - **Multi-file atomicity documented**: `vscode.workspace.applyEdit`
 *     IS atomic (all-or-nothing). The description now says so; the
 *     test fixture proves it by setting up a 3-file rename and
 *     verifying all three URIs end up in `affectedFiles`.
 *
 *   - **No-op rename (newName === current name)** detected at the
 *     impl boundary and rejected before hitting the provider so the
 *     model gets a clearer "nothing to rename to itself" error.
 */

import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// Narrow dep types
// ===========================================================================

export type RenameProviderResult =
    | { kind: 'ok'; affectedFiles: string[] }
    | { kind: 'no-provider' }
    | { kind: 'no-edits' };

export interface RenameService {
    /** Resolve a possibly-relative `filePath` to absolute, or null if missing. */
    resolveFile(filePath: string): string | null;
    /**
     * Run the rename provider and apply the edit. `line`/`character`
     * are 0-based (vscode-native); the impl handles the user-facing
     * 1-based conversion.
     */
    rename(absPath: string, line: number, character: number, newName: string): Promise<RenameProviderResult>;
}

// ===========================================================================
// Impl
// ===========================================================================

export interface RenameInput {
    filePath: string;
    /** 1-based. */
    line: number;
    /** 1-based. */
    character: number;
    newName: string;
    /** Optional current name — if provided, an immediate `newName === currentName` check rejects no-op renames. */
    currentName?: string;
}

export async function renameImpl(service: RenameService, input: RenameInput): Promise<string> {
    if (!input.filePath) { return JSON.stringify({ error: '`filePath` is required.' }); }
    if (typeof input.line !== 'number' || typeof input.character !== 'number') {
        return JSON.stringify({ error: '`line` and `character` are required (1-based).' });
    }
    if (!input.newName) { return JSON.stringify({ error: '`newName` is required.' }); }
    if (input.currentName && input.currentName === input.newName) {
        return JSON.stringify({
            error: `\`newName\` equals \`currentName\` (${input.currentName}) — nothing to do.`,
        });
    }
    const abs = service.resolveFile(input.filePath);
    if (!abs) { return JSON.stringify({ error: `File not found: ${input.filePath}` }); }

    let result: RenameProviderResult;
    try {
        result = await service.rename(
            abs,
            Math.max(0, Math.floor(input.line) - 1),
            Math.max(0, Math.floor(input.character) - 1),
            input.newName,
        );
    } catch (err) {
        return JSON.stringify({ error: `Rename failed: ${(err as Error).message}` });
    }

    if (result.kind === 'no-provider') {
        return JSON.stringify({
            error: 'No rename provider available for this language. The language extension may not implement rename, or the document isn\'t open in a language-aware state yet.',
        });
    }
    if (result.kind === 'no-edits') {
        return JSON.stringify({
            error: 'Rename provider returned no edits. Position may not be a renameable symbol, or the new name conflicts with the language\'s rename policy (e.g. trying to rename a keyword).',
        });
    }
    return JSON.stringify({
        applied: true,
        newName: input.newName,
        affectedFiles: result.affectedFiles,
        affectedFileCount: result.affectedFiles.length,
        note: result.affectedFiles.length > 1
            ? `Atomic multi-file rename across ${result.affectedFiles.length} files (single undo).`
            : 'Single-file rename (single undo).',
    }, null, 2);
}

export const RENAME_DESCRIPTION =
    'Workspace-wide rename of the symbol at a given file position via the ' +
    'language server\'s rename provider. **Atomic** — `vscode.workspace.applyEdit` ' +
    'applies the whole multi-file edit as a single undo unit, so partial ' +
    'rename across files cannot happen. **Safer than `tomAi_editFile` ' +
    'replaceAll** because the LSP knows about scope: a method named `foo` ' +
    'on class A is not renamed when class B also has a `foo`. **Not all ' +
    'languages have rename providers** — the response distinguishes ' +
    '`{error: "No rename provider available..."}` (language unsupported) ' +
    'from `{error: "no edits..."}` (provider ran but rejected this position ' +
    'or new name). Pass `currentName` to short-circuit no-op renames. ' +
    '**Positions are 1-based.** Requires user approval.';

export const RENAME_TOOL: SharedToolDefinition<RenameInput> = {
    name: 'tomAi_rename',
    displayName: 'Rename Symbol',
    description: RENAME_DESCRIPTION,
    tags: ['refactor', 'symbols', 'tom-ai-chat'],
    readOnly: false,
    requiresApproval: true,
    inputSchema: {
        type: 'object',
        required: ['filePath', 'line', 'character', 'newName'],
        properties: {
            filePath: { type: 'string' },
            line: { type: 'number', description: '1-based.' },
            character: { type: 'number', description: '1-based.' },
            newName: { type: 'string' },
            currentName: { type: 'string', description: 'Optional — when provided, no-op renames (newName === currentName) are rejected with a clear error.' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};
