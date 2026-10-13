/**
 * TomSpecs (SOM) search — the runtime's SpecQueryEngine as two read-only
 * tools:
 *
 *   tomAi_specSearch         run a query over one document, return the first page and a cursor
 *   tomAi_specSearchIterate  the next page of an open cursor
 *
 * Editor counterparts: doc_search / doc_search_iterate. The query dimensions
 * (text or portable pattern, kinds, class, section id, path glob, @MapsTo /
 * @DetailedIn, empty / non-empty) are the runtime's, AND-combined; nothing
 * here re-implements matching.
 *
 * A cursor is the series' only state (SomSearchCursors). It remembers the
 * file revision its matches come from: when the file has changed by the next
 * iterate, the query is run again on the new content and the answer says so,
 * starting over from the first match, instead of handing out paths from a
 * document that no longer exists.
 */

import {
    SomPatternError,
    SpecNodeKind,
    SpecQuery,
    SpecQueryEngine,
    SpecStateFilter,
} from 'tom_som_typescript_runtime';
import type {
    SpecNodeKindValue,
    SpecQueryCursor,
    SpecQueryInit,
    SpecQueryMatch,
    SpecStateFilterValue,
} from 'tom_som_typescript_runtime';

import { SharedToolDefinition } from './shared-tool-registry';
import {
    FILE_PARAM,
    SpecToolDeps,
    documentHeader,
    failure,
    json,
    liveDeps,
    loadDocument,
    sharedCursors,
    toWorkspacePath,
    FIRST_LOOK,
} from './spec-tool-common';
import { SomSpecInspector } from '../services/som-spec-inspector';
import type { SearchCursorEntry } from '../services/som-search-cursors';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SpecSearchInput {
    file: string;
    text?: string;
    regex?: boolean;
    caseInsensitive?: boolean;
    kinds?: string[];
    className?: string;
    sectionIdExact?: string;
    sectionIdPrefix?: string;
    pathGlob?: string;
    mapsTo?: string;
    detailedIn?: string;
    state?: string;
    pageSize?: number;
}

export interface SpecSearchIterateInput {
    cursorId: string;
    pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
/** Snippets longer than this are cut to a window around the first match. */
export const SNIPPET_MAX = 320;
const SNIPPET_LEAD = 80;
const HEADLINE_MAX = 160;

const NODE_KINDS = Object.values(SpecNodeKind) as string[];
const STATES = Object.values(SpecStateFilter) as string[];

const PATTERN_SUBSET =
    'The pattern language is the runtime\'s portable subset, identical in every SOM runtime: `.` any character, '
    + '`*` `+` `?` greedy quantifiers, `[...]` / `[^...]` classes with ranges, `^` / `$` anchoring the whole value, '
    + '`\\` + punctuation for that character. There is no alternation, grouping or `{n}`: `(`, `)`, `|`, `{`, `}` '
    + 'match themselves. `\\d`, `\\w`, `\\s`, `\\b` and any other `\\` + letter or digit are rejected.';

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

interface MatchView {
    path: string;
    kind: string;
    classId?: string;
    headline?: string;
    snippet?: string;
    matchSpans?: Array<{ start: number; end: number }>;
    /** Present when the snippet is a window: where it starts in the matched value, and the value's length. */
    snippetOffset?: number;
    valueLength?: number;
}

function firstLine(text: string, max: number): string {
    const line = text.split('\n', 1)[0];
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A match as the agent sees it: a one-line headline, and a long snippet cut to a window around the first match. */
export function matchView(m: SpecQueryMatch): MatchView {
    const view: MatchView = { path: m.path, kind: m.kind };
    if (m.classId) { view.classId = m.classId; }
    if (m.headline) { view.headline = firstLine(m.headline, HEADLINE_MAX); }
    if (m.snippet === null) { return view; }
    const spans = m.matchSpans.map((s) => ({ start: s.start, end: s.end }));
    if (m.snippet.length <= SNIPPET_MAX) {
        view.snippet = m.snippet;
        if (spans.length > 0) { view.matchSpans = spans; }
        return view;
    }
    const start = Math.max(0, (spans[0]?.start ?? 0) - SNIPPET_LEAD);
    const end = Math.min(m.snippet.length, start + SNIPPET_MAX);
    view.snippet = m.snippet.slice(start, end);
    const inWindow = spans.filter((s) => s.start >= start && s.end <= end).map((s) => ({ start: s.start - start, end: s.end - start }));
    if (inWindow.length > 0) { view.matchSpans = inWindow; }
    view.snippetOffset = start;
    view.valueLength = m.snippet.length;
    return view;
}

function pageSizeOf(value: number | undefined): number {
    const n = Math.floor(Number(value ?? DEFAULT_PAGE_SIZE));
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

class SearchInputError extends Error {}

function queryInit(deps: SpecToolDeps, input: SpecSearchInput): SpecQueryInit {
    const init: SpecQueryInit = {};
    if (input.text !== undefined && input.text !== '') {
        init.text = input.text;
        init.regex = input.regex === true;
        init.caseInsensitive = input.caseInsensitive === true;
    } else if (input.regex) {
        throw new SearchInputError('`regex: true` needs a `text` pattern.');
    }
    if (input.kinds !== undefined) {
        const bad = input.kinds.filter((k) => !NODE_KINDS.includes(k));
        if (bad.length > 0) {
            throw new SearchInputError(`Unknown kind(s) ${bad.join(', ')}. Kinds: ${NODE_KINDS.join(', ')}.`);
        }
        init.kinds = new Set(input.kinds as SpecNodeKindValue[]);
    }
    if (input.state !== undefined) {
        if (!STATES.includes(input.state)) {
            throw new SearchInputError(`Unknown state '${input.state}'. States: ${STATES.join(', ')}.`);
        }
        init.state = input.state as SpecStateFilterValue;
    }
    if (input.className) {
        // An unknown class would just match nothing; say so, with the close names.
        try {
            new SomSpecInspector(deps.service, null).reflectClass(input.className, { brief: true });
        } catch (e) {
            throw new SearchInputError((e as Error).message);
        }
        init.className = input.className;
    }
    for (const key of ['sectionIdExact', 'sectionIdPrefix', 'pathGlob', 'mapsTo', 'detailedIn'] as const) {
        if (input[key]) { init[key] = input[key]; }
    }
    return init;
}

/** Run `init` over the file's current content. A pattern outside the subset throws SomPatternError. */
function runQuery(deps: SpecToolDeps, file: string, init: SpecQueryInit): { cursor: SpecQueryCursor; total: number; revision: string; loaded: ReturnType<typeof loadDocument> } {
    const loaded = loadDocument(deps, file);
    const cursor = new SpecQueryEngine(deps.service.model, loaded.document).query(new SpecQuery(init));
    return { cursor, total: cursor.count, revision: loaded.revision, loaded };
}

function searchFailure(e: unknown): string {
    if (e instanceof SomPatternError) {
        return json({ ok: false, code: 'patternError', error: e.message, subset: PATTERN_SUBSET });
    }
    if (e instanceof SearchInputError) {
        return json({ ok: false, code: 'invalidInput', error: e.message });
    }
    return failure(e);
}

// ---------------------------------------------------------------------------
// specSearch / specSearchIterate
// ---------------------------------------------------------------------------

export async function specSearchImpl(deps: SpecToolDeps, input: SpecSearchInput): Promise<string> {
    try {
        const cursors = deps.cursors ?? sharedCursors;
        const init = queryInit(deps, input);
        const { cursor, total, revision, loaded } = runQuery(deps, input.file, init);
        const page = cursor.take(pageSizeOf(input.pageSize));
        const remaining = total - page.length;
        let cursorId: string | undefined;
        if (remaining > 0) {
            const entry = cursors.add({ filePath: loaded.filePath, revision, query: init, cursor, total });
            entry.delivered = page.length;
            cursorId = entry.id;
        }
        return json({
            ok: true,
            document: documentHeader(deps, loaded),
            total,
            returned: page.length,
            remaining,
            done: remaining === 0,
            ...(cursorId ? { cursorId } : {}),
            matches: page.map(matchView),
        });
    } catch (e) {
        return searchFailure(e);
    }
}

const CURSOR_GONE: Record<string, string> = {
    unknown: 'No search cursor with this id. Run tomAi_specSearch again.',
    expired: 'This search cursor expired (cursors close after 10 minutes without use). Run tomAi_specSearch again.',
    evicted: 'This search cursor was closed to make room for newer ones (at most 32 stay open). Run tomAi_specSearch again.',
    exhausted: 'This search cursor has already returned every match.',
};

export async function specSearchIterateImpl(deps: SpecToolDeps, input: SpecSearchIterateInput): Promise<string> {
    const cursors = deps.cursors ?? sharedCursors;
    const lookup = cursors.get(input.cursorId);
    if (!lookup.found) {
        return json({ ok: false, code: `${lookup.reason}Cursor`, error: CURSOR_GONE[lookup.reason] });
    }
    const entry: SearchCursorEntry = lookup.entry;
    try {
        let rerun: Record<string, unknown> = {};
        const now = deps.store.currentRevision(entry.filePath);
        if (now !== entry.revision) {
            const fresh = runQuery(deps, entry.filePath, entry.query);
            rerun = {
                rerun: true,
                previousRevision: entry.revision,
                note: 'The file changed since the search was opened, so the query ran again on its current content and the matches start over from the first.',
            };
            entry.cursor = fresh.cursor;
            entry.total = fresh.total;
            entry.revision = fresh.revision;
            entry.delivered = 0;
        }
        const page = entry.cursor.take(pageSizeOf(input.pageSize));
        entry.delivered += page.length;
        const remaining = entry.total - entry.delivered;
        if (remaining <= 0) { cursors.finish(entry.id); }
        return json({
            ok: true,
            cursorId: entry.id,
            ...rerun,
            document: { file: toWorkspacePath(deps, entry.filePath), revision: entry.revision },
            total: entry.total,
            returned: page.length,
            remaining: Math.max(remaining, 0),
            done: remaining <= 0,
            matches: page.map(matchView),
        });
    } catch (e) {
        cursors.finish(entry.id);
        return searchFailure(e);
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const SPEC_SEARCH_TOOL: SharedToolDefinition<SpecSearchInput> = {
    name: 'tomAi_specSearch',
    displayName: 'Spec: Search',
    description:
        'Search one TomSpecs document (`*.docspecs.yaml` or SOM `*.md`) with the runtime\'s query engine. All given '
        + 'filters are AND-combined: `text` over content, form values and headlines (a node\'s stored headline, else its '
        + 'model doc comment), `kinds`, `className` (a list item\'s or section\'s model class), `sectionIdExact` / '
        + '`sectionIdPrefix` (the model\'s @SectionId — a list item\'s own stored id is not matched), `pathGlob` '
        + '(`*` within one segment, `**` across), `mapsTo` / `detailedIn` (a root type such as `D03InformationModel`), '
        + 'and `state` (`empty` / `nonEmpty`; review state is not searchable). Returns `total`, the first page of matches '
        + '`{path, kind, classId, headline, snippet, matchSpans}` and, when more remain, a `cursorId` for '
        + 'tomAi_specSearchIterate. A snippet longer than 320 characters is a window around the first match, with '
        + '`snippetOffset` and `valueLength`; spans are relative to the snippet. With `regex: true`, `text` is a pattern: '
        + PATTERN_SUBSET + ' A rejected pattern returns `code: "patternError"`.' + FIRST_LOOK + ' Editor counterpart: doc_search.',
    tags: ['tomspecs', 'som', 'docspecs', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            file: FILE_PARAM,
            text: { type: 'string', description: 'Substring (or, with `regex`, a portable pattern) to find in values and headlines.' },
            regex: { type: 'boolean', description: 'Read `text` as a portable pattern (see the description). Default false.' },
            caseInsensitive: { type: 'boolean', description: 'Match `text` ignoring case. Default false.' },
            kinds: { type: 'array', items: { type: 'string', enum: NODE_KINDS }, description: 'Node kinds to keep.' },
            className: { type: 'string', description: 'Model class of the node, e.g. `FunctionalRequirementEntry`.' },
            sectionIdExact: { type: 'string', description: 'The model @SectionId, exactly (e.g. `FRE`).' },
            sectionIdPrefix: { type: 'string', description: 'A @SectionId prefix (e.g. `FRE-`).' },
            pathGlob: { type: 'string', description: 'Path glob: `*` within a segment, `**` across segments, e.g. `SBP/introductionAndScope/**`.' },
            mapsTo: { type: 'string', description: '@MapsTo target (a document root type, e.g. `D03InformationModel`).' },
            detailedIn: { type: 'string', description: '@DetailedIn target (a document root type).' },
            state: { type: 'string', enum: STATES, description: '`empty`: nodes holding no value; `nonEmpty`: nodes holding one.' },
            pageSize: { type: 'number', description: `Matches per page. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.` },
        },
        required: ['file'],
    },
    execute: async (input) => specSearchImpl(liveDeps(), input),
};

export const SPEC_SEARCH_ITERATE_TOOL: SharedToolDefinition<SpecSearchIterateInput> = {
    name: 'tomAi_specSearchIterate',
    displayName: 'Spec: Search (next page)',
    description:
        'The next page of a tomAi_specSearch cursor: `{total, returned, remaining, done, matches}`. Every match is '
        + 'returned exactly once across the pages; when `done` is true the cursor is closed. If the file changed since '
        + 'the search was opened, the query runs again on the new content and the answer carries `rerun: true` and '
        + 'starts over from the first match. Cursors close after 10 minutes without use, and at most 32 stay open; a '
        + 'closed or unknown cursor returns `code` `expiredCursor` / `evictedCursor` / `exhaustedCursor` / '
        + '`unknownCursor`.' + FIRST_LOOK + ' Editor counterpart: doc_search_iterate.',
    tags: ['tomspecs', 'som', 'docspecs', 'search', 'tom-ai-chat'],
    readOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            cursorId: { type: 'string', description: 'The `cursorId` tomAi_specSearch returned.' },
            pageSize: { type: 'number', description: `Matches per page. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.` },
        },
        required: ['cursorId'],
    },
    execute: async (input) => specSearchIterateImpl(liveDeps(), input),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SPEC_SEARCH_TOOLS: SharedToolDefinition<any>[] = [
    SPEC_SEARCH_TOOL,
    SPEC_SEARCH_ITERATE_TOOL,
];
