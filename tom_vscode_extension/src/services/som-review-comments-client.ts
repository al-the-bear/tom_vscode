/**
 * Reads a SOM Markdown document's review-comment context
 * (som-review-comments.ts) in a worker thread, off the extension host's
 * thread. One worker, one request at a time; a request still waiting when a
 * newer one arrives is answered null — the Markdown Browser only needs the
 * reading of the text it shows now, and a burst of saves then costs one
 * reading, not one per save.
 *
 * vscode-free.
 */

import * as path from 'path';
import { Worker } from 'worker_threads';

import type { SomCommentContext } from './som-review-comments';

interface Request {
    filePath: string;
    resolve: (context: SomCommentContext | null) => void;
    reject: (error: Error) => void;
}

export class SomCommentsWorkerClient {
    private worker: Worker | undefined;
    private running: (Request & { id: number }) | undefined;
    private waiting: Request | undefined;
    private nextId = 1;

    /** The context of `filePath`; null for a file that is not a SOM document, or when a newer request overtook this one. */
    contextFor(filePath: string): Promise<SomCommentContext | null> {
        return new Promise((resolve, reject) => {
            this.waiting?.resolve(null);
            this.waiting = { filePath, resolve, reject };
            this.pump();
        });
    }

    async dispose(): Promise<void> {
        this.waiting?.resolve(null);
        this.waiting = undefined;
        this.running?.resolve(null);
        this.running = undefined;
        const w = this.worker;
        this.worker = undefined;
        await w?.terminate();
    }

    private pump(): void {
        if (this.running || !this.waiting) { return; }
        const request = { ...this.waiting, id: this.nextId++ };
        this.waiting = undefined;
        this.running = request;
        this.ensureWorker().postMessage({ id: request.id, filePath: request.filePath });
    }

    private ensureWorker(): Worker {
        if (this.worker) { return this.worker; }
        const worker = new Worker(path.join(__dirname, 'som-review-comments-worker.js'));
        // The worker must not keep the process alive on its own.
        worker.unref();
        worker.on('message', (msg: { id: number; context?: SomCommentContext | null; error?: string }) => {
            const request = this.running;
            if (!request || request.id !== msg.id) { return; }
            this.running = undefined;
            if (msg.error !== undefined) { request.reject(new Error(msg.error)); } else { request.resolve(msg.context ?? null); }
            this.pump();
        });
        worker.on('error', (e) => {
            this.worker = undefined;
            const request = this.running;
            this.running = undefined;
            request?.reject(e);
            this.pump();
        });
        this.worker = worker;
        return worker;
    }
}
