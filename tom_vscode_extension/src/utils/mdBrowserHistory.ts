/**
 * Per-panel navigation history of the Markdown Browser: the documents visited
 * in one panel, with where the reader was in each, so going back returns to
 * the same place.
 */

/**
 * Where the reader was in a document: the source line of the block at the top
 * of the view and that block's offset from the top, plus the raw scroll offset
 * for when no block was found. A line survives re-rendering, where a scroll
 * offset of a lazily laid-out document does not.
 */
export interface ReadingPosition {
    line: number | null;
    delta: number;
    scrollTop: number;
}

export interface HistoryEntry {
    filePath: string;
    group: string;
    position?: ReadingPosition;
}

const DEFAULT_MAX_ENTRIES = 100;

export class NavigationHistory {
    private _entries: HistoryEntry[] = [];
    private _currentIndex = -1;

    constructor(private readonly _max = DEFAULT_MAX_ENTRIES) {}

    get canGoBack(): boolean { return this._currentIndex > 0; }
    get canGoForward(): boolean { return this._currentIndex < this._entries.length - 1; }
    get current(): HistoryEntry | undefined { return this._entries[this._currentIndex]; }

    /** Navigate to a new document: the forward entries are dropped. */
    push(entry: HistoryEntry): void {
        this._entries = this._entries.slice(0, this._currentIndex + 1);
        this._entries.push(entry);
        if (this._entries.length > this._max) {
            this._entries.shift();
        }
        this._currentIndex = this._entries.length - 1;
    }

    goBack(): HistoryEntry | undefined {
        if (!this.canGoBack) { return undefined; }
        this._currentIndex--;
        return this._entries[this._currentIndex];
    }

    goForward(): HistoryEntry | undefined {
        if (!this.canGoForward) { return undefined; }
        this._currentIndex++;
        return this._entries[this._currentIndex];
    }

    /**
     * Remember where the reader is in the current document. A report for
     * another file (one that arrives after the panel moved on) is ignored.
     */
    recordPosition(filePath: string, position: ReadingPosition): void {
        const current = this.current;
        if (current && current.filePath === filePath) {
            current.position = position;
        }
    }
}
