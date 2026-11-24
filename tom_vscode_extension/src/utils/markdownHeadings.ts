/**
 * Pre-render transforms for the MD Browser (`markdownBrowser-handler.ts`).
 *
 * marked.js renders standard markdown, but the MD Browser adds three things it
 * cannot express on its own. This module owns the pure, DOM-free logic for all
 * three so the webview stays glue-only and the behaviour is unit-testable
 * without the VS Code host:
 *
 *  1. **Any heading level.** HTML only has `h1`–`h6`. A heading of any level
 *     is emitted as a *capped* markdown heading (max 6 hashes, so marked still
 *     renders inline markdown in the title) carrying an invisible marker span
 *     with `data-level` = the true level. The webview promotes that to a
 *     `md-h{level}` class for per-level styling. A styled-div heading of a
 *     readable rendition (`<div class="heading<N>" …><!--[ID]--> Title</div>`,
 *     N ≥ 7; reading_view part *The MD Browser*) is read as a heading of level
 *     N and rewritten the same way, one line for one line.
 *
 *  2. **Per-heading IDs.** An id may be declared in a leading HTML comment:
 *     `###### <!--[FR-3]--> Functional Requirement 3`. The id is always shown as
 *     a badge inside the heading, and every heading also carries a dotted
 *     "full id" — its own id chained after the ids of every ancestor heading it
 *     is nested inside (idless ancestors contribute nothing but still nest).
 *     The webview renders the full id as a toggle-able sub-line.
 *
 *  3. **CR/LF conversion.** An opt-in pass that turns escaped (`\n`, `\r\n`,
 *     `\r`) and literal CR/CRLF line-break characters into real newlines, so an
 *     escaped blob (e.g. JSON-embedded text) reads as multiple lines.
 */

/** A heading line split into its level, optional id, and remaining text. */
export interface ParsedHeading {
    /** Heading depth, 1 or more (the leading hashes, or a heading div's N). */
    level: number;
    /** The id from a leading `<!--[id]-->` comment, or '' when absent. */
    id: string;
    /** The heading text after the id, still markdown (inline rendered later). */
    text: string;
}

/** Options for {@link transformMarkdown}. */
export interface TransformOptions {
    /** When true, apply {@link convertLineBreaks} before scanning headings. */
    convertLineBreaks?: boolean;
}

// Up to 3 leading spaces (CommonMark), one or more hashes, optional space + text.
const HEADING_RE = /^ {0,3}(#+)(?:[ \t]+([^\n]*?))?[ \t]*$/;
// A styled-div heading of a readable rendition: `<div class="heading<N>" …>` … `</div>` on one line.
const HEADING_DIV_RE = /^ {0,3}<div\s+class="heading(\d+)"[^>]*>(.*)<\/div>[ \t]*$/;
/** The lowest level a heading div is read at (a `heading<N>` div with N ≤ 6 stays content). */
export const HEADING_DIV_MIN_LEVEL = 7;
// An empty HTML anchor in a heading div's title (`<a id="X"></a>`), kept as HTML.
const EMPTY_ANCHOR_RE = /<a\s+(?:id|name)="[^"]*"\s*><\/a>/g;
// A leading `<!--[id]-->` comment (spaces around the brackets are tolerated).
const ID_COMMENT_RE = /^<!--\s*\[([^\]]+)\]\s*-->\s*/;
// An ATX closing hash sequence (` ##` at end of line).
const CLOSING_HASHES_RE = /\s+#+\s*$/;
// A fenced code-block delimiter (``` or ~~~, 3+ of a kind).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Parse a single line as an ATX heading (any number of hashes) or a styled-div
 * heading (`<div class="heading<N>" …><!--[ID]--> Title</div>`, N ≥ 7). Returns
 * `null` when the line is not a heading (hashes with no following space + text,
 * a `heading<N>` div with N ≤ 6, a `\<div` line).
 */
export function parseHeadingLine(line: string): ParsedHeading | null {
    const div = parseHeadingDiv(line);
    if (div) { return div; }
    const m = HEADING_RE.exec(line);
    if (!m) { return null; }
    const level = m[1].length;
    let rest = (m[2] ?? '').trim();
    rest = rest.replace(CLOSING_HASHES_RE, '').trim();
    let id = '';
    const idm = ID_COMMENT_RE.exec(rest);
    if (idm) {
        id = idm[1].trim();
        rest = rest.slice(idm[0].length);
    }
    return { level, id, text: rest.trim() };
}

/**
 * A styled-div heading: its level N (≥ {@link HEADING_DIV_MIN_LEVEL}), the id
 * of its leading `<!--[ID]-->` and its title as the div showed it — HTML
 * entities unescaped, then the Markdown punctuation escaped, so marked renders
 * the text and not its markup. Empty `<a id>` anchors in the title stay HTML
 * (the targets of links into the rendition).
 */
function parseHeadingDiv(line: string): ParsedHeading | null {
    const m = HEADING_DIV_RE.exec(line);
    if (!m) { return null; }
    const level = parseInt(m[1], 10);
    if (!(level >= HEADING_DIV_MIN_LEVEL)) { return null; }
    let rest = m[2].trim();
    let id = '';
    const idm = ID_COMMENT_RE.exec(rest);
    if (idm) {
        id = idm[1].trim();
        rest = rest.slice(idm[0].length);
    }
    const anchors = rest.match(EMPTY_ANCHOR_RE) ?? [];
    const title = escapeMarkdown(unescapeHtml(rest.replace(EMPTY_ANCHOR_RE, '').trim()));
    return { level, id, text: [...anchors, title].filter(Boolean).join(' ') };
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** HTML entities (named, `&#n;`, `&#xh;`) as their characters; an unknown name stays as written. */
function unescapeHtml(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
        if (name[0] === '#') {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return HTML_ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/** Every character Markdown or HTML would read as markup, backslash-escaped (CommonMark escapes any ASCII punctuation). */
function escapeMarkdown(s: string): string {
    return s.replace(/[\\`*_{}[\]()<>#+!|~&]/g, (c) => `\\${c}`);
}

/**
 * Turn escaped and literal line-break characters into real newlines. Handles
 * escaped `\r\n`, `\n`, `\r` (backslash sequences) and actual CR / CRLF.
 */
export function convertLineBreaks(text: string): string {
    return text
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

/**
 * Where each line {@link convertLineBreaks} shows comes from in the file: the
 * file line's index (lines split as the editor splits them, at `\n` / `\r\n`),
 * or -1 for a line the conversion made by splitting or changing a file line
 * (an escaped break, a bare CR). `null` when every file line is shown as it
 * is — then the shown lines are the file's lines. The Markdown Browser edits a
 * block with CR/LF on only when all its lines map to consecutive file lines.
 */
export function crlfLineMap(raw: string): number[] | null {
    const map: number[] = [];
    let moved = false;
    raw.split(/\r?\n/).forEach((line, index) => {
        const converted = convertLineBreaks(line);
        if (converted === line) {
            map.push(index);
            return;
        }
        moved = true;
        for (let i = converted.split('\n').length; i > 0; i--) { map.push(-1); }
    });
    return moved ? map : null;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Rebuild a parsed heading as a marked-friendly markdown line: capped hashes
 * (so inline markdown in the title still renders), an inline id badge, and an
 * invisible marker span carrying the true level + full id for the webview.
 */
function renderHeadingLine(h: ParsedHeading, fullId: string): string {
    const hashes = '#'.repeat(Math.min(h.level, 6));
    const badge = h.id
        ? `<span class="md-heading-id">${escapeHtml(h.id)}</span> `
        : '';
    const meta = `<span class="md-heading-meta" data-level="${h.level}"`
        + ` data-fullid="${escapeAttr(fullId)}"></span>`;
    const body = h.text ? `${badge}${h.text} ${meta}` : `${badge}${meta}`;
    return `${hashes} ${body}`.replace(/[ \t]+$/, '');
}

/**
 * Transform raw markdown for the MD Browser: optionally convert line breaks,
 * then rewrite every heading (outside fenced code) into a marked-friendly line
 * carrying its id badge, true level, and dotted full id.
 */
export function transformMarkdown(raw: string, opts: TransformOptions = {}): string {
    const text = opts.convertLineBreaks ? convertLineBreaks(raw) : raw;
    const lines = text.split('\n');
    const out: string[] = [];
    // Ancestor stack (one entry per open heading level) used to build full ids.
    const stack: Array<{ level: number; id: string }> = [];
    let fence: string | null = null;

    for (const line of lines) {
        const fm = FENCE_RE.exec(line);
        if (fm) {
            const marker = fm[1][0];
            if (fence === null) { fence = marker; out.push(line); continue; }
            if (fence === marker) { fence = null; out.push(line); continue; }
            // A different fence char while already fenced: still inside the block.
        }

        if (fence === null) {
            const h = parseHeadingLine(line);
            if (h) {
                while (stack.length && stack[stack.length - 1].level >= h.level) {
                    stack.pop();
                }
                stack.push({ level: h.level, id: h.id });
                const fullId = stack.filter(s => s.id).map(s => s.id).join('.');
                out.push(renderHeadingLine(h, fullId));
                continue;
            }
        }

        out.push(line);
    }

    return out.join('\n');
}
