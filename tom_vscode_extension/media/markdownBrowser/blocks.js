// Markdown Browser — source mapping for in-place editing.
//
// Pure string logic with no DOM and no `vscode` handle, kept in its own file so
// it can be loaded into a bare `vm` sandbox and unit-tested directly
// (src/utils/__tests__/mdBrowserBlocks.test.ts). Loaded as a classic script
// before main.js; the declarations below are globals main.js calls. The question
// and answer parser is media/shared/mdQuestions.js, loaded before this file and
// shared with the extension host (src/utils/mdQuestions.ts).
/* exported mdbCriticMark, mdbEditInlineComment, mdbChangeQuote, mdbChangeWithComment, mdbQuoteMatches, mdbCountLabel, mdbIsCommentLine, mdbCommentAt, mdbNextCommentId, mdbInRanges, mdbWriteComment, mdbSplitForLexing, mdbSectionRefs, mdbResolveSectionRef, mdbSectionAnchorIndex, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbFoldHidden, mdbFoldAncestors, mdbFoldLevelGroups, mdbIndentDepths, mdbGroups, mdbNavPick, mdbRevealDelta, MDB_LONG_COMMENT, MDB_CHECK_HERE, mdbIsAgentAuthor, mdbCommentAuthor, mdbCommentHeader, mdbCommentBody, mdbAttribution, MDB_CHANGE_TIME, MDB_CHANGE_TIMES, mdbLatestChangeTime, mdbChangeTimeLabel, MDB_READING_KINDS, mdbReadingFence, mdbReadingDivEnd, mdbReadingDivToken, mdbReadingBlockStart, mdbReadingSpan, mdbCitation, mdbReadingKey, mdbReadingMode */
//
// The browser renders the backend's transformed text. Without the CR/LF
// conversion that transform keeps every line where it is (it only rewrites
// heading lines), so a line number here is a line number in the file.

/**
 * Block types that get edit / insert buttons in edit mode.
 * @type {Record<string, boolean>}
 */
var MDB_EDITABLE_TYPES = { paragraph: true, list: true, blockquote: true, table: true, code: true, readingDiv: true };

/**
 * The top-level blocks of `text` with their line ranges.
 *
 * `tokens` is marked's lexer output for the same text. A token's `raw` is
 * found by searching forward from the end of the previous one, because the
 * lexer drops some source (link definitions) without a token, so the raws do
 * not simply add up to the text.
 *
 * @param {string} text
 * @param {Array<{type: string, raw: string}>} tokens
 * @returns {Array<{index: number, type: string, startLine: number, endLine: number, editable: boolean}>}
 *   `endLine` is exclusive and stops before trailing blank lines.
 */
function mdbBlocks(text, tokens) {
    var src = String(text || '').replace(/\r\n|\r/g, '\n');
    var cursor = 0;
    var line = 0;
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
        var raw = tokens[i].raw || '';
        if (!raw) { continue; }
        var at = src.indexOf(raw, cursor);
        if (at < 0) { continue; }
        line += countNewlines(src, cursor, at);
        var body = raw.replace(/\n+$/, '');
        var lines = body.length ? body.split('\n').length : 0;
        if (tokens[i].type !== 'space' && lines > 0) {
            out.push({
                index: i,
                type: tokens[i].type,
                startLine: line,
                endLine: line + lines,
                editable: MDB_EDITABLE_TYPES[tokens[i].type] === true,
            });
        }
        line += countNewlines(src, at, at + raw.length);
        cursor = at + raw.length;
    }
    return out;
}

/**
 * @param {string} src
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function countNewlines(src, from, to) {
    var n = 0;
    for (var i = from; i < to; i++) { if (src.charCodeAt(i) === 10) { n++; } }
    return n;
}

/**
 * The count shown beside the search and the navigation arrows: which match is
 * current and how many there are — `147/356`; `–/356` before the first step;
 * `0/0` when nothing matches.
 *
 * @param {number} index the current match, 0-based; -1 for none
 * @param {number} total
 * @returns {string}
 */
function mdbCountLabel(index, total) {
    if (total <= 0) { return '0/0'; }
    return (index >= 0 ? String(index + 1) : '–') + '/' + total;
}

// ---- Folding ----
// The document as a flat list in reading order: a heading entry carries its
// level and its own `folded` flag, content entries have level null. A heading
// opens a section that runs to the next heading of the same or a higher
// level. Folding is a property of one heading: an entry is hidden when any
// heading it sits under is folded, so folding and unfolding a section never
// changes the flags of the headings inside it.

/**
 * @typedef {{ level: number | null, folded?: boolean }} MdbFoldEntry
 */

/**
 * The entries a folded section hides.
 *
 * @param {MdbFoldEntry[]} entries
 * @returns {boolean[]}
 */
function mdbFoldHidden(entries) {
    /** @type {MdbFoldEntry[]} */
    var stack = [];
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.level !== null && e.level !== undefined) {
            while (stack.length && /** @type {number} */ (stack[stack.length - 1].level) >= e.level) { stack.pop(); }
        }
        out.push(stack.some(function(s) { return s.folded === true; }));
        if (e.level !== null && e.level !== undefined) { stack.push(e); }
    }
    return out;
}

/**
 * The indices of the folded headings `index` sits under — the ones to unfold
 * to make it visible.
 *
 * @param {MdbFoldEntry[]} entries
 * @param {number} index
 * @returns {number[]}
 */
function mdbFoldAncestors(entries, index) {
    /** @type {number[]} */
    var stack = [];
    var target = entries[index];
    for (var i = 0; i < index; i++) {
        var lvl = entries[i].level;
        if (lvl !== null && lvl !== undefined) {
            while (stack.length && /** @type {number} */ (entries[stack[stack.length - 1]].level) >= lvl) { stack.pop(); }
            stack.push(i);
        }
    }
    if (target && target.level !== null && target.level !== undefined) {
        var own = target.level;
        stack = stack.filter(function(s) { return /** @type {number} */ (entries[s].level) < own; });
    }
    return stack.filter(function(s) { return entries[s].folded === true; });
}

/**
 * For each heading, the sections its +/- buttons open and collapse
 * (vscimpb100): the headings of its own level whose parent section is its
 * parent (the nearest shallower heading before it; none for the document's
 * top level) — itself included, in document order — and that parent's index
 * (-1: the document). Null for an entry that is no heading. Other levels are
 * not part of a group, so their flags stay as they are.
 *
 * @param {MdbFoldEntry[]} entries
 * @returns {Array<{ members: number[], parent: number } | null>}
 */
function mdbFoldLevelGroups(entries) {
    /** @type {number[]} */
    var stack = [];
    /** @type {Object<string, { members: number[], parent: number }>} */
    var groups = {};
    /** @type {Array<{ members: number[], parent: number } | null>} */
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var lvl = entries[i].level;
        if (lvl === null || lvl === undefined) { out.push(null); continue; }
        while (stack.length && /** @type {number} */ (entries[stack[stack.length - 1]].level) >= lvl) { stack.pop(); }
        var parent = stack.length ? stack[stack.length - 1] : -1;
        var key = parent + '|' + lvl;
        if (!groups[key]) { groups[key] = { members: [], parent: parent }; }
        groups[key].members.push(i);
        out.push(groups[key]);
        stack.push(i);
    }
    return out;
}

// ---- Indentation ----

/**
 * The indent depth of each entry when the document is indented by heading
 * level: a heading of level L sits at L - 1, the content of its section one
 * step deeper, at L; content before the first heading stays at 0.
 *
 * @param {Array<{ level: number | null }>} entries
 * @returns {number[]}
 */
function mdbIndentDepths(entries) {
    var current = 0;
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var level = entries[i].level;
        if (level !== null && level !== undefined) {
            current = level;
            out.push(level - 1);
        } else {
            out.push(current);
        }
    }
    return out;
}

// ---- Grouping ----

/**
 * Elements that never take a closing tag.
 * @type {Record<string, number>}
 */
var MDB_VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };

/**
 * How far an html token changes the open-element depth: +1 per opening tag,
 * -1 per closing tag; comments, void and self-closing tags count nothing.
 *
 * @param {string} raw
 * @returns {number}
 */
function mdbHtmlDepthChange(raw) {
    var text = String(raw || '').replace(/<!--[\s\S]*?-->/g, '');
    var re = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
    var depth = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
        if (m[1]) { depth--; continue; }
        if (m[3] || MDB_VOID_TAGS[m[2].toLowerCase()] === 1) { continue; }
        depth++;
    }
    return depth;
}

/**
 * The top-level tokens grouped for rendering: a token on its own, except that
 * an html token opening an element (`<details>`) takes every following token
 * up to the one that closes it. Rendering such a run in one piece keeps the
 * element whole — wrapped one by one, `<details>` would close at the end of
 * its own wrapper and lose its content.
 *
 * @param {Array<{type: string, raw: string}>} tokens
 * @returns {Array<[number, number]>} inclusive index ranges, in order
 */
function mdbGroups(tokens) {
    /** @type {Array<[number, number]>} */
    var out = [];
    var i = 0;
    while (i < tokens.length) {
        var start = i;
        var depth = tokens[i].type === 'html' ? Math.max(0, mdbHtmlDepthChange(tokens[i].raw)) : 0;
        while (depth > 0 && i + 1 < tokens.length) {
            i++;
            if (tokens[i].type === 'html') { depth = Math.max(0, depth + mdbHtmlDepthChange(tokens[i].raw)); }
        }
        out.push([start, i]);
        i++;
    }
    return out;
}

// ---- Links in plain text ----

/** A DocSpecs section id: upper case letters and digits, `-`-separated. */
var MDB_SECTION_ID = '[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*';

/** A single section id is taken for a reference when it has more letters than this (digits and `-` not counted). */
var MDB_SINGLE_ID_MIN_LETTERS = 5;

/**
 * The section references in `text`, outer first: two or more section ids
 * joined by `>` (`OUTER > INNER`), or a single all-uppercase id with more
 * than four letters (`PLTPLN`, `ASMRE-ASMP-PERSONA-ARCHETYPES`). Shorter
 * single words (`HTTP`, `TODO`) are left alone. The caller links only those
 * that name a heading of the document.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, ids: string[]}>}
 */
function mdbSectionRefs(text) {
    var re = new RegExp('(?<![A-Za-z0-9-])' + MDB_SECTION_ID + '(?:[ \\t]*>[ \\t]*' + MDB_SECTION_ID + ')*(?![A-Za-z0-9-])', 'g');
    var out = [];
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
        var ids = m[0].split('>').map(function(s) { return s.trim(); });
        if (ids.length === 1 && (ids[0].match(/[A-Z]/g) || []).length < MDB_SINGLE_ID_MIN_LETTERS) { continue; }
        out.push({ start: m.index, end: m.index + m[0].length, ids: ids });
    }
    return out;
}

/**
 * The section id a table row is anchored at (reading_view, 05b_rdv1): the first
 * word of its first cell's text when it is a section id with a `-` (`ACE-CRIT-3`,
 * `KEATT-REFE-REF`), else ''. A section table's first cell, a records table's
 * `Id` cell.
 *
 * @param {string} text
 * @returns {string}
 */
function mdbRowAnchorId(text) {
    var first = String(text || '').trim().split(/\s+/)[0] || '';
    return new RegExp('^' + MDB_SECTION_ID + '$').test(first) && first.indexOf('-') > 0 ? first : '';
}

/**
 * The heading a section reference points at, as an index into `fullIds` (the
 * dotted id paths of the headings, in document order): the first whose last
 * segment is the reference's last id and whose segments hold the outer ids in
 * order; failing that, the first whose last segment is the last id; else -1.
 *
 * @param {string[]} ids
 * @param {string[]} fullIds
 * @returns {number}
 */
function mdbResolveSectionRef(ids, fullIds) {
    var last = ids[ids.length - 1];
    var fallback = -1;
    for (var i = 0; i < fullIds.length; i++) {
        var segs = fullIds[i].split('.');
        if (segs[segs.length - 1] !== last) { continue; }
        if (fallback < 0) { fallback = i; }
        // The outer ids, in order, among the segments above the last.
        var found = 0;
        for (var j = 0; j < segs.length - 1 && found < ids.length - 1; j++) {
            if (segs[j] === ids[found]) { found++; }
        }
        if (found === ids.length - 1) { return i; }
    }
    return fallback;
}

/**
 * The heading an anchor names as a section id (vscimpb150): `#TOKEN` is the
 * last id of a heading's dotted full id (`<!--[TOKEN]-->`), case-sensitive;
 * a dotted anchor (`#SBP.STKG.TOENV`) is a full id, matched as a whole.
 * Several headings with that last id (the same id under different parents):
 * the first in document order, as a section reference without context. The
 * index into `fullIds` (document order), or -1.
 *
 * @param {string} anchor
 * @param {string[]} fullIds
 * @returns {number}
 */
function mdbSectionAnchorIndex(anchor, fullIds) {
    if (!anchor) { return -1; }
    var dotted = anchor.indexOf('.') >= 0;
    for (var i = 0; i < fullIds.length; i++) {
        var full = fullIds[i] || '';
        if (!full) { continue; }
        if (dotted) {
            if (full === anchor) { return i; }
        } else if (full.slice(full.lastIndexOf('.') + 1) === anchor) {
            return i;
        }
    }
    return -1;
}

/**
 * Paths to Markdown files written as plain text (`iterations/notes.md`,
 * `../a.md`, `notes.md`), not part of a URL or a longer word.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, path: string}>}
 */
function mdbMdPaths(text) {
    var re = /(?<![\w./:@~-])((?:\.{1,2}\/)*(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.md)(?![\w/-])/gi;
    var out = [];
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, path: m[0] });
    }
    return out;
}

/**
 * Whether a link points at a Markdown document (not a URL, not an anchor in
 * this one).
 *
 * @param {string} href
 * @returns {boolean}
 */
function mdbIsMdLink(href) {
    var h = String(href || '');
    if (!h || h.charAt(0) === '#' || /^[a-z][a-z0-9+.-]*:/i.test(h)) { return false; }
    return /\.md$/i.test(h.split('#')[0].split('?')[0]);
}

// ---- Lexing a document in parts ----
// marked's block rules are `^`-anchored patterns with counted groups, which
// JavaScriptCore (WebKit) runs at every position of the rest of the input: one
// rule call costs time in proportion to the text left, so lexing a part is
// O(n²) in its length there (a 150,000-character part about 2 s, Chrome 10 ms).
// The page therefore lexes in small parts (main.js LEX_PART_CHARS).

/** A list item's marker at column 0: a following item would continue (and loosen) the list before it. */
var MDB_LIST_MARKER = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * `text` cut into parts of at least `target` characters, so lexing the parts
 * one by one gives the tokens of lexing the whole (link definitions aside,
 * which the caller merges). A part starts
 *
 * - at an ATX heading line (a heading always starts a block of its own; a
 *   reading-notation div never crosses one), or
 * - at a safe block boundary: a line at column 0 after a blank line that is
 *   no list item (it would continue the list before it) — so never an
 *   indented or lazy continuation line, nor inside a list item —
 *
 * and never inside fenced code, an open html element or a reading-notation
 * div (`:::`), which may hold blank lines. The parts joined with `\n` are
 * `text`.
 *
 * @param {string} text
 * @param {number} target
 * @returns {Array<{startLine: number, text: string}>}
 */
function mdbSplitForLexing(text, target) {
    var lines = String(text || '').split('\n');
    var parts = [];
    var start = 0;
    var size = 0;
    var fence = null;
    var htmlDepth = 0;
    var divDepth = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence !== null) {
            // A closing fence: the same character, at least as long, nothing after it.
            if (f && f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) { fence = null; }
        } else if (f) {
            fence = f[1];
        } else {
            var heading = /^#{1,6}(\s|$)/.test(line);
            if (heading) { divDepth = 0; }
            var free = i > start && size >= target && htmlDepth === 0 && divDepth === 0;
            var boundary = heading
                || (/^\S/.test(line) && lines[i - 1] !== undefined && lines[i - 1].trim() === '' && !MDB_LIST_MARKER.test(line));
            if (free && boundary) {
                parts.push({ startLine: start, text: lines.slice(start, i).join('\n') });
                start = i;
                size = 0;
            }
            if (/^ {0,3}</.test(line)) { htmlDepth = Math.max(0, htmlDepth + mdbHtmlDepthChange(line)); }
            if (mdbReadingFence(line)) { divDepth++; } else if (divDepth > 0 && MDB_READING_CLOSE.test(line)) { divDepth--; }
        }
        size += line.length + 1;
    }
    parts.push({ startLine: start, text: lines.slice(start).join('\n') });
    return parts;
}

// ---- Reviewer comment blocks ----
// A comment block is a blockquote whose first line starts with the upward
// arrow (U+2B06, with or without U+FE0F): `> ⬆️ **C-12** (Alexis): text`. Id
// and author are optional; ids are `C-<n>`, numbered per document, a missing
// one being the document's highest + 1 (tom_specs annot1). The block ends at
// the first line without `>` and holds only the comment.

/** The first line of a comment block. */
var MDB_COMMENT_START = /^ {0,3}> ?⬆️?/;
/** A blockquote line, and its `>` prefix. */
var MDB_QUOTE_LINE = /^ {0,3}> ?/;
/** The arrow at the start of a comment's text (the `>` removed). */
var MDB_COMMENT_ARROW = /^\s*⬆️?/;

/**
 * @param {string} line
 * @returns {boolean} whether `line` starts a comment block
 */
function mdbIsCommentLine(line) {
    return MDB_COMMENT_START.test(String(line || ''));
}

/**
 * The comment block starting at `line`: its line range (end exclusive) and its
 * text with the `> ` prefixes removed; null when no comment starts there.
 *
 * @param {string[]} lines
 * @param {number} line
 * @returns {{startLine: number, endLine: number, text: string} | null}
 */
function mdbCommentAt(lines, line) {
    if (!mdbIsCommentLine(lines[line])) { return null; }
    var end = line;
    var text = [];
    while (end < lines.length && MDB_QUOTE_LINE.test(lines[end])) {
        text.push(lines[end].replace(MDB_QUOTE_LINE, ''));
        end++;
    }
    return { startLine: line, endLine: end, text: text.join('\n') };
}

/**
 * The next free comment id of a document: the highest `C-<n>` written after
 * a comment arrow, plus one — or `runtimeNext`, the id the TomSpecs runtime
 * gives the next comment of a SOM document (annot2), when that is higher. So
 * the browser never hands out an id the agents' tools would give out too, nor
 * one the document already shows.
 *
 * @param {string} text
 * @param {number} [runtimeNext]
 * @returns {string}
 */
function mdbNextCommentId(text, runtimeNext) {
    var re = /⬆️?\s*\*\*C-(\d+)\*\*/g;
    var max = 0;
    var m;
    while ((m = re.exec(String(text || ''))) !== null) { max = Math.max(max, Number(m[1])); }
    return 'C-' + Math.max(max + 1, Number(runtimeNext) || 0);
}

/**
 * Whether 0-based `line` lies in one of the `[first, end)` ranges.
 *
 * @param {Array<Array<number>>} ranges
 * @param {number} line
 * @returns {boolean}
 */
function mdbInRanges(ranges, line) {
    for (var i = 0; i < (ranges || []).length; i++) {
        if (line >= ranges[i][0] && line < ranges[i][1]) { return true; }
    }
    return false;
}

/**
 * A comment's text as it is written into the document: the arrow and an id
 * at the start (`nextId` when it has none), the author after the id when it
 * names none and `author` is given (`(Alexis): `; a named author is kept),
 * every line under `> ` (a blank line as `>`), surrounding blank lines
 * dropped. `''` when the text holds nothing but the arrow, the id and the
 * author — no comment.
 *
 * With `at` (a change time, mdbReviewTime) the header records it after the
 * author, `(Alexis, 2026-11-07T14:05+01:00)` or `(2026-11-07T14:05+01:00)`,
 * replacing a time written before — as the runtime's insertComment and
 * editComment write it (SOM §11.9.10).
 *
 * @param {string} text
 * @param {string} nextId
 * @param {string} [author]
 * @param {string} [at]
 * @returns {string}
 */
function mdbWriteComment(text, nextId, author, at) {
    var lines = String(text || '').replace(/\r\n|\r/g, '\n').split('\n').map(function(l) { return l.replace(/\s+$/, ''); });
    while (lines.length && lines[0].trim() === '') { lines.shift(); }
    while (lines.length && lines[lines.length - 1].trim() === '') { lines.pop(); }
    if (!lines.length) { return ''; }
    var first = lines[0].replace(/^\s+/, '');
    var arrow = MDB_COMMENT_ARROW.exec(first);
    if (!arrow) {
        first = '⬆️ **' + nextId + '** ' + first;
    } else if (!/^\s*\*\*C-\d+\*\*/.test(first.slice(arrow[0].length))) {
        var rest = first.slice(arrow[0].length).replace(/^\s*/, '');
        first = arrow[0].replace(/^\s*/, '') + ' **' + nextId + '**' + (rest ? ' ' + rest : '');
    }
    if (author || at) {
        var head = /^(\s*\u2B06\uFE0F?\s*\*\*C-\d+\*\*)\s*(?:\(([^()\n]*)\)\s*(?=:))?([\s\S]*)$/.exec(first);
        if (head) {
            var named = head[2] !== undefined ? mdbCommentHeader('> ' + head[1] + ' (' + head[2] + '):') : { author: '', changedAt: '' };
            var parts = [];
            var who = head[2] !== undefined ? named.author : (author || '');
            if (who) { parts.push(who); }
            var when = at || named.changedAt;
            if (when) { parts.push(when); }
            var tail = head[3].replace(/^:\s*/, '');
            first = head[1] + (parts.length ? ' (' + parts.join(', ') + ')' : '') + ':' + (tail ? ' ' + tail : '');
        }
    }
    lines[0] = first;
    // Nothing but the header (arrow, id, author, colon): no comment.
    var body = first.replace(MDB_COMMENT_ARROW, '').replace(/^\s*\*\*C-\d+\*\*/, '').replace(/^\s*\([^)]*\)/, '').replace(/^\s*:/, '').trim();
    if (!body && lines.slice(1).every(function(l) { return l.trim() === ''; })) { return ''; }
    return lines.map(function(l) { return l === '' ? '>' : '> ' + l; }).join('\n');
}

// ---- Inline review marks (CriticMarkup, tom_specs annot1 §5) ----

var MDB_CRITIC = [
    { kind: 'addition', re: /^\{\+\+([\s\S]*?)\+\+\}/ },
    { kind: 'deletion', re: /^\{--([\s\S]*?)--\}/ },
    { kind: 'substitution', re: /^\{~~([\s\S]*?)~>([\s\S]*?)~~\}/ },
    { kind: 'highlight', re: /^\{==([\s\S]*?)==\}(?:\{>>([\s\S]*?)<<\})?/ },
    { kind: 'comment', re: /^\{>>([\s\S]*?)<<\}/ },
];

/**
 * The inline review mark at the very start of `src`, or null: `{++ added ++}`,
 * `{-- removed --}`, `{~~ old ~> new ~~}`, `{== text ==}` with an optional
 * `{>> comment <<}` right after it, or a `{>> comment <<}` alone. Texts are
 * trimmed; a mark with no text, or one never closed, is no mark. A comment
 * that starts with a quote of a change (SOM §11.9.3) carries `quote` (kind,
 * oldText, newText, outcome) and its `text` is the comment after the quote.
 *
 * @param {string} src
 * @returns {{raw: string, kind: string, text: string, oldText?: string, newText?: string, comment?: string,
 *   quote?: {kind: string, oldText: string, newText: string, outcome: string | null}} | null}
 */
function mdbCriticMark(src) {
    if (typeof src !== 'string' || src.charAt(0) !== '{') { return null; }
    for (var i = 0; i < MDB_CRITIC.length; i++) {
        var m = MDB_CRITIC[i].re.exec(src);
        if (!m) { continue; }
        var kind = MDB_CRITIC[i].kind;
        if (kind === 'substitution') {
            var oldText = m[1].trim();
            var newText = m[2].trim();
            if (!oldText && !newText) { return null; }
            return { raw: m[0], kind: kind, text: newText, oldText: oldText, newText: newText };
        }
        var text = m[1].trim();
        if (!text) { return null; }
        /** @type {{raw: string, kind: string, text: string, comment?: string, quote?: {kind: string, oldText: string, newText: string, outcome: string | null}}} */
        var out = { raw: m[0], kind: kind, text: text };
        if (kind === 'highlight' && m[2] !== undefined && m[2].trim()) { out.comment = m[2].trim(); }
        // A comment that starts with a quote of a change is a change comment: its
        // text is what follows the quote.
        var quote = kind === 'comment' ? mdbChangeQuote(text) : null;
        if (quote) {
            out.quote = { kind: quote.kind, oldText: quote.oldText, newText: quote.newText, outcome: quote.outcome };
            out.text = quote.comment;
        }
        return out;
    }
    return null;
}

/** @type {Record<string, string>} */
var MDB_QUOTE_KINDS = { '++': 'addition', '--': 'deletion', '~~': 'substitution' };

/**
 * The quote a change comment starts with (SOM §11.9.3), or null: `[++ added ++]`,
 * `[-- removed --]`, `[~~ old ~> new ~~]`, after leading whitespace; it ends at
 * the first later occurrence of the same delimiter followed (after spaces or
 * tabs) by `]` or by `| accepted ]` / `| rejected ]`. A quote never closed, or
 * a substitution quote without `~>`, is no quote.
 *
 * @param {string} text the comment's text
 * @returns {{kind: string, oldText: string, newText: string, outcome: string | null, comment: string} | null}
 */
function mdbChangeQuote(text) {
    var m = /^\s*\[(\+\+|--|~~)/.exec(String(text || ''));
    if (!m) { return null; }
    var delim = m[1];
    var body = text.slice(m[0].length);
    var esc = delim.replace(/[+~-]/g, '\\$&');
    var close = new RegExp(esc + '[ \\t]*(?:\\|[ \\t]*(accepted|rejected)[ \\t]*)?\\]');
    var c = close.exec(body);
    if (!c) { return null; }
    var inner = body.slice(0, c.index);
    var kind = MDB_QUOTE_KINDS[delim];
    var oldText = '';
    var newText = '';
    if (kind === 'substitution') {
        var at = inner.indexOf('~>');
        if (at < 0) { return null; }
        oldText = inner.slice(0, at).trim();
        newText = inner.slice(at + 2).trim();
    } else if (kind === 'addition') {
        newText = inner.trim();
    } else {
        oldText = inner.trim();
    }
    return { kind: kind, oldText: oldText, newText: newText, outcome: c[1] || null, comment: body.slice(c.index + c[0].length).trim() };
}

/**
 * Does a change comment's quote name this change mark (its kind and trimmed texts)?
 *
 * @param {{kind: string, oldText: string, newText: string} | undefined | null} quote
 * @param {{kind: string, text: string, oldText?: string, newText?: string} | undefined | null} mark
 * @returns {boolean}
 */
function mdbQuoteMatches(quote, mark) {
    if (!quote || !mark || quote.kind !== mark.kind) { return false; }
    if (mark.kind === 'substitution') { return quote.oldText === mark.oldText && quote.newText === mark.newText; }
    return mark.kind === 'addition' ? quote.newText === mark.text : quote.oldText === mark.text;
}

/**
 * A change mark at the start of `src` with what directly follows it: an
 * attribution token (`{@alice +bob}`, SOM §11.9.8) and the change's own
 * comment — a change comment whose quote names this change and records no
 * outcome, with no space between. Null when `src` starts with no change mark.
 *
 * @param {string} src
 * @returns {{mark: object, token: string, comment: object | null, raw: string} | null}
 */
function mdbChangeWithComment(src) {
    var mark = mdbCriticMark(src);
    if (!mark || (mark.kind !== 'addition' && mark.kind !== 'deletion' && mark.kind !== 'substitution')) { return null; }
    var rest = src.slice(mark.raw.length);
    var tokenMatch = /^\{@[^{}\n]*\}/.exec(rest);
    var token = tokenMatch ? tokenMatch[0] : '';
    var after = rest.slice(token.length);
    var next = after.charAt(0) === '{' ? mdbCriticMark(after) : null;
    var comment = next && next.kind === 'comment' && next.quote && !next.quote.outcome && mdbQuoteMatches(next.quote, mark) ? next : null;
    return { mark: mark, token: token, comment: comment, raw: mark.raw + (comment ? token + comment.raw : '') };
}

/**
 * Write a new comment into the `occurrence`-th (0-based) `raw` inline mark of
 * `source`: a `{>> comment <<}` alone, or the comment of a `{== text ==}`
 * highlight (one is added when it has none). An empty comment removes it: the
 * comment alone goes, a highlight keeps its marked text and loses the comment.
 * The mark's spacing style (`{>> x <<}` or `{>>x<<}`) is kept. A comment may
 * not hold `<<}`, which would end it early.
 *
 * @param {string} source
 * @param {string} raw
 * @param {number} occurrence
 * @param {string} comment
 * @returns {{text: string} | {error: string}}
 */
function mdbEditInlineComment(source, raw, occurrence, comment) {
    var mark = mdbCriticMark(raw);
    if (!mark || mark.raw !== raw || (mark.kind !== 'comment' && mark.kind !== 'highlight')) {
        return { error: 'Not an inline comment or highlight.' };
    }
    var at = -1;
    for (var n = 0; n <= occurrence; n++) {
        at = source.indexOf(raw, at + 1);
        if (at < 0) { return { error: 'The comment is no longer where it was; reload the view.' }; }
    }
    var text = String(comment || '').trim();
    if (text.indexOf('<<}') >= 0) { return { error: 'A comment cannot contain "<<}".' }; }
    // The comment follows the mark's own style: its comment's, else its highlight's.
    var spaced = raw.indexOf('{>>') >= 0 ? /\{>>\s/.test(raw) : /^\{==\s/.test(raw);
    var note = text ? (spaced ? '{>> ' + text + ' <<}' : '{>>' + text + '<<}') : '';
    var replacement = mark.kind === 'comment' ? note : raw.slice(0, raw.indexOf('==}') + 3) + note;
    return { text: source.slice(0, at) + replacement + source.slice(at + raw.length) };
}

// ---- Navigation ----

/**
 * The target to go to from a position in the document rather than from a
 * target: after a save or a decision, the element navigated to last was
 * replaced. A position is `{line, ord}` — a source line and, among the marks
 * of a block, the mark's index. Next is the first target at or after the
 * position, previous the last one before it; both wrap around. A null key
 * (a target with no source position) is passed over. -1 when there is none.
 *
 * @param {Array<{line: number, ord: number} | null>} keys the targets' positions, in document order
 * @param {{line: number, ord: number}} anchor
 * @param {number} delta 1 for next, -1 for previous
 * @returns {number}
 */
function mdbNavPick(keys, anchor, delta) {
    /** @param {{line: number, ord: number}} k */
    function before(k) { return k.line < anchor.line || (k.line === anchor.line && k.ord < anchor.ord); }
    var first = -1;
    var last = -1;
    var pick = -1;
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (!k) { continue; }
        if (first < 0) { first = i; }
        last = i;
        if (delta > 0 && pick < 0 && !before(k)) { pick = i; }
        if (delta < 0 && before(k)) { pick = i; }
    }
    if (pick >= 0) { return pick; }
    return delta > 0 ? first : last;
}

/**
 * How far to scroll to reveal a target with its context: the context's top
 * (the question an answer belongs to) `pad` below the top of the view, unless
 * that pushes `keepBottom` (the answer button, or its open editor) below the
 * view; then that bottom sits `pad` above the bottom instead. Positions are
 * relative to the top of the view.
 *
 * @param {number} contextTop
 * @param {number} keepBottom
 * @param {number} viewHeight
 * @param {number} pad
 * @returns {number} the scroll delta
 */
function mdbRevealDelta(contextTop, keepBottom, viewHeight, pad) {
    var delta = contextTop - pad;
    var keep = keepBottom - (viewHeight - pad);
    return keep > delta ? keep : delta;
}

// ---- Who wrote a review annotation; the check-here marker ----
// An agent signs as `agent_<role>` (src/utils/reviewAuthors.ts; `agent:<role>`
// written by hand counts too). `___check here___` flags what especially needs
// the reviewer's eye. A comment longer than MDB_LONG_COMMENT characters gets
// the buttons that show it in an overlay or the markdown preview editor.

/** How long a comment is before it gets the overlay / preview buttons. */
var MDB_LONG_COMMENT = 200;

/** The check-here marker at the start of a string (any case, inner spaces free). */
var MDB_CHECK_HERE = /^___\s*check here\s*___/i;

/**
 * @param {string} author
 * @returns {boolean} whether `author` is an agent's (`agent`, `agent_<role>`, `agent:<role>`)
 */
function mdbIsAgentAuthor(author) {
    return /^agent(?:[_:].+)?$/i.test(String(author || '').trim());
}

/**
 * A change time (SOM §11.9.10): minutes with the writer's UTC offset,
 * `2026-11-07T14:05+01:00` or `…Z`. Only a word of exactly this shape is a
 * time; anything else keeps its old meaning (an author, a member id).
 */
var MDB_CHANGE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

/** Every change time in a text (not anchored): its occurrences in headers, markers and tokens. */
var MDB_CHANGE_TIMES = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})(?![\d:])/g;

/**
 * The latest change time written in `text` ('' when none), compared as
 * instants: a question's header, its team answer and its members' answers
 * hold one each.
 *
 * @param {string} text
 * @returns {string}
 */
function mdbLatestChangeTime(text) {
    var latest = '';
    var latestMs = -Infinity;
    (String(text || '').match(MDB_CHANGE_TIMES) || []).forEach(function(t) {
        var ms = Date.parse(t);
        if (!isNaN(ms) && ms > latestMs) { latest = t; latestMs = ms; }
    });
    return latest;
}

/**
 * A change time (SOM §11.9.10) as the reader sees it: `label` relative while
 * recent (`just now`, `5 min ago`, `3 h ago`, `2 d ago`), else the date and
 * time as written (`2026-11-07 14:05`); `title` the full time with its offset.
 * Null when `changedAt` is not a change time.
 *
 * @param {string} changedAt
 * @param {number} [now] epoch ms; default the clock
 * @returns {{label: string, title: string} | null}
 */
function mdbChangeTimeLabel(changedAt, now) {
    if (!MDB_CHANGE_TIME.test(String(changedAt || ''))) { return null; }
    var ms = Date.parse(changedAt);
    if (isNaN(ms)) { return null; }
    var written = changedAt.slice(0, 10) + ' ' + changedAt.slice(11, 16);
    var offset = changedAt.slice(16);
    var title = 'Changed ' + written + ' (' + (offset === 'Z' ? 'UTC' : 'UTC' + offset) + ')';
    var age = (now === undefined ? Date.now() : now) - ms;
    var minute = 60000;
    var label;
    if (age < 0 || age >= 7 * 24 * 60 * minute) { label = written; }
    else if (age < minute) { label = 'just now'; }
    else if (age < 60 * minute) { label = Math.floor(age / minute) + ' min ago'; }
    else if (age < 24 * 60 * minute) { label = Math.floor(age / (60 * minute)) + ' h ago'; }
    else { label = Math.floor(age / (24 * 60 * minute)) + ' d ago'; }
    return { label: label, title: label === written ? title : title + ', ' + label };
}

/**
 * A comment block's header parentheses (`(Alexis, 2026-11-07T14:05+01:00)`,
 * `(Alexis)`, `(2026-11-07T14:05+01:00)`): the author and the change time,
 * each '' when not written. The time is the last `, `-separated part when it
 * has the time's shape (SOM §11.9.1, §11.9.10).
 *
 * @param {string} line the block's first line
 * @returns {{author: string, changedAt: string}}
 */
function mdbCommentHeader(line) {
    var m = /^ {0,3}> ?⬆️?\s*(?:\*\*C-\d+\*\*\s*)?\(([^()\n]*)\)\s*:/.exec(String(line || ''));
    if (!m) { return { author: '', changedAt: '' }; }
    var parts = m[1].split(',').map(function(p) { return p.trim(); });
    var changedAt = MDB_CHANGE_TIME.test(parts[parts.length - 1]) ? parts.pop() || '' : '';
    return { author: parts.join(', ').trim(), changedAt: changedAt };
}

/**
 * The author a comment block's first line names (`> ⬆️ **C-12** (Alexis): text`),
 * or '' when it names none; a change time in the parentheses is not an author.
 *
 * @param {string} line
 * @returns {string}
 */
function mdbCommentAuthor(line) {
    return mdbCommentHeader(line).author;
}

/**
 * The text of a comment block without its markers: the `> ` prefixes, the
 * arrow, the id and the author removed.
 *
 * @param {string} text the block's text with the `> ` prefixes already removed (mdbCommentAt)
 * @returns {string}
 */
function mdbCommentBody(text) {
    return String(text || '')
        .replace(/^\s*⬆️?\s*(?:\*\*C-\d+\*\*\s*)?(?:\([^()\n]*\)\s*)?:?\s*/, '')
        .trim();
}

/**
 * An attribution token at the start of `src` (`{@alice}`, `{@alice,bob}`, `{@agent_spec_author +bob -carol}`,
 * `{@alice 2026-11-07T14:05+01:00}`, `{@2026-11-07T14:05+01:00}`; SOM §11.9.8, §11.9.10): its
 * markup, the members it names as authors, those voting and its change time (its last word when
 * that has the time's shape, else ''). Null when `src` starts with none.
 *
 * `votes` keeps each vote's direction: `{member: 'bob', vote: 'accept'}` for `+bob`, `'reject'` for `-carol`.
 *
 * @param {string} src
 * @returns {{raw: string, authors: string[], voters: string[], votes: Array<{member: string, vote: string}>, changedAt: string} | null}
 */
function mdbAttribution(src) {
    var m = /^\{@([^{}\n]*)\}/.exec(String(src || ''));
    if (!m) { return null; }
    /** @type {string[]} */
    var authors = [];
    /** @type {string[]} */
    var voters = [];
    /** @type {Array<{member: string, vote: string}>} */
    var votes = [];
    var words = m[1].trim().split(/\s+/).filter(function(w) { return w; });
    var changedAt = words.length && MDB_CHANGE_TIME.test(words[words.length - 1]) ? words.pop() || '' : '';
    words.forEach(function(part) {
        if (part.charAt(0) === '+' || part.charAt(0) === '-') {
            voters.push(part.slice(1));
            votes.push({ member: part.slice(1), vote: part.charAt(0) === '+' ? 'accept' : 'reject' });
        } else {
            // Several authors of one change are one comma-separated word (`{@alice,bob}`).
            part.split(',').forEach(function(a) { if (a) { authors.push(a); } });
        }
    });
    return { raw: m[0], authors: authors, voters: voters, votes: votes, changedAt: changedAt };
}

// ---- The reading notation (DocSpecs specification § Reading Notation) ----
// A fenced div marks a block with a kind (`::: {.provenance}` … `:::`), a
// bracketed span an inline run (`[text]{.aside}`), and the citation shapes
// `(-> ids)` / `(<- source)` / `(<~ source)` an inline citation. The browser
// renders them as one element each and shows them by the kind's mode
// (main.js); the scanning is here.

/**
 * The registered kinds, their modes and defaults (the kind table of the
 * reading notation). `block` / `span`: the modes a block or a span of the
 * kind can be in, the default first; one mode only means the kind is not
 * collapsible. There is no hidden mode: the marker is the least a reader sees.
 * An unknown kind is shown (fences and braces hidden, content shown).
 * @type {Record<string, {block: string[], span: string[], title: string}>}
 */
var MDB_READING_KINDS = {
    provenance: { block: ['collapsed', 'shown'], span: ['marker', 'dimmed', 'shown'], title: 'where the statement came from' },
    trace: { block: ['collapsed', 'shown'], span: ['marker', 'dimmed', 'shown'], title: 'what the statement rests on' },
    editorial: { block: ['collapsed', 'shown'], span: ['marker', 'dimmed', 'shown'], title: 'a note for authors and checkers' },
    aside: { block: ['collapsed', 'shown'], span: ['marker', 'dimmed', 'shown'], title: 'secondary text' },
    refs: { block: ['compact'], span: ['compact'], title: 'a reference list' },
    records: { block: ['compact'], span: ['compact'], title: 'a table of records' },
    rejected: { block: ['collapsed', 'shown'], span: ['marker', 'shown'], title: 'text an import could not place' },
};

/**
 * The mode of `kind` for a block (`span` false) or a span: the reader's choice
 * in `modes` (`{kind: {block, span}}`) when the kind has it, else the kind's
 * default; an unknown kind is always `shown`.
 * @param {Record<string, {block?: string, span?: string}>|null|undefined} modes
 * @param {string} kind
 * @param {boolean} span
 * @returns {string}
 */
function mdbReadingMode(modes, kind, span) {
    var known = Object.prototype.hasOwnProperty.call(MDB_READING_KINDS, kind) ? MDB_READING_KINDS[kind] : null;
    if (!known) { return 'shown'; }
    var list = span ? known.span : known.block;
    var chosen = modes && modes[kind] ? (span ? modes[kind].span : modes[kind].block) : undefined;
    return chosen && list.indexOf(chosen) >= 0 ? chosen : list[0];
}

/**
 * The attribute braces of a fence or span, `{.kind .more #id key="value"}`
 * (without the braces): its first class is the kind; everything is kept.
 * @param {string} inner
 * @returns {{kind: string, classes: string[], id: string, attrs: Record<string, string>}}
 */
function mdbReadingAttrs(inner) {
    /** @type {{kind: string, classes: string[], id: string, attrs: Record<string, string>}} */
    var out = { kind: '', classes: [], id: '', attrs: {} };
    var re = /\s*(?:\.([\w-]+)|#([\w:.-]+)|([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)))/g;
    var m;
    while ((m = re.exec(inner)) !== null) {
        if (m[0].trim() === '') { break; }
        if (m[1]) { out.classes.push(m[1]); } else if (m[2]) { out.id = m[2]; } else if (m[3]) {
            out.attrs[m[3]] = m[4] !== undefined ? m[4].replace(/\\(.)/g, '$1') : m[5] !== undefined ? m[5] : m[6];
        }
    }
    out.kind = out.classes[0] || '';
    return out;
}

/**
 * An opening fence: at most three spaces, three or more colons, then the
 * attribute braces or a bare kind word (`::: provenance` reads as
 * `{.provenance}`). Null for any other line (a closing fence included).
 * @param {string} line
 * @returns {{colons: number, kind: string, classes: string[], id: string, attrs: Record<string, string>}|null}
 */
function mdbReadingFence(line) {
    var m = /^ {0,3}(:{3,})[ \t]*(?:\{([^}\n]*)\}|([A-Za-z][\w-]*))[ \t]*$/.exec(String(line));
    if (!m) { return null; }
    var a = m[2] !== undefined ? mdbReadingAttrs(m[2]) : { kind: m[3], classes: [m[3]], id: '', attrs: {} };
    return { colons: m[1].length, kind: a.kind, classes: a.classes, id: a.id, attrs: a.attrs };
}

/** A closing fence: at most three spaces, three or more colons and nothing else. */
var MDB_READING_CLOSE = /^ {0,3}:{3,}[ \t]*$/;
/** An ATX heading, or a styled-div heading line, outside code: a div never crosses one. */
var MDB_READING_HEADING = /^ {0,3}(?:#{1,6}(?:\s|$)|<div class="heading\d+")/;

/**
 * Where the div opened on line `open` of `lines` ends: the index of its
 * closing fence (`close`), or, unclosed, -1 with `stop` the line it stopped
 * before (the next heading, or the end). A nested opening fence needs its own
 * closing fence first; a fence inside fenced code is literal.
 * @param {string[]} lines
 * @param {number} open
 * @returns {{close: number, stop: number, unclosed: boolean}}
 */
function mdbReadingDivEnd(lines, open) {
    var depth = 0;
    var fence = null;
    for (var i = open + 1; i < lines.length; i++) {
        var line = lines[i];
        var code = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (code && code[1].charAt(0) === fence.charAt(0) && code[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) { fence = null; }
            continue;
        }
        if (code) { fence = code[1]; continue; }
        if (MDB_READING_HEADING.test(line)) { return { close: -1, stop: i, unclosed: true }; }
        if (mdbReadingFence(line)) { depth++; continue; }
        if (MDB_READING_CLOSE.test(line)) {
            if (depth === 0) { return { close: i, stop: i + 1, unclosed: false }; }
            depth--;
        }
    }
    return { close: -1, stop: lines.length, unclosed: true };
}

/**
 * The block token of a div (or a stray closing fence) at the start of `src`,
 * for marked's block extension `readingDiv`; undefined when `src` does not
 * start with a fence. `lexer` lexes the content (marked's `blockTokens`), so
 * lists, tables, code, nested divs, comments and questions inside render as
 * anywhere else.
 * @param {string} src
 * @param {{blockTokens: function(string, Array<unknown>=): Array<unknown>}} lexer
 * @returns {object|undefined}
 */
function mdbReadingDivToken(src, lexer) {
    var nl = src.indexOf('\n');
    var first = nl < 0 ? src : src.slice(0, nl);
    var open = mdbReadingFence(first);
    if (!open) {
        if (!MDB_READING_CLOSE.test(first)) { return undefined; }
        return { type: 'readingDiv', raw: nl < 0 ? src : src.slice(0, nl + 1), stray: true, kind: '', tokens: [] };
    }
    var lines = src.split('\n');
    var end = mdbReadingDivEnd(lines, 0);
    var contentLines = lines.slice(1, end.unclosed ? end.stop : end.close);
    var rawLines = lines.slice(0, end.stop);
    var raw = rawLines.join('\n');
    // The newline after the last line belongs to the token, as marked's own blocks keep theirs.
    if (src.length > raw.length && src.charAt(raw.length) === '\n') { raw += '\n'; }
    // An unclosed div keeps the blank lines before the heading out of its content.
    while (end.unclosed && contentLines.length && contentLines[contentLines.length - 1].trim() === '') { contentLines.pop(); }
    var text = contentLines.join('\n');
    return {
        type: 'readingDiv', raw: raw, text: text, kind: open.kind, classes: open.classes, id: open.id, attrs: open.attrs,
        unclosed: end.unclosed, stray: false, tokens: lexer.blockTokens(text, []),
    };
}

/**
 * The `start` of the block extension: where in `src` (marked passes the
 * source after the current position) a fence line begins, looked for only up
 * to the end of the current paragraph — its first blank line. A search through
 * the whole remaining text would be O(n) per paragraph and the render
 * quadratic (marked asks every block extension before each paragraph). The
 * answer is the index of the newline before the fence line, so the paragraph
 * ends at the line before it.
 * @param {string} src
 * @returns {number|undefined}
 */
function mdbReadingBlockStart(src) {
    var end = src.indexOf('\n\n');
    var part = end < 0 ? src : src.slice(0, end);
    var m = /\n {0,3}:{3}/.exec(part);
    return m ? m.index : undefined;
}

/**
 * A bracketed span at the start of `src`: `[text]` directly followed by
 * attribute braces with a class. The closing `]` is found with bracket
 * nesting, skipping code spans and escaped characters; `]\{.` is not a span.
 * @param {string} src
 * @returns {{raw: string, text: string, kind: string, classes: string[], id: string, attrs: Record<string, string>}|null}
 */
function mdbReadingSpan(src) {
    if (src.charAt(0) !== '[') { return null; }
    var depth = 0;
    for (var i = 0; i < src.length; i++) {
        var c = src.charAt(i);
        if (c === '\\') { i++; continue; }
        if (c === '`') {
            var run = (/^`+/.exec(src.slice(i)) || ['`'])[0];
            var close = src.indexOf(run, i + run.length);
            if (close < 0) { i += run.length - 1; continue; }
            i = close + run.length - 1;
            continue;
        }
        if (c === '\n' && src.charAt(i + 1) === '\n') { return null; }
        if (c === '[') { depth++; continue; }
        if (c !== ']') { continue; }
        depth--;
        if (depth > 0) { continue; }
        if (src.charAt(i + 1) !== '{') { return null; }
        var shut = src.indexOf('}', i + 2);
        if (shut < 0 || src.slice(i + 2, shut).indexOf('\n') >= 0) { return null; }
        var a = mdbReadingAttrs(src.slice(i + 2, shut));
        if (!a.kind) { return null; }
        return { raw: src.slice(0, shut + 1), text: src.slice(1, i), kind: a.kind, classes: a.classes, id: a.id, attrs: a.attrs };
    }
    return null;
}

/**
 * A citation shape at the start of `src`: `(-> ids)` (backed by: kind
 * `trace`), `(<- source)` (taken from) or `(<~ source)` (extrapolated from),
 * both kind `provenance`. The arrow is followed by one space; the content
 * holds no unbalanced parenthesis.
 * @param {string} src
 * @returns {{raw: string, arrow: string, content: string, kind: string}|null}
 */
function mdbCitation(src) {
    var m = /^\((->|<-|<~) ((?:[^()\n]|\([^()\n]*\))+)\)/.exec(src);
    if (!m) { return null; }
    return { raw: m[0], arrow: m[1], content: m[2], kind: m[1] === '->' ? 'trace' : 'provenance' };
}

/**
 * The per-element key of a reading element: its kind, the first 80
 * characters of its text (whitespace folded) and its occurrence, counted in
 * `seen` — kept like a fold state across a re-render of the same file.
 * @param {string} kind
 * @param {string} text
 * @param {Record<string, number>} seen
 * @returns {string}
 */
function mdbReadingKey(kind, text, seen) {
    var base = kind + '|' + String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    seen[base] = (seen[base] || 0) + 1;
    return base + '#' + seen[base];
}


// ---- Rejected blocks (RN-11): the resolution choices a `rejected` div offers ----

/** @typedef {{open: number, close: number, attrs: Record<string, string>, reason: string, content: string[], top: number, bottom: number, code: boolean[]}} MdbRejected */

/** Any heading line of the shown text (SOM Markdown uses more than six levels): a `#` line or a styled-div heading. */
var MDB_ANY_HEADING = /^ {0,3}(?:#+(?:[ \t]|$)|<div class="heading\d+")/;
/** A form-field label at column 0, as the SOM Markdown codec reads one. */
var MDB_FIELD_LABEL = /^([A-Za-z][A-Za-z0-9_]*):/;

/**
 * An escaped notation fence inside a div (`\:::`, RN-9): the line it stands
 * for unescaped, and whether it opens a div (`open`, its fence) or closes one.
 * @param {string} line
 * @returns {{line: string, open: object|null, colons: number}|null}
 */
function mdbEscapedFence(line) {
    var m = /^( {0,3})\\(:{3,}.*)$/.exec(String(line));
    if (!m) { return null; }
    var unescaped = m[1] + m[2];
    var open = mdbReadingFence(unescaped);
    if (open) { return { line: unescaped, open: open, colons: open.colons }; }
    if (MDB_READING_CLOSE.test(unescaped)) { return { line: unescaped, open: null, colons: (/:+/.exec(m[2]) || [''])[0].length }; }
    return null;
}

/**
 * For each line, whether it lies in fenced code (the fence lines included).
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function mdbCodeLines(lines) {
    var out = [];
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
        var code = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
        if (fence) {
            out.push(true);
            if (code && code[1].charAt(0) === fence.charAt(0) && code[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(lines[i])) { fence = null; }
            continue;
        }
        if (code) { fence = code[1]; out.push(true); continue; }
        out.push(false);
    }
    return out;
}

/**
 * The opening lines of the `rejected` divs in lines `start..end` (exclusive),
 * outside fenced code, in document order — the order the browser shows them.
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @returns {number[]}
 */
function mdbRejectedOpens(lines, start, end) {
    var code = mdbCodeLines(lines);
    var out = [];
    for (var i = Math.max(0, start); i < Math.min(end, lines.length); i++) {
        if (code[i]) { continue; }
        var f = mdbReadingFence(lines[i]);
        if (f && f.kind === 'rejected') { out.push(i); }
    }
    return out;
}

/**
 * The cells of a table row (escaped pipes kept in their cell), or null for a line that is no row.
 * @param {string} line
 * @returns {string[]|null}
 */
function mdbRowCells(line) {
    var t = String(line).trim();
    if (t.charAt(0) !== '|') { return null; }
    var cells = [];
    var cur = '';
    for (var i = 1; i < t.length; i++) {
        var c = t.charAt(i);
        if (c === '\\' && t.charAt(i + 1) === '|') { cur += '\\|'; i++; continue; }
        if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim() !== '') { cells.push(cur.trim()); }
    return cells;
}
/**
 * @param {string[]} cells
 * @returns {string}
 */
function mdbRowLine(cells) { return '| ' + cells.join(' | ') + ' |'; }
/**
 * @param {string} line
 * @returns {boolean}
 */
function mdbIsDelimiterRow(line) { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(String(line)); }
/**
 * A field name compared loosely: case and separators left out.
 * @param {string} name
 * @returns {string}
 */
function mdbFieldKey(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * The div opened on line `open` with what a resolution needs; null when it is no closed `rejected` div.
 * @param {string[]} lines
 * @param {number} open
 * @returns {MdbRejected|null}
 */
function mdbRejectedAt(lines, open) {
    var f = mdbReadingFence(lines[open]);
    if (!f || f.kind !== 'rejected') { return null; }
    var end = mdbReadingDivEnd(lines, open);
    if (end.unclosed) { return null; }
    var code = mdbCodeLines(lines);
    var top = 0;
    var bottom = lines.length;
    for (var i = 0; i < lines.length; i++) {
        if (code[i] || !MDB_ANY_HEADING.test(lines[i])) { continue; }
        if (i < open) { top = i + 1; } else if (i > end.close) { bottom = i; break; }
    }
    var content = lines.slice(open + 1, end.close);
    while (content.length && content[0].trim() === '') { content.shift(); }
    while (content.length && content[content.length - 1].trim() === '') { content.pop(); }
    return { open: open, close: end.close, attrs: f.attrs || {}, reason: (f.attrs || {}).reason || '', content: content, top: top, bottom: bottom, code: code };
}

/**
 * `lines` without lines `from..to` (exclusive), one blank line kept where two would meet.
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 * @returns {string[]}
 */
function mdbWithoutLines(lines, from, to) {
    var next = lines.slice(0, from).concat(lines.slice(to));
    if (from < next.length && next[from].trim() === '' && (from === 0 || next[from - 1].trim() === '')) { next.splice(from, 1); }
    return next;
}

/**
 * `lines` with lines `from..to` (exclusive) replaced by `insert`.
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 * @param {string[]} insert
 * @returns {string[]}
 */
function mdbWithLines(lines, from, to, insert) {
    return lines.slice(0, from).concat(insert, lines.slice(to));
}

/**
 * The one line edit turning `lines` into `next`: the changed lines between
 * their common start and end, `{startLine, endLine, expected, replacement}`
 * as the browser's applyEdit takes it (the replacement is never empty: a
 * removal takes a neighbouring line along). null when nothing changes.
 * @param {string[]} lines
 * @param {string[]} next
 * @returns {{startLine: number, endLine: number, expected: string, replacement: string}|null}
 */
function mdbLinesEdit(lines, next) {
    var p = 0;
    while (p < lines.length && p < next.length && lines[p] === next[p]) { p++; }
    if (p === lines.length && p === next.length) { return null; }
    var s = 0;
    while (s < lines.length - p && s < next.length - p && lines[lines.length - 1 - s] === next[next.length - 1 - s]) { s++; }
    var start = p;
    var endOld = lines.length - s;
    var endNew = next.length - s;
    if (endNew === start) {
        if (start > 0) { start--; } else if (endOld < lines.length) { endOld++; endNew++; }
    }
    return { startLine: start, endLine: endOld, expected: lines.slice(start, endOld).join('\n'), replacement: next.slice(start, endNew).join('\n') };
}

/**
 * Where a `Label: value` paragraph starting on line `i` ends (exclusive): at a blank line, the next label, a heading or a fence.
 * @param {string[]} lines
 * @param {number} i
 * @param {number} bottom
 * @returns {number}
 */
function mdbLabelParagraphEnd(lines, i, bottom) {
    var j = i + 1;
    while (j < bottom && lines[j].trim() !== '' && !MDB_FIELD_LABEL.test(lines[j]) && !MDB_ANY_HEADING.test(lines[j]) && !mdbReadingFence(lines[j]) && !MDB_READING_CLOSE.test(lines[j])) { j++; }
    return j;
}

/**
 * The value the rejected text gives: a row's last cell, or a `Label: value`
 * paragraph's text after its label. `{kind: 'row'|'label', label, value, cells}`;
 * null when the text is neither.
 * @param {string[]} content
 * @returns {{kind: string, label: string, value: string, cells: string[]}|null}
 */
function mdbRejectedValue(content) {
    if (content.length === 0) { return null; }
    var cells = mdbRowCells(content[0]);
    if (cells && content.length === 1 && cells.length >= 2) {
        return { kind: 'row', label: cells[cells.length - 2], value: cells[cells.length - 1], cells: cells };
    }
    var m = MDB_FIELD_LABEL.exec(content[0]);
    if (m && !cells) {
        var first = content[0].slice(m[0].length).trim();
        return { kind: 'label', label: m[1], value: [first].concat(content.slice(1)).join('\n').replace(/^\n+/, ''), cells: [] };
    }
    return null;
}

/**
 * A value as a row's cell: one line (`<br>` for a break), pipes escaped.
 * @param {string} value
 * @returns {string}
 */
function mdbCellValue(value) {
    return String(value).split('\n').map(function(l) { return l.trim(); }).filter(Boolean).join('<br>').replace(/(^|[^\\])\|/g, '$1\\|');
}
/**
 * A cell as a paragraph value: `<br>` as a break, escaped pipes plain.
 * @param {string} cell
 * @returns {string}
 */
function mdbCellText(cell) {
    return String(cell).replace(/<br\s*\/?>/gi, '\n').replace(/\\\|/g, '|');
}

/**
 * The place of field `field` in lines `top..bottom`, outside fenced code and
 * the rejected div `skip` (its `[open, close]`): a `Label:` paragraph
 * (`{kind: 'label', start, end, label, value}`) or a table row whose
 * label cell names it (`{kind: 'row', start, end, cells, value}`); `rowCells`
 * — the cell count a row must have — and `prefix` (the cells before the
 * label, compared) narrow the rows. null when the section has none.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @param {string} field
 * @param {number} rowCells
 * @param {string[]|null} prefix
 * @returns {{kind: string, start: number, end: number, label: string, value: string, cells: string[]}|null}
 */
function mdbFieldPlace(lines, at, field, rowCells, prefix) {
    var key = mdbFieldKey(field);
    for (var i = at.top; i < at.bottom; i++) {
        if (at.code[i] || (i >= at.open && i <= at.close)) { continue; }
        var f = mdbReadingFence(lines[i]);
        if (f && f.kind === 'rejected') {
            var e = mdbReadingDivEnd(lines, i);
            if (!e.unclosed) { i = e.close; }
            continue;
        }
        var m = MDB_FIELD_LABEL.exec(lines[i]);
        if (m && mdbFieldKey(m[1]) === key) {
            var end = mdbLabelParagraphEnd(lines, i, at.bottom);
            var first = lines[i].slice(m[0].length).trim();
            return { kind: 'label', start: i, end: end, label: m[1], value: [first].concat(lines.slice(i + 1, end)).join('\n').trim(), cells: [] };
        }
        var cells = mdbRowCells(lines[i]);
        if (!cells || mdbIsDelimiterRow(lines[i]) || cells.length < 2) { continue; }
        if (rowCells && cells.length !== rowCells) { continue; }
        if (mdbFieldKey(cells[cells.length - 2]) !== key) { continue; }
        var row = cells;
        if (prefix && prefix.some(function(/** @type {string} */ c, /** @type {number} */ k) { return c !== '' && c !== row[k]; })) { continue; }
        return { kind: 'row', start: i, end: i + 1, cells: cells, value: cells[cells.length - 1], label: cells[cells.length - 2] };
    }
    return null;
}

/**
 * The line a row can be appended after: the last row of the table directly above the div (blank lines between), or -1.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @returns {number}
 */
function mdbTableAbove(lines, at) {
    var i = at.open - 1;
    while (i >= at.top && lines[i].trim() === '') { i--; }
    return i >= at.top && !at.code[i] && mdbRowCells(lines[i]) ? i : -1;
}

/**
 * `lines` with the div replaced by `content` (the fences gone).
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @param {string[]} content
 * @returns {string[]}
 */
function mdbUnwrapRejected(lines, at, content) {
    return mdbWithLines(lines, at.open, at.close + 1, content);
}

/**
 * `lines` with `row` appended to the table above the div and the div removed; the div unwrapped to `row` when no table is above.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @param {string[]} rows
 * @returns {string[]}
 */
function mdbRowsIntoTable(lines, at, rows) {
    var after = mdbTableAbove(lines, at);
    if (after < 0) { return mdbUnwrapRejected(lines, at, rows); }
    var next = mdbWithoutLines(lines, at.open, at.close + 1);
    return mdbWithLines(next, after + 1, after + 1, rows);
}

/**
 * *Use this value instead*: the kept value replaced by the rejected one, the div removed.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @returns {string[]|null}
 */
function mdbResolveUse(lines, at) {
    var field = at.attrs.field;
    if (at.reason !== 'malformedBlock' || !field || !at.attrs.kept) { return null; }
    var given = mdbRejectedValue(at.content);
    if (!given) { return null; }
    var place = given.kind === 'row'
        ? mdbFieldPlace(lines, at, field, given.cells.length, given.cells.slice(0, -2))
        : mdbFieldPlace(lines, at, field, 0, null);
    if (!place) { return null; }
    var replacement;
    if (place.kind === 'row') {
        var cells = place.cells.slice();
        cells[cells.length - 1] = given.kind === 'row' ? given.value : mdbCellValue(given.value);
        replacement = [mdbRowLine(cells)];
    } else {
        var text = given.kind === 'row' ? mdbCellText(given.value) : given.value;
        var parts = text.split('\n');
        replacement = [place.label + ': ' + parts[0]].concat(parts.slice(1));
        if (parts[0] === '') { replacement[0] = place.label + ':'; }
    }
    // The div comes after or before the kept value; the later range is changed first.
    var next = lines;
    if (at.open > place.start) {
        next = mdbWithoutLines(next, at.open, at.close + 1);
        next = mdbWithLines(next, place.start, place.end, replacement);
    } else {
        next = mdbWithLines(next, place.start, place.end, replacement);
        next = mdbWithoutLines(next, at.open, at.close + 1);
    }
    return next;
}

/**
 * The header cell of a records table close to `field` (the same key, or one edit away).
 * @param {string[]} cells
 * @param {string} field
 * @returns {number}
 */
function mdbNearCell(cells, field) {
    var key = mdbFieldKey(field);
    /** @type {number[]} */
    var hits = [];
    cells.forEach(function(/** @type {string} */ c, /** @type {number} */ i) {
        if (mdbFieldKey(c) === key || mdbEditDistanceAtMostOne(mdbFieldKey(c), key)) { hits.push(i); }
    });
    return hits.length === 1 ? hits[0] : -1;
}
/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function mdbEditDistanceAtMostOne(a, b) {
    if (a === b) { return true; }
    if (Math.abs(a.length - b.length) > 1) { return false; }
    var i = 0;
    while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) { i++; }
    if (a.length === b.length) { return a.slice(i + 1) === b.slice(i + 1); }
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * *Rename to `<field>`* / *Rename to `<child>`*: the label renamed, the value moved where it belongs (a field only if empty).
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @returns {string[]|null}
 */
function mdbResolveRename(lines, at) {
    var content = at.content;
    if (content.length === 0) { return null; }
    if (at.reason === 'unknownSection' && at.attrs.section) {
        var first = mdbRowCells(content[0]);
        if (!first || first.length < 3 || content.some(function(/** @type {string} */ l) { return !mdbRowCells(l); })) { return null; }
        first[0] = at.attrs.section;
        return mdbRowsIntoTable(lines, at, [mdbRowLine(first)].concat(content.slice(1)));
    }
    if (at.reason !== 'unknownField' || !at.attrs.field) { return null; }
    var field = at.attrs.field;
    // A records table whose column is the near miss: its header cell renamed.
    if (content.length >= 2 && mdbRowCells(content[0]) && mdbIsDelimiterRow(content[1])) {
        var header = mdbRowCells(content[0]) || [];
        var col = mdbNearCell(header, field);
        if (col < 0) { return null; }
        header[col] = field;
        return mdbUnwrapRejected(lines, at, [mdbRowLine(header)].concat(content.slice(1)));
    }
    var given = mdbRejectedValue(content);
    if (!given) { return null; }
    var place = given.kind === 'row'
        ? mdbFieldPlace(lines, at, field, given.cells.length, given.cells.slice(0, -2))
        : mdbFieldPlace(lines, at, field, 0, null);
    if (place && place.value.trim() !== '') { return null; }
    if (given.kind === 'row') {
        var cells = given.cells.slice();
        cells[cells.length - 2] = field;
        if (place && place.kind === 'row') {
            var filled = place.cells.slice();
            filled[filled.length - 1] = given.value;
            return mdbWithLines(mdbWithoutLines(lines, at.open, at.close + 1), place.start, place.end, [mdbRowLine(filled)]);
        }
        return mdbRowsIntoTable(lines, at, [mdbRowLine(cells)]);
    }
    var parts = given.value.split('\n');
    var renamed = [field + ': ' + parts[0]].concat(parts.slice(1));
    if (place && place.kind === 'label') {
        var next = lines;
        var with1 = [place.label + ': ' + parts[0]].concat(parts.slice(1));
        if (at.open > place.start) {
            next = mdbWithLines(mdbWithoutLines(next, at.open, at.close + 1), place.start, place.end, with1);
        } else {
            next = mdbWithoutLines(mdbWithLines(next, place.start, place.end, with1), at.open, at.close + 1);
        }
        return next;
    }
    return mdbUnwrapRejected(lines, at, renamed);
}

/**
 * *Close here*: the escaped opening fence written as a fence again and closed at the end of the kept text.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @returns {string[]|null}
 */
function mdbResolveClose(lines, at) {
    var content = at.content.slice();
    for (var i = 0; i < content.length; i++) {
        var esc = mdbEscapedFence(content[i]);
        if (esc && esc.open) {
            content[i] = esc.line;
            content.push(new Array(esc.colons + 1).join(':'));
            return mdbUnwrapRejected(lines, at, content);
        }
    }
    return null;
}

/**
 * *Remove the fence*: the escaped fence lines removed, the rest kept.
 * @param {string[]} lines
 * @param {MdbRejected} at
 * @returns {string[]|null}
 */
function mdbResolveUnfence(lines, at) {
    var kept = at.content.filter(function(/** @type {string} */ l) { return !mdbEscapedFence(l); });
    if (kept.length === at.content.length) { return null; }
    if (kept.length === 0) { return mdbWithoutLines(lines, at.open, at.close + 1); }
    return mdbUnwrapRejected(lines, at, kept);
}

/** The choices in the order the browser offers them: id and label. */
/** @type {Array<{id: string, label: function(MdbRejected): string, resolve: function(string[], MdbRejected): (string[]|null)}>} */
var MDB_REJECTED_CHOICES = [
    { id: 'use', label: function() { return 'Use this value instead'; }, resolve: mdbResolveUse },
    { id: 'rename', label: function(at) { return 'Rename to ' + (at.attrs.field || at.attrs.section); }, resolve: mdbResolveRename },
    { id: 'close', label: function() { return 'Close here'; }, resolve: mdbResolveClose },
    { id: 'unfence', label: function() { return 'Remove the fence'; }, resolve: mdbResolveUnfence },
    { id: 'remove', label: function() { return 'Remove this'; }, resolve: function(/** @type {string[]} */ lines, /** @type {MdbRejected} */ at) { return mdbWithoutLines(lines, at.open, at.close + 1); } },
];

/**
 * The resolution choices of the `rejected` div opened on line `open`
 * (part *Parser and DocSpecs*, DI-8): those whose edit can be made, in order —
 * *Use this value instead*, *Rename to …*, *Close here*, *Remove the fence*,
 * *Remove this* (always). [] when the line opens no closed rejected div.
 * @param {string[]} lines
 * @param {number} open
 * @returns {Array<{id: string, label: string}>}
 */
function mdbRejectedChoices(lines, open) {
    var at = mdbRejectedAt(lines, open);
    if (!at) { return []; }
    var found = at;
    return MDB_REJECTED_CHOICES.filter(function(c) { return !!c.resolve(lines, found); })
        .map(function(c) { return { id: c.id, label: c.label(found) }; });
}

/**
 * The edit choice `choice` writes for the `rejected` div opened on line
 * `open`: one line edit `{startLine, endLine, expected, replacement}`, an
 * ordinary edit of the source; null when the choice does not apply.
 * @param {string[]} lines
 * @param {number} open
 * @param {string} choice
 */
function mdbResolveRejected(lines, open, choice) {
    var at = mdbRejectedAt(lines, open);
    if (!at) { return null; }
    var c = MDB_REJECTED_CHOICES.filter(function(x) { return x.id === choice; })[0];
    var next = c ? c.resolve(lines, at) : null;
    return next ? mdbLinesEdit(lines, next) : null;
}


// ---- Writing inline marks from the browser: a selection's mark, tracked edits (SOM §11.9.3) ----

/** Every inline mark, with the attribution token after it. */
var MDB_MARK_SCAN = /\{\+\+[\s\S]*?\+\+\}|\{--[\s\S]*?--\}|\{~~[\s\S]*?~~\}|\{==[\s\S]*?==\}|\{>>[\s\S]*?<<\}|\{@[^{}\n]*\}/g;
/** A mark delimiter: text holding one cannot go into a mark (marks do not nest). */
var MDB_MARK_DELIMITER = /\{>>|<<\}|\{==|==\}|\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|~>|\{@/;

/**
 * The attribution token written after a mark the user makes (`{@alice 2026-11-07T14:05+01:00}`,
 * SOM §11.9.8, §11.9.10): with a review member id, else none.
 * @param {string} memberId
 * @param {string} time
 * @returns {string}
 */
function mdbOwnToken(memberId, time) {
    return memberId ? '{@' + memberId + (time ? ' ' + time : '') + '}' : '';
}

/**
 * Where the text selected in the rendered block is in the block's `source`.
 * The selection with the text right before and after it (`before`, `after`:
 * what the rendered text nodes hold around it) is looked for first; else the
 * selection alone, which must be there once — or as often as in the rendered
 * text, the `occurrence`-th (0-based) then being it. Runs of white space match
 * any white space (a hard-wrapped paragraph). `selected` empty: the point
 * between `before` and `after`.
 * @param {string} source
 * @param {string} selected
 * @param {string} before
 * @param {string} after
 * @param {number} occurrence
 * @param {number} renderedCount  how often the selection is in the rendered block
 * @returns {{start: number, end: number} | {error: string}}
 */
function mdbLocateSelection(source, selected, before, after, occurrence, renderedCount) {
    var flex = function(/** @type {string} */ s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    };
    /** @type {(pattern: string) => Array<{index: number, text: string}>} */
    var all = function(pattern) {
        /** @type {Array<{index: number, text: string}>} */
        var found = [];
        if (!pattern) { return found; }
        var re = new RegExp(pattern, 'g');
        var m;
        while ((m = re.exec(source)) !== null) {
            found.push({ index: m.index, text: m[0] });
            if (m[0] === '') { re.lastIndex++; }
        }
        return found;
    };
    var why = 'The selection could not be found in the paragraph\'s source (it may cross formatting): edit the paragraph instead.';
    if (!selected) {
        if (!before && !after) { return { error: 'Click inside the text of a paragraph.' }; }
        var points = all('(' + flex(before) + ')' + flex(after));
        if (points.length !== 1) { return { error: why.replace('The selection', 'The place') }; }
        var lead = new RegExp('^' + flex(before)).exec(points[0].text);
        var at = points[0].index + (lead ? lead[0].length : 0);
        return { start: at, end: at };
    }
    var withContext = (before || after) ? all(flex(before) + '(' + flex(selected) + ')' + flex(after)) : [];
    if (withContext.length === 1) {
        var head = before ? new RegExp('^' + flex(before)).exec(withContext[0].text) : null;
        var start = withContext[0].index + (head ? head[0].length : 0);
        var body = new RegExp('^' + flex(selected)).exec(source.slice(start));
        if (body) { return { start: start, end: start + body[0].length }; }
    }
    var alone = all(flex(selected));
    if (alone.length === 1) { return { start: alone[0].index, end: alone[0].index + alone[0].text.length }; }
    if (alone.length > 1 && alone.length === renderedCount && occurrence >= 0 && occurrence < alone.length) {
        return { start: alone[occurrence].index, end: alone[occurrence].index + alone[occurrence].text.length };
    }
    return { error: alone.length > 1 ? 'The selected text is in this paragraph more than once: select more of it.' : why };
}

/**
 * The block's source with a mark written at `range` (mdbLocateSelection):
 * `comment` a highlight with its comment (`{== text ==}{>> comment <<}`),
 * `delete` a suggested deletion, `replace` a suggested replacement by `text`,
 * `point` a comment at an empty range. `token` (mdbOwnToken) follows the mark.
 * Refused with `error`: an empty selection or text, a mark delimiter in either,
 * a selection across a blank line, one inside or across another mark.
 * @param {string} source
 * @param {{start: number, end: number}} range
 * @param {string} kind  comment | delete | replace | point
 * @param {string} text
 * @param {string} token
 * @returns {{text: string} | {error: string}}
 */
function mdbSelectionMark(source, range, kind, text, token) {
    var start = range.start;
    var end = range.end;
    // The white space at the edges of a selection stays outside the mark.
    while (start < end && /\s/.test(source.charAt(start))) { start++; }
    while (end > start && /\s/.test(source.charAt(end - 1))) { end--; }
    var selected = source.slice(start, end);
    var note = String(text || '').trim();
    if (kind !== 'point' && !selected) { return { error: 'Select the text first.' }; }
    if (/\n[ \t]*\n/.test(selected)) { return { error: 'A mark cannot span a blank line: select within one paragraph.' }; }
    if (MDB_MARK_DELIMITER.test(selected)) { return { error: 'The selection holds a mark already: marks do not nest.' }; }
    MDB_MARK_SCAN.lastIndex = 0;
    var m;
    while ((m = MDB_MARK_SCAN.exec(source)) !== null) {
        var mEnd = m.index + m[0].length;
        if (kind === 'point' ? (start > m.index && start < mEnd) : (start < mEnd && end > m.index)) {
            return { error: 'This is inside another mark: marks do not nest.' };
        }
    }
    if (kind !== 'delete') {
        if (!note) { return { error: kind === 'replace' ? 'Write the replacement first.' : 'Write the comment first.' }; }
        if (MDB_MARK_DELIMITER.test(note)) { return { error: 'The text cannot contain a mark delimiter ({>> {== {++ {-- {~~ ~> <<}).' }; }
        if (/\n[ \t]*\n/.test(note)) { return { error: 'The text cannot contain a blank line.' }; }
    }
    var mark = kind === 'comment' ? '{== ' + selected + ' ==}{>> ' + note + ' <<}'
        : kind === 'delete' ? '{-- ' + selected + ' --}'
            : kind === 'replace' ? '{~~ ' + selected + ' ~> ' + note + ' ~~}'
                : '{>> ' + note + ' <<}';
    return { text: source.slice(0, start) + mark + (token || '') + source.slice(end) };
}

/**
 * The longest common subsequence of `a` and `b` as index pairs; null when the
 * table would be too large (the caller then does without).
 * @template T
 * @param {T[]} a
 * @param {T[]} b
 * @param {(x: T, y: T) => boolean} same
 * @returns {Array<[number, number]> | null}
 */
function mdbLcsPairs(a, b, same) {
    var n = a.length;
    var m = b.length;
    if (n * m > 4000000) { return null; }
    /** @type {Uint32Array[]} */
    var table = [];
    for (var i = 0; i <= n; i++) { table.push(new Uint32Array(m + 1)); }
    for (var x = n - 1; x >= 0; x--) {
        for (var y = m - 1; y >= 0; y--) {
            table[x][y] = same(a[x], b[y]) ? table[x + 1][y + 1] + 1 : Math.max(table[x + 1][y], table[x][y + 1]);
        }
    }
    /** @type {Array<[number, number]>} */
    var pairs = [];
    var p = 0;
    var q = 0;
    while (p < n && q < m) {
        if (same(a[p], b[q])) { pairs.push([p, q]); p++; q++; }
        else if (table[p + 1][q] >= table[p][q + 1]) { p++; }
        else { q++; }
    }
    return pairs;
}

/** The structural start of a line: list markers, task boxes, quote marks, heading hashes. */
var MDB_LINE_PREFIX = /^(?:\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>+[ \t]?|#{1,6}\s+))*\s*/;

/**
 * For each line, whether a mark cannot be written into it: inside a fenced
 * code block (its fences included), a table row, a div fence, html, a rule.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function mdbUnmarkableLines(lines) {
    var fence = '';
    return lines.map(function(line) {
        var f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (f && f[1].charAt(0) === fence.charAt(0) && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) { fence = ''; }
            return true;
        }
        if (f) { fence = f[1]; return true; }
        return /^\s*\|/.test(line) || /^ {0,3}:{3,}/.test(line) || /^\s*<[a-zA-Z/!]/.test(line) || /^ {0,3}([-*_])( *\1){2,} *$/.test(line);
    });
}

/**
 * One line's text split for the word diff: every inline mark (with its
 * attribution token) one piece, else words, runs of punctuation and runs of
 * white space.
 * @param {string} text
 * @returns {Array<{text: string, mark: boolean}>}
 */
function mdbDiffPieces(text) {
    /** @type {Array<{text: string, mark: boolean}>} */
    var pieces = [];
    var words = function(/** @type {string} */ plain) {
        (plain.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]+/gu) || []).forEach(function(w) { pieces.push({ text: w, mark: false }); });
    };
    var last = 0;
    MDB_MARK_SCAN.lastIndex = 0;
    var m;
    while ((m = MDB_MARK_SCAN.exec(text)) !== null) {
        words(text.slice(last, m.index));
        pieces.push({ text: m[0], mark: true });
        last = m.index + m[0].length;
    }
    words(text.slice(last));
    return pieces;
}

/**
 * `newBody` with what changed against `oldBody` written as marks, word by
 * word: removed words `{-- --}`, added `{++ ++}`, a replaced run
 * `{~~ old ~> new ~~}`; white space around a change stays outside its mark.
 * A change touching an existing mark, or holding a mark delimiter, is written
 * as it is (counted in `counter.untracked`).
 * @param {string} oldBody
 * @param {string} newBody
 * @param {string} token
 * @param {{untracked: number, marks: number}} counter
 * @returns {string}
 */
function mdbTrackedLine(oldBody, newBody, token, counter) {
    if (oldBody === newBody) { return newBody; }
    var a = mdbDiffPieces(oldBody);
    var b = mdbDiffPieces(newBody);
    var matched = mdbLcsPairs(a, b, function(x, y) { return x.text === y.text; });
    if (!matched) { counter.untracked++; return newBody; }
    var all = matched;
    // A matched run of white space between two changes belongs to one change ("big red" → "small blue").
    var pairs = all.filter(function(pair, k) {
        if (/\S/.test(a[pair[0]].text)) { return true; }
        var prev = k > 0 ? all[k - 1] : [-1, -1];
        var next = k + 1 < all.length ? all[k + 1] : [a.length, b.length];
        var changedBefore = pair[0] - prev[0] > 1 || pair[1] - prev[1] > 1;
        var changedAfter = next[0] - pair[0] > 1 || next[1] - pair[1] > 1;
        return !(changedBefore && changedAfter);
    });
    var out = '';
    var i = 0;
    var j = 0;
    /** @type {(ai: number, bj: number) => void} */
    var change = function(ai, bj) {
        var removed = a.slice(i, ai);
        var added = b.slice(j, bj);
        if (!removed.length && !added.length) { return; }
        var oldText = removed.map(function(p) { return p.text; }).join('');
        var newText = added.map(function(p) { return p.text; }).join('');
        var touchesMark = removed.concat(added).some(function(p) { return p.mark; });
        var from = oldText.trim();
        var to = newText.trim();
        if (touchesMark || MDB_MARK_DELIMITER.test(from) || MDB_MARK_DELIMITER.test(to)) {
            counter.untracked++;
            out += newText;
            return;
        }
        if (!from && !to) { out += newText; return; }
        var base = added.length ? newText : oldText;
        var lead = (/^\s*/.exec(base) || [''])[0];
        var trail = to || !added.length ? (/\s*$/.exec(base) || [''])[0] : '';
        if (!base.trim()) { lead = base; trail = ''; }
        var mark = from && to ? '{~~ ' + from + ' ~> ' + to + ' ~~}' : from ? '{-- ' + from + ' --}' : '{++ ' + to + ' ++}';
        counter.marks++;
        out += lead + mark + token + trail;
    };
    pairs.forEach(function(pair) {
        change(pair[0], pair[1]);
        out += b[pair[1]].text;
        i = pair[0] + 1;
        j = pair[1] + 1;
    });
    change(a.length, b.length);
    return out;
}

/**
 * How alike two lines are, 0 … 1 (the share of their words in common, in order).
 * @param {string} x
 * @param {string} y
 * @returns {number}
 */
function mdbLineSimilarity(x, y) {
    var a = x.trim().split(/\s+/).filter(function(w) { return w; });
    var b = y.trim().split(/\s+/).filter(function(w) { return w; });
    if (!a.length && !b.length) { return 1; }
    if (!a.length || !b.length) { return 0; }
    var pairs = mdbLcsPairs(a, b, function(p, q) { return p === q; });
    return pairs ? (2 * pairs.length) / (a.length + b.length) : 0;
}

/**
 * Tracking mode (the MD Browser's edit mode): `newText` as the user saved it,
 * with every change against `oldText` written as inline marks (SOM §11.9.3)
 * instead of being made. Lines are matched first (an unchanged line stays as
 * it is; in a changed stretch a line is paired with the one most like it),
 * then a pair is compared word by word (mdbTrackedLine). A line only in the
 * old text stays, marked deleted; one only in the new text is marked added.
 * The structural start of a line (list marker, quote mark, heading hashes)
 * stays outside the marks; what cannot carry a mark — code blocks, table
 * rows, html, fences, blank lines, changes to existing marks — is written as
 * the user left it (`untracked` counts those).
 * @param {string} oldText
 * @param {string} newText
 * @param {string} token  the attribution token after each mark (mdbOwnToken), or ''
 * @returns {{text: string, marks: number, untracked: number}}
 */
function mdbTrackedEdit(oldText, newText, token) {
    var counter = { untracked: 0, marks: 0 };
    var eol = String(newText).indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var oldLines = String(oldText).replace(/\r\n|\r/g, '\n').split('\n');
    var newLines = String(newText).replace(/\r\n|\r/g, '\n').split('\n');
    if (oldLines.join('\n') === newLines.join('\n')) { return { text: newText, marks: 0, untracked: 0 }; }
    var oldPlain = mdbUnmarkableLines(oldLines);
    var newPlain = mdbUnmarkableLines(newLines);
    var same = mdbLcsPairs(oldLines, newLines, function(x, y) { return x === y; });
    if (!same) { return { text: newText, marks: 0, untracked: 1 }; }
    /** @type {string[]} */
    var out = [];
    var tok = token || '';
    var prefixOf = function(/** @type {string} */ line) { return (MDB_LINE_PREFIX.exec(line) || [''])[0]; };
    // A removed blank line is kept when a removed line follows it: that line stays, marked, a paragraph of its own.
    var heldBlank = false;
    /** @type {(oi: number) => void} */
    var removedLine = function(oi) {
        var line = oldLines[oi];
        if (!line.trim()) { heldBlank = out.length > 0; return; }
        var prefix = prefixOf(line);
        var body = line.slice(prefix.length).trim();
        if (oldPlain[oi] || !body || MDB_MARK_DELIMITER.test(body)) { counter.untracked++; return; }
        if (heldBlank && out[out.length - 1].trim()) { out.push(''); }
        heldBlank = false;
        counter.marks++;
        out.push(prefix + '{-- ' + body + ' --}' + tok);
    };
    /** @type {(ni: number) => void} */
    var addedLine = function(ni) {
        var line = newLines[ni];
        var prefix = prefixOf(line);
        var body = line.slice(prefix.length).trim();
        if (!line.trim()) { out.push(line); return; }
        if (newPlain[ni] || !body || MDB_MARK_DELIMITER.test(body)) { counter.untracked++; out.push(line); return; }
        counter.marks++;
        out.push(prefix + '{++ ' + body + ' ++}' + tok);
    };
    /** @type {(oi: number, ni: number) => void} */
    var changedLine = function(oi, ni) {
        var oldLine = oldLines[oi];
        var newLine = newLines[ni];
        if (oldPlain[oi] || newPlain[ni]) { if (oldLine !== newLine) { counter.untracked++; } out.push(newLine); return; }
        var prefix = prefixOf(newLine);
        var oldPrefix = prefixOf(oldLine);
        var tail = (/\s*$/.exec(newLine.slice(prefix.length)) || [''])[0];
        var body = mdbTrackedLine(oldLine.slice(oldPrefix.length).replace(/\s+$/, ''), newLine.slice(prefix.length).replace(/\s+$/, ''), tok, counter);
        out.push(prefix + body + tail);
    };
    /** A changed stretch: old lines [o0, o1) against new lines [n0, n1). */
    /** @type {(o0: number, o1: number, n0: number, n1: number) => void} */
    var stretch = function(o0, o1, n0, n1) {
        var n = o1 - o0;
        var m = n1 - n0;
        if (!n) { for (var k = n0; k < n1; k++) { addedLine(k); } return; }
        if (!m) { for (var d = o0; d < o1; d++) { removedLine(d); } return; }
        var GAP = 0.6;
        var MIN = 0.4;
        /** @type {number[][]} */
        var sim = [];
        for (var a = 0; a < n; a++) {
            sim.push([]);
            for (var b = 0; b < m; b++) { sim[a].push(n * m > 40000 ? (a === b ? 1 : 0) : mdbLineSimilarity(oldLines[o0 + a], newLines[n0 + b])); }
        }
        /** @type {number[][]} */
        var cost = [];
        for (var r = 0; r <= n; r++) { cost.push(new Array(m + 1).fill(0)); }
        for (var x = n; x >= 0; x--) {
            for (var y = m; y >= 0; y--) {
                if (x === n && y === m) { continue; }
                var best = Infinity;
                if (x < n) { best = Math.min(best, GAP + cost[x + 1][y]); }
                if (y < m) { best = Math.min(best, GAP + cost[x][y + 1]); }
                if (x < n && y < m && sim[x][y] >= MIN) { best = Math.min(best, 1 - sim[x][y] + cost[x + 1][y + 1]); }
                cost[x][y] = best;
            }
        }
        var i = 0;
        var j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && sim[i][j] >= MIN && Math.abs(cost[i][j] - (1 - sim[i][j] + cost[i + 1][j + 1])) < 1e-9) {
                changedLine(o0 + i, n0 + j); i++; j++;
            } else if (i < n && Math.abs(cost[i][j] - (GAP + cost[i + 1][j])) < 1e-9) {
                removedLine(o0 + i); i++;
            } else {
                addedLine(n0 + j); j++;
            }
        }
    };
    var oi = 0;
    var ni = 0;
    same.forEach(function(pair) {
        stretch(oi, pair[0], ni, pair[1]);
        out.push(newLines[pair[1]]);
        oi = pair[0] + 1;
        ni = pair[1] + 1;
    });
    stretch(oi, oldLines.length, ni, newLines.length);
    return { text: out.join(eol), marks: counter.marks, untracked: counter.untracked };
}
