/**
 * A minimal host for the MD Browser's page that is not VS Code: one plain
 * HTML file a browser (or a JSDOM, or an application's webview) opens.
 *
 * The file is the page itself (`media/markdownBrowser/index.html`, composed by
 * utils/mdBrowserPage.ts) with its files loaded from a folder by URL — the
 * extension folder's `media/` and the vendored `marked`, `mermaid` and
 * codicons — and, ahead of every page script, a host script that:
 *
 *   - publishes the host object `window.__tomVscodeApi` (`postMessage`,
 *     `getState`, `setState`), so the page never asks for VS Code's;
 *   - logs every message the page posts: in `window.__tomHostMessages`, on the
 *     console, and in a small list at the bottom of the page;
 *   - answers `webviewReady` with the fixture document as an `mdContent`
 *     message, the way a host answers;
 *   - declares the protocol version and its capabilities in `window.__INIT__`
 *     (utils/mdBrowserProtocol.ts).
 *
 * The page's styles read the editor's theme variables (`--vscode-*`); a host
 * that is not the editor defines the ones it wants, as this one does with a
 * small dark set ({@link MD_BROWSER_TEST_HOST_THEME}).
 *
 * It shows that the page loads, renders a document and reports ready without
 * VS Code (`scripts/md-browser-test-host.cjs` writes the file; the test
 * mdBrowserTestHost.dom.test.ts opens it). It is a probe, not a product: it
 * answers nothing but `webviewReady`.
 *
 * `fs`, `path` and `url` only; no `vscode`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { getDocumentPickerCss, getDocumentPickerHtml, getDocumentPickerScript } from './documentPicker';
import { renderMdBrowserPage } from '../utils/mdBrowserPage';
import { MD_BROWSER_CAPABILITIES, MD_BROWSER_PICKER_PREFIX, mdBrowserInit } from '../utils/mdBrowserProtocol';

/** The document the test host shows when none is given. */
export const MD_BROWSER_TEST_FIXTURE = [
    '# The MD Browser outside VS Code',
    '',
    'This page is `media/markdownBrowser/index.html`, shown by a plain HTML host.',
    '',
    '## What the host does',
    '',
    '- publishes `window.__tomVscodeApi`',
    '- answers `webviewReady` with this document',
    '- logs the messages the page posts',
    '',
    '| Message | Direction |',
    '| --- | --- |',
    '| `webviewReady` | page → host |',
    '| `mdContent` | host → page |',
    '',
].join('\n');

/** The theme variables the test host defines: enough for the page to read as it does in a dark editor. */
export const MD_BROWSER_TEST_HOST_THEME = `:root {
    --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: Menlo, Consolas, monospace;
    --vscode-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-editor-background: #1f1f1f;
    --vscode-editor-foreground: #cccccc;
    --vscode-sideBar-background: #181818;
    --vscode-panel-border: #2b2b2b;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-dropdown-background: #313131;
    --vscode-dropdown-foreground: #cccccc;
    --vscode-dropdown-border: #3c3c3c;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-textLink-foreground: #4daafc;
    --vscode-textCodeBlock-background: #2b2b2b;
    --vscode-textBlockQuote-background: #2b2b2b;
    --vscode-textBlockQuote-border: #616161;
    --vscode-focusBorder: #0078d4;
}
body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }`;

export interface MdBrowserTestHostOptions {
    /** The folder holding `media/` and `node_modules/` (the extension folder). */
    extensionRoot: string;
    /** The Markdown the host answers `webviewReady` with. Default: {@link MD_BROWSER_TEST_FIXTURE}. */
    document?: string;
    /** The path the document is shown under. Default `fixture.md`. */
    documentPath?: string;
    /** Also give the document as first-paint data (`window.__INIT__.content`). Default false. */
    firstPaint?: boolean;
    /**
     * The capabilities this host declares (doc/md_browser_page_protocol.md). Default: every one — the page
     * then shows all its controls, although this host answers none of their messages; declare fewer to see
     * the page without them.
     */
    capabilities?: readonly string[];
}

/** The host script: the host object, the message log, the answer to `webviewReady`. Runs before the page's scripts. */
export function mdBrowserTestHostScript(content: Record<string, unknown>): string {
    return `(function () {
    var messages = [];
    var state = {};
    window.__tomHostMessages = messages;
    function show(msg) {
        var list = document.getElementById('tomHostLog');
        if (!list && document.body) {
            list = document.createElement('ol');
            list.id = 'tomHostLog';
            list.setAttribute('style', 'position:fixed;right:8px;bottom:8px;max-height:30vh;max-width:40vw;overflow:auto;margin:0;padding:6px 6px 6px 28px;font:11px monospace;background:#1e1e1e;color:#d4d4d4;border:1px solid #555;z-index:99999;');
            document.body.appendChild(list);
        }
        if (!list) { return; }
        var item = document.createElement('li');
        item.textContent = JSON.stringify(msg);
        list.appendChild(item);
    }
    var content = ${JSON.stringify(content).replace(/</g, '\\u003c')};
    window.__tomVscodeApi = {
        postMessage: function (msg) {
            messages.push(msg);
            if (window.console && console.log) { console.log('[md-browser host] page posted', JSON.stringify(msg)); }
            show(msg);
            // The one thing this host answers: the page is ready, here is the document.
            if (msg && msg.type === 'webviewReady') {
                setTimeout(function () { window.postMessage(content, '*'); }, 0);
            }
        },
        getState: function () { return state; },
        setState: function (next) { state = next || {}; return state; },
    };
})();`;
}

/**
 * The test host's page: the MD Browser's page with its files loaded from
 * `extensionRoot` by `file:` URL and the host script first.
 */
export function buildMdBrowserTestHostHtml(options: MdBrowserTestHostOptions): string {
    const root = path.resolve(options.extensionRoot);
    const url = (...parts: string[]): string => pathToFileURL(path.join(root, ...parts)).toString();
    const documentPath = options.documentPath ?? 'fixture.md';
    const content = {
        type: 'mdContent',
        content: options.document ?? MD_BROWSER_TEST_FIXTURE,
        filePath: documentPath,
        relativePath: documentPath,
        fileName: path.basename(documentPath),
        liveMode: false,
        crlf: false,
        lineMap: null,
    };
    const picker = { idPrefix: MD_BROWSER_PICKER_PREFIX, allowOtherFile: true, showGroupSelector: true };
    const page = renderMdBrowserPage(fs.readFileSync(path.join(root, 'media', 'markdownBrowser', 'index.html'), 'utf8'), {
        cspSource: 'file:',
        nonce: 'md-browser-test-host',
        baseUri: url('media', 'markdownBrowser'),
        sharedUri: url('media', 'shared'),
        markedUri: url('node_modules', 'marked', 'lib', 'marked.umd.js'),
        mermaidUri: url('node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
        codiconsUri: url('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
        pickerHtml: getDocumentPickerHtml({ ...picker, groupLabel: 'Type:', fileLabel: 'File:' }),
        pickerCss: getDocumentPickerCss(),
        pickerScript: getDocumentPickerScript(picker),
        // The protocol's first-paint data: the version, the capabilities, the document when asked for.
        init: { ...mdBrowserInit(options.capabilities ?? MD_BROWSER_CAPABILITIES, options.firstPaint ? content : undefined) },
    });
    // The host script goes first in <head>: the host object exists before any page script runs.
    const host = `<style id="tomHostTheme">\n${MD_BROWSER_TEST_HOST_THEME}\n</style>\n    <script nonce="md-browser-test-host">\n${mdBrowserTestHostScript(content)}\n</script>`;
    return page.replace(/<head[^>]*>/i, (head) => `${head}\n    ${host}`);
}

/** Write the test host's page to `file` (its folder created); answers the file. */
export function writeMdBrowserTestHost(file: string, options: MdBrowserTestHostOptions): string {
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildMdBrowserTestHostHtml(options));
    return target;
}
