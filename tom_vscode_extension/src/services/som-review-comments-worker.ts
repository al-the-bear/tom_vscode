/**
 * Worker thread for som-review-comments.ts: loading a large SOM Markdown
 * document and reading its comment context takes seconds (232 000 lines: ~2 s),
 * which must not block the extension host. Started by
 * som-review-comments-client.ts; answers `{id, context}` (null for a file that
 * is not a SOM document) or `{id, error}`.
 *
 * vscode-free.
 */

import { parentPort } from 'worker_threads';

import { SomModelService } from './som-model-service';
import { SomDocumentStore, nodeSomDocumentIo } from './som-document-store';
import { somCommentContext } from './som-review-comments';

let store: SomDocumentStore | undefined;
let service: SomModelService | undefined;

parentPort?.on('message', (msg: { id: number; filePath: string }) => {
    try {
        service ??= new SomModelService();
        store ??= new SomDocumentStore(service, nodeSomDocumentIo);
        const context = store.peek(msg.filePath) ? somCommentContext(store.load(msg.filePath), service) : null;
        parentPort?.postMessage({ id: msg.id, context });
    } catch (e) {
        parentPort?.postMessage({ id: msg.id, error: (e as Error).message });
    }
});
