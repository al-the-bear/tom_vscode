// @ts-nocheck
/* global marked, mermaid */
// Markdown Browser client — extracted verbatim from the inline <script> of
// buildHtml() in src/handlers/markdownBrowser-handler.ts (Phase B.21 webview
// restructuring). Predates strict checkJs (large verbatim extraction).
//
// The shared document-picker script (getDocumentPickerScript()) used to be
// concatenated into the middle of this script; it is now a separate inline
// <script> after this file. Both reference the global `vscode` handle: this
// file acquires it once and publishes it as window.vscode so the picker IIFE
// (which uses a bare `vscode`) resolves to the same handle. marked + mermaid are
// loaded as external <script>s before this file and used as globals.
(function () {
    var vscode = acquireVsCodeApi();
    window.vscode = vscode; // shared with the document-picker inline <script>
    var __mdBrowserBooted = false;

    try {
        var backBtn = document.getElementById('backBtn');
        var forwardBtn = document.getElementById('forwardBtn');
        var openInEditorBtn = document.getElementById('openInEditorBtn');
        var openExternalBtn = document.getElementById('openExternalBtn');
        var reloadBtn = document.getElementById('reloadBtn');
        var reconnectBtn = document.getElementById('reconnectBtn');
        var fullIdBtn = document.getElementById('fullIdBtn');
        var crlfBtn = document.getElementById('crlfBtn');
        var contentArea = document.getElementById('contentArea');
        var filePathEl = document.getElementById('filePath');

        // Toggle state for the two heading extensions:
        //   fullIdMode: show the dotted full-id sub-line under every heading
        //     (pure CSS via body.show-fullid — no re-render needed).
        //   crlfMode: convert escaped/literal line breaks to real newlines.
        //     The conversion happens server-side, so toggling asks the backend
        //     to re-send the current file (see the 'setCrlf' message).
        var fullIdMode = false;
        var crlfMode = false;

        var currentFilePath = '';
        // liveMode + follow-tail state.
        //   liveMode: true when the panel was opened via
        //     tomAi.openInMdBrowserLive — enables the auto-scroll-to-
        //     bottom behavior below.
        //   followTail: sticky flag. Starts true (initial render has
        //     no prior scroll state); the user's scroll listener
        //     flips it off when they scroll away from the bottom and
        //     back on when they scroll back. Only when followTail
        //     is on do we auto-scroll after a content update.
        var liveMode = false;
        var followTail = true;
        var BOTTOM_THRESHOLD_PX = 48;

        function isNearBottom() {
            if (!contentArea) return true;
            var distanceFromBottom = contentArea.scrollHeight - contentArea.clientHeight - contentArea.scrollTop;
            return distanceFromBottom <= BOTTOM_THRESHOLD_PX;
        }

        function scrollToBottom() {
            if (!contentArea) return;
            contentArea.scrollTop = contentArea.scrollHeight;
        }

        // ---- Notify backend that webview is ready ----
        // (Backend will send groups and initial file content)
        setTimeout(function() {
            vscode.postMessage({ type: 'webviewReady' });
        }, 10);

        // ---- Navigation Buttons ----
        backBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'goBack' });
        });
        forwardBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'goForward' });
        });
        openInEditorBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openInEditor' });
        });
        openExternalBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'openExternal' });
        });
        reloadBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'reload' });
        });
        if (reconnectBtn) {
            reconnectBtn.addEventListener('click', function() {
                // Re-attach the file watch on the backend and re-stick to the
                // tail, so a detached live-trail starts auto-updating again.
                followTail = true;
                vscode.postMessage({ type: 'reconnect' });
            });
        }

        // ---- Heading Toggles ----
        if (fullIdBtn) {
            fullIdBtn.addEventListener('click', function() {
                fullIdMode = !fullIdMode;
                document.body.classList.toggle('show-fullid', fullIdMode);
                fullIdBtn.classList.toggle('active', fullIdMode);
            });
        }
        if (crlfBtn) {
            crlfBtn.addEventListener('click', function() {
                crlfMode = !crlfMode;
                crlfBtn.classList.toggle('active', crlfMode);
                // The backend owns the conversion; ask it to re-render the file.
                vscode.postMessage({ type: 'setCrlf', value: crlfMode });
            });
        }

        // ---- Heading Enhancement ----
        // The backend rewrote each heading into a capped (<=h6) markdown heading
        // carrying an invisible `.md-heading-meta` marker (data-level, data-fullid)
        // and a `.md-heading-id` badge. Promote the true level to a per-level
        // class (md-h1..md-h10) and build the toggle-able full-id sub-line.
        function enhanceHeadings() {
            if (!contentArea) return;
            var metas = contentArea.querySelectorAll('.md-heading-meta');
            for (var i = 0; i < metas.length; i++) {
                var meta = metas[i];
                var heading = meta.closest('h1, h2, h3, h4, h5, h6');
                var level = parseInt(meta.getAttribute('data-level') || '0', 10);
                var fullId = meta.getAttribute('data-fullid') || '';
                if (heading) {
                    heading.classList.add('md-heading');
                    if (level >= 1 && level <= 10) {
                        heading.classList.add('md-h' + level);
                    }
                    heading.setAttribute('data-level', String(level));
                    if (fullId) {
                        var sub = document.createElement('div');
                        sub.className = 'md-heading-fullid';
                        sub.textContent = fullId;
                        heading.insertAdjacentElement('afterend', sub);
                    }
                }
                if (meta.parentNode) meta.parentNode.removeChild(meta);
            }
        }

        // ---- Render Markdown ----
        function renderMarkdown(text) {
            if (typeof marked !== 'undefined' && marked.parse) {
                // With CR/LF on, render single newlines as hard <br> breaks
                // (marked `breaks`). Block structure (lists, headings, tables)
                // is parsed first, so enumerations are not affected.
                return marked.parse(text || '', { breaks: crlfMode });
            }
            return '<pre>' + escapeHtml(text || '') + '</pre>';
        }

        function escapeHtml(text) {
            var div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ---- Anchor Scrolling ----
        function scrollToAnchor(anchor) {
            if (!anchor || !contentArea) return false;

            // Try finding element by ID first (standard anchor)
            var target = document.getElementById(anchor);

            // If not found, try common heading ID patterns generated by marked.js
            if (!target) {
                // marked.js generates IDs by lowercasing and replacing spaces/special chars
                var normalizedAnchor = anchor.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                target = document.getElementById(normalizedAnchor);
            }

            // Try finding by heading text content
            if (!target) {
                var headings = contentArea.querySelectorAll('h1, h2, h3, h4, h5, h6');
                for (var i = 0; i < headings.length; i++) {
                    var h = headings[i];
                    var headingId = h.id || '';
                    var headingText = (h.textContent || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
                    if (headingId === anchor || headingText === anchor || headingText === anchor.toLowerCase()) {
                        target = h;
                        break;
                    }
                }
            }

            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Add a brief highlight effect
                target.style.transition = 'background-color 0.3s';
                target.style.backgroundColor = 'var(--vscode-editor-findMatchHighlightBackground)';
                setTimeout(function() {
                    target.style.backgroundColor = '';
                }, 1500);
                return true;
            }
            return false;
        }

        function initMermaid() {
            if (typeof mermaid === 'undefined' || !contentArea) return;
            try {
                contentArea.querySelectorAll('pre > code.language-mermaid').forEach(function(codeEl) {
                    var pre = codeEl.parentElement;
                    if (!pre || !pre.parentElement) return;
                    var mermaidDiv = document.createElement('div');
                    mermaidDiv.className = 'mermaid';
                    mermaidDiv.textContent = codeEl.textContent || '';
                    pre.parentElement.replaceChild(mermaidDiv, pre);
                });
                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
                mermaid.run({ nodes: contentArea.querySelectorAll('.mermaid') });
            } catch (err) {
                console.error('Mermaid render failed', err);
            }
        }

        // ---- Link Click Handling ----
        function interceptLinks() {
            if (!contentArea) return;
            contentArea.querySelectorAll('a[href]').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var href = link.getAttribute('href') || '';
                    if (!href) return;

                    // Skip external URLs
                    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                        return;
                    }

                    vscode.postMessage({ type: 'navigateLink', href: href });
                });
            });
        }

        // ---- Message Handling ----
        window.addEventListener('message', function(e) {
            var msg = e.data;
            if (!msg || !msg.type) return;

            if (msg.type === 'mdContent') {
                if (msg.error) {
                    contentArea.innerHTML = '<div class="empty-state error-state">'
                        + '<span class="codicon codicon-error"></span>'
                        + '<div>' + escapeHtml(msg.error) + '</div>'
                        + '</div>';
                    filePathEl.textContent = 'Error';
                } else {
                    var prevFilePath = currentFilePath;
                    var incomingFilePath = msg.filePath || '';
                    var sameFile = !!prevFilePath && prevFilePath === incomingFilePath;
                    var incomingLiveMode = msg.liveMode === true;

                    // Sample follow-tail *before* we replace the DOM,
                    // otherwise scrollTop is meaningless. We only trust
                    // the sample when it's a re-render of the same
                    // file — a navigation to a different file resets
                    // followTail to true so the view starts at the
                    // bottom (live) or top (normal) rather than
                    // wherever the previous file happened to be.
                    if (sameFile) {
                        followTail = isNearBottom();
                    } else {
                        followTail = true;
                    }

                    liveMode = incomingLiveMode;
                    currentFilePath = incomingFilePath;
                    // Persist enough to restore this panel after a window reload
                    // (the backend's WebviewPanelSerializer reads filePath +
                    // liveMode back from here in deserializeWebviewPanel).
                    if (incomingFilePath) {
                        vscode.setState({ filePath: incomingFilePath, liveMode: liveMode });
                    }
                    // The backend is authoritative for CR/LF state; sync the
                    // local flag + button so a reload/restore renders correctly.
                    if (typeof msg.crlf === 'boolean') {
                        crlfMode = msg.crlf;
                        if (crlfBtn) crlfBtn.classList.toggle('active', crlfMode);
                    }
                    filePathEl.textContent = msg.relativePath || msg.fileName || '';
                    contentArea.innerHTML = renderMarkdown(msg.content);
                    enhanceHeadings();
                    initMermaid();
                    interceptLinks();

                    // Handle anchor scrolling after content loads
                    if (msg.anchor) {
                        // Small delay to ensure DOM is ready
                        setTimeout(function() {
                            scrollToAnchor(msg.anchor);
                        }, 50);
                    } else if (liveMode && followTail) {
                        // Layout may not be final yet (Mermaid blocks
                        // can resize the doc after they render). Wait
                        // a frame so scrollHeight reflects the new
                        // content, then pin to the bottom.
                        requestAnimationFrame(function() {
                            scrollToBottom();
                        });
                    } else if (!sameFile) {
                        // Different file and not following: start at
                        // the top, matching the previous behavior.
                        contentArea.scrollTop = 0;
                    }
                    // Same-file re-render without live follow: leave
                    // scrollTop alone so the user's reading position
                    // is preserved.
                }
            } else if (msg.type === 'navState') {
                backBtn.disabled = !msg.canGoBack;
                forwardBtn.disabled = !msg.canGoForward;
            } else if (msg.type === 'scrollToAnchor') {
                // Scroll to anchor within current document
                if (msg.anchor) {
                    scrollToAnchor(msg.anchor);
                }
            } else if (msg.type === 'reconnected') {
                // Backend re-attached the watch and pushed fresh content; pin to
                // the tail and briefly flash the button so the user sees it worked.
                followTail = true;
                if (msg.liveMode) {
                    requestAnimationFrame(function() { scrollToBottom(); });
                }
                if (reconnectBtn) {
                    reconnectBtn.classList.add('reconnect-ok');
                    setTimeout(function() { reconnectBtn.classList.remove('reconnect-ok'); }, 800);
                }
            }
        });

        __mdBrowserBooted = true;
    } catch (err) {
        console.error('[MdBrowser] Boot error:', err);
        document.body.innerHTML = '<div style="padding:20px;color:red;">MD Browser failed to initialize: ' + err + '</div>';
    }
})();
