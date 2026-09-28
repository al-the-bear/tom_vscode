import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * How often the poll fallback re-reads the watched file, in milliseconds.
 *
 * The poll is not a safety net here, it is the primary mechanism:
 * `createFileSystemWatcher` does not reliably fire for files whose real path
 * resolves outside the workspace folders, and every notepad is such a file.
 * The quest and workspace notes live under `_ai/`, a relative symlink onto a
 * single shared clone; the Tom global notes live in `~/.tom/notes/`, outside
 * any workspace folder at all. `markdownBrowser-handler.ts` carries the same
 * fallback for the same reason.
 *
 * A notepad is a small markdown file, so a re-read per second costs nothing
 * measurable — which is why the poll reads rather than stats. An mtime gate
 * would be cheaper but would also inherit the filesystem's timestamp
 * granularity, and a same-size edit inside one coarse tick is exactly the edit
 * a note-taker makes.
 */
export const NOTEPAD_POLL_INTERVAL_MS = 1000;

/**
 * Shared draft-on-disk storage for notepad providers that persist their
 * content into a single file (Tom global notes, workspace notes, quest
 * notes). Encapsulates the ensureDir + ensureFile + change-detection pattern
 * that every "file-backed notepad" was reimplementing.
 *
 * External changes reach the provider through the `onExternalChange` callback
 * given to `watch()`; the provider re-renders. Our own saves must not travel
 * that path, or the view would fight the user's typing.
 *
 * **How our own writes are recognised.** By content, not by timing. `_content`
 * is what this storage believes the file holds, and `save()` updates it before
 * writing — so a change signal whose disk content equals `_content` is our own
 * echo (or a no-op touch) and is dropped. This replaces a one-shot "ignore the
 * next event" flag, which was set on every save and cleared only when an event
 * actually arrived: on the paths above the event usually never arrived, the
 * flag stayed armed, and it swallowed the next *genuine* external edit
 * instead. Comparing content cannot get stuck, because it holds no state that
 * an absent event could strand.
 */
export class NotepadFileStorage {
    private _content: string = '';
    private _watcher: vscode.FileSystemWatcher | undefined;
    private _pollTimer: ReturnType<typeof setInterval> | undefined;
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
     * Replace the stored content and write it to disk. Updating `_content`
     * first is what makes the write invisible to change detection.
     */
    save(content: string): void {
        this._content = content;
        try {
            this.ensureFile();
            fs.writeFileSync(this.filePath, content, 'utf-8');
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to save notes: ${e}`);
        }
    }

    /**
     * Start detecting changes made to the file from outside. `onExternalChange`
     * fires once per change that actually differs from what we hold; the
     * provider is responsible for re-rendering. Calling it twice is a no-op.
     *
     * Both the native watcher and the poll feed the same check, so which of
     * them noticed first makes no difference to the caller.
     *
     * `pollIntervalMs` exists so tests need not wait a real second.
     */
    watch(onExternalChange: () => void, pollIntervalMs: number = NOTEPAD_POLL_INTERVAL_MS): void {
        if (this._watcher || this._pollTimer) {
            return; // already watching
        }
        const handle = (): void => {
            if (this._refreshFromDisk()) { onExternalChange(); }
        };
        try {
            const pattern = new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(this.filePath)),
                path.basename(this.filePath),
            );
            this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
            this._disposables.push(
                this._watcher.onDidChange(handle),
                this._watcher.onDidCreate(handle),
                this._watcher,
            );
        } catch {
            // The watcher is an optimisation for the paths it does serve; the
            // poll below is the guarantee. Losing it must not stop detection.
        }
        this._pollTimer = setInterval(handle, pollIntervalMs);
        this._pollTimer.unref?.();
    }

    /**
     * Re-read the file and adopt content that differs from what we hold.
     * Returns whether that happened, i.e. whether this was an external change.
     *
     * A read failure is reported as "no change": the file is either mid-write
     * or gone, and in both cases the content we already have is the better
     * answer than blanking the view. Unlike `load()` this never recreates a
     * missing file — a poll that resurrects what the user just deleted, once a
     * second, is not a poll anyone wants.
     */
    private _refreshFromDisk(): boolean {
        let onDisk: string;
        try {
            onDisk = fs.readFileSync(this.filePath, 'utf-8');
        } catch {
            return false;
        }
        if (onDisk === this._content) { return false; }
        this._content = onDisk;
        return true;
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
        if (this._pollTimer) { clearInterval(this._pollTimer); }
        this._pollTimer = undefined;
        for (const d of this._disposables) { d.dispose(); }
        this._disposables.length = 0;
        this._watcher = undefined;
    }
}
