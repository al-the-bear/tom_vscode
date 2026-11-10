// Markdown Browser — source mapping for in-place editing.
//
// Pure string logic with no DOM and no `vscode` handle, kept in its own file so
// it can be loaded into a bare `vm` sandbox and unit-tested directly
// (src/utils/__tests__/mdBrowserBlocks.test.ts). Loaded as a classic script
// before main.js; the declarations below are globals main.js calls. The question
// and answer parser is media/shared/mdQuestions.js, loaded before this file and
// shared with the extension host (src/utils/mdQuestions.ts).
/* exported mdbCriticMark, mdbEditInlineComment, mdbChangeQuote, mdbChangeWithComment, mdbQuoteMatches, mdbCountLabel, mdbIsCommentLine, mdbCommentAt, mdbNextCommentId, mdbInRanges, mdbWriteComment, mdbSplitForLexing, mdbSectionRefs, mdbResolveSectionRef, mdbMdPaths, mdbIsMdLink, mdbBlocks, mdbFoldHidden, mdbFoldAncestors, mdbIndentDepths, mdbGroups, mdbNavPick, mdbRevealDelta, MDB_LONG_COMMENT, MDB_CHECK_HERE, mdbIsAgentAuthor, mdbCommentAuthor, mdbCommentHeader, mdbCommentBody, mdbAttribution, MDB_CHANGE_TIME */
//
// The browser renders the backend's transformed text. Without the CR/LF
// conversion that transform keeps every line where it is (it only rewrites
// heading lines), so a line number here is a line number in the file.

/**
 * Block types that get edit / insert buttons in edit mode.
 * @type {Record<string, boolean>}
 */
var MDB_EDITABLE_TYPES = { paragraph: true, list: true, blockquote: true, table: true, code: true };

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
