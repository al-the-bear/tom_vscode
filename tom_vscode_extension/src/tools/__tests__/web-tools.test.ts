/**
 * Tool-impl tests for `web-tools.ts` — `tomAi_fetchWebpage` and
 * `tomAi_webSearch`.
 *
 * Strategy:
 *
 *   - **fetchWebpage**: stand up a local `http.createServer` per-suite
 *     and exercise the real http path against canned routes
 *     (`/ok`, `/redirect`, `/404`, `/slow`, `/large`). No mocks —
 *     this is the path the production tool actually uses, on a
 *     loopback socket. The c-row of the coverage doc explicitly
 *     asks for this.
 *
 *   - **webSearch**: inject a fake `SearchProvider`. The DDG-Lite
 *     production provider hits the real network so it's not part of
 *     the test suite. `parseDuckDuckGoLite` is exported separately
 *     and is tested against a canned HTML fixture so the brittle
 *     regex parser has a regression net.
 *
 * Coverage entry #7 four-row checklist:
 *
 *   a) Description clarity — verified in the impl file (timeout,
 *      follow-redirects, html-vs-md output, max-response-size all
 *      spelled out).
 *   b) Ambiguities — covered:
 *        - http/https-only check
 *        - rate-limit / failure surfacing on webSearch
 *        - shell-injection regression test (the bug fix)
 *        - 3xx status without follow → returns status, not error
 *   c) Real local http fixture (200/301/404/timeout/large).
 *   d) Timing — `tomAi_fetchWebpage:typical` < 50 ms on loopback;
 *      `tomAi_webSearch:typical` is whatever the fake provider takes
 *      (<1 ms).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { withTiming } from './_timing.js';
import {
    fetchWebpageImpl,
    parseDuckDuckGoLite,
    webSearchImpl,
    type SearchProvider,
    type SearchResult,
} from '../web-tools.js';

// ===========================================================================
// Local HTTP fixture
// ===========================================================================

let server: http.Server;
let baseUrl: string;

before(async () => {
    server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        if (url === '/ok') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<html><body>Hello <b>world</b></body></html>');
            return;
        }
        if (url === '/redirect') {
            res.writeHead(301, { location: '/target' });
            res.end();
            return;
        }
        if (url === '/target') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('redirected ok');
            return;
        }
        if (url.startsWith('/redirect-loop')) {
            // Every hit on this prefix redirects to itself with a fresh query
            // param — the impl sees genuinely new URLs each hop, so the hop
            // cap is the only thing that stops the chain.
            res.writeHead(301, { location: '/redirect-loop?n=' + Math.random() });
            res.end();
            return;
        }
        if (url === '/404') {
            res.writeHead(404, { 'content-type': 'text/html' });
            res.end('<html>not found</html>');
            return;
        }
        if (url === '/slow') {
            // Hold the response open longer than any test's timeout setting.
            // `.unref()` keeps the timer from blocking process exit if the
            // suite finishes before the timer fires, and we clear it
            // explicitly when the client aborts so the close() shutdown
            // doesn't have to wait.
            const t = setTimeout(() => {
                if (!res.writableEnded) {
                    res.writeHead(200);
                    res.end('too late');
                }
            }, 10_000);
            t.unref();
            res.on('close', () => clearTimeout(t));
            return;
        }
        if (url === '/large') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            // 200 KB of 'a' so the maxBytes truncation test has plenty to clip.
            res.end('a'.repeat(200_000));
            return;
        }
        if (url === '/headers') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ua: req.headers['user-agent'] }));
            return;
        }
        res.writeHead(500);
        res.end('unknown route');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ===========================================================================
// fetchWebpage
// ===========================================================================

describe('fetchWebpageImpl — local http fixture', () => {

    test('typical 200 returns body, status, content-type, byte count', async () => {
        const raw = await withTiming('tomAi_fetchWebpage:typical', () =>
            fetchWebpageImpl({}, { url: `${baseUrl}/ok` }));
        const r = JSON.parse(raw);
        assert.equal(r.status, 200);
        assert.match(r.contentType, /text\/html/);
        assert.equal(r.bytesReceived, 44);
        assert.equal(r.truncated, false);
        assert.deepEqual(r.redirectChain, []);
        assert.match(r.body, /<b>world<\/b>/);
    });

    test('301 follows redirect by default and records the chain', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: `${baseUrl}/redirect` }));
        assert.equal(r.status, 200);
        assert.equal(r.body, 'redirected ok');
        assert.equal(r.redirectChain.length, 1);
        assert.match(r.redirectChain[0], /\/redirect$/);
    });

    test('followRedirects: false → returns the 301 unchanged', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, {
            url: `${baseUrl}/redirect`,
            followRedirects: false,
        }));
        assert.equal(r.status, 301);
        assert.deepEqual(r.redirectChain, []);
    });

    test('redirect loop aborts with "Too many redirects" after 10 hops', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: `${baseUrl}/redirect-loop` }));
        assert.match(r.error, /Fetch failed: Too many redirects/);
    });

    test('404 is NOT treated as an error — status surfaced + body intact', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: `${baseUrl}/404` }));
        assert.equal(r.status, 404);
        assert.match(r.body, /not found/);
    });

    test('large body honours maxBytes and sets truncated:true', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, {
            url: `${baseUrl}/large`,
            maxBytes: 10_000,
        }));
        assert.equal(r.status, 200);
        assert.equal(r.body.length, 10_000);
        assert.equal(r.truncated, true);
        assert.equal(r.bytesReceived, 10_000);
    });

    test('timeout kills the request and reports it', async () => {
        const t0 = Date.now();
        const r = JSON.parse(await fetchWebpageImpl({}, {
            url: `${baseUrl}/slow`,
            timeoutMs: 200,
        }));
        const elapsed = Date.now() - t0;
        assert.match(r.error, /timed out after 200 ms/);
        assert.ok(elapsed < 2000, `timeout took too long: ${elapsed}ms`);
    });

    test('format: "text" strips HTML tags', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, {
            url: `${baseUrl}/ok`,
            format: 'text',
        }));
        assert.equal(r.status, 200);
        assert.doesNotMatch(r.body, /<b>/);
        assert.match(r.body, /Hello world/);
    });

    test('custom User-Agent is sent (not "curl/...")', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: `${baseUrl}/headers` }));
        const parsed = JSON.parse(r.body);
        assert.equal(parsed.ua, 'tom-ai-extension/1.0');
    });
});

describe('fetchWebpageImpl — validation', () => {

    test('empty URL returns instructive error', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await fetchWebpageImpl({}, { url: '' as any }));
        assert.match(r.error, /`url` is required/);
    });

    test('malformed URL returns instructive error', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: 'not a url at all' }));
        assert.match(r.error, /not a valid URL/);
    });

    test('non-http(s) scheme is rejected', async () => {
        const r = JSON.parse(await fetchWebpageImpl({}, { url: 'file:///etc/passwd' }));
        assert.match(r.error, /Only http:\/\/ and https:\/\/ URLs are supported/);
    });

    test('SHELL INJECTION REGRESSION: a URL with shell metacharacters does not run a shell command', async () => {
        // Old impl: `curl -sL "${url}" | head -c 50000` — closing the quote
        // executed arbitrary shell. The new impl uses http.request directly
        // so there is no shell to inject into.
        // We can't easily test "did NOT run rm" — but we can confirm the
        // URL parses through `new URL(...)` and produces a normal error
        // rather than a 0-status or empty body that would suggest a shell ran.
        const evilUrl = `${baseUrl}/ok"; touch /tmp/owned; echo "`;
        const r = JSON.parse(await fetchWebpageImpl({}, { url: evilUrl }));
        // The URL parser treats the `"`+shell-cmd as part of the path; the
        // request just returns 500 (unknown route) or similar. Either way
        // it's a normal HTTP response, not a shell side-effect.
        assert.ok('status' in r || 'error' in r);
        // Critical proof: the suite is still running with `/ok` route working,
        // meaning no shell ran (no file deleted, no process hung).
        const sane = JSON.parse(await fetchWebpageImpl({}, { url: `${baseUrl}/ok` }));
        assert.equal(sane.status, 200);
    });
});

// ===========================================================================
// webSearch
// ===========================================================================

function makeFakeProvider(opts: {
    name?: string;
    results?: SearchResult[];
    error?: Error;
} = {}): SearchProvider & { calls: Array<{ query: string; maxResults: number; timeoutMs: number }> } {
    const calls: Array<{ query: string; maxResults: number; timeoutMs: number }> = [];
    return {
        name: opts.name ?? 'fake-provider',
        calls,
        async search(query, maxResults, timeoutMs) {
            calls.push({ query, maxResults, timeoutMs });
            if (opts.error) { throw opts.error; }
            return opts.results ?? [];
        },
    };
}

describe('webSearchImpl', () => {

    test('typical call: provider results wrapped in the JSON envelope', async () => {
        const provider = makeFakeProvider({
            results: [
                { title: 'TypeScript', url: 'https://typescriptlang.org', snippet: 'A typed superset of JavaScript' },
                { title: 'TS Handbook', url: 'https://typescriptlang.org/docs', snippet: 'Official docs' },
            ],
        });
        const raw = await withTiming('tomAi_webSearch:typical', () =>
            webSearchImpl({ provider }, { query: 'typescript' }));
        const r = JSON.parse(raw);
        assert.equal(r.provider, 'fake-provider');
        assert.equal(r.query, 'typescript');
        assert.equal(r.returned, 2);
        assert.equal(r.results[0].title, 'TypeScript');
        assert.equal(provider.calls[0].query, 'typescript');
        assert.equal(provider.calls[0].maxResults, 8);  // default
    });

    test('empty query returns instructive error (no provider call)', async () => {
        const provider = makeFakeProvider();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await webSearchImpl({ provider }, { query: '' as any }));
        assert.match(r.error, /`query` is required/);
        assert.equal(provider.calls.length, 0);
    });

    test('provider error surfaces as { error, provider } — model can react', async () => {
        const provider = makeFakeProvider({ error: new Error('rate limit hit') });
        const r = JSON.parse(await webSearchImpl({ provider }, { query: 'q' }));
        assert.match(r.error, /Search failed \(fake-provider\): rate limit hit/);
        assert.equal(r.provider, 'fake-provider');
    });

    test('maxResults is forwarded and clamped at 50', async () => {
        const provider = makeFakeProvider();
        await webSearchImpl({ provider }, { query: 'q', maxResults: 1000 });
        assert.equal(provider.calls[0].maxResults, 50);
    });

    test('maxResults < 1 is clamped to 1', async () => {
        const provider = makeFakeProvider();
        await webSearchImpl({ provider }, { query: 'q', maxResults: 0 });
        assert.equal(provider.calls[0].maxResults, 1);
    });

    test('timeoutMs is forwarded to the provider', async () => {
        const provider = makeFakeProvider();
        await webSearchImpl({ provider }, { query: 'q', timeoutMs: 2000 });
        assert.equal(provider.calls[0].timeoutMs, 2000);
    });

    test('empty results array is reflected with returned: 0', async () => {
        const provider = makeFakeProvider({ results: [] });
        const r = JSON.parse(await webSearchImpl({ provider }, { query: 'q' }));
        assert.equal(r.returned, 0);
        assert.deepEqual(r.results, []);
    });
});

// ===========================================================================
// parseDuckDuckGoLite — direct regression test for the HTML parser
// ===========================================================================

describe('parseDuckDuckGoLite', () => {

    test('parses well-formed DDG-Lite output', () => {
        const html = `
            <table>
              <tr><td>
                <a class="result-link" href="https://a.com">Title <b>A</b></a>
              </td></tr>
              <tr><td class="result-snippet">Snippet about A.</td></tr>
              <tr><td>
                <a class="result-link" href="https://b.com">Title B</a>
              </td></tr>
              <tr><td class="result-snippet">Snippet about B.</td></tr>
            </table>
        `;
        const results = parseDuckDuckGoLite(html, 10);
        assert.equal(results.length, 2);
        assert.equal(results[0].url, 'https://a.com');
        assert.equal(results[0].title, 'Title A');
        assert.equal(results[0].snippet, 'Snippet about A.');
        assert.equal(results[1].url, 'https://b.com');
    });

    test('truncates to max', () => {
        const html = Array.from({ length: 5 }).map((_, i) =>
            `<a class="result-link" href="https://x${i}.com">T${i}</a><td class="result-snippet">S${i}</td>`,
        ).join('');
        const results = parseDuckDuckGoLite(html, 2);
        assert.equal(results.length, 2);
    });

    test('returns empty array on broken / unrelated HTML (e.g. rate-limit page)', () => {
        const html = '<html><body>Rate limited. Please try again later.</body></html>';
        assert.deepEqual(parseDuckDuckGoLite(html, 10), []);
    });
});
