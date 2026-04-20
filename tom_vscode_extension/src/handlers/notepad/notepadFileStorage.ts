import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Shared draft-on-disk storage for notepad providers that persist their
 * content into a single file (Tom global notes, workspace notes, quest
 * notes). Encapsulates the ensureDir + ensureFile + file-watcher +
 * ignore-echo pattern that every "file-backed notepad" was reimplementing.
 *
 * The file watcher distinguishes between our own writes (which we just
 * issued) and external writes (which should reload into the view). The
 * 1-second ignore window mirrors the original logic from
 * `sidebarNotes-handler.ts`: VS Code's file watcher sometimes fires
 * `onDidChange` for our own save a moment after `writeFileSync`, so we
 * suppress the first change event after each save.
 *
 * Providers hook into external changes by passing an `onExternalChange`
 * callback to `watch()`. The callback fires on `onDidChange` or
 * `onDidCreate` only when the change didn't originate from us.
 */
export class NotepadFileStorage {
    private _content: string = '';
    private _watcher: vscode.FileSystemWatcher | undefined;
    private _ignoreNextChange: boolean = false;
    private _lastSaveTime: number = 0;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(public readonly filePath: string) {}

    /** Absolute file path handed to the provider for display / open-in-editor. */
    get path(): string {
        return this.filePath;
    }

    /** Current in-memory content. Not freshly read from disk on each call — call `load()` first. */
    get content(): string {
        return this._content;
    }

    /** Force a disk re-read. Silently falls back to empty on I/O errors. */
    load(): string {
        try {
            this.ensureFile();
            this._content = fs.readFileSync(this.filePath, 'utf-8');
        } catch {
            this._content = '';
        }
        return this._content;
    }

    /**
     * Replace the stored content and write it to disk. Sets the ignore-echo
     * flag so the watcher doesn't treat this write as an external change.
     */
    save(content: string): void {
        this._content = content;
        try {
            this.ensureFile();
            this._ignoreNextChange = true;
            this._lastSaveTime = Date.now();
            fs.writeFileSync(this.filePath, content, 'utf-8');
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save notes: ${e}`);
        }
    }

    /**
     * Set up the file watcher. `onExternalChange` fires when the file
     * is modified from outside (not by our own `save()`). The provider
     * is responsible for re-rendering.
     */
    watch(onExternalChange: () => void): void {
        if (this._watcher) {
            return; // already watching
        }
        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(this.filePath)),
            path.basename(this.filePath),
        );
        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const handle = () => {
            // Suppress our own echoes. 1 s is conservative — VS Code's
            // watcher has been observed to fire up to ~400 ms after a
            // synchronous writeFileSync, so this gives margin without
            // blocking a real external edit the user just made.
            if (this._ignoreNextChange || Date.now() - this._lastSaveTime < 1000) {
                this._ignoreNextChange = false;
                return;
            }
            this.load();
            onExternalChange();
        };
        this._disposables.push(
            this._watcher.onDidChange(handle),
            this._watcher.onDidCreate(handle),
            this._watcher,
        );
    }

    /** Create the file (and its parent directory) if missing. */
    ensureFile(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, '', 'utf-8');
        }
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._disposables.length = 0;
        this._watcher = undefined;
    }
}
