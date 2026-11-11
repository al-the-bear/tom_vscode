/**
 * Downloads one provider-SDK tarball to a file, in a process of its own:
 *
 *   <node> providerDownloadWorker.js <url> <dest>
 *
 * Started by providerChildDownload.ts with VS Code's own binary as Node
 * (`ELECTRON_RUN_AS_NODE=1`). Why a process of its own: inside the extension
 * host the global `fetch` is VS Code's replacement (proxy support), and on
 * legiondary02 (Windows, no proxy) a 110 MB tarball through it never finished
 * — the install hung on the Claude CLI package — while the same download took
 * 3 s in Code.exe run as Node and in plain Node. Here `fetch` is Node's own.
 *
 * Talks to its parent on stdout, one line each: `progress <received> <total>`
 * (total 0 when the server sends no length) every few hundred ms and once at
 * the end; failures go to stderr with exit code 1. A proxy in the environment
 * (HTTPS_PROXY / HTTP_PROXY / NO_PROXY) is used, as Node does with
 * `NODE_USE_ENV_PROXY=1`, which the parent sets.
 *
 * Plain Node: no `vscode`, nothing from the extension.
 */

import * as fs from 'fs';

const PROGRESS_INTERVAL_MS = 250;

async function main(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    const total = Number(res.headers.get('content-length') ?? 0) || 0;
    if (!res.body) { throw new Error('the response has no body'); }
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    let received = 0;
    let last = 0;
    const report = (): void => { process.stdout.write(`progress ${received} ${total}\n`); };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) { break; }
            if (value) {
                received += value.byteLength;
                if (!out.write(value)) { await new Promise<void>((r) => out.once('drain', () => r())); }
            }
            const now = Date.now();
            if (now - last >= PROGRESS_INTERVAL_MS) { last = now; report(); }
        }
    } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    report();
}

if (require.main === module) {
    const [url, dest] = process.argv.slice(2);
    if (!url || !dest) {
        process.stderr.write('usage: providerDownloadWorker <url> <dest>\n');
        process.exit(2);
    }
    main(url, dest).then(
        () => process.exit(0),
        (e: unknown) => {
            const cause = (e as { cause?: { message?: string } })?.cause?.message;
            process.stderr.write(`${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ''}\n`);
            process.exit(1);
        },
    );
}
