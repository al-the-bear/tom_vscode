/**
 * The extension's file access for {@link SomDocumentStore}.
 *
 * A file open in an editor is the editor's: it is read from the editor buffer,
 * and written through a WorkspaceEdit followed by a save, so the editor
 * keeps its undo history and never shows a "file changed on disk" conflict.
 * A file with unsaved editor changes is reported dirty and the store refuses
 * to save it. A file not open anywhere is read and written on disk
 * (atomically, through {@link nodeSomDocumentIo}).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { SomDocumentIo, SomDocumentStore, nodeSomDocumentIo } from './som-document-store';
import { SomModelService } from './som-model-service';

function openDocument(filePath: string): vscode.TextDocument | undefined {
    const target = path.resolve(filePath);
    return vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === target,
    );
}

export const vscodeSomDocumentIo: SomDocumentIo = {
    read(filePath) {
        return openDocument(filePath)?.getText() ?? nodeSomDocumentIo.read(filePath);
    },
    isDirty(filePath) {
        return openDocument(filePath)?.isDirty ?? false;
    },
    async write(filePath, text) {
        const doc = openDocument(filePath);
        if (!doc) {
            await nodeSomDocumentIo.write(filePath, text);
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
        if (!(await vscode.workspace.applyEdit(edit))) {
            throw new Error(`The editor refused the edit to ${path.basename(filePath)}.`);
        }
        if (!(await doc.save())) {
            throw new Error(`${path.basename(filePath)} was edited in its editor but could not be saved.`);
        }
    },
};

let shared: SomDocumentStore | undefined;

/** The store every extension-side spec tool uses. */
export function somDocumentStore(): SomDocumentStore {
    shared ??= new SomDocumentStore(SomModelService.instance, vscodeSomDocumentIo);
    return shared;
}
