/**
 * What the Markdown Browser takes from the TomSpecs runtime to write a review
 * comment (src/services/som-review-comments.ts).
 *
 *   MC-1 the next comment number is the runtime's (annot2 nextCommentId): one past the highest C-<n>
 *        among the document's comments, 1 without any
 *   MC-2 form fields: every form section's lines from its first field label to the next heading —
 *        an item's own form (FR-01's `Status:`) and a form with its own heading (FRED, FREP) alike;
 *        the heading and the lines before the first label are not in a range
 *   MC-3 a document the import does not reproduce faithfully (an extra blank line, a heading it rejects) still
 *        gets the ranges of the sections it understood, at the file's own lines; a YAML document has none
 *   MC-4 the worker client: the same answer off the extension host's thread; null for a file that is not SOM
 *        Markdown; a request overtaken by a newer one before it started answers null
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SpecReviewAnnotations } from 'tom_som_typescript_runtime';
import { SomModelService } from '../som-model-service.js';
import { SomDocumentStore, nodeSomDocumentIo } from '../som-document-store.js';
import { somCommentContext } from '../som-review-comments.js';
import { SomCommentsWorkerClient } from '../som-review-comments-client.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SAMPLES = path.resolve(EXT_ROOT, '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_MD = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');

const service = new SomModelService();
const store = new SomDocumentStore(service, nodeSomDocumentIo);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'som-comments-'));
const write = (name: string, text: string): string => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
};

describe('review comments in SOM Markdown', () => {
    test('MC-1: the next comment number', () => {
        const loaded = store.load(write('mc1.md', MERIDIAN_MD));
        assert.equal(somCommentContext(loaded, service).nextCommentNumber, 1, 'no comment yet');
        const notes = new SpecReviewAnnotations(loaded.document);
        notes.insertComment({ path: 'SBP/content', afterParagraph: 0, text: 'Why three systems?', id: 'C-7' });
        const again = store.load(write('mc1b.md', store.render(loaded, { stamp: loaded.stamp })));
        assert.match(again.text, /⬆️ \*\*C-7\*\*/);
        assert.equal(somCommentContext(again, service).nextCommentNumber, 8, 'one past the highest');
    });

    test('MC-2: form fields', () => {
        const loaded = store.load(write('mc2.md', MERIDIAN_MD));
        assert.deepEqual(loaded.fidelityProblems, [], 'the sample is faithful');
        const { formFieldRanges } = somCommentContext(loaded, service);
        const lines = MERIDIAN_MD.split('\n');
        const covered = (i: number): boolean => formFieldRanges.some(([a, b]) => i >= a && i < b);
        const at = (needle: string): number => lines.findIndex((l) => l.startsWith(needle));
        const item = at('###### <!--[FRE-REQU-ORDER-CAPTURE]');
        const status = lines.indexOf('Status: approved', item);
        const fred = lines.findIndex((l, i) => i > item && l.startsWith('####### <!--[FRED]'));
        const description = lines.findIndex((l, i) => i > fred && l.startsWith('Description: '));
        assert.ok(item > 0 && status > item && fred > status && description > fred);
        assert.equal(covered(item), false, 'a heading is not a field');
        assert.equal(covered(status), true, 'an item\'s own form field');
        assert.equal(covered(status + 1), true, 'up to the next heading');
        assert.equal(covered(fred), false);
        assert.equal(covered(fred + 1), false, 'between the heading and the first label: the preamble');
        assert.equal(covered(description), true, 'a form with its own heading');
        assert.ok(formFieldRanges.every(([a, b]) => a < b && !/^#{1,6} /.test(lines[a])));
        const intro = at('# <!--[SBP]');
        assert.equal(covered(intro + 2), false, 'plain content is not a form');
    });

    test('MC-3: a document that is not faithful, and YAML', () => {
        const yaml = store.load(write('mc3.docspecs.yaml', MERIDIAN_YAML));
        assert.deepEqual(somCommentContext(yaml, service).formFieldRanges, []);
        assert.equal(somCommentContext(yaml, service).nextCommentNumber, 1, 'a YAML document still counts its comments');

        const shifted = MERIDIAN_MD.replace('Status: approved\n\n', 'Status: approved\n\n\n')
            .replace('####### <!--[FRED]--> Details', '####### <!--[NOSUCH]--> Not in the model\n\nStray: text\n\n####### <!--[FRED]--> Details');
        const odd = store.load(write('mc3.md', shifted));
        assert.ok(odd.fidelityProblems.length > 0 || odd.rejections.length > 0, 'the import does not reproduce this file');
        const { formFieldRanges } = somCommentContext(odd, service);
        const lines = shifted.split('\n');
        const covered = (i: number): boolean => formFieldRanges.some(([a, b]) => i >= a && i < b);
        const fred = lines.findIndex((l) => l.startsWith('####### <!--[FRED]'));
        const description = lines.findIndex((l, i) => i > fred && l.startsWith('Description: '));
        assert.equal(covered(description), true, 'the section after the rejected heading still has its fields, at the file\'s line');
        assert.equal(covered(lines.indexOf('Stray: text')), false, 'nothing under a heading the import rejected');
        assert.equal(covered(lines.indexOf('Status: approved')), true);
    });

    test('MC-4: the worker client', async () => {
        const client = new SomCommentsWorkerClient();
        try {
            const file = write('mc4.md', MERIDIAN_MD);
            const direct = somCommentContext(store.load(file), service);
            assert.deepEqual(await client.contextFor(file), direct);
            assert.equal(await client.contextFor(write('mc4-plain.md', '# Notes\n\nNot a spec.\n')), null);
            const [first, second, third] = await Promise.all([client.contextFor(file), client.contextFor(file), client.contextFor(file)]);
            assert.deepEqual(first, direct, 'the one already running finishes');
            assert.equal(second, null, 'overtaken while waiting');
            assert.deepEqual(third, direct, 'the newest runs');
        } finally {
            await client.dispose();
        }
    });
});
