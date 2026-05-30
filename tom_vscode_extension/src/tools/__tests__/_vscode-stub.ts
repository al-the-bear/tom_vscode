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
 * What this stub covers (per tool_test_coverage.md §0.1):
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
 *   - `EventEmitter`
 *   - `CancellationTokenSource`
 *   - `ProgressLocation` enum
 *
 * Any method a particular test cares about can be replaced via the
 * `overrides` parameter (deep-merged into the default stub).
 */

import Module from 'node:module';
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

export interface InstallOptions {
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

function applyOptions(state: InstallState, options: InstallOptions): void {
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
        private _emitter = new EventEmitter<void>();
        token = {
            get isCancellationRequested(): boolean { return src._cancelled; },
            onCancellationRequested: (listener: () => void): { dispose: () => void } => src._emitter.event(listener),
        };
        cancel(): void { this._cancelled = true; this._emitter.fire(); }
        dispose(): void { this._emitter.dispose(); }
        // Workaround — class field references self via outer scope binding.
        private _self = this;
    }
    // Workaround: TypeScript class field can't reference `this` in inner
    // object literal cleanly under target ES2015 — recapture below.
    // (Manually re-bind via `src` inside `.token`.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const src: any = CancellationTokenSource.prototype;

    const lmModels = options.lmModels ?? [];

    const stub: Record<string, unknown> = {
        workspace: {
            workspaceFolders: undefined as unknown,
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
            // Some tools call workspace.findFiles — best-effort empty result.
            findFiles: async (): Promise<unknown[]> => [],
            // applyEdit is exercised by language-service / workspace-edit tools.
            applyEdit: async (edit: unknown): Promise<boolean> => { record('workspace.applyEdit', [edit]); return true; },
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
            createWebviewPanel: (): Record<string, unknown> => ({ webview: { html: '', onDidReceiveMessage: new EventEmitter<unknown>().event } }),
            registerWebviewViewProvider: (): { dispose: () => void } => ({ dispose: () => undefined }),
            withProgress: async <T>(_opts: unknown, task: (progress: unknown, token: unknown) => Promise<T>): Promise<T> => {
                return task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
            },
        },
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
        EventEmitter,
        CancellationTokenSource,
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
        env: { sessionId: 'test-session', machineId: 'test-machine' },
    };

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
