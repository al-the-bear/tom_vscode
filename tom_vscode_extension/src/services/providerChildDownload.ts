/**
 * Provider-SDK downloads in a child process (providerDownloadWorker.ts): the
 * extension host's own `fetch` is VS Code's replacement, and through it the
 * 110 MB Claude CLI package never finished on a Windows machine without a
 * proxy (legiondary02, 2026-11-11), while Node's own `fetch` in a process of
 * its own — VS Code's binary run as Node — took seconds.
 *
 * vscode-free: the binary and the worker script are passed in (the extension
 * passes `process.execPath` and its compiled worker; tests run plain Node).
 */

import { spawn } from 'child_process';

/**
 * Download `url` to the file `dest`; `onProgress(received, total)` is called
 * as bytes arrive (total 0 when unknown). Aborting `signal` kills the process
 * and rejects. Matches ProviderInstallerOptions.downloadFile.
 */
export type DownloadFile = (
    url: string,
    dest: string,
    onProgress: (received: number, total: number) => void,
    signal: AbortSignal,
) => Promise<void>;

/**
 * A {@link DownloadFile} that runs `workerScript` with `nodeBinary`
 * (`ELECTRON_RUN_AS_NODE=1`, so VS Code's own binary runs as plain Node).
 */
export function childProcessDownloader(nodeBinary: string, workerScript: string): DownloadFile {
    return (url, dest, onProgress, signal) => new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        const child = spawn(nodeBinary, [workerScript, url, dest], {
            env: {
                ...process.env,
                // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable
                ELECTRON_RUN_AS_NODE: '1',
                // eslint-disable-next-line @typescript-eslint/naming-convention -- environment variable
                NODE_USE_ENV_PROXY: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        let pending = '';
        let settled = false;
        const finish = (err?: Error): void => {
            if (settled) { return; }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            if (err) { reject(err); } else { resolve(); }
        };
        const onAbort = (): void => {
            child.kill();
            finish(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                const m = /^progress (\d+) (\d+)$/.exec(line.trim());
                if (m) { onProgress(Number(m[1]), Number(m[2])); }
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (e) => finish(new Error(`the download process could not start (${nodeBinary}): ${e.message}`)));
        child.on('close', (code) => {
            if (code === 0) { finish(); return; }
            finish(new Error(stderr.trim() || `the download process ended with code ${code}`));
        });
    });
}
