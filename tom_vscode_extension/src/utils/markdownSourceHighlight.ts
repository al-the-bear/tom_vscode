/**
 * Minimal markdown **source** highlighter for the @WS panel's Logs viewer.
 *
 * Most of the Logs sub-tabs show a quest file as raw markdown rather than
 * rendered output, so the reader sees exactly what is on disk. There is no
 * syntax-highlighting library in this extension's dependency tree, and pulling
 * one in for a handful of read-only panes would be a poor trade — this is a
 * few dozen lines of line-based classification that covers the constructs the
 * quest files actually use.
 *
 * It is deliberately *not* a markdown parser: it never reorders, merges or
 * drops text. Every input character survives into the output (escaped), so the
 * rendered view lines up with the file line for line.
 *
 * **Escaping is load-bearing.** The output is assigned with `innerHTML` in a
 * webview that has no CSP, and the trail files quote user prompts verbatim —
 * so every character is escaped before any markup is added.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}

function span(cls: string, escaped: string): string {
    return `<span class="mdh-${cls}">${escaped}</span>`;
}

/** ``` or ~~~ opening/closing a fenced code block. */
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
/** ATX heading — the space after the hashes is what distinguishes it from `#tag`. */
const HEADING_RE = /^\s{0,3}#{1,6}\s/;
/** Three or more of the same marker, optionally spaced: `---`, `* * *`, `___`. */
const HR_RE = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const QUOTE_RE = /^\s*>/;
/** Leading bullet or ordered-list marker; the capture is the marker itself. */
const LIST_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/**
 * Wrap emphasis and links in `<span>`s. Operates on already-escaped text; the
 * escape sequences it introduces (`&amp;`, `&#39;`, …) contain none of the
 * characters this looks for, so they cannot be mistaken for markup.
 */
function highlightEmphasis(escaped: string): string {
    return escaped
        .replace(/\[[^\]]*\]\([^)]*\)/g, m => span('link', m))
        .replace(/\*\*[^*\n]+\*\*/g, m => span('bold', m))
        .replace(/(?<!\*)\*[^*\n]+\*(?!\*)/g, m => span('italic', m));
}

/**
 * Highlight the inline constructs of one prose line. Inline code is split out
 * first so that `*` inside a code span stays a literal asterisk rather than
 * being shown as emphasis the file does not contain.
 */
function highlightInline(escaped: string): string {
    return escaped
        .split(/(`[^`]*`)/g)
        .map(part => (part.length >= 2 && part.startsWith('`') && part.endsWith('`')
            ? span('inline-code', part)
            : highlightEmphasis(part)))
        .join('');
}

/** Classify and highlight a single line outside a fenced code block. */
function highlightProseLine(line: string): string {
    const escaped = escapeHtml(line);
    if (HEADING_RE.test(line)) { return span('heading', escaped); }
    // Checked before lists: `---` is a rule, not a bullet with no content.
    if (HR_RE.test(line)) { return span('hr', escaped); }
    if (TABLE_RE.test(line)) { return span('table', escaped); }
    if (QUOTE_RE.test(line)) { return span('quote', escaped); }
    const list = LIST_RE.exec(line);
    if (list) {
        const marker = escapeHtml(list[1]);
        return span('list', marker) + highlightInline(escapeHtml(line.slice(list[1].length)));
    }
    return highlightInline(escaped);
}

/**
 * Turn markdown source into escaped HTML with `mdh-*` span markers.
 *
 * An unterminated fence keeps everything after it marked as code: the viewer
 * shows a tail slice of a large file, so a block opened before the slice
 * boundary is routine, and flipping back to prose highlighting mid-block would
 * be more wrong than staying in code.
 */
export function highlightMarkdownSource(source: string): string {
    let inFence = false;
    return source.split('\n').map(line => {
        if (FENCE_RE.test(line)) {
            inFence = !inFence;
            return span('fence', escapeHtml(line));
        }
        return inFence ? span('code', escapeHtml(line)) : highlightProseLine(line);
    }).join('\n');
}
