/**
 * vscodeSomDocumentIo — the store's file access inside the extension (vsctsa2).
 *
 *   SDV-1  a file open in no editor is read and written on disk
 *   SDV-2  an open, clean file is read from the buffer and written as ONE
 *          full-range WorkspaceEdit followed by a save (one undo step)
 *   SDV-3  an open, dirty file is reported dirty and the store refuses it
 *   SDV-4  an edit the editor refuses, or a failed save, is an error
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fakeTextDocument, installVscodeStub, type FakeTextDocument, type StubWorkspaceEdit } from '../../tools/__tests__/_vscode-stub.js';
import { SomDocumentStore, SomDocumentError } from '../som-document-store.js';
import { SomModelService } from '../som-model-service.js';

const stub = installVscodeStub();

// Required after the stub is wired: the module imports 'vscode'.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { vscodeSomDocumentIo } = require('../som-document-io-vscode.js') as typeof import('../som-document-io-vscode.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'som-io-vscode-'));
const SAMPLE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents',
    'meridian_order_management.docspecs.yaml'), 'utf8');

function open(filePath: string, text: string, isDirty = false): FakeTextDocument {
    const doc = fakeTextDocument(filePath, text, { isDirty });
    stub.setTextDocuments([doc]);
    return doc;
}

function reset(): void {
    stub.setTextDocuments([]);
    stub.setApplyEditResult(true);
    stub.clearAppliedEdits();
    stub.spies.clear();
}

/** Every edit the editor was asked to apply, accepted or not. */
const requested = (): StubWorkspaceEdit[] => stub.spies.byMethod('workspace.applyEdit').map((c) => c.args[0] as StubWorkspaceEdit);

describe('vscodeSomDocumentIo', () => {
    test('SDV-1: a file open in no editor is read and written on disk', async () => {
        reset();
        const p = path.join(tmp, 'sdv1.docspecs.yaml');
        fs.writeFileSync(p, 'on disk\n');
        assert.equal(vscodeSomDocumentIo.read(p), 'on disk\n');
        assert.equal(vscodeSomDocumentIo.isDirty?.(p), false);
        await vscodeSomDocumentIo.write(p, 'written\n');
        assert.equal(fs.readFileSync(p, 'utf8'), 'written\n');
        assert.equal(requested().length, 0);
    });

    test('SDV-2: an open, clean file is written as one full-range edit, then saved', async () => {
        reset();
        const p = path.join(tmp, 'sdv2.docspecs.yaml');
        fs.writeFileSync(p, 'disk text\n');
        const doc = open(p, 'buffer text\n');
        assert.equal(vscodeSomDocumentIo.read(p), 'buffer text\n', 'the editor buffer is the truth');
        await vscodeSomDocumentIo.write(p, 'new text\n');
        const [edit] = stub.appliedEdits();
        assert.equal(stub.appliedEdits().length, 1);
        assert.equal(edit.size, 1, 'one operation: one undo step');
        const op = edit.ops[0];
        assert.deepEqual([op.kind, op.text], ['replace', 'new text\n']);
        assert.equal(op.uri.fsPath, p);
        const full = op.range!;
        assert.deepEqual([full.start.line, full.start.character], [0, 0]);
        assert.deepEqual([full.end.line, full.end.character], [1, 0], 'to the end of the buffer');
        assert.equal(doc.getText(), 'new text\n', 'the buffer holds the new text');
        assert.deepEqual([doc.saved, doc.isDirty], [1, false]);
        assert.equal(fs.readFileSync(p, 'utf8'), 'disk text\n', 'the disk is the editor save\'s business');
    });

    test('SDV-3: an open, dirty file is refused by the store', async () => {
        reset();
        const p = path.join(tmp, 'sdv3.docspecs.yaml');
        fs.writeFileSync(p, SAMPLE);
        open(p, SAMPLE, true);
        assert.equal(vscodeSomDocumentIo.isDirty?.(p), true);
        const store = new SomDocumentStore(new SomModelService(), vscodeSomDocumentIo);
        await assert.rejects(store.save(store.load(p)),
            (e: unknown) => e instanceof SomDocumentError && e.code === 'dirtyInEditor');
        assert.equal(requested().length, 0);
    });

    test('SDV-4: a refused edit or a failed save is an error', async () => {
        reset();
        const p = path.join(tmp, 'sdv4.docspecs.yaml');
        fs.writeFileSync(p, 'x\n');
        const doc = open(p, 'x\n');
        stub.setApplyEditResult(false);
        await assert.rejects(vscodeSomDocumentIo.write(p, 'y\n'), /refused the edit/);
        assert.equal(doc.getText(), 'x\n', 'refused: the buffer is unchanged');
        stub.setApplyEditResult(true);
        doc.saveResult = false;
        await assert.rejects(vscodeSomDocumentIo.write(p, 'y\n'), /could not be saved/);
    });
});
