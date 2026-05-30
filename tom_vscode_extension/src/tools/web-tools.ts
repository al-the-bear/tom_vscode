/**
 * Web tools — `tomAi_fetchWebpage` and `tomAi_webSearch`.
 *
 * Carved out of `tool-executors.ts` for coverage entry #7. Three
 * substantial changes beyond the usual `*Impl(deps, input)` pattern:
 *
 *   1. **fetchWebpage no longer shells out.** The previous impl
 *      interpolated the user URL into `curl -sL "${url}" | head -c 50000`
 *      with only a regex-style quote around it — a URL of the form
 *      `https://evil/"; rm -rf ~; #"` would close the quote and run
 *      arbitrary commands. Same class of bug `findTextInFiles` had
 *      and the same fix: use Node's built-in `http` / `https.request`
 *      directly so there is no shell on the path at all. As a
 *      bonus the impl now works on Windows (which doesn't ship `curl`
 *      by default).
 *
 *   2. **fetchWebpage surfaces the response shape**, not just the body.
 *      The response is JSON with `status`, `headers.content-type`,
 *      `bytesReceived`, `truncated`, and `redirectChain` so the LLM
 *      can tell a 404 from a 200, a redirect chain from a 200, and
 *      a truncated response from a complete one. `body` is the
 *      decoded text (with optional HTML→text stripping).
 *
 *   3. **webSearch is provider-agnostic.** The DDG-Lite fetcher is
 *      now one implementation of a `SearchProvider` interface; tests
 *      pass a fake provider and assert the formatter without touching
 *      the network. The fetcher itself is exported (`buildDuckDuckGoLiteProvider`)
 *      so swapping to a different engine later is a one-line change.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { SharedToolDefinition } from './shared-tool-registry';

// ===========================================================================
// fetchWebpage — http/https direct, no shell
// ===========================================================================

export interface FetchWebpageInput {
    url: string;
    /** Default 15000 ms. */
    timeoutMs?: number;
    /** Default 50_000 bytes. Hard max 5 MB. */
    maxBytes?: number;
    /** Default true. Capped at 10 hops. */
    followRedirects?: boolean;
    /** Default 'html' (raw body). 'text' strips HTML tags + collapses whitespace. */
    format?: 'html' | 'text';
}

export interface FetchedPage {
    status: number;
    contentType: string | undefined;
    bytesReceived: number;
    truncated: boolean;
    redirectChain: string[];
    body: string;
}

const FETCH_DEFAULT_TIMEOUT = 15_000;
const FETCH_DEFAULT_MAX_BYTES = 50_000;
const FETCH_MAX_REDIRECTS = 10;
const FETCH_HARD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Production deps — exposed so tests can inject a fake `request` that
 * doesn't touch the network. The default is `http`/`https` selected by
 * the URL scheme.
 */
export interface FetchDeps {
    request?: typeof https.request;  // http.request is type-compatible
}

export async function fetchWebpageImpl(deps: FetchDeps, input: FetchWebpageInput): Promise<string> {
    if (!input.url || typeof input.url !== 'string') {
        return JSON.stringify({ error: '`url` is required and must be a non-empty string.' });
    }
    let parsed: URL;
    try {
        parsed = new URL(input.url);
    } catch {
        return JSON.stringify({ error: `\`url\` is not a valid URL: ${input.url}` });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return JSON.stringify({ error: `Only http:// and https:// URLs are supported (got ${parsed.protocol}).` });
    }
    const timeoutMs = Math.max(100, input.timeoutMs ?? FETCH_DEFAULT_TIMEOUT);
    const maxBytes = clampBytes(input.maxBytes, FETCH_DEFAULT_MAX_BYTES);
    const followRedirects = input.followRedirects !== false;
    const format = input.format ?? 'html';

    let page: FetchedPage;
    try {
        page = await fetchOnce(parsed.toString(), { timeoutMs, maxBytes, followRedirects, deps });
    } catch (err) {
        return JSON.stringify({ error: `Fetch failed: ${(err as Error).message}` });
    }

    const body = format === 'text' ? stripHtml(page.body) : page.body;
    return JSON.stringify({
        status: page.status,
        contentType: page.contentType ?? null,
        bytesReceived: page.bytesReceived,
        truncated: page.truncated,
        redirectChain: page.redirectChain,
        body,
    });
}

interface FetchOnceOpts {
    timeoutMs: number;
    maxBytes: number;
    followRedirects: boolean;
    deps: FetchDeps;
}

function fetchOnce(targetUrl: string, opts: FetchOnceOpts, redirectChain: string[] = []): Promise<FetchedPage> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const isHttps = parsed.protocol === 'https:';
        const requester = opts.deps.request ?? (isHttps ? https.request : http.request);
        const req = requester(
            {
                method: 'GET',
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                headers: {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'User-Agent': 'tom-ai-extension/1.0',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    'Accept': '*/*',
                },
                timeout: opts.timeoutMs,
            },
            (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers.location;
                if (opts.followRedirects && status >= 300 && status < 400 && location) {
                    if (redirectChain.length >= FETCH_MAX_REDIRECTS) {
                        reject(new Error(`Too many redirects (max ${FETCH_MAX_REDIRECTS}); chain: ${redirectChain.join(' → ')}`));
                        res.resume();
                        return;
                    }
                    // Resolve relative redirects against the current URL.
                    const next = new URL(location, targetUrl).toString();
                    res.resume();
                    fetchOnce(next, opts, [...redirectChain, targetUrl]).then(resolve, reject);
                    return;
                }
                let collected = Buffer.alloc(0);
                let truncated = false;
                res.on('data', (chunk: Buffer) => {
                    if (truncated) { return; }
                    const remaining = opts.maxBytes - collected.length;
                    if (chunk.length <= remaining) {
                        collected = Buffer.concat([collected, chunk]);
                    } else {
                        collected = Buffer.concat([collected, chunk.slice(0, remaining)]);
                        truncated = true;
                        res.destroy();  // stop reading; we have enough.
                    }
                });
                res.on('end', () => {
                    resolve({
                        status,
                        contentType: res.headers['content-type'],
                        bytesReceived: collected.length,
                        truncated,
                        redirectChain,
                        body: collected.toString('utf8'),
                    });
                });
                res.on('error', reject);
                // `destroy()` triggers 'close' but the 'end' may not fire;
                // resolve from 'close' too when we cut the read short.
                res.on('close', () => {
                    if (truncated) {
                        resolve({
                            status,
                            contentType: res.headers['content-type'],
                            bytesReceived: collected.length,
                            truncated: true,
                            redirectChain,
                            body: collected.toString('utf8'),
                        });
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out after ${opts.timeoutMs} ms`));
        });
        req.end();
    });
}

function clampBytes(input: number | undefined, defaultBytes: number): number {
    const n = Number(input);
    if (!Number.isFinite(n) || n <= 0) { return defaultBytes; }
    return Math.min(Math.floor(n), FETCH_HARD_MAX_BYTES);
}

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Tool def
// ---------------------------------------------------------------------------

export const FETCH_WEBPAGE_DESCRIPTION =
    'Fetch the content of an http:// or https:// URL via Node\'s built-in ' +
    'http client (no shell, no curl dependency). The response is JSON ' +
    'with `status`, `contentType`, `bytesReceived`, `truncated`, ' +
    '`redirectChain`, and `body`. Redirects (3xx with Location) are ' +
    'followed by default — pass `followRedirects: false` to keep the ' +
    'first response. Default body cap is 50 000 bytes; pass `maxBytes` ' +
    'up to a 5 MB hard cap. Default timeout 15 000 ms. Pass `format: ' +
    '"text"` to strip HTML tags + script/style blocks before returning ' +
    '(useful when reading documentation pages); default `"html"` returns ' +
    'the raw body. Non-2xx responses are not errors — `status` reports ' +
    'whatever the server returned, and `body` carries the response (e.g. ' +
    'a 404 HTML page) so the model can inspect it.';

export const FETCH_WEBPAGE_TOOL: SharedToolDefinition<FetchWebpageInput> = {
    name: 'tomAi_fetchWebpage',
    displayName: 'Fetch Webpage',
    description: FETCH_WEBPAGE_DESCRIPTION,
    tags: ['web', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
            url: { type: 'string', description: 'http:// or https:// URL.' },
            timeoutMs: { type: 'number', description: 'Per-request timeout (default 15000).' },
            maxBytes: { type: 'number', description: 'Body cap in bytes (default 50000, hard max 5_242_880).' },
            followRedirects: { type: 'boolean', description: 'Follow 3xx Location headers. Default true. Capped at 10 hops.' },
            format: {
                type: 'string',
                enum: ['html', 'text'],
                description: 'Return the raw body (`html`) or strip tags + collapse whitespace (`text`). Default `html`.',
            },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ===========================================================================
// webSearch — provider-agnostic
// ===========================================================================

export interface WebSearchInput {
    query: string;
    maxResults?: number;
    timeoutMs?: number;
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface SearchProvider {
    /** Identifier shown in the response so the LLM knows which engine answered. */
    readonly name: string;
    search(query: string, maxResults: number, timeoutMs: number): Promise<SearchResult[]>;
}

export interface WebSearchDeps {
    provider: SearchProvider;
}

const WEB_SEARCH_DEFAULT_TIMEOUT = 15_000;
const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8;
const WEB_SEARCH_HARD_MAX_RESULTS = 50;

export async function webSearchImpl(deps: WebSearchDeps, input: WebSearchInput): Promise<string> {
    if (!input.query || typeof input.query !== 'string') {
        return JSON.stringify({ error: '`query` is required and must be a non-empty string.' });
    }
    const maxResults = Math.min(
        Math.max(1, Math.floor(Number(input.maxResults ?? WEB_SEARCH_DEFAULT_MAX_RESULTS))),
        WEB_SEARCH_HARD_MAX_RESULTS,
    );
    const timeoutMs = Math.max(100, input.timeoutMs ?? WEB_SEARCH_DEFAULT_TIMEOUT);

    let results: SearchResult[];
    try {
        results = await deps.provider.search(input.query, maxResults, timeoutMs);
    } catch (err) {
        return JSON.stringify({
            error: `Search failed (${deps.provider.name}): ${(err as Error).message}`,
            provider: deps.provider.name,
        });
    }
    return JSON.stringify({
        provider: deps.provider.name,
        query: input.query,
        returned: results.length,
        results,
    });
}

// ---------------------------------------------------------------------------
// DuckDuckGo Lite provider (production default)
// ---------------------------------------------------------------------------

/**
 * Build a DuckDuckGo-Lite-backed `SearchProvider`. Exported so the
 * production `tool-executors.ts` can wire it and so a swap to a
 * different engine later only needs to point the live deps at a
 * different factory.
 */
export function buildDuckDuckGoLiteProvider(): SearchProvider {
    return {
        name: 'duckduckgo-lite',
        async search(query, maxResults, timeoutMs) {
            return new Promise<SearchResult[]>((resolve, reject) => {
                const postData = `q=${encodeURIComponent(query)}`;
                const req = https.request({
                    hostname: 'lite.duckduckgo.com',
                    path: '/lite/',
                    method: 'POST',
                    headers: {
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Type': 'application/x-www-form-urlencoded',
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'Content-Length': Buffer.byteLength(postData),
                        // eslint-disable-next-line @typescript-eslint/naming-convention
                        'User-Agent': 'tom-ai-extension/1.0',
                    },
                    timeout: timeoutMs,
                }, (res) => {
                    let body = '';
                    res.on('data', (c: Buffer) => { body += c.toString(); });
                    res.on('end', () => {
                        try { resolve(parseDuckDuckGoLite(body, maxResults)); }
                        catch (err) { reject(err); }
                    });
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(new Error(`Search timed out after ${timeoutMs} ms`)); });
                req.write(postData);
                req.end();
            });
        },
    };
}

/**
 * Parse a DuckDuckGo-Lite HTML response. Exported so tests of the
 * parser itself can run against canned fixtures without standing up
 * a fake HTTP server.
 */
export function parseDuckDuckGoLite(html: string, max: number): SearchResult[] {
    const results: SearchResult[] = [];
    const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRegex.exec(html)) !== null) {
        const url = m[1].trim();
        const title = m[2].replace(/<[^>]*>/g, '').trim();
        if (url && title) { links.push({ url, title }); }
    }
    const snippets: string[] = [];
    while ((m = snippetRegex.exec(html)) !== null) {
        snippets.push(m[1].replace(/<[^>]*>/g, '').trim());
    }
    for (let i = 0; i < Math.min(links.length, max); i++) {
        results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? '' });
    }
    return results;
}

export const WEB_SEARCH_DESCRIPTION =
    'Search the web. Returns a JSON envelope with `provider` (which search ' +
    'engine answered), `query` (echoed back), `returned` (count), and ' +
    '`results` (array of `{title, url, snippet}`). Default provider is ' +
    'DuckDuckGo Lite (no API key required). Default 8 results, hard max 50. ' +
    'Default timeout 15 000 ms. Search-engine failures (timeouts, parse ' +
    'failures, rate-limit responses) come back as `{error, provider}` JSON ' +
    'rather than throwing, so the model can decide whether to retry or ' +
    'switch tactics. The HTML scraping is best-effort — DDG can change ' +
    'their markup at any time; check `returned: 0` before assuming "no ' +
    'matches".';

export const WEB_SEARCH_TOOL: SharedToolDefinition<WebSearchInput> = {
    name: 'tomAi_webSearch',
    displayName: 'Web Search',
    description: WEB_SEARCH_DESCRIPTION,
    tags: ['web', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: { type: 'string', description: 'The search query.' },
            maxResults: { type: 'number', description: 'Max results to return (default 8, hard max 50).' },
            timeoutMs: { type: 'number', description: 'Search timeout in ms (default 15000).' },
        },
    },
    execute: async () => '{"error":"execute() must be installed by tool-executors.ts"}',
};

// ---------------------------------------------------------------------------
// Master list
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WEB_TOOLS: SharedToolDefinition<any>[] = [
    FETCH_WEBPAGE_TOOL,
    WEB_SEARCH_TOOL,
];
