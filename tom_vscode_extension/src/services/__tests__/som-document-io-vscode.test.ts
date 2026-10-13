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

import { installVscodeStub } from '../../tools/__tests__/_vscode-stub.js';
import { SomDocumentStore, SomDocumentError } from '../som-document-store.js';
import { SomModelService } from '../som-model-service.js';

interface FakeDoc {
    uri: { scheme: string; fsPath: string };
    isDirty: boolean;
    text: string;
    saved: number;
    getText(): string;
    positionAt(offset: number): { offset: number };
    save(): Promise<boolean>;
}

const replacements: Array<{ uri: unknown; range: { start: { offset: number }; end: { offset: number } }; text: string }> = [];
let applyResult = true;
let saveResult = true;

const { stub } = installVscodeStub();
const workspace = stub.workspace as Record<string, unknown>;
workspace.textDocuments = [] as FakeDoc[];
workspace.applyEdit = async (edit: { ops: typeof replacements }): Promise<boolean> => {
    replacements.push(...edit.ops);
    return applyResult;
};
stub.Range = class { constructor(readonly start: unknown, readonly end: unknown) {} };
stub.WorkspaceEdit = class {
    ops: unknown[] = [];
    replace(uri: unknown, range: unknown, text: string): void { this.ops.push({ uri, range, text }); }
};

// Required after the stub is wired: the module imports 'vscode'.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { vscodeSomDocumentIo } = require('../som-document-io-vscode.js') as typeof import('../som-document-io-vscode.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'som-io-vscode-'));
const SAMPLE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents',
    'meridian_order_management.docspecs.yaml'), 'utf8');

function open(filePath: string, text: string, isDirty = false): FakeDoc {
    const doc: FakeDoc = {
        uri: { scheme: 'file', fsPath: filePath },
        isDirty,
        text,
        saved: 0,
        getText() { return this.text; },
        positionAt(offset) { return { offset }; },
        async save() { this.saved++; return saveResult; },
    };
    (workspace.textDocuments as FakeDoc[]).push(doc);
    return doc;
}

function reset(): void {
    workspace.textDocuments = [];
    replacements.length = 0;
    applyResult = true;
    saveResult = true;
}

describe('vscodeSomDocumentIo', () => {
    test('SDV-1: a file open in no editor is read and written on disk', async () => {
        reset();
        const p = path.join(tmp, 'sdv1.docspecs.yaml');
        fs.writeFileSync(p, 'on disk\n');
        assert.equal(vscodeSomDocumentIo.read(p), 'on disk\n');
        assert.equal(vscodeSomDocumentIo.isDirty?.(p), false);
        await vscodeSomDocumentIo.write(p, 'written\n');
        assert.equal(fs.readFileSync(p, 'utf8'), 'written\n');
        assert.equal(replacements.length, 0);
    });

    test('SDV-2: an open, clean file is written as one full-range edit, then saved', async () => {
        reset();
        const p = path.join(tmp, 'sdv2.docspecs.yaml');
        fs.writeFileSync(p, 'disk text\n');
        const doc = open(p, 'buffer text\n');
        assert.equal(vscodeSomDocumentIo.read(p), 'buffer text\n', 'the editor buffer is the truth');
        await vscodeSomDocumentIo.write(p, 'new text\n');
        assert.equal(replacements.length, 1);
        assert.equal(replacements[0].text, 'new text\n');
        assert.deepEqual([replacements[0].range.start.offset, replacements[0].range.end.offset], [0, 'buffer text\n'.length]);
        assert.equal(doc.saved, 1);
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
        assert.equal(replacements.length, 0);
    });

    test('SDV-4: a refused edit or a failed save is an error', async () => {
        reset();
        const p = path.join(tmp, 'sdv4.docspecs.yaml');
        fs.writeFileSync(p, 'x\n');
        open(p, 'x\n');
        applyResult = false;
        await assert.rejects(vscodeSomDocumentIo.write(p, 'y\n'), /refused the edit/);
        applyResult = true;
        saveResult = false;
        await assert.rejects(vscodeSomDocumentIo.write(p, 'y\n'), /could not be saved/);
    });
});
