/**
 * Comprehensive mock of the VS Code API for testing yaml-graph-vscode
 * outside of the VS Code extension host.
 *
 * Provides stub implementations of all VS Code APIs used by the package.
 * Used via vitest's resolve.alias configuration.
 */

// ─── URI ────────────────────────────────────────────────────

export class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;

    private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
        this.scheme = scheme;
        this.authority = authority;
        this.path = path;
        this.query = query;
        this.fragment = fragment;
        this.fsPath = path;
    }

    static file(path: string): Uri {
        return new Uri('file', '', path, '', '');
    }

    static parse(value: string): Uri {
        return new Uri('file', '', value, '', '');
    }

    toString(): string {
        return `${this.scheme}://${this.path}`;
    }

    with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(
            change.scheme ?? this.scheme,
            change.authority ?? this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment,
        );
    }
}

// ─── Position & Range & Selection ───────────────────────────

export class Position {
    readonly line: number;
    readonly character: number;
    constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
    }
    isEqual(other: Position): boolean {
        return this.line === other.line && this.character === other.character;
    }
    isBefore(other: Position): boolean {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    isAfter(other: Position): boolean {
        return !this.isEqual(other) && !this.isBefore(other);
    }
    translate(lineDelta?: number, characterDelta?: number): Position {
        return new Position(this.line + (lineDelta ?? 0), this.character + (characterDelta ?? 0));
    }
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
        if (startLine instanceof Position && startCharacter instanceof Position) {
            this.start = startLine;
            this.end = startCharacter;
        } else {
            this.start = new Position(startLine as number, startCharacter as number);
            this.end = new Position(endLine ?? 0, endCharacter ?? 0);
        }
    }
    get isEmpty(): boolean {
        return this.start.isEqual(this.end);
    }
    contains(positionOrRange: Position | Range): boolean {
        if (positionOrRange instanceof Position) {
            return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
        }
        return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
}

export class Selection extends Range {
    readonly anchor: Position;
    readonly active: Position;
    constructor(anchorLine: number | Position, anchorCharacter: number | Position, activeLine?: number, activeCharacter?: number) {
        if (anchorLine instanceof Position && anchorCharacter instanceof Position) {
            super(anchorLine, anchorCharacter);
            this.anchor = anchorLine;
            this.active = anchorCharacter;
        } else {
            super(anchorLine as number, anchorCharacter as number, activeLine, activeCharacter);
            this.anchor = new Position(anchorLine as number, anchorCharacter as number);
            this.active = new Position(activeLine ?? 0, activeCharacter ?? 0);
        }
    }
}

// ─── TextDocument ───────────────────────────────────────────

export class MockTextDocument {
    uri: Uri;
    fileName: string;
    private text: string;
    languageId: string = 'yaml';
    version: number = 1;
    isDirty: boolean = false;
    isUntitled: boolean = false;
    isClosed: boolean = false;

    constructor(uri: Uri, text: string) {
        this.uri = uri;
        this.fileName = uri.fsPath;
        this.text = text;
    }

    getText(_range?: Range): string {
        return this.text;
    }

    positionAt(offset: number): Position {
        let line = 0;
        let character = 0;
        for (let i = 0; i < offset && i < this.text.length; i++) {
            if (this.text[i] === '\n') {
                line++;
                character = 0;
            } else {
                character++;
            }
        }
        return new Position(line, character);
    }

    offsetAt(position: Position): number {
        let offset = 0;
        let line = 0;
        for (let i = 0; i < this.text.length; i++) {
            if (line === position.line) {
                return offset + position.character;
            }
            if (this.text[i] === '\n') {
                line++;
            }
            offset++;
        }
        return offset;
    }

    lineAt(lineOrPosition: number | Position): { text: string; range: Range; lineNumber: number } {
        const lineNum = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
        const lines = this.text.split('\n');
        const lineText = lines[lineNum] ?? '';
        return {
            text: lineText,
            range: new Range(lineNum, 0, lineNum, lineText.length),
            lineNumber: lineNum,
        };
    }

    get lineCount(): number {
        return this.text.split('\n').length;
    }

    /** Test helper: update the internal text. */
    _setText(newText: string): void {
        this.text = newText;
        this.version++;
    }
}

// ─── TextEditor ─────────────────────────────────────────────

export class MockTextEditor {
    document: MockTextDocument;
    selection: Selection;
    visibleRanges: Range[];
    private _revealedRange: Range | undefined;

    constructor(document: MockTextDocument) {
        this.document = document;
        this.selection = new Selection(0, 0);
        this.visibleRanges = [new Range(0, 0, 20, 0)];
    }

    revealRange(range: Range, _revealType?: TextEditorRevealType): void {
        this._revealedRange = range;
    }

    /** Test helper: get the last range revealed. */
    _getRevealedRange(): Range | undefined {
        return this._revealedRange;
    }
}

// ─── TextEditorRevealType ───────────────────────────────────

export enum TextEditorRevealType {
    Default = 0,
    InCenter = 1,
    InCenterIfOutsideViewport = 2,
    AtTop = 3,
}

// ─── WorkspaceEdit ──────────────────────────────────────────

export class WorkspaceEdit {
    private edits: Array<{ uri: Uri; range: Range; newText: string }> = [];

    replace(uri: Uri, range: Range, newText: string): void {
        this.edits.push({ uri, range, newText });
    }

    insert(uri: Uri, position: Position, newText: string): void {
        this.edits.push({ uri, range: new Range(position, position), newText });
    }

    delete(uri: Uri, range: Range): void {
        this.edits.push({ uri, range, newText: '' });
    }

    /** Test helper: get all recorded edits. */
    _getEdits(): Array<{ uri: Uri; range: Range; newText: string }> {
        return this.edits;
    }
}

// ─── Webview & WebviewPanel ─────────────────────────────────

export class MockWebview {
    html: string = '';
    private messageListeners: Array<(msg: any) => void> = [];
    private postedMessages: any[] = [];
    options: any = {};
    cspSource: string = 'mock-csp';

    onDidReceiveMessage(listener: (msg: any) => void): { dispose: () => void } {
        this.messageListeners.push(listener);
        // Automatically send 'ready' message to simulate webview initialization
        // Use setImmediate-style delay so the listener is fully registered first
        Promise.resolve().then(() => listener({ type: 'ready' }));
        return { dispose: () => {
            const idx = this.messageListeners.indexOf(listener);
            if (idx >= 0) this.messageListeners.splice(idx, 1);
        }};
    }

    postMessage(message: any): Thenable<boolean> {
        this.postedMessages.push(message);
        return Promise.resolve(true);
    }

    /** Test helper: simulate a message from the webview. */
    _simulateMessage(msg: any): void {
        for (const listener of this.messageListeners) {
            listener(msg);
        }
    }

    /** Test helper: get all messages posted to webview. */
    _getPostedMessages(): any[] {
        return this.postedMessages;
    }

    /** Test helper: clear posted messages. */
    _clearPostedMessages(): void {
        this.postedMessages = [];
    }
}

export class MockWebviewPanel {
    webview: MockWebview;
    viewType: string;
    title: string;
    private disposeListeners: Array<() => void> = [];
    private _isDisposed = false;

    constructor(viewType: string = 'yamlGraph.editor', title: string = 'YAML Graph') {
        this.webview = new MockWebview();
        this.viewType = viewType;
        this.title = title;
    }

    onDidDispose(listener: () => void): { dispose: () => void } {
        this.disposeListeners.push(listener);
        return { dispose: () => {} };
    }

    dispose(): void {
        this._isDisposed = true;
        for (const listener of this.disposeListeners) {
            listener();
        }
    }

    /** Test helper: check if disposed. */
    _isAlive(): boolean {
        return !this._isDisposed;
    }
}

// ─── Cancellation Token ─────────────────────────────────────

export class CancellationTokenSource {
    token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    };
    cancel(): void {
        this.token.isCancellationRequested = true;
    }
    dispose(): void {}
}

// ─── Event Emitter ──────────────────────────────────────────

export class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];

    event = (listener: (e: T) => void): { dispose: () => void } => {
        this.listeners.push(listener);
        return { dispose: () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        }};
    };

    fire(data: T): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

// ─── Diagnostic ─────────────────────────────────────────────

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export class Diagnostic {
    range: Range;
    message: string;
    severity: DiagnosticSeverity;
    source?: string;

    constructor(range: Range, message: string, severity?: DiagnosticSeverity) {
        this.range = range;
        this.message = message;
        this.severity = severity ?? DiagnosticSeverity.Error;
    }
}

// ─── DiagnosticCollection ───────────────────────────────────

export class MockDiagnosticCollection {
    name: string;
    private entries = new Map<string, Diagnostic[]>();

    constructor(name: string = 'test') {
        this.name = name;
    }

    set(uri: Uri, diagnostics: Diagnostic[]): void {
        this.entries.set(uri.toString(), diagnostics);
    }

    get(uri: Uri): Diagnostic[] | undefined {
        return this.entries.get(uri.toString());
    }

    clear(): void {
        this.entries.clear();
    }

    dispose(): void {
        this.entries.clear();
    }

    /** Test helper: get all entries. */
    _getAllEntries(): Map<string, Diagnostic[]> {
        return this.entries;
    }
}

// ─── window namespace ───────────────────────────────────────

const _shownMessages: Array<{ type: string; message: string }> = [];
const _visibleTextEditors: MockTextEditor[] = [];

export const window = {
    showErrorMessage: (message: string, ..._items: string[]): Thenable<string | undefined> => {
        _shownMessages.push({ type: 'error', message });
        return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string, ..._items: string[]): Thenable<string | undefined> => {
        _shownMessages.push({ type: 'warning', message });
        return Promise.resolve(undefined);
    },
    showInformationMessage: (message: string, ..._items: string[]): Thenable<string | undefined> => {
        _shownMessages.push({ type: 'info', message });
        return Promise.resolve(undefined);
    },

    get visibleTextEditors(): MockTextEditor[] {
        return _visibleTextEditors;
    },

    createWebviewPanel: (
        viewType: string, title: string, _showOptions: any, _options?: any
    ): MockWebviewPanel => {
        return new MockWebviewPanel(viewType, title);
    },

    registerCustomEditorProvider: (
        _viewType: string, _provider: any, _options?: any
    ): { dispose: () => void } => {
        return { dispose: () => {} };
    },

    /** Test helper: get all shown messages. */
    _getShownMessages: () => _shownMessages,

    /** Test helper: clear shown messages. */
    _clearShownMessages: () => { _shownMessages.length = 0; },

    /** Test helper: set visible editors. */
    _setVisibleTextEditors: (editors: MockTextEditor[]) => {
        _visibleTextEditors.length = 0;
        _visibleTextEditors.push(...editors);
    },
};

// ─── workspace namespace ────────────────────────────────────

const _onDidChangeTextDocumentEmitter = new EventEmitter<any>();

export const workspace = {
    findFiles: async (_include: string, _exclude?: string): Promise<Uri[]> => {
        return [];
    },

    asRelativePath: (pathOrUri: string | Uri): string => {
        const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
        return p.replace(/^.*\//, '');
    },

    applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => {
        return true;
    },

    onDidChangeTextDocument: _onDidChangeTextDocumentEmitter.event,

    getConfiguration: (_section?: string) => ({
        get: (_key: string, defaultValue?: any) => defaultValue,
        has: (_key: string) => false,
        update: async () => {},
    }),

    /** Test helper: fire a text document change event. */
    _fireDidChangeTextDocument: (e: any) => {
        _onDidChangeTextDocumentEmitter.fire(e);
    },
};

// ─── languages namespace ────────────────────────────────────

export const languages = {
    createDiagnosticCollection: (name?: string): MockDiagnosticCollection => {
        return new MockDiagnosticCollection(name);
    },
};

// ─── commands namespace ────────────────────────────────────

export const commands = {
    registerCommand: (_command: string, _callback: (...args: any[]) => any): { dispose: () => void } => {
        return { dispose: () => {} };
    },
    executeCommand: async <T>(_command: string, ..._rest: any[]): Promise<T | undefined> => {
        return undefined;
    },
};

// ─── ViewColumn ─────────────────────────────────────────────

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3,
}

// ─── ExtensionContext (minimal mock) ────────────────────────

export class MockExtensionContext {
    subscriptions: Array<{ dispose: () => void }> = [];
    extensionPath: string = '/mock/extension/path';
    extensionUri: Uri = Uri.file('/mock/extension/path');
    globalState = {
        get: (_key: string) => undefined,
        update: async (_key: string, _value: any) => {},
        keys: () => [] as string[],
    };
    workspaceState = {
        get: (_key: string) => undefined,
        update: async (_key: string, _value: any) => {},
        keys: () => [] as string[],
    };
}

// ─── Reset all mocks (for test isolation) ───────────────────

/**
 * Reset all mock state. Call this in beforeEach() for clean test isolation.
 */
export function _resetAllMocks(): void {
    window._clearShownMessages();
    window._setVisibleTextEditors([]);
}
