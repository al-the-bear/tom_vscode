import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * An item in the folder listing — the identifier the provider uses
 * (usually the absolute path) plus a user-facing label.
 */
export interface NotepadFolderItem {
    path: string;
    name: string;
}

export interface NotepadFolderStorageOptions {
    /** Absolute path to the folder to watch. */
    folderPath: string;
    /** Glob-ish filter applied to readdir, e.g. `f => f.endsWith('.md')`. */
    include?: (fileName: string) => boolean;
    /**
     * Called after readdir to let the provider add pinned items (e.g. the
     * Guidelines view's `.github/copilot-instructions.md`), reorder, or
     * rewrite names. Default: wrap each filename in `{ path, name }`.
     */
    pinned?: () => NotepadFolderItem[];
    /** `'change'` fires for content changes on the active file only. */
    onChange?: (changedPath: string) => void;
    /** `'listChanged'` fires when the folder's file list changes (add/delete). */
    onListChanged?: () => void;
    /** Used to pattern-match the watcher to the folder's workspace root. */
    workspaceGlob: string;
}

/**
 * Shared multi-file folder storage for notepad providers that browse a
 * directory of markdown / text files (`NotesNotepadProvider`,
 * `GuidelinesNotepadProvider`). Encapsulates the folder watcher + file
 * discovery + per-file read/write pattern, so individual providers stay
 * focused on their domain-specific file rules (which folder, which
 * pinned items, etc.).
 *
 * The provider still owns "active file" state — this helper is a thin
 * layer around directory I/O + watchers.
 */
export class NotepadFolderStorage {
    private _items: NotepadFolderItem[] = [];
    private _watcher: vscode.FileSystemWatcher | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly _opts: NotepadFolderStorageOptions) {}

    /** Current list of items as of the last `load()` call. */
    get items(): NotepadFolderItem[] {
        return this._items;
    }

    /** Absolute path the storage is scoped to. */
    get folderPath(): string {
        return this._opts.folderPath;
    }

    /**
     * Refresh the items list from disk. The provider calls this after
     * construction, after add/delete, and on visibility changes. Silent on
     * I/O errors — returns an empty list if the folder doesn't exist.
     */
    load(): void {
        const items: NotepadFolderItem[] = [];
        try {
            if (fs.existsSync(this._opts.folderPath)) {
                const include = this._opts.include ?? (() => true);
                const names = fs.readdirSync(this._opts.folderPath)
                    .filter(include)
                    .sort();
                for (const name of names) {
                    const p = path.join(this._opts.folderPath, name);
                    try {
                        if (fs.statSync(p).isFile()) {
                            items.push({ path: p, name });
                        }
                    } catch { /* skip unreadable entry */ }
                }
            }
        } catch {
            // Leave items empty on readdir failure.
        }
        if (this._opts.pinned) {
            items.unshift(...this._opts.pinned());
        }
        this._items = items;
    }

    /**
     * Create or replace a file in the folder. Returns the absolute path
     * on success, or `null` if the file already existed.
     */
    createFile(fileName: string, initialContent: string = ''): string | null {
        this.ensureFolder();
        const filePath = path.join(this._opts.folderPath, fileName);
        if (fs.existsSync(filePath)) { return null; }
        fs.writeFileSync(filePath, initialContent, 'utf-8');
        this.load();
        return filePath;
    }

    deleteFile(filePath: string): void {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        this.load();
    }

    /** Read a specific file's contents. Empty string on I/O error. */
    readContent(filePath: string): string {
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf-8');
            }
        } catch { /* fall through */ }
        return '';
    }

    /** Write to a specific file. Throws on I/O errors so callers can surface. */
    writeContent(filePath: string, content: string): void {
        fs.writeFileSync(filePath, content, 'utf-8');
    }

    ensureFolder(): void {
        if (!fs.existsSync(this._opts.folderPath)) {
            fs.mkdirSync(this._opts.folderPath, { recursive: true });
        }
    }

    /**
     * Start watching the folder for changes. Separates list-changed
     * events (add/delete) from per-file content changes so providers can
     * avoid reloading the whole list on every keystroke in another editor.
     */
    watch(): void {
        if (this._watcher) { return; }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }
        const pattern = new vscode.RelativePattern(workspaceFolder, this._opts.workspaceGlob);
        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

        const listChanged = () => {
            this.load();
            this._opts.onListChanged?.();
        };
        this._disposables.push(
            this._watcher.onDidCreate(listChanged),
            this._watcher.onDidDelete(listChanged),
            this._watcher.onDidChange((uri) => {
                this._opts.onChange?.(uri.fsPath);
            }),
            this._watcher,
        );
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables.length = 0;
        this._watcher = undefined;
    }
}
