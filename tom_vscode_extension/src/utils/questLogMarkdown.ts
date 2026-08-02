/**
 * Markdown → HTML for the @WS Logs section's **MD Trail** tab.
 *
 * Rendering happens in the extension host rather than the webview: the @WS
 * panel is an accordion whose sections are composed into a single inline
 * `<script>`, so it has no place to hang an extra `<script src>` for a
 * client-side renderer, and no CSP to constrain what such a renderer produces.
 *
 * That second point is why this is more than a `marked.parse` call. The trail
 * quotes user prompts and model answers verbatim, and the result is assigned
 * with `innerHTML` — so raw HTML in the source is escaped rather than passed
 * through, and `javascript:` / `data:` URLs are stripped from links and images.
 */

import { marked, Renderer, type Tokens } from 'marked';

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

/** Schemes that turn a URL into executable code. */
const UNSAFE_SCHEME_RE = /^(?:javascript|data|vbscript):/i;

/** Highest character code a browser skips over when resolving a URL. */
const LAST_IGNORED_URL_CHAR = 0x20;

function isSafeUrl(href: string | null | undefined): boolean {
    // Browsers ignore whitespace and control characters when resolving a URL,
    // so `java\nscript:…` is just as live as `javascript:…`. Drop them before
    // testing the scheme rather than trusting the literal spelling.
    const normalized = Array.from(href ?? '')
        .filter(ch => ch.charCodeAt(0) > LAST_IGNORED_URL_CHAR)
        .join('');
    return normalized.length > 0 && !UNSAFE_SCHEME_RE.test(normalized);
}

/**
 * A renderer that keeps markdown formatting but refuses to emit anything the
 * browser would execute. Shared across calls — it holds no per-document state.
 */
const inertRenderer = new Renderer();

/** Raw HTML in the source is shown as text, both block-level and inline. */
inertRenderer.html = ({ text }: Tokens.HTML | Tokens.Tag): string => escapeHtml(text);

inertRenderer.link = function (this: Renderer, { href, title, tokens }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens);
    if (!isSafeUrl(href)) { return label; }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href)}"${titleAttr}>${label}</a>`;
};

inertRenderer.image = ({ href, title, text }: Tokens.Image): string => {
    if (!isSafeUrl(href)) { return escapeHtml(text ?? ''); }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text ?? '')}"${titleAttr}>`;
};

/** Render trail markdown to HTML that is safe to assign with `innerHTML`. */
export function renderQuestLogMarkdown(source: string): string {
    if (!source) { return ''; }
    return marked.parse(source, { renderer: inertRenderer, async: false });
}
