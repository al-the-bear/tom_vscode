/**
 * Ambient typings for externalized webview JS (`media/<panelId>/*.js`).
 *
 * Webview scripts run in the VS Code webview sandbox, NOT the extension host,
 * so they must NOT pull in `@types/vscode`. This shim declares only the tiny
 * surface a webview client actually has:
 *   - `acquireVsCodeApi()` — the host bridge (may be called at most once).
 *   - `window.__INIT__`     — first-paint data injected by `webviewLoader`.
 *
 * Picked up by `tsconfig.media.json` (checkJs) so `// @ts-check`-headed media
 * JS typechecks against these without the extension-host types.
 */

/** The object returned by {@link acquireVsCodeApi}. */
interface VsCodeWebviewApi<TState = unknown> {
    /** Post a message to the extension host. */
    postMessage(message: unknown): void;
    /** Read the persisted webview state (survives hide/show). */
    getState(): TState | undefined;
    /** Persist webview state (survives hide/show). */
    setState(state: TState): void;
}

/**
 * Acquire the host bridge. The VS Code runtime allows this to be called at
 * most once per webview load.
 */
declare function acquireVsCodeApi<TState = unknown>(): VsCodeWebviewApi<TState>;

interface Window {
    /**
     * First-paint data injected by `webviewLoader.loadWebviewHtml({ init })`.
     * Undefined when the panel was rendered without an `init` payload.
     */
    __INIT__?: Record<string, unknown>;
}
