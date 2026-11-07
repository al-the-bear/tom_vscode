// Questions and answers in Markdown — the parser the MD Browser and the
// extension host share.
//
// The review syntax: a question block `> **❓ BQ-07 — topic:** text` (in a block
// of several, also `> **BQ-08 — field:** text`), its options `> - (a) …` (the
// recommended one bold, `**(b)**`), maybe `> *Recommendation:* (c) …`, and
// `> **Answer:**` with the answer after it.
//
// Pure string logic: no DOM, no `vscode`, no module system. The MD Browser
// loads it as a classic script before blocks.js and main.js (its declarations
// are globals they call); the host runs the same file in a `vm` context and
// takes the declarations from there (src/utils/mdQuestions.ts), so the browser
// and the agents' tools (tomAi_mdQuestions, tomAi_mdSetAnswer,
// tomAi_mdProposeAnswer) read a document the same way.
/* exported MDB_ANSWER_MARKER, mdbAnswerMarkers, mdbAnswerAt, mdbWriteAnswer, mdbQuestionAt, mdbQuestionOptions, mdbOptionAnswer, mdbQuestionHeads, mdbQuoteDepth, mdbProposedAnswerAt, mdbProposedAnswerLines */

/** The review-answer marker an answer is written after. */
var MDB_ANSWER_MARKER = '**Answer:**';

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
        if (l.indexOf(MDB_ANSWER_MARKER) >= 0 || l.trim() === '' || MDB_PROPOSED_ANSWER.test(l)) { break; }
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
 * For a SOM document the host reads the questions with the TomSpecs runtime
 * (som-review-comments.ts); `fromRuntime` maps a question id to that reading,
 * whose options and recommended letter then replace the browser's own, so the
 * browser and the agents' tools read a question the same way. `source` says
 * which reading was used.
 *
 * @param {string[]} lines
 * @param {number} answerLine
 * @param {Object<string, {options: Array<{letter: string, text: string, bold: boolean}>, recommended: (string|null)}>|null} [fromRuntime]
 * @returns {{id: string, line: number, options: Array<{letter: string, text: string, bold: boolean}>, recommended: (string|null), source: string}|null}
 */
function mdbQuestionAt(lines, answerLine, fromRuntime) {
    var head = -1;
    var id = '';
    for (var i = answerLine - (lines[answerLine].indexOf(MDB_ANSWER_MARKER) > 0 && MDB_QUESTION_HEAD.test(lines[answerLine]) ? 0 : 1); i >= 0 && i > answerLine - 400; i--) {
        if (i < answerLine && lines[i].indexOf(MDB_ANSWER_MARKER) >= 0) { break; }
        if (/^\s*#/.test(lines[i])) { break; }
        var h = MDB_QUESTION_HEAD.exec(lines[i]);
        if (h) { head = i; id = h[1] || h[2]; break; }
    }
    if (head < 0) { return null; }
    var known = fromRuntime && Object.prototype.hasOwnProperty.call(fromRuntime, id) ? fromRuntime[id] : null;
    if (known) {
        return { id: id, line: head, options: known.options.slice(), recommended: known.recommended, source: 'runtime' };
    }
    var parsed = mdbQuestionOptions(lines, head, answerLine);
    return { id: id, line: head, options: parsed.options, recommended: parsed.recommended, source: 'browser' };
}

/**
 * The options of the question whose header is `lines[head]`, read on the lines
 * after it up to `end` (exclusive), and the recommended option — the bold one,
 * else the one whose text says "recommended", else the letter a
 * `*Recommendation:*` line names.
 *
 * @param {string[]} lines
 * @param {number} head
 * @param {number} end
 * @returns {{options: Array<{letter: string, text: string, bold: boolean}>, recommended: (string|null)}}
 */
function mdbQuestionOptions(lines, head, end) {
    /** @type {Array<{letter: string, text: string, bold: boolean}>} */
    var options = [];
    var fromLine = null;
    var current = null;
    for (var k = head + 1; k < end; k++) {
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
    return { options: options, recommended: recommended };
}

/** A header's topic: `— topic:**` (or `— topic**`) after the id. */
var MDB_QUESTION_TOPIC = /—\s*(.*?):?\*\*\s*(.*)$/;

/**
 * Every question header outside fenced code, in document order: its id, the
 * line, the topic (the words between the dash and the closing `**`, without
 * the colon; empty when the header has none) and the text after the header.
 *
 * @param {string} text
 * @returns {Array<{id: string, line: number, topic: string, text: string}>}
 */
function mdbQuestionHeads(text) {
    var lines = String(text || '').replace(/\r\n|\r/g, '\n').split('\n');
    var out = [];
    var fence = null;
    for (var i = 0; i < lines.length; i++) {
        var f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
        if (f) {
            if (fence === null) { fence = f[1][0]; continue; }
            if (fence === f[1][0]) { fence = null; continue; }
        }
        if (fence !== null) { continue; }
        var h = MDB_QUESTION_HEAD.exec(lines[i]);
        if (!h) { continue; }
        var after = lines[i].slice(h.index);
        var t = MDB_QUESTION_TOPIC.exec(after);
        var rest = t ? t[2] : '';
        var answerAt = rest.indexOf(MDB_ANSWER_MARKER);
        if (answerAt >= 0) { rest = rest.slice(0, answerAt); }
        out.push({ id: h[1] || h[2], line: i, topic: t ? t[1].trim() : '', text: rest.trim() });
    }
    return out;
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

// ---- Proposed answers ----
// A helper (Grill me, an agent) does not answer for the user: it writes its
// proposal under the question, after the answer and a bare quote line, as
// `> **Proposed answer** (<source>, <date>): text`; the user accepts, edits or
// discards it.

/** A proposed-answer line: `**Proposed answer** (<source>, <date>): text`, maybe quoted. */
var MDB_PROPOSED_ANSWER = /^\s*(?:>\s?)*\*\*Proposed answer\*\*\s*\(([^,()]*),\s*([^()]*)\):\s*(.*)$/;

/**
 * The proposed answer that starts on `lines[line]`, with the lines that
 * continue it (as an answer is read: the same quote up to a bare `>` or blank
 * line, another marker or proposal), or null when none starts there.
 *
 * @param {string[]} lines
 * @param {number} line
 * @returns {{source: string, date: string, text: string, line: number, endLine: number}|null}
 */
function mdbProposedAnswerAt(lines, line) {
    if (line < 0 || line >= lines.length) { return null; }
    var m = MDB_PROPOSED_ANSWER.exec(lines[line]);
    if (!m) { return null; }
    var parts = [m[3].trim()];
    var depth = mdbQuoteDepth(lines[line]);
    var end = line + 1;
    for (; end < lines.length; end++) {
        var l = lines[end];
        if (l.indexOf(MDB_ANSWER_MARKER) >= 0 || l.trim() === '' || MDB_PROPOSED_ANSWER.test(l)) { break; }
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
    return { source: m[1].trim(), date: m[2].trim(), text: parts.join('\n'), line: line, endLine: end };
}

/**
 * The lines of a proposed answer under `prefix` (the quote prefix, e.g. `> `):
 * the head line and each further line of `text`; blank lines are dropped (they
 * would end it). `source` loses the characters that would end the bracket.
 *
 * @param {string} prefix
 * @param {string} source
 * @param {string} date
 * @param {string} text
 * @returns {string[]}
 */
function mdbProposedAnswerLines(prefix, source, date, text) {
    var body = String(text).replace(/\r\n|\r/g, '\n').split('\n')
        .map(function(l) { return l.trim(); })
        .filter(function(l) { return l !== ''; });
    var who = String(source).replace(/[,()\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'agent';
    var headLine = prefix + '**Proposed answer** (' + who + ', ' + date + '): ' + (body[0] || '');
    return [headLine.replace(/\s+$/, '')].concat(body.slice(1).map(function(l) { return prefix + l; }));
}
