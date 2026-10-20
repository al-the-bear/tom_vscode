/**
 * Shared `vscode` (and related extension-only-module) stub for tool
 * tests. Replaces the inline `Module._resolveFilename` trick that used
 * to live at the top of every test file with a single helper:
 *
 *   import { installVscodeStub } from './_vscode-stub.js';
 *
 *   installVscodeStub({
 *       workspaceFolders: [tmpRoot],
 *       moduleOverrides: {
 *           '../managers/chatVariablesStore': {
 *               ChatVariablesStore: { instance: { quest: 'demo_quest' } },
 *           },
 *       },
 *   });
 *
 *   // Now safe to import tool modules that themselves require('vscode')
 *   import { listPromptPairsImpl } from '../prompt-history-tools.js';
 *
 * Two contracts matter:
 *
 *   1. **Install at module top-level** — before any `import` of a tool
 *      module that pulls in `vscode`. Tool modules read `vscode.workspace`
 *      at require-time in some cases; the stub must already be wired
 *      into `require.cache` by then.
 *   2. **Install once per test process** — `installVscodeStub` is
 *      idempotent within a process: the first call wires the
 *      `_resolveFilename` hook, every subsequent call just merges new
 *      overrides into the active stub. Returns a `spies` accessor + a
 *      `restore()` function that's safe to call multiple times.
 *
 * What this stub covers:
 *
 *   - `workspace.workspaceFolders` (configurable URI list)
 *   - `workspace.getConfiguration(section)` returning a chainable get()
 *   - `window.{showInformationMessage, showWarningMessage,
 *      showErrorMessage, createOutputChannel}` — record calls, return
 *      sensible defaults
 *   - `commands.executeCommand` — records (cmd, args) tuples
 *   - `languages.{getDiagnostics, registerCodeActionsProvider}`
 *   - `lm.{selectChatModels, tools, invokeTool}`
 *   - `Uri.file(p)` returning `{ fsPath, path, scheme }`
 *   - `workspace.findFiles(include, exclude, max, token)` — a real search with
 *     Node's `fs.globSync` under the RelativePattern's base (or the first
 *     workspace folder for a string), the exclude glob applied, files only
 *   - `workspace.asRelativePath(p)` — relative to the workspace folder holding it
 *   - `RelativePattern` + `workspace.createFileSystemWatcher` — every watcher
 *     is recorded and can be fired by hand from a test via
 *     `stubFileWatchers()`. Nothing fires on its own, which is exactly what
 *     makes the "native watcher never fires" case testable.
 *   - `workspace.textDocuments` (fake open documents built with
 *     `fakeTextDocument(fsPath, text, {isDirty, saveResult})`; `[]` by default),
 *     `Position`, `Range` and `WorkspaceEdit` (recording replace / insert /
 *     delete), and `workspace.applyEdit`, which applies an edit to the open fake
 *     documents (they become dirty) unless `applyEditResult` is false; every call
 *     is a spy, every applied edit is in `appliedEdits()`
 *   - `EventEmitter`
 *   - `CancellationTokenSource`
 *   - `ProgressLocation` enum
 *
 * Any method a particular test cares about can be replaced via the
 * `overrides` parameter (deep-merged into the default stub).
 */

/* eslint-disable @typescript-eslint/naming-convention -- the stub mirrors the vscode API's names (Uri, EventEmitter, ViewColumn.Active, …) and marks its test hooks with `__` */
import Module from 'node:module';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Recorded outgoing call. Inspect via `getSpies()` from tests. */
export interface SpyCall {
    /** Stub method name, e.g. `'window.showInformationMessage'`. */
    method: string;
    /** Positional args the caller passed. */
    args: unknown[];
}

export interface VscodeStubSpies {
    /** Every recorded call across the stub, in chronological order. */
    calls: SpyCall[];
    /** Filter by method name (prefix or exact match supported). */
    byMethod(methodOrPrefix: string): SpyCall[];
    /** Clear the recorded calls. Useful in `beforeEach`. */
    clear(): void;
}

/**
 * A `vscode.FileSystemWatcher` handed out by the stub. It never fires by
 * itself — the test decides when (and whether) an event arrives, so code that
 * must survive a watcher going silent can be exercised honestly.
 */
export interface StubFileWatcher {
    /** The `RelativePattern` (or glob string) the watcher was created with. */
    readonly pattern: unknown;
    /** Set by `dispose()`. */
    disposed: boolean;
    /** Deliver an `onDidChange` event to every registered listener. */
    fireChange(uri?: unknown): void;
    /** Deliver an `onDidCreate` event to every registered listener. */
    fireCreate(uri?: unknown): void;
    /** Deliver an `onDidDelete` event to every registered listener. */
    fireDelete(uri?: unknown): void;
}

// ---------------------------------------------------------------------------
// Editor pieces: positions, ranges, workspace edits, open documents
// ---------------------------------------------------------------------------

/** `vscode.Position`: 0-based line and character. */
export class StubPosition {
    constructor(readonly line: number, readonly character: number) {}
}

/** `vscode.Range`, from two positions or from four numbers. */
export class StubRange {
    readonly start: StubPosition;
    readonly end: StubPosition;
    constructor(a: StubPosition | number, b: StubPosition | number, c?: number, d?: number) {
        if (typeof a === 'number') {
            this.start = new StubPosition(a, b as number);
            this.end = new StubPosition(c ?? 0, d ?? 0);
        } else {
            this.start = a;
            this.end = b as StubPosition;
        }
    }
    get isEmpty(): boolean { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

/** One operation a `StubWorkspaceEdit` recorded. A `delete` has no text; an `insert` has a position, no range. */
export interface StubEditOp {
    kind: 'replace' | 'insert' | 'delete';
    uri: { fsPath: string };
    range?: StubRange;
    position?: StubPosition;
    text?: string;
}

/** `vscode.WorkspaceEdit`: records its text operations in order. */
export class StubWorkspaceEdit {
    readonly ops: StubEditOp[] = [];
    /** The file operations, in order; `workspace.applyEdit` carries them out on disk, as VS Code does. */
    readonly fileOps: StubFileOp[] = [];
    /** Notebook edits (`set(uri, NotebookEdit[])`); `workspace.applyEdit` carries them out on the `.ipynb` file. */
    readonly notebookOps: Array<{ uri: { fsPath: string }; edits: StubNotebookEdit[] }> = [];
    get size(): number { return this.ops.length + this.fileOps.length + this.notebookOps.length; }
    set(uri: { fsPath: string }, edits: StubNotebookEdit[]): void { this.notebookOps.push({ uri, edits }); }
    replace(uri: { fsPath: string }, range: StubRange, text: string): void { this.ops.push({ kind: 'replace', uri, range, text }); }
    insert(uri: { fsPath: string }, position: StubPosition, text: string): void { this.ops.push({ kind: 'insert', uri, position, text }); }
    delete(uri: { fsPath: string }, range: StubRange): void { this.ops.push({ kind: 'delete', uri, range }); }
    createFile(uri: { fsPath: string }, options: StubFileOp['options'] = {}): void { this.fileOps.push({ kind: 'create', uri, options }); }
    deleteFile(uri: { fsPath: string }, options: StubFileOp['options'] = {}): void { this.fileOps.push({ kind: 'delete', uri, options }); }
    renameFile(from: { fsPath: string }, to: { fsPath: string }, options: StubFileOp['options'] = {}): void { this.fileOps.push({ kind: 'rename', uri: from, to, options }); }
    /** The documents the edit touches, each once, as `[uri, edits]` like VS Code's. */
    entries(): Array<[{ fsPath: string }, StubEditOp[]]> {
        const byPath = new Map<string, [{ fsPath: string }, StubEditOp[]]>();
        for (const o of this.ops) {
            const entry = byPath.get(o.uri.fsPath) ?? [o.uri, []];
            entry[1].push(o);
            byPath.set(o.uri.fsPath, entry);
        }
        return [...byPath.values()];
    }
}

/** A file operation a `StubWorkspaceEdit` recorded. */
export interface StubFileOp {
    kind: 'create' | 'delete' | 'rename';
    uri: { fsPath: string };
    to?: { fsPath: string };
    options: { overwrite?: boolean; ignoreIfExists?: boolean; ignoreIfNotExists?: boolean };
}

/** `vscode.NotebookCellKind`. */
export const StubNotebookCellKind = { Markup: 1, Code: 2 } as const;

/** `vscode.NotebookCellData`. */
export class StubNotebookCellData {
    constructor(readonly kind: number, readonly value: string, readonly languageId: string) {}
}

/** `vscode.NotebookRange`: cells start (inclusive) to end (exclusive). */
export class StubNotebookRange {
    constructor(readonly start: number, readonly end: number) {}
}

/** One `vscode.NotebookEdit`: replace the cells in `range` by `cells` (an insert is an empty range). */
export class StubNotebookEdit {
    constructor(readonly range: StubNotebookRange, readonly cells: StubNotebookCellData[]) {}
    static insertCells(index: number, cells: StubNotebookCellData[]): StubNotebookEdit { return new StubNotebookEdit(new StubNotebookRange(index, index), cells); }
    static replaceCells(range: StubNotebookRange, cells: StubNotebookCellData[]): StubNotebookEdit { return new StubNotebookEdit(range, cells); }
    static deleteCells(range: StubNotebookRange): StubNotebookEdit { return new StubNotebookEdit(range, []); }
}

/** A notebook is its `.ipynb` file: read it, apply the cell edits in order, write it back. */
function applyNotebookOps(edit: StubWorkspaceEdit): void {
    for (const { uri, edits } of edit.notebookOps) {
        const nb = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as { cells: unknown[] };
        for (const e of edits) {
            const cells = e.cells.map((c) => ({
                cell_type: c.kind === StubNotebookCellKind.Markup ? 'markdown' : 'code',
                source: c.value,
                metadata: { language: c.languageId },
                ...(c.kind === StubNotebookCellKind.Markup ? {} : { outputs: [], execution_count: null }),
            }));
            nb.cells.splice(e.range.start, e.range.end - e.range.start, ...cells);
        }
        fs.writeFileSync(uri.fsPath, `${JSON.stringify(nb, null, 1)}\n`);
    }
}

/** Carry out an edit's file operations on disk; false (nothing more done) where VS Code would refuse one. */
function applyFileOps(edit: StubWorkspaceEdit): boolean {
    for (const op of edit.fileOps) {
        const at = op.uri.fsPath;
        if (op.kind === 'create') {
            if (fs.existsSync(at)) {
                if (op.options.ignoreIfExists) { continue; }
                if (!op.options.overwrite) { return false; }
            }
            fs.mkdirSync(path.dirname(at), { recursive: true });
            fs.writeFileSync(at, '');
        } else if (op.kind === 'delete') {
            if (!fs.existsSync(at)) { if (op.options.ignoreIfNotExists) { continue; } return false; }
            fs.rmSync(at, { recursive: true });
        } else {
            const to = op.to!.fsPath;
            if (fs.existsSync(to)) {
                if (op.options.ignoreIfExists) { continue; }
                if (!op.options.overwrite) { return false; }
            }
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(at, to);
        }
    }
    return true;
}

/** A fake `vscode.TextDocument` open in an editor. */
export interface FakeTextDocument {
    readonly uri: { fsPath: string; path: string; scheme: 'file'; toString(): string };
    readonly fileName: string;
    isDirty: boolean;
    /** How often `save()` was called. */
    saved: number;
    /** What `save()` answers. */
    saveResult: boolean;
    readonly lineCount: number;
    getText(range?: StubRange): string;
    positionAt(offset: number): StubPosition;
    offsetAt(position: StubPosition): number;
    /** Replaces the buffer (an applied edit uses this); marks it dirty. */
    setText(text: string): void;
    save(): Promise<boolean>;
}

/**
 * A fake open document over `text`. Offsets and positions convert across
 * lines as VS Code's do (an offset past the end is clamped); `save()` counts,
 * clears `isDirty` when it succeeds and answers `saveResult` (default true).
 * Put it into `workspace.textDocuments` with the `textDocuments` option or
 * `setTextDocuments()`.
 */
export function fakeTextDocument(fsPath: string, text: string, opts: { isDirty?: boolean; saveResult?: boolean } = {}): FakeTextDocument {
    let buffer = text;
    const lineStarts = (): number[] => {
        const starts = [0];
        for (let i = 0; i < buffer.length; i++) { if (buffer[i] === '\n') { starts.push(i + 1); } }
        return starts;
    };
    const doc: FakeTextDocument = {
        uri: fakeUri(fsPath),
        fileName: fsPath,
        isDirty: opts.isDirty ?? false,
        saved: 0,
        saveResult: opts.saveResult ?? true,
        get lineCount(): number { return lineStarts().length; },
        getText(range?: StubRange): string {
            return range ? buffer.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : buffer;
        },
        positionAt(offset: number): StubPosition {
            const at = Math.max(0, Math.min(offset, buffer.length));
            const starts = lineStarts();
            let line = 0;
            while (line + 1 < starts.length && starts[line + 1] <= at) { line++; }
            return new StubPosition(line, at - starts[line]);
        },
        offsetAt(position: StubPosition): number {
            const starts = lineStarts();
            if (position.line >= starts.length) { return buffer.length; }
            const lineEnd = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : buffer.length;
            return Math.min(starts[position.line] + position.character, lineEnd);
        },
        setText(next: string): void { buffer = next; doc.isDirty = true; },
        async save(): Promise<boolean> {
            doc.saved++;
            if (doc.saveResult) { doc.isDirty = false; }
            return doc.saveResult;
        },
    };
    return doc;
}

/**
 * Apply `edit`'s operations to the documents they name: an open fake document
 * in its buffer, a file nobody has open on disk (VS Code opens it, edits it and
 * saves it).
 */
function applyToDocuments(edit: StubWorkspaceEdit, docs: FakeTextDocument[]): void {
    const open = new Set(docs.map((d) => d.uri.fsPath));
    const onDisk = [...new Set(edit.ops.map((o) => o.uri.fsPath))].filter((p) => !open.has(p) && fs.existsSync(p));
    const diskDocs = onDisk.map((p) => fakeTextDocument(p, fs.readFileSync(p, 'utf8')));
    for (const doc of [...docs, ...diskDocs]) {
        const ops = edit.ops.filter((o) => o.uri.fsPath === doc.uri.fsPath);
        if (ops.length === 0) { continue; }
        // From the end backwards, so earlier offsets stay valid.
        const spans = ops.map((o) => {
            const start = doc.offsetAt(o.range ? o.range.start : o.position!);
            const end = o.range ? doc.offsetAt(o.range.end) : start;
            return { start, end, text: o.kind === 'delete' ? '' : (o.text ?? '') };
        }).sort((a, b) => b.start - a.start);
        let text = doc.getText();
        for (const s of spans) { text = text.slice(0, s.start) + s.text + text.slice(s.end); }
        doc.setText(text);
    }
    for (const doc of diskDocs) { fs.writeFileSync(doc.uri.fsPath, doc.getText()); }
}

export interface InstallOptions {
    /** `workspace.textDocuments`: the documents open in an editor. Default `[]`. */
    textDocuments?: FakeTextDocument[];
    /** What `workspace.applyEdit` answers; false refuses every edit (nothing applied). Default true. */
    applyEditResult?: boolean;
    /**
     * URI fsPath values for `workspace.workspaceFolders`. Pass an empty
     * array (or omit) for `undefined` (the unconfigured state).
     */
    workspaceFolders?: string[];
    /**
     * Section → key → value lookup for `workspace.getConfiguration(section).get(key)`.
     * Missing keys return `undefined` — caller's `?? default` fallback wins.
     */
    configuration?: Record<string, Record<string, unknown>>;
    /**
     * Returned by `commands.executeCommand` when the requested command id
     * has no recorded value here. Default: `undefined`.
     */
    commandResults?: Record<string, unknown>;
    /** Stubs for `vscode.lm.selectChatModels(...)`. */
    lmModels?: Array<{ id: string; vendor: string; family: string; name: string }>;
    /**
     * Map of `require('<path>')` requests to fake exports. The path is
     * the spec string passed to `require` — including the literal
     * extension if the importer uses `.js`. Both bare and dot-relative
     * shapes are supported; the resolver tries the exact string first.
     */
    moduleOverrides?: Record<string, unknown>;
    /**
     * Per-call hooks for individual stub methods. Each override
     * receives the args the caller passed. Useful when a test wants
     * to assert on the args and shape a specific return value.
     */
    methodOverrides?: Partial<{
        showInformationMessage: (...args: unknown[]) => unknown;
        showWarningMessage: (...args: unknown[]) => unknown;
        showErrorMessage: (...args: unknown[]) => unknown;
        createOutputChannel: (name: string) => unknown;
        executeCommand: (cmd: string, ...args: unknown[]) => unknown;
        getDiagnostics: (uri?: unknown) => unknown;
    }>;
}

// ---------------------------------------------------------------------------
// Singleton install state
// ---------------------------------------------------------------------------

interface InstallState {
    spies: VscodeStubSpies;
    stub: Record<string, unknown>;
    moduleOverrides: Map<string, unknown>;
    moduleStubIds: Map<string, string>;
    originalResolve: (request: string, parent: unknown) => string;
    options: InstallOptions;
}

const VSCODE_STUB_ID = '___vscode_stub_shared___';
let installed: InstallState | undefined;

/**
 * Install (or extend) the shared vscode stub. Safe to call multiple
 * times — subsequent calls merge new `moduleOverrides` and apply new
 * `workspaceFolders` / `configuration` / `commandResults` over the
 * existing stub.
 *
 * Returns a handle the caller can use to inspect call spies, mutate
 * the stub at runtime, or restore the original resolver (rarely
 * needed in test files; useful in test-of-the-stub itself).
 */
export function installVscodeStub(options: InstallOptions = {}): {
    spies: VscodeStubSpies;
    /** Read-only handle to the live stub object — mutate at your own risk. */
    stub: Record<string, unknown>;
    /** Add or replace an additional `require(spec)` override after install. */
    addModuleOverride(spec: string, exports: unknown): void;
    /** Update workspaceFolders after install. Useful between tests. */
    setWorkspaceFolders(absPaths: string[]): void;
    /** Replace `workspace.textDocuments`. */
    setTextDocuments(docs: FakeTextDocument[]): void;
    /** What `workspace.applyEdit` answers from now on. */
    setApplyEditResult(result: boolean): void;
    /** The edits `workspace.applyEdit` applied (accepted), oldest first. */
    appliedEdits(): StubWorkspaceEdit[];
    clearAppliedEdits(): void;
    /** Restore the original Module._resolveFilename. Idempotent. */
    restore(): void;
} {
    if (!installed) {
        installed = createInstallState(options);
        hookResolver(installed);
    } else {
        applyOptions(installed, options);
    }
    return makeHandle(installed);
}

/**
 * Every watcher created through `workspace.createFileSystemWatcher` since the
 * stub was installed, oldest first. Empty when the stub isn't installed.
 * Tests fire events on these by hand — see `StubFileWatcher`.
 */
export function stubFileWatchers(): StubFileWatcher[] {
    if (!installed) { return []; }
    return (installed.stub.workspace as { __fileWatchers?: StubFileWatcher[] }).__fileWatchers ?? [];
}

function createInstallState(options: InstallOptions): InstallState {
    const calls: SpyCall[] = [];
    const record = (method: string, args: unknown[]): void => { calls.push({ method, args }); };
    const stub = buildDefaultStub(record, options);
    return {
        spies: makeSpies(calls),
        stub,
        moduleOverrides: new Map(),
        moduleStubIds: new Map(),
        originalResolve: (Module as unknown as { _resolveFilename: (req: string, parent: unknown) => string })._resolveFilename,
        options,
    };
}

function hookResolver(state: InstallState): void {
    registerModule(VSCODE_STUB_ID, state.stub);
    const originalResolve = state.originalResolve;
    (Module as unknown as { _resolveFilename: (req: string, parent: unknown) => string })._resolveFilename = function (request: string, parent: unknown): string {
        if (request === 'vscode') { return VSCODE_STUB_ID; }
        const overrideId = state.moduleStubIds.get(request);
        if (overrideId) { return overrideId; }
        // Tolerate `.js` / non-`.js` variants — tools sometimes import
        // their siblings with the explicit extension, sometimes without.
        const altKey = request.endsWith('.js') ? request.slice(0, -3) : `${request}.js`;
        const altId = state.moduleStubIds.get(altKey);
        if (altId) { return altId; }
        return originalResolve.call(this, request, parent);
    };
    // Apply any module overrides given in the initial install call.
    if (state.options.moduleOverrides) {
        for (const [spec, exports] of Object.entries(state.options.moduleOverrides)) {
            addModuleOverrideToState(state, spec, exports);
        }
    }
}

/** The edit bookkeeping of a stub, kept beside it rather than on the vscode surface. */
interface EditState {
    applyEditResult: boolean;
    appliedEdits: StubWorkspaceEdit[];
}
const editStates = new WeakMap<object, EditState>();
const editStateOf = (stub: Record<string, unknown>): EditState => editStates.get(stub)!;

function applyOptions(state: InstallState, options: InstallOptions): void {
    if (options.textDocuments !== undefined) {
        (state.stub.workspace as Record<string, unknown>).textDocuments = options.textDocuments;
    }
    if (options.applyEditResult !== undefined) {
        editStateOf(state.stub).applyEditResult = options.applyEditResult;
    }
    if (options.workspaceFolders !== undefined) {
        applyWorkspaceFolders(state.stub, options.workspaceFolders);
    }
    if (options.configuration) {
        applyConfiguration(state.stub, options.configuration);
    }
    if (options.commandResults) {
        const cmdMap = state.stub['__commandResults'] as Map<string, unknown> | undefined;
        if (cmdMap) {
            for (const [k, v] of Object.entries(options.commandResults)) { cmdMap.set(k, v); }
        }
    }
    if (options.lmModels) {
        (state.stub.lm as { __models: unknown[] }).__models = options.lmModels;
    }
    if (options.moduleOverrides) {
        for (const [spec, exports] of Object.entries(options.moduleOverrides)) {
            addModuleOverrideToState(state, spec, exports);
        }
    }
    // methodOverrides applied on every install call (idempotent overwrite).
    if (options.methodOverrides) {
        const win = state.stub.window as Record<string, unknown>;
        const cmds = state.stub.commands as Record<string, unknown>;
        const langs = state.stub.languages as Record<string, unknown>;
        const o = options.methodOverrides;
        if (o.showInformationMessage) { win.showInformationMessage = o.showInformationMessage; }
        if (o.showWarningMessage) { win.showWarningMessage = o.showWarningMessage; }
        if (o.showErrorMessage) { win.showErrorMessage = o.showErrorMessage; }
        if (o.createOutputChannel) { win.createOutputChannel = o.createOutputChannel; }
        if (o.executeCommand) { cmds.executeCommand = o.executeCommand; }
        if (o.getDiagnostics) { langs.getDiagnostics = o.getDiagnostics; }
    }
}

function makeHandle(state: InstallState): ReturnType<typeof installVscodeStub> {
    return {
        spies: state.spies,
        stub: state.stub,
        addModuleOverride(spec: string, exports: unknown): void {
            addModuleOverrideToState(state, spec, exports);
        },
        setWorkspaceFolders(absPaths: string[]): void {
            applyWorkspaceFolders(state.stub, absPaths);
        },
        setTextDocuments(docs: FakeTextDocument[]): void {
            (state.stub.workspace as Record<string, unknown>).textDocuments = docs;
        },
        setApplyEditResult(result: boolean): void {
            editStateOf(state.stub).applyEditResult = result;
        },
        appliedEdits(): StubWorkspaceEdit[] {
            return editStateOf(state.stub).appliedEdits;
        },
        clearAppliedEdits(): void {
            editStateOf(state.stub).appliedEdits.length = 0;
        },
        restore(): void {
            if (!installed) { return; }
            (Module as unknown as { _resolveFilename: (req: string, parent: unknown) => string })._resolveFilename = state.originalResolve;
            delete require.cache[VSCODE_STUB_ID];
            for (const id of state.moduleStubIds.values()) { delete require.cache[id]; }
            installed = undefined;
        },
    };
}

function addModuleOverrideToState(state: InstallState, spec: string, exports: unknown): void {
    const id = `___vscode_stub_module_${state.moduleStubIds.size}___`;
    registerModule(id, exports);
    state.moduleOverrides.set(spec, exports);
    state.moduleStubIds.set(spec, id);
}

function registerModule(id: string, exports: unknown): void {
    require.cache[id] = {
        id,
        filename: id,
        loaded: true,
        exports,
        children: [],
        paths: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

// ---------------------------------------------------------------------------
// Default stub construction
// ---------------------------------------------------------------------------

function makeSpies(calls: SpyCall[]): VscodeStubSpies {
    return {
        calls,
        byMethod(methodOrPrefix: string): SpyCall[] {
            return calls.filter((c) => c.method === methodOrPrefix || c.method.startsWith(methodOrPrefix));
        },
        clear(): void { calls.length = 0; },
    };
}

/** Node 22+'s glob helpers (newer than the @types/node this package builds with). */
const nodeGlob = {
    globSync: (pattern: string, opts: { cwd: string }): string[] =>
        (fs as unknown as { globSync(p: string, o: { cwd: string }): string[] }).globSync(pattern, opts),
    matchesGlob: (p: string, glob: string): boolean =>
        (path as unknown as { matchesGlob(p: string, g: string): boolean }).matchesGlob(p, glob),
};

function fakeUri(p: string): { fsPath: string; path: string; scheme: 'file'; toString(): string } {
    return {
        fsPath: p,
        path: p,
        scheme: 'file',
        toString(): string { return `file://${p}`; },
    };
}

function applyWorkspaceFolders(stub: Record<string, unknown>, paths: string[]): void {
    const ws = stub.workspace as Record<string, unknown>;
    if (paths.length === 0) {
        ws.workspaceFolders = undefined;
        return;
    }
    ws.workspaceFolders = paths.map((p, idx) => ({
        uri: fakeUri(path.resolve(p)),
        name: path.basename(p) || `folder-${idx}`,
        index: idx,
    }));
}

function applyConfiguration(stub: Record<string, unknown>, cfg: Record<string, Record<string, unknown>>): void {
    const ws = stub.workspace as Record<string, unknown> & { __cfg?: Record<string, Record<string, unknown>> };
    ws.__cfg = cfg;
}

function buildDefaultStub(record: (method: string, args: unknown[]) => void, options: InstallOptions): Record<string, unknown> {
    // Pre-populate command-id → return value lookup. Tests can extend
    // this via the install options or override `executeCommand` outright.
    const commandResults = new Map<string, unknown>();
    if (options.commandResults) {
        for (const [k, v] of Object.entries(options.commandResults)) { commandResults.set(k, v); }
    }

    // Configuration store — read by `workspace.getConfiguration(section).get(key, defaultValue)`.
    const configStore = options.configuration ?? {};

    class EventEmitter<T> {
        private _listeners: Array<(e: T) => void> = [];
        event: (listener: (e: T) => void) => { dispose: () => void } = (listener) => {
            this._listeners.push(listener);
            return {
                dispose: (): void => {
                    const i = this._listeners.indexOf(listener);
                    if (i >= 0) { this._listeners.splice(i, 1); }
                },
            };
        };
        fire(data: T): void { for (const l of this._listeners) { try { l(data); } catch { /* swallow */ } } }
        dispose(): void { this._listeners = []; }
    }

    class CancellationTokenSource {
        private _cancelled = false;
        private readonly _emitter = new EventEmitter<void>();
        readonly token: { readonly isCancellationRequested: boolean; onCancellationRequested: (listener: () => void) => { dispose: () => void } };
        constructor() {
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const self = this;
            this.token = {
                get isCancellationRequested(): boolean { return self._cancelled; },
                onCancellationRequested: (listener: () => void): { dispose: () => void } => self._emitter.event(listener),
            };
        }
        cancel(): void {
            if (this._cancelled) { return; }
            this._cancelled = true;
            this._emitter.fire();
        }
        dispose(): void { this._emitter.dispose(); }
    }

    const lmModels = options.lmModels ?? [];

    // Watchers handed out by `createFileSystemWatcher`, in creation order.
    const fileWatchers: StubFileWatcher[] = [];

    function createFileSystemWatcher(pattern: unknown): Record<string, unknown> {
        record('workspace.createFileSystemWatcher', [pattern]);
        const change = new EventEmitter<unknown>();
        const create = new EventEmitter<unknown>();
        const del = new EventEmitter<unknown>();
        const watcher = {
            pattern,
            disposed: false,
            onDidChange: change.event,
            onDidCreate: create.event,
            onDidDelete: del.event,
            fireChange(uri?: unknown): void { change.fire(uri); },
            fireCreate(uri?: unknown): void { create.fire(uri); },
            fireDelete(uri?: unknown): void { del.fire(uri); },
            dispose(): void {
                watcher.disposed = true;
                change.dispose(); create.dispose(); del.dispose();
            },
        };
        fileWatchers.push(watcher as unknown as StubFileWatcher);
        return watcher;
    }

    const stub: Record<string, unknown> = {
        workspace: {
            workspaceFolders: undefined as unknown,
            createFileSystemWatcher,
            __fileWatchers: fileWatchers,
            getConfiguration(section: string) {
                record('workspace.getConfiguration', [section]);
                const sec = (configStore[section] ?? {}) as Record<string, unknown>;
                return {
                    get<T = unknown>(key: string, defaultValue?: T): T {
                        return (sec[key] as T | undefined) ?? (defaultValue as T);
                    },
                    has(key: string): boolean { return key in sec; },
                    inspect(): undefined { return undefined; },
                    update(): Promise<void> { return Promise.resolve(); },
                };
            },
            // Tools sometimes call workspace.fs.* — provide a minimal no-op.
            fs: {
                readFile: async (): Promise<Uint8Array> => new Uint8Array(),
                writeFile: async (): Promise<void> => undefined,
            },
            // A real search over the file system (Node's glob), so code that finds
            // files through it is tested against what it would find, not an empty answer.
            async findFiles(include: unknown, exclude?: unknown, maxResults?: number, token?: { isCancellationRequested: boolean }): Promise<unknown[]> {
                record('workspace.findFiles', [include, exclude, maxResults]);
                const rel = include as { base?: unknown; pattern?: string } | string;
                const baseOf = (b: unknown): string | undefined => typeof b === 'string' ? b : (b as { fsPath?: string } | undefined)?.fsPath;
                const folders = (stub.workspace as { workspaceFolders?: Array<{ uri: { fsPath: string } }> }).workspaceFolders;
                const base = typeof rel === 'string' ? folders?.[0]?.uri.fsPath : baseOf(rel.base);
                const pattern = typeof rel === 'string' ? rel : rel.pattern;
                if (!base || !pattern || token?.isCancellationRequested) { return []; }
                const out: unknown[] = [];
                for (const relPath of nodeGlob.globSync(pattern, { cwd: base })) {
                    if (typeof exclude === 'string' && nodeGlob.matchesGlob(relPath, exclude)) { continue; }
                    const abs = path.join(base, relPath);
                    try { if (!fs.statSync(abs).isFile()) { continue; } } catch { continue; }
                    out.push(fakeUri(abs));
                    if (maxResults !== undefined && out.length >= maxResults) { break; }
                }
                return out;
            },
            // As VS Code answers it: relative to the workspace folder that holds the path, else the path itself.
            asRelativePath(pathOrUri: unknown): string {
                const abs = typeof pathOrUri === 'string' ? pathOrUri : (pathOrUri as { fsPath?: string })?.fsPath ?? String(pathOrUri);
                const folders = (stub.workspace as { workspaceFolders?: Array<{ uri: { fsPath: string } }> }).workspaceFolders ?? [];
                for (const f of folders) {
                    const rel = path.relative(f.uri.fsPath, abs);
                    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { return rel.split(path.sep).join('/'); }
                }
                return abs;
            },
            // The open document if there is one, else the file read from disk (missing → rejects, as VS Code does).
            // A notebook document over its .ipynb file: the cell count is the file's.
            async openNotebookDocument(uri: { fsPath: string }): Promise<Record<string, unknown>> {
                if (!fs.existsSync(uri.fsPath)) { throw new Error(`cannot open ${uri.fsPath}: file not found`); }
                const nb = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')) as { cells?: unknown[] };
                return { uri, notebookType: 'jupyter-notebook', cellCount: (nb.cells ?? []).length };
            },
            async openTextDocument(arg: unknown): Promise<FakeTextDocument> {
                const fsPath = typeof arg === 'string' ? arg : (arg as { fsPath?: string })?.fsPath;
                if (!fsPath) { throw new Error('openTextDocument: untitled documents are not stubbed'); }
                const docs = (stub.workspace as { textDocuments: FakeTextDocument[] }).textDocuments;
                const openDoc = docs.find((d) => d.uri.fsPath === fsPath);
                if (openDoc) { return openDoc; }
                if (!fs.existsSync(fsPath)) { throw new Error(`cannot open ${fsPath}: file not found`); }
                return fakeTextDocument(fsPath, fs.readFileSync(fsPath, 'utf8'));
            },
            textDocuments: options.textDocuments ?? [],
            // Applies a StubWorkspaceEdit to the open fake documents, unless refused.
            async applyEdit(edit: unknown): Promise<boolean> {
                record('workspace.applyEdit', [edit]);
                const edits = editStateOf(stub);
                if (!edits.applyEditResult) { return false; }
                const docs = (stub.workspace as { textDocuments: FakeTextDocument[] }).textDocuments;
                if (edit instanceof StubWorkspaceEdit) {
                    if (!applyFileOps(edit)) { return false; }
                    applyNotebookOps(edit);
                    applyToDocuments(edit, docs);
                }
                edits.appliedEdits.push(edit as StubWorkspaceEdit);
                return true;
            },
            onDidChangeConfiguration: new EventEmitter<unknown>().event,
        },
        window: {
            showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
                record('window.showInformationMessage', [message, ...items]);
                return Promise.resolve(undefined);
            },
            showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
                record('window.showWarningMessage', [message, ...items]);
                return Promise.resolve(undefined);
            },
            showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
                record('window.showErrorMessage', [message, ...items]);
                return Promise.resolve(undefined);
            },
            createOutputChannel(name: string): Record<string, unknown> {
                record('window.createOutputChannel', [name]);
                return {
                    name,
                    append(): void {},
                    appendLine(): void {},
                    clear(): void {},
                    show(): void {},
                    hide(): void {},
                    dispose(): void {},
                };
            },
            // Common no-ops.
            showInputBox: async (opts?: unknown): Promise<unknown> => { record('window.showInputBox', [opts]); return undefined; },
            showQuickPick: async (items: unknown, opts?: unknown): Promise<unknown> => { record('window.showQuickPick', [items, opts]); return undefined; },
            activeTextEditor: undefined as unknown,
            visibleTextEditors: [] as unknown[],
            tabGroups: { all: [] as unknown[], onDidChangeTabs: new EventEmitter<unknown>().event },
            // A panel nobody sees: it takes HTML and messages, and dispose() fires onDidDispose.
            createWebviewPanel: (viewType: string, title: string): Record<string, unknown> => {
                record('window.createWebviewPanel', [viewType, title]);
                const disposed = new EventEmitter<void>();
                const panel: Record<string, unknown> = {
                    viewType, title, visible: true, active: true,
                    webview: {
                        html: '', options: {}, cspSource: 'vscode-resource:',
                        onDidReceiveMessage: new EventEmitter<unknown>().event,
                        postMessage: async (): Promise<boolean> => true,
                        asWebviewUri: (u: unknown): unknown => u,
                    },
                    onDidDispose: disposed.event,
                    onDidChangeViewState: new EventEmitter<unknown>().event,
                    reveal: (): void => undefined,
                    dispose: (): void => { panel.visible = false; disposed.fire(); },
                };
                return panel;
            },
            // A QuickPick nobody sees. The ones shown are listed in `window.__quickPicks`, so a
            // test answers one as a person would: pick an item and accept, or hide it.
            __quickPicks: [] as unknown[],
            createQuickPick: (): Record<string, unknown> => {
                const accept = new EventEmitter<void>();
                const hide = new EventEmitter<void>();
                const qp: Record<string, unknown> = {
                    items: [], selectedItems: [], activeItems: [], value: '', title: undefined, placeholder: undefined,
                    canSelectMany: false, matchOnDescription: false, ignoreFocusOut: false, visible: false,
                    onDidAccept: accept.event, onDidHide: hide.event,
                    onDidChangeValue: new EventEmitter<string>().event,
                    onDidChangeSelection: new EventEmitter<unknown>().event,
                    onDidChangeActive: new EventEmitter<unknown>().event,
                    show: (): void => { qp.visible = true; ((stub.window as Record<string, unknown>).__quickPicks as unknown[]).push(qp); },
                    hide: (): void => { if (qp.visible) { qp.visible = false; hide.fire(); } },
                    dispose: (): void => { if (qp.visible) { qp.visible = false; hide.fire(); } },
                    /** Test helper: select these items (default the first) and press Enter. */
                    __accept: (picked?: unknown[]): void => { qp.selectedItems = picked ?? (qp.items as unknown[]).slice(0, 1); accept.fire(); },
                };
                return qp;
            },
            registerWebviewViewProvider: (): { dispose: () => void } => ({ dispose: () => undefined }),
            // An editor nobody sees, over the document it was asked to show.
            showNotebookDocument: async (doc: unknown): Promise<Record<string, unknown>> => {
                record('window.showNotebookDocument', [doc]);
                return { notebook: doc };
            },
            showTextDocument: async (doc: unknown): Promise<Record<string, unknown>> => {
                record('window.showTextDocument', [doc]);
                const start = new StubPosition(0, 0);
                return { document: doc, selection: new StubRange(start, start), selections: [], revealRange: () => undefined, viewColumn: 1 };
            },
            // A status-bar item that shows nothing (the queue and timer keep one).
            createStatusBarItem: (): Record<string, unknown> => ({ text: '', tooltip: '', command: undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }),
            withProgress: async <T>(_opts: unknown, task: (progress: unknown, token: unknown) => Promise<T>): Promise<T> => {
                return task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
            },
        },
        // Tasks and debug sessions that end at once. A test lists its tasks in `tasks.__tasks` and sets
        // `tasks.__exitCode`; every run and every debug start is recorded (`tasks.__runs`, `debug.__starts`).
        tasks: (() => {
            const ended = new EventEmitter<{ execution: unknown; exitCode: number | undefined }>();
            const tasks: Record<string, unknown> = {
                __tasks: [] as unknown[], __runs: [] as unknown[], __exitCode: 0 as number | undefined,
                fetchTasks: async (): Promise<unknown[]> => tasks.__tasks as unknown[],
                executeTask: async (task: unknown): Promise<unknown> => {
                    const execution = { task };
                    (tasks.__runs as unknown[]).push(task);
                    setTimeout(() => ended.fire({ execution, exitCode: tasks.__exitCode as number | undefined }), 0);
                    return execution;
                },
                onDidEndTaskProcess: ended.event,
            };
            return tasks;
        })(),
        debug: (() => {
            const terminated = new EventEmitter<{ name: string; configuration: { name: string } }>();
            const debug: Record<string, unknown> = {
                __starts: [] as unknown[],
                startDebugging: async (folder: unknown, config: unknown): Promise<boolean> => {
                    (debug.__starts as unknown[]).push({ folder, config });
                    const name = typeof config === 'string' ? config : (config as { name?: string })?.name ?? '';
                    setTimeout(() => terminated.fire({ name, configuration: { name } }), 0);
                    return true;
                },
                onDidTerminateDebugSession: terminated.event,
            };
            return debug;
        })(),
        commands: {
            async executeCommand(cmd: string, ...args: unknown[]): Promise<unknown> {
                record('commands.executeCommand', [cmd, ...args]);
                return commandResults.has(cmd) ? commandResults.get(cmd) : undefined;
            },
            registerCommand: (): { dispose: () => void } => ({ dispose: () => undefined }),
            getCommands: async (): Promise<string[]> => [],
        },
        languages: {
            getDiagnostics(uri?: unknown): unknown[] {
                record('languages.getDiagnostics', uri === undefined ? [] : [uri]);
                return [];
            },
            registerCodeActionsProvider(): { dispose: () => void } {
                record('languages.registerCodeActionsProvider', []);
                return { dispose: () => undefined };
            },
            registerDocumentSymbolProvider: (): { dispose: () => void } => ({ dispose: () => undefined }),
        },
        lm: {
            __models: lmModels,
            async selectChatModels(_filter?: unknown): Promise<unknown[]> {
                record('lm.selectChatModels', _filter === undefined ? [] : [_filter]);
                return (stub.lm as { __models: unknown[] }).__models;
            },
            get tools(): unknown[] { record('lm.tools', []); return []; },
            async invokeTool(name: string, opts: unknown): Promise<unknown> {
                record('lm.invokeTool', [name, opts]);
                return { content: [] };
            },
        },
        Uri: {
            file: (p: string): ReturnType<typeof fakeUri> => fakeUri(p),
            parse: (s: string): ReturnType<typeof fakeUri> => fakeUri(s),
            joinPath: (base: ReturnType<typeof fakeUri>, ...parts: string[]): ReturnType<typeof fakeUri> => fakeUri(path.join(base.fsPath, ...parts)),
        },
        Position: StubPosition,
        Range: StubRange,
        WorkspaceEdit: StubWorkspaceEdit,
        RelativePattern: class {
            base: unknown;
            pattern: string;
            constructor(base: unknown, pattern: string) { this.base = base; this.pattern = pattern; }
        },
        Disposable: class {
            constructor(private readonly _fn: () => void) {}
            dispose(): void { this._fn(); }
        },
        EventEmitter,
        CancellationTokenSource,
        StatusBarAlignment: { Left: 1, Right: 2 },
        TaskScope: { Global: 1, Workspace: 2 },
        // vscode.SymbolKind, a numeric enum with its reverse mapping (SymbolKind[11] === 'Function').
        SymbolKind: Object.fromEntries(['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor',
            'Enum', 'Interface', 'Function', 'Variable', 'Constant'].flatMap((name, i) => [[name, i], [i, name]])),
        NotebookCellKind: StubNotebookCellKind,
        NotebookCellData: StubNotebookCellData,
        NotebookRange: StubNotebookRange,
        NotebookEdit: StubNotebookEdit,
        ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
        ProgressLocation: {
            SourceControl: 1,
            Window: 10,
            Notification: 15,
        },
        // Stub the rich types tools may reference. Each is a tag-only
        // class so `instanceof` works without exposing internals.
        LanguageModelTextPart: class { constructor(public value: string) {} },
        LanguageModelToolCallPart: class { constructor(public callId: string, public name: string, public input: unknown) {} },
        LanguageModelToolResultPart: class { constructor(public callId: string, public content: unknown[]) {} },
        LanguageModelChatMessage: {
            User: (parts: unknown[]): unknown => ({ role: 'user', content: parts }),
            Assistant: (parts: unknown[]): unknown => ({ role: 'assistant', content: parts }),
        },
        version: '1.0.0-test',
        UIKind: { Desktop: 1, Web: 2 },
        env: {
            sessionId: 'test-session',
            machineId: 'test-machine',
            appName: 'Visual Studio Code (test)',
            appHost: 'desktop',
            uiKind: 1,
        },
    };

    editStates.set(stub, { applyEditResult: options.applyEditResult ?? true, appliedEdits: [] });
    // Where a later install's `commandResults` are merged in (applyOptions).
    stub.__commandResults = commandResults;

    // Apply initial workspaceFolders + configuration shaping.
    if (options.workspaceFolders) { applyWorkspaceFolders(stub, options.workspaceFolders); }
    if (options.configuration) { applyConfiguration(stub, options.configuration); }

    // Apply method overrides.
    if (options.methodOverrides) {
        const win = stub.window as Record<string, unknown>;
        const cmds = stub.commands as Record<string, unknown>;
        const langs = stub.languages as Record<string, unknown>;
        const o = options.methodOverrides;
        if (o.showInformationMessage) { win.showInformationMessage = o.showInformationMessage; }
        if (o.showWarningMessage) { win.showWarningMessage = o.showWarningMessage; }
        if (o.showErrorMessage) { win.showErrorMessage = o.showErrorMessage; }
        if (o.createOutputChannel) { win.createOutputChannel = o.createOutputChannel; }
        if (o.executeCommand) { cmds.executeCommand = o.executeCommand; }
        if (o.getDiagnostics) { langs.getDiagnostics = o.getDiagnostics; }
    }

    return stub;
}
