// @ts-check
// Markdown HTML preview client — migrated from the inline <script> of
// showMarkdownHtmlPreview() in src/handlers/markdownHtmlPreview.ts (Phase B.20
// webview restructuring).
//
// §3 content-injection panel: the marked + mermaid library URIs arrive via
// window.__INIT__ (known at first paint), but the markdown text itself arrives
// via postMessage (setContent) — so large documents and re-render-on-change are
// handled without rebuilding the HTML. main.js loads the two libraries, posts a
// 'ready' handshake, and re-renders on every setContent. The close button is
// wired with addEventListener.

(function () {
    const vscode = acquireVsCodeApi();
    const init = window.__INIT__ || {};
    const markedUri = typeof init.markedUri === 'string' ? init.markedUri : '';
    const mermaidUri = typeof init.mermaidUri === 'string' ? init.mermaidUri : '';

    const titleEl = document.getElementById('previewTitle');
    const metaEl = document.getElementById('previewMeta');
    const contentEl = document.getElementById('previewContent');
    const closeBtn = document.getElementById('closeBtn');

    if (closeBtn) {
        closeBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'close' });
        });
    }

    /**
     * @param {string} src
     * @returns {Promise<void>}
     */
    function loadScript(src) {
        return new Promise(function (resolve) {
            if (!src) {
                resolve();
                return;
            }
            const el = document.createElement('script');
            el.src = src;
            el.onload = function () { resolve(); };
            el.onerror = function () { resolve(); };
            document.head.appendChild(el);
        });
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    function escapeHtml(value) {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Render a payload posted from the host. Safe to call repeatedly
     * (re-render-on-change).
     * @param {{ title?: unknown, markdown?: unknown, meta?: unknown }} payload
     */
    function render(payload) {
        const title = typeof payload.title === 'string' ? payload.title : '';
        const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
        const meta = typeof payload.meta === 'string' ? payload.meta : '';

        if (titleEl) {
            titleEl.textContent = title;
        }
        if (metaEl) {
            metaEl.textContent = meta;
            metaEl.style.display = meta ? 'block' : 'none';
        }

        const markedLib = /** @type {any} */ (window).marked;
        const renderedHtml = (markedLib && typeof markedLib.parse === 'function')
            ? markedLib.parse(markdown)
            : '<pre>' + escapeHtml(markdown) + '</pre>';
        if (contentEl) {
            contentEl.innerHTML = renderedHtml;
        }

        const mermaidLib = /** @type {any} */ (window).mermaid;
        if (mermaidLib && contentEl) {
            try {
                contentEl.querySelectorAll('pre > code.language-mermaid').forEach(function (codeEl) {
                    const pre = codeEl.parentElement;
                    if (!pre || !pre.parentElement) {
                        return;
                    }
                    const mermaidDiv = document.createElement('div');
                    mermaidDiv.className = 'mermaid';
                    mermaidDiv.textContent = codeEl.textContent || '';
                    pre.parentElement.replaceChild(mermaidDiv, pre);
                });

                mermaidLib.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
                mermaidLib.run({ nodes: contentEl.querySelectorAll('.mermaid') });
            } catch (error) {
                console.error('Mermaid render failed', error);
            }
        }
    }

    window.addEventListener('message', function (event) {
        const msg = event.data;
        if (msg && msg.type === 'setContent') {
            render(msg);
        }
    });

    // Load the markdown + mermaid libraries first, then signal readiness so the
    // host posts the (possibly large) content without racing library load.
    Promise.all([loadScript(markedUri), loadScript(mermaidUri)]).then(function () {
        vscode.postMessage({ type: 'ready' });
    });
})();
