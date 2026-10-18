// Markdown Browser — source mapping for in-place editing.
//
// Pure string logic with no DOM and no `vscode` handle, kept in its own file so
// it can be loaded into a bare `vm` sandbox and unit-tested directly
// (src/utils/__tests__/mdBrowserBlocks.test.ts). Loaded as a classic script
// before main.js; the declarations below are globals main.js calls.
/* exported MDB_ANSWER_MARKER, mdbSectionRefs, mdbResolveSectionRef, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbAnswerMarkers, mdbAnswerAt, mdbWriteAnswer, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups */
//
// The browser renders the backend's transformed text. Without the CR/LF
// conversion that transform keeps every line where it is (it only rewrites
// heading lines), so a line number here is a line number in the file.

/**
 * Block types that get edit / insert buttons in edit mode.
 * @type {Record<string, boolean>}
 */
var MDB_EDITABLE_TYPES = { paragraph: true, list: true, blockquote: true, table: true, code: true };

/** The review-answer marker an answer is written after. */
var MDB_ANSWER_MARKER = '**Answer:**';

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
 * Every `**Answer:**` marker outside fenced code: its line, the column just
 * after it, and its ordinal among the markers on lines `startLine..endLine`
 * of the block it sits in is derived by the caller.
 *
 * @param {string} text
 * @returns {Array<{line: number, column: number}>}
 */
function mdbAnswerMarkers(text) {
    var lines = String(text || '').replace(/\r\n|\r/g, '\n').split('\n');
    var out = [];
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
        var m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
        if (m) {
            if (fence === null) { fence = m[1][0]; continue; }
            if (fence === m[1][0]) { fence = null; continue; }
        }
        if (fence !== null) { continue; }
        var from = 0;
        for (;;) {
            var at = lines[i].indexOf(MDB_ANSWER_MARKER, from);
            if (at < 0) { break; }
            out.push({ line: i, column: at + MDB_ANSWER_MARKER.length });
            from = at + MDB_ANSWER_MARKER.length;
        }
    }
    return out;
}

/** A blockquote prefix (`> `, `>> `, with optional indentation). */
var MDB_QUOTE_PREFIX = /^\s*(?:>\s?)+/;
/** Lines that start a block of their own and so end an answer outside a quote. */
var MDB_BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|#|```|~~~|\||>)/;

/**
 * @param {string} line
 * @returns {number} the blockquote depth of the line
 */
function mdbQuoteDepth(line) {
    var m = MDB_QUOTE_PREFIX.exec(line);
    return m ? (m[0].match(/>/g) || []).length : 0;
}

/**
 * The answer written after the marker that ends at `column` of `lines[line]`,
 * as the answer import reads it: the rest of the line and, inside a
 * blockquote, the following lines of the same quote up to a bare `>` line, a
 * blank line or a line without `>`; outside a quote, the rest of the
 * paragraph. Another `**Answer:**` ends it, also later on the same line.
 *
 * @param {string[]} lines
 * @param {number} line
 * @param {number} column
 * @returns {{text: string, endLine: number}} the answer (lines joined by `\n`,
 *   quote prefixes removed) and the line after it
 */
function mdbAnswerAt(lines, line, column) {
    var rest = lines[line].slice(column);
    var next = rest.indexOf(MDB_ANSWER_MARKER);
    if (next >= 0) { return { text: rest.slice(0, next).trim(), endLine: line + 1 }; }
    var parts = [rest.trim()];
    var depth = mdbQuoteDepth(lines[line]);
    var end = line + 1;
    for (; end < lines.length; end++) {
        var l = lines[end];
        if (l.indexOf(MDB_ANSWER_MARKER) >= 0 || l.trim() === '') { break; }
        if (depth > 0) {
            if (mdbQuoteDepth(l) !== depth) { break; }
            var body = l.replace(MDB_QUOTE_PREFIX, '');
            if (body.trim() === '') { break; }
            parts.push(body.trim());
        } else {
            if (MDB_BLOCK_START.test(l)) { break; }
            parts.push(l.trim());
        }
    }
    return { text: parts.join('\n').replace(/^\n+/, ''), endLine: end };
}

/**
 * The lines `line .. mdbAnswerAt(...).endLine` with `answer` written after the
 * marker that ends at `column`: `**Answer:** <answer>`, each further line of
 * the answer under the same quote prefix. Blank lines would end the answer,
 * so they are dropped; an empty answer clears it. A marker followed by
 * another on its line keeps that rest and takes the answer on one line.
 *
 * @param {string[]} lines
 * @param {number} line
 * @param {number} column
 * @param {string} answer
 * @returns {string}
 */
function mdbWriteAnswer(lines, line, column, answer) {
    var text = lines[line];
    var head = text.slice(0, column);
    var answerLines = String(answer).replace(/\r\n|\r/g, '\n').split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l !== ''; });
    var rest = text.slice(column);
    var next = rest.indexOf(MDB_ANSWER_MARKER);
    if (next >= 0) {
        return head + (answerLines.length ? ' ' + answerLines.join(' ') : '') + ' ' + rest.slice(next);
    }
    if (answerLines.length === 0) { return head; }
    var quote = MDB_QUOTE_PREFIX.exec(text);
    var prefix = quote ? quote[0].replace(/\s*$/, ' ') : '';
    return [head + ' ' + answerLines[0]].concat(answerLines.slice(1).map(function(l) { return prefix + l; })).join('\n');
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

/**
 * The section references in `text`: two or more section ids joined by `>`
 * (`OUTER > INNER`), outer first.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number, ids: string[]}>}
 */
function mdbSectionRefs(text) {
    var re = new RegExp('(?<![A-Za-z0-9-])' + MDB_SECTION_ID + '(?:[ \\t]*>[ \\t]*' + MDB_SECTION_ID + ')+(?![A-Za-z0-9-])', 'g');
    var out = [];
    var m;
    while ((m = re.exec(String(text || ''))) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, ids: m[0].split('>').map(function(s) { return s.trim(); }) });
    }
    return out;
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
