// Markdown Browser — source mapping for in-place editing.
//
// Pure string logic with no DOM and no `vscode` handle, kept in its own file so
// it can be loaded into a bare `vm` sandbox and unit-tested directly
// (src/utils/__tests__/mdBrowserBlocks.test.ts). Loaded as a classic script
// before main.js; the declarations below are globals main.js calls.
/* exported mdbCriticMark, mdbQuestionAt, mdbOptionAnswer, mdbIsCommentLine, mdbCommentAt, mdbNextCommentId, mdbInRanges, mdbWriteComment, mdbSplitForLexing, MDB_ANSWER_MARKER, mdbSectionRefs, mdbResolveSectionRef, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbAnswerMarkers, mdbAnswerAt, mdbWriteAnswer, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups, mdbNavPick, mdbRevealDelta */
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

// ---- Questions and their options ----
// A question block (tom_specs annot1): `> **❓ BQ-07 — topic:** text`, in a
// block of several questions also `> **BQ-08 — field:** text`, then its
// options `> - (a) …` (continuation lines indented), maybe a
// `> *Recommendation:* (c) …` line, and `> **Answer:**`. Options are a single
// lowercase letter in round brackets; the recommended one is written bold,
// `**(b)**`.

/** A question header: `**❓ <ID>` or `**<ID> — `. */
var MDB_QUESTION_HEAD = /\*\*(?:❓\s*([A-Z][A-Z0-9]*-\d+)|([A-Z][A-Z0-9]*-\d+)\s*(?:★\s*)?—)/;
/** An option line: `- (a) text` or `- **(b)** text` (also `- **(b) text**`). */
var MDB_OPTION = /^\s*[-*]\s+(\*\*)?\(([a-z])\)(\*\*)?\s*(.*)$/;
var MDB_RECOMMENDATION = /^\s*\*?Recommendation:\*?\s*\(([a-z])\)/;

/**
 * The question the `**Answer:**` on `lines[answerLine]` answers: its id, the
 * line of its header, its options and the recommended option — the bold one,
 * else the one whose text says "recommended", else the letter a
 * `*Recommendation:*` line names. Null when no question header is found above
 * the answer (before the previous answer).
 *
 * @param {string[]} lines
 * @param {number} answerLine
 * @returns {{id: string, line: number, options: Array<{letter: string, text: string, bold: boolean}>, recommended: (string|null)}|null}
 */
function mdbQuestionAt(lines, answerLine) {
    var head = -1;
    var id = '';
    for (var i = answerLine - (lines[answerLine].indexOf(MDB_ANSWER_MARKER) > 0 && MDB_QUESTION_HEAD.test(lines[answerLine]) ? 0 : 1); i >= 0 && i > answerLine - 400; i--) {
        if (i < answerLine && lines[i].indexOf(MDB_ANSWER_MARKER) >= 0) { break; }
        if (/^\s*#/.test(lines[i])) { break; }
        var h = MDB_QUESTION_HEAD.exec(lines[i]);
        if (h) { head = i; id = h[1] || h[2]; break; }
    }
    if (head < 0) { return null; }
    /** @type {Array<{letter: string, text: string, bold: boolean}>} */
    var options = [];
    var fromLine = null;
    var current = null;
    for (var k = head + 1; k < answerLine; k++) {
        var body = lines[k].replace(MDB_QUOTE_PREFIX, '');
        var o = MDB_OPTION.exec(body);
        if (o) {
            var text = o[4];
            var bold = !!o[1];
            if (bold && !o[3]) { text = text.replace(/\*\*/, ''); }
            current = { letter: o[2], text: text.replace(/\*\*$/, '').trim(), bold: bold };
            options.push(current);
            continue;
        }
        var r = MDB_RECOMMENDATION.exec(body);
        if (r) { fromLine = r[1]; current = null; continue; }
        // An indented line continues the option above; anything else ends it.
        if (current && /^\s{2,}\S/.test(body)) { current.text += ' ' + body.trim(); continue; }
        current = null;
    }
    var recommended = null;
    for (var b = 0; b < options.length && recommended === null; b++) { if (options[b].bold) { recommended = options[b].letter; } }
    for (var t = 0; t < options.length && recommended === null; t++) { if (/\brecommended\b/i.test(options[t].text)) { recommended = options[t].letter; } }
    if (recommended === null && fromLine) { recommended = fromLine; }
    return { id: id, line: head, options: options, recommended: recommended };
}

/**
 * The answer that picks option `letter`: `(b)`.
 *
 * @param {string} letter
 * @returns {string}
 */
function mdbOptionAnswer(letter) {
    return '(' + letter + ')';
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

// ---- Lexing a large document in parts ----

/**
 * `text` cut into parts of at least `target` characters, each starting at an
 * ATX heading line outside fenced code and outside an open html element. An
 * ATX heading always starts a block of its own, so lexing the parts one by
 * one gives the tokens of lexing the whole (link definitions aside, which the
 * caller merges). The parts joined with `\n` are `text`.
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
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (f) {
            if (fence === null) { fence = f[1][0]; } else if (fence === f[1][0]) { fence = null; }
        } else if (fence === null) {
            if (i > start && size >= target && htmlDepth === 0 && /^#{1,6}(\s|$)/.test(line)) {
                parts.push({ startLine: start, text: lines.slice(start, i).join('\n') });
                start = i;
                size = 0;
            }
            if (/^\s{0,3}</.test(line)) { htmlDepth = Math.max(0, htmlDepth + mdbHtmlDepthChange(line)); }
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
 * @param {string} text
 * @param {string} nextId
 * @param {string} [author]
 * @returns {string}
 */
function mdbWriteComment(text, nextId, author) {
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
    if (author) {
        var head = /^(\s*\u2B06\uFE0F?\s*\*\*C-\d+\*\*)\s*([\s\S]*)$/.exec(first);
        if (head && !/^\(/.test(head[2])) {
            first = head[1] + ' (' + author + '):' + (head[2].replace(/^:\s*/, '') ? ' ' + head[2].replace(/^:\s*/, '') : '');
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
 * trimmed; a mark with no text, or one never closed, is no mark.
 *
 * @param {string} src
 * @returns {{raw: string, kind: string, text: string, oldText?: string, newText?: string, comment?: string} | null}
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
        /** @type {{raw: string, kind: string, text: string, comment?: string}} */
        var out = { raw: m[0], kind: kind, text: text };
        if (kind === 'highlight' && m[2] !== undefined && m[2].trim()) { out.comment = m[2].trim(); }
        return out;
    }
    return null;
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
