/**
 * Tests for `NotepadFileStorage` — the shared file-backed store behind all
 * three notepad views (VS Code global notes, workspace notes, quest notes).
 *
 * The behaviour under test is change detection: an edit made to the file from
 * *outside* the view must reach the view, while the view's own autosave must
 * not bounce back at it. Two properties matter and neither used to hold:
 *
 *   1. **The poll is the guarantee, not the watcher.** All three notepads live
 *      on paths `createFileSystemWatcher` does not reliably serve — the quest
 *      and workspace notes under the symlinked `_ai/` tree, the global notes
 *      outside the workspace altogether. The stub here never fires a watcher
 *      event unless a test asks it to, so "the native watcher stayed silent"
 *      is the default case rather than an exotic one.
 *   2. **Echo suppression must not be stateful.** Recognising our own write by
 *      comparing content is self-correcting; a one-shot "ignore the next
 *      event" flag is not — if the event it was armed for never arrives, the
 *      flag stays armed and eats a real edit instead.
 *
 * `NotepadFileStorage` imports `vscode` at module top, so the shared stub is
 * installed before the import.
 */

import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub, stubFileWatchers, type StubFileWatcher } from '../../tools/__tests__/_vscode-stub.js';
installVscodeStub({});

import { NotepadFileStorage } from '../notepad/notepadFileStorage.js';

/** Poll period used throughout — short enough to keep the suite quick. */
const POLL_MS = 10;

/** Long enough for several poll ticks to have run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, POLL_MS * 6));
}

describe('NotepadFileStorage — external change detection', () => {

    let tmpDir: string;
    let notesFile: string;
    let storage: NotepadFileStorage;
    let externalChanges: number;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-storage-'));
        notesFile = path.join(tmpDir, 'notes.md');
        fs.writeFileSync(notesFile, 'original', 'utf-8');
        storage = new NotepadFileStorage(notesFile);
        externalChanges = 0;
    });

    afterEach(() => {
        storage.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Start watching, counting the external-change notifications. */
    function startWatching(): void {
        storage.load();
        storage.watch(() => { externalChanges++; }, POLL_MS);
    }

    /** Write to the file the way another editor would — behind our back. */
    function writeExternally(content: string): void {
        fs.writeFileSync(notesFile, content, 'utf-8');
    }

    /**
     * The watcher belonging to the storage under test. The stub's registry
     * spans the whole process, so the newest entry is ours — the earlier ones
     * belong to already-disposed storages from previous tests.
     */
    function watcher(): StubFileWatcher {
        const all = stubFileWatchers();
        assert.ok(all.length > 0, 'no file watcher was created');
        return all[all.length - 1];
    }

    test('an external edit is reported even when the native watcher never fires', async () => {
        startWatching();
        writeExternally('edited elsewhere');
        await settle();
        assert.equal(externalChanges, 1, 'the poll must catch what the watcher missed');
        assert.equal(storage.content, 'edited elsewhere');
    });

    test('an external edit is reported when only the watcher fires', async () => {
        startWatching();
        writeExternally('edited elsewhere');
        watcher().fireChange();
        assert.equal(externalChanges, 1);
        assert.equal(storage.content, 'edited elsewhere');
    });

    test('our own save is not reported back as an external change', async () => {
        startWatching();
        storage.save('typed in the view');
        watcher().fireChange();
        await settle();
        assert.equal(externalChanges, 0);
    });

    test('a save whose watcher echo never arrives does not swallow the next external edit', async () => {
        startWatching();
        storage.save('typed in the view');
        // No watcher event for our write — the case the old one-shot ignore
        // flag stayed armed for, eating the genuine edit that came next.
        writeExternally('edited elsewhere');
        watcher().fireChange();
        await settle();
        assert.equal(externalChanges, 1);
        assert.equal(storage.content, 'edited elsewhere');
    });

    test('a rewrite with identical content is not reported', async () => {
        startWatching();
        writeExternally('original');
        watcher().fireChange();
        await settle();
        assert.equal(externalChanges, 0);
    });

    test('successive external edits are each reported once', async () => {
        startWatching();
        writeExternally('first');
        await settle();
        writeExternally('second');
        await settle();
        assert.equal(externalChanges, 2);
        assert.equal(storage.content, 'second');
    });

    test('a deleted file is not reported as a change, and the content is kept', async () => {
        startWatching();
        fs.rmSync(notesFile);
        await settle();
        assert.equal(externalChanges, 0);
        assert.equal(storage.content, 'original');
    });

    test('watch() is idempotent — a second call adds no second watcher', () => {
        const before = stubFileWatchers().length;
        startWatching();
        storage.watch(() => { externalChanges++; }, POLL_MS);
        assert.equal(stubFileWatchers().length - before, 1);
    });

    test('dispose() stops the poll', async () => {
        startWatching();
        storage.dispose();
        writeExternally('edited after dispose');
        await settle();
        assert.equal(externalChanges, 0);
    });

    test('the file and its parent directory are created on demand', () => {
        const nested = path.join(tmpDir, 'a', 'b', 'notes.md');
        const nestedStorage = new NotepadFileStorage(nested);
        assert.equal(nestedStorage.load(), '');
        assert.ok(fs.existsSync(nested));
        nestedStorage.dispose();
    });
});
