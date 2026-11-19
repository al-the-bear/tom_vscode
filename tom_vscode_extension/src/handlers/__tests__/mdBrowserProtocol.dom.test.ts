/**
 * The MD Browser page protocol as a versioned contract (01b_woneb2; doc/md_browser_page_protocol.md,
 * src/utils/mdBrowserProtocol.ts, media/markdownBrowser/main.js, src/handlers/markdownBrowser-handler.ts).
 *
 *   MP-1 the contract lists every message the page and the handler exchange: the names the page posts, the cases
 *        the handler answers, the names the handler posts and the page listens to — read from the code — are the
 *        names of the document's two tables and of the protocol module, each with the same capability
 *   MP-2 the version and the capabilities are the same in the document, the module and the page
 *   MP-3 capabilities: a host declaring no assists sees no assist controls (and with them, it does); a host
 *        declaring none has no edit mode, no review buttons, no team, no picker, no back / forward, and the page
 *        posts nothing but `webviewReady`; a link into the document is still followed
 *   MP-4 a host of another version is refused by the page with a visible message; a page of another version is
 *        refused by the handler with a visible message
 *   MP-5 the editor's host declares the version and every capability; a page given no protocol data (an
 *        embedding page of the same build) has every capability
 */

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
    MD_BROWSER_CAPABILITIES, MD_BROWSER_HOST_MESSAGES, MD_BROWSER_PAGE_MESSAGES, MD_BROWSER_PICKER_PREFIX, MD_BROWSER_PROTOCOL_VERSION,
    mdBrowserInit, mdBrowserVersionProblem,
} from '../../utils/mdBrowserProtocol.js';
import { buildMdBrowserTestHostHtml } from '../mdBrowserTestHost.js';
import { getDocumentPickerScript } from '../documentPicker.js';

const EXT = path.resolve(__dirname, '..', '..', '..');
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(EXT, '..', '..', '..', 'ztmp', 'vscode_extension_261119_01b_woneb2_protocol-')));
after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });
const read = (...p: string[]): string => fs.readFileSync(path.join(EXT, ...p), 'utf8');
const DOC = read('doc', 'md_browser_page_protocol.md');
const HANDLER = read('src', 'handlers', 'markdownBrowser-handler.ts');
const PAGE_FILES = [['media', 'markdownBrowser', 'main.js'], ['media', 'markdownBrowser', 'askBar.js'], ['media', 'shared', 'assistOverlay.js'], ['media', 'shared', 'mdOverlay.js']];
const PICKER = getDocumentPickerScript({ idPrefix: MD_BROWSER_PICKER_PREFIX, allowOtherFile: true, showGroupSelector: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = any;
const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();
const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].flatMap((m) => m.slice(1).filter(Boolean));

/** The rows of the table under heading `title` of the contract: message name → capability. */
function table(title: string): Map<string, string> {
    const start = DOC.indexOf(`## ${title}`);
    assert.ok(start >= 0, title);
    const next = DOC.indexOf('\n## ', start + 4);
    const rows = new Map<string, string>();
    for (const line of DOC.slice(start, next < 0 ? undefined : next).split('\n')) {
        const m = /^\| `(\w+)` \| ([\w]+) \|/.exec(line);
        if (m) { rows.set(m[1], m[2]); }
    }
    return rows;
}

let files = 0;
async function open(html: string): Promise<{ w: Win; close(): void }> {
    const file = path.join(SANDBOX, `host-${++files}.html`);
    fs.writeFileSync(file, html);
    const dom = await JSDOM.fromFile(file, { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = dom.window as Win;
    await new Promise<void>((resolve) => { if (w.document.readyState === 'complete') { resolve(); } else { w.addEventListener('load', () => resolve()); } });
    return { w, close: () => w.close() };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !done(); i++) { await sleep(50); }
}
const types = (w: Win): string[] => Array.from(w.__tomHostMessages as Win[], (m) => String(m.type));

const QUESTION_DOC = [
    '# A review',
    '',
    'Jump to [the end](#the-end).',
    '',
    '> **❓ Q-1 — the colour:** Which colour?',
    '> - (a) red',
    '> - **(b)** blue',
    '>',
    '> **Answer:**',
    '',
    'Some {++added++} text.',
    '',
    '## The end',
    '',
    'Done.',
    '',
].join('\n');

describe('the MD Browser page protocol', () => {
    test('MP-1: the contract lists every message of the code', () => {
        // Page → host, as the page's scripts post them (the picker's included).
        const posted = new Set<string>();
        for (const f of PAGE_FILES) {
            const text = read(...f);
            for (const n of all(text, /(?:postMessage|post)\(\{\s*type:\s*'(\w+)'/g)) { posted.add(n); }
            // A type chosen between two, and a message built before it is posted.
            for (const n of all(text, /type:\s*[^,\n]*\?\s*'(\w+)'\s*:\s*'(\w+)'/g)) { posted.add(n); }
            for (const n of all(text, /var message = \{\s*type:\s*'(\w+)'/g)) { posted.add(n); }
        }
        for (const n of all(PICKER, /postMessage\(\{\s*type:\s*'(\w+)'/g)) { posted.add(n); }
        // … and as the handler answers them.
        const handle = HANDLER.slice(HANDLER.indexOf('private async _handleMessage('), HANDLER.indexOf('// Panel singletons'));
        const cases = new Set([...all(handle, /case '(\w+)':/g), ...all(handle, /case PICKER_PREFIX \+ '(\w+)':/g).map((n) => MD_BROWSER_PICKER_PREFIX + n)]);
        const pageRows = table('4. Page → host messages');
        // One message the handler answers is not sent by this page: the picker's groups come unasked (the contract says so).
        assert.deepEqual(sorted(cases).filter((n) => !posted.has(n)), ['mdBrowserGetGroups']);
        assert.deepEqual(sorted(posted).filter((n) => !cases.has(n)), [], 'the handler answers everything the page posts');
        assert.match(DOC, /\| `mdBrowserGetGroups` \| navigation \| — \| Answers `mdBrowserGroups`\. The page of this version does not send it/);
        assert.deepEqual(sorted(pageRows.keys()), sorted(cases), 'the document lists every page → host message, and no other');
        assert.deepEqual(sorted(Object.keys(MD_BROWSER_PAGE_MESSAGES)), sorted(cases), 'so does the module');
        assert.equal(cases.size, 25);
        for (const [name, capability] of pageRows) { assert.equal(capability, MD_BROWSER_PAGE_MESSAGES[name], `${name}: the document's capability is the module's`); }

        // Host → page, as the handler posts them and the page listens.
        const sent = new Set([...all(HANDLER, /type: '(\w+)'/g), ...all(HANDLER, /type: PICKER_PREFIX \+ '(\w+)'/g).map((n) => MD_BROWSER_PICKER_PREFIX + n)]);
        const heard = new Set<string>();
        for (const f of PAGE_FILES) { for (const n of all(read(...f), /msg\.type === '(\w+)'/g)) { heard.add(n); } }
        for (const n of all(PICKER, /msg\.type === '(\w+)'/g)) { heard.add(n); }
        const hostRows = table('5. Host → page messages');
        assert.deepEqual(sorted(sent), sorted(heard), 'the handler posts exactly what the page listens to');
        assert.deepEqual(sorted(hostRows.keys()), sorted(sent), 'the document lists every host → page message, and no other');
        assert.deepEqual(sorted(Object.keys(MD_BROWSER_HOST_MESSAGES)), sorted(sent));
        assert.equal(sent.size, 15);
        for (const [name, capability] of hostRows) { assert.equal(capability, MD_BROWSER_HOST_MESSAGES[name], name); }

        // The capability table of § 3 names each message under its capability.
        const section = DOC.slice(DOC.indexOf('## 3. Capabilities'), DOC.indexOf('## 4. Page'));
        for (const row of section.split('\n').filter((l: string) => /^\| (`\w+`|\*\(core\)\*) \|/.test(l))) {
            const cells: string[] = row.split('|').map((c: string) => c.trim());
            const capability = cells[1] === '*(core)*' ? 'core' : cells[1].replace(/`/g, '');
            assert.deepEqual(sorted(all(cells[3], /`(\w+)`/g)), sorted(Object.keys(MD_BROWSER_PAGE_MESSAGES).filter((n) => MD_BROWSER_PAGE_MESSAGES[n] === capability)), `§ 3 ${capability}: page → host`);
            assert.deepEqual(sorted(all(cells[4], /`(\w+)`/g)), sorted(Object.keys(MD_BROWSER_HOST_MESSAGES).filter((n) => MD_BROWSER_HOST_MESSAGES[n] === capability)), `§ 3 ${capability}: host → page`);
        }
    });

    test('MP-2: one version, one set of capabilities', () => {
        assert.equal(Number(/\*\*Protocol version: (\d+)\*\*/.exec(DOC)?.[1]), MD_BROWSER_PROTOCOL_VERSION);
        const main = read('media', 'markdownBrowser', 'main.js');
        assert.equal(Number(/var MDB_PROTOCOL_VERSION = (\d+);/.exec(main)?.[1]), MD_BROWSER_PROTOCOL_VERSION);
        const pageCaps = /var MDB_CAPABILITIES = \[([^\]]+)\];/.exec(main)![1].split(',').map((c) => c.trim().replace(/'/g, ''));
        assert.deepEqual(pageCaps, [...MD_BROWSER_CAPABILITIES]);
        assert.match(DOC, /any of `editing`, `reviewMarks`, `teamReview`, `assists`, `askBar`, `navigation`/);
        // The page's capability-of-message table is the module's, without the core messages.
        const tableText = main.slice(main.indexOf('var MDB_MESSAGE_CAPABILITY = {'), main.indexOf('var mdbInit'));
        const pageTable = Object.fromEntries([...tableText.matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]));
        assert.deepEqual(pageTable, Object.fromEntries(Object.entries(MD_BROWSER_PAGE_MESSAGES).filter(([, c]) => c !== 'core')));
        // Each capability has its hiding rule.
        const css = read('media', 'markdownBrowser', 'style.css');
        for (const c of MD_BROWSER_CAPABILITIES) { assert.ok(css.includes(`body.mdb-no-${c} `), `style.css hides the controls of ${c}`); }
    });

    test('MP-3: a capability not declared has no controls and no messages', async (t) => {
        // Every capability: the question has its assist buttons.
        const full = await open(buildMdBrowserTestHostHtml({ extensionRoot: EXT, document: QUESTION_DOC }));
        t.after(() => full.close());
        await until(() => !!full.w.document.querySelector('#contentArea h1'));
        assert.deepEqual([...full.w.__mdbProtocol.capabilities], [...MD_BROWSER_CAPABILITIES]);
        assert.equal(full.w.document.querySelectorAll('.mdb-assist-btn').length, 2, 'Grill me and Explain in detail');
        assert.equal(full.w.document.body.className.includes('mdb-no-'), false);
        assert.equal(full.w.document.getElementById('editModeBtn').hidden, false);
        assert.ok(types(full.w).includes('editState'));

        // No assists: no assist controls; the rest is there.
        const noAssists = await open(buildMdBrowserTestHostHtml({ extensionRoot: EXT, document: QUESTION_DOC, capabilities: MD_BROWSER_CAPABILITIES.filter((c) => c !== 'assists') }));
        t.after(() => noAssists.close());
        await until(() => !!noAssists.w.document.querySelector('#contentArea h1'));
        assert.equal(noAssists.w.document.querySelectorAll('.mdb-assist-btn').length, 0, 'no assist controls');
        assert.ok(noAssists.w.document.body.classList.contains('mdb-no-assists'));
        assert.ok(noAssists.w.document.querySelector('.mdb-answer-btn'), 'the answer button is still there');
        assert.equal(noAssists.w.document.getElementById('editModeBtn').hidden, false);
        noAssists.w.__tomVscodeApi.postMessage({ type: 'assistQuestion', use: 'grillMe' });
        noAssists.w.__tomVscodeApi.postMessage({ type: 'assistCancel', id: 'x' });
        assert.equal(types(noAssists.w).some((x) => x.startsWith('assist')), false, 'and no assist message reaches the host');

        // No capability: a reader.
        const none = await open(buildMdBrowserTestHostHtml({ extensionRoot: EXT, document: QUESTION_DOC, capabilities: [] }));
        t.after(() => none.close());
        const d = none.w.document;
        await until(() => !!d.querySelector('#contentArea h1'));
        for (const c of MD_BROWSER_CAPABILITIES) { assert.ok(d.body.classList.contains(`mdb-no-${c}`), c); }
        for (const id of ['editModeBtn', 'acceptAllBtn', 'rejectAllBtn', 'teamReview', 'backBtn', 'forwardBtn', 'askBar']) { assert.equal(d.getElementById(id).hidden, true, id); }
        assert.equal(d.querySelector('.picker-area').hidden, true);
        assert.equal(d.querySelectorAll('.mdb-assist-btn').length, 0);
        assert.match(d.querySelector('#contentArea h1').textContent, /A review/, 'the document is rendered all the same');
        assert.ok(d.querySelector('#contentArea ins, #contentArea .mdb-rm'), 'and its marks are shown');
        // Whatever the page would post for a capability stays in the page.
        for (const type of Object.keys(MD_BROWSER_PAGE_MESSAGES).filter((n) => MD_BROWSER_PAGE_MESSAGES[n] !== 'core')) { none.w.__tomVscodeApi.postMessage({ type }); }
        none.w.__tomVscodeApi.postMessage({ type: 'reload' });
        none.w.__tomVscodeApi.postMessage({ type: 'somethingOfAnotherScript' });
        assert.deepEqual(types(none.w), ['webviewReady', 'reload', 'somethingOfAnotherScript'], 'core messages and unknown ones pass; nothing of a capability');
        // An ask bar the host sends although it declared none is not shown.
        none.w.postMessage({ type: 'askBar', bar: { requestId: 'r1', buttons: [{ id: 'ok', label: 'OK' }], keepFile: true } }, '*');
        await sleep(60);
        assert.equal(d.getElementById('askBar').hidden, true);
        // A link into the document is followed by the page itself; nothing is posted.
        const link = [...d.querySelectorAll('#contentArea a')].find((a: Win) => a.getAttribute('href') === '#the-end') as Win;
        assert.ok(link);
        link.dispatchEvent(new none.w.MouseEvent('click', { bubbles: true, cancelable: true }));
        assert.equal(types(none.w).includes('navigateLink'), false);
    });

    test('MP-4: another version is refused, visibly', async (t) => {
        // The page: a host of version 99.
        const html = buildMdBrowserTestHostHtml({ extensionRoot: EXT }).replace(`"protocolVersion":${MD_BROWSER_PROTOCOL_VERSION}`, '"protocolVersion":99');
        assert.match(html, /"protocolVersion":99/);
        const page = await open(html);
        t.after(() => page.close());
        await until(() => (page.w.__tomHostMessages ?? []).length > 0);
        const box = page.w.document.getElementById('mdbProtocolMismatch');
        assert.ok(box, 'a visible message');
        assert.equal(box.textContent, `The MD Browser page speaks protocol version ${MD_BROWSER_PROTOCOL_VERSION}, its host version 99. The page and its host come from different builds: install one build of both.`);
        assert.equal(page.w.document.getElementById('contentArea'), null, 'nothing else is shown');
        assert.deepEqual(JSON.parse(JSON.stringify(page.w.__tomHostMessages)), [{ type: 'webviewReady', protocolVersion: MD_BROWSER_PROTOCOL_VERSION }], 'the host is told the page\'s version');
        await sleep(100);
        assert.equal(page.w.document.querySelector('h1'), null, 'the host\'s document is not rendered');

        // The host: a page of another version.
        assert.equal(mdBrowserVersionProblem(MD_BROWSER_PROTOCOL_VERSION), undefined);
        assert.equal(mdBrowserVersionProblem(undefined), undefined, 'a page naming none is the host\'s own build');
        assert.match(mdBrowserVersionProblem(2, 1)!, /^The MD Browser page speaks protocol version 2, this host version 1\. /);
        assert.match(mdBrowserVersionProblem('1')!, /version 1, this host version 1/, 'a version is a number');
        const ready = HANDLER.slice(HANDLER.indexOf("case 'webviewReady': {"), HANDLER.indexOf("case PICKER_PREFIX + 'GetGroups':"));
        assert.match(ready, /const mismatch = mdBrowserVersionProblem\(msg\.protocolVersion\);\s*if \(mismatch\) \{\s*void this\._panel\.webview\.postMessage\(\{ type: 'mdContent', content: '', error: mismatch \}\);\s*void vscode\.window\.showErrorMessage\(`Markdown Browser: \$\{mismatch\}`\);\s*break;/);
        assert.ok(ready.indexOf('if (mismatch)') < ready.indexOf('this._webviewReady = true;'), 'refused before anything is sent');
        // The page shows an mdContent error in place of the document.
        const shown = await open(buildMdBrowserTestHostHtml({ extensionRoot: EXT }));
        t.after(() => shown.close());
        await until(() => !!shown.w.document.querySelector('#contentArea h1'));
        shown.w.postMessage({ type: 'mdContent', content: '', error: mdBrowserVersionProblem(2, 1) }, '*');
        await until(() => /protocol version 2/.test(shown.w.document.getElementById('contentArea').textContent));
        assert.match(shown.w.document.getElementById('contentArea').textContent, /The MD Browser page speaks protocol version 2, this host version 1/);
    });

    test('MP-5: the editor\'s host, and a page without protocol data', async (t) => {
        assert.deepEqual(mdBrowserInit(), { protocolVersion: MD_BROWSER_PROTOCOL_VERSION, capabilities: [...MD_BROWSER_CAPABILITIES] });
        assert.deepEqual(mdBrowserInit(['navigation', 'editing']).capabilities, ['editing', 'navigation'], 'in the protocol\'s order');
        assert.deepEqual(mdBrowserInit([], { type: 'mdContent' }), { protocolVersion: MD_BROWSER_PROTOCOL_VERSION, capabilities: [], content: { type: 'mdContent' } });
        assert.throws(() => mdBrowserInit(['editing', 'flying']), /Not a capability of the MD Browser page: flying/);
        const build = HANDLER.slice(HANDLER.indexOf('function buildHtml('));
        assert.match(build, /init: \{ \.\.\.mdBrowserInit\(\) \},/, 'the editor\'s host declares the version and every capability');
        // No protocol data at all (the QUEST NOTES side panel embeds the renderer so): every capability, no check.
        const html = buildMdBrowserTestHostHtml({ extensionRoot: EXT, document: QUESTION_DOC }).replace(/<script[^>]*>window\.__INIT__ = [^\n]*<\/script>\n?/, '');
        assert.doesNotMatch(html, /__INIT__ =/);
        const page = await open(html);
        t.after(() => page.close());
        await until(() => !!page.w.document.querySelector('#contentArea h1'));
        assert.deepEqual([...page.w.__mdbProtocol.capabilities], [...MD_BROWSER_CAPABILITIES]);
        assert.equal(page.w.document.querySelectorAll('.mdb-assist-btn').length, 2);
        assert.deepEqual(JSON.parse(JSON.stringify(page.w.__tomHostMessages[0])), { type: 'webviewReady', protocolVersion: MD_BROWSER_PROTOCOL_VERSION });
    });
});
