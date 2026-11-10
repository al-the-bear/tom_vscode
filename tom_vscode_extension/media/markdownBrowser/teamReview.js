// Markdown Browser — the team review notation (SOM §11.9.8): individual
// answers, conflict blocks, the member colours, and the edits that decide them.
//
// Pure string logic with no DOM and no `vscode` handle, like blocks.js: loaded
// as a classic script after it and before main.js, and unit-tested in a bare
// `vm` sandbox (src/utils/__tests__/mdBrowserTeamReview.test.ts). Line numbers
// are 0-based lines of the text shown; edits are `{startLine, endLine,
// expected, replacement}` with `endLine` exclusive, as main.js posts them.
/* exported mdbIndividualAnswers, mdbMostChosen, mdbOpenSummary, mdbConflictAt, mdbConflictEdit, mdbConflictChosenText, mdbMemberColor, MDB_MEMBER_COLORS, MDB_CONFLICT_HEAD */

/**
 * An individual answer line, `**Answer (alice, bob):** (a) because …`, with
 * an optional change time as the last part of the list (SOM §11.9.10). A list
 * holding only a time is the team answer, not an individual one.
 */
var MDB_INDIVIDUAL_ANSWER = /^\s*(?:>\s?)*\*\*Answer \(([^()]*)\):\*\*\s?(.*)$/;
var MDB_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
var MDB_LETTER = /^\s*\*{0,2}\(([a-z])\)\*{0,2}/;

/**
 * The individual answers of the question whose team `**Answer:**` is on
 * `teamLine`: the `**Answer (<ids>):**` lines above it in the same quote
 * block, in order, each with its members, its answer (continuation lines kept)
 * and the option letter it starts with (or '').
 *
 * @param {string[]} lines
 * @param {number} teamLine
 * @returns {Array<{line: number, members: string[], answer: string, letter: string}>}
 */
function mdbIndividualAnswers(lines, teamLine) {
    /** @type {Array<{line: number, members: string[], answer: string, letter: string}>} */
    var out = [];
    var head = teamLine - 1;
    // The question's block: the quoted lines above the team answer.
    while (head >= 0 && /^\s*>/.test(lines[head]) && !/\*\*❓/.test(lines[head])) { head--; }
    for (var i = Math.max(head, 0); i < teamLine; i++) {
        var m = MDB_INDIVIDUAL_ANSWER.exec(lines[i] || '');
        if (!m) { continue; }
        var parts = m[1].split(',').map(function(p) { return p.trim(); }).filter(function(p) { return p; });
        if (parts.length && MDB_TIME.test(parts[parts.length - 1])) { parts.pop(); }
        if (parts.length === 0) { continue; }
        var text = [m[2]];
        // Continuation lines: quoted, not a blank `>`, not another label.
        for (var k = i + 1; k < teamLine; k++) {
            var inner = String(lines[k] || '').replace(/^\s*(?:>\s?)*/, '');
            if (!/^\s*>/.test(lines[k] || '') || !inner.trim() || /^\*\*Answer/.test(inner)) { break; }
            text.push(inner);
        }
        var answer = text.join('\n').trim();
        var letter = MDB_LETTER.exec(answer);
        out.push({ line: i, members: parts, answer: answer, letter: letter ? letter[1] : '' });
    }
    return out;
}

/**
 * The option most members chose, counting every member of a shared line;
 * '' when nobody chose an option or two options tie for the most.
 *
 * @param {Array<{members: string[], letter: string}>} answers
 * @returns {string}
 */
function mdbMostChosen(answers) {
    /** @type {Record<string, number>} */
    var votes = {};
    answers.forEach(function(a) { if (a.letter) { votes[a.letter] = (votes[a.letter] || 0) + a.members.length; } });
    var best = '';
    var most = 0;
    var tie = false;
    Object.keys(votes).sort().forEach(function(letter) {
        if (votes[letter] > most) { best = letter; most = votes[letter]; tie = false; } else if (votes[letter] === most) { tie = true; }
    });
    return tie ? '' : best;
}

/**
 * The summary an `open:` answer starts from: every member's position, by
 * display name, e.g. `open: Alice Owner (a); Bob Dev (b) — Swiss customers`.
 *
 * @param {Array<{members: string[], answer: string}>} answers
 * @param {Record<string, string>} names member id → display name
 * @returns {string}
 */
function mdbOpenSummary(answers, names) {
    var parts = answers.map(function(a) {
        var who = a.members.map(function(id) { return names[id] || id; }).join(', ');
        return who + ' ' + a.answer.replace(/\s*\n\s*/g, ' ');
    });
    return 'open: ' + (parts.length ? parts.join('; ') : '');
}

/** A conflict block's header line: `> ⚖️ **X-3 — topic:** text`. */
var MDB_CONFLICT_HEAD = /^\s*>\s?⚖️?\s*\*\*(X-[1-9][0-9]*) — (.+?):\*\*\s?(.*)$/;
var MDB_ALTERNATIVE = /^- \(([a-z]|base)\)\s?(?:\*\*([a-z0-9_, ]+):\*\*\s?)?(.*)$/;
/**
 * Topics of the structural conflicts a merge writes; their decision is not a text.
 * @type {Record<string, boolean>}
 */
var MDB_STRUCTURAL_TOPICS = { 'Item removed': true, 'Item moved': true, 'Headline changed': true };

/**
 * The conflict block that opens on `line`, or null: its id, topic and text,
 * the base, the lettered alternatives with their members, the decision
 * written (with its line, -1 when the block has none), and the block's lines
 * `[startLine, endLine)`.
 *
 * @param {string[]} lines
 * @param {number} line
 * @returns {{id: string, topic: string, text: string, base: string, alternatives: Array<{letter: string, members: string[], text: string}>, decision: string, decisionLine: number, startLine: number, endLine: number, structural: boolean} | null}
 */
function mdbConflictAt(lines, line) {
    var head = MDB_CONFLICT_HEAD.exec(lines[line] || '');
    if (!head) { return null; }
    var end = line + 1;
    while (end < lines.length && /^\s*>/.test(lines[end])) { end++; }
    var base = '';
    /** @type {Array<{letter: string, members: string[], text: string}>} */
    var alternatives = [];
    var decision = '';
    var decisionLine = -1;
    /** @type {{text: string[]} | null} */
    var current = null;
    /** @type {string[] | null} */
    var baseParts = null;
    for (var i = line + 1; i < end; i++) {
        var inner = String(lines[i]).replace(/^\s*>\s?/, '');
        if (/^\*\*Decision:\*\*/.test(inner)) {
            decisionLine = i;
            var d = [inner.replace(/^\*\*Decision:\*\*\s?/, '')];
            for (var k = i + 1; k < end; k++) { d.push(String(lines[k]).replace(/^\s*>\s?/, '')); }
            decision = d.join('\n').trim();
            break;
        }
        var alt = MDB_ALTERNATIVE.exec(inner);
        if (alt) {
            if (alt[1] === 'base') {
                baseParts = [alt[3]];
                current = { text: baseParts };
            } else {
                var entry = { letter: alt[1], members: (alt[2] || '').split(',').map(function(x) { return x.trim(); }).filter(function(x) { return x; }), text: '' };
                var parts = [alt[3]];
                alternatives.push(entry);
                current = { text: parts };
                /** @type {any} */ (entry).parts = parts;
            }
            continue;
        }
        // A continuation line of the alternative above (indented), or the gap before the decision.
        if (current && /^\s+\S/.test(inner)) { current.text.push(inner.replace(/^\s{2}/, '')); continue; }
        current = null;
    }
    if (baseParts) { base = baseParts.join('\n'); }
    alternatives.forEach(function(a) {
        var withParts = /** @type {any} */ (a);
        a.text = withParts.parts.join('\n');
        delete withParts.parts;
    });
    return {
        id: head[1], topic: head[2], text: head[3].trim(), base: base, alternatives: alternatives,
        decision: decision, decisionLine: decisionLine, startLine: line, endLine: end,
        structural: !!MDB_STRUCTURAL_TOPICS[head[2]],
    };
}

/**
 * The text a choice stands for: an alternative's (`{letter: 'a'}`), the
 * base (`{letter: 'base'}`) or text written by hand (`{text}`).
 *
 * @param {{base: string, alternatives: Array<{letter: string, text: string}>}} conflict
 * @param {{letter?: string, text?: string}} choice
 * @returns {string | null}
 */
function mdbConflictChosenText(conflict, choice) {
    if (typeof choice.text === 'string') { return choice.text; }
    if (choice.letter === 'base') { return conflict.base; }
    var alt = conflict.alternatives.filter(function(a) { return a.letter === choice.letter; })[0];
    return alt ? alt.text : null;
}

/**
 * Whether a paragraph starting on `line` is an annotation block (a comment,
 * a question, a conflict), not text the decision could replace.
 *
 * @param {string} line
 * @returns {boolean}
 */
function mdbIsAnnotationLine(line) {
    return /^\s*>\s?(?:⬆️|⚖️|\*\*❓|\*\*[A-Z][A-Z0-9]*-\d+ (?:★ )?—)/.test(line);
}

/**
 * The edit deciding a conflict, as the runtime applies a decision (SOM
 * §11.9.8, "Applying"): the chosen text replaces the text paragraph directly
 * before the block (annotation blocks between them skipped) and the block is
 * removed with the blank line after it. A conflict about a whole value (its
 * text names no paragraph) replaces the run of text paragraphs up to the block.
 * A structural conflict, or one whose target is a form field or another value
 * (`<path> <field>`, a path that is not this place), is not written into the
 * text here: its decision line is set instead, and tomAi_specRemoveAllAnnotations
 * applies it (`decisionOnly: true`). `{open}` writes `open: …` as the decision
 * and keeps the block. Null when the choice names no alternative.
 *
 * @param {string[]} lines
 * @param {{id: string, text: string, base: string, alternatives: Array<{letter: string, text: string}>, decisionLine: number, startLine: number, endLine: number, structural: boolean}} conflict
 * @param {{letter?: string, text?: string, open?: string}} choice
 * @returns {{startLine: number, endLine: number, expected: string, replacement: string, decisionOnly: boolean} | null}
 */
function mdbConflictEdit(lines, conflict, choice) {
    if (typeof choice.open === 'string') {
        return mdbDecisionLineEdit(lines, conflict, choice.open.trim() || 'open:');
    }
    var chosen = mdbConflictChosenText(conflict, choice);
    if (chosen === null) { return null; }
    var paragraphNamed = /, paragraph \d+$/.test(conflict.text);
    var elsewhere = conflict.structural || /^\S+ \S+$/.test(conflict.text) && !paragraphNamed;
    if (elsewhere) {
        var decision = typeof choice.text === 'string' ? choice.text : '(' + choice.letter + ')';
        return mdbDecisionLineEdit(lines, conflict, decision);
    }
    // The text paragraphs above the block, back to the section's heading.
    /** @type {Array<[number, number]>} */
    var paragraphs = [];
    var k = conflict.startLine - 1;
    while (k >= 0 && !/^#{1,6}\s/.test(lines[k])) {
        if (!String(lines[k]).trim()) { k--; continue; }
        var last = k;
        while (k - 1 >= 0 && String(lines[k - 1]).trim() && !/^#{1,6}\s/.test(lines[k - 1])) { k--; }
        paragraphs.unshift([k, last]);
        k--;
    }
    var texts = paragraphs.filter(function(p) { return !mdbIsAnnotationLine(lines[p[0]]); });
    var blockEnd = conflict.endLine < lines.length && !String(lines[conflict.endLine]).trim() ? conflict.endLine + 1 : conflict.endLine;
    var from;
    var to;
    if (!paragraphNamed) {
        // A whole value: the run of text paragraphs directly above the block.
        var run = [];
        for (var r = paragraphs.length - 1; r >= 0 && !mdbIsAnnotationLine(lines[paragraphs[r][0]]); r--) { run.unshift(paragraphs[r]); }
        if (run.length) { from = run[0][0]; to = run[run.length - 1][1]; }
    } else if (texts.length) {
        from = texts[texts.length - 1][0];
        to = texts[texts.length - 1][1];
    }
    var startLine = from === undefined ? conflict.startLine : from;
    var kept = from === undefined ? [] : lines.slice(/** @type {number} */ (to) + 1, conflict.startLine);
    var replacement = from === undefined
        ? chosen.split('\n').concat([''])
        : chosen.split('\n').concat(kept);
    // Between the replaced paragraph and the block: drop the trailing blank line the block leaves behind.
    while (replacement.length && from !== undefined && blockEnd >= lines.length && !String(replacement[replacement.length - 1]).trim()) { replacement.pop(); }
    return {
        startLine: startLine, endLine: blockEnd,
        expected: lines.slice(startLine, blockEnd).join('\n'),
        replacement: replacement.join('\n'),
        decisionOnly: false,
    };
}

/**
 * The edit writing `decision` on a conflict's `**Decision:**` line (added
 * when the block has none), the block otherwise kept.
 *
 * @param {string[]} lines
 * @param {{decisionLine: number, startLine: number, endLine: number}} conflict
 * @param {string} decision
 * @returns {{startLine: number, endLine: number, expected: string, replacement: string, decisionOnly: boolean}}
 */
function mdbDecisionLineEdit(lines, conflict, decision) {
    var written = decision.split('\n');
    var block = ['> **Decision:** ' + written[0]].concat(written.slice(1).map(function(l) { return l ? '> ' + l : '>'; }));
    if (conflict.decisionLine < 0) {
        return {
            startLine: conflict.endLine, endLine: conflict.endLine, expected: '',
            replacement: ['>'].concat(block).join('\n') + '\n', decisionOnly: true,
        };
    }
    return {
        startLine: conflict.decisionLine, endLine: conflict.endLine,
        expected: lines.slice(conflict.decisionLine, conflict.endLine).join('\n'),
        replacement: block.join('\n'), decisionOnly: true,
    };
}

/** The member colours: distinct hues readable on light and dark themes. */
var MDB_MEMBER_COLORS = ['#3b82f6', '#e8590c', '#2f9e44', '#ae3ec9', '#e03131', '#1098ad', '#f08c00', '#5c7cfa', '#c2255c', '#66a80f'];

/**
 * The colour of a member: by its place in the team, else by its id.
 *
 * @param {string} memberId
 * @param {string[]} team member ids in team order
 * @returns {string}
 */
function mdbMemberColor(memberId, team) {
    var index = team.indexOf(memberId);
    if (index < 0) {
        index = 0;
        for (var i = 0; i < memberId.length; i++) { index = (index * 31 + memberId.charCodeAt(i)) % 1000; }
    }
    return MDB_MEMBER_COLORS[index % MDB_MEMBER_COLORS.length];
}
