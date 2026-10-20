/**
 * SomDocumentStore — file-backed SOM documents (vsctsa2).
 *
 * Every spec tool loads a file into a SpecDocument, edits it, and saves it back
 * in the file's own format through this store. These tests use copies of the
 * Meridian sample in a temporary directory.
 *
 *   SD-1   a YAML file loads: format, root, stamp, editability, revision
 *   SD-2   rendering with the file's own stamp and review is byte-identical
 *   SD-3   the review pass: absent stays absent, `review: {}` stays, entries stay
 *   SD-3b  the pass's presence is the runtime's decode, not a text match: a quoted `"review": {}` key survives a save
 *   SD-4   save writes the file, stamps the model version, returns the revision
 *   SD-5   a file changed since load is never overwritten (revision conflict)
 *   SD-6   dryRun writes nothing and returns the diff
 *   SD-7   a document dirty in an editor is refused
 *   SD-8   a newer same-major stamp and a cross-major stamp load read-only
 *   SD-9   the Meridian Markdown imports faithfully (tom_specs qrb8 fixed); a non-canonical file loads read-only
 *   SD-10  a faithful Markdown document round-trips and saves as Markdown
 *   SD-11  Markdown with parse rejections loads read-only, naming the lines
 *   SD-12  unknown format and unknown root are clear errors
 *   SD-13  save reports review entries whose path no longer resolves
 *   SD-14  peek identifies a document from its header, null for anything else
 *   SD-15  create writes an empty document that loads again, in both formats; an emptied YAML keeps its root
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SpecDocument, SpecEditor, SomEditability } from 'tom_som_typescript_runtime';
import { SomModelService } from '../som-model-service.js';
import { SomDocumentStore, SomDocumentError, nodeSomDocumentIo } from '../som-document-store.js';
import { olderSameMajor, stampOf, withStamp } from '../../tools/__tests__/_somSamples.js';

const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SAMPLES = path.resolve(EXT_ROOT, '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');
const MERIDIAN_MD = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.md'), 'utf8');
/** The stamp ai_build's sample carries today; it moves with the model. */
const SAMPLE_STAMP = stampOf(MERIDIAN_YAML);

const service = new SomModelService();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'som-store-'));

function write(name: string, text: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, text);
    return p;
}

function store(isDirty?: (p: string) => boolean): SomDocumentStore {
    return new SomDocumentStore(service, { ...nodeSomDocumentIo, isDirty });
}

async function refusal(promise: Promise<unknown>): Promise<SomDocumentError> {
    try {
        await promise;
    } catch (e) {
        assert.ok(e instanceof SomDocumentError, `expected SomDocumentError, got ${String(e)}`);
        return e;
    }
    assert.fail('expected a refusal');
}

describe('SomDocumentStore', () => {
    test('SD-1: a YAML file loads', () => {
        const p = write('sd1.docspecs.yaml', MERIDIAN_YAML);
        const doc = store().load(p);
        assert.equal(doc.format, 'yaml');
        assert.equal(doc.root.sectionId, 'SBP');
        assert.equal(doc.stamp, SAMPLE_STAMP);
        assert.equal(doc.editability, SomEditability.editable);
        assert.equal(doc.readOnlyReason, null);
        assert.match(doc.revision, /^[0-9a-f]{64}$/);
        assert.equal(doc.document.content('SBP/content')?.startsWith('Solution Blueprint for the'), true);
    });

    test('SD-2: rendering with the file own stamp and review is byte-identical', () => {
        const doc = store().load(write('sd2.docspecs.yaml', MERIDIAN_YAML));
        assert.equal(store().render(doc, { stamp: doc.stamp }), MERIDIAN_YAML);
    });

    test('SD-3: the review pass — absent, explicit empty, with entries', () => {
        const s = store();
        const absent = s.load(write('sd3a.docspecs.yaml', MERIDIAN_YAML));
        assert.equal(absent.review, null);
        assert.ok(!s.render(absent, { stamp: absent.stamp }).includes('review:'), 'no review pass is added');

        const emptyText = `${MERIDIAN_YAML}review: {}\n`;
        const empty = s.load(write('sd3b.docspecs.yaml', emptyText));
        assert.notEqual(empty.review, null, 'an explicit empty pass is present');
        assert.equal(Object.keys(empty.review as object).length, 0);
        assert.equal(s.render(empty, { stamp: empty.stamp }), emptyText);

        const fullText = `${MERIDIAN_YAML}review:\n  "SBP/content":\n    comment: |2-\n      Checked.\n    reviewed: true\n`;
        const full = s.load(write('sd3c.docspecs.yaml', fullText));
        assert.equal(s.render(full, { stamp: full.stamp }), fullText);
    });

    test('SD-3b: an explicit empty pass survives a save, however its key is written', async () => {
        const s = store();
        for (const [name, key] of [['sd3d.docspecs.yaml', 'review'], ['sd3e.docspecs.yaml', '"review"']]) {
            const p = write(name, `${MERIDIAN_YAML}${key}: {}\n`);
            const doc = s.load(p);
            assert.notEqual(doc.review, null, `${key}: the pass is present`);
            await s.save(doc);
            assert.match(fs.readFileSync(p, 'utf8'), /\nreview: \{\}\n$/, `${key}: the saved file keeps the pass`);
        }
    });

    test('SD-4: save writes, stamps the model version and returns the new revision', async () => {
        const s = store();
        const p = write('sd4.docspecs.yaml', withStamp(MERIDIAN_YAML, olderSameMajor(service.modelVersion)));
        const doc = s.load(p);
        SpecEditor.forModel(doc.document, service.model).setValue('SBP/content', 'Replaced summary.');
        const result = await s.save(doc);
        assert.equal(result.written, true);
        const onDisk = fs.readFileSync(p, 'utf8');
        assert.equal(onDisk, result.text);
        assert.match(onDisk, new RegExp(`modelVersion: "${service.modelVersion}"`), 'the stamp is upgraded on save');
        const again = s.load(p);
        assert.equal(again.document.content('SBP/content'), 'Replaced summary.');
        assert.equal(again.revision, result.revision);
        assert.equal(doc.revision, result.revision, 'the loaded document follows its own save');
        assert.ok(!fs.readdirSync(tmp).some((f) => f.includes('.tmp-')), 'no temp file left behind');
    });

    test('SD-5: a file changed since load is never overwritten', async () => {
        const s = store();
        const p = write('sd5.docspecs.yaml', MERIDIAN_YAML);
        const doc = s.load(p);
        fs.writeFileSync(p, `${MERIDIAN_YAML}# changed by someone else\n`);
        const err = await refusal(s.save(doc));
        assert.equal(err.code, 'revisionConflict');
        assert.match(fs.readFileSync(p, 'utf8'), /changed by someone else/);

        const fresh = s.load(p);
        const err2 = await refusal(s.save(fresh, { expectedRevision: 'deadbeef' }));
        assert.equal(err2.code, 'revisionConflict');
    });

    test('SD-6: dryRun writes nothing and returns the diff', async () => {
        const s = store();
        // An older stamp, so the diff also shows the upgrade a save would write.
        const older = olderSameMajor(service.modelVersion);
        const original = withStamp(MERIDIAN_YAML, older);
        const p = write('sd6.docspecs.yaml', original);
        const doc = s.load(p);
        SpecEditor.forModel(doc.document, service.model).setValue('SBP/content', 'Dry run.');
        const result = await s.save(doc, { dryRun: true });
        assert.equal(result.written, false);
        assert.equal(fs.readFileSync(p, 'utf8'), original);
        assert.match(result.diff, /^\+ {6}Dry run\.$/m);
        assert.ok(result.diff.includes(`-modelVersion: "${older}"`), 'the old stamp goes');
        assert.ok(result.diff.includes(`+modelVersion: "${service.modelVersion}"`), 'the model version comes');
    });

    test('SD-7: a document dirty in an editor is refused', async () => {
        const p = write('sd7.docspecs.yaml', MERIDIAN_YAML);
        const s = store((file) => file === p);
        const err = await refusal(s.save(s.load(p)));
        assert.equal(err.code, 'dirtyInEditor');
    });

    test('SD-8: newer same-major and cross-major stamps load read-only', async () => {
        const s = store();
        const newer = s.load(write('sd8a.docspecs.yaml', withStamp(MERIDIAN_YAML, '1.99')));
        assert.equal(newer.editability, SomEditability.rejectedNewerMinor);
        assert.match(newer.readOnlyReason ?? '', /1\.99.*1\.\d+/);
        const err = await refusal(s.save(newer));
        assert.equal(err.code, 'readOnly');

        const cross = s.load(write('sd8b.docspecs.yaml', withStamp(MERIDIAN_YAML, '2.0')));
        assert.equal(cross.editability, SomEditability.readOnlyCrossMajor);
        assert.ok(cross.readOnlyReason);
    });

    test('SD-9: Markdown fidelity — the sample is faithful, a non-canonical file is read-only', async () => {
        const s = store();
        const doc = s.load(write('sd9.md', MERIDIAN_MD));
        assert.equal(doc.format, 'markdown');
        assert.deepEqual(doc.fidelityProblems, []);
        assert.equal(doc.readOnlyReason, null);
        // A file that does not re-render as itself would be rewritten by a save, so it is refused.
        const odd = s.load(write('sd9-odd.md', MERIDIAN_MD.replace('\n\n## ', '\n\n\n## ')));
        assert.match(odd.fidelityProblems.join('\n'), /does not reproduce the file/);
        assert.match(odd.readOnlyReason ?? '', /rewrite it/);
        assert.equal((await refusal(s.save(odd))).code, 'readOnly');
    });

    test('SD-10: a faithful Markdown document round-trips and saves as Markdown', async () => {
        const s = store();
        const source = new SpecDocument();
        SpecEditor.forModel(source, service.model).setValue('SBP/content', 'A small blueprint.');
        const text = source.toMarkdown(service.model, 'D00SolutionBlueprint');
        const p = write('sd10.md', text);
        const doc = s.load(p);
        assert.deepEqual(doc.fidelityProblems, []);
        assert.equal(doc.readOnlyReason, null);
        assert.equal(doc.stamp, service.modelVersion);
        assert.equal(s.render(doc, { stamp: doc.stamp }), text);
        SpecEditor.forModel(doc.document, service.model).setValue('SBP/content', 'An edited blueprint.');
        await s.save(doc);
        const saved = fs.readFileSync(p, 'utf8');
        assert.match(saved, /^<!-- docspec: solution-blueprint\/\d+\.\d+ -->/);
        assert.match(saved, /An edited blueprint\./);
    });

    test('SD-11: Markdown with parse rejections loads read-only', async () => {
        const s = store();
        const source = new SpecDocument();
        SpecEditor.forModel(source, service.model).setValue('SBP/content', 'Body.');
        const text = `${source.toMarkdown(service.model, 'D00SolutionBlueprint')}\n## <!--[NOPE]--> Not a section\n\nStray text.\n`;
        const doc = s.load(write('sd11.md', text));
        assert.ok(doc.rejections.length > 0);
        assert.match(doc.readOnlyReason ?? '', /rejected/);
        assert.equal((await refusal(s.save(doc))).code, 'readOnly');
    });

    test('SD-12: unknown format and unknown root are clear errors', () => {
        const s = store();
        assert.throws(() => s.load(write('sd12.txt', 'hello')), (e: unknown) => e instanceof SomDocumentError && e.code === 'unknownFormat');
        assert.throws(() => s.load(write('sd12.docspecs.yaml', MERIDIAN_YAML.replace('SBP D00SolutionBlueprint:', 'ZZZ Nothing:'))),
            (e: unknown) => e instanceof SomDocumentError && e.code === 'unknownRoot');
        assert.throws(() => s.load(path.join(tmp, 'missing.docspecs.yaml')), (e: unknown) => e instanceof SomDocumentError && e.code === 'notFound');
    });

    test('SD-13: save reports review entries whose path no longer resolves', async () => {
        const s = store();
        const text = `${MERIDIAN_YAML}review:\n  "SBP/noSuchSection":\n    comment: ok\n`;
        const doc = s.load(write('sd13.docspecs.yaml', text));
        const result = await s.save(doc, { dryRun: true });
        assert.deepEqual(result.staleReviewPaths, ['SBP/noSuchSection']);
    });

    test('SD-14: peek identifies a document from its header, null for anything else', () => {
        const s = store();
        const yaml = s.peek(write('sd14.docspecs.yaml', MERIDIAN_YAML));
        assert.deepEqual([yaml?.format, yaml?.root.sectionId, yaml?.stamp, yaml?.editability, yaml?.versionReason],
            ['yaml', 'SBP', SAMPLE_STAMP, SomEditability.editable, null]);
        const md = s.peek(write('sd14.md', MERIDIAN_MD));
        assert.deepEqual([md?.format, md?.root.sectionId, md?.stamp], ['markdown', 'SBP', stampOf(MERIDIAN_MD)]);
        const newer = s.peek(write('sd14n.docspecs.yaml', withStamp(MERIDIAN_YAML, '1.99')));
        assert.equal(newer?.editability, SomEditability.rejectedNewerMinor);
        assert.match(newer?.versionReason ?? '', /1\.99/);
        assert.equal(s.peek(write('sd14-plain.md', '# Notes\n\ntext\n')), null);
        assert.equal(s.peek(write('sd14-plain.yaml', 'key: value\n')), null);
        assert.equal(s.peek(write('sd14-unknown.docspecs.yaml', MERIDIAN_YAML.replace('SBP D00SolutionBlueprint:', 'ZZZ Nothing:'))), null);
        assert.equal(s.peek(path.join(tmp, 'missing.docspecs.yaml')), null);
        assert.equal(s.peek(write('sd14.txt', 'x')), null);
    });

    test('SD-15: create, and an empty YAML document keeps its root', async () => {
        const s = store();
        const yamlPath = path.join(tmp, 'sd15', 'new.docspecs.yaml');
        const created = await s.create(yamlPath, 'SBP');
        assert.match(fs.readFileSync(yamlPath, 'utf8'), /^document:\n {2}SBP D00SolutionBlueprint: \{\}$/m);
        assert.equal(created.root.sectionId, 'SBP');
        assert.equal(created.stamp, service.modelVersion);
        assert.equal(created.readOnlyReason, null);
        await assert.rejects(s.create(yamlPath, 'SBP'), (e: unknown) => e instanceof SomDocumentError && e.code === 'exists');

        const md = await s.create(path.join(tmp, 'sd15', 'new.md'), 'D00SolutionBlueprint');
        assert.deepEqual(md.fidelityProblems, []);
        assert.equal(md.readOnlyReason, null);

        const full = s.load(write('sd15-full.docspecs.yaml', MERIDIAN_YAML));
        full.document.removeValuesUnder('SBP');
        await s.save(full);
        const again = s.load(full.filePath);
        assert.equal(again.root.sectionId, 'SBP', 'a document cleared to nothing can still be loaded');
        assert.equal(again.document.isEmpty, true);
    });
});
