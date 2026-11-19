/**
 * The MD Browser's page behind the host object (01b_woneb1; media/markdownBrowser/, src/utils/mdBrowserPage.ts,
 * src/handlers/mdBrowserTestHost.ts, scripts/md-browser-test-host.cjs).
 *
 *   MH-1 the page loads in a plain HTML host without VS Code: the test host's file, opened from disk in a JSDOM
 *        that runs its scripts and loads its files by URL (no `acquireVsCodeApi` anywhere), renders the fixture
 *        document and posts `webviewReady` to the host object; the host logs the messages
 *   MH-2 first-paint data: with `window.__INIT__.content` the document is rendered before the host answers
 *   MH-3 the page names VS Code in one place only: main.js takes `window.__tomVscodeApi || acquireVsCodeApi()`;
 *        the other page scripts and the document picker post through the published host object
 *   MH-4 the composer: the page's own tokens and the loader's placeholders are all filled by the host's values,
 *        nothing is left; `window.__INIT__` only when the host gives first-paint data
 *   MH-5 VS Code's host composes the page with the same function, through the webview loader's renderer
 *   MH-6 the script writes the host file
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { JSDOM, VirtualConsole } from 'jsdom';

import { MD_BROWSER_PAGE_TOKENS, fillMdBrowserPageParts, renderMdBrowserPage } from '../../utils/mdBrowserPage.js';
import { MD_BROWSER_TEST_FIXTURE, buildMdBrowserTestHostHtml, writeMdBrowserTestHost } from '../mdBrowserTestHost.js';
import { getDocumentPickerScript } from '../documentPicker.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_01b_woneb1_host-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const media = (...p: string[]): string => fs.readFileSync(path.join(EXT, 'media', ...p), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Open a host file as a browser would: its scripts run, its files load by URL. No VS Code API is provided. */
async function open(file: string): Promise<{ w: Win; logs: string[]; errors: string[]; close(): void }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('log', (...args: unknown[]) => logs.push(args.map(String).join(' ')));
    virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
    virtualConsole.on('jsdomError', (e: Error) => errors.push(String(e?.message ?? e)));
    const dom = await JSDOM.fromFile(file, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole });
    const w = dom.window as Win;
    await new Promise<void>((resolve) => { if (w.document.readyState === 'complete') { resolve(); } else { w.addEventListener('load', () => resolve()); } });
    return { w, logs, errors, close: () => w.close() };
}
/** Wait until `done()` holds (at most 5 s). */
async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !done(); i++) { await sleep(50); }
}

describe('the MD Browser page behind the host object', () => {
    test('MH-1: the page renders a document and reports ready in a plain HTML host', async (t) => {
        const file = writeMdBrowserTestHost(path.join(SANDBOX, 'host.html'), { extensionRoot: EXT });
        const html = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(html, /\{\{\w+\}\}/, 'every token is filled');
        assert.doesNotMatch(html, /vscode-(resource|webview)|acquireVsCodeApi/, 'the host page asks nothing of VS Code');
        const page = await open(file);
        t.after(() => page.close());
        const { w } = page;
        assert.equal(typeof w.acquireVsCodeApi, 'undefined', 'no VS Code here');
        await until(() => (w.__tomHostMessages ?? []).some((m: Win) => m.type === 'webviewReady') && !!w.document.querySelector('#contentArea h1'));
        const messages: Win[] = w.__tomHostMessages;
        assert.ok(messages.some((m) => m.type === 'webviewReady'), `the page posted webviewReady: ${JSON.stringify(messages)}`);
        assert.equal(messages[0].type, 'webviewReady', 'first');
        assert.equal(w.document.body.textContent.includes('MD Browser failed to initialize'), false, page.errors.join('\n'));
        // The fixture is rendered: its headings, list and table.
        const content = w.document.querySelector('#contentArea');
        assert.match(content.querySelector('h1').textContent, /The MD Browser outside VS Code/);
        assert.match(content.querySelector('h2').textContent, /What the host does/);
        assert.equal(content.querySelectorAll('li').length, 3);
        assert.equal(content.querySelectorAll('table tr').length, 3);
        assert.ok([...content.querySelectorAll('code')].some((c: Win) => c.textContent === 'window.__tomVscodeApi'));
        // The host logs what the page posts: in the list on the page and on the console.
        const logged = [...w.document.querySelectorAll('#tomHostLog li')].map((li: Win) => JSON.parse(li.textContent).type);
        assert.deepEqual(logged, JSON.parse(JSON.stringify(messages)).map((m: Win) => m.type));
        assert.ok(page.logs.some((l) => l.includes('[md-browser host] page posted {"type":"webviewReady","protocolVersion":1}')));
        // The page's state goes through the host object too.
        assert.deepEqual(JSON.parse(JSON.stringify(w.__tomVscodeApi.getState())), { filePath: 'fixture.md', liveMode: false });
        // The page's stylesheets and scripts came from the folder, by URL.
        assert.equal(typeof w.marked, 'object', 'the vendored marked loaded');
        assert.match(html, /<style id="tomHostTheme">[\s\S]*--vscode-editor-background:/, 'the host gives the theme variables the page\'s styles read');
        assert.ok([...w.document.querySelectorAll('link[rel="stylesheet"]')].every((l: Win) => String(l.href).startsWith('file://')));
    });

    test('MH-2: first-paint data', async (t) => {
        const doc = '# From the first paint\n\nNo round trip.\n';
        // A host that never answers: the document can only come from window.__INIT__.
        const html = buildMdBrowserTestHostHtml({ extensionRoot: EXT, document: doc, documentPath: 'notes/first.md', firstPaint: true })
            .replace("if (msg && msg.type === 'webviewReady') {", 'if (false) {');
        assert.match(html, /window\.__INIT__ = \{"protocolVersion":1,"capabilities":\[[^\]]+\],"content":\{"type":"mdContent","content":"# From the first paint/);
        const file = path.join(SANDBOX, 'first.html');
        fs.writeFileSync(file, html);
        const page = await open(file);
        t.after(() => page.close());
        await until(() => !!page.w.document.querySelector('#contentArea h1') && page.w.__tomHostMessages.length > 0);
        assert.equal(page.w.document.querySelector('#contentArea h1').textContent.trim(), 'From the first paint');
        assert.ok(page.w.__tomHostMessages.some((m: Win) => m.type === 'webviewReady'), 'and it still reports ready');
        // Without it the first-paint data holds the protocol's version and capabilities only.
        assert.match(buildMdBrowserTestHostHtml({ extensionRoot: EXT }), /window\.__INIT__ = \{"protocolVersion":1,"capabilities":\["editing","reviewMarks","teamReview","assists","askBar","navigation"\]\};/);
    });

    test('MH-3: VS Code is named in one place', () => {
        const main = media('markdownBrowser', 'main.js');
        const code = main.split('\n').filter((l) => !l.trim().startsWith('//'));
        assert.deepEqual(code.filter((l) => l.includes('acquireVsCodeApi')).map((l) => l.trim()), ['var vscode = window.__tomVscodeApi || acquireVsCodeApi();']);
        assert.match(main, /window\.__tomVscodeApi = vscode;/, 'published for the page\'s other scripts');
        assert.doesNotMatch(main, /window\.vscode\b/);
        for (const file of [['markdownBrowser', 'blocks.js'], ['markdownBrowser', 'teamReview.js'], ['markdownBrowser', 'askBar.js'], ['shared', 'mdQuestions.js'], ['shared', 'mdOverlay.js'], ['shared', 'assistOverlay.js']]) {
            const text = media(...file).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
            assert.doesNotMatch(text, /acquireVsCodeApi/, file.join('/'));
        }
        assert.match(media('markdownBrowser', 'askBar.js'), /if \(w\.__tomVscodeApi\) \{ w\.__tomVscodeApi\.postMessage\(msg\); \}/);
        assert.match(media('shared', 'assistOverlay.js'), /var api = w\.__tomVscodeApi \|\| w\.vscode;/);
        const html = media('markdownBrowser', 'index.html');
        // The markup: no VS Code API, resource scheme or command link. What remains are the theme variables
        // (`--vscode-*`), which the host's stylesheet defines.
        const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/var\(--vscode-[\w-]+\)/g, '');
        assert.doesNotMatch(markup, /vscode/i, 'the page\'s markup names no VS Code');
        // The picker: the published host object, else the panel's own handle (the @WS panel).
        const picker = getDocumentPickerScript({ idPrefix: 'mdBrowser', allowOtherFile: true, showGroupSelector: true });
        assert.match(picker, /function _mdBrowser_host\(\) \{ return window\.__tomVscodeApi \|\| vscode; \}/);
        assert.equal((picker.match(/_mdBrowser_host\(\)\.postMessage\(/g) ?? []).length, 8);
        assert.doesNotMatch(picker.replace(/function _mdBrowser_host\(\).*\n/, ''), /\bvscode\.postMessage/);
    });

    test('MH-4: the composer', () => {
        const raw = media('markdownBrowser', 'index.html');
        const tokens = [...new Set((raw.replace(/<!--[\s\S]*?-->/g, '').match(/\{\{\w+\}\}/g) ?? []))].sort();
        assert.deepEqual(tokens, ['{{baseUri}}', '{{codiconsUri}}', '{{cspSource}}', '{{markedUri}}', '{{mermaidUri}}', '{{pickerCss}}', '{{pickerHtml}}', '{{pickerScript}}', '{{sharedUri}}'], 'what a host supplies');
        assert.deepEqual([...MD_BROWSER_PAGE_TOKENS].sort(), ['codiconsUri', 'markedUri', 'mermaidUri', 'pickerCss', 'pickerHtml', 'pickerScript']);
        const parts = { markedUri: 'M', mermaidUri: 'R', codiconsUri: 'C', pickerHtml: '<i id="p"></i>', pickerCss: '.p{}', pickerScript: '/*p*/' };
        const filled = fillMdBrowserPageParts(raw, parts);
        assert.match(filled, /<script src="M"><\/script>\s*<script src="R"><\/script>/);
        assert.match(filled, /\{\{baseUri\}\}\/main\.js/, 'the loader\'s placeholders are left for the loader');
        const page = renderMdBrowserPage(raw, { ...parts, cspSource: 'https://host.example', baseUri: 'https://host.example/page/', sharedUri: 'https://host.example/shared', nonce: 'n1' });
        assert.doesNotMatch(page.replace(/<!--[\s\S]*?-->/g, ''), /\{\{\w+\}\}/);
        assert.match(page, /script-src https:\/\/host\.example 'unsafe-inline'/);
        assert.match(page, /<script src="https:\/\/host\.example\/page\/main\.js" nonce="n1"><\/script>/);
        assert.match(page, /<link href="https:\/\/host\.example\/shared\/mdOverlay\.css" rel="stylesheet" \/>/);
        assert.doesNotMatch(page, /__INIT__ =/);
        const withInit = renderMdBrowserPage(raw, { ...parts, cspSource: 'x', baseUri: 'b', sharedUri: 's', nonce: 'n1', init: { content: { type: 'mdContent', content: '</script>' } } });
        const at = withInit.indexOf('window.__INIT__ = {"content":{"type":"mdContent","content":"\\u003c/script>"}}');
        assert.ok(at > 0 && at < withInit.indexOf('b/main.js'), 'the first-paint data comes before main.js, safely serialised');
    });

    test('MH-5: VS Code\'s host', () => {
        const handler = fs.readFileSync(path.join(EXT, 'src', 'handlers', 'markdownBrowser-handler.ts'), 'utf8');
        const build = handler.slice(handler.indexOf('function buildHtml('));
        assert.match(build, /return renderMdBrowserPage\(readMediaText\('markdownBrowser', 'index\.html'\), \{\s*cspSource: webview\.cspSource,\s*nonce: generateNonce\(\),\s*baseUri: mediaUrl\('markdownBrowser'\),\s*sharedUri: mediaUrl\('shared'\),/);
        assert.doesNotMatch(build, /content/, 'VS Code gives no document at first paint: it sends it after webviewReady, as before');
        assert.match(fs.readFileSync(path.join(EXT, 'src', 'utils', 'mdBrowserPage.ts'), 'utf8'), /import \{ renderWebviewHtml \} from '\.\/webviewLoader';/);
        assert.equal(MD_BROWSER_TEST_FIXTURE.startsWith('# The MD Browser outside VS Code'), true);
    });

    test('MH-6: the script writes the host file', () => {
        const out = path.join(SANDBOX, 'cli', 'host.html');
        const doc = path.join(SANDBOX, 'doc.md');
        fs.writeFileSync(doc, '# A document of mine\n');
        const printed = execFileSync(process.execPath, [path.join(EXT, 'scripts', 'md-browser-test-host.cjs'), '--out', out, '--doc', doc], { encoding: 'utf8' });
        assert.match(printed, /MD Browser test host written: .*host\.html/);
        const html = fs.readFileSync(out, 'utf8');
        assert.match(html, /window\.__tomVscodeApi = \{/);
        assert.match(html, /"content":"# A document of mine\\n","filePath":"doc\.md"/);
        assert.throws(() => execFileSync(process.execPath, [path.join(EXT, 'scripts', 'md-browser-test-host.cjs')], { stdio: 'pipe' }), /usage: /);
    });
});
