/**
 * Tests for `webviewLoader.ts` — the single uniform webview asset loader
 * (Phase A.1 of the webview restructuring plan).
 *
 * Strategy: the pure {@link renderWebviewHtml} is exercised directly, and
 * {@link loadWebviewHtml} is driven through an injected, in-memory
 * `WebviewLoaderDeps` + a tiny fake webview — so the tests never touch the
 * real filesystem or `require('vscode')`.
 *
 * Coverage (per plan A.1.c):
 *   - placeholder substitution (the fixed set)
 *   - nonce uniqueness per load
 *   - `init` JSON injection (and `</script>` breakout safety)
 *   - unknown placeholder left untouched
 *   - missing-file error message
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    renderWebviewHtml,
    loadWebviewHtml,
    generateNonce,
    stripHtmlComments,
    type WebviewLike,
    type WebviewLoaderDeps,
} from '../webviewLoader.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A fake webview: `asWebviewUri` is irrelevant here (deps resolve URLs). */
const fakeWebview: WebviewLike = {
    cspSource: 'vscode-webview://test',
    asWebviewUri(uri) {
        return uri;
    },
};

/** Build injectable deps backed by an in-memory file map. */
function makeDeps(
    files: Record<string, string>,
    overrides: Partial<WebviewLoaderDeps> = {},
): WebviewLoaderDeps {
    let counter = 0;
    return {
        readMediaFile(panelId, file) {
            const key = `${panelId}/${file}`;
            const content = files[key];
            if (content === undefined) {
                throw new Error(`webviewLoader: media file not found: media/${key}`);
            }
            return content;
        },
        mediaDirUrl(_webview, dir) {
            return `https://webview.test/media/${dir}/`;
        },
        generateNonce() {
            counter += 1;
            return `nonce-${counter}`;
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// renderWebviewHtml — pure rewriting
// ---------------------------------------------------------------------------

describe('renderWebviewHtml — placeholder substitution', () => {
    test('substitutes the fixed placeholder set', () => {
        const raw =
            '<head></head><body>' +
            'csp={{cspSource}} nonce={{nonce}} base={{baseUri}} shared={{sharedUri}}' +
            '</body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'https://x/media/chatPanel/',
            sharedUri: 'https://x/media/shared/',
        });
        assert.match(out, /csp=CSP/);
        assert.match(out, /nonce=N1/);
        // Trailing slash stripped from the resolved dir URLs.
        assert.match(out, /base=https:\/\/x\/media\/chatPanel /);
        assert.match(out, /shared=https:\/\/x\/media\/shared</);
    });

    test('leaves unknown placeholders untouched', () => {
        const raw = '<head></head><body>{{unknownThing}} {{nonce}}</body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
        });
        assert.match(out, /\{\{unknownThing\}\}/);
        assert.match(out, /N1/);
    });
});

describe('renderWebviewHtml — CSP + nonce injection', () => {
    test('injects a CSP meta when none present', () => {
        const raw = '<head></head><body></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSPSRC',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
        });
        assert.match(out, /Content-Security-Policy/);
        assert.match(out, /script-src 'nonce-N1'/);
        assert.match(out, /CSPSRC/);
    });

    test('does not inject a second CSP when author wrote one', () => {
        const raw =
            '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head>' +
            '<body></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSPSRC',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
        });
        const count = (out.match(/Content-Security-Policy/g) ?? []).length;
        assert.equal(count, 1);
    });

    test('adds the nonce to scripts that lack one, preserves existing', () => {
        const raw =
            '<head></head><body>' +
            '<script src="./main.js"></script>' +
            '<script nonce="keep">x</script>' +
            '</body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N9',
            baseUri: 'b',
            sharedUri: 's',
        });
        assert.match(out, /<script src="\.\/main\.js" nonce="N9">/);
        assert.match(out, /<script nonce="keep">/);
        assert.doesNotMatch(out, /nonce="keep" nonce=/);
    });
});

describe('renderWebviewHtml — init injection', () => {
    test('injects window.__INIT__ before main.js', () => {
        const raw = '<head></head><body><script src="./main.js"></script></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
            init: { a: 1, b: 'hi' },
        });
        const initIdx = out.indexOf('window.__INIT__');
        const mainIdx = out.indexOf('main.js');
        assert.ok(initIdx >= 0, 'init script present');
        assert.ok(initIdx < mainIdx, 'init injected before main.js');
        assert.match(out, /window\.__INIT__ = \{"a":1,"b":"hi"\}/);
    });

    test('omits init script when no init given', () => {
        const raw = '<head></head><body><script src="./main.js"></script></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
        });
        assert.doesNotMatch(out, /window\.__INIT__/);
    });

    test('escapes </script> in init payload to prevent breakout', () => {
        const raw = '<head></head><body><script src="./main.js"></script></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
            init: { evil: '</script><script>alert(1)</script>' },
        });
        // The raw closing tag must not appear inside the init payload.
        assert.match(out, /\\u003c\/script>/);
        assert.doesNotMatch(out, /alert\(1\)<\/script><\/script>/);
    });

    test('falls back to before </body> when no main.js', () => {
        const raw = '<head></head><body>content</body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
            init: { x: 1 },
        });
        const initIdx = out.indexOf('window.__INIT__');
        const bodyClose = out.indexOf('</body>');
        assert.ok(initIdx >= 0 && initIdx < bodyClose, 'init before </body>');
    });
});

describe('renderWebviewHtml — extra assets', () => {
    test('links extra styles into head and injects extra scripts', () => {
        const raw = '<head></head><body><script src="./main.js"></script></body>';
        const out = renderWebviewHtml(raw, {
            cspSource: 'CSP',
            nonce: 'N1',
            baseUri: 'b',
            sharedUri: 's',
            extraStyleUrls: ['https://x/extra.css'],
            extraScriptUrls: ['https://x/lib.js'],
        });
        assert.match(out, /<link rel="stylesheet" href="https:\/\/x\/extra\.css">/);
        const libIdx = out.indexOf('lib.js');
        const mainIdx = out.indexOf('main.js');
        assert.ok(libIdx >= 0 && libIdx < mainIdx, 'extra script before main.js');
        // Injected lib script must also receive a nonce.
        assert.match(out, /<script src="https:\/\/x\/lib\.js" nonce="N1">/);
    });
});

// ---------------------------------------------------------------------------
// loadWebviewHtml — IO wrapper with injected deps
// ---------------------------------------------------------------------------

describe('loadWebviewHtml — IO wrapper', () => {
    test('reads index.html and applies the full rewrite', () => {
        const deps = makeDeps({
            'chatPanel/index.html':
                '<head></head><body>base={{baseUri}} <script src="./main.js"></script></body>',
        });
        const out = loadWebviewHtml(fakeWebview, 'chatPanel', { init: { ready: true } }, deps);
        assert.match(out, /base=https:\/\/webview\.test\/media\/chatPanel/);
        assert.match(out, /window\.__INIT__ = \{"ready":true\}/);
        assert.match(out, /Content-Security-Policy/);
        assert.match(out, /<script src="\.\/main\.js" nonce="nonce-1">/);
    });

    test('mints a unique nonce per load', () => {
        const deps = makeDeps({
            'p/index.html': '<head></head><body><script src="./main.js"></script></body>',
        });
        const a = loadWebviewHtml(fakeWebview, 'p', {}, deps);
        const b = loadWebviewHtml(fakeWebview, 'p', {}, deps);
        const nonceA = a.match(/nonce="(nonce-\d+)"/)?.[1];
        const nonceB = b.match(/nonce="(nonce-\d+)"/)?.[1];
        assert.ok(nonceA && nonceB);
        assert.notEqual(nonceA, nonceB);
    });

    test('throws a clear error when the media file is missing', () => {
        const deps = makeDeps({});
        assert.throws(
            () => loadWebviewHtml(fakeWebview, 'ghostPanel', {}, deps),
            /media file not found: media\/ghostPanel\/index\.html/,
        );
    });

    test('passes opts.styles / opts.scripts through as media-relative URLs', () => {
        const deps = makeDeps({
            'p/index.html': '<head></head><body><script src="./main.js"></script></body>',
        });
        const out = loadWebviewHtml(
            fakeWebview,
            'p',
            { styles: ['theme.css'], scripts: ['vendor.js'] },
            deps,
        );
        assert.match(out, /href="https:\/\/webview\.test\/media\/p\/theme\.css"/);
        assert.match(out, /src="https:\/\/webview\.test\/media\/p\/vendor\.js"/);
    });
});

// ---------------------------------------------------------------------------
// generateNonce
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// stripHtmlComments — guards the accordion/tab host shells against the
// "comment absorbs the {{css}}/{{script}} tokens" regression that left the
// @WS accordion rendering its escaped script source as visible page text.
// ---------------------------------------------------------------------------

describe('stripHtmlComments', () => {
    test('removes a leading shell comment that mentions placeholder tokens', () => {
        const shell =
            '<!--\n  Shell doc: substitutes {{css}} and {{script}} below.\n-->\n' +
            '<html><head><style>{{css}}</style></head>' +
            '<body><script>{{script}}</script></body></html>';
        const stripped = stripHtmlComments(shell);
        // The comment (and its token mentions) is gone; the real tokens remain.
        assert.doesNotMatch(stripped, /Shell doc/);
        assert.equal((stripped.match(/\{\{css\}\}/g) ?? []).length, 1);
        assert.equal((stripped.match(/\{\{script\}\}/g) ?? []).length, 1);
    });

    test('host substitution no longer leaks script into the doc comment', () => {
        // Reproduces the @WS bug: a literal token substitution over a shell
        // whose comment names the tokens. Without the strip, the comment's
        // {{script}} is filled too — and a `-->` inside the injected script
        // terminates the comment early, spilling script source as page text.
        const shell =
            '<!-- composes {{css}}, {{script}} -->\n' +
            '<style>{{css}}</style><body><script>{{script}}</script></body>';
        const css = '.a{color:red}';
        // Script body deliberately contains a decrement that reads as `-->`.
        const script = 'var i=10; while (i --> 0) {} var marker=1;';
        const tokens: Record<string, string> = { '{{css}}': css, '{{script}}': script };
        let html = stripHtmlComments(shell);
        for (const [t, v] of Object.entries(tokens)) {
            html = html.split(t).join(v);
        }
        // Script appears exactly once — only inside the real <script>, never
        // leaked into a (now-absent) comment.
        assert.equal((html.match(/var marker=1;/g) ?? []).length, 1);
        const scriptIdx = html.indexOf('var marker=1;');
        const styleClose = html.indexOf('</style>');
        assert.ok(scriptIdx > styleClose, 'script lands after </style>, not inside the head');
    });

    test('leaves comment-free templates untouched', () => {
        const raw = '<html><head></head><body>{{script}}</body></html>';
        assert.equal(stripHtmlComments(raw), raw);
    });
});

describe('generateNonce', () => {
    test('produces distinct values', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i += 1) {
            seen.add(generateNonce());
        }
        assert.equal(seen.size, 100);
    });
});
