/**
 * The MD Browser's page, composed for whatever host shows it (BP-13 of the
 * webwork_redesign idea: the page is loadable outside VS Code).
 *
 * `media/markdownBrowser/index.html` names nothing of its host. Everything
 * host-specific is a `{{token}}` the host fills:
 *
 *   - where the page's own files are: `{{baseUri}}` (`media/markdownBrowser/`)
 *     and `{{sharedUri}}` (`media/shared/`);
 *   - the vendored libraries: `{{markedUri}}`, `{{mermaidUri}}`, `{{codiconsUri}}`;
 *   - what the content security policy admits: `{{cspSource}}`;
 *   - the document picker's three pieces (`{{pickerHtml}}`, `{{pickerCss}}`,
 *     `{{pickerScript}}`; handlers/documentPicker.ts, vscode-free);
 *   - optional first-paint data, `window.__INIT__` (`content`: an `mdContent`
 *     message the page renders before its first round trip).
 *
 * At run time the page talks to its host through one object,
 * `window.__tomVscodeApi` (`postMessage`, optional `getState` / `setState`);
 * in VS Code, where none is published, main.js takes `acquireVsCodeApi()`.
 *
 * {@link renderMdBrowserPage} fills the page's own tokens and hands the rest —
 * `{{cspSource}}`, `{{baseUri}}`, `{{sharedUri}}`, `window.__INIT__` — to the
 * webview loader's renderer (utils/webviewLoader.ts), which is how the VS Code
 * host supplies them. Another host calls the same function with its own
 * locations (handlers/mdBrowserTestHost.ts builds a plain HTML page that way).
 *
 * Pure: no `vscode`, no `fs`.
 */

import { renderWebviewHtml } from './webviewLoader';

/** What a host supplies beyond the loader's placeholders. */
export interface MdBrowserPageParts {
    /** URL of `marked` (the UMD build). */
    markedUri: string;
    /** URL of `mermaid` (the minified build). */
    mermaidUri: string;
    /** URL of the codicons stylesheet. */
    codiconsUri: string;
    /** The document picker's markup, styles and script (handlers/documentPicker.ts). */
    pickerHtml: string;
    pickerCss: string;
    pickerScript: string;
}

/** Everything a host supplies to show the page. */
export interface MdBrowserPageHost extends MdBrowserPageParts {
    /** What the page's content security policy admits its styles, scripts, fonts and images from. */
    cspSource: string;
    /** URL of `media/markdownBrowser/` (no trailing slash needed). */
    baseUri: string;
    /** URL of `media/shared/`. */
    sharedUri: string;
    /** A nonce for the page's scripts (the loader adds it to every script tag). */
    nonce: string;
    /** First-paint data, exposed as `window.__INIT__`; none when omitted. */
    init?: Record<string, unknown>;
}

/** The page's own tokens, in the order they are filled. */
export const MD_BROWSER_PAGE_TOKENS: ReadonlyArray<keyof MdBrowserPageParts> = ['codiconsUri', 'markedUri', 'mermaidUri', 'pickerHtml', 'pickerCss', 'pickerScript'];

/** `rawHtml` with the page's own tokens filled (the loader's placeholders are left for the loader). */
export function fillMdBrowserPageParts(rawHtml: string, parts: MdBrowserPageParts): string {
    let html = rawHtml;
    for (const token of MD_BROWSER_PAGE_TOKENS) {
        html = html.split(`{{${token}}}`).join(parts[token]);
    }
    return html;
}

/** The page for `host`: `media/markdownBrowser/index.html` (`rawHtml`) with every token filled. */
export function renderMdBrowserPage(rawHtml: string, host: MdBrowserPageHost): string {
    return renderWebviewHtml(fillMdBrowserPageParts(rawHtml, host), {
        cspSource: host.cspSource,
        nonce: host.nonce,
        baseUri: host.baseUri,
        sharedUri: host.sharedUri,
        ...(host.init !== undefined ? { init: host.init } : {}),
    });
}
