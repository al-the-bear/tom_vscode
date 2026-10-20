/**
 * The shared `vscode` test stub's editor pieces (vscimpa3): open text
 * documents, positions and ranges, and workspace edits — what code that
 * writes through an open editor needs, in one place instead of a copy per
 * test.
 *
 *   VS-1  Position / Range: a Range from two positions or four numbers; isEmpty
 *   VS-2  fakeTextDocument: uri, text, offset ↔ position across lines, getText(range), lineCount, save
 *         (counted, clears isDirty, returns saveResult)
 *   VS-3  WorkspaceEdit records replace / insert / delete in order, with size
 *   VS-4  applyEdit: recorded as a spy and in appliedEdits(); applied to the open fake document (which
 *         becomes dirty); applyEditResult false refuses it and changes nothing
 *   VS-5  workspace.textDocuments: [] by default, set by the option and by setTextDocuments()
 */

import test, { beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeTextDocument, installVscodeStub } from './_vscode-stub.js';

const handle = installVscodeStub();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vscode = handle.stub as any;

describe('the vscode stub: documents and edits', () => {
    beforeEach(() => {
        handle.setTextDocuments([]);
        handle.setApplyEditResult(true);
        handle.clearAppliedEdits();
        handle.spies.clear();
    });

    test('VS-1: Position and Range', () => {
        const a = new vscode.Position(1, 2);
        assert.deepEqual([a.line, a.character], [1, 2]);
        const r = new vscode.Range(a, new vscode.Position(3, 0));
        assert.deepEqual([r.start.line, r.start.character, r.end.line, r.end.character], [1, 2, 3, 0]);
        const n = new vscode.Range(0, 1, 0, 1);
        assert.deepEqual([n.start.character, n.end.character], [1, 1]);
        assert.equal(n.isEmpty, true);
        assert.equal(r.isEmpty, false);
    });

    test('VS-2: a fake text document', async () => {
        const doc = fakeTextDocument('/ws/a.md', 'ab\ncd\n', { isDirty: true });
        assert.equal(doc.uri.fsPath, '/ws/a.md');
        assert.equal(doc.uri.scheme, 'file');
        assert.equal(doc.fileName, '/ws/a.md');
        assert.equal(doc.getText(), 'ab\ncd\n');
        assert.equal(doc.lineCount, 3);
        const p = doc.positionAt(4);
        assert.deepEqual([p.line, p.character], [1, 1]);
        assert.equal(doc.offsetAt(p), 4);
        assert.equal(doc.offsetAt(doc.positionAt(99)), 6, 'clamped to the end');
        assert.equal(doc.getText(new vscode.Range(doc.positionAt(1), doc.positionAt(4))), 'b\nc');
        assert.equal(doc.isDirty, true);
        assert.equal(await doc.save(), true);
        assert.deepEqual([doc.saved, doc.isDirty], [1, false]);
        const failing = fakeTextDocument('/ws/b.md', 'x', { saveResult: false });
        assert.equal(await failing.save(), false);
    });

    test('VS-3: a WorkspaceEdit records its operations', () => {
        const uri = vscode.Uri.file('/ws/a.md');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, 0, 1), 'X');
        edit.insert(uri, new vscode.Position(1, 0), 'Y');
        edit.delete(uri, new vscode.Range(1, 1, 1, 2));
        assert.equal(edit.size, 3);
        assert.deepEqual(edit.ops.map((o: { kind: string; text?: string }) => [o.kind, o.text ?? null]), [['replace', 'X'], ['insert', 'Y'], ['delete', null]]);
    });

    test('VS-4: applyEdit applies to the open document, or refuses', async () => {
        const doc = fakeTextDocument('/ws/a.md', 'ab\ncd\n');
        handle.setTextDocuments([doc]);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(2)), 'AB');
        edit.insert(doc.uri, doc.positionAt(6), 'ef\n');
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(doc.getText(), 'AB\ncd\nef\n');
        assert.equal(doc.isDirty, true, 'an applied edit leaves the buffer dirty until saved');
        assert.equal(handle.appliedEdits().length, 1);
        assert.equal(handle.spies.byMethod('workspace.applyEdit').length, 1);

        handle.setApplyEditResult(false);
        const refused = new vscode.WorkspaceEdit();
        refused.delete(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(2)));
        assert.equal(await vscode.workspace.applyEdit(refused), false);
        assert.equal(doc.getText(), 'AB\ncd\nef\n', 'refused: unchanged');
        assert.equal(handle.appliedEdits().length, 1, 'only applied edits are listed');
        assert.equal(handle.spies.byMethod('workspace.applyEdit').length, 2, 'every call is recorded');
    });

    test('VS-5: workspace.textDocuments', () => {
        assert.deepEqual(vscode.workspace.textDocuments, []);
        const doc = fakeTextDocument('/ws/c.md', 'c');
        installVscodeStub({ textDocuments: [doc] });
        assert.deepEqual(vscode.workspace.textDocuments, [doc]);
        handle.setTextDocuments([]);
        assert.deepEqual(vscode.workspace.textDocuments, []);
    });
});
