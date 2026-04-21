import * as vscode from 'vscode';

/**
 * Workspace-state backed draft store for notepad providers that keep
 * their content in VS Code's `workspaceState` memento rather than in a
 * file on disk (Copilot / Local LLM / AI Conversation / Tom AI Chat
 * panel drafts).
 *
 * Each instance owns one key and handles debounced save-on-change
 * semantics externally — providers call `save()` when the user edits,
 * the memento write goes through `context.workspaceState.update()`
 * which VS Code already debounces internally. This helper exists mostly
 * for symmetry with {@link NotepadFileStorage} / {@link NotepadFolderStorage}
 * and to centralise the key naming contract so the `configuration_structure.md`
 * inventory stays accurate.
 *
 * Secondary selection keys (selected template, profile, config id, etc.)
 * are tracked as siblings on the same store so the provider doesn't
 * have to spread `workspaceState` access across half a dozen private
 * methods.
 */
export class NotepadDraftStore {
    private _draft: string;
    private readonly _selections: Map<string, string> = new Map();

    constructor(
        private readonly _context: vscode.ExtensionContext,
        public readonly draftKey: string,
        selectionKeys: string[] = [],
    ) {
        this._draft = _context.workspaceState.get<string>(draftKey) ?? '';
        for (const key of selectionKeys) {
            this._selections.set(key, _context.workspaceState.get<string>(key) ?? '');
        }
    }

    /** Current draft text. Updated by `save()` — not re-read from state on access. */
    get draft(): string {
        return this._draft;
    }

    /** Lookup a tracked selection value by its storage key. */
    getSelection(key: string): string {
        return this._selections.get(key) ?? '';
    }

    /**
     * Persist a new draft. Provider should call this on every
     * `updateDraft` message from the webview; VS Code's memento layer
     * handles write batching internally so we don't add our own debounce.
     */
    async save(draft: string): Promise<void> {
        this._draft = draft;
        await this._context.workspaceState.update(this.draftKey, draft);
    }

    /** Persist a selection value under one of the configured selection keys. */
    async setSelection(key: string, value: string): Promise<void> {
        this._selections.set(key, value);
        await this._context.workspaceState.update(key, value);
    }
}
