/**
 * Tool-impl tests for `conversation-result-tools.ts` — coverage
 * entry #31.
 *
 *   - tomAi_readConversationResult
 *   - tomAi_writeConversationResult
 *
 * Strategy: a real on-disk fixture under `os.tmpdir()` standing in
 * for the workspace root, plus a thin `ResultFileStore` adapter that
 * does the path math the live bridge does (workspaceRoot +
 * `_ai/ai_conversation/{id}.result.md`).  Real fs round-trips keep
 * the test honest about append semantics + sanitisation + the
 * multi-conversation isolation guarantee.
 *
 * Coverage entry #31 four-row checklist:
 *
 *   a) Description clarity — verified in the impl: file location
 *      format spelled out, conversationId sanitisation documented
 *      (`[^a-zA-Z0-9._-]` → `_`), default `current`.
 *   b) Ambiguities closed:
 *        - **append vs replace** explicit in modes + tested for
 *          both fresh-file and existing-file cases
 *        - **separator-on-append** ('\n' only when existing
 *          doesn't already end with one) documented + tested
 *        - **append is read-modify-write, NOT atomic** documented
 *        - **multi-conversation isolation** tested: writes to
 *          different conversationIds don't see each other
 *        - **conversationId sanitisation** tested with `..` /
 *          `/` to confirm they map to `_` (path traversal closed)
 *        - **empty conversationId / explicit undefined** falls
 *          back to "current"
 *   c) Round-trip tests per the c-row's explicit ask: write then
 *      read; append then read; replace overwrites.
 *   d) Timing — sub-ms per call (small files).
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withTiming } from './_timing.js';

// `conversation-result-tools.ts` imports `vscode` at module top to wire
// the live bridge — install the shared stub first.
import { installVscodeStub } from './_vscode-stub.js';
installVscodeStub({});

import {
    readConversationResultImpl,
    writeConversationResultImpl,
    sanitiseConversationId,
    type ResultFileStore,
} from '../conversation-result-tools.js';

// ===========================================================================
// On-disk fixture + store backed by it
// ===========================================================================

let tmp: string;

function makeStore(): ResultFileStore {
    return {
        workspaceRoot: () => tmp,
        aiFolderName: () => '_ai',
        fileExists: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
        readFile: (p) => {
            const content = fs.readFileSync(p, 'utf8');
            const stat = fs.statSync(p);
            return { content, size: stat.size, modified: stat.mtime };
        },
        writeFile: (p, content) => {
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            fs.writeFileSync(p, content, 'utf8');
        },
        fileSize: (p) => {
            try { return fs.statSync(p).size; }
            catch { return 0; }
        },
    };
}

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-result-'));
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function fileFor(conversationId: string): string {
    return path.join(tmp, '_ai', 'ai_conversation', `${conversationId}.result.md`);
}

// ===========================================================================
// `sanitiseConversationId`
// ===========================================================================

describe('sanitiseConversationId', () => {

    test('alphanumerics and dot/underscore/dash pass through unchanged', () => {
        assert.equal(sanitiseConversationId('abc-123_v2.alpha'), 'abc-123_v2.alpha');
    });

    test('slashes become underscores (traversal closed)', () => {
        assert.equal(sanitiseConversationId('../escape'), '.._escape');
    });

    test('every disallowed char goes to _', () => {
        assert.equal(sanitiseConversationId('x y$z'), 'x_y_z');
    });
});

// ===========================================================================
// `tomAi_readConversationResult`
// ===========================================================================

describe('readConversationResultImpl', () => {

    test('typical: missing file → ok:true, exists:false, empty content (NOT an error)', async () => {
        const store = makeStore();
        const raw = await withTiming('tomAi_readConversationResult:typical', () =>
            readConversationResultImpl(store, { conversationId: 'fresh-' + Date.now() }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.exists, false);
        assert.equal(r.content, '');
        assert.equal(r.size, 0);
        assert.match(r.note, /does not exist yet/);
    });

    test('defaults conversationId to "current"', async () => {
        const store = makeStore();
        const r = JSON.parse(await readConversationResultImpl(store, {}));
        assert.equal(r.conversationId, 'current');
        assert.equal(r.rawConversationId, 'current');
    });

    test('sanitises conversationId and echoes both raw + sanitised', async () => {
        const store = makeStore();
        const r = JSON.parse(await readConversationResultImpl(store, { conversationId: '../escape' }));
        assert.equal(r.rawConversationId, '../escape');
        assert.equal(r.conversationId, '.._escape');
        // The path component uses the sanitised id, NOT the raw one
        assert.match(r.path, /\.\._escape\.result\.md$/);
    });

    test('no workspace → ok:false', async () => {
        const closed: ResultFileStore = { ...makeStore(), workspaceRoot: () => undefined };
        const r = JSON.parse(await readConversationResultImpl(closed, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /No workspace open/);
    });

    test('store.readFile throws → ok:false with reason', async () => {
        const broken: ResultFileStore = {
            ...makeStore(),
            fileExists: () => true,
            readFile: () => { throw new Error('EACCES'); },
        };
        const r = JSON.parse(await readConversationResultImpl(broken, {}));
        assert.equal(r.ok, false);
        assert.match(r.error, /readConversationResult failed: EACCES/);
    });
});

// ===========================================================================
// `tomAi_writeConversationResult`
// ===========================================================================

describe('writeConversationResultImpl', () => {

    test('typical: replace mode creates the file with the supplied content', async () => {
        const store = makeStore();
        const cid = 'write-' + Date.now();
        const raw = await withTiming('tomAi_writeConversationResult:typical', () =>
            writeConversationResultImpl(store, { content: '# Outcome\n', conversationId: cid }));
        const r = JSON.parse(raw);
        assert.equal(r.ok, true);
        assert.equal(r.mode, 'replace');
        assert.equal(r.size, '# Outcome\n'.length);
        // File actually exists on disk
        assert.equal(fs.readFileSync(fileFor(cid), 'utf8'), '# Outcome\n');
    });

    test('non-string content rejected', async () => {
        const store = makeStore();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await writeConversationResultImpl(store, { content: 42 as any }));
        assert.equal(r.ok, false);
        assert.match(r.error, /`content` is required/);
    });

    test('replace mode overwrites an existing file', async () => {
        const store = makeStore();
        const cid = 'overwrite-' + Date.now();
        await writeConversationResultImpl(store, { content: 'first', conversationId: cid });
        await writeConversationResultImpl(store, { content: 'second', conversationId: cid });
        assert.equal(fs.readFileSync(fileFor(cid), 'utf8'), 'second');
    });

    test('append mode adds the supplied content after a `\\n` separator (when missing)', async () => {
        const store = makeStore();
        const cid = 'append-' + Date.now();
        // Existing content does NOT end with \n
        await writeConversationResultImpl(store, { content: 'line one', conversationId: cid });
        await writeConversationResultImpl(store, { content: 'line two', mode: 'append', conversationId: cid });
        assert.equal(fs.readFileSync(fileFor(cid), 'utf8'), 'line one\nline two');
    });

    test('append mode skips the separator when existing already ends with `\\n`', async () => {
        const store = makeStore();
        const cid = 'append-sep-' + Date.now();
        await writeConversationResultImpl(store, { content: 'line one\n', conversationId: cid });
        await writeConversationResultImpl(store, { content: 'line two', mode: 'append', conversationId: cid });
        assert.equal(fs.readFileSync(fileFor(cid), 'utf8'), 'line one\nline two');
    });

    test('append mode on missing file = replace', async () => {
        const store = makeStore();
        const cid = 'append-missing-' + Date.now();
        await writeConversationResultImpl(store, { content: 'first append', mode: 'append', conversationId: cid });
        assert.equal(fs.readFileSync(fileFor(cid), 'utf8'), 'first append');
    });

    test('multi-conversation isolation: writes to A and B do not interfere', async () => {
        const store = makeStore();
        await writeConversationResultImpl(store, { content: 'A content', conversationId: 'alpha' });
        await writeConversationResultImpl(store, { content: 'B content', conversationId: 'beta' });
        const ra = JSON.parse(await readConversationResultImpl(store, { conversationId: 'alpha' }));
        const rb = JSON.parse(await readConversationResultImpl(store, { conversationId: 'beta' }));
        assert.equal(ra.content, 'A content');
        assert.equal(rb.content, 'B content');
    });

    test('mode unknown silently falls back to replace (preserves old behaviour)', async () => {
        const store = makeStore();
        const cid = 'unknown-mode-' + Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = JSON.parse(await writeConversationResultImpl(store, { content: 'x', mode: 'bogus' as any, conversationId: cid }));
        assert.equal(r.mode, 'replace');
    });

    test('store.writeFile throws → ok:false with reason', async () => {
        const broken: ResultFileStore = {
            ...makeStore(),
            writeFile: () => { throw new Error('ENOSPC'); },
        };
        const r = JSON.parse(await writeConversationResultImpl(broken, { content: 'x' }));
        assert.equal(r.ok, false);
        assert.match(r.error, /writeConversationResult failed: ENOSPC/);
    });
});

// ===========================================================================
// Round-trip — the c-row's explicit ask
// ===========================================================================

describe('round-trip read/write/append', () => {

    test('write → read returns the same content + correct size + modified ISO', async () => {
        const store = makeStore();
        const cid = 'rt-' + Date.now();
        const content = '# Heading\n\nBody paragraph.\n';
        const wr = JSON.parse(await writeConversationResultImpl(store, { content, conversationId: cid }));
        assert.equal(wr.ok, true);
        const rd = JSON.parse(await readConversationResultImpl(store, { conversationId: cid }));
        assert.equal(rd.ok, true);
        assert.equal(rd.exists, true);
        assert.equal(rd.content, content);
        assert.equal(rd.size, content.length);
        assert.match(rd.modified, /^\d{4}-\d{2}-\d{2}T/);
    });

    test('write → append → read combines correctly with the smart separator', async () => {
        const store = makeStore();
        const cid = 'rt-append-' + Date.now();
        await writeConversationResultImpl(store, { content: '## first turn', conversationId: cid });
        await writeConversationResultImpl(store, { content: '## second turn', mode: 'append', conversationId: cid });
        await writeConversationResultImpl(store, { content: '## third turn', mode: 'append', conversationId: cid });
        const rd = JSON.parse(await readConversationResultImpl(store, { conversationId: cid }));
        assert.equal(rd.content, '## first turn\n## second turn\n## third turn');
    });

    test('write replace → write replace → read returns only the second write', async () => {
        const store = makeStore();
        const cid = 'rt-overwrite-' + Date.now();
        await writeConversationResultImpl(store, { content: 'first', conversationId: cid });
        await writeConversationResultImpl(store, { content: 'final', conversationId: cid });
        const rd = JSON.parse(await readConversationResultImpl(store, { conversationId: cid }));
        assert.equal(rd.content, 'final');
    });
});
