/**
 * TomSpecs search tools (vsctsa4): specSearch and specSearchIterate over a
 * copy of the Meridian sample.
 *
 *   SS-1   text: case-sensitive and case-insensitive, spans point at the text
 *   SS-2   kinds
 *   SS-3   className, and an unknown class is an input error naming close classes
 *   SS-4   sectionIdExact and sectionIdPrefix (the model's @SectionId)
 *   SS-5   pathGlob, `**` and `*`
 *   SS-6   mapsTo and detailedIn
 *   SS-7   state empty / nonEmpty
 *   SS-8   several filters AND-combine
 *   SS-9   a 200+ match result walked page by page: every match exactly once, then closed
 *   SS-10  unknown, expired and evicted cursors are clear errors
 *   SS-11  iterating after the file changed re-runs the query and says so
 *   SS-12  patterns: the subset works; a full-regex construct is rejected with the subset text
 *   SS-13  a long snippet is a window around the match; invalid input is refused
 *   SS-14  both tools are read-only
 */

import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installVscodeStub } from './_vscode-stub.js';
import { withTiming } from './_timing.js';
installVscodeStub({});

import { SpecQuery, SpecQueryEngine } from 'tom_som_typescript_runtime';
import type { SpecQueryInit } from 'tom_som_typescript_runtime';
import { SomModelService } from '../../services/som-model-service.js';
import { SomDocumentStore } from '../../services/som-document-store.js';
import { SomSearchCursors } from '../../services/som-search-cursors.js';
import type { SpecToolDeps } from '../spec-tool-common.js';
import { SPEC_SEARCH_TOOLS, specSearchImpl, specSearchIterateImpl } from '../spec-search-tools.js';

const SAMPLES = path.resolve(__dirname, '..', '..', '..', '..', '..', 'ai_build', 'tom_som_dart_v0', 'documents');
const MERIDIAN_YAML = fs.readFileSync(path.join(SAMPLES, 'meridian_order_management.docspecs.yaml'), 'utf8');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-search-'));
const FILE = 'meridian.docspecs.yaml';
fs.writeFileSync(path.join(ws, FILE), MERIDIAN_YAML);

const service = SomModelService.instance;
const store = new SomDocumentStore(service);
const deps: SpecToolDeps = { wsRoot: ws, store, service, cursors: new SomSearchCursors() };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const search = async (input: object, d: SpecToolDeps = deps): Promise<Json> => JSON.parse(await specSearchImpl(d, { file: FILE, ...input }));
const iterate = async (cursorId: string, pageSize?: number, d: SpecToolDeps = deps): Promise<Json> =>
    JSON.parse(await specSearchIterateImpl(d, { cursorId, pageSize }));

/** What the runtime itself returns for `init` on the sample: the tools must agree with it. */
function runtimeMatches(init: SpecQueryInit): string[] {
    const doc = store.load(path.join(ws, FILE)).document;
    return new SpecQueryEngine(service.model, doc).query(new SpecQuery(init)).toList().map((m) => m.path);
}

/** Every match of a search, all pages. */
async function allPaths(input: object): Promise<string[]> {
    const first = await search({ ...input, pageSize: 100 });
    assert.equal(first.ok, true, JSON.stringify(first));
    const paths: string[] = first.matches.map((m: Json) => m.path);
    let cursorId = first.cursorId;
    while (cursorId) {
        const page = await iterate(cursorId, 100);
        paths.push(...page.matches.map((m: Json) => m.path));
        cursorId = page.done ? undefined : cursorId;
    }
    assert.equal(paths.length, first.total);
    return paths;
}

describe('TomSpecs search tools', () => {
    before(() => { void service.model; });

    test('SS-1: text search, with and without case', async () => {
        const r = JSON.parse(await withTiming('tomAi_specSearch:typical', () =>
            specSearchImpl(deps, { file: FILE, text: 'Order', pageSize: 10 })));
        assert.equal(r.ok, true);
        assert.match(r.document.revision, /^[0-9a-f]{64}$/);
        assert.ok(r.total > 0);
        for (const m of r.matches) {
            for (const s of m.matchSpans ?? []) { assert.equal(m.snippet.slice(s.start, s.end), 'Order'); }
        }
        const insensitive = await search({ text: 'order', caseInsensitive: true });
        assert.ok(insensitive.total > r.total, 'ignoring case finds more');
        assert.equal(insensitive.total, runtimeMatches({ text: 'order', caseInsensitive: true }).length);
    });

    test('SS-2: kinds', async () => {
        const paths = await allPaths({ kinds: ['listItemComplex'] });
        assert.deepEqual(paths, runtimeMatches({ kinds: new Set(['listItemComplex']) }));
        assert.ok(paths.length > 100);
        assert.ok(paths.every((p) => service.reflection.resolve(p)?.kind === 'listItemComplex'));
    });

    test('SS-3: className, and an unknown class', async () => {
        const r = await search({ className: 'FunctionalRequirementEntry', pageSize: 100 });
        assert.ok(r.total > 0);
        assert.ok(r.matches.every((m: Json) => m.classId === 'FunctionalRequirementEntry'));
        const bad = await search({ className: 'FunctionalRequirement' });
        assert.equal(bad.code, 'invalidInput');
        assert.match(bad.error, /Similar: .*FunctionalRequirementEntry/);
    });

    test('SS-4: sectionIdExact and sectionIdPrefix', async () => {
        const exact = await allPaths({ sectionIdExact: 'FRED' });
        assert.ok(exact.length > 0);
        assert.ok(exact.every((p) => p.endsWith('/FRED')));
        const prefix = await allPaths({ sectionIdPrefix: 'FRE' });
        assert.ok(prefix.length > exact.length);
        assert.ok(exact.every((p) => prefix.includes(p)));
        assert.deepEqual(prefix, runtimeMatches({ sectionIdPrefix: 'FRE' }));
    });

    test('SS-5: pathGlob', async () => {
        const deep = await allPaths({ pathGlob: 'SBP/introductionAndScope/**' });
        assert.ok(deep.length > 0 && deep.every((p) => p.startsWith('SBP/introductionAndScope/')));
        const shallow = await allPaths({ pathGlob: 'SBP/introductionAndScope/*' });
        assert.ok(shallow.length > 0 && shallow.every((p) => p.split('/').length === 3));
        assert.ok(shallow.length < deep.length);
    });

    test('SS-6: mapsTo and detailedIn', async () => {
        const doc = store.load(path.join(ws, FILE)).document;
        const projections = [...new SpecQueryEngine(service.model, doc).projectNodes()];
        const mapsTo = projections.find((p) => p.mapsTo)?.mapsTo as string;
        const detailedIn = projections.find((p) => p.detailedIn)?.detailedIn as string;
        assert.ok(mapsTo && detailedIn, 'the sample carries both annotations');
        const m = await allPaths({ mapsTo });
        assert.deepEqual(m, projections.filter((p) => p.mapsTo === mapsTo).map((p) => p.path));
        const d = await allPaths({ detailedIn });
        assert.deepEqual(d, projections.filter((p) => p.detailedIn === detailedIn).map((p) => p.path));
    });

    test('SS-7: state', async () => {
        const nonEmpty = await search({ state: 'nonEmpty' });
        const empty = await search({ state: 'empty' });
        // The worst case: no filter, every node of the document is a candidate.
        const all = JSON.parse(await withTiming('tomAi_specSearch:all-nodes', () => specSearchImpl(deps, { file: FILE })));
        assert.equal(nonEmpty.total + empty.total, all.total);
        assert.ok(nonEmpty.total > 0 && empty.total > 0);
    });

    test('SS-8: filters AND-combine', async () => {
        const both = await allPaths({ className: 'FunctionalRequirementEntry', text: 'order', caseInsensitive: true });
        const byClass = await allPaths({ className: 'FunctionalRequirementEntry' });
        const byText = await allPaths({ text: 'order', caseInsensitive: true });
        assert.ok(both.length > 0);
        assert.deepEqual(both, byClass.filter((p) => byText.includes(p)));
    });

    test('SS-9: a 200+ match result is walked page by page, each match exactly once', async () => {
        const expected = runtimeMatches({ text: 'e', caseInsensitive: true });
        assert.ok(expected.length >= 200, `the walk needs 200+ matches, got ${expected.length}`);
        const first = await search({ text: 'e', caseInsensitive: true, pageSize: 37 });
        assert.equal(first.total, expected.length);
        assert.equal(first.returned, 37);
        assert.equal(first.remaining, expected.length - 37);
        const seen: string[] = first.matches.map((m: Json) => m.path);
        let pages = 1;
        let last: Json = first;
        while (!last.done) {
            last = JSON.parse(await withTiming('tomAi_specSearchIterate:typical', () =>
                specSearchIterateImpl(deps, { cursorId: first.cursorId, pageSize: 37 })));
            assert.equal(last.ok, true);
            assert.equal(last.total, expected.length);
            seen.push(...last.matches.map((m: Json) => m.path));
            assert.equal(last.remaining, expected.length - seen.length);
            pages++;
        }
        assert.deepEqual(seen, expected);
        assert.equal(new Set(seen).size, seen.length);
        assert.equal(pages, Math.ceil(expected.length / 37));
        assert.equal((await iterate(first.cursorId)).code, 'exhaustedCursor');

        const small = await search({ sectionIdExact: 'FRED', pageSize: 100 });
        assert.equal(small.done, true);
        assert.equal(small.cursorId, undefined, 'a result that fits one page opens no cursor');
    });

    test('SS-10: unknown, expired and evicted cursors', async () => {
        assert.equal((await iterate('sc-000000000000')).code, 'unknownCursor');

        let t = 0;
        const timed: SpecToolDeps = { ...deps, cursors: new SomSearchCursors(() => t, 10 * 60 * 1000, 1) };
        const a = await search({ text: 'order', pageSize: 1 }, timed);
        t += 10 * 60 * 1000 + 1;
        const expired = await iterate(a.cursorId, 1, timed);
        assert.equal(expired.code, 'expiredCursor');
        assert.match(expired.error, /10 minutes/);

        const b = await search({ text: 'order', pageSize: 1 }, timed);
        await search({ text: 'Order', pageSize: 1 }, timed); // cap 1: b is evicted
        const evicted = await iterate(b.cursorId, 1, timed);
        assert.equal(evicted.code, 'evictedCursor');
    });

    test('SS-11: iterating after the file changed re-runs the query', async () => {
        const file = 'changing.docspecs.yaml';
        fs.writeFileSync(path.join(ws, file), MERIDIAN_YAML);
        const first = JSON.parse(await specSearchImpl(deps, { file, text: 'order', pageSize: 2 }));
        assert.ok(first.total > 2);
        // Keep exactly one occurrence of the searched word.
        fs.writeFileSync(path.join(ws, file), MERIDIAN_YAML.replace(/order/g, 'zzzzz').replace('zzzzz', 'order'));
        const next = await iterate(first.cursorId, 2);
        assert.equal(next.ok, true);
        assert.equal(next.rerun, true);
        assert.equal(next.previousRevision, first.document.revision);
        assert.notEqual(next.document.revision, first.document.revision);
        assert.match(next.note, /changed/);
        // Headlines include model doc comments, which still say "order"; the file's own values now say it once.
        const changed = store.load(path.join(ws, file)).document;
        const expected = new SpecQueryEngine(service.model, changed).query(new SpecQuery({ text: 'order' })).toList().map((m) => m.path);
        assert.ok(expected.length < first.total);
        assert.equal(next.total, expected.length, 'the query ran on the new content');
        assert.deepEqual(next.matches.map((m: Json) => m.path), expected.slice(0, 2), 'and starts over from the first match');
    });

    test('SS-12: patterns', async () => {
        const anchored = await search({ text: '^The system must accept', regex: true });
        assert.equal(anchored.total, 1);
        const classes = await search({ text: 'FR-0[1-3] ', regex: true, pageSize: 100 });
        assert.ok(classes.total >= 3);
        const rejected = await search({ text: 'FR-\\d+', regex: true });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.code, 'patternError');
        assert.match(rejected.error, /outside the portable subset/);
        assert.match(rejected.subset, /no alternation, grouping/);
        // Without `regex` the same text is a plain substring and simply matches nothing.
        assert.equal((await search({ text: 'FR-\\d+' })).total, 0);
    });

    test('SS-13: long snippets are windowed; invalid input is refused', async () => {
        const r = await search({ text: 'are derived', pathGlob: 'SBP/content' });
        assert.equal(r.total, 1);
        const m = r.matches[0];
        assert.ok(m.valueLength > 320, 'SBP/content is longer than one snippet');
        assert.ok(m.snippetOffset > 0, 'the window starts before the match, not at the value start');
        assert.ok(m.snippet.length <= 320);
        const span = m.matchSpans[0];
        assert.equal(m.snippet.slice(span.start, span.end), 'are derived');
        assert.ok(!m.headline.includes('\n'));

        assert.equal((await search({ kinds: ['chapter'] })).code, 'invalidInput');
        assert.equal((await search({ state: 'reviewed' })).code, 'invalidInput');
        assert.equal((await search({ regex: true })).code, 'invalidInput');
        assert.equal((await search({ file: 'missing.docspecs.yaml' })).code, 'notFound');
    });

    test('SS-14: both tools are read-only', () => {
        assert.deepEqual(SPEC_SEARCH_TOOLS.map((t) => t.name), ['tomAi_specSearch', 'tomAi_specSearchIterate']);
        assert.ok(SPEC_SEARCH_TOOLS.every((t) => t.readOnly && !t.requiresApproval));
    });
});
