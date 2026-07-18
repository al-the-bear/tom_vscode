/**
 * Pre-render transforms for the MD Browser (`markdownBrowser-handler.ts`).
 *
 * marked.js renders standard markdown, but the MD Browser adds three things it
 * cannot express on its own. This module owns the pure, DOM-free logic for all
 * three so the webview stays glue-only and the behaviour is unit-testable
 * without the VS Code host:
 *
 *  1. **Up to 10 heading levels.** HTML only has `h1`–`h6`. A level 1–10
 *     heading is emitted as a *capped* markdown heading (max 6 hashes, so marked
 *     still renders inline markdown in the title) carrying an invisible marker
 *     span with `data-level` = the true level. The webview promotes that to a
 *     `md-h{level}` class for per-level styling.
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
    /** Heading depth, 1..10 (counted from the leading hashes). */
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

// Up to 3 leading spaces (CommonMark), 1–10 hashes, optional space + text.
const HEADING_RE = /^ {0,3}(#{1,10})(?:[ \t]+([^\n]*?))?[ \t]*$/;
// A leading `<!--[id]-->` comment (spaces around the brackets are tolerated).
const ID_COMMENT_RE = /^<!--\s*\[([^\]]+)\]\s*-->\s*/;
// An ATX closing hash sequence (` ##` at end of line).
const CLOSING_HASHES_RE = /\s+#+\s*$/;
// A fenced code-block delimiter (``` or ~~~, 3+ of a kind).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Parse a single line as an ATX heading. Returns `null` when the line is not a
 * heading (including 11+ hashes, or hashes with no following space + text).
 */
export function parseHeadingLine(line: string): ParsedHeading | null {
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
