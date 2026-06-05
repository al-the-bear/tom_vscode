/**
 * webviewLoader — the single, uniform loader for externalized webview assets.
 *
 * Part of the Webview & Textarea Restructuring (quest `vscode_extension`,
 * Phase A.1). The goal is to stop embedding webview HTML/JS inside TypeScript
 * template literals (which forces hand-escaping of backticks / `${...}` and
 * hides the JS from ESLint/tsc). Instead each panel authors real
 * `media/<panelId>/index.html` + `main.js` + `style.css` files, and this
 * loader does *all* of the rewriting — CSP, nonce, `asWebviewUri`, and a
 * small fixed set of placeholders — in one place.
 *
 * ## The only rewriting that ever happens
 *
 * 1. A fixed, documented placeholder set is substituted (and nothing else):
 *      - `{{cspSource}}` → `webview.cspSource`
 *      - `{{nonce}}`     → fresh per-load nonce
 *      - `{{baseUri}}`   → `asWebviewUri(media/<panelId>/)`
 *      - `{{sharedUri}}` → `asWebviewUri(media/shared/)`
 *    Unknown `{{...}}` tokens are left untouched.
 * 2. A standard CSP `<meta>` is injected into `<head>` *iff* the document
 *    does not already declare one (authors may hand-write one using the
 *    placeholders above).
 * 3. Every `<script>` tag that lacks a `nonce` attribute gets the per-load
 *    nonce (so authors write clean `<script src="./main.js"></script>`).
 * 4. `window.__INIT__ = <JSON>` is injected as a nonce'd script immediately
 *    before the first `main.js` reference (or before `</body>` if none).
 *
 * Dynamic / per-render data does **not** go through string substitution — it
 * is passed via `init` (first paint) or `postMessage` (live updates). This
 * keeps the placeholder set tiny and the `.html` files lint-clean.
 *
 * ## Testability
 *
 * The pure rewriting is in {@link renderWebviewHtml} — no `vscode`, no `fs`.
 * {@link loadWebviewHtml} is the thin IO wrapper that reads the file, mints a
 * nonce and resolves URIs; its IO is injectable via the optional `deps`
 * argument so tests stay hermetic (and never `require('vscode')`).
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal webview surface the loader needs. */
export interface WebviewLike {
    /** The `Content-Security-Policy` source token for this webview. */
    readonly cspSource: string;
    /** Convert an on-disk URI into a webview-loadable URI. */
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

/** Options for {@link loadWebviewHtml}. */
export interface LoadWebviewHtmlOptions {
    /**
     * First-paint data. Serialized to JSON and exposed to the webview JS as
     * `window.__INIT__`. Live updates should use `postMessage`, not this.
     */
    init?: Record<string, unknown>;
    /**
     * Extra stylesheet file names under `media/<panelId>/` to `<link>` into
     * `<head>` (beyond whatever the `.html` already references). Default: none.
     */
    styles?: string[];
    /**
     * Extra script file names under `media/<panelId>/` to inject (beyond
     * whatever the `.html` already references). Each is added as a nonce'd
     * `<script src>` before the init payload. Default: none.
     */
    scripts?: string[];
}

/** Inputs to the pure {@link renderWebviewHtml} renderer. */
export interface RenderWebviewHtmlParams {
    /** `webview.cspSource`. */
    cspSource: string;
    /** Per-load nonce. */
    nonce: string;
    /** Resolved `media/<panelId>/` webview URI (string form). */
    baseUri: string;
    /** Resolved `media/shared/` webview URI (string form). */
    sharedUri: string;
    /** First-paint data, injected as `window.__INIT__`. */
    init?: Record<string, unknown>;
    /** Extra stylesheet URLs to `<link>` into `<head>`. */
    extraStyleUrls?: string[];
    /** Extra script URLs to inject as nonce'd `<script src>`. */
    extraScriptUrls?: string[];
}

/** Injectable IO for {@link loadWebviewHtml} (defaults hit fs + `vscode`). */
export interface WebviewLoaderDeps {
    /** Read `media/<panelId>/<file>` as UTF-8; throw a clear error if absent. */
    readMediaFile(panelId: string, file: string): string;
    /** Resolve a `media/<dir>/` directory to a webview URL string. */
    mediaDirUrl(webview: WebviewLike, dir: string): string;
    /** Mint a fresh nonce. */
    generateNonce(): string;
}

// ---------------------------------------------------------------------------
// Pure rendering (no vscode, no fs — unit-tested directly)
// ---------------------------------------------------------------------------

/** Generate a CSP-grade nonce. Exported for the default deps + reuse. */
export function generateNonce(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

/** Build the standard CSP `<meta>` tag content for a webview. */
export function buildCspMeta(cspSource: string, nonce: string): string {
    return (
        `<meta http-equiv="Content-Security-Policy" content="` +
        `default-src 'none'; ` +
        `img-src ${cspSource} https: data:; ` +
        `style-src ${cspSource} 'unsafe-inline'; ` +
        `font-src ${cspSource}; ` +
        `script-src 'nonce-${nonce}';">`
    );
}

/**
 * Rewrite a raw `index.html` into the final webview HTML.
 *
 * Pure: the same inputs always produce the same output. All fs/`vscode`
 * concerns live in {@link loadWebviewHtml}.
 */
export function renderWebviewHtml(rawHtml: string, params: RenderWebviewHtmlParams): string {
    const { cspSource, nonce, baseUri, sharedUri } = params;

    // 1. Fixed placeholder substitution. Unknown {{...}} tokens are untouched
    //    because they are simply not in this map.
    let html = substitutePlaceholders(rawHtml, {
        cspSource,
        nonce,
        baseUri: stripTrailingSlash(baseUri),
        sharedUri: stripTrailingSlash(sharedUri),
    });

    // 2. Inject the standard CSP <meta> unless the author already declared one.
    if (!/Content-Security-Policy/i.test(html)) {
        html = injectIntoHead(html, buildCspMeta(cspSource, nonce));
    }

    // 3. Inject any extra stylesheet <link>s into <head>.
    for (const url of params.extraStyleUrls ?? []) {
        html = injectIntoHead(html, `<link rel="stylesheet" href="${url}">`);
    }

    // 4. Inject any extra <script src> (before init payload) — nonce added in
    //    the blanket pass below.
    const extraScripts = (params.extraScriptUrls ?? [])
        .map((url) => `<script src="${url}"></script>`)
        .join('\n');

    // 5. Build the init payload script (always nonce'd here directly).
    const initScript = params.init !== undefined
        ? `<script nonce="${nonce}">window.__INIT__ = ${serializeInit(params.init)};</script>`
        : '';

    const preMain = [extraScripts, initScript].filter(Boolean).join('\n');
    if (preMain) {
        html = injectBeforeMainScript(html, preMain);
    }

    // 6. Blanket pass: every <script> tag without a nonce gets the nonce.
    html = addNonceToScripts(html, nonce);

    return html;
}

// ---------------------------------------------------------------------------
// IO wrapper
// ---------------------------------------------------------------------------

/**
 * Load `media/<panelId>/index.html`, rewrite it (see module docs) and return
 * the final HTML string to assign to `webview.html`.
 *
 * `deps` is injectable for tests; in production it defaults to a cached fs
 * reader, the real nonce generator and `webview.asWebviewUri`.
 */
export function loadWebviewHtml(
    webview: WebviewLike,
    panelId: string,
    opts: LoadWebviewHtmlOptions = {},
    deps: WebviewLoaderDeps = defaultDeps(),
): string {
    const rawHtml = deps.readMediaFile(panelId, 'index.html');
    const nonce = deps.generateNonce();
    const baseUri = deps.mediaDirUrl(webview, panelId);
    const sharedUri = deps.mediaDirUrl(webview, 'shared');

    const extraStyleUrls = (opts.styles ?? []).map((f) => `${stripTrailingSlash(baseUri)}/${f}`);
    const extraScriptUrls = (opts.scripts ?? []).map((f) => `${stripTrailingSlash(baseUri)}/${f}`);

    return renderWebviewHtml(rawHtml, {
        cspSource: webview.cspSource,
        nonce,
        baseUri,
        sharedUri,
        init: opts.init,
        extraStyleUrls,
        extraScriptUrls,
    });
}

// ---------------------------------------------------------------------------
// Default production IO (lazy `vscode` require — never hit when deps injected)
// ---------------------------------------------------------------------------

let cachedDeps: WebviewLoaderDeps | undefined;

function defaultDeps(): WebviewLoaderDeps {
    if (cachedDeps) {
        return cachedDeps;
    }
    // Lazy requires so tests that inject `deps` never pull in `vscode`/fs.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const vscodeMod = require('vscode') as typeof import('vscode');
    const { getExtensionPath } = require('../handlers/handler_shared') as {
        getExtensionPath(): string | undefined;
    };
    /* eslint-enable @typescript-eslint/no-var-requires */

    const fileCache = new Map<string, string>();

    cachedDeps = {
        readMediaFile(panelId: string, file: string): string {
            const extPath = getExtensionPath();
            if (!extPath) {
                throw new Error(
                    'webviewLoader: extension path not configured (setExtensionPath was never called)',
                );
            }
            const filePath = path.join(extPath, 'media', panelId, file);
            const cached = fileCache.get(filePath);
            if (cached !== undefined) {
                return cached;
            }
            let content: string;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                throw new Error(`webviewLoader: media file not found: ${filePath}`);
            }
            fileCache.set(filePath, content);
            return content;
        },
        mediaDirUrl(webview: WebviewLike, dir: string): string {
            const extPath = getExtensionPath();
            if (!extPath) {
                throw new Error(
                    'webviewLoader: extension path not configured (setExtensionPath was never called)',
                );
            }
            const onDisk = vscodeMod.Uri.file(path.join(extPath, 'media', dir));
            return webview.asWebviewUri(onDisk).toString();
        },
        generateNonce,
    };
    return cachedDeps;
}

/** Clear the production file cache. For tests / hot-reload only. */
export function clearWebviewLoaderCache(): void {
    cachedDeps = undefined;
}

/**
 * Read a raw `media/<panelId>/<file>` text asset (cached after first load),
 * WITHOUT any of the loader's HTML rewriting.
 *
 * This is the escape hatch for **accordion-hosted** panels that do not yet own
 * a full `index.html` rendered through {@link loadWebviewHtml} (the shared
 * accordion shell is migrated last — see the webview restructuring plan B.24).
 * Such panels author their own JS/CSS in `media/<panelId>/` files and feed the
 * text into `getAccordionHtml(...)`; this keeps the source lintable and free of
 * template-literal escaping while the shell stays inline. Prefer
 * {@link loadWebviewHtml} for any panel that can render a standalone document.
 */
export function readMediaText(panelId: string, file: string): string {
    return defaultDeps().readMediaFile(panelId, file);
}

/**
 * Strip HTML comments (`<!-- ... -->`) from a template shell.
 *
 * Why: the accordion/tab host shells carry a leading dev-doc comment that
 * mentions the `{{css}}` / `{{script}}` placeholder tokens verbatim. Those
 * hosts compose their shell with a *literal* token substitution
 * (`html.split(token).join(value)`), which also replaces the tokens **inside
 * the comment** — dumping the entire css+script blob there. The injected
 * script then contains a `-->` sequence that terminates the comment early,
 * spilling the rest of the (escaped) script source onto the page as visible
 * text and leaving the real body unrendered. Stripping comments from the shell
 * BEFORE substitution lets the dev docs reference the tokens freely without
 * leaking into the rendered output. Run on the raw template only, so injected
 * css/script (which may legitimately contain `<!--`/`-->`) is never affected.
 */
export function stripHtmlComments(html: string): string {
    return html.replace(/<!--[\s\S]*?-->/g, '');
}

// ---------------------------------------------------------------------------
// Internal string helpers (pure)
// ---------------------------------------------------------------------------

function substitutePlaceholders(html: string, values: Record<string, string>): string {
    return html.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
    });
}

function stripTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Serialize the init payload, escaping `</` so it can't break out of <script>. */
function serializeInit(init: Record<string, unknown>): string {
    return JSON.stringify(init).replace(/</g, '\\u003c');
}

function injectIntoHead(html: string, snippet: string): string {
    const headOpen = html.match(/<head[^>]*>/i);
    if (headOpen) {
        const idx = (headOpen.index ?? 0) + headOpen[0].length;
        return `${html.slice(0, idx)}\n${snippet}${html.slice(idx)}`;
    }
    // No <head> — fall back to prepending.
    return `${snippet}\n${html}`;
}

function injectBeforeMainScript(html: string, snippet: string): string {
    const mainScript = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*main\.js["'][^>]*>/i);
    if (mainScript) {
        const idx = mainScript.index ?? 0;
        return `${html.slice(0, idx)}${snippet}\n${html.slice(idx)}`;
    }
    const bodyClose = html.search(/<\/body>/i);
    if (bodyClose >= 0) {
        return `${html.slice(0, bodyClose)}${snippet}\n${html.slice(bodyClose)}`;
    }
    return `${html}\n${snippet}`;
}

function addNonceToScripts(html: string, nonce: string): string {
    return html.replace(/<script\b([^>]*)>/gi, (match, attrs: string) => {
        if (/\bnonce\s*=/.test(attrs)) {
            return match;
        }
        return `<script${attrs} nonce="${nonce}">`;
    });
}
